/**
 * Headless tests for buildManifest (core/project-store.js) — the single-flat-log
 * manifest (#148): every tier is ops in one `manifest.log`, source-op Parquet bytes are
 * stripped to op-id-keyed file refs (written separately), and the non-log scalars
 * (activeId/activePlugins/output/datasetMeta/collab) ride alongside. There is no longer
 * a datasets[]/collectionLog/analysisLog/orphanDataOps split — they're all just ops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from '../core/project-store.js';

const op = (over) => ({ id: 'op-x', hlc: { wall: 1, counter: 0 }, owner: 'core', reads: [], ...over });

test('buildManifest carries the whole flat log verbatim (every tier is ops)', () => {
  const log = [
    op({ id: 'c1', target: 'coll/ds:1', type: 'addDataset', payload: { id: 1, name: 'D' } }),
    op({ id: 't1', target: 'ds:1/var:x', type: 'computeVar', payload: { name: 'x', expr: '1' } }),
    op({ id: 'a1', target: 'analysis:r1', type: 'runAnalysis', payload: { runId: 'r1', label: 'Freq' } }),
  ];
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: { log, activeId: 1 } });
  assert.deepEqual(m.log, log); // non-source ops pass through untouched
  assert.equal(m.activeId, 1);
});

test('buildManifest strips a source op’s Parquet bytes to a file ref (kept), never bytes', () => {
  const log = [
    op({
      id: 'op-src1', target: 'ds:1/source:op-src1', type: 'load',
      payload: { src: { meta: [{ name: 'x' }], label: 'f.csv', file: 'src_op-src1.parquet', parquet: new Uint8Array([1, 2, 3]) } },
    }),
  ];
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: { log, activeId: 1 } });
  assert.equal(m.log[0].payload.src.file, 'src_op-src1.parquet');
  assert.equal(m.log[0].payload.src.parquet, undefined); // bytes never in the manifest
  assert.deepEqual(m.log[0].payload.src.meta, [{ name: 'x' }]);
});

test('buildManifest carries the non-log scalars and defaults them when omitted', () => {
  const full = buildManifest({ name: 'P', savedAt: 1, bundle: { log: [], activeId: 2, activePlugins: ['p'], datasetMeta: { 2: { libraryLink: { id: 'b', version: 1 } } }, collabId: 'c', collabSecret: 's' } });
  assert.deepEqual(full.activePlugins, ['p']);
  assert.deepEqual(full.datasetMeta, { 2: { libraryLink: { id: 'b', version: 1 } } });
  assert.equal(full.collabId, 'c');

  const bare = buildManifest({ name: 'P', savedAt: 1, bundle: { log: [] } });
  assert.deepEqual(bare.log, []);
  assert.equal(bare.activePlugins, null);
  assert.equal(bare.datasetMeta, null);
  assert.equal(bare.collabId, null);
});
