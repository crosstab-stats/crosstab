/**
 * @file project-store.js
 * Persistent **projects** — the top tier of the two-tier model.
 *
 * A *project* is the whole working set: every open dataset (each its own
 * immutable sources + transform log) plus which one is active. It's a living
 * document — saved as one self-contained bundle and autosaved as you work. (The
 *
 *   projects/
 *     catalog.json                 — the browse index (one summary per project)
 *     crosstab-encryption.json     — plaintext salt/verifier (only when encrypted)
 *     <projectId>/
 *       project.json               — { name, savedAt, activeId, log:[…ops], … } (#148:
 *                                    ONE flat op-log spanning every tier; no base sidecar)
 *       src_<opId>.parquet          — each source op's immutable bytes, keyed by op id
 *
 * Bytes live behind a swappable {@link StorageDriver} (OPFS by default, or a picked
 * folder mirrored to OneDrive/Dropbox — {@link ProjectStore#useDirectory}), so the
 * *where* is one implementation and a future cloud-API driver reuses the same seam.
 * At-rest **encryption** ({@link ProjectStore#unlock}) sits ABOVE the driver: bytes
 * are enciphered before `write` and deciphered after `read`, so a driver — even an
 * untrusted provider — only ever sees ciphertext (#143/#144).
 */

import { OpfsDriver, FsaFolderDriver, capabilitiesOf } from './storage-driver.js';
import { deriveKey, encryptWithKey, decryptWithKey, isEnveloped, newSalt, DEFAULT_ITERATIONS } from './crypto-envelope.js';
import { liveOps } from './op-log.js';

const ROOT = 'projects';

/**
 * Write queues for drivers that declare `sharedRoot` — keyed by the storage they share, so
 * every ProjectStore built over the same root serialises against the others. Module level
 * because that is the scope the sharing has: per-instance state cannot see a sibling.
 */
const SHARED_TAILS = new Map();
const CATALOG = 'catalog.json';
/** How long a catalog write waits for more changes. Long enough that a burst of
 * autosaves writes once, short enough that the index is right by the time anyone has
 * navigated anywhere to look at it. */
const CATALOG_FLUSH_MS = 400;
/** A pending catalog change that removes the entry. */
const REMOVED = Symbol('catalog-entry-removed');

/**
 * Every file name a manifest's log points at: source Parquet and asset blobs.
 *
 * One reader for both, because the sweep and the integrity check have to agree about
 * what "referenced" means — two slightly different answers would show a file as garbage
 * in one and as healthy in the other.
 */
export function manifestRefs(manifest) {
  const out = new Set();
  for (const op of manifest?.log ?? []) {
    if (isSourceOp(op) && op.payload?.src?.file) out.add(op.payload.src.file);
    else if (op.type === 'addAsset' && op.payload?.id) out.add(`${ASSET_DIR}/${safeAssetId(op.payload.id)}.bin`);
  }
  return out;
}

/**
 * The source files this manifest says are DEAD — positive evidence, not absence.
 *
 * A source op carries `src.file` only while it is live: `rawExport` sets it from
 * `#steps()`, the live fold, so an op that was retracted, undone, or left behind a
 * `replace` barrier is persisted **byte-less on purpose** — the envelope stays for audit
 * and merge, and `buildManifest` says as much ("byte-less (retracted) sources have
 * none"). The sidecar name is derived from the stable op id, so a dead op still names
 * the file it used to own.
 *
 * That is what makes this safe where a set difference was not. A file whose op is not in
 * this log at all — a peer's, another tab's — yields no evidence and is never returned,
 * so it cannot be deleted by a manifest that simply does not know about it.
 */
export function deadSourceFiles(manifest) {
  const out = new Set();
  for (const op of manifest?.log ?? []) {
    if (!isSourceOp(op) || !op.id) continue;
    if (op.payload?.src?.file) continue; // live: it names its bytes
    out.add(`src_${op.id}.parquet`);
  }
  return out;
}

/** Do two summaries say the same thing? Compared field by field rather than by
 * stringifying, because key ORDER would otherwise decide whether the index looked
 * stale, and `undefined` and absent have to read as the same. */
function sameSummary(a, b) {
  const fields = ['name', 'savedAt', 'datasetCount', 'rowCount', 'lastOpenedAt'];
  for (const f of fields) if ((a?.[f] ?? null) !== (b?.[f] ?? null)) return false;
  const pa = a?.activePlugins ?? null;
  const pb = b?.activePlugins ?? null;
  if (Array.isArray(pa) && Array.isArray(pb)) {
    return pa.length === pb.length && pa.every((x, i) => x === pb[i]);
  }
  return pa === pb;
}

/**
 * Combine two pending changes to the same entry, oldest first.
 *
 * They must COMPOSE rather than the later one replacing the earlier, because each patch
 * computes its carried fields from the entry it is handed — and if that is the entry on
 * DISK, everything the earlier patch did is invisible to it. Open a project (a deferred
 * `lastOpenedAt`) and then autosave it, and the save would carry `lastOpenedAt` from a
 * disk entry that did not have it yet, putting "recent" back to meaning "recently saved".
 *
 * @param {Function|symbol|undefined} older
 * @param {Function|symbol} newer
 */
function composePatch(older, newer) {
  if (!older || newer === REMOVED) return newer;
  // Removed and then written again — a delete followed by a save of the same id. The
  // new entry is built from nothing, not from the one that was removed.
  if (older === REMOVED) return (prev) => newer(undefined);
  return (prev) => {
    const mid = older(prev);
    // A patch that declines (returns null) leaves the entry as it was for the next one —
    // `markOpened` on a project with no entry must not stop a save from creating one.
    return newer(mid ?? prev) ?? mid;
  };
}

/** Subdirectory holding media asset bytes inside a project (`assets/<id>.bin`). */
const ASSET_DIR = 'assets';

/** Asset ids are content hashes (lowercase hex); strip anything else so a crafted ref
 * can never escape the project directory. */
const safeAssetId = (id) => String(id).replace(/[^a-f0-9]/gi, '');

/** Source op types — their bytes are written as Parquet sidecars; every other op is a
 * light transform stored inline in the manifest. Mirrors data-store's SOURCE_OPS. */
const SOURCE_TYPES = new Set(['load', 'append', 'join']);
const isSourceOp = (op) => SOURCE_TYPES.has(op?.type);
const ENC_META = 'crosstab-encryption.json'; // plaintext salt/verifier/epoch for the folder
/** A fresh key-epoch id — see {@link ProjectStore#keyStatus}. */
const newEpoch = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2));
/**
 * Is this one of CrossTab's source Parquet files?
 *
 * Exported and used everywhere the question is asked — the save sweep, the
 * occupied-destination check, and the delete-files path. It was previously open-coded in
 * the sweep and hand-written from a STALE DOC COMMENT elsewhere (`ds<id>_src<n>.parquet`,
 * a naming this code has not used for a long time), so the delete path silently matched
 * nothing and left every source file behind.
 */
export const isSourceFile = (name) => typeof name === 'string' && name.startsWith('src_') && name.endsWith('.parquet');

const MARKER = 'crosstab-project.json'; // plaintext "this folder IS a CrossTab project" + display name
const VERIFIER = 'crosstab-folder-v1'; // known token, encrypted, to check a passphrase on unlock

/** In flat (folder) mode there's exactly one project and the id is vestigial — this
 * stands in wherever the id-centric API needs one. */
export const FOLDER_PROJECT_ID = '.';

/** Live dataset count folded from the flat log's collection ops — the catalog summary
 * the launcher shows without loading the whole project. Goes through the shared liveness
 * fold, so an UNDONE `addDataset` doesn't count (#149 C3); `removeDataset` (binned) and
 * `purgeDataset` both take one out. Mirrors DatasetManager's COLLECTION projection —
 * they must agree, or the launcher advertises a dataset count the project doesn't have. */
function countDatasets(manifest) {
  const ids = new Set();
  for (const op of liveOps(manifest?.log ?? [])) {
    if (op.type === 'addDataset') ids.add(op.payload?.id);
    else if (op.type === 'removeDataset' || op.type === 'purgeDataset') ids.delete(op.payload?.id);
  }
  return ids.size;
}

const te = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class ProjectStore {
  /** Serialises catalog read-modify-write ops so an autosave can't interleave
   * with a delete/rename and resurrect a just-removed entry (orphan in the list). */
  #tail = Promise.resolve();

  /**
   * Catalog changes not yet on disk: `id` → a function of that id's current entry, or
   * {@link REMOVED}.
   *
   * A FUNCTION rather than a finished entry, because the whole point of holding them is
   * that they are applied later, against a catalog that may have moved on. A patch reads
   * `lastOpenedAt` and a carried `rowCount` off whatever is actually on disk at flush
   * time, so a second tab stamping "opened" is merged rather than overwritten by a
   * summary that was built before it happened.
   * @type {Map<string, Function|symbol>}
   */
  #pendingCatalog = new Map();

  /** The scheduled flush, so a burst of autosaves writes the catalog once. */
  #flushTimer = null;

  /** Ids whose catalog entry this session has already put on disk. The FIRST save of a
   * project flushes immediately, because that is when the entry may need CREATING and a
   * creation is the one change that cannot be reconstructed cheaply: `list()` can
   * recover a folder the catalog has no record of, but only by reading its manifest, so
   * a catalog missing many entries turns one listing into that many reads. Writing a
   * creation at once keeps recovery an exceptional path rather than the normal one. */
  #onDisk = new Set();

  constructor() {
    // The last moment a deferred write can happen. `pagehide` rather than
    // `beforeunload`, which does not fire reliably on mobile, and rather than `unload`,
    // which is deprecated and disqualifies the page from the back-forward cache.
    // `visibilitychange` catches the tab being switched away from, which on mobile is
    // often the only warning there is.
    //
    // Best-effort by construction: the browser does not wait for an async flush. That is
    // the reason only UPDATES defer — a lost one costs a slightly stale `savedAt` in the
    // list, while the project's own bytes were written long before. Creations, renames
    // and deletions never defer, so none of them depends on this firing.
    if (typeof addEventListener === 'function') {
      const onExit = () => { void this.flushCatalog(); };
      addEventListener('pagehide', onExit);
      addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onExit();
      });
    }
  }

  /** The byte backend (see {@link module:core/storage-driver}). OPFS by default;
   * {@link ProjectStore#useDirectory} swaps in a picked folder. */
  #driver = new OpfsDriver();

  /** AES-GCM master key for at-rest encryption, or null (plaintext). Set by
   * {@link ProjectStore#unlock}; never persisted. When set, every data file
   * (`project.json`, the Parquet sources, the asset blobs) is written as a ciphertext
   * envelope and decrypted on read — so a driver / cloud provider that mirrors the
   * folder only ever sees ciphertext. The salt + a verifier live plaintext in
   * `crosstab-encryption.json` (a salt isn't secret). The catalog is always
   * plaintext (it spans projects, which in OPFS mode can each have a DIFFERENT key). */
  #key = null;
  /** The `epoch` of the meta this key was derived against (#144). A shared folder's
   * protection can change under a peer that is already connected; the epoch is how that
   * peer notices before it writes ciphertext nobody else can read. @type {string|null} */
  #keyEpoch = null;

  /** Which project id {@link #key} belongs to. In nested (OPFS) mode each project
   * can carry its own passphrase, so a save must never encrypt one project's bytes
   * with another's key (that would make it permanently unopenable) — {@link #save}
   * guards on this. Flat mode has one project, so it's always FOLDER_PROJECT_ID. */
  #keyId = null;

  /**
   * The key the folder was using BEFORE an unfinished rekey, so files not yet rewritten
   * are still readable. Held only between {@link ProjectStore#changePassphrase} and
   * {@link ProjectStore#finishRekey}; see `#readRaw` for how it is used and the meta's
   * `prev` block for how a crash in between is survivable.
   */
  #prevKey = null;

  /** Whether the meta still describes a previous keying (an unfinished rekey). */
  #rekeyPending = false;

  /** **Flat, single-project layout** — for folder mode. The picked folder IS the
   * project: files live directly in it (`project.json`, `src_<opId>.parquet`,
   * `crosstab-encryption.json`, a `crosstab-project.json` marker) with NO `projects/`
   * prefix, NO per-project id subdir, and NO catalog. OPFS keeps its nested
   * multi-project layout. So "a project is a folder" (like a Logic/git/.app bundle). */
  #flat = false;

  /** Point the store at a picked folder (a OneDrive/Dropbox/local folder the OS sync
   * client mirrors) — the folder itself is the project (flat layout). Null reverts to
   * OPFS (nested multi-project). The caller must have re-granted write permission
   * (`requestPermission`) first — the browser won't give silent persistent write. */
  useDirectory(handle) {
    this.#driver = handle ? new FsaFolderDriver(handle) : new OpfsDriver();
    this.#flat = !!handle;
  }

  /** Swap in an arbitrary storage driver (the general seam — e.g. a future cloud
   * driver, also one-project-per-location → flat). Null resets to OPFS. */
  useDriver(driver, { flat } = {}) {
    this.#driver = driver ?? new OpfsDriver();
    // The driver declares its own layout; the option is an override for a caller that
    // knows better. Defaulting to `true` regardless of what the driver said was how the
    // layout and the behaviour came apart in the first place.
    this.#flat = driver ? (flat ?? capabilitiesOf(driver).flat) : false;
  }

  /** What the current driver can do (defaults filled in). */
  get capabilities() {
    return capabilitiesOf(this.#driver);
  }

  /** Path of a project file, respecting the layout. Flat (folder): the bare name.
   * Nested (OPFS): `projects/<id>/<name>`. */
  #path(id, name) {
    return this.#flat ? name : `${ROOT}/${id}/${name}`;
  }

  /** Path of the plaintext encryption meta (salt/verifier). Per-project in nested
   * (OPFS) mode so every project can carry its OWN passphrase (the shared-lab case);
   * flat (folder) mode has exactly one project, so the id is vestigial. */
  #metaPath(id = FOLDER_PROJECT_ID) {
    return this.#flat ? ENC_META : `${ROOT}/${id}/${ENC_META}`;
  }

  /**
   * Flat layout: one project at this location, files at the root, no catalog.
   *
   * This replaces a `kind === 'folder'` test, which asked the driver WHO IT WAS rather
   * than what it does. The two answers had already diverged: a driver injected through
   * {@link ProjectStore#useDriver} got `#flat` from the option and `folderBacked` from
   * its name, so it would have been laid out flat and then treated as nested — the
   * cloud case, i.e. the reason the seam exists.
   *
   * Everything that used to ask "is this a folder?" — layout, the encryption key id,
   * whether the launcher is already in — was really asking this.
   */
  get flat() {
    return this.#flat;
  }

  get available() {
    return this.#driver.available;
  }

  /** @returns {boolean} Whether at-rest encryption is currently on. */
  get encrypted() {
    return this.#key != null;
  }

  /**
   * Turn on at-rest encryption with a passphrase. On first use for a folder this
   * mints + stores a public salt and a verifier; afterwards it checks the passphrase
   * against that verifier and throws on mismatch (so the user learns immediately,
   * not on the first corrupt read). The derived key is held in memory only —
   * **a forgotten passphrase is unrecoverable** (no server, by design).
   * @param {string} passphrase
   */
  async unlock(passphrase, id = FOLDER_PROJECT_ID) {
    // The salt/verifier meta is plaintext — read/write it via the driver DIRECTLY,
    // bypassing the crypto wrappers (chicken-and-egg: we need it to derive the key).
    const metaPath = this.#metaPath(id);
    let meta = null;
    const rawMeta = await this.#driver.read(metaPath);
    if (rawMeta) { try { meta = JSON.parse(new TextDecoder().decode(rawMeta)); } catch { meta = null; } }

    const salt = meta ? unb64(meta.salt) : newSalt();
    const iterations = meta?.iterations || DEFAULT_ITERATIONS;
    const key = await deriveKey(passphrase, salt, iterations);

    if (meta?.verifier) {
      let ok = false;
      try { ok = new TextDecoder().decode(await decryptWithKey(key, unb64(meta.verifier))) === VERIFIER; } catch { ok = false; }
      if (!ok) {
        // A rekey that was interrupted leaves BOTH keyings described. Accept the old
        // passphrase too, so someone who only knows the previous one is not locked out
        // of their own folder by a half-finished operation — they can still read
        // everything, because the not-yet-rewritten files are the ones it opens.
        const prevOk = meta.prev ? await this.#tryPrev(passphrase, meta, id) : false;
        if (!prevOk) throw new Error('Wrong passphrase for this project.');
        return;
      }
      // Right passphrase, but a rekey never finished: keep the old key alongside so the
      // files that were not rewritten still open. It can only be derived from the old
      // passphrase, which we may not have — `#readRaw` simply fails on those until
      // `resumeRekey` supplies it.
      this.#rekeyPending = !!meta.prev;
    } else {
      const verifier = b64(await encryptWithKey(key, VERIFIER));
      // `epoch` identifies THIS keying of the folder (#144). A random id, not a counter:
      // two peers who rekey concurrently would both write "2", and the whole point is
      // that any difference must be detectable. Meta written before the epoch existed
      // reads as null, which compares equal to itself and so never false-alarms.
      meta = { v: 1, salt: b64(salt), iterations, verifier, epoch: newEpoch() };
      await this.#driver.write(metaPath, te.encode(JSON.stringify(meta)));
    }
    this.#key = key;
    this.#keyId = id;
    this.#keyEpoch = meta?.epoch ?? null;
  }


  /**
   * Was the last rekey left unfinished? True between a `changePassphrase` that wrote the
   * transitional meta and the `finishRekey` that clears it — including across a reload,
   * because the state lives in the meta's `prev` block, not in memory.
   */
  get rekeyPending() { return !!this.#rekeyPending; }

  /** Try `passphrase` against the meta's PREVIOUS keying; adopt it as the live key if
   * it matches, so a half-rekeyed folder still opens for whoever holds the old secret. */
  async #tryPrev(passphrase, meta, id) {
    try {
      const salt = unb64(meta.prev.salt);
      const iterations = meta.prev.iterations || DEFAULT_ITERATIONS;
      const key = await deriveKey(passphrase, salt, iterations);
      const ok = new TextDecoder().decode(await decryptWithKey(key, unb64(meta.prev.verifier))) === VERIFIER;
      if (!ok) return false;
      this.#key = key;
      this.#keyId = id;
      this.#keyEpoch = meta.epoch ?? null;
      this.#rekeyPending = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Change a protected project's passphrase in ONE step.
   *
   * The reason this exists rather than "unprotect, then protect": that sequence writes
   * every file back to disk in the CLEAR in between. On a synced folder those plaintext
   * bytes reach the cloud, and the operation whose entire purpose is to improve
   * confidentiality briefly destroys it.
   *
   * Crash safety is the whole design. The caller rewrites every file after this returns,
   * which cannot be atomic on any driver we have, so the meta describes BOTH keyings for
   * the duration:
   *
   *   { salt, verifier, epoch, prev: { salt, verifier, iterations } }
   *
   * Written BEFORE the rewrite starts, so an interrupted rekey is always recoverable:
   * files carry a mix of the two keys, and either passphrase opens the folder — `unlock`
   * accepts both, and `#readRaw` falls back to the old key for anything not yet
   * rewritten. {@link ProjectStore#finishRekey} drops `prev` once the rewrite lands.
   *
   * The epoch changes here, so connected peers detect the rekey through the ordinary
   * `keyStatus` path with no extra signalling.
   *
   * @param {string} oldPass @param {string} newPass @param {string} [id]
   */
  async changePassphrase(oldPass, newPass, id = FOLDER_PROJECT_ID) {
    if (!newPass) throw new Error('changePassphrase: empty new passphrase');
    const metaPath = this.#metaPath(id);
    const rawMeta = await this.#driver.read(metaPath);
    if (!rawMeta) throw new Error('This project isn’t protected — there is no passphrase to change.');
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(rawMeta)); } catch { throw new Error('This project’s encryption settings could not be read.'); }

    // Verify the OLD passphrase against what is on disk rather than trusting the
    // in-memory key: the person changing it must prove they know the current one.
    const oldSalt = unb64(meta.salt);
    const oldIter = meta.iterations || DEFAULT_ITERATIONS;
    const oldKey = await deriveKey(oldPass, oldSalt, oldIter);
    let ok = false;
    try { ok = new TextDecoder().decode(await decryptWithKey(oldKey, unb64(meta.verifier))) === VERIFIER; } catch { ok = false; }
    if (!ok) throw new Error('That isn’t the current passphrase.');

    const salt = newSalt();
    const iterations = DEFAULT_ITERATIONS;
    const key = await deriveKey(newPass, salt, iterations);
    const verifier = b64(await encryptWithKey(key, VERIFIER));
    const next = {
      v: 1, salt: b64(salt), iterations, verifier, epoch: newEpoch(),
      prev: { salt: meta.salt, iterations: oldIter, verifier: meta.verifier },
    };
    await this.#driver.write(metaPath, te.encode(JSON.stringify(next)));

    this.#key = key;
    this.#prevKey = oldKey;
    this.#keyId = id;
    this.#keyEpoch = next.epoch;
    this.#rekeyPending = true;
  }

  /**
   * Drop the transitional `prev` keying once every file has been rewritten under the new
   * key. Until this runs the old passphrase still opens the folder, which is the point —
   * so calling it before the rewrite finishes would strand the un-rewritten files.
   */
  async finishRekey(id = FOLDER_PROJECT_ID) {
    const metaPath = this.#metaPath(id);
    const raw = await this.#driver.read(metaPath);
    if (!raw) return;
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(raw)); } catch { return; }
    if (!meta.prev) { this.#prevKey = null; this.#rekeyPending = false; return; }
    delete meta.prev;
    await this.#driver.write(metaPath, te.encode(JSON.stringify(meta)));
    this.#prevKey = null;
    this.#rekeyPending = false;
  }

  /** Drop the in-memory key (e.g. closing a project, or before switching to another). */
  lock() {
    this.#key = null;
    this.#keyId = null;
    this.#keyEpoch = null;
    this.#prevKey = null;
  }

  /**
   * Is the key we hold still the folder's current one? (#144)
   *
   * A shared folder's protection can be changed by whoever owns it — Protect, Remove
   * protection, or a passphrase change — and every other peer keeps whatever key it
   * derived when it opened. Writing with that stale key produces files the rest of the
   * team cannot read, and it happens exactly when the data's confidentiality is what is
   * being changed. There was no way to notice: the meta is read once, at unlock.
   *
   * Cheap enough to call before every folder write — one small plaintext read.
   *
   * @returns {Promise<{current: boolean, reason: 'ok'|'rekeyed'|'unprotected'|'protected'}>}
   */
  async keyStatus(id = FOLDER_PROJECT_ID) {
    const raw = await this.#driver.read(this.#metaPath(id));
    if (!raw) {
      // Meta gone: the folder was unprotected while we were connected. Our key is now
      // wrong in the other direction — we would write ciphertext into a plaintext folder.
      return { current: !this.#key, reason: this.#key ? 'unprotected' : 'ok' };
    }
    let meta = null;
    try {
      meta = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      // A meta that EXISTS but will not parse is not "fine" — it is most likely being
      // rewritten right now, and a rekey is exactly when that happens (the owner writes
      // this file, then re-encrypts every other one). Answering "ok" here let a peer
      // sail past the guard mid-rekey and write with a stale key. Unknown is not ok.
      return { current: false, reason: 'unreadable' };
    }
    if (!this.#key) return { current: false, reason: 'protected' }; // protection turned ON under us
    const epoch = meta?.epoch ?? null;
    if (epoch === this.#keyEpoch) return { current: true, reason: 'ok' };
    return { current: false, reason: 'rekeyed' };
  }

  /**
   * Remove at-rest protection: delete the project's encryption meta and drop the
   * key. The caller MUST re-save the bundle afterwards so its files are rewritten
   * plaintext (this removes only the salt/verifier + key, not the ciphertext).
   * @param {string} [id]
   */
  async removeEncryption(id = FOLDER_PROJECT_ID) {
    await this.#driver.remove(this.#metaPath(id));
    this.lock();
  }

  /** @returns {Promise<boolean>} Whether a given project already has encryption set
   * up (its `crosstab-encryption.json` present) — so an open flow knows to *enter* an
   * existing passphrase vs *set* a new one. Per-project in nested (OPFS) mode. */
  /**
   * Does this location already hold CrossTab files — a project, or the remains of one?
   *
   * Broader than "is there a project here" on purpose. A folder can contain source Parquet
   * with no manifest (an interrupted move, a half-deleted project), and that reads as EMPTY
   * to a manifest check. Moving in then succeeded, and the save sweep — which removes
   * source files the manifest does not claim — quietly ate them.
   *
   * Only ever looks for OUR files. Someone else's documents in the same folder are not
   * occupancy and are none of our business.
   */
  async looksOccupied(id = FOLDER_PROJECT_ID) {
    if (await this.hasEncryption(id)) return 'a protected project';
    if ((await this.list()).length) return 'a project';
    try {
      const here = await this.#driver.list(this.#flat ? '' : `${ROOT}/${id}`);
      if (here.some(isSourceFile)) return 'data files from a CrossTab project';
      if (here.includes(MARKER)) return 'a CrossTab project marker';
    } catch { /* unreadable — the checks above are what matter */ }
    return null;
  }

  async hasEncryption(id = FOLDER_PROJECT_ID) {
    return !!(await this.#driver.read(this.#metaPath(id)));
  }

  /** Acquire the mutex; returns a release fn. */
  async #acquire() {
    // A driver whose instances address the same bytes needs ONE queue between them, not one
    // each. OPFS is that case: the open project autosaves through its own store while the
    // project list reads through a second, and both rewrite `projects/catalog.json` by
    // temp-then-rename. Two per-instance queues let those interleave, and the loser got
    // "A FileSystemHandle cannot be moved while it is locked" — found the first time a
    // dataset copy was written while an autosave was in flight (2026-10-02).
    const shared = this.capabilities.sharedRoot ? `${this.#driver.kind}:${ROOT}` : null;
    const prev = shared ? (SHARED_TAILS.get(shared) ?? Promise.resolve()) : this.#tail;
    let release;
    const mine = new Promise((r) => {
      release = r;
    });
    if (shared) SHARED_TAILS.set(shared, mine);
    else this.#tail = mine;
    await prev;
    return release;
  }

  /** Project summaries, newest first. Self-heals: drops catalog entries whose
   * bundle folder is missing (e.g. left by an old race) so the manager never
   * lists a project that can't be opened. */
  async list() {
    // Flat (folder) mode: exactly one project, derived from its manifest (no catalog).
    if (this.#flat) {
      const m = await this.readManifest(FOLDER_PROJECT_ID);
      return m
        ? [{
          id: FOLDER_PROJECT_ID, name: m.name, savedAt: m.savedAt,
          datasetCount: countDatasets(m), rowCount: m.rowCount,
          activePlugins: m.activePlugins ?? null,
        }]
        : [];
    }
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      // A change that has not been flushed is still a change: without this, opening a
      // project and going straight to the manager would show the stale "recent" order
      // for as long as the flush had not run.
      this.#applyPatches(cat, this.#pendingCatalog);
      const present = new Set(await this.#driver.list(ROOT));
      const kept = cat.entries.filter((e) => present.has(e.id));
      // Heal by recording removals rather than writing here — so every catalog write
      // goes through the flush, and listing a busy index costs no write at all.
      for (const e of cat.entries) if (!present.has(e.id)) this.#pendingCatalog.set(e.id, REMOVED);
      // And heal the other way: a folder the catalog has no record of is a project that
      // exists, so it is listed from its own manifest rather than being invisible. This
      // is what makes the catalog a CACHE — losing it costs ordering metadata, not
      // access to anyone's work.
      const known = new Set(cat.entries.map((e) => e.id));
      for (const id of present) {
        // What makes a folder a project is that it holds a manifest, which
        // `#recoverEntry` checks — not the shape of its name. An earlier cut tested ids
        // against the UUID format `crypto.randomUUID` produces, which made any project
        // whose id came from elsewhere unrecoverable, in precisely the situation
        // recovery is for. The cost of asking is one failed read per stray directory.
        if (known.has(id) || id === CATALOG) continue;
        const found = await this.#recoverEntry(id);
        if (!found) continue;
        kept.push(found);
        this.#pendingCatalog.set(id, composePatch(this.#pendingCatalog.get(id), () => found));
      }
      return kept.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    } finally {
      release();
    }
  }

  /**
   * Save (create or overwrite) a project bundle.
   *
   * @param {Object} project
   * @param {string} [project.id] - Entry id (minted if absent).
   * @param {string} project.name
   * @param {number} project.savedAt - epoch ms
   * @param {{activeId: number, datasets: Array<{id: number, name: string, state: object}>}} project.bundle
   * @param {{writeSourcesFor?: Set<number>}} [opts] - Dataset ids whose Parquet
   *   sources to (re)write; omit to write them all (a full save).
   * @returns {Promise<string>} the project id.
   */
  async save({ id, name, savedAt, bundle }, { writeSourcesFor } = {}) {
    if (navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        /* best effort */
      }
    }
    id = this.#flat ? FOLDER_PROJECT_ID : (id || crypto.randomUUID());

    // Guard: never encrypt one project's bytes with another project's key — that
    // would make it permanently unopenable. In OPFS mode each project can carry its
    // own key, so the loaded key MUST belong to the id being saved. (Creating a NEW
    // protected project pre-mints the id and unlocks it, so #keyId already matches.)
    if (this.#key && !this.#flat && this.#keyId !== id) {
      throw new Error('internal: encryption key does not match the project being saved');
    }

    // Parquet first, then the manifest — the same manifest shape folder-sync merges,
    // built by the shared {@link buildManifest} so save and sync never drift.
    await this.#writeSources(id, bundle, writeSourcesFor);
    const manifest = buildManifest({ name, savedAt, bundle });
    await this.#write(this.#file(id, 'project.json'), JSON.stringify(manifest));
    // NO reclamation here, deliberately (2026-10-21). Saving is about durability; what
    // to keep is a space decision, and making it as a side effect of every save is where
    // every bug in this area came from — including one that deleted a peer's half-synced
    // data. Dead bytes are collected by {@link ProjectStore#compactProject}, which says
    // what it will free before it does it. See the quota guard in project-sync.

    if (this.#flat) {
      // Folder = project: a plaintext marker makes the folder self-describing (and
      // lets the launcher show its name before unlocking). No catalog in flat mode.
      await this.#driver.write(MARKER, te.encode(JSON.stringify({ app: 'crosstab', name, savedAt })));
      return id;
    }

    // The summary carries activePlugins too, so the launcher's rail can seed its picker
    // from a project without loading the whole bundle.
    //
    // Deferred after the first save of this project: the project's own bytes are already
    // on disk above, and what is left is a browse index. The first one goes now, because
    // that is when the ENTRY may need creating — see `#onDisk`. Losing it costs a
    // manifest read at the next listing rather than the project, which is what the
    // recovery in `list()` is for.
    await this.#patchCatalog(
      id,
      (prev) => this.#summaryFor(id, manifest, prev),
      { now: !this.#onDisk.has(id) },
    );
    return id;
  }

  /**
   * Load a project bundle (manifest + every dataset's sources).
   * @param {string} id
   * @returns {Promise<{id: string, name: string, bundle: {activeId: number, datasets: Array<{id: number, name: string, state: object}>}}>}
   */
  async load(id) {
    const manifest = JSON.parse(await this.#read(this.#file(id, 'project.json')));
    // Reconcile the index against what was just read. A catalog entry left stale by a
    // lost flush would otherwise STAY stale for a project nobody edits: opening one to
    // read its output stamps `lastOpenedAt` and nothing else, and without an edit there
    // is no save to rebuild the summary.
    //
    // Deliberately not "trigger a save". A save writes a new `savedAt` for an edit that
    // never happened — a lie in the log and in the History panel — and rewrites bytes
    // that are already correct. The manifest is in hand here, so the honest repair is to
    // make the summary agree with it and leave the project alone.
    this.#reconcileSummary(id, manifest);
    // The single flat one-true-log (every tier). Re-attach each LIVE source op's Parquet
    // from its op-id-keyed sidecar; byte-less (retracted) source ops and every other op
    // pass through verbatim with their stable id/hlc/target intact.
    const log = [];
    for (const op of manifest.log ?? []) {
      if (isSourceOp(op) && op.payload?.src?.file) {
        const bytes = await this.#readBytes(this.#file(id, op.payload.src.file));
        const src = { ...op.payload.src, parquet: new Uint8Array(bytes) };
        log.push({ ...op, payload: { ...op.payload, src } });
      } else {
        log.push(op);
      }
    }
    // Split out each subsystem's tier for its own restore (all share the one log:
    // loadBundle handles collection + data; these two restore analysis + workspace).
    const analysisLog = log.filter((o) => o.owner === 'core' && typeof o.target === 'string' && o.target.startsWith('analysis:'));
    const workspaceOps = log.filter((o) => typeof o.target === 'string' && o.target.startsWith('ws:'));
    const assetOps = log.filter((o) => o.owner === 'core' && typeof o.target === 'string' && o.target.startsWith('asset:'));
    const itemOps = log.filter((o) => typeof o.target === 'string' && o.target.startsWith('item:')); // #152
    return {
      id,
      name: manifest.name,
      bundle: {
        activeId: manifest.activeId,
        activePlugins: Array.isArray(manifest.activePlugins) ? manifest.activePlugins : null,
        output: Array.isArray(manifest.output) ? manifest.output : null,
        datasetMeta: manifest.datasetMeta && typeof manifest.datasetMeta === 'object' ? manifest.datasetMeta : null,
        collabId: manifest.collabId ?? null,
        collabSecret: manifest.collabSecret ?? null,
        analysisLog,
        workspaceOps,
        assetOps,
        itemOps,
        log,
      },
    };
  }

  /**
   * Read a project's raw manifest (`project.json`) **without** materialising its
   * Parquet sources — a *stat + parse*, not a full load. This is how folder-sync
   * cheaply reads "their" latest version to diff against, and how change-detection
   * watches one file (`project.json` rewrites on every save and indexes every
   * dataset). Returns null if absent/unparseable (tolerate torn reads mid-sync —
   * retry next tick rather than treating a parse failure as corruption).
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async readManifest(id) {
    try {
      return JSON.parse(await this.#read(this.#file(id, 'project.json')));
    } catch (err) {
      // `null` means ABSENT, and callers act on that: decideSync maps a null peer
      // manifest to `seed`, i.e. "write mine over the folder". Returning null for a
      // DECRYPT failure therefore turned "I cannot read this" into "there is nothing
      // here" — a stale-keyed peer would blindly overwrite the owner's project with its
      // own, encrypted under a key the owner no longer holds. Absent is null; anything
      // else is an error the caller must see.
      if (/^not found:/.test(err?.message || '')) return null;
      throw err;
    }
  }

  /**
   * Write a **merged** manifest straight to `project.json` (folder-sync) — the result
   * of an op-union merge, whose source `file` refs point at Parquet the OS sync client
   * has already mirrored from both sides (op-id-keyed, so no collision + no bytes here).
   * The driver's `write` is atomic (temp + rename), so a peer polling `project.json`
   * mid-write never reads a torn file. Refreshes the catalog so `list()` stays in step.
   * @param {string} id
   * @param {object} manifest
   */
  async writeManifest(id, manifest) {
    await this.#write(this.#file(id, 'project.json'), JSON.stringify(manifest));
    if (this.#flat) { // folder = project: refresh the plaintext marker, no catalog
      await this.#driver.write(MARKER, te.encode(JSON.stringify({ app: 'crosstab', name: manifest.name, savedAt: manifest.savedAt })));
      return;
    }
    await this.#patchCatalog(
      id,
      (prev) => this.#summaryFor(id, manifest, prev),
      { now: !this.#onDisk.has(id) },
    );
  }

  /** Rename a project (updates its manifest + the catalog/marker). */
  async rename(id, name) {
    const manifest = JSON.parse(await this.#read(this.#file(id, 'project.json')));
    manifest.name = name;
    await this.#write(this.#file(id, 'project.json'), JSON.stringify(manifest));
    if (this.#flat) {
      await this.#driver.write(MARKER, te.encode(JSON.stringify({ app: 'crosstab', name, savedAt: manifest.savedAt })));
      return;
    }
    // `now`, unlike a save: a rename is a deliberate act the user is watching for, and
    // seeing the old name come back after a crash would read as the rename not working.
    await this.#patchCatalog(id, (prev) => (prev ? { ...prev, name } : null), { now: true });
  }

  /** Delete a project bundle and drop it from the catalog. (Not used in flat/folder
   * mode — a folder project is deleted by the user removing the folder.) */
  /**
   * Note that a project was opened, for ordering a "recent projects" list (#171).
   *
   * Distinct from `savedAt`, and the difference is the whole point: opening a project to
   * look at it without editing leaves `savedAt` untouched, so ordering by it would never
   * move that project up the list — which is not what anyone means by recent.
   *
   * Best-effort and never throws: failing to remember that you looked at something must
   * not stop you looking at it.
   */
  async markOpened(id, when = Date.now()) {
    if (this.#flat || id == null) return; // one project per location; nothing to order
    // Deferred, and returning the entry UNCHANGED when there is none: a project that
    // has never been saved has nothing in the catalog to stamp, and the patch must not
    // conjure a half-built entry for it.
    await this.#patchCatalog(id, (prev) => (prev ? { ...prev, lastOpenedAt: when } : null));
  }

  async delete(id) {
    if (this.#flat) return; // don't blow away the user's picked folder from here
    await this.#driver.removeTree(`${ROOT}/${id}`);
    // `now`: the bytes are already gone, so until this lands the catalog names a project
    // that cannot be opened. `list()` would heal it, but only on the next listing.
    await this.#patchCatalog(id, REMOVED, { now: true });
  }

  /**
   * Write only the Parquet sources of a bundle (no `project.json`) — the folder-sync
   * step that lands *my* data so a merged manifest's file refs resolve, while
   * {@link folder-sync} owns `project.json` via the merge (#143). File names match
   * {@link buildManifest}'s (`src_<opId>.parquet`).
   * @param {string} id
   * @param {object} bundle
   * @param {Set<number>} [only]  dataset ids to write; omit for all.
   */
  async writeSourcesOnly(id, bundle, only) {
    await this.#writeSources(id, bundle, only);
  }

  /**
   * Write a plaintext file directly into the folder, BYPASSING encryption — for
   * OS-facing files (double-click shortcuts, a HOW-TO note) that the operating
   * system reads and CrossTab itself never reads back. Folder mode only.
   * @param {string} name  bare file name (flat folder layout)
   * @param {string|Uint8Array} data
   * @returns {Promise<boolean>} false (no-op) unless folder-backed
   */
  async writePlainFile(name, data) {
    if (!this.#flat) return false;
    const bytes = typeof data === 'string' ? te.encode(data) : data;
    await this.#driver.write(name, bytes);
    return true;
  }

  /** Whether a plaintext file already exists directly in the folder (flat mode). */
  async hasPlainFile(name) {
    if (!this.#flat) return false;
    try {
      return (await this.#driver.read(name)) != null;
    } catch {
      return false;
    }
  }

  /**
   * Delete byte files this project no longer references — a purged dataset's Parquet
   * sidecars and any asset whose `addAsset` op is gone (#149 C2). Without it the project
   * only ever grew: `orphanDataOps` stripped a source op's `file` ref but nothing removed
   * the file, so every purged dataset and every replaced import left its bytes behind
   * forever.
   *
   * Keyed on the **manifest we just wrote**, not on ownership or any side table: a file
   * survives iff some op in the saved log names it. That's the whole rule, it can't drift
   * from what a load will actually read, and it stays correct when #150 adds asset
   * ownership. Runs after the manifest is durable, so a crash mid-sweep loses only
   * garbage — never a file the manifest still points at.
   *
   * Best-effort throughout: a sweep failure must never fail a save.
   */
  /**
   * Bytes on disk per project — every file in each project's folder, not just the ones
   * the log references.
   *
   * Everything counts because this answers "what would deleting it free", and an
   * unreferenced source or a stale asset occupies exactly as much room as a live one.
   *
   * ONE walk for the whole index rather than a call per project: at ~50 projects a
   * per-project version was most of a `stat` storm, and this is called when a human
   * opens the manager — not on any hot path. A project whose folder cannot be read is
   * omitted rather than reported as zero, because "0 bytes" would be read as "nothing to
   * gain by deleting this".
   *
   * @returns {Promise<Map<string, number>>} project id → bytes
   */
  async projectSizes() {
    const out = new Map();
    if (this.#flat) return out; // folder mode is one project, and its size is the folder's
    let ids;
    try { ids = await this.#driver.list(ROOT); } catch { return out; }
    for (const id of ids) {
      if (id === CATALOG) continue;
      let total = 0;
      let seen = false;
      try {
        for (const name of await this.#driver.list(`${ROOT}/${id}`)) {
          if (name === ASSET_DIR) {
            for (const a of await this.#driver.list(`${ROOT}/${id}/${ASSET_DIR}`)) {
              const st = await this.#driver.stat(`${ROOT}/${id}/${ASSET_DIR}/${a}`).catch(() => null);
              if (st) { total += st.size || 0; seen = true; }
            }
            continue;
          }
          const st = await this.#driver.stat(`${ROOT}/${id}/${name}`).catch(() => null);
          if (st) { total += st.size || 0; seen = true; }
        }
      } catch { continue; }
      if (seen) out.set(id, total);
    }
    return out;
  }

  /**
   * Delete the data files nothing in this project's log accounts for.
   *
   * **Deliberately not part of {@link ProjectStore#compactProject}**, and the difference
   * is authority rather than mechanism. Compaction acts on the log's own evidence — an
   * op that says its bytes are dead — and needs nobody's permission. This deletes files
   * the log says NOTHING about, which is the exact case the save path was changed to
   * stop touching, because an unaccounted-for file is routinely a collaborator's data
   * that arrived before the index explaining it.
   *
   * So it exists only as a thing a person can choose, knowing the one fact the app
   * cannot: that the sync has finished. Callers must confirm before calling.
   *
   * @param {string} id
   * @param {{dryRun?: boolean}} [opts]
   * @returns {Promise<{files: string[], bytes: number, removed: number}>}
   */
  async discardUnreferenced(id, { dryRun = false } = {}) {
    const out = { files: [], bytes: 0, removed: 0 };
    const check = await this.projectIntegrity(id);
    // No manifest means nothing can be called unaccounted-for: every file would qualify,
    // and deleting the project's data because its index was briefly unreadable is the
    // worst outcome this whole area has.
    if (check.manifestUnreadable) return out;
    for (const name of check.unreferenced) {
      const st = await this.#driver.stat(this.#file(id, name)).catch(() => null);
      out.files.push(name);
      out.bytes += st?.size ?? 0;
      if (dryRun) continue;
      await this.#driver.remove(this.#file(id, name));
      out.removed += 1;
    }
    return out;
  }

  /**
   * How much room is left, as the browser sees it.
   *
   * `navigator.storage.estimate()` is the only warning available before a write fails,
   * and it is approximate on purpose (browsers round it to resist fingerprinting). So it
   * is used for "you are getting close", never for arithmetic — a decision that needed
   * the exact number would be wrong on every engine.
   *
   * Returns null where the API is absent, which callers must read as "no information",
   * NOT as "plenty of room".
   *
   * @returns {Promise<{usage: number, quota: number, freeBytes: number, usedFraction: number}|null>}
   */
  static async storageEstimate() {
    try {
      const est = await navigator.storage?.estimate?.();
      if (!est || !Number.isFinite(est.quota) || !est.quota) return null;
      const usage = Number(est.usage) || 0;
      return {
        usage,
        quota: est.quota,
        freeBytes: Math.max(0, est.quota - usage),
        usedFraction: usage / est.quota,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check a project's files against what its manifest expects.
   *
   * Four outcomes, and keeping them apart is the whole value — they have different
   * causes and opposite remedies:
   *
   *  - **`missing`** — the log references a file that is not here. A dataset will come
   *    back short or empty. Usually a sync that delivered `project.json` before the
   *    Parquet, which are the two ends of the same save and arrive in whatever order the
   *    sync client feels like; the fix is to wait, or to fetch that one file.
   *  - **`unreferenced`** — a file is here that nothing in the log points at. The
   *    opposite order of the same race, or a hand-copied folder. **Not garbage**: until
   *    the matching manifest arrives this is the only copy of someone's data, which is
   *    why the sweep no longer deletes it.
   *  - **`unreadable`** — present, and the bytes are not what they claim. A torn write,
   *    a half-synced file, bit-rot. This is the only one that is unambiguously damage.
   *  - **`manifestUnreadable`** — `project.json` itself will not parse. Everything else
   *    is unknowable, so the check says that and stops rather than reporting every file
   *    as unreferenced, which would be true and useless.
   *
   * It reads no Parquet bodies: a size-zero or truncated file is caught by `stat`, and
   * decoding every column of a multi-gigabyte project to verify a project the user has
   * not asked about would cost more than the problem.
   *
   * Reports; never repairs. The remedies differ and most of them are the user's — wait
   * for a sync, re-copy a file, accept a loss. The one time this code acted on its own
   * judgement it deleted a colleague's data.
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, manifestUnreadable: boolean, missing: string[],
   *   unreferenced: string[], unreadable: string[], checked: number}>}
   */
  async projectIntegrity(id) {
    const out = {
      ok: true, manifestUnreadable: false, missing: [], unreferenced: [], unreadable: [], checked: 0,
    };
    let manifest = null;
    try {
      manifest = JSON.parse(await this.#read(this.#file(id, 'project.json')));
    } catch {
      // Includes a project encrypted under a key this store does not hold — which is
      // not damage, and is why this says "unreadable" rather than "corrupt".
      return { ...out, ok: false, manifestUnreadable: true };
    }
    const want = manifestRefs(manifest);
    const dir = this.#flat ? '' : `${ROOT}/${id}`;
    const here = new Set();
    for (const name of await this.#driver.list(dir)) if (isSourceFile(name)) here.add(name);
    for (const assetId of await this.listAssets(id)) here.add(`${ASSET_DIR}/${safeAssetId(assetId)}.bin`);

    for (const name of want) {
      out.checked += 1;
      if (!here.has(name)) { out.missing.push(name); continue; }
      const st = await this.#driver.stat(this.#file(id, name)).catch(() => null);
      // A zero-length file is the signature of an interrupted write: the entry exists
      // because it was created, and the bytes never followed.
      if (!st || !st.size) out.unreadable.push(name);
    }
    for (const name of here) if (!want.has(name)) out.unreferenced.push(name);

    out.ok = !out.missing.length && !out.unreferenced.length && !out.unreadable.length;
    out.missing.sort();
    out.unreferenced.sort();
    out.unreadable.sort();
    return out;
  }

  /**
   * Free the bytes of source ops this project's own log says are dead.
   *
   * **The only thing in the store that deletes data files**, and it is never a side
   * effect: a save reclaims nothing, so nothing is removed until someone asks. That is
   * the asset doctrine (#150, #152) applied to sources — reference-counted from the log,
   * abstaining when unsure, a rare explicit act.
   *
   * **What "dead" means is the log's statement, not a set difference** — see
   * {@link deadSourceFiles}. A source op carries `src.file` only while it is in the live
   * fold, so a retracted, undone or barrier-superseded op is persisted byte-less on
   * purpose, and still names its sidecar through its stable id. A file whose op is not in
   * this log at all yields no evidence and is never touched, which is what a peer's
   * half-synced data and another tab's new dataset both look like.
   *
   * **What it costs, which the caller must say out loud.** Those bytes are what a deep
   * undo would have revived: the generation a `replace` superseded is kept precisely so
   * one Ctrl+Z brings it back. Compacting trades that for space, and a user who is not
   * told is a user who finds out by losing an undo.
   *
   * @param {string} id
   * @param {{dryRun?: boolean}} [opts] `dryRun` reports without removing — what the
   *   confirmation shows.
   * @returns {Promise<{files: string[], bytes: number, removed: number}>}
   */
  async compactProject(id, { dryRun = false } = {}) {
    const out = { files: [], bytes: 0, removed: 0 };
    let manifest;
    try {
      manifest = JSON.parse(await this.#read(this.#file(id, 'project.json')));
    } catch {
      return out; // unreadable or locked: nothing can be proved dead, so nothing goes
    }
    const dead = deadSourceFiles(manifest);
    if (!dead.size) return out;
    // A live op must win over a dead one of the same name. They cannot collide today —
    // the name IS the op id — but a merge that revived a retracted source would make
    // them, and resurrecting bytes is cheaper to get right than un-deleting them.
    const live = manifestRefs(manifest);
    const present = new Set(await this.#driver.list(this.#flat ? '' : `${ROOT}/${id}`));
    for (const name of dead) {
      if (live.has(name) || !present.has(name)) continue;
      const st = await this.#driver.stat(this.#file(id, name)).catch(() => null);
      out.files.push(name);
      out.bytes += st?.size ?? 0;
      if (dryRun) continue;
      await this.#driver.remove(this.#file(id, name));
      out.removed += 1;
    }
    out.files.sort();
    return out;
  }

  // --- media assets (#149 A5) -------------------------------------------------
  // Media lives IN the project, beside the source Parquet, under `assets/<id>.bin`.
  // It used to sit in its own OPFS root, which meant a project's media couldn't travel
  // with it — not into a bundle, a synced folder, or a peer. Bytes are content-addressed
  // by the caller (the id IS the hash), and the metadata is an op in the log, so there
  // is no catalog and no metadata sidecar to fall out of step.

  /** Path of one asset's bytes inside the project. */
  #assetFile(id, assetId) {
    return this.#file(id, `${ASSET_DIR}/${safeAssetId(assetId)}.bin`);
  }

  /**
   * Store an asset's bytes. Streams the Blob straight through when the project is
   * unprotected, so a multi-GB movie never sits in RAM. A **protected** project falls
   * back to a buffered write, because the at-rest envelope encrypts a whole byte array
   * — correctness over memory; the alternative is silently storing media in the clear.
   * @param {string} id project id @param {string} assetId @param {Blob} blob
   */
  async writeAsset(id, assetId, blob) {
    const path = this.#assetFile(id, assetId);
    if (this.#key) await this.#write(path, new Uint8Array(await blob.arrayBuffer()));
    else await this.#driver.writeStream(path, blob);
  }

  /**
   * Read an asset's bytes as a Blob, or null. Unprotected projects hand back the
   * handle's own File (nothing is copied — a `<video>` can stream from it); a protected
   * project must decrypt, so it materialises.
   * @param {string} id project id @param {string} assetId @param {string} [type] MIME type
   * @returns {Promise<Blob|null>}
   */
  async readAsset(id, assetId, type) {
    const path = this.#assetFile(id, assetId);
    if (this.#key) {
      const bytes = await this.#readRaw(path);
      return bytes ? new Blob([bytes], { type: type || 'application/octet-stream' }) : null;
    }
    const file = await this.#driver.readBlob(path);
    if (!file) return null;
    return type ? file.slice(0, file.size, type) : file;
  }

  /** Whether an asset's bytes are present in this project. */
  async hasAsset(id, assetId) {
    return (await this.#driver.readBlob(this.#assetFile(id, assetId))) != null;
  }

  /** Forget an asset's bytes (the purge/sweep path). */
  async removeAsset(id, assetId) {
    await this.#driver.remove(this.#assetFile(id, assetId));
  }

  /** Asset ids whose bytes are present in this project — the sweep's "what's on disk". */
  async listAssets(id) {
    const names = await this.#driver.list(this.#path(id, ASSET_DIR));
    return names.filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -'.bin'.length));
  }

  // --- internals -------------------------------------------------------------

  /** Path of a file inside a project bundle (layout-aware; see {@link ProjectStore#useDirectory}). */
  #file(id, name) {
    return this.#path(id, name);
  }

  /**
   * Change one project's catalog entry, writing the file later.
   *
   * `patch(prev)` returns the entry to store, or null to leave the catalog alone. The
   * hot path — an autosave stamping a new `savedAt` — now costs no read, no write and no
   * lock; it records a closure and returns.
   *
   * @param {string} id
   * @param {Function|symbol} patch `(prev|undefined) => entry|null`, or {@link REMOVED}
   * @param {{now?: boolean}} [opts] `now` writes before returning — for a change the
   *   user made deliberately and would notice losing (a create, a rename, a delete).
   */
  async #patchCatalog(id, patch, { now = false } = {}) {
    this.#pendingCatalog.set(id, composePatch(this.#pendingCatalog.get(id), patch));
    if (now) {
      await this.flushCatalog();
      return;
    }
    if (this.#flushTimer != null) return;
    // A plain timer rather than an idle callback: the flush must happen on a schedule a
    // user can reason about ("within a second of stopping"), and `requestIdleCallback`
    // can be starved indefinitely by a busy tab — which is exactly the tab that has been
    // autosaving.
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.flushCatalog();
    }, CATALOG_FLUSH_MS);
  }

  /**
   * Write every pending catalog change.
   *
   * Re-reads the file and applies the patches to it, rather than writing a snapshot
   * assembled earlier: that is what lets two tabs interleave without one losing the
   * other's entries, and it is why a pending change is a function.
   *
   * Never throws — the catalog is a browse index derived from projects that are already
   * safely on disk, and failing to update it must not fail the save that scheduled it.
   */
  async flushCatalog() {
    if (this.#flushTimer != null) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
    if (!this.#pendingCatalog.size || this.#flat) { this.#pendingCatalog.clear(); return; }
    // Taken before the await so a patch recorded DURING the write is not dropped by the
    // clear at the end; it stays pending and the next flush carries it.
    const batch = this.#pendingCatalog;
    this.#pendingCatalog = new Map();
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      if (this.#applyPatches(cat, batch, { record: true })) {
        await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
      }
    } catch {
      // Put them back, so the next flush retries rather than silently losing the index
      // update. Newer patches for the same id win — they were computed later.
      for (const [id, patch] of batch) if (!this.#pendingCatalog.has(id)) this.#pendingCatalog.set(id, patch);
    } finally {
      release();
    }
  }

  /**
   * Bring the catalog entry into line with a manifest just read, if it has drifted.
   *
   * Fire-and-forget and deferred: it is housekeeping on a browse index, and must never
   * delay or fail the load that noticed it. Comparing first keeps the common case free —
   * an entry that already agrees schedules no write at all.
   */
  #reconcileSummary(id, manifest) {
    if (this.#flat || !manifest) return;
    this.#patchCatalog(id, (prev) => {
      const next = this.#summaryFor(id, manifest, prev);
      // `recovered` is not part of the summary; an entry that carried it is being
      // replaced by a real one, so a drift check must not call them equal.
      if (prev && !prev.recovered && sameSummary(prev, next)) return null;
      return next;
    }).catch(() => { /* the project loaded; the index can wait for the next flush */ });
  }

  /**
   * Rebuild one project's summary from its own files, for a folder the catalog has no
   * record of.
   *
   * Three outcomes, and the second is the one worth designing for:
   *
   *  - **Readable** — the manifest answers everything the catalog holds except
   *    `lastOpenedAt`, which is a fact about this device and is simply absent. Nothing
   *    is guessed.
   *  - **Encrypted and locked** — the bytes are an envelope this store has no key for,
   *    so the name is genuinely unknowable from here (for a protected project the
   *    catalog was the only place it lived in the clear). It is still LISTED, with the
   *    lock stated, because a project you cannot name is far better than a project you
   *    cannot find: opening it prompts for the passphrase and the real name arrives with
   *    the first successful read.
   *  - **Neither** — no `project.json`, or bytes that are not a manifest. Not a project;
   *    skipped, so a stray directory never becomes a phantom row.
   *
   * @returns {Promise<object|null>} a catalog summary, or null if this is not a project.
   */
  async #recoverEntry(id) {
    let bytes;
    try {
      bytes = await this.#driver.read(this.#file(id, 'project.json'));
    } catch {
      return null;
    }
    if (!bytes) return null;
    if (isEnveloped(bytes) && !this.#key) {
      return { id, name: null, encrypted: true, savedAt: undefined, recovered: true };
    }
    try {
      const manifest = JSON.parse(await this.#read(this.#file(id, 'project.json')));
      if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') return null;
      return { ...this.#summaryFor(id, manifest, undefined), recovered: true };
    } catch {
      // Enveloped under a DIFFERENT key, or damaged. Either way the folder holds
      // something claiming to be a project, so say it is there rather than silently
      // dropping it — the user is the only one who can tell which it is.
      return isEnveloped(bytes)
        ? { id, name: null, encrypted: true, savedAt: undefined, recovered: true }
        : null;
    }
  }

  /**
   * Apply pending patches to a catalog object, in place.
   *
   * Shared by the flush and by {@link ProjectStore#list}, which needs the same view and
   * must not get a different one — a listing that disagreed with what the next flush
   * writes is worse than either answer on its own.
   *
   * `record` is set only by the flush: it marks which ids are now on disk, which is what
   * decides whether a later save can defer. Listing applies the same patches and leaves
   * them pending, because listing does not write them.
   */
  #applyPatches(cat, batch, { record = false } = {}) {
    let changed = 0;
    for (const [id, patch] of batch) {
      const idx = cat.entries.findIndex((e) => e.id === id);
      if (patch === REMOVED) {
        if (idx >= 0) { cat.entries.splice(idx, 1); changed += 1; }
        if (record) this.#onDisk.delete(id);
        continue;
      }
      const next = patch(idx >= 0 ? cat.entries[idx] : undefined);
      // A patch may DECLINE by returning null: stamping a project that has no entry, or
      // a reconcile finding nothing has drifted. Counting those as changes would make
      // every project open cost a full catalog write — the cost this is all here to
      // remove, coming back through the door marked housekeeping.
      if (!next) continue;
      if (idx >= 0) cat.entries[idx] = next;
      else cat.entries.push(next);
      if (record) this.#onDisk.add(id);
      changed += 1;
    }
    return changed;
  }

  /**
   * One project's catalog summary, built from its manifest.
   *
   * Shared by `save` and `refreshSummary`, which had a copy each — and had already
   * drifted: one wrote `activePlugins: manifest.activePlugins` and the other
   * `manifest.activePlugins ?? null`, so whether a project's plugin list read as absent
   * or as empty depended on which code path last touched it.
   *
   * `prev` is the entry currently on disk. Two fields are carried from it because the
   * summary is rebuilt whole and anything not re-stated is lost: `lastOpenedAt`, which is
   * a fact about this device and never appears in a manifest, and `rowCount` when this
   * particular write did not compute one.
   */
  #summaryFor(id, manifest, prev) {
    return {
      lastOpenedAt: prev?.lastOpenedAt,
      id,
      name: manifest.name,
      savedAt: manifest.savedAt,
      datasetCount: countDatasets(manifest),
      rowCount: Number.isFinite(manifest.rowCount) ? manifest.rowCount : prev?.rowCount,
      activePlugins: manifest.activePlugins ?? null,
    };
  }

  async #readCatalog() {
    try {
      const parsed = JSON.parse(await this.#readPlain(`${ROOT}/${CATALOG}`));
      return Array.isArray(parsed.entries) ? parsed : { entries: [] };
    } catch {
      return { entries: [] };
    }
  }

  /** Write a JSON string plaintext (driver-direct, bypassing #key). The catalog uses
   * this: it spans projects, which in OPFS mode can each carry a DIFFERENT key, so it
   * can't be encrypted under any one of them. (Project NAMES are therefore visible in
   * the catalog even for protected projects — same as the plaintext folder marker;
   * the DATA stays encrypted.) */
  async #writePlain(path, str) {
    await this.#driver.write(path, te.encode(str));
  }

  /** Read a plaintext JSON file as a string, or throw if missing (caller catches). */
  async #readPlain(path) {
    const raw = await this.#driver.read(path);
    if (raw == null) throw new Error(`not found: ${path}`);
    return new TextDecoder().decode(raw);
  }

  /** Encrypt-when-keyed, then hand opaque bytes to the driver. Strings are UTF-8
   * encoded first (JSON manifests); Uint8Arrays (Parquet) pass through. */
  async #write(path, data) {
    let bytes;
    if (this.#key) bytes = await encryptWithKey(this.#key, data);
    else bytes = typeof data === 'string' ? te.encode(data) : data;
    await this.#driver.write(path, bytes);
  }

  /** Read raw bytes via the driver, transparently decrypting an encryption envelope
   * when a key is set. An enveloped file with no key is a clear, actionable error
   * rather than a garbled parse. Plaintext (legacy / unencrypted) passes through, so
   * a folder can be read + migrated in place. Missing file → throws (callers catch). */
  async #readRaw(path) {
    const raw = await this.#driver.read(path);
    if (raw == null) throw new Error(`not found: ${path}`);
    if (isEnveloped(raw)) {
      if (!this.#key) throw new Error('This project is encrypted — unlock it with its passphrase first.');
      try {
        return await decryptWithKey(this.#key, raw);
      } catch (err) {
        // Mid-rekey, some files are still under the old key. Plaintext already coexists
        // with ciphertext (the envelope is self-describing), so the only unreadable mix
        // is old-ciphertext beside new — which this closes. Outside a rekey `#prevKey`
        // is null and the error propagates exactly as before.
        if (!this.#prevKey) throw err;
        return decryptWithKey(this.#prevKey, raw);
      }
    }
    return raw;
  }

  async #read(path) {
    return new TextDecoder().decode(await this.#readRaw(path));
  }

  async #readBytes(path) {
    return this.#readRaw(path); // Uint8Array (callers wrap as needed)
  }

  /** Write each dataset's Parquet sources (all datasets, or only those in `only`).
   * Sources are named by the op that created them → `src_<opId>.parquet`, matching
   * {@link buildManifest}'s file refs. */
  async #writeSources(id, bundle, only) {
    const dsIdOf = (op) => { const m = /^ds:([^/]+)\//.exec(op.target); return m ? m[1] : null; };
    for (const op of bundle.log ?? []) {
      if (!isSourceOp(op)) continue;
      const { file, parquet } = op.payload?.src ?? {};
      if (!file) continue; // retracted (byte-less) source — nothing to write
      // `only` (dirty dataset ids): skip sources of datasets that didn't change.
      if (only) { const k = dsIdOf(op); if (k == null || !only.has(Number(k))) continue; }
      if (!parquet) throw new Error(`save: source ${file} has no parquet`);
      await this.#write(this.#file(id, file), parquet);
    }
  }
}

/**
 * Build the `project.json` **manifest** (metadata + transform logs + Parquet file
 * refs, no bytes) from an in-memory bundle — the exact shape {@link ProjectStore#save}
 * writes and {@link module:core/collab-sync~mergeProjects} merges. Pure, so it also
 * produces "my" manifest for a folder sync without touching disk. File refs follow
 * `src_<opId>.parquet` (matching {@link ProjectStore#writeSourcesOnly}).
 *
 * @param {{name: string, savedAt: number, bundle: object}} arg
 * @returns {object} the manifest
 */
export function buildManifest({ name, savedAt, bundle }) {
  // The single flat one-true-log (every tier: collection + data + analysis, and — once
  // migrated — workspace). Each op keeps its stable id/hlc/target/owner/author so the log
  // round-trips verbatim and merges by op identity. Source ops carry an op-id-keyed
  // Parquet FILE ref instead of bytes (written separately by #writeSources); the
  // peer-local DuckDB table name is already stripped by rawExport.
  const log = (bundle.log ?? []).map((op) => {
    if (isSourceOp(op) && op.payload?.src) {
      const s = op.payload.src;
      const src = { meta: s.meta, label: s.label ?? null };
      if (s.wide) { src.wide = true; src.rowidBase = s.rowidBase; }
      if (s.file) src.file = s.file; // byte-less (retracted) sources have none
      return { ...op, payload: { ...op.payload, src } };
    }
    return op;
  });
  return {
    name,
    savedAt,
    // Travels with the project rather than living only in this device's catalog: it is a
    // fact about the data, so a project copied to another machine should still be able to
    // say how big it is without being opened.
    ...(Number.isFinite(bundle.rowCount) ? { rowCount: bundle.rowCount } : {}),
    activeId: bundle.activeId,
    activePlugins: Array.isArray(bundle.activePlugins) ? bundle.activePlugins : null,
    output: Array.isArray(bundle.output) ? bundle.output : null,
    // Per-dataset non-log state (the library link). Names/order/membership are ops.
    datasetMeta: bundle.datasetMeta && typeof bundle.datasetMeta === 'object' ? bundle.datasetMeta : null,
    // Collaboration identity (#143): rides the manifest so both peers derive the same
    // signaling room + secret. Minted by the app on save.
    collabId: bundle.collabId ?? null,
    collabSecret: bundle.collabSecret ?? null,
    log,
  };
}
