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
} from '../core/collections.js';

const ownerOf = (p) => (p.builtin ? 'builtin' : `plugin:${p.id}`);

test('a full declaration normalises unchanged', () => {
  assert.deepEqual(
    normalizeCollection({ id: 'boundarySets', label: 'Map layers', labelField: 'fileName', sidebar: 'list', assetRefs: ['assetId'] }),
    { id: 'boundarySets', label: 'Map layers', labelField: 'fileName', sidebar: 'list', assetRefs: ['assetId'] },
  );
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

test('recordLabel prefers the declared field and falls back to the id', () => {
  const decl = normalizeCollection({ id: 'boundarySets', labelField: 'fileName' });
  assert.equal(recordLabel(decl, { id: 'it-1', fields: { fileName: 'counties.geojson' } }), 'counties.geojson');
  assert.equal(recordLabel(decl, { id: 'it-1', fields: {} }), 'it-1');
  assert.equal(recordLabel(decl, { id: 'it-1', fields: { fileName: '   ' } }), 'it-1');
  // No labelField declared at all — still never blank.
  assert.equal(recordLabel(normalizeCollection({ id: 'x' }), { id: 'it-2', fields: { name: 'ignored' } }), 'it-2');
});
