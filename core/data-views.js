/**
 * @file data-views.js
 * Read-only SPSS-style views of the dataset: a virtualised **Data View** (the
 * cell grid) and a **Variable View** (per-variable metadata). These are core
 * host UI — like the menubar and sidebar — not plugins: a sandboxed plugin can't
 * draw interactive host DOM, and a real grid over hundreds of thousands of rows
 * must virtualise (render only the visible window), which is inherently
 * interactive. They read straight from {@link DataStore}.
 *
 * Editing is intentionally absent: mutating data needs the transform/recode API.
 * This is a viewer — "see the data before deciding how to recode".
 */

const ROW_H = 28; // px; must match the CSS cell height for scrollbar accuracy.
const COL_W = 120; // px; fixed column width so columns can be virtualised too.
const GUT_W = 56; // px; the sticky row-number gutter.
const ROW_BUF = 8; // rows rendered above/below the viewport.
const COL_BUF = 3; // columns rendered left/right of the viewport.

/**
 * Virtualised cell grid (rows = cases, columns = variables), windowed in **both**
 * dimensions: only the rows *and* columns near the viewport are in the DOM, and
 * each scroll fetches just that block from DuckDB via {@link DataStore#getRows}.
 * This keeps a wide dataset (e.g. GSS's ~980 variables) smooth — without column
 * windowing a single screen would be tens of thousands of cells. Factor codes
 * display as their value labels (raw code on hover).
 */
export class DataView {
  /** @param {HTMLElement} host - The scroll container. @param {import('./data-store.js').DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
    this.metas = [];
    this.token = 0; // guards against stale async windows
    this.raf = null;
    this.lastKey = null; // `${startRow}:${startCol}` of the rendered block

    this.table = document.createElement('table');
    this.table.className = 'grid';
    this.thead = document.createElement('thead');
    this.tbody = document.createElement('tbody');
    this.table.append(this.thead, this.tbody);
    this.host.replaceChildren(this.table);
    this.host.addEventListener('scroll', () => this.#onScroll());
  }

  /** Rebuild from scratch (call on data change or first show). */
  async refresh() {
    this.metas = this.store.getVariableMeta();
    this.host.scrollTop = 0;
    this.host.scrollLeft = 0;
    this.lastKey = null;
    // Size the table to the full virtual extent so both scrollbars span all data.
    this.table.style.width = `${GUT_W + this.metas.length * COL_W}px`;
    await this.#render(true);
  }

  #onScroll() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.#render(false);
    });
  }

  async #render(force) {
    const total = this.store.rowCount;
    const nCols = this.metas.length;
    if (total === 0 || nCols === 0) {
      this.thead.replaceChildren();
      this.tbody.replaceChildren();
      return;
    }

    const viewH = this.host.clientHeight || 400;
    const viewW = this.host.clientWidth || 600;
    const startRow = Math.max(0, Math.floor(this.host.scrollTop / ROW_H) - ROW_BUF);
    const visRows = Math.ceil(viewH / ROW_H) + ROW_BUF * 2;
    const endRow = Math.min(total, startRow + visRows);
    const startCol = Math.max(0, Math.floor(this.host.scrollLeft / COL_W) - COL_BUF);
    const visCols = Math.ceil(viewW / COL_W) + COL_BUF * 2;
    const endCol = Math.min(nCols, startCol + visCols);

    // Skip if the visible block hasn't moved (cheap small scrolls within buffer).
    const key = `${startRow}:${startCol}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    const winMetas = this.metas.slice(startCol, endCol);
    const token = ++this.token;
    const rows = await this.store.getRows({
      offset: startRow,
      limit: endRow - startRow,
      variables: winMetas.map((m) => m.name),
    });
    if (token !== this.token) return; // a newer scroll superseded this fetch

    const leftW = startCol * COL_W;
    const rightW = (nCols - endCol) * COL_W;

    // Header: corner + left spacer + visible column headers + right spacer.
    const htr = document.createElement('tr');
    htr.append(el('th', '', 'corner'));
    if (leftW > 0) htr.append(hspacer('th', leftW));
    for (const m of winMetas) {
      const th = el('th', m.label || m.name);
      th.title = `${m.name} · ${m.type}${m.measurementLevel ? ` · ${m.measurementLevel}` : ''}`;
      htr.append(th);
    }
    if (rightW > 0) htr.append(hspacer('th', rightW));
    this.thead.replaceChildren(htr);

    // Body: top spacer row + visible rows + bottom spacer row.
    const span = winMetas.length + 1 + (leftW > 0 ? 1 : 0) + (rightW > 0 ? 1 : 0);
    const frag = document.createDocumentFragment();
    if (startRow > 0) frag.append(vspacerRow(startRow * ROW_H, span));
    rows.forEach((row, i) => frag.append(this.#rowEl(startRow + i + 1, row, winMetas, leftW, rightW)));
    const tail = total - endRow;
    if (tail > 0) frag.append(vspacerRow(tail * ROW_H, span));
    this.tbody.replaceChildren(frag);
  }

  #rowEl(num, row, winMetas, leftW, rightW) {
    const tr = document.createElement('tr');
    tr.append(el('td', String(num), 'rownum'));
    if (leftW > 0) tr.append(hspacer('td', leftW));
    for (const m of winMetas) {
      const v = row[m.name];
      let td;
      if (v === null || v === undefined) {
        td = el('td', '·', 'na');
      } else if (m.type === 'factor' && m.valueLabels && m.valueLabels[v] !== undefined) {
        td = el('td', String(m.valueLabels[v]));
        td.title = String(v); // raw code on hover
      } else {
        td = el('td', String(v), m.type === 'numeric' ? 'num' : '');
      }
      tr.append(td);
    }
    if (rightW > 0) tr.append(hspacer('td', rightW));
    return tr;
  }
}

/**
 * Per-variable metadata table: name, label, type, measure, a summary of value
 * labels, and user-missing codes. Small (one row per variable), so it just
 * renders fully — the consolidated picture most useful before recoding.
 */
export class VariableView {
  /** @param {HTMLElement} host @param {import('./data-store.js').DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
  }

  render() {
    const metas = this.store.getVariableMeta();
    if (metas.length === 0) {
      this.host.innerHTML = '<p class="grid-empty">No data loaded. Use File ▸ Import.</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'vargrid';
    const head = document.createElement('tr');
    for (const h of ['Name', 'Label', 'Type', 'Measure', 'Value labels', 'Missing']) {
      head.append(el('th', h));
    }
    table.append(elWrap('thead', head));

    const body = document.createElement('tbody');
    for (const m of metas) {
      const tr = document.createElement('tr');
      tr.append(elCode('td', m.name));
      tr.append(el('td', m.label || ''));
      tr.append(el('td', m.type));
      tr.append(el('td', m.measurementLevel || ''));
      tr.append(el('td', summariseLabels(m.valueLabels)));
      tr.append(el('td', (m.missingValues || []).join(', ')));
      body.append(tr);
    }
    table.append(body);
    this.host.replaceChildren(table);
  }
}

// --- helpers -----------------------------------------------------------------

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function elWrap(tag, child) {
  const e = document.createElement(tag);
  e.append(child);
  return e;
}

function elCode(tag, text) {
  const e = document.createElement(tag);
  const c = document.createElement('code');
  c.textContent = text;
  e.append(c);
  return e;
}

/** A zero-content row of a given pixel height — the vertical (row) spacer. */
function vspacerRow(heightPx, colspan) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = 'spacer';
  td.style.height = `${Math.max(0, heightPx)}px`;
  tr.append(td);
  return tr;
}

/** A zero-content cell of a given pixel width — the horizontal (column) spacer
 * that holds the place of the off-screen columns so the scroll extent is right. */
function hspacer(tag, widthPx) {
  const cell = document.createElement(tag);
  cell.className = 'spacer';
  cell.style.width = `${Math.max(0, widthPx)}px`;
  cell.style.minWidth = `${Math.max(0, widthPx)}px`;
  return cell;
}

/** Compact "1=Male; 2=Female" summary (truncated) for the Variable View. */
function summariseLabels(valueLabels) {
  if (!valueLabels) return '';
  const entries = Object.entries(valueLabels);
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 6).map(([code, label]) => `${code}=${label}`);
  if (entries.length > 6) parts.push(`… (${entries.length} total)`);
  return parts.join('; ');
}
