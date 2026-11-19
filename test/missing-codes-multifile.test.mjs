/**
 * @file missing-codes-multifile.test.mjs
 * One answer for a whole multi-file import.
 *
 * ## The hazard, which is not the tedium
 *
 * Selecting four Scorecard years produced four identical NA/PS prompts. Annoying, but
 * the reason this changed is what happens if they are answered DIFFERENTLY. Stacked
 * sources are combined with `UNION ALL BY NAME`, and DuckDB resolves a column that is
 * DOUBLE in one source and VARCHAR in another by casting to the common supertype —
 * VARCHAR. So accepting the codes on files 1-2 and declining on file 3 silently reverts
 * every recovered column to text across the WHOLE stacked dataset, including the rows
 * where they were accepted. No error; just the original 3,347-mistyped-columns problem
 * back over all 27,252 rows.
 *
 * Carrying one answer across the import makes that impossible by construction rather than
 * unlikely.
 *
 * ## Why it may still ask twice
 *
 * Files genuinely differ — one of the owner's four offered a single code where the others
 * offered two — so "ask once and reuse forever" would be wrong for a file introducing a
 * code nobody has been asked about. It asks again only for values not yet offered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { missingCodesPrompt } = await import('../core/import-service.js');
const { stripComments } = await import('../core/plugin-modules.js');

const cand = (value, columns = 10) => ({ value, values: columns * 100, columns });
const proposal = (...values) => ({
  candidates: values.map((v) => cand(v)),
  combos: values.map((v) => ({ codes: [v], columns: 10 })),
  omitted: 0,
});

// =============================================================================
// The prompt
// =============================================================================

test('a single-file import names only that file', () => {
  const p = missingCodesPrompt('a.csv', proposal('NA'), { files: 1 });
  assert.match(p.hint, /appear in “a\.csv” where numbers/);
  assert.doesNotMatch(p.hint, /other/);
});

test('a multi-file import says the answer governs all of them', () => {
  // Naming one file while deciding for four would be a quiet lie.
  const p = missingCodesPrompt('a.csv', proposal('NA'), { files: 4 });
  assert.match(p.hint, /“a\.csv” and the other 3 files where numbers/);
  const two = missingCodesPrompt('a.csv', proposal('NA'), { files: 2 });
  assert.match(two.hint, /and the other 1 file where/, 'singular when there is one other');
});

test('an explicit selection overrides the default pre-tick', () => {
  // Used when a later file introduces a new code: what was already agreed stays ticked.
  const p = missingCodesPrompt('c.csv', proposal('NA', 'PS', 'XX'), { selected: ['NA', 'XX'] });
  assert.deepEqual(p.selected, ['NA', 'XX']);
  assert.deepEqual(p.items.map((i) => i.value), ['NA', 'PS', 'XX'], 'all are still offered');
});

test('with no selection given, everything is pre-ticked as before', () => {
  const p = missingCodesPrompt('a.csv', proposal('NA', 'PS'));
  assert.deepEqual(p.selected, ['NA', 'PS']);
});

// =============================================================================
// The rule that removes the hazard
// =============================================================================

test('the import carries ONE answer across its files', () => {
  const src = stripComments(readFileSync('core/import-service.js', 'utf8'));
  assert.match(src, /const codeRun = \{ accepted: new Set\(\), offered: new Set\(\), files: files\.length \}/,
    'per-import state exists');
  // Created BEFORE the loop — inside it, each file would get its own and nothing is shared.
  const stateAt = src.indexOf('const codeRun =');
  const loopAt = src.indexOf('for (const file of files) {', stateAt - 400);
  assert.ok(stateAt > 0 && stateAt < loopAt, 'the state is created before the file loop');
  assert.match(src, /this\.#askMissingCodes\(file\.name, proposal, codeRun\)/, 'and is passed in');
});

test('a file with no new candidates reuses the answer instead of asking', () => {
  const src = stripComments(readFileSync('core/import-service.js', 'utf8'));
  assert.match(src, /const fresh = candidates\.filter\(\(c\) => !run\.offered\.has\(c\.value\)\)/);
  assert.match(src, /if \(!fresh\.length\)[\s\S]{0,200}return \[\.\.\.run\.accepted\]/,
    'no fresh codes short-circuits to the agreed set, with no dialog');
});

test('cancelling a later prompt keeps what was already agreed', () => {
  // Retracting mid-import would produce exactly the inconsistent typing this prevents.
  const src = stripComments(readFileSync('core/import-service.js', 'utf8'));
  assert.match(src, /if \(Array\.isArray\(chosen\)\) \{[\s\S]{0,160}run\.accepted\.clear\(\)/,
    'the accepted set is only replaced when an actual answer came back');
});
