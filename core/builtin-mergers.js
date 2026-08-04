/**
 * @file builtin-mergers.js
 * Host-side merger registry for the BUILTIN plugins (#148 step 6b) — the piece that
 * makes plugin-blob merge (CAQDAS coding, spatial slots) actually happen in the real
 * app, for BOTH transports (folder sync + live co-authoring).
 *
 * Why this exists: the merge kernel dispatches each workspace blob to its owner's
 * declared merger (`manifest.merge`), and a `via: 'fnName'` declaration needs the plugin
 * *module* host-side to resolve the name — which the app does not have, since plugins run
 * sandboxed. Builtins are trusted and in-repo, so the host can register theirs directly.
 *
 * Much smaller than it was. After #152 the builtins' real state lives in item records,
 * which merge by op-union with no declared merger at all; what is left here is the
 * handful of genuinely blob-shaped config values. The core→plugin import that used to
 * pull CAQDAS's merge function is gone with it.
 */

/** Builtin plugin id → its workspaces' merge declarations, keyed by **workspace id**
 * (the granularity the merge dispatches at — one plugin can own several workspaces with
 * different mergers). Mirrors each plugin's `manifest.workspaces[].{id, merge}`. */
const BUILTIN_MERGERS = {
  // Both are now plain config blobs. CAQDAS's composite merger is gone: codes, segments
  // and memos became item records and host memos (#152 L3), which merge by op-union in
  // the kernel, so the only blob left is which columns hold the documents and labels.
  // Spatial's map blob is gone entirely — boundary sets are records too — leaving its
  // per-dataset linkage config.
  'builtin-caqdas': { 'caqdas-coding': { strategy: 'lww' } },
  'builtin-spatial': { 'spatial-link': { strategy: 'lww' } },
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
