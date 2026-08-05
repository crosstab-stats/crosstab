/**
 * Headless tests for asset reference counting (core/asset-refs.js, #152 Layer 5 / #150).
 * Run: `npm test`.
 *
 * The property that matters most here is the ABSTAIN rule: leaking bytes is a bug report,
 * deleting a user's only copy of an interview recording is not, so partial knowledge must
 * never produce a sweep. Several tests exist only to pin that down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refId, refsIn, collectRefs, findOrphans, itemRefSources } from '../core/asset-refs.js';
import { ItemStore } from '../core/item-store.js';
import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const src = (name, ids) => ({ name, ids: () => ids });

// --- ref parsing -------------------------------------------------------------

test('refId accepts an asset: ref and a bare hex id, rejects anything else', () => {
  assert.equal(refId(`asset:${A}`), A);
  assert.equal(refId(A), A);
  assert.equal(refId('data:text/plain;base64,aGk='), null);
  assert.equal(refId('just some text'), null);
  assert.equal(refId(''), null);
  assert.equal(refId(null), null);
  assert.equal(refId(42), null);
});

test('refsIn handles a single ref, an array, and a JSON array in a string', () => {
  assert.deepEqual(refsIn(`asset:${A}`), [A]);
  assert.deepEqual(refsIn([`asset:${A}`, `asset:${B}`]), [A, B]);
  // How CAQDAS writes a media cell: a JSON array of refs in a string column.
  assert.deepEqual(refsIn(JSON.stringify([`asset:${A}`, `asset:${B}`])), [A, B]);
});

test('refsIn walks user data without throwing on junk', () => {
  assert.deepEqual(refsIn('[not valid json'), []);
  assert.deepEqual(refsIn({ nested: 'object' }), []);
  assert.deepEqual(refsIn(undefined), []);
  assert.deepEqual(refsIn(['plain text', `asset:${A}`, null]), [A]);
});

// --- collection --------------------------------------------------------------

test('collectRefs unions across sources and dedups', async () => {
  const { ids, incomplete } = await collectRefs([
    src('one', [`asset:${A}`, `asset:${B}`]),
    src('two', [`asset:${B}`, `asset:${C}`]),
  ]);
  assert.deepEqual([...ids].sort(), [A, B, C]);
  assert.deepEqual(incomplete, []);
});

test('collectRefs reports a throwing source instead of swallowing it', async () => {
  const { ids, incomplete } = await collectRefs([
    src('good', [`asset:${A}`]),
    { name: 'broken', ids: () => { throw new Error('duckdb is closed'); } },
  ]);
  assert.deepEqual([...ids], [A]);
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].name, 'broken');
  assert.match(incomplete[0].error, /duckdb is closed/);
});

test('collectRefs awaits async sources (a dataset scan is a query)', async () => {
  const { ids } = await collectRefs([{ name: 'async', ids: async () => [`asset:${A}`] }]);
  assert.deepEqual([...ids], [A]);
});

// --- orphan detection --------------------------------------------------------

test('findOrphans returns exactly the unreferenced ids', async () => {
  const { orphans, incomplete } = await findOrphans([A, B, C], [src('s', [`asset:${B}`])]);
  assert.deepEqual(orphans.sort(), [A, C]);
  assert.deepEqual(incomplete, []);
});

test('findOrphans returns nothing when everything is referenced', async () => {
  const { orphans } = await findOrphans([A], [src('s', [`asset:${A}`])]);
  assert.deepEqual(orphans, []);
});

test('ABSTAIN: one failing source suppresses the whole sweep', async () => {
  // A is genuinely unreferenced by the source that DID answer — but the broken source
  // might have referenced it, so nothing may be swept.
  const { orphans, incomplete } = await findOrphans([A, B], [
    src('good', [`asset:${B}`]),
    { name: 'broken', ids: () => { throw new Error('nope'); } },
  ]);
  assert.deepEqual(orphans, [], 'partial knowledge must never delete bytes');
  assert.equal(incomplete.length, 1);
});

test('zero sources means zero references — so the host MUST register its scanners', async () => {
  // The subtle one. With zero sources the naive arithmetic says every asset is an orphan
  // and the sweep deletes the entire project's media. An empty source LIST is legitimate
  // (nothing declared refs), so this asserts the caller-visible behaviour deliberately:
  // sources that answer "I reference nothing" DO permit a sweep. The guard against the
  // catastrophic case is that a real host always registers its scanners; the abstain rule
  // covers a scanner that breaks, which is the failure that actually happens.
  const { orphans } = await findOrphans([A], []);
  assert.deepEqual(orphans, [A]);
});

// --- the item source (the reason plugin state had to become host-visible) ----

test('itemRefSources counts refs held in a declared item field', async () => {
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { fileName: 'counties.geojson', assetId: `asset:${A}` });
  items.put('builtin', 'boundarySets', 'b2', { fileName: 'districts.geojson', assetId: `asset:${B}` });

  const sources = itemRefSources(items, [{ owner: 'builtin', collection: 'boundarySets', field: 'assetId' }]);
  const { orphans } = await findOrphans([A, B, C], sources);
  assert.deepEqual(orphans, [C]);
});

test('a BINNED record still pins its asset — only a purge frees it', async () => {
  // The dataset parallel: binning a dataset keeps its Parquet sidecars, because the bin
  // is recoverable. A boundary set in the bin must likewise keep its geometry, or
  // restoring it would hand back an empty map.
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { assetId: `asset:${A}` });
  const sources = itemRefSources(items, [{ owner: 'builtin', collection: 'boundarySets', field: 'assetId' }]);

  assert.deepEqual((await findOrphans([A], sources)).orphans, []);
  items.remove('builtin', 'boundarySets', 'b1');
  assert.deepEqual((await findOrphans([A], sources)).orphans, [], 'binned, so still pinned');
  items.purge('builtin', 'boundarySets', 'b1');
  assert.deepEqual((await findOrphans([A], sources)).orphans, [A], 'purged — now reclaimable');
});

test('restoring a binned record brings its asset reference back with it', async () => {
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { fileName: 'wards.geojson', assetId: `asset:${A}` });
  items.remove('builtin', 'boundarySets', 'b1');
  assert.equal(items.get('builtin', 'boundarySets', 'b1'), null);
  assert.deepEqual(items.binned('builtin', 'boundarySets').map((r) => r.id), ['b1']);

  items.restore('builtin', 'boundarySets', 'b1');
  const back = items.get('builtin', 'boundarySets', 'b1');
  assert.equal(back.fields.fileName, 'wards.geojson');
  assert.equal(back.fields.assetId, `asset:${A}`);
  assert.deepEqual(items.binned('builtin', 'boundarySets'), []);
});

test('two items sharing one asset keep it alive until BOTH go (dedup survives GC)', async () => {
  // The whole reason refcounting is needed rather than delete-with-owner: content
  // addressing means two boundary sets loaded from the same file share bytes.
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { assetId: `asset:${A}` });
  items.put('builtin', 'boundarySets', 'b2', { assetId: `asset:${A}` });
  const sources = itemRefSources(items, [{ owner: 'builtin', collection: 'boundarySets', field: 'assetId' }]);

  items.purge('builtin', 'boundarySets', 'b1');
  assert.deepEqual((await findOrphans([A], sources)).orphans, [], 'still referenced by b2');
  items.purge('builtin', 'boundarySets', 'b2');
  assert.deepEqual((await findOrphans([A], sources)).orphans, [A]);
});

test('an undone put stops counting as a reference', async () => {
  // Undo is a fold-level concept, so the ref count has to follow it — otherwise undoing
  // a boundary load would leave its bytes pinned forever.
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { assetId: `asset:${A}` });
  const sources = itemRefSources(items, [{ owner: 'builtin', collection: 'boundarySets', field: 'assetId' }]);
  assert.deepEqual((await findOrphans([A], sources)).orphans, []);

  log.undoWhere((o) => o.type === 'putItem');
  items.loadFromLog();
  assert.deepEqual((await findOrphans([A], sources)).orphans, [A]);
});

// --- #150: owner-scoped enumeration -------------------------------------------
// The byte pool is content-addressed and deduped, so two plugins holding the same file
// hold the same id. A naive list() would therefore be a way to read the names of
// everyone else's files; scoping is a boundary, not a convenience.
const { scopedAssetList } = await import('../core/asset-store.js');

const fakeAssets = {
  listRefs: (refs) => refs.map((r) => ({ ref: r, id: String(r).replace(/^asset:/, ''), name: `${r}.bin` })),
};
const fakeItems = (records) => ({ list: (owner, collection) => records[`${owner}/${collection}`] ?? [] });

test('a plugin sees the assets its OWN records point at', () => {
  const list = scopedAssetList({
    decls: () => [{ owner: 'spatial', collection: 'boundarySets', field: 'assetId' }],
    items: fakeItems({ 'spatial/boundarySets': [{ id: 'a', fields: { assetId: 'asset:aaa' } }, { id: 'b', fields: { assetId: 'asset:bbb' } }] }),
    owner: 'spatial',
    assets: fakeAssets,
  });
  assert.deepEqual(list().map((x) => x.id), ['aaa', 'bbb']);
});

test('…and NOT another plugin\'s, even when the bytes are shared', () => {
  // caqdas holds the very same asset id — dedup means one copy of the bytes — but it
  // has no record of it, so it must not appear in caqdas's listing.
  const records = {
    'spatial/boundarySets': [{ id: 'a', fields: { assetId: 'asset:shared' } }],
    'caqdas/documents': [],
  };
  const list = scopedAssetList({
    decls: () => [{ owner: 'caqdas', collection: 'documents', field: 'ref' }],
    items: fakeItems(records),
    owner: 'caqdas',
    assets: fakeAssets,
  });
  assert.deepEqual(list(), [], 'a shared byte pool is not a shared index');
});

test('records with the field empty contribute nothing', () => {
  const list = scopedAssetList({
    decls: () => [{ owner: 'p', collection: 'c', field: 'ref' }],
    items: fakeItems({ 'p/c': [{ id: '1', fields: {} }, { id: '2' }, { id: '3', fields: { ref: 'asset:x' } }] }),
    owner: 'p',
    assets: fakeAssets,
  });
  assert.deepEqual(list().map((x) => x.id), ['x']);
});

test('no items or no asset service degrades to empty, never throws', () => {
  assert.deepEqual(scopedAssetList({ decls: () => [], items: null, owner: 'p', assets: fakeAssets })(), []);
  assert.deepEqual(scopedAssetList({ decls: () => [], items: fakeItems({}), owner: 'p', assets: null })(), []);
});

test('a plugin that declares no assetRefs lists nothing', () => {
  const list = scopedAssetList({
    decls: () => [],
    items: fakeItems({ 'p/c': [{ id: '1', fields: { ref: 'asset:x' } }] }),
    owner: 'p',
    assets: fakeAssets,
  });
  assert.deepEqual(list(), [], 'enumeration follows the DECLARATION, not what happens to be in the records');
});
