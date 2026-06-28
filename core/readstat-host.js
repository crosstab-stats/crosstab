/**
 * @file readstat-host.js
 * Host-side ReadStat (SPSS/Stata/SAS) import + export (#123).
 *
 * ReadStat was a sandboxed codec plugin (#112), but that spawned its WASM worker
 * from inside the opaque-origin codec iframe — which **iOS/Safari WebKit refuses to
 * run** (a bare nested Worker in a `sandbox="allow-scripts"` iframe dies with no
 * catchable error; confirmed by an on-device capability probe: `worker=onerror`).
 * That broke SPSS/Stata/SAS import AND export on every iPhone/iPad — unacceptable for
 * a stats tool.
 *
 * Fix: run ReadStat in a **host-owned, same-origin Worker** (the same kind of worker
 * the DuckDB engine uses, which works on iOS), and register it through the ordinary
 * import/export extension points so it joins the unified File ▸ Import/Export picker
 * exactly as before. The worker code ({@link ../plugins/builtin-readstat-codec/codec-worker.js})
 * is reused verbatim — it already streams the file in ~1 MB chunks via `FileReaderSync`
 * (no whole-file load) and emits column batches, which the host flushes into DuckDB
 * through the out-of-core streaming ingest ({@link DataStore#loadStreaming} /
 * {@link DataStore#loadWide}). So large files (the full GSS) are first-class by
 * construction, not an afterthought.
 *
 * Trade-off: this trusted **built-in** codec now runs host-side rather than sandboxed.
 * The codec sandbox remains for untrusted third-party codecs; ReadStat is first-party
 * code, so host execution is an acceptable, narrow exception for a platform iOS can't
 * otherwise support.
 */

const BASE = new URL('../', import.meta.url); // core/ → project root
const WORKER_URL = new URL('plugins/builtin-readstat-codec/codec-worker.js', BASE).href;
const GLUE_URL = new URL('vendor/readstat/readstat.mjs', BASE).href;
const WASM_URL = new URL('vendor/readstat/readstat.wasm', BASE).href;

const READ_EXTS = ['.sav', '.zsav', '.dta', '.por', '.xpt', '.sas7bdat'];
const FORMAT_BY_EXT = { '.sav': 'sav', '.zsav': 'sav', '.por': 'por', '.dta': 'dta', '.sas7bdat': 'sas7bdat', '.xpt': 'xpt' };
const MIME = { sav: 'application/x-spss-sav', dta: 'application/x-stata-dta', por: 'application/x-spss-por', xpt: 'application/x-sas-xport' };
const MEASURE_CODE = { nominal: 1, ordinal: 2, scale: 3 };

function formatForName(name) {
  const i = String(name).lastIndexOf('.');
  return FORMAT_BY_EXT[i >= 0 ? String(name).slice(i).toLowerCase() : ''] ?? null;
}

/** Ultra-wide heuristic (mirrors the codec): route huge column counts to the
 * out-of-core loadWide path rather than a DuckDB table (which OOMs on ~7k-col GSS). */
function isWide(varCount, rowCount) {
  const rows = rowCount >= 0 ? rowCount : 100000;
  return Math.ceil((varCount * rows) / 4_000_000) > 8;
}

export class ReadStatHost {
  #importers;
  #exporters;
  #data;
  #ui;
  #results;
  #ctlPromise = null;

  /**
   * @param {Object} deps
   * @param {import('./import-service.js').ImportService} deps.importers
   * @param {import('./export-service.js').ExportService} deps.exporters
   * @param {Object} deps.data - The host data API (datasets.api): getVariableMeta,
   *   getRows, getRowCount, maxOctetLengths.
   * @param {Object} deps.ui - UiService (selectFromList) for the variable-subset import.
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   */
  constructor({ importers, exporters, data, ui, results }) {
    this.#importers = importers;
    this.#exporters = exporters;
    this.#data = data;
    this.#ui = ui;
    this.#results = results;
  }

  /** Register the SPSS/Stata/SAS read + write formats into the unified picker. */
  activate() {
    this.#importers.registerCodec({
      id: 'readstat', label: 'SPSS / Stata / SAS…', extensions: READ_EXTS, order: 20, multiple: true,
      startRead: (file) => this.#startRead(file, false),
    });
    this.#importers.registerCodec({
      id: 'readstat-pick', label: 'SPSS / Stata / SAS — choose variables…', extensions: READ_EXTS, order: 21, multiple: true,
      startRead: (file) => this.#startRead(file, true),
    });
    this.#exporters.register({ id: 'readstat-sav', label: 'SPSS (.sav)', extensions: ['.sav'], order: 30, export: ({ ticket }) => void this.#runWrite('sav', ticket) });
    this.#exporters.register({ id: 'readstat-dta', label: 'Stata (.dta)', extensions: ['.dta'], order: 31, export: ({ ticket }) => void this.#runWrite('dta', ticket) });
  }

  // --- worker control (one worker for the lifetime, built on first use) --------

  #getCtl() {
    if (!this.#ctlPromise) this.#ctlPromise = this.#buildCtl();
    return this.#ctlPromise;
  }

  async #buildCtl() {
    const [workerSrc, glueSource, wasmBuf] = await Promise.all([
      fetch(WORKER_URL).then((r) => r.text()),
      fetch(GLUE_URL).then((r) => r.text()),
      fetch(WASM_URL).then((r) => r.arrayBuffer()),
    ]);
    const wasmBinary = new Uint8Array(wasmBuf);
    // Host-side, same-origin blob worker (works on iOS, unlike the sandbox nested
    // worker). Classic worker: the worker has no static imports; it dynamic-imports
    // the glue from a blob it builds in `init`.
    const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));

    const reqs = new Map();
    let nextId = 1;
    const ctl = { worker, onWriteChunk: null };

    worker.onmessage = (e) => {
      const m = e.data;
      const req = reqs.get(m.id);
      switch (m.type) {
        case 'inited':
        case 'catalog':
          reqs.delete(m.id); req?.resolve(m); break;
        case 'variables':
          if (req) req.queue = req.queue.then(() => req.onVariables?.(m.variables, m.storageTypes)).catch(req.fail); break;
        case 'batch':
          if (req) req.queue = req.queue.then(() => req.onBatch?.(m.columns, m.nrows)).catch(req.fail); break;
        case 'done':
          if (req) req.queue.then(() => { if (reqs.has(m.id)) { reqs.delete(m.id); req.resolve({ rowCount: m.rowCount }); } }); break;
        case 'writeReady':
        case 'batchDone':
          req?.resolve?.(m); break;
        case 'writeChunk':
          // Collect output bytes host-side (no app.codec.writeChunk hop).
          ctl.onWriteChunk?.(m.bytes); break;
        case 'writeDone':
          reqs.delete(m.id); req?.resolve?.(m); break;
        case 'error':
          reqs.delete(m.id); req?.reject?.(new Error(m.message)); break;
        case 'fatal': {
          const err = new Error(`ReadStat worker crashed: ${m.message}`);
          for (const r of reqs.values()) r.reject?.(err);
          reqs.clear();
          break;
        }
      }
    };
    worker.onerror = (e) => {
      const where = e.filename ? ` @ ${e.filename}:${e.lineno || 0}` : '';
      const err = new Error(`SPSS/Stata/SAS engine error: ${e.message || 'worker crashed'}${where}`);
      for (const r of reqs.values()) r.reject?.(err);
      reqs.clear();
    };

    const send = (msg, opts = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        reqs.set(id, { resolve, reject, ...opts });
        worker.postMessage({ ...msg, id });
      });

    await send({ type: 'init', glueSource, wasmBinary });

    ctl.catalog = (file, format) => send({ type: 'catalog', file, format });
    ctl.stream = (file, format, { onVariables, onBatch, variables = null } = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const req = { resolve, reject, onVariables, onBatch, queue: Promise.resolve() };
        req.fail = (err) => { if (reqs.has(id)) { reqs.delete(id); reject(err); } };
        reqs.set(id, req);
        worker.postMessage({ type: 'data', id, file, format, rowLimit: -1, variables });
      });
    ctl.writeBegin = (format, rowCount, variables) => send({ type: 'writeBegin', format, rowCount, variables });
    ctl.writeBatch = (columns, nrows) => send({ type: 'writeBatch', columns, nrows });
    ctl.writeEnd = () => send({ type: 'writeEnd' });
    return ctl;
  }

  // --- read (streaming into the host ingest via the registerCodec contract) ----

  /**
   * The codec-read contract import-service consumes: `begin()` resolves the catalog
   * head (after the worker reports the stream's variables); `drain(cb)` feeds each
   * column batch with backpressure (one batch in flight → bounded memory).
   * @param {Blob} file
   * @param {boolean} pick - Let the user choose a variable subset first.
   */
  #startRead(file, pick) {
    const queue = [];
    let notify = null;
    let ended = false;
    let error = null;
    let head = null;
    let headResolve;
    let headReject;
    const headPromise = new Promise((res, rej) => { headResolve = res; headReject = rej; });
    const wake = () => { if (notify) { const n = notify; notify = null; n(); } };

    (async () => {
      const format = formatForName(file.name);
      if (!format) throw new Error(`Unsupported file: ${file.name}`);
      const ctl = await this.#getCtl();
      const cat = await ctl.catalog(file, format);

      let chosen = null;
      if (pick) {
        chosen = await this.#ui.selectFromList({
          title: `Choose variables — ${file.name}`,
          hint: `${cat.varCount.toLocaleString()} variables${cat.rowCount >= 0 ? ` · ${cat.rowCount.toLocaleString()} rows` : ''}. Pick the ones to import (search to filter).`,
          items: cat.variables.map((v) => ({ value: v.name, label: v.label ? `${v.label} (${v.name})` : v.name })),
          multiple: true,
          okLabel: 'Import selected',
          searchPlaceholder: 'Filter by name or label…',
        });
        if (!chosen || !chosen.length) throw new Error('Import cancelled.');
      }
      const wide = isWide(pick ? chosen.length : cat.varCount, cat.rowCount);
      await ctl.stream(file, format, {
        variables: chosen,
        onVariables: (variables, storageTypes) => { head = { variables, storageTypes, rowCount: cat.rowCount, wide }; headResolve(head); },
        onBatch: (columns) => new Promise((ack) => { queue.push({ columns, ack }); wake(); }),
      });
    })().then(
      () => { ended = true; if (!head) headReject(new Error('ReadStat produced no variables')); },
      (e) => { error = e; ended = true; if (!head) headReject(e); },
    ).finally(wake);

    return {
      begin: () => headPromise,
      drain: async (cb) => {
        for (;;) {
          if (queue.length) { const it = queue.shift(); try { await cb(it.columns); } finally { it.ack(); } continue; }
          if (error) throw error;
          if (ended) return;
          // eslint-disable-next-line no-await-in-loop -- block until the next batch
          await new Promise((r) => { notify = r; });
        }
      },
    };
  }

  // --- write (streaming the derived dataset out, bytes collected host-side) ----

  async #runWrite(format, ticket) {
    try {
      const ctl = await this.#getCtl();
      const meta = await this.#data.getVariableMeta();
      if (!meta.length) throw new Error('no variables to export');
      const schema = await this.#buildWriteSchema(meta);
      const rowCount = await this.#data.getRowCount();
      const chunks = [];
      ctl.onWriteChunk = (bytes) => chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      try {
        await ctl.writeBegin(format, rowCount, schema);
        const BATCH = 20000;
        for (let off = 0; off < rowCount; off += BATCH) {
          const rows = await this.#data.getRows({ offset: off, limit: BATCH });
          if (!rows.length) break;
          const columns = schema.map((sv) => rows.map((row) => cellFor(sv, row[sv.name])));
          await ctl.writeBatch(columns, rows.length);
        }
        await ctl.writeEnd();
      } finally {
        ctl.onWriteChunk = null;
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { data.set(c, at); at += c.byteLength; }
      this.#exporters.deliver(ticket, { filename: `data.${format}`, mimeType: MIME[format] || 'application/octet-stream', data });
    } catch (err) {
      this.#results.appendError(`Export failed: ${err.message}`);
      try { this.#exporters.deliver(ticket, null); } catch { /* ticket may be gone */ }
    }
  }

  /** Build the ReadStat export schema from VariableMeta (ported from the codec):
   * numeric / numeric-coded factors → DOUBLE + double labels; string / non-numeric
   * factors → STRING + string labels. String widths from one host aggregate query. */
  async #buildWriteSchema(meta) {
    const schema = meta.map((m) => {
      const measure = MEASURE_CODE[m.measurementLevel] || 0;
      const v = { name: m.name, label: m.label || '', measure, type: 'double', width: 1, labels: [], labelsAreString: false, missing: [] };
      const valueLabels = m.valueLabels && Object.keys(m.valueLabels).length ? m.valueLabels : null;
      if (m.type === 'string') {
        v.type = 'string';
        if (valueLabels) { v.labelsAreString = true; v.labels = Object.keys(valueLabels).map((c) => ({ sval: c, text: String(valueLabels[c]) })); }
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
        v.type = 'double';
        v.labels = Object.keys(valueLabels).filter((c) => Number.isFinite(Number(c))).map((c) => ({ value: Number(c), text: String(valueLabels[c]) }));
      }
      if (v.type === 'double' && Array.isArray(m.missingValues) && m.missingValues.length) {
        v.missing = m.missingValues.filter((x) => Number.isFinite(Number(x))).map((x) => ({ lo: Number(x), hi: Number(x) }));
      }
      return v;
    });
    const stringNames = schema.filter((s) => s.type === 'string').map((s) => s.name);
    if (stringNames.length) {
      const widths = await this.#data.maxOctetLengths(stringNames);
      for (const s of schema) if (s.type === 'string') s.width = Math.max(1, (widths && widths[s.name]) || 1);
    }
    return schema;
  }
}

/** Coerce a row value for the writer: NaN/null = missing. */
function cellFor(sv, val) {
  if (sv.type === 'string') return val == null ? null : String(val);
  if (val == null || val === '') return NaN;
  const n = Number(val);
  return Number.isNaN(n) ? NaN : n;
}
