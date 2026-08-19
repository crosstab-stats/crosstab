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
 * Structural / control op types — they never appear as *content* in a projection's
 * fold; they express **liveness and order** over the content ops:
 *  - `undo`/`redo` (payload `{opId}`) — reversible hide/show of an op (append-only
 *    undo — the log is never mutated to undo; see docs/MIGRATION-one-true-log.md).
 *  - `retract` (payload `{opId}`) — a deliberate, merge-safe deletion (a tombstone).
 *  - `reorder` (payload `{order:[opId,…]}`) — user-chosen order over the content ops.
 */
export const STRUCTURAL_OPS = new Set(['undo', 'redo', 'retract', 'reorder']);

/**
 * The **applied-state** query for a log: `applied(opId)` is false iff the op's latest
 * (highest-HLC) `undo`/`redo` marker is an `undo`. Every op is applied by default;
 * `undo{opId}` hides it, a later `redo{opId}` shows it again. Non-recursive: undo/redo
 * markers are themselves never undone (undo targets the next applied op; redo re-shows
 * the most-recently-undone one), so a single latest-marker-wins pass is exact.
 *
 * **Assumes `ops` is already HLC-ordered** (as {@link ProjectLog#slice}/`state` and
 * every projection fold provide) — it does NOT re-sort, so callers holding an unordered
 * set must {@link orderByHlc} first.
 *
 * @param {Op[]} ops  in HLC order
 * @returns {(opId: string) => boolean}
 */
export function appliedState(ops) {
  const latest = new Map(); // opId → 'undo' | 'redo' (last-in-order wins ⇒ highest HLC)
  for (const op of ops ?? []) {
    if ((op.type === 'undo' || op.type === 'redo') && op.payload?.opId != null) {
      latest.set(op.payload.opId, op.type);
    }
  }
  return (opId) => latest.get(opId) !== 'undo';
}

/**
 * The **live content ops** of a log, in the input's (HLC) order: every non-structural op
 * that is currently *applied* (not net-undone) and not dropped by an *applied* `retract`.
 * This is the shared liveness fold every projection runs before its own interpretation
 * (collection membership, analysis list, the data pipeline). Reorder is NOT applied here
 * (it's data-tier-specific — see {@link module:core/data-fold}); this only resolves
 * undo/redo/retract. Pure. **Assumes `ops` is already HLC-ordered** (see {@link appliedState}).
 *
 * @param {Op[]} ops  in HLC order
 * @returns {Op[]}
 */
export function liveOps(ops) {
  const list = ops ?? [];
  const applied = appliedState(list);
  const retracted = new Set();
  for (const op of list) {
    if (op.type === 'retract' && applied(op.id) && op.payload?.opId != null) retracted.add(op.payload.opId);
  }
  return list.filter((op) => !STRUCTURAL_OPS.has(op.type) && applied(op.id) && !retracted.has(op.id));
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
 * **Ancestor matching (#166).** Exact matching alone was unusable for anything that
 * reads *data* rather than a prior edit. A coding anchored to
 * `ds:7/cell:transcript:1000003` reads a cell that may never have been individually
 * written — its value arrived with the dataset's `load` — so under exact matching every
 * such coding reported as dangling on every merge, and the real signal drowned in the
 * false ones. A read is therefore also satisfied by a writer at or ABOVE it in the
 * address path: `ds:7/cell:transcript:1000003` ⊑ `ds:7/cell:transcript` ⊑ `ds:7`, so the
 * `load` that created the dataset satisfies reads of anything inside it. This is the
 * refinement the original NB anticipated; anchors are what made it necessary.
 *
 * @param {Op[]} orderedOps  the ops in the order to check
 * @param {{base?: Iterable<string>}} [opts]  targets already available before op[0]
 * @returns {Array<{op: Op, missing: string[]}>}
 */
export function unresolvedReads(orderedOps, { base } = {}) {
  const available = new Set(base ?? []);
  const problems = [];
  for (const op of orderedOps ?? []) {
    const missing = op.reads.filter((t) => !isSatisfied(t, available));
    if (missing.length) problems.push({ op, missing });
    // This op provides its own target AND every address above it: an op that wrote
    // anything under `ds:7` is proof that `ds:7` exists, which is the question this
    // function asks. Whether a *later* write invalidated a reader is a different
    // question — see {@link staleReaders}.
    for (const t of readAncestors(op.target)) available.add(t);
  }
  return problems;
}

/**
 * Every address that would satisfy a read of `target`, from the most specific to the
 * whole aggregate. `ds:7/cell:notes:3` → [`ds:7/cell:notes:3`, `ds:7/cell:notes`, `ds:7`].
 * Splitting on both `/` and `:` is what lets a whole-dataset write cover one of its
 * cells; the aggregate root (`ds:7`) is the coarsest thing anyone can write.
 */
export function readAncestors(target) {
  const t = String(target ?? '');
  if (!t) return [];
  const out = [t];
  const slash = t.indexOf('/');
  if (slash === -1) return out;
  const root = t.slice(0, slash);
  let rest = t.slice(slash + 1);
  while (rest.includes(':')) {
    rest = rest.slice(0, rest.lastIndexOf(':'));
    out.push(`${root}/${rest}`);
  }
  out.push(root);
  return out;
}

/** Is a read of `target` satisfied by anything already available? */
function isSatisfied(target, available) {
  return readAncestors(target).some((t) => available.has(t));
}

/**
 * **Drift**: ops whose reads are written AFTER them.
 *
 * A different question from {@link unresolvedReads}, and the one that actually matters
 * for anchored records. "Unresolved" asks *is a writer missing before me* — and once
 * ancestor matching is in place a dataset's `load` satisfies every read inside it, so a
 * later edit to one of those cells no longer registers there at all. Drift asks *does
 * something I depend on change after me*, which is precisely: this coding was made
 * against text that has since been edited, so its anchor may no longer point where it
 * did.
 *
 * Detection only — the anchor's own resolution decides whether the region actually moved
 * (a coding earlier in a document is untouched by an edit later in it). This narrows
 * "everything in the project" to "these records, because of these ops", which is what
 * makes a staleness check affordable at all.
 *
 * **Aggregate writes.** Some ops replace their whole aggregate rather than one leaf — a
 * `load` is the dataset's replace barrier, so it changes every cell in it, yet its
 * address (`ds:7/source:<tok>`) is a sibling of the cells rather than an ancestor. No
 * address-only rule can know that, and guessing from the shape would be exactly the kind
 * of inference this codebase refuses elsewhere. So the caller declares it:
 * `isAggregateWrite` promotes such an op to its aggregate root, where the path rule then
 * does the right thing. Left undeclared, only leaf-level writes are considered — which
 * under-reports rather than over-reports, the safer direction for a check whose output is
 * shown to a user.
 *
 * @param {Op[]} orderedOps  ops in the order to check
 * @param {{isReader?: (op: Op) => boolean, isAggregateWrite?: (op: Op) => boolean}} [opts]
 * @returns {Array<{op: Op, staleReads: string[], writers: Op[]}>}
 */
export function staleReaders(orderedOps, { isReader, isAggregateWrite } = {}) {
  const all = orderedOps ?? [];
  const list = all.filter((op) => op.reads?.length && (!isReader || isReader(op)));
  if (!list.length) return [];

  // The address a write effectively lands on, once aggregate replacement is accounted for.
  const addrOf = (op) => {
    if (!isAggregateWrite?.(op)) return op.target;
    const anc = readAncestors(op.target);
    return anc[anc.length - 1] ?? op.target; // the aggregate root
  };

  // Index every write by effective address once, rather than rescanning per reader.
  const writesAt = new Map();
  all.forEach((op, i) => {
    const addr = addrOf(op);
    if (!writesAt.has(addr)) writesAt.set(addr, []);
    writesAt.get(addr).push({ op, i });
  });
  const indexOfOp = new Map(all.map((op, i) => [op.id, i]));

  // A write affects a read when the two addresses are on ONE path: the write is the read,
  // something inside it, or the whole thing it belongs to. Two sibling cells are not on
  // one path, which is what keeps a busy dataset from reporting every coding as stale.
  const onSamePath = (writeAddr, readAddr) =>
    readAncestors(writeAddr).includes(readAddr) || readAncestors(readAddr).includes(writeAddr);

  const out = [];
  for (const op of list) {
    const at = indexOfOp.get(op.id) ?? -1;
    const staleReads = [];
    const writers = [];
    for (const t of op.reads) {
      for (const [addr, entries] of writesAt) {
        if (!onSamePath(addr, t)) continue;
        const after = entries.filter((e) => e.i > at);
        if (!after.length) continue;
        if (!staleReads.includes(t)) staleReads.push(t);
        for (const e of after) if (!writers.includes(e.op)) writers.push(e.op);
      }
    }
    if (staleReads.length) out.push({ op, staleReads, writers });
  }
  return out;
}
