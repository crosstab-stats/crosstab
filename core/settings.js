/**
 * @file settings.js
 * One declared home for the user's preferences.
 *
 * ## Why
 *
 * Core reaches into `localStorage` from a dozen-odd places, but most of that is state,
 * cache or credentials (see the boundary below). The **eight genuine preferences**, held
 * by **five modules** — `var-order`, `screen-mode`, `debug`, `at-rest`, `live-sync` —
 * had each rebuilt the same five pieces: a key, the values it accepts, a default,
 * validate-on-read so a hand-edited value cannot poison the app, and a `try/catch` on
 * both sides because storage throws outright in Safari private mode and in a sandboxed
 * frame. Five copies of a rule is where copies drift.
 *
 * (Those two numbers are asserted by `test/settings-store.test.mjs`. A count in a comment
 * is a measurement, and measurements rot — this one already had, within a day of being
 * written, when the shaped settings arrived and "six" quietly became eight.)
 *
 * The second reason is the one that shaped the design: a single **Settings screen** needs
 * to enumerate what is settable, and no amount of `getItem` wrapping gives it that. So
 * this is a registry rather than a get/set helper — each setting *declares* itself with
 * the label, group and options a screen would need, and {@link listSettings} is that
 * screen's whole data source. Same shape as `menus.register` and the plugin manifests:
 * declare it, and the host renders it.
 *
 * ## What belongs here, and what deliberately does not
 *
 * A setting is something **a person would change about how the app behaves**, and that it
 * would be reasonable to show them a list of. That excludes most of what is in
 * `localStorage`, and the exclusions are the point rather than an oversight:
 *
 *  - **Install and enable state** (`crosstab.plugins.*`) — not a preference; it is what
 *    the plugin manager *is*, with its own UI and its own migration rules.
 *  - **Caches** (the plugin catalogue) — regenerable, and listing it would invite someone
 *    to "fix" it.
 *  - **Transient handoffs** (`crosstab.oauth.result`, the offline resume in
 *    `sessionStorage`) — alive for one round trip.
 *  - **Credentials** (`crosstab.dropbox.config`) — a screen that enumerates settings must
 *    never be the thing that prints a token.
 *  - **Identity and first-run flags** (`crosstab.identity`, `crosstab.launcher.seen`) —
 *    data and lifecycle, not preference.
 *
 * The encryption policy and the collab relay/TURN config ARE settings and are declared
 * here. They are shaped — an object and an array — rather than scalar, which is the only
 * reason they waited: a registry that could hold nothing but strings was a gap in the
 * registry, not a property of those settings. Hence `json` and `coerce` below.
 *
 * One of them carries a secret. A TURN entry has `username`/`credential`, and a registry
 * whose whole purpose is to let a screen enumerate settings must not be the thing that
 * prints those — so a setting may declare itself `secret`, and {@link listSettings} then
 * reports only whether it is set.
 *
 * ## Keys are never renamed
 *
 * Every `key` below is the one that module already used. A tidier naming scheme would
 * silently reset the preference of every existing user on upgrade — the kind of change
 * that costs nothing to make and cannot be undone once shipped. `legacyKeys` carries the
 * read-only fallbacks that predate a rename.
 */

/**
 * @typedef {Object} SettingSpec
 * @property {string} id - Stable registry id (`group.name`), used by {@link listSettings}.
 * @property {string} key - The `localStorage` key. Never changed once shipped.
 * @property {string[]} [legacyKeys] - Older keys, read as a fallback and never written.
 * @property {any[]} [values] - The accepted values. A stored value outside this set is
 *   treated as absent, so a hand-edited or stale entry degrades to the default rather
 *   than reaching the app.
 * @property {boolean} [json] - Stored as JSON rather than as a bare string.
 * @property {(value: any) => any} [coerce] - Accept, adjust or REJECT a value. Applied
 *   both to what is read out of storage and to what is written in, so one rule covers
 *   both directions. Returning `undefined` rejects: on read that yields the fallback, on
 *   write the call is a no-op. This is where a shaped setting states its shape — and
 *   where the encryption policy merges what is stored over its defaults, so that a stored
 *   partial stays a partial.
 * @property {any} [fallback=null] - The value when nothing valid is stored. May be a
 *   FUNCTION, called per read, for a default a caller might mutate: the encryption policy
 *   has always handed back a fresh object and has to keep doing so.
 * @property {any} [onError] - The value when storage THROWS, which is not always the
 *   same answer — see `screen-mode.autoNote`, where a dismissal that cannot be
 *   remembered must read as "already seen" or the note nags on every load. Defaults to
 *   `fallback`.
 * @property {boolean} [secret] - The value may contain a credential, so {@link
 *   listSettings} reports only whether it is set. See the TURN config.
 * @property {string} [label] - Shown by a Settings screen.
 * @property {string} [group] - How a Settings screen would section it.
 * @property {string} [hint] - One line on what the choice does.
 * @property {Array<[any, string]>} [options] - `[value, label]` pairs for a `<select>`.
 */

/** @type {Map<string, SettingSpec>} */
const registry = new Map();

/** Read at call time, never captured: a test can install a fake, and `localStorage` does
 * not exist at all under `node --test`. */
const storage = () => globalThis.localStorage;

/**
 * Declare a setting and get its accessors.
 *
 * @param {SettingSpec} spec
 * @returns {{get: () => any, set: (v: any) => void, clear: () => void, spec: SettingSpec}}
 */
export function defineSetting(spec) {
  if (registry.has(spec.id)) throw new Error(`settings: "${spec.id}" is already defined`);
  // One key, one owner. Two settings over one key is a silent fight, and the loser is
  // whichever one happens to write last.
  for (const other of registry.values()) {
    if (other.key === spec.key) throw new Error(`settings: "${spec.id}" reuses the key of "${other.id}"`);
  }
  const full = { fallback: null, legacyKeys: [], ...spec };
  if (!('onError' in full)) full.onError = full.fallback;
  registry.set(full.id, full);

  return {
    spec: full,
    get() {
      try {
        const s = storage();
        let raw = s?.getItem(full.key);
        for (const legacy of full.legacyKeys) {
          if (raw == null) raw = s?.getItem(legacy);
        }
        const v = decode(full, raw);
        return v === undefined ? resolve(full.fallback) : v;
      } catch {
        return resolve(full.onError); // storage disabled (private mode, sandboxed frame)
      }
    },
    /**
     * Write a value. An unaccepted one is a no-op, not a throw: a caller passing rubbish
     * is a bug to fix, and corrupting the stored preference on the way out helps nobody.
     *
     * "Unaccepted" is not the same as "means clear". `setRelayUrls([])` clears the
     * override and says so by calling {@link clear} — rather than leaning on an empty
     * array being quietly rejected here, which would read the same and mean something
     * else entirely.
     */
    set(value) {
      const v = accept(full, value);
      if (v === undefined) return;
      try {
        storage()?.setItem(full.key, full.json ? JSON.stringify(v) : v);
      } catch { /* storage unavailable */ }
    },
    /** Forget the choice — the stored absence that `fallback` describes. */
    clear() {
      try { storage()?.removeItem(full.key); } catch { /* storage unavailable */ }
    },
  };
}

/** A fallback may be a thunk, for a default a caller could mutate. */
const resolve = (f) => (typeof f === 'function' ? f() : f);

/** Storage string -> value, or `undefined` when there is nothing usable there. */
function decode(spec, raw) {
  if (raw == null) return undefined;
  let v = raw;
  if (spec.json) {
    // A malformed entry is treated as absent rather than thrown. It is one hand edit or
    // one half-finished write away, and taking the app down over it would be a worse
    // answer than falling back to the default.
    try { v = JSON.parse(raw); } catch { return undefined; }
  }
  return accept(spec, v);
}

/** Value -> the value to use, or `undefined` to reject it. */
function accept(spec, value) {
  if (spec.values) return spec.values.includes(value) ? value : undefined;
  if (spec.coerce) return spec.coerce(value);
  return value == null ? undefined : value;
}

/**
 * Every declared setting with its current value — the data source for a Settings screen.
 *
 * Returns only what has been *declared*, which is the point: a key written directly to
 * `localStorage` by some module is, by construction, not a setting, and will not appear
 * in a list that claims to be the settings.
 *
 * @returns {Array<SettingSpec & {value: any}>}
 */
export function listSettings() {
  return [...registry.values()].map((spec) => {
    let value;
    let isSet = false;
    try {
      const raw = storage()?.getItem(spec.key);
      isSet = raw != null;
      const v = decode(spec, raw);
      value = v === undefined ? resolve(spec.fallback) : v;
    } catch {
      value = resolve(spec.onError);
    }
    // A TURN entry carries `username`/`credential`. WHETHER one is configured is a fine
    // thing for a screen to show; its contents are not, and a registry that printed them
    // would have turned "list the settings" into a credential dump.
    return spec.secret ? { ...spec, value: undefined, isSet } : { ...spec, value, isSet };
  });
}

/** Declared ids, for tests and for anything that needs to check coverage. */
export function settingIds() {
  return [...registry.keys()];
}

/** Drop every declaration. Tests only — modules declare at import, and an import runs once. */
export function _resetRegistry() {
  registry.clear();
}
