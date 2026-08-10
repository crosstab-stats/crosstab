/**
 * @file folder-sync.js
 * The folder-backed sync loop (#143/#148) — orchestration on top of the op-log merge
 * ({@link module:core/collab-sync~mergeProjects}) and the folder-aware {@link ProjectStore}.
 *
 * A folder-backed project is one `project.json` (a flat op-log) inside a picked folder
 * the OS sync client (OneDrive/Dropbox/iCloud/local) mirrors between machines. Two
 * people therefore write the SAME file. This reconciles that by **op union**:
 *
 *   read theirs (project.json) → land my Parquet → merge(mine, theirs) → write the result.
 *
 * There is **no base** (`project.base.json` is gone): the merge derives the common
 * ancestor from the shared op-id set, so a peer that syncs last never mis-reads a peer's
 * op as a deletion. `decideSync` is pure (headlessly testable); `syncFolderProject` adds
 * the store I/O. The picker/permission/polling that decide *when* to sync sit above.
 */

import { mergeProjects } from './collab-sync.js';
import { stableStringify } from './merge.js';
import { opIds } from './op-log.js';
import { buildManifest } from './project-store.js';

/** Content signature of a manifest — its DURABLE work, ignoring fields that change
 * without being a real edit: `savedAt` (stamped every write), `output` (regenerable
 * analysis pixels), and `activeId` (per-peer view state). The log is compared by its
 * op-id SET (order-independent), so two peers that converged on the same ops match even
 * if a re-sort left the arrays differently ordered. */
function contentSig(m) {
  if (!m || typeof m !== 'object') return null;
  return stableStringify({
    log: [...opIds(m.log ?? [])].sort(),
    activePlugins: Array.isArray(m.activePlugins) ? [...m.activePlugins].sort() : null,
    datasetMeta: m.datasetMeta ?? null,
    collabId: m.collabId ?? null,
  });
}

/** Whether two manifests represent the same work (see {@link contentSig}). */
export function manifestsEqual(a, b) {
  return contentSig(a) === contentSig(b);
}

/**
 * Decide what a sync should do given this client's current manifest `mine` and the
 * on-disk `theirs`. Pure — no I/O, no base.
 *
 *  - **seed** — nothing on disk yet: write mine.
 *  - **in-sync** — same work already: nothing to do.
 *  - **merge** — otherwise: op-union merge (mine, theirs), surfacing any conflicts.
 *
 * Operand order is canonicalised (lower content signature fills the "mine" slot on both
 * sides) so BOTH peers compute the byte-identical merged log — otherwise two idle
 * windows would poll-write forever.
 *
 * @param {object} mine
 * @param {object|null} theirs
 * @param {Record<string, object>} mergers  from `buildMergers`
 * @param {object|null} [resolutions]  user conflict choices (re-run to a clean result)
 * @returns {{action: 'seed'|'in-sync'|'merge', manifest: object, conflicts: object[]}}
 */
export function decideSync(mine, theirs, mergers = {}, resolutions = null) {
  if (!theirs) return { action: 'seed', manifest: mine, conflicts: [] };
  if (manifestsEqual(theirs, mine)) return { action: 'in-sync', manifest: theirs, conflicts: [] };
  const [lo, hi] = contentSig(mine) <= contentSig(theirs) ? [mine, theirs] : [theirs, mine];
  const { manifest, conflicts } = mergeProjects(lo, hi, mergers, resolutions);
  return { action: 'merge', manifest, conflicts };
}

/**
 * Run one sync pass against the folder-backed store: read theirs, decide, write the
 * outcome. Returns the decision (with the written manifest + conflicts).
 *
 * @param {object} arg
 * @param {import('./project-store.js').ProjectStore} arg.store  a folder-backed store
 * @param {string} arg.id
 * @param {object} arg.mine     this client's current manifest
 * @param {Record<string, object>} [arg.mergers]
 * @param {object|null} [arg.resolutions]
 * @param {number} [arg.now]
 * @returns {Promise<{action: string, manifest: object, conflicts: object[]}>}
 */
export async function syncOnce({ store, id, mine, mergers = {}, resolutions = null, now }) {
  const theirs = await store.readManifest(id);
  const decision = decideSync(mine, theirs, mergers, resolutions);
  if (decision.action === 'in-sync') return decision;
  if (decision.action === 'merge' && decision.conflicts.length && !resolutions) {
    return { action: 'conflicts', manifest: decision.manifest, conflicts: decision.conflicts };
  }
  const stamped = { ...decision.manifest, savedAt: now ?? Date.now() };
  await store.writeManifest(id, stamped);
  return { ...decision, manifest: stamped };
}

/**
 * The full folder-sync pass for the live app: land my Parquet, build my manifest, merge
 * against the peer (op union — no base), resolve conflicts, write the result, and — if a
 * peer contributed ops — hand the merged manifest back so the caller reloads it.
 *
 * Ordering: read the peer BEFORE writing anything, then land my Parquet (op-id-keyed
 * sidecars, so a merged source op's file ref resolves), then own `project.json`.
 *
 * @param {object} arg
 * @param {import('./project-store.js').ProjectStore} arg.store  folder-backed store
 * @param {string} arg.id
 * @param {string} arg.name
 * @param {object} arg.bundle    this app's current bundle (from the project snapshot)
 * @param {Record<string, object>} [arg.mergers]  from `buildMergers`
 * @param {(conflicts: object[]) => Promise<object|null>} [arg.resolveConflicts]
 * @param {(id: string, manifest: object) => Promise<void>} [arg.applyMerged]
 * @param {Set<number>} [arg.dirty]  dataset ids whose Parquet changed (omit = all).
 * @param {number} [arg.now]
 * @returns {Promise<{action: string, manifest: object, conflicts: object[], changed: boolean}>}
 */
export async function syncFolderProject({ store, id, name, bundle, mergers = {}, resolveConflicts, applyMerged, dirty, now }) {
  const savedAt = now ?? Date.now();
  // 1. Read the peer first. A throw here means the file is THERE and unreadable (a
  // stale key, or a half-written rewrite) — never seed over that. `readManifest`
  // returns null only for genuine absence, which is the one case seeding is right for.
  let theirs;
  try {
    theirs = await store.readManifest(id);
  } catch (err) {
    return { action: 'blocked', conflicts: [], changed: false, manifest: null,
      reason: `the folder's project file could not be read (${err?.message || err}) — nothing was written` };
  }
  await store.writeSourcesOnly(id, bundle, dirty); // 2. land my Parquet
  const mine = buildManifest({ name, savedAt, bundle }); // 3. my manifest (pure)

  // 4. Decide; resolve conflicts if any (report what was surfaced even after resolution).
  let decision = decideSync(mine, theirs, mergers);
  const surfaced = decision.conflicts;
  if (decision.action === 'merge' && decision.conflicts.length) {
    const resolutions = resolveConflicts ? await resolveConflicts(decision.conflicts) : null;
    if (resolutions == null) return { action: 'cancelled', conflicts: surfaced, changed: false, manifest: null };
    decision = decideSync(mine, theirs, mergers, resolutions);
  }

  // 5. Write the outcome.
  const merged = { ...decision.manifest, savedAt };
  await store.writeManifest(id, merged);

  // 6. If a peer contributed ops (the result isn't just my own work), reload it.
  const changed = decision.action === 'merge' && !manifestsEqual(merged, mine);
  if (changed && applyMerged) await applyMerged(id, merged);
  return { action: decision.action, conflicts: surfaced, changed, manifest: merged };
}
