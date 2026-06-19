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
  /** @param {HTMLElement} host - The view panel. @param {import('./data-store.js').DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
    this.metas = [];
    this.filter = ''; // column-header filter text
    this.token = 0; // guards against stale async windows
    this.raf = null;
    this.lastKey = null; // `${startRow}:${startCol}:${filter}` of the rendered block

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
    const token = ++this.token;
    const rows = await this.store.getRows({
      offset: startRow,
      limit: endRow - startRow,
      variables: winMetas.map((m) => m.name),
      includeRowId: true, // needed so a cell edit can target the row by stable id
    });
    if (token !== this.token) return; // a newer scroll superseded this fetch

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
      tr.className = 'vargrid__row';
      tr.title = 'Click to edit';
      tr.append(elCode('td', m.name));
      tr.append(el('td', m.label || ''));
      tr.append(el('td', m.type));
      tr.append(el('td', m.measurementLevel || ''));
      tr.append(el('td', summariseLabels(m.valueLabels)));
      tr.append(el('td', (m.missingValues || []).join(', ')));
      tr.addEventListener('click', () => this.#openEditor(m));
      body.append(tr);
    }
    table.append(body);
    this.host.replaceChildren(table);
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
 * The **History / rewind panel**: a linear list of the dataset's transform log,
 * over an "as-imported" base step, with the current position highlighted. Click
 * any step to rewind (or fast-forward) to that state — mechanically a single
 * {@link DataStore#rewindTo}. Steps *ahead* of the current position (undone but
 * still redoable) render greyed; making a fresh edit after a rewind discards them.
 *
 * Linear by design, **not** git-style branching: the audience thinks in linear
 * syntax files, and divergent exploration is already served by the multi-dataset
 * workspace (a fork is just a separate dataset). The same log is the basis for a
 * future export-to-syntax (the history *is* the do-file).
 */
export class HistoryView {
  /** @param {HTMLElement} host @param {import('./data-store.js').DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
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
    applied.forEach((t, i) => {
      const n = i + 1;
      const d = describeTransform(t);
      ol.append(
        this.#step({ n, marker: n, title: d.title, detail: d.detail, state: n === applied.length ? 'current' : 'applied' }),
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
          'No data yet. Importing, then recoding/computing/editing in this dataset appears here as steps you can rewind to.',
          'history-hint',
        ),
      );
    }
  }

  /** One timeline row: a clickable step that rewinds to having `n` transforms
   * applied. The current step is highlighted and inert. */
  #step({ n, marker, title, detail, state }) {
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
      btn.disabled = true;
      btn.title = 'Current state';
    } else {
      btn.title = `Rewind to: ${title}`;
      btn.addEventListener('click', () => void this.store.rewindTo(n));
    }
    li.append(btn);
    return li;
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
