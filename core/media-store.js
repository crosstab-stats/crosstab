/**
 * @file media-store.js
 * Content-addressed OPFS store for qualitative MEDIA assets (#139).
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
 * Two files per asset in one flat directory: `<id>.bin` (the bytes) and `<id>.json`
 * (`{type, name, size}`). Deliberately **no shared mutable catalog** — that is the
 * hydrate-before-mount clobber class of bug the workspace store hit; here every asset
 * is self-describing and {@link MediaStore#list} just scans the directory.
 *
 * The store is host-only. A plugin never touches it: it asks `app.media.load(ref)`
 * and gets back an opaque {@link Blob}, so the sandbox stays walled off from the
 * filesystem (see the media service in app.js and the `media-src blob:` CSP variant
 * injected by core/plugin-sandbox.js).
 */

const ROOT = 'media-assets';

/** Files up to this size get a full SHA-256 content id (read at once — cheap here);
 * larger files are streamed and fingerprinted instead, so a multi-GB movie never has
 * to sit in RAM to be hashed. */
const FULL_HASH_MAX = 256 * 1024 * 1024; // 256 MB

export class MediaStore {
  /** @returns {boolean} Whether OPFS is available in this browser. */
  get available() {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
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
    const root = await this.#root(true);
    await this.#write(root, id + '.bin', data);
    const info = { type: 'application/octet-stream', name: '', ...meta, size: data.byteLength };
    await this.#write(root, id + '.json', new TextEncoder().encode(JSON.stringify(info)));
    return { id, ...info };
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
    const root = await this.#root(true);
    const fh = await root.getFileHandle(id + '.bin', { create: true });
    try {
      // pipeTo streams the File chunk-by-chunk into OPFS and closes the writable.
      await file.stream().pipeTo(await fh.createWritable());
    } catch (e) {
      try { await root.removeEntry(id + '.bin'); } catch { /* nothing partial to clean */ }
      throw e;
    }
    const info = {
      type: file.type || 'application/octet-stream',
      name: file.name || '',
      ...meta,
      size: file.size,
    };
    await this.#write(root, id + '.json', new TextEncoder().encode(JSON.stringify(info)));
    return { id, ...info };
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
   * Read an asset's bytes + metadata, or null if absent (e.g. cleared OPFS, or an
   * id a collaborator has referenced but not yet shared).
   * @param {string} id
   * @returns {Promise<{bytes: Uint8Array, type: string, name: string, size: number}|null>}
   */
  async get(id) {
    try {
      const root = await this.#root();
      const bin = await root.getFileHandle(safe(id) + '.bin');
      const bytes = new Uint8Array(await (await bin.getFile()).arrayBuffer());
      let meta = {};
      try {
        const mh = await root.getFileHandle(safe(id) + '.json');
        meta = JSON.parse(await (await mh.getFile()).text());
      } catch {
        /* metadata sidecar missing — fall back to a generic blob */
      }
      // Spread the sidecar so probed fields (medium/duration/width/height) come
      // through; type/name defaulted, size authoritative from the bytes.
      return { type: 'application/octet-stream', name: '', ...meta, bytes, size: bytes.byteLength };
    } catch {
      return null;
    }
  }

  /** Read an asset as a correctly-typed Blob, for handing to a plugin / a media
   * element. Null if the asset isn't present. */
  async getBlob(id) {
    const a = await this.get(id);
    return a ? new Blob([a.bytes], { type: a.type }) : null;
  }

  /** @returns {Promise<boolean>} Whether the asset's bytes are present locally. */
  async has(id) {
    try {
      const root = await this.#root();
      await root.getFileHandle(safe(id) + '.bin');
      return true;
    } catch {
      return false;
    }
  }

  /** Forget an asset's bytes + metadata. Best-effort. */
  async delete(id) {
    const root = await this.#root().catch(() => null);
    if (!root) return;
    for (const suffix of ['.bin', '.json']) {
      try { await root.removeEntry(safe(id) + suffix); } catch { /* already gone */ }
    }
  }

  /** List stored assets (`{id, type, name, size}`) by scanning the directory — no
   * catalog to fall out of sync with the bytes. */
  async list() {
    const out = [];
    try {
      const root = await this.#root();
      for await (const [entryName, handle] of root.entries()) {
        if (handle.kind !== 'file' || !entryName.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(await (await handle.getFile()).text());
          out.push({ id: entryName.slice(0, -'.json'.length), ...meta });
        } catch {
          /* skip a corrupt sidecar */
        }
      }
    } catch {
      /* no store yet */
    }
    return out;
  }

  /** @returns {Promise<FileSystemDirectoryHandle>} */
  async #root(create = false) {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT, { create });
  }

  async #write(dir, filename, data) {
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
    } finally {
      await w.close();
    }
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
