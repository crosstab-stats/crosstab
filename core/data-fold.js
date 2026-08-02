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
 *    overrides it. The *latest* reorder wins (the input is HLC-ordered, so the last
 *    one seen is newest); ops not named in it keep their HLC order after the named
 *    ones (a stable sort on the position index).
 *
 * Kept pure and DuckDB-free so the ordering — the genuinely new, merge-sensitive
 * logic — is headlessly testable (see test/data-fold.test.mjs). The SQL replay of the
 * returned steps stays in data-store.js.
 */

/** Op types that are structural (consumed here), not replayable data steps. */
const STRUCTURAL = new Set(['retract', 'reorder']);

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
  const retracted = new Set();
  let latestOrder = null;
  for (const op of raw) {
    if (op.type === 'retract') retracted.add(op.payload?.opId);
    else if (op.type === 'reorder' && Array.isArray(op.payload?.order)) latestOrder = op.payload.order; // HLC-ordered ⇒ last wins
  }

  const live = raw.filter((op) => !STRUCTURAL.has(op.type) && !retracted.has(op.id));

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
