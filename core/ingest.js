/**
 * @file ingest.js
 * One way for data to enter the engine.
 *
 * ## Why this file exists
 *
 * There were six. Counted 2026-11-20, after the owner asked whether there was any reason
 * not to consolidate: *"three paths to data ingest means three places to watch for bugs
 * and three feature sets that can drift."* There were twice that many, and the drift was
 * already measurable rather than hypothetical:
 *
 * | route | primitive | could record the budget | could carry missing codes | decided wide |
 * |---|---|---|---|---|
 * | `#createSource({columns})` | `replaceTable` (one Arrow shot) | no | no | no |
 * | `#createSource({parquet})` | `registerFileBuffer` + CTAS | no | no | no |
 * | `loadStreaming` | `beginStreamIngest` batches | **yes** | yes | yes |
 * | `loadWide` | JS Parquet → OPFS | n/a | yes | yes |
 * | `#restoreWideSource` | `registerParquetFile` | n/a | yes | n/a |
 * | `#createSourceFromSql` | `CREATE TABLE AS SELECT` | no | no | no |
 *
 * One of six recorded what the shared budget needs. That is not carelessness: each route
 * was added for a real need at a different time, and no single one of them ever looked
 * worth a rewrite on its own.
 *
 * ## What the budget is actually for, which decides the shape of this module
 *
 * It is an ENGINE limit, not a JS one. A plugin that materialises a whole table in its own
 * heap is spending its own memory and that is its business; what cannot be allowed is that
 * table reaching DuckDB **in one piece**, because the ceiling it hits is the checkpoint —
 * which cannot accumulate past a few hundred MB, cannot spill (there is no disk-backed
 * database; see `duckdb-manager.js`), and whose failure is FATAL to the whole database,
 * taking down every dataset that had already loaded successfully.
 *
 * So the job here is not to stop callers building big things. It is to make sure nothing
 * arrives at the engine unbatched and unaccounted. A caller that hands over whole columns
 * is therefore served by the same code as one that streams: the host slices the payload
 * and chooses the batch size, which bounds the engine without pretending to bound the
 * caller.
 *
 * ## What is NOT consolidated, deliberately
 *
 * `#createSourceFromSql` — Extract and Join — stays separate and keeps its
 * `CREATE TABLE AS SELECT`. It never materialises in JS at all (#121), so routing it
 * through a batch protocol would pull gigabytes out through JS that currently never leave
 * the engine. That is not drift; it is the best path in the file, and it should be used
 * more rather than folded in. What it is missing is the provenance and the accounting,
 * which is a different fix.
 *
 * ## Where the ROUTE decision lives, which is not here
 *
 * `DuckDBManager#planIngest`. Two of its three inputs — what the database already holds,
 * and whether this browser can stream out of core at all — are properties of that
 * instance, and the second is not known synchronously: it is probed during init, and the
 * first import routes before anything has touched DuckDB. A version of this file that
 * decided the route itself read the capability while it was still `null` and reproduced
 * the exact bug that killed an iPhone. This module takes `wide` as an argument and does
 * not have an opinion.
 */

import { rowGroupFor } from './plugin-stdlib.js';
import { debug } from './debug.js';

/** The row-id column the wide (Parquet) route bakes in. Mirrors `data-store.js`'s
 * `CT_ROW`; passed in rather than imported to keep the dependency one-way. */
export const WIDE_ROW_COL = '__ct_row';

/**
 * Open an ingest and get back one `batch`/`finish`/`abort`, whichever route it took.
 *
 * Both underlying mechanisms already had this shape; what they did not have was a common
 * face, so every caller had to know which one it was talking to. A caller now says what
 * it has and streams it.
 *
 * - **table route** — `beginStreamIngest`, which itself picks OPFS-backed parts or an
 *   in-memory ingest depending on what the browser allows (WebKit cannot hand an OPFS
 *   handle to the worker). The row id is baked in by the ingest, so there is no
 *   full-table rewrite afterwards.
 * - **wide route** — Parquet encoded in JS, one row group at a time, streamed straight to
 *   OPFS and registered for `read_parquet`. DuckDB only ever READS it, which is the only
 *   genuinely out-of-core thing available: encoding in JS bypasses the write/checkpoint
 *   path entirely.
 *
 * `batch(columns)` returns a promise on both routes and the caller MUST await it. That is
 * the backpressure: on the wide route it is what keeps one row group in flight instead of
 * all of them, and dropping it lets every OPFS write race.
 *
 * @param {object} arg
 * @param {object} arg.duckdb - DuckDBManager
 * @param {boolean} arg.wide - from `DuckDBManager#planIngest`
 * @param {Array<{name: string, type?: string}>} arg.variables - in column order
 * @param {Object<string, string>} arg.storageTypes - name → 'numeric'|'string'
 * @param {string} arg.table - the table name to build (table route)
 * @param {string} arg.file - the OPFS file name to write (wide route)
 * @param {string} arg.rowidCol - the row-id column name (table route)
 * @param {number} arg.rowidBase - the row-id namespace for this source
 * @param {number} [arg.rowGroupRows] - rows per Parquet row group; derived from the
 *   width when 0, because a row group is accumulated whole in JS and so its size IS the
 *   peak memory of that path.
 * @returns {Promise<{wide: boolean, batch: (columns: object) => Promise<void>,
 *                    finish: () => Promise<{rows: number, file?: string}>,
 *                    abort: () => Promise<void>}>}
 */
export async function openIngest({
  duckdb, wide, variables, storageTypes, table, file, rowidCol, rowidBase, rowGroupRows = 0,
}) {
  let rows = 0;
  if (!wide) {
    const ingester = await duckdb.beginStreamIngest(table, storageTypes, { rowidCol, rowidBase });
    return {
      wide: false,
      batch: async (columns) => {
        rows += rowsIn(columns);
        await ingester.addBatch(columns);
      },
      finish: async () => {
        // The phase an iPhone died in with nothing in the log: `finish` is where a WebKit
        // ingest builds the final table from its temp one, holding both at once.
        debug('data', 'ingest finishing', { rows });
        await ingester.finish();
        debug('data', 'ingest finished', { rows });
        return { rows };
      },
      abort: async () => {
        try { await duckdb.query(`DROP TABLE IF EXISTS ${quoted(table)}`); } catch { /* best-effort */ }
        try { await duckdb.cleanupStreamIngest(table); } catch { /* best-effort */ }
      },
    };
  }

  const groupRows = rowGroupRows > 0 ? rowGroupRows : rowGroupFor(variables.length);
  const columns = variables.map((v) => ({ name: v.name, type: v.type === 'string' ? 'string' : 'numeric' }));
  columns.push({ name: WIDE_ROW_COL, type: 'numeric' });
  const writer = await duckdb.openParquetWriter(columns, { name: file });

  // One row group's worth of column buffers, reset on each flush — so peak JS memory here
  // is one row group rather than the whole (potentially multi-GB) dataset.
  const freshAcc = () => {
    const a = {};
    for (const v of variables) a[v.name] = [];
    a[WIDE_ROW_COL] = [];
    return a;
  };
  let acc = freshAcc();
  let accRows = 0;
  let registered = file;

  const flush = async () => {
    if (accRows === 0) return;
    const columnData = variables.map((v) => ({
      name: v.name,
      data: acc[v.name],
      ...(v.type === 'string' ? {} : { type: 'DOUBLE' }),
    }));
    columnData.push({ name: WIDE_ROW_COL, data: acc[WIDE_ROW_COL], type: 'DOUBLE' });
    writer.writeRowGroup(columnData);
    acc = freshAcc();
    accRows = 0;
    // Awaited: push the encoded row group to OPFS and free the buffer before the next one
    // is built.
    await writer.drain();
  };

  return {
    wide: true,
    batch: (cols) => {
      const n = rowsIn(cols, variables[0]?.name);
      for (const v of variables) {
        const src = cols[v.name];
        const dst = acc[v.name];
        for (let k = 0; k < n; k++) dst.push(src[k]);
      }
      const rowIdx = acc[WIDE_ROW_COL];
      for (let k = 0; k < n; k++) rowIdx.push(rows + k);
      rows += n;
      accRows += n;
      // RETURNED rather than called and dropped — see the note on backpressure above.
      return accRows >= groupRows ? flush() : Promise.resolve();
    },
    finish: async () => {
      await flush();
      registered = await writer.finalize(file);
      return { rows, file: registered };
    },
    abort: async () => {
      // Close the writable first, or the half-written file stays locked by it.
      try { await writer.abort?.(); } catch { /* best-effort */ }
      try { await duckdb.dropRegisteredFile(registered, { removeFromOpfs: true }); } catch { /* best-effort */ }
    },
  };
}

/** Rows in a batch: the length of any one column, since all of them must agree. */
function rowsIn(columns, preferred = null) {
  if (preferred && columns[preferred]) return columns[preferred].length;
  const first = Object.keys(columns)[0];
  return first ? columns[first].length : 0;
}

/** A locally quoted identifier, so this module does not import the SQL helper just to
 * name a table in one best-effort DROP. */
function quoted(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
