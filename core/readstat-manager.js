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
   * @returns {Promise<{rowCount: number}>}
   */
  stream(file, format, { onVariables, onBatch, rowLimit = -1 } = {}) {
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
      this.#worker.postMessage({ type: 'data', id, file, format, rowLimit });
    });
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
