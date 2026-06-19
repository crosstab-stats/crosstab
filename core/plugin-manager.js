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
      this.#catalog[url] = { id: manifest.id, name: manifest.name };
      writeJSON(LS_CATALOG, this.#catalog);
      return true;
    } catch (err) {
      console.error(`Failed to load plugin ${url}`, err);
      this.#results.appendError(`Failed to load plugin ${url}: ${err.message}`);
      return false;
    }
  }

  /** Known plugins for the dialog: every URL with its enabled/loaded state. */
  list() {
    const loaded = new Set(this.#loader.list().map((m) => m.id));
    return this.#urls.map((url) => {
      const cat = this.#catalog[url];
      return {
        url,
        id: cat?.id ?? null,
        name: cat?.name ?? prettyName(url),
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
      <p class="ct-dialog__hint">Turn built-in plugins on or off. Disabling one removes
        its menu items right away; your choices are saved across sessions.</p>
      <ul class="ct-plugins"></ul>
      <menu class="ct-dialog__buttons"><button value="close" type="submit" class="ct-dialog__primary">Done</button></menu>`;
    const ul = form.querySelector('.ct-plugins');

    const renderList = () => {
      ul.replaceChildren();
      for (const p of this.list()) ul.append(this.#row(p, renderList));
    };
    renderList();

    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
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
