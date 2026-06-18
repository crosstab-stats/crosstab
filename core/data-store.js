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

/** Column auto-added when stacking files, tagging each row with its origin so a
 * pooled multi-file/multi-year dataset stays distinguishable (group/filter by
 * it). Chosen to be unlikely to collide with real variable names. */
const SOURCE_COL = 'source_file';

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

  /**
   * name → DuckDB SQL type string (e.g. `DOUBLE`, `BIGINT`, `DATE`,
   * `DECIMAL(9,2)`). Cached on each `setDataset` so reads don't re-query the
   * schema. Drives the type-aware casting in {@link DataStore#getColumns} and
   * {@link DataStore#getInjectionParquet} — independent of `VariableMeta.type`,
   * so it stays correct for types the metadata model doesn't yet name (the
   * dates/int64 a `.sav`/`.dta` import will bring in).
   * @type {Map<string, string>}
   */
  #sqlTypes = new Map();

  /**
   * Source label of the currently-loaded data, remembered so that the first
   * *append* to a single-file dataset can tag the pre-existing rows correctly
   * (they have no `source_file` column yet). Null for the demo seed / unknown.
   * @type {string|null}
   */
  #lastSource = null;

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
    await this.#replaceDataset({ variables, columns });
  }

  /**
   * Load a dataset delivered by an importer plugin. Accepts either shape of the
   * importer contract — `{ variables, columns }` (JS-parsed, e.g. CSV) or
   * `{ variables, parquet }` (R/`haven`-parsed) — and either **replaces** the
   * current dataset or **appends** (stacks rows) onto it.
   *
   * Append reconciles columns by name (`UNION ALL BY NAME`, NULL-filling vars a
   * file lacks) and tags each file's rows with a `source_file` column so a pooled
   * multi-year dataset stays distinguishable. The engine — never a plugin — calls
   * this, only in response to a user import action.
   *
   * @param {Object} dataset
   * @param {VariableMeta[]} dataset.variables
   * @param {Object<string, Array>} [dataset.columns]
   * @param {Uint8Array} [dataset.parquet]
   * @param {'replace'|'append'} [dataset.mode='replace']
   * @param {string} [dataset.source] - Provenance label for this file's rows.
   * @returns {Promise<void>}
   */
  async loadDataset({ variables, columns, parquet, mode = 'replace', source }) {
    // Appending to an empty store is just a load.
    if (mode === 'append' && this.#rowCount > 0) {
      await this.#appendDataset({ variables, columns, parquet, source });
    } else {
      await this.#replaceDataset({ variables, columns, parquet, source });
    }
  }

  /** Replace the whole dataset (parquet or columnar). */
  async #replaceDataset({ variables, columns, parquet, source }) {
    if (parquet) {
      await this.#duckdb.replaceTableFromParquet(MAIN_TABLE, parquet);
    } else {
      const cols = columns ?? {};
      const lengths = variables.map((v) => (cols[v.name] ?? []).length);
      const rowCount = lengths.length ? lengths[0] : 0;
      if (lengths.some((len) => len !== rowCount)) {
        throw new Error('DataStore: all columns must have equal length');
      }
      const coerced = {};
      for (const meta of variables) coerced[meta.name] = coerceColumn(meta, cols[meta.name] ?? []);
      await this.#duckdb.replaceTable(MAIN_TABLE, coerced);
    }
    this.#variables = variables.map((m) => ({ ...m }));
    this.#byName = new Map(this.#variables.map((m) => [m.name, m]));
    this.#lastSource = source ?? null;
    await this.#postLoad();
  }

  /**
   * Stack a new file's rows onto the current dataset, reconciling columns by
   * name and tagging provenance. The incoming data is materialised into a temp
   * table, then `UNION ALL BY NAME`-d with the main table.
   */
  async #appendDataset({ variables, columns, parquet, source }) {
    const TEMP = 'dataset_incoming';
    if (parquet) {
      await this.#duckdb.replaceTableFromParquet(TEMP, parquet);
    } else {
      const cols = columns ?? {};
      const coerced = {};
      for (const meta of variables) coerced[meta.name] = coerceColumn(meta, cols[meta.name] ?? []);
      await this.#duckdb.replaceTable(TEMP, coerced);
    }

    const q = quoteIdent;
    const src = q(SOURCE_COL);
    const incLit = sqlString(source ?? 'import');
    // Existing rows: if they already carry source_file (a prior append) keep it;
    // otherwise tag them with the dataset's remembered origin.
    const mainSelect = this.#sqlTypes.has(SOURCE_COL)
      ? `SELECT * FROM ${q(MAIN_TABLE)}`
      : `SELECT *, ${sqlString(this.#lastSource ?? 'dataset 1')} AS ${src} FROM ${q(MAIN_TABLE)}`;
    const incSelect = `SELECT *, ${incLit} AS ${src} FROM ${q(TEMP)}`;

    await this.#duckdb.query(
      `CREATE TABLE dataset_new AS ${mainSelect} UNION ALL BY NAME ${incSelect}`,
    );
    await this.#duckdb.query(`DROP TABLE ${q(MAIN_TABLE)}`);
    await this.#duckdb.query(`ALTER TABLE dataset_new RENAME TO ${q(MAIN_TABLE)}`);
    await this.#duckdb.query(`DROP TABLE ${q(TEMP)}`);

    this.#mergeVariables(variables);
    await this.#postLoad();
  }

  /** Merge an appended file's variable metadata into the cache (union by name;
   * existing meta wins on shared names) and ensure the `source_file` entry. */
  #mergeVariables(incoming) {
    const byName = new Map(this.#variables.map((m) => [m.name, m]));
    for (const m of incoming) if (!byName.has(m.name)) byName.set(m.name, { ...m });
    if (!byName.has(SOURCE_COL)) {
      byName.set(SOURCE_COL, {
        name: SOURCE_COL,
        label: 'Source file',
        type: 'factor',
        measurementLevel: 'nominal',
      });
    }
    this.#variables = [...byName.values()];
    this.#byName = byName;
  }

  /** Refresh row count, SQL types and selection after a load/append; emit. */
  async #postLoad() {
    const countTable = await this.#duckdb.query(
      `SELECT count(*) AS n FROM ${quoteIdent(MAIN_TABLE)}`,
    );
    this.#rowCount = Number(countTable.get(0).n);
    this.#selected = this.#selected.filter((n) => this.#byName.has(n));
    await this.#refreshSqlTypes();
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
    const present = names.filter((n) => this.#byName.has(n));
    if (this.#rowCount === 0 || present.length === 0) return {};

    // Build a per-column SELECT expression + JS representation from the column's
    // actual SQL type (see #sqlTypes). The casts encode the bridge rules proven
    // in the spikes: numeric → DOUBLE (decimals can't come back scaled wrong),
    // 64-bit ints → VARCHAR (R/JS have no exact int64; carry as character),
    // temporal → ISO text (callers reconstruct Date/POSIXct), boolean → text.
    const plan = present.map((name) => {
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

    const table = await this.#duckdb.query(
      `SELECT ${plan.map((p) => p.expr).join(', ')} FROM ${quoteIdent(MAIN_TABLE)}`,
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
      `SELECT ${selectList} FROM ${quoteIdent(MAIN_TABLE)}`,
    );
  }

  /** Refresh the cached SQL column types from DuckDB's schema. */
  async #refreshSqlTypes() {
    this.#sqlTypes = new Map();
    if (this.#variables.length === 0 || this.#rowCount === 0) return;
    const rows = await this.#duckdb.query(
      `SELECT column_name, data_type FROM information_schema.columns ` +
        `WHERE table_name = '${MAIN_TABLE}'`,
    );
    for (let i = 0; i < rows.numRows; i++) {
      const r = rows.get(i);
      this.#sqlTypes.set(String(r.column_name), String(r.data_type));
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
