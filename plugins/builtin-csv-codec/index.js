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
const { ingestTable, tableVariableNames } = globalThis.ctStd;

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
    { id: 'csv', label: 'CSV…', extensions: ['.csv', '.tsv', '.txt'], read: 'readCsv', catalog: 'catalogCsv', write: 'writeCsv', order: 10, multiple: true },
  ],
};

const READ_CHUNK = 1 << 22; // 4 MiB per random-access read
const WRITE_BATCH = 50_000; // rows per output flush on export

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
 * Decode a delimited file into the dataset.
 *
 * ## What is left here, and what moved
 *
 * All of it, once: this reader used to own the typing rule, the missing-code detection,
 * the unique-naming, the width routing, the cell-sized batching and the two-pass
 * orchestration. Every one of those is a property of tabular data or of our storage
 * rather than of comma-separated text, and every one of them was therefore re-implemented
 * — differently — by the other codecs. They now live in `ingestTable` (plugin-stdlib),
 * which no codec reimplements.
 *
 * What is genuinely CSV is what remains: the delimiter, RFC-4180 quoting, and reading the
 * source in chunks without ever holding the file. `scan` is handed to `ingestTable` and
 * called twice, which is why it was written to take an `onRow` that may return a promise.
 *
 * ## Why two passes, for the reader coming here from the parse
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
 * The cost of streaming is that a column's TYPE is not known until its last value has
 * been seen, so the file is read twice rather than weakening the rule — see `ingestTable`,
 * which owns that decision now. Re-reading is cheap: the source is a File on disk, already
 * being read in chunks.
 *
 * `dropSingleEmptyRow` is the one genuinely delimited-text quirk that had to travel with
 * the hoist: a file ending in a newline tokenises to a final row of one empty field, and
 * that is not a row. No other format can produce it, so no other format inherits it.
 */
export async function readCsv(app, { name, select }) {
  const size = await app.codec.size();
  const delimiter = /\.tsv$/i.test(name || '') ? '\t' : ',';
  // A plugin's own line in the HOST's log (`app.debugLog`, gated inside the sandbox so a
  // call costs nothing when logging is off). Here because the delimiter is the one
  // decision this reader makes alone, and a `.txt` read as comma-delimited when the file
  // was tab-delimited produces one wide column — which looks like a parse bug and is not.
  app.debugLog?.('read', {
    bytes: size,
    delimiter: delimiter === ',' ? 'comma' : 'tab',
    narrowed: !!select,
  });
  await ingestTable(app, {
    select,
    dropSingleEmptyRow: true,
    scanRows: (onRow, ctx) => scan(app, size, delimiter, onRow, ctx.tick),
  });
}

/**
 * The variable list without the data: the header row, and nothing else.
 *
 * This is the format where "choose which variables to import" costs the least to offer
 * and was previously impossible to ask for — the capability existed only behind a second
 * SPSS/Stata/SAS menu entry, so a 3,379-column CSV could not be subset at all.
 *
 * Reads ONE chunk, not the file. A header is the first line, and 4 MiB of a 67 MB file is
 * enough for any header anyone has written; a file whose first line is longer than that
 * yields a truncated last name, which is why the tokeniser's partial row is discarded
 * rather than used (`tok.push`, never `tok.end`). The names come from the same
 * `tableVariableNames` the import applies, or the user would tick `a_2` and the import
 * would produce something else.
 *
 * No types: inferring them is the two-pass scan, which is the thing this call exists to
 * avoid. The host's picker shows names, which is what someone choosing columns reads.
 */
export async function catalogCsv(app, { name }) {
  const size = await app.codec.size();
  const delimiter = /\.tsv$/i.test(name || '') ? '\t' : ',';
  const u8 = await app.codec.read(0, Math.min(READ_CHUNK, size));
  const tok = tokenizer(delimiter);
  // `push`, so an incomplete final row stays pending and is never mistaken for the
  // header. If the first chunk holds no line break at all there is no complete row and
  // the catalog is empty — the host then says so and imports everything.
  const rows = tok.push(new TextDecoder('utf-8').decode(u8));
  if (!rows.length) return { variables: [] };
  return { variables: tableVariableNames(rows[0]).map((nm) => ({ name: nm })) };
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
