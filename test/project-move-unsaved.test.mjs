/**
 * @file project-move-unsaved.test.mjs
 * "Add some data first" said to a project that has data.
 *
 * Found by the manual pass: open clean, pick the quantitative demo, then **File ▸ Manage
 * projects… ▸ Store in…** a folder. The move was refused with "Add some data first — an
 * empty project has nothing to move", in front of 30 rows and 5 variables.
 *
 * The guard asked `!this.#binding`, which answers "has this project been WRITTEN yet".
 * That coincides with "is it empty" for a blank project and comes apart for a loaded
 * demo: nothing has been edited, so no autosave has fired, so there is no binding. The
 * encryption dialog had the same false negative from the same proxy, calling that
 * project "Nothing saved yet".
 *
 * `hasContent()` asks the question the storage verbs actually need, and with data on
 * board the verb proceeds: choosing where a project lives is itself the first deliberate
 * act about its storage, so it brings the project into being at the destination.
 *
 * The move itself was driven end-to-end in a real browser against a real folder store
 * (an OPFS directory handle through the app's own FsaFolderDriver): never-edited demo →
 * moveTo → true, the folder holds project.json + the Parquet source + the shortcut, the
 * 30 rows survive, protectionState flips to `folder`, and OPFS is left with no projects
 * directory at all — no stray local copy. A blank project is still refused.
 *
 * Run: `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProjectSync } from '../core/project-sync.js';

/** ProjectSync with only the dependency `hasContent` reads. */
const withSheets = (sheets) => new ProjectSync({ datasets: { all: () => sheets } });
const sheet = (rowCount, vars = []) => ({ rowCount, getVariableMeta: () => vars });

// --- what "empty" actually means ---------------------------------------------

test('a loaded demo has content, binding or no binding', () => {
  // The reported case: 30 rows, 5 variables, never saved.
  const p = withSheets([sheet(30, [{ name: 'region' }, { name: 'gender' }])]);
  assert.equal(p.hasContent(), true);
});

test('the launcher’s blank project has none', () => {
  // One dataset, no variables, no rows — which is what "Add some data first" is for.
  assert.equal(withSheets([sheet(0, [])]).hasContent(), false);
  assert.equal(withSheets([]).hasContent(), false);
});

test('a schema with no rows still counts', () => {
  // An import that matched nothing is not the same as never having imported: there are
  // variables to store, and refusing to move them would lose a real (if empty) dataset.
  assert.equal(withSheets([sheet(0, [{ name: 'id' }])]).hasContent(), true);
});

test('any one dataset with content is enough', () => {
  assert.equal(withSheets([sheet(0, []), sheet(12, [])]).hasContent(), true);
});

test('it survives a half-built engine rather than throwing', () => {
  // It is called from error paths and from a dialog that can open early.
  assert.equal(new ProjectSync({}).hasContent(), false);
  assert.equal(withSheets([{}]).hasContent(), false);
});

// --- the verbs ask the new question ------------------------------------------

const SRC = readFileSync(new URL('../core/project-sync.js', import.meta.url), 'utf8');
/** A correct comment must never be what satisfies an assertion about the code. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = strip(SRC);
const bodyOf = (sig) => CODE.slice(CODE.indexOf(sig)).split('\n  }')[0];

test('moveTo refuses on emptiness, not on being unsaved', () => {
  const body = bodyOf('async moveTo(backend)');
  assert.match(body, /if \(wasLocal && !this\.hasContent\(\)\)/);
  assert.ok(!/wasLocal && !this\.#binding/.test(body), 'the binding proxy was the bug');
});

test('a move that creates the project names it what autosave would', () => {
  // Otherwise this path invents a second default ("My project") for the same situation
  // the rest of the app calls "Untitled project".
  const body = bodyOf('async moveTo(backend)');
  assert.match(body, /const projectName = this\.activeName[\s\S]{0,120}'Untitled project'/);
  assert.ok(!/'My project'/.test(body), 'no second invented default');
});

test('the encryption dialog reports unsaved-with-data as protectable', () => {
  const body = bodyOf('async protectionState()');
  assert.match(body, /if \(!this\.hasContent\(\)\) return \{ scope: 'unsaved' \}/);
  assert.match(body, /scope: 'local'/, 'with content it is a normal local project');
});

test('protecting an unwritten project writes it first', () => {
  // `#settle` only saves where a binding already exists, so without this the next line
  // reads `this.#binding.id` off null.
  const body = bodyOf('async protectProject()');
  assert.match(body, /if \(!this\.hasContent\(\)\)/);
  assert.match(body, /await this\.ensureProject\(\)/);
  const guard = body.indexOf('ensureProject');
  const use = body.indexOf('this.#binding.id');
  assert.ok(guard > -1 && use > guard, 'the project must exist before its id is read');
});
