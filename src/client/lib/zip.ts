import { sanitizeFileName } from './format';

/** Several files are bundled into one classic (non-ZIP64) zip, so these are hard limits. */
export const MAX_ZIP_FILES = 1000;
export const MAX_ZIP_BYTES = 0xffffffff;

export class ZipLimitError extends Error {
  constructor(readonly reason: 'too-many' | 'too-large') {
    super(`zip limit exceeded: ${reason}`);
    this.name = 'ZipLimitError';
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (zip/PNG polynomial). Pass the previous result as `crc` to continue across chunks. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function crc32OfFile(file: File): Promise<number> {
  if (typeof file.stream !== 'function') return crc32(new Uint8Array(await file.arrayBuffer()));
  const reader = file.stream().getReader();
  let crc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
  }
}

/** Renames repeats as "name (2).ext". Compared case-insensitively because Windows extracts that way. */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    if (used.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${base} (${n})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = d.getFullYear();
  if (!Number.isFinite(ms) || year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Bundles files into one stored (uncompressed) zip without reading them into memory:
 * the result is a Blob that points at the original files, so any slice can be read later
 * (each receiver reads at its own pace). Only a CRC-32 pass over each file happens up front.
 */
export async function buildZip(files: readonly File[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  if (files.length > MAX_ZIP_FILES) throw new ZipLimitError('too-many');

  const encoder = new TextEncoder();
  const names = uniqueNames(files.map((file) => sanitizeFileName(file.name))).map((name) => encoder.encode(name));
  const total = files.reduce((sum, file, i) => sum + 30 + file.size + 46 + 2 * names[i]!.length, 22);
  if (total > MAX_ZIP_BYTES) throw new ZipLimitError('too-large');

  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const [i, file] of files.entries()) {
    const name = names[i]!;
    const crc = await crc32OfFile(file);
    onProgress?.(i + 1, files.length);
    const { time, date } = dosDateTime(file.lastModified);

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true); // version needed
    l.setUint16(6, 0x0800, true); // names are UTF-8
    l.setUint16(8, 0, true); // stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, file.size, true);
    l.setUint32(22, file.size, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); // version made by
    c.setUint16(6, 20, true); // version needed
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, file.size, true);
    c.setUint32(24, file.size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, file);
    central.push(entry);
    offset += local.length + file.size;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
