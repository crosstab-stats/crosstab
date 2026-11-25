/**
 * @file r-console-na-note.test.mjs
 * The R Console explains an NA result — and says nothing about what to do with it.
 *
 * ## The decision these tests hold
 *
 * The console folds each variable's designated missing codes to NA before binding `vars`,
 * because that is what a plugin's inputs get (#159). The cost is a student who types
 * `mean(vars)`, gets `NA`, and has no way to see that the host did something to the data
 * on the way in — the Data grid still shows -99.
 *
 * The fix considered first was a checkbox to drop the NA entirely, so `mean(vars)` would
 * just work. It was rejected: `vars` exists to be *exactly* what a plugin receives, so a
 * third binding would make console-tested code return different numbers inside a plugin
 * (the #159 bug again), and for a multi-variable `vars` "drop the NA" silently means
 * listwise deletion — the real methodological choice, made invisible.
 *
 * What shipped instead is a diagnosis: how many NA are in `vars`, and where they came
 * from when the host is what put them there. The owner's line on the scope:
 *
 *   *"Rather than provide guidance that implies removal is the correct approach (it may
 *   not be), let's simply surface a reason why the result may not be what was expected
 *   (particularly when related to something we did, the missing/NA substitution)."*
 *
 * So the boundary is: **the tool explains its own behaviour, it does not teach the
 * analysis.** `na.rm`, `na.omit`, "remove", "drop" are all out — not because they are
 * wrong, but because which one is right is the analyst's call and, in a classroom, the
 * instructor's to teach. The third test is the one with teeth: hint strings attract one
 * more helpful sentence every time someone touches them, and that is how a diagnosis
 * becomes a curriculum.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from '../core/plugin-modules.js';

const SRC = readFileSync('core/r-console.js', 'utf8');
const WEBR = readFileSync('core/webr-manager.js', 'utf8');

/** A method's source, comments and all. */
function method(src, signature) {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `${signature} is gone from r-console.js — renamed, or the note was removed`);
  const end = src.indexOf('\n  }', i);
  assert.notEqual(end, -1, `could not find the end of ${signature}`);
  return src.slice(i, end + 4);
}

// --- the NA detector, lifted and run -----------------------------------------------
// Not re-implemented here: a copy of the regexes would keep passing after the real ones
// changed, which is the one thing this test exists to catch.

const showsNA = (() => {
  const body = method(SRC, 'static #showsNA(output) {');
  const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
  return new Function('output', inner);
})();

test('R printing NA is what triggers the note', () => {
  assert.equal(showsNA('[1] NA'), true);
  assert.equal(showsNA('[1] NaN'), true);
  assert.equal(showsNA('  age income\n1  NA  31000'), true);
});

test('a result with no NA in it does not', () => {
  assert.equal(showsNA('[1] 42'), false);
  assert.equal(showsNA('[1] 37.5'), false);
  assert.equal(showsNA(''), false);
  assert.equal(showsNA(undefined), false);
});

test('a character value that reads "NA" is not R saying NA', () => {
  // A country code, a factor level, a label. The note would be a non-sequitur on these.
  assert.equal(showsNA('[1] "NA"'), false);
  assert.equal(showsNA('[1] "NA" "SE" "NO"'), false);
  // Unquoted but not the token: word boundaries, not a substring search.
  assert.equal(showsNA('[1] Namibia'), false);
  assert.equal(showsNA('[1] 3 NATIONAL'), false);
});

// --- the boundary ------------------------------------------------------------------

test('the note diagnoses and does not advise', () => {
  // Comments stripped first: this method's own doc comment names `na.rm` and "dropping"
  // precisely in order to forbid them, and a naive search would read the prohibition as
  // the offence.
  const note = stripComments(method(SRC, '#noteMissing(output) {'));
  for (const banned of ['na.rm', 'na.omit', 'remove', 'drop', 'complete.cases', 'should', 'consider', 'instead try']) {
    assert.ok(
      !note.toLowerCase().includes(banned),
      `the NA note now says "${banned}" — it is a diagnosis, not guidance on how to handle missing data`,
    );
  }
});

test('it only credits the fold when a CHECKED variable declares missing codes', () => {
  const note = stripComments(method(SRC, '#noteMissing(output) {'));
  assert.match(note, /declared\s*=\s*meta\.some\(/, 'the declared-codes test is gone');
  assert.match(
    note,
    /this\.#checked\.has\(m\.name\)/,
    'every variable in the project would answer for the checked ones — saying the host folded '
    + 'codes when it did not teaches the student something false about their own data',
  );
  // The manager-level getVariableMeta takes no options and ignores a {variables} filter.
  assert.ok(
    !/getVariableMeta\s*\?\.\(\s*\{/.test(note) && !/getVariableMeta\s*\(\s*\{/.test(note),
    'getVariableMeta is being passed a filter it ignores — the result is every variable in the project',
  );
  assert.match(note, /!this\.#keepMissing && declared/, 'with raw codes bound, the host did not fold anything');
});

// --- the wiring --------------------------------------------------------------------

test('the note is offered after a successful line, never after an error', () => {
  const submit = stripComments(method(SRC, 'async #submit(code) {'));
  assert.match(submit, /if \(!res\.error\) this\.#noteMissing\(res\.output\)/,
    'an error message of its own is the explanation; a second one about NA is noise');
});

test('once per binding, and a new binding earns a fresh explanation', () => {
  const note = stripComments(method(SRC, '#noteMissing(output) {'));
  assert.match(note, /if \(this\.#naExplained/, 'the note would repeat on every NA result');
  assert.match(note, /this\.#naExplained = true/);

  const rebind = stripComments(method(SRC, 'async #rebind() {'));
  assert.match(rebind, /this\.#naExplained = false/, 'a changed binding keeps a spent explanation');
  assert.match(rebind, /this\.#bound = \{\}/, 'stale counts would describe the previous selection');
});

test('an unknown count is not treated as zero', () => {
  const note = stripComments(method(SRC, '#noteMissing(output) {'));
  assert.match(note, /Number\.isFinite\(na\)/,
    'consoleBind omits the count when it could not take one; `!na` would silently mean "no NA"');
});

test('the count comes from the bound object, on both bind paths', () => {
  const bind = stripComments(WEBR.slice(WEBR.indexOf('consoleBind(columns, multiple')));
  const body = bind.slice(0, bind.indexOf("}, 'consoleBind');"));
  assert.match(body, /sum\(is\.na\(\.v\)\)/, 'the NA count must be asked of the object R actually holds');
  const spread = body.match(/return \{ names: columns, multiple, \.\.\.\(await counts\(\)\) \}/g) ?? [];
  assert.equal(spread.length, 2,
    'both the Parquet and the JS-array bind path must report the count, or the note appears only '
    + 'when nanoparquet happens to be unavailable');
});

test('the info line discloses the NA count without being asked', () => {
  const rebind = stripComments(method(SRC, 'async #rebind() {'));
  assert.match(rebind, /\$\{n\} NA/, 'the quietest disclosure is the line that already describes the binding');
  assert.match(rebind, /this\.#keepMissing\s*$|this\.#keepMissing\s*\n?\s*\?\s*'raw codes'/m,
    'with raw codes bound there is no fold to report');
});
