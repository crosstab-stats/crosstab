/**
 * @file plugins/builtin-rdata-export/index.js
 * Built-in **R data export** plugin: File ▸ Export data… ▸ R data frame (.rds) /
 * R workspace (.RData).
 *
 * The native R round-trip companion to the R-syntax export and the SPSS/Stata
 * codecs (#97). It writes the current dataset as a real R object so it reopens in
 * R/RStudio with `readRDS()` / `load()` exactly as CrossTab sees it — typed
 * columns, with value-labelled variables as factors.
 *
 * How it gets the data into R without hand-rolling: it asks `webr.run` to inject
 * the whole dataset as the standard `df` data.frame (the same typed injection the
 * analysis plugins use — value labels become factors), then `saveRDS(df, …)` /
 * `save(df, …)` and reads the bytes back. So the export is the engine's own faithful
 * data.frame, not a JS reconstruction.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-rdata-export',
  name: 'R Data Export',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Export',
  keywords: ['r', 'rds', 'rdata', 'dataframe', 'export', 'reproducible'],
  rPackages: [],
  exports: [
    { label: 'R data frame (.rds)…', extensions: ['.rds'], order: 31, export: 'exportRds' },
    { label: 'R workspace (.RData)…', extensions: ['.RData'], order: 32, export: 'exportRData' },
  ],
};

/** Export the dataset as a single-object `.rds` (read back with `readRDS()`). */
export async function exportRds(app) {
  const path = '/tmp/ct_export.rds';
  const data = await writeViaR(app, `saveRDS(df, ${rStr(path)})`, path);
  return { filename: 'crosstab-export.rds', mimeType: 'application/octet-stream', data };
}

/** Export the dataset as an `.RData` workspace holding a `df` object (read back
 * with `load()`, which restores the `df` variable). */
export async function exportRData(app) {
  const path = '/tmp/ct_export.RData';
  const data = await writeViaR(app, `save(df, file = ${rStr(path)})`, path);
  return { filename: 'crosstab-export.RData', mimeType: 'application/octet-stream', data };
}

/**
 * Inject the whole dataset as `df`, run `writeExpr` (which serialises `df` to
 * `outPath`), and return the written bytes.
 *
 * The injection is the host's standard typed data-bridge: declaring one input that
 * references every column makes `webr.run` materialise `df` with all variables
 * (numeric stays numeric; value-labelled variables come through as factors). An
 * exporter sets no host inputs, so passing `injectInputs` here is honoured as-is.
 */
async function writeViaR(app, writeExpr, outPath) {
  const meta = await app.data.getVariableMeta();
  const columns = meta.map((m) => m.name);
  if (!columns.length) throw new Error('no variables to export');
  await app.webr.run(writeExpr, { injectInputs: { all: { kind: 'variables', columns } } });
  const bytes = await app.webr.readFile(outPath);
  if (!bytes || !bytes.length) throw new Error('R produced no output');
  return bytes;
}

/** Quote a string as an R string literal. */
function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
