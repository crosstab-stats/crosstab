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
import { ProjectLog } from './project-log.js';
import { makeOp } from './op-log.js';
import { currentAuthor } from './user-identity.js';

/** Bus event: the set of datasets or the active one changed (drives the switcher). */
export const DATASETS_CHANGED = 'datasets:changed';

/** The dataset-COLLECTION projection (unified log, System 2): folds add/rename/remove
 * ops into the ordered `[{id, name}]` membership. This — not the instance Map — is the
 * source of truth for which datasets exist, their names, and their order. The Map
 * (`#datasets`) is just the live-instance store keyed by these ids. See
 * docs/ARCHITECTURE-unified-log.md §7. Which dataset is *active* is view state, NOT an
 * op (the same call the DataStore already makes for variable selection). */
const COLLECTION = {
  key: 'collection',
  match: (op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('coll/'),
  fold: (ops) => {
    const names = new Map();
    for (const op of ops) {
      if (op.type === 'addDataset') names.set(op.payload.id, op.payload.name);
      else if (op.type === 'renameDataset') { if (names.has(op.payload.id)) names.set(op.payload.id, op.payload.name); }
      else if (op.type === 'removeDataset') names.delete(op.payload.id);
    }
    return [...names.entries()].map(([id, name]) => ({ id, name }));
  },
};

/** A globally-unique id for a NEW dataset. Random (~48 bits), NOT a shared local
 * counter — two peers creating datasets concurrently (offline, or live from the same
 * bundle) must never mint the same id, or their DuckDB tables / Parquet files collide
 * AND the merge sees the two different datasets as rival `addDataset(coll/ds:<id>)` ops
 * (a false "both added" conflict). Kept a plain integer < 2^53 so it stays a valid
 * DuckDB identifier suffix and JSON number — no id-type churn across the app. Starts at
 * 2, leaving 0/1 for the reserved blank-project dataset. */
function newDatasetId() {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return (r[0] % 0x1000000) * 0x1000000 + (r[1] % 0x1000000) + 2;
}

const collAdd = (id, name) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'addDataset', payload: { id, name } });
const collRename = (id, name) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'renameDataset', payload: { id, name } });
const collRemove = (id) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'removeDataset', payload: { id } });

export class DatasetManager {
  /** @type {import('./event-bus.js').EventBus} */
  #bus;
  /** @type {import('./duckdb-manager.js').DuckDBManager} */
  #duckdb;
  /** id → DataStore (the live-instance store; membership is owned by {@link #log}).
   * @type {Map<number, DataStore>} */
  #datasets = new Map();
  /** Active dataset id — VIEW STATE, not a logged op. */
  #activeId = null;
  /** The project's unified op log; here it carries the dataset-collection tier. Later
   * units register more projections (analysis, plugin) on the SAME log. @type {ProjectLog} */
  #log;

  /**
   * @param {import('./event-bus.js').EventBus} bus
   * @param {import('./duckdb-manager.js').DuckDBManager} duckdb
   * @param {ProjectLog} [projectLog]  the shared project log (default: a fresh one).
   */
  constructor(bus, duckdb, projectLog) {
    this.#bus = bus;
    this.#duckdb = duckdb;
    this.#log = projectLog ?? new ProjectLog({ author: currentAuthor });
    this.#log.register(COLLECTION);
  }

  /** The ordered collection membership from the log — the source of truth for which
   * datasets exist, their order, and their names. */
  #collection() {
    return this.#log.state('collection');
  }

  /** The raw collection op-log (add/rename/remove ops), persisted in the project bundle
   * so the merge (unit 6) reconciles membership from REAL ops — both peers converge, and
   * a removeDataset propagates instead of being inferred from absence. */
  collectionOps() {
    return this.#log.ops().filter((o) => COLLECTION.match(o));
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

  /** All open datasets (live {@link DataStore}s), in the collection's order. */
  all() {
    return this.#collection().map((c) => this.#datasets.get(c.id)).filter(Boolean);
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

  /** Summaries for the dataset switcher, in collection order. Name comes from the
   * collection projection (its source of truth); row count/link from the live instance. */
  list() {
    return this.#collection().map((c) => {
      const ds = this.#datasets.get(c.id);
      return {
        id: c.id,
        name: c.name,
        rowCount: ds?.rowCount ?? 0,
        active: c.id === this.#activeId,
        libraryLink: ds?.libraryLink ?? null,
      };
    });
  }

  /**
   * Create a new (empty) dataset and return its {@link DataStore}. Becomes active
   * if it's the first dataset or `activate` is set.
   * @param {string} [name='Dataset']
   * @param {{activate?: boolean}} [opts]
   * @returns {DataStore}
   */
  add(name = 'Dataset', { activate = false } = {}) {
    const id = newDatasetId();
    const ds = new DataStore(this.#bus, this.#duckdb, { id, name, log: this.#log });
    this.#datasets.set(id, ds);
    this.#log.append(collAdd(id, name)); // membership is recorded, not just held in the Map
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

  /** Rename a dataset (updates the switcher). The op is the source of truth; `ds.name`
   * is kept in sync as the synchronous display cache many callers read. */
  rename(id, name) {
    const ds = this.#datasets.get(id);
    if (!ds) return;
    ds.name = name;
    this.#log.append(collRename(id, name));
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
    this.#log.append(collRemove(id)); // deletion is a recorded op — not just absence
    // The dataset is gone from the collection; hard-drop its now-orphaned data ops so
    // the log doesn't carry dead pipeline steps (the collRemove is the authoritative
    // deletion signal that propagates on merge).
    this.#log.clearWhere((op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith(`ds:${id}/`));
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
    const id = newDatasetId();
    const ds = new DataStore(this.#bus, this.#duckdb, { id, name, log: this.#log });
    this.#datasets.set(id, ds);
    this.#log.append(collAdd(id, name)); // recycle-bin restore is a real add to the collection
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
  async loadBundle({ datasets, activeId, collectionLog }) {
    for (const ds of this.#datasets.values()) await ds.dispose();
    this.#datasets.clear();
    this.#activeId = null;
    // Rebuild the collection + data tiers of the log from the bundle. Leave OTHER
    // projections (e.g. analysis) alone — their own load path restores them on the
    // shared log.
    this.#log.clearWhere(
      (op) => COLLECTION.match(op) || (op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('ds:')),
    );
    if (Array.isArray(collectionLog) && collectionLog.length) {
      // Unit 6: the REAL persisted/merged collection ops (with their ids + HLC), so
      // membership — including deletes — comes straight from the log and both peers
      // converge. This retires the deterministic reconstruction below.
      this.#log.receiveOps(collectionLog);
    } else {
      // Back-compat (pre-unit-6 saves / a fresh blank project): rebuild the tier from
      // datasets[] with deterministic ids so it's identical across loads and machines.
      this.#log.receiveOps(
        (datasets ?? []).map((d, i) => makeOp(collAdd(d.id, d.name), { id: `coll-add-${d.id}`, hlc: { wall: 0, counter: i }, author: { authorId: 'restore' } })),
      );
    }
    // Recreate with the SAVED ids so a project's Parquet files (named by dataset
    // id) map back consistently across save/load.
    for (const d of datasets) {
      const ds = new DataStore(this.#bus, this.#duckdb, { id: d.id, name: d.name, log: this.#log });
      ds.libraryLink = d.libraryLink ?? null;
      this.#datasets.set(d.id, ds);
      try {
        // Project-load path (project.json): RAW op envelopes (with id/hlc/target) →
        // restore verbatim, preserving ids so the retract/reorder structural ops
        // survive and merge can match op identity. Library/bundle re-home path (folded
        // recipe, no envelope) → restoreState re-mints under this dataset's fresh id.
        const ops = d.state?.ops;
        if (Array.isArray(ops) && ops.length && ops[0]?.hlc != null && ops[0]?.target != null) {
          await ds.rawRestore(ops);
        } else {
          await ds.restoreState(d.state);
        }
      } catch (err) {
        // A dataset whose sources didn't materialise (e.g. gap-fill bytes not yet here)
        // must NOT linger in the Map with no tables — a later #snapshot would try to
        // export its missing source and throw, breaking ALL sync. Drop it; it stays in
        // the collection membership and re-materialises on the next apply once complete.
        console.error('[dataset] restore failed; dropping until its data arrives:', d.id, err);
        this.#datasets.delete(d.id);
        try { await ds.dispose(); } catch { /* best-effort */ }
      }
    }
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
  dropVariables(names) {
    return this.active.dropVariables(names);
  }
  keepVariables(names) {
    return this.active.keepVariables(names);
  }
  renameVariable(oldName, newName) {
    return this.active.renameVariable(oldName, newName);
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
       * ordered script (the loads in their right place, not just a stub). */
      getHistory: () => this.getHistory(),
      onDataChanged: (fn) => this.#bus.on(CoreEvents.DATA_CHANGED, fn),
      onSelectionChanged: (fn) => this.#bus.on(CoreEvents.SELECTION_CHANGED, fn),
      /** Emit a derived dataset (e.g. bootstrap resamples, a filtered subset) as a
       * new active dataset. Resolves to its id. **Carry the source variables'
       * metadata** (`missingValues`, value labels, measure) into the `variables` you
       * pass — the host folds designated `missingValues` to `NA` at analysis
       * injection, so a derived dataset that preserves them stays correct for missing;
       * one built with bare name+type would lose that. */
      create: (dataset) => this.createWithData(dataset),
      /** Make a dataset active — for an importer that creates a dataset and then wants
       * to switch to it after attaching workspace state (#139). No-op for a bad id. */
      setActive: (id) => this.setActive(id),
    });
  }

  /** `app.transform` — the write API, delegating to the active dataset. */
  get transformApi() {
    return Object.freeze({
      updateVariable: (name, patch) => this.active.updateVariable(name, patch),
    });
  }
}
