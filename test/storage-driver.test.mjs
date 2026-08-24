/**
 * @file storage-driver.test.mjs
 * The storage seam's contract (#143 cloud storage).
 *
 * The property being pinned is that behaviour comes from DECLARED capabilities, never
 * from the driver's `kind`. That distinction is not academic: `ProjectStore` used to
 * take its folder-vs-OPFS behaviour from `kind === 'folder'` while taking its LAYOUT
 * from a separate flag, so a driver injected through the seam — the seam's entire
 * purpose — was laid out flat and then treated as nested. A third-party driver would
 * have had to lie about its name to be handled correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPABILITIES, capabilitiesOf, OpfsDriver, FsaFolderDriver } from '../core/storage-driver.js';

test('a driver that declares nothing gets the conservative defaults', () => {
  // Every default is the assumption that costs least if wrong: promise no atomicity and
  // no streaming rather than have the store rely on either and find out at runtime.
  const caps = capabilitiesOf({ kind: 'mystery' });
  assert.equal(caps.atomicWrite, false);
  assert.equal(caps.canStream, false);
  assert.equal(caps.externallySynced, true, 'assume someone else may write these bytes');
  assert.equal(caps.flat, true, 'assume one project per location, like every remote backend');
});

test('a partial declaration is filled in, not rejected', () => {
  // A WebDAV driver should be able to say the one thing that differs from the default.
  const caps = capabilitiesOf({ kind: 'webdav', capabilities: { atomicWrite: true } });
  assert.equal(caps.atomicWrite, true);
  assert.equal(caps.flat, true);
  assert.equal(caps.canStream, false, 'unstated stays at the default');
});

test('capabilitiesOf tolerates null and undefined', () => {
  assert.deepEqual({ ...capabilitiesOf(null) }, { ...DEFAULT_CAPABILITIES });
  assert.deepEqual({ ...capabilitiesOf(undefined) }, { ...DEFAULT_CAPABILITIES });
});

test('the two shipped drivers declare the layouts they actually have', () => {
  // OPFS is the nested multi-project store, private to this browser profile.
  const opfs = capabilitiesOf(new OpfsDriver());
  assert.equal(opfs.flat, false);
  assert.equal(opfs.externallySynced, false);

  // A picked folder IS the project, and an OS sync client mirrors it, so another
  // machine writing these bytes is the normal case rather than an edge one.
  const folder = capabilitiesOf(new FsaFolderDriver(null));
  assert.equal(folder.flat, true);
  assert.equal(folder.externallySynced, true);
});

test('flat-ness is a declaration, not a name — the bug this replaces', () => {
  // The old test was `kind === 'folder'`. Anything else answered "not flat" however it
  // was actually laid out, so this is the exact case that misbehaved.
  const webdav = { kind: 'webdav', capabilities: { flat: true, externallySynced: true } };
  assert.equal(capabilitiesOf(webdav).flat, true);
  assert.notEqual(webdav.kind, 'folder', 'and it never had to claim to be a folder');
});

test('the defaults object cannot be mutated by a caller', () => {
  // It is shared by every driver that declares nothing; one careless write would
  // silently re-specify the contract for all of them.
  assert.throws(() => { DEFAULT_CAPABILITIES.flat = false; }, TypeError);
  assert.equal(DEFAULT_CAPABILITIES.flat, true);
});
