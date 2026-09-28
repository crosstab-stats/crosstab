/**
 * @file runtime-hosts.test.mjs
 * #185 — a deployment's own runtime mirror gets cached like the built-in CDN.
 *
 * `runtimeHosts` was accepted and validated for weeks with nothing consuming it: the offline
 * cache lives in `sw.js`, and a service worker cannot import `core/`. So a site that mirrored
 * WebR on its own host set `assets` + `runtimeHosts`, saw both accepted, and still
 * re-downloaded the whole R runtime every session — the one field in the file that silently
 * did nothing.
 *
 * The fix could have gone two ways, and which one was chosen is the thing worth guarding:
 *
 *  - **Rejected:** the worker reads and parses `deploy.json` itself. That means a second
 *    comment-and-trailing-comma-tolerant parser and a second copy of the hostname rule. Two
 *    copies of one rule is precisely what produced the diverged plugin tooltip, the "built-in"
 *    origin label and the double-counted deploy issues, all inside one week.
 *  - **Chosen:** `core/deploy-config.js` stays the only reader, and the page announces the
 *    result over the channel `set-standalone` already uses. The worker persists it in its own
 *    cache, so the announcement has to land once per deployment rather than once per fetch.
 *
 * That choice creates one thing to test that would otherwise be untestable and invisible: the
 * worker keeps a *defensive floor* over the announced list, and **a floor stricter than the
 * validator upstream is a silent drop**. A deployer writing `localhost` or an intranet
 * `mirror` would be accepted by the settings file, warned about nothing, and quietly never
 * cached. So the floor is asserted against the real validator's output, not against a
 * hand-written list of what I imagined it accepts.
 *
 * `sw.js` cannot be imported — it is a classic worker script that touches `self` and `caches`
 * at load — so the region between its `hosts:start` / `hosts:end` markers is extracted and
 * run. Same seam technique as plugin-host.html's import-map aliases, and for the same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseDeployConfig, validateDeployConfig } from '../core/deploy-config.js';

/** The worker's host rules, lifted out of sw.js and made callable. */
function loadHostRules() {
  const src = readFileSync('sw.js', 'utf8');
  const block = src.match(/\/\/ hosts:start[\s\S]*?\/\/ hosts:end/);
  assert.ok(block, 'the hosts:start/end seam is gone from sw.js — restore it or this file is blind');
  return new Function(`${block[0]}
return {
  RUNTIME_HOSTS,
  sanitizeHosts,
  isRuntimeAsset,
  announce: (hosts) => { extraRuntimeHosts = sanitizeHosts(hosts); return extraRuntimeHosts; },
};`)();
}

// =============================================================================
// What gets cached
// =============================================================================

test('the built-in CDN hosts are recognised, and unrelated hosts are not', () => {
  const { isRuntimeAsset } = loadHostRules();
  for (const url of [
    'https://webr.r-wasm.org/latest/webr.mjs',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/lavaan_0.6-19.tgz',
    'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm',
    'https://esm.sh/hyparquet@1',
  ]) assert.equal(isRuntimeAsset(url), true, url);

  // The reason this is an allow-list at all: a plugin's own fetches (FRED, Wikipedia) and
  // any other cross-origin DATA must never be silently cached.
  for (const url of [
    'https://api.stlouisfed.org/fred/series?id=GDP',
    'https://en.wikipedia.org/w/api.php',
    'https://mirror.example.edu/webr/webr.mjs',
  ]) assert.equal(isRuntimeAsset(url), false, url);
});

test('an announced mirror is cached; announcing it does not open the door to anything else', () => {
  const { announce, isRuntimeAsset } = loadHostRules();
  announce(['mirror.example.edu']);
  assert.equal(isRuntimeAsset('https://mirror.example.edu/webr/webr.mjs'), true);
  assert.equal(isRuntimeAsset('https://other.example.edu/webr/webr.mjs'), false);
  assert.equal(isRuntimeAsset('https://api.stlouisfed.org/fred/series'), false);
});

test('the built-in hosts cannot be taken away by an announcement', () => {
  // The stock build depends on them, so an empty, broken or hostile announcement must not be
  // able to switch off caching for the CDN.
  const { announce, isRuntimeAsset } = loadHostRules();
  for (const bad of [[], null, 'mirror.example.edu', [{}, 42], ['*']]) {
    announce(bad);
    assert.equal(isRuntimeAsset('https://webr.r-wasm.org/x.wasm'), true, `lost the CDN for ${JSON.stringify(bad)}`);
  }
});

test('an empty announcement clears a mirror that has been removed', () => {
  // Why the page announces on every boot rather than only when it has something to say.
  const { announce, isRuntimeAsset } = loadHostRules();
  announce(['mirror.example.edu']);
  assert.equal(isRuntimeAsset('https://mirror.example.edu/x'), true);
  announce([]);
  assert.equal(isRuntimeAsset('https://mirror.example.edu/x'), false);
});

// =============================================================================
// The floor over the announced list
// =============================================================================

test('the floor normalises rather than guesses', () => {
  const { sanitizeHosts, RUNTIME_HOSTS } = loadHostRules();
  assert.deepEqual(sanitizeHosts(['MIRROR.Example.EDU', ' mirror.example.edu ']), ['mirror.example.edu'],
    'case-folded and deduplicated — a URL hostname is lowercase');
  assert.deepEqual(sanitizeHosts([RUNTIME_HOSTS[0], 'mirror.example.edu']), ['mirror.example.edu'],
    'a built-in is not repeated into the extras');
  assert.deepEqual(sanitizeHosts(null), []);
  assert.deepEqual(sanitizeHosts('mirror.example.edu'), [], 'a bare string is not a list');
  assert.equal(sanitizeHosts(Array.from({ length: 40 }, (_, i) => `h${i}.example.edu`)).length, 20,
    'an allow-list, not a directory');
});

test('the floor refuses what could never be a hostname', () => {
  const { sanitizeHosts } = loadHostRules();
  for (const bad of ['mirror.example.edu:8080', 'mirror.example.edu/webr', 'a b', '', '   ', 'x'.repeat(300)]) {
    assert.deepEqual(sanitizeHosts([bad]), [], `accepted ${JSON.stringify(bad)}`);
  }
});

/**
 * The divergence guard. This is the test the change actually needed.
 *
 * `deploy-config.js` validates `runtimeHosts` and tells the deployer when it drops one. If the
 * worker's floor is *stricter*, a host survives validation with no warning and is then dropped
 * where nobody can see it — the deployer set the field, was told nothing, and their mirror is
 * still downloaded every session. So: everything the real validator keeps must also survive
 * the floor.
 */
test('the worker never drops a host the settings file accepted', () => {
  const { sanitizeHosts } = loadHostRules();
  const candidates = [
    'mirror.example.edu',
    'localhost', // a dev box — single-label, and a regex-based floor would have refused it
    'mirror', // an intranet host, which is also single-label and also legitimate
    'r-mirror.stats.example.ac.uk',
    'xn--80ak6aa92e.com', // punycode
    '10.0.0.7', // an IP is a hostname as far as the cache is concerned
    'a.b',
  ];
  const cfg = validateDeployConfig(parseDeployConfig(JSON.stringify({ runtimeHosts: candidates })));
  assert.deepEqual(cfg.issues, [], 'this test is only meaningful for hosts the validator KEEPS');
  assert.deepEqual(sanitizeHosts(cfg.runtimeHosts), cfg.runtimeHosts,
    'the worker silently dropped a host the deployer was told was fine');
});

// =============================================================================
// The marker family
// =============================================================================

test('the worker’s own bookkeeping keys are not counted as cached assets', () => {
  // There are two of these keys now (the offline opt-in, and the host list), and the first was
  // matched by exact URL in four places. Adding a second that way would have inflated the
  // "N files cached" figure and made the host list look like a downloaded asset.
  const src = readFileSync('sw.js', 'utf8');
  const isMarker = new Function(`${src.match(/const MARKER_PREFIX = [\s\S]*?\n}/)[0]}
return isMarker;`)();
  assert.equal(isMarker('https://crosstab.local/__offline_enabled__'), true);
  assert.equal(isMarker('https://crosstab.local/__runtime_hosts__'), true);
  assert.equal(isMarker('https://webr.r-wasm.org/webr.mjs'), false);
  assert.equal(isMarker('https://example.edu/index.html'), false);
});

test('the page and the worker agree on the marker prefix', () => {
  // They are separate files by necessity — a service worker cannot import core/ — so the one
  // constant they must share is checked rather than assumed.
  const prefixOf = (file) => readFileSync(file, 'utf8').match(/MARKER_PREFIX = '([^']+)'/)?.[1];
  const inWorker = prefixOf('sw.js');
  assert.ok(inWorker, 'sw.js no longer declares MARKER_PREFIX');
  assert.equal(prefixOf('core/offline.js'), inWorker,
    'the page would count the worker’s bookkeeping keys as cached files');
});
