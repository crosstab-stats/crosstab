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
import { DatasetManager, DATASETS_CHANGED } from './dataset-manager.js';
import { DuckDBManager } from './duckdb-manager.js';
import { WebRManager } from './webr-manager.js';
import { ResultsPane } from './results-pane.js';
import { MenuShell } from './menu-shell.js';
import { UiService } from './ui-service.js';
import { ImportService } from './import-service.js';
import { ExportService } from './export-service.js';
import { DatasetStore } from './dataset-store.js';
import { DatasetLibrary } from './library.js';
import { ProjectStore } from './project-store.js';
import { ProjectSync, PROJECT_CHANGED } from './project-sync.js';
import { DataView, VariableView } from './data-views.js';
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
const BUILTIN_PLUGINS = [
  './plugins/builtin-csv-import/index.js',
  './plugins/builtin-haven-import/index.js',
  './plugins/builtin-frequencies/index.js',
  './plugins/builtin-descriptives/index.js',
  './plugins/builtin-crosstabs/index.js',
  './plugins/builtin-regression/index.js',
  './plugins/builtin-fred/index.js',
  './plugins/builtin-wikipedia/index.js',
  './plugins/builtin-csv-export/index.js',
  './plugins/builtin-correlation/index.js',
  './plugins/builtin-logistic/index.js',
  './plugins/builtin-plots/index.js',
  './plugins/builtin-bootstrap/index.js',
];

/**
 * Host-side network fetch exposed to plugins as `app.web`. The engine performs
 * the fetch from the host origin (more reliable than a sandboxed iframe's
 * opaque-origin request). Only enables "web" data-source importers; cross-origin
 * targets still need CORS (or a proxy). Restricted to http(s) GET.
 *
 * @type {Readonly<{ get: (url: string) => Promise<{ok: boolean, status: number, text: string}> }>}
 */
const webService = Object.freeze({
  get: async (url) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('web.get: only http(s) URLs');
    const res = await fetch(String(url));
    return { ok: res.ok, status: res.status, text: await res.text() };
  },
});

/**
 * Boot the application into the given root element.
 *
 * @param {Object} mounts
 * @param {HTMLElement} mounts.menubar - Host for the menubar.
 * @param {HTMLElement} mounts.sidebar - Host for the variables list.
 * @param {HTMLElement} mounts.results - Host for the results pane shadow root.
 * @param {HTMLElement} mounts.status - Small status/health line.
 * @param {HTMLElement} [mounts.busy] - Optional "working" indicator overlay.
 * @param {HTMLElement} [mounts.tabs] - Workspace tab bar.
 * @param {HTMLElement} [mounts.viewData] - Host for the Data View grid.
 * @param {HTMLElement} [mounts.viewVars] - Host for the Variable View.
 * @returns {Promise<object>} The assembled engine (handy for console debugging).
 */
export async function boot(mounts) {
  // --- core services ---------------------------------------------------------
  const bus = new EventBus();
  const duckdb = new DuckDBManager();
  // `datasets` owns the open datasets and presents the active one through the
  // same surface a single DataStore used to (it delegates). Everything that used
  // to hold "the dataset" now holds the manager.
  const datasets = new DatasetManager(bus, duckdb);
  // Create the first (empty) dataset up front so there's always an active dataset
  // for the UI to render against; its data is loaded below.
  datasets.add('Demo data', { activate: true });
  const webr = new WebRManager(
    {
      bus,
      getColumns: (opts) => datasets.getColumns(opts),
      getInjectionParquet: (opts) => datasets.getInjectionParquet(opts),
    },
    { preloadPackages: [] }, // built-in plugins declare their own R deps
  );
  const results = new ResultsPane(mounts.results);
  const menus = new MenuShell(mounts.menubar);
  const ui = new UiService(datasets);
  const importers = new ImportService({ menus, data: datasets, results: results.api, bus });
  const exporters = new ExportService({ menus, data: datasets, results: results.api, bus });
  const datasetStore = new DatasetStore();

  // The service bundle the plugin broker dispatches against. `data`/`results`/
  // `menus`/`ui` expose only their published `api` slices, never the full class
  // instances; `webr` and `bus` are passed directly (the broker exposes a
  // reviewed subset of each — see plugin-broker.js `buildDispatch`).
  const services = {
    bus,
    data: datasets.api,
    transform: datasets.transformApi,
    webr,
    results: results.api,
    menus: menus.api,
    ui: ui.api,
    importers: importers.api,
    exporters: exporters.api,
    web: webService,
  };
  const loader = new PluginLoader(services);

  // --- shell wiring ----------------------------------------------------------
  wireStatusLine(bus, mounts.status, webr);
  if (mounts.busy) wireBusyIndicator(bus, mounts.busy);
  // The sidebar is the project navigator: the project name + its datasets (switch
  // active / add / remove / rename). Variable selection lives in the grid headers.
  new ProjectSidebar(mounts.sidebar, datasets, bus);

  // Tabbed workspace: Data View (grid) / Variable View / Output (results pane).
  if (mounts.viewData && mounts.viewVars && mounts.tabs) {
    const dataView = new DataView(mounts.viewData, datasets);
    const variableView = new VariableView(mounts.viewVars, datasets);
    wireWorkspaceTabs(bus, mounts, { dataView, variableView, results: mounts.results });
    // Keep the grid's header checkboxes in step when selection changes elsewhere
    // (e.g. the sidebar) — both surfaces drive the one shared selection.
    bus.on(CoreEvents.SELECTION_CHANGED, () => dataView.syncSelection());
  }
  const clearBtn = document.getElementById('clear-output');
  if (clearBtn) clearBtn.addEventListener('click', () => results.clear());

  // Edit ▸ Undo / Redo over the transform log. Host-owned (like the data grid),
  // not a plugin — registered through the same `menus.register` everything uses.
  // No-ops when there's nothing to undo/redo; the views refresh on DATA_CHANGED.
  menus.register({
    id: 'core:undo',
    path: ['Edit'],
    label: 'Undo',
    order: 10,
    command: () => void datasets.undo(),
  });
  menus.register({
    id: 'core:redo',
    path: ['Edit'],
    label: 'Redo',
    order: 20,
    command: () => void datasets.redo(),
  });

  // Dataset library (OPFS), tier 2: reusable building blocks — explicit
  // "Save dataset to library" / "Add dataset from library". No autosave here;
  // the project tier (below) owns autosave.
  const library = new DatasetLibrary({
    datasetStore,
    data: datasets,
    ui,
    menus,
    results: results.api,
  });
  library.activate();

  // Projects (OPFS): the living-document tier — autosaves the whole working set.
  const projStatus = document.createElement('span');
  projStatus.id = 'proj-status';
  projStatus.className = 'lib-status';
  mounts.status.parentElement?.append(projStatus);
  const projects = new ProjectSync({
    projectStore: new ProjectStore(),
    datasets,
    ui,
    menus,
    bus,
    results: results.api,
    statusEl: projStatus,
  });
  projects.activate();

  // --- seed data + warm up the runtimes, in parallel -------------------------
  // The two WASM runtimes are independent, so load them concurrently rather than
  // serially: `setDataset` cold-starts DuckDB; `webr.preload()` cold-starts R.
  // We only need DuckDB up before continuing (plugins/UI read data), so we await
  // the data load and let WebR keep warming in the background.
  mounts.status.textContent = 'Loading data engine…';
  const dataReady = datasets.setDataset(makeDemoDataset());
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

  // `dataStore` kept as an alias to the manager (it delegates to the active
  // dataset) so console pokes / older references keep working.
  const engine = { bus, datasets, dataStore: datasets, duckdb, webr, results, menus, importers, exporters, datasetStore, library, projects, loader, services };
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
 * Drive the non-blocking "working" indicator from WebR job activity — the slow
 * path (package installs, file reads, analyses). It deliberately does NOT track
 * plugin RPCs or dialogs: while a plugin is awaiting `app.ui` input (e.g. the
 * variable picker) the engine is idle, waiting on the user, not busy.
 *
 * @param {EventBus} bus
 * @param {HTMLElement} el - The `.busy` overlay (contains a `.busy__text`).
 */
function wireBusyIndicator(bus, el) {
  const text = el.querySelector('.busy__text');
  // WebR runs jobs serially, so consecutive jobs (e.g. an import's install →
  // mount → read sequence) would flicker the badge off/on between them. Track a
  // count and hide on a short delay so it stays up across a burst.
  let active = 0;
  let hideTimer = null;
  const labels = {
    installPackages: 'Installing R packages (first run only)…',
    mountFile: 'Loading file…',
    readFile: 'Transferring data…',
    writeFile: 'Transferring data…',
    run: 'Running…',
  };
  bus.on(CoreEvents.WEBR_JOB, ({ status, kind }) => {
    if (status === 'started') {
      active += 1;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (text) text.textContent = labels[kind] ?? 'Working…';
      el.hidden = false;
    } else {
      active = Math.max(0, active - 1);
      if (active === 0 && !hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (active === 0) el.hidden = true;
        }, 250);
      }
    }
  });
}

/**
 * Wire the tabbed workspace (Data / Variables / Output). Switching to a tab
 * renders that view; the data/variable views also refresh on dataset change
 * while visible. Analyses jump focus to Output; a finished import jumps to Data
 * so you see what came in.
 *
 * @param {EventBus} bus
 * @param {Object} mounts - Must include `tabs`, `viewData`, `viewVars`, `results`.
 * @param {{dataView: DataView, variableView: VariableView, results: HTMLElement}} views
 */
function wireWorkspaceTabs(bus, mounts, { dataView, variableView, results }) {
  const panels = { data: mounts.viewData, vars: mounts.viewVars, output: results };
  const buttons = [...mounts.tabs.querySelectorAll('.tab')];
  let current = 'output';

  const show = (name) => {
    current = name;
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.view === name));
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
    if (name === 'data') dataView.refresh();
    else if (name === 'vars') variableView.render();
  };

  for (const b of buttons) b.addEventListener('click', () => show(b.dataset.view));
  bus.on(CoreEvents.DATA_CHANGED, () => {
    if (current === 'data') dataView.refresh();
    else if (current === 'vars') variableView.render();
  });
  // Focus the relevant view for the action in progress.
  bus.on('analysis:started', () => show('output'));
  bus.on('import:finished', () => show('data'));
}

/**
 * The left sidebar: the **project navigator**. Shows the project name and the
 * datasets in the current project — click to switch active, ✕ to remove,
 * double-click a name to rename, and ＋ to add a dataset. (Variable selection
 * lives in the grid column headers now, not here.)
 */
class ProjectSidebar {
  /**
   * @param {HTMLElement} host
   * @param {import('./dataset-manager.js').DatasetManager} datasets
   * @param {EventBus} bus
   */
  constructor(host, datasets, bus) {
    this.host = host;
    this.datasets = datasets;
    this.projectName = null;
    bus.on(DATASETS_CHANGED, () => this.render());
    bus.on(CoreEvents.DATA_CHANGED, () => this.render()); // refresh row counts
    bus.on(PROJECT_CHANGED, ({ name } = {}) => {
      this.projectName = name;
      this.render();
    });
    this.render();
  }

  render() {
    this.host.replaceChildren();

    const title = document.createElement('div');
    title.className = 'proj__name';
    title.textContent = this.projectName || 'Unsaved project';
    this.host.append(title);

    const sub = document.createElement('div');
    sub.className = 'proj__sub';
    sub.textContent = 'Datasets';
    this.host.append(sub);

    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    const items = this.datasets.list();
    for (const it of items) list.append(this.#row(it, items.length));
    this.host.append(list);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'proj__add';
    add.textContent = '＋ Add dataset';
    add.title = 'Add an empty dataset (then import or derive into it)';
    add.addEventListener('click', () =>
      this.datasets.add(`Dataset ${this.datasets.list().length + 1}`, { activate: true }),
    );
    this.host.append(add);
  }

  #row(it, count) {
    const li = document.createElement('li');
    li.className = 'proj__ds' + (it.active ? ' proj__ds--active' : '');
    li.addEventListener('click', () => {
      if (!it.active) this.datasets.setActive(it.id);
    });

    const name = document.createElement('span');
    name.className = 'proj__ds-name';
    name.textContent = it.name;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.#rename(li, name, it);
    });

    const rows = document.createElement('span');
    rows.className = 'proj__ds-rows';
    rows.textContent = it.rowCount.toLocaleString();

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'proj__ds-x';
    x.textContent = '✕';
    x.title = 'Remove this dataset from the project';
    x.disabled = count <= 1; // never remove the last dataset
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.datasets.remove(it.id);
    });

    li.append(name, rows, x);
    return li;
  }

  /** Inline-rename a dataset row. */
  #rename(li, nameEl, it) {
    const input = document.createElement('input');
    input.className = 'proj__ds-edit';
    input.value = it.name;
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v && v !== it.name) this.datasets.rename(it.id, v);
      else this.render();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        done = true;
        this.render();
      }
    });
    input.addEventListener('blur', commit);
    li.replaceChild(input, nameEl);
    input.focus();
    input.select();
  }
}
