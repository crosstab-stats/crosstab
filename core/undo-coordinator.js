/**
 * @file undo-coordinator.js
 * ONE Undo/Redo across every tier that records user actions — data operations, analysis
 * runs, and plugin item records (coding, boundary sets, memos).
 *
 * ## Why it is HLC-ordered rather than stack-ordered
 *
 * The original coordinator kept its own push-down stack of `{kind}` markers, fed by bus
 * events, and routed Undo to whichever kind was on top. That worked while there were two
 * kinds, both of which emitted an event it listened for. It broke the moment a third
 * arrived: coding a passage wrote a `putItem` the coordinator never heard about, so Ctrl-Z
 * skipped past it and silently reverted an older DATA op instead — the user's coding
 * looked un-undoable while an unrelated transform quietly disappeared. Worse than doing
 * nothing.
 *
 * The fix is to stop keeping a private ordering at all. Every action is already an op in
 * the one true log, stamped with an HLC, so "what was the most recent action?" has a real
 * answer: the newest applied op across the tiers. That is the #149 C7 decision ("undo
 * targets the highest live HLC") extended to every tier, and it cannot fall out of step
 * with the log the way a parallel stack can.
 *
 * ## What still needs a side-stack
 *
 * Analysis runs, and only for their *output*. Undoing a run must also remove the output
 * blocks it produced, and redoing it must re-run the plugin to regenerate them — neither
 * is derivable from the op alone. So the analysis entry is kept alongside, but its
 * PLACE IN TIME is read from the log like everything else.
 */

import { CoreEvents } from './event-bus.js';
import { hlcCompare } from './hlc.js';
import { isItemOp } from './item-store.js';

/** DATA_CHANGED reasons that represent a NEW, undoable data action. */
const NEW_DATA_REASONS = new Set(['transform', 'append', 'join']);

/** Ops belonging to a dataset's own tier (the tabular pipeline). */
const isDataOp = (op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('ds:');
/** Ops recording an analysis run. */
const isAnalysisOp = (op) => typeof op.target === 'string' && op.target.startsWith('analysis:');

export class UndoCoordinator {
  #datasets;
  #analysisLog;
  #results;
  #pluginActions;
  #log;
  #items;
  #onItemsChanged;
  #bus;
  /** Analysis entries by runId, so an undone run can be restored with its output. */
  #analysisById = new Map();
  /** Undone analysis entries, newest last — the only redo state that isn't in the log. */
  #undoneAnalyses = [];

  constructor({ datasets, analysisLog, results, pluginActions, bus, projectLog, itemStore, onItemsChanged }) {
    this.#datasets = datasets;
    this.#analysisLog = analysisLog;
    this.#results = results;
    this.#pluginActions = pluginActions;
    this.#log = projectLog ?? null;
    this.#items = itemStore ?? null;
    this.#onItemsChanged = onItemsChanged ?? (() => {});
    this.#bus = bus ?? null;

    bus.on(CoreEvents.DATA_CHANGED, (s) => {
      // A destructive re-import or a change of which project is in view invalidates the
      // analysis side-stack; the log tiers look after themselves.
      if (s?.reason === 'replace' || s?.reason === 'switch') this.#undoneAnalyses = [];
      // A NEW action discards whatever was still ahead of the cursor (see #discardFuture).
      if (NEW_DATA_REASONS.has(s?.reason)) this.#discardFuture();
    });
    bus.on('analysislog:recorded', (entry) => {
      if (entry?.runId) this.#analysisById.set(entry.runId, entry);
      this.#undoneAnalyses = [];
      this.#discardFuture();
    });
  }

  /** Guards the discard against the DATA_CHANGED its own retracts emit. */
  #discarding = false;

  /**
   * Discard the branch below the cursor when a NEW action is taken.
   *
   * `rewindTo` has documented this since it was written — "a subsequent fresh operation
   * discards whatever is still ahead (standard linear branch-discard), so the timeline
   * stays linear" — and it was never implemented. The consequence was not cosmetic:
   * undo C, append D, and redoing C put it back ABOVE D (the fold orders by HLC), so the
   * History panel drew the undone rows below the applied ones while a redo inserted them
   * in the middle. It also meant a stashed analysis output could be restored into a data
   * state that had moved on underneath it.
   *
   * The discard is an explicit `retract` per op, not a deletion: append-only, auditable,
   * and it propagates to a peer instead of looking like their addition on the next merge.
   */
  #discardFuture() {
    if (!this.#log || this.#discarding) return;
    const undone = this.#log.undoneOps(() => true);
    if (!undone.length) return;
    this.#discarding = true;
    try {
      for (const op of undone) {
        this.#log.append({ target: op.target, owner: op.owner, type: 'retract', payload: { opId: op.id } });
        // That branch is gone, so any output held aside for it is gone too — otherwise a
        // later fast-forward could restore a result whose steps no longer exist.
        const runId = isAnalysisOp(op) ? op.payload?.runId : null;
        if (runId) this.#results.removeRun?.(runId);
      }
      this.#undoneAnalyses = [];
    } finally {
      this.#discarding = false;
    }
  }

  /** The newest applied op in each tier, tagged — the candidates for "most recent action". */
  #candidates() {
    if (!this.#log) return [];
    const out = [];
    const data = this.#log.topUndoable(isDataOp);
    if (data && this.#datasets.canUndo) out.push({ kind: 'data', hlc: data.hlc, op: data });
    const item = this.#log.topUndoable(isItemOp);
    if (item) out.push({ kind: 'item', hlc: item.hlc, op: item });
    const analysis = this.#log.topUndoable(isAnalysisOp);
    if (analysis) out.push({ kind: 'analysis', hlc: analysis.hlc, op: analysis });
    return out.sort((a, b) => hlcCompare(a.hlc, b.hlc));
  }

  /** The action Undo would act on, or null. */
  #top() {
    const c = this.#candidates();
    return c.length ? c[c.length - 1] : null;
  }

  get canUndo() {
    if (this.#log) return !!this.#top();
    return this.#datasets.canUndo;
  }

  get canRedo() {
    if (!this.#log) return this.#datasets.canRedo;
    return !!this.#log.topRedoable(() => true) || this.#undoneAnalyses.length > 0;
  }

  /**
   * The action Undo would act on — `{kind, op}` — or null when there is nothing.
   *
   * Exposed so the Edit menu can NAME it ("Undo: Computed age2"). The coordinator has
   * always known which op it would hit; a bare "Undo" simply never said, which is worst
   * precisely when it matters — after a reorder, or when the last thing you did was in
   * a different tier from the thing you are looking at.
   */
  undoTarget() {
    return this.#top();
  }

  /**
   * The action Redo would act on — `{kind, op}` — or null.
   *
   * Deliberately mirrors what {@link UndoCoordinator#redo} ACTUALLY does (the most
   * recently undone op in the log) rather than {@link UndoCoordinator#canRedo}, which
   * also returns true for an undone analysis whose op is no longer redoable. A menu item
   * that is enabled must do something when clicked.
   */
  redoTarget() {
    if (!this.#log) return null;
    const op = this.#log.topRedoable(() => true);
    if (!op) return null;
    const kind = isDataOp(op) ? 'data' : isItemOp(op) ? 'item' : isAnalysisOp(op) ? 'analysis' : 'data';
    return { kind, op };
  }

  /** True when the most recent action is an analysis — the History timeline marks it. */
  lastActionIsAnalysis() {
    return this.#top()?.kind === 'analysis';
  }

  /** True when the most recent action is a plugin record — so History can mark THAT row
   * 'current' and Undo visibly targets what the user just did. */
  lastActionIsItem() {
    return this.#top()?.kind === 'item';
  }

  async undo() {
    const top = this.#top();
    if (!top) {
      if (this.#datasets.canUndo) await this.#datasets.undo();
      return;
    }
    if (top.kind === 'data') {
      const opId = top.op?.id ?? null;
      await this.#datasets.undo();
      // Drop the confirmation line a compute/recode/filter appended for THIS op, so the
      // Output doesn't claim a transform that's now undone (a no-op for ops with no note).
      if (opId) this.#results.removeByTag?.(opId);
      return;
    }
    if (top.kind === 'item') {
      // Hide the op, refold, and tell whoever is showing that state to re-read it. A
      // coding workspace holds its own in-memory copy, so the fold alone is not enough.
      this.#log.undoWhere((o) => o.id === top.op.id);
      this.#items?.loadFromLog();
      await this.#onItemsChanged();
      return;
    }
    // analysis: hide the op AND drop the output blocks it produced.
    this.#log.undoWhere((o) => o.id === top.op.id);
    // AnalysisLog.entries() folds live from the log, so hiding the op removes the run
    // from the timeline with no extra bookkeeping. Only the OUTPUT needs help.
    const runId = top.op.payload?.runId ?? null;
    const entry = (runId && this.#analysisById.get(runId)) || null;
    if (runId) this.#results.removeRun?.(runId);
    if (entry) this.#undoneAnalyses.push(entry);
    this.#bus?.emit?.('analysislog:changed', {});
  }

  async redo() {
    if (!this.#log) {
      if (this.#datasets.canRedo) await this.#datasets.redo();
      return;
    }
    // Redo mirrors undo: the most recently UNDONE op across tiers wins.
    const top = this.#log.topRedoable(() => true);
    if (!top) return;
    if (isDataOp(top)) { await this.#datasets.redo(); return; }
    if (isItemOp(top)) {
      this.#log.redoWhere((o) => o.id === top.id);
      this.#items?.loadFromLog();
      await this.#onItemsChanged();
      return;
    }
    if (isAnalysisOp(top)) {
      this.#log.redoWhere((o) => o.id === top.id);
      this.#bus?.emit?.('analysislog:changed', {});
      const entry = this.#undoneAnalyses.pop();
      if (entry) await this.#pluginActions.replay?.(entry); // regenerate its output
      return;
    }
    if (this.#datasets.canRedo) await this.#datasets.redo();
  }
}
