/**
 * @file plugin-package-store.js
 * Durable storage for added **plugin packages** (`.ctplugin`), backed by OPFS (#119).
 *
 * A single-file plugin persists its small source string in localStorage (see the
 * PluginManager `#user` entries). A *packaged* plugin also carries binary assets
 * (a WASM module can be hundreds of KB) — too big and too binary for localStorage —
 * so its raw `.ctplugin` bytes live here in OPFS instead, keyed by the plugin's load
 * key. localStorage keeps only the small entry record (key, name, kind:'package');
 * this holds the bytes, so a packaged plugin survives reload like everything else.
 *
 * One flat directory of `<key>.ctplugin` blobs — no catalog needed (the
 * PluginManager's `#user` list is the index of which keys exist).
 */

const ROOT = 'plugin-packages';

export class PluginPackageStore {
  /** @returns {boolean} Whether OPFS is available in this browser. */
  get available() {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  /** Persist a package's raw `.ctplugin` bytes under a plugin load key. */
  async save(key, bytes) {
    const root = await this.#root(true);
    await this.#write(root, fileFor(key), bytes);
  }

  /** Read a package's bytes, or null if absent (e.g. cleared OPFS). */
  async load(key) {
    try {
      const root = await this.#root();
      const fh = await root.getFileHandle(fileFor(key));
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Forget a package's bytes (on plugin removal). Best-effort. */
  async delete(key) {
    try {
      const root = await this.#root();
      await root.removeEntry(fileFor(key));
    } catch {
      /* already gone */
    }
  }

  /** @returns {Promise<FileSystemDirectoryHandle>} */
  async #root(create = false) {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT, { create });
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
}

/** A filesystem-safe filename for a plugin load key. */
function fileFor(key) {
  return `${String(key).replace(/[^\w.-]+/g, '_')}.ctplugin`;
}
