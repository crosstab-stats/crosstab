/**
 * Headless tests for the folder-sync decision logic (core/folder-sync.js) on the ONE
 * TRUE LOG. decideSync merges two flat op-logs by identity (no base): seed / in-sync /
 * merge. syncFolderProject is exercised against an in-memory store stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSync, manifestsEqual, syncFolderProject } from '../core/folder-sync.js';
import { buildMergers } from '../core/collab-sync.js';
import { buildManifest } from '../core/project-store.js';

let seq = 0;
const op = (id, target, type, payload = {}, wall = 1) => ({ id, hlc: { wall, counter: seq++ }, target, owner: 'core', type, payload, reads: [] });
const recode = (id, name) => op(id, `ds:1/var:${name}`, 'recodeVar', { name });
const ADD = op('add1', 'coll/ds:1', 'addDataset', { id: 1, name: 'ds1' });
const LOAD = op('load1', 'ds:1/source:s1', 'load', { src: { meta: [{ name: 'x' }], file: 'src_load1.parquet' } });
const man = (ops, savedAt = 1) => ({ name: 'P', savedAt, activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log: [ADD, LOAD, ...ops] });
const txIds = (m) => m.log.filter((o) => o.type === 'recodeVar').map((o) => o.payload.name).sort();

test('manifestsEqual ignores savedAt and output', () => {
  const a = man([], 100);
  const b = man([], 999);
  b.output = [{ some: 'result' }];
  assert.ok(manifestsEqual(a, b));
  assert.ok(!manifestsEqual(a, man([recode('r1', 'income')])));
});

test('decideSync: nothing on disk → seed', () => {
  assert.equal(decideSync(man([]), null).action, 'seed');
});

test('decideSync: disk equals mine (same op set) → in-sync', () => {
  const shared = recode('r1', 'income');
  assert.equal(decideSync(man([shared]), man([shared], 555)).action, 'in-sync');
});

test('decideSync: a peer advanced the file → merge (disjoint recodes, no conflict)', () => {
  const d = decideSync(man([recode('m1', 'income')]), man([recode('t1', 'age')]), buildMergers([]));
  assert.equal(d.action, 'merge');
  assert.equal(d.conflicts.length, 0);
  assert.deepEqual(txIds(d.manifest), ['age', 'income']);
});

test('decideSync: peer advanced + same-variable edit → merge with a surfaced conflict', () => {
  const d = decideSync(man([recode('m1', 'income')]), man([recode('t1', 'income')]), buildMergers([]));
  assert.equal(d.action, 'merge');
  assert.ok(d.conflicts.length >= 1);
});

test('decideSync: merge is perspective-independent (no two-window ping-pong)', () => {
  const a = man([recode('a1', 'income')]);
  const b = man([recode('b1', 'age')]);
  const fromA = decideSync(a, b, buildMergers([])).manifest; // A's perspective
  const fromB = decideSync(b, a, buildMergers([])).manifest; // B's perspective
  assert.ok(manifestsEqual(fromA, fromB)); // identical → converges
  assert.equal(decideSync(fromA, fromB).action, 'in-sync'); // re-merge of the converged result is a no-op
});

// --- syncFolderProject: the full flow against an in-memory store ------------

function mockStore() {
  const db = {};
  const slot = (id) => (db[id] ??= {});
  return {
    db,
    async readManifest(id) { return slot(id).manifest ?? null; },
    async writeManifest(id, m) { slot(id).manifest = structuredClone(m); },
    async writeSourcesOnly() { /* bytes irrelevant to the manifest merge */ },
  };
}
const bundleOf = (ops) => ({ activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log: [ADD, LOAD, ...ops] });

test('syncFolderProject: a peer contributed → merge, write, reload (no base)', async () => {
  const store = mockStore();
  store.db.p = { manifest: man([recode('t1', 'age')]) }; // peer added an age recode on disk
  let applied = null;
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async () => ({}), applyMerged: async (id, m) => { applied = m; }, now: 7,
  });
  assert.equal(r.action, 'merge');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.changed, true);
  assert.deepEqual(txIds(store.db.p.manifest), ['age', 'income']);
  assert.deepEqual(txIds(applied), ['age', 'income']);
});

test('syncFolderProject: a same-variable conflict is surfaced, then resolved', async () => {
  const store = mockStore();
  store.db.p = { manifest: man([recode('t1', 'income')]) };
  let seen = null;
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async (conflicts) => { seen = conflicts; return { [conflicts[0].key]: 'theirs' }; },
    applyMerged: async () => {}, now: 7,
  });
  assert.ok(seen.length >= 1);
  assert.ok(r.conflicts.length >= 1); // reported, but resolved (written)
  assert.ok(store.db.p.manifest); // a resolved manifest was written
});

test('syncFolderProject: cancelling an unresolved conflict leaves the disk untouched', async () => {
  const store = mockStore();
  const theirs = man([recode('t1', 'income')]);
  store.db.p = { manifest: theirs };
  const r = await syncFolderProject({
    store, id: 'p', name: 'P', bundle: bundleOf([recode('m1', 'income')]), mergers: buildMergers([]),
    resolveConflicts: async () => null, applyMerged: async () => {}, now: 7,
  });
  assert.equal(r.action, 'cancelled');
  assert.deepEqual(store.db.p.manifest, theirs); // untouched
});
