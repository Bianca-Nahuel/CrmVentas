// QR de mentira para el proveedor falso: un PNG en blanco y negro con forma de QR (tres esquinas y un
// dibujo pseudoaleatorio fijo). No se puede escanear y no codifica nada. Se arma con node:zlib, sin
// dependencias.
import { crc32, deflateSync } from 'node:zlib';

const MODULES = 29;
const SCALE = 8;
const MARGIN = 4;

function isFinder(x: number, y: number): boolean {
  for (const [ox, oy] of [
    [0, 0],
    [MODULES - 7, 0],
    [0, MODULES - 7],
  ] as const) {
    const dx = x - ox;
    const dy = y - oy;
    if (dx < 0 || dy < 0 || dx > 6 || dy > 6) continue;
    const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    return ring !== 2;
  }
  return false;
}

function inFinderZone(x: number, y: number): boolean {
  const near = (v: number, o: number) => v >= o - 1 && v <= o + 7;
  return (
    (near(x, 0) && near(y, 0)) || (near(x, MODULES - 7) && near(y, 0)) || (near(x, 0) && near(y, MODULES - 7))
  );
}

function dark(x: number, y: number): boolean {
  if (inFinderZone(x, y)) return isFinder(x, y);
  return (x * 7 + y * 13 + x * y * 3) % 5 < 2;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function buildPng(): string {
  const size = (MODULES + MARGIN * 2) * SCALE;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(size + 1, 255);
    row[0] = 0; // filtro "none"
    const y = Math.floor(py / SCALE) - MARGIN;
    for (let px = 0; px < size; px++) {
      const x = Math.floor(px / SCALE) - MARGIN;
      if (x >= 0 && y >= 0 && x < MODULES && y < MODULES && dark(x, y)) row[px + 1] = 0;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = 0; // escala de grises
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

export const FAKE_QR_IMAGE = buildPng();
