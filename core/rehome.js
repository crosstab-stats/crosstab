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

/**
 * Everything currently bound to `fromId`, ready to plan against.
 *
 * Only records BOUND to that dataset — a project-scoped record (null dsId) is visible
 * from every dataset and belongs to none, so moving it would be meaningless. This is
 * why the codebook stopped being part of #151: codes are project-scoped now.
 *
 * @param {object} arg
 * @param {string|number} arg.fromId
 * @param {{list:Function}} arg.itemStore
 * @param {Array<{id:string, owner:string, rowRefs?:string[]}>} arg.decls
 * @param {{entries:Function}} [arg.analysisLog]
 */
export function gatherRehome({ fromId, itemStore, decls, analysisLog }) {
  const key = String(fromId);
  const items = [];
  for (const d of decls ?? []) {
    for (const rec of itemStore.list(d.owner, d.id, { dsId: fromId }) ?? []) {
      // `list` with a dsId also returns project-scoped records; keep only the bound ones.
      if (String(rec.scope?.dsId ?? '') !== key) continue;
      items.push({ owner: d.owner, collection: d.id, id: rec.id, fields: rec.fields });
    }
  }
  const analyses = (analysisLog?.entries?.() ?? [])
    .filter((e) => e.datasetId != null && String(e.datasetId) === key);
  return { items, analyses };
}

/**
 * Move what can be moved. Returns what actually happened, including what was left.
 *
 * Records are re-put under the SAME id with a new scope, so nothing is duplicated and
 * anything referencing a record by id still resolves. A record whose row reference
 * cannot be mapped is skipped and reported — never repointed at a row that merely
 * happens to exist.
 *
 * Analyses are NOT relabelled. An analysis entry records what was run against A, and
 * silently restamping it with B's id would claim results that were never produced.
 * They are re-RUN against B instead, through the ordinary replay path, so the output in
 * the pane is genuinely B's.
 */
export async function applyRehome({
  fromId, toId, rowMap, items, decls, analyses = [],
  itemStore, analysisLog, replay,
}) {
  const refsFor = (collection) => decls.find((d) => d.id === collection)?.rowRefs ?? [];
  const map = rowMap?.map ?? new Map();
  let moved = 0;
  const stranded = [];

  for (const rec of items) {
    const { fields, ok } = rehomeRecord(rec.fields, refsFor(rec.collection), map);
    if (!ok) { stranded.push(rec); continue; }
    itemStore.put(rec.owner, rec.collection, rec.id, fields, { scope: { dsId: toId } });
    moved++;
  }

  let replayed = 0;
  let failed = 0;
  for (const entry of analyses) {
    try {
      await replay?.({ ...entry, datasetId: toId });
      replayed++;
    } catch {
      // One analysis failing to re-run must not abandon the rest — a plugin may be
      // deactivated, or B may simply lack a variable the run needed.
      failed++;
    }
  }
  if (replayed && analysisLog?.clearFor) analysisLog.clearFor(fromId);

  return { moved, stranded, replayed, failed };
}
