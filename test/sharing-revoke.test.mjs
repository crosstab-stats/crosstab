/**
 * @file sharing-revoke.test.mjs
 * Revoking invite links, and the wording that has to stay honest about it.
 *
 * "Stop sharing" shipped in 2026-08; this is the half that was left open. The two are
 * deliberately separate actions and the design note says not to conflate them:
 *
 *  - **Stop sharing** refuses the room the links point at. Reversible.
 *  - **Revoke** rotates the project's collab identity, so the links address a room that
 *    no longer exists. Irreversible.
 *
 * The old `confirm()` could only offer one verb, and its own text had to apologise for
 * the gap — *"it does not revoke the links themselves"*. The dialog now has both, and
 * each states its limit beside itself, because the person revoking a link is usually
 * worried about precisely the thing neither action can do: take back a copy someone
 * already has.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sharingOffer, REVOKED_NOTE } from '../core/sharing-settings.js';

// =============================================================================
// What the dialog offers
// =============================================================================

test('the status says which state the project is in', () => {
  assert.match(sharingOffer({ sharing: true, hasIdentity: true }).status, /ON/);
  assert.match(sharingOffer({ sharing: false, hasIdentity: true }).status, /OFF/);
});

test('the toggle is labelled for what it will do, not for the state', () => {
  assert.equal(sharingOffer({ sharing: true, hasIdentity: true }).toggleLabel, 'Stop sharing');
  assert.equal(sharingOffer({ sharing: false, hasIdentity: true }).toggleLabel, 'Allow sharing');
});

test('stopping sharing is described as reversible, and revoking as not', () => {
  // The distinction the whole feature rests on.
  const on = sharingOffer({ sharing: true, hasIdentity: true });
  assert.match(on.toggleBody, /turn it back on/i);
  assert.match(on.revokeNote, /cannot be undone/i);
});

test('turning sharing back on says the old links start working again', () => {
  // Because stopping REFUSED them rather than revoking them — a reader who does not
  // know that will assume the opposite, which is the more dangerous assumption.
  const off = sharingOffer({ sharing: false, hasIdentity: true });
  assert.match(off.toggleBody, /start working again|resumes/i);
});

test('revocation is not offered before there is anything to revoke', () => {
  // A project that has never issued a link has no identity, and the button would
  // rotate a secret nobody holds.
  const fresh = sharingOffer({ sharing: true, hasIdentity: false });
  assert.equal(fresh.canRevoke, false);
  assert.match(fresh.revokeNote, /nothing to revoke/i);
  assert.equal(sharingOffer({ sharing: true, hasIdentity: true }).canRevoke, true);
});

test('the revoke note says plainly who is NOT locked out', () => {
  // Folder co-holders receive the new room on the next sync, because holding the folder
  // is the credential. Someone revoking links to shut a person out needs to know that
  // this does not do it.
  const note = sharingOffer({ sharing: true, hasIdentity: true }).revokeNote;
  assert.match(note, /folder/i);
  assert.match(note, /NOT locked out|not locked out/);
});

test('the confirmation afterwards does not overclaim', () => {
  // The one genuinely harmful outcome would be letting someone believe revocation
  // undoes the sharing.
  assert.match(REVOKED_NOTE, /no longer exists/i);
  assert.match(REVOKED_NOTE, /does not retract copies/i);
});

// =============================================================================
// What rotation actually does
// =============================================================================

const SRC = readFileSync('core/project-sync.js', 'utf8');
const BODY = SRC.slice(SRC.indexOf('async revokeInviteLinks()'), SRC.indexOf('async revokeInviteLinks()') + 700);

test('BOTH halves of the identity rotate, not just the secret', () => {
  // roomId is derived from collabId and the secret rides beside it in the link, so
  // rotating only the secret leaves an old link able to reach the right signalling room
  // and merely fail to decrypt. Rotating both means it addresses nothing.
  assert.match(BODY, /#collabId = null/);
  assert.match(BODY, /#collabSecret = null/);
  assert.match(BODY, /#ensureCollab\(\)/, 'the new pair must come from the one minting path');
});

test('a live session is dropped before the room is abandoned', () => {
  // Leaving it up would mean the revocation had not taken effect for exactly the people
  // currently connected — the empty gesture stopCoauthoring used to be.
  const stop = BODY.indexOf('stopCoauthoring');
  const rotate = BODY.indexOf('#collabId = null');
  assert.ok(stop > 0 && stop < rotate, 'stopCoauthoring must come first');
});

test('the rotation is persisted rather than left in memory', () => {
  assert.match(BODY, /#dirty = true/);
  assert.match(BODY, /#settle\(\)/, 'it must be on disk before the user is told it happened');
});

test('asking whether there is an identity does not MINT one', () => {
  // `hasCollabIdentity` must not go through #ensureCollab — the dialog asks this every
  // time it opens, and a getter that creates what it reports would hand every project a
  // collab identity just for looking at the Sharing dialog.
  const getter = SRC.slice(SRC.indexOf('get hasCollabIdentity()'), SRC.indexOf('get hasCollabIdentity()') + 160);
  assert.doesNotMatch(getter, /ensureCollab/);
});

test('the menu opens the dialog rather than a confirm', () => {
  const app = readFileSync('core/app.js', 'utf8');
  const item = app.slice(app.indexOf("id: 'core:sharing'"), app.indexOf("id: 'core:sharing'") + 600);
  assert.match(item, /showSharingSettings/);
  assert.doesNotMatch(item, /confirm\(/, 'a confirm can only ever offer one of the two verbs');
});
