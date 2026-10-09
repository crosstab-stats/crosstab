/**
 * @file sphericity.test.mjs
 * The repeated-measures ANOVA's sphericity output.
 *
 * It printed an F and then a sentence saying "Sphericity is assumed (no
 * Greenhouse-Geisser correction)" — which is the assumption the design stands on,
 * stated rather than tested. With three or more conditions that F is only valid if the
 * variances of all the pairwise differences are equal, and a research-methods course
 * spends the lesson on exactly that; `builtin-mixedanova` had the correction, but this
 * is the one sitting in the Comparison menu beside the other tests.
 *
 * The arithmetic runs in WebR, which Node cannot host, so it is diffed against desktop R
 * by `scripts/validation/sphericity-reference.R` — 27 checks against `mauchly.test` and
 * `anova.mlm`, including the two epsilons, which base R computes and then exposes only
 * inside its printed heading. What is testable here is the shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../plugins/builtin-anova/index.js', import.meta.url), 'utf8');
const REP = SRC.slice(SRC.indexOf('export async function repeated'), SRC.indexOf('// --- helpers'));

test('sphericity is tested, not assumed', () => {
  assert.ok(!/Sphericity is assumed \(no Greenhouse/.test(REP), 'the old claim must be gone');
  assert.match(REP, /mauchly\.test/, 'W comes from base R, not from a hand-rolled determinant');
  assert.match(REP, /test = "Spherical"/, 'and the corrected p-values from anova.mlm');
});

test('the within-subjects table has SPSS\'s four rows', () => {
  for (const row of ['Sphericity Assumed', 'Greenhouse-Geisser', 'Huynh-Feldt', 'Lower-bound']) {
    assert.ok(REP.includes(`'${row}'`), `${row} should be a row`);
  }
  // The correction changes the df, not the F — that is the whole idea, and a table that
  // recomputed F would be describing a different test.
  assert.match(REP, /dfCond \* eps/, 'df is multiplied by epsilon');
  assert.match(REP, /ssCond \/ \(dfCond \* eps\)/, 'and the mean square follows from it');
});

test('the Huynh-Feldt epsilon is capped at 1', () => {
  // The raw estimate can exceed 1 — base R prints 1.032 on one of the validation cases.
  // Above 1 it is meaningless as a df multiplier; SPSS caps it, and so must this.
  assert.match(REP, /hfE <- min\(1,/);
});

test('two conditions get no test rather than a vacuous one', () => {
  // With one difference there is nothing for sphericity to be violated between, and
  // Mauchly's W is 1 by construction. Reporting it would be reporting an arithmetic
  // identity as a finding.
  assert.match(REP, /if \(k > 2 && n > k\)/);
  assert.ok(REP.includes('sphericity cannot be'), 'and says so instead');
});

test('the footnote tells the reader which row to use', () => {
  assert.match(REP, /read the \*\*Sphericity Assumed\*\* row/);
  assert.match(REP, /\*\*Greenhouse-Geisser\*\*/);
  // "Harder to clear" is a claim about the critical value, which is the only thing that
  // moves monotonically — the p-value can fall when F is near 1. The validation script
  // checks the cut-off for exactly this reason.
  assert.match(REP, /harder to clear/);
});
