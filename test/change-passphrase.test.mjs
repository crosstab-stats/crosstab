/**
 * @file change-passphrase.test.mjs
 * Changing a protected project's passphrase in ONE step (#144).
 *
 * Why it needed to exist: the only rekey the app offered was unprotect-then-protect,
 * which writes every file back to disk IN THE CLEAR in between. On a synced folder those
 * plaintext bytes reach the cloud — the operation whose whole purpose is to improve
 * confidentiality briefly destroyed it.
 *
 * Crash safety is the substance of the design, so most of what is pinned here is what
 * survives an interruption. The caller rewrites every file after `changePassphrase`
 * returns, and that cannot be atomic on any driver we have, so the meta describes BOTH
 * keyings for the duration and either passphrase opens the folder until it is finished.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { ProjectStore } = await import('../core/project-store.js');

function memDriver(files = new Map()) {
  return {
    files,
    async read(path) { return files.get(path) ?? null; },
    async write(path, bytes) { files.set(path, bytes); },
    async remove(path) { files.delete(path); },
    async list() { return [...files.keys()]; },
    async mkdirp() {},
    get flat() { return true; },
  };
}

function peerOn(files) {
  const s = new ProjectStore();
  s.useDriver(memDriver(files), { flat: true });
  return s;
}

const META = 'crosstab-encryption.json';
const metaOf = (files) => JSON.parse(new TextDecoder().decode(files.get(META)));

/** A protected folder holding one saved project. */
async function protectedFolder(pass = 'first passphrase') {
  const files = new Map();
  const store = peerOn(files);
  await store.unlock(pass, 'p');
  await store.save({ id: 'p', name: 'P', savedAt: 1, bundle: { log: [{ id: 'op1' }] } });
  return { files, store };
}

test('the new passphrase opens the project and the old one no longer does', async () => {
  const { files, store } = await protectedFolder();
  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  await store.save({ id: 'p', name: 'P', savedAt: 2, bundle: { log: [{ id: 'op1' }] } });
  await store.finishRekey('p');

  const fresh = peerOn(files);
  await fresh.unlock('second passphrase', 'p');
  assert.ok(await fresh.readManifest('p'), 'the new passphrase reads the project');

  const stale = peerOn(files);
  await assert.rejects(() => stale.unlock('first passphrase', 'p'), /Wrong passphrase/,
    'the old passphrase is genuinely retired once the rekey completes');
});

test('THE POINT: nothing is ever written in the clear', async () => {
  // What unprotect-then-protect could not promise. Every file stays enveloped from
  // start to finish — there is no moment a plaintext project.json exists on disk.
  const { files, store } = await protectedFolder();
  const enveloped = (b) => b && b.length > 4 && b[0] === 0x43 && b[1] === 0x54 && b[2] === 0x45;
  assert.ok(enveloped(files.get('project.json')), 'protected to begin with');

  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  assert.ok(enveloped(files.get('project.json')), 'still enveloped mid-rekey');
  await store.save({ id: 'p', name: 'P', savedAt: 2, bundle: { log: [{ id: 'op1' }] } });
  assert.ok(enveloped(files.get('project.json')), 'still enveloped after the rewrite');
  await store.finishRekey('p');
  assert.ok(enveloped(files.get('project.json')), 'and after the commit');
});

test('the wrong current passphrase is refused before anything changes', async () => {
  const { files, store } = await protectedFolder();
  const before = new Uint8Array(files.get(META));
  await assert.rejects(() => store.changePassphrase('not it', 'second passphrase', 'p'),
    /isn.t the current passphrase/);
  assert.deepEqual(files.get(META), before, 'the meta is untouched by a failed attempt');
});

// --- interrupted mid-rewrite ---------------------------------------------------------

test('an interrupted rekey still opens with EITHER passphrase', async () => {
  // The tab closed between the meta write and the rewrite finishing. Files carry a mix
  // of the two keys; being locked out of your own folder because of that would be the
  // worst possible outcome of a security operation.
  const { files, store } = await protectedFolder();
  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  // …and now nothing rewrites. project.json is still under the OLD key.

  const withNew = peerOn(files);
  await assert.doesNotReject(() => withNew.unlock('second passphrase', 'p'));
  const withOld = peerOn(files);
  await assert.doesNotReject(() => withOld.unlock('first passphrase', 'p'),
    'the previous passphrase is still honoured while the rekey is unfinished');
});

test('…and the old key still READS the files that were not rewritten', async () => {
  const { files, store } = await protectedFolder();
  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  // The store holds both keys, so an un-rewritten file is still readable.
  const m = await store.readManifest('p');
  assert.ok(m, 'old-key file read through the fallback');
  assert.equal(m.name, 'P');

  // A peer that only knows the OLD passphrase can read it too.
  const old = peerOn(files);
  await old.unlock('first passphrase', 'p');
  assert.ok(await old.readManifest('p'));
});

test('the unfinished state is visible, and clears when the rekey completes', async () => {
  const { files, store } = await protectedFolder();
  assert.equal(store.rekeyPending, false);

  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  assert.equal(store.rekeyPending, true);
  assert.ok(metaOf(files).prev, 'the meta records the previous keying');

  // It survives a reload — the state is on disk, not in memory.
  const reloaded = peerOn(files);
  await reloaded.unlock('second passphrase', 'p');
  assert.equal(reloaded.rekeyPending, true);

  await store.save({ id: 'p', name: 'P', savedAt: 2, bundle: { log: [{ id: 'op1' }] } });
  await store.finishRekey('p');
  assert.equal(store.rekeyPending, false);
  assert.equal(metaOf(files).prev, undefined, 'the previous keying is dropped');
});

test('finishing twice is harmless', async () => {
  const { store } = await protectedFolder();
  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  await store.finishRekey('p');
  await assert.doesNotReject(() => store.finishRekey('p'));
});

// --- what peers see ------------------------------------------------------------------

test('a rekey bumps the epoch, so connected peers detect it with no extra signalling', async () => {
  const { files, store } = await protectedFolder();
  const before = metaOf(files).epoch;

  // A peer connected under the old key.
  const peer = peerOn(files);
  await peer.unlock('first passphrase', 'p');
  assert.deepEqual(await peer.keyStatus('p'), { current: true, reason: 'ok' });

  await store.changePassphrase('first passphrase', 'second passphrase', 'p');
  assert.notEqual(metaOf(files).epoch, before, 'a new keying is a new epoch');

  const st = await peer.keyStatus('p');
  assert.equal(st.current, false);
  assert.equal(st.reason, 'rekeyed', 'the peer halts through the ordinary path');
});

test('changing the passphrase of an unprotected project is refused, not silently ignored', async () => {
  const store = peerOn(new Map());
  await assert.rejects(() => store.changePassphrase('a', 'b', 'p'), /isn.t protected/);
});

test('an empty new passphrase is refused', async () => {
  const { store } = await protectedFolder();
  await assert.rejects(() => store.changePassphrase('first passphrase', '', 'p'), /empty/);
});
