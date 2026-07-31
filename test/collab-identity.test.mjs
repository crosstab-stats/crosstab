/**
 * Headless tests for the collab-identity seam (#143): the folder path's entry to the
 * signaling room. Two peers holding the same folder-synced manifest must derive the
 * IDENTICAL room id + secret — that's how the receiving faculty joins the room with
 * no separate invite link.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCollabIdentity, roomFor, inviteLinkFor, parseInviteLink, deriveRoomId } from '../core/live-invite.js';
import { buildManifest } from '../core/project-store.js';
import { mergeManifests, buildMergers } from '../core/collab-sync.js';

const bundle = (extra = {}) => ({ activeId: 1, activePlugins: null, workspaces: null, output: null, datasets: [{ id: 1, name: 'ds1', libraryLink: null, state: { sources: [{ id: 's1', meta: [{ name: 'x' }], label: 'f', combine: 'base' }], transforms: [], order: ['s'] } }], ...extra });

test('ensureCollabIdentity mints once, then is stable', () => {
  const first = ensureCollabIdentity(null);
  assert.ok(first.collabId && first.collabSecret && first.minted);
  const again = ensureCollabIdentity(first); // already has identity
  assert.equal(again.collabId, first.collabId);
  assert.equal(again.collabSecret, first.collabSecret);
  assert.equal(again.minted, false);
});

test('buildManifest carries collab identity so it rides folder sync', () => {
  const id = ensureCollabIdentity(null);
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: bundle({ collabId: id.collabId, collabSecret: id.collabSecret }) });
  assert.equal(m.collabId, id.collabId);
  assert.equal(m.collabSecret, id.collabSecret);
});

test('folder path: both peers derive the IDENTICAL room + secret from the synced manifest', async () => {
  const id = ensureCollabIdentity(null);
  // A saves; the manifest syncs to B verbatim (OneDrive mirrors the file).
  const synced = buildManifest({ name: 'P', savedAt: 1, bundle: bundle({ collabId: id.collabId, collabSecret: id.collabSecret }) });
  const roomA = await roomFor(synced);
  const roomB = await roomFor(synced); // B holds the same file
  assert.deepEqual(roomA, roomB);
  assert.equal(roomA.roomId, await deriveRoomId(id.collabId));
  assert.equal(roomA.secret, id.collabSecret);
});

test('roomFor is null before an identity exists', async () => {
  assert.equal(await roomFor(buildManifest({ name: 'P', savedAt: 1, bundle: bundle() })), null);
});

test('pure-live path: an invite link round-trips to the same room + secret', async () => {
  const id = ensureCollabIdentity(null);
  const m = buildManifest({ name: 'P', savedAt: 1, bundle: bundle({ collabId: id.collabId, collabSecret: id.collabSecret }) });
  const link = await inviteLinkFor({ baseUrl: 'https://crosstab-stats.github.io/crosstab/', manifest: m });
  const parsed = parseInviteLink(link);
  const room = await roomFor(m);
  assert.equal(parsed.roomId, room.roomId); // same room as the folder path
  assert.equal(parsed.secret, room.secret);
});

test('merge preserves collab identity (never drops the room/secret)', () => {
  const id = ensureCollabIdentity(null);
  const withId = buildManifest({ name: 'P', savedAt: 1, bundle: bundle({ collabId: id.collabId, collabSecret: id.collabSecret }) });
  const withoutId = buildManifest({ name: 'P', savedAt: 2, bundle: bundle() }); // a peer that hasn't got it yet
  // Whichever side holds the identity, the merge keeps it (propagates to the other).
  assert.equal(mergeManifests(null, withId, withoutId, buildMergers([])).manifest.collabId, id.collabId);
  assert.equal(mergeManifests(null, withoutId, withId, buildMergers([])).manifest.collabSecret, id.collabSecret);
});
