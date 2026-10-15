import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_ZIP_BYTES, MAX_ZIP_FILES, ZipLimitError, buildZip, crc32, uniqueNames } from './zip';

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (name: string, content: Uint8Array<ArrayBuffer> | string, lastModified = Date.UTC(2026, 9, 15, 12, 30, 20)) =>
  new File([typeof content === 'string' ? bytes(content) : content], name, { lastModified });
const readAll = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('can be continued across chunks', () => {
    const whole = crc32(bytes('hello world'));
    expect(crc32(bytes(' world'), crc32(bytes('hello')))).toBe(whole);
  });
});

describe('uniqueNames', () => {
  it('keeps distinct names and numbers repeated ones before the extension', () => {
    expect(uniqueNames(['a.txt', 'b.txt', 'a.txt', 'a.txt', 'noext', 'noext'])).toEqual([
      'a.txt',
      'b.txt',
      'a (2).txt',
      'a (3).txt',
      'noext',
      'noext (2)',
    ]);
  });
});

describe('buildZip', () => {
  it('produces an archive an independent reader opens, with exact names and bytes', async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31 + 7) & 0xff);
    const zip = await buildZip([
      file('hello.txt', 'hello zip'),
      file('붙임.2026학년도 보고서(울릉중).hwp', big),
      file('empty.bin', ''),
    ]);
    expect(zip.type).toBe('application/zip');

    const entries = unzipSync(await readAll(zip));
    expect(Object.keys(entries)).toEqual(['hello.txt', '붙임.2026학년도 보고서(울릉중).hwp', 'empty.bin']);
    expect(new TextDecoder().decode(entries['hello.txt'])).toBe('hello zip');
    expect(Buffer.from(entries['붙임.2026학년도 보고서(울릉중).hwp']!).equals(Buffer.from(big))).toBe(true);
    expect(entries['empty.bin']).toHaveLength(0);
  });

  it('stores without compression, so the size is exactly headers plus data', async () => {
    const files = [file('a.txt', 'aaaa'), file('한글.txt', 'bbbbbbbb')];
    const zip = await buildZip(files);
    const names = files.map((f) => new TextEncoder().encode(f.name).length);
    const data = files.reduce((n, f) => n + f.size, 0);
    const locals = names.reduce((n, len) => n + 30 + len, 0);
    const central = names.reduce((n, len) => n + 46 + len, 0);
    expect(zip.size).toBe(locals + data + central + 22);
  });

  it('flags names as UTF-8 and stores the CRC in the header', async () => {
    const zip = await buildZip([file('한글.txt', '123456789')]);
    const view = new DataView(await zip.arrayBuffer());
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800); // UTF-8 names
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint32(14, true)).toBe(0xcbf43926);
    expect(view.getUint32(18, true)).toBe(9);
    expect(view.getUint32(22, true)).toBe(9);
  });

  it('records the file modification time in DOS format', async () => {
    const modified = new Date(2026, 9, 15, 12, 30, 20); // local time, like the DOS fields
    const zip = await buildZip([file('t.txt', 'x', modified.getTime())]);
    const view = new DataView(await zip.arrayBuffer());
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect({ h: time >> 11, m: (time >> 5) & 63, s: (time & 31) * 2 }).toEqual({ h: 12, m: 30, s: 20 });
    expect({ y: (date >> 9) + 1980, mo: (date >> 5) & 15, d: date & 31 }).toEqual({ y: 2026, mo: 10, d: 15 });
  });

  it('keeps files with the same name apart', async () => {
    const zip = await buildZip([file('same.txt', 'one'), file('same.txt', 'two')]);
    const entries = unzipSync(await readAll(zip));
    expect(Object.keys(entries)).toEqual(['same.txt', 'same (2).txt']);
    expect(new TextDecoder().decode(entries['same (2).txt'])).toBe('two');
  });

  it('can be sliced anywhere, as the sender does chunk by chunk', async () => {
    const zip = await buildZip([file('a.txt', 'a'.repeat(1000)), file('b.txt', 'b'.repeat(1000))]);
    const whole = await readAll(zip);
    const parts: Uint8Array[] = [];
    for (let start = 0; start < zip.size; start += 777) parts.push(await readAll(zip.slice(start, start + 777)));
    expect(Buffer.concat(parts).equals(Buffer.from(whole))).toBe(true);
  });

  it('reports progress per file', async () => {
    const calls: Array<[number, number]> = [];
    await buildZip([file('1', 'a'), file('2', 'b'), file('3', 'c')], (done, total) => calls.push([done, total]));
    expect(calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it(`refuses more than ${MAX_ZIP_FILES} files before reading anything`, async () => {
    const many = Array.from({ length: MAX_ZIP_FILES + 1 }, (_, i) => file(`f${i}`, ''));
    await expect(buildZip(many)).rejects.toMatchObject({ name: 'ZipLimitError', reason: 'too-many' });
  });

  it('refuses archives that would not fit a classic (non-ZIP64) zip before reading anything', async () => {
    const huge = { name: 'huge.bin', size: MAX_ZIP_BYTES, lastModified: 0 } as unknown as File;
    const small = file('a.txt', 'x');
    const error = await buildZip([huge, small]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZipLimitError);
    expect((error as ZipLimitError).reason).toBe('too-large');
  });
});
