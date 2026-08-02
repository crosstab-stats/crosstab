/**
 * Headless tests for conflict RESOLUTION — the property the conflict UI relies on:
 * a merge is a pure function of the user's choices, so feeding a surfaced conflict's
 * `key` back as a resolution re-runs deterministically to a clean, correctly-chosen
 * result (0 remaining conflicts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threeWayLog, mergeProject } from '../core/merge.js';
import { mergeManifests, buildMergers } from '../core/collab-sync.js';
import { mergeState as caqdasMerge } from '../plugins/builtin-caqdas/index.js';

const recode = (id, name, rules) => ({ id, type: 'recodeVar', name, rules });

test('every surfaced conflict carries a stable key', () => {
  const ancestor = [recode('r1', 'income', 'orig')];
  const r = threeWayLog(ancestor, [recode('r1', 'income', 'A')], [recode('r1', 'income', 'B')]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(typeof r.conflicts[0].key, 'string');
  // Re-running gives the SAME key (deterministic) — resolutions stay valid.
  const again = threeWayLog(ancestor, [recode('r1', 'income', 'A')], [recode('r1', 'income', 'B')]);
  assert.equal(again.conflicts[0].key, r.conflicts[0].key);
});

test('threeWayLog edit/edit: resolving "theirs" re-runs clean with their op', () => {
  const ancestor = [recode('r1', 'income', 'orig')];
  const mine = [recode('r1', 'income', 'A')];
  const theirs = [recode('r1', 'income', 'B')];
  const first = threeWayLog(ancestor, mine, theirs);
  const key = first.conflicts[0].key;
  const resolved = threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'theirs' } });
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(resolved.resolved.find((o) => o.id === 'r1').rules, 'B');
  // "mine" keeps my version.
  const mineWins = threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'mine' } });
  assert.equal(mineWins.resolved.find((o) => o.id === 'r1').rules, 'A');
});

test('threeWayLog add/add (same target, different ops): mine/theirs/both all resolve', () => {
  const ancestor = [{ id: 'load1', type: 'load', src: { label: 'x', meta: [] } }];
  const mine = [...ancestor, recode('m1', 'income', 'A')];
  const theirs = [...ancestor, recode('t1', 'income', 'B')];
  const first = threeWayLog(ancestor, mine, theirs);
  const key = first.conflicts[0].key;
  const ids = (res) => res.resolved.map((o) => o.id).filter((x) => x !== 'load1').sort();
  assert.deepEqual(ids(threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'mine' } })), ['m1']);
  assert.deepEqual(ids(threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'theirs' } })), ['t1']);
  assert.deepEqual(ids(threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'both' } })), ['m1', 't1']);
  assert.equal(threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'both' } }).conflicts.length, 0);
});

test('mergeManifests: resolving a dataset conflict re-runs clean (keys survive the coordinator)', () => {
  const ds = (txs) => ({ id: 1, name: 'ds1', libraryLink: null, sources: [{ id: 's1', meta: [{ name: 'x' }], label: 'f', combine: 'base', file: 's1.parquet' }], transforms: txs, order: ['s', ...txs.map(() => 't')] });
  const M = (txs) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, workspaces: null, output: null, datasets: [ds(txs)] });
  const base = M([]);
  const mine = M([recode('m1', 'income', 'A')]);
  const theirs = M([recode('t1', 'income', 'B')]);
  const first = mergeManifests(base, mine, theirs, buildMergers([]));
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].dataset, 1);
  const key = first.conflicts[0].key;
  const resolved = mergeManifests(base, mine, theirs, buildMergers([]), { [key]: 'theirs' });
  assert.equal(resolved.conflicts.length, 0);
  assert.deepEqual(resolved.manifest.datasets[0].transforms.map((t) => t.id), ['t1']);
});

test('resolution reaches inside a plugin custom merger (CAQDAS) with no plugin change', () => {
  const plugins = [{ id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } }];
  const cb = (color) => ({ version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anx', color }], segments: [] });
  const leaf = (color) => ({ __wsv: 4, ws: { 'builtin-caqdas': { 'caqdas-coding': { _default: { 1: cb(color) } } } } });
  const M = (color) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: ['builtin-caqdas'], workspaces: leaf(color), output: null, datasets: [] });
  const base = M('#000');
  const mine = M('#f00');
  const theirs = M('#0f0');
  const first = mergeManifests(base, mine, theirs, buildMergers(plugins));
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].owner, 'builtin-caqdas');
  const key = first.conflicts[0].key;
  const resolved = mergeManifests(base, mine, theirs, buildMergers(plugins), { [key]: 'theirs' });
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(resolved.manifest.workspaces.ws['builtin-caqdas']['caqdas-coding']._default[1].codes[0].color, '#0f0');
});

test('mergeProject: resolutions apply across log + blob tiers at once', () => {
  const load = { id: 'load1', type: 'load', src: { label: 'x', meta: [] } };
  const ancestor = { log: [load], blobs: { p: { owner: 'p', value: 'V0' } } };
  const mine = { log: [load, recode('m1', 'age', 'A')], blobs: { p: { owner: 'p', value: 'V1' } } };
  const theirs = { log: [load, recode('m1', 'age', 'B')], blobs: { p: { owner: 'p', value: 'V2' } } };
  const mergers = { core: { strategy: 'three-way' }, p: { strategy: 'lww' } };
  const first = mergeProject({ ancestor, mine, theirs, mergers });
  assert.equal(first.conflicts.length, 2); // one log edit/edit, one blob lww
  const res = Object.fromEntries(first.conflicts.map((c) => [c.key, c.owner === 'p' ? 'mine' : 'theirs']));
  const clean = mergeProject({ ancestor, mine, theirs, mergers, resolutions: res });
  assert.equal(clean.conflicts.length, 0);
  assert.equal(clean.log.find((o) => o.id === 'm1').rules, 'B'); // core → theirs
  assert.equal(clean.blobs.p.value, 'V1'); // blob → mine
});
