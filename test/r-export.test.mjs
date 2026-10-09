/**
 * @file r-export.test.mjs
 * Exporting the history as a runnable R script.
 *
 * The ask, and the reason it is worth more here than the other two dialects (owner,
 * 2026-10-09): *"A lot of faculty are trying to switch to teaching R but they are
 * having trouble with the base language issues. Given CrossTab is R backed … they can
 * load the data, run the analysis, then export the history as R and see what an actual
 * working R script looks like to generate that result."*
 *
 * So the bar is higher than for Stata and SPSS. Those exports assume the dataset is
 * already open in the application; this one is handed to someone who has only the file,
 * and it has to RUN. That is checked for real — `scripts/validation/` has no part in it
 * because the proof is simply executing the output in R, which the development machine
 * can do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptToR, scriptToSpss, scriptFileName } from '../core/script-export.js';

const PREP = [
  'compute agegrp = CASE WHEN age < 30 THEN 1 ELSE 2 END',
  'keep if age > 17',
  'rename agegrp to cohort',
  'set missing conrinc = -99',
].join('\n');

test('the script stands on its own: it reads the data it then edits', () => {
  // SPSS and Stata are handed to someone with the dataset already open. A .R file is
  // handed to someone who has only the file, so the frame has to exist before line one
  // of the preparation touches it.
  const out = scriptToR(PREP).text;
  const load = out.indexOf('read.csv(');
  const firstEdit = out.indexOf('d$cohort');
  assert.ok(load > 0, 'no load line');
  assert.ok(load < out.indexOf('d <- subset'), 'the frame must exist before it is filtered');
  assert.ok(!/open your dataset first/.test(out), 'that instruction belongs to the other dialects');
});

test('a CASE becomes one ifelse, not a statement block', () => {
  // SPSS has no conditional expression so it needs DO IF / ELSE IF / END IF; R does, and
  // writing the SPSS shape in R would be a translation nobody would recognise.
  const out = scriptToR('compute g = CASE WHEN age < 30 THEN 1 ELSE 2 END').text;
  assert.match(out, /d\$g <- with\(d, ifelse\(age < 30, 1, 2\)\)/);
  assert.ok(!/DO IF|END IF/.test(out));
});

test('bare column names work because the renderer is reused, not forked', () => {
  // `with()` and `subset()` evaluate against the frame, so the shared expression
  // renderer needs no R-specific pass — one renderer, three dialects.
  assert.match(scriptToR('keep if age > 17 AND educ < 12').text, /subset\(d, age > 17 & educ < 12\)/);
});

test('R says what it cannot represent instead of pretending', () => {
  const labels = scriptToR('label variable educ "Years of education"').text;
  assert.match(labels, /base R has no variable labels/);
  assert.match(labels, /attr\(d\$educ, "label"\)/);
  const missing = scriptToR('set missing conrinc = -99').text;
  assert.match(missing, /no user-missing tier/, 'converting the codes to NA is destructive — say so');
  assert.match(missing, /d\$conrinc\[d\$conrinc %in% c\(-99\)\] <- NA/);
  const measure = scriptToR('set measure educ = ordinal').text;
  assert.match(measure, /ordered = TRUE/, 'and points at the R equivalent rather than bailing');
});

test('analyses are the idiom a tutor would write', () => {
  const out = scriptToR([
    'run builtin-compare.oneway {"y": "prestg10", "g": "degree"}',
    'run builtin-regression.run {"dv": "conrinc", "ivs": ["educ"]}',
    'run builtin-compare.paired {"x1": "educ", "x2": "paeduc"}',
  ].join('\n')).text;
  assert.match(out, /aov\(prestg10 ~ factor\(degree\), data = d\)/);
  assert.match(out, /TukeyHSD\(fit\)/);
  assert.match(out, /lm\(conrinc ~ educ, data = d\)/);
  assert.match(out, /t\.test\(d\$educ, d\$paeduc, paired = TRUE\)/);
});

test('where we deliberately differ from base R, the script says so', () => {
  // The factorial reports Type III; aov() gives Type I. A student handed this file
  // would otherwise get different numbers from the same data and no way to know why.
  const out = scriptToR('run builtin-anova.factorial {"dv": "y", "facs": ["a", "b"]}').text;
  assert.match(out, /factor\(a\) \* factor\(b\)/, 'the full factorial, not main effects');
  assert.match(out, /Type III/);
  assert.match(out, /car::Anova/);
});

test('a weight is flagged, because R has no global one to turn on', () => {
  const out = scriptToR('run builtin-descriptives.run {"vars": ["age"], "weight": "wtssps"}').text;
  assert.match(out, /R has no global weight/);
  assert.match(out, /survey package/);
});

test('an analysis carrying options the translator does not know is refused, not guessed', () => {
  // The same guard the other dialects have: a silently-different model handed to a
  // student is worse than a comment telling them to run it by hand.
  const out = scriptToR('run builtin-regression.run {"dv": "y", "ivs": ["x"], "robust": true}').text;
  assert.match(out, /not translated/);
  assert.match(out, /robust/);
});

test('the file extension is .R', () => {
  assert.equal(scriptFileName('r'), 'analysis.R');
  assert.equal(scriptFileName('spss'), 'analysis.sps');
  assert.equal(scriptFileName('stata'), 'analysis.do');
});

test('adding R did not disturb the other two dialects', () => {
  const sps = scriptToSpss(PREP).text;
  assert.match(sps, /^COMPUTE /m);
  assert.match(sps, /^SELECT IF /m);
  assert.ok(!/read\.csv/.test(sps), 'the R preamble must not leak into SPSS');
});
