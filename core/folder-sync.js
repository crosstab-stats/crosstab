/**
 * @file folder-sync.js
 * The folder-backed sync loop (#143) — the orchestration on top of the tested
 * merge brain ({@link module:core/collab-sync}) and the folder-aware
 * {@link ProjectStore}.
 *
 * A folder-backed project is one `projects/<id>/` bundle inside a picked folder the
 * OS sync client (OneDrive/Dropbox/iCloud/local) mirrors between machines. Two
 * people therefore write the *same* `project.json`. This module reconciles that:
 *
 *   read theirs (project.json) + base (project.base.json) + mine (this app's state)
 *   → decide → write the result → record it as the new base.
 *
 * The **base** is this client's common-ancestor snapshot: the last manifest it
 * agreed on. Diffing mine and theirs against it is what turns "two files that
 * differ" into "these specific edits, merged" — the git-style three-way merge, with
 * genuine collisions surfaced (never a silent wrong merge).
 *
 * `decideSync` is pure (headlessly testable); `syncOnce` adds the store I/O. The
 * picker/permission/polling that decide *when* to call `syncOnce` sit above.
 */

import { mergeManifests } from './collab-sync.js';
import { stableStringify } from './merge.js';
import { buildManifest } from './project-store.js';

/** Content signature of a manifest, ignoring fields that change without being a
 * real edit: `savedAt` (stamped every write) and `output` (regenerable analysis
 * results). Two manifests with the same signature are the same *work*.
 *
 * The `JSON.parse(JSON.stringify(...))` canonicalisation is load-bearing: an
 * in-memory manifest can carry `undefined`-valued keys (e.g. a non-join source's
 * `joinKey: undefined`) that a JSON round-trip **drops**. Without normalising, an
 * in-memory manifest would never signature-match the same manifest read back from
 * disk — so a poll would see a phantom "peer wrote" every tick and rewrite forever
 * (a self-inflicted write storm). Canonicalising both sides the way disk does makes
 * the comparison symmetric. */
function contentSig(m) {
  if (!m || typeof m !== 'object') return null;
  const { savedAt, output, ...rest } = JSON.parse(JSON.stringify(m));
  return stableStringify(rest);
}

/** Whether two manifests represent the same work (see {@link contentSig}). */
export function manifestsEqual(a, b) {
  return contentSig(a) === contentSig(b);
}

/**
 * Decide what a sync should do, given the common-ancestor `base`, this client's
 * current manifest `mine`, and the on-disk manifest `theirs`. Pure — no I/O.
 *
 *  - **seed** — nothing on disk yet: write mine, it becomes the base.
 *  - **in-sync** — disk already equals mine: nothing to do.
 *  - **push** — disk still equals the base (only *I* changed): write mine.
 *  - **merge** — disk advanced past the base (a peer wrote): three-way merge
 *    `(base, mine, theirs)`, surfacing any conflicts.
 *
 * With no base (first sync into a folder that already holds a project), `theirs` is
 * used as the ancestor — conservative: it keeps their work and layers mine on top,
 * rather than inventing divergence.
 *
 * @param {object|null} base
 * @param {object} mine
 * @param {object|null} theirs
 * @param {Record<string, object>} mergers  from `buildMergers` (see collab-sync)
 * @param {object|null} [resolutions]  user conflict choices (see the conflict UI);
 *   pass them back to re-run a merge to a clean result.
 * @returns {{action: 'seed'|'in-sync'|'push'|'merge', manifest: object, conflicts: object[]}}
 */
export function decideSync(base, mine, theirs, mergers = {}, resolutions = null) {
  if (!theirs) return { action: 'seed', manifest: mine, conflicts: [] };
  if (manifestsEqual(theirs, mine)) return { action: 'in-sync', manifest: theirs, conflicts: [] };
  if (base && manifestsEqual(theirs, base)) return { action: 'push', manifest: mine, conflicts: [] };
  const ancestor = base ?? theirs;
  const { manifest, conflicts } = mergeManifests(ancestor, mine, theirs, mergers, resolutions);
  return { action: 'merge', manifest, conflicts };
}

/**
 * Run one sync pass against the folder-backed store: read theirs + base, decide,
 * write the outcome, and record the new base. Returns the decision (with the
 * written manifest and any conflicts) so the caller can apply a merged result back
 * to the live app and surface conflicts.
 *
 * `now` is injectable so the write is testable deterministically; defaults to
 * `Date.now()` in real use.
 *
 * @param {object} arg
 * @param {import('./project-store.js').ProjectStore} arg.store  a folder-backed store
 * @param {string} arg.id       project id
 * @param {object} arg.mine     this client's current manifest
 * @param {Record<string, object>} [arg.mergers]
 * @param {object|null} [arg.resolutions]  user conflict choices — pass on a *second*
 *   call (after the conflict UI) to write a resolved merge. Absent + unresolved
 *   conflicts ⇒ nothing is written; the caller resolves then calls again.
 * @param {number} [arg.now]
 * @returns {Promise<{action: string, manifest: object, conflicts: object[]}>}
 */
export async function syncOnce({ store, id, mine, mergers = {}, resolutions = null, now }) {
  const theirs = await store.readManifest(id);
  const base = await store.readBase(id);
  const decision = decideSync(base, mine, theirs, mergers, resolutions);

  if (decision.action === 'in-sync') {
    if (!base) await store.writeBase(id, theirs); // adopt the on-disk state as our ancestor
    return decision;
  }

  // A merge with conflicts and no resolutions yet: don't write a half-decided
  // manifest — hand the conflicts back so the host can surface them, then call
  // again with `resolutions` to write the clean result.
  if (decision.action === 'merge' && decision.conflicts.length && !resolutions) {
    return { action: 'conflicts', manifest: decision.manifest, conflicts: decision.conflicts };
  }

  const stamped = { ...decision.manifest, savedAt: now ?? Date.now() };
  await store.writeManifest(id, stamped);
  await store.writeBase(id, stamped);
  return { ...decision, manifest: stamped };
}

/**
 * The full folder-sync pass for the live app: land my Parquet, build my manifest,
 * merge against the peer + base, resolve any conflicts, write the result, and — if a
 * peer contributed changes — hand the merged manifest back so the caller reloads it
 * into the app. This is what a folder-backed save/poll calls; it's the merge-aware
 * replacement for a blind `store.save` (two clients share one `project.json`, so a
 * plain overwrite would clobber the peer).
 *
 * Ordering matters: read the peer + base **before** writing anything, then land my
 * Parquet (so merged file-refs resolve), then own `project.json` via the merge.
 *
 * @param {object} arg
 * @param {import('./project-store.js').ProjectStore} arg.store  folder-backed store
 * @param {string} arg.id
 * @param {string} arg.name
 * @param {object} arg.bundle    this app's current bundle (from the project snapshot)
 * @param {Record<string, object>} [arg.mergers]  from `buildMergers`
 * @param {(conflicts: object[]) => Promise<object|null>} [arg.resolveConflicts]  show
 *   the conflict UI and return a resolutions map, or null to cancel the sync.
 * @param {(id: string, manifest: object) => Promise<void>} [arg.applyMerged]  reload
 *   the merged project into the app (called only when a peer actually contributed).
 * @param {Set<number>} [arg.dirty]  dataset ids whose Parquet changed (omit = all).
 * @param {number} [arg.now]
 * @returns {Promise<{action: string, conflicts: object[], changed: boolean}>}
 */
export async function syncFolderProject({ store, id, name, bundle, mergers = {}, resolveConflicts, applyMerged, dirty, now }) {
  const savedAt = now ?? Date.now();
  // 1. Read the peer + ancestor BEFORE writing anything.
  const theirs = await store.readManifest(id);
  const base = await store.readBase(id);
  // 2. Land my Parquet so a merged manifest's file refs resolve.
  await store.writeSourcesOnly(id, bundle, dirty);
  // 3. My manifest (pure — same builder save() uses).
  const mine = buildManifest({ name, savedAt, bundle });

  // 4. Decide; resolve conflicts if any. `surfaced` is what the user was asked
  //    about, reported back even after it's resolved (for a "merged, N resolved" note).
  let decision = decideSync(base, mine, theirs, mergers);
  const surfaced = decision.conflicts;
  if (decision.action === 'merge' && decision.conflicts.length) {
    const resolutions = resolveConflicts ? await resolveConflicts(decision.conflicts) : null;
    if (resolutions == null) return { action: 'cancelled', conflicts: surfaced, changed: false };
    decision = decideSync(base, mine, theirs, mergers, resolutions);
  }

  // 5. Write the outcome + record it as the new common ancestor.
  const merged = { ...decision.manifest, savedAt };
  await store.writeManifest(id, merged);
  await store.writeBase(id, merged);

  // 6. If a peer contributed (the result isn't just my own manifest), reload it.
  const changed = decision.action === 'merge' && !manifestsEqual(merged, mine);
  if (changed && applyMerged) await applyMerged(id, merged);
  return { action: decision.action, conflicts: surfaced, changed };
}
