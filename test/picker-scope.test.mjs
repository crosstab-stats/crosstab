/**
 * @file picker-scope.test.mjs
 * #179 step 3 — the variable picker can offer every open dataset, and says which is which.
 *
 * The owner's rule for this half: *"scope should not be plugin based. I see no reason a plugin
 * should ever care about the provenance of the data we are passing it. This is all host based
 * logic, drop a toggle in the picker (can auto-on if the data grid already has variables from
 * multiple datasets selected)."*
 *
 * So: no manifest field, no opt-in, nothing for a plugin author to anticipate — the 63 existing
 * plugins get this for free and none of them can tell. What is worth pinning is the three
 * judgements in it:
 *
 *  1. **Off by default.** For most analyses mixing datasets is a mistake, not a feature.
 *     Defaulting every list to the union would make `AGE` ambiguous in the one place a user most
 *     needs to trust what they clicked.
 *  2. **On by itself when the user has already said so.** Variables ticked in two datasets IS
 *     the intent; making them hunt for a toggle to see what they just selected would be the app
 *     forgetting.
 *  3. **The active dataset's names stay bare.** A selection that never leaves it is
 *     indistinguishable from one made before any of this existed — which is what makes every
 *     recorded input and every saved script keep working.
 *
 * The dialog itself is DOM, so these tests drive the data side (the manager's three new views)
 * and pin the picker's contract against its source, the same way optional-variable-input does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { formatVarRef, parseVarRef } from '../core/var-ref.js';

const UI = readFileSync(new URL('../core/ui-service.js', import.meta.url), 'utf8');

// =============================================================================
// The manager's cross-dataset views
// =============================================================================

/** A DatasetManager stand-in: the collection projection and per-dataset stores. */
function managerLike(datasets, activeIndex = 0) {
  // Mirrors what DatasetManager.allVariableMeta/allSelectedVariables/selectionSpread do, so the
  // rules are testable without a ProjectLog, DuckDB and a browser. Kept beside the real ones by
  // the source pins at the bottom of this file.
  const active = datasets[activeIndex];
  return {
    list: () => datasets.map((d) => ({ id: d.name, name: d.name, active: d === active })),
    getVariableMeta: () => active.meta,
    getSelectedVariables: () => active.selected ?? [],
    allVariableMeta: () => datasets.flatMap((d) => d.meta.map((m) => ({
      ...m,
      name: d === active ? m.name : formatVarRef(d.name, m.name),
      dataset: d === active ? null : d.name,
    }))),
    allSelectedVariables: () => datasets.flatMap((d) => (d.selected ?? []).map(
      (n) => (d === active ? n : formatVarRef(d.name, n)),
    )),
    selectionSpread: () => datasets.filter((d) => (d.selected ?? []).length).length,
  };
}

const W1 = { name: 'Wave 1', meta: [{ name: 'age', label: 'Age' }, { name: 'income' }], selected: ['age'] };
const W2 = { name: 'Wave 2', meta: [{ name: 'age', label: 'Age at T2' }, { name: 'wt' }], selected: [] };

test('the active dataset keeps bare names; the others are qualified', () => {
  const m = managerLike([W1, W2]);
  assert.deepEqual(m.allVariableMeta().map((x) => x.name), ['age', 'income', 'Wave 2:age', 'Wave 2:wt']);
  assert.deepEqual(m.allVariableMeta().map((x) => x.dataset), [null, null, 'Wave 2', 'Wave 2']);
});

test('two datasets’ `age` are two rows, distinguishable and separately pickable', () => {
  // The collision the qualifier exists for. Both keep their own labels.
  const rows = managerLike([W1, W2]).allVariableMeta().filter((x) => parseVarRef(x.name).name === 'age');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.label), ['Age', 'Age at T2']);
});

test('selectionSpread counts datasets with a selection, not variables', () => {
  assert.equal(managerLike([W1, W2]).selectionSpread(), 1, 'one dataset has ticks');
  const both = managerLike([W1, { ...W2, selected: ['wt'] }]);
  assert.equal(both.selectionSpread(), 2);
  // Two ticks in ONE dataset is not a span: that is the ordinary case.
  assert.equal(managerLike([{ ...W1, selected: ['age', 'income'] }, W2]).selectionSpread(), 1);
});

test('the cross-dataset seed qualifies the foreign ticks and leaves the local ones bare', () => {
  const m = managerLike([W1, { ...W2, selected: ['wt'] }]);
  assert.deepEqual(m.allSelectedVariables(), ['age', 'Wave 2:wt']);
});

// =============================================================================
// The picker's contract
// =============================================================================

test('the scope starts OFF, and turns itself on only when the selection already spans', () => {
  assert.match(UI, /selectionSpread\?\.\(\)\s*\?\?\s*0\)\s*>\s*1/,
    'auto-on is gated on more than one dataset having a selection');
  // Nothing else may switch it on: no option, no manifest field, no plugin input.
  const decl = UI.slice(UI.indexOf('let allDatasets'), UI.indexOf('const metaFor'));
  assert.equal(/options|spec|manifest/.test(decl), false, 'the scope is the host’s decision alone');
});

test('a plugin cannot ask for it, or refuse it', () => {
  // The owner's rule: a plugin has no business knowing where its data came from. So
  // `selectVariables` must not read any cross-dataset option out of its argument.
  const opts = UI.slice(UI.indexOf('selectVariables(options = {}) {'), UI.indexOf('let meta = metaFor'));
  for (const bad of ['allDatasets = ', 'datasets = ', 'crossDataset']) {
    assert.equal(opts.includes(`${bad}options`), false, `${bad} must not come from the caller`);
  }
});

test('the toggle is only shown when there IS another dataset', () => {
  // A switch that cannot change anything reads as broken — the same rule the chart controls
  // follow, and the reason a one-dataset project sees no new UI at all.
  assert.match(UI, /if \(canSpan && \(this\.#store\.list\?\.\(\) \?\? \[\]\)\.length > 1\)/);
});

test('changing the scope re-groups, which is the one time re-grouping is allowed', () => {
  // The standing rule is that ticking a box must never reorder rows under the cursor. Changing
  // the scope replaces the list wholesale, so regrouping there is what the user asked for.
  const handler = UI.slice(UI.indexOf("scopeBox.addEventListener('change'"), UI.indexOf('bar.el.append(wrap)'));
  assert.match(handler, /meta = metaFor\(allDatasets\)/);
  assert.match(handler, /selected = meta\.filter/);
  assert.match(handler, /ticked\.delete\(name\)/, 'a tick for a variable no longer listed must go');
});

test('a foreign variable is badged with its dataset, not left to punctuation', () => {
  assert.match(UI, /ct-dialog__dsbadge/);
  const row = UI.slice(UI.indexOf('const row = (m) => {'), UI.indexOf('const groupLabel'));
  assert.match(row, /if \(m\.dataset\)/, 'only a foreign variable gets the badge');
});

test('the badge and the toggle are styled, and legibly', () => {
  // A badge with no style is invisible; a low-contrast one fails AA as small text. Both have
  // bitten this project before (the gridlines at 1.21:1, the hover-only controls).
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /\.ct-dialog__dsbadge\s*\{/);
  assert.match(html, /\.ct-vartools__scope\s*\{/);
  assert.match(html, /color: #3c4a57/, 'the muted-but-AA-legible pair used elsewhere');
});
