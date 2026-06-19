/**
 * @file project-store.js
 * Persistent **projects** in OPFS — the top tier of the two-tier model.
 *
 * A *project* is the whole working set: every open dataset (each its own
 * immutable sources + transform log) plus which one is active. It's a living
 * document — saved as one self-contained bundle and autosaved as you work. (The
 * other tier, the reusable building-block dataset library, is {@link DatasetStore}.)
 *
 *   projects/
 *     catalog.json                 — the browse index (one summary per project)
 *     <projectId>/
 *       project.json               — { name, savedAt, activeId, datasets: [...] }
 *       ds<dsId>_src<n>.parquet     — each dataset's immutable sources, flat
 *
 * `project.json` holds every dataset's manifest (metadata + transform log + file
 * refs); the Parquet sources sit alongside, prefixed by dataset id. Autosave can
 * rewrite just `project.json` plus the *changed* dataset's Parquet
 * (`writeSourcesFor`), leaving big unchanged sources on disk — the same
 * cheap-metadata-save trick the dataset library uses, one tier up.
 */

const ROOT = 'projects';
const CATALOG = 'catalog.json';

export class ProjectStore {
  /** @returns {boolean} Whether OPFS is available. */
  get available() {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  /** Project summaries, newest first. */
  async list() {
    const cat = await this.#readCatalog();
    return cat.entries.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
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
    const root = await this.#root(true);
    id = id || crypto.randomUUID();
    const dir = await root.getDirectoryHandle(id, { create: true });

    const datasets = [];
    for (const d of bundle.datasets) {
      const writeSources = !writeSourcesFor || writeSourcesFor.has(d.id);
      const sources = [];
      for (let i = 0; i < d.state.sources.length; i++) {
        const s = d.state.sources[i];
        const file = `ds${d.id}_src${i + 1}.parquet`;
        if (writeSources) {
          if (!s.parquet) throw new Error(`save: dataset ${d.id} source ${i + 1} has no parquet`);
          await this.#write(dir, file, s.parquet);
        }
        const entry = { meta: s.meta, label: s.label ?? null, combine: s.combine ?? 'base', file };
        if (s.combine === 'join') {
          entry.joinKey = s.joinKey;
          entry.aliases = s.aliases ?? [];
        }
        sources.push(entry);
      }
      datasets.push({ id: d.id, name: d.name, sources, transforms: d.state.transforms ?? [] });
    }

    const manifest = { name, savedAt, activeId: bundle.activeId, datasets };
    await this.#write(dir, 'project.json', JSON.stringify(manifest));

    const cat = await this.#readCatalog();
    const summary = { id, name, savedAt, datasetCount: datasets.length };
    const idx = cat.entries.findIndex((e) => e.id === id);
    if (idx >= 0) cat.entries[idx] = summary;
    else cat.entries.push(summary);
    await this.#write(root, CATALOG, JSON.stringify(cat));
    return id;
  }

  /**
   * Load a project bundle (manifest + every dataset's sources).
   * @param {string} id
   * @returns {Promise<{id: string, name: string, bundle: {activeId: number, datasets: Array<{id: number, name: string, state: object}>}}>}
   */
  async load(id) {
    const root = await this.#root();
    const dir = await root.getDirectoryHandle(id);
    const manifest = JSON.parse(await this.#read(dir, 'project.json'));
    const datasets = [];
    for (const d of manifest.datasets) {
      const sources = [];
      for (const s of d.sources) {
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
      datasets.push({ id: d.id, name: d.name, state: { sources, transforms: d.transforms ?? [] } });
    }
    return { id, name: manifest.name, bundle: { activeId: manifest.activeId, datasets } };
  }

  /** Delete a project bundle and drop it from the catalog. */
  async delete(id) {
    const root = await this.#root(true);
    try {
      await root.removeEntry(id, { recursive: true });
    } catch {
      /* already gone */
    }
    const cat = await this.#readCatalog();
    cat.entries = cat.entries.filter((e) => e.id !== id);
    await this.#write(root, CATALOG, JSON.stringify(cat));
  }

  // --- internals -------------------------------------------------------------

  async #root(create = false) {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT, { create });
  }

  async #readCatalog() {
    try {
      const root = await this.#root();
      const parsed = JSON.parse(await this.#read(root, CATALOG));
      return Array.isArray(parsed.entries) ? parsed : { entries: [] };
    } catch {
      return { entries: [] };
    }
  }

  async #write(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
    } finally {
      await w.close();
    }
  }

  async #read(dir, name) {
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
  }

  async #readBytes(dir, name) {
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).arrayBuffer();
  }
}
