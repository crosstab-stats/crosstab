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

const KEY = 'crosstab.dropbox.config';

/** Fields worth remembering between sessions. Tokens are conspicuously not among them. */
const PUBLIC_FIELDS = Object.freeze(['appKey', 'basePath']);

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
