/**
 * @file storage-webdav.js
 * WebDAV as a storage driver (#143) — the first non-handle backend.
 *
 * ## Why WebDAV first
 *
 * It is a PROTOCOL, not a vendor. One driver plus a server URL reaches ownCloud,
 * Nextcloud, Synology, Seafile, and a long tail of self-hosted boxes, with no code per
 * provider. That is the whole argument for choosing this axis: the alternative — a
 * driver per company — would have written most of this file several times over.
 *
 * It is also the honest first test of {@link module:core/storage-driver}. Both existing
 * drivers wrap a `FileSystemDirectoryHandle`, so every convenience the handle API gives
 * away for free was silently assumed by the seam. Here nothing is free: parent
 * directories must be created explicitly, "atomic" means an extra round trip, and a
 * missing file is a status code rather than an exception. If the interface survives
 * this, it will survive Dropbox.
 *
 * ## THE DEPLOYMENT CONSTRAINT — read this before promising anyone it works
 *
 * A browser cannot talk to an arbitrary WebDAV server. `PROPFIND`, `MKCOL` and `MOVE`
 * are non-simple methods, so every one of them is preflighted, and the `Authorization`
 * header needs explicit permission. **Nextcloud and ownCloud send no CORS headers on
 * their WebDAV endpoints by default**, so out of the box this driver is blocked by the
 * browser before a single byte moves.
 *
 * That is fixable, but only by whoever runs the server — which is exactly the
 * self-hosting audience this driver is for. The reverse proxy in front of the instance
 * needs roughly:
 *
 *     Access-Control-Allow-Origin: https://<the CrossTab origin>
 *     Access-Control-Allow-Credentials: true
 *     Access-Control-Allow-Methods: GET, PUT, DELETE, HEAD, OPTIONS, PROPFIND, MKCOL, MOVE
 *     Access-Control-Allow-Headers: Authorization, Content-Type, Depth, Destination, Overwrite
 *     Access-Control-Expose-Headers: Content-Length, Last-Modified
 *
 * It is stated here rather than discovered later because "CORS" is the single most
 * likely reason a correct implementation appears broken, and a failed preflight
 * surfaces in the browser as an opaque network error with nothing useful in it.
 *
 * ## Credentials
 *
 * Basic auth with an **app password**, which is what ownCloud and Nextcloud issue for
 * exactly this purpose: revocable per client, no second factor, and useless for logging
 * into the web UI. A bearer token is accepted too, for servers that prefer one. The
 * credential is held in memory by the driver and never written to disk here — persisting
 * it is the caller's decision, and a different one from using it.
 *
 * Crypto sits ABOVE this seam, so the server sees ciphertext for a protected project.
 * The credential guards the account; the passphrase guards the data. They are not
 * substitutes.
 */

import { debug } from './debug.js';

/** Non-empty path segments. */
const segs = (path) => String(path ?? '').split('/').filter(Boolean);

/** A path encoded for a URL, segment by segment — `/` must survive, everything else
 * must not. `encodeURIComponent` on the whole path would eat the separators. */
const encodePath = (parts) => parts.map(encodeURIComponent).join('/');

/**
 * Child names from a PROPFIND `Depth: 1` multistatus body.
 *
 * Parsed with a regex rather than `DOMParser` — deliberately. `DOMParser` does not
 * exist in the test environment, and pulling in an XML parser for one element type
 * would be a dependency for the sake of ceremony. `<href>` is the only element read
 * here, its content is URL-escaped by definition (so it cannot contain markup), and the
 * namespace prefix varies by server, which the pattern allows for.
 *
 * @param {string} xml  the multistatus body
 * @param {string} basePath  the collection's own path, whose entry is dropped
 * @returns {string[]} child names, decoded, directories WITHOUT a trailing slash
 */
export function parsePropfind(xml, basePath) {
  const base = segs(basePath).join('/');
  const out = [];
  const seen = new Set();
  for (const m of String(xml ?? '').matchAll(/<[^>]*href[^>]*>([^<]*)<\/[^>]*href[^>]*>/gi)) {
    let href = m[1].trim();
    if (!href) continue;
    // Servers answer with either an absolute URL or a root-relative path; both are
    // normalised to a path here so the caller never has to care which it got.
    try {
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
    } catch { /* not a URL — treat as a path */ }
    const parts = segs(decodeURIComponent(href));
    const path = parts.join('/');
    if (!path || path === base) continue; // the collection itself
    if (base && !path.startsWith(`${base}/`)) continue; // outside — not ours
    const name = parts[parts.length - 1];
    // A collection's href ends in `/`, which `segs` already dropped; dedupe anyway,
    // since a server is free to list an entry more than once.
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/** The ancestor directories of `path`, outermost first — what MKCOL must walk. */
export function ancestorsOf(path) {
  const parts = segs(path);
  parts.pop(); // the leaf is a file, not a collection
  const out = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * A WebDAV collection as a CrossTab storage driver.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl  the collection this project lives in, e.g.
 *   `https://cloud.example.org/remote.php/dav/files/jane/CrossTab/study`
 * @param {string} [opts.username] @param {string} [opts.password]  Basic auth (app password)
 * @param {string} [opts.token]  bearer token, instead of username/password
 * @param {typeof fetch} [opts.fetch]  injectable, so the driver is testable without a server
 */
export class WebDavDriver {
  kind = 'webdav';

  #base;        // origin + path prefix, no trailing slash
  #prefix;      // path segments of the base collection
  #auth;
  #fetch;
  /** Collections known to exist, so a save does not re-MKCOL the same tree every time.
   * Only ever a cache of successes — a miss costs one tolerated 405, never a lost write. */
  #dirs = new Set();

  constructor({ baseUrl, username, password, token, fetch: f } = {}) {
    if (!baseUrl) throw new Error('WebDavDriver: baseUrl is required');
    const url = new URL(String(baseUrl));
    this.#prefix = segs(url.pathname);
    this.#base = url.origin;
    this.#auth = token
      ? `Bearer ${token}`
      : (username != null ? `Basic ${btoa(`${username}:${password ?? ''}`)}` : null);
    this.#fetch = f ?? ((...a) => globalThis.fetch(...a));
  }

  /** The folder IS the project and someone else's client may write it — same shape as a
   * synced folder. Atomic because WebDAV has MOVE; streaming because a Blob body is sent
   * by the browser without being read into JS memory first. */
  get capabilities() {
    return { flat: true, externallySynced: true, atomicWrite: true, canStream: true };
  }

  get available() {
    // Reachability is a question only a request can answer, and answering it here would
    // mean a network round trip in a getter. Configuration validity is what is knowable.
    return !!this.#base;
  }

  /** Absolute URL for a driver-relative path. */
  #url(path) {
    return `${this.#base}/${encodePath([...this.#prefix, ...segs(path)])}`;
  }

  async #req(method, path, { body, headers = {}, okStatuses } = {}) {
    const h = { ...headers };
    if (this.#auth) h.Authorization = this.#auth;
    const res = await this.#fetch(this.#url(path), { method, body, headers: h, redirect: 'manual' });
    if (okStatuses && !okStatuses.includes(res.status)) {
      throw new Error(`WebDAV ${method} ${path}: HTTP ${res.status}`);
    }
    return res;
  }

  async read(path) {
    const res = await this.#req('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WebDAV GET ${path}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The media path: `Response#blob()` never materialises the bytes as one JS buffer. */
  async readBlob(path) {
    const res = await this.#req('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WebDAV GET ${path}: HTTP ${res.status}`);
    return res.blob();
  }

  /**
   * Create every missing ancestor collection. WebDAV `PUT` does NOT create parents —
   * the first thing the handle drivers gave away for free that has to be paid for here.
   * `405 Method Not Allowed` is the ordinary "already exists" answer, not a failure.
   */
  async #ensureDirs(path) {
    for (const dir of ancestorsOf(path)) {
      if (this.#dirs.has(dir)) continue;
      const res = await this.#req('MKCOL', dir);
      if (res.ok || res.status === 405 || res.status === 301) this.#dirs.add(dir);
      else throw new Error(`WebDAV MKCOL ${dir}: HTTP ${res.status}`);
    }
  }

  /**
   * Write via a temp path and MOVE, so a peer polling the real path over a synced
   * collection never reads half a file — the same bargain the handle drivers strike with
   * rename, one round trip more expensive.
   */
  async #putThenMove(path, body) {
    await this.#ensureDirs(path);
    const tmp = `${path}.tmp`;
    await this.#req('PUT', tmp, { body, okStatuses: [200, 201, 204] });
    const res = await this.#req('MOVE', tmp, {
      headers: { Destination: this.#url(path), Overwrite: 'T' },
    });
    if (!res.ok && res.status !== 204) {
      // Never leave an orphan `.tmp` next to the real file: the folder is the project,
      // and a stray sibling is something a co-author's sync client will faithfully
      // replicate to everyone.
      try { await this.#req('DELETE', tmp); } catch { /* best effort */ }
      throw new Error(`WebDAV MOVE ${path}: HTTP ${res.status}`);
    }
  }

  async write(path, bytes) {
    await this.#putThenMove(path, bytes);
    debug('storage', 'webdav write', { path, bytes: bytes?.byteLength ?? 0 });
  }

  async writeStream(path, blob) {
    await this.#putThenMove(path, blob);
  }

  async remove(path) {
    const res = await this.#req('DELETE', path);
    if (!res.ok && res.status !== 404) throw new Error(`WebDAV DELETE ${path}: HTTP ${res.status}`);
  }

  /** DELETE on a collection is recursive by specification, so this is `remove`. */
  async removeTree(path) {
    return this.remove(path);
  }

  async list(dirPath) {
    const res = await this.#req('PROPFIND', dirPath, { headers: { Depth: '1' } });
    if (res.status === 404) return [];
    if (!res.ok && res.status !== 207) throw new Error(`WebDAV PROPFIND ${dirPath}: HTTP ${res.status}`);
    return parsePropfind(await res.text(), [...this.#prefix, ...segs(dirPath)].join('/'));
  }

  async stat(path) {
    const res = await this.#req('HEAD', path);
    if (!res.ok) return null; // missing, or a server that dislikes HEAD — same answer
    const size = Number(res.headers.get('content-length'));
    const mod = res.headers.get('last-modified');
    const mtime = mod ? Date.parse(mod) : NaN;
    return { size: Number.isFinite(size) ? size : 0, mtime: Number.isFinite(mtime) ? mtime : 0 };
  }
}
