/**
 * Headless tests for base-data gap-fill (core/gap-fill.js): detection, chunking,
 * integrity, and the full request→chunk→verify→store round-trip between two peers
 * (in-memory byte stores, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refKey, sourceRefs, missingSources, chunk, reassemble, sha256hex, SourceExchange } from '../core/gap-fill.js';

const src = (id, file) => ({ id, file, meta: [{ name: 'x' }], label: 'f', combine: 'base' });
const manifest = (datasets) => ({ name: 'P', savedAt: 1, activeId: datasets[0].id, datasets });
const ds = (id, sources) => ({ id, name: `ds${id}`, sources, transforms: [], order: sources.map(() => 's') });

test('sourceRefs / missingSources detect what a peer lacks', () => {
  const m = manifest([ds(1, [src('op-a', 'ds1_src1.parquet')]), ds(2, [src('op-b', 'ds2_src1.parquet')])]);
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

/** Wire two SourceExchanges through a drained broadcast queue. */
function wire(a, b) {
  const q = [];
  const peers = {};
  const mk = (id, held, bytesById) => {
    const store = new Map();
    const ex = new SourceExchange({
      held: new Set(held),
      readSource: async (ref) => bytesById[refKey(ref)] ?? null,
      storeSource: async (ref, bytes) => { store.set(refKey(ref), bytes); },
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
  const m = manifest([ds(1, [src('op-a', 'ds1_src1.parquet')]), ds(2, [src('op-b', 'ds2_src1.parquet')])]);
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
  assert.deepEqual(peers.A.received, [{ key: 'op-b', ok: true, dsId: 2, file: 'ds2_src1.parquet' }]);
});

test('a holder that declines (consent/size gate) sends nothing', async () => {
  const q = [];
  const B = new SourceExchange({
    held: new Set(['op-b']),
    readSource: async () => new Uint8Array([1, 2, 3]),
    storeSource: async () => {},
    send: (m) => q.push(m),
    allowSend: () => false, // decline (e.g. 3 GB over a field link)
  });
  await B.receive({ t: 'need', refs: [{ id: 'op-b', dsId: 2, file: 'ds2_src1.parquet' }] }, 'A');
  assert.equal(q.length, 0);
});

test('integrity failure is rejected, not stored', async () => {
  const stored = [];
  const A = new SourceExchange({
    held: new Set(), readSource: async () => null,
    storeSource: async (ref) => stored.push(refKey(ref)),
    send: () => {},
    onReceived: (ev) => { A.__last = ev; },
  });
  const good = new Uint8Array([1, 2, 3, 4]);
  const hash = await sha256hex(good);
  // Deliver a single chunk whose bytes don't match the advertised hash.
  await A.receive({ t: 'src-chunk', key: 'op-x', dsId: 1, file: 'f.parquet', seq: 0, total: 1, hash, bytes: new Uint8Array([9, 9, 9, 9]) }, 'B');
  assert.deepEqual(stored, []);          // not stored
  assert.equal(A.__last.ok, false);      // reported as failed
  assert.ok(!A.held.has('op-x'));
});
