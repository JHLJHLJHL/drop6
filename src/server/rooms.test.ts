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

describe('a sender that dropped off', () => {
  const GRACE = 60_000;

  function setupWithGrace() {
    const clock = { time: 1_000_000, now() { return this.time; } };
    const manager = new RoomManager({ clock, senderGraceMs: GRACE });
    return { clock, manager };
  }

  function openRoomWithSecret(manager: RoomManager) {
    const sender = new FakePeer();
    manager.createRoom(sender);
    const created = sender.last('room-created');
    return { sender, code: created.code, senderId: created.peerId, secret: created.secret };
  }

  it('hands a secret to the sender only when the room is created', () => {
    const { manager } = setupWithGrace();
    const { sender, code, secret } = openRoomWithSecret(manager);
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    const { receiver } = join(manager, code);
    expect(JSON.stringify(receiver.messages)).not.toContain(secret);
    expect(sender.messages.filter((m) => m.type === 'room-created')).toHaveLength(1);
  });

  it('keeps the room and its receivers without telling them anything', () => {
    const { manager, clock } = setupWithGrace();
    const { sender, code } = openRoomWithSecret(manager);
    const { receiver } = join(manager, code);
    const before = receiver.messages.length;
    manager.disconnect(sender);
    clock.time += GRACE - 1;
    manager.sweep();
    expect(manager.roomCount).toBe(1);
    expect(receiver.messages).toHaveLength(before);
    expect(receiver.closed).toBe(false);
  });

  it('closes the room for the receivers once the grace period is over', () => {
    const { manager, clock } = setupWithGrace();
    const { sender, code } = openRoomWithSecret(manager);
    const { receiver } = join(manager, code);
    manager.disconnect(sender);
    clock.time += GRACE;
    manager.sweep();
    expect(receiver.last('room-closed').reason).toBe('SENDER_LEFT');
    expect(receiver.closed).toBe(true);
    expect(manager.roomCount).toBe(0);
  });

  it('closes a room that nobody swept as soon as someone asks for it after the grace period', () => {
    const { manager, clock } = setupWithGrace();
    const { sender, code } = openRoomWithSecret(manager);
    manager.disconnect(sender);
    clock.time += GRACE;
    expect(join(manager, code).error).toBe('ROOM_NOT_FOUND');
    expect(manager.roomCount).toBe(0);

    const second = openRoomWithSecret(manager);
    manager.disconnect(second.sender);
    clock.time += GRACE;
    expect(manager.resumeRoom(new FakePeer(), second.code, second.secret)).toBe('ROOM_NOT_FOUND');
    expect(manager.roomCount).toBe(0);
  });

  it('still closes at once when the sender leaves on purpose', () => {
    const { manager } = setupWithGrace();
    const { sender, code } = openRoomWithSecret(manager);
    const { receiver } = join(manager, code);
    manager.leave(sender);
    expect(receiver.last('room-closed').reason).toBe('SENDER_LEFT');
    expect(manager.roomCount).toBe(0);
  });

  it('treats a disconnecting receiver like a leaving one', () => {
    const { manager } = setupWithGrace();
    const { sender, code } = openRoomWithSecret(manager);
    const { receiver } = join(manager, code);
    manager.disconnect(receiver);
    expect(sender.last('peer-left').receiverCount).toBe(0);
  });

  it('refuses new receivers while the sender is away', () => {
    const { manager } = setupWithGrace();
    const { sender, code } = openRoomWithSecret(manager);
    manager.disconnect(sender);
    expect(join(manager, code).error).toBe('SENDER_AWAY');
  });

  it('lets the sender take the room back, handing over the receivers and keeping its identity', () => {
    const { manager } = setupWithGrace();
    const { sender, code, senderId, secret } = openRoomWithSecret(manager);
    const a = join(manager, code).receiver;
    const b = join(manager, code).receiver;
    manager.disconnect(sender);

    const back = new FakePeer();
    expect(manager.resumeRoom(back, code, secret)).toBeUndefined();
    const resumed = back.last('room-resumed');
    expect(resumed.peerId).toBe(senderId);
    expect(resumed.receiverIds.sort()).toEqual([a.last('room-joined').peerId, b.last('room-joined').peerId].sort());

    // signals flow again, and new receivers are welcome again
    expect(manager.relaySignal(a, senderId, offer)).toBeUndefined();
    expect(back.last('signal')).toMatchObject({ data: offer });
    expect(join(manager, code).error).toBeUndefined();
    expect(back.last('peer-joined').receiverCount).toBe(3);
  });

  it('drops what receivers send to the sender while it is away instead of failing', () => {
    const { manager } = setupWithGrace();
    const { sender, code, senderId } = openRoomWithSecret(manager);
    const { receiver } = join(manager, code);
    manager.disconnect(sender);
    expect(manager.relaySignal(receiver, senderId, offer)).toBeUndefined();
    expect(manager.relayProgress(receiver, { state: 'waiting', receivedBytes: 0, totalBytes: 1 })).toBeUndefined();
    manager.leave(receiver); // and a receiver leaving meanwhile does not trip over the missing sender
  });

  it('only hands the room to someone with the right secret', () => {
    const { manager } = setupWithGrace();
    const { sender, code, secret } = openRoomWithSecret(manager);
    manager.disconnect(sender);
    const intruder = new FakePeer();
    expect(manager.resumeRoom(intruder, code, 'f'.repeat(32))).toBe('NOT_ALLOWED');
    expect(manager.resumeRoom(intruder, code, secret.slice(0, 31))).toBe('NOT_ALLOWED');
    expect(manager.resumeRoom(intruder, '000000', secret)).toBe('ROOM_NOT_FOUND');
    expect(intruder.messages).toHaveLength(0);
  });

  it('replaces a connection that still looks alive and closes it', () => {
    const { manager } = setupWithGrace();
    const { sender, code, secret } = openRoomWithSecret(manager);
    const fresh = new FakePeer();
    expect(manager.resumeRoom(fresh, code, secret)).toBeUndefined();
    expect(sender.closed).toBe(true);
    manager.disconnect(sender); // the old connection finally reports its death: nothing happens to the room
    expect(manager.roomCount).toBe(1);
    expect(join(manager, code).error).toBeUndefined();
    expect(fresh.last('peer-joined').receiverCount).toBe(1);
  });

  it('refuses a connection that is already in a room', () => {
    const { manager } = setupWithGrace();
    const { sender, code, secret } = openRoomWithSecret(manager);
    expect(manager.resumeRoom(sender, code, secret)).toBe('ALREADY_IN_ROOM');
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
