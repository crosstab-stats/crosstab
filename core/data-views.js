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

/**
 * Virtualised cell grid (rows = cases, columns = variables). Renders only the
 * rows in (and just around) the viewport, fetching each window from DuckDB via
 * {@link DataStore#getRows}. Factor codes display as their value labels.
 */
export class DataView {
  /** @param {HTMLElement} host - The scroll container. @param {import('./data-store.js').DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
    this.metas = [];
    this.token = 0; // guards against stale async windows
    this.raf = null;

    this.table = document.createElement('table');
    this.table.className = 'grid';
    this.thead = document.createElement('thead');
    this.tbody = document.createElement('tbody');
    this.table.append(this.thead, this.tbody);
    this.host.replaceChildren(this.table);
    this.host.addEventListener('scroll', () => this.#onScroll());
  }

  /** Rebuild header + first window (call on data change or first show). */
  async refresh() {
    this.metas = this.store.getVariableMeta();
    this.#renderHeader();
    this.host.scrollTop = 0;
    await this.#renderWindow();
  }

  #renderHeader() {
    const tr = document.createElement('tr');
    tr.append(el('th', '', 'corner'));
    for (const m of this.metas) {
      const th = el('th', m.label || m.name);
      th.title = `${m.name} · ${m.type}${m.measurementLevel ? ` · ${m.measurementLevel}` : ''}`;
      tr.append(th);
    }
    this.thead.replaceChildren(tr);
  }

  #onScroll() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.#renderWindow();
    });
  }

  async #renderWindow() {
    const total = this.store.rowCount;
    if (total === 0 || this.metas.length === 0) {
      this.tbody.replaceChildren(spacerRow(0, 1)); // empty
      return;
    }
    const buffer = 10;
    const viewH = this.host.clientHeight || 400;
    const start = Math.max(0, Math.floor(this.host.scrollTop / ROW_H) - buffer);
    const visible = Math.ceil(viewH / ROW_H) + buffer * 2;
    const limit = Math.min(visible, total - start);

    const token = ++this.token;
    const rows = await this.store.getRows({
      offset: start,
      limit,
      variables: this.metas.map((m) => m.name),
    });
    if (token !== this.token) return; // a newer scroll superseded this fetch

    const cols = this.metas.length + 1;
    const frag = document.createDocumentFragment();
    frag.append(spacerRow(start * ROW_H, cols));
    rows.forEach((row, i) => frag.append(this.#rowEl(start + i + 1, row)));
    const tail = total - (start + rows.length);
    if (tail > 0) frag.append(spacerRow(tail * ROW_H, cols));
    this.tbody.replaceChildren(frag);
  }

  #rowEl(num, row) {
    const tr = document.createElement('tr');
    tr.append(el('td', String(num), 'rownum'));
    for (const m of this.metas) {
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

/** A zero-content row of a given pixel height — the virtualisation spacer. */
function spacerRow(heightPx, colspan) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.style.height = `${Math.max(0, heightPx)}px`;
  td.style.padding = '0';
  td.style.border = 'none';
  tr.append(td);
  return tr;
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
