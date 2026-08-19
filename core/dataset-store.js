/**
 * @file dataset-store.js
 * Persistent dataset library, backed by the **Origin Private File System** (OPFS).
 *
 * Re-importing data (especially via `haven`) is slow; the library caches the
 * *post-import* result so reload is near-instant. OPFS is the right backing
 * store: it's persistent, large (~10 GB quota), and — unlike the File System
 * Access "pick a folder" API — works on iPad Safari as well as Chrome, which is
 * our target. It is also **origin-scoped**, so a sandboxed plugin gets its *own*
 * OPFS, never the host's — which is exactly why persistence has to live here, in
 * the engine, rather than in a plugin.
 *
 * ## What a saved entry contains (the "save everything" model)
 * Because sources are immutable and edits are a replayable transform log, a saved
 * entry stores the **whole reproducible stack**, not a flattened snapshot:
 *
 *   datasets/
 *     catalog.json                 — the browse index (one summary per entry)
 *     <id>/
 *       manifest.json              — { name, savedAt, sources:[{meta,label,file}], transforms, … }
 *       source_1.parquet           — each immutable source, verbatim
 *       source_2.parquet
 *       …
 *
 * Reload reconstructs sources + log → the derived view, so undo and provenance
 * survive a round-trip, and a pooled multi-file dataset saves naturally (N
 * sources). The big Parquet files are written once; metadata-only edits rewrite
 * just `manifest.json` + the catalog (see `writeSources:false`), which is what
 * makes autosave-on-every-edit cheap.
 */

/** Subdirectory of OPFS that holds the library. */
const ROOT = 'datasets';
const CATALOG = 'catalog.json';

/** Source op types — their bytes are written as Parquet sidecars; every other op is a
 * light transform stored inline in the manifest. Mirrors data-store's SOURCE_OPS and
 * the folded recipe {@link module:core/data-store~DataStore#exportState} produces. */
const SOURCE_TYPES = new Set(['load', 'append', 'join']);
const isSourceOp = (op) => SOURCE_TYPES.has(op?.type);

/**
 * @typedef {Object} SourceState
 * @property {import('./data-store.js').VariableMeta[]} meta - The source's as-imported metadata.
 * @property {string|null} label - Provenance label (e.g. a file basename).
 * @property {Uint8Array} [parquet] - The source's data (omitted on a sidecar-only save).
 */

/**
 * @typedef {Object} DatasetState
 * @property {SourceState[]} sources
 * @property {Array<object>} transforms - The transform log.
 * @property {number} [rowCount]
 * @property {number} [varCount]
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} id
 * @property {string} name
 * @property {number} savedAt - epoch ms
 * @property {number} rowCount
 * @property {number} varCount
 * @property {number} sourceCount
 */

/** Content ids are hex, but never let a crafted one escape the block directory. */
const safeAssetName = (id) => String(id).replace(/[^a-z0-9]/gi, '').slice(0, 96);

/**
 * A stored record-block manifest as the shape callers consume.
 *
 * Pure and exported for one specific reason: this mapping was written field by field
 * inside `load()`, and when `children` was added to the write side nobody added it here —
 * so every block on disk was complete and every add produced an empty codebook, with
 * nothing failing anywhere. A hand-rolled projection of a growing shape is exactly the
 * kind of code that needs a test, and it could not have one while it was inline.
 *
 * @param {string} id @param {object} manifest @param {object[]} assets  bytes already read
 */
export function recordBlockFromManifest(id, manifest, assets = []) {
  return {
    id,
    kind: 'record',
    name: manifest?.name ?? '',
    savedAt: manifest?.savedAt ?? 0,
    version: manifest?.version ?? 1,
    record: manifest?.record ?? null,
    // The records COMPOSED into this one — a codebook's codes travel with the codebook.
    children: Array.isArray(manifest?.children) ? manifest.children : [],
    assets,
  };
}

export class DatasetStore {
  /** Serialises catalog read-modify-write so concurrent saves/deletes can't
   * interleave and orphan/resurrect entries. */
  #tail = Promise.resolve();

  /** OPFS subdirectory this store occupies. Defaults to the dataset library; a
   * second instance can pass a different name to scope a separate area on the same
   * proven machinery (e.g. the per-project recycle bin — see #115). */
  #rootName;

  constructor(root = ROOT) {
    this.#rootName = root;
  }

  /** @returns {Promise<boolean>} Whether OPFS is available in this browser. */
  get available() {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
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

  /** The browse index, newest first. Self-heals: drops catalog entries whose
   * folder is missing so a building block that can't be loaded isn't listed. */
  async list() {
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const root = await this.#root(true);
      const kept = [];
      let dropped = false;
      for (const e of cat.entries) {
        try {
          await root.getDirectoryHandle(e.id);
          kept.push(e);
        } catch {
          dropped = true;
        }
      }
      if (dropped) await this.#write(root, CATALOG, JSON.stringify({ entries: kept }));
      return kept.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    } finally {
      release();
    }
  }

  /**
   * Create or overwrite an entry. With `writeSources:false` the source Parquet
   * files are left untouched (the cheap autosave path) and only `manifest.json`
   * + the catalog are rewritten — valid only when the entry already exists with
   * its sources on disk.
   *
   * A building block is **versioned**: a new entry starts at V1, and overwriting
   * an existing one (same `id`) bumps the version — the basis for linked datasets
   * tracking "linked to V<n>".
   *
   * @param {{id?: string, name: string, savedAt: number, state: DatasetState}} entry
   * @param {{writeSources?: boolean}} [opts]
   * @returns {Promise<{id: string, version: number}>} The entry id + new version.
   */
  async save({ id, name, savedAt, state, extra }, { writeSources = true } = {}) {
    const release = await this.#acquire();
    try {
      return await this.#saveImpl({ id, name, savedAt, state, extra }, { writeSources });
    } finally {
      release();
    }
  }

  async #saveImpl({ id, name, savedAt, state, extra }, { writeSources = true } = {}) {
    // Ask the browser to keep this data (OPFS is evictable by default).
    if (navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        /* best effort */
      }
    }
    const root = await this.#root(true);
    id = id || crypto.randomUUID();
    const dir = await root.getDirectoryHandle(id, { create: true });

    const cat = await this.#readCatalog();
    const existing = cat.entries.find((e) => e.id === id);
    const version = existing ? (existing.version || 1) + 1 : 1;

    // The dataset's FOLDED reproducible recipe as an ordered op list (the shape
    // {@link module:core/data-store~DataStore#exportState} produces): source ops carry a
    // Parquet FILE ref (bytes written separately), transform ops are inline + light.
    const ops = [];
    let n = 0;
    for (const op of state.ops ?? []) {
      if (isSourceOp(op)) {
        n++;
        const file = `source_${n}.parquet`;
        if (writeSources) {
          if (!op.src?.parquet) throw new Error(`save: source ${n} has no parquet bytes`);
          await this.#write(dir, file, op.src.parquet);
        }
        const src = { meta: op.src.meta, label: op.src.label ?? null };
        if (op.src.wide) { src.wide = true; src.rowidBase = op.src.rowidBase; }
        const entry = { type: op.type, src, file };
        if (op.author) entry.author = op.author;
        if (op.type === 'join') { entry.joinKey = op.joinKey; entry.aliases = op.aliases ?? []; entry.joinType = op.joinType ?? 'left'; }
        ops.push(entry);
      } else {
        ops.push(op); // transform op — no bytes, store as-is
      }
    }

    const manifest = { name, savedAt, version, ops };
    await this.#write(dir, 'manifest.json', JSON.stringify(manifest));

    const summary = {
      id,
      name,
      savedAt,
      version,
      rowCount: state.rowCount ?? 0,
      varCount: state.varCount ?? 0,
      sourceCount: n,
      // Caller-supplied catalog fields (e.g. the recycle bin's projectId + deletedAt),
      // carried verbatim into the browse index so list() can filter on them.
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    const idx = cat.entries.findIndex((e) => e.id === id);
    if (idx >= 0) cat.entries[idx] = summary;
    else cat.entries.push(summary);
    await this.#write(root, CATALOG, JSON.stringify(cat));

    return { id, version };
  }

  /**
   * Save a **record** block — a plugin's item record plus the asset bytes it references
   * (#153 step 4). The library's other entries are datasets; this is the second kind, and
   * the reason #146's "building-block eligibility" was parked pending a contract that
   * could hold something other than a dataset.
   *
   * Versioned identically to a dataset block, and stored in the same catalog so one list
   * shows both — which is what the user asked for: an item looks the same wherever it is.
   *
   * @param {{id?: string, name: string, savedAt: number,
   *          record: {owner: string, collection: string, fields: object},
   *          assets?: Array<{id: string, bytes: Uint8Array, type?: string, name?: string}>}} entry
   * @returns {Promise<{id: string, version: number}>}
   */
  async saveRecord({ id, name, savedAt, record, children = [], assets = [] }) {
    const release = await this.#acquire();
    try {
      if (navigator.storage?.persist) {
        try { await navigator.storage.persist(); } catch { /* best effort */ }
      }
      const root = await this.#root(true);
      id = id || crypto.randomUUID();
      const dir = await root.getDirectoryHandle(id, { create: true });
      const cat = await this.#readCatalog();
      const existing = cat.entries.find((e) => e.id === id);
      const version = existing ? (existing.version || 1) + 1 : 1;

      // Asset bytes ride as sidecars, keyed by their ORIGINAL content id. On add the
      // bytes are re-stored in the destination project, which — being content-addressed
      // — mints the same id again, so a block added twice shares one copy.
      const stored = [];
      for (const a of assets) {
        if (!a?.id || !a.bytes) continue;
        const file = `asset_${safeAssetName(a.id)}.bin`;
        await this.#write(dir, file, a.bytes);
        stored.push({ id: a.id, file, type: a.type ?? 'application/octet-stream', name: a.name ?? '' });
      }

      // `children` are the records COMPOSED into this one (#166): a codebook's codes
      // travel with the codebook, because a codebook without its codes is a name. They
      // keep their ids, which is what lets a later pull match them against this
      // project's copies instead of duplicating everything.
      const manifest = { kind: 'record', name, savedAt, version, record, children, assets: stored };
      await this.#write(dir, 'manifest.json', JSON.stringify(manifest));

      const summary = {
        id, name, savedAt, version,
        kind: 'record',
        collection: record?.collection ?? null,
        childCount: children.length,
        assetCount: stored.length,
      };
      const idx = cat.entries.findIndex((e) => e.id === id);
      if (idx >= 0) cat.entries[idx] = summary;
      else cat.entries.push(summary);
      await this.#write(root, CATALOG, JSON.stringify(cat));
      return { id, version };
    } finally {
      release();
    }
  }

  /**
   * Load an entry, reading its manifest and every source Parquet.
   * @param {string} id
   * @returns {Promise<{id: string, name: string, savedAt: number, state: DatasetState}>}
   */
  async load(id) {
    const root = await this.#root();
    const dir = await root.getDirectoryHandle(id);
    const manifest = JSON.parse(await this.#read(dir, 'manifest.json'));
    // A record block carries no op recipe — just the record and its asset bytes (#153).
    if (manifest.kind === 'record') {
      const assets = [];
      for (const a of manifest.assets ?? []) {
        try {
          assets.push({ ...a, bytes: new Uint8Array(await this.#readBytes(dir, a.file)) });
        } catch (e) {
          console.warn('[library] asset missing from block', a.file, e);
        }
      }
      return recordBlockFromManifest(id, manifest, assets);
    }
    // The folded op recipe (the shape DataStore.restoreState consumes): source ops get
    // their Parquet re-attached from the sidecar; transform ops are inline.
    const ops = [];
    for (const op of manifest.ops ?? []) {
      if (isSourceOp(op)) {
        const buf = await this.#readBytes(dir, op.file);
        const src = { meta: op.src.meta, label: op.src.label ?? null, parquet: new Uint8Array(buf) };
        if (op.src.wide) { src.wide = true; src.rowidBase = op.src.rowidBase; }
        const restored = { type: op.type, src };
        if (op.author) restored.author = op.author;
        if (op.type === 'join') { restored.joinKey = op.joinKey; restored.aliases = op.aliases ?? []; restored.joinType = op.joinType ?? 'left'; }
        ops.push(restored);
      } else {
        ops.push(op);
      }
    }
    return {
      id,
      name: manifest.name,
      savedAt: manifest.savedAt,
      version: manifest.version ?? 1,
      state: { ops },
    };
  }

  /**
   * Delete an entry (its folder) and drop it from the catalog.
   * @param {string} id
   */
  async delete(id) {
    const root = await this.#root(true);
    try {
      await root.removeEntry(id, { recursive: true });
    } catch {
      /* already gone */
    }
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      cat.entries = cat.entries.filter((e) => e.id !== id);
      await this.#write(root, CATALOG, JSON.stringify(cat));
    } finally {
      release();
    }
  }

  /**
   * Merge `extra` into an entry's catalog summary in place (no folder/Parquet I/O).
   * Used by the recycle bin to re-scope an "unsaved"-project deletion onto the
   * project once it's saved and gets a real id (#115), so the entry follows the
   * project instead of leaking across projects. No-op if the id is unknown.
   * @param {string} id
   * @param {Record<string, any>} extra
   */
  async retag(id, extra) {
    const release = await this.#acquire();
    try {
      const root = await this.#root(true);
      const cat = await this.#readCatalog();
      const e = cat.entries.find((x) => x.id === id);
      if (e) {
        Object.assign(e, extra);
        await this.#write(root, CATALOG, JSON.stringify(cat));
      }
    } finally {
      release();
    }
  }

  // --- internals -------------------------------------------------------------

  /** @returns {Promise<FileSystemDirectoryHandle>} the library root dir. */
  async #root(create = false) {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(this.#rootName, { create });
  }

  /** @returns {Promise<{entries: CatalogEntry[]}>} the catalog, or an empty one. */
  async #readCatalog() {
    try {
      const root = await this.#root();
      const txt = await this.#read(root, CATALOG);
      const parsed = JSON.parse(txt);
      return Array.isArray(parsed.entries) ? parsed : { entries: [] };
    } catch {
      return { entries: [] };
    }
  }

  /** Write a string or bytes to `name` in `dir`, replacing any existing file. */
  async #write(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
    } finally {
      await w.close();
    }
  }

  /** Read `name` in `dir` as text. */
  async #read(dir, name) {
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
  }

  /** Read `name` in `dir` as an ArrayBuffer. */
  async #readBytes(dir, name) {
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).arrayBuffer();
  }
}
