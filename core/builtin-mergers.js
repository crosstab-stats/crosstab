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

/** Builtin id → its merge declaration (kernel-ready): a `merge` fn (composite blob,
 * e.g. CAQDAS codes/segments/memos add-wins) or a built-in `strategy`. Mirrors what
 * each plugin's `manifest.workspaces[].merge` declares. */
const BUILTIN_MERGERS = {
  'builtin-caqdas': { merge: caqdasMergeState }, // composite: codes + segments + memos
  'builtin-spatial': { strategy: 'lww' }, // per-slot last-writer-wins
};

/**
 * Assemble the merger map for a sync: core (always three-way) plus any ACTIVE builtin
 * plugins whose mergers the host can run. Shape matches what `mergeManifests`/
 * `mergeProject` expect (`owner → { merge } | { strategy }`).
 * @param {string[]} activeIds  ids of currently-active plugins (e.g. from plugins.list())
 * @returns {Record<string, object>}
 */
export function mergersFor(activeIds) {
  const mergers = { core: { strategy: 'three-way' } };
  for (const id of activeIds || []) {
    if (BUILTIN_MERGERS[id]) mergers[id] = BUILTIN_MERGERS[id];
  }
  return mergers;
}
