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

const LS_DISABLED = 'crosstab.plugins.disabled';
const LS_CATALOG = 'crosstab.plugins.catalog';
const LS_CATALOG_V = 'crosstab.plugins.catalogVersion';
const LS_USER = 'crosstab.plugins.user';
const LS_WEB = 'crosstab.plugins.web';

/** Bump when the catalog shape OR built-in manifests' metadata change, so a
 * stale persisted catalog (e.g. missing newly-declared `disciplines`) is dropped
 * and re-probed on next load. */
const CATALOG_VERSION = 3;

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

  /**
   * @param {Object} deps
   * @param {import('./loader.js').PluginLoader} deps.loader
   * @param {string[]} deps.urls - Built-in plugin entry URLs.
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./plugin-actions.js').PluginActions} deps.actions
   */
  constructor({ loader, urls, menus, results, actions }) {
    this.#loader = loader;
    this.#urls = urls;
    this.#menus = menus;
    this.#results = results;
    this.#actions = actions;
    this.#disabled = new Set(readJSON(LS_DISABLED, []));
    // Drop a stale catalog if the catalog version changed (e.g. manifests gained
    // `disciplines`), so it's re-probed fresh rather than serving old metadata.
    if (readJSON(LS_CATALOG_V, 0) !== CATALOG_VERSION) {
      writeJSON(LS_CATALOG, {});
      writeJSON(LS_CATALOG_V, CATALOG_VERSION);
    }
    this.#catalog = readJSON(LS_CATALOG, {});
    this.#user = Array.isArray(readJSON(LS_USER, [])) ? readJSON(LS_USER, []) : [];
    this.#webAllowed = new Set(readJSON(LS_WEB, []));
  }

  /** Has the user granted this plugin (by manifest id) network access? */
  isWebAllowed(id) {
    return !!id && this.#webAllowed.has(id);
  }

  /** Remember that the user allowed this plugin network access (so it isn't asked
   * again). Called by the loader's consent gate after an "allow". */
  grantWeb(id) {
    if (!id || this.#webAllowed.has(id)) return;
    this.#webAllowed.add(id);
    writeJSON(LS_WEB, [...this.#webAllowed]);
  }

  /** Forget a network grant — the plugin will be asked again next time it fetches. */
  revokeWeb(id) {
    if (this.#webAllowed.delete(id)) writeJSON(LS_WEB, [...this.#webAllowed]);
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

  /** Load every enabled plugin (built-in + user). Call once at boot. */
  async loadEnabled() {
    for (const e of this.#entries()) {
      if (this.#disabled.has(e.key)) continue;
      await this.#loadEntry(e);
    }
  }

  /** Load one entry, recording its manifest in the catalog. Resolves the manifest,
   * or throws (callers that want best-effort use {@link #loadEntry}). */
  async #loadEntryStrict(entry) {
    const manifest =
      entry.source != null
        ? await this.#loader.loadSource(entry.source, entry.name || entry.key)
        : await this.#loader.load(entry.url);
    this.#recordCatalog(entry.key, manifest);
    // Declarative plugins are wired host-side (menus/importers/exporters + invoke);
    // legacy plugins self-register in activate(), so this is a no-op for them.
    if (this.#actions && PluginActions.isDeclarative(manifest)) {
      this.#actions.wire(manifest, this.#originLabel(entry));
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
        const manifest =
          e.source != null
            ? await this.#loader.probeManifestSource(e.source, e.name || e.key)
            : await this.#loader.probeManifest(e.url);
        this.#recordCatalog(e.key, manifest);
      } catch (err) {
        console.warn(`Manifest probe failed for ${e.key}`, err);
      }
      onProgress?.(++done, todo.length, this.#catalog[e.key]?.name || e.key);
    }
  }

  /** Host-tracked origin for output attribution — the part a plugin can't forge. */
  #originLabel(entry) {
    if (entry.builtin) return 'built-in';
    if (entry.kind === 'authored') return 'created here';
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

  /** Unload a plugin's host-side wiring (menus) + its sandbox. */
  async #unload(id) {
    if (!id) return;
    this.#actions?.unwire(id);
    await this.#loader.unload(id);
  }

  /** Best-effort load (boot/toggle): surfaces errors, never throws. */
  async #loadEntry(entry) {
    try {
      return await this.#loadEntryStrict(entry);
    } catch (err) {
      console.error(`Failed to load plugin ${entry.key}`, err);
      this.#results.appendError(`Failed to load plugin ${entry.name || entry.key}: ${err.message}`);
      return null;
    }
  }

  /** Add a plugin from a URL (untrusted, re-fetched each boot). Throws if it
   * doesn't load, so nothing is persisted on failure. */
  async addFromUrl(url) {
    url = String(url || '').trim();
    if (!url) throw new Error('Enter a plugin URL.');
    if (this.#entries().some((e) => e.key === url)) throw new Error('That URL is already added.');
    const entry = { key: url, kind: 'url', url };
    const manifest = await this.#loadEntryStrict(entry);
    this.#user.push(entry);
    writeJSON(LS_USER, this.#user);
    return manifest;
  }

  /** Add a plugin from a local file (untrusted, source persisted). */
  async addFromFile(file) {
    const source = await file.text();
    const entry = { key: `local:${crypto.randomUUID()}`, kind: 'file', name: file.name, source };
    const manifest = await this.#loadEntryStrict(entry);
    this.#user.push(entry);
    writeJSON(LS_USER, this.#user);
    return manifest;
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
    const manifest = await this.#loadEntryStrict(entry);
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
    writeJSON(LS_USER, this.#user);
    writeJSON(LS_DISABLED, [...this.#disabled]);
    writeJSON(LS_CATALOG, this.#catalog);
  }

  /** Turn a plugin on/off — persists and applies live (load / unload). */
  async setEnabled(key, enabled) {
    if (enabled) {
      this.#disabled.delete(key);
      writeJSON(LS_DISABLED, [...this.#disabled]);
      if (!this.#isLoaded(key)) {
        const entry = this.#entries().find((e) => e.key === key);
        if (entry) await this.#loadEntry(entry);
      }
    } else {
      this.#disabled.add(key);
      writeJSON(LS_DISABLED, [...this.#disabled]);
      const id = this.#catalog[key]?.id;
      if (id) await this.#unload(id);
    }
  }

  #isLoaded(key) {
    const id = this.#catalog[key]?.id;
    return id ? this.#loader.list().some((m) => m.id === id) : false;
  }

  /** All known plugins for the dialog, with state + origin. */
  list() {
    const loaded = new Set(this.#loader.list().map((m) => m.id));
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
        enabled: !this.#disabled.has(e.key),
        loaded: cat?.id ? loaded.has(cat.id) : false,
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
      <input type="search" class="ct-plugins__search" placeholder="Search plugins…" autocomplete="off">
      <div class="ct-plugins__err" hidden></div>
      <div class="ct-plugins"></div>
      <menu class="ct-dialog__buttons"><button value="close" type="submit" class="ct-dialog__primary">Done</button></menu>`;
    const box = form.querySelector('.ct-plugins');
    const search = form.querySelector('.ct-plugins__search');
    const errEl = form.querySelector('.ct-plugins__err');
    const setErr = (msg) => {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    };

    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      const items = this.list().filter((p) => matchesQuery(p, q));
      box.replaceChildren();
      if (items.length === 0) {
        box.append(el('p', 'No plugins match your search.', 'ct-plugins__empty'));
        return;
      }
      for (const group of groupByCategory(items)) {
        box.append(el('div', group.category, 'ct-plugins__cat'));
        const ul = el('ul', null, 'ct-plugins__list');
        for (const p of group.items) ul.append(this.#row(p, renderList, setErr));
        box.append(ul);
      }
    };

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
        await this.setEnabled(p.key, cb.checked);
      } catch (err) {
        setErr(`Toggle failed: ${err.message}`);
      }
      refresh();
    });
    label.append(cb, el('span', p.name, 'ct-plugin__name'));

    const right = el('span', null, 'ct-plugin__right');
    const metaText = p.enabled ? (p.loaded ? p.origin : 'failed to load') : 'disabled';
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

/** Open a file picker for a plugin source file. Resolves the File, or null. */
function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.mjs,text/javascript';
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

/** The **recommended category vocabulary**, in display order — the convention we
 * model so the plugin list stays legible as it grows (rather than one giant
 * "Analysis" bucket). Analyses are grouped by *method family*, mirroring the
 * Analyze ▸ … submenus. A plugin may use any string; unrecognised categories sort
 * alphabetically after these (a gentle nudge toward the standard vocabulary), and
 * the catch-all "Other" goes last. Kept in sync with the manifest `category` doc
 * in loader.js. */
const CATEGORY_ORDER = [
  'Import',
  'Descriptive Statistics',
  'Comparison',
  'Correlation',
  'Regression',
  'Multivariate',
  'Time Series',
  'Resampling',
  'Graphs',
  'Export',
];
function categoryRank(c) {
  if (c === 'Other') return 1000;
  const i = CATEGORY_ORDER.indexOf(c);
  return i >= 0 ? i : 500;
}

/** Group plugins into ordered category sections. */
function groupByCategory(items) {
  const byCat = new Map();
  for (const p of items) {
    const c = p.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  return [...byCat.keys()]
    .sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
    .map((c) => ({ category: c, items: byCat.get(c) }));
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

/** A readable fallback name from a plugin URL (used only if it never loaded). */
function prettyName(url) {
  const m = String(url).match(/([^/]+)\/index\.js$/);
  return (m ? m[1] : url).replace(/^builtin-/, '').replace(/-/g, ' ');
}
