/**
 * @file epi-levels.test.mjs
 * #186 — the 2×2 must be labelled from the level the recode actually used.
 *
 * The bug this guards against is not a wrong number, which is why it survived a
 * verification pass: the arithmetic was self-consistent, and only the LABELS lied. The
 * plugin recoded the higher of the two observed codes to 1, then named the rows by
 * looking up the value labels of the literal codes '1' and '0'. For 1 = Yes / 2 = No
 * data — the coding survey files actually arrive in — the row containing the *No* cases
 * was captioned *Yes*, and every measure under it described the opposite exposure.
 *
 * So the test is: the caller must never label from a literal. It reads the levels R
 * reports back, and those come from the same expression that did the recode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifest, run } from '../plugins/builtin-epi/index.js';

const META = [
  { name: 'smoker', type: 'numeric', label: 'Smokes', valueLabels: { 1: 'Yes', 2: 'No' } },
  { name: 'ill', type: 'numeric', label: 'Fell ill', valueLabels: { 1: 'Yes', 2: 'No' } },
];

/** Drive the plugin with R stubbed out; `levels` is what R reports the recode used. */
async function invoke(inputs, levels) {
  const out = { rCode: '', tables: [], texts: [], errors: [] };
  const app = {
    data: { getVariableMeta: async () => META },
    webr: {
      run: async (code) => {
        out.rCode = code;
        return {
          result: {
            names: ['a', 'b', 'c', 'd', 'n', 'expPos', 'expNeg', 'outPos', 'outNeg'],
            values: [3, 1, 1, 5, 10, levels.expPos, levels.expNeg, levels.outPos, levels.outNeg]
              .map((v) => ({ values: [v] })),
          },
        };
      },
    },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, caption: o?.caption ?? '' }); },
      appendText: async (s) => { out.texts.push(s); },
      appendError: async (s) => { out.errors.push(s); },
    },
  };
  await run(app, { exposure: 'smoker', outcome: 'ill', ...inputs });
  return out;
}

const YES_IS_EXPOSED = { expPos: '1', expNeg: '2', outPos: '1', outNeg: '2' };
const NO_IS_EXPOSED = { expPos: '2', expNeg: '1', outPos: '2', outNeg: '1' };

test('the dialog asks which category is exposed, and which is a case', () => {
  const inputs = manifest.menu[0].inputs;
  const exposed = inputs.find((i) => i.name === 'exposed');
  const caseL = inputs.find((i) => i.name === 'case');
  assert.equal(exposed.kind, 'level');
  assert.equal(exposed.of, 'exposure');
  assert.equal(caseL.kind, 'level');
  assert.equal(caseL.of, 'outcome');
  // Seeded to the higher code: that is what the plugin has always done, so accepting
  // the default cannot change a number relative to the old behaviour.
  assert.equal(exposed.preferLast, true);
  assert.equal(caseL.preferLast, true);
});

test('the table is labelled from the level the RECODE used, not from code "1"', async () => {
  // R reports it recoded with 2 = No as the exposed group (the old default on 1/2 data).
  const out = await invoke({}, NO_IS_EXPOSED);
  const tab = out.tables.find((t) => t.caption.startsWith('2×2 Table'));
  assert.match(tab.rows[0][0], /^No \(exposed\)/, 'the exposed row must name No');
  assert.match(tab.rows[1][0], /^Yes \(unexposed\)/);
  // The pre-fix code printed "Yes (exposed)" here — the exact inversion of the truth.
  assert.ok(!tab.rows[0][0].startsWith('Yes'), 'this is the #186 inversion');
});

test('choosing Yes as exposed labels Yes as exposed', async () => {
  const out = await invoke({ exposed: '1', case: '1' }, YES_IS_EXPOSED);
  const tab = out.tables.find((t) => t.caption.startsWith('2×2 Table'));
  assert.match(tab.rows[0][0], /^Yes \(exposed\)/);
  assert.match(tab.rows[1][0], /^No \(unexposed\)/);
  assert.match(tab.columns[1], /^Yes \(case\)/);
  assert.match(tab.columns[2], /^No \(non-case\)/);
});

test('the measures table names the direction it is measuring', async () => {
  // The numbers get read off this table, so the direction belongs on it — not only on
  // the 2×2 above, which a reader may have scrolled past.
  const out = await invoke({ exposed: '1', case: '1' }, YES_IS_EXPOSED);
  const m = out.tables.find((t) => t.caption.startsWith('Effect Measures'));
  assert.match(m.caption, /exposed = Yes/);
  assert.match(m.caption, /case = Yes/);
});

test('the chosen levels reach R, and an old script sends NULL', async () => {
  const picked = await invoke({ exposed: '1', case: '2' }, YES_IS_EXPOSED);
  assert.match(picked.rCode, /bin01\(exposure, "1"\)/);
  assert.match(picked.rCode, /bin01\(outcome, "2"\)/);
  // A log recorded before the picker existed: R falls back to the higher code, which is
  // what the plugin always did, so replaying it reproduces the same numbers.
  const old = await invoke({}, NO_IS_EXPOSED);
  assert.match(old.rCode, /bin01\(exposure, NULL\)/);
  assert.match(old.rCode, /bin01\(outcome, NULL\)/);
});

test('an unlabelled code still prints as itself rather than as "undefined"', async () => {
  const out = { tables: [] };
  const app = {
    data: { getVariableMeta: async () => [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }] },
    webr: { run: async () => ({ result: {
      names: ['a', 'b', 'c', 'd', 'n', 'expPos', 'expNeg', 'outPos', 'outNeg'],
      values: [3, 1, 1, 5, 10, '7', '4', '1', '0'].map((v) => ({ values: [v] })),
    } }) },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, caption: o?.caption ?? '' }); },
      appendText: async () => {}, appendError: async () => {},
    },
  };
  await run(app, { exposure: 'a', outcome: 'b' });
  const tab = out.tables.find((t) => t.caption.startsWith('2×2 Table'));
  assert.match(tab.rows[0][0], /^7 \(exposed\)/);
});
