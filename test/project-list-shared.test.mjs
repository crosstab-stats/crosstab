/**
 * @file project-list-shared.test.mjs
 * One renderer for every list of projects.
 *
 * Three surfaces drew a project list. The data layer was unified in August (#171,
 * `listAllProjects()`); the sidebar and the project manager both moved onto it and the
 * launcher never did, keeping its own pair of loops over `listProjects()` +
 * `listProjectLocations()`. The visible cost was that the first screen of the app showed
 * **one list that was secretly two** — local projects as a bare name, remembered locations
 * as a glyph plus a name — with no date and no size while the data carried both.
 *
 * These are source-level assertions rather than render tests because there is no DOM here
 * (the project runs `node --test` with no jsdom). What they protect is the thing that
 * actually rotted: a second renderer appearing. The rendering itself was verified in the
 * running app — rail at 240px, one-line metadata, mutual exclusion with the data-source
 * buttons, and the manager opening over the launcher without disturbing it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const launcher = readFileSync('core/launcher.js', 'utf8');
const app = readFileSync('core/app.js', 'utf8');
const list = readFileSync('core/project-list.js', 'utf8');
const sync = readFileSync('core/project-sync.js', 'utf8');

test('both surfaces render through the shared component', () => {
  assert.match(app, /renderProjectList\(recents, \{/);
  assert.match(launcher, /renderProjectList\(rows, \{/);
  assert.match(launcher, /import \{ renderProjectList, markPickedProject \}/);
});

test('the launcher no longer walks two lists of its own', () => {
  // The rail's old pair. `openProjectByName` still uses listProjects for now — that is the
  // only survivor, and it goes in the follow-up that deletes the function.
  const rail = launcher.slice(launcher.indexOf('// Saved projects in the rail'));
  assert.doesNotMatch(rail, /listProjectLocations\(\)/);
  assert.match(rail, /listAllProjects\(\)/);
});

test('the unified row carries activePlugins, or the picker seeding dies silently', () => {
  // The launcher seeds its plugin picker from the project's saved set on a pick. That came
  // from the OPFS-only list; migrating without carrying it would have left the feature
  // looking fine and quietly doing nothing.
  assert.match(sync, /activePlugins: Array\.isArray\(p\.activePlugins\) \? p\.activePlugins : null/);
  assert.match(launcher, /if \(Array\.isArray\(row\.activePlugins\)\)/);
});

test('a location reports activePlugins as null, not as an empty set', () => {
  // "We cannot know" and "it had none" are different claims. Seeding a picker from the
  // second when the truth is the first would switch a project's plugins off.
  const loc = sync.slice(sync.indexOf('key: `loc:'));
  assert.match(loc.slice(0, 900), /activePlugins: null/);
});

test('rename is the sidebar’s alone', () => {
  // Settled 2026-10-01: rename belongs to the project you are IN, not to a list of ones you
  // might open. The component takes it as a per-host verb and the launcher does not pass it.
  assert.match(app, /onRename: \(p, li, nameEl\)/);
  const rail = launcher.slice(launcher.indexOf('// Saved projects in the rail'));
  assert.doesNotMatch(rail, /onRename/);
});

test('what a click MEANS stays with the host', () => {
  // The sidebar opens at once; the launcher stages a pick that Start commits. Kept on
  // evidence, not symmetry — the owner fat-fingered the wrong project on an iPhone, and a
  // confirm step is a feature on a touch target you can miss.
  assert.match(app, /onPick: \(p\) => void this\.#openProjectRow\(p\)/);
  assert.match(launcher, /this\.#pendingProject = \{ id: row\.projectId \}/);
  assert.match(launcher, /this\.#pendingBackend = backend/);
  assert.doesNotMatch(list, /openProject|pendingProject/, 'the shared component has no opinion about it');
});

test('a folder pick is always deferred to Start, gesture or not', () => {
  // A folder's permission re-grant must happen inside a user gesture and fails SILENTLY
  // without one. Start is that gesture. Branching on `needsGesture` here would create a
  // second path whose failure mode is "clicking does nothing, with no error anywhere".
  const rail = launcher.slice(launcher.indexOf('// Saved projects in the rail'));
  assert.doesNotMatch(rail, /needsGesture/);
});

test('picking a data source clears a picked project', () => {
  // The project rows are not `.ctl__source` buttons any more, so the blanket toggle no
  // longer reaches them. A cleared pick that still looks picked is the worst outcome:
  // Start would open the demo while the screen says otherwise.
  assert.match(launcher, /markPickedProject\(overlay\.querySelector\('\.ctl__projects'\), null\)/);
});

test('the launcher offers Manage projects, using the same closure the File menu does', () => {
  assert.match(launcher, /class="ctl__manage"|'ctl__manage'/);
  assert.match(launcher, /this\.#openManager\('recents'\)/);
  assert.match(app, /^\s*openManager,$/m, 'app.js hands over the one it already built');
});

test('the CSS template holds no backtick, which once silently ate the stylesheet', () => {
  // A backtick inside a CSS COMMENT terminated the template literal early. The remaining
  // CSS still parsed as JS, so `node --check` passed and the launcher simply rendered with
  // no styles at all — a full-width unstyled page. Same family as the recorded
  // shell-quoting hazard: the damage is invisible to a syntax check.
  const open = launcher.indexOf('function injectStyles');
  const close = launcher.indexOf('document.head.append(s)', open);
  assert.ok(open > 0 && close > open);
  const backticks = (launcher.slice(open, close).match(/`/g) || []).length;
  assert.equal(backticks, 2, 'only the template literal’s own delimiters');
});
