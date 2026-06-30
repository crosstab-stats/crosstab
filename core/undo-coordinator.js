/**
 * @file undo-coordinator.js
 * One Undo/Redo across BOTH kinds of history — data operations and analysis runs.
 *
 * The data-store owns undo/redo for data ops; analyses live in a separate log. Once
 * analyses appear in the History timeline, a single "Undo" must act on whichever was
 * the most recent action — otherwise undoing right after an analysis silently reverts
 * an earlier data edit and leaves the analysis (and its now-stale output) behind.
 *
 * This coordinator records the ORDER of actions (data vs analysis) and routes Undo:
 *  - most recent was an **analysis** → drop that analysis and its output blocks
 *    (no data change);
 *  - most recent was a **data op** → delegate to the data-store's own undo.
 *
 * It never mutates data directly (data goes through `datasets.undo/redo`), so a
 * desync in an exotic flow degrades to a mis-routed (but safe) undo, never data loss.
 * New-dataset loads (`replace`) reset both stacks.
 */

import { CoreEvents } from './event-bus.js';

/** DATA_CHANGED reasons that represent a NEW, undoable data action (vs undo/redo/
 * reorder/restore, which aren't new actions). */
const NEW_DATA_REASONS = new Set(['transform', 'append', 'join']);

export class UndoCoordinator {
  #datasets;
  #analysisLog;
  #results;
  #pluginActions;
  /** @type {Array<{kind:'data'}|{kind:'analysis',entry:object}>} */
  #undo = [];
  #redo = [];

  constructor({ datasets, analysisLog, results, pluginActions, bus }) {
    this.#datasets = datasets;
    this.#analysisLog = analysisLog;
    this.#results = results;
    this.#pluginActions = pluginActions;

    bus.on(CoreEvents.DATA_CHANGED, (s) => {
      const r = s && s.reason;
      if (r === 'replace') { this.#undo = []; this.#redo = []; } // new dataset → fresh history
      else if (NEW_DATA_REASONS.has(r)) { this.#undo.push({ kind: 'data' }); this.#redo = []; }
    });
    bus.on('analysislog:recorded', (entry) => {
      this.#undo.push({ kind: 'analysis', entry });
      this.#redo = [];
    });
  }

  get canUndo() {
    const top = this.#undo[this.#undo.length - 1];
    return top?.kind === 'analysis' ? true : this.#datasets.canUndo;
  }

  get canRedo() {
    const top = this.#redo[this.#redo.length - 1];
    return top?.kind === 'analysis' ? true : this.#datasets.canRedo;
  }

  /** True when the most recent (not-yet-undone) action is an analysis — the History
   * timeline marks that analysis 'current'. */
  lastActionIsAnalysis() {
    return this.#undo[this.#undo.length - 1]?.kind === 'analysis';
  }

  async undo() {
    const top = this.#undo[this.#undo.length - 1];
    if (top?.kind === 'analysis') {
      this.#undo.pop();
      const n = this.#analysisLog.count;
      if (n > 0) {
        const entry = this.#analysisLog.entries()[n - 1];
        this.#analysisLog.remove(n - 1); // drop the step (timeline re-renders)
        const mark = Number.isFinite(entry?.outputMark) ? entry.outputMark : null;
        if (mark != null) this.#results.truncateTo?.(mark); // drop its output blocks
        this.#redo.push({ kind: 'analysis', entry });
      }
      return;
    }
    if (this.#datasets.canUndo) {
      await this.#datasets.undo(); // fires DATA_CHANGED 'undo' — ignored by our observer
      if (top) this.#undo.pop();
      this.#redo.push({ kind: 'data' });
    }
  }

  async redo() {
    const top = this.#redo[this.#redo.length - 1];
    if (top?.kind === 'analysis') {
      this.#redo.pop();
      this.#analysisLog.restore(top.entry);
      this.#undo.push({ kind: 'analysis', entry: top.entry });
      await this.#pluginActions.replay?.(top.entry); // re-run to regenerate its output
      return;
    }
    if (this.#datasets.canRedo) {
      await this.#datasets.redo();
      if (top) this.#redo.pop();
      this.#undo.push({ kind: 'data' });
    }
  }
}
