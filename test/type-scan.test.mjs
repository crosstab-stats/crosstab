/**
 * @file type-scan.test.mjs
 * The shared typing rule — one implementation, every codec that infers types.
 *
 * ## Why it is shared
 *
 * It was written inside builtin-csv-codec, and builtin-excel-codec carried a comment
 * saying its own typing "mirrors the CSV codec". That mirroring is exactly why fixing
 * CSV's mistyping left Excel with all of it: measured on the same 3,379-column Scorecard
 * year, CSV typed 3,360 columns numeric and Excel typed 211.
 *
 * Typing text is a property of tabular data, not of a file format, so it lives in the
 * host now and the codecs drive it. After the move, the same file through the Excel
 * codec types 3,360 / 19 — identical to CSV.
 *
 * ## What is genuinely per-format
 *
 * Only the question "does this value count as a number". A text format has nothing but
 * text, so "parses as finite" is all there is. A spreadsheet already knows the
 * difference, and Excel's reader has always required a real JS number — which is what
 * keeps a ZIP code stored as text from being parsed into a number that has lost its
 * leading zero. That predicate is a parameter; everything above it is shared.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { createTypeScan } = await import('../core/plugin-stdlib.js');

/** Feed rows, return the scan. */
const scanOf = (rows, opts) => {
  const s = createTypeScan(opts);
  for (const r of rows) s.observeRow(r);
  return s;
};
const candidates = (s) => Object.fromEntries(s.proposal().candidates.map((c) => [c.value, c.columns]));

// =============================================================================
// The rule
// =============================================================================

test('a column is numeric only if every value is', () => {
  const s = scanOf([['1', '1'], ['2', 'x'], ['3', '3']], { columns: 2 });
  assert.deepEqual(s.decide([]).isNumeric, [true, false]);
});

test('an accepted code stops counting against a column', () => {
  const s = scanOf([['1', '1'], ['2', 'NA'], ['3', '3']], { columns: 2 });
  assert.deepEqual(s.decide(['NA']).isNumeric, [true, true]);
});

test('a column with no values at all stays text', () => {
  const s = scanOf([['1', ''], ['2', '']], { columns: 2 });
  assert.deepEqual(s.decide(['NA']).isNumeric, [true, false]);
});

test('a column that is ALL code is numeric and entirely missing', () => {
  const s = scanOf([['1', 'NA'], ['2', 'NA']], { columns: 2 });
  const d = s.decide(['NA']);
  assert.equal(d.isNumeric[1], true);
  assert.equal(d.isMissing('NA'), true);
});

test('isMissing covers blanks, nulls and accepted codes — and nothing else', () => {
  const d = scanOf([['1']], { columns: 1 }).decide(['NA']);
  assert.equal(d.isMissing(''), true);
  assert.equal(d.isMissing(null), true);
  assert.equal(d.isMissing(undefined), true);
  assert.equal(d.isMissing('NA'), true);
  assert.equal(d.isMissing('0'), false);
  assert.equal(d.isMissing('x'), false);
});

// =============================================================================
// The two guards
// =============================================================================

test('a text column with few distinct values is not proposed', () => {
  // No number in it, so its values can never become candidate codes.
  const s = scanOf([['Public'], ['Private Nonprofit'], ['Public']], { columns: 1 });
  assert.deepEqual(candidates(s), {});
});

test('a high-cardinality column stops being tracked', () => {
  const rows = Array.from({ length: 30 }, (_v, i) => [`Institution ${i}`]);
  assert.deepEqual(candidates(scanOf(rows, { columns: 1 })), {});
});

// =============================================================================
// The per-format predicate — the only thing codecs disagree about
// =============================================================================

test('the text rule parses a numeric-looking string', () => {
  const s = scanOf([['01234'], ['5678']], { columns: 1 });
  assert.deepEqual(s.decide([]).isNumeric, [true], 'CSV has nothing but text to go on');
});

test('the spreadsheet rule does NOT, which is what saves a ZIP code', () => {
  const EXCEL = (v) => typeof v === 'number' && Number.isFinite(v);
  const s = scanOf([['01234'], ['5678']], { columns: 1, numeric: EXCEL });
  assert.deepEqual(s.decide([]).isNumeric, [false], 'text cells stay text, leading zero intact');
  const real = scanOf([[1234], [5678]], { columns: 1, numeric: EXCEL });
  assert.deepEqual(real.decide([]).isNumeric, [true], 'real numeric cells still type numeric');
});

test('a spreadsheet column of numbers with an "NA" cell is still recovered', () => {
  const EXCEL = (v) => typeof v === 'number' && Number.isFinite(v);
  const s = scanOf([[1], ['NA'], [3]], { columns: 1, numeric: EXCEL });
  assert.deepEqual(candidates(s), { NA: 1 }, 'proposed');
  assert.deepEqual(s.decide(['NA']).isNumeric, [true]);
});

// =============================================================================
// Shape
// =============================================================================

test('width can be discovered from the rows rather than declared', () => {
  const s = createTypeScan();
  s.observeRow(['1', '2']);
  s.observeRow(['3', '4', 'x']);
  assert.deepEqual(s.decide([]).isNumeric, [true, true, false], 'the third column was learned');
});

test('rows are counted', () => {
  assert.equal(scanOf([['1'], ['2'], ['3']], { columns: 1 }).rows(), 3);
});

test('combinations are reported, because recovery is not a sum', () => {
  const s = scanOf([
    ['1', '1', '1'],
    ['NA', '2', 'NA'],
    ['3', 'PS', 'PS'],
  ], { columns: 3 });
  const combos = Object.fromEntries(s.proposal().combos.map((k) => [k.codes.join(' '), k.columns]));
  assert.deepEqual(combos, { NA: 1, PS: 1, 'NA PS': 1 });
  assert.deepEqual(s.decide(['NA']).isNumeric, [true, false, false]);
  assert.deepEqual(s.decide(['NA', 'PS']).isNumeric, [true, true, true]);
});
