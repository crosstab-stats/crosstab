/**
 * @file mixture-models.test.mjs
 * #141 — latent class and latent profile analysis, the Mplus mixture-model gap.
 *
 * **Feasibility was settled by reading WebR's own binary repo index, not by trial.** For R 4.6:
 * `poLCA` has a dependency closure of three (poLCA, scatterplot3d, MASS) and `flexmix` of four
 * (flexmix, lattice, modeltools, nnet) — nowhere near the shared-object ceiling that makes bigger
 * packages fail. `mclust` is **not built for WebR at all**, which is why LPA runs on a flexmix
 * Gaussian mixture and why `tidyLPA` (closure 115, needing mclust) was never an option.
 *
 * The R itself is validated by `spike/validate-mixture-R.R` against local R 4.6.0. That script
 * separates two things this header used to run together: **exact identities** (BIC against
 * `-2logL + npar·log n`, posterior rows summing to 1, the modal class being the posterior's
 * argmax) which cannot pass by luck, and **recovery within sampling error**, reported in standard
 * errors. An estimate from 600 sampled cases is never equal to the parameter that generated them:
 * everything lands within a couple of SE, which is what correct looks like. What the simulation
 * establishes is that the WIRING is right, since a wrong field gives nonsense rather than a near
 * miss — poLCA and flexmix do the estimating.
 *
 * One result from that run is load-bearing for the code here: on the LPA data **AIC preferred
 * k = 3 over the true k = 2 while BIC got it right**, which is why the comparison table ships with
 * the rule for reading it instead of leaving the user to pick a column.
 *
 * What is tested HERE is everything around that, in two groups:
 *
 *  1. **The R that gets generated**, because three of its properties are load-bearing and each
 *     would fail quietly: poLCA refuses anything not coded 1…K, the formula has to survive a
 *     variable named `Q1 (wave 1)`, and the seed has to be in the script or the same analysis
 *     replays to a different answer.
 *  2. **The reporting**, because choosing the number of classes IS the analysis, and a table of
 *     fit statistics with no rule for reading it is where users go wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gmm, lca, lpa, manifest } from '../plugins/builtin-mixture/index.js';

/** An R list in the shape webR hands back. */
const rList = (obj) => ({
  names: Object.keys(obj),
  values: Object.values(obj).map((v) => ({ values: Array.isArray(v) ? v : [v] })),
});

/** Drive a tool with R stubbed; collect the generated code and everything appended. */
async function invoke(fn, inputs, result, opts = {}) {
  const out = { rCode: '', tables: [], texts: [], errors: [], created: [] };
  const app = {
    data: {
      getVariableMeta: async () => opts.meta ?? [],
      getColumns: async () => opts.columns ?? {},
      create: async (d) => { out.created.push(d); },
    },
    webr: { run: async (code) => { out.rCode = code; return { result }; } },
    results: {
      beginAnalysis() {}, endAnalysis() {},
      appendTable: async (t, o) => out.tables.push({ ...t, caption: o?.caption ?? '' }),
      appendText: async (s) => out.texts.push(s),
      appendError: async (s) => out.errors.push(s),
    },
  };
  await fn(app, inputs);
  return out;
}

/** The LCA result poLCA really produced on 600 simulated cases (two true classes). */
const LCA_RESULT = rList({
  k: 3, n: 600,
  cmpK: [1, 2, 3], cmpNpar: [4, 9, 14],
  cmpAic: [3174.364, 2613.862, 2622.903], cmpBic: [3191.951, 2653.434, 2684.460],
  cmpG2: [560.5, 0.93, 0.5], cmpDf: [11, 6, 1],
  cmpEnt: [NaN, 0.883, 0.894], cmpSmall: [1, 0.317, 0.063],
  share: [0.632, 0.305, 0.063],
  pItem: ['q1', 'q1', 'q2', 'q2', 'q1', 'q1', 'q2', 'q2', 'q1', 'q1', 'q2', 'q2'],
  pClass: [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3],
  pCat: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2],
  pVal: [0.09, 0.91, 0.14, 0.86, 0.86, 0.14, 0.80, 0.20, 0.5, 0.5, 0.4, 0.6],
  mapItem: ['q1', 'q1', 'q2', 'q2'], mapCode: ['0', '1', '0', '1'], mapRank: [1, 2, 1, 2],
  assign: [1, 1, 2, 3], maxPost: [0.99, 0.98, 0.95, 0.6],
});

/** The LPA result flexmix really produced on 500 simulated cases (two true profiles). */
const LPA_RESULT = rList({
  k: 3, n: 500,
  cmpK: [1, 2, 3], cmpNpar: [6, 13, 20],
  cmpAic: [5949.869, 4880.346, 4878.505], cmpBic: [5975.157, 4935.136, 4962.797],
  cmpLL: [-2968.935, -2427.173, -2419.252],
  cmpEnt: [NaN, 0.986, 0.839], cmpSmall: [1, 0.401, 0.177],
  share: [0.177, 0.224, 0.599],
  cenVals: [2.20, 2.53, 3.24, 3.36, 2.68, 3.54, 0.01, 0.08, -0.11],
  cenItem: ['anx', 'dep', 'som', 'anx', 'dep', 'som', 'anx', 'dep', 'som'],
  cenClass: [1, 1, 1, 2, 2, 2, 3, 3, 3],
  assign: [3, 3, 1, 2], maxPost: [0.99, 0.97, 0.8, 0.7],
});

/** LCA_RESULT with some columns replaced — for the cases the real run did not happen to show. */
function withCmp(over) {
  const base = Object.fromEntries(LCA_RESULT.names.map((n, i) => [n, LCA_RESULT.values[i].values]));
  return rList({ ...base, ...over });
}

const LCA_IN = { items: ['q1', 'q2', 'q3', 'q4'], classes: 3, seed: 12345, save: 'no' };
const LPA_IN = { items: ['anx', 'dep', 'som'], classes: 3, seed: 12345, save: 'no' };

// =============================================================================
// The R that gets generated
// =============================================================================

test('poLCA is handed categories recoded to 1…K, because it refuses anything else', () => {
  // The trap that would have shown up as "Error in poLCA" on the most ordinary data there is:
  // 0/1 items. Recoding by RANK also handles 1/5 scales and arbitrary codes.
  return invoke(lca, LCA_IN, LCA_RESULT).then(({ rCode }) => {
    assert.match(rCode, /lv <- sort\(unique\(v\[!is\.na\(v\)\]\)\)/);
    assert.match(rCode, /d\[\[j\]\] <- match\(v, lv\)/, 'the recode itself');
    assert.match(rCode, /maps\[\[nm\[j\]\]\] <- as\.character\(lv\)/, 'and the mapping is kept, to print');
  });
});

test('the model formula uses safe symbols, so an awkward variable name cannot break it', async () => {
  // `Q1 (wave 1)` is a legal CrossTab variable name and an illegal R symbol. poLCA needs a
  // formula, so the columns are renamed for the model and reported under their real names.
  const { rCode } = await invoke(lca, LCA_IN, LCA_RESULT);
  assert.match(rCode, /names\(d\) <- paste0\("v", seq_along\(d\)\)/);
  assert.match(rCode, /paste\(vv, collapse = ","\)/, 'the formula is built from the safe names');
  assert.equal(/cbind\(",\s*paste\(nm/.test(rCode), false, 'never from the raw ones');
});

test('the seed is written into the script, for both engines', async () => {
  // Random starts mean an unseeded mixture model replays to a different answer, which a
  // recorded, re-runnable log cannot live with.
  for (const [fn, inputs, result] of [[lca, LCA_IN, LCA_RESULT], [lpa, LPA_IN, LPA_RESULT]]) {
    const { rCode } = await invoke(fn, { ...inputs, seed: 4242 }, result);
    assert.match(rCode, /set\.seed\(4242\)/);
  }
});

test('a non-integer or absent seed still produces a seeded script', async () => {
  for (const seed of [undefined, null, 'abc', 7.9]) {
    const { rCode } = await invoke(lca, { ...LCA_IN, seed }, LCA_RESULT);
    assert.match(rCode, /set\.seed\(\d+\)/, `no seed for ${JSON.stringify(seed)}`);
  }
});

test('every k from 1 up is fitted, not only the one asked for', async () => {
  // Choosing the number of classes IS the analysis; a tool that fits one k answers a question
  // the user cannot yet ask.
  const { rCode } = await invoke(lca, { ...LCA_IN, classes: 4 }, LCA_RESULT);
  assert.match(rCode, /for \(k in 1:4\)/);
  const lp = await invoke(lpa, { ...LPA_IN, classes: 5 }, LPA_RESULT);
  assert.match(lp.rCode, /for \(k in 1:5\)/);
});

test('a k outside 1…10 is clamped rather than obeyed', async () => {
  // 40 classes is not a typology, and each k refits from every random start.
  for (const [asked, used] of [[0, 1], [-3, 1], [40, 10], [11, 10]]) {
    const { rCode } = await invoke(lca, { ...LCA_IN, classes: asked }, LCA_RESULT);
    assert.match(rCode, new RegExp(`for \\(k in 1:${used}\\)`), `classes=${asked}`);
  }
});

test('LPA uses a diagonal Gaussian mixture, on complete cases', async () => {
  // Diagonal is the LPA specification: indicators independent WITHIN a profile, because their
  // correlation is what the profiles are there to explain.
  const { rCode } = await invoke(lpa, LPA_IN, LPA_RESULT);
  assert.match(rCode, /FLXMCmvnorm\(diagonal = TRUE\)/);
  assert.match(rCode, /stats::complete\.cases/);
  assert.equal(rCode.includes('mclust'), false, 'mclust is not available for WebR');
});

test('a fit that fails is skipped, not fatal', async () => {
  // Mixture models fail to converge routinely at higher k. Losing the whole analysis because
  // k = 6 failed would throw away the k = 2 and 3 the user needed.
  for (const [fn, inputs, result] of [[lca, LCA_IN, LCA_RESULT], [lpa, LPA_IN, LPA_RESULT]]) {
    const { rCode } = await invoke(fn, inputs, result);
    assert.match(rCode, /try\(/);
    assert.match(rCode, /inherits\(fit, "try-error"\).*\) next/);
    assert.match(rCode, /if \(!length\(rows\)\) stop\("no model converged"\)/);
  }
});

// =============================================================================
// Guards
// =============================================================================

test('too few indicators is explained, not attempted', async () => {
  const two = await invoke(lca, { ...LCA_IN, items: ['q1', 'q2'] }, LCA_RESULT);
  assert.match(two.errors[0], /at least three indicators/);
  assert.equal(two.rCode, '', 'R was never called');
  const one = await invoke(lpa, { ...LPA_IN, items: ['anx'] }, LPA_RESULT);
  assert.match(one.errors[0], /at least two indicators/);
});

// =============================================================================
// Reporting — the rule for reading the comparison table
// =============================================================================

test('the comparison table carries every k, with the statistics that decide between them', async () => {
  const { tables } = await invoke(lca, LCA_IN, LCA_RESULT);
  const cmp = tables.find((t) => /Choosing the number/.test(t.caption));
  assert.ok(cmp, 'no comparison table');
  assert.deepEqual(cmp.rows.map((r) => r[0]), ['1', '2', '3']);
  for (const col of ['AIC', 'BIC', 'Entropy']) {
    assert.ok(cmp.columns.some((c) => c.includes(col)), `no ${col} column`);
  }
  assert.ok(cmp.columns.some((c) => /Smallest/.test(c)));
});

test('the BIC minimum is named, because that is the measure to trust here', async () => {
  // The LPA fixture is the real demonstration: AIC prefers k = 3, BIC prefers the true k = 2.
  const { texts } = await invoke(lpa, LPA_IN, LPA_RESULT);
  const guide = texts.find((t) => /Lower BIC/.test(t));
  assert.ok(guide, 'no reading guide');
  assert.match(guide, /lowest at 2 profiles/);
});

test('a class holding under 5% of cases is called out', async () => {
  // Not a finding: usually the model fitting a handful of unusual cases.
  const tiny = withCmp({ cmpSmall: [1, 0.317, 0.031] });
  const { texts } = await invoke(lca, LCA_IN, tiny);
  const guide = texts.find((t) => /under 5%/.test(t));
  assert.ok(guide, 'the tiny-class warning is missing');
  assert.match(guide, /at k = 3 the smallest is that small/);
});

test('the threshold is 5%, not "anything smallish"', async () => {
  // The real 600-case run produced a 6.3% third class, which is small and not a red flag. A
  // warning that fired there would fire on most three-class solutions.
  const { texts } = await invoke(lca, LCA_IN, LCA_RESULT);
  assert.equal(texts.some((t) => /under 5%/.test(t)), false, 'LCA_RESULT’s smallest class is 6.3%');
});

test('no tiny class means no warning about one', async () => {
  const { texts } = await invoke(lca, LCA_IN, withCmp({ cmpSmall: [1, 0.317, 0.30] }));
  assert.equal(texts.some((t) => /under 5%/.test(t)), false);
});

test('when BIC prefers another k, the report says how to see that solution', async () => {
  // The detail is for the k the user asked for — choosing for them would contradict "the
  // statistics do not decide" in the same paragraph — so the way to the other one is spelled out.
  const { texts } = await invoke(lca, LCA_IN, LCA_RESULT);
  const guide = texts.find((t) => /detail below is for/.test(t));
  assert.ok(guide, 'the loop is left open');
  assert.match(guide, /\*\*3 classes\*\*/);
  assert.match(guide, /Re-run with 2/);
});

test('the statistics are explicitly not the whole answer', async () => {
  const { texts } = await invoke(lca, LCA_IN, LCA_RESULT);
  assert.ok(texts.some((t) => /statistics do not decide/.test(t)));
  assert.ok(texts.some((t) => /Entropy says how cleanly/.test(t)));
});

test('the seed is reported with the results, not just used', async () => {
  const { texts } = await invoke(lca, { ...LCA_IN, seed: 909 }, LCA_RESULT);
  assert.ok(texts.some((t) => /Random seed 909/.test(t)), 'an unreported seed is an unreproducible result');
});

// =============================================================================
// Reporting — what each class IS
// =============================================================================

test('the recoding is printed in the user’s own value labels', async () => {
  // A class profile that says "category 2" is unreadable; one that says "Yes" is the finding.
  const meta = [{ name: 'q1', label: 'Needs help bathing', valueLabels: { 0: 'No', 1: 'Yes' } }, { name: 'q2' }];
  const { tables } = await invoke(lca, LCA_IN, LCA_RESULT, { meta });
  const map = tables.find((t) => /How each indicator was coded/.test(t.caption));
  assert.ok(map);
  assert.deepEqual(map.rows[0], ['Needs help bathing', '1 = No, 2 = Yes']);
});

test('item-response probabilities are laid out one class per column', async () => {
  const meta = [{ name: 'q1', label: 'Bathing', valueLabels: { 0: 'No', 1: 'Yes' } }];
  const { tables } = await invoke(lca, LCA_IN, LCA_RESULT, { meta });
  const probs = tables.find((t) => /Probability of each answer/.test(t.caption));
  assert.deepEqual(probs.columns, ['', 'Class 1', 'Class 2', 'Class 3']);
  // q1 = Yes is category 2: .91 in class 1, .14 in class 2, .50 in class 3.
  const yes = probs.rows.find((r) => r[0] === 'Bathing = Yes');
  assert.deepEqual(yes.slice(1), ['0.910', '0.140', '0.500']);
});

test('profile means are reported per indicator, in the indicators’ own units', async () => {
  const { tables, texts } = await invoke(lpa, LPA_IN, LPA_RESULT);
  const cen = tables.find((t) => /Mean of each indicator/.test(t.caption));
  assert.deepEqual(cen.columns, ['', 'Profile 1', 'Profile 2', 'Profile 3']);
  assert.deepEqual(cen.rows.find((r) => r[0] === 'anx').slice(1), ['2.200', '3.360', '0.010']);
  // And the scale caveat, which is the way an LPA is most often quietly wrong.
  assert.ok(texts.some((t) => /very different scales/.test(t)));
});

test('class sizes report both the share and the modal count', async () => {
  const { tables } = await invoke(lca, LCA_IN, LCA_RESULT);
  const sizes = tables.find((t) => /Class sizes/.test(t.caption));
  assert.deepEqual(sizes.rows.map((r) => r[0]), ['Class 1', 'Class 2', 'Class 3']);
  assert.equal(sizes.rows[0][1], '63.2%');
  assert.equal(sizes.rows[0][2], '2', 'two of the four fixture cases are in class 1');
});

// =============================================================================
// Saving class membership
// =============================================================================

test('saving membership writes a new dataset, leaving the original alone', async () => {
  // The Mplus SAVEDATA equivalent, and the reason anyone fits these models: assign people to
  // classes, then analyse the classes. A plugin cannot add a column to a live dataset.
  const columns = { age: [70, 71, 72, 73], sex: ['f', 'm', 'f', 'm'] };
  const { created, texts } = await invoke(lca, { ...LCA_IN, save: 'yes' }, LCA_RESULT, { columns });
  assert.equal(created.length, 1);
  const d = created[0];
  assert.deepEqual(Object.keys(d.columns), ['age', 'sex', 'latent_class', 'latent_class_prob']);
  assert.deepEqual(d.columns.latent_class, ['1', '1', '2', '3'], 'the modal class, as a category');
  assert.deepEqual(d.columns.latent_class_prob, [0.99, 0.98, 0.95, 0.6]);
  assert.equal(d.variables.at(-2).measurementLevel, 'nominal');
  assert.ok(texts.some((t) => /original data is unchanged/.test(t)));
  assert.ok(texts.some((t) => /low probability sit between/.test(t)), 'uncertain cases are flagged');
});

test('a misaligned save is refused with the reason, not written', async () => {
  // The model drops incomplete cases, so its vectors can be shorter than the dataset. Writing
  // that column anyway would silently attach every class to the wrong row.
  const columns = { age: [70, 71, 72, 73, 74, 75] }; // 6 rows, 4 classified
  const { created, texts } = await invoke(lca, { ...LCA_IN, save: 'yes' }, LCA_RESULT, { columns });
  assert.deepEqual(created, [], 'nothing may be written');
  const why = texts.find((t) => /was not saved/.test(t));
  assert.ok(why);
  assert.match(why, /4 complete cases out of 6 rows/);
  assert.match(why, /Filter or impute/, 'and what to do about it');
});

test('not asking to save writes nothing', async () => {
  const { created } = await invoke(lca, LCA_IN, LCA_RESULT, { columns: { age: [1, 2, 3, 4] } });
  assert.deepEqual(created, []);
});

// =============================================================================
// The manifest
// =============================================================================

test('only the two packages that were verified are declared', () => {
  // The offline cache pre-fetches every enabled plugin's R packages, so a speculative entry is a
  // download every user pays for — and `mclust` would never arrive at all.
  assert.deepEqual(manifest.rPackages, ['poLCA', 'flexmix']);
});

test('all three tools are on the menu with the inputs they need', () => {
  const byRun = Object.fromEntries(manifest.menu.map((m) => [m.run, m]));
  assert.deepEqual(Object.keys(byRun).sort(), ['gmm', 'lca', 'lpa']);
  // The same four questions in the same order everywhere — a user who has run one has learnt
  // all three. Only the FIRST input's name differs, because a growth mixture's indicators are
  // occasions of one measure rather than separate measures.
  for (const [run, first] of [['lca', 'items'], ['lpa', 'items'], ['gmm', 'waves']]) {
    const names = byRun[run].inputs.map((i) => i.name);
    assert.deepEqual(names, [first, 'classes', 'seed', 'save'], `${run} inputs`);
    assert.equal(byRun[run].inputs.find((i) => i.name === 'seed').default, 12345, 'a default seed');
    assert.ok(byRun[run].inputs.every((i) => i.hint), `${run} has an unhinted input`);
  }
  // LCA takes categorical indicators, so it must NOT filter the picker to numeric.
  assert.equal(byRun.lca.inputs[0].types, undefined);
  assert.deepEqual(byRun.lpa.inputs[0].types, ['numeric']);
  assert.deepEqual(byRun.gmm.inputs[0].types, ['numeric']);
  // The order the menu reads in: indicators, then profiles, then trajectories.
  assert.deepEqual(manifest.menu.map((m) => m.order), [60, 61, 62]);
});

test('it is findable by the words someone leaving Mplus would type', () => {
  for (const term of ['latent class', 'lca', 'latent profile', 'lpa', 'mplus', 'mixture model']) {
    assert.ok(manifest.keywords.includes(term), `not searchable: ${term}`);
  }
  assert.match(manifest.howto, /run builtin-mixture\.lca/);
  assert.match(manifest.howto, /run builtin-mixture\.lpa/);
  assert.ok(manifest.disciplines.includes('Gerontology'), 'the faculty who asked for it');
});

// =============================================================================
// Growth mixture models — classes of TRAJECTORY
// =============================================================================

/**
 * The last Mplus headline model, and the engine choice is the interesting part. `lcmm` is the
 * specialist package and a 14-package dependency closure; `flexmix` was already here for LPA
 * (closure of four) and ships `FLXMRlmm`, a mixture of linear MIXED models — classes of
 * trajectory with a random intercept within each class, which is the model. So a growth mixture
 * added **no new R package at all**, which matters because the offline cache pre-fetches the
 * packages of every enabled plugin.
 *
 * The fixture is a real run against local R on two simulated trajectory groups (150 rising at
 * +1.5 per occasion, 100 flat at −0.2), and it happens to illustrate the model's own hazard: BIC
 * picks the true k = 2, while k = 3 splits off a 4.45% class that is an artefact.
 */
const GMM_RESULT = rList({
  k: 3, n: 250, nOcc: 5, nDropped: 0,
  cmpK: [1, 2, 3], cmpNpar: [4, 9, 14],
  cmpAic: [5241.938, 4056.427, 4056.606],
  cmpBic: [5262.461, 4102.605, 4128.438],
  cmpLL: [-2616.969, -2019.213, -2014.303],
  cmpEnt: [NaN, 0.9969, 0.9307], cmpSmall: [1, 0.4009, 0.0445],
  share: [0.5554, 0.4001, 0.0445],
  // Repeated per class, parallel to parVals/parClass — the bug this fixture caught was a bare
  // four-entry rownames() against twelve values, which left every class but the first blank.
  parNames: [
    'coef.(Intercept)', 'coef.time', 'sigma2.Random', 'sigma2.Residual',
    'coef.(Intercept)', 'coef.time', 'sigma2.Random', 'sigma2.Residual',
    'coef.(Intercept)', 'coef.time', 'sigma2.Random', 'sigma2.Residual',
  ],
  parVals: [9.6436, 1.5524, 1.7544, 0.6406, 9.8655, -0.224, 1.245, 0.6786, 11.1881, 0.9802, 1.6754, 0.596],
  parClass: [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3],
  assign: [1, 1, 2, 3], maxPost: [0.9736, 0.994, 0.9996, 0.9735],
});
const GMM_IN = { waves: ['t1', 't2', 't3', 't4', 't5'], classes: 3, seed: 12345, save: 'no' };
const WAVE_META = [{ name: 't1', label: 'Baseline' }, { name: 't2', label: 'Year 1' },
  { name: 't3', label: 'Year 2' }, { name: 't4', label: 'Year 3' }, { name: 't5', label: 'Year 4' }];

/** GMM_RESULT with some fields replaced. */
function withGmm(over) {
  const base = Object.fromEntries(GMM_RESULT.names.map((n, i) => [n, GMM_RESULT.values[i].values]));
  return rList({ ...base, ...over });
}

test('a growth mixture takes WIDE data and reshapes it, so both growth tools ask the same thing', async () => {
  // A mixed model needs one row per person-occasion; the data users have — and what the latent
  // growth curve in builtin-sem takes — is one column per occasion. Reshaping internally means a
  // user comparing one growth curve against a mixture of them never restructures their data.
  const { rCode } = await invoke(gmm, GMM_IN, GMM_RESULT);
  assert.match(rCode, /rep\(seq_len\(nPer\), times = nOcc\)/, 'the person id');
  assert.match(rCode, /rep\(seq_len\(nOcc\) - 1, each = nPer\)/, 'time 0, 1, 2, … over the columns');
  assert.match(rCode, /flexmix\(y ~ time \| id/, 'grouped by person, so the class belongs to a person');
  assert.match(rCode, /FLXMRlmm\(random = ~ 1\)/, 'a random intercept within each class');
});

test('a person with fewer than two occasions is dropped, and counted', async () => {
  // One point is not a trajectory. Dropping them in the open beats letting the fit do something
  // silent with them.
  const { rCode } = await invoke(gmm, GMM_IN, GMM_RESULT);
  assert.match(rCode, /table\(d\$id\) >= 2/);
  const { texts } = await invoke(gmm, GMM_IN, withGmm({ n: 240, nDropped: 10 }), { meta: WAVE_META });
  assert.match(texts[0], /240 people, 10 dropped for having fewer than two usable occasions/);
});

test('fewer than three occasions is refused with the reason', async () => {
  const { errors, rCode } = await invoke(gmm, { ...GMM_IN, waves: ['t1', 't2'] }, GMM_RESULT);
  assert.match(errors[0], /at least three occasions/);
  assert.match(errors[0], /just a line between two points/);
  assert.equal(rCode, '');
});

test('the occasions, their spacing and the seed are stated up front', async () => {
  const { texts } = await invoke(gmm, GMM_IN, GMM_RESULT, { meta: WAVE_META });
  assert.match(texts[0], /Baseline → Year 1 → Year 2 → Year 3 → Year 4/);
  assert.match(texts[0], /Modelled at times 0, 1, 2, 3, 4 — equally spaced, so the slope is per OCCASION/);
  assert.match(texts[0], /Random seed 12345/);
  // ...and the generic header is suppressed rather than printed alongside it.
  assert.equal(texts.filter((t) => /complete cases/.test(t)).length, 0);
});

test('each class reports its own level, rate, and within-class spread', async () => {
  const { tables } = await invoke(gmm, GMM_IN, GMM_RESULT, { meta: WAVE_META });
  const t = tables.find((x) => /Trajectory of each class/.test(x.caption));
  assert.deepEqual(t.columns, ['', 'Class 1', 'Class 2', 'Class 3']);
  assert.deepEqual(t.rows.map((r) => r[0]), [
    'Starting level (intercept)',
    'Change per occasion (slope)',
    'Variance between people, within the class',
    'Residual variance',
  ]);
  // Class 1 rises at +1.55, class 2 falls at −0.22 — the two simulated groups.
  assert.deepEqual(t.rows[1].slice(1), ['1.552', '-0.224', '0.980']);
  assert.equal(t.rows[2][1], '1.754', 'the random-intercept variance is reported, not hidden');
});

test('classes moving in OPPOSITE directions is called out — it is the whole finding', async () => {
  // The canonical growth-mixture result: an "average modest decline" that is really a stable
  // majority plus a fast-declining group. A single growth curve averages exactly that away.
  const { texts } = await invoke(gmm, GMM_IN, GMM_RESULT, { meta: WAVE_META });
  const note = texts.find((x) => /opposite directions/.test(x));
  assert.ok(note, 'the direction split is not mentioned');
  assert.match(note, /2 rising, 1 falling/);
  assert.match(note, /a single growth curve would have averaged into one modest trend/);
});

test('classes all moving the same way say so instead', async () => {
  const same = withGmm({
    parVals: [9.6, 1.5, 1.7, 0.6, 9.8, 0.4, 1.2, 0.6, 11.1, 0.9, 1.6, 0.5],
  });
  const { texts } = await invoke(gmm, GMM_IN, same, { meta: WAVE_META });
  assert.ok(texts.some((x) => /every class moves the same way, differing in how fast/.test(x)));
  assert.equal(texts.some((x) => /opposite directions/.test(x)), false);
});

test('the two ways a growth mixture misleads are both stated', async () => {
  const { texts } = await invoke(gmm, GMM_IN, GMM_RESULT, { meta: WAVE_META });
  const caution = texts.find((x) => /Classes can appear where there are none/.test(x));
  assert.ok(caution, 'the spurious-classes caution is missing');
  assert.match(caution, /single population with non-normal change/);
  assert.match(caution, /spacing is assumed equal/);
});

test('it shares the k-comparison machinery rather than reimplementing it', async () => {
  // Same table, same reading guidance, same tiny-class rule as LCA and LPA — and this fixture
  // exercises all of it: BIC is lowest at the true k = 2, and k = 3 splits off 4.45%.
  const { tables, texts } = await invoke(gmm, GMM_IN, GMM_RESULT, { meta: WAVE_META });
  assert.ok(tables.some((t) => /Choosing the number of class/.test(t.caption)));
  assert.ok(texts.some((t) => /lowest at 2 classes/.test(t)));
  assert.ok(texts.some((t) => /under 5% of cases/.test(t)), 'the 4.45% class must be flagged');
  assert.ok(texts.some((t) => /Re-run with 2/.test(t)));
});

test('growth mixtures added NO new R package', () => {
  // The engine decision: lcmm is the specialist and a 14-package closure; flexmix was already
  // here and ships FLXMRlmm. The offline cache pre-fetches every enabled plugin's packages, so
  // this is a download avoided for everyone who only wanted latent class analysis.
  assert.deepEqual(manifest.rPackages, ['poLCA', 'flexmix']);
  assert.ok(manifest.keywords.includes('growth mixture'));
  assert.ok(manifest.keywords.includes('trajectory'));
  assert.ok(manifest.keywords.includes('nagin'), 'group-based trajectory modelling by its other name');
  assert.match(manifest.howto, /run builtin-mixture\.gmm/);
});
