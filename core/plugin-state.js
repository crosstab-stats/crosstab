/**
 * @file plugin-state.js
 * Which plugins are ACTIVE in a project, as ops on the one true log (#157).
 *
 * ## Why this exists
 *
 * The active set used to be a scalar array on the manifest — `activePlugins` — snapshot
 * from a live read of the plugin manager at save time, and merged between peers with a
 * set UNION. That shape had no way to say "off". A union only grows, so a deactivation
 * could not propagate: a co-author's set kept re-adding the plugin you had just switched
 * off, and no policy patched over it without inventing a tie-break rule the log already
 * knows how to answer.
 *
 * This is the same defect the project NAME had (#149 A3): state living beside the log,
 * merged by a scalar rule, so one peer's change never reached the other and the next
 * save quietly reverted it. The fix is the same too — make it ops.
 *
 * ## The shape
 *
 * One target per plugin, `plugin:<key>`, carrying `activatePlugin` / `deactivatePlugin`.
 * The fold is last-writer-wins per plugin, in HLC order, which gives for free everything
 * the union rule had to fake:
 *
 *  - **Off is a fact, not an absence.** A deactivation is a positive op with a clock, so
 *    it beats an earlier activation from either peer.
 *  - **Merge is the ordinary op-union.** No `unionArr`, no per-field policy.
 *  - **It is undoable and it shows in History**, like every other op.
 *  - **Absence still means nothing.** A plugin with no ops is simply unspoken-for, which
 *    is what lets a project stay silent about plugins it never used.
 *
 * Identity is the manager's `key` (the load descriptor — a built-in URL or a user entry),
 * not the plugin id, because that is what activation acts on and what survives a plugin
 * that fails to load and therefore has no id yet.
 */

import { liveOps } from './op-log.js';

/** Target for one plugin's activation state. */
export const pluginTarget = (key) => `plugin:${key}`;

/** The key back out of a `plugin:<key>` target (null if it isn't one). */
export function keyOfPluginTarget(target) {
  return typeof target === 'string' && target.startsWith('plugin:') ? target.slice('plugin:'.length) : null;
}

/** Is this op part of the plugin-activation tier? */
export const isPluginOp = (op) => op?.owner === 'core' && typeof op?.target === 'string' && op.target.startsWith('plugin:');

/** The plugin-activation tier of a flat log (a `.crosstab` import, a merge result). */
export const pluginOpsOf = (log) => (log ?? []).filter(isPluginOp);

/**
 * Fold activation ops into the set of active plugin keys — last writer wins per plugin,
 * in the log's canonical HLC order. Undone ops are hidden by {@link liveOps}, so an undo
 * of a deactivation restores the activation beneath it without any special casing.
 *
 * @param {import('./op-log.js').Op[]} ops
 * @returns {Set<string>}
 */
export function foldPluginState(ops) {
  const state = new Map(); // key → boolean
  for (const op of liveOps(ops)) {
    const key = keyOfPluginTarget(op.target);
    if (!key) continue;
    if (op.type === 'activatePlugin') state.set(key, true);
    else if (op.type === 'deactivatePlugin') state.set(key, false);
  }
  const active = new Set();
  for (const [key, on] of state) if (on) active.add(key);
  return active;
}

/**
 * Every plugin the project has an OPINION about, and what it is. Distinct from
 * {@link foldPluginState}, which answers only "what is on" — a caller reconciling the
 * live plugin manager needs to know the difference between "the project says off" and
 * "the project has never mentioned this plugin", because only the first should switch
 * anything off.
 *
 * @returns {Map<string, boolean>} key → active
 */
export function foldPluginOpinions(ops) {
  const state = new Map();
  for (const op of liveOps(ops)) {
    const key = keyOfPluginTarget(op.target);
    if (!key) continue;
    if (op.type === 'activatePlugin') state.set(key, true);
    else if (op.type === 'deactivatePlugin') state.set(key, false);
  }
  return state;
}

/** The projection registered on {@link module:core/project-log~ProjectLog}. */
export const PLUGIN_STATE = {
  key: 'plugins',
  match: isPluginOp,
  fold: (ops) => foldPluginState(ops),
};

/**
 * Ops that would move the project from its current recorded opinions to `want`.
 *
 * Emitting an op only where the state actually differs keeps the log free of no-op
 * churn: re-activating something already recorded as active writes nothing, so a project
 * open (which reconciles the manager against the log) cannot spam the log with a fresh
 * op per plugin per session.
 *
 * @param {Map<string, boolean>} opinions  from {@link foldPluginOpinions}
 * @param {Iterable<string>} want          keys that should be active
 * @param {Iterable<string>} known         every installed key, so a plugin dropping out
 *   of `want` can be recorded as deactivated rather than silently forgotten
 * @returns {Array<{target: string, owner: 'core', type: string, payload: {key: string}}>}
 */
export function pluginOpsFor(opinions, want, known) {
  const on = want instanceof Set ? want : new Set(want);
  const all = new Set([...(known ?? []), ...on, ...opinions.keys()]);
  const out = [];
  for (const key of all) {
    const should = on.has(key);
    if (opinions.get(key) === should) continue; // already recorded — say nothing
    out.push({
      target: pluginTarget(key),
      owner: 'core',
      type: should ? 'activatePlugin' : 'deactivatePlugin',
      payload: { key },
    });
  }
  return out;
}

/**
 * Migrate a legacy `activePlugins` array into ops (#157).
 *
 * Old saves recorded the set as a scalar. On open we turn it into the activations it
 * implied, so the project keeps working and immediately starts carrying its state the
 * new way. Only ACTIVATIONS: the old array said nothing about plugins it omitted — they
 * might have been deliberately off or simply not installed on that machine — and
 * inventing deactivations from an absence is exactly the inference this tier exists to
 * stop making.
 *
 * @param {string[]|null} activePlugins  the legacy scalar
 * @param {Map<string, boolean>} opinions  what the log already says (skip those)
 * @param {(idOrKey: string) => string|null} resolveKey  the array may hold plugin IDs
 *   (what `project-bundle` wrote) or manager keys; the caller knows how to map them
 */
export function migrateLegacyActivePlugins(activePlugins, opinions, resolveKey) {
  if (!Array.isArray(activePlugins) || !activePlugins.length) return [];
  const out = [];
  const seen = new Set();
  for (const entry of activePlugins) {
    const key = resolveKey(entry);
    if (!key || seen.has(key) || opinions.has(key)) continue;
    seen.add(key);
    out.push({ target: pluginTarget(key), owner: 'core', type: 'activatePlugin', payload: { key } });
  }
  return out;
}
