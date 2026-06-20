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

/**
 * @typedef {Object} PluginManifest
 * @property {string} id - Globally unique, stable id, e.g. `'builtin-frequencies'`.
 * @property {string} name - Human-readable name.
 * @property {string} version - The plugin's own semver version.
 * @property {string} apiVersion - Engine API version targeted, e.g. `'0.1.0'`.
 * @property {string[]} [rPackages] - R packages to pre-install on activation.
 * @property {string} [category] - Section the plugin manager files it under. Use a
 *   **specific** category, not a generic "Analysis" bucket — categorise analyses
 *   by *method family*, matching the `Analyze ▸ …` submenus. Recommended
 *   vocabulary (extend as needed): `'Import'`, `'Descriptive Statistics'`,
 *   `'Comparison'`, `'Correlation'`, `'Regression'`, `'Multivariate'`,
 *   `'Time Series'`, `'Resampling'`, `'Graphs'`, `'Export'`. An unrecognised value
 *   just makes a new section (sorted after the recommended ones); missing → "Other".
 *   **This also fixes the plugin's menu location:** `menus.register` takes only a
 *   `label` (+ `command`/`order`); the host files the item under `category` as the
 *   top-level menu — the same place the plugin manager lists it. A plugin cannot
 *   put its menu anywhere else (any `path` it passes is ignored — see
 *   plugin-broker.js), so the menu and the manager always agree.
 * @property {string[]} [keywords] - Extra search terms for the plugin manager, so
 *   a plugin is findable by what it does even if its name doesn't say (e.g. a
 *   regression plugin keyworded with `['ols', 'linear']`).
 * @property {string} [menu] - For a **declarative single-item plugin** (one that
 *   exports `run` instead of `activate`): the menu item's label. Defaults to
 *   `name`. The item is filed under `category` automatically.
 * @property {number} [menuOrder] - Optional sort weight for that item within its
 *   category menu (lower first; default 100).
 *
 * ## Entry point: `run` (simple) or `activate` (advanced)
 * A plugin exports **either**:
 *  - `run(app)` — the simplest form: the host adds one menu item (label from
 *    `menu`/`name`, filed under `category`) and calls `run(app)` when clicked. No
 *    boilerplate. This is what the in-app creator templates use.
 *  - `activate(app)` — full control: register several menu items, an importer/
 *    exporter, event handlers, etc. Use this when one menu item → one function is
 *    not enough (e.g. the Plots plugin's five charts).
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

  /** Asks the user to allow network access for an untrusted plugin's first
   * `app.web.get`. `(label, url) => Promise<boolean>`. Defaults to deny. */
  #confirmNetwork;

  /**
   * @param {object} services - `{ data, results, webr, menus, ui, bus }`. These
   *   are the published service surfaces; the broker exposes a reviewed subset
   *   of them to plugins.
   * @param {Object} [opts]
   * @param {HTMLElement} [opts.sandboxContainer] - Where plugin iframes are
   *   appended. Defaults to a hidden `<div>` added to `document.body`.
   * @param {(label: string, url: string) => Promise<boolean>} [opts.confirmNetwork]
   *   - Consent prompt for an untrusted plugin's first network request.
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
  async load(url, opts = {}) {
    // Fetch the plugin source on the host so we can hand it to the opaque-origin
    // sandbox, which cannot fetch it itself. Same-origin always works; a
    // cross-origin URL needs the author to CORS-enable it (no proxy here).
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch plugin ${url}: HTTP ${res.status}`);
    const code = await res.text();
    return this.#instantiate(code, url, opts);
  }

  /**
   * Load + activate a plugin from its **source text** directly (no fetch) — used
   * for file-picked plugins and any case where the host already has the code.
   *
   * @param {string} code - The plugin's entry-module source.
   * @param {string} [label='plugin'] - A label for errors/consent prompts.
   * @param {{trusted?: boolean}} [opts]
   * @returns {Promise<PluginManifest>}
   */
  async loadSource(code, label = 'plugin', opts = {}) {
    return this.#instantiate(code, label, opts);
  }

  /**
   * Sandbox, import, version-check and activate a plugin from source text. A
   * `trusted` plugin (built-in) gets the full service surface; an untrusted one
   * (externally loaded) gets a **network-gated** `app.web` so its first request
   * needs user consent — the host-mediated path is the only network a plugin has
   * (the sandbox CSP blocks its own; see plugin-host.html).
   *
   * @param {string} code
   * @param {string} label - URL or filename, for errors/consent.
   * @param {{trusted?: boolean}} [opts]
   * @returns {Promise<PluginManifest>}
   */
  async #instantiate(code, label, { trusted = true } = {}) {
    const services = trusted ? this.#services : this.#gatedServices(label);
    const iframe = this.#createIframe();
    const broker = new PluginBroker({
      iframe,
      services,
      onError: (err) => console.error(`[plugin ${label}]`, err),
    });

    // Append + navigate; the runtime posts {t:'ready'} once it is wired up.
    this.#sandboxContainer.append(iframe);
    iframe.src = PLUGIN_HOST_URL;

    try {
      await broker.whenReady();
      const manifest = await broker.sendLoad(code);

      if (!manifest || typeof manifest.id !== 'string') {
        throw new Error(`Plugin at ${label} exported no valid manifest`);
      }
      if (this.#plugins.has(manifest.id)) {
        throw new Error(`Plugin "${manifest.id}" is already loaded`);
      }
      assertApiCompatible(manifest);

      // Pre-install declared R packages so the first analysis does not pay for
      // it. Queued in the WebR job queue; awaited lazily by the eventual run().
      if (manifest.rPackages?.length) {
        this.#services.webr.installPackages(manifest.rPackages).catch((err) => {
          console.warn(`Plugin "${manifest.id}": package preinstall failed`, err);
        });
      }

      await broker.sendActivate({ ...manifest, apiVersion: API_VERSION });

      this.#plugins.set(manifest.id, { manifest, iframe, broker, trusted });
      return manifest;
    } catch (err) {
      // Roll back a partially-loaded plugin so a failure leaves no orphan iframe.
      broker.dispose();
      iframe.remove();
      throw err;
    }
  }

  /** Services for an untrusted plugin: every host service as-is, but `web.get`
   * gated behind a one-time consent prompt (cached per plugin instance). */
  #gatedServices(label) {
    const realWeb = this.#services.web;
    const confirmNetwork = this.#confirmNetwork;
    let decision = null;
    const web = Object.freeze({
      get: async (url) => {
        if (decision === null) decision = await confirmNetwork(label, String(url));
        if (!decision) throw new Error('Network access was blocked for this plugin.');
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
  invoke(id, fn, args = []) {
    const record = this.#plugins.get(id);
    if (!record) throw new Error(`Plugin "${id}" is not loaded`);
    return record.broker.invoke(fn, args);
  }

  /** Bind the host-gathered inputs for a plugin's in-flight action (auto-injected
   * into its `webr.run`). Paired with {@link PluginLoader#clearActiveInputs}. */
  setActiveInputs(id, inputs) {
    this.#plugins.get(id)?.broker.setActiveInputs(inputs);
  }

  clearActiveInputs(id) {
    this.#plugins.get(id)?.broker.clearActiveInputs();
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

/** Create the hidden container that holds plugin iframes. */
function createHiddenContainer() {
  const el = document.createElement('div');
  el.id = 'crosstab-plugin-sandboxes';
  el.hidden = true;
  document.body.append(el);
  return el;
}
