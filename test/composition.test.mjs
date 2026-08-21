/**
 * Composition, ordering and conflict policy (#166 step 4).
 *
 * Three properties are being pinned, and the first is a privacy boundary rather than a
 * correctness nicety: a codebook promoted to the shared library must carry its CODES and
 * must NOT carry its CODINGS, because codings are passages of real participant data and a
 * building block exists to be handed to other people.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';
import { ItemStore } from '../core/item-store.js';
import { normalizeCollection, childrenOf, childTravels, surfacesConflicts } from '../core/collections.js';
import { mergeProjects } from '../core/collab-sync.js';
import { sortKeyBetween, nextSortKey } from '../plugins/builtin-caqdas/index.js';
import { recordBlockFromManifest } from '../core/dataset-store.js';

const OWNER = 'builtin-caqdas';
const NUL = String.fromCharCode(0);

/** The CAQDAS declarations, normalised the way the host reads them. */
const DECLS = [
  { id: 'codebooks', portable: true },
  { id: 'codes', parent: { collection: 'codebooks', field: 'codebookId' } },
  { id: 'segments', onConcurrentEdit: 'surface' },
].map((d) => ({ ...normalizeCollection(d), owner: OWNER }));

// --- composition vs dependency ----------------------------------------------

test('codes COMPOSE into a codebook; codings do not', () => {
  assert.deepEqual(childrenOf(DECLS, OWNER, 'codebooks').map((d) => d.id), ['codes']);
  assert.deepEqual(childrenOf(DECLS, OWNER, 'codes'), [],
    'a coding depends on a code but is not part of it — this is what keeps participant '
    + 'passages out of a shared codebook');
});

test('a codebook block gathers its codes and nothing else', () => {
  // The gather logic the library performs, exercised against a real item store.
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1 }), author: () => ({ authorId: 'a' }) });
  const items = new ItemStore({ log });
  items.put(OWNER, 'codebooks', 'bk1', { name: 'Wave 1' });
  items.put(OWNER, 'codes', 'c1', { name: 'waiting', codebookId: 'bk1' });
  items.put(OWNER, 'codes', 'c2', { name: 'kindness', codebookId: 'bk1' });
  items.put(OWNER, 'codes', 'c3', { name: 'other book', codebookId: 'bk2' });
  items.put(OWNER, 'segments', 's1', { doc: 'r1', codeId: 'c1', quote: 'we had to wait' });

  const collected = [];
  for (const kid of childrenOf(DECLS, OWNER, 'codebooks')) {
    for (const child of items.list(OWNER, kid.id)) {
      if (String(child.fields?.[kid.parent.field]) !== 'bk1') continue;
      collected.push({ collection: kid.id, id: child.id });
    }
  }
  assert.deepEqual(collected.map((c) => c.id).sort(), ['c1', 'c2'], 'only THIS book’s codes');
  assert.ok(!collected.some((c) => c.collection === 'segments'), 'never a coding');
});

test('a dataset-bound child never travels, whatever its collection declares', () => {
  // The record's scope is evidence, not a guess: the host resolved it at write time from
  // the collection's scope (or the workspace's, when the collection omits one).
  const projectScoped = { ...normalizeCollection({ id: 'codes' }), owner: OWNER };
  assert.equal(childTravels(projectScoped, { scope: { dsId: null } }), true);
  assert.equal(childTravels(projectScoped, { scope: { dsId: 7 } }), false,
    'bound to dataset 7, so it means nothing in the project this block is handed to');
  assert.equal(childTravels(projectScoped, {}), true, 'no scope at all is project-wide');
});

test('a collection DECLARED dataset-scoped never travels either', () => {
  const perDataset = { ...normalizeCollection({ id: 'segments', scope: 'dataset' }), owner: OWNER };
  assert.equal(childTravels(perDataset, { scope: { dsId: null } }), false,
    'the declaration alone is disqualifying — the record need not be inspected');
});

test('a MIS-DECLARED parent is still harmless: the quote stays in the project', () => {
  // #163 asked for belt and braces so this privacy boundary does not rest on one
  // declaration staying right. Here it is wrong on purpose: segments claim to COMPOSE
  // into a codebook. The gather must still refuse them.
  const decls = [
    { id: 'codebooks', portable: true },
    { id: 'codes', scope: 'project', parent: { collection: 'codebooks', field: 'codebookId' } },
    { id: 'segments', scope: 'dataset', parent: { collection: 'codebooks', field: 'codebookId' } },
  ].map((d) => ({ ...normalizeCollection(d), owner: OWNER }));

  const log = new ProjectLog({ hlc: new HLC({ now: () => 1 }), author: () => ({ authorId: 'a' }) });
  const items = new ItemStore({ log });
  items.put(OWNER, 'codebooks', 'bk1', { name: 'Wave 1' });
  items.put(OWNER, 'codes', 'c1', { name: 'waiting', codebookId: 'bk1' });
  items.put(OWNER, 'segments', 's1',
    { doc: 'r1', codeId: 'c1', codebookId: 'bk1', quote: 'I waited four hours in A&E' },
    { scope: { dsId: 7 } });

  const collected = [];
  for (const kid of childrenOf(decls, OWNER, 'codebooks')) {
    for (const child of items.list(OWNER, kid.id)) {
      if (String(child.fields?.[kid.parent.field]) !== 'bk1') continue;
      if (!childTravels(kid, child)) continue;
      collected.push({ collection: kid.id, id: child.id });
    }
  }
  assert.deepEqual(collected.map((c) => c.id), ['c1']);
  assert.ok(!collected.some((c) => c.collection === 'segments'),
    'the participant passage never leaves, even though the declaration said it composes');
});

// --- ordering ----------------------------------------------------------------

test('a fractional key inserts between neighbours without renumbering them', () => {
  assert.equal(sortKeyBetween(1, 2), 1.5);
  assert.equal(sortKeyBetween(null, 5), 4, 'before the first');
  assert.equal(sortKeyBetween(3, null), 4, 'after the last');
  assert.equal(sortKeyBetween(null, null), 1, 'an empty book');
});

test('repeated inserts between the same pair keep converging, never colliding', () => {
  let lo = 1;
  const hi = 2;
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const k = sortKeyBetween(lo, hi);
    assert.ok(k > lo && k < hi, 'stays strictly between');
    assert.ok(!seen.has(k), 'and never repeats a key');
    seen.add(k);
    lo = k;
  }
});

test('nextSortKey appends past whatever is there, ignoring unkeyed codes', () => {
  assert.equal(nextSortKey([]), 1);
  assert.equal(nextSortKey([{ sort: 1 }, { sort: 4 }, { name: 'unkeyed' }]), 5);
});

// --- conflict policy ---------------------------------------------------------

test('the policy is per collection, so opting codings in leaves others on LWW', () => {
  assert.ok(surfacesConflicts(DECLS, OWNER, 'segments'));
  assert.ok(!surfacesConflicts(DECLS, OWNER, 'codes'));
  assert.ok(!surfacesConflicts(DECLS, 'builtin-spatial', 'boundarySets'));
});

/** Two peers, one shared record, each editing it without seeing the other. */
function divergedPeers(fieldsA, fieldsB) {
  const peer = (wall, author) => {
    const log = new ProjectLog({ hlc: new HLC({ now: () => wall }), author: () => author });
    return { log, store: new ItemStore({ log }) };
  };
  const a = peer(1000, { authorId: 'kc', initials: 'KC' });
  const b = peer(1001, { authorId: 'rm', initials: 'RM' });
  a.store.put(OWNER, 'segments', 's1', fieldsA);
  b.store.put(OWNER, 'segments', 's1', fieldsB);
  return [a.log.serialize(), b.log.serialize()];
}

const surfaces = (owner, collection) => surfacesConflicts(DECLS, owner, collection);

test('two coders re-anchoring one coding differently is SURFACED, not silently decided', () => {
  const [mine, theirs] = divergedPeers(
    { anchor: { ref: { selectors: [{ kind: 'text-quote', exact: 'we had to wait' }] } } },
    { anchor: { ref: { selectors: [{ kind: 'text-quote', exact: 'had to wait three hours' }] } } },
  );
  const { conflicts } = mergeProjects({ log: mine }, { log: theirs }, {}, null, { surfaces });
  const boundary = conflicts.filter((c) => c.kind === 'item-field' && c.field === 'anchor');
  assert.equal(boundary.length, 1, 'a boundary disagreement must reach the user');
  assert.ok(boundary[0].scope.includes(`segments${NUL}s1`));
});

test('without the policy the same merge stays silent — existing plugins are unaffected', () => {
  const [mine, theirs] = divergedPeers({ codeId: 'c1' }, { codeId: 'c2' });
  const { conflicts } = mergeProjects({ log: mine }, { log: theirs }, {});
  assert.deepEqual(conflicts.filter((c) => c.kind === 'item-field'), []);
});

test('edits to DIFFERENT fields of one coding are not a conflict — the fold keeps both', () => {
  const [mine, theirs] = divergedPeers({ anchor: { ref: 1 } }, { codeId: 'c9' });
  const { conflicts } = mergeProjects({ log: mine }, { log: theirs }, {}, null, { surfaces });
  assert.deepEqual(conflicts.filter((c) => c.kind === 'item-field'), [],
    'this is exactly what narrow writes buy');
});

test('the same value written by both peers is agreement, not conflict', () => {
  const [mine, theirs] = divergedPeers({ codeId: 'c1', quote: 'wait' }, { codeId: 'c1', quote: 'wait' });
  const { conflicts } = mergeProjects({ log: mine }, { log: theirs }, {}, null, { surfaces });
  assert.deepEqual(conflicts.filter((c) => c.kind === 'item-field'), []);
});

test('surfacing ADDS a conflict without dropping either write', () => {
  const [mine, theirs] = divergedPeers({ quote: 'a' }, { quote: 'b' });
  const { manifest } = mergeProjects({ log: mine }, { log: theirs }, {}, null, { surfaces });
  const puts = manifest.log.filter((o) => o.type === 'putItem');
  assert.equal(puts.length, 2, 'both peers keep everything they wrote');
});

// --- regressions from human testing (2026-08-19) ------------------------------

test('a record block ROUND-TRIPS its children — the write side is not enough', () => {
  // Reported from real use: "codebook saved to building blocks, added to a new project,
  // no codes." `saveRecord` persisted `children`; `load()` rebuilt its return object field
  // by field and nobody added the new one — so every block on disk was complete and every
  // add produced an empty codebook, with nothing failing anywhere. Now the mapping is a
  // pure function and this exercises it directly.
  const manifest = {
    kind: 'record',
    name: 'Wave 1',
    savedAt: 1,
    version: 3,
    record: { owner: OWNER, collection: 'codebooks', id: 'bk1', fields: { name: 'Wave 1' } },
    children: [
      { collection: 'codes', id: 'c1', parentField: 'codebookId', fields: { name: 'waiting', codebookId: 'bk1' } },
      { collection: 'codes', id: 'c2', parentField: 'codebookId', fields: { name: 'kindness', codebookId: 'bk1' } },
    ],
  };
  const loaded = recordBlockFromManifest('blk', manifest, []);
  assert.equal(loaded.children.length, 2, 'a codebook without its codes is just a name');
  assert.deepEqual(loaded.children.map((c) => c.fields.name).sort(), ['kindness', 'waiting']);
  assert.equal(loaded.record.id, 'bk1', 'and the record keeps the id a later pull matches on');
  assert.equal(loaded.version, 3);
});

test('a block with no children (a map layer) still loads, and never yields undefined', () => {
  const loaded = recordBlockFromManifest('blk', { name: 'Counties', record: { collection: 'boundarySets' } });
  assert.deepEqual(loaded.children, [], 'never undefined — callers iterate this');
  assert.equal(loaded.version, 1);
  assert.deepEqual(recordBlockFromManifest('blk', null).children, []);
});

test('adding a block repoints children at the parent id actually used', () => {
  // The re-point matters even though ids are preserved: a caller may supply its own
  // parent id, and a child left pointing at the old one would vanish from the book.
  const children = [{ collection: 'codes', id: 'c1', parentField: 'codebookId', fields: { name: 'x', codebookId: 'OLD' } }];
  const parentId = 'bk1';
  const applied = children.map((c) => ({ ...c.fields, [c.parentField]: parentId }));
  assert.equal(applied[0].codebookId, 'bk1');
});
