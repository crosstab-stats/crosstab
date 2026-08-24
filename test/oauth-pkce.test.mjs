/**
 * @file oauth-pkce.test.mjs
 * OAuth with PKCE for a client that has no secret to keep (#143).
 *
 * The properties worth pinning are the ones whose failure is silent: a challenge that
 * does not actually derive from its verifier, a `state` check that accepts anything, and
 * a token error swallowed into "sign-in failed" when the provider said exactly what was
 * misconfigured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makePkcePair, authorizeUrl, newState, exchangeToken, needsRefresh, runAuthPopup } from '../core/oauth-pkce.js';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('the challenge is genuinely SHA-256 of the verifier', async () => {
  // If this drifts the flow still "works" right up to the token exchange, which then
  // fails with a message about an invalid grant that names nothing useful.
  const { verifier, challenge } = await makePkcePair();
  assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()));
});

test('a verifier is 43+ chars, URL-safe, and never repeats', async () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const { verifier } = await makePkcePair();
    assert.ok(verifier.length >= 43, 'RFC 7636 minimum');
    assert.match(verifier, /^[A-Za-z0-9\-_]+$/, 'no padding, no + or /');
    assert.ok(!seen.has(verifier), 'reuse would let an intercepted code be redeemed later');
    seen.add(verifier);
  }
});

test('the authorize URL carries everything the provider requires', () => {
  const url = new URL(authorizeUrl({
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    clientId: 'abc-123',
    redirectUri: 'https://app.example/oauth-callback.html',
    scope: 'Files.ReadWrite offline_access',
    challenge: 'CH',
    state: 'ST',
    extra: { prompt: 'select_account' },
  }));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'CH');
  assert.equal(url.searchParams.get('state'), 'ST');
  assert.equal(url.searchParams.get('scope'), 'Files.ReadWrite offline_access');
  assert.equal(url.searchParams.get('prompt'), 'select_account', 'provider-specific extras pass through');
  assert.equal(url.searchParams.get('client_secret'), null, 'a public client has none to send');
});

test('states are unique per attempt', () => {
  const a = new Set(Array.from({ length: 20 }, () => newState()));
  assert.equal(a.size, 20);
});

test('the code exchange sends the verifier and no secret', async () => {
  let sent = null;
  const fetch = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) };
    return { ok: true, status: 200, async json() { return { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 's' }; } };
  };
  const tok = await exchangeToken({
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId: 'abc-123', redirectUri: 'https://app.example/cb', code: 'CODE', verifier: 'VER', fetch,
  });
  assert.equal(sent.body.get('grant_type'), 'authorization_code');
  assert.equal(sent.body.get('code_verifier'), 'VER');
  assert.equal(sent.body.get('client_secret'), null);
  assert.equal(tok.accessToken, 'AT');
  assert.equal(tok.refreshToken, 'RT');
  assert.ok(tok.expiresAt > Date.now());
});

test('a refresh sends the refresh token and no code', async () => {
  let sent = null;
  const fetch = async (url, init) => {
    sent = new URLSearchParams(init.body);
    return { ok: true, status: 200, async json() { return { access_token: 'AT2', expires_in: 3600 }; } };
  };
  const tok = await exchangeToken({ tokenUrl: 'https://t', clientId: 'c', refreshToken: 'RT', fetch });
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('code'), null);
  assert.equal(tok.accessToken, 'AT2');
  assert.equal(tok.refreshToken, null, 'a provider that does not rotate one gives none back');
});

test("the provider's own error text survives", async () => {
  // OAuth failures are configuration failures nine times in ten, and the provider names
  // which one. "Sign-in failed" turns a five-minute fix into an afternoon.
  const fetch = async () => ({
    ok: false, status: 400,
    async json() { return { error: 'invalid_grant', error_description: 'AADSTS50011: redirect URI does not match' }; },
  });
  await assert.rejects(
    () => exchangeToken({ tokenUrl: 'https://t', clientId: 'c', code: 'x', verifier: 'v', fetch }),
    /AADSTS50011: redirect URI does not match/,
  );
});

test('a non-JSON error response still produces a usable message', async () => {
  const fetch = async () => ({ ok: false, status: 502, async json() { throw new Error('not json'); } });
  await assert.rejects(() => exchangeToken({ tokenUrl: 'https://t', clientId: 'c', fetch }), /HTTP 502/);
});

test('refresh is due early, not late', () => {
  assert.equal(needsRefresh(Date.now() + 300_000), false);
  assert.equal(needsRefresh(Date.now() + 30_000), true, 'inside the skew — renew before it bites mid-save');
  assert.equal(needsRefresh(0), true);
  assert.equal(needsRefresh(null), true);
});

// --- the popup handshake -----------------------------------------------------

/** A fake window/message environment. */
function popupEnv({ opened = true } = {}) {
  const handlers = new Set();
  const win = { closed: false, close() { this.closed = true; } };
  return {
    win,
    opts: {
      open: () => (opened ? win : null),
      listen: (t, h) => handlers.add(h),
      unlisten: (t, h) => handlers.delete(h),
      origin: 'https://app.example',
    },
    send: (data, origin = 'https://app.example') => handlers.forEach((h) => h({ origin, data })),
  };
}

test('a matching reply resolves with the code and closes the popup', async () => {
  const env = popupEnv();
  const p = runAuthPopup('https://provider/auth', 'ST', env.opts);
  env.send({ type: 'crosstab-oauth', code: 'CODE', state: 'ST' });
  assert.equal(await p, 'CODE');
  assert.equal(env.win.closed, true);
});

test('a reply from another origin is ignored', async () => {
  // The callback page is ours; a message from anywhere else is noise at best.
  const env = popupEnv();
  const p = runAuthPopup('https://provider/auth', 'ST', env.opts);
  env.send({ type: 'crosstab-oauth', code: 'EVIL', state: 'ST' }, 'https://attacker.example');
  env.send({ type: 'crosstab-oauth', code: 'GOOD', state: 'ST' });
  assert.equal(await p, 'GOOD');
});

test('a mismatched state is rejected, not accepted', async () => {
  // This is the check that stops someone else's login being accepted as the answer to
  // ours — the whole reason `state` exists.
  const env = popupEnv();
  const p = runAuthPopup('https://provider/auth', 'ST', env.opts);
  env.send({ type: 'crosstab-oauth', code: 'CODE', state: 'OTHER' });
  await assert.rejects(() => p, /state mismatch/);
});

test('a provider error comes back as an error', async () => {
  const env = popupEnv();
  const p = runAuthPopup('https://provider/auth', 'ST', env.opts);
  env.send({ type: 'crosstab-oauth', error: 'access_denied' });
  await assert.rejects(() => p, /access_denied/);
});

test('a blocked popup says so instead of hanging', async () => {
  const env = popupEnv({ opened: false });
  await assert.rejects(() => runAuthPopup('https://provider/auth', 'ST', env.opts), /blocked/i);
});
