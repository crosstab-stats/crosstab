/**
 * @file key-epoch.test.mjs
 * A shared folder's key can change under a peer that is already connected (#144).
 *
 * The failure this guards is silent: the peer keeps the key it derived at open, so its
 * next save re-encrypts with a key nobody else has (after an unprotect) or it cannot
 * read the new files (after a protect/rekey) — and it happens exactly when the data's
 * confidentiality is what is being changed. `keyStatus` is how a peer notices before it
 * writes, so these tests pin each direction of the change.
 *
 * Driven through an in-memory storage driver: real crypto, no filesystem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { ProjectStore } = await import('../core/project-store.js');

/** An in-memory driver — the seam ProjectStore already takes (core/storage-driver.js). */
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

/** A store sharing one folder's bytes — i.e. one peer's view of a shared folder. */
function peerOn(files) {
  const s = new ProjectStore();
  s.useDriver(memDriver(files), { flat: true });
  return s;
}

test('a key derived against the current meta reads as current', async () => {
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('correct horse');
  const status = await owner.keyStatus();
  assert.deepEqual(status, { current: true, reason: 'ok' });
});

test('THE BUG: a peer that opened before a REKEY must not be told it is fine', async () => {
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('first passphrase');

  // A second peer opens the same folder with the same passphrase — same epoch.
  const peer = peerOn(files);
  await peer.unlock('first passphrase');
  assert.equal((await peer.keyStatus()).current, true, 'in step to begin with');

  // The owner rekeys: protection off, then on with a new passphrase (the only rekey
  // path the UI offers today).
  await owner.removeEncryption();
  await owner.unlock('second passphrase');

  const status = await peer.keyStatus();
  assert.equal(status.current, false, 'the connected peer must NOT keep writing');
  assert.equal(status.reason, 'rekeyed');
});

test('protection REMOVED under a connected peer is caught', async () => {
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('shared secret');
  const peer = peerOn(files);
  await peer.unlock('shared secret');

  await owner.removeEncryption(); // meta deleted; folder is plaintext now

  const status = await peer.keyStatus();
  assert.equal(status.current, false, 'the peer would otherwise write ciphertext into a plaintext folder');
  assert.equal(status.reason, 'unprotected');
});

test('protection ADDED under a peer holding no key is caught', async () => {
  const files = new Map();
  const plain = peerOn(files); // opened an unprotected folder — no key at all
  assert.equal((await plain.keyStatus()).current, true, 'plaintext folder, no key: fine');

  const owner = peerOn(files);
  await owner.unlock('newly protected');

  const status = await plain.keyStatus();
  assert.equal(status.current, false, 'the peer would otherwise write plaintext into a protected folder');
  assert.equal(status.reason, 'protected');
});

test('an unprotected folder with no key stays current — no false alarms', async () => {
  const store = peerOn(new Map());
  assert.deepEqual(await store.keyStatus(), { current: true, reason: 'ok' });
});

test('re-unlocking after a rekey brings the peer back in step', async () => {
  // The recovery path the UI offers: reopen the folder, re-enter the passphrase.
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('one');
  const peer = peerOn(files);
  await peer.unlock('one');

  await owner.removeEncryption();
  await owner.unlock('two');
  assert.equal((await peer.keyStatus()).current, false);

  await peer.unlock('two');
  assert.deepEqual(await peer.keyStatus(), { current: true, reason: 'ok' });
});

test('meta written before epochs existed does not false-alarm', async () => {
  // A folder protected by an older build has no `epoch`. Both sides then read null,
  // which compares equal — an upgrade must not present itself as a rekey.
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('legacy');
  const metaPath = [...files.keys()].find((k) => k.includes('encryption'));
  const meta = JSON.parse(new TextDecoder().decode(files.get(metaPath)));
  delete meta.epoch;
  files.set(metaPath, new TextEncoder().encode(JSON.stringify(meta)));

  const peer = peerOn(files);
  await peer.unlock('legacy');
  assert.deepEqual(await peer.keyStatus(), { current: true, reason: 'ok' });
});
