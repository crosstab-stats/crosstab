/**
 * Headless tests for the item tier (core/item-store.js, #152 Layer 1).
 * Run: `npm test`.
 *
 * Two things are being proven here. First the fold itself — field merge, tombstones,
 * resurrection, undo. Second, and more importantly, the **merge routing**: the whole
 * design rests on item ops reaching op-union rather than a plugin's blob merger, and
 * that property lives in code this module doesn't own (collab-sync), so it is asserted
 * here rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';
import { ItemStore, foldItems, itemTarget, parseItemTarget, isItemOp, newItemId } from '../core/item-store.js';
import { mergeProjects, mergerKey } from '../core/collab-sync.js';
import { mergeState as caqdasMergeState } from '../plugins/builtin-caqdas/index.js';

const NUL = '\u0000';

/** A peer with a controllable clock, so HLC order is deterministic. */
function peer(startWall, author = { authorId: 'a', initials: 'A' }) {
  let wall = startWall;
  const log = new ProjectLog({ hlc: new HLC({ now: () => wall }), author: () => author });
  return { log, store: new ItemStore({ log }), tick: (w) => { wall = w; } };
}

const itemsOf = (log) => foldItems(log.filter(isItemOp));

// --- addressing --------------------------------------------------------------

test('itemTarget round-trips through parseItemTarget', () => {
  const t = itemTarget('core', 'memos', 'm1');
  assert.equal(t, `item:core${NUL}memos${NUL}m1`);
  assert.deepEqual(parseItemTarget(t), ['core', 'memos', 'm1']);
  assert.ok(isItemOp({ target: t }));
  assert.ok(!isItemOp({ target: `ws:builtin${NUL}caqdas-coding${NUL}_default${NUL}5` }));
});

test('itemTarget rejects a NUL in any coordinate (a mis-addressed op must fail loudly)', () => {
  assert.throws(() => itemTarget('core', `me${NUL}mos`, 'm1'), /may not contain NUL/);
  assert.throws(() => itemTarget('core', 'memos', ''), /id is required/);
});

test('newItemId is unique and namespaced apart from op ids', () => {
  const a = newItemId();
  assert.notEqual(a, newItemId());
  assert.match(a, /^it-/);
});

// --- fold --------------------------------------------------------------------

test('put then read: the record folds out of the log', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'hello', anchor: 'ds:1' });
  assert.deepEqual(store.get('core', 'memos', 'm1').fields, { text: 'hello', anchor: 'ds:1' });
});

test('putItem SHALLOW-MERGES fields — a partial update keeps the rest', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'first', anchor: 'ds:1' });
  store.put('core', 'memos', 'm1', { text: 'edited' });
  assert.deepEqual(store.get('core', 'memos', 'm1').fields, { text: 'edited', anchor: 'ds:1' });
});

test('the cache matches a cold refold (write-through is not drifting)', () => {
  const { log, store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a' });
  store.put('core', 'memos', 'm1', { text: 'b', extra: 1 });
  store.put('core', 'notes', 'n1', { text: 'c' });
  const cold = foldItems(log.slice(isItemOp));
  assert.deepEqual(store.get('core', 'memos', 'm1'), cold.get('core').get('memos').get('m1'));
  assert.deepEqual(store.get('core', 'notes', 'n1'), cold.get('core').get('notes').get('n1'));
});

test('author is CREATION authorship, not last-touch', () => {
  const { log, store } = peer(1000, { authorId: 'kc', initials: 'KC' });
  store.put('core', 'memos', 'm1', { text: 'mine' });
  log.append({
    target: itemTarget('core', 'memos', 'm1'), owner: 'core', type: 'putItem',
    payload: { fields: { text: 'theirs' } }, author: { authorId: 'rt', initials: 'RT' },
  });
  store.loadFromLog();
  const rec = store.get('core', 'memos', 'm1');
  assert.equal(rec.fields.text, 'theirs');
  assert.equal(rec.author.authorId, 'kc');
});

test('removeItem tombstones, and a later put resurrects (deletion is an op, not a state)', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a' });
  store.remove('core', 'memos', 'm1');
  assert.equal(store.get('core', 'memos', 'm1'), null);
  store.put('core', 'memos', 'm1', { text: 'back' });
  assert.equal(store.get('core', 'memos', 'm1').fields.text, 'back');
});

test('resurrection RESTORES the untouched fields, it does not start blank', () => {
  // This is the concurrent remove-vs-edit case, not a user recreating a record: ids are
  // minted fresh, so the only way a put lands after a remove is that a peer was editing
  // the full record. Blanking the fields it did not mention would be silent data loss.
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a', anchor: 'ds:1' });
  store.remove('core', 'memos', 'm1');
  store.put('core', 'memos', 'm1', { text: 'b' });
  assert.deepEqual(store.get('core', 'memos', 'm1').fields, { text: 'b', anchor: 'ds:1' });
});

test('cache still matches a cold refold across a remove/resurrect cycle', () => {
  // The generic drift test above only exercises puts. Removal is where the write-through
  // cache and the fold first disagreed: dropping the record from the cache lost the
  // fields a resurrection has to restore.
  const { log, store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a', anchor: 'ds:1' });
  store.remove('core', 'memos', 'm1');
  store.put('core', 'memos', 'm1', { text: 'b' });
  const cold = foldItems(log.slice(isItemOp));
  assert.deepEqual(store.get('core', 'memos', 'm1'), cold.get('core').get('memos').get('m1'));
});

// --- undo (the headline benefit: a plugin action becomes undoable) -----------

test('undo hides the put — the record reverts to its previous fields', () => {
  const { log, store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'first' });
  store.put('core', 'memos', 'm1', { text: 'second' });
  log.undoWhere(isItemOp);
  store.loadFromLog();
  assert.equal(store.get('core', 'memos', 'm1').fields.text, 'first');
});

test('undoing the creating put removes the record entirely', () => {
  const { log, store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'only' });
  log.undoWhere(isItemOp);
  store.loadFromLog();
  assert.equal(store.get('core', 'memos', 'm1'), null);
});

test('undoing a removeItem brings the record back', () => {
  const { log, store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a' });
  store.remove('core', 'memos', 'm1');
  log.undoWhere(isItemOp);
  store.loadFromLog();
  assert.equal(store.get('core', 'memos', 'm1').fields.text, 'a');
});

// --- scope + listing ---------------------------------------------------------

test('list narrows by dataset scope; project-scoped records show for every dataset', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'on ds 1' }, { scope: { dsId: 1 } });
  store.put('core', 'memos', 'm2', { text: 'on ds 2' }, { scope: { dsId: 2 } });
  store.put('core', 'memos', 'm3', { text: 'project-wide' });
  assert.deepEqual(store.list('core', 'memos', { dsId: 1 }).map((r) => r.id), ['m1', 'm3']);
  assert.deepEqual(store.list('core', 'memos').map((r) => r.id), ['m1', 'm2', 'm3']);
});

test('scope survives a later partial put that omits it', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a' }, { scope: { dsId: 7 } });
  store.put('core', 'memos', 'm1', { text: 'b' });
  assert.deepEqual(store.get('core', 'memos', 'm1').scope, { dsId: 7 });
});

test('dropDataset tombstones records for that dataset only', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a' }, { scope: { dsId: 1 } });
  store.put('core', 'memos', 'm2', { text: 'b' }, { scope: { dsId: 2 } });
  store.put('core', 'memos', 'm3', { text: 'c' });
  store.dropDataset(1);
  assert.deepEqual(store.list('core', 'memos').map((r) => r.id), ['m2', 'm3']);
});

// --- persistence round-trip --------------------------------------------------

test('ops() / restoreOps() round-trip the tier and preserve op ids for merge', () => {
  const { store } = peer(1000);
  store.put('core', 'memos', 'm1', { text: 'a' });
  store.put('core', 'memos', 'm2', { text: 'b' });
  const saved = store.ops();

  const fresh = peer(2000);
  fresh.store.restoreOps(saved);
  assert.deepEqual(fresh.store.list('core', 'memos').map((r) => r.fields.text), ['a', 'b']);
  assert.deepEqual(fresh.store.ops().map((o) => o.id), saved.map((o) => o.id));
});

test('restoreOps replaces the item tier without disturbing other tiers', () => {
  const { log, store } = peer(1000);
  log.append({ target: 'coll/ds:1', owner: 'core', type: 'addDataset', payload: { id: 1, name: 'gss' } });
  store.put('core', 'memos', 'm1', { text: 'a' });
  store.restoreOps([]);
  assert.equal(store.list('core', 'memos').length, 0);
  assert.equal(log.ops().filter((o) => o.target === 'coll/ds:1').length, 1);
});

// --- merge routing (the property this design rests on) -----------------------

test('MERGE ROUTING: plugin-owned item ops union by id and never reach a blob merger', () => {
  // The hazard: mergeProjects dispatches non-core ops per owner, and a plugin's declared
  // merger expects BLOB state ({codes, segments, memos}), not ops. If item ops were fed
  // to it, CAQDAS's mergeState would run on an op array and silently produce nonsense.
  // They must instead fall through to the plain per-owner id union.
  let called = 0;
  const spy = (arg) => { called++; return caqdasMergeState(arg); };

  const a = peer(1000);
  const b = peer(2000);
  a.store.put('builtin', 'segments', 's1', { doc: 1, codeId: 'c1' });
  b.store.put('builtin', 'segments', 's2', { doc: 1, codeId: 'c2' });

  const { manifest, conflicts } = mergeProjects(
    { log: a.log.serialize() },
    { log: b.log.serialize() },
    { [mergerKey('builtin', 'caqdas-coding')]: { merge: spy }, 'caqdas-coding': { merge: spy } },
  );

  assert.equal(called, 0, 'a blob merger must not be invoked for item ops');
  assert.deepEqual(conflicts, []);
  assert.deepEqual([...itemsOf(manifest.log).get('builtin').get('segments').keys()].sort(), ['s1', 's2']);
});

test('MERGE: two peers adding different records both survive (add-wins, for free)', () => {
  const a = peer(1000);
  const b = peer(2000);
  a.store.put('core', 'memos', 'm1', { text: 'faculty note' });
  b.store.put('core', 'memos', 'm2', { text: 'student note' });

  const { manifest } = mergeProjects({ log: a.log.serialize() }, { log: b.log.serialize() }, {});
  assert.deepEqual([...itemsOf(manifest.log).get('core').get('memos').keys()].sort(), ['m1', 'm2']);
});

test('MERGE: concurrent edits to DIFFERENT fields of one record both land', () => {
  // The payoff of the shallow field merge: under blob LWW one of these two is lost.
  const seedPeer = peer(1000);
  seedPeer.store.put('builtin', 'memos', 'm1', { text: 'original', anchor: 'ds:1' });
  const seed = seedPeer.store.ops();

  const left = peer(3000);
  left.store.restoreOps(seed);
  left.store.put('builtin', 'memos', 'm1', { text: 'edited text' });

  const right = peer(4000);
  right.store.restoreOps(seed);
  right.store.put('builtin', 'memos', 'm1', { anchor: 'ds:2' });

  const { manifest } = mergeProjects({ log: left.log.serialize() }, { log: right.log.serialize() }, {});
  const rec = itemsOf(manifest.log).get('builtin').get('memos').get('m1');
  assert.equal(rec.fields.text, 'edited text');
  assert.equal(rec.fields.anchor, 'ds:2');
});

test('MERGE: remove on one side, later edit on the other — HLC decides, and the edit wins', () => {
  const seedPeer = peer(1000);
  seedPeer.store.put('builtin', 'memos', 'm1', { text: 'a', anchor: 'ds:1' });
  const seed = seedPeer.store.ops();

  const remover = peer(3000);
  remover.store.restoreOps(seed);
  remover.store.remove('builtin', 'memos', 'm1');

  const editor = peer(4000); // later wall clock → its put sorts after the remove
  editor.store.restoreOps(seed);
  editor.store.put('builtin', 'memos', 'm1', { text: 'still here' });

  const { manifest } = mergeProjects({ log: remover.log.serialize() }, { log: editor.log.serialize() }, {});
  const rec = itemsOf(manifest.log).get('builtin').get('memos').get('m1');
  assert.equal(rec.fields.text, 'still here');
  assert.equal(rec.fields.anchor, 'ds:1', 'the untouched field survives the resurrection');
});

test('MERGE: later remove beats an earlier edit (the mirror case)', () => {
  const seedPeer = peer(1000);
  seedPeer.store.put('builtin', 'memos', 'm1', { text: 'a' });
  const seed = seedPeer.store.ops();

  const editor = peer(3000);
  editor.store.restoreOps(seed);
  editor.store.put('builtin', 'memos', 'm1', { text: 'edited' });

  const remover = peer(4000);
  remover.store.restoreOps(seed);
  remover.store.remove('builtin', 'memos', 'm1');

  const { manifest } = mergeProjects({ log: editor.log.serialize() }, { log: remover.log.serialize() }, {});
  assert.equal(itemsOf(manifest.log).get('builtin')?.get('memos')?.get('m1'), undefined);
});
