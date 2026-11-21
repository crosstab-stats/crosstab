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
import { debug, isDebug } from './debug.js';

/**
 * Manages the lifecycle of, and access to, the single DuckDB-WASM runtime.
 */
/** Statements that change something. Logged always; everything else only when slow. */
const MUTATING_SQL = /^\s*(CREATE|DROP|INSERT|UPDATE|DELETE|ALTER|COPY|ATTACH|DETACH|CHECKPOINT|PRAGMA|SET|USE|BEGIN|COMMIT|ROLLBACK)\b/i;

/** A read slower than this is a finding rather than noise. */
const SLOW_QUERY_MS = 250;

/**
 * A statement's SHAPE, for the log — never its values.
 *
 * The debug log is exported and attached to bug reports, so it must not carry the user's
 * data, and a `WHERE` clause or an `INSERT` can. This keeps the keywords and identifiers
 * that make a statement recognisable, collapses whitespace and truncates; quoted string
 * literals are replaced wholesale.
 *
 * @param {string} sql
 * @returns {string}
 */
function sqlShape(sql) {
  return String(sql)
    .replace(/'(?:[^']|'')*'/g, "'?'") // string literals out, including '' escapes
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

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

  /** Whether the opened database actually landed on OPFS. `false` on every browser
   * today (see `#instantiate`); kept as a field rather than inferred so that the day
   * upstream fixes the path lookup, there is one place that notices. `null` = not
   * determined. @type {boolean|null} */
  #diskBacked = null;

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

  /** table name → estimated bytes it holds. Keyed on THIS instance because the
   * checkpoint ceiling is the instance's, and every dataset shares one. @type {Map<string, number>} */
  #tableBytes = new Map();

  /** Record (or update) what a source table is estimated to cost. */
  noteTableBytes(table, bytes) {
    this.#tableBytes.set(String(table), Math.max(0, Number(bytes) || 0));
  }

  /** Forget a table that has been dropped; the budget is about what is resident NOW. */
  forgetTable(table) {
    this.#tableBytes.delete(String(table));
  }

  /** Estimated bytes the source TABLES in this database are holding. Wide sources are
   * absent by construction: they are OPFS Parquet files DuckDB only reads, so they never
   * enter the buffer pool or the checkpoint this budget exists for. */
  get loadedTableBytes() {
    let total = 0;
    for (const bytes of this.#tableBytes.values()) total += bytes;
    return total;
  }

  /**
   * Would ingesting a table of this shape push the database past
   * {@link TABLE_BYTE_BUDGET}? If so the caller should route it out-of-core.
   *
   * @param {Array<{type?: string}>} variables
   * @param {number} rowCount
   * @returns {boolean}
   */
  async wouldExceedTableBudget(variables, rowCount) {
    // AWAITS readiness, which is the whole point. The capability is probed during init,
    // and the first import decides its route BEFORE anything has touched DuckDB — so the
    // first version read `#opfsHandleOk` while it was still null, `null !== false` was
    // true, the desktop budget applied, and an iPhone built the table that killed it.
    // The decision cannot be synchronous, because the fact it depends on is not.
    try { await this.#ensureReady(); } catch { /* fall through: unknown is handled below */ }
    // `=== true`, not `!== false`: unknown counts as cannot-stream. A device we failed to
    // probe is not a device we may assume the best of, and the cost of being wrong that
    // way is a slower import rather than a dead tab.
    return exceedsTableBudget(this.loadedTableBytes, variables, rowCount, this.#opfsHandleOk === true);
  }

  /**
   * The whole ingest route decision: table, or out-of-core?
   *
   * ## Why it lives here and not in the caller
   *
   * It used to be two halves in two layers. A codec decided `wide` from the FILE and
   * `import-service` decided `overBudget` from what was already resident, and the import
   * took `head.wide || overBudget` — while the four other ways into the engine consulted
   * neither half. Width is a property of the data; residency and the stream capability
   * are properties of THIS instance. Two of the three facts are here, so the decision is.
   *
   * ## Why it is async, which is not incidental
   *
   * The capability is probed during init, and the FIRST import routes before anything has
   * touched DuckDB. An earlier version read `#opfsHandleOk` while it was still `null`,
   * `null !== false` was true, the desktop budget applied, and an iPhone built the table
   * that killed it. {@link DuckDBManager#wouldExceedTableBudget} awaits readiness and
   * applies `=== true` (unknown counts as cannot-stream); this delegates to it rather
   * than recomputing, so there is one budget computation and not two that can drift.
   *
   * @param {Array<{type?: string}>} variables
   * @param {number} rowCount - rows, or -1 when not known (routed pessimistically)
   * @param {object} [opts]
   * @param {boolean} [opts.declaredWide] - the caller already measured the source and
   *   knows a table cannot hold it (the full GSS FATAL-OOMs however empty the database).
   * @returns {Promise<{wide: boolean, overBudget: boolean, estBytes: number,
   *                    canStream: boolean, loadedBytes: number}>}
   */
  async planIngest(variables, rowCount, { declaredWide = false } = {}) {
    const overBudget = await this.wouldExceedTableBudget(variables, rowCount);
    return {
      wide: !!declaredWide || overBudget,
      overBudget,
      estBytes: estimateTableBytes(variables ?? [], rowCount),
      canStream: this.canStreamOutOfCore === true,
      loadedBytes: this.loadedTableBytes,
    };
  }

  /** Whether this browser can stream an ingest out of core. False on WebKit, where
   * `registerFileHandle` cannot cross into the worker — which makes a table ingest hold
   * the whole dataset (twice, at `finish`) in the wasm heap. @type {boolean|null} */
  get canStreamOutOfCore() {
    return this.#opfsHandleOk;
  }

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
    // EVERY statement the engine runs goes through here, which is what makes this the
    // place to instrument — and also why it cannot simply log all of them. A grid scroll
    // issues a window query per frame, so logging reads unconditionally would push 2,000
    // routine SELECTs through the ring buffer and throw away the context a bug report
    // needs. (The buffer IS the log: `saveLog()` exports it, most recent entries only.)
    //
    // So: every statement that CHANGES something is logged, because those are the ones
    // whose order matters when reconstructing what happened. Reads are logged only when
    // slow, because a slow read is a finding and a fast one is noise.
    if (!isDebug()) return conn.query(sql);
    const mutating = MUTATING_SQL.test(sql);
    const t0 = Date.now();
    try {
      const out = await conn.query(sql);
      const ms = Date.now() - t0;
      // Statement SHAPE, never its values: a log that goes into a bug report must not
      // carry the user's data, and a WHERE clause can.
      if (mutating) debug('sql', sqlShape(sql), { ms, rows: out?.numRows ?? null });
      else if (ms >= SLOW_QUERY_MS) debug('sql', `SLOW ${sqlShape(sql)}`, { ms, rows: out?.numRows ?? null });
      return out;
    } catch (err) {
      // A failing statement is always worth a line, read or not: this is the one place
      // that knows both the statement and that it threw.
      debug('sql', `FAILED ${sqlShape(sql)}`, {
        ms: Date.now() - t0,
        message: String(err?.message ?? err).slice(0, 200),
      });
      throw err;
    }
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
    if (colNames.length === 0) return;

    if (columns[colNames[0]].length === 0) {
      const defs = colNames.map((c) => {
        const sample = columns[c];
        const t = sample instanceof Float64Array || sample instanceof Float32Array ? 'DOUBLE' : 'VARCHAR';
        return `${quoteIdent(c)} ${t}`;
      });
      await conn.query(`CREATE TABLE ${quoteIdent(name)} (${defs.join(', ')})`);
      return;
    }

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
      const h = await root.getFileHandle(opfsName(name));
      await this.#db.registerFileHandle(name, h, PROT, true);
    };
    const removePart = async (name) => {
      try { await this.#db.dropFile(name); } catch { /* best-effort */ }
      try { await root.removeEntry(opfsName(name)); } catch { /* best-effort */ }
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
        const handle = await root.getFileHandle(opfsName(name), { create: true });
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
      const h = await root.getFileHandle(opfsName(name), { create: true });
      await this.#db.registerFileHandle(name, h, this.#duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      this.#opfsHandleOk = true;
    } catch {
      this.#opfsHandleOk = false; // Safari/WebKit: handles aren't postable to a worker
    }
    try { await this.#db.dropFile(name); } catch { /* best-effort */ }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(opfsName(name));
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
   * Say so, once, when the database did not end up on disk.
   *
   * The failure this guards is not an exception — `db.open()` succeeds and quietly
   * buffers (see the long note in `#instantiate`). For a month the only evidence was one
   * worker log line on an installed PWA, and a comment in this file asserted the
   * opposite. A diagnostic that nobody can see is how that happens.
   *
   * The test is the registry, not a heuristic: DuckDB's own `globFiles` reports a
   * `dataProtocol` per file, and a `0` (BUFFER) on the path the database resolved to
   * means the heap. Best-effort throughout — this is a diagnostic, and a diagnostic that
   * can break a boot is worse than no diagnostic.
   *
   * @param {any} db - the AsyncDuckDB, already opened
   * @param {string} dbFile - the plain OPFS database file name
   */
  async #warnIfNotDiskBacked(db, dbFile) {
    try {
      const files = await db.globFiles('*');
      // The spelling DuckDB resolves the database path to — one slash, not two.
      const resolved = `opfs:/${opfsName(dbFile)}`;
      const entry = (files ?? []).find((f) => String(f?.fileName) === resolved);
      // BUFFER is protocol 2 when DuckDB reports a missing file it is buffering and 0
      // once it holds one; either way, anything that is not 3 is not on disk.
      if (entry && Number(entry.dataProtocol) !== 3) {
        this.#diskBacked = false;
        console.warn(
          `[duckdb] the database is in the wasm heap, not on OPFS (${resolved} is`
          + ` dataProtocol ${entry.dataProtocol}). Large datasets cannot spill; the table`
          + ' budget is the only ceiling. See the note in core/duckdb-manager.js.',
        );
      } else if (entry) {
        this.#diskBacked = true;
      }
    } catch { /* a diagnostic must never be the thing that breaks the boot */ }
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
    // Write the OPFS file regardless (main-thread createWritable works on iOS, and it
    // keeps the file available for readOpfsFile/persistence).
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsName(name), { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    // Register BY NAME, on every platform. See {@link opfsRef}: this is the only route
    // that works on WebKit, and it works on Chromium too, so there is one path rather
    // than a capability branch. What it replaces on iOS was `registerFileBuffer` — the
    // whole Parquet in the heap, which made the out-of-core path not out-of-core exactly
    // where that hurt most.
    //
    // The handle fallback stays for one reason only: if registration by name ever fails,
    // a device that CAN post handles should not lose the feature over it.
    try {
      await this.#db.registerOPFSFileName(opfsRef(name));
      return opfsRef(name);
    } catch (err) {
      if (await this.#canUseOpfsHandles()) {
        await this.#db.registerFileHandle(name, handle, this.#duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      } else {
        // Nothing left but memory. Bounded by the device, and no longer the normal case.
        console.warn('[duckdb] OPFS registration by name failed; falling back to an in-memory buffer', err);
        await this.#db.registerFileBuffer(name, bytes);
      }
      // Both fallbacks register under the PLAIN name, so the reference differs by route.
      // Returning it is what keeps the caller from having to know which route was taken.
      return name;
    }
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
   * @returns {Promise<{writeRowGroup: (columnData: Array<{name: string, data: ArrayLike<*>}>) => void, finalize: (name: string) => Promise<string>}>}
   *   `finalize` resolves to the DuckDB REFERENCE for the file (`opfs://<name>` on the
   *   by-name route), which is what `read_parquet` must be given.
   */
  async openParquetWriter(columns, { name = null } = {}) {
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
    // statistics: true writes per-row-group min/max so reads can prune by a __ct_row
    // range (the wide grid's windowed scroll, #128). The footer grows modestly, but
    // pruning is the larger win on ultra-wide files.
    const pw = new W.ParquetWriter({ writer: bw, schema, statistics: true });

    // With a `name`, the encoded bytes go STRAIGHT TO OPFS a row group at a time and the
    // whole file is never held. Without one, the old behaviour: accumulate and hand over
    // a buffer.
    const sink = name ? await this.#openOpfsSink(name) : null;

    /**
     * Push what has been encoded so far to the sink and reset the buffer.
     *
     * `ByteWriter` keeps two counters, and the difference is the whole trick: `offset` is
     * the total ever written and `index` is the position within the current buffer. Every
     * file position in the Parquet metadata comes from `offset` — verified by reading
     * parquet-writer.js, column.js, indexes.js and metadata.js, where the only `.index`
     * occurrences are `Array.indexOf`. So resetting `index` after draining is invisible
     * to the format. Upstream's own node `fileWriter` does exactly this.
     *
     * Measured before it was written: 400 columns x 20,000 rows, buffered vs streamed,
     * produced byte-identical files (29,178,336 bytes each) with peak buffer 27.8 MiB vs
     * 2.9 MiB.
     *
     * The slice COPIES, which matters: the write is async and the buffer is reused the
     * moment this returns.
     */
    const drain = async () => {
      if (!sink || bw.index === 0) return;
      const chunk = new Uint8Array(bw.buffer.slice(0, bw.index));
      bw.index = 0;
      await sink.write(chunk);
    };

    return {
      // One write() call == one row group (rowGroupSize huge so it isn't re-split).
      writeRowGroup: (columnData) => pw.write({ columnData, rowGroupSize: 1_000_000_000 }),
      // Caller awaits this between row groups; a no-op when there is no sink.
      drain,
      // Returns the REFERENCE DuckDB will answer to, not the byte count — the caller
      // needs it for `read_parquet`, and it is `opfs://<name>` whenever registration by
      // name succeeded (see {@link opfsRef}). Nothing used the byte count.
      finalize: async (fallbackName) => {
        pw.finish(); // writes the footer into the buffer
        if (sink) {
          await drain();
          await sink.close();
          return this.#registerWrittenParquet(name);
        }
        const bytes = new Uint8Array(bw.getBuffer());
        return this.registerParquetFile(fallbackName ?? name, bytes);
      },
      /** Give up without leaving a half-written file holding a writable open. */
      abort: async () => { if (sink) await sink.abort(); },
    };
  }

  /**
   * A writable over an OPFS file, for the streaming Parquet path.
   *
   * `createWritable` is the main-thread OPFS write API and works on WebKit, which is the
   * entire reason this path exists there: DuckDB cannot write to OPFS on WebKit at all
   * (measured — a COPY to a registered `opfs://` file left it at one byte), so the bytes
   * have to come from us.
   *
   * @param {string} name - plain OPFS file name
   */
  async #openOpfsSink(name) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsName(name), { create: true });
    const writable = await handle.createWritable(); // truncates an existing file
    let written = 0;
    return {
      write: async (chunk) => { await writable.write(chunk); written += chunk.length; },
      close: async () => { await writable.close(); return written; },
      abort: async () => { try { await writable.abort(); } catch { /* best-effort */ } },
    };
  }

  /**
   * Register a Parquet file that is ALREADY on OPFS, without reading it back.
   *
   * The point of the streaming path: the bytes were never in memory and must not be put
   * there now. By-name registration is measured working on both Chromium and WebKit, and
   * the size gate is satisfied for free because the file has just been written.
   *
   * @param {string} name
   * @returns {Promise<string>} the reference for `read_parquet`
   */
  async #registerWrittenParquet(name) {
    await this.#ensureReady();
    try {
      await this.#db.registerOPFSFileName(opfsRef(name));
      return opfsRef(name);
    } catch (err) {
      // Unlucky path only: this spends the memory the streaming write just saved, so it
      // is never the normal route.
      console.warn('[duckdb] by-name registration failed for a written Parquet; reading it back', err);
      const bytes = await this.readOpfsFile(name);
      return this.registerParquetFile(name, bytes);
    }
  }

  /** Drop a file registered via {@link registerParquetFile}; optionally delete the
   * backing OPFS file too (otherwise it persists for a later session to re-register). */
  async dropRegisteredFile(name, { removeFromOpfs = false } = {}) {
    // `name` may be either spelling: the reference `registerParquetFile` returned
    // (`opfs://x` when registered by name) or the plain OPFS file name. Drop both from
    // DuckDB — whichever was not used is a harmless no-op — and always strip the prefix
    // before touching OPFS, which knows nothing about it.
    const plain = String(name ?? '').replace(/^opfs:\/\//, '');
    try { await this.#db.dropFile(opfsRef(plain)); } catch { /* best-effort */ }
    try { await this.#db.dropFile(plain); } catch { /* best-effort */ }
    if (removeFromOpfs) {
      try { const root = await navigator.storage.getDirectory(); await root.removeEntry(opfsName(name)); } catch { /* best-effort */ }
    }
  }

  /** Read Parquet bytes back from an OPFS file registered earlier (for persistence
   * export). @param {string} name @returns {Promise<Uint8Array>} */
  async readOpfsFile(name) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsName(name));
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
          try { await root.removeEntry(opfsName(n)); } catch { /* best-effort */ }
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

    // Open the database on OPFS so storage is disk-backed: DuckDB then pages to disk and
    // can hold datasets far larger than the wasm ~4 GB heap. Start each session from a
    // clean DB: dataset *persistence* is owned by the project/parquet store, so a
    // carried-over DuckDB file would only orphan tables and grow unbounded.
    // (`ATTACH 'opfs://…'` does NOT page — it must be the opened database.)
    //
    // ## THIS DOES NOT WORK, AND IT CANNOT BE MADE TO FROM HERE
    //
    // The database is in the wasm heap on every machine, every session, and the cause is
    // one character. **Measured 2026-11-19 on Chromium** by `core/storage-probe.js`
    // (`opfs-path-spelling`), after three earlier rounds chased the wrong thing:
    //
    // DuckDB canonicalises the scheme separator on every path it opens as a database or
    // opens for WRITING — `open({path})`, `ATTACH`, and `COPY … TO` alike. One, two,
    // three and four slashes all resolve to exactly `opfs:/name`. The duckdb-wasm file
    // registry is only reachable under the name a file was registered with, and
    // `opfs://name` is the only spelling that reaches the web filesystem at all —
    // register and open `opfs:/name` and DuckDB decides `opfs` is an unknown filesystem
    // scheme and tries to autoload `opfs.duckdb_extension.wasm`, which does not exist.
    //
    // So the write side looks up a name nothing is registered under, finds nothing, and
    // creates a BUFFER entry in the wasm heap. `globFiles` shows both, side by side:
    //
    //     opfs://crosstab-duckdb.db   dataProtocol 3   fileSize 0         <- the registration
    //     opfs:/crosstab-duckdb.db    dataProtocol 0   fileSize 1847296   <- the database
    //
    // `db.open()` does not throw, so the catch below never fires. The only outward sign
    // was a `Buffering missing file: opfs:/…` line from a worker — note the single slash,
    // which was the clue sitting in plain sight for a month.
    //
    // ## FOUR findings, one cause
    //
    // This retires three other conclusions, which were all this:
    //
    //   * **The size gate is not the obstacle.** `prepareDBFileHandle` does skip
    //     registration for a zero-length file (`!fromCached && handle.getSize() && …`), and
    //     that is real, but satisfying it changes nothing: a registration under
    //     `opfs://name` is not what the open looks up. The gate can also be defeated
    //     outright — `registerFileURL(ref, ref, 3, true)` sets the protocol and
    //     `registerOPFSFileName(ref)` stashes the sync handle via `_preparedHandles`
    //     before the gate, both string-only, both verified on a zero-byte file. It does
    //     not help here.
    //   * **Seeding cannot help either**, so the `copyFileToBuffer` wall that blocked
    //     three rounds no longer needs climbing. (DETACH-first-then-copy, the move those
    //     rounds concluded with, was tried on 2026-11-19 and also fails — the file is
    //     still in the registry, closed, and the copy still throws a bare `Error`.)
    //   * **"WebKit cannot write to OPFS" was mis-attributed.** `COPY … TO 'opfs://x'`
    //     leaves the file untouched and buffers 868,359 bytes under `opfs:/x` on
    //     **Chromium** too. It is not a platform gap; it is this gap, on the COPY target
    //     path. iOS is not worse off than the desktop here — both are in the heap.
    //
    // Reads are the one thing unaffected, which is why they are the one thing that works:
    // `read_parquet('opfs://x')` resolves against the registry under the registered name,
    // which is what the wide-dataset path is built on and why it genuinely is out of core.
    //
    // ## CONSEQUENCE
    //
    // There is no spill, on any platform, and no local change makes one. A table that
    // outgrows the heap dies with "no temporary directory is specified". The 67 MB
    // Scorecard CSV that OOMed at 3.1 GiB was fixed by correcting column TYPES (3,366
    // VARCHAR → 3,360 DOUBLE), not by storage. So the memory heuristics — the table
    // budget, width routing, cell-sized batches — are not scaffolding waiting for this
    // fix. They are the ceiling management, permanently, until duckdb-wasm looks the
    // database path up under the name it was registered with.
    //
    // The open is still ATTEMPTED, because the day that lands we get disk backing for
    // free and the cost today is two empty OPFS files. What is NOT acceptable is failing
    // silently, so it now checks and says so once. See `#warnIfNotDiskBacked`.
    try {
      const OPFS_DB = 'crosstab-duckdb.db';
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(opfsName(OPFS_DB)).catch(() => {});
        await root.removeEntry(opfsName(`${OPFS_DB}.wal`)).catch(() => {});
      } catch {
        /* OPFS unavailable — db.open below will fall back or throw, handled next */
      }
      await db.open({ path: `opfs://${OPFS_DB}`, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
      await this.#warnIfNotDiskBacked(db, OPFS_DB);
    } catch (err) {
      // OPFS unavailable (private mode, quota, older browser): stay in-memory.
      console.warn('[duckdb] OPFS open failed; using in-memory storage (datasets capped by the wasm heap)', err);
    }

    this.#worker = worker;
    this.#db = db;
    this.#conn = await db.connect();
    // Probe the handle capability NOW rather than on the first ingest, because the
    // routing decision for the FIRST import depends on it and that decision is
    // synchronous. See `wouldExceedTableBudget`.
    try { await this.#canUseOpfsHandles(); } catch { /* leaves it null; treated as unknown */ }
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
// --- the table budget --------------------------------------------------------
//
// Lives HERE, not in data-store, because the ceiling it guards belongs to the DuckDB
// INSTANCE and one instance is shared by every dataset. The first version tracked bytes
// per DataStore, which is per-DATASET — so each new import asked a store that had just
// been created and was told ~0. Three Scorecard years in a row reported
// `loadedMiB: 0` and FATAL-ed exactly as before the budget existed.

/**
 * Roughly what one DuckDB table of this shape costs in the wasm heap.
 *
 * A FLOOR, not a figure: a DOUBLE is 8 bytes, a VARCHAR slot is 16 (`string_t`) and
 * anything over 12 bytes also allocates on the string heap, which this does not count.
 * It is deliberately crude — what it has to do is tell "another Scorecard year" apart
 * from "a 40-column survey", and for that the floor is enough.
 *
 * @param {Array<{type?: string}>} variables
 * @param {number} rowCount
 * @returns {number} bytes
 */
export function estimateTableBytes(variables, rowCount) {
  const rows = Math.max(0, Number(rowCount) || 0);
  let perRow = 8; // the row-id column the ingest bakes in
  for (const v of variables ?? []) perRow += v?.type === 'string' ? 16 : 8;
  return perRow * rows;
}

/**
 * How much table data may sit in the DuckDB heap before an import is sent out-of-core.
 *
 * ## The ceiling is real and it is the CHECKPOINT
 *
 * `loadWide` has said for a while that "DuckDB-WASM's checkpoint can't accumulate past
 * ~600 MB and can't spill (OPFS temp is unimplemented)". That is why the out-of-core
 * Parquet path exists. What was missed is that the ceiling belongs to the DATABASE while
 * `isWideDataset` judges one FILE — so any number of individually-modest imports can walk
 * into it together.
 *
 * Which is what happened (owner, 2026-11-18), importing College Scorecard years one after
 * another, each 3,379 columns and none of them "wide" by the per-file rule:
 *
 *     table 1   6,272 rows  ~170 MB   ok
 *     table 2   6,430 rows  ~175 MB   ok        (~345 MB loaded)
 *     table 3   7,766 rows  ~211 MB   FATAL     (~556 MB loaded)
 *
 *     FATAL Error: Failed to create checkpoint: Out of Memory Error: Allocation failure
 *
 * It had ingested every row — `rowsIngested: 7766`, the full file — and died 18 seconds
 * later writing itself out. And FATAL is not an ordinary error: DuckDB invalidates the
 * database, so the two tables that HAD loaded go down with it.
 *
 * ## Why this number
 *
 * Bracketed by those two observations, not chosen: ~345 MB demonstrably works, ~556 MB
 * demonstrably does not. 384 MiB sits above the first and well below the second, leaving
 * room for what this estimate ignores (string heap, per-column metadata, and the
 * checkpoint's own transient allocation — the thing that actually blew up).
 *
 * Re-measure before raising it. The cost of being wrong in this direction is a slower
 * import; in the other, it is a dead database and the loss of everything already loaded.
 */
export const TABLE_BYTE_BUDGET = 384 * 1024 * 1024;

/**
 * The budget where the ingest CANNOT stream out of core — WebKit, today.
 *
 * A different ceiling for a different reason. Above, the limit is the checkpoint's and
 * the data is on its way to disk. Here nothing goes to disk: `#beginMemoryIngest` appends
 * every batch into a temp table and then does
 *
 *     CREATE TABLE target AS SELECT *, row_number() OVER () ... FROM tmp
 *
 * so at `finish` BOTH tables are resident and a window function materialises across the
 * whole thing. Peak is upwards of twice the dataset, in a web view iOS will reclaim long
 * before DuckDB's own 3.1 GiB limit is reached.
 *
 * Which it did: importing one 3,379 × 6,272 Scorecard year on an iPhone (~163 MiB by the
 * estimate above, so ~330 MiB at finish) killed the PWA outright — the log recorded
 * `read finished` with all 22 batches consumed and nothing after it. That is the single
 * observation this number is set against, so it is set WELL below it rather than near it,
 * and an ordinary survey (40 columns × 100,000 rows is 33 MB) still goes to a table.
 *
 * The out-of-core path this diverts to is not a consolation prize on WebKit: `loadWide`
 * encodes Parquet in JS one row group at a time and registers it BY NAME, which is the
 * one OPFS route WebKit does support (measured, iOS 18.7). It is bounded where this is
 * not.
 *
 * Refine it with a measurement, not a guess — and the measurement is a phone.
 */
export const TABLE_BYTE_BUDGET_IN_MEMORY = 64 * 1024 * 1024;

/**
 * Should a table of this shape go out-of-core, given what is already loaded?
 *
 * Pure, so the arithmetic can be tested without a DuckDB.
 *
 * @param {number} loadedBytes - {@link DataStore#loadedTableBytes}
 * @param {Array<{type?: string}>} variables
 * @param {number} rowCount
 * @param {boolean} [canStreamOutOfCore=true] - False on WebKit, where the ingest holds
 *   the whole dataset in memory and a far smaller budget applies. See
 *   {@link TABLE_BYTE_BUDGET_IN_MEMORY}.
 * @returns {boolean}
 */
export function exceedsTableBudget(loadedBytes, variables, rowCount, canStreamOutOfCore = true) {
  const budget = canStreamOutOfCore ? TABLE_BYTE_BUDGET : TABLE_BYTE_BUDGET_IN_MEMORY;
  return (Number(loadedBytes) || 0) + estimateTableBytes(variables, rowCount) > budget;
}

/**
 * How DuckDB refers to an OPFS file we have registered.
 *
 * Registration by NAME is the only route that works everywhere. `registerFileHandle`
 * posts a `FileSystemFileHandle` to the worker and WebKit refuses to clone it
 * (`DataCloneError`), which is why `registerParquetFile` used to fall back to
 * `registerFileBuffer` on iOS — loading the whole Parquet into memory, so the
 * "out-of-core" path was nothing of the kind on the one platform least able to afford it.
 *
 * `registerOPFSFileName` takes a string; the worker calls
 * `navigator.storage.getDirectory()` and opens its own sync access handle, so nothing
 * crosses the boundary. Measured 2026-11-18 on BOTH an iPhone (iOS 18.7, where
 * `opfsHandlesToWorker` is false) and Chromium desktop (where it is true): registered and
 * read back identically. One path, not two.
 *
 * The cost is that the registered key — and therefore the string SQL must use — carries
 * the prefix. Everything in the app keeps the plain OPFS file name; this is applied at
 * the DuckDB boundary and nowhere else.
 *
 * @param {string} name - the plain OPFS file name
 * @returns {string} e.g. `opfs://ct_wide_3.parquet`
 */
export function opfsRef(name) {
  const s = String(name ?? '');
  return s.startsWith('opfs://') ? s : `opfs://${s}`;
}

/**
 * The inverse: the plain OPFS file name, whichever spelling you have.
 *
 * **Every OPFS call in this file goes through this**, and a test enforces that, because
 * relying on remembering is what broke. `opfsRef` was introduced so DuckDB could be told
 * about a file by name; the reference then flows outward as `src.file`, and the save path
 * handed it to `getFileHandle` — which rejects it, since `/` and `:` are not legal in an
 * OPFS name:
 *
 *     TypeError: Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle':
 *     Name is not allowed.
 *
 * — owner, 2026-11-18, on the first import that routed wide. `dropRegisteredFile` had
 * been taught to strip; `readOpfsFile` had not. One call site is a bug waiting; the rule
 * is that there are no bare ones.
 *
 * Idempotent, so it is safe on a name that never had the prefix.
 *
 * @param {string} ref
 * @returns {string}
 */
export function opfsName(ref) {
  return String(ref ?? '').replace(/^opfs:\/\//, '');
}

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
