/**
 * Headless tests for buildManifest (core/project-store.js) — specifically that it
 * carries the analysis log and the dataset-collection op-log through to the persisted
 * manifest. analysisLog was previously DROPPED here (a pre-existing bug: analyses
 * didn't survive save/reload); collectionLog is unit 6's membership tier. Both must
 * round-trip, or save/load and folder/live sync silently lose them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from '../core/project-store.js';

const bundle = (extra = {}) => ({
  activeId: 1,
  datasets: [{ id: 1, name: 'D', libraryLink: null, state: { sources: [], transforms: [], order: [] } }],
  ...extra,
});

test('buildManifest carries analysisLog (was dropped before — analyses now survive save)', () => {
  const analysisLog = [{ runId: 'r1', label: 'Frequencies', pluginId: 'p', inputs: {} }];
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: bundle({ analysisLog }) });
  assert.deepEqual(m.analysisLog, analysisLog);
});

test('buildManifest carries collectionLog (unit 6 membership tier)', () => {
  const collectionLog = [{ id: 'a1', type: 'addDataset', owner: 'core', target: 'coll/ds:1', payload: { id: 1, name: 'D' } }];
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: bundle({ collectionLog }) });
  assert.deepEqual(m.collectionLog, collectionLog);
});

test('buildManifest defaults both to null when the bundle omits them (old bundles)', () => {
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: bundle() });
  assert.equal(m.analysisLog, null);
  assert.equal(m.collectionLog, null);
});
