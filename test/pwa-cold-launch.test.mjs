/**
 * @file pwa-cold-launch.test.mjs
 * The installed app must reach its launcher from a cold start, on a bad radio.
 *
 * ## The bug this exists for
 *
 * Reported 2026-11-10 with a screenshot, after several sightings: the iOS Home Screen app
 * opened to its shell, the status line read "Starting…", and the launcher never appeared.
 * Force-quitting and reopening always worked, instantly. It was likelier when several
 * updates had accumulated since the last launch, but that was neither necessary nor
 * sufficient.
 *
 * It is the October "PWA froze at Starting…" bug (`boot-never-hangs.test.mjs`) one layer
 * down. That one bounded the two config fetches `boot()` awaits. This one is about the
 * module graph that has to arrive before `boot` is so much as *imported* — every byte of
 * which the service worker serves.
 *
 * **Three things lined up, and all three had to be fixed.**
 *
 * 1. **The cache-first path could not engage on the launch it was written for.** The
 *    worker serves the same-origin shell cache-first when `standalone` is set, and
 *    `standalone` was an in-memory variable announced by the page. The page cannot make
 *    that announcement until `core/offline.js` has loaded — one of the very module fetches
 *    the flag exists to serve from cache. So on every cold launch of the installed app the
 *    flag was `false` for the whole of boot. A circular dependency, invisible because the
 *    degraded path (network-first) normally works.
 *
 * 2. **The network-first path it fell through to had no deadline.** `respondWith()` on a
 *    promise that never settles is a subresource that never arrives. A module that never
 *    arrives is a boot that can neither start nor fail — and the shell the user is staring
 *    at is static HTML, so "Starting…" is just the initial text of an element nobody got
 *    round to updating. Exactly the shape of the October bug: a `try/catch` covers a fetch
 *    that REJECTS and does nothing at all for one that never SETTLES.
 *
 * 3. **An update reloaded the page mid-boot.** `updatefound` fires when a new worker
 *    begins *installing*; the handler reloaded immediately, discarding an in-flight boot
 *    while that worker was precaching eight entries with `cache: 'reload'`. That is the
 *    "more likely after several updates" correlate.
 *
 * `sw.js` cannot be imported — it is a classic worker script that touches `self` and
 * `caches` at load — so the regions between its seam markers are extracted and run. Same
 * technique as `runtime-hosts.test.mjs`, and for the same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('sw.js', 'utf8');

/** Lift a marked region out of sw.js. */
function seam(name) {
  const block = SRC.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`));
  assert.ok(
    block,
    `the ${name}:start/end seam is gone from sw.js — restore it or this file is blind`,
  );
  return block[0];
}

/**
 * Comments are stripped before anything is asserted ABSENT. The fix is *documented* in
 * sw.js in the same words the assertions look for — "window.location.reload()",
 * "AbortSignal" — so a test reading raw source would find the explanation of why the code
 * is gone and conclude it is still there.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** The worker's remembered-decision machinery, made callable. */
function loadRestore(caches) {
  return new Function(
    'caches',
    `${seam('markers')}
${seam('hosts')}
${seam('deadline')}
function withIsolation(r) { return r; }
${seam('shell')}
${seam('restore')}
return {
  restoreSettings,
  announceStandalone: (v) => { standalone = !!v; },
  state: () => ({ standalone, offlineEnabled, extraRuntimeHosts }),
  OFFLINE_MARKER, HOSTS_MARKER, STANDALONE_MARKER,
};`,
  )(caches);
}

/** A Cache API over a Map, counting opens so memoisation can be asserted. */
function fakeCaches(entries = {}) {
  const store = new Map(Object.entries(entries));
  let opens = 0;
  return {
    opens: () => opens,
    store,
    open: async () => {
      opens++;
      return {
        match: async (k) => store.get(k),
        put: async (k, v) => void store.set(k, v),
        delete: async (k) => store.delete(k),
      };
    },
  };
}

// =============================================================================
// 1. The flag that could never be true when it mattered
// =============================================================================

test('a respawned worker still knows it is serving an installed app', async () => {
  // The heart of it. `activate` does NOT re-run when an idle worker is respawned — which
  // iOS does aggressively — so restoring there alone left a respawned worker answering the
  // whole boot with `standalone` back at its default.
  const caches = fakeCaches({ 'https://crosstab.local/__standalone__': new Response('1') });
  const w = loadRestore(caches);

  assert.equal(w.state().standalone, false, 'a fresh worker instance starts with nothing');
  await w.restoreSettings();
  assert.equal(
    w.state().standalone,
    true,
    'and must recover the decision before it routes a single fetch — otherwise the '
      + 'cache-first shell path is off for the entire cold launch',
  );
});

test('the offline opt-in and the runtime hosts come back too', async () => {
  // Same lifecycle bug, lower stakes: these two only made a respawned worker slower.
  const caches = fakeCaches({
    'https://crosstab.local/__offline_enabled__': new Response('1'),
    'https://crosstab.local/__runtime_hosts__': { json: async () => ['mirror.example.edu'] },
  });
  const w = loadRestore(caches);
  await w.restoreSettings();
  const s = w.state();
  assert.equal(s.offlineEnabled, true);
  assert.deepEqual(s.extraRuntimeHosts, ['mirror.example.edu']);
});

test('nothing is restored that was never stored', async () => {
  const w = loadRestore(fakeCaches());
  await w.restoreSettings();
  assert.deepEqual(w.state(), { standalone: false, offlineEnabled: false, extraRuntimeHosts: [] });
});

test('a restore never un-does an announcement it raced', async () => {
  // The page's `set-standalone` message and the first fetch's restore run concurrently. If
  // the message lands first and the marker write has not yet, a restore that ASSIGNED
  // rather than OR-ed would reset the flag the page just set — and the window in which
  // that happens is precisely a cold launch.
  const caches = fakeCaches(); // marker not written yet
  const w = loadRestore(caches);
  w.announceStandalone(true);
  await w.restoreSettings();
  assert.equal(w.state().standalone, true, 'the live announcement outranks an empty cache');
});

test('restoring is memoised — one cache open per worker, not one per request', async () => {
  const caches = fakeCaches({ 'https://crosstab.local/__standalone__': new Response('1') });
  const w = loadRestore(caches);
  await Promise.all([w.restoreSettings(), w.restoreSettings(), w.restoreSettings()]);
  await w.restoreSettings();
  assert.equal(caches.opens(), 1, 'every fetch awaits this; it must not re-read the cache');
});

test('a worker with no Cache API still answers fetches', async () => {
  // Degraded, not broken: the defaults stand and the network path takes over.
  const w = loadRestore({ open: async () => { throw new Error('no Cache API'); } });
  await w.restoreSettings();
  assert.equal(w.state().standalone, false);
});

test('the decision is restored before any routing happens', () => {
  // Ordering, not presence: a restore that ran after the standalone/offline branch would
  // be decoration. Checked against the comment-stripped source so the prose above
  // handleFetch cannot satisfy it.
  const body = stripComments(SRC).match(/async function handleFetch\(r\)[\s\S]*?\n}/);
  assert.ok(body, 'handleFetch is gone or renamed');
  const restoreAt = body[0].indexOf('restoreSettings');
  const routeAt = body[0].indexOf('standalone');
  assert.ok(restoreAt > -1, 'handleFetch must restore the remembered decisions');
  assert.ok(
    restoreAt < routeAt,
    'it must do so BEFORE the branch that reads `standalone`, or the first request of a '
      + 'respawned worker — the document itself — is routed on a default',
  );
});

test('the standalone announcement is persisted, not just held', () => {
  const src = stripComments(SRC);
  const handler = src.match(/d\.type === 'set-standalone'[\s\S]*?else if/);
  assert.ok(handler, "the set-standalone message handler is gone");
  assert.match(
    handler[0],
    /STANDALONE_MARKER/,
    'the page announces this once per load and the worker outlives none of it — a flag '
      + 'that is only assigned is the bug this file is named for',
  );
});

// =============================================================================
// 2. A stalled network must not become a permanent hang
// =============================================================================

/** The worker's network deadline, made callable. */
function loadDeadline() {
  return new Function(`${seam('deadline')}
return { withDeadline, SHELL_HEADERS_TIMEOUT_MS };`)();
}

test('a fetch that never settles is given up on', async () => {
  // Without the deadline this test does not fail — it hangs forever, which is the honest
  // shape of the defect.
  const { withDeadline } = loadDeadline();
  const t0 = Date.now();
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 40),
    /stalled/,
    'a stalled request must reject so the caller can fall back to the cache',
  );
  assert.ok(Date.now() - t0 < 2000, 'and promptly');
});

test('a response that arrives in time is passed straight through', async () => {
  const { withDeadline } = loadDeadline();
  const res = { ok: true, marker: 'the real response' };
  assert.equal(await withDeadline(Promise.resolve(res), 1000), res);
});

test('a rejection still rejects as itself', async () => {
  // The case the original code already handled. The fix must not have traded one for the
  // other — offline must stay a fast, honest failure into the cache fallback.
  const { withDeadline } = loadDeadline();
  await assert.rejects(() => withDeadline(Promise.reject(new Error('offline')), 1000), /offline/);
});

test('the deadline is long enough not to fire on a slow but healthy link', () => {
  const { SHELL_HEADERS_TIMEOUT_MS } = loadDeadline();
  assert.ok(SHELL_HEADERS_TIMEOUT_MS >= 5000, 'shorter would fail real phones on bad signal');
  assert.ok(SHELL_HEADERS_TIMEOUT_MS <= 15000, 'longer and it reads as a hang, which is the bug');
});

test('the same-origin shell is the thing that is bounded', () => {
  const body = stripComments(SRC).match(/async function networkAndCache[\s\S]*?\n}/);
  assert.ok(body, 'networkAndCache is gone or renamed');
  assert.match(
    body[0],
    /sameOrigin && isGet\s*\?[\s\S]*?withDeadline/,
    'the module graph, the documents and the plugin sources are the boot path; they are '
      + 'what must never hang',
  );
});

test('the bound covers the headers, never the body', () => {
  // An AbortSignal would apply to the whole request. In a vendored air-gapped build the
  // WebR/DuckDB runtimes are same-origin files of tens of megabytes, so aborting on total
  // elapsed time would kill a healthy transfer over a slow LAN — trading a rare hang for a
  // guaranteed one. Racing the promise bounds connect-and-first-byte and nothing else.
  const body = stripComments(SRC).match(/function withDeadline[\s\S]*?\n}/);
  assert.ok(body);
  assert.doesNotMatch(
    body[0],
    /AbortSignal|\.abort\(/,
    'the deadline must not be able to truncate a download that is slow but progressing',
  );
  assert.match(body[0], /clearTimeout/, 'and it must not leak a timer per request');
});

// =============================================================================
// 3. An update must not pull the rug out from under a boot
// =============================================================================

test('a new worker does not reload the page the moment it starts installing', () => {
  const src = stripComments(SRC);
  const handler = src.match(/addEventListener\('updatefound'[\s\S]*?\n {8}\}\);/);
  assert.ok(handler, 'the updatefound handler is gone or reshaped — re-check this test');

  assert.doesNotMatch(
    handler[0],
    /^\s*if \(n\.serviceWorker\.controller\) window\.location\.reload\(\);\s*$/m,
    'reloading on `updatefound` discards an in-flight boot while the new worker is '
      + 'precaching over a cold radio — the "several updates" correlate',
  );
  assert.match(
    handler[0],
    /statechange/,
    'it must wait for the new worker to actually take over',
  );
  assert.match(handler[0], /activated/, 'specifically, for it to reach `activated`');
});

test('an update still lands on this launch rather than after a force-quit', () => {
  // The proactive update check exists because iOS Safari will not re-check a controlled
  // tab on its own. Deferring the reload must not quietly restore the "had to kill the
  // app" bug it was written to fix.
  const src = stripComments(SRC);
  assert.match(src, /registration\.update\(\)/, 'the proactive check is still made');
  assert.match(src, /visibilitychange/, 'and still re-made when the app comes back to the fore');
  assert.match(src, /skipWaiting/, 'so activation follows install without waiting for a close');
});

test('the reload waits for the document, and happens at most once per load', () => {
  const handler = stripComments(SRC).match(/addEventListener\('updatefound'[\s\S]*?\n {8}\}\);/)[0];
  assert.match(
    handler,
    /readyState === 'complete'/,
    'never yank a boot that is still in progress',
  );
  assert.match(
    handler,
    /sessionStorage\.getItem\('coiReloadedBySelf'\)/,
    'a worker that re-announces must not be able to start a reload loop',
  );
});

test('the update reload and the isolate reload cannot both fire in one cycle', () => {
  // They share one session flag. The isolate dance reads it as `=== 'isolate'`, so the
  // update path must write a DIFFERENT value — writing 'isolate' would suppress a genuine
  // isolation reload on the next load and leave the app without SharedArrayBuffer.
  const src = stripComments(SRC);
  assert.match(src, /setItem\('coiReloadedBySelf', 'update'\)/, 'the update path marks itself');
  assert.match(src, /reloadedBySelf === 'isolate'/, 'and the isolate path still tests for its own');
});
