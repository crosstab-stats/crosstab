/**
 * Headless tests for conflict RESOLUTION — the property the conflict UI relies on:
 * a merge is a pure function of the user's choices, so feeding a surfaced conflict's
 * `key` back as a resolution re-runs deterministically to a clean, correctly-chosen
 * result (0 remaining conflicts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threeWayLog, mergeProject } from '../core/merge.js';
import { mergeProjects, buildMergers } from '../core/collab-sync.js';
import { mergeState as caqdasMerge } from '../plugins/builtin-caqdas/index.js';

const recode = (id, name, rules) => ({ id, type: 'recodeVar', name, rules });
const NUL = String.fromCharCode(0);
const lop = (id, target, type, payload, owner = 'core', wall = 1) => ({ id, hlc: { wall, counter: 0 }, target, owner, type, payload, reads: [] });

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

test('mergeProjects: resolving a dataset conflict re-runs clean (keys survive the coordinator)', () => {
  const shared = [lop('add1', 'coll/ds:1', 'addDataset', { id: 1, name: 'ds1' }), lop('load1', 'ds:1/source:s1', 'load', { src: { meta: [{ name: 'x' }] } })];
  const M = (op) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: null, output: null, datasetMeta: null, collabId: null, log: [...shared, op] });
  const mine = M(lop('m1', 'ds:1/var:income', 'recodeVar', { name: 'income', rules: 'A' }));
  const theirs = M(lop('t1', 'ds:1/var:income', 'recodeVar', { name: 'income', rules: 'B' }));
  const first = mergeProjects(mine, theirs, buildMergers([]));
  assert.ok(first.conflicts.length >= 1);
  const key = first.conflicts[0].key;
  const resolved = mergeProjects(mine, theirs, buildMergers([]), { [key]: 'theirs' });
  assert.equal(resolved.conflicts.length, 0);
  assert.ok(resolved.manifest.log.some((o) => o.id === 't1'));
});

test('resolution reaches inside a plugin custom merger (CAQDAS) with no plugin change', () => {
  const plugins = [{ id: 'builtin-caqdas', manifest: { workspaces: [{ id: 'caqdas-coding', merge: { via: 'mergeState' } }] }, module: { mergeState: caqdasMerge } }];
  const leaf = `ws:builtin-caqdas${NUL}caqdas-coding${NUL}_default${NUL}1`;
  const cb = (color) => ({ version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anx', color }], segments: [] });
  const wsOp = (id, color, wall) => lop(id, leaf, 'setWorkspace', { value: cb(color), label: null }, 'builtin-caqdas', wall);
  const shared = wsOp('wbase', '#000', 1);
  const M = (op) => ({ name: 'P', savedAt: 1, activeId: 1, activePlugins: ['builtin-caqdas'], output: null, datasetMeta: null, collabId: null, log: [shared, op] });
  const mine = M(wsOp('wm', '#f00', 3));
  const theirs = M(wsOp('wt', '#0f0', 3));
  const first = mergeProjects(mine, theirs, buildMergers(plugins));
  assert.ok(first.conflicts.length >= 1);
  assert.equal(first.conflicts[0].owner, 'builtin-caqdas');
  const key = first.conflicts[0].key;
  const resolved = mergeProjects(mine, theirs, buildMergers(plugins), { [key]: 'theirs' });
  assert.equal(resolved.conflicts.length, 0);
  const merged = resolved.manifest.log.filter((o) => o.target === leaf).sort((a, b) => (a.hlc.wall - b.hlc.wall) || (a.hlc.counter - b.hlc.counter)).slice(-1)[0];
  assert.equal(merged.payload.value.codes[0].color, '#0f0');
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
