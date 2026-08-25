/**
 * @file storage-backend.test.mjs
 * Where a project lives, as one interface per platform (#172).
 *
 * The engine used to ask which UI flow the user came through and key real behaviour on
 * the answer, which produced four bugs of one shape — a save that overwrote a peer, a
 * poll that never ran, a re-key that went unnoticed, and a project list that queried the
 * wrong store. What is pinned here is the replacement: every platform answers the same
 * questions, and nothing about how the bytes behave is inferred from a name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpfsBackend, FolderBackend, DropboxBackend, WebDavBackend, backendFor,
  LOCAL_POLL_MS, REMOTE_POLL_MS,
} from '../core/storage-backend.js';
import { capabilitiesOf } from '../core/storage-driver.js';

const fakeHandle = (name = 'My study') => ({ name, queryPermission: async () => 'granted' });

test('every backend answers the same questions', () => {
  // The interface is the point. A backend that cannot describe or remember itself forces
  // the caller to special-case it, which is how the branches came back last time.
  const backends = [
    new OpfsBackend(),
    new FolderBackend(fakeHandle()),
    new DropboxBackend({ appKey: 'K', basePath: '/s' }, async () => ({ getToken: async () => 'T' })),
    new WebDavBackend({ url: 'https://c.example/dav/s' }, async () => 'pw'),
  ];
  for (const b of backends) {
    assert.equal(typeof b.kind, 'string', 'kind');
    assert.equal(typeof b.connect, 'function', 'connect');
    assert.equal(typeof b.driver, 'function', 'driver');
    assert.ok(b.describe().label, `${b.kind} describes itself`);
    assert.equal(typeof b.needsGesture, 'boolean', 'needsGesture');
    assert.equal(typeof b.pollMs, 'number', 'pollMs');
  }
});

test('capabilities come from the driver, not from the kind', () => {
  // The whole fix. OPFS is the only backend holding many projects; everything else is one
  // project per location and may be written by someone else.
  const opfs = capabilitiesOf(new OpfsBackend().driver());
  assert.equal(opfs.flat, false);
  assert.equal(opfs.externallySynced, false);

  const folder = capabilitiesOf(new FolderBackend(fakeHandle()).driver());
  assert.equal(folder.flat, true);
  assert.equal(folder.externallySynced, true);

  const dav = capabilitiesOf(new WebDavBackend({ url: 'https://c/dav' }, async () => 'p').driver());
  assert.equal(dav.flat, true);
  assert.equal(dav.externallySynced, true);
});

test('a fresh driver per call — the probe and the live store never share one', () => {
  // Sharing would mean an aborted probe left the live store half-configured, which is the
  // failure mode the probe-then-commit ordering exists to prevent.
  const b = new FolderBackend(fakeHandle());
  assert.notEqual(b.driver(), b.driver());
});

test('only a folder needs a user gesture, and only a folder offers shortcuts', () => {
  // Both are File System Access API requirements rather than opinions about storage —
  // the two genuinely non-uniform things, and they are declared rather than assumed.
  assert.equal(new FolderBackend(fakeHandle()).needsGesture, true);
  assert.equal(new DropboxBackend({ appKey: 'K' }, async () => ({})).needsGesture, false);
  assert.equal(typeof new FolderBackend(fakeHandle()).shortcuts, 'function');
  assert.equal(new DropboxBackend({ appKey: 'K' }, async () => ({})).shortcuts, undefined);
  assert.equal(new OpfsBackend().shortcuts, undefined);
});

test('polling is local-fast and remote-slow, and local storage is not polled at all', () => {
  assert.equal(new OpfsBackend().pollMs, 0, 'nothing else writes it');
  assert.equal(new FolderBackend(fakeHandle()).pollMs, LOCAL_POLL_MS);
  assert.equal(new DropboxBackend({ appKey: 'K' }, async () => ({})).pollMs, REMOTE_POLL_MS);
});

test('connect is where the credential is obtained, and a refusal is not an exception', async () => {
  // A cancelled sign-in must leave the open project untouched, so it reports false rather
  // than throwing past the caller's guard.
  const cancelled = new WebDavBackend({ url: 'https://c/dav' }, async () => null);
  assert.equal(await cancelled.connect(), false);

  const given = new WebDavBackend({ url: 'https://c/dav' }, async () => 'pw');
  assert.equal(await given.connect(), true);

  // An EMPTY password is a choice a server may accept; only a cancel is a refusal.
  const empty = new WebDavBackend({ url: 'https://c/dav' }, async () => '');
  assert.equal(await empty.connect(), true);
});

test('a Dropbox backend cannot build a driver before it has a session', () => {
  // Failing loudly here beats a driver that silently sends no Authorization header and
  // gets a 401 the caller would read as "wrong password".
  const b = new DropboxBackend({ appKey: 'K', basePath: '/s' }, async () => ({ getToken: async () => 'T' }));
  assert.throws(() => b.driver(), /connect/);
});

test('what a backend remembers is an address, never a credential', async () => {
  const dbx = new DropboxBackend({ appKey: 'K', basePath: '/s' }, async () => ({ getToken: async () => 'SECRET' }));
  await dbx.connect();
  assert.deepEqual(dbx.remember().config, { appKey: 'K', basePath: '/s' });

  const dav = new WebDavBackend({ url: 'https://c/dav', username: 'jane' }, async () => 'SECRET');
  await dav.connect();
  const mark = dav.remember();
  assert.deepEqual(mark.config, { url: 'https://c/dav', username: 'jane' });
  assert.ok(!JSON.stringify(mark).includes('SECRET'));
});

test('local storage remembers nothing — the OPFS catalog already lists it', () => {
  assert.equal(new OpfsBackend().remember(), null);
});

test('a remembered entry becomes a backend again, given only how to get in', () => {
  const b = backendFor(
    { kind: 'dropbox', config: { appKey: 'K', basePath: '/s' } },
    { dropboxSession: async () => ({ getToken: async () => 'T' }) },
  );
  assert.equal(b.kind, 'dropbox');
  assert.equal(b.describe().label, '/s');
});

test('an entry that cannot be rebuilt returns null rather than a broken backend', () => {
  // Missing credentials, a missing handle, or a kind from a newer version. Each must fail
  // where the caller can say something useful, not on first use.
  assert.equal(backendFor({ kind: 'dropbox', config: { appKey: 'K' } }, {}), null, 'no way to sign in');
  assert.equal(backendFor({ kind: 'folder' }, {}), null, 'a folder entry with no handle');
  assert.equal(backendFor({ kind: 'graph', config: {} }, {}), null, 'a kind this build does not know');
  assert.equal(backendFor(null, {}), null);
});

test('a kind-less entry is treated as a folder, matching the registry', () => {
  assert.equal(backendFor({ handle: fakeHandle() }, {}).kind, 'folder');
});
