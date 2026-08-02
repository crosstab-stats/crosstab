/**
 * Headless tests for the project-level three-way merge (core/collab-sync.js) — the
 * folder transport's brain. This is what folder-sync runs when it detects two
 * divergent `project.json` files sharing a common ancestor. No FS, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  datasetToOps,
  opsToDataset,
  flattenWorkspaces,
  unflattenWorkspaces,
  buildMergers,
  mergeManifests,
} from '../core/collab-sync.js';
import { mergeState as caqdasMerge } from '../plugins/builtin-caqdas/index.js';

// --- fixtures --------------------------------------------------------------

const source = (id, label, names) => ({ id, meta: names.map((n) => ({ name: n })), label, combine: 'base', file: `${id}.parquet` });
const recode = (id, name, rules) => ({ id, type: 'recodeVar', name, rules });

/** A minimal one-dataset project manifest. */
function manifest({ name = 'P', datasets, workspaces = null, activePlugins = null }) {
  return { name, savedAt: 1, activeId: datasets[0].id, activePlugins, workspaces, output: null, datasets };
}
const ds = (id, sources, transforms) => ({
  id, name: `ds${id}`, libraryLink: null,
  sources, transforms,
  order: [...sources.map(() => 's'), ...transforms.map(() => 't')],
});

const wsBundle = (ws, labels) => ({ __wsv: 4, ws, ...(labels ? { labels } : {}) });

// --- manifest ⇄ ops --------------------------------------------------------

test('datasetToOps / opsToDataset round-trips with ids and order preserved', () => {
  const d = ds(1, [source('s1', 'gss', ['age', 'income'])], [recode('r1', 'income', 'A'), recode('r2', 'age', 'B')]);
  const ops = datasetToOps(d);
  assert.deepEqual(ops.map((o) => o.id), ['s1', 'r1', 'r2']);
  assert.equal(ops[0].type, 'load');
  const back = opsToDataset(ops);
  assert.deepEqual(back.order, ['s', 't', 't']);
  assert.deepEqual(back.sources.map((s) => s.id), ['s1']);
  assert.deepEqual(back.transforms.map((t) => t.id), ['r1', 'r2']);
  assert.equal(back.sources[0].combine, 'base');
});

test('datasetToOps assigns DETERMINISTIC ids to a legacy (id-less) manifest', () => {
  const legacy = { sources: [{ meta: [{ name: 'x' }], label: 'f', combine: 'base', file: 'a.parquet' }], transforms: [{ type: 'recodeVar', name: 'x', rules: 'A' }], order: ['s', 't'] };
  const a = datasetToOps(legacy).map((o) => o.id);
  const b = datasetToOps(legacy).map((o) => o.id); // same input on "another machine"
  assert.deepEqual(a, b); // identical → pre-collab project stays mergeable
  assert.ok(a.every((id) => id.startsWith('op-')));
});

// --- workspaces flatten/unflatten ------------------------------------------

test('flattenWorkspaces / unflattenWorkspaces round-trip', () => {
  const bundle = wsBundle({
    'builtin-caqdas': { 'caqdas-coding': { _default: { 1: { codes: [], segments: [] } } } },
    'builtin-spatial': { 'spatial-map': { counties: { NO_DS: 'FC1' }, tracts: { NO_DS: 'FC2' } } },
  }, { some: 'label' });
  const flat = flattenWorkspaces(bundle);
  assert.equal(Object.keys(flat).length, 3); // 1 caqdas leaf + 2 spatial slots
  const round = unflattenWorkspaces(flat, bundle.labels);
  assert.deepEqual(round, bundle);
});

// --- buildMergers ----------------------------------------------------------

test('buildMergers resolves strategy and via→exported-fn from loaded plugins', () => {
  const plugins = [
    { id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } },
    { id: 'builtin-spatial', manifest: { workspaces: [{ id: 'spatial-map', merge: { strategy: 'lww' } }, { id: 'spatial-link', merge: { strategy: 'lww' } }] } },
    { id: 'no-merge', manifest: { workspaces: [{ id: 'w' }] } },
  ];
  const m = buildMergers(plugins);
  assert.deepEqual(m.core, { strategy: 'three-way' });
  assert.equal(typeof m['builtin-caqdas'].merge, 'function');
  assert.deepEqual(m['builtin-spatial'], { strategy: 'lww' });
  assert.equal(m['no-merge'], undefined); // no declaration → kernel default at merge time
});

// --- mergeManifests: the folder-sync merge ---------------------------------

test('mergeManifests: disjoint recodes on the same dataset auto-merge', () => {
  const base = manifest({ datasets: [ds(1, [source('s1', 'gss', ['age', 'income'])], [])] });
  const mine = manifest({ datasets: [ds(1, [source('s1', 'gss', ['age', 'income'])], [recode('m1', 'income', 'A')])] });
  const theirs = manifest({ datasets: [ds(1, [source('s1', 'gss', ['age', 'income'])], [recode('t1', 'age', 'B')])] });
  const { manifest: out, conflicts } = mergeManifests(base, mine, theirs, buildMergers([]));
  assert.equal(conflicts.length, 0);
  assert.deepEqual(out.datasets[0].transforms.map((t) => t.id), ['m1', 't1']);
});

test('mergeManifests: both recode the same variable differently → conflict tagged with dataset', () => {
  const base = manifest({ datasets: [ds(1, [source('s1', 'gss', ['income'])], [])] });
  const mine = manifest({ datasets: [ds(1, [source('s1', 'gss', ['income'])], [recode('m1', 'income', 'A')])] });
  const theirs = manifest({ datasets: [ds(1, [source('s1', 'gss', ['income'])], [recode('t1', 'income', 'B')])] });
  const { conflicts } = mergeManifests(base, mine, theirs, buildMergers([]));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'add/add');
  assert.equal(conflicts[0].dataset, 1);
});

test('mergeManifests: a dataset added on one side is kept (add-wins, never drop data)', () => {
  const base = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])] });
  const mine = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], []), ds(2, [source('s2', 'b', ['y'])], [])] });
  const theirs = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])] });
  const { manifest: out, conflicts } = mergeManifests(base, mine, theirs, buildMergers([]));
  assert.equal(conflicts.length, 0);
  assert.deepEqual(out.datasets.map((d) => d.id).sort(), [1, 2]);
});

test('mergeManifests: a dataset deleted on one side (unchanged on the other) is dropped', () => {
  // base has both; mine deleted ds2; theirs still holds an untouched ds2 → delete wins
  // (previously it resurrected from theirs — the reported live co-authoring bug).
  const both = [ds(1, [source('s1', 'a', ['x'])], []), ds(2, [source('s2', 'b', ['y'])], [])];
  const base = manifest({ datasets: both });
  const mine = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])] });
  const theirs = manifest({ datasets: both });
  const { manifest: out, conflicts } = mergeManifests(base, mine, theirs, buildMergers([]));
  assert.equal(conflicts.length, 0);
  assert.deepEqual(out.datasets.map((d) => d.id), [1]); // ds2 stays deleted on both peers
});

test('mergeManifests: delete is symmetric regardless of which slot deleted it', () => {
  const both = [ds(1, [source('s1', 'a', ['x'])], []), ds(2, [source('s2', 'b', ['y'])], [])];
  const base = manifest({ datasets: both });
  // theirs deleted ds2 this time (the deleter is in the "theirs" slot).
  const out = mergeManifests(base, manifest({ datasets: both }), manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])] }), buildMergers([])).manifest;
  assert.deepEqual(out.datasets.map((d) => d.id), [1]);
});

test('mergeManifests: delete loses to a concurrent edit (no silent data loss)', () => {
  // mine deletes ds2; theirs recoded a var in ds2 → keep it rather than lose the edit.
  const base = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], []), ds(2, [source('s2', 'b', ['y'])], [])] });
  const mine = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])] });
  const theirs = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], []), ds(2, [source('s2', 'b', ['y'])], [recode('r1', 'y', 'A')])] });
  const out = mergeManifests(base, mine, theirs, buildMergers([])).manifest;
  const ds2 = out.datasets.find((d) => d.id === 2);
  assert.ok(ds2, 'edited dataset survives the concurrent delete');
  assert.deepEqual(ds2.transforms.map((t) => t.id), ['r1']); // the edit is preserved
});

test('mergeManifests: CAQDAS codebooks from two coders union (Dedoose case, via buildMergers)', () => {
  const plugins = [{ id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } }];
  const cb = (codes) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments: [] });
  const leaf = (codes) => ({ 'builtin-caqdas': { 'caqdas-coding': { _default: { 1: cb(codes) } } } });
  const base = manifest({ datasets: [ds(1, [source('s1', 'i', ['x'])], [])], workspaces: wsBundle(leaf([{ id: 'c1', name: 'anx' }])) });
  const mine = manifest({ datasets: [ds(1, [source('s1', 'i', ['x'])], [])], workspaces: wsBundle(leaf([{ id: 'c1', name: 'anx' }, { id: 'c2', name: 'coping' }])) });
  const theirs = manifest({ datasets: [ds(1, [source('s1', 'i', ['x'])], [])], workspaces: wsBundle(leaf([{ id: 'c1', name: 'anx' }, { id: 'c3', name: 'stigma' }])) });
  const { manifest: out, conflicts } = mergeManifests(base, mine, theirs, buildMergers(plugins));
  assert.equal(conflicts.length, 0);
  const merged = out.workspaces.ws['builtin-caqdas']['caqdas-coding']._default[1];
  assert.deepEqual(merged.codes.map((c) => c.id).sort(), ['c1', 'c2', 'c3']);
});

test('mergeManifests: spatial slots add-wins across sides; concurrent byte change conflicts (LWW no clock)', () => {
  const plugins = [{ id: 'builtin-spatial', manifest: { workspaces: [{ id: 'spatial-map', merge: { strategy: 'lww' } }] } }];
  const slots = (obj) => wsBundle({ 'builtin-spatial': { 'spatial-map': obj } });
  const base = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])], workspaces: slots({ counties: { NO_DS: 'V1' } }) });
  // mine adds tracts; theirs changes counties bytes.
  const mine = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])], workspaces: slots({ counties: { NO_DS: 'V1' }, tracts: { NO_DS: 'T1' } }) });
  const theirs = manifest({ datasets: [ds(1, [source('s1', 'a', ['x'])], [])], workspaces: slots({ counties: { NO_DS: 'V2' } }) });
  const { manifest: out, conflicts } = mergeManifests(base, mine, theirs, buildMergers(plugins));
  const spatial = out.workspaces.ws['builtin-spatial']['spatial-map'];
  assert.deepEqual(Object.keys(spatial).sort(), ['counties', 'tracts']); // add-wins slot set
  assert.equal(spatial.counties.NO_DS, 'V2'); // one-side byte change taken cleanly
  assert.equal(conflicts.length, 0);
});
