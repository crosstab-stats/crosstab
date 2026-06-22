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
 *  2. **Offline cache (opt-in).** When the user turns on "Make available offline"
 *     (see core/offline.js), this worker caches every successful GET it serves —
 *     the app shell, the WASM runtimes (WebR, DuckDB, Arrow, hyparquet) and the R
 *     packages — then serves them from cache when the network is gone. That's the
 *     "download once, then work on a flight" path for the installed PWA. The spike
 *     confirmed the CDN runtimes return CORS (non-opaque) responses, so they cache
 *     and re-serve cleanly even under cross-origin isolation.
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
let offlineEnabled = false;

if (typeof window === 'undefined') {
  // ---- Running as the service worker ----------------------------------------
  self.addEventListener('install', () => self.skipWaiting());
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
  let sameOrigin = true;
  try {
    sameOrigin = new URL(r.url).origin === self.location.origin;
  } catch {
    /* opaque URL — treat as same-origin (won't be cached anyway) */
  }

  // Cache-first for immutable cross-origin assets (the WASM runtimes + R
  // packages): they're versioned by URL, so a hit is always valid and avoids a
  // multi-MB re-download.
  if (offlineEnabled && isGet && !sameOrigin) {
    const hit = await caches.match(r);
    if (hit) return hit;
  }

  const request =
    coepCredentialless && r.mode === 'no-cors' ? new Request(r, { credentials: 'omit' }) : r;

  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    // Network gone — fall back to whatever we cached (covers the app shell too).
    const hit = await caches.match(r);
    if (hit) return hit;
    throw err;
  }

  if (response.status === 0) return response; // opaque; leave as-is (can't rewrite)

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
  if (!coepCredentialless) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  const init = { status: response.status, statusText: response.statusText, headers };

  // Cache successful GETs (cache-on-use) so this session's assets are available
  // offline. We cache the *rewritten* response (with CORP), so a later offline
  // serve still satisfies cross-origin isolation.
  if (offlineEnabled && isGet && response.ok && response.type !== 'opaque') {
    const forCache = new Response(response.clone().body, init);
    caches.open(CACHE).then((c) => c.put(r, forCache)).catch(() => {});
  }

  return new Response(response.body, init);
}
