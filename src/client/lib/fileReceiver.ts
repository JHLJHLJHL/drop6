import {
  ACK_INTERVAL_BYTES,
  payloadSize,
  senderMessageSchema,
  type Delivery,
  type FileMeta,
  type ReceiverMessage,
} from '../../shared/transfer';
import { trySend, type ChannelLike } from './channel';
import { receiveOptions, type FileSink } from './sink';

export type ReceivePhase = 'waiting' | 'review' | 'blocked' | 'receiving' | 'done' | 'canceled' | 'failed';

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

  constructor(
    private readonly channel: ChannelLike,
    private readonly options: { memoryOnly: boolean },
    private readonly onChange: (snapshot: ReceiveSnapshot) => void,
  ) {
    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('close', this.handleClose);
  }

  get snapshot(): ReceiveSnapshot {
    return { phase: this.phase, meta: this.meta, savedBytes: this.saved, reason: this.reason };
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
    if (!this.send(delivery === 'files' ? { t: 'accept', as: 'files' } : { t: 'accept' })) void this.fail('connection-lost');
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
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('close', this.handleClose);
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
    if (this.phase !== 'receiving') {
      void this.fail('connection-lost');
      return;
    }
    // Writes already in flight may still complete the file; wait for them before judging.
    void this.writeChain.then(() => {
      if (this.terminal || this.settling) return;
      if (this.meta && this.saved === this.expectedBytes) void this.finalize(this.expectedBytes);
      else void this.fail('connection-lost');
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
    else if (!this.terminal) void this.fail('protocol');
  };

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
