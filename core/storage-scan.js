/**
 * @file storage-scan.js
 * Find the working files no session owns any more — "scan for lost files".
 *
 * ## What is lost, and why nothing was collecting it
 *
 * An out-of-core ingest writes its Parquet to the OPFS **root**, named
 * `ct_src_<dataset>_<seq>.parquet`. That file is session scratch and nothing more: saving a
 * project does not reference it, it COPIES the bytes to `projects/<id>/src_<opId>.parquet`.
 * So the root file is owned by one tab, for as long as that tab lives.
 *
 * Every in-session release is already correct — `DataStore#pruneDeadSources` frees a source
 * a `replace` barrier dropped, `DatasetManager#purge` disposes and frees, and `remove` bins
 * rather than frees on purpose, so a restore costs nothing. What has no owner is the END of
 * a session: a reload, a crash or a closed tab disposes nothing, so everything that session
 * wrote stays on disk forever. One wide import is routinely hundreds of megabytes, so this
 * is the expensive kind of leak, and OPFS has no "temp" that the browser reclaims.
 *
 * ## Why it is a scan a person runs, and not a sweep on boot
 *
 * Because of the rule the rest of this codebase keeps (see `ProjectStore#discardUnreferenced`,
 * which says it at length): **never delete what you cannot account for**. A file this tab
 * does not recognise is routinely another tab's live data, and deleting a stranger's working
 * set is far worse than leaving bytes on disk. A boot-time sweep would have to decide that
 * question at the one moment it knows least.
 *
 * ## How "nobody owns it" is made provable rather than guessed
 *
 * Three gates, and a file has to clear all of them:
 *
 *  1. **No other tab is open.** Every session holds a shared Web Lock named
 *     {@link TAB_LOCK}, so `navigator.locks.query()` counts the live sessions across the
 *     whole origin. One holder means this tab is alone and no other session can own
 *     anything here. The lock is released by the browser when the tab dies, which is
 *     exactly the event that strands the files — so a crashed session can never hold its
 *     orphans hostage. If the API is missing the scan reports and refuses to delete, which
 *     is the honest answer rather than a guess.
 *  2. **The name is one WE write.** An allow-list, not "anything unfamiliar". The OPFS root
 *     also holds `projects/` and the plugin-package directory, and a future feature will put
 *     something else there; a file that does not match is left alone forever, which is the
 *     safe direction to be wrong in.
 *  3. **It is not live here, and not warm.** Files this tab's datasets are using are
 *     excluded by name, and so is anything modified in the last {@link WARM_MS} — an ingest
 *     in flight has written its parts but not yet registered them, and a scan racing one
 *     must not call its working set garbage.
 *
 * The functions are parameterised over the directory and the lock manager so the rules can
 * be tested without OPFS, which is the only way the gates get exercised at all.
 */

/** The shared lock every session holds for its lifetime, so sessions can be counted. */
export const TAB_LOCK = 'crosstab-session';

/** A file younger than this may belong to an ingest that has not registered it yet. */
export const WARM_MS = 60_000;

/**
 * The working files CrossTab writes to the OPFS root.
 *
 * Deliberately anchored and specific. `ct_src_<datasetId>_<seq>.parquet` is the source
 * itself (`DataStore#load`); `__part<n>` are the streaming-ingest pieces
 * (`DuckDBManager`, which cleans them up itself when a run finishes normally) and
 * `_restore` is the hard-restore staging file. `__merge<n>` has no producer today and is
 * matched because `cleanupStreamIngest` already expects it — a name we would clean up in
 * session is a name we can collect after one.
 */
export const WORKING_FILE = /^ct_src_\d+_\d+(?:__part\d+|__merge\d+|_restore)?\.parquet$/;

/** @param {string} name @returns {boolean} */
export function isWorkingFile(name) {
  return WORKING_FILE.test(String(name ?? ''));
}

/**
 * The source file a part or staging file belongs to, or the name itself.
 *
 * A part is live exactly when its SOURCE is: `ct_src_7_2__part3.parquet` belongs to
 * `ct_src_7_2.parquet`, and a dataset registers only the latter. Without this an active
 * wide dataset's parts would read as lost the moment a scan ran mid-ingest.
 *
 * @param {string} name
 * @returns {string}
 */
export function baseFileOf(name) {
  const m = /^(ct_src_\d+_\d+)(?:__part\d+|__merge\d+|_restore)\.parquet$/.exec(String(name ?? ''));
  return m ? `${m[1]}.parquet` : String(name ?? '');
}

/**
 * How many CrossTab sessions are open across this origin, including this one.
 *
 * `null` means "cannot tell" — an engine without Web Locks, or a query that threw — and a
 * caller must read it as unknown, never as one. The whole safety argument rests on this
 * number, so the unknown case has to be louder than the safe one.
 *
 * @param {{query?: Function}} [locks]
 * @returns {Promise<number|null>}
 */
export async function openSessions(locks = globalThis.navigator?.locks) {
  if (typeof locks?.query !== 'function') return null;
  try {
    const state = await locks.query();
    return (state?.held ?? []).filter((l) => l.name === TAB_LOCK).length;
  } catch {
    return null;
  }
}

/**
 * Hold this session's lock for as long as the page lives.
 *
 * Shared mode, so every tab gets one and none of them waits. The promise inside the
 * callback is never resolved on purpose: the lock is released by the browser when the
 * document goes away, which is the event we actually want to observe. Returns a function
 * that drops it, for tests — nothing in the app calls it.
 *
 * @param {{request?: Function}} [locks]
 * @returns {() => void}
 */
export function holdSessionLock(locks = globalThis.navigator?.locks) {
  if (typeof locks?.request !== 'function') return () => {};
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  // Not awaited: this resolves only when the lock is dropped.
  void Promise.resolve(locks.request(TAB_LOCK, { mode: 'shared' }, () => held)).catch(() => {});
  return release;
}

/**
 * Which of `names` are lost, given what this session is using.
 *
 * Pure, so the three rules can be read in one place and tested without a filesystem.
 *
 * @param {object} arg
 * @param {Iterable<{name: string, bytes?: number, modifiedAt?: number}>} arg.entries
 * @param {Iterable<string>} arg.live - working files this session's datasets hold
 * @param {number} arg.now - epoch ms, passed in rather than read, so a test is not a clock
 * @returns {Array<{name: string, bytes: number, modifiedAt: number}>}
 */
export function lostAmong({ entries, live, now }) {
  const owned = new Set(live ?? []);
  const out = [];
  for (const e of entries ?? []) {
    const name = String(e?.name ?? '');
    if (!isWorkingFile(name)) continue;
    if (owned.has(name) || owned.has(baseFileOf(name))) continue;
    const modifiedAt = Number(e?.modifiedAt) || 0;
    if (modifiedAt && now - modifiedAt < WARM_MS) continue;
    out.push({ name, bytes: Number(e?.bytes) || 0, modifiedAt });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/**
 * List the OPFS root, with each entry's size and mtime.
 *
 * Directories are skipped rather than walked: everything this collects is a loose file at
 * the root, and `projects/` is the one place a wrong answer would be unrecoverable.
 *
 * @param {object} [deps]
 * @returns {Promise<Array<{name: string, bytes: number, modifiedAt: number}>>}
 */
export async function listRoot({ getDirectory = () => globalThis.navigator?.storage?.getDirectory?.() } = {}) {
  const root = await getDirectory();
  if (!root) return [];
  const out = [];
  for await (const [name, handle] of root.entries()) {
    if (handle?.kind !== 'file') continue;
    try {
      const file = await handle.getFile();
      out.push({ name, bytes: file.size, modifiedAt: file.lastModified });
    } catch {
      // Unreadable means unknowable, and unknowable is never collected.
    }
  }
  return out;
}

/**
 * The whole scan: what is lost, how much it costs, and whether it may be deleted.
 *
 * `blocked` is the part callers must honour. It is not an error — the files are reported
 * either way, because knowing the bytes are there is useful on its own — but it says the
 * one condition that makes deletion safe could not be established.
 *
 * @param {object} arg
 * @param {Iterable<string>} arg.live
 * @param {number} [arg.now]
 * @param {object} [arg.deps] - injected for tests: `{listRoot, openSessions}`
 * @returns {Promise<{files: Array<{name, bytes, modifiedAt}>, bytes: number,
 *                    sessions: number|null, blocked: null|'other-tabs'|'unknown-sessions'}>}
 */
export async function scanLostFiles({ live = [], now = Date.now(), deps = {} } = {}) {
  const list = deps.listRoot ?? listRoot;
  const sessionsOf = deps.openSessions ?? openSessions;
  const [entries, sessions] = await Promise.all([list(), sessionsOf()]);
  const files = lostAmong({ entries, live, now });
  const bytes = files.reduce((t, f) => t + f.bytes, 0);
  let blocked = null;
  if (sessions == null) blocked = 'unknown-sessions';
  else if (sessions > 1) blocked = 'other-tabs';
  return { files, bytes, sessions, blocked };
}

/**
 * Delete the files a scan found, re-checking first.
 *
 * The re-scan is not belt and braces, it is the contract: a dialog sits open for as long as
 * someone reads it, and a tab opened in that time must cancel the delete. Only names that
 * are still lost at this instant are removed, so a stale list cannot take a live file with
 * it.
 *
 * @param {object} arg
 * @param {string[]} arg.names - what the user agreed to
 * @param {Iterable<string>} arg.live
 * @param {object} [arg.deps]
 * @returns {Promise<{removed: string[], bytes: number, blocked: string|null, failed: string[]}>}
 */
export async function deleteLostFiles({ names, live = [], now = Date.now(), deps = {} } = {}) {
  const scan = await scanLostFiles({ live, now, deps });
  if (scan.blocked) return { removed: [], bytes: 0, blocked: scan.blocked, failed: [] };
  const agreed = new Set(names ?? []);
  const doomed = scan.files.filter((f) => agreed.has(f.name));
  const getDirectory = deps.getDirectory ?? (() => globalThis.navigator?.storage?.getDirectory?.());
  const root = await getDirectory();
  const removed = [];
  const failed = [];
  let bytes = 0;
  for (const f of doomed) {
    try {
      await root.removeEntry(f.name);
      removed.push(f.name);
      bytes += f.bytes;
    } catch {
      failed.push(f.name);
    }
  }
  return { removed, bytes, blocked: null, failed };
}
