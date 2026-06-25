/**
 * @file workspace-store.js
 * Host-side store for plugin **workspace state** (#93).
 *
 * A workspace plugin (e.g. CAQDAS coding) owns a blob of state the host persists
 * but does NOT interpret. The store is that vault: it holds one value per
 * **workspace id** (not per plugin — so a lite "TA recoder" and a heavy "faculty
 * analyzer" plugin that both declare the same id share the data), and it round-
 * trips with the project.
 *
 * Two properties matter for the no-lock-in / open-container promise:
 *  - **Opaque**: the host never reads the value. The plugin owns its schema and
 *    versioning (the blob should carry its own version stamp).
 *  - **Preserve-on-missing-plugin**: a value is kept even if no plugin for its id
 *    is currently installed, so a shared project's coding data survives until the
 *    recipient installs the plugin. The store never drops a part it doesn't
 *    understand.
 *
 * v1 stores JSON-serialisable values (objects/arrays/strings/numbers) — enough
 * for CAQDAS codes. Binary blobs (base64 / sidecar files) can come later.
 */

import { CoreEvents } from './event-bus.js';

export class WorkspaceStore {
  /** workspaceId → value (opaque, plugin-owned). @type {Map<string, any>} */
  #states = new Map();
  /** workspaceId → owner token (the namespace of the first plugin to access it this
   * session). Guards against a third-party plugin squatting a well-known workspace
   * id (e.g. the built-in `caqdas-coding`) to read/overwrite its blob (#89). Not
   * persisted: the on-disk format stays a flat `{id: value}` (no migration, and
   * same-author lite/heavy sharing by id is preserved — same namespace = same
   * owner). @type {Map<string, string>} */
  #owners = new Map();
  #bus;

  /** @param {{bus?: import('./event-bus.js').EventBus}} [deps] */
  constructor({ bus } = {}) {
    this.#bus = bus ?? null;
  }

  /** Is `owner` allowed to touch `id`? A previously-claimed id only answers to its
   * owner; an unclaimed id is open to the first caller. `owner == null` (internal
   * callers: import/export) bypasses the check. */
  #mayAccess(id, owner) {
    if (owner == null) return true;
    const claimed = this.#owners.get(id);
    return claimed == null || claimed === owner;
  }

  /** Current value for a workspace id, or null if none (or if `owner` doesn't own
   * it). Reading claims ownership for an unclaimed id. */
  get(id, owner) {
    if (!this.#mayAccess(id, owner)) return null;
    if (owner != null && !this.#owners.has(id)) this.#owners.set(id, owner);
    return this.#states.has(id) ? this.#states.get(id) : null;
  }

  /** Persist a workspace's value and announce the change (drives autosave). A
   * value of `null`/`undefined` clears it. Throws if `owner` doesn't own the id. */
  set(id, value, owner) {
    if (!id) return;
    if (!this.#mayAccess(id, owner)) {
      throw new Error(`Workspace "${id}" is owned by another plugin.`);
    }
    if (owner != null) this.#owners.set(id, owner);
    if (value == null) this.#states.delete(id);
    else this.#states.set(id, value);
    this.#bus?.emit(CoreEvents.WORKSPACE_CHANGED, { id });
  }

  has(id) {
    return this.#states.has(id);
  }

  /** Snapshot every stored blob for the project save — including ids with no
   * installed plugin (preserve-on-missing). Returns a deep-cloned plain object. */
  export() {
    const out = {};
    for (const [id, value] of this.#states) out[id] = structuredClone(value);
    return out;
  }

  /** Replace the whole store from a project's saved blob (on open). Anything not
   * in `obj` is dropped — opening a project means adopting its workspace state. */
  import(obj) {
    this.#states.clear();
    this.#owners.clear(); // a new project re-establishes ownership on first access
    if (obj && typeof obj === 'object') {
      for (const id of Object.keys(obj)) this.#states.set(id, obj[id]);
    }
  }

  /** Drop everything (e.g. a fresh project). */
  clear() {
    this.#states.clear();
    this.#owners.clear();
  }
}
