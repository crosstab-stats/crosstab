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
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Export',
  keywords: ['csv', 'data'],
  rPackages: [],
};

/** @param {object} app - The plugin-scoped engine API (every method is async). */
export async function activate(app) {
  await app.exporters.register({
    id: 'csv-export',
    label: 'CSV…',
    extensions: ['.csv'],
    order: 10,
    export: ({ ticket }) => exportCsv(app, ticket),
  });
}

/**
 * Pull the columns, build a CSV string, and deliver it. Any failure is reported
 * in the results pane; the engine drops the ticket either way.
 *
 * @param {object} app
 * @param {number} ticket
 */
async function exportCsv(app, ticket) {
  try {
    const meta = await app.data.getVariableMeta();
    if (!meta.length) throw new Error('no variables to export');
    const names = meta.map((m) => m.name);

    const cols = await app.data.getColumns();
    const rowCount = await app.data.getRowCount();

    const lines = [names.map(csvEscape).join(',')];
    for (let r = 0; r < rowCount; r++) {
      const cells = names.map((name) => {
        const col = cols[name];
        const v = col ? col[r] : null;
        return csvEscape(formatCell(v));
      });
      lines.push(cells.join(','));
    }
    // CRLF line endings (RFC-4180; also the friendliest for Excel on Windows).
    const data = lines.join('\r\n');

    await app.exporters.deliver(ticket, {
      filename: 'crosstab-export.csv',
      mimeType: 'text/csv;charset=utf-8',
      data,
    });
  } catch (err) {
    await app.results.appendError(`CSV export failed: ${err.message}`);
    await app.exporters.deliver(ticket, null);
  }
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
