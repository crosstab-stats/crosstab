/**
 * @file storage-driver.js
 * The pluggable storage seam (#143) — a **path-based** byte store that
 * {@link ProjectStore} sits on top of, so where the bytes live (OPFS, a picked
 * folder mirrored to OneDrive/Dropbox, or a future cloud-API driver) is one
 * swappable implementation instead of hardcoded `navigator.storage` calls.
 *
 * ## Why this is a *core* interface, not a sandboxed plugin
 *
 * Storage drivers are unlike the sandboxed analysis plugins: a folder driver needs a
 * main-thread user gesture (`showDirectoryPicker`) and a handle that doesn't survive
 * `postMessage`; a cloud driver moves gigabytes and custodies OAuth tokens (a higher
 * trust tier than a codec). So this is a core-registered driver **interface** that
 * runs on the main thread — the same seam a cloud driver will implement later.
 *
 * ## Crypto sits ABOVE this
 *
 * {@link ProjectStore} encrypts before `write` and decrypts after `read`, so a driver
 * only ever handles opaque bytes. That's what makes an untrusted provider driver safe
 * (it can withhold/corrupt bytes but never read them). Drivers therefore stay dumb:
 * no crypto, no manifest knowledge — just paths and bytes.
 *
 * The interface (all paths are `/`-joined, relative to the driver root):
 *  - `read(path) → Uint8Array | null`  (null = missing)
 *  - `write(path, bytes)`              (creates parent dirs; atomic — see below)
 *  - `writeStream(path, blob)`         (same, without materialising the bytes)
 *  - `remove(path)` / `removeTree(path)`  (no-op if missing)
 *  - `list(dirPath) → string[]`        (child entry names; [] if missing)
 *  - `stat(path) → {size, mtime} | null`
 *  - `available: boolean`, `kind: string`, `capabilities: DriverCapabilities`
 *
 * ## Capabilities are DECLARED, never inferred from `kind`
 *
 * `kind` is a label for logs and diagnostics. Behaviour must come from
 * {@link DriverCapabilities}, because asking "are you the folder driver?" is a question
 * only the two drivers that existed at the time could answer. It had already gone wrong
 * once: `ProjectStore` derived its folder-vs-OPFS behaviour from `kind === 'folder'`
 * while its LAYOUT came from the `flat` flag, so a driver injected through
 * {@link ProjectStore#useDriver} — the seam's whole purpose — got a flat layout and
 * nested behaviour. A third-party driver would have had to lie about its name to be
 * treated correctly, which is the clearest possible sign the question was wrong.
 *
 * `writeStream` is in this list because it is in the code, and a contract that omits a
 * method every implementation must supply is not a contract. It is also the hardest
 * thing to do over HTTP — each provider has its own resumable-upload protocol — so
 * `canStream: false` is a legitimate answer, and the caller falls back to `write`.
 *
 * Atomicity is likewise declared, not assumed. The handle drivers get it from
 * temp-then-rename; WebDAV has `MOVE`, Graph and Dropbox have moves, and S3 has no
 * rename at all. It matters because a folder-sync peer polling a path is exactly who a
 * half-written file hurts, so a driver that cannot promise it has to say so rather than
 * let the store believe otherwise.
 */

/**
 * What a driver can do, as declared facts rather than guesses about its identity.
 *
 * @typedef {object} DriverCapabilities
 * @property {boolean} flat  One project per location: files sit at the root with no
 *   per-project subdirectory and no catalog. Nested (OPFS) holds many projects.
 * @property {boolean} externallySynced  Something other than this tab may write these
 *   bytes — an OS sync client, another device, a co-author. Drives polling and merge.
 * @property {boolean} atomicWrite  A reader at the target path sees the old bytes or
 *   the new ones, never a partial write.
 * @property {boolean} canStream  `writeStream` genuinely streams; false means the
 *   caller should expect it to buffer, and avoid handing it multi-GB blobs.
 */

/** The conservative default for a driver that declares nothing. */
export const DEFAULT_CAPABILITIES = Object.freeze({
  flat: true,
  externallySynced: true,
  atomicWrite: false,
  canStream: false,
});

/** A driver's declared capabilities, with anything unstated defaulted. */
export const capabilitiesOf = (driver) => Object.freeze({
  ...DEFAULT_CAPABILITIES,
  ...(driver?.capabilities ?? {}),
});

/** Non-empty path segments. */
function segs(path) {
  return String(path).split('/').filter(Boolean);
}

/**
 * Base driver over a `FileSystemDirectoryHandle` root (OPFS or a picked folder).
 * A cloud-API driver would implement the same method surface over HTTP instead of
 * extending this.
 */
class HandleDriver {
  /** @type {FileSystemDirectoryHandle | (() => Promise<FileSystemDirectoryHandle>)} */
  #root;
  kind;

  constructor(root, kind) {
    this.#root = root;
    this.kind = kind;
  }

  async #rootHandle() {
    return typeof this.#root === 'function' ? this.#root() : this.#root;
  }

  /** Walk to the directory holding `path`'s leaf, creating parents when `create`. */
  async #dirOf(parts, create) {
    let dir = await this.#rootHandle();
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  }

  async read(path) {
    const parts = segs(path);
    const name = parts.pop();
    try {
      const dir = await this.#dirOf(parts, false);
      const fh = await dir.getFileHandle(name);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch {
      return null; // missing → null (callers decide if that's an error)
    }
  }

  async write(path, bytes) {
    const parts = segs(path);
    const name = parts.pop();
    const dir = await this.#dirOf(parts, true);
    // Atomic: write a temp file, then rename over the target, so a peer polling the
    // real path over a sync folder never reads a half-written file. Fall back to a
    // direct write where `move()` isn't available.
    const tmp = `${name}.tmp`;
    const tfh = await dir.getFileHandle(tmp, { create: true });
    let w = await tfh.createWritable();
    try { await w.write(bytes); } finally { await w.close(); }
    if (typeof tfh.move === 'function') {
      try {
        await tfh.move(name); // rename within the dir (overwrites)
      } catch (err) {
        // e.g. the File System Access API blocks the target extension. Don't leave an
        // orphan `.tmp` behind — clean it up, then surface the failure.
        try { await dir.removeEntry(tmp); } catch { /* best effort */ }
        throw err;
      }
    } else {
      const fh = await dir.getFileHandle(name, { create: true });
      w = await fh.createWritable();
      try { await w.write(bytes); } finally { await w.close(); }
      try { await dir.removeEntry(tmp); } catch { /* best effort */ }
    }
  }

  /**
   * Write a Blob/File by **streaming** it — same atomic temp-then-rename as
   * {@link HandleDriver#write}, but the bytes never sit in RAM as one buffer. This is
   * the media path: a multi-GB movie must reach the project without being materialised
   * (and without hitting the browser's single-blob read wall).
   * @param {string} path @param {Blob} blob
   */
  async writeStream(path, blob) {
    const parts = segs(path);
    const name = parts.pop();
    const dir = await this.#dirOf(parts, true);
    const tmp = `${name}.tmp`;
    const tfh = await dir.getFileHandle(tmp, { create: true });
    try {
      await blob.stream().pipeTo(await tfh.createWritable());
    } catch (err) {
      try { await dir.removeEntry(tmp); } catch { /* nothing partial to clean */ }
      throw err;
    }
    if (typeof tfh.move === 'function') {
      try {
        await tfh.move(name);
      } catch (err) {
        try { await dir.removeEntry(tmp); } catch { /* best effort */ }
        throw err;
      }
    } else {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      try { await (await dir.getFileHandle(tmp)).getFile().then((f) => f.stream().pipeTo(w)); } finally { /* w closed by pipeTo */ }
      try { await dir.removeEntry(tmp); } catch { /* best effort */ }
    }
  }

  /**
   * Read a file as a **Blob** without materialising it — the handle's `File` IS a Blob,
   * so a media element can stream from it and a slice reads only what it needs.
   * @param {string} path @returns {Promise<File|null>}
   */
  async readBlob(path) {
    const parts = segs(path);
    const name = parts.pop();
    try {
      const dir = await this.#dirOf(parts, false);
      return await (await dir.getFileHandle(name)).getFile();
    } catch {
      return null;
    }
  }

  async remove(path) {
    const parts = segs(path);
    const name = parts.pop();
    try {
      const dir = await this.#dirOf(parts, false);
      await dir.removeEntry(name);
    } catch { /* already gone */ }
  }

  async removeTree(path) {
    const parts = segs(path);
    const name = parts.pop();
    try {
      const dir = await this.#dirOf(parts, false);
      await dir.removeEntry(name, { recursive: true });
    } catch { /* already gone */ }
  }

  async list(dirPath) {
    try {
      const dir = await this.#dirOf(segs(dirPath), false);
      const out = [];
      for await (const [n] of dir.entries()) out.push(n);
      return out;
    } catch {
      return [];
    }
  }

  async stat(path) {
    const parts = segs(path);
    const name = parts.pop();
    try {
      const dir = await this.#dirOf(parts, false);
      const f = await (await dir.getFileHandle(name)).getFile();
      return { size: f.size, mtime: f.lastModified };
    } catch {
      return null;
    }
  }

  get available() {
    return true;
  }
}

/** Default driver: the origin's private OPFS. */
export class OpfsDriver extends HandleDriver {
  constructor() {
    super(() => navigator.storage.getDirectory(), 'opfs');
  }

  /** Private to this origin and this tab's browser profile: many projects, and nobody
   * else writing them. */
  get capabilities() {
    return { flat: false, externallySynced: false, atomicWrite: true, canStream: true };
  }

  get available() {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }
}

/** A picked folder (from `showDirectoryPicker`) an OS sync client mirrors to a
 * cloud provider — the folder-backed collaboration transport (#143). */
export class FsaFolderDriver extends HandleDriver {
  constructor(handle) {
    super(handle, 'folder');
  }

  /** The folder IS the project, and an OS sync client mirrors it — so another machine
   * writing these bytes is the normal case, not an edge one. */
  get capabilities() {
    return { flat: true, externallySynced: true, atomicWrite: true, canStream: true };
  }
}
