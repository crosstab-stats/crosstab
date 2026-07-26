/**
 * @file workspace-store.js
 * Host-side store for plugin **workspace state** (#93), keyed **per owner, per
 * dataset** (#139, #145).
 *
 * A workspace plugin (e.g. CAQDAS coding) owns a blob of state the host persists but
 * does NOT interpret. The blob is scoped to an **(owner, workspace id, dataset id)**
 * triple:
 *  - **per dataset** because qualitative coding is per-dataset exactly like
 *    quantitative analysis — switching the active dataset switches the whole coding
 *    state with it (no cross-dataset codebook pollution, no row-id collision).
 *  - **per owner** because the workspace id is a *shared* namespace: two plugins from
 *    different authors may both declare `wsId: 'notes'`, and they must not clobber or
 *    read-through each other. The owner (see {@link ownerToken}) is part of the
 *    storage *key*, so a colliding id from a different author is simply a different
 *    slot — collision-safe and squat-proof by construction, with no runtime
 *    claim/race to get wrong.
 *
 * ## What ownership does and does NOT buy (#145)
 * The model is **"read the world, write your own."** Activation is full trust, so we
 * do NOT treat a blob as confidential from other activated plugins — a plugin can
 * already read the whole active *dataset*, and a blob is just derived data. What
 * ownership enforces is **integrity**: because the key carries the owner and the
 * services derive that owner from host-asserted identity, a plugin can only ever
 * write its *own* slot. It is namespacing for integrity, not isolation for secrecy.
 * (The read *addressing* happens to default to your own owner; that is a convenience,
 * not a claimed barrier — a cross-owner read would just pass a different owner.)
 *
 * Properties preserved:
 *  - **Opaque**: the host never reads the value; the plugin owns its schema/versioning.
 *  - **Preserve-on-missing-plugin**: a value survives even if no plugin for its id is
 *    installed, so a shared project's coding data isn't dropped.
 */

import { CoreEvents } from './event-bus.js';

/** Bucket key for the "no dataset" case (a workspace not tied to a dataset). */
const NO_DS = ' ';

export class WorkspaceStore {
  /** owner → (workspaceId → (datasetKey → value)).
   * @type {Map<string, Map<string, Map<string, any>>>} */
  #states = new Map();
  /** "owner\0wsId\0dsKey" → display label. Host-managed metadata, separate from
   * the opaque blob so the host can render it without interpreting the value. */
  #labels = new Map();
  #bus;

  /** @param {{bus?: import('./event-bus.js').EventBus}} [deps] */
  constructor({ bus } = {}) {
    this.#bus = bus ?? null;
  }

  #dsKey(dsId) {
    return dsId == null || dsId === '' ? NO_DS : String(dsId);
  }

  /** Value for an (owner, workspace, dataset), or null. */
  get(owner, wsId, dsId) {
    const v = this.#states.get(owner)?.get(wsId)?.get(this.#dsKey(dsId));
    return v === undefined ? null : v;
  }

  /** Persist an (owner, workspace, dataset) value and announce the change (drives
   * autosave). null/undefined clears it. A plugin can only reach its own `owner`
   * (the service derives it from host-asserted identity), so this is write-your-own
   * by construction — no access check needed.
   * @param {string} owner
   * @param {string} wsId
   * @param {string|null} dsId
   * @param {any} value
   * @param {{label?: string}} [meta] - Host-managed metadata (display label). */
  set(owner, wsId, dsId, value, meta) {
    if (!owner || !wsId) return;
    let byWs = this.#states.get(owner);
    if (!byWs) { byWs = new Map(); this.#states.set(owner, byWs); }
    let perDs = byWs.get(wsId);
    if (!perDs) { perDs = new Map(); byWs.set(wsId, perDs); }
    const k = this.#dsKey(dsId);
    if (value == null) { perDs.delete(k); this.#labels.delete(`${owner}\0${wsId}\0${k}`); }
    else {
      perDs.set(k, value);
      if (meta?.label != null) this.#labels.set(`${owner}\0${wsId}\0${k}`, meta.label);
    }
    this.#bus?.emit(CoreEvents.WORKSPACE_CHANGED, { owner, id: wsId, dataset: dsId ?? null });
  }

  has(owner, wsId, dsId) {
    return !!this.#states.get(owner)?.get(wsId)?.has(this.#dsKey(dsId));
  }

  /** Does this (owner, workspace) hold data for ANY dataset? (Deciding whether a
   * plugin's project data must be reckoned with on deactivation, #118.) */
  hasAny(owner, wsId) {
    const perDs = this.#states.get(owner)?.get(wsId);
    return !!perDs && perDs.size > 0;
  }

  /** List every (owner, wsId) that holds a blob for the given dataset.
   * @param {string|null} dsId
   * @returns {Array<{owner: string, wsId: string, label: string|null}>} */
  listForDataset(dsId) {
    const k = this.#dsKey(dsId);
    const out = [];
    for (const [owner, byWs] of this.#states) {
      for (const [wsId, perDs] of byWs) {
        if (perDs.has(k)) {
          const lk = `${owner}\0${wsId}\0${k}`;
          out.push({ owner, wsId, label: this.#labels.get(lk) ?? null });
        }
      }
    }
    return out;
  }

  /** Get the display label for a blob, or null. */
  getLabel(owner, wsId, dsId) {
    return this.#labels.get(`${owner}\0${wsId}\0${this.#dsKey(dsId)}`) ?? null;
  }

  /** Set the display label without touching the blob value. */
  setLabel(owner, wsId, dsId, label) {
    const k = `${owner}\0${wsId}\0${this.#dsKey(dsId)}`;
    if (label == null) this.#labels.delete(k);
    else this.#labels.set(k, label);
    this.#bus?.emit(CoreEvents.WORKSPACE_CHANGED, { owner, id: wsId, dataset: dsId ?? null });
  }

  /** Clear one (owner, workspace) across ALL datasets — the deactivation purge (#118). */
  clearWorkspace(owner, wsId) {
    const byWs = this.#states.get(owner);
    if (!byWs) return;
    const perDs = byWs.get(wsId);
    if (perDs) {
      for (const k of perDs.keys()) this.#labels.delete(`${owner}\0${wsId}\0${k}`);
    }
    byWs.delete(wsId);
    if (byWs.size === 0) this.#states.delete(owner);
  }

  /** Drop every workspace's blob for a dataset that's been removed (across all owners). */
  dropDataset(dsId) {
    const k = this.#dsKey(dsId);
    for (const [owner, byWs] of this.#states) {
      for (const [wsId, perDs] of byWs) {
        if (perDs.delete(k)) this.#labels.delete(`${owner}\0${wsId}\0${k}`);
      }
    }
  }

  /** Snapshot for the project save — the versioned owner-nested shape
   * `{ __wsv: 3, ws: { owner: { wsId: { dsKey: value } } } }`. Includes owners/ids with
   * no installed plugin (preserve-on-missing). Deep-cloned. Labels are stored as
   * `labels: { "owner\0wsId\0dsKey": string }`. */
  export() {
    const ws = {};
    for (const [owner, byWs] of this.#states) {
      const o = {};
      for (const [wsId, perDs] of byWs) {
        const d = {};
        for (const [k, value] of perDs) d[k] = structuredClone(value);
        o[wsId] = d;
      }
      ws[owner] = o;
    }
    const labels = this.#labels.size ? Object.fromEntries(this.#labels) : undefined;
    return { __wsv: 3, ws, labels };
  }

  /** Replace the store from a project's saved blob. Accepts the v3 owner-nested shape;
   * an older shape (v2 `{ wsId: { dsKey } }` or legacy flat `{ wsId: value }`) must be
   * migrated *before* import — see {@link migrateWorkspaceBlob} (the store has no
   * plugin context to assign owners). Anything unknown is dropped. */
  import(obj) {
    this.#states.clear();
    this.#labels.clear();
    const ws = obj && obj.__wsv === 3 ? obj.ws : null;
    if (!ws || typeof ws !== 'object') return;
    for (const owner of Object.keys(ws)) {
      const byWs = new Map();
      const o = ws[owner] || {};
      for (const wsId of Object.keys(o)) {
        const perDs = new Map();
        const d = o[wsId] || {};
        for (const k of Object.keys(d)) perDs.set(k, d[k]);
        byWs.set(wsId, perDs);
      }
      this.#states.set(owner, byWs);
    }
    if (obj.labels && typeof obj.labels === 'object') {
      for (const [k, v] of Object.entries(obj.labels)) {
        if (typeof v === 'string') this.#labels.set(k, v);
      }
    }
  }

  clear() {
    this.#states.clear();
    this.#labels.clear();
  }
}

/**
 * The ownership namespace for a plugin's workspace state (#89, #145). Built-ins are
 * mutually trusting (one shared `builtin` owner). For others the qualified id is
 * `<namespace>:<local>` (host for URL plugins, author for file/authored), so the
 * namespace prefix is the owner: two plugins from the same author/host may share a
 * workspace id, a different author gets a separate slot.
 *
 * @param {{builtin?: boolean, id?: string, origin?: string}} plugin
 * @returns {string}
 */
export function ownerToken(plugin) {
  if (plugin.builtin) return 'builtin';
  const qid = String(plugin.id || '');
  const i = qid.indexOf(':');
  if (i > 0) return `ns:${qid.slice(0, i)}`;
  return plugin.origin ? `origin:${plugin.origin}` : `plugin:${qid}`;
}

/**
 * Migrate a saved workspace blob to the v3 owner-nested shape. A v3 blob passes
 * through. Older shapes are lifted best-effort and **never destructively**:
 *  - **v2** `{ __wsv: 2, ws: { wsId: { dsKey: value } } }` — each `wsId` is wrapped
 *    under the owner of the plugin that declares it (via `resolveOwner`).
 *  - **legacy flat** `{ wsId: value }` (pre-#139) — attached to a single dataset
 *    (`targetDatasetId`) then wrapped under its owner. A clean per-dataset split is
 *    impossible (old row-ids collided across datasets), so this is best-effort.
 *
 * An id whose owner can't be resolved (no installed plugin declares it) is kept under
 * a synthetic `legacy:<wsId>` owner so the data survives; the declaring plugin can be
 * re-associated later. In practice the only real legacy case is the built-in
 * `caqdas-coding` → `builtin`.
 *
 * @param {any} obj - The saved workspace section.
 * @param {{targetDatasetId?: string|number|null, resolveOwner?: (wsId: string) => (string|null)}} [opts]
 * @returns {{__wsv: 3, ws: object}}
 */
export function migrateWorkspaceBlob(obj, opts = {}) {
  const { targetDatasetId = null, resolveOwner } = opts;
  if (obj && obj.__wsv === 3) return obj;
  const ownerOf = (wsId) => (resolveOwner && resolveOwner(wsId)) || `legacy:${wsId}`;
  const out = {};
  const put = (owner, wsId, perDs) => {
    if (!out[owner]) out[owner] = {};
    out[owner][wsId] = perDs;
  };
  if (obj && obj.__wsv === 2 && obj.ws && typeof obj.ws === 'object') {
    for (const wsId of Object.keys(obj.ws)) put(ownerOf(wsId), wsId, obj.ws[wsId] || {});
  } else if (obj && typeof obj === 'object') {
    // Legacy flat: { wsId: value } → one dataset bucket.
    const key = targetDatasetId == null || targetDatasetId === '' ? NO_DS : String(targetDatasetId);
    for (const wsId of Object.keys(obj)) put(ownerOf(wsId), wsId, { [key]: obj[wsId] });
  }
  return { __wsv: 3, ws: out };
}
