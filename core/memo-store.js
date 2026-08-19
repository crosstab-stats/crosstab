/**
 * @file memo-store.js
 * **Memos** — anchored, persistent, author-stamped notes (#152 Layer 2).
 *
 * ## Why the host owns these
 *
 * Memoing is a named qualitative technique (grounded-theory memoing, reflexivity, the
 * audit trail), not a UI nicety — which is why #148 built them for CAQDAS. But building
 * them *inside* CAQDAS made them CAQDAS-only: you could annotate a coded passage and
 * nothing else. You could not write "why did I run this model?" on an analysis, or "this
 * variable is unreliable before 2019" on a dataset.
 *
 * So memos move to the host, and plugins write them THROUGH it rather than owning a
 * `memos` collection each. That is the difference between one memo system and several
 * identically-shaped ones: a single query answers "show me everything I have written
 * about this project", regardless of which surface it was written on.
 *
 * ## The anchor
 *
 * A memo points at something by **op-log target** — already the universal address of
 * everything in the system (`ds:3`, `analysis:<runId>`, `item:builtin\0segments\0<id>`).
 * No new addressing scheme was needed; that is the payoff of #148 giving everything a
 * target in the first place.
 *
 * The anchor is `{kind, target, ref?}`. `ref` exists for a sub-address the target cannot
 * express, but note the case that motivated it turned out NOT to need it: a spreadsheet
 * cell IS an op target, `ds:<id>/cell:<column>:<rid>`, because that is what `setCell`
 * writes. So a cell memo anchors to a real address, and — importantly — the address is
 * valid whether or not anything was ever written there. Annotating a value you have not
 * edited and annotating your edit of it are the same thread, which is the right answer:
 * "this number looks wrong" and "so I changed it" belong together.
 *
 * **What `ref` turned out to be for (#166).** A *region within* the target: a passage
 * inside a cell, a span of a recording, a rectangle on an image. A cell is a target; a
 * sentence in the middle of one is not, and that is exactly the gap this field was held
 * open for. It now carries an anchor ref from {@link module:core/anchors} — content-first
 * selectors that survive the text being edited — which is what makes a CAQDAS coding and
 * a note-on-a-passage the same kind of thing rather than two parallel inventions.
 *
 * ## Orphans
 *
 * When an anchor is binned the memo SURVIVES and reads as orphaned (#152 D4). Deleting a
 * dataset is recoverable, so silently destroying the analytic notes attached to it would
 * be a worse loss than the dataset itself — the note is often the only record of *why*.
 * Purging the anchor is the point of no return, matching the bin/purge distinction
 * everywhere else (#149 A4).
 */

import { newItemId } from './item-store.js';
import { normalizeRef } from './anchors.js';

/** The collection memos live in, owned by core. See CORE_COLLECTIONS in collections.js. */
export const MEMO_COLLECTION = 'memos';
const OWNER = 'core';

/** The address of a dataset CELL — byte-identical to what {@link DataStore#setCell}
 * writes, so a note about a value and a note about changing it share one anchor. Keyed by
 * the row's STABLE id, not its position, so the note follows the row through sorts,
 * appends and reorders. */
export const cellTarget = (dsId, column, rid) => `ds:${dsId}/cell:${column}:${rid}`;

/** The address of a VARIABLE — what `setVariable` writes. */
export const variableTarget = (dsId, name) => `ds:${dsId}/var:${name}`;

/** The dataset id an anchor belongs to, or null — `ds:3` and `ds:3/cell:age:1` alike.
 * Used to scope a memo so it nests under its dataset in the sidebar. */
export const datasetOfTarget = (target) => {
  const t = String(target ?? '');
  if (!t.startsWith('ds:')) return null;
  const rest = t.slice(3);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
};

/** Anchor kinds the host understands well enough to resolve a label for. */
export const ANCHOR_KINDS = Object.freeze({
  PROJECT: 'project',
  DATASET: 'dataset',
  VARIABLE: 'variable',
  ANALYSIS: 'analysis',
  ITEM: 'item',
  CELL: 'cell',
});

/**
 * Normalise an anchor. Returns null when it names nothing — a memo with no anchor is a
 * different feature (an unanchored note), deliberately not built.
 *
 * `ref` is the **sub-address the target cannot express** — a region *within* the thing
 * addressed, which is what this field was reserved for from the start (see the header)
 * and what {@link module:core/anchors} now supplies. It takes two shapes:
 *
 *  - a **structured ref** `{selectors:[…], expects?}` — a passage in a cell, a span of a
 *    recording, a rectangle on an image. Normalised through `normalizeRef`, so a
 *    malformed selector costs that region its precision rather than the whole memo;
 *  - a plain **string discriminator**, for a target that needs no region but does need
 *    telling apart. Kept deliberately: it costs one branch and it is a real use.
 *
 * The stringify that used to happen here unconditionally was a trap, not a feature: a
 * structured ref passed through it became `"[object Object]"`, which made every region on
 * one target compare EQUAL — silently collapsing distinct notes into one thread with
 * nothing thrown. Structure has to be understood here before anything is allowed to
 * write it.
 */
export function normalizeAnchor(raw) {
  const kind = typeof raw?.kind === 'string' && raw.kind ? raw.kind : null;
  const target = typeof raw?.target === 'string' && raw.target ? raw.target : null;
  if (!kind || !target) return null;
  const out = { kind, target };
  if (raw.ref != null) {
    const ref = typeof raw.ref === 'object' ? normalizeRef(raw.ref) : String(raw.ref);
    if (ref) out.ref = ref;
  }
  return out;
}

/** A ref's identity, for comparison. A structured ref is identified by its selectors —
 * canonicalised so key order cannot make two identical regions look different. */
function refKey(ref) {
  if (ref == null) return '';
  if (typeof ref !== 'object') return String(ref);
  const sel = (ref.selectors ?? []).map((s) =>
    Object.keys(s).sort().map((k) => `${k}=${JSON.stringify(s[k])}`).join(','));
  return `${sel.join('|')}${ref.expects ? `@${ref.expects}` : ''}`;
}

/** Same thing? Compared on target + ref, never on kind — the kind is a display hint.
 * Two notes on DIFFERENT regions of one cell are different anchors, which is what makes
 * per-passage annotation work at all. */
export function sameAnchor(a, b) {
  return !!a && !!b && a.target === b.target && refKey(a.ref) === refKey(b.ref);
}

export class MemoStore {
  #items;
  /** () => the dataset id a memo should be scoped to for an anchor, or null. */
  #scopeFor;

  /**
   * @param {{items: import('./item-store.js').ItemStore, scopeFor?: (anchor: object) => (string|number|null)}} deps
   */
  constructor({ items, scopeFor } = {}) {
    this.#items = items ?? null;
    this.#scopeFor = scopeFor ?? (() => null);
  }

  /**
   * Write a memo.
   * @param {{kind: string, target: string, ref?: string}} anchor
   * @param {string} text
   * @returns {string|null} the memo id, or null if the anchor or text was empty
   */
  add(anchor, text) {
    const a = normalizeAnchor(anchor);
    const body = String(text ?? '').trim();
    if (!this.#items || !a || !body) return null;
    const id = newItemId();
    this.#items.put(OWNER, MEMO_COLLECTION, id, {
      text: body,
      anchor: a,
      // Wall-clock, so a reader can order a conversation. NOT used for merge ordering —
      // that is the HLC's job, and a peer's clock may disagree with ours.
      createdAt: Date.now(),
    }, { scope: { dsId: this.#scopeFor(a) } });
    return id;
  }

  /** Edit a memo's text. Only the text: an anchor is where the note was written, and
   * moving it would silently change what a past observation was about. */
  setText(id, text) {
    const body = String(text ?? '').trim();
    if (!this.#items || !id || !body) return;
    this.#items.put(OWNER, MEMO_COLLECTION, id, { text: body });
  }

  /** Bin a memo (recoverable — see the module header). */
  remove(id) {
    if (this.#items && id) this.#items.remove(OWNER, MEMO_COLLECTION, id);
  }

  /** Every memo, newest last, optionally only those on one anchor. */
  list(anchor) {
    if (!this.#items) return [];
    const want = anchor ? normalizeAnchor(anchor) : null;
    return this.#items.list(OWNER, MEMO_COLLECTION)
      .filter((r) => !want || sameAnchor(r.fields?.anchor, want))
      .map((r) => ({
        id: r.id,
        text: r.fields?.text ?? '',
        anchor: r.fields?.anchor ?? null,
        author: r.author ?? null,
        createdAt: r.fields?.createdAt ?? 0,
      }))
      .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  }

  /** How many memos sit on an anchor — for a marker beside the thing itself. */
  countFor(anchor) {
    return this.list(anchor).length;
  }

  /**
   * Memos whose anchor no longer resolves. `exists(target)` is injected because only the
   * app knows which datasets, runs and records are live. Surfaced rather than deleted:
   * an orphaned memo is usually the only surviving record of why something was done.
   */
  orphans(exists) {
    return this.list().filter((m) => m.anchor && !exists(m.anchor));
  }
}

/**
 * The plugin-facing memo surface. Deliberately host-MEDIATED: memos are written with
 * `core` as their owner no matter who asks, so a memo written from the coding workspace
 * and one written on an analysis are the same kind of record in the same collection.
 * A plugin owning its own `memos` collection would recreate exactly the fragmentation
 * this layer exists to remove.
 *
 * @param {MemoStore} store
 * @returns {{add: Function, list: Function, remove: Function, setText: Function}}
 */
export function createMemoService(store) {
  return {
    add: (anchor, text) => store.add(anchor, text),
    list: (anchor) => store.list(anchor),
    setText: (id, text) => store.setText(id, text),
    remove: (id) => store.remove(id),
  };
}
