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
// The WebR binary package repo (CDN mode). The R-minor dir must match the WebR
// build — keep in sync with scripts/vendor-assets.mjs R_VERSION_DIR.
const PKG_REPO = 'https://repo.r-wasm.org/bin/emscripten/contrib/4.6';

export class OfflineManager {
  #webr;
  #duckdb;
  #plugins;

  /**
   * @param {object} deps
   * @param {import('./webr-manager.js').WebRManager} deps.webr
   * @param {import('./duckdb-manager.js').DuckDBManager} deps.duckdb
   * @param {import('./plugin-manager.js').PluginManager} [deps.plugins] - To learn
   *   which R packages the enabled plugins need (for the offline closure prefetch).
   */
  constructor({ webr, duckdb, plugins }) {
    this.#webr = webr;
    this.#duckdb = duckdb;
    this.#plugins = plugins ?? null;
  }

  /** Whether the browser can do this at all (SW + Cache API). */
  get supported() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'caches' in self;
  }

  /** Read state straight from the Cache API (no SW round-trip needed):
   * `{ supported, controlled, enabled, runtimeCached, count, bytes }`. `enabled` is
   * the opt-in marker (the full-toolkit pre-cache was run); `runtimeCached` means the
   * R engine is in the cache (possibly just from normal use — #92 cache-as-used), so
   * analyses can run offline even without opting in. */
  async status() {
    if (!this.supported) return { supported: false, controlled: false, enabled: false, runtimeCached: false, count: 0, bytes: 0 };
    let enabled = false;
    let runtimeCached = false;
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
        // The WebR engine being cached (CDN host or vendored same-origin) is what
        // lets analyses run offline.
        if (/webr\.r-wasm\.org|\/vendor\/webr\//.test(req.url)) runtimeCached = true;
        // Headers only (no body reads) so status stays fast with ~100 MB cached.
        const r = await c.match(req);
        const len = Number(r?.headers.get('content-length') || 0);
        if (len) bytes += len;
      }
    } catch {
      /* Cache API unavailable */
    }
    return { supported: true, controlled: !!navigator.serviceWorker.controller, enabled, runtimeCached, count, bytes };
  }

  /** True once a previous enable() reloaded to gain control — boot calls
   * resumeIfPending() to finish the warm. */
  get hasPendingResume() {
    try {
      return !!sessionStorage.getItem(RESUME_KEY);
    } catch {
      return false;
    }
  }

  /** Tell the service worker whether we're running as a standalone (Home Screen)
   * app, so it serves the app shell cache-first / stale-while-revalidate (instant,
   * flaky-network-proof) instead of network-first. */
  setStandalone(value) {
    if (!navigator.serviceWorker?.controller) return;
    this.#message('set-standalone', { value: !!value }).catch(() => {
      /* not critical */
    });
  }

  /**
   * Turn on offline caching and cache the app + runtimes + the chosen R packages.
   * May reload once the very first time (to put the page under SW control); the
   * warm then resumes on boot with the same package list.
   * @param {(text: string) => void} [onProgress]
   * @param {object} [opts]
   * @param {boolean} [opts.allPlugins] cache every plugin's packages (plan-ahead).
   * @param {string[]} [opts.packages] explicit R-package list (e.g. the launcher's
   *   *selected* plugins, which aren't loaded yet). Takes precedence over allPlugins.
   */
  async enable(onProgress = () => {}, { allPlugins = false, packages = null } = {}) {
    if (!this.supported) throw new Error('This browser can’t cache for offline use.');
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* best effort */
    }
    const wanted = this.#resolveWanted({ allPlugins, packages });
    // Persist "on" now, so it survives a control-gaining reload and the SW hydrates
    // on at its next activation.
    await this.#setMarker();

    if (!navigator.serviceWorker.controller) {
      onProgress('Activating offline support — reloading once…');
      try {
        // Carry the exact package list across the reload (a launcher selection
        // would otherwise be gone after the page reboots).
        sessionStorage.setItem(RESUME_KEY, JSON.stringify({ packages: wanted }));
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

    await this.#runWarm(onProgress, wanted);
  }

  /** Resolve the R-package set to cache: an explicit list wins, else every plugin
   * (allPlugins) or the loaded set; nanoparquet (the host bridge) is always added. */
  #resolveWanted({ allPlugins = false, packages = null } = {}) {
    const set = new Set(['nanoparquet']);
    let pkgs = packages;
    if (!pkgs) {
      try {
        pkgs = allPlugins ? this.#plugins?.allRPackages?.() : this.#plugins?.requiredRPackages?.();
      } catch {
        pkgs = [];
      }
    }
    for (const p of pkgs || []) set.add(p);
    return [...set];
  }

  /** If a prior enable() reloaded to gain control, finish caching now (boot calls
   * this). No-op otherwise. */
  async resumeIfPending(onProgress = () => {}) {
    let payload = null;
    try {
      payload = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
    } catch {
      /* ignore */
    }
    if (!payload || !Array.isArray(payload.packages)) return;
    // Keep the flag until we actually have control + finish, so a reload that
    // didn't immediately yield control retries on the next load rather than
    // silently dropping the request.
    if (!navigator.serviceWorker.controller) return;
    try {
      await this.#runWarm(onProgress, payload.packages);
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

  /** Cache + warm everything once the page is under SW control.
   * @param {string[]} wantedPackages the resolved R-package set to pre-fetch
   *   (already includes nanoparquet; see #resolveWanted). */
  async #runWarm(onProgress, wantedPackages = []) {
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

    // 3) Data engine.
    onProgress('Caching the data engine…');
    await this.#duckdb.preload();

    // 4) R packages: pre-fetch the dependency closure of the chosen packages (the
    // selected/enabled plugins, or every plugin) so those analyses run offline
    // without having to have been run online first. We cache the package .tgz files
    // directly (not install them) — so caching many plugins' packages can't OOM the
    // single WebR session.
    await this.#cachePackages(wantedPackages, onProgress);

    onProgress('Offline ready.');
  }

  /** Cache the dependency closure of `wanted` R packages from the WebR binary repo,
   * so an offline `installPackages` is served from cache. Downloads the .tgz files
   * (and the PACKAGES index WebR resolves against) — never installs them. */
  async #cachePackages(wanted, onProgress) {
    if (!wanted.length) return;
    onProgress('Resolving R packages…');
    let index;
    try {
      const txt = await (await fetch(`${PKG_REPO}/PACKAGES`, { cache: 'reload' })).text();
      index = parsePackages(txt);
    } catch {
      onProgress('Couldn’t reach the R package repo — packages will cache on first use.');
      return;
    }
    // Cache the index variants WebR reads at install time (it resolves against the
    // binary .rds; the others are harmless to have).
    await Promise.all(
      ['PACKAGES', 'PACKAGES.gz', 'PACKAGES.rds'].map((f) => fetch(`${PKG_REPO}/${f}`, { cache: 'reload' }).catch(() => {})),
    );

    // Dependency closure over what the repo actually offers (base R packages like
    // 'stats'/'methods' aren't in the repo and are skipped — they ship with WebR).
    const closure = new Set();
    const visit = (name) => {
      if (closure.has(name) || !index[name]) return;
      closure.add(name);
      for (const dep of index[name].deps) visit(dep);
    };
    for (const w of wanted) visit(w);
    const list = [...closure];
    if (!list.length) return;

    // Fetch the .tgz files with a small concurrency pool (gentle on the repo, but
    // faster than one-at-a-time for a big closure).
    let done = 0;
    const POOL = 6;
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        const { Version } = index[name];
        await fetch(`${PKG_REPO}/${name}_${Version}.tgz`, { cache: 'reload' }).catch(() => {});
        onProgress(`Caching R packages… ${++done}/${list.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, list.length) }, worker));
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

/** Parse a CRAN-style PACKAGES file into `{ name: { Version, deps:Set } }`. Mirrors
 * the resolver in scripts/vendor-assets.mjs (kept in step), so the offline cache
 * and the air-gap vendor script compute the same dependency closure. */
function parsePackages(text) {
  const out = {};
  for (const block of text.split(/\n\s*\n/)) {
    const fields = {};
    let key = null;
    for (const line of block.split('\n')) {
      const m = line.match(/^(\S[^:]*):\s?(.*)$/);
      if (m) {
        key = m[1];
        fields[key] = m[2];
      } else if (key && /^\s/.test(line)) {
        fields[key] += ' ' + line.trim();
      }
    }
    if (!fields.Package) continue;
    const deps = new Set();
    for (const f of ['Depends', 'Imports', 'LinkingTo']) {
      if (!fields[f]) continue;
      for (const d of fields[f].split(',')) {
        const name = d.trim().replace(/\s*\(.*\)\s*$/, '');
        if (name && name !== 'R') deps.add(name);
      }
    }
    out[fields.Package] = { Version: fields.Version, deps };
  }
  return out;
}
