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
  #bus;

  /** @param {{bus?: import('./event-bus.js').EventBus}} [deps] */
  constructor({ bus } = {}) {
    this.#bus = bus ?? null;
  }

  /** Current value for a workspace id, or null if none. */
  get(id) {
    return this.#states.has(id) ? this.#states.get(id) : null;
  }

  /** Persist a workspace's value and announce the change (drives autosave). A
   * value of `null`/`undefined` clears it. */
  set(id, value) {
    if (!id) return;
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
    if (obj && typeof obj === 'object') {
      for (const id of Object.keys(obj)) this.#states.set(id, obj[id]);
    }
  }

  /** Drop everything (e.g. a fresh project). */
  clear() {
    this.#states.clear();
  }
}
