/**
 * @file summarise-missing.test.mjs
 * The Variable View's MISSING cell (owner, GSS on an iPhone, 2026-10-07).
 *
 * One GSS variable declares −100 … −10 as missing, and the column printed all ninety-one
 * codes, so a single row grew taller than the screen: *"at first I thought the variables
 * view was broken."* The cell is a summary — the editor holds the exact list — so the fix
 * is to say the same thing in one line, and to say how much was folded away so a short
 * cell never implies a short list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseMissing } from '../core/var-role.js';

test('THE REPORTED CASE: a long consecutive run becomes one span', () => {
  const codes = [];
  for (let v = -100; v <= -10; v += 1) codes.push(v);
  assert.equal(summariseMissing(codes), '-100 to -10 (91 codes)');
});

test('a run is only a run when every step is exactly 1', () => {
  // "8, 10, 12" is three codes that happen to be close together, not a span — writing it
  // as "8 to 12" would claim 9 and 11 are missing too.
  assert.equal(summariseMissing([8, 10, 12]), '8, 10, 12');
});

test('two in a row stay listed — "to" is longer than the thing it replaces', () => {
  assert.equal(summariseMissing([-9, -8]), '-9, -8');
  assert.equal(summariseMissing([-9, -8, -7]), '-9 to -7 (3 codes)');
});

test('runs and strays mix, in numeric order whatever order they arrived in', () => {
  assert.equal(summariseMissing([97, -3, -1, -2, 99, 98]), '-3 to -1, 97 to 99 (6 codes)');
});

test('a short list is left exactly as it is, with no count to read past', () => {
  // The count earns its place only when something was folded; on "-99, -98" it is noise.
  assert.equal(summariseMissing([-99]), '-99');
  assert.equal(summariseMissing([1, 5]), '1, 5');
});

test('DECLARED RANGES appear at all — the column used to omit them', () => {
  // A variable whose missing is a span too wide to enumerate showed an EMPTY cell, which
  // reads as "nothing is missing here" when the opposite is true.
  // No count on these: the cell is showing everything there is, and a count is only
  // meaningful when it is NOT — calling a span “1 code” would be wrong twice over.
  assert.equal(summariseMissing([], [[-999999, 0]]), '-999999 to 0');
  assert.equal(summariseMissing([-99], [[-999999, -1000]]), '-99, -999999 to -1000');
});

test('more groups than fit are elided, and the count says how many there were', () => {
  assert.equal(summariseMissing([1, 3, 5, 7, 9, 11, 13, 15]), '1, 3, 5, 7, 9, 11, … (8 codes)');
});

test('the cap is adjustable, because a wider column could afford more', () => {
  assert.equal(summariseMissing([1, 3, 5, 7], [], { max: 2 }), '1, 3, … (4 codes)');
});

test('options passed where ranges belong do not throw', () => {
  // The signature is (values, ranges, opts) and the middle argument is easy to skip. An
  // object is not iterable, so the old loop would have thrown inside a table render.
  assert.equal(summariseMissing([1, 3], { max: 2 }), '1, 3');
});

test('nothing missing is an empty cell, not a "0 codes" badge', () => {
  assert.equal(summariseMissing(), '');
  assert.equal(summariseMissing([], []), '');
  assert.equal(summariseMissing(null, null), '');
});

test('junk in the metadata is skipped rather than printed', () => {
  // Importers hand back sentinels; NaN and Infinity in a cell would read as real codes.
  assert.equal(summariseMissing([NaN, Infinity, -99]), '-99');
  assert.equal(summariseMissing([], [[NaN, 0], [1, 2]]), '1 to 2',
    'and the dropped range does not inflate a count');
});
