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
 * The asset URLs (DuckDB-WASM, Apache Arrow, hyparquet-writer) and the DuckDB
 * bundle live in {@link ./assets.js} — which serves them from a CDN by default or
 * from same-origin `./vendor/` in the air-gapped, self-hosted mode.
 */

import { getAssets } from './assets.js';

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

  /** Lazily-imported JS Parquet writer module (loaded on first wide import). */
  #parquetWriter = null;

  /** Whether this browser can hand an OPFS `FileSystemFileHandle` to the DuckDB
   * worker via postMessage. Chrome: yes. WebKit/iOS Safari: NO — it throws
   * `DataCloneError` (handles aren't structured-cloneable to a worker there), which
   * breaks the out-of-core (OPFS parts) streaming ingest. Probed once, then the
   * ingest falls back to an in-memory path on Safari. @type {boolean|null} */
  #opfsHandleOk = null;

  /** Monotonic counter for unique scratch filenames. A FIXED scratch name
   * ('ct_export.parquet'/'ct_import.parquet') corrupts data when two Parquet
   * export/restore ops interleave (e.g. an autosave during a multi-file import):
   * they clobber each other's scratch file, and a truncated/garbled Parquet gets
   * written to disk. Unique names per op make concurrent ops independent. */
  #scratchSeq = 0;

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
   * @param {string} [opts.rowidCol] - If set, a BIGINT row-id column with this name
   *   is baked into each part (so the final read needs no whole-table window).
   * @param {number} [opts.rowidBase=0] - Row-id namespace offset.
   * @param {number} [opts.targetCells=4000000] - Approx cells per part (~32 MB).
   *   Kept small for two reasons: the temp table is built via INSERTs (which can't
   *   page to disk, so must stay well under `memory_limit`), and large parts of a
   *   *wide* table flush truncated to OPFS under concurrent load — small parts
   *   avoid both.
   * @returns {Promise<{addBatch: (columns: Object) => Promise<void>, finish: () => Promise<void>}>}
   */
  async beginStreamIngest(table, types, { rowidCol = null, rowidBase = 0, targetCells = 4_000_000 } = {}) {
    const { conn } = await this.#ensureReady();
    // Out-of-core ingest spills to OPFS Parquet parts, which means handing OPFS file
    // handles to the worker — impossible on WebKit/iOS Safari (DataCloneError). There,
    // fall back to an in-memory ingest (the path the demo uses, which works on Safari).
    if (!(await this.#canUseOpfsHandles())) {
      return this.#beginMemoryIngest(table, types, { rowidCol, rowidBase });
    }
    const ncols = Math.max(1, Object.keys(types).length);
    const rowsPerPart = Math.max(1000, Math.floor(targetCells / ncols));
    const tmp = `${table}__ingest_tmp`;
    const parts = [];
    let tmpRows = 0;
    let tmpCreated = false;
    let seq = 0;
    let rowsSoFar = 0; // rows flushed before the current part (for the baked row id)

    const root = await navigator.storage.getDirectory();
    const PROT = this.#duckdb.DuckDBDataProtocol.BROWSER_FSACCESS;
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
      const partRows = tmpRows;
      // Bake a unique row id per part (small per-part window) so the final read is a
      // plain streaming SELECT * — a whole-table window over wide data would OOM.
      const src = rowidCol
        ? `(SELECT *, CAST(${rowidBase + rowsSoFar} AS BIGINT) + CAST(row_number() OVER () AS BIGINT) AS ${quoteIdent(rowidCol)} FROM ${quoteIdent(tmp)})`
        : quoteIdent(tmp);
      // Write, then verify it reads back before dropping the temp (an OPFS part can
      // occasionally flush truncated under load — retry while we still have the data).
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const handle = await root.getFileHandle(name, { create: true });
        await this.#db.registerFileHandle(name, handle, PROT, true);
        await conn.query(`COPY ${src} TO '${name}' (FORMAT parquet)`);
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
      rowsSoFar += partRows;
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

    const finish = async () => {
      // Ensure at least one part exists (even empty) so the CTAS has a schema.
      if (tmpRows > 0) {
        await flushPart();
      } else if (parts.length === 0) {
        const empty = {};
        for (const c of Object.keys(types)) empty[c] = types[c] === 'numeric' ? new Float64Array(0) : [];
        await this.appendColumns(tmp, empty, types, { create: true });
        tmpCreated = true;
        await flushPart();
      }

      for (const p of parts) await reReg(p);
      await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      // Read the parts sequentially (threads=1): with many wide parts, parallel
      // parquet readers blow the memory_limit. The row id is already a column, so
      // this is a plain streaming projection straight to the (OPFS) table.
      let prevThreads = null;
      try {
        try { prevThreads = String((await conn.query(`SELECT current_setting('threads') AS t`)).get(0).t); } catch { /* ignore */ }
        await conn.query('SET threads=1');
        await conn.query(`CREATE TABLE ${quoteIdent(table)} AS SELECT * FROM read_parquet([${sqlList(parts)}])`);
      } finally {
        if (prevThreads) { try { await conn.query(`SET threads=${prevThreads}`); } catch { /* ignore */ } }
        for (const p of parts) await removePart(p);
        try { await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`); } catch { /* best-effort */ }
      }
    };

    return { addBatch, finish };
  }

  /** Probe once whether this browser can hand an OPFS `FileSystemFileHandle` to the
   * DuckDB worker (see {@link DuckDBManager##opfsHandleOk}). WebKit/iOS Safari can't,
   * so the out-of-core streaming ingest must fall back to an in-memory path there. */
  async #canUseOpfsHandles() {
    if (this.#opfsHandleOk != null) return this.#opfsHandleOk;
    const name = '__ct_fsaccess_probe';
    try {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(name, { create: true });
      await this.#db.registerFileHandle(name, h, this.#duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      this.#opfsHandleOk = true;
    } catch {
      this.#opfsHandleOk = false; // Safari/WebKit: handles aren't postable to a worker
    }
    try { await this.#db.dropFile(name); } catch { /* best-effort */ }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name);
    } catch { /* best-effort */ }
    return this.#opfsHandleOk;
  }

  /**
   * In-memory streaming ingest for browsers without OPFS-handle→worker support
   * (Safari). Appends each batch straight into the target table via Arrow IPC — the
   * same path the demo/`replaceTable` uses, which works on WebKit — then bakes the
   * row id with one SQL pass. Memory-bounded by the dataset size: fine for a device
   * that can't do out-of-core anyway; a multi-GB file would exceed memory here, an
   * accepted iOS limitation. Same `{addBatch, finish}` contract as the OPFS path.
   */
  async #beginMemoryIngest(table, types, { rowidCol = null, rowidBase = 0 } = {}) {
    const { conn } = await this.#ensureReady();
    const tmp = `${table}__mem_tmp`;
    let created = false;
    const addBatch = async (columns) => {
      await this.appendColumns(tmp, columns, types, { create: !created });
      created = true;
    };
    const finish = async () => {
      if (!created) {
        // No rows arrived — still create an empty temp with the right schema.
        const empty = {};
        for (const c of Object.keys(types)) empty[c] = types[c] === 'numeric' ? new Float64Array(0) : [];
        await this.appendColumns(tmp, empty, types, { create: true });
      }
      // Build the final table from the accumulator (not self-referencing), baking the
      // stable row id in one pass — small in-memory data, so no OOM risk.
      const sel = rowidCol
        ? `SELECT *, CAST(${rowidBase} AS BIGINT) + CAST(row_number() OVER () AS BIGINT) AS ${quoteIdent(rowidCol)} FROM ${quoteIdent(tmp)}`
        : `SELECT * FROM ${quoteIdent(tmp)}`;
      try {
        await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
        await conn.query(`CREATE TABLE ${quoteIdent(table)} AS ${sel}`);
      } finally {
        try { await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`); } catch { /* best-effort */ }
      }
    };
    return { addBatch, finish };
  }

  /**
   * Stage Parquet bytes to an OPFS file and register it with DuckDB so queries can
   * `read_parquet('<name>')` it **without ever loading it into a table**. This is
   * the foundation of the wide-dataset path: a very wide file is stored as one OPFS
   * Parquet file (written by a JS encoder), and the dataset reads it with
   * `read_parquet` — DuckDB's read path is genuinely out-of-core, so it never hits
   * the buffer-pool/checkpoint OOM that ingesting into a table does.
   *
   * @param {string} name - File name to register (also the OPFS file name).
   * @param {Uint8Array} bytes - Parquet file bytes.
   * @returns {Promise<void>}
   */
  async registerParquetFile(name, bytes) {
    await this.#ensureReady();
    const PROT = this.#duckdb.DuckDBDataProtocol.BROWSER_FSACCESS;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    await this.#db.registerFileHandle(name, handle, PROT, true);
  }

  /**
   * Open an **incremental** JS Parquet writer for a wide dataset: the caller feeds
   * row groups one at a time (bounded memory — the uncompressed data never fully
   * materialises), then finalises to a registered OPFS file. Encoding happens
   * entirely outside DuckDB, so arbitrarily wide data (the full GSS, ~6,942 cols)
   * never enters DuckDB's buffer pool; DuckDB only `read_parquet`s the result.
   *
   * @param {Array<{name: string, type: 'numeric'|'string'}>} columns - Column schema
   *   (numeric → DOUBLE, string → UTF8 BYTE_ARRAY), in order.
   * @returns {Promise<{writeRowGroup: (columnData: Array<{name: string, data: ArrayLike<*>}>) => void, finalize: (name: string) => Promise<number>}>}
   */
  async openParquetWriter(columns) {
    if (!this.#parquetWriter) this.#parquetWriter = await import(/* @vite-ignore */ getAssets().hyparquetWriterUrl);
    const W = this.#parquetWriter;
    const schema = [{ name: 'root', num_children: columns.length }];
    for (const c of columns) {
      schema.push(
        c.type === 'string'
          ? { name: c.name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' }
          : { name: c.name, type: 'DOUBLE', repetition_type: 'OPTIONAL' },
      );
    }
    const bw = new W.ByteWriter();
    const pw = new W.ParquetWriter({ writer: bw, schema, statistics: false });
    return {
      // One write() call == one row group (rowGroupSize huge so it isn't re-split).
      writeRowGroup: (columnData) => pw.write({ columnData, rowGroupSize: 1_000_000_000 }),
      finalize: async (name) => {
        pw.finish();
        const bytes = new Uint8Array(bw.getBuffer());
        await this.registerParquetFile(name, bytes);
        return bytes.byteLength;
      },
    };
  }

  /** Drop a file registered via {@link registerParquetFile}; optionally delete the
   * backing OPFS file too (otherwise it persists for a later session to re-register). */
  async dropRegisteredFile(name, { removeFromOpfs = false } = {}) {
    try { await this.#db.dropFile(name); } catch { /* best-effort */ }
    if (removeFromOpfs) {
      try { const root = await navigator.storage.getDirectory(); await root.removeEntry(name); } catch { /* best-effort */ }
    }
  }

  /** Read Parquet bytes back from an OPFS file registered earlier (for persistence
   * export). @param {string} name @returns {Promise<Uint8Array>} */
  async readOpfsFile(name) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
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
    const name = `ct_export_${this.#scratchSeq++}.parquet`;
    await conn.query(`COPY (${sql}) TO '${name}' (FORMAT parquet)`);
    try {
      const buf = await this.#db.copyFileToBuffer(name);
      // Defence in depth (#105): never hand back — and so never persist — bytes
      // that aren't a valid Parquet file. Better to fail the save loudly than
      // write a project that won't reload. (Valid files, incl. empty results,
      // carry the 'PAR1' magic at both ends.)
      if (!isValidParquet(buf)) {
        throw new Error('Parquet export produced invalid bytes; aborting to avoid writing a corrupt project.');
      }
      return buf;
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
    const file = `ct_import_${this.#scratchSeq++}.parquet`;
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
    // Don't cache a *failed* init: a transient first-attempt failure (e.g. a runtime
    // fetch that lost a race with service-worker control on a cold offline boot)
    // must not poison DuckDB for the whole session — a later call can retry (#120).
    if (!this.#initPromise) {
      this.#initPromise = this.#init().catch((err) => {
        this.#initPromise = null;
        throw err;
      });
    }
    return this.#initPromise;
  }

  /** One-time runtime construction. */
  async #init() {
    // Dynamic import so the WASM payload is only fetched when first needed. URLs
    // come from the asset registry (CDN by default, ./vendor/ when self-hosted).
    const assets = getAssets();
    const [duckdb, arrow] = await Promise.all([
      import(/* @vite-ignore */ assets.duckdbUrl),
      import(/* @vite-ignore */ assets.arrowUrl),
    ]);
    this.#duckdb = duckdb;
    this.#arrow = arrow;

    // In self-hosted mode use our vendored bundle (same-origin worker + wasm);
    // otherwise the jsDelivr URLs. selectBundle picks mvp/eh per browser features.
    const bundles = assets.duckdbBundles ? assets.duckdbBundles() : duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);

    // The bundle's worker lives on the CDN (cross-origin). Under COEP we can't
    // construct a Worker directly from a cross-origin URL. We fetch its source on
    // the MAIN thread and inline it into a same-origin blob worker — two reasons:
    // (1) a main-thread fetch flows through the service worker, so the worker script
    // is cached for offline use; an in-worker `importScripts(crossOriginUrl)` would
    // bypass the SW and never cache, breaking DuckDB with no network (#92); (2) it
    // satisfies COEP without a cross-origin Worker URL. Falls back to the
    // importScripts wrapper if the source can't be fetched as text.
    let workerUrl;
    try {
      const src = await (await fetch(bundle.mainWorker)).text();
      workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch {
      workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
      );
    }
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

/** True if `bytes` look like a real Parquet file: the 'PAR1' magic appears at both
 * the start and the end (the footer). Catches truncated/garbled exports before
 * they're persisted. Empty result sets still produce a valid (PAR1-bracketed)
 * file, so this doesn't reject legitimately-empty data. */
export function isValidParquet(bytes) {
  if (!bytes || bytes.length < 8) return false;
  const MAGIC = [0x50, 0x41, 0x52, 0x31]; // 'PAR1'
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
    if (bytes[bytes.length - 4 + i] !== MAGIC[i]) return false;
  }
  return true;
}
