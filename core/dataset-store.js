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

export class DatasetStore {
  /** Serialises catalog read-modify-write so concurrent saves/deletes can't
   * interleave and orphan/resurrect entries. */
  #tail = Promise.resolve();

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
  async save({ id, name, savedAt, state }, { writeSources = true } = {}) {
    const release = await this.#acquire();
    try {
      return await this.#saveImpl({ id, name, savedAt, state }, { writeSources });
    } finally {
      release();
    }
  }

  async #saveImpl({ id, name, savedAt, state }, { writeSources = true } = {}) {
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

    const sources = [];
    for (let i = 0; i < state.sources.length; i++) {
      const s = state.sources[i];
      const file = `source_${i + 1}.parquet`;
      if (writeSources) {
        if (!s.parquet) throw new Error(`save: source ${i + 1} has no parquet bytes`);
        await this.#write(dir, file, s.parquet);
      }
      const entry = { meta: s.meta, label: s.label ?? null, file, combine: s.combine ?? 'base' };
      if (s.combine === 'join') {
        entry.joinKey = s.joinKey;
        entry.aliases = s.aliases ?? [];
      }
      sources.push(entry);
    }

    const manifest = { name, savedAt, version, sources, transforms: state.transforms ?? [], order: state.order ?? null };
    await this.#write(dir, 'manifest.json', JSON.stringify(manifest));

    const summary = {
      id,
      name,
      savedAt,
      version,
      rowCount: state.rowCount ?? 0,
      varCount: state.varCount ?? 0,
      sourceCount: state.sources.length,
    };
    const idx = cat.entries.findIndex((e) => e.id === id);
    if (idx >= 0) cat.entries[idx] = summary;
    else cat.entries.push(summary);
    await this.#write(root, CATALOG, JSON.stringify(cat));

    return { id, version };
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
    const sources = [];
    for (const s of manifest.sources) {
      const buf = await this.#readBytes(dir, s.file);
      sources.push({
        meta: s.meta,
        label: s.label ?? null,
        combine: s.combine ?? 'base',
        joinKey: s.joinKey,
        aliases: s.aliases,
        parquet: new Uint8Array(buf),
      });
    }
    return {
      id,
      name: manifest.name,
      savedAt: manifest.savedAt,
      version: manifest.version ?? 1,
      state: { sources, transforms: manifest.transforms ?? [], order: manifest.order ?? null },
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

  // --- internals -------------------------------------------------------------

  /** @returns {Promise<FileSystemDirectoryHandle>} the library root dir. */
  async #root(create = false) {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT, { create });
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
