/**
 * @file storage-webdav.test.mjs
 * The first non-handle storage driver, driven against a fake server.
 *
 * `fetch` is injected, so every path through the driver is exercised without a network
 * or a WebDAV instance — including the ones a real server makes hard to provoke on
 * demand, like a MOVE failing after its PUT succeeded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebDavDriver, parsePropfind, ancestorsOf } from '../core/storage-webdav.js';
import { capabilitiesOf } from '../core/storage-driver.js';

const BASE = 'https://cloud.example.org/remote.php/dav/files/jane/study';

/** A fake server that records calls and replies from a routing table. */
function fakeServer(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, headers: init.headers || {}, body: init.body });
    const key = `${method} ${new URL(url).pathname}`;
    const r = routes[key] ?? routes[method] ?? { status: 404 };
    const reply = typeof r === 'function' ? r() : r;
    return {
      status: reply.status ?? 200,
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      headers: new Map(Object.entries(reply.headers ?? {})),
      async arrayBuffer() { return (reply.bytes ?? new Uint8Array()).buffer; },
      async text() { return reply.text ?? ''; },
      async blob() { return reply.blob ?? null; },
    };
  };
  return { fetch, calls };
}

const driver = (routes) => {
  const srv = fakeServer(routes);
  return { srv, d: new WebDavDriver({ baseUrl: BASE, username: 'jane', password: 'app-pw', fetch: srv.fetch }) };
};

// --- pure helpers ------------------------------------------------------------

test('PROPFIND parsing handles absolute hrefs, relative hrefs and the self entry', () => {
  // Servers differ on all three, and getting the self entry wrong means a project
  // directory that appears to contain itself.
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/remote.php/dav/files/jane/study/</d:href></d:response>
    <d:response><d:href>/remote.php/dav/files/jane/study/project.json</d:href></d:response>
    <d:response><d:href>https://cloud.example.org/remote.php/dav/files/jane/study/ds1_src0.parquet</d:href></d:response>
    <d:response><d:href>/remote.php/dav/files/jane/study/assets/</d:href></d:response>
  </d:multistatus>`;
  assert.deepEqual(
    parsePropfind(xml, 'remote.php/dav/files/jane/study'),
    ['project.json', 'ds1_src0.parquet', 'assets'],
  );
});

test('PROPFIND parsing decodes escaped names and ignores anything outside the collection', () => {
  const xml = `<d:multistatus xmlns:d="DAV:">
    <d:href>/dav/study/my%20project%20notes.json</d:href>
    <d:href>/dav/elsewhere/secret.json</d:href>
  </d:multistatus>`;
  assert.deepEqual(parsePropfind(xml, 'dav/study'), ['my project notes.json']);
});

test('PROPFIND parsing tolerates any namespace prefix, and none', () => {
  const xml = '<multistatus><response><href>/dav/study/a.json</href></response></multistatus>';
  assert.deepEqual(parsePropfind(xml, 'dav/study'), ['a.json']);
  assert.deepEqual(parsePropfind('', 'dav/study'), []);
  assert.deepEqual(parsePropfind(null, 'dav/study'), []);
});

test('ancestorsOf lists collections outermost first, and never the leaf', () => {
  // MKCOL cannot create a tree in one call, and creating them inner-first fails.
  assert.deepEqual(ancestorsOf('assets/big/movie.bin'), ['assets', 'assets/big']);
  assert.deepEqual(ancestorsOf('project.json'), [], 'a root-level file needs no collection');
});

// --- the driver --------------------------------------------------------------

test('a missing file reads as null, not as an error', () => {
  // The seam's contract: null means missing, and callers decide whether that is a
  // problem. A handle driver gets this from a caught exception; here it is a status.
  const { d } = driver({ GET: { status: 404 } });
  return d.read('project.json').then((r) => assert.equal(r, null));
});

test('read returns bytes and sends the auth header', async () => {
  const { srv, d } = driver({ GET: { status: 200, bytes: new Uint8Array([1, 2, 3]) } });
  const bytes = await d.read('project.json');
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(srv.calls[0].headers.Authorization, `Basic ${btoa('jane:app-pw')}`);
  assert.equal(srv.calls[0].url, `${BASE}/project.json`);
});

test('write creates parents, PUTs a temp file, then MOVEs it into place', async () => {
  // The atomicity bargain: a peer polling the real path never sees a partial file.
  const { srv, d } = driver({ MKCOL: { status: 201 }, PUT: { status: 201 }, MOVE: { status: 204 } });
  await d.write('assets/blob.bin', new Uint8Array([9]));
  assert.deepEqual(srv.calls.map((c) => c.method), ['MKCOL', 'PUT', 'MOVE']);
  assert.match(srv.calls[1].url, /assets\/blob\.bin\.tmp$/);
  assert.equal(srv.calls[2].headers.Destination, `${BASE}/assets/blob.bin`);
  assert.equal(srv.calls[2].headers.Overwrite, 'T');
});

test('an existing collection answers MKCOL with 405, which is not a failure', async () => {
  const { d } = driver({ MKCOL: { status: 405 }, PUT: { status: 204 }, MOVE: { status: 204 } });
  await d.write('assets/x.bin', new Uint8Array([1]));
});

test('parent creation is cached, so a second write does not re-walk the tree', async () => {
  const { srv, d } = driver({ MKCOL: { status: 201 }, PUT: { status: 201 }, MOVE: { status: 204 } });
  await d.write('assets/a.bin', new Uint8Array([1]));
  await d.write('assets/b.bin', new Uint8Array([2]));
  assert.equal(srv.calls.filter((c) => c.method === 'MKCOL').length, 1);
});

test('a failed MOVE cleans up its temp file before throwing', async () => {
  // The folder IS the project, so an orphan `.tmp` is not litter — a co-author's sync
  // client replicates it to everyone.
  const { srv, d } = driver({ MKCOL: { status: 405 }, PUT: { status: 201 }, MOVE: { status: 507 }, DELETE: { status: 204 } });
  await assert.rejects(() => d.write('assets/x.bin', new Uint8Array([1])), /MOVE/);
  const del = srv.calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'the temp file is deleted');
  assert.match(del.url, /\.tmp$/);
});

test('deleting something already gone is not an error; a real failure is', async () => {
  const { d } = driver({ DELETE: { status: 404 } });
  await d.remove('gone.json'); // resolves
  const { d: d2 } = driver({ DELETE: { status: 403 } });
  await assert.rejects(() => d2.remove('locked.json'), /HTTP 403/);
});

test('list PROPFINDs at Depth 1 and returns child names', async () => {
  const xml = '<multistatus><href>/remote.php/dav/files/jane/study/assets/a.bin</href></multistatus>';
  const { srv, d } = driver({ PROPFIND: { status: 207, text: xml } });
  assert.deepEqual(await d.list('assets'), ['a.bin']);
  assert.equal(srv.calls[0].headers.Depth, '1');
});

test('listing a missing collection is empty, matching the handle drivers', async () => {
  const { d } = driver({ PROPFIND: { status: 404 } });
  assert.deepEqual(await d.list('nope'), []);
});

test('stat reads size and mtime from the headers, and is null when absent', async () => {
  const { d } = driver({ HEAD: { status: 200, headers: { 'content-length': '42', 'last-modified': 'Wed, 20 Aug 2026 10:00:00 GMT' } } });
  const st = await d.stat('project.json');
  assert.equal(st.size, 42);
  assert.equal(st.mtime, Date.parse('Wed, 20 Aug 2026 10:00:00 GMT'));
  const { d: d2 } = driver({ HEAD: { status: 404 } });
  assert.equal(await d2.stat('project.json'), null);
});

test('paths are escaped per segment, so separators survive and spaces do not', async () => {
  const { srv, d } = driver({ GET: { status: 404 } });
  await d.read('my folder/a file.json');
  assert.equal(srv.calls[0].url, `${BASE}/my%20folder/a%20file.json`);
});

test('it declares itself flat and atomic without claiming to be a folder', () => {
  // The capability fix: a driver states what it does. Before that, being handled
  // correctly meant reporting `kind: 'folder'`.
  const { d } = driver({});
  const caps = capabilitiesOf(d);
  assert.equal(d.kind, 'webdav');
  assert.equal(caps.flat, true);
  assert.equal(caps.externallySynced, true);
  assert.equal(caps.atomicWrite, true, 'MOVE gives the same guarantee as rename');
  assert.equal(caps.canStream, true);
});

test('a bearer token is accepted instead of a password', async () => {
  const srv = fakeServer({ GET: { status: 404 } });
  const d = new WebDavDriver({ baseUrl: BASE, token: 'abc123', fetch: srv.fetch });
  await d.read('x.json');
  assert.equal(srv.calls[0].headers.Authorization, 'Bearer abc123');
});

test('a driver with no baseUrl is refused at construction', () => {
  // Failing here beats failing on the first save, when there is data to lose.
  assert.throws(() => new WebDavDriver({}), /baseUrl/);
});
