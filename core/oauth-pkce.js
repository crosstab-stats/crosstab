/**
 * @file oauth-pkce.js
 * OAuth 2.0 with PKCE, for a browser app that has no server and keeps no secret (#143).
 *
 * Shared by the cloud storage drivers (Graph, Drive, and anything else that wants it),
 * because the flow is identical everywhere and only the endpoints and scopes differ.
 *
 * ## Why PKCE, and why there is no client secret
 *
 * The authorization-code flow was designed for servers, which can keep a secret. A
 * browser cannot: anything shipped to the page is readable by whoever loads it. PKCE
 * (RFC 7636) replaces the secret with a per-attempt one — a random `code_verifier` kept
 * in memory, and the SHA-256 of it (`code_challenge`) sent up front. The provider hands
 * back a code that is only redeemable by whoever can produce the original verifier, so
 * intercepting the code achieves nothing.
 *
 * This is why a **client id is not a credential**. It identifies the application, not
 * the user, and every public client publishes it. Registering as a "web app" instead of
 * a "single-page app" is the classic mistake: it issues a client secret, and then there
 * is nowhere honest to put it.
 *
 * ## Bring your own client id
 *
 * The id is configuration, not code. CrossTab ships no registration of its own, so a
 * user or an institution registers once and pastes the id in — which keeps consent
 * screens naming the organisation that actually holds the data, leaves no central
 * registration for this project to administer or lose, and means a locked-down tenant
 * can point at its own approved app instead of asking IT to bless someone else's.
 *
 * ## Token custody
 *
 * The access token lives in memory only. A refresh token is offered to the caller and
 * NOT persisted here: whether a long-lived credential is written to disk is a policy
 * decision, and the same one the owner already made for WebDAV — type it again rather
 * than leave the keys lying about (see webdav-connections.js).
 */

/** Base64url — no padding, URL-safe alphabet, as the spec requires. */
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh PKCE pair.
 *
 * The verifier is 32 random bytes rendered base64url (43 chars — the spec's minimum, and
 * 256 bits of entropy). Generated per attempt and never reused: reuse would let a code
 * intercepted once be redeemed later.
 *
 * @param {Crypto} [crypto]
 * @returns {Promise<{verifier: string, challenge: string}>}
 */
export async function makePkcePair(crypto = globalThis.crypto) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/**
 * The URL to send the user to.
 *
 * `state` is carried through and must be compared on return — it is what stops a code
 * from someone else's login attempt being accepted as the answer to ours.
 *
 * @param {object} arg
 * @param {string} arg.authorizeUrl @param {string} arg.clientId @param {string} arg.redirectUri
 * @param {string} arg.scope @param {string} arg.challenge @param {string} arg.state
 * @param {Record<string,string>} [arg.extra]  provider-specific parameters
 */
export function authorizeUrl({ authorizeUrl: base, clientId, redirectUri, scope, challenge, state, extra = {} }) {
  const u = new URL(base);
  const p = u.searchParams;
  p.set('response_type', 'code');
  p.set('client_id', clientId);
  p.set('redirect_uri', redirectUri);
  p.set('scope', scope);
  p.set('code_challenge', challenge);
  p.set('code_challenge_method', 'S256');
  p.set('state', state);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return u.toString();
}

/** A random value for `state`. Same generator as the verifier, same reason. */
export const newState = (crypto = globalThis.crypto) => b64url(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Redeem an authorization code, or refresh an access token.
 *
 * Errors carry the provider's own `error` / `error_description`, because OAuth failures
 * are configuration failures nine times out of ten — a redirect URI that does not match
 * to the character, a scope not granted, a client registered as the wrong type — and the
 * provider's message names which one. Swallowing it in favour of "sign-in failed" turns
 * a five-minute fix into an afternoon.
 *
 * @returns {Promise<{accessToken: string, refreshToken: string|null, expiresAt: number, scope: string}>}
 */
export async function exchangeToken({ tokenUrl, clientId, redirectUri, code, verifier, refreshToken, fetch: f = globalThis.fetch }) {
  const body = new URLSearchParams({ client_id: clientId });
  if (refreshToken) {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refreshToken);
  } else {
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', redirectUri);
    body.set('code_verifier', verifier);
  }
  const res = await f(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  return {
    accessToken: json.access_token,
    // Absent when the provider was not asked for offline access, which is a legitimate
    // configuration rather than an error — the session simply ends when the token does.
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope ?? '',
  };
}

/**
 * Is this token close enough to expiry to renew?
 *
 * The skew matters: a token that passes this check and then expires mid-request turns a
 * save into a 401, and with no refresh token that means a re-login with unsaved work on
 * screen. Sixty seconds is cheap insurance against clock drift and a slow upload.
 */
export const needsRefresh = (expiresAt, skewMs = 60_000) => !expiresAt || Date.now() + skewMs >= expiresAt;

/**
 * Run the browser half: open the provider's page, wait for the callback to report back.
 *
 * A popup rather than a full-page redirect, because a redirect would tear down the app
 * and take unsaved work with it. `oauth-callback.html` is a static page on our own origin
 * whose only job is to post the code to its opener — the app itself never loads there.
 *
 * @returns {Promise<string>} the authorization code
 */
export function runAuthPopup(url, expectedState, { open = globalThis.open, listen = globalThis.addEventListener, unlisten = globalThis.removeEventListener, origin = globalThis.location?.origin } = {}) {
  return new Promise((resolve, reject) => {
    const win = open(url, 'crosstab-oauth', 'width=520,height=680');
    if (!win) { reject(new Error('The sign-in window was blocked. Allow popups for this site and try again.')); return; }
    let done = false;
    const finish = (err, code) => {
      if (done) return;
      done = true;
      unlisten('message', onMessage);
      clearInterval(closedTimer);
      try { win.close(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(code);
    };
    const onMessage = (ev) => {
      // Same-origin only: the callback page is ours, and a message from anywhere else is
      // either noise or an attempt to feed us someone else's code.
      if (ev.origin !== origin || ev.data?.type !== 'crosstab-oauth') return;
      if (ev.data.error) { finish(new Error(String(ev.data.error))); return; }
      if (ev.data.state !== expectedState) { finish(new Error('OAuth state mismatch — the sign-in reply did not match this request.')); return; }
      finish(null, String(ev.data.code));
    };
    listen('message', onMessage);
    // A user who closes the window is cancelling, and should not be left waiting on a
    // promise that never settles.
    const closedTimer = setInterval(() => {
      if (win.closed) finish(new Error('Sign-in was cancelled.'));
    }, 500);
  });
}
