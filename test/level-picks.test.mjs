/**
 * @file level-picks.test.mjs
 * #187 — every plugin that recodes a binary variable must let the user name the
 * positive level, and must print which level it used.
 *
 * These are contract tests over a whole tier rather than deep tests of one plugin. The
 * failure they exist to prevent is uniform and was present in five plugins at once: a
 * binary variable is recoded with "the higher of the two observed codes becomes 1", the
 * choice is never printed, and for `1 = Yes / 2 = No` data — the coding survey files
 * actually arrive in — every effect is reported for the opposite category with nothing
 * on screen saying so.
 *
 * Two properties are asserted for each, and they are the two rules #186 taught:
 *
 *   1. the chosen level reaches R, and its ABSENCE sends NULL — so a script recorded
 *      before the picker existed replays to the same numbers rather than silently
 *      switching to a new default;
 *   2. the output NAMES the level, so a default that was never examined is still
 *      visible to whoever reads the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as survival from '../plugins/builtin-survival/index.js';
import * as causal from '../plugins/builtin-causal/index.js';
import * as multilevel from '../plugins/builtin-multilevel/index.js';
import * as margins from '../plugins/builtin-margins/index.js';
import * as survey from '../plugins/builtin-survey/index.js';
import * as epi from '../plugins/builtin-epi/index.js';
import * as logistic from '../plugins/builtin-logistic/index.js';
import * as ordinal from '../plugins/builtin-ordinal/index.js';
import * as nonparametric from '../plugins/builtin-nonparametric/index.js';
import * as bayesian from '../plugins/builtin-bayesian/index.js';
import * as bootstrap from '../plugins/builtin-bootstrap/index.js';
import * as categorical from '../plugins/builtin-categorical/index.js';

/** Collect the R source a plugin emits, plus whatever it printed. */
function harness(meta, result) {
  const out = { rCode: '', tables: [], texts: [], errors: [], charts: [] };
  const app = {
    data: { getVariableMeta: async () => meta },
    webr: {
      run: async (code) => { out.rCode += code; return { result }; },
      installPackages: async () => {},
    },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, caption: o?.caption ?? '' }); },
      appendText: async (s) => { out.texts.push(s); },
      appendChart: async (m) => { out.charts.push(m); },
      appendError: async (s) => { out.errors.push(s); },
    },
  };
  return { app, out };
}

/** An R return value in webR's toJs() shape. */
const rList = (obj) => ({
  names: Object.keys(obj),
  values: Object.values(obj).map((v) => ({ values: [].concat(v) })),
});

const META = [
  { name: 'died', type: 'numeric', label: 'Died', valueLabels: { 1: 'Died', 2: 'Alive' } },
  { name: 'days', type: 'numeric', label: 'Days' },
  { name: 'arm', type: 'numeric', label: 'Arm', valueLabels: { 1: 'Treated', 2: 'Control' } },
  { name: 'wave', type: 'numeric', label: 'Wave', valueLabels: { 1: 'Before', 2: 'After' } },
  { name: 'score', type: 'numeric', label: 'Score' },
  { name: 'site', type: 'factor', label: 'Site' },
  { name: 'wt', type: 'numeric', label: 'Weight' },
];

/** Every level input in a manifest, flattened across its menu items. */
const levelInputs = (m) => m.menu.flatMap((item) => (item.inputs || []).filter((i) => i.kind === 'level'));

test('every Tier-2 plugin now declares a level input for its binary variable', () => {
  for (const [name, mod] of Object.entries({ survival, causal, multilevel, margins, survey, epi })) {
    const lv = levelInputs(mod.manifest);
    assert.ok(lv.length > 0, `${name} declares no level input`);
    // Seeded to the higher code: that is the rule these plugins already used, so taking
    // the default cannot move a number relative to the previous release.
    for (const i of lv) {
      assert.equal(i.preferLast, true, `${name}.${i.name} must seed the higher code`);
      assert.ok(i.of, `${name}.${i.name} must name the variable input it belongs to`);
    }
  }
});

test('every level input points at a variable input declared BEFORE it', () => {
  // The host resolves `of` from inputs already gathered, so a level input placed above
  // its variable would silently collect nothing.
  for (const [name, mod] of Object.entries({ survival, causal, multilevel, margins, survey, epi })) {
    for (const item of mod.manifest.menu) {
      const seen = [];
      for (const i of item.inputs || []) {
        if (i.kind === 'level') {
          assert.ok(seen.includes(i.of), `${name}: ${i.name} refers to ${i.of}, not yet gathered`);
        }
        seen.push(i.name);
      }
    }
  }
});

test('survival: the event level reaches R and is named in the caption', async () => {
  const res = rList({
    groups: 'Overall', n: 10, events: 6, median: 5, lcl: 3, ucl: 9,
    lrChi: NaN, lrDf: NaN, lrP: NaN, eventLevel: '1',
    curveT: 1, curveS: 0.9, curveLo: 0.7, curveHi: 1, curveCens: 0,
    curveStratum: 1, curveNames: 'Overall',
  });
  const { app, out } = harness(META, res);
  await survival.kaplanMeier(app, { time: 'days', status: 'died', event: '1' });
  assert.match(out.rCode, /status01\(status, "1"\)/);
  const km = out.tables.find((t) => t.caption.startsWith('Kaplan–Meier'));
  assert.match(km.caption, /event = Died/);
  assert.match(km.caption, /censored/, 'and says what the other category becomes');
});

test('survival: an old script sends NULL, keeping the previous behaviour', async () => {
  const res = rList({
    groups: 'Overall', n: 10, events: 6, median: 5, lcl: 3, ucl: 9,
    lrChi: NaN, lrDf: NaN, lrP: NaN, eventLevel: '2',
    curveT: 1, curveS: 0.9, curveLo: 0.7, curveHi: 1, curveCens: 0,
    curveStratum: 1, curveNames: 'Overall',
  });
  const { app, out } = harness(META, res);
  await survival.kaplanMeier(app, { time: 'days', status: 'died' });
  assert.match(out.rCode, /status01\(status, NULL\)/);
  // …and the caption still names what R actually chose, which is the whole point:
  // the old default becomes visible instead of remaining a guess.
  assert.match(out.tables[0].caption, /event = Alive/);
});

test('causal: both indicators are pickable and both are named', async () => {
  const res = rList({
    terms: ['(Intercept)', '.t:.p'], est: [1, 2], se: [0.1, 0.2], t: [10, 10], p: [0.01, 0.01],
    n: 40, iIdx: 2, tpos: '1', ppos: '2',
  });
  const { app, out } = harness(META, res);
  await causal.did(app, { y: 'score', treat: 'arm', treated: '1', post: 'wave', after: '2' });
  assert.match(out.rCode, /bin01\(treat, "1"\)/);
  assert.match(out.rCode, /bin01\(post, "2"\)/);
  const t = out.tables.find((x) => x.caption.startsWith('Difference-in-Differences'));
  assert.match(t.caption, /treated = Treated/);
  assert.match(t.caption, /after = After/);
});

test('multilevel: the modelled category is named', async () => {
  const res = rList({
    terms: '(Intercept)', est: 0.5, se: 0.1, z: 5, p: 0.001,
    gvar: 0.2, icc: 0.06, nobs: 100, ngrp: 10, ypos: '1',
  });
  const { app, out } = harness(META, res);
  await multilevel.logistic(app, { y: 'died', yes: '1', fixed: ['score'], group: 'site' });
  assert.match(out.rCode, /bin01\(y, "1"\)/);
  assert.match(out.tables[0].caption, /modelling Died/);
});

test('survey: logistic names the category; linear says nothing about one', async () => {
  const res = rList({
    terms: '(Intercept)', est: 0.5, se: 0.1, tval: 5, p: 0.001, lo: 0.3, hi: 0.7, n: 100, pos: '1',
  });
  const logit = harness(META, res);
  await survey.regression(logit.app, { dv: 'died', ivs: ['score'], yes: '1', family: 'logistic', weight: 'wt' });
  assert.match(logit.out.tables[0].caption, /modelling Died/);
  // The old prose said "the higher category is modelled as 1" — true but unactionable.
  assert.ok(logit.out.texts.some((t) => /odds of Died/.test(t)));

  const linear = harness(META, rList({
    terms: '(Intercept)', est: 0.5, se: 0.1, tval: 5, p: 0.001, lo: 0.3, hi: 0.7, n: 100, pos: 'NA',
  }));
  await survey.regression(linear.app, { dv: 'score', ivs: ['days'], family: 'linear', weight: 'wt' });
  assert.ok(!/modelling/.test(linear.out.tables[0].caption),
    'a linear model has no positive category to claim');
});

test('margins: the category is named for logistic, absent for linear', async () => {
  const res = rList({ term: 'score', est: 0.1, se: 0.01, z: 10, p: 0.001, lo: 0.08, hi: 0.12, n: 100, pos: '1' });
  const logit = harness(META, res);
  await margins.margins(logit.app, { dv: 'died', ivs: ['score'], yes: '1', family: 'logistic', kind: 'ame' });
  assert.match(logit.out.rCode, /\.pos <- if/);
  assert.match(logit.out.tables[0].caption, /modelling Died/);

  const lin = harness(META, rList({ term: 'days', est: 0.1, se: 0.01, z: 10, p: 0.001, lo: 0.08, hi: 0.12, n: 100, pos: 'NA' }));
  await margins.margins(lin.app, { dv: 'score', ivs: ['days'], family: 'linear', kind: 'ame' });
  assert.ok(!/modelling/.test(lin.out.tables[0].caption));
});

// --- Tier 3 & 4 ---------------------------------------------------------------

test('logistic: the modelled outcome category is now choosable', () => {
  const i = levelInputs(logistic.manifest).find((x) => x.name === 'modelled');
  assert.equal(i.of, 'dv');
  assert.equal(i.preferLast, true, 'SPSS models the higher code; the default must match');
});

test('logistic: the pick reaches R, and its absence keeps the old ordering', async () => {
  const res = rList({
    terms: '(Intercept)', termVar: '(Intercept)', termLevel: '', estimate: 1, se: 0.1,
    z: 10, p: 0.001, expb: 2.7, n: 100, nulldev: 130, resdev: 100,
    positive: '1', negative: '2', catVar: [], catRef: [], expbLo: 2, expbHi: 3,
  });
  const picked = harness(META, res);
  await logistic.run(picked.app, { dv: 'died', ivs: ['score'], modelled: '1', opts: [] });
  assert.match(picked.out.rCode, /\.want <- "1"/);
  assert.match(picked.out.tables[0].caption, /modelling Died/);

  const old = harness(META, res);
  await logistic.run(old.app, { dv: 'died', ivs: ['score'], opts: [] });
  assert.match(old.out.rCode, /\.want <- NULL/);
});

test('ordinal: the multinomial reference category is choosable', () => {
  const i = levelInputs(ordinal.manifest).find((x) => x.name === 'base');
  assert.equal(i.of, 'dv');
  // NOT preferLast: R's own default baseline is the FIRST level, and this picker exists
  // to make that visible, not to change it.
  assert.ok(!i.preferLast);
});

test('Tier 4: a 3-group variable is no longer refused — pick two of k', () => {
  // Each of these used to stop() unless the variable had exactly two levels, so the
  // only way to test two of three groups was to go and recode the data.
  for (const [name, mod] of Object.entries({ nonparametric, bayesian, bootstrap, categorical })) {
    const lv = levelInputs(mod.manifest);
    const g1 = lv.find((x) => x.name === 'g1');
    const g2 = lv.find((x) => x.name === 'g2');
    assert.ok(g1, `${name} has no Group 1 picker`);
    assert.ok(g2, `${name} has no Group 2 picker`);
    assert.equal(g2.exclude, 'g1', `${name}: Group 2 must exclude whatever Group 1 took`);
    assert.equal(g1.of, g2.of, `${name}: both pickers must read the same variable`);
  }
});

test('Tier 4: the hard "exactly 2" stops are gone from the touched paths', async () => {
  const { app, out } = harness(META, rList({
    levels: ['A', 'B'], n: [5, 5], meanRank: [4, 7], sumRank: [20, 35],
    U: 5, W: 20, Z: -1.5, p: 0.13, r: 0.3,
  }));
  await nonparametric.mannWhitney(app, { y: 'score', g: 'site', g1: 'A', g2: 'B' });
  assert.ok(!/must have exactly 2 groups/.test(out.rCode));
  assert.match(out.rCode, /needs at least 2 groups/);
  assert.match(out.rCode, /g1w <- "A"/);
  // The subset must happen BEFORE ranking — a third group's cases must not contribute
  // ranks. See scripts/validation/mannwhitney-subset-ranks.R for why this matters.
  assert.ok(out.rCode.indexOf('keep <- g == lv1') < out.rCode.indexOf('rk <- rank(y)'));
});

test('twoProp: both the group pair AND the counted category are choosable', () => {
  const lv = levelInputs(categorical.manifest);
  const succ = lv.find((x) => x.name === 'success');
  assert.equal(succ.of, 'outcome');
  assert.equal(succ.preferLast, true, 'it counted the SECOND outcome level before');
});
