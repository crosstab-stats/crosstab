/**
 * @file shell-manifest.test.mjs
 * The page tells the worker what a real launch needed; the worker caches what it missed.
 *
 * ## The gap this closes
 *
 * The app shell caches as it is served (#92), which quietly misses the one slice that
 * matters most. On a **first visit** the document is fetched before any worker controls
 * the page, and the modules `core/app.js` imports *directly* start loading in that same
 * window — so they go straight to the network, the worker never sees them, and they are
 * the only part of the boot graph not in the cache. Measured on a cold profile during the
 * 2026-11-10 investigation: **36** of `core/` cached after one launch, **128** after
 * three.
 *
 * They do arrive on the second launch, so this only ever bit install-then-immediately-
 * offline. That is the exact sequence an installed app is for.
 *
 * ## Why it is built this way
 *
 * The alternative was listing the boot graph by hand in `SHELL_PRECACHE`. A hand-written
 * import graph rots silently the first time an import changes, and a shell list that is
 * quietly incomplete is worse than none because it looks finished. `performance` has the
 * browser's own record of what loaded — including the files fetched before this worker
 * existed, which a worker can never reconstruct. So the page announces and the worker
 * persists, the same division of labour `set-runtime-hosts` already uses.
 *
 * The top-up runs after the launcher is up and the page is idle, never during boot and
 * never on `install`: adding requests to a cold launch is half of what made the
 * 2026-11-10 hang a hang, and precaching this list on install would recreate it at
 * thirteen times the size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectShellUrls } from '../core/offline.js';

const SRC = readFileSync('sw.js', 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function seam(name) {
  const block = SRC.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`));
  assert.ok(block, `the ${name}:start/end seam is gone from sw.js`);
  return block[0];
}

/** An entry as `performance.getEntriesByType('resource')` reports it. */
const res = (name, bytes = 1000) => ({ name, encodedBodySize: bytes, transferSize: bytes });

// =============================================================================
// The page side: what a launch reports
// =============================================================================

const ORIGIN = 'https://example.test';

test('the modules a launch loaded are what gets announced', () => {
  const urls = collectShellUrls(
    { getEntriesByType: () => [res(`${ORIGIN}/core/app.js`), res(`${ORIGIN}/core/event-bus.js`)] },
    ORIGIN,
  );
  assert.deepEqual(urls, [`${ORIGIN}/core/app.js`, `${ORIGIN}/core/event-bus.js`]);
});

test('another origin is never announced, whatever it is', () => {
  // The worker re-checks this too, but a page that hands over a CDN URL has already got
  // the rule wrong, and the R-package CDN is the one thing that must not be dragged into
  // the shell tier.
  const urls = collectShellUrls(
    { getEntriesByType: () => [
      res('https://repo.r-wasm.org/bin/lavaan.tgz'),
      res('https://cdn.jsdelivr.net/npm/thing.js'),
      res(`${ORIGIN}/core/app.js`),
    ] },
    ORIGIN,
  );
  assert.deepEqual(urls, [`${ORIGIN}/core/app.js`]);
});

test("a user's data is not quietly copied into a durable cache", () => {
  // `performance` records every byte the page pulled, which includes an imported .csv and
  // whatever a plugin fetched through app.web. Those are the user's content, not the app:
  // caching them is a privacy surprise and a way to fill a disk. Hence an allow-list.
  const urls = collectShellUrls(
    { getEntriesByType: () => [
      res(`${ORIGIN}/uploads/patients.csv`),
      res(`${ORIGIN}/data/responses.sav`),
      res(`${ORIGIN}/core/app.js`),
    ] },
    ORIGIN,
  );
  assert.deepEqual(urls, [`${ORIGIN}/core/app.js`]);
});

test('a vendored runtime is left to cache-on-use', () => {
  // In an air-gapped build the WebR/DuckDB runtimes are same-origin files of tens of MB.
  // Announcing them would make a background top-up re-download the whole runtime on what
  // may be a metered connection.
  const urls = collectShellUrls(
    { getEntriesByType: () => [
      res(`${ORIGIN}/vendor/webr.wasm`, 40 * 1024 * 1024),
      res(`${ORIGIN}/vendor/big-bundle.js`, 9 * 1024 * 1024),
      res(`${ORIGIN}/core/app.js`, 50_000),
    ] },
    ORIGIN,
  );
  assert.deepEqual(urls, [`${ORIGIN}/core/app.js`], 'only the small shell files');
});

test('a query string is dropped rather than cached under a key nobody asks for', () => {
  const urls = collectShellUrls(
    { getEntriesByType: () => [res(`${ORIGIN}/core/app.js?v=12345`), res(`${ORIGIN}/core/app.js`)] },
    ORIGIN,
  );
  assert.deepEqual(urls, [`${ORIGIN}/core/app.js`]);
});

test('the same file loaded twice is announced once', () => {
  const urls = collectShellUrls(
    { getEntriesByType: () => [res(`${ORIGIN}/core/app.js`), res(`${ORIGIN}/core/app.js`)] },
    ORIGIN,
  );
  assert.equal(urls.length, 1);
});

test('the announcement is bounded', () => {
  const many = Array.from({ length: 2000 }, (_, i) => res(`${ORIGIN}/core/m${i}.js`));
  const urls = collectShellUrls({ getEntriesByType: () => many }, ORIGIN);
  assert.ok(urls.length <= 600 && urls.length > 0, `bounded, got ${urls.length}`);
});

test('a browser without resource timing just says nothing', () => {
  assert.deepEqual(collectShellUrls({}, ORIGIN), []);
  assert.deepEqual(collectShellUrls({ getEntriesByType: () => { throw new Error('nope'); } }, ORIGIN), []);
});

// =============================================================================
// The worker side: what it accepts, and what it then does
// =============================================================================

/** The worker's manifest machinery, made callable. */
function loadShell({ cache, fetchImpl }) {
  const caches = { open: async () => cache };
  return new Function(
    'caches', 'fetch', 'self', 'Request', 'Response',
    `${seam('markers')}
${seam('deadline')}
function withIsolation(r) { return r; }
${seam('shell')}
return { sanitizeShellUrls, topUpShell, SHELL_MANIFEST_MAX };`,
  )(caches, fetchImpl, { location: { origin: ORIGIN } }, Request, Response);
}

/** A Cache over a Map. */
function fakeCache(initial = []) {
  const store = new Map(initial.map((u) => [u, 'cached']));
  return {
    store,
    match: async (k) => store.get(typeof k === 'string' ? k : k.url),
    put: async (k, v) => void store.set(typeof k === 'string' ? k : k.url, v),
    delete: async (k) => store.delete(typeof k === 'string' ? k : k.url),
  };
}

test('the worker refuses a cross-origin URL even when the page asks for it', () => {
  // The message channel is not a capability: any script on the origin can post here. So
  // the worker re-derives the rule rather than trusting the sender.
  const { sanitizeShellUrls } = loadShell({ cache: fakeCache(), fetchImpl: async () => {} });
  assert.deepEqual(
    sanitizeShellUrls([`${ORIGIN}/core/app.js`, 'https://evil.test/x.js', 'https://repo.r-wasm.org/p.tgz']),
    [`${ORIGIN}/core/app.js`],
  );
});

test('the worker drops junk without dropping the message', () => {
  // Junk must be rejected, not RESOLVED. Parsing with the origin as a base would turn
  // "not a url" and 42 into plausible same-origin paths, each costing a real request and
  // a 404 on every launch until the prune caught up. Absolute-only is what prevents that,
  // and the page only ever announces absolute URLs.
  const { sanitizeShellUrls } = loadShell({ cache: fakeCache(), fetchImpl: async () => {} });
  const got = sanitizeShellUrls([null, '', 'not a url', 42, '/core/relative.js',
    `${ORIGIN}/core/a.js`, `${ORIGIN}/b.js?x=1`]);
  assert.deepEqual(got, [`${ORIGIN}/core/a.js`]);
});

test('the worker caps what it will store', () => {
  const { sanitizeShellUrls, SHELL_MANIFEST_MAX } = loadShell({ cache: fakeCache(), fetchImpl: async () => {} });
  const many = Array.from({ length: 5000 }, (_, i) => `${ORIGIN}/core/m${i}.js`);
  assert.equal(sanitizeShellUrls(many).length, SHELL_MANIFEST_MAX);
});

test('only the files the worker is missing are fetched', async () => {
  // The whole point: the already-cached majority must not be re-downloaded every launch.
  const cache = fakeCache([`${ORIGIN}/core/app.js`]);
  const asked = [];
  const { topUpShell } = loadShell({
    cache,
    fetchImpl: async (req) => { asked.push(req.url); return new Response('x', { status: 200 }); },
  });
  const out = await topUpShell([`${ORIGIN}/core/app.js`, `${ORIGIN}/core/event-bus.js`]);
  assert.deepEqual(asked, [`${ORIGIN}/core/event-bus.js`], 'the cached one is never requested');
  assert.equal(out.added, 1);
  assert.ok(cache.store.has(`${ORIGIN}/core/event-bus.js`), 'and the missing one is now held');
});

test('a module deleted in a refactor prunes itself from the list', async () => {
  // Otherwise a stale manifest re-requests a 404 on every launch, for ever.
  const { topUpShell } = loadShell({
    cache: fakeCache(),
    fetchImpl: async (req) => new Response('', { status: req.url.endsWith('gone.js') ? 404 : 200 }),
  });
  const out = await topUpShell([`${ORIGIN}/core/gone.js`, `${ORIGIN}/core/here.js`]);
  assert.deepEqual(out.dropped, [`${ORIGIN}/core/gone.js`]);
  assert.equal(out.added, 1, 'and a 404 does not stop the rest');
});

test('a network that has started failing is left alone', async () => {
  // A background task that keeps hammering a dead connection becomes a foreground problem
  // — and on iOS, sockets held by doomed requests are the scarce resource.
  let calls = 0;
  const { topUpShell } = loadShell({
    cache: fakeCache(),
    fetchImpl: async () => { calls++; throw new Error('offline'); },
  });
  const urls = Array.from({ length: 50 }, (_, i) => `${ORIGIN}/core/m${i}.js`);
  const out = await topUpShell(urls);
  assert.equal(out.added, 0);
  assert.ok(calls <= 5, `gave up after ${calls} failures rather than trying all 50`);
});

test('a stalled top-up cannot hang the worker', async () => {
  // It reuses the same deadline as the serving path: a background task that never
  // finishes keeps the worker (and its connections) alive indefinitely.
  const { topUpShell } = loadShell({ cache: fakeCache(), fetchImpl: () => new Promise(() => {}) });
  const t0 = Date.now();
  const out = await topUpShell(
    [`${ORIGIN}/core/a.js`, `${ORIGIN}/core/b.js`, `${ORIGIN}/core/c.js`],
    { timeoutMs: 40 },
  );
  assert.equal(out.added, 0);
  assert.ok(Date.now() - t0 < 2000, 'bounded by the shell deadline, not by hope');
});

test('top-ups are serial, not a burst of connections', () => {
  const body = stripComments(SRC).match(/async function topUpShell[\s\S]*?\n}/);
  assert.ok(body, 'topUpShell is gone or renamed');
  assert.doesNotMatch(
    body[0],
    /Promise\.all|allSettled/,
    'a parallel top-up opens ~130 connections on a phone that has just finished booting',
  );
  assert.match(body[0], /for \(const url of urls\)/, 'one at a time');
});

// =============================================================================
// Wiring
// =============================================================================

test('the manifest is persisted and restored like every other worker decision', () => {
  const src = stripComments(SRC);
  assert.match(src, /SHELL_MARKER/, 'it has a marker');
  const restore = src.match(/function restoreSettings[\s\S]*?\n}/);
  assert.match(restore[0], /SHELL_MARKER/, 'and is restored before fetches are routed');
  const handler = src.match(/d\.type === 'announce-shell'[\s\S]*?else if/);
  assert.ok(handler, 'the announce-shell handler is gone');
  assert.match(handler[0], /c\.put\(SHELL_MARKER/, 'and the announcement is written down');
});

test('a short launch cannot shrink what a long session learned', () => {
  // Different launches load different parts of the app. Replacing rather than merging
  // would mean a launch that only reached the launcher threw away the rest.
  const handler = stripComments(SRC).match(/d\.type === 'announce-shell'[\s\S]*?else if/)[0];
  assert.match(handler, /\.\.\.shellManifest,\s*\.\.\.announced/, 'merge, not replace');
});

test('the announcement is scheduled before the launcher gate, and deferred to idle', () => {
  // `launcher.open()` resolves when the user picks a source and clicks Start — it is a
  // human gate, not a loading step. Scheduling the announcement BELOW it meant a launch
  // where someone opened the app, looked at the launcher and closed it taught the worker
  // nothing, which is a large share of real launches. (Found by testing it: a one-launch
  // profile still showed 40 of core/ cached and no manifest at all.)
  //
  // It must still be deferred to load+idle, because the top-up spends requests and a
  // launch is the worst moment to spend them.
  const app = readFileSync('core/app.js', 'utf8');
  const idx = app.indexOf('scheduleShellAnnounce');
  const openIdx = app.indexOf('await launcher.open()');
  assert.ok(idx > 0 && openIdx > 0, 'boot must hand the list over');
  assert.ok(idx < openIdx, 'scheduled before the launcher gate, which waits on a human');
  const block = app.slice(idx - 100, openIdx);
  assert.match(block, /requestIdleCallback/, 'deferred to idle, not run inline');
  assert.match(block, /readyState === 'complete'|addEventListener\('load'/, 'and not before load');
});

test('install still precaches only the small critical set', () => {
  // The manifest must NOT be precached on install: that is the contention which made the
  // 2026-11-10 hang a hang, at thirteen times the size.
  const install = stripComments(SRC).match(/addEventListener\('install'[\s\S]*?\n {2}\}\);/);
  assert.ok(install, 'the install handler is gone or reshaped');
  assert.doesNotMatch(install[0], /SHELL_MARKER|shellManifest|topUpShell/,
    'install must stay the short critical list, not the whole boot graph');
  assert.match(install[0], /SHELL_PRECACHE/);
});

test('a first visit still announces, even though it starts uncontrolled', () => {
  // The launch this whole feature exists for is the one that registers the worker — which
  // means the page is NOT yet controlled when boot finishes. Returning early on a missing
  // controller would have skipped precisely the launch worth announcing, and the gap would
  // have stayed open for exactly as long as before.
  const src = readFileSync('core/offline.js', 'utf8');
  const body = src.slice(src.indexOf('announceShell()'), src.indexOf('setRuntimeHosts('));
  assert.match(body, /controllerchange/,
    'announceShell must wait for control rather than give up when it is missing');
  assert.match(body, /\{ once: true \}/, 'and only once');
});
