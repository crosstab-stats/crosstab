/**
 * Headless tests for the collaboration merge kernel (core/merge.js).
 * Run: `npm test` (Node's built-in runner; no dependencies).
 *
 * These prove the load-bearing piece of #143 with zero infrastructure — the same
 * merge that folder-sync runs on two files and live-sync runs continuously.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stableStringify,
  deterministicOpId,
  opContentSig,
  threeWayLog,
  addWinsSet,
  lww,
  mergeProject,
} from '../core/merge.js';

// --- op identity -----------------------------------------------------------

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('deterministicOpId is identical on every machine for the same content+index', () => {
  const op = { type: 'recodeVar', name: 'income', rules: [{ from: -99, to: null }] };
  // Same op, same index → same id, regardless of key insertion order.
  const reordered = { rules: [{ to: null, from: -99 }], name: 'income', type: 'recodeVar' };
  assert.equal(deterministicOpId(op, 3), deterministicOpId(reordered, 3));
  // Index participates: the same op at a different position is a different op.
  assert.notEqual(deterministicOpId(op, 3), deterministicOpId(op, 4));
});

test('opContentSig ignores id and src (assigned/live, not authored)', () => {
  const a = { id: 'op-aaa', type: 'setVariable', name: 'x', patch: { label: 'X' } };
  const b = { id: 'op-zzz', type: 'setVariable', name: 'x', patch: { label: 'X' } };
  assert.equal(opContentSig(a), opContentSig(b));
});

// --- threeWayLog (core tabular state class) --------------------------------

const recode = (id, name, extra = {}) => ({ id, type: 'recodeVar', name, ...extra });

test('threeWayLog: disjoint additions auto-merge with no conflict', () => {
  const ancestor = [{ id: 'load1', type: 'load', src: { label: 'gss', meta: [] } }];
  const mine = [...ancestor, recode('m1', 'income')];
  const theirs = [...ancestor, recode('t1', 'education')];
  const r = threeWayLog(ancestor, mine, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.resolved.map((o) => o.id), ['load1', 'm1', 't1']);
});

test('threeWayLog: both independently recode the SAME variable → add/add conflict', () => {
  const ancestor = [{ id: 'load1', type: 'load', src: { label: 'gss', meta: [] } }];
  const mine = [...ancestor, recode('m1', 'income', { rules: 'A' })];
  const theirs = [...ancestor, recode('t1', 'income', { rules: 'B' })];
  const r = threeWayLog(ancestor, mine, theirs);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kind, 'add/add');
  assert.equal(r.conflicts[0].target, 'var:income');
});

test('threeWayLog: one-side edit of an ancestor op is taken; convergent edits do not conflict', () => {
  const ancestor = [recode('r1', 'income', { rules: 'orig' })];
  const mineEdited = [recode('r1', 'income', { rules: 'new' })];
  const theirsSame = [recode('r1', 'income', { rules: 'orig' })];
  const r = threeWayLog(ancestor, mineEdited, theirsSame);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.resolved[0].rules, 'new');

  // Both edit to the SAME new content → converge, no conflict.
  const bothSame = threeWayLog(ancestor, mineEdited, [recode('r1', 'income', { rules: 'new' })]);
  assert.equal(bothSame.conflicts.length, 0);
  assert.equal(bothSame.resolved[0].rules, 'new');
});

test('threeWayLog: both edit the same ancestor op differently → edit/edit conflict', () => {
  const ancestor = [recode('r1', 'income', { rules: 'orig' })];
  const r = threeWayLog(ancestor, [recode('r1', 'income', { rules: 'A' })], [recode('r1', 'income', { rules: 'B' })]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kind, 'edit/edit');
});

test('threeWayLog: edit-vs-delete surfaces; delete-vs-delete removes cleanly', () => {
  const ancestor = [recode('r1', 'income', { rules: 'orig' }), recode('r2', 'age')];
  // mine deletes r1, theirs edits it → conflict.
  const editDelete = threeWayLog(ancestor, [recode('r2', 'age')], [recode('r1', 'income', { rules: 'edited' }), recode('r2', 'age')]);
  assert.equal(editDelete.conflicts.length, 1);
  assert.equal(editDelete.conflicts[0].kind, 'edit/delete');
  // both delete r1 → gone, no conflict.
  const bothDelete = threeWayLog(ancestor, [recode('r2', 'age')], [recode('r2', 'age')]);
  assert.equal(bothDelete.conflicts.length, 0);
  assert.deepEqual(bothDelete.resolved.map((o) => o.id), ['r2']);
});

// --- addWinsSet (CAQDAS codebook) ------------------------------------------

const code = (id, label, color = '#000') => ({ id, label, color });

test('addWinsSet: concurrent additions union; add wins over a concurrent delete', () => {
  const ancestor = [code('c1', 'anxiety')];
  const mine = [code('c1', 'anxiety'), code('c2', 'coping')]; // added c2
  const theirs = []; // deleted c1
  const r = addWinsSet(ancestor, mine, theirs, (x) => x.id, 'builtin-caqdas');
  const ids = r.resolved.map((x) => x.id).sort();
  assert.deepEqual(ids, ['c1', 'c2']); // c1 survives (add-wins), c2 added
  assert.equal(r.conflicts.length, 0);
});

test('addWinsSet: same code edited differently on both sides → conflict; one-side edit is clean', () => {
  const ancestor = [code('c1', 'anxiety', '#000')];
  const both = addWinsSet(ancestor, [code('c1', 'anxiety', '#f00')], [code('c1', 'anxiety', '#0f0')], (x) => x.id);
  assert.equal(both.conflicts.length, 1);
  const oneSide = addWinsSet(ancestor, [code('c1', 'anxiety', '#f00')], [code('c1', 'anxiety', '#000')], (x) => x.id);
  assert.equal(oneSide.conflicts.length, 0);
  assert.equal(oneSide.resolved[0].color, '#f00');
});

// --- lww (spatial boundary slot bytes) -------------------------------------

test('lww: later clock wins; one-side change is clean; concurrent no-clock changes conflict', () => {
  assert.equal(lww('a', { value: 'b', clock: 2 }, { value: 'c', clock: 1 }).resolved, 'b');
  assert.equal(lww('a', { value: 'b' }, { value: 'a' }).resolved, 'b'); // only mine changed
  assert.equal(lww('a', { value: 'b' }, { value: 'c' }).conflicts.length, 1); // both changed, no clock
});

// --- mergeProject: two structurally-different mergers in one merge ----------

test('mergeProject dispatches per owner and aggregates conflicts across tiers', () => {
  const base = { id: 'load1', type: 'load', src: { label: 'gss', meta: [] } };
  const ancestor = {
    log: [base],
    blobs: {
      'builtin-caqdas': { owner: 'builtin-caqdas', value: [code('c1', 'anxiety')] },
      'builtin-spatial::counties': { owner: 'builtin-spatial', value: 'GEOJSON_V1' },
    },
  };
  const mine = {
    log: [base, recode('m1', 'income')], // disjoint add
    blobs: {
      'builtin-caqdas': { owner: 'builtin-caqdas', value: [code('c1', 'anxiety'), code('c2', 'coping')] }, // add code
      'builtin-spatial::counties': { owner: 'builtin-spatial', value: 'GEOJSON_V1b' }, // I re-shaded the bytes...
    },
  };
  const theirs = {
    log: [base, recode('t1', 'education')], // disjoint add
    blobs: {
      'builtin-caqdas': { owner: 'builtin-caqdas', value: [code('c1', 'anxiety'), code('c3', 'stigma')] }, // add different code
      'builtin-spatial::counties': { owner: 'builtin-spatial', value: 'GEOJSON_V2' }, // ...they changed the SAME bytes differently, no clock → conflict
    },
  };
  const mergers = {
    core: { strategy: 'three-way' },
    'builtin-caqdas': { strategy: 'add-wins', keyFn: (x) => x.id },
    'builtin-spatial': { strategy: 'lww' },
  };
  const r = mergeProject({ ancestor, mine, theirs, mergers });

  // Core log: both recodes auto-merged (disjoint variables).
  assert.deepEqual(r.log.map((o) => o.id), ['load1', 'm1', 't1']);
  // CAQDAS codebook: all three codes unioned, no conflict.
  assert.deepEqual(r.blobs['builtin-caqdas'].value.map((c) => c.id).sort(), ['c1', 'c2', 'c3']);
  // Spatial: concurrent byte change with no clock → exactly one surfaced conflict.
  const spatialConflicts = r.conflicts.filter((c) => c.owner === 'builtin-spatial');
  assert.equal(spatialConflicts.length, 1);
  // Only the spatial tier conflicts; the other two merged cleanly.
  assert.equal(r.conflicts.length, 1);
});

test('mergeProject: a plugin custom merge() function is envelope-wrapped and tagged with owner', () => {
  const ancestor = { log: [], blobs: { 'x-plugin': { owner: 'x-plugin', value: { n: 0 } } } };
  const mine = { log: [], blobs: { 'x-plugin': { owner: 'x-plugin', value: { n: 1 } } } };
  const theirs = { log: [], blobs: { 'x-plugin': { owner: 'x-plugin', value: { n: 2 } } } };
  const mergers = {
    'x-plugin': {
      // Custom semantics: sum the deltas from the ancestor (a toy CRDT counter).
      merge: ({ ancestor: a, mine: m, theirs: t }) => ({ resolved: { n: a.n + (m.n - a.n) + (t.n - a.n) }, conflicts: [] }),
    },
  };
  const r = mergeProject({ ancestor, mine, theirs, mergers });
  assert.equal(r.blobs['x-plugin'].value.n, 3); // 0 + 1 + 2
  assert.equal(r.conflicts.length, 0);
});
