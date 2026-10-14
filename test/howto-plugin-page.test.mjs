/**
 * @file howto-plugin-page.test.mjs
 * Every plugin has a page, and the ⓘ beside it leads there (#192).
 *
 * Reported by the owner: clicking ⓘ on Frequencies "does not pull up the howto page, it
 * still falls through to the old placeholder". Two separate faults, and only one was a bug:
 *
 *  - the hook was assigned where `plugins` was still undefined, so it was never set;
 *  - and even wired, the old About dialog repeated the plugin's one-line `howto`, which
 *    the legacy bridge ALSO publishes as a topic — a plugin documented twice in two
 *    renderings, which is what this system exists to stop.
 *
 * So the dialog is gone and ⓘ opens the plugin's page. These pin the three cases that
 * page has to cover, because they are easy to get right one at a time and wrong together:
 * a plugin that authored topics, one with only the legacy note, and one with nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHowtoLibrary } from '../core/howto-library.js';

const lib = (entries) => createHowtoLibrary({
  catalogue: () => entries,
  readFile: async () => ({ kind: 'text', value: '--- id: first\nFirst body.\n--- id: second\nSecond body.\n' }),
});

const AUTHORED = {
  id: 'p-authored',
  name: 'Authored',
  enabled: true,
  menu: ['Frequencies…', 'Crosstabs…'],
  howtoFile: 'howto.md',
  // Deliberately NOT in alphabetical order: "Second" sorts before "The first one".
  howtoIndex: [
    { id: 'first', title: 'The first one', category: 'Stats' },
    { id: 'second', title: 'Second', category: 'Stats' },
  ],
};
const LEGACY = { id: 'p-legacy', name: 'Legacy', enabled: true, menu: ['Thing…'], howto: 'Pick it from Analyze.' };
const SILENT = { id: 'p-silent', name: 'Infrastructure', enabled: true, menu: [] };

test('the entry page is the topic the AUTHOR listed first, not the one that sorts first', () => {
  // Frequencies' ⓘ landed on "Add a mode, median or variance" because it sorts before
  // "Make a frequency table". Declaration order is intent: "start here" is the author's
  // call, and alphabetically-first is nobody's.
  const l = lib([AUTHORED]);
  assert.equal(l.pluginPage('p-authored'), 'first');
  const sorted = l.topics().map((t) => t.id);
  assert.deepEqual(sorted, ['second', 'first'], 'the READER still gets them sorted');
});

test('a plugin with only the legacy one-line note gets a listed page', async () => {
  const l = lib([LEGACY]);
  const page = l.pluginPage('p-legacy');
  assert.equal(page, 'plugin-p-legacy');
  const body = await l.body(page);
  assert.equal(body.md, 'Pick it from Analyze.');
  assert.equal(body.error, undefined);
  assert.deepEqual(l.topics().filter((t) => !t.hidden).map((t) => t.id), ['plugin-p-legacy']);
});

test('a plugin that documents NOTHING still has a page — hidden, and not an error', () => {
  // The ⓘ has to lead somewhere, but an infrastructure plugin must not pad the index with
  // a row that teaches nobody anything.
  const l = lib([SILENT]);
  assert.equal(l.pluginPage('p-silent'), 'plugin-p-silent');
  assert.deepEqual(l.topics().filter((t) => !t.hidden), []);
});

test('an empty synthesised page reports no body, NOT a missing file', async () => {
  // "ships no how-to file" would be true of a file it was never supposed to have. The
  // view says what an empty page means instead.
  const body = await lib([SILENT]).body('plugin-p-silent');
  assert.equal(body.error, undefined);
  assert.equal(String(body.md ?? '').trim(), '');
});

test('the menu list belongs to the ENTRY page only', () => {
  // Otherwise "Adds 2 items to the menus" repeats on every topic the plugin ships.
  const l = lib([AUTHORED]);
  assert.equal(l.isEntryPage(l.topicById('first')), true);
  assert.equal(l.isEntryPage(l.topicById('second')), false);
  assert.deepEqual(l.menuAdds('p-authored'), ['Frequencies…', 'Crosstabs…']);
});

test('one rule decides what an entry contributes', async () => {
  // A row filter in the library that duplicated a slice of collectTopics' logic is what
  // left a documentation-less plugin with no page at all, twice in a row — first by
  // excluding legacy entries, then by excluding silent ones.
  const l = lib([AUTHORED, LEGACY, SILENT]);
  assert.deepEqual(l.topics().map((t) => t.id).sort(),
    ['first', 'plugin-p-legacy', 'plugin-p-silent', 'second']);
  for (const id of ['p-authored', 'p-legacy', 'p-silent']) {
    assert.ok(l.pluginPage(id), `${id} has a page`);
  }
});

// --- the wiring ------------------------------------------------------------------

const app = readFileSync('core/app.js', 'utf8');
const picker = readFileSync('core/plugin-picker.js', 'utf8');
const manager = readFileSync('core/plugin-manager.js', 'utf8');

test('the ⓘ hook is assigned where `plugins` actually exists', () => {
  // The original bug: assigned at a point where `plugins` was declared but not yet
  // constructed, so `if (plugins)` was false and the button silently did nothing. No unit
  // test could see it; the app said so immediately.
  const decl = app.indexOf('  let plugins;');
  const ctor = app.indexOf('plugins = new PluginManager({');
  const hook = app.indexOf('plugins.onHowto =');
  assert.ok(decl !== -1 && ctor !== -1 && hook !== -1);
  assert.ok(hook > ctor, 'the hook must come after the constructor, not merely after the declaration');
});

test('EVERY picker that renders ⓘ is given the hook', () => {
  // The picker calls `this.#onHowto?.(id)`, so a picker constructed without it has a
  // button that silently does nothing — which is how the launcher shipped: the plugin
  // manager was wired and the launcher was not. The optional call is what hid it, the
  // same reflex that hid a missing delegation in the History panel a day earlier.
  const launcher = readFileSync('core/launcher.js', 'utf8');
  const constructions = [...picker.matchAll(/new PluginPicker\(\{/g)].length
    + [...launcher.matchAll(/new PluginPicker\(\{/g)].length;
  const wired = [...picker.matchAll(/onHowto/g)].length > 0 && /onHowto: this\.#onHowto/.test(launcher);
  assert.ok(constructions >= 2, 'both pickers accounted for');
  assert.ok(wired, 'the launcher forwards its hook');
  assert.match(app, /onHowto: \(pluginId\) => services\.howto\.openPlugin\(pluginId\)/);
});

test('ⓘ opens the plugin page, and the About dialog is gone', () => {
  assert.match(picker, /if \(act === 'about'\) \{[\s\S]*this\.#onHowto\?\.\(p\?\.id\)/);
  assert.doesNotMatch(picker, /openPluginAbout/);
  assert.doesNotMatch(manager, /export function openPluginAbout/);
});
