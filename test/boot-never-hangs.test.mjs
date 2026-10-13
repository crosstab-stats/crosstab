/**
 * @file boot-never-hangs.test.mjs
 * Boot must always reach the launcher, including when the network stalls.
 *
 * ## The bug this exists for
 *
 * Reported 2026-10-13 with a screenshot, after being seen several times on a phone: the
 * installed PWA opened to its shell, the status line read "Starting…", and **the launcher
 * never appeared** — for minutes, until the app was force-quit. Reopening worked fine.
 *
 * `boot()` has exactly two top-level awaits before `launcher.open()`, and both were plain
 * fetches with no deadline:
 *
 *     const deploy = await loadDeployConfig();        // ./deploy.json
 *     const sitePlugins = await loadSitePlugins(...); // ./<dir>/index.json
 *
 * Their `try/catch` covers a fetch that REJECTS. It does nothing for one that never
 * settles — so `boot()` neither resolved nor rejected, and even the `.catch()` in
 * index.html that would have shown "Failed to start: …" never ran. The shell was painted
 * from static HTML, which is why the window looked alive.
 *
 * **Why the PWA hit it and a browser tab mostly did not.** `deploy.json` is absent from
 * the stock build, so it 404s. The service worker only caches a `response.ok`, so it is
 * never cached *despite being listed in SHELL_PRECACHE*. And `cache: 'no-store'` forbids
 * the HTTP cache. So every standalone cold start made a blocking, uncached network
 * request before anything else could happen — at exactly the moment a phone or desktop
 * PWA is most likely to have a cold network stack.
 *
 * These tests use an injected fetch that never settles. Without the timeout they hang
 * forever rather than failing, which is the honest shape of the defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDeployConfig, fetchConfigFile, CONFIG_FETCH_TIMEOUT_MS } from '../core/deploy-config.js';
import { loadSitePlugins } from '../core/site-plugins.js';

/** A fetch that never settles — a stalled network, not a failed one. */
const stalled = () => new Promise(() => {});
/** A fetch that rejects — the case that always worked, kept so the fix did not break it. */
const refused = () => Promise.reject(new Error('offline'));

test('a stalled deploy.json does not hang boot', async () => {
  const t0 = Date.now();
  const cfg = await loadDeployConfig({ fetch: stalled, timeoutMs: 40 });
  assert.ok(cfg && typeof cfg === 'object', 'it must resolve to the built-in defaults');
  assert.ok(!cfg.applied, 'the defaults stand; nothing was applied from a file that never arrived');
  assert.ok(Date.now() - t0 < 2000, 'and it must not wait around to do it');
});

test('a stalled site-plugin index does not hang boot either', async () => {
  const t0 = Date.now();
  const out = await loadSitePlugins({ cfg: { pluginDir: 'site-plugins' }, fetch: stalled, timeoutMs: 40 });
  assert.deepEqual(out.entries, [], 'no entries, rather than no app');
  assert.equal(out.issues.length, 1, 'and it says the index could not be read');
  assert.ok(Date.now() - t0 < 2000);
});

test('a REFUSED fetch still behaves as it always did', async () => {
  // The case the original try/catch handled. The fix must not have traded one for
  // the other.
  const cfg = await loadDeployConfig({ fetch: refused, timeoutMs: 40 });
  assert.ok(cfg && typeof cfg === 'object');
});

test('a file that answers in time is still read normally', async () => {
  // The timeout must not become "ignore the deployment's settings".
  const body = JSON.stringify({ support: { repo: 'crosstab-stats/crosstab' } });
  const ok = async () => ({ ok: true, text: async () => body });
  const cfg = await loadDeployConfig({ fetch: ok, timeoutMs: 1000 });
  assert.equal(cfg.applied, true, 'a real file is applied, not skipped');
});

test('a 404 is still the quiet normal case for the stock build', async () => {
  const missing = async () => ({ ok: false, status: 404, text: async () => '' });
  const cfg = await loadDeployConfig({ fetch: missing, timeoutMs: 1000 });
  assert.ok(cfg && typeof cfg === 'object');
});

test('fetchConfigFile returns null rather than throwing, whatever happens', async () => {
  assert.equal(await fetchConfigFile(stalled, './x.json', 30), null);
  assert.equal(await fetchConfigFile(refused, './x.json', 30), null);
  assert.equal(await fetchConfigFile(() => { throw new Error('sync boom'); }, './x.json', 30), null);
  assert.equal(await fetchConfigFile(async () => ({ ok: false }), './x.json', 30), null);
});

test('the default deadline is long enough to be fair and short enough to notice', () => {
  // Timing out on a deployment that HAS a deploy.json costs it its support routes and
  // site plugins for that session, so this should not be twitchy; a user staring at a
  // frozen splash should not wait long either.
  assert.ok(CONFIG_FETCH_TIMEOUT_MS >= 2000, 'not so short that a slow link loses its settings');
  assert.ok(CONFIG_FETCH_TIMEOUT_MS <= 10000, 'not so long that it reads as a hang');
});

test('the first two things boot awaits are still the two bounded loaders', () => {
  // The guard that matters most. This bug was findable because boot reaches the launcher
  // through exactly two awaits, and both are now bounded. If a THIRD await appears ahead
  // of them, it is on the critical path to the launcher and needs a deadline of its own —
  // otherwise this exact freeze comes back.
  //
  // Checked by ORDER rather than by counting indented lines: boot also *defines* many
  // async handlers, whose awaits run later and must not be confused with its own.
  const app = readFileSync('core/app.js', 'utf8');
  const start = app.indexOf('export async function boot(');
  const open = app.indexOf('await launcher.open()', start);
  assert.ok(start > 0 && open > start, 'boot and launcher.open must both be findable');
  const body = app.slice(start, open);
  const firstTwo = [...body.matchAll(/await\s+([A-Za-z_$][\w$.]*)\s*\(/g)].slice(0, 2).map((m) => m[1]);
  assert.deepEqual(firstTwo, ['loadDeployConfig', 'loadSitePlugins'],
    'a new await landed on the critical path to the launcher — give it a deadline');
});
