/**
 * @file storage-probe.js
 * Does a DuckDB database opened at `opfs://…` actually end up on disk?
 *
 * ## Why this exists instead of a fix
 *
 * It does not, today — `duckdb-manager.js` explains the mechanism: duckdb-wasm registers
 * an `opfs://` database only when the file already has bytes, and we delete it
 * immediately before opening, so every session runs in the wasm heap with no spill. That
 * much is settled, read out of the pinned bundle.
 *
 * What is NOT settled is the remedy, and it is not deducible. Nothing upstream can
 * bootstrap a NEW OPFS database, so dropping the delete is necessary and probably not
 * sufficient; the likely fix is to seed a valid empty database into OPFS first. Whether
 * that works depends on answers no amount of reading gives: does `copyFileToBuffer`
 * produce an image DuckDB will reopen, does the `.wal` need the same treatment, does a
 * seeded file actually get REGISTERED rather than buffered again.
 *
 * Guessing costs a round trip per guess when the only feedback is an exported log. So
 * this answers all of them in ONE run, and the fix follows from the output.
 *
 * ## Safety
 *
 * It never touches the live database. It stands up its own duckdb instance against its
 * own `crosstab-probe-*.db` files, and deletes them afterwards. The cost is a second
 * wasm heap for the duration, which is why it is a deliberate menu action and not a
 * boot-time check.
 *
 * Run it from **Edit ▸ Debugging ▸ Storage diagnostics…** with logging on, then export
 * the log.
 */

import { debug } from './debug.js';
import { getAssets } from './assets.js';
import { opfsRef } from './duckdb-manager.js';

/** Rows written before CHECKPOINT. Enough that a disk-backed file cannot be 0 bytes,
 * small enough that a buffered one cannot OOM the probe. */
const PROBE_ROWS = 200_000;

/**
 * Everything knowable about a thrown value.
 *
 * The first run of this probe reported `error: ""` for the case that mattered, because
 * it did `String(err?.message ?? err)` and the throw had no `message`. A diagnostic that
 * cannot describe a failure is not a diagnostic — so this takes the name, the message,
 * any own enumerable properties (DuckDB's worker errors carry detail there), and the
 * first stack frames, and never returns an empty string.
 */
function describeError(err) {
  if (err == null) return 'threw null/undefined';
  const bits = [];
  try {
    if (typeof err === 'string') return err || 'threw an empty string';
    if (err.name) bits.push(String(err.name));
    if (err.message) bits.push(String(err.message));
    const own = {};
    for (const k of Object.keys(err)) {
      if (k === 'stack' || k === 'message' || k === 'name') continue;
      const v = err[k];
      if (v != null && typeof v !== 'object' && typeof v !== 'function') own[k] = v;
    }
    if (Object.keys(own).length) bits.push(jsonSafe(own));
    if (!bits.length) bits.push(Object.prototype.toString.call(err), String(err));
    if (typeof err.stack === 'string' && err.stack) {
      bits.push(err.stack.split('\n').slice(0, 3).join(' | '));
    }
  } catch (e) {
    bits.push(`(describing the error itself threw: ${e?.message ?? e})`);
  }
  const out = bits.filter(Boolean).join(' — ').slice(0, 600);
  return out || 'threw something with nothing on it';
}

/** JSON that survives BigInt. Arrow hands back BigInt for 64-bit columns, and the first
 * run lost `duckdb_memory` and `pragma_database_size` — the two that would let the table
 * budget ASK instead of estimate — to a bare `JSON.stringify`. */
function jsonSafe(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}` : v));
  } catch (e) {
    return `(unserialisable: ${e?.message ?? e})`;
  }
}

/** Delete an OPFS file, ignoring "not there". */
async function opfsDelete(name) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name).catch(() => {});
  } catch {
    /* no OPFS at all — the caller reports that separately */
  }
}

/** Size of an OPFS file in bytes, or null when it does not exist. */
async function opfsSize(name) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    return (await handle.getFile()).size;
  } catch {
    return null;
  }
}

/** Write bytes to an OPFS file, replacing it. */
async function opfsWrite(name, bytes) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

/** A fresh duckdb instance, built the way DuckDBManager builds its own. */
async function makeInstance(duckdb) {
  const assets = getAssets();
  const bundles = assets.duckdbBundles ? assets.duckdbBundles() : duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  let workerUrl;
  try {
    const src = await (await fetch(bundle.mainWorker)).text();
    workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  } catch {
    workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  }
  const worker = new Worker(workerUrl);
  // A CAPTURING logger, not a ConsoleLogger. Two runs reported the seed failing with
  // `[object Error] — Error` and nothing else: duckdb-wasm marshals worker errors across
  // postMessage and the message does not survive, so no amount of squeezing the Error
  // object on this side recovers it. The logger is the other channel — the worker's own
  // account of what it was doing — and at DEBUG it says what the C++ side reported.
  const logs = [];
  const logger = {
    log: (entry) => {
      try {
        logs.push(typeof entry === 'string' ? entry : jsonSafe(entry));
        if (logs.length > 60) logs.shift(); // the tail is the interesting part
      } catch { /* a logger must never be the thing that throws */ }
    },
  };
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  return { db, worker, logs };
}

/**
 * Write some data, checkpoint, and report whether the OPFS file grew.
 *
 * A non-zero file after CHECKPOINT is the whole question: it means DuckDB registered the
 * path as OPFS (protocol 3) rather than buffering it in the heap (protocol 2).
 */
async function runCase(duckdb, label, { seed }) {
  const name = `crosstab-probe-${label}.db`;
  const result = { case: label, seeded: !!seed };
  await opfsDelete(name);
  await opfsDelete(`${name}.wal`);

  let inst = null;
  // Which step was last ENTERED. The first run said only that seeding failed, which left
  // five candidate causes and no way to choose between them.
  let step = 'start';
  const at = (s) => { step = s; };
  try {
    if (seed) {
      // Make a valid, empty DuckDB image and put it in OPFS so the file is non-empty
      // BEFORE the real open — which is the condition the registration is gated on.
      // Two ways to produce a valid empty image, tried in order, because the first run
      // died at `copyFileToBuffer` — almost certainly because it had already DETACHed,
      // so the file was gone from DuckDB's registry by the time it was asked for. Copy
      // before detaching; and if that is not it, open the path directly instead.
      // Each strategy is a LIST OF NAMED STEPS, not one opaque function. The last two runs
      // said "attach-copy-detach failed" — which could have been the ATTACH, the
      // CHECKPOINT or the copy, three different diagnoses. Now the failure names the
      // statement.
      const strategies = [
        {
          // The one the last three rounds pointed at. `globFiles` showed DuckDB holding
          // the file under exactly the name being copied, so the name was never the
          // problem — what differed between the copy that failed and the `.wal` copy that
          // SUCCEEDED was that the wal was closed and trivial. So: detach first, confirm
          // the file is still in the registry, and copy it closed.
          name: 'detach-then-copy',
          steps: [
            ['attach', (db, conn) => conn.query(`ATTACH '${name}' AS seed`)],
            ['create', (db, conn) => conn.query('CREATE TABLE seed.t (i INTEGER)')],
            ['checkpoint', (db, conn) => conn.query('CHECKPOINT seed')],
            ['detach', (db, conn) => conn.query('DETACH seed')],
            // Does DETACH also DROP it? If the registry is empty here the copy cannot
            // work and the whole seeding idea is finished, which is worth knowing.
            ['glob-after-detach', async (db, conn, attempt) => {
              attempt.globAfterDetach = jsonSafe(await db.globFiles('*'));
            }],
            ['copyFileToBuffer', (db) => db.copyFileToBuffer(name)],
          ],
          bytesFrom: 'copyFileToBuffer',
        },
        {
          name: 'attach-copy-detach',
          steps: [
            ['attach', (db, conn) => conn.query(`ATTACH '${name}' AS seed`)],
            ['checkpoint', (db, conn) => conn.query('CHECKPOINT')],
            ['copyFileToBuffer', (db) => db.copyFileToBuffer(name)], // BEFORE the detach
            ['detach', (db, conn) => conn.query('DETACH seed').catch(() => undefined)],
          ],
          // Which step's return value is the image.
          bytesFrom: 'copyFileToBuffer',
        },
        {
          name: 'open-buffered-path',
          openPath: name, // open the file itself rather than attaching it
          steps: [
            ['checkpoint', (db, conn) => conn.query('CHECKPOINT').catch(() => undefined)],
            ['copyFileToBuffer', (db) => db.copyFileToBuffer(name)],
          ],
          bytesFrom: 'copyFileToBuffer',
        },
        {
          // Third way in, added because the first two fail identically on both platforms
          // and may share a cause: let DuckDB create the file through a plain CREATE,
          // which exercises the write path without ATTACH or an explicit path at all.
          name: 'attach-with-table',
          steps: [
            ['attach', (db, conn) => conn.query(`ATTACH '${name}' AS seed`)],
            ['create', (db, conn) => conn.query('CREATE TABLE seed.t (i INTEGER)')],
            ['checkpoint', (db, conn) => conn.query('CHECKPOINT seed')],
            ['copyFileToBuffer', (db) => db.copyFileToBuffer(name)],
            ['detach', (db, conn) => conn.query('DETACH seed').catch(() => undefined)],
          ],
          bytesFrom: 'copyFileToBuffer',
        },
      ];

      result.seedAttempts = [];
      let bytes = null;
      for (const strategy of strategies) {
        at(`seed:${strategy.name}`);
        const s = await makeInstance(duckdb);
        const attempt = { strategy: strategy.name, reached: [] };
        try {
          // READ_WRITE explicitly. `open()` does not default to read-write, so neither
          // ATTACH (which must CREATE a file) nor opening a path that is not there could
          // ever have worked — the second strategy said exactly that once the error
          // reporting was fixed.
          attempt.reached.push('open');
          await s.db.open({
            ...(strategy.openPath ? { path: strategy.openPath } : {}),
            accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
          });
          attempt.reached.push('connect');
          const conn = await s.db.connect();
          for (const [label, fn] of strategy.steps) {
            attempt.reached.push(label);
            const out = await fn(s.db, conn, attempt);
            if (label === strategy.bytesFrom) bytes = out;
          }
          await conn.close();
          attempt.bytes = bytes?.length ?? 0;
          if (!bytes?.length) bytes = null;
        } catch (err) {
          attempt.failedAt = attempt.reached[attempt.reached.length - 1];
          attempt.error = describeError(err).slice(0, 300);
          bytes = null;
        } finally {
          // The worker's own account, which is the only place the real message survives.
          attempt.workerLog = (s.logs ?? []).slice(-8);
          await s.db.terminate().catch(() => {});
          s.worker.terminate();
        }
        result.seedAttempts.push(attempt);
        if (bytes?.length) break;
      }
      if (!bytes?.length) throw new Error(`no seed strategy produced an image: ${jsonSafe(result.seedAttempts)}`);
      result.seedBytes = bytes.length;
      at('seed:opfsWrite');
      await opfsWrite(name, bytes);
      result.sizeBeforeOpen = await opfsSize(name);
    } else {
      result.sizeBeforeOpen = await opfsSize(name); // expected null: this is today's path
    }

    at('open');
    inst = await makeInstance(duckdb);
    await inst.db.open({ path: `opfs://${name}`, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    at('connect');
    const conn = await inst.db.connect();
    at('create-table');
    await conn.query(`CREATE TABLE probe AS SELECT i, i::DOUBLE AS x, ('v' || i) AS s FROM range(${PROBE_ROWS}) t(i)`);
    at('checkpoint');
    await conn.query('CHECKPOINT');
    at('measure');
    result.sizeAfterCheckpoint = await opfsSize(name);
    result.walAfterCheckpoint = await opfsSize(`${name}.wal`);
    result.diskBacked = (result.sizeAfterCheckpoint ?? 0) > 0;
    await conn.close();
    at('done');
  } catch (err) {
    result.failedAt = step;
    result.error = describeError(err);
    result.workerLog = (inst?.logs ?? []).slice(-8);
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
    await opfsDelete(name);
    await opfsDelete(`${name}.wal`);
  }
  debug('probe', `case:${label}`, result);
  return result;
}

/**
 * Can DuckDB read an OPFS file it was given by NAME rather than by handle?
 *
 * This is the mobile question, and it is a different question from the two cases above.
 * `registerFileHandle` posts a `FileSystemFileHandle` to the worker, WebKit refuses to
 * clone it, and `registerParquetFile` therefore falls back to `registerFileBuffer` —
 * which loads the whole Parquet into memory. So on iOS the out-of-core path is not
 * out-of-core, the database is not disk-backed either, and the most memory-constrained
 * platform we support has no escape hatch at all.
 *
 * But `registerOPFSFileName` takes a STRING. The worker calls
 * `navigator.storage.getDirectory()` itself and opens its own sync access handle, so no
 * handle ever crosses the boundary and WebKit's objection does not apply. And unlike the
 * database case, the size gate is satisfied for free: a file we have already written has
 * bytes in it.
 *
 * If this works, iOS can have genuine out-of-core reads today. CSV rather than Parquet
 * only because a valid Parquet is awkward to synthesise here — what is under test is
 * whether DuckDB can open an OPFS path by name in a worker, not which format it holds.
 */
async function probeOpfsByName(duckdb) {
  const name = 'crosstab-probe-byname.csv';
  const out = { case: 'opfs-by-name' };
  let inst = null;
  let step = 'start';
  const at = (s) => { step = s; };
  try {
    at('write');
    await opfsWrite(name, new TextEncoder().encode('a,b\n1,x\n2,y\n3,z\n'));
    out.bytesWritten = await opfsSize(name);
    at('instance');
    inst = await makeInstance(duckdb);
    at('open');
    await inst.db.open({});
    at('registerOPFSFileName');
    await inst.db.registerOPFSFileName(`opfs://${name}`);
    out.registered = true;
    at('query');
    const conn = await inst.db.connect();
    const rows = await conn.query(`SELECT count(*) AS n FROM read_csv_auto('opfs://${name}')`);
    out.rowsRead = jsonSafe(rows.toArray().map((r) => r.toJSON()));
    out.readable = true;
    await conn.close();
    at('done');
  } catch (err) {
    out.failedAt = step;
    out.error = describeError(err);
    out.readable = false;
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
    await opfsDelete(name);
  }
  debug('probe', 'case:opfs-by-name', out);
  return out;
}

/**
 * Can DuckDB WRITE to an OPFS file it was given by name?
 *
 * The question that decides whether an out-of-core ingest is buildable on WebKit.
 * Reading by name is settled — it works on both platforms. Writing is not, and the
 * reason is the size gate: by-name registration only registers a file that ALREADY HAS
 * BYTES, so a fresh, empty Parquet part is skipped, buffered in the heap, and `COPY … TO`
 * writes to memory. That is precisely what the out-of-core ingest exists to avoid.
 *
 * The candidate trick is to defeat the gate rather than the API: write one placeholder
 * byte with `createWritable` (which WebKit does support from the main thread), register
 * the now-non-empty file by name, and let `COPY` truncate and overwrite it. The protocol-3
 * handlers in the bundle do implement truncate and write, so this is plausible — and
 * plausible is exactly the standard that has cost the owner four round trips today.
 *
 * Decisive either way: if the OPFS file grows past the placeholder AND reads back with
 * the right row count, WebKit can write out of core and `beginStreamIngest` can be
 * rebuilt on it. If it stays one byte, the bytes went to the heap and it cannot.
 */
async function probeOpfsWrite(duckdb) {
  const name = 'crosstab-probe-write.parquet';
  const out = { case: 'opfs-by-name-write' };
  let inst = null;
  let step = 'start';
  const at = (s) => { step = s; };
  try {
    at('placeholder');
    // One byte, so the registration gate has something to measure.
    await opfsWrite(name, new Uint8Array([0]));
    out.sizeBeforeCopy = await opfsSize(name);
    at('instance');
    inst = await makeInstance(duckdb);
    await inst.db.open({ accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    at('register');
    await inst.db.registerOPFSFileName(opfsRef(name));
    const conn = await inst.db.connect();
    at('copy');
    await conn.query(
      `COPY (SELECT i, i * 2 AS j, ('v' || i) AS s FROM range(${PROBE_ROWS}) t(i)) `
      + `TO '${opfsRef(name)}' (FORMAT parquet)`,
    );
    at('measure');
    out.sizeAfterCopy = await opfsSize(name);
    // The whole question: did the bytes reach OPFS, or the heap?
    out.wroteToOpfs = (out.sizeAfterCopy ?? 0) > 1024;
    at('readback');
    const rows = await conn.query(`SELECT count(*) AS n FROM read_parquet('${opfsRef(name)}')`);
    out.rowsRead = jsonSafe(rows.toArray().map((r) => r.toJSON()));
    await conn.close();
    at('done');
  } catch (err) {
    out.failedAt = step;
    out.error = describeError(err);
    out.workerLog = (inst?.logs ?? []).slice(-8);
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
    await opfsDelete(name);
  }
  debug('probe', 'case:opfs-by-name-write', out);
  return out;
}

/**
 * What does DuckDB actually CALL its files?
 *
 * The other open thread. Every seed strategy died at `copyFileToBuffer` with each SQL
 * statement before it succeeding, which points at the name rather than the operation —
 * and we have already seen DuckDB normalise `opfs://x` to `opfs:/x` in its own log. If
 * the file it created is held under a spelling other than the one passed to ATTACH, the
 * copy is simply asking for something that is not there.
 *
 * `globFiles` reads the registry directly, so this stops being a guess.
 */
async function probeFileNames(duckdb) {
  const attached = 'crosstab-probe-names.db';
  const out = { case: 'file-names' };
  let inst = null;
  try {
    await opfsDelete(attached);
    inst = await makeInstance(duckdb);
    await inst.db.open({ accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    const conn = await inst.db.connect();
    out.before = jsonSafe(await inst.db.globFiles('*'));
    await conn.query(`ATTACH '${attached}' AS seed`);
    await conn.query('CREATE TABLE seed.t (i INTEGER)');
    await conn.query('CHECKPOINT seed');
    // The names DuckDB holds AFTER creating the thing we then fail to copy.
    out.after = jsonSafe(await inst.db.globFiles('*'));
    // And try the copy against each name it reports, rather than the one we assumed.
    out.copyAttempts = [];
    const names = [attached, opfsRef(attached), `${attached}.wal`];
    try {
      for (const f of (JSON.parse(out.after) ?? [])) {
        const n = f?.fileName ?? f?.name ?? null;
        if (n && !names.includes(n)) names.push(n);
      }
    } catch { /* the list is diagnostic either way */ }
    for (const n of names) {
      try {
        const bytes = await inst.db.copyFileToBuffer(n);
        out.copyAttempts.push({ name: n, bytes: bytes?.length ?? 0 });
      } catch (err) {
        out.copyAttempts.push({ name: n, error: describeError(err).slice(0, 160) });
      }
    }
    await conn.query('DETACH seed').catch(() => {});
    await conn.close();
  } catch (err) {
    out.error = describeError(err);
    out.workerLog = (inst?.logs ?? []).slice(-8);
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
    await opfsDelete(attached);
    await opfsDelete(`${attached}.wal`);
  }
  debug('probe', 'case:file-names', out);
  return out;
}

/**
 * Can the database be made disk-backed by REGISTERING the file before opening it?
 *
 * ## Why this is a different question from seeding
 *
 * Three rounds were spent trying to seed a valid empty image into OPFS so the file would
 * be non-empty when `open()` checked it. That accepts the size gate and tries to satisfy
 * it. This goes around it, and the route came out of the pinned bundle rather than out of
 * a hunch. `prepareFileHandles` begins:
 *
 *     if (X._files.has(n)) return { path: n, handle: X._files.get(n), fromCached: true };
 *
 * and the gate the OPEN handler then applies is
 *
 *     !fromCached && handle.getSize() && await registerFileHandleAsync(path, handle, 3, true)
 *
 * So a name ALREADY in the worker's `_files` map short-circuits on `!fromCached` — the
 * size is never consulted, and whatever protocol was registered for that name stands.
 * Register the OPFS database as protocol 3 BEFORE `open()`, and a zero-length file is
 * fine: there is nothing to seed.
 *
 * ## THE SPELLING IS THE WHOLE THING, and it is ONE SLASH
 *
 * Measured 2026-11-19 on Chromium. Registering `opfs://x` before the open worked exactly
 * as read: `globFiles` showed it at `dataProtocol: 3` both before and after, and
 * `duckdb_databases()` agreed the database was that file. And the OPFS file stayed at 0
 * bytes, because the glob had FOUR entries, not two:
 *
 *     opfs://…db      fileSize 0        dataProtocol 3   <- ours
 *     opfs://…db.wal  —                 dataProtocol 3   <- ours
 *     opfs:/…db       fileSize 1847296  dataProtocol 0   <- DuckDB's own, BUFFER
 *     opfs:/…db.wal   fileSize 1        dataProtocol 0
 *
 * DuckDB's C++ side normalises `opfs://x` to `opfs:/x`, finds nothing registered under
 * THAT, and buffers a second entry in the wasm heap. Our registration was never
 * consulted. 1.8 MB of database in the heap, beside a correct-looking protocol-3 entry
 * nothing reads — which is why the mechanism looked right and the file looked empty.
 *
 * This also closes the thread that cost the previous three rounds. A probe did check the
 * names once and concluded "not a naming problem" — correctly, for the case it ran, which
 * ATTACHed a plain name where no normalisation happens. The `opfs://` path is where the
 * slash goes missing, and that case was never the one being examined.
 *
 * ## AND REGISTERING UNDER THE RESOLVED NAME CANNOT WORK EITHER — measured, same run
 *
 * The obvious follow-up is to register `opfs:/x` and open `opfs:/x`. The open fails
 * before it begins:
 *
 *     IO Error: Extension https://extensions.duckdb.org/v1.5.4/wasm_eh/
 *               opfs.duckdb_extension.wasm is not available
 *
 * One slash makes `opfs` an unknown filesystem SCHEME, so DuckDB tries to autoload an
 * `opfs` extension instead of routing to the registered-file filesystem. `opfs://` is
 * the only spelling that reaches the web filesystem, and `opfs:/` is the only spelling
 * the registry is then consulted with. The two cannot be made to meet from outside the
 * worker, so **a NEW opened-on-OPFS database is not reachable in this build** — not by
 * seeding (the size gate), and not by pre-registering (this). It is an upstream fix.
 *
 * `registerFileURL` is kept as a control. It posts only strings and it DOES set
 * protocol 3 — measured, despite the binding passing four arguments against a two-entry
 * `argTypes` list — which matters a great deal later, just not here.
 *
 * ## The two posting routes, and why only one can ever work
 *
 * `registerFileHandle` posts a `FileSystemFileHandle` into the worker, which WebKit
 * refuses to clone. `registerFileURL` posts only strings — and it does set protocol 3
 * (measured; the binding passes four arguments against a two-entry `argTypes` list and
 * emscripten's `ccall` carries the extras through anyway). But protocol 3 is not enough
 * on its own. `openFile` case 3 is:
 *
 *     let d = X._files?.get(_.fileName);
 *     if (!d) throw new Error("No OPFS access handle registered with name: " + _.fileName);
 *
 * A sync access handle must be in `_files`, and only posting a handle puts one there.
 * `registerOPFSFileName` is the string-only route that does, but it goes through the size
 * gate and keys the handle under the `opfs://` spelling DuckDB will not look up. So the
 * `url` route is kept as the negative control it is: it proves the protocol is set and
 * still cannot work, which is the shape of the WebKit gap rather than a bug in the call.
 *
 * ## What counts as an answer
 *
 * Size is read AFTER the instance is terminated, not before. The worker holds an
 * exclusive sync access handle while it runs, so a main-thread `getFile()` can report a
 * stale 0 — the first version of this probe measured through the lock and would have
 * called a working fix a failure. Then it REOPENS in a fresh instance and counts the
 * rows, because a file with bytes in it that DuckDB cannot read back is not a disk-backed
 * database.
 *
 * @param {any} duckdb - the imported duckdb-wasm module
 * @param {{route: 'handle'|'url', spelling: 'double'|'single'}} how
 */
async function probeDbRegisterFirst(duckdb, { route, spelling }) {
  const label = `${route}-${spelling}`;
  const name = `crosstab-probe-reg-${label}.db`;
  const wal = `${name}.wal`;
  const out = { case: `db-register-first:${label}` };
  const PROT = duckdb.DuckDBDataProtocol.BROWSER_FSACCESS;
  // The one variable under test. `opfs:/x` is what DuckDB normalises to and therefore
  // what it looks up; `opfs://x` is what every other call site in the app spells.
  const ref = (f) => (spelling === 'single' ? `opfs:/${f}` : opfsRef(f));
  let inst = null;
  let step = 'start';
  const at = (x) => { step = x; };

  /** Register both database files under the spelling being tested. */
  const registerBoth = async (db) => {
    const root = await navigator.storage.getDirectory();
    for (const f of [name, wal]) {
      if (route === 'handle') {
        const h = await root.getFileHandle(f, { create: true });
        await db.registerFileHandle(ref(f), h, PROT, true);
      } else {
        await db.registerFileURL(ref(f), ref(f), PROT, true);
      }
    }
  };

  try {
    at('create-empty-files');
    await opfsDelete(name);
    await opfsDelete(wal);
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(name, { create: true });
    await root.getFileHandle(wal, { create: true });
    out.sizeBeforeOpen = await opfsSize(name); // 0 — the state that defeats the size gate

    at('instance');
    inst = await makeInstance(duckdb);
    at(`register:${label}`);
    await registerBoth(inst.db);
    // The registry as DuckDB sees it BEFORE the open. `dataProtocol` here is the claim.
    out.globBeforeOpen = jsonSafe(await inst.db.globFiles('*'));

    at('open');
    await inst.db.open({
      path: ref(name),
      accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      // Set by hand: the worker only sets it on the `opfs://` branch, which the
      // single-slash spelling deliberately skips.
      useDirectIO: true,
    });
    at('connect');
    const conn = await inst.db.connect();
    at('databases');
    try {
      const rows = await conn.query('SELECT database_name, path, type FROM duckdb_databases()');
      out.databases = jsonSafe(rows.toArray().map((r) => r.toJSON())).slice(0, 400);
    } catch { /* diagnostic only */ }
    at('create-table');
    await conn.query(`CREATE TABLE probe AS SELECT i, i::DOUBLE AS x, ('v' || i) AS s FROM range(${PROBE_ROWS}) t(i)`);
    at('checkpoint');
    await conn.query('CHECKPOINT');
    at('glob');
    // The smoking gun from the first run: a SECOND entry at dataProtocol 0 under a
    // different spelling means the bytes went to the heap. Recorded either way.
    out.globAfterOpen = jsonSafe(await inst.db.globFiles('*'));
    await conn.close();

    at('terminate');
    await inst.db.terminate().catch(() => {});
    inst.worker.terminate();
    inst = null;
    // NOW measure: the exclusive sync handle is released, so this is the real size.
    at('measure');
    out.sizeAfterTerminate = await opfsSize(name);
    out.walAfterTerminate = await opfsSize(wal);
    out.diskBacked = (out.sizeAfterTerminate ?? 0) > 0;

    at('reopen');
    // Attempted unconditionally. If the file has bytes this proves they are a database;
    // if it does not, the error is the clearest statement of what went wrong.
    try {
      inst = await makeInstance(duckdb);
      await registerBoth(inst.db);
      await inst.db.open({
        path: ref(name),
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
        useDirectIO: true,
      });
      const conn2 = await inst.db.connect();
      const rows = await conn2.query('SELECT count(*) AS n FROM probe');
      out.rowsAfterReopen = jsonSafe(rows.toArray().map((r) => r.toJSON()));
      out.reopened = `${PROBE_ROWS}` === `${rows.toArray()[0]?.toJSON()?.n}`;
      await conn2.close();
    } catch (err) {
      out.reopened = false;
      out.reopenError = describeError(err).slice(0, 300);
      out.reopenWorkerLog = (inst?.logs ?? []).slice(-6);
    }
    at('done');
  } catch (err) {
    out.failedAt = step;
    out.error = describeError(err);
    out.workerLog = (inst?.logs ?? []).slice(-8);
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
    await opfsDelete(name);
    await opfsDelete(wal);
  }
  debug('probe', `case:db-register-first:${label}`, out);
  return out;
}

/**
 * Put the TABLES on OPFS by ATTACHing a registered file, rather than by opening one.
 *
 * ## The idea, and why it was wrong
 *
 * Everything above fights `open({path: 'opfs://…'})`, and that fight is lost. ATTACH
 * looked like a way around it: the file-names probe ATTACHed `crosstab-probe-names.db`
 * and `globFiles` reported that exact string, so ATTACH appeared not to normalise. USE
 * the attached database and every table the ingest creates would be written through
 * DuckDB's buffer manager into a real OPFS file.
 *
 * **MEASURED 2026-11-19 — no.** `duckdb_databases()` reports
 * `path: "opfs:/crosstab-probe-attach-handle.db"` and the glob grows the same buffered
 * twin the opened-database case produced: `opfs:/…db` at `dataProtocol: 0`, 1,851,393
 * bytes in the wasm heap, beside our untouched protocol-3 entry. The earlier probe saw no
 * normalisation because the name it ATTACHed had no scheme and therefore no `//` to
 * collapse — it was never the case under examination. See {@link probeOpfsPathSpelling},
 * which is what finally settled the general rule.
 *
 * Kept as a case rather than deleted, because "ATTACH does not page" is an assertion
 * `duckdb-manager.js` carried untested for months and this is the measurement that
 * retires it.
 *
 * ## The two routes are a platform question, not a style question
 *
 * - `handle` posts a `FileSystemFileHandle`. Chromium only; WebKit refuses to clone it,
 *   which is the same objection that makes the out-of-core ingest fall back on iOS.
 * - `url-name` posts **only strings**, in two calls that each supply half of what a
 *   protocol-3 registration needs for a ZERO-LENGTH file:
 *
 *     registerFileURL('opfs://x', 'opfs://x', 3, true)  // sets the protocol
 *     registerOPFSFileName('opfs://x')                  // stashes the sync handle
 *
 *   The second looks pointless, since its size gate skips the registration for an empty
 *   file. It is not: `prepareFileHandles` stashes the sync access handle in
 *   `_preparedHandles[name]` BEFORE that gate, unconditionally, and `getFileInfo` later
 *   promotes it —
 *
 *     !X._files.has(u.fileName) && X._preparedHandles[u.fileName]
 *       && (X._files.set(u.fileName, X._preparedHandles[u.fileName]), …)
 *
 *   — which is exactly what `openFile` case 3 needs (`_files.get(fileName)`, or it throws
 *   "No OPFS access handle registered with name"). Protocol from one call, handle from
 *   the other, no handle crossing a postMessage boundary, and no bytes required.
 *
 * **That pairing WORKS, and it is the one reusable thing this probe found.** Verified
 * here and again in {@link probeOpfsWrite}: a zero-length OPFS file registers at
 * `dataProtocol: 3` through string-only calls, which is the size gate defeated — the gate
 * that was believed to make a NEW empty OPFS part unregisterable on WebKit. It does not
 * rescue THIS case, because what defeats ATTACH is the spelling and not the gate. Where
 * it may matter is any path that needs a fresh OPFS file registered without posting a
 * handle.
 *
 * @param {any} duckdb - the imported duckdb-wasm module
 * @param {'handle'|'url-name'} route - how the registration is posted to the worker
 */
async function probeAttachOpfsDatabase(duckdb, route) {
  const name = `crosstab-probe-attach-${route}.db`;
  const wal = `${name}.wal`;
  const out = { case: `attach-opfs:${route}` };
  const PROT = duckdb.DuckDBDataProtocol.BROWSER_FSACCESS;
  let inst = null;
  let step = 'start';
  const at = (x) => { step = x; };

  /** Register both files as protocol 3 under the `opfs://` spelling ATTACH will resolve. */
  const registerBoth = async (db) => {
    const root = await navigator.storage.getDirectory();
    for (const f of [name, wal]) {
      // The file must exist before either route: `handle` needs something to hand over,
      // and `registerOPFSFileName` opens it by name.
      await root.getFileHandle(f, { create: true });
      if (route === 'handle') {
        const h = await root.getFileHandle(f, { create: true });
        await db.registerFileHandle(opfsRef(f), h, PROT, true);
      } else {
        await db.registerFileURL(opfsRef(f), opfsRef(f), PROT, true);
        await db.registerOPFSFileName(opfsRef(f));
      }
    }
  };

  try {
    at('create-empty-files');
    await opfsDelete(name);
    await opfsDelete(wal);
    at('instance');
    inst = await makeInstance(duckdb);
    // A plain in-memory database. The OPFS file is the ATTACHED one, which is the point:
    // nothing here depends on the opened-database path that cannot be fixed.
    await inst.db.open({ accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    at(`register:${route}`);
    await registerBoth(inst.db);
    out.globBeforeAttach = jsonSafe(await inst.db.globFiles('*'));

    const conn = await inst.db.connect();
    at('attach');
    await conn.query(`ATTACH '${opfsRef(name)}' AS disk`);
    at('use');
    await conn.query('USE disk');
    at('databases');
    try {
      const rows = await conn.query('SELECT database_name, path, type FROM duckdb_databases()');
      out.databases = jsonSafe(rows.toArray().map((r) => r.toJSON())).slice(0, 400);
    } catch { /* diagnostic only */ }
    at('create-table');
    await conn.query(`CREATE TABLE probe AS SELECT i, i::DOUBLE AS x, ('v' || i) AS s FROM range(${PROBE_ROWS}) t(i)`);
    at('checkpoint');
    await conn.query('CHECKPOINT disk');
    at('glob');
    // A second entry at dataProtocol 0 under any spelling of this name means the bytes
    // went to the heap, whatever the file size says.
    out.globAfterCheckpoint = jsonSafe(await inst.db.globFiles('*'));
    at('detach');
    // Back to the default catalog first: DETACHing the database in USE is an error.
    await conn.query('USE memory').catch(() => {});
    await conn.query('DETACH disk').catch(() => {});
    await conn.close();

    at('terminate');
    await inst.db.terminate().catch(() => {});
    inst.worker.terminate();
    inst = null;
    // Only now: the worker holds an exclusive sync access handle while it lives, so a
    // main-thread getFile() before this can report a stale zero.
    at('measure');
    out.sizeAfterTerminate = await opfsSize(name);
    out.walAfterTerminate = await opfsSize(wal);
    out.diskBacked = (out.sizeAfterTerminate ?? 0) > 0;

    at('reopen');
    // Bytes are not a database. Reopen in a FRESH instance and count the rows.
    try {
      inst = await makeInstance(duckdb);
      await inst.db.open({ accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
      await registerBoth(inst.db);
      const conn2 = await inst.db.connect();
      await conn2.query(`ATTACH '${opfsRef(name)}' AS disk`);
      const rows = await conn2.query('SELECT count(*) AS n FROM disk.probe');
      out.rowsAfterReopen = jsonSafe(rows.toArray().map((r) => r.toJSON()));
      out.reopened = `${PROBE_ROWS}` === `${rows.toArray()[0]?.toJSON()?.n}`;
      await conn2.close();
    } catch (err) {
      out.reopened = false;
      out.reopenError = describeError(err).slice(0, 300);
      out.reopenWorkerLog = (inst?.logs ?? []).slice(-6);
    }
    at('done');
  } catch (err) {
    out.failedAt = step;
    out.error = describeError(err);
    out.workerLog = (inst?.logs ?? []).slice(-8);
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
    await opfsDelete(name);
    await opfsDelete(wal);
  }
  debug('probe', `case:attach-opfs:${route}`, out);
  return out;
}

/**
 * How many slashes does DuckDB keep after `opfs:`? — the measurement that explained
 * everything else in this file.
 *
 * ## Why one question about punctuation is the whole story
 *
 * Four separate failures were being carried as four separate findings: the database is
 * never disk-backed, seeding it fails at `copyFileToBuffer`, pre-registering the file
 * does nothing, and "WebKit cannot write to OPFS". They have ONE cause.
 *
 * DuckDB canonicalises the scheme separator on every path it opens as a database or
 * **opens for writing** — `open({path})`, `ATTACH`, and `COPY … TO` alike. The file
 * registry, meanwhile, is only reachable under the spelling it was registered with, and
 * `opfs://` is the only spelling that reaches the web filesystem at all (register and
 * open `opfs:/x` and DuckDB decides `opfs` is an unknown filesystem scheme and tries to
 * autoload `opfs.duckdb_extension.wasm`, which does not exist). So the write side looks
 * up a name nothing is registered under, finds nothing, and silently creates a BUFFER
 * entry in the wasm heap instead. Every one of those four failures is that, and the
 * buffered twin is visible in `globFiles` in each case.
 *
 * Reads are unaffected, which is why they were the one thing that worked:
 * `read_parquet('opfs://x')` resolves against the registry under the registered name.
 *
 * ## What this case does
 *
 * Registers the same OPFS file as protocol 3 under the canonical `opfs://name`, then
 * ATTACHes it with one, two, three and four slashes, and reports the path DuckDB ends up
 * holding. If any spelling survived to `opfs://name`, there would be a workaround.
 *
 * **Measured 2026-11-19, Chromium: every one of them collapses to exactly `opfs:/name`,
 * and every one produces a ~540 KB buffered twin.** There is no spelling to find, so this
 * is not a bug to route around — it is an upstream fix, and the probe exists to say so
 * cheaply if anyone doubts it later or a new duckdb-wasm lands.
 *
 * @param {any} duckdb - the imported duckdb-wasm module
 */
async function probeOpfsPathSpelling(duckdb) {
  const out = { case: 'opfs-path-spelling', attempts: [] };
  let inst = null;
  try {
    inst = await makeInstance(duckdb);
    await inst.db.open({ accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    const root = await navigator.storage.getDirectory();
    // One slash through four. `opfs://` is the canonical spelling and the control.
    for (const [i, prefix] of ['opfs:/', 'opfs://', 'opfs:///', 'opfs:////'].entries()) {
      const file = `crosstab-probe-slash-${i}.db`;
      const attempt = { slashes: prefix.length - 5, attachedAs: `${prefix}${file}` };
      await opfsDelete(file);
      await opfsDelete(`${file}.wal`);
      const handle = await root.getFileHandle(file, { create: true });
      // Always registered under the CANONICAL name, so the only thing varying is the
      // spelling ATTACH is given.
      await inst.db.registerFileHandle(opfsRef(file), handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      const conn = await inst.db.connect();
      try {
        await conn.query(`ATTACH '${prefix}${file}' AS d${i}`);
        const rows = await conn.query('SELECT database_name, path FROM duckdb_databases()');
        attempt.resolvedPath = rows.toArray().map((r) => r.toJSON())
          .find((r) => r.database_name === `d${i}`)?.path ?? null;
        await conn.query(`CREATE TABLE d${i}.t AS SELECT i FROM range(50000) t(i)`);
        await conn.query(`CHECKPOINT d${i}`);
        // The buffered twin, if there is one: name | protocol | size.
        attempt.files = (await inst.db.globFiles('*'))
          .filter((f) => String(f.fileName).includes(file))
          .map((f) => `${f.fileName}|p${f.dataProtocol}|${f.fileSize ?? '-'}`);
        await conn.query(`DETACH d${i}`).catch(() => {});
      } catch (err) {
        attempt.error = describeError(err).slice(0, 200);
      }
      await conn.close();
      out.attempts.push(attempt);
      await opfsDelete(file);
      await opfsDelete(`${file}.wal`);
    }
    // One line, because this is the finding: the DISTINCT set of things DuckDB resolved
    // to, with the per-attempt filename folded out so four identical answers read as one.
    out.resolvedTo = [...new Set(out.attempts.map((a) => {
      const v = a.resolvedPath ?? (a.error ? `error: ${a.error.slice(0, 60)}` : 'no path');
      return v.replace(/slash-\d/, 'slash-N');
    }))].join(' , ');
  } catch (err) {
    out.error = describeError(err);
  } finally {
    if (inst) {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
    }
  }
  debug('probe', 'case:opfs-path-spelling', out);
  return out;
}

/** Which self-reporting APIs this duckdb build actually answers. Useful beyond this
 * probe: the table budget in data-store.js is an ESTIMATE only because none of these
 * was known to work. */
async function probeIntrospection(duckdb) {
  const out = {};
  const inst = await makeInstance(duckdb);
  try {
    await inst.db.open({});
    const conn = await inst.db.connect();
    for (const [key, sql] of [
      ['duckdb_memory', 'SELECT * FROM duckdb_memory()'],
      ['database_size', 'SELECT * FROM pragma_database_size()'],
      ['duckdb_databases', 'SELECT database_name, path, type FROM duckdb_databases()'],
      ['memory_limit', "SELECT current_setting('memory_limit') AS v"],
      ['temp_directory', "SELECT current_setting('temp_directory') AS v"],
    ]) {
      try {
        const rows = await conn.query(sql);
        out[key] = jsonSafe(rows.toArray().map((r) => r.toJSON())).slice(0, 500);
      } catch (err) {
        out[key] = `unavailable: ${describeError(err).slice(0, 200)}`;
      }
    }
    await conn.close();
  } finally {
    await inst.db.terminate().catch(() => {});
    inst.worker.terminate();
  }
  debug('probe', 'introspection', out);
  return out;
}

/**
 * Run the whole probe. Logs through `debug('probe', …)`, so turn logging on first and
 * export the log afterwards.
 *
 * @returns {Promise<object>} the same findings, for a caller that wants them inline
 */
export async function probeStorage() {
  const report = { opfs: null, cases: [], introspection: null };
  debug('probe', 'starting — this creates its own duckdb, nothing here touches your data');

  try {
    await navigator.storage.getDirectory();
    report.opfs = 'available';
  } catch (err) {
    report.opfs = `unavailable: ${String(err?.message ?? err).slice(0, 200)}`;
    debug('probe', 'OPFS unavailable — nothing below can work', { why: report.opfs });
    return report;
  }

  const assets = getAssets();
  const duckdb = await import(/* @vite-ignore */ assets.duckdbUrl);

  // Which platform this is, in the terms that actually decide the answer. The first run
  // came off an iPhone, where WebKit cannot hand an OPFS FileSystemFileHandle to a
  // worker (DuckDBManager probes the same thing for its out-of-core ingest) — so a
  // failure there may be WebKit's rather than the approach's, and a report that does not
  // say which is a report that gets over-read.
  report.platform = { ua: (navigator.userAgent || '').slice(0, 200) };
  try {
    const inst = await makeInstance(duckdb);
    try {
      await inst.db.open({});
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('__ct_probe_fsaccess', { create: true });
      await inst.db.registerFileHandle('__ct_probe_fsaccess', h, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      report.platform.opfsHandlesToWorker = true;
      try { await inst.db.dropFile('__ct_probe_fsaccess'); } catch { /* best-effort */ }
    } catch (err) {
      report.platform.opfsHandlesToWorker = false;
      report.platform.opfsHandleError = describeError(err).slice(0, 200);
    } finally {
      await inst.db.terminate().catch(() => {});
      inst.worker.terminate();
      await opfsDelete('__ct_probe_fsaccess');
    }
  } catch (err) {
    report.platform.opfsHandlesToWorker = `probe failed: ${describeError(err).slice(0, 160)}`;
  }
  debug('probe', 'platform', report.platform);

  // The decisive pair. `cold` is exactly what the app does today — open a path whose
  // file does not exist. `seeded` is the proposed fix. If cold reports diskBacked:false
  // and seeded reports true, the remedy is settled and the rest is plumbing.
  report.cases.push(await runCase(duckdb, 'cold', { seed: false }));
  report.cases.push(await runCase(duckdb, 'seeded', { seed: true }));
  // The mobile question, and independent of the two above: it can pass on a device where
  // seeding fails, which would mean iOS gets out-of-core READS even without a disk-backed
  // database. Worth knowing separately rather than folding into one verdict.
  report.cases.push(await probeOpfsByName(duckdb));
  // The two that decide what gets built next: whether WebKit can WRITE out of core, and
  // what DuckDB calls the file every seed attempt failed to copy.
  report.cases.push(await probeOpfsWrite(duckdb));
  report.cases.push(await probeFileNames(duckdb));
  // And the route that needs no seed at all — registering the database file as protocol 3
  // before `open()`, so the size gate is short-circuited by `fromCached`. Both posting
  // routes, because they fail on different platforms.
  // `handle-single` is the candidate fix; the other three are its controls — one varies
  // the spelling, one varies the posting route, and `url-double` is what the first run
  // already measured, kept so a re-run shows the same thing.
  for (const how of [
    { route: 'handle', spelling: 'single' },
    { route: 'handle', spelling: 'double' },
  ]) {
    report.cases.push(await probeDbRegisterFirst(duckdb, how));
  }
  // The route that does not fight the opened-database path at all: ATTACH, where the
  // path is NOT normalised, so a pre-registered protocol-3 file is actually found.
  for (const route of ['handle', 'url-name']) {
    report.cases.push(await probeAttachOpfsDatabase(duckdb, route));
  }
  // And the one that explains all of the above in a single line of output.
  report.cases.push(await probeOpfsPathSpelling(duckdb));

  try {
    report.introspection = await probeIntrospection(duckdb);
  } catch (err) {
    report.introspection = { error: String(err?.message ?? err).slice(0, 200) };
  }

  const regCases = report.cases.filter((c) => c.case.startsWith('db-register-first:'));
  const attachCases = report.cases.filter((c) => c.case.startsWith('attach-opfs:'));
  // The headline, because this is the one that says whether a disk-backed store is
  // buildable at all — and `url-name` specifically is the one that could reach iOS.
  const attach = attachCases
    .map((c) => {
      const label = c.case.replace('attach-opfs:', '');
      if (c.reopened) return `${label}=YES (${c.sizeAfterTerminate} bytes, reopened)`;
      if (c.diskBacked) return `${label}=${c.sizeAfterTerminate} bytes but no reopen (${c.reopenError ?? '?'})`;
      return `${label}=no (${c.failedAt ?? 'buffered in the heap'}${c.error ? `: ${String(c.error).slice(0, 80)}` : ''})`;
    })
    .join(', ');
  // Its own finding rather than folded into `database:`, because a win here makes seeding
  // moot and a win on the `url` route specifically is the one that ships to iOS.
  // "Disk-backed" alone is not enough: it has to reopen.
  const reg = regCases
    .map((c) => {
      const label = c.case.replace('db-register-first:', '');
      if (c.reopened) return `${label}=YES (${c.sizeAfterTerminate} bytes)`;
      if (c.diskBacked) return `${label}=${c.sizeAfterTerminate} bytes but no reopen (${c.reopenError ?? c.failedAt ?? '?'})`;
      return `${label}=no (${c.failedAt ?? 'buffered in the heap'})`;
    })
    .join(', ');
  const cold = report.cases.find((c) => c.case === 'cold');
  const seeded = report.cases.find((c) => c.case === 'seeded');
  const byName = report.cases.find((c) => c.case === 'opfs-by-name');
  const db = cold?.diskBacked
    ? 'cold open is ALREADY disk-backed — the premise is wrong, re-read duckdb-manager.js'
    : seeded?.diskBacked
      ? 'seeding works: seed once, then never delete the file'
      // Name the STATEMENT, not just the strategy: "attach-copy-detach failed" could be
      // three different diagnoses, and two runs were spent not knowing which.
      : `seeding did NOT make it disk-backed (${(seeded?.seedAttempts ?? [])
          .map((a) => `${a.strategy}@${a.failedAt ?? 'ok'}`).join(', ') || seeded?.failedAt || '?'})`;
  // Reported as two findings, not one. They fail independently, and conflating them is
  // how "it does not work on mobile" turns into "mobile gets the slow path" by default.
  const write = report.cases.find((c) => c.case === 'opfs-by-name-write');
  const spell = report.cases.find((c) => c.case === 'opfs-path-spelling');
  // First, because it is the CAUSE and the rest are its symptoms.
  report.verdict = `opfs:// resolves to: ${spell?.resolvedTo ?? spell?.error ?? '?'}`
    + ` | ATTACH on OPFS: ${attach}`
    + ` | database: ${db}`
    + ` | register-before-open: ${reg}`
    + ` | by-name READ: ${byName?.readable ? 'yes' : `no (${byName?.failedAt ?? '?'})`}`
    // The one that decides whether an out-of-core ingest is buildable on WebKit.
    + ` | by-name WRITE: ${write?.wroteToOpfs ? 'YES — the ingest can be rebuilt on this' : `no (${write?.failedAt ?? 'bytes went to the heap'})`}`;
  debug('probe', 'verdict', { verdict: report.verdict });
  return report;
}
