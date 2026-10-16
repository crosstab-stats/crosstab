/**
 * @file clean-name.test.mjs
 * User-typed names are bounded before they reach the op log.
 *
 * A project or dataset name was taken with `String(name).trim()` and nothing else, and
 * it does not merely get displayed: it becomes an APPENDED OP, written on every save and
 * replicated to every collaborator. Paste a document into the rename box and that
 * document is in the log for the life of the project, in every copy of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanName } from '../core/plugin-stdlib.js';

const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const LSEP = String.fromCharCode(0x2028);

test('an ordinary name is left alone', () => {
  assert.equal(cleanName('Wave 2 (pilot)'), 'Wave 2 (pilot)');
  assert.equal(cleanName('  trimmed  '), 'trimmed');
  assert.equal(cleanName('ALL CAPS & punctuation!'), 'ALL CAPS & punctuation!');
});

test('a pasted document is capped, not stored', () => {
  assert.equal(cleanName('x'.repeat(512 * 1024)).length, 200);
  assert.equal(cleanName('x'.repeat(50)).length, 50, 'a real name must not be touched');
});

test('control characters become spaces, so words do not weld together', () => {
  // Dropping them would turn "My\nProject" into "MyProject", which reads as a name the
  // user chose rather than one the app mangled.
  assert.equal(cleanName(`My${LF}Project`), 'My Project');
  assert.equal(cleanName(`a${NUL}b`), 'a b');
  assert.equal(cleanName(`a${LSEP}b`), 'a b');
});

test('runs of whitespace collapse', () => {
  assert.equal(cleanName(`a ${LF} ${LF}  b`), 'a b');
});

test('an empty or whitespace-only name yields the fallback', () => {
  assert.equal(cleanName('   '), '');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(`${NUL}${LF}`, { fallback: 'Untitled' }), 'Untitled');
});

test('the two callers that write a name into the log use it', () => {
  // The point is not the helper, it is that the op-appending paths go through it.
  assert.match(readFileSync('core/project-sync.js', 'utf8'), /name = cleanName\(name\)/);
  assert.match(readFileSync('core/dataset-manager.js', 'utf8'), /collRename\(id, cleanName\(name\)\)/);
});

test('cleanName is not slug — it keeps the name a person typed', () => {
  // Two jobs that look similar: `slug` makes a filename (lowercase, dashed), this keeps
  // a display name. Collapsing them would rename every project to a URL fragment.
  assert.notEqual(cleanName('Wave 2 (pilot)'), 'wave-2-pilot');
});
