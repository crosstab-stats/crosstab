/**
 * @file howto-plugin-page.test.mjs
 * Every plugin has a page, the ⓘ beside it leads there, and both surfaces share the
 * wiring that makes that true (#192).
 *
 * Reported by the owner: clicking ⓘ on Frequencies "does not pull up the howto page, it
 * still falls through to the old placeholder" — and then, after that was fixed, the same
 * button on the LAUNCHER did nothing. Their follow-up is the question that produced the
 * last group of tests here: *"I thought we unified the plugin manager and launcher to use
 * the same machinery specifically to avoid this kind of drift."*
 *
 * They had. #177 unified the RENDERING — one `PluginPicker`, one `addsTooltip`, one About
 * dialog — and it worked exactly as intended: deleting that dialog fixed both screens at
 * once with no second edit. What stayed duplicated was the WIRING. Each site assembled its
 * own options object, so the picker's arguments split into two kinds that looked alike:
 * ambient (`plugins`, `onHowto` — identical everywhere) and per-site (`mode`, `selected`,
 * `headLead` — genuinely different). Passing the ambient kind per site means every new one
 * must be remembered N times, and N had quietly become 2.
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
  assert.deepEqual(l.topics().map((t) => t.id), ['second', 'first'], 'the READER still gets them sorted');
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

// --- the wiring both surfaces share ----------------------------------------------

const app = readFileSync('core/app.js', 'utf8');
const picker = readFileSync('core/plugin-picker.js', 'utf8');
const manager = readFileSync('core/plugin-manager.js', 'utf8');
const launcher = readFileSync('core/launcher.js', 'utf8');

test('the ambient deps a picker needs are defined ONCE', () => {
  assert.equal([...app.matchAll(/const pluginPickerHost = /g)].length, 1);
  assert.match(app, /onHowto: \(pluginId\) => services\.howto\.openPlugin\(pluginId\)/);
});

test('EVERY picker SPREADS that bundle instead of naming its members', () => {
  // The invariant that actually closes the hole. A site listing `plugins:` or `onHowto:`
  // by hand is a site the NEXT ambient dependency can miss — so this is about the SHAPE
  // of the call, not about the dependency that happened to drift this time.
  let found = 0;
  for (const [name, src] of [['plugin-picker.js', picker], ['launcher.js', launcher]]) {
    for (const m of src.matchAll(/new PluginPicker\(\{([\s\S]{0,400}?)\}\)/g)) {
      found += 1;
      assert.match(m[1], /\.\.\./, `${name}: a picker must spread the host bundle`);
      assert.doesNotMatch(m[1], /\bplugins:/, `${name}: ambient deps come from the bundle`);
      assert.doesNotMatch(m[1], /\bonHowto:/, `${name}: ambient deps come from the bundle`);
    }
  }
  assert.ok(found >= 2, `both picker sites found (saw ${found})`);
});

test('both surfaces are handed the SAME bundle, not a copy of its contents', () => {
  assert.equal([...app.matchAll(/pickerHost: pluginPickerHost/g)].length, 2);
});

test('the bundle is a thunk, because it names things built after its consumers', () => {
  // `plugins` is constructed after the manager's options object is written, and the
  // launcher later still. A plain value would have captured undefined — which is exactly
  // the first version of this bug, where the hook was assigned against an unconstructed
  // binding and the button silently did nothing.
  assert.match(app, /const pluginPickerHost = \(\) => \(\{/);
  assert.match(manager, /this\.#pickerHost = pickerHost \?\?/);
});

test('ⓘ opens the plugin page, and the About dialog is gone', () => {
  assert.match(picker, /if \(act === 'about'\) \{[\s\S]*this\.#onHowto\?\.\(p\?\.id\)/);
  assert.doesNotMatch(picker, /openPluginAbout/);
  assert.doesNotMatch(manager, /export function openPluginAbout/);
});
