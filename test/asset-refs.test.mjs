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

test('removing the last item holding a ref makes its asset an orphan', async () => {
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { assetId: `asset:${A}` });
  const sources = itemRefSources(items, [{ owner: 'builtin', collection: 'boundarySets', field: 'assetId' }]);

  assert.deepEqual((await findOrphans([A], sources)).orphans, []);
  items.remove('builtin', 'boundarySets', 'b1');
  assert.deepEqual((await findOrphans([A], sources)).orphans, [A]);
});

test('two items sharing one asset keep it alive until BOTH go (dedup survives GC)', async () => {
  // The whole reason refcounting is needed rather than delete-with-owner: content
  // addressing means two boundary sets loaded from the same file share bytes.
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const items = new ItemStore({ log });
  items.put('builtin', 'boundarySets', 'b1', { assetId: `asset:${A}` });
  items.put('builtin', 'boundarySets', 'b2', { assetId: `asset:${A}` });
  const sources = itemRefSources(items, [{ owner: 'builtin', collection: 'boundarySets', field: 'assetId' }]);

  items.remove('builtin', 'boundarySets', 'b1');
  assert.deepEqual((await findOrphans([A], sources)).orphans, [], 'still referenced by b2');
  items.remove('builtin', 'boundarySets', 'b2');
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
