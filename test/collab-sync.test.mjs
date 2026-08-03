/**
 * Headless tests for the project-level merge (core/collab-sync.js) on the ONE TRUE LOG.
 * mergeProjects unions two flat op-logs by identity (ancestor = shared op-id set, no
 * base): core ops three-way, each plugin owner's workspace blobs merged per leaf with a
 * deterministic result op. No FS, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergers, mergeProjects, planDatasetApply } from '../core/collab-sync.js';
import { mergeState as caqdasMerge } from '../plugins/builtin-caqdas/index.js';

const NUL = String.fromCharCode(0); // ws-target separator (matches workspace-store)
const op = (id, target, type, payload = {}, owner = 'core', wall = 1) => ({ id, hlc: { wall, counter: 0 }, target, owner, type, payload, reads: [] });
const recode = (id, name, wall = 1) => op(id, `ds:1/var:${name}`, 'recodeVar', { name }, 'core', wall);
const addDs = (id, name) => op(`add${id}`, `coll/ds:${id}`, 'addDataset', { id, name });
const loadDs = (id) => op(`load${id}`, `ds:${id}/source:s${id}`, 'load', { src: { meta: [{ name: 'x' }] } });
const man = (log, extra = {}) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log, ...extra });
const logIds = (m) => m.log.map((o) => o.id).sort();
const caqdasLeaf = `ws:builtin-caqdas${NUL}caqdas-coding${NUL}_default${NUL}1`;

test('buildMergers resolves strategy and via→exported-fn from loaded plugins', () => {
  const plugins = [
    { id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } },
    { id: 'builtin-spatial', manifest: { workspaces: [{ id: 'spatial-map', merge: { strategy: 'lww' } }] } },
    { id: 'no-merge', manifest: { workspaces: [{ id: 'w' }] } },
  ];
  const m = buildMergers(plugins);
  assert.deepEqual(m.core, { strategy: 'three-way' });
  assert.equal(typeof m['caqdas-coding'].merge, 'function'); // keyed by workspace id
  assert.deepEqual(m['spatial-map'], { strategy: 'lww' });
  assert.equal(m['w'], undefined); // no-merge plugin's workspace declares no merger
});

test('disjoint recodes on the same dataset auto-merge (union by id)', () => {
  const shared = [addDs(1, 'ds1'), loadDs(1)];
  const mine = man([...shared, recode('m1', 'income')]);
  const theirs = man([...shared, recode('t1', 'age')]);
  const { manifest: out, conflicts } = mergeProjects(mine, theirs, buildMergers([]));
  assert.equal(conflicts.length, 0);
  assert.ok(logIds(out).includes('m1') && logIds(out).includes('t1'));
});

test('both recode the SAME variable → a surfaced conflict (never silent)', () => {
  const shared = [addDs(1, 'ds1'), loadDs(1)];
  const mine = man([...shared, recode('m1', 'income')]);
  const theirs = man([...shared, recode('t1', 'income')]);
  const { conflicts } = mergeProjects(mine, theirs, buildMergers([]));
  assert.ok(conflicts.length >= 1);
});

test('a dataset added on one side is kept (add-wins, never drop data)', () => {
  const shared = [addDs(1, 'ds1'), loadDs(1)];
  const mine = man([...shared, addDs(2, 'ds2'), loadDs(2)]);
  const theirs = man([...shared]);
  const { manifest: out, conflicts } = mergeProjects(mine, theirs, buildMergers([]));
  assert.equal(conflicts.length, 0);
  assert.ok(logIds(out).includes('add2') && logIds(out).includes('load2'));
});

test('a removeDataset op propagates as a real op (no delete-inference)', () => {
  const shared = [addDs(1, 'ds1'), loadDs(1), addDs(2, 'ds2'), loadDs(2)];
  const mine = man([...shared, op('rm2', 'coll/ds:2', 'removeDataset', { id: 2 }, 'core', 5)]);
  const theirs = man([...shared]); // theirs still has ds2, untouched
  const { manifest: out } = mergeProjects(mine, theirs, buildMergers([]));
  assert.ok(logIds(out).includes('rm2'), 'the removeDataset op rides the merged log → the delete propagates');
});

test('CAQDAS codebooks from two coders union via the deterministic merge op', () => {
  const plugins = [{ id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } }];
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const wsOp = (id, codes, wall) => op(id, caqdasLeaf, 'setWorkspace', { value: cb(codes), label: null }, 'builtin-caqdas', wall);
  const shared = [addDs(1, 'ds1'), loadDs(1), wsOp('wbase', [{ id: 'c1', name: 'anx' }], 1)];
  const mine = man([...shared, wsOp('wa', [{ id: 'c1', name: 'anx' }, { id: 'c2', name: 'coping' }], 3)]);
  const theirs = man([...shared, wsOp('wb', [{ id: 'c1', name: 'anx' }, { id: 'c3', name: 'stigma' }], 3)]);
  const { manifest: out, conflicts } = mergeProjects(mine, theirs, buildMergers(plugins));
  assert.equal(conflicts.length, 0);
  const latest = out.log.filter((o) => o.target === caqdasLeaf).sort((a, b) => (a.hlc.wall - b.hlc.wall) || (a.hlc.counter - b.hlc.counter)).slice(-1)[0];
  assert.deepEqual(latest.payload.value.codes.map((c) => c.id).sort(), ['c1', 'c2', 'c3']);
});

test('the ws merge op is DETERMINISTIC — same operands ⇒ same op id (converges, no oscillation)', () => {
  // Convergence relies on: (1) the transport canonicalises operand order (lower peer id
  // fills the "mine" slot — see decideSync / LiveDoc), so both peers call mergeProjects
  // with the IDENTICAL operands; (2) mergeProjects is then a pure function, so both
  // synthesise the byte-identical merge op (same id) → the union dedups it and it enters
  // the shared ancestor, so re-merging is a fixpoint (no oscillation).
  const plugins = [{ id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } }];
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const wsOp = (id, codes, wall) => op(id, caqdasLeaf, 'setWorkspace', { value: cb(codes), label: null }, 'builtin-caqdas', wall);
  const shared = [wsOp('wbase', [{ id: 'c1' }], 1)];
  const lo = man([...shared, wsOp('wa', [{ id: 'c1' }, { id: 'c2' }], 3)]);
  const hi = man([...shared, wsOp('wb', [{ id: 'c1' }, { id: 'c3' }], 3)]);
  const first = mergeProjects(lo, hi, buildMergers(plugins)).manifest.log.filter((o) => o.target === caqdasLeaf).map((o) => o.id).sort();
  const again = mergeProjects(lo, hi, buildMergers(plugins)).manifest.log.filter((o) => o.target === caqdasLeaf).map((o) => o.id).sort();
  assert.deepEqual(first, again, 'pure: identical operands synthesise the identical merge op');
  // And re-merging the merged result is a fixpoint (the synthesized op is now shared).
  const merged = mergeProjects(lo, hi, buildMergers(plugins)).manifest;
  const twice = mergeProjects(merged, merged, buildMergers(plugins)).manifest;
  const leafVals = (m) => m.log.filter((o) => o.target === caqdasLeaf).length;
  assert.equal(leafVals(twice), leafVals(merged), 'no new merge op on re-merge — fixpoint reached');
});

test('planDatasetApply: a changed op set → REBUILD only that dataset', () => {
  const cur = [{ id: 1, ops: [{ id: 'a' }, { id: 'b' }] }, { id: 2, ops: [{ id: 'c' }] }];
  const inc = [{ id: 1, ops: [{ id: 'a' }, { id: 'b' }, { id: 'x' }] }, { id: 2, ops: [{ id: 'c' }] }, { id: 3, ops: [{ id: 'z' }] }];
  const plan = planDatasetApply(cur, inc);
  assert.deepEqual(plan.rebuild, [1]);
  assert.deepEqual(plan.add, [3]);
  assert.deepEqual(plan.keep, [2]);
  assert.deepEqual(plan.remove, []);
});
