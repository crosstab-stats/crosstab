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
import { HLC } from './hlc.js';
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

  get canUndo() { return this.#ops.length > 0; }
  get canRedo() { return this.#redo.length > 0; }

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
