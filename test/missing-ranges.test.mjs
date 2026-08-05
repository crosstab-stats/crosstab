/**
 * @file missing-ranges.test.mjs
 * Range-style missing values (SPSS/Stata `MISSING VALUES income (LO THRU 0)`).
 *
 * The bug this pins produced WRONG NUMBERS silently: a range the importer could not
 * enumerate contributed only its two endpoints to `missingValues`, so everything
 * between them counted as real data in every mean, correlation and regression, with
 * nothing on screen to suggest it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { splitMissing } = await import('../plugins/builtin-readstat-codec/index.js');

test('a single designated code is a value, not a range', () => {
  assert.deepEqual(splitMissing([[-99, -99]]), { values: [-99], ranges: [] });
});

test('a small integer span still enumerates (cheap to compare, legible in Variables view)', () => {
  assert.deepEqual(splitMissing([[8, 11]]), { values: [8, 9, 10, 11], ranges: [] });
});

test('REGRESSION: a wide span becomes a RANGE, not its two endpoints', () => {
  // The old behaviour was `{ values: [-999999, 0] }` — which marks exactly two numbers
  // missing and lets -50 through as a valid income.
  const { values, ranges } = splitMissing([[-999999, 0]]);
  assert.deepEqual(values, [], 'no endpoint-shaped consolation prize');
  assert.deepEqual(ranges, [[-999999, 0]]);
});

test('REGRESSION: a non-integer span becomes a range too', () => {
  assert.deepEqual(splitMissing([[-1.5, 2.5]]), { values: [], ranges: [[-1.5, 2.5]] });
});

test('discrete codes and ranges coexist on one variable', () => {
  const { values, ranges } = splitMissing([[-99, -99], [-999999, -1000], [7, 8]]);
  assert.deepEqual(values, [-99, 7, 8]);
  assert.deepEqual(ranges, [[-999999, -1000]]);
});

test('non-finite bounds are dropped rather than poisoning the comparison', () => {
  // ReadStat can hand back sentinels; a NaN or Infinity in a SQL BETWEEN would either
  // error or silently match nothing, and both are worse than ignoring the declaration.
  assert.deepEqual(splitMissing([[NaN, 0], [-Infinity, 0], [1, 1]]), { values: [1], ranges: [] });
});

test('the boundary of the enumeration cutoff', () => {
  assert.equal(splitMissing([[0, 1000]]).values.length, 1001, '1000-wide span still enumerates');
  assert.deepEqual(splitMissing([[0, 1001]]).ranges, [[0, 1001]], 'one wider becomes a range');
});
