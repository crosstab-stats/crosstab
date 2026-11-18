/**
 * @file table-budget-wiring.test.mjs
 * That the table budget is actually CONSULTED — which it was not.
 *
 * ## What happened
 *
 * table-budget.test.mjs passed throughout, because it tests the arithmetic. The
 * arithmetic was fine. The budget still did nothing at all, for two reasons, and the
 * owner's log said so plainly on three consecutive imports:
 *
 *     [import] route {wide: false, declaredWide: false, overBudget: false, loadedMiB: 0}
 *
 * `loadedMiB: 0` with two 3,379-column tables already resident.
 *
 *  1. `DatasetManager` forwards the DataStore interface method by method, and these two
 *     were never added. The call site used `wouldExceedTableBudget?.(…)`, so a missing
 *     method became a silent `false` instead of a TypeError. The third import built its
 *     table and FATAL-ed exactly as it had before any of this existed.
 *
 *  2. Deeper: the total was kept PER DataStore, which is per-DATASET. Every import makes
 *     a new dataset, so even once forwarded it would have asked a store created seconds
 *     earlier and been told ~0. The checkpoint ceiling belongs to the DuckDB INSTANCE,
 *     and one instance is shared by every dataset — so the total has to live there.
 *
 * These tests are about the chain, not the sum. Checking the links is not checking the
 * chain; the same lesson import-liveness learned when `progress` was missing from one of
 * four places.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { DuckDBManager, estimateTableBytes, TABLE_BYTE_BUDGET } =
  await import('../core/duckdb-manager.js');
const { stripComments } = await import('../core/plugin-modules.js');

/** The owner's shape, as the picker types it. */
const SCORECARD = [
  ...Array.from({ length: 3360 }, () => ({ type: 'numeric' })),
  ...Array.from({ length: 19 }, () => ({ type: 'string' })),
];

// =============================================================================
// The total lives on the shared instance
// =============================================================================

test('the running total is kept by the DuckDB instance', () => {
  const db = new DuckDBManager();
  assert.equal(db.loadedTableBytes, 0, 'nothing loaded yet');
  db.noteTableBytes('t1', 100);
  db.noteTableBytes('t2', 250);
  assert.equal(db.loadedTableBytes, 350, 'across tables, not per dataset');
});

test('a dropped table stops counting', () => {
  const db = new DuckDBManager();
  db.noteTableBytes('t1', 100);
  db.noteTableBytes('t2', 250);
  db.forgetTable('t1');
  assert.equal(db.loadedTableBytes, 250);
  db.forgetTable('nonexistent'); // must not throw or go negative
  assert.equal(db.loadedTableBytes, 250);
});

test('re-noting a table replaces rather than doubles it', () => {
  const db = new DuckDBManager();
  db.noteTableBytes('t1', 100);
  db.noteTableBytes('t1', 400);
  assert.equal(db.loadedTableBytes, 400);
});

test('the three Scorecard years reproduce the real decision', () => {
  // The exact sequence that FATAL-ed, now answered from one shared instance.
  const db = new DuckDBManager();
  assert.equal(db.wouldExceedTableBudget(SCORECARD, 6272), false, 'first: a table');
  db.noteTableBytes('ct_src_1', estimateTableBytes(SCORECARD, 6272));

  assert.equal(db.wouldExceedTableBudget(SCORECARD, 6430), false, 'second: still a table');
  db.noteTableBytes('ct_src_2', estimateTableBytes(SCORECARD, 6430));

  assert.equal(db.wouldExceedTableBudget(SCORECARD, 7766), true, 'third: OUT OF CORE');
  assert.ok(db.loadedTableBytes > 0, `and the total is not zero (was ${db.loadedTableBytes})`);
});

test('garbage byte counts cannot poison the total', () => {
  const db = new DuckDBManager();
  db.noteTableBytes('a', -5);
  db.noteTableBytes('b', NaN);
  db.noteTableBytes('c', undefined);
  assert.equal(db.loadedTableBytes, 0);
});

// =============================================================================
// The chain — every link, because a missing one is silent
// =============================================================================

test('DatasetManager forwards both halves of the budget', () => {
  // The link that was missing. It delegates the DataStore interface method by method,
  // so anything not written out here simply is not there.
  const src = readFileSync('core/dataset-manager.js', 'utf8');
  assert.match(src, /get loadedTableBytes\(\)/, 'the getter is forwarded');
  assert.match(src, /wouldExceedTableBudget\(variables, rowCount\)/, 'the method is forwarded');
});

test('DataStore defers to the instance instead of keeping its own total', () => {
  const src = readFileSync('core/data-store.js', 'utf8');
  assert.match(src, /return this\.#duckdb\.loadedTableBytes/, 'the getter delegates');
  assert.match(src, /return this\.#duckdb\.wouldExceedTableBudget/, 'the method delegates');
  assert.doesNotMatch(src, /#tableBytes/, 'and keeps no per-dataset map of its own');
  assert.match(src, /this\.#duckdb\.noteTableBytes\(/, 'an ingested table is recorded');
  assert.match(src, /this\.#duckdb\.forgetTable\(/, 'a dropped table is forgotten');
});

test('the import does NOT optional-call the budget', () => {
  // `?.` is what turned a missing method into "no, carry on" for three imports running.
  // If the wiring breaks again it must throw, loudly, rather than quietly reverting to
  // the behaviour that destroys the database.
  // Comments stripped FIRST. The comment at that call site quotes the broken form on
  // purpose, to say why it is not written that way — and this assertion matched the
  // explanation rather than the code. Asserting an ABSENCE over raw source is a trap
  // this repo has fallen into repeatedly; `stripComments` exists for it.
  const src = stripComments(readFileSync('core/import-service.js', 'utf8'));
  assert.doesNotMatch(src, /wouldExceedTableBudget\?\./,
    'an optional call here hides exactly the failure this guards against');
  assert.match(src, /this\.#data\.wouldExceedTableBudget\(/, 'it is called directly');
});

test('the budget is still bracketed by the observations', () => {
  const worked = estimateTableBytes(SCORECARD, 6272) + estimateTableBytes(SCORECARD, 6430);
  const died = worked + estimateTableBytes(SCORECARD, 7766);
  assert.ok(TABLE_BYTE_BUDGET > worked && TABLE_BYTE_BUDGET < died);
});
