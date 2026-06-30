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
import { DatasetOps } from './dataset-ops.js';
import { PluginManager } from './plugin-manager.js';
import { PluginActions } from './plugin-actions.js';
import { AnalysisLog } from './analysis-log.js';
import { UndoCoordinator } from './undo-coordinator.js';
import { CodecService } from './codec-service.js';
import { PluginCreator } from './plugin-creator.js';
import { DatasetStore } from './dataset-store.js';
import { DatasetLibrary, LIBRARY_CHANGED } from './library.js';
import { ProjectStore } from './project-store.js';
import { ProjectSync, PROJECT_CHANGED } from './project-sync.js';
import { DataView, VariableView, HistoryPanel } from './data-views.js';
import { RConsole } from './r-console.js';
import { PluginLoader } from './loader.js';
import { installDialogKeybindings } from './dialog-keys.js';
import { Launcher } from './launcher.js';
import { OfflineManager } from './offline.js';
import { exportProjectBundle, importProjectBundle, pickBundleFile, downloadBlob, slug } from './project-bundle.js';
import { WorkspaceStore } from './workspace-store.js';
import { WorkspaceManager } from './workspace-manager.js';
import { PluginPackageStore } from './plugin-package-store.js';

/**
 * URLs of the built-in plugins to load at startup. These load through the exact
 * same sandboxed-iframe path as any third-party plugin (see loader.js) — there
 * is no privileged loader. Adding a built-in analysis is just adding an entry
 * here. URLs are fetched by the host, so they are resolved relative to the
 * document (index.html), not this module.
 * @type {string[]}
 */
const BUILTIN_PLUGINS = [
  './plugins/builtin-text-import/index.js', // .txt corpus → one row per file (for CAQDAS #67)
  // File formats (CSV, Parquet, NDJSON, SPSS/Stata/SAS) are streaming codec plugins
  // (#98), grouped near the bottom of this list.
  './plugins/builtin-frequencies/index.js',
  './plugins/builtin-descriptives/index.js',
  './plugins/builtin-crosstabs/index.js',
  './plugins/builtin-regression/index.js',
  './plugins/builtin-fred/index.js',
  './plugins/builtin-wikipedia/index.js',
  './plugins/builtin-syntax-export/index.js',
  './plugins/builtin-rdata-export/index.js',
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
  './plugins/builtin-bayesian/index.js',
  './plugins/builtin-survey/index.js',
  './plugins/builtin-sem/index.js',
  './plugins/builtin-cluster/index.js',
  './plugins/builtin-countmodels/index.js',
  './plugins/builtin-margins/index.js',
  './plugins/builtin-ordinal/index.js',
  './plugins/builtin-textanalytics/index.js',
  './plugins/builtin-causal/index.js',
  './plugins/builtin-survival/index.js',
  './plugins/builtin-multilevel/index.js',
  './plugins/builtin-mediation/index.js',
  './plugins/builtin-meta/index.js',
  './plugins/builtin-mixedanova/index.js',
  './plugins/builtin-var/index.js',
  './plugins/builtin-cointegration/index.js',
  './plugins/builtin-limdep/index.js',
  './plugins/builtin-clusterse/index.js',
  './plugins/builtin-imputation/index.js',
  './plugins/builtin-epi/index.js',
  './plugins/builtin-inequality/index.js',
  './plugins/builtin-trend/index.js',
  './plugins/builtin-ecology/index.js',
  './plugins/builtin-ordination/index.js',
  './plugins/builtin-doe/index.js',
  './plugins/builtin-sna/index.js',
  './plugins/builtin-spatial/index.js',
  // Reference workspace plugin (#93): proves the manifest→tab→sandboxed UI→state
  // loop. Off by default; enable in Edit ▸ Plugins to see the workspace tab.
  './plugins/builtin-hello-workspace/index.js',
  // Qualitative coding workspace (#67) — the first real workspace plugin.
  './plugins/builtin-caqdas/index.js',
  // Decision-support workspace (#53/#54) — ICER + decision matrix, extensible.
  './plugins/builtin-decisions/index.js',
  // Streaming format codecs (#98) — all file import/export rides this interface.
  './plugins/builtin-csv-codec/index.js',
  './plugins/builtin-ndjson-codec/index.js',
  './plugins/builtin-parquet-codec/index.js',
  // ReadStat (SPSS/Stata/SAS) — a sandboxed codec again (#130). It runs on the codec
  // sandbox's MAIN thread (no worker — iOS won't start one there, #123) because the
  // WASM is built with ASYNCIFY, so its sync read/write IO can suspend for async JS.
  './plugins/builtin-readstat-codec/index.js',
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
          fetch from the site below. This is the only way it can send data off your device —
          allow it only if you trust this plugin. If you allow, CrossTab remembers your choice
          <strong>for this site only</strong>; a different host will ask again. Revoke any time
          in Edit ▸ Plugins….</p>
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
 * After opening a shared `.crosstab` bundle, warn about analyses/plugins it used
 * that aren't installed here (#102). Built-ins are always present, so these are
 * always third-party (a URL/file/authored plugin); we show each with its origin
 * (and URL, when known, so the user can re-add it via Edit ▸ Plugins…). Informational
 * only — the project still opens; those analyses just won't be in the menu.
 *
 * @param {Array<{name:string, origin?:string, url?:string}>} missing
 */
function showMissingPluginsDialog(missing) {
  const d = document.createElement('dialog');
  d.className = 'ct-dialog ct-dialog--wide';
  const items = missing
    .map((p) => {
      const where = p.url
        ? `<code style="word-break:break-all">${escapeText(p.url)}</code>`
        : `<span class="ct-dialog__hint">${escapeText(originText(p.origin))}</span>`;
      return `<li><strong>${escapeText(p.name || 'Unnamed plugin')}</strong> — ${where}</li>`;
    })
    .join('');
  d.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title">Some analyses aren't installed</h2>
      <p class="ct-dialog__hint">This shared project used ${missing.length} plugin${missing.length === 1 ? '' : 's'}
        that ${missing.length === 1 ? "isn't" : "aren't"} installed on this device. Your data and
        saved output opened fine — these analyses just won't appear in the menus until you add them
        (Edit ▸ Plugins…). Add a plugin by its URL when one is shown below.</p>
      <ul class="ct-dialog__list">${items}</ul>
      <menu class="ct-dialog__buttons">
        <button value="ok" type="submit" class="ct-dialog__primary">Got it</button>
      </menu>
    </form>`;
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

/** Human-readable origin label for a recorded plugin descriptor. */
function originText(origin) {
  if (origin === 'url') return 'from a URL (not recorded)';
  if (origin === 'file') return 'added from a file on the sharer’s device';
  if (origin === 'authored') return 'authored in CrossTab on the sharer’s device';
  return 'not a built-in plugin';
}

/** True while a crash dialog is open, so a burst of failed jobs shows just one. */
let crashDialogOpen = false;

/**
 * Offer to restart the R subsystem after it crashed (out of memory). A restart is
 * far less destructive than the page reload it would otherwise take: datasets,
 * projects, and output survive — only installed R packages and R Console variables
 * are cleared (and reinstall / can be redefined on demand).
 *
 * @param {import('./webr-manager.js').WebRManager} webr
 * @param {{appendText: Function, appendError: Function}} resultsApi
 */
function offerRestartR(webr, resultsApi) {
  if (crashDialogOpen) return;
  crashDialogOpen = true;
  const d = document.createElement('dialog');
  d.className = 'ct-dialog';
  d.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title">R ran out of memory</h2>
      <p class="ct-dialog__hint">The R runtime hit the browser's memory limit and has stopped — no more
        analyses will run until it's restarted. <strong>Restarting keeps your datasets, projects, and
        output</strong>; it only clears installed R packages and any R Console variables (packages
        reinstall on demand). This is much gentler than reloading the page.</p>
      <menu class="ct-dialog__buttons">
        <button value="later" type="submit">Not now</button>
        <button value="restart" type="submit" class="ct-dialog__primary">Restart R</button>
      </menu>
    </form>`;
  d.addEventListener('close', async () => {
    const restart = d.returnValue === 'restart';
    d.remove();
    crashDialogOpen = false;
    if (!restart) return;
    try {
      await webr.restart();
      resultsApi.appendText('R restarted — installed packages and R Console variables were cleared; your data and output are intact.');
    } catch (err) {
      resultsApi.appendError(`Couldn’t restart R: ${err.message}`);
    }
  });
  document.body.append(d);
  d.showModal();
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
  // Neutral seed name; the launcher renames the active dataset to match the chosen
  // source ('Demo data', 'Qualitative demo', or 'Dataset 1' for blank).
  datasets.add('Dataset 1', { activate: true });
  const webr = new WebRManager(
    {
      bus,
      getColumns: (opts) => datasets.getColumns(opts),
      getInjectionParquet: (opts) => datasets.getInjectionParquet(opts),
    },
    { preloadPackages: [] }, // built-in plugins declare their own R deps
  );
  const results = new ResultsPane(mounts.results, { bus });
  const menus = new MenuShell(mounts.menubar);
  const ui = new UiService(datasets);
  const importers = new ImportService({ menus, data: datasets, results: results.api, bus, webr });
  // SPSS/Stata/SAS (ReadStat) is a sandboxed codec plugin (builtin-readstat-codec, #130),
  // joining this same Import/Export picker via the codec interface like CSV/Parquet.
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
  // Per-project recycle bin (#115): a deleted dataset is snapshotted here before
  // its tables are dropped, so it can be restored. Same proven OPFS machinery as
  // the library, rooted in a separate directory.
  const recycle = new DatasetStore('recycle');

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
      let origin = '';
      try { origin = new URL(url).origin; } catch { /* invalid URL → no remembered grant */ }
      if (plugin.id && origin && plugins.isWebAllowed(plugin.id, origin)) return true; // remembered for this origin
      const allow = await promptNetworkDialog(plugin.name, url);
      if (allow && plugin.id && origin) plugins.grantWeb(plugin.id, origin); // remember it, scoped to this origin
      return allow;
    },
  });
  // Streaming format codecs (#98): a unified read/write per format, sandboxed like
  // any plugin but driving the host's streaming ingest/download. `services.codec`
  // is added to the (already-passed-to-loader) bundle now; plugins load post-boot,
  // so the broker sees it. Codecs are registered from manifests via pluginActions.
  const codecs = new CodecService({ importers, exporters, loader, results: results.api });
  services.codec = codecs.serviceApi;
  // SPSS/Stata/SAS (ReadStat) is a sandboxed codec plugin again (#130) — see the codec
  // plugin list above; it runs on the codec sandbox's main thread (ASYNCIFY, no worker).

  // Host-side wiring for declarative plugins: reads manifest.menu, gathers each
  // action's declared inputs, opens the (host-owned) output section, and invokes
  // the plugin's named function. The PluginManager calls wire/unwire on load/unload.
  // Ordered, replayable record of analyses run (the analysis half of the script,
  // #132). Data ops already replay via the data-store log; this covers analyses.
  const analysisLog = new AnalysisLog(bus);
  // Replacing the base dataset (a fresh demo/blank load, an import-replace, a new
  // project) starts a new analysis context — the prior analyses ran against data
  // that's now gone, so clear them. (Transforms/reorders/appends keep their
  // analyses; only a `replace` swaps the base out from under them. Project open
  // fires `restore`, then sets the saved log, so it's unaffected.)
  bus.on(CoreEvents.DATA_CHANGED, (summary) => {
    if (summary && summary.reason === 'replace') analysisLog.clear();
  });
  const pluginActions = new PluginActions({
    loader,
    menus: menus.api,
    results,
    ui: ui.api,
    bus,
    importers: importers.api,
    exporters: exporters.api,
    outputExporters: outputExporters.api,
    codecs,
    analysisLog,
    dataStore: datasets,
  });

  // One Undo/Redo across BOTH data ops and analysis runs: when the most recent
  // action is an analysis, Undo removes that analysis + its output (not a data op).
  const undoCoordinator = new UndoCoordinator({
    datasets,
    analysisLog,
    results,
    pluginActions,
    bus,
  });

  // --- shell wiring ----------------------------------------------------------
  wireStatusLine(bus, mounts.status, webr);
  if (mounts.busy) wireBusyIndicator(bus, mounts.busy);
  // If the R runtime crashes (out of memory), offer a restart instead of leaving
  // the session silently broken until a page reload.
  bus.on(CoreEvents.WEBR_CRASHED, () => offerRestartR(webr, results.api));
  // (The sidebar project manager is created below, once the library + project
  // services it drives exist.)

  // Tabbed workspace: Data View (grid) / Variable View / Output (results pane).
  // `workspaceTabs` is the runtime add/remove-tab surface plugin workspaces use.
  let workspaceTabs = null;
  if (mounts.viewData && mounts.viewVars && mounts.tabs) {
    const dataView = new DataView(mounts.viewData, datasets);
    const variableView = new VariableView(mounts.viewVars, datasets);
    // R Console tab: a live REPL on the persistent WebR session (host feature).
    const rConsole = mounts.viewConsole ? new RConsole(mounts.viewConsole, { webr, store: datasets }) : null;
    workspaceTabs = wireWorkspaceTabs(bus, mounts, { dataView, variableView, results: mounts.results, rConsole, resultsPane: results });
    // Keep the grid's header checkboxes in step when selection changes elsewhere
    // (e.g. the sidebar) — both surfaces drive the one shared selection.
    bus.on(CoreEvents.SELECTION_CHANGED, () => dataView.syncSelection());
  }

  // Edit ▸ Undo / Redo — routed through the coordinator so a single Undo acts on
  // the most recent action whether it was a data op OR an analysis run. Host-owned
  // (like the data grid), registered through the same `menus.register` everything
  // uses. No-ops when there's nothing to undo/redo; views refresh on DATA_CHANGED.
  menus.register({
    id: 'core:undo',
    path: ['Edit'],
    label: 'Undo',
    order: 10,
    command: () => void undoCoordinator.undo(),
  });
  menus.register({
    id: 'core:redo',
    path: ['Edit'],
    label: 'Redo',
    order: 20,
    command: () => void undoCoordinator.redo(),
  });

  // Edit ▸ History… — the *actions* log (loads + transforms) in a floating panel
  // beside Undo/Redo. Distinct from the Data/Variables/Output tabs (inputs &
  // outputs); History is what you did. Click a step to rewind live, reorder with
  // ▲▼, or remove with ✕.
  const historyPanel = new HistoryPanel(datasets, bus, { analysisLog, pluginActions, undo: undoCoordinator });
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
  // Transform ▸ Extract columns to a new dataset… / Join with another dataset… —
  // dataset-level manipulation: subset columns into a fresh dataset, and join two
  // open project datasets by key (all four join types) (#121).
  new DatasetOps({ datasets, menus, results: results.api, ui }).activate();

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
  // Host store for plugin workspace state (#93). Persists per-project, keyed by
  // workspace id; opaque to the host. Empty until a workspace plugin writes.
  const workspaceStore = new WorkspaceStore({ bus });
  const projects = new ProjectSync({
    projectStore: new ProjectStore(),
    datasets,
    ui,
    menus,
    bus,
    results: results.api,
    statusEl: projStatus,
    // A project remembers which analyses were active. `plugins` is assigned later
    // in boot; these closures run on save/open (long after), so the late binding
    // is fine — and they no-op gracefully until then.
    getActivePlugins: () => (plugins ? plugins.activatedKeys() : null),
    applyActivePlugins: (keys) => (plugins ? plugins.applyActivatedSet(keys) : Promise.resolve()),
    // Every installed plugin's identifiers (load key + manifest id), so the project
    // can tell a recorded-but-uninstalled plugin apart from one it simply has, and
    // carry the former forward across saves (#102).
    pluginIdentities: () => (plugins ? plugins.list().flatMap((p) => [p.key, p.id]).filter(Boolean) : []),
    // A project also remembers each plugin workspace's state blob. After swapping in
    // the new project's blobs, force-remount any live workspace tabs so they re-read
    // their state — a plugin active in both the old and new project stays mounted, so
    // reconcile() alone wouldn't refresh it and it would keep showing stale data.
    getWorkspaces: () => workspaceStore.export(),
    applyWorkspaces: (obj) => {
      workspaceStore.import(obj);
      if (workspaceManager && plugins) void workspaceManager.remountActive(plugins.list());
    },
    // …and the Output tab's results, so reopening shows them (and switching
    // projects clears/reloads output instead of leaving the previous one's).
    getOutput: () => results.getModel(),
    applyOutput: (model) => results.restoreModel(model),
    getAnalysisLog: () => analysisLog.toJSON(),
    applyAnalysisLog: (entries) => analysisLog.load(entries),
  });
  projects.activate();

  // File ▸ Export project bundle — the open, self-describing .crosstab archive
  // (Parquet data + JSON schema + transform log). Host-owned (reads all datasets),
  // not a plugin. Import is a follow-up.
  menus.register({
    id: 'core:export-bundle',
    path: ['File'],
    label: 'Export project bundle (.crosstab)…',
    order: 6,
    command: async () => {
      try {
        const name = projects.activeName || 'crosstab-project';
        // Record the active analysis/plugin set so a recipient restores the same
        // analyses (and is warned about any they don't have — #102).
        const activePlugins = plugins.list().filter((p) => p.activated);
        const blob = await exportProjectBundle({ datasets, projectName: name, plugins: activePlugins });
        downloadBlob(blob, `${slug(name) || 'crosstab-project'}.crosstab`);
        results.api.appendText(`Exported **${name}** as a .crosstab bundle (${(blob.size / 1048576).toFixed(1)} MB).`);
      } catch (err) {
        results.api.appendError(`Export project bundle failed: ${err.message}`);
      }
    },
  });
  menus.register({
    id: 'core:import-bundle',
    path: ['File'],
    label: 'Open project bundle (.crosstab)…',
    order: 7,
    command: async () => {
      const file = await pickBundleFile();
      if (!file) return;
      try {
        const { name, bundle, plugins: recorded } = importProjectBundle(new Uint8Array(await file.arrayBuffer()));
        await projects.openBundle({ name, bundle });
        // Warn about analyses/plugins the bundle used but this install doesn't have
        // (#102). Built-ins always present; only non-built-ins (URL/file/authored)
        // can be missing — match by manifest id against what's installed here.
        const have = new Set(plugins.list().map((p) => p.id).filter(Boolean));
        const missing = (recorded || []).filter((p) => !p.builtin && p.id && !have.has(p.id));
        results.api.appendText(`Opened project bundle **${name}** — ${bundle.datasets.length} dataset(s).`);
        if (missing.length) showMissingPluginsDialog(missing);
      } catch (err) {
        results.api.appendError(`Open project bundle failed: ${err.message}`);
      }
    },
  });

  // SPSS (.sav) / Stata (.dta) export is now provided by the ReadStat codec plugin
  // (File ▸ Export data… ▸ SPSS/Stata), streamed through the codec interface (#98 Phase 2).

  // Now that projects exist, let the output-export dialog default its report
  // title to the active project name, and register its File menu item.
  outputExporters.activate(projects);

  // The sidebar project manager (active project + datasets, other projects,
  // building blocks). Created here, after the services it drives exist.
  new ProjectSidebar(mounts.sidebar, { datasets, projects, library, bus, recycle });

  // --- warm the runtimes ------------------------------------------------------
  // WebR warms in the background. DuckDB cold-starts when the launcher loads the
  // chosen data source — we no longer auto-seed a demo here; the launcher (below)
  // gates the session, picking the data source and which plugins are active.
  mounts.status.textContent = 'Starting…';
  webr.preload().catch((err) => console.warn('WebR preload failed', err));

  // The plugin manager owns the catalog + the enabled/disabled set (persisted)
  // and exposes Edit ▸ Plugins…; the launcher drives activation through it.
  plugins = new PluginManager({
    loader,
    urls: BUILTIN_PLUGINS,
    menus,
    results: results.api,
    actions: pluginActions,
    bus,
    projectReferences: () => projects.referencedPlugins(),
    // Detect/purge a deactivated plugin's saved project data, and keep or drop it
    // from the open project's plugin set on deactivation (#118).
    workspaceStore,
    project: projects,
    // Durable store for added multi-file `.ctplugin` packages — their bundled assets
    // are too big/binary for localStorage (#119).
    packageStore: new PluginPackageStore(),
  });
  plugins.activate();

  // Plugin workspaces (#93): mount/unmount workspace TABS to match the active
  // plugin set. Rides PLUGINS_CHANGED (same signal as menu wiring) + one initial
  // pass for any workspace plugin already active at boot. Only when the tabbed
  // workspace exists (it won't in a headless/embedded mount).
  let workspaceManager = null;
  if (workspaceTabs) {
    workspaceManager = new WorkspaceManager({ tabs: workspaceTabs, store: workspaceStore, services });
    const reconcileWorkspaces = () => void workspaceManager.reconcile(plugins.list());
    bus.on(CoreEvents.PLUGINS_CHANGED, reconcileWorkspaces);
    reconcileWorkspaces();
  }
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

  // `dataStore` kept as an alias to the manager (it delegates to the active
  // dataset) so console pokes / older references keep working. Exposed before the
  // launcher so the launcher (and dev tooling) can use the engine.
  const engine = { bus, datasets, dataStore: datasets, duckdb, webr, results, menus, importers, exporters, datasetStore, recycle, library, projects, loader, plugins, pluginCreator, services, workspaceStore, workspaceManager, codecs, analysisLog, pluginActions, undoCoordinator };
  // eslint-disable-next-line no-undef
  globalThis.crosstab = engine;

  // --- launcher: the front door (data source + active plugins) ----------------
  // A `?launch=<preset>` URL flag bypasses the screen (presets: start-blank,
  // demo-quant, demo-qual) — handy for a fast dev loop and power users.
  // "Make available offline" (installed-PWA offline caching) — drives the service
  // worker to cache the app shell + runtimes; surfaced in the launcher About panel.
  const offline = new OfflineManager({ webr, duckdb, plugins });
  engine.offline = offline;
  // Connectivity indicator in the status bar — most useful on a field device, where
  // it tells the user why an online importer is quiet and confirms "you're cached."
  if (mounts.status) wireConnectivityIndicator(mounts.status, offline);
  const launcher = new Launcher({ plugins, datasets, bus, projects, offline });
  engine.launcher = launcher;
  const launchFlag = new URLSearchParams(location.search).get('launch');
  let bypassed = false;
  if (launchFlag) {
    try {
      // `?launch=` accepts a preset (start-blank/demo-quant/demo-qual) or, failing
      // that, a saved project name — opening it (data + its plugins) headless.
      bypassed = await launcher.applyPreset(launchFlag);
      if (!bypassed) bypassed = await launcher.openProjectByName(launchFlag);
    } catch (err) {
      console.warn('Launch preset failed', err);
    }
  }
  if (!bypassed) await launcher.open();

  // Click the "CrossTab" brand to reopen the launcher (also the plugin picker).
  const brand = document.querySelector('header .brand');
  if (brand) {
    brand.style.cursor = 'pointer';
    brand.title = 'Open the launcher / plugin picker';
    brand.addEventListener('click', () => void launcher.open({ reopen: true }));
  }

  // Boot done: from the next change on, an unsaved session auto-starts an
  // autosaving "Untitled project" (so the launcher's data load doesn't spawn one).
  projects.arm();

  // If a prior "Make available offline" reloaded once to gain service-worker
  // control, finish caching the app + runtimes now (no-op otherwise).
  void offline.resumeIfPending((t) => console.info('[offline]', t));

  // Running as an installed (Home Screen) app? Tell the worker, so it serves the
  // shell cache-first — a field iPad on a dead connection still launches instantly.
  const standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (standalone) {
    offline.setStandalone(true);
    // Re-announce if SW control arrives slightly after boot.
    navigator.serviceWorker?.addEventListener?.('controllerchange', () => offline.setStandalone(true));
  }

  // Opportunistic update check when online: refresh the SW registration so a newer
  // version is fetched. Combined with the standalone stale-while-revalidate serving,
  // the app self-updates on the next launch (the SW skipWaiting()s + claims).
  if (navigator.onLine) {
    navigator.serviceWorker?.getRegistration?.().then((reg) => reg?.update?.()).catch(() => {});
  }

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
 * A small status-bar connectivity indicator. Quiet when online and not cached;
 * confirms "offline-ready" when online + cached; and clearly flags offline use —
 * calmly if cached ("working offline"), as a warning if not. Most valuable on a
 * sketchy-connectivity field device.
 *
 * @param {HTMLElement} statusEl - The status line (we append a sibling span).
 * @param {import('./offline.js').OfflineManager} offline
 */
function wireConnectivityIndicator(statusEl, offline) {
  const el = document.createElement('span');
  el.id = 'net-status';
  el.className = 'lib-status';
  (statusEl.parentElement || statusEl).append(el);
  const paint = async () => {
    let enabled = false;
    let runtimeCached = false;
    try {
      const st = await offline.status();
      enabled = st.enabled;
      runtimeCached = st.runtimeCached;
    } catch {
      /* ignore */
    }
    // The app shell is cached automatically (#92), and the R engine + packages cache
    // as they're used — so "offline-capable" means the engine is cached (whether via
    // the opt-in pre-cache or just from normal use). Offline without it = the app
    // still runs, but R analyses needing uncached packages won't.
    const offlineCapable = enabled || runtimeCached;
    if (navigator.onLine) {
      el.hidden = !offlineCapable;
      el.textContent = offlineCapable ? '✓ Offline-ready' : '';
      el.style.color = '#7a8590';
    } else {
      el.hidden = false;
      el.textContent = offlineCapable ? '✈ Working offline' : '✈ Offline — app only (R engine not cached yet)';
      el.style.color = offlineCapable ? '#7a8590' : '#b26a00';
    }
  };
  window.addEventListener('online', paint);
  window.addEventListener('offline', paint);
  void paint();
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
  let importing = false;
  let hideTimer = null;
  const labels = {
    installPackages: 'Installing R packages (first run only)…',
    mountFile: 'Loading file…',
    readFile: 'Transferring data…',
    writeFile: 'Transferring data…',
    run: 'Running…',
  };
  const show = (msg) => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (text) text.textContent = msg;
    el.hidden = false;
  };
  const scheduleHide = () => {
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (active === 0 && !importing) el.hidden = true;
    }, 250);
  };
  bus.on(CoreEvents.WEBR_JOB, ({ status, kind }) => {
    if (status === 'started') {
      active += 1;
      show(labels[kind] ?? 'Working…');
    } else {
      active = Math.max(0, active - 1);
      if (active === 0) scheduleHide();
    }
  });
  // Imports run on our own ReadStat worker (not WebR), so drive the badge directly
  // and surface a live "rows read" count — the import is the slowest thing the user
  // waits on, and we own the parser so the number is free.
  bus.on('import:started', () => {
    importing = true;
    show('Reading file…');
  });
  bus.on('import:progress', ({ done, total }) => {
    if (!importing) return;
    const d = (done ?? 0).toLocaleString();
    show(total >= 0 ? `Reading data… ${d} / ${total.toLocaleString()} rows` : `Reading data… ${d} rows`);
  });
  bus.on('import:ended', () => {
    importing = false;
    if (active === 0) scheduleHide();
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
  // Built-in panes by view name; workspace plugins add/remove entries at runtime.
  const panels = new Map([
    ['data', mounts.viewData],
    ['vars', mounts.viewVars],
    ['output', results],
    ['console', mounts.viewConsole],
  ]);
  // Per-view "on show" hook (built-ins refresh their content; workspaces register
  // their own when they add a tab).
  const onShow = {
    data: () => dataView.refresh(),
    vars: () => variableView.render(),
    console: () => rConsole?.onShow(),
  };
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
    if (!panels.has(name)) return;
    current = name;
    for (const b of mounts.tabs.querySelectorAll('.tab')) {
      b.setAttribute('aria-selected', String(b.dataset.view === name));
    }
    for (const [key, panel] of panels) if (panel) panel.hidden = key !== name;
    syncClearBtn(name);
    onShow[name]?.();
  };

  syncClearBtn(current); // initial state (Output is the default view)
  // Event delegation so tabs added at runtime (plugin workspaces) work too.
  mounts.tabs.addEventListener('click', (e) => {
    const b = e.target.closest?.('.tab');
    if (b && b.dataset.view) show(b.dataset.view);
  });
  bus.on(CoreEvents.DATA_CHANGED, () => {
    if (current === 'data') dataView.refresh();
    else if (current === 'vars') variableView.render();
    else if (current === 'console') rConsole?.refresh();
  });
  // Focus the relevant view for the action in progress.
  bus.on('analysis:started', () => show('output'));
  bus.on('import:finished', () => show('data'));
  // An error (incl. ones outside an analysis) should pull the user to Output, and
  // scroll to it so the message isn't missed below the fold.
  bus.on('output:error', () => { show('output'); resultsPane?.scrollToLatest(); });
  // Output appended outside the menu-analysis path (e.g. a workspace plugin's
  // own buttons) should also surface Output — otherwise the action looks dead —
  // and snap to the start of the new output (not on 'analysis:started', which
  // fires before anything is appended).
  bus.on('output:written', () => { show('output'); resultsPane?.scrollToLatest(); });

  // Registry surface for plugin workspaces (#93): add/remove a runtime tab.
  const workspaceSection = results.parentElement; // the .workspace <section>
  return {
    show,
    /** Add a runtime tab. `view` = unique data-view key; `pane` = the view element
     * (the workspace manager mounts the plugin iframe into it). */
    addTab({ view, title, pane, onShow: hook }) {
      if (panels.has(view)) return;
      pane.classList.add('view');
      pane.hidden = true;
      workspaceSection.append(pane);
      panels.set(view, pane);
      if (hook) onShow[view] = hook;
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.dataset.view = view;
      btn.textContent = title;
      mounts.tabs.insertBefore(btn, clearBtn || null);
    },
    removeTab(view) {
      mounts.tabs.querySelector(`.tab[data-view="${CSS.escape(view)}"]`)?.remove();
      const pane = panels.get(view);
      panels.delete(view);
      delete onShow[view];
      pane?.remove();
      if (current === view) show('output');
    },
  };
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
  constructor(host, { datasets, projects, library, bus, recycle }) {
    this.host = host;
    this.datasets = datasets;
    this.projects = projects;
    this.library = library;
    this.recycle = recycle ?? null;
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
    let binned = [];
    try {
      if (this.recycle) {
        const scope = this.#projectScope();
        const all = await this.recycle.list();
        // A dataset deleted before the project was saved is scoped 'unsaved'. Once
        // the project has an id (autosave creates one), claim those entries onto it
        // so the bin follows the project rather than leaking into others.
        if (scope !== 'unsaved') {
          for (const e of all) {
            if (e.projectScope === 'unsaved') {
              try {
                await this.recycle.retag(e.id, { projectScope: scope });
                e.projectScope = scope;
              } catch {
                /* best effort */
              }
            }
          }
        }
        binned = all.filter((e) => e.projectScope === scope);
      }
    } catch {
      /* OPFS unavailable */
    }
    if (token !== this.#token) return; // superseded by a newer render

    // Block id → current version, so a linked dataset can show "update available".
    const blockVer = new Map(blocks.map((b) => [b.id, b.version ?? 1]));

    this.host.replaceChildren();
    this.host.append(this.#projectZone(blockVer));
    if (binned.length) this.host.append(this.#recycleZone(binned));
    this.host.append(this.#projectsZone(otherProjects));
    this.host.append(this.#blocksZone(blocks));
  }

  // --- zone 1: active project + its datasets ---------------------------------

  #projectZone(blockVer) {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'proj__head';
    const name = el('span', this.projectName || 'Unsaved project', 'proj__name');
    // Rename inline (like a dataset), always — double-click the name or click ✎.
    // A never-saved project names+saves itself on commit (renameActive), so this
    // is never the Save modal; it matches every other ✎ in the sidebar.
    const renameInline = () =>
      this.#inlineRename(head, name, this.projectName ?? '', (v) => this.projects.renameActive(v));
    name.title = 'Double-click to rename';
    name.style.cursor = 'text';
    name.addEventListener('dblclick', renameInline);
    const editBtn = iconBtn('✎', 'Rename project', renameInline);
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
        void this.#deleteDataset(it);
      },
      'proj__ds-x',
    );
    li.append(edit, x);
    return li;
  }

  // --- recycle bin (#115) ----------------------------------------------------

  /** The recycle scope key for the active project (a stable string; 'unsaved' for
   * a project that has never been saved, so its deletions are still recoverable). */
  #projectScope() {
    return String(this.projects.activeId ?? 'unsaved');
  }

  /** Snapshot a dataset into the recycle bin, then remove it. The snapshot never
   * blocks the delete: a snapshot failure is logged and the delete proceeds (we
   * don't trap the user with an undeletable dataset). Empty datasets (no sources)
   * aren't binned — there's nothing to recover. */
  async #deleteDataset(it) {
    if (this.recycle) {
      try {
        const ds = this.datasets.get(it.id);
        const state = ds ? await ds.exportState({ includeParquet: true }) : null;
        if (state && state.sources && state.sources.length) {
          await this.recycle.save({
            name: it.name,
            savedAt: Date.now(),
            state,
            extra: { projectScope: this.#projectScope() },
          });
          await this.#capRecycle();
        }
      } catch (err) {
        console.error('[recycle] snapshot failed; deleting anyway', err);
      }
    }
    await this.datasets.remove(it.id);
  }

  /** Keep at most `cap` binned datasets per project; evict the oldest beyond it so
   * the bin can't grow without bound. */
  async #capRecycle(cap = 20) {
    try {
      const scope = this.#projectScope();
      const mine = (await this.recycle.list())
        .filter((e) => e.projectScope === scope)
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      for (const e of mine.slice(cap)) await this.recycle.delete(e.id);
    } catch {
      /* best effort */
    }
  }

  /** Restore a binned dataset back into the project, then drop it from the bin. */
  async #restoreDataset(e) {
    try {
      const snap = await this.recycle.load(e.id);
      await this.datasets.addFromState({ name: snap.name, state: snap.state, activate: true });
      await this.recycle.delete(e.id);
      this.render();
    } catch (err) {
      console.error('[recycle] restore failed', err);
      alert('Could not restore that dataset — its saved copy may be corrupt.');
    }
  }

  /** Permanently remove a binned dataset (after confirmation). */
  async #purgeRecycle(e) {
    if (!confirm(`Permanently delete "${e.name}"? This can't be undone.`)) return;
    try {
      await this.recycle.delete(e.id);
    } catch (err) {
      console.error('[recycle] purge failed', err);
    }
    this.render();
  }

  #recycleZone(binned) {
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'Recently deleted', 'proj__sub proj__sub--zone'));
    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    for (const e of binned) {
      const li = document.createElement('li');
      li.className = 'proj__ds proj__ds--trash';
      const name = el('span', e.name, 'proj__ds-name');
      name.title = `Deleted ${new Date(e.savedAt).toLocaleString()} · ${(e.rowCount || 0).toLocaleString()} rows`;
      name.style.color = '#8a94a0';
      li.append(name);
      li.append(el('span', (e.rowCount || 0).toLocaleString(), 'proj__ds-rows'));
      const restore = iconBtn('↩', 'Restore this dataset', (ev) => {
        ev.stopPropagation();
        void this.#restoreDataset(e);
      }, 'proj__ds-x');
      const purge = iconBtn('✕', 'Delete permanently', (ev) => {
        ev.stopPropagation();
        void this.#purgeRecycle(e);
      }, 'proj__ds-x');
      li.append(restore, purge);
      list.append(li);
    }
    frag.append(list);
    return frag;
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
