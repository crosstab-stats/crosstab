/**
 * Headless tests for the project-level merge (core/collab-sync.js) on the ONE TRUE LOG.
 * mergeProjects unions two flat op-logs by identity (ancestor = shared op-id set, no
 * base): core ops three-way, each plugin owner's workspace blobs merged per leaf with a
 * deterministic result op. No FS, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergers, mergeProjects, planDatasetApply } from '../core/collab-sync.js';
import { deterministicOpId } from '../core/merge.js';

// A stand-in plugin merger. These tests exercise the TRANSPORT — that a custom blob
// merger is reached, that its merge op is deterministic, that peers converge — not any
// particular plugin. CAQDAS used to supply the example, but after #152 its codebook is
// item records with no custom merger, so the example is synthesised here instead. Same
// add-wins shape CAQDAS's used to have.
const codebookMerge = ({ ancestor, mine, theirs, helpers }) => {
  const r = helpers.addWinsSet(ancestor?.codes ?? [], mine?.codes ?? [], theirs?.codes ?? [], (c) => c.id, 'x-coding');
  return { resolved: { ...(mine ?? {}), codes: r.resolved }, conflicts: r.conflicts };
};
const CODING_PLUGINS = [{
  id: 'x-coding',
  manifest: { workspaces: [{ id: 'x-codebook', merge: { via: 'mergeCodebook' } }] },
  module: { mergeCodebook: codebookMerge },
}];


const NUL = String.fromCharCode(0); // ws-target separator (matches workspace-store)
const op = (id, target, type, payload = {}, owner = 'core', wall = 1) => ({ id, hlc: { wall, counter: 0 }, target, owner, type, payload, reads: [] });
const recode = (id, name, wall = 1) => op(id, `ds:1/var:${name}`, 'recodeVar', { name }, 'core', wall);
const addDs = (id, name) => op(`add${id}`, `coll/ds:${id}`, 'addDataset', { id, name });
const loadDs = (id) => op(`load${id}`, `ds:${id}/source:s${id}`, 'load', { src: { meta: [{ name: 'x' }] } });
const man = (log, extra = {}) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log, ...extra });
const logIds = (m) => m.log.map((o) => o.id).sort();
const caqdasLeaf = `ws:x-coding${NUL}x-codebook${NUL}_default${NUL}1`;

test('buildMergers resolves strategy and via→exported-fn from loaded plugins', () => {
  const plugins = [
    { id: 'x-coding', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: codebookMerge } },
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

test('a plugin codebook from two coders union via the deterministic merge op', () => {
  const plugins = CODING_PLUGINS;
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const wsOp = (id, codes, wall) => op(id, caqdasLeaf, 'setWorkspace', { value: cb(codes), label: null }, 'x-coding', wall);
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
  const plugins = CODING_PLUGINS;
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const wsOp = (id, codes, wall) => op(id, caqdasLeaf, 'setWorkspace', { value: cb(codes), label: null }, 'x-coding', wall);
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

// --- #149 B4: a merge op's id must depend on its INPUTS, not just its output ------
// Hashing only (target + resolved value) let a later merge that happened to resolve to
// a previously-emitted value re-mint the SAME id with a HIGHER hlc. receiveOps dedups by
// id, so the newer copy was dropped and the leaf's fold could then pick an ordinary
// write over the merge result — peers genuinely out of step while manifestsEqual (an
// id-set comparison) reported them in sync.

test('deterministicOpId changes when the contributing ops change (B4)', () => {
  const body = { target: 'ws:leaf', owner: 'p', type: 'setWorkspace', payload: { value: { a: 1 }, label: null } };
  const a = deterministicOpId({ ...body, reads: ['op-1', 'op-2'] }, body.target);
  const b = deterministicOpId({ ...body, reads: ['op-1', 'op-3'] }, body.target);
  const again = deterministicOpId({ ...body, reads: ['op-1', 'op-2'] }, body.target);
  assert.notEqual(a, b, 'different contributors must not collide on one id');
  assert.equal(a, again, 'same contributors + same value = same id (still deterministic)');
});

test('re-running the same workspace merge mints the same op id (B4)', () => {
  const NUL = String.fromCharCode(0);
  const leaf = ['ws:x-coding', 'x-codebook', '_default', '1'].join(NUL);
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const op = (id, codes, wall) => ({
    id, hlc: { wall, counter: 0 }, target: leaf, owner: 'x-coding',
    type: 'setWorkspace', reads: [], payload: { value: cb(codes), label: null },
  });
  const shared = op('wbase', [{ id: 'c1', name: 'anx' }], 1);
  const M = (o) => ({
    name: 'P', savedAt: 1, activeId: 1, activePlugins: ['x-coding'],
    output: null, datasetMeta: null, collabId: null, log: [shared, o],
  });
  const A = M(op('wa', [{ id: 'c1', name: 'anx' }, { id: 'c2', name: 'coping' }], 3));
  const B = M(op('wb', [{ id: 'c1', name: 'anx' }, { id: 'c3', name: 'stigma' }], 3));
  const plugins = [{
    id: 'x-coding',
    manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] },
    module: { mergeState: codebookMerge },
  }];
  const emitted = (m) => m.manifest.log
    .filter((o) => o.target === leaf && !['wbase', 'wa', 'wb'].includes(o.id))
    .map((o) => o.id);
  // Re-running the SAME merge must mint the same id — that's what stops a merge op
  // oscillating between syncs. (Cross-peer identity comes from the canonical operand
  // order the transports impose before calling in; mergeProjects itself is not
  // operand-symmetric, because the merged VALUE isn't — see live-protocol.test.mjs.)
  const once = emitted(mergeProjects(A, B, buildMergers(plugins)));
  const twice = emitted(mergeProjects(A, B, buildMergers(plugins)));
  assert.equal(once.length, 1, 'one merge op for the diverged leaf');
  assert.deepEqual(once, twice, 're-running the same merge must not mint a new id');
});

// --- #158: joining is ADOPTION, not a merge ----------------------------------
test('a peer holding NO project adopts the other side whole', () => {
  // The joiner used to stand up a blank project so the manifest had "somewhere to
  // land". Its empty dataset then merged in as a mystery "Dataset 1" in the host's
  // sidebar, and its plugin set — asserted with the newest clock in the room —
  // reconfigured the host's. Holding nothing removes the operand entirely: there is no
  // ancestor to reconcile and nothing local to leak.
  const hostLog = [
    { id: 'op-1', hlc: { wall: 1, counter: 0 }, owner: 'core', target: 'coll/ds:7', type: 'addDataset', payload: { id: 7, name: 'Field notes' }, reads: [] },
    { id: 'op-2', hlc: { wall: 2, counter: 0 }, owner: 'core', target: 'plugin:./p/caqdas.js', type: 'activatePlugin', payload: { key: './p/caqdas.js' }, reads: [] },
  ];
  const { manifest, conflicts } = mergeProjects(null, { log: hostLog }, {}, null);
  assert.deepEqual(conflicts, [], 'nothing to disagree about — one side has no project');
  assert.deepEqual(manifest.log.map((o) => o.id), ['op-1', 'op-2'], 'the host project arrives whole');
  assert.equal(manifest.log.filter((o) => o.type === 'addDataset').length, 1, 'no phantom dataset');
});

test('…and it is symmetric: the side WITH the project keeps it intact', () => {
  const mineLog = [
    { id: 'op-1', hlc: { wall: 1, counter: 0 }, owner: 'core', target: 'coll/ds:7', type: 'addDataset', payload: { id: 7, name: 'Field notes' }, reads: [] },
  ];
  const { manifest, conflicts } = mergeProjects({ log: mineLog }, null, {}, null);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(manifest.log.map((o) => o.id), ['op-1']);
});
