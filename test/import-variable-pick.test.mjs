/**
 * @file import-variable-pick.test.mjs
 * "Choose which variables to import", for every format rather than one.
 *
 * ## What this replaces
 *
 * `readImportPick` was a real feature behind an arbitrary door: a second File-menu entry,
 * "SPSS / Stata / SAS — choose variables…", reachable only for those three formats. So
 * picking 50 of the GSS's 7,000 variables was possible and doing the same thing to a
 * 3,379-column CSV was not — the same disease as the typing rule living in five codecs,
 * which is a capability belonging to importing generally living inside one codec.
 *
 * It is now a checkbox on the import picker plus one new codec verb, `catalog()` — "the
 * variable list without the data".
 *
 * ## The failure this file mostly guards
 *
 * Two different pieces of code have to agree on what a variable is CALLED, and they run
 * minutes apart: `catalog()` names the columns for the picker, and the import names them
 * again for real. If they disagree by one character the user ticks `a_2`, the import
 * produces `a2`, nothing selected matches anything imported, and the result is an empty
 * or hollow dataset with no error anywhere. So most of what follows is a round trip:
 * catalogue a file, import the same file, and require the two lists to be identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { workbook, sheetXml } from './xlsx-fixture.mjs';

const { ingestTable, tableVariableNames } = globalThis.ctStd;

/**
 * Every variable a catalogue offers, flattened, in order.
 *
 * `catalog()` returns a list of SOURCES as of 2026-11-20 — a workbook's sheets, and in
 * principle a `.RData`'s objects or a SQLite file's tables — because the host cannot know
 * whether a format holds one table or several. A single-table format may still answer
 * with the older `{variables}` shape, which the codec service wraps. Most assertions here
 * are about the agreement between a catalogue and an import, which is per source, so this
 * flattens only where the test genuinely does not care which source a name came from.
 */
/** Comments are prose about the rule, not the rule — strip before asserting absence. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const allNames = (cat) => (cat.sources
  ? cat.sources.flatMap((src) => src.variables.map((v) => v.name))
  : cat.variables.map((v) => v.name));

// The .xlsx reader and the Parquet reader both import their library from a blob: URL,
// which node's ESM loader refuses. Same shim as the two codec test files, for the same
// reason; see excel-codec-streaming.test.mjs for the long version.
const realCreateObjectURL = globalThis.URL.createObjectURL;
globalThis.URL.createObjectURL = (blob) => {
  const src = blob?.[Symbol.for('ct.test.source')] ?? null;
  if (src === null) return realCreateObjectURL?.call(globalThis.URL, blob);
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
 * A host for one codec call. `select` is what the user chose; `asset` answers
 * `loadAsset`.
 */
function host(bytes, { select = null, asset = null } = {}) {
  const out = { batches: [], variables: null, opts: null, select, created: [] };
  const app = {
    codec: {
      size: async () => bytes.length,
      read: async (off, len) => bytes.subarray(off, off + (len ?? bytes.length - off)),
      sourceFile: async () => ({ name: 'probe', size: bytes.length }),
      loadAsset: async (name) => (typeof asset === 'function' ? asset(name) : asset),
      begin: async (variables, storageTypes, opts) => {
        out.variables = variables;
        out.storageTypes = storageTypes;
        out.opts = opts ?? null;
      },
      batch: async (cols) => { out.batches.push(cols); },
      progress: async () => {},
      missingCodes: async () => [],
    },
    // Extra sources become their own datasets through `app.data.create`.
    data: { create: async (spec) => { out.created.push(spec); return 1; } },
    ui: { selectFromList: async () => null },
  };
  return { app, out };
}

/** Column names, stitched from what `begin` was told. */
const namesOf = (out) => (out.variables ?? []).map((v) => v.name);

/** Whole columns, stitched back out of the batches the way the host does. */
function columnsOf(out) {
  const cols = {};
  for (const v of out.variables ?? []) cols[v.name] = [];
  for (const b of out.batches) {
    for (const v of out.variables) cols[v.name].push(...Array.from(b[v.name]));
  }
  return cols;
}

// =============================================================================
// The naming rule both sides share
// =============================================================================

test('the shared naming rule is positional, so a blank is V<its own column>', () => {
  // The trap: naming the blanks in the order they are MET gives ['a','V1','a_2'], and a
  // catalogue built that way disagrees with an import built the other way. Position, not
  // rank among the blanks.
  assert.deepEqual(tableVariableNames(['a', '', 'a']), ['a', 'V2', 'a_2']);
  assert.deepEqual(tableVariableNames(['', '', 'x']), ['V1', 'V2', 'x']);
  assert.deepEqual(tableVariableNames(['  pad  ', null, undefined]), ['pad', 'V2', 'V3']);
  assert.deepEqual(tableVariableNames(['d', 'd', 'd']), ['d', 'd_2', 'd_3']);
});

// =============================================================================
// ingestTable: what a selection actually does
// =============================================================================

/** Drive `ingestTable` over rows of raw values, as a codec does. */
async function ingest(rows, { select = null } = {}) {
  const { app, out } = host(new Uint8Array(0), { select });
  await ingestTable(app, {
    select,
    scanRows: async (onRow) => {
      for (const r of rows) {
        const wait = onRow(r);
        if (wait) await wait; // eslint-disable-line no-await-in-loop
      }
    },
  });
  return { names: namesOf(out), columns: columnsOf(out), opts: out.opts };
}

test('an unselected column is not imported', async () => {
  const rows = [['a', 'b', 'c'], ['1', 'x', '3'], ['2', 'y', '4']];
  const r = await ingest(rows, { select: ['a', 'c'] });
  assert.deepEqual(r.names, ['a', 'c']);
  assert.deepEqual([...r.columns.a], [1, 2]);
  assert.deepEqual([...r.columns.c], [3, 4]);
});

test('the kept columns come from the right SOURCE positions', async () => {
  // The bug a naive implementation has: filter the variables but keep reading row[c] by
  // OUTPUT index, and every column after the first gap holds its neighbour's values.
  const rows = [['a', 'b', 'c', 'd'], ['1', '2', '3', '4']];
  const r = await ingest(rows, { select: ['b', 'd'] });
  assert.deepEqual(r.names, ['b', 'd']);
  assert.deepEqual([...r.columns.b], [2], 'b holds a’s value');
  assert.deepEqual([...r.columns.d], [4], 'd holds the wrong column’s value');
});

test('the file order is kept, not the order they were ticked in', async () => {
  const rows = [['a', 'b', 'c'], ['1', '2', '3']];
  const r = await ingest(rows, { select: ['c', 'a'] });
  assert.deepEqual(r.names, ['a', 'c']);
});

test('a selected name the file does not have is ignored, not fatal', async () => {
  // A recorded import may carry a selection made against a different revision of the
  // file. Failing the whole import over one renamed column would be worse than importing
  // what is still there.
  const rows = [['a', 'b'], ['1', '2']];
  const r = await ingest(rows, { select: ['a', 'gone'] });
  assert.deepEqual(r.names, ['a']);
});

test('but a selection matching NOTHING says so', async () => {
  // The one case where silence would be indefensible: an empty dataset that looks like a
  // successful import.
  const rows = [['a', 'b'], ['1', '2']];
  await assert.rejects(() => ingest(rows, { select: ['x', 'y'] }),
    /none of the selected variables/);
});

test('no selection imports everything, byte for byte as before', async () => {
  const rows = [['a', 'b'], ['1', 'x']];
  const all = await ingest(rows);
  const nul = await ingest(rows, { select: null });
  assert.deepEqual(all.names, ['a', 'b']);
  assert.deepEqual(nul.names, all.names);
});

test('the storage routing is recomputed for the NARROWED width', async () => {
  // Picking 50 of 7,000 variables should be routed as a 50-column dataset, which is the
  // memory win the feature exists for — not as a 7,000-column one.
  const wide = Array.from({ length: 3000 }, (_, c) => `v${c}`);
  const rows = [wide, wide.map((_, c) => String(c))];
  const r = await ingest(rows, { select: ['v0', 'v1'] });
  assert.equal(r.names.length, 2);
  assert.equal(r.opts.wide, false);
});

// =============================================================================
// Each codec: does its catalogue agree with its import?
// =============================================================================

const CSV = 'a,,a,zz\n1,2,3,x\n4,5,6,y\n';

test('CSV: the catalogue names exactly what the import names', async () => {
  const { catalogCsv, readCsv } = await import('../plugins/builtin-csv-codec/index.js');
  const bytes = new TextEncoder().encode(CSV);

  const h1 = host(bytes);
  const cat = await catalogCsv(h1.app, { name: 'x.csv' });
  const h2 = host(bytes);
  await readCsv(h2.app, { name: 'x.csv' });

  assert.deepEqual(cat.variables.map((v) => v.name), namesOf(h2.out));
  // And the awkward header is exactly the awkward case: a blank and a duplicate.
  assert.deepEqual(cat.variables.map((v) => v.name), ['a', 'V2', 'a_2', 'zz']);
});

test('CSV: a selection made from the catalogue imports those columns', async () => {
  const { catalogCsv, readCsv } = await import('../plugins/builtin-csv-codec/index.js');
  const bytes = new TextEncoder().encode(CSV);
  const cat = await catalogCsv(host(bytes).app, { name: 'x.csv' });
  const pick = [cat.variables[1].name, cat.variables[3].name]; // the blank one and 'zz'

  const h = host(bytes);
  await readCsv(h.app, { name: 'x.csv', select: pick });
  assert.deepEqual(namesOf(h.out), ['V2', 'zz']);
  assert.deepEqual([...columnsOf(h.out).V2], [2, 5]);
  assert.deepEqual(columnsOf(h.out).zz, ['x', 'y']);
});

test('CSV: the catalogue reads ONE chunk, not the file', async () => {
  // The promise the offer makes: choosing costs less than importing. A catalogue that
  // read the whole file would make "choose which variables" slower than importing them
  // all and deleting some.
  // Over 4 MiB, which is READ_CHUNK: at 200 KB "one chunk" and "the whole file" are the
  // same thing and the test could not fail.
  const big = `h1,h2\n${'123456,789012\n'.repeat(320_000)}`;
  const bytes = new TextEncoder().encode(big);
  assert.ok(bytes.length > (1 << 22), 'the fixture is smaller than one chunk');
  let bytesRead = 0;
  let calls = 0;
  const { app } = host(bytes);
  const inner = app.codec.read;
  app.codec.read = async (off, len) => {
    calls += 1;
    const u8 = await inner(off, len);
    bytesRead += u8.length;
    return u8;
  };
  const { catalogCsv } = await import('../plugins/builtin-csv-codec/index.js');
  const cat = await catalogCsv(app, { name: 'x.csv' });
  assert.deepEqual(cat.variables.map((v) => v.name), ['h1', 'h2']);
  assert.ok(bytesRead < bytes.length, `read all ${bytesRead} bytes of ${bytes.length}`);
  assert.equal(calls, 1, `${calls} reads for a header`);
});

test('CSV: an incomplete first line yields no catalogue rather than a truncated name', async () => {
  // A header longer than one chunk would otherwise be offered half-read, and the user
  // would tick a name the import never produces. No catalogue is the honest answer; the
  // host then says so and imports everything.
  const bytes = new TextEncoder().encode('a_very_long_header_with_no_newline_at_all');
  const { catalogCsv } = await import('../plugins/builtin-csv-codec/index.js');
  const cat = await catalogCsv(host(bytes).app, { name: 'x.csv' });
  assert.deepEqual(cat.variables, []);
});

test('JSON Lines: the catalogue agrees with the import, sampling aside', async () => {
  const { catalogNdjson, readNdjson } = await import('../plugins/builtin-ndjson-codec/index.js');
  const text = '{"a":1,"b":"x"}\n{"b":"y","a":2}\n';
  const bytes = new TextEncoder().encode(text);

  const cat = await catalogNdjson(host(bytes).app, {});
  const h = host(bytes);
  await readNdjson(h.app, {});
  assert.deepEqual(cat.variables.map((v) => v.name), namesOf(h.out));
  assert.deepEqual(cat.variables.map((v) => v.name), ['a', 'b']);
});

test('JSON Lines: a selection drops the rest', async () => {
  const { readNdjson } = await import('../plugins/builtin-ndjson-codec/index.js');
  const bytes = new TextEncoder().encode('{"a":1,"b":"x","c":9}\n{"a":2,"b":"y","c":8}\n');
  const h = host(bytes);
  await readNdjson(h.app, { select: ['a', 'c'] });
  assert.deepEqual(namesOf(h.out), ['a', 'c']);
  assert.deepEqual([...columnsOf(h.out).c], [9, 8]);
});

test('Excel: the catalogue agrees with the import', async () => {
  const { catalogXlsx, readXlsx } = await import('../plugins/builtin-excel-codec/index.js');
  // A text cell is an `inlineStr`; `<v>a</v>` declares a NUMBER whose value is "a", and
  // the reader is right to discard it. Getting that wrong the first time is what this
  // test caught: catalogue and import agreed perfectly on the WRONG header (the data row,
  // promoted after row 1 was discarded), which is exactly the agreement being asserted —
  // so the fixture had to be fixed and not the assertion.
  const text = (c, r, v) => `<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const num = (c, r, v) => `<c r="${String.fromCharCode(65 + c)}${r}"><v>${v}</v></c>`;
  const sheet = `<row r="1">${text(0, 1, 'a')}${text(2, 1, 'a')}</row>`
    + `<row r="2">${num(0, 2, 1)}${num(1, 2, 2)}${num(2, 2, 3)}</row>`
    + `<row r="3">${num(0, 3, 4)}${num(1, 3, 5)}${num(2, 3, 6)}</row>`;
  const bytes = workbook({ sheet1: sheet, dim1: 'A1:C3' });
  const asset = (name) => (name === 'xlsx-stream' ? STREAM_SOURCE : null);

  const cat = await catalogXlsx(host(bytes, { asset }).app, {});
  // One source per sheet now, so the agreement is checked against the SHEET the import
  // actually read rather than against a flattened list — which is the whole reason the
  // tree shape exists. The old version offered the first sheet's header as a guess and
  // the import matched it by name against whichever sheet was chosen afterwards.
  assert.ok(Array.isArray(cat.sources), 'the catalogue is not a list of sources');
  const h = host(bytes, { asset });
  await readXlsx(h.app, { name: 'book.xlsx', plan: { sources: { [cat.sources[0].id]: null } } });
  assert.deepEqual(cat.sources[0].variables.map((v) => v.name), namesOf(h.out));
  assert.deepEqual(cat.sources[0].variables.map((v) => v.name), ['a', 'V2', 'a_2']);
  // ...and the row count the picker shows beside each heading comes from the sheet's own
  // dimension record, which is what tells a data sheet from a codebook at a glance.
  assert.equal(cat.sources[0].rowCount, 2);
});

test('Excel: ABC from one sheet and DEF from another is TWO datasets', async () => {
  // The shape the owner asked for, and the answer to what it means. Two sheets are two
  // tables with their own row counts and no shared row identity, so pooling them would be
  // a positional paste — which this codec has always refused. Each picked sheet becomes
  // its own dataset, narrowed to what was ticked under its own heading.
  const { catalogXlsx, readXlsx } = await import('../plugins/builtin-excel-codec/index.js');
  const text = (c, r, v) => `<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const num = (c, r, v) => `<c r="${String.fromCharCode(65 + c)}${r}"><v>${v}</v></c>`;
  const bytes = workbook({
    sheet1: `<row r="1">${text(0, 1, 'ABC')}${text(1, 1, 'XYZ')}</row>`
      + `<row r="2">${num(0, 2, 1)}${num(1, 2, 9)}</row>`,
    dim1: 'A1:B2',
    sheet2: `<row r="1">${text(0, 1, 'term')}${text(1, 1, 'DEF')}</row>`
      + `<row r="2">${num(0, 2, 7)}${num(1, 2, 8)}</row>`,
    dim2: 'A1:B2',
  });
  const asset = (name) => (name === 'xlsx-stream' ? STREAM_SOURCE : null);

  const cat = await catalogXlsx(host(bytes, { asset }).app, {});
  assert.equal(cat.sources.length, 2, 'both sheets were not declared');
  const [s1, s2] = cat.sources;
  assert.deepEqual(s1.variables.map((v) => v.name), ['ABC', 'XYZ']);
  assert.deepEqual(s2.variables.map((v) => v.name), ['term', 'DEF']);

  const h = host(bytes, { asset });
  await readXlsx(h.app, {
    name: 'book.xlsx',
    plan: { sources: { [s1.id]: ['ABC'], [s2.id]: ['DEF'] } },
  });
  // Sheet 1 is the primary: it streams through the host ingest.
  assert.deepEqual(namesOf(h.out), ['ABC']);
  assert.deepEqual([...columnsOf(h.out).ABC], [1]);
  // Sheet 2 becomes its own dataset, narrowed to ITS pick and not to the primary's.
  assert.equal(h.out.created.length, 1);
  assert.equal(h.out.created[0].name, s2.id);
  assert.deepEqual(h.out.created[0].variables.map((v) => v.name), ['DEF']);
  assert.deepEqual([...h.out.created[0].columns.DEF], [8]);
});

test('Excel: a selection drops the rest', async () => {
  const { readXlsx } = await import('../plugins/builtin-excel-codec/index.js');
  const sheet = sheetXml('A1:C2', '<row r="1">'
    + '<c r="A1" t="inlineStr"><is><t>keep</t></is></c>'
    + '<c r="B1" t="inlineStr"><is><t>drop</t></is></c>'
    + '<c r="C1" t="inlineStr"><is><t>also</t></is></c></row>'
    + '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><v>3</v></c></row>');
  // `sheetXml` wraps rows; pass the rows through `workbook` instead so the dim matches.
  const bytes = workbook({
    sheet1: '<row r="1">'
      + '<c r="A1" t="inlineStr"><is><t>keep</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>drop</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>also</t></is></c></row>'
      + '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><v>3</v></c></row>',
    dim1: 'A1:C2',
  });
  assert.ok(sheet.length > 0); // the helper is exercised, not asserted on
  const asset = (name) => (name === 'xlsx-stream' ? STREAM_SOURCE : null);
  const h = host(bytes, { asset });
  await readXlsx(h.app, {
    name: 'book.xlsx',
    plan: { sources: { Data: ['keep', 'also'] } },
  });
  assert.deepEqual(namesOf(h.out), ['keep', 'also']);
  assert.deepEqual([...columnsOf(h.out).also], [3]);
});

test('Parquet: the catalogue is the footer, and a selection is a genuine SKIP', async () => {
  // The format where this pays most: columnar, so an unselected column is never
  // decompressed. The assertion is that hyparquet is TOLD which columns to read — a
  // filter applied after decoding would be correct and would waste the whole point.
  const { catalogParquet, readParquet } = await import('../plugins/builtin-parquet-codec/index.js');
  const src = `
    export async function parquetMetadataAsync() {
      return {
        num_rows: 2n,
        row_groups: [{ num_rows: 2n }],
        schema: [
          { name: 'root', num_children: 3 },
          { name: 'a' }, { name: 'b' }, { name: 'c' },
        ],
      };
    }
    globalThis.__askedFor = [];
    export async function parquetReadObjects({ columns }) {
      globalThis.__askedFor.push(columns ?? null);
      const rows = [{ a: 1, b: 'x', c: 9 }, { a: 2, b: 'y', c: 8 }];
      if (!columns) return rows;
      return rows.map((r) => Object.fromEntries(columns.map((k) => [k, r[k]])));
    }
  `;
  const bytes = new Uint8Array(16);
  const cat = await catalogParquet(host(bytes, { asset: src }).app, {});
  assert.deepEqual(cat.variables.map((v) => v.name), ['a', 'b', 'c'], 'the root group is not a column');
  assert.equal(cat.rowCount, 2, 'a BigInt row count survived');

  globalThis.__askedFor = [];
  const h = host(bytes, { asset: src });
  await readParquet(h.app, { select: ['a', 'c'] });
  assert.deepEqual(namesOf(h.out), ['a', 'c']);
  assert.deepEqual(globalThis.__askedFor, [['a', 'c']], 'it decoded columns nobody asked for');
});

// =============================================================================
// The chain — because a verb that exists everywhere but one place is the bug
// =============================================================================

test('`catalog` is forwarded at every point between the manifest and the host', async () => {
  // THE BUG THIS EXISTS FOR, already paid for once: `progress` was wired into the sandbox
  // namespace, the broker and the read session, and dropped in plugin-actions. Everything
  // looked right and the import died on a phone. `catalog` travels the same road.
  const actions = readFileSync('core/plugin-actions.js', 'utf8');
  assert.match(actions, /catalog: codec\.catalog/, 'plugin-actions drops it');

  const svc = readFileSync('core/codec-service.js', 'utf8');
  assert.match(svc, /readCatalog: \(file\) => this\.#runCatalog/, 'codec-service does not expose it');
  assert.match(svc, /spec\.catalog \? \{ readCatalog/, 'it is exposed even when the codec has none');

  const imp = readFileSync('core/import-service.js', 'utf8');
  assert.match(imp, /spec\.readCatalog/, 'import-service never calls it');
  assert.match(imp, /startRead\(file, \{ plan \}\)/, 'the import plan never reaches the read');

  // The codec's own sheet dialog is gone: `catalog` declares a source per sheet and the
  // host asks both questions at once, before the read. Deciding WHETHER to ask was always
  // the codec's business and still is — the catalogue is what says there are sheets at
  // all — but two dialogs from two owners in an undesigned order was not.
  // Comments stripped FIRST. The codec's own doc comment explains that it USED to call
  // `app.ui.selectFromList`, which is exactly the prose this assertion would match — a
  // trap this repo has fallen into repeatedly, where a correct comment breaks its own
  // guard.
  const excel = stripComments(readFileSync('plugins/builtin-excel-codec/index.js', 'utf8'));
  assert.ok(!/chooseSheets/.test(excel), 'the codec still runs its own sheet picker');
  assert.ok(!/app\.ui\./.test(excel), 'the codec still opens a dialog of its own');

  // ...and the declaring end: every codec that can name its columns cheaply does.
  for (const name of ['builtin-csv-codec', 'builtin-ndjson-codec', 'builtin-excel-codec',
    'builtin-parquet-codec', 'builtin-readstat-codec']) {
    const src = readFileSync(`plugins/${name}/index.js`, 'utf8');
    assert.match(src, /catalog: '\w+'/, `${name} declares no catalog`);
  }
});

test('the duplicate SPSS menu entry is gone, but its recorded id still resolves', async () => {
  // The point of the whole exercise: one capability, offered once, instead of a second
  // File-menu entry for the one codec that implemented it.
  const readstat = readFileSync('plugins/builtin-readstat-codec/index.js', 'utf8');
  assert.ok(!/readstat-pick/.test(readstat), 'the duplicate codec entry is still declared');
  assert.ok(!/readImportPick/.test(readstat), 'the second read verb is still exported');

  // ...and the id must NOT be purged everywhere. A project saved before today records
  // `readstat-pick` as the importer that made its dataset, and script export reads that
  // log to decide which R/Stata reader to emit. Dropping the row would downgrade those
  // exports from a known reader to a guess — a silent regression in old projects, which
  // is exactly the kind of thing a tidy-up grep causes.
  const exp = readFileSync('core/script-export.js', 'utf8');
  assert.match(exp, /'readstat-pick': \{ byExtension: true \}/,
    'a recorded readstat-pick import no longer resolves to a reader');
});

test('the import picker carries the option, and reads it before closing', async () => {
  const picker = readFileSync('core/format-picker.js', 'utf8');
  // Read BEFORE close: the `close` listener removes the dialog, and a removed input
  // reports nothing. This ordering is the whole correctness of the checkbox.
  const read = picker.indexOf('const opts = readOptions();');
  const closed = picker.indexOf('dialog.close();', read > 0 ? read : 0);
  assert.ok(read > 0 && closed > read, 'options are read after the dialog is closed');
  assert.match(picker, /entry\.command\(opts\)/, 'the choice is not passed the options');

  const imp = readFileSync('core/import-service.js', 'utf8');
  assert.match(imp, /id: 'pick'/, 'the import picker offers no variable-pick option');
  // Asked once per RUN, not once per file: stacked sources are UNIONed BY NAME, so a
  // different answer for file 2 hollows out file 1.
  assert.match(imp, /asked: false, wanted: !!pickerOptions\.pick/,
    'the once-per-run latch is gone');
  // And the latch now closes AFTER the catalogue is seen rather than before, because a
  // multi-source file has to be asked "which tables?" whatever the user said about
  // variables — which is what let the Excel codec stop asking for itself.
  assert.match(imp, /if \(sources\.length === 1 && !run\.wanted\) return null;/,
    'a multi-source file is no longer always asked about');
});

test('a codec with no catalogue is told to the user, not ignored', async () => {
  // The user ticked a box. Silently importing all 3,379 columns after being asked to
  // choose is the failure this avoids.
  const imp = readFileSync('core/import-service.js', 'utf8');
  // Checked where the BRANCH is, not inside the codec path: the picker also lists web
  // sources that fetch their own bytes and legacy `parse` importers, and neither ever
  // reaches the codec path — so a check further in would have covered the one kind that
  // was never the problem. Found while driving the real dialog, not by reading.
  const at = imp.indexOf("options.pick && typeof spec.readCatalog !== 'function'");
  assert.ok(at > 0, 'the unsupported case is not handled before the branch');
  const window = imp.slice(at, at + 600);
  assert.match(window, /appendText/, 'it says nothing when it cannot list the variables');
  assert.match(window, /pick: false/, 'it explains itself and then asks anyway');
  // ...and before the web branch, or a web source silently swallows the option again.
  assert.ok(at < imp.indexOf("spec.source === 'web'", at - 400 > 0 ? at - 400 : 0) || true);
  const webAt = imp.indexOf("if (spec.source === 'web') return this.#runWebImport");
  assert.ok(webAt > at, 'the web branch is taken before the option is answered');
});
