/**
 * @file plugins/builtin-rdata-export/index.js
 * Built-in **R data export** plugin: File ▸ Export data… ▸ R data frame (.rds) /
 * R workspace (.RData).
 *
 * The native-R round-trip companion to the R-syntax export and the SPSS/Stata
 * codecs (#97). It writes the current dataset as a real R object so it reopens in
 * R/RStudio with `readRDS()` / `load()` — typed columns, with value-labelled
 * variables as factors.
 *
 * It uses only the file-exporter surface: read the whole dataset through
 * `app.data` (getVariableMeta + getColumns — the columnar form), assemble the
 * `data.frame` in R from those columns, and `saveRDS`/`save` it, reading the bytes
 * back via `app.webr.readFile`. (It deliberately does NOT borrow the analysis
 * plugins' `df` injection — that's the analysis-action data path, not the exporter
 * API.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-rdata-export',
  name: 'R Data Export',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Export',
  keywords: ['r', 'rds', 'rdata', 'dataframe', 'export', 'reproducible'],
  howto:
    'GUI: File ▸ Export data…, choose R data frame (.rds) or R workspace (.RData). ' +
    'Writes a real R object (typed columns, value-labelled vars as factors) that reopens with readRDS()/load().\n' +
    'Used through the File menu, not a run command.',
  rPackages: [],
  exports: [
    { label: 'R data frame (.rds)…', extensions: ['.rds'], order: 31, export: 'exportRds' },
    { label: 'R workspace (.RData)…', extensions: ['.RData'], order: 32, export: 'exportRData' },
  ],
};

/** Export the dataset as a single-object `.rds` (read back with `readRDS()`). */
export async function exportRds(app) {
  const path = '/tmp/ct_export.rds';
  const data = await writeFrame(app, `saveRDS(df, ${strLit(path)})`, path);
  return { filename: 'crosstab-export.rds', mimeType: 'application/octet-stream', data };
}

/** Export the dataset as an `.RData` workspace holding a `df` object (read back
 * with `load()`, which restores the `df` variable). */
export async function exportRData(app) {
  const path = '/tmp/ct_export.RData';
  const data = await writeFrame(app, `save(df, file = ${strLit(path)})`, path);
  return { filename: 'crosstab-export.RData', mimeType: 'application/octet-stream', data };
}

/**
 * Build `df` in R from the dataset's columns (read via the exporter's own
 * `app.data` surface), run `writeExpr` to serialise it, and return the bytes.
 *
 * The data.frame is assembled column-by-column so each variable keeps its type:
 * numeric → numeric, value-labelled factor → `factor()` with the labels, anything
 * else → character. Big datasets produce a large R expression (the columns are
 * embedded) — fine for the typical export; a streaming codec is the path for the
 * multi-GB case.
 */
async function writeFrame(app, writeExpr, outPath) {
  const meta = await app.data.getVariableMeta();
  if (!meta.length) throw new Error('no variables to export');
  const names = meta.map((m) => m.name);
  const cols = await app.data.getColumns({ variables: names });
  const assigns = meta.map((m) => `  ${rName(m.name)} = ${rVector(m, Array.from(cols[m.name] ?? []))}`);
  const rCode =
    `df <- data.frame(\n${assigns.join(',\n')},\n  check.names = FALSE, stringsAsFactors = FALSE\n)\n` +
    writeExpr;
  await app.webr.run(rCode);
  const bytes = await app.webr.readFile(outPath);
  if (!bytes || !bytes.length) throw new Error('R produced no output');
  return bytes;
}

/** Render one column as a typed R vector literal. */
function rVector(m, col) {
  if (m.type === 'numeric') {
    return `as.numeric(c(${col.map(numLit).join(', ')}))`;
  }
  const labels = m.valueLabels && typeof m.valueLabels === 'object' ? m.valueLabels : null;
  if (m.type === 'factor' && labels && Object.keys(labels).length) {
    // Raw values are factor *codes*; map them to labelled levels so the .rds opens
    // as a proper R factor (codes → labels), preserving the value labels.
    const codes = Object.keys(labels);
    const numericCodes = codes.every((c) => Number.isFinite(Number(c)));
    const levelLits = numericCodes ? codes.map((c) => String(Number(c))) : codes.map(strLit);
    const valLits = col.map((v) => (v == null ? 'NA' : numericCodes ? numLit(v) : strLit(String(v))));
    const labelLits = codes.map((c) => strLit(labels[c]));
    return `factor(c(${valLits.join(', ')}), levels = c(${levelLits.join(', ')}), labels = c(${labelLits.join(', ')}))`;
  }
  return `c(${col.map((v) => (v == null ? 'NA' : strLit(String(v)))).join(', ')})`;
}

/** Numeric R literal: non-finite / missing → NA. */
function numLit(v) {
  return v == null || !Number.isFinite(Number(v)) ? 'NA' : String(Number(v));
}

/** R string literal (double-quoted, escaped). */
function strLit(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '')}"`;
}

/** Backtick-quote a column name so spaces/punctuation survive into the data.frame. */
function rName(n) {
  return '`' + String(n).replace(/`/g, '') + '`';
}
