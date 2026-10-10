/**
 * @file missing-values-field.test.mjs
 * The Missing values field in the Edit variable dialog: two lines, and it takes a pasted
 * column as readily as a comma list.
 *
 * ## Why it changed
 *
 * It was a single-line `<input>`. A GSS-style variable carries thirty-odd codes, so on a
 * phone that was a box you scrubbed sideways through without ever seeing the end — while
 * the field directly beneath it, Value labels, was already a `<textarea>` wrapping the
 * same kind of list-y content.
 *
 * Worth being precise about what this is NOT: it is **not** a WCAG 1.4.10 failure. That
 * criterion is about the page layout forcing two-dimensional scrolling; a form control
 * scrolling its own value is native behaviour and outside its scope. The dialog itself
 * reflows correctly. This is a usability fix, and the distinction matters because
 * conflating the two is how a compliance claim stops meaning anything.
 *
 * The owner's shape for it (2026-10-09): *"We can give missing a second line, but I'm not
 * sure it needs to be as large as 'values'. And pasting from a column list we got in an
 * email might be handy."* So: two rows, not four, and newlines parse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseMissing } from '../core/data-views.js';

// =============================================================================
// The parser — the paste shapes are the point
// =============================================================================

test('the comma form it has always taken still works', () => {
  assert.deepEqual(parseMissing('-100, -99, -98'), [-100, -99, -98]);
  assert.deepEqual(parseMissing('8,9'), [8, 9]);
});

test('a column pasted out of an email', () => {
  assert.deepEqual(parseMissing('-7\n-8\n-9'), [-7, -8, -9]);
});

test('…including the mess a real paste carries', () => {
  // CRLF from a Windows mail client, a blank line, padding spaces, and the trailing comma
  // left by someone who started converting it to a list and stopped.
  assert.deepEqual(parseMissing('-7\r\n-8\n\n -9 \n-10,'), [-7, -8, -9, -10]);
});

test('commas and newlines mixed, because a half-converted list is the likeliest paste', () => {
  assert.deepEqual(parseMissing('-1, -2\n-3,-4\n'), [-1, -2, -3, -4]);
});

test('nothing in, nothing out — not a list containing emptiness', () => {
  assert.deepEqual(parseMissing(''), []);
  assert.deepEqual(parseMissing('\n\n  \n'), []);
  assert.deepEqual(parseMissing(','), []);
});

test('a non-numeric code stays a string rather than becoming NaN', () => {
  // String variables have string missing codes ("NA", "refused"). Number() would turn
  // those into NaN, which compares equal to nothing and would silently match no rows.
  assert.deepEqual(parseMissing('NA\nrefused'), ['NA', 'refused']);
  assert.deepEqual(parseMissing('-9\nNA'), [-9, 'NA']);
  assert.ok(parseMissing('-9').every((v) => typeof v === 'number'));
});

test('numeric strings keep their numeric type, which is what the data holds', () => {
  assert.deepEqual(parseMissing(' 0 , 1 ').map((v) => typeof v), ['number', 'number']);
});

// =============================================================================
// The field itself
// =============================================================================

test('Missing values is a two-row textarea — smaller than Value labels, not equal to it', () => {
  const src = readFileSync('core/data-views.js', 'utf8');
  assert.match(src, /<textarea name="missing" rows="2">/, 'two rows: enough to paste into and to see that a long list is long');
  assert.match(src, /<textarea name="labels" rows="4">/, 'and still visibly the secondary of the two fields');
  assert.doesNotMatch(src, /<input name="missing"/, 'the single-line input is gone, not merely restyled');
});

test('the hint says both shapes are accepted, since neither is guessable', () => {
  const src = readFileSync('core/data-views.js', 'utf8');
  assert.match(src, /one per line, or comma-separated/);
});

test('the stored value is written back as a comma list, so reopening is not a diff', () => {
  // The round trip matters: the dialog renders `missingValues.join(', ')`, so a user who
  // pastes a column and reopens sees a comma list. That is fine — but it must be the SAME
  // codes, or an untouched Save would silently rewrite the variable.
  const codes = parseMissing('-7\n-8\n-9');
  assert.deepEqual(parseMissing(codes.join(', ')), codes);
});
