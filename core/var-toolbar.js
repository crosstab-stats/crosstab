/**
 * @file var-toolbar.js
 * The filter + order control strip that sits above EVERY list of variables.
 *
 * There are three such lists — the Data grid's columns, Variable View's rows,
 * and the picker every analysis opens ({@link module:core/ui-service}) — and
 * until now each built its own strip. The copies drifted, predictably and fast:
 * different placeholder text (one of which did not fit its box), an accessible
 * name on some and not others, a debounce on some and not others, and three
 * copies of the same name-or-label predicate. The picker had drifted from the
 * other two within a *day* of all three being touched, which is the argument for
 * this file existing: a widget duplicated three times is not a widget, it is
 * three widgets that happen to agree today.
 *
 * So the strip is built here, once, and the differences that were never
 * decisions are gone with it:
 *
 *  - **One wording.** Both surfaces match on name OR label, so the box says so
 *    rather than naming the things being filtered — "columns" and "variables"
 *    are the same objects seen from two tabs.
 *  - **An accessible name, always.** A placeholder is a visual affordance, not
 *    an accessible name; it is announced inconsistently and vanishes on the
 *    first keystroke.
 *  - **Debounced, always.** The grid used to re-read DuckDB on every keystroke —
 *    a round-trip per character on a 971-variable file — and the picker rebuilt
 *    ~900 list nodes per keystroke.
 *  - **Enter never submits.** Harmless in a panel, load-bearing in the picker,
 *    where a half-typed query landing on the dialog's primary button confirms a
 *    selection the user has not finished making. One rule, not a flag.
 *
 * What is deliberately NOT shared is the count that follows the controls. Each
 * caller appends its own, because they report different facts: the grid's is the
 * variable SELECTION ("3 selected"), Variable View's is the filter result
 * ("971 variables"), the picker's is how much of the list survived the search
 * ("12 of 971 variables"). Same slot, different meanings; sharing it would be a
 * lie rather than a saving.
 *
 * Ordering itself lives in {@link module:core/var-order} — kept separate and
 * DOM-free so the sort and the preference stay headlessly testable.
 */

import { VAR_ORDER_OPTIONS } from './var-order.js';

/** How long to wait after the last keystroke before filtering. */
const DEBOUNCE_MS = 100;

/**
 * Build the strip.
 *
 * @param {Object} opts
 * @param {string} [opts.filter=''] - initial filter text
 * @param {(q: string) => void} opts.onFilter - called with the text, debounced
 * @param {string} opts.order - initial {@link module:core/var-order} order
 * @param {(v: string) => void} opts.onOrder - called with the chosen order
 * @param {'bar'|'dialog'} [opts.variant='bar'] - `bar` is a panel toolbar (its own
 *   background and bottom rule); `dialog` sits inside a modal and brings none.
 * @returns {{el: HTMLElement, filterInput: HTMLInputElement, orderSelect: HTMLSelectElement}}
 */
export function makeVarToolbar({ filter = '', onFilter, order, onOrder, variant = 'bar' }) {
  const el = document.createElement('div');
  el.className = `ct-vartools ct-vartools--${variant === 'dialog' ? 'dialog' : 'bar'}`;

  const filterInput = document.createElement('input');
  filterInput.type = 'search';
  filterInput.className = 'ct-vartools__q';
  filterInput.placeholder = 'Filter by name or label…';
  filterInput.setAttribute('aria-label', 'Filter variables by name or label');
  filterInput.autocomplete = 'off';
  filterInput.value = filter;

  let debounce = null;
  filterInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => onFilter(filterInput.value), DEBOUNCE_MS);
  });
  // Enter belongs to the filter box while the caret is in it. Inside the picker's
  // <form> it would otherwise reach the primary button and confirm a selection
  // mid-query; outside a form it does nothing, so this needs no condition.
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  const orderSelect = document.createElement('select');
  orderSelect.className = 'ct-vartools__order';
  orderSelect.setAttribute('aria-label', 'Variable order');
  orderSelect.title = 'Order the variables: file order or A–Z / Z–A by name or label';
  for (const [v, label] of VAR_ORDER_OPTIONS) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (v === order) o.selected = true;
    orderSelect.append(o);
  }
  orderSelect.addEventListener('change', () => onOrder(orderSelect.value));

  el.append(filterInput, orderSelect);
  return { el, filterInput, orderSelect };
}

/**
 * The predicate the box implies: a variable matches when the query appears in its
 * name or in its label, case-insensitively. Empty query matches everything.
 *
 * Shared for the same reason the widget is — three copies of this test had to
 * agree for the control to mean one thing in three places.
 *
 * @template {{name: string, label?: string}} T
 * @param {T[]} metas
 * @param {string} query
 * @returns {T[]}
 */
export function filterVars(metas, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return metas;
  return metas.filter(
    (m) => m.name.toLowerCase().includes(q) || String(m.label ?? '').toLowerCase().includes(q),
  );
}
