/**
 * @file compute-recode.js
 * Host UI for the Phase-2 data transforms: **Transform ▸ Compute variable…** and
 * **Recode into new variable…**. Both create a new, *derived* variable through the
 * engine's logged transforms ({@link DataStore#computeVariable} /
 * {@link DataStore#recodeVariable}) — so they are non-destructive (sources stay
 * immutable), undoable, shown in the History panel, and exported to syntax.
 *
 * Host-owned (it draws host dialogs and drives engine transform methods), the same
 * line as the data grid and the Variable-View editor — not a sandboxed plugin.
 */
export class ComputeRecode {
  #data;
  #menus;
  #results;

  /**
   * @param {Object} deps
   * @param {import('./dataset-manager.js').DatasetManager} deps.data
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendText: Function, appendError: Function}} deps.results - ResultsPane#api.
   */
  constructor({ data, menus, results }) {
    this.#data = data;
    this.#menus = menus;
    this.#results = results;
  }

  activate() {
    this.#menus.register({
      id: 'core:compute',
      path: ['Transform'],
      label: 'Compute variable…',
      order: 10,
      command: () => this.#openCompute(),
    });
    this.#menus.register({
      id: 'core:recode',
      path: ['Transform'],
      label: 'Recode into new variable…',
      order: 20,
      command: () => this.#openRecode(),
    });
    this.#menus.register({
      id: 'core:select-cases',
      path: ['Transform'],
      label: 'Select cases…',
      order: 30,
      command: () => this.#openFilter(),
    });
  }

  // --- Select cases (row filter) ---------------------------------------------

  #openFilter() {
    if (!this.#guardData()) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-cr">
        <h2 class="ct-dialog__title">Select cases</h2>
        <p class="ct-dialog__hint">Keep only the rows where a condition is true (e.g.
          <code>age &gt;= 18</code>, <code>grp = 1</code>, <code>year &gt; 2000 AND region = 'West'</code>).
          Non-destructive — it filters the working view; undo or History restores all rows.</p>
        <label class="ct-field">Keep cases where
          <textarea name="cond" rows="2" class="ct-cr__expr" placeholder="age >= 18 AND grp = 1"></textarea>
        </label>
        <div class="ct-cr__palette"></div>
        <p class="ct-hint">Click a variable to insert it — variables appear in <code>"double quotes"</code>
          (how column names are written); put text <em>values</em> in <code>'single quotes'</code>.
          Comparisons: <code>= != &lt; &lt;= &gt; &gt;=</code> · combine with <code>AND OR NOT</code> ·
          <code>IN (…)</code>, <code>IS NULL</code>. Categorical variables are stored as <em>codes</em>
          (the grid shows their labels) — match the code, e.g. <code>"gender" = '1'</code>.</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Select</button>
        </menu>
      </form>`;

    const cond = dialog.querySelector('textarea[name="cond"]');
    const palette = dialog.querySelector('.ct-cr__palette');
    for (const m of this.#vars()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ct-cr__chip';
      chip.textContent = m.name;
      chip.title = codeHint(m) || m.label || m.name;
      chip.addEventListener('click', () => insertAtCursor(cond, identForExpr(m.name)));
      palette.append(chip);
    }

    dialog.addEventListener('close', async () => {
      const ok = dialog.returnValue === 'ok';
      const condition = cond.value.trim();
      const vars = this.#vars();
      dialog.remove();
      if (!ok || !condition) return;
      try {
        const before = this.#data.rowCount;
        await this.#data.filterCases(condition);
        const after = this.#data.rowCount;
        // 0 rows is the classic "filtered a label, but the column stores codes"
        // trap — diagnose it and tell the user the exact code to match.
        const note = after === 0 && before > 0 ? diagnoseZeroRows(condition, vars) : '';
        this.#results.appendText(
          `Selected cases where \`${condition}\` — ${after.toLocaleString()} of ${before.toLocaleString()} rows kept.${note}`,
        );
      } catch (err) {
        this.#results.appendError(err.message);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  #vars() {
    return this.#data.getVariableMeta();
  }

  #guardData() {
    if (this.#data.rowCount === 0) {
      this.#results.appendError('No data is loaded — import a dataset first.');
      return false;
    }
    return true;
  }

  // --- Compute ---------------------------------------------------------------

  #openCompute() {
    if (!this.#guardData()) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-cr">
        <h2 class="ct-dialog__title">Compute variable</h2>
        <p class="ct-dialog__hint">Create a new variable from an expression of existing
          variables (e.g. <code>income / 1000</code>, <code>a + b + c</code>,
          <code>sqrt(x)</code>).</p>
        <div class="ct-row">
          <label class="ct-field">New variable name
            <input name="name" type="text" placeholder="e.g. income_k" autocomplete="off">
          </label>
          <label class="ct-field">Type
            <select name="type"><option value="numeric">numeric</option><option value="string">string</option></select>
          </label>
        </div>
        <label class="ct-field">Expression
          <textarea name="expr" rows="3" class="ct-cr__expr" placeholder="income / 1000"></textarea>
        </label>
        <div class="ct-cr__palette"></div>
        <p class="ct-hint">Click a variable to insert it. Operators: <code>+ - * / ^</code> ·
          functions: <code>sqrt log ln exp abs round floor ceil</code> · <code>CASE WHEN … THEN … ELSE … END</code>.</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Compute</button>
        </menu>
      </form>`;

    const expr = dialog.querySelector('textarea[name="expr"]');
    const palette = dialog.querySelector('.ct-cr__palette');
    for (const m of this.#vars()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ct-cr__chip';
      chip.textContent = m.name;
      chip.title = m.label || m.name;
      chip.addEventListener('click', () => insertAtCursor(expr, identForExpr(m.name)));
      palette.append(chip);
    }

    dialog.addEventListener('close', async () => {
      const ok = dialog.returnValue === 'ok';
      const name = dialog.querySelector('input[name="name"]').value.trim();
      const type = dialog.querySelector('select[name="type"]').value;
      const expression = expr.value.trim();
      dialog.remove();
      if (!ok) return;
      try {
        await this.#data.computeVariable(name, expression, type);
        this.#results.appendText(`Computed **${name}** = \`${expression}\`.`);
      } catch (err) {
        this.#results.appendError(err.message);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  // --- Recode ----------------------------------------------------------------

  #openRecode() {
    if (!this.#guardData()) return;
    const vars = this.#vars();
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    const opts = vars.map((m) => `<option value="${attr(m.name)}">${esc(m.label ? `${m.label} (${m.name})` : m.name)}</option>`).join('');
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-cr">
        <h2 class="ct-dialog__title">Recode into new variable</h2>
        <p class="ct-dialog__hint">Map the values of a variable into a new one
          (collapse categories, reverse-code, bin a scale).</p>
        <div class="ct-row">
          <label class="ct-field">Recode from
            <select name="source">${opts}</select>
          </label>
          <label class="ct-field">New variable name
            <input name="name" type="text" placeholder="e.g. agegroup" autocomplete="off">
          </label>
          <label class="ct-field">Type
            <select name="type"><option value="numeric">numeric</option><option value="factor">factor</option><option value="string">string</option></select>
          </label>
        </div>
        <div class="ct-cr__ruleshead"><span>Old value</span><span></span><span>New value</span><span></span></div>
        <div class="ct-cr__rules"></div>
        <button type="button" class="ct-cr__addrule">+ Add rule</button>
        <div class="ct-cr__else"></div>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Recode</button>
        </menu>
      </form>`;

    const rulesEl = dialog.querySelector('.ct-cr__rules');
    const rows = [];
    const addRow = () => {
      const r = makeRuleRow(() => {
        const i = rows.indexOf(r);
        if (i >= 0) rows.splice(i, 1);
        r.el.remove();
      });
      rows.push(r);
      rulesEl.append(r.el);
    };
    addRow();
    dialog.querySelector('.ct-cr__addrule').addEventListener('click', addRow);

    // "All other values →" else row.
    const elseRow = makeToControls();
    elseRow.kind.value = 'copy';
    elseRow.sync();
    const elseWrap = dialog.querySelector('.ct-cr__else');
    elseWrap.append(el('span', 'All other values →', 'ct-cr__elselabel'), elseRow.el);

    dialog.addEventListener('close', async () => {
      const ok = dialog.returnValue === 'ok';
      const source = dialog.querySelector('select[name="source"]').value;
      const name = dialog.querySelector('input[name="name"]').value.trim();
      const type = dialog.querySelector('select[name="type"]').value;
      const rules = rows.map((r) => r.read()).filter(Boolean);
      const elseRule = elseRow.read();
      dialog.remove();
      if (!ok) return;
      try {
        await this.#data.recodeVariable(name, source, rules, type, elseRule);
        this.#results.appendText(`Recoded **${source}** → **${name}** (${rules.length} rule${rules.length === 1 ? '' : 's'}).`);
      } catch (err) {
        this.#results.appendError(err.message);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
}

// --- recode rule row ---------------------------------------------------------

/** One recode rule: a "from" matcher and a "to" target. Returns `{el, read()}`
 * where read() yields `{from, value?|lo,hi, to}` or null if incomplete. */
function makeRuleRow(onRemove) {
  const wrap = el('div', null, 'ct-cr__rule');

  const from = document.createElement('select');
  from.className = 'ct-cr__from';
  from.innerHTML =
    '<option value="value">value</option><option value="range">range</option><option value="missing">missing</option>';

  const val = inputEl('value', 'ct-cr__val');
  const lo = inputEl('low', 'ct-cr__lo');
  const hi = inputEl('high', 'ct-cr__hi');
  const fromInputs = el('span', null, 'ct-cr__frominputs');
  fromInputs.append(val, lo, el('span', '–', 'ct-cr__dash'), hi);

  const syncFrom = () => {
    val.hidden = from.value !== 'value';
    lo.hidden = hi.hidden = from.value !== 'range';
    fromInputs.querySelector('.ct-cr__dash').hidden = from.value !== 'range';
  };
  from.addEventListener('change', syncFrom);
  syncFrom();

  const arrow = el('span', '→', 'ct-cr__arrow');
  const to = makeToControls();

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'ct-cr__rm';
  rm.textContent = '✕';
  rm.title = 'Remove rule';
  rm.addEventListener('click', onRemove);

  wrap.append(from, fromInputs, arrow, to.el, rm);

  const read = () => {
    const kind = from.value;
    const target = to.read();
    if (kind === 'value') {
      if (val.value.trim() === '') return null;
      return { from: 'value', value: val.value.trim(), to: target };
    }
    if (kind === 'range') {
      if (lo.value.trim() === '' || hi.value.trim() === '') return null;
      return { from: 'range', lo: Number(lo.value), hi: Number(hi.value), to: target };
    }
    return { from: 'missing', to: target };
  };
  return { el: wrap, read };
}

/** The "to" half of a rule (or the else row): a kind select + value input.
 * Returns `{el, kind, sync, read()}`. */
function makeToControls() {
  const wrap = el('span', null, 'ct-cr__to');
  const kind = document.createElement('select');
  kind.className = 'ct-cr__tokind';
  kind.innerHTML =
    '<option value="value">value</option><option value="copy">copy original</option><option value="sysmis">system-missing</option>';
  const value = inputEl('new value', 'ct-cr__toval');
  const sync = () => {
    value.hidden = kind.value !== 'value';
  };
  kind.addEventListener('change', sync);
  sync();
  wrap.append(kind, value);
  const read = () => (kind.value === 'value' ? { kind: 'value', value: value.value.trim() } : { kind: kind.value });
  return { el: wrap, kind, sync, read };
}

// --- small DOM/SQL helpers ---------------------------------------------------

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function inputEl(placeholder, className) {
  const i = document.createElement('input');
  i.type = 'text';
  i.autocomplete = 'off';
  i.placeholder = placeholder;
  i.className = className;
  return i;
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
}

/** Reference a variable in a DuckDB expression: double-quote it (handles spaces). */
function identForExpr(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** A SQL literal for a value-label code: bare for numeric-coded, else quoted. */
function valueLiteral(m, code) {
  if (m?.type === 'numeric' && /^-?\d+(\.\d+)?$/.test(String(code))) return String(code);
  return `'${String(code).replace(/'/g, "''")}'`;
}

/** Tooltip for a labelled categorical: its code→label map, so the user matches
 * the stored code (the grid shows the label). Empty for unlabelled variables. */
function codeHint(m) {
  const labels = m?.valueLabels && Object.keys(m.valueLabels).length ? m.valueLabels : null;
  if (!labels) return '';
  const pairs = Object.entries(labels)
    .slice(0, 12)
    .map(([c, l]) => `  ${c} = ${l}`)
    .join('\n');
  return `${m.label ? m.label + '\n' : ''}Stored as codes — match the code, not the label:\n${pairs}`;
}

/** Explain a 0-row filter. If a quoted text value in the condition is actually a
 * value *label* of some categorical, point to the code to use instead — the most
 * common cause (the grid shows labels; the column stores codes). */
function diagnoseZeroRows(condition, vars) {
  const literals = [...String(condition).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  for (const lit of literals) {
    for (const v of vars || []) {
      const labels = v.valueLabels || {};
      const hit = Object.entries(labels).find(([, lab]) => String(lab).toLowerCase() === lit.toLowerCase());
      if (hit) {
        return (
          `\n\n⚠ 0 rows matched. **'${lit}'** is a value *label* for **${v.name}**, but the column stores ` +
          `codes (the grid shows labels). Match the code instead, e.g. \`${identForExpr(v.name)} = ${valueLiteral(v, hit[0])}\`.`
        );
      }
    }
  }
  return (
    '\n\n⚠ 0 rows matched. If you filtered a categorical by the label shown in the grid, those variables are ' +
    'stored as codes — open Variables to see the code↔label map and match the code, or double-check the value’s type.'
  );
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function attr(s) {
  return esc(s).replace(/"/g, '&quot;');
}
