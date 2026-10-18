import {
  BUFFERED_LOW_THRESHOLD,
  CHUNK_SIZE,
  MAX_BUFFERED_AMOUNT,
  MAX_UNACKED_BYTES,
  receiverMessageSchema,
  type SenderMessage,
} from '../../shared/transfer';
import { trySend, type ChannelLike, type FileSource, type SeparateSource } from './channel';

export type SendPhase = 'waiting' | 'sending' | 'done' | 'rejected' | 'canceled' | 'failed';

export interface SendSnapshot {
  phase: SendPhase;
  /** Bytes the receiver confirmed as saved. This is the progress source of truth. */
  ackedBytes: number;
  totalBytes: number;
  reason?: string | undefined;
}

const TERMINAL: readonly SendPhase[] = ['done', 'rejected', 'canceled', 'failed'];

/**
 * Sends one file to one receiver over one DataChannel. Each receiver gets its own
 * instance, so a failure or cancel here cannot affect any other receiver.
 *
 * With `separate`, the receiver may ask for the files back to back instead of the
 * zip `file`; whichever it picks becomes what this instance streams.
 */
export class FileSender {
  private phase: SendPhase = 'waiting';
  private reason: string | undefined;
  private sent = 0;
  private acked = 0;
  private wake: (() => void) | undefined;
  private payload: FileSource;

  constructor(
    private readonly channel: ChannelLike,
    private readonly file: FileSource,
    private readonly onChange: (snapshot: SendSnapshot) => void,
    private readonly separate?: SeparateSource,
  ) {
    this.payload = file;
    channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('bufferedamountlow', this.notify);
    channel.addEventListener('close', this.handleClose);
  }

  get snapshot(): SendSnapshot {
    return { phase: this.phase, ackedBytes: this.acked, totalBytes: this.payload.size, reason: this.reason };
  }

  private get terminal(): boolean {
    return TERMINAL.includes(this.phase);
  }

  /** Sends the metadata and waits for the receiver to accept. No file bytes go out before that. */
  start(): void {
    const meta: SenderMessage = {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      mime: this.file.type || 'application/octet-stream',
      ...(this.separate && { files: this.separate.entries }),
    };
    if (!trySend(this.channel, JSON.stringify(meta))) {
      this.finish('failed', 'connection-lost');
      return;
    }
    this.onChange(this.snapshot);
  }

  /** Stops this transfer locally (receiver left, user stopped). */
  cancel(): void {
    if (this.terminal) return;
    const abort: SenderMessage = { t: 'abort', reason: 'sender-canceled' };
    trySend(this.channel, JSON.stringify(abort));
    this.finish('canceled', 'local');
  }

  private readonly notify = (): void => {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  };

  private nextWake(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private finish(phase: SendPhase, reason?: string): void {
    if (this.terminal) return;
    this.phase = phase;
    this.reason = reason;
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('bufferedamountlow', this.notify);
    this.channel.removeEventListener('close', this.handleClose);
    this.notify();
    this.onChange(this.snapshot);
  }

  private readonly handleClose = (): void => {
    this.finish('failed', 'connection-lost');
  };

  private readonly handleMessage = (event: Event): void => {
    const data = (event as MessageEvent).data as unknown;
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = receiverMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.t) {
      case 'accept':
        if (this.phase === 'waiting') {
          if (message.as === 'files') {
            if (!this.separate) {
              this.finish('failed', 'protocol');
              break;
            }
            this.payload = this.separate.source;
          }
          // A receiver picking up a dropped connection already holds the first `from` bytes.
          const from = message.from ?? 0;
          if (from > this.payload.size) {
            this.finish('failed', 'protocol');
            break;
          }
          this.sent = from;
          this.acked = from;
          this.phase = 'sending';
          this.onChange(this.snapshot);
          void this.pump();
        }
        break;
      case 'reject':
        this.finish('rejected', message.reason);
        break;
      case 'cancel':
        this.finish('canceled', 'receiver');
        break;
      case 'error':
        this.finish('failed', 'receiver-error');
        break;
      case 'ack':
        if (this.phase !== 'sending') break;
        if (message.bytes > this.sent) {
          this.finish('failed', 'protocol');
        } else if (message.bytes > this.acked) {
          this.acked = message.bytes;
          this.onChange(this.snapshot);
          this.notify();
        }
        break;
    }
  };

  /** Streams chunks with backpressure on both the local send buffer and unacked bytes. */
  private async pump(): Promise<void> {
    const { size } = this.payload;
    while (this.sent < size) {
      while (!this.terminal && (this.channel.bufferedAmount + CHUNK_SIZE > MAX_BUFFERED_AMOUNT || this.sent - this.acked >= MAX_UNACKED_BYTES)) {
        await this.nextWake();
      }
      if (this.terminal) return;

      const end = Math.min(this.sent + CHUNK_SIZE, size);
      let chunk: ArrayBuffer;
      try {
        chunk = await this.payload.slice(this.sent, end).arrayBuffer();
      } catch {
        this.finish('failed', 'read-failed');
        return;
      }
      if (this.terminal) return;
      if (!trySend(this.channel, chunk)) {
        this.finish('failed', 'connection-lost');
        return;
      }
      this.sent = end;
    }

    // Everything is out; wait until the receiver confirmed the last byte is saved.
    while (!this.terminal && this.acked < size) await this.nextWake();
    if (this.terminal) return;

    const complete: SenderMessage = { t: 'complete', size };
    if (trySend(this.channel, JSON.stringify(complete))) this.finish('done');
    else this.finish('failed', 'connection-lost');
  }
}
