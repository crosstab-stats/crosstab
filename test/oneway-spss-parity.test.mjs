/**
 * @file oneway-spss-parity.test.mjs
 * The One-Way ANOVA's output blocks, and the order they come in.
 *
 * A psychology methods course runs seven procedures side by side against SPSS, and the
 * one-way was the one that did not line up (owner, 2026-10-08): SPSS printed an *ANOVA
 * Effect Sizes* table we answered with a sentence, and we printed a Tukey table SPSS
 * only prints when Post Hoc is ticked. Two blocks were missing outright — the
 * homogeneity test and the robust tests — which is the part that mattered, because
 * Levene is what tells a student which row to read and we printed it for the *t-test*
 * and not for the procedure where the choice actually arises.
 *
 * The arithmetic cannot be tested here: it runs in WebR, which Node has no host for.
 * It is diffed against desktop R instead — `scripts/validation/oneway-spss-parity.R`,
 * which runs the EXACT R this plugin emits (captured by `oneway-emit-r.py`) against
 * `oneway.test`, an independently built Levene, and the SS from `aov`. All of it
 * matched to 1e-9 on three designs plus controls. What IS testable here is the shape:
 * that every block is still emitted, and in SPSS's order, so a later edit cannot
 * quietly drop one or shuffle them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../plugins/builtin-compare/index.js', import.meta.url), 'utf8');
const ONEWAY = SRC.slice(SRC.indexOf('export async function oneway'), SRC.indexOf('// --- helpers'));

/** The captions this procedure emits, in the order it emits them. */
const captions = () => [...ONEWAY.matchAll(/caption:\s*`([^`$]*)/g)].map((m) => m[1].trim());

test("the output follows SPSS's block order", () => {
  // Descriptives, homogeneity, ANOVA, effect sizes, robust tests, post-hoc. Reading two
  // outputs side by side is the whole task, and a different order makes that manual.
  assert.deepEqual(captions(), [
    'Descriptives —',
    'Test of Homogeneity of Variances —',
    'ANOVA',
    'ANOVA Effect Sizes',
    'Robust Tests of Equality of Means —',
    'Multiple Comparisons —',
  ]);
});

test('the post-hoc table names its groups, and carries the SPSS columns', () => {
  // It printed "1-0" and "4-3" — the raw factor codes — in the same output where the
  // Descriptives table above it said "less than high school". R has the levels and the
  // host has the value labels, so pasting the two sides together in R was the bug: the
  // sides come back separately now and the host labels each one.
  assert.ok(!/paste0\(lvs\[b\], "-", lvs\[a\]\)/.test(ONEWAY), 'R must not paste the pair itself');
  assert.match(ONEWAY, /tukI <- c\(tukI, lvs\[b\]\); tukJ <- c\(tukJ, lvs\[a\]\)/);
  assert.ok(ONEWAY.includes('valueLabel(meta, gName, a)'), 'the (I) side is labelled');
  assert.ok(ONEWAY.includes('valueLabel(meta, gName, tukJ[i])'), 'and the (J) side');
  // Std. Error was computed for the interval already and simply not shown.
  assert.match(ONEWAY, /tukSE/);
  assert.ok(ONEWAY.includes("'Std. Error'"));
  // SPSS's star on the difference, and the footnote that explains it.
  assert.match(ONEWAY, /tp\[i\] < 0\.05 \? '\*' : ''/);
  assert.match(ONEWAY, /significant at the 0\.05 level/);
  // And the honest note about why there are half as many rows.
  assert.match(ONEWAY, /SPSS lists every pair twice/);
});

test('the effect sizes are a TABLE, and there are three of them', () => {
  // η² alone, printed as prose, is what the comparison tripped over. η² is biased
  // upward; ε² and ω² are the ones to quote, and SPSS prints all three.
  for (const name of ['Eta-squared', 'Epsilon-squared', 'Omega-squared']) {
    assert.ok(ONEWAY.includes(`'${name}`), `${name} should be a row in the effect-size table`);
  }
  assert.ok(!/appendText\(`Effect size/.test(ONEWAY), 'and not a sentence under the ANOVA');
  for (const key of ['eta2', 'eps2', 'om2']) {
    assert.ok(ONEWAY.includes(`${key} =`), `${key} must be computed in R, not derived in JS`);
  }
});

test("Levene is mean-centred, the same variant the t-test above reports", () => {
  // Two Levenes in one app that differ without saying so is the thing to avoid. The
  // t-test's is mean-centred because that is what SPSS's T-TEST prints; this one has to
  // match it, and the footnote has to name the median-centred variant in the
  // Assumptions plugin so the two numbers are explained rather than merely different.
  assert.match(ONEWAY, /abs\(y - gm\[as\.character\(g\)\]\)/, 'deviation from the group MEAN');
  assert.match(ONEWAY, /median-centred/, 'and the other variant is named');
  assert.match(ONEWAY, /Based on Mean/, 'labelled as SPSS labels its first row');
});

test('the robust tests are there for when Levene says the variances differ', () => {
  // Without these, a significant Levene leaves a student with nothing to read instead,
  // which is worse than not printing Levene at all.
  for (const name of ['Welch', 'Brown-Forsythe']) {
    assert.ok(ONEWAY.includes(`'${name}'`), `${name} should be a row in the robust table`);
  }
  assert.match(ONEWAY, /welDf2/, 'with its own Satterthwaite denominator df');
  assert.match(ONEWAY, /bfDf2/);
});

test('a degenerate group yields no robust row rather than a number nobody can reproduce', () => {
  // Welch weights are n/variance, so a constant group makes them infinite. Guarded in R
  // and gated in JS — both halves, or an Infinity reaches the table.
  assert.match(ONEWAY, /robust_ok <- all\(is\.finite\(gv\)\) && all\(gv > 0\) && all\(gn > 1\)/);
  assert.match(ONEWAY, /if \(Number\.isFinite\(r\.n1\('welF'\)\)\)/);
  assert.match(ONEWAY, /if \(Number\.isFinite\(r\.n1\('levF'\)\)\)/);
});

test('the footnote says what to read, and where we stop short of SPSS', () => {
  // The honest half: SPSS prints confidence intervals on the effect sizes and a
  // random-effects ω², and we do not. Saying so is better than a reader assuming the
  // columns were lost.
  assert.match(ONEWAY, /read \*\*Welch\*\* instead/);
  assert.match(ONEWAY, /confidence intervals/);
  assert.match(ONEWAY, /point estimates only/);
});
