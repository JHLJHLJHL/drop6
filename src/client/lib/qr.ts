import qrcode from 'qrcode-generator';

/** White margin around the modules, in modules. The QR standard asks for at least 4. */
export const QUIET_ZONE = 4;

/**
 * Dark/light modules of a QR code for `text`. Error correction L: the code is shown on a screen
 * (no print damage), so fewer, bigger modules scan more easily than a denser, sturdier one.
 */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => qr.isDark(row, col)));
}

/** One SVG path for all dark modules, as horizontal runs (`M x y h n v1 h-n z`), shifted by the quiet zone. */
export function qrPath(matrix: boolean[][]): string {
  const runs: string[] = [];
  matrix.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      let end = c;
      while (end < row.length && row[end]) end += 1;
      runs.push(`M${c + QUIET_ZONE} ${r + QUIET_ZONE}h${end - c}v1h-${end - c}z`);
      c = end;
    }
  });
  return runs.join('');
}
