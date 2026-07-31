/**
 * @file folder-handle.js
 * Persist the picked folder handle for a folder-backed project (#143), and re-grant
 * write permission on return.
 *
 * `FileSystemDirectoryHandle`s are **structured-cloneable**, so they can be stored
 * in IndexedDB and survive a reload — the user picks their OneDrive/Dropbox/local
 * folder once, not every session. The browser will NOT restore *write* permission
 * silently, though: on return you must call `requestPermission({mode:'readwrite'})`
 * from a user gesture (one click). `queryPermission` first avoids re-prompting when
 * it's already granted this session.
 *
 * Small and dependency-free; the IndexedDB round-trip is verifiable in-browser.
 */

const DB_NAME = 'crosstab-folders';
const STORE = 'handles';
const KEY = 'projectFolder';

/** Open (or create) the tiny handle DB. */
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

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Persist the picked folder handle (overwrites any previous one). */
export async function saveFolderHandle(handle, key = KEY) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').put(handle, key);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Retrieve the persisted folder handle, or null if none stored. */
export async function loadFolderHandle(key = KEY) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Forget the persisted folder handle (e.g. the user closes the folder project). */
export async function clearFolderHandle(key = KEY) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').delete(key);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Ensure the handle has read-write permission, prompting if needed. Returns true
 * if granted. `requestPermission` requires a user gesture, so call this from a
 * click handler (e.g. the "reconnect folder" button on return).
 *
 * @param {FileSystemHandle} handle
 * @returns {Promise<boolean>}
 */
export async function ensureReadWrite(handle) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
