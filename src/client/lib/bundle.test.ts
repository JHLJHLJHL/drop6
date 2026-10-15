import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { prepareSource, zipName } from './bundle';

const file = (name: string, content: string) =>
  new File([content], name, { type: 'text/plain', lastModified: 1_700_000_000_000 });

describe('zipName', () => {
  it('says how many files are inside', () => {
    expect(zipName(3)).toBe('DROP6 파일 3개.zip');
  });
});

describe('prepareSource', () => {
  it('sends a single file as it is, without zipping', async () => {
    const one = file('only.txt', 'just me');
    const prepared = await prepareSource([one]);
    expect(prepared.source).toBe(one);
    expect(prepared.fileCount).toBe(1);
  });

  it('bundles several files into one zip with a name, type and size of its own', async () => {
    const prepared = await prepareSource([file('a.txt', 'AAA'), file('b.txt', 'BBBB'), file('c.txt', '')]);
    expect(prepared.fileCount).toBe(3);
    expect(prepared.source.name).toBe('DROP6 파일 3개.zip');
    expect(prepared.source.type).toBe('application/zip');

    // the sender reads it slice by slice, exactly like a File
    const whole = new Uint8Array(await prepared.source.slice(0, prepared.source.size).arrayBuffer());
    expect(whole).toHaveLength(prepared.source.size);
    const entries = unzipSync(whole);
    expect(Object.keys(entries)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(new TextDecoder().decode(entries['b.txt'])).toBe('BBBB');
  });

  it('keeps a single file free of any file list', async () => {
    expect((await prepareSource([file('only.txt', 'x')])).separate).toBeUndefined();
  });

  it('also offers the files back to back, listed in order with the names the zip uses', async () => {
    const prepared = await prepareSource([file('a.txt', 'AAA'), file('a.txt', 'BB'), file('../c.txt', '')]);
    expect(prepared.separate?.entries).toEqual([
      { name: 'a.txt', size: 3 },
      { name: 'a (2).txt', size: 2 },
      { name: '.._c.txt', size: 0 },
    ]);
    const joined = prepared.separate!.source;
    expect(joined.size).toBe(5);
    expect(new TextDecoder().decode(await joined.slice(0, joined.size).arrayBuffer())).toBe('AAABB');
    expect(new TextDecoder().decode(await joined.slice(2, 4).arrayBuffer())).toBe('AB');
  });

  it('passes progress through while zipping', async () => {
    const seen: number[] = [];
    await prepareSource([file('1', 'a'), file('2', 'b')], (done) => seen.push(done));
    expect(seen).toEqual([1, 2]);
  });
});
