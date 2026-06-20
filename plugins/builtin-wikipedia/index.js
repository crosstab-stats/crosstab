/**
 * @file plugins/builtin-wikipedia/index.js
 * Built-in importer plugin: File ▸ Import ▸ Wikipedia table.
 *
 * Point it at any Wikipedia article (URL or title) and it pulls a table off the
 * page into a dataset — country statistics, sports records, historical series,
 * whatever has a `wikitable` on it. A second example of the **`web` importer
 * source** (after FRED), and the first *scrape*-style importer.
 *
 * ## Why no proxy is needed
 * Wikipedia's human article URL (`…/wiki/Title`) sends no CORS header, so a
 * direct browser fetch of it is blocked. But Wikipedia's **REST API**
 * (`…/api/rest_v1/page/html/<Title>`) is CORS-open and returns the same rendered
 * article HTML — tables included. So we translate whatever the user pastes into
 * that endpoint and fetch it straight through `app.web.get`, no CORS proxy.
 *
 * ## What it does, and its limits
 * Parsing uses the browser's native `DOMParser` (already in the sandbox) — no R,
 * no second WASM runtime. It flattens `colspan`/`rowspan`, strips `[1]`-style
 * footnote markers, and infers a column as numeric when most of its cells start
 * with a number (so `"168.2 cm (5 ft 6 in)"` → `168.2`, `"1,234"` → `1234`).
 * Real-world tables are messy; this is best-effort, not guaranteed-clean. It
 * pulls ONE table per import — to combine tables across pages by a key (e.g.
 * height vs. electricity by country) you'd need a dataset *join*, which the
 * engine doesn't have yet (append only stacks rows). See TODO.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-wikipedia',
  name: 'Wikipedia Table Import',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Import',
  keywords: ['web', 'scrape', 'table', 'wikipedia'],
  rPackages: [],
  imports: [{ label: 'Wikipedia table…', source: 'web', order: 60, parse: 'importTable' }],
};

/**
 * Declarative `web` importer: prompt for a page, fetch it, let the user pick a
 * table, and **return** it as a dataset (or `null` if cancelled; throw on error).
 *
 * @param {object} app
 * @returns {Promise<object|null>}
 */
export async function importTable(app) {
  const form = await app.ui.showForm({
    title: 'Import a Wikipedia table',
    hint: 'Paste an article URL or just its title.',
    okLabel: 'Fetch',
    fields: [
      { name: 'page', label: 'Article', placeholder: 'e.g. Human height by country', hint: '(URL or title)' },
    ],
  });
  if (!form) return null;
  const raw = (form.page || '').trim();
  if (!raw) throw new Error('an article URL or title is required');

  const { lang, title } = parsePage(raw);
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`;
  const res = await app.web.get(url);
  if (!res.ok) {
    throw new Error(
      res.status === 404 ? `no Wikipedia article found for "${title}"` : `fetch failed (HTTP ${res.status})`,
    );
  }

  const doc = new DOMParser().parseFromString(res.text, 'text/html');
  const tables = findDataTables(doc);
  if (tables.length === 0) throw new Error('no data tables found on that page');

  let chosen = tables[0];
  if (tables.length > 1) {
    const items = tables.map((t, i) => ({ value: String(i), label: describeTable(t, i) }));
    const picked = await app.ui.selectFromList({
      title: 'Choose a table',
      hint: `${tables.length} tables on this page — pick one to import.`,
      items,
      multiple: false,
      okLabel: 'Import',
      searchPlaceholder: 'Filter tables…',
    });
    if (!picked || picked.length === 0) return null; // cancelled
    chosen = tables[Number(picked[0])];
  }

  const dataset = extractTable(chosen);
  if (dataset.variables.length === 0) throw new Error('the chosen table had no usable columns');
  dataset.source = title.replace(/_/g, ' ');
  return dataset;
}

/**
 * Work out the wiki language subdomain and page title from whatever the user
 * pasted: a full URL, a `lang.wikipedia.org/wiki/Title`, or a bare title.
 *
 * @param {string} input
 * @returns {{ lang: string, title: string }}
 */
function parsePage(input) {
  const m = input.match(/^(?:https?:\/\/)?(\w+)\.wikipedia\.org\/wiki\/([^?#]+)/i);
  if (m) {
    return { lang: m[1].toLowerCase(), title: decodeURIComponent(m[2]) };
  }
  // A bare title (possibly with spaces); the REST API accepts underscores.
  return { lang: 'en', title: input.replace(/\s+/g, '_') };
}

/**
 * Collect the tables worth offering: prefer `wikitable`s (the data-table class);
 * if a page has none, fall back to any reasonably sized table that isn't an
 * infobox/navbox/etc.
 *
 * @param {Document} doc
 * @returns {HTMLTableElement[]}
 */
function findDataTables(doc) {
  const wikitables = [...doc.querySelectorAll('table.wikitable')];
  if (wikitables.length) return wikitables;
  const SKIP = /(navbox|infobox|metadata|sidebar|vertical-navbox|ambox|toccolours|mbox)/i;
  return [...doc.querySelectorAll('table')].filter(
    (t) => !SKIP.test(t.className || '') && t.rows.length >= 3,
  );
}

/** A short, searchable one-line description of a table for the picker. */
function describeTable(table, index) {
  const caption = table.querySelector('caption');
  const cap = caption ? cleanText(caption) : '';
  const headRow = table.rows[0];
  const heads = headRow
    ? [...headRow.cells].map((c) => cleanText(c)).filter(Boolean).slice(0, 4).join(', ')
    : '';
  const dims = `${table.rows.length}×${headRow ? headRow.cells.length : '?'}`;
  return `Table ${index + 1} (${dims})${cap ? ` — ${cap}` : ''}${heads ? `: ${heads}` : ''}`;
}

/**
 * Turn an HTML table into the importer dataset shape (`{ variables, columns }`),
 * flattening spans, naming columns from the header rows, and inferring numeric
 * columns.
 *
 * @param {HTMLTableElement} table
 * @returns {{ variables: object[], columns: Object<string, Array> }}
 */
function extractTable(table) {
  const matrix = tableToMatrix(table);
  if (matrix.length === 0) return { variables: [], columns: {} };
  const width = Math.max(...matrix.map((r) => r.length));

  // Leading rows where every present cell is a <th> are the header.
  let headerRows = 0;
  for (const row of matrix) {
    const cells = row.filter(Boolean);
    if (cells.length && cells.every((c) => c.isHeader)) headerRows++;
    else break;
  }

  // Column names: stack the header-row texts for each column (de-duping the
  // repeats that colspan expansion produces), join with a space.
  const names = [];
  for (let c = 0; c < width; c++) {
    const parts = [];
    for (let r = 0; r < headerRows; r++) {
      const tx = matrix[r][c]?.text || '';
      if (tx && parts[parts.length - 1] !== tx) parts.push(tx);
    }
    names.push(parts.join(' ').trim());
  }

  const dataRows = matrix.slice(headerRows || 0);
  const columns = {};
  const variables = [];
  for (let c = 0; c < width; c++) {
    const rawCol = dataRows.map((row) => {
      const tx = row[c]?.text;
      return tx === undefined || tx === '' ? null : tx;
    });
    const name = uniqueName(names[c] || `Column ${c + 1}`, columns);

    if (isNumericColumn(rawCol)) {
      columns[name] = rawCol.map((v) => (v === null ? null : toNumber(v)));
      variables.push({ name, type: 'numeric', measurementLevel: 'scale' });
    } else {
      columns[name] = rawCol;
      variables.push({ name, type: 'string', measurementLevel: 'nominal' });
    }
  }
  return { variables, columns };
}

/**
 * Flatten a table into a rectangular matrix of `{ text, isHeader }`, expanding
 * `colspan`/`rowspan` so every logical cell lands in its grid position.
 *
 * @param {HTMLTableElement} table
 * @returns {Array<Array<{text: string, isHeader: boolean}>>}
 */
function tableToMatrix(table) {
  const matrix = [];
  const rows = [...table.rows];
  for (let r = 0; r < rows.length; r++) {
    matrix[r] = matrix[r] || [];
    let c = 0;
    for (const cell of [...rows[r].cells]) {
      while (matrix[r][c] !== undefined) c++; // skip cells filled by a rowspan above
      const value = { text: cleanText(cell), isHeader: cell.tagName === 'TH' };
      const colspan = clampSpan(cell.getAttribute('colspan'));
      const rowspan = clampSpan(cell.getAttribute('rowspan'));
      for (let i = 0; i < rowspan; i++) {
        matrix[r + i] = matrix[r + i] || [];
        for (let j = 0; j < colspan; j++) matrix[r + i][c + j] = value;
      }
      c += colspan;
    }
  }
  return matrix;
}

/** Parse a span attribute, defaulting to 1 and capping runaway values. */
function clampSpan(attr) {
  const n = parseInt(attr || '1', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 1;
}

/**
 * Visible text of a cell, cleaned for data use. Parsoid inlines `<style>`
 * (TemplateStyles) and `<link>` nodes inside cells — their text would otherwise
 * leak into `textContent` (e.g. a stray `font-size:80%` becoming the number
 * `80`), so they're removed first. `<br>` becomes a space so multi-line headers
 * like `Average<br>male height` don't run together. Footnote markers (`[1]`) and
 * runs of whitespace are collapsed.
 */
function cleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('style, script, link').forEach((n) => n.remove());
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return (clone.textContent || '')
    .replace(/\[[^\]]*\]/g, '') // [1], [note 2], [a]
    .replace(/ /g, ' ') // nbsp
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull a leading number out of a cell, tolerating thousands separators, units,
 * and parentheticals: `"1,234 kWh"` → 1234, `"168.2 cm (5 ft)"` → 168.2.
 * Returns `null` for non-numeric / placeholder cells.
 */
function toNumber(s) {
  let t = String(s).replace(/,(?=\d{3}\b)/g, ''); // strip thousands separators
  if (t === '' || /^(n\/?a|—|–|-|\.{2,}|\?)$/i.test(t.trim())) return null;
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** A column is numeric if most of its non-empty cells start with a number. */
function isNumericColumn(values) {
  let nonEmpty = 0;
  let numeric = 0;
  for (const v of values) {
    if (v === null) continue;
    nonEmpty++;
    if (toNumber(v) !== null) numeric++;
  }
  return numeric >= 3 && numeric / nonEmpty >= 0.6;
}

/** Ensure a column name is unique (and non-empty) within the dataset. */
function uniqueName(base, columns) {
  const name = base || 'Column';
  if (!(name in columns)) return name;
  let i = 2;
  while (`${name}_${i}` in columns) i++;
  return `${name}_${i}`;
}
