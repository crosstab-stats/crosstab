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
 *  - **The transform log** (`#transforms`) is an ordered list of edits the user
 *    has made (e.g. recode/retype a variable). It is data, not mutation —
 *    inspectable, undoable, and (later) exportable as a do-file.
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

/** Name of the working **view** the rest of the app reads. It is derived (never
 * written directly) from the immutable source tables + the transform log. */
const MAIN_TABLE = 'dataset';

/** Prefix for the immutable per-file source tables (`ct_source_1`, …). */
const SOURCE_TABLE_PREFIX = 'ct_source_';

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
   * The immutable source tables, in load order. One per imported/appended file.
   * @type {Array<{table: string, meta: VariableMeta[], label: string|null}>}
   */
  #sources = [];

  /**
   * The transform log: ordered, replayable edits applied over the sources to
   * derive the working view + metadata. v1 entry type is `setVariable`
   * (`{type:'setVariable', name, patch}`). Inspectable via {@link DataStore#getTransforms},
   * reversible via {@link DataStore#undo} — the reproducibility record.
   * @type {Array<{type: string, name?: string, patch?: object}>}
   */
  #transforms = [];

  /**
   * Undone transforms, most-recently-undone last — the redo stack. Cleared by any
   * new transform (the standard undo/redo branch-discard) and by a load.
   * @type {Array<{type: string, name?: string, patch?: object}>}
   */
  #redoStack = [];

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
  async loadDataset({ variables, columns, parquet, mode = 'replace', source, joinKey, aliases }) {
    const canCombine = this.#sources.length > 0;
    const combine = canCombine && (mode === 'append' || mode === 'join') ? mode : 'replace';
    if (combine === 'replace') {
      await this.#dropAll();
      const s = await this.#createSource(1, { variables, columns, parquet, source });
      s.combine = 'base';
      this.#sources = [s];
      this.#transforms = [];
    } else {
      const idx = this.#sources.length + 1;
      const s = await this.#createSource(idx, { variables, columns, parquet, source });
      s.combine = combine;
      if (combine === 'join') {
        s.joinKey = joinKey;
        s.aliases = aliases ?? [];
      }
      this.#sources.push(s);
    }
    // A load is a structural change; the transform redo branch no longer applies.
    this.#redoStack = [];
    await this.rederive(combine === 'replace' ? 'replace' : combine);
  }

  /**
   * Materialise one immutable source table (`ct_source_<index>`) from a loaded
   * file and return its descriptor. Does not touch the working view.
   *
   * @returns {Promise<{table: string, meta: VariableMeta[], label: string|null}>}
   */
  async #createSource(index, { variables, columns, parquet, source }) {
    const table = `${SOURCE_TABLE_PREFIX}${index}`;
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
    return { table, meta: variables.map((m) => ({ ...m })), label: source ?? null };
  }

  /** Drop the working view and every source table; clear the source list. */
  async #dropAll() {
    await this.#duckdb.query(`DROP VIEW IF EXISTS ${quoteIdent(MAIN_TABLE)}`);
    for (const s of this.#sources) {
      await this.#duckdb.query(`DROP TABLE IF EXISTS ${quoteIdent(s.table)}`);
    }
    this.#sources = [];
  }

  /**
   * Recompute everything derived from `#sources` + `#transforms`: the variable
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
    // Sources combine two ways: `append` sources stack rows onto the base (UNION),
    // `join` sources add columns by matching a key (LEFT JOIN). Split them so the
    // view composes as: stacked rows first, then joined columns hung off them.
    const stacked = this.#sources.filter((s, i) => i === 0 || s.combine !== 'join');
    const joins = this.#sources.filter((s) => s.combine === 'join');
    const multiStacked = stacked.length > 1;

    // 1) Metadata: union the stacked sources (first wins on shared names), add
    //    source_file for a pooled dataset, add each join source's columns (minus
    //    its key, which dups the base key) renaming on collision, then replay the
    //    transform log.
    const byName = new Map();
    for (const s of stacked) {
      for (const m of s.meta) if (!byName.has(m.name)) byName.set(m.name, { ...m });
    }
    if (multiStacked && !byName.has(SOURCE_COL)) {
      byName.set(SOURCE_COL, {
        name: SOURCE_COL,
        label: 'Source file',
        type: 'factor',
        measurementLevel: 'nominal',
      });
    }
    const joinPlans = joins.map((s) => {
      const cols = [];
      for (const m of s.meta) {
        if (m.name === s.joinKey?.right) continue; // drop the redundant right key
        let out = m.name;
        if (byName.has(out)) out = uniqueName(`${m.name}${s.label ? ` (${s.label})` : ' (joined)'}`, byName);
        byName.set(out, { ...m, name: out });
        cols.push({ orig: m.name, out });
      }
      return { source: s, cols };
    });
    for (const t of this.#transforms) {
      if (t.type === 'setVariable') applyPatch(byName.get(t.name), t.patch);
    }
    this.#variables = [...byName.values()];
    this.#byName = byName;

    // 2) Working view: numeric-typed columns are CAST to DOUBLE here (the only
    //    "data" effect of a transform); a pooled dataset gets source_file +
    //    UNION ALL BY NAME; join sources are LEFT JOINed onto the stacked rows.
    if (this.#sources.length === 0) {
      await this.#duckdb.query(`DROP VIEW IF EXISTS ${quoteIdent(MAIN_TABLE)}`);
      this.#sqlTypes = new Map();
      this.#rowCount = 0;
    } else {
      const numeric = new Set(this.#variables.filter((m) => m.type === 'numeric').map((m) => m.name));
      const stackedSql = stacked
        .map((s, i) => {
          const colExprs = s.meta.map((col) => {
            const q = quoteIdent(col.name);
            return numeric.has(col.name) ? `TRY_CAST(${q} AS DOUBLE) AS ${q}` : q;
          });
          const prov = multiStacked
            ? `, ${sqlString(s.label ?? `dataset ${i + 1}`)} AS ${quoteIdent(SOURCE_COL)}`
            : '';
          return `SELECT ${colExprs.join(', ')}${prov} FROM ${quoteIdent(s.table)}`;
        })
        .join(' UNION ALL BY NAME ');

      let sql = stackedSql;
      if (joins.length > 0) {
        let from = `(${stackedSql}) AS R`;
        const selectCols = ['R.*'];
        joins.forEach((s, ji) => {
          const alias = `J${ji + 1}`;
          from += ` LEFT JOIN ${quoteIdent(s.table)} AS ${alias} ON ${joinConditionSql('R', alias, s)}`;
          for (const c of joinPlans[ji].cols) {
            const ref = `${alias}.${quoteIdent(c.orig)}`;
            const expr = numeric.has(c.out) ? `TRY_CAST(${ref} AS DOUBLE)` : ref;
            selectCols.push(`${expr} AS ${quoteIdent(c.out)}`);
          }
        });
        sql = `SELECT ${selectCols.join(', ')} FROM ${from}`;
      }
      await this.#duckdb.query(`CREATE OR REPLACE VIEW ${quoteIdent(MAIN_TABLE)} AS ${sql}`);
      await this.#refreshSqlTypes();
      const c = await this.#duckdb.query(`SELECT count(*) AS n FROM ${quoteIdent(MAIN_TABLE)}`);
      this.#rowCount = Number(c.get(0).n);
    }

    this.#selected = this.#selected.filter((n) => this.#byName.has(n));
    this.#bus.emit(CoreEvents.DATA_CHANGED, this.#snapshotSummary(reason));
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
    this.#transforms.push({ type: 'setVariable', name, patch });
    this.#redoStack = [];
    await this.rederive('transform');
  }

  /**
   * The transform log (a copy) — the ordered edits applied over the immutable
   * sources. The basis for an undo/history UI and a future do-file export.
   * @returns {Array<object>}
   */
  getTransforms() {
    return this.#transforms.map((t) => structuredClone(t));
  }

  /** @returns {boolean} Whether there is a transform to undo. */
  get canUndo() {
    return this.#transforms.length > 0;
  }

  /** @returns {boolean} Whether there is an undone transform to redo. */
  get canRedo() {
    return this.#redoStack.length > 0;
  }

  /** Undo the most recent transform (onto the redo stack) and re-derive. No-op if
   * the log is empty. */
  async undo() {
    if (this.#transforms.length === 0) return;
    this.#redoStack.push(this.#transforms.pop());
    await this.rederive('undo');
  }

  /** Re-apply the most recently undone transform and re-derive. No-op if there is
   * nothing to redo. */
  async redo() {
    if (this.#redoStack.length === 0) return;
    this.#transforms.push(this.#redoStack.pop());
    await this.rederive('redo');
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
    for (const s of this.#sources) {
      const entry = {
        meta: s.meta.map((m) => ({ ...m })),
        label: s.label,
        combine: s.combine ?? 'base',
      };
      if (s.combine === 'join') {
        entry.joinKey = s.joinKey;
        entry.aliases = s.aliases ?? [];
      }
      if (includeParquet) {
        entry.parquet = await this.#duckdb.queryToParquet(`SELECT * FROM ${quoteIdent(s.table)}`);
      }
      sources.push(entry);
    }
    return {
      sources,
      transforms: this.getTransforms(),
      rowCount: this.#rowCount,
      varCount: this.#variables.length,
    };
  }

  /**
   * Replace the live dataset with a saved state from the library: recreate each
   * immutable source from its Parquet, restore the transform log, and re-derive.
   *
   * @param {import('./dataset-store.js').DatasetState} state
   * @returns {Promise<void>}
   */
  async restoreState({ sources, transforms }) {
    await this.#dropAll();
    this.#sources = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const s = await this.#createSource(i + 1, {
        variables: src.meta,
        parquet: src.parquet,
        source: src.label,
      });
      s.combine = src.combine ?? (i === 0 ? 'base' : 'append');
      if (s.combine === 'join') {
        s.joinKey = src.joinKey;
        s.aliases = src.aliases ?? [];
      }
      this.#sources.push(s);
    }
    this.#transforms = Array.isArray(transforms) ? transforms.map((t) => ({ ...t })) : [];
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
   * @returns {Promise<Array<Object<string, number|string|null>>>}
   */
  async getRows({ offset = 0, limit = 100, variables } = {}) {
    const plan = this.#columnPlan(variables);
    if (this.#rowCount === 0 || plan.length === 0) return [];
    const lim = Math.max(0, Math.floor(limit));
    const off = Math.max(0, Math.floor(offset));
    const table = await this.#duckdb.query(
      `SELECT ${plan.map((p) => p.expr).join(', ')} FROM ${quoteIdent(MAIN_TABLE)} ` +
        `LIMIT ${lim} OFFSET ${off}`,
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
      `SELECT ${selectList} FROM ${quoteIdent(MAIN_TABLE)}`,
    );
  }

  /** Refresh the cached SQL column types from the working view. `DESCRIBE` works
   * on views (unlike a table-name lookup in information_schema). */
  async #refreshSqlTypes() {
    this.#sqlTypes = new Map();
    const rows = await this.#duckdb.query(`DESCRIBE ${quoteIdent(MAIN_TABLE)}`);
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
    return { rowCount: this.#rowCount, variables: this.#variables.map((v) => v.name), reason };
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
