/**
 * @file factorial-type3.test.mjs
 * The Factorial ANOVA's sums-of-squares type, and its SPSS block set.
 *
 * It reported **Type I** (sequential) sums of squares while SPSS's UNIANOVA reports
 * **Type III**. On a balanced design that distinction is invisible, which is why it
 * survived; on anything unbalanced — every real survey — it is not. A 2x2 on GSS-shaped
 * data moved a main effect from 641 to 419, so a side-by-side against SPSS would simply
 * have disagreed, with nothing on either output to say why.
 *
 * The arithmetic runs in WebR, which Node cannot host. It is diffed against desktop R by
 * `scripts/validation/factorial-type3.R`: on a balanced design Type III must equal base
 * R's Type I exactly, and on an unbalanced one it is checked against Type III built from
 * its definition — the rise in residual sum of squares when a term's columns alone are
 * dropped from the design matrix, assembled from model.matrix and lm.fit, sharing no
 * code with drop1. What is testable here is the shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../plugins/builtin-anova/index.js', import.meta.url), 'utf8');
const FAC = SRC.slice(SRC.indexOf('export async function factorial'), SRC.indexOf('export async function repeated'));

test('sums of squares are Type III, and the output says which', () => {
  assert.match(FAC, /drop1\(fit, ~ \., test = "F"\)/, 'Type III comes from drop1');
  // drop1 only gives Type III under sum-to-zero contrasts. Without this it silently
  // returns something else that still looks like a plausible ANOVA table.
  assert.match(FAC, /contrasts = c\("contr\.sum", "contr\.poly"\)/);
  assert.match(FAC, /Type III Sum of Squares/, 'and the column is labelled');
  assert.ok(!/Type I \(sequential\)/.test(FAC), 'the old claim must be gone');
});

test('R is handed R, not JSON', () => {
  // JSON.stringify emits ["F1","F2"], which is valid JSON and not valid R — it reached
  // the interpolation as `d[, ["F1","F2"]]` and would have failed at run time on every
  // factorial ANOVA. Found by the validation script, which is the point of having one.
  assert.ok(!FAC.includes('JSON.stringify'), 'no JSON array may be interpolated into R');
  assert.match(FAC, /c\(\$\{tok\.map\(rStr\)\.join\(', '\)\}\)/);
});

test("the SPSS block set is there", () => {
  const caps = [...FAC.matchAll(/caption:\s*`([^`$]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(caps, [
    'Descriptive Statistics — dependent:',
    "Levene's Test of Equality of Error Variances — dependent:",
    'Tests of Between-Subjects Effects — dependent:',
  ]);
});

test('the effects table brackets its terms the way SPSS does', () => {
  for (const row of ['Corrected Model', 'Error', 'Corrected Total']) {
    assert.ok(FAC.includes(`'${row}'`), `${row} should be a row`);
  }
  // The model F comes back from R rather than being assembled here: a p-value needs an
  // incomplete beta, and hand-rolling one next to an R session that has pf() is silly.
  assert.match(FAC, /fModel/);
  assert.match(FAC, /stats::pf\(fModel/);
});

test('Levene uses the same mean-centred variant as the other procedures', () => {
  // Across the design's CELLS rather than one factor, but the same definition — three
  // Levenes in one app that quietly differ is the thing to avoid.
  assert.match(FAC, /abs\(d\$\.y - ave\(d\$\.y, cell, FUN = mean\)\)/);
  assert.match(FAC, /Based on Mean/);
});

test('the footnote names the type and what is left out', () => {
  assert.match(FAC, /\*\*Type III\*\*/);
  assert.match(FAC, /on an unbalanced one they do not/);
  assert.match(FAC, /Intercept row/, 'SPSS prints one and we do not — say so');
});
