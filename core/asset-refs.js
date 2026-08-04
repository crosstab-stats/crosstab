/**
 * @file asset-refs.js
 * Who still points at an asset — and therefore which assets are garbage
 * (#152 Layer 5, closing #150's fourth bullet).
 *
 * ## The problem this solves
 *
 * Asset bytes are content-addressed and shared: two datasets coding the same interview
 * recording reference one file. So "delete the asset when its owner goes away" is wrong —
 * an asset dies only when the LAST reference to it does. Until #152 that was unanswerable,
 * because references hid in places the host could not read: CAQDAS puts `asset:` refs in a
 * dataset string column, spatial buried them in an opaque workspace blob. Nothing scanned
 * either, so deleting a boundary set leaked its bytes forever.
 *
 * The item tier fixes half of it (refs live in host-visible fields), and a dataset column
 * is queryable, so both can now be enumerated. This module is the arithmetic on top.
 *
 * ## Conservative by construction
 *
 * The dangerous failure here is deleting bytes someone still needs — unrecoverable, unlike
 * leaking bytes, which merely wastes space. So a source that cannot answer makes the whole
 * sweep abstain: {@link findOrphans} returns NO orphans if any source is incomplete, and
 * names the ones that failed. Leaking is a bug report; deleting a user's only copy of an
 * interview recording is not.
 *
 * Pure — no store, no DuckDB, no DOM. The impure scanners are injected as sources.
 */

/** Refs are written `asset:<id>` in datasets and item fields; ids are bare in the log. */
const PREFIX = 'asset:';

/** Bare id for a ref, or null if it isn't an asset ref (a `data:` URI, a plain string). */
export function refId(ref) {
  const s = typeof ref === 'string' ? ref.trim() : '';
  if (!s) return null;
  if (s.startsWith(PREFIX)) return s.slice(PREFIX.length) || null;
  // A bare hex id (what the log's index stores) is accepted so callers can mix the two.
  return /^[a-f0-9]{16,}$/i.test(s) ? s : null;
}

/**
 * Pull every asset id out of an arbitrary field value. A field may hold one ref, an array
 * of refs, or a JSON array of refs in a string (which is how CAQDAS writes a media cell).
 * Anything unrecognisable yields nothing rather than throwing — a scanner walks user data.
 * @param {*} value
 * @returns {string[]}
 */
export function refsIn(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (typeof value !== 'string') return [];
  const direct = refId(value);
  if (direct) return [direct];
  const s = value.trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.flatMap(refsIn);
    } catch { /* not JSON — no refs */ }
  }
  return [];
}

/**
 * @typedef {Object} RefSource
 * @property {string} name  Identifies it in an abstain report ("dataset:3.media").
 * @property {() => Iterable<string>|Promise<Iterable<string>>} ids  Refs or bare ids.
 */

/**
 * Ask every source what it references.
 * @param {RefSource[]} sources
 * @returns {Promise<{ids: Set<string>, incomplete: Array<{name: string, error: string}>}>}
 */
export async function collectRefs(sources) {
  const ids = new Set();
  const incomplete = [];
  for (const src of sources ?? []) {
    try {
      for (const raw of (await src.ids()) ?? []) {
        for (const id of refsIn(raw)) ids.add(id);
      }
    } catch (err) {
      incomplete.push({ name: src.name ?? '(unnamed)', error: String(err?.message || err) });
    }
  }
  return { ids, incomplete };
}

/**
 * Assets in the project's index that nobody references any more.
 *
 * **Abstains on partial knowledge**: if any source failed, `orphans` is empty and
 * `incomplete` says which — the caller should report, not sweep. See the module header.
 *
 * @param {Iterable<string>} indexIds  ids the asset tier knows about
 * @param {RefSource[]} sources
 * @returns {Promise<{orphans: string[], incomplete: Array<{name: string, error: string}>}>}
 */
export async function findOrphans(indexIds, sources) {
  const { ids: referenced, incomplete } = await collectRefs(sources);
  if (incomplete.length) return { orphans: [], incomplete };
  const orphans = [...new Set(indexIds ?? [])].filter((id) => !referenced.has(id));
  return { orphans, incomplete };
}

/**
 * A source over the item tier, built from manifest declarations. This is the payoff of
 * making plugin state host-visible: a plugin says *which field holds a ref* and the host
 * can then count references into state it still cannot interpret.
 *
 * @param {import('./item-store.js').ItemStore} itemStore
 * @param {Array<{owner: string, collection: string, field: string}>} decls
 * @returns {RefSource[]}
 */
export function itemRefSources(itemStore, decls) {
  return (decls ?? []).map((d) => ({
    name: `item:${d.owner}/${d.collection}.${d.field}`,
    ids: () => itemStore.list(d.owner, d.collection).map((rec) => rec.fields?.[d.field]),
  }));
}
