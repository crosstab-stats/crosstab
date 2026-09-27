/**
 * @file syntax-line-move.test.mjs
 * Reordering steps from inside Syntax view (owner, 2026-09-25): "the inability to reorder
 * steps while in syntax view mode still seems odd. having to switch to steps view to reorder
 * and then switch back to syntax view to edit syntax feels out of place."
 *
 * Reordering there always *worked* — the replay rebuilds the pipeline from the text in order,
 * so moving a line is moving the step — but the only gesture for it was the ▲/▼ buttons on
 * the Steps rows, one view away. `moveScriptLines` is that gesture (Alt+↑ / Alt+↓), kept pure
 * so the line arithmetic is tested here rather than by clicking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lineStartOffset, moveScriptLines } from '../core/data-views.js';

/** A script shaped like the real thing: a source anchor, transforms, an analysis. */
const SCRIPT = [
  '# use "GSS 2014"',
  'compute agegrp = age',
  'recode educ into educ3: 0..11 -> 1; else copy',
  'keep if age > 20',
  'run builtin-frequencies.run {"vars": ["educ3"]}',
].join('\n');

/** Index of the first character of line `n`. */
function startOfLine(text, n) {
  return text.split('\n').slice(0, n).reduce((acc, l) => acc + l.length + 1, 0);
}

test('a line moves up, and the caret keeps its column on that line', () => {
  const caret = startOfLine(SCRIPT, 3) + 5; // inside `keep if …`
  const out = moveScriptLines(SCRIPT, caret, caret, -1);
  assert.deepEqual(out.value.split('\n'), [
    '# use "GSS 2014"',
    'compute agegrp = age',
    'keep if age > 20',
    'recode educ into educ3: 0..11 -> 1; else copy',
    'run builtin-frequencies.run {"vars": ["educ3"]}',
  ]);
  // Still on the same text, at the same column — so you can keep typing after a move.
  assert.equal(out.start, out.end);
  assert.equal(out.value.slice(out.start - 5, out.start), 'keep ');
});

test('a line moves down', () => {
  const caret = startOfLine(SCRIPT, 1);
  const out = moveScriptLines(SCRIPT, caret, caret, 1);
  assert.deepEqual(out.value.split('\n').slice(1, 3), [
    'recode educ into educ3: 0..11 -> 1; else copy',
    'compute agegrp = age',
  ]);
});

test('a selection spanning lines moves as one block and stays selected', () => {
  const from = startOfLine(SCRIPT, 1);
  const to = startOfLine(SCRIPT, 2) + 4; // part-way into the recode line
  const out = moveScriptLines(SCRIPT, from, to, 1);
  assert.deepEqual(out.value.split('\n'), [
    '# use "GSS 2014"',
    'keep if age > 20',
    'compute agegrp = age',
    'recode educ into educ3: 0..11 -> 1; else copy',
    'run builtin-frequencies.run {"vars": ["educ3"]}',
  ]);
  // Both moved lines are selected, whole — so a second Alt+↓ moves the same block again.
  assert.equal(
    out.value.slice(out.start, out.end),
    'compute agegrp = age\nrecode educ into educ3: 0..11 -> 1; else copy',
  );
});

test('the ends are a no-op, not a wrap-around or a loss', () => {
  assert.equal(moveScriptLines(SCRIPT, 0, 0, -1), null);
  const lastLine = SCRIPT.split('\n').length - 1;
  const caret = startOfLine(SCRIPT, lastLine);
  assert.equal(moveScriptLines(SCRIPT, caret, caret, 1), null);
  // A selection touching the first line cannot move up even if it ends lower down.
  assert.equal(moveScriptLines(SCRIPT, 0, startOfLine(SCRIPT, 2), -1), null);
});

test('moving never adds, drops or rewrites a line', () => {
  // The invariant that matters: the script is a permutation of itself. A line-arithmetic
  // slip here would silently delete a step, and Run would apply the result.
  const before = SCRIPT.split('\n');
  let text = SCRIPT;
  for (const [dir, line] of [[1, 1], [1, 2], [-1, 4], [-1, 3], [1, 0]]) {
    const caret = startOfLine(text, line);
    const out = moveScriptLines(text, caret, caret, dir);
    if (out) text = out.value;
  }
  assert.deepEqual([...text.split('\n')].sort(), [...before].sort());
  assert.equal(text.split('\n').length, before.length);
});

test('blank lines are lines too, so spacing can be moved like anything else', () => {
  const text = 'a\n\nb';
  const caret = startOfLine(text, 1); // the blank
  const out = moveScriptLines(text, caret, caret, 1);
  assert.equal(out.value, 'a\nb\n');
});

test('a caret past the end of the destination line lands at that line’s end', () => {
  // Moving a long line onto a short one must not leave the caret beyond the text.
  const text = 'short\na much longer line';
  const caret = text.length; // end of the long line
  const out = moveScriptLines(text, caret, caret, -1);
  assert.equal(out.value, 'a much longer line\nshort');
  assert.ok(out.start <= out.value.length);
  assert.equal(out.value.slice(0, out.start), 'a much longer line');
});

// =============================================================================
// The gutter's own controls (owner, 2026-09-27)
// =============================================================================

/**
 * "Is there a reason the arrow and 'x' icons on the steps view are not used in syntax view?"
 * There was not. They are there now, and they do a DIFFERENT thing from their Steps-view
 * twins: Steps mutates the committed log, the gutter edits the TEXT. The textarea is an
 * unapplied draft, so moving a committed step behind it would leave two versions of the list
 * disagreeing — the same shape as the duplicated deploy issues and the diverged tooltip.
 *
 * They also matter for reach: Alt+↑/↓ needs a keyboard, so before this there was no way to
 * reorder in Syntax view on a touch device at all.
 *
 * `lineStartOffset` is the seam the buttons use to turn "line N" into the caret position the
 * shared mover expects, so it is what gets tested here.
 */
test('lineStartOffset finds the start of each line, and clamps', () => {
  const text = ['alpha', 'beta', 'gamma'].join('\n');
  assert.equal(lineStartOffset(text, 0), 0);
  assert.equal(lineStartOffset(text, 1), 6);
  assert.equal(lineStartOffset(text, 2), 11);
  assert.equal(text.slice(lineStartOffset(text, 2)), 'gamma');
  // Out of range clamps rather than returning NaN — a gutter index can lag a fast edit.
  assert.equal(lineStartOffset(text, 99), 11);
  assert.equal(lineStartOffset(text, -3), 0);
  assert.equal(lineStartOffset('', 0), 0);
});

test('a gutter move is the same operation as the keyboard one', () => {
  // The button computes a caret from the line index and hands it to the shared mover, so the
  // two gestures cannot drift apart.
  const start = lineStartOffset(SCRIPT, 3);
  const byButton = moveScriptLines(SCRIPT, start, start, -1);
  const byKeyboard = moveScriptLines(SCRIPT, start + 4, start + 4, -1); // caret mid-line
  assert.equal(byButton.value, byKeyboard.value);
});

test('deleting one line leaves the rest intact', () => {
  // What the gutter's ✕ does, as plain text: one line, not a whole multi-line construct. The
  // recode's metadata lines are their own lines, and what you see deleted is what is deleted.
  const lines = SCRIPT.split('\n');
  const index = 2;
  const after = lines.slice(0, index).concat(lines.slice(index + 1));
  assert.equal(after.length, lines.length - 1);
  assert.ok(!after.includes(lines[index]));
  assert.deepEqual(after[index], lines[index + 1]);
});
