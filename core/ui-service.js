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


/** Shortest list that earns a "Selected only" toggle — below this the answer is
 * already on screen, and the control would only be another thing to read. */
const SELECTED_ONLY_MIN = 15;

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
 * @property {boolean} [optional] - This role may be left empty. A single-select
 *   picker then offers an explicit "none" choice, because a radio cannot be
 *   un-chosen once chosen, and nothing is pre-selected — the default answer to an
 *   optional question is "no".
 * @property {string} [okLabel='OK']
 */

import { pickFile as pickOneFile } from './pick-file.js';
import { loadVarOrder, saveVarOrder, sortVars, loadVarDisplay, saveVarDisplay, varDisplay } from './var-order.js';
import { makeVarToolbar, filterVars } from './var-toolbar.js';
import { isCategorical, isQuantitative } from './var-role.js';
import { escapeHtml } from './text.js';

/**
 * A dialog's title row, with the ⓘ when there is a topic to open (#192).
 *
 * One builder for all three dialog kinds here: the alternative is three copies of a
 * title+button row, which is how the plugin manager and the launcher came to disagree
 * about a button they both rendered.
 *
 * @param {string} title @param {string|null} howto @param {Function|null} onHowto
 * @returns {HTMLElement}
 */
function dialogHead(title, howto, onHowto) {
  const head = document.createElement('div');
  head.className = 'ct-dialog__head';
  const h2 = document.createElement('h2');
  h2.className = 'ct-dialog__title';
  h2.textContent = title;
  head.append(h2);
  if (howto && onHowto) {
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'ct-dialog__howto';
    info.textContent = '\u24d8';
    info.title = 'How to use this';
    info.setAttribute('aria-label', 'How to use this');
    info.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onHowto(howto);
    });
    head.append(info);
  }
  return head;
}

/**
 * Which rows the picker shows, given its filter box and its "Selected only" toggle.
 *
 * Pulled out of the dialog so it can be tested: the suite runs `node --test` with no
 * jsdom, and a rule about what a list contains is worth more than an assertion that a
 * line of source still exists.
 *
 * `ticked` is the LIVE tick set, not the selection the dialog opened with — "Selected
 * only" has to mean what is chosen now, or it would show the opening state forever.
 *
 * @param {Array<object>} rows @param {{query: string, selectedOnly: boolean, ticked: Set<string>}} view
 */
export function visibleVars(rows, { query = '', selectedOnly = false, ticked = new Set() } = {}) {
  const hits = filterVars(rows, query);
  return selectedOnly ? hits.filter((m) => ticked.has(m.name)) : hits;
}

/**
 * The picker's status line: how much of the list is on screen, and how much is ticked.
 *
 * The tick half is multi-select only — "1 selected" beside a radio list states what the
 * list already shows. It is rendered into an `aria-live` element, so this string is also
 * what a screen reader hears when a box is ticked.
 */
export function pickerCountLabel({ shown, total, ticked = 0, multiple = true }) {
  const of = shown === total
    ? `${total} variable${total === 1 ? '' : 's'}`
    : `${shown} of ${total} variables`;
  return multiple ? `${of} · ${ticked} selected` : of;
}

/**
 * What to say when the list comes back empty — which emptiness it is.
 *
 * "No variable matches that filter" under a ticked "Selected only" box sends the reader
 * hunting for a typo in a filter they never set.
 */
export function pickerEmptyLabel({ selectedOnly, ticked = 0 }) {
  if (!selectedOnly) return 'No variable matches that filter.';
  return ticked
    ? 'No selected variable matches that filter.'
    : 'Nothing is selected yet. Untick “Selected only” to choose.';
}

export class UiService {
  /** @type {import('./data-store.js').DataStore} */
  #store;

  /**
   * @param {import('./data-store.js').DataStore} dataStore - Source of variable
   *   metadata and the current selection.
   */
  /** @type {(topicId: string) => void} opens the how-to guide (#192). */
  #onHowto = null;

  /**
   * @param {object} dataStore
   * @param {{onHowto?: (topicId: string) => void}} [deps] — `onHowto` puts a ⓘ beside a
   *   dialog's title when the caller names a topic. Injected rather than imported so the
   *   UI service keeps no opinion about where documentation lives, and so a dialog opened
   *   in a test does not need a guide.
   */
  constructor(dataStore, { onHowto = null } = {}) {
    this.#onHowto = onHowto;
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
   * The order is the shared preference in {@link module:core/var-order}, so the
   * grid and Variable View follow the same choice — SPSS's equivalent is a
   * global option (Edit ▸ Options ▸ Variable Lists) that a student sets once in
   * Lab 2 and never revisits, and an option only one list obeyed would be worse
   * than none.
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
      optional = false,
      okLabel = 'OK',
          // A how-to topic id. Present, and with a guide wired, the dialog shows a ⓘ (#192)
      // — help at the moment the question is actually asked.
      howto = null,
    } = options;

    // Cross-dataset scope (#179). OFF by default — for most analyses mixing datasets is a
    // mistake rather than a feature, and defaulting every list to the union would make `AGE`
    // ambiguous in the one place a user most needs to trust what they clicked.
    //
    // It turns itself on when the user has ALREADY ticked variables in more than one dataset,
    // because at that point they have stated the intent and hiding what they just selected
    // behind a toggle would be the app forgetting. No plugin opts in or out: a plugin has no
    // business knowing where its data came from.
    const canSpan = typeof this.#store.allVariableMeta === 'function';
    let allDatasets = canSpan && (this.#store.selectionSpread?.() ?? 0) > 1;
    const metaFor = (spanning) => {
      const raw = spanning ? this.#store.allVariableMeta() : this.#store.getVariableMeta();
      return types?.length ? raw.filter((m) => fitsRole(m, types)) : raw;
    };
    let meta = metaFor(allDatasets);
    // The sidebar/grid selection means "these are the variables I am working on",
    // which is a good default for the variables an analysis is ABOUT and a bad one
    // for a secondary role. Seeding it into an OPTIONAL input inverted that input's
    // default: a weight picker opened with whatever happened to be selected in the
    // Data view already chosen, so a user who wanted no weight got one.
    const seedSelection = () => (allDatasets && this.#store.allSelectedVariables
      ? this.#store.allSelectedVariables()
      : this.#store.getSelectedVariables());
    const checked = new Set(preselect ?? (optional ? [] : seedSelection()));
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
    let selected = meta.filter((m) => checked.has(m.name));
    let rest = meta.filter((m) => !checked.has(m.name));
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
          <div class="ct-dialog__head-slot"></div>
          ${hint ? `<p class="ct-dialog__hint">${escapeHtml(hint)}</p>` : ''}
          <div class="ct-vartools-slot"></div>
          <p class="ct-vartools__count ct-vartools__count--dialog" role="status" aria-live="polite"></p>
          <ul class="ct-dialog__vars"></ul>
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">${escapeHtml(okLabel)}</button>
          </menu>
        </form>`;

      const countEl = dialog.querySelector('.ct-vartools__count');
      dialog.querySelector('.ct-dialog__head-slot')
        .replaceWith(dialogHead(title, howto, this.#onHowto));
      const list = dialog.querySelector('.ct-dialog__vars');

      // The same filter + order strip the Data grid and Variable View carry
      // (var-toolbar.js) — including the rule that Enter belongs to the box and
      // must not reach this dialog's primary button mid-query.
      let query = '';
      // This list has always shown BOTH — the label, then the name in a <code>. That is
      // now one of three choices rather than the only one, so a reader who set "names"
      // in the grid meets names here too. `both` is what it did before, so an unset
      // preference changes nothing.
      let display = loadVarDisplay();
      const bar = makeVarToolbar({
        variant: 'dialog',
        order: loadVarOrder(),
        display,
        onFilter: (q) => { query = q; render(); },
        onOrder: (v) => { saveVarOrder(v); render(); },
        onDisplay: (v) => { display = v; saveVarDisplay(v); render(); },
      });
      dialog.querySelector('.ct-vartools-slot').replaceWith(bar.el);
      const order = bar.orderSelect;

      // The scope switch. Only offered when the project HAS another dataset — a switch that
      // could not change anything reads as broken (the same rule the chart controls follow).
      let scopeBox = null;
      if (canSpan && (this.#store.list?.() ?? []).length > 1) {
        const wrap = document.createElement('label');
        wrap.className = 'ct-vartools__scope';
        scopeBox = document.createElement('input');
        scopeBox.type = 'checkbox';
        scopeBox.checked = allDatasets;
        const txt = document.createElement('span');
        txt.textContent = 'Variables from all datasets';
        wrap.append(scopeBox, txt);
        wrap.title = 'Rows are not matched across datasets — each variable keeps its own cases.';
        scopeBox.addEventListener('change', () => {
          allDatasets = scopeBox.checked;
          meta = metaFor(allDatasets);
          // Re-group here, and only here. The rule is that ticking a box must never reorder
          // rows under the cursor; changing the scope is a deliberate act that replaces the
          // list wholesale, so regrouping is what the user asked for.
          for (const name of [...ticked]) if (!meta.some((m) => m.name === name)) ticked.delete(name);
          selected = meta.filter((m) => checked.has(m.name));
          rest = meta.filter((m) => !checked.has(m.name));
          render();
        });
        bar.el.append(wrap);
      }

      // "Selected only" — the picker's own filter, for the long lists where the ticks are
      // scattered through hundreds of rows and checking what you have chosen means
      // scrolling the whole thing. Multi-select only: a radio picker holds at most one
      // tick, so the control could never earn its place there.
      //
      // Gated on list length for the same reason the scope switch is gated on there being
      // a second dataset — a control that cannot usefully change anything reads as broken,
      // and on a twelve-variable list the answer is already on screen.
      let selectedOnly = false;
      let selectedOnlyBox = null;
      if (multiple && meta.length >= SELECTED_ONLY_MIN) {
        const wrap = document.createElement('label');
        wrap.className = 'ct-vartools__scope';
        selectedOnlyBox = document.createElement('input');
        selectedOnlyBox.type = 'checkbox';
        const txt = document.createElement('span');
        txt.textContent = 'Selected only';
        wrap.append(selectedOnlyBox, txt);
        wrap.title = 'Show only the variables currently ticked.';
        selectedOnlyBox.addEventListener('change', () => {
          selectedOnly = selectedOnlyBox.checked;
          render();
        });
        bar.el.append(wrap);
      }

      const sorted = (rows) => sortVars(rows, order.value);
      // Ticking is live; the grouping above it is not. Filtering on `ticked` rather than on
      // the opening `checked` is what makes this show what is chosen NOW — and because
      // ticking a box does not re-render (the rule that stops rows jumping under the
      // cursor), unticking inside this view leaves the row in place with its box cleared
      // rather than yanking it out from under the pointer.
      const matching = (rows) => visibleVars(rows, { query, selectedOnly, ticked });

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
              el.checked = el.value === '' ? ticked.size === 0 : ticked.has(el.value);
            }
          }
          paintCount();
        });
        const shown = varDisplay(m, display);
        const span = document.createElement('span');
        span.textContent = shown.primary;
        label.append(input, span);
        if (display === 'both' && shown.secondary) {
          const code = document.createElement('code');
          code.textContent = shown.secondary;
          label.append(code);
        }
        // Whichever is not on screen stays one hover away, as in the grid header.
        label.title = [m.name, m.label].filter(Boolean).join(' · ');
        // Which dataset, when it is not this one. The `code` already shows the qualified
        // reference, but a name is read as a name — the badge is what makes the difference
        // visible at a glance rather than something to notice in the punctuation.
        if (m.dataset) {
          const badge = document.createElement('span');
          badge.className = 'ct-dialog__dsbadge';
          badge.textContent = m.dataset;
          badge.title = `From the dataset “${m.dataset}”`;
          label.append(badge);
        }
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

      /**
       * The status line: how much of the list is on screen, and how much is ticked.
       *
       * Separate from {@link render} because ticking deliberately does NOT re-render —
       * rows must not reorder under the cursor — so the count has to be repainted on its
       * own or it would show the opening number for the rest of the dialog's life. The
       * element is `aria-live="polite"`, so this is also how a screen reader is told that
       * a tick landed.
       *
       * The tick count is multi-select only: "1 selected" beside a radio list states
       * something the list already makes obvious.
       */
      let shownCount = 0;
      const paintCount = (shown = shownCount) => {
        shownCount = shown;
        countEl.textContent = pickerCountLabel({
          shown, total: meta.length, ticked: ticked.size, multiple,
        });
      };

      /**
       * The "none" choice for an optional single-select.
       *
       * A radio cannot be un-chosen by clicking it again, so without this an
       * optional role had no way back to empty once anything was picked —
       * Cancel was the only exit, and Cancel does not read as "no thanks", it
       * reads as "abandon the analysis".
       *
       * Never filtered out by the search: it is not a variable, and hiding the
       * way out while hunting for a name would be its own trap.
       */
      const noneRow = () => {
        const li = document.createElement('li');
        li.className = 'ct-dialog__none';
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'var';
        input.value = '';
        input.checked = ticked.size === 0;
        input.addEventListener('change', () => {
          if (input.checked) ticked.clear();
          for (const el of list.querySelectorAll('input[name="var"]')) {
            el.checked = el.value === '' ? ticked.size === 0 : ticked.has(el.value);
          }
        });
        const span = document.createElement('span');
        span.textContent = 'None';
        label.append(input, span);
        li.append(label);
        return li;
      };

      const render = () => {
        const top = sorted(matching(selected));
        const bottom = sorted(matching(rest));
        list.replaceChildren();
        if (optional && !multiple) list.append(noneRow());
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
        paintCount(shown);
        if (!shown) {
          // Which emptiness it is. "No variable matches that filter" under a ticked
          // "Selected only" box sends the reader hunting for a typo in a filter they did
          // not set.
          list.append(groupLabel(pickerEmptyLabel({ selectedOnly, ticked: ticked.size })));
        }
      };
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
          // A how-to topic id. Present, and with a guide wired, the dialog shows a ⓘ (#192)
      // — help at the moment the question is actually asked.
      howto = null,
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

      form.append(dialogHead(title, howto, this.#onHowto));
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
   * @param {Array<{name: string, label?: string, type?: 'text'|'password'|'number'|'select', value?: string, placeholder?: string, hint?: string, step?: number|string, min?: number|string, max?: number|string, options?: Array<{value: string, label?: string}>}>} [options.fields]
   *   A 'select' field takes `options` and resolves to the chosen `value`.
   *   For `type:'number'`, `step` defaults to `'any'` (accepts decimals); pass an
   *   explicit `step`/`min`/`max` to constrain (e.g. `step:1` for integers).
   * @param {string} [options.okLabel='OK']
   * @returns {Promise<Record<string,string> | null>}
   */
  showForm(options = {}) {
    // `howto` puts a ⓘ beside the title when a guide is wired (#192).
    const { title = 'Form', hint, fields = [], okLabel = 'OK', howto = null } = options;
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      const fieldHtml = fields
        .map((f) => {
          if (f.type === 'select') {
            // A one-of-many choice. Exists because "copy this into which project?" is a
            // pick from a list the host knows, and a free-text field for it would be a
            // name the user has to get exactly right.
            const opts = (f.options ?? [])
              .map((o) => `<option value="${escapeHtml(String(o.value))}"${String(o.value) === String(f.value ?? '') ? ' selected' : ''}>${escapeHtml(o.label ?? o.value)}</option>`)
              .join('');
            return `
            <label class="ct-field">${escapeHtml(f.label ?? f.name)}${
              f.hint ? ` <span class="ct-hint">${escapeHtml(f.hint)}</span>` : ''
            }
              <select name="${escapeHtml(f.name)}">${opts}</select>
            </label>`;
          }
          const type = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
          // Number inputs default to `step="any"` so a fractional value (e.g. a test
          // proportion of 0.892) isn't rejected against the browser's step=1 grid,
          // which anchors on the field's default and only accepts x, x±1, x±2…
          // A field may still declare an explicit step/min/max for integer-only cases.
          const numAttrs =
            type === 'number'
              ? ` step="${escapeHtml(f.step != null ? String(f.step) : 'any')}"${
                  f.min != null ? ` min="${escapeHtml(String(f.min))}"` : ''
                }${f.max != null ? ` max="${escapeHtml(String(f.max))}"` : ''}`
              : '';
          return `
            <label class="ct-field">${escapeHtml(f.label ?? f.name)}${
              f.hint ? ` <span class="ct-hint">${escapeHtml(f.hint)}</span>` : ''
            }
              <input name="${escapeHtml(f.name)}" type="${type}" value="${escapeHtml(f.value ?? '')}"
                     placeholder="${escapeHtml(f.placeholder ?? '')}"${numAttrs} autocomplete="off">
            </label>`;
        })
        .join('');
      dialog.innerHTML = `
        <form method="dialog" class="ct-dialog__form ct-edit">
          <div class="ct-dialog__head-slot"></div>
          ${hint ? `<p class="ct-dialog__hint">${escapeHtml(hint)}</p>` : ''}
          ${fieldHtml}
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">${escapeHtml(okLabel)}</button>
          </menu>
        </form>`;
      dialog.querySelector('.ct-dialog__head-slot').replaceWith(dialogHead(title, howto, this.#onHowto));
      dialog.addEventListener('close', () => {
        const ok = dialog.returnValue === 'ok';
        const out = {};
        if (ok) {
          for (const f of fields) {
            const sel = f.type === 'select' ? 'select' : 'input';
            const el = dialog.querySelector(`${sel}[name="${escapeHtml(f.name)}"]`);
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
  pickFile(opts = {}) {
    // Delegates. The focus fallback this method used to own is now shared, which is the
    // point of the move: four other pickers relied on `cancel` alone and simply never
    // settled without it. See core/pick-file.js.
    return pickOneFile(opts);
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
  // ADDITIVE ONLY. An exact type match wins before anything below is consulted, so this
  // function can only ever widen what a picker offers — never narrow it. That is a
  // deliberate limit on #188's blast radius: the reported fault was a variable being
  // MISSING from a list, and a fix that also started removing variables from lists
  // (a numeric column someone marked nominal disappearing from weight pickers) would
  // break working projects to tidy up a taxonomy. Untidiness that costs nothing —
  // a Scale-measured factor still appearing among grouping variables — is left alone.
  if (types.includes(m.type)) return true;
  const wantsCategorical = types.includes('factor') || types.includes('string');
  const wantsNumeric = types.includes('numeric');
  // Categorical role: a numeric-CODED category qualifies (#174i).
  if (wantsCategorical && !wantsNumeric && isCategorical(m)) return true;
  // Numeric role: the mirror image, and the half that was missing (#188). A variable
  // the FILE calls Scale is a quantity even if the importer typed it `factor` because
  // it happened to carry a value label — which is how a GSS weight came to be
  // unselectable as a weight while its data sat in DuckDB as a plain number. The test
  // is `isQuantitative`, not `!isCategorical`, so a nominal code is still refused:
  // widening a numeric role to *everything* would offer race codes as a weight.
  if (wantsNumeric && m.type !== 'string' && isQuantitative(m)) return true;
  return false;
}


