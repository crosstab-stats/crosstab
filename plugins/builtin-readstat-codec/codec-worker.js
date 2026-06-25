/**
 * @file codec-worker.js
 * Web Worker that runs the ReadStat WASM to read SPSS/Stata/SAS files, streaming.
 *
 * Why a worker: ReadStat's IO is synchronous, and the only way to read arbitrary
 * byte ranges of a multi-GB File synchronously in a browser is `FileReaderSync`,
 * which exists only in workers. So the WASM lives here; the codec plugin (index.js)
 * posts a File in and gets back a catalog or a stream of column batches.
 *
 * Messages IN:
 *   { type:'catalog', id, file, format }           → reads dictionary only
 *   { type:'data',    id, file, format, rowLimit } → streams batches
 * Messages OUT (each tagged with the request id):
 *   { type:'catalog', id, rowCount, varCount, encoding, variables }
 *   { type:'variables', id, variables, storageTypes }   (data mode, before batches)
 *   { type:'batch', id, columns, nrows }                (transferable buffers)
 *   { type:'done', id, rowCount }
 *   { type:'error', id, message }
 *
 * `variables` are VariableMeta ({name,label,type,valueLabels,missingValues,
 * measurementLevel}); `storageTypes` map name→'numeric'|'string' (how the column
 * is stored: factor codes are numeric, string vars are text).
 */
const FORMATS = { sav: 0, dta: 1, sas7bdat: 2, por: 3, xpt: 4 };
/** Writable formats (sas7bdat is read-only in ReadStat). */
const FORMATS_W = { sav: 0, dta: 1, por: 3, xpt: 4 };
const TYPE_STRING = 0;
const TYPE_STRING_REF = 6;
const MEASURE = { 1: 'nominal', 2: 'ordinal', 3: 'scale' };
/** Target bytes per batch; rows-per-batch is derived so wide files stay bounded. */
const BATCH_BYTES = 16 * 1024 * 1024;

// Sandbox variant (#98): unlike the host worker, this one runs inside a codec
// plugin's opaque-origin sandbox, so it can't fetch its own glue/wasm (connect-src
// 'none') and has no OPFS. The host hands the ReadStat glue source + wasm bytes in
// via an 'init' message; output bytes are posted back (no OPFS sink).
let modPromise = null;
let glueUrl = null; // blob: URL of readstat.mjs, set on init
let wasmBinary = null; // readstat.wasm bytes, set on init
const getModule = () => (modPromise ??= import(glueUrl).then((m) => m.default({ wasmBinary, locateFile: (p) => p })));

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      wasmBinary = msg.wasmBinary;
      // The Emscripten glue computes `new URL('readstat.wasm', import.meta.url)`. As
      // a blob-imported module, import.meta.url is a blob: URL — an invalid base for
      // new URL(). Repoint it at a dummy absolute base; we pass wasmBinary, so the
      // resolved URL is never actually fetched.
      const patched = String(msg.glueSource).split('import.meta.url').join('"https://readstat.invalid/readstat.mjs"');
      glueUrl = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
      self.postMessage({ type: 'inited', id: msg.id });
      return;
    }
    if (msg.type === 'catalog') await runCatalog(msg);
    else if (msg.type === 'data') await runData(msg);
    else if (msg.type === 'writeBegin') await runWriteBegin(msg);
    else if (msg.type === 'writeBatch') await runWriteBatch(msg);
    else if (msg.type === 'writeEnd') await runWriteEnd(msg);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};

// --- write path (streaming export) ------------------------------------------
// State for the in-flight export. The writer lives in WASM across the synchronous
// batch calls; we feed it one DuckDB batch at a time and stream its output bytes
// straight to an OPFS sync-access handle, so memory stays bounded at any size.
let wVars = null; // schema for the export (var order)
let wCols = null; // current batch: array of column arrays in var order
let wId = null; // request id, so streamed chunks are tagged

async function runWriteBegin({ id, format, rowCount, variables }) {
  const Module = await getModule();
  wVars = variables;
  // Schema callbacks — served from the host-supplied schema (var order).
  Module.ctwNVars = () => wVars.length;
  Module.ctwVarType = (i) => (wVars[i].type === 'double' ? 1 : 0);
  Module.ctwVarWidth = (i) => wVars[i].width || 1;
  Module.ctwVarName = (i) => wVars[i].name;
  Module.ctwVarLabel = (i) => wVars[i].label || '';
  Module.ctwVarMeasure = (i) => wVars[i].measure || 0;
  Module.ctwVarNLabels = (i) => (wVars[i].labels ? wVars[i].labels.length : 0);
  Module.ctwLabelIsString = (i) => (wVars[i].labelsAreString ? 1 : 0);
  Module.ctwLabelDval = (i, j) => Number(wVars[i].labels[j].value);
  Module.ctwLabelSval = (i, j) => String(wVars[i].labels[j].sval ?? '');
  Module.ctwLabelText = (i, j) => String(wVars[i].labels[j].text ?? '');
  Module.ctwVarNMissing = (i) => (wVars[i].missing ? wVars[i].missing.length : 0);
  Module.ctwMissingLo = (i, j) => Number(wVars[i].missing[j].lo);
  Module.ctwMissingHi = (i, j) => Number(wVars[i].missing[j].hi);
  // Cell callbacks — served from the current batch (NaN/null → missing).
  Module.ctwCellDouble = (c, r) => {
    const v = wCols[c][r];
    return v == null || v !== v ? NaN : +v;
  };
  Module.ctwCellString = (c, r) => {
    const v = wCols[c][r];
    return v == null ? null : String(v);
  };
  // Output sink: no OPFS in the sandbox — copy each chunk out of the WASM heap and
  // post it back to the plugin, which forwards it to app.codec.writeChunk (the host
  // streams it to the download). Memory stays bounded (one chunk in flight).
  wId = id;
  Module.ctwSink = (u8) => {
    const c = u8.slice(); // copy off the WASM heap before transfer
    self.postMessage({ type: 'writeChunk', id: wId, bytes: c }, [c.buffer]);
  };
  const fmt = FORMATS_W[format];
  if (fmt === undefined) throw new Error(`Cannot write format "${format}".`);
  const err = Module.ccall('ct_write_begin', 'number', ['number', 'number'], [fmt, rowCount]);
  if (err !== 0) {
    const m = Module.ccall('ct_error_message', 'string', ['number'], [err]);
    closeWrite();
    self.postMessage({ type: 'error', id, message: `ReadStat write: ${m}` });
    return;
  }
  self.postMessage({ type: 'writeReady', id });
}

async function runWriteBatch({ id, columns, nrows }) {
  const Module = await getModule();
  wCols = columns; // array of column arrays, var order
  const err = Module.ccall('ct_write_batch', 'number', ['number'], [nrows]);
  if (err !== 0) {
    const m = Module.ccall('ct_error_message', 'string', ['number'], [err]);
    closeWrite();
    self.postMessage({ type: 'error', id, message: `ReadStat write: ${m}` });
    return;
  }
  self.postMessage({ type: 'batchDone', id });
}

async function runWriteEnd({ id }) {
  const Module = await getModule();
  const err = Module.ccall('ct_write_end', 'number', [], []);
  closeWrite();
  if (err !== 0) {
    const m = Module.ccall('ct_error_message', 'string', ['number'], [err]);
    self.postMessage({ type: 'error', id, message: `ReadStat write: ${m}` });
    return;
  }
  // The output bytes were already streamed via 'writeChunk'; just signal completion.
  self.postMessage({ type: 'writeDone', id });
}

/** Reset write state (output already streamed via the sink). */
function closeWrite() {
  wCols = null;
  wVars = null;
  wId = null;
}

/** Shared parse setup: wire FileReaderSync IO + collect schema. Returns a context
 * whose handlers the caller installs on Module before calling ct_parse. `keep`, if
 * a Set of variable names, restricts the import to those columns (skipped columns'
 * values are never read). */
function makeContext(Module, file, keep = null) {
  const frs = new FileReaderSync();
  const size = file.size;

  const meta = { rowCount: -1, varCount: 0, encoding: '' };
  const rawVars = []; // {index,name,label,type,format,measure,labelSet} (kept only)
  const labelSets = {}; // setName → { code: label }
  const missing = {}; // varIndex → [values]
  // ReadStat reports original variable indices to the value handler even when some
  // are skipped, so map each kept variable's original index → its column position.
  const keptIndexMap = {};

  // Reset any prior filter on the (reused) module, then install this request's.
  Module.ctKeepVar = keep ? (_index, name) => (keep.has(name) ? 1 : 0) : null;

  // Read-ahead buffer: ReadStat issues thousands of tiny (4-12 byte) reads, and a
  // FileReaderSync call per tiny read is ruinously slow. Serve small reads from a
  // cached ~1 MB chunk, doing one FileReaderSync read per chunk (refilled on a
  // seek outside the window). Each chunk is small, so files past 2 GB are fine.
  const CHUNK = 1 << 20;
  let bufStart = 0;
  let buf = new Uint8Array(0);
  Module.ctReadAt = (pos, bufPtr, nbyte) => {
    if (pos < 0 || pos >= size) return 0;
    const need = Math.min(nbyte, size - pos);
    if (need <= 0) return 0;
    if (pos < bufStart || pos + need > bufStart + buf.length) {
      const end = Math.min(pos + Math.max(need, CHUNK), size);
      buf = new Uint8Array(frs.readAsArrayBuffer(file.slice(pos, end)));
      bufStart = pos;
    }
    const off = pos - bufStart;
    Module.HEAPU8.set(buf.subarray(off, off + need), bufPtr);
    return need;
  };
  Module.ctMetadata = (rowCount, varCount, encoding) => {
    meta.rowCount = rowCount;
    meta.varCount = varCount;
    meta.encoding = encoding;
  };
  Module.ctVariable = (index, name, label, type, format, measure, labelSet) => {
    keptIndexMap[index] = rawVars.length;
    rawVars.push({ index, name, label, type, format, measure, labelSet });
  };
  Module.ctMissingRange = (vi, lo, hi) => {
    (missing[vi] ??= []).push([lo, hi]); // raw (lo,hi) pairs; expanded at finalize
  };
  Module.ctValueLabel = (set, dval, sval, label) => {
    (labelSets[set] ??= {})[sval ?? dval] = label;
  };

  return { meta, rawVars, labelSets, missing, size, keptIndexMap };
}

/** Cap on expanding a missing *range* to discrete values (keeps metadata bounded).
 * GSS's standard range (-100..-10 = 91 values) is well under this. */
const MAX_MISSING_EXPAND = 1000;

/**
 * Turn ReadStat missing-range (lo,hi) pairs into the discrete `missingValues` list
 * the app uses. A discrete spec arrives as lo===hi. A true range (SPSS "lo THRU
 * hi", e.g. GSS's -100..-10) is expanded to its integer members so exact-match
 * recoding flags every code in it; an unbounded/huge/non-integer range falls back
 * to its endpoints (rare; better than dropping it).
 */
function expandMissing(pairs) {
  const out = [];
  for (const [lo, hi] of pairs) {
    if (lo === hi) { out.push(lo); continue; }
    if (Number.isInteger(lo) && Number.isInteger(hi) && Number.isFinite(lo) && Number.isFinite(hi) && hi - lo <= MAX_MISSING_EXPAND) {
      for (let v = lo; v <= hi; v++) out.push(v);
    } else {
      out.push(lo, hi);
    }
  }
  return out;
}

/** Map collected ReadStat schema → VariableMeta[] + storageTypes. */
function finalizeVariables({ rawVars, labelSets, missing }) {
  const variables = [];
  const storageTypes = {};
  for (const v of rawVars) {
    const isString = v.type === TYPE_STRING || v.type === TYPE_STRING_REF;
    storageTypes[v.name] = isString ? 'string' : 'numeric';
    const labels = labelSets[v.labelSet];
    const out = { name: v.name };
    if (v.label) out.label = v.label;
    if (labels && Object.keys(labels).length) {
      out.type = 'factor';
      out.valueLabels = labels;
    } else {
      out.type = isString ? 'string' : 'numeric';
    }
    const miss = missing[v.index];
    if (miss && miss.length) {
      const expanded = expandMissing(miss);
      if (expanded.length) out.missingValues = expanded;
    }
    const ml = MEASURE[v.measure];
    if (ml) out.measurementLevel = ml;
    variables.push(out);
  }
  return { variables, storageTypes };
}

async function runCatalog({ id, file, format }) {
  const Module = await getModule();
  const ctx = makeContext(Module, file);
  Module.ctValueDouble = () => {};
  Module.ctValueString = () => {};
  const err = Module.ccall('ct_parse', 'number', ['number', 'number', 'number'],
    [FORMATS[format] ?? 0, ctx.size, 0]); // rowLimit 0 = catalog
  if (err !== 0) {
    const m = Module.ccall('ct_error_message', 'string', ['number'], [err]);
    self.postMessage({ type: 'error', id, message: `ReadStat: ${m}` });
    return;
  }
  const { variables } = finalizeVariables(ctx);
  self.postMessage({
    type: 'catalog', id,
    rowCount: ctx.meta.rowCount, varCount: ctx.meta.varCount, encoding: ctx.meta.encoding,
    variables,
  });
}

async function runData({ id, file, format, rowLimit = -1, variables = null }) {
  const Module = await getModule();
  const keep = Array.isArray(variables) && variables.length ? new Set(variables) : null;
  const ctx = makeContext(Module, file, keep);

  let started = false;
  let names = [];
  let types = [];          // 'numeric' | 'string' per column (by index)
  let batchRows = 0;
  let cols = [];           // per-column Float64Array | Array
  let batchStart = 0;      // global obs index at start of current batch
  let filled = 0;          // rows written into current batch
  let total = 0;

  const alloc = () => {
    cols = names.map((_, i) => (types[i] === 'numeric' ? new Float64Array(batchRows) : new Array(batchRows)));
  };
  const flush = (n) => {
    if (n <= 0) return;
    const columns = {};
    const transfer = [];
    for (let i = 0; i < names.length; i++) {
      if (types[i] === 'numeric') {
        const a = n === batchRows ? cols[i] : cols[i].slice(0, n);
        columns[names[i]] = a;
        transfer.push(a.buffer);
      } else {
        columns[names[i]] = n === batchRows ? cols[i] : cols[i].slice(0, n);
      }
    }
    self.postMessage({ type: 'batch', id, columns, nrows: n }, transfer);
    batchStart += n;
    filled = 0;
    alloc(); // fresh buffers (previous numeric buffers were transferred away)
  };
  const start = () => {
    const fin = finalizeVariables(ctx);
    names = fin.variables.map((v) => v.name);
    types = names.map((n) => fin.storageTypes[n]);
    batchRows = Math.max(100, Math.floor(BATCH_BYTES / Math.max(1, names.length * 8)));
    alloc();
    self.postMessage({ type: 'variables', id, variables: fin.variables, storageTypes: fin.storageTypes });
    started = true;
  };
  const onValue = (obs, vi, val) => {
    if (!started) start();
    const pos = ctx.keptIndexMap[vi];
    if (pos === undefined) return; // skipped column (guard; handler shouldn't fire)
    while (obs - batchStart >= batchRows) flush(batchRows);
    const row = obs - batchStart;
    cols[pos][row] = val;
    if (row + 1 > filled) filled = row + 1;
    if (obs + 1 > total) total = obs + 1;
  };
  Module.ctValueDouble = (obs, vi, v, sysmiss) => onValue(obs, vi, sysmiss ? NaN : v);
  Module.ctValueString = (obs, vi, v, sysmiss) => onValue(obs, vi, sysmiss ? null : v);

  const err = Module.ccall('ct_parse', 'number', ['number', 'number', 'number'],
    [FORMATS[format] ?? 0, ctx.size, rowLimit]);
  if (err !== 0) {
    const m = Module.ccall('ct_error_message', 'string', ['number'], [err]);
    self.postMessage({ type: 'error', id, message: `ReadStat: ${m}` });
    return;
  }
  if (!started) start(); // zero-row file: still deliver the schema
  flush(filled);
  self.postMessage({ type: 'done', id, rowCount: total });
}
