/**
 * @file folder-handle.js
 * A small **registry of remembered folder projects** (#143), so folder-backed
 * projects are first-class: listed and reopenable in both the launcher and the
 * in-app sidebar, with a one-click reconnect and an explicit "forget".
 *
 * `FileSystemDirectoryHandle`s are structured-cloneable, so we persist them (with a
 * display name + last-saved time) in IndexedDB and they survive a reload — pick a
 * folder once, reopen it from a list thereafter. The browser will NOT restore *write*
 * permission silently, though: reconnecting must call `ensureReadWrite` from a user
 * gesture (one click). Multiple folders are supported (dedup by `isSameEntry`).
 */

const DB_NAME = 'crosstab-folders';
const STORE = 'handles';
const REGISTRY_KEY = 'registry'; // an array of { id, handle, name, savedAt }

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
 * Remember (or update) a folder project. Dedupes by `isSameEntry`, so re-saving the
 * same folder updates its name/time rather than adding a duplicate.
 * @param {FileSystemDirectoryHandle} handle
 * @param {{name?: string, savedAt?: number}} [meta]
 * @returns {Promise<string>} the registry entry id
 */
export async function rememberFolder(handle, { name, savedAt } = {}) {
  const reg = await readRegistry();
  for (const e of reg) {
    try {
      if (e.handle && (await e.handle.isSameEntry(handle))) {
        e.handle = handle; // refresh the handle (permissions/identity)
        if (name != null) e.name = name;
        e.savedAt = savedAt ?? Date.now();
        await writeRegistry(reg);
        return e.id;
      }
    } catch { /* stale handle — skip */ }
  }
  const id = globalThis.crypto.randomUUID();
  reg.push({ id, handle, name: name ?? handle.name, savedAt: savedAt ?? Date.now() });
  await writeRegistry(reg);
  return id;
}

/** All remembered folder projects, most-recent first. */
export async function listFolders() {
  return (await readRegistry()).slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Forget a remembered folder (does NOT touch the folder's files — just the entry). */
export async function forgetFolder(id) {
  const reg = await readRegistry();
  await writeRegistry(reg.filter((e) => e.id !== id));
}

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
