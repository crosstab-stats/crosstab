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
  try {
    if (seed) {
      // Make a valid, empty DuckDB image and put it in OPFS so the file is non-empty
      // BEFORE the real open — which is the condition the registration is gated on.
      const s = await makeInstance(duckdb);
      try {
        await s.db.open({});
        const conn = await s.db.connect();
        await conn.query(`ATTACH '${name}' AS seed`);
        await conn.query('CHECKPOINT');
        await conn.query('DETACH seed');
        const bytes = await s.db.copyFileToBuffer(name);
        result.seedBytes = bytes?.length ?? 0;
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

    inst = await makeInstance(duckdb);
    await inst.db.open({ path: `opfs://${name}`, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    const conn = await inst.db.connect();
    await conn.query(`CREATE TABLE probe AS SELECT i, i::DOUBLE AS x, ('v' || i) AS s FROM range(${PROBE_ROWS}) t(i)`);
    await conn.query('CHECKPOINT');
    result.sizeAfterCheckpoint = await opfsSize(name);
    result.walAfterCheckpoint = await opfsSize(`${name}.wal`);
    result.diskBacked = (result.sizeAfterCheckpoint ?? 0) > 0;
    await conn.close();
  } catch (err) {
    result.error = String(err?.message ?? err).slice(0, 300);
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
        out[key] = JSON.stringify(rows.toArray().map((r) => r.toJSON())).slice(0, 400);
      } catch (err) {
        out[key] = `unavailable: ${String(err?.message ?? err).slice(0, 120)}`;
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
