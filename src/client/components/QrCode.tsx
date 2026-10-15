import { useMemo } from 'react';
import { QUIET_ZONE, qrMatrix, qrPath } from '../lib/qr';

/** A square QR code drawn as one SVG path (crisp at any size, black on white with the standard margin). */
export function QrCode({ value }: { value: string }) {
  const { path, size } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { path: qrPath(matrix), size: matrix.length + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg
      className="qr"
      role="img"
      aria-label="QR 코드. 휴대폰 카메라로 찍으면 받기 화면이 코드가 입력된 채 열려요"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
