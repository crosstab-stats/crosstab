/**
 * @file dataset-manager.js
 * Holds the **set of open datasets** and which one is *active*, and presents the
 * active one through the same surface a single {@link DataStore} used to expose.
 *
 * ## Why
 * The engine used to hold exactly one dataset. Real work needs several at once:
 * a survey plus a derived bootstrap distribution, two tables to join, a few
 * library datasets open side by side. So each dataset is its own immutable
 * sources + transform log + derived view (a {@link DataStore} with
 * id-namespaced DuckDB tables), and this manager owns the collection and the
 * active pointer.
 *
 * ## How it stays low-churn
 * The manager **delegates the whole DataStore read/write interface to the active
 * dataset** (`rowCount`, `getColumns`, `loadDataset`, `updateVariable`, …), so
 * code that held a single `DataStore` keeps calling the same methods — they just
 * land on whatever is active now. On top it adds the multi-dataset operations
 * (`list`/`setActive`/`add`/`remove`) and the plugin-facing `create()` (emit a
 * derived dataset). Switching the active dataset re-emits `DATA_CHANGED` /
 * `SELECTION_CHANGED` so all the UI refreshes onto the new one.
 *
 * `DATA_CHANGED` payloads carry a `datasetId` so a listener can tell whether the
 * *active* dataset changed or some background one did (e.g. a derived dataset
 * being built before it's activated). The library autosave relies on this.
 */

import { CoreEvents } from './event-bus.js';
import { DataStore } from './data-store.js';

/** Bus event: the set of datasets or the active one changed (drives the switcher). */
export const DATASETS_CHANGED = 'datasets:changed';

export class DatasetManager {
  /** @type {import('./event-bus.js').EventBus} */
  #bus;
  /** @type {import('./duckdb-manager.js').DuckDBManager} */
  #duckdb;
  /** id → DataStore. @type {Map<number, DataStore>} */
  #datasets = new Map();
  /** Active dataset id. */
  #activeId = null;
  /** Monotonic dataset id. */
  #nextId = 1;

  /**
   * @param {import('./event-bus.js').EventBus} bus
   * @param {import('./duckdb-manager.js').DuckDBManager} duckdb
   */
  constructor(bus, duckdb) {
    this.#bus = bus;
    this.#duckdb = duckdb;
  }

  // --- collection ------------------------------------------------------------

  /** The active {@link DataStore}. */
  get active() {
    return this.#datasets.get(this.#activeId);
  }

  /** @returns {number|null} */
  get activeId() {
    return this.#activeId;
  }

  /** All open datasets (live {@link DataStore}s), in id order. */
  all() {
    return [...this.#datasets.values()];
  }

  /** Summaries for the dataset switcher. */
  list() {
    return [...this.#datasets.values()].map((ds) => ({
      id: ds.id,
      name: ds.name,
      rowCount: ds.rowCount,
      active: ds.id === this.#activeId,
    }));
  }

  /**
   * Create a new (empty) dataset and return its {@link DataStore}. Becomes active
   * if it's the first dataset or `activate` is set.
   * @param {string} [name='Dataset']
   * @param {{activate?: boolean}} [opts]
   * @returns {DataStore}
   */
  add(name = 'Dataset', { activate = false } = {}) {
    const id = this.#nextId++;
    const ds = new DataStore(this.#bus, this.#duckdb, { id, name });
    this.#datasets.set(id, ds);
    if (activate || this.#activeId === null) this.#activeId = id;
    this.#bus.emit(DATASETS_CHANGED, this.list());
    return ds;
  }

  /** Switch the active dataset and refresh the UI onto it. */
  setActive(id) {
    if (!this.#datasets.has(id) || id === this.#activeId) return;
    this.#activeId = id;
    this.#emitActive('switch');
  }

  /** Rename a dataset (updates the switcher). */
  rename(id, name) {
    const ds = this.#datasets.get(id);
    if (!ds) return;
    ds.name = name;
    this.#bus.emit(DATASETS_CHANGED, this.list());
  }

  /** Remove a dataset, dropping its DuckDB tables. If it was active, activate
   * another (or none). */
  async remove(id) {
    const ds = this.#datasets.get(id);
    if (!ds) return;
    await ds.dispose();
    this.#datasets.delete(id);
    if (this.#activeId === id) {
      this.#activeId = this.#datasets.keys().next().value ?? null;
      this.#emitActive('switch');
    } else {
      this.#bus.emit(DATASETS_CHANGED, this.list());
    }
  }

  /**
   * Engine side of `app.data.create`: build a dataset from delivered data, load
   * it, and (by default) make it active. The reproducibility/lineage `source`
   * label rides along as the provenance tag.
   *
   * @param {Object} dataset - `{ name?, variables, columns?, parquet?, activate? }`
   * @returns {Promise<number>} the new dataset id.
   */
  async createWithData({ name = 'Derived dataset', variables, columns, parquet, activate = true }) {
    const ds = this.add(name, { activate: false });
    await ds.loadDataset({ variables, columns, parquet, mode: 'replace', source: name });
    if (activate) {
      this.#activeId = ds.id;
      this.#emitActive('switch');
    } else {
      this.#bus.emit(DATASETS_CHANGED, this.list());
    }
    return ds.id;
  }

  /**
   * Replace the entire working set with a saved project bundle: dispose the open
   * datasets, recreate each from the bundle, and restore the active one.
   *
   * @param {{activeId: number, datasets: Array<{id: number, name: string, state: object}>}} bundle
   */
  async loadBundle({ datasets, activeId }) {
    for (const ds of this.#datasets.values()) await ds.dispose();
    this.#datasets.clear();
    this.#activeId = null;
    // Recreate with the SAVED ids so a project's Parquet files (named by dataset
    // id) map back consistently across save/load.
    for (const d of datasets) {
      const ds = new DataStore(this.#bus, this.#duckdb, { id: d.id, name: d.name });
      this.#datasets.set(d.id, ds);
      await ds.restoreState(d.state);
    }
    const maxId = datasets.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0);
    this.#nextId = Math.max(this.#nextId, maxId + 1);
    this.#activeId = this.#datasets.has(activeId)
      ? activeId
      : (this.#datasets.keys().next().value ?? null);
    this.#emitActive('switch');
  }

  /** Re-emit active-dataset events so every consumer refreshes onto it. */
  #emitActive(reason) {
    this.#bus.emit(DATASETS_CHANGED, this.list());
    const ds = this.active;
    if (!ds) return;
    this.#bus.emit(CoreEvents.DATA_CHANGED, {
      datasetId: ds.id,
      rowCount: ds.rowCount,
      variables: ds.getVariableMeta().map((m) => m.name),
      reason,
    });
    this.#bus.emit(CoreEvents.SELECTION_CHANGED, ds.getSelectedVariables());
  }

  // --- DataStore interface, delegated to the active dataset -------------------
  // Lets code that held a single DataStore keep calling the same methods.

  get rowCount() {
    return this.active?.rowCount ?? 0;
  }
  get binding() {
    return this.active?.binding ?? null;
  }
  set binding(v) {
    if (this.active) this.active.binding = v;
  }
  setDataset(d) {
    return this.active.setDataset(d);
  }
  loadDataset(d) {
    return this.active.loadDataset(d);
  }
  getDataFrame(o) {
    return this.active.getDataFrame(o);
  }
  getColumns(o) {
    return this.active.getColumns(o);
  }
  getRows(o) {
    return this.active.getRows(o);
  }
  getVariableMeta(o) {
    return this.active?.getVariableMeta(o) ?? [];
  }
  getSelectedVariables() {
    return this.active?.getSelectedVariables() ?? [];
  }
  setSelectedVariables(n) {
    return this.active.setSelectedVariables(n);
  }
  getInjectionParquet(o) {
    return this.active.getInjectionParquet(o);
  }
  updateVariable(n, p) {
    return this.active.updateVariable(n, p);
  }
  getTransforms() {
    return this.active.getTransforms();
  }
  get canUndo() {
    return this.active?.canUndo ?? false;
  }
  get canRedo() {
    return this.active?.canRedo ?? false;
  }
  undo() {
    return this.active.undo();
  }
  redo() {
    return this.active.redo();
  }
  exportState(o) {
    return this.active.exportState(o);
  }
  restoreState(s) {
    return this.active.restoreState(s);
  }

  // --- plugin-facing surfaces ------------------------------------------------

  /** `app.data` — the read API, delegating to the active dataset, plus `create`
   * (emit a derived dataset). */
  get api() {
    return Object.freeze({
      getDataFrame: (o) => this.active.getDataFrame(o),
      getColumns: (o) => this.active.getColumns(o),
      getVariableMeta: (o) => this.active?.getVariableMeta(o) ?? [],
      getSelectedVariables: () => this.active?.getSelectedVariables() ?? [],
      getRowCount: () => this.rowCount,
      onDataChanged: (fn) => this.#bus.on(CoreEvents.DATA_CHANGED, fn),
      onSelectionChanged: (fn) => this.#bus.on(CoreEvents.SELECTION_CHANGED, fn),
      /** Emit a derived dataset (e.g. bootstrap resamples) as a new active
       * dataset. Resolves to its id. */
      create: (dataset) => this.createWithData(dataset),
    });
  }

  /** `app.transform` — the write API, delegating to the active dataset. */
  get transformApi() {
    return Object.freeze({
      updateVariable: (name, patch) => this.active.updateVariable(name, patch),
    });
  }
}
