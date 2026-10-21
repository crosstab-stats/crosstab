/**
 * @file project-integrity.test.mjs
 * A project's files versus what its manifest expects — and the save that used to
 * destroy the difference.
 *
 * ## The bug this file exists for
 *
 * `#sweep` removed every `src_*.parquet` and every asset the manifest BEING SAVED did
 * not reference. That is correct only if my manifest is the whole truth, and in a folder
 * a sync client writes into it is not: a peer's `project.json` and their Parquet are the
 * two ends of one save and arrive in whatever order the sync client feels like. Land the
 * bytes first and my next autosave deleted them — then their manifest arrived pointing at
 * files I had destroyed, while from their side the sync had succeeded.
 *
 * Two tabs on one OPFS project do the same thing to each other, so `externallySynced` is
 * not the discriminator and OPFS is not safe by being local.
 *
 * ## The rule, which the project already had written down twice
 *
 * Abstain on partial knowledge. A memo whose anchor is gone is *surfaced, not swept*;
 * asset GC *"refuses to sweep while ANY item collection is undeclared"*, because a
 * declaration nobody wrote looks exactly like "nothing references this". A file this
 * session has never seen referenced is the same shape of unknown — unaccounted for, not
 * garbage. The sweep now deletes only what it can prove it dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore, manifestRefs } from '../core/project-store.js';

/** A driver that records what it is asked to delete. */
function memoryDriver() {
  const files = new Map();
  const removed = [];
  const enc = new TextEncoder();
  return {
    kind: 'memory',
    capabilities: { flat: false, externallySynced: true, atomicWrite: true, canStream: true },
    get available() { return true; },
    files,
    removed,
    async read(p) { return files.get(p) ?? null; },
    async write(p, b) { files.set(p, b instanceof Uint8Array ? b : enc.encode(String(b))); },
    async writeStream(p, blob) { files.set(p, new Uint8Array(await blob.arrayBuffer())); },
    async readBlob(p) { return files.has(p) ? new Blob([files.get(p)]) : null; },
    async remove(p) { removed.push(p); files.delete(p); },
    async removeTree(p) { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k); },
    async list(dir) {
      const out = new Set();
      const prefix = dir ? `${dir}/` : '';
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest) out.add(rest.split('/')[0]);
      }
      return [...out];
    },
    async stat(p) { return files.has(p) ? { size: files.get(p).length, mtime: 0 } : null; },
  };
}

const store = () => {
  const d = memoryDriver();
  const s = new ProjectStore();
  s.useDriver(d, { flat: false });
  return { s, d };
};

/**
 * A bundle with one real source op — bytes included, because `save` writes the Parquet
 * from the op and refuses a source that claims a file and carries nothing.
 */
const withSource = (file, opId = 'op1') => ({
  activePlugins: [],
  datasets: [],
  log: [{
    id: opId,
    type: 'load',
    target: 'ds:1/data',
    payload: { src: { file, label: 'rows', parquet: new Uint8Array([80, 65, 82, 49, 1, 2, 3]) } },
  }],
});
const empty = () => ({ log: [], datasets: [], activePlugins: [] });

/**
 * The same source op after it has been retracted, undone, or left behind a replace
 * barrier: the envelope stays in the log for audit and merge, and loses `src.file`.
 *
 * That byte-less state is the EVIDENCE the sweep acts on, and it is what retracting
 * actually produces — an op does not vanish from the log, because physical removal is
 * merge-unsafe under shared-id ancestry (#149).
 */
const deadSource = (opId = 'op1') => ({
  activePlugins: [],
  datasets: [],
  log: [{ id: opId, type: 'load', target: 'ds:1/data', payload: { src: { label: 'rows', meta: [] } } }],
});

const put = (d, path, bytes = [80, 65, 82, 49]) => d.files.set(path, new Uint8Array(bytes));
const names = (d, id) => [...d.files.keys()].filter((k) => k.startsWith(`projects/${id}/`)).sort();

// =============================================================================
// The data loss
// =============================================================================

test('a save does NOT delete a peer’s file that arrived before their manifest', async () => {
  // Reproduced against the store before the fix: both of these were gone after one
  // ordinary autosave, and the peer's manifest then arrived pointing at nothing.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Shared', savedAt: 1000, bundle: empty() });
  put(d, 'projects/p1/src_peerop123.parquet');
  put(d, 'projects/p1/assets/deadbeef.bin', [1, 2, 3]);

  await s.save({ id: 'p1', name: 'Shared', savedAt: 2000, bundle: empty() });

  assert.ok(d.files.has('projects/p1/src_peerop123.parquet'), 'the peer’s data survived');
  assert.ok(d.files.has('projects/p1/assets/deadbeef.bin'), 'and their media');
});

test('a project this session has never seen is not swept at all', async () => {
  // No knowledge means no sweeping, rather than sweeping against an empty set — which
  // is "delete everything in the folder".
  const { s, d } = store();
  put(d, 'projects/p9/src_a.parquet');
  put(d, 'projects/p9/src_b.parquet');
  await s.save({ id: 'p9', name: 'Arrived from elsewhere', savedAt: 1000, bundle: empty() });
  assert.ok(d.files.has('projects/p9/src_a.parquet'));
  assert.ok(d.files.has('projects/p9/src_b.parquet'));
});

test('a SAVE frees nothing, however dead the source is', async () => {
  // Saving is about durability; what to keep is a space decision, and making it as a
  // side effect of every save is where every bug in this area came from — including the
  // one that deleted a peer's half-synced data.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: deadSource('op1') });
  assert.ok(d.files.has('projects/p1/src_op1.parquet'), 'still there after the save');
});

test('compaction collects a retracted source, and only on being asked', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: deadSource('op1') });

  const plan = await s.compactProject('p1', { dryRun: true });
  assert.deepEqual(plan.files, ['src_op1.parquet']);
  assert.ok(plan.bytes > 0, 'and it can say how much');
  assert.equal(plan.removed, 0, 'a dry run removes nothing');
  assert.ok(d.files.has('projects/p1/src_op1.parquet'));

  const done = await s.compactProject('p1');
  assert.equal(done.removed, 1);
  assert.ok(!d.files.has('projects/p1/src_op1.parquet'));
});

test('compaction leaves a live source alone', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  const plan = await s.compactProject('p1', { dryRun: true });
  assert.deepEqual(plan.files, []);
  assert.ok(d.files.has('projects/p1/src_op1.parquet'));
});

test('compaction never touches a file whose op it has never heard of', async () => {
  // The protection the save-time sweep got wrong, now the only place that deletes.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: empty() });
  put(d, 'projects/p1/src_peer.parquet');
  const done = await s.compactProject('p1');
  assert.deepEqual(done.files, []);
  assert.ok(d.files.has('projects/p1/src_peer.parquet'));
});

test('compacting an unreadable or locked project frees nothing', async () => {
  // Nothing can be proved dead without a manifest, and "I cannot read it" must not
  // become "none of it is referenced".
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  d.files.set('projects/p1/project.json', new TextEncoder().encode('{ torn'));
  const done = await s.compactProject('p1');
  assert.deepEqual(done.files, []);
  assert.ok(d.files.has('projects/p1/src_op1.parquet'));
});

test('an op that VANISHES from the log deletes nothing', async () => {
  // The distinction the owner's question turned on. Retracting keeps the envelope and
  // drops `src.file`; an op simply not being there means something else — a regressed
  // merge, a half-loaded log, a bug — and absence must not be read as a decision.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: empty() });
  assert.ok(d.files.has('projects/p1/src_op1.parquet'),
    'no evidence, so no deletion — the bytes wait for a log that explains them');
});

test('compaction needs no session memory — the manifest carries the evidence', async () => {
  // A fresh store that has never seen this project can still compact it, because the
  // proof is in the file it reads rather than in anything it remembers.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: deadSource('op1') });

  const fresh = new ProjectStore();
  fresh.useDriver(d, { flat: false });
  const done = await fresh.compactProject('p1');
  assert.equal(done.removed, 1);
});

test('a live op of the same name beats a dead one', async () => {
  // Cannot happen today — the file name IS the op id, so one op owns one name — but a
  // merge that revived a retracted source would make it possible, and resurrecting
  // bytes is cheaper to get right than un-deleting them.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  const both = {
    activePlugins: [], datasets: [],
    log: [
      { id: 'op1', type: 'load', target: 'ds:1/data', payload: { src: { label: 'dead', meta: [] } } },
      { id: 'op2', type: 'load', target: 'ds:1/data', payload: { src: { file: 'src_op1.parquet', label: 'alive', meta: [], parquet: new Uint8Array([80, 65, 82, 49]) } } },
    ],
  };
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: both });
  await s.compactProject('p1');
  assert.ok(d.files.has('projects/p1/src_op1.parquet'), 'something live still names it');
});

test('assets are not collected by a save OR by compaction', async () => {
  // They were, by the same absence rule. The app owns asset GC properly — reference
  // counted across item fields and dataset cells, refusing to run while any collection
  // is undeclared, and a rare explicit act rather than a side effect of saving. Two
  // collectors over the same bytes with different ideas of "referenced" is how one
  // deletes what the other is keeping.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: empty() });
  put(d, 'projects/p1/assets/orphan.bin', [1, 2, 3]);
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: empty() });
  await s.compactProject('p1');
  assert.ok(d.files.has('projects/p1/assets/orphan.bin'));
});

test('a second tab’s new dataset survives this tab’s autosave', async () => {
  // The same bug without any folder sync at all, which is why `externallySynced` is not
  // the discriminator: two tabs are two sessions over one OPFS project.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: empty() });
  const other = new ProjectStore();
  other.useDriver(d, { flat: false });
  await other.save({ id: 'p1', name: 'Study', savedAt: 1500, bundle: withSource('src_tabB.parquet', 'tabB') });
  put(d, 'projects/p1/src_tabB.parquet');

  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: empty() });
  assert.ok(d.files.has('projects/p1/src_tabB.parquet'), 'the other tab’s data survived');
});

// =============================================================================
// manifestRefs — one reader, so the sweep and the check cannot disagree
// =============================================================================

test('manifestRefs finds both kinds of reference', () => {
  const refs = manifestRefs({
    log: [
      { id: 'o1', type: 'load', payload: { src: { file: 'src_o1.parquet' } } },
      { id: 'o2', type: 'addAsset', payload: { id: 'abc123' } },
      { id: 'o3', type: 'setCell', payload: {} },
    ],
  });
  assert.deepEqual([...refs].sort(), ['assets/abc123.bin', 'src_o1.parquet']);
});

test('a byte-less source op references nothing', () => {
  // A retracted source keeps its op and loses its bytes deliberately (#149 B3); it must
  // not make the check report a missing file for something nothing expects.
  assert.equal(manifestRefs({ log: [{ id: 'o1', type: 'load', payload: { src: {} } }] }).size, 0);
  assert.equal(manifestRefs({}).size, 0);
  assert.equal(manifestRefs(null).size, 0);
});

// =============================================================================
// The check: four outcomes, kept apart
// =============================================================================

test('a healthy project reports ok with nothing to say', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  put(d, 'projects/p1/src_op1.parquet');
  const r = await s.projectIntegrity('p1');
  assert.equal(r.ok, true);
  assert.deepEqual([r.missing, r.unreferenced, r.unreadable], [[], [], []]);
  assert.equal(r.checked, 1);
});

test('a referenced file that is not here is MISSING, not corrupt', async () => {
  // The common case, and the one that today shows up as a dataset coming back empty
  // with nothing said: `project.json` synced before the Parquet.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  // The manifest landed; the Parquet did not — or has gone since.
  d.files.delete('projects/p1/src_op1.parquet');
  const r = await s.projectIntegrity('p1');
  assert.deepEqual(r.missing, ['src_op1.parquet']);
  assert.deepEqual(r.unreadable, [], 'absent is not damaged');
  assert.equal(r.ok, false);
});

test('a file nothing points at is UNREFERENCED, and that is not a verdict of garbage', async () => {
  // The opposite order of the same race. Until the matching manifest arrives this is
  // the only copy of someone's data — which is exactly why the sweep leaves it alone.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: empty() });
  put(d, 'projects/p1/src_peer.parquet');
  const r = await s.projectIntegrity('p1');
  assert.deepEqual(r.unreferenced, ['src_peer.parquet']);
  assert.deepEqual(r.missing, []);
});

test('a half-written file is UNREADABLE, which is the only unambiguous damage', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  put(d, 'projects/p1/src_op1.parquet', []);     // created, never written
  const r = await s.projectIntegrity('p1');
  assert.deepEqual(r.unreadable, ['src_op1.parquet']);
  assert.deepEqual(r.missing, [], 'it is here — it is just not data');
});

test('an unreadable manifest says so and stops', async () => {
  // Reporting every file as unreferenced would be true and useless: nothing is known
  // about what this project expects, so the honest answer is that one fact.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  put(d, 'projects/p1/src_op1.parquet');
  d.files.set('projects/p1/project.json', new TextEncoder().encode('{ torn'));
  const r = await s.projectIntegrity('p1');
  assert.equal(r.manifestUnreadable, true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unreferenced, [], 'it does not guess about the rest');
});

test('assets are checked the same way as sources', async () => {
  const { s, d } = store();
  const bundle = {
    activePlugins: [], datasets: [],
    log: [{ id: 'o2', type: 'addAsset', target: 'asset:abc123', payload: { id: 'abc123' } }],
  };
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle });
  const missing = await s.projectIntegrity('p1');
  assert.deepEqual(missing.missing, ['assets/abc123.bin']);
  put(d, 'projects/p1/assets/abc123.bin', [1, 2, 3]);
  const healthy = await s.projectIntegrity('p1');
  assert.equal(healthy.ok, true);
});

test('the check never repairs anything', async () => {
  // Reporting and acting are different jobs, and the one time this code acted on its
  // own judgement it deleted a colleague's data.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  put(d, 'projects/p1/src_peer.parquet');
  const before = names(d, 'p1');
  const r = await s.projectIntegrity('p1');
  assert.equal(r.ok, false);
  assert.deepEqual(names(d, 'p1'), before, 'not one byte moved');
  assert.deepEqual(d.removed, []);
});

// =============================================================================
// Discarding what the log cannot account for — a USER's call, not the app's
// =============================================================================
// Separate from compaction, and the difference is authority rather than mechanism.
// Compaction acts on the log's own evidence and needs nobody's permission; this deletes
// files the log says nothing about, which is the exact case the save path was changed to
// stop touching. It exists only because a person can know the one thing the app cannot:
// that the sync has finished.

test('discarding removes exactly the unreferenced files, and compaction does not', async () => {
  // The browser pass caught this wired the wrong way round: the dialog's "delete the
  // unexpected files" called compactProject, which deliberately will not touch them —
  // so it reported zero bytes and did nothing, while telling the user it had tidied up.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  put(d, 'projects/p1/src_peer.parquet', [1, 2, 3, 4, 5]);

  const compacted = await s.compactProject('p1');
  assert.deepEqual(compacted.files, [], 'compaction has no evidence about it');
  assert.ok(d.files.has('projects/p1/src_peer.parquet'));

  const plan = await s.discardUnreferenced('p1', { dryRun: true });
  assert.deepEqual(plan.files, ['src_peer.parquet']);
  assert.equal(plan.bytes, 5);
  assert.equal(plan.removed, 0);
  assert.ok(d.files.has('projects/p1/src_peer.parquet'), 'a dry run removes nothing');

  const done = await s.discardUnreferenced('p1');
  assert.equal(done.removed, 1);
  assert.ok(!d.files.has('projects/p1/src_peer.parquet'));
  assert.ok(d.files.has('projects/p1/src_op1.parquet'), 'the live source is untouched');
});

test('discarding refuses entirely when the manifest cannot be read', async () => {
  // Without a manifest EVERY file is unaccounted-for, so this would delete the project's
  // data because its index was briefly unreadable — the worst outcome in this whole area.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: withSource('src_op1.parquet') });
  put(d, 'projects/p1/src_peer.parquet');
  d.files.set('projects/p1/project.json', new TextEncoder().encode('{ torn'));

  const done = await s.discardUnreferenced('p1');
  assert.deepEqual(done.files, []);
  assert.equal(done.removed, 0);
  assert.ok(d.files.has('projects/p1/src_op1.parquet'));
  assert.ok(d.files.has('projects/p1/src_peer.parquet'));
});
