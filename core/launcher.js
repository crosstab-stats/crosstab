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
/** Categories whose plugins are infrastructure — always active (import/export). */
const INFRA_CATEGORIES = new Set(['Import', 'Export']);

/** Launch presets: data source + the extra (non-infra) plugin ids to activate.
 * Used by both the Library buttons and the `?launch=` URL bypass. */
const PRESETS = {
  'start-blank': { source: 'blank', label: 'Blank', plugins: [...CORE_IDS] },
  'demo-quant': { source: 'demo-quant', label: 'Demo (quantitative)', plugins: [...CORE_IDS] },
  'demo-qual': { source: 'demo-qual', label: 'Demo (qualitative)', plugins: [...CORE_IDS, 'builtin-textanalytics'] },
};

const LS_SEEN = 'crosstab.launcher.seen';

export class Launcher {
  #plugins; #datasets; #bus;
  #root = null;
  /** Selected plugin keys (the checked set). @type {Set<string>} */
  #selected = new Set();
  #discipline = 'All';
  #pendingSource = null; // source key chosen this session, applied on Start
  #resolve = null;

  /**
   * @param {object} deps
   * @param {import('./plugin-manager.js').PluginManager} deps.plugins
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./event-bus.js').EventBus} [deps.bus]
   */
  constructor({ plugins, datasets, bus }) {
    this.#plugins = plugins;
    this.#datasets = datasets;
    this.#bus = bus;
  }

  /** Load a data source by key (also used by the URL bypass). */
  async #loadSource(key) {
    if (key === 'demo-quant') return this.#datasets.setDataset(makeDemoDataset());
    if (key === 'demo-qual') return this.#datasets.setDataset(makeQualDemoDataset());
    return this.#datasets.setDataset(makeBlankDataset()); // 'blank' / default
  }

  /** Apply a preset directly (data + plugins), no UI — the `?launch=` path.
   * @param {string} name preset key (start-blank/demo-quant/demo-qual)
   * @returns {Promise<boolean>} whether the preset was recognised */
  async applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return false;
    // Presets (URL bypass) include infrastructure (importers/exporters) so the
    // session is usable; the interactive picker, by contrast, is authoritative.
    const want = new Set(preset.plugins);
    for (const p of this.#plugins.list()) if (INFRA_CATEGORIES.has(p.category)) want.add(p.key);
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
      if (CORE_IDS.has(p.id) || INFRA_CATEGORIES.has(p.category)) keys.add(p.key);
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

    const indicator = overlay.querySelector('.ctl__indicator');
    const listBox = overlay.querySelector('.ctl__plugins');
    const discSel = overlay.querySelector('.ctl__discipline');
    const searchEl = overlay.querySelector('.ctl__search');

    // Prime the catalog (probe any uncataloged manifests), showing progress —
    // this is the "loading screen builds the plugin list as they load" bit.
    indicator.textContent = 'Loading plugins…';
    await this.#plugins.primeCatalog((done, total) => {
      indicator.textContent = `Loading plugins… ${done}/${total}`;
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

    overlay.querySelector('.ctl__howto').addEventListener('click', () => this.#showHowTo());
    overlay.querySelector('.ctl__start').addEventListener('click', () => this.#start(reopen));

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

  /** Diff the desired selection against current enabled state and apply live. */
  async #applySelection(desiredKeysOrIds) {
    const list = this.#plugins.list();
    // Allow callers to pass ids (presets) or keys (UI). Build a key set. The
    // selection is authoritative — importers/exporters default ON (see
    // #defaultSelection) but the user can deselect them and that sticks.
    const keySet = new Set();
    for (const p of list) {
      if (desiredKeysOrIds.has(p.key) || (p.id && desiredKeysOrIds.has(p.id))) keySet.add(p.key);
    }
    // Diff against actual LOAD state (not the persisted enabled flag, which can
    // drift): load what's wanted-but-not-loaded, unload what's loaded-but-not-
    // wanted. setEnabled also persists the enabled/disabled flag either way.
    for (const p of list) {
      const want = keySet.has(p.key);
      if (want && !p.loaded) await this.#plugins.setEnabled(p.key, true);
      else if (!want && p.loaded) await this.#plugins.setEnabled(p.key, false);
    }
  }

  async #start(reopen) {
    const startBtn = this.#root.querySelector('.ctl__start');
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      await this.#applySelection(this.#selected);
      // Load data only if a source was chosen (on reopen, keep current data unless picked).
      if (this.#pendingSource || !reopen) await this.#loadSource(this.#pendingSource || 'blank');
      markSeen();
    } catch (err) {
      console.error('Launcher start failed', err);
    }
    this.#close();
  }

  #close() {
    this.#root?.remove();
    this.#root = null;
    this.#pendingSource = null;
    const r = this.#resolve; this.#resolve = null;
    r?.();
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
}

// --- helpers ----------------------------------------------------------------

function markSeen() {
  try { localStorage.setItem(LS_SEEN, '1'); } catch { /* storage off */ }
}

const CATEGORY_ORDER = ['Import', 'Descriptive Statistics', 'Comparison', 'Compare Means', 'Correlation', 'Regression', 'Multivariate', 'Time Series', 'Survival', 'Categorical', 'Scale', 'Text', 'Resampling', 'Graphs', 'Export'];
function categoryRank(c) {
  if (c === 'Other') return 1000;
  const i = CATEGORY_ORDER.indexOf(c);
  return i >= 0 ? i : 500;
}
function groupByCategory(items) {
  const byCat = new Map();
  for (const p of items) {
    const c = p.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  return [...byCat.keys()]
    .sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
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

function SHELL_HTML(reopen) {
  return `
    <div class="ctl__card">
      <div class="ctl__header">
        <div class="ctl__brand">CrossTab</div>
        <div class="ctl__tagline">Statistics for everyone, every device, everywhere</div>
      </div>
      <div class="ctl__body">
        <aside class="ctl__library">
          <div class="ctl__railhead">Start from</div>
          <button type="button" class="ctl__source" data-source="blank">Start blank</button>
          <button type="button" class="ctl__source" data-source="demo-quant">Demo · quantitative</button>
          <button type="button" class="ctl__source" data-source="demo-qual">Demo · qualitative</button>
          <div class="ctl__railnote">Or import your own data once you're in.</div>
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
        </aside>
      </div>
      <div class="ctl__footer">
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
    .ctl__body { display: flex; min-height: 0; flex: 1; }
    .ctl__library, .ctl__about { flex: 0 0 200px; padding: 16px; overflow-y: auto; }
    .ctl__about { border-left: 1px solid var(--line, #d8dde2); font-size: 13px; color: #41505e; }
    .ctl__about p { margin: 0 0 10px; }
    .ctl__library { border-right: 1px solid var(--line, #d8dde2); }
    .ctl__railhead { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #7a8590; margin: 0 0 8px; }
    .ctl__railnote { font-size: 12px; color: #8a94a0; margin-top: 12px; }
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
    .ctl__about .ctl__howto { font: inherit; font-size: 13px; color: var(--accent, #2980b9); background: none; border: 0; cursor: pointer; padding: 0; }
    .ctl__about .ctl__howto:hover { text-decoration: underline; }
    .ctl__footer { padding: 12px 24px; border-top: 1px solid var(--line, #d8dde2); display: flex; justify-content: flex-end; background: #fff; }
    .ctl__start { font: inherit; font-size: 15px; font-weight: 600; padding: 10px 28px; border: 0;
      border-radius: 8px; background: var(--accent, #2980b9); color: #fff; cursor: pointer; }
    .ctl__start:hover { background: #1f6391; }
    .ctl__start:disabled { opacity: .6; cursor: default; }
    .ctl__howto-body p { margin: 0 0 10px; line-height: 1.5; }`;
  document.head.append(s);
}
