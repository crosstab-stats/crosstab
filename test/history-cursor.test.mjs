/**
 * @file history-cursor.test.mjs
 * The History panel is a view of the timeline (#191 T3/T4).
 *
 * Four defects the owner reported all came from the panel computing its own order:
 *   1. the `current` badge never moved, so it said nothing;
 *   2. analysis rows were not clickable at all;
 *   3. clicking a data step rewound the data and left the analyses below it standing,
 *      so Output went on showing numbers whose input data no longer existed;
 *   4. an arrow moved two rows, because it crossed a sibling AND a data step at once.
 *
 * Source-level assertions, because the project runs `node --test` with no DOM. The
 * ORDERING rules they depend on are covered properly in timeline.test.mjs; what these
 * protect is that the panel keeps reading them instead of growing its own copy again.
 * The behaviour itself was driven in the running app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const view = readFileSync('core/data-views.js', 'utf8');
const store = readFileSync('core/data-store.js', 'utf8');
const results = readFileSync('core/results-pane.js', 'utf8');
const syntax = readFileSync('core/crosstab-syntax.js', 'utf8');

/** The HistoryView class body — so a match elsewhere in this large file cannot stand in. */
const historyView = view.slice(view.indexOf('export class HistoryView'), view.indexOf('function ctlBtn'));

test('the panel draws what buildTimeline returns, and computes no order of its own', () => {
  assert.match(historyView, /buildTimeline\(\{/);
  // The tell-tales of the old hand-rolled interleave.
  assert.doesNotMatch(historyView, /byAt/, 'no private grouping by `at`');
  assert.doesNotMatch(historyView, /tcount/, 'no private transform counter');
  assert.doesNotMatch(historyView, /flushZero/, 'no private interleave');
});

test('EVERY row is clickable, including an analysis', () => {
  // Analysis rows were a <span> with `cursor: default` and no handler — which is why
  // clicking one did nothing while a data step rewound.
  const rowFn = historyView.slice(historyView.indexOf('#timelineRow(row'), historyView.indexOf('#rowControls(row'));
  assert.match(rowFn, /addEventListener\('click', \(\) => void this\.#cursorTo\(row\)\)/);
  assert.doesNotMatch(historyView, /cursor: default/);
});

test('an analysis row keeps its NUMBER, with the kind shown as a glyph beside the title', () => {
  // The sigma used to replace the number, so analysis rows were unnumbered — and since
  // the number was also the rewind coordinate, unnumbered meant unreachable.
  assert.match(historyView, /text: row\.kind === 'start' \? '\\u25cb' : String\(row\.n\)/);
  assert.match(historyView, /class: 'history__glyph'/);
});

test('an arrow swaps with the NEIGHBOUR — one row, whatever kind it is', () => {
  const move = historyView.slice(historyView.indexOf('async #moveRow('), historyView.indexOf('async #applyOrder('));
  assert.match(move, /const j = i \+ dir;/);
  assert.match(move, /\[ids\[i\], ids\[j\]\] = \[ids\[j\], ids\[i\]\]/);
  // The old special cases are gone: no sibling branch, no separate data-step path.
  assert.doesNotMatch(historyView, /hasSiblingAbove|hasSiblingBelow|#swapAnalyses/);
});

test('what a move COSTS is derived, not chosen by which button was pressed', () => {
  const apply = historyView.slice(historyView.indexOf('async #applyOrder('), historyView.indexOf('async #removeRow('));
  // Re-derive the pipeline only if the DATA order actually changed...
  assert.match(apply, /rederive: dataBefore !== dataAfter/);
  // ...and re-run exactly the analyses whose derived position moved.
  assert.match(apply, /staleAnalyses\(next\.rows\)/);
  assert.match(apply, /repositionAnalysis\?\.\(runId, to, \{ prefix: stepsAbove\(next\.rows, runId\) \}\)/);
});

test('the cursor governs the analyses too, not just the data', () => {
  // Defect 3. The data tier moves first so a restored analysis lands on the right state.
  const cursor = historyView.slice(historyView.indexOf('async #cursorTo('), historyView.indexOf('async #moveRow('));
  assert.match(cursor, /await this\.store\.rewindTo\(row\.dataCount\)/);
  assert.match(cursor, /withdrawRun\?\.\(r\.id\)/);
  assert.match(cursor, /admit\?\.\(r\.id\)/);
  assert.ok(cursor.indexOf('rewindTo') < cursor.indexOf('admit'), 'data first, then the analyses');
});

test('a withdrawn analysis restores its stashed output, and only re-runs as a fallback', () => {
  const cursor = historyView.slice(historyView.indexOf('async #cursorTo('), historyView.indexOf('async #moveRow('));
  assert.match(cursor, /if \(!this\.results\?\.restoreRun\?\.\(r\.id\)\)/, 'restore first');
  assert.match(cursor, /repositionAnalysis\?\.\(r\.id, r\.at, \{ prefix: stepsAbove\(seq, r\.id\) \}\)/,
    're-run at its OWN position, not at the cursor’s');
});

test('withdrawing is reversible; deleting is not', () => {
  // The distinction the owner pushed on: a memo (or a result) taken down by the cursor
  // comes back, where a deleted one is a tombstone and must never return on a
  // fast-forward. `removeRun` therefore drops the stash as well.
  const remove = results.slice(results.indexOf('removeRun(runId) {'), results.indexOf('reorderRuns(order) {'));
  assert.match(remove, /this\.#withdrawn\.delete\(runId\)/);
});

test('a pure presentation swap does not replay the pipeline', () => {
  const fn = store.slice(store.indexOf('async applyTimelineOrder('), store.indexOf('/** @returns {boolean} Whether this dataset has an operation to undo.'));
  assert.match(fn, /if \(rederive\)/);
  // ...but the op is still written, or the move would be lost entirely.
  assert.match(fn, /this\.#append\('reorder', \{ order \}, 'order'\)/);
});

test('the base import stays pinned, and nothing may sit above it', () => {
  const controls = historyView.slice(historyView.indexOf('#rowControls(row'), historyView.indexOf('  #recordRow(r) {'));
  assert.match(controls, /const locked = i === pinIdx/);
  assert.match(controls, /const canUp = !locked && i > pinIdx \+ 1/);
});

test('the Syntax view reads the same producer, so the two cannot disagree', () => {
  // They did: the panel placed analyses on a five-type transform set and this file on a
  // nine-type one, so after a drop or a weight they showed different histories.
  assert.match(syntax, /import \{ buildTimeline, TRANSFORM_TYPES \} from '\.\/timeline\.js'/);
  assert.doesNotMatch(syntax, /const TRANSFORM_TYPES = new Set\(/, 'no second definition');
  assert.doesNotMatch(syntax, /let tcount = 0/, 'no second copy of the interleave');
});
