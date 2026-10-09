/**
 * @file var-display.test.mjs
 * Whether a variable shows its NAME or its LABEL — the other half of SPSS's
 * Edit ▸ Options ▸ Variable Lists, of which we had only built the order half.
 *
 * Reported twice, the second time with feeling: *"the data grid column headers not
 * showing the variable is becoming more annoying"*. The grid header rendered
 * `label || name`, so a labelled variable never showed its name on screen at all — the
 * name was in a `title`, which needs a pointer that can rest somewhere, so on a phone,
 * for a keyboard user and for a screen reader it was unreachable. That is this
 * project's standing rule: if hover or a keyboard is the only way to reach it, it is
 * not shipped.
 *
 * The asymmetry that made it a bug rather than a nicety: the toolbar already lets you
 * FIND by name (`filterVars` matches either) and SORT by name — and then the header
 * picked one for you.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  VAR_DISPLAYS, VAR_DISPLAY_OPTIONS, varDisplay, loadVarDisplay, saveVarDisplay,
} from '../core/var-order.js';

const GRID = await readFile(new URL('../core/data-views.js', import.meta.url), 'utf8');
const PICKER = await readFile(new URL('../core/ui-service.js', import.meta.url), 'utf8');
const BAR = await readFile(new URL('../core/var-toolbar.js', import.meta.url), 'utf8');

const LABELLED = { name: 'educ', label: 'Highest year of school completed' };

test('each mode shows what it says, and keeps the other for the tooltip', () => {
  assert.deepEqual(varDisplay(LABELLED, 'label'),
    { primary: 'Highest year of school completed', secondary: 'educ' });
  assert.deepEqual(varDisplay(LABELLED, 'name'),
    { primary: 'educ', secondary: 'Highest year of school completed' });
  assert.deepEqual(varDisplay(LABELLED, 'both'),
    { primary: 'Highest year of school completed', secondary: 'educ' });
  // Whichever is not on screen is always the secondary, so no surface can lose one.
  for (const mode of VAR_DISPLAYS) {
    const { primary, secondary } = varDisplay(LABELLED, mode);
    assert.deepEqual([primary, secondary].sort(), ['Highest year of school completed', 'educ'].sort(),
      `${mode} dropped one of the two`);
  }
});

test('an unlabelled variable shows its name under every mode', () => {
  // There is nothing else to show, and a blank header is worse than a redundant one.
  for (const mode of VAR_DISPLAYS) {
    assert.deepEqual(varDisplay({ name: 'v1' }, mode), { primary: 'v1', secondary: '' }, mode);
    assert.deepEqual(varDisplay({ name: 'v1', label: '' }, mode), { primary: 'v1', secondary: '' }, mode);
    assert.deepEqual(varDisplay({ name: 'v1', label: '   ' }, mode), { primary: 'v1', secondary: '' },
      `${mode}: a whitespace label is not a label`);
  }
  // A label identical to the name collapses too, so "both" does not print it twice.
  assert.deepEqual(varDisplay({ name: 'age', label: 'age' }, 'both'), { primary: 'age', secondary: '' });
});

test('junk in the metadata does not reach the header', () => {
  assert.deepEqual(varDisplay(undefined, 'label'), { primary: '', secondary: '' });
  assert.deepEqual(varDisplay({}, 'name'), { primary: '', secondary: '' });
  assert.equal(varDisplay(LABELLED, 'nonsense').primary, 'Highest year of school completed',
    'an unknown mode falls back to the old behaviour rather than rendering nothing');
});

test('the preference round-trips, and an unset one changes nothing', () => {
  const store = new Map();
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    assert.equal(loadVarDisplay(), 'label', 'the default is what every surface already did');
    saveVarDisplay('name');
    assert.equal(loadVarDisplay(), 'name');
    saveVarDisplay('not-a-mode');
    assert.equal(loadVarDisplay(), 'name', 'a bad value is refused, not stored');
    store.set('crosstab.varlist.display', 'garbage');
    assert.equal(loadVarDisplay(), 'label', 'and a corrupted one reads as the default');
  } finally {
    globalThis.localStorage = real;
  }
});

test('storage being unavailable is survivable, not fatal', () => {
  // Private mode and sandboxed frames throw on access; a preference is never worth an
  // exception on the way to drawing a grid.
  const real = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('denied'); },
  });
  try {
    assert.equal(loadVarDisplay(), 'label');
    assert.doesNotThrow(() => saveVarDisplay('name'));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real, writable: true });
  }
});

test('the control is offered once, in the shared strip', () => {
  // The same argument var-order.js makes: a preference only one surface honoured would
  // be worse than none, because you set it in one place and meet the old behaviour in
  // another with nothing on screen explaining why.
  assert.match(BAR, /VAR_DISPLAY_OPTIONS/);
  assert.match(BAR, /ct-vartools__display/);
  assert.deepEqual(VAR_DISPLAY_OPTIONS.map(([v]) => v), VAR_DISPLAYS);
  // Optional, because Variable View has Name and Label as separate columns and has
  // nothing to choose between — an inert control there would be worse than none.
  assert.match(BAR, /if \(display !== undefined && typeof onDisplay === 'function'\)/);
});

test('both one-name surfaces read it and write it back', () => {
  for (const [who, src] of [['the grid', GRID], ['the picker', PICKER]]) {
    assert.match(src, /loadVarDisplay\(\)/, `${who} should read the preference`);
    assert.match(src, /saveVarDisplay\(/, `${who} should persist a change`);
    assert.match(src, /varDisplay\(/, `${who} should use the shared resolver`);
  }
});

test('the grid keeps BOTH in the tooltip whichever is on screen', () => {
  // The fix is that the name stops being hover-only — not that the label takes its turn
  // at being unreachable.
  assert.match(GRID, /th\.title = \[m\.name, m\.label, m\.type, m\.measurementLevel\]/);
  assert.match(PICKER, /label\.title = \[m\.name, m\.label\]/);
});

test('"both" STACKS in a column header rather than sitting inline', () => {
  // The picker puts label and name side by side and has the width for it. Measured in
  // the grid at its 120px default column, inline clipped the label to about 20px while
  // the name held its own — which shows you neither. Stacked, the label got 84px and
  // the name was not clipped at all.
  assert.match(GRID, /colhead__stack/);
  assert.match(GRID, /stack\.append\(span, el\('code', shown\.secondary, 'colhead__name'\)\)/);
});
