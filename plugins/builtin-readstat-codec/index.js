/**
 * @file plugins/builtin-readstat-codec/index.js
 * ReadStat (SPSS / Stata / SAS) as a streaming format codec — sandboxed, no worker.
 *
 * History: this was a sandboxed codec plugin (#112) whose WASM ran in a **nested
 * Worker** inside the opaque-origin codec sandbox — which iOS/Safari WebKit refuses to
 * start (#123), so it was moved host-side (readstat-host.js). #130 brings it back into
 * the sandbox the principled way: the ReadStat WASM is rebuilt with **ASYNCIFY**, so
 * its synchronous read/write callbacks can SUSPEND while async JS does the IO — letting
 * it run on the sandbox **main thread** (where CSV already runs), with NO Worker and NO
 * FileReaderSync. Large files stay first-class: reads pull bounded ~1 MB Blob slices,
 * batches stream out via app.codec.begin/batch, and export bytes stream via
 * app.codec.writeChunk — memory is bounded at any size.
 *
 * This makes ReadStat a true sandboxed, third-party-equal codec again, and (the real
 * point) proves the codec interface supports streaming sync-IO formats on iOS.
 */

export const manifest = {
  id: 'builtin-readstat-codec',
  name: 'SPSS / Stata / SAS codec',
  version: '5', // #130: ASYNCIFY main-thread build (no worker) + step instrumentation.
  apiVersion: '0.1.0',
  category: 'Data',
  // The plugin ships its own engine (a third-party codec would do the same): the glue
  // + WASM resolve from same-origin siblings via app.codec.loadAsset → loader.resolveAsset.
  // No worker asset any more — the engine runs on the sandbox main thread.
  assets: [
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

const FORMATS = { sav: 0, dta: 1, sas7bdat: 2, por: 3, xpt: 4 };
const FORMATS_W = { sav: 0, dta: 1, por: 3, xpt: 4 };
const FORMAT_BY_EXT = { '.sav': 'sav', '.zsav': 'sav', '.por': 'por', '.dta': 'dta', '.sas7bdat': 'sas7bdat', '.xpt': 'xpt' };
const MIME = { sav: 'application/x-spss-sav', dta: 'application/x-stata-dta', por: 'application/x-spss-por', xpt: 'application/x-sas-xport' };
const MEASURE_CODE = { nominal: 1, ordinal: 2, scale: 3 };
const MEASURE = { 1: 'nominal', 2: 'ordinal', 3: 'scale' };
const TYPE_STRING = 0;
const TYPE_STRING_REF = 6;
const BATCH_BYTES = 16 * 1024 * 1024; // target bytes/batch; rows-per-batch derived (wide stays bounded)
const CHUNK = 1 << 20; // read-ahead window (ReadStat issues thousands of tiny reads)

function formatForName(name) {
  const i = String(name).lastIndexOf('.');
  return FORMAT_BY_EXT[i >= 0 ? String(name).slice(i).toLowerCase() : ''] ?? null;
}

/** Ultra-wide heuristic (mirrors the host path): route huge column counts to the
 * out-of-core loadWide ingest rather than a DuckDB table (OOMs on ~7k-col GSS). */
function isWide(varCount, rowCount) {
  const rows = rowCount >= 0 ? rowCount : 100000;
  return Math.ceil((varCount * rows) / 4_000_000) > 8;
}

// --- engine (main-thread, ASYNCIFY) -----------------------------------------
// One Module for the plugin's lifetime, instantiated on first use from the host-
// provided glue + wasm. Runs on the sandbox MAIN thread; ct_parse / ct_write_* SUSPEND
// (ASYNCIFY) at each IO callback, so they're driven via ccall(..., { async: true }).

let modulePromise = null;

// #130 debug instrumentation: every step writes a line to the Output pane (visible on
// iPad, where there's no console). Fire-and-forget so it never adds latency or throws
// in the hot path. Remove once the iOS sandbox path is confirmed.
function dbg(app, msg) {
  try { const p = app?.results?.appendText?.(`\`[readstat]\` ${msg}`); if (p && p.catch) p.catch(() => {}); } catch { /* never let logging break import */ }
}

async function getModule(app) {
  if (!modulePromise) modulePromise = build(app);
  return modulePromise;
}

async function build(app) {
  dbg(app, 'build: loading assets (glue + wasm)…');
  const [glueSource, wasmBytes] = await Promise.all([
    app.codec.loadAsset('readstat-glue'),
    app.codec.loadAsset('readstat-wasm'),
  ]);
  const wasmBinary = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
  dbg(app, `build: glue ${String(glueSource).length} chars, wasm ${wasmBinary.byteLength} bytes`);
  // The glue does `new URL('readstat.wasm', import.meta.url)`; as a blob-imported
  // module import.meta.url is a blob: URL (invalid base). Repoint at a dummy absolute
  // base — we pass wasmBinary, so the resolved URL is never fetched.
  const patched = String(glueSource).split('import.meta.url').join('"https://readstat.invalid/readstat.mjs"');
  const url = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
  const log = [];
  dbg(app, 'build: importing glue module…');
  const factory = (await import(url)).default;
  dbg(app, 'build: instantiating WASM (ASYNCIFY)…');
  const Module = await factory({
    wasmBinary,
    locateFile: (p) => p,
    print: (s) => log.push(String(s)),
    printErr: (s) => log.push(String(s)),
    onAbort: (r) => log.push(`abort: ${r}`),
  });
  Module.__log = log;
  dbg(app, 'build: WASM ready ✓');
  return Module;
}

function logTail(Module) {
  const l = Module && Module.__log;
  return l && l.length ? ` — wasm: ${l.slice(-6).join(' | ')}` : '';
}

/** Install an ASYNC read callback over `file` on Module (bounded ~1 MB read-ahead).
 * Instrumented (#130 debug): logs the first read, every refill, and ANY read error
 * (a rejected/short Blob.arrayBuffer is a prime iOS-sandbox suspect) — returning -1 so
 * ReadStat surfaces it as a clean error instead of an opaque trap. */
function installRead(app, Module, file) {
  const size = file.size;
  let bufStart = 0;
  let buf = new Uint8Array(0);
  let nReads = 0;
  let nRefills = 0;
  Module.ctReadAt = async (pos, bufPtr, nbyte) => {
    if (pos < 0 || pos >= size) return 0;
    const need = Math.min(nbyte, size - pos);
    if (need <= 0) return 0;
    nReads++;
    if (nReads === 1) dbg(app, `read: first call pos=${pos} nbyte=${nbyte}`);
    if (pos < bufStart || pos + need > bufStart + buf.length) {
      const end = Math.min(pos + Math.max(need, CHUNK), size);
      nRefills++;
      if (nRefills <= 3 || nRefills % 25 === 0) dbg(app, `read: refill #${nRefills} pos=${pos} len=${end - pos} (reads=${nReads})`);
      try {
        const ab = await file.slice(pos, end).arrayBuffer();
        buf = new Uint8Array(ab);
        bufStart = pos;
        if (buf.length < end - pos) { dbg(app, `read: SHORT slice — asked ${end - pos}, got ${buf.length} @${pos}`); return -1; }
      } catch (e) {
        dbg(app, `read: ERROR file.slice(${pos},${end}).arrayBuffer() → ${e && e.message || e}`);
        return -1;
      }
    }
    Module.HEAPU8.set(buf.subarray(pos - bufStart, pos - bufStart + need), bufPtr);
    return need;
  };
}

/** Wire the dictionary-collecting callbacks; returns the collector context. `keep`,
 * if a Set of names, restricts the import to those columns. (Mirrors codec-worker.) */
function makeContext(Module, keep = null) {
  const meta = { rowCount: -1, varCount: 0, encoding: '' };
  const rawVars = [];
  const labelSets = {};
  const missing = {};
  const keptIndexMap = {};
  Module.ctKeepVar = keep ? (_i, name) => (keep.has(name) ? 1 : 0) : null;
  Module.ctMetadata = (rowCount, varCount, encoding) => { meta.rowCount = rowCount; meta.varCount = varCount; meta.encoding = encoding; };
  Module.ctVariable = (index, name, label, type, format, measure, labelSet) => {
    keptIndexMap[index] = rawVars.length;
    rawVars.push({ index, name, label, type, format, measure, labelSet });
  };
  Module.ctMissingRange = (vi, lo, hi) => { (missing[vi] ??= []).push([lo, hi]); };
  Module.ctValueLabel = (set, dval, sval, label) => { (labelSets[set] ??= {})[sval ?? dval] = label; };
  return { meta, rawVars, labelSets, missing, keptIndexMap };
}

const MAX_MISSING_EXPAND = 1000;
function expandMissing(pairs) {
  const out = [];
  for (const [lo, hi] of pairs) {
    if (lo === hi) { out.push(lo); continue; }
    if (Number.isInteger(lo) && Number.isInteger(hi) && Number.isFinite(lo) && Number.isFinite(hi) && hi - lo <= MAX_MISSING_EXPAND) {
      for (let v = lo; v <= hi; v++) out.push(v);
    } else { out.push(lo, hi); }
  }
  return out;
}

function finalizeVariables({ rawVars, labelSets, missing }) {
  const variables = [];
  const storageTypes = {};
  for (const v of rawVars) {
    const isString = v.type === TYPE_STRING || v.type === TYPE_STRING_REF;
    storageTypes[v.name] = isString ? 'string' : 'numeric';
    const labels = labelSets[v.labelSet];
    const out = { name: v.name };
    if (v.label) out.label = v.label;
    if (labels && Object.keys(labels).length) { out.type = 'factor'; out.valueLabels = labels; }
    else { out.type = isString ? 'string' : 'numeric'; }
    const miss = missing[v.index];
    if (miss && miss.length) { const e = expandMissing(miss); if (e.length) out.missingValues = e; }
    const ml = MEASURE[v.measure];
    if (ml) out.measurementLevel = ml;
    variables.push(out);
  }
  return { variables, storageTypes };
}

/** Catalog (dictionary only) — for the wide check + the variable picker. */
async function catalog(app, file, format) {
  const Module = await getModule(app);
  installRead(app, Module, file);
  const ctx = makeContext(Module);
  Module.ctValueDouble = () => {};
  Module.ctValueString = () => {};
  dbg(app, `catalog: ct_parse(format=${format}, rowLimit=0)…`);
  const err = await Module.ccall('ct_parse', 'number', ['number', 'number', 'number'], [FORMATS[format] ?? 0, file.size, 0], { async: true });
  dbg(app, `catalog: ct_parse returned ${err}`);
  if (err !== 0) throw new Error(`ReadStat: ${Module.ccall('ct_error_message', 'string', ['number'], [err])}${logTail(Module)}`);
  const { variables } = finalizeVariables(ctx);
  dbg(app, `catalog: ✓ ${ctx.meta.varCount} vars, ${ctx.meta.rowCount} rows`);
  return { rowCount: ctx.meta.rowCount, varCount: ctx.meta.varCount, encoding: ctx.meta.encoding, variables };
}

/** Stream a file's rows into the host ingest as column batches, in order. `keep`
 * restricts to chosen columns. Returns total row count. */
async function stream(app, file, format, { onVariables, onBatch, variables = null }) {
  const Module = await getModule(app);
  installRead(app, Module, file);
  const keep = Array.isArray(variables) && variables.length ? new Set(variables) : null;
  const ctx = makeContext(Module, keep);

  let started = false;
  let names = [];
  let types = [];
  let batchRows = 0;
  let cols = [];
  let batchStart = 0;
  let total = 0;
  let nBatches = 0;
  let pending = Promise.resolve(); // serialises begin + batches so they arrive in order
  let failed = null;

  const alloc = () => { cols = names.map((_, i) => (types[i] === 'numeric' ? new Float64Array(batchRows) : new Array(batchRows))); };
  const flush = (n) => {
    if (n <= 0) return;
    const columns = {};
    for (let i = 0; i < names.length; i++) columns[names[i]] = n === batchRows ? cols[i] : cols[i].slice(0, n);
    nBatches++;
    if (nBatches <= 3 || nBatches % 25 === 0) dbg(app, `stream: batch #${nBatches} (${n} rows, total≈${batchStart + n})`);
    pending = pending.then(() => onBatch(columns)).catch((e) => { failed = failed || e; });
    batchStart += n;
    alloc();
  };
  const start = () => {
    const fin = finalizeVariables(ctx);
    names = fin.variables.map((v) => v.name);
    types = names.map((nm) => fin.storageTypes[nm]);
    batchRows = Math.max(100, Math.floor(BATCH_BYTES / Math.max(1, names.length * 8)));
    alloc();
    dbg(app, `stream: variables ready — ${names.length} cols, ${batchRows} rows/batch`);
    pending = pending.then(() => onVariables(fin.variables, fin.storageTypes)).catch((e) => { failed = failed || e; });
    started = true;
  };
  const onValue = (obs, vi, val) => {
    if (!started) start();
    const pos = ctx.keptIndexMap[vi];
    if (pos === undefined) return;
    while (obs - batchStart >= batchRows) flush(batchRows);
    cols[pos][obs - batchStart] = val;
    if (obs + 1 > total) total = obs + 1;
  };
  Module.ctValueDouble = (obs, vi, v, sysmiss) => onValue(obs, vi, sysmiss ? NaN : v);
  Module.ctValueString = (obs, vi, v, sysmiss) => onValue(obs, vi, sysmiss ? null : v);

  dbg(app, 'stream: ct_parse(rowLimit=-1)…');
  const err = await Module.ccall('ct_parse', 'number', ['number', 'number', 'number'], [FORMATS[format] ?? 0, file.size, -1], { async: true });
  dbg(app, `stream: ct_parse returned ${err}`);
  if (err !== 0) throw new Error(`ReadStat: ${Module.ccall('ct_error_message', 'string', ['number'], [err])}${logTail(Module)}`);
  if (!started) start(); // zero-row file: still deliver the schema
  flush(total - batchStart);
  await pending; // all batches reached the host (in order)
  if (failed) throw failed;
  dbg(app, `stream: ✓ done — ${total} rows in ${nBatches} batches`);
  return total;
}

// --- read --------------------------------------------------------------------

export async function readImport(app) {
  try {
    dbg(app, '=== import start ===');
    const file = await app.codec.sourceFile();
    dbg(app, `sourceFile: "${file && file.name}" (${file && file.size} bytes, type=${file && file.type || '?'})`);
    const format = formatForName(file.name);
    if (!format) throw new Error(`Unsupported file: ${file.name}`);
    dbg(app, `format: ${format}`);
    const cat = await catalog(app, file, format);
    const wide = isWide(cat.varCount, cat.rowCount);
    dbg(app, `routing: ${wide ? 'WIDE (out-of-core)' : 'streaming'} ingest`);
    await stream(app, file, format, {
      onVariables: (variables, storageTypes) => app.codec.begin(variables, storageTypes, { rowCount: cat.rowCount, wide }),
      onBatch: (columns) => app.codec.batch(columns),
    });
    dbg(app, '=== import done ✓ ===');
  } catch (err) {
    dbg(app, `✗ FAILED: ${err && err.message || err}`);
    throw err;
  }
}

export async function readImportPick(app) {
  const file = await app.codec.sourceFile();
  const format = formatForName(file.name);
  if (!format) throw new Error(`Unsupported file: ${file.name}`);
  const cat = await catalog(app, file, format);
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
  await stream(app, file, format, {
    variables: chosen,
    onVariables: (variables, storageTypes) => app.codec.begin(variables, storageTypes, { rowCount: cat.rowCount, wide }),
    onBatch: (columns) => app.codec.batch(columns),
  });
}

// --- write -------------------------------------------------------------------

export function writeSav(app) { return writeFormat(app, 'sav'); }
export function writeDta(app) { return writeFormat(app, 'dta'); }

async function writeFormat(app, format) {
  const fmt = FORMATS_W[format];
  if (fmt === undefined) throw new Error(`Cannot write format "${format}".`);
  const Module = await getModule(app);
  const meta = await app.data.getVariableMeta();
  if (!meta.length) throw new Error('no variables to export');
  const schema = await buildWriteSchema(app, meta);
  const rowCount = await app.data.getRowCount();

  // Schema getters (var order) + cell getters (current batch); output sink streams
  // each chunk to the host (bounded memory). The wasm SUSPENDS at the sink (ASYNCIFY),
  // so writeChunk can be awaited — back-pressure on the export, no full-file buffer.
  let wq = Promise.resolve();
  Object.assign(Module, {
    ctwNVars: () => schema.length,
    ctwVarType: (i) => (schema[i].type === 'double' ? 1 : 0),
    ctwVarWidth: (i) => schema[i].width || 1,
    ctwVarName: (i) => schema[i].name,
    ctwVarLabel: (i) => schema[i].label || '',
    ctwVarMeasure: (i) => schema[i].measure || 0,
    ctwVarNLabels: (i) => (schema[i].labels ? schema[i].labels.length : 0),
    ctwLabelIsString: (i) => (schema[i].labelsAreString ? 1 : 0),
    ctwLabelDval: (i, j) => Number(schema[i].labels[j].value),
    ctwLabelSval: (i, j) => String(schema[i].labels[j].sval ?? ''),
    ctwLabelText: (i, j) => String(schema[i].labels[j].text ?? ''),
    ctwVarNMissing: (i) => (schema[i].missing ? schema[i].missing.length : 0),
    ctwMissingLo: (i, j) => Number(schema[i].missing[j].lo),
    ctwMissingHi: (i, j) => Number(schema[i].missing[j].hi),
  });
  let wcols = null;
  Module.ctwCellDouble = (c, r) => { const v = wcols[c][r]; return v == null || v !== v ? NaN : +v; };
  Module.ctwCellString = (c, r) => { const v = wcols[c][r]; return v == null ? null : String(v); };
  Module.ctwSink = (u8) => { const bytes = u8.slice(); wq = wq.then(() => app.codec.writeChunk(bytes)); };

  const check = (err) => { if (err !== 0) throw new Error(`ReadStat write: ${Module.ccall('ct_error_message', 'string', ['number'], [err])}${logTail(Module)}`); };
  check(await Module.ccall('ct_write_begin', 'number', ['number', 'number'], [fmt, rowCount], { async: true }));
  const BATCH = 20000;
  for (let off = 0; off < rowCount; off += BATCH) {
    const rows = await app.data.getRows({ offset: off, limit: BATCH });
    if (!rows.length) break;
    wcols = schema.map((sv) => rows.map((row) => cellFor(sv, row[sv.name])));
    check(await Module.ccall('ct_write_batch', 'number', ['number'], [rows.length], { async: true }));
  }
  check(await Module.ccall('ct_write_end', 'number', [], [], { async: true }));
  await wq; // every output chunk reached the host
  return { filename: `data.${format}`, mimeType: MIME[format] || 'application/octet-stream' };
}

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

function cellFor(sv, val) {
  if (sv.type === 'string') return val == null ? null : String(val);
  if (val == null || val === '') return NaN;
  const n = Number(val);
  return Number.isNaN(n) ? NaN : n;
}
