/**
 * @file ingest-one-way.test.mjs
 * `DataStore#load` — the one way data enters the engine from outside it.
 *
 * ## What this replaced
 *
 * Six routes, of which exactly one recorded what the shared table budget needs. The owner
 * asked the question that settled it: *"three paths to data ingest means three places to
 * watch for bugs and three feature sets that can drift."* The count was six and the drift
 * was already there — see the table at the top of `core/ingest.js`.
 *
 * ## What is actually being guarded here
 *
 * Not "it loads data" — the suite has plenty of that. These are the properties the
 * consolidation exists to make true of EVERY caller rather than of one:
 *
 *  - whole columns reach the engine in SLICES, because the ceiling is DuckDB's checkpoint
 *    and its failure is fatal to the whole database, not just to the import;
 *  - the slices rejoin exactly, which is the thing a batching bug breaks silently;
 *  - a table that was built is RECORDED, or the next import's budget check passes when it
 *    should not have;
 *  - column names are cleaned on the way in, which the old ingress claimed to do for
 *    every route and did for one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { DataStore } = await import('../core/data-store.js');

/** An Arrow-ish result: `numRows`, `get(i)`, `toArray()`. */
const rows = (list) => ({
  numRows: list.length,
  get: (i) => list[i],
  toArray: () => list,
  schema: { fields: [] },
});

/**
 * A recording stub of the engine surface the ingest touches.
 *
 * Deliberately dumb about the ROUTE: `planIngest` returns whatever it is told rather than
 * computing a verdict, so a routing bug cannot pass by being shared with the stub.
 */
function stubEngine({ wide = false } = {}) {
  const batches = [];
  const noted = [];
  const sql = [];
  return {
    batches,
    noted,
    sql,
    async planIngest(variables, rowCount, { declaredWide = false } = {}) {
      return { wide: wide || !!declaredWide, overBudget: false, estBytes: 0, canStream: true, loadedBytes: 0 };
    },
    noteTableBytes(table, bytes) { noted.push([table, bytes]); },
    forgetTable() {},
    get loadedTableBytes() { return 0; },
    get canStreamOutOfCore() { return true; },
    async beginStreamIngest() {
      return {
        addBatch: async (cols) => { batches.push(cols); },
        finish: async () => {},
      };
    },
    async cleanupStreamIngest() {},
    async openParquetWriter() {
      return {
        writeRowGroup: (columnData) => { batches.push(columnData); },
        drain: async () => {},
        finalize: async (name) => `opfs://${name}`,
        abort: async () => {},
      };
    },
    async dropRegisteredFile() {},
    async registerParquetFile() {},
    async replaceTable() {},
    async replaceTableFromParquet() {},
    async queryToParquet() { return new Uint8Array([1, 2, 3]); },
    async readOpfsFile() { return new Uint8Array([1, 2, 3]); },
    async query(text) {
      sql.push(String(text).replace(/\s+/g, ' ').slice(0, 120));
      if (/^DESCRIBE/i.test(text)) return rows([]);
      if (/min\(/i.test(text)) return rows([{ m: 1 }]);
      if (/count\(\*\)/i.test(text)) return rows([{ n: 1 }]);
      return rows([]);
    },
  };
}

const bus = { emit() {}, on() {}, off() {} };
const newStore = (engine) => new DataStore(bus, engine, { id: 'd1', name: 'T' });

/** `n` rows of `w` numeric columns, where `v<c>` row `i` holds `i * 1000 + c` — so any
 * misplaced slice or swapped column is visible in the value itself. */
function grid(n, w) {
  const variables = Array.from({ length: w }, (_, c) => ({ name: `v${c}`, type: 'numeric' }));
  const columns = {};
  for (let c = 0; c < w; c++) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i * 1000 + c;
    columns[`v${c}`] = a;
  }
  return { variables, columns };
}

/** Stitch the recorded batches back into whole columns. */
function stitch(batches, variables) {
  const out = {};
  for (const v of variables) out[v.name] = [];
  for (const b of batches) {
    for (const v of variables) out[v.name].push(...Array.from(b[v.name] ?? []));
  }
  return out;
}

// =============================================================================
// Whole columns arrive in slices
// =============================================================================

test('a payload bigger than the batch budget arrives in more than one piece', async () => {
  // THE POINT OF THE EXERCISE. `app.data.create` used to hand DuckDB one Arrow table: the
  // whole dataset as Arrow buffers, again as one contiguous IPC array, and again in the
  // wasm heap, with no budget check. A plugin's own JS heap is its business; that table
  // reaching the engine in one piece is not.
  const engine = stubEngine();
  const { variables, columns } = grid(60_000, 30); // 1.8M cells against a 1M budget
  await newStore(engine).loadDataset({ variables, columns, mode: 'replace' });
  assert.ok(engine.batches.length > 1, `sent it in ${engine.batches.length} batch(es)`);
  for (const b of engine.batches) {
    assert.ok(b.v0.length * 30 <= 1_000_000, `a batch of ${b.v0.length} x 30 is over budget`);
  }
});

test('a small payload is still one batch — slicing is not a tax on normal data', async () => {
  const engine = stubEngine();
  const { variables, columns } = grid(50, 3);
  await newStore(engine).loadDataset({ variables, columns, mode: 'replace' });
  assert.equal(engine.batches.length, 1);
});

test('the slices rejoin EXACTLY, which is what a batching bug breaks silently', async () => {
  // The failure mode: an off-by-one at the seam, or a column read by output index after a
  // gap, produces a dataset that loads cleanly and holds the wrong numbers.
  const engine = stubEngine();
  const { variables, columns } = grid(60_000, 30);
  await newStore(engine).loadDataset({ variables, columns, mode: 'replace' });
  const got = stitch(engine.batches, variables);
  assert.equal(got.v0.length, 60_000, 'rows were lost or duplicated');
  for (const [i, c] of [[0, 0], [1, 29], [33_332, 7], [33_333, 7], [59_999, 29]]) {
    assert.equal(got[`v${c}`][i], i * 1000 + c, `row ${i} of v${c} is wrong`);
  }
});

test('the batch budget is in CELLS, so width decides the row count', async () => {
  // A fixed row count is fine at ten columns and fatal at three thousand.
  const narrow = stubEngine();
  await newStore(narrow).loadDataset({ ...grid(400_000, 2), mode: 'replace' });
  const wide = stubEngine();
  await newStore(wide).loadDataset({ ...grid(400_000, 200), mode: 'replace' });
  assert.ok(narrow.batches[0].v0.length > wide.batches[0].v0.length,
    'a wide payload must send smaller batches than a narrow one');
});

// =============================================================================
// The accounting line that had one caller
// =============================================================================

test('a table built from whole columns is recorded in the budget', async () => {
  // Four of the five routes into the engine built a real table and never registered its
  // cost, so `loadedTableBytes` under-reported and the NEXT import's budget check passed
  // when it should not have — the failure being a FATAL checkpoint that also destroys
  // whatever had already loaded.
  const engine = stubEngine();
  await newStore(engine).loadDataset({ ...grid(1000, 4), mode: 'replace' });
  assert.equal(engine.noted.length, 1, 'the ingested table was not recorded');
  const [, bytes] = engine.noted[0];
  // 8 bytes of row id + 4 numeric columns x 8, per row.
  assert.equal(bytes, 1000 * (8 + 4 * 8));
});

test('the out-of-core route records NOTHING, because it holds nothing', async () => {
  // A wide source is an OPFS Parquet file DuckDB only reads: it never enters the buffer
  // pool or the checkpoint this budget exists for. Counting it would route later imports
  // out of core for no reason.
  const engine = stubEngine({ wide: true });
  await newStore(engine).loadDataset({ ...grid(1000, 4), mode: 'replace' });
  assert.deepEqual(engine.noted, []);
});

// =============================================================================
// Name cleaning, on every path rather than one
// =============================================================================

test('an unrepresentable character in a column name is cleaned on the way in', async () => {
  // A lone surrogate survives JSON, IndexedDB and a sync hop looking fine, then becomes
  // U+FFFD the first time anything UTF-8 encodes it — so two peers hold different values
  // with nothing reporting a problem. The old ingress said "every route that puts data in
  // a dataset comes through this function" and lived in the one route a file import does
  // NOT take.
  const engine = stubEngine();
  const store = newStore(engine);
  await store.loadDataset({
    variables: [{ name: 'ok', type: 'numeric' }, { name: 'bad\uD800', type: 'numeric' }],
    columns: { ok: [1], 'bad\uD800': [2] },
    mode: 'replace',
  });
  const names = (store.getHistory().applied ?? [])
    .filter((o) => o.src)[0].src.meta.map((m) => m.name);
  assert.deepEqual(names, ['ok', 'bad�']);
  // ...and the BATCH must be keyed by the cleaned name too, or the ingest writes a column
  // the schema never declared.
  assert.deepEqual(Object.keys(engine.batches[0]).sort(), ['bad�', 'ok']);
});

// =============================================================================
// The shapes `loadDataset` has always accepted
// =============================================================================

test('mismatched column lengths are still refused', async () => {
  await assert.rejects(
    () => newStore(stubEngine()).loadDataset({
      variables: [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }],
      columns: { a: [1, 2], b: [1] },
      mode: 'replace',
    }),
    /equal length/,
  );
});

test('an empty dataset still gets its schema to the engine', async () => {
  // Zero rows is a legitimate dataset — a blank project, an extract that matched nothing.
  // The ingest creates the table on its FIRST batch, so sending none would leave no table
  // at all rather than an empty one.
  const engine = stubEngine();
  await newStore(engine).loadDataset({
    variables: [{ name: 'a', type: 'numeric' }, { name: 's', type: 'string' }],
    columns: { a: [], s: [] },
    mode: 'replace',
  });
  assert.equal(engine.batches.length, 1);
  assert.deepEqual(Object.keys(engine.batches[0]).sort(), ['a', 's']);
  assert.equal(engine.batches[0].a.length, 0);
});

test('join mode still records a join, not a second base', async () => {
  // `loadDataset` carries three modes and the consolidation had to keep all of them:
  // `replace` resets, `append` stacks rows, `join` adds columns by key. A `join` that
  // landed as a `load` would silently discard the data it was joining onto.
  const engine = stubEngine();
  const store = newStore(engine);
  await store.loadDataset({ ...grid(3, 2), mode: 'replace' });
  await store.loadDataset({
    variables: [{ name: 'k', type: 'numeric' }, { name: 'extra', type: 'numeric' }],
    columns: { k: [0, 1000, 2000], extra: [7, 8, 9] },
    mode: 'join',
    joinKey: { left: 'v0', right: 'k' },
  });
  const types = (store.getHistory().applied ?? []).filter((o) => o.src).map((o) => o.type);
  assert.deepEqual(types, ['load', 'join']);
});

test('append mode stacks rather than replacing', async () => {
  const engine = stubEngine();
  const store = newStore(engine);
  await store.loadDataset({ ...grid(3, 2), mode: 'replace' });
  await store.loadDataset({ ...grid(2, 2), mode: 'append' });
  const types = (store.getHistory().applied ?? []).filter((o) => o.src).map((o) => o.type);
  assert.deepEqual(types, ['load', 'append']);
});

// =============================================================================
// Provenance, which three of six routes could not carry
// =============================================================================

test('`producedBy` reaches the op, after months of going nowhere', async () => {
  // #160 records WHICH run in this project made the data. `createWithData` accepted it,
  // `loadDataset` passed it, and `#addSourceOp` destructured four fields and not that one
  // — so the Run R script reverse bridge wrote the run id into a void from the day it
  // shipped. One producer, zero readers, no test. Found by counting the ingest routes.
  const engine = stubEngine();
  const store = newStore(engine);
  await store.loadDataset({
    ...grid(2, 1),
    mode: 'replace',
    producedBy: { kind: 'rscript', runId: 'r7', frame: 'out' },
  });
  const op = (store.getHistory().applied ?? []).find((o) => o.src);
  assert.deepEqual(op.producedBy, { kind: 'rscript', runId: 'r7', frame: 'out' });
});

test('and it survives the save-and-reopen a project does', async () => {
  // A field threaded through the ingest but not through restore is a field that vanishes
  // the first time someone closes the project — which is the same failure in a slower
  // disguise.
  const store = newStore(stubEngine());
  await store.loadDataset({
    ...grid(2, 1), mode: 'replace', producedBy: { kind: 'rscript', runId: 'r7' },
  });
  const saved = await store.exportState({ includeParquet: true });
  const fresh = newStore(stubEngine());
  await fresh.restoreState({ ops: saved.ops });
  const op = (fresh.getHistory().applied ?? []).find((o) => o.src);
  assert.deepEqual(op.producedBy, { kind: 'rscript', runId: 'r7' });
});
