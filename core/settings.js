/**
 * @file settings.js
 * One declared home for the user's preferences.
 *
 * ## Why
 *
 * Nine core modules reached into `localStorage` independently, and the six that store a
 * genuine *preference* had each rebuilt the same five pieces: a key, the values it
 * accepts, a default, validate-on-read so a hand-edited value cannot poison the app, and
 * a `try/catch` on both sides because storage throws outright in Safari private mode and
 * in a sandboxed frame. Five copies of a rule is where copies drift.
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
 * Collab relay/TURN config (`crosstab.relays`, `crosstab.turn`) is the honest borderline:
 * user-editable and screen-worthy, but shaped (arrays and objects) rather than scalar.
 * Left where it is until the screen exists to say what editing it should look like.
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
 * @property {any} [fallback=null] - The value when nothing valid is stored.
 * @property {any} [onError] - The value when storage THROWS, which is not always the
 *   same answer — see `screen-mode.autoNote`, where a dismissal that cannot be
 *   remembered must read as "already seen" or the note nags on every load. Defaults to
 *   `fallback`.
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

  const ok = (v) => (full.values ? full.values.includes(v) : v != null);

  return {
    spec: full,
    get() {
      try {
        const s = storage();
        let raw = s?.getItem(full.key);
        for (const legacy of full.legacyKeys) {
          if (raw == null) raw = s?.getItem(legacy);
        }
        return ok(raw) ? raw : full.fallback;
      } catch {
        return full.onError; // storage disabled (private mode, sandboxed frame)
      }
    },
    /** Writing an unaccepted value is a no-op, not a throw: a caller passing rubbish is a
     * bug to fix, and corrupting the stored preference on the way out helps nobody. */
    set(value) {
      if (!ok(value)) return;
      try { storage()?.setItem(full.key, value); } catch { /* storage unavailable */ }
    },
    /** Forget the choice — the stored absence that `fallback` describes. */
    clear() {
      try { storage()?.removeItem(full.key); } catch { /* storage unavailable */ }
    },
  };
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
    let value = spec.fallback;
    try {
      const raw = storage()?.getItem(spec.key);
      value = (spec.values ? spec.values.includes(raw) : raw != null) ? raw : spec.fallback;
    } catch { value = spec.onError; }
    return { ...spec, value };
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
