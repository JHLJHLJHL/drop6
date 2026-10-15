import type { FileSource } from './channel';
import { buildZip } from './zip';

export interface PreparedSource {
  /** What gets sent: the file itself, or one zip holding all the files. */
  source: FileSource;
  fileCount: number;
}

export function zipName(count: number): string {
  return `DROP6 파일 ${count}개.zip`;
}

/** One file goes out untouched; several files are bundled into a single zip. */
export async function prepareSource(
  files: readonly File[],
  onProgress?: (done: number, total: number) => void,
): Promise<PreparedSource> {
  if (files.length === 1) return { source: files[0]!, fileCount: 1 };
  const blob = await buildZip(files, onProgress);
  return {
    source: {
      name: zipName(files.length),
      size: blob.size,
      type: 'application/zip',
      slice: (start, end) => blob.slice(start, end),
    },
    fileCount: files.length,
  };
}
