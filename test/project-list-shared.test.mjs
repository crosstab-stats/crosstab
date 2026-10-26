/**
 * @file project-list-shared.test.mjs
 * One renderer for every list of projects.
 *
 * Three surfaces drew a project list. The data layer was unified in August (#171); the
 * sidebar and the project manager both moved onto it and the launcher never did, keeping
 * its own pair of loops over the two calls that unification superseded — an OPFS-only list
 * and a locations-only one. The visible cost was that the first screen of the app showed
 * **one list that was secretly two** — local projects as a bare name, remembered locations
 * as a glyph plus a name — with no date and no size while the data carried both. Both old
 * functions are now deleted, so there is one way to ask.
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
  // Its old pair — an OPFS-only list and a locations-only one — are gone entirely now, so
  // there is only one call anything can make.
  const rail = launcher.slice(launcher.indexOf('// Saved projects in the rail'));
  assert.match(rail, /listProjects\(\)/);
  assert.doesNotMatch(launcher, /listProjectLocations/);
});

test('there is exactly ONE project-list function left', () => {
  // The redundancy the owner spotted: "why even have two 'list the projects' functions?"
  // Answer, after tracing it — no reason. One was OPFS-only, one locations-only, and
  // callers had to know which storage a project sat on before they could ask about it,
  // which is the knowledge the backend abstraction exists to remove.
  assert.doesNotMatch(sync, /listAllProjects|listProjectLocations\(\) \{/);
  // Its options bag is allowed — `{sizes}` was added 2026-10-26 after measuring that the
  // size walk was 169 ms of a 174 ms call at 60 projects. What must stay singular is the
  // FUNCTION, not its arity.
  assert.match(sync, /^  async listProjects\(\{[^)]*\} = \{\}\) \{/m);
  assert.equal((sync.match(/^  async listProjects\(/gm) ?? []).length, 1, 'exactly one');
  // And the dead "Open project" browse modal it fed, superseded by the manager in #173.
  assert.doesNotMatch(sync, /#showBrowseModal|#entryRow/);
});

test('the size walk is OPT-IN, and only the manager opts in', () => {
  // Measured 2026-10-26 at 60 projects: the disk-size walk was 169 ms of a 174 ms
  // `listProjects()`, because a size needs one OPFS handle operation per file at ~0.5 ms
  // each. There is no faster walk, only not walking — so the two surfaces that never show
  // the number stopped paying for it, and the one that answers "which should I delete"
  // asks for it explicitly.
  assert.match(sync, /if \(wantSizes\) \{/, 'guarded');
  assert.match(sync, /async listProjects\(\{ sizes: wantSizes = false \} = \{\}\)/, 'default off');

  const manager = readFileSync('core/project-manager.js', 'utf8');
  assert.match(manager, /listProjects\(\{ sizes: true \}\)/, 'the manager asks');

  // And nobody else does. A size on the launcher or the sidebar is 169 ms they do not
  // spend, for a column they do not draw.
  for (const path of ['core/launcher.js', 'core/app.js']) {
    const src = readFileSync(path, 'utf8');
    assert.doesNotMatch(src, /listProjects\(\{[^)]*sizes/, `${path} must not ask for sizes`);
  }
});

test('one pass per directory, not one stat per file', () => {
  // `stat` resolves its path from the root on every call (`#dirOf` walks
  // getDirectoryHandle per segment), so statting a directory's files re-resolved that
  // directory once per file. `statDir` exists to ask once.
  const store = readFileSync('core/project-store.js', 'utf8');
  assert.match(store, /typeof this\.#driver\.statDir === 'function'/, 'uses it when present');
  assert.match(store, /for \(const name of await this\.#driver\.list\(dirPath\)\)/,
    'and falls back for drivers without it — dropbox and webdav are untouched');

  const driver = readFileSync('core/storage-driver.js', 'utf8');
  assert.match(driver, /^  async statDir\(dirPath\) \{/m);
  // Deliberately not recursive: a project's assets are a second directory, asked for
  // separately, and a recursive default would hide an expensive call behind a cheap name.
  const body = driver.slice(driver.indexOf('async statDir('), driver.indexOf('async statDir(') + 700);
  assert.doesNotMatch(body, /await this\.statDir/, 'no recursion');
  assert.match(body, /if \(h\.kind !== 'file'\) continue;/, 'subdirectories are skipped');
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

test('the sidebar keeps its "Manage projects…" button under the list', () => {
  // Lost in a33f537 and not noticed for a day: #projectsZone was rewritten to use the
  // shared row renderer, and this button sat between the list and the `return`, so the
  // whole span went. Nothing renders a button that is not there, so no test failed and
  // nothing looked wrong — the owner spotted it on a phone (2026-10-11).
  //
  // It is the only place a project can be renamed or deleted from the sidebar: the rows
  // themselves deliberately carry no destructive verbs (#173), so losing this left the
  // zone with no way to manage anything at all.
  const zone = app.slice(app.indexOf('#projectsZone(recents) {'));
  const body = zone.slice(0, zone.indexOf('\n  }'));
  assert.match(body, /if \(this\.openManager\)/, 'rendered only when there is a manager to open');
  assert.match(body, /text: 'Manage projects…'/);
  assert.match(body, /this\.openManager\(\)/);
});
