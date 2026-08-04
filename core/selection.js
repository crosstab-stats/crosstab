/**
 * @file selection.js
 * What the user currently has selected, **per kind** (#153).
 *
 * ## Why this is not a single slot
 *
 * The obvious model is "the active thing", one global slot, the way "the active dataset"
 * has always worked. That is wrong here, and the user's example is the proof: selecting
 * the ZIP-code boundary layer AND a survey dataset *at the same time* is a real workflow
 * — run frequencies on the survey, filtered to a ZIP. Neither selection displaces the
 * other because they answer different questions.
 *
 * So selection is a SET, keyed by kind: one active dataset, one active map layer, one
 * active whatever-comes-next, coexisting. That is also what makes cross-plugin flows
 * composable (#147): spatial reads the active layer, the analysis reads the active
 * dataset, and neither has to ask the other what it is doing.
 *
 * ## Scope
 *
 * Session state, deliberately — it is not persisted with the project yet. Reopening a
 * project therefore starts with nothing selected and each surface falls back to its own
 * default (spatial loads its most recent layer). Persisting it is a small manifest scalar
 * and worth doing, but it is a separate change from making selection exist at all.
 *
 * The store holds ids only. It does not know what a record IS, cannot fetch one, and
 * never validates against a live collection — a selection pointing at a deleted record
 * simply reads as stale, and the surface that resolves it decides what to do. Keeping it
 * dumb is what lets it sit under datasets, item records and anything later without
 * learning about any of them.
 */

import { CoreEvents } from './event-bus.js';

/** Bus event: the selection changed. Payload `{ owner, collection, id }`. */
export const SELECTION_CHANGED = 'selection:kindchanged';

const key = (owner, collection) => `${owner}\u0000${collection}`;

export class SelectionStore {
  /** "owner\0collection" → record id. @type {Map<string, string>} */
  #active = new Map();
  #bus;

  constructor({ bus } = {}) {
    this.#bus = bus ?? null;
  }

  /** The selected record id for a kind, or null. */
  get(owner, collection) {
    return this.#active.get(key(owner, collection)) ?? null;
  }

  /** Select a record for its kind. Passing null clears just that kind. Selecting the
   * already-selected record is a no-op, so a re-render cannot spam listeners. */
  set(owner, collection, id) {
    const k = key(owner, collection);
    const prev = this.#active.get(k) ?? null;
    const next = id ?? null;
    if (prev === next) return;
    if (next == null) this.#active.delete(k);
    else this.#active.set(k, next);
    this.#bus?.emit(SELECTION_CHANGED, { owner, collection, id: next });
  }

  /** Is this the selected record for its kind? */
  isActive(owner, collection, id) {
    return id != null && this.get(owner, collection) === id;
  }

  /** Every current selection, as `{owner, collection, id}` — for a plugin asking what is
   * selected without knowing which kinds exist. */
  all() {
    return [...this.#active.entries()].map(([k, id]) => {
      const [owner, collection] = k.split('\u0000');
      return { owner, collection, id };
    });
  }

  /** Drop everything. Called at a project boundary: a selection is a pointer into the
   * project that just closed, and carrying it across would point at nothing. */
  clear() {
    if (!this.#active.size) return;
    this.#active.clear();
    this.#bus?.emit(SELECTION_CHANGED, {});
  }
}

/**
 * The plugin-facing read surface. Read-only by design: a plugin reacts to what the user
 * selected, it does not decide it. (A plugin that wants to change the selection has a
 * verb for that — an explicit user action — rather than reaching in.)
 *
 * Scoped to the caller's own owner, matching every other plugin surface: a plugin asks
 * about its OWN collections, and gets the active dataset id for free since that is
 * host-owned and everyone needs it.
 */
export function createSelectionService(store, ownerOf, activeDatasetId) {
  return {
    get: (pluginId, collection) => store.get(ownerOf(pluginId), String(collection ?? '')),
    dataset: () => activeDatasetId(),
  };
}

void CoreEvents;
