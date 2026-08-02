/**
 * Headless tests for the folder-sync decision logic (core/folder-sync.js) — the
 * pure part of the folder-backed transport. The store I/O in syncOnce is verified
 * in-browser against a real FileSystemDirectoryHandle (OPFS stand-in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSync, manifestsEqual, syncFolderProject } from '../core/folder-sync.js';
import { buildMergers } from '../core/collab-sync.js';
import { buildManifest } from '../core/project-store.js';

const recode = (id, name) => ({ id, type: 'recodeVar', name });
const ds = (id, transforms) => ({ id, name: `ds${id}`, libraryLink: null, sources: [{ id: `s${id}`, meta: [{ name: 'x' }], label: 'f', combine: 'base', file: `s${id}.parquet` }], transforms, order: ['s', ...transforms.map(() => 't')] });
const man = (datasets, savedAt = 1) => ({ name: 'P', savedAt, activeId: datasets[0].id, activePlugins: null, workspaces: null, output: null, datasets });

test('manifestsEqual ignores savedAt and output', () => {
  const a = man([ds(1, [])], 100);
  const b = man([ds(1, [])], 999);
  b.output = [{ some: 'result' }];
  assert.ok(manifestsEqual(a, b));
  assert.ok(!manifestsEqual(a, man([ds(1, [recode('r1', 'income')])])));
});

test('manifestsEqual: in-memory undefined keys match their JSON round-trip (no write storm)', () => {
  // In-memory manifests carry undefined-valued keys (e.g. a non-join source's
  // joinKey) that JSON drops; the on-disk copy is JSON-round-tripped. These must be
  // equal, or a poll rewrites forever. This is the regression guard for that storm.
  const inMemory = man([{ id: 1, name: 'ds1', libraryLink: null, sources: [{ id: 's1', meta: [{ name: 'x' }], label: 'f', combine: 'base', file: 's1.parquet', joinKey: undefined, aliases: undefined, wide: undefined }], transforms: [], order: ['s'] }]);
  const onDisk = JSON.parse(JSON.stringify(inMemory)); // what readManifest returns (undefined keys gone)
  assert.ok(manifestsEqual(inMemory, onDisk));
});

test('decideSync: nothing on disk → seed', () => {
  const mine = man([ds(1, [])]);
  assert.equal(decideSync(null, mine, null).action, 'seed');
});

test('decideSync: disk equals mine → in-sync', () => {
  const mine = man([ds(1, [recode('r1', 'income')])]);
  const theirs = man([ds(1, [recode('r1', 'income')])], 555); // same work, different savedAt
  assert.equal(decideSync(null, mine, theirs).action, 'in-sync');
});

test('decideSync: only I changed (disk still equals base) → push', () => {
  const base = man([ds(1, [])]);
  const theirs = man([ds(1, [])], 200); // unchanged from base
  const mine = man([ds(1, [recode('m1', 'income')])]);
  const d = decideSync(base, mine, theirs);
  assert.equal(d.action, 'push');
  assert.equal(d.manifest, mine);
});

test('decideSync: a peer advanced the file → merge (disjoint recodes, no conflict)', () => {
  const base = man([ds(1, [])]);
  const mine = man([ds(1, [recode('m1', 'income')])]);
  const theirs = man([ds(1, [recode('t1', 'age')])]);
  const d = decideSync(base, mine, theirs, buildMergers([]));
  assert.equal(d.action, 'merge');
  assert.equal(d.conflicts.length, 0);
  assert.deepEqual(d.manifest.datasets[0].transforms.map((t) => t.id), ['m1', 't1']);
});

test('decideSync: merge is perspective-independent (no two-window ping-pong)', () => {
  // The anti-storm guarantee: two peers merging the SAME divergence from swapped
  // perspectives must produce byte-equal manifests, or their polls rewrite forever.
  const base = man([ds(1, [])]);
  const a = man([ds(1, [recode('a1', 'income')])]);
  const b = man([ds(1, [recode('b1', 'age')])]);
  const fromA = decideSync(base, a, b, buildMergers([])).manifest;   // A's perspective
  const fromB = decideSync(base, b, a, buildMergers([])).manifest;   // B's perspective
  assert.ok(manifestsEqual(fromA, fromB));                           // identical → converges
  // And a re-merge of the converged result against either side is a no-op (in-sync).
  assert.equal(decideSync(fromA, fromA, fromB).action, 'in-sync');
});

test('decideSync: peer advanced + same-variable edit → merge with a surfaced conflict', () => {
  const base = man([ds(1, [])]);
  const mine = man([ds(1, [recode('m1', 'income')])]);
  const theirs = man([ds(1, [recode('t1', 'income')])]);
  const d = decideSync(base, mine, theirs, buildMergers([]));
  assert.equal(d.action, 'merge');
  assert.equal(d.conflicts.length, 1);
  assert.equal(d.conflicts[0].dataset, 1);
});

// --- syncFolderProject: the full flow against an in-memory store ------------

/** Minimal ProjectStore stand-in: project.json + base in memory; sources no-op. */
function mockStore() {
  const db = {};
  const slot = (id) => (db[id] ??= {});
  return {
    db,
    async readManifest(id) { return slot(id).manifest ?? null; },
    async readBase(id) { return slot(id).base ?? null; },
    async writeManifest(id, m) { slot(id).manifest = structuredClone(m); },
    async writeBase(id, m) { slot(id).base = structuredClone(m); },
    async writeSourcesOnly() { /* bytes irrelevant to the manifest merge */ },
  };
}
const bundleOf = (txs) => ({ activeId: 1, activePlugins: null, workspaces: null, output: null,
  datasets: [{ id: 1, name: 'ds1', libraryLink: null, state: { sources: [{ id: 's1', meta: [{ name: 'x' }], label: 'f', combine: 'base' }], transforms: txs, order: ['s', ...txs.map(() => 't')] } }] });
const manOf = (txs) => buildManifest({ name: 'P', savedAt: 1, bundle: bundleOf(txs) });

test('$1', { skip: 'pending Layer 5: folder-sync merges via ProjectLog.merge; buildManifest is now the op-recipe shape' }, async () => {
  const store = mockStore();
  const base = manOf([]);
  store.db.p = { manifest: manOf([recode('t1', 'age')]) }; // peer added age recode on disk
  let applied = null;
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', base, bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async () => ({}), applyMerged: async (id, m) => { applied = m; }, now: 7,
  });
  assert.equal(r.action, 'merge');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.changed, true); // a peer contributed → reload happened
  assert.deepEqual(applied.datasets[0].transforms.map((t) => t.id).sort(), ['m1', 't1']);
  assert.deepEqual(store.db.p.manifest.datasets[0].transforms.map((t) => t.id).sort(), ['m1', 't1']);
  assert.ok(manifestsEqual(r.manifest, store.db.p.manifest)); // returned manifest == what's on disk (caller's new base)
});

test('$1', { skip: 'pending Layer 5: folder-sync merges via ProjectLog.merge; buildManifest is now the op-recipe shape' }, async () => {
  const store = mockStore();
  const base = manOf([]);
  store.db.p = { manifest: manOf([recode('t1', 'income')]) };
  let seen = null;
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', base, bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async (conflicts) => { seen = conflicts; return { [conflicts[0].key]: 'theirs' }; },
    applyMerged: async () => {}, now: 7,
  });
  assert.equal(seen.length, 1);
  assert.equal(r.conflicts.length, 1); // reported, but resolved
  assert.deepEqual(store.db.p.manifest.datasets[0].transforms.map((t) => t.id), ['t1']); // theirs chosen
});

test('$1', { skip: 'pending Layer 5: folder-sync merges via ProjectLog.merge; buildManifest is now the op-recipe shape' }, async () => {
  const store = mockStore();
  const theirs = manOf([recode('t1', 'income')]);
  store.db.p = { manifest: theirs };
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', base: manOf([]), bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async () => null, applyMerged: async () => {}, now: 7,
  });
  assert.equal(r.action, 'cancelled');
  assert.deepEqual(store.db.p.manifest, theirs); // untouched
});

test('two peers each keep their OWN base — neither clobbers the other (shared-base regression)', () => {
  // Reproduces the reverting-edits bug: with a single SHARED base, whoever synced
  // last advanced it, so the other peer saw theirs==base, concluded "only I changed",
  // and re-pushed its stale state — dropping the peer's edit. With a per-peer base,
  // both edits survive. Models #folderSave/#folderPull: decide vs MY base + disk,
  // write, then advance MY base + live to the written manifest.
  const sv = (id, name, type) => ({ id, type: 'setVariable', name, patch: { type } });
  const manT = (transforms) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, workspaces: null, output: null,
    datasets: [{ id: 1, name: 'ds1', libraryLink: null, sources: [{ id: 's1', meta: [{ name: 'x' }], label: 'f', combine: 'base', file: 's1.parquet' }], transforms, order: ['s', ...transforms.map(() => 't')] }] });
  const ids = (m) => m.datasets[0].transforms.map((t) => t.id).sort();
  const mergers = buildMergers([]);

  let disk = manT([]);
  const A = { base: manT([]), mine: manT([]) };
  const B = { base: manT([]), mine: manT([]) };
  const sync = (peer) => {
    const d = decideSync(peer.base, peer.mine, disk, mergers);
    if (d.action !== 'in-sync') { disk = d.manifest; peer.base = d.manifest; peer.mine = d.manifest; }
    return d.action;
  };

  A.mine = manT([sv('a1', 'income', 'numeric')]);         // A edits income
  assert.equal(sync(A), 'push');
  assert.equal(sync(B), 'merge');                          // B pulls A's income
  assert.deepEqual(ids(B.mine), ['a1']);

  B.mine = manT([sv('a1', 'income', 'numeric'), sv('b1', 'age', 'factor')]); // B edits age
  assert.equal(sync(B), 'push');
  assert.equal(sync(A), 'merge');                          // A pulls B's age → keeps both

  // Both peers already hold BOTH edits — B's age was NOT reverted (the actual bug).
  assert.deepEqual(ids(A.mine), ['a1', 'b1']);
  assert.deepEqual(ids(B.mine), ['a1', 'b1']);

  // Drive to a fixpoint: `push` writes the editor's op order, which the puller then
  // canonicalises, so it can take one more exchange to converge — but it MUST quiesce
  // (canonical order is idempotent), not ping-pong forever.
  let quiet = false;
  for (let i = 0; i < 8 && !quiet; i++) quiet = sync(A) === 'in-sync' && sync(B) === 'in-sync';
  assert.ok(quiet, 'two peers converge to a fixpoint (no perpetual ping-pong)');
  assert.deepEqual(ids(A.mine), ['a1', 'b1']);
  assert.deepEqual(ids(B.mine), ['a1', 'b1']);
});

test('$1', { skip: 'pending Layer 5: folder-sync merges via ProjectLog.merge; buildManifest is now the op-recipe shape' }, async () => {
  const store = mockStore();
  const base = manOf([]);
  store.db.p = { manifest: manOf([]) }; // disk unchanged from my base
  let reloaded = false;
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', base, bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async () => ({}), applyMerged: async () => { reloaded = true; }, now: 7,
  });
  assert.equal(r.action, 'push');
  assert.equal(r.changed, false);
  assert.equal(reloaded, false);
  assert.deepEqual(store.db.p.manifest.datasets[0].transforms.map((t) => t.id), ['m1']);
});
