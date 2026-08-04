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
import { liveOps } from './op-log.js';
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
    for (const op of liveOps(ops)) { // undone add/rename/remove are hidden by the liveness fold
      if (op.type === 'addDataset') names.set(op.payload.id, op.payload.name);
      else if (op.type === 'renameDataset') { if (names.has(op.payload.id)) names.set(op.payload.id, op.payload.name); }
      else if (op.type === 'removeDataset' || op.type === 'purgeDataset') names.delete(op.payload.id);
    }
    return [...names.entries()].map(([id, name]) => ({ id, name }));
  },
};

/**
 * The RECYCLE-BIN projection: datasets with a `removeDataset` op and no `purgeDataset`
 * after it. Deletion is a **status change in the log**, not a copy into another store —
 * the dataset's ops (and its Parquet sidecars) stay exactly where they were, and this
 * fold is the whole index of what's recoverable. `purgeDataset` is the point of no
 * return: it drops the entry here, and the save sweep is then free to delete the bytes.
 *
 * The deletion timestamp comes from the op's own HLC wall clock — no separate field to
 * keep in step, and it merges with the op.
 */
const BIN = {
  key: 'bin',
  match: COLLECTION.match,
  fold: (ops) => {
    const names = new Map(); // id → current name while live
    const binned = new Map(); // id → {id, name, deletedAt}
    for (const op of liveOps(ops)) {
      const id = op.payload?.id;
      if (op.type === 'addDataset') { names.set(id, op.payload.name); binned.delete(id); }
      else if (op.type === 'renameDataset') {
        if (names.has(id)) names.set(id, op.payload.name);
        const b = binned.get(id);
        if (b) b.name = op.payload.name; // renamed while binned (rare, but the log allows it)
      } else if (op.type === 'removeDataset') {
        if (names.has(id)) binned.set(id, { id, name: names.get(id), deletedAt: op.hlc?.wall ?? 0 });
        names.delete(id);
      } else if (op.type === 'purgeDataset') {
        binned.delete(id);
        names.delete(id);
      }
    }
    return [...binned.values()];
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
const collPurge = (id) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'purgeDataset', payload: { id } });

export class DatasetManager {
  /** @type {import('./event-bus.js').EventBus} */
  #bus;
  /** @type {import('./duckdb-manager.js').DuckDBManager} */
  #duckdb;
  /** id → DataStore (the live-instance store; membership is owned by {@link #log}).
   * @type {Map<number, DataStore>} */
  #datasets = new Map();
  /** id → DataStore for datasets in the RECYCLE BIN. Deleting moves the instance here
   * and appends a `removeDataset` op; nothing is copied and its DuckDB tables stay put,
   * so a restore is instant and costs no bytes. Membership here mirrors the {@link BIN}
   * projection — the log is the index, this Map is just the live instances (exactly as
   * `#datasets` is for the collection). Emptied by `purge` (the real delete).
   * @type {Map<number, DataStore>} */
  #binned = new Map();
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
    this.#log.register(BIN);
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

  /** Raw data-tier ops (`ds:<id>/…`) whose dataset is **no longer live** — a deleted
   * dataset's superseded pipeline steps. The one true log keeps these (see
   * {@link DatasetManager#remove}); this exposes them so the project save path persists
   * them alongside the live datasets' ops. They're never re-materialised into a
   * DataStore (the collection projection excludes the removed dataset), so the
   * peer-local table name / any bytes are stripped from source ops — the envelope
   * (id/hlc/author/target) is what matters for audit + merge. */
  orphanDataOps() {
    // "Orphaned" now means PURGED: a binned dataset is still held (its ops and bytes are
    // serialised by its own retained DataStore), so only a permanently-purged one lands
    // here — envelope kept for audit + merge, bytes stripped.
    const live = new Set([...this.#datasets.keys(), ...this.#binned.keys()].map((id) => String(id)));
    const dsId = (op) => { const m = /^ds:([^/]+)\//.exec(op.target); return m ? m[1] : null; };
    return this.#log
      .ops()
      .filter((op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('ds:'))
      .filter((op) => { const id = dsId(op); return id != null && !live.has(id); })
      .map((op) => {
        if (['load', 'append', 'join'].includes(op.type) && op.payload?.src) {
          const { table, parquet, file, ...src } = op.payload.src; // eslint-disable-line no-unused-vars
          return { ...op, payload: { ...op.payload, src } };
        }
        return op;
      });
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

  /**
   * Move a dataset to the recycle bin. This is a **status change, not a teardown**: the
   * DataStore instance (and every DuckDB table behind it) moves to `#binned`, and a
   * `removeDataset` op records the change. Nothing is copied anywhere, so a restore is
   * instant and free — the bin is a view of the log, not a second store (#149 A8).
   *
   * The log KEEPS the dataset's data ops. The `removeDataset` op is the authoritative
   * deletion signal; a physical drop would break the audit trail AND resurrect the ops
   * on merge, since an op absent from the shared-id ancestor reads as the peer's
   * ADDITION (the delete-inference class #148 exists to kill).
   *
   * Removing the **last** dataset isn't forbidden — it resets the project to a fresh
   * empty dataset (the "clear the clutter and start fresh" gesture), so there's always
   * an active one. Otherwise, if the removed one was active, another becomes active.
   */
  async remove(id) {
    const ds = this.#datasets.get(id);
    if (!ds) return;
    // An empty dataset has nothing to recover, so it's removed AND purged in one go —
    // otherwise every "clear the clutter" gesture would leave a blank bin entry.
    const recoverable = ds.getHistory().applied.length > 0;
    this.#datasets.delete(id);
    this.#log.append(collRemove(id));
    if (recoverable) {
      this.#binned.set(id, ds); // tables intact — restore costs nothing
    } else {
      await ds.dispose();
      this.#log.append(collPurge(id));
    }
    // Tell the save path this dataset's bytes must be durable now: it is no longer in
    // the live set, so an incremental save would otherwise never write its sidecars,
    // and a delete before the first full save would lose them.
    this.#bus.emit(CoreEvents.DATA_CHANGED, { datasetId: id, rowCount: 0, variables: [], reason: 'binned' });
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

  /** What's in the recycle bin: the {@link BIN} projection (the index) joined to the
   * retained instances for a row count. Synchronous — there is no separate store to
   * await, because the bin IS the log. */
  binnedList() {
    return this.#log.state('bin').map((b) => ({
      id: b.id,
      name: b.name,
      deletedAt: b.deletedAt,
      rowCount: this.#binned.get(b.id)?.rowCount ?? 0,
    }));
  }

  /** The retained (binned) DataStores. The save path serialises these alongside the
   * live ones, so a deleted dataset's ops AND its Parquet sidecars survive a reload —
   * which is what makes the bin durable without a second copy of anything. */
  binnedStores() {
    return [...this.#binned.values()];
  }

  /**
   * Bring a dataset back from the bin: an appended `addDataset` and a move between two
   * Maps. **No bytes are read, written, or copied** — the instance and its DuckDB
   * tables were never torn down. It returns under its original id, so everything keyed
   * by dataset id (workspace/CAQDAS coding above all — #149 A4) re-attaches by itself.
   *
   * @param {{id: number, activate?: boolean}} entry
   * @returns {Promise<{id: number}>}
   */
  async restoreDeleted({ id, activate = true }) {
    const ds = this.#binned.get(id);
    if (!ds) throw new Error('That dataset is no longer in the bin.');
    const entry = this.#log.state('bin').find((b) => String(b.id) === String(id));
    this.#binned.delete(id);
    this.#datasets.set(id, ds);
    this.#log.append(collAdd(id, entry?.name ?? ds.name));
    if (activate || this.#activeId === null) {
      this.#activeId = id;
      this.#emitActive('switch');
    } else {
      this.#bus.emit(DATASETS_CHANGED, this.list());
    }
    return { id };
  }

  /**
   * Permanently destroy a binned dataset: drop its DuckDB state and append
   * `purgeDataset` — the point of no return, and the signal that stops the save path
   * writing its sidecars (so the sweep can delete them). Its op envelopes stay in the
   * log, byte-less via {@link DatasetManager#orphanDataOps}, so the audit trail and
   * merge identity survive; only the data is gone.
   *
   * @param {number} id
   */
  async purge(id) {
    const ds = this.#binned.get(id);
    if (ds) {
      await ds.dispose();
      this.#binned.delete(id);
    }
    this.#log.append(collPurge(id));
    this.#bus.emit(CoreEvents.DATA_CHANGED, { datasetId: id, rowCount: 0, variables: [], reason: 'purged' });
    this.#bus.emit(DATASETS_CHANGED, this.list());
  }

  /**
   * Replace the collection + data tiers from the **flat one-true-log** (the single
   * `manifest.log`, filtered to this manager's tiers by the caller or here): dispose the
   * open datasets, receive the collection ops (membership), then reconstruct each live
   * dataset by materialising its source bytes + folding its slice. Orphaned data ops (a
   * deleted dataset's superseded steps) are kept in the log for audit + merge-safety but
   * never re-materialised. Other tiers (analysis, workspace) are restored by their own
   * subsystems from the same shared log. An empty log yields one fresh blank dataset.
   *
   * @param {{log?: object[], activeId?: number, datasetMeta?: Record<string, {libraryLink?: object}>}} bundle
   */
  async loadBundle({ log = [], activeId, datasetMeta = {}, empty = false }) {
    for (const ds of this.#datasets.values()) await ds.dispose();
    for (const ds of this.#binned.values()) await ds.dispose();
    this.#datasets.clear();
    this.#binned.clear();
    this.#activeId = null;
    // Clear only the tiers this manager owns (collection + data); analysis/workspace are
    // cleared+restored by their own subsystems on the shared log.
    this.#log.clearWhere(
      (op) => COLLECTION.match(op) || (op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('ds:')),
    );
    const isDs = (o) => o.owner === 'core' && typeof o.target === 'string' && o.target.startsWith('ds:');
    const dsIdOf = (o) => { const m = /^ds:([^/]+)\//.exec(o.target); return m ? m[1] : null; };
    const collOps = log.filter((o) => COLLECTION.match(o));
    const dsOps = log.filter(isDs);
    // Membership first (ids + names + order + removes), straight from the real ops.
    this.#log.receiveOps(collOps);
    const members = this.#collection(); // folded [{id, name}] in order
    const binMembers = this.#log.state('bin'); // deleted-but-recoverable, same fold family
    const heldIds = new Set([...members, ...binMembers].map((m) => String(m.id)));
    // Group each dataset's ops (with source bytes attached) by its id.
    const byId = new Map();
    for (const o of dsOps) {
      const k = dsIdOf(o);
      if (k == null) continue;
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(o);
    }
    // Reconstruct each held dataset with its SAVED id (source sidecars are op-id keyed).
    // Binned ones are rebuilt exactly like live ones — same ops, same bytes, same tables
    // — they just land in `#binned`, because "deleted" is a status in the log and not a
    // different kind of storage. That's what makes a restore after a reload free too.
    for (const { id, name } of [...members, ...binMembers]) {
      const into = binMembers.some((b) => b.id === id) ? this.#binned : this.#datasets;
      const ds = new DataStore(this.#bus, this.#duckdb, { id, name, log: this.#log });
      ds.libraryLink = datasetMeta?.[id]?.libraryLink ?? datasetMeta?.[String(id)]?.libraryLink ?? null;
      into.set(id, ds);
      try {
        await ds.rawRestore(byId.get(String(id)) ?? []); // materialise sources + fold, ids preserved
      } catch (err) {
        // Last resort only: rawRestore now survives a source that won't materialise
        // (it lands byte-less and rederive skips it — #149 B3), so reaching here means
        // something worse. Drop the instance; the dataset stays in the collection
        // membership and re-materialises on the next apply once its bytes arrive. Its
        // OPS are already in the log by this point, so the next save can't lose them.
        console.error('[dataset] restore failed; dropping until its data arrives:', id, err);
        into.delete(id);
        try { await ds.dispose(); } catch { /* best-effort */ }
      }
    }
    // Ops of PURGED datasets — keep them in the log for audit + merge-safety; nothing
    // folds them (their bytes are gone by the user's explicit choice).
    const orphan = dsOps.filter((o) => !heldIds.has(dsIdOf(o)));
    if (orphan.length) this.#log.receiveOps(orphan);
    // An OPEN project always has at least one dataset, so a blank load gets one — but
    // `empty` says no project is open at all (#158), and then there is nothing to make a
    // dataset for. The difference is not cosmetic: `add` appends a real collection op,
    // and that op is what used to travel from a joiner's landing-pad project into the
    // host's, arriving as a mystery "Dataset 1" nobody created.
    if (!empty && this.#datasets.size === 0) this.add('Dataset 1', { activate: true });
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
  /**
   * The dataset every `load*` lands in, creating one if the project has none (#158).
   *
   * There used to be a dataset from app boot, so these delegates could assume `active`.
   * That boot dataset is gone — it was the phantom "Dataset 1" that travelled into a
   * co-author's project — so the first load into a fresh project makes its own. This is
   * the honest place for it: loading data is precisely when a dataset is needed, whereas
   * creating one at boot asserted that a project existed before the user had chosen
   * anything.
   */
  #target() {
    return this.active ?? this.add('Dataset 1', { activate: true }); // `add` returns the store
  }

  setDataset(d) {
    return this.#target().setDataset(d);
  }
  loadDataset(d) {
    return this.#target().loadDataset(d);
  }
  loadStreaming(o) {
    return this.#target().loadStreaming(o);
  }
  loadWide(o) {
    return this.#target().loadWide(o);
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
