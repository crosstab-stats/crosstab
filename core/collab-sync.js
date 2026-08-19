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
/** Merger registry key for one plugin's workspace — owner-qualified so two plugins can
 * use the same workspace id without inheriting each other's merge strategy (#149 C4). */
export const mergerKey = (owner, wsId) => `${owner}\u0000${wsId}`;

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
 *  - **Scalars** — `activeId` mine; `output` regenerable (mine);
 *    `datasetMeta` merged (mine wins per key); collab identity kept.
 *
 * @param {object|null} mine
 * @param {object|null} theirs
 * @param {Record<string, object>} mergers  from {@link buildMergers}
 * @param {object|null} [resolutions]  user conflict choices (re-run to a clean result)
 * @returns {{manifest: object, conflicts: object[]}}
 */
/** The separator in an `item:` target's coordinates. */
const NUL = String.fromCharCode(0);

/**
 * Same-record, same-field writes made concurrently by two peers, for collections that
 * asked to hear about them.
 *
 * "Concurrent" here means neither side saw the other: the op is absent from the shared
 * ancestor on both sides. A field both peers changed, to different values, from a common
 * starting point is a real disagreement rather than a sequence of edits.
 *
 * @param {object[]} mo @param {object[]} to  one owner's ops from each peer
 * @param {string} owner
 * @param {(owner: string, collection: string) => boolean} [surfaces]
 */
function concurrentItemConflicts(mo, to, owner, surfaces) {
  if (typeof surfaces !== 'function') return [];
  const shared = new Set(sharedAncestor(mo, to).map((o) => o.id));
  const newOps = (ops) => ops.filter((o) => o.type === 'putItem' && !shared.has(o.id));
  const fieldsOf = (ops) => {
    const byTarget = new Map();
    for (const o of orderByHlc(newOps(ops))) {
      if (!byTarget.has(o.target)) byTarget.set(o.target, {});
      Object.assign(byTarget.get(o.target), o.payload?.fields ?? {});
    }
    return byTarget;
  };
  const mineBy = fieldsOf(mo);
  const theirsBy = fieldsOf(to);
  const out = [];
  for (const [target, mineFields] of mineBy) {
    const theirFields = theirsBy.get(target);
    if (!theirFields) continue;
    const [, collection] = String(target).startsWith('item:')
      ? String(target).slice('item:'.length).split(NUL)
      : [];
    if (!collection || !surfaces(owner, collection)) continue;
    for (const [field, mineVal] of Object.entries(mineFields)) {
      if (!(field in theirFields)) continue;
      if (stableStringify(mineVal) === stableStringify(theirFields[field])) continue;
      out.push({ owner, scope: target, field, mine: mineVal, theirs: theirFields[field], kind: 'item-field' });
    }
  }
  return out;
}

export function mergeProjects(mine, theirs, mergers = {}, resolutions = null, opts = {}) {
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

    // Item records normally resolve a same-record collision silently by HLC, which is
    // right for most plugin data — you do not prompt someone about a polygon. But a
    // collection may declare `onConcurrentEdit: 'surface'`, and then a genuine collision
    // is reported instead of decided. Two coders disagreeing about where a passage
    // begins is the case: letting the clock pick a winner destroys one of their
    // judgements silently, which is precisely what per-coder records exist to prevent.
    //
    // The union above still stands — nothing is dropped. This only ADDS a conflict for
    // the user to settle, so declining to settle it leaves today's behaviour intact.
    conflicts.push(...concurrentItemConflicts(mo, to, owner, opts.surfaces));

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
      // Keyed by (owner, wsId) first: a third-party plugin naming its workspace
      // `caqdas-coding` must NOT get CAQDAS's merger run on its own blob (#149 C4).
      // The bare-wsId lookup stays as a fallback for mergers registered before the
      // owner was part of the key.
      const decl = mergers[mergerKey(owner, wsIdOf(key))] ?? mergers[wsIdOf(key)] ?? mergers[owner];
      const r = resolveMerger(decl, { resolutions, scope: key })(av, m.value, t.value, owner);
      conflicts.push(...(r.conflicts ?? []).map((c) => ({ owner, ...c })));
      // Deterministic merge op: same id + hlc on both peers ⇒ converges, never oscillates.
      const payload = { value: r.resolved, label: m.label ?? t.label ?? null };
      const latestHlc = (ops) => orderByHlc(ops.filter((o) => o.target === key)).slice(-1)[0]?.hlc ?? { wall: 0, counter: 0 };
      const lm = latestHlc(mo);
      const lt = latestHlc(to);
      const hlc = { wall: Math.max(lm.wall, lt.wall), counter: Math.max(lm.counter, lt.counter) + 1 };
      // The id must be derived from the INPUTS as well as the output (#149 B4). Hashing
      // only (target + resolved value) meant a later merge that happened to resolve to a
      // previously-emitted value re-minted the SAME id with a HIGHER hlc — reachable via
      // delete-and-redo under add-wins. `receiveOps` dedups by id, so the newer copy was
      // silently dropped and the leaf's LWW fold could then pick an ordinary write over
      // the merge result, leaving peers genuinely out of step while `manifestsEqual`
      // (an id-set comparison) reported them in sync. The contributing op ids are the
      // same SET on both peers (only the operand order differs), so sorting keeps it
      // deterministic.
      const contributors = [...new Set([...mo, ...to].filter((o) => o.target === key).map((o) => o.id))].sort();
      const id = deterministicOpId({ target: key, owner, type: 'setWorkspace', payload, reads: contributors }, key);
      merged.push({ id, hlc, target: key, owner, type: 'setWorkspace', reads: [], payload });
    }
  }

  const manifest = {
    name: mine?.name ?? theirs?.name,
    savedAt: mine?.savedAt ?? theirs?.savedAt,
    activeId: mine?.activeId ?? theirs?.activeId,
    // `activePlugins` is NOT merged here any more (#157). It moved onto the log as
    // `plugin:` ops, so it merges by op-union + HLC like everything else — which is the
    // only way "off" can win. A union of two sets can only grow, so a deactivation could
    // never propagate: whichever peer still had the plugin on re-added it every merge.
    // The scalar is still written by savers for backward compatibility and carried
    // through here untouched; nothing reads it back.
    activePlugins: mine?.activePlugins ?? theirs?.activePlugins ?? null,
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
        if (typeof fn === 'function') {
          const m = { merge: fn, ...(decl.keyFn ? { keyFn: decl.keyFn } : {}) };
          mergers[ws.id] = m;
          mergers[mergerKey(p.id, ws.id)] = m; // owner-qualified (#149 C4)
        }
      } else if (decl.strategy) {
        const m = { strategy: decl.strategy, ...(decl.keyFn ? { keyFn: decl.keyFn } : {}) };
        mergers[ws.id] = m;
        mergers[mergerKey(p.id, ws.id)] = m; // owner-qualified (#149 C4)
      }
    }
  }
  return mergers;
}
