/**
 * @file timeline.test.mjs
 * One ordered, numbered list — and one definition of a transform (#191 T2).
 *
 * The History panel, `crosstab-syntax`'s `bodyLines`, its per-dataset `serializeProject`
 * and the Syntax gutter each implemented the same interleaving rule separately, on sets
 * of "what counts as a transform" that did not match: nine types, five, and eight. An
 * analysis's position was GENERATED with one of them, DRAWN with another and SERIALISED
 * with a third, so after a `dropVars` or a `weight by` the three views of one history
 * disagreed about where an analysis belonged.
 *
 * `buildTimeline` is the single producer. These pin the rules the four copies were
 * supposed to share, plus the one that fixes the drift: **`at` is derived from position**,
 * so what the list shows and what the numbers describe cannot come apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, staleAnalyses, analysisOrder, stepsAbove, TRANSFORM_TYPES } from '../core/timeline.js';

const load = (id = 'op-load') => ({ id, type: 'load', src: { label: 'gss.sav', meta: [] } });
const compute = (id, name) => ({ id, type: 'computeVar', name, expr: '1' });
const weight = (id, name) => ({ id, type: 'setWeight', name });
const drop = (id, names) => ({ id, type: 'dropVars', names });
const run = (runId, label, at) => ({ runId, label, pluginName: 'Descriptives', at });

/** Just the readable shape: "n kind title". */
const shape = (rows) => rows.filter((r) => r.kind !== 'start').map((r) => `${r.n} ${r.kind} ${r.title}`);

test('the seed order interleaves analyses by their recorded `at`', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a'), compute('c2', 'b')],
    analyses: [run('r1', 'Frequencies', 1), run('r2', 'Crosstab', 2)],
  });
  assert.deepEqual(shape(rows), [
    '1 data Imported data',
    '2 data Computed a',
    '3 analysis Frequencies',
    '4 data Computed b',
    '5 analysis Crosstab',
  ]);
});

test('an analysis run before any transform sits AFTER the sources, never above them', () => {
  // An analysis of freshly imported data describes the import; nothing can precede it.
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'Frequencies', 0)],
  });
  assert.deepEqual(shape(rows), ['1 data Imported data', '2 analysis Frequencies', '3 data Computed a']);
});

test('numbering is ONE sequence over data and analysis rows', () => {
  // The old panel numbered data rows by their index among applied steps and placed
  // analyses by a transform count — two coordinate systems in one list.
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'A', 0), run('r2', 'B', 1)],
  });
  assert.deepEqual(rows.map((r) => r.n), [0, 1, 2, 3, 4]);
});

test('`at` is DERIVED from position, and matches the stored value when nothing moved', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a'), compute('c2', 'b')],
    analyses: [run('r1', 'Frequencies', 1), run('r2', 'Crosstab', 2)],
  });
  const got = rows.filter((r) => r.kind === 'analysis').map((r) => [r.id, r.at]);
  assert.deepEqual(got, [['r1', 1], ['r2', 2]]);
  assert.deepEqual(staleAnalyses(rows), [], 'nothing moved, so nothing needs re-running');
});

test('an explicit order wins, and the derived `at` FOLLOWS it', () => {
  // The bug this kills: the list showed one position while the entry still claimed
  // another, so the numbers described data the row was no longer sitting after.
  const steps = [load(), compute('c1', 'a')];
  const analyses = [run('r1', 'Frequencies', 1)];
  const { rows } = buildTimeline({
    steps,
    analyses,
    order: ['op-load', 'r1', 'c1'], // the analysis dragged ABOVE the compute
  });
  assert.deepEqual(shape(rows), ['1 data Imported data', '2 analysis Frequencies', '3 data Computed a']);
  assert.equal(rows.find((r) => r.id === 'r1').at, 0, 'no transforms above it any more');
});

test('staleAnalyses names exactly the runs whose data position changed', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'Moved', 1), run('r2', 'Still here', 1)],
    order: ['op-load', 'r1', 'c1', 'r2'],
  });
  assert.deepEqual(staleAnalyses(rows), [
    { runId: 'r1', from: 1, to: 0, entry: rows.find((r) => r.id === 'r1').entry },
  ]);
});

test('reordering two analyses that share a data step re-runs NEITHER', () => {
  // Same data above both, so no derived `at` moves — the swap is presentation only.
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'First', 1), run('r2', 'Second', 1)],
    order: ['op-load', 'c1', 'r2', 'r1'],
  });
  assert.deepEqual(analysisOrder(rows), ['r2', 'r1']);
  assert.deepEqual(staleAnalyses(rows), []);
});

test('a `weight by` counts as a transform — the case the History panel got wrong', () => {
  // data-views counted five op types and setWeight was not among them, so an analysis
  // recorded after a weight never matched the running count and fell to the bottom of
  // the list. Weighting changes what the next Frequencies reports; it is a transform.
  assert.ok(TRANSFORM_TYPES.has('setWeight'));
  const { rows } = buildTimeline({
    steps: [load(), weight('w1', 'wtssps'), compute('c1', 'z')],
    analyses: [run('r1', 'Weighted freq', 1)],
  });
  assert.deepEqual(shape(rows), [
    '1 data Imported data',
    '2 data Weighted cases',
    '3 analysis Weighted freq',
    '4 data Computed z',
  ]);
});

test('dropVars / keepVars / renameVar count too', () => {
  for (const t of ['dropVars', 'keepVars', 'renameVar']) assert.ok(TRANSFORM_TYPES.has(t), t);
  const { rows } = buildTimeline({
    steps: [load(), drop('d1', ['x'])],
    analyses: [run('r1', 'After the drop', 1)],
  });
  assert.equal(shape(rows).at(-1), '3 analysis After the drop');
});

test('an order naming a row that no longer exists is ignored, not fatal', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'A', 1)],
    order: ['op-load', 'GONE', 'r1', 'c1'],
  });
  assert.deepEqual(shape(rows), ['1 data Imported data', '2 analysis A', '3 data Computed a']);
});

test('rows the order does not name keep their seed order, after the ones it does', () => {
  // An order written before a new row existed still means what it said.
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a'), compute('c2', 'b')],
    analyses: [run('r1', 'New run', 2)],
    order: ['op-load', 'c2', 'c1'], // written before r1 existed
  });
  assert.deepEqual(shape(rows), [
    '1 data Imported data',
    '2 data Computed b',
    '3 data Computed a',
    '4 analysis New run',
  ]);
});

test('dataCount is the rewind coordinate: how many data steps are at or above a row', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a'), compute('c2', 'b')],
    analyses: [run('r1', 'Mid', 1)],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.dataCount]), [
    ['start', 0], ['data', 1], ['data', 2], ['analysis', 2], ['data', 3],
  ]);
});

test('rows below the cursor are the SAME kinds, flagged not-live, and come last', () => {
  // Applied rows first, then everything below the cursor. That partition is what makes
  // the list linear: an undone row is always drawn after every applied one — which is
  // also where a redo now puts it back, since a new action retracts the branch.
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    future: [compute('c2', 'b')],
    analyses: [run('r1', 'A', 1)],
    futureAnalyses: [run('r2', 'Withdrawn', 2)],
  });
  assert.deepEqual(rows.filter((r) => r.kind !== 'start').map((r) => `${r.n} ${r.kind} ${r.live} ${r.title}`), [
    '1 data true Imported data',
    '2 data true Computed a',
    '3 analysis true A',
    '4 data false Computed b',
    '5 analysis false Withdrawn',
  ]);
});

test('a withdrawn analysis is not re-run and does not order the Output', () => {
  // It sits below the cursor: its numbers are stashed, not stale, and nothing recomputes.
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'Shown', 1)],
    futureAnalyses: [run('r2', 'Withdrawn', 99)],
  });
  assert.deepEqual(analysisOrder(rows), ['r1']);
  assert.deepEqual(staleAnalyses(rows), []);
});

test('stepsAbove is the prefix to materialise for a row', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a'), compute('c2', 'b')],
    analyses: [run('r1', 'Mid', 1)],
  });
  assert.deepEqual(stepsAbove(rows, 'r1').map((s) => s.id), ['op-load', 'c1']);
});

test('`ids` covers the live rows only — a reorder cannot name the discarded branch', () => {
  const { ids } = buildTimeline({
    steps: [load()],
    future: [compute('c9', 'gone')],
    analyses: [run('r1', 'A', 0)],
  });
  assert.deepEqual(ids, ['op-load', 'r1']);
});

test('`ids` is the row order, ready to be written as a reorder payload', () => {
  const { ids } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'A', 1)],
  });
  assert.deepEqual(ids, ['op-load', 'c1', 'r1']);
});

test('an empty project is a lone Start row', () => {
  const { rows, ids } = buildTimeline({});
  assert.deepEqual(rows.map((r) => r.kind), ['start']);
  assert.deepEqual(ids, []);
});

test('an analysis with no recorded position goes last rather than vanishing', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [{ runId: 'r1', label: 'Unpositioned', pluginName: 'P' }],
  });
  assert.equal(shape(rows).at(-1), '3 analysis Unpositioned');
});
