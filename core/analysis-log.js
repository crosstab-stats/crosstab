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
 */

import { newOpId } from './merge.js';
import { makeOp } from './op-log.js';
import { ProjectLog } from './project-log.js';

/** The analysis-run projection: folds runAnalysis/removeAnalysis ops into the ordered
 * list of runs (keyed by `runId`, so a re-added run after a remove reappears). */
const ANALYSIS = {
  key: 'analysis',
  match: (op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('analysis:'),
  fold: (ops) => {
    const runs = new Map();
    for (const op of ops) {
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

  /** Remove every analysis (a fresh project / cleared output) — clears only this tier
   * of the shared log. */
  clear() {
    if (!this.#log.state('analysis').length) return;
    this.#log.clearWhere(ANALYSIS.match);
    this.#changed();
  }

  /** Serialise for the project bundle (entries carry their `runId`). */
  toJSON() {
    return this.#log.state('analysis').map((e) => structuredClone(e));
  }

  /** Restore from a serialised array (project load). Clears this tier then rebuilds it
   * with deterministic ids/clock so it's identical across loads. Does NOT replay — the
   * caller decides when to re-execute. Entries saved before unit 5 lack a `runId`; one
   * is minted deterministically from the index. */
  load(arr) {
    this.#log.clearWhere(ANALYSIS.match);
    const ops = (Array.isArray(arr) ? arr : []).map((e, i) => {
      const runId = e?.runId ?? `run-restore-${i}`;
      return makeOp(
        { target: `analysis:${runId}`, owner: 'core', type: 'runAnalysis', payload: { ...e, runId } },
        { id: `an-${runId}`, hlc: { wall: 0, counter: i }, author: { authorId: 'restore' } },
      );
    });
    this.#log.receiveOps(ops);
    this.#changed();
  }

  #changed() {
    this.#bus?.emit?.('analysislog:changed');
  }
}
