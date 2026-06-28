/**
 * @file launcher.js
 * The first-load **launcher** — CrossTab's front door. Three surfaces in one:
 *  - a loading screen (it primes the plugin catalog as plugins' manifests load),
 *  - a plugin **activation** manager (choose which analyses populate the menus),
 *  - onboarding (pick a data source, read the About pitch, "How to use").
 *
 * It's also re-openable mid-session (click the "CrossTab" brand), and bypassable
 * via a `?launch=` URL flag (preset or saved project) for power users and a fast
 * dev loop. Activation rides the existing PluginManager enabled/disabled model;
 * the picker pins the plugins relevant to a chosen discipline (self-declared on
 * each manifest) to the top.
 *
 * Host-owned (drives the loader/manager); not a plugin.
 */

import { makeDemoDataset, makeQualDemoDataset, makeBlankDataset } from './demo-data.js';

/** Curated-core analysis plugins, pre-selected on a fresh "Start blank". */
const CORE_IDS = new Set([
  'builtin-frequencies', 'builtin-descriptives', 'builtin-crosstabs',
  'builtin-correlation', 'builtin-regression', 'builtin-plots',
]);
/** File-I/O categories that are **default-on in a fresh launch** (so import/export
 * works out of the box) — but NOT forced: nothing re-enables them behind the user's
 * back, so disabling a codec (or opening a project that doesn't include one) sticks.
 * 'Import'/'Export' = legacy one-shot importers/exporters; 'Data' = streaming format
 * codecs (#98: CSV, Parquet, NDJSON, SPSS/Stata/SAS). */
const DEFAULT_ON_CATEGORIES = new Set(['Import', 'Export', 'Data']);

/** Launch presets: data source + the extra (non-infra) plugin ids to activate.
 * Used by both the Library buttons and the `?launch=` URL bypass. */
const PRESETS = {
  'start-blank': { source: 'blank', label: 'Blank', plugins: [...CORE_IDS] },
  'demo-quant': { source: 'demo-quant', label: 'Demo (quantitative)', plugins: [...CORE_IDS] },
  'demo-qual': { source: 'demo-qual', label: 'Demo (qualitative)', plugins: [...CORE_IDS, 'builtin-textanalytics', 'builtin-caqdas'] },
};

const LS_SEEN = 'crosstab.launcher.seen';

export class Launcher {
  #plugins; #datasets; #bus; #projects; #offline;
  #root = null;
  /** Selected plugin keys (the checked set). @type {Set<string>} */
  #selected = new Set();
  #discipline = 'All';
  #pendingSource = null; // source key chosen this session, applied on Start
  #pendingProject = null; // { id } when a saved project is chosen instead of a source
  #resolve = null;
  #onKey = null; // Escape-to-dismiss handler, active only while reopened over a session

  /**
   * @param {object} deps
   * @param {import('./plugin-manager.js').PluginManager} deps.plugins
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./event-bus.js').EventBus} [deps.bus]
   * @param {import('./project-sync.js').ProjectSync} [deps.projects] - Enables the
   *   saved-projects rail + the `?launch=<projectName>` bypass.
   * @param {import('./offline.js').OfflineManager} [deps.offline] - Enables the
   *   "Make available offline" control in the About panel.
   */
  constructor({ plugins, datasets, bus, projects, offline }) {
    this.#plugins = plugins;
    this.#datasets = datasets;
    this.#bus = bus;
    this.#projects = projects ?? null;
    this.#offline = offline ?? null;
  }

  /** Load a data source by key (also used by the URL bypass) and name the active
   * dataset to match — setDataset swaps the data but not the name, so without this
   * a "Start blank" session inherits the boot seed's name. */
  async #loadSource(key) {
    let dataset, name;
    if (key === 'demo-quant') { dataset = makeDemoDataset(); name = 'Demo data'; }
    else if (key === 'demo-qual') { dataset = makeQualDemoDataset(); name = 'Qualitative demo'; }
    else { dataset = makeBlankDataset(); name = 'Dataset 1'; } // 'blank' / default
    await this.#datasets.setDataset(dataset);
    try {
      if (this.#datasets.activeId != null) this.#datasets.rename(this.#datasets.activeId, name);
    } catch {
      /* naming is best-effort */
    }
  }

  /** Apply a preset directly (data + plugins), no UI — the `?launch=` path.
   * @param {string} name preset key (start-blank/demo-quant/demo-qual)
   * @returns {Promise<boolean>} whether the preset was recognised */
  async applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return false;
    // Resolving a preset (ids) and the infra categories needs the catalog
    // (id/category per plugin). The UI path primes it; this bypass must too, or a
    // freshly-cleared catalog (first run / CATALOG_VERSION bump) resolves to
    // nothing. primeCatalog only probes uncataloged entries, so it's ~instant once
    // cached.
    await this.#plugins.primeCatalog();
    // A fresh launch gets the default-on set (core stats + file codecs) plus the
    // preset's extras. Codecs are a DEFAULT here, not forced — the user can disable
    // any of them afterwards and it sticks (nothing re-adds them).
    const want = this.#defaultSelection(this.#plugins.list());
    for (const id of preset.plugins) want.add(id);
    await this.#applySelection(want);
    await this.#loadSource(preset.source);
    markSeen();
    return true;
  }

  /** Compute the default selection (keys) for a fresh launch: curated core +
   * infrastructure categories. */
  #defaultSelection(list) {
    const keys = new Set();
    for (const p of list) {
      if (CORE_IDS.has(p.id) || DEFAULT_ON_CATEGORIES.has(p.category)) keys.add(p.key);
    }
    return keys;
  }

  /**
   * Show the launcher and resolve once the user enters the app.
   * @param {{reopen?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async open({ reopen = false } = {}) {
    if (this.#root) return; // already open
    const overlay = el('div', null, 'ctl');
    this.#root = overlay;
    injectStyles();
    overlay.innerHTML = SHELL_HTML(reopen);
    document.body.append(overlay);
    void stampBuild(overlay.querySelector('.ctl__build'));
    const updateBtn = overlay.querySelector('.ctl__update');
    updateBtn?.addEventListener('click', () => void checkForUpdates(updateBtn, overlay.querySelector('.ctl__build')));

    const indicator = overlay.querySelector('.ctl__indicator');
    const listBox = overlay.querySelector('.ctl__plugins');
    const discSel = overlay.querySelector('.ctl__discipline');
    const searchEl = overlay.querySelector('.ctl__search');

    // Prime the catalog (probe any uncataloged manifests), showing progress —
    // this is the "loading screen builds the plugin list as they load" bit.
    indicator.textContent = 'Cataloguing plugins…';
    await this.#plugins.primeCatalog((done, total) => {
      indicator.textContent = `Cataloguing plugins… ${done}/${total}`;
    });
    indicator.textContent = 'Ready';

    const list = this.#plugins.list();
    // Seed the selection: remembered (enabled) once seen; curated core on first run.
    this.#selected = localStorage.getItem(LS_SEEN)
      ? new Set(list.filter((p) => p.enabled).map((p) => p.key))
      : this.#defaultSelection(list);

    // Discipline dropdown options = union of declared disciplines.
    const disciplines = [...new Set(list.flatMap((p) => p.disciplines || []))].sort();
    discSel.innerHTML =
      `<option value="All">All disciplines</option>` +
      disciplines.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');

    const rerender = () => this.#renderPlugins(listBox, list, searchEl.value.trim().toLowerCase());
    discSel.addEventListener('change', () => { this.#discipline = discSel.value; rerender(); });
    searchEl.addEventListener('input', rerender);
    rerender();

    // Library sources.
    overlay.querySelectorAll('[data-source]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.#pendingSource = btn.dataset.source;
        overlay.querySelectorAll('[data-source]').forEach((b) => b.classList.toggle('is-active', b === btn));
        // A demo/blank choice seeds its preset's plugin selection (user can tweak).
        const preset = Object.values(PRESETS).find((p) => p.source === btn.dataset.source);
        if (preset) {
          const want = this.#defaultSelection(list);
          preset.plugins.forEach((id) => { const m = list.find((p) => p.id === id); if (m) want.add(m.key); });
          this.#selected = want;
          rerender();
        }
      });
    });
    // On first open, default the source to Blank so Start always works.
    if (!reopen) overlay.querySelector('[data-source="blank"]')?.classList.add('is-active');

    // Saved projects in the rail: open one (its data + plugin set). Picking a
    // project seeds the picker from what it had active, so the user still sees and
    // can tweak the selection before Start.
    if (this.#projects) {
      let saved = [];
      try { saved = await this.#projects.listProjects(); } catch { saved = []; }
      const projBox = overlay.querySelector('.ctl__projects');
      if (saved.length && projBox) {
        overlay.querySelector('.ctl__railhead--projects')?.removeAttribute('hidden');
        for (const p of saved) {
          const btn = el('button', p.name, 'ctl__source ctl__source--project');
          btn.type = 'button';
          btn.dataset.project = p.id;
          btn.title = `Open project: ${p.name}`;
          btn.addEventListener('click', () => {
            this.#pendingProject = { id: p.id };
            this.#pendingSource = null;
            overlay.querySelectorAll('.ctl__source').forEach((b) => b.classList.toggle('is-active', b === btn));
            if (Array.isArray(p.activePlugins)) {
              // The project's saved plugin set is authoritative — including the user
              // having turned a codec OFF. No infra force-add: a plugin is on only if
              // the project had it on (or the user ticks it here before applying).
              this.#selected = new Set(p.activePlugins.filter((k) => list.some((x) => x.key === k)));
              rerender();
            }
          });
          projBox.append(btn);
        }
      }
    }

    overlay.querySelector('.ctl__howto').addEventListener('click', () => this.#showHowTo());
    overlay.querySelector('.ctl__caveats').addEventListener('click', () => this.#showCaveats());
    this.#renderOffline(overlay);
    this.#renderInstallHint(overlay);
    overlay.querySelector('.ctl__start').addEventListener('click', () => this.#start(reopen));

    // Reopened over a live session: allow dismissing without choosing/reloading a
    // source — Cancel button + Escape just close the overlay and return to the current
    // project unchanged. (On first load there's nothing to go back to, so no Cancel.)
    if (reopen) {
      overlay.querySelector('.ctl__cancel')?.addEventListener('click', () => this.#close());
      this.#onKey = (e) => { if (e.key === 'Escape') this.#close(); };
      document.addEventListener('keydown', this.#onKey);
    }

    return new Promise((resolve) => { this.#resolve = resolve; });
  }

  #renderPlugins(box, list, query) {
    const match = (p) => !query || [p.name, p.category, ...(p.keywords || [])].join(' ').toLowerCase().includes(query);
    const visible = list.filter(match);
    const pinnedActive = this.#discipline !== 'All';
    const isPinned = (p) => pinnedActive && (p.disciplines || []).includes(this.#discipline);
    const pinned = visible.filter(isPinned);
    const rest = visible.filter((p) => !isPinned(p));
    box.replaceChildren();
    if (pinned.length) {
      box.append(this.#section(`Recommended for ${this.#discipline}`, pinned, box, list));
    }
    box.append(this.#section(pinned.length ? 'All other plugins' : 'All plugins', rest, box, list));
  }

  /** A pinned/unpinned section: a header with scoped select-all/none + the grid. */
  #section(title, items, box, fullList) {
    const wrap = el('div', null, 'ctl__section');
    const head = el('div', null, 'ctl__sectionhead');
    head.append(el('span', title, 'ctl__sectiontitle'));
    const keys = items.map((p) => p.key);
    const all = el('button', 'Select all', 'ctl__linkbtn');
    const none = el('button', 'None', 'ctl__linkbtn');
    all.type = none.type = 'button';
    all.addEventListener('click', () => { keys.forEach((k) => this.#selected.add(k)); this.#renderPlugins(box, fullList, ''); });
    none.addEventListener('click', () => { keys.forEach((k) => this.#selected.delete(k)); this.#renderPlugins(box, fullList, ''); });
    head.append(all, none);
    wrap.append(head);

    const grid = el('div', null, 'ctl__grid');
    for (const group of groupByCategory(items)) {
      // Keep a category label with its plugins in one column block, so a
      // single-plugin category doesn't float its lone row beside the header.
      const g = el('div', null, 'ctl__catgroup');
      g.append(el('div', group.category, 'ctl__cat'));
      for (const p of group.items) g.append(this.#pluginRow(p));
      grid.append(g);
    }
    if (!items.length) grid.append(el('div', 'None.', 'ctl__cat'));
    wrap.append(grid);
    return wrap;
  }

  #pluginRow(p) {
    const label = el('label', null, 'ctl__plugin');
    // Hover tooltip: the analyses this plugin adds (so a user can see *why* it's
    // recommended — e.g. Econometrics → robust regression, IV/2SLS, panel).
    if (p.menu && p.menu.length) {
      label.title = `${p.name} adds:\n• ${p.menu.join('\n• ')}`;
    }
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.#selected.has(p.key);
    cb.addEventListener('change', () => {
      if (cb.checked) this.#selected.add(p.key); else this.#selected.delete(p.key);
    });
    label.append(cb, el('span', p.name, 'ctl__pluginname'));
    return label;
  }

  /** Diff the desired selection against current load state and apply live — the
   * picker is authoritative (importers/exporters default ON via #defaultSelection,
   * but a deselect sticks). Delegates to the shared PluginManager primitive that
   * per-project plugin restore also uses; accepts keys (UI) or ids (presets). */
  async #applySelection(desiredKeysOrIds) {
    await this.#plugins.applyActivatedSet(desiredKeysOrIds);
  }

  /** Open a saved project by name (case-insensitive) — the `?launch=<name>` bypass.
   * Restores the project's data *and* its saved plugin set.
   * @param {string} name
   * @returns {Promise<boolean>} whether a matching project was found & opened. */
  async openProjectByName(name) {
    if (!this.#projects) return false;
    let saved = [];
    try {
      saved = await this.#projects.listProjects();
    } catch {
      return false;
    }
    const want = String(name).trim().toLowerCase();
    const match = saved.find((p) => String(p.name).trim().toLowerCase() === want);
    if (!match) return false;
    await this.#projects.openProject(match.id); // full restore (data + its plugins)
    markSeen();
    return true;
  }

  async #start(reopen) {
    const startBtn = this.#root.querySelector('.ctl__start');
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      if (this.#pendingProject && this.#projects) {
        // Open the chosen project's data + workspace state FIRST, *then* apply the
        // picker's selection. Order matters: applying the selection mounts workspace
        // tabs, and a workspace plugin reads its state on mount — so the workspace
        // store must already be hydrated, or it mounts empty and its first autosave
        // clobbers the restored blob (the CAQDAS codebook-loss bug). The picker's
        // plugin set is still authoritative (applied last); the project's own plugin
        // restore is skipped.
        await this.#projects.openProject(this.#pendingProject.id, { applyPlugins: false });
        await this.#applySelection(this.#selected);
      } else {
        await this.#applySelection(this.#selected);
        if (this.#pendingSource || !reopen) {
          // Loading a fresh data source (Demo/Blank). On reopen, FIRST detach into a
          // new project — otherwise setDataset mutates the currently-open project's
          // active dataset and autosave overwrites it (clobbering a saved project).
          // Run it as a *seed load* so merely loading regenerable demo/blank data
          // doesn't auto-create an "Untitled project" (the boot seed's exemption,
          // extended to the reopen path). The user's first real action still saves.
          const doLoad = async () => {
            if (reopen) await this.#projects?.newProject?.();
            await this.#loadSource(this.#pendingSource || 'blank');
          };
          if (this.#projects?.loadingSeed) await this.#projects.loadingSeed(doLoad);
          else await doLoad();
        }
      }
      markSeen();
    } catch (err) {
      console.error('Launcher start failed', err);
      // Never close into a broken/half-loaded state: drop to a clean project so
      // the app is usable. (openProject already self-recovers on a damaged
      // project; this is the backstop for any other start failure.)
      try {
        await this.#projects?.newProject?.();
      } catch {
        /* best-effort */
      }
    }
    this.#close();
  }

  #close() {
    if (this.#onKey) { document.removeEventListener('keydown', this.#onKey); this.#onKey = null; }
    this.#root?.remove();
    this.#root = null;
    this.#pendingSource = null;
    this.#pendingProject = null;
    const r = this.#resolve; this.#resolve = null;
    r?.();
  }

  /** Render the "Make available offline" control (installed-PWA offline caching).
   * Stays hidden when unsupported (no service worker / Cache API). */
  async #renderOffline(overlay) {
    const box = overlay.querySelector('.ctl__offline');
    if (!box || !this.#offline?.supported) return;

    const draw = (status) => {
      box.replaceChildren();
      box.append(el('div', 'Offline', 'ctl__railhead'));
      // Everything caches as you use it (#92): the app shell and each analysis's R
      // engine/packages are kept the first time they're fetched — no opt-in. So the
      // control below is only about PRE-caching the toolkit ahead of time (for stuff
      // you haven't run yet — a flight, an air-gapped machine).
      box.append(el('div', '✓ Works offline automatically', 'ctl__offlineok'));
      box.append(el('p', 'CrossTab and every analysis you run are cached as you use them — so whatever you’ve used already works with no connection. Pre-cache the rest (analyses you haven’t opened yet) for a flight or an air-gapped machine:', 'ctl__offlinehint'));
      const prog = el('div', '', 'ctl__offlineprog');

      // Run enable() for the chosen scope; disable the buttons + stream progress.
      const run = async (opts, btns) => {
        btns.forEach((b) => (b.disabled = true));
        try {
          await this.#offline.enable((t) => { prog.textContent = t; }, opts);
          draw(await this.#offline.status());
        } catch (err) {
          prog.textContent = `Couldn’t enable: ${err.message}`;
          btns.forEach((b) => (b.disabled = false));
        }
      };
      // Packages for the *selected* (ticked) plugins — they aren't loaded until
      // Start, so we resolve them by key here.
      const selectedPackages = () => this.#plugins.rPackagesForKeys([...this.#selected]);

      if (status.enabled) {
        const size = status.bytes ? ` · ~${(status.bytes / 1048576).toFixed(0)} MB` : '';
        const files = status.count ? ` (${status.count} files${size})` : '';
        box.append(el('div', `✓ Full toolkit pre-cached for offline${files}`, 'ctl__offlineok'));
        // Smart caching: the worker keeps caching new packages/assets as you use
        // features. Offer the plan-ahead "cache the whole toolkit" top-up too.
        box.append(el('p', 'More gets cached automatically as you use features. Or top up the full toolkit now:', 'ctl__offlinehint'));
        const allBtn = el('button', '⬇ Cache all plugins', 'ctl__offlinebtn');
        allBtn.type = 'button';
        const rm = el('button', 'Remove offline data', 'ctl__offlinealt');
        rm.type = 'button';
        allBtn.addEventListener('click', () => run({ allPlugins: true }, [allBtn, rm]));
        rm.addEventListener('click', async () => {
          rm.disabled = true;
          try { await this.#offline.disable(); } catch { /* ignore */ }
          draw(await this.#offline.status());
        });
        box.append(allBtn, prog, rm);
      } else {
        // Primary action caches the plugins you've selected (the set you'll actually
        // load); the subordinate link extends that to every plugin in the catalogue.
        const btn = el('button', '⬇ Pre-cache selected plugins', 'ctl__offlinebtn');
        btn.type = 'button';
        btn.title = 'Download the selected plugins and their R packages now, so they work with no connection.';
        const allBtn = el('button', 'Or pre-cache all plugins (larger download)', 'ctl__offlinealt');
        allBtn.type = 'button';
        allBtn.title = 'Also cache plugins you haven’t selected — a bigger download.';
        btn.addEventListener('click', () => run({ packages: selectedPackages() }, [btn, allBtn]));
        allBtn.addEventListener('click', () => run({ allPlugins: true }, [btn, allBtn]));
        box.append(btn, allBtn, prog);
      }
    };

    try {
      draw(await this.#offline.status());
      box.hidden = false;
    } catch {
      box.hidden = true;
    }
  }

  /** Recommend installing on the platforms where "Add to Home Screen" is the idiom
   * AND it materially helps — iOS/iPadOS (Safari's ~7-day tab-eviction of stored
   * data, incl. OPFS projects) and Android/ChromeOS. Deliberately keyed off the
   * platform (UA), NOT a generic touch heuristic: a desktop with a touchscreen has
   * a mouse as its primary pointer and shouldn't be nagged. Hidden when already
   * running standalone. */
  #renderInstallHint(overlay) {
    const box = overlay.querySelector('.ctl__install');
    if (!box) return;
    const standalone =
      window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const isCrOS = /CrOS/.test(ua);
    if (standalone || !(isIOS || isAndroid || isCrOS)) return;

    const head = isCrOS ? 'install CrossTab as an app' : 'add CrossTab to your Home Screen';
    // The ~7-day eviction is iOS/Safari-specific; elsewhere it's about convenience
    // + more durable storage, so the reason is platform-accurate.
    const why = isIOS
      ? 'In a browser tab, mobile Safari can erase a site’s stored data — your <strong>saved projects and datasets</strong>, plus any offline cache — after about a week without opening it. Installed, your work stays put, it launches full-screen, and it’s ready offline in the field.'
      : 'Installing keeps CrossTab one tap away, launches it full-screen, and makes its offline storage more durable — so your <strong>saved projects</strong> and cache stick around.';
    const how = isIOS
      ? 'Tap the Share button, then “Add to Home Screen.”'
      : 'Open your browser’s menu, then “Install app” / “Add to Home screen.”';
    box.innerHTML = `
      <div class="ctl__installhead">📲 For best results, ${head}.</div>
      <details class="ctl__installwhy">
        <summary>Why?</summary>
        <p>${why}</p>
        <p class="ctl__installhow">${how}</p>
      </details>`;
    box.hidden = false;
  }

  #showHowTo() {
    const d = document.createElement('dialog');
    d.className = 'ct-dialog ct-dialog--wide';
    d.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">How to use CrossTab</h2>
        <div class="ctl__howto-body">
          <p><strong>Menubar</strong> (top) — File, Edit, and your analysis menus. The analyses you see are the plugins you switched on here; add more anytime via <em>Edit ▸ Plugins…</em> or by clicking <strong>CrossTab</strong> in the corner to reopen this screen.</p>
          <p><strong>Sidebar</strong> (left) — your project and its datasets. Import a file, or pick a demo on this screen to explore.</p>
          <p><strong>Workspace tabs</strong> — <em>Data</em> (the grid), <em>Variables</em> (rename/recode/label), <em>Output</em> (your results), and an <em>R Console</em>.</p>
          <p><strong>Run an analysis</strong> — pick it from a menu, choose variables in the dialog, and the result appears in Output (export it from <em>File</em>).</p>
        </div>
        <menu class="ct-dialog__buttons"><button value="ok" type="submit" class="ct-dialog__primary">Got it</button></menu>
      </form>`;
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  }

  /** "Caveats & limits": an honest list of the structural limitations of running a
   * whole stats stack in the browser — the trade-offs we haven't engineered away,
   * and what each means in practice. Keeps the "everyone, every device" tagline
   * truthful. */
  #showCaveats() {
    const d = document.createElement('dialog');
    d.className = 'ct-dialog ct-dialog--wide';
    d.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">Caveats &amp; limits — the honest version</h2>
        <div class="ctl__howto-body">
          <p>CrossTab runs entirely in your browser, on your device. That's what keeps
            your data private and lets it work offline — but it also means a few real
            limits we haven't been able to engineer away. Here's what to expect.</p>
          <p><strong>Scrolling a large dataset can lag.</strong> The data grid streams
            rows from an on-disk store instead of holding the whole table in memory, so
            scrolling through a big dataset may take a second to catch up.
            <em>Your data is complete and correct — the view just paints a beat behind.</em></p>
          <p><strong>R analyses are capped at a few GB.</strong> The in-browser R engine
            is 32-bit, so any single R-based analysis can address only a few gigabytes at
            once. <em>Basic data handling scales further (the out-of-core store does that),
            but a heavy model on a very large dataset can run out of memory — work on a
            subset or a sample if you hit it.</em></p>
          <p><strong>First use needs the internet — once.</strong> The R engine and each
            stats package download the first time they're used (tens of MB).
            <em>After that they're cached; you can also pre-cache everything for offline or
            air-gapped use from the loading screen.</em></p>
          <p><strong>Speed depends on your device.</strong> Every computation runs locally,
            so a phone or tablet is slower than a desktop and a heavy model can take a while.
            <em>Nothing is sent to a server to speed it up — that's the trade-off for full
            privacy.</em></p>
        </div>
        <menu class="ct-dialog__buttons"><button value="ok" type="submit" class="ct-dialog__primary">Got it</button></menu>
      </form>`;
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  }
}

// --- helpers ----------------------------------------------------------------

function markSeen() {
  try { localStorage.setItem(LS_SEEN, '1'); } catch { /* storage off */ }
}

/** Group plugins into category sections, BOTH categories and the plugins within
 * each sorted alphabetically — predictable for discovery. */
function groupByCategory(items) {
  const byCat = new Map();
  for (const p of items) {
    const c = p.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  return [...byCat.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ category: c, items: byCat.get(c).sort((x, y) => x.name.localeCompare(y.name)) }));
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** The Last-Modified of the app code this device is actually RUNNING. Fetched through
 * the service worker, so on an installed PWA (where the shell is served cache-first)
 * this is the CACHED/loaded build — NOT whatever the server now has. GitHub Pages
 * re-stamps every file's Last-Modified to the deploy time on each rebuild, so this is
 * effectively "which deploy is loaded." Best-effort: null if unavailable. */
async function loadedBuildTime() {
  try {
    const res = await fetch('core/app.js', { cache: 'no-store' });
    return res.headers.get('last-modified') || null;
  } catch {
    return null;
  }
}

function formatBuildTime(lm) {
  if (!lm) return null;
  const d = new Date(lm);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Fill the launcher's build stamp with the LOADED build's publish time (see
 * {@link loadedBuildTime}) — so a stale installed PWA shows the OLD time, truthfully
 * reflecting the code that's running rather than the server's latest deploy. */
async function stampBuild(elBuild) {
  if (!elBuild) return;
  const f = formatBuildTime(await loadedBuildTime());
  elBuild.textContent = f ? `build: ${f}` : 'build: (unknown)';
}

/** Post a one-shot message to the active service worker and await its reply (or null
 * on no controller / timeout). Drives the SW's `refresh-shell`. */
function swMessage(type, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => finish(e.data);
    setTimeout(() => finish(null), timeoutMs);
    try { ctrl.postMessage({ type }, [ch.port2]); } catch { finish(null); }
  });
}

/** Manual "Check for updates" for installed (Home Screen) PWAs, which have no browser
 * refresh button. No cleverness, no build-number comparison: when the user asks to
 * check, we actually go fetch the files and reload into them. Specifically:
 *  1. `reg.update()` — pick up a changed service worker if there is one.
 *  2. `refresh-shell` — tell the SW to RE-FETCH every cached same-origin app file from
 *     the network (cache:'reload'), replacing the cached copies. This is what makes an
 *     app-code deploy (which doesn't touch sw.js, so no new worker) actually arrive.
 *  3. Drop the persisted plugin catalog so the next boot RE-PROBES every plugin from
 *     its (now-refreshed) file — not from the cached index. So new/changed plugins
 *     show up without needing a catalog-version bump.
 *  4. Always reload. The user asked to check; they get fresh code, every time.
 * Only network state gates it (offline → can't fetch). */
async function checkForUpdates(btn, elBuild) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const restore = (msg) => {
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2600);
  };
  if (!navigator.onLine) { restore('Offline — connect to check'); return; }
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    await reg?.update?.().catch(() => {});
    btn.textContent = 'Fetching latest…';
    await swMessage('refresh-shell'); // re-fetch all cached same-origin files from network
    // Force a full plugin re-probe on the next boot (read the files, not the cached
    // catalog index) — keep in sync with plugin-manager.js LS_CATALOG.
    try { localStorage.removeItem('crosstab.plugins.catalog'); } catch { /* ignore */ }
    btn.textContent = 'Reloading…';
    setTimeout(() => window.location.reload(), 350);
  } catch {
    restore('Check failed — try again');
  }
}

function SHELL_HTML(reopen) {
  return `
    <div class="ctl__card">
      <div class="ctl__header">
        <div class="ctl__brand">CrossTab</div>
        <div class="ctl__tagline">Statistics for everyone, every device, everywhere</div>
        <div class="ctl__build" title="When this deployed build was published (the served files' last-modified time). Useful for confirming a device picked up the latest version.">build: …</div>
        <button type="button" class="ctl__update" title="Re-check the server for a newer version and reload into it. Useful as an installed app (Home Screen), where there's no browser refresh button.">Check for updates</button>
      </div>
      <div class="ctl__body">
        <aside class="ctl__library">
          <div class="ctl__railhead">Start from</div>
          <button type="button" class="ctl__source" data-source="blank">Start blank</button>
          <button type="button" class="ctl__source" data-source="demo-quant">Demo · quantitative</button>
          <button type="button" class="ctl__source" data-source="demo-qual">Demo · qualitative</button>
          <div class="ctl__railnote">Or import your own data once you're in.</div>
          <div class="ctl__railhead ctl__railhead--projects" hidden>Projects</div>
          <div class="ctl__projects"></div>
        </aside>
        <section class="ctl__center">
          <div class="ctl__centerhead">
            <span class="ctl__indicator">Loading…</span>
            <select class="ctl__discipline" aria-label="Field / discipline"></select>
            <input type="search" class="ctl__search" placeholder="Filter plugins…" autocomplete="off">
          </div>
          <div class="ctl__plugins"></div>
        </section>
        <aside class="ctl__about">
          <div class="ctl__railhead">About</div>
          <p>CrossTab is free, open-source software. Your <strong>data never leaves your device</strong> — every analysis runs locally in your browser.</p>
          <p>All plugin code is inspectable, and <strong>all plugins are equal</strong> — you're encouraged to write your own.</p>
          <button type="button" class="ctl__howto">How to use →</button>
          <button type="button" class="ctl__howto ctl__caveats">Caveats &amp; limits →</button>
          <div class="ctl__offline" hidden></div>
          <div class="ctl__install" hidden></div>
        </aside>
      </div>
      <div class="ctl__footer">
        ${reopen ? '<button type="button" class="ctl__cancel">← Back to project</button>' : ''}
        <button type="button" class="ctl__start">${reopen ? 'Apply changes' : 'Start CrossTab'}</button>
      </div>
    </div>`;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .ctl { position: fixed; inset: 0; z-index: 2000; background: rgba(20,28,38,.55);
      display: flex; align-items: center; justify-content: center; padding: 16px; }
    .ctl__card { background: var(--bg, #f7f8fa); width: min(1040px, 96vw); max-height: 94vh;
      border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.4); display: flex; flex-direction: column; overflow: hidden; }
    .ctl__header { background: var(--bar, #2c3e50); color: var(--bar-fg, #ecf0f1); padding: 18px 24px; text-align: center; }
    .ctl__brand { font-size: 26px; font-weight: 800; letter-spacing: .04em; }
    .ctl__tagline { font-size: 13px; opacity: .85; margin-top: 2px; }
    .ctl__build { font-size: 11px; opacity: .55; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .ctl__update { font: inherit; font-size: 11px; margin-top: 6px; padding: 4px 10px; cursor: pointer;
      color: var(--accent, #2980b9); background: transparent; border: 1px solid var(--line, #d8dde2);
      border-radius: 6px; min-height: 30px; }
    .ctl__update:hover { background: #eef5fb; }
    .ctl__update:disabled { opacity: .6; cursor: default; }
    .ctl__body { display: flex; min-height: 0; flex: 1; }
    .ctl__library, .ctl__about { flex: 0 0 200px; padding: 16px; overflow-y: auto; }
    .ctl__about { border-left: 1px solid var(--line, #d8dde2); font-size: 13px; color: #41505e; }
    .ctl__about p { margin: 0 0 10px; }
    .ctl__library { border-right: 1px solid var(--line, #d8dde2); }
    .ctl__railhead { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #7a8590; margin: 0 0 8px; }
    .ctl__railnote { font-size: 12px; color: #8a94a0; margin-top: 12px; }
    .ctl__railhead--projects { margin-top: 16px; }
    .ctl__source--project { font-size: 13px; }
    .ctl__projects:empty { display: none; }
    .ctl__source { display: block; width: 100%; text-align: left; font: inherit; font-size: 14px;
      padding: 10px 12px; margin: 0 0 6px; border: 1px solid var(--line, #d8dde2); border-radius: 8px; background: #fff; cursor: pointer; }
    .ctl__source:hover { background: #eef5fb; }
    .ctl__source.is-active { border-color: var(--accent, #2980b9); background: #e6f0fa; font-weight: 600; }
    .ctl__center { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 16px; }
    .ctl__centerhead { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
    .ctl__indicator { font-size: 12px; color: #7a8590; flex: none; min-width: 92px; }
    .ctl__discipline, .ctl__search { font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--line, #d8dde2); border-radius: 6px; }
    .ctl__search { flex: 1; min-width: 0; }
    .ctl__plugins { flex: 1; overflow-y: auto; border: 1px solid var(--line, #d8dde2); border-radius: 8px; background: #fff; padding: 8px 10px; }
    .ctl__section { margin: 0 0 10px; }
    .ctl__sectionhead { display: flex; align-items: center; gap: 8px; position: sticky; top: -8px;
      background: #fff; padding: 6px 0 4px; border-bottom: 1px solid var(--line, #d8dde2); margin: 0 0 6px; }
    .ctl__sectiontitle { font-size: 12px; font-weight: 700; color: #41505e; flex: 1; }
    .ctl__linkbtn { font: inherit; font-size: 12px; background: none; border: 0; color: var(--accent, #2980b9); cursor: pointer; padding: 2px 4px; }
    .ctl__linkbtn:hover { text-decoration: underline; }
    .ctl__grid { columns: 2; column-gap: 22px; }
    .ctl__catgroup { break-inside: avoid; -webkit-column-break-inside: avoid; display: block; }
    .ctl__cat { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: #9aa3ab;
      margin: 6px 0 2px; break-inside: avoid; }
    .ctl__plugin { display: flex; align-items: center; gap: 7px; padding: 3px 2px; font-size: 13.5px; cursor: pointer; break-inside: avoid; }
    .ctl__plugin:hover { background: #f4f8fc; }
    .ctl__pluginname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctl__about .ctl__howto { display: block; font: inherit; font-size: 13px; color: var(--accent, #2980b9); background: none; border: 0; cursor: pointer; padding: 0; }
    .ctl__about .ctl__howto:hover { text-decoration: underline; }
    .ctl__about .ctl__caveats { margin-top: 6px; }
    .ctl__offline { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line, #d8dde2); }
    .ctl__offlinehint { font-size: 12px; color: #8a94a0; margin: 0 0 8px; }
    .ctl__offlinebtn { font: inherit; font-size: 13px; padding: 7px 10px; width: 100%; cursor: pointer;
      border: 1px solid var(--accent, #2980b9); border-radius: 8px; background: #fff; color: var(--accent, #2980b9); }
    .ctl__offlinebtn:hover { background: #eef5fb; }
    .ctl__offlinebtn:disabled { opacity: .6; cursor: default; }
    .ctl__offlinealt { display: block; width: 100%; margin-top: 6px; font: inherit; font-size: 12px;
      color: var(--accent, #2980b9); background: none; border: 0; cursor: pointer; padding: 2px 0; text-align: center; }
    .ctl__offlinealt:hover { text-decoration: underline; }
    .ctl__offlinealt:disabled { opacity: .6; cursor: default; text-decoration: none; }
    .ctl__offlineprog { font-size: 12px; color: #7a8590; margin-top: 6px; min-height: 1em; }
    .ctl__offlineok { font-size: 13px; color: #2e7d32; margin: 0 0 6px; font-weight: 600; }
    .ctl__install { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--accent, #2980b9);
      border-radius: 8px; background: #eef5fb; }
    .ctl__installhead { font-size: 12.5px; color: #1f4e6b; line-height: 1.4; }
    .ctl__installwhy { margin-top: 4px; font-size: 12px; color: #41505e; }
    .ctl__installwhy summary { cursor: pointer; color: var(--accent, #2980b9); width: max-content; }
    .ctl__installwhy p { margin: 6px 0 0; line-height: 1.45; }
    .ctl__installhow { color: #5a6570; }
    .ctl__footer { padding: 12px 24px; border-top: 1px solid var(--line, #d8dde2); display: flex; justify-content: flex-end; gap: 10px; background: #fff; }
    .ctl__cancel { margin-right: auto; font: inherit; font-size: 14px; padding: 10px 18px; cursor: pointer;
      background: #fff; border: 1px solid var(--line, #d8dde2); border-radius: 8px; color: #41505e; }
    .ctl__cancel:hover { background: #eef2f6; }
    .ctl__start { font: inherit; font-size: 15px; font-weight: 600; padding: 10px 28px; border: 0;
      border-radius: 8px; background: var(--accent, #2980b9); color: #fff; cursor: pointer; }
    .ctl__start:hover { background: #1f6391; }
    .ctl__start:disabled { opacity: .6; cursor: default; }
    .ctl__howto-body p { margin: 0 0 10px; line-height: 1.5; }`;
  document.head.append(s);
}
