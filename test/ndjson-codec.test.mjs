/**
 * @file ndjson-codec.test.mjs
 * The JSON Lines reader, after its typing moved into the host's shared ingest.
 *
 * ## What it used to do
 *
 * It inferred the whole schema from the FIRST object in the file — `typeof row[k] ===
 * 'number'` on one record decided the column for every record — and coerced the rest to
 * that guess. One string in the first object and a column of ten million numbers imported
 * as text; one number in the first object and every later `"N/A"` became `NaN` with
 * nothing said. It detected no missing-value codes, and it never routed a large file out
 * of core, so a multi-gigabyte file built a DuckDB table however big it was.
 *
 * Those are not three bugs in this reader. They are one structural fact — typing, code
 * detection and width routing are properties of tabular data, not of newline-delimited
 * JSON — and this file is mostly about what the format gets for free now that the host
 * owns them: exact typing over every record, the NA/PS pass, cell-sized batches, and the
 * out-of-core route.
 *
 * What stays genuinely about this format is here too: there is no header row, so a key may
 * first appear in the last object in the file and must still become a column; and the
 * values are real JS values, so a JSON `true` must not become the number 1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { readNdjson } = await import('../plugins/builtin-ndjson-codec/index.js');

/**
 * Run the codec over `text`, handing it `chunk` bytes at a time.
 *
 * @param {string} text the file
 * @param {object} [opts]
 * @param {number} [opts.chunk] bytes per read — small values force boundary cases
 * @param {string[]|null} [opts.accept] what the host answers when asked for missing codes;
 *   `null` means the host does not implement the verb at all (the older-host path)
 */
async function run(text, { chunk = 1 << 20, accept = [] } = {}) {
  const bytes = new TextEncoder().encode(text);
  const out = { batches: [], variables: null, rowCount: null, wide: null, proposals: [] };
  const app = {
    codec: {
      size: async () => bytes.length,
      read: async (off, len) => bytes.subarray(off, off + Math.min(len, chunk)),
      begin: async (variables, storageTypes, opts) => {
        out.variables = variables;
        out.storageTypes = storageTypes;
        out.rowCount = opts?.rowCount ?? null;
        out.wide = !!opts?.wide;
        out.missingCodes = opts?.missingCodes ?? null;
      },
      progress: async () => {},
      batch: async (cols) => { out.batches.push(cols); },
      ...(accept === null ? {} : {
        missingCodes: async (proposal) => { out.proposals.push(proposal); return accept; },
      }),
    },
  };
  await readNdjson(app, {});

  // Stitch the batches back into whole columns, which is what the host does.
  const columns = {};
  for (const v of out.variables ?? []) columns[v.name] = [];
  for (const b of out.batches) {
    for (const v of out.variables) columns[v.name].push(...Array.from(b[v.name]));
  }
  return { ...out, columns, types: Object.fromEntries((out.variables ?? []).map((v) => [v.name, v.type])) };
}

const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

// =============================================================================
// Typing over the whole file, which is the bug
// =============================================================================

test('a type is decided by every record, not by the first one', async () => {
  // THE BUG. The first object says `x` is a number, so the old reader typed the column
  // numeric and turned the "N/A" in the last record into NaN — losing the only thing that
  // distinguished "we did not measure it" from "we measured zero".
  const r = await run(lines({ x: 1 }, { x: 2 }, { x: 'N/A' }));
  assert.equal(r.types.x, 'string', 'one non-number makes the column text');
  assert.deepEqual(r.columns.x, ['1', '2', 'N/A']);
});

test('and a late number does not rescue a column the first record made text', async () => {
  // The mirror image, and it must NOT change: all-or-nothing is the rule that keeps a
  // column with one sentinel in it out of the numeric bucket.
  const r = await run(lines({ x: 'N/A' }, { x: 1 }, { x: 2 }));
  assert.equal(r.types.x, 'string');
});

test('a JSON true is text, not the number 1', async () => {
  // `Number(true)` is 1, so the shared text rule would have typed a boolean column
  // numeric and stored 1/0. JSON carries its own types and a boolean is not a number.
  const r = await run(lines({ ok: true }, { ok: false }));
  assert.equal(r.types.ok, 'string');
  assert.deepEqual(r.columns.ok, ['true', 'false']);
});

test('a string column holds strings, whatever the JSON held', async () => {
  // The old reader called String() by hand on this path. The shared ingest does it, so
  // nothing non-string reaches a string column — a real bug if it did, since the store
  // and every exporter downstream assume it.
  const r = await run(lines({ v: 1 }, { v: true }, { v: 'x' }));
  assert.equal(r.types.v, 'string');
  for (const v of r.columns.v) assert.equal(typeof v, 'string', `${v} is not a string`);
});

// =============================================================================
// What the format itself needs: no header row
// =============================================================================

test('a key that first appears in the LAST record still becomes a column', async () => {
  // There is no header, so the schema is not knowable until the file has been read. The
  // old reader took the first object's keys and ignored every field it had not seen.
  const r = await run(lines({ a: 1 }, { a: 2 }, { a: 3, late: 9 }));
  assert.deepEqual(Object.keys(r.types), ['a', 'late']);
  assert.equal(r.types.late, 'numeric');
  // The records that never mentioned it are missing there, not zero.
  assert.deepEqual([...r.columns.late].map((v) => (Number.isNaN(v) ? 'NaN' : v)), ['NaN', 'NaN', 9]);
});

test('keys in a different order are the same columns', async () => {
  // JSON says object key order is not meaningful. A reader that positioned values by each
  // record's own key order would silently transpose the data.
  const r = await run(lines({ a: 1, b: 10 }, { b: 20, a: 2 }));
  assert.deepEqual([...r.columns.a], [1, 2]);
  assert.deepEqual([...r.columns.b], [10, 20]);
});

test('the column order is first appearance, so a well-formed file reads in its own order', async () => {
  const r = await run(lines({ z: 1, a: 2 }, { a: 3, z: 4 }));
  assert.deepEqual(Object.keys(r.types), ['z', 'a']);
});

// =============================================================================
// The missing-code pass, which this format never had
// =============================================================================

test('accepting a code recovers the column as numeric', async () => {
  // The College Scorecard problem, in this format: a column of numbers with a text
  // sentinel in it is unanalysable as text and costs twice the storage.
  const r = await run(lines({ x: 1 }, { x: 'NA' }, { x: 3 }), { accept: ['NA'] });
  assert.equal(r.types.x, 'numeric');
  assert.deepEqual(r.missingCodes, ['NA']);
  assert.equal(r.columns.x[0], 1);
  assert.ok(Number.isNaN(r.columns.x[1]), 'the code became missing, not a value');
  assert.equal(r.columns.x[2], 3);
});

test('the codes are PROPOSED, and only what the host accepts is applied', async () => {
  const r = await run(lines({ x: 1 }, { x: 'NA' }, { x: 'PS' }, { x: 4 }), { accept: [] });
  assert.equal(r.proposals.length, 1, 'asked exactly once');
  const offered = r.proposals[0].candidates.map((c) => c.value).sort();
  assert.deepEqual(offered, ['NA', 'PS']);
  assert.equal(r.types.x, 'string', 'nothing accepted, so nothing changes');
});

test('an accepted code is missing wherever it appears, including in a text column', async () => {
  // The host was asked whether the VALUE means missing and said yes. Striking it out in
  // one column and storing it as data in the next would be incoherent.
  const r = await run(lines({ n: 1, s: 'red' }, { n: 'NA', s: 'NA' }), { accept: ['NA'] });
  assert.equal(r.types.s, 'string');
  assert.deepEqual(r.columns.s, ['red', null]);
});

test('a host with no missing-code verb reads exactly as before', async () => {
  // The older-host path, and the test harness path. It must reproduce untouched typing.
  const r = await run(lines({ x: 1 }, { x: 'NA' }), { accept: null });
  assert.equal(r.types.x, 'string');
  assert.deepEqual(r.missingCodes, []);
});

// =============================================================================
// Storage routing and batching, which this format also never had
// =============================================================================

test('it makes the storage-routing decision at all, on the shared rule', async () => {
  // The decision three of five codecs were not making: this reader declared no `wide`
  // flag, so a multi-gigabyte JSON-lines file built a DuckDB table however big it was.
  // The assertion is deliberately against `isWideDataset` rather than a hard-coded
  // verdict — the point is that one rule decides, so the same file goes the same way
  // whichever reader opened it, and re-tuning the threshold must not need this file
  // edited. (The threshold itself is ~32 million cells and is tested in
  // import-liveness.test.mjs, where it belongs.)
  const { isWideDataset } = await import('../core/plugin-stdlib.js');
  for (const file of [
    lines({ a: 1 }, { a: 2 }),
    lines({ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'z' }),
  ]) {
    const r = await run(file);
    assert.equal(typeof r.wide, 'boolean', 'no routing decision was made');
    assert.equal(r.wide, isWideDataset(r.variables.length, r.rowCount));
  }
});

test('the row count is known by the time the schema is declared', async () => {
  // It is counted in the first pass. The old reader never knew it, so the routing rule
  // had to assume a row count — and assuming is what the shared rule is careful about.
  const r = await run(lines({ a: 1 }, { a: 2 }, { a: 3 }));
  assert.equal(r.rowCount, 3);
});

test('batches are sized by CELLS, so a wide file does not send a huge one', async () => {
  // A fixed row count is fine at ten columns and fatal at three thousand: it is the width
  // that decides what a batch costs.
  const wide = {};
  for (let c = 0; c < 1500; c++) wide[`v${c}`] = c;
  const r = await run(lines(...Array.from({ length: 800 }, () => wide)));
  assert.ok(r.batches.length > 1, 'sent it all in one batch');
  for (const b of r.batches) {
    const rows = b.v0.length;
    assert.ok(rows * 1500 <= 1_000_000, `${rows} rows x 1,500 columns is too big a batch`);
  }
});

// =============================================================================
// The parse itself, which is all that is left of this codec
// =============================================================================

test('a record straddling a chunk boundary is not lost or split', async () => {
  // The source may return short reads, and in the app every read is a postMessage round
  // trip. Feeding it one byte at a time is the same path, taken to its limit.
  const text = lines({ a: 1, s: 'hello, world' }, { a: 2, s: 'x\ny' }, { a: 3, s: '☃' });
  const whole = await run(text);
  const byByte = await run(text, { chunk: 1 });
  assert.deepEqual(byByte.types, whole.types);
  assert.deepEqual(byByte.columns, whole.columns);
  assert.equal(byByte.rowCount, 3);
});

test('a file with no trailing newline keeps its last record', async () => {
  const r = await run(`${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}`);
  assert.equal(r.rowCount, 2);
  assert.deepEqual([...r.columns.a], [1, 2]);
});

test('malformed and non-object lines are skipped, identically on both passes', async () => {
  // The two passes must agree on which lines are rows, or the types belong to one set of
  // rows and the values to another. Skipping has to be deterministic, not best-effort.
  const r = await run(`{"a":1}\nnot json\n[1,2,3]\n\n"a string"\n{"a":2}\n`);
  assert.equal(r.rowCount, 2);
  assert.deepEqual([...r.columns.a], [1, 2]);
});

test('an empty file says so rather than importing nothing', async () => {
  // It used to declare an empty schema and produce a dataset with no columns, which is
  // not something anyone asked for. Same answer as the delimited reader now.
  await assert.rejects(() => run(''), /no columns found/);
  await assert.rejects(() => run('\n\n'), /no columns found/);
});
