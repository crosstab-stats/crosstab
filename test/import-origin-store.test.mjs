/**
 * @file import-origin-store.test.mjs
 * The filename on the op, through the real DataStore — recorded, saved, restored.
 *
 * Its sibling (`import-origin.test.mjs`) checks what the surfaces PRINT given an op that
 * already carries an origin. This checks the half those tests have to assume: that
 * `loadDataset` actually puts it there, and that a save-and-reopen brings it back. Those
 * are three separate code paths — `#createSource`, `exportState`, `restoreState` — and a
 * field threaded through two of three is a field that vanishes the first time someone
 * closes a project.
 *
 * ## Why a stub engine rather than DuckDB
 *
 * DuckDB is a multi-megabyte cross-origin WASM worker; node has no DOM to host it, and
 * headless Chrome stalls on it under virtual time (tried, 2026-11-17). But DuckDB is
 * *storage* here, and none of what is under test is storage: the origin never reaches
 * SQL, which is exactly the property that makes it metadata rather than a column. So the
 * engine is stubbed at the narrow surface the load path touches, and the DataStore under
 * test is the real one.
 *
 * The stub is deliberately dumb — it records the SQL it is handed and answers the two
 * shapes the row-id bake reads back. If the load path grows a new engine call, this
 * fails rather than silently passing.
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

function stubEngine() {
  const sql = [];
  return {
    sql,
    async replaceTable(table, cols) { sql.push(`replaceTable ${table}`); this.cols = cols; },
    async replaceTableFromParquet(table) { sql.push(`replaceTableFromParquet ${table}`); },
    async query(text) {
      sql.push(String(text).replace(/\s+/g, ' ').slice(0, 60));
      // DESCRIBE: no row-id column yet, so the store bakes one.
      if (/^DESCRIBE/i.test(text)) return rows([]);
      if (/min\(/i.test(text)) return rows([{ m: 1 }]);
      // `rederive` counts the view it just created; a store with no row count believes
      // it holds no data and stops.
      if (/count\(\*\)/i.test(text)) return rows([{ n: 3 }]);
      return rows([]);
    },
    async queryToParquet() { return new Uint8Array([1, 2, 3]); },
    async readOpfsFile() { return new Uint8Array([1, 2, 3]); },
    async registerParquetFile() {},
    async dropRegisteredFile() {},
    async openParquetWriter() { return { write: async () => {}, close: async () => {} }; },
    async beginStreamIngest() { return { batch: async () => {}, finish: async () => {} }; },
    async cleanupStreamIngest() {},
  };
}

/** getHistory() returns the timeline envelope; the data steps are its `applied` list. */
const stepsOf = (store) => store.getHistory().applied ?? [];

const bus = { emit() {}, on() {}, off() {} };
const newStore = (id = 'd1') => new DataStore(bus, stubEngine(), { id, name: 'T' });

const DATA = {
  variables: [{ name: 'age', type: 'numeric' }, { name: 'pay', type: 'numeric' }],
  columns: { age: [31, 42, 55], pay: [100, 200, 300] },
};

test('a single-file replace records the filename and no provenance column', async () => {
  // The exact shape of the commonest import: no `source` tag — so no `source_file`
  // column is added to the data — and the filename as `origin`. Before this, that
  // combination recorded the filename NOWHERE, which is the bug.
  const store = newStore();
  await store.loadDataset({ ...DATA, mode: 'replace', source: undefined, origin: 'GSS-2022.sav' });
  const load = stepsOf(store).find((s) => s.type === 'load');
  assert.ok(load, 'no load op');
  assert.equal(load.src.origin, 'GSS-2022.sav');
  assert.equal(load.src.label, null, 'no provenance column on a single-file replace');
});

test('the origin never reaches the data — it is metadata, not a column', async () => {
  // The whole reason it is a separate field. If it ever appears in the SQL, it has
  // become a column, and every row of someone's data grew a constant.
  const engine = stubEngine();
  const store = new DataStore(bus, engine, { id: 'd1', name: 'T' });
  await store.loadDataset({ ...DATA, mode: 'replace', origin: 'GSS-2022.sav' });
  assert.ok(!engine.sql.some((s) => s.includes('GSS-2022')), engine.sql.join(' | '));
  assert.ok(!Object.keys(engine.cols ?? {}).includes('source_file'));
});

test('it survives the save and reopen a project does', async () => {
  const store = newStore();
  await store.loadDataset({ ...DATA, mode: 'replace', origin: 'GSS-2022.sav' });
  const state = await store.exportState({ includeParquet: true });

  // What a saved project carries.
  const saved = state.ops ? state.ops : state;
  const savedLoad = (Array.isArray(saved) ? saved : saved.ops ?? []).find((o) => o.type === 'load');
  assert.equal(savedLoad?.src?.origin, 'GSS-2022.sav', 'dropped on the way into the file');

  // ...and what comes back out.
  const reopened = newStore('d2');
  await reopened.restoreState(state);
  const load = stepsOf(reopened).find((s) => s.type === 'load');
  assert.equal(load?.src?.origin, 'GSS-2022.sav', 'dropped on the way back');
});

test('a stacked import keeps BOTH — the column tag and the filename', async () => {
  // They are different things and an append needs both: `label` identifies the rows in
  // the `source_file` column, `origin` says which file they came out of. They are
  // usually the same string, which is exactly why conflating them went unnoticed.
  const store = newStore();
  await store.loadDataset({ ...DATA, mode: 'replace', source: 'wave1', origin: 'wave1.csv' });
  await store.loadDataset({ ...DATA, mode: 'append', source: 'wave2', origin: 'wave2.csv' });
  const steps = stepsOf(store).filter((s) => s.type === 'load' || s.type === 'append');
  assert.deepEqual(steps.map((s) => s.src.label), ['wave1', 'wave2']);
  assert.deepEqual(steps.map((s) => s.src.origin), ['wave1.csv', 'wave2.csv']);
});

test('data that came from no file is unchanged — null, not a guess', async () => {
  // A plugin's data.create, a derived dataset, a blank sheet: there is no filename, and
  // inventing one would put a lie in the syntax view.
  const store = newStore();
  await store.loadDataset({ ...DATA, mode: 'replace' });
  const load = stepsOf(store).find((s) => s.type === 'load');
  assert.equal(load.src.origin, null);
});

test('the importer that read the file is recorded too, and survives the round trip', async () => {
  // Better evidence than the name: a .txt opened by the CSV codec is comma-delimited,
  // and nothing about the filename says so.
  const store = newStore();
  await store.loadDataset({ ...DATA, mode: 'replace', origin: 'survey.txt', importer: 'csv' });
  assert.equal(stepsOf(store).find((s) => s.type === 'load').src.importer, 'csv');

  const reopened = newStore('d2');
  await reopened.restoreState(await store.exportState({ includeParquet: true }));
  assert.equal(stepsOf(reopened).find((s) => s.type === 'load').src.importer, 'csv');
});

test('the importer never reaches the data either', async () => {
  const engine = stubEngine();
  const store = new DataStore(bus, engine, { id: 'd1', name: 'T' });
  await store.loadDataset({ ...DATA, mode: 'replace', origin: 'survey.txt', importer: 'csv' });
  assert.ok(!engine.sql.some((s) => /survey\.txt|'csv'/.test(s)), engine.sql.join(' | '));
});
