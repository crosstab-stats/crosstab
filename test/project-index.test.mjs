/**
 * @file project-index.test.mjs
 * "Recent" has to survive a save (#171).
 *
 * `lastOpenedAt` is a fact about this DEVICE, not about the project, so it is not in the
 * manifest and never will be. But both catalog writers rebuild their summary from the
 * manifest, which means anything not carried across explicitly is destroyed on every
 * save. That is the trap this file exists for: the failure would be invisible — the list
 * still renders, still sorts, and simply stops reflecting what you last opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../core/project-store.js';

/** An in-memory driver: paths to bytes, and nothing else. */
function memoryDriver() {
  const files = new Map();
  const enc = new TextEncoder();
  return {
    kind: 'memory',
    capabilities: { flat: false, externallySynced: false, atomicWrite: true, canStream: true },
    get available() { return true; },
    files,
    async read(path) { return files.get(path) ?? null; },
    async write(path, bytes) { files.set(path, bytes instanceof Uint8Array ? bytes : enc.encode(String(bytes))); },
    async writeStream(path, blob) { files.set(path, new Uint8Array(await blob.arrayBuffer())); },
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

/** The smallest bundle `save` will accept. */
const bundle = () => ({ log: [], datasets: [], activePlugins: [] });

function store() {
  const s = new ProjectStore();
  s.useDriver(memoryDriver(), { flat: false });
  return s;
}

test('a project saves and lists', async () => {
  const s = store();
  await s.save({ id: 'p1', name: 'My study', savedAt: 1000, bundle: bundle() });
  const [entry] = await s.list();
  assert.equal(entry.id, 'p1');
  assert.equal(entry.name, 'My study');
  assert.equal(entry.savedAt, 1000);
});

test('markOpened records when a project was last opened', async () => {
  const s = store();
  await s.save({ id: 'p1', name: 'My study', savedAt: 1000, bundle: bundle() });
  await s.markOpened('p1', 5000);
  const [entry] = await s.list();
  assert.equal(entry.lastOpenedAt, 5000);
  assert.equal(entry.savedAt, 1000, 'opening is not saving');
});

test('a save PRESERVES lastOpenedAt — the whole point of this file', async () => {
  // Both catalog writers rebuild the summary from the manifest. Without the carry-across,
  // the first autosave after opening a project would silently reset it, and "recent"
  // would quietly mean "recently saved" again.
  const s = store();
  await s.save({ id: 'p1', name: 'My study', savedAt: 1000, bundle: bundle() });
  await s.markOpened('p1', 5000);
  await s.save({ id: 'p1', name: 'My study', savedAt: 2000, bundle: bundle() });
  const [entry] = await s.list();
  assert.equal(entry.lastOpenedAt, 5000, 'survived the save');
  assert.equal(entry.savedAt, 2000, 'and the save still updated its own field');
});

test('a project never opened simply has no stamp', async () => {
  // Absence is meaningful: the merged index falls back to savedAt, so a project from
  // before this existed still sorts sensibly instead of sinking to the bottom.
  const s = store();
  await s.save({ id: 'p1', name: 'My study', savedAt: 1000, bundle: bundle() });
  const [entry] = await s.list();
  assert.equal(entry.lastOpenedAt, undefined);
});

test('marking an unknown project is a no-op, not an error', async () => {
  // Opening something never saved is ordinary — there is no catalog row to stamp yet.
  const s = store();
  await s.markOpened('nope', 5000);
  assert.deepEqual(await s.list(), []);
});

test('deleting a project takes its catalog entry and its files', async () => {
  const s = store();
  await s.save({ id: 'p1', name: 'One', savedAt: 1000, bundle: bundle() });
  await s.save({ id: 'p2', name: 'Two', savedAt: 2000, bundle: bundle() });
  await s.delete('p1');
  const left = await s.list();
  assert.deepEqual(left.map((e) => e.id), ['p2']);
});

test('two projects list most-recently-saved first', async () => {
  const s = store();
  await s.save({ id: 'old', name: 'Old', savedAt: 1000, bundle: bundle() });
  await s.save({ id: 'new', name: 'New', savedAt: 9000, bundle: bundle() });
  assert.deepEqual((await s.list()).map((e) => e.id), ['new', 'old']);
});
