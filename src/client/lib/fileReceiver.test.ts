import { describe, expect, it } from 'vitest';
import { ACK_INTERVAL_BYTES, CHUNK_SIZE, MAX_BLOB_BYTES } from '../../shared/transfer';
import { FileReceiver, type ReceiveSnapshot } from './fileReceiver';
import { FakeChannel, FakeSink, flush, waitFor } from './testFakes';

function setup(options: { memoryOnly?: boolean } = {}) {
  const channel = new FakeChannel();
  const snapshots: ReceiveSnapshot[] = [];
  const receiver = new FileReceiver(channel, { memoryOnly: options.memoryOnly ?? false }, (s) => snapshots.push(s));
  return { channel, receiver, last: () => snapshots.at(-1)!, snapshots };
}

const meta = (size: number) =>
  JSON.stringify({ t: 'meta', name: 'photo.png', size, mime: 'image/png' });
const chunk = (size: number, fill = 1) => new Uint8Array(size).fill(fill).buffer;
const complete = (size: number) => JSON.stringify({ t: 'complete', size });
const acks = (channel: FakeChannel) => channel.messagesOf('ack').map((m) => m.bytes);

describe('FileReceiver', () => {
  it('shows file info first and asks nothing of the sender until the user accepts', () => {
    const { channel, last } = setup();
    channel.emitMessage(meta(1000));
    expect(last()).toMatchObject({
      phase: 'review',
      meta: { name: 'photo.png', size: 1000, mime: 'image/png' },
    });
    expect(channel.sent).toHaveLength(0);
  });

  it('sends accept and stores incoming chunks in order', async () => {
    const { channel, receiver } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(6));
    receiver.accept(sink);
    expect(channel.messagesOf('accept')).toHaveLength(1);
    channel.emitMessage(new Uint8Array([1, 2, 3]).buffer);
    channel.emitMessage(new Uint8Array([4, 5, 6]).buffer);
    await waitFor(() => sink.written.length === 2);
    expect(sink.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('ACKs only bytes the sink has actually saved', async () => {
    const { channel, receiver } = setup();
    const sink = new FakeSink();
    let release!: () => void;
    sink.gate = new Promise<void>((resolve) => (release = resolve));
    channel.emitMessage(meta(ACK_INTERVAL_BYTES * 2));
    receiver.accept(sink);

    for (let i = 0; i < ACK_INTERVAL_BYTES / CHUNK_SIZE; i += 1) channel.emitMessage(chunk(CHUNK_SIZE));
    await flush(30);
    expect(acks(channel)).toEqual([]);

    release();
    await waitFor(() => acks(channel).length === 1);
    expect(acks(channel)).toEqual([ACK_INTERVAL_BYTES]);
  });

  it('closes the sink and reports done after the complete message, acking the final bytes', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(100));
    receiver.accept(sink);
    channel.emitMessage(chunk(100));
    channel.emitMessage(complete(100));
    await waitFor(() => last().phase === 'done');
    expect(sink.closed).toBe(1);
    expect(sink.aborted).toBe(0);
    expect(last().savedBytes).toBe(100);
    expect(acks(channel).at(-1)).toBe(100);
  });

  it('accepts and finishes an empty file', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(0));
    receiver.accept(sink);
    channel.emitMessage(complete(0));
    await waitFor(() => last().phase === 'done');
    expect(sink.closed).toBe(1);
  });

  it('finishes if the channel closes after every byte was saved but before complete arrived', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(50));
    receiver.accept(sink);
    channel.emitMessage(chunk(50));
    await waitFor(() => sink.written.length === 1);
    channel.close();
    await waitFor(() => last().phase === 'done');
    expect(sink.closed).toBe(1);
  });

  it('cancel() notifies the sender and aborts the stream without closing it', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(CHUNK_SIZE * 4));
    receiver.accept(sink);
    channel.emitMessage(chunk(CHUNK_SIZE));
    await waitFor(() => sink.written.length === 1);
    receiver.cancel();
    await waitFor(() => sink.aborted === 1);
    expect(channel.messagesOf('cancel')).toHaveLength(1);
    expect(sink.closed).toBe(0);
    expect(last().phase).toBe('canceled');
  });

  it('aborts the stream when the connection drops mid-transfer', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(CHUNK_SIZE * 4));
    receiver.accept(sink);
    channel.emitMessage(chunk(CHUNK_SIZE));
    channel.close();
    await waitFor(() => last().phase === 'failed');
    expect(last().reason).toBe('connection-lost');
    expect(sink.aborted).toBe(1);
    expect(sink.closed).toBe(0);
  });

  it('aborts the stream, tells the sender and fails when storing a chunk fails', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    sink.failOnWrite = true;
    channel.emitMessage(meta(100));
    receiver.accept(sink);
    channel.emitMessage(chunk(100));
    await waitFor(() => last().phase === 'failed');
    expect(last().reason).toBe('storage');
    expect(sink.aborted).toBe(1);
    expect(channel.messagesOf('error')).toHaveLength(1);
  });

  it('fails when more bytes arrive than the metadata promised', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(10));
    receiver.accept(sink);
    channel.emitMessage(chunk(11));
    await waitFor(() => last().phase === 'failed');
    expect(last().reason).toBe('protocol');
    expect(sink.aborted).toBe(1);
  });

  it('fails when complete arrives with fewer bytes than promised', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(10));
    receiver.accept(sink);
    channel.emitMessage(chunk(5));
    channel.emitMessage(complete(10));
    await waitFor(() => last().phase === 'failed');
    expect(sink.aborted).toBe(1);
    expect(sink.closed).toBe(0);
  });

  it('treats a sender abort as a failure and aborts the stream', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(100));
    receiver.accept(sink);
    channel.emitMessage(JSON.stringify({ t: 'abort', reason: 'sender-canceled' }));
    await waitFor(() => last().phase === 'failed');
    expect(last().reason).toBe('sender-aborted');
    expect(sink.aborted).toBe(1);
  });

  it('abort(reason) lets the session end a transfer from outside (e.g. sender left)', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(100));
    receiver.accept(sink);
    receiver.abort('sender-left');
    await waitFor(() => sink.aborted === 1);
    expect(last()).toMatchObject({ phase: 'failed', reason: 'sender-left' });
    expect(channel.messagesOf('error')).toHaveLength(0);
  });

  it('ignores file bytes that arrive before the user accepted', async () => {
    const { channel, last } = setup();
    channel.emitMessage(meta(100));
    channel.emitMessage(chunk(100));
    await flush();
    expect(last().phase).toBe('failed');
    expect(last().reason).toBe('protocol');
  });

  it('decline() tells the sender and moves to canceled', () => {
    const { channel, receiver, last } = setup();
    channel.emitMessage(meta(100));
    receiver.decline();
    expect(channel.messagesOf('reject')).toEqual([{ t: 'reject', reason: 'declined' }]);
    expect(last().phase).toBe('canceled');
  });

  describe('memory-only fallback (500MB limit)', () => {
    it('lets a file of exactly 500MB through to review', () => {
      const { channel, last } = setup({ memoryOnly: true });
      channel.emitMessage(meta(MAX_BLOB_BYTES));
      expect(last().phase).toBe('review');
      expect(channel.messagesOf('reject')).toHaveLength(0);
    });

    it('blocks a file over 500MB before the transfer starts and tells the sender', () => {
      const { channel, receiver, last } = setup({ memoryOnly: true });
      const sink = new FakeSink();
      channel.emitMessage(meta(MAX_BLOB_BYTES + 1));
      expect(last().phase).toBe('blocked');
      expect(last().reason).toBe('too-large');
      expect(channel.messagesOf('reject')).toEqual([{ t: 'reject', reason: 'too-large' }]);
      receiver.accept(sink);
      expect(channel.messagesOf('accept')).toHaveLength(0);
    });

    it('does not limit size when streaming to disk', () => {
      const { channel, last } = setup({ memoryOnly: false });
      channel.emitMessage(meta(MAX_BLOB_BYTES * 10));
      expect(last().phase).toBe('review');
    });
  });
});
