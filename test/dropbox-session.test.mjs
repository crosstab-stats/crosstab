/**
 * @file dropbox-session.test.mjs
 * The OAuth session behind the Dropbox driver.
 *
 * The properties worth pinning are the ones that fail quietly: a refresh storm when
 * several requests hit an expired token at once, a refresh that forgets the refresh
 * token because Dropbox does not reissue one, and a config store that acquires a token
 * field it was never meant to hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropboxSession, loadConfig, saveConfig, redirectUriFor } from '../core/dropbox-session.js';

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => [...map.values()].join(''),
  };
}

/** A token endpoint that counts calls. */
function tokenServer(reply = {}) {
  let calls = 0;
  const bodies = [];
  return {
    get calls() { return calls; },
    bodies,
    fetch: async (url, init) => {
      calls += 1;
      bodies.push(new URLSearchParams(init.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: `AT${calls}`, expires_in: 3600, ...reply };
        },
      };
    },
  };
}

test('the config store holds the app key and folder, and nothing else', () => {
  // The app key is a client id and public by design; a token is not, and must never end
  // up here by an over-eager caller spreading an object.
  const st = fakeStorage();
  saveConfig({ appKey: 'faero', basePath: '/CrossTab/study', accessToken: 'AT-SECRET', refreshToken: 'RT-SECRET' }, st);
  const cfg = loadConfig(st);
  assert.deepEqual(cfg, { appKey: 'faero', basePath: '/CrossTab/study' });
  assert.ok(!st.dump().includes('SECRET'), 'no token reaches storage');
});

test('a corrupt or absent config is empty, not an exception', () => {
  assert.deepEqual(loadConfig(fakeStorage({ 'crosstab.dropbox.config': 'not json' })), {});
  assert.deepEqual(loadConfig(fakeStorage()), {});
  assert.deepEqual(loadConfig(undefined), {});
});

test('the redirect URI is the static callback beside the app, not the app', () => {
  // Booting the app inside the popup would start a second copy of everything to read two
  // query parameters.
  assert.equal(
    redirectUriFor({ origin: 'https://x.github.io', pathname: '/crosstab/index.html' }),
    'https://x.github.io/crosstab/oauth-callback.html',
  );
  assert.equal(
    redirectUriFor({ origin: 'https://x.github.io', pathname: '/crosstab/' }),
    'https://x.github.io/crosstab/oauth-callback.html',
  );
});

test('a session needs an app key', () => {
  assert.throws(() => new DropboxSession({}), /app key/);
});

test('sign-in exchanges the code and asks for offline access', async () => {
  const srv = tokenServer({ refresh_token: 'RT' });
  let authUrl = null;
  const s = new DropboxSession({
    appKey: 'faero', redirectUri: 'https://app/cb', fetch: srv.fetch,
    openPopup: async (url) => { authUrl = url; return 'CODE'; },
  });
  await s.signIn();
  assert.ok(s.signedIn);
  const u = new URL(authUrl);
  assert.equal(u.searchParams.get('client_id'), 'faero');
  assert.equal(u.searchParams.get('token_access_type'), 'offline', 'or there is no refresh token to renew with');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(srv.bodies[0].get('code'), 'CODE');
  assert.equal(await s.getToken(), 'AT1');
});

test('an unexpired token is reused rather than refreshed', async () => {
  const srv = tokenServer({ refresh_token: 'RT' });
  const s = new DropboxSession({ appKey: 'k', fetch: srv.fetch, redirectUri: 'https://app/cb', openPopup: async () => 'C' });
  await s.signIn();
  await s.getToken();
  await s.getToken();
  assert.equal(srv.calls, 1, 'one exchange at sign-in, no renewals');
});

test('an expiring token is renewed before it bites', async () => {
  // Renewed slightly early on purpose: a token that dies mid-upload costs a re-auth with
  // unsaved work on screen.
  const srv = tokenServer({ refresh_token: 'RT', expires_in: 30 });
  const s = new DropboxSession({ appKey: 'k', fetch: srv.fetch, redirectUri: 'https://app/cb', openPopup: async () => 'C' });
  await s.signIn();
  assert.equal(await s.getToken(), 'AT2', 'inside the skew, so renewed on first use');
  assert.equal(srv.bodies[1].get('grant_type'), 'refresh_token');
});

test('concurrent callers cause ONE refresh, not one each', async () => {
  // Every driver request calls getToken(). A save touching a dozen files at an expiry
  // boundary would otherwise fire a dozen renewals, racing to replace each other.
  const srv = tokenServer({ refresh_token: 'RT', expires_in: 10 });
  const s = new DropboxSession({ appKey: 'k', fetch: srv.fetch, redirectUri: 'https://app/cb', openPopup: async () => 'C' });
  await s.signIn();
  const all = await Promise.all([s.getToken(), s.getToken(), s.getToken(), s.getToken()]);
  assert.equal(srv.calls, 2, 'sign-in, then a single shared renewal');
  assert.deepEqual(new Set(all).size, 1, 'and everyone gets the same token');
});

test('the refresh token survives a renewal that does not reissue one', async () => {
  // Dropbox returns only an access token on refresh. Overwriting the stored refresh
  // token with that absence would make the session unrenewable after exactly one hour.
  const srv = tokenServer({ refresh_token: 'RT', expires_in: 10 });
  const s = new DropboxSession({ appKey: 'k', fetch: srv.fetch, redirectUri: 'https://app/cb', openPopup: async () => 'C' });
  await s.signIn();
  await s.getToken(); // renew once
  await s.getToken(); // and again — only possible if RT was kept
  assert.equal(srv.calls, 3);
  assert.equal(srv.bodies[2].get('refresh_token'), 'RT');
});

test('with no refresh token the existing one is used until it fails', async () => {
  // A provider or configuration that grants no offline access is not an error; the
  // session simply ends when the token does, and the 401 says so at that point.
  const srv = tokenServer({ expires_in: 10 }); // no refresh_token
  const s = new DropboxSession({ appKey: 'k', fetch: srv.fetch, redirectUri: 'https://app/cb', openPopup: async () => 'C' });
  await s.signIn();
  assert.equal(await s.getToken(), 'AT1');
  assert.equal(srv.calls, 1, 'nothing to renew with, so nothing is attempted');
});

test('asking for a token before signing in is an error, not a silent empty string', async () => {
  const s = new DropboxSession({ appKey: 'k', fetch: async () => ({}), redirectUri: 'https://app/cb' });
  await assert.rejects(() => s.getToken(), /Not signed in/);
});

test('signing out forgets the tokens', async () => {
  const srv = tokenServer({ refresh_token: 'RT' });
  const s = new DropboxSession({ appKey: 'k', fetch: srv.fetch, redirectUri: 'https://app/cb', openPopup: async () => 'C' });
  await s.signIn();
  s.signOut();
  assert.equal(s.signedIn, false);
  await assert.rejects(() => s.getToken(), /Not signed in/);
});
