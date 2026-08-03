/**
 * @file media-store.js
 * Content-addressed store for qualitative MEDIA assets (#139), living **inside the
 * project** (#149 A5).
 *
 * Qualitative coding of audio / image / video keeps the media OUT of the dataset —
 * a multi-GB video does not belong in a Parquet cell. The dataset holds only a
 * lightweight `asset:<sha256>` reference; the bytes live here, keyed by their
 * content hash. Content addressing buys three things at once:
 *   - **dedup** — coding the same file twice stores it once;
 *   - **integrity** — a received asset can be checked against the id the log expects;
 *   - it is the exact primitive the collaboration base-data index (#143, "share this
 *     file!") and at-rest encryption (#144) are designed to build on.
 *
 * The bytes are one file per asset in the project's own `assets/` directory, written
 * through {@link ProjectStore} — so media is encrypted with the project when the project
 * is protected, lands in a synced folder with it, and travels wherever the project goes.
 * It used to live in a separate OPFS root, which meant a shared project's media simply
 * wasn't there for the recipient.
 *
 * The **metadata is an op** (`addAsset`, target `asset:<id>`), not a sidecar file: the
 * log is the index, so it merges, undoes, and travels like everything else, and there is
 * no catalog to fall out of step with the bytes. Nothing is copied anywhere — the id is
 * the content hash, so re-importing the same file writes it once.
 *
 * The store is host-only. A plugin never touches it: it asks `app.media.load(ref)`
 * and gets back an opaque {@link Blob}, so the sandbox stays walled off from the
 * filesystem (see the media service in app.js and the `media-src blob:` CSP variant
 * injected by core/plugin-sandbox.js).
 */

import { liveOps } from './op-log.js';

/** Bus event: the media-asset tier changed (an asset was added or forgotten), so the
 * project is dirty and should autosave. */
export const MEDIA_CHANGED = 'media:changed';

/** The media-asset projection: `addAsset` ops folded to `[{id, type, name, size, ...}]`.
 * The whole index of what the project references; whether the BYTES are here is asked
 * separately (a peer can hold the ref before the file arrives). */
export const ASSETS = {
  key: 'assets',
  match: (op) => op.owner === 'core' && typeof op.target === 'string' && op.target.startsWith('asset:'),
  fold: (ops) => {
    const out = new Map();
    for (const op of liveOps(ops)) {
      if (op.type === 'addAsset') out.set(op.payload.id, { ...op.payload });
      else if (op.type === 'removeAsset') out.delete(op.payload.id);
    }
    return [...out.values()];
  },
};

/** Files up to this size get a full SHA-256 content id (read at once — cheap here);
 * larger files are streamed and fingerprinted instead, so a multi-GB movie never has
 * to sit in RAM to be hashed. */
const FULL_HASH_MAX = 256 * 1024 * 1024; // 256 MB

export class MediaStore {
  /** @type {import('./project-store.js').ProjectStore|null} */
  #store = null;
  /** @type {import('./project-log.js').ProjectLog|null} */
  #log = null;
  /** () => current project id, or null when the project has never been saved. */
  #projectId = () => null;
  /** async () => project id, creating the "Untitled project" if there isn't one yet, so
   * an asset always has a project to live in. */
  #ensureProject = async () => null;
  /** @type {import('./event-bus.js').EventBus|null} */
  #bus = null;

  constructor(deps) {
    if (deps) this.attach(deps);
  }

  /**
   * Point the store at the project tier. Separate from the constructor only because the
   * media service is published to plugins before `ProjectSync` is built; the store is
   * inert (and `available` is false) until this runs.
   *
   * @param {{store?: import('./project-store.js').ProjectStore,
   *          log?: import('./project-log.js').ProjectLog,
   *          projectId?: () => string|null,
   *          ensureProject?: () => Promise<string|null>}} deps
   */
  attach({ store, log, bus, projectId, ensureProject } = {}) {
    this.#store = store ?? this.#store;
    this.#bus = bus ?? this.#bus;
    if (log && log !== this.#log) {
      this.#log = log;
      this.#log.register(ASSETS);
    }
    if (projectId) this.#projectId = projectId;
    if (ensureProject) this.#ensureProject = ensureProject;
  }

  /** @returns {boolean} Whether media can be stored at all (a project store is wired). */
  get available() {
    return !!this.#store;
  }

  /** This project's `asset:` ops — the tier the project save carries in manifest.log. */
  ops() {
    return this.#log ? this.#log.slice(ASSETS.match) : [];
  }

  /** Replace the asset tier on project load/switch: drop the current `asset:` ops and
   * receive the saved ones (ids preserved, so they merge). The BYTES are not touched —
   * they already sit in the project directory this is loading from. */
  restoreOps(ops) {
    if (!this.#log) return;
    this.#log.clearWhere(ASSETS.match);
    this.#log.receiveOps(Array.isArray(ops) ? ops : []);
  }

  /** Metadata for one asset, from the log. Null if the project doesn't reference it. */
  meta(id) {
    return (this.#log?.state('assets') ?? []).find((a) => a.id === id) ?? null;
  }

  /** Record the asset in the log — the index. Content-addressed, so re-importing the
   * same file appends a fresh op that folds to the same entry. */
  #record(info) {
    this.#log?.append({ target: `asset:${info.id}`, owner: 'core', type: 'addAsset', payload: { ...info } });
    this.#changed();
  }

  /** Tell the project an asset op landed, so it autosaves. Appending to the log doesn't
   * emit anything by itself, and without this the manifest would be written from a
   * snapshot taken before the asset existed — bytes on disk, no index. */
  #changed() {
    this.#bus?.emit?.(MEDIA_CHANGED, {});
  }

  /**
   * Store bytes keyed by their SHA-256. Idempotent: re-storing identical bytes is a
   * no-op on the payload (dedup) and just refreshes the metadata sidecar. Any metadata
   * keys are persisted verbatim (type/name plus probed `medium`/`duration`/`width`/
   * `height`, #139), so the asset is self-describing independent of any dataset.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {{type?: string, name?: string, [k: string]: any}} [meta]
   * @returns {Promise<{id: string, size: number, type: string, name: string}>}
   */
  async put(bytes, meta = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const id = await sha256hex(data);
    const info = { id, type: 'application/octet-stream', name: '', ...meta, size: data.byteLength };
    const pid = await this.#ensureProject();
    if (pid == null) throw new Error('media.put: no project to store the asset in');
    await this.#store.writeAsset(pid, id, new Blob([data], { type: info.type }));
    this.#record(info);
    return info;
  }

  /**
   * Store a **File by streaming** it to OPFS — memory-bounded, so a multi-GB movie
   * doesn't OOM (and it dodges the browser's ~2 GB single-blob read wall, since no
   * single read is large). This is the sink an importer plugin drives via `media.put`;
   * the plugin hands over the host-held File *by reference* (no byte copy across the
   * sandbox), and the heavy I/O happens here.
   *
   * The content id is a full SHA-256 for files up to {@link FULL_HASH_MAX} (true dedup
   * + integrity), else a deterministic **fingerprint** of `size ‖ head ‖ tail` — Web
   * Crypto has no streaming digest, so hashing a 4 GB file in full would mean holding
   * it in RAM; the fingerprint is streaming-cheap, still dedups a re-imported file, and
   * has negligible collision risk. Both are plain hex ids — the ref stays opaque.
   *
   * @param {File|Blob} file
   * @param {{type?: string, name?: string, [k: string]: any}} [meta]
   * @returns {Promise<{id: string, size: number, type: string, name: string}>}
   */
  async putFile(file, meta = {}) {
    const id = await this.#idForFile(file);
    const pid = await this.#ensureProject();
    if (pid == null) throw new Error('media.put: no project to store the asset in');
    await this.#store.writeAsset(pid, id, file); // streamed by the driver, never buffered
    const info = {
      id,
      type: file.type || 'application/octet-stream',
      name: file.name || '',
      ...meta,
      size: file.size,
    };
    this.#record(info);
    return info;
  }

  /** Content id for a File: full SHA-256 when small enough to read at once, else a
   * streaming-cheap fingerprint of size + first/last 1 MB (slices are small even for a
   * multi-GB file, so this never materialises the whole thing). */
  async #idForFile(file) {
    if (file.size <= FULL_HASH_MAX) {
      return sha256hex(new Uint8Array(await file.arrayBuffer()));
    }
    const HEAD = 1024 * 1024;
    const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(HEAD, file.size - HEAD)).arrayBuffer());
    const tag = new TextEncoder().encode(`ctfp:${file.size}:`);
    const buf = new Uint8Array(tag.length + head.length + tail.length);
    buf.set(tag, 0);
    buf.set(head, tag.length);
    buf.set(tail, tag.length + head.length);
    return sha256hex(buf);
  }

  /**
   * Read an asset's bytes + metadata, or null if absent (e.g. a ref a collaborator
   * shared before the file itself arrived).
   * @param {string} id
   * @returns {Promise<{bytes: Uint8Array, type: string, name: string, size: number}|null>}
   */
  async get(id) {
    const blob = await this.getBlob(id);
    if (!blob) return null;
    const meta = this.meta(id) ?? {};
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { type: 'application/octet-stream', name: '', ...meta, bytes, size: bytes.byteLength };
  }

  /** Read an asset as a correctly-typed Blob, for handing to a plugin / a media element.
   * Nothing is materialised on the way for an unprotected project (the project file's own
   * handle IS the Blob), so a `<video>` streams straight off disk. Null if the bytes
   * aren't here. */
  async getBlob(id) {
    const pid = this.#projectId();
    if (!this.#store || pid == null) return null;
    return this.#store.readAsset(pid, id, this.meta(id)?.type);
  }

  /** @returns {Promise<boolean>} Whether the asset's bytes are present in this project. */
  async has(id) {
    const pid = this.#projectId();
    if (!this.#store || pid == null) return false;
    return this.#store.hasAsset(pid, id);
  }

  /** Forget an asset: a `removeAsset` op (the index) plus its bytes. */
  async delete(id) {
    const pid = this.#projectId();
    this.#log?.append({ target: `asset:${id}`, owner: 'core', type: 'removeAsset', payload: { id } });
    this.#changed();
    if (this.#store && pid != null) await this.#store.removeAsset(pid, id);
  }

  /** The project's assets, from the log — the index, whether or not the bytes are here
   * yet. `list({present: true})` intersects that with what's actually on disk. */
  async list({ present = false } = {}) {
    const all = this.#log?.state('assets') ?? [];
    if (!present) return all;
    const pid = this.#projectId();
    if (!this.#store || pid == null) return [];
    const held = new Set(await this.#store.listAssets(pid));
    return all.filter((a) => held.has(a.id));
  }

  /** Asset ids the log references but this project has no bytes for — the gap a hand-off
   * or a peer transfer has to fill. */
  async missing() {
    const refs = (this.#log?.state('assets') ?? []).map((a) => a.id);
    const pid = this.#projectId();
    if (!this.#store || pid == null) return refs;
    const held = new Set(await this.#store.listAssets(pid));
    return refs.filter((id) => !held.has(id));
  }
}

/**
 * The host-side media resolver handed to plugins as `app.media`. It is the ONLY
 * door a sandboxed plugin has to media bytes: it returns an opaque Blob and never
 * exposes the store, a handle, or the filesystem. Resolution is **local only** —
 * `asset:` refs read the content-addressed store; `data:` refs are decoded inline
 * (the embed / test path). Anything else is rejected so a ref can never reach the
 * network (the URL fetcher is deliberately deferred — #143/B).
 *
 * @param {MediaStore} store
 * @returns {{ load: (ref: string) => Promise<Blob|null> }}
 */
export function createMediaService(store) {
  return {
    async load(ref) {
      const s = String(ref ?? '');
      if (s.startsWith('asset:')) return store.getBlob(s.slice('asset:'.length));
      if (s.startsWith('data:')) return dataUriToBlob(s);
      throw new Error('media.load: only asset: and data: references are supported (remote URLs are not fetched)');
    },
    /**
     * The write sink an importer plugin drives (#139): stream a host-held File into the
     * store and return its `asset:<id>` ref. The File crosses from the sandbox by
     * reference (no byte copy), and {@link MediaStore#putFile} streams it to OPFS, so
     * even a multi-GB movie is memory-bounded. Returns the ref plus the resolved
     * metadata (id/size/type) for the importer to put in its dataset row.
     */
    async put(file, meta) {
      if (!(file instanceof Blob)) throw new Error('media.put: expected a File/Blob');
      const info = await store.putFile(file, meta || {});
      return { ...info, ref: `asset:${info.id}` };
    },
  };
}

/** Decode a `data:` URI to a typed Blob (base64 or percent-encoded). */
export function dataUriToBlob(uri) {
  const m = /^data:([^;,]*)((?:;[^,]*)*)?,(.*)$/s.exec(String(uri));
  if (!m) throw new Error('media.load: malformed data: URI');
  const type = m[1] || 'text/plain';
  const isB64 = /;base64/i.test(m[2] || '');
  const raw = m[3];
  const bytes = isB64
    ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(raw));
  return new Blob([bytes], { type });
}

/** SHA-256 hex of bytes — the asset id / content hash. Needs a secure context
 * (HTTPS or localhost), which the app already requires for COOP/COEP. */
async function sha256hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Defensive filename guard: ids are lowercase hex, but never let a crafted ref
 * escape the store directory. */
function safe(id) {
  return String(id).replace(/[^a-f0-9]/gi, '');
}
