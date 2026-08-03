/**
 * @file workspace-store.js
 * Host-side store for plugin **workspace state** (#93, #146), keyed
 * **per owner, per workspace, per slot, per dataset**.
 *
 * A workspace plugin (e.g. CAQDAS coding, spatial map) owns blobs of state the
 * host persists but does NOT interpret. Each blob is scoped to an
 * **(owner, workspace id, slot id, dataset key)** quad:
 *
 *  - **slot** is the plugin-chosen sub-key within a workspace. A CAQDAS workspace
 *    stores one blob per dataset → one default slot. A spatial workspace stores
 *    separate boundary sets (US counties, voting districts, …) each in its own
 *    slot, so each can be independently renamed, deleted, or promoted to a
 *    building block.
 *  - **dataset key** is either the active dataset id (for dataset-scoped
 *    workspaces like CAQDAS) or the {@link NO_DS} sentinel (for project-scoped
 *    workspaces like spatial boundaries, which are independent of the survey data).
 *  - **owner** is the plugin's namespace token (see {@link ownerToken}), part of
 *    the storage KEY — a colliding workspace id from a different author is simply
 *    a different slot.
 *
 * ## Slot lifecycle
 * Plugins create, rename, and delete slots freely via `app.state`. The host
 * renders each slot as its own line in the project sidebar, so the user can
 * manage them individually — renaming a boundary set, deleting one without
 * affecting the others, or eventually marking one as a reusable building block.
 *
 * Properties preserved:
 *  - **Opaque**: the host never reads the value; the plugin owns its schema.
 *  - **Preserve-on-missing-plugin**: a value survives even if no plugin for its
 *    id is installed, so a shared project's data isn't dropped.
 */

import { CoreEvents } from './event-bus.js';
import { liveOps } from './op-log.js';

/** Bucket key for project-scoped workspaces (not tied to a dataset). */
const NO_DS = ' ';

/** Default slot id when the plugin doesn't specify one. */
const DEFAULT_SLOT = '_default';

export { NO_DS, DEFAULT_SLOT };

/** The op-log target for one workspace leaf — the `ws:` tier of the one true log. The
 * four coordinates are NUL-joined (never present in the tokens) so the target parses
 * back cleanly, and `owner` is ALSO the op's `owner` field, so the merge routes each
 * plugin's blobs to that plugin's declared merger. */
const wsTarget = (owner, wsId, slotId, dsKey) => `ws:${owner}\0${wsId}\0${slotId}\0${dsKey}`;
const parseWsTarget = (t) => t.slice(3).split('\0'); // → [owner, wsId, slotId, dsKey]
/** Does an op belong to the workspace tier? */
export const isWorkspaceOp = (op) => typeof op?.target === 'string' && op.target.startsWith('ws:');

export class WorkspaceStore {
  /** owner → wsId → slotId → dsKey → value (a fold CACHE of the log's `ws:` tier — the
   * one true log is the source of truth; every write also appends a `setWorkspace` op).
   * @type {Map<string, Map<string, Map<string, Map<string, any>>>>} */
  #states = new Map();
  /** "owner\0wsId\0slotId\0dsKey" → display label. */
  #labels = new Map();
  #bus;
  /** The shared project op-log; the `ws:` tier lives here (#148). @type {import('./project-log.js').ProjectLog} */
  #log;

  /** @param {{bus?: import('./event-bus.js').EventBus, log?: import('./project-log.js').ProjectLog}} [deps] */
  constructor({ bus, log } = {}) {
    this.#bus = bus ?? null;
    this.#log = log ?? null;
  }

  #dsKey(dsId) {
    return dsId == null || dsId === '' ? NO_DS : String(dsId);
  }

  #labelKey(owner, wsId, slotId, dsKey) {
    return `${owner}\0${wsId}\0${slotId}\0${dsKey}`;
  }

  /** Apply one leaf to the in-memory fold cache (shared by live writes + log folding).
   * value null/undefined clears it. */
  #applyLeaf(owner, wsId, slotId, dsKey, value, label) {
    if (!owner || !wsId || !slotId) return;
    let byWs = this.#states.get(owner);
    if (!byWs) { byWs = new Map(); this.#states.set(owner, byWs); }
    let bySlot = byWs.get(wsId);
    if (!bySlot) { bySlot = new Map(); byWs.set(wsId, bySlot); }
    let perDs = bySlot.get(slotId);
    if (!perDs) { perDs = new Map(); bySlot.set(slotId, perDs); }
    const lk = this.#labelKey(owner, wsId, slotId, dsKey);
    if (value == null) {
      perDs.delete(dsKey);
      this.#labels.delete(lk);
      if (!perDs.size) bySlot.delete(slotId);
      if (!bySlot.size) byWs.delete(wsId);
      if (!byWs.size) this.#states.delete(owner);
    } else {
      perDs.set(dsKey, value);
      if (label != null) this.#labels.set(lk, label);
    }
  }

  /** The workspace tier's ops (the `ws:` slice of the shared log) — the project save
   * path folds these into `manifest.log`. */
  ops() {
    return this.#log ? this.#log.slice(isWorkspaceOp) : [];
  }

  /** Replace the workspace tier on project load/switch: clear the `ws:` ops, receive the
   * saved ones (ids preserved for merge), and refold the cache. */
  restoreOps(ops) {
    if (!this.#log) return;
    this.#log.clearWhere(isWorkspaceOp);
    this.#log.receiveOps(Array.isArray(ops) ? ops : []);
    this.loadFromLog();
  }

  /** Rebuild the fold cache from the shared log's `ws:` tier (undo/redo/retract-aware via
   * {@link liveOps}). Called on project load and after a merge apply — the maps are a
   * cache, the log is truth. */
  loadFromLog() {
    this.#states.clear();
    this.#labels.clear();
    if (!this.#log) return;
    for (const op of liveOps(this.ops())) {
      if (op.type === 'setWorkspace') {
        const [owner, wsId, slotId, dsKey] = parseWsTarget(op.target);
        this.#applyLeaf(owner, wsId, slotId, dsKey, op.payload?.value ?? null, op.payload?.label ?? null);
      } else if (op.type === 'clearWorkspace') {
        const [owner, wsId] = parseWsTarget(op.target);
        this.#clearWsMaps(owner, wsId);
      }
    }
    this.#bus?.emit(CoreEvents.WORKSPACE_CHANGED, {});
  }

  /** Value for an (owner, workspace, slot, dataset), or null. */
  get(owner, wsId, slotId, dsId) {
    const dk = this.#dsKey(dsId);
    const v = this.#states.get(owner)?.get(wsId)?.get(slotId)?.get(dk);
    return v === undefined ? null : v;
  }

  /** Persist an (owner, workspace, slot, dataset) value.
   * @param {string} owner
   * @param {string} wsId
   * @param {string} slotId
   * @param {string|null} dsId
   * @param {any} value — null/undefined clears it.
   * @param {{label?: string}} [meta] */
  set(owner, wsId, slotId, dsId, value, meta) {
    if (!owner || !wsId || !slotId) return;
    const dk = this.#dsKey(dsId);
    // One true log: every workspace write is an op (owner-tagged so merge routes each
    // plugin's blobs to its declared merger). value null = a tombstone (merge-safe clear).
    this.#log?.append({ target: wsTarget(owner, wsId, slotId, dk), owner, type: 'setWorkspace', payload: { value: value ?? null, label: meta?.label ?? null } });
    this.#applyLeaf(owner, wsId, slotId, dk, value, meta?.label); // write-through the fold cache
    this.#bus?.emit(CoreEvents.WORKSPACE_CHANGED, { owner, id: wsId, slot: slotId, dataset: dsId ?? null });
  }

  has(owner, wsId, slotId, dsId) {
    return !!this.#states.get(owner)?.get(wsId)?.get(slotId)?.has(this.#dsKey(dsId));
  }

  /** Does this (owner, workspace) hold data in ANY slot for ANY dataset? */
  hasAny(owner, wsId) {
    const bySlot = this.#states.get(owner)?.get(wsId);
    if (!bySlot) return false;
    for (const perDs of bySlot.values()) {
      if (perDs.size > 0) return true;
    }
    return false;
  }

  /** List every (owner, wsId, slotId) that holds a blob for the given dataset.
   * @param {string|null} dsId
   * @returns {Array<{owner: string, wsId: string, slotId: string, label: string|null}>} */
  listForDataset(dsId) {
    const dk = this.#dsKey(dsId);
    const out = [];
    for (const [owner, byWs] of this.#states) {
      for (const [wsId, bySlot] of byWs) {
        for (const [slotId, perDs] of bySlot) {
          if (perDs.has(dk)) {
            const lk = this.#labelKey(owner, wsId, slotId, dk);
            out.push({ owner, wsId, slotId, label: this.#labels.get(lk) ?? null });
          }
        }
      }
    }
    return out;
  }

  /** List slots for a specific (owner, workspace, dataset).
   * @returns {Array<{slotId: string, label: string|null}>} */
  listSlots(owner, wsId, dsId) {
    const dk = this.#dsKey(dsId);
    const bySlot = this.#states.get(owner)?.get(wsId);
    if (!bySlot) return [];
    const out = [];
    for (const [slotId, perDs] of bySlot) {
      if (perDs.has(dk)) {
        const lk = this.#labelKey(owner, wsId, slotId, dk);
        out.push({ slotId, label: this.#labels.get(lk) ?? null });
      }
    }
    return out;
  }

  /** Get the display label for a blob, or null. */
  getLabel(owner, wsId, slotId, dsId) {
    return this.#labels.get(this.#labelKey(owner, wsId, slotId, this.#dsKey(dsId))) ?? null;
  }

  /** Set the display label without changing the blob value — re-appends the current
   * value with the new label (the label rides the leaf's setWorkspace op). */
  setLabel(owner, wsId, slotId, dsId, label) {
    const dk = this.#dsKey(dsId);
    const cur = this.get(owner, wsId, slotId, dsId);
    if (cur == null) return; // nothing to label
    this.#log?.append({ target: wsTarget(owner, wsId, slotId, dk), owner, type: 'setWorkspace', payload: { value: cur, label: label ?? null } });
    const lk = this.#labelKey(owner, wsId, slotId, dk);
    if (label == null) this.#labels.delete(lk); else this.#labels.set(lk, label);
    this.#bus?.emit(CoreEvents.WORKSPACE_CHANGED, { owner, id: wsId, slot: slotId, dataset: dsId ?? null });
  }

  /** Clear the fold cache for one (owner, workspace) across all slots/datasets. */
  #clearWsMaps(owner, wsId) {
    const byWs = this.#states.get(owner);
    if (!byWs) return;
    const bySlot = byWs.get(wsId);
    if (bySlot) {
      for (const [slotId, perDs] of bySlot) {
        for (const dk of perDs.keys()) this.#labels.delete(this.#labelKey(owner, wsId, slotId, dk));
      }
    }
    byWs.delete(wsId);
    if (byWs.size === 0) this.#states.delete(owner);
  }

  /** Clear one (owner, workspace) across ALL slots and datasets — the deactivation purge.
   * Appends a `clearWorkspace` op (merge-safe: the clear propagates) + updates the cache. */
  clearWorkspace(owner, wsId) {
    this.#log?.append({ target: `ws:${owner}\0${wsId}`, owner, type: 'clearWorkspace', payload: {} });
    this.#clearWsMaps(owner, wsId);
  }

  /** Drop every workspace's blob for a dataset that's been removed (across all owners/slots).
   * Appends a tombstone per affected leaf so the removal propagates on merge. */
  dropDataset(dsId) {
    const dk = this.#dsKey(dsId);
    const hits = [];
    for (const [owner, byWs] of this.#states) {
      for (const [wsId, bySlot] of byWs) {
        for (const [slotId, perDs] of bySlot) {
          if (perDs.has(dk)) hits.push([owner, wsId, slotId]);
        }
      }
    }
    for (const [owner, wsId, slotId] of hits) {
      this.#log?.append({ target: wsTarget(owner, wsId, slotId, dk), owner, type: 'setWorkspace', payload: { value: null, label: null } });
      this.#applyLeaf(owner, wsId, slotId, dk, null, null);
    }
  }

  /** Snapshot for the project save.
   * Shape: `{ __wsv: 4, ws: { owner: { wsId: { slotId: { dsKey: value } } } }, labels }`. */
  export() {
    const ws = {};
    for (const [owner, byWs] of this.#states) {
      const o = {};
      for (const [wsId, bySlot] of byWs) {
        const s = {};
        for (const [slotId, perDs] of bySlot) {
          const d = {};
          for (const [dk, value] of perDs) d[dk] = structuredClone(value);
          s[slotId] = d;
        }
        o[wsId] = s;
      }
      ws[owner] = o;
    }
    const labels = this.#labels.size ? Object.fromEntries(this.#labels) : undefined;
    return { __wsv: 4, ws, labels };
  }

  /** Replace the store from a project's saved blob. Accepts v4; older shapes must
   * be migrated via {@link migrateWorkspaceBlob} first. */
  import(obj) {
    this.#states.clear();
    this.#labels.clear();
    const ws = obj && obj.__wsv === 4 ? obj.ws : null;
    if (!ws || typeof ws !== 'object') return;
    for (const owner of Object.keys(ws)) {
      const byWs = new Map();
      const o = ws[owner] || {};
      for (const wsId of Object.keys(o)) {
        const bySlot = new Map();
        const slots = o[wsId] || {};
        for (const slotId of Object.keys(slots)) {
          const perDs = new Map();
          const d = slots[slotId] || {};
          for (const dk of Object.keys(d)) perDs.set(dk, d[dk]);
          bySlot.set(slotId, perDs);
        }
        byWs.set(wsId, bySlot);
      }
      this.#states.set(owner, byWs);
    }
    if (obj.labels && typeof obj.labels === 'object') {
      for (const [k, v] of Object.entries(obj.labels)) {
        if (typeof v === 'string') this.#labels.set(k, v);
      }
    }
  }

  /** Wipe the workspace tier — the fold cache AND the `ws:` ops on the shared log (a
   * project switch / fresh project). Lifecycle only. */
  clear() {
    this.#states.clear();
    this.#labels.clear();
    this.#log?.clearWhere(isWorkspaceOp);
  }
}

/**
 * The ownership namespace for a plugin's workspace state (#89, #145). Built-ins
 * share one `builtin` owner. For others the qualified id prefix is the owner.
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
 * Migrate a saved workspace blob to the v4 slot-aware shape. A v4 blob passes
 * through. Older shapes are lifted best-effort:
 *
 *  - **v3** `{ __wsv: 3, ws: { owner: { wsId: { dsKey: value } } } }` — each
 *    (wsId, dsKey) gets wrapped under the `_default` slot.
 *  - **v2** `{ __wsv: 2, ws: { wsId: { dsKey: value } } }` — each wsId goes
 *    under its resolved owner + `_default` slot.
 *  - **legacy flat** `{ wsId: value }` — attached to `targetDatasetId` under
 *    its resolved owner + `_default` slot.
 *
 * @param {any} obj - The saved workspace section.
 * @param {{targetDatasetId?: string|number|null, resolveOwner?: (wsId: string) => (string|null)}} [opts]
 * @returns {{__wsv: 4, ws: object, labels?: object}}
 */
export function migrateWorkspaceBlob(obj, opts = {}) {
  const { targetDatasetId = null, resolveOwner } = opts;
  if (obj && obj.__wsv === 4) return obj;

  // First lift to v3 shape (the old migration path handles v2 + legacy).
  let v3;
  if (obj && obj.__wsv === 3) {
    v3 = obj;
  } else {
    const ownerOf = (wsId) => (resolveOwner && resolveOwner(wsId)) || `legacy:${wsId}`;
    const out = {};
    const put = (owner, wsId, perDs) => {
      if (!out[owner]) out[owner] = {};
      out[owner][wsId] = perDs;
    };
    if (obj && obj.__wsv === 2 && obj.ws && typeof obj.ws === 'object') {
      for (const wsId of Object.keys(obj.ws)) put(ownerOf(wsId), wsId, obj.ws[wsId] || {});
    } else if (obj && typeof obj === 'object') {
      const key = targetDatasetId == null || targetDatasetId === '' ? NO_DS : String(targetDatasetId);
      for (const wsId of Object.keys(obj)) put(ownerOf(wsId), wsId, { [key]: obj[wsId] });
    }
    v3 = { __wsv: 3, ws: out };
  }

  // Now lift v3 → v4: wrap each (wsId → { dsKey: value }) under _default slot.
  const ws4 = {};
  const v3ws = v3.ws || {};
  for (const owner of Object.keys(v3ws)) {
    ws4[owner] = {};
    for (const wsId of Object.keys(v3ws[owner] || {})) {
      ws4[owner][wsId] = { [DEFAULT_SLOT]: v3ws[owner][wsId] || {} };
    }
  }

  // Migrate labels: v3 labels had 3-part keys "owner\0wsId\0dsKey" → inject _default slot.
  let labels;
  if (v3.labels && typeof v3.labels === 'object') {
    labels = {};
    for (const [k, v] of Object.entries(v3.labels)) {
      if (typeof v !== 'string') continue;
      const parts = k.split('\0');
      if (parts.length === 3) {
        labels[`${parts[0]}\0${parts[1]}\0${DEFAULT_SLOT}\0${parts[2]}`] = v;
      } else {
        labels[k] = v;
      }
    }
  }

  return { __wsv: 4, ws: ws4, labels };
}
