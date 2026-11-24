/**
 * @file storage-scan.test.mjs
 * The lost-file scan, and mostly the cases where it must REFUSE.
 *
 * The feature is a delete button over a directory, so the interesting assertions are not
 * "does it find the garbage" but "does it leave everything else alone". Three gates have
 * to hold — the name is one we write, no other session is open, and the file is neither
 * live here nor warm — and each one is the only thing standing between a scan and
 * somebody's data. They are tested one at a time, each with a pair that differs in just
 * that gate, so a gate that stops working fails a test rather than passing a weaker one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  TAB_LOCK, WARM_MS, isWorkingFile, baseFileOf, lostAmong, openSessions,
  holdSessionLock, scanLostFiles, deleteLostFiles,
} = await import('../core/storage-scan.js');

const NOW = 1_700_000_000_000;
const old = (name, bytes = 1024) => ({ name, bytes, modifiedAt: NOW - 10 * WARM_MS });

/** A lock manager with `n` CrossTab sessions holding the shared lock. */
const locksWith = (n, extra = []) => ({
  query: async () => ({
    held: [...Array.from({ length: n }, () => ({ name: TAB_LOCK, mode: 'shared' })), ...extra],
    pending: [],
  }),
});

// =============================================================================
// Gate 1: only names we write
// =============================================================================

test('it recognises exactly the working files CrossTab writes', () => {
  // The real shapes, from the code that builds them: `DataStore#load` names the source,
  // `DuckDBManager` names the streaming parts, and a hard restore stages one more.
  assert.ok(isWorkingFile('ct_src_208730065967544_2.parquet'), 'a wide source');
  assert.ok(isWorkingFile('ct_src_1_2__part9.parquet'), 'a streaming part');
  assert.ok(isWorkingFile('ct_src_1_2__merge3.parquet'), 'a merge part');
  assert.ok(isWorkingFile('ct_src_7_1_restore.parquet'), 'a restore staging file');
});

test('and NOTHING else — the allow-list is the safety, not a filter', () => {
  // Every one of these is either another subsystem's, a project's own data, or a user's
  // file that happens to be here. The scan must be blind to all of them forever: an
  // unfamiliar name is left alone, which is the safe direction to be wrong in.
  for (const name of [
    'projects', 'crosstab-projects.json', 'crosstab-project.json',
    'src_12345.parquet',            // a project's OWN sidecar, inside projects/<id>/
    'ct_export_3.parquet',          // DuckDB's internal FS, never OPFS — but be sure
    'my data.parquet', 'notes.txt', 'ct_src_.parquet', 'ct_src_abc_1.parquet',
    'xct_src_1_2.parquet', 'ct_src_1_2.parquet.bak', 'ct_src_1_2.csv',
  ]) {
    assert.equal(isWorkingFile(name), false, name);
  }
});

test('a part is owned by its source, so an active ingest is not mistaken for litter', () => {
  // `ct_src_7_2__part3` belongs to `ct_src_7_2`, and only the latter is ever registered
  // by a dataset. Without this the parts of a live wide dataset would read as lost.
  assert.equal(baseFileOf('ct_src_7_2__part3.parquet'), 'ct_src_7_2.parquet');
  assert.equal(baseFileOf('ct_src_7_2_restore.parquet'), 'ct_src_7_2.parquet');
  assert.equal(baseFileOf('ct_src_7_2.parquet'), 'ct_src_7_2.parquet', 'a source is its own base');

  const entries = [old('ct_src_7_2.parquet'), old('ct_src_7_2__part3.parquet')];
  assert.deepEqual(
    lostAmong({ entries, live: ['ct_src_7_2.parquet'], now: NOW }),
    [], 'a live source did not protect its own parts',
  );
  assert.equal(lostAmong({ entries, live: [], now: NOW }).length, 2, 'and both go when it is not live');
});

// =============================================================================
// Gate 3: live here, or too warm to judge
// =============================================================================

test('a file this session is using is never lost', () => {
  const entries = [old('ct_src_1_1.parquet'), old('ct_src_2_1.parquet')];
  const got = lostAmong({ entries, live: ['ct_src_1_1.parquet'], now: NOW });
  assert.deepEqual(got.map((f) => f.name), ['ct_src_2_1.parquet']);
});

test('a file written seconds ago is left alone, because an ingest may not have registered it', () => {
  // The race this closes: `openIngest` writes parts before `#wideFiles` knows the source,
  // so a scan running at that moment would see real working data with no owner.
  const warm = { name: 'ct_src_9_1.parquet', bytes: 10, modifiedAt: NOW - 1000 };
  const cold = { name: 'ct_src_9_2.parquet', bytes: 10, modifiedAt: NOW - WARM_MS - 1 };
  const got = lostAmong({ entries: [warm, cold], live: [], now: NOW });
  assert.deepEqual(got.map((f) => f.name), ['ct_src_9_2.parquet']);
});

test('the biggest file is listed first, since the point is reclaiming space', () => {
  const got = lostAmong({
    entries: [old('ct_src_1_1.parquet', 10), old('ct_src_2_1.parquet', 5000), old('ct_src_3_1.parquet', 300)],
    live: [], now: NOW,
  });
  assert.deepEqual(got.map((f) => f.bytes), [5000, 300, 10]);
});

// =============================================================================
// Gate 2: no other session — the one that makes "nobody owns this" provable
// =============================================================================

test('one session holding the lock means this tab is alone', async () => {
  assert.equal(await openSessions(locksWith(1)), 1);
  assert.equal(await openSessions(locksWith(3)), 3);
  // Other locks in the same origin are not ours and must not be counted.
  assert.equal(await openSessions(locksWith(1, [{ name: 'something-else' }])), 1);
});

test('no Web Locks, or a query that throws, is UNKNOWN and never one', async () => {
  // The distinction the whole safety argument rests on. "Cannot tell" must not collapse
  // into the permissive answer, which is what a `?? 1` would have done.
  // `null`, not `undefined`: a default parameter only fires for `undefined`, and this
  // Node has a real `navigator.locks` — which would make the no-API case quietly test the
  // present-API one and pass for the wrong reason.
  assert.equal(await openSessions(null), null);
  assert.equal(await openSessions({}), null, 'an object with no query()');
  assert.equal(await openSessions({ query: async () => { throw new Error('nope'); } }), null);
});

test('the session lock is SHARED, so a second tab is never left waiting on the first', () => {
  // Exclusive mode would make every tab after the first queue forever on a lock that is
  // held for the life of the page — and the count would then always read 1, which is the
  // wrong answer in the dangerous direction.
  const calls = [];
  holdSessionLock({ request: (name, opts) => { calls.push([name, opts]); return new Promise(() => {}); } });
  assert.deepEqual(calls, [[TAB_LOCK, { mode: 'shared' }]]);
});

test('a scan with another tab open REPORTS but refuses', async () => {
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet', 4096)],
    openSessions: async () => 2,
  };
  const got = await scanLostFiles({ live: [], now: NOW, deps });
  assert.equal(got.blocked, 'other-tabs');
  assert.equal(got.files.length, 1, 'the files are still reported — the bytes are real either way');
  assert.equal(got.bytes, 4096);
});

test('a scan that cannot count sessions refuses too, and says which refusal it is', async () => {
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet')],
    openSessions: async () => null,
  };
  assert.equal((await scanLostFiles({ live: [], now: NOW, deps })).blocked, 'unknown-sessions');
});

test('alone, with cold unowned files, it is not blocked', async () => {
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet', 2048)],
    openSessions: async () => 1,
  };
  const got = await scanLostFiles({ live: [], now: NOW, deps });
  assert.equal(got.blocked, null);
  assert.equal(got.bytes, 2048);
});

// =============================================================================
// Deleting: the agreed list is re-checked, never trusted
// =============================================================================

test('it deletes only what the user agreed to AND what is still lost', async () => {
  const removed = [];
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet'), old('ct_src_2_1.parquet'), old('ct_src_3_1.parquet')],
    openSessions: async () => 1,
    getDirectory: async () => ({ removeEntry: async (n) => { removed.push(n); } }),
  };
  // Agreed to two; one of them has since become live, so only the other may go.
  const got = await deleteLostFiles({
    names: ['ct_src_1_1.parquet', 'ct_src_2_1.parquet'],
    live: ['ct_src_2_1.parquet'],
    now: NOW,
    deps,
  });
  assert.deepEqual(removed, ['ct_src_1_1.parquet']);
  assert.deepEqual(got.removed, ['ct_src_1_1.parquet']);
  assert.equal(got.blocked, null);
});

test('a tab opened while the dialog sat there cancels the whole delete', async () => {
  // The contract, not belt and braces: a confirm box stays up for as long as someone
  // reads it, and the safety condition can change underneath it. Nothing is removed.
  const removed = [];
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet')],
    openSessions: async () => 2, // the second tab arrived after the scan
    getDirectory: async () => ({ removeEntry: async (n) => { removed.push(n); } }),
  };
  const got = await deleteLostFiles({ names: ['ct_src_1_1.parquet'], live: [], now: NOW, deps });
  assert.equal(got.blocked, 'other-tabs');
  assert.deepEqual(removed, [], 'a file was deleted after the safety condition lapsed');
  assert.equal(got.bytes, 0);
});

test('a name that was never scanned cannot be deleted by passing it in', async () => {
  // The agreed list is an intersection, not an instruction: the scan decides what is
  // eligible and the user decides which of those go.
  const removed = [];
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet')],
    openSessions: async () => 1,
    getDirectory: async () => ({ removeEntry: async (n) => { removed.push(n); } }),
  };
  await deleteLostFiles({ names: ['projects', 'crosstab-projects.json'], live: [], now: NOW, deps });
  assert.deepEqual(removed, []);
});

test('a removal that fails is reported, not counted as freed', async () => {
  const deps = {
    listRoot: async () => [old('ct_src_1_1.parquet', 100), old('ct_src_2_1.parquet', 200)],
    openSessions: async () => 1,
    getDirectory: async () => ({
      removeEntry: async (n) => { if (n === 'ct_src_1_1.parquet') throw new Error('locked'); },
    }),
  };
  const got = await deleteLostFiles({
    names: ['ct_src_1_1.parquet', 'ct_src_2_1.parquet'], live: [], now: NOW, deps,
  });
  assert.deepEqual(got.failed, ['ct_src_1_1.parquet']);
  assert.deepEqual(got.removed, ['ct_src_2_1.parquet']);
  assert.equal(got.bytes, 200, 'a failed removal inflated the freed total');
});
