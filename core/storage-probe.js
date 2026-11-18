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
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  return { db, worker };
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
      at('seed:instance');
      const s = await makeInstance(duckdb);
      try {
        at('seed:open-memory');
        await s.db.open({});
        at('seed:connect');
        const conn = await s.db.connect();
        at('seed:attach');
        await conn.query(`ATTACH '${name}' AS seed`);
        at('seed:checkpoint');
        await conn.query('CHECKPOINT');
        at('seed:detach');
        await conn.query('DETACH seed');
        at('seed:copyFileToBuffer');
        const bytes = await s.db.copyFileToBuffer(name);
        result.seedBytes = bytes?.length ?? 0;
        at('seed:opfsWrite');
        await opfsWrite(name, bytes);
        await conn.close();
      } finally {
        await s.db.terminate().catch(() => {});
        s.worker.terminate();
      }
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

  try {
    report.introspection = await probeIntrospection(duckdb);
  } catch (err) {
    report.introspection = { error: String(err?.message ?? err).slice(0, 200) };
  }

  const cold = report.cases.find((c) => c.case === 'cold');
  const seeded = report.cases.find((c) => c.case === 'seeded');
  report.verdict = cold?.diskBacked
    ? 'cold open is ALREADY disk-backed — the premise is wrong, re-read duckdb-manager.js'
    : seeded?.diskBacked
      ? 'seeding works: seed once, then never delete the file'
      : 'seeding did NOT make it disk-backed — look at the per-case errors';
  debug('probe', 'verdict', { verdict: report.verdict });
  return report;
}
