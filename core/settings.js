/**
 * @file settings.js
 * One declared home for the user's preferences.
 *
 * ## Why
 *
 * Core reaches into `localStorage` from a dozen-odd places, but most of that is state,
 * cache or credentials (see the boundary below). The genuine preferences were spread
 * across `var-order`, `screen-mode`, `debug`, `at-rest` and `live-sync`, and each module
 * had rebuilt the same five pieces: a key, the values it accepts, a default,
 * validate-on-read so a hand-edited value cannot poison the app, and a `try/catch` on
 * both sides because storage throws outright in Safari private mode and in a sandboxed
 * frame. Copies of a rule are where rules drift.
 *
 * `listSettings()` is the authority on what is declared and how many — deliberately not
 * repeated here. A census in a header is a snapshot pasted into a sentence that is not
 * one: this paragraph said "six" and was wrong within the day, when the shaped settings
 * arrived.
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
 *  - **Enable state** (`crosstab.plugins.disabled`) — not a preference; it is what the
 *    plugin manager *is*, with its own UI and its own migration rules, and sixty-odd
 *    built-ins are not a list anyone wants enumerated on a preferences screen.
 *  - **Caches** (the plugin catalogue) — regenerable, and listing it would invite someone
 *    to "fix" it.
 *  - **Transient handoffs** (`crosstab.oauth.result`, the offline resume in
 *    `sessionStorage`) — alive for one round trip.
 *
 * That exclusion used to read `crosstab.plugins.*`, and the wildcard was doing damage.
 * `crosstab.plugins.user` is not install state: it is the set of **sources this person
 * chose**, one kind of which is a URL — third-party code re-fetched from someone else's
 * host and executed on every launch. A screen that answers "what have I configured in
 * this app?" cannot leave that out; of everything in this registry it is the entry most
 * worth seeing at a glance. It is declared now in `plugin-manager.js` and **routed**, and
 * the manager stays the only writer — `set()` here reports that a value was accepted, not
 * that it reached the disk, and that file's own write path reports a real quota failure
 * after once losing an authored plugin to a swallowed one.
 *
 * `crosstab.plugins.web` came out of the same wildcard, and is the sharper of the two: it
 * is the standing set of "yes, this plugin may fetch from that host" answers. A permission
 * given once in a modal, about a thing that then happens silently on every run, whose only
 * previous trace was a one-letter badge inside the plugin manager. It is declared and
 * routed beside the other. Neither offers a Clear, and the grants one must not: those
 * grants live in a `Map` for the life of the page, so deleting the key from here would
 * leave every one of them working until a reload — a revoke that does not revoke.
 *
 * Two more bullets stood here and are gone, and they are the reason this list is now
 * written about members rather than families:
 *
 *  - **"Credentials (`crosstab.dropbox.config`) — must never print a token."** The rule is
 *    right and the premise was false: that key holds a PKCE **app key**, which the
 *    sign-in dialog itself calls out as not a secret, plus a folder path. The real tokens
 *    are memory-only by design and never reach disk. So the exclusion guarded against
 *    something that cannot happen while hiding what a person would actually check — is
 *    this device set up to reach my Dropbox, and which folder does it use. Declared in
 *    `dropbox-session.js`, routed, and deliberately NOT marked `secret`: that would
 *    restate the same wrong thing in a new place.
 *  - **"First-run flags (`crosstab.launcher.seen`) — lifecycle, not preference."** Undone
 *    by two things. First, the registry already holds a seen-flag: `screen.autoNoteSeen`
 *    is exactly "have you been shown this once", declared, and simply given no `label`.
 *    So the rule the code follows is not "lifecycle flags are not settings" — it is
 *    *declare it, and show it only if a person could act on it*. Second, the owner's case:
 *    an IT technician sets up a shortcut and launches it once to check it works, and the
 *    flag is now set on a device whose real user has never seen it, with no way back.
 *    Shown, in `launcher.js`, labelled for what it actually does (which set the plugin
 *    picker starts pre-ticked from) rather than what "seen" sounds like it should do.
 *
 * Found the same way as the identity gap: the owner working the manual test pass, then an
 * audit of every remaining key. Every one of them was an exclusion written as a *family*
 * when only one member of the family qualified — four times, by the same mechanism. A
 * category name in this list is a claim about each member, and is worth re-reading as one
 * before it is trusted.
 *
 * `crosstab.identity` was on that last line too, as "data, not preference". That was half
 * right, and it is the half that hid the other: `authorId` is an identifier the user
 * never chooses, but the display name, initials, avatar colour and "automatically check
 * for live collaborators" stored beside it are preferences — the last of them a toggle
 * that decides whether opening a project reaches the network. The owner found all four
 * missing from the Settings screen while working the manual pass. It is declared now, in
 * `user-identity.js`, and **routed**: the screen shows a summary that never includes the
 * authorId and sends you to the editor that already exists.
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
 * @property {(value: any) => string} [summary] - One line describing a SHAPED value, for
 *   a screen that would otherwise have to print an object. Declared by the owning module
 *   for the same reason `apply` is: only it knows which fields are the preference and
 *   which are plumbing. The identity blob uses it to show the name, initials and
 *   auto-join state while never printing the minted `authorId`.
 * @property {string} [label] - Shown by a Settings screen.
 * @property {string} [group] - How a Settings screen would section it.
 * @property {string} [hint] - One line on what the choice does.
 * @property {Array<[any, string]>} [options] - `[value, label]` pairs for a `<select>`.
 * @property {(value: any) => void} [apply] - Make a stored change TAKE EFFECT, declared by
 *   the owning module because only it knows what that means. Called by {@link setSetting}
 *   and {@link clearSetting} after the write, with the value that is now in force.
 *
 *   **Must not write.** The registry has already stored the value; an `apply` that stored
 *   it again would make the write path depend on which of two stores ran last. A setting
 *   with no `apply` is one that is simply read when next needed — which is most of them,
 *   and is why this is optional rather than required.
 * @property {string} [editedAt] - Where the REAL control for this setting lives, when a
 *   Settings screen should route to it rather than offer its own. Named rather than
 *   linked: the module declaring a setting must not have to import the dialog that edits
 *   it (`at-rest.js` is imported BY `encryption-settings.js`, so the reverse is a cycle).
 *   A screen shows the current value read-only and this text beside it.
 */

/** @type {Map<string, SettingSpec>} */
const registry = new Map();

/**
 * id -> the accessor object {@link defineSetting} handed its declaring module.
 *
 * Kept so that {@link setSetting} can write through the SAME closure the module uses
 * rather than re-implementing encode/accept beside it. A second write path would be a
 * second set of rules about what a valid value is, and the screen would be the client of
 * whichever one happened to be more lenient.
 *
 * @type {Map<string, {get: Function, set: Function, clear: Function}>}
 */
const accessors = new Map();

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

  const api = {
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
     * Write a value, returning whether it was ACCEPTED. An unaccepted one is a no-op, not
     * a throw: a caller passing rubbish is a bug to fix, and corrupting the stored
     * preference on the way out helps nobody.
     *
     * "Unaccepted" is not the same as "means clear". `setRelayUrls([])` clears the
     * override and says so by calling {@link clear} — rather than leaning on an empty
     * array being quietly rejected here, which would read the same and mean something
     * else entirely.
     */
    set(value) {
      const v = accept(full, value);
      if (v === undefined) return false;
      try {
        storage()?.setItem(full.key, full.json ? JSON.stringify(v) : v);
      } catch { /* storage unavailable */ }
      // TRUE means the value was accepted, not that it reached the disk. Storage failing
      // is already handled everywhere else here by being invisible (`onError` answers the
      // read), and the caller that needed a return value — a Settings screen — is asking
      // "was my input valid", which is a different question with a different remedy.
      return true;
    },
    /** Forget the choice — the stored absence that `fallback` describes. */
    clear() {
      try { storage()?.removeItem(full.key); } catch { /* storage unavailable */ }
    },
  };
  accessors.set(full.id, api);
  return api;
}

/**
 * Write a setting BY ID, for a Settings screen — which holds specs, not accessors.
 *
 * {@link listSettings} made the registry a complete data SOURCE for a screen and left it
 * unable to change anything: the accessors go to the declaring module and nowhere else.
 * So a screen could render every setting and edit none of them.
 *
 * Routed through the module's own accessor, so an unaccepted value is the same no-op it
 * would be anywhere else, and then through the spec's `apply` so the change takes effect.
 * Returns whether the value was accepted — a screen needs to know, because a rejected
 * write leaves the control showing something that was never stored.
 *
 * @param {string} id
 * @param {any} value
 * @returns {boolean} whether it was accepted and written
 */
export function setSetting(id, value) {
  const api = accessors.get(id);
  const spec = registry.get(id);
  if (!api || !spec) return false;
  if (!api.set(value)) return false;
  // The value that is now in force, which is not always the one passed in: a `coerce` may
  // adjust it, and `apply` has to act on what was actually stored.
  spec.apply?.(api.get());
  return true;
}

/**
 * Return a setting to its default — the stored absence, not a written default value.
 *
 * The distinction is the whole point of `fallback`: `screen.mode` unset means "let the
 * viewport decide", which no concrete value can express.
 *
 * @param {string} id
 * @returns {boolean} whether the id was known
 */
export function clearSetting(id) {
  const api = accessors.get(id);
  const spec = registry.get(id);
  if (!api || !spec) return false;
  api.clear();
  spec.apply?.(api.get());
  return true;
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
  accessors.clear();
}
