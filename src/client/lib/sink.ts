import { canReceiveInMemory, type FileMeta } from '../../shared/transfer';
import { sanitizeFileName } from './format';

/** Where received bytes go. Writes are issued strictly one after another. */
export interface FileSink {
  readonly kind: 'file-system' | 'memory';
  write(chunk: ArrayBuffer): Promise<void>;
  /** Commits the file. Only called after every byte was written. */
  close(): Promise<void>;
  /** Discards partial data. Safe to call after a failure; never throws. */
  abort(): Promise<void>;
}

export interface WritableLike {
  write(chunk: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Streams to disk through a FileSystemWritableFileStream (File System Access API). */
export class FileSystemSink implements FileSink {
  readonly kind = 'file-system' as const;

  constructor(private readonly writable: WritableLike) {}

  write(chunk: ArrayBuffer): Promise<void> {
    return this.writable.write(chunk);
  }

  close(): Promise<void> {
    return this.writable.close();
  }

  async abort(): Promise<void> {
    try {
      await this.writable.abort();
    } catch {
      // the stream is already errored or closed; nothing left to discard
    }
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Keeps the whole file in memory and offers it as a normal browser download at the end. */
export class BlobSink implements FileSink {
  readonly kind = 'memory' as const;
  private chunks: ArrayBuffer[] | null = [];

  constructor(
    private readonly meta: FileMeta,
    private readonly save: (blob: Blob, fileName: string) => void = downloadBlob,
  ) {}

  async write(chunk: ArrayBuffer): Promise<void> {
    this.chunks?.push(chunk);
  }

  async close(): Promise<void> {
    if (!this.chunks) return;
    const blob = new Blob(this.chunks, { type: this.meta.mime });
    this.chunks = null;
    this.save(blob, sanitizeFileName(this.meta.name));
  }

  async abort(): Promise<void> {
    this.chunks = null;
  }
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    name: string;
    createWritable(): Promise<WritableLike>;
  }>;
}

export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function';
}

export type Receivable = { ok: true } | { ok: false; reason: 'too-large' };

/** Streaming to disk has no limit; the in-memory fallback stops at 500MB. */
export function checkReceivable(size: number, streamsToDisk: boolean): Receivable {
  return streamsToDisk || canReceiveInMemory(size) ? { ok: true } : { ok: false, reason: 'too-large' };
}

/**
 * Opens the save dialog. Must run inside the click handler (needs user activation).
 * Resolves undefined when the user dismisses the dialog.
 */
export async function pickFileSystemSink(
  fileName: string,
): Promise<{ sink: FileSystemSink; savedName: string } | undefined> {
  try {
    const handle = await (window as SaveFilePickerWindow).showSaveFilePicker!({
      suggestedName: sanitizeFileName(fileName),
    });
    return { sink: new FileSystemSink(await handle.createWritable()), savedName: handle.name };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    throw error;
  }
}
