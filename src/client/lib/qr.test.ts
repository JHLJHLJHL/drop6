import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath } from './qr';
import { matrixFromPath, rasterizeMatrix } from './qrTestUtils';

const decode = (matrix: boolean[][]) => {
  const { data, width } = rasterizeMatrix(matrix);
  return jsQR(data, width, width)?.data;
};

describe('qrMatrix', () => {
  it('makes a square matrix that a QR decoder reads back to the same text', () => {
    for (const text of [
      'https://drop6.onrender.com/receive#code=163960',
      'http://127.0.0.1:4173/receive#code=004200',
      'https://my-long-custom-domain.example.com/receive#code=999999',
    ]) {
      const matrix = qrMatrix(text);
      expect(matrix.length).toBeGreaterThanOrEqual(21);
      expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
      expect(decode(matrix), text).toBe(text);
    }
  });

  it('is deterministic', () => {
    expect(qrMatrix('abc')).toEqual(qrMatrix('abc'));
  });
});

describe('qrPath', () => {
  it('describes exactly the dark modules, offset by the quiet zone', () => {
    const matrix = qrMatrix('https://drop6.onrender.com/receive#code=163960');
    expect(matrixFromPath(qrPath(matrix), matrix.length)).toEqual(matrix);
  });

  it('decodes after being drawn from the path alone', () => {
    const text = 'https://drop6.onrender.com/receive#code=482913';
    const matrix = qrMatrix(text);
    expect(decode(matrixFromPath(qrPath(matrix), matrix.length))).toBe(text);
  });

  it('merges runs of dark modules, so the path stays small', () => {
    const matrix = qrMatrix('https://drop6.onrender.com/receive#code=163960');
    const dark = matrix.flat().filter(Boolean).length;
    const runs = (qrPath(matrix).match(/M/g) ?? []).length;
    expect(runs).toBeLessThan(dark);
  });
});
