/**
 * Headless tests for the live co-authoring convergence engine (core/live-protocol.js).
 * Two LiveDocs are wired through an in-memory broadcast queue drained to a fixpoint,
 * so we test the real convergence loop without any network. A step cap catches
 * non-convergence (a message storm) as a failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDoc } from '../core/live-protocol.js';
import { attachLiveDoc } from '../core/live-sync.js';
import { buildMergers } from '../core/collab-sync.js';
import { manifestsEqual } from '../core/folder-sync.js';
import { mergeState as caqdasMerge } from '../plugins/builtin-caqdas/index.js';

const recode = (id, name) => ({ id, type: 'recodeVar', name });
const ds = (txs) => ({ id: 1, name: 'ds1', libraryLink: null, sources: [{ id: 's1', meta: [{ name: 'x' }], label: 'f', combine: 'base', file: 's1.parquet' }], transforms: txs, order: ['s', ...txs.map(() => 't')] });
const man = (txs, extra = {}) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, workspaces: null, output: null, datasets: [ds(txs)], ...extra });
const txIds = (m) => m.datasets[0].transforms.map((t) => t.id);

/** A tiny broadcast network: docs push messages; drain() delivers to every other
 * doc until the queue empties (fixpoint) or the storm cap trips. */
function makeNet() {
  const net = { q: [], docs: {}, conflicts: {} };
  net.add = (id, opts) => {
    net.docs[id] = new LiveDoc({
      selfId: id,
      send: (m) => net.q.push([id, m]),
      onConflicts: (c) => { net.conflicts[id] = c; },
      ...opts,
    });
    return net.docs[id];
  };
  net.drain = () => {
    let steps = 0;
    while (net.q.length) {
      if (++steps > 500) throw new Error('did not converge — message storm');
      const [from, m] = net.q.shift();
      for (const [id, d] of Object.entries(net.docs)) if (id !== from) d.receive(m, from);
    }
    return steps;
  };
  return net;
}

test('disjoint recodes converge to identical state on both peers', () => {
  const net = makeNet();
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: man([recode('b1', 'age')]), mergers: buildMergers([]) });
  A.hello(); B.hello();
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest)); // byte-convergent
  assert.deepEqual(txIds(A.manifest), ['a1', 'b1']);
  assert.deepEqual(txIds(B.manifest), ['a1', 'b1']);
});

test('convergence is order-independent (peer with higher id edits first)', () => {
  const net = makeNet();
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: man([recode('b1', 'age')]), mergers: buildMergers([]) });
  B.hello(); A.hello(); // reversed announce order
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
  assert.deepEqual(txIds(A.manifest), ['a1', 'b1']); // canonical (id) order, not arrival order
});

test('late join: an empty joiner catches up to the full project', () => {
  const net = makeNet();
  let applied = null;
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: { name: 'P', savedAt: 0, activeId: 1, activePlugins: null, workspaces: null, output: null, datasets: [] }, mergers: buildMergers([]), onChange: (m) => { applied = m; } });
  A.hello(); B.hello();
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
  assert.equal(B.manifest.datasets.length, 1);       // joiner received the dataset
  assert.deepEqual(txIds(B.manifest), ['a1']);
  assert.ok(applied);                                 // onChange fired with the merged state
});

test('CAQDAS codebooks converge (add-wins) live', () => {
  const plugins = [{ id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } }];
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const ws = (codes) => ({ __wsv: 4, ws: { 'builtin-caqdas': { 'caqdas-coding': { _default: { 1: cb(codes) } } } } });
  const net = makeNet();
  const A = net.add('A', { manifest: man([], { workspaces: ws([{ id: 'c1', name: 'anx' }, { id: 'c2', name: 'coping' }]) }), mergers: buildMergers(plugins) });
  const B = net.add('B', { manifest: man([], { workspaces: ws([{ id: 'c1', name: 'anx' }, { id: 'c3', name: 'stigma' }]) }), mergers: buildMergers(plugins) });
  A.hello(); B.hello();
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
  const codes = A.manifest.workspaces.ws['builtin-caqdas']['caqdas-coding']._default[1].codes.map((c) => c.id).sort();
  assert.deepEqual(codes, ['c1', 'c2', 'c3']);
});

test('a genuine conflict surfaces, and resolving it re-converges both peers', () => {
  const net = makeNet();
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: man([recode('b1', 'income')]), mergers: buildMergers([]) });
  A.hello(); B.hello();
  net.drain();
  // Both independently recoded `income` → an add/add conflict, surfaced (not silently merged).
  assert.ok(net.conflicts.A?.length || net.conflicts.B?.length);
  const key = (net.conflicts.A ?? net.conflicts.B)[0].key;
  assert.ok(!manifestsEqual(A.manifest, B.manifest) || txIds(A.manifest).length === 1); // not silently unioned

  // A resolves in favour of the lower-id ("mine" slot = A's a1).
  A.resolve({ [key]: 'mine' });
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
  assert.deepEqual(txIds(A.manifest), ['a1']);
  assert.deepEqual(txIds(B.manifest), ['a1']);
});

test('attachLiveDoc wires a LiveDoc onto a session transport (send out, receive in)', () => {
  // Mock the LiveSession surface attachLiveDoc uses.
  const session = {
    sent: [], _ops: null, _leave: null,
    sendOps(m) { this.sent.push(m); },
    onOps(cb) { this._ops = cb; },
    onPeerLeave(cb) { this._leave = cb; },
  };
  const doc = attachLiveDoc(session, { selfId: 'A', manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  doc.hello();
  assert.ok(session.sent.some((m) => m.t === 'hello'));   // send routed out through the session
  assert.ok(session.sent.some((m) => m.t === 'state'));

  // A peer's state arrives via the session's op channel → the doc converges.
  session._ops({ t: 'state', peerId: 'B', manifest: man([recode('b1', 'age')]) }, 'B');
  assert.deepEqual(txIds(doc.manifest), ['a1', 'b1']);
  assert.ok(session.sent.some((m) => m.t === 'state' && txIds(m.manifest).length === 2)); // merged state broadcast back
});
