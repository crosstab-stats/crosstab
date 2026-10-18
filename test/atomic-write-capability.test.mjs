/**
 * @file atomic-write-capability.test.mjs
 * `atomicWrite` reports what the engine was seen to do, not what the design intends.
 *
 * The handle drivers declared `atomicWrite: true` outright, on the strength of
 * temp-then-rename. Then WebKit turned out to EXPOSE `move()` while implementing only
 * the two-argument form, so `renameOver` grew a fallback that writes in place — which is
 * what makes saving work on an iPhone at all, and which also made the guarantee
 * conditional while the flag stayed absolute.
 *
 * It was latent rather than broken: four drivers declared it, four tests asserted it,
 * and nothing in production read it. That is precisely why it was worth fixing before a
 * reader arrived — the obvious first reader is folder-sync, whose peer-safety argument
 * is *"the write is atomic, so a peer polling `project.json` mid-write never reads a
 * torn file."* On an engine taking the fallback, that sentence is false, and the failure
 * it produces is a peer reading half a manifest.
 *
 * These drive a fake File System Access handle, so the WebKit shape is reproduced rather
 * than described: a `move()` that exists and throws `TypeError` for the one-argument
 * call, exactly as iOS does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OpfsDriver, FsaFolderDriver } from '../core/storage-driver.js';

/**
 * A directory handle good enough to write into.
 *
 * @param {'chromium'|'webkit'|'none'|'nameOnly'} engine how `move()` behaves:
 *   - `chromium` — the one-argument `move(name)` works;
 *   - `webkit` — the short form throws `TypeError`, the spec's `move(dir, name)` works.
 *     This is REAL iOS, and the point of including it is that atomicity survives:
 *     `renameOver` tries the long form second and the rename happens. The original bug
 *     was the crash ("Not enough arguments"), not a loss of atomicity;
 *   - `none` — no `move` at all;
 *   - `nameOnly` — `move` exists and BOTH forms throw `TypeError`. The case the
 *     capability has to tell the truth about, and the one an existence check cannot see.
 */
function fakeDir(engine) {
  const files = new Map();
  const mk = (name) => ({
    name,
    async createWritable() {
      let buf = null;
      return {
        async write(b) { buf = b; },
        async close() { files.set(name, buf); },
      };
    },
    async getFile() {
      const bytes = files.get(name) ?? new Uint8Array();
      return {
        arrayBuffer: async () => bytes.buffer,
        // The in-place fallback streams the temp file into the target, so the fake has
        // to offer a stream as well as a buffer.
        stream: () => ({ async pipeTo(w) { await w.write(bytes); await w.close(); } }),
      };
    },
    ...(engine === 'none' ? {} : {
      async move(a, b) {
        if (engine === 'nameOnly') throw new TypeError('Not enough arguments');
        if (engine === 'webkit' && b === undefined) throw new TypeError('Not enough arguments');
        const to = b === undefined ? a : b;
        files.set(to, files.get(name));
        files.delete(name);
        return undefined;
      },
    }),
  });
  const dir = {
    async getDirectoryHandle() { return dir; },
    async getFileHandle(name) { return mk(name); },
    async removeEntry(name) { files.delete(name); },
    files,
  };
  return dir;
}

const driverOn = (engine) => new FsaFolderDriver(fakeDir(engine));

test('before any write, the claim is optimistic — and says it is unproven', () => {
  // Answering `false` on a Chromium driver that simply has not written yet would be its
  // own lie. What matters is that the driver can say which it is.
  const d = driverOn('chromium');
  assert.equal(d.capabilities.atomicWrite, true);
  assert.equal(d.atomicityKnown, false, 'nothing has been attempted yet');
});

test('an engine that renames keeps the claim, and now it is evidence', async () => {
  const d = driverOn('chromium');
  await d.write('a/project.json', new Uint8Array([1, 2, 3]));
  assert.equal(d.atomicityKnown, true);
  assert.equal(d.capabilities.atomicWrite, true);
});

test('WebKit KEEPS the claim — its long-form move works', async () => {
  // Worth pinning because it is easy to get backwards (I did). iOS throws on the
  // one-argument `move(name)`, which is what used to crash the save — but it implements
  // the spec's `move(dir, name)`, so `renameOver` succeeds on its second attempt and the
  // write really is atomic. The bug was the crash, not a lost guarantee.
  const d = driverOn('webkit');
  await d.write('a/project.json', new Uint8Array([1, 2, 3]));
  assert.equal(d.capabilities.atomicWrite, true);
  assert.equal(d.atomicityKnown, true);
});

test('a move that exists in name only DOWNGRADES the claim', async () => {
  // The case the capability exists to tell the truth about: `move` is present, so no
  // existence check catches it, and both forms throw — so the driver writes in place and
  // temp-then-rename never happened.
  const d = driverOn('nameOnly');
  assert.equal(d.capabilities.atomicWrite, true, 'optimistic until it has tried');
  await d.write('a/project.json', new Uint8Array([1, 2, 3]));
  assert.equal(d.capabilities.atomicWrite, false,
    'the guarantee was not kept, so it must stop being claimed');
  assert.equal(d.atomicityKnown, true);
});

test('an engine with no move at all downgrades too', async () => {
  const d = driverOn('none');
  await d.write('a/x.json', new Uint8Array([1]));
  assert.equal(d.capabilities.atomicWrite, false);
});

test('the bytes land either way — the fallback is a real write, not a failure', async () => {
  for (const engine of ['chromium', 'webkit', 'none', 'nameOnly']) {
    const dir = fakeDir(engine);
    const d = new FsaFolderDriver(dir);
    await d.write('project.json', new Uint8Array([7, 8, 9]));
    assert.deepEqual([...(dir.files.get('project.json') ?? [])], [7, 8, 9], engine);
    assert.ok(!dir.files.has('project.json.tmp'), `${engine}: left a temp file behind`);
  }
});

test('writeStream teaches the driver too', async () => {
  // Both paths rename and both find out. If only `write` recorded it, a session whose
  // saves go through the streaming path would never learn, and would keep claiming an
  // atomicity it is not keeping — which is the same bug in a quieter place.
  const d = driverOn('nameOnly');
  const blob = { stream: () => ({ async pipeTo(w) { await w.write(new Uint8Array([1])); await w.close(); } }) };
  await d.writeStream('a/b.parquet', blob);
  assert.equal(d.atomicityKnown, true, 'a streamed write must record what rename did');
  assert.equal(d.capabilities.atomicWrite, false);
});

test('OPFS reports the same way, and keeps its other capabilities', () => {
  const d = new OpfsDriver();
  const caps = d.capabilities;
  assert.equal(caps.atomicWrite, d.renamesAtomically);
  assert.equal(caps.flat, false);
  assert.equal(caps.sharedRoot, true, 'every ProjectStore in the tab writes one catalog');
  assert.equal(caps.canStream, true);
});

test('the claim is never hard-coded true in a handle driver any more', () => {
  // The regression that would re-break it is someone restoring the literal.
  const src = readFileSync('core/storage-driver.js', 'utf8');
  const handleCaps = src.slice(src.indexOf('class HandleDriver'));
  assert.doesNotMatch(handleCaps, /atomicWrite: true/,
    'a handle driver must derive this from what it observed');
});
