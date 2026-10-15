/**
 * @file script-export-menu.test.mjs
 * The analysis script is reachable from the File menu (#176's loose end).
 *
 * The chooser existed for weeks on the History panel's toolbar, which made it the one
 * place to find it. Someone wanting to hand their data steps to a Stata colleague opens
 * **File**, reads "Export data…", finds a list of data formats, and concludes the app
 * cannot do it — so the capability was present and unfindable.
 *
 * Two properties are worth holding still. The item must not be a format inside the
 * data picker (that picker lists DATA formats, and a script is not a dataset), and the
 * method behind it must work with the panel never opened — it is a File menu item, and
 * requiring a visit to History first would defeat the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_HOWTO } from '../core/howto-core.js';

const app = readFileSync('core/app.js', 'utf8');
const views = readFileSync('core/data-views.js', 'utf8');

test('File carries an Export analysis script item, next to Export data', () => {
  const at = app.indexOf("id: 'core:script-export'");
  assert.ok(at > 0, 'the File item is gone');
  const block = app.slice(at, at + 400);
  assert.match(block, /path: \['File'\]/);
  assert.match(block, /label: 'Export analysis script…'/);
  assert.match(block, /historyPanel\.exportScript\(\)/);
  // It belongs to File's 30-33 in/out block rather than to the project items at the top.
  // The exact position within that block is file-menu-order.test.mjs's business — pinning
  // the number here too meant one reshuffle broke two tests for one reason.
  const order = Number(block.match(/order: (\d+)/)[1]);
  assert.ok(order >= 30 && order <= 33, `order ${order} is outside the in/out block`);
});

test('the chooser is public, and the panel still uses the same one', () => {
  // Not a copy for the menu: a second chooser is a second list of formats to keep in step.
  assert.match(views, /^  exportScript\(\) \{/m, 'exportScript must be public for the menu');
  assert.equal(views.match(/exportScript\(\)/g).length, 2, 'the definition and the panel button — no second chooser');
  assert.match(views, /exportBtn\.addEventListener\('click', \(\) => this\.exportScript\(\)\)/);
});

test('the script is NOT offered as a format in the data picker', () => {
  // [[unified-import-export-picker]]: that picker lists data formats, and adding a
  // script to it would make "Export data…" mean two different kinds of thing.
  const svc = readFileSync('core/export-service.js', 'utf8');
  assert.doesNotMatch(svc, /ctscript/i);
});

test('the chooser does not need the panel to have been opened', () => {
  // `#currentScript` prefers an unsaved editor draft and otherwise serialises the applied
  // steps. The second branch is the one the File menu takes, and if it ever started
  // depending on `#ta` the menu item would throw on a fresh session.
  const at = views.indexOf('#currentScript() {');
  const body = views.slice(at).split('\n').slice(0, 4).join('\n');
  assert.match(body, /if \(this\.#dirty && this\.#ta\)/,
    'the draft branch must be guarded on the textarea existing');
  assert.match(body, /return \{ text: this\.#scriptText\(\), draft: false \}/);
});

test('the Syntax guide now says the script can be saved and opened', () => {
  // The guide is a view of the Syntax category, so a topic filed anywhere else would
  // not appear in it — which is how the gap arose in the first place.
  const topic = CORE_HOWTO.howtoIndex.find((t) => t.id === 'syntax-save-load');
  assert.ok(topic, 'no syntax-save-load topic');
  assert.equal(topic.category, 'Syntax');
  const body = readFileSync('docs/howto-core.md', 'utf8')
    .split(/^--- id: syntax-save-load$/m)[1];
  for (const dialect of ['.ctscript', '.do', '.sps', '.R']) {
    assert.ok(body.includes(dialect), `the page must name ${dialect}`);
  }
  assert.match(body, /File ▸ Export analysis script…/, 'the page must name the menu route');
  assert.match(body, /draft/, 'an import arrives as a draft — the page must say so');
});
