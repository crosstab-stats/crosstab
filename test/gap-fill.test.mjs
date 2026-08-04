/**
 * Headless tests for base-data gap-fill (core/gap-fill.js): detection, chunking,
 * integrity, and the full request→chunk→verify→store round-trip between two peers
 * (in-memory byte stores, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refKey, sourceRefs, missingSources, assetRefs, missingAssets, chunk, reassemble, sha256hex, BlobExchange } from '../core/gap-fill.js';

// A source op in the flat one-true-log (the shape sourceRefs now reads).
const loadOp = (id, dsId, file) => ({ id, hlc: { wall: 0, counter: 0 }, target: `ds:${dsId}/source:${id}`, owner: 'core', type: 'load', payload: { src: { meta: [{ name: 'x' }], label: 'f', file } }, reads: [] });
const manifest = (ops) => ({ name: 'P', savedAt: 1, activeId: 1, log: ops });

test('sourceRefs / missingSources detect what a peer lacks', () => {
  const m = manifest([loadOp('op-a', 1, 'src_op-a.parquet'), loadOp('op-b', 2, 'src_op-b.parquet')]);
  assert.deepEqual(sourceRefs(m).map(refKey), ['op-a', 'op-b']);
  assert.deepEqual(missingSources(m, new Set(['op-a'])).map(refKey), ['op-b']); // has a, needs b
  assert.deepEqual(missingSources(m, new Set(['op-a', 'op-b'])), []);           // has both
});

test('chunk / reassemble round-trips (incl. an exact multiple and empty)', () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 256);
  assert.deepEqual([...reassemble(chunk(bytes, 256))], [...bytes]);
  assert.deepEqual([...reassemble(chunk(bytes, 1000))], [...bytes]); // one chunk
  assert.equal(chunk(new Uint8Array(0)).length, 1);                  // empty → one empty chunk
  assert.equal(reassemble(chunk(new Uint8Array(0))).length, 0);
});

test('sha256hex is stable and content-sensitive', async () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.equal(await sha256hex(a), await sha256hex(new Uint8Array([1, 2, 3])));
  assert.notEqual(await sha256hex(a), await sha256hex(new Uint8Array([1, 2, 4])));
});

/** Wire two BlobExchanges through a drained broadcast queue. */
function wire(a, b) {
  const q = [];
  const peers = {};
  const mk = (id, held, bytesById) => {
    const store = new Map();
    const ex = new BlobExchange({
      held: new Set(held),
      kind: 'source', refsOf: sourceRefs, read: async (ref) => bytesById[refKey(ref)] ?? null,
      store: async (ref, bytes) => { store.set(refKey(ref), bytes); },
      send: (m, to) => q.push([id, m, to]),
      onReceived: (ev) => { (peers[id].received ||= []).push(ev); },
      chunkSize: 64,
    });
    peers[id] = { ex, store, received: [] };
    return peers[id];
  };
  peers.A = mk('A', a.held, a.bytes);
  peers.B = mk('B', b.held, b.bytes);
  const drain = async () => {
    let steps = 0;
    while (q.length) {
      if (++steps > 2000) throw new Error('gap-fill did not settle');
      const [from, m, to] = q.shift();
      for (const [id, p] of Object.entries(peers)) if (id !== from && (!to || to === id)) await p.ex.receive(m, from);
    }
  };
  return { peers, drain };
}

test('full round-trip: a peer fetches a missing source, verified and stored', async () => {
  const payload = new Uint8Array(500).map((_, i) => (i * 7) % 256); // > chunkSize (64) → multi-chunk
  const m = manifest([loadOp('op-a', 1, 'src_op-a.parquet'), loadOp('op-b', 2, 'src_op-b.parquet')]);
  // A has op-a and needs op-b; B has op-b.
  const { peers, drain } = wire(
    { held: ['op-a'], bytes: { 'op-a': new Uint8Array([9]) } },
    { held: ['op-b'], bytes: { 'op-b': payload } },
  );
  const missing = peers.A.ex.requestMissing(m);
  assert.deepEqual(missing.map(refKey), ['op-b']);
  await drain();
  assert.ok(peers.A.ex.held.has('op-b'));                     // now held
  assert.deepEqual([...peers.A.store.get('op-b')], [...payload]); // exact bytes stored
  assert.deepEqual(peers.A.received, [{ kind: 'source', key: 'op-b', ok: true, ref: { dsId: '2', file: 'src_op-b.parquet', id: 'op-b' } }]);
});

// Trystero's action channel only transmits binary when the WHOLE payload is a
// TypedArray; a Uint8Array nested in a plain object gets JSON-serialised (to a
// numeric-keyed object) and arrives corrupt. project-sync base64s the chunk bytes at
// the transport boundary to survive that. These two tests pin the hazard + the fix.
const jsonClone = (m) => JSON.parse(JSON.stringify(m)); // what a JSON transport does to a message
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

test('raw nested bytes are corrupted by a JSON transport (the bug)', async () => {
  const A = new BlobExchange({
    kind: 'source', refsOf: sourceRefs, held: new Set(), read: async () => null,
    store: async () => {}, send: () => {},
    onReceived: (ev) => { A.__last = ev; },
  });
  const good = new Uint8Array([1, 2, 3, 4]);
  const hash = await sha256hex(good);
  const msg = { t: 'gap-chunk', kind: 'source', key: 'op-x', dsId: 1, file: 'f.parquet', seq: 0, total: 1, hash, bytes: good };
  await A.receive(jsonClone(msg), 'B');   // as it would arrive over a JSON channel
  assert.equal(A.__last.ok, false);       // Uint8Array → {0,1,2,3} → integrity fails
});

test('a base64 adapter (project-sync wiring) survives the JSON transport', async () => {
  const stored = [];
  const A = new BlobExchange({
    kind: 'source', refsOf: sourceRefs, held: new Set(), read: async () => null,
    store: async (ref, bytes) => stored.push([ref.file ?? ref.id, [...bytes]]),
    send: () => {}, onReceived: (ev) => { A.__last = ev; },
  });
  const good = new Uint8Array([1, 2, 3, 4]);
  const hash = await sha256hex(good);
  // Sender wraps → JSON transport → receiver unwraps (mirrors project-sync send/onOps).
  const wire = jsonClone({ t: 'gap-chunk', kind: 'source', key: 'op-x', ref: { id: 'op-x', dsId: 1, file: 'f.parquet' }, seq: 0, total: 1, hash, bytes: b64(good) });
  const decoded = wire.t === 'gap-chunk' && typeof wire.bytes === 'string' ? { ...wire, bytes: unb64(wire.bytes) } : wire;
  await A.receive(decoded, 'B');
  assert.equal(A.__last.ok, true);
  assert.deepEqual(stored, [['f.parquet', [1, 2, 3, 4]]]); // exact bytes land
});

test('a holder that declines (consent/size gate) sends nothing', async () => {
  const q = [];
  const B = new BlobExchange({
    held: new Set(['op-b']),
    kind: 'source', refsOf: sourceRefs, read: async () => new Uint8Array([1, 2, 3]),
    store: async () => {},
    send: (m) => q.push(m),
    allowSend: () => false, // decline (e.g. 3 GB over a field link)
  });
  await B.receive({ t: 'need', refs: [{ id: 'op-b', dsId: 2, file: 'ds2_src1.parquet' }] }, 'A');
  assert.equal(q.length, 0);
});

test('integrity failure is rejected, not stored', async () => {
  const stored = [];
  const A = new BlobExchange({
    kind: 'source', refsOf: sourceRefs, held: new Set(), read: async () => null,
    store: async (ref) => stored.push(refKey(ref)),
    send: () => {},
    onReceived: (ev) => { A.__last = ev; },
  });
  const good = new Uint8Array([1, 2, 3, 4]);
  const hash = await sha256hex(good);
  // Deliver a single chunk whose bytes don't match the advertised hash.
  await A.receive({ t: 'gap-chunk', kind: 'source', key: 'op-x', dsId: 1, file: 'f.parquet', seq: 0, total: 1, hash, bytes: new Uint8Array([9, 9, 9, 9]) }, 'B');
  assert.deepEqual(stored, []);          // not stored
  assert.equal(A.__last.ok, false);      // reported as failed
  assert.ok(!A.held.has('op-x'));
});

// --- assets (#155) -----------------------------------------------------------
// The gap #152 opened: spatial geometry used to live in the workspace blob, which rides
// inside manifest.log and therefore reached peers for free. Moving it to an asset meant a
// co-authored map layer arrived with a valid assetId and nothing behind it.

const assetManifest = (ops) => ({ log: ops });

test('assetRefs reads addAsset ops and honours removeAsset', () => {
  const m = assetManifest([
    { type: 'addAsset', payload: { id: 'aaa', name: 'counties.geojson', type: 'application/geo+json' } },
    { type: 'addAsset', payload: { id: 'bbb', name: 'clip.wav', type: 'audio/wav' } },
    { type: 'removeAsset', payload: { id: 'bbb' } },
    { type: 'load', payload: { src: { file: 'src_1.parquet' } }, target: 'ds:1/source:op-1', id: 'op-1' },
  ]);
  assert.deepEqual(assetRefs(m).map((r) => r.id), ['aaa'], 'a dropped asset is not fetched');
});

test('assetRefs dedupes — re-importing identical bytes appends another addAsset', () => {
  const m = assetManifest([
    { type: 'addAsset', payload: { id: 'aaa', name: 'x' } },
    { type: 'addAsset', payload: { id: 'aaa', name: 'x again' } },
  ]);
  assert.equal(assetRefs(m).length, 1);
});

test('missingAssets is what a peer lacks', () => {
  const m = assetManifest([
    { type: 'addAsset', payload: { id: 'aaa' } },
    { type: 'addAsset', payload: { id: 'bbb' } },
  ]);
  assert.deepEqual(missingAssets(m, new Set(['aaa'])).map((r) => r.id), ['bbb']);
});

test('an asset ROUND-TRIPS between peers, verified by content hash', async () => {
  // An asset's id IS its sha256, so identity and integrity are the same value.
  const bytes = new Uint8Array([7, 7, 9, 9, 1, 2, 3]);
  const id = await sha256hex(bytes);
  const m = assetManifest([{ type: 'addAsset', payload: { id, name: 'wards.geojson' } }]);

  const q = [];
  const peers = {};
  const mk = (name, has) => {
    const store = new Map();
    const ex = new BlobExchange({
      kind: 'asset',
      refsOf: assetRefs,
      held: new Set(has ? [id] : []),
      read: async (ref) => (ref.id === id && has ? bytes : null),
      store: async (ref, b) => { store.set(ref.id, b); },
      send: (msg, to) => q.push([name, msg, to]),
      onReceived: (ev) => { (peers[name].got ||= []).push(ev); },
      chunkSize: 3, // force multi-chunk
    });
    peers[name] = { ex, store, got: [] };
  };
  mk('holder', true);
  mk('joiner', false);

  const missing = peers.joiner.ex.requestMissing(m);
  assert.deepEqual(missing.map((r) => r.id), [id]);
  let steps = 0;
  while (q.length) {
    if (++steps > 500) throw new Error('asset gap-fill did not settle');
    const [from, msg, to] = q.shift();
    for (const [n, p] of Object.entries(peers)) if (n !== from && (!to || to === n)) await p.ex.receive(msg, from);
  }
  assert.deepEqual([...peers.joiner.store.get(id)], [...bytes], 'exact bytes landed');
  assert.ok(peers.joiner.ex.held.has(id));
  assert.equal(peers.joiner.got[0].kind, 'asset');
});

test('the two exchanges IGNORE each other on a shared channel', async () => {
  // Both ride the same ops channel. Without the kind discriminator the asset exchange
  // would answer the source exchange's `need` and try to ingest its chunks.
  const served = [];
  const assets = new BlobExchange({
    kind: 'asset', refsOf: assetRefs, held: new Set(['aaa']),
    read: async () => { served.push('asset-read'); return new Uint8Array([1]); },
    store: async () => {}, send: () => {},
  });
  // A SOURCE request must not reach the asset exchange's reader.
  await assets.receive({ t: 'need', kind: 'source', refs: [{ id: 'aaa' }] }, 'peer');
  assert.deepEqual(served, [], 'asset exchange ignored a source request');
  // …and its own kind does reach it.
  await assets.receive({ t: 'need', kind: 'asset', refs: [{ id: 'aaa' }] }, 'peer');
  assert.deepEqual(served, ['asset-read']);
});
