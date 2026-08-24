/**
 * @file storage-dropbox.js
 * Dropbox as a storage driver (#143) — the first OAuth backend.
 *
 * ## What differs from WebDAV, and why it is simpler
 *
 * Dropbox is path-addressed, so this is a sibling of the WebDAV driver rather than a new
 * shape — the reason it was built second. Three things it gives away that WebDAV charges
 * for:
 *
 *  - **Parents are created implicitly.** An upload to `/a/b/c.json` makes `/a` and `/b`
 *    on the way. No MKCOL walk, no cache of which collections exist.
 *  - **Overwrite is atomic.** `mode: overwrite` commits the whole file or none of it, so
 *    the temp-then-rename dance is unnecessary. A reader polling the path sees the old
 *    bytes or the new ones.
 *  - **CORS works.** Dropbox serves its API to browser origins by design, which is
 *    precisely what makes a self-hosted WebDAV server hard.
 *
 * What it charges for instead is OAuth (see oauth-pkce.js) and a split API surface: RPC
 * calls take JSON bodies at `api.dropboxapi.com`, while content calls put their arguments
 * in a `Dropbox-API-Arg` **header** and use the body for bytes, at
 * `content.dropboxapi.com`.
 *
 * ## The header-encoding trap
 *
 * `Dropbox-API-Arg` is an HTTP header, so it must be ASCII. A path containing any
 * non-ASCII character — an accented folder name, a CJK one — produces a header the
 * browser refuses to send, and the failure surfaces as a generic network error rather
 * than anything naming the cause. Dropbox's documented answer is to escape non-ASCII as
 * `\uXXXX` inside the JSON, which {@link asciiJson} does.
 *
 * ## Tokens
 *
 * The driver never holds a token; it asks for one per request through `getToken()`. That
 * keeps refresh where it belongs — with whoever owns the OAuth session — and means a
 * token renewed mid-save is picked up without the driver knowing anything happened.
 */

import { httpError, isAuthError } from './storage-driver.js';
import { debug } from './debug.js';

export { isAuthError };

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

/** Anything above this goes through an upload session instead of a single request.
 * Dropbox's own ceiling is 150 MB; 100 keeps clear of it without chunking small saves. */
const SINGLE_SHOT_LIMIT = 100 * 1024 * 1024;
/** Chunk size for a session upload. Dropbox recommends a multiple of 4 MB. */
const CHUNK = 8 * 1024 * 1024;

/**
 * JSON with every non-ASCII character escaped, for use in an HTTP header.
 * @see the header-encoding note in this file's header
 */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A Dropbox path: always absolute, `/` for the root — never a bare name. */
export const dbxPath = (base, path) => {
  const parts = [...String(base ?? '').split('/'), ...String(path ?? '').split('/')].filter(Boolean);
  return parts.length ? `/${parts.join('/')}` : '';
};

/** Is this the "there is nothing at that path" error, rather than a real failure? */
export function isNotFound(body) {
  const tag = body?.error?.['.tag'];
  if (tag === 'path_lookup' || tag === 'path') {
    const inner = body.error[tag]?.['.tag'];
    return inner === 'not_found' || inner === 'not_folder';
  }
  return false;
}

/**
 * A Dropbox folder as a CrossTab storage driver.
 *
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken  supplies a valid access token per request
 * @param {string} [opts.basePath]  the folder holding this project, e.g. `/CrossTab/study`
 * @param {typeof fetch} [opts.fetch]
 */
export class DropboxDriver {
  kind = 'dropbox';

  #getToken;
  #base;
  #fetch;

  constructor({ getToken, basePath = '', fetch: f } = {}) {
    if (typeof getToken !== 'function') throw new Error('DropboxDriver: getToken is required');
    this.#getToken = getToken;
    this.#base = String(basePath ?? '').replace(/\/+$/, '');
    this.#fetch = f ?? ((...a) => globalThis.fetch(...a));
  }

  /** One project per folder, someone else's client may write it, overwrite is atomic,
   * and an upload session streams. */
  get capabilities() {
    return { flat: true, externallySynced: true, atomicWrite: true, canStream: true };
  }

  get available() {
    return true; // reachability is a question only a request can answer
  }

  #path(path) {
    return dbxPath(this.#base, path);
  }

  /** An RPC call: JSON in, JSON out. */
  async #rpc(endpoint, arg, { tolerateNotFound = false } = {}) {
    const res = await this.#fetch(`${RPC}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.#getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arg),
    });
    if (res.status === 401) throw httpError(`Dropbox ${endpoint}`, 401);
    if (res.ok) return res.json();
    // 409 is Dropbox's "your request was well-formed but the path says otherwise", which
    // covers the ordinary missing-file case as well as real conflicts — so the body has
    // to be read to tell them apart.
    const body = await res.json().catch(() => ({}));
    if (tolerateNotFound && isNotFound(body)) return null;
    throw httpError(`Dropbox ${endpoint}`, res.status, body.error_summary ?? '');
  }

  /** A content call: arguments in a header, bytes in the body. */
  async #content(endpoint, arg, { body, download = false } = {}) {
    const headers = {
      Authorization: `Bearer ${await this.#getToken()}`,
      'Dropbox-API-Arg': asciiJson(arg),
    };
    if (!download) headers['Content-Type'] = 'application/octet-stream';
    const res = await this.#fetch(`${CONTENT}${endpoint}`, { method: 'POST', headers, body });
    if (res.status === 401) throw httpError(`Dropbox ${endpoint}`, 401);
    return res;
  }

  async #download(path) {
    const res = await this.#content('/files/download', { path: this.#path(path) }, { download: true });
    if (res.ok) return res;
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && isNotFound(body)) return null; // missing → null, per the contract
    throw httpError(`Dropbox download ${path}`, res.status, body.error_summary ?? '');
  }

  async read(path) {
    const res = await this.#download(path);
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  /** The media path — the response Blob is never materialised as one JS buffer. */
  async readBlob(path) {
    const res = await this.#download(path);
    return res ? res.blob() : null;
  }

  async write(path, bytes) {
    const res = await this.#content(
      '/files/upload',
      { path: this.#path(path), mode: 'overwrite', autorename: false, mute: true },
      { body: bytes },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw httpError(`Dropbox upload ${path}`, res.status, body.error_summary ?? '');
    }
    debug('storage', 'dropbox write', { path, bytes: bytes?.byteLength ?? 0 });
  }

  /**
   * Stream a Blob up.
   *
   * Below the single-shot limit this is an ordinary upload — chunking a 2 MB manifest
   * would be three round trips to save one. Above it, an upload session: the file does
   * not exist at the destination until `finish`, so a half-sent multi-GB movie is never
   * visible to a peer, which is the same guarantee overwrite gives for a small file.
   */
  async writeStream(path, blob) {
    if (!blob || blob.size <= SINGLE_SHOT_LIMIT) {
      return this.write(path, blob);
    }
    const start = await this.#content('/files/upload_session/start', { close: false }, { body: blob.slice(0, CHUNK) });
    if (!start.ok) throw httpError(`Dropbox upload_session/start ${path}`, start.status);
    const { session_id: sessionId } = await start.json();

    let offset = Math.min(CHUNK, blob.size);
    while (offset < blob.size) {
      const end = Math.min(offset + CHUNK, blob.size);
      const res = await this.#content(
        '/files/upload_session/append_v2',
        { cursor: { session_id: sessionId, offset }, close: false },
        { body: blob.slice(offset, end) },
      );
      if (!res.ok) throw httpError(`Dropbox upload_session/append ${path}`, res.status);
      offset = end;
    }
    const fin = await this.#content(
      '/files/upload_session/finish',
      {
        cursor: { session_id: sessionId, offset },
        commit: { path: this.#path(path), mode: 'overwrite', autorename: false, mute: true },
      },
      { body: new Uint8Array() },
    );
    if (!fin.ok) throw httpError(`Dropbox upload_session/finish ${path}`, fin.status);
  }

  async remove(path) {
    // Deleting something already gone is success — the caller wanted it absent.
    await this.#rpc('/files/delete_v2', { path: this.#path(path) }, { tolerateNotFound: true });
  }

  /** A folder delete is recursive in Dropbox, so this is `remove`. */
  async removeTree(path) {
    return this.remove(path);
  }

  async list(dirPath) {
    let res = await this.#rpc('/files/list_folder', { path: this.#path(dirPath), recursive: false }, { tolerateNotFound: true });
    if (!res) return [];
    const names = res.entries.map((e) => e.name);
    // Paging is not optional: a project with many sources or assets will exceed one page,
    // and a silently truncated listing would read as missing files.
    while (res.has_more) {
      res = await this.#rpc('/files/list_folder/continue', { cursor: res.cursor });
      names.push(...res.entries.map((e) => e.name));
    }
    return names;
  }

  async stat(path) {
    const meta = await this.#rpc('/files/get_metadata', { path: this.#path(path) }, { tolerateNotFound: true });
    if (!meta) return null;
    const mtime = Date.parse(meta.server_modified ?? '');
    return { size: Number(meta.size) || 0, mtime: Number.isFinite(mtime) ? mtime : 0 };
  }
}

/** OAuth endpoints and scopes for Dropbox — everything the PKCE helper needs. */
export const DROPBOX_OAUTH = Object.freeze({
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  scope: 'files.content.read files.content.write files.metadata.read',
  // Without this Dropbox issues a short-lived token and NO refresh token, so a session
  // dies after four hours with no way to renew but sending the user back through consent.
  extra: { token_access_type: 'offline' },
});
