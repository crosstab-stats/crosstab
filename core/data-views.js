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

import { CoreEvents } from './event-bus.js';
import { serialize, parse } from './crosstab-syntax.js';

const ROW_H = 28; // px; must match the CSS cell height for scrollbar accuracy.
const COL_W = 120; // px; fixed column width so columns can be virtualised too.
const GUT_W = 56; // px; the sticky row-number gutter.
const ROW_BUF = 8; // rows rendered above/below the viewport.
const COL_BUF = 3; // columns rendered left/right of the viewport.
// Rows fetched above/below the visible block and cached, so vertical scrolling
// within the cache needs NO new DuckDB read. Each windowed read of a wide dataset
// pays a large fixed cost (parsing the Parquet metadata), so the win is issuing far
// fewer of them — not making each faster (#128).
const FETCH_BUF = 120;

/**
 * Virtualised cell grid (rows = cases, columns = variables), windowed in **both**
 * dimensions: only the rows *and* columns near the viewport are in the DOM, and
 * each scroll fetches just that block from DuckDB via {@link DataStore#getRows}.
 * This keeps a wide dataset (e.g. GSS's ~980 variables) smooth — without column
 * windowing a single screen would be tens of thousands of cells. Factor codes
 * display as their value labels (raw code on hover).
 */
export class DataView {
  /** @param {HTMLElement} host - The view panel. @param {import('./data-store.js').DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
    this.metas = [];
    this.filter = ''; // column-header filter text
    this.token = 0; // guards against stale async windows
    this.raf = null;
    this.lastKey = null; // `${startRow}:${startCol}:${filter}` of the rendered block
    this.rowCache = null; // { start, end, startCol, endCol, filter, rows } — see FETCH_BUF

    // The panel becomes a flex column: a fixed toolbar (column filter + selection
    // count) above a scrolling grid area. The scroll/virtualisation math reads
    // the inner scroller, not the host. Done via a class, not inline
    // `display:flex` — an inline style would beat the `.view[hidden]` display:none
    // rule and leave the grid visible behind the other tabs.
    host.classList.add('ct-gridhost');

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'grid-toolbar';
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'search';
    this.filterInput.className = 'grid-filter';
    this.filterInput.placeholder = 'Filter columns…';
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value;
      this.#applyFilter();
    });
    this.selCount = document.createElement('span');
    this.selCount.className = 'grid-selcount';
    this.toolbar.append(this.filterInput, this.selCount);

    this.scroller = document.createElement('div');
    this.scroller.className = 'grid-scroll';
    this.table = document.createElement('table');
    this.table.className = 'grid';
    this.thead = document.createElement('thead');
    this.tbody = document.createElement('tbody');
    this.table.append(this.thead, this.tbody);
    this.scroller.append(this.table);

    this.host.replaceChildren(this.toolbar, this.scroller);
    this.scroller.addEventListener('scroll', () => this.#onScroll());
  }

  /** Rebuild from scratch (call on data change or first show). */
  async refresh() {
    this.metas = this.store.getVariableMeta();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.lastKey = null;
    this.rowCache = null; // data changed → the cached block is stale
    await this.#render(true);
    this.#updateSelCount();
  }

  /** Columns to display, after applying the column-header filter. */
  #visibleMetas() {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.metas;
    return this.metas.filter(
      (m) => m.name.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q),
    );
  }

  /** Re-render after the filter changes (column set changed → reset H-scroll). */
  async #applyFilter() {
    this.scroller.scrollLeft = 0;
    this.lastKey = null;
    this.rowCache = null; // column set changed → re-fetch
    await this.#render(true);
  }

  #onScroll() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.#render(false);
    });
  }

  /**
   * Read a window of rows, riding out a *transient* "table/view does not exist"
   * that can occur for a beat while a project open/restore rebuilds the active
   * dataset's DuckDB view (a stale view briefly referencing a source being
   * recreated — #114). Retries a few times with a short backoff; returns `null`
   * if it never settles (the caller keeps the current grid and re-renders on the
   * rebuild's DATA_CHANGED). A non-transient error (a real bug) is rethrown.
   * @returns {Promise<Array<object>|null>}
   */
  async #getRowsResilient(opts) {
    for (let i = 0; ; i++) {
      try {
        return await this.store.getRows(opts);
      } catch (err) {
        const transient = /does not exist|not found|Catalog Error/i.test(String(err?.message || err));
        if (!transient || i >= 4) {
          if (transient) return null; // gave up gracefully — no raw error to the user
          throw err;
        }
        await new Promise((r) => setTimeout(r, 80 + i * 80));
      }
    }
  }

  async #render(force) {
    const total = this.store.rowCount;
    const cols = this.#visibleMetas();
    const nCols = cols.length;
    // Size the table to the (filtered) virtual extent so both scrollbars are right.
    this.table.style.width = nCols === 0 ? 'auto' : `${GUT_W + nCols * COL_W}px`;

    if (total === 0 || nCols === 0) {
      this.thead.replaceChildren();
      this.tbody.replaceChildren();
      // Distinguish "no data" from "filter matched nothing".
      if (nCols === 0 && this.metas.length > 0) {
        const td = el('td', 'No columns match the filter.');
        td.style.cssText = 'width:auto;max-width:none;color:#7a8590;';
        this.tbody.append(elWrap('tr', td));
      }
      return;
    }

    const viewH = this.scroller.clientHeight || 400;
    const viewW = this.scroller.clientWidth || 600;
    const startRow = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - ROW_BUF);
    const visRows = Math.ceil(viewH / ROW_H) + ROW_BUF * 2;
    const endRow = Math.min(total, startRow + visRows);
    const startCol = Math.max(0, Math.floor(this.scroller.scrollLeft / COL_W) - COL_BUF);
    const visCols = Math.ceil(viewW / COL_W) + COL_BUF * 2;
    const endCol = Math.min(nCols, startCol + visCols);

    // Skip if the visible block hasn't moved (cheap small scrolls within buffer).
    // The filter is part of the key so a filter change always re-renders.
    const key = `${startRow}:${startCol}:${this.filter}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    const winMetas = cols.slice(startCol, endCol);

    // Serve the visible rows from the cached block when possible; only hit DuckDB
    // when the viewport leaves the cache, the columns move, or the filter changes
    // (#128 — each wide-file read pays a big fixed metadata cost, so issue far fewer).
    // The cache holds one column window, so a horizontal move re-fetches; vertical
    // scrolls within ±FETCH_BUF rows of the fetched block do not.
    const c = this.rowCache;
    const cacheHit = c && !force && c.filter === this.filter
      && c.startCol === startCol && c.endCol === endCol
      && startRow >= c.start && endRow <= c.end;

    let blockRows, blockStart;
    if (cacheHit) {
      blockRows = c.rows;
      blockStart = c.start;
    } else {
      const fetchStart = Math.max(0, startRow - FETCH_BUF);
      const fetchEnd = Math.min(total, endRow + FETCH_BUF);
      const token = ++this.token;
      const fetched = await this.#getRowsResilient({
        offset: fetchStart,
        limit: fetchEnd - fetchStart,
        variables: winMetas.map((m) => m.name),
        includeRowId: true, // needed so a cell edit can target the row by stable id
      });
      if (token !== this.token) return; // a newer scroll superseded this fetch
      // A transient read failure mid-rebuild (a view briefly referencing a source
      // being recreated during a project open/restore — #114). Bail quietly and keep
      // the current grid: the rebuild emits DATA_CHANGED on completion, which fires a
      // fresh refresh that renders correctly. Never surface a raw DuckDB error here.
      if (fetched == null) return;
      this.rowCache = { start: fetchStart, end: fetchEnd, startCol, endCol, filter: this.filter, rows: fetched };
      blockRows = fetched;
      blockStart = fetchStart;
    }
    const rows = blockRows.slice(startRow - blockStart, endRow - blockStart);

    const leftW = startCol * COL_W;
    const rightW = (nCols - endCol) * COL_W;
    const selected = new Set(this.store.getSelectedVariables());

    // Header: corner + left spacer + visible column headers + right spacer. Each
    // header carries a checkbox tied to the variable selection.
    const htr = document.createElement('tr');
    htr.append(el('th', '', 'corner'));
    if (leftW > 0) htr.append(hspacer('th', leftW));
    for (const m of winMetas) htr.append(this.#headerCell(m, selected.has(m.name)));
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

  /** A column header with a selection checkbox tied to the variable selection. */
  #headerCell(m, isSelected) {
    const th = document.createElement('th');
    th.title = `${m.name} · ${m.type}${m.measurementLevel ? ` · ${m.measurementLevel}` : ''}`;
    const wrap = document.createElement('label');
    wrap.className = 'colhead';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'colhead__check';
    cb.checked = isSelected;
    cb.dataset.var = m.name;
    cb.addEventListener('change', () => this.#toggle(m.name, cb.checked));
    const span = el('span', m.label || m.name, 'colhead__label');
    wrap.append(cb, span);
    th.append(wrap);
    return th;
  }

  /** Add/remove a variable from the shared selection (drives pickers + sidebar). */
  #toggle(name, on) {
    const sel = new Set(this.store.getSelectedVariables());
    if (on) sel.add(name);
    else sel.delete(name);
    this.store.setSelectedVariables([...sel]);
    this.#updateSelCount();
  }

  /**
   * Re-sync rendered header checkboxes + the count to the store's selection.
   * Called when the selection changes elsewhere (e.g. the sidebar). Cheap — only
   * touches the currently-rendered headers, no refetch.
   */
  syncSelection() {
    const sel = new Set(this.store.getSelectedVariables());
    for (const cb of this.thead.querySelectorAll('.colhead__check')) {
      cb.checked = sel.has(cb.dataset.var);
    }
    this.#updateSelCount();
  }

  #updateSelCount() {
    const n = this.store.getSelectedVariables().length;
    this.selCount.textContent = n ? `${n} selected` : '';
  }

  #rowEl(num, row, winMetas, leftW, rightW) {
    const tr = document.createElement('tr');
    tr.append(el('td', String(num), 'rownum'));
    if (leftW > 0) tr.append(hspacer('td', leftW));
    for (const m of winMetas) {
      const v = row[m.name];
      let td;
      if (v === null || v === undefined) {
        td = el('td', '·', 'na cell');
      } else if (m.type === 'factor' && m.valueLabels && m.valueLabels[v] !== undefined) {
        td = el('td', String(m.valueLabels[v]), 'cell');
        td.title = String(v); // raw code on hover
      } else {
        td = el('td', String(v), m.type === 'numeric' ? 'num cell' : 'cell');
      }
      // Double-click to edit — stored as a sparse override transform keyed by the
      // row's stable id (`row.__rid`), so the edit survives appends/reordering.
      // Non-destructive, undoable, shows in History. Edits the raw value (a
      // factor's *code*, not its label).
      if (row.__rid != null) {
        td.addEventListener('dblclick', () => this.#editCell(td, num - 1, row.__rid, m, v));
      }
      tr.append(td);
    }
    if (rightW > 0) tr.append(hspacer('td', rightW));
    return tr;
  }

  /**
   * Turn a cell into an inline editor. Commit on Enter/blur (writes a sparse
   * override via {@link DataStore#setCell}; the grid then refreshes on
   * DATA_CHANGED), cancel on Escape.
   */
  #editCell(td, displayRow, rid, meta, rawValue) {
    if (td.querySelector('input')) return; // already editing
    const input = document.createElement('input');
    input.className = 'cell-edit';
    input.value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
    td.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      try {
        await this.store.setCell(rid, meta.name, input.value, displayRow);
        // The grid refreshes on the resulting DATA_CHANGED while visible; if not,
        // refresh defensively so the new value shows.
      } catch (err) {
        console.error('[grid] setCell failed', err);
      }
      await this.refresh();
    };
    const cancel = async () => {
      if (done) return;
      done = true;
      await this.refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void cancel();
      }
    });
    input.addEventListener('blur', () => void commit());
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
    /** Current name/label filter text (persists across re-renders). */
    this.filter = '';
    /** Flex column so the filter toolbar stays put while the list scrolls (a class,
     * not inline style, so `.view[hidden]` still wins when the tab is inactive). */
    host.classList.add('ct-gridhost');
  }

  render() {
    const metas = this.store.getVariableMeta();
    if (metas.length === 0) {
      this.tbody = null;
      this.host.innerHTML = '<p class="grid-empty">No data loaded. Use File ▸ Import.</p>';
      return;
    }
    this.metas = metas;

    // Toolbar: a filter box (matches name or label) + a live count. With thousands
    // of variables, scanning the whole list to find one to recode is painful.
    const toolbar = document.createElement('div');
    toolbar.className = 'grid-toolbar';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'grid-filter';
    input.placeholder = 'Filter variables by name or label…';
    input.value = this.filter;
    let debounce = null;
    input.addEventListener('input', () => {
      this.filter = input.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => this.#applyFilter(), 100);
    });
    this.count = document.createElement('span');
    this.count.className = 'grid-selcount';
    toolbar.append(input, this.count);

    const scroller = document.createElement('div');
    scroller.className = 'grid-scroll';
    const table = document.createElement('table');
    table.className = 'vargrid';
    const head = document.createElement('tr');
    for (const h of ['Name', 'Label', 'Type', 'Measure', 'Value labels', 'Missing']) {
      head.append(el('th', h));
    }
    table.append(elWrap('thead', head));
    this.tbody = document.createElement('tbody');
    table.append(this.tbody);
    scroller.append(table);

    this.host.replaceChildren(toolbar, scroller);
    this.#applyFilter();
  }

  /** Rebuild the table body for the current filter (matched on name or label,
   * case-insensitive). Cheap to call on every keystroke since it only rebuilds the
   * — usually much smaller — matched set. */
  #applyFilter() {
    if (!this.tbody) return;
    const q = this.filter.trim().toLowerCase();
    const shown = q
      ? this.metas.filter(
          (m) => m.name.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q),
        )
      : this.metas;
    this.count.textContent = q
      ? `${shown.length.toLocaleString()} of ${this.metas.length.toLocaleString()}`
      : `${this.metas.length.toLocaleString()} variable${this.metas.length === 1 ? '' : 's'}`;

    const frag = document.createDocumentFragment();
    for (const m of shown) {
      const tr = document.createElement('tr');
      tr.className = 'vargrid__row';
      tr.title = 'Click to edit';
      tr.append(elCode('td', m.name));
      tr.append(el('td', m.label || ''));
      tr.append(el('td', m.type));
      tr.append(el('td', m.measurementLevel || ''));
      tr.append(el('td', summariseLabels(m.valueLabels)));
      tr.append(el('td', (m.missingValues || []).join(', ')));
      tr.addEventListener('click', () => this.#openEditor(m));
      frag.append(tr);
    }
    if (shown.length === 0) {
      const td = el('td', `No variables match “${this.filter.trim()}”.`);
      td.colSpan = 6;
      td.style.cssText = 'color:#7a8590;';
      frag.append(elWrap('tr', td));
    }
    this.tbody.replaceChildren(frag);
  }

  /**
   * Modal editor for one variable's metadata. Applies a non-destructive
   * transform via {@link DataStore#updateVariable} on save.
   *
   * @param {import('./data-store.js').VariableMeta} meta
   */
  #openEditor(meta) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const opt = (v, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${v || '—'}</option>`;
    const labelLines = Object.entries(meta.valueLabels || {})
      .map(([code, label]) => `${code} = ${label}`)
      .join('\n');
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-edit">
        <h2 class="ct-dialog__title">Edit variable</h2>
        <p class="ct-dialog__hint"><code>${esc(meta.name)}</code></p>
        <label class="ct-field">Label
          <input name="label" type="text" value="${attr(meta.label || '')}">
        </label>
        <div class="ct-row">
          <label class="ct-field">Type
            <select name="type">${['numeric', 'string', 'factor'].map((t) => opt(t, meta.type)).join('')}</select>
          </label>
          <label class="ct-field">Measure
            <select name="measure">${['', 'nominal', 'ordinal', 'scale'].map((t) => opt(t, meta.measurementLevel || '')).join('')}</select>
          </label>
        </div>
        <label class="ct-field">Missing values <span class="ct-hint">comma-separated codes treated as missing</span>
          <input name="missing" type="text" value="${attr((meta.missingValues || []).join(', '))}">
        </label>
        <label class="ct-field">Value labels <span class="ct-hint">one <code>code = label</code> per line</span>
          <textarea name="labels" rows="4">${esc(labelLines)}</textarea>
        </label>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Save</button>
        </menu>
      </form>`;

    dialog.addEventListener('close', async () => {
      const form = dialog.querySelector('form');
      const ok = dialog.returnValue === 'ok';
      dialog.remove();
      if (!ok) return;
      const patch = {
        label: form.label.value.trim(),
        type: form.type.value,
        measurementLevel: form.measure.value || undefined,
        missingValues: parseMissing(form.missing.value),
        valueLabels: parseLabels(form.labels.value),
      };
      try {
        await this.store.updateVariable(meta.name, patch);
      } catch (err) {
        console.error('[recode] updateVariable failed', err);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
}

/**
 * The **History panel** — the dataset's universal operation log as a linear list
 * of *actions* (loads + transforms), with the current position highlighted. It
 * lives in a floating panel opened from **Edit ▸ History…** (not a workspace tab —
 * Data/Variables/Output are inputs & outputs; History is what you *did*). Each
 * step:
 *  - **click the body** → rewind/fast-forward to that state (live — the grid
 *    behind the panel updates immediately, since the panel doesn't block it);
 *  - **▲ / ▼** → reorder the step (now meaningful: replay is sequential, so moving
 *    an append above a transform makes the transform cover the appended rows);
 *  - **−** → delete the step.
 * Reorder/delete are guarded ({@link DataStore#moveOp}/{@link DataStore#removeOp}):
 * the base import is pinned, and an order that would break a dependency is rejected
 * with a message. Linear by design (not git branching).
 */
export class HistoryView {
  /**
   * @param {HTMLElement} host
   * @param {import('./data-store.js').DataStore} store
   * @param {{onError?: (msg: string) => void}} [opts]
   */
  constructor(host, store, opts = {}) {
    this.host = host;
    this.store = store;
    this.onError = opts.onError ?? (() => {});
    host.classList.add('ct-historyhost');
  }

  /** Rebuild the timeline from the universal log (call on show + on data change). */
  render() {
    const { applied, future } = this.store.getHistory();
    const ol = document.createElement('ol');
    ol.className = 'history';

    // Step 0: the empty start, before any data is loaded. Rewinding here clears
    // the dataset back to nothing (you can then import fresh).
    ol.append(
      this.#step({
        n: 0,
        marker: '○',
        title: 'Start',
        detail: 'empty — before any data',
        state: applied.length === 0 ? 'current' : 'applied',
      }),
    );

    // Applied operations 1..k (k = current position) — loads and transforms alike.
    // Every applied op except the base import (log index 0) can be reordered/deleted.
    applied.forEach((t, i) => {
      const n = i + 1;
      const d = describeTransform(t);
      ol.append(
        this.#step({
          n,
          marker: n,
          title: d.title,
          detail: d.detail,
          state: n === applied.length ? 'current' : 'applied',
          index: i,
          canUp: i >= 2,
          canDown: i >= 1 && i < applied.length - 1,
          canDelete: i >= 1,
        }),
      );
    });

    // Future (undone) operations — greyed, still clickable to fast-forward.
    future.forEach((t, i) => {
      const n = applied.length + i + 1;
      const d = describeTransform(t);
      ol.append(this.#step({ n, marker: n, title: d.title, detail: d.detail, state: 'future' }));
    });

    this.host.replaceChildren(ol);
    if (applied.length === 0 && future.length === 0) {
      this.host.append(
        el(
          'p',
          'No data yet. Importing, then recoding/computing/editing in this dataset appears here as steps you can rewind to, reorder, or remove.',
          'history-hint',
        ),
      );
    }
  }

  /** One timeline row: a clickable body that rewinds to having `n` ops applied,
   * plus (for reorderable applied steps) move/delete controls. */
  #step({ n, marker, title, detail, state, index, canUp, canDown, canDelete }) {
    const li = document.createElement('li');
    li.className = `history__step history__step--${state}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history__btn';
    btn.append(el('span', String(marker), 'history__marker'));
    const body = el('span', null, 'history__body');
    body.append(el('span', title, 'history__title'));
    if (detail) body.append(el('span', detail, 'history__detail'));
    btn.append(body);
    if (state === 'current') {
      btn.append(el('span', 'current', 'history__badge'));
    }
    // The body always rewinds to this step (even the current one is harmlessly
    // re-applied); reorder/delete live in the controls so they don't trigger it.
    btn.title = state === 'current' ? 'Current state' : `Rewind to: ${title}`;
    btn.addEventListener('click', () => void this.store.rewindTo(n));
    li.append(btn);

    if (canUp || canDown || canDelete) {
      const ctl = el('span', null, 'history__ctl');
      ctl.append(
        ctlBtn('▲', 'Move up', !canUp, () => this.#move(index, index - 1)),
        ctlBtn('▼', 'Move down', !canDown, () => this.#move(index, index + 1)),
        ctlBtn('✕', 'Remove this step', !canDelete, () => this.#remove(index)),
      );
      li.append(ctl);
    }
    return li;
  }

  async #move(from, to) {
    try {
      await this.store.moveOp(from, to);
    } catch (err) {
      this.onError(err.message);
    }
  }

  async #remove(index) {
    try {
      await this.store.removeOp(index);
    } catch (err) {
      this.onError(err.message);
    }
  }
}

/** A small control button for a history step (move/delete). */
function ctlBtn(glyph, title, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'history__ctlbtn';
  b.textContent = glyph;
  b.title = title;
  b.disabled = !!disabled;
  if (!disabled) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      void onClick();
    });
  }
  return b;
}

/**
 * The floating **History panel** that hosts a {@link HistoryView}. Non-blocking
 * (docked to the right, no backdrop) so the Data grid behind it stays visible and
 * updates live as you click/reorder steps. Opened from Edit ▸ History….
 */
export class HistoryPanel {
  #store;
  #bus;
  #panel = null;
  #view = null;
  #errEl = null;
  #off = null;
  #escHandler = null;
  // Syntax mode (#134).
  #analysisLog = null;
  #pluginActions = null;
  #syntax = false;
  #contentEl = null;
  #editorEl = null;
  #textarea = null;
  #syntaxBtn = null;

  /**
   * @param {import('./data-store.js').DataStore} store
   * @param {import('./event-bus.js').EventBus} bus
   * @param {{analysisLog?: object, pluginActions?: object}} [opts] - enable the
   *   Syntax editor: read/replay the analysis log + rebuild via Run.
   */
  constructor(store, bus, { analysisLog = null, pluginActions = null } = {}) {
    this.#store = store;
    this.#bus = bus;
    this.#analysisLog = analysisLog;
    this.#pluginActions = pluginActions;
  }

  #build() {
    const panel = el('div', null, 'history-panel');
    const head = el('div', null, 'history-panel__head');
    head.append(el('span', 'History', 'history-panel__title'));
    const close = ctlBtn('✕', 'Close', false, () => this.close());
    close.className = 'history-panel__close';
    head.append(close);

    // Toolbar: one-click "collect imports" — pull all data-loading steps to the
    // top, before the transforms (the clean "load, then process" order).
    const toolbar = el('div', null, 'history-panel__toolbar');
    const collect = el('button', '↑ Collect imports', 'history-panel__action');
    collect.type = 'button';
    collect.title = 'Move all data-loading steps (import, append, join) above the transforms';
    collect.addEventListener('click', async () => {
      this.#clearErr();
      try {
        await this.#store.collectImports();
      } catch (err) {
        this.#showErr(err.message);
      }
    });
    toolbar.append(collect);

    // Syntax mode toggle — only when the editor deps are wired (#134).
    if (this.#analysisLog && this.#pluginActions) {
      const synBtn = el('button', '✎ Syntax', 'history-panel__action');
      synBtn.type = 'button';
      synBtn.title = 'View and edit the whole analysis as an editable script (CrossTab syntax), then Run to rebuild';
      synBtn.addEventListener('click', () => this.#toggleSyntax());
      toolbar.append(synBtn);
      this.#syntaxBtn = synBtn;
    }

    this.#errEl = el('div', null, 'history-panel__err');
    this.#errEl.hidden = true;
    const content = el('div', null, 'history-panel__content');
    this.#contentEl = content;
    panel.append(head, toolbar, this.#errEl, content);
    if (this.#analysisLog && this.#pluginActions) {
      panel.append(this.#buildEditor());
    }
    document.body.append(panel);
    this.#panel = panel;
    this.#view = new HistoryView(content, this.#store, { onError: (m) => this.#showErr(m) });
  }

  /** The Syntax editor: a monospace textarea of the serialized timeline
   * plus Run / Refresh. Hidden until the Syntax toggle is on. */
  #buildEditor() {
    const wrap = el('div', null, 'history-panel__syntax');
    wrap.hidden = true;
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:8px 10px;';

    const hint = el(
      'p',
      'Edit this script and Run to rebuild the dataset and re-run the analyses. ' +
        'Lines starting with # are comments (data sources can’t be edited as text). Expressions are SQL.',
      'history-panel__synhint',
    );
    hint.style.cssText = 'margin:0; font-size:12px; color:#6a7480; line-height:1.4;';

    const ta = document.createElement('textarea');
    ta.className = 'history-panel__synta';
    ta.spellcheck = false;
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.style.cssText =
      'width:100%; box-sizing:border-box; min-height:48vh; resize:vertical; ' +
      'font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; ' +
      'padding:8px 10px; border:1px solid var(--line,#d8dee4); border-radius:6px; white-space:pre;';
    this.#textarea = ta;

    const row = el('div', null, 'history-panel__synrow');
    row.style.cssText = 'display:flex; gap:8px;';
    const run = el('button', '▶ Run', 'history-panel__action');
    run.type = 'button';
    run.title = 'Rebuild the dataset from these steps and re-run the analyses';
    run.style.cssText = 'background:var(--accent,#2980b9); color:#fff; border-color:var(--accent,#2980b9);';
    run.addEventListener('click', () => void this.#runScript());
    const refresh = el('button', '↻ Refresh', 'history-panel__action');
    refresh.type = 'button';
    refresh.title = 'Discard edits and reload the script from the current steps';
    refresh.addEventListener('click', () => this.#fillEditor());
    row.append(run, refresh);

    wrap.append(hint, ta, row);
    this.#editorEl = wrap;
    return wrap;
  }

  /** Switch between the step timeline and the script editor. */
  #toggleSyntax() {
    this.#syntax = !this.#syntax;
    this.#clearErr();
    if (this.#syntax) this.#fillEditor();
    this.#contentEl.hidden = this.#syntax;
    this.#editorEl.hidden = !this.#syntax;
    if (this.#syntaxBtn) {
      this.#syntaxBtn.textContent = this.#syntax ? '↩ Steps' : '✎ Syntax';
      this.#syntaxBtn.classList.toggle('is-on', this.#syntax);
    }
  }

  /** (Re)load the editor text from the current timeline + analysis log. */
  #fillEditor() {
    if (!this.#textarea) return;
    const { applied } = this.#store.getHistory();
    const analyses = this.#analysisLog ? this.#analysisLog.entries() : [];
    this.#textarea.value = serialize(applied, analyses);
  }

  /** Parse the edited script, rebuild the data pipeline (atomically — a bad script
   * is rejected, not applied), then re-run the analyses. */
  async #runScript() {
    this.#clearErr();
    const { steps, errors } = parse(this.#textarea.value);
    if (errors.length) {
      const first = errors[0];
      this.#showErr(`Line ${first.line}: ${first.message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`);
      return;
    }
    let unknown = 0;
    try {
      // Position-faithful replay: data is rebuilt to each analysis's place in the
      // script before that analysis runs, so output matches the order shown. The
      // full transform set is validated first, so a bad data step aborts cleanly.
      ({ unknown } = await this.#pluginActions.replayScript(steps));
    } catch (err) {
      this.#showErr(err.message);
      return;
    }
    this.#fillEditor(); // reflect the rebuilt state (and drop any unknown lines)
    if (unknown > 0) this.#showErr(`${unknown} analysis line(s) referenced a plugin that isn’t active — skipped.`);
  }

  #showErr(msg) {
    if (!this.#errEl) return;
    this.#errEl.textContent = msg;
    this.#errEl.hidden = false;
  }

  #clearErr() {
    if (this.#errEl) this.#errEl.hidden = true;
  }

  open() {
    if (!this.#panel) this.#build();
    this.#panel.hidden = false;
    this.#clearErr();
    if (this.#syntax) this.#fillEditor();
    else this.#view.render();
    // Re-render live as the dataset changes (rewind/move/delete/edit elsewhere).
    // In syntax mode, leave the textarea alone so a data change elsewhere can't
    // clobber the user's in-progress edits.
    this.#off = this.#bus.on(CoreEvents.DATA_CHANGED, () => {
      this.#clearErr();
      if (!this.#syntax) this.#view.render();
    });
    this.#escHandler = (e) => {
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.#escHandler);
  }

  close() {
    if (this.#panel) this.#panel.hidden = true;
    this.#off?.();
    this.#off = null;
    if (this.#escHandler) document.removeEventListener('keydown', this.#escHandler);
    this.#escHandler = null;
  }

  toggle() {
    if (this.#panel && !this.#panel.hidden) this.close();
    else this.open();
  }
}

// --- helpers -----------------------------------------------------------------

/** Human-readable title + detail for any operation-log entry — data loads
 * (load/append/join) and data transforms alike. */
function describeTransform(t) {
  if (t && t.type === 'load') {
    return { title: 'Imported data', detail: t.src?.label || 'the original data' };
  }
  if (t && t.type === 'append') {
    return { title: 'Appended rows', detail: t.src?.label || 'more data' };
  }
  if (t && t.type === 'join') {
    const key = t.joinKey ? `${t.joinKey.left} ↔ ${t.joinKey.right}` : 'a key';
    return { title: `Joined ${t.src?.label || 'data'}`, detail: `on ${key}` };
  }
  if (t && t.type === 'setCell') {
    return {
      title: `Edited cell · ${t.column}`,
      detail: `row ${t.row + 1} = ${t.value == null || t.value === '' ? '(blank)' : t.value}`,
    };
  }
  if (t && t.type === 'computeVar') {
    return { title: `Computed ${t.name}`, detail: t.expr };
  }
  if (t && t.type === 'recodeVar') {
    const n = (t.rules || []).length;
    return { title: `Recoded ${t.source} → ${t.name}`, detail: `${n} rule${n === 1 ? '' : 's'}` };
  }
  if (t && t.type === 'filterCases') {
    return { title: 'Selected cases', detail: t.label || t.expr || '' };
  }
  if (!t || t.type !== 'setVariable') return { title: t?.type || 'Change', detail: '' };
  const p = t.patch || {};
  const bits = [];
  if ('type' in p) bits.push(`type → ${p.type}`);
  if ('label' in p) bits.push(p.label ? `label “${p.label}”` : 'cleared label');
  if ('measurementLevel' in p) bits.push(p.measurementLevel ? `measure → ${p.measurementLevel}` : 'cleared measure');
  if ('missingValues' in p) {
    const m = p.missingValues;
    bits.push(m && m.length ? `missing: ${m.join(', ')}` : 'cleared missing');
  }
  if ('valueLabels' in p) {
    const k = p.valueLabels ? Object.keys(p.valueLabels).length : 0;
    bits.push(k ? `${k} value label${k === 1 ? '' : 's'}` : 'cleared value labels');
  }
  return { title: `Edited ${t.name}`, detail: bits.join(' · ') };
}

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

/** Parse a comma-separated missing-codes string into numbers (or strings). */
function parseMissing(text) {
  return String(text)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const n = Number(s);
      return s !== '' && Number.isFinite(n) ? n : s;
    });
}

/** Parse a "code = label" per-line textarea into a `{code: label}` map. */
function parseLabels(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const code = line.slice(0, i).trim();
    const label = line.slice(i + 1).trim();
    if (code !== '') out[code] = label;
  }
  return out;
}

/** HTML-escape for text content. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for an HTML attribute value. */
function attr(s) {
  return esc(s).replace(/"/g, '&quot;');
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
