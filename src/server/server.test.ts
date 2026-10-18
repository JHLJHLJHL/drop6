import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  JOIN_RATE_LIMIT,
  MAX_MESSAGE_BYTES,
  MAX_RECEIVERS,
  ROOM_TTL_MS,
} from '../shared/protocol';
import { createAppServer, type AppServer, type AppServerOptions } from './server';
import { TestClient } from './testClient';

const silent = { info: () => {}, error: () => {} };
const ICE = [
  { urls: ['stun:stun.example.com:3478'] },
  { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' },
];

let staticDir: string;
const servers: AppServer[] = [];
const clients: TestClient[] = [];

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'drop6-static-'));
  await mkdir(path.join(staticDir, 'assets'));
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>DROP6</title>');
  await writeFile(path.join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(path.join(staticDir, '..', 'drop6-secret.txt'), 'top secret');
});

afterAll(async () => {
  await rm(staticDir, { recursive: true, force: true });
  await rm(path.join(staticDir, '..', 'drop6-secret.txt'), { force: true });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function start(options: Partial<AppServerOptions> = {}) {
  const server = createAppServer({
    host: '127.0.0.1',
    port: 0,
    iceServers: ICE,
    staticDir,
    logger: silent,
    ...options,
  });
  servers.push(server);
  const port = await server.start();
  return { server, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

async function connect(url: string, headers?: Record<string, string>) {
  const client = await TestClient.connect(url, headers ? { headers } : undefined);
  clients.push(client);
  return client;
}

async function openRoom(url: string) {
  const sender = await connect(url);
  sender.send({ type: 'create-room' });
  const created = await sender.next<{ code: string; peerId: string }>('room-created');
  return { sender, ...created };
}

async function joinRoom(url: string, code: string) {
  const receiver = await connect(url);
  receiver.send({ type: 'join-room', code });
  return receiver;
}

describe('HTTP', () => {
  it('answers GET /health', async () => {
    const { http } = await start();
    const res = await fetch(`${http}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves validated ICE config from /api/config without caching', async () => {
    const { http } = await start();
    const res = await fetch(`${http}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ iceServers: ICE });
  });

  it('asks the ICE provider on every /api/config request (short-lived TURN credentials)', async () => {
    let calls = 0;
    const getIceServers = async () => {
      calls += 1;
      return [{ urls: ['turn:turn.example.com:3478'], username: `user-${calls}`, credential: 'c' }];
    };
    const { http } = await start({ getIceServers });
    const first = await (await fetch(`${http}/api/config`)).json();
    const second = await (await fetch(`${http}/api/config`)).json();
    expect(first).toEqual({ iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'user-1', credential: 'c' }] });
    expect(second.iceServers[0].username).toBe('user-2');
  });

  it('still answers /api/config when the ICE provider fails, with a generic error and no details', async () => {
    const getIceServers = async () => {
      throw new Error('token abc123 rejected');
    };
    const { http } = await start({ getIceServers });
    const res = await fetch(`${http}/api/config`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe('{"error":"INTERNAL"}');
    expect(body).not.toContain('abc123');
  });

  it('serves index.html at / and for unknown extension-less paths (SPA refresh)', async () => {
    const { http } = await start();
    for (const route of ['/', '/receive', '/some/deep/route']) {
      const res = await fetch(`${http}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('DROP6');
    }
  });

  it('serves hashed assets as immutable and 404s missing files and unknown API routes', async () => {
    const { http } = await start();
    const asset = await fetch(`${http}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${http}/assets/missing.js`)).status).toBe(404);
    const api = await fetch(`${http}/api/nope`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
  });

  it('does not allow path traversal out of the static directory', async () => {
    const { http } = await start();
    const res = await fetch(`${http}/..%2fdrop6-secret.txt`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('top secret');
  });

  it('sets security headers', async () => {
    const { http } = await start();
    const res = await fetch(`${http}/`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('hides the test clock endpoints outside test mode', async () => {
    const { http } = await start({ testMode: false });
    const res = await fetch(`${http}/__test__/clock/advance`, { method: 'POST', body: '{"ms":1}' });
    expect(res.status).toBe(404);
  });
});

describe('WebSocket protocol', () => {
  it('creates a room and relays signals between sender and receiver', async () => {
    const { ws } = await start();
    const { sender, code, peerId: senderId } = await openRoom(ws);
    const receiver = await joinRoom(ws, code);
    const joined = await receiver.next<{ peerId: string; senderId: string }>('room-joined');
    expect(joined.senderId).toBe(senderId);
    expect(await sender.next('peer-joined')).toMatchObject({ peerId: joined.peerId, receiverCount: 1 });

    sender.send({ type: 'signal', to: joined.peerId, data: { kind: 'offer', sdp: 'v=0' } });
    expect(await receiver.next('signal')).toMatchObject({ from: senderId, data: { kind: 'offer' } });
    receiver.send({ type: 'signal', to: senderId, data: { kind: 'answer', sdp: 'v=0' } });
    expect(await sender.next('signal')).toMatchObject({ from: joined.peerId, data: { kind: 'answer' } });
  });

  it('answers the 4th receiver with ROOM_FULL', async () => {
    const { ws } = await start();
    const { code } = await openRoom(ws);
    for (let i = 0; i < MAX_RECEIVERS; i += 1) {
      const receiver = await joinRoom(ws, code);
      await receiver.next('room-joined');
    }
    const fourth = await joinRoom(ws, code);
    expect(await fourth.next('error')).toMatchObject({ code: 'ROOM_FULL' });
  });

  it('rejects new joins once 30 minutes passed while earlier receivers keep signaling', async () => {
    const { ws, http } = await start({ testMode: true });
    const { sender, code, peerId: senderId } = await openRoom(ws);
    const early = await joinRoom(ws, code);
    const { peerId: earlyId } = await early.next<{ peerId: string }>('room-joined');

    await fetch(`${http}/__test__/clock/advance`, { method: 'POST', body: JSON.stringify({ ms: ROOM_TTL_MS - 5_000 }) });
    const lastMinute = await joinRoom(ws, code);
    await lastMinute.next('room-joined');

    await fetch(`${http}/__test__/clock/advance`, { method: 'POST', body: JSON.stringify({ ms: 5_000 }) });
    const late = await joinRoom(ws, code);
    expect(await late.next('error')).toMatchObject({ code: 'ROOM_EXPIRED' });

    sender.send({ type: 'signal', to: earlyId, data: { kind: 'offer', sdp: 'v=0' } });
    expect(await early.next('signal')).toMatchObject({ from: senderId });
  });

  it('keeps the connection usable after invalid JSON, unknown types and bad shapes', async () => {
    const { ws } = await start();
    const client = await connect(ws);
    client.send('{not json');
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_JSON' });
    client.send({ type: 'launch-missiles' });
    expect(await client.next('error')).toMatchObject({ code: 'UNKNOWN_TYPE' });
    client.send({ type: 'join-room', code: 'abc' });
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    client.send({ type: 'create-room', extra: true });
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    client.send([1, 2]);
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    client.send({ type: 'create-room' });
    await client.next('room-created');
  });

  it('rejects binary frames with an error and closes with 1003', async () => {
    const { ws } = await start();
    const client = await connect(ws);
    client.sendBinary(Buffer.from([1, 2, 3]));
    expect(await client.next('error')).toMatchObject({ code: 'BINARY_NOT_SUPPORTED' });
    expect((await client.closed).code).toBe(1003);
  });

  it('accepts messages of exactly 64KiB but closes the connection above that', async () => {
    const { ws } = await start();
    const ok = await connect(ws);
    ok.send('x'.repeat(MAX_MESSAGE_BYTES));
    expect(await ok.next('error')).toMatchObject({ code: 'INVALID_JSON' });

    const tooBig = await connect(ws);
    tooBig.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    // ws answers 1009 (message too big); depending on TCP timing the peer may only see 1006.
    expect([1006, 1009]).toContain((await tooBig.closed).code);
  });

  it('blocks signals to peers outside the sender-receiver pair', async () => {
    const { ws } = await start();
    const one = await openRoom(ws);
    const two = await openRoom(ws);
    const stranger = await joinRoom(ws, two.code);
    const { peerId: strangerId } = await stranger.next<{ peerId: string }>('room-joined');
    await two.sender.next('peer-joined');

    one.sender.send({ type: 'signal', to: strangerId, data: { kind: 'offer', sdp: 'v=0' } });
    expect(await one.sender.next('error')).toMatchObject({ code: 'NOT_ALLOWED' });
    await stranger.expectSilence();

    const loner = await connect(ws);
    loner.send({ type: 'signal', to: strangerId, data: { kind: 'offer', sdp: 'v=0' } });
    expect(await loner.next('error')).toMatchObject({ code: 'NOT_IN_ROOM' });
  });

  it('relays receiver transfer-progress to the sender', async () => {
    const { ws } = await start();
    const { sender, code } = await openRoom(ws);
    const receiver = await joinRoom(ws, code);
    const { peerId } = await receiver.next<{ peerId: string }>('room-joined');
    receiver.send({ type: 'transfer-progress', state: 'failed', receivedBytes: 0, totalBytes: 5 });
    await sender.next('peer-joined');
    expect(await sender.next('transfer-progress')).toMatchObject({ from: peerId, state: 'failed' });
  });

  it('tells receivers at once when the sender leaves on purpose', async () => {
    const { ws } = await start();
    const first = await openRoom(ws);
    const a = await joinRoom(ws, first.code);
    await a.next('room-joined');
    first.sender.send({ type: 'leave' });
    expect(await a.next('room-closed')).toMatchObject({ reason: 'SENDER_LEFT' });
  });

  it('keeps the room for a sender that just vanished, and tells receivers only once the grace period is over', async () => {
    const { ws, http } = await start({ testMode: true, senderGraceMs: 10_000 });
    const { sender, code } = await openRoom(ws);
    const receiver = await joinRoom(ws, code);
    await receiver.next('room-joined');
    sender.ws.terminate();

    await receiver.expectSilence(150);
    await fetch(`${http}/__test__/clock/advance`, { method: 'POST', body: JSON.stringify({ ms: 9_000 }) });
    await receiver.expectSilence(100);
    await fetch(`${http}/__test__/clock/advance`, { method: 'POST', body: JSON.stringify({ ms: 2_000 }) });
    expect(await receiver.next('room-closed')).toMatchObject({ reason: 'SENDER_LEFT' });
  });

  it('lets the sender take the room back with its secret and hands over the receivers that are still there', async () => {
    const { ws } = await start();
    const first = await connect(ws);
    first.send({ type: 'create-room' });
    const created = await first.next<{ code: string; peerId: string; secret: string }>('room-created');
    const receiver = await joinRoom(ws, created.code);
    const { peerId: receiverId } = await receiver.next<{ peerId: string }>('room-joined');
    await first.next('peer-joined');
    first.ws.terminate();
    await first.closed;

    const back = await connect(ws);
    back.send({ type: 'resume-room', code: created.code, secret: created.secret });
    expect(await back.next('room-resumed')).toMatchObject({
      peerId: created.peerId,
      receiverIds: [receiverId],
      maxReceivers: MAX_RECEIVERS,
    });

    // the receiver can reach the new connection with the sender's old peer id, and the room is open again
    receiver.send({ type: 'signal', to: created.peerId, data: { kind: 'answer', sdp: 'v=0' } });
    expect(await back.next('signal')).toMatchObject({ from: receiverId });
    const late = await joinRoom(ws, created.code);
    await late.next('room-joined');
  });

  it('refuses to hand the room to anyone without the secret', async () => {
    const { ws } = await start();
    const { sender, code } = await openRoom(ws);
    sender.ws.terminate();
    await sender.closed;

    const intruder = await connect(ws);
    intruder.send({ type: 'resume-room', code, secret: '0'.repeat(32) });
    expect(await intruder.next('error')).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('refuses new receivers while the sender is away', async () => {
    const { ws } = await start();
    const { sender, code } = await openRoom(ws);
    sender.ws.terminate();
    await sender.closed;

    const late = await joinRoom(ws, code);
    expect(await late.next('error')).toMatchObject({ code: 'SENDER_AWAY' });
  });

  it('lets a new connection of the sender replace one that still looks alive', async () => {
    const { ws } = await start();
    const first = await connect(ws);
    first.send({ type: 'create-room' });
    const created = await first.next<{ code: string; secret: string }>('room-created');

    const second = await connect(ws);
    second.send({ type: 'resume-room', code: created.code, secret: created.secret });
    await second.next('room-resumed');
    await first.closed;

    const receiver = await joinRoom(ws, created.code);
    await receiver.next('room-joined');
    expect(await second.next('peer-joined')).toMatchObject({ receiverCount: 1 });
  });

  it('tells the sender when a receiver disconnects', async () => {
    const { ws } = await start();
    const { sender, code } = await openRoom(ws);
    const receiver = await joinRoom(ws, code);
    const { peerId } = await receiver.next<{ peerId: string }>('room-joined');
    await sender.next('peer-joined');
    receiver.ws.terminate();
    expect(await sender.next('peer-left')).toMatchObject({ peerId, receiverCount: 0 });
  });
});

describe('abuse protection', () => {
  it(`limits join attempts to ${JOIN_RATE_LIMIT.max} per ${JOIN_RATE_LIMIT.windowMs / 1000}s per IP`, async () => {
    const { ws } = await start({ trustProxyHops: 1 });
    const attacker = await connect(ws, { 'x-forwarded-for': '203.0.113.7' });
    for (let i = 0; i < JOIN_RATE_LIMIT.max; i += 1) {
      attacker.send({ type: 'join-room', code: '000000' });
      expect(await attacker.next('error')).toMatchObject({ code: 'ROOM_NOT_FOUND' });
    }
    attacker.send({ type: 'join-room', code: '000000' });
    expect(await attacker.next('error')).toMatchObject({ code: 'RATE_LIMITED' });

    const other = await connect(ws, { 'x-forwarded-for': '203.0.113.8' });
    other.send({ type: 'join-room', code: '000000' });
    expect(await other.next('error')).toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });

  it('ignores X-Forwarded-For unless proxy hops are configured', async () => {
    const { ws } = await start({ joinRateLimit: { max: 1, windowMs: 60_000 } });
    const a = await connect(ws, { 'x-forwarded-for': '203.0.113.1' });
    const b = await connect(ws, { 'x-forwarded-for': '203.0.113.2' });
    a.send({ type: 'join-room', code: '000000' });
    await a.next('error');
    b.send({ type: 'join-room', code: '000000' });
    expect(await b.next('error')).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('refuses cross-origin WebSocket upgrades but allows same-origin and no-origin clients', async () => {
    const { ws } = await start();
    const host = new URL(ws).host;
    await expect(connect(ws, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
    await connect(ws, { origin: `http://${host}` });
    await connect(ws);
  });

  it('only upgrades on /ws', async () => {
    const { ws } = await start();
    await expect(connect(ws.replace('/ws', '/other'))).rejects.toThrow(/404/);
  });

  it('drops connections that stop answering pings', async () => {
    const { ws } = await start({ heartbeatIntervalMs: 40 });
    const dead = await TestClient.connect(ws, { autoPong: false });
    clients.push(dead);
    const { sender, code } = await openRoom(ws);
    const receiver = await joinRoom(ws, code);
    await receiver.next('room-joined');
    // `dead` never pongs; once terminated it must be gone, healthy peers stay.
    await dead.closed;
    expect(sender.ws.readyState).toBe(sender.ws.OPEN);
  });
});

describe('shutdown', () => {
  it('tells connected peers the server is going away and closes with 1001', async () => {
    const { ws, server } = await start();
    const { sender, code } = await openRoom(ws);
    const receiver = await joinRoom(ws, code);
    await receiver.next('room-joined');
    await server.close();
    expect(await receiver.next('room-closed')).toMatchObject({ reason: 'SERVER_SHUTDOWN' });
    expect(await sender.next('room-closed')).toMatchObject({ reason: 'SERVER_SHUTDOWN' });
    expect((await receiver.closed).code).toBe(1001);
  });
});
