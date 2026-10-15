import type { FileEntry } from '../../shared/transfer';

/** The slice of RTCDataChannel the transfer code relies on (lets tests use a fake). */
export interface ChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer): void;
  addEventListener(type: 'message' | 'bufferedamountlow' | 'close' | 'error', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'bufferedamountlow' | 'close' | 'error', listener: (event: Event) => void): void;
}

/** A File (or Blob with a name) the sender streams out in slices. */
export interface FileSource {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** The same files sent back to back, for a receiver who wants them one by one instead of the zip. */
export interface SeparateSource {
  entries: FileEntry[];
  /** All the files joined end to end; `entries` tell where one stops and the next begins. */
  source: FileSource;
}

export function trySend(channel: ChannelLike, data: string | ArrayBuffer): boolean {
  try {
    channel.send(data);
    return true;
  } catch {
    return false;
  }
}
