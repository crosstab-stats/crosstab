/**
 * @file rehome.js
 * Repoint everything that referenced dataset A at dataset B (#151).
 *
 * ## Why this exists
 *
 * In-place replace is gone (#149 A8), so "here is a corrected version of my data" means:
 * import as a new dataset, bin the old. Everything keyed to the OLD dataset id then
 * dangles — analysis runs, plugin records, coded segments — and until this existed the
 * answer was "do that work again by hand".
 *
 * Half the original problem dissolved rather than being solved: CAQDAS codes became
 * project-scoped, so a codebook no longer belongs to a dataset and needs no moving. What
 * is left is the things that genuinely are per-dataset.
 *
 * ## The hard part: row references
 *
 * A coded segment does not point at a dataset, it points at a ROW — `__ct_rid`, baked as
 * `sourceSeq * 1e9 + rowNumber`. Re-importing a corrected file therefore produces
 * *identical* ids whenever the row count and order are unchanged, which is the common
 * case and needs no mapping at all. Ids only diverge when rows were added, removed or
 * reordered — and then the only honest recourse is to match on a key the user names.
 *
 * A row reference the host cannot map is **dropped, and counted**, never silently
 * repointed at whatever now occupies that id. Pointing a quotation at the wrong
 * participant is worse than losing it, because nothing downstream can tell.
 *
 * Pure: no DOM, no store, no async. The caller supplies row ids and applies the plan.
 */

/**
 * Work out how dataset A's row ids map onto dataset B's.
 *
 * @param {object} arg
 * @param {string[]} arg.fromRids  A's row ids, in row order
 * @param {string[]} arg.toRids    B's row ids, in row order
 * @param {string[]} [arg.fromKeys] A's key-column values, aligned to `fromRids`
 * @param {string[]} [arg.toKeys]   B's key-column values, aligned to `toRids`
 * @returns {{map: Map<string,string>, strategy: 'identity'|'key'|'none',
 *           matched: number, unmatched: string[], ambiguous: string[]}}
 */
export function planRowMap({ fromRids, toRids, fromKeys, toKeys }) {
  const from = (fromRids ?? []).map(String);
  const to = new Set((toRids ?? []).map(String));

  // A NAMED KEY WINS over identity. Tempting to prefer identity as the cheap path, but
  // it is only sound while row order is unchanged: ids are `sourceSeq * 1e9 + rowNumber`,
  // so inserting one row at the top of B shifts every subsequent row into the id its
  // predecessor used to hold. Identity would map every coding one row off, silently and
  // plausibly. A user who names a key column is telling us what identifies a row, and
  // that is strictly better information than position.
  if (!fromKeys || !toKeys) {
    // No key offered: identity is the best available signal, and it is genuinely right
    // for the common case — the same rows re-imported in the same order.
    if (from.length && from.every((r) => to.has(r))) {
      return { map: new Map(from.map((r) => [r, r])), strategy: 'identity', matched: from.length, unmatched: [], ambiguous: [] };
    }
    return { map: new Map(), strategy: 'none', matched: 0, unmatched: from, ambiguous: [] };
  }

  // Key match. A key value occurring more than once on either side is refused rather
  // than resolved by position: "first match wins" would quietly attach a participant's
  // codings to a different participant with the same name.
  const countBy = (vals) => {
    const c = new Map();
    for (const v of vals) { const k = norm(v); if (k !== null) c.set(k, (c.get(k) ?? 0) + 1); }
    return c;
  };
  const fromCounts = countBy(fromKeys);
  const toCounts = countBy(toKeys);

  const toByKey = new Map();
  (toRids ?? []).forEach((rid, i) => {
    const k = norm(toKeys[i]);
    if (k !== null && toCounts.get(k) === 1) toByKey.set(k, String(rid));
  });

  const map = new Map();
  const unmatched = [];
  const ambiguous = [];
  from.forEach((rid, i) => {
    const k = norm(fromKeys[i]);
    if (k === null) { unmatched.push(rid); return; }
    if (fromCounts.get(k) > 1 || toCounts.get(k) > 1) { ambiguous.push(rid); return; }
    const hit = toByKey.get(k);
    if (hit === undefined) { unmatched.push(rid); return; }
    map.set(rid, hit);
  });
  return { map, strategy: 'key', matched: map.size, unmatched, ambiguous };
}

/** A key value normalised for matching: trimmed, case-folded, blanks are not keys. */
function norm(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t.toLowerCase();
}

/**
 * Rewrite one plugin record for its new home.
 *
 * `rowRefs` names the fields holding a `__ct_rid` — declared by the collection, exactly
 * as `assetRefs` declares which fields hold asset refs. The host cannot infer it: a
 * string field holding "1000000003" is indistinguishable from any other string, and
 * guessing would corrupt records rather than move them.
 *
 * @returns {{fields: object, ok: boolean}} ok=false ⇒ a row reference could not be
 *   mapped, so the record must be left behind rather than moved to a wrong row.
 */
export function rehomeRecord(fields, rowRefs, map) {
  if (!rowRefs?.length) return { fields, ok: true };
  const out = { ...fields };
  for (const f of rowRefs) {
    const v = out[f];
    if (v === undefined || v === null) continue;
    const hit = map.get(String(v));
    if (hit === undefined) return { fields: out, ok: false };
    out[f] = hit;
  }
  return { fields: out, ok: true };
}

/**
 * Everything that references dataset A, as a plan the caller can show before applying.
 *
 * Counting first and applying second is the point: re-homing is irreversible in the
 * user's mind even when the op log can undo it, and "42 codings will move, 3 cannot be
 * matched and will stay behind" is a decision someone can actually make.
 *
 * @param {object} arg
 * @param {Array<{collection:string, owner:string, id:string, fields:object}>} arg.items
 * @param {Array<{id:string, collection:string, rowRefs?:string[]}>} arg.decls
 * @param {Array<{runId:string, datasetId:string|number}>} arg.analyses
 * @param {{map: Map<string,string>}} arg.rowMap
 */
export function planRehome({ items = [], decls = [], analyses = [], rowMap }) {
  const refsFor = (collection) => decls.find((d) => d.id === collection)?.rowRefs ?? [];
  const byCollection = new Map();
  let movable = 0;
  let stranded = 0;

  for (const rec of items) {
    const { ok } = rehomeRecord(rec.fields, refsFor(rec.collection), rowMap?.map ?? new Map());
    const bucket = byCollection.get(rec.collection) ?? { collection: rec.collection, move: 0, strand: 0 };
    if (ok) { bucket.move++; movable++; } else { bucket.strand++; stranded++; }
    byCollection.set(rec.collection, bucket);
  }

  return {
    collections: [...byCollection.values()].sort((a, b) => a.collection.localeCompare(b.collection)),
    analyses: analyses.length,
    movable,
    stranded,
    strategy: rowMap?.strategy ?? 'none',
    // Nothing to do is worth saying plainly rather than showing an empty dialog.
    empty: movable === 0 && stranded === 0 && analyses.length === 0,
  };
}
