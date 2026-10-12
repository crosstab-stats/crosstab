/**
 * @file stdlib-reporting.test.mjs
 * The statistical-reporting formatters, and the drift they replaced.
 *
 * ## What this is defending
 *
 * A drift scan of the 60 compute plugins on 2026-10-12 found six helpers copied into
 * dozens of files and already disagreeing with each other **in output a reader can see**:
 *
 *     fmtP     32 copies, 5 variants — `< .001`, `<.001` (sced), `< 0.001` (spatial)
 *     rStr     32 copies, 2 variants — two escaped the newline, thirty did not
 *     ci       18 copies, 3 variants — 3 dp in thirteen, 4 dp in three
 *     labelOf  27 copies, 3 variants — one took a different argument entirely
 *     metaMap  34 copies, 3 variants
 *     f        38 copies, 4 variants (cosmetic — all four behaved identically)
 *
 * Unlike the `el()` swap, this drift was never invisible: it printed. Three spellings of
 * `p < .001` across one manuscript's worth of tables is the kind of thing a reviewer
 * notices and an author has to fix by hand. So these tests pin the CONVENTIONS, not just
 * the plumbing — a future edit that re-introduces a leading zero on a p-value should
 * fail here rather than ship.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtP, fmtPInline, fixed, rounded, ci, labelOf, metaMap, rStr,
} from '../core/plugin-stdlib.js';

test('fmtP prints three decimals and no leading zero', () => {
  // A p cannot exceed 1, so the digit before the point can only be 0 or 1 and carries no
  // information. APA's rule, and SPSS's Sig. column. Taken on the owner's call 2026-10-12
  // ("good to be consistent") — the floor case already dropped it, so `0.034` beside
  // `< .001` was the app disagreeing with itself inside one column.
  assert.equal(fmtP(0.0342), '.034');
  assert.equal(fmtP(0.5), '.500');
  assert.equal(fmtP(0.049), '.049');
  // The floor. All three of the tree's spellings converge here: `< .001` wins, with the
  // space, without the zero. This is the assertion that would have caught sced and spatial.
  assert.equal(fmtP(0.0009), '< .001');
  assert.equal(fmtP(0), '< .001');
  assert.equal(fmtP(1e-16), '< .001');
  assert.notEqual(fmtP(0), '< 0.001', 'builtin-spatial\u2019s spelling: a p cannot exceed 1');
  assert.notEqual(fmtP(0), '<.001', 'builtin-sced\u2019s spelling: needs the space');
});

test('fmtP says nothing rather than something false', () => {
  for (const bad of [NaN, null, undefined, Infinity, -Infinity, 'x']) {
    assert.equal(fmtP(bad), '\u2014', `${String(bad)} should be the em dash`);
  }
});

test('fmtPInline is the same number in a sentence', () => {
  assert.equal(fmtPInline(0.0342), 'p = .034');
  assert.equal(fmtPInline(0.0001), 'p < .001');
  assert.equal(fmtPInline(NaN), 'p = \u2014');
  // It delegates, so the two can never disagree about the leading zero.
  assert.equal(fmtPInline(0.5), `p = ${fmtP(0.5)}`);
  assert.equal(fmtPInline(1), 'p = 1.000');
});

test('p = 1 keeps its digit, because that is not a leading zero', () => {
  // A real result: a chi-square of exactly 0, or a two-sided test on a perfectly
  // symmetric split. `.000` would say the opposite of what happened. The zero is stripped
  // from the formatted STRING, not by assuming the value is below 1.
  assert.equal(fmtP(1), '1.000');
  assert.equal(fmtP(0.9996), '1.000', 'rounds up to 1.000 and keeps it');
  assert.equal(fmtP(0.9994), '.999');
});

test('a negative falls through the floor, as it always did', () => {
  // Not a p-value at all, and nothing upstream should produce one. It lands on `< .001`
  // because the floor test is `p < 0.001` — which is what all 32 copies did, so this is
  // recorded rather than chosen. The leading-zero change did not touch it.
  assert.equal(fmtP(-0.25), '< .001');
});

test('fixed holds its decimals, and non-finite is a real answer', () => {
  assert.equal(fixed(1.23456, 3), '1.235');
  assert.equal(fixed(2, 0), '2');
  assert.equal(fixed(-0.5, 2), '-0.50');
  // R returns NaN for a statistic it could not compute. Printing 0 would read as a result.
  assert.equal(fixed(NaN, 3), '\u2014');
  assert.equal(fixed(null, 3), '\u2014');
  assert.equal(fixed(Infinity, 3), '\u2014');
});

test('rounded is a count, not a formatted number', () => {
  assert.equal(rounded(3.6), '4');
  assert.equal(rounded(1024), '1024', 'no separator: a comma reads as a decimal in much of the world');
  assert.equal(rounded(NaN), '\u2014');
});

test('ci defaults to three decimals and lets the caller ask for more', () => {
  assert.equal(ci(-0.2141, 1.0378), '[-0.214, 1.038]');
  // margins / meta / trend: a slope can be small enough that 3 dp prints all zeros.
  assert.equal(ci(0.00012, 0.00071, 4), '[0.0001, 0.0007]');
  assert.equal(ci(NaN, 1), '\u2014');
  assert.equal(ci(1, NaN), '\u2014');
});

test('labelOf names a variable both ways round', () => {
  const entry = { name: 'hhinc', label: 'Household income' };
  assert.equal(labelOf(entry, 'hhinc'), 'Household income (hhinc)');
  // builtin-var's case: a plot legend, where the column name is clutter.
  assert.equal(labelOf(entry, 'hhinc', { qualify: false }), 'Household income');
});

test('labelOf never invents a label it does not have', () => {
  assert.equal(labelOf({ name: 'q1' }, 'q1'), 'q1');
  assert.equal(labelOf({ name: 'q1', label: '' }, 'q1'), 'q1');
  // The mirror-image hazard: builtin-mixture passed the MAP here. Resolving nothing has
  // to degrade to the column name, not to "undefined (q1)".
  assert.equal(labelOf(undefined, 'q1'), 'q1');
  assert.equal(labelOf(new Map([['q1', { label: 'First' }]]), 'q1'), 'q1');
});

test('metaMap keys by column name and tolerates no dataset', () => {
  const m = metaMap([{ name: 'a', label: 'A' }, { name: 'b' }]);
  assert.equal(m.get('a').label, 'A');
  assert.equal(m.size, 2);
  assert.equal(metaMap(null).size, 0, 'a plugin can run before a dataset is open');
  assert.equal(metaMap(undefined).size, 0);
});

test('rStr produces a literal R will read back as the original string', () => {
  assert.equal(rStr('hhinc'), '"hhinc"');
  assert.equal(rStr('say "hi"'), '"say \\"hi\\""');
  assert.equal(rStr('C:\\data'), '"C:\\\\data"');
});

test('rStr escapes the newline — the fix that lived in only two of thirty-two copies', () => {
  // A raw newline inside the literal is legal R, but it splits the generated line. The
  // captured-R audit trail and the `# df <- …` comment prelude are both read line-wise,
  // and a newline in a column name would push the rest of a comment onto a live code line.
  assert.equal(rStr('a\nb'), '"a\\nb"');
  assert.equal(rStr('a\r\nb'), '"a\\r\\nb"');
  for (const out of [rStr('a\nb'), rStr('a\r\nb')]) {
    assert.ok(!out.includes('\n'), 'the literal must stay on one line');
    assert.ok(!out.includes('\r'), 'the literal must stay on one line');
  }
});

test('rStr escapes the backslash before the quote, not after', () => {
  // Order matters: escaping `"` first and `\` second would double the backslash it just
  // introduced, turning `"` into `\\"` — a closed string followed by stray code.
  assert.equal(rStr('\\"'), '"\\\\\\""');
  const r = rStr('\\');
  assert.equal(r, '"\\\\"', 'a lone backslash must not escape the closing quote');
});

test('rStr coerces rather than throwing on a non-string', () => {
  // Call sites pass value labels straight from the data, which can be numeric or null.
  assert.equal(rStr(42), '"42"');
  assert.equal(rStr(null), '"null"');
});
