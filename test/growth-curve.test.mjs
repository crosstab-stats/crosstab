/**
 * @file growth-curve.test.mjs
 * #141 — latent growth curve modelling, the "start here" half of Mplus parity.
 *
 * It needed no new dependency: lavaan was already in `builtin-sem`, which is also **why it lives
 * there** rather than in the new mixture plugin. lavaan under WebR needs the patch at the top of
 * that file — `parallel::detectCores()` returns NA, which trips lavaan's own option validation —
 * and a second plugin would have meant a second copy of that workaround. One copy, one owner;
 * the alternative is the shape that has already produced a diverged tooltip, a wrong origin label
 * and a double-counted deploy issue in this codebase.
 *
 * The generated R is validated by `spike/validate-mixture-R.R` on local R 4.6.0, which checks what
 * must hold EXACTLY — `z = est/se`, df against the moment count, and every loading being FIXED
 * rather than estimated, which is the whole claim of the model — and separately reports parameter
 * recovery in standard errors. On data generated with a mean intercept of 10 and a slope of 1.5 the
 * estimates land within about 2 SE: that is what correct looks like, not a mismatch, because an
 * estimate is not the parameter that generated it. The fixture below is one such run's output.
 *
 * What is tested here is the wrapper's judgement, which is where a growth-curve GUI earns its
 * keep or misleads:
 *
 *  - **The loadings are fixed and the spacing is stated.** `0, 1, 2, 3` over the variables in the
 *    order given. Unequally spaced waves (baseline, 6 months, 2 years) modelled this way give a
 *    slope per *occasion*, not per unit of time — silently.
 *  - **The slope VARIANCE is the point.** It is what a growth curve adds over a repeated-measures
 *    ANOVA, and when it is not significant the report says so rather than leaving the reader to
 *    notice.
 *  - **Two occasions cannot support the model**, and saying why beats a lavaan error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { growth, manifest } from '../plugins/builtin-sem/index.js';

const rList = (obj) => ({
  names: Object.keys(obj),
  values: Object.values(obj).map((v) => ({ values: Array.isArray(v) ? v : [v] })),
});

/** The output local R 4.6.0 really produced for the simulated four-wave data. */
const FIT = rList({
  ok: true, n: 400,
  mLhs: ['i', 's'], mEst: [9.910809, 1.490624], mSe: [0.1121451, 0.0373407],
  mZ: [88.37484, 39.91955], mP: [0, 0],
  vLhs: ['i', 's', 'i'], vRhs: ['i', 's', 's'],
  vEst: [4.30175099, 0.36200632, -0.08954589],
  vSe: [0.36104917, 0.04500383, 0.09131972],
  vP: [0, 8.881784e-16, 3.268021e-01],
  fitNames: ['chisq', 'df', 'pvalue', 'cfi', 'tli', 'rmsea', 'srmr', 'aic', 'bic'],
  fitVals: [7.810, 5.000, 0.167, 0.998, 0.998, 0.037, 0.016, 6083.130, 6119.053],
});

const WAVES = ['w1', 'w2', 'w3', 'w4'];
const META = [{ name: 'w1', label: 'Baseline' }, { name: 'w2', label: '6 months' },
  { name: 'w3', label: '12 months' }, { name: 'w4', label: '18 months' }];

async function invoke(inputs, result, meta = META) {
  const out = { rCode: '', tables: [], texts: [], errors: [] };
  const app = {
    data: { getVariableMeta: async () => meta },
    webr: { run: async (code) => { out.rCode = code; return { result }; } },
    results: {
      beginAnalysis() {}, endAnalysis() {},
      appendTable: async (t, o) => out.tables.push({ ...t, caption: o?.caption ?? '' }),
      appendText: async (s) => out.texts.push(s),
      appendError: async (s) => out.errors.push(s),
    },
  };
  await growth(app, inputs);
  return out;
}

// =============================================================================
// The model that gets fitted
// =============================================================================

test('the loadings are FIXED — that is what makes the factors an intercept and a slope', async () => {
  const { rCode } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  assert.match(rCode, /"i =~ ", paste\(sprintf\("1\*%s"/, 'the intercept loads 1 on every occasion');
  assert.match(rCode, /"s =~ ", paste\(sprintf\("%d\*%s", tt/, 'the slope loads 0, 1, 2, …');
  assert.match(rCode, /tt <- seq_len\(ncol\(d\)\) - 1/);
  assert.match(rCode, /fit <- growth\(mod, data = d\)/);
});

test('a quadratic term is added only when asked for, and squares the same spacing', async () => {
  const off = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  assert.equal(off.rCode.includes('q =~'), false);
  const on = await invoke({ waves: WAVES, quadratic: 'yes' }, FIT);
  assert.match(on.rCode, /q =~ /);
  assert.match(on.rCode, /tt\^2/);
  assert.match(on.rCode, /fac <- c\("i", "s", "q"\)/, 'and the quadratic is reported too');
});

test('the WebR lavaan patch is in the script, not assumed', async () => {
  // Without it lavaan's option check throws on `parallel::detectCores()` returning NA under WebR.
  const { rCode } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  assert.match(rCode, /ct\.lavaan\.patched/);
  assert.match(rCode, /lav_options_checkinterval/);
});

// =============================================================================
// Guards
// =============================================================================

test('two occasions is explained rather than attempted', async () => {
  const { errors, rCode } = await invoke({ waves: ['w1', 'w2'], quadratic: 'no' }, FIT);
  assert.match(errors[0], /at least three occasions/);
  assert.match(errors[0], /slope and the residuals cannot both be identified/);
  assert.equal(rCode, '', 'R was never called');
});

test('a quadratic needs four occasions', async () => {
  const { errors } = await invoke({ waves: ['w1', 'w2', 'w3'], quadratic: 'yes' }, FIT);
  assert.match(errors[0], /quadratic growth curve needs at least four/);
});

test('a model that did not converge says what to try instead', async () => {
  // Growth models fail on little between-person variation, and "did not converge" alone leaves
  // the user with nowhere to go.
  const { errors, tables } = await invoke({ waves: WAVES, quadratic: 'no' }, rList({ ok: false, n: 0 }));
  assert.match(errors[0], /did not converge/);
  assert.match(errors[0], /repeated-measures ANOVA instead/);
  assert.deepEqual(tables, [], 'and nothing is reported as if it had worked');
});

// =============================================================================
// What it reports
// =============================================================================

test('the occasions and their assumed spacing are stated up front', async () => {
  // The single most likely way to misread a growth curve: waves that are not equally spaced.
  const { texts } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  const head = texts[0];
  // `builtin-sem`'s own label format, which is "Label (name)" — the variable name stays
  // visible because a reader matching output to a codebook needs it.
  assert.match(head, /Baseline \(w1\) → 6 months \(w2\) → 12 months \(w3\) → 18 months \(w4\)/,
    'the user’s own labels, in this plugin’s format');
  assert.match(head, /Modelled at times 0, 1, 2, 3 — equally spaced/);
  assert.match(head, /N = 400/);
});

test('the growth factors are named in words, not as i and s', async () => {
  const { tables } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  const means = tables.find((t) => /Growth factor means/.test(t.caption));
  assert.deepEqual(means.rows.map((r) => r[0]), ['Intercept (starting level)', 'Slope (change per occasion)']);
  assert.equal(means.rows[1][1], '1.491', 'the mean slope');
});

test('variances and the intercept–slope covariance are distinguished', async () => {
  const { tables } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  const v = tables.find((t) => /variances and covariances/.test(t.caption));
  assert.deepEqual(v.rows.map((r) => r[0]), [
    'Variance of intercept (starting level)',
    'Variance of slope (change per occasion)',
    'Covariance i–s',
  ]);
  assert.equal(v.rows[0][1], '4.302');
});

test('fit is reported, because fixed loadings are a strong claim about the shape of change', async () => {
  const { tables } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  const fit = tables.find((t) => /Model fit/.test(t.caption));
  assert.deepEqual(fit.columns, ['χ²', 'df', 'p', 'CFI', 'TLI', 'RMSEA', 'SRMR', 'AIC', 'BIC']);
  assert.deepEqual(fit.rows[0], ['7.81', '5', '0.167', '0.998', '0.998', '0.037', '0.016', '6083.1', '6119.1']);
});

test('the reading is spelled out: mean slope vs slope VARIANCE', async () => {
  const { texts } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  const note = texts.find((t) => /slope variance/.test(t));
  assert.match(note, /adds over a repeated-measures ANOVA/);
  assert.match(note, /Unequally spaced occasions/, 'and the spacing caveat is repeated where it bites');
});

test('a non-significant slope variance is called out, not left to be noticed', async () => {
  // The finding that decides whether the model was worth fitting: if nobody differs in their
  // rate of change, a simpler model says the same thing.
  const flat = rList({
    ...Object.fromEntries(FIT.names.map((n, i) => [n, FIT.values[i].values])),
    vP: [0, 0.42, 0.33],
  });
  const { texts } = await invoke({ waves: WAVES, quadratic: 'no' }, flat);
  assert.ok(texts.some((t) => /slope variance is \*\*not\*\* significant/.test(t)));
  assert.ok(texts.some((t) => /everyone changes at much the same rate/.test(t)));
});

test('a significant slope variance produces no such caveat', async () => {
  const { texts } = await invoke({ waves: WAVES, quadratic: 'no' }, FIT);
  assert.equal(texts.some((t) => /not\*\* significant/.test(t)), false);
});

// =============================================================================
// The menu
// =============================================================================

test('it sits with the other lavaan models, and the wave order is its time axis', () => {
  const item = manifest.menu.find((m) => m.run === 'growth');
  assert.ok(item, 'no growth menu item');
  assert.match(item.label, /Latent growth curve/);
  const waves = item.inputs.find((i) => i.name === 'waves');
  assert.equal(waves.multiple, true);
  assert.deepEqual(waves.types, ['numeric']);
  assert.match(waves.hint, /the order IS the time axis/, 'the one thing a user must know');
  const q = item.inputs.find((i) => i.name === 'quadratic');
  assert.equal(q.kind, 'choice');
  assert.equal(q.default, 'no');
});

test('no R package was added — lavaan was already here', () => {
  assert.deepEqual(manifest.rPackages, ['lavaan']);
});
