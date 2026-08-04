/**
 * Headless tests for the live co-authoring convergence engine (core/live-protocol.js) on
 * the ONE TRUE LOG. Two LiveDocs are wired through an in-memory broadcast queue drained
 * to a fixpoint, so we test the real convergence loop without a network. A step cap
 * catches non-convergence (a message storm). Manifests are `{log:[...ops], …scalars}`;
 * merge is by op identity (no base).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDoc } from '../core/live-protocol.js';
import { attachLiveDoc } from '../core/live-sync.js';
import { buildMergers } from '../core/collab-sync.js';
import { manifestsEqual } from '../core/folder-sync.js';

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


const NUL = String.fromCharCode(0);
let seq = 0;
const op = (id, target, type, payload = {}, owner = 'core') => ({ id, hlc: { wall: 1000, counter: seq++ }, target, owner, type, payload, reads: [] });
const recode = (id, name) => op(id, `ds:1/var:${name}`, 'recodeVar', { name });
const LOAD = op('load1', 'ds:1/source:s1', 'load', { src: { meta: [{ name: 'x' }] } }); // shared ancestor op
const ADD = op('add1', 'coll/ds:1', 'addDataset', { id: 1, name: 'ds1' });
const man = (ops, extra = {}) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log: [ADD, LOAD, ...ops], ...extra });
const ids = (m) => (m.log ?? []).map((o) => o.id).filter((x) => x !== 'add1' && x !== 'load1').sort();

function makeNet() {
  const net = { q: [], docs: {}, conflicts: {} };
  net.add = (id, opts) => {
    net.docs[id] = new LiveDoc({ selfId: id, send: (m) => net.q.push([id, m]), onConflicts: (c) => { net.conflicts[id] = c; }, ...opts });
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
  assert.ok(manifestsEqual(A.manifest, B.manifest)); // byte-convergent (by op-id set)
  assert.deepEqual(ids(A.manifest), ['a1', 'b1']);
  assert.deepEqual(ids(B.manifest), ['a1', 'b1']);
});

test('convergence is order-independent (peer with higher id edits first)', () => {
  const net = makeNet();
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: man([recode('b1', 'age')]), mergers: buildMergers([]) });
  B.hello(); A.hello(); // reversed announce order
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
  assert.deepEqual(ids(A.manifest), ['a1', 'b1']);
});

test('late join: an empty joiner catches up to the full project', () => {
  const net = makeNet();
  let applied = null;
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: { name: 'P', savedAt: 0, activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log: [] }, mergers: buildMergers([]), onChange: (m) => { applied = m; } });
  A.hello(); B.hello();
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
  assert.deepEqual(ids(B.manifest), ['a1']); // joiner received the dataset's ops
  assert.ok(B.manifest.log.some((o) => o.id === 'load1'));
  assert.ok(applied);
});

test('a plugin codebook converge (add-wins) live — the workspace tier merges on the log', () => {
  const plugins = CODING_PLUGINS;
  const leaf = `ws:x-coding${NUL}x-codebook${NUL}_default${NUL}1`;
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const wsOp = (id, codes) => op(id, leaf, 'setWorkspace', { value: cb(codes), label: null }, 'x-coding');
  const shared = wsOp('wbase', [{ id: 'c1', name: 'anx' }]); // common ancestor leaf
  const A = { ...man([]), log: [ADD, LOAD, shared, wsOp('wa', [{ id: 'c1', name: 'anx' }, { id: 'c2', name: 'coping' }])] };
  const B = { ...man([]), log: [ADD, LOAD, shared, wsOp('wb', [{ id: 'c1', name: 'anx' }, { id: 'c3', name: 'stigma' }])] };
  const net = makeNet();
  const dA = net.add('A', { manifest: A, mergers: buildMergers(plugins) });
  const dB = net.add('B', { manifest: B, mergers: buildMergers(plugins) });
  dA.hello(); dB.hello();
  net.drain();
  assert.ok(manifestsEqual(dA.manifest, dB.manifest), 'both peers converge');
  const latest = dA.manifest.log.filter((o) => o.target === leaf).sort((a, b) => (a.hlc.wall - b.hlc.wall) || (a.hlc.counter - b.hlc.counter)).slice(-1)[0];
  assert.deepEqual(latest.payload.value.codes.map((c) => c.id).sort(), ['c1', 'c2', 'c3']);
});

test('a genuine conflict surfaces, and resolving it re-converges both peers', () => {
  const net = makeNet();
  const A = net.add('A', { manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  const B = net.add('B', { manifest: man([recode('b1', 'income')]), mergers: buildMergers([]) }); // SAME target
  A.hello(); B.hello();
  net.drain();
  assert.ok(net.conflicts.A?.length || net.conflicts.B?.length, 'same-target edit surfaces a conflict, not a silent merge');
  const key = (net.conflicts.A ?? net.conflicts.B)[0].key;
  A.resolve({ [key]: 'mine' }); // favour the lower-id ("mine" slot = A's a1)
  net.drain();
  assert.ok(manifestsEqual(A.manifest, B.manifest));
});

test('attachLiveDoc wires a LiveDoc onto a session transport (send out, receive in)', () => {
  const session = {
    sent: [], _ops: null, _leave: null,
    sendOps(m) { this.sent.push(m); },
    onOps(cb) { this._ops = cb; },
    onPeerLeave(cb) { this._leave = cb; },
  };
  const doc = attachLiveDoc(session, { selfId: 'A', manifest: man([recode('a1', 'income')]), mergers: buildMergers([]) });
  doc.hello();
  assert.ok(session.sent.some((m) => m.t === 'hello'));
  assert.ok(session.sent.some((m) => m.t === 'state'));
  session._ops({ t: 'state', peerId: 'B', manifest: man([recode('b1', 'age')]) }, 'B');
  assert.deepEqual(ids(doc.manifest), ['a1', 'b1']);
  assert.ok(session.sent.some((m) => m.t === 'state' && ids(m.manifest).length === 2));
});
