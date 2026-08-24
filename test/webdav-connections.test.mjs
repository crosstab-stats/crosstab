/**
 * @file webdav-connections.test.mjs
 * Remembered WebDAV locations hold the address and never the key.
 *
 * The owner's call (2026-08-24): store the username, type the password each session.
 * The rejected alternative was encrypting the stored password behind a passphrase —
 * which trades one typed secret for another and buys nothing. These tests pin the
 * property that decision produces, including against the caller most likely to get it
 * wrong: one that hands over a whole credentials object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listConnections, rememberConnection, forgetConnection, labelFor, PUBLIC_FIELDS,
} from '../core/webdav-connections.js';
import { isAuthError, WebDavDriver } from '../core/storage-webdav.js';

/** A localStorage stand-in. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => [...map.values()].join(''),
  };
}

test('a password handed in is dropped, not stored', () => {
  // The slip this defends against reads correctly at the call site: passing the same
  // object used to build the driver. The projection makes it harmless.
  const st = fakeStorage();
  const rec = rememberConnection(
    { url: 'https://cloud.example.org/dav/study', username: 'jane', password: 'app-pw-secret', token: 'tok' },
    st,
  );
  assert.equal(rec.username, 'jane');
  assert.equal(rec.password, undefined);
  assert.equal(rec.token, undefined);
  assert.ok(!st.dump().includes('app-pw-secret'), 'nothing resembling the secret reaches storage');
  assert.ok(!st.dump().includes('tok'));
});

test('PUBLIC_FIELDS is the whole story, and cannot be edited at runtime', () => {
  // The guarantee is "this module has no path that writes a secret". A mutable list
  // would make that a matter of who imported it last.
  assert.deepEqual([...PUBLIC_FIELDS], ['id', 'url', 'username', 'name', 'savedAt']);
  assert.ok(!PUBLIC_FIELDS.includes('password'));
  assert.throws(() => { PUBLIC_FIELDS.push('password'); }, TypeError);
});

test('re-entering the same location updates rather than duplicates', () => {
  const st = fakeStorage();
  rememberConnection({ url: 'https://c.example/dav/s', username: 'jane', name: 'Study' }, st);
  rememberConnection({ url: 'https://c.example/dav/s', username: 'jane', name: 'Study 2026' }, st);
  const all = listConnections(st);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'Study 2026');
});

test('the same server under two accounts stays two entries', () => {
  // Right for a shared machine: the address alone does not identify the connection.
  const st = fakeStorage();
  rememberConnection({ url: 'https://c.example/dav/s', username: 'jane' }, st);
  rememberConnection({ url: 'https://c.example/dav/s', username: 'sam' }, st);
  assert.equal(listConnections(st).length, 2);
});

test('a corrupt store costs the list, not the app', () => {
  assert.deepEqual(listConnections(fakeStorage({ 'crosstab.webdav.connections': '{oh no' })), []);
  assert.deepEqual(listConnections(fakeStorage({ 'crosstab.webdav.connections': '{"not":"an array"}' })), []);
  assert.deepEqual(listConnections(undefined), [], 'no storage at all (private mode) is empty, not a throw');
});

test('entries without a url are discarded on read', () => {
  const st = fakeStorage({ 'crosstab.webdav.connections': JSON.stringify([{ username: 'jane' }, { url: 'https://c/dav' }]) });
  assert.equal(listConnections(st).length, 1);
});

test('forgetting removes one and leaves the rest', () => {
  const st = fakeStorage();
  const a = rememberConnection({ url: 'https://c.example/dav/a', username: 'jane' }, st);
  rememberConnection({ url: 'https://c.example/dav/b', username: 'jane' }, st);
  forgetConnection(a.id, st);
  const left = listConnections(st);
  assert.equal(left.length, 1);
  assert.match(left[0].url, /\/dav\/b$/);
});

test('a storage that refuses to write is a non-event', () => {
  // Private mode, or a full quota. Remembering is a convenience; failing to remember
  // must never stop someone opening their project.
  const st = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.equal(rememberConnection({ url: 'https://c/dav', username: 'j' }, st), null);
});

test('labels prefer the given name, then the folder, then the host', () => {
  assert.equal(labelFor({ url: 'https://c.example/dav/s', name: 'My study' }), 'My study');
  assert.equal(labelFor({ url: 'https://cloud.example.org/remote.php/dav/files/jane/study' }), 'study — cloud.example.org');
  assert.equal(labelFor({ url: 'https://cloud.example.org' }), 'cloud.example.org');
  assert.equal(labelFor({ url: 'not a url' }), 'not a url');
});

test('a 401 is re-promptable; a 403 is not', async () => {
  // The consequence of holding the password only in memory: the caller must be able to
  // tell "ask again" from "asking again will not help", or an autosave dies silently
  // when an app password is revoked mid-session.
  const respond = (status) => async () => ({
    status, ok: false, headers: new Map(), async text() { return ''; }, async arrayBuffer() { return new ArrayBuffer(0); },
  });
  const d401 = new WebDavDriver({ baseUrl: 'https://c.example/dav', username: 'j', password: 'x', fetch: respond(401) });
  const err = await d401.read('project.json').then(() => null, (e) => e);
  assert.ok(isAuthError(err), '401 asks for the password again');
  assert.equal(err.status, 401);

  const d403 = new WebDavDriver({ baseUrl: 'https://c.example/dav', username: 'j', password: 'x', fetch: respond(403) });
  const err3 = await d403.read('project.json').then(() => null, (e) => e);
  assert.ok(!isAuthError(err3), '403 means authenticated and refused — re-typing would loop');
  assert.equal(err3.status, 403);
});

test('a 401 never masquerades as a missing file', async () => {
  // read() answers null for 404. If a 401 took that path too, a project behind a stale
  // password would open as an empty one — and then autosave over the real thing.
  const d = new WebDavDriver({
    baseUrl: 'https://c.example/dav',
    username: 'j',
    password: 'x',
    fetch: async () => ({ status: 401, ok: false, headers: new Map(), async arrayBuffer() { return new ArrayBuffer(0); } }),
  });
  await assert.rejects(() => d.read('project.json'), (e) => isAuthError(e));
});
