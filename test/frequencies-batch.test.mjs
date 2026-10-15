/**
 * @file frequencies-batch.test.mjs
 * Frequencies measures every variable in ONE R call.
 *
 * It used to issue one `webr.run` per variable, so a 20-variable run paid twenty
 * round-trips and re-sent the weighted-statistics prelude twenty times. Batching moves
 * one property that mattered from JS into R: the per-variable `try/catch` that let one
 * unusable column report itself while the rest of the run printed. If that isolation is
 * lost, the failure mode is "one bad variable, no tables at all" — which is why it is
 * tested here rather than left to the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../plugins/builtin-frequencies/index.js';
import { fakeWebr } from './webr-fake.mjs';

const META = [
  { name: 'q1', type: 'numeric', label: 'First question', missingValues: [9] },
  { name: 'q2', type: 'numeric', label: 'Second question' },
  { name: 'q3', type: 'numeric', missingRanges: [[90, 99]] },
];

/** An R list in webR's `toJs()` shape. */
const rList = (obj) => ({
  type: 'list',
  names: Object.keys(obj),
  values: Object.values(obj).map((v) => (v && v.type === 'list' ? v : { values: [].concat(v) })),
});

/** What `.freq1` returns for a column — enough fields for the table builders. */
const measured = (values, counts) => rList({
  values,
  counts,
  percent: counts.map((c) => (c / 10) * 100),
  valid_percent: counts.map((c) => (c / 10) * 100),
  cumulative: counts.map((c, i) => counts.slice(0, i + 1).reduce((a, b) => a + b, 0) * 10),
  n_total: 10, n_valid: 10, n_missing: 0, dropped: 0,
  mean: 1.5, median: 1.5, sum: 15, sd: 0.5, variance: 0.25, se: 0.16,
  min: 1, max: 2, range: 1, p25: 1, p50: 1.5, p75: 2,
  mode_value: '1', mode_ties: 1, n_numeric: 10,
});

/** Run the plugin, answering its single R call with `reply(code)`. */
async function invoke(inputs, reply) {
  const out = { codes: [], tables: [], texts: [], errors: [] };
  const app = {
    data: { getVariableMeta: async () => META },
    webr: fakeWebr({
      run: async (code) => { out.codes.push(code); return { result: reply(code) }; },
    }),
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, caption: o?.caption ?? '' }); },
      appendText: async (s) => { out.texts.push(s); },
      appendError: async (s) => { out.errors.push(s); },
    },
  };
  await run(app, inputs);
  return out;
}

const allOk = () => rList({
  v1: measured(['1', '2'], [6, 4]),
  v2: measured(['1', '2'], [5, 5]),
  v3: measured(['1', '2'], [7, 3]),
});

test('three variables cost one R call, not three', async () => {
  const out = await invoke({ vars: ['q1', 'q2', 'q3'] }, allOk);
  assert.equal(out.codes.length, 1);
  assert.equal(out.tables.length, 3, 'one frequency table per variable');
  assert.deepEqual(out.errors, []);
});

test('the prelude is sent once and each variable is one call into it', async () => {
  const [code] = (await invoke({ vars: ['q1', 'q2', 'q3'] }, allOk)).codes;
  assert.equal(code.match(/wclean <- function/g).length, 1, 'WEIGHTED_R must not repeat');
  assert.equal(code.match(/\.freq1 <- function/g).length, 1);
  assert.equal(code.match(/\.freq1\(vars\[\[/g).length, 3);
  assert.ok(code.includes('tryCatch('), 'per-variable isolation lives in R now');
});

test("a variable's missing codes and ranges travel as arguments, not as pasted source", async () => {
  const [code] = (await invoke({ vars: ['q1', 'q2', 'q3'] }, allOk)).codes;
  // q1 designates the code 9; q3 designates the span 90–99; q2 designates nothing.
  assert.ok(code.includes('.freq1(vars[["q1"]], c(9), c(), c())'), code);
  assert.ok(code.includes('.freq1(vars[["q2"]], c(), c(), c())'), code);
  assert.ok(code.includes('.freq1(vars[["q3"]], c(), c(90), c(99))'), code);
});

test('one failing column reports itself and the others still print', async () => {
  const out = await invoke({ vars: ['q1', 'q2', 'q3'] }, () => rList({
    v1: measured(['1', '2'], [6, 4]),
    v2: rList({ '.error': 'object of type closure is not subsettable' }),
    v3: measured(['1', '2'], [7, 3]),
  }));
  assert.equal(out.tables.length, 2, 'q1 and q3 still print');
  assert.deepEqual(out.errors, ['Frequencies for "q2": object of type closure is not subsettable']);
  assert.ok(out.tables.every((t) => !t.caption.includes('Second question')));
});

test('a missing slot is reported against the variable it belongs to', async () => {
  // Not a data condition — a statement that never ran. It still has to name a variable,
  // because "Frequencies failed" with three variables selected tells the reader nothing.
  const out = await invoke({ vars: ['q1', 'q2'] }, () => rList({ v1: measured(['1'], [10]) }));
  assert.equal(out.tables.length, 1);
  assert.deepEqual(out.errors, ['Frequencies for "q2": no result for this variable']);
});

test('a failure of the whole call is reported once, not per variable', async () => {
  const out = await invoke({ vars: ['q1', 'q2', 'q3'] }, () => null);
  assert.deepEqual(out.tables, []);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^Frequencies: /);
});

test('the Statistics table still sits above the frequency tables', async () => {
  // SPSS's order, and the reason the plugin measures everything before printing anything.
  const out = await invoke({ vars: ['q1', 'q2'], statistics: ['mean', 'median'] }, allOk);
  assert.match(out.tables[0].caption, /^Statistics/);
  assert.equal(out.tables.length, 3);
});

test('a weight is bound once for the whole batch and named in every caption', async () => {
  const out = await invoke({ vars: ['q1', 'q2'], weight: 'q3' }, allOk);
  assert.equal(out.codes.length, 1);
  assert.equal(out.codes[0].match(/wclean\(weight,/g).length, 1, 'one weight fold for the run');
  assert.ok(out.tables.every((t) => t.caption.endsWith('— weighted by q3')), out.tables.map((t) => t.caption));
});
