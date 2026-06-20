/**
 * @file plugins/builtin-csv-export/index.js
 * Built-in exporter plugin: File ▸ Export ▸ CSV.
 *
 * The mirror of the CSV *importer*: it registers through the public
 * `app.exporters` API — the same call a third party would use to add a new output
 * format — reads the current data through `app.data`, formats it as RFC-4180 CSV,
 * and hands the engine the bytes to download.
 *
 * It exports the **derived view**, so any recodes/retypes in the transform log
 * are already applied (the source data itself stays immutable). Values are
 * written **raw** (factor codes, not value labels) so the file round-trips back
 * through the CSV importer; a labels-vs-codes option can come later. Missing
 * values (numeric `NaN`, text `null`) become empty cells.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-csv-export',
  name: 'CSV Export',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Export',
  keywords: ['csv', 'data'],
  rPackages: [],
  exports: [{ label: 'CSV…', extensions: ['.csv'], order: 10, export: 'exportData' }],
};

/**
 * Build a CSV of the current (derived) data and return the bytes for the host to
 * download. Declarative exporter: the host runs this and downloads the result.
 *
 * @param {object} app
 * @returns {Promise<{filename: string, mimeType: string, data: string}>}
 */
export async function exportData(app) {
  const meta = await app.data.getVariableMeta();
  if (!meta.length) throw new Error('no variables to export');
  const names = meta.map((m) => m.name);

  const cols = await app.data.getColumns();
  const rowCount = await app.data.getRowCount();

  const lines = [names.map(csvEscape).join(',')];
  for (let r = 0; r < rowCount; r++) {
    const cells = names.map((name) => {
      const col = cols[name];
      return csvEscape(formatCell(col ? col[r] : null));
    });
    lines.push(cells.join(','));
  }
  return {
    filename: 'crosstab-export.csv',
    mimeType: 'text/csv;charset=utf-8',
    data: lines.join('\r\n'), // CRLF (RFC-4180; Excel-friendly)
  };
}

/**
 * One cell's value → its string form. Missing (numeric `NaN`, `null`/`undefined`)
 * becomes an empty string; everything else is stringified as-is.
 *
 * @param {number|string|null|undefined} v
 * @returns {string}
 */
function formatCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isNaN(v) ? '' : String(v);
  return String(v);
}

/**
 * RFC-4180 field escaping: wrap in quotes (doubling any internal quote) when the
 * value contains a comma, quote, or newline.
 *
 * @param {string} s
 * @returns {string}
 */
function csvEscape(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
