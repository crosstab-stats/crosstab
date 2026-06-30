/**
 * @file loader.js
 * Plugin lifecycle: fetch → sandbox → import → version-check → activate → unload.
 *
 * ## Isolation: all plugins are equal
 * There is no privileged loading path. Every plugin — the built-in Frequencies
 * analysis included — runs inside its own sandboxed `<iframe>` and talks to the
 * engine only over `postMessage`. The engine never imports plugin code into its
 * own realm. This is the Factorio / VS Code principle taken literally: the
 * official content is just the official mod, subject to the exact same boundary,
 * trust level, and API as any third-party plugin. Concretely that means a plugin
 * cannot reach the engine's JS heap or the host DOM, and anything it returns
 * (e.g. result HTML) is treated as untrusted.
 *
 * The mechanics: the loader fetches the plugin's entry-module source, spins up a
 * sandboxed {@link plugin-host.html} iframe, and hands the source to that iframe
 * to import from a blob URL. A {@link PluginBroker} per iframe services the
 * plugin's API calls against the core services. See plugin-broker.js for the
 * wire protocol.
 */

import { PluginBroker } from './plugin-broker.js';

/**
 * API contract version the engine implements. A plugin declares the version it
 * targets in its manifest; the loader requires the same MAJOR and an engine
 * MINOR ≥ the plugin's. (Migration policy for major bumps is an open question.)
 * @type {string}
 */
export const API_VERSION = '0.1.0';

/** URL of the sandbox document every plugin iframe loads. */
const PLUGIN_HOST_URL = './plugin-host.html';
/** Sandbox document for codec plugins (#98): same runtime, CSP widened for WASM +
 * an in-sandbox worker. Used only for plugins that declare `manifest.codecs`. */
const CODEC_HOST_URL = './plugin-host-codec.html';

/**
 * Compute a plugin's **qualified id** — its globally-unique identity — by
 * namespacing the author-declared `manifest.id` (a short *local* name) with its
 * **origin**, so two unrelated plugins can never collide (#102). Built-ins are the
 * reserved `builtin-…` namespace and pass through unchanged (zero churn; they're
 * already unique and app-controlled). A third-party plugin loaded from a URL is
 * namespaced by its **host** (verifiable — the author had to serve it from there);
 * a file/authored plugin by its self-declared `manifest.author` (unverifiable, so
 * it only guards against *accidental* clashes), falling back to `local`.
 *
 * Because the namespace is prepended by the host (never by the author's id text),
 * a third-party plugin can't forge a `builtin-…` identity or squat another's.
 *
 * @param {{kind:'builtin'|'url'|'file'|'authored', url?:string}} origin
 * @param {{id:string, author?:string}} manifest
 * @returns {string} the qualified id, e.g. `builtin-regression` or `alice.dev:regression`.
 */
export function qualifyId(origin, manifest) {
  const local = String(manifest?.id ?? '').trim();
  if (!local) throw new Error('Plugin manifest is missing an id.');
  if (!origin || origin.kind === 'builtin') return local; // reserved builtin namespace
  if (origin.kind === 'url') {
    let host = '';
    try {
      host = new URL(origin.url).host;
    } catch {
      /* relative/garbage URL → fall back below */
    }
    return `${host || 'url'}:${local}`;
  }
  // file / authored: the author tag is the namespace (self-declared); else 'local'.
  const author = String(manifest?.author ?? '').trim().replace(/\s+/g, '-').toLowerCase();
  return `${author || 'local'}:${local}`;
}

/**
 * A plugin is **fully declarative**: a `manifest` (data) describing what it
 * contributes, plus **named exported functions** the manifest references. The host
 * does all wiring — there is no `activate`, and the `app` surface exposes no
 * registration verbs. A plugin can only do what a manifest section exists for.
 *
 * @typedef {Object} PluginManifest
 * @property {string} id - Globally unique, stable id, e.g. `'builtin-frequencies'`.
 * @property {string} name - Human-readable name.
 * @property {string} version - The plugin's own semver version.
 * @property {string} apiVersion - Engine API version targeted, e.g. `'0.1.0'`.
 * @property {string[]} [rPackages] - R packages to pre-install on load.
 * @property {string} [category] - Section the plugin manager files it under, and
 *   the **top-level menu** its items appear under (the two always agree — the host
 *   owns placement; a plugin can't choose). Use a **specific** category by *method
 *   family*, not a generic "Analysis" bucket. Recommended vocabulary: `'Import'`,
 *   `'Descriptive Statistics'`, `'Comparison'`, `'Correlation'`, `'Regression'`,
 *   `'Multivariate'`, `'Time Series'`, `'Resampling'`, `'Graphs'`, `'Export'`. An
 *   unrecognised value just makes a new section; missing → "Other".
 * @property {string[]} [keywords] - Extra search terms for the plugin manager.
 * @property {string} [howto] - Optional usage note shown behind the 🔍 in the plugin
 *   manager and in the Syntax guide. Write a line or two on using it from the GUI,
 *   then the syntax call form, e.g. `Pick variables in Descriptive Statistics ▸
 *   Frequencies. Syntax: run builtin-frequencies.run {"vars": ["gender","region"]}`.
 * @property {Array<MenuItem>} [menu] - Menu actions. Each item is filed under
 *   `category`; clicking it gathers the item's `inputs`, binds them into R by name,
 *   then calls the named `run` function.
 * @property {Array<ImporterDecl>} [imports] - File/web importers (File ▸ Import).
 * @property {Array<ExporterDecl>} [exports] - Data exporters (File ▸ Export).
 * @property {Array<ExporterDecl>} [outputExports] - Report exporters (Export output…).
 *
 * @typedef {Object} MenuItem
 * @property {string} label - Menu item text, e.g. `'Descriptives…'`.
 * @property {string} run - Name of the exported function to call: `run(app, inputs)`.
 * @property {number} [order] - Sort weight within the category menu (lower first).
 * @property {Array<InputDecl>} [inputs] - Inputs gathered (in order) before `run`.
 *
 * @typedef {Object} InputDecl
 * @property {string} name - Key under which the value is passed in `inputs` and
 *   bound in R (single variable → vector, multi → data.frame, scalar → value).
 * @property {'variables'|'number'|'choice'|'text'|'file'} [kind='variables']
 * @property {string} [label] - Role label (e.g. 'Outcome'); the host composes the
 *   dialog title/hint.
 * @property {string[]} [extensions] - (file) picker filter, e.g. `['.geojson']`.
 *   A `file` input opens a picker and passes the plugin `{ name, bytes:Uint8Array }`
 *   (a supplementary file — distinct from an importer, which makes a dataset).
 * @property {boolean} [multiple] - (variables) allow several.
 * @property {string[]} [types] - (variables) restrict to types, e.g. `['numeric']`.
 * @property {boolean} [optional] - cancel yields null/empty instead of aborting.
 * @property {boolean} [unique] - (variables) exclude vars chosen by earlier
 *   `unique` inputs in the same action (e.g. scatter X ≠ Y).
 * @property {Array<{value:string,label?:string}>} [options] - (choice) the choices.
 * @property {*} [default] - (number/choice/text) default value.
 *
 * @typedef {Object} ImporterDecl
 * @property {string} label
 * @property {string} parse - Named function `parse(app, {name, file})` →
 *   `{variables, columns|parquet}` (or null to abort). Returns the dataset; the
 *   host commits it.
 * @property {'file'|'web'} [source='file'] - `'web'` opens no picker.
 * @property {string[]} [extensions] - Picker filter (file source).
 * @property {boolean} [multiple] - Allow several files (pooled).
 * @property {boolean} [stage] - Host-mount the upload into WebR and pass `parse`
 *   the mounted `path` (no `file`). For large, R-parsed formats — avoids cloning
 *   a multi-GB file through the sandbox; the host owns the mount lifecycle.
 * @property {number} [order]
 *
 * @typedef {Object} ExporterDecl
 * @property {string} label
 * @property {string} export - Named function returning
 *   `{filename, mimeType, data}` for the host to download.
 * @property {string[]} [extensions]
 * @property {number} [order]
 */

/**
 * @typedef {Object} LoadedPlugin
 * @property {PluginManifest} manifest
 * @property {HTMLIFrameElement} iframe
 * @property {PluginBroker} broker
 */

/**
 * Loads, activates and unloads plugins, each in its own sandboxed iframe.
 */
export class PluginLoader {
  /** Core services bundle handed to each broker. @type {object} */
  #services;

  /** Hidden container holding all plugin iframes. @type {HTMLElement} */
  #sandboxContainer;

  /** id → loaded plugin record. @type {Map<string, LoadedPlugin>} */
  #plugins = new Map();

  /** hostUrl → fetched sandbox-document HTML (memoised). The sandbox iframes load
   * from a **blob: URL** of this HTML rather than the host URL directly: a sandboxed
   * opaque-origin iframe's navigation to a same-origin URL is NOT controlled by the
   * service worker, so `src=./plugin-host.html` can't be served from cache and would
   * fail offline once the SW controls the page (installed PWAs). Fetching the host
   * HTML on the (SW-controlled) main thread caches it; loading the iframe from a
   * blob: URL then needs no network or SW — same isolation (opaque origin), but works
   * offline (#92). Same mechanism the loader already uses for plugin code + the DuckDB
   * worker. @type {Map<string, Promise<string>>} */
  #hostHtml = new Map();

  /** Asks the user to allow a plugin's first `app.web.get`. A *remembered* grant
   * resolves true without prompting; otherwise the user is prompted (and an allow
   * is remembered host-side). `(plugin: {id, name}, url) => Promise<boolean>`.
   * Defaults to deny. */
  #confirmNetwork;

  /**
   * @param {object} services - `{ data, results, webr, menus, ui, bus }`. These
   *   are the published service surfaces; the broker exposes a reviewed subset
   *   of them to plugins.
   * @param {Object} [opts]
   * @param {HTMLElement} [opts.sandboxContainer] - Where plugin iframes are
   *   appended. Defaults to a hidden `<div>` added to `document.body`.
   * @param {(plugin: {id: string, name: string}, url: string) => Promise<boolean>} [opts.confirmNetwork]
   *   - Consent gate for a plugin's first network request (resolves a remembered
   *     grant without prompting).
   */
  constructor(services, opts = {}) {
    this.#services = services;
    this.#sandboxContainer = opts.sandboxContainer ?? createHiddenContainer();
    this.#confirmNetwork = opts.confirmNetwork ?? (async () => false);
  }

  /**
   * Load and activate a plugin from a module URL.
   *
   * @param {string} url - Same-origin URL of the plugin's entry module, e.g.
   *   `'./plugins/builtin-frequencies/index.js'`. The loader fetches its source
   *   and runs it inside a sandbox; the URL is never `import()`ed by the engine.
   * @returns {Promise<PluginManifest>} The activated plugin's manifest.
   */
  async activate(url, origin = { kind: 'url', url }) {
    // Fetch the plugin source on the host so we can hand it to the opaque-origin
    // sandbox, which cannot fetch it itself. Same-origin always works; a
    // cross-origin URL needs the author to CORS-enable it (no proxy here).
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch plugin ${url}: HTTP ${res.status}`);
    const code = await res.text();
    // Record the entry URL so the plugin's declared assets can resolve from
    // *siblings* of it — same author-controlled origin, verifiable (#119).
    return this.#instantiate(code, url, origin, { entryUrl: url });
  }

  /**
   * Activate a plugin from its **source text** directly (no fetch) — used for
   * file-picked plugins and any case where the host already has the code.
   *
   * @param {string} code - The plugin's entry-module source.
   * @param {string} [label='plugin'] - A label for errors/consent prompts.
   * @param {object} [origin] - Origin descriptor (for id namespacing).
   * @param {Map<string,Uint8Array>} [assets] - Bundled package assets by entry name,
   *   for a multi-file plugin loaded from a `.ctplugin` zip — its declared assets
   *   resolve from this bundle rather than a URL sibling (#119).
   * @returns {Promise<PluginManifest>}
   */
  async activateSource(code, label = 'plugin', origin = { kind: 'authored' }, assets = null) {
    return this.#instantiate(code, label, origin, { assets });
  }

  /**
   * Read a plugin's manifest **without activating it** — sandbox the code, grab
   * the exported manifest, then tear the sandbox down. Used to populate the
   * plugin picker/launcher with full metadata (category, disciplines) for
   * plugins the user hasn't switched on, without keeping ~N iframes alive or
   * doing any R work. The probe is throwaway: it never enters `#plugins`.
   *
   * @param {string} url
   * @returns {Promise<PluginManifest>}
   */
  async probeManifest(url, origin = { kind: 'url', url }) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch plugin ${url}: HTTP ${res.status}`);
    return this.#probe(await res.text(), url, origin);
  }

  /** Like {@link probeManifest} but from source text (file/authored plugins). */
  async probeManifestSource(code, label = 'plugin', origin = { kind: 'authored' }) {
    return this.#probe(code, label, origin);
  }

  /** Sandbox `code`, return its manifest (id qualified by origin), and dispose the
   * sandbox. No activation. */
  async #probe(code, label, origin) {
    const ctx = { id: null, name: label };
    const iframe = this.#createIframe();
    const broker = new PluginBroker({ iframe, services: this.#gatedServices(ctx), onError: () => {} });
    this.#sandboxContainer.append(iframe);
    iframe.src = await this.#sandboxSrc(PLUGIN_HOST_URL);
    try {
      await broker.whenReady();
      const manifest = await broker.sendLoad(code);
      if (!manifest || typeof manifest.id !== 'string') {
        throw new Error(`Plugin at ${label} exported no valid manifest`);
      }
      manifest.id = qualifyId(origin, manifest); // origin-namespaced identity (#102)
      return manifest;
    } finally {
      broker.dispose();
      iframe.remove();
    }
  }

  /**
   * Sandbox, import, version-check and activate a plugin from source text. Every
   * plugin is treated identically (see the file header): each gets a
   * **network-gated** `app.web` whose first request needs user consent — the
   * host-mediated path is the only network a plugin has (the sandbox CSP blocks
   * its own; see plugin-host.html). An allow is remembered host-side.
   *
   * @param {string} code
   * @param {string} label - URL or filename, for errors/consent.
   * @returns {Promise<PluginManifest>}
   */
  async #instantiate(code, label, origin, { hostUrl = PLUGIN_HOST_URL, entryUrl = null, assets = null } = {}) {
    // Identity for the consent gate. The manifest id isn't known until the plugin
    // loads, so the gate reads it from this holder — `web.get` only ever fires
    // after load + activate, by which point it's filled in.
    const ctx = { id: null, name: label };
    const iframe = this.#createIframe();
    const broker = new PluginBroker({
      iframe,
      services: this.#gatedServices(ctx),
      onError: (err) => console.error(`[plugin ${label}]`, err),
    });

    // Append + point the iframe at a blob: URL of the sandbox document; the runtime
    // posts {t:'ready'} once wired up. blob: (not the host URL) so it works offline —
    // see #hostHtml.
    this.#sandboxContainer.append(iframe);
    iframe.src = await this.#sandboxSrc(hostUrl);

    try {
      await broker.whenReady();
      const manifest = await broker.sendLoad(code);

      if (!manifest || typeof manifest.id !== 'string') {
        throw new Error(`Plugin at ${label} exported no valid manifest`);
      }
      manifest.id = qualifyId(origin, manifest); // origin-namespaced identity (#102)
      // A codec plugin needs the WASM/worker-enabled sandbox. We load into the
      // default (strict) host just to read the manifest; if it declares codecs,
      // re-instantiate it in the codec host (cheap — the source is already fetched).
      if (Array.isArray(manifest.codecs) && manifest.codecs.length && hostUrl !== CODEC_HOST_URL) {
        broker.dispose();
        iframe.remove();
        return this.#instantiate(code, label, origin, { hostUrl: CODEC_HOST_URL, entryUrl, assets });
      }
      if (this.#plugins.has(manifest.id)) {
        throw new Error(`Plugin "${manifest.id}" is already activated`);
      }
      assertApiCompatible(manifest);

      // The gate's consent prompt / remembered-grant lookup keys off the plugin's
      // own identity, now that it's known.
      ctx.id = manifest.id;
      ctx.name = manifest.name || label;

      // NOTE: declared R packages are installed lazily on the plugin's first
      // invoke (see #ensurePackages), NOT here. Eagerly installing every
      // plugin's packages at load time fires dozens of concurrent WebR installs
      // at app start once many plugins are registered, which overwhelms/wedges
      // the runtime. Deferring to first real use keeps startup free of R work.

      await broker.sendActivate({ ...manifest, apiVersion: API_VERSION });

      // Retain origin/entryUrl + any bundled package assets so the plugin's
      // declared assets can be resolved on demand (#119) — from its own bundle, or
      // from a same-origin sibling of its entry URL.
      this.#plugins.set(manifest.id, { manifest, iframe, broker, origin, entryUrl, assets });
      return manifest;
    } catch (err) {
      // Roll back a partially-loaded plugin so a failure leaves no orphan iframe.
      broker.dispose();
      iframe.remove();
      throw err;
    }
  }

  /** Services for a plugin: every host service as-is, but `web.get` gated behind
   * the consent callback. The first decision is cached for this instance (so a
   * mid-session block isn't re-prompted); a remembered allow is resolved by the
   * callback without a prompt. `ctx` carries the plugin identity, filled in once
   * the manifest loads (before any `web.get` can fire). */
  #gatedServices(ctx) {
    const realWeb = this.#services.web;
    const confirmNetwork = this.#confirmNetwork;
    // Per-origin decision cache: consent is asked once per *host*, not once per
    // plugin. A new origin re-prompts, so an allow for one host never silently
    // authorises fetching (and exfiltrating to) another (#89).
    const decided = new Map(); // origin → boolean
    const web = Object.freeze({
      get: async (url) => {
        let origin;
        try {
          origin = new URL(String(url)).origin;
        } catch {
          throw new Error('web.get: invalid URL');
        }
        if (!decided.has(origin)) {
          decided.set(origin, await confirmNetwork({ id: ctx.id, name: ctx.name }, String(url)));
        }
        if (!decided.get(origin)) throw new Error('Network access was blocked for this plugin.');
        return realWeb.get(url);
      },
    });
    return Object.freeze({ ...this.#services, web });
  }

  /**
   * Deactivate and unload a plugin: dispose its broker (which undoes its menu
   * items and subscriptions) and remove its iframe (which destroys its heap).
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async unload(id) {
    const record = this.#plugins.get(id);
    if (!record) return;
    this.#plugins.delete(id);
    record.broker.dispose();
    record.iframe.remove();
  }

  /** @returns {PluginManifest[]} Manifests of all currently loaded plugins. */
  list() {
    return [...this.#plugins.values()].map((p) => p.manifest);
  }

  /**
   * Invoke a named export on a loaded plugin (declarative API entry path). The
   * host gathers inputs and calls `run`/`parse`/`export` this way.
   * @param {string} id - Plugin id.
   * @param {string} fn - Exported function name.
   * @param {any[]} [args]
   * @returns {Promise<any>}
   */
  async invoke(id, fn, args = []) {
    const record = this.#plugins.get(id);
    if (!record) throw new Error(`Plugin "${id}" is not loaded`);
    await this.#ensurePackages(record);
    return record.broker.invoke(fn, args);
  }

  /**
   * Install a plugin's declared R packages on first use, exactly once. The
   * promise is cached on the plugin record so concurrent/later invokes reuse it;
   * a failed install is not cached (so a later invoke can retry). Deferring to
   * first invoke keeps app startup from firing every plugin's installs at once.
   * @param {{manifest: PluginManifest, pkgs?: Promise<void>|null}} record
   */
  #ensurePackages(record) {
    const pkgs = record.manifest.rPackages;
    if (!pkgs?.length) return Promise.resolve();
    if (!record.pkgs) {
      record.pkgs = Promise.resolve(this.#services.webr.installPackages(pkgs)).catch((err) => {
        record.pkgs = null; // allow retry on a later invoke
        throw err;
      });
    }
    return record.pkgs;
  }

  /**
   * Resolve a **plugin-declared asset** to its bytes/text — the no-lock-in path
   * that lets a multi-file plugin bring its own dependencies instead of relying on
   * the host's shared-runtime allowlist (#119). A plugin declares its assets in the
   * manifest (`manifest.assets` and/or `codecs[].assets`: `{name, path?, kind?}`);
   * only *declared* names resolve here (the per-plugin allowlist), and only from:
   *  1. its own **bundle** (a `.ctplugin` package's entries), or
   *  2. a **same-origin sibling** of its entry URL (author-controlled + verifiable —
   *     the same trust basis as the host namespace in {@link qualifyId}).
   *
   * Off-origin targets are refused, preserving the sandbox boundary (no arbitrary
   * host fetches). Returns `null` when the plugin didn't declare `name`, so the
   * caller can fall back to the host's shared-library allowlist.
   *
   * @param {string} pluginId
   * @param {string} name
   * @returns {Promise<{kind:'text'|'bytes', value:string|Uint8Array}|null>}
   */
  async resolveAsset(pluginId, name) {
    const rec = this.#plugins.get(pluginId);
    if (!rec) return null;
    const decl = assetDecl(rec.manifest, name);
    if (!decl) return null; // not declared by this plugin → caller may use the host allowlist
    const kind = decl.kind === 'bytes' ? 'bytes' : 'text';
    const path = decl.path || name;
    // 1. The plugin's own bundle (a packaged .ctplugin) — bytes keyed by entry name.
    if (rec.assets && rec.assets.has(path)) {
      const raw = rec.assets.get(path);
      return { kind, value: kind === 'bytes' ? raw : new TextDecoder().decode(raw) };
    }
    // 2. A same-origin sibling of the entry URL (URL/built-in plugins).
    if (rec.entryUrl) {
      const base = new URL(rec.entryUrl, location.href);
      const target = new URL(path, base);
      if (target.origin !== base.origin) {
        throw new Error(`Plugin asset "${name}" resolves off-origin (${target.origin}) — blocked.`);
      }
      const res = await fetch(target.href);
      if (!res.ok) throw new Error(`Plugin asset "${name}" failed to load (HTTP ${res.status}).`);
      return { kind, value: kind === 'bytes' ? new Uint8Array(await res.arrayBuffer()) : await res.text() };
    }
    throw new Error(`Plugin asset "${name}" is declared but neither bundled nor reachable from an entry URL.`);
  }

  /** Bind the host-gathered inputs for a plugin's in-flight action (auto-injected
   * into its `webr.run`). Paired with {@link PluginLoader#clearActiveInputs}. */
  setActiveInputs(id, inputs) {
    this.#plugins.get(id)?.broker.setActiveInputs(inputs);
  }

  clearActiveInputs(id) {
    this.#plugins.get(id)?.broker.clearActiveInputs();
  }

  /** Set a loaded plugin's host-tracked output attribution ("Name · origin"), so
   * any output it appends outside an analysis bracket is still traceable (#106).
   * The origin is owned by the plugin manager, hence set here post-load. */
  setAttribution(id, attribution) {
    this.#plugins.get(id)?.broker.setAttribution(attribution);
  }

  /** A fresh blob: URL of the sandbox document for an iframe's `src` (#92). The host
   * HTML is fetched once per host URL and cached (the fetch goes through the service
   * worker, so it's available offline); each iframe gets its own blob: URL built from
   * that text. Loading from blob: needs no network or SW — yet `sandbox="allow-scripts"`
   * still forces an opaque origin + isolated heap, so isolation is unchanged. The URL
   * is revoked shortly after (the iframe loads it in milliseconds). */
  async #sandboxSrc(hostUrl) {
    let p = this.#hostHtml.get(hostUrl);
    if (!p) {
      p = (async () => {
        const res = await fetch(hostUrl);
        if (!res.ok) throw new Error(`Failed to load plugin sandbox ${hostUrl}: HTTP ${res.status}`);
        return res.text();
      })().catch((err) => {
        this.#hostHtml.delete(hostUrl); // don't cache a failure — allow retry
        throw err;
      });
      this.#hostHtml.set(hostUrl, p);
    }
    const html = await p;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    setTimeout(() => URL.revokeObjectURL(url), 15000); // iframe loads it in ms
    return url;
  }

  /** Build a hidden, sandboxed iframe for a plugin. */
  #createIframe() {
    const iframe = document.createElement('iframe');
    // allow-scripts ONLY: scripts run, but the frame stays a unique opaque
    // origin with no access to the parent DOM. Deliberately NO allow-same-origin
    // (that would defeat heap isolation) and NO allow-forms/popups/etc.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('title', 'plugin sandbox');
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
    return iframe;
  }
}

/**
 * Check a plugin's declared API version against {@link API_VERSION}.
 * Policy: MAJOR must match exactly; engine MINOR must be ≥ plugin MINOR.
 *
 * @param {PluginManifest} manifest
 * @throws if incompatible.
 */
function assertApiCompatible(manifest) {
  const declared = manifest.apiVersion;
  if (typeof declared !== 'string') {
    throw new Error(`Plugin "${manifest.id}" does not declare an apiVersion`);
  }
  const [pMajor, pMinor] = declared.split('.').map(Number);
  const [eMajor, eMinor] = API_VERSION.split('.').map(Number);

  if (pMajor !== eMajor) {
    throw new Error(
      `Plugin "${manifest.id}" targets API ${declared} but engine is ${API_VERSION} ` +
        `(incompatible major version).`,
    );
  }
  if (pMinor > eMinor) {
    throw new Error(
      `Plugin "${manifest.id}" targets API ${declared}, newer than engine ${API_VERSION}.`,
    );
  }
}

/**
 * Find a plugin's declaration for an asset `name`, searching both `manifest.assets`
 * and each `manifest.codecs[].assets` (a codec may declare its own deps). Returns
 * `{name, path?, kind?}` or null. This declared set is the plugin's *own* allowlist
 * — the host resolves only what the plugin asked for (#119).
 */
function assetDecl(manifest, name) {
  const lists = [manifest?.assets, ...((manifest?.codecs || []).map((c) => c?.assets))];
  for (const list of lists) {
    if (Array.isArray(list)) {
      const found = list.find((a) => a && a.name === name);
      if (found) return found;
    }
  }
  return null;
}

/** Create the hidden container that holds plugin iframes. */
function createHiddenContainer() {
  const el = document.createElement('div');
  el.id = 'crosstab-plugin-sandboxes';
  el.hidden = true;
  document.body.append(el);
  return el;
}
