/**
 * @file float-selected.test.mjs
 * #180 — the selected variables float to the front of the list.
 *
 * The workflow: a homework question needs seven variables with unrelated names, the next needs
 * seven different ones, and clearing the first set means remembering each name and hunting it
 * in a 900-column grid — while the `7 selected` counter knows exactly which seven and will not
 * show them to you. The picker has floated them since #174a; this is the same partition for the
 * Data grid's columns and Variable View's rows.
 *
 * What is worth testing is not the partition (three lines) but the two rules copied from the
 * picker, because each exists to prevent a specific bad moment:
 *
 *  - **Nothing selected means no grouping at all** — not an empty group, not a stray separator.
 *    The feature has to be invisible until it is useful.
 *  - **The order inside each group is whatever `sortVars` decided.** Floating is a secondary
 *    key, not a re-sort; a user who chose "Label (A–Z)" still gets it, twice.
 *
 * The third rule — that the surfaces pass a SNAPSHOT rather than the live selection, so a row
 * cannot jump out from under the cursor mid-click — lives at the call sites, and shows up here
 * only as the fact that this function has no opinion about when it is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { floatSelected, sortVars } from '../core/var-order.js';

const metas = (...names) => names.map((name, i) => ({ name, label: `Label ${name}`, __i: i }));
const names = (r) => r.list.map((m) => m.name).join(' ');

test('selected variables come first, in their existing order', () => {
  const list = metas('age', 'sex', 'educ', 'income');
  const out = floatSelected(list, new Set(['educ', 'age']));
  // `age` before `educ` because that is the order they were already in — floating is a
  // secondary key, not a re-sort into selection order.
  assert.equal(names(out), 'age educ sex income');
  assert.equal(out.floated, 2);
});

test('nothing selected means the plain list and no boundary', () => {
  const list = metas('a', 'b', 'c');
  for (const sel of [new Set(), null, undefined, 'not a set']) {
    const out = floatSelected(list, sel);
    assert.equal(names(out), 'a b c', `changed the list for ${String(sel)}`);
    assert.equal(out.floated, 0, 'a separator with nothing above it would be noise');
    assert.equal(out.list, list, 'the same array, so a caller can skip re-rendering');
  }
});

test('everything selected also has no boundary to draw', () => {
  // A rule at one end of the list says nothing. Same for a selection of names that are not
  // in this list at all (a filter can hide a selected variable).
  const list = metas('a', 'b');
  assert.equal(floatSelected(list, new Set(['a', 'b'])).floated, 0);
  assert.equal(floatSelected(list, new Set(['zz'])).floated, 0);
  assert.equal(names(floatSelected(list, new Set(['zz']))), 'a b');
});

test('the boundary is the index of the first unselected variable', () => {
  const list = metas('a', 'b', 'c', 'd', 'e');
  const out = floatSelected(list, new Set(['b', 'd', 'e']));
  assert.equal(names(out), 'b d e a c');
  assert.equal(out.floated, 3);
  assert.equal(out.list[out.floated].name, 'a', 'the surfaces draw their rule at this one');
});

test('the chosen sort order still holds inside each group', () => {
  // A user who picked "Name (Z–A)" gets it twice: once among the floated, once among the rest.
  const list = sortVars(metas('age', 'sex', 'educ', 'income'), 'name-desc');
  assert.equal(list.map((m) => m.name).join(' '), 'sex income educ age');
  const out = floatSelected(list, new Set(['age', 'income']));
  assert.equal(names(out), 'income age sex educ');
});

test('no variable is ever added, lost or duplicated', () => {
  // The property that matters for a grid: a column that vanishes from the view is a column
  // the user cannot reach.
  const list = metas('a', 'b', 'c', 'd', 'e', 'f');
  for (const sel of [[], ['a'], ['f'], ['b', 'c'], ['a', 'f'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
    const out = floatSelected(list, new Set(sel));
    assert.equal(out.list.length, list.length, `count changed for ${sel}`);
    assert.deepEqual([...out.list].sort((x, y) => x.__i - y.__i), list, `set changed for ${sel}`);
  }
});

test('an empty or malformed list is handled rather than thrown on', () => {
  assert.deepEqual(floatSelected([], new Set(['a'])), { list: [], floated: 0 });
  assert.deepEqual(floatSelected(null, new Set(['a'])), { list: [], floated: 0 });
  // A meta with no name is not selected — it must not land in the floated group by accident.
  const out = floatSelected([{}, { name: 'a' }], new Set(['a']));
  assert.equal(out.floated, 1);
  assert.equal(out.list[0].name, 'a');
});
