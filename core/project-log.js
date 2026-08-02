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
import { HLC, hlcEncode } from './hlc.js';
import { makeOp, orderByHlc, sharedAncestor, unresolvedReads, opIds } from './op-log.js';

/**
 * @typedef {Object} Projection
 * @property {string} key                     Stable name (for `state(key)`).
 * @property {(op: import('./op-log.js').Op) => boolean} match  Which ops it consumes.
 * @property {(ops: import('./op-log.js').Op[]) => *} fold      Pure replay → derived state.
 */

export class ProjectLog {
  /** @type {import('./op-log.js').Op[]} active ops (unordered internally; ordered on read). */
  #ops = [];
  /** @type {import('./op-log.js').Op[]} undone ops (redo stack), most-recently-undone last. */
  #redo = [];
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
    this.#redo = []; // a new action discards the redo branch (standard undo semantics)
    return op;
  }

  /**
   * Fold in **remote** ops (from a peer / a loaded file): advance the clock past each
   * and add the ones we don't already have (dedup by id — ops are immutable, so a
   * shared id means identical content). Does not merge/resolve — that's {@link merge}.
   * @param {import('./op-log.js').Op[]} ops
   */
  receiveOps(ops) {
    const have = new Set([...opIds(this.#ops), ...opIds(this.#redo)]);
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
    const row = (o, state) => ({
      state,
      hlc: hlcEncode(o.hlc),
      target: o.target,
      owner: o.owner,
      type: o.type,
      author: o.author?.initials ?? o.author?.authorId ?? '',
      payload: o.payload ? JSON.stringify(o.payload).slice(0, 120) : '',
      reads: (o.reads ?? []).join(',') || '',
      id: o.id,
    });
    return [
      ...this.ops().map((o) => row(o, 'active')),
      ...this.#redo.map((o) => row(o, 'undone')),
    ];
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

  /** Commit a merged op set (from {@link merge}) as the new log; clears redo. */
  adopt(ops) {
    this.#ops = [...(ops ?? [])];
    this.#redo = [];
  }

  /** Empty the log (both active and redo). Used when replacing the whole project
   * (e.g. loading a different bundle). */
  reset() {
    this.#ops = [];
    this.#redo = [];
  }

  /** Drop every op (active + redo) matching `pred` — clears ONE tier/projection of a
   * shared log without disturbing the others (e.g. reload the dataset collection while
   * leaving the analysis tier alone). */
  clearWhere(pred) {
    this.#ops = this.#ops.filter((o) => !pred(o));
    this.#redo = this.#redo.filter((o) => !pred(o));
  }

  get canUndo() { return this.#ops.length > 0; }
  get canRedo() { return this.#redo.length > 0; }

  /** Whether any active / undone op matches `pred` — scoped undo/redo availability
   * (e.g. "does THIS dataset have anything to undo?" on the shared log). */
  canUndoWhere(pred) { return this.#ops.some(pred); }
  canRedoWhere(pred) { return this.#redo.some(pred); }

  /**
   * Undo the highest-HLC **active** op matching `pred` (scoped to one tier/dataset on
   * the shared log), moving it onto the redo stack. Re-fold happens on the next
   * {@link state}/{@link slice} read. Returns the undone op, or null if none match.
   * (Solo semantics; the collaborative "whose op may I undo" nuance is deferred, as
   * for {@link undo}.)
   */
  undoWhere(pred) {
    const matching = orderByHlc(this.#ops.filter(pred));
    const last = matching[matching.length - 1];
    if (!last) return null;
    this.#ops = this.#ops.filter((o) => o.id !== last.id);
    this.#redo.push(last);
    return last;
  }

  /** Re-apply the most-recently-undone op matching `pred`. Returns it, or null. */
  redoWhere(pred) {
    for (let i = this.#redo.length - 1; i >= 0; i--) {
      if (pred(this.#redo[i])) {
        const [op] = this.#redo.splice(i, 1);
        this.#ops.push(op);
        return op;
      }
    }
    return null;
  }

  /** The undone (redo-stack) ops matching `pred`, in undo order (most-recently-undone
   * last) — the raw material for a History panel's "future" list. A copy. */
  undoneOps(pred = () => true) {
    return this.#redo.filter(pred);
  }

  /** Undo the latest op (highest HLC) onto the redo stack. Re-fold happens on the next
   * {@link state} read. (Collaborative "whose op may I undo" nuance is deferred — for
   * now the newest op wins, matching single-author expectation.) */
  undo() {
    if (!this.#ops.length) return null;
    const ordered = orderByHlc(this.#ops);
    const last = ordered[ordered.length - 1];
    this.#ops = this.#ops.filter((o) => o.id !== last.id);
    this.#redo.push(last);
    return last;
  }

  /** Re-apply the most recently undone op. */
  redo() {
    if (!this.#redo.length) return null;
    const op = this.#redo.pop();
    this.#ops.push(op);
    return op;
  }
}
