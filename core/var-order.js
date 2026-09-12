/**
 * @file var-order.js
 * How variables are ORDERED in every list that shows them.
 *
 * CrossTab shows its variables in three places — the Data grid's columns,
 * Variable View's rows, and the picker every analysis opens
 * ({@link module:core/ui-service~UiService#selectVariables}) — and an ordering
 * preference that only one of them honoured would be worse than none: the user
 * sets "alphabetical" somewhere and then meets file order somewhere else, with
 * nothing on screen explaining why. So the choice lives here, once, and all
 * three read it.
 *
 * It is stored in `localStorage` rather than in the project because it describes
 * how *this reader* likes to hunt for a variable, not anything about the data —
 * the same reasoning that puts SPSS's equivalent under Edit ▸ Options ▸ Variable
 * Lists rather than in the .sav. (SPSS applies its option to dialog lists only;
 * here it applies to the grid and Variable View too, because a 900-column grid
 * is exactly as hard to search as a 900-row dialog list.)
 *
 * Each surface re-reads on render, and the workspace re-renders a tab when it is
 * shown, so changing the order in one place is in effect the moment you look at
 * another.
 *
 * Pure module: no DOM, no app deps.
 */

/** Storage key. Was `crosstab.varpicker.sort` while only the picker honoured it. */
const KEY = 'crosstab.varlist.sort';
const LEGACY_KEY = 'crosstab.varpicker.sort';

/**
 * @typedef {'file'|'file-desc'|'name'|'name-desc'|'label'|'label-desc'} VarOrder
 *
 * Direction is part of the order rather than a separate toggle. Six
 * self-describing entries in one menu are easier to learn than a field
 * selector plus a direction button whose current state has to be read off an
 * arrow — and this strip already carries a filter box and a count.
 *
 * Reversed FILE order earns its place alongside the two alphabetical reverses:
 * a computed or recoded variable lands at the end of the file, so "last first"
 * is how you find the eight dichotomies you just made. Offering it also avoids
 * the obvious question about why two of the three orders reverse and one does
 * not.
 */

/** The orders a surface may offer, in the order they are offered. */
export const VAR_ORDERS = /** @type {VarOrder[]} */ ([
  'file', 'file-desc', 'name', 'name-desc', 'label', 'label-desc',
]);

/** `[value, label]` pairs for a `<select>`. */
export const VAR_ORDER_OPTIONS = [
  ['file', 'File order'],
  ['file-desc', 'File order (last first)'],
  ['name', 'Name (A–Z)'],
  ['name-desc', 'Name (Z–A)'],
  ['label', 'Label (A–Z)'],
  ['label-desc', 'Label (Z–A)'],
];

/** The remembered order, defaulting to file order — what every surface did before
 * the choice existed, so an unset preference changes nothing. */
export function loadVarOrder() {
  try {
    const s = globalThis.localStorage;
    const v = s?.getItem(KEY) ?? s?.getItem(LEGACY_KEY);
    return VAR_ORDERS.includes(v) ? v : 'file';
  } catch {
    return 'file'; // storage disabled (private mode, sandboxed frame)
  }
}

/** Remember the order. Failing to persist is not worth interrupting anyone for. */
export function saveVarOrder(value) {
  if (!VAR_ORDERS.includes(value)) return;
  try { globalThis.localStorage?.setItem(KEY, value); } catch { /* storage unavailable */ }
}

/**
 * Case- and accent-aware comparison.
 *
 * Plain `<` files every lowercase name after every uppercase one, which in a GSS
 * extract (mixed `age`, `IMMASSIM`) reads as two separate alphabets. `numeric`
 * also puts `Q2` before `Q10`, which is the order a person means by "sorted".
 */
const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export function collate(a, b) {
  return COLLATOR.compare(String(a ?? ''), String(b ?? ''));
}

/**
 * `metas` in the given order.
 *
 * Ties break on name so the result is stable and reproducible: two variables
 * sharing a label (or both unlabelled) must not swap places between renders.
 *
 * @template {{name: string, label?: string}} T
 * @param {T[]} metas
 * @param {VarOrder} order
 * @returns {T[]} a copy, except in plain `file` order where the input is passed
 *   through untouched — the dataset's own order is not something this invents.
 */
export function sortVars(metas, order) {
  const desc = typeof order === 'string' && order.endsWith('-desc');
  const key = desc ? order.slice(0, -5) : order;
  if (key !== 'name' && key !== 'label') {
    // File order: the dataset's own, or exactly that read backwards.
    return desc ? [...metas].reverse() : metas;
  }
  const of = key === 'name' ? (m) => m.name : (m) => m.label ?? m.name;
  const asc = [...metas].sort((a, b) => collate(of(a), of(b)) || collate(a.name, b.name));
  // Descending is the ascending order REVERSED, not a negated comparator, so
  // ties reverse with everything else. Negating only the primary key would leave
  // equal-labelled variables in ascending name order inside a descending list —
  // a subtlety nobody would notice until it looked wrong.
  return desc ? asc.reverse() : asc;
}
