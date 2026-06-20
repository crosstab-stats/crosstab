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
   * @internal Begin an **out-of-core streaming ingest** into `table`. Returns an
   * ingester with `addBatch(columns)` and `finish()`.
   *
   * Why not just `INSERT` every batch into the target: in DuckDB-WASM, many
   * appends to one OPFS table pile uncommitted/cached pages into the buffer pool,
   * which grows until it hits `memory_limit` and fails (and manual `CHECKPOINT`
   * can OOM). So instead we accumulate batches in a *small* temp table, spill it
   * to an OPFS **Parquet part** once it crosses a size threshold (then DROP it,
   * freeing memory), and finally build `table` with a single `CREATE TABLE AS
   * SELECT … FROM read_parquet([parts])` — the CTAS path that DuckDB streams to
   * disk out-of-core (verified: a 1.2 GB table under a 488 MB cap). Memory stays
   * bounded by the part threshold regardless of total dataset size.
   *
   * @param {string} table - Target table name.
   * @param {Object<string, import('./data-store.js').VariableType>} types - name → type.
   * @param {Object} [opts]
   * @param {string} [opts.rowidExpr] - Extra SELECT expression appended in the
   *   final CTAS (e.g. a baked-in row id), so no separate full-table rewrite.
   * @param {number} [opts.targetCells=16000000] - Approx cells per part (~128 MB).
   *   Kept small because the temp table is built via INSERTs, which can't page to
   *   disk and must stay well under `memory_limit`. Many small parts are then
   *   hierarchically merged (bounded fan-in) so the final read only opens a few.
   * @returns {Promise<{addBatch: (columns: Object) => Promise<void>, finish: () => Promise<void>}>}
   */
  async beginStreamIngest(table, types, { rowidExpr, targetCells = 16_000_000 } = {}) {
    const { conn } = await this.#ensureReady();
    const ncols = Math.max(1, Object.keys(types).length);
    const rowsPerPart = Math.max(1000, Math.floor(targetCells / ncols));
    const tmp = `${table}__ingest_tmp`;
    const parts = [];
    let tmpRows = 0;
    let tmpCreated = false;
    let seq = 0;

    const root = await navigator.storage.getDirectory();
    const PROT = this.#duckdb.DuckDBDataProtocol.BROWSER_FSACCESS;

    // Reading many OPFS parquet files at once is flaky/memory-heavy, so the final
    // read (and every merge step) opens at most this many parts.
    const MERGE_FANIN = 12;
    const sqlList = (names) => names.map((p) => `'${p}'`).join(', ');
    const reReg = async (name) => {
      const h = await root.getFileHandle(name);
      await this.#db.registerFileHandle(name, h, PROT, true);
    };
    const removePart = async (name) => {
      try { await this.#db.dropFile(name); } catch { /* best-effort */ }
      try { await root.removeEntry(name); } catch { /* best-effort */ }
    };

    const flushPart = async () => {
      const name = `${table}__part${seq++}.parquet`;
      // Write the part, then verify it reads back before dropping the temp — under
      // concurrent worker load an OPFS part can occasionally flush truncated, so we
      // confirm (and retry) while we still have the temp data to re-COPY.
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const handle = await root.getFileHandle(name, { create: true });
        await this.#db.registerFileHandle(name, handle, PROT, true);
        await conn.query(`COPY ${quoteIdent(tmp)} TO '${name}' (FORMAT parquet)`);
        await this.#db.dropFile(name); // release write handle → flush to OPFS
        try {
          await reReg(name);
          await conn.query(`SELECT 1 FROM read_parquet('${name}') LIMIT 1`);
          await this.#db.dropFile(name);
          ok = true;
        } catch {
          try { await this.#db.dropFile(name); } catch { /* best-effort */ }
          await removePart(name);
        }
      }
      if (!ok) throw new Error(`streaming ingest: part "${name}" failed to write to OPFS`);
      parts.push(name);
      await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`);
      tmpCreated = false;
      tmpRows = 0;
    };

    const addBatch = async (columns) => {
      await this.appendColumns(tmp, columns, types, { create: !tmpCreated });
      tmpCreated = true;
      const first = Object.keys(columns)[0];
      tmpRows += first ? columns[first].length : 0;
      if (tmpRows >= rowsPerPart) await flushPart();
    };

    /** Combine a group of parquet parts into one new part (read few, write one). */
    const mergeGroup = async (group, outName) => {
      for (const p of group) await reReg(p);
      const oh = await root.getFileHandle(outName, { create: true });
      await this.#db.registerFileHandle(outName, oh, PROT, true);
      await conn.query(`COPY (SELECT * FROM read_parquet([${sqlList(group)}])) TO '${outName}' (FORMAT parquet)`);
      await this.#db.dropFile(outName);
      for (const p of group) await removePart(p);
    };

    const finish = async () => {
      // Ensure at least one part exists (even an empty one) so the CTAS has a
      // schema to build from for a zero-row file.
      if (tmpRows > 0) {
        await flushPart();
      } else if (parts.length === 0) {
        const empty = {};
        for (const c of Object.keys(types)) empty[c] = types[c] === 'numeric' ? new Float64Array(0) : [];
        await this.appendColumns(tmp, empty, types, { create: true });
        tmpCreated = true;
        await flushPart();
      }

      // Hierarchically merge down to <= MERGE_FANIN parts so the final read opens
      // only a few files at once.
      let level = parts.slice();
      let mergeSeq = 0;
      while (level.length > MERGE_FANIN) {
        const next = [];
        for (let i = 0; i < level.length; i += MERGE_FANIN) {
          const group = level.slice(i, i + MERGE_FANIN);
          const out = `${table}__merge${mergeSeq++}.parquet`;
          await mergeGroup(group, out);
          next.push(out);
        }
        level = next;
      }

      for (const p of level) await reReg(p);
      const sel = rowidExpr ? `*, ${rowidExpr}` : '*';
      await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      try {
        await conn.query(`CREATE TABLE ${quoteIdent(table)} AS SELECT ${sel} FROM read_parquet([${sqlList(level)}])`);
      } finally {
        for (const p of level) await removePart(p);
        try { await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`); } catch { /* best-effort */ }
      }
    };

    return { addBatch, finish };
  }

  /** Best-effort removal of any leftover streaming-ingest part files for a table
   * (OPFS parquet parts named `<table>__part*`/`__merge*`), e.g. after a failed
   * import, so they don't accumulate. */
  async cleanupStreamIngest(table) {
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [n] of root.entries()) {
        if (n.startsWith(`${table}__`)) {
          try { await this.#db?.dropFile(n); } catch { /* best-effort */ }
          try { await root.removeEntry(n); } catch { /* best-effort */ }
        }
      }
    } catch { /* OPFS unavailable */ }
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
