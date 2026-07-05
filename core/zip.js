/**
 * @file zip.js
 * A tiny, dependency-free ZIP reader/writer — just enough for the open
 * `.crosstab` project bundle ({@link ./project-bundle.js}). Entries are STORED
 * (no compression): the bulk of a bundle is Parquet, which is already compressed,
 * and "store" keeps the writer trivial and the archive maximally compatible
 * (any unzip tool, `import zipfile` in Python, etc.).
 *
 * v1 limits (fine for typical projects; revisit for the multi-GB case): builds the
 * archive in memory as a Blob, and uses 32-bit sizes/offsets (no ZIP64), so a
 * single entry or archive >4 GB is out of scope here — that needs streamed,
 * ZIP64-aware writing.
 */

/** CRC-32 (IEEE) table + helper — ZIP per-entry checksum. */
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

const enc = new TextEncoder();
const dec = new TextDecoder();
const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const bytes = (d) => (d instanceof Uint8Array ? d : enc.encode(String(d)));

/**
 * Build a ZIP Blob from entries (STORE method).
 * @param {Array<{name: string, data: Uint8Array|string}>} entries
 * @returns {Blob}
 */
export function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = bytes(e.data);
    const crc = crc32(data);
    const lfh = concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    );
    parts.push(lfh, data);
    central.push({ name, crc, size: data.length, offset });
    offset += lfh.length + data.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const cdh = concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size),
      u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset), c.name,
    );
    parts.push(cdh);
    offset += cdh.length;
  }
  const eocd = concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(offset - cdStart), u32(cdStart), u16(0),
  );
  parts.push(eocd);
  return new Blob(parts, { type: 'application/zip' });
}

/**
 * Parse a STORED ZIP into entries. Walks the central directory (robust to extra
 * fields). Throws on a deflated entry (we never write those).
 * @param {Uint8Array} buf
 * @returns {Array<{name: string, data: Uint8Array}>}
 */
export function readZip(buf) {
  // Find the end-of-central-directory record (scan back over its 22-byte min).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (rd32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP (no end-of-central-directory).');
  const count = rd16(buf, eocd + 10);
  let p = rd32(buf, eocd + 16); // central directory offset
  const out = [];
  for (let n = 0; n < count; n++) {
    if (rd32(buf, p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = rd16(buf, p + 10);
    const compSize = rd32(buf, p + 20);
    const nameLen = rd16(buf, p + 28);
    const extraLen = rd16(buf, p + 30);
    const commentLen = rd16(buf, p + 32);
    const lhOff = rd32(buf, p + 42);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // Local header: data starts after its name+extra.
    const lhNameLen = rd16(buf, lhOff + 26);
    const lhExtraLen = rd16(buf, lhOff + 28);
    const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
    if (method !== 0) throw new Error(`ZIP entry "${name}" is compressed; only STORE is supported.`);
    out.push({ name, data: buf.subarray(dataStart, dataStart + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Parse a ZIP into entries, supporting BOTH stored (method 0) and DEFLATE
 * (method 8) — unlike {@link readZip}, which is STORE-only for our own bundles.
 * DEFLATE is inflated with the browser-native `DecompressionStream('deflate-raw')`
 * (no dependency; iOS Safari 16.4+). Used to unwrap a downloaded/picked `.zip` that
 * contains a data file (real-world archives are almost always deflated). Directory
 * entries (names ending in `/`) are returned too; callers filter them out.
 *
 * @param {Uint8Array} buf - The whole archive.
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
export async function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (rd32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP (no end-of-central-directory).');
  const count = rd16(buf, eocd + 10);
  let p = rd32(buf, eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (rd32(buf, p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = rd16(buf, p + 10);
    const compSize = rd32(buf, p + 20);
    const nameLen = rd16(buf, p + 28);
    const extraLen = rd16(buf, p + 30);
    const commentLen = rd16(buf, p + 32);
    const lhOff = rd32(buf, p + 42);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lhNameLen = rd16(buf, lhOff + 26);
    const lhExtraLen = rd16(buf, lhOff + 28);
    const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`ZIP entry "${name}" uses an unsupported compression method (${method}).`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Inflate a raw DEFLATE stream via the browser's DecompressionStream. */
async function inflateRaw(raw) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser can’t decompress ZIP entries (no DecompressionStream).');
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
