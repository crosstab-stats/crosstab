/**
 * @file data-store.js
 * The canonical dataset and its published API surface.
 *
 * ## Storage: DuckDB-WASM, fronted by a thin synchronous metadata cache
 *
 * The dataset's *values* live in a DuckDB-WASM table (see
 * {@link DuckDBManager}); this class is a facade over that connection. The
 * decision to use DuckDB — rather than in-memory JS arrays — was proven out
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

/** Name of the single DuckDB table that holds the active dataset. */
const MAIN_TABLE = 'dataset';

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

  /**
   * Variable metadata in display order — the synchronous cache. The values these
   * describe live in DuckDB; this is everything the UI needs without awaiting.
   * @type {VariableMeta[]}
   */
  #variables = [];

  /** name → meta, for O(1) lookup. @type {Map<string, VariableMeta>} */
  #byName = new Map();

  /** Number of cases (rows). Kept explicit so an empty dataset can have schema. */
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
   */
  constructor(bus, duckdb) {
    this.#bus = bus;
    this.#duckdb = duckdb;
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
    const names = variables.map((v) => v.name);
    const lengths = names.map((n) => (columns[n] ?? []).length);
    const rowCount = lengths.length ? lengths[0] : 0;
    if (lengths.some((len) => len !== rowCount)) {
      throw new Error('DataStore.setDataset: all columns must have equal length');
    }

    // Coerce to the storage representation (Float64Array / string[]) then hand
    // the whole table to DuckDB in one Arrow ingest.
    const coerced = {};
    for (const meta of variables) {
      coerced[meta.name] = coerceColumn(meta, columns[meta.name] ?? []);
    }
    await this.#duckdb.replaceTable(MAIN_TABLE, coerced);

    this.#variables = variables.map((m) => ({ ...m }));
    this.#byName = new Map(this.#variables.map((m) => [m.name, m]));
    this.#rowCount = rowCount;
    // Drop any selection referring to variables that no longer exist.
    this.#selected = this.#selected.filter((n) => this.#byName.has(n));
    this.#bus.emit(CoreEvents.DATA_CHANGED, this.#snapshotSummary());
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
    const names = variables ?? this.#variables.map((v) => v.name);
    const metas = names.map((n) => this.#byName.get(n)).filter(Boolean);
    if (this.#rowCount === 0 || metas.length === 0) return {};

    // CAST numeric columns to DOUBLE so a DECIMAL storage type can't come back
    // scaled wrong through Arrow-JS (see file header / spike RESULTS.md).
    const selectList = metas
      .map((m) =>
        m.type === 'numeric'
          ? `CAST(${quoteIdent(m.name)} AS DOUBLE) AS ${quoteIdent(m.name)}`
          : quoteIdent(m.name),
      )
      .join(', ');
    const table = await this.#duckdb.query(
      `SELECT ${selectList} FROM ${quoteIdent(MAIN_TABLE)}`,
    );

    const out = {};
    const n = table.numRows;
    for (const m of metas) {
      const col = table.getChild(m.name);
      if (m.type === 'numeric') {
        const arr = new Float64Array(n);
        // `.get(i)` (not `.toArray()`) so SQL NULLs are preserved, not dropped;
        // map them to NaN, our numeric "missing" sentinel.
        for (let i = 0; i < n; i++) {
          const v = col.get(i);
          arr[i] = v == null ? NaN : Number(v);
        }
        out[m.name] = arr;
      } else {
        const arr = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = col.get(i);
          arr[i] = v == null ? null : String(v);
        }
        out[m.name] = arr;
      }
    }
    return out;
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
   * Lightweight description of the dataset, emitted with DATA_CHANGED so
   * listeners can update without pulling the whole frame.
   * @returns {{rowCount: number, variables: string[]}}
   */
  #snapshotSummary() {
    return { rowCount: this.#rowCount, variables: this.#variables.map((v) => v.name) };
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
