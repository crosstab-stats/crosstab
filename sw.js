/*!
 * sw.js — Cross-Origin-Isolation service worker (coi-serviceworker pattern).
 *
 * WebR's fast, multi-threaded path and `SharedArrayBuffer` require the page to
 * be "cross-origin isolated", which the browser only grants when the document
 * is served with:
 *     Cross-Origin-Opener-Policy:  same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *
 * On static hosts where we cannot set response headers (GitHub Pages, local
 * `python -m http.server`), this service worker injects those headers on the
 * fly. In PRODUCTION (Cloudflare Pages) set the headers at the edge with a
 * `_headers` file and this worker becomes a harmless no-op fallback.
 *
 * This file is loaded TWO ways, and behaves differently in each:
 *   1. As a normal page `<script src="sw.js">` — runs the `else` branch below,
 *      which registers *itself* as the service worker and reloads once so the
 *      controlled page gets the isolation headers.
 *   2. As the service worker — runs the `if` branch, rewriting responses.
 *
 * Derived from coi-serviceworker by Guido Zuidhof and contributors (MIT).
 * TODO: fold in PWA precaching here once we vendor WebR assets for offline use.
 */

/* global self */
let coepCredentialless = false;

if (typeof window === 'undefined') {
  // ---- Running as the service worker ----------------------------------------
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'deregister') {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === 'coepCredentialless') {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener('fetch', (event) => {
    const r = event.request;
    // Don't touch range/cache-only cross-origin requests.
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

    const request =
      coepCredentialless && r.mode === 'no-cors'
        ? new Request(r, { credentials: 'omit' })
        : r;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response; // opaque; leave as-is
          const headers = new Headers(response.headers);
          headers.set(
            'Cross-Origin-Embedder-Policy',
            coepCredentialless ? 'credentialless' : 'require-corp',
          );
          if (!coepCredentialless) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch((e) => console.error(e)),
    );
  });
} else {
  // ---- Running as a page script: register ourselves -------------------------
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
    window.sessionStorage.removeItem('coiReloadedBySelf');
    const coepDegrading = reloadedBySelf === 'coepdegrade';

    const n = navigator;
    // Already isolated (e.g. real headers from Cloudflare): nothing to do.
    if (window.crossOriginIsolated !== false || coepDegrading) return;
    if (!window.isSecureContext) {
      console.warn('COI service worker: not a secure context; SharedArrayBuffer unavailable.');
      return;
    }
    if (!n.serviceWorker) {
      console.warn('COI service worker: serviceWorker API unavailable.');
      return;
    }

    n.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        registration.addEventListener('updatefound', () => window.location.reload());
        // If we already control the page but aren't isolated, force a reload.
        if (registration.active && !n.serviceWorker.controller) window.location.reload();
      },
      (err) => console.error('COI service worker registration failed:', err),
    );
  })();
}
