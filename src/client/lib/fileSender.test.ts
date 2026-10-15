import { describe, expect, it } from 'vitest';
import {
  BUFFERED_LOW_THRESHOLD,
  CHUNK_SIZE,
  MAX_BUFFERED_AMOUNT,
  MAX_UNACKED_BYTES,
} from '../../shared/transfer';
import { FileSender, type SendSnapshot } from './fileSender';
import { FakeChannel, flush, linkChannels, makeFile, waitFor } from './testFakes';

function setup(size = 200_000) {
  const channel = new FakeChannel();
  const file = makeFile(size);
  const snapshots: SendSnapshot[] = [];
  const sender = new FileSender(channel, file, (snapshot) => snapshots.push(snapshot));
  return { channel, file, sender, last: () => snapshots.at(-1)!, snapshots };
}

/** The network instantly accepts whatever is sent. */
function autoDrain(channel: FakeChannel): void {
  channel.onSend = () => void setTimeout(() => channel.drain(), 0);
}

const accept = (channel: FakeChannel) => channel.emitMessage(JSON.stringify({ t: 'accept' }));
const ack = (channel: FakeChannel, bytes: number) => channel.emitMessage(JSON.stringify({ t: 'ack', bytes }));
const sentBytes = (channel: FakeChannel) => channel.chunks.reduce((n, c) => n + c.byteLength, 0);

describe('FileSender', () => {
  it('sends metadata as a string first and no file bytes before the receiver accepts', async () => {
    const { channel, sender, last } = setup(1234);
    sender.start();
    expect(channel.sent[0]).toBeTypeOf('string');
    expect(channel.messages[0]).toEqual({
      t: 'meta',
      name: 'sample.bin',
      size: 1234,
      mime: 'application/octet-stream',
    });
    await flush();
    expect(channel.chunks).toHaveLength(0);
    expect(last().phase).toBe('waiting');
  });

  it('streams the file as 64KiB binary chunks in order once accepted', async () => {
    const { channel, file, sender } = setup(3 * CHUNK_SIZE + 100);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => channel.chunks.length === 4);
    expect(channel.chunks.map((c) => c.byteLength)).toEqual([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, 100]);
    const sent = new Uint8Array(await new Blob(channel.chunks).arrayBuffer());
    expect(sent).toEqual(new Uint8Array(await file.arrayBuffer()));
  });

  it('never lets bufferedAmount exceed 1MiB and resumes on bufferedamountlow', async () => {
    const { channel, sender } = setup(4 * 1024 * 1024);
    const other = new FakeChannel();
    const network = linkChannels(channel, other);
    let lowEvents = 0;
    channel.addEventListener('bufferedamountlow', () => (lowEvents += 1));

    network.pause();
    sender.start();
    accept(channel);
    await flush(40);

    expect(channel.bufferedAmountLowThreshold).toBe(BUFFERED_LOW_THRESHOLD);
    expect(channel.bufferedAmount).toBeLessThanOrEqual(MAX_BUFFERED_AMOUNT);
    expect(channel.bufferedAmount + CHUNK_SIZE).toBeGreaterThan(MAX_BUFFERED_AMOUNT);
    const stalledAt = channel.chunks.length;
    expect(stalledAt).toBeLessThan(64);

    network.resume();
    await waitFor(() => channel.chunks.length === 64);
    expect(lowEvents).toBeGreaterThan(0);
    expect(channel.maxBufferedAmount).toBeLessThanOrEqual(MAX_BUFFERED_AMOUNT);
  });

  it('counts progress from receiver ACKs, not from bytes sent', async () => {
    const { channel, sender, last } = setup(300_000);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => sentBytes(channel) === 300_000);
    expect(last().phase).toBe('sending');
    expect(last().ackedBytes).toBe(0);

    ack(channel, CHUNK_SIZE);
    expect(last().ackedBytes).toBe(CHUNK_SIZE);
    ack(channel, 1_000); // stale, lower ACK is ignored
    expect(last().ackedBytes).toBe(CHUNK_SIZE);
    expect(last().totalBytes).toBe(300_000);
  });

  it('pauses when too many bytes are unacknowledged and continues as ACKs arrive', async () => {
    const { channel, sender } = setup(10 * 1024 * 1024);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => sentBytes(channel) === MAX_UNACKED_BYTES);
    await flush(30);
    expect(sentBytes(channel)).toBe(MAX_UNACKED_BYTES);

    ack(channel, 1024 * 1024);
    await waitFor(() => sentBytes(channel) === MAX_UNACKED_BYTES + 1024 * 1024);
  });

  it('sends the complete message only after the last byte is acknowledged', async () => {
    const { channel, sender, last } = setup(100_000);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => sentBytes(channel) === 100_000);
    await flush(30);
    expect(channel.messagesOf('complete')).toHaveLength(0);

    ack(channel, 50_000);
    await flush(30);
    expect(channel.messagesOf('complete')).toHaveLength(0);

    ack(channel, 100_000);
    await waitFor(() => channel.messagesOf('complete').length === 1);
    expect(channel.messagesOf('complete')[0]).toEqual({ t: 'complete', size: 100_000 });
    expect(typeof channel.sent.at(-1)).toBe('string');
    expect(last()).toMatchObject({ phase: 'done', ackedBytes: 100_000 });
  });

  it('completes an empty file right after accept', async () => {
    const { channel, sender, last } = setup(0);
    sender.start();
    accept(channel);
    await waitFor(() => last().phase === 'done');
    expect(channel.messagesOf('complete')[0]).toEqual({ t: 'complete', size: 0 });
    expect(channel.chunks).toHaveLength(0);
  });

  it('stops without sending anything when the receiver rejects', async () => {
    const { channel, sender, last } = setup();
    sender.start();
    channel.emitMessage(JSON.stringify({ t: 'reject', reason: 'too-large' }));
    expect(last()).toMatchObject({ phase: 'rejected', reason: 'too-large' });
    await flush();
    expect(channel.chunks).toHaveLength(0);
  });

  it.each([
    ['cancel', { t: 'cancel' }, 'canceled'],
    ['error', { t: 'error', reason: 'storage' }, 'failed'],
  ] as const)('stops sending when the receiver sends %s mid-transfer', async (_name, message, phase) => {
    const { channel, sender, last } = setup(5 * 1024 * 1024);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => channel.chunks.length > 2);
    channel.emitMessage(JSON.stringify(message));
    expect(last().phase).toBe(phase);
    await flush();
    const frozen = channel.chunks.length;
    await flush(30);
    expect(channel.chunks.length).toBe(frozen);
  });

  it('fails with connection-lost when the channel closes mid-transfer', async () => {
    const { channel, sender, last } = setup(5 * 1024 * 1024);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => channel.chunks.length > 2);
    channel.close();
    expect(last()).toMatchObject({ phase: 'failed', reason: 'connection-lost' });
  });

  it('fails on an ACK for more bytes than were sent', async () => {
    const { channel, sender, last } = setup(100_000);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => sentBytes(channel) === 100_000);
    ack(channel, 100_001);
    expect(last()).toMatchObject({ phase: 'failed', reason: 'protocol' });
  });

  it('ignores malformed control messages instead of crashing', async () => {
    const { channel, sender, last } = setup();
    sender.start();
    channel.emitMessage('{nope');
    channel.emitMessage(JSON.stringify({ t: 'something-else' }));
    channel.emitMessage(new ArrayBuffer(4));
    expect(last().phase).toBe('waiting');
  });

  it('cancel() stops locally and tells the receiver', async () => {
    const { channel, sender, last } = setup(5 * 1024 * 1024);
    autoDrain(channel);
    sender.start();
    accept(channel);
    await waitFor(() => channel.chunks.length > 1);
    sender.cancel();
    expect(last().phase).toBe('canceled');
    expect(channel.messagesOf('abort')).toHaveLength(1);
  });
});
