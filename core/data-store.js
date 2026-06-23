/**
 * @file data-store.js
 * The canonical dataset and its published API surface.
 *
 * ## Source-immutable architecture: sources + transform log → derived view
 *
 * The imported data is the **immutable source of truth** and is never
 * overwritten (see the README principle). Concretely:
 *
 *  - **Source tables** (`ct_source_1`, …) hold each imported/appended file's
 *    data in DuckDB. They are created once and never altered.
 *  - **The universal log** (`#log`) is one ordered list of *every* operation —
 *    data loads (import/append/join) and data transforms (recode/retype/compute/
 *    cell edit) alike. It is data, not mutation — inspectable, undoable, and
 *    exportable as a do-file. {@link DataStore#rederive} partitions it by op kind.
 *  - **`dataset`** is a DuckDB **VIEW** derived from the sources + the log. Every
 *    read in the app queries it. Metadata-only transforms (relabel, designate
 *    missing, retype-to-factor) just recompute the JS-side metadata; only
 *    retype-to-numeric (a `CAST` in the view) and append (another source in the
 *    `UNION ALL BY NAME`) change the view definition — a cheap DDL redefine, no
 *    data copy. So sources stay immutable and there is no source/working
 *    duplication.
 *
 * Values live in DuckDB-WASM (see {@link DuckDBManager}); this class is a facade.
 * The decision to use DuckDB — rather than in-memory JS arrays — was proven out
 * before the rewrite; see `spike/RESULTS.md`.
 *
 * What stays in JS, synchronously, is only the small stuff every part of the UI
 * needs without awaiting: variable **metadata** (labels, value labels, missing
 * codes, measurement level), the **row count**, and the user's **selection**.
 * That keeps the sidebar and dialog code synchronous. Anything that pulls actual
 * cell data — {@link DataStore#getColumns}, {@link DataStore#getDataFrame} — is
 * **async**, because it queries DuckDB.
 *
 * The *public* API hands plugins row-oriented objects (`[{col: val}, ...]`) and
 * columnar arrays, the shapes plugin authors expect and that map cleanly onto an
 * R `data.frame`. Metadata (SPSS/Haven semantics) lives here because SQL columns
 * don't carry labels, value labels, missing codes, or measurement level.
 *
 * ### Bridge rules baked in (from the spikes)
 * Numeric columns are read back with an explicit `CAST(... AS DOUBLE)`: DuckDB
 * can store a column as DECIMAL, and pulling a decimal through Arrow-JS without
 * the cast silently scales it wrong (the `mean=590000` bug — see RESULTS.md).
 */

import { CoreEvents } from './event-bus.js';
import { quoteIdent } from './duckdb-manager.js';

/** Column auto-added when stacking files, tagging each row with its origin so a
 * pooled multi-file/multi-year dataset stays distinguishable (group/filter by
 * it). Chosen to be unlikely to collide with real variable names. */
const SOURCE_COL = 'source_file';

/**
 * Hidden, **stable per-row id** baked into each immutable source table. Cell
 * edits ({@link DataStore#setCell}) key on it instead of a positional index, so
 * an edited value follows its row through appends and row-reordering joins. It's
 * part of the immutable source (created once, persisted in the source Parquet,
 * never regenerated on restore), travels through the derived view, and is kept
 * out of the user-facing variable list. Not a real variable — never in `#variables`.
 */
const ROWID_COL = '__ct_rid';

/** Row-id namespacing: `sourceIndex * ROWID_STRIDE + rowNumber`. The stride caps
 * a single source at 1e9 rows (far beyond what the runtimes carry) while keeping
 * ids well under 2^53 for realistic source counts, so they survive the BIGINT→JS
 * trip exactly. (Ids are also passed as digit strings, never parsed to float.) */
const ROWID_STRIDE = 1_000_000_000;

/** Per-row sequential index baked into a **wide source**'s Parquet file (assigned
 * in import order). The stable row id is derived from it; it also gives reads a
 * cheap ordering key. Internal; never surfaced as a variable. */
const CT_ROW = '__ct_row';

/** Log op types that are *data transforms* (vs. load/append/join source ops).
 * `getTransforms()` and the persisted `transforms` array carry only these. */
const DATA_OPS = new Set(['setVariable', 'setCell', 'computeVar', 'recodeVar', 'filterCases']);

/** Log op types that are *source* operations (data loads). */
const SOURCE_OPS = new Set(['load', 'append', 'join']);

/**
 * @typedef {'numeric' | 'string' | 'factor'} VariableType
 * Storage/semantics of a variable. `numeric` is stored as a DuckDB DOUBLE and
 * returned as a `Float64Array`; `string` and `factor` are stored as DuckDB
 * VARCHAR and returned as plain arrays. A `factor` additionally expects
 * `valueLabels` mapping codes to human-readable categories.
 */

/**
 * @typedef {'nominal' | 'ordinal' | 'scale'} MeasurementLevel
 * SPSS-style measurement level, used by analyses to decide which procedures are
 * appropriate (e.g. a mean is meaningful for `scale`, not for `nominal`).
 */

/**
 * @typedef {Object} VariableMeta
 * @property {string} name - Machine name / column identifier. Unique per dataset.
 * @property {string} [label] - Human-readable description shown in the UI.
 * @property {VariableType} type - How the column is stored and interpreted.
 * @property {Object<string|number, string>} [valueLabels] - Code → label map,
 *   e.g. `{1: "Low", 2: "Medium", 3: "High"}`.
 * @property {Array<number|string>} [missingValues] - Sentinel values that mean
 *   "missing", e.g. `[-99, -98]`. These are *user-defined* missing values; a
 *   genuine empty cell is represented as `null` (numeric: `NaN`).
 * @property {MeasurementLevel} [measurementLevel] - Analytic role of the variable.
 */

/**
 * The canonical dataset for the session. There is exactly one live instance,
 * created by the app bootstrap and exposed to plugins (read-mostly) through the
 * {@link DataStore#api} surface.
 */
export class DataStore {
  /** @type {import('./event-bus.js').EventBus} */
  #bus;

  /** Storage engine: the live DuckDB-WASM runtime. @type {import('./duckdb-manager.js').DuckDBManager} */
  #duckdb;

  /** Stable id of this dataset within the {@link DatasetManager}. */
  #id;

  /** Name of the **working view** this dataset's reads query. Namespaced by id so
   * many datasets coexist in one DuckDB. Derived from sources + the log. */
  #view;

  /** Prefix for this dataset's immutable per-file source tables (namespaced). */
  #sourcePrefix;

  /** Human-readable dataset name (shown in the switcher); mutable (rename). */
  name;

  /** Library binding: `{ id, name }` of the saved entry this dataset autosaves
   * to, or `null` if unsaved. Per-dataset so each can bind independently.
   * (Legacy of the pre-projects model; projects now own autosave — kept harmless.) */
  binding = null;

  /** Link to a building-block library entry this dataset is the working copy of:
   * `{ id, version }` or null. Set when added from / promoted to the library, so
   * an explicit re-save UPDATES that block (bumping its version) instead of
   * duplicating, and the sidebar can show "linked to V<n>". Persisted in the
   * project bundle. (Version *propagation/pull* is a later feature.) */
  libraryLink = null;

  /**
   * The **universal operation log**: one ordered, replayable history of *every*
   * operation — data loads and data transforms alike. Entry types:
   *  - `{type:'load', src}` — the base import (a replace resets the log to this).
   *  - `{type:'append', src}` — stack more rows (another immutable source).
   *  - `{type:'join', src, joinKey, aliases}` — add columns by a key.
   *  - `{type:'setVariable', name, patch}` — metadata edit.
   *  - `{type:'setCell', rid, column, value, row}` — sparse cell override.
   *  - `{type:'computeVar'|'recodeVar', name, …}` — derived variable.
   * where `src = {table, meta, label}` references an immutable DuckDB source table.
   *
   * {@link DataStore#rederive} partitions this by op kind to build the view, so the
   * *result* is identical to the old sources+transforms split — but now loads are
   * first-class history: undoable, rewindable, and shown as steps. The persisted
   * shape ({@link DataStore#exportState}) stays `{sources, transforms}` (derived
   * from the log), so the project/library tiers are unchanged.
   * @type {Array<object>}
   */
  #log = [];

  /**
   * Undone operations, most-recently-undone last — the redo stack. Cleared by any
   * new operation (standard undo/redo branch-discard).
   * @type {Array<object>}
   */
  #redoStack = [];

  /** Monotonic source-table counter (never reused), so an undone source op leaves
   * no naming/row-id collision for a later one. Also the row-id namespace. */
  #sourceSeq = 0;

  /** Every source table this dataset has materialised, for reliable cleanup
   * (undone/redo-discarded sources would otherwise leak until dispose). @type {Set<string>} */
  #sourceTables = new Set();

  /** Every registered OPFS Parquet file backing a wide source, for the same
   * reliable cleanup — these are files, not tables. @type {Set<string>} */
  #wideFiles = new Set();

  /**
   * DERIVED: variable metadata in display order — the synchronous cache the UI
   * reads. Recomputed by {@link DataStore#rederive} from the sources' metadata
   * with the transform log applied.
   * @type {VariableMeta[]}
   */
  #variables = [];

  /** DERIVED: name → meta, for O(1) lookup. @type {Map<string, VariableMeta>} */
  #byName = new Map();

  /**
   * DERIVED: name → the working view's DuckDB SQL type string (e.g. `DOUBLE`,
   * `BIGINT`, `DATE`). Refreshed on rederive; drives the type-aware casting in
   * {@link DataStore#getColumns}/{@link DataStore#getInjectionParquet}.
   * @type {Map<string, string>}
   */
  #sqlTypes = new Map();

  /** DERIVED: number of cases (rows) in the working view. */
  #rowCount = 0;

  /**
   * Names of variables the user has highlighted in the UI. Selection *state*,
   * not data, but dataset-scoped and needed by every analysis dialog.
   * @type {string[]}
   */
  #selected = [];

  /**
   * @param {import('./event-bus.js').EventBus} bus - App event bus.
   * @param {import('./duckdb-manager.js').DuckDBManager} duckdb - Storage engine.
   * @param {Object} [opts]
   * @param {number|string} [opts.id=1] - Unique id; namespaces this dataset's
   *   DuckDB tables/view so multiple datasets coexist.
   * @param {string} [opts.name='Dataset'] - Display name.
   */
  constructor(bus, duckdb, { id = 1, name = 'Dataset' } = {}) {
    this.#bus = bus;
    this.#duckdb = duckdb;
    this.#id = id;
    this.name = name;
    this.#view = `ct_view_${id}`;
    this.#sourcePrefix = `ct_src_${id}_`;
  }

  /** @returns {number|string} This dataset's id. */
  get id() {
    return this.#id;
  }

  // ---------------------------------------------------------------------------
  // Mutation (engine-side; not part of the plugin API yet)
  // ---------------------------------------------------------------------------

  /**
   * Replace the entire dataset. This is how an importer (CSV, .sav, …) loads
   * data, and how tests/the demo seed a dataset. Loads the columns into DuckDB
   * and refreshes the metadata cache. Emits {@link CoreEvents.DATA_CHANGED}.
   *
   * @param {Object} dataset
   * @param {VariableMeta[]} dataset.variables - Column metadata, in display order.
   * @param {Object<string, Array>} dataset.columns - name → raw value array.
   *   Each array must have the same length, which becomes the row count.
   * @returns {Promise<void>}
   */
  async setDataset({ variables, columns }) {
    await this.loadDataset({ variables, columns, mode: 'replace' });
  }

  /**
   * Load a dataset delivered by an importer plugin. Accepts either shape of the
   * importer contract — `{ variables, columns }` (JS-parsed, e.g. CSV) or
   * `{ variables, parquet }` (R/`haven`-parsed) — and either **replaces** the
   * current dataset or **appends** (stacks rows) onto it.
   *
   * Replace resets the sources and the transform log to a fresh import; append
   * adds another immutable source (reconciled by name via `UNION ALL BY NAME` in
   * the derived view, NULL-filling vars a file lacks, with each file's rows tagged
   * by a `source_file` column). The engine — never a plugin — calls this, only in
   * response to a user import action.
   *
   * @param {Object} dataset
   * @param {VariableMeta[]} dataset.variables
   * @param {Object<string, Array>} [dataset.columns]
   * @param {Uint8Array} [dataset.parquet]
   * @param {'replace'|'append'|'join'} [dataset.mode='replace'] - `replace` resets
   *   to a single base source; `append` stacks rows (UNION); `join` adds the new
   *   dataset's columns by matching a key (LEFT JOIN onto the stacked base).
   * @param {string} [dataset.source] - Provenance label for this file's rows.
   * @param {{left: string, right: string}} [dataset.joinKey] - For `join`: the key
   *   column on the current data (`left`) and the incoming data (`right`).
   * @param {Array<{base: string, incoming: string}>} [dataset.aliases] - For `join`:
   *   manual key matches the user paired up in review (incoming value → base value),
   *   applied on top of normalized-exact matching.
   * @returns {Promise<void>}
   */
  async loadDataset({ variables, columns, parquet, mode = 'replace', source, joinKey, aliases, joinType }) {
    const combine = this.#hasData() && (mode === 'append' || mode === 'join') ? mode : 'replace';
    if (combine === 'replace') {
      // A replace is a hard reset: the new import becomes the base of a fresh log.
      await this.#dropAll();
      const src = await this.#createSource({ variables, columns, parquet, source });
      this.#log = [{ type: 'load', src }];
    } else {
      const src = await this.#createSource({ variables, columns, parquet, source });
      this.#log.push(
        combine === 'join'
          ? { type: 'join', src, joinKey, aliases: aliases ?? [], joinType: joinType ?? 'left' }
          : { type: 'append', src },
      );
    }
    // A new operation discards the redo branch (standard undo/redo semantics).
    this.#redoStack = [];
    await this.rederive(combine === 'replace' ? 'replace' : combine);
  }

  /**
   * Load a dataset by **streaming** it into a source table batch-by-batch, for
   * importers that can't materialise the whole thing in memory (a multi-GB
   * .sav/.dta read by ReadStat). The caller drives the ingest via the `ctx` it's
   * handed:
   *  - `ctx.begin(variables, storageTypes)` — once, first: records the variable
   *    metadata and creates the (empty) source table with a stable schema.
   *  - `ctx.batch(columns)` — per chunk: appends rows (name→Float64Array|Array).
   *
   * After `ingest` resolves, the row-id is baked in and the source is registered
   * as a `load` (replace) or `append` op, then the view re-derives — identical to
   * any other import from there on.
   *
   * @param {Object} opts
   * @param {'replace'|'append'} [opts.mode='replace']
   * @param {string} [opts.source] - Provenance label.
   * @param {(ctx: {begin: Function, batch: Function}) => Promise<void>} opts.ingest
   * @returns {Promise<void>}
   */
  async loadStreaming({ mode = 'replace', source, ingest }) {
    const combine = this.#hasData() && mode === 'append' ? 'append' : 'replace';
    if (combine === 'replace') await this.#dropAll();

    const seq = ++this.#sourceSeq;
    const table = `${this.#sourcePrefix}${seq}`;
    // Bake the stable row id into the ingest (namespaced by seq, like #ensureRowId)
    // so there's no separate full-table rewrite afterwards. Row order is irrelevant
    // — the id only needs to be unique and stable per row.
    const base = seq * ROWID_STRIDE;
    let meta = null;
    let ingester = null;

    const ctx = {
      begin: async (variables, storageTypes) => {
        meta = variables;
        ingester = await this.#duckdb.beginStreamIngest(table, storageTypes, {
          rowidCol: ROWID_COL,
          rowidBase: base,
        });
      },
      batch: async (columns) => {
        if (!ingester) throw new Error('loadStreaming: batch before begin()');
        await ingester.addBatch(columns);
      },
    };

    try {
      await ingest(ctx);
      if (ingester) await ingester.finish();
    } catch (err) {
      // Roll back a half-built source so the dataset isn't left broken, and sweep
      // any leftover OPFS ingest parts.
      try {
        await this.#duckdb.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      } catch {
        /* best-effort */
      }
      try {
        await this.#duckdb.cleanupStreamIngest(table);
      } catch {
        /* best-effort */
      }
      throw err;
    }
    if (!meta) throw new Error('streaming import delivered no variables');

    this.#sourceTables.add(table);
    // Row id already baked into the table by the ingest CTAS (no #ensureRowId).
    const src = { table, meta: meta.map((m) => ({ ...m })), label: source ?? null };
    if (combine === 'replace') this.#log = [{ type: 'load', src }];
    else this.#log.push({ type: 'append', src });
    this.#redoStack = [];
    await this.rederive(combine);
  }

  /**
   * Load a **very wide** file as a *wide source*: a single streaming pass encodes
   * the data — in JS, outside DuckDB — to one Parquet **file** on OPFS (carrying a
   * `__ct_row` index), and the dataset reads it back with `read_parquet`.
   *
   * Why a file, not a table: ingesting the full GSS (~6,942 cols) into a DuckDB
   * table FATAL-OOMs — DuckDB-WASM's checkpoint can't accumulate past ~600 MB and
   * can't spill (OPFS temp is unimplemented). Encoding Parquet in JS bypasses the
   * whole write/checkpoint path; DuckDB only ever *reads* the file, which is
   * genuinely out-of-core (the full file reads in ~1 s using a few MB of heap).
   *
   * The file is written one row group at a time from the stream, so only
   * `rowGroupRows` rows are buffered at once regardless of total size — and it's a
   * single file read (no per-column passes, no join).
   *
   * @param {Object} opts
   * @param {'replace'|'append'} [opts.mode='replace']
   * @param {string} [opts.source]
   * @param {number} [opts.rowGroupRows=8000] - Rows buffered per row group.
   * @param {import('./data-store.js').VariableMeta[]} opts.variables - The file
   *   catalog (column order + source metadata).
   * @param {number} opts.rowCount - Total rows (from the catalog), for progress.
   * @param {(done: number, total: number) => void} [opts.onProgress] - Row tick.
   * @param {(onBatch: (columns: object) => void) => Promise<void>} opts.stream
   *   - Stream the whole file once, calling `onBatch` per batch of rows (all columns).
   * @returns {Promise<void>}
   */
  async loadWide({ mode = 'replace', source, rowGroupRows = 8000, variables, rowCount, onProgress, stream }) {
    if (!Array.isArray(variables) || variables.length === 0) {
      throw new Error('loadWide: variables (the file catalog) are required');
    }
    const combine = this.#hasData() && mode === 'append' ? 'append' : 'replace';
    if (combine === 'replace') await this.#dropAll();

    const seq = ++this.#sourceSeq;
    const base = seq * ROWID_STRIDE;
    const file = `${this.#sourcePrefix}${seq}.parquet`;

    const columns = variables.map((v) => ({ name: v.name, type: v.type === 'string' ? 'string' : 'numeric' }));
    columns.push({ name: CT_ROW, type: 'numeric' });
    const writer = await this.#duckdb.openParquetWriter(columns);

    // Accumulate the stream into row-group-sized column buffers, flush each as one
    // Parquet row group, then reset — so peak JS memory is one row group, not the
    // whole (potentially multi-GB uncompressed) dataset.
    const freshAcc = () => {
      const a = {};
      for (const v of variables) a[v.name] = [];
      a[CT_ROW] = [];
      return a;
    };
    let acc = freshAcc();
    let accRows = 0;
    let rowBase = 0;
    const flush = () => {
      if (accRows === 0) return;
      const columnData = variables.map((v) => ({
        name: v.name,
        data: acc[v.name],
        ...(v.type === 'string' ? {} : { type: 'DOUBLE' }),
      }));
      columnData.push({ name: CT_ROW, data: acc[CT_ROW], type: 'DOUBLE' });
      writer.writeRowGroup(columnData);
      acc = freshAcc();
      accRows = 0;
    };

    try {
      await stream((cols) => {
        const first = variables[0].name;
        const n = first && cols[first] ? cols[first].length : 0;
        for (const v of variables) {
          const src = cols[v.name];
          const dst = acc[v.name];
          for (let k = 0; k < n; k++) dst.push(src[k]);
        }
        const rowIdx = acc[CT_ROW];
        for (let k = 0; k < n; k++) rowIdx.push(rowBase + k);
        rowBase += n;
        accRows += n;
        if (accRows >= rowGroupRows) flush();
        onProgress?.(rowBase, rowCount);
      });
      flush();
      await writer.finalize(file);
      this.#wideFiles.add(file);
    } catch (err) {
      try { await this.#duckdb.dropRegisteredFile(file, { removeFromOpfs: true }); } catch { /* best-effort */ }
      throw err;
    }

    const src = {
      wide: true,
      file,
      rowidBase: base,
      meta: variables.map((m) => ({ ...m })),
      label: source ?? null,
    };
    if (combine === 'replace') this.#log = [{ type: 'load', src }];
    else this.#log.push({ type: 'append', src });
    this.#redoStack = [];
    await this.rederive(combine);
  }

  /** Whether any data is loaded (the log has a source op). */
  #hasData() {
    return this.#sourceOps().length > 0;
  }

  /**
   * The read relation for the column readers. Normally the working view, but for a
   * dataset that is exactly one wide source with no transforms (the common case
   * right after importing a huge file), reads go **straight to `read_parquet`**.
   * Going through the view would force DuckDB to bind all ~6,942 column expressions
   * on every query (~0.8 s of pure overhead) even to fetch a 12-column grid window;
   * reading the Parquet directly with just the needed columns skips that.
   *
   * @returns {{ from: string, rid: string }} `from` SQL relation + row-id expression.
   */
  #readRelation() {
    if (this.#log.length === 1) {
      const op = this.#log[0];
      if (op.type === 'load' && op.src.wide) {
        return {
          from: `read_parquet(${sqlString(op.src.file)})`,
          rid: `CAST(${op.src.rowidBase} AS BIGINT) + CAST(${quoteIdent(CT_ROW)} AS BIGINT) + 1`,
        };
      }
    }
    return { from: quoteIdent(this.#view), rid: quoteIdent(ROWID_COL) };
  }

  /** The load/append/join ops in the active log, in order (the base is first). */
  #sourceOps() {
    return this.#log.filter((o) => o.type === 'load' || o.type === 'append' || o.type === 'join');
  }

  /**
   * Materialise one immutable source table from a loaded file and return its
   * descriptor `{table, meta, label}`. A fresh, never-reused sequence number names
   * the table and namespaces its row ids. Does not touch the working view.
   *
   * @returns {Promise<{table: string, meta: VariableMeta[], label: string|null}>}
   */
  async #createSource({ variables, columns, parquet, source }) {
    const seq = ++this.#sourceSeq;
    const table = `${this.#sourcePrefix}${seq}`;
    if (parquet) {
      await this.#duckdb.replaceTableFromParquet(table, parquet);
    } else {
      const cols = columns ?? {};
      const lengths = variables.map((v) => (cols[v.name] ?? []).length);
      const rowCount = lengths.length ? lengths[0] : 0;
      if (lengths.some((len) => len !== rowCount)) {
        throw new Error('DataStore: all columns must have equal length');
      }
      const coerced = {};
      for (const meta of variables) coerced[meta.name] = coerceColumn(meta, cols[meta.name] ?? []);
      await this.#duckdb.replaceTable(table, coerced);
    }
    this.#sourceTables.add(table);
    await this.#ensureRowId(table, seq);
    return { table, meta: variables.map((m) => ({ ...m })), label: source ?? null };
  }

  /** Restore a wide source from its persisted Parquet bytes: write the file back to
   * OPFS and register it for `read_parquet` (it carries `__ct_row`). The saved
   * row-id base is kept so row ids are stable across save/restore. */
  async #restoreWideSource(src) {
    const seq = ++this.#sourceSeq;
    const file = `${this.#sourcePrefix}${seq}.parquet`;
    await this.#duckdb.registerParquetFile(file, src.parquet);
    this.#wideFiles.add(file);
    return {
      wide: true,
      file,
      rowidBase: src.rowidBase ?? seq * ROWID_STRIDE,
      meta: src.meta.map((m) => ({ ...m })),
      label: src.label ?? null,
    };
  }

  /**
   * Bake the stable {@link ROWID_COL} into a freshly created source — unless it
   * already carries one (the restore path: the id was persisted in the source
   * Parquet, so keep it). Ids are namespaced by the source sequence number so
   * they're unique across a pooled/joined dataset and never collide.
   *
   * @param {string} table - The source table name.
   * @param {number} seq - The source's sequence number (namespaces the id range).
   */
  async #ensureRowId(table, seq) {
    const desc = await this.#duckdb.query(`DESCRIBE ${quoteIdent(table)}`);
    for (let i = 0; i < desc.numRows; i++) {
      if (String(desc.get(i).column_name) === ROWID_COL) return; // restored — keep it
    }
    const base = seq * ROWID_STRIDE;
    await this.#duckdb.query(
      `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT *, ` +
        `CAST(${base} AS BIGINT) + CAST(row_number() OVER () AS BIGINT) AS ${quoteIdent(ROWID_COL)} ` +
        `FROM ${quoteIdent(table)}`,
    );
  }

  /** Drop the working view, every source table, and every registered chunk file
   * this dataset ever materialised (including ones left by undone/discarded ops);
   * reset the log. */
  async #dropAll() {
    await this.#duckdb.query(`DROP VIEW IF EXISTS ${quoteIdent(this.#view)}`);
    for (const table of this.#sourceTables) {
      await this.#duckdb.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    }
    this.#sourceTables.clear();
    for (const file of this.#wideFiles) {
      try { await this.#duckdb.dropRegisteredFile(file, { removeFromOpfs: true }); } catch { /* best-effort */ }
    }
    this.#wideFiles.clear();
    this.#log = [];
    this.#redoStack = [];
  }

  /**
   * Recompute everything derived from the operation log (`#log`): the variable
   * metadata cache, the working `dataset` view, the SQL types, and the row count.
   * Then emit {@link CoreEvents.DATA_CHANGED}. This is the single place the
   * "source + log → derived" projection happens.
   *
   * @param {string} [reason='change'] - What prompted the re-derivation
   *   (`'replace'`/`'append'`/`'transform'`/`'undo'`/`'redo'`/`'restore'`). Passed
   *   through on the DATA_CHANGED event so the library sync can decide whether to
   *   autosave, unbind, or ignore.
   * @returns {Promise<void>}
   */
  async rederive(reason = 'change') {
    // STRICT SEQUENTIAL REPLAY: fold the log in order, so each op sees exactly the
    // dataset state the ops before it produced — true do-file semantics. A compute
    // logged before a join is evaluated over the pre-join data (and appended rows
    // added after it get NULL for it, via UNION ALL BY NAME). This guarantees the
    // engine's result matches running the log as a script.
    const log = this.#log;
    // source_file provenance appears once there's >1 stacked source (load+append).
    const multiStacked = log.filter((o) => o.type === 'load' || o.type === 'append').length > 1;

    /** @type {Map<string, VariableMeta>} */
    const byName = new Map();
    let sql = null;

    const addSourceFile = () => {
      if (multiStacked && !byName.has(SOURCE_COL)) {
        byName.set(SOURCE_COL, { name: SOURCE_COL, label: 'Source file', type: 'factor', measurementLevel: 'nominal' });
      }
    };

    for (const op of log) {
      if (op.type === 'load') {
        byName.clear();
        for (const m of op.src.meta) if (!byName.has(m.name)) byName.set(m.name, { ...m });
        addSourceFile();
        sql = this.#sourceSelectSql(op.src, multiStacked);
      } else if (op.type === 'append') {
        for (const m of op.src.meta) if (!byName.has(m.name)) byName.set(m.name, { ...m });
        addSourceFile();
        sql = `(${sql}) UNION ALL BY NAME (${this.#sourceSelectSql(op.src, multiStacked)})`;
      } else if (op.type === 'join') {
        const jt = ({ left: 'LEFT', inner: 'INNER', right: 'RIGHT', full: 'FULL' })[
          (op.joinType || 'left').toLowerCase()
        ] || 'LEFT';
        const addsRightRows = jt === 'RIGHT' || jt === 'FULL';
        const keyNumeric = byName.get(op.joinKey?.left)?.type === 'numeric';
        const cols = [];
        for (const m of op.src.meta) {
          if (m.name === op.joinKey?.right) continue; // drop the redundant right key (kept via the base key below)
          let out = m.name;
          if (byName.has(out)) out = uniqueName(`${m.name}${op.src.label ? ` (${op.src.label})` : ' (joined)'}`, byName);
          byName.set(out, { ...m, name: out });
          cols.push({ orig: m.name, out });
        }
        const joinedSel = cols.map((c) => {
          const ref = `J.${quoteIdent(c.orig)}`;
          return `${byName.get(c.out)?.type === 'numeric' ? `TRY_CAST(${ref} AS DOUBLE)` : ref} AS ${quoteIdent(c.out)}`;
        });
        const cond = joinConditionSql('C', 'J', { joinKey: op.joinKey, aliases: op.aliases });
        if (addsRightRows) {
          // RIGHT/FULL introduce rows with no left match → for those, C.* is all NULL.
          // Coalesce the row id (J's ids are stride-namespaced per source, so they
          // stay unique) and the key column from the join source, so the right-only
          // rows keep a stable id and a populated key instead of NULLs.
          const rid = quoteIdent(ROWID_COL);
          const lk = quoteIdent(op.joinKey.left);
          const rk = quoteIdent(op.joinKey.right);
          const keyCoalesce = keyNumeric
            ? `COALESCE(C.${lk}, TRY_CAST(J.${rk} AS DOUBLE))`
            : `COALESCE(CAST(C.${lk} AS VARCHAR), CAST(J.${rk} AS VARCHAR))`;
          const base =
            `C.* EXCLUDE (${rid}, ${lk}), ` +
            `COALESCE(C.${rid}, J.${rid}) AS ${rid}, ${keyCoalesce} AS ${lk}`;
          sql =
            `SELECT ${base}${joinedSel.length ? ', ' + joinedSel.join(', ') : ''} ` +
            `FROM (${sql}) AS C ${jt} JOIN ${quoteIdent(op.src.table)} AS J ON ${cond}`;
        } else {
          sql =
            `SELECT ${['C.*', ...joinedSel].join(', ')} FROM (${sql}) AS C ` +
            `${jt} JOIN ${quoteIdent(op.src.table)} AS J ON ${cond}`;
        }
      } else if (op.type === 'setVariable') {
        applyPatch(byName.get(op.name), op.patch);
        // The only op with a *data* effect: retype-to-numeric casts the column now.
        if (op.patch && op.patch.type === 'numeric' && byName.has(op.name)) {
          const q = quoteIdent(op.name);
          sql = `SELECT * EXCLUDE (${q}), TRY_CAST(${q} AS DOUBLE) AS ${q} FROM (${sql})`;
        }
      } else if (op.type === 'computeVar' || op.type === 'recodeVar') {
        const cast = normType(op.varType) === 'numeric' ? 'DOUBLE' : 'VARCHAR';
        byName.set(op.name, {
          name: op.name,
          label: op.label,
          type: normType(op.varType),
          measurementLevel: cast === 'DOUBLE' ? 'scale' : 'nominal',
        });
        const scalar = op.type === 'computeVar' ? `(${op.expr})` : recodeCaseSql(op);
        sql = `SELECT *, TRY_CAST(${scalar} AS ${cast}) AS ${quoteIdent(op.name)} FROM (${sql})`;
      } else if (op.type === 'filterCases') {
        // Select cases: keep rows where the condition holds. Wrap the running query
        // in a WHERE; rows are filtered in the view, never deleted from sources.
        if (sql !== null) sql = `SELECT * FROM (${sql}) WHERE (${op.expr})`;
      } else if (op.type === 'setCell') {
        if (sql && byName.has(op.column) && /^\d+$/.test(String(op.rid ?? ''))) {
          const q = quoteIdent(op.column);
          const isNum = byName.get(op.column)?.type === 'numeric';
          sql =
            `SELECT * EXCLUDE (${q}), CASE ${quoteIdent(ROWID_COL)} WHEN ${op.rid} ` +
            `THEN ${cellLiteral(op.value, isNum)} ELSE ${q} END AS ${q} FROM (${sql})`;
        }
      }
    }

    this.#variables = [...byName.values()];
    this.#byName = byName;

    if (sql === null) {
      await this.#duckdb.query(`DROP VIEW IF EXISTS ${quoteIdent(this.#view)}`);
      this.#sqlTypes = new Map();
      this.#rowCount = 0;
    } else {
      await this.#duckdb.query(`CREATE OR REPLACE VIEW ${quoteIdent(this.#view)} AS ${sql}`);
      await this.#refreshSqlTypes();
      const c = await this.#duckdb.query(`SELECT count(*) AS n FROM ${quoteIdent(this.#view)}`);
      this.#rowCount = Number(c.get(0).n);
    }

    this.#selected = this.#selected.filter((n) => this.#byName.has(n));
    this.#bus.emit(CoreEvents.DATA_CHANGED, this.#snapshotSummary(reason));
  }

  /** One immutable source's SELECT: its columns (numeric-typed → cast to DOUBLE),
   * the stable row id, and (when pooling >1 stacked source) a `source_file` tag.
   * A chunked source inlines a join across its narrow chunk tables on `__ct_row`
   * (projection pushdown means a read only scans the chunks it needs); its row id
   * is derived from that index. */
  #sourceSelectSql(src, multiStacked) {
    const colExprs = src.meta.map((col) => {
      const q = quoteIdent(col.name);
      return col.type === 'numeric' ? `TRY_CAST(${q} AS DOUBLE) AS ${q}` : q;
    });
    const prov = multiStacked ? `, ${sqlString(src.label ?? 'dataset')} AS ${quoteIdent(SOURCE_COL)}` : '';

    if (src.wide) {
      // Wide source: read the single OPFS Parquet file out-of-core; derive the row
      // id from the baked __ct_row index. Projection pushdown means a read only
      // decodes the selected columns.
      colExprs.push(
        `CAST(${src.rowidBase} AS BIGINT) + CAST(${quoteIdent(CT_ROW)} AS BIGINT) + 1 AS ${quoteIdent(ROWID_COL)}`,
      );
      return `SELECT ${colExprs.join(', ')}${prov} FROM read_parquet(${sqlString(src.file)})`;
    }

    colExprs.push(quoteIdent(ROWID_COL));
    return `SELECT ${colExprs.join(', ')}${prov} FROM ${quoteIdent(src.table)}`;
  }

  /**
   * Apply a metadata transform to one variable: change its label, type,
   * measurement level, value labels, or missing-value codes. Non-destructive —
   * the data is not rewritten — with one exception: re-typing **to numeric**
   * casts the underlying column to DOUBLE (via `TRY_CAST`, non-numeric → NULL) so
   * numeric analyses actually receive numbers. Other type changes are
   * metadata-only (categorical analyses read the column's native storage fine).
   *
   * Designating missing values is the SPSS model: the codes stay in the data and
   * analyses honour `missingValues` (the Frequencies plugin recodes them to NA),
   * so it's fully reversible. Emits {@link CoreEvents.DATA_CHANGED}.
   *
   * @param {string} name
   * @param {Partial<VariableMeta>} patch
   * @returns {Promise<void>}
   */
  async updateVariable(name, patch) {
    if (!this.#byName.has(name)) throw new Error(`updateVariable: unknown variable "${name}"`);

    // Sanitise (this is plugin-callable via app.transform): drop invalid enum
    // values rather than letting them corrupt the metadata.
    patch = { ...patch };
    if ('type' in patch && !['numeric', 'string', 'factor'].includes(patch.type)) {
      delete patch.type;
    }
    if (
      'measurementLevel' in patch &&
      patch.measurementLevel != null &&
      !['nominal', 'ordinal', 'scale'].includes(patch.measurementLevel)
    ) {
      delete patch.measurementLevel;
    }
    if (Object.keys(patch).length === 0) return;

    // Append to the transform log and re-derive — never a destructive edit. The
    // retype-to-numeric cast is applied in the derived view (see rederive), so the
    // source column is untouched and the change is reversible via undo(). A fresh
    // edit discards any redo branch (standard undo/redo semantics).
    this.#log.push({ type: 'setVariable', name, patch });
    this.#redoStack = [];
    await this.rederive('transform');
  }

  /**
   * Edit a single cell — a **sparse override** logged like any transform, so it's
   * non-destructive (the source table is untouched), undoable, shows in the
   * History panel, and exports to syntax. The override is applied at its position
   * in the sequential {@link DataStore#rederive} (a `CASE` on the stable row id);
   * the immutable sources never change. `value` is the raw value the user typed
   * (`''`/null clears the cell to
   * NA); numeric columns parse it, others store it as text.
   *
   * Row identity is a **stable per-row id** ({@link ROWID_COL}) carried from the
   * immutable source, so the edit follows its row through appends and
   * row-reordering joins — not a positional index. `row` is kept only as a
   * human-readable label for the History panel / syntax export.
   *
   * @param {string|number} rid - The row's stable id (from `getRows({includeRowId})`).
   * @param {string} column - Variable name.
   * @param {string|number|null} value - The new raw value (`''`/null → NA).
   * @param {number} [displayRow=0] - The row's position when edited (label only).
   * @returns {Promise<void>}
   */
  async setCell(rid, column, value, displayRow = 0) {
    if (!this.#byName.has(column)) throw new Error(`setCell: unknown variable "${column}"`);
    if (rid == null || !/^\d+$/.test(String(rid))) throw new Error('setCell: invalid row id');
    this.#log.push({
      type: 'setCell',
      rid: String(rid),
      column,
      value: value === '' ? null : value,
      row: Math.max(0, Math.floor(Number(displayRow) || 0)),
    });
    this.#redoStack = [];
    await this.rederive('transform');
  }


  /**
   * Create a **computed variable** from a SQL scalar expression over existing
   * columns (e.g. `weight / (height^2)`). A logged, non-destructive transform: it
   * adds a derived column to the view (sources stay immutable), is undoable, shows
   * in History, and exports to syntax. A later compute may reference an earlier
   * one. Invalid SQL is rejected (the transform is rolled back and the error
   * surfaced) so a bad expression never leaves the dataset broken.
   *
   * @param {string} name - New variable name (must be a fresh identifier).
   * @param {string} expr - A DuckDB scalar expression referencing variable names.
   * @param {VariableType} [varType='numeric']
   * @returns {Promise<void>}
   */
  async computeVariable(name, expr, varType = 'numeric') {
    this.#assertNewVarName(name);
    if (!expr || !String(expr).trim()) throw new Error('Compute: the expression is empty.');
    await this.#addDerivedVar({ type: 'computeVar', name: name.trim(), expr: String(expr), varType: normType(varType) });
  }

  /**
   * Create a **recoded variable** by mapping an existing variable's values via
   * structured rules (collapse categories, reverse-code, bin a scale). A logged,
   * non-destructive transform (new variable by default), undoable, in History, and
   * exported to syntax. Rules are `{from:'value'|'range'|'missing', value?|lo?,hi?,
   * to:{kind:'value'|'copy'|'sysmis', value?}}`; `elseRule` handles all other
   * values (default: copy the source).
   *
   * @param {string} name
   * @param {string} source - Existing variable to recode from.
   * @param {Array<object>} rules
   * @param {VariableType} [varType='numeric']
   * @param {{kind:string, value?:any}} [elseRule]
   * @returns {Promise<void>}
   */
  async recodeVariable(name, source, rules, varType = 'numeric', elseRule = { kind: 'copy' }) {
    this.#assertNewVarName(name);
    if (!this.#byName.has(source)) throw new Error(`Recode: source variable "${source}" not found.`);
    await this.#addDerivedVar({
      type: 'recodeVar',
      name: name.trim(),
      source,
      rules: Array.isArray(rules) ? rules : [],
      elseRule: elseRule ?? { kind: 'copy' },
      varType: normType(varType),
    });
  }

  /**
   * **Select cases**: keep only rows matching a boolean condition (a DuckDB scalar
   * expression over existing variables, e.g. `age >= 18 AND grp = 1`). A logged,
   * non-destructive, reversible transform — sources stay intact; undo, History, and
   * syntax export all see it. Rows are filtered in the derived view, not deleted.
   * Invalid SQL is rejected (rolled back) so the dataset is never left broken.
   *
   * @param {string} expr - A DuckDB boolean expression referencing variable names.
   * @param {string} [label] - Human label for History (defaults to the expression).
   * @returns {Promise<void>}
   */
  async filterCases(expr, label) {
    if (!expr || !String(expr).trim()) throw new Error('Select cases: the condition is empty.');
    const cond = String(expr).trim();
    await this.#addDerivedVar({ type: 'filterCases', expr: cond, label: label || cond });
  }

  /** Push a compute/recode/filter transform and re-derive; roll back if the
   * generated SQL is invalid so the dataset is never left broken. */
  async #addDerivedVar(t) {
    this.#log.push(t);
    this.#redoStack = [];
    try {
      await this.rederive('transform');
    } catch (err) {
      this.#log.pop();
      await this.rederive('transform');
      throw new Error(err?.message || String(err));
    }
  }

  /** Validate a new variable name: a fresh, identifier-like name. */
  #assertNewVarName(name) {
    const n = (name ?? '').trim();
    if (!n) throw new Error('A variable name is required.');
    if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(n)) {
      throw new Error('Name must start with a letter and use only letters, digits, _ or .');
    }
    if (this.#byName.has(n)) throw new Error(`A variable named "${n}" already exists.`);
  }

  /**
   * The **data** transforms (a copy), in order — the metadata/recode/compute/cell
   * ops only, *not* the load/append/join source ops. This is the contract the
   * library version/pull and the syntax exporter rely on (a plugin reads it via
   * `app.data.getTransforms`), so it stays data-only even though the underlying log
   * is now universal. For the full history (loads included) see
   * {@link DataStore#getHistory}.
   * @returns {Array<object>}
   */
  getTransforms() {
    return this.#log.filter((t) => DATA_OPS.has(t.type)).map((t) => structuredClone(t));
  }

  /** @returns {boolean} Whether there is an operation to undo. */
  get canUndo() {
    return this.#log.length > 0;
  }

  /** @returns {boolean} Whether there is an undone operation to redo. */
  get canRedo() {
    return this.#redoStack.length > 0;
  }

  /** Undo the most recent operation (onto the redo stack) and re-derive — now
   * spans loads/appends/joins too. No-op if the log is empty. */
  async undo() {
    if (this.#log.length === 0) return;
    this.#redoStack.push(this.#log.pop());
    await this.rederive('undo');
  }

  /** Re-apply the most recently undone operation and re-derive. No-op if there is
   * nothing to redo. */
  async redo() {
    if (this.#redoStack.length === 0) return;
    this.#log.push(this.#redoStack.pop());
    await this.rederive('redo');
  }

  /**
   * The full **universal-log** timeline for the History/rewind UI: the **applied**
   * operations (chronological) and the undone ones still **ahead** of the current
   * position (`future`, also chronological — the redo stack un-reversed). The
   * current position is `applied.length` steps in. Includes load/append/join, so
   * data loads appear as their own steps. Order is exact and survives save/restore
   * (the `order` hint in {@link DataStore#exportState}).
   *
   * @returns {{applied: object[], future: object[]}}
   */
  getHistory() {
    return {
      applied: this.#log.map((t) => structuredClone(t)),
      future: [...this.#redoStack].reverse().map((t) => structuredClone(t)),
    };
  }

  /**
   * Rewind (or fast-forward) to a point on the timeline: make exactly `n`
   * operations applied, shifting the rest onto the redo stack (or pulling them
   * back off). `n = 0` is the empty start (before any import); `n = applied +
   * future` re-applies everything. One re-derivation regardless of distance. A
   * subsequent fresh operation discards whatever is still ahead (standard linear
   * branch-discard), so the timeline stays linear.
   *
   * @param {number} n - Target number of applied operations.
   * @returns {Promise<void>}
   */
  async rewindTo(n) {
    const total = this.#log.length + this.#redoStack.length;
    const target = Math.max(0, Math.min(Math.floor(n), total));
    if (target === this.#log.length) return;
    while (this.#log.length > target) this.#redoStack.push(this.#log.pop());
    while (this.#log.length < target) this.#log.push(this.#redoStack.pop());
    await this.rederive('rewind');
  }

  /**
   * Reorder the **applied** log: move the op at `from` to index `to`. Because
   * replay is sequential, this changes the result (the point — e.g. move an append
   * above a transform so the transform then covers the appended rows). Guarded:
   * the base `load` is pinned at 0, a dependency check rejects orders where a step
   * would precede something it needs (e.g. editing `foo` before the compute that
   * creates `foo`), and the re-derive is rolled back if the SQL still fails. A
   * structural edit discards the redo branch.
   *
   * @param {number} from @param {number} to
   * @returns {Promise<void>}
   */
  async moveOp(from, to) {
    const n = this.#log.length;
    from = Math.floor(from);
    to = Math.floor(to);
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    if (from === 0 || to === 0) throw new Error('The base import stays first.');
    const next = [...this.#log];
    const [op] = next.splice(from, 1);
    next.splice(to, 0, op);
    await this.#applyReorder(next, op);
  }

  /**
   * Delete the op at `index` from the applied log entirely (its "−" in History).
   * Guarded the same way: can't remove the base import, and can't remove a step a
   * later step depends on. Discards the redo branch.
   *
   * @param {number} index
   * @returns {Promise<void>}
   */
  async removeOp(index) {
    index = Math.floor(index);
    if (index < 0 || index >= this.#log.length) return;
    if (this.#log[index]?.type === 'load') throw new Error('The base import can’t be removed — use File ▸ replace instead.');
    const next = [...this.#log];
    next.splice(index, 1);
    await this.#applyReorder(next);
  }

  /**
   * "Collect imports": stable-partition the log so every data-loading op
   * (load/append/join) moves to the top, ahead of the transforms — the clean
   * "import all the data, then process it" order. No-op if already arranged.
   * Goes through the same guard, so it's rejected (and rolled back) in the rare
   * case a join's key depends on a transform-created column.
   *
   * @returns {Promise<void>}
   */
  async collectImports() {
    const firstTx = this.#log.findIndex((o) => !SOURCE_OPS.has(o.type));
    if (firstTx === -1) return; // no transforms — nothing to pull above
    if (!this.#log.slice(firstTx).some((o) => SOURCE_OPS.has(o.type))) return; // already collected
    const sources = this.#log.filter((o) => SOURCE_OPS.has(o.type));
    const transforms = this.#log.filter((o) => !SOURCE_OPS.has(o.type));
    await this.#applyReorder([...sources, ...transforms], true);
  }

  /** Validate, then swap in a reordered/edited log and re-derive; on any failure
   * (dependency or SQL) restore the previous log and surface the reason. */
  async #applyReorder(next, movedOp) {
    const problem = validateOrder(next);
    if (problem) throw new Error(problem);
    const prev = this.#log;
    this.#log = next;
    this.#redoStack = [];
    try {
      await this.rederive('reorder');
    } catch (err) {
      this.#log = prev;
      await this.rederive('reorder');
      const what = movedOp ? 'move' : 'removal';
      throw new Error(`That ${what} isn’t valid here: ${err?.message || err}`);
    }
  }

  /**
   * Serialise the full reproducible state for the dataset library: every
   * immutable source (metadata + label, and its Parquet bytes unless
   * `includeParquet` is false) plus the transform log. With `includeParquet:false`
   * this is the cheap path for a metadata-only autosave (no source bytes fetched).
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.includeParquet=true]
   * @returns {Promise<import('./dataset-store.js').DatasetState>}
   */
  async exportState({ includeParquet = true } = {}) {
    const sources = [];
    for (const op of this.#sourceOps()) {
      const entry = {
        meta: op.src.meta.map((m) => ({ ...m })),
        label: op.src.label,
        combine: op.type === 'load' ? 'base' : op.type,
      };
      if (op.type === 'join') {
        entry.joinKey = op.joinKey;
        entry.aliases = op.aliases ?? [];
        entry.joinType = op.joinType ?? 'left';
      }
      if (op.src.wide) {
        // Persist the wide source's single Parquet file bytes (read back straight
        // from OPFS — never materialises the wide table); keep the row-id base.
        entry.wide = true;
        entry.rowidBase = op.src.rowidBase;
        if (includeParquet) entry.parquet = await this.#duckdb.readOpfsFile(op.src.file);
      } else if (includeParquet) {
        entry.parquet = await this.#duckdb.queryToParquet(`SELECT * FROM ${quoteIdent(op.src.table)}`);
      }
      sources.push(entry);
    }
    return {
      sources,
      transforms: this.getTransforms(),
      // The exact interleaving of source ops ('s') and data transforms ('t'), so a
      // restore replays the log in true order (sequential rederive is order-
      // sensitive). Omitted-on-old-saves → restore falls back to sources-then-
      // transforms. `sources`/`transforms` each stay in their own relative order,
      // so this single tag stream reconstructs the full log.
      order: this.#log.map((op) => (SOURCE_OPS.has(op.type) ? 's' : 't')),
      rowCount: this.#rowCount,
      varCount: this.#variables.length,
    };
  }

  /**
   * Replace the live dataset with a saved state: recreate each immutable source
   * from its Parquet and rebuild the operation log, then re-derive. The persisted
   * shape stays `{sources, transforms}` (so projects/library are unchanged), plus
   * an `order` tag stream that interleaves them back into the exact log — so a
   * restore reproduces the in-session order (and the same result on another
   * machine). Old saves without `order` fall back to source-ops-then-transforms.
   *
   * @param {import('./dataset-store.js').DatasetState & {order?: string[]}} state
   * @returns {Promise<void>}
   */
  async restoreState({ sources, transforms, order }) {
    await this.#dropAll();
    const srcs = Array.isArray(sources) ? sources : [];
    const txs = Array.isArray(transforms) ? transforms : [];

    // Materialise each source first (a queue), then weave per `order`.
    const srcOps = [];
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      const created = src.wide
        ? await this.#restoreWideSource(src)
        : await this.#createSource({ variables: src.meta, parquet: src.parquet, source: src.label });
      const type = i === 0 ? 'load' : src.combine === 'join' ? 'join' : 'append';
      srcOps.push(type === 'join' ? { type, src: created, joinKey: src.joinKey, aliases: src.aliases ?? [], joinType: src.joinType ?? 'left' } : { type, src: created });
    }

    const log = [];
    if (Array.isArray(order) && order.length === srcs.length + txs.length) {
      let si = 0;
      let ti = 0;
      for (const tag of order) log.push(tag === 's' ? srcOps[si++] : { ...txs[ti++] });
    } else {
      // Backward-compatible fallback: sources first, then transforms.
      for (const op of srcOps) log.push(op);
      for (const t of txs) log.push({ ...t });
    }
    this.#log = log;
    this.#redoStack = [];
    await this.rederive('restore');
  }

  /**
   * Update the user's variable selection. Emits
   * {@link CoreEvents.SELECTION_CHANGED} with the new list of names.
   *
   * @param {string[]} names - Variable names now selected. Unknown names are
   *   dropped silently so callers can pass UI state without pre-filtering.
   */
  setSelectedVariables(names) {
    this.#selected = names.filter((n) => this.#byName.has(n));
    this.#bus.emit(CoreEvents.SELECTION_CHANGED, [...this.#selected]);
  }

  // ---------------------------------------------------------------------------
  // Read accessors (back the public API)
  // ---------------------------------------------------------------------------

  /** @returns {number} Current number of cases (rows). */
  get rowCount() {
    return this.#rowCount;
  }

  /**
   * Build the row-oriented view of the dataset.
   *
   * This allocates `rowCount` objects, so it is O(rows × cols). For large data
   * an analysis should prefer to push computation into R/DuckDB rather than pull
   * a full materialised copy; this method exists for plugin convenience and
   * small-to-medium datasets.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.variables] - Restrict to these columns, in this
   *   order. Defaults to all variables in display order.
   * @returns {Promise<Array<Object<string, number|string|null>>>}
   */
  async getDataFrame({ variables } = {}) {
    const cols = await this.getColumns({ variables });
    const names = (variables ?? this.#variables.map((v) => v.name)).filter((n) => n in cols);
    const rows = new Array(this.#rowCount);
    for (let r = 0; r < this.#rowCount; r++) {
      const row = {};
      for (const n of names) {
        const v = cols[n][r];
        row[n] = typeof v === 'number' && Number.isNaN(v) ? null : v;
      }
      rows[r] = row;
    }
    return rows;
  }

  /**
   * Columnar view of the dataset — the efficient path for code that injects data
   * into R. Numeric columns come back as `Float64Array` (missing → `NaN`); text
   * and factor columns as `Array<string|null>`.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.variables] - Restrict/reorder columns.
   * @returns {Promise<Object<string, Float64Array | Array<string|null>>>}
   */
  async getColumns({ variables } = {}) {
    const plan = this.#columnPlan(variables);
    if (this.#rowCount === 0 || plan.length === 0) return {};

    const table = await this.#duckdb.query(
      `SELECT ${plan.map((p) => p.expr).join(', ')} FROM ${this.#readRelation().from}`,
    );

    const out = {};
    const n = table.numRows;
    for (const p of plan) {
      const col = table.getChild(p.name);
      if (p.numeric) {
        const arr = new Float64Array(n);
        // `.get(i)` (not `.toArray()`) so SQL NULLs are preserved, not dropped;
        // map them to NaN, our numeric "missing" sentinel.
        for (let i = 0; i < n; i++) {
          const v = col.get(i);
          arr[i] = v == null ? NaN : Number(v);
        }
        out[p.name] = arr;
      } else {
        const arr = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = col.get(i);
          arr[i] = v == null ? null : String(v);
        }
        out[p.name] = arr;
      }
    }
    return out;
  }

  /**
   * Per-column SELECT plan from each column's actual SQL type (see `#sqlTypes`).
   * Shared by {@link DataStore#getColumns} and {@link DataStore#getRows}. The
   * casts encode the bridge rules: numeric → DOUBLE (decimals can't come back
   * scaled wrong), 64-bit ints → VARCHAR (no exact int64 in R/JS), temporal → ISO
   * text, boolean → text.
   *
   * @param {string[]} [variables]
   * @returns {Array<{name: string, expr: string, numeric: boolean}>}
   */
  #columnPlan(variables) {
    const names = variables ?? this.#variables.map((v) => v.name);
    return names
      .filter((n) => this.#byName.has(n))
      .map((name) => {
        const kind = classifySqlType(this.#sqlTypes.get(name));
        const q = quoteIdent(name);
        let expr;
        switch (kind) {
          case 'numeric':
            expr = `CAST(${q} AS DOUBLE) AS ${q}`;
            break;
          case 'date':
            expr = `strftime(${q}, '%Y-%m-%d') AS ${q}`;
            break;
          case 'timestamp':
            expr = `strftime(${q}, '%Y-%m-%d %H:%M:%S') AS ${q}`;
            break;
          case 'int64':
          case 'time':
          case 'bool':
            expr = `CAST(${q} AS VARCHAR) AS ${q}`;
            break;
          default: // text
            expr = q;
        }
        return { name, expr, numeric: kind === 'numeric' };
      });
  }

  /**
   * A window of rows as row objects — the backing accessor for the virtualised
   * data grid. Pushes the windowing into DuckDB (`LIMIT/OFFSET`) so only the
   * visible rows are ever fetched, regardless of dataset size.
   *
   * @param {Object} [opts]
   * @param {number} [opts.offset=0]
   * @param {number} [opts.limit=100]
   * @param {string[]} [opts.variables]
   * @param {boolean} [opts.includeRowId=false] - Also return each row's stable id
   *   as `__rid` (a digit string), so the grid can edit a cell by identity.
   * @returns {Promise<Array<Object<string, number|string|null>>>}
   */
  async getRows({ offset = 0, limit = 100, variables, includeRowId = false } = {}) {
    const plan = this.#columnPlan(variables);
    if (this.#rowCount === 0 || plan.length === 0) return [];
    const lim = Math.max(0, Math.floor(limit));
    const off = Math.max(0, Math.floor(offset));
    const rel = this.#readRelation();
    const exprs = plan.map((p) => p.expr);
    if (includeRowId) exprs.push(`CAST(${rel.rid} AS VARCHAR) AS __rid`);
    const table = await this.#duckdb.query(
      `SELECT ${exprs.join(', ')} FROM ${rel.from} LIMIT ${lim} OFFSET ${off}`,
    );
    const rows = [];
    const n = table.numRows;
    for (let i = 0; i < n; i++) {
      const r = table.get(i);
      const row = {};
      for (const p of plan) {
        const v = r[p.name];
        if (v == null) row[p.name] = null;
        else if (p.numeric) {
          const num = Number(v);
          row[p.name] = Number.isNaN(num) ? null : num;
        } else row[p.name] = String(v);
      }
      if (includeRowId) row.__rid = r.__rid == null ? null : String(r.__rid);
      rows.push(row);
    }
    return rows;
  }

  /**
   * Build a Parquet snapshot of the dataset (or a subset) for injection into
   * WebR — the fast lane that preserves column types natively in R. Values are
   * passed through *raw* (no user-missing recode; analyses do that themselves),
   * except 64-bit integers, which are cast to VARCHAR because neither Parquet's
   * R reader nor JS can represent them exactly.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.variables]
   * @returns {Promise<Uint8Array | null>} Parquet bytes, or `null` if empty.
   */
  async getInjectionParquet({ variables } = {}) {
    const names = (variables ?? this.#variables.map((v) => v.name)).filter((n) =>
      this.#byName.has(n),
    );
    if (this.#rowCount === 0 || names.length === 0) return null;

    const selectList = names
      .map((name) => {
        const q = quoteIdent(name);
        // Keep everything native (Parquet carries dates/decimals/bools/text
        // faithfully); only 64-bit ints need the character cast.
        return classifySqlType(this.#sqlTypes.get(name)) === 'int64'
          ? `CAST(${q} AS VARCHAR) AS ${q}`
          : q;
      })
      .join(', ');
    return this.#duckdb.queryToParquet(
      `SELECT ${selectList} FROM ${this.#readRelation().from}`,
    );
  }

  /**
   * Max byte length of each named column's string form — the fixed storage width
   * a .sav/.dta export must declare up front for its string variables. One
   * aggregate query over the working view; bounded memory regardless of size.
   *
   * @param {string[]} names
   * @returns {Promise<Object<string, number>>} name → max octet length (≥0).
   */
  async maxOctetLengths(names) {
    const cols = (names ?? []).filter((n) => this.#byName.has(n));
    if (!cols.length || this.#rowCount === 0) return {};
    const rel = this.#readRelation();
    const sel = cols
      .map((n, i) => `max(octet_length(CAST(${quoteIdent(n)} AS VARCHAR))) AS m${i}`)
      .join(', ');
    const t = await this.#duckdb.query(`SELECT ${sel} FROM ${rel.from}`);
    const r = t.get(0);
    const out = {};
    cols.forEach((n, i) => (out[n] = Number(r?.[`m${i}`] ?? 0) || 0));
    return out;
  }

  /** Refresh the cached SQL column types from the working view. `DESCRIBE` works
   * on views (unlike a table-name lookup in information_schema). */
  async #refreshSqlTypes() {
    this.#sqlTypes = new Map();
    const rows = await this.#duckdb.query(`DESCRIBE ${quoteIdent(this.#view)}`);
    for (let i = 0; i < rows.numRows; i++) {
      const r = rows.get(i);
      this.#sqlTypes.set(String(r.column_name), String(r.column_type));
    }
  }

  /**
   * Variable metadata for every column (or a subset), in display order. Reads
   * from the synchronous cache.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.variables] - Restrict/reorder.
   * @returns {VariableMeta[]} Deep copies; safe for the caller to read.
   */
  getVariableMeta({ variables } = {}) {
    const names = variables ?? this.#variables.map((v) => v.name);
    return names
      .map((n) => this.#byName.get(n))
      .filter(Boolean)
      .map((meta) => structuredClone(meta));
  }

  /** @returns {string[]} Names of currently selected variables. */
  getSelectedVariables() {
    return [...this.#selected];
  }

  // ---------------------------------------------------------------------------
  // Public API surface handed to plugins
  // ---------------------------------------------------------------------------

  /**
   * The frozen, plugin-facing slice of this store. This is what becomes
   * `app.data`. It is deliberately read-only: plugins consume data and react to
   * changes but do not mutate the canonical dataset directly (a future "recode"
   * plugin will go through an explicit transform API, not these methods).
   *
   * `getDataFrame`/`getColumns` are async (they hit DuckDB); the plugin broker
   * awaits every call, so this is transparent to plugin authors.
   *
   * @returns {Readonly<{
   *   getDataFrame: (opts?: {variables?: string[]}) => Promise<Array<Object>>,
   *   getColumns: (opts?: {variables?: string[]}) => Promise<Object>,
   *   getVariableMeta: (opts?: {variables?: string[]}) => VariableMeta[],
   *   getSelectedVariables: () => string[],
   *   getRowCount: () => number,
   *   onDataChanged: (fn: Function) => (() => void),
   *   onSelectionChanged: (fn: Function) => (() => void),
   * }>}
   */
  get api() {
    return Object.freeze({
      getDataFrame: (opts) => this.getDataFrame(opts),
      getColumns: (opts) => this.getColumns(opts),
      getVariableMeta: (opts) => this.getVariableMeta(opts),
      getSelectedVariables: () => this.getSelectedVariables(),
      getRowCount: () => this.rowCount,
      /**
       * Subscribe to dataset replacement/mutation.
       * @param {(summary: object) => void} fn
       * @returns {() => void} unsubscribe
       */
      onDataChanged: (fn) => this.#bus.on(CoreEvents.DATA_CHANGED, fn),
      /**
       * Subscribe to selection changes.
       * @param {(names: string[]) => void} fn
       * @returns {() => void} unsubscribe
       */
      onSelectionChanged: (fn) => this.#bus.on(CoreEvents.SELECTION_CHANGED, fn),
    });
  }

  /**
   * The plugin-facing **write** surface, exposed as `app.transform`. Kept
   * separate from the read-only `app.data` so the distinction stays clear. This
   * is what lets a third-party (e.g. an AI auto-recode) plugin apply metadata
   * transforms programmatically — read with `app.data.getVariableMeta`, decide,
   * then `app.transform.updateVariable`. Phase 2's compute/recode will join here.
   *
   * @returns {Readonly<{ updateVariable: (name: string, patch: object) => Promise<void> }>}
   */
  get transformApi() {
    return Object.freeze({
      updateVariable: (name, patch) => this.updateVariable(name, patch),
    });
  }

  /**
   * Lightweight description of the dataset, emitted with DATA_CHANGED so
   * listeners can update without pulling the whole frame. `reason` lets the
   * library sync distinguish a persistable edit from a replace/restore.
   * @param {string} [reason]
   * @returns {{rowCount: number, variables: string[], reason?: string}}
   */
  #snapshotSummary(reason) {
    return {
      datasetId: this.#id,
      rowCount: this.#rowCount,
      variables: this.#variables.map((v) => v.name),
      reason,
    };
  }

  /** Drop this dataset's DuckDB tables/view (called when it's removed from the
   * workspace). After this the instance must not be used. */
  async dispose() {
    await this.#dropAll();
  }
}

/**
 * Coerce a raw value array into the storage representation for a variable's
 * type. Numeric columns become `Float64Array` with empty/`null` cells as `NaN`;
 * other columns become `Array<string|null>` with `null` for empties. These are
 * exactly the shapes {@link DuckDBManager#replaceTable} turns into Arrow
 * Float64 / Utf8 columns.
 *
 * @param {VariableMeta} meta
 * @param {Array} raw
 * @returns {Float64Array | Array<string|null>}
 */
/**
 * Render a JS string as a single-quoted SQL string literal (internal quotes
 * doubled). Used for the provenance tag injected into the append query.
 *
 * @param {string} s
 * @returns {string}
 */
function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * SQL literal for a cell-override value, typed to the column. Blank/null → `NULL`;
 * a numeric column parses the value (junk → `NULL`); other columns quote it.
 *
 * @param {string|number|null} val
 * @param {boolean} isNumeric
 * @returns {string}
 */
function cellLiteral(val, isNumeric) {
  if (val === null || val === undefined || val === '') return 'NULL';
  if (isNumeric) {
    const n = Number(val);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  return sqlString(val);
}

/** Clamp a variable type to a known value (defaults to numeric). */
function normType(t) {
  return t === 'string' || t === 'factor' ? t : 'numeric';
}

/**
 * Check a proposed operation order for dependency violations — the guard for
 * History reorder/delete. Walks the log tracking which columns are *available* at
 * each point (sources add their columns; compute/recode add their new variable)
 * and rejects when a step would run before something it needs: editing/recoding/
 * cell-editing a column that doesn't exist yet, a join whose key isn't present, or
 * a non-load op landing before the base import. Returns an error message, or null
 * if the order is sound. (Compute *expression* reads aren't statically known —
 * those are caught by the re-derive itself; this catches the silent ones.)
 *
 * @param {Array<object>} log
 * @returns {string|null}
 */
function validateOrder(log) {
  const available = new Set();
  let haveBase = false;
  for (const op of log) {
    if (op.type === 'load') {
      available.clear();
      for (const m of op.src.meta) available.add(m.name);
      haveBase = true;
      continue;
    }
    if (!haveBase) return 'Steps must come after the base import.';
    if (op.type === 'append') {
      for (const m of op.src.meta) available.add(m.name);
    } else if (op.type === 'join') {
      if (op.joinKey?.left && !available.has(op.joinKey.left)) {
        return `This join needs the key “${op.joinKey.left}”, which isn’t available at that point.`;
      }
      for (const m of op.src.meta) if (m.name !== op.joinKey?.right) available.add(m.name);
    } else if (op.type === 'setVariable') {
      if (!available.has(op.name)) return `“${op.name}” must be created before it’s edited.`;
    } else if (op.type === 'recodeVar') {
      if (!available.has(op.source)) return `“${op.source}” must exist before it’s recoded into “${op.name}”.`;
      available.add(op.name);
    } else if (op.type === 'computeVar') {
      available.add(op.name); // expression reads are validated by the re-derive
    } else if (op.type === 'setCell') {
      if (!available.has(op.column)) return `“${op.column}” must exist before a cell of it is edited.`;
    }
  }
  return null;
}

/**
 * Build the `CASE … END` SQL for a recode transform. Exact-value rules compare on
 * text (so factor codes match); range rules compare numerically; `missing` checks
 * NULL. `to`/`elseRule` map to a typed literal, the source value (`copy`), or NULL
 * (`sysmis`). Unmatched falls to `elseRule` (default: copy).
 *
 * @param {{source:string, rules:Array, elseRule:object, varType:string}} t
 * @returns {string}
 */
function recodeCaseSql(t) {
  const src = quoteIdent(t.source);
  const isNum = normType(t.varType) === 'numeric';
  const whens = (t.rules ?? [])
    .map((r) => {
      let cond;
      if (r.from === 'range') {
        const lo = Number(r.lo);
        const hi = Number(r.hi);
        cond =
          Number.isFinite(lo) && Number.isFinite(hi)
            ? `TRY_CAST(${src} AS DOUBLE) BETWEEN ${lo} AND ${hi}`
            : '1 = 0';
      } else if (r.from === 'missing') {
        cond = `${src} IS NULL`;
      } else {
        cond = `CAST(${src} AS VARCHAR) = ${sqlString(String(r.value ?? ''))}`;
      }
      return `WHEN ${cond} THEN ${recodeTo(r.to, isNum, src)}`;
    })
    .join(' ');
  const elseSql = recodeTo(t.elseRule ?? { kind: 'copy' }, isNum, src);
  return `CASE ${whens} ELSE ${elseSql} END`;
}

/** SQL for a recode target: a typed literal, the source value (copy), or NULL. */
function recodeTo(to, isNum, srcQ) {
  if (!to || to.kind === 'sysmis') return 'NULL';
  if (to.kind === 'copy') return `CAST(${srcQ} AS ${isNum ? 'DOUBLE' : 'VARCHAR'})`;
  return cellLiteral(to.value, isNum);
}

/**
 * Ensure `base` is unique against a Map/Set of taken names, appending ` 2`, ` 3`…
 * Used when a joined source's column name collides with an existing column.
 *
 * @param {string} base
 * @param {{has: (k: string) => boolean}} taken
 * @returns {string}
 */
function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/**
 * Build the ON condition for a LEFT JOIN of a join source. Both keys are
 * normalised (cast to text, lower-cased, trimmed) so case/whitespace differences
 * don't block a match; manual `aliases` remap specific incoming key values to the
 * base value *before* normalisation (the user's review-step pairings).
 *
 * @param {string} left - The stacked-rows alias (e.g. `R`).
 * @param {string} right - The join-source alias (e.g. `J1`).
 * @param {{joinKey: {left: string, right: string}, aliases?: Array<{base: string, incoming: string}>}} s
 * @returns {string}
 */
function joinConditionSql(left, right, s) {
  const leftRaw = `CAST(${left}.${quoteIdent(s.joinKey.left)} AS VARCHAR)`;
  const rightRaw = `CAST(${right}.${quoteIdent(s.joinKey.right)} AS VARCHAR)`;
  let rightExpr = rightRaw;
  const aliases = s.aliases ?? [];
  if (aliases.length) {
    const whens = aliases
      .map((a) => `WHEN ${sqlString(String(a.incoming))} THEN ${sqlString(String(a.base))}`)
      .join(' ');
    rightExpr = `CASE ${rightRaw} ${whens} ELSE ${rightRaw} END`;
  }
  const norm = (e) => `lower(trim(${e}))`;
  return `${norm(leftRaw)} = ${norm(rightExpr)}`;
}

/**
 * Apply a `setVariable` patch to a variable's metadata in place (used when
 * replaying the transform log). Empty values clear the field. No-op if the named
 * variable isn't present (e.g. an edit to a variable a later replace removed).
 *
 * @param {VariableMeta|undefined} meta
 * @param {object} patch
 */
function applyPatch(meta, patch) {
  if (!meta || !patch) return;
  for (const key of ['label', 'type', 'measurementLevel', 'valueLabels', 'missingValues']) {
    if (!(key in patch)) continue;
    const v = patch[key];
    const empty =
      v == null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (key === 'valueLabels' && typeof v === 'object' && Object.keys(v).length === 0);
    if (empty) delete meta[key];
    else meta[key] = v;
  }
}

function coerceColumn(meta, raw) {
  if (meta.type === 'numeric') {
    const out = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      out[i] = v === null || v === undefined || v === '' ? NaN : Number(v);
    }
    return out;
  }
  return raw.map((v) => (v === null || v === undefined ? null : String(v)));
}

/**
 * Map a DuckDB SQL type string to the bridge category that decides how a column
 * is cast and represented. Order matters: 64-bit ints are matched before the
 * general numeric family so they take the character path (R/JS have no exact
 * int64). See `spike/datatypes-spike.html`.
 *
 * @param {string} [sqlType] - e.g. `DOUBLE`, `BIGINT`, `DATE`, `DECIMAL(9,2)`.
 * @returns {'numeric'|'int64'|'date'|'timestamp'|'time'|'bool'|'text'}
 */
function classifySqlType(sqlType) {
  const t = String(sqlType ?? '').toUpperCase();
  if (/^(BIGINT|HUGEINT|UBIGINT|UHUGEINT)\b/.test(t)) return 'int64';
  if (t.startsWith('DATE')) return 'date';
  if (t.startsWith('TIMESTAMP')) return 'timestamp';
  if (t.startsWith('TIME')) return 'time';
  if (t === 'BOOLEAN' || t === 'BOOL') return 'bool';
  if (/^(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|TINYINT|SMALLINT|INTEGER|INT|UINTEGER|USMALLINT|UTINYINT)\b/.test(t)) {
    return 'numeric';
  }
  return 'text';
}
