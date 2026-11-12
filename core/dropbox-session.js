/**
 * @file dropbox-session.js
 * The OAuth session behind the Dropbox driver (#143) — sign in, hold a token, refresh it.
 *
 * The driver deliberately knows nothing about any of this. It asks for a token per
 * request through `getToken()`, so renewal happens here and a save that spans an expiry
 * simply picks up the new one.
 *
 * ## The app key is configuration, not a credential
 *
 * A Dropbox **app key** is the OAuth client id. PKCE publishes it by design — it names
 * the application, not the user, and every browser client ships it in the clear. (The app
 * *secret* is a different thing, and has nowhere safe to live in a browser: this never
 * asks for one.) So it is stored in plain `localStorage` beside the folder path, and can
 * be read by anyone with the machine, which costs nothing.
 *
 * It is **not baked into the source**, and that is a deliberate choice rather than
 * caution about secrecy:
 *
 *  - A registration belongs to whoever made it. Hardcoding one person's app key would put
 *    their name on every other user's consent screen, and route strangers' authorisations
 *    through an app they do not control.
 *  - A Dropbox app starts in *development* mode with a hard cap on linked accounts, so a
 *    shipped key would simply fail for everyone but its owner, in a way that looks like a
 *    bug rather than a quota.
 *  - An institution that will not approve a third-party app can register its own and
 *    point at that, which is the same reasoning that keeps the whole cloud layer
 *    bring-your-own.
 *
 * ## Token custody
 *
 * The access token and refresh token live in memory for the session and are never
 * written to disk — the policy the owner set for WebDAV, applied to the credential that
 * is actually long-lived. The cost is signing in again after a reload; the benefit is
 * that a machine at rest holds no key to anyone's cloud storage.
 */

import { makePkcePair, authorizeUrl, newState, exchangeToken, needsRefresh, runAuthPopup } from './oauth-pkce.js';
import { DROPBOX_OAUTH } from './storage-dropbox.js';
import { defineSetting } from './settings.js';

const KEY = 'crosstab.dropbox.config';

/** Fields worth remembering between sessions. Tokens are conspicuously not among them. */
const PUBLIC_FIELDS = Object.freeze(['appKey', 'basePath']);

/**
 * The remembered Dropbox setup, as a declared setting.
 *
 * `core/settings.js` excluded this key under **Credentials**, reasoning that "a screen
 * that enumerates settings must never be the thing that prints a token". The rule is
 * right. The premise is not: **this key has never held a token.** The access and refresh
 * tokens live in memory for the session only (see the file header above), and
 * {@link PUBLIC_FIELDS} is the whole of what is written — an `appKey`, which the sign-in
 * dialog itself calls out as *not* a secret ("the app *secret* is, and is not used
 * here"), and a folder path.
 *
 * So the exclusion was protecting against something that cannot happen, while hiding the
 * thing a person would actually want to check: whether this device is set up to reach
 * their Dropbox at all, and which folder it uses. That made it the fourth entry in that
 * list written as a *category* — Credentials — rather than about the member.
 *
 * It is declared as an ordinary routed row rather than a `secret` one, because calling it
 * secret would state the same wrong thing in a new place: a reader would reasonably infer
 * a credential is stored here, and the entire design is that none is.
 */
const dropboxSetting = defineSetting({
  id: 'storage.dropbox',
  key: KEY,
  json: true,
  // The same narrowing `loadConfig` does, so the screen cannot describe a field this
  // module would refuse to load — including one a future build might add.
  coerce: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = {};
    for (const f of PUBLIC_FIELDS) if (typeof v[f] === 'string' && v[f]) out[f] = v[f];
    return out;
  },
  fallback: {},
  label: 'Dropbox',
  group: 'Privacy',
  editedAt: 'the Dropbox sign-in, or here',
  hint: 'CrossTab uses your own Dropbox app registration, so the permission screen names '
    + 'your app and nothing is routed through anyone else. Only the app key and folder are '
    + 'kept here — the sign-in itself is never written to disk, which is why you sign in '
    + 'again after a reload.',
  summary: (v) => {
    const cfg = v && typeof v === 'object' ? v : {};
    if (!cfg.appKey && !cfg.basePath) return 'Not set up';
    const where = cfg.basePath ? ` · ${cfg.basePath}` : '';
    // Never the key itself. It is not a secret, but it is fifteen characters of noise
    // that nobody reads, and printing identifiers by default is a habit worth not having.
    return cfg.appKey ? `App key saved${where}` : `No app key yet${where}`;
  },
});

/** Saved app key + folder, or empty. Never throws — a corrupt entry must not cost the UI. */
export function loadConfig(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? '{}');
    const out = {};
    for (const f of PUBLIC_FIELDS) if (typeof raw?.[f] === 'string') out[f] = raw[f];
    return out;
  } catch {
    return {};
  }
}

/** Remember the app key and folder. Anything else handed in is dropped, as with WebDAV. */
export function saveConfig(cfg, storage = globalThis.localStorage) {
  const out = {};
  for (const f of PUBLIC_FIELDS) if (cfg?.[f] != null) out[f] = String(cfg[f]);
  try { storage?.setItem(KEY, JSON.stringify(out)); } catch { /* private mode — not fatal */ }
  return out;
}

/** The redirect target: a static page on our own origin, never the app itself. */
export const redirectUriFor = (loc = globalThis.location) =>
  `${loc.origin}${loc.pathname.replace(/[^/]*$/, '')}oauth-callback.html`;

/**
 * A signed-in Dropbox session.
 *
 * @param {object} opts
 * @param {string} opts.appKey
 * @param {string} [opts.redirectUri]
 * @param {typeof fetch} [opts.fetch]
 * @param {Function} [opts.openPopup]  injectable for tests
 */
export class DropboxSession {
  #appKey;
  #redirectUri;
  #fetch;
  #openPopup;
  #access = null;
  #refresh = null;
  #expiresAt = 0;
  /** In-flight refresh, so N concurrent requests hitting an expired token produce ONE
   * renewal rather than N — several of which would be racing to replace each other. */
  #renewing = null;

  constructor({ appKey, redirectUri, fetch: f, openPopup } = {}) {
    if (!appKey) throw new Error('DropboxSession: an app key is required');
    this.#appKey = appKey;
    this.#redirectUri = redirectUri ?? redirectUriFor();
    this.#fetch = f ?? ((...a) => globalThis.fetch(...a));
    this.#openPopup = openPopup ?? runAuthPopup;
  }

  get signedIn() {
    return !!this.#access;
  }

  /** Send the user through consent and keep the resulting tokens. */
  async signIn() {
    const { verifier, challenge } = await makePkcePair();
    const state = newState();
    const url = authorizeUrl({
      authorizeUrl: DROPBOX_OAUTH.authorizeUrl,
      clientId: this.#appKey,
      redirectUri: this.#redirectUri,
      scope: DROPBOX_OAUTH.scope,
      challenge,
      state,
      extra: DROPBOX_OAUTH.extra,
    });
    const code = await this.#openPopup(url, state);
    const tok = await exchangeToken({
      tokenUrl: DROPBOX_OAUTH.tokenUrl,
      clientId: this.#appKey,
      redirectUri: this.#redirectUri,
      code,
      verifier,
      fetch: this.#fetch,
    });
    this.#apply(tok);
  }

  #apply(tok) {
    this.#access = tok.accessToken;
    // Dropbox does not reissue a refresh token on renewal, so keep the one we have.
    if (tok.refreshToken) this.#refresh = tok.refreshToken;
    this.#expiresAt = tok.expiresAt;
  }

  /**
   * A token good for the next request — the function the driver holds.
   *
   * Renews slightly before expiry rather than on failure: a token that dies mid-upload
   * costs a re-auth with unsaved work on screen, which is a far worse outcome than one
   * extra round trip.
   */
  async getToken() {
    if (this.#access && !needsRefresh(this.#expiresAt)) return this.#access;
    if (!this.#refresh) {
      if (this.#access) return this.#access; // no way to renew — let the 401 speak for itself
      throw new Error('Not signed in to Dropbox.');
    }
    this.#renewing = this.#renewing ?? exchangeToken({
      tokenUrl: DROPBOX_OAUTH.tokenUrl,
      clientId: this.#appKey,
      refreshToken: this.#refresh,
      fetch: this.#fetch,
    }).then((tok) => { this.#apply(tok); return tok.accessToken; })
      .finally(() => { this.#renewing = null; });
    return this.#renewing;
  }

  /** Forget the tokens. The app key and folder stay — they are not the secret part. */
  signOut() {
    this.#access = null;
    this.#refresh = null;
    this.#expiresAt = 0;
  }
}
