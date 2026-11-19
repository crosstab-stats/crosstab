/**
 * @file excel-codec-streaming.test.mjs
 * The Excel codec now has TWO readers, and which one runs is the whole point.
 *
 * ## What happened
 *
 * Reading an .xlsx through SheetJS cost ~1.23 MiB per row of a 3,379-column sheet, so a
 * College Scorecard year wanted about 7.6 GiB against a renderer cap near 4. An .xlsx is
 * a zip of XML and can be read a chunk at a time, so now it is — but .xls (BIFF) and
 * .xlsb (binary sheet parts) are not XML and still need SheetJS.
 *
 * Two readers behind one codec is the risk this file exists for. The failure modes are
 * silent ones: an .xlsx quietly taking the SheetJS path (the OOM comes back), an .xls
 * taking the streaming path (garbage or a throw for a file that used to work), or the two
 * paths disagreeing about types, missing values or row shape so that which reader ran
 * changes what the user gets. So what is asserted here is routing and equivalence, not
 * parsing — `xlsx-streaming.test.mjs` covers the reader itself.
 *
 * ## The one shim
 *
 * A codec loads a dependency as TEXT and blob-imports it, because the sandbox allows
 * `blob:` scripts and no fetching. Node refuses to import a blob URL
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME) but will import a `data:` URL, so
 * `URL.createObjectURL` is swapped for one that produces the latter. Both mean "import
 * this source text"; the source is the REAL `core/xlsx-stream.js` off disk, so the asset
 * contract — host hands over text, codec turns it into a module — is exercised rather
 * than stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { workbook, sheetXml, zip, WORKBOOK_XML, RELS_XML } from './xlsx-fixture.mjs';

const { readXlsx } = await import('../plugins/builtin-excel-codec/index.js');

// --- the data: URL shim ------------------------------------------------------

const realCreateObjectURL = globalThis.URL.createObjectURL;
globalThis.URL.createObjectURL = (blob) => {
  if (typeof blob?.text !== 'function') return realCreateObjectURL?.call(globalThis.URL, blob);
  // Blob.text() is async and createObjectURL is not, so carry the bytes synchronously.
  const src = blob[Symbol.for('ct.test.source')] ?? null;
  if (src === null) throw new Error('test shim: blob source not recorded');
  return `data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`;
};
const RealBlob = globalThis.Blob;
globalThis.Blob = class extends RealBlob {
  constructor(parts, opts) {
    super(parts, opts);
    if (typeof parts?.[0] === 'string') this[Symbol.for('ct.test.source')] = parts[0];
  }
};
globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL ?? (() => {});

const STREAM_SOURCE = readFileSync(new URL('../core/xlsx-stream.js', import.meta.url), 'utf8');

/**
 * A fake SheetJS, for the .xls/.xlsb fallback.
 *
 * Deliberately minimal: what is under test is that the codec ROUTES a legacy file here
 * and still completes, not SheetJS's parsing. It reads a tiny JSON "workbook" so a test
 * can state the cells plainly.
 */
const FAKE_SHEETJS = `
export const utils = {
  sheet_to_json: (ws) => ws.aoa,
  decode_range: (ref) => {
    const m = /^A1:([A-Z]+)(\\d+)$/.exec(ref);
    const cols = m ? m[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) : 1;
    return { s: { r: 0, c: 0 }, e: { r: m ? Number(m[2]) - 1 : 0, c: cols - 1 } };
  },
};
export function read(bytes) {
  globalThis.__fakeSheetJsRead = (globalThis.__fakeSheetJsRead || 0) + 1;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(8)));
}
`;

/** Bytes that look like an .xls (OLE compound magic) carrying a fake workbook after it. */
function legacyWorkbook(obj) {
  const head = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Run the codec over `bytes`.
 *
 * @param {Uint8Array} bytes the file
 * @param {object} [opts]
 * @param {((payload: object) => string[])|null} [opts.answer] what the host replies to
 *   `missingCodes`. `null` means the host does NOT implement the verb — the negative
 *   control, where typing must be exactly what it was before any of this.
 * @param {?string[]} [opts.sheets] what the sheet picker returns (null → no UI service).
 */
async function run(bytes, { answer = () => [], sheets = null, name = 'book.xlsx' } = {}) {
  globalThis.__fakeSheetJsRead = 0;
  const out = {
    batches: [], variables: null, storageTypes: null, beginOpts: null,
    asked: null, assets: [], created: [], offered: null,
  };
  const codec = {
    size: async () => bytes.length,
    read: async (off, len) => bytes.subarray(off, off + len),
    loadAsset: async (n) => {
      out.assets.push(n);
      if (n === 'xlsx-stream') return STREAM_SOURCE;
      if (n === 'xlsx') return FAKE_SHEETJS;
      throw new Error(`unexpected asset ${n}`);
    },
    begin: async (variables, storageTypes, opts) => {
      out.variables = variables;
      out.storageTypes = storageTypes;
      out.beginOpts = opts;
    },
    batch: async (cols) => { out.batches.push(cols); },
    progress: async () => {},
  };
  if (answer) {
    codec.missingCodes = async (payload) => { out.asked = payload; return answer(payload); };
  }
  const app = {
    codec,
    data: { create: async (spec) => { out.created.push(spec); } },
  };
  if (sheets) {
    app.ui = {
      selectFromList: async (spec) => { out.offered = spec.items.map((i) => i.label); return sheets; },
    };
  }
  await readXlsx(app, { name });

  const columns = {};
  for (const v of out.variables ?? []) columns[v.name] = [];
  for (const b of out.batches) {
    for (const v of out.variables) columns[v.name].push(...Array.from(b[v.name]));
  }
  return { ...out, columns, rows: out.batches.reduce((n, b) => n + b[out.variables[0].name].length, 0) };
}

/** Header + data rows as `<row>` XML, values written as inline strings or numbers. */
function sheetOf(rows) {
  const letter = (i) => {
    let s = '';
    for (let x = i + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
    return s;
  };
  return rows.map((row, r) => {
    if (row === null) return `<row r="${r + 1}"/>`; // an empty row, present in the XML
    const cells = row.map((v, c) => {
      const ref = `${letter(c)}${r + 1}`;
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
}

// =============================================================================
// Routing: which reader ran
// =============================================================================

test('an .xlsx streams, and SheetJS is never even fetched', async () => {
  const r = await run(workbook({ sheet1: sheetOf([['a', 'b'], [1, 2], [3, 4]]) }));
  assert.deepEqual(r.assets, ['xlsx-stream'], 'only the streaming reader was loaded');
  assert.equal(globalThis.__fakeSheetJsRead, 0, 'SheetJS did not parse anything');
  assert.deepEqual(r.columns, { a: [1, 3], b: [2, 4] });
});

test('an .xls falls back to SheetJS rather than being misread', async () => {
  const r = await run(legacyWorkbook({
    SheetNames: ['S'],
    Sheets: { S: { '!ref': 'A1:B3', aoa: [['a', 'b'], [1, 2], [3, 4]] } },
  }), { name: 'old.xls' });
  assert.deepEqual(r.assets, ['xlsx'], 'the streaming reader was not loaded at all');
  assert.equal(globalThis.__fakeSheetJsRead, 1);
  assert.deepEqual(r.columns, { a: [1, 3], b: [2, 4] },
    'and the legacy path still produces the same columns',
  );
});

test('an .xlsb — a zip whose sheet parts are binary — falls back too', async () => {
  // The dangerous near-miss: it IS a zip, so the magic check passes and the streaming
  // reader opens it happily. The sheet part is `.bin`, and scanning binary as XML yields
  // a silently EMPTY import — the worst outcome of the three, because nothing reports it.
  const bytes = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels',
      data: RELS_XML.replace(/sheet(\d)\.xml/g, 'sheet$1.bin'), deflate: true },
    { name: 'xl/worksheets/sheet1.bin', data: 'not xml at all', deflate: true },
    { name: 'xl/worksheets/sheet2.bin', data: 'not xml at all', deflate: true },
  ]);
  // The fake SheetJS cannot parse this, and that is the point: the import FAILS from
  // inside the fallback instead of succeeding emptily from the streaming reader.
  await assert.rejects(() => run(bytes, { name: 'book.xlsb' }));
  assert.equal(globalThis.__fakeSheetJsRead, 1, 'the legacy reader is the one that ran');
});

// =============================================================================
// Typing and missing values: the two paths must agree
// =============================================================================

test('a column numeric APART FROM a code is recovered once the host accepts it', async () => {
  const sheet = sheetOf([['n', 'txt'], [1, 'Public'], ['NA', 'Private'], [3, 'Public']]);
  const r = await run(workbook({ sheet1: sheet }), { answer: () => ['NA'] });

  assert.deepEqual(r.asked.candidates.map((c) => c.value), ['NA'],
    'NA is offered; "Public"/"Private" are not, because that column has no numbers',
  );
  assert.deepEqual(r.variables.map((v) => v.type), ['numeric', 'string']);
  assert.deepEqual(Array.from(r.columns.n), [1, NaN, 3]);
  assert.deepEqual(r.columns.txt, ['Public', 'Private', 'Public']);
  assert.deepEqual(r.beginOpts.missingCodes, ['NA'], 'and the codes are recorded on the import');
});

test('the negative control: a host that does not ask gets the old typing', async () => {
  const sheet = sheetOf([['n'], [1], ['NA'], [3]]);
  const r = await run(workbook({ sheet1: sheet }), { answer: null });
  assert.deepEqual(r.variables.map((v) => v.type), ['string'],
    'one "NA" still makes the whole column a string when nobody is asked',
  );
  assert.deepEqual(r.columns.n, ['1', 'NA', '3']);
  assert.equal(r.asked, null);
});

test('a number stays a number and text that LOOKS numeric does not', async () => {
  // A cell holding the text "01234" is a ZIP code. Typing the column numeric would drop
  // the leading zero, which is why the Excel rule is "a real number", not "parses as one".
  const sheet =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>zip</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>01234</t></is></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>00987</t></is></c></row>';
  const r = await run(workbook({ sheet1: sheet }), { answer: () => [] });
  assert.equal(r.variables[0].type, 'string');
  assert.deepEqual(r.columns.zip, ['01234', '00987']);
});

test('an accepted code is missing in a TEXT column too', async () => {
  const sheet = sheetOf([['n', 't'], [1, 'yes'], ['NA', 'NA'], [3, 'no']]);
  const r = await run(workbook({ sheet1: sheet }), { answer: () => ['NA'] });
  assert.deepEqual(Array.from(r.columns.n), [1, NaN, 3]);
  assert.deepEqual(r.columns.t, ['yes', null, 'no'],
    'the host was asked whether NA means missing and said yes; it means that everywhere',
  );
});

// =============================================================================
// Row shape
// =============================================================================

test('blank rows are dropped, as the SheetJS path did', async () => {
  // `blankrows: false` is what the codec used, so a blank row in the middle shifts every
  // row after it. Both forms of blank: absent from the XML, and present but empty.
  const sheet = sheetOf([['a'], [1], null, [2], [null], [3]]);
  const r = await run(workbook({ sheet1: sheet }), { answer: () => [] });
  assert.deepEqual(Array.from(r.columns.a), [1, 2, 3]);
  assert.equal(r.beginOpts.rowCount, 3, 'and the count the progress bar gets matches');
});

test('the first non-blank row is the header, even after leading blanks', async () => {
  const sheet = sheetOf([null, ['a', 'b'], [1, 2]]);
  const r = await run(workbook({ sheet1: sheet }), { answer: () => [] });
  assert.deepEqual(r.variables.map((v) => v.name), ['a', 'b']);
  assert.deepEqual(Array.from(r.columns.a), [1]);
});

test('blank and duplicate header cells get usable names', async () => {
  const sheet = sheetOf([['a', null, 'a'], [1, 2, 3]]);
  const r = await run(workbook({ sheet1: sheet }), { answer: () => [] });
  assert.deepEqual(r.variables.map((v) => v.name), ['a', 'V2', 'a_2']);
});

test('a row WIDER than the header still gets its columns', async () => {
  const sheet = sheetOf([['a'], [1, 99]]);
  const r = await run(workbook({ sheet1: sheet }), { answer: () => [] });
  assert.deepEqual(r.variables.map((v) => v.name), ['a', 'V2'],
    'the width comes from the widest row, not from the header alone',
  );
  assert.deepEqual(Array.from(r.columns.V2), [99]);
});

// =============================================================================
// Batching: cells, not rows
// =============================================================================

test('batches are bounded by CELLS, which is what a wide sheet needs', async () => {
  // A fixed row count is fine at ten columns and fatal at three thousand. This is the
  // arithmetic that handed DuckDB one batch of 21 million cells and OOMed at 3.1 GiB.
  const width = 40;
  const header = Array.from({ length: width }, (_, c) => `v${c}`);
  const rows = [header];
  for (let r = 0; r < 120; r++) rows.push(Array.from({ length: width }, (_, c) => r * width + c));
  const r = await run(workbook({ sheet1: sheetOf(rows) }), { answer: () => [] });

  assert.equal(r.rows, 120, 'every row arrived');
  const perBatch = r.batches.map((b) => b.v0.length);
  assert.equal(perBatch.reduce((a, b) => a + b, 0), 120);
  for (const b of r.batches) {
    const cells = Object.keys(b).length * b.v0.length;
    assert.ok(cells <= 1_000_000, `a batch carried ${cells} cells`);
  }
  // Values land in the right column, not shifted by the batch boundary.
  assert.equal(Array.from(r.columns.v0).at(-1), 119 * width);
  assert.equal(Array.from(r.columns[`v${width - 1}`]).at(-1), 119 * width + width - 1);
});

test('numeric columns arrive as Float64Array, text as plain arrays', async () => {
  const r = await run(workbook({ sheet1: sheetOf([['n', 't'], [1, 'x']]) }), { answer: () => [] });
  assert.ok(r.batches[0].n instanceof Float64Array);
  assert.ok(Array.isArray(r.batches[0].t));
});

// =============================================================================
// Multi-sheet workbooks
// =============================================================================

test('a multi-sheet workbook asks, and splits the extra sheet into its own dataset', async () => {
  const bytes = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS_XML, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml('A1:B3', sheetOf([['a', 'b'], [1, 2], [3, 4]])), deflate: true },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml('A1:A3', sheetOf([['code'], ['x'], ['y']])), deflate: true },
  ]);
  const r = await run(bytes, { answer: () => [], sheets: ['Data', 'Codebook'] });

  assert.deepEqual(r.offered, ['Data  (2 rows × 2 cols)', 'Codebook  (2 rows × 1 cols)'],
    'the picker labels each tab with its size, read from the dimension without inflating it',
  );
  assert.deepEqual(r.columns, { a: [1, 3], b: [2, 4] }, 'the first chosen sheet is the primary');
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].name, 'Codebook');
  assert.deepEqual(r.created[0].columns.code, ['x', 'y'],
    'the second sheet is its own dataset — workbook tabs are not row-stacked',
  );
  assert.equal(r.created[0].activate, false);
});

test('with no UI service the first sheet is used, not a failure', async () => {
  const bytes = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS_XML, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml('A1:A2', sheetOf([['a'], [1]])), deflate: true },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml('A1:A2', sheetOf([['b'], [2]])), deflate: true },
  ]);
  const r = await run(bytes, { answer: () => [] });
  assert.deepEqual(r.variables.map((v) => v.name), ['a']);
  assert.equal(r.created.length, 0);
});

test('cancelling the sheet picker cancels the import', async () => {
  const bytes = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS_XML, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml('A1:A2', sheetOf([['a'], [1]])), deflate: true },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml('A1:A2', sheetOf([['b'], [2]])), deflate: true },
  ]);
  const began = [];
  const app = {
    codec: {
      size: async () => bytes.length,
      read: async (off, len) => bytes.subarray(off, off + len),
      loadAsset: async () => STREAM_SOURCE,
      begin: async (v) => { began.push(v); },
      batch: async () => {},
    },
    ui: { selectFromList: async () => null }, // null is a cancel; [] is "none chosen"
    data: { create: async () => {} },
  };
  await assert.rejects(() => readXlsx(app, { name: 'x.xlsx' }), /cancelled/i);
  assert.equal(began.length, 0, 'nothing was ingested before the cancel');

  app.ui.selectFromList = async () => [];
  await assert.rejects(() => readXlsx(app, { name: 'x.xlsx' }), /no sheets selected/i);
});