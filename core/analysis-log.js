/**
 * @file analysis-log.js
 * An ordered, replayable record of the **analyses** the user has run — the missing
 * half of CrossTab's "script". The data-store already keeps a universal log of
 * data operations (load/recode/compute/filter…) that it can replay to rebuild the
 * dataset; this is the analogous log for analysis *runs* (crosstabs, regression,
 * plots) so they can be re-executed to reproduce the Output pane.
 *
 * It is pure data — record/list/edit/serialise. The actual re-execution lives in
 * {@link PluginActions} (it owns the loader + results framing); this class just
 * holds the ordered entries and notifies listeners when they change. Together with
 * the data-store log it forms the timeline the script editor (#132–#134) reads and
 * writes.
 *
 * @typedef {Object} AnalysisEntry
 * @property {string} pluginId   - owning plugin id (for loader.invoke).
 * @property {string} pluginName - display name (for the output section attribution).
 * @property {string} origin     - host-tracked origin label ("built-in", "from …").
 * @property {string} label      - menu item label (the output section heading).
 * @property {string} run        - the plugin's exported function name to invoke.
 * @property {Array<object>} specs - the item's declared `inputs` (to re-bind R inputs on replay).
 * @property {object} inputs     - the gathered input values (the replayable params).
 */

export class AnalysisLog {
  /** @type {AnalysisEntry[]} */
  #entries = [];
  /** @type {import('./event-bus.js').EventBus|null} */
  #bus;

  /** @param {import('./event-bus.js').EventBus} [bus] */
  constructor(bus = null) {
    this.#bus = bus;
  }

  /** Append a completed analysis. Entries are stored as deep clones so later edits
   * to the caller's objects can't mutate the log. */
  record(entry) {
    this.#entries.push(structuredClone(entry));
    this.#changed();
  }

  /** A deep copy of the ordered entries (safe to hand to callers/serialisers). */
  entries() {
    return this.#entries.map((e) => structuredClone(e));
  }

  /** How many analyses are logged. */
  get count() {
    return this.#entries.length;
  }

  /** Drop the entry at `index` (e.g. the user deleted that step). */
  remove(index) {
    if (index < 0 || index >= this.#entries.length) return;
    this.#entries.splice(index, 1);
    this.#changed();
  }

  /** Move the entry at `from` to `to` (re-order a step). */
  move(from, to) {
    if (from < 0 || from >= this.#entries.length || to < 0 || to >= this.#entries.length) return;
    const [e] = this.#entries.splice(from, 1);
    this.#entries.splice(to, 0, e);
    this.#changed();
  }

  /** Remove everything (a fresh project / cleared output). */
  clear() {
    if (!this.#entries.length) return;
    this.#entries = [];
    this.#changed();
  }

  /** Serialise for the project bundle. */
  toJSON() {
    return this.#entries.map((e) => structuredClone(e));
  }

  /** Restore from a serialised array (project load). Does NOT replay — the caller
   * decides when to re-execute. */
  load(arr) {
    this.#entries = Array.isArray(arr) ? arr.map((e) => structuredClone(e)) : [];
    this.#changed();
  }

  #changed() {
    this.#bus?.emit?.('analysislog:changed');
  }
}
