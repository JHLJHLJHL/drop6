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

  it('keeps showing the file info when the connection drops before the user decided', async () => {
    const { channel, last } = setup();
    channel.emitMessage(meta(CHUNK_SIZE * 4));
    channel.close();
    await flush(30);
    expect(last().phase).toBe('review');
  });

  it('waits for the sender instead of failing when the user accepts on a connection that already dropped', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(meta(CHUNK_SIZE * 4));
    channel.close();
    await flush(10);
    receiver.accept(sink);
    expect(last().phase).toBe('paused');
    expect(sink.aborted).toBe(0);

    const next = new FakeChannel();
    receiver.resume(next);
    next.emitMessage(meta(CHUNK_SIZE * 4));
    await waitFor(() => last().phase === 'receiving');
    expect(next.messagesOf('accept')).toEqual([{ t: 'accept', from: 0 }]);
  });

  describe('a connection that drops mid-transfer', () => {
    const size = CHUNK_SIZE * 4;
    const accepts = (channel: FakeChannel) => channel.messagesOf('accept');

    /** Accepts, receives one chunk and lets the connection drop. */
    async function dropAfterOneChunk() {
      const s = setup();
      const sink = new FakeSink();
      s.channel.emitMessage(meta(size));
      s.receiver.accept(sink);
      s.channel.emitMessage(chunk(CHUNK_SIZE, 1));
      await waitFor(() => sink.written.length === 1);
      s.channel.close();
      await waitFor(() => s.last().phase === 'paused');
      return { ...s, sink };
    }

    it('pauses instead of failing, keeping the sink open and what it holds', async () => {
      const { last, sink } = await dropAfterOneChunk();
      expect(last()).toMatchObject({ phase: 'paused', savedBytes: CHUNK_SIZE });
      expect(sink.aborted).toBe(0);
      expect(sink.closed).toBe(0);
    });

    it('continues right after the saved bytes when the sender comes back on a new connection', async () => {
      const { receiver, sink, last } = await dropAfterOneChunk();
      const next = new FakeChannel();
      receiver.resume(next);
      next.emitMessage(meta(size));
      await waitFor(() => last().phase === 'receiving');
      expect(accepts(next)).toEqual([{ t: 'accept', from: CHUNK_SIZE }]);

      next.emitMessage(chunk(CHUNK_SIZE, 2));
      next.emitMessage(chunk(CHUNK_SIZE, 3));
      next.emitMessage(chunk(CHUNK_SIZE, 4));
      await waitFor(() => sink.written.length === 4);
      next.emitMessage(complete(size));
      await waitFor(() => last().phase === 'done');
      expect(sink.bytes.length).toBe(size);
      expect(sink.bytes[0]).toBe(1);
      expect(sink.bytes[size - 1]).toBe(4);
      expect(sink.closed).toBe(1);
      expect(sink.aborted).toBe(0);
    });

    it('asks for the files back to back again when that is how it was receiving', async () => {
      const files = [{ name: 'a.txt', size: CHUNK_SIZE * 2 }, { name: 'b.txt', size: CHUNK_SIZE * 2 }];
      const first = new FakeChannel();
      const snapshots: ReceiveSnapshot[] = [];
      const receiver = new FileReceiver(first, { memoryOnly: false }, (s) => snapshots.push(s));
      const sink = new FakeSink();
      const bundle = JSON.stringify({ t: 'meta', name: 'bundle.zip', size: 999, mime: 'application/zip', files });
      first.emitMessage(bundle);
      receiver.accept(sink, 'files');
      first.emitMessage(chunk(CHUNK_SIZE));
      await waitFor(() => sink.written.length === 1);
      first.close();
      await waitFor(() => snapshots.at(-1)!.phase === 'paused');

      const next = new FakeChannel();
      receiver.resume(next);
      next.emitMessage(bundle);
      await waitFor(() => snapshots.at(-1)!.phase === 'receiving');
      expect(accepts(next)).toEqual([{ t: 'accept', as: 'files', from: CHUNK_SIZE }]);
    });

    it('waits on without failing when the new connection dies before it got going', async () => {
      const { receiver, last } = await dropAfterOneChunk();
      const dead = new FakeChannel();
      receiver.resume(dead);
      dead.close();
      await flush(30);
      expect(last().phase).toBe('paused');

      const next = new FakeChannel();
      receiver.resume(next);
      next.emitMessage(meta(size));
      await waitFor(() => last().phase === 'receiving');
    });

    it('does not take bytes that arrive before the sender was asked to continue', async () => {
      const { receiver, sink, last } = await dropAfterOneChunk();
      const next = new FakeChannel();
      receiver.resume(next);
      next.emitMessage(chunk(CHUNK_SIZE, 9));
      await flush(30);
      expect(sink.written).toHaveLength(1);
      expect(last().phase).toBe('paused');
    });

    it('fails when the sender announces a different file', async () => {
      const { receiver, sink, last } = await dropAfterOneChunk();
      const next = new FakeChannel();
      receiver.resume(next);
      next.emitMessage(JSON.stringify({ t: 'meta', name: 'other.png', size, mime: 'image/png' }));
      await waitFor(() => last().phase === 'failed');
      expect(last().reason).toBe('protocol');
      expect(sink.aborted).toBe(1);
    });

    it('lets the user cancel while waiting, which throws the partial file away', async () => {
      const { receiver, sink, last } = await dropAfterOneChunk();
      receiver.cancel();
      await waitFor(() => sink.aborted === 1);
      expect(last().phase).toBe('canceled');
      expect(sink.closed).toBe(0);
    });

    it('throws the partial file away when the room is given up while waiting', async () => {
      const { receiver, sink, last } = await dropAfterOneChunk();
      receiver.abort('sender-left');
      await waitFor(() => last().phase === 'failed');
      expect(last().reason).toBe('sender-left');
      expect(sink.aborted).toBe(1);
    });

    it('still completes the file when everything was saved before the drop, even if "complete" never arrived', async () => {
      const s = setup();
      const sink = new FakeSink();
      s.channel.emitMessage(meta(CHUNK_SIZE));
      s.receiver.accept(sink);
      s.channel.emitMessage(chunk(CHUNK_SIZE));
      await waitFor(() => sink.written.length === 1);
      s.channel.close();
      await waitFor(() => s.last().phase === 'done');
      expect(sink.closed).toBe(1);
    });

    it('can be suspended from outside when the sender starts over with a connection of its own', async () => {
      const s = setup();
      const sink = new FakeSink();
      s.channel.emitMessage(meta(size));
      s.receiver.accept(sink);
      s.channel.emitMessage(chunk(CHUNK_SIZE));
      await waitFor(() => sink.written.length === 1);
      s.receiver.suspend();
      expect(s.last().phase).toBe('paused');
      s.channel.emitMessage(chunk(CHUNK_SIZE)); // late bytes of the old connection are ignored
      await flush(20);
      expect(sink.written).toHaveLength(1);
    });
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
