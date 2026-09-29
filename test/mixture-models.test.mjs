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

import { lca, lpa, manifest } from '../plugins/builtin-mixture/index.js';

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

test('both tools are on the menu with the inputs they need', () => {
  const byRun = Object.fromEntries(manifest.menu.map((m) => [m.run, m]));
  assert.deepEqual(Object.keys(byRun).sort(), ['lca', 'lpa']);
  for (const run of ['lca', 'lpa']) {
    const names = byRun[run].inputs.map((i) => i.name);
    assert.deepEqual(names, ['items', 'classes', 'seed', 'save'], `${run} inputs`);
    assert.equal(byRun[run].inputs.find((i) => i.name === 'seed').default, 12345, 'a default seed');
    assert.ok(byRun[run].inputs.every((i) => i.hint), `${run} has an unhinted input`);
  }
  // LCA takes categorical indicators, so it must NOT filter the picker to numeric.
  assert.equal(byRun.lca.inputs[0].types, undefined);
  assert.deepEqual(byRun.lpa.inputs[0].types, ['numeric']);
});

test('it is findable by the words someone leaving Mplus would type', () => {
  for (const term of ['latent class', 'lca', 'latent profile', 'lpa', 'mplus', 'mixture model']) {
    assert.ok(manifest.keywords.includes(term), `not searchable: ${term}`);
  }
  assert.match(manifest.howto, /run builtin-mixture\.lca/);
  assert.match(manifest.howto, /run builtin-mixture\.lpa/);
  assert.ok(manifest.disciplines.includes('Gerontology'), 'the faculty who asked for it');
});
