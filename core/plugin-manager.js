/**
 * @file plugin-manager.js
 * Manage the installed plugins — **host-owned** control of the plugin lifecycle
 * (it drives the loader and persists state; a sandboxed plugin has no handle on
 * the loader or its peers, so this can't itself be a plugin).
 *
 * Two kinds of plugin — a provenance label only, **not** a privilege level:
 *  - **Built-in** — the URLs shipped with the app (`urls`).
 *  - **User** — added at runtime, either from a **URL** (re-fetched each boot; the
 *    author must CORS-enable it) or from a **file** (the source is persisted in
 *    localStorage so it survives a restart).
 *
 * Every plugin is sandboxed and gated identically: the only network it has is a
 * host-mediated `app.web`, and the first request needs user consent (the sandbox
 * CSP blocks any other network). There is no built-in bypass — the manager
 * persists per-plugin web grants (keyed by manifest id) so an allowed plugin
 * isn't asked again; {@link grantWeb}/{@link revokeWeb}/{@link isWebAllowed} and
 * the loader's consent gate (app.js) drive that.
 *
 * Exposes **Edit ▸ Plugins…**: a searchable, category-grouped dialog to toggle,
 * add (URL / file), fork, and remove plugins, and to revoke a web grant.
 * Toggling/removing is live — unloading a plugin disposes its broker, which
 * removes its menu items immediately.
 */

import { PluginActions } from './plugin-actions.js';
import { CoreEvents } from './event-bus.js';
import { packPlugin, unpackPlugin, looksLikeZip } from './plugin-package.js';

const LS_DISABLED = 'crosstab.plugins.disabled';
const LS_CATALOG = 'crosstab.plugins.catalog';
const LS_CATALOG_V = 'crosstab.plugins.catalogVersion';
const LS_USER = 'crosstab.plugins.user';
const LS_WEB = 'crosstab.plugins.web';

/** Bump when the catalog shape OR built-in manifests' metadata change, so a
 * stale persisted catalog (e.g. missing newly-declared `disciplines`) is dropped
 * and re-probed on next load. */
const CATALOG_VERSION = 10; // 10: catalog records `codecs` (#98)

export class PluginManager {
  /** @type {import('./loader.js').PluginLoader} */
  #loader;
  /** Built-in plugin entry-module URLs. @type {string[]} */
  #urls;
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** ResultsPane#api, for load errors. @type {{appendError: Function}} */
  #results;

  /** Disabled plugin keys (persisted). @type {Set<string>} */
  #disabled;
  /** key → {id, name, category, keywords} learned when a plugin loads (persisted),
   * so disabled/unloaded plugins still show details in the dialog. @type {Object} */
  #catalog;
  /** User-added plugins (persisted): `{key, kind:'url'|'file'|'authored', url?,
   * name?, source?}`. @type {Array<object>} */
  #user;
  /** Manifest ids the user has granted network access (persisted). Every plugin
   * is gated identically — there is no built-in bypass; a grant just means "don't
   * ask again for this plugin." @type {Set<string>} */
  #webAllowed;

  /** In-app plugin creator, attached after construction. @type {?import('./plugin-creator.js').PluginCreator} */
  #creator = null;

  /** Host-side wiring for declarative plugins (menus + invoke). @type {import('./plugin-actions.js').PluginActions} */
  #actions;

  /** Event bus, to announce active-set changes. @type {?import('./event-bus.js').EventBus} */
  #bus = null;

  /** () => string[] : plugin ids the OPEN project references but doesn't have
   * installed — so adding a local plugin that matches one can confirm intent (#102). */
  #projectReferences = null;

  /** Host store for plugin workspace blobs (#93) — to detect/purge a plugin's saved
   * project data when it's deactivated (#118). @type {?import('./workspace-store.js').WorkspaceStore} */
  #workspaceStore = null;

  /** The open project's plugin-association controls (#118): keep a deactivated
   * plugin with the project, or drop it. @type {?{keepPlugin:Function, dropPlugin:Function}} */
  #project = null;

  /** Durable store (OPFS) for added `.ctplugin` package bytes (#119). A packaged
   * plugin's binary assets are too big/binary for localStorage, so the package is
   * kept here and its assets loaded from it on activation. @type {?import('./plugin-package-store.js').PluginPackageStore} */
  #packageStore = null;

  /** key → { assets: Map<string,Uint8Array> } : decoded package assets, cached so a
   * just-added package activates without a second OPFS round-trip. @type {Map<string, {assets: Map}>} */
  #packageCache = new Map();

  /**
   * @param {Object} deps
   * @param {import('./loader.js').PluginLoader} deps.loader
   * @param {string[]} deps.urls - Built-in plugin entry URLs.
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./plugin-actions.js').PluginActions} deps.actions
   * @param {import('./event-bus.js').EventBus} [deps.bus] - To announce active-set
   *   changes (so the project autosave re-records its plugin set).
   * @param {() => string[]} [deps.projectReferences] - The open project's
   *   referenced-but-uninstalled plugin ids (for the add-time conflict prompt).
   * @param {import('./workspace-store.js').WorkspaceStore} [deps.workspaceStore] -
   *   To detect/purge a deactivated plugin's saved project data (#118).
   * @param {{keepPlugin:Function, dropPlugin:Function}} [deps.project] - The open
   *   project's plugin-association controls, to keep or drop a plugin on deactivation (#118).
   * @param {import('./plugin-package-store.js').PluginPackageStore} [deps.packageStore]
   *   - Durable OPFS store for added `.ctplugin` package bytes (#119).
   */
  constructor({ loader, urls, menus, results, actions, bus, projectReferences, workspaceStore, project, packageStore }) {
    this.#loader = loader;
    this.#urls = urls;
    this.#menus = menus;
    this.#results = results;
    this.#actions = actions;
    this.#bus = bus ?? null;
    this.#projectReferences = projectReferences ?? null;
    this.#workspaceStore = workspaceStore ?? null;
    this.#project = project ?? null;
    this.#packageStore = packageStore ?? null;
    this.#disabled = new Set(readJSON(LS_DISABLED, []));
    // Drop a stale catalog if the catalog version changed (e.g. manifests gained
    // `disciplines`), so it's re-probed fresh rather than serving old metadata.
    if (readJSON(LS_CATALOG_V, 0) !== CATALOG_VERSION) {
      writeJSON(LS_CATALOG, {});
      writeJSON(LS_CATALOG_V, CATALOG_VERSION);
    }
    this.#catalog = readJSON(LS_CATALOG, {});
    this.#user = Array.isArray(readJSON(LS_USER, [])) ? readJSON(LS_USER, []) : [];
    this.#webAllowed = readWebGrants(readJSON(LS_WEB, {}));
  }

  /** Has the user granted this plugin (by qualified id) network access? A grant is
   * scoped to specific **origins** the user approved — passing `origin` checks that
   * exact origin; omitting it answers "does this plugin have any grant" (for the
   * manager badge). One "allow" no longer authorises every host (#89). */
  isWebAllowed(id, origin) {
    if (!id) return false;
    const set = this.#webAllowed.get(id);
    if (!set || !set.size) return false;
    return origin == null ? true : set.has(origin);
  }

  /** Remember that the user allowed this plugin to fetch from `origin` (so the same
   * origin isn't asked again). Called by the loader's consent gate after an "allow".
   * A new origin re-prompts — the grant never widens to other hosts on its own. */
  grantWeb(id, origin) {
    if (!id || !origin) return;
    let set = this.#webAllowed.get(id);
    if (!set) this.#webAllowed.set(id, (set = new Set()));
    if (set.has(origin)) return;
    set.add(origin);
    this.#persistWeb();
  }

  /** Forget all of a plugin's network grants — it'll be asked again next time it
   * fetches from any host. */
  revokeWeb(id) {
    if (this.#webAllowed.delete(id)) this.#persistWeb();
  }

  /** Persist the per-plugin origin grants as `{ qualifiedId: [origin, …] }`. */
  #persistWeb() {
    const obj = {};
    for (const [id, set] of this.#webAllowed) if (set.size) obj[id] = [...set];
    writeJSON(LS_WEB, obj);
  }

  activate() {
    this.#menus.register({
      id: 'core:plugins',
      path: ['Edit'],
      label: 'Plugins…',
      order: 40,
      command: () => this.#showDialog(),
    });
  }

  /** Give the manager a handle on the creator (for Create / Edit actions). */
  attachCreator(creator) {
    this.#creator = creator;
  }

  /** Every known plugin as a load descriptor (built-ins first, then user). */
  #entries() {
    const builtins = this.#urls.map((url) => ({ key: url, kind: 'url', url, builtin: true }));
    return [...builtins, ...this.#user];
  }

  /** Load every enabled plugin (built-in + user). Call once at boot. Activations run
   * with a small concurrency cap (not one-at-a-time) so a many-plugin launch is fast,
   * especially offline where each cached fetch + sandbox handshake otherwise serialises
   * into tens of seconds (#120). */
  async activateEnabled() {
    const todo = this.#entries().filter((e) => !this.#disabled.has(e.key));
    await this.#runPool(todo, (e) => this.#activateEntry(e));
  }

  /** Run `fn` over `items` with a small concurrency cap — fast but bounded, so a
   * burst of sandbox handshakes at launch isn't dropped (and {@link #activateEntry}
   * already retries once if one is). Never rejects: `fn` is best-effort. */
  async #runPool(items, fn, limit = 6) {
    const queue = [...items];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await fn(item);
        } catch {
          /* best-effort — #activateEntry/setEnabled already surface their own errors */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  }

  /** Load one entry, recording its manifest in the catalog. Resolves the manifest,
   * or throws (callers that want best-effort use {@link #activateEntry}). */
  async #activateEntryStrict(entry) {
    const originDesc = this.#originDescriptor(entry);
    // A packaged plugin brings its own bundled assets (its WASM/worker/glue) — load
    // them from the stored `.ctplugin` so its declared assets resolve from the bundle
    // (#119). Single-file plugins pass none (null).
    const assets = entry.kind === 'package' ? await this.#loadPackageAssets(entry.key) : null;
    const manifest =
      entry.source != null
        ? await this.#loader.activateSource(entry.source, entry.name || entry.key, originDesc, assets)
        : await this.#loader.activate(entry.url, originDesc);
    this.#recordCatalog(entry.key, manifest);
    // Stamp the broker with this plugin's host-tracked attribution so any output it
    // appends outside an analysis bracket is still traceable, not unattributed (#106).
    const origin = this.#originLabel(entry);
    this.#loader.setAttribution?.(manifest.id, `${manifest.name} · ${origin}`);
    // Declarative plugins are wired host-side (menus/importers/exporters + invoke);
    // legacy plugins self-register in activate(), so this is a no-op for them.
    if (this.#actions && PluginActions.isDeclarative(manifest)) {
      this.#actions.wire(manifest, origin);
    }
    return manifest;
  }

  /** Record a plugin's manifest metadata in the (persisted) catalog, so disabled
   * or not-yet-activated plugins still show full details in the picker. */
  #recordCatalog(key, manifest) {
    this.#catalog[key] = {
      id: manifest.id,
      name: manifest.name,
      category: typeof manifest.category === 'string' ? manifest.category : '',
      keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
      disciplines: Array.isArray(manifest.disciplines) ? manifest.disciplines : [],
      // R packages the plugin declares — used by the offline cache to pre-fetch the
      // dependency closure of the *enabled* plugins.
      rPackages: Array.isArray(manifest.rPackages) ? manifest.rPackages : [],
      // Workspace tabs the plugin declares (#93): [{id, title}]. Recorded so the
      // workspace manager can mount tabs for active workspace plugins.
      workspaces: Array.isArray(manifest.workspaces)
        ? manifest.workspaces.filter((w) => w && typeof w.id === 'string').map((w) => ({ id: w.id, title: String(w.title || w.id) }))
        : [],
      // Streaming format codecs the plugin declares (#98): [{id, label, extensions}].
      codecs: Array.isArray(manifest.codecs)
        ? manifest.codecs
            .filter((c) => c && (c.read || c.write))
            .map((c) => ({ id: c.id || c.label, label: String(c.label || c.id), extensions: Array.isArray(c.extensions) ? c.extensions : [] }))
        : [],
      // The plugin's action labels — the "what you get" list shown on hover in
      // the picker (ellipsis trimmed). Aggregated across ALL the declarative
      // action fields a plugin can expose, so importers/exporters are treated
      // identically to analyses (none is privileged): menu (analyses), imports
      // (file importers), exports (data exporters), outputExports (output exporters).
      menu: ['menu', 'imports', 'exports', 'outputExports', 'codecs']
        .flatMap((k) => (Array.isArray(manifest[k]) ? manifest[k] : []))
        .map((m) => String(m?.label ?? '').replace(/\s*[.…]+\s*$/, ''))
        .filter(Boolean),
    };
    writeJSON(LS_CATALOG, this.#catalog);
  }

  /**
   * Populate the catalog with manifest metadata for every known plugin —
   * including ones the user hasn't activated — by probing their manifests
   * without activating them (no iframe kept alive, no R work). Only probes
   * entries not already cataloged, so it's cheap after the first run. Drives the
   * launcher/picker grouping (category + disciplines) for the full plugin set.
   *
   * @param {(done:number, total:number, name:string)=>void} [onProgress]
   */
  async primeCatalog(onProgress) {
    const todo = this.#entries().filter((e) => !this.#catalog[e.key]?.id);
    let done = 0;
    for (const e of todo) {
      try {
        const originDesc = this.#originDescriptor(e);
        const manifest =
          e.source != null
            ? await this.#loader.probeManifestSource(e.source, e.name || e.key, originDesc)
            : await this.#loader.probeManifest(e.url, originDesc);
        this.#recordCatalog(e.key, manifest);
      } catch (err) {
        console.warn(`Manifest probe failed for ${e.key}`, err);
      }
      onProgress?.(++done, todo.length, this.#catalog[e.key]?.name || e.key);
    }
  }

  /** Origin descriptor for {@link qualifyId} — how the loader namespaces a plugin's
   * id (#102). Built-ins are the reserved namespace; everything else is namespaced
   * by its verifiable host (URL) or self-declared author (file/authored). */
  #originDescriptor(entry) {
    if (entry.builtin) return { kind: 'builtin' };
    if (entry.kind === 'url') return { kind: 'url', url: entry.url };
    // A package is a file you added — namespaced like a file/authored plugin.
    if (entry.kind === 'package') return { kind: 'file' };
    return { kind: entry.kind === 'file' ? 'file' : 'authored' };
  }

  /** Host-tracked origin for output attribution — the part a plugin can't forge. */
  #originLabel(entry) {
    if (entry.builtin) return 'built-in';
    if (entry.kind === 'authored') return 'created here';
    if (entry.kind === 'package') return 'from package';
    if (entry.kind === 'file') return 'from file';
    if (entry.kind === 'url') {
      try {
        return `from ${new URL(entry.url).host}`;
      } catch {
        return 'from URL';
      }
    }
    return 'external';
  }

  /** Decoded bundled assets for a packaged plugin — from the just-added in-memory
   * cache, else unpacked from its stored `.ctplugin` bytes in OPFS (#119). */
  async #loadPackageAssets(key) {
    const cached = this.#packageCache.get(key);
    if (cached) return cached.assets;
    if (!this.#packageStore) throw new Error('Plugin packages require OPFS, which is unavailable here.');
    const bytes = await this.#packageStore.load(key);
    if (!bytes) throw new Error('Plugin package data is missing (browser storage may have been cleared).');
    const { assets } = unpackPlugin(bytes);
    this.#packageCache.set(key, { assets });
    return assets;
  }

  /** Unload a plugin's host-side wiring (menus) + its sandbox. */
  async #unload(id) {
    if (!id) return;
    this.#actions?.unwire(id);
    await this.#loader.unload(id);
  }

  /** Best-effort load (boot/toggle): surfaces errors, never throws. Retries once
   * on failure — bulk loads at launcher start can drop a plugin's sandbox
   * handshake, and a retry is exactly what the user's manual uncheck/re-check did.
   * #instantiate rolls back fully on a throw, so the retry starts clean. */
  async #activateEntry(entry) {
    try {
      return await this.#activateEntryStrict(entry);
    } catch (err1) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        return await this.#activateEntryStrict(entry);
      } catch (err2) {
        console.error(`Failed to load plugin ${entry.key}`, err2);
        this.#results.appendError(`Failed to load plugin ${entry.name || entry.key}: ${err2.message}`);
        return null;
      }
    }
  }

  /**
   * Guard a not-yet-registered entry against a **qualified-id collision** with a
   * plugin already catalogued here (#102). The id is globally unique by
   * construction (origin-namespaced — see {@link qualifyId}), so a clash means the
   * *same* plugin (same host/author + local id) — i.e. you're re-adding or updating
   * it. We confirm a replace rather than silently creating a second registered entry
   * with the same id (which would make project restore ambiguous). Returns the
   * qualified id; throws if the user cancels or the clash is an un-replaceable built-in.
   */
  async #ensureIdAvailable(entry) {
    const originDesc = this.#originDescriptor(entry);
    const probed = entry.source != null
      ? await this.#loader.probeManifestSource(entry.source, entry.name || entry.key, originDesc)
      : await this.#loader.probeManifest(entry.url, originDesc);
    const qid = probed.id;
    const clash = Object.entries(this.#catalog).find(([k, c]) => c?.id === qid && k !== entry.key);
    if (clash) {
      const [clashKey, clashCat] = clash;
      const clashEntry = this.#entries().find((e) => e.key === clashKey);
      if (clashEntry?.builtin) {
        throw new Error(`Plugin id "${qid}" is reserved by a built-in ("${clashCat.name}").`);
      }
      const ok = confirm(`A plugin with id "${qid}" is already installed: "${clashCat.name}".\n\nReplace it with this one?`);
      if (!ok) throw new Error(`Plugin id "${qid}" is already in use by "${clashCat.name}".`);
      await this.removePlugin(clashKey);
      return qid;
    }
    // Adding a LOCAL plugin (file/authored) whose id matches one the OPEN project
    // references but doesn't have installed (#102). Its namespace (author) is
    // self-declared/unverifiable, so the match could be the genuinely-missing plugin
    // (or a compatible upgrade) — or an honest mistake. Ask. (URL plugins skip this:
    // a host-namespaced match is verifiably the same plugin, so it just resolves.)
    if (!entry.builtin && entry.kind !== 'url') {
      const referenced = (this.#projectReferences ? this.#projectReferences() : []) || [];
      if (referenced.includes(qid)) {
        const ok = confirm(
          `Your open project refers to a plugin "${qid}" that isn't installed here.\n\n` +
            `This plugin has the same id. Add it as the one your project is missing ` +
            `(or a compatible upgrade)?\n\nOK = use it for the project · Cancel = stop.`,
        );
        if (!ok) throw new Error(`Cancelled: "${qid}" matches a plugin your open project refers to.`);
      }
    }
    return qid;
  }

  /** Add a plugin from a URL (untrusted, re-fetched each boot). Throws if it
   * doesn't load, so nothing is persisted on failure. */
  async addFromUrl(url) {
    url = String(url || '').trim();
    if (!url) throw new Error('Enter a plugin URL.');
    if (this.#entries().some((e) => e.key === url)) throw new Error('That URL is already added.');
    const entry = { key: url, kind: 'url', url };
    await this.#ensureIdAvailable(entry); // qualified-id uniqueness (#102)
    const manifest = await this.#activateEntryStrict(entry);
    this.#user.push(entry);
    writeJSON(LS_USER, this.#user);
    return manifest;
  }

  /** Add a plugin from a local file (untrusted, source persisted). Accepts either a
   * single `.js` entry module or a multi-file `.ctplugin` package (a ZIP carrying
   * index.js + bundled assets — #119). A package's source is persisted in
   * localStorage like a file plugin; its (possibly large, binary) assets live in the
   * OPFS package store and load on activation. */
  async addFromFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (looksLikeZip(buf)) return this.#addPackage(buf);
    const source = new TextDecoder().decode(buf);
    const entry = { key: `local:${crypto.randomUUID()}`, kind: 'file', name: file.name, source };
    await this.#ensureIdAvailable(entry); // qualified-id uniqueness (#102)
    const manifest = await this.#activateEntryStrict(entry);
    this.#user.push(entry);
    writeJSON(LS_USER, this.#user);
    return manifest;
  }

  /** Add a `.ctplugin` package: unpack it, cache its assets for the immediate
   * activation, then (only once it loads) persist the entry + the raw package bytes
   * to OPFS so it survives reload. Nothing is persisted on failure. */
  async #addPackage(buf) {
    if (!this.#packageStore?.available) {
      throw new Error('Plugin packages need storage (OPFS), which is unavailable in this browser.');
    }
    const { name, indexSource, assets } = unpackPlugin(buf);
    const key = `package:${crypto.randomUUID()}`;
    const entry = { key, kind: 'package', name, source: indexSource };
    this.#packageCache.set(key, { assets }); // so #activateEntryStrict needn't re-read OPFS
    try {
      await this.#ensureIdAvailable(entry); // qualified-id uniqueness (#102)
      const manifest = await this.#activateEntryStrict(entry);
      await this.#packageStore.save(key, buf); // durable: assets survive reload
      this.#user.push(entry);
      writeJSON(LS_USER, this.#user);
      return manifest;
    } catch (err) {
      this.#packageCache.delete(key); // rolled back — leave nothing behind
      throw err;
    }
  }

  /** Create or update an **authored** plugin from editor source. The source is
   * persisted first (so work is never lost), then (re)loaded — a load failure
   * throws (for the creator to show) but leaves the source saved + editable.
   *
   * @param {{name:string, source:string, key?:string}} arg
   * @returns {Promise<{key:string, manifest:object}>}
   */
  async saveAuthored({ name, source, key }) {
    let entry = key ? this.#user.find((e) => e.key === key) : null;
    if (entry) {
      // Editing: unload the previous version so its id frees up for the reload.
      const oldId = this.#catalog[key]?.id;
      if (oldId) {
        try {
          await this.#unload(oldId);
        } catch {
          /* ignore */
        }
      }
      entry.name = name;
      entry.source = source;
    } else {
      entry = { key: `authored:${crypto.randomUUID()}`, kind: 'authored', name, source };
      this.#user.push(entry);
    }
    writeJSON(LS_USER, this.#user); // persist before load — never lose the work
    const manifest = await this.#activateEntryStrict(entry);
    return { key: entry.key, manifest };
  }

  /** The persisted authored/user entry for a key (incl. its source), for editing. */
  getEntry(key) {
    return this.#user.find((e) => e.key === key) ?? null;
  }

  /** Any plugin's entry — built-in or user — keyed by its load key. */
  #entryFor(key) {
    return this.#entries().find((e) => e.key === key) ?? null;
  }

  /** A plugin's source text, for forking. User plugins (authored/file) carry it;
   * built-in and URL plugins are re-fetched from their URL — built-ins are
   * same-origin and URL plugins are CORS-enabled by definition (they loaded). */
  async getSource(key) {
    const e = this.#entryFor(key);
    if (!e) throw new Error('Unknown plugin.');
    if (e.source != null) return e.source;
    if (!e.url) throw new Error('No source available for this plugin.');
    const res = await fetch(e.url);
    if (!res.ok) throw new Error(`couldn’t fetch source (HTTP ${res.status})`);
    return res.text();
  }

  /**
   * Produce a shareable artifact for a plugin (#119): a multi-file plugin (one that
   * declares assets) exports as a `.ctplugin` package bundling its entry + every
   * declared asset; a single-file plugin exports as plain `.js` (the format
   * {@link addFromFile} also accepts). Either re-imports here or on another machine.
   *
   * @param {string} key
   * @returns {Promise<{blob: Blob, filename: string} | {text: string, filename: string}>}
   */
  async exportPlugin(key) {
    const entry = this.#entryFor(key);
    if (!entry) throw new Error('Unknown plugin.');
    const source = await this.getSource(key);
    const manifest = await this.#manifestFor(entry, source);
    const decls = declaredAssets(manifest);
    const slug = pluginSlug(manifest.name || entry.name || 'plugin');
    if (!decls.length) return { text: source, filename: `${slug}.js` }; // single-file
    // Multi-file → bundle each declared asset's bytes alongside the entry.
    const assets = [];
    for (const d of decls) {
      const bytes = await this.#assetBytes(entry, d);
      assets.push({ key: d.path || d.name, bytes });
    }
    const blob = packPlugin({ name: manifest.name, indexSource: source, assets });
    return { blob, filename: `${slug}.ctplugin` };
  }

  /** This plugin's manifest, for export — from its already-decoded package assets if
   * any, else probed from source (cheap; the sandbox just returns the manifest). */
  async #manifestFor(entry, source) {
    const originDesc = this.#originDescriptor(entry);
    return entry.source != null || entry.kind === 'package'
      ? this.#loader.probeManifestSource(source, entry.name || entry.key, originDesc)
      : this.#loader.probeManifest(entry.url, originDesc);
  }

  /** Bytes for one declared asset when packaging a plugin: from the package bundle
   * if it's already a package, else fetched from a same-origin sibling of its entry
   * URL (built-in / URL plugins) — the same resolution the loader uses (#119). */
  async #assetBytes(entry, decl) {
    const want = decl.path || decl.name;
    if (entry.kind === 'package') {
      const assets = await this.#loadPackageAssets(entry.key);
      const b = assets.get(want);
      if (!b) throw new Error(`Package is missing declared asset "${want}".`);
      return b;
    }
    const baseUrl = entry.url || entry.key; // built-in/URL entry module URL
    const target = new URL(want, new URL(baseUrl, location.href));
    const res = await fetch(target.href);
    if (!res.ok) throw new Error(`couldn’t fetch asset "${want}" (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Remove a user plugin entirely (unload + forget). Built-ins can't be removed. */
  async removePlugin(key) {
    const i = this.#user.findIndex((e) => e.key === key);
    if (i < 0) return;
    const id = this.#catalog[key]?.id;
    if (id) {
      try {
        await this.#unload(id);
      } catch {
        /* ignore */
      }
    }
    this.#user.splice(i, 1);
    this.#disabled.delete(key);
    if (id) this.revokeWeb(id); // don't leave a dangling grant for a gone plugin
    delete this.#catalog[key];
    // A package also has bytes in OPFS + a decoded cache — drop both (#119).
    this.#packageCache.delete(key);
    if (this.#packageStore) await this.#packageStore.delete(key).catch(() => {});
    writeJSON(LS_USER, this.#user);
    writeJSON(LS_DISABLED, [...this.#disabled]);
    writeJSON(LS_CATALOG, this.#catalog);
  }

  /** Turn a plugin on/off — persists and applies live (load / unload). */
  async setEnabled(key, enabled) {
    if (enabled) {
      this.#disabled.delete(key);
      writeJSON(LS_DISABLED, [...this.#disabled]);
      if (!this.#isActivated(key)) {
        const entry = this.#entries().find((e) => e.key === key);
        if (entry) await this.#activateEntry(entry);
      }
    } else {
      this.#disabled.add(key);
      writeJSON(LS_DISABLED, [...this.#disabled]);
      const id = this.#catalog[key]?.id;
      if (id) await this.#unload(id);
    }
    // The active set changed — let the project autosave re-record its plugin set.
    // (applyActivatedSet drives this in a loop, so a set-apply emits once per change;
    // all coalesce into a single debounced save.)
    this.#bus?.emit(CoreEvents.PLUGINS_CHANGED);
  }

  #isActivated(key) {
    const id = this.#catalog[key]?.id;
    return id ? this.#loader.list().some((m) => m.id === id) : false;
  }

  /** The plugin's workspace ids that currently hold saved data in the open project
   * (#118). A plugin's data lives in workspace-store blobs keyed by the workspace ids
   * it declares (its `manifest.workspaces`), preserved opaquely by the host. */
  #projectDataIds(key) {
    if (!this.#workspaceStore) return [];
    const wsIds = (this.#catalog[key]?.workspaces || []).map((w) => w.id).filter(Boolean);
    return wsIds.filter((id) => this.#workspaceStore.has(id));
  }

  /**
   * Handle a user un-ticking a plugin in the picker (#118). If it has saved data in
   * the open project, ask what to do with that data before deactivating; otherwise
   * deactivate and forget it from the project's plugin set. The plugin stays
   * **installed** either way — this is project-scoped, not an uninstall (use the ✕
   * button for that). Returns false only when the user cancels.
   *
   * @returns {Promise<boolean>} whether deactivation proceeded.
   */
  async #deactivateFromPicker(p) {
    const dataIds = this.#projectDataIds(p.key);
    if (!dataIds.length) {
      // No project data — deactivate and drop it from the project's plugin set (b).
      await this.setEnabled(p.key, false);
      this.#project?.dropPlugin?.({ key: p.key, id: p.id });
      return true;
    }
    const choice = await this.#promptDeactivateData(p);
    if (choice === 'cancel') return false;
    if (choice === 'delete') {
      // Purge the plugin's project data, then drop it from the plugin set.
      for (const id of dataIds) this.#workspaceStore.set(id, null);
      this.#project?.dropPlugin?.({ key: p.key, id: p.id });
    } else {
      // Keep the data + the project association; just deactivate for this session.
      this.#project?.keepPlugin?.(p.key);
    }
    await this.setEnabled(p.key, false);
    return true;
  }

  /** Three-way prompt shown when deactivating a plugin that has saved data in the
   * open project (#118). Resolves 'delete' | 'keep' | 'cancel'. */
  #promptDeactivateData(p) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'ct-dialog';
      d.innerHTML = `
        <form method="dialog" class="ct-dialog__form">
          <h2 class="ct-dialog__title">Deactivate “${escapeHtml(p.name)}”?</h2>
          <p class="ct-dialog__hint">This plugin has saved data in the current project
            (for example a coding workspace). Deactivating it won't uninstall the plugin —
            it stays available in this list. What should happen to its project data?</p>
          <menu class="ct-dialog__buttons ct-dialog__buttons--stack">
            <button value="keep" type="submit" class="ct-dialog__primary">Keep data, just deactivate for now</button>
            <button value="delete" type="submit" class="ct-dialog__danger">Delete data and remove from project</button>
            <button value="cancel" type="submit">Cancel</button>
          </menu>
        </form>`;
      d.addEventListener('close', () => {
        const v = d.returnValue;
        d.remove();
        resolve(v === 'delete' || v === 'keep' ? v : 'cancel');
      });
      document.body.append(d);
      d.showModal();
    });
  }

  /** The union of R packages declared by the currently-active (loaded) plugins —
   * what the offline cache must pre-fetch (with their dependency closure) so those
   * analyses work with no network. */
  requiredRPackages() {
    const set = new Set();
    for (const p of this.list()) if (p.activated) for (const pkg of p.rPackages || []) set.add(pkg);
    return [...set];
  }

  /** Union of R packages across ALL known plugins (loaded or not) — for the
   * "cache every plugin for offline" option (plan-ahead, larger download). */
  allRPackages() {
    const set = new Set();
    for (const p of this.list()) for (const pkg of p.rPackages || []) set.add(pkg);
    return [...set];
  }

  /** Union of R packages for a given set of plugin load keys — lets the launcher
   * pre-cache for the *selected* (ticked) plugins, which aren't loaded until Start. */
  rPackagesForKeys(keys) {
    const want = new Set(keys || []);
    const set = new Set();
    for (const p of this.list()) if (want.has(p.key)) for (const pkg of p.rPackages || []) set.add(pkg);
    return [...set];
  }

  /** The keys of every currently-active (loaded) plugin — the set a project
   * persists so reopening it restores the same analyses/importers. Uses *loaded*,
   * not merely `enabled`: a plugin can be un-disabled yet never activated (the
   * launcher only loads what was selected), and we want what's actually wired. */
  activatedKeys() {
    return this.list().filter((p) => p.activated).map((p) => p.key);
  }

  /** Drive the active plugin set to exactly `keys` (accepts load keys or manifest
   * ids): load what's wanted-but-inactive, unload what's active-but-unwanted. The
   * shared primitive behind the launcher's picker *and* per-project plugin restore;
   * unknown keys (e.g. a user plugin absent on this machine) are simply skipped. */
  async applyActivatedSet(keys) {
    const want = new Set(keys || []);
    const list = this.list();
    const keySet = new Set();
    for (const p of list) if (want.has(p.key) || (p.id && want.has(p.id))) keySet.add(p.key);
    const toActivate = [];
    const toDeactivate = [];
    for (const p of list) {
      const w = keySet.has(p.key);
      if (w && !p.activated) toActivate.push(p.key);
      // Disable every non-wanted plugin (not just ones currently loaded), so the
      // disabled set is the exact complement of the active set. Otherwise a
      // never-loaded-but-not-disabled plugin reads as "enabled but not loaded" —
      // which the manager (correctly) labels "failed to load", a false alarm.
      else if (!w && p.enabled) toDeactivate.push(p.key);
    }
    // Deactivations are cheap (dispose) and rare at launch — do them first, in order.
    for (const key of toDeactivate) await this.setEnabled(key, false);
    // Activations are the slow part (cached fetch + sandbox handshake + module import
    // + activate). Run them with a concurrency cap instead of one-at-a-time, which cut
    // launch from ~N sequential handshakes to ~N/cap waves — a big win offline (#120).
    await this.#runPool(toActivate, (key) => this.setEnabled(key, true));
  }

  /** All known plugins for the dialog, with state + origin. */
  list() {
    const activated = new Set(this.#loader.list().map((m) => m.id));
    return this.#entries().map((e) => {
      const cat = this.#catalog[e.key];
      return {
        key: e.key,
        builtin: !!e.builtin,
        id: cat?.id ?? null,
        name: cat?.name ?? e.name ?? prettyName(e.url || e.key),
        category: cat?.category || 'Other',
        keywords: cat?.keywords ?? [],
        disciplines: cat?.disciplines ?? [],
        rPackages: cat?.rPackages ?? [],
        menu: cat?.menu ?? [],
        workspaces: cat?.workspaces ?? [],
        codecs: cat?.codecs ?? [],
        url: e.url ?? null, // entry source URL (for the workspace manager to fetch)
        enabled: !this.#disabled.has(e.key),
        activated: cat?.id ? activated.has(cat.id) : false,
        webAllowed: this.isWebAllowed(cat?.id),
        removable: !e.builtin,
        editable: e.kind === 'authored',
        origin: e.builtin ? 'built-in' : e.kind, // 'url' | 'file' | 'authored'
      };
    });
  }

  // --- dialog ----------------------------------------------------------------

  #showDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';
    form.innerHTML = `
      <h2 class="ct-dialog__title">Plugins</h2>
      <p class="ct-dialog__hint">Toggle, add, or remove plugins — changes are live and
        saved across sessions. <strong>Added plugins run sandboxed</strong> (no network
        of their own) but can read the data you load here, so only add ones you trust.</p>
      <div class="ct-plugins__add">
        <button type="button" class="ct-plugins__addbtn" data-act="create">+ Create new…</button>
        <button type="button" class="ct-plugins__addbtn" data-act="url">+ Add from URL…</button>
        <button type="button" class="ct-plugins__addbtn" data-act="file">+ Add from file…</button>
      </div>
      <div class="ct-plugins__filters">
        <select class="ct-plugins__discipline" aria-label="Field / discipline"></select>
        <input type="search" class="ct-plugins__search" placeholder="Search plugins…" autocomplete="off">
      </div>
      <div class="ct-plugins__err" hidden></div>
      <div class="ct-plugins"></div>
      <menu class="ct-dialog__buttons"><button value="close" type="submit" class="ct-dialog__primary">Done</button></menu>`;
    const box = form.querySelector('.ct-plugins');
    const search = form.querySelector('.ct-plugins__search');
    const discSel = form.querySelector('.ct-plugins__discipline');
    const errEl = form.querySelector('.ct-plugins__err');
    const setErr = (msg) => {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    };

    // Discipline filter: pin the plugins a field recommends to the top — the same
    // self-declared `disciplines` the launcher's picker uses.
    const disciplines = [...new Set(this.list().flatMap((p) => p.disciplines || []))].sort();
    discSel.replaceChildren(new Option('All disciplines', 'All'));
    for (const d of disciplines) discSel.append(new Option(d, d));

    const renderGroups = (list) => {
      for (const group of groupByCategory(list)) {
        box.append(el('div', group.category, 'ct-plugins__cat'));
        const ul = el('ul', null, 'ct-plugins__list');
        for (const p of group.items) ul.append(this.#row(p, renderList, setErr));
        box.append(ul);
      }
    };
    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      const disc = discSel.value;
      const items = this.list().filter((p) => matchesQuery(p, q));
      box.replaceChildren();
      if (items.length === 0) {
        box.append(el('p', 'No plugins match your search.', 'ct-plugins__empty'));
        return;
      }
      if (disc && disc !== 'All') {
        const pinned = items.filter((p) => (p.disciplines || []).includes(disc));
        const rest = items.filter((p) => !(p.disciplines || []).includes(disc));
        if (pinned.length) {
          box.append(el('div', `Recommended for ${disc}`, 'ct-plugins__section'));
          renderGroups(pinned);
        }
        box.append(el('div', pinned.length ? 'All other plugins' : 'All plugins', 'ct-plugins__section'));
        renderGroups(rest);
      } else {
        renderGroups(items);
      }
    };
    discSel.addEventListener('change', renderList);

    form.querySelector('[data-act="create"]').addEventListener('click', () => {
      setErr('');
      if (!this.#creator) {
        setErr('The plugin creator is unavailable.');
        return;
      }
      this.#creator.open(null, renderList);
    });
    form.querySelector('[data-act="url"]').addEventListener('click', async () => {
      setErr('');
      const url = await this.#promptUrl();
      if (!url) return;
      try {
        await this.addFromUrl(url);
      } catch (err) {
        setErr(`Couldn’t add ${url}: ${err.message}`);
      }
      renderList();
    });
    form.querySelector('[data-act="file"]').addEventListener('click', async () => {
      setErr('');
      const file = await pickFile();
      if (!file) return;
      try {
        await this.addFromFile(file);
      } catch (err) {
        setErr(`Couldn’t add ${file.name}: ${err.message}`);
      }
      renderList();
    });
    search.addEventListener('input', renderList);
    renderList();

    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
  }

  #row(p, refresh, setErr) {
    const li = el('li', null, 'ct-plugin');

    const label = el('label', null, 'ct-plugin__main');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      setErr('');
      try {
        if (cb.checked) {
          await this.setEnabled(p.key, true);
        } else {
          // Deactivating via the picker: if the plugin has saved project data, ask
          // before discarding it (#118). A cancel restores the checkbox unchanged.
          const proceeded = await this.#deactivateFromPicker(p);
          if (!proceeded) {
            cb.checked = true;
            cb.disabled = false;
            return;
          }
        }
      } catch (err) {
        setErr(`Toggle failed: ${err.message}`);
      }
      refresh();
    });
    label.append(cb, el('span', p.name, 'ct-plugin__name'));

    const right = el('span', null, 'ct-plugin__right');
    const metaText = p.enabled ? (p.activated ? p.origin : 'failed') : 'disabled';
    right.append(el('span', metaText, 'ct-plugin__meta'));

    // Network grant: shown only when the user has allowed this plugin web access;
    // click to revoke (it'll be asked again next time it fetches).
    if (p.webAllowed && p.id) {
      const wb = document.createElement('button');
      wb.type = 'button';
      wb.className = 'ct-plugin__web';
      wb.textContent = '🌐';
      wb.title = 'Network access allowed — click to revoke';
      wb.addEventListener('click', () => {
        setErr('');
        this.revokeWeb(p.id);
        refresh();
      });
      right.append(wb);
    }

    // Fork: open the editor pre-filled with a copy of this plugin's source as a
    // *new* plugin. Available on every row (built-ins are the worked examples).
    if (this.#creator) {
      const fork = document.createElement('button');
      fork.type = 'button';
      fork.className = 'ct-plugin__fork';
      fork.textContent = '⧉';
      fork.title = 'Make an editable copy';
      fork.addEventListener('click', async () => {
        setErr('');
        try {
          const source = await this.getSource(p.key);
          const copyName = `${p.name} (copy)`;
          this.#creator.open({ name: copyName, fromName: p.name, source: forkSource(source, copyName) }, refresh);
        } catch (err) {
          setErr(`Couldn’t copy ${p.name}: ${err.message}`);
        }
      });
      right.append(fork);
    }
    // Export the plugin's source to a .js file — the same format "From file" loads,
    // so a creator can share a plugin a project expects (the missing-plugin case, #102).
    {
      const exp = document.createElement('button');
      exp.type = 'button';
      exp.className = 'ct-plugin__export';
      exp.textContent = '⬇';
      exp.title = 'Export this plugin to a file (shareable; re-add with “From file”). Multi-file plugins export as a .ctplugin package.';
      exp.addEventListener('click', async () => {
        setErr('');
        try {
          const out = await this.exportPlugin(p.key);
          if (out.blob) downloadBlob(out.blob, out.filename);
          else downloadText(out.filename, out.text);
        } catch (err) {
          setErr(`Couldn’t export ${p.name}: ${err.message}`);
        }
      });
      right.append(exp);
    }
    if (p.editable && this.#creator) {
      const ed = document.createElement('button');
      ed.type = 'button';
      ed.className = 'ct-plugin__edit';
      ed.textContent = '✎';
      ed.title = 'Edit this plugin';
      ed.addEventListener('click', () => {
        setErr('');
        const entry = this.getEntry(p.key);
        if (entry) this.#creator.open({ key: entry.key, name: entry.name, source: entry.source }, refresh);
      });
      right.append(ed);
    }
    if (p.removable) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ct-plugin__rm';
      rm.textContent = '✕';
      rm.title = 'Remove this plugin';
      rm.addEventListener('click', async () => {
        setErr('');
        try {
          await this.removePlugin(p.key);
        } catch (err) {
          setErr(`Remove failed: ${err.message}`);
        }
        refresh();
      });
      right.append(rm);
    }

    li.append(label, right);
    return li;
  }

  /** A nested prompt for a plugin URL. Resolves the trimmed URL, or null. */
  #promptUrl() {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'ct-dialog';
      d.innerHTML = `
        <form method="dialog" class="ct-dialog__form">
          <h2 class="ct-dialog__title">Add plugin from URL</h2>
          <p class="ct-dialog__hint">Paste the URL of a plugin's entry module (a <code>.js</code> file).
            A cross-origin URL must be served with CORS enabled by its author (there's no proxy).</p>
          <input name="url" type="url" class="ct-plugins__urlinput" placeholder="https://…/index.js" autocomplete="off">
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">Add</button>
          </menu>
        </form>`;
      d.addEventListener('close', () => {
        const ok = d.returnValue === 'ok';
        const url = d.querySelector('input[name="url"]').value.trim();
        d.remove();
        resolve(ok ? url : null);
      });
      document.body.append(d);
      d.showModal();
      d.querySelector('input').focus();
    });
  }
}

// --- helpers ---------------------------------------------------------------

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

/** A short, collision-resistant hex token. */
function randHex(n) {
  return crypto.randomUUID().replace(/-/g, '').slice(0, n);
}

/** Escape text for safe interpolation into a dialog's innerHTML (plugin names are
 * user/author-supplied). */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Prepare a forked plugin's source so it loads as a *distinct* plugin: give the
 * manifest a fresh `id` (required — the original's id is already taken) and the
 * "(copy)" display name. Both target the first matching manifest literal; the
 * id rewrite is the load-critical one (the only `id:` in a declarative manifest),
 * the name is cosmetic. If the source has no manifest `id`, it wouldn't load
 * anyway and the save-time error will say so. */
function forkSource(source, copyName) {
  let out = source.replace(
    /(\bid\s*:\s*)(['"`])([^'"`]*)\2/,
    (_m, pre, q, old) => `${pre}${q}${(old || 'plugin') + '-copy-' + randHex(6)}${q}`,
  );
  out = out.replace(
    /(\bname\s*:\s*)(['"`])([^'"`]*)\2/,
    (_m, pre, q) => `${pre}${q}${copyName.replace(new RegExp(q, 'g'), '\\' + q)}${q}`,
  );
  return out;
}

/** Download `text` as a file (used to export a plugin's source). */
function downloadText(filename, text) {
  downloadBlob(new Blob([text], { type: 'text/javascript;charset=utf-8' }), filename);
}

/** Download a Blob as a file (used to export a `.ctplugin` package). */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Every asset a manifest declares (top-level `assets` + each codec's `assets`) —
 * the plugin's own dependency list, used to decide single-file vs package export. */
function declaredAssets(manifest) {
  const out = [];
  const push = (list) => {
    if (Array.isArray(list)) for (const a of list) if (a && a.name) out.push(a);
  };
  push(manifest?.assets);
  for (const c of manifest?.codecs || []) push(c?.assets);
  return out;
}

/** Filesystem-safe slug for a plugin export filename. */
function pluginSlug(name) {
  return (
    String(name || 'plugin')
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'plugin'
  );
}

/** Open a file picker for a plugin source file. Resolves the File, or null. */
function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.mjs,.ctplugin,.zip,text/javascript,application/zip';
    input.style.display = 'none';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Does a plugin match the search query? Matches across name, id, category, and
 * keywords — so an oddly-named plugin is still found by what it does. */
function matchesQuery(p, q) {
  if (!q) return true;
  const hay = [p.name, p.id, p.category, ...(p.keywords || [])].join(' ').toLowerCase();
  return hay.includes(q);
}

/** Group plugins into category sections, BOTH categories and the plugins within
 * each sorted alphabetically — predictable for discovery (matches the launcher). */
function groupByCategory(items) {
  const byCat = new Map();
  for (const p of items) {
    const c = p.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  return [...byCat.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ category: c, items: byCat.get(c).sort((x, y) => (x.name || '').localeCompare(y.name || '')) }));
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable / full — choices just won't persist */
  }
}

/** Parse persisted web grants into `Map<qualifiedId, Set<origin>>`. The current
 * format is `{ id: [origin, …] }`. The legacy v1 format was a flat `[id, …]` array
 * (a per-plugin *boolean* "any URL" grant); that is intentionally dropped on read
 * so an over-broad old grant becomes a one-time re-prompt rather than silently
 * carrying forward unbounded host access (#89). */
function readWebGrants(raw) {
  const m = new Map();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, origins] of Object.entries(raw)) {
      if (Array.isArray(origins)) {
        const set = new Set(origins.filter((o) => typeof o === 'string' && o));
        if (set.size) m.set(id, set);
      }
    }
  }
  return m;
}

/** A readable fallback name from a plugin URL (used only if it never loaded). */
function prettyName(url) {
  const m = String(url).match(/([^/]+)\/index\.js$/);
  return (m ? m[1] : url).replace(/^builtin-/, '').replace(/-/g, ' ');
}
