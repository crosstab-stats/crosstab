/**
 * @file missing-values-field.test.mjs
 * The Missing values field in the Edit variable dialog: what it accepts, and the two
 * things the metadata holds behind it.
 *
 * ## Why it is one field for two keys
 *
 * Missing is declared two ways. Discrete codes live in `missingValues`; inclusive spans
 * live in `missingRanges`, and arrive from SPSS/Stata files as
 * `MISSING VALUES income (LO THRU 0)`. **The editor only ever read and wrote the first.**
 * So a variable imported with a span opened with an EMPTY box beside a Variable View cell
 * that read `-999999 to 0`, and nothing in the dialog could edit or remove it
 * (found 2026-10-07, closed 2026-10-09).
 *
 * The saving grace was that `applyPatch` merges by key list rather than replacing, so an
 * unmentioned `missingRanges` survived — no data was lost. What the user got instead was
 * worse to live with than an error: clear the box intending to remove every missing
 * declaration, save, and the variable goes on treating a whole span as missing with
 * nothing on screen to say so. The app appears to ignore you.
 *
 * They are one idea — "what counts as missing" — and were two controls' worth of state
 * behind one control only by accident. Hence one field, split on save.
 *
 * ## Why it is a two-row textarea
 *
 * It was a single-line input, and a GSS-style variable carries thirty-odd codes: a box you
 * scrubbed sideways through without seeing the end. Two rows, not four — enough to paste
 * into, without giving a secondary field the weight of Value labels below it (owner,
 * 2026-10-09: *"we can give missing a second line, but I'm not sure it needs to be as
 * large as 'values'. And pasting from a column list we got in an email might be handy."*)
 *
 * Worth stating plainly, because conflating the two would make the compliance claim
 * meaningless: the single-line version was **not** a WCAG 1.4.10 failure. That criterion
 * is about page layout forcing two-dimensional scrolling; a form control scrolling its own
 * value is native behaviour and outside its scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { splitMissingSpec, formatMissingSpec } from '../core/data-views.js';

const codes = (t) => splitMissingSpec(t).missingValues;
const ranges = (t) => splitMissingSpec(t).missingRanges;

// =============================================================================
// Discrete codes — the shapes a paste arrives in
// =============================================================================

test('the comma form it has always taken still works', () => {
  assert.deepEqual(codes('-100, -99, -98'), [-100, -99, -98]);
  assert.deepEqual(codes('8,9'), [8, 9]);
});

test('a column pasted out of an email', () => {
  assert.deepEqual(codes('-7\n-8\n-9'), [-7, -8, -9]);
});

test('…including the mess a real paste carries', () => {
  // CRLF from a Windows mail client, a blank line, padding spaces, and the trailing comma
  // left by someone who started converting it to a list and stopped.
  assert.deepEqual(codes('-7\r\n-8\n\n -9 \n-10,'), [-7, -8, -9, -10]);
});

test('commas and newlines mixed, because a half-converted list is the likeliest paste', () => {
  assert.deepEqual(codes('-1, -2\n-3,-4\n'), [-1, -2, -3, -4]);
});

test('nothing in, nothing out — not a list containing emptiness', () => {
  assert.deepEqual(splitMissingSpec(''), { missingValues: [], missingRanges: [] });
  assert.deepEqual(splitMissingSpec('\n\n  \n'), { missingValues: [], missingRanges: [] });
  assert.deepEqual(splitMissingSpec(','), { missingValues: [], missingRanges: [] });
});

test('a non-numeric code stays a string rather than becoming NaN', () => {
  // String variables have string missing codes. Number() would make those NaN, which
  // compares equal to nothing and would silently match no rows.
  assert.deepEqual(codes('NA\nrefused'), ['NA', 'refused']);
  assert.deepEqual(codes('-9\nNA'), [-9, 'NA']);
  assert.ok(codes('-9').every((v) => typeof v === 'number'));
});

// =============================================================================
// Spans
// =============================================================================

test('a span is read as a range, not as two codes', () => {
  assert.deepEqual(ranges('-999999 to 0'), [[-999999, 0]]);
  assert.deepEqual(codes('-999999 to 0'), [], 'and does not also leave its ends behind as codes');
});

test('SPSS spells it THRU, so that is accepted too — but never written back', () => {
  assert.deepEqual(ranges('LO thru 0'.replace('LO', '-999999')), [[-999999, 0]]);
  assert.deepEqual(ranges('-99 THRU -90'), [[-99, -90]]);
  assert.deepEqual(ranges('-99 through -90'), [[-99, -90]]);
  assert.equal(formatMissingSpec({ missingRanges: [[-99, -90]] }), '-99 to -90');
});

test('codes and spans mix in one field, because they are one idea to the reader', () => {
  const got = splitMissingSpec('-1, -99 to -90, 7');
  assert.deepEqual(got.missingValues, [-1, 7]);
  assert.deepEqual(got.missingRanges, [[-99, -90]]);
});

test('a reversed span is swapped, not dropped', () => {
  // designatedMissingSql emits `BETWEEN lo AND hi` and skips the range when hi < lo — so
  // accepting `0 to -99` verbatim would look accepted and then match nothing at all.
  assert.deepEqual(ranges('0 to -99'), [[-99, 0]]);
});

test('a span whose ends are equal is a code, which is all it ever meant', () => {
  assert.deepEqual(ranges('-9 to -9'), []);
  assert.deepEqual(codes('-9 to -9'), [-9]);
});

test('a bare hyphen is NOT a span, because minus signs make it ambiguous', () => {
  // `-99 - -90` could be a range or an expression; every missing code in practice is
  // negative, so guessing here would be guessing often.
  assert.deepEqual(ranges('-99 - -90'), []);
  assert.deepEqual(codes('-99 - -90'), ['-99 - -90']);
});

test('text that merely contains the word stays a plain code', () => {
  assert.deepEqual(ranges('3 to 5 years'), []);
  assert.deepEqual(codes('3 to 5 years'), ['3 to 5 years']);
  assert.deepEqual(codes('1.2.3 to 4'), ['1.2.3 to 4'], 'a non-numeric end is not a NaN range');
});

test('decimals and exponents are real bounds', () => {
  assert.deepEqual(ranges('-1.5 to 0.25'), [[-1.5, 0.25]]);
  assert.deepEqual(ranges('-1e3 to -1'), [[-1000, -1]]);
});

// =============================================================================
// The round trip — the part the bug was actually about
// =============================================================================

test('a variable with a span opens showing it, instead of showing an empty box', () => {
  const meta = { missingValues: [-1], missingRanges: [[-999999, 0]] };
  assert.equal(formatMissingSpec(meta), '-1, -999999 to 0');
});

test('open, save untouched, and nothing about the variable changes', () => {
  const meta = { missingValues: [-1, 'NA'], missingRanges: [[-99, -90], [500, 600]] };
  const reparsed = splitMissingSpec(formatMissingSpec(meta));
  assert.deepEqual(reparsed.missingValues, meta.missingValues);
  assert.deepEqual(reparsed.missingRanges, meta.missingRanges);
});

test('clearing the box clears the span too — the symptom that made this worth fixing', () => {
  // Both keys come back empty, and applyPatch deletes a key whose value is an empty
  // array. Before this, the patch never mentioned missingRanges, the merge left it in
  // place, and the variable kept treating the span as missing with nothing on screen.
  const got = splitMissingSpec('');
  assert.deepEqual(got.missingRanges, []);
  assert.ok('missingRanges' in got, 'the key must be PRESENT and empty, not absent');
});

test('consecutive codes are NOT compressed into a span on the way out', () => {
  // The trap: summariseMissing (the Variable View cell) renders 8, 9, 10 as "8 to 10",
  // and reusing it here would mean the next Save read three codes back as a RANGE —
  // silently declaring 8.5 missing as well. The editor must round-trip, not summarise.
  assert.equal(formatMissingSpec({ missingValues: [8, 9, 10] }), '8, 9, 10');
  assert.deepEqual(ranges(formatMissingSpec({ missingValues: [8, 9, 10] })), []);
});

test('a malformed stored range is skipped rather than rendered as NaN', () => {
  assert.equal(formatMissingSpec({ missingValues: [-1], missingRanges: [[NaN, 0], null, [1, 2]] }), '-1, 1 to 2');
});

test('no metadata at all is an empty field, not a crash', () => {
  assert.equal(formatMissingSpec(undefined), '');
  assert.equal(formatMissingSpec({}), '');
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

test('the dialog writes BOTH keys, which is what lets it clear a span', () => {
  const src = readFileSync('core/data-views.js', 'utf8');
  assert.match(src, /\.\.\.splitMissingSpec\(form\.missing\.value\)/);
  assert.doesNotMatch(src, /missingValues: parseMissing/, 'the one-key save is gone');
});

test('the hint teaches the span syntax, since nobody would guess it', () => {
  const src = readFileSync('core/data-views.js', 'utf8');
  assert.match(src, /one per line, or comma-separated; a span is/);
  assert.match(src, /-99 to -90/);
});
