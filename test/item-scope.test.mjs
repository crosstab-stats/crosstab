/**
 * @file item-scope.test.mjs
 * Project-scoped item records are visible from every dataset. This is the assumption the
 * whole codebook design rests on, so it is worth pinning where it can be checked cheaply.
 *
 * A CAQDAS codebook is project-wide (a coding scheme spans the documents it is applied
 * to, and gets reused across studies) while its codings are per-dataset (they anchor to
 * `__ct_rid` row ids belonging to exactly one dataset). Both live in the same plugin, so
 * the two scopes have to coexist in one store — and a project-scoped record has to
 * survive a dataset switch without being filtered out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { ItemStore } = await import('../core/item-store.js');
const { ProjectLog } = await import('../core/project-log.js');
const { HLC } = await import('../core/hlc.js');

const OWNER = 'builtin';
const DS_A = 'ds-a';
const DS_B = 'ds-b';

/** A store over a real op log, matching the harness in item-store.test.mjs. */
function store() {
  let wall = 1000;
  const log = new ProjectLog({ hlc: new HLC({ now: () => wall++ }), author: () => ({ authorId: 'a', initials: 'A' }) });
  const s = new ItemStore({ log });
  s._log = log;
  return s;
}

const ids = (recs) => recs.map((r) => r.id).sort();

test('a null-dsId record is returned for EVERY dataset', () => {
  const s = store();
  s.put(OWNER, 'codebooks', 'b1', { name: 'Shared scheme' }, { scope: { wsId: 'w', dsId: null } });

  assert.deepEqual(ids(s.list(OWNER, 'codebooks', { dsId: DS_A })), ['b1']);
  assert.deepEqual(ids(s.list(OWNER, 'codebooks', { dsId: DS_B })), ['b1'],
    'the same codebook is visible from a different dataset');
});

test('a dataset-scoped record is invisible from another dataset', () => {
  const s = store();
  s.put(OWNER, 'segments', 's1', { doc: 'r1' }, { scope: { wsId: 'w', dsId: DS_A } });

  assert.deepEqual(ids(s.list(OWNER, 'segments', { dsId: DS_A })), ['s1']);
  assert.deepEqual(ids(s.list(OWNER, 'segments', { dsId: DS_B })), [],
    'a coding anchored to dataset A must not surface while coding dataset B');
});

test('the two scopes coexist in one store without leaking into each other', () => {
  // The actual CAQDAS shape: project-wide codes, per-dataset codings.
  const s = store();
  s.put(OWNER, 'codes', 'c1', { name: 'Trust' }, { scope: { wsId: 'w', dsId: null } });
  s.put(OWNER, 'segments', 'sA', { doc: 'rA', codeId: 'c1' }, { scope: { wsId: 'w', dsId: DS_A } });
  s.put(OWNER, 'segments', 'sB', { doc: 'rB', codeId: 'c1' }, { scope: { wsId: 'w', dsId: DS_B } });

  // One codebook, two datasets coded against it, each seeing only its own codings.
  for (const ds of [DS_A, DS_B]) {
    assert.deepEqual(ids(s.list(OWNER, 'codes', { dsId: ds })), ['c1'], `codes visible from ${ds}`);
  }
  assert.deepEqual(ids(s.list(OWNER, 'segments', { dsId: DS_A })), ['sA']);
  assert.deepEqual(ids(s.list(OWNER, 'segments', { dsId: DS_B })), ['sB']);
});

test('listing with no dsId returns everything, which is what makes "no migration" work', () => {
  // Codes that were written dataset-scoped BEFORE they became project-scoped are not
  // rewritten. They simply appear in the project-wide list, because an unfiltered list
  // returns all records. Nothing vanishes and no migration code exists.
  const s = store();
  s.put(OWNER, 'codes', 'old', { name: 'Legacy' }, { scope: { wsId: 'w', dsId: DS_A } });
  s.put(OWNER, 'codes', 'new', { name: 'Modern' }, { scope: { wsId: 'w', dsId: null } });

  assert.deepEqual(ids(s.list(OWNER, 'codes')), ['new', 'old'],
    'an unscoped listing sees the legacy dataset-scoped code too');
});

test('re-putting a record can move it between scopes', () => {
  // What "copy this code to another codebook" and any future re-home tool need: scope is
  // rewritable, so a record is not stuck in the dataset it was born in.
  const s = store();
  s.put(OWNER, 'codes', 'c1', { name: 'Trust' }, { scope: { wsId: 'w', dsId: DS_A } });
  assert.deepEqual(ids(s.list(OWNER, 'codes', { dsId: DS_B })), []);

  s.put(OWNER, 'codes', 'c1', { name: 'Trust' }, { scope: { wsId: 'w', dsId: null } });
  assert.deepEqual(ids(s.list(OWNER, 'codes', { dsId: DS_B })), ['c1'], 'now project-wide');
});

test('scope survives a rebuild from the log', () => {
  // Records are folded from ops, and collaboration replays them. A scope that did not
  // survive the fold would silently re-scope every record on reload.
  const a = store();
  a.put(OWNER, 'codes', 'c1', { name: 'Trust' }, { scope: { wsId: 'w', dsId: null } });
  a.put(OWNER, 'segments', 's1', { doc: 'r' }, { scope: { wsId: 'w', dsId: DS_A } });

  // Rebuild a fresh store from the ops alone — what a reload, or a peer receiving the
  // log, actually does. If scope did not survive the fold, every record would silently
  // re-scope on reload.
  const b = new ItemStore({ log: a._log });
  b.loadFromLog(); // what project load does — the constructor only registers

  assert.deepEqual(ids(b.list(OWNER, 'codes', { dsId: DS_B })), ['c1'], 'still project-wide');
  assert.deepEqual(ids(b.list(OWNER, 'segments', { dsId: DS_B })), [], 'still dataset-bound');
  assert.deepEqual(ids(b.list(OWNER, 'segments', { dsId: DS_A })), ['s1'], 'and still visible at home');
});
