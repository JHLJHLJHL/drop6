import { QUIET_ZONE } from './qr';

/** Test helpers: draw a module matrix the way a screen would, and read an SVG path back into a matrix. */

export function rasterizeMatrix(matrix: boolean[][], scale = 6): { data: Uint8ClampedArray; width: number } {
  const size = matrix.length + QUIET_ZONE * 2;
  const width = size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const i = (((r + QUIET_ZONE) * scale + y) * width + (c + QUIET_ZONE) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }),
  );
  return { data, width };
}

/** The dark modules an SVG path of horizontal runs (`M x y h n v1 h-n z`) describes. */
export function matrixFromPath(path: string, moduleCount: number): boolean[][] {
  const matrix = Array.from({ length: moduleCount }, () => Array<boolean>(moduleCount).fill(false));
  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let i = 0; i < Number(run); i += 1) matrix[Number(y) - QUIET_ZONE]![Number(x) - QUIET_ZONE + i] = true;
  }
  return matrix;
}
