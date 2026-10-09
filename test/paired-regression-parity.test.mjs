/**
 * @file paired-regression-parity.test.mjs
 * The last two blocks of the SPSS-parity sweep.
 *
 * A psychology methods course is comparing seven procedures side by side against SPSS.
 * Two gaps were left after the ANOVAs:
 *
 *   - the paired t-test printed descriptives and the test, but not SPSS's **Paired
 *     Samples Correlations** — which is not decoration, because a paired test is worth
 *     running precisely BECAUSE the two measures are related, and r is what says how
 *     much the pairing bought;
 *   - linear regression folded the model F into its Model Summary row, where SPSS
 *     splits it out as an **ANOVA** table with the sums of squares the F comes from,
 *     and reported no **Std. Error of the Estimate**.
 *
 * The arithmetic runs in WebR; it is diffed against desktop R by
 * `scripts/validation/paired-and-regression.R` — against cor.test, summary.lm and
 * anova, and the weighted correlation against CASE EXPANSION, which is the standard
 * this project already holds its weighted statistics to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CMP = await readFile(new URL('../plugins/builtin-compare/index.js', import.meta.url), 'utf8');
const REG = await readFile(new URL('../plugins/builtin-regression/index.js', import.meta.url), 'utf8');
const PAIRED = CMP.slice(CMP.indexOf('export async function paired'), CMP.indexOf('// --- One-way ANOVA'));

test('the paired t-test reports the correlation between the two measures', () => {
  const caps = [...PAIRED.matchAll(/caption:\s*`([^`$]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(caps, ['Paired Statistics', 'Paired Samples Correlations', 'Paired-Samples t-Test —'],
    "SPSS's order: descriptives, correlation, then the test");
  assert.ok(PAIRED.includes("'Correlation'") && PAIRED.includes("'Sig.'"));
});

test('the paired correlation honours the weight', () => {
  // R's cov() takes no frequency weights, so this one is hand-rolled and has to use the
  // same weighted means the rest of the test uses — not a plain cov() on the side.
  assert.match(PAIRED, /sum\(w \* \(x1 - wmean\(x1, w\)\) \* \(x2 - wmean\(x2, w\)\)\) \/ \(n - 1\)/);
  assert.match(PAIRED, /if \(all\(w == 1\)\) stats::cov\(x1, x2\)/, 'and falls through to R at w = 1');
});

test('a degenerate pair reports no correlation rather than a NaN', () => {
  // Zero variance in either measure, or |r| = 1, leaves the t undefined.
  assert.match(PAIRED, /if \(v1 > 0 && v2 > 0\)/);
  assert.match(PAIRED, /abs\(rPair\) >= 1 \|\| n <= 2/);
  assert.match(PAIRED, /if \(Number\.isFinite\(r\.n1\('rPair'\)\)\)/, 'and the table is gated in JS too');
});

test('regression splits Model Summary from the ANOVA table, as SPSS does', () => {
  const caps = [...REG.matchAll(/caption:\s*`([^`$]*)/g)].map((m) => m[1].trim());
  assert.ok(caps.some((c) => c.startsWith('Model Summary')), 'the fit');
  assert.ok(caps.some((c) => c.startsWith('ANOVA')), 'and the test of it');
  assert.ok(caps.indexOf(caps.find((c) => c.startsWith('Model Summary')))
    < caps.indexOf(caps.find((c) => c.startsWith('ANOVA'))), 'summary first');
  for (const row of ['Regression', 'Residual', 'Total']) {
    assert.ok(REG.includes(`'${row}'`), `${row} should be a row in the ANOVA table`);
  }
});

test('Model Summary carries the Std. Error of the Estimate', () => {
  assert.ok(REG.includes("'Std. Error of the Estimate'"));
  assert.match(REG, /sigma = s\$sigma/, 'taken from summary.lm, not recomputed');
  // The F moved out of this row; leaving it in both places would be two sources for one
  // number, which is how they come to disagree.
  const summaryCols = /columns: \['R', 'R Square', 'Adj\. R Square', ([^\]]*)\]/.exec(REG);
  assert.ok(summaryCols, 'the Model Summary columns should still be findable');
  assert.ok(!summaryCols[1].includes("'F'"), 'F belongs to the ANOVA table now');
});
