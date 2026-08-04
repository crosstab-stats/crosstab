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
      void NEW_DATA_REASONS;
    });
    bus.on('analysislog:recorded', (entry) => {
      if (entry?.runId) this.#analysisById.set(entry.runId, entry);
      this.#undoneAnalyses = [];
    });
  }

  /** The newest applied op in each tier, tagged — the candidates for "most recent action". */
  #candidates() {
    if (!this.#log) return [];
    const out = [];
    const data = this.#log.topUndoable(isDataOp);
    if (data && this.#datasets.canUndo) out.push({ kind: 'data', hlc: data.hlc });
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

  /** True when the most recent action is an analysis — the History timeline marks it. */
  lastActionIsAnalysis() {
    return this.#top()?.kind === 'analysis';
  }

  async undo() {
    const top = this.#top();
    if (!top) {
      if (this.#datasets.canUndo) await this.#datasets.undo();
      return;
    }
    if (top.kind === 'data') {
      await this.#datasets.undo();
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
