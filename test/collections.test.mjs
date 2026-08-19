/**
 * Headless tests for collection declarations (core/collections.js, #152).
 * Run: `npm test`.
 *
 * The declaration is the ONLY thing the host knows about a plugin's records, so the
 * failure mode that matters is a malformed manifest taking out more than its own entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCollection,
  declaredCollections,
  assetRefDecls,
  sidebarCollections,
  recordLabel,
  undeclaredItemsGuard,
  CORE_COLLECTIONS,
  anchorRefDecls,
  childrenOf,
  surfacesConflicts,
} from '../core/collections.js';

const ownerOf = (p) => (p.builtin ? 'builtin' : `plugin:${p.id}`);

test('a full declaration normalises unchanged', () => {
  const full = {
    id: 'boundarySets', label: 'Map layers', labelField: 'fileName',
    summaryField: 'featureCount', sidebar: 'list', assetRefs: ['assetId'], portable: true,
    scope: 'project', rowRefs: [], anchorRefs: [], parent: null, onConcurrentEdit: 'lww',
  };
  assert.deepEqual(normalizeCollection(full), full);
});

test('scope is tri-state: omitted means INHERIT the workspace, not "dataset"', () => {
  // The distinction matters. builtin-spatial declares a project-scoped WORKSPACE and its
  // collections say nothing about scope; defaulting them to 'dataset' would silently
  // re-scope every boundary set to the active dataset and empty the sidebar.
  assert.equal(normalizeCollection({ id: 'x' }).scope, null, 'omitted = inherit');
  assert.equal(normalizeCollection({ id: 'x', scope: 'project' }).scope, 'project');
  assert.equal(normalizeCollection({ id: 'x', scope: 'dataset' }).scope, 'dataset');
});

test('a malformed scope is ignored rather than guessed', () => {
  // Same rule as the rest of this normaliser: a bad manifest costs that plugin the
  // feature, never the whole sidebar — and guessing here would move people's records.
  for (const bad of ['Project', 'global', '', 1, true, null, {}]) {
    assert.equal(normalizeCollection({ id: 'x', scope: bad }).scope, null, String(bad));
  }
});

test('portable is opt-in and strictly boolean', () => {
  // Whether a record means anything OUTSIDE its project is knowable only to the
  // collection's author, so the host must not infer it. Default false: being listed in
  // the sidebar and being reusable elsewhere are different questions, and conflating them
  // is what briefly made memos draggable to the library.
  assert.equal(normalizeCollection({ id: 'x' }).portable, false);
  assert.equal(normalizeCollection({ id: 'x', portable: 'yes' }).portable, false);
  assert.equal(normalizeCollection({ id: 'x', portable: 1 }).portable, false);
  assert.equal(normalizeCollection({ id: 'x', portable: true }).portable, true);
});

test('core memos are NOT portable — an anchor does not survive the move', () => {
  const memos = CORE_COLLECTIONS.find((c) => c.id === 'memos');
  assert.equal(memos.sidebar, 'list', 'listed…');
  assert.equal(memos.portable, false, '…but not reusable elsewhere');
});

test('summaryField defaults to null and rejects junk', () => {
  // It names the field shown where a dataset shows its row count (#153 D3), so a
  // non-string must not reach the renderer.
  assert.equal(normalizeCollection({ id: 'x' }).summaryField, null);
  assert.equal(normalizeCollection({ id: 'x', summaryField: 7 }).summaryField, null);
  assert.equal(normalizeCollection({ id: 'x', summaryField: 'featureCount' }).summaryField, 'featureCount');
});

test('label defaults to the id, so a heading is never blank', () => {
  assert.equal(normalizeCollection({ id: 'memos' }).label, 'memos');
});

test('sidebar defaults to none — visibility is opt-in, never accidental', () => {
  assert.equal(normalizeCollection({ id: 'memos' }).sidebar, 'none');
  assert.equal(normalizeCollection({ id: 'memos', sidebar: 'wat' }).sidebar, 'none');
  assert.equal(normalizeCollection({ id: 'memos', sidebar: 'count' }).sidebar, 'count');
});

test('a declaration with no id is dropped rather than throwing', () => {
  assert.equal(normalizeCollection({}), null);
  assert.equal(normalizeCollection({ id: '   ' }), null);
  assert.equal(normalizeCollection(null), null);
});

test('junk in labelField / assetRefs is discarded, not propagated', () => {
  const d = normalizeCollection({ id: 'x', labelField: 42, assetRefs: ['ok', 7, null, ''] });
  assert.equal(d.labelField, null);
  assert.deepEqual(d.assetRefs, ['ok']);
});

test('ONE bad declaration costs that entry only, not the whole sidebar', () => {
  const decls = declaredCollections(
    [{ id: 'p', builtin: true, collections: [{ id: 'good', sidebar: 'list' }, { nope: true }, { id: 'alsoGood' }] }],
    ownerOf,
  );
  assert.deepEqual(decls.map((d) => d.id), ['good', 'alsoGood']);
});

test('declaredCollections tags each with its owner and skips plugins declaring none', () => {
  const decls = declaredCollections([
    { id: 'builtin-spatial', builtin: true, collections: [{ id: 'boundarySets' }] },
    { id: 'third-party', collections: [{ id: 'boundarySets' }] },
    { id: 'builtin-crosstabs', builtin: true },
  ], ownerOf);
  assert.deepEqual(decls.map((d) => `${d.owner}/${d.id}`), ['builtin/boundarySets', 'plugin:third-party/boundarySets']);
});

test('two plugins may use the same collection name — owner keeps them apart', () => {
  const decls = declaredCollections([
    { id: 'a', builtin: true, collections: [{ id: 'notes', assetRefs: ['ref'] }] },
    { id: 'b', collections: [{ id: 'notes', assetRefs: ['ref'] }] },
  ], ownerOf);
  assert.deepEqual(assetRefDecls(decls), [
    { owner: 'builtin', collection: 'notes', field: 'ref' },
    { owner: 'plugin:b', collection: 'notes', field: 'ref' },
  ]);
});

test('assetRefDecls flattens multiple ref fields on one collection', () => {
  const decls = declaredCollections(
    [{ id: 'p', builtin: true, collections: [{ id: 'docs', assetRefs: ['primary', 'thumbnail'] }] }],
    ownerOf,
  );
  assert.deepEqual(assetRefDecls(decls).map((d) => d.field), ['primary', 'thumbnail']);
});

test('sidebarCollections keeps list and count, drops none', () => {
  const decls = declaredCollections([{
    id: 'p', builtin: true,
    collections: [
      { id: 'boundarySets', sidebar: 'list' },
      { id: 'codes', sidebar: 'count' },
      { id: 'segments', sidebar: 'none' },
      { id: 'internal' }, // defaulted to none
    ],
  }], ownerOf);
  assert.deepEqual(sidebarCollections(decls).map((d) => d.id), ['boundarySets', 'codes']);
});

// --- the undeclared-collection guard ----------------------------------------
// Found by browser-testing the real app: the abstain rule catches a scanner that THROWS,
// but not a declaration nobody wrote. Without this guard, a plugin author who stores an
// asset ref in an item field and forgets to declare it gets those bytes swept.

test('guard passes when every collection holding records is declared', () => {
  const decls = declaredCollections([{ id: 'p', builtin: true, collections: [{ id: 'boundarySets' }] }], ownerOf);
  const guard = undeclaredItemsGuard([{ owner: 'builtin', collection: 'boundarySets' }], decls);
  assert.deepEqual([...guard.ids()], []);
});

test('guard THROWS on an undeclared collection, so the sweep abstains', () => {
  const decls = declaredCollections([{ id: 'p', builtin: true, collections: [{ id: 'boundarySets' }] }], ownerOf);
  const guard = undeclaredItemsGuard([{ owner: 'builtin', collection: 'secretStash' }], decls);
  assert.throws(() => guard.ids(), /no manifest declaration.*builtin\/secretStash/);
});

test('guard is owner-aware: a declaration by one owner does not cover another', () => {
  const decls = declaredCollections([{ id: 'a', builtin: true, collections: [{ id: 'notes' }] }], ownerOf);
  const guard = undeclaredItemsGuard([{ owner: 'plugin:b', collection: 'notes' }], decls);
  assert.throws(() => guard.ids(), /plugin:b\/notes/);
});

test('guard reports every undeclared collection at once, deduped and sorted', () => {
  const guard = undeclaredItemsGuard([
    { owner: 'builtin', collection: 'zebra' },
    { owner: 'builtin', collection: 'apple' },
    { owner: 'builtin', collection: 'zebra' },
  ], []);
  assert.throws(() => guard.ids(), /builtin\/apple, builtin\/zebra/);
});

test('CORE_COLLECTIONS covers core-owned records, so core never trips its own guard', () => {
  // Core has no manifest; without its own declaration list every sweep would abstain.
  const guard = undeclaredItemsGuard([{ owner: 'core', collection: 'memos' }], CORE_COLLECTIONS);
  assert.deepEqual([...guard.ids()], []);
});

test('an empty item tier never trips the guard', () => {
  assert.deepEqual([...undeclaredItemsGuard([], []).ids()], []);
});

test('recordLabel prefers the declared field and falls back to the id', () => {
  const decl = normalizeCollection({ id: 'boundarySets', labelField: 'fileName' });
  assert.equal(recordLabel(decl, { id: 'it-1', fields: { fileName: 'counties.geojson' } }), 'counties.geojson');
  assert.equal(recordLabel(decl, { id: 'it-1', fields: {} }), 'it-1');
  assert.equal(recordLabel(decl, { id: 'it-1', fields: { fileName: '   ' } }), 'it-1');
  // No labelField declared at all — still never blank.
  assert.equal(recordLabel(normalizeCollection({ id: 'x' }), { id: 'it-2', fields: { name: 'ignored' } }), 'it-2');
});

test('rowRefs is declared, never inferred', () => {
  // Same rule as assetRefs. A string field holding "1000000003" looks like any other
  // string, so a host that guessed would corrupt records rather than re-home them.
  assert.deepEqual(normalizeCollection({ id: 'x' }).rowRefs, [], 'none by default');
  assert.deepEqual(normalizeCollection({ id: 'x', rowRefs: ['doc'] }).rowRefs, ['doc']);
  assert.deepEqual(normalizeCollection({ id: 'x', rowRefs: 'doc' }).rowRefs, [], 'a bare string is not a list');
  assert.deepEqual(normalizeCollection({ id: 'x', rowRefs: ['doc', 7, '', null] }).rowRefs, ['doc'],
    'junk entries are dropped, the good one survives');
});

// --- anchors, composition, conflict policy (#166) ----------------------------

test('anchorRefs are declared, never inferred — and malformed entries are dropped', () => {
  const d = normalizeCollection({ id: 'segments', anchorRefs: ['anchor', '', 42, 'other'] });
  assert.deepEqual(d.anchorRefs, ['anchor', 'other']);
  assert.deepEqual(normalizeCollection({ id: 'x' }).anchorRefs, []);
});

test('anchorRefDecls flattens to (owner, collection, field), like assetRefDecls', () => {
  const decls = [
    { owner: 'builtin-caqdas', id: 'segments', anchorRefs: ['anchor'] },
    { owner: 'core', id: 'memos', anchorRefs: [] },
  ];
  assert.deepEqual(anchorRefDecls(decls), [
    { owner: 'builtin-caqdas', collection: 'segments', field: 'anchor' },
  ]);
});

test('a parent needs BOTH coordinates — half a declaration is dropped, not half-honoured', () => {
  assert.deepEqual(
    normalizeCollection({ id: 'codes', parent: { collection: 'codebooks', field: 'codebookId' } }).parent,
    { collection: 'codebooks', field: 'codebookId' },
  );
  assert.equal(normalizeCollection({ id: 'codes', parent: { collection: 'codebooks' } }).parent, null);
  assert.equal(normalizeCollection({ id: 'codes', parent: { field: 'codebookId' } }).parent, null);
  assert.equal(normalizeCollection({ id: 'codes' }).parent, null);
});

test('childrenOf finds what is COMPOSED into a record, and only within one owner', () => {
  const decls = [
    { owner: 'builtin-caqdas', id: 'codes', parent: { collection: 'codebooks', field: 'codebookId' } },
    { owner: 'builtin-caqdas', id: 'segments', parent: null },
    { owner: 'other-plugin', id: 'things', parent: { collection: 'codebooks', field: 'codebookId' } },
  ];
  const kids = childrenOf(decls, 'builtin-caqdas', 'codebooks');
  assert.deepEqual(kids.map((d) => d.id), ['codes']);
  assert.deepEqual(childrenOf(decls, 'builtin-caqdas', 'codes'), []);
});

test('a dependency (segment → code) is NOT composition — it must never travel', () => {
  // Declared with no `parent`: segments reference a code but are not part of a codebook.
  // This is the guard against a shared codebook carrying participant passages with it.
  const decls = [{ owner: 'builtin-caqdas', id: 'segments', parent: null }];
  assert.deepEqual(childrenOf(decls, 'builtin-caqdas', 'codes'), []);
});

test('onConcurrentEdit defaults to lww and only the exact opt-in changes it', () => {
  assert.equal(normalizeCollection({ id: 'x' }).onConcurrentEdit, 'lww');
  assert.equal(normalizeCollection({ id: 'x', onConcurrentEdit: 'surface' }).onConcurrentEdit, 'surface');
  assert.equal(normalizeCollection({ id: 'x', onConcurrentEdit: 'nonsense' }).onConcurrentEdit, 'lww');
  assert.equal(normalizeCollection({ id: 'x', onConcurrentEdit: true }).onConcurrentEdit, 'lww');
});

test('surfacesConflicts is per collection, so opting one in leaves the rest on lww', () => {
  const decls = [
    { owner: 'builtin-caqdas', id: 'segments', onConcurrentEdit: 'surface' },
    { owner: 'builtin-spatial', id: 'boundarySets', onConcurrentEdit: 'lww' },
  ];
  assert.ok(surfacesConflicts(decls, 'builtin-caqdas', 'segments'));
  assert.ok(!surfacesConflicts(decls, 'builtin-spatial', 'boundarySets'));
  assert.ok(!surfacesConflicts(decls, 'builtin-caqdas', 'codes'));
});
