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
 * @property {string[]} [rSource] - the R this run actually evaluated, one entry per
 *   evaluation, each already carrying a readable note of how the data was bound. Present
 *   only for runs that used R, and only for runs recorded live (see PluginActions#execute).
 *   This is the PROVENANCE of the numbers: it lets a project be audited by someone who
 *   does not have the plugin that produced them, and gives the R export its exact-code
 *   half. Persisted deliberately — the owner's call, 2026-10-09.
 * @property {number} [rSourceDropped] - evaluations omitted at the size cap, if any.
 */

import { newOpId } from './merge.js';
import { liveOps, orderByHlc } from './op-log.js';
import { ProjectLog } from './project-log.js';
import { retargetRefs, varsNamed } from './var-ref.js';
import { staleReaders } from './op-log.js';

/** The analysis-run projection: folds runAnalysis/removeAnalysis ops into the ordered
 * list of runs (keyed by `runId`, so a re-added run after a remove reappears). */
const ANALYSIS = {
  key: 'analysis',
  match: (op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('analysis:'),
  fold: (ops) => {
    const runs = new Map();
    let order = null;
    for (const op of liveOps(ops)) { // undone run/remove ops are hidden by the liveness fold
      if (op.type === 'runAnalysis') runs.set(op.payload.runId, op.payload);
      else if (op.type === 'removeAnalysis') runs.delete(op.payload.runId);
      // LEGACY, read-only. Nothing writes `reorderAnalyses` any more: the timeline's single
      // `reorder` op orders data steps and analyses in ONE sequence (core/timeline.js), and
      // an analyses-only order beside it was a second authority on the same question. Kept
      // so a project saved while it existed still opens in the order it was left in.
      else if (op.type === 'reorderAnalyses' && Array.isArray(op.payload?.order)) order = op.payload.order;
    }
    const list = [...runs.values()];
    if (!order) return list;
    // A Map re-set does NOT move an existing key, which is why the natural order here is
    // "first run, first shown" and why re-recording an analysis could never reorder it.
    // An explicit order is the only way to express "this one comes after that one" when
    // two analyses share a data position (#148 deferred this; the History arrows need it).
    //
    // Stable and forgiving: ids the order does not mention keep their relative position
    // AFTER the ones it does, so an order written before a new analysis existed still
    // means what it said, and a stale id for a removed run is simply ignored.
    const rank = new Map(order.map((id, i) => [id, i]));
    return list
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ra = rank.has(a.e.runId) ? rank.get(a.e.runId) : Number.POSITIVE_INFINITY;
        const rb = rank.has(b.e.runId) ? rank.get(b.e.runId) : Number.POSITIVE_INFINITY;
        return (ra - rb) || (a.i - b.i);
      })
      .map(({ e }) => e);
  },
};

/** Source ops: they replace the whole dataset, so a staleness check has to treat them as a
 * write to every variable in it rather than to one sibling address. */
const SOURCE_OPS = new Set(['load', 'append', 'join']);

/**
 * The op-log targets a run depends on: one per variable it actually read.
 *
 * This is what lets {@link AnalysisLog#staleRuns} work at all. `staleReaders` has been in
 * op-log.js since #166, answering exactly the right question — "does something I depend on
 * change after me?" — and it could not see analyses, because a `runAnalysis` op declared
 * no reads. A result computed from a variable recoded afterwards sat in Output looking as
 * authoritative as one computed a second ago.
 *
 * An unqualified reference means the run's own dataset, which is what `datasetId` says.
 * A run whose dataset is unknown (recorded before it was tracked) declares nothing rather
 * than guessing: under-reporting staleness is the safer direction for a mark shown to a user.
 */
function readsOf(entry) {
  const own = entry?.datasetId;
  const out = [];
  for (const { dataset, name } of varsNamed(entry?.inputs, entry?.specs)) {
    // A qualified reference names another dataset BY NAME, which is not an op address;
    // resolving it needs the collection, which this module deliberately does not have.
    // Its own dataset covers the overwhelmingly common case.
    if (dataset != null) continue;
    if (own == null) continue;
    const target = `ds:${own}/var:${name}`;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

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
    this.#log.append({
      target: `analysis:${payload.runId}`, owner: 'core', type: 'runAnalysis', payload,
      reads: readsOf(payload),
    });
    this.#bus?.emit?.('analysislog:recorded', structuredClone(payload));
    this.#changed();
  }

  /** Re-append a previously-removed entry (undo's redo) without emitting a new-run
   * signal — it isn't a fresh action. Re-adds by its existing `runId`. */
  restore(entry) {
    const payload = structuredClone(entry);
    if (!payload.runId) payload.runId = newOpId();
    this.#log.append({
      target: `analysis:${payload.runId}`, owner: 'core', type: 'runAnalysis', payload,
      reads: readsOf(payload),
    });
    this.#changed();
  }

  /**
   * Hide a run without deleting it — the History cursor moving above it.
   *
   * An `undo` op, the same append-only hide the undo coordinator uses, so the run drops
   * out of {@link AnalysisLog#entries} and comes back on {@link AnalysisLog#admit}. This
   * is NOT `remove`: a removal is a `removeAnalysis` tombstone that propagates as a
   * deletion, where a withdrawal is a position the user can walk back out of.
   *
   * @param {string} runId @returns {boolean} whether anything was withdrawn
   */
  withdraw(runId) {
    if (!runId) return false;
    // EVERY live op for this run, not just the newest. A run accumulates `runAnalysis` ops
    // — a move, a rename, a re-run each append one — and the fold takes any applied op as
    // evidence the run exists. Hiding only the latest left an older one standing, so the
    // analysis showed up TWICE in the timeline: once live, once below the cursor. Measured
    // in the app on a run that had been re-run once.
    let n = 0;
    while (n < 1000 && this.#log.undoWhere((o) => o.type === 'runAnalysis' && o.payload?.runId === runId)) n += 1;
    if (n) this.#changed();
    return n > 0;
  }

  /** Bring a withdrawn run back: the mirror of {@link AnalysisLog#withdraw}, and equally
   * all-of-them — a partial redo would leave the run live on a stale payload. */
  admit(runId) {
    if (!runId) return false;
    let n = 0;
    while (n < 1000 && this.#log.redoWhere((o) => o.type === 'runAnalysis' && o.payload?.runId === runId)) n += 1;
    if (n) this.#changed();
    return n > 0;
  }

  /** The runs currently hidden by an undo — the timeline's "below the cursor" analyses,
   * shown greyed rather than simply vanishing. One entry per RUN, newest payload wins:
   * a run with several ops would otherwise be listed once per op. */
  withdrawnEntries() {
    const byRun = new Map();
    // Sorted by the OPS' own HLC, not by `undoneOps`'s order — that is oldest-UNDO-MARKER
    // first, and `withdraw` undoes a run's newest op first, so reading it directly left the
    // ORIGINAL payload winning and a withdrawn run showed the position it was first run at.
    for (const op of orderByHlc(this.#log.undoneOps(ANALYSIS.match))) {
      if (op.type === 'runAnalysis' && op.payload?.runId) byRun.set(op.payload.runId, op.payload);
    }
    // A run that is still live somewhere (a partially-undone history) is not withdrawn.
    const live = new Set(this.#log.state('analysis').map((e) => e.runId));
    return [...byRun.entries()]
      .filter(([runId]) => !live.has(runId))
      .map(([, payload]) => structuredClone(payload));
  }


  /**
   * The runs whose data has changed since they ran — results that no longer describe what
   * they claim to.
   *
   * Detection only, and deliberately: the honest thing to do with a stale result is to SAY
   * it is stale, not to silently re-run it (which would cost a WebR round trip per result
   * on every edit) and not to hide it (the numbers were true of the data at the time, which
   * is exactly what a history is for).
   *
   * Only the LATEST op per run counts. A reposition or a dataset rename appends a fresh
   * `runAnalysis` for the same runId, and the superseded ones are older than everything,
   * so counting them would report every moved analysis as permanently stale.
   *
   * @returns {Set<string>} runIds
   */
  staleRuns() {
    const ops = liveOps(this.#log.slice((o) => (
      (typeof o.target === 'string' && o.target.startsWith('analysis:'))
      || (o.owner === 'core' && typeof o.target === 'string' && o.target.startsWith('ds:'))
    )));
    const newest = new Map();
    for (const op of ops) if (op.type === 'runAnalysis' && op.payload?.runId) newest.set(op.payload.runId, op.id);
    const current = new Set(newest.values());
    const problems = staleReaders(ops, {
      isReader: (op) => op.type === 'runAnalysis' && current.has(op.id),
      isAggregateWrite: (op) => SOURCE_OPS.has(op.type),
    });
    return new Set(problems.map((p) => p.op.payload?.runId).filter(Boolean));
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

  /**
   * Move an analysis to a different **data position** — `at` is the number of transforms
   * applied when it ran, so this is "run it one data step earlier/later" (#190).
   *
   * Log-native without a new op type: a fresh `runAnalysis` for the same `runId` replaces the
   * payload, because the projection folds the newest op per run as authoritative. Two peers
   * moving the same analysis resolve last-writer-wins by HLC, which is the right rule for a
   * position. What this deliberately CANNOT do is reorder two analyses that share an `at` —
   * their order is the fold's, and changing it needs the explicit order op #148 deferred.
   *
   * Callers must re-run the analysis afterwards: `at` says which data the result describes, so
   * changing it without recomputing would file the old numbers under a new position.
   *
   * @param {string} runId @param {number} at
   * @returns {object|null} the updated entry, or null if there is no such run
   */
  /**
   * Record that a run was re-executed where it already is.
   *
   * {@link AnalysisLog#reposition} returns early when the position has not changed, which
   * is right for a MOVE — there is nothing to record. But a re-run is a real event, and
   * without an op for it the log still shows the result as older than the edit that made
   * it stale, so the `stale` mark never clears however many times you press ↻.
   *
   * The fresh op also re-derives `reads[]`, so an analysis re-run after its variables
   * changed declares what it reads NOW.
   *
   * @param {string} runId @returns {object|null} the entry, or null if there is no such run
   */
  touch(runId) {
    const entry = this.#log.state('analysis').find((e) => e.runId === runId);
    if (!entry) return null;
    const payload = structuredClone(entry);
    this.#log.append({
      target: `analysis:${runId}`, owner: 'core', type: 'runAnalysis', payload,
      reads: readsOf(payload),
    });
    this.#changed();
    return payload;
  }

  reposition(runId, at) {
    const entry = this.#log.state('analysis').find((e) => e.runId === runId);
    if (!entry) return null;
    const next = Math.max(0, Math.floor(Number(at) || 0));
    if (next === entry.at) return entry;
    const payload = { ...structuredClone(entry), at: next };
    this.#log.append({
      target: `analysis:${runId}`, owner: 'core', type: 'runAnalysis', payload,
      reads: readsOf(payload),
    });
    this.#changed();
    return payload;
  }

  /**
   * Re-point every analysis that names a dataset by its OLD name at its new one (#179).
   *
   * Qualified variable references resolve by dataset NAME, so without this a rename left saved
   * analyses pointing at a dataset that no longer exists: the next Run failed loudly (which is
   * the right failure, but still a failure) and the Syntax view showed a reference that could
   * not be resolved. The owner's call: *"ideally a dataset rename should be a rare event, so
   * it's okay if it is a little expensive."*
   *
   * **Append-only, like everything else here.** One fresh `runAnalysis` per affected run, which
   * is exactly what {@link AnalysisLog#reposition} does for a position: the projection folds the
   * newest op per run as authoritative, so the rewrite IS the history rather than hiding it.
   * Two peers renaming the same dataset resolve last-writer-wins by HLC, the right rule for a
   * name. The log gains one visible "this analysis was re-pointed" entry per analysis, which is
   * the audit trail the one-true-log exists to keep.
   *
   * Nothing is re-run: the numbers do not change, only the spelling of where they came from.
   *
   * @param {string} oldName @param {string} newName
   * @returns {number} how many analyses were re-pointed
   */
  retargetDataset(oldName, newName) {
    const from = String(oldName ?? '').trim();
    const to = String(newName ?? '').trim();
    if (!from || !to || from === to) return 0;
    let n = 0;
    for (const entry of this.#log.state('analysis')) {
      const inputs = retargetRefs(entry.inputs, entry.specs, from, to);
      if (!inputs) continue;
      const payload = { ...structuredClone(entry), inputs };
      this.#log.append({
        target: `analysis:${entry.runId}`, owner: 'core', type: 'runAnalysis', payload,
        reads: readsOf(payload),
      });
      n += 1;
    }
    if (n) this.#changed();
    return n;
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
    const want = String(datasetId);
    // A cross-dataset analysis has more than one parent (#179), so it is invalidated by a
    // re-import of ANY of them. The conservative reading on purpose: a stale entry the user can
    // re-run is a much smaller harm than output that silently quotes data no longer there.
    this.clear((e) => {
      if (Array.isArray(e.datasetIds) && e.datasetIds.length) {
        return e.datasetIds.some((id) => id != null && String(id) === want);
      }
      return e.datasetId != null && String(e.datasetId) === want;
    });
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
