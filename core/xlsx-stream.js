/**
 * @file xlsx-stream.js
 * Reading an .xlsx without ever holding it.
 *
 * ## Why this exists
 *
 * `builtin-excel-codec` reads a workbook with SheetJS, which materialises every cell as
 * an object, and then builds an array-of-arrays from it and pivots THAT into columns —
 * bytes, workbook, AoA and columns all alive at once. Measured on a College Scorecard
 * year converted to .xlsx (3,379 x 6,272): 735 MiB at 500 rows, 1,322 at 1,000, 2,578 at
 * 2,000 — linear at ~1.23 MiB/row, so the real file needs about **7.6 GiB** against a
 * renderer cap near 4. One file fails, not five, and it fails in the JS heap before
 * DuckDB sees a row.
 *
 * SheetJS cannot stream a read, so the alternative was an asterisk on the format picker
 * saying "small files only". The owner declined it: *"Lack of parity isn't defensible for
 * me when we have a path to parity."*
 *
 * ## The shape of it
 *
 * An .xlsx is a zip. The compressed bytes are tens of megabytes and holding those is
 * fine; what cannot be held is the INFLATED sheet XML. So this streams one entry
 * through `DecompressionStream` and scans the XML as it arrives, emitting rows. No
 * new dependency — the browser already does the inflating.
 *
 * Two things are necessarily held whole, and both are bounded by something other than the
 * cell count: the **shared strings** table (bounded by DISTINCT strings — for data like
 * the Scorecard's, a few hundred), and the **style → number-format** map (bounded by
 * distinct formats). A workbook whose every cell is a unique long string is the case this
 * does not help, and it is a different file from the one that prompted it.
 *
 * ## What it is not
 *
 * Not a general XML parser. Spreadsheet XML is extremely regular, and a targeted scanner
 * is both smaller and faster than pulling in a SAX library. It handles what a data file
 * contains: numbers, shared and inline strings, booleans, formula results, dates (which
 * need the style table to recognise at all), and sparse rows.
 */

// --- the zip half ------------------------------------------------------------
//
// An .xlsx is a zip, so reading one starts with the archive. These two functions were
// `zip.js`'s until this module needed them, and they live here now for a structural
// reason rather than a tidiness one: the Excel codec runs in the plugin sandbox and
// receives this file through `app.codec.loadAsset`, which blob-imports it. A blob URL
// has no base to resolve `./zip.js` against, so an asset module must import NOTHING.
//
// `zip.js` keeps the whole-archive reader (`readZipEntries`) it already had; this is the
// streaming pair, and it has exactly one caller — the lines below.

const dec = new TextDecoder();
const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * The central directory, without inflating anything.
 *
 * Split out of {@link readZipEntries} so a caller can find ONE entry and stream it.
 * That is what the Excel reader needs: an .xlsx is a zip, and the whole problem with
 * reading one is that inflating a sheet gives hundreds of megabytes of XML. Listing the
 * directory costs nothing; it is the inflate that has to be paid by the chunk.
 *
 * @param {Uint8Array} buf - The whole archive.
 * @returns {Array<{name: string, method: number, raw: Uint8Array}>}
 */
export function zipDirectory(buf) {
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
    out.push({ name, method, raw: buf.subarray(dataStart, dataStart + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Inflate ONE zip entry as a stream of chunks, never holding the whole thing.
 *
 * The entry's compressed bytes are already in memory — an .xlsx is tens of megabytes and
 * that is not the problem. What cannot be held is the INFLATED sheet XML, which for a
 * 3,379-column year is hundreds of megabytes before anything has been parsed out of it.
 *
 * @param {{method: number, raw: Uint8Array}} entry - from {@link zipDirectory}
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* streamZipEntry(entry) {
  if (entry.method === 0) { yield entry.raw; return; } // stored: already plain
  if (entry.method !== 8) {
    throw new Error(`ZIP entry uses an unsupported compression method (${entry.method}).`);
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser can’t decompress ZIP entries (no DecompressionStream).');
  }
  const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length) yield value;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** Decode the five XML entities plus numeric escapes. */
function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(?:(amp|lt|gt|quot|apos)|#x([0-9a-fA-F]+)|#(\d+));/g, (m, name, hex, dec2) => {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
    return String.fromCodePoint(parseInt(hex || dec2, hex ? 16 : 10));
  });
}

/** One attribute off an element's attribute text. Cheaper than parsing them all when
 * three are wanted out of a dozen. */
function attr(text, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(text);
  return m ? m[1] : null;
}

/** `BC` → 54. The column letters in a cell reference like `BC12`. */
export function colFromRef(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break; // stop at the row digits
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Feed an entry's inflated bytes through a scanner that consumes whole elements.
 *
 * The buffer keeps whatever does not yet form a complete element, which is the only
 * subtlety in streaming XML: a tag, a row, or a multi-byte character can straddle a
 * chunk boundary. `TextDecoder` with `stream: true` handles the character case; `take`
 * returns the number of characters it consumed so the rest is carried forward.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {(buf: string, final: boolean) => number} take
 */
async function scanChunks(chunks, take) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    const used = take(buf, false);
    if (used > 0) buf = buf.slice(used);
  }
  buf += decoder.decode();
  take(buf, true);
}

/**
 * The shared-string table: `<si>` elements, each possibly several `<t>` runs (rich text
 * splits a single string across runs, and concatenating them is what Excel shows).
 *
 * @returns {Promise<string[]>}
 */
export async function readSharedStrings(entry) {
  const out = [];
  if (!entry) return out;
  await scanChunks(streamZipEntry(entry), (buf, final) => {
    let at = 0;
    for (;;) {
      const start = buf.indexOf('<si', at);
      if (start < 0) break;
      const close = buf.indexOf('</si>', start);
      if (close < 0) {
        // A self-closing `<si/>` is an empty string and has no `</si>`.
        const selfEnd = buf.indexOf('>', start);
        if (selfEnd > 0 && buf[selfEnd - 1] === '/') { out.push(''); at = selfEnd + 1; continue; }
        break; // incomplete — wait for more
      }
      const inner = buf.slice(start, close);
      let text = '';
      const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
      let m;
      while ((m = re.exec(inner))) text += m[1] ? unescapeXml(m[1]) : '';
      out.push(text);
      at = close + 5;
    }
    if (final) return buf.length;
    return at;
  });
  return out;
}

/** Built-in number-format ids that mean a date or a time. */
const DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Does a custom format code describe a date/time? Date tokens outside literal text. */
export function isDateFormatCode(code) {
  if (!code) return false;
  // Strip quoted literals, escaped characters, bracketed colours/conditions, and the
  // currency-ish parts — a literal "day" in a money format must not make it a date.
  const bare = String(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[yqdhms]/i.test(bare) && !/^[^a-zA-Z]*$/.test(bare);
}

/**
 * Which cell styles mean "this number is a date".
 *
 * Needed because an .xlsx stores a date as a plain number and ONLY the style says
 * otherwise. Without this a date column reads as 45292 and types numeric — silently
 * wrong in a way no error would show, and a change in meaning from what the current
 * reader produces.
 *
 * @returns {Promise<boolean[]>} indexed by the cell's `s` attribute
 */
export async function readDateStyles(entry) {
  if (!entry) return [];
  let xml = '';
  await scanChunks(streamZipEntry(entry), (buf, final) => {
    if (!final) return 0; // styles.xml is small; assemble it whole
    xml = buf;
    return buf.length;
  });

  const custom = new Map();
  const numFmts = /<numFmts\b[\s\S]*?<\/numFmts>/.exec(xml);
  if (numFmts) {
    const re = /<numFmt\b([^>]*)\/>/g;
    let m;
    while ((m = re.exec(numFmts[0]))) {
      const id = Number(attr(m[1], 'numFmtId'));
      const code = unescapeXml(attr(m[1], 'formatCode') ?? '');
      if (Number.isFinite(id)) custom.set(id, code);
    }
  }

  const out = [];
  const xfs = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(xml);
  if (!xfs) return out;
  const re = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let m;
  while ((m = re.exec(xfs[0]))) {
    const id = Number(attr(m[1], 'numFmtId') ?? '0');
    out.push(custom.has(id) ? isDateFormatCode(custom.get(id)) : DATE_FORMAT_IDS.has(id));
  }
  return out;
}

/** Excel's day-zero is 1899-12-30: the serial counts from 1900-01-01 as day 1 AND the
 * format keeps 1900's non-existent leap day, which cancels out to this epoch. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** An Excel serial as a Date, matching what SheetJS's `cellDates` produces so the
 * codec's existing stringification is unchanged. */
export function serialToDate(serial) {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial * 86400000));
}

/**
 * Stream one worksheet, calling `onRow(values, rowNumber)` per row.
 *
 * `values` is a sparse-filled array indexed by column: a row that writes A, C and ZZ
 * yields an array with holes rather than three entries, because the column a value is in
 * is the whole point. Missing/blank cells are `null`.
 *
 * @param {object} entry - the sheet's zip entry
 * @param {object} opts
 * @param {string[]} opts.sharedStrings
 * @param {boolean[]} opts.dateStyles
 * @param {(values: Array<any>, rowNumber: number) => void|Promise<void>} opts.onRow
 */
export async function streamSheetRows(entry, { sharedStrings = [], dateStyles = [], onRow }) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  /**
   * Parse whole `<row>` elements out of the buffer, delivering each one before looking
   * for the next.
   *
   * This does NOT collect rows and deliver them afterwards. The first version did, to
   * keep the scanner synchronous while `onRow` could be async — and it held every row of
   * the file, which is the exact thing this module exists to avoid. It measured 788 MiB
   * on a 2,000-row sheet and was caught only because the number was taken rather than
   * assumed.
   *
   * So the loop awaits `onRow` inline and keeps only what is left of the buffer: peak is
   * one inflate chunk plus one row.
   */
  const flush = async (final) => {
    for (;;) {
      const start = buf.indexOf('<row', 0);
      if (start < 0) {
        // Nothing pending; drop everything before a possible partial tag.
        if (!final) buf = buf.slice(Math.max(0, buf.length - 8));
        return;
      }
      const openEnd = buf.indexOf('>', start);
      if (openEnd < 0) { buf = buf.slice(start); return; } // tag split across chunks
      const selfClosing = buf[openEnd - 1] === '/';
      let end;
      if (selfClosing) end = openEnd + 1;
      else {
        const close = buf.indexOf('</row>', openEnd);
        if (close < 0) { buf = buf.slice(start); return; } // row split across chunks
        end = close + 6;
      }

      const rowNum = Number(attr(buf.slice(start, openEnd), 'r') ?? '0');
      const values = [];
      if (!selfClosing) {
        const inner = buf.slice(openEnd + 1, end - 6);
        const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let m;
        while ((m = re.exec(inner))) {
          const ref = attr(m[1], 'r');
          const col = ref ? colFromRef(ref) : values.length;
          values[col] = cellValue(m[1], m[2], sharedStrings, dateStyles);
        }
      }
      buf = buf.slice(end);
      await onRow(values, rowNum);
    }
  };

  for await (const chunk of streamZipEntry(entry)) {
    buf += decoder.decode(chunk, { stream: true });
    await flush(false);
  }
  buf += decoder.decode();
  await flush(true);
}

/** One cell's value, given its attributes and inner XML. */
function cellValue(a, body, sharedStrings, dateStyles) {
  if (body == null || body === '') return null;
  const t = attr(a, 't') ?? 'n';

  if (t === 'inlineStr') {
    let text = '';
    const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let m;
    while ((m = re.exec(body))) text += m[1] ? unescapeXml(m[1]) : '';
    return text === '' ? null : text;
  }

  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
  if (!v) return null;
  const raw = v[1];

  if (t === 's') {
    const i = Number(raw);
    return Number.isFinite(i) ? (sharedStrings[i] ?? null) : null;
  }
  // `str` is a formula's cached string result; `e` is an error value, which is text as
  // far as a data table is concerned.
  // An ISO date cell (OOXML's newer form, and what SheetJS writes). SheetJS round-trips
  // these through LOCAL time — it subtracts the offset on write and adds it back on
  // read, so a date written as midnight UTC is stored as 16:00 the previous day in
  // PST and comes back as midnight. Matched deliberately: the codec's current
  // behaviour IS SheetJS's, and a one-day shift in a date column is exactly the kind of
  // silent change this rewrite must not introduce. A file written by Excel stores a
  // serial with a date style instead, which the branch below handles and which has no
  // timezone ambiguity at all.
  if (t === 'd') {
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return unescapeXml(raw) || null;
    return new Date(ms + new Date(ms).getTimezoneOffset() * 60000);
  }
  if (t === 'str' || t === 'e') return unescapeXml(raw) || null;
  if (t === 'b') return raw === '1' || raw === 'true';

  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const s = Number(attr(a, 's') ?? '-1');
  // A date is a number plus a style that says so; without the style it is just a number.
  if (s >= 0 && dateStyles[s]) return serialToDate(n);
  return n;
}

/**
 * The workbook's sheets, in the order Excel shows them, each with the zip entry holding
 * its XML.
 *
 * The name is in `xl/workbook.xml` and the file it points at is in the rels, so the two
 * have to be joined — a sheet's position in the directory is not its position in the
 * workbook, and guessing `sheet1.xml` is the first tab is wrong often enough to matter.
 *
 * @param {Uint8Array} bytes - the whole .xlsx
 */
export function openWorkbook(bytes) {
  const dir = zipDirectory(bytes);
  const byName = new Map(dir.map((e) => [e.name, e]));

  const relsEntry = byName.get('xl/_rels/workbook.xml.rels') ?? null;

  return {
    entry: (name) => byName.get(name) ?? null,
    sharedStringsEntry: byName.get('xl/sharedStrings.xml') ?? null,
    stylesEntry: byName.get('xl/styles.xml') ?? null,
    workbookEntry: byName.get('xl/workbook.xml') ?? null,
    relsEntry,
    all: dir,
  };
}

/** Read a small entry fully as text (workbook.xml, rels) — these are kilobytes. */
async function entryText(entry) {
  if (!entry) return '';
  let out = '';
  await scanChunks(streamZipEntry(entry), (buf, final) => {
    if (!final) return 0;
    out = buf;
    return buf.length;
  });
  return out;
}

/**
 * Sheet names joined to their entries.
 *
 * @returns {Promise<Array<{name: string, entry: object}>>}
 */
export async function listSheets(wb) {
  const relsXml = await entryText(wb.relsEntry);
  const rels = new Map();
  const relRe = /<Relationship\b([^>]*)\/>/g;
  let m;
  while ((m = relRe.exec(relsXml))) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const bookXml = await entryText(wb.workbookEntry);
  const out = [];
  const sheetRe = /<sheet\b([^>]*)\/>/g;
  while ((m = sheetRe.exec(bookXml))) {
    const name = unescapeXml(attr(m[1], 'name') ?? '');
    const rid = attr(m[1], 'r:id') ?? attr(m[1], 'id');
    const target = rid ? rels.get(rid) : null;
    const entry = target ? wb.entry(`xl/${target}`) : null;
    if (entry) out.push({ name, entry });
  }
  // A workbook with no usable rels still has its sheets on disk; order by file name so
  // something sensible happens rather than nothing.
  if (!out.length) {
    for (const e of wb.all) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) out.push({ name: e.name, entry: e });
    }
  }
  return out;
}

/**
 * A sheet's declared extent, read without inflating the whole sheet.
 *
 * `<dimension ref="A1:DEF6273"/>` sits in the first few hundred bytes, before
 * `<sheetData>`. The picker needs it to say "6,272 rows × 3,379 cols" next to a tab
 * name, and paying a full inflate per tab just to label the dialog would undo the point
 * of this module.
 *
 * The attribute is optional in the spec. Excel and SheetJS both write it; a producer that
 * does not gets `null`, and the caller labels the tab without a size rather than guessing.
 *
 * @returns {Promise<?{rows: number, cols: number}>} rows EXCLUDES the header.
 */
export async function readSheetDimension(entry) {
  let buf = '';
  for await (const chunk of streamZipEntry(entry)) {
    buf += new TextDecoder('utf-8').decode(chunk, { stream: true });
    const m = /<dimension\b[^>]*\bref="([^"]*)"/.exec(buf);
    if (m) return parseRange(m[1]);
    // Past the opening of the cell data there will be no dimension element; stop rather
    // than inflating megabytes to learn nothing. (Breaking the loop closes the stream.)
    if (buf.includes('<sheetData')) return null;
    if (buf.length > 65536) return null; // a header this long is not going to declare one
  }
  return null;
}

/** `A1:DEF6273` → rows/cols. A single-cell ref (`A1`) is a one-cell sheet. */
function parseRange(ref) {
  const parts = String(ref).split(':');
  const end = parts[parts.length - 1];
  const start = parts[0];
  const r0 = Number(/(\d+)\s*$/.exec(start)?.[1] ?? '1');
  const r1 = Number(/(\d+)\s*$/.exec(end)?.[1] ?? '1');
  if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null;
  return {
    rows: Math.max(0, r1 - r0), // the first row is the header
    cols: Math.max(1, colFromRef(end) - colFromRef(start) + 1),
  };
}
