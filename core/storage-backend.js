/**
 * @file storage-backend.js
 * Where a project lives, as one interface per platform (#172).
 *
 * ## What this replaces, and why
 *
 * The engine used to ask "which UI flow did the user come through?" — a `#folderMode`
 * flag — and key real behaviour on the answer. That produced four bugs of the same shape:
 * saves that overwrote a peer, a poll that never ran, a re-key that went unnoticed, and a
 * project list that queried the wrong store. Each was fixed by reading a capability
 * instead, and each was found by someone using the app rather than by a test.
 *
 * The deeper cost was duplication. Opening and moving existed twice — once for folders,
 * once for remote, the second written by copying the first — so a new provider meant
 * copying both again and remembering every check inside them. Two providers in, that was
 * already 227 lines with no test coverage.
 *
 * A backend owns everything platform-specific, so the engine can hold one and know
 * nothing else:
 *
 *  - `capabilities` — how the bytes behave: `{flat, externallySynced, atomicWrite,
 *    canStream}`. This is what drives merge-on-save, polling and layout.
 *  - `driver()` — the byte interface (read/write/list/stat/…). A FRESH one per call,
 *    because the probe store and the live store must never share one.
 *  - `connect()` — get ready to be used: re-grant folder permission, sign in to Dropbox,
 *    ask for a WebDAV password, or nothing at all. Whatever credential that needs was
 *    supplied when the backend was constructed, so this never opens UI of its own.
 *  - `describe()` — how to render in a list, as data rather than a branch in the sidebar
 *    and another in the launcher.
 *  - `remember()` — what the location registry should store. Addresses, never secrets.
 *  - `pollMs` — how often a peer's write is worth checking for.
 *  - `projectId` — WHICH project at this location, or null for "the one that is there".
 *    Only local storage holds more than one, and this is the whole of that difference.
 *  - `passphraseMode` — which unlock dialog fits: one project among many, or a location.
 *  - `shortcuts()` — optional; only a real directory can hold a double-click file.

 * ## No favourite children
 *
 * Local storage is a backend too. It was briefly not — `openProject(id)` opened local
 * projects and `openLocation(backend)` opened everything else — which is the same
 * privileged-path flaw as `#folderMode`, just further in. It looked harmless only because
 * local storage is the UNDEMANDING case: nothing else writes it, so there is no merge, no
 * poll, no credential and no gesture to get wrong. Agreement by luck is not agreement, and
 * it is where the next storage bug would have lived.
 *
 * ## The one thing that is genuinely not uniform
 *
 * A folder's permission re-grant must happen inside a user GESTURE — the browser refuses
 * otherwise, and it fails silently rather than throwing. `needsGesture` says so, and the
 * launcher defers such a backend to its Start click instead of connecting on hover or on
 * selection. Nothing else in the interface leaks the platform.
 */

import { OpfsDriver, FsaFolderDriver } from './storage-driver.js';
import { WebDavDriver } from './storage-webdav.js';
import { DropboxDriver } from './storage-dropbox.js';
import { ensureReadWrite } from './project-locations.js';
import { shortcutFiles } from './folder-shortcut.js';

/** A local file read costs nothing; a network round trip against a rate-limiting
 * provider costs a request per open tab. */
export const LOCAL_POLL_MS = 3000;
export const REMOTE_POLL_MS = 15000;

/**
 * The browser's own storage. The default, and the only backend holding MANY projects —
 * which is why `flat` is false here and true everywhere else.
 */
export class OpfsBackend {
  kind = 'opfs';
  needsGesture = false;
  pollMs = 0; // nothing else writes it, so there is nothing to watch for
  passphraseMode = 'unlock'; // one project among many, not a whole location

  #id;

  /** @param {string|number|null} projectId  which project; null means "browse". */
  constructor(projectId = null) { this.#id = projectId ?? null; }

  /** The one field that distinguishes local storage: it holds MANY projects, so it names
   * which. Every other backend holds one and answers null. */
  get projectId() { return this.#id; }

  driver() { return new OpfsDriver(); }
  async connect() { return true; }
  describe() { return { kind: this.kind, glyph: '💻', label: 'This browser', detail: '' }; }
  remember() { return null; } // the local catalog already lists these
}

/**
 * A picked directory, which an OS sync client may be mirroring to a cloud provider.
 *
 * The demanding case, and the reason the interface looks as it does: it is the only
 * backend needing a user gesture, the only one holding a non-serialisable handle, and the
 * only one that can carry OS-facing shortcut files.
 */
export class FolderBackend {
  kind = 'folder';
  needsGesture = true;
  pollMs = LOCAL_POLL_MS;
  projectId = null; // the location holds exactly one project
  passphraseMode = 'folder';

  #handle;

  constructor(handle) {
    if (!handle) throw new Error('FolderBackend: a directory handle is required');
    this.#handle = handle;
  }

  /** Show the OS picker. Static because acquiring a handle precedes having a backend. */
  static async pick() {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) return null;
    try {
      return await window.showDirectoryPicker({ id: 'crosstab-projects', mode: 'readwrite' });
    } catch {
      return null; // the user cancelled the picker
    }
  }

  get handle() { return this.#handle; }

  driver() { return new FsaFolderDriver(this.#handle); }

  /** The browser will not restore write permission silently — this must run inside a
   * user gesture, and returns false rather than throwing when it is refused. */
  async connect() { return ensureReadWrite(this.#handle); }

  describe() {
    return { kind: this.kind, glyph: '📁', label: this.#handle.name ?? 'Folder', detail: '' };
  }

  remember() { return { kind: 'folder', handle: this.#handle, name: this.#handle.name }; }

  /** OS-facing double-click files, so a recipient can launch CrossTab from the folder. */
  shortcuts(name, origin, pathname) { return shortcutFiles(name, origin, pathname); }
}

/**
 * Dropbox. The credential is a signed-in session supplied by the caller, so this never
 * opens a sign-in window of its own — and a token renewed mid-save is picked up without
 * the backend knowing, because the driver asks per request.
 */
export class DropboxBackend {
  kind = 'dropbox';
  needsGesture = false;
  pollMs = REMOTE_POLL_MS;
  projectId = null;
  passphraseMode = 'folder';

  #config;
  #getSession;
  #session = null;

  /**
   * @param {{appKey: string, basePath?: string}} config
   * @param {() => Promise<{getToken: () => Promise<string>}>} getSession
   */
  constructor(config, getSession) {
    this.#config = { appKey: config?.appKey, basePath: config?.basePath ?? '' };
    this.#getSession = getSession;
  }

  driver() {
    const session = this.#session;
    if (!session) throw new Error('DropboxBackend: connect() first');
    return new DropboxDriver({ getToken: () => session.getToken(), basePath: this.#config.basePath });
  }

  async connect() {
    this.#session = await this.#getSession();
    return !!this.#session;
  }

  describe() {
    return { kind: this.kind, glyph: '📦', label: this.#config.basePath || 'Dropbox', detail: 'Dropbox' };
  }

  remember() { return { kind: 'dropbox', config: this.#config, name: this.#config.basePath || 'Dropbox' }; }
}

/**
 * WebDAV — ownCloud, Nextcloud, Synology, anything speaking the protocol.
 *
 * The password is fetched through a callback at connect time and held only by the driver,
 * so nothing on this path can write it anywhere.
 */
export class WebDavBackend {
  kind = 'webdav';
  needsGesture = false;
  pollMs = REMOTE_POLL_MS;
  projectId = null;
  passphraseMode = 'folder';

  #config;
  #getPassword;
  #password = null;

  /**
   * @param {{url: string, username?: string}} config
   * @param {() => Promise<string|null>} getPassword
   */
  constructor(config, getPassword) {
    this.#config = { url: config?.url, username: config?.username ?? '' };
    this.#getPassword = getPassword;
  }

  driver() {
    return new WebDavDriver({
      baseUrl: this.#config.url,
      username: this.#config.username,
      password: this.#password,
    });
  }

  async connect() {
    this.#password = await this.#getPassword();
    return this.#password != null; // an empty password is a choice; a cancel is not
  }

  describe() {
    let host = this.#config.url;
    try { host = new URL(this.#config.url).host; } catch { /* not a URL — show it raw */ }
    return { kind: this.kind, glyph: '🌐', label: host, detail: this.#config.url };
  }

  remember() { return { kind: 'webdav', config: this.#config, name: this.describe().label }; }
}

/**
 * Rebuild a backend from a remembered location entry.
 *
 * The registry stores an address, never a credential, so reopening always needs the
 * caller to supply how to get in — which is why `credentials` is a required argument
 * rather than something this module could ever hold.
 *
 * @param {{kind: string, handle?: object, config?: object}} entry
 * @param {{dropboxSession?: Function, webdavPassword?: Function}} credentials
 * @returns {object|null} a backend, or null if the entry cannot be rebuilt
 */
export function backendFor(entry, credentials = {}) {
  switch (entry?.kind ?? 'folder') {
    case 'folder':
      // `entry?.kind` above defaults a null entry to 'folder', so this arm is where a
      // null lands — it must not then dereference it.
      return entry?.handle ? new FolderBackend(entry.handle) : null;
    case 'dropbox':
      return entry.config?.appKey && credentials.dropboxSession
        ? new DropboxBackend(entry.config, () => credentials.dropboxSession(entry.config))
        : null;
    case 'webdav':
      return entry.config?.url && credentials.webdavPassword
        ? new WebDavBackend(entry.config, () => credentials.webdavPassword(entry.config))
        : null;
    default:
      return null;
  }
}
