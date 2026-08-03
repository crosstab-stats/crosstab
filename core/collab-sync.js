/**
 * @file collab-sync.js
 * Project-level merge — the transport's brain (#143/#148), now on the ONE TRUE LOG.
 *
 * A persisted project is a single flat op-log (`manifest.log`) spanning every tier —
 * collection, dataset data, analysis, and the plugin workspace (`ws:`) tier — plus a
 * few non-log scalars. {@link mergeProjects} merges two divergent projects entirely by
 * **op identity**: the common ancestor is the shared op-id set ({@link sharedAncestor}),
 * so there is NO separate `project.base.json`. Core ops three-way merge by id; each
 * plugin owner's workspace blobs are folded per leaf and merged by that owner's declared
 * merger (the CAQDAS composite, spatial lww), with the merged value emitted as a
 * **deterministic** op so both peers converge to the identical log with no oscillation.
 *
 * Pure — no FS, no DOM, no network — so it is headlessly testable. The browser wiring
 * (picker, permission, polling, writing bytes) sits above it (folder-sync / live-sync).
 */

import { threeWayLog, resolveMerger, deterministicOpId, stableStringify } from './merge.js';
import { sharedAncestor, orderByHlc, liveOps } from './op-log.js';

const isCore = (op) => op.owner === 'core';
const isWs = (op) => typeof op?.target === 'string' && op.target.startsWith('ws:');
/** The workspace id embedded in a `ws:<owner>\0<wsId>\0<slot>\0<dsKey>` target — the key
 * the merge dispatches on (all builtins share the `builtin` owner token, so owner alone
 * can't pick the merger; the wsId does, matching {@link module:core/builtin-mergers}). */
const wsIdOf = (target) => String(target).slice(3).split('\0')[1];

/**
 * Fold one plugin owner's `ws:` ops into per-leaf `{value, label}` keyed by target
 * (last-writer-wins, liveness-aware via {@link liveOps}). A `setWorkspace{value:null}` or
 * a `clearWorkspace` clears; the latest applied write wins. Pure.
 * @param {import('./op-log.js').Op[]} ops
 * @returns {Map<string, {value: *, label: string|null}>}
 */
function foldWsLeaves(ops) {
  const leaves = new Map();
  for (const op of liveOps(ops)) {
    if (op.type === 'setWorkspace') {
      const v = op.payload?.value ?? null;
      if (v == null) leaves.delete(op.target);
      else leaves.set(op.target, { value: v, label: op.payload?.label ?? null });
    } else if (op.type === 'clearWorkspace') {
      const prefix = `${op.target}\0`;
      for (const k of [...leaves.keys()]) if (k.startsWith(prefix)) leaves.delete(k);
    }
  }
  return leaves;
}

const unionArr = (a, b) => {
  const s = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
  return s.size ? [...s] : null;
};

/**
 * Three-way merge two divergent project manifests (each `{log, …scalars}`) from their
 * common ancestor — the shared op-id history, no separate base.
 *
 *  - **Core ops** (collection + data + analysis, `owner:'core'`) — {@link threeWayLog}
 *    by id: disjoint targets union, a genuine same-target concurrent edit is surfaced.
 *    Deletion (`retract`/`removeDataset`) and undo/redo are ordinary ops, so they
 *    propagate; nothing is inferred from absence.
 *  - **Workspace ops** (`owner:` a plugin) — union every write by id, then for any leaf
 *    both sides diverged on, fold each side to its blob value and run the owner's merger
 *    (CAQDAS composite / spatial lww) with the shared-ancestor fold as the ancestor.
 *    The merged value is emitted as a **deterministic** `setWorkspace` op (id + hlc a
 *    pure function of the inputs), so both peers produce the identical op → the union
 *    dedups it → convergence, and it can't oscillate (it re-enters the shared ancestor).
 *  - **Scalars** — `activeId` mine; `activePlugins` unioned; `output` regenerable (mine);
 *    `datasetMeta` merged (mine wins per key); collab identity kept.
 *
 * @param {object|null} mine
 * @param {object|null} theirs
 * @param {Record<string, object>} mergers  from {@link buildMergers}
 * @param {object|null} [resolutions]  user conflict choices (re-run to a clean result)
 * @returns {{manifest: object, conflicts: object[]}}
 */
export function mergeProjects(mine, theirs, mergers = {}, resolutions = null) {
  const conflicts = [];
  const mineLog = mine?.log ?? [];
  const theirsLog = theirs?.log ?? [];

  // --- core tier: op-log three-way by id (ancestor = shared op-id set) ---
  const coreMine = mineLog.filter(isCore);
  const coreTheirs = theirsLog.filter(isCore);
  const coreR = resolveMerger(mergers.core ?? { strategy: 'three-way' }, { resolutions, scope: 'core' })(
    sharedAncestor(coreMine, coreTheirs), coreMine, coreTheirs, 'core',
  );
  conflicts.push(...(coreR.conflicts ?? []));
  const merged = [...(coreR.resolved ?? [])];

  // --- workspace tier: per plugin owner, per leaf ---
  const wsOwners = new Set([...mineLog, ...theirsLog].filter((o) => !isCore(o)).map((o) => o.owner));
  for (const owner of wsOwners) {
    const mo = mineLog.filter((o) => o.owner === owner);
    const to = theirsLog.filter((o) => o.owner === owner);
    // Union every write by id — both peers keep everything they wrote.
    const byId = new Map();
    for (const o of [...mo, ...to]) if (!byId.has(o.id)) byId.set(o.id, o);
    merged.push(...byId.values());

    // Blob-merge each leaf both sides diverged on.
    const mineLeaves = foldWsLeaves(mo);
    const theirsLeaves = foldWsLeaves(to);
    const ancLeaves = foldWsLeaves(sharedAncestor(mo, to));
    for (const key of new Set([...mineLeaves.keys(), ...theirsLeaves.keys()])) {
      const m = mineLeaves.get(key);
      const t = theirsLeaves.get(key);
      if (!m || !t) continue; // add-wins single side (the union already kept its op)
      if (stableStringify(m.value) === stableStringify(t.value)) continue; // equal → nothing to do
      const av = ancLeaves.get(key)?.value ?? null;
      // Dispatch by workspace id (the leaf's wsId), NOT the shared owner token — that's
      // what maps to the plugin's declared merger (e.g. caqdas-coding → mergeState).
      const decl = mergers[wsIdOf(key)] ?? mergers[owner];
      const r = resolveMerger(decl, { resolutions, scope: key })(av, m.value, t.value, owner);
      conflicts.push(...(r.conflicts ?? []).map((c) => ({ owner, ...c })));
      // Deterministic merge op: same id + hlc on both peers ⇒ converges, never oscillates.
      const payload = { value: r.resolved, label: m.label ?? t.label ?? null };
      const latestHlc = (ops) => orderByHlc(ops.filter((o) => o.target === key)).slice(-1)[0]?.hlc ?? { wall: 0, counter: 0 };
      const lm = latestHlc(mo);
      const lt = latestHlc(to);
      const hlc = { wall: Math.max(lm.wall, lt.wall), counter: Math.max(lm.counter, lt.counter) + 1 };
      const id = deterministicOpId({ target: key, owner, type: 'setWorkspace', payload }, key);
      merged.push({ id, hlc, target: key, owner, type: 'setWorkspace', reads: [], payload });
    }
  }

  const manifest = {
    name: mine?.name ?? theirs?.name,
    savedAt: mine?.savedAt ?? theirs?.savedAt,
    activeId: mine?.activeId ?? theirs?.activeId,
    activePlugins: unionArr(mine?.activePlugins, theirs?.activePlugins),
    output: Array.isArray(mine?.output) ? mine.output : (theirs?.output ?? null), // regenerable
    datasetMeta: { ...(theirs?.datasetMeta ?? {}), ...(mine?.datasetMeta ?? {}) }, // mine wins per key
    collabId: mine?.collabId ?? theirs?.collabId ?? null,
    collabSecret: mine?.collabSecret ?? theirs?.collabSecret ?? null,
    log: orderByHlc(merged),
  };
  return { manifest, conflicts };
}

/**
 * Plan how to bring a live dataset set to `incoming` from `current` by dataset id +
 * a content signature, so a merge apply touches ONLY what changed (never dispose-all).
 * Signature = the dataset's ops (its `ds:<id>/…` slice), so a rename (a collection-tier
 * op) doesn't force a DuckDB rebuild. Entries are `{id, ops}` (folded from the log).
 * Pure. Returns dataset ids grouped by the action the apply should take.
 *
 * @param {Array<{id:*, ops?:object[]}>} current
 * @param {Array<{id:*, ops?:object[]}>} incoming
 * @returns {{add: any[], rebuild: any[], keep: any[], remove: any[]}}
 */
export function planDatasetApply(current, incoming) {
  const sig = (d) => stableStringify((d?.ops ?? []).map((o) => o.id).sort());
  const cur = new Map((current ?? []).map((d) => [d.id, d]));
  const inc = new Map((incoming ?? []).map((d) => [d.id, d]));
  const add = [];
  const rebuild = [];
  const keep = [];
  const remove = [];
  for (const [id, d] of inc) {
    const c = cur.get(id);
    if (!c) add.push(id);
    else if (sig(c) !== sig(d)) rebuild.push(id);
    else keep.push(id);
  }
  for (const id of cur.keys()) if (!inc.has(id)) remove.push(id);
  return { add, rebuild, keep, remove };
}

/**
 * Build the `mergers` map from the currently-loaded plugins (owner → merge declaration):
 *  - `merge: { via: 'fnName' }` → the plugin module's named export;
 *  - `merge: { strategy }` → a built-in kernel strategy.
 * `core` is always three-way. A plugin with no declaration falls back to the kernel's
 * safe default (surface any difference). See {@link module:core/builtin-mergers}.
 *
 * @param {Array<{id: string, manifest: object, module?: object}>} plugins
 * @returns {Record<string, object>}
 */
export function buildMergers(plugins) {
  const mergers = { core: { strategy: 'three-way' } };
  for (const p of plugins ?? []) {
    const wss = Array.isArray(p?.manifest?.workspaces) ? p.manifest.workspaces : [];
    for (const ws of wss) {
      const decl = ws?.merge;
      if (!decl) continue;
      // Key by WORKSPACE id (what mergeProjects dispatches on), not plugin id.
      if (decl.via) {
        const fn = p.module?.[decl.via];
        if (typeof fn === 'function') mergers[ws.id] = { merge: fn, ...(decl.keyFn ? { keyFn: decl.keyFn } : {}) };
      } else if (decl.strategy) {
        mergers[ws.id] = { strategy: decl.strategy, ...(decl.keyFn ? { keyFn: decl.keyFn } : {}) };
      }
    }
  }
  return mergers;
}
