/**
 * @file plugins/builtin-csv-import/index.js
 * Built-in importer plugin: File ▸ Import ▸ CSV.
 *
 * Demonstrates that **file import is just a plugin**. It registers an importer
 * through the public `app.importers` API — the same call a third party would use
 * to teach CrossTab a brand-new file format — parses the bytes itself (here, in
 * plain JS), and hands the engine a dataset to commit. It imports nothing from
 * `core/` and touches the engine only through the `app` object.
 *
 * The parser is deliberately small but handles the things real CSVs have:
 * quoted fields, embedded commas/quotes/newlines, and `\r\n`. Type inference is
 * conservative: a column is `numeric` only if every non-empty value parses as a
 * finite number; otherwise it stays `string`. (Value labels / factors aren't
 * inferable from raw CSV — that's what a `.sav` import is for.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-csv-import',
  name: 'CSV Import',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Import',
  keywords: ['csv', 'text', 'delimited', 'file'],
  rPackages: [],
};

/**
 * Register the CSV importer. The engine adds the File ▸ Import ▸ CSV menu item
 * and, on use, hands us the chosen file's bytes via the `parse` callback.
 *
 * @param {object} app - The plugin-scoped engine API (every method is async).
 */
export async function activate(app) {
  await app.importers.register({
    id: 'csv',
    label: 'CSV…',
    extensions: ['.csv', '.tsv', '.txt'],
    order: 10,
    multiple: true, // batch-select several CSVs to pool them

    parse: ({ ticket, name, file }) => importCsv(app, ticket, name, file),
  });
}

/**
 * Parse the bytes and deliver the dataset back to the engine. Any failure is
 * reported in the results pane; the engine drops the ticket either way.
 *
 * @param {object} app
 * @param {number} ticket - Opaque token tying this parse to the engine's request.
 * @param {string} name - Original file name (used to pick the delimiter).
 * @param {Blob} file - The uploaded file (a `File` is a `Blob`).
 */
async function importCsv(app, ticket, name, file) {
  try {
    const text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
    const delimiter = name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const dataset = parseCsv(text, delimiter);
    if (dataset.variables.length === 0) throw new Error('no columns found');
    await app.importers.deliver(ticket, dataset);
  } catch (err) {
    await app.results.appendError(`CSV parse failed: ${err.message}`);
    // Settle the ticket but abort: delivering null tells the engine not to
    // clobber the loaded dataset with a failed/empty import.
    await app.importers.deliver(ticket, null);
  }
}

/**
 * Parse delimited text into the importer dataset shape
 * (`{ variables, columns }`).
 *
 * @param {string} text
 * @param {string} delimiter
 * @returns {{ variables: object[], columns: Object<string, Array> }}
 */
function parseCsv(text, delimiter) {
  const rows = tokenize(text, delimiter);
  if (rows.length === 0) return { variables: [], columns: {} };

  const header = rows[0].map((h, i) => h.trim() || `V${i + 1}`);
  const body = rows.slice(1);

  // Initialise a parallel array per column.
  const raw = header.map(() => []);
  for (const row of body) {
    // Skip fully empty trailing lines.
    if (row.length === 1 && row[0] === '') continue;
    for (let c = 0; c < header.length; c++) {
      const cell = row[c];
      raw[c].push(cell === undefined || cell === '' ? null : cell);
    }
  }

  const variables = [];
  const columns = {};
  for (let c = 0; c < header.length; c++) {
    const name = uniqueName(header[c], columns);
    const values = raw[c];
    if (isNumericColumn(values)) {
      variables.push({ name, type: 'numeric', measurementLevel: 'scale' });
      columns[name] = values.map((v) => (v === null ? null : Number(v)));
    } else {
      variables.push({ name, type: 'string', measurementLevel: 'nominal' });
      columns[name] = values;
    }
  }
  return { variables, columns };
}

/** @returns {boolean} True if every non-null value parses as a finite number. */
function isNumericColumn(values) {
  let seen = 0;
  for (const v of values) {
    if (v === null) continue;
    seen++;
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
  }
  return seen > 0; // an all-empty column stays string
}

/** Ensure a column name is unique within the dataset being built. */
function uniqueName(base, columns) {
  if (!(base in columns)) return base;
  let i = 2;
  while (`${base}_${i}` in columns) i++;
  return `${base}_${i}`;
}

/**
 * Split delimited text into rows of fields, honouring RFC-4180-style quoting:
 * double-quoted fields may contain the delimiter, newlines, and escaped quotes
 * (`""`). Handles `\n` and `\r\n` line endings.
 *
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
function tokenize(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Close the field/row; swallow the paired \n of a \r\n.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Flush any trailing field/row not terminated by a newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
