/**
 * @file timeline-records.test.mjs
 * A record belongs under the step it is about, and travels with it (#191 T6).
 *
 * From the owner's probe: *"memos being off the axis sounds like a good way to get in a
 * situation where the project has a stored memo notating a chart that was undone. or a
 * redo restoring the chart but silently dropping the memo that was on it?"*
 *
 * Right on both counts, and the log already had the field for it: a memo anchors by
 * op-log TARGET, and `analysis:<runId>` is a declared anchor kind, so a memo on a chart is
 * a real case. `ItemStore.put` has always accepted `reads[]` — "the causal edge the log has
 * always supported and the item tier never used (#166)" — and memo-store never passed it.
 *
 * So a record is not off the axis: it is ATTACHED to a row and moves with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTimeline } from '../core/timeline.js';

const load = (id = 'op-load') => ({ id, type: 'load', src: { label: 'gss.sav', meta: [] }, target: 'ds:3/source:tok' });
const compute = (id, name) => ({ id, type: 'computeVar', name, expr: '1', target: `ds:3/var:${name}` });
const cell = (id, col, rid) => ({ id, type: 'setCell', column: col, rid, row: 0, value: 'x', target: `ds:3/cell:${col}:${rid}` });
const run = (runId, label, at) => ({ runId, label, pluginName: 'Charts', at });
const memo = (id, text, anchorTarget) => ({ id, title: text, detail: 'Memos', anchorTarget, owner: 'core', collection: 'memos' });

/** "n kind title", with records shown as their nesting. */
const shape = (rows) => rows.filter((r) => r.kind !== 'start')
  .map((r) => (r.kind === 'record' ? `    ◆ ${r.title} -> ${r.parentId}` : `${r.n} ${r.kind} ${r.title}`));

test('a memo on an analysis nests under that analysis', () => {
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    analyses: [run('r1', 'Bar chart', 1)],
    records: [memo('m1', 'check the top code', 'analysis:r1')],
  });
  assert.deepEqual(shape(rows), [
    '1 data Imported data',
    '2 data Computed a',
    '3 analysis Bar chart',
    '    ◆ check the top code -> r1',
  ]);
});

test('a memo on a cell nests under the step that last WROTE that cell', () => {
  // The most recent step that touched it — which is the one a rewind past it would undo.
  const { rows } = buildTimeline({
    steps: [load(), cell('e1', 'age', '1000003')],
    records: [memo('m1', 'coded wrong', 'ds:3/cell:age:1000003')],
  });
  assert.equal(shape(rows).at(-1), '    ◆ coded wrong -> e1');
});

test('a memo on a cell nobody has edited falls back to the import that brought it in', () => {
  // Address-path matching: `ds:3/cell:age:17` is satisfied by `ds:3` when nothing more
  // specific wrote it. The alternative — calling it unanchored — would file a note about
  // real data under "not about a step".
  const { rows } = buildTimeline({
    steps: [load(), compute('c1', 'a')],
    records: [memo('m1', 'odd value here', 'ds:3/cell:age:17')],
  });
  assert.equal(shape(rows)[1], '    ◆ odd value here -> op-load');
});

test('a record with no anchor on this timeline goes last, parented to nothing', () => {
  // A project note, a codebook entry: genuinely not about any one step. Its own group.
  const { rows } = buildTimeline({
    steps: [load()],
    records: [memo('m1', 'about the project', 'project:notes')],
  });
  const rec = rows.find((r) => r.kind === 'record');
  assert.equal(rec.parentId, null);
  assert.equal(rows.at(-1), rec, 'last');
});

test('a memo on a WITHDRAWN analysis is withdrawn with it, not orphaned', () => {
  // The owner's first scenario. The record inherits its parent's liveness, so it is drawn
  // below the cursor alongside the chart it is about rather than left pointing at nothing.
  const { rows } = buildTimeline({
    steps: [load()],
    analyses: [run('r1', 'Kept', 0)],
    futureAnalyses: [run('r2', 'Withdrawn chart', 0)],
    records: [memo('m1', 'note on the withdrawn chart', 'analysis:r2')],
  });
  const rec = rows.find((r) => r.kind === 'record');
  assert.equal(rec.parentId, 'r2');
  assert.equal(rec.live, false, 'it travels with its anchor');
});

test('several records under one step keep their order', () => {
  const { rows } = buildTimeline({
    steps: [load()],
    analyses: [run('r1', 'Chart', 0)],
    records: [memo('m1', 'first', 'analysis:r1'), memo('m2', 'second', 'analysis:r1')],
  });
  assert.deepEqual(rows.filter((r) => r.kind === 'record').map((r) => r.title), ['first', 'second']);
});

test('no records means no extra rows at all', () => {
  const { rows } = buildTimeline({ steps: [load()], records: [] });
  assert.equal(rows.filter((r) => r.kind === 'record').length, 0);
});

// --- the wiring ------------------------------------------------------------------

const memoStore = readFileSync('core/memo-store.js', 'utf8');
const view = readFileSync('core/data-views.js', 'utf8');

test('a memo declares what it reads, so the causal edge exists at all', () => {
  assert.match(memoStore, /reads: \[a\.target\]/);
});

test('History can delete a record — and it is a tombstone, not a withdrawal', () => {
  // The owner: "is the only method to click around to find the thing the memo is on?"
  // It was, for a live memo: the sidebar's count line is inert, and the orphan list only
  // appears once the anchor is already gone.
  assert.match(view, /this\.removeRecord\(rec\)/);
  const app = readFileSync('core/app.js', 'utf8');
  assert.match(app, /removeRecord: \(rec\) => \{\s*itemStore\.remove\(rec\.owner, rec\.collection, rec\.id\)/);
});

test('a long run of records collapses, so notes cannot bury the recipe', () => {
  // Every un-edited cell's notes hang off the import, so one well-annotated dataset would
  // otherwise push the numbered steps off the panel.
  assert.match(view, /const RECORD_PREVIEW = 3;/);
  assert.match(view, /#recordToggle\(key, run\.length, expanded\)/);
});
