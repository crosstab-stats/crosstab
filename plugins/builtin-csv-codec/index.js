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

export const manifest = {
  id: 'builtin-csv-codec',
  name: 'CSV codec',
  version: '2', // #91: bumped as a freshness marker (watch the plugin-manager badge)
  apiVersion: '0.1.0',
  category: 'Data',
  keywords: ['csv', 'tsv', 'text', 'delimited', 'file'],
  codecs: [
    { id: 'csv', label: 'CSV…', extensions: ['.csv', '.tsv', '.txt'], read: 'readCsv', write: 'writeCsv', order: 10, multiple: true },
  ],
};

const WRITE_BATCH = 50_000;
const EMIT_BATCH = 50_000;

// --- read --------------------------------------------------------------------

/** Decode a delimited file into the dataset. Reads the whole file via the codec's
 * random-access reads, parses it, then streams rows to the host ingest in batches. */
export async function readCsv(app, { name }) {
  const size = await app.codec.size();
  const bytes = await readAll(app, size);
  const text = new TextDecoder('utf-8').decode(bytes);
  const delimiter = /\.tsv$/i.test(name || '') ? '\t' : ',';
  const { variables, storageTypes, columns } = parseCsv(text, delimiter);
  if (!variables.length) throw new Error('CSV: no columns found');

  await app.codec.begin(variables, storageTypes);
  const total = variables.length ? columns[variables[0].name].length : 0;
  for (let off = 0; off < total; off += EMIT_BATCH) {
    const chunk = {};
    for (const v of variables) chunk[v.name] = columns[v.name].slice(off, off + EMIT_BATCH);
    await app.codec.batch(chunk);
  }
}

/** Read the whole source via chunked random-access reads, concatenated. */
async function readAll(app, size) {
  const CHUNK = 1 << 22; // 4 MiB
  const parts = [];
  let off = 0;
  while (off < size) {
    const u8 = await app.codec.read(off, Math.min(CHUNK, size - off));
    if (!u8.length) break;
    parts.push(u8);
    off += u8.length;
  }
  const out = new Uint8Array(off);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** Parse delimited text → {variables, storageTypes, columns} (numeric cols as
 * Float64Array with NaN for missing; string cols as arrays with null for missing). */
function parseCsv(text, delimiter) {
  const rows = tokenize(text, delimiter);
  if (rows.length === 0) return { variables: [], storageTypes: {}, columns: {} };

  const header = rows[0].map((h, i) => h.trim() || `V${i + 1}`);
  const raw = header.map(() => []);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === '') continue; // skip blank trailing line
    for (let c = 0; c < header.length; c++) {
      const cell = row[c];
      raw[c].push(cell === undefined || cell === '' ? null : cell);
    }
  }

  const variables = [];
  const storageTypes = {};
  const columns = {};
  const used = {};
  for (let c = 0; c < header.length; c++) {
    const name = uniqueName(header[c], used);
    used[name] = true;
    const values = raw[c];
    if (isNumericColumn(values)) {
      variables.push({ name, type: 'numeric', measurementLevel: 'scale' });
      storageTypes[name] = 'numeric';
      const a = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) a[i] = values[i] === null ? NaN : Number(values[i]);
      columns[name] = a;
    } else {
      variables.push({ name, type: 'string', measurementLevel: 'nominal' });
      storageTypes[name] = 'string';
      columns[name] = values;
    }
  }
  return { variables, storageTypes, columns };
}

/** True if every non-null value parses as a finite number (and at least one does). */
function isNumericColumn(values) {
  let seen = 0;
  for (const v of values) {
    if (v === null) continue;
    seen++;
    if (!Number.isFinite(Number(v))) return false;
  }
  return seen > 0;
}

/** Ensure a column name is unique within the dataset being built. */
function uniqueName(base, used) {
  if (!(base in used)) return base;
  let i = 2;
  while (`${base}_${i}` in used) i++;
  return `${base}_${i}`;
}

/** Split delimited text into rows of fields, honouring RFC-4180 quoting (quoted
 * fields may contain the delimiter, newlines, and escaped `""`); handles \n and \r\n. */
function tokenize(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
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
