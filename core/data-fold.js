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

/**
 * Resolve a dataset's raw op slice (HLC-ordered, from `ProjectLog.slice`) into the
 * ordered list of **live data steps** to replay. Retracted ops are dropped;
 * structural ops are consumed; the latest `reorder` (if any) sets the order.
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
  // Undo/redo/retract → the live content steps (shared liveness fold).
  const live = liveOps(raw);
  // The latest APPLIED reorder sets the order (an undone reorder has no effect).
  const applied = appliedState(raw);
  let latestOrder = null;
  for (const op of raw) {
    if (op.type === 'reorder' && applied(op.id) && Array.isArray(op.payload?.order)) latestOrder = op.payload.order; // HLC-ordered ⇒ last applied wins
  }

  let ordered = live;
  if (latestOrder) {
    const pos = new Map(latestOrder.map((id, i) => [id, i]));
    const at = (op) => (pos.has(op.id) ? pos.get(op.id) : Number.POSITIVE_INFINITY);
    // Array#sort is stable, so ops absent from the reorder (both at Infinity) keep
    // their incoming HLC order, landing after the explicitly-ordered ones.
    ordered = [...live].sort((a, b) => at(a) - at(b));
  }

  return ordered.map(flattenStep);
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
