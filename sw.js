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
 *       - **Runtimes + R packages (cross-origin on CDN): OPT-IN.** The big WebR /
 *         DuckDB / Arrow / hyparquet downloads + the R-package closure cache only
 *         when the user turns on "Make available offline" (see core/offline.js) —
 *         too large to force. In the air-gapped build these runtimes are *same-origin*
 *         (`./vendor/`), so the shell rule caches them automatically there too.
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

const CACHE = 'crosstab-offline-v1';
// A synthetic key (never a real request) that marks "offline caching is on".
const OFFLINE_MARKER = 'https://crosstab.local/__offline_enabled__';
// Tier-1 caching (the app shell) is automatic — the OPT-IN marker now only gates
// tier-2 (the big cross-origin runtimes + R packages).
let offlineEnabled = false;
// The minimal critical shell precached on install, so the app can boot offline even
// from a cold install (the rest of the same-origin module graph fills cache-on-use
// on first load). Resolved against the SW's scope. Kept short + resilient: a missing
// entry never fails the install.
const SHELL_PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  'core/app.js',
  'vendor/icon-192.png',
  'vendor/icon-180.png',
];
// Set by the page when running as a Home Screen (standalone) app — then the
// same-origin shell is served cache-first/stale-while-revalidate so a flaky or
// absent connection (a field iPad) never blocks launch. In-memory; the page
// re-announces it each load.
let standalone = false;

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
          const c = await caches.open(CACHE);
          offlineEnabled = !!(await c.match(OFFLINE_MARKER));
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
    } else if (d.type === 'offline-status') {
      ev.waitUntil(
        (async () => {
          let count = 0;
          let bytes = 0;
          try {
            const c = await caches.open(CACHE);
            for (const req of await c.keys()) {
              if (req.url === OFFLINE_MARKER) continue;
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
        registration.addEventListener('updatefound', () => window.location.reload());
        // Reload once only to GAIN isolation we don't yet have (header injection).
        if (!alreadyIsolated && registration.active && !n.serviceWorker.controller) {
          window.location.reload();
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
  const isGet = r.method === 'GET';
  const isNav = r.mode === 'navigate';
  let sameOrigin = true;
  try {
    sameOrigin = new URL(r.url).origin === self.location.origin;
  } catch {
    /* opaque URL — treat as same-origin (won't be cached anyway) */
  }

  // Tier 2 — opted-in cross-origin runtimes + R packages: cache-first. They're
  // versioned by URL, so a hit is always valid and avoids a multi-MB re-download.
  if (offlineEnabled && isGet && !sameOrigin) {
    const hit = await caches.match(r);
    if (hit) return hit;
  }

  // Tier 1 — an installed (standalone) app serves the same-origin app shell
  // cache-first + background revalidate, so a flaky or absent connection (a field
  // iPad, a desktop PWA offline) never blocks launch. Ungated: the shell is cached
  // automatically (#92). A tab falls through to network-first below, staying fresh.
  // A *navigation* (e.g. `/?launch=…`) maps to the cached index document — its query
  // would otherwise miss the cache key.
  if (isGet && sameOrigin && standalone) {
    const hit = isNav ? await matchShell() : await caches.match(r);
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
    // Offline navigation fallback: any in-app URL boots from the cached shell
    // document, so the app opens with no connection regardless of the path/query.
    if (isNav) {
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

/** Fetch with the COEP header rewrite, caching the result. The same-origin app
 * shell is cached AUTOMATICALLY (tier 1, #92); cross-origin runtimes/packages cache
 * only when "Make available offline" is on (tier 2). Returns the rewritten response;
 * throws if the network fails (so the caller can fall back to cache). */
async function networkAndCache(r, isGet, sameOrigin) {
  const request =
    coepCredentialless && r.mode === 'no-cors' ? new Request(r, { credentials: 'omit' }) : r;
  const response = await fetch(request);
  if (response.status === 0) return response; // opaque; leave as-is (can't rewrite)

  // Cache the *rewritten* response (with CORP), so a later offline serve still
  // satisfies cross-origin isolation.
  if (isGet && response.ok && response.type !== 'opaque' && (sameOrigin || offlineEnabled)) {
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
