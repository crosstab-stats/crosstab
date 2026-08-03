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
import { mergeState as caqdasMerge } from '../plugins/builtin-caqdas/index.js';

/** The helper bundle the host hands a plugin's custom merge() (see resolveMerger). */
const HELPERS = { threeWayLog, addWinsSet, lww, stableStringify };

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

test('threeWayLog: a sequential edit to a variable a peer already ADOPTED does not conflict (live revert bug #148)', () => {
  // Live scenario: peer B adopted peer A's first edit (op a) to gender; peer A then made
  // a SECOND edit (op b) to gender. mine (A) = [a, b]; theirs (B) = [a]. op a is common
  // (same id on both) → not an independent addition, so b must NOT collide with it.
  const ancestor = [{ id: 'load1', type: 'load', src: { label: 'gss', meta: [] } }];
  const a = { id: 'a', type: 'setVariable', name: 'gender', patch: { measurementLevel: 'scale' } };
  const b = { id: 'b', type: 'setVariable', name: 'gender', patch: { measurementLevel: 'nominal' } };
  const r = threeWayLog(ancestor, [...ancestor, a, b], [...ancestor, a]);
  assert.equal(r.conflicts.length, 0, 'no phantom add/add — a is shared, b is a clean sequential add');
  assert.deepEqual(r.resolved.map((o) => o.id), ['load1', 'a', 'b']);
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

test('threeWayLog: one side REORDERS steps → the reorder is kept (order is editable)', () => {
  const ancestor = [recode('o1', 'a'), recode('o2', 'b'), recode('o3', 'c')];
  const mine = [recode('o2', 'b'), recode('o1', 'a'), recode('o3', 'c')]; // swapped o1/o2
  const theirs = [recode('o1', 'a'), recode('o2', 'b'), recode('o3', 'c')]; // unchanged
  const r = threeWayLog(ancestor, mine, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.resolved.map((o) => o.id), ['o2', 'o1', 'o3']); // mine's reorder wins
  // Symmetric: the reorder on the *theirs* side is equally kept (convergence).
  const r2 = threeWayLog(ancestor, theirs, mine);
  assert.deepEqual(r2.resolved.map((o) => o.id), ['o2', 'o1', 'o3']);
});

test('threeWayLog: both reorder differently → order conflict, resolvable', () => {
  const ancestor = [recode('o1', 'a'), recode('o2', 'b'), recode('o3', 'c')];
  const mine = [recode('o2', 'b'), recode('o1', 'a'), recode('o3', 'c')];   // swap o1/o2
  const theirs = [recode('o1', 'a'), recode('o3', 'c'), recode('o2', 'b')]; // swap o2/o3
  const first = threeWayLog(ancestor, mine, theirs);
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].kind, 'order');
  const key = first.conflicts[0].key;
  const mineWins = threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'mine' } });
  assert.equal(mineWins.conflicts.length, 0);
  assert.deepEqual(mineWins.resolved.map((o) => o.id), ['o2', 'o1', 'o3']);
  const theirsWins = threeWayLog(ancestor, mine, theirs, 'core', { resolutions: { [key]: 'theirs' } });
  assert.deepEqual(theirsWins.resolved.map((o) => o.id), ['o1', 'o3', 'o2']);
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

// --- REAL builtin mergers against real state shapes ------------------------

const seg = (doc, codeId, start, end, text) => ({ doc, codeId, start, end, text });

test('CAQDAS: two coders on the same transcripts merge cleanly (the Dedoose case)', () => {
  // Ancestor: one code, one coded passage.
  const ancestor = {
    version: 1, textColumn: 'transcript', labelColumn: null,
    codes: [{ id: 'c1', name: 'anxiety', color: '#ffd166', group: '', memo: '' }],
    segments: [seg('r1', 'c1', 0, 10, 'I felt so')],
  };
  // Coder A: adds a code and codes a new passage under the existing code.
  const mine = {
    ...ancestor,
    codes: [...ancestor.codes, { id: 'c2', name: 'coping', color: '#8ecae6', group: '', memo: '' }],
    segments: [...ancestor.segments, seg('r2', 'c1', 5, 20, 'worried about')],
  };
  // Coder B: adds a different code and codes a different passage.
  const theirs = {
    ...ancestor,
    codes: [...ancestor.codes, { id: 'c3', name: 'stigma', color: '#a7c957', group: '', memo: '' }],
    segments: [...ancestor.segments, seg('r3', 'c1', 0, 8, 'people judge')],
  };
  const r = caqdasMerge({ ancestor, mine, theirs, helpers: HELPERS });
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.resolved.codes.map((c) => c.id).sort(), ['c1', 'c2', 'c3']);
  assert.equal(r.resolved.segments.length, 3); // ancestor's + one from each coder
});

test('CAQDAS: coding the SAME passage under the same code converges (no duplicate)', () => {
  const ancestor = { version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'x' }], segments: [] };
  const same = seg('r1', 'c1', 3, 9, 'the same');
  const r = caqdasMerge({ ancestor, mine: { ...ancestor, segments: [same] }, theirs: { ...ancestor, segments: [{ ...same }] }, helpers: HELPERS });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.resolved.segments.length, 1); // converged, not duplicated
});

test('CAQDAS: same code recoloured two ways surfaces an edit/edit conflict', () => {
  const ancestor = { version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anxiety', color: '#000' }], segments: [] };
  const r = caqdasMerge({
    ancestor,
    mine: { ...ancestor, codes: [{ id: 'c1', name: 'anxiety', color: '#f00' }] },
    theirs: { ...ancestor, codes: [{ id: 'c1', name: 'anxiety', color: '#0f0' }] },
    helpers: HELPERS,
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].owner, 'builtin-caqdas');
});

test('CAQDAS: renaming a code loses to a keep? no — add-wins keeps a one-side edit', () => {
  // One coder renames c1; the other leaves it. The rename is taken, no conflict.
  const ancestor = { version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anx' }], segments: [] };
  const r = caqdasMerge({ ancestor, mine: { ...ancestor, codes: [{ id: 'c1', name: 'anxiety' }] }, theirs: ancestor, helpers: HELPERS });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.resolved.codes[0].name, 'anxiety');
});

test('spatial: add-wins slots + LWW bytes via mergeProject (real per-slot blob keys)', () => {
  // Each boundary set is its own blob key (owner tag → builtin-spatial → strategy lww).
  const slot = (name, ver) => ({ fileName: name, keyProp: 'GEOID', geojson: `FC:${name}:${ver}` });
  const ancestor = { log: [], blobs: {
    'builtin-spatial::counties': { owner: 'builtin-spatial', value: slot('counties', 1) },
  } };
  // Coder A re-shades counties (new bytes) and adds a NEW slot (tracts).
  const mine = { log: [], blobs: {
    'builtin-spatial::counties': { owner: 'builtin-spatial', value: slot('counties', 2) },
    'builtin-spatial::tracts': { owner: 'builtin-spatial', value: slot('tracts', 1) },
  } };
  // Coder B leaves counties, adds a different NEW slot (districts).
  const theirs = { log: [], blobs: {
    'builtin-spatial::counties': { owner: 'builtin-spatial', value: slot('counties', 1) },
    'builtin-spatial::districts': { owner: 'builtin-spatial', value: slot('districts', 1) },
  } };
  const r = mergeProject({ ancestor, mine, theirs, mergers: { 'builtin-spatial': { strategy: 'lww' } } });
  // All three slots present (add-wins on the slot set); counters's one-side byte change taken; no conflict.
  assert.deepEqual(Object.keys(r.blobs).sort(), ['builtin-spatial::counties', 'builtin-spatial::districts', 'builtin-spatial::tracts']);
  assert.equal(r.blobs['builtin-spatial::counties'].value.geojson, 'FC:counties:2');
  assert.equal(r.conflicts.length, 0);
});

test('full project merge: core log + CAQDAS custom merger resolved via manifest `via`', () => {
  // Simulate what the transport does: read manifest.merge.via → the module export.
  const mergers = {
    core: { strategy: 'three-way' },
    'builtin-caqdas': { merge: caqdasMerge }, // resolved from { via: 'mergeState' }
  };
  const base = { id: 'load1', type: 'load', src: { label: 'interviews', meta: [] } };
  const cb = (codes, segments) => ({ version: 1, textColumn: 't', labelColumn: null, codes, segments });
  const ancestor = { log: [base], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([{ id: 'c1', name: 'anx' }], []) } } };
  const mine = { log: [base, { id: 'm1', type: 'recodeVar', name: 'age' }], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([{ id: 'c1', name: 'anx' }, { id: 'c2', name: 'coping' }], []) } } };
  const theirs = { log: [base, { id: 't1', type: 'recodeVar', name: 'income' }], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([{ id: 'c1', name: 'anx' }, { id: 'c3', name: 'stigma' }], []) } } };
  const r = mergeProject({ ancestor, mine, theirs, mergers });
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.log.map((o) => o.id), ['load1', 'm1', 't1']); // disjoint recodes merged
  assert.deepEqual(r.blobs['builtin-caqdas'].value.codes.map((c) => c.id).sort(), ['c1', 'c2', 'c3']); // codebook unioned
});

test('CAQDAS merge: two coders coding the SAME passage stay DISTINCT (per-coder ids)', () => {
  // The whole point of authorship (#148): inter-coder reliability must see that BOTH
  // coders coded a passage, so identical-span codings with different ids do NOT collapse.
  const mergers = { core: { strategy: 'three-way' }, 'builtin-caqdas': { merge: caqdasMerge } };
  const cb = (segments) => ({ version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anx' }], segments });
  const seg = (id, who) => ({ id, doc: 'r1', codeId: 'c1', start: 10, end: 50, text: 'x', author: { authorId: who, initials: who.toUpperCase() } });
  const ancestor = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([]) } } };
  const mine = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([seg('s-jane', 'jane')]) } } };
  const theirs = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([seg('s-bob', 'bob')]) } } };
  const r = mergeProject({ ancestor, mine, theirs, mergers });
  const segs = r.blobs['builtin-caqdas'].value.segments;
  assert.equal(segs.length, 2, "both coders' identical-span codings survive");
  assert.deepEqual(segs.map((s) => s.author.initials).sort(), ['BOB', 'JANE']);
  assert.equal(r.conflicts.length, 0);
});

test('CAQDAS merge: legacy id-less identical codings still collapse (content-key fallback)', () => {
  const mergers = { core: { strategy: 'three-way' }, 'builtin-caqdas': { merge: caqdasMerge } };
  const cb = (segments) => ({ version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anx' }], segments });
  const legacy = { doc: 'r1', codeId: 'c1', start: 10, end: 50, text: 'x' }; // pre-#148, no id
  const ancestor = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([]) } } };
  const mine = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([{ ...legacy }]) } } };
  const theirs = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: cb([{ ...legacy }]) } } };
  const r = mergeProject({ ancestor, mine, theirs, mergers });
  assert.equal(r.blobs['builtin-caqdas'].value.segments.length, 1, 'id-less identical codings dedupe by content');
});

test('CAQDAS merge: two people annotating the SAME coding — both memos survive (office-hours case)', () => {
  // Memos are a separate add-wins collection anchored by id, so faculty + student can
  // both comment on the same coding without one clobbering the other (#148 step 3).
  const mergers = { core: { strategy: 'three-way' }, 'builtin-caqdas': { merge: caqdasMerge } };
  const blob = (memos) => ({ version: 1, textColumn: 't', labelColumn: null, codes: [{ id: 'c1', name: 'anx' }], segments: [{ id: 's1', doc: 'r1', codeId: 'c1', start: 10, end: 50, text: 'x' }], memos });
  const memo = (id, who) => ({ id, anchorKind: 'segment', anchorId: 's1', text: `note ${who}`, author: { authorId: who, initials: who.toUpperCase() }, createdAt: 1 });
  const ancestor = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: blob([]) } } };
  const mine = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: blob([memo('n-jane', 'jane')]) } } };
  const theirs = { log: [], blobs: { 'builtin-caqdas': { owner: 'builtin-caqdas', value: blob([memo('n-bob', 'bob')]) } } };
  const r = mergeProject({ ancestor, mine, theirs, mergers });
  const memos = r.blobs['builtin-caqdas'].value.memos;
  assert.equal(memos.length, 2, 'both annotations on the same coding survive');
  assert.deepEqual(memos.map((n) => n.author.initials).sort(), ['BOB', 'JANE']);
  assert.equal(r.conflicts.length, 0);
});

test('mergersFor assembles core + ACTIVE builtin mergers (3rd-party deferred to the bridge)', async () => {
  const { mergersFor } = await import('../core/builtin-mergers.js');
  assert.deepEqual(Object.keys(mergersFor([])), ['core']); // core-only when nothing active
  const m = mergersFor(['builtin-caqdas', 'builtin-spatial', 'some-3rd-party']);
  // Keyed by WORKSPACE id (what mergeProjects dispatches on), not plugin id.
  assert.equal(typeof m['caqdas-coding'].merge, 'function', 'CAQDAS coding merger wired');
  assert.deepEqual(m['spatial-map'], { strategy: 'lww' });
  assert.deepEqual(m['spatial-link'], { strategy: 'lww' });
  assert.ok(!('some-3rd-party' in m), '3rd-party blob not host-mergeable yet (needs the sandbox bridge)');
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

// --- #149 B5: converging structural intent is not a conflict ---------------------
// Two peers who both undo (or both retract) the SAME op have not disagreed: every
// resolution yields the same outcome, so surfacing a conflict is pure noise.
// NOTE: these use the real ENVELOPE shape (an explicit `target`). Flat recipe-shaped
// ops fall through opTarget to a unique `op:<id>`, so they never collide in the
// add/add pass and could not exercise this at all.

const env = (id, target, type, extra = {}) => ({ id, target, type, ...extra });

test('both peers undoing the same op is convergence, not a conflict (B5)', () => {
  const base = env('r1', 'ds:1/var:income', 'recodeVar', { name: 'income', rules: 'orig' });
  const r = threeWayLog(
    [base],
    [base, env('um', 'ds:1/var:income', 'undo', { payload: { opId: 'r1' } })],
    [base, env('ut', 'ds:1/var:income', 'undo', { payload: { opId: 'r1' } })],
  );
  assert.equal(r.conflicts.length, 0, 'identical intent must not surface a conflict');
  assert.deepEqual(r.resolved.map((o) => o.id).sort(), ['r1', 'um', 'ut']);
});

test('both peers retracting the same op is convergence too (B5)', () => {
  const base = env('c1', 'ds:1/var:bmi', 'computeVar', { name: 'bmi' });
  const r = threeWayLog(
    [base],
    [base, env('rm', 'ds:1/op:c1', 'retract', { payload: { opId: 'c1' } })],
    [base, env('rt', 'ds:1/op:c1', 'retract', { payload: { opId: 'c1' } })],
  );
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.resolved.map((o) => o.id).sort(), ['c1', 'rm', 'rt']);
});

test('B5 exemption is narrow: undoing DIFFERENT ops on one target still conflicts', () => {
  const a = env('a1', 'ds:1/var:income', 'recodeVar', { name: 'income', rules: 'A' });
  const b = env('b1', 'ds:1/var:income', 'recodeVar', { name: 'income', rules: 'B' });
  const r = threeWayLog(
    [a, b],
    [a, b, env('um', 'ds:1/var:income', 'undo', { payload: { opId: 'a1' } })],
    [a, b, env('ut', 'ds:1/var:income', 'undo', { payload: { opId: 'b1' } })], // a DIFFERENT op
  );
  assert.equal(r.conflicts.length, 1, 'undoing different ops is a real disagreement');
});

test('B5 exemption does not cover reorder — rival orderings still conflict', () => {
  const a = env('a1', 'ds:1/source:s1', 'load');
  const b = env('b1', 'ds:1/var:x', 'computeVar', { name: 'x' });
  const r = threeWayLog(
    [a, b],
    [a, b, env('rm', 'ds:1/order', 'reorder', { payload: { order: ['a1', 'b1'] } })],
    [a, b, env('rt', 'ds:1/order', 'reorder', { payload: { order: ['b1', 'a1'] } })],
  );
  assert.ok(r.conflicts.length >= 1, 'rival orderings must still surface');
});
