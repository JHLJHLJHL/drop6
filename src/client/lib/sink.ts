import { canReceiveInMemory, type FileEntry, type FileMeta } from '../../shared/transfer';
import { numberedName, sanitizeFileName } from './format';
import { uniqueNames } from './zip';

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

/**
 * Receives several files sent end to end and hands each one to a sink of its own:
 * opened when its first byte arrives, closed as soon as its last byte is in
 * (empty files are created on the way). A failed transfer leaves the finished files
 * in place and discards only the one in progress.
 */
export class SplitSink implements FileSink {
  private readonly names: string[];
  private index = 0;
  private left: number;
  private current: FileSink | undefined;

  constructor(
    readonly kind: FileSink['kind'],
    private readonly entries: readonly FileEntry[],
    private readonly open: (name: string, size: number) => Promise<FileSink>,
  ) {
    // The names came from the sender: make them safe and different from each other again.
    this.names = uniqueNames(entries.map((entry) => sanitizeFileName(entry.name)));
    this.left = entries[0]?.size ?? 0;
  }

  private async openCurrent(): Promise<FileSink> {
    this.current ??= await this.open(this.names[this.index]!, this.entries[this.index]!.size);
    return this.current;
  }

  /** Closes the file that has all its bytes and moves on to the next one. */
  private async finishCurrent(): Promise<void> {
    const sink = await this.openCurrent();
    this.current = undefined;
    this.index += 1;
    this.left = this.entries[this.index]?.size ?? 0;
    await sink.close();
  }

  private async skipEmpty(): Promise<void> {
    while (this.index < this.entries.length && this.left === 0) await this.finishCurrent();
  }

  async write(chunk: ArrayBuffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      await this.skipEmpty();
      if (this.index >= this.entries.length) throw new Error('more bytes than announced');
      const take = Math.min(this.left, chunk.byteLength - offset);
      const sink = await this.openCurrent();
      await sink.write(take === chunk.byteLength ? chunk : chunk.slice(offset, offset + take));
      this.left -= take;
      offset += take;
      if (this.left === 0) await this.finishCurrent();
    }
  }

  async close(): Promise<void> {
    await this.skipEmpty();
    if (this.index < this.entries.length) throw new Error('fewer bytes than announced');
  }

  async abort(): Promise<void> {
    const sink = this.current;
    this.current = undefined;
    await sink?.abort();
  }
}

/** Each file becomes its own browser download once its last byte is in. */
export function memorySplitSink(entries: readonly FileEntry[]): SplitSink {
  return new SplitSink('memory', entries, async (name, size) => new BlobSink({ name, size, mime: '' }));
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string; startIn?: 'downloads' }) => Promise<{
    name: string;
    createWritable(): Promise<WritableLike>;
  }>;
}

export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function';
}

export type Receivable = { ok: true } | { ok: false; reason: 'too-large' };

/**
 * What a receiver can take: the zip (or the single file) as one piece, and/or the
 * files of a multi-file transfer one by one. Without streaming to disk every piece
 * has to fit in memory, so the files one by one only need the biggest file to fit.
 */
export function receiveOptions(meta: FileMeta, streamsToDisk: boolean): { zip: boolean; files: boolean } {
  return {
    zip: checkReceivable(meta.size, streamsToDisk).ok,
    files: meta.files !== undefined && meta.files.every((file) => checkReceivable(file.size, streamsToDisk).ok),
  };
}

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
      startIn: 'downloads',
    });
    return { sink: new FileSystemSink(await handle.createWritable()), savedName: handle.name };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    throw error;
  }
}

interface DirectoryHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{ createWritable(): Promise<WritableLike> }>;
}

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options: { mode: 'readwrite'; startIn?: 'downloads' }) => Promise<DirectoryHandleLike>;
}

/** The first of "name", "name (2)", ... that is not taken in `dir`: received files never overwrite what is already there. */
async function freeName(dir: DirectoryHandleLike, name: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : numberedName(name, n);
    try {
      await dir.getFileHandle(candidate); // found: taken
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return candidate;
      if (!(error instanceof DOMException && error.name === 'TypeMismatchError')) throw error; // a folder of that name: taken
    }
  }
}

/**
 * Opens the folder dialog; every file is then streamed into its own file in that folder.
 * Must run inside the click handler (needs user activation).
 * Resolves undefined when the user dismisses the dialog.
 */
export async function pickDirectorySink(
  entries: readonly FileEntry[],
): Promise<{ sink: SplitSink; savedName: string } | undefined> {
  try {
    const dir = await (window as DirectoryPickerWindow).showDirectoryPicker!({ mode: 'readwrite', startIn: 'downloads' });
    const sink = new SplitSink('file-system', entries, async (name) => {
      const handle = await dir.getFileHandle(await freeName(dir, name), { create: true });
      return new FileSystemSink(await handle.createWritable());
    });
    return { sink, savedName: dir.name };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    throw error;
  }
}
