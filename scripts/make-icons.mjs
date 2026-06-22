/**
 * @file scripts/make-icons.mjs
 * Generate CrossTab's PWA icons (no dependencies — a tiny hand-rolled PNG encoder
 * over Node's zlib). Produces maskable, full-bleed icons with a 2×2 "crosstab"
 * grid mark on the brand bar colour, at the sizes the manifest + iOS need:
 *   vendor/icon-192.png, vendor/icon-512.png  (web app manifest)
 *   vendor/icon-180.png                         (apple-touch-icon)
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');

const BG = [44, 62, 80]; // #2c3e50 brand bar
const LINE = [236, 240, 241]; // #ecf0f1
const HEADER = [41, 128, 185]; // #2980b9 — column headers (top row)
const HEADER2 = [52, 152, 219]; // #3498db — row headers (left column)
const CORNER = [31, 99, 145]; // #1f6391 — the header corner cell

// --- CRC32 (PNG chunk checksums) ------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encode an RGBA pixel buffer (w*h*4) as a PNG (colour type 6, 8-bit). */
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const px = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  const rect = (x0, y0, ww, hh, color) => {
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) px(x, y, color);
  };

  rect(0, 0, size, size, BG); // full-bleed background (maskable-safe)

  // A 3×3 cross-tabulation centred in the maskable safe zone (~64%): coloured
  // header row + header column (the margins that define a crosstab), plain body.
  const g0 = Math.round(size * 0.18);
  const g1 = Math.round(size * 0.82);
  const side = g1 - g0;
  const cw = side / 3; // cell size
  const c = (i) => Math.round(g0 + i * cw);
  const t = Math.max(2, Math.round(size * 0.03)); // grid line thickness

  // Header margins: top row, left column, and the darker corner where they meet.
  rect(g0, g0, side, c(1) - g0, HEADER); // top row (column headers)
  rect(g0, g0, c(1) - g0, side, HEADER2); // left column (row headers)
  rect(g0, g0, c(1) - g0, c(1) - g0, CORNER); // corner cell

  // Grid lines (4 verticals + 4 horizontals → a 3×3 table), clamped to the box.
  for (let i = 0; i <= 3; i++) {
    const p = c(i);
    rect(Math.min(p, g1 - t), g0, t, side, LINE); // vertical
    rect(g0, Math.min(p, g1 - t), side, t, LINE); // horizontal
  }

  return encodePNG(rgba, size, size);
}

mkdirSync(VENDOR, { recursive: true });
for (const size of [192, 512, 180]) {
  const file = join(VENDOR, `icon-${size}.png`);
  writeFileSync(file, makeIcon(size));
  console.log(`wrote vendor/icon-${size}.png`);
}
console.log('done.');
