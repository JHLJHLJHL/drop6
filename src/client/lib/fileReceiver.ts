import {
  ACK_INTERVAL_BYTES,
  payloadSize,
  senderMessageSchema,
  type Delivery,
  type FileEntry,
  type FileMeta,
  type ReceiverMessage,
} from '../../shared/transfer';
import { trySend, type ChannelLike } from './channel';
import { receiveOptions, type FileSink } from './sink';

/** `paused`: the connection dropped mid-transfer; what was saved so far is kept until the sender connects again. */
export type ReceivePhase = 'waiting' | 'review' | 'blocked' | 'receiving' | 'paused' | 'done' | 'canceled' | 'failed';

export interface ReceiveSnapshot {
  phase: ReceivePhase;
  meta?: FileMeta | undefined;
  /** Bytes the sink has actually stored. */
  savedBytes: number;
  reason?: string | undefined;
}

const TERMINAL: readonly ReceivePhase[] = ['blocked', 'done', 'canceled', 'failed'];

/** Receives one file on one DataChannel and stores it through a FileSink. */
export class FileReceiver {
  private phase: ReceivePhase = 'waiting';
  private meta: FileMeta | undefined;
  private delivery: Delivery = 'zip';
  private reason: string | undefined;
  private sink: FileSink | undefined;
  private received = 0;
  private saved = 0;
  private lastAcked = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private settling = false;
  /** A new connection was handed over while paused; its first message must be the same file's meta. */
  private resuming = false;

  constructor(
    private channel: ChannelLike,
    private readonly options: { memoryOnly: boolean },
    private readonly onChange: (snapshot: ReceiveSnapshot) => void,
  ) {
    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('close', this.handleClose);
  }

  get snapshot(): ReceiveSnapshot {
    return { phase: this.phase, meta: this.meta, savedBytes: this.saved, reason: this.reason };
  }

  /** Waiting for the sender to connect again; the sink is still open and nothing saved is lost. */
  get isPaused(): boolean {
    return this.phase === 'paused';
  }

  /**
   * The connection dropped mid-transfer (or is being replaced). Keeps the sink and what it holds,
   * and waits for `resume` with the next connection. Only has an effect while receiving.
   */
  suspend(): void {
    if (this.phase !== 'receiving') return;
    this.unlisten();
    this.phase = 'paused';
    this.resuming = false;
    this.onChange(this.snapshot);
  }

  /**
   * Picks the transfer up again on a new connection: once the sender announces the same file,
   * it is asked to continue right after the last byte that was saved.
   */
  resume(channel: ChannelLike): void {
    if (this.phase !== 'paused') return;
    this.unlisten();
    this.channel = channel;
    this.resuming = true;
    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('close', this.handleClose);
  }

  /** Stops listening to the connection without touching the transfer (it was replaced by another receiver object). */
  detach(): void {
    this.unlisten();
  }

  private unlisten(): void {
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('close', this.handleClose);
  }

  private get terminal(): boolean {
    return TERMINAL.includes(this.phase);
  }

  /** Bytes this transfer will carry: the file or zip, or the several files added up. */
  private get expectedBytes(): number {
    return this.meta ? payloadSize(this.meta, this.delivery) : 0;
  }

  /**
   * User accepted: start receiving into `sink`. Only valid while reviewing the file info.
   * `delivery` 'files' takes the files of a multi-file transfer one by one instead of the zip;
   * then `sink` must split the incoming bytes by `meta.files`.
   */
  accept(sink: FileSink, delivery: Delivery = 'zip'): void {
    if (this.phase !== 'review') return;
    if (!this.meta || !receiveOptions(this.meta, !this.options.memoryOnly)[delivery]) return;
    this.sink = sink;
    this.delivery = delivery;
    this.phase = 'receiving';
    this.onChange(this.snapshot);
    // The connection may have dropped while the user was deciding: wait for the sender to connect again.
    if (!this.send(delivery === 'files' ? { t: 'accept', as: 'files' } : { t: 'accept' })) this.suspend();
  }

  /** User said no before anything was sent. */
  decline(): void {
    if (this.terminal) return;
    this.send({ t: 'reject', reason: 'declined' });
    this.finish('canceled', 'declined');
  }

  /** User stopped the transfer. Only this receiver's connection ends; the stream is aborted. */
  cancel(): void {
    if (this.terminal) return;
    if (this.phase === 'paused') {
      const sink = this.sink;
      this.send({ t: 'cancel' }); // best effort: the connection is probably gone
      this.finish('canceled', 'local');
      void sink?.abort();
      return;
    }
    if (this.phase !== 'receiving') {
      this.decline();
      return;
    }
    this.send({ t: 'cancel' });
    const sink = this.sink;
    this.finish('canceled', 'local');
    void sink?.abort();
  }

  /** Ends the transfer from outside (e.g. signaling reported the sender is gone). */
  abort(reason: string): void {
    void this.fail(reason);
  }

  private send(message: ReceiverMessage): boolean {
    return trySend(this.channel, JSON.stringify(message));
  }

  private finish(phase: ReceivePhase, reason?: string): void {
    if (this.terminal) return;
    this.phase = phase;
    this.reason = reason;
    this.unlisten();
    this.onChange(this.snapshot);
  }

  private async fail(reason: string): Promise<void> {
    if (this.terminal) return;
    const sink = this.sink;
    this.finish('failed', reason);
    if (reason === 'storage' || reason === 'protocol') this.send({ t: 'error', reason });
    await sink?.abort();
  }

  private readonly handleClose = (): void => {
    if (this.terminal) return;
    if (this.phase === 'paused') {
      // The new connection died before it got going: keep waiting for the next one.
      this.resuming = false;
      this.unlisten();
      return;
    }
    if (this.phase !== 'receiving') {
      // Nothing is being received yet: the screen stays as it is. The sender connects again on its own
      // (the next offer replaces this receiver), or the room closes and the session reports why.
      this.unlisten();
      return;
    }
    // Writes already in flight may still complete the file; wait for them before judging.
    void this.writeChain.then(() => {
      if (this.terminal || this.settling) return;
      if (this.meta && this.saved === this.expectedBytes) void this.finalize(this.expectedBytes);
      else this.suspend(); // what is saved stays; the sender may come back
    });
  };

  private readonly handleMessage = (event: Event): void => {
    const data = (event as MessageEvent).data as unknown;
    if (typeof data === 'string') {
      this.handleControl(data);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    if (this.phase === 'receiving') this.handleChunk(data);
    else if (!this.terminal && this.phase !== 'paused') void this.fail('protocol');
  };

  /** The sender announced a file on a new connection: continue if it is the one being received. */
  private continueWith(message: { name: string; size: number; mime: string; files?: FileEntry[] | undefined }): void {
    const known = this.meta;
    const same =
      known !== undefined &&
      message.name === known.name &&
      message.size === known.size &&
      message.mime === known.mime &&
      JSON.stringify(message.files) === JSON.stringify(known.files);
    if (!same) {
      void this.fail('protocol');
      return;
    }
    this.resuming = false;
    // Everything received before the drop is written first; the sender then restarts right after it.
    void this.writeChain.then(() => {
      if (this.terminal || this.phase !== 'paused') return;
      this.received = this.saved;
      this.lastAcked = this.saved;
      this.phase = 'receiving';
      this.onChange(this.snapshot);
      const accept: ReceiverMessage = { t: 'accept', ...(this.delivery === 'files' && { as: 'files' as const }), from: this.saved };
      if (!this.send(accept)) this.suspend();
    });
  }

  private handleControl(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = senderMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.t) {
      case 'meta':
        if (this.phase === 'paused' && this.resuming) {
          this.continueWith(message);
          break;
        }
        if (this.phase !== 'waiting') {
          void this.fail('protocol');
          break;
        }
        this.meta = { name: message.name, size: message.size, mime: message.mime, files: message.files };
        if (this.options.memoryOnly && !this.canTakeAny(this.meta)) {
          this.send({ t: 'reject', reason: 'too-large' });
          this.finish('blocked', 'too-large');
        } else {
          this.phase = 'review';
          this.onChange(this.snapshot);
        }
        break;
      case 'complete':
        if (this.phase === 'receiving') void this.finalize(message.size);
        break;
      case 'abort':
        if (!this.terminal) void this.fail('sender-aborted');
        break;
    }
  }

  /** A memory-only browser can still take the files one by one when the zip itself is too big. */
  private canTakeAny(meta: FileMeta): boolean {
    const options = receiveOptions(meta, !this.options.memoryOnly);
    return options.zip || options.files;
  }

  private handleChunk(chunk: ArrayBuffer): void {
    const { meta, sink } = this;
    if (!meta || !sink || this.received + chunk.byteLength > this.expectedBytes) {
      void this.fail('protocol');
      return;
    }
    this.received += chunk.byteLength;
    // Writes are chained so the sink sees chunks one at a time, in order.
    this.writeChain = this.writeChain.then(async () => {
      if (this.terminal) return;
      try {
        await sink.write(chunk);
      } catch {
        await this.fail('storage');
        return;
      }
      this.saved += chunk.byteLength;
      this.onChange(this.snapshot);
      this.ackIfDue();
    });
  }

  private ackIfDue(): void {
    const size = this.expectedBytes;
    if (this.saved > this.lastAcked && (this.saved - this.lastAcked >= ACK_INTERVAL_BYTES || this.saved === size)) {
      this.lastAcked = this.saved;
      this.send({ t: 'ack', bytes: this.saved });
    }
  }

  private async finalize(announcedSize: number): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    await this.writeChain;
    const { meta, sink } = this;
    if (this.terminal || !meta || !sink) return;
    if (this.saved !== this.expectedBytes || announcedSize !== this.expectedBytes) {
      await this.fail('protocol');
      return;
    }
    try {
      await sink.close();
    } catch {
      await this.fail('storage');
      return;
    }
    this.finish('done');
  }
}
