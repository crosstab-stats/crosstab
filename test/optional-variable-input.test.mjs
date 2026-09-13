/**
 * @file optional-variable-input.test.mjs
 * An optional variable role defaults to "none", and can be put back to it.
 *
 * The variable picker seeds itself from the Data view's selection, which is a
 * good default for the variables an analysis is ABOUT and a bad one for a
 * secondary role. Applied to an OPTIONAL input it inverted that input's own
 * default: Frequencies' weight picker opened with whatever happened to be ticked
 * in the grid already chosen, so a user who wanted no weight got one.
 *
 * And a single-select picker is radios, which cannot be un-chosen by clicking
 * them again — so once anything was picked there was no route back to empty.
 * Cancel was the only exit, and Cancel does not read as "no thanks", it reads as
 * "abandon the analysis".
 *
 * Both halves matter: an explicit "none" with nothing pre-chosen is what makes
 * an optional input actually optional. Pinned here against the source, since the
 * picker is DOM and this is about the contract between the two files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI = readFileSync(new URL('../core/ui-service.js', import.meta.url), 'utf8');
const ACTIONS = readFileSync(new URL('../core/plugin-actions.js', import.meta.url), 'utf8');

test('an optional role is not seeded from the Data view selection', () => {
  // The fallback has to be gated on `optional`, not applied to every picker.
  assert.match(
    UI,
    /preselect\s*\?\?\s*\(optional\s*\?\s*\[\]\s*:\s*this\.#store\.getSelectedVariables\(\)\)/,
    'an optional input must start empty, not from the grid selection',
  );
});

test('the picker is told which inputs are optional', () => {
  // The option is useless if the caller never passes it — which is exactly the
  // shape of the original bug, a capability that existed and was not wired.
  const call = ACTIONS.slice(ACTIONS.indexOf('ui.selectVariables({'), ACTIONS.indexOf('if (res === null)'));
  assert.match(call, /optional:\s*!!spec\.optional/, 'gatherInputs must pass the input\'s optionality through');
});

test('a single-select optional picker offers an explicit "none"', () => {
  assert.match(UI, /const noneRow = \(\)/, 'expected a none choice to exist');
  assert.match(UI, /if \(optional && !multiple\) list\.append\(noneRow\(\)\)/,
    'the none choice belongs on single-select optional pickers');
  // It clears the model, not just the radio — the result is read from the model.
  const body = UI.slice(UI.indexOf('const noneRow = ()'), UI.indexOf('const render = ()'));
  assert.match(body, /ticked\.clear\(\)/, 'choosing none must clear the selection it resolves from');
});

test('the "none" row survives a search that matches no variable', () => {
  // Hiding the way out while hunting for a name would be its own trap.
  const render = UI.slice(UI.indexOf('const render = ()'), UI.indexOf('search.addEventListener'));
  const nonePos = render.indexOf('noneRow()');
  const matchPos = render.indexOf('matching(');
  assert.ok(nonePos > -1, 'render should place the none row');
  assert.ok(nonePos < render.indexOf('list.append(groupLabel'), 'the none row comes first');
  assert.doesNotMatch(render.slice(nonePos, nonePos + 120), /matching\(/,
    'the none row must not be run through the filter');
  assert.ok(matchPos > -1);
});

test('picking a variable turns the "none" radio off, and vice versa', () => {
  // Both directions go through the model, so the two can never both look chosen.
  const sync = /el\.checked = el\.value === ''\s*\?\s*ticked\.size === 0\s*:\s*ticked\.has\(el\.value\)/g;
  const hits = UI.match(sync) || [];
  assert.ok(hits.length >= 2, `both the variable rows and the none row should resync (found ${hits.length})`);
});

test('cancelling an optional input still means "none", as it always did', () => {
  const at = ACTIONS.indexOf('if (res === null)');
  assert.ok(at > -1, 'expected the cancel branch');
  const branch = ACTIONS.slice(at, at + 220);
  assert.match(branch, /spec\.optional/);
  assert.match(branch, /spec\.multiple \? \[\] : null/);
});
