/**
 * @file project-store.js
 * Persistent **projects** — the top tier of the two-tier model.
 *
 * A *project* is the whole working set: every open dataset (each its own
 * immutable sources + transform log) plus which one is active. It's a living
 * document — saved as one self-contained bundle and autosaved as you work. (The
 * other tier, the reusable building-block dataset library, is {@link DatasetStore}.)
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
const CATALOG = 'catalog.json';

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

  /** The byte backend (see {@link module:core/storage-driver}). OPFS by default;
   * {@link ProjectStore#useDirectory} swaps in a picked folder. */
  #driver = new OpfsDriver();

  /** AES-GCM master key for at-rest encryption, or null (plaintext). Set by
   * {@link ProjectStore#unlock}; never persisted. When set, every data file
   * (`project.json`, `project.base.json`, Parquet) is written as a ciphertext
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
   * project: files live directly in it (`project.json`, `ds<id>_src<n>.parquet`,
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
  async hasEncryption(id = FOLDER_PROJECT_ID) {
    return !!(await this.#driver.read(this.#metaPath(id)));
  }

  /** Acquire the mutex; returns a release fn. */
  async #acquire() {
    const prev = this.#tail;
    let release;
    this.#tail = new Promise((r) => {
      release = r;
    });
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
      return m ? [{ id: FOLDER_PROJECT_ID, name: m.name, savedAt: m.savedAt, datasetCount: countDatasets(m), activePlugins: m.activePlugins ?? null }] : [];
    }
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const present = new Set(await this.#driver.list(ROOT));
      const kept = cat.entries.filter((e) => present.has(e.id));
      if (kept.length !== cat.entries.length) await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify({ entries: kept }));
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
   * @param {{activeId: number, datasets: Array<{id: number, name: string, state: import('./dataset-store.js').DatasetState}>}} project.bundle
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
    await this.#sweep(id, manifest); // drop bytes nothing in the log points at (#149 C2)

    if (this.#flat) {
      // Folder = project: a plaintext marker makes the folder self-describing (and
      // lets the launcher show its name before unlocking). No catalog in flat mode.
      await this.#driver.write(MARKER, te.encode(JSON.stringify({ app: 'crosstab', name, savedAt })));
      return id;
    }

    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      // The summary carries activePlugins too, so the launcher's rail can seed its
      // picker from a project without loading the whole bundle.
      const idx = cat.entries.findIndex((e) => e.id === id);
      const summary = {
        // `lastOpenedAt` is not in the manifest and never will be — it is a fact about
        // this device, not about the project. The summary is REBUILT here on every save,
        // so it has to be carried across or a save silently resets "recent".
        lastOpenedAt: idx >= 0 ? cat.entries[idx].lastOpenedAt : undefined,
        id,
        name,
        savedAt,
        datasetCount: countDatasets(manifest),
        activePlugins: manifest.activePlugins,
      };
      if (idx >= 0) cat.entries[idx] = summary;
      else cat.entries.push(summary);
      await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
    } finally {
      release();
    }
    return id;
  }

  /**
   * Load a project bundle (manifest + every dataset's sources).
   * @param {string} id
   * @returns {Promise<{id: string, name: string, bundle: {activeId: number, datasets: Array<{id: number, name: string, state: object}>}}>}
   */
  async load(id) {
    const manifest = JSON.parse(await this.#read(this.#file(id, 'project.json')));
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
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const idx = cat.entries.findIndex((e) => e.id === id);
      const summary = {
        lastOpenedAt: idx >= 0 ? cat.entries[idx].lastOpenedAt : undefined, // see #save
        id,
        name: manifest.name,
        savedAt: manifest.savedAt,
        datasetCount: countDatasets(manifest),
        activePlugins: manifest.activePlugins ?? null,
      };
      if (idx >= 0) cat.entries[idx] = summary;
      else cat.entries.push(summary);
      await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
    } finally {
      release();
    }
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
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const e = cat.entries.find((x) => x.id === id);
      if (e) e.name = name;
      await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
    } finally {
      release();
    }
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
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const e = cat.entries.find((x) => x.id === id);
      if (!e) return; // never saved — nothing in the catalog to stamp
      e.lastOpenedAt = when;
      await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
    } catch {
      /* the project is open; the ordering hint is a convenience */
    } finally {
      release();
    }
  }

  async delete(id) {
    if (this.#flat) return; // don't blow away the user's picked folder from here
    await this.#driver.removeTree(`${ROOT}/${id}`);
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      cat.entries = cat.entries.filter((e) => e.id !== id);
      await this.#writePlain(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
    } finally {
      release();
    }
  }

  /**
   * Write only the Parquet sources of a bundle (no `project.json`) — the folder-sync
   * step that lands *my* data so a merged manifest's file refs resolve, while
   * {@link folder-sync} owns `project.json` via the merge (#143). File names match
   * {@link buildManifest}'s (`ds<id>_src<n>.parquet`).
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
  async #sweep(id, manifest) {
    try {
      const keep = new Set();
      for (const op of manifest.log ?? []) {
        if (isSourceOp(op) && op.payload?.src?.file) keep.add(op.payload.src.file);
        else if (op.type === 'addAsset' && op.payload?.id) keep.add(`${ASSET_DIR}/${safeAssetId(op.payload.id)}.bin`);
      }
      for (const name of await this.#driver.list(this.#flat ? '' : `${ROOT}/${id}`)) {
        if (!name.startsWith('src_') || !name.endsWith('.parquet')) continue;
        if (!keep.has(name)) await this.#driver.remove(this.#file(id, name));
      }
      for (const assetId of await this.listAssets(id)) {
        if (!keep.has(`${ASSET_DIR}/${safeAssetId(assetId)}.bin`)) await this.removeAsset(id, assetId);
      }
    } catch (err) {
      console.warn('[project] sweep skipped', err);
    }
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
   * Source ops are numbered in recipe order → `ds<id>_src<n>.parquet`, matching
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
 * `ds<id>_src<n>.parquet` (matching {@link ProjectStore#writeSourcesOnly}).
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
