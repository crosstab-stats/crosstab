/**
 * @file plugins/builtin-readstat-codec/index.js
 * ReadStat (SPSS / Stata / SAS) as a streaming format codec (#98 Phase 2).
 *
 * This is the dogfood case for the codec interface: the format logic that used to
 * be a host subsystem (core/readstat-manager.js + the host worker) now lives in a
 * sandboxed plugin. The host keeps only the plumbing — the file picker, the
 * streaming DuckDB/OPFS ingest, and the download — exactly what the security model
 * forces it to own.
 *
 * It runs in the WASM/worker-enabled codec sandbox (plugin-host-codec.html). The
 * host hands it the ReadStat glue + .wasm + the worker source via
 * `app.codec.loadAsset` (the sandbox can't fetch them). Parsing happens in an
 * in-sandbox Worker (codec-worker.js) — ReadStat's IO is synchronous, so the
 * worker reads the input `File` (handed in via `app.codec.sourceFile`) with
 * FileReaderSync in bounded ~1 MB slices, keeping even multi-GB imports memory-
 * bounded without an Asyncify rebuild. Row batches stream out via
 * `app.codec.begin`/`batch`; on write, output bytes stream via
 * `app.codec.writeChunk`.
 *
 * NOTE (follow-up): the ultra-wide path (the host's `loadWide`, for ~7k-column GSS
 * extracts) isn't yet exposed through the codec read interface — this uses the
 * streaming (OPFS-parts) ingest, which covers the vast majority of files.
 */

export const manifest = {
  id: 'builtin-readstat-codec',
  name: 'SPSS / Stata / SAS codec',
  version: '3', // #123: capability-probe build (pinpoints the failing worker layer).
  apiVersion: '0.1.0',
  category: 'Data',
  // This plugin brings its own dependencies rather than relying on the host's
  // shared-library allowlist (#119) — proving a third-party codec can ship the same
  // way. Each asset resolves from a same-origin sibling of this entry module's URL
  // (`app.codec.loadAsset(name)` → loader.resolveAsset). The worker is a true
  // sibling; the ReadStat glue + WASM live in the shared vendor dir (a packaged
  // `.ctplugin` would instead bundle them — same names, resolved from the bundle).
  assets: [
    { name: 'readstat-worker', path: 'codec-worker.js', kind: 'text' },
    { name: 'readstat-glue', path: '../../vendor/readstat/readstat.mjs', kind: 'text' },
    { name: 'readstat-wasm', path: '../../vendor/readstat/readstat.wasm', kind: 'bytes' },
  ],
  codecs: [
    { id: 'readstat', label: 'SPSS / Stata / SAS…', extensions: ['.sav', '.zsav', '.dta', '.por', '.xpt', '.sas7bdat'], read: 'readImport', order: 20, multiple: true },
    { id: 'readstat-pick', label: 'SPSS / Stata / SAS — choose variables…', extensions: ['.sav', '.zsav', '.dta', '.por', '.xpt', '.sas7bdat'], read: 'readImportPick', order: 21, multiple: true },
    { id: 'readstat-sav', label: 'SPSS (.sav)', extensions: ['.sav'], write: 'writeSav', order: 30 },
    { id: 'readstat-dta', label: 'Stata (.dta)', extensions: ['.dta'], write: 'writeDta', order: 31 },
  ],
};

const FORMAT_BY_EXT = { '.sav': 'sav', '.zsav': 'sav', '.por': 'por', '.dta': 'dta', '.sas7bdat': 'sas7bdat', '.xpt': 'xpt' };
const MIME = { sav: 'application/x-spss-sav', dta: 'application/x-stata-dta', por: 'application/x-spss-por', xpt: 'application/x-sas-xport' };

function formatForName(name) {
  const i = String(name).lastIndexOf('.');
  return FORMAT_BY_EXT[i >= 0 ? String(name).slice(i).toLowerCase() : ''] ?? null;
}

/** Ultra-wide heuristic (mirrors the old host path): if the estimated OPFS-part
 * count exceeds 8, route to the out-of-core loadWide path instead of building a
 * DuckDB table (which fatal-OOMs on ~7k-column files like the cumulative GSS). */
function isWide(varCount, rowCount) {
  const rows = rowCount >= 0 ? rowCount : 100000;
  return Math.ceil((varCount * rows) / 4_000_000) > 8;
}

// --- worker control ----------------------------------------------------------
// One worker for the plugin's lifetime, built on first use from host-provided
// assets. Mirrors core/readstat-manager.js's request routing, but the worker is
// in-sandbox and IO crosses app.codec instead of the host directly.

let ctlPromise = null;

async function getCtl(app) {
  if (!ctlPromise) ctlPromise = buildCtl(app);
  const ctl = await ctlPromise;
  ctl.app = app; // latest app, for writeChunk forwarding
  return ctl;
}

// #123 capability probe: pinpoint which worker capability WebKit refuses inside the
// opaque-origin codec sandbox, since the real worker dies with no catchable detail on
// iOS. Tests, in order: (1) a bare nested blob Worker runs, (2) dynamic import() of a
// blob ES-module works inside it, (3) WebAssembly.instantiate works inside it. Stops
// at the first failure. Result is surfaced in the worker-crash message so it's
// readable on-device (no console). This decides whether the fix is in-sandbox (e.g.
// glue-loading) or requires moving the engine host-side.
let probeResult = '(probe not run)';
async function probeWorkerCapabilities() {
  const src = [
    'self.onmessage = async (e) => {',
    '  const cmd = e.data;',
    '  try {',
    '    if (cmd === "worker") return self.postMessage({ stage: "worker", ok: true });',
    '    if (cmd === "import") {',
    '      const u = URL.createObjectURL(new Blob(["export default 1"], { type: "text/javascript" }));',
    '      await import(u); return self.postMessage({ stage: "import", ok: true });',
    '    }',
    '    if (cmd === "wasm") {',
    '      await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));',
    '      return self.postMessage({ stage: "wasm", ok: true });',
    '    }',
    '  } catch (err) { self.postMessage({ stage: cmd, ok: false, msg: String(err && err.message || err) }); }',
    '};',
  ].join('\n');
  let w;
  try {
    w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch (e) {
    return `worker-create threw: ${(e && e.message) || e}`;
  }
  const ask = (cmd) =>
    new Promise((res) => {
      const t = setTimeout(() => res(`${cmd}=CRASH/timeout`), 4000);
      const onMsg = (ev) => { clearTimeout(t); w.removeEventListener('message', onMsg); res(`${ev.data.stage}=${ev.data.ok ? 'ok' : `FAIL(${ev.data.msg})`}`); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', () => { clearTimeout(t); res(`${cmd}=worker-onerror`); }, { once: true });
      w.postMessage(cmd);
    });
  const out = [];
  for (const cmd of ['worker', 'import', 'wasm']) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design (stop at first fail)
    const r = await ask(cmd);
    out.push(r);
    if (!r.endsWith('=ok')) break;
  }
  try { w.terminate(); } catch { /* ignore */ }
  return out.join(', ');
}

async function buildCtl(app) {
  const [workerSrc, glueSource, wasmBinary] = await Promise.all([
    app.codec.loadAsset('readstat-worker'),
    app.codec.loadAsset('readstat-glue'),
    app.codec.loadAsset('readstat-wasm'),
  ]);
  probeResult = await probeWorkerCapabilities(); // #123: capture before the real worker
  // Classic (not module) worker: module workers from a blob: URL fail to load in the
  // opaque-origin codec sandbox. The worker has no static imports — it dynamic-
  // imports the glue (supported in classic workers) — so classic is fine.
  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));

  const reqs = new Map();
  let nextId = 1;
  const ctl = { app: null, worker };

  worker.onmessage = (e) => {
    const m = e.data;
    const req = reqs.get(m.id);
    if (!req) return;
    switch (m.type) {
      case 'inited':
        reqs.delete(m.id); req.resolve(m); break;
      case 'catalog':
        reqs.delete(m.id); req.resolve(m); break;
      case 'variables':
        req.queue = req.queue.then(() => req.onVariables?.(m.variables, m.storageTypes)).catch(req.fail); break;
      case 'batch':
        req.queue = req.queue.then(() => req.onBatch?.(m.columns, m.nrows)).catch(req.fail); break;
      case 'done':
        req.queue.then(() => { if (reqs.has(m.id)) { reqs.delete(m.id); req.resolve({ rowCount: m.rowCount }); } }); break;
      case 'writeReady':
      case 'batchDone':
        req.resolve?.(m); break;
      case 'writeChunk':
        // Forward each output chunk to the host download stream, in order. Chunks
        // are produced during writeBatch/writeEnd and tagged with the writeBegin id;
        // they're chained on a single per-export queue (ctl.wq) that writeFormat()
        // awaits after writeEnd, so the host has every chunk before it assembles.
        ctl.wq = (ctl.wq || Promise.resolve()).then(() => ctl.app.codec.writeChunk(m.bytes)); break;
      case 'writeDone':
        reqs.delete(m.id); req.resolve?.(m); break;
      case 'error':
        reqs.delete(m.id); req.reject?.(new Error(m.message)); break;
      case 'fatal': {
        // Worker-global crash (WASM abort/OOM, etc.) — not tied to one request; fail
        // everything in flight with the detail the worker managed to capture (#91).
        const err = new Error(`ReadStat worker crashed: ${m.message}`);
        for (const r of reqs.values()) r.reject?.(err);
        reqs.clear();
        break;
      }
    }
  };
  worker.onerror = (e) => {
    const where = e.filename ? ` @ ${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
    // An empty-message worker onerror is a hard crash below JS — on iOS Safari this is
    // almost always the per-worker memory ceiling (a fixed WebKit cap, not device RAM)
    // hit while parsing a large/very-wide file (e.g. a full-GSS .sav with thousands of
    // variables). Give actionable guidance rather than a cryptic abort (#91).
    const detail = e.message
      ? `${e.message}${where}`
      : 'the SPSS/Stata/SAS engine couldn’t run in this browser';
    // #123: append the capability-probe result so an on-device crash names the exact
    // failing layer (bare worker / dynamic import / WASM instantiate).
    const err = new Error(`SPSS/Stata/SAS engine error: ${detail} [worker probe: ${probeResult}]`);
    for (const r of reqs.values()) r.reject?.(err);
    reqs.clear();
  };

  const send = (msg, opts = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      reqs.set(id, { resolve, reject, ...opts });
      worker.postMessage({ ...msg, id });
    });
  };

  // Init the worker with the glue + wasm (it can't fetch them itself).
  await new Promise((resolve, reject) => {
    const id = nextId++;
    reqs.set(id, { resolve, reject });
    worker.postMessage({ type: 'init', id, glueSource, wasmBinary });
  });

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

// --- read --------------------------------------------------------------------

/** Import every variable, streaming into the host ingest. Catalogs first (cheap
 * dictionary read) to flag ultra-wide files for the out-of-core loadWide path. */
export async function readImport(app, _info) {
  const file = await app.codec.sourceFile();
  const format = formatForName(file.name);
  if (!format) throw new Error(`Unsupported file: ${file.name}`);
  const ctl = await getCtl(app);
  const cat = await ctl.catalog(file, format);
  const wide = isWide(cat.varCount, cat.rowCount);
  await ctl.stream(file, format, {
    onVariables: (variables, storageTypes) => app.codec.begin(variables, storageTypes, { rowCount: cat.rowCount, wide }),
    onBatch: (columns) => app.codec.batch(columns),
  });
}

/** Read the dictionary, let the user pick a subset, then import those columns. */
export async function readImportPick(app, _info) {
  const file = await app.codec.sourceFile();
  const format = formatForName(file.name);
  if (!format) throw new Error(`Unsupported file: ${file.name}`);
  const ctl = await getCtl(app);
  const cat = await ctl.catalog(file, format);
  const chosen = await app.ui.selectFromList({
    title: `Choose variables — ${file.name}`,
    hint: `${cat.varCount.toLocaleString()} variables${cat.rowCount >= 0 ? ` · ${cat.rowCount.toLocaleString()} rows` : ''}. Pick the ones to import (search to filter).`,
    items: cat.variables.map((v) => ({ value: v.name, label: v.label ? `${v.label} (${v.name})` : v.name })),
    multiple: true,
    okLabel: 'Import selected',
    searchPlaceholder: 'Filter by name or label…',
  });
  if (!chosen || !chosen.length) throw new Error('Import cancelled.');
  const wide = isWide(chosen.length, cat.rowCount);
  await ctl.stream(file, format, {
    variables: chosen,
    onVariables: (variables, storageTypes) => app.codec.begin(variables, storageTypes, { rowCount: cat.rowCount, wide }),
    onBatch: (columns) => app.codec.batch(columns),
  });
}

// --- write -------------------------------------------------------------------

export function writeSav(app) { return writeFormat(app, 'sav'); }
export function writeDta(app) { return writeFormat(app, 'dta'); }

async function writeFormat(app, format) {
  const meta = await app.data.getVariableMeta();
  const schema = await buildWriteSchema(app, meta);
  const rowCount = await app.data.getRowCount();
  const ctl = await getCtl(app);
  ctl.wq = Promise.resolve(); // fresh output-chunk forward queue for this export
  await ctl.writeBegin(format, rowCount, schema);
  const BATCH = 20000;
  for (let off = 0; off < rowCount; off += BATCH) {
    const rows = await app.data.getRows({ offset: off, limit: BATCH });
    if (!rows.length) break;
    const columns = schema.map((sv) => rows.map((row) => cellFor(sv, row[sv.name])));
    await ctl.writeBatch(columns, rows.length);
  }
  await ctl.writeEnd();
  await ctl.wq; // ensure every output chunk reached the host before it assembles
  return { filename: `data.${format}`, mimeType: MIME[format] || 'application/octet-stream' };
}

const MEASURE_CODE = { nominal: 1, ordinal: 2, scale: 3 };

/** Build the export schema from VariableMeta (ported from readstat-manager):
 * numeric / numeric-coded factors → DOUBLE + double labels; string / non-numeric
 * factors → STRING + string labels. String widths from one host aggregate query. */
async function buildWriteSchema(app, meta) {
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
    const widths = await app.data.maxOctetLengths(stringNames);
    for (const s of schema) if (s.type === 'string') s.width = Math.max(1, (widths && widths[s.name]) || 1);
  }
  return schema;
}

/** Coerce a row value for the writer: NaN/null = missing. */
function cellFor(sv, val) {
  if (sv.type === 'string') return val == null ? null : String(val);
  if (val == null || val === '') return NaN;
  const n = Number(val);
  return Number.isNaN(n) ? NaN : n;
}
