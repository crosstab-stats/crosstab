/**
 * @file ui-service.js
 * Host-rendered dialogs for plugins (`app.ui`).
 *
 * Because every plugin runs in a sandboxed iframe with no access to the host
 * DOM, a plugin cannot draw its own dialog onto the page. Instead it *describes*
 * the interaction it needs and the engine renders it, in the host document, and
 * returns the result across the postMessage boundary. This also gives every
 * analysis a consistent, SPSS-like dialog look without each plugin reinventing
 * one.
 *
 * The first primitive is {@link UiService#selectVariables} — the variable picker
 * almost every analysis opens with. A general declarative form dialog
 * (`showForm`) is the natural next primitive once a second analysis needs
 * options beyond variable choice; it is intentionally not built yet.
 */

/**
 * @typedef {Object} SelectVariablesOptions
 * @property {string} [title='Select variables']
 * @property {string} [hint] - Sub-heading explaining the choice.
 * @property {boolean} [multiple=true] - Allow multiple selection (checkboxes)
 *   vs. single (radios).
 * @property {string[]} [preselect] - Variable names checked initially. Defaults
 *   to the user's current sidebar selection.
 * @property {Array<'numeric'|'string'|'factor'>} [types] - Restrict the list to
 *   these variable types (e.g. only categorical variables for a crosstab).
 * @property {string} [okLabel='OK']
 */

export class UiService {
  /** @type {import('./data-store.js').DataStore} */
  #store;

  /**
   * @param {import('./data-store.js').DataStore} dataStore - Source of variable
   *   metadata and the current selection.
   */
  constructor(dataStore) {
    this.#store = dataStore;
  }

  /**
   * Show a modal variable picker and resolve with the chosen variable names, or
   * `null` if the user cancels.
   *
   * The list is **searchable and sortable** (#174a). That is not decoration: a
   * GSS extract carries ~900 variables, and this picker is the surface a student
   * meets in *every* analysis — it was the only one of the three variable
   * surfaces (Variable View, data grid, this) with neither a filter box nor an
   * ordering choice, so finding IMMRGHTS meant scrolling 896 rows in file order.
   * The sort choice is remembered across dialogs and sessions, because SPSS's
   * equivalent is a global preference (Edit ▸ Options ▸ Variable Lists) that a
   * student sets once in Lab 2 and never revisits.
   *
   * @param {SelectVariablesOptions} [options]
   * @returns {Promise<string[] | null>}
   */
  selectVariables(options = {}) {
    const {
      title = 'Select variables',
      hint,
      multiple = true,
      preselect,
      types,
      exclude,
      okLabel = 'OK',
    } = options;

    let meta = this.#store.getVariableMeta();
    if (types?.length) meta = meta.filter((m) => fitsRole(m, types));
    const checked = new Set(preselect ?? this.#store.getSelectedVariables());
    const excluded = new Set(exclude ?? []); // disabled (e.g. chosen in a prior `unique` round)
    const inputType = multiple ? 'checkbox' : 'radio';

    // Float the already-selected variables (e.g. ticked in the data grid or the
    // sidebar) into a "Selected" group at the top — pre-checked — so the common
    // case is a glance-and-OK, with the full list still below for adjustments.
    // For a single-select picker (radios) we only pre-check when exactly one is
    // selected; with several selected we still surface them on top but let the
    // user pick which one (several pre-checked radios can't coexist).
    //
    // Grouping is decided ONCE, from the incoming selection, and never
    // recomputed: ticking a box must not make its row jump to the top group
    // under the user's cursor.
    const selected = meta.filter((m) => checked.has(m.name));
    const rest = meta.filter((m) => !checked.has(m.name));
    const autoCheck = multiple || selected.length === 1;
    // Live tick state, kept outside the DOM so re-rendering (filter/sort) is lossless.
    const ticked = new Set(
      autoCheck ? selected.filter((m) => !excluded.has(m.name)).map((m) => m.name) : [],
    );

    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      dialog.innerHTML = `
        <form method="dialog" class="ct-dialog__form">
          <h2 class="ct-dialog__title">${esc(title)}</h2>
          ${hint ? `<p class="ct-dialog__hint">${esc(hint)}</p>` : ''}
          <div class="ct-varfind">
            <input type="search" class="ct-varfind__q" placeholder="Search name or label…"
                   aria-label="Search variables by name or label" autocomplete="off">
            <label class="ct-varfind__sort">Sort
              <select class="ct-varfind__order" aria-label="Variable list order">
                <option value="file">File order</option>
                <option value="name">Name (A–Z)</option>
                <option value="label">Label (A–Z)</option>
              </select>
            </label>
          </div>
          <p class="ct-varfind__count" role="status" aria-live="polite"></p>
          <ul class="ct-dialog__vars"></ul>
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">${esc(okLabel)}</button>
          </menu>
        </form>`;

      const search = dialog.querySelector('.ct-varfind__q');
      const order = dialog.querySelector('.ct-varfind__order');
      const countEl = dialog.querySelector('.ct-varfind__count');
      const list = dialog.querySelector('.ct-dialog__vars');
      order.value = loadVarSort();

      // Enter in the search box must not submit the form as OK on a half-typed
      // query — the same rule selectFromList follows.
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
      });

      const sorted = (rows) => {
        const key = order.value;
        if (key === 'file') return rows;
        const of = key === 'name' ? (m) => m.name : (m) => m.label ?? m.name;
        return [...rows].sort((a, b) => collate(of(a), of(b)) || collate(a.name, b.name));
      };
      const matching = (rows) => {
        const q = search.value.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(
          (m) =>
            m.name.toLowerCase().includes(q) || String(m.label ?? '').toLowerCase().includes(q),
        );
      };

      const row = (m) => {
        const disabled = excluded.has(m.name);
        const li = document.createElement('li');
        if (disabled) li.className = 'ct-dialog__excluded';
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = inputType;
        input.name = 'var';
        input.value = m.name;
        input.disabled = disabled;
        input.checked = ticked.has(m.name);
        input.addEventListener('change', () => {
          if (!multiple) ticked.clear();
          if (input.checked) ticked.add(m.name);
          else ticked.delete(m.name);
          // A radio turning on silently turns its siblings off; repaint so the
          // rows agree with the model even when the browser did it for us.
          if (!multiple) {
            for (const el of list.querySelectorAll('input[name="var"]')) {
              el.checked = ticked.has(el.value);
            }
          }
        });
        const span = document.createElement('span');
        span.textContent = m.label ?? m.name;
        const code = document.createElement('code');
        code.textContent = m.name;
        label.append(input, span, code);
        if (disabled) {
          const taken = document.createElement('span');
          taken.className = 'ct-dialog__taken';
          taken.textContent = 'already selected';
          label.append(taken);
        }
        li.append(label);
        return li;
      };
      const groupLabel = (text) => {
        const li = document.createElement('li');
        li.className = 'ct-dialog__group';
        li.textContent = text;
        return li;
      };

      const render = () => {
        const top = sorted(matching(selected));
        const bottom = sorted(matching(rest));
        list.replaceChildren();
        if (selected.length) {
          if (top.length) {
            list.append(groupLabel('Selected'));
            for (const m of top) list.append(row(m));
          }
          if (bottom.length) {
            list.append(groupLabel('All variables'));
            for (const m of bottom) list.append(row(m));
          }
        } else {
          for (const m of bottom) list.append(row(m));
        }
        const shown = top.length + bottom.length;
        countEl.textContent =
          shown === meta.length
            ? `${meta.length} variable${meta.length === 1 ? '' : 's'}`
            : `${shown} of ${meta.length} variables`;
        if (!shown) list.append(groupLabel('No variable matches that search.'));
      };
      search.addEventListener('input', render);
      order.addEventListener('change', () => {
        saveVarSort(order.value);
        render();
      });
      render();

      document.body.append(dialog);
      dialog.addEventListener('close', () => {
        dialog.remove();
        // Read the model, not the DOM: a tick scrolled out by a search is still a tick.
        resolve(dialog.returnValue === 'ok' ? [...ticked] : null);
      });
      dialog.showModal();
    });
  }

  /**
   * Show a modal, **searchable** multi-select over an arbitrary list of items —
   * for choosing from data the engine doesn't hold yet (e.g. the variable
   * catalog of a file *before* import, which can be thousands of entries).
   * Unlike {@link UiService#selectVariables}, the candidate list is supplied by
   * the caller rather than read from the dataset.
   *
   * @param {Object} [options]
   * @param {string} [options.title='Select']
   * @param {string} [options.hint]
   * @param {Array<{value: string, label?: string}>} [options.items]
   * @param {boolean} [options.multiple=true]
   * @param {string} [options.okLabel='OK']
   * @param {string} [options.searchPlaceholder='Filter…']
   * @param {string[]} [options.selected] - Values pre-checked when the dialog opens
   *   (for `multiple`; single-select seeds the radio from the first). Values not in
   *   `items` are ignored.
   * @returns {Promise<string[] | null>} Chosen values, or `null` if cancelled.
   */
  selectFromList(options = {}) {
    const {
      title = 'Select',
      hint,
      items = [],
      multiple = true,
      okLabel = 'OK',
      searchPlaceholder = 'Filter…',
      selected: initialSelected = [],
    } = options;
    const CAP = 500; // max rows rendered at once; refine search to see more
    const seed = multiple ? initialSelected : initialSelected.slice(0, 1);
    const selected = new Set(seed);

    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      const form = document.createElement('form');
      form.method = 'dialog';
      form.className = 'ct-dialog__form';

      const h2 = document.createElement('h2');
      h2.className = 'ct-dialog__title';
      h2.textContent = title;
      form.append(h2);
      if (hint) {
        const p = document.createElement('p');
        p.className = 'ct-dialog__hint';
        p.textContent = hint;
        form.append(p);
      }

      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = searchPlaceholder;
      search.setAttribute('aria-label', searchPlaceholder || 'Filter the list');
      search.style.cssText =
        'width:100%; padding:8px; margin:0 0 8px; border:1px solid var(--line,#ccc);' +
        ' border-radius:6px; font:inherit;';
      // Don't let Enter in the filter confirm (OK) a half-typed query — pick an
      // item or click OK. (Enter maps to the primary button elsewhere; here the
      // filter box owns it.)
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
      });
      form.append(search);

      const bar = document.createElement('div');
      bar.style.cssText =
        'display:flex; justify-content:space-between; align-items:center;' +
        ' margin:0 0 8px; font-size:13px; color:#5a6470;';
      const count = document.createElement('span');
      bar.append(count);
      if (multiple) {
        const selAll = document.createElement('button');
        selAll.type = 'button';
        selAll.textContent = 'Select all shown';
        selAll.style.cssText =
          'font:inherit; font-size:13px; background:none; border:none;' +
          ' color:var(--accent,#2572a5); cursor:pointer; padding:0;';
        selAll.addEventListener('click', () => {
          for (const it of shown) selected.add(it.value);
          render();
        });
        bar.append(selAll);
      }
      form.append(bar);

      const list = document.createElement('ul');
      list.className = 'ct-dialog__vars';
      form.append(list);

      const menu = document.createElement('menu');
      menu.className = 'ct-dialog__buttons';
      const cancel = document.createElement('button');
      cancel.type = 'submit';
      cancel.value = 'cancel';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.type = 'submit';
      ok.value = 'ok';
      ok.className = 'ct-dialog__primary';
      ok.textContent = okLabel;
      menu.append(cancel, ok);
      form.append(menu);
      dialog.append(form);

      let shown = [];
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const matches = q
          ? items.filter(
              (it) =>
                (it.label ?? it.value).toLowerCase().includes(q) ||
                it.value.toLowerCase().includes(q),
            )
          : items;
        shown = matches.slice(0, CAP);
        list.replaceChildren();
        for (const it of shown) {
          const li = document.createElement('li');
          const label = document.createElement('label');
          const input = document.createElement('input');
          input.type = multiple ? 'checkbox' : 'radio';
          input.name = 'item';
          input.value = it.value;
          input.checked = selected.has(it.value);
          input.addEventListener('change', () => {
            if (!multiple) selected.clear();
            if (input.checked) selected.add(it.value);
            else selected.delete(it.value);
            count.textContent = `${selected.size} selected`;
          });
          const span = document.createElement('span');
          span.textContent = it.label ?? it.value;
          const code = document.createElement('code');
          code.textContent = it.value;
          label.append(input, span, code);
          li.append(label);
          list.append(li);
        }
        if (matches.length > CAP) {
          const li = document.createElement('li');
          li.style.cssText = 'color:#646e77; padding:6px;';
          li.textContent = `Showing first ${CAP} of ${matches.length} — refine your filter.`;
          list.append(li);
        }
        count.textContent = `${selected.size} selected`;
      };
      search.addEventListener('input', render);
      render();

      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(dialog.returnValue === 'ok' ? [...selected] : null);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /**
   * Show a modal form of text inputs and resolve with the entered values (or
   * `null` if cancelled). The general declarative input dialog — for analysis
   * options or, e.g., a FRED importer asking for a series ID and API key.
   *
   * @param {Object} [options]
   * @param {string} [options.title='Form']
   * @param {string} [options.hint]
   * @param {Array<{name: string, label?: string, type?: 'text'|'password'|'number', value?: string, placeholder?: string, hint?: string}>} [options.fields]
   * @param {string} [options.okLabel='OK']
   * @returns {Promise<Record<string,string> | null>}
   */
  showForm(options = {}) {
    const { title = 'Form', hint, fields = [], okLabel = 'OK' } = options;
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      const fieldHtml = fields
        .map((f) => {
          const type = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
          return `
            <label class="ct-field">${esc(f.label ?? f.name)}${
              f.hint ? ` <span class="ct-hint">${esc(f.hint)}</span>` : ''
            }
              <input name="${attr(f.name)}" type="${type}" value="${attr(f.value ?? '')}"
                     placeholder="${attr(f.placeholder ?? '')}" autocomplete="off">
            </label>`;
        })
        .join('');
      dialog.innerHTML = `
        <form method="dialog" class="ct-dialog__form ct-edit">
          <h2 class="ct-dialog__title">${esc(title)}</h2>
          ${hint ? `<p class="ct-dialog__hint">${esc(hint)}</p>` : ''}
          ${fieldHtml}
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">${esc(okLabel)}</button>
          </menu>
        </form>`;
      dialog.addEventListener('close', () => {
        const ok = dialog.returnValue === 'ok';
        const out = {};
        if (ok) {
          for (const f of fields) {
            const el = dialog.querySelector(`input[name="${attr(f.name)}"]`);
            out[f.name] = el ? el.value : '';
          }
        }
        dialog.remove();
        resolve(ok ? out : null);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /**
   * Ask the user for a file and hand the plugin the `File` itself.
   *
   * The picker is host-owned because a sandboxed frame cannot open one — and should not:
   * this way the user's choice is the only thing that crosses the boundary, one file at a
   * time, with no path and no directory access.
   *
   * Added for the SAS companion catalog (#150-adjacent): a `.sas7bdat` records only a
   * format NAME for each variable and keeps the labels in a separate `.sas7bcat`, so the
   * importer has to be able to ask for the second half.
   *
   * @param {{title?: string, accept?: string, hint?: string}} [opts]
   * @returns {Promise<File|null>} null if the user cancels
   */
  pickFile({ accept = '', hint = '' } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.display = 'none';
      if (hint) input.title = hint;
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; input.remove(); resolve(v); } };
      input.addEventListener('change', () => done(input.files?.[0] ?? null));
      // `cancel` is not universal; the focus fallback covers browsers without it. Both
      // are idempotent through `settled`, so a double fire cannot resolve twice.
      input.addEventListener('cancel', () => done(null));
      window.addEventListener('focus', () => setTimeout(() => done(input.files?.[0] ?? null), 400), { once: true });
      document.body.append(input);
      input.click();
    });
  }

  /**
   * The frozen object exposed to plugins as `app.ui`.
   * @returns {Readonly<{
   *   selectVariables: (opts?: SelectVariablesOptions) => Promise<string[]|null>,
   *   selectFromList: (opts?: object) => Promise<string[]|null>,
   *   showForm: (opts?: object) => Promise<Record<string,string>|null>,
 *   pickFile: (opts?: object) => Promise<File|null>,
   * }>}
   */
  get api() {
    return Object.freeze({
      selectVariables: (opts) => this.selectVariables(opts),
      selectFromList: (opts) => this.selectFromList(opts),
      showForm: (opts) => this.showForm(opts),
      pickFile: (opts) => this.pickFile(opts),
    });
  }
}

/**
 * Does a variable fit the role an input asked for?
 *
 * `types` is a list of **storage** types, but what an analysis actually needs is
 * a **role**: Crosstabs' rows, the independent t-test's grouping variable and
 * ANOVA's factor all declare `['factor', 'string']` meaning *categorical*, not
 * meaning "stored as text". Filtering on storage alone hid every numeric-coded
 * category — which is most of them. A dichotomy recoded to 1/2 is numeric, and
 * so the entire recode-then-crosstab exercise (#174i) failed silently: the
 * variable the student had just made was not in the list, with nothing on screen
 * saying why. The same applied to any `.sav` variable SPSS marked nominal that
 * arrived without value labels.
 *
 * So a categorical role also admits a numeric variable whose **measure** says it
 * is categorical. Measure is already first-class here: the importers carry it,
 * Variable View edits it, and Recode sets it. A numeric role is left alone — it
 * means arithmetic, and widening that would be a different (and wrong) claim.
 */
function fitsRole(m, types) {
  if (types.includes(m.type)) return true;
  const wantsCategorical = types.includes('factor') || types.includes('string');
  if (!wantsCategorical || types.includes('numeric') || m.type !== 'numeric') return false;
  return m.measurementLevel === 'nominal' || m.measurementLevel === 'ordinal';
}

/**
 * The variable picker's ordering preference (`'file' | 'name' | 'label'`).
 *
 * It lives in localStorage rather than in the project, because it describes how
 * *this reader* likes to hunt for a variable, not anything about the data — the
 * same reasoning SPSS applies by putting it in Edit ▸ Options rather than in the
 * .sav. A missing or unrecognised value falls back to file order, which is what
 * the picker did before the choice existed.
 */
const VAR_SORT_KEY = 'crosstab.varpicker.sort';
const VAR_SORTS = ['file', 'name', 'label'];

/** Read the remembered picker order, defaulting to file order. */
export function loadVarSort() {
  try {
    const v = globalThis.localStorage?.getItem(VAR_SORT_KEY);
    return VAR_SORTS.includes(v) ? v : 'file';
  } catch {
    return 'file'; // storage disabled (private mode, sandboxed frame)
  }
}

/** Remember the picker order. Failure to persist is not worth interrupting a dialog for. */
export function saveVarSort(value) {
  if (!VAR_SORTS.includes(value)) return;
  try { globalThis.localStorage?.setItem(VAR_SORT_KEY, value); } catch { /* storage unavailable */ }
}

/**
 * Case- and accent-aware comparison for the A–Z orders.
 *
 * Plain `<` would file every lowercase name after every uppercase one, which in
 * a GSS extract (mixed `age`, `IMMASSIM`) reads as two separate alphabets.
 */
const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
function collate(a, b) {
  return COLLATOR.compare(String(a ?? ''), String(b ?? ''));
}

/** HTML-escape text content. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for an HTML attribute value. */
function attr(s) {
  return esc(s).replace(/"/g, '&quot;');
}
