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
import { installPassphraseUI } from './passphrase-ui.js';
import { installIdentityChip, getIdentity, onIdentityChange, currentAuthor } from './user-identity.js';
import { ProjectLog } from './project-log.js';
import { ItemStore, newItemId, isItemOp, parseItemTarget, itemTarget } from './item-store.js';
import { MemoStore, createMemoService, ANCHOR_KINDS, datasetOfTarget } from './memo-store.js';
import { SelectionStore, createSelectionService, SELECTION_CHANGED } from './selection.js';
import { parseInviteLink } from './live-invite.js';
import { findOrphans, itemRefSources, refsIn } from './asset-refs.js';
import { declaredCollections, assetRefDecls, undeclaredItemsGuard, CORE_COLLECTIONS,
         sidebarCollections, recordLabel } from './collections.js';
import { LivePresence } from './live-presence.js';
import { mergersFor } from './builtin-mergers.js';
import { OutputExportService } from './output-export.js';
import { ComputeRecode } from './compute-recode.js';
import { DatasetOps } from './dataset-ops.js';
import { PluginManager } from './plugin-manager.js';
import { PluginActions } from './plugin-actions.js';
import { AnalysisLog } from './analysis-log.js';
import { UndoCoordinator } from './undo-coordinator.js';
import { runRScript, registerRScriptRunner } from './r-script.js';
import { CodecService } from './codec-service.js';
import { PluginCreator } from './plugin-creator.js';
import { DatasetStore } from './dataset-store.js';
import { debug, isDebug, setDebug, saveLog } from './debug.js';
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
import { WorkspaceStore, ownerToken } from './workspace-store.js';
import { liveOps } from './op-log.js';
import { WorkspaceManager } from './workspace-manager.js';
import { PluginPackageStore } from './plugin-package-store.js';
import { AssetStore, createAssetService, ASSETS_CHANGED } from './asset-store.js';
import { makeZip, readZipEntries } from './zip.js';

/**
 * Ask what to do about datasets linked to a **building block** when a project leaves
 * this machine (#149 A9).
 *
 * The choice is narrower than it first looks, and worth stating plainly in the dialog:
 * a bundle always carries every dataset's own sources, so the DATA travels either way —
 * there is no "embed vs reference" size trade-off. All that's at stake is the
 * `libraryLink` badge and its Pull-update button.
 *
 * And that link is local by construction. A block's id is a `crypto.randomUUID()` minted
 * on whichever machine first saved it, and there is no mechanism to share a block
 * between machines at all, so a recipient's library will not contain that id — not even
 * if they independently imported the identical file. Keeping the link is therefore only
 * useful for a copy coming back to THIS machine (an archive you re-import yourself).
 *
 * @param {string[]} names  linked dataset names, for the prompt.
 * @returns {Promise<boolean|null>} true = keep links, false = drop them, null = cancel.
 */
function askLinkedBlocks(names) {
  const list = names.length === 1 ? `“${names[0]}”` : `${names.length} datasets`;
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">Linked building blocks</h2>
        <p class="ct-dialog__hint">${list} ${names.length === 1 ? 'is' : 'are'} linked to a
          building block in your library. The data is included in the export either way —
          this only affects the “linked” badge and its update button.</p>
        <p class="ct-dialog__hint">Building blocks live on one machine, so the link
          <strong>won’t resolve for anyone else</strong>. Keep it only if this copy is
          coming back to this computer.</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="keep" type="submit">Keep the links</button>
          <button value="drop" type="submit" class="ct-dialog__primary">Drop the links</button>
        </menu>
      </form>`;
    dialog.addEventListener('close', () => {
      const v = dialog.returnValue;
      dialog.remove();
      resolve(v === 'drop' ? false : v === 'keep' ? true : null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * URLs of the built-in plugins to load at startup. These load through the exact
 * same sandboxed-iframe path as any third-party plugin (see loader.js) — there
 * is no privileged loader. Adding a built-in analysis is just adding an entry
 * here. URLs are fetched by the host, so they are resolved relative to the
 * document (index.html), not this module.
 * @type {string[]}
 */
const BUILTIN_PLUGINS = [
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
  './plugins/builtin-agreement/index.js',
  './plugins/builtin-sced/index.js',
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
  // Excel (.xlsx/.xls) via SheetJS — read-only codec (import), whole-file (not
  // streaming: Excel is inherently bounded), then batched into the host ingest.
  './plugins/builtin-excel-codec/index.js',
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
    // Do NOT auto-follow redirects. The per-origin consent gate (loader.js
    // #gatedServices) approves the *requested* origin only; if fetch silently
    // followed a 30x, a grant for a trusted host would let its (open-)redirect
    // bounce the request — carrying data in the URL — to an origin the user never
    // approved, defeating the gate (#89). `redirect: 'manual'` makes a redirect a
    // dead-stop opaque response, so the cross-origin hop never fires; we surface a
    // clear error instead of leaking. Callers must use a direct endpoint.
    const res = await fetch(String(url), { redirect: 'manual' });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new Error(
        'web.get: the server returned a redirect, which is not followed for your safety ' +
          '(a redirect could send your data to a site you did not approve). Use the direct URL.',
      );
    }
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
  // The project's single unified operation log (docs/ARCHITECTURE-unified-log.md).
  // Shared across the tiers that fold from it — the dataset collection and the
  // analysis-run list today; more to come. Created once here, injected into each.
  const projectLog = new ProjectLog({ author: currentAuthor });
  // `datasets` owns the open datasets and presents the active one through the
  // same surface a single DataStore used to (it delegates). Everything that used
  // to hold "the dataset" now holds the manager.
  const datasets = new DatasetManager(bus, duckdb, projectLog);
  const itemStore = new ItemStore({ log: projectLog, bus });

  /**
   * Project epoch (#153). Advances every time the project boundary is crossed — a new
   * project, an open, a switch — i.e. exactly when workspace plugins are re-mounted.
   *
   * It exists because a workspace mount OUTLIVES the project it was made in, by however
   * long its iframe takes to notice. A plugin holds its records in memory and writes them
   * back on various triggers, so a mount belonging to the CLOSED project could write the
   * old project's state into the new one. Ordering the tier resets helps but cannot close
   * it: the write originates in a sandbox, asynchronously, after the host has moved on.
   *
   * Symptom that led here: switching away from the spatial demo intermittently kept
   * exactly the ACTIVE map layer — the one `wsSaveState` writes — in the new project.
   *
   * So writes carry the epoch they were mounted under, and a stale one is dropped. This
   * is a guard, not a policy: legitimate writes from a live mount always match.
   */
  let projectEpoch = 0;
  const currentEpoch = () => projectEpoch;

  // What the user has selected, per kind (#153 D2). Not one global slot: an active
  // dataset and an active map layer coexist, because they answer different questions.
  const selection = new SelectionStore({ bus });
  // Memos (#152 Layer 2): anchored notes, host-owned so a note written in the coding
  // workspace and one written on an analysis are the SAME record in the same collection.
  // Scope follows the anchor, so a note about a dataset nests under it in the sidebar.
  const memoStore = new MemoStore({
    items: itemStore,
    // Parse the dataset out properly: a cell anchor is `ds:3/cell:age:1000000001`, so a
    // bare slice(3) would have produced a nonsense id and scoped the memo nowhere.
    scopeFor: (a) => datasetOfTarget(a?.target),
  });
  // NO dataset is created at boot (#158). This line used to exist so "there's always an
  // active dataset for the UI to render against" — a convenience that made a project the
  // engine's only representable state, and the launcher and an invite joiner then had to
  // fake one. Its `addDataset` op is literally the phantom "Dataset 1" that turned up in
  // a co-author's sidebar. The UI renders an empty state instead; a project makes its
  // own first dataset when one is actually opened.
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
  installPassphraseUI(); // register the at-rest passphrase prompt (#144) for export/import/folder
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
  // NOTE: the recycle bin used to be a second DatasetStore rooted at OPFS `recycle/` —
  // a full byte-for-byte copy of every deleted dataset, in a store that couldn't follow
  // the project into a bundle, a folder, or a peer. It is now a projection over the
  // project's own log (#149 A8); nothing is copied and there is no second store.

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
  // Media assets (#139): qualitative audio/image/video are content-addressed and live
  // INSIDE the project (#149 A5) — bytes in its `assets/` directory, metadata as
  // `addAsset` ops in the same log as everything else — so they're encrypted with the
  // project, land in a synced folder with it, and travel with a bundle. The dataset
  // holds only `asset:<id>` refs. The `assets.load(ref) -> Blob` service is the ONLY door
  // a (media-CSP) plugin has to them — it never sees the store, a handle, or the
  // filesystem. Wired below, once `projects` exists; the broker sees it because plugins
  // load post-boot.
  const assetStore = new AssetStore();
  services.assets = createAssetService(assetStore);
  // ZIP for plugins (#139): surface the host's zip module so an archive-format
  // exporter/importer (e.g. REFI-QDA .qdpx) can build/read a ZIP without bundling its
  // own lib or being host-owned. Pure computation on bytes the plugin already holds —
  // `make` returns the archive bytes; `read` unwraps stored + deflated entries.
  services.zip = {
    make: async (entries) => new Uint8Array(await makeZip(entries).arrayBuffer()),
    read: (bytes) => readZipEntries(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  };
  // Media importers are per-medium plugins (builtin-image/audio/video-import, #139):
  // they probe in their own media-CSP sandbox and stream bytes into the store via the
  // `assets.put` sink above — no privileged host importer.
  // SPSS/Stata/SAS (ReadStat) is a sandboxed codec plugin again (#130) — see the codec
  // plugin list above; it runs on the codec sandbox's main thread (ASYNCIFY, no worker).

  // Host-side wiring for declarative plugins: reads manifest.menu, gathers each
  // action's declared inputs, opens the (host-owned) output section, and invokes
  // the plugin's named function. The PluginManager calls wire/unwire on load/unload.
  // Ordered, replayable record of analyses run (the analysis half of the script,
  // #132). Data ops already replay via the data-store log; this covers analyses.
  const analysisLog = new AnalysisLog(bus, projectLog);
  // A destructive re-import swaps the base data out from under the analyses that ran
  // on it, so those analyses are cleared. Two things keep that narrow (#149 A1):
  // `replace` now fires only when the load actually destroyed existing data (filling a
  // fresh dataset — a derived/extracted one, or a blank being seeded — reports `load`),
  // and the clear is scoped to the dataset that was replaced, not the whole project.
  // Transforms/reorders/appends keep their analyses; project open fires `restore`.
  bus.on(CoreEvents.DATA_CHANGED, (summary) => {
    if (summary && summary.reason === 'replace') analysisLog.clearFor(summary.datasetId);
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

  // Cross-plugin invocation (#147): a plugin can call `app.run.analysis(target, opts)`
  // and the host routes it through pluginActions. Added post-creation like codec.
  services.runAnalysis = (target, opts) => pluginActions.runAnalysis(target, opts);

  // One Undo/Redo across BOTH data ops and analysis runs: when the most recent
  // action is an analysis, Undo removes that analysis + its output (not a data op).
  services.memos = createMemoService(memoStore);
  // Read-only for plugins: a plugin REACTS to what the user selected, it does not decide
  // it. Scoped to the caller's own owner like every other plugin surface.
  // Named `selectionRead` and keyed by plugin id, matching workspaceRead / itemsRead:
  // the binder that knows WHICH plugin is asking lives in workspace-manager (per mount)
  // and loader (per compute frame), not in the broker, which does not know.
  services.selectionRead = createSelectionService(
    selection,
    (pluginId) => {
      const p = plugins ? plugins.list().find((x) => x.id === pluginId) : null;
      return p ? ownerToken(p) : 'unknown';
    },
    () => datasets.activeId,
  );
  // Selecting a record is a change the workspace showing that kind needs to see. Reuse
  // the existing refresh hook rather than inventing a second notification path — a
  // workspace already knows how to re-read its state and re-render in place.
  bus.on(SELECTION_CHANGED, () => { void workspaceManager?.notifyWorkspaceRefresh?.(); });

  /**
   * A memo control on an analysis's output section (#152 Layer 2's headline case:
   * "why did I run this?"). The anchor is `analysis:<runId>` — an op-log target, so no
   * new addressing was needed — and the note therefore survives the output being
   * regenerated, which is the whole point: output is derived and disposable, the
   * reasoning behind it is not.
   */
  const decorateRunSection = (section, runId) => {
    const anchor = { kind: ANCHOR_KINDS.ANALYSIS, target: `analysis:${runId}` };
    const existing = section.querySelector('.results-section__memos');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.className = 'results-section__memos';
    wrap.style.cssText = 'margin:2px 0 8px;font-size:12px;';

    const render = () => {
      wrap.replaceChildren();
      for (const m of memoStore.list(anchor)) {
        const line = document.createElement('div');
        line.style.cssText = 'color:#4a5560;padding:2px 0 2px 10px;border-left:2px solid #c8d0d8;margin:2px 0;';
        const who = m.author?.initials ? `${m.author.initials}: ` : '';
        line.textContent = `${who}${m.text}`;
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕';
        del.title = 'Delete this memo';
        del.style.cssText = 'margin-left:6px;border:0;background:none;color:#687381;cursor:pointer;';
        del.addEventListener('click', () => { memoStore.remove(m.id); render(); });
        line.append(del);
        wrap.append(line);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = memoStore.countFor(anchor) ? '＋ memo' : '💬 Add a memo';
      add.title = 'Record why this analysis was run, or what to make of it';
      add.style.cssText = 'border:0;background:none;color:#5a6570;cursor:pointer;padding:2px 0;font-size:12px;';
      add.addEventListener('click', () => {
        const input = document.createElement('input');
        input.placeholder = 'Why this analysis, caveats, what you noticed…';
        input.style.cssText = 'width:100%;max-width:520px;font-size:12px;padding:3px 5px;';
        let done = false;
        const finish = (commit) => {
          if (done) return;
          done = true;
          if (commit && input.value.trim()) memoStore.add(anchor, input.value);
          render();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        add.replaceWith(input);
        input.focus();
      });
      wrap.append(add);
    };
    render();
    const attr = section.querySelector('.results-section__attr');
    if (attr) attr.insertAdjacentElement('afterend', wrap);
    else section.querySelector('.results-section__title')?.insertAdjacentElement('afterend', wrap);
  };
  results.onRunSection?.(decorateRunSection);

  /**
   * Does a memo's anchor still resolve? (#152 D4)
   *
   * A memo outlives the thing it was written about, on purpose: deleting a dataset is
   * recoverable, but the note explaining WHY it was dropped is often the only record
   * that it happened. So instead of sweeping them, orphans are surfaced.
   *
   * Binned counts as existing — the anchor is recoverable, so the memo is not orphaned,
   * it is merely attached to something in the bin. Only a purge orphans it.
   */
  const memoAnchorExists = (anchor) => {
    const t = String(anchor?.target ?? '');
    if (!t) return false;
    if (t.startsWith('project/')) return true;
    if (t.startsWith('ds:')) {
      // Covers the dataset itself AND everything addressed inside it (cells, variables).
      // A cell anchor resolves as long as its DATASET is around: the target is an address,
      // not a record of an event, so a note on a value nobody has edited is still at home.
      const id = datasetOfTarget(t);
      const live = datasets.list().some((d) => String(d.id) === id);
      const binned = datasets.binnedList().some((d) => String(d.id) === id);
      return live || binned;
    }
    if (t.startsWith('analysis:')) {
      const runId = t.slice('analysis:'.length);
      return analysisLog.entries().some((e) => e.runId === runId);
    }
    if (t.startsWith('item:')) {
      const [owner, collection, id] = parseItemTarget(t);
      if (!owner || !collection || !id) return false;
      return !!itemStore.get(owner, collection, id)
        || itemStore.binned(owner, collection).some((r) => r.id === id);
    }
    return true; // an anchor kind the host doesn't know about is not evidence of absence
  };
  const orphanedMemos = () => memoStore.orphans(memoAnchorExists);

  /**
   * Plugin actions as History rows (#152). The host cannot read a record's schema, so the
   * wording comes from the collection DECLARATION — its label, and which field carries a
   * display name. That is the same declaration the sidebar and the asset refcount read;
   * a plugin describes its records once and every host surface can talk about them.
   *
   * Returns rows oldest-first with their HLC, so the panel can place them in time against
   * the data steps rather than guessing.
   */
  const itemHistory = () => {
    const decls = new Map(
      [...CORE_COLLECTIONS, ...declaredCollections(plugins?.list() ?? [], ownerToken)]
        .map((d) => [`${d.owner}\u0000${d.id}`, d]),
    );
    const ops = liveOps(projectLog.slice(isItemOp));
    const seen = new Set();
    const rows = [];
    const activeDs = datasets.activeId;
    for (const op of ops) {
      const [owner, collection, id] = parseItemTarget(op.target);
      // History is per-dataset, so show only records belonging to the dataset in view,
      // plus project-scoped ones (a boundary set, a project note). Scope lives on the
      // RECORD rather than on every op, since a later partial put may omit it.
      const scope = itemStore.get(owner, collection, id)?.scope
        ?? itemStore.binned(owner, collection).find((r) => r.id === id)?.scope
        ?? op.payload?.scope ?? null;
      const ds = scope?.dsId;
      if (ds != null && String(ds) !== String(activeDs)) continue;
      const decl = decls.get(`${owner}\u0000${collection}`);
      const noun = (decl?.label ?? collection).replace(/s$/, '');
      // A removeItem op carries no fields, so read the label off the RECORD instead —
      // it is in the bin, not destroyed. Without this a deletion reads "Removed memo"
      // with no indication of WHICH, which is the one line in the audit trail where
      // knowing what went is the entire point.
      const rec = itemStore.get(owner, collection, id)
        ?? itemStore.binned(owner, collection).find((r) => r.id === id);
      const label = decl?.labelField
        ? (op.payload?.fields?.[decl.labelField] ?? rec?.fields?.[decl.labelField])
        : null;
      const named = typeof label === 'string' && label.trim() ? ` “${label.length > 32 ? `${label.slice(0, 31)}…` : label}”` : '';
      const first = !seen.has(op.target);
      seen.add(op.target);
      const group = decl?.label ?? collection;
      rows.push({
        id: op.id,
        hlc: op.hlc,
        group, // the collection's own label — the heading is built from these
        // purgeItem must be named explicitly: without it a permanent delete fell through
        // to the else and reported itself as an EDIT — the audit trail describing the one
        // irreversible act as the most routine one.
        title: op.type === 'removeItem' ? `Removed ${noun.toLowerCase()}${named}`
          : op.type === 'purgeItem' ? `Deleted ${noun.toLowerCase()}${named} permanently`
            : first ? `Added ${noun.toLowerCase()}${named}`
              : `Edited ${noun.toLowerCase()}${named}`,
        // Always name the collection, and add the author when there is one. The label
        // used to be DROPPED whenever an author existed, which is how a core-owned memo
        // ended up with nothing identifying it but a heading that called it a plugin.
        detail: op.author?.initials ? `${group} · by ${op.author.initials}` : group,
        who: op.author?.initials ?? null,
      });
      void id;
    }
    return rows;
  };

  const undoCoordinator = new UndoCoordinator({
    datasets,
    analysisLog,
    results,
    pluginActions,
    bus,
    // Undo now orders by HLC across every tier rather than by a private stack (#152),
    // so it needs the log itself, the item fold, and a way to tell a live workspace to
    // re-read — a coding tab holds its own in-memory copy, so refolding is not enough.
    projectLog,
    itemStore,
    onItemsChanged: async () => {
      try { await workspaceManager?.notifyWorkspaceRefresh?.(); } catch { /* not mounted */ }
    },
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
    const dataView = new DataView(mounts.viewData, datasets, { memos: memoStore });
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
  const historyPanel = new HistoryPanel(datasets, bus, { analysisLog, pluginActions, undo: undoCoordinator, results, itemHistory });
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

  // Transform ▸ Run R script… — an interop lane (#136): run a user's .R against the
  // active data in the persistent R session (available as `data`), show output +
  // plots, then optionally import a resulting data frame as a new dataset. R runs in
  // its own WASM sandbox — it can't touch the data store.
  menus.register({
    id: 'core:run-r-script',
    path: ['Transform'],
    label: 'Run R script…',
    order: 90,
    command: () => runRScript({ pluginActions, webr, datasets }),
  });
  // The runner that executes an R script into the Output pane — registered so the run
  // is a recorded, replayable analysis step (#137), re-run on replay/undo.
  registerRScriptRunner({ pluginActions, results: results.api, webr, datasets });

  // Dataset library (OPFS), tier 2: reusable building blocks — explicit
  // "Save dataset to library" / "Add dataset from library". No autosave here;
  // the project tier (below) owns autosave.
  const library = new DatasetLibrary({
    items: itemStore,
    assets: assetStore,
    collections: () => [...CORE_COLLECTIONS, ...declaredCollections(plugins?.list() ?? [], ownerToken)],
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
  // Host store for plugin workspace state (#93). Persists per-project, keyed per
  // (owner, workspace id, dataset) (#145); opaque to the host. Empty until a
  // workspace plugin writes.
  const workspaceStore = new WorkspaceStore({ bus, log: projectLog });
  // Item tier (#152): fine-grained, host-folded records — the granular counterpart to
  // the workspace blob above. Plugins write them through `app.items`; core memos live
  // here too. Because the fields are host-visible, asset references inside them can be
  // COUNTED, which is what makes garbage collection possible at all (#150).

  /**
   * Every place an `asset:` reference can live (#152 Layer 5). Reference counting is
   * only as safe as this list is COMPLETE — a source that is missing makes the sweep
   * think an asset is garbage — so the two scanners are deliberately broad:
   *
   *  1. **Item fields** a plugin declared as holding refs (`manifest.collections[]`
   *     `.assetRefs`). The host cannot read the schema, but a field NAME is enough.
   *  2. **Dataset cells**, scanned without any declaration — every string column of
   *     every dataset, INCLUDING binned ones. Binned is not purged (#149 A4), so a
   *     deleted dataset's coding is restorable and its media must stay alive. Scanning
   *     everything is slower than a declared-column list but cannot be out of date,
   *     and a sweep is a rare explicit act.
   *
   * A scanner that throws makes `findOrphans` abstain entirely rather than sweep on
   * partial knowledge — see core/asset-refs.js.
   */
  const assetRefSources = () => {
    const declared = [...CORE_COLLECTIONS, ...declaredCollections(plugins?.list() ?? [], ownerToken)];
    const sources = itemRefSources(itemStore, assetRefDecls(declared));
    // Refuse to sweep while ANY item collection is undeclared: the abstain rule catches a
    // scanner that throws, but a declaration nobody wrote would otherwise look exactly
    // like "nothing references this" (found by browser-testing, #152).
    sources.push(undeclaredItemsGuard(itemStore.all(), declared));
    const scanStore = (store, label) => ({
      name: `dataset:${label}`,
      ids: async () => {
        const cols = await store.getColumns();
        const out = [];
        for (const values of Object.values(cols)) {
          if (!Array.isArray(values)) continue; // Float64Array ⇒ numeric, can't hold a ref
          for (const v of values) out.push(...refsIn(v));
        }
        return out;
      },
    });
    for (const ds of datasets.all()) sources.push(scanStore(ds, ds.id));
    for (const ds of datasets.binnedStores()) sources.push(scanStore(ds, `${ds.id} (binned)`));
    return sources;
  };

  /**
   * Delete asset bytes nothing points at any more. Returns what it did — including the
   * abstain case, which must be reported rather than silently treated as "nothing to do".
   * @param {{dryRun?: boolean}} [opts]
   */
  const sweepAssets = async ({ dryRun = false } = {}) => {
    const index = (await assetStore.list()).map((a) => a.id);
    const { orphans, incomplete } = await findOrphans(index, assetRefSources());
    if (incomplete.length) {
      console.warn('[assets] sweep abstained — these sources could not be read:', incomplete);
      return { swept: [], abstained: true, incomplete };
    }
    if (!dryRun) for (const id of orphans) await assetStore.delete(id);
    return { swept: orphans, abstained: false, incomplete: [] };
  };
  /**
   * Regenerate the Output pane for analyses that arrived from a co-author (#156).
   *
   * The analysis LOG is shared; the pane is not. That is the right split — output is a
   * projection, and merging two panes wholesale was what replaced one peer's messages
   * with the other's. But it left the other half unbuilt: a co-author's run appeared in
   * History, marked current, with nothing to show for it.
   *
   * So each peer materialises its own pixels from the shared log, exactly as reopening a
   * project or running the script editor does. Replay is idempotent and does not
   * re-record, so this cannot echo back around the room.
   *
   * Failures are remembered, not retried. `#execute` already reports a failed run into
   * the pane, and the same failure would otherwise repeat on every subsequent merge —
   * one bad run becoming an error block per keystroke.
   *
   * The attempted set is never cleared and needs no project scoping: a runId is an op id,
   * unique across projects, and reopening a project restores its saved output, so
   * everything already rendered is seen as rendered.
   */
  const materializedRuns = new Set();
  /** Runs we declined to replay because the plugin isn't here — retried when that
   * changes. runId → entry. @type {Map<string, object>} */
  const blockedRuns = new Map();

  /**
   * Can this peer actually run a co-author's analysis? Three different answers, and the
   * difference matters because two of them are things the user can fix in one click.
   * @returns {{ok:true}|{ok:false, reason:'inactive'|'missing', key?:string, name:string}}
   */
  const analysisAvailability = (entry) => {
    if (entry.host) return { ok: true }; // a host action — no plugin involved
    if (loader.list().some((m) => m.id === entry.pluginId)) return { ok: true };
    const known = plugins.list().find((p) => p.id === entry.pluginId);
    if (known) return { ok: false, reason: 'inactive', key: known.key, name: known.name || entry.pluginName };
    return { ok: false, reason: 'missing', name: entry.pluginName || entry.pluginId };
  };

  /** Re-attempt blocked runs, clearing the notices that stood in for them. */
  const retryBlocked = async (entries) => {
    for (const entry of entries) {
      blockedRuns.delete(entry.runId);
      materializedRuns.delete(entry.runId);
      results.removeRun(entry.runId); // take down the notice; the run replaces it
    }
    await materializeMissingAnalyses();
  };

  const materializeMissingAnalyses = async () => {
    const rendered = new Set(results.getModel().map((b) => b.runId).filter(Boolean));
    const pending = analysisLog.entries().filter((e) => e.runId && !rendered.has(e.runId) && !materializedRuns.has(e.runId));
    if (!pending.length) return;
    debug('live', 'materialising peer analyses', { count: pending.length });
    for (const entry of pending) {
      materializedRuns.add(entry.runId);
      const avail = analysisAvailability(entry);
      if (avail.ok) {
        // eslint-disable-next-line no-await-in-loop -- analyses must run in order
        await pluginActions.replay(entry);
        continue;
      }
      // Not a failure — an unmet condition, and the user is one click from meeting it.
      // Left as a bare error this read as "something is broken"; what it actually means
      // is "your co-author ran something you have turned off".
      blockedRuns.set(entry.runId, entry);
      if (avail.reason === 'inactive') {
        results.appendNotice(
          `“${entry.label}” was run by a co-author using the ${avail.name} plugin, which isn't active here. `
          + 'Activate it to see the results.',
          {
            label: `Activate ${avail.name} and run`,
            runId: entry.runId,
            onClick: async () => { await plugins.setEnabled(avail.key, true); await retryBlocked([entry]); },
          },
        );
      } else {
        results.appendNotice(
          `“${entry.label}” was run by a co-author using the ${avail.name} plugin, which isn't installed here. `
          + 'Install it and this will fill in on its own.',
          { label: 'Open plugin manager…', runId: entry.runId, onClick: () => plugins.openDialog() },
        );
      }
    }
  };

  // A plugin arriving or being switched on is the event those notices are waiting for,
  // so they clear themselves — the manager dialog is a shortcut, not the only route, and
  // someone who installs a plugin for their own reasons shouldn't have to find the
  // notice and press it.
  bus.on(CoreEvents.PLUGINS_CHANGED, () => {
    const ready = [...blockedRuns.values()].filter((e) => analysisAvailability(e).ok);
    if (ready.length) void retryBlocked(ready);
  });

  const projectStoreForProjects = new ProjectStore();
  const projects = new ProjectSync({
    projectStore: projectStoreForProjects,
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
    // Merger map for sync (#148 6b): core + the ACTIVE builtin plugins' mergers, so a
    // peer's CAQDAS coding / spatial slots actually MERGE (not clobber) across a shared
    // folder — and, later, live. Third-party plugin blobs need the sandbox bridge (todo).
    getMergers: () => mergersFor(plugins ? plugins.list().filter((p) => p.activated).map((p) => p.id).filter(Boolean) : []),
    // A project also remembers each plugin workspace's state blob. After swapping in
    // the new project's blobs, force-remount any live workspace tabs so they re-read
    // their state — a plugin active in both the old and new project stays mounted, so
    // reconcile() alone wouldn't refresh it and it would keep showing stale data.
    // Workspaces are now the `ws:` tier of the one true log (#148): save carries their
    // ops in manifest.log; load routes them here. The store folds them into its cache.
    projectLog,
    getAssetOps: () => assetStore.ops(),
    applyAssetOps: (ops) => assetStore.restoreOps(ops),
    // Byte-level access for live asset gap-fill (#155). `held` is what we have BYTES
    // for, not what the index lists — a peer holds the ref long before the file lands.
    assetBytes: {
      held: async () => (await assetStore.list({ present: true })).map((a) => a.id),
      read: async (id) => (await assetStore.get(id))?.bytes ?? null,
      // put() re-hashes, and an asset id IS its sha256, so storing verifies identity.
      store: async (id, bytes, meta) => { await assetStore.put(bytes, meta || {}); },
    },
    getItemOps: () => itemStore.ops(),
    applyItemOps: (ops) => itemStore.restoreOps(ops),
    getWorkspaceOps: () => workspaceStore.ops(),
    applyWorkspaces: async (ops, { refresh = false } = {}) => {
      // A non-refresh apply IS the project boundary: it remounts every workspace. Bump
      // first, so mounts created below capture the NEW epoch and any still-in-flight
      // write from the outgoing project's mounts is already stale. A `refresh` is the
      // same project (peer sync / merge), so the epoch must NOT move — the live mounts
      // are legitimate and would be locked out.
      if (!refresh) { projectEpoch += 1; selection.clear(); }
      workspaceStore.restoreOps(Array.isArray(ops) ? ops : []); // ws ops from manifest.log (runs sync, before any await)
      if (!workspaceManager || !plugins) return;
      if (refresh) {
        // A PEER's change (folder/live sync): refresh mounted workspaces IN PLACE via
        // their onRefresh hook — never tear down + remount, because a remount re-runs the
        // sandbox handshake, which times out on a backgrounded window (the "workspace
        // crashed on the other peer" two-window bug). Fall back to remount only if a
        // mounted workspace lacks onRefresh.
        const ok = await workspaceManager.notifyWorkspaceRefresh();
        if (!ok) await workspaceManager.remountActive(plugins.list());
      } else {
        await workspaceManager.remountActive(plugins.list()); // project open/switch → different project's blobs
      }
    },
    // …and the Output tab's results, so reopening shows them (and switching
    // projects clears/reloads output instead of leaving the previous one's).
    getOutput: () => results.getModel(),
    applyOutput: (model) => results.restoreModel(model),
    getAnalysisLog: () => analysisLog.toJSON(),
    applyAnalysisLog: (entries) => analysisLog.load(entries),
    materializeAnalyses: () => materializeMissingAnalyses(),
    getPluginStates: () => (plugins ? plugins.list().map((p) => ({ key: p.key, activated: !!p.activated })) : []),
    applyProjectPlugins: async (opinions) => {
      if (!plugins) return;
      const changed = await plugins.applyProjectPlugins(opinions);
      if (changed.length) debug('project', 'plugin set reconciled from the log', changed);
    },
  });
  // Now that the project exists, point the media store at it: bytes go into the
  // project's own `assets/` dir through the same ProjectStore (so encryption, folder
  // mode and the project layout all apply for free), and the index lives in the shared
  // log. A file dropped into a never-saved project brings the project into being first.
  assetStore.attach({
    store: projectStoreForProjects,
    log: projectLog,
    bus,
    projectId: () => projects.activeId,
    ensureProject: () => projects.ensureProject(),
  });
  projects.activate();

  // File ▸ Export project bundle — the open, self-describing .crosstab archive
  // (Parquet data + JSON schema + transform log). Host-owned (reads all datasets),
  // not a plugin. Import is a follow-up.
  // Invite a collaborator by link (#156). The only entry to a shared project that
  // needs no data transfer up front: the recipient joins an empty CrossTab and the
  // project arrives over the wire (op log, then Parquet + assets via gap-fill).
  menus.register({
    id: 'core:invite-link',
    path: ['File'],
    label: 'Copy invite link…',
    order: 12,
    command: async () => {
      try {
        // A room only exists once the project has a collab identity, which is minted on
        // save — so an unsaved project genuinely has nowhere to invite anyone to.
        const link = await projects.inviteLink();
        if (!link) {
          results.appendError('Save the project first — an invite link needs a room to point at.');
          return;
        }
        let copied = false;
        try { await navigator.clipboard.writeText(link); copied = true; } catch { /* no permission */ }
        results.appendText(
          `**Invite link${copied ? ' (copied to clipboard)' : ''}**\n\n\`${link}\`\n\n`
          + 'Anyone who opens this joins the project — the link IS the key, so treat it '
          + 'like a password. The room id and key sit in the URL fragment, which browsers '
          + 'never send to a server.\n\n'
          + '**You must be online and co-authoring when they open it** — they start from '
          + 'nothing, and every byte comes from you.',
        );
      } catch (err) {
        results.appendError(`Could not build an invite link: ${err.message}`);
      }
    },
  });

  menus.register({
    id: 'core:export-bundle',
    path: ['File'],
    label: 'Export project bundle (.crosstab)…',
    order: 6,
    command: async () => {
      try {
        // Name the bundle after the project; fall back to the active dataset's name (so
        // an unsaved/unnamed project still exports something meaningful) before the
        // generic placeholder. The name rides in the manifest so the recipient agrees.
        const name = projects.activeName || datasets.active?.name || 'crosstab-project';
        // Record the active analysis/plugin set so a recipient restores the same
        // analyses (and is warned about any they don't have — #102).
        const activePlugins = plugins.list().filter((p) => p.activated);
        const collab = projects.collabIdentity?.(); // #148 — bundle carries the room identity
        // The faithful-clone snapshot (raw log + source bytes) — so a hand-off can co-author.
        const snapshot = await projects.exportSnapshot();
        // Carry the project's media with it — a bundle whose `asset:` refs resolve to
        // nothing on the other machine isn't a hand-off (#149 A5).
        const assets = [];
        for (const a of await assetStore.list({ present: true })) {
          const got = await assetStore.get(a.id);
          if (got?.bytes) assets.push({ id: a.id, bytes: got.bytes });
        }
        // Linked building blocks (#149 A9). A block's id is a random UUID minted on the
        // machine that first saved it, and there is no way to share a block between
        // machines at all — so a `libraryLink` is meaningless to anyone but its author,
        // and stale even for them once the block is gone. The DATA is in the bundle
        // either way (the faithful-clone tier carries every dataset's sources), so this
        // is purely about whether the recipient sees a dangling "linked to v3" badge and
        // a Pull-update button that can't work. Default: drop it.
        const linked = datasets.all().filter((d) => d.libraryLink);
        if (linked.length) {
          const keep = await askLinkedBlocks(linked.map((d) => d.name));
          if (keep === null) return; // cancelled
          if (!keep) {
            snapshot.datasetMeta = Object.fromEntries(
              Object.entries(snapshot.datasetMeta ?? {}).map(([k, v]) => [k, { ...v, libraryLink: null }]),
            );
          }
        }
        const blob = await exportProjectBundle({ datasets, bundle: snapshot, projectName: name, plugins: activePlugins, collab, assets });
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
        const { name, bundle, plugins: recorded, assets } = importProjectBundle(new Uint8Array(await file.arrayBuffer()));
        await projects.openBundle({ name, bundle });
        // Land the media into the NEW project's own assets/ dir. After openBundle so the
        // project exists; the `addAsset` ops came in with the log.
        for (const a of assets ?? []) {
          try { await assetStore.put(a.bytes, assetStore.meta(a.id) ?? {}); } catch (e) { console.warn('[assets] import failed', a.id, e); }
        }
        // Warn about analyses/plugins the bundle used but this install doesn't have
        // (#102). Built-ins always present; only non-built-ins (URL/file/authored)
        // can be missing — match by manifest id against what's installed here.
        const have = new Set(plugins.list().map((p) => p.id).filter(Boolean));
        const missing = (recorded || []).filter((p) => !p.builtin && p.id && !have.has(p.id));
        const dsCount = (bundle.log || []).filter((o) => o.type === 'addDataset').length;
        results.api.appendText(`Opened project bundle **${name}** — ${dsCount} dataset(s).`);
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
  new ProjectSidebar(mounts.sidebar, {
    datasets, projects, library, bus,
    workspaceStore, itemStore, assetStore, sweepAssets, memoStore, orphanedMemos, selection,
    pluginList: () => (plugins ? plugins.list() : []),
  });

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
    projectLog, // activation DECISIONS are ops on the project's log (#157)
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

  // Workspace-state read from a plugin's compute frame (#139) — so an exporter (e.g.
  // caqdas's REFI-QDA export) can reach codings the sandbox otherwise walls off. The
  // read is keyed by the caller's OWN owner (#145): it addresses the plugin's own
  // space, which it must declare. This is not a confidentiality barrier (activation
  // is full trust; a blob is no more secret than the dataset) — it's the addressing
  // default; cross-space read would just pass a different owner, and isn't built yet.
  services.workspaceRead = (pluginId, wsId, slotId) => {
    const p = plugins ? plugins.list().find((x) => x.id === pluginId) : null;
    if (!p) { debug('app', 'workspaceRead: plugin not found:', pluginId); return null; }
    const wsDef = (p.workspaces || []).find((w) => w.id === wsId);
    if (!wsDef) { debug('app', 'workspaceRead: wsDef not found:', wsId); return null; }
    const scope = wsDef.scope || 'dataset';
    const dsId = scope === 'project' ? null : datasets.activeId;
    const result = workspaceStore.get(ownerToken(p), wsId, slotId || '_default', dsId);
    debug('app', `workspaceRead ${wsId} slot=${slotId} scope=${scope} dsId=${dsId} →`, result != null ? 'HAS DATA' : 'null');
    return result;
  };
  services.workspaceWrite = (pluginId, wsId, value, dsId, slotId) => {
    const p = plugins ? plugins.list().find((x) => x.id === pluginId) : null;
    if (!p) return;
    const wsDef = (p.workspaces || []).find((w) => w.id === wsId);
    if (!wsDef) return;
    const scope = wsDef.scope || 'dataset';
    const effectiveDsId = scope === 'project' ? null : (dsId ?? datasets.activeId);
    debug('app', `workspaceWrite ${wsId} slot=${slotId} scope=${scope} dsId=${effectiveDsId}`);
    workspaceStore.set(ownerToken(p), wsId, slotId || '_default', effectiveDsId, value);
  };

  // Item read/write from a plugin's COMPUTE frame (#152) — the sibling of
  // workspaceRead/Write above, for the same reason: an exporter (caqdas's REFI-QDA
  // export) runs outside the workspace mount, where the per-mount `items` service does
  // not exist, yet it needs the codings. Owner is resolved from the calling plugin
  // exactly as the workspace path does, so a plugin still only ever reaches its own
  // records — the context changes, the authority rule does not.
  services.itemsRead = (pluginId, collection) => {
    const p = plugins ? plugins.list().find((x) => x.id === pluginId) : null;
    if (!p || !collection) return [];
    return itemStore.list(ownerToken(p), String(collection))
      .map((r) => ({ id: r.id, fields: r.fields, author: r.author ?? null }));
  };
  services.itemsWrite = (pluginId, collection, id, fields) => {
    const p = plugins ? plugins.list().find((x) => x.id === pluginId) : null;
    if (!p || !collection) return null;
    const itemId = id || newItemId();
    itemStore.put(ownerToken(p), String(collection), itemId, fields ?? {});
    return itemId;
  };
  services.itemsRemove = (pluginId, collection, id) => {
    const p = plugins ? plugins.list().find((x) => x.id === pluginId) : null;
    if (!p || !collection || !id) return;
    itemStore.remove(ownerToken(p), String(collection), String(id));
  };

  // Cross-plugin discovery (#147): plugins call `app.plugins.list()` to see what
  // analyses are available. Returns only activated plugins with their menu items.
  services.plugins = {
    list: () => pluginActions.listRunnable(),
  };
  // Notify all loaded plugin iframes when the set of active plugins changes, so
  // workspace plugins that registered `app.plugins.onChange(cb)` can re-query.
  bus.on(CoreEvents.PLUGINS_CHANGED, () => loader.broadcastPluginsChanged());

  // Plugin workspaces (#93): mount/unmount workspace TABS to match the active
  // plugin set. Rides PLUGINS_CHANGED (same signal as menu wiring) + one initial
  // pass for any workspace plugin already active at boot. Only when the tabbed
  // workspace exists (it won't in a headless/embedded mount).
  let workspaceManager = null;
  if (workspaceTabs) {
    workspaceManager = new WorkspaceManager({
      tabs: workspaceTabs,
      store: workspaceStore,
      items: itemStore,
      epoch: currentEpoch,
      services,
      activeDatasetId: () => datasets.activeId, // coding state is per-dataset (#139)
    });
    const reconcileWorkspaces = () => void workspaceManager.reconcile(plugins.list());
    bus.on(CoreEvents.PLUGINS_CHANGED, reconcileWorkspaces);
    reconcileWorkspaces();
    // A workspace reads the active dataset's columns at mount (e.g. the CAQDAS coding
    // tab's document-column picker), so it must re-mount when the ACTIVE dataset
    // changes — otherwise it's frozen on whatever booted and can't see a
    // newly-imported dataset's columns. Gate on the active id actually changing so
    // renames / row edits (which also emit DATASETS_CHANGED / DATA_CHANGED) don't churn
    // it. The codebook + segments persist in the workspace store, so a re-mount is
    // lossless.
    let lastActiveId = datasets.activeId;
    bus.on(DATASETS_CHANGED, () => {
      if (datasets.activeId === lastActiveId) return;
      debug('app', 'dataset switched:', lastActiveId, '→', datasets.activeId);
      lastActiveId = datasets.activeId;
      // Try the lifecycle hook first — if all mounted workspaces handle
      // onDatasetChanged, they re-render in place (faster, preserves DOM state).
      // Fall back to full remount if any workspace lacks the hook.
      void workspaceManager.notifyDatasetChanged(plugins.list()).then((handled) => {
        debug('app', 'notifyDatasetChanged resolved — handled:', handled, handled ? '' : '→ remounting');
        if (!handled) void workspaceManager.remountActive(plugins.list());
      });
    });
    bus.on('workspace:refresh', () => {
      void workspaceManager.notifyWorkspaceRefresh().then((handled) => {
        if (!handled) void workspaceManager.remountActive(plugins.list());
      });
    });
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
  const registerDebugToggle = () => {
    menus.register({
      id: 'core:debug-toggle',
      path: ['Edit', 'Debugging'],
      // Checkbox idiom: the glyph reflects the CURRENT state (☑ on / ☐ off) and
      // clicking toggles it — so it's unambiguously a stateful toggle, not an action.
      label: (isDebug() ? '☑' : '☐') + ' Debug logging',
      order: 10,
      command: () => { setDebug(!isDebug()); registerDebugToggle(); },
    });
  };
  registerDebugToggle();
  menus.register({
    id: 'core:debug-save',
    path: ['Edit', 'Debugging'],
    label: 'Save debug log…',
    order: 20,
    command: () => saveLog(),
  });

  // `dataStore` kept as an alias to the manager (it delegates to the active
  // dataset) so console pokes / older references keep working. Exposed before the
  // launcher so the launcher (and dev tooling) can use the engine.
  const engine = { bus, datasets, itemStore, memoStore, assetRefSources, sweepAssets, dataStore: datasets, duckdb, webr, results, menus, importers, exporters, datasetStore, library, projects, assetStore, loader, plugins, pluginCreator, services, workspaceStore, workspaceManager, codecs, analysisLog, pluginActions, undoCoordinator, projectLog };
  /**
   * Console debugging: dump the FULL one true log — every op across all tiers
   * (collection, data, analysis), including the `retract`/`reorder` tombstones and
   * undone ops that the folded History view hides. `crosstab.dumpLog()` for
   * everything; `crosstab.dumpLog('ds:5')` (or any substring) to filter by target —
   * built for tracing merge issues (#148 Layer 5). Returns the rows too, so it's
   * useful even when console.table is truncated.
   */
  engine.dumpLog = (targetFilter) => {
    const rows = projectLog.dump().filter((r) => !targetFilter || r.target.includes(targetFilter));
    try { console.table(rows); } catch { /* console.table unavailable */ }
    const active = rows.filter((r) => r.state === 'active').length;
    console.log(`[crosstab] ${rows.length} ops — ${active} active, ${rows.length - active} undone${targetFilter ? ` (filter: ${targetFilter})` : ''}`);
    return rows;
  };
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
  const launcher = new Launcher({ plugins, datasets, bus, projects, offline, workspaceStore, itemStore, assetStore });
  engine.launcher = launcher;
  const launchFlag = new URLSearchParams(location.search).get('launch');
  let bypassed = false;

  // An invite link (#156) short-circuits the launcher entirely: the recipient has no
  // data and no choices to make, so showing them a "pick a data source" screen would be
  // asking a question with one answer. Join the room and let the project arrive.
  const invite = parseInviteLink(location.href);
  if (invite) {
    try {
      await projects.joinByInvite(invite);
      // Clear the credential out of the address bar once used. It stays in history, so
      // this is tidiness rather than security — but a shared screen showing the key in
      // the URL for the rest of the session is a needless leak.
      history.replaceState(null, '', location.href.split('#')[0]);
      bypassed = true;
      results.appendText(
        '**Joining a shared project…**\n\nWaiting for the person who sent the link. '
        + 'Everything — the data, and any media or map layers — arrives from them, so '
        + 'they need to be online with the project open and co-authoring turned on.',
      );
      // The live UI is wired further down, so the actual join happens there. Flagging
      // it rather than reaching forward keeps one owner for presence/session lifecycle.
      engine.pendingInviteJoin = true;
    } catch (err) {
      results.appendError(`That invite link didn't work: ${err.message}`);
    }
  }

  if (!bypassed && launchFlag === 'open-folder') {
    // The double-click shortcuts we drop into a folder project (#143) deep-link
    // here: show a focused "Open shared folder" landing instead of the full picker.
    try { await launcher.openFolderLanding(); bypassed = true; } catch (err) { console.warn('Open-folder landing failed', err); }
  } else if (!bypassed && launchFlag) {
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

  // Your identity self-chip in the top bar (#148) — shows your initials, click to edit.
  installIdentityChip(document.querySelector('header'));

  // Live presence (#148 step 5): a "Go live" toggle (only for shareable/folder projects)
  // + peer chips showing who else is in the room. Explicit opt-in — joining the public
  // broker is a deliberate act. Presence carries only the identity beacon, never data.
  const headerEl = document.querySelector('header');
  if (headerEl) {
    const peersEl = document.createElement('div');
    peersEl.className = 'ct-peers';
    const goLiveBtn = document.createElement('button');
    goLiveBtn.type = 'button';
    goLiveBtn.className = 'ct-golive';
    goLiveBtn.hidden = true;
    // "Co-author with X" offer (#148 step 6): appears when a peer is present but we're
    // not yet live-syncing data. One click elevates presence → live co-authoring.
    const offerBtn = document.createElement('button');
    offerBtn.type = 'button';
    offerBtn.className = 'ct-golive ct-coauthor';
    offerBtn.hidden = true;
    headerEl.append(peersEl, offerBtn, goLiveBtn);

    let roster = []; // last presence roster (others)
    const render = () => {
      // peer chips
      peersEl.replaceChildren();
      for (const p of roster) {
        const chip = document.createElement('span');
        chip.className = 'ct-peerchip';
        chip.textContent = p.initials || '·';
        chip.style.background = p.color || '#687381';
        chip.title = p.name || p.initials || 'Someone editing';
        peersEl.append(chip);
      }
      // Go-live toggle (presence)
      goLiveBtn.hidden = !projects.collabReady && !presence.live;
      goLiveBtn.textContent = presence.live ? '● Live' : 'Go live';
      goLiveBtn.classList.toggle('is-live', presence.live);
      goLiveBtn.title = presence.live
        ? 'You’re sharing presence in this project’s room — click to stop'
        : 'Show who else is editing (joins this project’s live room)';
      // Co-author offer / status
      const co = projects.coauthoring;
      const canOffer = roster.length > 0 && presence.live && !co;
      offerBtn.hidden = !canOffer && !co;
      if (co) {
        // Co-authoring is opt-in per peer, not a request/approve handshake: clicking
        // starts OUR side. Show "waiting" until a peer actually joins the doc, so it
        // doesn't imply the other person is synced before they've clicked.
        const joined = projects.coauthorPeerCount > 0;
        offerBtn.textContent = joined ? '● Co-authoring' : 'Waiting for collaborator…';
        offerBtn.classList.toggle('is-live', joined);
        offerBtn.title = joined
          ? 'Live co-authoring — edits sync in real time. Click to stop.'
          : 'You’re ready to co-author; waiting for someone else to start too. Click to stop.';
      } else if (canOffer) {
        const who = roster.map((p) => p.name || p.initials).filter(Boolean).join(', ') || 'collaborator';
        offerBtn.textContent = `Co-author with ${who}`;
        offerBtn.classList.remove('is-live');
        offerBtn.title = 'Start live co-authoring — your edits and theirs sync in real time.';
      }
      debug('live', 'render', { roster: roster.length, live: presence.live, co: projects.coauthoring, offerHidden: offerBtn.hidden });
    };
    // Defensive: never show yourself as a peer (drop any roster entry with your own
    // authorId — a self-echo from the relay). Real peers have distinct authorIds.
    const presence = new LivePresence({ onRoster: (r) => { const me = getIdentity().authorId; roster = (r || []).filter((p) => p.authorId !== me); render(); } });
    engine.presence = presence;

    // Join the current project's room, broadcasting this user's identity beacon.
    const startLive = async () => {
      const room = await projects.activeRoom();
      debug('live', 'startLive', { hasRoom: !!room, collabReady: projects.collabReady });
      if (!room) return false; // not saved yet → no room
      const id = getIdentity();
      await presence.start({
        roomId: room.roomId,
        secret: room.secret,
        self: { authorId: id.authorId, initials: id.initials, name: id.name, color: id.color, since: Date.now() },
      });
      return true;
    };
    // Fully leave: stop data co-authoring first, then presence.
    const stopLive = async () => { projects.stopCoauthoring(); await presence.stop(); };

    // Auto-join when the user opted in ("auto-check for live collaborators"), the project
    // is shareable, and we're online. The setting IS the air-gap/privacy control; being
    // offline just skips it silently (the broker is unreachable anyway).
    let autoStarting = false;
    const maybeAutoLive = async () => {
      if (!getIdentity().autoLive || presence.live || autoStarting || !projects.collabReady || !navigator.onLine) return;
      autoStarting = true;
      try { await startLive(); } catch { /* offline / broker unreachable — stay silent */ } finally { autoStarting = false; render(); }
    };

    goLiveBtn.addEventListener('click', async () => {
      debug('live', 'goLive CLICK', { live: presence.live });
      goLiveBtn.disabled = true;
      try {
        if (presence.live) await stopLive();
        else if (!(await startLive())) engine.results?.appendError?.('This project isn’t shareable yet — save it first.');
      } catch (err) {
        engine.results?.appendError?.(`Live presence failed: ${err.message}`);
      } finally {
        goLiveBtn.disabled = false;
        render();
      }
    });

    offerBtn.addEventListener('click', async () => {
      debug('live', 'offer CLICK', { co: projects.coauthoring, live: presence.live, hasSession: !!presence.session, roster: roster.length });
      offerBtn.disabled = true;
      try {
        if (projects.coauthoring) projects.stopCoauthoring();
        else if (presence.session) await projects.startCoauthoring(presence.session);
      } catch (err) {
        engine.results?.appendError?.(`Live co-authoring failed: ${err.message}`);
      } finally {
        offerBtn.disabled = false;
        render();
      }
    });

    // PROJECT_CHANGED fires on EVERY project emit (save status, co-author start/stop),
    // not just a real switch — so only tear down presence when the project actually
    // CHANGED (compare projectKey). Otherwise startCoauthoring's own emit would trip
    // the handler and immediately stop itself (the "co-author button bounces" storm).
    let lastProjectKey = projects.projectKey;
    bus.on(PROJECT_CHANGED, async () => {
      const key = projects.projectKey;
      if (key !== lastProjectKey) {
        lastProjectKey = key;
        if (presence.live) await stopLive(); // left/switched project → leave its room
        roster = [];
        render();
        void maybeAutoLive(); // auto-join the newly-opened project if opted in
      } else {
        render(); // same project, just a status/co-author re-emit → refresh UI only
      }
    });
    // Toggling "auto-check" on goes live for the current project right away.
    onIdentityChange(() => { render(); void maybeAutoLive(); });
    render();
    void maybeAutoLive(); // the project open at boot

    // An invite joiner (#156) goes live unconditionally — the auto-live SETTING is about
    // volunteering your presence in your own projects, and someone who just followed an
    // invite has already opted in by clicking it. They also elevate straight to
    // co-authoring: with nothing local, presence alone would leave them watching an
    // empty project while the data sat one step away.
    if (engine.pendingInviteJoin) {
      engine.pendingInviteJoin = false;
      void (async () => {
        try {
          if (!(await startLive())) {
            engine.results?.appendError?.('Could not open the invite room.');
            return;
          }
          if (presence.session) await projects.startCoauthoring(presence.session);
          render();
        } catch (err) {
          engine.results?.appendError?.(`Could not join the shared project: ${err.message}`);
        }
      })();
    }
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
      el.style.color = '#646e77';
    } else {
      el.hidden = false;
      el.textContent = offlineCapable ? '✈ Working offline' : '✈ Offline — app only (R engine not cached yet)';
      el.style.color = offlineCapable ? '#646e77' : '#b26a00';
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
    // Emit 'output:cleared' so the project persists the now-empty output (a user
    // clear is real work — without this, reopening the project brings the old output
    // back). Distinct from the clear() that runs inside restoreModel on project LOAD,
    // which must NOT trigger a save mid-load.
    output: { label: 'Clear output', title: 'Clear all output', run: () => { resultsPane?.clear(); bus.emit('output:cleared'); } },
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
    /** The currently-shown view key — so a workspace re-mount can restore it instead
     * of stranding the user on Output. */
    activeView: () => current,
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
/** Human byte size for the inventory line — one decimal, no dependency. */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

class ProjectSidebar {
  /** @type {{count:number,bytes:number}|null} */
  #assets = null;
  /** asset id → byte size, so a reclaim can report how much it frees. @type {Map<string,number>} */
  #assetBytes = new Map();
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
  constructor(host, { datasets, projects, library, bus, workspaceStore, itemStore, assetStore, sweepAssets, memoStore, orphanedMemos, selection, pluginList }) {
    this.host = host;
    this.datasets = datasets;
    this.projects = projects;
    this.library = library;
    this.wsStore = workspaceStore ?? null;
    this.itemStore = itemStore ?? null;
    this.assetStore = assetStore ?? null;
    this.sweepAssets = sweepAssets ?? null;
    this.memoStore = memoStore ?? null;
    this.orphanedMemos = orphanedMemos ?? null;
    this.selection = selection ?? null;
    /** Asset tally for the inventory line, refreshed each render (async, so it is read
     * from a field rather than awaited mid-DOM-build). @type {{count:number,bytes:number}|null} */
    this.#assets = null;
    this.pluginList = pluginList ?? (() => []);
    this.projectName = null;
    bus.on(DATASETS_CHANGED, () => this.render());
    bus.on(CoreEvents.ITEMS_CHANGED, () => this.render()); // the inventory covers items too (#152)
    bus.on(SELECTION_CHANGED, () => this.render()); // …and which of them is selected (#153)
    bus.on(ASSETS_CHANGED, () => this.render()); // …and stored files, however they change
    bus.on(CoreEvents.DATA_CHANGED, () => this.render());
    bus.on(LIBRARY_CHANGED, () => this.render());
    bus.on(CoreEvents.WORKSPACE_CHANGED, () => this.render());
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
    let folderProjects = [];
    try {
      folderProjects = (await this.projects.listFolderProjects?.()) ?? [];
      // Exclude the open folder — it's shown in the active-project zone, not "other".
      const activeFolderId = this.projects.activeFolderId;
      if (activeFolderId) folderProjects = folderProjects.filter((f) => f.id !== activeFolderId);
    } catch {
      /* no remembered folders */
    }
    try {
      blocks = await this.library.list();
    } catch {
      /* OPFS unavailable */
    }
    // What the project is carrying, for the inventory line. Read here (async) so the
    // DOM build below stays synchronous.
    try {
      const assets = (await this.assetStore?.list()) ?? [];
      this.#assetBytes = new Map(assets.map((a) => [a.id, Number(a.size) || 0]));
      this.#assets = assets.length
        ? { count: assets.length, bytes: assets.reduce((t, a) => t + (Number(a.size) || 0), 0) }
        : null;
    } catch {
      this.#assets = null; // never let an asset read break the sidebar
    }
    // The bin is a projection over the project's own log — no store to read, no scope
    // to reconcile, and it follows the project everywhere the project goes (#149 A8).
    const binned = this.datasets.binnedList();
    if (token !== this.#token) return; // superseded by a newer render

    // Block id → current version, so a linked dataset can show "update available".
    const blockVer = new Map(blocks.map((b) => [b.id, b.version ?? 1]));

    this.host.replaceChildren();
    this.host.append(this.#projectZone(blockVer));
    const binnedItems = this.itemStore?.binned() ?? [];
    if (binned.length || binnedItems.length) this.host.append(this.#recycleZone(binned, binnedItems));
    this.host.append(this.#projectsZone(otherProjects, folderProjects));
    this.host.append(this.#blocksZone(blocks));
  }

  // --- zone 1: active project + its datasets ---------------------------------

  #projectZone(blockVer) {
    const frag = document.createDocumentFragment();
    // With no project open (#158) the zone is a prompt, not a project with a blank name:
    // no rename, no delete, no "+ Add dataset" for a project that doesn't exist.
    if (this.projects && !this.projects.hasProject) {
      const empty = el('div', '', 'proj__empty');
      empty.append(el('div', 'No project open', 'proj__name'));
      const hint = el('div', 'Open one from the list below, or start a new one from the CrossTab menu.', 'proj__hint');
      hint.style.cssText = 'font-size:12px; color:#6b7378; margin-top:4px;';
      empty.append(hint);
      const frag0 = document.createDocumentFragment();
      frag0.append(empty);
      return frag0;
    }
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
    head.append(name, editBtn);
    if (this.memoStore) head.append(this.#memoButton(head, { kind: 'project', target: 'project/name' }));
    head.append(delBtn);
    frag.append(head);

    frag.append(el('div', 'Datasets', 'proj__sub'));

    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    // The datasets list is a drop target for building blocks (add to project).
    this.#dropTarget(list, 'block', (id) => this.library.addBlockToProject(id));
    const hidden = this.#hiddenWsIds();
    const items = this.datasets.list();
    for (const it of items) list.append(this.#datasetRow(it, items.length, blockVer, hidden));
    frag.append(list);

    // Project-scoped content — item collections first, then workspace blobs. Both get a
    // section because the sidebar is the project's INVENTORY: the objection to plugin
    // data was never convenience, it was losing sight of the fact that this project HAS
    // data here. Headings come from each collection's declaration, so no plugin is
    // special-cased (the old hardcoded "Map layers" section was exactly that).
    for (const decl of this.#collectionDecls()) {
      const section = this.#collectionSection(decl, null);
      if (!section) continue;
      frag.append(el('div', decl.label, 'proj__sub'));
      frag.append(section);
    }
    if (this.wsStore) {
      const projectBlobs = this.wsStore.listForDataset(null).filter((b) => !hidden.has(b.wsId));
      if (projectBlobs.length) {
        frag.append(el('div', 'Plugin data', 'proj__sub'));
        const blobList = document.createElement('ul');
        blobList.className = 'proj__datasets';
        const wsTitles = this.#wsIdTitles();
        for (const b of projectBlobs) blobList.append(this.#blobRow(b, null, wsTitles));
        frag.append(blobList);
      }
    }
    const orphans = this.orphanedMemos?.() ?? [];
    if (orphans.length) {
      frag.append(el('div', 'Notes with no home', 'proj__sub'));
      const ul = document.createElement('ul');
      ul.className = 'proj__datasets';
      for (const m of orphans) {
        const li = document.createElement('li');
        li.className = 'proj__blob';
        const txt = m.text.length > 40 ? `${m.text.slice(0, 39)}…` : m.text;
        const name = el('span', txt, 'proj__blob-name');
        name.title = `The ${m.anchor?.kind ?? 'thing'} this note was written about is gone. `
          + 'Kept because the note is often the only record of why.';
        name.style.opacity = '0.75';
        li.append(name);
        li.append(iconBtn('✕', 'Delete this note', (e) => {
          e.stopPropagation();
          this.memoStore.remove(m.id);
        }, 'proj__ds-x'));
        ul.append(li);
      }
      frag.append(ul);
    }

    const assetSection = this.#assetsSection(this.#assets);
    if (assetSection) frag.append(assetSection);

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

  /**
   * Every collection the host may show, core's own plus each plugin's (#152).
   * Rebuilt per render so activating a plugin surfaces its data immediately.
   */
  #collectionDecls() {
    let declared = [];
    try {
      declared = declaredCollections(this.pluginList() ?? [], ownerToken);
    } catch {
      /* a broken plugin list must not take out the sidebar */
    }
    return sidebarCollections([...CORE_COLLECTIONS, ...declared]);
  }

  /**
   * One collection's section: a row per record (`sidebar: 'list'`) or a single summary
   * line (`'count'`). The count mode exists because CAQDAS segments run to thousands and
   * would drown the sidebar — the point is visibility that "this project has data here",
   * which a count delivers just as well as a list.
   *
   * @param {object} decl
   * @param {string|number|null} dsId  null ⇒ the project-scoped section
   */
  #collectionSection(decl, dsId) {
    if (!this.itemStore) return null;
    let all = [];
    try {
      all = this.itemStore.list(decl.owner, decl.id);
    } catch {
      return null;
    }
    // Scope is filtered HERE rather than via list({dsId}), which deliberately includes
    // project-scoped records for every dataset — right for a plugin reading its own
    // state, wrong for an inventory that must show each record exactly once.
    let recs = all.filter((r) => (dsId == null
      ? r.scope?.dsId == null
      : String(r.scope?.dsId) === String(dsId)));
    // Orphaned memos get their own section, so keep them out of this one — the same note
    // listed twice reads as two notes.
    if (decl.owner === 'core' && decl.id === 'memos' && this.orphanedMemos) {
      const orphaned = new Set(this.orphanedMemos().map((m) => m.id));
      recs = recs.filter((r) => !orphaned.has(r.id));
    }
    if (!recs.length) return null;

    const frag = document.createDocumentFragment();
    if (decl.sidebar === 'count') {
      const line = el('li', `${decl.label} · ${recs.length}`, 'proj__blob');
      line.title = `${recs.length} ${decl.label.toLowerCase()} in this project`;
      const ul = document.createElement('ul');
      ul.className = 'proj__datasets';
      ul.append(line);
      frag.append(ul);
      return frag;
    }
    const ul = document.createElement('ul');
    ul.className = 'proj__datasets';
    // Indent only when the record genuinely belongs to the dataset above it. A
    // project-scoped record (a map layer) is a PEER of the datasets, and indenting it was
    // drawing it as the child of nothing.
    for (const rec of recs) ul.append(this.#recordRow(decl, rec, dsId != null));
    frag.append(ul);
    return frag;
  }

  /** One item record: its label, inline rename (when a labelField is declared), delete. */
  #recordRow(decl, rec, nested = false) {
    // Rename needs a field to write into. `labelField` when declared, else `name` if the
    // record happens to carry one — which covers most real collections without the host
    // inventing a field. When there is genuinely nothing to write, rename is absent, and
    // that absence is intrinsic rather than a second-class-citizen decision.
    const field = decl.labelField ?? (typeof rec.fields?.name === 'string' ? 'name' : null);
    const summary = decl.summaryField ? rec.fields?.[decl.summaryField] : null;
    return this.#contentRow({
      name: recordLabel(decl, rec),
      title: [decl.label, field ? 'Double-click to rename' : null].filter(Boolean).join(' — '),
      nested,
      // Clicking a record selects it FOR ITS KIND, which is what clicking a dataset has
      // always meant. Selections coexist rather than displace each other (#153 D2), so
      // picking a map layer does not deselect the dataset you are analysing.
      active: !!this.selection?.isActive(decl.owner, decl.id, rec.id),
      onOpen: this.selection ? () => this.selection.set(decl.owner, decl.id, rec.id) : null,
      // Portability is DECLARED, not inferred (#153). It was briefly unconditional,
      // which quietly made memos draggable to the library — a note whose anchor points
      // into the project it was written in. Being listed as a row and being meaningful
      // in another project are different questions, and only the collection's author
      // can answer the second.
      drag: decl.portable
        ? { kind: 'record', id: `${decl.owner}\u0000${decl.id}\u0000${rec.id}` }
        : null,
      summary: summary == null ? null : String(summary),
      onRename: field ? (v) => { if (v) this.itemStore.put(decl.owner, decl.id, rec.id, { [field]: v }); } : null,
      onDelete: () => this.itemStore.remove(decl.owner, decl.id, rec.id),
      deleteTitle: 'Remove from project',
      // Records are annotatable for the same reason datasets are: they have a target.
      // Withholding it was an oversight, not a decision (#153). The exception is memos
      // themselves — #148 settled that memos are FLAT rather than threaded, so offering
      // to annotate an annotation would quietly reintroduce the nesting that decision
      // rejected.
      memoAnchor: decl.owner === 'core' && decl.id === 'memos'
        ? null
        : { kind: 'item', target: itemTarget(decl.owner, decl.id, rec.id) },
    });
  }

  /**
   * The project's stored bytes. Worth a line of its own because it answers "what is this
   * project actually carrying?" — and, now that references can be counted (#150), it can
   * also surface bytes nothing points at, which was unanswerable before.
   */
  #assetsSection(assets) {
    if (!assets || !assets.count) return null;
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'Stored files', 'proj__sub'));
    const ul = document.createElement('ul');
    ul.className = 'proj__datasets';
    const li = el('li', `${assets.count} file${assets.count === 1 ? '' : 's'} · ${fmtBytes(assets.bytes)}`, 'proj__blob');
    li.title = 'Media, geometry and other bytes stored inside this project';
    ul.append(li);
    frag.append(ul);
    if (this.sweepAssets) frag.append(this.#reclaimButton());
    return frag;
  }

  /**
   * Reclaim stored files nothing references any more.
   *
   * Why this is a button and not automatic: assets are content-addressed and SHARED, so
   * removing the last boundary set that used one does not mean the bytes are dead — the
   * same file may back another set, or a dataset column. Deleting on clear would have to
   * guess; refcounting can only answer the question by scanning every dataset, which is
   * far too expensive to run on each sidebar render. So it is an explicit act, like
   * emptying a bin — which is also how the user reached for it ("are they in the bin?").
   *
   * Deliberately unavailable when the sweep abstains: that state is reported, never
   * silently rendered as "nothing to reclaim" (see core/asset-refs.js).
   */
  #reclaimButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'proj__add';
    btn.textContent = 'Reclaim unused files';
    btn.title = 'Delete stored files that nothing in this project points at any more';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const check = await this.sweepAssets({ dryRun: true });
        if (check.abstained) {
          alert(
            'Cannot reclaim safely right now — some references could not be read, '
            + 'so a file that is still in use might look unused:\n\n'
            + check.incomplete.map((i) => `• ${i.name}: ${i.error}`).join('\n'),
          );
          return;
        }
        if (!check.swept.length) {
          alert('Nothing to reclaim — every stored file is still referenced.');
          return;
        }
        const freed = check.swept.reduce((t, id) => t + (this.#assetBytes?.get(id) ?? 0), 0);
        const n = check.swept.length;
        if (!confirm(`Delete ${n} unused file${n === 1 ? '' : 's'}${freed ? ` (${fmtBytes(freed)})` : ''}? This can't be undone.`)) return;
        await this.sweepAssets();
        await this.render();
      } catch (e) {
        console.error('[assets] reclaim failed', e);
        alert(`Reclaim failed: ${e.message}`);
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  /**
   * ONE row for every piece of project content — a dataset, a plugin record, a building
   * block (#153).
   *
   * Before this, records were drawn by a separate builder that gave them a smaller font,
   * grey text and a 24px indent. That styling encoded "subordinate to the dataset above",
   * which was true when all plugin data was a dataset side-car and is false now: a map
   * layer is project-scoped and a peer of the datasets, not a child of one. The visual
   * difference was carrying a claim about ownership that had stopped being true.
   *
   * Sharing the builder also makes the user's actual requirement structural rather than
   * maintained by hand — *however items in a project are displayed should match how items
   * in building blocks are displayed* — and turns flat-vs-grouped into one switch applied
   * to both, instead of a commitment.
   *
   * Genuine subordination still exists (CAQDAS coding really does belong to its dataset),
   * so `nested` indents the row while keeping its treatment identical.
   */
  #contentRow({
    name, title, nested = false, active = false, badge = null, summary = null,
    onOpen = null, onRename = null, onDelete = null, deleteTitle = 'Remove',
    memoAnchor = null, drag = null,
  }) {
    const li = document.createElement('li');
    li.className = 'proj__ds'
      + (active ? ' proj__ds--active' : '')
      + (nested ? ' proj__ds--nested' : '');
    if (drag) {
      li.draggable = true;
      li.addEventListener('dragstart', (e) => this.#startDrag(e, drag.kind, drag.id));
      li.addEventListener('dragend', () => (this.#drag = null));
    }
    if (onOpen) li.addEventListener('click', onOpen);
    else li.style.cursor = 'default';

    const shown = name.length > 44 ? `${name.slice(0, 43).trimEnd()}…` : name;
    const nameEl = el('span', shown, 'proj__ds-name');
    if (title || shown !== name) nameEl.title = [shown === name ? null : name, title].filter(Boolean).join(' — ');
    if (onRename) {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.#inlineRename(li, nameEl, name, onRename);
      });
    }
    li.append(nameEl);

    if (badge) {
      const b = el('span', badge.text, badge.onClick ? 'proj__ds-update' : 'proj__ds-link');
      if (badge.title) b.title = badge.title;
      if (badge.onClick) b.addEventListener('click', (e) => { e.stopPropagation(); badge.onClick(); });
      li.append(b);
    }
    if (summary != null && summary !== '') li.append(el('span', String(summary), 'proj__ds-rows'));

    if (onRename) {
      li.append(iconBtn('✎', 'Rename', (e) => {
        e.stopPropagation();
        this.#inlineRename(li, nameEl, name, onRename);
      }, 'proj__ds-x'));
    }
    if (onDelete) {
      li.append(iconBtn('✕', deleteTitle, (e) => { e.stopPropagation(); onDelete(); }, 'proj__ds-x'));
    }
    if (memoAnchor && this.memoStore) li.append(this.#memoButton(li, memoAnchor));
    return li;
  }

  #datasetRow(it, count, blockVer, hidden) {
    let badge = null;
    if (it.libraryLink) {
      const linkedV = it.libraryLink.version;
      const latest = blockVer?.get(it.libraryLink.id);
      badge = latest != null && latest > linkedV
        ? { text: `↑v${latest}`, title: `Update from v${linkedV} to v${latest}`, onClick: () => void this.library.pullLatest(it.id) }
        : { text: `v${linkedV}`, title: 'Linked to a building block' };
    }
    const li = this.#contentRow({
      name: it.name,
      title: 'Double-click to rename · drag to Building Blocks',
      active: it.active,
      badge,
      summary: it.rowCount.toLocaleString(),
      onOpen: () => { if (!it.active) this.datasets.setActive(it.id); },
      onRename: (v) => this.datasets.rename(it.id, v),
      onDelete: () => void this.#deleteDataset(it),
      deleteTitle: count <= 1 ? 'Remove — resets to a fresh empty dataset' : 'Remove from project',
      memoAnchor: { kind: 'dataset', target: `ds:${it.id}` },
      drag: { kind: 'dataset', id: it.id },
    });

    const frag = document.createDocumentFragment();
    frag.append(li);
    // Dataset-scoped content nests under its dataset, exactly as workspace blobs already
    // do — item collections join them rather than getting a separate arrangement (#152).
    for (const decl of this.#collectionDecls()) {
      const section = this.#collectionSection(decl, it.id);
      if (section) frag.append(section);
    }
    if (this.wsStore) {
      const blobs = this.wsStore.listForDataset(it.id).filter((b) => !hidden?.has(b.wsId));
      if (blobs.length) {
        const wsTitles = this.#wsIdTitles();
        for (const b of blobs) {
          frag.append(this.#blobRow(b, it.id, wsTitles));
        }
      }
    }
    return frag;
  }

  #hiddenWsIds() {
    const set = new Set();
    for (const p of this.pluginList()) {
      if (!Array.isArray(p.workspaces)) continue;
      for (const ws of p.workspaces) {
        if (ws?.id && !ws.tab) set.add(ws.id);
      }
    }
    return set;
  }

  #wsIdTitles() {
    const map = new Map();
    for (const p of this.pluginList()) {
      if (!Array.isArray(p.workspaces)) continue;
      for (const ws of p.workspaces) {
        if (ws?.id && ws.title) map.set(ws.id, ws.title);
      }
    }
    return map;
  }

  /**
   * A workspace BLOB line. Deliberately still the subdued `.proj__blob` style rather than
   * the shared content row (#153).
   *
   * This is not the old second-class treatment surviving by accident — the audit changed
   * what these rows contain. Before #152 a blob WAS the coding, which is why it was
   * listed; now the coding is item records and the blob holds only config (which column
   * holds the documents, a per-dataset layer linkage). Config is not content: you do not
   * name it, reuse it, annotate it, or promote it to a building block. Giving it a row
   * equal to a dataset would overstate it.
   *
   * OPEN (#153): whether these should appear at all now. The visibility they used to
   * provide — "this dataset has plugin data" — is now carried by the item counts
   * ("Codes · 23"), so they may be pure noise. Left visible until that is confirmed.
   */
  #blobRow(blob, dsId, wsTitles) {
    const li = document.createElement('li');
    li.className = 'proj__blob';
    const wsTitle = wsTitles.get(blob.wsId) || blob.wsId;
    const label = blob.label || '';
    const slotSuffix = blob.slotId && blob.slotId !== '_default' ? blob.slotId : '';
    const text = label ? `${wsTitle}: ${label}`
      : slotSuffix ? `${wsTitle}: ${slotSuffix}`
      : wsTitle;
    const name = el('span', text, 'proj__blob-name');
    name.title = 'Double-click to rename';
    const renameAction = (v) => {
      this.wsStore.setLabel(blob.owner, blob.wsId, blob.slotId, dsId, v || null);
    };
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.#inlineRename(li, name, label || slotSuffix, renameAction, 'proj__blob-name');
    });
    li.append(name);
    const edit = iconBtn('✎', 'Rename', (e) => {
      e.stopPropagation();
      this.#inlineRename(li, name, label || slotSuffix, renameAction, 'proj__blob-name');
    }, 'proj__ds-x');
    const x = iconBtn('✕', 'Delete', (e) => {
      e.stopPropagation();
      this.wsStore.set(blob.owner, blob.wsId, blob.slotId, dsId, null);
    }, 'proj__ds-x');
    li.append(edit, x);
    return li;
  }

  // --- recycle bin (#115, re-based on the one true log in #149 A8) ------------
  // Deleting is a status change, not a copy: the dataset's ops and Parquet sidecars stay
  // in the project and a `removeDataset` op records it. So the bin travels with the
  // project, merges, survives a reload, and costs nothing to enter or leave.

  /** Move a dataset to the bin. Its workspace blobs (CAQDAS coding, …) are deliberately
   * left in place — deletion is recoverable and the restore re-attaches to them; they're
   * tombstoned only on a permanent purge. */
  async #deleteDataset(it) {
    await this.datasets.remove(it.id);
    await this.#capRecycle();
  }

  /** Keep at most `cap` binned datasets; purge the oldest beyond it so the bin (and the
   * project's retained bytes) can't grow without bound. */
  async #capRecycle(cap = 20) {
    try {
      const mine = this.datasets.binnedList().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
      for (const e of mine.slice(cap)) await this.#purgeEntry(e);
    } catch {
      /* best effort */
    }
  }

  /** Restore a binned dataset — an appended op and a Map move; no bytes are touched. It
   * returns under its original id, so its workspace/coding state re-attaches by itself. */
  async #restoreDataset(e) {
    try {
      await this.datasets.restoreDeleted({ id: e.id, activate: true });
      this.render();
    } catch (err) {
      console.error('[recycle] restore failed', err);
      alert('Could not restore that dataset.');
    }
  }

  /** The point of no return: drop the data and tombstone the dataset's workspace blobs.
   * Shared by the explicit purge and the bin cap. */
  async #purgeEntry(e) {
    if (!this.datasets.get(e.id)) {
      this.wsStore?.dropDataset(e.id);
      this.itemStore?.dropDataset(e.id); // #152: the dataset's item records go too
    }
    await this.datasets.purge(e.id);
  }

  /** Permanently remove a binned dataset (after confirmation). */
  async #purgeRecycle(e) {
    if (!confirm(`Permanently delete "${e.name}"? This can't be undone.`)) return;
    try {
      await this.#purgeEntry(e);
    } catch (err) {
      console.error('[recycle] purge failed', err);
    }
    this.render();
  }

  /**
   * One binned item record: restore, or purge permanently.
   *
   * Records share the dataset bin rather than getting their own zone, because they are the
   * same KIND of thing — the user-meaningful object, as opposed to the bytes behind it. A
   * dataset keeps its Parquet sidecars while binned; a record keeps its assets, and only a
   * purge releases either. Without this the asymmetry the user spotted was real: datasets
   * were recoverable and a plugin's map layer simply vanished.
   */
  #binnedItemRow(rec, decl) {
    const li = document.createElement('li');
    li.className = 'proj__blob';
    const label = decl ? recordLabel(decl, rec) : rec.id;
    const name = el('span', label, 'proj__blob-name');
    name.title = `${decl?.label ?? rec.collection} — deleted, still recoverable`;
    li.append(name);
    li.append(iconBtn('⤺', 'Restore', (e) => {
      e.stopPropagation();
      this.itemStore.restore(rec.owner, rec.collection, rec.id);
    }, 'proj__ds-x'));
    li.append(iconBtn('✕', 'Delete permanently', (e) => {
      e.stopPropagation();
      if (!confirm(`Permanently delete "${label}"? This can't be undone, and any stored files only it used become reclaimable.`)) return;
      this.itemStore.purge(rec.owner, rec.collection, rec.id);
    }, 'proj__ds-x'));
    return li;
  }

  /**
   * Write a memo against an anchor, inline. Deliberately the same gesture as an inline
   * rename rather than a modal: a memo is a passing thought about the thing you are
   * looking at, and a dialog is enough friction to stop people writing them — which
   * defeats memoing as a practice (the audit trail is only useful if it is kept).
   *
   * @param {HTMLElement} row      the row to compose under
   * @param {{kind: string, target: string, ref?: string}} anchor
   */
  #composeMemo(row, anchor) {
    if (!this.memoStore) return;
    const holder = document.createElement('li');
    holder.className = 'proj__blob';
    const input = document.createElement('input');
    input.className = 'proj__ds-edit';
    input.placeholder = 'Memo — why, caveats, what you noticed…';
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v) this.memoStore.add(anchor, v);
      this.render();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    holder.append(input);
    row.insertAdjacentElement('afterend', holder);
    input.focus();
  }

  /** The 💬 button that opens {@link #composeMemo}, plus a count when notes exist. */
  #memoButton(row, anchor) {
    const n = this.memoStore?.countFor(anchor) ?? 0;
    return iconBtn(n ? `💬${n}` : '💬', n ? `${n} memo${n === 1 ? '' : 's'} — click to add another` : 'Add a memo', (e) => {
      e.stopPropagation();
      this.#composeMemo(row, anchor);
    }, 'proj__ds-x');
  }

  #recycleZone(binned, binnedItems = []) {
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'Recently deleted', 'proj__sub proj__sub--zone'));
    const list = document.createElement('ul');
    list.className = 'proj__datasets';
    if (binnedItems.length) {
      // Fall back through the declaration map so a record whose collection is declared
      // `sidebar: none` still gets a human label once it is in the bin.
      const byKey = new Map(this.#collectionDecls().map((d) => [`${d.owner}/${d.id}`, d]));
      for (const rec of binnedItems) list.append(this.#binnedItemRow(rec, byKey.get(`${rec.owner}/${rec.collection}`)));
    }
    for (const e of binned) {
      const li = document.createElement('li');
      li.className = 'proj__ds proj__ds--trash';
      const name = el('span', e.name, 'proj__ds-name');
      name.title = `Deleted ${new Date(e.deletedAt).toLocaleString()} · ${(e.rowCount || 0).toLocaleString()} rows`;
      name.style.color = '#687381';
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

  #projectsZone(projects, folderProjects = []) {
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'Projects', 'proj__sub proj__sub--zone'));
    if (projects.length === 0 && folderProjects.length === 0) {
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
    // Remembered folder projects (#143) — external folders (OneDrive/Dropbox/local),
    // first-class alongside in-browser projects. Click reopens (a permission re-grant
    // happens on the click); ✕ forgets the entry (leaves the folder's files intact).
    for (const f of folderProjects) {
      const li = document.createElement('li');
      li.className = 'proj__ds proj__ds--folder';
      li.title = `Reopen folder project: ${f.name}`;
      li.addEventListener('click', () => void this.projects.reopenFolder(f.handle));
      const name = el('span', `📁 ${f.name}`, 'proj__ds-name');
      const forget = iconBtn('✕', 'Forget this folder (keeps its files)', (e) => {
        e.stopPropagation();
        void this.projects.forgetFolderProject(f.id);
      }, 'proj__ds-x');
      li.append(name, forget);
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
    this.#dropTarget(list, 'record', (key) => {
      const [owner, collection, recId] = String(key).split('\u0000');
      if (owner && collection && recId) void this.library.promoteRecordToBlock(owner, collection, recId);
    });
    if (blocks.length === 0) {
      list.append(el('li', 'Drag a dataset or a map layer here to reuse it across projects.', 'proj__empty'));
    }
    // Blocks go through the SAME builder as project content, which is the user's actual
    // requirement: however an item looks in a project is how it looks in the library.
    for (const b of blocks) {
      // One list, two kinds — the user's call. The badge is what keeps it readable
      // without splitting into sections that would then have to be kept in step with the
      // project list.
      const kindLabel = b.kind === 'record'
        ? (this.#collectionDecls().find((d) => d.id === b.collection)?.label ?? b.collection ?? 'Record')
        : null;
      list.append(this.#contentRow({
        name: b.name,
        title: kindLabel
          ? `${kindLabel} · click to add to the current project`
          : 'Click to add to the current project · drag onto Datasets',
        badge: { text: kindLabel ? `${kindLabel} · v${b.version ?? 1}` : `v${b.version ?? 1}`, title: 'Block version' },
        onOpen: () => void this.library.addBlockToProject(b.id),
        onDelete: () => void this.library.deleteBlock(b.id),
        deleteTitle: 'Delete building block',
        drag: { kind: 'block', id: b.id },
      }));
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
  // The glyph is decorative; `title` alone is a weak accessible name (VoiceOver
  // ignores it in several contexts, and most of these buttons are destructive).
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}
