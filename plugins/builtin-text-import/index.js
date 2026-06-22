/**
 * @file plugins/builtin-text-import/index.js
 * Built-in importer plugin: File ▸ Import ▸ Text files (one row per file).
 *
 * Turns a collection of plain-text files into a codeable corpus for the CAQDAS
 * coding workspace (#67): batch-select your `.txt` files and each becomes one row
 * — a `document` column (the file name) and a `text` column (the contents). That's
 * exactly the shape CAQDAS expects (one document per row, a text column).
 *
 * Mechanism: each file's `parse` returns a SINGLE-row dataset; the engine's
 * existing multi-file import stacks them (UNION) into an N-row dataset. So no
 * special "folder import" path is needed — `multiple: true` + a one-row-per-file
 * parser reuses the same batching every importer gets. (Select multiple files in
 * the picker; true directory picking isn't portable to iPad Safari.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-text-import',
  name: 'Text Import',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Import',
  keywords: ['text', 'txt', 'qualitative', 'corpus', 'documents', 'transcripts', 'coding'],
  disciplines: ['qualitative', 'sociology', 'education', 'communication', 'anthropology', 'nursing'],
  imports: [
    {
      label: 'Text files → one row per file…',
      extensions: ['.txt', '.text', '.md'],
      order: 15,
      multiple: true, // batch-select the whole folder's files; each becomes a row
      parse: 'parseFile',
    },
  ],
};

/**
 * Read one text file into a single-row dataset. The host stacks the rows from a
 * multi-file selection into one corpus (replace for the first file, append for
 * the rest). Declarative importer: return `{variables, columns}` (or throw).
 *
 * @param {object} app
 * @param {{name: string, file: Blob}} input
 * @returns {Promise<{variables: object[], columns: object}>}
 */
export async function parseFile(app, { name, file }) {
  const text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
  const document = String(name).replace(/\.[^.]+$/, '') || String(name);
  return {
    variables: [
      { name: 'document', type: 'string', measurementLevel: 'nominal', label: 'Source file' },
      { name: 'text', type: 'string', measurementLevel: 'nominal', label: 'Document text' },
    ],
    columns: { document: [document], text: [text] },
  };
}
