import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ERROR_MESSAGES,
  MAX_RECEIVERS,
  ROOM_TTL_MS,
  SENDER_GRACE_MS,
  type ErrorCode,
  type ProgressState,
  type RoomCloseReason,
  type ServerMessage,
  type SignalData,
} from '../shared/protocol';

/** One WebSocket connection, seen from the room logic. */
export interface PeerHandle {
  send(message: ServerMessage): void;
  close(): void;
}

export interface Clock {
  now(): number;
}

export interface RoomManagerOptions {
  clock?: Clock | undefined;
  generateCode?: (() => string) | undefined;
  ttlMs?: number | undefined;
  maxReceivers?: number | undefined;
  /** How long a room waits for its sender to reconnect before it is given up. */
  senderGraceMs?: number | undefined;
}

interface Member {
  id: string;
  handle: PeerHandle;
  role: 'sender' | 'receiver';
  room: Room;
}

interface Room {
  code: string;
  expiresAt: number;
  /** Proves it is the same sender when a dropped connection comes back. */
  secret: string;
  /** When the sender's connection dropped; undefined while it is connected. */
  awaySince?: number | undefined;
  sender: Member;
  receivers: Map<string, Member>;
}

const MAX_CODE_ATTEMPTS = 100;

/** Stands in for the sender's connection while it is away: everything sent to it is dropped. */
const NOBODY: PeerHandle = { send() {}, close() {} };

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Cryptographically secure, zero-padded 6-digit code. */
export function randomCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function newPeerId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * In-memory room state. Methods send their own success messages and return an
 * ErrorCode (never throw) when the request is refused.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Map<PeerHandle, Member>();
  private readonly clock: Clock;
  private readonly generateCode: () => string;
  private readonly ttlMs: number;
  private readonly maxReceivers: number;
  private readonly senderGraceMs: number;

  constructor(options: RoomManagerOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.generateCode = options.generateCode ?? randomCode;
    this.ttlMs = options.ttlMs ?? ROOM_TTL_MS;
    this.maxReceivers = options.maxReceivers ?? MAX_RECEIVERS;
    this.senderGraceMs = options.senderGraceMs ?? SENDER_GRACE_MS;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  createRoom(handle: PeerHandle): ErrorCode | undefined {
    if (this.members.has(handle)) return 'ALREADY_IN_ROOM';

    let code: string | undefined;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = this.generateCode();
      if (!this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (code === undefined) return 'INTERNAL';

    const now = this.clock.now();
    const room = { code, expiresAt: now + this.ttlMs, secret: randomBytes(16).toString('hex'), receivers: new Map() } as Room;
    room.sender = { id: newPeerId(), handle, role: 'sender', room };
    this.rooms.set(code, room);
    this.members.set(handle, room.sender);

    handle.send({
      type: 'room-created',
      code,
      peerId: room.sender.id,
      secret: room.secret,
      expiresAt: room.expiresAt,
      serverTime: now,
      maxReceivers: this.maxReceivers,
    });
    return undefined;
  }

  joinRoom(handle: PeerHandle, code: string): ErrorCode | undefined {
    if (this.members.has(handle)) return 'ALREADY_IN_ROOM';
    const room = this.rooms.get(code);
    if (!room) return 'ROOM_NOT_FOUND';

    const now = this.clock.now();
    if (this.giveUpOnAbsentSender(room, now)) return 'ROOM_NOT_FOUND';
    // Nobody could take the new receiver's offer: ask it to come back once the sender is back.
    if (room.awaySince !== undefined) return 'SENDER_AWAY';
    // The join window is [createdAt, expiresAt): exactly at expiresAt it is closed.
    if (now >= room.expiresAt) return 'ROOM_EXPIRED';
    if (room.receivers.size >= this.maxReceivers) return 'ROOM_FULL';

    const member: Member = { id: newPeerId(), handle, role: 'receiver', room };
    room.receivers.set(member.id, member);
    this.members.set(handle, member);

    handle.send({
      type: 'room-joined',
      peerId: member.id,
      senderId: room.sender.id,
      expiresAt: room.expiresAt,
      serverTime: now,
      receiverCount: room.receivers.size,
      maxReceivers: this.maxReceivers,
    });
    room.sender.handle.send({
      type: 'peer-joined',
      peerId: member.id,
      receiverCount: room.receivers.size,
    });
    return undefined;
  }

  /** Only sender <-> receiver of the same room may exchange signals. Expiry is irrelevant here. */
  relaySignal(handle: PeerHandle, to: string, data: SignalData): ErrorCode | undefined {
    const from = this.members.get(handle);
    if (!from) return 'NOT_IN_ROOM';
    const target = this.findCounterpart(from, to);
    if (!target) return 'NOT_ALLOWED';
    target.handle.send({ type: 'signal', from: from.id, data });
    return undefined;
  }

  relayProgress(
    handle: PeerHandle,
    progress: { state: ProgressState; receivedBytes: number; totalBytes: number },
  ): ErrorCode | undefined {
    const from = this.members.get(handle);
    if (!from) return 'NOT_IN_ROOM';
    if (from.role !== 'receiver') return 'NOT_ALLOWED';
    from.room.sender.handle.send({ type: 'transfer-progress', from: from.id, ...progress });
    return undefined;
  }

  /**
   * The sender is back after its connection dropped: it takes the room over again and gets the
   * receivers that are still in it. Needs the secret it was given when the room was created.
   */
  resumeRoom(handle: PeerHandle, code: string, secret: string): ErrorCode | undefined {
    if (this.members.has(handle)) return 'ALREADY_IN_ROOM';
    const room = this.rooms.get(code);
    if (!room) return 'ROOM_NOT_FOUND';
    if (!sameSecret(room.secret, secret)) return 'NOT_ALLOWED';

    const now = this.clock.now();
    if (this.giveUpOnAbsentSender(room, now)) return 'ROOM_NOT_FOUND';

    // The old connection may not look dead from here yet: the new one replaces it.
    const stale = room.sender.handle;
    if (stale !== NOBODY) {
      this.members.delete(stale);
      stale.close();
    }
    room.sender.handle = handle;
    room.awaySince = undefined;
    this.members.set(handle, room.sender);

    handle.send({
      type: 'room-resumed',
      peerId: room.sender.id,
      expiresAt: room.expiresAt,
      serverTime: now,
      maxReceivers: this.maxReceivers,
      receiverIds: [...room.receivers.keys()],
    });
    return undefined;
  }

  /** A connection dropped without saying goodbye. A receiver is gone; a sender is given time to come back. */
  disconnect(handle: PeerHandle): void {
    const member = this.members.get(handle);
    if (member?.role !== 'sender') {
      this.leave(handle);
      return;
    }
    this.members.delete(handle);
    member.room.sender.handle = NOBODY;
    member.room.awaySince = this.clock.now();
  }

  /** Closes the rooms whose sender stayed away for too long. */
  sweep(): void {
    const now = this.clock.now();
    for (const room of [...this.rooms.values()]) this.giveUpOnAbsentSender(room, now);
  }

  leave(handle: PeerHandle): void {
    const member = this.members.get(handle);
    if (!member) return;
    this.members.delete(handle);

    const { room } = member;
    if (member.role === 'receiver') {
      room.receivers.delete(member.id);
      room.sender.handle.send({
        type: 'peer-left',
        peerId: member.id,
        receiverCount: room.receivers.size,
      });
      return;
    }
    this.closeRoom(room);
  }

  /** Closes a room whose sender has been away longer than the grace period. True when it was closed. */
  private giveUpOnAbsentSender(room: Room, now: number): boolean {
    if (room.awaySince === undefined || now - room.awaySince < this.senderGraceMs) return false;
    this.closeRoom(room);
    return true;
  }

  private closeRoom(room: Room): void {
    this.rooms.delete(room.code);
    for (const receiver of room.receivers.values()) {
      this.members.delete(receiver.handle);
      receiver.handle.send({ type: 'room-closed', reason: 'SENDER_LEFT' });
      receiver.handle.close();
    }
    room.receivers.clear();
  }

  /** Tells everyone the rooms are going away (server shutdown). */
  closeAll(reason: RoomCloseReason): void {
    for (const member of this.members.keys()) {
      member.send({ type: 'room-closed', reason });
    }
    this.members.clear();
    this.rooms.clear();
  }

  private findCounterpart(from: Member, to: string): Member | undefined {
    const { room } = from;
    if (from.role === 'sender') return room.receivers.get(to);
    return room.sender.id === to ? room.sender : undefined;
  }
}

export function errorMessage(code: ErrorCode): ServerMessage {
  return { type: 'error', code, message: ERROR_MESSAGES[code] };
}
