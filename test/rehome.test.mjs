/**
 * @file rehome.test.mjs
 * Repointing what referenced dataset A at dataset B (#151).
 *
 * The delicate part is not moving records — it is the ROW references inside them. A
 * coded segment points at a `__ct_rid`, and attaching a quotation to the wrong
 * participant is worse than losing it, because nothing downstream can tell. So most of
 * what is pinned here is about refusing to guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { planRowMap, rehomeRecord, planRehome, gatherRehome, applyRehome } = await import('../core/rehome.js');

// Row ids are `sourceSeq * 1e9 + rowNumber`, so a re-import of the same rows in the
// same order genuinely produces the same ids.
const rid = (n) => String(1_000_000_000 + n);

// --- working out the mapping ---------------------------------------------------------

test('identical row ids map to themselves — the common case needs no key at all', () => {
  // "Here is a corrected version" usually means the same rows, same order, one cell
  // fixed. The ids are derived from position, so they are genuinely the same rows.
  const p = planRowMap({ fromRids: [rid(1), rid(2), rid(3)], toRids: [rid(1), rid(2), rid(3)] });
  assert.equal(p.strategy, 'identity');
  assert.equal(p.matched, 3);
  assert.equal(p.map.get(rid(2)), rid(2));
  assert.deepEqual(p.unmatched, []);
});

test('a NAMED KEY beats identity — identity is only sound while order is unchanged', () => {
  // The trap: ids are `sourceSeq * 1e9 + rowNumber`, so inserting one row at the top of
  // B shifts every later row into the id its predecessor used to hold. Identity would
  // then map every coding one row off — silently, and plausibly. A user who names a key
  // column has told us what identifies a row, which beats position.
  const p = planRowMap({
    fromRids: [rid(1), rid(2)], toRids: [rid(1), rid(2)],
    fromKeys: ['a', 'b'], toKeys: ['b', 'a'], // B's rows are in the other order
  });
  assert.equal(p.strategy, 'key');
  assert.equal(p.map.get(rid(1)), rid(2), 'row "a" is B’s second row, not its first');
  assert.equal(p.map.get(rid(2)), rid(1));
});

test('when ids diverge, a named key column maps them', () => {
  // Rows were added, so B re-baked its ids. P002 moved position; the key follows it.
  const p = planRowMap({
    fromRids: [rid(1), rid(2)],
    toRids: [rid(1), rid(2), rid(3)],
    fromKeys: ['P001', 'P002'],
    toKeys: ['P000', 'P001', 'P002'], // a row was PREPENDED, so everything shifted
  });
  assert.equal(p.strategy, 'key');
  assert.equal(p.map.get(rid(1)), rid(2), 'P001 moved down one row');
  assert.equal(p.map.get(rid(2)), rid(3), 'P002 moved down one row');
  assert.equal(p.matched, 2);
});

test('a key value appearing twice is REFUSED, not resolved by position', () => {
  // "First match wins" would attach one participant's codings to another with the same
  // name. Refusing is the only answer that cannot be silently wrong.
  const p = planRowMap({
    fromRids: [rid(1), rid(2)],
    toRids: [rid(5), rid(6)],
    fromKeys: ['Smith', 'Jones'],
    toKeys: ['Smith', 'Smith'],
  });
  assert.equal(p.map.has(rid(1)), false, 'the duplicated key maps to nothing');
  assert.deepEqual(p.ambiguous, [rid(1)]);
  assert.deepEqual(p.unmatched, [rid(2)], 'Jones is simply absent from B');
});

test('duplicates on the SOURCE side are ambiguous too', () => {
  const p = planRowMap({
    fromRids: [rid(1), rid(2)], toRids: [rid(5)],
    fromKeys: ['Smith', 'Smith'], toKeys: ['Smith'],
  });
  assert.equal(p.matched, 0);
  assert.equal(p.ambiguous.length, 2);
});

test('blank keys are not keys', () => {
  // Two rows with an empty id column are not "the same row".
  const p = planRowMap({
    fromRids: [rid(1), rid(2)], toRids: [rid(5), rid(6)],
    fromKeys: ['', '  '], toKeys: ['', 'x'],
  });
  assert.equal(p.matched, 0);
  assert.deepEqual(p.unmatched, [rid(1), rid(2)]);
});

test('keys match case- and whitespace-insensitively', () => {
  const p = planRowMap({
    fromRids: [rid(1)], toRids: [rid(9)],
    fromKeys: [' P001 '], toKeys: ['p001'],
  });
  assert.equal(p.map.get(rid(1)), rid(9));
});

test('no key column and mismatched ids means no mapping — say so, do not guess', () => {
  const p = planRowMap({ fromRids: [rid(1)], toRids: [rid(7)] });
  assert.equal(p.strategy, 'none');
  assert.equal(p.matched, 0);
  assert.deepEqual(p.unmatched, [rid(1)]);
});

// --- rewriting a record ----------------------------------------------------------------

test('a record with no row references moves untouched', () => {
  const r = rehomeRecord({ name: 'Trust', color: '#fff' }, [], new Map());
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields, { name: 'Trust', color: '#fff' });
});

test('a declared row reference is remapped', () => {
  const map = new Map([[rid(1), rid(9)]]);
  const r = rehomeRecord({ doc: rid(1), codeId: 'c1', start: 0 }, ['doc'], map);
  assert.equal(r.ok, true);
  assert.equal(r.fields.doc, rid(9));
  assert.equal(r.fields.codeId, 'c1', 'everything else is left alone');
});

test('an UNMAPPABLE row reference strands the record rather than moving it wrong', () => {
  // The whole point. Repointing this at whatever now occupies that id would attach a
  // coded quotation to a different participant, and nothing downstream could tell.
  const r = rehomeRecord({ doc: rid(4), codeId: 'c1' }, ['doc'], new Map([[rid(1), rid(9)]]));
  assert.equal(r.ok, false);
});

test('a null row reference is not a broken one', () => {
  const r = rehomeRecord({ doc: null, codeId: 'c1' }, ['doc'], new Map());
  assert.equal(r.ok, true);
});

// --- the plan --------------------------------------------------------------------------

const DECLS = [
  { id: 'segments', rowRefs: ['doc'] },
  { id: 'codes' }, // project-scoped, no row refs — nothing to remap
];

test('the plan counts what moves and what stays, per collection', () => {
  // Counting before applying is the point: "42 codings will move, 3 cannot be matched"
  // is a decision someone can make. An irreversible-feeling operation should never be
  // the first time you learn what it will do.
  const map = { map: new Map([[rid(1), rid(9)]]), strategy: 'key' };
  const plan = planRehome({
    items: [
      { collection: 'segments', id: 's1', fields: { doc: rid(1) } },
      { collection: 'segments', id: 's2', fields: { doc: rid(2) } }, // unmappable
      { collection: 'codes', id: 'c1', fields: { name: 'Trust' } },
    ],
    decls: DECLS,
    analyses: [{ runId: 'r1', datasetId: 'A' }],
    rowMap: map,
  });

  assert.equal(plan.movable, 2, 'one segment + one code');
  assert.equal(plan.stranded, 1);
  assert.equal(plan.analyses, 1);
  assert.equal(plan.strategy, 'key');
  const seg = plan.collections.find((c) => c.collection === 'segments');
  assert.deepEqual(seg, { collection: 'segments', move: 1, strand: 1 });
});

test('nothing to move is reported as empty, not as an empty dialog', () => {
  const plan = planRehome({ items: [], decls: DECLS, analyses: [], rowMap: { map: new Map() } });
  assert.equal(plan.empty, true);
});

test('a collection with no declared rowRefs never strands anything', () => {
  // Project-scoped codes are the case that made half of #151 disappear: they do not
  // reference a row, so they cannot fail to find one.
  const plan = planRehome({
    items: Array.from({ length: 5 }, (_, i) => ({ collection: 'codes', id: `c${i}`, fields: { name: `n${i}` } })),
    decls: DECLS, analyses: [], rowMap: { map: new Map() },
  });
  assert.equal(plan.stranded, 0);
  assert.equal(plan.movable, 5);
});

// --- gathering and applying ------------------------------------------------------------

/** A stand-in item store with the two methods rehome touches. */
function fakeStore(records) {
  const rows = records.map((r) => ({ ...r }));
  return {
    rows,
    list(owner, collection, { dsId } = {}) {
      return rows.filter((r) => r.owner === owner && r.collection === collection
        && (dsId === undefined || r.scope?.dsId == null || String(r.scope.dsId) === String(dsId)));
    },
    put(owner, collection, id, fields, { scope } = {}) {
      const hit = rows.find((r) => r.owner === owner && r.collection === collection && r.id === id);
      if (hit) { hit.fields = fields; hit.scope = scope; }
    },
  };
}

const OWNED = [
  { id: 'segments', owner: 'builtin', rowRefs: ['doc'] },
  { id: 'codes', owner: 'builtin' },
];

test('gather picks up records BOUND to the dataset, not ones merely visible from it', () => {
  // A project-scoped record (null dsId) is visible from every dataset and belongs to
  // none. Moving it would be meaningless — and this is exactly why the codebook stopped
  // being part of #151.
  const store = fakeStore([
    { owner: 'builtin', collection: 'segments', id: 's1', fields: { doc: rid(1) }, scope: { dsId: 'A' } },
    { owner: 'builtin', collection: 'segments', id: 's2', fields: { doc: rid(2) }, scope: { dsId: 'B' } },
    { owner: 'builtin', collection: 'codes', id: 'c1', fields: { name: 'Trust' }, scope: { dsId: null } },
  ]);
  const g = gatherRehome({ fromId: 'A', itemStore: store, decls: OWNED });
  assert.deepEqual(g.items.map((i) => i.id), ['s1'], 'only the record bound to A');
});

test('gather finds the analyses run against that dataset', () => {
  const analysisLog = { entries: () => [
    { runId: 'r1', datasetId: 'A' }, { runId: 'r2', datasetId: 'B' }, { runId: 'r3' },
  ] };
  const g = gatherRehome({ fromId: 'A', itemStore: fakeStore([]), decls: OWNED, analysisLog });
  assert.deepEqual(g.analyses.map((a) => a.runId), ['r1']);
});

test('apply re-scopes under the SAME id, remapping row references', async () => {
  // Same id matters: nothing is duplicated, and anything referencing a record by id
  // still resolves after the move.
  const store = fakeStore([
    { owner: 'builtin', collection: 'segments', id: 's1', fields: { doc: rid(1), codeId: 'c1' }, scope: { dsId: 'A' } },
  ]);
  const items = gatherRehome({ fromId: 'A', itemStore: store, decls: OWNED }).items;
  const res = await applyRehome({
    fromId: 'A', toId: 'B', items, decls: OWNED,
    rowMap: { map: new Map([[rid(1), rid(9)]]) }, itemStore: store,
  });
  assert.equal(res.moved, 1);
  const rec = store.rows[0];
  assert.equal(rec.id, 's1', 'same record, not a copy');
  assert.equal(rec.scope.dsId, 'B');
  assert.equal(rec.fields.doc, rid(9), 'the row reference followed');
  assert.equal(rec.fields.codeId, 'c1');
});

test('a record whose row cannot be mapped is LEFT BEHIND and reported', async () => {
  const store = fakeStore([
    { owner: 'builtin', collection: 'segments', id: 's1', fields: { doc: rid(4) }, scope: { dsId: 'A' } },
  ]);
  const items = gatherRehome({ fromId: 'A', itemStore: store, decls: OWNED }).items;
  const res = await applyRehome({
    fromId: 'A', toId: 'B', items, decls: OWNED,
    rowMap: { map: new Map() }, itemStore: store,
  });
  assert.equal(res.moved, 0);
  assert.equal(res.stranded.length, 1);
  assert.equal(store.rows[0].scope.dsId, 'A', 'still on A — not moved to a wrong row');
});

test('analyses are RE-RUN against B, not relabelled', async () => {
  // An analysis entry records what was run against A. Restamping it with B's id would
  // claim results that were never produced; the numbers in the output are A's.
  const seen = [];
  const analysisLog = { entries: () => [], clearFor: (id) => seen.push(`cleared:${id}`) };
  const res = await applyRehome({
    fromId: 'A', toId: 'B', items: [], decls: OWNED, rowMap: { map: new Map() },
    itemStore: fakeStore([]), analysisLog,
    analyses: [{ runId: 'r1', datasetId: 'A', label: 'Frequencies' }],
    replay: async (e) => { seen.push(`ran:${e.runId}@${e.datasetId}`); },
  });
  assert.equal(res.replayed, 1);
  assert.deepEqual(seen, ['ran:r1@B', 'cleared:A'],
    're-run against B, and A’s stale entry cleared only after it succeeded');
});

test('one failing analysis does not abandon the rest', async () => {
  // A plugin may be deactivated, or B may lack a variable the run needed.
  const res = await applyRehome({
    fromId: 'A', toId: 'B', items: [], decls: OWNED, rowMap: { map: new Map() },
    itemStore: fakeStore([]),
    analyses: [{ runId: 'r1' }, { runId: 'r2' }, { runId: 'r3' }],
    replay: async (e) => { if (e.runId === 'r2') throw new Error('plugin gone'); },
  });
  assert.equal(res.replayed, 2);
  assert.equal(res.failed, 1);
});
