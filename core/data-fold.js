/**
 * @file data-fold.js
 * The pure ordering fold for one dataset's slice of the unified log.
 *
 * A DataStore no longer owns a private op array — its history is the subset of the
 * project's {@link ProjectLog} whose target is `ds:<id>/…` (see
 * docs/MIGRATION-one-true-log.md). Two of those op types are *structural* rather than
 * data steps, and this module resolves them into the ordered list of live steps that
 * {@link DataStore#rederive} replays into DuckDB:
 *
 *  - **`retract`** — the log-native deletion of a pipeline step. Physical removal is
 *    merge-unsafe (a removed op drops out of the shared-id ancestor and reads as the
 *    peer's *addition* on the next merge, silently returning — the delete-inference
 *    bug class). So a delete appends `retract{payload:{opId}}`; the fold drops the
 *    retracted op. The retract itself propagates as an ordinary add-wins op, so the
 *    deletion survives a merge.
 *  - **`reorder`** — user-editable pipeline order (the do-file editor's move / collect
 *    imports). Order is HLC-derived by default; a `reorder{payload:{order:[opId,…]}}`
 *    overrides it. The *latest applied* reorder wins (the input is HLC-ordered, so the
 *    last one seen is newest); ops not named in it keep their HLC order after the named
 *    ones (a stable sort on the position index).
 *  - **`undo`/`redo`** — reversible, append-only hide/show of any op (resolved by the
 *    shared {@link liveOps}/{@link appliedState} helper). An undone step is dropped from
 *    the replay; a redone one returns; an undone `retract`/`reorder` loses its effect.
 *
 * On top of those it applies one **derived** rule, the *replace barrier*: a `load` op
 * means "start over from this source" (rederive's `load` branch clears the variable map
 * and begins a fresh SELECT), so every step ordered before the last live `load` is
 * already dead and is dropped here. Deriving that from the `load` itself — rather than
 * retracting the prior steps at import time, as the first cut of #148 did — is what makes
 * a replace-import a *single* undoable action: one `undo` of the `load` lifts the barrier
 * and the whole previous pipeline comes back. (Retracting instead left N undoable
 * tombstones whose individual undos revived steps in states that could not be replayed.)
 *
 * Kept pure and DuckDB-free so the ordering — the genuinely new, merge-sensitive
 * logic — is headlessly testable (see test/data-fold.test.mjs). The SQL replay of the
 * returned steps stays in data-store.js.
 */

import { liveOps, appliedState } from './op-log.js';

/** Flatten one op into the replay/History shape: `{id, author, type, ...payload}`.
 * The inverse convention the mutators use when they `append({type, payload})`. */
export function flattenStep(op) {
  return { id: op.id, author: op.author, type: op.type, ...(op.payload ?? {}) };
}

/** The live content ops in HLC order, split at the **replace barrier**: `kept` are the
 * ops from the last live `load` onward, `dropped` are the ones it superseded.
 *
 * Deliberately computed on HLC (append) order, NOT on the reordered replay order, so
 * that liveness is *stable under reorder*: dragging the new import above an older step
 * in the History editor changes the order, never what exists. (It also keeps the split
 * identical on every peer without depending on a reorder op having merged yet.) */
function splitAtBarrier(raw) {
  const live = liveOps(raw); // undo/redo/retract → the live content steps
  let at = 0;
  for (let i = live.length - 1; i > 0; i--) if (live[i].type === 'load') { at = i; break; }
  return { kept: at ? live.slice(at) : live, dropped: at ? live.slice(0, at) : [] };
}

/** Apply the latest APPLIED `reorder` (an undone one has no effect) to a live list. */
function applyReorder(raw, live) {
  const applied = appliedState(raw);
  let latestOrder = null;
  for (const op of raw) {
    if (op.type === 'reorder' && applied(op.id) && Array.isArray(op.payload?.order)) latestOrder = op.payload.order; // HLC-ordered ⇒ last applied wins
  }
  if (!latestOrder) return live;
  const pos = new Map(latestOrder.map((id, i) => [id, i]));
  const at = (op) => (pos.has(op.id) ? pos.get(op.id) : Number.POSITIVE_INFINITY);
  // Array#sort is stable, so ops absent from the reorder (both at Infinity) keep
  // their incoming HLC order, landing after the explicitly-ordered ones.
  return [...live].sort((a, b) => at(a) - at(b));
}

/**
 * Resolve a dataset's raw op slice (HLC-ordered, from `ProjectLog.slice`) into the
 * ordered list of **live data steps** to replay. Retracted ops are dropped;
 * structural ops are consumed; the latest `reorder` (if any) sets the order; and
 * everything before the last `load` (the replace barrier) is dropped.
 *
 * Each returned step is flattened for the replay switch: `{id, author, type,
 * ...payload}` — so the existing rederive code reads `step.src`, `step.name`,
 * `step.patch`, … exactly as it did when the log was a plain array of such objects.
 *
 * @param {import('./op-log.js').Op[]} ops  The dataset's ops in HLC order.
 * @returns {Array<{id:string, type:string, [k:string]:*}>}
 */
export function foldDataOps(ops) {
  const raw = ops ?? [];
  return applyReorder(raw, splitAtBarrier(raw).kept).map(flattenStep);
}

/**
 * The op ids dropped by the **replace barrier** alone — live, un-retracted steps that
 * a later `load` superseded. These are the ops whose materialised bytes a caller may
 * safely free: unlike an *undone* op (which a redo must be able to bring back), a
 * barrier-dropped op can only return if the `load` above it is undone.
 *
 * @param {import('./op-log.js').Op[]} ops
 * @returns {string[]}
 */
export function barrierDroppedIds(ops) {
  return splitAtBarrier(ops ?? []).dropped.map((o) => o.id);
}

/**
 * The op ids of a dataset's live data steps, in fold order — the identity list the
 * History panel / a `reorder` payload is built from. Convenience over
 * {@link foldDataOps} for callers that only need ordering, not the flattened steps.
 * @param {import('./op-log.js').Op[]} ops
 * @returns {string[]}
 */
export function liveStepIds(ops) {
  return foldDataOps(ops).map((s) => s.id);
}
