import { describe, expect, it } from 'vitest';
import { MAX_BUFFERED_AMOUNT } from '../../shared/transfer';
import { FileReceiver, type ReceiveSnapshot } from './fileReceiver';
import { FileSender, type SendSnapshot } from './fileSender';
import { FakeChannel, FakeSink, linkChannels, makeFile, waitFor } from './testFakes';

/** One sender-side + receiver-side pair over a linked fake network, like one RTCPeerConnection each. */
function createPeer(file: File, sinkOptions: { gate?: Promise<void> } = {}) {
  const senderChannel = new FakeChannel();
  const receiverChannel = new FakeChannel();
  const network = linkChannels(senderChannel, receiverChannel);
  const sink = new FakeSink();
  sink.gate = sinkOptions.gate;
  let sendSnapshot: SendSnapshot | undefined;
  let receiveSnapshot: ReceiveSnapshot | undefined;
  const sender = new FileSender(senderChannel, file, (s) => (sendSnapshot = s));
  const receiver = new FileReceiver(receiverChannel, { memoryOnly: false }, (s) => (receiveSnapshot = s));
  return {
    senderChannel,
    receiverChannel,
    network,
    sink,
    sender,
    receiver,
    get send() { return sendSnapshot!; },
    get receive() { return receiveSnapshot!; },
    begin() {
      sender.start();
      return waitFor(() => receiveSnapshot?.phase === 'review').then(() => receiver.accept(sink));
    },
  };
}

describe('sender and receiver together', () => {
  it('delivers the exact bytes, with progress following the receiver and complete after the last ACK', async () => {
    const file = makeFile(1_000_003);
    const peer = createPeer(file);
    await peer.begin();
    await waitFor(() => peer.send.phase === 'done' && peer.receive.phase === 'done');

    expect(Buffer.from(peer.sink.bytes).equals(Buffer.from(await file.arrayBuffer()))).toBe(true);
    expect(peer.send).toMatchObject({ ackedBytes: 1_000_003, totalBytes: 1_000_003 });
    expect(peer.senderChannel.maxBufferedAmount).toBeLessThanOrEqual(MAX_BUFFERED_AMOUNT);
    expect(peer.sink.closed).toBe(1);
  });

  it('keeps the sender at the receiver\'s pace when the disk is slow', async () => {
    const file = makeFile(600_000);
    let release!: () => void;
    const peer = createPeer(file, { gate: new Promise<void>((resolve) => (release = resolve)) });
    await peer.begin();
    await waitFor(() => peer.senderChannel.chunks.length === 10);
    expect(peer.send.ackedBytes).toBe(0); // nothing saved yet -> no progress yet

    release();
    await waitFor(() => peer.send.phase === 'done');
    expect(peer.sink.bytes.length).toBe(600_000);
  });

  it('one connection dropping does not stop the other two', async () => {
    const file = makeFile(4 * 1024 * 1024);
    const peers = [createPeer(file), createPeer(file), createPeer(file)];
    const [healthy1, victim, healthy2] = peers as [ReturnType<typeof createPeer>, ReturnType<typeof createPeer>, ReturnType<typeof createPeer>];

    await Promise.all(peers.map((p) => p.begin()));
    await waitFor(() => victim.senderChannel.chunks.length > 0);
    victim.receiverChannel.close(); // e.g. the network dropped

    await waitFor(() => healthy1.send.phase === 'done' && healthy2.send.phase === 'done');
    await waitFor(() => victim.send.phase === 'failed');
    expect(victim.send.reason).toBe('connection-lost');
    // the receiver keeps what it has and waits for the sender to connect again
    expect(victim.receive.phase).toBe('paused');
    expect(victim.sink.aborted).toBe(0);

    const original = Buffer.from(await file.arrayBuffer());
    expect(Buffer.from(healthy1.sink.bytes).equals(Buffer.from(original))).toBe(true);
    expect(Buffer.from(healthy2.sink.bytes).equals(Buffer.from(original))).toBe(true);
  });

  it('picks a dropped transfer up where it stopped and still delivers the exact bytes', async () => {
    const file = makeFile(2_000_003);
    const peer = createPeer(file);
    await peer.begin();
    await waitFor(() => peer.receive.savedBytes > 300_000);
    peer.receiverChannel.close(); // the connection drops mid-transfer
    await waitFor(() => peer.receive.phase === 'paused' && peer.send.phase === 'failed');

    // The sender connects again: a new connection with a new FileSender; the same receiver carries on.
    const senderChannel = new FakeChannel();
    const receiverChannel = new FakeChannel();
    linkChannels(senderChannel, receiverChannel);
    let send: SendSnapshot | undefined;
    const sender = new FileSender(senderChannel, file, (s) => (send = s));
    peer.receiver.resume(receiverChannel);
    sender.start();
    await waitFor(() => send?.phase === 'done' && peer.receive.phase === 'done');

    expect(Buffer.from(peer.sink.bytes).equals(Buffer.from(await file.arrayBuffer()))).toBe(true);
    expect(peer.sink.closed).toBe(1);
    expect(peer.sink.aborted).toBe(0);
    // only what was missing went over the new connection
    const from = receiverChannel.messagesOf('accept')[0]!.from as number;
    expect(from).toBeGreaterThan(300_000);
    expect(senderChannel.chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(file.size - from);
    expect(send).toMatchObject({ ackedBytes: file.size, totalBytes: file.size });
  });

  it('survives several drops in a row', async () => {
    const file = makeFile(3_000_007);
    const peer = createPeer(file);
    await peer.begin();
    let receiverChannel = peer.receiverChannel;
    let send: SendSnapshot | undefined = peer.send;

    for (let drop = 1; drop <= 3; drop += 1) {
      const target = drop * 600_000;
      await waitFor(() => peer.receive.savedBytes >= target);
      receiverChannel.close();
      await waitFor(() => peer.receive.phase === 'paused');

      const nextSender = new FakeChannel();
      receiverChannel = new FakeChannel();
      linkChannels(nextSender, receiverChannel);
      peer.receiver.resume(receiverChannel);
      new FileSender(nextSender, file, (s) => (send = s)).start();
      await waitFor(() => peer.receive.phase === 'receiving');
    }
    await waitFor(() => send?.phase === 'done' && peer.receive.phase === 'done');
    expect(Buffer.from(peer.sink.bytes).equals(Buffer.from(await file.arrayBuffer()))).toBe(true);
    expect(peer.sink.closed).toBe(1);
  });

  it('one receiver cancelling does not stop the other two', async () => {
    const file = makeFile(4 * 1024 * 1024);
    const peers = [createPeer(file), createPeer(file), createPeer(file)];
    const [healthy1, canceller, healthy2] = peers as [ReturnType<typeof createPeer>, ReturnType<typeof createPeer>, ReturnType<typeof createPeer>];

    await Promise.all(peers.map((p) => p.begin()));
    await waitFor(() => canceller.senderChannel.chunks.length > 0);
    canceller.receiver.cancel();

    await waitFor(() => healthy1.send.phase === 'done' && healthy2.send.phase === 'done');
    await waitFor(() => canceller.send.phase === 'canceled');
    expect(canceller.sink.aborted).toBe(1);
    expect(canceller.sink.closed).toBe(0);
  });
});
