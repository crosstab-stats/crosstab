/**
 * @file item-store.js
 * The **item tier** of the one true log (#152 Layer 1) — fine-grained, host-folded
 * records with real identity, owned by core or by a plugin.
 *
 * ## Why this exists
 *
 * The `ws:` tier (#148) put plugin state on the log, but at **blob granularity**: one
 * `setWorkspace` op carries a plugin's ENTIRE state, so the log records "the coding
 * workspace changed", never "KC added a memo on segment s1". Everything the host would
 * like to do with that state — undo one action, show it in History, merge it without a
 * plugin-supplied merger, count references to an asset — needs the *records* to be
 * addressable, not just the blob.
 *
 * An item is therefore one record at one address:
 *
 *     item:<owner>\0<collection>\0<itemId>
 *
 * `owner` is the write authority (`'core'` or a plugin's owner token — see
 * {@link module:core/workspace-store~ownerToken}); `collection` is a plugin-chosen name
 * (`'segments'`, `'memos'`, `'boundarySets'`); `itemId` is stable for the record's life.
 *
 * ## What the host owns, and what it doesn't
 *
 * The host owns the **model** — named collections of id-keyed records — and folds them
 * generically. It does NOT own the *schema*: `fields` is an opaque object the host never
 * interprets. That split is the whole design (#152 D1): declaring structure is enough to
 * get merge, undo, history and reference-scanning host-side, so plugins never ship a fold
 * (which could only run while the plugin is activated — see the D1 rationale in TODO.md).
 *
 * State that has no useful identity — config, a viewport, atomic geometry bytes — stays
 * on the `ws:` blob path, which is not deprecated (#152 D2). `builtin-spatial` is the
 * reference case: its polygons merge LWW because you don't line-merge geometry.
 *
 * ## Fold semantics
 *
 *  - **`putItem`** shallow-MERGES its `fields` over the record's current fields. Two
 *    peers editing different fields of one record therefore both survive; only a genuine
 *    same-field collision is decided, and HLC order decides it (last writer wins per
 *    field, which is strictly better than the per-blob LWW it replaces).
 *  - **`removeItem`** tombstones the record. A later `putItem` resurrects it — deletion
 *    is an ordinary op competing on HLC order, not a terminal state. This follows the
 *    project's explicit-ops rule: deletion is a *recorded act*, never an absence.
 *  - **`purgeItem`** is the point of no return, the same distinction datasets draw
 *    between the bin and a permanent delete (#149 A4). A tombstoned record is BINNED —
 *    still folded (flagged), still counting as a reference so its asset bytes survive —
 *    and only a purge stops both. That symmetry is the point: a record is the
 *    user-meaningful object the way a dataset is, and an asset is its sidecar the way a
 *    Parquet file is, so the record is what gets binned and the bytes follow it.
 *  - `undo` / `retract` are handled upstream by {@link liveOps}, so an undone put simply
 *    isn't folded. That is how plugin actions become undoable at all.
 *
 * ## Merge (no new code needed — verified, not assumed)
 *
 * Core-owned items merge through `threeWayLog`: disjoint records union, and two peers
 * editing the same record concurrently surface an `add/add` conflict. Plugin-owned items
 * take `collab-sync.mergeProjects`'s per-owner branch, which unions every op by id and
 * only blob-merges `setWorkspace`/`clearWorkspace` leaves — item ops aren't leaves, so
 * they union and never reach a plugin merger. Both paths are correct; they differ only
 * in whether a same-record concurrent edit is surfaced or silently resolved by HLC.
 */

import { CoreEvents } from './event-bus.js';
import { liveOps } from './op-log.js';

/** Tier prefix. Deliberately NOT `ws:` — items are not workspace blobs, and
 * `collab-sync`'s leaf folding keys off `ws:`. */
const PREFIX = 'item:';

/** Does an op belong to the item tier? */
export const isItemOp = (op) => typeof op?.target === 'string' && op.target.startsWith(PREFIX);

/** The address of one record. Coordinates are NUL-joined, so none may contain NUL. */
export function itemTarget(owner, collection, itemId) {
  for (const [what, v] of [['owner', owner], ['collection', collection], ['id', itemId]]) {
    if (!v || typeof v !== 'string') throw new Error(`itemTarget: ${what} is required`);
    if (v.includes('\0')) throw new Error(`itemTarget: ${what} may not contain NUL`);
  }
  return `${PREFIX}${owner}\0${collection}\0${itemId}`;
}

/** → `[owner, collection, itemId]`. */
export const parseItemTarget = (t) => String(t).slice(PREFIX.length).split('\0');

/** A fresh record id. Mirrors `newOpId`'s shape but is its own namespace — an item's
 * identity outlives the op that created it. */
export function newItemId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `it-${uuid}` : `it-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * The item projection: every live item op folded to `owner → collection → id → record`.
 * A record is `{id, owner, collection, fields, scope, author, removed}`; removed records
 * are dropped from the result (the tombstone matters only during the fold).
 *
 * Pure and exported so it can be folded off any op array — the store's cache is only a
 * cache, this is the truth.
 *
 * `includeRemoved` keeps tombstoned records in the result, flagged `removed: true`. The
 * store uses it so its cache mirrors this fold EXACTLY: a resurrecting `putItem` has to
 * merge over the fields the record had before it was removed, which is impossible once
 * the record has been dropped. Callers reading state want the default (removed records
 * absent).
 *
 * @param {import('./op-log.js').Op[]} ops  in HLC order
 * @param {{includeRemoved?: boolean}} [opts]
 * @returns {Map<string, Map<string, Map<string, object>>>}
 */
export function foldItems(ops, { includeRemoved = false } = {}) {
  /** @type {Map<string, Map<string, Map<string, object>>>} */
  const byOwner = new Map();
  const removed = new Set();
  const purged = new Set();

  for (const op of liveOps(ops ?? [])) {
    if (op.type !== 'putItem' && op.type !== 'removeItem' && op.type !== 'purgeItem') continue;
    const [owner, collection, id] = parseItemTarget(op.target);
    if (!owner || !collection || !id) continue; // malformed address — ignore, never throw mid-fold

    if (op.type === 'removeItem') { removed.add(op.target); continue; }
    if (op.type === 'purgeItem') { purged.add(op.target); removed.delete(op.target); continue; }
    removed.delete(op.target); // a later put resurrects
    purged.delete(op.target);  // …even after a purge: ops are append-only, and the log
                               // decides by order, not by any state being terminal

    let byColl = byOwner.get(owner);
    if (!byColl) { byColl = new Map(); byOwner.set(owner, byColl); }
    let byId = byColl.get(collection);
    if (!byId) { byId = new Map(); byColl.set(collection, byId); }

    const prev = byId.get(id);
    byId.set(id, {
      id,
      owner,
      collection,
      // Shallow field merge — concurrent edits to DIFFERENT fields both survive.
      fields: { ...(prev?.fields ?? {}), ...(op.payload?.fields ?? {}) },
      // Scope is set at creation and carried forward; a later put may omit it.
      scope: op.payload?.scope ?? prev?.scope ?? null,
      // Creation authorship, not last-touch — "who wrote this memo" outlives later edits.
      author: prev?.author ?? op.author ?? null,
      target: op.target,
      removed: false,
    });
  }

  for (const t of removed) {
    const [owner, collection, id] = parseItemTarget(t);
    const byId = byOwner.get(owner)?.get(collection);
    if (!byId?.has(id)) continue;
    if (includeRemoved) byId.get(id).removed = true;
    else byId.delete(id);
  }
  // Purged records are gone from every view, bin included — that is what makes purge
  // different from remove, and what finally frees the assets they referenced.
  for (const t of purged) {
    const [owner, collection, id] = parseItemTarget(t);
    byOwner.get(owner)?.get(collection)?.delete(id);
  }
  return byOwner;
}

/** The registered projection, so `log.state('items')` works. */
export const ITEMS = {
  key: 'items',
  match: isItemOp,
  fold: foldItems,
};

export class ItemStore {
  /** Fold CACHE (the log is the source of truth). owner → collection → id → record. */
  #cache = new Map();
  #log;
  #bus;

  /** @param {{log: import('./project-log.js').ProjectLog, bus?: import('./event-bus.js').EventBus}} deps */
  constructor({ log, bus } = {}) {
    this.#log = log ?? null;
    this.#bus = bus ?? null;
    this.#log?.register(ITEMS);
  }

  /** This tier's ops — what the project save path folds into `manifest.log`. */
  ops() {
    return this.#log ? this.#log.slice(isItemOp) : [];
  }

  /** Replace the item tier on project load/switch (ids preserved for merge), then refold. */
  restoreOps(ops) {
    if (!this.#log) return;
    this.#log.clearWhere(isItemOp);
    this.#log.receiveOps(Array.isArray(ops) ? ops : []);
    this.loadFromLog();
  }

  /** Rebuild the cache from the log. Call after any path that adds ops out of HLC order
   * — a merge apply, a peer's ops arriving, a project load. Local writes write through. */
  loadFromLog() {
    // `includeRemoved` so the cache mirrors the fold exactly — see foldItems.
    this.#cache = this.#log ? foldItems(this.ops(), { includeRemoved: true }) : new Map();
    this.#bus?.emit(CoreEvents.ITEMS_CHANGED, {});
  }

  /**
   * Create or update one record. Fields shallow-merge over what's there, so a caller may
   * send only what changed.
   *
   * @param {string} owner
   * @param {string} collection
   * @param {string} id            pass {@link newItemId} for a new record
   * @param {object} fields        opaque to the host
   * @param {{scope?: {wsId?: string, slotId?: string, dsId?: string|number|null}}} [opts]
   * @returns {object} the folded record
   */
  put(owner, collection, id, fields, { scope } = {}) {
    const target = itemTarget(owner, collection, id);
    const payload = { fields: fields ?? {} };
    if (scope) payload.scope = scope;
    const op = this.#log?.append({ target, owner, type: 'putItem', payload });
    // Write-through: a local append always carries the highest HLC, so this is equivalent
    // to refolding. (Received ops can sort earlier — those go through loadFromLog.)
    const rec = this.#applyPut(owner, collection, id, payload, op?.author ?? null, target);
    this.#bus?.emit(CoreEvents.ITEMS_CHANGED, { owner, collection, id });
    return rec;
  }

  #applyPut(owner, collection, id, payload, author, target) {
    let byColl = this.#cache.get(owner);
    if (!byColl) { byColl = new Map(); this.#cache.set(owner, byColl); }
    let byId = byColl.get(collection);
    if (!byId) { byId = new Map(); byColl.set(collection, byId); }
    const prev = byId.get(id);
    const rec = {
      id, owner, collection,
      fields: { ...(prev?.fields ?? {}), ...(payload.fields ?? {}) },
      scope: payload.scope ?? prev?.scope ?? null,
      author: prev?.author ?? author,
      target,
      removed: false, // a put over a tombstone resurrects it
    };
    byId.set(id, rec);
    return rec;
  }

  /** Append the tombstone without touching the cache. */
  #appendRemove(owner, collection, id) {
    this.#log?.append({ target: itemTarget(owner, collection, id), owner, type: 'removeItem', payload: {} });
  }

  /**
   * Remove one record (an explicit tombstone op — a later {@link put} resurrects it,
   * carrying the fields it did not mention; see {@link foldItems}).
   *
   * The cache keeps the record and FLAGS it, exactly as the fold does — dropping it
   * would lose the fields a later resurrection has to restore, and the cache would then
   * disagree with a cold refold (the bug the fold-vs-cache tests exist to catch).
   */
  remove(owner, collection, id) {
    this.#appendRemove(owner, collection, id);
    const rec = this.#cache.get(owner)?.get(collection)?.get(id);
    if (rec) rec.removed = true;
    this.#bus?.emit(CoreEvents.ITEMS_CHANGED, { owner, collection, id });
  }

  /** One record, or null. Tombstoned records are held in the cache (see {@link remove})
   * but are not state — they read as absent. */
  get(owner, collection, id) {
    const rec = this.#cache.get(owner)?.get(collection)?.get(id);
    return rec && !rec.removed ? rec : null;
  }

  /**
   * Every record in a collection, optionally narrowed to one dataset's scope.
   * `dsId` matching is on the recorded scope, so project-scoped records (no `dsId`)
   * are returned for every dataset.
   * @returns {object[]}
   */
  list(owner, collection, { dsId, includeRemoved = false } = {}) {
    const all = [...(this.#cache.get(owner)?.get(collection)?.values() ?? [])]
      .filter((r) => includeRemoved || !r.removed);
    if (dsId === undefined) return all;
    return all.filter((r) => r.scope?.dsId == null || String(r.scope.dsId) === String(dsId));
  }

  /**
   * Records currently in the bin — removed, but recoverable.
   *
   * A record is the user-meaningful object, the way a dataset is; the asset bytes it
   * references are its sidecar, the way a Parquet file is. So a removed record keeps its
   * bytes until it is PURGED, and {@link restore} brings both back together. Restoring an
   * asset on its own would be meaningless — you would have the bytes and nothing pointing
   * at them.
   */
  binned(owner, collection) {
    if (owner === undefined) {
      const out = [];
      for (const byColl of this.#cache.values()) {
        for (const byId of byColl.values()) for (const r of byId.values()) if (r.removed) out.push(r);
      }
      return out;
    }
    return [...(this.#cache.get(owner)?.get(collection)?.values() ?? [])].filter((r) => r.removed);
  }

  /** Bring a binned record back. Resurrection is already the fold's semantics — a put
   * over a tombstone restores the fields it does not mention — so this is an empty put. */
  restore(owner, collection, id) {
    const rec = this.#cache.get(owner)?.get(collection)?.get(id);
    if (!rec?.removed) return null;
    return this.put(owner, collection, id, {});
  }

  /** Forget a binned record permanently: the point of no return, after which the assets
   * it referenced are no longer counted and become reclaimable. */
  purge(owner, collection, id) {
    const byId = this.#cache.get(owner)?.get(collection);
    const rec = byId?.get(id);
    if (!rec) return;
    this.#log?.append({ target: itemTarget(owner, collection, id), owner, type: 'purgeItem', payload: {} });
    byId.delete(id);
    this.#bus?.emit(CoreEvents.ITEMS_CHANGED, { owner, collection, id });
  }

  /** Collection names this owner holds records in. */
  collections(owner) {
    return [...(this.#cache.get(owner)?.keys() ?? [])];
  }

  /** Every record across all owners/collections — the host-side scan that makes asset
   * reference counting possible (#152 Layer 5). */
  all() {
    const out = [];
    for (const byColl of this.#cache.values()) {
      for (const byId of byColl.values()) {
        for (const rec of byId.values()) if (!rec.removed) out.push(rec);
      }
    }
    return out;
  }

  /**
   * Tombstone every record scoped to a dataset. Called on a **purge**, never on a bin —
   * deletion is recoverable and the restore re-attaches to these records (#149 A4).
   */
  dropDataset(dsId) {
    let hit = false;
    for (const rec of this.all()) {
      if (rec.scope?.dsId != null && String(rec.scope.dsId) === String(dsId)) {
        this.#appendRemove(rec.owner, rec.collection, rec.id);
        hit = true;
      }
    }
    if (hit) this.loadFromLog(); // one refold for the whole drop, not one per record
  }
}
