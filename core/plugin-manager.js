/**
 * @file plugin-manager.js
 * Enable/disable the installed plugins — **host-owned** management of the plugin
 * lifecycle (it drives the loader and persists which plugins are off; a sandboxed
 * plugin has no handle on the loader or other plugins, so this can't be a plugin).
 *
 * It owns the catalog of known plugin URLs (the built-in set), loads the enabled
 * ones at boot, and exposes **Edit ▸ Plugins…** — a dialog where each plugin can
 * be toggled. Toggling is **live**: disabling unloads the plugin (its broker
 * disposer removes its menu items/exporters immediately); enabling loads it. The
 * disabled set persists in localStorage, so choices survive a reload.
 */

const LS_DISABLED = 'crosstab.plugins.disabled';
const LS_CATALOG = 'crosstab.plugins.catalog';

export class PluginManager {
  /** @type {import('./loader.js').PluginLoader} */
  #loader;
  /** Known plugin entry-module URLs (the built-in set). @type {string[]} */
  #urls;
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** ResultsPane#api, for load errors. @type {{appendError: Function}} */
  #results;

  /** Disabled plugin URLs (persisted). @type {Set<string>} */
  #disabled;
  /** url → {id, name} learned when a plugin loads (persisted), so disabled
   * (unloaded) plugins still show a friendly name in the dialog. @type {Object} */
  #catalog;

  /**
   * @param {Object} deps
   * @param {import('./loader.js').PluginLoader} deps.loader
   * @param {string[]} deps.urls - Built-in plugin entry URLs.
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   */
  constructor({ loader, urls, menus, results }) {
    this.#loader = loader;
    this.#urls = urls;
    this.#menus = menus;
    this.#results = results;
    this.#disabled = new Set(readJSON(LS_DISABLED, []));
    this.#catalog = readJSON(LS_CATALOG, {});
  }

  /** Register the Edit ▸ Plugins… entry. */
  activate() {
    this.#menus.register({
      id: 'core:plugins',
      path: ['Edit'],
      label: 'Plugins…',
      order: 40,
      command: () => this.#showDialog(),
    });
  }

  /** Load every enabled plugin (skips the disabled set). Call once at boot. */
  async loadEnabled() {
    for (const url of this.#urls) {
      if (this.#disabled.has(url)) continue;
      await this.#loadOne(url);
    }
  }

  async #loadOne(url) {
    try {
      const manifest = await this.#loader.load(url);
      this.#catalog[url] = {
        id: manifest.id,
        name: manifest.name,
        category: typeof manifest.category === 'string' ? manifest.category : '',
        keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
      };
      writeJSON(LS_CATALOG, this.#catalog);
      return true;
    } catch (err) {
      console.error(`Failed to load plugin ${url}`, err);
      this.#results.appendError(`Failed to load plugin ${url}: ${err.message}`);
      return false;
    }
  }

  /** Known plugins for the dialog: every URL with its enabled/loaded state, plus
   * the category/keywords cached from the manifest (for grouping + search). */
  list() {
    const loaded = new Set(this.#loader.list().map((m) => m.id));
    return this.#urls.map((url) => {
      const cat = this.#catalog[url];
      return {
        url,
        id: cat?.id ?? null,
        name: cat?.name ?? prettyName(url),
        category: cat?.category || 'Other',
        keywords: cat?.keywords ?? [],
        enabled: !this.#disabled.has(url),
        loaded: cat?.id ? loaded.has(cat.id) : false,
      };
    });
  }

  /** Turn a plugin on/off — persists and applies live (load / unload). */
  async setEnabled(url, enabled) {
    if (enabled) {
      this.#disabled.delete(url);
      writeJSON(LS_DISABLED, [...this.#disabled]);
      if (!this.#isLoaded(url)) await this.#loadOne(url);
    } else {
      this.#disabled.add(url);
      writeJSON(LS_DISABLED, [...this.#disabled]);
      const id = this.#catalog[url]?.id;
      if (id) await this.#loader.unload(id);
    }
  }

  #isLoaded(url) {
    const id = this.#catalog[url]?.id;
    return id ? this.#loader.list().some((m) => m.id === id) : false;
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
      <p class="ct-dialog__hint">Turn plugins on or off — disabling one removes its
        menu items right away; choices are saved across sessions. Grouped by category;
        search matches names <em>and</em> keywords.</p>
      <input type="search" class="ct-plugins__search" placeholder="Search plugins…" autocomplete="off">
      <div class="ct-plugins"></div>
      <menu class="ct-dialog__buttons"><button value="close" type="submit" class="ct-dialog__primary">Done</button></menu>`;
    const box = form.querySelector('.ct-plugins');
    const search = form.querySelector('.ct-plugins__search');

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
        for (const p of group.items) ul.append(this.#row(p, renderList));
        box.append(ul);
      }
    };
    // Preserve scroll/focus across re-renders triggered by toggles vs. typing:
    search.addEventListener('input', renderList);
    renderList();

    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
  }

  #row(p, refresh) {
    const li = document.createElement('li');
    li.className = 'ct-plugin';

    const label = document.createElement('label');
    label.className = 'ct-plugin__main';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        await this.setEnabled(p.url, cb.checked);
      } catch (err) {
        this.#results.appendError(`Plugin toggle failed: ${err.message}`);
      }
      refresh();
    });
    const name = document.createElement('span');
    name.className = 'ct-plugin__name';
    name.textContent = p.name;
    label.append(cb, name);

    const meta = document.createElement('span');
    meta.className = 'ct-plugin__meta';
    meta.textContent = p.enabled ? (p.loaded ? p.id ?? '' : 'failed to load') : 'disabled';

    li.append(label, meta);
    return li;
  }
}

// --- helpers ---------------------------------------------------------------

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
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
