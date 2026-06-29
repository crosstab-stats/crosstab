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

  /** A specific open dataset by id, or undefined. */
  get(id) {
    return this.#datasets.get(id);
  }

  /** Nudge listeners to re-render the dataset list (e.g. a link badge changed)
   * without any structural change. */
  touch() {
    this.#bus.emit(DATASETS_CHANGED, this.list());
  }

  /** Summaries for the dataset switcher. */
  list() {
    return [...this.#datasets.values()].map((ds) => ({
      id: ds.id,
      name: ds.name,
      rowCount: ds.rowCount,
      active: ds.id === this.#activeId,
      libraryLink: ds.libraryLink ?? null,
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

  /** Remove a dataset, dropping its DuckDB tables. Removing the **last** dataset
   * isn't forbidden — it resets the project to a fresh empty dataset (the
   * "clear the clutter and start fresh" gesture), so there's always an active
   * dataset. Otherwise, if the removed one was active, another becomes active. */
  async remove(id) {
    const ds = this.#datasets.get(id);
    if (!ds) return;
    await ds.dispose();
    this.#datasets.delete(id);
    if (this.#datasets.size === 0) {
      // Start fresh: a single empty dataset, ready to import into.
      this.#activeId = null;
      this.add('Dataset 1', { activate: true });
      this.#emitActive('replace');
      return;
    }
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
   * Extract a subset of columns from an open dataset into a NEW dataset — entirely
   * in DuckDB (no JS materialisation), so it scales to large/ultra-wide sources
   * (#121). Preserves the chosen variables' metadata (labels, value labels, …).
   *
   * @param {{srcId: number, varNames: string[], name?: string, activate?: boolean}} arg
   * @returns {Promise<number>} the new dataset id.
   */
  async extractColumns({ srcId, varNames, name = 'Extract', activate = true }) {
    const src = this.#datasets.get(srcId);
    if (!src) throw new Error('Extract: source dataset not found.');
    const metaByName = new Map(src.getVariableMeta().map((m) => [m.name, m]));
    const variables = (varNames || []).map((n) => metaByName.get(n)).filter(Boolean);
    if (!variables.length) throw new Error('Extract: no valid columns selected.');
    const selectSql = src.relationSql(variables.map((v) => v.name));
    const ds = this.add(name, { activate: false });
    await ds.loadFromSql({ selectSql, variables, source: name });
    if (activate) {
      this.#activeId = ds.id;
      this.#emitActive('switch');
    } else {
      this.#bus.emit(DATASETS_CHANGED, this.list());
    }
    return ds.id;
  }

  /**
   * Join another open dataset into a target dataset by key — entirely in DuckDB (the
   * incoming columns are copied from the other dataset's relation via SQL, never
   * pulled through JS), so even a multi-GB join source stays out-of-core (#121). The
   * engine's join op handles all four types and renames any non-key name clash.
   *
   * @param {{targetId: number, otherId: number, joinKey: {left: string, right: string}, joinType?: string}} arg
   */
  async joinDatasets({ targetId, otherId, joinKey, joinType }) {
    const target = this.#datasets.get(targetId);
    const other = this.#datasets.get(otherId);
    if (!target) throw new Error('Join: target dataset not found.');
    if (!other) throw new Error('Join: dataset to join not found.');
    const variables = other.getVariableMeta();
    const selectSql = other.relationSql();
    await target.joinFromSql({ selectSql, variables, source: other.name, joinKey, joinType });
    this.touch(); // refresh the sidebar (the target's row count changed)
  }

  /**
   * Add a single dataset reconstructed from a saved {@link DataStore} state (the
   * inverse of {@link DataStore#exportState}). Used to **restore a dataset from the
   * recycle bin** (#115) without disturbing the other open datasets. Gets a fresh
   * id (so its DuckDB tables don't collide with the live set) and becomes active.
   *
   * @param {{name: string, state: object, activate?: boolean}} entry
   * @returns {Promise<number>} the new dataset id.
   */
  async addFromState({ name = 'Restored dataset', state, activate = true }) {
    const id = this.#nextId++;
    const ds = new DataStore(this.#bus, this.#duckdb, { id, name });
    this.#datasets.set(id, ds);
    await ds.restoreState(state);
    if (activate || this.#activeId === null) {
      this.#activeId = id;
      this.#emitActive('switch');
    } else {
      this.#bus.emit(DATASETS_CHANGED, this.list());
    }
    return id;
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
      ds.libraryLink = d.libraryLink ?? null;
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
  loadStreaming(o) {
    return this.active.loadStreaming(o);
  }
  loadWide(o) {
    return this.active.loadWide(o);
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
  setCell(rid, column, value, displayRow) {
    return this.active.setCell(rid, column, value, displayRow);
  }
  computeVariable(name, expr, varType) {
    return this.active.computeVariable(name, expr, varType);
  }
  recodeVariable(name, source, rules, varType, elseRule) {
    return this.active.recodeVariable(name, source, rules, varType, elseRule);
  }
  filterCases(expr, label) {
    return this.active.filterCases(expr, label);
  }
  getTransforms() {
    return this.active.getTransforms();
  }
  getHistory() {
    return this.active?.getHistory() ?? { applied: [], future: [] };
  }
  rewindTo(n) {
    return this.active.rewindTo(n);
  }
  moveOp(from, to) {
    return this.active.moveOp(from, to);
  }
  removeOp(index) {
    return this.active.removeOp(index);
  }
  collectImports() {
    return this.active.collectImports();
  }
  replaceTransforms(transforms) {
    return this.active.replaceTransforms(transforms);
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
      /** A window of rows as objects (LIMIT/OFFSET), optionally with each row's
       * stable id as `__rid` — for workspaces that reference rows (e.g. CAQDAS
       * coding attaches to row + span). */
      getRows: (o) => (this.active ? this.active.getRows(o) : Promise.resolve([])),
      getVariableMeta: (o) => this.active?.getVariableMeta(o) ?? [],
      getSelectedVariables: () => this.active?.getSelectedVariables() ?? [],
      getRowCount: () => this.rowCount,
      /** Max UTF-8 byte length per (string) column — for a codec sizing fixed-width
       * string fields (e.g. ReadStat .sav/.dta export). */
      maxOctetLengths: (names) => (this.active ? this.active.maxOctetLengths(names) : Promise.resolve({})),
      /** The active dataset's data transforms (data-only; for library/pull). */
      getTransforms: () => this.active?.getTransforms() ?? [],
      /** The full ordered operation log ({applied, future}) — load/append/join +
       * data transforms in true order. Lets export-to-syntax emit a faithful,
       * ordered do-file (the loads in their right place, not just a stub). */
      getHistory: () => this.getHistory(),
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
