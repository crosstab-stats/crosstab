/**
 * @file var-order.js
 * How variables are NAMED and ORDERED in every list that shows them.
 *
 * Two preferences, kept together because SPSS keeps them together for the same reason:
 * Edit ▸ Options ▸ Variable Lists has exactly these two halves — *display* (names or
 * labels) and *order*. The file name predates the first half; renaming it would churn
 * every importer for no behavioural gain, so the scope is stated here instead.
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
/** Storage key for the display half. */
const DISPLAY_KEY = 'crosstab.varlist.display';

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
 * @typedef {'label'|'name'|'both'} VarDisplay
 *
 * What a surface calls a variable when it has room for one thing.
 *
 * The Data grid's header showed `label || name`, so a labelled variable never showed
 * its name anywhere on screen — the name lived in a `title`, which needs a pointer that
 * can rest somewhere, so on a phone, for a keyboard user and for a screen reader it was
 * not reachable at all (owner, 2026-10-07: *"it'd be nice to be able to select what it
 * shows in the column header for when you're searching for a specific variable by
 * name"*).
 *
 * The asymmetry that made it a bug rather than a nicety: the toolbar already lets you
 * FIND by name (`filterVars` matches either) and SORT by name, and then the header
 * picked one for you.
 *
 * `both` is the variable picker's long-standing treatment — label, then the name in a
 * `<code>` — offered to the other surfaces rather than invented for them.
 */

/** The display modes a surface may offer, in the order they are offered. */
export const VAR_DISPLAYS = /** @type {VarDisplay[]} */ (['label', 'name', 'both']);

/** `[value, label]` pairs for a `<select>`. */
export const VAR_DISPLAY_OPTIONS = [
  ['label', 'Show labels'],
  ['name', 'Show names'],
  ['both', 'Show both'],
];

/** The remembered display, defaulting to `label` — what every surface did before the
 * choice existed, so an unset preference changes nothing. */
export function loadVarDisplay() {
  try {
    const v = globalThis.localStorage?.getItem(DISPLAY_KEY);
    return VAR_DISPLAYS.includes(v) ? v : 'label';
  } catch {
    return 'label'; // storage disabled (private mode, sandboxed frame)
  }
}

/** Remember the display. Failing to persist is not worth interrupting anyone for. */
export function saveVarDisplay(value) {
  if (!VAR_DISPLAYS.includes(value)) return;
  try { globalThis.localStorage?.setItem(DISPLAY_KEY, value); } catch { /* storage unavailable */ }
}

/**
 * What to put on screen for one variable, and what to leave for the tooltip.
 *
 * Returns both parts so no surface has to re-derive the fallbacks, and so the one not
 * shown is always still reachable on hover — the fix is that a name stops being
 * hover-ONLY, not that a label becomes hover-only in its place.
 *
 * An unlabelled variable shows its name under every mode: there is nothing else to
 * show, and a blank header would be worse than a redundant one. For the same reason
 * `both` collapses to a single part when the label and the name are the same string.
 *
 * @param {{name: string, label?: string}} meta
 * @param {VarDisplay} mode
 * @returns {{primary: string, secondary: string}} `secondary` is '' when there is
 *   nothing more to say.
 */
export function varDisplay(meta, mode) {
  const name = String(meta?.name ?? '');
  const label = String(meta?.label ?? '').trim();
  if (!label || label === name) return { primary: name, secondary: '' };
  if (mode === 'name') return { primary: name, secondary: label };
  if (mode === 'both') return { primary: label, secondary: name };
  return { primary: label, secondary: name };
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

/**
 * Float the SELECTED variables to the front of a list (#180).
 *
 * The workflow that asks for it: a homework question needs seven variables with unrelated
 * names, the next needs seven different ones. Clearing the first set means remembering each
 * name and finding it again in a 900-column grid — while the `7 selected` counter knows
 * exactly which seven and will not show them to you.
 *
 * The picker has done this since #174a; this is the same partition for the Data grid's columns
 * and Variable View's rows, so the third surface stops being the only one that can answer
 * "which ones are ticked?".
 *
 * Two properties are copied deliberately from that implementation, and they are the reason to
 * copy rather than reinvent:
 *
 *  1. **Nothing selected → no grouping at all.** Not an empty group, not a separator: the plain
 *     list, exactly as before. The feature has to be invisible until it is useful.
 *  2. **The caller decides WHEN.** This function is pure and takes the selection it is given;
 *     the surfaces pass a SNAPSHOT taken when the view was (re)built, never the live set.
 *     Re-partitioning on every tick would make a row jump out from under the cursor mid-click
 *     — the picker's comment calls that out, and a grid is worse, because the column you just
 *     ticked would slide left while you reach for the next one.
 *
 * Within each group the incoming order is preserved, so whatever `sortVars` decided still
 * holds inside the floated block and inside the rest.
 *
 * @param {Array<{name: string}>} metas  already filtered and sorted
 * @param {Set<string>|null|undefined} selected  the snapshot to float
 * @returns {{list: Array<object>, floated: number}} the list, and how many are at the front
 *   (the boundary a surface draws its separator at)
 */
export function floatSelected(metas, selected) {
  const list = Array.isArray(metas) ? metas : [];
  if (!selected || typeof selected.has !== 'function' || selected.size === 0) {
    return { list, floated: 0 };
  }
  const front = [];
  const rest = [];
  for (const m of list) (selected.has(m?.name) ? front : rest).push(m);
  // Everything selected (or nothing of it present) means there is no boundary to draw, so say
  // so rather than reporting a separator that would sit at one end of the list.
  if (!front.length || !rest.length) return { list, floated: 0 };
  return { list: [...front, ...rest], floated: front.length };
}
