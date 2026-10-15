/**
 * @file picker-selected-only.test.mjs
 * Two refinements to the variable picker (TODO: "Variable-picker polish").
 *
 * **A live tick count.** The status line already said "12 of 900 variables" — how much of
 * the list the filter was showing — and never said how much was *chosen*. On a 900-variable
 * GSS extract that is the number the user actually wants, and it could not simply be added
 * to `render()`: ticking a box deliberately does NOT re-render, because reordering rows
 * under the cursor causes mis-clicks. So the count is repainted on its own.
 *
 * **A "Selected only" view.** The same list, restricted to what is ticked — for the case
 * where the ticks are scattered through hundreds of rows and checking your work means
 * scrolling the lot.
 *
 * The dialog is DOM and the suite runs `node --test` with no jsdom, so both behaviours are
 * lifted into pure functions and tested there — a rule about what the list contains is
 * worth more than an assertion that a line of source still exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visibleVars, pickerCountLabel, pickerEmptyLabel } from '../core/ui-service.js';

const META = [
  { name: 'age', label: 'Age in years' },
  { name: 'income', label: 'Household income' },
  { name: 'region', label: 'Region of residence' },
  { name: 'educ', label: 'Highest education' },
];
const names = (rows) => rows.map((m) => m.name);

// =============================================================================
// Selected only
// =============================================================================

test('off, the view is the filter alone', () => {
  assert.deepEqual(names(visibleVars(META, { query: '', selectedOnly: false })), names(META));
  assert.deepEqual(names(visibleVars(META, { query: 'reg', selectedOnly: false })), ['region']);
});

test('on, the view is what is ticked RIGHT NOW', () => {
  const ticked = new Set(['income', 'educ']);
  assert.deepEqual(names(visibleVars(META, { selectedOnly: true, ticked })), ['income', 'educ']);
  // The live set, not the one the dialog opened with: a box ticked during the dialog
  // belongs in this view, and one unticked does not.
  ticked.add('age');
  ticked.delete('educ');
  assert.deepEqual(names(visibleVars(META, { selectedOnly: true, ticked })), ['age', 'income']);
});

test('the two compose — a filter inside the selection, not instead of it', () => {
  const ticked = new Set(['income', 'region']);
  assert.deepEqual(names(visibleVars(META, { query: 'reg', selectedOnly: true, ticked })), ['region']);
  // A filter that matches an UNticked variable finds nothing here, which is the point:
  // the question being asked is "of the ones I picked".
  assert.deepEqual(names(visibleVars(META, { query: 'age', selectedOnly: true, ticked })), []);
});

test('on with nothing ticked is empty, not everything', () => {
  // The failure that would matter: treating an empty tick set as "no restriction" shows
  // the whole list under a ticked box, which reads as the toggle being broken.
  assert.deepEqual(visibleVars(META, { selectedOnly: true, ticked: new Set() }), []);
});

test('order is the list order, not tick order', () => {
  // Rows must not rearrange themselves by when they were ticked — the same rule that
  // keeps the "Selected" group from recomputing under the cursor.
  const ticked = new Set(['region', 'age']);
  assert.deepEqual(names(visibleVars(META, { selectedOnly: true, ticked })), ['age', 'region']);
});

// =============================================================================
// The status line
// =============================================================================

test('the count says how much is shown and how much is chosen', () => {
  assert.equal(pickerCountLabel({ shown: 4, total: 4, ticked: 0 }), '4 variables · 0 selected');
  assert.equal(pickerCountLabel({ shown: 1, total: 4, ticked: 2 }), '1 of 4 variables · 2 selected');
});

test('a single-select picker gets no tick count', () => {
  // "1 selected" beside a radio list states what the list already shows.
  assert.equal(pickerCountLabel({ shown: 4, total: 4, ticked: 1, multiple: false }), '4 variables');
});

test('one variable is not "1 variables"', () => {
  assert.equal(pickerCountLabel({ shown: 1, total: 1, ticked: 1 }), '1 variable · 1 selected');
});

test('an empty list says WHICH emptiness it is', () => {
  assert.equal(pickerEmptyLabel({ selectedOnly: false }), 'No variable matches that filter.');
  assert.match(pickerEmptyLabel({ selectedOnly: true, ticked: 3 }), /No selected variable/);
  // The one that would otherwise send someone hunting for a typo in a filter they never set.
  assert.match(pickerEmptyLabel({ selectedOnly: true, ticked: 0 }), /Nothing is selected yet/);
});

// =============================================================================
// Wiring the DOM half cannot test
// =============================================================================

const UI = readFileSync(new URL('../core/ui-service.js', import.meta.url), 'utf8');

test('the count is repainted on every tick, not only on render', () => {
  // The whole point of lifting it out: `render()` alone would leave the opening number
  // on screen for the life of the dialog, because ticking does not re-render.
  const handler = UI.slice(UI.indexOf("input.addEventListener('change'"), UI.indexOf('const shown = varDisplay'));
  assert.match(handler, /paintCount\(\)/, 'ticking a box must repaint the count');
});

test('the toggle is offered only where it could help', () => {
  // A control that cannot usefully change anything reads as broken — the rule the
  // cross-dataset scope switch already follows.
  assert.match(UI, /if \(multiple && meta\.length >= SELECTED_ONLY_MIN\)/,
    'single-select holds one tick; a short list is already on screen');
  assert.match(UI, /const SELECTED_ONLY_MIN = \d+;/);
});
