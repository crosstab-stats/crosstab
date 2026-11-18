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
const { uniqueName } = globalThis.ctStd;

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
const EMIT_CELLS = 2_000_000; // target values per batch; rows-per-batch derived
const READ_CHUNK = 1 << 22; // 4 MiB per random-access read

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
  let header = null;
  let rowCount = 0;
  let numeric = null; // per column: still numeric so far?
  let seen = null; // per column: any non-empty value at all?
  await scan(app, size, delimiter, (row) => {
    if (!header) {
      header = row.map((h, i) => h.trim() || `V${i + 1}`);
      numeric = header.map(() => true);
      seen = header.map(() => false);
      return undefined;
    }
    if (row.length === 1 && row[0] === '') return undefined; // blank trailing line
    rowCount += 1;
    for (let c = 0; c < header.length && c < row.length; c++) {
      const v = row[c];
      if (v === '' || v === undefined) continue;
      seen[c] = true;
      if (numeric[c] && !Number.isFinite(Number(v))) numeric[c] = false;
    }
    return undefined;
  }, (rows) => app.codec.progress(rows, -1));
  if (!header || !header.length) throw new Error('CSV: no columns found');

  const used = {};
  const variables = [];
  const storageTypes = {};
  const isNum = [];
  for (let c = 0; c < header.length; c++) {
    const nm = uniqueName(header[c], used);
    used[nm] = true;
    // A column with no values at all is a string column: there is nothing to say it is
    // a number, and calling it numeric would turn every blank into NaN.
    const num = numeric[c] && seen[c];
    isNum.push(num);
    variables.push({ name: nm, type: num ? 'numeric' : 'string', measurementLevel: num ? 'scale' : 'nominal' });
    storageTypes[nm] = num ? 'numeric' : 'string';
  }

  // --- pass 2: fill and emit ----------------------------------------------------
  await app.codec.begin(variables, storageTypes, { rowCount });
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
      if (isNum[c]) col[fill] = v === '' || v === undefined ? NaN : Number(v);
      else col[fill] = v === '' || v === undefined ? null : v;
    }
    fill += 1;
    // The promise is the signal: `scan` awaits it, so the next row lands in a fresh
    // buffer rather than past the end of a full one.
    return fill >= perBatch ? flush() : undefined;
  }, () => app.codec.progress(emitted + fill, rowCount));
  await flush();
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
