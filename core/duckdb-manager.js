/**
 * @file duckdb-manager.js
 * Owns the DuckDB-WASM runtime: loading it, holding the connection, and moving
 * data in and out. This is the storage engine behind {@link DataStore}.
 *
 * Why DuckDB-WASM is the data layer (and not plain JS arrays): social-science
 * datasets get large (hundreds of variables × hundreds of thousands of cases),
 * and DuckDB gives us typed columnar storage plus vectorised filtering/
 * aggregation that R never has to see. The engine was proven end-to-end before
 * this was written — see `spike/RESULTS.md` for the scale, messy-data and
 * type-fidelity evidence and the rules that shaped this code.
 *
 * Apache Arrow is the interchange format in *both* directions:
 *  - **in:** {@link DuckDBManager#replaceTable} builds an Arrow table from
 *    columnar JS arrays, serialises it to an IPC stream, and inserts it. IPC
 *    (a stable wire format) is used instead of `insertArrowTable` so we are not
 *    hostage to an `instanceof` match between our Arrow build and the one DuckDB
 *    bundles.
 *  - **out:** {@link DuckDBManager#query} returns the Arrow table DuckDB
 *    produces; callers read columns with `.getChild(name).get(i)`.
 *
 * Like {@link WebRManager}, the runtime is lazy: the (tens of MB) WASM payload is
 * only fetched on first use, so opening the app stays cheap.
 *
 * TODO(hardening): pin + vendor the DuckDB-WASM and Arrow assets (currently CDN,
 * mirroring the WebR `latest` convenience) for reproducibility + offline PWA use.
 */

/**
 * DuckDB-WASM ES-module entry, from jsDelivr. Pinned for reproducibility; vendor
 * for release (see TODO.md).
 *
 * NOTE: two different version numbers. This is the **npm package** version of the
 * JS bindings; the **DuckDB engine** it bundles is separate (check `PRAGMA
 * version`). `@1.29.0` shipped engine 1.1.1; this build (`1.33.1-dev*`) ships
 * engine ~1.5.x — wanted for its more mature OPFS support. duckdb-wasm publishes
 * its releases under `-dev` tags, so a `-dev` pin is the normal current build.
 * @type {string}
 */
const DUCKDB_URL = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev45.0/+esm';

/**
 * Apache Arrow ES-module entry. Used only to *build* tables for ingest; query
 * results come back as Arrow objects from DuckDB itself.
 * @type {string}
 */
const ARROW_URL = 'https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm';

/**
 * Manages the lifecycle of, and access to, the single DuckDB-WASM runtime.
 */
export class DuckDBManager {
  /** Loaded DuckDB module namespace. @type {any} */
  #duckdb = null;

  /** Loaded Apache Arrow module namespace. @type {any} */
  #arrow = null;

  /** The AsyncDuckDB instance. @type {any} */
  #db = null;

  /** The dedicated worker backing the runtime. @type {Worker|null} */
  #worker = null;

  /** The live connection. @type {any} */
  #conn = null;

  /** In-flight init promise, so concurrent first-callers share one init. */
  #initPromise = null;

  /** @returns {boolean} True once the runtime is initialised and ready. */
  get isReady() {
    return this.#conn !== null;
  }

  /** Begin loading DuckDB now rather than on first use. Safe to call repeatedly. */
  async preload() {
    await this.#ensureReady();
  }

  /**
   * Run a SQL statement and return the Arrow result table. Read columns with
   * `result.getChild(name).get(i)` (which yields `null` for SQL NULL).
   *
   * @param {string} sql
   * @returns {Promise<any>} an `apache-arrow` Table
   */
  async query(sql) {
    const { conn } = await this.#ensureReady();
    return conn.query(sql);
  }

  /**
   * Replace a table wholesale from columnar JS arrays. This is the ingest path
   * an importer (or the demo seed) uses. Numeric columns should arrive as
   * `Float64Array` (→ Arrow Float64), text/factor columns as `Array<string|null>`
   * (→ Arrow Utf8); `null` marks missing.
   *
   * @param {string} name - Table name (caller-controlled, not user input).
   * @param {Object<string, Float64Array | Array<string|null>>} columns
   * @returns {Promise<void>}
   */
  async replaceTable(name, columns) {
    const { conn, arrow } = await this.#ensureReady();
    await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);

    const colNames = Object.keys(columns);
    // An empty dataset still has a valid (table-less) state; getColumns guards on
    // the row count, so we simply leave no table behind.
    if (colNames.length === 0 || columns[colNames[0]].length === 0) return;

    const table = arrow.tableFromArrays(columns);
    const ipc = arrow.tableToIPC(table, 'stream');
    await conn.insertArrowFromIPCStream(ipc, { name, create: true });
  }

  /**
   * Append one batch of rows to a table, creating it on the first batch. This is
   * the **streaming ingest** path: an importer that can't materialise a whole
   * dataset in memory (a multi-GB .sav/.dta read by ReadStat) calls this once per
   * chunk of rows, so the table is built incrementally and the full data never
   * sits in the wasm heap (it pages to OPFS).
   *
   * The Arrow schema is built **explicitly** from `types` — not inferred from the
   * JS arrays — so every batch has an identical schema and the append never fails
   * on a column that happened to be all-null (→ Arrow Null) in one batch. Numeric
   * columns must arrive as `Float64Array` (→ Float64), text/factor as
   * `Array<string|null>` (→ Utf8); `null`/`NaN` mark missing.
   *
   * @param {string} name - Table name (caller-controlled, not user input).
   * @param {Object<string, Float64Array|Array<string|null>>} columns
   * @param {Object<string, import('./data-store.js').VariableType>} types - name → type.
   * @param {Object} [opts]
   * @param {boolean} [opts.create=false] - True for the first batch (creates the table).
   * @returns {Promise<void>}
   */
  async appendColumns(name, columns, types, { create = false } = {}) {
    const { conn, arrow } = await this.#ensureReady();
    const names = Object.keys(columns);
    if (names.length === 0) return;
    const vectors = {};
    for (const col of names) {
      const t = types[col] === 'numeric' ? new arrow.Float64() : new arrow.Utf8();
      vectors[col] = arrow.vectorFromArray(columns[col], t);
    }
    const table = new arrow.Table(vectors);
    const ipc = arrow.tableToIPC(table, 'stream');
    await conn.insertArrowFromIPCStream(ipc, { name, create });
  }

  /**
   * Run a query and return its result as Parquet bytes. This is the fast lane
   * into WebR: DuckDB writes Parquet, the bytes cross into WebR's virtual FS, and
   * R reads them with `nanoparquet` — preserving column types (dates, decimals,
   * …) natively, with no per-cell JS boxing. (Bridge B in `spike/RESULTS.md`.)
   *
   * @param {string} sql - A complete SELECT.
   * @returns {Promise<Uint8Array>} Parquet file bytes.
   */
  async queryToParquet(sql) {
    const { conn } = await this.#ensureReady();
    const name = 'ct_export.parquet';
    await conn.query(`COPY (${sql}) TO '${name}' (FORMAT parquet)`);
    try {
      return await this.#db.copyFileToBuffer(name);
    } finally {
      try {
        await this.#db.dropFile(name);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  /**
   * Replace a table from Parquet bytes (e.g. produced by an importer plugin that
   * parsed a file in R/`haven` and wrote Parquet). DuckDB reads Parquet natively,
   * so this is the efficient ingest path for the dual importer contract.
   *
   * @param {string} name - Table name.
   * @param {Uint8Array} bytes - Parquet file bytes.
   * @returns {Promise<void>}
   */
  async replaceTableFromParquet(name, bytes) {
    const { conn } = await this.#ensureReady();
    const file = 'ct_import.parquet';
    await this.#db.registerFileBuffer(file, bytes);
    try {
      await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
      await conn.query(
        `CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM read_parquet('${file}')`,
      );
    } finally {
      try {
        await this.#db.dropFile(file);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  /** Shut the runtime down and reset. The next call cold-starts a new runtime. */
  async close() {
    const conn = this.#conn;
    const db = this.#db;
    const worker = this.#worker;
    this.#conn = null;
    this.#db = null;
    this.#worker = null;
    this.#initPromise = null;
    try {
      await conn?.close?.();
      await db?.terminate?.();
      worker?.terminate?.();
    } catch {
      /* best-effort teardown */
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Lazily load + init DuckDB, sharing one init across concurrent callers. */
  async #ensureReady() {
    if (this.#conn) return { conn: this.#conn, arrow: this.#arrow };
    if (!this.#initPromise) this.#initPromise = this.#init();
    return this.#initPromise;
  }

  /** One-time runtime construction. */
  async #init() {
    // Dynamic import so the WASM payload is only fetched when first needed.
    const [duckdb, arrow] = await Promise.all([
      import(/* @vite-ignore */ DUCKDB_URL),
      import(/* @vite-ignore */ ARROW_URL),
    ]);
    this.#duckdb = duckdb;
    this.#arrow = arrow;

    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

    // The bundle's worker lives on the CDN (cross-origin). Under COEP we can't
    // construct a Worker directly from a cross-origin URL, so wrap it in a
    // same-origin blob that `importScripts` it. (Proven in the spikes.)
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    // Open the database on OPFS so storage is disk-backed: DuckDB then pages to
    // disk and can hold datasets far larger than the wasm ~4 GB heap (verified
    // out-of-core — a 1.2 GB table queried under a 488 MB cap). Start each session
    // from a clean DB: dataset *persistence* is owned by the project/parquet store,
    // so a carried-over DuckDB file would only orphan tables and grow unbounded.
    // (`ATTACH 'opfs://…'` does NOT page — it must be the opened database.)
    try {
      const OPFS_DB = 'crosstab-duckdb.db';
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(OPFS_DB).catch(() => {});
        await root.removeEntry(`${OPFS_DB}.wal`).catch(() => {});
      } catch {
        /* OPFS unavailable — db.open below will fall back or throw, handled next */
      }
      await db.open({ path: `opfs://${OPFS_DB}`, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    } catch (err) {
      // OPFS unavailable (private mode, quota, older browser): stay in-memory.
      console.warn('[duckdb] OPFS open failed; using in-memory storage (datasets capped by the wasm heap)', err);
    }

    this.#worker = worker;
    this.#db = db;
    this.#conn = await db.connect();
    return { conn: this.#conn, arrow };
  }
}

/**
 * Quote a SQL identifier (double-quote, with internal quotes doubled). Table and
 * column names flow from variable metadata, so quote them defensively even
 * though they are not raw user input.
 *
 * @param {string} name
 * @returns {string}
 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
