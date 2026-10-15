import type { FileSource, SeparateSource } from './channel';
import { buildZip, entryNames } from './zip';

export interface PreparedSource {
  /** What gets sent: the file itself, or one zip holding all the files. */
  source: FileSource;
  fileCount: number;
  /** Only with several files. */
  separate?: SeparateSource;
}

export function zipName(count: number): string {
  return `DROP6 파일 ${count}개.zip`;
}

/** One file goes out untouched; several files are bundled into a single zip (and offered one by one too). */
export async function prepareSource(
  files: readonly File[],
  onProgress?: (done: number, total: number) => void,
): Promise<PreparedSource> {
  if (files.length === 1) return { source: files[0]!, fileCount: 1 };
  const blob = await buildZip(files, onProgress);
  const joined = new Blob([...files]);
  const names = entryNames(files);
  return {
    source: {
      name: zipName(files.length),
      size: blob.size,
      type: 'application/zip',
      slice: (start, end) => blob.slice(start, end),
    },
    fileCount: files.length,
    separate: {
      entries: files.map((file, i) => ({ name: names[i]!, size: file.size })),
      source: {
        name: zipName(files.length),
        size: joined.size,
        type: 'application/octet-stream',
        slice: (start, end) => joined.slice(start, end),
      },
    },
  };
}
