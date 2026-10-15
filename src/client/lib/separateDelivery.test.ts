import { describe, expect, it } from 'vitest';
import { MAX_BLOB_BYTES } from '../../shared/transfer';
import { prepareSource } from './bundle';
import { FileReceiver, type ReceiveSnapshot } from './fileReceiver';
import { FileSender, type SendSnapshot } from './fileSender';
import { SplitSink } from './sink';
import { FakeChannel, FakeSink, linkChannels, makeFile, waitFor } from './testFakes';

const file = (name: string, content: string) => new File([content], name, { lastModified: 1_700_000_000_000 });
const files3 = () => [file('a.txt', 'AAA'), file('b.txt', ''), file('c.txt', 'CCCCC')];

const entries = [
  { name: 'a.txt', size: 3 },
  { name: 'b.txt', size: 2 },
];
const zipMeta = (size: number, extra: object = {}) =>
  JSON.stringify({ t: 'meta', name: 'DROP6 파일 2개.zip', size, mime: 'application/zip', files: entries, ...extra });
const complete = (size: number) => JSON.stringify({ t: 'complete', size });

describe('FileReceiver, files delivery', () => {
  function setup(options: { memoryOnly?: boolean } = {}) {
    const channel = new FakeChannel();
    const snapshots: ReceiveSnapshot[] = [];
    const receiver = new FileReceiver(channel, { memoryOnly: options.memoryOnly ?? false }, (s) => snapshots.push(s));
    return { channel, receiver, last: () => snapshots.at(-1)! };
  }

  it('passes the file list on with the file info', () => {
    const { channel, last } = setup();
    channel.emitMessage(zipMeta(400));
    expect(last()).toMatchObject({ phase: 'review', meta: { size: 400, files: entries } });
  });

  it('asks for the files back to back and expects exactly their added-up size, not the zip size', async () => {
    const { channel, receiver, last } = setup();
    const sink = new FakeSink();
    channel.emitMessage(zipMeta(400));
    receiver.accept(sink, 'files');
    expect(channel.messagesOf('accept')).toEqual([{ t: 'accept', as: 'files' }]);

    channel.emitMessage(new Uint8Array(5).fill(7).buffer);
    channel.emitMessage(complete(5));
    await waitFor(() => last().phase === 'done');
    expect(sink.bytes).toHaveLength(5);
    expect(channel.messagesOf('ack').at(-1)).toEqual({ t: 'ack', bytes: 5 });
  });

  it('fails when the files delivery gets more bytes than the files add up to', async () => {
    const { channel, receiver, last } = setup();
    channel.emitMessage(zipMeta(400));
    receiver.accept(new FakeSink(), 'files');
    channel.emitMessage(new Uint8Array(6).buffer);
    await waitFor(() => last().phase === 'failed');
    expect(last().reason).toBe('protocol');
  });

  it('keeps asking for the zip as before when accepted without a delivery', () => {
    const { channel, receiver } = setup();
    channel.emitMessage(zipMeta(400));
    receiver.accept(new FakeSink());
    expect(channel.messagesOf('accept')).toEqual([{ t: 'accept' }]);
  });

  it('ignores a files delivery when the sender listed no files', () => {
    const { channel, receiver, last } = setup();
    channel.emitMessage(JSON.stringify({ t: 'meta', name: 'one.bin', size: 10, mime: '' }));
    receiver.accept(new FakeSink(), 'files');
    expect(last().phase).toBe('review');
    expect(channel.sent).toHaveLength(0);
  });

  describe('in a browser that keeps files in memory', () => {
    const half = MAX_BLOB_BYTES / 2 + 1;
    const bigZip = JSON.stringify({
      t: 'meta',
      name: 'big.zip',
      size: half * 2 + 100,
      mime: 'application/zip',
      files: [
        { name: 'x', size: half },
        { name: 'y', size: half },
      ],
    });

    it('still lets the receiver review when only the files one by one fit', () => {
      const { channel, last } = setup({ memoryOnly: true });
      channel.emitMessage(bigZip);
      expect(last().phase).toBe('review');
      expect(channel.messagesOf('reject')).toHaveLength(0);
    });

    it('refuses the zip that does not fit even when the receiver insists', () => {
      const { channel, receiver, last } = setup({ memoryOnly: true });
      channel.emitMessage(bigZip);
      receiver.accept(new FakeSink(), 'zip');
      expect(last().phase).toBe('review');
      expect(channel.messagesOf('accept')).toHaveLength(0);
    });

    it('blocks the transfer when one file alone is over the limit', () => {
      const { channel, last } = setup({ memoryOnly: true });
      channel.emitMessage(
        JSON.stringify({
          t: 'meta',
          name: 'big.zip',
          size: MAX_BLOB_BYTES * 3,
          mime: 'application/zip',
          files: [
            { name: 'x', size: MAX_BLOB_BYTES + 1 },
            { name: 'y', size: 1 },
          ],
        }),
      );
      expect(last()).toMatchObject({ phase: 'blocked', reason: 'too-large' });
      expect(channel.messagesOf('reject')).toEqual([{ t: 'reject', reason: 'too-large' }]);
    });
  });
});

describe('FileSender, separate files', () => {
  async function setup() {
    const prepared = await prepareSource(files3());
    const channel = new FakeChannel();
    const other = new FakeChannel();
    linkChannels(channel, other);
    const snapshots: SendSnapshot[] = [];
    const sender = new FileSender(channel, prepared.source, (s) => snapshots.push(s), prepared.separate);
    return { prepared, channel, other, sender, last: () => snapshots.at(-1)! };
  }
  const sentBytes = (channel: FakeChannel) => new Blob(channel.chunks).arrayBuffer();

  it('tells the receiver which files are inside the zip', async () => {
    const { channel, sender, prepared } = await setup();
    sender.start();
    expect(channel.messages[0]).toEqual({
      t: 'meta',
      name: 'DROP6 파일 3개.zip',
      size: prepared.source.size,
      mime: 'application/zip',
      files: [
        { name: 'a.txt', size: 3 },
        { name: 'b.txt', size: 0 },
        { name: 'c.txt', size: 5 },
      ],
    });
  });

  it('streams the zip when the receiver accepts as before', async () => {
    const { channel, sender, last, prepared } = await setup();
    sender.start();
    channel.emitMessage(JSON.stringify({ t: 'accept' }));
    await waitFor(() => channel.chunks.length > 0);
    expect(last().totalBytes).toBe(prepared.source.size);
    expect((await sentBytes(channel)).byteLength).toBe(prepared.source.size);
  });

  it('streams the files back to back, with their added-up size as the total, when asked for files', async () => {
    const { channel, sender, last } = await setup();
    sender.start();
    channel.emitMessage(JSON.stringify({ t: 'accept', as: 'files' }));
    await waitFor(() => channel.chunks.length === 1);
    expect(last()).toMatchObject({ phase: 'sending', totalBytes: 8 });
    expect(new TextDecoder().decode(await sentBytes(channel))).toBe('AAACCCCC');
  });

  it('sends complete with the files size once the last byte is acknowledged', async () => {
    const { channel, sender, last } = await setup();
    sender.start();
    channel.emitMessage(JSON.stringify({ t: 'accept', as: 'files' }));
    await waitFor(() => channel.chunks.length === 1);
    channel.emitMessage(JSON.stringify({ t: 'ack', bytes: 8 }));
    await waitFor(() => last().phase === 'done');
    expect(channel.messagesOf('complete')).toEqual([{ t: 'complete', size: 8 }]);
  });

  it('fails when files are asked for but none were offered', async () => {
    const channel = new FakeChannel();
    const snapshots: SendSnapshot[] = [];
    const sender = new FileSender(channel, makeFile(100), (s) => snapshots.push(s));
    sender.start();
    channel.emitMessage(JSON.stringify({ t: 'accept', as: 'files' }));
    expect(snapshots.at(-1)).toMatchObject({ phase: 'failed', reason: 'protocol' });
    expect(channel.chunks).toHaveLength(0);
  });
});

describe('sender and receiver together, files delivery', () => {
  /** One sender/receiver pair over a linked fake network; every file lands in its own FakeSink. */
  async function run(inputs: File[], delivery: 'zip' | 'files') {
    const prepared = await prepareSource(inputs);
    const senderChannel = new FakeChannel();
    const receiverChannel = new FakeChannel();
    linkChannels(senderChannel, receiverChannel);
    let send!: SendSnapshot;
    let receive!: ReceiveSnapshot;
    const sender = new FileSender(senderChannel, prepared.source, (s) => (send = s), prepared.separate);
    const receiver = new FileReceiver(receiverChannel, { memoryOnly: false }, (s) => (receive = s));

    const opened: Array<{ name: string; sink: FakeSink }> = [];
    const whole = new FakeSink();
    sender.start();
    await waitFor(() => receive?.phase === 'review');
    const sink =
      delivery === 'files'
        ? new SplitSink('memory', receive.meta!.files!, async (name) => {
            const fake = new FakeSink();
            opened.push({ name, sink: fake });
            return fake;
          })
        : whole;
    receiver.accept(sink, delivery);
    await waitFor(() => send.phase === 'done' && receive.phase === 'done');
    return { opened, whole, send, receive };
  }

  it('saves every file on its own with exactly its own bytes', async () => {
    const inputs = [makeFile(300_000, 'big.bin'), file('empty.txt', ''), makeFile(70_001, 'small.bin'), file('note.txt', 'hello')];
    const { opened, send, receive } = await run(inputs, 'files');

    expect(opened.map((f) => f.name)).toEqual(['big.bin', 'empty.txt', 'small.bin', 'note.txt']);
    for (const [i, input] of inputs.entries()) {
      expect(Buffer.from(opened[i]!.sink.bytes).equals(Buffer.from(await input.arrayBuffer()))).toBe(true);
      expect(opened[i]!.sink.closed).toBe(1);
    }
    const total = inputs.reduce((sum, input) => sum + input.size, 0);
    expect(send).toMatchObject({ phase: 'done', ackedBytes: total, totalBytes: total });
    expect(receive.savedBytes).toBe(total);
  });

  it('still delivers the zip to a receiver who wants it, from the same sender', async () => {
    const inputs = files3();
    const { whole, send } = await run(inputs, 'zip');
    const prepared = await prepareSource(inputs);
    expect(Buffer.from(whole.bytes).equals(Buffer.from(await prepared.source.slice(0, prepared.source.size).arrayBuffer()))).toBe(true);
    expect(send.totalBytes).toBe(prepared.source.size);
  });
});
