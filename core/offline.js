/**
 * @file offline.js
 * The page side of "Make available offline" — the installed-PWA path to working
 * with no network (e.g. on a flight). The {@link ./sw.js} service worker does the
 * caching; this drives it: turn caching on, then *warm the runtimes* so their
 * assets flow through the worker and get cached, and report status. Distinct from
 * the air-gapped build ({@link ./assets.js} local mode + docs/OFFLINE.md), which
 * vendors assets at deploy time; this is a one-click runtime opt-in for a normal
 * CDN-hosted install.
 *
 * State lives in the Cache itself (a marker entry) and is read directly from the
 * page via the Cache API — so status never depends on the service worker being
 * reachable. The SW only needs to (a) hydrate "on" from the marker at activation
 * and (b) cache responses while on.
 *
 * Control caveat: a freshly-installed SW is `active` but doesn't control the page
 * that registered it until one reload — and on hosts that already send the
 * isolation headers, the COI shim's reload is skipped, so `clients.claim()` is the
 * only thing that would grab control, and it's unreliable for the current load. So
 * the *first* enable does one reload to gain control, then resumes automatically.
 *
 * Phase 1 (this): app shell + the WASM runtimes (WebR, DuckDB) + the data bridge
 * (nanoparquet); other R packages cache as you use them. Phase 2 will add a
 * guaranteed R-package closure prefetch + richer progress UI.
 */

const SW_URL = 'sw.js';
const CACHE = 'crosstab-offline-v1';
// Must match sw.js OFFLINE_MARKER.
const MARKER = 'https://crosstab.local/__offline_enabled__';
// Survives the one control-gaining reload, so we resume the warm afterwards.
const RESUME_KEY = 'crosstab.offline.resume';

export class OfflineManager {
  #webr;
  #duckdb;

  /**
   * @param {object} deps
   * @param {import('./webr-manager.js').WebRManager} deps.webr
   * @param {import('./duckdb-manager.js').DuckDBManager} deps.duckdb
   */
  constructor({ webr, duckdb }) {
    this.#webr = webr;
    this.#duckdb = duckdb;
  }

  /** Whether the browser can do this at all (SW + Cache API). */
  get supported() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'caches' in self;
  }

  /** Read state straight from the Cache API (no SW round-trip needed):
   * `{ supported, controlled, enabled, count, bytes }`. */
  async status() {
    if (!this.supported) return { supported: false, controlled: false, enabled: false, count: 0, bytes: 0 };
    let enabled = false;
    let count = 0;
    let bytes = 0;
    try {
      const c = await caches.open(CACHE);
      for (const req of await c.keys()) {
        if (req.url === MARKER) {
          enabled = true;
          continue;
        }
        count++;
        // Headers only (no body reads) so status stays fast with ~100 MB cached.
        const r = await c.match(req);
        const len = Number(r?.headers.get('content-length') || 0);
        if (len) bytes += len;
      }
    } catch {
      /* Cache API unavailable */
    }
    return { supported: true, controlled: !!navigator.serviceWorker.controller, enabled, count, bytes };
  }

  /** True once a previous enable() reloaded to gain control — boot calls
   * resumeIfPending() to finish the warm. */
  get hasPendingResume() {
    try {
      return sessionStorage.getItem(RESUME_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Turn on offline caching and cache the app + runtimes. May reload once the very
   * first time (to put the page under SW control); the warm then resumes on boot.
   * @param {(text: string) => void} [onProgress]
   */
  async enable(onProgress = () => {}) {
    if (!this.supported) throw new Error('This browser can’t cache for offline use.');
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* best effort */
    }
    // Persist "on" now, so it survives a control-gaining reload and the SW hydrates
    // on at its next activation.
    await this.#setMarker();

    if (!navigator.serviceWorker.controller) {
      onProgress('Activating offline support — reloading once…');
      try {
        sessionStorage.setItem(RESUME_KEY, '1');
      } catch {
        /* no sessionStorage — the post-reload resume just won't auto-fire */
      }
      try {
        await navigator.serviceWorker.register(SW_URL);
        await navigator.serviceWorker.ready;
      } catch {
        /* may already be registered */
      }
      location.reload();
      return; // page navigates away
    }

    await this.#runWarm(onProgress);
  }

  /** If a prior enable() reloaded to gain control, finish caching now (boot calls
   * this). No-op otherwise. */
  async resumeIfPending(onProgress = () => {}) {
    if (!this.hasPendingResume) return;
    // Keep the flag until we actually have control + finish, so a reload that
    // didn't immediately yield control retries on the next load rather than
    // silently dropping the request.
    if (!navigator.serviceWorker.controller) return;
    try {
      await this.#runWarm(onProgress);
      sessionStorage.removeItem(RESUME_KEY);
    } catch (err) {
      console.warn('[offline] resume warm failed', err);
    }
  }

  /** Turn it off and drop the cache. */
  async disable() {
    try {
      await caches.delete(CACHE);
    } catch {
      /* ignore */
    }
    if (navigator.serviceWorker?.controller) {
      try {
        await this.#message('offline-disable');
      } catch {
        /* live flag clears on next load anyway */
      }
    }
  }

  // --- internals -------------------------------------------------------------

  /** Cache + warm everything once the page is under SW control. */
  async #runWarm(onProgress) {
    // Flip the live SW flag (the marker handles persistence across reloads, but the
    // already-running worker needs to be told to start caching this session).
    try {
      await this.#message('offline-enable');
    } catch {
      /* the marker is set; the SW will cache after its next activation regardless */
    }

    // 1) App shell — re-fetch the same-origin files this page loaded (now through
    // the controlling SW). Enumerated from resource timing, so no hardcoded list.
    onProgress('Caching the app…');
    await this.#cacheShell();

    // 2) WebR runtime (the big one). It already initialised this session, so a
    // plain preload() wouldn't re-fetch. Restart so its worker re-loads the runtime
    // through the SW. Clears installed R packages (re-installable) but keeps
    // datasets, projects and output — same as the out-of-memory restart.
    onProgress('Caching the R runtime (largest step)…');
    try {
      await this.#webr.restart();
    } catch {
      /* not started yet — fine */
    }
    await this.#webr.preload();
    onProgress('Caching the data bridge…');
    try {
      await this.#webr.installPackages(['nanoparquet']); // the host's data→R bridge
    } catch {
      /* non-fatal — caches on first real use */
    }

    // 3) Data engine.
    onProgress('Caching the data engine…');
    await this.#duckdb.preload();
    onProgress('Offline ready.');
  }

  /** Re-fetch the same-origin app shell so the SW caches it. The set is read from
   * resource timing (what this page actually loaded) plus the entry points, so it
   * tracks the real module graph without a maintained manifest. */
  async #cacheShell() {
    const urls = new Set();
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (e.name.startsWith(location.origin) && /\.(m?js|css|json|html|png|svg|woff2?)(\?|$)/.test(e.name)) {
          urls.add(e.name);
        }
      }
    } catch {
      /* performance API unavailable */
    }
    for (const u of ['index.html', 'manifest.json', 'sw.js']) urls.add(new URL(u, location.href).href);
    urls.add(location.href);
    // `cache: 'reload'` bypasses the HTTP cache so a real response flows through the
    // SW (and into the offline cache), not a 304.
    await Promise.all([...urls].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  }

  /** Write the "offline on" marker straight into the cache (page-side). */
  async #setMarker() {
    try {
      const c = await caches.open(CACHE);
      await c.put(MARKER, new Response('1'));
    } catch {
      /* ignore */
    }
  }

  /** Round-trip a message to the controlling SW via a MessageChannel. */
  #message(type, data = {}) {
    return new Promise((resolve, reject) => {
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) return reject(new Error('no service worker controller'));
      const ch = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('offline worker timed out')), 10000);
      ch.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data);
      };
      ctrl.postMessage({ type, ...data }, [ch.port2]);
    });
  }
}
