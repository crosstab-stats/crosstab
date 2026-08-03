/**
 * @file builtin-mergers.js
 * Host-side merger registry for the BUILTIN plugins (#148 step 6b) — the piece that
 * makes plugin-blob merge (CAQDAS coding, spatial slots) actually happen in the real
 * app, for BOTH transports (folder sync + live co-authoring).
 *
 * Why this exists: the merge kernel dispatches each workspace blob to its owner's
 * declared merger (`manifest.merge`), but a `via: 'fnName'` declaration needs the
 * plugin *module* to resolve the name to a live function — and the app never had the
 * modules host-side (plugins run sandboxed), so `#folderSave` fell back to `{core}`
 * only and coding never merged. Builtins are trusted, in-repo, and their mergers are
 * PURE functions (no DOM/app access), so the host can import them directly — no
 * sandbox bridge needed. Third-party plugin blobs still need that bridge (deferred);
 * until then they fall back to the kernel's safe default (surface a conflict).
 *
 * NOTE the deliberate core→plugin import: it's confined to this one file and pulls
 * only pure merge logic (the plugin module has no top-level side effects).
 */

import { mergeState as caqdasMergeState } from '../plugins/builtin-caqdas/index.js';

/** Builtin plugin id → its workspaces' merge declarations, keyed by **workspace id**
 * (the granularity the merge dispatches at — one plugin can own several workspaces with
 * different mergers). Mirrors each plugin's `manifest.workspaces[].{id, merge}`. */
const BUILTIN_MERGERS = {
  'builtin-caqdas': { 'caqdas-coding': { merge: caqdasMergeState } }, // composite: codes + segments + memos
  'builtin-spatial': { 'spatial-map': { strategy: 'lww' }, 'spatial-link': { strategy: 'lww' } }, // per-slot LWW
};

/**
 * Assemble the merger map for a sync: core (always three-way) plus any ACTIVE builtin
 * plugins' mergers, keyed by **workspace id** — the key {@link module:core/collab-sync~mergeProjects}
 * looks up per workspace leaf (a leaf's target carries its wsId; all builtins share the
 * `builtin` owner token, so owner alone can't pick the right merger). Third-party plugin
 * blobs still need the sandbox bridge (deferred) → they fall back to the safe default.
 * @param {string[]} activeIds  ids of currently-active plugins (from plugins.list())
 * @returns {Record<string, object>}
 */
export function mergersFor(activeIds) {
  const mergers = { core: { strategy: 'three-way' } };
  for (const id of activeIds || []) {
    if (BUILTIN_MERGERS[id]) Object.assign(mergers, BUILTIN_MERGERS[id]); // spread wsId → decl
  }
  return mergers;
}
