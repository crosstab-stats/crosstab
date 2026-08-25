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
 * than leave the keys lying about (see project-locations.js).
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

/** Where the callback page leaves its answer, for the opener to collect. */
export const OAUTH_RESULT_KEY = 'crosstab.oauth.result';
export const OAUTH_CHANNEL = 'crosstab-oauth';

/**
 * Run the browser half: open the provider's page, wait for the code to come back.
 *
 * ## Why this does not use `window.opener`
 *
 * The obvious design — popup posts to `window.opener` — cannot work in this app.
 * CrossTab serves `Cross-Origin-Opener-Policy: same-origin` because WebR and DuckDB need
 * cross-origin isolation, and COOP severs the opener relationship as soon as the popup
 * navigates to the provider. When it returns to our origin it is in a different browsing
 * context group: `window.opener` is null, and the handle we kept reports `closed === true`
 * even while the window is plainly on screen.
 *
 * That produced both halves of a confusing failure — the popup announcing it had nothing
 * to do, and the app reporting a cancellation the user never made.
 *
 * So the answer comes back over channels that are scoped to the ORIGIN rather than to the
 * window relationship, and the callback page writes to all of them:
 *
 *  - `BroadcastChannel` — the direct route where it exists.
 *  - `localStorage` + the `storage` event — the fallback, with polling behind it, because
 *    the event does not fire in every browser for every context pairing.
 *  - `postMessage` to the opener — kept because it costs three lines and is the fast path
 *    when COOP is not in play, such as under a dev server without the isolation headers.
 *
 * ## Why cancellation is not detected
 *
 * `win.closed` looks like the obvious signal and is unusable here. Under COOP a severed
 * handle reports `closed === true` while the window is plainly open, and the severance
 * happens when the popup NAVIGATES — not when it is created — so sampling once at open
 * reads `false` and every sample after it reads `true`. There is no moment at which the
 * two cases can be told apart.
 *
 * Since they cannot be distinguished, the question is which mistake to make. Treating a
 * severed handle as a cancellation breaks every sign-in, reporting a cancellation the user
 * never made *after they have already granted access* — the bug this replaces, twice.
 * Ignoring a real cancellation costs a wait. So the wait is what we take: the promise
 * settles when the code arrives, or on a timeout that says what to do.
 *
 * The code sits in `localStorage` for the instant between the callback writing it and the
 * opener reading it. That is same-origin only, single-use, and bound to a PKCE verifier
 * this page never saw — and it is deleted on read.
 *
 * @returns {Promise<string>} the authorization code
 */
export function runAuthPopup(url, expectedState, {
  open = globalThis.open,
  listen = globalThis.addEventListener,
  unlisten = globalThis.removeEventListener,
  origin = globalThis.location?.origin,
  storage = globalThis.localStorage,
  makeChannel = () => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(OAUTH_CHANNEL) : null),
  pollMs = 400,
  timeoutMs = 3 * 60_000,
} = {}) {
  return new Promise((resolve, reject) => {
    // A previous attempt's answer would otherwise be collected instantly as this one's.
    try { storage?.removeItem(OAUTH_RESULT_KEY); } catch { /* private mode */ }

    const win = open(url, 'crosstab-oauth', 'width=520,height=680');
    if (!win) { reject(new Error('The sign-in window was blocked. Allow popups for this site and try again.')); return; }

    const channel = makeChannel();
    let done = false;
    const finish = (err, code) => {
      if (done) return;
      done = true;
      unlisten('message', onMessage);
      unlisten('storage', onStorage);
      try { channel?.close(); } catch { /* already closed */ }
      clearInterval(timer);
      try { storage?.removeItem(OAUTH_RESULT_KEY); } catch { /* nothing to clean */ }
      try { win.close(); } catch { /* severed, or already gone — it closes itself */ }
      if (err) reject(err); else resolve(code);
    };

    /** One delivery, from whichever channel got here first. */
    const accept = (data) => {
      if (!data || data.type !== 'crosstab-oauth') return;
      if (data.error) { finish(new Error(String(data.error))); return; }
      // The state check is what stops a code from someone else's attempt being accepted
      // as the answer to ours, and it matters more here: a localStorage entry is not
      // addressed to anyone in particular.
      if (data.state !== expectedState) { finish(new Error('OAuth state mismatch — the sign-in reply did not match this request.')); return; }
      finish(null, String(data.code));
    };

    const onMessage = (ev) => { if (ev.origin === origin) accept(ev.data); };
    const onStorage = (ev) => { if (ev.key === OAUTH_RESULT_KEY && ev.newValue) accept(safeParse(ev.newValue)); };
    listen('message', onMessage);
    listen('storage', onStorage);
    if (channel) channel.onmessage = (ev) => accept(ev.data);

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const raw = (() => { try { return storage?.getItem(OAUTH_RESULT_KEY); } catch { return null; } })();
      if (raw) { accept(safeParse(raw)); return; }
      if (Date.now() - startedAt > timeoutMs) {
        finish(new Error('Sign-in did not complete. Close the sign-in window and try again.'));
      }
    }, pollMs);
  });
}

/** Parse without letting a half-written entry throw inside a poll tick. */
function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}
