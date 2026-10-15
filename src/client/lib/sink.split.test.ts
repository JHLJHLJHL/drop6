// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BLOB_BYTES } from '../../shared/transfer';
import { SplitSink, memorySplitSink, pickDirectorySink, receiveOptions } from './sink';
import { FakeSink } from './testFakes';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe('SplitSink (several files sent end to end)', () => {
  function setup(sizes: number[], names = sizes.map((_, i) => `f${i}.bin`)) {
    const opened: Array<{ name: string; size: number; sink: FakeSink }> = [];
    const sink = new SplitSink(
      'memory',
      sizes.map((size, i) => ({ name: names[i]!, size })),
      async (name, size) => {
        const fake = new FakeSink();
        opened.push({ name, size, sink: fake });
        return fake;
      },
    );
    return { sink, opened };
  }

  it('cuts the incoming bytes at the file boundaries, even in the middle of a chunk', async () => {
    const { sink, opened } = setup([3, 2, 4]);
    await sink.write(bytes(1, 2));
    await sink.write(bytes(3, 4, 5, 6, 7)); // ends file 0, all of file 1, starts file 2
    await sink.write(bytes(8, 9));
    await sink.close();
    expect(opened.map((f) => f.name)).toEqual(['f0.bin', 'f1.bin', 'f2.bin']);
    expect(opened.map((f) => [...f.sink.bytes])).toEqual([[1, 2, 3], [4, 5], [6, 7, 8, 9]]);
    expect(opened.map((f) => f.sink.closed)).toEqual([1, 1, 1]);
  });

  it('closes a file as soon as its last byte is in, not at the very end', async () => {
    const { sink, opened } = setup([2, 2]);
    await sink.write(bytes(1, 2, 3));
    expect(opened[0]!.sink.closed).toBe(1);
    expect(opened[1]!.sink.closed).toBe(0);
  });

  it('creates empty files wherever they are, including first and last', async () => {
    const { sink, opened } = setup([0, 2, 0, 1, 0]);
    await sink.write(bytes(1, 2, 3));
    await sink.close();
    expect(opened.map((f) => f.name)).toEqual(['f0.bin', 'f1.bin', 'f2.bin', 'f3.bin', 'f4.bin']);
    expect(opened.map((f) => f.sink.bytes.length)).toEqual([0, 2, 0, 1, 0]);
    expect(opened.every((f) => f.sink.closed === 1)).toBe(true);
  });

  it('makes names safe and different from each other, because the sender chose them', async () => {
    const { sink, opened } = setup([1, 1, 1], ['../a.txt', 'B.txt', 'b.txt']);
    await sink.write(bytes(1, 2, 3));
    expect(opened.map((f) => f.name)).toEqual(['.._a.txt', 'B.txt', 'b (2).txt']);
  });

  it('refuses more bytes than the files add up to', async () => {
    const { sink } = setup([2]);
    await expect(sink.write(bytes(1, 2, 3))).rejects.toThrow(/more bytes/);
  });

  it('refuses to close before every file got its bytes', async () => {
    const { sink } = setup([2, 2]);
    await sink.write(bytes(1, 2, 3));
    await expect(sink.close()).rejects.toThrow(/fewer bytes/);
  });

  it('abort discards only the file in progress and keeps the finished ones', async () => {
    const { sink, opened } = setup([2, 4]);
    await sink.write(bytes(1, 2, 3));
    await sink.abort();
    expect(opened[0]!.sink).toMatchObject({ closed: 1, aborted: 0 });
    expect(opened[1]!.sink).toMatchObject({ closed: 0, aborted: 1 });
  });

  it('abort before any byte arrived does nothing', async () => {
    const { sink, opened } = setup([2]);
    await sink.abort();
    expect(opened).toHaveLength(0);
  });
});

describe('memorySplitSink', () => {
  it('turns every file into its own download', async () => {
    const blobs = new Map<string, Blob>();
    const downloads: Array<{ name: string; href: string }> = [];
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = `blob:fake/${blobs.size}`;
      blobs.set(url, blob as Blob);
      return url;
    };
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, href: this.href });
    };
    try {
      const sink = memorySplitSink([
        { name: 'a.txt', size: 2 },
        { name: 'b.txt', size: 1 },
      ]);
      await sink.write(bytes(1, 2, 3));
      await sink.close();
    } finally {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    }

    const saved = await Promise.all(
      downloads.map(async (d) => ({ name: d.name, bytes: [...new Uint8Array(await blobs.get(d.href)!.arrayBuffer())] })),
    );
    expect(saved).toEqual([
      { name: 'a.txt', bytes: [1, 2] },
      { name: 'b.txt', bytes: [3] },
    ]);
  });
});

describe('receiveOptions', () => {
  const meta = (size: number, files?: number[]) => ({
    name: 'bundle.zip',
    size,
    mime: 'application/zip',
    files: files?.map((fileSize, i) => ({ name: `f${i}`, size: fileSize })),
  });

  it('offers the zip only, for a transfer of one file', () => {
    expect(receiveOptions(meta(100), true)).toEqual({ zip: true, files: false });
  });

  it('offers both when streaming to disk, however big', () => {
    expect(receiveOptions(meta(50 * 1024 ** 3, [30 * 1024 ** 3, 20 * 1024 ** 3]), true)).toEqual({ zip: true, files: true });
  });

  it('in memory, the zip must fit as a whole but the files only one at a time', () => {
    const half = MAX_BLOB_BYTES / 2 + 1;
    expect(receiveOptions(meta(half * 2 + 100, [half, half]), false)).toEqual({ zip: false, files: true });
  });

  it('in memory, one file over the limit rules out the files too', () => {
    expect(receiveOptions(meta(MAX_BLOB_BYTES * 2, [MAX_BLOB_BYTES + 1, 10]), false)).toEqual({ zip: false, files: false });
  });
});

describe('pickDirectorySink', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });

  /** A folder holding `existing` files; remembers what was created and written. */
  function fakeFolder(existing: string[] = []) {
    const files = new Map<string, number[]>(existing.map((name) => [name, [0]]));
    const closed: string[] = [];
    const dir = {
      name: 'My Folder',
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!files.has(name)) {
          if (!options?.create) throw new DOMException('no such file', 'NotFoundError');
          files.set(name, []);
        }
        return {
          createWritable: async () => ({
            write: async (chunk: ArrayBuffer) => void files.get(name)!.push(...new Uint8Array(chunk)),
            close: async () => void closed.push(name),
            abort: async () => {},
          }),
        };
      },
    };
    const picker = vi.fn(async () => dir);
    (window as unknown as Record<string, unknown>).showDirectoryPicker = picker;
    return { files, closed, picker };
  }

  it('asks for a writable folder starting in downloads, then writes each file into it', async () => {
    const folder = fakeFolder();
    const picked = await pickDirectorySink([
      { name: 'a.txt', size: 2 },
      { name: 'b.txt', size: 1 },
    ]);
    expect(folder.picker).toHaveBeenCalledWith({ mode: 'readwrite', startIn: 'downloads' });
    expect(picked?.savedName).toBe('My Folder');
    await picked!.sink.write(bytes(1, 2, 3));
    await picked!.sink.close();
    expect(Object.fromEntries(folder.files)).toEqual({ 'a.txt': [1, 2], 'b.txt': [3] });
    expect(folder.closed).toEqual(['a.txt', 'b.txt']);
  });

  it('never overwrites a file that is already in the folder', async () => {
    const folder = fakeFolder(['a.txt', 'a (2).txt']);
    const picked = await pickDirectorySink([
      { name: 'a.txt', size: 1 },
      { name: 'c.txt', size: 0 },
    ]);
    await picked!.sink.write(bytes(9));
    await picked!.sink.close();
    expect(folder.files.get('a.txt')).toEqual([0]);
    expect(folder.files.get('a (3).txt')).toEqual([9]);
    expect(folder.files.has('c.txt')).toBe(true);
  });

  it('resolves undefined when the user dismisses the dialog', async () => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
      throw new DOMException('dismissed', 'AbortError');
    };
    await expect(pickDirectorySink([{ name: 'a', size: 1 }])).resolves.toBeUndefined();
  });

  it('rethrows other failures so the session can report a storage problem', async () => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    await expect(pickDirectorySink([{ name: 'a', size: 1 }])).rejects.toThrow('blocked');
  });
});
