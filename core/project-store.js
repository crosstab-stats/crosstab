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
 *       project.json               — { name, savedAt, activeId, datasets: [...] }
 *       project.base.json          — the sync common-ancestor snapshot (#143)
 *       ds<dsId>_src<n>.parquet     — each dataset's immutable sources, flat
 *
 * Bytes live behind a swappable {@link StorageDriver} (OPFS by default, or a picked
 * folder mirrored to OneDrive/Dropbox — {@link ProjectStore#useDirectory}), so the
 * *where* is one implementation and a future cloud-API driver reuses the same seam.
 * At-rest **encryption** ({@link ProjectStore#unlock}) sits ABOVE the driver: bytes
 * are enciphered before `write` and deciphered after `read`, so a driver — even an
 * untrusted provider — only ever sees ciphertext (#143/#144).
 */

import { OpfsDriver, FsaFolderDriver } from './storage-driver.js';
import { deriveKey, encryptWithKey, decryptWithKey, isEnveloped, newSalt, DEFAULT_ITERATIONS } from './crypto-envelope.js';

const ROOT = 'projects';
const CATALOG = 'catalog.json';
const ENC_META = 'crosstab-encryption.json'; // plaintext salt/verifier for the folder
const MARKER = 'crosstab-project.json'; // plaintext "this folder IS a CrossTab project" + display name
const VERIFIER = 'crosstab-folder-v1'; // known token, encrypted, to check a passphrase on unlock

/** In flat (folder) mode there's exactly one project and the id is vestigial — this
 * stands in wherever the id-centric API needs one. */
export const FOLDER_PROJECT_ID = '.';

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
   * (`project.json`, `project.base.json`, Parquet, and the catalog) is written as a
   * ciphertext envelope and decrypted on read — so a driver / cloud provider that
   * mirrors the folder only ever sees ciphertext. The salt + a verifier live
   * plaintext in `crosstab-encryption.json` (a salt isn't secret). */
  #key = null;

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
  useDriver(driver, { flat = true } = {}) {
    this.#driver = driver ?? new OpfsDriver();
    this.#flat = driver ? flat : false;
  }

  /** Path of a project file, respecting the layout. Flat (folder): the bare name.
   * Nested (OPFS): `projects/<id>/<name>`. */
  #path(id, name) {
    return this.#flat ? name : `${ROOT}/${id}/${name}`;
  }

  /** Path of the plaintext encryption meta (salt/verifier). */
  #metaPath() {
    return this.#flat ? ENC_META : `${ROOT}/${ENC_META}`;
  }

  /** @returns {boolean} Whether the store is currently folder-backed (vs OPFS). */
  get folderBacked() {
    return this.#driver.kind === 'folder';
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
  async unlock(passphrase) {
    // The salt/verifier meta is plaintext — read/write it via the driver DIRECTLY,
    // bypassing the crypto wrappers (chicken-and-egg: we need it to derive the key).
    const metaPath = this.#metaPath();
    let meta = null;
    const rawMeta = await this.#driver.read(metaPath);
    if (rawMeta) { try { meta = JSON.parse(new TextDecoder().decode(rawMeta)); } catch { meta = null; } }

    const salt = meta ? unb64(meta.salt) : newSalt();
    const iterations = meta?.iterations || DEFAULT_ITERATIONS;
    const key = await deriveKey(passphrase, salt, iterations);

    if (meta?.verifier) {
      let ok = false;
      try { ok = new TextDecoder().decode(await decryptWithKey(key, unb64(meta.verifier))) === VERIFIER; } catch { ok = false; }
      if (!ok) throw new Error('Wrong passphrase for this folder.');
    } else {
      const verifier = b64(await encryptWithKey(key, VERIFIER));
      await this.#driver.write(metaPath, te.encode(JSON.stringify({ v: 1, salt: b64(salt), iterations, verifier })));
    }
    this.#key = key;
  }

  /** Drop the in-memory key (e.g. closing a folder project). */
  lock() {
    this.#key = null;
  }

  /** @returns {Promise<boolean>} Whether this store already has encryption set up
   * (an `crosstab-encryption.json` present) — so an open flow knows to *enter* an
   * existing passphrase vs *set* a new one. */
  async hasEncryption() {
    return !!(await this.#driver.read(this.#metaPath()));
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
      return m ? [{ id: FOLDER_PROJECT_ID, name: m.name, savedAt: m.savedAt, datasetCount: (m.datasets ?? []).length, activePlugins: m.activePlugins ?? null }] : [];
    }
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const present = new Set(await this.#driver.list(ROOT));
      const kept = cat.entries.filter((e) => present.has(e.id));
      if (kept.length !== cat.entries.length) await this.#write(`${ROOT}/${CATALOG}`, JSON.stringify({ entries: kept }));
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

    // Parquet first, then the manifest — the same manifest shape folder-sync merges,
    // built by the shared {@link buildManifest} so save and sync never drift.
    await this.#writeSources(id, bundle, writeSourcesFor);
    const manifest = buildManifest({ name, savedAt, bundle });
    await this.#write(this.#file(id, 'project.json'), JSON.stringify(manifest));

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
      const summary = { id, name, savedAt, datasetCount: manifest.datasets.length, activePlugins: manifest.activePlugins };
      const idx = cat.entries.findIndex((e) => e.id === id);
      if (idx >= 0) cat.entries[idx] = summary;
      else cat.entries.push(summary);
      await this.#write(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
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
    const datasets = [];
    for (const d of manifest.datasets) {
      const sources = [];
      for (const s of d.sources) {
        const bytes = await this.#readBytes(this.#file(id, s.file));
        sources.push({
          id: s.id ?? undefined, // stable merge identity (absent on pre-collab saves → restore re-derives it)
          meta: s.meta,
          label: s.label ?? null,
          combine: s.combine ?? 'base',
          joinKey: s.joinKey,
          aliases: s.aliases,
          wide: s.wide ?? false,
          rowidBase: s.rowidBase,
          parquet: new Uint8Array(bytes),
        });
      }
      datasets.push({
        id: d.id,
        name: d.name,
        libraryLink: d.libraryLink ?? null,
        state: { sources, transforms: d.transforms ?? [], order: d.order ?? null },
      });
    }
    return {
      id,
      name: manifest.name,
      bundle: {
        activeId: manifest.activeId,
        activePlugins: Array.isArray(manifest.activePlugins) ? manifest.activePlugins : null,
        workspaces: manifest.workspaces && typeof manifest.workspaces === 'object' ? manifest.workspaces : null,
        output: Array.isArray(manifest.output) ? manifest.output : null,
        collabId: manifest.collabId ?? null,
        collabSecret: manifest.collabSecret ?? null,
        datasets,
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
    } catch {
      return null;
    }
  }

  /**
   * The **common-ancestor** snapshot for merge (#143): the last manifest this client
   * successfully synced, stored as a `project.base.json` sidecar in the bundle. A
   * three-way merge diffs *my* current manifest and *their* on-disk manifest against
   * this base. After a successful sync, the merged manifest becomes the new base.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async readBase(id) {
    try {
      return JSON.parse(await this.#read(this.#file(id, 'project.base.json')));
    } catch {
      return null;
    }
  }

  /** Record the common-ancestor snapshot (see {@link ProjectStore#readBase}). */
  async writeBase(id, manifest) {
    await this.#write(this.#file(id, 'project.base.json'), JSON.stringify(manifest));
  }

  /**
   * Write a **merged** manifest straight to `project.json` (folder-sync, #143) —
   * the result of a three-way merge, whose dataset `file` refs point at Parquet the
   * OS sync client has already mirrored from both sides (so no bytes to write here).
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
      const summary = { id, name: manifest.name, savedAt: manifest.savedAt, datasetCount: (manifest.datasets ?? []).length, activePlugins: manifest.activePlugins ?? null };
      const idx = cat.entries.findIndex((e) => e.id === id);
      if (idx >= 0) cat.entries[idx] = summary;
      else cat.entries.push(summary);
      await this.#write(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
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
      await this.#write(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
    } finally {
      release();
    }
  }

  /** Delete a project bundle and drop it from the catalog. (Not used in flat/folder
   * mode — a folder project is deleted by the user removing the folder.) */
  async delete(id) {
    if (this.#flat) return; // don't blow away the user's picked folder from here
    await this.#driver.removeTree(`${ROOT}/${id}`);
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      cat.entries = cat.entries.filter((e) => e.id !== id);
      await this.#write(`${ROOT}/${CATALOG}`, JSON.stringify(cat));
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

  // --- internals -------------------------------------------------------------

  /** Path of a file inside a project bundle (layout-aware; see {@link ProjectStore#useDirectory}). */
  #file(id, name) {
    return this.#path(id, name);
  }

  async #readCatalog() {
    try {
      const parsed = JSON.parse(await this.#read(`${ROOT}/${CATALOG}`));
      return Array.isArray(parsed.entries) ? parsed : { entries: [] };
    } catch {
      return { entries: [] };
    }
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
      return decryptWithKey(this.#key, raw);
    }
    return raw;
  }

  async #read(path) {
    return new TextDecoder().decode(await this.#readRaw(path));
  }

  async #readBytes(path) {
    return this.#readRaw(path); // Uint8Array (callers wrap as needed)
  }

  /** Write each dataset's Parquet sources (all datasets, or only those in `only`). */
  async #writeSources(id, bundle, only) {
    for (const d of bundle.datasets) {
      if (only && !only.has(d.id)) continue;
      for (let i = 0; i < d.state.sources.length; i++) {
        const s = d.state.sources[i];
        if (!s.parquet) throw new Error(`save: dataset ${d.id} source ${i + 1} has no parquet`);
        await this.#write(this.#file(id, `ds${d.id}_src${i + 1}.parquet`), s.parquet);
      }
    }
  }
}

/**
 * Build the `project.json` **manifest** (metadata + transform logs + Parquet file
 * refs, no bytes) from an in-memory bundle — the exact shape {@link ProjectStore#save}
 * writes and {@link module:core/collab-sync~mergeManifests} merges. Pure, so it also
 * produces "my" manifest for a folder sync without touching disk. File refs follow
 * `ds<id>_src<n>.parquet` (matching {@link ProjectStore#writeSourcesOnly}).
 *
 * @param {{name: string, savedAt: number, bundle: object}} arg
 * @returns {object} the manifest
 */
export function buildManifest({ name, savedAt, bundle }) {
  const datasets = [];
  for (const d of bundle.datasets) {
    const sources = [];
    for (let i = 0; i < d.state.sources.length; i++) {
      const s = d.state.sources[i];
      const entry = { id: s.id ?? null, meta: s.meta, label: s.label ?? null, combine: s.combine ?? 'base', file: `ds${d.id}_src${i + 1}.parquet` };
      if (s.combine === 'join') {
        entry.joinKey = s.joinKey;
        entry.aliases = s.aliases ?? [];
      }
      if (s.wide) {
        entry.wide = true;
        entry.rowidBase = s.rowidBase;
      }
      sources.push(entry);
    }
    datasets.push({ id: d.id, name: d.name, libraryLink: d.libraryLink ?? null, sources, transforms: d.state.transforms ?? [], order: d.state.order ?? null });
  }
  return {
    name,
    savedAt,
    activeId: bundle.activeId,
    activePlugins: Array.isArray(bundle.activePlugins) ? bundle.activePlugins : null,
    workspaces: bundle.workspaces && typeof bundle.workspaces === 'object' ? bundle.workspaces : null,
    output: Array.isArray(bundle.output) ? bundle.output : null,
    // Collaboration identity (#143): carried in the manifest so it rides folder sync —
    // both peers derive the same signaling room + secret. Minted by the app on save.
    collabId: bundle.collabId ?? null,
    collabSecret: bundle.collabSecret ?? null,
    datasets,
  };
}
