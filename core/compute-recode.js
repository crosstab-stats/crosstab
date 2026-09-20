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
  #ui;

  /**
   * @param {Object} deps
   * @param {import('./dataset-manager.js').DatasetManager} deps.data
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendText: Function, appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./ui-service.js').UiService} [deps.ui] - Shared variable picker,
   *   so Recode's source uses the same searchable list as the plugins.
   */
  constructor({ data, menus, results, ui }) {
    this.#data = data;
    this.#menus = menus;
    this.#results = results;
    this.#ui = ui ?? null;
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
      id: 'core:count-values',
      path: ['Transform'],
      label: 'Count values within cases…',
      order: 25,
      command: () => this.#openCount(),
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
        const opId = await this.#data.filterCases(condition);
        const after = this.#data.rowCount;
        // 0 rows is the classic "filtered a label, but the column stores codes"
        // trap — diagnose it and tell the user the exact code to match.
        const note = after === 0 && before > 0 ? diagnoseZeroRows(condition, vars) : '';
        this.#results.appendText(
          `Selected cases where \`${condition}\` — ${after.toLocaleString()} of ${before.toLocaleString()} rows kept.${note}`,
          { tag: opId },
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
        const opId = await this.#data.computeVariable(name, expression, type);
        this.#results.appendText(`Computed **${name}** = \`${expression}\`.`, { tag: opId });
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
    dialog.className = 'ct-dialog ct-dialog--wide ct-cr-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-cr">
        <h2 class="ct-dialog__title">Recode into new variable</h2>
        <p class="ct-dialog__hint">Map the values of a variable into a new one
          (collapse categories, reverse-code, bin a scale).</p>
        <div class="ct-row">
          <div class="ct-field">Recode from
            <button type="button" class="ct-cr__pick" name="sourcebtn">
              <span class="ct-cr__picklabel"></span><span class="ct-cr__pickcaret" aria-hidden="true">▾</span>
            </button>
          </div>
          <label class="ct-field">New variable name
            <input name="name" type="text" placeholder="e.g. agegroup" autocomplete="off">
          </label>
          <label class="ct-field">Variable label
            <input name="varlabel" type="text" placeholder="e.g. Age group" autocomplete="off">
          </label>
        </div>
        <div class="ct-row">
          <label class="ct-field">Type
            <select name="type"><option value="numeric">numeric</option><option value="factor">factor</option><option value="string">string</option></select>
          </label>
          <label class="ct-field">Measure <span class="ct-hint">what the new variable can be used for</span>
            <select name="measure">
              <option value="nominal">nominal (categories)</option>
              <option value="ordinal">ordinal (ranked categories)</option>
              <option value="scale">scale (a quantity)</option>
            </select>
          </label>
        </div>
        <div class="ct-cr__ruleshead"><span>Old value</span><span></span><span></span><span>New value</span><span></span><span>Label for it</span><span></span></div>
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

    // Recode source: the SAME searchable picker the plugins use (ui.selectVariables),
    // pre-seeded from the grid selection. A plain <select> of every variable doesn't
    // scale — a GSS extract has thousands — and its longest option used to blow out the
    // row; a compact button that opens the shared picker fixes both.
    const known = new Set(vars.map((m) => m.name));
    const preselected = (this.#data.getSelectedVariables?.() || []).filter((n) => known.has(n));
    let source = preselected[0] || vars[0]?.name || '';
    const metaByName = new Map(vars.map((m) => [m.name, m]));
    const srcBtn = dialog.querySelector('button[name="sourcebtn"]');
    const srcLabel = srcBtn.querySelector('.ct-cr__picklabel');
    const renderSource = () => {
      const m = metaByName.get(source);
      srcLabel.textContent = m ? (m.label ? `${m.label} (${m.name})` : m.name) : 'Choose a variable…';
    };
    renderSource();
    srcBtn.addEventListener('click', async () => {
      if (!this.#ui) return;
      const picked = await this.#ui.selectVariables({
        title: 'Recode from',
        hint: 'The variable whose values you want to map into a new one.',
        multiple: false,
        preselect: source ? [source] : undefined,
      });
      if (picked && picked[0]) { source = picked[0]; renderSource(); }
    });

    // "All other values →" else row.
    const elseRow = makeToControls();
    elseRow.kind.value = 'copy';
    elseRow.sync();
    const elseWrap = dialog.querySelector('.ct-cr__else');
    elseWrap.append(el('span', 'All other values →', 'ct-cr__elselabel'), elseRow.el);

    // Default the measure from the rules, live: a map onto discrete values is a
    // set of categories; anything that copies the original through is still a
    // quantity. The select stays editable — this only saves the common case from
    // being wrong by default. Once the user touches it, we stop guessing.
    const measureEl = dialog.querySelector('select[name="measure"]');
    let measureTouched = false;
    measureEl.addEventListener('change', () => { measureTouched = true; });
    const inferMeasure = () => {
      if (measureTouched) return;
      const targets = [...rows.map((r) => r.read()).filter(Boolean).map((r) => r.to), elseRow.read()];
      const copies = targets.some((t) => t && t.kind === 'copy');
      measureEl.value = copies ? 'scale' : 'nominal';
    };
    dialog.addEventListener('input', inferMeasure);
    dialog.addEventListener('change', inferMeasure);
    inferMeasure();

    dialog.addEventListener('close', async () => {
      const ok = dialog.returnValue === 'ok';
      const name = dialog.querySelector('input[name="name"]').value.trim();
      const type = dialog.querySelector('select[name="type"]').value;
      const varLabel = dialog.querySelector('input[name="varlabel"]').value.trim();
      const measure = measureEl.value;
      const read = rows.map((r) => r.read());
      const rules = read.filter(Boolean);
      // Value labels the user typed beside each rule's new value, e.g. 1 = Agree.
      // Collecting them here (rather than sending the user to Variable View) is the
      // whole point: the packet names the new variable AND its labels in one breath,
      // eight times in a single lab.
      const valueLabels = {};
      rows.forEach((r, i) => {
        const rule = read[i];
        const text = r.labelText();
        if (!text || !rule || rule.to?.kind !== 'value') return;
        if (rule.to.value !== '') valueLabels[String(rule.to.value)] = text;
      });
      const elseRule = elseRow.read();
      dialog.remove();
      if (!ok) return;
      try {
        const opId = await this.#data.recodeVariable(name, source, rules, type, elseRule);
        // Metadata lands as an ordinary `setVariable` patch rather than as new
        // fields on the recode op: `setVariable` already carries label / value
        // labels / measure and already round-trips through the syntax editor, so
        // the recode stays losslessly representable as one `recode` line.
        const patch = {};
        if (varLabel) patch.label = varLabel;
        if (Object.keys(valueLabels).length) patch.valueLabels = valueLabels;
        if (measure) patch.measurementLevel = measure;
        if (Object.keys(patch).length) await this.#data.updateVariable(name, patch);
        const labelled = Object.keys(valueLabels).length;
        this.#results.appendText(
          `Recoded **${source}** → **${name}** (${rules.length} rule${rules.length === 1 ? '' : 's'}` +
            `${labelled ? `, ${labelled} value label${labelled === 1 ? '' : 's'}` : ''}, ${measure}).`,
          { tag: opId }, // undo of the recode drops this line
        );
      } catch (err) {
        this.#results.appendError(err.message);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  // --- Count values within cases (index builder) -----------------------------

  /**
   * SPSS's **Count Values Within Cases** (#174k) — the index builder.
   *
   * Building an index is a standard first-course exercise: take eight
   * dichotomous items, count how many a respondent agreed with, and analyse the
   * count. Compute could already do `a + b + c`, but *counting a specific value*
   * across a variable list meant hand-writing a `CASE WHEN` per variable, eight
   * times, with no way to say "and only score people who answered them all".
   *
   * It emits an ordinary `computeVar` transform rather than a new op type. The
   * expression it writes is exactly what a user could have typed, so the step is
   * undoable, appears in History, and round-trips through the syntax editor as a
   * single `compute` line with nothing lost.
   */
  #openCount() {
    if (!this.#guardData()) return;
    const vars = this.#vars();
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-cr">
        <h2 class="ct-dialog__title">Count values within cases</h2>
        <p class="ct-dialog__hint">Score each case on how many of the chosen variables
          hold one of the values you name — the usual way to build an index from a
          battery of items.</p>
        <div class="ct-row">
          <label class="ct-field">New variable name
            <input name="name" type="text" placeholder="e.g. immig_index" autocomplete="off">
          </label>
          <label class="ct-field">Variable label
            <input name="varlabel" type="text" placeholder="e.g. Pro-immigration index" autocomplete="off">
          </label>
        </div>
        <p class="ct-cr__counthead">Count across these variables</p>
        <div class="ct-cr__countvars"></div>
        <p class="ct-cr__counthead">…each time the value is</p>
        <div class="ct-cr__matches"></div>
        <button type="button" class="ct-cr__addrule">+ Add value</button>
        <label class="ct-cr__complete">
          <input type="checkbox" name="complete" checked>
          Leave the score blank for a case that is missing any of these variables
          <span class="ct-hint">(off: missing items just don't count towards the score)</span>
        </label>
        <p class="ct-hint">Categorical variables are stored as <em>codes</em> (the grid shows
          their labels) — count the code. Hover a variable to see its code↔label map.</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Count</button>
        </menu>
      </form>`;

    const varsEl = dialog.querySelector('.ct-cr__countvars');
    for (const m of vars) {
      const label = el('label', null, 'ct-cr__countvar');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = m.name;
      label.title = codeHint(m) || m.label || m.name;
      label.append(box, el('span', m.label ? `${m.label} (${m.name})` : m.name));
      varsEl.append(label);
    }

    const matchesEl = dialog.querySelector('.ct-cr__matches');
    const matches = [];
    const addMatch = () => {
      const r = makeMatchRow(() => {
        const i = matches.indexOf(r);
        if (i >= 0) matches.splice(i, 1);
        r.el.remove();
      });
      matches.push(r);
      matchesEl.append(r.el);
    };
    addMatch();
    dialog.querySelector('.ct-cr__addrule').addEventListener('click', addMatch);

    dialog.addEventListener('close', async () => {
      const ok = dialog.returnValue === 'ok';
      const name = dialog.querySelector('input[name="name"]').value.trim();
      const varLabel = dialog.querySelector('input[name="varlabel"]').value.trim();
      const complete = dialog.querySelector('input[name="complete"]').checked;
      const chosen = [...varsEl.querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.value);
      const tests = matches.map((r) => r.read()).filter(Boolean);
      dialog.remove();
      if (!ok) return;
      try {
        if (!chosen.length) throw new Error('Count: choose at least one variable to count across.');
        if (!tests.length) throw new Error('Count: name at least one value to count.');
        const metaByName = new Map(vars.map((m) => [m.name, m]));
        const opId = await this.#data.computeVariable(name, countExpr(chosen, tests, complete, metaByName), 'numeric');
        // A count is a quantity, and it is the thing the next analysis means to
        // average — so it is declared scale, not left to be guessed at.
        const patch = { measurementLevel: 'scale' };
        if (varLabel) patch.label = varLabel;
        await this.#data.updateVariable(name, patch);
        this.#results.appendText(
          `Counted **${name}** across ${chosen.length} variable${chosen.length === 1 ? '' : 's'}` +
            `${complete ? ', blank unless all were answered' : ''}.`,
          { tag: opId },
        );
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

  const matcher = makeFromControls();
  const from = matcher.kind;
  const fromInputs = matcher.el;

  const arrow = el('span', '→', 'ct-cr__arrow');
  const to = makeToControls();

  // The value label for this rule's new value ("1 = Agree"), typed here rather
  // than on a second trip through Variable View (#174j). Only meaningful when the
  // target IS a value, so it hides with the value input.
  const lbl = inputEl('label (optional)', 'ct-cr__tolabel', 'Label for the new value');
  // The input sits in its own cell so hiding it doesn't collapse the grid column
  // and slide the remove button under the reader's cursor.
  const lblCell = el('span', null, 'ct-cr__tolabelcell');
  lblCell.append(lbl);
  const syncLabel = () => { lbl.hidden = to.kind.value !== 'value'; };
  to.kind.addEventListener('change', syncLabel);
  syncLabel();

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'ct-cr__rm';
  rm.textContent = '✕';
  rm.title = 'Remove rule';
  rm.addEventListener('click', onRemove);

  // The new-value KIND select and its VALUE input go in as SEPARATE grid cells (not
  // wrapped together), so the value input gets its own full column instead of sharing
  // one with the select.
  wrap.append(from, fromInputs, arrow, to.kind, to.value, lblCell, rm);

  const read = () => {
    const match = matcher.read();
    return match ? { ...match, to: to.read() } : null;
  };
  return { el: wrap, read, labelText: () => (lbl.hidden ? '' : lbl.value.trim()) };
}

/**
 * The "old value" half of a rule: a value / range / missing selector and its
 * inputs. Shared by the Recode rule rows and the Count dialog's value list, which
 * ask the same question — *which values of this variable do you mean?* — and
 * should therefore not answer it with two different sets of controls.
 *
 * Returns `{kind, el, read()}`: `kind` is the selector (its own grid cell),
 * `el` the inputs, and `read()` yields `{from:'value',value} |
 * {from:'range',lo,hi} | {from:'missing'}`, or null when incomplete.
 */
function makeFromControls() {
  const kind = document.createElement('select');
  kind.className = 'ct-cr__from';
  kind.setAttribute('aria-label', 'Match by');
  kind.innerHTML =
    '<option value="value">value</option><option value="range">range</option><option value="missing">missing</option>';

  const val = inputEl('value', 'ct-cr__val', 'Old value');
  const lo = inputEl('low', 'ct-cr__lo', 'Range low');
  const hi = inputEl('high', 'ct-cr__hi', 'Range high');
  const wrap = el('span', null, 'ct-cr__frominputs');
  const dash = el('span', '–', 'ct-cr__dash');
  wrap.append(val, lo, dash, hi);

  const sync = () => {
    val.hidden = kind.value !== 'value';
    lo.hidden = hi.hidden = dash.hidden = kind.value !== 'range';
  };
  kind.addEventListener('change', sync);
  sync();

  const read = () => {
    if (kind.value === 'value') {
      return val.value.trim() === '' ? null : { from: 'value', value: val.value.trim() };
    }
    if (kind.value === 'range') {
      if (lo.value.trim() === '' || hi.value.trim() === '') return null;
      return { from: 'range', lo: Number(lo.value), hi: Number(hi.value) };
    }
    return { from: 'missing' };
  };
  return { kind, el: wrap, read };
}

/** The "to" half of a rule (or the else row): a kind select + value input.
 * Returns `{el, kind, sync, read()}`. */
function makeToControls() {
  const wrap = el('span', null, 'ct-cr__to');
  const kind = document.createElement('select');
  kind.className = 'ct-cr__tokind';
  kind.setAttribute('aria-label', 'Replace with');
  kind.innerHTML =
    '<option value="value">value</option><option value="copy">copy original</option><option value="sysmis">system-missing</option>';
  const value = inputEl('new value', 'ct-cr__toval', 'New value');
  const sync = () => {
    value.hidden = kind.value !== 'value';
  };
  kind.addEventListener('change', sync);
  sync();
  wrap.append(kind, value);
  const read = () => (kind.value === 'value' ? { kind: 'value', value: value.value.trim() } : { kind: kind.value });
  // `value` is exposed so the recode rule row can place it as its own grid cell (the
  // else row/count still use `el`, the kind+value pair wrapped together).
  return { el: wrap, kind, value, sync, read };
}

/** One value-matcher row for the Count dialog: the "from" half of a recode rule
 * plus a remove button. Returns `{el, read()}`. */
function makeMatchRow(onRemove) {
  const wrap = el('div', null, 'ct-cr__match');
  const from = makeFromControls();
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'ct-cr__rm';
  rm.textContent = '✕';
  rm.title = 'Remove value';
  rm.addEventListener('click', onRemove);
  wrap.append(from.kind, from.el, rm);
  return { el: wrap, read: from.read };
}

/**
 * Build the `compute` expression for Count values within cases.
 *
 * One `CASE WHEN … THEN 1 ELSE 0 END` per variable, summed. With `complete`, the
 * whole sum is NULL for a case missing any item — the rule a methods lab states
 * as "only complete responders", and the difference between an index of 3 that
 * means "agreed with three" and one that means "answered three".
 *
 * `metaByName` is needed for exactly that guard. A blank cell is only half of
 * what "missing" means here: survey data says so with *codes* — GSS's 8 and 9
 * for Don't know / No answer, or a declared `(LO THRU 0)` span — and those are
 * ordinary numbers in the column. Testing `IS NULL` alone scored a respondent who
 * refused every item as a complete responder with an index of 0.
 */
function countExpr(names, tests, complete, metaByName) {
  const per = names
    .map((n) => {
      const q = identForExpr(n);
      const conds = tests.map((t) => matchSql(q, t, metaByName.get(n))).join(' OR ');
      return `CASE WHEN ${conds} THEN 1 ELSE 0 END`;
    })
    .join(' + ');
  if (!complete) return per;
  const anyMissing = names.map((n) => missingSql(identForExpr(n), metaByName.get(n))).join(' OR ');
  return `CASE WHEN ${anyMissing} THEN NULL ELSE (${per}) END`;
}

/**
 * "This cell is missing": blank, or one of the variable's designated codes or
 * ranges. Compared through `TRY_CAST` so a text column simply never matches a
 * numeric code rather than erroring — the same shape `DataStore#missingWrap`
 * uses at analysis injection, written out here because a computed variable is
 * built in SQL against the raw column.
 */
function missingSql(q, meta) {
  const tests = [`${q} IS NULL`];
  const codes = (meta?.missingValues ?? []).map(Number).filter(Number.isFinite);
  if (codes.length) tests.push(`TRY_CAST(${q} AS DOUBLE) IN (${codes.join(', ')})`);
  for (const r of meta?.missingRanges ?? []) {
    const lo = Number(Array.isArray(r) ? r[0] : r?.lo);
    const hi = Number(Array.isArray(r) ? r[1] : r?.hi);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
      tests.push(`TRY_CAST(${q} AS DOUBLE) BETWEEN ${lo} AND ${hi}`);
    }
  }
  return tests.length === 1 ? tests[0] : `(${tests.join(' OR ')})`;
}

/**
 * SQL for one value matcher.
 *
 * A value that reads as a number is compared numerically, not as text: a code
 * stored as a DOUBLE renders as `1.0` when cast to VARCHAR, so a text comparison
 * against the `1` the user typed would silently never match and the index would
 * come out zero for everyone.
 */
function matchSql(q, t, meta) {
  if (t.from === 'missing') return missingSql(q, meta);
  if (t.from === 'range') return `TRY_CAST(${q} AS DOUBLE) BETWEEN ${t.lo} AND ${t.hi}`;
  const raw = String(t.value ?? '').trim();
  const n = Number(raw);
  if (raw !== '' && Number.isFinite(n)) return `TRY_CAST(${q} AS DOUBLE) = ${n}`;
  return `CAST(${q} AS VARCHAR) = '${raw.replace(/'/g, "''")}'`;
}

// --- small DOM/SQL helpers ---------------------------------------------------

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function inputEl(placeholder, className, label) {
  const i = document.createElement('input');
  i.type = 'text';
  i.autocomplete = 'off';
  i.placeholder = placeholder;
  i.className = className;
  // A placeholder is not an accessible name: it is announced inconsistently and
  // vanishes on first keystroke. These rows repeat, so the name has to carry which
  // field it is — see the rule-index pass in makeRuleRow.
  i.setAttribute('aria-label', label || placeholder);
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
