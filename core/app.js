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
import { OutputExportService } from './output-export.js';
import { ComputeRecode } from './compute-recode.js';
import { PluginManager } from './plugin-manager.js';
import { PluginActions } from './plugin-actions.js';
import { PluginCreator } from './plugin-creator.js';
import { DatasetStore } from './dataset-store.js';
import { DatasetLibrary, LIBRARY_CHANGED } from './library.js';
import { ProjectStore } from './project-store.js';
import { ProjectSync, PROJECT_CHANGED } from './project-sync.js';
import { DataView, VariableView, HistoryPanel } from './data-views.js';
import { RConsole } from './r-console.js';
import { PluginLoader } from './loader.js';
import { installDialogKeybindings } from './dialog-keys.js';
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
  './plugins/builtin-syntax-export/index.js',
  './plugins/builtin-html-export/index.js',
  './plugins/builtin-docx-export/index.js',
  './plugins/builtin-correlation/index.js',
  './plugins/builtin-logistic/index.js',
  './plugins/builtin-plots/index.js',
  './plugins/builtin-bootstrap/index.js',
  './plugins/builtin-compare/index.js',
  './plugins/builtin-nonparametric/index.js',
  './plugins/builtin-reliability/index.js',
  './plugins/builtin-factor/index.js',
  './plugins/builtin-assumptions/index.js',
  './plugins/builtin-categorical/index.js',
  './plugins/builtin-anova/index.js',
  './plugins/builtin-timeseries/index.js',
  './plugins/builtin-manova/index.js',
  './plugins/builtin-econometrics/index.js',
  './plugins/builtin-aggregate/index.js',
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
 * Prompt the user to allow a plugin's first `app.web.get` — the one network path
 * a plugin has (the sandbox CSP blocks the rest). Lets the user stop a plugin from
 * sending the loaded data out. Resolves a boolean. This is just the dialog; the
 * remember/persist decision is layered on in {@link boot} (every plugin is gated
 * identically — there is no trusted bypass).
 *
 * @param {string} name - The plugin's display name.
 * @param {string} url - The URL it wants to fetch.
 * @returns {Promise<boolean>}
 */
function promptNetworkDialog(name, url) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ct-dialog ct-dialog--wide';
    d.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">Allow network access?</h2>
        <p class="ct-dialog__hint">The plugin <strong>${escapeText(name)}</strong> wants to
          fetch a URL. This is the only way it can send data off your device — allow it
          only if you trust this plugin. If you allow, CrossTab remembers and won't ask
          again for this plugin (revoke it any time in Edit ▸ Plugins…).</p>
        <p class="ct-dialog__hint" style="word-break:break-all"><code>${escapeText(url)}</code></p>
        <menu class="ct-dialog__buttons">
          <button value="allow" type="submit">Allow</button>
          <button value="block" type="submit" class="ct-dialog__primary">Block</button>
        </menu>
      </form>`;
    d.addEventListener('close', () => {
      const allow = d.returnValue === 'allow';
      d.remove();
      resolve(allow);
    });
    document.body.append(d);
    d.showModal();
  });
}

/** Minimal text escape for the few interpolations above. */
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  // Enter activates each dialog's primary (blue) button, app-wide (see dialog-keys).
  installDialogKeybindings();

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
  // Output export: host owns the "Export output…" dialog + the (host-only) print
  // path; formats (HTML, Word, …) are plugins that register via app.outputExporters
  // and read the result model through app.results.getModel.
  const outputExporters = new OutputExportService({
    resultsHost: mounts.results,
    menus,
    results: results.api,
    bus,
  });
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
    outputExporters: outputExporters.api,
    web: webService,
  };
  // `plugins` (the manager) owns the persisted web-access grants; it's created
  // below but the loader needs the consent gate now, so the gate closes over it.
  // The gate only ever fires on a user action long after `plugins` is assigned.
  let plugins;
  const loader = new PluginLoader(services, {
    confirmNetwork: async (plugin, url) => {
      if (plugin.id && plugins.isWebAllowed(plugin.id)) return true; // remembered allow
      const allow = await promptNetworkDialog(plugin.name, url);
      if (allow && plugin.id) plugins.grantWeb(plugin.id); // remember it
      return allow;
    },
  });
  // Host-side wiring for declarative plugins: reads manifest.menu, gathers each
  // action's declared inputs, opens the (host-owned) output section, and invokes
  // the plugin's named function. The PluginManager calls wire/unwire on load/unload.
  const pluginActions = new PluginActions({
    loader,
    menus: menus.api,
    results,
    ui: ui.api,
    bus,
    importers: importers.api,
    exporters: exporters.api,
    outputExporters: outputExporters.api,
  });

  // --- shell wiring ----------------------------------------------------------
  wireStatusLine(bus, mounts.status, webr);
  if (mounts.busy) wireBusyIndicator(bus, mounts.busy);
  // (The sidebar project manager is created below, once the library + project
  // services it drives exist.)

  // Tabbed workspace: Data View (grid) / Variable View / Output (results pane).
  if (mounts.viewData && mounts.viewVars && mounts.tabs) {
    const dataView = new DataView(mounts.viewData, datasets);
    const variableView = new VariableView(mounts.viewVars, datasets);
    // R Console tab: a live REPL on the persistent WebR session (host feature).
    const rConsole = mounts.viewConsole ? new RConsole(mounts.viewConsole, { webr, store: datasets }) : null;
    wireWorkspaceTabs(bus, mounts, { dataView, variableView, results: mounts.results, rConsole, resultsPane: results });
    // Keep the grid's header checkboxes in step when selection changes elsewhere
    // (e.g. the sidebar) — both surfaces drive the one shared selection.
    bus.on(CoreEvents.SELECTION_CHANGED, () => dataView.syncSelection());
  }

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

  // Edit ▸ History… — the *actions* log (loads + transforms) in a floating panel
  // beside Undo/Redo. Distinct from the Data/Variables/Output tabs (inputs &
  // outputs); History is what you did. Click a step to rewind live, reorder with
  // ▲▼, or remove with ✕.
  const historyPanel = new HistoryPanel(datasets, bus);
  menus.register({
    id: 'core:history',
    path: ['Edit'],
    label: 'History…',
    order: 30,
    command: () => historyPanel.toggle(),
  });

  // Transform ▸ Compute variable… / Recode into new variable… — Phase-2 data
  // transforms that create derived variables (logged, undoable, in History).
  new ComputeRecode({ data: datasets, menus, results: results.api }).activate();

  // Dataset library (OPFS), tier 2: reusable building blocks — explicit
  // "Save dataset to library" / "Add dataset from library". No autosave here;
  // the project tier (below) owns autosave.
  const library = new DatasetLibrary({
    datasetStore,
    data: datasets,
    ui,
    menus,
    results: results.api,
    bus,
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

  // Now that projects exist, let the output-export dialog default its report
  // title to the active project name, and register its File menu item.
  outputExporters.activate(projects);

  // The sidebar project manager (active project + datasets, other projects,
  // building blocks). Created here, after the services it drives exist.
  new ProjectSidebar(mounts.sidebar, { datasets, projects, library, bus });

  // --- seed data + warm up the runtimes, in parallel -------------------------
  // The two WASM runtimes are independent, so load them concurrently rather than
  // serially: `setDataset` cold-starts DuckDB; `webr.preload()` cold-starts R.
  // We only need DuckDB up before continuing (plugins/UI read data), so we await
  // the data load and let WebR keep warming in the background.
  mounts.status.textContent = 'Loading data engine…';
  const dataReady = datasets.setDataset(makeDemoDataset());
  webr.preload().catch((err) => console.warn('WebR preload failed', err));
  await dataReady;

  // --- load built-in plugins (those the user hasn't disabled) ----------------
  // The plugin manager owns the catalog + the enabled/disabled set (persisted),
  // loads the enabled ones, and exposes Edit ▸ Plugins… to toggle them live.
  plugins = new PluginManager({ loader, urls: BUILTIN_PLUGINS, menus, results: results.api, actions: pluginActions });
  plugins.activate();
  // In-app plugin creator (Edit ▸ Create plugin…, and the manager's "Create new…"):
  // authors a plugin from a template and loads it through the same sandbox.
  const pluginCreator = new PluginCreator({ manager: plugins });
  plugins.attachCreator(pluginCreator);
  menus.register({
    id: 'core:create-plugin',
    path: ['Edit'],
    label: 'Create plugin…',
    order: 41,
    command: () => pluginCreator.open(null),
  });
  await plugins.loadEnabled();

  // Boot done: from the next change on, an unsaved session auto-starts an
  // autosaving "Untitled project" (so the seed load above doesn't spawn one).
  projects.arm();

  // `dataStore` kept as an alias to the manager (it delegates to the active
  // dataset) so console pokes / older references keep working.
  const engine = { bus, datasets, dataStore: datasets, duckdb, webr, results, menus, importers, exporters, datasetStore, library, projects, loader, plugins, pluginCreator, services };
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
 * Wire the tabbed workspace (Data / Variables / History / Output). Switching to a
 * tab renders that view; the data/variable/history views also refresh on dataset
 * change while visible. Analyses jump focus to Output; a finished import jumps to
 * Data so you see what came in.
 *
 * @param {EventBus} bus
 * @param {Object} mounts - Must include `tabs`, `viewData`, `viewVars`, `results`;
 *   `viewHistory` is optional.
 * @param {{dataView: DataView, variableView: VariableView, historyView: ?HistoryView, results: HTMLElement}} views
 */
function wireWorkspaceTabs(bus, mounts, { dataView, variableView, results, rConsole, resultsPane }) {
  const panels = { data: mounts.viewData, vars: mounts.viewVars, output: results, console: mounts.viewConsole };
  const buttons = [...mounts.tabs.querySelectorAll('.tab')];
  const clearBtn = document.getElementById('clear-output');
  let current = 'output';

  // The clear button is contextual: hidden in Data/Variables (nothing to clear),
  // "Clear output" in Output, "Clear console" (reset the REPL) in R Console.
  const CLEAR = {
    output: { label: 'Clear output', title: 'Clear all output', run: () => resultsPane?.clear() },
    console: { label: 'Clear console', title: 'Clear the console and reset the R session', run: () => rConsole?.reset() },
  };
  const syncClearBtn = (name) => {
    if (!clearBtn) return;
    const cfg = CLEAR[name];
    clearBtn.hidden = !cfg;
    if (cfg) {
      clearBtn.textContent = cfg.label;
      clearBtn.title = cfg.title;
    }
  };
  if (clearBtn) clearBtn.addEventListener('click', () => CLEAR[current]?.run());

  const show = (name) => {
    current = name;
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.view === name));
    for (const [key, panel] of Object.entries(panels)) if (panel) panel.hidden = key !== name;
    syncClearBtn(name);
    if (name === 'data') dataView.refresh();
    else if (name === 'vars') variableView.render();
    else if (name === 'console') rConsole?.onShow();
  };

  syncClearBtn(current); // initial state (Output is the default view)
  for (const b of buttons) b.addEventListener('click', () => show(b.dataset.view));
  bus.on(CoreEvents.DATA_CHANGED, () => {
    if (current === 'data') dataView.refresh();
    else if (current === 'vars') variableView.render();
    else if (current === 'console') rConsole?.refresh();
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
  #token = 0;
  #drag = null; // { kind: 'dataset'|'block', id }

  /**
   * @param {HTMLElement} host
   * @param {Object} deps
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./project-sync.js').ProjectSync} deps.projects
   * @param {import('./library.js').DatasetLibrary} deps.library
   * @param {EventBus} deps.bus
   */
  constructor(host, { datasets, projects, library, bus }) {
    this.host = host;
    this.datasets = datasets;
    this.projects = projects;
    this.library = library;
    this.projectName = null;
    bus.on(DATASETS_CHANGED, () => this.render());
    bus.on(CoreEvents.DATA_CHANGED, () => this.render());
    bus.on(LIBRARY_CHANGED, () => this.render());
    bus.on(PROJECT_CHANGED, ({ name } = {}) => {
      this.projectName = name;
      this.render();
    });
    this.render();
  }

  async render() {
    // Reads the project + block catalogs (async); keep only the latest render.
    const token = ++this.#token;
    let otherProjects = [];
    let blocks = [];
    try {
      otherProjects = (await this.projects.listProjects()).filter((p) => p.id !== this.projects.activeId);
    } catch {
      /* OPFS unavailable */
    }
    try {
      blocks = await this.library.list();
    } catch {
      /* OPFS unavailable */
    }
    if (token !== this.#token) return; // superseded by a newer render

    // Block id → current version, so a linked dataset can show "update available".
    const blockVer = new Map(blocks.map((b) => [b.id, b.version ?? 1]));

    this.host.replaceChildren();
    this.host.append(this.#projectZone(blockVer));
    this.host.append(this.#projectsZone(otherProjects));
    this.host.append(this.#blocksZone(blocks));
  }

  // --- zone 1: active project + its datasets ---------------------------------

  #projectZone(blockVer) {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'proj__head';
    const name = el('span', this.projectName || 'Unsaved project', 'proj__name');
    const editBtn = iconBtn('✎', 'Rename project', () => {
      if (this.projects.activeId) this.#inlineRename(head, name, name.textContent, (v) => this.projects.renameProject(this.projects.activeId, v));
      else void this.projects.saveInteractive();
    });
    const delBtn = iconBtn('✕', 'Delete project', () => {
      if (this.projects.activeId) void this.projects.deleteProject(this.projects.activeId);
      else void this.projects.newProject();
    });
    head.append(name, editBtn, delBtn);
    frag.append(head);

    frag.append(el('div', 'Datasets', 'proj__sub'));

    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    // The datasets list is a drop target for building blocks (add to project).
    this.#dropTarget(list, 'block', (id) => this.library.addBlockToProject(id));
    const items = this.datasets.list();
    for (const it of items) list.append(this.#datasetRow(it, items.length, blockVer));
    frag.append(list);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'proj__add';
    add.textContent = '＋ Add dataset';
    add.title = 'Add an empty dataset (then import or derive into it)';
    add.addEventListener('click', () =>
      this.datasets.add(`Dataset ${this.datasets.list().length + 1}`, { activate: true }),
    );
    frag.append(add);
    return frag;
  }

  #datasetRow(it, count, blockVer) {
    const li = document.createElement('li');
    li.className = 'proj__ds' + (it.active ? ' proj__ds--active' : '');
    li.draggable = true;
    li.addEventListener('dragstart', (e) => this.#startDrag(e, 'dataset', it.id));
    li.addEventListener('dragend', () => (this.#drag = null));
    li.addEventListener('click', () => {
      if (!it.active) this.datasets.setActive(it.id);
    });

    const name = el('span', it.name, 'proj__ds-name');
    name.title = 'Double-click to rename · drag to Building Blocks';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.#inlineRename(li, name, it.name, (v) => this.datasets.rename(it.id, v), 'proj__ds-rows');
    });
    li.append(name);

    if (it.libraryLink) {
      const linkedV = it.libraryLink.version;
      const latest = blockVer?.get(it.libraryLink.id);
      if (latest != null && latest > linkedV) {
        // The block has a newer version — offer to pull it in.
        const upd = iconBtn(`↑v${latest}`, `Update from v${linkedV} to v${latest}`, (e) => {
          e.stopPropagation();
          void this.library.pullLatest(it.id);
        }, 'proj__ds-update');
        li.append(upd);
      } else {
        const badge = el('span', `v${linkedV}`, 'proj__ds-link');
        badge.title = 'Linked to a building block';
        li.append(badge);
      }
    }
    li.append(el('span', it.rowCount.toLocaleString(), 'proj__ds-rows'));

    const edit = iconBtn('✎', 'Rename dataset', (e) => {
      e.stopPropagation();
      this.#inlineRename(li, name, it.name, (v) => this.datasets.rename(it.id, v));
    }, 'proj__ds-x');
    const x = iconBtn(
      '✕',
      count <= 1 ? 'Remove — resets to a fresh empty dataset' : 'Remove from project',
      (e) => {
        e.stopPropagation();
        void this.datasets.remove(it.id);
      },
      'proj__ds-x',
    );
    li.append(edit, x);
    return li;
  }

  // --- zone 2: other saved projects ------------------------------------------

  #projectsZone(projects) {
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'Projects', 'proj__sub proj__sub--zone'));
    if (projects.length === 0) {
      frag.append(el('div', 'No other saved projects.', 'proj__empty'));
      return frag;
    }
    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    for (const p of projects) {
      const li = document.createElement('li');
      li.className = 'proj__ds';
      li.title = 'Open this project';
      li.addEventListener('click', () => void this.projects.openProject(p.id));
      const name = el('span', p.name, 'proj__ds-name');
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.#inlineRename(li, name, p.name, (v) => this.projects.renameProject(p.id, v));
      });
      const edit = iconBtn('✎', 'Rename', (e) => {
        e.stopPropagation();
        this.#inlineRename(li, name, p.name, (v) => this.projects.renameProject(p.id, v));
      }, 'proj__ds-x');
      const del = iconBtn('✕', 'Delete project', (e) => {
        e.stopPropagation();
        void this.projects.deleteProject(p.id);
      }, 'proj__ds-x');
      li.append(name, edit, del);
      list.append(li);
    }
    frag.append(list);
    return frag;
  }

  // --- zone 3: building blocks -----------------------------------------------

  #blocksZone(blocks) {
    const frag = document.createDocumentFragment();
    const sub = el('div', 'Building blocks', 'proj__sub proj__sub--zone');
    frag.append(sub);
    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    // Drop a dataset here to promote it to a building block (v1).
    this.#dropTarget(list, 'dataset', (id) => this.library.promoteToBlock(id));
    if (blocks.length === 0) {
      list.append(el('li', 'Drag a dataset here to save it as a reusable block.', 'proj__empty'));
    }
    for (const b of blocks) {
      const li = document.createElement('li');
      li.className = 'proj__ds';
      li.draggable = true;
      li.title = 'Click to add to the current project · drag onto Datasets';
      li.addEventListener('dragstart', (e) => this.#startDrag(e, 'block', b.id));
      li.addEventListener('dragend', () => (this.#drag = null));
      li.addEventListener('click', () => void this.library.addBlockToProject(b.id));
      li.append(el('span', b.name, 'proj__ds-name'));
      li.append(el('span', `v${b.version ?? 1}`, 'proj__ds-link'));
      const del = iconBtn('✕', 'Delete building block', (e) => {
        e.stopPropagation();
        void this.library.deleteBlock(b.id);
      }, 'proj__ds-x');
      li.append(del);
      list.append(li);
    }
    frag.append(list);
    return frag;
  }

  // --- drag + inline-rename helpers ------------------------------------------

  #startDrag(e, kind, id) {
    this.#drag = { kind, id };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', JSON.stringify(this.#drag));
  }

  /** Make `el` accept a drag of `kind`, calling `onDrop(id)` when one lands. */
  #dropTarget(elm, kind, onDrop) {
    elm.addEventListener('dragover', (e) => {
      if (this.#drag?.kind === kind) {
        e.preventDefault();
        elm.classList.add('proj__drop');
      }
    });
    elm.addEventListener('dragleave', () => elm.classList.remove('proj__drop'));
    elm.addEventListener('drop', (e) => {
      elm.classList.remove('proj__drop');
      let payload = this.#drag;
      if (!payload) {
        try {
          payload = JSON.parse(e.dataTransfer.getData('text/plain'));
        } catch {
          return;
        }
      }
      if (payload?.kind !== kind) return;
      e.preventDefault();
      void onDrop(payload.id);
      this.#drag = null;
    });
  }

  /** Swap a name element for an input; commit on Enter/blur, cancel on Esc. */
  #inlineRename(parent, nameEl, current, onCommit, beforeClass) {
    const input = document.createElement('input');
    input.className = 'proj__ds-edit';
    input.value = current;
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v && v !== current) onCommit(v);
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
    parent.replaceChild(input, nameEl);
    input.focus();
    input.select();
    void beforeClass;
  }
}

/** A small text element: `el(tag, text, className)`. */
function el(tag, text, className) {
  const e = document.createElement(tag);
  e.textContent = text ?? '';
  if (className) e.className = className;
  return e;
}

/** A small icon button. */
function iconBtn(glyph, title, onClick, className = 'proj__ds-x') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
