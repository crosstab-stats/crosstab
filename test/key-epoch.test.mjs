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

// --- failing CLOSED: the rekey window ------------------------------------------------
//
// The three tests below cover one concrete data-loss path, found 2026-08-10 while
// building the live-peer rekey story. A rekey rewrites `crosstab-encryption.json` and
// then re-encrypts every other file, so a peer polling mid-rewrite can read a truncated
// meta. Every link in that chain used to fail OPEN:
//
//   truncated meta -> keyStatus said "ok"      -> the guard let the write through
//   -> readManifest could not decrypt          -> returned null, meaning "absent"
//   -> decideSync mapped null to "seed"        -> peer overwrote the owner's project,
//                                                 encrypted with the stale key.
//
// The owner's data replaced, by a peer, with something the owner cannot open.

test('a meta that exists but will not parse is NOT reported as ok', async () => {
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('correct horse', 'p');
  await owner.save({ id: 'p', name: 'P', savedAt: 1, bundle: { log: [] } });

  // What a poll sees mid-rewrite: the file is there, half-written.
  files.set('crosstab-encryption.json', new TextEncoder().encode('{"v":1,"sal'));
  const st = await owner.keyStatus('p');
  assert.equal(st.current, false, 'unknown must not read as current');
  assert.equal(st.reason, 'unreadable');
});

test('readManifest tells ABSENT apart from UNREADABLE', async () => {
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('correct horse', 'p');
  await owner.save({ id: 'p', name: 'P', savedAt: 1, bundle: { log: [] } });

  // Absent → null. This is the one case where seeding is the right answer.
  const empty = peerOn(new Map());
  assert.equal(await empty.readManifest('p'), null);

  // Present but not decryptable → throws, so no caller can mistake it for absence.
  const stale = peerOn(files);
  await assert.rejects(() => stale.readManifest('p'), /encrypted|decrypt|passphrase/i,
    'a peer with no key must not be told the project is missing');
});

test('a stale-keyed peer cannot seed over the owner’s project', async () => {
  const { syncFolderProject } = await import('../core/folder-sync.js');
  const files = new Map();
  const owner = peerOn(files);
  await owner.unlock('correct horse', 'p');
  await owner.save({ id: 'p', name: 'Owner project', savedAt: 1, bundle: { log: [] } });
  const ownerBytes = files.get('project.json');

  // A peer holding no key at all — the same position a rekeyed-out peer is in.
  const peer = peerOn(files);
  const res = await syncFolderProject({
    store: peer, id: 'p', name: 'Peer project', bundle: { log: [] },
  });

  assert.equal(res.action, 'blocked', 'refused rather than seeding');
  assert.match(res.reason, /could not be read/);
  assert.deepEqual(files.get('project.json'), ownerBytes,
    "the owner's ciphertext is byte-identical — nothing was written over it");
});

// --- the halt POLICY -----------------------------------------------------------------
//
// What `keyStatus` reports is one thing; what the session DOES about it is another, and
// that half lived untested inside a private method until 2026-08-10. It is
// safety-critical — it is what stops a peer writing files its collaborators cannot read.

const { keyHaltDecision, UNREADABLE_TOLERANCE } = await import('../core/project-sync.js');

test('a current key just continues', () => {
  assert.equal(keyHaltDecision({ current: true, reason: 'ok' }).action, 'continue');
});

test('every definite change halts immediately — no grace period', () => {
  // These are not ambiguous: the folder demonstrably is not using our key. Waiting would
  // only widen the window in which we might write something unreadable.
  for (const reason of ['rekeyed', 'unprotected', 'protected']) {
    const d = keyHaltDecision({ current: false, reason });
    assert.equal(d.action, 'halt', reason);
    assert.match(d.reason, /\w/, 'and says which change it was');
  }
});

test('an unreadable meta is TOLERATED at first — a rekey rewrites that file', () => {
  // Halting on the first glimpse would make every rekey a session-ending event for
  // every peer, because the owner necessarily rewrites this file mid-operation.
  for (let n = 0; n < UNREADABLE_TOLERANCE; n++) {
    assert.equal(keyHaltDecision({ current: false, reason: 'unreadable' }, n).action, 'skip', `run ${n}`);
  }
});

test('…but the patience is BOUNDED — silently never saving is its own data loss', () => {
  const d = keyHaltDecision({ current: false, reason: 'unreadable' }, UNREADABLE_TOLERANCE);
  assert.equal(d.action, 'halt');
  assert.match(d.reason, /could not be read/);
});

test('skipping is not halting — the poll must keep running to notice recovery', () => {
  const d = keyHaltDecision({ current: false, reason: 'unreadable' }, 1);
  assert.equal(d.action, 'skip');
  assert.notEqual(d.action, 'halt');
});

test('an unrecognised reason halts rather than continuing', () => {
  // Fail closed on the unknown: this function decides whether it is safe to WRITE.
  for (const status of [{ current: false, reason: 'something-new' }, { current: false }, {}, null]) {
    assert.equal(keyHaltDecision(status).action, 'halt', JSON.stringify(status));
  }
});
