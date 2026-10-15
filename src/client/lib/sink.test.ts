import { describe, expect, it } from 'vitest';
import { MAX_BLOB_BYTES } from '../../shared/transfer';
import { BlobSink, FileSystemSink, checkReceivable } from './sink';

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe('BlobSink (memory fallback)', () => {
  it('hands the concatenated chunks to the saver on close', async () => {
    const saved: Array<{ blob: Blob; name: string }> = [];
    const sink = new BlobSink({ name: 'a.txt', size: 4, mime: 'text/plain' }, (blob, name) => saved.push({ blob, name }));
    await sink.write(bytes(1, 2));
    await sink.write(bytes(3, 4));
    expect(saved).toHaveLength(0);
    await sink.close();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe('a.txt');
    expect(saved[0]!.blob.type).toBe('text/plain');
    expect(new Uint8Array(await saved[0]!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('sanitizes the download file name', async () => {
    const saved: string[] = [];
    const sink = new BlobSink({ name: '../evil.txt', size: 0, mime: '' }, (_blob, name) => saved.push(name));
    await sink.close();
    expect(saved).toEqual(['.._evil.txt']);
  });

  it('never saves anything after abort', async () => {
    const saved: unknown[] = [];
    const sink = new BlobSink({ name: 'a.txt', size: 2, mime: '' }, (blob) => saved.push(blob));
    await sink.write(bytes(1, 2));
    await sink.abort();
    await sink.close();
    expect(saved).toHaveLength(0);
  });
});

describe('FileSystemSink', () => {
  function fakeWritable() {
    const calls: string[] = [];
    return {
      calls,
      writable: {
        write: async (chunk: ArrayBuffer) => void calls.push(`write:${chunk.byteLength}`),
        close: async () => void calls.push('close'),
        abort: async () => void calls.push('abort'),
      },
    };
  }

  it('streams writes straight to the file and closes it once', async () => {
    const { calls, writable } = fakeWritable();
    const sink = new FileSystemSink(writable);
    await sink.write(bytes(1, 2, 3));
    await sink.write(bytes(4));
    await sink.close();
    expect(calls).toEqual(['write:3', 'write:1', 'close']);
  });

  it('aborts the stream so no partial file is committed', async () => {
    const { calls, writable } = fakeWritable();
    const sink = new FileSystemSink(writable);
    await sink.write(bytes(1));
    await sink.abort();
    expect(calls).toEqual(['write:1', 'abort']);
  });

  it('swallows errors from abort (already broken streams)', async () => {
    const sink = new FileSystemSink({
      write: async () => {},
      close: async () => {},
      abort: async () => {
        throw new Error('stream errored');
      },
    });
    await expect(sink.abort()).resolves.toBeUndefined();
  });
});

describe('checkReceivable (500MB memory fallback boundary)', () => {
  it('allows exactly 500MB in memory and refuses one byte more', () => {
    expect(checkReceivable(MAX_BLOB_BYTES, false)).toEqual({ ok: true });
    expect(checkReceivable(MAX_BLOB_BYTES + 1, false)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('has no size limit when the File System Access API streams to disk', () => {
    expect(checkReceivable(50 * 1024 ** 3, true)).toEqual({ ok: true });
  });
});
