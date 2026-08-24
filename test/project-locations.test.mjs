/**
 * @file project-locations.test.mjs
 * The registry of remembered project locations (#143, #171).
 *
 * It was a registry of folders, which is exactly why a project moved to Dropbox vanished
 * from the Projects list while one moved to a folder did not. Generalising the store that
 * already worked — rather than adding a second one for remote — is what these tests pin:
 * that pre-existing folder entries survive, and that a remote entry remembers WHERE a
 * project is without ever remembering how to get into it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_CONFIG, publicConfig, remoteKey, normalizeEntry } from '../core/project-locations.js';

test('a remote config keeps the address and drops the secret', () => {
  // The slip this defends against reads correctly at the call site: passing the same
  // object used to build the driver. Projection makes it harmless.
  const cfg = publicConfig('dropbox', {
    appKey: 'faero4nnch04rqo', basePath: '/CrossTab/study',
    accessToken: 'AT-SECRET', refreshToken: 'RT-SECRET',
  });
  assert.deepEqual(cfg, { appKey: 'faero4nnch04rqo', basePath: '/CrossTab/study' });
  assert.ok(!JSON.stringify(cfg).includes('SECRET'));
});

test('the same discipline applies to WebDAV, where the secret is a password', () => {
  const cfg = publicConfig('webdav', { url: 'https://c.example/dav/s', username: 'jane', password: 'app-pw' });
  assert.deepEqual(cfg, { url: 'https://c.example/dav/s', username: 'jane' });
  assert.equal(cfg.password, undefined);
});

test('an unknown kind remembers nothing at all', () => {
  // Fail closed: a kind nobody has declared fields for cannot smuggle any through.
  assert.deepEqual(publicConfig('mystery', { url: 'x', secret: 'y' }), {});
});

test('the field lists cannot be edited at runtime', () => {
  // The guarantee is "no path here writes a secret". A mutable list makes that a matter
  // of who imported the module last.
  assert.throws(() => { PUBLIC_CONFIG.dropbox.push('accessToken'); }, TypeError);
  assert.ok(!PUBLIC_CONFIG.dropbox.includes('accessToken'));
  assert.ok(!PUBLIC_CONFIG.webdav.includes('password'));
});

test('an entry written before kinds existed reads as a folder', () => {
  // The migration, such as it is. Getting this wrong would drop every remembered folder
  // out of the list on upgrade — a silent loss of the feature that already worked.
  const old = { id: 'x', handle: {}, name: 'My study', savedAt: 1 };
  assert.equal(normalizeEntry(old).kind, 'folder');
  assert.equal(normalizeEntry({ ...old, kind: 'dropbox' }).kind, 'dropbox');
  assert.equal(normalizeEntry({}).kind, 'folder');
});

test('two folders on one account are two entries; the same folder twice is one', () => {
  // Dedup identity is the ADDRESS. Without this, reopening the same location every day
  // would grow the list by one row a day.
  const a = remoteKey('dropbox', { appKey: 'K', basePath: '/study-one' });
  const b = remoteKey('dropbox', { appKey: 'K', basePath: '/study-two' });
  const aAgain = remoteKey('dropbox', { appKey: 'K', basePath: '/study-one' });
  assert.notEqual(a, b);
  assert.equal(a, aAgain);
});

test('a secret cannot change a location\\u2019s identity', () => {
  // The key is built from the projected config, so the same place with a fresh token is
  // still the same place — otherwise every sign-in would add a duplicate row.
  assert.equal(
    remoteKey('dropbox', { appKey: 'K', basePath: '/s', accessToken: 'AT1' }),
    remoteKey('dropbox', { appKey: 'K', basePath: '/s', accessToken: 'AT2' }),
  );
});

test('kinds do not collide with each other', () => {
  assert.notEqual(remoteKey('dropbox', { basePath: '/s' }), remoteKey('webdav', { url: '/s' }));
});
