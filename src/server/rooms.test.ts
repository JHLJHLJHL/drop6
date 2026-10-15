import { describe, expect, it } from 'vitest';
import { MAX_RECEIVERS, ROOM_TTL_MS, type ServerMessage, type SignalData } from '../shared/protocol';
import { RoomManager, type PeerHandle } from './rooms';

class FakePeer implements PeerHandle {
  messages: ServerMessage[] = [];
  closed = false;
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  close(): void {
    this.closed = true;
  }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    const found = [...this.messages].reverse().find((m) => m.type === type);
    if (!found) throw new Error(`no ${type} message; got ${this.messages.map((m) => m.type).join(',')}`);
    return found as Extract<ServerMessage, { type: T }>;
  }
}

const offer: SignalData = { kind: 'offer', sdp: 'v=0' };

function setup(codes?: string[]) {
  const clock = { time: 1_000_000, now() { return this.time; } };
  const queue = codes ? [...codes] : undefined;
  const manager = new RoomManager({
    clock,
    generateCode: queue ? () => queue.shift() ?? '999999' : undefined,
  });
  return { clock, manager };
}

function openRoom(manager: RoomManager) {
  const sender = new FakePeer();
  expect(manager.createRoom(sender)).toBeUndefined();
  const created = sender.last('room-created');
  return { sender, code: created.code, senderId: created.peerId };
}

function join(manager: RoomManager, code: string) {
  const receiver = new FakePeer();
  const error = manager.joinRoom(receiver, code);
  return { receiver, error };
}

describe('RoomManager.createRoom', () => {
  it('sends a 6-digit code and an expiry 30 minutes ahead', () => {
    const { manager, clock } = setup();
    const { sender, code } = openRoom(manager);
    const created = sender.last('room-created');
    expect(code).toMatch(/^\d{6}$/);
    expect(created.expiresAt).toBe(clock.time + ROOM_TTL_MS);
    expect(created.serverTime).toBe(clock.time);
    expect(created.maxReceivers).toBe(MAX_RECEIVERS);
  });

  it('retries when the generated code collides with an active room', () => {
    const { manager } = setup(['111111', '111111', '222222']);
    const first = openRoom(manager);
    const second = openRoom(manager);
    expect(first.code).toBe('111111');
    expect(second.code).toBe('222222');
  });

  it('gives up with INTERNAL when no free code can be found', () => {
    const { manager } = setup(Array(200).fill('111111'));
    openRoom(manager);
    expect(manager.createRoom(new FakePeer())).toBe('INTERNAL');
  });

  it('refuses a second room from the same connection', () => {
    const { manager } = setup();
    const sender = new FakePeer();
    manager.createRoom(sender);
    expect(manager.createRoom(sender)).toBe('ALREADY_IN_ROOM');
  });
});

describe('RoomManager.joinRoom', () => {
  it('rejects unknown codes', () => {
    const { manager } = setup();
    expect(join(manager, '123456').error).toBe('ROOM_NOT_FOUND');
  });

  it('joins, tells the receiver who the sender is and notifies the sender', () => {
    const { manager } = setup();
    const { sender, code, senderId } = openRoom(manager);
    const { receiver, error } = join(manager, code);
    expect(error).toBeUndefined();
    const joined = receiver.last('room-joined');
    expect(joined.senderId).toBe(senderId);
    expect(joined.receiverCount).toBe(1);
    const notice = sender.last('peer-joined');
    expect(notice.peerId).toBe(joined.peerId);
    expect(notice.receiverCount).toBe(1);
  });

  it('accepts a join 1 ms before expiry but rejects exactly at expiry', () => {
    const { manager, clock } = setup();
    const { code } = openRoom(manager);
    clock.time += ROOM_TTL_MS - 1;
    expect(join(manager, code).error).toBeUndefined();
    clock.time += 1;
    expect(join(manager, code).error).toBe('ROOM_EXPIRED');
  });

  it('allows at most 3 receivers and answers the 4th with ROOM_FULL', () => {
    const { manager } = setup();
    const { code } = openRoom(manager);
    for (let i = 0; i < MAX_RECEIVERS; i += 1) expect(join(manager, code).error).toBeUndefined();
    expect(join(manager, code).error).toBe('ROOM_FULL');
  });

  it('frees a slot when a receiver leaves', () => {
    const { manager } = setup();
    const { sender, code } = openRoom(manager);
    const peers = Array.from({ length: MAX_RECEIVERS }, () => join(manager, code).receiver);
    manager.leave(peers[0]!);
    expect(sender.last('peer-left').receiverCount).toBe(2);
    expect(join(manager, code).error).toBeUndefined();
  });

  it('refuses a connection that is already in a room', () => {
    const { manager } = setup();
    const { sender, code } = openRoom(manager);
    expect(manager.joinRoom(sender, code)).toBe('ALREADY_IN_ROOM');
  });
});

describe('RoomManager.leave', () => {
  it('closes the room for every receiver when the sender leaves', () => {
    const { manager } = setup();
    const { sender, code } = openRoom(manager);
    const a = join(manager, code).receiver;
    const b = join(manager, code).receiver;
    manager.leave(sender);
    for (const receiver of [a, b]) {
      expect(receiver.last('room-closed').reason).toBe('SENDER_LEFT');
      expect(receiver.closed).toBe(true);
    }
    expect(manager.roomCount).toBe(0);
    expect(join(manager, code).error).toBe('ROOM_NOT_FOUND');
  });

  it('is a no-op for connections that never joined anything', () => {
    const { manager } = setup();
    expect(() => manager.leave(new FakePeer())).not.toThrow();
  });
});

describe('RoomManager.relaySignal', () => {
  it('relays between sender and receiver in both directions', () => {
    const { manager } = setup();
    const { sender, code, senderId } = openRoom(manager);
    const { receiver } = join(manager, code);
    const receiverId = receiver.last('room-joined').peerId;

    expect(manager.relaySignal(sender, receiverId, offer)).toBeUndefined();
    expect(receiver.last('signal')).toMatchObject({ from: senderId, data: offer });

    const answer: SignalData = { kind: 'answer', sdp: 'v=0' };
    expect(manager.relaySignal(receiver, senderId, answer)).toBeUndefined();
    expect(sender.last('signal')).toMatchObject({ from: receiverId, data: answer });
  });

  it('keeps relaying for existing participants after the room expired', () => {
    const { manager, clock } = setup();
    const { sender, code, senderId } = openRoom(manager);
    const { receiver } = join(manager, code);
    const receiverId = receiver.last('room-joined').peerId;
    clock.time += ROOM_TTL_MS + 60_000;
    expect(manager.relaySignal(sender, receiverId, offer)).toBeUndefined();
    expect(manager.relaySignal(receiver, senderId, offer)).toBeUndefined();
    expect(sender.messages.at(-1)?.type).toBe('signal');
  });

  it('rejects signals from connections that are not in a room', () => {
    const { manager } = setup();
    const { receiver } = join(manager, '000000');
    expect(manager.relaySignal(receiver, 'a'.repeat(16), offer)).toBe('NOT_IN_ROOM');
  });

  it('blocks receiver-to-receiver signaling', () => {
    const { manager } = setup();
    const { code } = openRoom(manager);
    const a = join(manager, code).receiver;
    const b = join(manager, code).receiver;
    expect(manager.relaySignal(a, b.last('room-joined').peerId, offer)).toBe('NOT_ALLOWED');
    expect(b.messages.some((m) => m.type === 'signal')).toBe(false);
  });

  it('blocks signaling to peers in a different room and to unknown ids', () => {
    const { manager } = setup();
    const one = openRoom(manager);
    const two = openRoom(manager);
    const stranger = join(manager, two.code).receiver;
    const strangerId = stranger.last('room-joined').peerId;
    expect(manager.relaySignal(one.sender, strangerId, offer)).toBe('NOT_ALLOWED');
    expect(manager.relaySignal(one.sender, 'f'.repeat(16), offer)).toBe('NOT_ALLOWED');
    expect(stranger.messages.some((m) => m.type === 'signal')).toBe(false);
  });

  it('stops relaying to a receiver that already left', () => {
    const { manager } = setup();
    const { sender, code } = openRoom(manager);
    const { receiver } = join(manager, code);
    const receiverId = receiver.last('room-joined').peerId;
    manager.leave(receiver);
    expect(manager.relaySignal(sender, receiverId, offer)).toBe('NOT_ALLOWED');
  });
});

describe('RoomManager.relayProgress', () => {
  it('forwards receiver progress to the sender only', () => {
    const { manager } = setup();
    const { sender, code } = openRoom(manager);
    const { receiver } = join(manager, code);
    const receiverId = receiver.last('room-joined').peerId;
    const progress = { state: 'failed', receivedBytes: 0, totalBytes: 10 } as const;
    expect(manager.relayProgress(receiver, progress)).toBeUndefined();
    expect(sender.last('transfer-progress')).toMatchObject({ from: receiverId, ...progress });
    expect(manager.relayProgress(sender, progress)).toBe('NOT_ALLOWED');
  });
});
