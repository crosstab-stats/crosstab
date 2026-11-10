/*!
 * sw.js — Cross-Origin-Isolation + **offline cache** service worker.
 *
 * Two jobs in one worker:
 *
 *  1. **Cross-origin isolation.** WebR's fast, multi-threaded path and
 *     `SharedArrayBuffer` require the page to be "cross-origin isolated", granted
 *     only when the document is served with:
 *         Cross-Origin-Opener-Policy:  same-origin
 *         Cross-Origin-Embedder-Policy: require-corp
 *     On static hosts where we can't set response headers (GitHub Pages, local
 *     `python -m http.server`), this worker injects them on the fly. In production
 *     (Cloudflare Pages) the headers come from the edge and this part is a no-op.
 *
 *  2. **Offline cache — one model, two tiers (#92).** Caching is unified across all
 *     run modes (tab, installed desktop/iPad PWA, air-gapped vendored build):
 *       - **App shell (same-origin): cached AUTOMATICALLY.** A small critical set is
 *         precached on `install`; thereafter every same-origin GET is cached as it's
 *         served. So the app itself opens offline after one load — no opt-in. An
 *         installed (standalone) app serves the shell cache-first (instant, flaky-
 *         network-proof); a tab stays network-first (fresh) with a cache fallback.
 *       - **Runtimes + R packages (cross-origin on CDN): cached AS USED.** The WebR /
 *         DuckDB / Arrow / hyparquet runtimes + each R package come down during
 *         normal use anyway (WebR warms at boot, a package downloads when its
 *         analysis first runs); we now keep them (cache-on-use, cache-first) instead
 *         of re-downloading — from the known runtime hosts only ({@link RUNTIME_HOSTS}),
 *         never arbitrary cross-origin data. So what you've used online works offline,
 *         with no opt-in and no extra download, and boots faster. The "Make available
 *         offline" toggle (core/offline.js) now only PRE-fetches the closure of
 *         packages you *haven't* run yet. In the air-gapped build the runtimes are
 *         *same-origin* (`./vendor/`), so the shell rule already covers them.
 *     The spike confirmed the CDN runtimes return CORS (non-opaque) responses, so
 *     they cache and re-serve cleanly even under cross-origin isolation.
 *
 * This file is loaded TWO ways and behaves differently in each:
 *   1. As a page `<script src="sw.js">` — runs the `else` branch: registers itself
 *      (always, so the cache can work) and reloads once *only if* isolation is
 *      still missing.
 *   2. As the service worker — runs the `if` branch: header rewriting + caching.
 *
 * Derived from coi-serviceworker by Guido Zuidhof and contributors (MIT).
 */

/* global self, caches */
let coepCredentialless = false;

// markers:start — a test seam, paired with `restore:start` below (see runtime-hosts.test.mjs
// for why sw.js is read rather than imported).
const CACHE = 'crosstab-offline-v4';
// Synthetic keys (never real requests) the worker uses to remember a decision across
// restarts. A service worker is killed and respawned freely, so anything that must survive
// that lives in the cache, not in a variable. They share a prefix so every place that
// ENUMERATES the cache can skip them as a family — the first one was matched by exact URL in
// four places, which would have silently counted the second as a cached asset.
const MARKER_PREFIX = 'https://crosstab.local/__';
const OFFLINE_MARKER = `${MARKER_PREFIX}offline_enabled__`;
// The deployment's extra runtime hosts (#185 `runtimeHosts`), as announced by the page.
const HOSTS_MARKER = `${MARKER_PREFIX}runtime_hosts__`;
// "This origin has been launched as an installed app." See {@link standalone} for why a
// variable was not enough, and what it cost.
const STANDALONE_MARKER = `${MARKER_PREFIX}standalone__`;
// The same-origin files a real launch actually needed, as announced by the page. See
// {@link topUpShell}.
const SHELL_MARKER = `${MARKER_PREFIX}shell_manifest__`;

/** Is this one of the worker's own bookkeeping keys rather than a cached asset? */
function isMarker(url) {
  return String(url).startsWith(MARKER_PREFIX);
}
// Tier-1 caching (the app shell) is automatic — the OPT-IN marker now only gates
// tier-2 (the big cross-origin runtimes + R packages).
let offlineEnabled = false;
// markers:end
// The minimal critical shell precached on install, so the app can boot offline even
// from a cold install (the rest of the same-origin module graph fills cache-on-use
// on first load). Resolved against the SW's scope. Kept short + resilient: a missing
// entry never fails the install.
/**
 * Same-origin documents that ARE themselves, and must never be answered with the app
 * shell.
 *
 * The shell fallback exists so an in-app URL like `/?launch=demo-quant` boots from cache
 * whatever its query. It was written as "any top-level navigation", which quietly
 * included pages that are not the app: an installed (standalone) CrossTab answered the
 * OAuth popup's navigation to `oauth-callback.html` with `index.html`, so the popup
 * booted a second copy of the whole app and the sign-in it was carrying went nowhere.
 *
 * Only visible when installed or offline, because an online browser tab falls through to
 * network-first and gets the right page — which is exactly the sort of difference that
 * makes a bug look like magic.
 */
const STANDALONE_DOCS = ['oauth-callback.html'];

/** Is this URL one of those documents? */
function isStandaloneDoc(url) {
  try {
    const path = new URL(url).pathname;
    return STANDALONE_DOCS.some((d) => path.endsWith(`/${d}`) || path === `/${d}`);
  } catch {
    return false;
  }
}

const SHELL_PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  'core/app.js',
  // The plugin sandbox document — every plugin loads in an iframe built from this one
  // template (the per-capability CSP is injected at runtime; see core/plugin-sandbox.js),
  // so it must be cached for plugins (hence analyses, importers, the demo data) to
  // work offline.
  'plugin-host.html',
  // The OAuth redirect target. It is a real, separate document — see STANDALONE_DOCS.
  'oauth-callback.html',
  // The deployment's own settings (#185). Absent in the stock build, and a missing entry never
  // fails the install — but a site that HAS one needs it cached, or an air-gapped/offline boot
  // would silently fall back to our defaults instead of their support routes and mirror.
  'deploy.json',
  'vendor/icon-192.png',
  'vendor/icon-180.png',
];

// Cross-origin hosts CrossTab loads its RUNTIMES + R packages from (CDN mode). These
// are cached automatically as they're used (they download anyway) and served
// cache-first — so "used online once → works offline" + faster boot, with no opt-in.
// Restricted to these known hosts so we never auto-cache arbitrary fetched *data*
// (e.g. a plugin's app.web request, the Wikipedia importer).
// hosts:start — a test seam. sw.js cannot be imported (it is a classic worker script that
// touches `self` and `caches` on load), so test/runtime-hosts.test.mjs extracts these lines
// and runs them. Keep the region self-contained; see the test for what it asserts.
const RUNTIME_HOSTS = [
  'webr.r-wasm.org', // WebR runtime
  'repo.r-wasm.org', // WebR R-package binaries
  'cdn.jsdelivr.net', // DuckDB-WASM, Arrow, hyparquet-writer
  'esm.sh', // codec libs (hyparquet) + esm.sh bundles
  // Whisper model weights (#201). transformers.js resolves a repo id against its default
  // `HF_HUB_URL`, and the worker sets no `env` override, so this is where the ONNX files
  // actually come from. Without it the weights were the one runtime payload the offline
  // cache could not hold — not even opportunistically, because `isRuntimeAsset` gates
  // caching by host. The library itself was already covered by cdn.jsdelivr.net above,
  // which is why transcription could *start* offline and then fail fetching its model.
  'huggingface.co',
  // The CDN huggingface.co redirects large files to. A cached redirect to an uncacheable
  // target is worse than no cache: it looks present and fails at read time.
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
];

/**
 * ...plus whatever the deployment's own `runtimeHosts` adds (#185) — a site that mirrors
 * WebR on its own host needs those payloads cached too, or "used online once → works
 * offline" quietly excludes the very files it was set up to serve.
 *
 * **The page announces these; the worker does not read `deploy.json`.** A service worker
 * cannot import `core/`, so parsing the file here would mean a SECOND comment-and-trailing-
 * comma-tolerant parser and a second copy of the hostname validation. Two copies of one rule
 * is the exact shape that produced the diverged plugin tooltip, the "built-in" origin label
 * and the double-counted deploy issues — all in one week. So `core/deploy-config.js` stays
 * the only thing that reads that file, and the page posts the result (`set-runtime-hosts`,
 * the same path `set-standalone` already uses).
 *
 * The cost of that choice, stated plainly: on the very first load the announcement can
 * arrive after WebR has already started fetching, so a payload or two goes uncached. It is
 * persisted to {@link HOSTS_MARKER}, so from the second load — and every cold start after,
 * including the offline ones where no page has run yet — the list is in place before the
 * first fetch. The built-ins are never replaced, only added to: a bad or empty announcement
 * cannot switch off caching for the CDN the stock build depends on.
 */
let extraRuntimeHosts = [];

/**
 * Bare hostnames, deduplicated against the built-ins.
 *
 * A floor, not a second validator: `deploy-config.js` has already checked the field and
 * warned the deployer about anything it rejected. The test used here is deliberately the
 * SAME primitive the match uses — a host is acceptable if `new URL('https://' + host)`
 * round-trips it unchanged — so this can never be stricter than `isRuntimeAsset`, which is
 * how a legitimate host (`localhost`, an intranet `mirror`) would otherwise be accepted in
 * the settings file, dropped silently here, and never cached with nobody told why.
 *
 * Note what does NOT need guarding: matching is exact equality against a URL's hostname, and
 * there is no wildcard syntax, so an entry like `*.example.edu` is inert rather than
 * dangerous — it simply never equals anything. What this does refuse is a malformed MESSAGE
 * (a bug, or another script on the origin) filling the allow-list with junk.
 */
function sanitizeHosts(list) {
  const out = [];
  for (const h of Array.isArray(list) ? list : []) {
    const host = String(h ?? '').trim().toLowerCase();
    if (!host || host.length > 253) continue;
    let round = '';
    try { round = new URL(`https://${host}`).hostname; } catch { continue; }
    if (round !== host) continue; // a port, a path, whitespace — not a hostname
    if (RUNTIME_HOSTS.includes(host) || out.includes(host)) continue;
    out.push(host);
    if (out.length >= 20) break; // an allow-list, not a directory
  }
  return out;
}

function isRuntimeAsset(url) {
  try {
    const { hostname } = new URL(url);
    return RUNTIME_HOSTS.includes(hostname) || extraRuntimeHosts.includes(hostname);
  } catch {
    return false;
  }
}
// hosts:end

// restore:start — a test seam; needs `markers:start` and `hosts:start` in scope.
/**
 * Has this origin been launched as a Home Screen (standalone) app? Then the same-origin
 * shell is served cache-first/stale-while-revalidate, so a flaky or absent connection (a
 * field iPad) never blocks launch.
 *
 * **This was in-memory only, re-announced by the page each load, and that was the
 * "PWA hangs at Starting…" bug (2026-11-10).** The announcement travels
 * page → worker, and the page can only make it once `core/offline.js` has loaded — which
 * is itself one of the module fetches the flag was supposed to serve from cache. So on
 * every cold launch of the installed app the flag was `false` for the whole of boot, and
 * the cache-first path written for exactly that moment could never engage. The shell went
 * to the network instead, one unbounded request per module, on the cold radio of a phone
 * that has just been woken — and a fetch that never settles is a module that never
 * arrives, so `import { boot }` never resolved and the static shell sat at its initial
 * "Starting…" with no launcher and no error. Force-quitting worked because the second
 * launch had a warm radio.
 *
 * It is now persisted like every other decision the worker has to remember, per the rule
 * stated at {@link MARKER_PREFIX}: a worker is killed and respawned freely — and replaced
 * outright on every deploy — so this cannot live in a variable alone. Restored before the
 * first fetch is answered ({@link restoreSettings}), which is the whole point.
 */
let standalone = false;

/**
 * Re-read the decisions that must outlive this worker instance.
 *
 * Three of them — the offline opt-in, the deployment's runtime hosts, and {@link
 * standalone} — were being restored in `activate` alone. That covers a worker *version*
 * change and nothing else: **`activate` does not re-run when an idle worker is respawned**,
 * which iOS does aggressively, so a respawned worker answered fetches with all three back
 * at their defaults. For the first two that only means "slower"; for `standalone` it meant
 * the hang above.
 *
 * Memoised, so this costs one cache open per worker instance, and awaited at the top of
 * {@link handleFetch} rather than hooked to a lifecycle event that may never fire again.
 *
 * It never *un-does* an announcement: a restore that loses a race with a `set-standalone`
 * message must not reset the flag it just set, so each value can only be turned on here,
 * never off. The one thing it cannot survive is a {@link CACHE} version bump, which drops
 * the markers along with the payloads — but that also empties the shell cache, so there is
 * nothing for `standalone` to serve from that launch anyway. The bounded fetch below is
 * what covers that case.
 */
/**
 * The same-origin files a real launch needed, accumulated across launches. Persisted for
 * the same reason as everything else here — a worker does not outlive its own decisions.
 * See {@link topUpShell}.
 */
let shellManifest = [];

let restored = null;
function restoreSettings() {
  restored ??= (async () => {
    try {
      const c = await caches.open(CACHE);
      offlineEnabled = offlineEnabled || !!(await c.match(OFFLINE_MARKER));
      standalone = standalone || !!(await c.match(STANDALONE_MARKER));
      if (!extraRuntimeHosts.length) {
        const saved = await c.match(HOSTS_MARKER);
        if (saved) extraRuntimeHosts = sanitizeHosts(await saved.json().catch(() => []));
      }
      if (!shellManifest.length) {
        const saved = await c.match(SHELL_MARKER);
        if (saved) shellManifest = sanitizeShellUrls(await saved.json().catch(() => []));
      }
    } catch {
      /* Cache API unavailable — the defaults stand */
    }
  })();
  return restored;
}
// restore:end

// shell:start — a test seam; needs `markers:start` in scope.
/** A boot graph is ~130 files. The cap is a backstop against a malformed announcement, not
 *  a budget — a legitimate list never comes close. */
const SHELL_MANIFEST_MAX = 600;
/** Top-ups run one at a time: the point is to fill gaps quietly in the background, not to
 *  open 130 connections on a phone that has just finished booting. */
const TOP_UP_CONCURRENCY = 1;
/** Give up after this many consecutive failures. A network that has started refusing will
 *  not be talked round by request 97, and hammering it is how a background task becomes a
 *  foreground problem. */
const TOP_UP_GIVE_UP_AFTER = 3;

/**
 * Keep only what is genuinely ours to cache.
 *
 * The page is trusted (same origin, our own code) but the message channel is not a
 * capability: any script on the origin can post to the worker. So this re-derives the
 * STRUCTURAL rules rather than believing the sender — absolute URL, same origin as the
 * worker, no query or hash (a key nothing will ask for again is pure waste), sane count.
 *
 * What it deliberately does NOT re-derive is *which file kinds* belong to the shell. That
 * list lives in `core/offline.js` and stays there, for the reason set out above
 * {@link extraRuntimeHosts}: a second copy of one rule is the exact shape that shipped
 * three separate bugs in a week, and it would buy nothing here — the only sender that can
 * reach this channel is already running on the origin, where it could read anything it
 * wanted to cache. The structural rules are what keep a bad message from turning into a
 * cross-origin download or an unbounded cache.
 */
function sanitizeShellUrls(list, origin = self.location.origin) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '');
    if (!s || s.length > 2048) continue;
    let u;
    try {
      // Absolute only — deliberately NO base. Resolving against the origin would turn any
      // junk in a malformed message ("not a url", a number) into a plausible same-origin
      // path, which then costs a real request and a 404 on every launch until the prune
      // catches it. The page always announces absolute URLs, so nothing legitimate is lost.
      u = new URL(s);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue; // never a cross-origin payload, whatever was asked
    if (u.search || u.hash) continue;
    const clean = u.origin + u.pathname;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= SHELL_MANIFEST_MAX) break;
  }
  return out;
}

/**
 * Cache the shell files this origin needs but has never been asked for.
 *
 * **The gap.** The shell caches as it is served, which misses precisely the files fetched
 * before a worker controlled the page — and on a first visit that is the document plus the
 * modules `core/app.js` imports directly: the most boot-critical slice of the graph.
 * Measured on a cold profile, one launch cached 36 of `core/` and three cached 128. They
 * arrive on the second launch anyway, so this only ever bit install-then-go-offline — but
 * that is the sequence an installed app exists for.
 *
 * **Why a list from the page rather than a list in this file.** `SHELL_PRECACHE` is
 * hand-written, and a hand-written boot graph rots silently on the next import change —
 * worse than no list, because it looks complete. The page has `performance`'s exact record
 * of what it loaded, including everything fetched before this worker existed, which is the
 * one thing a worker can never reconstruct. Same division of labour as the deployment's
 * runtime hosts: the page knows, the worker persists and acts.
 *
 * **Never during install, never blocking a boot.** The page announces once it is idle with
 * the launcher up, so a top-up only runs on a connection that has just demonstrably
 * worked. Adding requests during boot is half of what made the 2026-11-10 hang a hang, and
 * precaching this list on `install` would recreate that at thirteen times the size. The
 * cost of that choice: a {@link CACHE} version bump empties the cache, and the shell is
 * refilled by the launch after the next one rather than immediately.
 *
 * Entries that 404 are dropped from the manifest rather than retried every launch, so a
 * module deleted in a refactor cleans itself out of the list.
 */
async function topUpShell(urls, { timeoutMs = SHELL_HEADERS_TIMEOUT_MS } = {}) {
  let cache;
  try {
    cache = await caches.open(CACHE);
  } catch {
    return { added: 0, dropped: [] };
  }
  const dropped = [];
  let added = 0;
  let consecutiveFailures = 0;
  for (const url of urls) {
    if (consecutiveFailures >= TOP_UP_GIVE_UP_AFTER) break;
    try {
      if (await cache.match(url)) continue; // already held — the common case
      const res = await withDeadline(fetch(new Request(url, { cache: 'no-cache' })), timeoutMs);
      if (res.status === 404 || res.status === 410) {
        dropped.push(url); // gone for good; stop carrying it
        consecutiveFailures = 0;
        continue;
      }
      if (!res.ok || res.type === 'opaque') {
        consecutiveFailures++;
        continue;
      }
      await cache.put(url, withIsolation(res));
      added++;
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
    }
  }
  return { added, dropped };
}
// shell:end

if (typeof window === 'undefined') {
  // ---- Running as the service worker ----------------------------------------
  self.addEventListener('install', (event) => {
    self.skipWaiting();
    // Precache-on-install (#92): seed the cache with the critical boot shell so the
    // app opens offline even before any cache-on-use has run. `reload` so a new SW
    // (shipped on each deploy) refreshes these rather than reusing the HTTP cache.
    event.waitUntil(
      caches.open(CACHE).then((c) =>
        Promise.allSettled(
          SHELL_PRECACHE.map(async (u) => {
            try {
              const res = await fetch(new Request(u, { cache: 'reload' }));
              if (res.ok && res.type !== 'opaque') await c.put(u, withIsolation(res));
            } catch {
              /* a missing/uncacheable entry must never fail the install */
            }
          }),
        ),
      ),
    );
  });
  self.addEventListener('activate', (event) =>
    event.waitUntil(
      (async () => {
        await self.clients.claim(); // control existing tabs without a reload
        try {
          // Drop superseded cache versions so a shell bump (new CACHE name) fully
          // re-precaches the app shell — incl. the plugin sandbox host docs — instead
          // of serving a stale precached copy. Costs a one-time re-download of cached
          // runtimes, which is the correct trade for guaranteed-fresh shell code.
          for (const k of await caches.keys()) {
            if (k !== CACHE && k.startsWith('crosstab-offline-')) await caches.delete(k);
          }
          // The offline opt-in, the deployment's extra runtime hosts and whether this is
          // an installed app — all from the last page that announced them, and all
          // restored BEFORE any fetch is handled, which is the point of persisting them.
          // `handleFetch` awaits the same memoised read, so a respawned worker (where
          // this listener never runs again) is covered too.
          await restoreSettings();
        } catch {
          /* Cache API unavailable */
        }
      })(),
    ),
  );

  self.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;
    const reply = (msg) => ev.ports?.[0]?.postMessage(msg);

    if (d.type === 'deregister') {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (d.type === 'coepCredentialless') {
      coepCredentialless = d.value;
    } else if (d.type === 'set-standalone') {
      standalone = !!d.value;
      // Persisted, not just held: the page cannot announce this until its module graph has
      // loaded, so a flag that lived only in memory was always false for the launch it
      // existed to serve. See {@link standalone}.
      ev.waitUntil(
        (async () => {
          try {
            const c = await caches.open(CACHE);
            if (standalone) await c.put(STANDALONE_MARKER, new Response('1'));
            else await c.delete(STANDALONE_MARKER);
          } catch {
            /* Cache API unavailable — this launch still works, the next is just slower */
          }
        })(),
      );
    } else if (d.type === 'announce-shell') {
      // Merge rather than replace: different launches load different parts of the app, and
      // a launch that only reached the launcher must not shrink a manifest that a longer
      // session had filled out. The merge is capped, and a 404 during top-up is what prunes
      // it, so it converges rather than growing for ever.
      ev.waitUntil(
        (async () => {
          try {
            await restoreSettings();
            const announced = sanitizeShellUrls(d.urls);
            if (!announced.length) {
              reply({ ok: true, added: 0, known: shellManifest.length });
              return;
            }
            const merged = sanitizeShellUrls([...shellManifest, ...announced]);
            const { added, dropped } = await topUpShell(merged);
            shellManifest = dropped.length ? merged.filter((u) => !dropped.includes(u)) : merged;
            const c = await caches.open(CACHE);
            await c.put(SHELL_MARKER, new Response(JSON.stringify(shellManifest)));
            reply({ ok: true, added, known: shellManifest.length, dropped: dropped.length });
          } catch (e) {
            reply({ ok: false, error: String(e) });
          }
        })(),
      );
    } else if (d.type === 'set-runtime-hosts') {
      // Additive and idempotent: every page load re-announces, and announcing nothing
      // leaves the built-in CDN hosts exactly as they are.
      extraRuntimeHosts = sanitizeHosts(d.hosts);
      ev.waitUntil(
        (async () => {
          try {
            const c = await caches.open(CACHE);
            if (extraRuntimeHosts.length) {
              await c.put(HOSTS_MARKER, new Response(JSON.stringify(extraRuntimeHosts)));
            } else {
              // A deployment that REMOVED its mirror must not keep caching from it.
              await c.delete(HOSTS_MARKER);
            }
            reply({ ok: true, hosts: extraRuntimeHosts });
          } catch (e) {
            reply({ ok: false, error: String(e) });
          }
        })(),
      );
    } else if (d.type === 'offline-enable') {
      offlineEnabled = true;
      ev.waitUntil(
        (async () => {
          try {
            const c = await caches.open(CACHE);
            await c.put(OFFLINE_MARKER, new Response('1'));
            reply({ ok: true });
          } catch (e) {
            reply({ ok: false, error: String(e) });
          }
        })(),
      );
    } else if (d.type === 'offline-disable') {
      offlineEnabled = false;
      ev.waitUntil(caches.delete(CACHE).then(() => reply({ ok: true })));
    } else if (d.type === 'refresh-shell') {
      // Force-refresh the cached same-origin app shell from the network (#: "Check
      // for updates"). An installed PWA serves the shell cache-first, so an app-code
      // deploy (which doesn't change sw.js → no new worker) would otherwise never
      // reach the device. Re-fetch every cached same-origin entry with cache:'reload'
      // and replace it; leave the big cross-origin runtime entries alone. Reply with
      // how many entries were refreshed so the page can decide whether to reload.
      ev.waitUntil(
        (async () => {
          let updated = 0;
          try {
            const c = await caches.open(CACHE);
            const keys = await c.keys();
            await Promise.allSettled(
              keys.map(async (req) => {
                if (isMarker(req.url)) return;
                let same = false;
                try { same = new URL(req.url).origin === self.location.origin; } catch { /* opaque */ }
                if (!same) return; // app shell only
                try {
                  const res = await fetch(new Request(req.url, { cache: 'reload' }));
                  if (res.ok && res.type !== 'opaque') { await c.put(req, withIsolation(res)); updated++; }
                } catch { /* offline / transient — keep the existing entry */ }
              }),
            );
            reply({ ok: true, updated });
          } catch (e) {
            reply({ ok: false, error: String(e) });
          }
        })(),
      );
    } else if (d.type === 'offline-status') {
      ev.waitUntil(
        (async () => {
          let count = 0;
          let bytes = 0;
          try {
            const c = await caches.open(CACHE);
            for (const req of await c.keys()) {
              if (isMarker(req.url)) continue;
              count++;
              // Sum Content-Length from headers only (cheap — no body reads), so a
              // status check stays fast even with ~100 MB cached.
              const resp = await c.match(req);
              const len = Number(resp?.headers.get('content-length') || 0);
              if (len) bytes += len;
            }
          } catch {
            /* ignore */
          }
          reply({ enabled: offlineEnabled, count, bytes });
        })(),
      );
    }
  });

  self.addEventListener('fetch', (event) => {
    const r = event.request;
    // Don't touch range/cache-only cross-origin requests.
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    event.respondWith(handleFetch(r));
  });
} else {
  // ---- Running as a page script: register ourselves -------------------------
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
    window.sessionStorage.removeItem('coiReloadedBySelf');
    const coepDegrading = reloadedBySelf === 'coepdegrade';

    const n = navigator;
    if (!window.isSecureContext) {
      console.warn('COI service worker: not a secure context; SharedArrayBuffer unavailable.');
      return;
    }
    if (!n.serviceWorker) {
      console.warn('COI service worker: serviceWorker API unavailable.');
      return;
    }

    // Already isolated (real headers from the host)? Then we don't need the
    // reload-to-isolate dance — but we STILL register, so the offline cache can
    // work. clients.claim() (above) gives the worker control without a reload.
    const alreadyIsolated = window.crossOriginIsolated !== false || coepDegrading;

    n.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        // A genuine UPDATE to an already-running app → reload to pick up fresh code.
        // Guard on an existing controller so this does NOT fire on the very first
        // install (that case is the isolate-reload below, not an app update).
        //
        // **When** this reloads was the third ingredient in the "PWA hangs at Starting…"
        // bug (2026-11-10), and it is why the hang correlated with having missed several
        // updates. `updatefound` fires the instant a new worker begins INSTALLING — so the
        // old code reloaded the page while that worker was precaching eight entries with
        // `cache: 'reload'` (forced network), on the cold radio of a just-woken phone,
        // discarding a boot that was already in flight and starting a fresh one into the
        // same contention. The more deploys had accumulated, the likelier a launch landed
        // in that window.
        //
        // Now it waits for the new worker to be ACTIVATED — `skipWaiting()` means that
        // follows install closely, so a deploy still lands on this launch rather than
        // after a force-quit, which is the property the proactive check below exists for —
        // and then waits for the document to finish loading before pulling it out from
        // under itself. The session flag makes it at most one update-reload per load-cycle
        // (it is read and cleared at the top of every load), so a worker that re-announces
        // cannot start a reload loop.
        registration.addEventListener('updatefound', () => {
          const fresh = registration.installing;
          if (!fresh || !n.serviceWorker.controller) return; // first install → isolate path
          fresh.addEventListener('statechange', () => {
            if (fresh.state !== 'activated') return;
            if (window.sessionStorage.getItem('coiReloadedBySelf')) return; // once per cycle
            window.sessionStorage.setItem('coiReloadedBySelf', 'update');
            // Never yank a boot that is still in progress. If it never completes we simply
            // do not reload — the update waits for the next launch, which is strictly
            // better than restarting a load that is already struggling.
            if (document.readyState === 'complete') window.location.reload();
            else window.addEventListener('load', () => window.location.reload(), { once: true });
          });
        });

        // Proactively check for a new worker whenever the tab regains focus (and once
        // now). iOS Safari won't re-check a controlled tab on its own, so without this
        // a deploy isn't picked up until the tab is fully closed — the "had to kill the
        // tab" bug. `updatefound` above then reloads into the new version automatically.
        const checkForUpdate = () => { registration.update().catch(() => {}); };
        window.addEventListener('focus', checkForUpdate);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
        checkForUpdate();

        if (alreadyIsolated) return; // host sent real COI headers — no dance needed

        // We're not isolated yet. The header-injecting worker only affects the
        // navigations it CONTROLS, so the first visit (document fetched before the
        // worker took control) must reload once the worker is controlling — the
        // reloaded navigation then gets the injected COOP/COEP. The session flag
        // makes this fire at most once per load-cycle, so a context that genuinely
        // can't isolate (no SharedArrayBuffer) reloads once and then stops — no loop.
        if (reloadedBySelf === 'isolate') return; // already tried this cycle — don't loop
        const reloadToIsolate = () => {
          window.sessionStorage.setItem('coiReloadedBySelf', 'isolate');
          window.location.reload();
        };
        if (n.serviceWorker.controller) {
          // The worker already controls this page but it loaded un-isolated (it
          // claimed us via clients.claim() AFTER the document was fetched) — reload
          // now to pick up the headers. (The previous check required
          // registration.active && !controller, which a fast first-visit claim never
          // satisfied, so the first page-view stayed non-isolated.)
          reloadToIsolate();
        } else {
          // True first visit, worker still installing: reload the moment it takes
          // control (`controllerchange`, fired by clients.claim() after activation).
          n.serviceWorker.addEventListener('controllerchange', reloadToIsolate, { once: true });
        }
      },
      (err) => console.error('COI service worker registration failed:', err),
    );
  })();
}

/**
 * Serve a request: COEP header rewrite always; cache-first for already-cached
 * cross-origin runtime/packages (fast + offline); network-first for the
 * same-origin app shell (fresh when online); and a cache fallback when the
 * network is gone. Successful GETs are cached while offline mode is on.
 */
async function handleFetch(r) {
  // Before anything is routed: a respawned worker has none of its remembered decisions,
  // and the most important of them decides this very request's path. Memoised — one cache
  // open per worker instance, not per request.
  await restoreSettings();
  const isGet = r.method === 'GET';
  // Only a TOP-LEVEL document navigation should fall back to the index shell. A
  // nested navigation (a plugin sandbox <iframe> loading plugin-host.html) must
  // resolve to its own cached document, never index.html — else the sandbox boots
  // the whole app and never signals ready.
  const isTopNav = r.mode === 'navigate' && r.destination === 'document'
    && !isStandaloneDoc(r.url); // a page that is not the app must resolve to itself
  let sameOrigin = true;
  try {
    sameOrigin = new URL(r.url).origin === self.location.origin;
  } catch {
    /* opaque URL — treat as same-origin (won't be cached anyway) */
  }

  // Tier 2 — cross-origin runtimes + R packages: cache-first whenever cached. The
  // known runtime hosts cache automatically (cached as used); opting in additionally
  // pre-fetches unused packages. Either way a cache hit avoids a multi-MB
  // re-download and lets the app run offline.
  if (isGet && !sameOrigin && (offlineEnabled || isRuntimeAsset(r.url))) {
    const hit = await caches.match(r);
    if (hit) return hit;
  }

  // Tier 1 — serve the same-origin app shell cache-first + background revalidate
  // when the app is **installed (standalone)** OR the device is **offline**. This
  // makes a cold offline boot fast: otherwise every same-origin file (the module
  // graph + ~17 plugin sources) would each wait on a failed network request first,
  // turning a launch into tens of seconds. An online tab falls through to
  // network-first below, staying fresh. A *navigation* (e.g. `/?launch=…`) maps to
  // the cached index document — its query would otherwise miss the cache key.
  if (isGet && sameOrigin && (standalone || !self.navigator.onLine)) {
    // A standalone doc is matched ignoring its query: the OAuth callback arrives as
    // `oauth-callback.html?code=…`, and keying on that would miss the cache every time
    // while filling it with one entry per sign-in.
    const hit = isTopNav
      ? await matchShell()
      : await caches.match(r, isStandaloneDoc(r.url) ? { ignoreSearch: true } : undefined);
    if (hit) {
      networkAndCache(r, isGet, sameOrigin).catch(() => {}); // background revalidate
      return hit;
    }
  }

  // Network (with COEP rewrite + cache-on-use); fall back to cache when offline.
  try {
    return await networkAndCache(r, isGet, sameOrigin);
  } catch (err) {
    const hit = await caches.match(r);
    if (hit) return hit;
    // Offline navigation fallback: any in-app top-level URL boots from the cached
    // shell document, so the app opens with no connection regardless of path/query.
    if (isTopNav) {
      const shell = await matchShell();
      if (shell) return shell;
    }
    throw err;
  }
}

/** The cached shell document (for navigation fallback) — index.html, or the root. */
async function matchShell() {
  return (
    (await caches.match('index.html')) ||
    (await caches.match('./')) ||
    (await caches.match(new URL('index.html', self.location.href).href)) ||
    null
  );
}

/**
 * How long a same-origin shell request may take to produce RESPONSE HEADERS before the
 * worker gives up on the network and falls back to the cache.
 *
 * This is the second half of the "PWA hangs at Starting…" fix, and the direct descendant
 * of the 5s bound put on `deploy.json` in October (`core/deploy-config.js`): a `try/catch`
 * covers a fetch that REJECTS and does nothing whatsoever for one that never SETTLES.
 * `event.respondWith()` on a promise that never settles is a subresource that never
 * arrives — and a module that never arrives is a boot that cannot start, fail, or report
 * anything, because the shell the user is staring at is static HTML.
 *
 * 8s: longer than any healthy same-origin file takes even on a bad link, short enough that
 * a wedged request becomes a cached boot (or at worst a visible "Failed to start: …")
 * rather than an indefinite stare at the status line.
 */
// deadline:start — a test seam.
const SHELL_HEADERS_TIMEOUT_MS = 8000;

/**
 * The deadline covers the HEADERS, not the body — and that distinction is the reason there
 * is no `AbortSignal` here.
 *
 * `fetch()` resolves as soon as the response head arrives; the body streams afterwards. So
 * racing the returned promise bounds exactly the phase that hangs (connect + first byte)
 * and cannot truncate a download that is slow but progressing. An `AbortSignal.timeout`
 * would apply to the whole request including the body, which in a vendored air-gapped
 * build — where the WebR/DuckDB runtimes are same-origin `./vendor/` files of tens of
 * megabytes — would abort a perfectly healthy transfer over a slow LAN and leave the user
 * with a runtime that never finishes downloading. Trading a rare hang for a guaranteed one
 * is not a fix.
 *
 * The cost of racing rather than aborting: a wedged request is abandoned, not cancelled. It
 * holds its connection until the platform times it out on its own. That is a real cost on
 * iOS's small per-host connection pool, and it is still much the better end of the trade —
 * the alternative is the connection being held by a request nobody has given up on either.
 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`network stalled after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
// deadline:end

/** Fetch with the COEP header rewrite, caching the result. The same-origin app
 * shell is cached AUTOMATICALLY (tier 1, #92); cross-origin runtimes/packages cache
 * only when "Make available offline" is on (tier 2). Returns the rewritten response;
 * throws if the network fails (so the caller can fall back to cache). */
async function networkAndCache(r, isGet, sameOrigin) {
  let request = r;
  if (coepCredentialless && r.mode === 'no-cors') {
    request = new Request(r, { credentials: 'omit' });
  } else if (sameOrigin && isGet) {
    // Revalidate same-origin app files against the server so a deploy propagates —
    // otherwise the HTTP cache could hand the network-first path a stale module and
    // we'd cache + serve old app code. `no-cache` = conditional GET (304 when
    // unchanged, fresh body when changed); offline it just throws → cache fallback.
    try {
      request = new Request(r, { cache: 'no-cache' });
    } catch {
      /* some requests can't be reconstructed (rare) — use the original */
    }
  }
  // Same-origin GETs are the boot path (the module graph, the shell documents, the plugin
  // sources) and they are the ones that must never hang — see SHELL_HEADERS_TIMEOUT_MS.
  // Everything else (cross-origin runtimes, non-GET) keeps the plain unbounded fetch: it is
  // not on the path to the launcher, and WebR's preload failure is already caught upstream.
  const hit = sameOrigin && isGet
    ? withDeadline(fetch(request), SHELL_HEADERS_TIMEOUT_MS)
    : fetch(request);
  const response = await hit;
  if (response.status === 0) return response; // opaque; leave as-is (can't rewrite)

  // Cache the *rewritten* response (with CORP), so a later offline serve still
  // satisfies cross-origin isolation. Same-origin shell + known runtime hosts cache
  // AUTOMATICALLY (as used); opting in additionally caches any other cross-origin
  // (the pre-fetched package closure).
  // Never cache a URL whose query carries the answer to a sign-in. The authorization
  // code is single-use and useless without a PKCE verifier the cache has never seen, so
  // this is not a breach — but writing a credential fragment to disk as a CACHE KEY,
  // once per sign-in, forever, is not something to do by accident either.
  const isOauthReturn = isStandaloneDoc(r.url) && new URL(r.url).search;
  if (
    isGet &&
    response.ok &&
    response.type !== 'opaque' &&
    !isOauthReturn &&
    (sameOrigin || isRuntimeAsset(r.url) || offlineEnabled)
  ) {
    const forCache = withIsolation(response.clone());
    caches.open(CACHE).then((c) => c.put(r, forCache)).catch(() => {});
  }

  return withIsolation(response);
}

/** Re-clothe a response with the cross-origin-isolation headers so it satisfies COI
 * whether served live or from cache. Opaque responses can't be rewritten. */
function withIsolation(response) {
  if (response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
  if (!coepCredentialless) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
