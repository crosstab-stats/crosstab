/**
 * @file merge.js
 * The collaboration merge kernel — the load-bearing piece under *every* transport
 * (folder-sync, cloud-API, live P2P). See the "Online collaboration" design in
 * TODO.md (#143).
 *
 * ## The architecture: the engine coordinates, the owner defines "merge"
 *
 * A project is two persistence tiers, and they merge differently:
 *
 *  - **The transform op-log** ({@link module:core/data-store~DataStore#log}) — a
 *    *dependent pipeline* of tabular ops, all **core-owned**. A wrong silent merge
 *    here yields plausible-but-wrong published numbers, so it uses a git-style
 *    **three-way merge** that auto-merges provably-disjoint ops and *surfaces*
 *    genuine collisions to the user (never silently resolves them). This lives in
 *    core because **core is the owner of the tabular state class** — not as a
 *    special exception.
 *  - **Plugin state blobs** ({@link module:core/workspace-store}) — each keyed by
 *    `(owner, wsId, slotId, dataset)`. These merge under **owner-declared** rules,
 *    because different plugins' data merges differently: a CAQDAS codebook is a set
 *    of codes → **add-wins**; a spatial workspace is named boundary slots →
 *    **add-wins on the slot set + last-writer-wins on each slot's blob**. Hardcoding
 *    one rule would be wrong for the other.
 *
 * The **engine owns the envelope, never the meaning** (the same doctrine as the
 * space-verb dispatch #145 and the storage-driver seam): op identity, common-
 * ancestor tracking, divergence detection, dispatch to each owner's merger,
 * **conflict *surfacing***, and the atomic commit. A merger may resolve cleanly
 * *or* return conflicts, but it can **never force a silent overwrite** of another
 * owner's state — the integrity model (#145/#146: a plugin writes only its own
 * state) contains an untrusted merger's blast radius to its own blob, which is
 * exactly what makes delegating the *meaning* of merge safe.
 *
 * Everything here is **pure** (no DuckDB, no DOM, no network) so the whole kernel
 * is testable headlessly — see `test/merge.test.mjs`.
 */

// ---------------------------------------------------------------------------
// Op identity — the primitive both transports need.
// ---------------------------------------------------------------------------

/** Op fields that are assigned/derived rather than authored, so they are excluded
 * from an op's identity/content signature. `src` holds a live DuckDB table handle
 * (not authored content); a source op's identity comes from its label + combine +
 * column signature instead (see {@link opContentSig}). */
const OP_ID_SKIP = new Set(['id', 'src']);

/**
 * Deterministic JSON: object keys sorted, so structurally-equal values stringify
 * identically on every machine (unlike `JSON.stringify`, whose key order follows
 * insertion). Used for content hashes and content comparison.
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * A 64-bit hex digest of a string via two independent FNV-1a passes. Plenty for op
 * identity (this is *not* a security hash); deterministic and synchronous, so the
 * same content yields the same id on every machine.
 * @param {string} str
 * @returns {string} 16 hex chars
 */
export function hash64(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0xc9dc5118 >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The authored-content signature of a log op — its identity independent of the
 * assigned `id` and the live `src` handle. Source ops (load/append/join) are
 * signed by combine-kind + label + column-name list + join key; every other op is
 * signed by its type + its remaining fields.
 * @param {object} op
 * @returns {string}
 */
export function opContentSig(op) {
  if (op.type === 'load' || op.type === 'append' || op.type === 'join') {
    const names = (op.src?.meta ?? []).map((m) => m.name).join('|');
    const jk = op.joinKey ? `${op.joinKey.left}>${op.joinKey.right}` : '';
    return `${op.type}::${op.src?.label ?? ''}::${names}::${jk}`;
  }
  const rest = {};
  for (const k of Object.keys(op)) if (!OP_ID_SKIP.has(k)) rest[k] = op[k];
  return `${op.type}::${stableStringify(rest)}`;
}

/**
 * A **deterministic** id for a legacy op (a saved project from before op-ids
 * existed), from its content signature + its index in the log. The same project
 * loaded on two machines gets the SAME ids, so a project shared *before*
 * collaboration existed stays mergeable.
 * @param {object} op
 * @param {number} index
 * @returns {string}
 */
export function deterministicOpId(op, index) {
  return `op-${hash64(`${index}::${opContentSig(op)}`)}`;
}

/**
 * A fresh id for a genuinely-new op created live. Random (not content-derived) so
 * two independent edits are two ops even if their content happens to match — the
 * merge layer then decides whether that is convergence or a conflict.
 * @returns {string}
 */
export function newOpId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `op-${uuid}` : `op-${hash64(`${Date.now()}:${Math.random()}`)}`;
}

/**
 * The **target** an op edits — the key used to detect two sides editing "the same
 * thing" independently. Two ops with the same target from different sides are a
 * semantic collision to surface; disjoint targets auto-merge.
 * @param {object} op
 * @returns {string}
 */
export function opTarget(op) {
  switch (op.type) {
    case 'setVariable':
    case 'recodeVar':
    case 'computeVar':
      return `var:${op.name}`;
    case 'renameVar':
      return `var:${op.from ?? op.name}`;
    case 'setCell':
      return `cell:${op.column}:${op.rid}`;
    case 'dropVars':
    case 'keepVars':
      return 'schema'; // structural — conservative: two schema edits collide
    case 'filterCases':
      return 'rows';
    case 'load':
    case 'append':
    case 'join':
      return `src:${op.id}`; // each source add is independent
    default:
      return `op:${op.id}`;
  }
}

// ---------------------------------------------------------------------------
// Merge helpers (the toolkit) — pure. Owners compose these; core uses threeWayLog
// for its own tabular state class.
// ---------------------------------------------------------------------------

const byId = (ops) => new Map((ops ?? []).map((o) => [o.id, o]));

/**
 * @typedef {Object} Conflict
 * @property {string} owner   Which state class the conflict is in (`'core'` or a plugin id).
 * @property {string} target  The thing both sides edited (see {@link opTarget}) / blob key.
 * @property {string} kind    `'edit/edit'` | `'edit/delete'` | `'add/add'`.
 * @property {string} label   Human-readable, for the resolution prompt.
 * @property {*} mine         This side's value/op.
 * @property {*} theirs       Their side's value/op.
 * @property {string[]} options  Choices the host offers, e.g. `['mine','theirs','both']`.
 */

/**
 * @typedef {Object} MergeResult
 * @property {*} resolved       The auto-merged value (log array, blob, …).
 * @property {Conflict[]} conflicts  Genuine collisions for the host to surface. Empty ⇒ clean.
 */

/**
 * Git-style three-way merge of an **op-log** (a dependent pipeline). Auto-merges
 * provably-disjoint ops (id-keyed) and **surfaces** genuine collisions rather than
 * silently picking a side — a wrong silent merge here becomes a wrong published
 * number. This is the merger core registers for its own tabular state class.
 *
 * Resolution, per op id across ancestor/mine/theirs:
 *  - added by one side only → keep it;
 *  - added by both with same id but differing content → `add/add` conflict;
 *  - in ancestor, changed by one side only → take the change;
 *  - in ancestor, changed by both to the same content → take it (convergent);
 *  - in ancestor, changed by both differently → `edit/edit` conflict;
 *  - removed by one side, changed by the other → `edit/delete` conflict;
 *  - removed by one/both, otherwise unchanged → remove.
 *
 * Then a **target pass**: independent additions from *both* sides that touch the
 * same {@link opTarget} (e.g. each side newly recodes `income`) are surfaced as an
 * `add/add` conflict even though their ids differ.
 *
 * Ordering (MVP, honest about its limits): surviving ancestor ops keep ancestor
 * order; mine's new ops then theirs' new ops append after, in each side's order.
 * A dependency-aware topological reorder is deferred — logged, not silently
 * assumed correct.
 *
 * @param {object[]} ancestor
 * @param {object[]} mine
 * @param {object[]} theirs
 * @param {string} [owner='core']
 * @returns {MergeResult}
 */
export function threeWayLog(ancestor, mine, theirs, owner = 'core') {
  const a = byId(ancestor);
  const m = byId(mine);
  const t = byId(theirs);
  const conflicts = [];
  const sig = (op) => (op ? opContentSig(op) : null);

  /** id → chosen op (or undefined = removed). Content decisions first; order after. */
  const chosen = new Map();
  const allIds = new Set([...a.keys(), ...m.keys(), ...t.keys()]);

  for (const id of allIds) {
    const ao = a.get(id);
    const mo = m.get(id);
    const to = t.get(id);
    const label = (op) => `${op.type}${op.name ? ` ${op.name}` : ''}`;

    if (!ao) {
      // Added on one or both sides (not in the common ancestor).
      if (mo && to) {
        if (sig(mo) === sig(to)) chosen.set(id, mo); // same op both sides → converge
        else conflicts.push({ owner, target: opTarget(mo), kind: 'add/add', label: `both added ${label(mo)} differently`, mine: mo, theirs: to, options: ['mine', 'theirs', 'both'] });
      } else chosen.set(id, mo ?? to);
      continue;
    }
    // Present in the ancestor.
    const mChanged = mo && sig(mo) !== sig(ao);
    const tChanged = to && sig(to) !== sig(ao);
    const mRemoved = !mo;
    const tRemoved = !to;

    if (mRemoved && tRemoved) continue; // both removed → gone
    if (mRemoved && tChanged) { conflicts.push({ owner, target: opTarget(to), kind: 'edit/delete', label: `you removed ${label(ao)}, they changed it`, mine: null, theirs: to, options: ['mine', 'theirs'] }); continue; }
    if (tRemoved && mChanged) { conflicts.push({ owner, target: opTarget(mo), kind: 'edit/delete', label: `they removed ${label(ao)}, you changed it`, mine: mo, theirs: null, options: ['mine', 'theirs'] }); continue; }
    if (mRemoved || tRemoved) continue; // removed one side, unchanged other → remove
    if (mChanged && tChanged) {
      if (sig(mo) === sig(to)) chosen.set(id, mo); // converged to the same edit
      else conflicts.push({ owner, target: opTarget(mo), kind: 'edit/edit', label: `both changed ${label(ao)} differently`, mine: mo, theirs: to, options: ['mine', 'theirs'] });
      continue;
    }
    if (mChanged) chosen.set(id, mo);
    else if (tChanged) chosen.set(id, to);
    else chosen.set(id, ao); // untouched
  }

  // Target pass: independent same-target additions from BOTH sides collide even
  // with different ids (two people each freshly recode the same variable).
  const addedMine = mine.filter((o) => !a.has(o.id) && chosen.has(o.id));
  const addedTheirs = theirs.filter((o) => !a.has(o.id) && chosen.has(o.id));
  const theirTargets = new Map(addedTheirs.map((o) => [opTarget(o), o]));
  for (const mo of addedMine) {
    const to = theirTargets.get(opTarget(mo));
    if (to && to.id !== mo.id) {
      conflicts.push({ owner, target: opTarget(mo), kind: 'add/add', label: `both independently added ${mo.type} ${mo.name ?? ''}`.trim(), mine: mo, theirs: to, options: ['mine', 'theirs', 'both'] });
    }
  }

  // Ordering (MVP): ancestor order for survivors, then mine-adds, then theirs-adds.
  const merged = [];
  const emit = (id) => { if (chosen.has(id)) { merged.push(chosen.get(id)); chosen.delete(id); } };
  for (const op of ancestor) emit(op.id);
  for (const op of mine) emit(op.id);
  for (const op of theirs) emit(op.id);

  return { resolved: merged, conflicts };
}

/**
 * **Add-wins set merge** — the CAQDAS codebook's rule. An item present on *either*
 * side survives (add beats a concurrent delete); an item is removed only if it was
 * in the ancestor and deleted on both sides. When the *same* item was edited
 * differently on the two sides, that's surfaced as an `edit/edit` conflict (the
 * host resolves; no silent pick).
 *
 * @param {Array} ancestor
 * @param {Array} mine
 * @param {Array} theirs
 * @param {(item:*) => string} keyFn  Stable identity of an item (e.g. code id).
 * @param {string} [owner='plugin']
 * @returns {MergeResult}
 */
export function addWinsSet(ancestor, mine, theirs, keyFn, owner = 'plugin') {
  const a = new Map((ancestor ?? []).map((x) => [keyFn(x), x]));
  const m = new Map((mine ?? []).map((x) => [keyFn(x), x]));
  const t = new Map((theirs ?? []).map((x) => [keyFn(x), x]));
  const conflicts = [];
  const resolved = [];
  const keys = new Set([...m.keys(), ...t.keys(), ...a.keys()]);

  for (const k of keys) {
    const ax = a.get(k);
    const mx = m.get(k);
    const tx = t.get(k);
    const inAncestor = a.has(k);

    if (inAncestor && !mx && !tx) continue; // deleted on both → remove (only way to remove)
    // Add-wins: present on either side (or one side deleted, the other kept/edited).
    if (mx && tx) {
      if (stableStringify(mx) === stableStringify(tx)) resolved.push(mx);
      else if (ax && stableStringify(mx) === stableStringify(ax)) resolved.push(tx); // only theirs edited
      else if (ax && stableStringify(tx) === stableStringify(ax)) resolved.push(mx); // only mine edited
      else { resolved.push(mx); conflicts.push({ owner, target: `item:${k}`, kind: 'edit/edit', label: `both edited item ${k}`, mine: mx, theirs: tx, options: ['mine', 'theirs'] }); }
    } else {
      resolved.push(mx ?? tx); // one side deleted, add-wins keeps the survivor
    }
  }
  return { resolved, conflicts };
}

/**
 * **Last-writer-wins** for an opaque scalar/blob — the rule for each spatial
 * boundary slot's bytes. Picks the side with the later `clock`; with no clock and
 * two differing concurrent edits, surfaces a conflict rather than guessing.
 *
 * @param {*} ancestor
 * @param {{value:*, clock?:number}} mine
 * @param {{value:*, clock?:number}} theirs
 * @param {string} [owner='plugin']
 * @param {string} [target='blob']
 * @returns {MergeResult}
 */
export function lww(ancestor, mine, theirs, owner = 'plugin', target = 'blob') {
  const aS = stableStringify(ancestor?.value ?? ancestor);
  const mS = stableStringify(mine?.value ?? mine);
  const tS = stableStringify(theirs?.value ?? theirs);
  if (mS === tS) return { resolved: mine?.value ?? mine, conflicts: [] };
  const mChanged = mS !== aS;
  const tChanged = tS !== aS;
  if (mChanged && !tChanged) return { resolved: mine?.value ?? mine, conflicts: [] };
  if (tChanged && !mChanged) return { resolved: theirs?.value ?? theirs, conflicts: [] };
  // Both changed differently.
  const mc = mine?.clock;
  const tc = theirs?.clock;
  if (typeof mc === 'number' && typeof tc === 'number' && mc !== tc) {
    return { resolved: (mc > tc ? mine : theirs).value, conflicts: [] };
  }
  return {
    resolved: mine?.value ?? mine,
    conflicts: [{ owner, target, kind: 'edit/edit', label: `both changed ${target}`, mine: mine?.value ?? mine, theirs: theirs?.value ?? theirs, options: ['mine', 'theirs'] }],
  };
}

// ---------------------------------------------------------------------------
// The coordinator — the engine's job: dispatch per owner, collect conflicts.
// ---------------------------------------------------------------------------

/**
 * Built-in declarative strategies an owner can name in its manifest instead of
 * writing a merge function. Keyed by `manifest.merge.strategy`.
 * @type {Record<string, (a:*, m:*, t:*, decl:object, owner:string) => MergeResult>}
 */
export const STRATEGIES = {
  'three-way': (a, m, t, _decl, owner) => threeWayLog(a ?? [], m ?? [], t ?? [], owner),
  'add-wins': (a, m, t, decl, owner) => {
    const keyFn = decl.keyFn ?? ((x) => x?.id ?? stableStringify(x));
    return addWinsSet(a ?? [], m ?? [], t ?? [], keyFn, owner);
  },
  lww: (a, m, t, _decl, owner) => lww(a, { value: m }, { value: t }, owner),
};

/**
 * Resolve a merger for one owner's declared merge config. A declaration is either
 * `{ strategy }` (a built-in) or `{ merge(fn) }` (a custom, envelope-enforced
 * function the plugin exported). Unknown/absent → a safe default that surfaces any
 * difference as a single conflict (never a silent pick).
 *
 * @param {object} decl  `manifest.merge` for this owner (or a core descriptor).
 * @returns {(ancestor:*, mine:*, theirs:*, owner:string) => MergeResult}
 */
export function resolveMerger(decl) {
  if (!decl) {
    return (a, m, t, owner) => (stableStringify(m) === stableStringify(t)
      ? { resolved: m, conflicts: [] }
      : { resolved: m, conflicts: [{ owner, target: 'state', kind: 'edit/edit', label: 'state differs (no merge strategy declared)', mine: m, theirs: t, options: ['mine', 'theirs'] }] });
  }
  if (typeof decl.merge === 'function') {
    return (a, m, t, owner) => {
      const r = decl.merge({ ancestor: a, mine: m, theirs: t, helpers: { threeWayLog, addWinsSet, lww, stableStringify } }) ?? {};
      return { resolved: r.resolved, conflicts: (r.conflicts ?? []).map((c) => ({ owner, ...c })) };
    };
  }
  const strat = STRATEGIES[decl.strategy];
  return (a, m, t, owner) => (strat ? strat(a, m, t, decl, owner) : { resolved: m, conflicts: [] });
}

/**
 * Merge two divergent project states from their common ancestor. Each state is
 * `{ log, blobs }` where `log` is the core transform op-log and `blobs` maps an
 * owner key → `{ owner, value }`. The `mergers` map supplies each owner's declared
 * merge config (`'core'` defaults to three-way); unknown owners fall back to the
 * safe default in {@link resolveMerger}.
 *
 * Returns the merged state plus **all** conflicts across every tier — the host
 * surfaces them together and commits atomically once resolved. This is the single
 * algorithm both transports run: folder-sync runs it on two files; live-sync runs
 * it continuously.
 *
 * @param {{ancestor: object, mine: object, theirs: object, mergers?: Record<string, object>}} arg
 * @returns {{log: object[], blobs: Record<string, *>, conflicts: Conflict[]}}
 */
export function mergeProject({ ancestor, mine, theirs, mergers = {} }) {
  const conflicts = [];

  // Tier 1: the core transform op-log (three-way; core owns the tabular class).
  const logMerge = resolveMerger(mergers.core ?? { strategy: 'three-way' })(
    ancestor?.log ?? [], mine?.log ?? [], theirs?.log ?? [], 'core',
  );
  conflicts.push(...logMerge.conflicts);

  // Tier 2: plugin state blobs, each dispatched to its owner's declared merger.
  const blobs = {};
  const keys = new Set([
    ...Object.keys(ancestor?.blobs ?? {}),
    ...Object.keys(mine?.blobs ?? {}),
    ...Object.keys(theirs?.blobs ?? {}),
  ]);
  for (const key of keys) {
    const owner = (mine?.blobs?.[key]?.owner) ?? (theirs?.blobs?.[key]?.owner) ?? key;
    const av = ancestor?.blobs?.[key]?.value;
    const mv = mine?.blobs?.[key]?.value;
    const tv = theirs?.blobs?.[key]?.value;
    if (mv === undefined && tv === undefined) continue;
    if (mv === undefined || tv === undefined) { blobs[key] = { owner, value: mv ?? tv }; continue; } // present one side
    const r = resolveMerger(mergers[owner])(av, mv, tv, owner);
    blobs[key] = { owner, value: r.resolved };
    conflicts.push(...r.conflicts);
  }

  return { log: logMerge.resolved, blobs, conflicts };
}
