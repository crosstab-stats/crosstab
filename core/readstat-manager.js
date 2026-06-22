/**
 * @file readstat-manager.js
 * Host-side controller for the ReadStat WASM worker (see
 * `vendor/readstat/readstat-worker.js`). Reads SPSS/Stata/SAS files in the
 * browser, streaming, with no in-memory size limit — the ingest engine for
 * whole-file imports of multi-GB datasets that OOM under WebR/haven.
 *
 * The worker does the synchronous WASM parsing (it owns `FileReaderSync`); this
 * class is the async front door: it spins the worker up lazily, routes tagged
 * request/response messages, and serialises a stream's `onVariables`/`onBatch`
 * callbacks so the ingester sees them in order.
 *
 * Backpressure note: `ct_parse` runs synchronously in the worker, so batch
 * messages arrive as fast as it parses. The callbacks are chained on a per-request
 * promise queue (so DuckDB inserts stay ordered), but a much slower consumer could
 * let transferred batch buffers pile up. In practice DuckDB ingest keeps pace with
 * parse; if that stops being true for the largest files, add SharedArrayBuffer +
 * Atomics backpressure here (the worker can `Atomics.wait` between batches).
 */

/** File extension (with dot) → ReadStat format key. */
const FORMAT_BY_EXT = {
  '.sav': 'sav',
  '.zsav': 'sav',
  '.por': 'por',
  '.dta': 'dta',
  '.sas7bdat': 'sas7bdat',
  '.xpt': 'xpt',
};

/** All extensions ReadStat can import (for the picker filter). */
export const READSTAT_EXTENSIONS = Object.keys(FORMAT_BY_EXT);

export class ReadStatManager {
  /** @type {Worker|null} */
  #worker = null;
  /** Monotonic request id. */
  #nextId = 1;
  /** id → request record. @type {Map<number, any>} */
  #reqs = new Map();

  /** Map a file name to its ReadStat format key, or null if unsupported. */
  static formatForName(name) {
    const i = String(name).lastIndexOf('.');
    const ext = i >= 0 ? String(name).slice(i).toLowerCase() : '';
    return FORMAT_BY_EXT[ext] ?? null;
  }

  /** Lazily construct the worker (a same-origin ES module worker). */
  #ensure() {
    if (this.#worker) return;
    this.#worker = new Worker(new URL('../vendor/readstat/readstat-worker.js', import.meta.url), {
      type: 'module',
    });
    this.#worker.onmessage = (e) => this.#dispatch(e.data);
    this.#worker.onerror = (e) => {
      const err = new Error(`ReadStat worker error: ${e.message || 'unknown'}`);
      for (const req of this.#reqs.values()) req.reject(err);
      this.#reqs.clear();
    };
  }

  #dispatch(m) {
    const req = this.#reqs.get(m.id);
    if (!req) return;
    switch (m.type) {
      case 'catalog':
        this.#reqs.delete(m.id);
        req.resolve(m);
        break;
      case 'variables':
        req.queue = req.queue.then(() => req.onVariables?.(m.variables, m.storageTypes)).catch(req.fail);
        break;
      case 'batch':
        req.queue = req.queue.then(() => req.onBatch?.(m.columns, m.nrows)).catch(req.fail);
        break;
      case 'done':
        req.queue.then(() => {
          if (this.#reqs.has(m.id)) {
            this.#reqs.delete(m.id);
            req.resolve({ rowCount: m.rowCount });
          }
        });
        break;
      // Write handshake: each step (writeReady / batchDone / writeDone) resolves
      // the one pending step-promise the driver is awaiting.
      case 'writeReady':
      case 'batchDone':
        req.resolve?.(m);
        break;
      case 'writeDone':
        this.#reqs.delete(m.id);
        req.resolve?.(m);
        break;
      case 'error':
        this.#reqs.delete(m.id);
        req.reject(new Error(m.message));
        break;
    }
  }

  /**
   * Read just the variable dictionary (no data rows) — cheap even for a multi-GB
   * file. Used to drive a variable-picker before a full import.
   *
   * @param {Blob} file
   * @param {string} format - ReadStat format key (`'sav'`, `'dta'`, …).
   * @returns {Promise<{rowCount: number, varCount: number, encoding: string, variables: object[]}>}
   */
  catalog(file, format) {
    this.#ensure();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#reqs.set(id, { resolve, reject });
      this.#worker.postMessage({ type: 'catalog', id, file, format });
    });
  }

  /**
   * Stream a file's rows as column batches. `onVariables(variables, storageTypes)`
   * fires once before any batch; `onBatch(columns, nrows)` fires per chunk
   * (`columns` are name→Float64Array|Array). Both may be async and run in order.
   *
   * @param {Blob} file
   * @param {string} format
   * @param {Object} cbs
   * @param {(variables: object[], storageTypes: Object) => any} [cbs.onVariables]
   * @param {(columns: Object, nrows: number) => any} [cbs.onBatch]
   * @param {number} [cbs.rowLimit=-1] - Cap rows read (-1 = all).
   * @param {string[]|null} [cbs.variables=null] - If set, import only these columns.
   * @returns {Promise<{rowCount: number}>}
   */
  stream(file, format, { onVariables, onBatch, rowLimit = -1, variables = null } = {}) {
    this.#ensure();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const req = { resolve, reject, onVariables, onBatch, queue: Promise.resolve() };
      req.fail = (err) => {
        if (this.#reqs.has(id)) {
          this.#reqs.delete(id);
          reject(err);
        }
      };
      this.#reqs.set(id, req);
      this.#worker.postMessage({ type: 'data', id, file, format, rowLimit, variables });
    });
  }

  /**
   * Stream a dataset OUT to a native SPSS/Stata/SAS file, bounded memory at any
   * size: the writer lives in the worker, fed one DuckDB batch at a time, its
   * output streamed to an OPFS file. Returns a Blob (the file).
   *
   * @param {object} ds - A DataStore instance (getVariableMeta/getRows/rowCount/maxOctetLengths).
   * @param {string} format - 'sav' | 'dta' | 'por' | 'xpt'.
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<Blob>}
   */
  async writeDataset(ds, format, onProgress) {
    this.#ensure();
    const id = this.#nextId++;
    const req = {};
    this.#reqs.set(id, req);
    const step = () => new Promise((resolve, reject) => { req.resolve = resolve; req.reject = reject; });
    try {
      const schema = await buildWriteSchema(ds);
      const rowCount = ds.rowCount;
      let p = step();
      this.#worker.postMessage({ type: 'writeBegin', id, format, rowCount, variables: schema });
      await p;
      const BATCH = 20000;
      for (let off = 0; off < rowCount; off += BATCH) {
        const rows = await ds.getRows({ offset: off, limit: BATCH });
        if (!rows.length) break;
        const columns = schema.map((sv) => rows.map((row) => cellFor(sv, row[sv.name])));
        p = step();
        this.#worker.postMessage({ type: 'writeBatch', id, columns, nrows: rows.length });
        await p;
        onProgress?.(Math.min(off + BATCH, rowCount), rowCount);
      }
      p = step();
      this.#worker.postMessage({ type: 'writeEnd', id });
      const done = await p;
      return done.blob;
    } finally {
      this.#reqs.delete(id);
    }
  }

  /** Tear the worker down (next call cold-starts a new one). */
  dispose() {
    try {
      this.#worker?.terminate();
    } catch {
      /* best-effort */
    }
    this.#worker = null;
    this.#reqs.clear();
  }
}

const MEASURE_CODE = { nominal: 1, ordinal: 2, scale: 3 };

/**
 * Build the export schema from a dataset's VariableMeta — deciding, per variable,
 * how to represent it in a .sav/.dta: numeric variables and numeric-coded factors
 * become DOUBLE with double value labels (the SPSS/Stata norm); string variables
 * and non-numeric-coded factors become STRING with string value labels. String
 * widths come from one aggregate query so the header is exact.
 *
 * @param {object} ds
 * @returns {Promise<Array<object>>}
 */
async function buildWriteSchema(ds) {
  const meta = ds.getVariableMeta();
  const schema = meta.map((m) => {
    const measure = MEASURE_CODE[m.measurementLevel] || 0;
    const v = { name: m.name, label: m.label || '', measure, type: 'double', width: 1, labels: [], labelsAreString: false, missing: [] };
    const valueLabels = m.valueLabels && Object.keys(m.valueLabels).length ? m.valueLabels : null;
    if (m.type === 'string') {
      v.type = 'string';
    } else if (m.type === 'factor' && valueLabels) {
      const codes = Object.keys(valueLabels);
      const allNumeric = codes.every((c) => c !== '' && Number.isFinite(Number(c)));
      if (allNumeric) {
        v.type = 'double';
        v.labels = codes.map((c) => ({ value: Number(c), text: String(valueLabels[c]) }));
      } else {
        v.type = 'string';
        v.labelsAreString = true;
        v.labels = codes.map((c) => ({ sval: c, text: String(valueLabels[c]) }));
      }
    } else if (valueLabels) {
      // numeric variable that nonetheless carries value labels
      v.type = 'double';
      v.labels = Object.keys(valueLabels)
        .filter((c) => Number.isFinite(Number(c)))
        .map((c) => ({ value: Number(c), text: String(valueLabels[c]) }));
    }
    // Missing-value definitions apply to numeric (double) variables.
    if (v.type === 'double' && Array.isArray(m.missingValues) && m.missingValues.length) {
      v.missing = m.missingValues
        .filter((x) => Number.isFinite(Number(x)))
        .map((x) => ({ lo: Number(x), hi: Number(x) }));
    }
    return v;
  });
  const stringNames = schema.filter((s) => s.type === 'string').map((s) => s.name);
  if (stringNames.length) {
    const widths = await ds.maxOctetLengths(stringNames);
    for (const s of schema) if (s.type === 'string') s.width = Math.max(1, widths[s.name] || 1);
  }
  return schema;
}

/** Coerce a row value to what the worker expects: NaN/null = missing. A double
 * variable parses numeric-string factor codes; a string variable stays text. */
function cellFor(sv, val) {
  if (sv.type === 'string') return val == null ? null : String(val);
  if (val == null || val === '') return NaN;
  const n = Number(val);
  return Number.isNaN(n) ? NaN : n;
}
