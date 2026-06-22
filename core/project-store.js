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
  /** Serialises catalog read-modify-write ops so an autosave can't interleave
   * with a delete/rename and resurrect a just-removed entry (orphan in the list). */
  #tail = Promise.resolve();

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

  /** Project summaries, newest first. Self-heals: drops catalog entries whose
   * bundle folder is missing (e.g. left by an old race) so the manager never
   * lists a project that can't be opened. */
  async list() {
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const kept = [];
      let dropped = false;
      const root = await this.#root(true);
      for (const e of cat.entries) {
        let ok = false;
        try {
          await root.getDirectoryHandle(e.id);
          ok = true;
        } catch {
          ok = false;
        }
        if (ok) kept.push(e);
        else dropped = true;
      }
      if (dropped) await this.#write(root, CATALOG, JSON.stringify({ entries: kept }));
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
        // A wide source's `file` is a single read_parquet-backed Parquet (not a
        // table); the flag tells load/restore to re-register it rather than CTAS it.
        if (s.wide) {
          entry.wide = true;
          entry.rowidBase = s.rowidBase;
        }
        sources.push(entry);
      }
      datasets.push({
        id: d.id,
        name: d.name,
        libraryLink: d.libraryLink ?? null,
        sources,
        transforms: d.state.transforms ?? [],
        order: d.state.order ?? null,
      });
    }

    // `activePlugins` (load keys of the plugins active when saved) lets opening a
    // project restore its analysis set. Null/absent ⇒ pre-feature save ⇒ leave the
    // current plugin set alone on open (back-compatible).
    const activePlugins = Array.isArray(bundle.activePlugins) ? bundle.activePlugins : null;
    // Plugin workspace blobs (#93), keyed by workspace id — opaque to the host,
    // preserved verbatim (incl. ids whose plugin isn't installed here).
    const workspaces = bundle.workspaces && typeof bundle.workspaces === 'object' ? bundle.workspaces : null;
    // The Output tab's result model (#103) — sections/tables/plots/text/errors.
    const output = Array.isArray(bundle.output) ? bundle.output : null;
    const manifest = { name, savedAt, activeId: bundle.activeId, activePlugins, workspaces, output, datasets };
    await this.#write(dir, 'project.json', JSON.stringify(manifest));

    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      // The summary carries activePlugins too, so the launcher's rail can seed its
      // picker from a project without loading the whole bundle.
      const summary = { id, name, savedAt, datasetCount: datasets.length, activePlugins };
      const idx = cat.entries.findIndex((e) => e.id === id);
      if (idx >= 0) cat.entries[idx] = summary;
      else cat.entries.push(summary);
      await this.#write(root, CATALOG, JSON.stringify(cat));
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
          wide: s.wide ?? false,
          rowidBase: s.rowidBase,
          parquet: new Uint8Array(buf),
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
        datasets,
      },
    };
  }

  /** Rename a project (updates its manifest + the catalog). */
  async rename(id, name) {
    const root = await this.#root(true);
    const dir = await root.getDirectoryHandle(id);
    const manifest = JSON.parse(await this.#read(dir, 'project.json'));
    manifest.name = name;
    await this.#write(dir, 'project.json', JSON.stringify(manifest));
    const release = await this.#acquire();
    try {
      const cat = await this.#readCatalog();
      const e = cat.entries.find((x) => x.id === id);
      if (e) e.name = name;
      await this.#write(root, CATALOG, JSON.stringify(cat));
    } finally {
      release();
    }
  }

  /** Delete a project bundle and drop it from the catalog. */
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
