/**
 * @file share-state.js
 * Whether a project may be shared at all, as ops on the one true log.
 *
 * ## Why this is not a manifest flag
 *
 * Leaving a room is not the same as not sharing. A project's room is DERIVED, not
 * stored: `collabId` + `collabSecret` ride in the manifest and `roomFor` hashes them
 * into a room id, so anyone holding the manifest computes the same room by themselves.
 * That is the design goal for a folder synced through Dropbox or Drive — and exactly
 * why `stopCoauthoring()` says nothing about intent. It means "not right now"; every
 * co-holder can still walk back in, and so can you on the next open.
 *
 * So the off switch has to be a fact ABOUT THE PROJECT that travels with it. That rules
 * out a scalar, for the reason #157 moved plugin activation onto the log: a scalar
 * merged between peers cannot express "off". If A disables sharing and B never spoke,
 * a union or a last-save-wins merge silently re-enables it, because absence and "never
 * said" are the same value. An op has a clock, so "off" beats an earlier "on" from
 * either side, and the ordinary op-union is the whole merge rule.
 *
 * ## The shape
 *
 * One target, `share:project`, carrying `enableSharing` / `disableSharing`, folded
 * last-writer-wins by HLC. Three states, and the third is the point:
 *
 *   - `true`  — someone said yes.
 *   - `false` — someone said no. Positive, clocked, and it travels.
 *   - `null`  — nobody has ever said. NOT the same as `false`: a project that never
 *               touched collaboration must not read as one that opted out, or every
 *               existing project would silently become un-shareable on upgrade.
 *
 * Callers treat `null` as permitted. Only an explicit `false` refuses.
 *
 * **Why a constant target rather than `share:<projectId>`.** The log belongs to exactly
 * one project, so the id would be a constant with extra steps — and worse than that, it
 * would be the *collab* id, which can be rotated when links are revoked. Rotating it
 * would silently start a new LWW chain and lose the refusal. The target must outlive the
 * identity it governs, because governing that identity is its job.
 *
 * ## What it does NOT promise, and says so in the UI
 *
 * This prevents FUTURE joins and severs current ones. It cannot retract what peers
 * already hold — they have the log — and it cannot govern a folder already sitting in
 * someone else's Dropbox. Same honest shape as at-rest encryption: it protects what
 * happens next, not what already happened.
 *
 * Deliberately NOT the same action as revoking links (rotating `collabSecret`), which
 * kills outstanding invite URLs but leaves folder co-holders reconnecting transparently
 * on the next sync. Two different promises; conflating them would let someone believe
 * they had made the stronger one.
 */

import { liveOps } from './op-log.js';

/** The single target carrying a project's sharing decision. */
export const SHARE_TARGET = 'share:project';

/** Is this op part of the sharing tier? */
export const isShareOp = (op) => op?.owner === 'core' && op?.target === SHARE_TARGET;

/** The sharing tier of a flat log (a `.crosstab` import, a merge result). */
export const shareOpsOf = (log) => (log ?? []).filter(isShareOp);

/**
 * Fold sharing ops into the project's decision — last writer wins, in the log's
 * canonical HLC order. Undone ops are hidden by {@link liveOps}, so undoing a disable
 * restores whatever sat beneath it with no special casing.
 *
 * @param {import('./op-log.js').Op[]} ops
 * @returns {boolean|null} `null` when the project has never expressed a view.
 */
export function foldSharing(ops) {
  let state = null;
  for (const op of liveOps(ops)) {
    if (!isShareOp(op)) continue;
    if (op.type === 'enableSharing') state = true;
    else if (op.type === 'disableSharing') state = false;
  }
  return state;
}

/**
 * Has this project been affirmatively closed to sharing?
 *
 * Phrased as "disabled" rather than "not enabled" so the `null` case cannot be misread
 * at a call site: an unspoken project is shareable, which is what every project built
 * before this tier existed expects.
 */
export const sharingDisabled = (ops) => foldSharing(ops) === false;

/** The op body recording a decision. Append with `ProjectLog#append`. */
export const shareOp = (on) => ({
  target: SHARE_TARGET,
  owner: 'core',
  type: on ? 'enableSharing' : 'disableSharing',
  payload: {},
});

/** The projection registered on {@link module:core/project-log~ProjectLog}. */
export const SHARE_STATE = {
  key: 'sharing',
  match: isShareOp,
  fold: (ops) => foldSharing(ops),
};
