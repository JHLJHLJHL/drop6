import type { ChannelLike } from './channel';
import type { FileSink } from './sink';

const encoder = new TextEncoder();

function byteLength(data: string | ArrayBuffer): number {
  return typeof data === 'string' ? encoder.encode(data).length : data.byteLength;
}

/** In-memory RTCDataChannel stand-in with an explicit send buffer. */
export class FakeChannel extends EventTarget implements ChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxBufferedAmount = 0;
  readonly sent: Array<string | ArrayBuffer> = [];
  onSend: ((data: string | ArrayBuffer) => void) | undefined;
  onClose: (() => void) | undefined;

  override addEventListener(type: string, listener: (event: Event) => void): void {
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: (event: Event) => void): void {
    super.removeEventListener(type, listener);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new DOMException('channel closed', 'InvalidStateError');
    this.sent.push(data);
    this.bufferedAmount += byteLength(data);
    this.maxBufferedAmount = Math.max(this.maxBufferedAmount, this.bufferedAmount);
    this.onSend?.(data);
  }

  /** The network accepted `bytes` out of the send buffer. Fires bufferedamountlow when crossing the threshold. */
  drain(bytes = Number.POSITIVE_INFINITY): void {
    const before = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, before - bytes);
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }

  emitMessage(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    this.onClose?.();
  }

  /** Control messages (strings) sent so far, parsed. */
  get messages(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as Record<string, unknown>);
  }

  /** Binary chunks sent so far. */
  get chunks(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => typeof d !== 'string');
  }

  messagesOf(t: string): Array<Record<string, unknown>> {
    return this.messages.filter((m) => m.t === t);
  }
}

/** Wires two fake channels together. Items travel one per macrotask; pause() models a stalled network. */
export function linkChannels(a: FakeChannel, b: FakeChannel): { pause(): void; resume(): void } {
  interface Item {
    data: string | ArrayBuffer;
    from: FakeChannel;
    to: FakeChannel;
  }
  const queue: Item[] = [];
  let paused = false;
  let scheduled = false;

  const schedule = () => {
    if (scheduled || paused || queue.length === 0) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const item = queue.shift();
      if (item) {
        if (item.to.readyState === 'open') item.to.emitMessage(item.data);
        item.from.drain(byteLength(item.data));
      }
      schedule();
    }, 0);
  };

  a.onSend = (data) => {
    queue.push({ data, from: a, to: b });
    schedule();
  };
  b.onSend = (data) => {
    queue.push({ data, from: b, to: a });
    schedule();
  };
  a.onClose = () => setTimeout(() => b.close(), 0);
  b.onClose = () => setTimeout(() => a.close(), 0);

  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      schedule();
    },
  };
}

/** Records every FileSink call; `gate` lets tests hold writes open. */
export class FakeSink implements FileSink {
  readonly kind = 'memory';
  readonly written: ArrayBuffer[] = [];
  closed = 0;
  aborted = 0;
  failOnWrite = false;
  gate: Promise<void> | undefined;

  async write(chunk: ArrayBuffer): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failOnWrite) throw new Error('disk full');
    this.written.push(chunk);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  async abort(): Promise<void> {
    this.aborted += 1;
  }

  get bytes(): Uint8Array {
    const out = new Uint8Array(this.written.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of this.written) {
      out.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export function flush(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic pseudo-random bytes so file content mix-ups are detectable. */
export function makeFile(size: number, name = 'sample.bin'): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >> 8) * 17 + 7) & 0xff;
  return new File([bytes], name, { type: 'application/octet-stream' });
}
