/**
 * Headless tests for planDatasetApply (core/collab-sync.js) — the delta planner that
 * lets a live merge apply touch only what changed (add/rebuild/keep/remove) instead of
 * disposing and rebuilding every dataset. Pure; the DuckDB-side wiring is separate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDatasetApply } from '../core/collab-sync.js';

// On the one true log, a dataset's signature is the id SET of its ops (its ds:<id>/…
// slice). Both "current" and "incoming" are the same {id, ops} shape now.
const md = (id, srcIds = ['s1'], transforms = []) => ({ id, ops: [...srcIds, ...transforms.map((t) => t.id)].map((x) => ({ id: x })) });
const ld = md;

test('unchanged datasets are KEPT (their DuckDB tables stay put)', () => {
  const cur = [ld(1), ld(2)];
  const inc = [md(1), md(2)];
  assert.deepEqual(planDatasetApply(cur, inc), { add: [], rebuild: [], keep: [1, 2], remove: [] });
});

test('a new dataset is ADDed; a vanished one is REMOVEd', () => {
  const cur = [ld(1), ld(2)];
  const inc = [md(1), md(3)]; // 2 gone, 3 new
  const p = planDatasetApply(cur, inc);
  assert.deepEqual(p.add, [3]);
  assert.deepEqual(p.remove, [2]);
  assert.deepEqual(p.keep, [1]);
  assert.deepEqual(p.rebuild, []);
});

test('a changed tabular shape (new transform / new source) → REBUILD only that one', () => {
  const cur = [ld(1, ['s1'], []), ld(2, ['s1'], [])];
  const inc = [md(1, ['s1'], [{ id: 'r1', type: 'recodeVar' }]), md(2, ['s1'], [])]; // 1 gained a transform
  const p = planDatasetApply(cur, inc);
  assert.deepEqual(p.rebuild, [1]);
  assert.deepEqual(p.keep, [2]);
  // a new source on a dataset also triggers rebuild
  assert.deepEqual(planDatasetApply([ld(9, ['s1'])], [md(9, ['s1', 's2'])]).rebuild, [9]);
});

test('a rename does NOT rebuild (name is collection-tier, not tabular)', () => {
  const cur = [{ id: 1, name: 'Old', state: { sources: [{ id: 's1' }], transforms: [] } }];
  const inc = [{ id: 1, name: 'New', sources: [{ id: 's1' }], transforms: [] }];
  assert.deepEqual(planDatasetApply(cur, inc), { add: [], rebuild: [], keep: [1], remove: [] });
});

test('the reported two-window shape: each peer keeps its own, adds the other\'s', () => {
  // A holds demo(1) + its own energy(E); the merge brings in B's height(H).
  const cur = [ld(1), ld('E')];
  const inc = [md(1), md('E'), md('H')];
  const p = planDatasetApply(cur, inc);
  assert.deepEqual(p.keep.sort(), [1, 'E']); // demo + energy untouched (no dispose!)
  assert.deepEqual(p.add, ['H']);            // only height is created
  assert.deepEqual(p.remove, []);
});

test('empty inputs are handled', () => {
  assert.deepEqual(planDatasetApply(undefined, undefined), { add: [], rebuild: [], keep: [], remove: [] });
  assert.deepEqual(planDatasetApply([ld(1)], []), { add: [], rebuild: [], keep: [], remove: [1] });
});
