/**
 * @file project-locations.js
 * A registry of remembered project LOCATIONS (#143, #171) — where a project lives, so it
 * can be listed and reopened whether that is a picked folder, Dropbox or WebDAV.
 *
 * ## Why this is general rather than folder-specific
 *
 * It began as a registry of folders, and that is precisely why a project moved to Dropbox
 * vanished from the Projects list while one moved to a folder did not: folders had a
 * registry and remote had nothing. The obvious fix — a second registry for remote — would
 * have bought a third store, a third rendering, and a third copy of every project verb
 * (#167 wants rename/delete/duplicate on that list). So the thing that already worked was
 * generalised instead of duplicated.
 *
 * An entry is `{ id, kind, name, savedAt, handle?, config? }`:
 *  - `kind: 'folder'` carries a `FileSystemDirectoryHandle`, which is why this lives in
 *    IndexedDB at all — handles are structured-cloneable and `localStorage` is not.
 *  - `kind: 'dropbox' | 'webdav'` carries a plain `config` saying WHERE, never how to get
 *    in. See {@link PUBLIC_CONFIG}.
 *
 * **Entries written before this generalisation carry no `kind` and are folders**, so a
 * missing one reads as `'folder'`. No migration step, and nobody loses a remembered folder
 * on upgrade.
 *
 * Reconnecting a folder still needs `ensureReadWrite` from a user gesture: the browser
 * will not restore *write* permission silently. A remote location needs its credential
 * instead, which is the caller's job — this module never holds one.
 *
 * A step toward #171, not a substitute for it: the OPFS catalog is still a separate list,
 * and folding it in is the move that remains.
 */

// Names kept from when this held only folders. Renaming them would strand every
// remembered folder in a database nothing reads — a cosmetic gain for a real loss.
const DB_NAME = 'crosstab-folders';
const STORE = 'handles';
const REGISTRY_KEY = 'registry'; // { id, kind, name, savedAt, handle?, config? }[]

/**
 * What a remote location's `config` may contain — WHERE it is, never how to get in.
 *
 * ## Addresses, never credentials — and why storing nothing beats storing it safely
 *
 * A WebDAV app password is the keys to someone's whole cloud account; a Dropbox refresh
 * token is the same. So none of them is here. The address and the username are, and the
 * secret is typed each session.
 *
 * The alternative that looks better and is not: encrypt the stored credential behind a
 * passphrase. That trades one typed secret for another and buys nothing — *"if we're going
 * to be asking for a password to unlock the credential in the first place, that isn't much
 * different from simply not storing the credential and just asking for that"* (owner,
 * 2026-08-24). A lock whose key sits beside it is decoration.
 *
 * The guarantee is structural rather than a convention: a caller handing over the whole
 * object it used to build a driver is the likeliest slip, and it reads perfectly well at
 * the call site. Projecting through this list means such a call stores the address and
 * drops the secret, and no path here can write a password or a token unless someone adds
 * the field deliberately.
 *
 * This is a different question from at-rest encryption. That passphrase protects the DATA
 * in a project; a credential protects an ACCOUNT that happens to hold it. Neither excuses
 * skipping the other.
 */
// The INNER arrays are frozen too. `Object.freeze` is shallow, so freezing only the
// outer object leaves every list push-able — and a single `PUBLIC_CONFIG.dropbox.push`
// anywhere would silently widen what this module is allowed to store, for the rest of the
// session, with the doc comment above still claiming otherwise. Caught by a test that
// asserted the push would throw, and then watched a later test see the token it had added.
export const PUBLIC_CONFIG = Object.freeze({
  dropbox: Object.freeze(['appKey', 'basePath']),
  webdav: Object.freeze(['url', 'username']),
});

/** A config reduced to the fields its kind may remember. Exported to be tested: the
 * property that no secret reaches storage is the one worth pinning. */
export function publicConfig(kind, config) {
  const allowed = PUBLIC_CONFIG[kind] ?? [];
  const out = {};
  for (const f of allowed) if (config?.[f] != null) out[f] = String(config[f]);
  return out;
}

/** What makes two remote locations "the same place", for dedup. */
export const remoteKey = (kind, config) => kind + ':' + JSON.stringify(publicConfig(kind, config));

/** An entry as callers see it — `kind` filled in for pre-generalisation rows. */
export const normalizeEntry = (e) => ({ ...e, kind: (e && e.kind) || 'folder' });
const normalize = normalizeEntry;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, val) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

async function readRegistry() {
  const db = await openDb();
  try {
    const arr = await idbGet(db, REGISTRY_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function writeRegistry(arr) {
  const db = await openDb();
  try { await idbPut(db, REGISTRY_KEY, arr); } finally { db.close(); }
}

/**
 * Remember (or update) a folder project. Dedupes by `isSameEntry`, so re-saving the same
 * folder refreshes its name and time rather than stacking a duplicate.
 *
 * **`savedAt` is stamped only when the caller passes one**, which it does after a WRITE.
 * It used to be stamped on every call — and the only caller was the open path, so for a
 * folder project `savedAt` silently meant "last opened", contradicting this file's own
 * description of it. Project lists are ordered and labelled by it as *last worked on*, so
 * an open that stamped it made merely looking at a project indistinguishable from working
 * on one (owner, 2026-10-10).
 *
 * `lastOpenedAt` is still stamped every time, and is deliberately kept even though nothing
 * currently reads it: it is the cheap half of a possible "sort by recently opened" that
 * every OS file manager and M365's home page offers, and it cannot be backfilled later.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {{name?: string, savedAt?: number, datasetCount?: number, rowCount?: number}} [meta]
 * @returns {Promise<string>} the registry entry id
 */
export async function rememberFolder(handle, meta = {}) {
  const { name, savedAt } = meta;
  const reg = await readRegistry();
  for (const e of reg) {
    try {
      if (e.handle && (await e.handle.isSameEntry(handle))) {
        e.handle = handle; // refresh the handle (permissions/identity)
        e.kind = 'folder';
        if (name != null) e.name = name;
        if (savedAt != null) e.savedAt = savedAt;
        applyStats(e, meta);
        e.lastOpenedAt = Date.now();
        await writeRegistry(reg);
        return e.id;
      }
    } catch { /* stale handle — skip */ }
  }
  const id = globalThis.crypto.randomUUID();
  const entry = {
    id, kind: 'folder', handle, name: name ?? handle.name,
    savedAt: savedAt ?? Date.now(), lastOpenedAt: Date.now(),
  };
  applyStats(entry, meta);
  reg.push(entry);
  await writeRegistry(reg);
  return id;
}

/**
 * Carry a project's size onto its registry entry.
 *
 * A remembered location has no readable manifest from a list — reaching the folder needs a
 * permission gesture, which a list cannot ask for. But CrossTab writes this entry while the
 * project is OPEN and every dataset is in memory, so the numbers are free at exactly the
 * moment they are knowable. Recording them here is the same move as stamping `kindProvider`
 * on a chart at write time: ask while the thing that knows is still there.
 *
 * Only ever overwrites with a real number, so a caller that does not know (an open, a
 * rename) leaves the last known size standing rather than blanking it.
 */
function applyStats(entry, { datasetCount, rowCount } = {}) {
  if (Number.isFinite(datasetCount)) entry.datasetCount = datasetCount;
  if (Number.isFinite(rowCount)) entry.rowCount = rowCount;
}

/**
 * Remember (or update) a remote project location.
 *
 * Dedupes on the address, so reopening the same Dropbox folder refreshes its entry rather
 * than adding one per visit — while two different folders on the same account stay two
 * entries, which is the whole point of listing them.
 *
 * @param {'dropbox'|'webdav'} kind
 * @param {object} config  projected through {@link PUBLIC_CONFIG}; secrets are dropped
 * @param {{name?: string, savedAt?: number, datasetCount?: number, rowCount?: number}} [meta]
 * @returns {Promise<string|null>} the entry id, or null for an unknown kind
 */
export async function rememberRemote(kind, config, meta = {}) {
  const { name, savedAt } = meta;
  if (!PUBLIC_CONFIG[kind]) return null;
  const cfg = publicConfig(kind, config);
  const key = remoteKey(kind, cfg);
  const reg = await readRegistry();
  const found = reg.find((e) => e.kind === kind && remoteKey(e.kind, e.config) === key);
  const entry = found || { id: globalThis.crypto.randomUUID(), kind };
  entry.config = cfg;
  if (name != null) entry.name = name;
  entry.name = entry.name || kind;
  // Only on a write — see rememberFolder. A new entry gets one so it is never undefined.
  if (savedAt != null) entry.savedAt = savedAt;
  else if (!found) entry.savedAt = Date.now();
  applyStats(entry, meta);
  // Every successful open re-remembers, so for a remote location this is genuinely "last
  // opened", where `savedAt` means the last time we WROTE.
  entry.lastOpenedAt = Date.now();
  if (!found) reg.push(entry);
  await writeRegistry(reg);
  return entry.id;
}

/** All remembered locations, most recently WORKED ON first, whatever their kind.
 * (`savedAt`, not `lastOpenedAt` — see rememberFolder for why opening must not reorder.) */
export async function listLocations() {
  return (await readRegistry())
    .map(normalize)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Only the folder ones — for callers that genuinely mean folders. */
export async function listFolders() {
  return (await listLocations()).filter((e) => e.kind === 'folder');
}

/** Forget a location. Never touches what it points at — just the entry. */
export async function forgetLocation(id) {
  const reg = await readRegistry();
  await writeRegistry(reg.filter((e) => e.id !== id));
}

/** @deprecated Use {@link forgetLocation}. Kept while call sites migrate. */
export const forgetFolder = forgetLocation;

/**
 * Ensure the handle has read-write permission, prompting if needed. Returns true if
 * granted. `requestPermission` requires a user gesture — call from a click handler.
 * @param {FileSystemHandle} handle
 * @returns {Promise<boolean>}
 */
export async function ensureReadWrite(handle) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
