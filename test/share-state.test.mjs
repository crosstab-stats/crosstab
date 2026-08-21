/**
 * @file share-state.test.mjs
 * "This project is not shared" as a fact on the log.
 *
 * The property under test is the one a manifest scalar could not express: OFF has to be
 * distinguishable from NEVER SAID, and it has to win against a peer who only ever said
 * ON. A union or a last-save-wins merge gets this wrong in the direction that matters —
 * it silently re-opens a project someone deliberately closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';
import { foldSharing, sharingDisabled, isShareOp, shareOp, shareOpsOf, SHARE_TARGET } from '../core/share-state.js';

const logAt = (t, author = 'a') =>
  new ProjectLog({ hlc: new HLC({ now: () => t }), author: () => ({ authorId: author }) });

test('silence is not refusal — an untouched project stays shareable', () => {
  // The upgrade case. Every project that existed before this tier has no sharing ops at
  // all, and reading that as "off" would switch collaboration off across the install.
  assert.equal(foldSharing([]), null);
  assert.equal(sharingDisabled([]), false);
});

test('a decision folds last-writer-wins', () => {
  const log = logAt(1);
  log.append(shareOp(true));
  assert.equal(foldSharing(log.slice(isShareOp)), true);
  log.append(shareOp(false));
  assert.equal(foldSharing(log.slice(isShareOp)), false);
  assert.equal(sharingDisabled(log.slice(isShareOp)), true);
  log.append(shareOp(true));
  assert.equal(foldSharing(log.slice(isShareOp)), true);
});

test('OFF beats an earlier ON from the other peer — the whole point of an op', () => {
  // A said nothing but yes; B closed it later. Merged, the project is closed. Under the
  // old scalar/union shape B's decision would vanish, because "off" was just an absence.
  const a = logAt(1, 'A');
  a.append(shareOp(true));
  const b = logAt(2, 'B');
  b.append(shareOp(false));

  const merged = logAt(3, 'A');
  merged.receiveOps([...a.slice(isShareOp), ...b.slice(isShareOp)]);
  assert.equal(foldSharing(merged.slice(isShareOp)), false);

  // …and order of arrival must not change the answer.
  const other = logAt(3, 'B');
  other.receiveOps([...b.slice(isShareOp), ...a.slice(isShareOp)]);
  assert.equal(foldSharing(other.slice(isShareOp)), false);
});

test('an undone refusal is not a refusal', () => {
  // liveOps hides undone ops, so this needs no special casing in the fold — but it is
  // exactly the kind of thing that quietly breaks, and a closed project reopening
  // itself is the failure nobody would notice until strangers were in the room.
  const log = logAt(1);
  log.append(shareOp(true));
  log.append(shareOp(false));
  assert.equal(foldSharing(log.slice(isShareOp)), false);
  log.undo();
  assert.equal(foldSharing(log.slice(isShareOp)), true, 'undoing the disable restores the enable beneath it');
});

test('the tier is addressed by a constant target, not the collab id', () => {
  // The id can be rotated when links are revoked. If the target carried it, rotating
  // would start a fresh LWW chain and lose the refusal — the governed value cannot be
  // part of the address of the thing governing it.
  assert.equal(shareOp(false).target, SHARE_TARGET);
  assert.equal(shareOp(true).target, SHARE_TARGET);
  assert.ok(!SHARE_TARGET.includes('undefined'));
});

test('shareOpsOf picks this tier out of a flat log and leaves the rest alone', () => {
  const log = logAt(1);
  log.append(shareOp(false));
  log.append({ target: 'plugin:x', owner: 'core', type: 'activatePlugin', payload: { key: 'x' } });
  const flat = log.slice(() => true);
  assert.equal(shareOpsOf(flat).length, 1);
  assert.equal(shareOpsOf(flat)[0].type, 'disableSharing');
});
