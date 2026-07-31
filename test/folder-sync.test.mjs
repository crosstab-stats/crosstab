/**
 * Headless tests for the folder-sync decision logic (core/folder-sync.js) — the
 * pure part of the folder-backed transport. The store I/O in syncOnce is verified
 * in-browser against a real FileSystemDirectoryHandle (OPFS stand-in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSync, manifestsEqual } from '../core/folder-sync.js';
import { buildMergers } from '../core/collab-sync.js';

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

test('decideSync: peer advanced + same-variable edit → merge with a surfaced conflict', () => {
  const base = man([ds(1, [])]);
  const mine = man([ds(1, [recode('m1', 'income')])]);
  const theirs = man([ds(1, [recode('t1', 'income')])]);
  const d = decideSync(base, mine, theirs, buildMergers([]));
  assert.equal(d.action, 'merge');
  assert.equal(d.conflicts.length, 1);
  assert.equal(d.conflicts[0].dataset, 1);
});
