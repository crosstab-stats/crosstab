/**
 * @file data-store.js
 * The canonical dataset and its published API surface.
 *
 * Internally the store keeps each variable as a columnar array (and, for
 * numeric variables, a typed `Float64Array`) because that is far more memory
 * efficient than an array of row objects — a dataset with 200 variables and
 * 100k cases is 100k tiny objects in row form, but 200 flat arrays in columnar
 * form. Columnar storage is also what R, DuckDB, and Arrow all want.
 *
 * The *public* API, however, hands plugins row-oriented objects
 * (`[{col: val}, ...]`), because that is the shape plugin authors expect and
 * the shape that maps cleanly onto an R `data.frame` when injected into WebR.
 * The conversion happens here, once, behind a stable contract.
 *
 * Variable metadata follows a structure inspired by Haven / SPSS so that a
 * `.sav` round-trip can preserve labels, value labels, missing codes and
 * measurement level. See {@link VariableMeta}.
 */

import { CoreEvents } from './event-bus.js';

/**
 * @typedef {'numeric' | 'string' | 'factor'} VariableType
 * Storage/semantics of a variable. `numeric` is stored as Float64Array,
 * `string` and `factor` as plain arrays. A `factor` additionally expects
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
 * A single variable's storage plus metadata.
 *
 * @typedef {Object} Column
 * @property {VariableMeta} meta
 * @property {Float64Array | Array<string|null>} values - Length === row count.
 */

/**
 * The canonical dataset for the session. There is exactly one live instance,
 * created by the app bootstrap and exposed to plugins (read-mostly) through the
 * {@link DataStore#api} surface.
 */
export class DataStore {
  /** @type {import('./event-bus.js').EventBus} */
  #bus;

  /**
   * Insertion-ordered map of variable name → column. Order is the display order
   * of variables (left-to-right in the data editor, order in `getDataFrame`).
   * @type {Map<string, Column>}
   */
  #columns = new Map();

  /** Number of cases (rows). Kept explicit so an empty dataset can have schema. */
  #rowCount = 0;

  /**
   * Names of variables the user has highlighted in the UI. This is *selection
   * state*, not data, but it lives here because it is dataset-scoped and every
   * analysis dialog needs it.
   * @type {string[]}
   */
  #selected = [];

  /**
   * @param {import('./event-bus.js').EventBus} bus - App event bus, used to
   *   broadcast {@link CoreEvents.DATA_CHANGED} and
   *   {@link CoreEvents.SELECTION_CHANGED}.
   */
  constructor(bus) {
    this.#bus = bus;
  }

  // ---------------------------------------------------------------------------
  // Mutation (engine-side; not part of the plugin API yet)
  // ---------------------------------------------------------------------------

  /**
   * Replace the entire dataset. This is how an importer (CSV, .sav, …) loads
   * data, and how tests seed a dataset. Emits {@link CoreEvents.DATA_CHANGED}.
   *
   * @param {Object} dataset
   * @param {VariableMeta[]} dataset.variables - Column metadata, in display order.
   * @param {Object<string, Array>} dataset.columns - name → raw value array.
   *   Each array must have the same length, which becomes the row count.
   */
  setDataset({ variables, columns }) {
    const names = variables.map((v) => v.name);
    const lengths = names.map((n) => (columns[n] ?? []).length);
    const rowCount = lengths.length ? lengths[0] : 0;
    if (lengths.some((len) => len !== rowCount)) {
      throw new Error('DataStore.setDataset: all columns must have equal length');
    }

    const next = new Map();
    for (const meta of variables) {
      const raw = columns[meta.name] ?? [];
      next.set(meta.name, { meta, values: coerceColumn(meta, raw) });
    }

    this.#columns = next;
    this.#rowCount = rowCount;
    // Drop any selection referring to variables that no longer exist.
    this.#selected = this.#selected.filter((n) => next.has(n));
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
    this.#selected = names.filter((n) => this.#columns.has(n));
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
   * @returns {Array<Object<string, number|string|null>>}
   */
  getDataFrame({ variables } = {}) {
    const names = variables ?? [...this.#columns.keys()];
    const cols = names.map((n) => this.#columns.get(n)).filter(Boolean);
    const rows = new Array(this.#rowCount);
    for (let r = 0; r < this.#rowCount; r++) {
      const row = {};
      for (const col of cols) {
        const v = col.values[r];
        row[col.meta.name] = Number.isNaN(v) ? null : v;
      }
      rows[r] = row;
    }
    return rows;
  }

  /**
   * Columnar view of the dataset — the efficient path for code that injects
   * data into R or DuckDB. Returns references to the live arrays for numeric
   * columns (do not mutate); string columns are copied defensively.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.variables] - Restrict/reorder columns.
   * @returns {Object<string, Float64Array | Array<string|null>>}
   */
  getColumns({ variables } = {}) {
    const names = variables ?? [...this.#columns.keys()];
    const out = {};
    for (const n of names) {
      const col = this.#columns.get(n);
      if (!col) continue;
      out[n] = col.meta.type === 'numeric' ? col.values : [...col.values];
    }
    return out;
  }

  /**
   * Variable metadata for every column (or a subset), in display order.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.variables] - Restrict/reorder.
   * @returns {VariableMeta[]} Deep-ish copies; safe for the caller to read.
   */
  getVariableMeta({ variables } = {}) {
    const names = variables ?? [...this.#columns.keys()];
    return names
      .map((n) => this.#columns.get(n))
      .filter(Boolean)
      .map((col) => structuredClone(col.meta));
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
   * @returns {Readonly<{
   *   getDataFrame: (opts?: {variables?: string[]}) => Array<Object>,
   *   getColumns: (opts?: {variables?: string[]}) => Object,
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
    return { rowCount: this.#rowCount, variables: [...this.#columns.keys()] };
  }
}

/**
 * Coerce a raw value array into the storage representation for a variable's
 * type. Numeric columns become `Float64Array` with empty/`null` cells as `NaN`;
 * other columns keep `null` for empties.
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
