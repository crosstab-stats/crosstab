/**
 * @file project-settings.test.mjs
 * Project-scoped settings on the Settings screen, written as OPS (#207).
 *
 * ## The question this answers
 *
 * The owner looked for the frequency weight on the Settings screen, did not find it, and
 * then asked for the right thing rather than the obvious one: *"Could we design the
 * project-level settings (such as weights) as viewable/settable in the settings screen,
 * but have a change there emit an op in the project log just like it would if set
 * elsewhere?"*
 *
 * Which dissolves the tension instead of trading one side away. The weight genuinely is
 * not a device preference — `core/data-store.js` calls it *"a property of the DATASET …
 * folded from the log like everything else"* — and that is load-bearing: because setting
 * it is an op it is undoable, appears in History, exports in the analysis script and
 * merges to collaborators. A `localStorage` key would have none of those, and the scope is
 * per-DATASET, so one stored value would be wrong even inside one project.
 *
 * So the screen does not own the setting; it is a second DOORWAY to the one path. A
 * descriptor's `set` calls the same `DataStore#setWeight` the Data menu calls, and the op,
 * the History row, the undo entry and the merge happen because they always did.
 *
 * ## What is asserted
 *
 * Mostly that this file did not accidentally become a second implementation: the
 * eligibility rule is the picker's, the write is the dataset's own method, and the screen
 * renders descriptors without knowing what a weight is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { projectSettings } = await import('../core/project-settings.js');

const SCREEN = readFileSync('core/settings-screen.js', 'utf8');
const MODULE = readFileSync('core/project-settings.js', 'utf8');

/**
 * Source with comments stripped, for every assertion about something being ABSENT.
 *
 * Both absence checks below failed on their own explanations the first time:
 * `project-settings.js` says "a localStorage key would have none of those" while
 * asserting it writes no localStorage, and `settings-screen.js` says "never learns what a
 * weight is" while asserting it never says "weight". That is the SIXTH time in this
 * session that a correct comment broke a guard written against raw source — so the rule
 * is now a helper rather than a lesson: an absence assertion reads CODE.
 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SCREEN_CODE = codeOf(SCREEN);
const MODULE_CODE = codeOf(MODULE);

/** A dataset stand-in. `calls` records what reached the real method. */
function fakeDataset(over = {}) {
  const calls = [];
  return {
    calls,
    name: 'GSS',
    weightVar: null,
    getVariableMeta: () => [
      { name: 'wtssall', type: 'numeric', measurementLevel: 'scale', label: 'Post-strat weight' },
      { name: 'race', type: 'numeric', measurementLevel: 'nominal' },
      { name: 'sex', type: 'factor' },
      { name: 'age', type: 'numeric' },
    ],
    setWeight: async (n) => { calls.push(n); },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------

test('no dataset means no rows, not rows that cannot act', () => {
  // An empty list and a list of dead controls are different states; the screen renders
  // its own "nothing open" line from the empty one.
  assert.deepEqual(projectSettings({ active: null }), []);
  assert.deepEqual(projectSettings(null), []);
  assert.deepEqual(projectSettings(undefined), []);
});

test('the row names the DATASET it applies to', () => {
  // A weight is per-dataset. A row saying only "Frequency weight" would claim a
  // project-wide scope it does not have, and two datasets in one project routinely want
  // different weights.
  const [w] = projectSettings({ active: fakeDataset() });
  assert.match(w.scope, /dataset/);
  assert.match(w.scope, /GSS/);
});

// ---------------------------------------------------------------------------------------
// Eligibility — the picker's rule, not a second one
// ---------------------------------------------------------------------------------------

test('only quantitative variables are offered, and "No weight" comes first', () => {
  const [w] = projectSettings({ active: fakeDataset() });
  const names = w.options.map(([v]) => v);
  assert.equal(names[0], '', 'turning a weight off must not mean hunting for a blank row');
  assert.deepEqual(names.slice(1), ['wtssall', 'age']);
  // A nominal code and a factor are refused: offering race as a weight is the failure
  // #188's widening was careful to avoid.
  assert.ok(!names.includes('race'));
  assert.ok(!names.includes('sex'));
});

test('eligibility comes from the shared predicate, not a local copy', () => {
  // Two definitions of "can this be a weight" is how a screen comes to offer a variable
  // the picker refuses. The Data menu asks for types: ['numeric'], whose role admits a
  // Scale-measured variable the importer happened to type `factor` (#188).
  assert.match(MODULE, /import \{ isQuantitative \} from '\.\/var-role\.js'/);
  assert.ok(!/measurementLevel === 'scale'/.test(MODULE), 'the rule is not re-derived here');
});

test('a label is shown beside the name, as in every other variable list', () => {
  const [w] = projectSettings({ active: fakeDataset() });
  assert.deepEqual(w.options.find(([v]) => v === 'wtssall'), ['wtssall', 'wtssall — Post-strat weight']);
  assert.deepEqual(w.options.find(([v]) => v === 'age'), ['age', 'age'], 'no label, no dash');
});

// ---------------------------------------------------------------------------------------
// Writing — the same path the menu uses
// ---------------------------------------------------------------------------------------

test('a change calls the dataset\'s own setWeight, which is what makes it an op', () => {
  const ds = fakeDataset();
  const [w] = projectSettings({ active: ds });
  return Promise.resolve()
    .then(() => w.set('wtssall'))
    .then(() => w.set(''))
    .then(() => {
      // '' is "no weight" and must arrive as null — the stored ABSENCE, which is a real
      // answer and distinct from a missing one.
      assert.deepEqual(ds.calls, ['wtssall', null]);
    });
});

test('nothing here writes the device registry', () => {
  // The whole point: a project setting must not become a browser preference, or it would
  // stop being undoable, exportable and mergeable.
  assert.ok(!/setSetting|localStorage|defineSetting/.test(MODULE_CODE));
});

test('a weight already set but no longer eligible is kept and marked', () => {
  // Its measure may have changed under it. Dropping it from its own control would leave a
  // weight in force that the screen denies exists.
  const [w] = projectSettings({ active: fakeDataset({ weightVar: 'race' }) });
  assert.equal(w.value, 'race');
  assert.equal(w.stale, true);
  const [ok] = projectSettings({ active: fakeDataset({ weightVar: 'wtssall' }) });
  assert.equal(ok.stale, false);
});

// ---------------------------------------------------------------------------------------
// The screen renders descriptors, and knows nothing about weights
// ---------------------------------------------------------------------------------------

test('the screen never learns what a weight is', () => {
  // It is handed a provider. If this file ever mentions a weight, the separation has gone
  // and the next project setting will need a dialog change rather than a descriptor.
  assert.ok(!/weight/i.test(SCREEN_CODE), 'settings-screen.js code must not mention weights');
  assert.match(SCREEN, /projectSettings = null/, 'the provider is injected');
  assert.match(SCREEN, /const rows = projectSettings\(\) \|\| \[\]/, 'and read at render time');
});

test('the project group is LAST and visibly a different scope', () => {
  // Last because it is the section that is not always there -- a screen whose first
  // section vanishes depending on what is open reads as broken.
  const deviceAt = SCREEN.indexOf('for (const { group, items } of settingsGroups())');
  const projectAt = SCREEN.indexOf("text: 'This project'");
  assert.ok(deviceAt > 0 && projectAt > deviceAt);
  const css = readFileSync('index.html', 'utf8');
  assert.match(css, /\.ct-settings__group--project \{[^}]*border-top/,
    'a different scope needs a visible break, not just a heading');
});

test('a refused write puts the control back and says why', () => {
  // setWeight throws on an unknown variable. Leaving the select showing a value the
  // project never accepted would be the screen lying about what is in force.
  const at = SCREEN.indexOf('sel.addEventListener(\'change\', async () => {');
  const body = SCREEN.slice(at, SCREEN.indexOf('control.append(sel, err)', at));
  assert.match(body, /catch/);
  assert.match(body, /sel\.value = String\(p\.value \?\? ''\)/, 'reverted');
  assert.match(body, /err\.textContent = e\?\.message/, 'and explained');
  // And a SUCCESSFUL write re-reads rather than trusting what was sent.
  assert.match(body, /await p\.set\(chosen\);[\s\S]*render\(\);/);
});

test('an empty project shows a sentence, not an empty section', () => {
  assert.match(SCREEN, /No dataset is open, so there is nothing project-specific to set yet/);
});
