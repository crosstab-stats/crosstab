/**
 * @file app.js
 * Composition root. Wires the core modules together, mounts the shell UI, seeds
 * a temporary demo dataset, and loads the built-in plugins.
 *
 * This is the only place that knows about every module at once. Everything below
 * it talks through narrow interfaces (the event bus and the published service
 * APIs), which is what keeps the architecture pluggable. If you want to
 * understand how the pieces fit, read this file top to bottom.
 */

import { EventBus, CoreEvents } from './event-bus.js';
import { DataStore } from './data-store.js';
import { DuckDBManager } from './duckdb-manager.js';
import { WebRManager } from './webr-manager.js';
import { ResultsPane } from './results-pane.js';
import { MenuShell } from './menu-shell.js';
import { UiService } from './ui-service.js';
import { PluginLoader } from './loader.js';
import { makeDemoDataset } from './demo-data.js';

/**
 * URLs of the built-in plugins to load at startup. These load through the exact
 * same sandboxed-iframe path as any third-party plugin (see loader.js) — there
 * is no privileged loader. Adding a built-in analysis is just adding an entry
 * here. URLs are fetched by the host, so they are resolved relative to the
 * document (index.html), not this module.
 * @type {string[]}
 */
const BUILTIN_PLUGINS = ['./plugins/builtin-frequencies/index.js'];

/**
 * Boot the application into the given root element.
 *
 * @param {Object} mounts
 * @param {HTMLElement} mounts.menubar - Host for the menubar.
 * @param {HTMLElement} mounts.sidebar - Host for the variables list.
 * @param {HTMLElement} mounts.results - Host for the results pane shadow root.
 * @param {HTMLElement} mounts.status - Small status/health line.
 * @returns {Promise<object>} The assembled engine (handy for console debugging).
 */
export async function boot(mounts) {
  // --- core services ---------------------------------------------------------
  const bus = new EventBus();
  const duckdb = new DuckDBManager();
  const dataStore = new DataStore(bus, duckdb);
  const webr = new WebRManager(
    {
      bus,
      getColumns: (opts) => dataStore.getColumns(opts),
      getInjectionParquet: (opts) => dataStore.getInjectionParquet(opts),
    },
    { preloadPackages: [] }, // built-in plugins declare their own R deps
  );
  const results = new ResultsPane(mounts.results);
  const menus = new MenuShell(mounts.menubar);
  const ui = new UiService(dataStore);

  // The service bundle the plugin broker dispatches against. `data`/`results`/
  // `menus`/`ui` expose only their published `api` slices, never the full class
  // instances; `webr` and `bus` are passed directly (the broker exposes a
  // reviewed subset of each — see plugin-broker.js `buildDispatch`).
  const services = {
    bus,
    data: dataStore.api,
    webr,
    results: results.api,
    menus: menus.api,
    ui: ui.api,
  };
  const loader = new PluginLoader(services);

  // --- shell wiring ----------------------------------------------------------
  wireStatusLine(bus, mounts.status, webr);
  const sidebar = new VariablesSidebar(mounts.sidebar, dataStore);
  bus.on(CoreEvents.DATA_CHANGED, () => sidebar.render());
  bus.on(CoreEvents.SELECTION_CHANGED, () => sidebar.renderSelection());

  // --- seed data + warm up the runtimes, in parallel -------------------------
  // The two WASM runtimes are independent, so load them concurrently rather than
  // serially: `setDataset` cold-starts DuckDB; `webr.preload()` cold-starts R.
  // We only need DuckDB up before continuing (plugins/UI read data), so we await
  // the data load and let WebR keep warming in the background.
  mounts.status.textContent = 'Loading data engine…';
  const dataReady = dataStore.setDataset(makeDemoDataset());
  webr.preload().catch((err) => console.warn('WebR preload failed', err));
  await dataReady;

  // --- load built-in plugins -------------------------------------------------
  for (const url of BUILTIN_PLUGINS) {
    try {
      const manifest = await loader.load(url);
      console.info(`Loaded plugin: ${manifest.name} (${manifest.id})`);
    } catch (err) {
      console.error(`Failed to load plugin ${url}`, err);
      results.appendError(`Failed to load plugin ${url}: ${err.message}`);
    }
  }

  const engine = { bus, dataStore, duckdb, webr, results, menus, loader, services };
  // Expose for manual poking in the console during early development.
  // eslint-disable-next-line no-undef
  globalThis.crosstab = engine;
  return engine;
}

/**
 * Keep a small status line in sync with WebR readiness and job activity, so the
 * user has feedback during the (potentially slow) first R load.
 *
 * @param {EventBus} bus
 * @param {HTMLElement} el
 * @param {WebRManager} webr
 */
function wireStatusLine(bus, el, webr) {
  const set = (text) => {
    el.textContent = text;
  };
  set('R runtime: not yet loaded');
  bus.on(CoreEvents.WEBR_READY, () => set('R runtime: ready'));
  bus.on(CoreEvents.WEBR_JOB, ({ status, kind }) => {
    if (status === 'started') set(`R runtime: running ${kind}…`);
    else if (status === 'finished') set('R runtime: ready');
    else if (status === 'failed') set(`R runtime: ${kind} failed`);
  });
  if (webr.isReady) set('R runtime: ready');
}

/**
 * The left-hand variable list. Clicking a variable toggles its membership in the
 * dataset's selection, which analyses read via `app.data.getSelectedVariables()`.
 * This is intentionally minimal — a stand-in for the eventual data editor — but
 * it exercises the selection half of the data API end to end.
 */
class VariablesSidebar {
  /** @param {HTMLElement} host @param {DataStore} store */
  constructor(host, store) {
    this.host = host;
    this.store = store;
    this.render();
  }

  render() {
    this.host.replaceChildren();
    const heading = document.createElement('h2');
    heading.className = 'sidebar__title';
    heading.textContent = 'Variables';
    this.host.append(heading);

    const list = document.createElement('ul');
    list.className = 'sidebar__list';
    const selected = new Set(this.store.getSelectedVariables());

    const allMeta = this.store.getVariableMeta();
    if (allMeta.length === 0) {
      // Cold start: the data engine (DuckDB) is still loading; no variables yet.
      const note = document.createElement('p');
      note.className = 'sidebar__empty';
      note.textContent = 'Loading data…';
      this.host.append(note);
      return;
    }

    for (const meta of allMeta) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar__var';
      btn.dataset.var = meta.name;
      btn.setAttribute('aria-pressed', String(selected.has(meta.name)));
      btn.title = `${meta.name} · ${meta.type} · ${meta.measurementLevel ?? ''}`;
      btn.innerHTML =
        `<span class="sidebar__var-label">${escapeHtml(meta.label ?? meta.name)}</span>` +
        `<span class="sidebar__var-name">${escapeHtml(meta.name)}</span>`;
      btn.addEventListener('click', () => this.toggle(meta.name));
      li.append(btn);
      list.append(li);
    }
    this.host.append(list);
  }

  /** Re-sync only the pressed state (cheaper than a full re-render). */
  renderSelection() {
    const selected = new Set(this.store.getSelectedVariables());
    for (const btn of this.host.querySelectorAll('.sidebar__var')) {
      btn.setAttribute('aria-pressed', String(selected.has(btn.dataset.var)));
    }
  }

  toggle(name) {
    const selected = new Set(this.store.getSelectedVariables());
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    this.store.setSelectedVariables([...selected]);
  }
}

/** Escape a string for safe interpolation into innerHTML. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
