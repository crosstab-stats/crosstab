/**
 * @file project-log.js
 * The unified log's stateful core: ONE ordered operation log for a whole project, with
 * pluggable **projections** (read-models) folded from it, one merge that reuses the
 * kernel, and one undo. See docs/ARCHITECTURE-unified-log.md §2/§6/§10/§11.
 *
 * This is the "aggregate primitive" the design calls for. It owns the envelope forever
 * — op identity, the HLC clock, cross-owner interleave order, merge dispatch, and undo.
 * A projection owns only its *fold* (and, at the app edge, its *materialize*): the host
 * never needs to understand a projection's state to store, order, merge, or undo it.
 *
 * Pure and transport-free (no DuckDB, no DOM, no network) so it is headlessly testable;
 * the live wiring (DuckDB folds, the bus, autosave, P2P) sits above it.
 */

import { resolveMerger } from './merge.js';
import { HLC, hlcEncode, hlcCompare } from './hlc.js';
import { makeOp, orderByHlc, sharedAncestor, unresolvedReads, opIds, appliedState } from './op-log.js';

/**
 * @typedef {Object} Projection
 * @property {string} key                     Stable name (for `state(key)`).
 * @property {(op: import('./op-log.js').Op) => boolean} match  Which ops it consumes.
 * @property {(ops: import('./op-log.js').Op[]) => *} fold      Pure replay → derived state.
 */

/**
 * ## API tiers (encapsulation contract)
 *
 * The log is the project's single source of truth, so **who may mutate it, and how, is
 * deliberately restricted** — a bug that reaches in and edits ops directly is the worst
 * kind (silent corruption, broken audit trail, merge divergence). The methods split into
 * three tiers:
 *
 * - **Feature (the only writes ordinary code makes):** {@link ProjectLog#append}. Every
 *   domain change — including *deletion* (append a `retract`/`removeDataset`) and
 *   *reorder* (append a `reorder`) — is an appended op. Feature code never removes or
 *   rewrites ops; it appends new ones the fold interprets.
 * - **History navigation:** {@link ProjectLog#undo}/{@link ProjectLog#redo} and their
 *   scoped `*Where` forms, plus {@link ProjectLog#discardLocal} (roll back a *just-made*
 *   local append that failed validation, before it was ever durable). These mutate, but
 *   only the tail the user/appender just created.
 * - **Lifecycle (rare, restricted to new/save/load/merge/sync):**
 *   {@link ProjectLog#reset}, {@link ProjectLog#clearWhere}, {@link ProjectLog#restore},
 *   {@link ProjectLog#serialize}, {@link ProjectLog#receiveOps}, {@link ProjectLog#adopt}.
 *   These replace or bulk-clear whole tiers and belong to the persistence/transport
 *   layer — NOT to any editing/feature path. (`clearWhere` in particular is a tier
 *   *replace* during load/reload, never a way to "delete some ops" mid-edit.)
 *
 * `#ops` is private; the tiers above are the entire mutation surface. There is **no
 * redo stack** — undo/redo are ordinary appended ops (`undo`/`redo`, payload `{opId}`),
 * so undo state persists and merges like everything else (an undone op is hidden by the
 * liveness fold, never removed). See {@link module:core/op-log~liveOps}.
 */
export class ProjectLog {
  /** @type {import('./op-log.js').Op[]} every op ever appended (ordered on read). Undo is
   * an appended `undo` op, not a removal — the log only grows (Seal is the deliberate,
   * rare exception). */
  #ops = [];
  /** @type {HLC} */
  #hlc;
  /** @type {() => object} */
  #author;
  /** @type {Record<string, object>} owner → merge declaration (from buildMergers). */
  #mergers;
  /** @type {Map<string, Projection>} */
  #projections = new Map();

  /**
   * @param {object} [opts]
   * @param {HLC} [opts.hlc]                 the peer's clock (default: fresh HLC).
   * @param {() => object} [opts.author]     current author snapshot provider.
   * @param {Record<string, object>} [opts.mergers]  owner → merge decl; `core` defaults
   *   to three-way. Plugins supply their own; unknown owners fall back to three-way.
   */
  constructor({ hlc, author, mergers } = {}) {
    this.#hlc = hlc ?? new HLC();
    this.#author = author ?? (() => ({ authorId: 'local' }));
    this.#mergers = mergers ?? {};
  }

  /** Register a projection (read-model). Later `state(key)` folds it from the log. */
  register(projection) {
    this.#projections.set(projection.key, projection);
    return this;
  }

  /** All active ops, in canonical HLC order (a copy). */
  ops() {
    return orderByHlc(this.#ops);
  }

  /**
   * The active ops matching `pred`, in canonical HLC order — the slice a
   * projection folds (e.g. one dataset's `ds:<id>/…` ops, or one tier's). A copy;
   * safe to hold. This is how {@link DataStore} reads its own history without a
   * private log: it pulls `slice(o => o.target.startsWith('ds:5/'))` and replays.
   * @param {(op: import('./op-log.js').Op) => boolean} pred
   * @returns {import('./op-log.js').Op[]}
   */
  slice(pred) {
    return orderByHlc(this.#ops.filter(pred));
  }

  /**
   * Serialise the log for persistence: the active ops in canonical HLC order. The
   * clock is deliberately NOT stored alongside — {@link restore} advances it past
   * every op via {@link receiveOps}, which is monotonic (see hlc.js), so a reloaded
   * project's next local op always sorts after everything saved. The redo stack is
   * session-only (standard undo semantics) and is not persisted.
   * @returns {import('./op-log.js').Op[]}
   */
  serialize() {
    return this.ops();
  }

  /**
   * Replace the whole log with a persisted / rebuilt op set (from {@link serialize},
   * a bundle, or a merge result being loaded fresh). Clears the log + redo, then
   * folds the ops in via {@link receiveOps} so the clock advances past all of them.
   * @param {import('./op-log.js').Op[]} ops
   * @returns {this}
   */
  restore(ops) {
    this.reset();
    this.receiveOps(ops);
    return this;
  }

  /**
   * Append a **local** operation: stamp a fresh HLC + id + author, add it, and return
   * it. `reads` declares the targets it depends on (the causal DAG); default none.
   * @param {{target:string, owner:string, type:string, payload?:object, reads?:string[]}} body
   * @returns {import('./op-log.js').Op}
   */
  append(body) {
    const op = makeOp(body, { hlc: this.#hlc.tick(), author: this.#author() });
    this.#ops.push(op);
    return op;
  }

  /**
   * Fold in **remote** ops (from a peer / a loaded file): advance the clock past each
   * and add the ones we don't already have (dedup by id — ops are immutable, so a
   * shared id means identical content). Does not merge/resolve — that's {@link merge}.
   * @param {import('./op-log.js').Op[]} ops
   */
  receiveOps(ops) {
    const have = opIds(this.#ops);
    for (const op of ops ?? []) {
      this.#hlc.receive(op.hlc);
      if (!have.has(op.id)) { this.#ops.push(op); have.add(op.id); }
    }
  }

  /**
   * Debug view of the **whole** log: every active op (in HLC order) followed by every
   * undone (redo-stack) op, flattened to plain rows for console inspection. Unlike a
   * projection's folded state (or `DataStore.getHistory`), this shows what the fold
   * hides — `retract`/`reorder` tombstones, undone ops, and every tier at once — with
   * the routing fields that matter for merge debugging (target/owner/hlc/author).
   * Not for persistence (use {@link serialize}); built to trace merge issues.
   * @returns {Array<{state:string, hlc:string, target:string, owner:string, type:string, author:string, payload:string, reads:string, id:string}>}
   */
  dump() {
    const ordered = this.ops();
    const applied = appliedState(ordered);
    // Which content ops an applied retract has dropped (for the state column).
    const retracted = new Set();
    for (const o of ordered) if (o.type === 'retract' && applied(o.id) && o.payload?.opId != null) retracted.add(o.payload.opId);
    const stateOf = (o) => {
      if (o.type === 'undo' || o.type === 'redo' || o.type === 'retract' || o.type === 'reorder') {
        return applied(o.id) ? o.type : `${o.type}(undone)`;
      }
      if (!applied(o.id)) return 'undone';
      if (retracted.has(o.id)) return 'retracted';
      return 'active';
    };
    return ordered.map((o) => ({
      state: stateOf(o),
      hlc: hlcEncode(o.hlc),
      target: o.target,
      owner: o.owner,
      type: o.type,
      author: o.author?.initials ?? o.author?.authorId ?? '',
      payload: o.payload ? JSON.stringify(o.payload).slice(0, 120) : '',
      reads: (o.reads ?? []).join(',') || '',
      id: o.id,
    }));
  }

  /** The derived state of a registered projection (folds its ops in HLC order). */
  state(key) {
    const p = this.#projections.get(key);
    if (!p) throw new Error(`ProjectLog: no projection "${key}"`);
    return p.fold(orderByHlc(this.#ops.filter((o) => p.match(o))));
  }

  /**
   * Three-way merge this log against another peer's ops, WITHOUT mutating (call
   * {@link adopt} to commit a clean/resolved result). The common ancestor is derived
   * from the shared op-id set (no separate base). Ops are partitioned by **owner** and
   * each owner's set run through its declared merger (core → three-way); results are
   * reassembled in global HLC order. Returns the merged ops, every conflict across all
   * owners, and any `reads[]` left dangling by the merge.
   *
   * @param {import('./op-log.js').Op[]} theirs
   * @param {{resolutions?: object|null, base?: Iterable<string>}} [opts]
   * @returns {{ops: import('./op-log.js').Op[], conflicts: object[], dangling: Array<{op:object,missing:string[]}>}}
   */
  merge(theirs, { resolutions = null, base } = {}) {
    const mine = this.#ops;
    const ancestor = sharedAncestor(mine, theirs);
    const byOwner = (ops) => {
      const m = new Map();
      for (const o of ops ?? []) {
        let arr = m.get(o.owner);
        if (!arr) { arr = []; m.set(o.owner, arr); }
        arr.push(o);
      }
      return m;
    };
    const aO = byOwner(ancestor);
    const mO = byOwner(mine);
    const tO = byOwner(theirs);
    const owners = new Set([...aO.keys(), ...mO.keys(), ...tO.keys()]);

    let merged = [];
    const conflicts = [];
    for (const owner of owners) {
      const decl = this.#mergers[owner] ?? { strategy: 'three-way' };
      const r = resolveMerger(decl, { resolutions, scope: owner })(aO.get(owner) ?? [], mO.get(owner) ?? [], tO.get(owner) ?? [], owner);
      if (Array.isArray(r.resolved)) merged.push(...r.resolved);
      conflicts.push(...(r.conflicts ?? []));
    }
    merged = orderByHlc(merged);
    return { ops: merged, conflicts, dangling: unresolvedReads(merged, { base }) };
  }

  /** Commit a merged op set (from {@link merge}) as the new log. */
  adopt(ops) {
    this.#ops = [...(ops ?? [])];
  }

  /** Empty the log. Used when replacing the whole project (e.g. loading a bundle). */
  reset() {
    this.#ops = [];
  }

  /** **Lifecycle only.** Drop every op matching `pred` — a tier *replace* during
   * load/reload (e.g. rebuild the dataset collection while leaving the analysis tier
   * alone). NOT an editing primitive: to delete a durable op during normal work, append a
   * `retract` (physical removal is merge-unsafe). To roll back a failed *just-appended*
   * local op, use {@link ProjectLog#discardLocal}; to reversibly hide one, {@link ProjectLog#undoWhere}. */
  clearWhere(pred) {
    this.#ops = this.#ops.filter((o) => !pred(o));
  }

  /**
   * Roll back a **just-appended local op that failed validation** before it became
   * durable — the only sanctioned physical removal of a specific op by feature code.
   * Use it when an {@link ProjectLog#append} you just made turns out invalid (e.g. it
   * generated SQL that won't run) and must vanish as if never attempted. It is NOT a way
   * to edit established history: to remove a durable/shared op append a `retract`, and to
   * reversibly hide one use {@link ProjectLog#undoWhere} (both merge-safe; a physical
   * drop of a durable op resurrects from a peer that still has it).
   * @param {string} opId
   */
  discardLocal(opId) {
    this.#ops = this.#ops.filter((o) => o.id !== opId);
  }

  // --- undo / redo: append-only, no redo stack -------------------------------
  // Undo/redo are ordinary ops (`undo`/`redo`, payload {opId}) targeted at the undone
  // op's OWN target, so the liveness fold ({@link module:core/op-log~liveOps}) sees them
  // in the same slice and hides/shows the op. State derives entirely from the log — no op
  // is ever moved or removed — so undo state persists on save and merges like any op.

  /** Ops matching `pred` that are undoable now: content/structural ops (never undo/redo
   * markers) currently applied (shown), in HLC order — the highest is the "latest action". */
  #undoable(pred) {
    const ordered = orderByHlc(this.#ops);
    const applied = appliedState(ordered);
    return ordered.filter(
      (o) => pred(o) && o.type !== 'undo' && o.type !== 'redo' && applied(o.id),
    );
  }

  /** Ops matching `pred` currently hidden by an undo (redoable), each with the undo
   * marker that hid it — sorted oldest-undo first (the newest is the next redo target). */
  #redoable(pred) {
    const latest = new Map();
    for (const m of orderByHlc(this.#ops)) {
      if ((m.type === 'undo' || m.type === 'redo') && m.payload?.opId != null) latest.set(m.payload.opId, m);
    }
    const byId = new Map(this.#ops.map((o) => [o.id, o]));
    const out = [];
    for (const [opId, m] of latest) {
      if (m.type !== 'undo') continue;
      const op = byId.get(opId);
      if (op && op.type !== 'undo' && op.type !== 'redo' && pred(op)) out.push({ op, marker: m });
    }
    return out.sort((a, b) => hlcCompare(a.marker.hlc, b.marker.hlc) || (a.marker.id < b.marker.id ? -1 : 1));
  }

  get canUndo() { return this.canUndoWhere(() => true); }
  get canRedo() { return this.canRedoWhere(() => true); }

  /** Whether anything matching `pred` can be undone / redone (scoped availability on the
   * shared log — e.g. "does THIS dataset have anything to undo?"). */
  canUndoWhere(pred) { return this.#undoable(pred).length > 0; }
  canRedoWhere(pred) { return this.#redoable(pred).length > 0; }

  /**
   * Undo the latest applied op matching `pred` (scoped to one tier/dataset) by
   * **appending** an `undo{opId}` op targeted at that op — the fold then hides it. Re-fold
   * happens on the next {@link state}/{@link slice} read. Returns the appended undo op, or
   * null if there is nothing to undo.
   */
  undoWhere(pred) {
    const cands = this.#undoable(pred);
    const last = cands[cands.length - 1];
    if (!last) return null;
    return this.append({ target: last.target, owner: last.owner, type: 'undo', payload: { opId: last.id } });
  }

  /** Redo the most-recently-undone op matching `pred` by **appending** a `redo{opId}` op.
   * Returns the appended redo op, or null. */
  redoWhere(pred) {
    const cands = this.#redoable(pred);
    const top = cands[cands.length - 1]; // newest undo = next to redo
    if (!top) return null;
    return this.append({ target: top.op.target, owner: top.op.owner, type: 'redo', payload: { opId: top.op.id } });
  }

  /** The currently-undone content ops matching `pred`, oldest-undo first — a History
   * panel's "future" list (reverse it for newest-first, the redo order). */
  undoneOps(pred = () => true) {
    return this.#redoable(pred).map((e) => e.op);
  }

  /** Undo the latest applied op anywhere (appends an `undo` op). */
  undo() { return this.undoWhere(() => true); }

  /** Redo the most-recently-undone op anywhere (appends a `redo` op). */
  redo() { return this.redoWhere(() => true); }
}
