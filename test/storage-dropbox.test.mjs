/**
 * @file storage-dropbox.test.mjs
 * The first OAuth-backed storage driver, against a fake Dropbox.
 *
 * Two things here have no equivalent in the WebDAV driver and are where the bugs would
 * be: the `Dropbox-API-Arg` header must be pure ASCII or the browser silently refuses to
 * send it, and `list_folder` pages — a truncated listing reads as missing files rather
 * than as an error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropboxDriver, asciiJson, dbxPath, isNotFound, DROPBOX_OAUTH, isAuthError } from '../core/storage-dropbox.js';
import { capabilitiesOf } from '../core/storage-driver.js';

/** A fake Dropbox: routes keyed by endpoint path, calls recorded. */
function fakeDbx(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url, path: u.pathname, headers: init.headers || {}, body: init.body });
    const r = routes[u.pathname] ?? { status: 409, json: { error_summary: 'path/not_found/', error: { '.tag': 'path', path: { '.tag': 'not_found' } } } };
    const reply = typeof r === 'function' ? r(calls.length) : r;
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { if (reply.json === undefined) throw new Error('not json'); return reply.json; },
      async arrayBuffer() { return (reply.bytes ?? new Uint8Array()).buffer; },
      async blob() { return reply.blob ?? 'BLOB'; },
    };
  };
  return { fetch, calls };
}

const mk = (routes, basePath = '/CrossTab/study') => {
  const srv = fakeDbx(routes);
  return { srv, d: new DropboxDriver({ getToken: async () => 'TOKEN', basePath, fetch: srv.fetch }) };
};

// --- pure helpers ------------------------------------------------------------

test('the API-arg header is pure ASCII, and still round-trips', () => {
  // A non-ASCII header value is rejected by the browser before the request leaves, and
  // it surfaces as a generic network error naming nothing.
  const json = asciiJson({ path: '/Études/naïve.json' });
  assert.ok(/^[\x00-\x7f]*$/.test(json), 'nothing above U+007F survives');
  assert.equal(JSON.parse(json).path, '/Études/naïve.json', 'and the server still reads the real path');
});

test('paths are absolute, deduped of empty segments, and the root is empty', () => {
  // Dropbox rejects a bare name, and wants "" rather than "/" for the root.
  assert.equal(dbxPath('/CrossTab/study', 'project.json'), '/CrossTab/study/project.json');
  assert.equal(dbxPath('/CrossTab/study/', '/assets/a.bin'), '/CrossTab/study/assets/a.bin');
  assert.equal(dbxPath('', ''), '');
  assert.equal(dbxPath('', 'project.json'), '/project.json');
});

test('not-found is told apart from a real conflict', () => {
  assert.equal(isNotFound({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }), true);
  assert.equal(isNotFound({ error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } } }), true);
  assert.equal(isNotFound({ error: { '.tag': 'path', path: { '.tag': 'conflict' } } }), false,
    'a genuine conflict must not be swallowed as "missing"');
  assert.equal(isNotFound({}), false);
});

// --- the driver --------------------------------------------------------------

test('read returns bytes and sends a bearer token', async () => {
  const { srv, d } = mk({ '/2/files/download': { status: 200, bytes: new Uint8Array([7, 8]) } });
  assert.deepEqual([...await d.read('project.json')], [7, 8]);
  assert.equal(srv.calls[0].headers.Authorization, 'Bearer TOKEN');
  assert.equal(JSON.parse(srv.calls[0].headers['Dropbox-API-Arg']).path, '/CrossTab/study/project.json');
});

test('a missing file reads as null', async () => {
  const { d } = mk({}); // default route is path/not_found
  assert.equal(await d.read('nope.json'), null);
});

test('a 401 is flagged re-promptable rather than reported as missing', async () => {
  // Same trap as WebDAV: if an expired token took the not-found path, a project would
  // open EMPTY and then autosave over the real thing.
  const { d } = mk({ '/2/files/download': { status: 401 } });
  await assert.rejects(() => d.read('project.json'), (e) => isAuthError(e) && e.status === 401);
});

test('write overwrites in one shot, with no rename dance', async () => {
  // Dropbox commits the whole file or none of it, so the WebDAV temp-then-MOVE is
  // unnecessary here — and doing it anyway would double every save.
  const { srv, d } = mk({ '/2/files/upload': { status: 200, json: {} } });
  await d.write('project.json', new Uint8Array([1]));
  assert.equal(srv.calls.length, 1);
  const arg = JSON.parse(srv.calls[0].headers['Dropbox-API-Arg']);
  assert.equal(arg.mode, 'overwrite');
  assert.equal(arg.autorename, false, 'a renamed save is a lost save');
});

test('a small blob goes up whole rather than through a session', async () => {
  const { srv, d } = mk({ '/2/files/upload': { status: 200, json: {} } });
  await d.writeStream('a.bin', { size: 1024, slice: () => 'CHUNK' });
  assert.deepEqual(srv.calls.map((c) => c.path), ['/2/files/upload']);
});

test('a large blob goes start → append → finish, and lands only at finish', async () => {
  // The file does not exist at the destination until finish, which is the same
  // guarantee overwrite gives a small one: no peer ever sees half a movie.
  const routes = {
    '/2/files/upload_session/start': { status: 200, json: { session_id: 'S1' } },
    '/2/files/upload_session/append_v2': { status: 200, json: {} },
    '/2/files/upload_session/finish': { status: 200, json: {} },
  };
  const size = 20 * 1024 * 1024 + 5; // > CHUNK, < single-shot limit is irrelevant here
  const big = { size: 300 * 1024 * 1024, slice: (a, b) => ({ from: a, to: b }) };
  const { srv, d } = mk(routes);
  await d.writeStream('assets/movie.bin', big);
  const seq = srv.calls.map((c) => c.path.replace('/2/files/upload_session/', ''));
  assert.equal(seq[0], 'start');
  assert.equal(seq[seq.length - 1], 'finish');
  assert.ok(seq.filter((s) => s === 'append_v2').length > 1, 'more than one chunk for 300 MB');
  const commit = JSON.parse(srv.calls[srv.calls.length - 1].headers['Dropbox-API-Arg']).commit;
  assert.equal(commit.path, '/CrossTab/study/assets/movie.bin');
  assert.ok(size > 0);
});

test('list pages until the cursor is exhausted', async () => {
  // A project with many sources or assets exceeds one page, and a silently truncated
  // listing looks exactly like missing files.
  let n = 0;
  const { d } = mk({
    '/2/files/list_folder': { status: 200, json: { entries: [{ name: 'a' }], has_more: true, cursor: 'C1' } },
    '/2/files/list_folder/continue': () => {
      n += 1;
      return { status: 200, json: { entries: [{ name: `p${n}` }], has_more: n < 2, cursor: 'C2' } };
    },
  });
  assert.deepEqual(await d.list(''), ['a', 'p1', 'p2']);
});

test('listing a missing folder is empty, matching the other drivers', async () => {
  const { d } = mk({});
  assert.deepEqual(await d.list('assets'), []);
});

test('stat maps Dropbox metadata onto the seam shape', async () => {
  const { d } = mk({ '/2/files/get_metadata': { status: 200, json: { size: 99, server_modified: '2026-08-24T10:00:00Z' } } });
  assert.deepEqual(await d.stat('project.json'), { size: 99, mtime: Date.parse('2026-08-24T10:00:00Z') });
  const { d: d2 } = mk({});
  assert.equal(await d2.stat('project.json'), null);
});

test('deleting something already gone is success', async () => {
  const { d } = mk({}); // not_found
  await d.remove('gone.json');
});

test('it declares itself flat and atomic', () => {
  const { d } = mk({});
  const caps = capabilitiesOf(d);
  assert.equal(d.kind, 'dropbox');
  assert.equal(caps.flat, true);
  assert.equal(caps.atomicWrite, true);
  assert.equal(caps.canStream, true);
});

test('a token is fetched per request, so a refresh mid-session is picked up', async () => {
  // The driver holds no token. Renewal belongs to whoever owns the OAuth session, and
  // this is what lets it happen without the driver knowing.
  let issued = 0;
  const srv = fakeDbx({ '/2/files/upload': { status: 200, json: {} } });
  const d = new DropboxDriver({ getToken: async () => `T${++issued}`, basePath: '/x', fetch: srv.fetch });
  await d.write('a.json', new Uint8Array([1]));
  await d.write('b.json', new Uint8Array([1]));
  assert.equal(srv.calls[0].headers.Authorization, 'Bearer T1');
  assert.equal(srv.calls[1].headers.Authorization, 'Bearer T2');
});

test('a driver with no token source is refused at construction', () => {
  assert.throws(() => new DropboxDriver({ basePath: '/x' }), /getToken/);
});

test('the OAuth config asks for offline access', () => {
  // Without it Dropbox issues a short-lived token and NO refresh token, so the session
  // dies after a few hours with nothing to renew from.
  assert.equal(DROPBOX_OAUTH.extra.token_access_type, 'offline');
  assert.match(DROPBOX_OAUTH.scope, /files\.content\.write/);
  assert.match(DROPBOX_OAUTH.authorizeUrl, /^https:\/\/www\.dropbox\.com/);
});
