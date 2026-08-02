/**
 * @file op-log.js
 * The unified operation log's primitives (see docs/ARCHITECTURE-unified-log.md).
 * This module is the pure, transport-free core: the op envelope, the merge-base
 * derivation, and the `reads[]`-aware ordering + dangling-reference detection. The
 * stateful aggregate (log + fold + undo + merge dispatch) and the wiring into the live
 * app are built on top of these.
 *
 * ## Invariant: ops are immutable; "editing" is appending
 *
 * You never mutate a logged op — a change is always a NEW op with a fresh id. That is
 * what makes {@link sharedAncestor} sound: a shared op id means identical content, so
 * the intersection of two peers' id sets is a clean common ancestor (no "same id,
 * different content" ambiguity). Keep this invariant or the merge base breaks.
 *
 * ## Two orders, two jobs (§4 of the design)
 *
 *  - **HLC** gives the *total* order used to interleave ops on merge — the real fix for
 *    the old "mine's new ops, then theirs'" guesswork ({@link orderByHlc}).
 *  - **`reads[]`** gives the *causal* constraint: an op that reads a target must sit
 *    after the op that writes it. In v1 we ORDER by HLC (causally consistent for ops
 *    that observed each other) and use `reads[]` to *validate* and to *surface* a
 *    reader that would land before its writer ({@link unresolvedReads}) — we do not
 *    silently reorder across concurrent branches (that would change meaning; it is
 *    surfaced instead, per "never a silent wrong result").
 */

import { newOpId } from './merge.js';
import { hlcCompare } from './hlc.js';

/**
 * @typedef {Object} Op
 * @property {string} id       Stable unique identity (immutable).
 * @property {import('./hlc.js').HlcStamp} hlc  Hybrid Logical Clock stamp.
 * @property {string} target   The aggregate address this op writes (e.g. `ds:2/var:income`).
 * @property {string} owner    Merge authority: `'core'` or a plugin id.
 * @property {string} type     The operation verb.
 * @property {object} [payload] Light metadata (heavy bytes are asset refs, never inline).
 * @property {string[]} reads  Targets this op depends on (the causal DAG); may be empty.
 * @property {{authorId:string,initials?:string,name?:string,color?:string}} [author]
 */

/**
 * Construct an op envelope. `id` defaults to a fresh random id; pass one explicitly in
 * tests for determinism. `reads` defaults to `[]`. Throws if the required routing
 * fields are missing (a mis-addressed op must fail loudly, not merge into limbo).
 *
 * @param {{target:string, owner:string, type:string, payload?:object, reads?:string[]}} body
 * @param {{id?:string, hlc:import('./hlc.js').HlcStamp, author?:object}} stamp
 * @returns {Op}
 */
export function makeOp({ target, owner, type, payload, reads }, { id, hlc, author } = {}) {
  if (!target) throw new Error('makeOp: target is required');
  if (!owner) throw new Error('makeOp: owner is required');
  if (!type) throw new Error('makeOp: type is required');
  if (!hlc) throw new Error('makeOp: hlc stamp is required');
  const op = { id: id ?? newOpId(), hlc, target, owner, type, reads: Array.isArray(reads) ? [...reads] : [] };
  if (payload !== undefined) op.payload = payload;
  if (author) op.author = author;
  return op;
}

/** The set of op ids in a log. @param {Op[]} ops @returns {Set<string>} */
export function opIds(ops) {
  return new Set((ops ?? []).map((o) => o.id));
}

/**
 * The **common ancestor** for a three-way merge, derived from the logs themselves:
 * the ops whose id appears in BOTH sides. Because ops are immutable (a shared id ⇒
 * identical content), this id-set intersection is a sound merge base — so we need no
 * separately-tracked `project.base.json` and no fragile in-memory ancestor. Returns
 * `mine`'s copies of the shared ops, in `mine`'s order.
 *
 * @param {Op[]} mine @param {Op[]} theirs @returns {Op[]}
 */
export function sharedAncestor(mine, theirs) {
  const theirIds = opIds(theirs);
  return (mine ?? []).filter((o) => theirIds.has(o.id));
}

/**
 * Order ops by HLC (total order), with the op id as a stable, deterministic tiebreak
 * so two peers sorting the same set get byte-identical results. This is the interleave
 * order used on merge — replacing the old "keep ancestor order, then mine's new ops,
 * then theirs'" heuristic with true temporal order.
 *
 * @param {Op[]} ops @returns {Op[]} a new sorted array (input not mutated)
 */
export function orderByHlc(ops) {
  return [...(ops ?? [])].sort((a, b) => hlcCompare(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Validate a **specific order** against the `reads[]` causal constraint: every op must
 * appear after the ops that write the targets it reads. A read is satisfied by an
 * earlier op whose `target` matches exactly, or by a target present in `base` (state
 * already materialised before this log — e.g. a checkpoint, or an imported source).
 *
 * Returns the ops whose reads are NOT satisfied at their position — i.e. **dangling**
 * references (a reader before its writer, or a read of something that no longer
 * exists). Empty ⇒ the order is causally valid. The caller decides what to do
 * (surface a conflict, reject a reorder, mark the op inert) — this primitive only
 * detects, it never silently repairs.
 *
 * NB: v1 matches read targets to writer targets **exactly**. Prefix/relational
 * matching (e.g. a read of `ds:2/var:income` satisfied by the `load` that created the
 * dataset) is a projection-level refinement layered on later.
 *
 * @param {Op[]} orderedOps  the ops in the order to check
 * @param {{base?: Iterable<string>}} [opts]  targets already available before op[0]
 * @returns {Array<{op: Op, missing: string[]}>}
 */
export function unresolvedReads(orderedOps, { base } = {}) {
  const available = new Set(base ?? []);
  const problems = [];
  for (const op of orderedOps ?? []) {
    const missing = op.reads.filter((t) => !available.has(t));
    if (missing.length) problems.push({ op, missing });
    available.add(op.target); // this op now provides its own target to later ops
  }
  return problems;
}
