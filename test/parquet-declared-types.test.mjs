/**
 * @file parquet-declared-types.test.mjs
 * Parquet column types read from the footer, against REAL Parquet bytes.
 *
 * ## What this replaced
 *
 * The reader decided each column from the values in the first row group that had any —
 * the same shape of bug the JSON Lines reader had (a type inferred from a sample and
 * applied to the whole file), and harder to excuse in a format that carries real types in
 * its footer. A column whose first row group happens to be all-null, or all integers
 * before a later group introduces a string, was typed wrong in silence.
 *
 * ## Why this file writes real files instead of stubbing
 *
 * Because the mapping cannot be derived from the Parquet spec. What matters is not what an
 * annotation MEANS but what hyparquet hands back for it, and the two differ in ways that
 * would have been got wrong by reading the spec:
 *
 *   DATE, TIMESTAMP_*, INT96  ->  Date objects, not numbers
 *   JSON, GEOMETRY            ->  already-parsed JS values
 *   DECIMAL                   ->  a Number, pre-divided by its scale
 *   TIME_MILLIS               ->  not converted at all; a raw INT32
 *
 * A stub would have let any of those pass. So the fixtures are written with
 * hyparquet-writer and read with hyparquet — the same two libraries the app loads as
 * assets — which makes this the one test in the suite that would catch the mapping
 * drifting under a library upgrade.
 *
 * The libraries are pinned CDN modules, so they are imported the way the codec imports
 * them: from source text through a `data:` URL (node refuses the `blob:` URL the sandbox
 * uses; see the shim below). If the network is unavailable the fixtures cannot be built,
 * and those tests SKIP rather than pass vacuously.
 *
 * ## So the file has two halves, and only one of them needs the network
 *
 * The mapping itself is a pure function — schema elements in, types out — so it is tested
 * exhaustively offline, and that half always runs. The round trip against real bytes is
 * what proves the mapping still matches what the library does, which is the half that
 * would catch a version bump changing a conversion under us. A reader who finds the
 * second half skipped should know the first half still covered the logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { readParquet, catalogParquet, schemaTypes, declaredType } = await import('../plugins/builtin-parquet-codec/index.js');

// The codec imports its asset with `URL.createObjectURL` + `import(blobUrl)`; node's ESM
// loader accepts file:, data: and node: and refuses blob:. Same shim as the other codec
// tests, for the same reason.
let lastAssetSource = null;
URL.createObjectURL = () => `data:text/javascript;base64,${Buffer.from(lastAssetSource).toString('base64')}`;
URL.revokeObjectURL = () => {};

/** The pinned bundles, exactly as `core/codec-service.js`'s ASSETS table names them. */
const CDN = {
  hyparquet: 'https://esm.sh/hyparquet@1?bundle&target=es2022',
  'hyparquet-writer': 'https://esm.sh/hyparquet-writer@0.16.1?bundle&target=es2022',
};

const sources = new Map();
let offline = null;

/** Fetch a bundle once. `?bundle` on esm.sh re-exports from a versioned path, so follow
 * the one-line indirection the same way the host's vendor script does. */
async function assetSource(name) {
  if (sources.has(name)) return sources.get(name);
  const text = await (await fetch(CDN[name])).text();
  const m = /export \* from "([^"]+)"/.exec(text);
  const src = m ? await (await fetch(new URL(m[1], 'https://esm.sh/')).then((r) => r)).text() : text;
  sources.set(name, src);
  return src;
}

/** The writer, imported the same way the codec imports its reader. */
async function writer() {
  lastAssetSource = await assetSource('hyparquet-writer');
  return import(URL.createObjectURL(new Blob([lastAssetSource])));
}

test.before(async () => {
  try {
    await assetSource('hyparquet');
    await assetSource('hyparquet-writer');
  } catch (err) {
    offline = String(err?.message ?? err);
  }
});

/**
 * Run the codec over real Parquet bytes and report what it told the host.
 *
 * @param {Array<{name: string, data: any[], type?: string}>} columnData - the writer's
 *   column spec; `type` picks the physical/annotated Parquet type.
 * @param {object} [opts]
 * @param {?string[]} [opts.select] - a per-variable selection
 * @param {number} [opts.rowGroupSize] - force more than one row group
 */
async function roundTrip(columnData, { select = null, rowGroupSize } = {}) {
  const W = await writer();
  const buf = W.parquetWriteBuffer({ columnData, ...(rowGroupSize ? { rowGroupSize } : {}) });
  const bytes = new Uint8Array(buf);

  const out = { batches: [], variables: null, storageTypes: null, opts: null };
  const app = {
    codec: {
      loadAsset: async (name) => { lastAssetSource = await assetSource(name); return lastAssetSource; },
      size: async () => bytes.length,
      // `slice`, NOT `subarray`. The codec's `sourceBuffer` hands hyparquet `u8.buffer`,
      // and a subarray SHARES its backing buffer — so every range request would have
      // returned the whole file and hyparquet would read at the wrong offsets
      // ("unsupported page type: undefined", which is what it says when it lands in the
      // middle of a page). The real `app.codec.read` goes through `File.slice().
      // arrayBuffer()`, which allocates a fresh buffer, so production is fine and this
      // was the fixture lying about the contract.
      read: async (off, len) => bytes.slice(off, off + (len ?? bytes.length - off)),
      begin: async (variables, storageTypes, o) => {
        out.variables = variables;
        out.storageTypes = storageTypes;
        out.opts = o ?? null;
      },
      batch: async (cols) => { out.batches.push(cols); },
      progress: async () => {},
    },
  };
  await readParquet(app, { select });

  const columns = {};
  for (const v of out.variables ?? []) columns[v.name] = [];
  for (const b of out.batches) {
    for (const v of out.variables) columns[v.name].push(...Array.from(b[v.name] ?? []));
  }
  return {
    ...out,
    columns,
    types: Object.fromEntries((out.variables ?? []).map((v) => [v.name, v.type])),
    bytes,
  };
}

const skipIfOffline = (t) => {
  if (offline) {
    t.skip(`the pinned Parquet libraries could not be fetched (${offline.slice(0, 60)})`);
    return true;
  }
  return false;
};

// =============================================================================
// The mapping itself — pure, exhaustive, and offline
// =============================================================================

/** One leaf, as the footer describes it. */
const leaf = (type, extra = {}) => ({ name: 'c', type, repetition_type: 'OPTIONAL', ...extra });

test('the physical types that arrive as numbers are numeric', () => {
  for (const t of ['BOOLEAN', 'INT32', 'INT64', 'FLOAT', 'DOUBLE']) {
    assert.equal(declaredType(leaf(t)), 'numeric', t);
  }
});

test('the annotations that arrive as a Date are text', () => {
  // The whole reason this mapping cannot come from the spec: all three of these are
  // physically integers, and reading the physical type alone types them numeric — which
  // stores an epoch millisecond count with nothing to say it was ever a time.
  assert.equal(declaredType(leaf('INT32', { converted_type: 'DATE' })), 'string');
  assert.equal(declaredType(leaf('INT64', { converted_type: 'TIMESTAMP_MILLIS' })), 'string');
  assert.equal(declaredType(leaf('INT64', { converted_type: 'TIMESTAMP_MICROS' })), 'string');
  assert.equal(declaredType(leaf('INT64', { logical_type: { type: 'TIMESTAMP', unit: 'NANOS' } })), 'string');
  // The legacy encoding, which carries no annotation at all.
  assert.equal(declaredType(leaf('INT96')), 'string');
});

test('DECIMAL is numeric however it was stored', () => {
  // It arrives already divided by its scale, as a Number, whether the bytes were an
  // INT32, an INT64 or a fixed-length byte array — so the physical type says nothing
  // useful and testing only the common one would miss two thirds of it.
  for (const t of ['INT32', 'INT64', 'FIXED_LEN_BYTE_ARRAY', 'BYTE_ARRAY']) {
    assert.equal(declaredType(leaf(t, { converted_type: 'DECIMAL', scale: 2 })), 'numeric', t);
  }
});

test('the annotations that arrive as a parsed object are text', () => {
  // And `toText` has to JSON-stringify them; `String(v)` would store "[object Object]".
  for (const conv of ['JSON']) {
    assert.equal(declaredType(leaf('BYTE_ARRAY', { converted_type: conv })), 'string', conv);
  }
  for (const lt of ['GEOMETRY', 'GEOGRAPHY']) {
    assert.equal(declaredType(leaf('BYTE_ARRAY', { logical_type: { type: lt } })), 'string', lt);
  }
});

test('text is text, annotated or bare', () => {
  assert.equal(declaredType(leaf('BYTE_ARRAY', { converted_type: 'UTF8' })), 'string');
  assert.equal(declaredType(leaf('BYTE_ARRAY', { converted_type: 'ENUM' })), 'string');
  assert.equal(declaredType(leaf('BYTE_ARRAY', { logical_type: { type: 'STRING' } })), 'string');
  // A bare BYTE_ARRAY: hyparquet decodes it as UTF-8 by default, so text is the faithful
  // reading, not a guess.
  assert.equal(declaredType(leaf('BYTE_ARRAY')), 'string');
  assert.equal(declaredType(leaf('FIXED_LEN_BYTE_ARRAY', { logical_type: { type: 'UUID' } })), 'string');
  // ...but unannotated fixed bytes arrive as raw bytes, which are not a number.
  assert.equal(declaredType(leaf('FIXED_LEN_BYTE_ARRAY')), 'string');
});

test('TIME_MILLIS is numeric, because the reader does not convert it', () => {
  // The one that looks like it should be a time and is not: hyparquet has no branch for
  // it, so it arrives as the raw INT32 — milliseconds past midnight. Typing it as text
  // would store "34200000", which is worse than the number it actually is.
  assert.equal(declaredType(leaf('INT32', { converted_type: 'TIME_MILLIS' })), 'numeric');
});

test('unsigned integers are numeric', () => {
  assert.equal(declaredType(leaf('INT32', { converted_type: 'UINT_32' })), 'numeric');
  assert.equal(declaredType(leaf('INT64', { converted_type: 'UINT_64' })), 'numeric');
  assert.equal(
    declaredType(leaf('INT64', { logical_type: { type: 'INTEGER', bitWidth: 64, isSigned: false } })),
    'numeric',
  );
});

test('a flat schema yields its leaves in order', () => {
  const types = schemaTypes({
    schema: [
      { name: 'root', num_children: 3 },
      { name: 'a', type: 'INT32' },
      { name: 'b', type: 'BYTE_ARRAY', converted_type: 'UTF8' },
      { name: 'c', type: 'INT64', converted_type: 'TIMESTAMP_MILLIS' },
    ],
  });
  assert.deepEqual(types.names, ['a', 'b', 'c']);
  assert.deepEqual(types.types, { a: 'numeric', b: 'string', c: 'string' });
});

test('a NESTED schema declares nothing, so the caller falls back to sniffing', () => {
  // Rather than invent a flattening. This reader only ever supported flat files, and a
  // guessed flattening would mean declaring names that `parquetReadObjects` never
  // produces — a schema the host is promised and never receives.
  assert.equal(schemaTypes({
    schema: [
      { name: 'root', num_children: 2 },
      { name: 'a', type: 'INT32' },
      { name: 'group', num_children: 1 },
      { name: 'inner', type: 'INT32' },
    ],
  }), null);
});

test('a duplicate leaf name declares nothing either', () => {
  // Two leaves of the same name cannot be told apart in the object keys hyparquet
  // produces, so there is no honest mapping to make.
  assert.equal(schemaTypes({
    schema: [{ name: 'root', num_children: 2 }, { name: 'x', type: 'INT32' }, { name: 'x', type: 'INT32' }],
  }), null);
});

test('a missing or empty schema declares nothing', () => {
  assert.equal(schemaTypes({}), null);
  assert.equal(schemaTypes({ schema: [] }), null);
  assert.equal(schemaTypes({ schema: [{ name: 'root', num_children: 0 }] }), null);
  assert.equal(schemaTypes(null), null);
});

// =============================================================================
// The mapping, against bytes
// =============================================================================

test('every physical type is declared as what it actually arrives as', async (t) => {
  if (skipIfOffline(t)) return;
  const r = await roundTrip([
    { name: 'i32', data: [1, 2], type: 'INT32' },
    { name: 'i64', data: [10n, 20n], type: 'INT64' },
    { name: 'dbl', data: [1.5, 2.5], type: 'DOUBLE' },
    { name: 'flt', data: [1.5, 2.5], type: 'FLOAT' },
    { name: 'bool', data: [true, false], type: 'BOOLEAN' },
    { name: 'str', data: ['a', 'b'], type: 'STRING' },
  ]);
  assert.deepEqual(r.types, {
    i32: 'numeric', i64: 'numeric', dbl: 'numeric', flt: 'numeric', bool: 'numeric', str: 'string',
  });
  // And the values land, including the two that are not plain numbers in JS.
  assert.deepEqual([...r.columns.i64], [10, 20], 'a BigInt column');
  assert.deepEqual([...r.columns.bool], [1, 0], 'a boolean column, as 1/0');
  assert.deepEqual(r.columns.str, ['a', 'b']);
});

test('a TIMESTAMP column is text, not a number — it arrives as a Date', async (t) => {
  if (skipIfOffline(t)) return;
  // The case a mapping written from the Parquet spec gets wrong: TIMESTAMP_MILLIS is
  // physically an INT64, so "it is an integer" is the obvious and incorrect reading.
  // hyparquet converts it to a Date, and `Number(aDate)` would have stored an epoch
  // millisecond count with no indication that it was ever a time.
  const r = await roundTrip([
    { name: 'when', data: [new Date('2020-01-02T03:04:05Z'), new Date('2021-06-07T08:09:10Z')], type: 'TIMESTAMP' },
  ]);
  assert.equal(r.types.when, 'string');
  assert.deepEqual(r.columns.when, ['2020-01-02T03:04:05.000Z', '2021-06-07T08:09:10.000Z'],
    'carried as ISO text, which is the engine’s temporal convention');
});

test('a JSON column is text, and not the string "[object Object]"', async (t) => {
  if (skipIfOffline(t)) return;
  // hyparquet hands back a PARSED value for a JSON-annotated column, so the old
  // `String(v)` would have stored "[object Object]" for every row. Nothing about the
  // Parquet spec hints at that; it came out of probing the library.
  const r = await roundTrip([
    { name: 'blob', data: [{ a: 1 }, { b: [2, 3] }], type: 'JSON' },
  ]);
  assert.equal(r.types.blob, 'string');
  assert.deepEqual(r.columns.blob, ['{"a":1}', '{"b":[2,3]}']);
});

// =============================================================================
// The bug: a sample is not the file
// =============================================================================

test('a column whose FIRST row group is all null is still typed from the footer', async (t) => {
  if (skipIfOffline(t)) return;
  // THE BUG. Sniffing saw no value in the first row group, so `sawValue` stayed false and
  // the column became text — and then every number in the later groups was stored as a
  // string, in a file that said DOUBLE in its footer all along.
  const data = [null, null, 3.5, 4.5];
  const r = await roundTrip(
    [{ name: 'k', data: [1, 2, 3, 4], type: 'INT32' }, { name: 'v', data, type: 'DOUBLE' }],
    { rowGroupSize: 2 },
  );
  assert.ok(r.batches.length > 1, 'the fixture did not produce more than one row group');
  assert.equal(r.types.v, 'numeric', 'typed from a sample rather than from the footer');
  const got = [...r.columns.v].map((x) => (Number.isNaN(x) ? null : x));
  assert.deepEqual(got, [null, null, 3.5, 4.5]);
});

test('the schema reaches the host BEFORE any row group is read', async (t) => {
  if (skipIfOffline(t)) return;
  // Declaring rather than sniffing means `begin` no longer waits for data — so an empty
  // file keeps its columns instead of arriving as a dataset with none, and the host can
  // route on the real width immediately.
  const r = await roundTrip([{ name: 'a', data: [], type: 'INT32' }, { name: 's', data: [], type: 'STRING' }]);
  assert.deepEqual(r.variables.map((v) => v.name), ['a', 's']);
  assert.deepEqual(r.types, { a: 'numeric', s: 'string' });
  assert.equal(r.batches.length, 0, 'an empty batch was sent');
});

// =============================================================================
// The catalogue agrees with the import, which is the silent failure
// =============================================================================

test('the catalogue names exactly what the import declares', async (t) => {
  if (skipIfOffline(t)) return;
  const W = await writer();
  const columnData = [
    { name: 'id', data: [1, 2], type: 'INT32' },
    { name: 'label', data: ['x', 'y'], type: 'STRING' },
    { name: 'when', data: [new Date(0), new Date(1)], type: 'TIMESTAMP' },
  ];
  const bytes = new Uint8Array(W.parquetWriteBuffer({ columnData }));
  const app = {
    codec: {
      loadAsset: async (name) => { lastAssetSource = await assetSource(name); return lastAssetSource; },
      size: async () => bytes.length,
      read: async (off, len) => bytes.slice(off, off + (len ?? bytes.length - off)),
      begin: async () => {}, batch: async () => {}, progress: async () => {},
    },
  };
  const cat = await catalogParquet(app, {});
  const r = await roundTrip(columnData);
  assert.deepEqual(cat.sources ? cat.sources[0].variables.map((v) => v.name) : cat.variables.map((v) => v.name),
    r.variables.map((v) => v.name));
  assert.equal(cat.rowCount ?? cat.sources?.[0]?.rowCount, 2);
});

test('a selection narrows what is DECLARED as well as what is read', async (t) => {
  if (skipIfOffline(t)) return;
  // Declaring the full footer while reading a subset would promise the host columns that
  // never arrive — an ingest whose first batch is missing half its schema.
  const r = await roundTrip([
    { name: 'keep', data: [1, 2], type: 'INT32' },
    { name: 'drop', data: ['a', 'b'], type: 'STRING' },
    { name: 'also', data: [3.5, 4.5], type: 'DOUBLE' },
  ], { select: ['keep', 'also'] });
  assert.deepEqual(r.variables.map((v) => v.name), ['keep', 'also']);
  assert.deepEqual(Object.keys(r.batches[0]).sort(), ['also', 'keep']);
  assert.deepEqual([...r.columns.also], [3.5, 4.5]);
});

test('a selection matching nothing says so rather than importing an empty schema', async (t) => {
  if (skipIfOffline(t)) return;
  await assert.rejects(
    () => roundTrip([{ name: 'a', data: [1], type: 'INT32' }], { select: ['nope'] }),
    /none of the selected variables/,
  );
});
