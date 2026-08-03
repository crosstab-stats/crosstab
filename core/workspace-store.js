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
   * Appends a tombstone per affected leaf so the removal propagates on merge.
   *
   * NOT called when a dataset is deleted — deletion is recoverable, and the restore
   * re-attaches to these very leaves under the same dataset id (#149 A4). It is called
   * only on a *permanent purge*, which is the point of no return. */
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

  // NOTE: `export()` / `import()` and the module-level `migrateWorkspaceBlob` are GONE
  // (#149 C5). They were the pre-#148 blob format: a whole-tier snapshot written
  // straight into the cache, bypassing the log. Once the `ws:` tier moved onto the one
  // true log they had no callers, and leaving them meant some future path could
  // reintroduce a write the log never sees. Save/load go through ops() / restoreOps().
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
