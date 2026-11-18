/**
 * @file plugins/builtin-csv-codec/index.js
 * CSV as a streaming format codec (#98) — replaces the separate builtin-csv-import
 * and builtin-csv-export one-shot plugins with a single read+write codec.
 *
 * Behaviour is preserved from the originals: RFC-4180 quoting (quoted fields with
 * embedded commas/quotes/newlines, `\r\n`), conservative type inference (a column
 * is numeric only if every non-empty value parses as a finite number), unique
 * column names, and CRLF/Excel-friendly output with raw values (factor codes, not
 * labels) so a file round-trips.
 *
 * Read reads the whole file (as the original did) but emits to the host ingest in
 * row batches, so the commit stays memory-bounded (OPFS parts) regardless of size.
 * (True streaming *read* — type inference from a sample rather than the whole file —
 * is a possible later refinement; CSV type inference needs all values to be exact.)
 */

/** The host's shared helpers (core/plugin-stdlib.js). */
const { uniqueName, isWideDataset, createTypeScan } = globalThis.ctStd;

export const manifest = {
  id: 'builtin-csv-codec',
  name: 'CSV codec',
  version: '2', // #91: bumped as a freshness marker (watch the plugin-manager badge)
  apiVersion: '0.1.0',
  category: 'Data',
  keywords: ['csv', 'tsv', 'text', 'delimited', 'file'],
  howto:
    'GUI: File ▸ Import data… (or Export data…), choose CSV (.csv / .tsv / .txt). Reads and writes RFC-4180 delimited text.\n' +
    'Used through the File menu, not a run command.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'codec-csv',
      title: 'CSV and delimited text',
      category: 'Data',
      keywords: ['csv', 'tsv', 'txt', 'delimited', 'comma', 'tab', 'text file', 'import', 'export', 'rfc 4180'],
      needs: ['builtin-csv-codec'],
      seeAlso: ['import-data', 'export-data'],
    },
  ],
  codecs: [
    { id: 'csv', label: 'CSV…', extensions: ['.csv', '.tsv', '.txt'], read: 'readCsv', write: 'writeCsv', order: 10, multiple: true },
  ],
};

const WRITE_BATCH = 50_000;
// Values per ingest batch; rows-per-batch is derived from the file's width.
//
// Sized for the platform that is tight, not the one this is developed on. A batch
// crosses the sandbox boundary by postMessage, and iOS/Safari REFUSES the transfer
// list across an opaque-origin iframe (#91) — so there every batch is CLONED, and the
// transient peak is the batch twice over. At a million values that is 8 MiB doubled
// rather than 16.
//
// Measured at 3,300 columns, ingest time and JS heap after: 500k -> 11.1s/92 MiB,
// 1M -> 10.6s/98 MiB, 2M -> 8.7s/121 MiB. The heap figures are one sample each and
// move with GC timing, so the choice rests on the clone above rather than on them;
// what the timings do show is that the cost of a smaller batch lands on WIDE files,
// where a batch is few rows and the per-column overhead is paid more often.
const EMIT_CELLS = 1_000_000;
const READ_CHUNK = 1 << 22; // 4 MiB per random-access read

// --- missing-value codes (the "NA"/"PS" problem) -----------------------------
//
// College Scorecard's MERGED2025_26_PP.csv is 3,379 columns, of which exactly 19 are
// genuinely text. The other 3,360 are numbers — but only 13 of them TYPE as numeric,
// because the all-or-nothing rule below is defeated by two sentinels: "NA" (15.7M
// values, recovers 2,843 columns on its own) and "PS" (2.6M, 414 on its own). Neither
// alone is enough; together they recover 3,347. Measured on the owner's file,
// 2026-11-18 — and note the documented spelling "PrivacySuppressed" appears ZERO times
// in that release, so a hard-coded list from the docs would have fixed nothing.
//
// Worth knowing when reading those counts: only 708 of the 3,379 columns hold any data
// at all. 2,652 are withheld or unreported for every single institution.
//
// Typed as strings, those 3,347 variables cannot be analysed at all, and they cost
// 322 MiB of DuckDB string slots against 163 MiB as doubles.
//
// So pass 1 also COLLECTS the non-numeric values blocking each column, and the host is
// asked which of them mean "missing" (pre-selected, never applied invisibly — the
// answer belongs to the import, so a replay re-applies it rather than re-asking).
//
// THE RULE AND THE DETECTOR NOW LIVE IN THE HOST (`createTypeScan` in plugin-stdlib),
// not here. They were written here first, and builtin-excel-codec's comment said its
// typing "mirrors the CSV codec" — which is precisely why fixing this file left Excel
// typing 211 of the same 3,379 columns numeric against this reader's 3,360. Typing text
// is a property of tabular data, not of CSV. This reader's job is to hand over rows.

// --- read --------------------------------------------------------------------

/**
 * Decode a delimited file into the dataset, in two streaming passes.
 *
 * ## Why two passes, and why neither holds the file
 *
 * This used to read the whole file, decode it to one JS string, tokenise that into an
 * array of arrays of STRINGS, pivot those into per-column arrays, and only then emit —
 * holding every one of those at once. On a 67 MB College Scorecard extract (~3,300
 * columns) that is ~21 million JS strings, and the import died at 3.1 GiB having never
 * shown a row count:
 *
 *     Out of Memory Error: failed to allocate data of size 1.0 MiB (3.1 GiB/3.1 GiB used)
 *
 * — owner, 2026-11-17. The spinner froze too, because the tokeniser never yielded: the
 * one visible sign of life was blocked by the work it was meant to be reporting.
 *
 * So the parse streams, and the cost of streaming is that a column's TYPE is not known
 * until its last value has been seen. The old code could decide after the fact because
 * it had every value in hand. Rather than weaken that rule — "numeric iff every
 * non-empty value parses as finite", which is what makes a column with one "N/A" stay a
 * string — the file is read twice:
 *
 *   1. count the rows and watch each column for a non-numeric value. Holds one boolean
 *      and one counter per column, and NO cells.
 *   2. re-read, converting each row straight into the output buffers and emitting a
 *      batch whenever enough CELLS have accumulated.
 *
 * Re-reading is cheap — the source is a File on disk, already being read in chunks —
 * and it buys exact typing with bounded memory.
 *
 * ## Batching by cells rather than rows
 *
 * A fixed 50,000-row batch is fine at 10 columns and fatal at 3,300: it is the width
 * that decides how much a batch costs. The batch is therefore sized in VALUES, so a
 * wide file sends more, smaller batches and a narrow one still sends few, large ones.
 * (`builtin-readstat-codec` reached the same conclusion for the same reason.)
 */
export async function readCsv(app, { name }) {
  const size = await app.codec.size();
  const delimiter = /\.tsv$/i.test(name || '') ? '\t' : ',';

  // --- pass 1: the header, the row count, and which columns are numeric ---------
  //
  // The typing RULE is not here. `createTypeScan` is the host's, shared by every codec
  // that has to infer types from text — this reader's only job is to hand it rows.
  let header = null;
  let rowCount = 0;
  let typeScan = null;
  await scan(app, size, delimiter, (row) => {
    if (!header) {
      header = row.map((h, i) => h.trim() || `V${i + 1}`);
      typeScan = createTypeScan({ columns: header.length });
      return undefined;
    }
    if (row.length === 1 && row[0] === '') return undefined; // blank trailing line
    rowCount += 1;
    typeScan.observeRow(row);
    return undefined;
  }, (rows) => app.codec.progress(rows, -1));
  if (!header || !header.length) throw new Error('CSV: no columns found');

  // Which recurring non-numeric values mean "missing"? The host decides (and records
  // the answer against the import); an empty set reproduces the old typing exactly.
  const accepted = await askMissingCodes(app, typeScan);
  const { isNumeric, isMissing } = typeScan.decide(accepted);

  const used = {};
  const variables = [];
  const storageTypes = {};
  const isNum = [];
  for (let c = 0; c < header.length; c++) {
    const nm = uniqueName(header[c], used);
    used[nm] = true;
    const num = !!isNumeric[c];
    isNum.push(num);
    variables.push({ name: nm, type: num ? 'numeric' : 'string', measurementLevel: num ? 'scale' : 'nominal' });
    storageTypes[nm] = num ? 'numeric' : 'string';
  }

  // --- pass 2: fill and emit ----------------------------------------------------
  // A dataset too big for a DuckDB table goes to the out-of-core ingest instead — the
  // host writes Parquet and queries that. readstat has routed on this rule for a while
  // and the CSV reader did not, so a huge CSV built a table however big it was.
  //
  // The rule is about SIZE. Routing on WIDTH was tried and dropped: measured at 3,300
  // columns the parquet path cost MORE (178 MiB of JS heap against 121), because it
  // accumulates a whole row group in JS. See `isWideDataset`.
  const wide = isWideDataset(variables.length, rowCount);
  // `missingCodes` travels with the schema so the ingest — and anything reading the
  // dataset's provenance later — can say WHY a column is numeric (#output-outlives).
  await app.codec.begin(variables, storageTypes, { rowCount, wide, missingCodes: [...accepted] });
  const width = variables.length;
  const perBatch = Math.max(1, Math.min(rowCount || 1, Math.floor(EMIT_CELLS / Math.max(1, width))));
  let buf = newBuffers(variables, isNum, perBatch);
  let fill = 0;
  let emitted = 0;
  let first = true;

  const flush = async () => {
    if (!fill) return;
    await app.codec.batch(sliceBuffers(buf, variables, isNum, fill));
    emitted += fill;
    fill = 0;
    buf = newBuffers(variables, isNum, perBatch);
  };

  await scan(app, size, delimiter, (row) => {
    if (first) { first = false; return undefined; } // header
    if (row.length === 1 && row[0] === '') return undefined;
    for (let c = 0; c < width; c++) {
      const v = c < row.length ? row[c] : '';
      const col = buf[c];
      // `isMissing` is the scan's, so "which values count as missing" is decided in one
      // place and applied identically by every codec — including in a column that stayed
      // text, since the host ticked "NA means missing in this file", not "…in the columns
      // it happened to rescue".
      const missing = isMissing(v);
      if (isNum[c]) col[fill] = missing ? NaN : Number(v);
      else col[fill] = missing ? null : v;
    }
    fill += 1;
    // The promise is the signal: `scan` awaits it, so the next row lands in a fresh
    // buffer rather than past the end of a full one.
    return fill >= perBatch ? flush() : undefined;
  }, () => app.codec.progress(emitted + fill, rowCount));
  await flush();
}

/**
 * Ask the host which recurring non-numeric values should count as missing.
 *
 * Thin on purpose: the detection and the arithmetic are `createTypeScan`'s, shared with
 * every other codec that infers types from text. All that is left here is the call.
 *
 * Returns the empty set when the host does not implement the verb — an older host, or
 * the test harness — which reproduces the old typing byte for byte. The host is asked
 * even when there is nothing to propose, because a REPLAYED import carries the codes
 * accepted the first time and must apply them whether or not this file revision still
 * proposes them.
 *
 * @param {object} app
 * @param {{proposal: () => object}} typeScan
 * @returns {Promise<Set<string>>}
 */
async function askMissingCodes(app, typeScan) {
  if (typeof app.codec.missingCodes !== 'function') return new Set();
  const answer = await app.codec.missingCodes(typeScan.proposal());
  // Anything the host names is honoured even if it was not offered: a recorded import
  // may legitimately carry codes from a different revision of the file.
  return new Set(Array.isArray(answer) ? answer.filter((v) => typeof v === 'string') : []);
}

/** Column buffers for one batch: Float64Array for numeric, plain array for string. */
function newBuffers(variables, isNum, n) {
  return variables.map((_v, c) => (isNum[c] ? new Float64Array(n) : new Array(n)));
}

/** The filled prefix of each buffer, keyed by variable name. */
function sliceBuffers(buf, variables, isNum, n) {
  const out = {};
  for (let c = 0; c < variables.length; c++) {
    out[variables[c].name] = isNum[c] ? buf[c].subarray(0, n) : buf[c].slice(0, n);
  }
  return out;
}

/**
 * Read the file in chunks and hand complete rows to `onRow`, honouring RFC-4180
 * quoting across chunk boundaries.
 *
 * `onRow` may return a promise — pass 2 returns one exactly when a batch filled up —
 * and it is awaited before the next row. That is what keeps a batch at its size: the
 * first version flushed at CHUNK boundaries instead, so a chunk holding more rows than
 * a batch overran the buffers, and because a Float64Array silently ignores a write past
 * its end while a plain Array grows, the numeric and string columns of one batch came
 * out DIFFERENT LENGTHS. Caught in the browser, where a 4 MiB chunk holds ~400 rows of
 * a 3,300-column file against a 606-row batch; node's smaller reads had hidden it.
 *
 * `onTick` is called per chunk so a long scan can say it is alive.
 */
async function scan(app, size, delimiter, onRow, onTick) {
  const decoder = new TextDecoder('utf-8');
  const tok = tokenizer(delimiter);
  let off = 0;
  let rows = 0;

  const feed = async (text, final = false) => {
    for (const row of final ? tok.end(text) : tok.push(text)) {
      rows += 1;
      const wait = onRow(row);
      if (wait) await wait; // eslint-disable-line no-await-in-loop -- a batch flushed
    }
  };

  while (off < size) {
    // eslint-disable-next-line no-await-in-loop -- sequential by nature
    const u8 = await app.codec.read(off, Math.min(READ_CHUNK, size - off));
    if (!u8.length) break;
    off += u8.length;
    // eslint-disable-next-line no-await-in-loop
    await feed(decoder.decode(u8, { stream: true }));
    onTick(rows);
    // Hand the event loop back, every chunk. In the app `read` is a postMessage round
    // trip and would yield anyway, but relying on that puts the responsiveness of the
    // UI at the mercy of how someone else implements a read — and a yield per 4 MiB
    // costs about a millisecond against a parse that takes far longer.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 0); });
  }
  await feed(decoder.decode(), true);
  onTick(rows);
}

/**
 * An incremental RFC-4180 tokeniser: feed it text, get back the rows it completed,
 * with the partial field and row carried over to the next call.
 *
 * It returns rows rather than calling back per row so the caller stays in charge of
 * when to await — a tokeniser that invoked an async callback mid-scan could not be
 * paused, which is the whole reason the batch overran.
 */
function tokenizer(delimiter) {
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let pendingQuote = false; // a '"' inside a quoted field: close, or an escaped '"'?
  let afterCR = false;

  const endField = () => { row.push(field); field = ''; wasQuoted = false; };

  const drain = (text) => {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') { field += '"'; continue; } // escaped quote
        quoted = false; // the field closed
      }
      if (quoted) {
        if (ch === '"') pendingQuote = true;
        else field += ch;
        continue;
      }
      if (afterCR) { afterCR = false; if (ch === '\n') continue; }
      if (ch === '"' && field === '' && !wasQuoted) { quoted = true; wasQuoted = true; continue; }
      if (ch === delimiter) { endField(); continue; }
      if (ch === '\n') { endField(); out.push(row); row = []; continue; }
      if (ch === '\r') { endField(); out.push(row); row = []; afterCR = true; continue; }
      field += ch;
    }
    return out;
  };

  return {
    push: drain,
    end(text) {
      const out = drain(text);
      // A file with no trailing newline still has a last row — unless the stream ended
      // exactly on one, in which case there is nothing pending and adding a row would
      // invent a blank one.
      if (field !== '' || row.length) { endField(); out.push(row); row = []; }
      return out;
    },
  };
}

// --- write -------------------------------------------------------------------

/** Encode the current (derived) dataset as RFC-4180 CSV, streaming rows in batches.
 * Raw values (factor codes, not labels), missing → empty cell, CRLF line endings. */
export async function writeCsv(app, _info) {
  const meta = await app.data.getVariableMeta();
  if (!meta.length) throw new Error('no variables to export');
  const names = meta.map((m) => m.name);
  const total = await app.data.getRowCount();
  const enc = new TextEncoder();

  await app.codec.writeChunk(enc.encode(names.map(csvEscape).join(',') + '\r\n'));
  for (let off = 0; off < total; off += WRITE_BATCH) {
    const rows = await app.data.getRows({ offset: off, limit: WRITE_BATCH });
    let s = '';
    for (const r of rows) s += names.map((n) => csvEscape(formatCell(r[n]))).join(',') + '\r\n';
    await app.codec.writeChunk(enc.encode(s));
  }
  return { filename: 'crosstab-export.csv', mimeType: 'text/csv;charset=utf-8' };
}

function formatCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isNaN(v) ? '' : String(v);
  return String(v);
}

function csvEscape(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
