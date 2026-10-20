/**
 * @file project-catalog-writes.test.mjs
 * A save's catalog cost must not depend on how many projects there are.
 *
 * Measured at 44 projects (2026-10-17): `catalog.json` was 30 KB, and every save read the
 * whole file, rebuilt one entry and rewrote the whole file under a lock. So the price of
 * a busy index was paid by every autosave of every project — including a small one with
 * nothing to do with the other 999 — and because it is a WRITE it degrades faster than a
 * read would.
 *
 * The catalog is a browse index derived from projects whose own bytes are already safely
 * on disk, so the write can wait. These tests pin the three things that makes true:
 *
 *  1. The hot path does no catalog IO at all.
 *  2. Nothing is lost by waiting — in particular, two pending changes to one project
 *     COMPOSE, and a change you have made is visible in `list()` before it is flushed.
 *  3. What cannot safely wait does not: a creation, a rename and a deletion are durable
 *     before their call returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../core/project-store.js';
import { MAGIC } from '../core/crypto-envelope.js';

/** An in-memory driver that COUNTS what it is asked to do, per path. */
function countingDriver() {
  const files = new Map();
  const reads = new Map();
  const writes = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const enc = new TextEncoder();
  return {
    kind: 'memory',
    capabilities: { flat: false, externallySynced: false, atomicWrite: true, canStream: true },
    get available() { return true; },
    files,
    reads,
    writes,
    catalogWrites: () => writes.get('projects/catalog.json') ?? 0,
    catalogReads: () => reads.get('projects/catalog.json') ?? 0,
    async read(path) { bump(reads, path); return files.get(path) ?? null; },
    async write(path, bytes) {
      bump(writes, path);
      files.set(path, bytes instanceof Uint8Array ? bytes : enc.encode(String(bytes)));
    },
    async writeStream(path, blob) { bump(writes, path); files.set(path, new Uint8Array(await blob.arrayBuffer())); },
    async readBlob(path) { return files.has(path) ? new Blob([files.get(path)]) : null; },
    async remove(path) { files.delete(path); },
    async removeTree(path) { for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k); },
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
    async stat(path) { return files.has(path) ? { size: files.get(path).length, mtime: 0 } : null; },
  };
}

const bundle = () => ({ log: [], datasets: [], activePlugins: [] });

function store() {
  const d = countingDriver();
  const s = new ProjectStore();
  s.useDriver(d, { flat: false });
  return { s, d };
}

const catalog = (d) => JSON.parse(new TextDecoder().decode(d.files.get('projects/catalog.json')));

// =============================================================================
// 1. The hot path
// =============================================================================

test('the first save of a project writes the catalog; the next ones do not', async () => {
  // The first is when the ENTRY may need CREATING. `list()` can recover a folder the
  // catalog has no record of, but only by reading its manifest — so writing a creation
  // at once is what keeps recovery exceptional instead of the normal path.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  assert.equal(d.catalogWrites(), 1, 'the creating save is durable at once');

  for (let i = 0; i < 20; i += 1) {
    await s.save({ id: 'p1', name: 'Study', savedAt: 2000 + i, bundle: bundle() });
  }
  assert.equal(d.catalogWrites(), 1, 'twenty autosaves, no further catalog write');
  assert.equal(d.catalogReads(), 1, 'and they do not read it either');
});

test('a burst of autosaves collapses into ONE catalog write', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  const before = d.catalogWrites();
  for (let i = 0; i < 50; i += 1) {
    await s.save({ id: 'p1', name: 'Study', savedAt: 2000 + i, bundle: bundle() });
  }
  await s.flushCatalog();
  assert.equal(d.catalogWrites(), before + 1);
  assert.equal(catalog(d).entries[0].savedAt, 2049, 'and the last one is what landed');
});

test('saving one project does not touch another project’s cost', async () => {
  // The point of the whole change: a busy index must not make a small project's save
  // more expensive. With a whole-file rewrite it did, linearly.
  const { s, d } = store();
  for (let i = 0; i < 10; i += 1) {
    await s.save({ id: `p${i}`, name: `P${i}`, savedAt: 1000 + i, bundle: bundle() });
  }
  await s.flushCatalog();
  const before = d.catalogWrites();
  await s.save({ id: 'p3', name: 'P3', savedAt: 9999, bundle: bundle() });
  assert.equal(d.catalogWrites(), before, 'an established project’s save writes nothing');
});

// =============================================================================
// 2. Nothing is lost by waiting
// =============================================================================

test('a pending change is visible in list() before it reaches disk', async () => {
  // Open a project and go straight to the manager: without this the "recent" order
  // would be stale for as long as the flush had not run.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  const writes = d.catalogWrites();
  await s.markOpened('p1', 5000);
  assert.equal(d.catalogWrites(), writes, 'the stamp has not been written');
  const [entry] = await s.list();
  assert.equal(entry.lastOpenedAt, 5000, 'and is reported anyway');
});

test('two pending changes to one project COMPOSE', async () => {
  // The bug this caught: each patch computes its carried fields from the entry it is
  // handed, so a later patch replacing an earlier one reads a disk entry that does not
  // have the earlier change in it. Open a project, then autosave — 400ms apart at most,
  // so this is the common case — and `lastOpenedAt` went back to being reset by a save.
  const { s } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.markOpened('p1', 5000);
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: bundle() });
  await s.flushCatalog();
  const [entry] = await s.list();
  assert.equal(entry.lastOpenedAt, 5000, 'the stamp survived the save that followed it');
  assert.equal(entry.savedAt, 2000);
});

test('composition holds across a flush boundary too', async () => {
  const { s } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.markOpened('p1', 5000);
  await s.flushCatalog();
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: bundle() });
  await s.flushCatalog();
  assert.equal((await s.list())[0].lastOpenedAt, 5000);
});

test('a flush applies patches to what is on disk NOW, not to a snapshot', async () => {
  // Why a pending change is a function rather than a finished entry: two tabs. Another
  // writer's entry must survive this one's flush.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: bundle() }); // pending
  // Something else adds a project between the patch and the flush.
  const cat = catalog(d);
  cat.entries.push({ id: 'other', name: 'Another tab', savedAt: 1500 });
  d.files.set('projects/catalog.json', new TextEncoder().encode(JSON.stringify(cat)));
  await s.flushCatalog();
  const ids = catalog(d).entries.map((e) => e.id).sort();
  assert.deepEqual(ids, ['other', 'p1'], 'the other tab’s entry was not clobbered');
});

test('a patch declining does not stop a later one', async () => {
  // `markOpened` on a project with no entry returns null — it must leave the entry alone
  // rather than writing a half-built one, and must not block a save from creating it.
  const { s } = store();
  await s.markOpened('ghost', 5000);
  await s.save({ id: 'ghost', name: 'Later', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  const [entry] = await s.list();
  assert.equal(entry.name, 'Later');
  assert.equal(entry.lastOpenedAt, undefined, 'the stamp had nothing to attach to');
});

test('a pending patch recorded DURING a flush is not swallowed', async () => {
  // The flush takes the batch before it awaits, so anything recorded while it is writing
  // stays pending for the next one rather than being cleared unwritten.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  const writing = s.flushCatalog();
  await s.markOpened('p1', 7000);
  await writing;
  await s.flushCatalog();
  assert.equal(catalog(d).entries[0].lastOpenedAt, 7000);
});

// =============================================================================
// 3. What cannot wait does not
// =============================================================================

test('a rename is on disk before it returns', async () => {
  // A deliberate act the user is watching for: seeing the old name come back after a
  // crash would read as the rename not having worked.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Old', savedAt: 1000, bundle: bundle() });
  const before = d.catalogWrites();
  await s.rename('p1', 'New');
  assert.equal(d.catalogWrites(), before + 1);
  assert.equal(catalog(d).entries[0].name, 'New');
});

test('a delete is on disk before it returns', async () => {
  // Until it lands the catalog names a project that cannot be opened.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.save({ id: 'p2', name: 'Other', savedAt: 1001, bundle: bundle() });
  await s.delete('p1');
  assert.deepEqual(catalog(d).entries.map((e) => e.id), ['p2']);
});

test('a project deleted while a save of it was pending stays deleted', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: bundle() }); // pending
  await s.delete('p1');
  await s.flushCatalog();
  assert.deepEqual(catalog(d).entries, []);
  assert.deepEqual(await s.list(), []);
});

test('a project re-created after a pending delete is built from nothing', async () => {
  // The composed patch must not carry the dead entry's fields into the new one.
  const { s } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.markOpened('p1', 5000);
  await s.flushCatalog();
  await s.delete('p1');
  await s.save({ id: 'p1', name: 'Reborn', savedAt: 3000, bundle: bundle() });
  await s.flushCatalog();
  const [entry] = await s.list();
  assert.equal(entry.name, 'Reborn');
  assert.equal(entry.lastOpenedAt, undefined, 'the old stamp did not come back');
});

// =============================================================================
// Self-healing, which is what makes a lost update survivable
// =============================================================================

test('listing drops an entry whose folder has gone, and writes nothing to do it', async () => {
  // The existing sweep, now expressed as a pending removal — so listing a busy index
  // costs no write at all, and every catalog write goes through one path.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.save({ id: 'p2', name: 'Other', savedAt: 1001, bundle: bundle() });
  await s.flushCatalog();
  await d.removeTree('projects/p1');
  const before = d.catalogWrites();
  const listed = await s.list();
  assert.deepEqual(listed.map((e) => e.id), ['p2']);
  assert.equal(d.catalogWrites(), before, 'the listing itself wrote nothing');
  await s.flushCatalog();
  assert.deepEqual(catalog(d).entries.map((e) => e.id), ['p2'], 'and the sweep landed');
});

test('a failed flush keeps its patches for the next attempt', async () => {
  // The catalog is derived from projects already safely on disk, so a flush that cannot
  // write must not throw into the save that scheduled it — but it must not drop the
  // update either, or the index silently stops tracking the project.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  const realWrite = d.write.bind(d);
  d.write = async (path, bytes) => {
    if (path === 'projects/catalog.json') throw new Error('disk full');
    return realWrite(path, bytes);
  };
  await s.save({ id: 'p1', name: 'Study', savedAt: 2000, bundle: bundle() });
  await s.flushCatalog(); // must not throw
  assert.equal(catalog(d).entries[0].savedAt, 1000, 'the failed write changed nothing');
  d.write = realWrite;
  await s.flushCatalog();
  assert.equal(catalog(d).entries[0].savedAt, 2000, 'and the retry carried it');
});

// =============================================================================
// The summary itself
// =============================================================================

test('save and refreshSummary build the SAME summary', async () => {
  // They had a copy each and had already drifted: one wrote
  // `activePlugins: manifest.activePlugins`, the other `?? null`, so whether a
  // project's plugin list read as absent or as empty depended on which path last ran.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../core/project-store.js', import.meta.url), 'utf8',
  );
  const uses = [...src.matchAll(/#summaryFor\(/g)].length;
  // One definition and every caller: save, refreshSummary, the load-time reconcile and
  // the recovery of a folder the catalog had no record of.
  assert.equal(uses, 5, 'one definition and four callers');
  assert.doesNotMatch(src, /activePlugins: manifest\.activePlugins,/,
    'the un-defaulted copy is gone');
});

// =============================================================================
// The catalog is a CACHE: the folders are the truth about what exists
// =============================================================================
// Both hardenings close holes where the index was authoritative over data that can
// perfectly well speak for itself, and both answer the same question: what survives a
// power cut between a change being recorded and the flush that writes it.

/** Wipe the catalog the way a torn write or a lost disk would. */
const loseCatalog = (d) => d.files.delete('projects/catalog.json');

/**
 * Change a project's manifest WITHOUT going through `save()`, leaving the catalog behind
 * — a manifest newer than the index.
 *
 * Not a contrived state: it is what a power cut between a save and its flush leaves, and
 * equally what a folder sync or a peer delivers, since neither of those goes through this
 * machine's `save()` either.
 */
function driftManifest(d, id, patch) {
  const path = `projects/${id}/project.json`;
  const m = JSON.parse(new TextDecoder().decode(d.files.get(path)));
  d.files.set(path, new TextEncoder().encode(JSON.stringify({ ...m, ...patch })));
}

test('a project whose catalog entry is gone is still listed', async () => {
  // The hole: `list()` intersected the catalog with the folders present, so an entry
  // lost to a torn write — or arriving from another machine — meant a project that
  // exists on disk and cannot be seen or opened.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  loseCatalog(d);

  const listed = await s.list();
  assert.deepEqual(listed.map((e) => e.name), ['Study']);
  assert.equal(listed[0].savedAt, 1000, 'rebuilt from the project’s own manifest');
  assert.equal(listed[0].id, 'p1');
});

test('losing the whole catalog loses ordering metadata, not access', async () => {
  // The catastrophic version: `#readCatalog` degrades a corrupt file to `{entries: []}`,
  // which used to hide EVERY project at once.
  const { s, d } = store();
  for (let i = 0; i < 5; i += 1) {
    await s.save({ id: `p${i}`, name: `Study ${i}`, savedAt: 1000 + i, bundle: bundle() });
  }
  await s.flushCatalog();
  await s.markOpened('p2', 9999);
  await s.flushCatalog();
  d.files.set('projects/catalog.json', new TextEncoder().encode('{ this is not json'));

  const listed = await s.list();
  assert.equal(listed.length, 5, 'every project is back');
  assert.deepEqual(listed.map((e) => e.name).sort(),
    ['Study 0', 'Study 1', 'Study 2', 'Study 3', 'Study 4']);
  // What is genuinely unrecoverable is the one field that only ever lived here.
  assert.equal(listed.find((e) => e.id === 'p2').lastOpenedAt, undefined,
    'lastOpenedAt is a fact about this device, and is honestly absent');
});

test('recovery is written back, so it happens once', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  loseCatalog(d);
  await s.list();
  await s.flushCatalog();
  const reads = d.reads.get('projects/p1/project.json') ?? 0;
  await s.list();
  assert.equal(d.reads.get('projects/p1/project.json') ?? 0, reads,
    'the second listing reads no manifests');
});

test('a stray directory does not become a phantom project', async () => {
  // Recovery must not turn everything under `projects/` into a row.
  const { s, d } = store();
  await s.save({ id: 'c7e1f3a2-0b4d-4e5f-8a9b-1c2d3e4f5a6b', name: 'Real', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  loseCatalog(d);
  d.files.set('projects/.DS_Store', new Uint8Array([1, 2, 3]));
  d.files.set('projects/notes/readme.txt', new TextEncoder().encode('hello'));
  const listed = await s.list();
  assert.deepEqual(listed.map((e) => e.name), ['Real']);
});

test('a folder with no manifest is not a project', async () => {
  const { s, d } = store();
  d.files.set('projects/c7e1f3a2-0b4d-4e5f-8a9b-1c2d3e4f5a6b/src_1.parquet', new Uint8Array([1]));
  assert.deepEqual(await s.list(), []);
});

test('a locked project is listed as locked rather than hidden', async () => {
  // For a protected project the catalog was the only place the name lived in the clear,
  // so the name is genuinely unknowable here. Being unable to NAME a project is far
  // better than being unable to FIND it: opening it prompts for the passphrase.
  const { s, d } = store();
  const id = 'c7e1f3a2-0b4d-4e5f-8a9b-1c2d3e4f5a6b';
  // The real magic, not four bytes typed from memory — wrong ones would make this
  // assert nothing. Padded past the IV length so `isEnveloped` accepts it.
  const env = new Uint8Array(32);
  env.set(MAGIC, 0);
  d.files.set(`projects/${id}/project.json`, env);
  const [entry] = await s.list();
  assert.equal(entry.id, id);
  assert.equal(entry.encrypted, true);
  assert.equal(entry.name, null, 'and it does not invent one');
});

// =============================================================================
// A stale entry repairs itself when the project is opened
// =============================================================================

test('opening a project reconciles a stale catalog entry', async () => {
  // The question this answers: a project whose entry is stale, opened only to READ its
  // output and never edited. Nothing triggers a save, so without this the entry stayed
  // stale indefinitely.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  driftManifest(d, 'p1', { name: 'Renamed in the manifest', savedAt: 7000 });
  assert.equal(catalog(d).entries[0].savedAt, 1000, 'the index is stale');

  await s.load('p1');          // just looking; no edit, no save
  await s.flushCatalog();
  assert.equal(catalog(d).entries[0].savedAt, 7000, 'opening it was enough');
  assert.equal(catalog(d).entries[0].name, 'Renamed in the manifest');
});

test('opening a project is not a save — the manifest is untouched', async () => {
  // The remedy must not be "trigger a save": that would write a new `savedAt` for an
  // edit that never happened, which is a lie in the log and in the History panel.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  driftManifest(d, 'p1', { savedAt: 7000 });
  const before = d.writes.get('projects/p1/project.json') ?? 0;
  await s.load('p1');
  await s.flushCatalog();
  assert.equal(d.writes.get('projects/p1/project.json') ?? 0, before,
    'the project’s own bytes were not rewritten');
  assert.equal(catalog(d).entries[0].savedAt, 7000, 'only the index moved');
});

test('opening a project whose entry already agrees writes nothing', async () => {
  // The common case has to stay free, or every open would cost a catalog write.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  const before = d.catalogWrites();
  await s.load('p1');
  await s.flushCatalog();
  assert.equal(d.catalogWrites(), before, 'nothing drifted, so nothing was written');
});

test('the reconcile keeps lastOpenedAt, which no manifest knows', async () => {
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.markOpened('p1', 5000);
  await s.flushCatalog();
  driftManifest(d, 'p1', { savedAt: 7000 });
  await s.load('p1');
  await s.flushCatalog();
  assert.equal(catalog(d).entries[0].lastOpenedAt, 5000);
  assert.equal(catalog(d).entries[0].savedAt, 7000);
});

test('a load never fails because the index could not be tidied', async () => {
  // Housekeeping on a browse index must not stand between the user and their project.
  const { s, d } = store();
  await s.save({ id: 'p1', name: 'Study', savedAt: 1000, bundle: bundle() });
  await s.flushCatalog();
  driftManifest(d, 'p1', { savedAt: 7000 });
  const realWrite = d.write.bind(d);
  d.write = async (path, bytes) => {
    if (path === 'projects/catalog.json') throw new Error('disk full');
    return realWrite(path, bytes);
  };
  const loaded = await s.load('p1');   // must not throw
  assert.equal(loaded.name, 'Study');
  d.write = realWrite;
});
