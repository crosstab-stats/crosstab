/**
 * @file stdlib-unpack.test.mjs
 * Reading an R result: one vocabulary, and a missing statistic that stays missing.
 *
 * ## The three defects this replaces
 *
 * `flat()` / `normalizeResult()` lived in 45 plugins and the copies disagreed about both
 * what they return and what a missing value is (scanned 2026-10-12):
 *
 * 1. **`num` meant two types** — a numeric scalar in 28 plugins, a numeric vector in 10.
 *    `str` was overloaded the same way (a vector in agreement, a scalar in epi).
 * 2. **12 copies turned a missing number into `0`**, because WebR renders R's `NA` and
 *    `NaN` alike as JS `null` and `[null].map(Number)` is `[0]`.
 * 3. **20 copies turned a missing string into the text `"null"`**.
 *
 * Defect 2 was confirmed in the running app before any of this was written: a regression
 * on a perfectly collinear predictor printed `VIF 0.00`, and a VIF is never below 1. The
 * fixtures below are the ACTUAL shapes `webr.run()` returned in that session, not
 * invented ones — including the detail that `Inf` survives as a JS infinity while `NA`
 * and `NaN` both flatten to `null`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { unpackR, fixed, fmtP } from '../core/plugin-stdlib.js';

/** What `webr.run()` actually handed back for `list(nums = c(1, NA, 3), …)`. */
const FIXTURE = {
  type: 'list',
  names: ['nums', 'ints', 'chars', 'logi', 'scalarNA', 'nanv', 'infv', 'empty'],
  values: [
    { type: 'double', values: [1, null, 3] },
    { type: 'integer', values: [1, null, 3] },
    { type: 'character', values: ['a', null, 'c'] },
    { type: 'logical', values: [true, null, false] },
    { type: 'double', values: [null] },
    { type: 'double', values: [1, null, 3] },          // c(1, NaN, 3) — NaN also -> null
    { type: 'double', values: [1, Infinity, -Infinity] },
    { type: 'double', values: [] },
  ],
};

test('a missing number becomes NaN, never zero', () => {
  const r = unpackR(FIXTURE);
  const nums = r.nums('nums');
  assert.equal(nums.length, 3);
  assert.equal(nums[0], 1);
  assert.ok(Number.isNaN(nums[1]), 'R NA must not become 0 — that reads as a finding');
  assert.equal(nums[2], 3);
  // The whole point, stated as the user sees it.
  assert.equal(fixed(nums[1], 3), '—');
  assert.notEqual(fixed(nums[1], 3), '0.000');
});

test('R NaN is also null on the wire, and is also not zero', () => {
  // WebR does not distinguish NA from NaN in toJs(); both arrive as null. A plugin cannot
  // tell them apart, and for a results table it does not need to — neither is a number.
  const r = unpackR(FIXTURE);
  assert.ok(Number.isNaN(r.nums('nanv')[1]));
});

test('NA in an integer or logical vector is missing too', () => {
  const r = unpackR(FIXTURE);
  assert.ok(Number.isNaN(r.nums('ints')[1]), 'NA_integer_ is not 0');
  // A logical maps to 1/0, so a missing one must not read as FALSE.
  const logi = r.nums('logi');
  assert.equal(logi[0], 1);
  assert.ok(Number.isNaN(logi[1]), 'NA is not FALSE');
  assert.equal(logi[2], 0);
});

test('an infinity is passed through, because it is already non-finite', () => {
  // Inf survives toJs() as a JS infinity; only NA/NaN flatten to null. `fixed` prints the
  // em dash for it either way, so nothing has to special-case it.
  const r = unpackR(FIXTURE);
  const inf = r.nums('infv');
  assert.equal(inf[1], Infinity);
  assert.equal(inf[2], -Infinity);
  assert.equal(fixed(inf[1], 2), '—');
});

test('a missing string is empty, not the word "null"', () => {
  const r = unpackR(FIXTURE);
  assert.deepEqual(r.strs('chars'), ['a', '', 'c']);
  assert.notEqual(r.strs('chars')[1], 'null', 'String(null) is the bug being fixed');
});

test('num1 and str1 read the first element', () => {
  const r = unpackR(FIXTURE);
  assert.equal(r.num1('nums'), 1);
  assert.equal(r.str1('chars'), 'a');
  // A one-element vector and a scalar are the same thing in R.
  assert.ok(Number.isNaN(r.num1('scalarNA')));
  assert.equal(fmtP(r.num1('scalarNA')), '—');
});

test('str1 can report absence as null, for a caller that must tell it from empty', () => {
  // builtin-epi's lv() renders an absent factor attribute as `?`, so it needs the
  // distinction. Everyone else gets ''.
  const r = unpackR(FIXTURE);
  assert.equal(r.str1('scalarNA'), '');
  assert.equal(r.str1('scalarNA', { missing: null }), null);
  assert.equal(r.str1('chars', { missing: null }), 'a', 'a present value is unaffected');
});

test('an absent name is empty rather than an exception', () => {
  // A plugin reads optional fields its R only sometimes emits; asking must be safe.
  const r = unpackR(FIXTURE);
  assert.deepEqual(r.nums('nope'), []);
  assert.deepEqual(r.strs('nope'), []);
  assert.ok(Number.isNaN(r.num1('nope')));
  assert.equal(r.str1('nope'), '');
  assert.deepEqual(r.nums('empty'), [], 'a zero-length R vector is not a missing one');
});

test('has() separates "absent" from "present but NA"', () => {
  const r = unpackR(FIXTURE);
  assert.equal(r.has('scalarNA'), true, 'present, and its value is missing');
  assert.equal(r.has('nope'), false);
  assert.ok(Number.isNaN(r.num1('scalarNA')));
});

test('the overloaded names are gone, so stale code fails loudly', () => {
  // `num` was a scalar in 28 plugins and a vector in 10; `str` a vector in one and a
  // scalar in another. Keeping either would let a copied line return the wrong TYPE in
  // silence. A missing method throws on the spot instead.
  const r = unpackR(FIXTURE);
  assert.equal(r.num, undefined, 'num was ambiguous and must not exist');
  assert.equal(r.str, undefined, 'str was ambiguous and must not exist');
  assert.equal(r.n1, undefined);
  assert.equal(r.s1, undefined);
  assert.throws(() => r.num('nums'), TypeError);
});

test('it accepts a plain object as well as a names/values pair', () => {
  // Some callers pass an already-shaped object; the old copies all handled both.
  const r = unpackR({ a: { type: 'double', values: [5, null] }, b: 7 });
  assert.equal(r.num1('a'), 5);
  assert.ok(Number.isNaN(r.nums('a')[1]));
  assert.equal(r.num1('b'), 7, 'an unwrapped scalar still reads');
});

test('a null or undefined result does not throw', () => {
  // `webr.run()` returns result: null when R returned something unconvertible.
  for (const bad of [null, undefined]) {
    const r = unpackR(bad);
    assert.deepEqual(r.nums('x'), []);
    assert.ok(Number.isNaN(r.num1('x')));
    assert.equal(r.has('x'), false);
  }
});
