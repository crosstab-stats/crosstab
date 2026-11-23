/**
 * @file ingest-route-measure.mjs
 * Does the ingest route decision need a WIDTH term, or is cells enough?
 *
 * ## The question, and why it was reopened
 *
 * `isWideDataset` routes on CELLS — `ceil(cols*rows/4e6) > 8`. Width-routing was tried and
 * rejected in e85f8e4, measured at 3,300 columns: 7.3 s / 178 MiB of JS heap through the
 * out-of-core Parquet path against 8.7 s / 121 MiB as a DuckDB table. The table won on
 * memory, so the per-column cost did not justify a width term.
 *
 * That measurement was taken on NUMERIC columns. The import that reopened the question was
 * 99.6% VARCHAR — and a DuckDB table charges 16 bytes per string slot plus a string heap,
 * against 8 flat for a double. So the rejection may hold only for the type it was measured
 * on. That is the whole question: at the SAME width, does text change the answer?
 *
 * ## What it measures
 *
 * One `DataStore#load` per run, through the real ingest, with the route forced by
 * `declaredWide`. Reports wall time, peak JS heap sampled across the run, and DuckDB's own
 * reported memory afterwards — the last because the ceiling this routing exists to respect
 * is the engine's, not the page's, and the two are different pools.
 *
 * ## How to run it
 *
 * ONE RUN PER PAGE LOAD, which is the discipline the earlier numbers were taken with: a
 * second import in the same session starts from a heap the first one grew and from a
 * database already holding a table, so the two are not comparable. From the console of a
 * freshly loaded app:
 *
 *     const m = await import('/spike/ingest-route-measure.mjs');
 *     await m.measure({ cols: 3300, rows: 2000, type: 'string', route: 'table' });
 *
 * It appends to `localStorage.ct_route_measure`; `m.report()` prints the table once every
 * combination has been run. Reload between runs.
 *
 * ## What it found, 2026-11-23 (desktop Chromium, 3,300 x 2,000)
 *
 *     type     route   time       JS heap peak   engine
 *     numeric  table    6,073 ms   81 MiB         46 MiB
 *     numeric  wide     3,642 ms  200 MiB          1 MiB
 *     string   table   26,651 ms  244 MiB         76 MiB
 *     string   wide     8,188 ms  470 MiB          1 MiB
 *
 * TYPE changes the answer and width does not: at identical width and cell count, text costs
 * the table path 4.4x the time and 1.65x the engine memory of numbers. So the suspicion that
 * e85f8e4 had measured the wrong type was right — and the conclusion drawn from it, that a
 * width term was missing, was wrong. The type-aware rule already exists beside the cells
 * rule (`estimateTableBytes`/`exceedsTableBudget`), it catches the text case, and the cells
 * rule's only distinct contribution is to route the CHEAPEST case out of core. The full
 * reasoning and the recommendation are in TODO.md under "Import machinery", step 4.
 *
 * Also worth keeping: `rowGroupFor(3300) * 3300` is 4.0M cells, so the wide path's JS peak is
 * bounded by ONE ROW GROUP whatever the file's size — the 200/470 MiB figures would not grow
 * for a file ten times larger, while the table path's engine memory is cumulative across
 * every import in the session. The two ceilings differ in kind, not just in size.
 */

const KEY = 'ct_route_measure';

/** Peak `usedJSHeapSize` over the life of a run, sampled. Chrome-only; null elsewhere. */
function heapSampler() {
  const mem = () => performance.memory?.usedJSHeapSize ?? null;
  const start = mem();
  if (start == null) return { stop: () => ({ startMiB: null, peakMiB: null }) };
  let peak = start;
  const t = setInterval(() => { peak = Math.max(peak, mem() ?? peak); }, 50);
  return {
    stop: () => {
      clearInterval(t);
      peak = Math.max(peak, mem() ?? peak);
      return { startMiB: Math.round(start / 1048576), peakMiB: Math.round(peak / 1048576) };
    },
  };
}

/** What DuckDB says it is holding, which is the pool the routing exists to protect. */
async function engineMiB(duckdb) {
  try {
    const t = await duckdb.query('SELECT sum(memory_usage_bytes) AS b FROM duckdb_memory()');
    const b = Number(t.toArray()[0]?.toJSON()?.b ?? 0);
    return Math.round(b / 1048576);
  } catch {
    return null;
  }
}

/**
 * Run one ingest and record it.
 *
 * @param {object} spec
 * @param {number} spec.cols
 * @param {number} spec.rows
 * @param {'numeric'|'string'} spec.type - every column is this
 * @param {'table'|'wide'} spec.route - forced via `declaredWide`
 */
export async function measure({ cols = 3300, rows = 2000, type = 'numeric', route = 'table' } = {}) {
  const ct = globalThis.crosstab;
  if (!ct) throw new Error('run this from the app page');
  const dm = ct.datasets;
  // A fresh dataset, so the load is a `replace` into something empty and the figures are
  // not the previous dataset's.
  const id = await dm.createWithData({
    name: `route-${route}-${type}`,
    variables: [{ name: 'seed', type: 'numeric' }],
    columns: { seed: new Float64Array([0]) },
    activate: true,
  });
  const store = dm.active;

  const variables = Array.from({ length: cols }, (_, c) => ({ name: `v${c}`, type }));
  const storageTypes = Object.fromEntries(variables.map((v) => [v.name, type]));

  // Batches are generated on the fly rather than built up front: materialising the whole
  // payload first would put it in the peak, and what is under test is the INGEST's cost,
  // not the generator's.
  const BATCH = Math.max(1, Math.floor(1_000_000 / cols));
  const batchFor = (n) => {
    const out = {};
    for (let c = 0; c < cols; c++) {
      if (type === 'numeric') {
        const a = new Float64Array(n);
        for (let i = 0; i < n; i++) a[i] = c + i;
        out[`v${c}`] = a;
      } else {
        const a = new Array(n);
        // Distinct values, and long enough to land on DuckDB's string heap rather than
        // inline in the 16-byte slot — which is the cost the question is about.
        for (let i = 0; i < n; i++) a[i] = `c${c}r${i}_padpadpadpad`;
        out[`v${c}`] = a;
      }
    }
    return out;
  };

  const sampler = heapSampler();
  const t0 = performance.now();
  await store.load({
    mode: 'replace',
    variables,
    storageTypes,
    rowCount: rows,
    declaredWide: route === 'wide',
    source: 'route-measure',
    stream: async (batch) => {
      for (let off = 0; off < rows; off += BATCH) {
        // eslint-disable-next-line no-await-in-loop -- one batch in flight, as in a real read
        await batch(batchFor(Math.min(BATCH, rows - off)));
      }
    },
  });
  const ms = Math.round(performance.now() - t0);
  const heap = sampler.stop();
  const engine = await engineMiB(ct.duckdb);

  const row = {
    cols, rows, type, route, ms, ...heap, engineMiB: engine,
    cells: cols * rows,
    budgetMiB: Math.round((ct.duckdb.loadedTableBytes ?? 0) / 1048576),
  };
  const all = JSON.parse(localStorage.getItem(KEY) || '[]');
  all.push(row);
  localStorage.setItem(KEY, JSON.stringify(all));
  // eslint-disable-next-line no-console -- this is a measurement harness
  console.log('[route-measure]', row);
  return row;
}

/** Everything recorded so far, newest last. */
export function results() {
  return JSON.parse(localStorage.getItem(KEY) || '[]');
}

/** Print the comparison the question actually asks: table vs wide, per type. */
export function report() {
  const all = results();
  const pick = (type, route) => all.filter((r) => r.type === type && r.route === route).pop() ?? null;
  const lines = [];
  for (const type of ['numeric', 'string']) {
    const t = pick(type, 'table');
    const w = pick(type, 'wide');
    if (!t || !w) { lines.push(`${type}: incomplete (need both routes)`); continue; }
    lines.push(
      `${type.padEnd(8)} table ${String(t.ms).padStart(6)}ms  heap ${String(t.peakMiB).padStart(4)}MiB  engine ${String(t.engineMiB).padStart(4)}MiB`
      + ` | wide ${String(w.ms).padStart(6)}ms  heap ${String(w.peakMiB).padStart(4)}MiB  engine ${String(w.engineMiB).padStart(4)}MiB`,
    );
  }
  // eslint-disable-next-line no-console -- this is a measurement harness
  console.log(lines.join('\n'));
  return lines;
}

/** Start over. */
export function reset() {
  localStorage.removeItem(KEY);
}
