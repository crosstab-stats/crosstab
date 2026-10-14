/**
 * @file howto-dialog-info.test.mjs
 * The ⓘ on an analysis dialog (#192) — the third entry point.
 *
 * The other two answer "what is this plugin?". This one answers "what do I put in this
 * box?", which is the moment someone is most likely to want an answer and least likely to
 * go hunting through a menu for it.
 *
 * Two rules, and the second is what makes it useful on day one:
 *
 *  - a menu ITEM may name its topic (`howto: 'frequencies-basics'`);
 *  - otherwise it falls back to the plugin's ENTRY PAGE — the same resolution the ⓘ beside
 *    a plugin row uses, so the two can never point at different pages for one plugin.
 *
 * Verified in the running app on all three dialog kinds and on both resolution paths; the
 * assertions here are the ones that can rot silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync('core/ui-service.js', 'utf8');
const actions = readFileSync('core/plugin-actions.js', 'utf8');
const app = readFileSync('core/app.js', 'utf8');
const freq = readFileSync('plugins/builtin-frequencies/index.js', 'utf8');

test('ALL THREE dialog kinds build their title through one helper', () => {
  // selectVariables, selectFromList and showForm each used to write their own <h2>. Three
  // copies of a title row is how two screens came to disagree about a button they both
  // rendered — see the plugin picker's ambient-deps bundle.
  assert.equal([...ui.matchAll(/dialogHead\(title, howto, this\.#onHowto\)/g)].length, 3);
  assert.match(ui, /function dialogHead\(title, howto, onHowto\)/);
});

test('every dialog kind accepts a topic', () => {
  assert.equal([...ui.matchAll(/howto = null/g)].length, 3);
});

test('the ⓘ only appears when there is BOTH a topic and a guide', () => {
  // A button that opens nothing is worse than no button: it reads as "no documentation".
  assert.match(ui, /if \(howto && onHowto\) \{/);
});

test('the guide is injected, not imported, so a dialog in a test needs no guide', () => {
  assert.match(ui, /constructor\(dataStore, \{ onHowto = null \} = \{\} \) \{|constructor\(dataStore, \{ onHowto = null \} = \{\}\) \{/);
  assert.match(app, /new UiService\(datasets, \{ onHowto:/);
});

test('every dialog gatherInputs opens carries the topic', () => {
  // Missing one would give a plugin's first dialog an ⓘ and its second none, which reads
  // as the help having run out rather than as a gap.
  const body = actions.slice(actions.indexOf('async function gatherInputs('));
  const calls = [...body.matchAll(/ui\.(selectVariables|selectFromList|showForm)\(\{/g)].length;
  const carried = [...body.matchAll(/ui\.(selectVariables|selectFromList|showForm)\(\{ howto,/g)].length;
  assert.ok(calls > 0, 'found the dialog calls');
  assert.equal(carried, calls, 'every one of them passes the topic');
});

test('an item names its topic, else the plugin’s entry page', () => {
  const fn = actions.slice(actions.indexOf('#howtoFor(manifest, item) {'), actions.indexOf('async #runVerb'));
  assert.match(fn, /item\?\.howto/, 'the item may name one');
  assert.match(fn, /this\.#howtoPage\?\.\(manifest\?\.id\)/, 'otherwise the plugin page');
});

test('the dialog ⓘ and the plugin-row ⓘ resolve through the SAME function', () => {
  // Two resolvers would let a plugin's dialog and its row point at different pages.
  assert.match(app, /services\.howto\.pageFor = \(pluginId\) => howtoLibrary\.pluginPage\(pluginId\)/);
  assert.match(app, /howtoPage: \(pluginId\) => services\.howto\?\.pageFor\?\.\(pluginId\)/);
});

test('every call site that gathers inputs resolves a topic', () => {
  const sites = [...actions.matchAll(/gatherInputs\(this\.#ui, specs, [^)]*\)/g)].map((m) => m[0]);
  assert.ok(sites.length >= 3, `found ${sites.length} call sites`);
  for (const site of sites) {
    assert.match(site, /this\.#howtoFor\(/, `a gathering site with no topic: ${site}`);
  }
});

test('builtin-frequencies is the reference: its item names its topic', () => {
  assert.match(freq, /howto: 'frequencies-basics'/);
});
