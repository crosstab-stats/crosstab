/**
 * @file show-all-variables.test.mjs
 * The role filter is a default, not a veto (#205).
 *
 * ## The owner's challenge, which was right
 *
 * A categorical input hid a Scale-measured numeric, so crosstabbing income was impossible
 * until you recoded it — and recoding changes nothing about the data, it just sets the
 * measure, so the variable "magically" appeared. Asked whether that was CrossTab's call to
 * make: *"I agree that a categorical analysis on income will have thousands of rows. But
 * my challenge is: is that so bad? Is it CrossTab's duty to tell the person they CAN'T get
 * that table?"*
 *
 * It is not. A thousand-row crosstab is BIG, not WRONG, and there are real reasons to ask
 * for one — finding the 999 in an age column, seeing a variable's distinct values, learning
 * how dirty a column is. Every tool this project chases is looser: SPSS treats measure as
 * advisory for most procedures, Stata ignores it, R has no concept of it.
 *
 * And the project had already settled the principle: *pre-select, never apply invisibly* —
 * a sensible default, pre-filled into each run's own control, opt-out-able per run, because
 * **the override is the win over SPSS, not the parity**. The role filter had been the
 * opposite of that since it was written: a judgement applied invisibly with no control to
 * override it.
 *
 * ## What this pins
 *
 * The default still filters — that is what makes the common case a glance-and-OK, and a
 * default that changed what every existing project's pickers offer would be a worse answer
 * than the problem. What changed is that it can be overridden, that the override is
 * REMEMBERED (owner: *"set it once when they start a project and run with it always"*), and
 * that a revealed row says why it was not offered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI = readFileSync('core/ui-service.js', 'utf8');

/** A localStorage stand-in — settings.js reads it at call time. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
  return map;
}

fakeStorage();
const varOrder = await import('../core/var-order.js');
const { listSettings, setSetting } = await import('../core/settings.js');

// ---------------------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------------------

test('the default is unchanged behaviour', () => {
  fakeStorage();
  assert.equal(varOrder.loadShowAllRoles(), 'fitting');
  assert.equal(varOrder.showAllRoles(), false);
});

test('it is remembered, and reachable from the Settings screen', () => {
  // The owner asked for a remembered setting "stored in the same place so it is exposed on
  // the unified settings screen" -- so it must be DECLARED, not a private localStorage key.
  fakeStorage();
  const spec = listSettings().find((s) => s.id === 'varlist.showAll');
  assert.ok(spec, 'declared in the registry');
  assert.equal(spec.group, 'Variables', 'beside the other two variable-list settings');
  assert.ok(spec.label, 'and labelled, which is what puts it on the screen at all');
  assert.deepEqual(spec.options.map((o) => o[0]), ['fitting', 'all']);
  // Editable there rather than routed: the picker reads it on open, so a change applies
  // to the next picker without needing a surface to re-render.
  assert.ok(!spec.editedAt, 'not routed elsewhere');
});

test('a write through the registry is what the picker then reads', () => {
  fakeStorage();
  assert.equal(setSetting('varlist.showAll', 'all'), true);
  assert.equal(varOrder.showAllRoles(), true);
  assert.equal(setSetting('varlist.showAll', 'nonsense'), false, 'and rubbish is refused');
  assert.equal(varOrder.showAllRoles(), true, 'leaving the stored choice alone');
});

test('a hand-edited or stale value degrades to the default', () => {
  // Same rule as every other setting here: a value outside the accepted set is treated as
  // absent rather than reaching the picker.
  fakeStorage({ 'crosstab.varlist.showall': 'everything' });
  assert.equal(varOrder.loadShowAllRoles(), 'fitting');
});

// ---------------------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------------------

test('the filter is applied only when the override is off', () => {
  // The whole change, in one line of the source: `types?.length && !all`.
  assert.match(UI, /return types\?\.length && !all \? raw\.filter\(\(m\) => fitsRole\(m, types\)\) : raw;/);
  assert.match(UI, /let showAll = showAllRoles\(\);/, 'seeded from the remembered setting');
});

test('the switch is offered only when it would reveal something', () => {
  // "A switch that could not change anything reads as broken" -- the rule the
  // dataset-scope switch states for itself, and the reason hiddenCount exists.
  assert.match(UI, /const hiddenCount = \(spanning\)/);
  assert.match(UI, /if \(types\?\.length && \(hiddenCount\(allDatasets\) > 0 \|\| showAll\)\)/);
  // `|| showAll` matters: with the override already on, nothing is hidden, and the switch
  // must still appear or there would be no way to turn it back off.
});

test('ticking it is a PER-RUN override and does not rewrite the setting', () => {
  // The weight-picker contract: a project-level choice is pre-filled and stays
  // opt-out-able for one run. The Settings screen is where the default changes.
  const at = UI.indexOf("txt.textContent = 'Show all variables'");
  const body = UI.slice(at, at + 1400);
  assert.match(body, /showAll = roleBox\.checked/);
  assert.ok(!/saveShowAllRoles|setSetting/.test(body), 'the handler writes no setting');
});

test('a variable ticked and then re-hidden is dropped, not silently kept', () => {
  // Turning the override back off must not leave a choice in the result that the list no
  // longer shows -- the same rule the scope switch follows.
  const at = UI.indexOf("txt.textContent = 'Show all variables'");
  const body = UI.slice(at, at + 1400);
  assert.match(body, /if \(!meta\.some\(\(m\) => m\.name === name\)\) ticked\.delete\(name\)/);
});

test('a revealed row says WHY it is not normally offered', () => {
  assert.match(UI, /className = 'ct-dialog__rolemiss'/);
  assert.match(UI, /roleMissReason\(m\)/);
  // Only on the rows that miss, and only while the override is on.
  assert.match(UI, /if \(showAll && types\?\.length && !fitsRole\(m, types\)\)/);
  // Muted rather than a warning colour: the row IS selectable, and this explains a
  // default rather than reporting a fault.
  const css = readFileSync('index.html', 'utf8');
  assert.match(css, /\.ct-dialog__rolemiss \{[^}]*--ct-muted/);
});

test('the reason names the MEASURE, which is the thing that decides it', () => {
  // "numeric" would be true of a nominal code too and would send someone looking in the
  // wrong place; the measure is both the cause and what Variable View can change.
  const at = UI.indexOf('function roleMissReason(');
  const body = UI.slice(at, UI.indexOf('\n}', at));
  for (const level of ['scale', 'nominal', 'ordinal']) {
    assert.ok(body.includes(`'${level}'`), `reports ${level}`);
  }
  assert.match(body, /measured Scale/);
  // No measure recorded: report the storage type rather than inventing a level.
  assert.match(body, /type \$\{m\?\.type \|\| 'unknown'\}/);
});

test('the role predicates themselves are untouched', () => {
  // #205 changes who gets OFFERED, not what fits. `fitsRole` stays additive-only -- the
  // constraint that exists because widening a numeric role to everything would offer race
  // codes as a weight, and because a fix that started REMOVING variables from lists would
  // break working projects to tidy a taxonomy.
  assert.match(UI, /ADDITIVE ONLY/);
  assert.match(UI, /if \(types\.includes\(m\.type\)\) return true;/);
});
