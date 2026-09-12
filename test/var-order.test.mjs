/**
 * @file var-order.test.mjs
 * How variables are ordered in every list that shows them (core/var-order.js).
 *
 * Three surfaces share this — the Data grid's columns, Variable View's rows and
 * the picker every analysis opens — so a bug here is a bug in three places at
 * once, and two of its failure modes are silent: mutating the caller's array
 * (which would reorder the dataset itself, not just the view) and an unstable
 * tie-break (which makes a list shuffle between renders for no visible reason).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { sortVars, VAR_ORDERS, VAR_ORDER_OPTIONS, collate } = await import('../core/var-order.js');

/** Deliberately mixed case, a duplicate label, and a missing one. */
const VARS = [
  { name: 'wtssnr', label: 'Weight' },
  { name: 'age', label: 'Age of respondent' },
  { name: 'IMMASSIM', label: 'Immigrants assimilate' },
  { name: 'q10', label: 'Duplicate' },
  { name: 'q2', label: 'Duplicate' },
  { name: 'sex' }, // no label — falls back to its name
];
const names = (rows) => rows.map((m) => m.name);

test('file order is the dataset\'s own, passed through untouched', () => {
  assert.deepEqual(names(sortVars(VARS, 'file')), names(VARS));
  // Not a copy: plain file order is the identity, and copying would only invite
  // a caller to believe it owns the result.
  assert.equal(sortVars(VARS, 'file'), VARS);
});

test('an unknown or missing order falls back to file order rather than throwing', () => {
  for (const bad of [undefined, null, '', 'sideways', 42, {}]) {
    assert.deepEqual(names(sortVars(VARS, bad)), names(VARS), String(bad));
  }
});

test('name and label sort case-insensitively and numerically', () => {
  // Case-insensitive: IMMASSIM must file among the lowercase names, not before
  // all of them — an uppercase-first sort reads as two separate alphabets.
  assert.deepEqual(names(sortVars(VARS, 'name')), ['age', 'IMMASSIM', 'q2', 'q10', 'sex', 'wtssnr']);
  // Numeric-aware: q2 before q10, which is what a person means by "sorted".
  assert.ok(names(sortVars(VARS, 'name')).indexOf('q2') < names(sortVars(VARS, 'name')).indexOf('q10'));
  assert.deepEqual(names(sortVars(VARS, 'label')),
    ['age', 'q2', 'q10', 'IMMASSIM', 'sex', 'wtssnr']);
});

test('an unlabelled variable sorts by its name, not to the top as a blank', () => {
  const byLabel = names(sortVars(VARS, 'label'));
  // `sex` has no label; it files under "sex", between "Immigrants…" and "Weight".
  assert.equal(byLabel[byLabel.length - 2], 'sex');
  assert.notEqual(byLabel[0], 'sex');
});

test('ties break on name, so a repeated sort never shuffles', () => {
  // q2 and q10 share a label. Their relative order must come from the name, and
  // must be the same every time — a list that reorders itself between renders
  // for no visible reason is the kind of bug nobody manages to report.
  const once = names(sortVars(VARS, 'label'));
  for (let i = 0; i < 5; i++) assert.deepEqual(names(sortVars(VARS, 'label')), once);
  assert.ok(once.indexOf('q2') < once.indexOf('q10'));
});

test('descending is the ascending order reversed — ties included', () => {
  for (const key of ['name', 'label']) {
    const asc = names(sortVars(VARS, key));
    const desc = names(sortVars(VARS, `${key}-desc`));
    assert.deepEqual(desc, [...asc].reverse(), key);
  }
  // Specifically: the tie between q2 and q10 flips too. A negated primary
  // comparator would have left them in ascending name order inside a descending
  // list, which looks almost right.
  const desc = names(sortVars(VARS, 'label-desc'));
  assert.ok(desc.indexOf('q10') < desc.indexOf('q2'));
});

test('reversed file order is the file read backwards', () => {
  assert.deepEqual(names(sortVars(VARS, 'file-desc')), [...names(VARS)].reverse());
});

test('sorting never mutates the caller\'s array', () => {
  // The grid hands its live `metas` in. Sorting in place would reorder the
  // dataset's own variable list, not the view of it.
  for (const order of VAR_ORDERS) {
    const input = VARS.map((m) => ({ ...m }));
    const before = names(input);
    sortVars(input, order);
    assert.deepEqual(names(input), before, order);
  }
});

test('every offered option is a real order, and every order is offered', () => {
  assert.deepEqual(VAR_ORDER_OPTIONS.map(([v]) => v), VAR_ORDERS);
  for (const [, label] of VAR_ORDER_OPTIONS) assert.ok(label && label.trim(), 'every option needs a label');
  // Each order must actually do something distinguishable, or the menu is lying.
  const seen = new Set(VAR_ORDERS.map((o) => names(sortVars(VARS, o)).join(',')));
  assert.equal(seen.size, VAR_ORDERS.length, 'two options produced the same order');
});

test('empty and single-variable lists are handled without special-casing', () => {
  for (const order of VAR_ORDERS) {
    assert.deepEqual(sortVars([], order), []);
    assert.deepEqual(names(sortVars([{ name: 'only' }], order)), ['only']);
  }
});

test('collate is case- and accent-insensitive and numeric', () => {
  assert.equal(collate('abc', 'ABC'), 0);
  assert.ok(collate('a', 'B') < 0);
  assert.ok(collate('q2', 'q10') < 0);
  assert.equal(collate(null, ''), 0);
});
