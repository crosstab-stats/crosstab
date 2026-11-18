/**
 * @file table-budget.test.mjs
 * Routing an import out-of-core because of what is ALREADY loaded.
 *
 * ## What happened
 *
 * `loadWide` has said for a while that "DuckDB-WASM's checkpoint can't accumulate past
 * ~600 MB and can't spill (OPFS temp is unimplemented)" — that is why the out-of-core
 * Parquet path exists at all. What nobody noticed is that the ceiling belongs to the
 * DATABASE while `isWideDataset` judges one FILE. So imports that are each individually
 * fine walk into it together.
 *
 * The owner imported College Scorecard years back to back, each 3,379 columns, none of
 * them "wide" by the per-file rule:
 *
 *     table 1   6,272 rows  ~170 MB   ok
 *     table 2   6,430 rows  ~175 MB   ok       (~345 MB loaded)
 *     table 3   7,766 rows  ~211 MB   FATAL    (~556 MB loaded)
 *
 *     FATAL Error: Failed to create checkpoint: Out of Memory Error: Allocation failure
 *
 * The log showed `rowsIngested: 7766` — the whole file in, dying 18 seconds later while
 * writing itself out. FATAL invalidates the database, so the two good tables went too.
 *
 * The budget is bracketed by those two observations rather than picked: ~345 MB works,
 * ~556 MB does not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { estimateTableBytes, exceedsTableBudget, TABLE_BYTE_BUDGET } =
  await import('../core/duckdb-manager.js');

const MiB = 1024 * 1024;
/** The owner's file shape: 3,360 numeric + 19 text, as the picker now types it. */
const SCORECARD = [
  ...Array.from({ length: 3360 }, () => ({ type: 'numeric' })),
  ...Array.from({ length: 19 }, () => ({ type: 'string' })),
];

// =============================================================================
// The estimate
// =============================================================================

test('a numeric column is 8 bytes a row, a text column 16', () => {
  assert.equal(estimateTableBytes([{ type: 'numeric' }], 1), 8 + 8, 'plus the row id');
  assert.equal(estimateTableBytes([{ type: 'string' }], 1), 8 + 16);
  assert.equal(estimateTableBytes([{ type: 'numeric' }, { type: 'string' }], 10), (8 + 8 + 16) * 10);
});

test('an empty or malformed shape costs nothing rather than throwing', () => {
  assert.equal(estimateTableBytes([], 1000), 8000, 'the row id still counts');
  assert.equal(estimateTableBytes(null, 10), 80);
  assert.equal(estimateTableBytes(SCORECARD, 0), 0);
  assert.equal(estimateTableBytes(SCORECARD, -5), 0);
});

test('the estimate reproduces the sizes actually observed', () => {
  // Within a few MB of the figures in the file comment, which is all this needs to be.
  const mb = (v) => Math.round(v / MiB);
  assert.ok(Math.abs(mb(estimateTableBytes(SCORECARD, 6272)) - 163) <= 12, mb(estimateTableBytes(SCORECARD, 6272)));
  assert.ok(Math.abs(mb(estimateTableBytes(SCORECARD, 7766)) - 202) <= 12, mb(estimateTableBytes(SCORECARD, 7766)));
});

// =============================================================================
// The decision, against the three real data points
// =============================================================================

test('the first Scorecard year stays a table', () => {
  assert.equal(exceedsTableBudget(0, SCORECARD, 6272), false);
});

test('the second still fits — the budget must not be so tight it never allows two', () => {
  const first = estimateTableBytes(SCORECARD, 6272);
  assert.equal(exceedsTableBudget(first, SCORECARD, 6430), false,
    'that combination was observed working');
});

test('the third goes out-of-core instead of killing the database', () => {
  const loaded = estimateTableBytes(SCORECARD, 6272) + estimateTableBytes(SCORECARD, 6430);
  assert.equal(exceedsTableBudget(loaded, SCORECARD, 7766), true,
    'this combination was observed FATAL-ing');
});

test('the budget sits between what worked and what did not', () => {
  const worked = estimateTableBytes(SCORECARD, 6272) + estimateTableBytes(SCORECARD, 6430);
  const died = worked + estimateTableBytes(SCORECARD, 7766);
  assert.ok(TABLE_BYTE_BUDGET > worked, 'must not reject a combination known to work');
  assert.ok(TABLE_BYTE_BUDGET < died, 'must reject the one known to be fatal');
});

// =============================================================================
// It must not disturb ordinary datasets
// =============================================================================

test('an ordinary survey is never routed out-of-core', () => {
  const survey = Array.from({ length: 40 }, () => ({ type: 'numeric' }));
  // 40 columns × 100,000 rows is 33 MB — a tenth of the budget on its own.
  assert.equal(exceedsTableBudget(0, survey, 100000), false);
  // And a working set of ten of them still fits, which is the case that matters: the
  // budget must not turn normal multi-dataset work into the slow path.
  assert.equal(exceedsTableBudget(9 * estimateTableBytes(survey, 100000), survey, 100000), false);
});

test('…but enough of them legitimately is over the ceiling', () => {
  // Not a quirk to work around: a hundred of those tables is 3.3 GB, which is exactly
  // what the checkpoint cannot write. Routing them out-of-core is the right answer.
  const survey = Array.from({ length: 40 }, () => ({ type: 'numeric' }));
  assert.equal(exceedsTableBudget(99 * estimateTableBytes(survey, 100000), survey, 100000), true);
});

test('dropping a dataset frees its share of the budget', () => {
  // The Map is keyed by table so a removed table stops counting; here that is the
  // arithmetic the DataStore getter performs.
  const one = estimateTableBytes(SCORECARD, 6272);
  assert.equal(exceedsTableBudget(one * 2, SCORECARD, 7766), true, 'two loaded: over');
  assert.equal(exceedsTableBudget(one, SCORECARD, 7766), false, 'one dropped: under again');
});

test('a single table larger than the whole budget is routed, not refused', () => {
  assert.equal(exceedsTableBudget(0, SCORECARD, 100000), true);
});
