/**
 * @file project-health.test.mjs
 * Telling "wait" from "act", because for a folder project they are opposite advice.
 *
 * A project's `project.json` and its data files are the two ends of one save, and a
 * folder sync client delivers them in whatever order it likes. So on a synced folder, a
 * file the log expects being absent is **routine and self-healing**. In local OPFS
 * nothing else writes to the folder, so the same symptom means something went wrong and
 * waiting will not fix it.
 *
 * Getting the tone wrong costs in both directions: too alarming and someone deletes and
 * re-imports a project that was about to finish syncing; too casual and a genuinely
 * corrupt project rots behind a grey notice. The split is the feature, so it is what
 * these pin — along with the thing the owner asked for, which is that the recovery
 * options say WHY they are unavailable rather than hiding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectHealth, recoveryOptions } from '../core/project-health.js';

const integrity = (over = {}) => ({
  ok: false, manifestUnreadable: false, missing: [], unreferenced: [], unreadable: [], ...over,
});

// =============================================================================
// The same symptom, two meanings
// =============================================================================

test('a healthy project says nothing at all', () => {
  const h = projectHealth({ integrity: { ok: true }, backing: 'folder' });
  assert.equal(h.level, 'ok');
  assert.equal(h.short, '', 'no chip, no permanent badge to stop reading');
});

test('no integrity reading is not a problem report', () => {
  assert.equal(projectHealth({ integrity: null, backing: 'folder' }).level, 'ok');
});

test('missing files on a SYNCED folder means waiting', () => {
  const h = projectHealth({ integrity: integrity({ missing: ['src_a.parquet', 'src_b.parquet'] }), backing: 'folder' });
  assert.equal(h.level, 'waiting');
  assert.match(h.short, /Waiting for 2 files/);
  assert.match(h.detail, /sync separately/);
  assert.match(h.detail, /clears on its own/);
  assert.equal(h.canWait, true);
});

test('the same missing files in LOCAL storage means damage', () => {
  // Nothing else writes to OPFS, so they did not fail to arrive — they have gone.
  const h = projectHealth({ integrity: integrity({ missing: ['src_a.parquet'] }), backing: 'opfs' });
  assert.equal(h.level, 'damaged');
  assert.match(h.short, /1 file missing/);
  assert.match(h.detail, /they have gone/);
  assert.equal(h.canWait, false, 'waiting is not the advice here');
});

test('a present-but-unreadable file is damage on EITHER backing', () => {
  // A torn or empty file is not something a sync client is going to finish delivering.
  for (const backing of ['folder', 'opfs']) {
    const h = projectHealth({ integrity: integrity({ unreadable: ['src_a.parquet'] }), backing });
    assert.equal(h.level, 'damaged', backing);
    assert.match(h.short, /1 damaged file/);
  }
});

test('damage outranks absence when both are present', () => {
  // The worse diagnosis wins, or a folder project with one torn file and two missing
  // ones would read as "just waiting" and be left alone.
  const h = projectHealth({
    integrity: integrity({ missing: ['a'], unreadable: ['b'] }),
    backing: 'folder',
  });
  assert.equal(h.level, 'damaged');
});

test('an unreadable manifest is its own message, and differs by backing', () => {
  const folder = projectHealth({ integrity: integrity({ manifestUnreadable: true }), backing: 'folder' });
  const local = projectHealth({ integrity: integrity({ manifestUnreadable: true }), backing: 'opfs' });
  assert.equal(folder.level, 'damaged');
  assert.match(folder.detail, /still being written/, 'a folder gets the benefit of the doubt');
  assert.match(local.detail, /Nothing else writes to local storage/);
});

test('unexpected files alone are reported quietly, not as loss', () => {
  // The other half of the same race: a collaborator's data arriving before the index
  // that explains it. Nothing is lost, so the wording must not imply it is.
  const h = projectHealth({ integrity: integrity({ unreferenced: ['src_peer.parquet'] }), backing: 'folder' });
  assert.equal(h.level, 'waiting');
  assert.match(h.short, /1 unexpected file/);
  assert.match(h.detail, /only copy/);
});

test('a live session is a reason to hope even in local storage', () => {
  const h = projectHealth({ integrity: integrity({ missing: ['a'] }), backing: 'opfs', live: true });
  assert.equal(h.canWait, true);
  assert.match(h.detail, /peer/);
});

// =============================================================================
// The recovery routes: all shown, the unavailable ones saying why
// =============================================================================

const opts = (over = {}) => {
  const integ = over.integrity ?? integrity({ missing: ['src_a.parquet'] });
  return recoveryOptions({
    health: projectHealth({ integrity: integ, backing: over.backing ?? 'folder', live: over.live }),
    integrity: integ,
    rebuildable: over.rebuildable ?? [],
    live: over.live ?? false,
    spareBytes: over.spareBytes ?? 0,
  });
};
const byId = (list, id) => list.find((o) => o.id === id);

test('every route is listed, even when it cannot be taken', () => {
  // Hiding an option tells the user nothing; a disabled one with its reason tells them
  // what state they are in.
  const ids = opts().map((o) => o.id);
  assert.deepEqual(ids, ['recheck', 'rebuild', 'peer', 'discard']);
  for (const o of opts()) assert.ok(o.why && o.why.length > 20, `${o.id} must explain itself`);
});

test('rebuild is offered only for files this session still holds', () => {
  const off = byId(opts(), 'rebuild');
  assert.equal(off.enabled, false);
  assert.match(off.why, /no copy of their rows in memory/);
  assert.match(off.why, /went missing AFTER it was loaded/, 'and says when it WOULD help');

  const on = byId(opts({ rebuildable: ['src_a.parquet'] }), 'rebuild');
  assert.equal(on.enabled, true);
  assert.match(on.label, /Rewrite 1 file/);
});

test('rebuild counts only the affected files it can actually fix', () => {
  const integ = integrity({ missing: ['src_a.parquet', 'src_b.parquet'] });
  const o = byId(opts({ integrity: integ, rebuildable: ['src_a.parquet', 'src_unrelated.parquet'] }), 'rebuild');
  assert.match(o.label, /Rewrite 1 file/);
  assert.match(o.why, /1 of the 2 affected files/);
});

test('rebuild warns about the sync conflict it can cause', () => {
  // It writes our copy into a folder a sync client is actively managing.
  const o = byId(opts({ rebuildable: ['src_a.parquet'] }), 'rebuild');
  assert.match(o.why, /conflicting change/);
});

test('asking a peer needs a peer, and says how to get one', () => {
  assert.equal(byId(opts(), 'peer').enabled, false);
  assert.match(byId(opts(), 'peer').why, /Go live/);
  assert.equal(byId(opts({ live: true }), 'peer').enabled, true);
});

test('deleting unexpected files is offered only when there are some, with the caution', () => {
  assert.equal(byId(opts(), 'discard').enabled, false);
  const spare = opts({
    integrity: integrity({ unreferenced: ['src_peer.parquet'] }),
    spareBytes: 5 * 1024 * 1024,
  });
  const o = byId(spare, 'discard');
  assert.equal(o.enabled, true);
  assert.match(o.label, /frees 5\.0 MB/);
  assert.match(o.why, /only copy/, 'the caution travels with the button');
});

test('check-again is always available, and leads with it while waiting', () => {
  const waiting = byId(opts(), 'recheck');
  assert.equal(waiting.enabled, true);
  assert.match(waiting.why, /first/, 'the thing to try first when a sync may still be running');
  const local = byId(opts({ backing: 'opfs' }), 'recheck');
  assert.equal(local.enabled, true);
  assert.doesNotMatch(local.why, /first/, 'but not advertised as the fix when it cannot be');
});
