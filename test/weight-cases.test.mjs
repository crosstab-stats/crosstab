/**
 * @file weight-cases.test.mjs
 * Set the frequency weight once, as SPSS's Data ▸ Weight Cases.
 *
 * Reported while comparing the two side by side (owner, 2026-10-09): *"SPSS lets you
 * set the weights once and every analysis uses it. CrossTab is making me set the
 * weights every run."* Twelve analyses across eight plugins take a weight, and each
 * one made the reader find it again in a list that is 900 variables long on real data.
 *
 * Three properties make a global weight safe rather than spooky, and they are what
 * this file pins:
 *
 *  1. **It pre-fills; it does not decide.** The picker still opens with the weight
 *     visible and ticked, so unticking it for one run costs a click.
 *  2. **What ran is what is recorded.** `gathered` is the object written into the log,
 *     so an analysis records the weight it actually used — changing the dataset's
 *     weight afterwards cannot reach back and alter what an old result claims.
 *  3. **It is never invisible.** A setting that silently changes the N and the degrees
 *     of freedom of every analysis is the one piece of state that has to be on screen
 *     all the time, which is why SPSS puts "Weight On" in its status bar.
 *
 * Verified in the browser end to end: the op lands in the log, the indicator reads
 * "⚖ Weighted by age", the real picker opens with `age` already ticked, and the
 * recorded analysis carries the weight explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const STORE = await readFile(new URL('../core/data-store.js', import.meta.url), 'utf8');
const ACTIONS = await readFile(new URL('../core/plugin-actions.js', import.meta.url), 'utf8');
const APP = await readFile(new URL('../core/app.js', import.meta.url), 'utf8');

test('the weight is an OP, so it is part of the project rather than a mood', () => {
  // A field would not survive a reopen, would not merge between peers, and could not be
  // undone — every other change to a dataset is an op and this is no different.
  assert.match(STORE, /#appendGuarded\('setWeight', \{ name: next \}, 'weight'\)/);
  assert.match(STORE, /op\.type === 'setWeight'/, 'and it is folded back out of the log');
  // One weight per dataset, so two peers setting it are editing the same thing.
  assert.match(STORE, /case 'setWeight':/);
  assert.match(STORE, /return 'weight';/);
});

test('a weight naming a column that is gone is no weight at all', () => {
  // Dropping or renaming the column must not leave every analysis pre-filled with
  // something unresolvable — the fold clears it rather than carrying a dangling name.
  assert.match(STORE, /weightVar && byName\.has\(weightVar\) \? weightVar : null/);
  assert.match(STORE, /setWeight: unknown variable/, 'and it cannot be set to one either');
});

test('setting the same weight twice is not an op', () => {
  // Otherwise opening the dialog and pressing OK grows the log and dirties the project
  // for a change that did not happen.
  assert.match(STORE, /if \(next === this\.weightVar\) return;/);
});

test('the picker is PRE-FILLED, not bypassed', () => {
  const branch = ACTIONS.slice(ACTIONS.indexOf("if (kind === 'variables')"), ACTIONS.indexOf("} else if (kind === 'number'"));
  assert.match(branch, /preselect: dsWeight \? \[dsWeight\] : undefined/);
  // Still the ordinary picker: same title, same list, same optional handling. The only
  // difference is which box starts ticked.
  assert.match(branch, /optional: !!spec\.optional/);
  assert.ok(!/skip|bypass/i.test(branch), 'nothing may shortcut the dialog');
});

test('a weight input is recognised by role, with the existing convention honoured', () => {
  // `role: 'weight'` is the explicit marker. `name === 'weight'` is what all twelve
  // built-ins already use, so none of them needed editing and a third-party plugin
  // written the same way gets it too.
  assert.match(ACTIONS, /spec\.role === 'weight' \|\| spec\.name === 'weight'/);
  // Only for a single-select: a multi-select weight is not a thing, and pre-ticking one
  // entry of a multi list would be a different and wronger claim.
  assert.match(ACTIONS, /wantsWeight && !spec\.multiple/);
});

test('an active weight is on screen whenever it is on', () => {
  assert.match(APP, /function wireWeightIndicator/);
  assert.match(APP, /Weighted by \$\{w\}/);
  assert.match(APP, /wireWeightIndicator\(mounts\.status, datasets, bus\)/);
  // Repainted on any data change, which is also how it clears when the column goes.
  assert.match(APP, /bus\.on\(CoreEvents\.DATA_CHANGED, paint\)/);
});

test('cancelling the Weight cases dialog is not the same as clearing the weight', () => {
  // Two different answers, and an optional picker is what distinguishes them: `null` is
  // "leave it alone", an empty selection is "weight by nothing".
  const cmd = APP.slice(APP.indexOf("id: 'core:weight-cases'"), APP.indexOf("id: 'core:run-r-script'"));
  assert.match(cmd, /if \(picked === null\) return;/);
  assert.match(cmd, /ds\.setWeight\(picked\[0\] \?\? null\)/);
  assert.match(cmd, /optional: true/);
  // And it names the missing step rather than opening an empty dialog.
  assert.match(cmd, /open or start a project first/);
});
