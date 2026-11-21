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

const { DuckDBManager, estimateTableBytes, exceedsTableBudget, TABLE_BYTE_BUDGET } =
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
  // The sequence that FATAL-ed, answered from one shared instance. The DECISION is the
  // pure function here, with the capability supplied: a DuckDBManager that has never
  // initialised cannot know what the platform can do, and the next test is about what it
  // does with that.
  const db = new DuckDBManager();
  const over = (rows) => exceedsTableBudget(db.loadedTableBytes, SCORECARD, rows, true);

  assert.equal(over(6272), false, 'first: a table');
  db.noteTableBytes('ct_src_1', estimateTableBytes(SCORECARD, 6272));

  assert.equal(over(6430), false, 'second: still a table');
  db.noteTableBytes('ct_src_2', estimateTableBytes(SCORECARD, 6430));

  assert.equal(over(7766), true, 'third: OUT OF CORE');
  assert.ok(db.loadedTableBytes > 0, `and the total is not zero (was ${db.loadedTableBytes})`);
});

test('an uninitialised instance is CONSERVATIVE, not optimistic', async () => {
  // Nothing here can reach a real DuckDB, so the capability stays unknown — which is
  // exactly the state the first import found it in, and where the previous version read
  // `null !== false`, decided the platform could stream, and let an iPhone build the
  // table that killed it. Unknown must mean "assume it cannot".
  const db = new DuckDBManager();
  assert.equal(db.canStreamOutOfCore, null, 'unknown');
  assert.equal(await db.wouldExceedTableBudget(SCORECARD, 6272), true,
    'one Scorecard year goes out of core when we cannot confirm the platform streams');
  const survey = Array.from({ length: 40 }, () => ({ type: 'numeric' }));
  assert.equal(await db.wouldExceedTableBudget(survey, 100000), false,
    'but being conservative must not drag ordinary data onto the slow path');
});

test('the instance passes its streaming capability into the budget', () => {
  // The link that makes the WebKit budget apply at all. `wouldExceedTableBudget` is
  // synchronous and the first import's routing depends on it, which is why the
  // capability is probed during init rather than on first ingest.
  const src = stripComments(readFileSync('core/duckdb-manager.js', 'utf8'));
  assert.match(src, /exceedsTableBudget\(this\.loadedTableBytes, variables, rowCount, this\.#opfsHandleOk === true\)/,
    'the capability reaches the budget, and UNKNOWN counts as cannot-stream');
  assert.match(src, /await this\.#canUseOpfsHandles\(\)/,
    'it is probed during init');
  // The bug this replaces: the decision read the capability while it was still null,
  // because the first import routes BEFORE anything has touched DuckDB. `null !== false`
  // was true, the desktop budget applied, and the iPhone built the table that killed it.
  assert.match(src, /async wouldExceedTableBudget\(variables, rowCount\) \{[\s\S]*?await this\.#ensureReady\(\)/,
    'and the decision AWAITS readiness, so the answer exists when it is read');
});

test('every link in the budget chain awaits', () => {
  // An un-awaited async call here returns a Promise, which is truthy — so forgetting
  // one would route EVERYTHING out of core and look like a performance bug rather than
  // a wiring bug. Worth pinning at each hop.
  //
  // The hops changed on 2026-11-20: the import no longer asks the budget, because the
  // import no longer decides the route. `DuckDBManager#planIngest` does, and the one
  // `DataStore#load` awaits it — so the chain is shorter and every way into the engine
  // is on it, rather than only file imports.
  const dm = stripComments(readFileSync('core/duckdb-manager.js', 'utf8'));
  assert.match(dm, /async planIngest\(/, 'the plan is async');
  assert.match(dm, /const overBudget = await this\.wouldExceedTableBudget\(/,
    'and it AWAITS the budget rather than recomputing it — one computation, not two');
  // DataStore no longer re-exposes the budget check. It delegated it for one caller — the
  // routing block in import-service — and that block is gone, so the delegate had zero
  // callers. Removed rather than kept "for symmetry": an exposed check with nobody calling
  // it is an invitation to open a second routing site, which is the thing this consolidation
  // removed.
  const ds = stripComments(readFileSync('core/data-store.js', 'utf8'));
  assert.ok(!/async wouldExceedTableBudget\(/.test(ds),
    'a budget check with no caller invites a second routing site');
  assert.match(ds, /await this\.#duckdb\.planIngest\(variables, rowCount, \{ declaredWide \}\)/,
    'and the one load() awaits the plan');
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

test('DatasetManager forwards what the budget needs', () => {
  // The link that was missing, and the reason this file exists: DatasetManager delegates
  // the DataStore interface method by method, so anything not written out there simply
  // is not there, and `?.` at the call site turned the absence into "no, carry on".
  //
  // `wouldExceedTableBudget` is no longer forwarded, deliberately: it had exactly one
  // caller — the routing block in import-service — and that block is gone, because the
  // route is now decided inside `load`. A forwarder with no caller is an invitation to
  // open a second routing site, which is the thing being consolidated away.
  const src = readFileSync('core/dataset-manager.js', 'utf8');
  assert.match(src, /get loadedTableBytes\(\)/, 'the getter is forwarded');
  assert.match(src, /\n  load\(o\) \{\n    return this\.#target\(\)\.load\(o\);/,
    'the one way in is forwarded');
  assert.ok(!/wouldExceedTableBudget/.test(src),
    'a forwarded budget check with no caller invites a second routing site');
});

test('DataStore defers to the instance instead of keeping its own total', () => {
  const src = readFileSync('core/data-store.js', 'utf8');
  assert.match(src, /return this\.#duckdb\.loadedTableBytes/, 'the getter delegates');
  assert.doesNotMatch(src, /#tableBytes/, 'and keeps no per-dataset map of its own');
  assert.match(src, /this\.#duckdb\.noteTableBytes\(/, 'an ingested table is recorded');
  assert.match(src, /this\.#duckdb\.forgetTable\(/, 'a dropped table is forgotten');
});

test('the route decision is NOT optional-called', () => {
  // `?.` is what turned a missing method into "no, carry on" for three imports running.
  // If the wiring breaks again it must throw, loudly, rather than quietly reverting to
  // the behaviour that destroys the database.
  //
  // Comments stripped FIRST. The comment at the old call site quoted the broken form on
  // purpose, to say why it is not written that way — and this assertion matched the
  // explanation rather than the code. Asserting an ABSENCE over raw source is a trap this
  // repo has fallen into repeatedly; `stripComments` exists for it.
  //
  // The call site moved from import-service to `DataStore#load`, which is the point: one
  // site, on every path in, instead of one site on one of five.
  const ds = stripComments(readFileSync('core/data-store.js', 'utf8'));
  assert.doesNotMatch(ds, /planIngest\?\./,
    'an optional call here hides exactly the failure this guards against');
  assert.match(ds, /await this\.#duckdb\.planIngest\(/, 'it is called directly');

  // And the old site must not grow a second opinion back.
  const imp = stripComments(readFileSync('core/import-service.js', 'utf8'));
  assert.ok(!/wouldExceedTableBudget|planIngest/.test(imp),
    'import-service is deciding the route again');
});

test('the budget is still bracketed by the observations', () => {
  const worked = estimateTableBytes(SCORECARD, 6272) + estimateTableBytes(SCORECARD, 6430);
  const died = worked + estimateTableBytes(SCORECARD, 7766);
  assert.ok(TABLE_BYTE_BUDGET > worked && TABLE_BYTE_BUDGET < died);
});
