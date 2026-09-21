/**
 * @file test/logistic-options.test.mjs
 * Binary Logistic — the SPSS Options output (#178).
 *
 * Two halves, both real:
 *
 *  1. **The R it emits.** The plugin builds its R by interpolation, so these tests run
 *     the REAL builder and assert on the source text — that ticking an option is what
 *     puts its block in, and that "Categorical…" and the reference choice reach R.
 *  2. **The tables it renders.** `test/logistic-r-result.fixture.json` is the value R
 *     actually returned for that emitted source (R 4.6.0, in webR's `toJs()` shape),
 *     so the numbers checked here are R's, not invented. The statistics themselves
 *     were validated against `ResourceSelection::hoslem.test`, `residuals(type =
 *     "pearson")` and `confint.default` to machine epsilon — that check lives on local
 *     R (no package installs in CI); this file guards the wiring around it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifest, run } from '../plugins/builtin-logistic/index.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./logistic-r-result.fixture.json', import.meta.url), 'utf8'),
);

const META = [
  { name: 'SCHOOL_ATTEND', type: 'factor', label: 'Attends school', valueLabels: { 1: 'No', 2: 'Yes' } },
  { name: 'LANGUAGE', type: 'numeric', label: 'Language at home', valueLabels: { 1: 'English', 2: 'Spanish', 3: 'Other' } },
  { name: 'AGE', type: 'numeric', label: 'Age' },
];

/** Drive the plugin with a stub host; returns the emitted R plus every output block. */
async function invoke(inputs, { result = FIXTURE } = {}) {
  const out = { rCode: '', tables: [], texts: [], charts: [], errors: [] };
  const app = {
    data: { getVariableMeta: async () => META },
    webr: {
      run: async (code) => {
        out.rCode = code;
        return { result };
      },
    },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, caption: o?.caption ?? '' }); },
      appendText: async (s) => { out.texts.push(s); },
      appendChart: async (m) => { out.charts.push(m); },
      appendError: async (s) => { out.errors.push(s); },
    },
  };
  await run(app, { dv: 'SCHOOL_ATTEND', ivs: ['LANGUAGE', 'AGE'], ...inputs });
  return out;
}

const captioned = (out, needle) => out.tables.find((t) => t.caption.includes(needle));

// --- the menu contract -------------------------------------------------------

test('the dialog offers every option SPSS puts behind its Options button', () => {
  const inputs = manifest.menu[0].inputs;
  const opts = inputs.find((i) => i.name === 'opts');
  const values = opts.options.map((o) => o.value);
  for (const v of ['class', 'ci', 'hl', 'plot', 'casewise']) assert.ok(values.includes(v), v);
  assert.equal(opts.multiple, true);
  // SPSS prints the classification table whether you ask or not; match that, so a
  // student comparing printouts sees the same tables.
  assert.deepEqual(opts.default, ['class']);

  const ref = inputs.find((i) => i.name === 'ref');
  assert.deepEqual(ref.options.map((o) => o.value), ['first', 'last']);
  assert.equal(ref.default, 'first', 'first is what the plugin already did — no silent shift');
  assert.ok(inputs.find((i) => i.name === 'cats').optional);
});

// --- half 1: the R that gets emitted -----------------------------------------

test('an option that is off emits none of its R', async () => {
  const { rCode } = await invoke({ opts: [] });
  assert.ok(!/hoslem|pchisq/i.test(rCode), 'no Hosmer-Lemeshow block');
  assert.ok(!/cwTotal/.test(rCode), 'no casewise block');
  assert.ok(!/plBin/.test(rCode), 'no classification-plot block');
  assert.ok(!/ct00/.test(rCode), 'no classification-table block');
  assert.ok(!/\bpred <- /.test(rCode), 'nothing computes predicted groups');
});

test('each option pulls in exactly its own block', async () => {
  assert.match((await invoke({ opts: ['hl'] })).rCode, /hlChisq/);
  assert.match((await invoke({ opts: ['casewise'] })).rCode, /cwTotal/);
  assert.match((await invoke({ opts: ['plot'] })).rCode, /plBin/);
  assert.match((await invoke({ opts: ['class'] })).rCode, /ct00/);
  // The 0.5 cut is needed by three options, and must be defined once for any of them.
  for (const o of ['class', 'plot', 'casewise']) {
    assert.match((await invoke({ opts: [o] })).rCode, /pred <- as\.integer\(p >= 0\.5\)/);
  }
});

test('Categorical… forces a numerically-coded predictor to be dummy-coded', async () => {
  const bare = await invoke({ opts: [] });
  assert.match(bare.rCode, /catv <- character\(0\)/, 'numeric LANGUAGE is a slope by default');

  const declared = await invoke({ opts: [], cats: ['LANGUAGE'] });
  assert.match(declared.rCode, /catv <- c\("LANGUAGE"\)/);
});

test('a factor predictor is dummy-coded without being declared', async () => {
  const out = { rCode: '' };
  const app = {
    data: {
      getVariableMeta: async () => [
        ...META,
        { name: 'REGION', type: 'factor', label: 'Region' },
      ],
    },
    webr: { run: async (code) => { out.rCode = code; return { result: FIXTURE }; } },
    results: {
      appendTable: async () => {}, appendText: async () => {},
      appendChart: async () => {}, appendError: async () => {},
    },
  };
  await run(app, { dv: 'SCHOOL_ATTEND', ivs: ['REGION', 'AGE'], opts: [] });
  assert.match(out.rCode, /catv <- c\("REGION"\)/);
});

test('the reference choice is what switches relevel on', async () => {
  assert.match((await invoke({ opts: [], cats: ['LANGUAGE'] })).rCode, /if \(FALSE && nlevels/);
  assert.match(
    (await invoke({ opts: [], cats: ['LANGUAGE'], ref: 'last' })).rCode,
    /if \(TRUE && nlevels\(f\) > 1\) f <- relevel\(f, ref = levels\(f\)\[nlevels\(f\)\]\)/,
  );
});

test('the case number is pinned before glm can drop NA rows', async () => {
  const { rCode } = await invoke({ opts: ['casewise'] });
  const pin = rCode.indexOf('rownames(d) <- seq_len(nrow(d))');
  const fit = rCode.indexOf('glm(');
  assert.ok(pin > -1 && pin < fit, 'row names are set before fitting');
  assert.match(rCode, /as\.integer\(rownames\(fit\$model\)\)/);
});

test('a stray pick in Categorical… is ignored, and says so', async () => {
  const out = await invoke({ opts: [], cats: ['NOT_A_PREDICTOR'] });
  assert.match(out.rCode, /catv <- character\(0\)/);
  assert.ok(out.texts.some((t) => t.includes('NOT_A_PREDICTOR')));
  // Ignoring it must not quietly add a term to the model.
  assert.match(out.rCode, /\.y ~ `LANGUAGE` \+ `AGE`/);
});

// --- half 2: the tables rendered from R's real return value ------------------

test('with no options ticked the output is the two original tables', async () => {
  const out = await invoke({ opts: [] });
  assert.equal(out.tables.length, 2);
  assert.match(out.tables[0].caption, /^Model Summary/);
  assert.equal(out.tables[1].caption.split(' —')[0], 'Variables in the Equation');
  assert.deepEqual(out.tables[1].columns, ['', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)']);
  assert.equal(out.charts.length, 0);
});

test('CI for Exp(B) adds two columns, and only when ticked', async () => {
  const off = captioned(await invoke({ opts: [] }), 'Variables in the Equation');
  assert.equal(off.columns.length, 7);

  const on = captioned(await invoke({ opts: ['ci'] }), 'Variables in the Equation');
  assert.deepEqual(on.columns.slice(7), [
    '95% C.I. for Exp(B) — Lower', '95% C.I. for Exp(B) — Upper',
  ]);
  // R's Wald bounds for LANGUAGE = Spanish, straddling Exp(B) = 3.291.
  const spanish = on.rows.find((r) => r[0].includes('Spanish'));
  assert.equal(spanish[6], '3.291');
  assert.equal(spanish[7], '2.116');
  assert.equal(spanish[8], '5.119');
  assert.ok(Number(spanish[7]) < Number(spanish[6]) && Number(spanish[6]) < Number(spanish[8]));
});

test('dummy rows are named with value labels, and the reference is stated', async () => {
  const t = captioned(await invoke({ opts: [], cats: ['LANGUAGE'] }), 'Variables in the Equation');
  const names = t.rows.map((r) => r[0]);
  assert.equal(names[0], 'Constant');
  assert.ok(names.includes('Language at home (LANGUAGE) = Spanish'), names.join(' | '));
  assert.ok(names.includes('Language at home (LANGUAGE) = Other'));
  assert.ok(names.includes('Age (AGE)'), 'a numeric predictor keeps its plain name');
  assert.match(t.caption, /reference category: Language at home \(LANGUAGE\) = English/);
});

test('Hosmer–Lemeshow prints the test and its contingency table', async () => {
  const out = await invoke({ opts: ['hl'] });
  const test_ = captioned(out, 'Hosmer and Lemeshow Test');
  assert.deepEqual(test_.columns, ['Chi-square', 'df', 'Sig.']);
  assert.deepEqual(test_.rows[0], ['5.044', '8', '0.753']); // R: chisq 5.0441, df 8, p .7529
  assert.match(test_.caption, /LARGE Sig\. is the good result/);

  const tab = captioned(out, 'Contingency Table');
  assert.equal(tab.rows.length, 10, 'deciles of risk');
  assert.ok(tab.columns[1].startsWith('No —') && tab.columns[3].startsWith('Yes —'),
    'outcome columns carry the value labels');
  // Every case lands in exactly one bin: the observed counts sum to the model N.
  const total = tab.rows.reduce((s, r) => s + Number(r[5]), 0);
  assert.equal(total, 497);
});

test('the classification table counts and percentages are the confusion matrix', async () => {
  const t = captioned(await invoke({ opts: ['class'] }), 'Classification Table');
  // R's table at the .5 cut: 131 / 93 / 88 / 185.
  assert.deepEqual(t.rows[0].slice(0, 3), ['Observed: No', '131', '93']);
  assert.deepEqual(t.rows[1].slice(0, 3), ['Observed: Yes', '88', '185']);
  assert.equal(t.rows[0][3], (100 * 131 / 224).toFixed(1));
  assert.equal(t.rows[1][3], (100 * 185 / 273).toFixed(1));
  assert.equal(t.rows[2][0], 'Overall Percentage');
  assert.equal(t.rows[2][3], (100 * (131 + 185) / 497).toFixed(1));
  assert.match(t.caption, /cut value is \.500/);
});

test('the casewise list names dataset rows and labels both outcome columns', async () => {
  const out = await invoke({ opts: ['casewise'] });
  const t = captioned(out, 'Casewise List');
  assert.deepEqual(t.columns, [
    'Case', 'Observed: Attends school (SCHOOL_ATTEND)', 'Predicted', 'Predicted Group',
    'Resid', 'ZResid',
  ]);
  assert.equal(t.rows.length, 2); // R flagged exactly two cases beyond 2 SD
  assert.deepEqual(t.rows.map((r) => r[0]), ['63', '232']);
  // A flagged case is one the model got wrong, so observed and predicted must differ.
  for (const r of t.rows) assert.notEqual(r[1], r[3]);
  for (const r of t.rows) assert.ok(Math.abs(Number(r[5])) > 2, 'listed only if beyond 2 SD');
  assert.ok(Math.abs(Number(t.rows[0][5])) >= Math.abs(Number(t.rows[1][5])), 'largest first');
  assert.match(t.caption, /“Case” is the dataset row number/);
});

test('an empty casewise list says so instead of printing an empty table', async () => {
  const quiet = {
    ...FIXTURE,
    values: FIXTURE.values.map((v, i) => (
      ['cwRow', 'cwObs', 'cwPred', 'cwGroup', 'cwResid', 'cwZ'].includes(FIXTURE.names[i])
        ? { ...v, values: [] }
        : FIXTURE.names[i] === 'cwTotal' ? { ...v, values: [0] } : v
    )),
  };
  const out = await invoke({ opts: ['casewise'] }, { result: quiet });
  assert.equal(captioned(out, 'Casewise List'), undefined);
  assert.ok(out.texts.some((t) => t.includes('no case has a standardised residual')));
});

test('the classification plot is a chart MODEL, not a baked picture', async () => {
  const out = await invoke({ opts: ['plot'] });
  assert.equal(out.charts.length, 1);
  const c = out.charts[0];
  assert.equal(c.kind, 'categorical'); // goes through the host chart layer (#131)
  assert.equal(c.view.stack, 'stacked');
  assert.equal(c.view.mark, 'bar');
  assert.equal(c.counts, true);
  assert.equal(c.categories.length, 20); // bins of .05 across 0..1
  assert.deepEqual(c.series.map((s) => s.label), ['Observed: No', 'Observed: Yes']);
  // Both series are binned over the same cases, so together they are the model N.
  const n = c.series.reduce((s, ser) => s + ser.values.reduce((a, b) => a + b, 0), 0);
  assert.equal(n, 497);
  assert.equal(c.series[0].values.length, 20);
});

test('all five options at once render in SPSS order', async () => {
  const out = await invoke({ opts: ['class', 'ci', 'hl', 'plot', 'casewise'] });
  const order = out.tables.map((t) => t.caption.split(' —')[0]);
  assert.deepEqual(order, [
    'Model Summary',
    'Hosmer and Lemeshow Test',
    'Contingency Table for Hosmer and Lemeshow Test',
    'Classification Table',
    'Variables in the Equation',
    'Casewise List',
  ]);
  assert.equal(out.charts.length, 1);
  assert.equal(out.errors.length, 0);
});

test('an outcome with no predictors is refused before R is asked', async () => {
  const out = await invoke({ ivs: [] });
  assert.equal(out.rCode, '');
  assert.equal(out.tables.length, 0);
  assert.match(out.errors[0], /at least one predictor/);
});
