/**
 * @file analysis-log.js
 * An ordered, replayable record of the **analyses** the user has run — the missing
 * half of CrossTab's "script". The data-store already keeps a universal log of
 * data operations (load/recode/compute/filter…) that it can replay to rebuild the
 * dataset; this is the analogous log for analysis *runs* (crosstabs, regression,
 * plots) so they can be re-executed to reproduce the Output pane.
 *
 * ## Unit 5: a projection on the unified log
 *
 * Analysis runs are now **ops on the shared {@link ProjectLog}** (target
 * `analysis:<runId>`, owner `core`), and the list is the `analysis` **projection**'s
 * fold — see docs/ARCHITECTURE-unified-log.md §7. Each run therefore carries a stable
 * `runId` (identity for merge), replacing the old positional array. The public API
 * (`record`/`entries`/`remove`/`restore`/`count`/`toJSON`/`load`/`clear`) and the two
 * bus signals are unchanged, so `PluginActions`, `UndoCoordinator`, and the project
 * save/restore keep working exactly as before. The actual cross-peer *merge* of the
 * list lights up in unit 6 (when the transport merge moves onto the log); the pixels
 * are always regenerated (a `materialize`), never merged.
 *
 * The re-execution itself lives in {@link PluginActions}; this class just holds the
 * ordered entries (now via the log) and notifies listeners when they change.
 *
 * @typedef {Object} AnalysisEntry
 * @property {string} runId      - stable identity of this run (for merge/undo).
 * @property {string} pluginId   - owning plugin id (for loader.invoke).
 * @property {string} pluginName - display name (for the output section attribution).
 * @property {string} origin     - host-tracked origin label ("built-in", "from …").
 * @property {string} label      - menu item label (the output section heading).
 * @property {string} run        - the plugin's exported function name to invoke.
 * @property {Array<object>} specs - the item's declared `inputs` (to re-bind R inputs on replay).
 * @property {object} inputs     - the gathered input values (the replayable params).
 * @property {number|string} [datasetId] - the dataset this run analysed, so a
 *   destructive re-import of that dataset clears only its own analyses.
 */

import { newOpId } from './merge.js';
import { liveOps } from './op-log.js';
import { ProjectLog } from './project-log.js';

/** The analysis-run projection: folds runAnalysis/removeAnalysis ops into the ordered
 * list of runs (keyed by `runId`, so a re-added run after a remove reappears). */
const ANALYSIS = {
  key: 'analysis',
  match: (op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('analysis:'),
  fold: (ops) => {
    const runs = new Map();
    for (const op of liveOps(ops)) { // undone run/remove ops are hidden by the liveness fold
      if (op.type === 'runAnalysis') runs.set(op.payload.runId, op.payload);
      else if (op.type === 'removeAnalysis') runs.delete(op.payload.runId);
    }
    return [...runs.values()];
  },
};

export class AnalysisLog {
  /** @type {import('./event-bus.js').EventBus|null} */
  #bus;
  /** @type {ProjectLog} */
  #log;

  /**
   * @param {import('./event-bus.js').EventBus} [bus]
   * @param {ProjectLog} [projectLog]  the shared project log (default: a fresh one).
   */
  constructor(bus = null, projectLog) {
    this.#bus = bus;
    this.#log = projectLog ?? new ProjectLog();
    this.#log.register(ANALYSIS);
  }

  /** Append a completed analysis as a `runAnalysis` op (minting a stable `runId`).
   * Emits the distinct `analysislog:recorded` signal (a NEW run — the undo coordinator
   * tracks it as the latest action) plus the generic `changed`. */
  record(entry) {
    // Reuse the runId the runner already stamped onto this analysis's output blocks
    // (PluginActions#execute), so the log entry and its output share ONE identity and
    // output can be removed by id. Mint one only if a caller records without running.
    const payload = { ...structuredClone(entry), runId: entry.runId ?? newOpId() };
    this.#log.append({ target: `analysis:${payload.runId}`, owner: 'core', type: 'runAnalysis', payload });
    this.#bus?.emit?.('analysislog:recorded', structuredClone(payload));
    this.#changed();
  }

  /** Re-append a previously-removed entry (undo's redo) without emitting a new-run
   * signal — it isn't a fresh action. Re-adds by its existing `runId`. */
  restore(entry) {
    const payload = structuredClone(entry);
    if (!payload.runId) payload.runId = newOpId();
    this.#log.append({ target: `analysis:${payload.runId}`, owner: 'core', type: 'runAnalysis', payload });
    this.#changed();
  }

  /** A deep copy of the ordered entries (safe to hand to callers/serialisers). */
  entries() {
    return this.#log.state('analysis').map((e) => structuredClone(e));
  }

  /** How many analyses are logged. */
  get count() {
    return this.#log.state('analysis').length;
  }

  /** Drop the entry at `index` (e.g. the user deleted that step) — a `removeAnalysis` op. */
  remove(index) {
    const runs = this.#log.state('analysis');
    if (index < 0 || index >= runs.length) return;
    const runId = runs[index].runId;
    this.#log.append({ target: `analysis:${runId}`, owner: 'core', type: 'removeAnalysis', payload: { runId } });
    this.#changed();
  }

  /** Move the entry at `from` to `to`. NOTE: order is now the log's HLC order; an
   * explicit reorder op is future work (this method has no callers today). No-op. */
  move(_from, _to) {
    // Reordering under the unified log needs a dedicated order op (deferred); left as a
    // no-op rather than silently corrupting HLC order. Unused in the app today.
  }

  /**
   * Remove every live analysis by **appending a `removeAnalysis` op for each** — the
   * log-native deletion. It is deliberately NOT `clearWhere`: physically dropping the
   * runs takes them out of the shared-id ancestor, so on the next merge a peer that
   * still holds them reads them as *their* addition and every cleared analysis comes
   * back (the delete-inference class #148 exists to kill). Appending the removals makes
   * the clear propagate instead.
   *
   * @param {(entry: object) => boolean} [pred] - Limit the clear to matching runs.
   */
  clear(pred) {
    const runs = this.#log.state('analysis').filter((e) => (pred ? pred(e) : true));
    if (!runs.length) return;
    for (const { runId } of runs) {
      this.#log.append({ target: `analysis:${runId}`, owner: 'core', type: 'removeAnalysis', payload: { runId } });
    }
    this.#changed();
  }

  /**
   * Clear only the analyses that ran against one dataset — what a destructive
   * re-import of THAT dataset invalidates. Runs recorded before `datasetId` was tracked
   * carry none, and are left alone rather than guessed at: a stale entry the user can
   * re-run is a far smaller harm than silently deleting analyses of a dataset that was
   * never touched.
   *
   * @param {number|string} datasetId
   */
  clearFor(datasetId) {
    if (datasetId == null) return;
    this.clear((e) => e.datasetId != null && String(e.datasetId) === String(datasetId));
  }

  /** Serialise for the project bundle: the tier's **raw** ops (runAnalysis/removeAnalysis
   * envelopes in HLC order, stable ids/hlc/author preserved) — the one true log, not the
   * folded entry list. This lets deletions (removeAnalysis) and identity survive a
   * save/reload and a merge, exactly like the data and collection tiers. */
  toJSON() {
    return this.#log.slice(ANALYSIS.match);
  }

  /** Restore from a serialised op array (project load): clear this tier, then fold the
   * raw ops back in **preserving their ids** (via receiveOps) so identity is stable for
   * merge. Does NOT replay — the caller decides when to re-execute. */
  load(ops) {
    this.#log.clearWhere(ANALYSIS.match);
    this.#log.receiveOps(Array.isArray(ops) ? ops : []);
    this.#changed();
  }

  #changed() {
    this.#bus?.emit?.('analysislog:changed');
  }
}
