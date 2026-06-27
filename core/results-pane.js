/**
 * @file results-pane.js
 * Renders analysis output into the results area.
 *
 * Output philosophy (see project README): results should read like SPSS output
 * — labelled tables, clean layout, significance stars — not like an R console
 * dump. Plugins therefore hand this renderer *structured, already-formatted*
 * fragments (an HTML table, an SVG plot, a Markdown note) rather than raw text,
 * and the pane is responsible only for placing and styling them.
 *
 * ## Open question (resolved here, with rationale): shadow DOM
 * The pane mounts its content inside an **open shadow root**. Reasons:
 *   - Plugin- and analysis-authored table HTML cannot leak styles into the app
 *     chrome, and the app's CSS reset cannot clobber carefully formatted tables.
 *   - We can ship one canonical "SPSS-ish" stylesheet that every analysis table
 *     inherits for free, giving visual consistency across third-party plugins.
 * The root is *open* (not closed) so tests and power users can still inspect it.
 *
 * ## Trust note
 * Every plugin — built-in or third-party — runs sandboxed and is untrusted, so
 * the HTML/SVG fragments that arrive here over postMessage are sanitised through
 * {@link sanitizeHtml} before insertion. The sanitiser is a conservative
 * allowlist, not a full audited defence; see sanitize-html.js. (Markdown passed
 * to {@link ResultsPane#appendText} is HTML-escaped during rendering, so it is
 * safe without a second pass.)
 */

import { sanitizeHtml } from './sanitize-html.js';
import { downloadFile } from './export-service.js';

/** Canonical stylesheet applied inside the shadow root. Kept inline so the pane
 * is self-contained and has no external CSS dependency. */
const RESULTS_STYLES = `
  :host { display: block; }
  .results-root {
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1a1a1a;
    padding: 16px;
    -webkit-text-size-adjust: 100%; /* keep table text stable on iPad Safari */
  }
  .results-section { margin: 0 0 28px; }
  .results-section__title {
    font-size: 15px; font-weight: 700; letter-spacing: .02em;
    text-transform: uppercase; color: #333;
    border-bottom: 2px solid #333; padding-bottom: 4px; margin: 0 0 12px;
  }
  /* Always-on attribution: which plugin produced this, and its host-tracked
     origin. The plugin can't forge the origin, so output is always traceable. */
  .results-section__attr {
    font-size: 11px; color: #8a8a8a; margin: -8px 0 12px; letter-spacing: .01em;
  }
  .results-block { margin: 0 0 16px; overflow-x: auto; }
  /* SPSS-like pivot tables */
  table { border-collapse: collapse; font-size: 13px; min-width: 240px; }
  caption {
    caption-side: top; text-align: left; font-weight: 600;
    padding: 0 0 6px; color: #222;
  }
  th, td { padding: 6px 12px; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  thead th { border-bottom: 1px solid #333; }
  tbody tr:last-child td { border-bottom: 1px solid #333; }
  tbody th { font-weight: 600; }
  .results-note { color: #555; }
  .results-note h1, .results-note h2, .results-note h3 { margin: .4em 0; }
  .results-note code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: #f4f4f4; padding: 1px 4px; border-radius: 3px;
  }
  .results-error {
    border-left: 3px solid #c0392b; background: #fdf3f2;
    padding: 8px 12px; color: #7a201a; white-space: pre-wrap;
    font-family: ui-monospace, Menlo, monospace; font-size: 12px;
  }
  svg { width: 100%; max-width: 720px; height: auto; display: block; }
  /* A plot lives in a user-resizable box (drag the lower-right grip). Default ~
     svglite's 7×4.5in (672×432px) so the first render is pixel-true; min() keeps
     it responsive on narrow screens, and there's NO max-width so a drag can grow
     it poster-size (the pane scrolls if it exceeds the viewport). The SVG fills
     the box but keeps its aspect (preserveAspectRatio), so dragging just scales/
     letterboxes — crisp (vector) but the *ratio* doesn't change until you click
     "Redraw at this size", which re-runs the recipe at the box's dimensions. */
  .results-plot {
    position: relative;
    resize: both; overflow: hidden; box-sizing: border-box;
    width: min(100%, 672px); height: 432px;
    border: 1px solid #e3e7eb; border-radius: 6px; padding: 4px;
  }
  .results-plot__svg { width: 100%; height: 100%; }
  .results-plot__svg svg { width: 100%; height: 100%; max-width: none; }
  .results-plot__redraw {
    position: absolute; right: 18px; bottom: 4px;
    font: inherit; font-size: 12px; padding: 3px 9px;
    background: #fff; border: 1px solid var(--accent, #2980b9);
    color: var(--accent, #2980b9); border-radius: 6px; cursor: pointer;
    opacity: 0; transition: opacity .12s;
  }
  .results-plot:hover .results-plot__redraw, .results-plot__redraw:focus { opacity: .95; }
  /* "save this plot" controls, mirror of the redraw button on the lower-left */
  .results-plot__save {
    position: absolute; left: 8px; bottom: 4px; display: flex; gap: 4px;
    opacity: 0; transition: opacity .12s;
  }
  .results-plot:hover .results-plot__save, .results-plot__save:focus-within { opacity: .95; }
  .results-plot__savebtn {
    font: inherit; font-size: 12px; padding: 3px 9px;
    background: #fff; border: 1px solid var(--accent, #2980b9);
    color: var(--accent, #2980b9); border-radius: 6px; cursor: pointer;
  }
  .results-empty { color: #888; font-style: italic; }
`;

/**
 * Owns the results DOM and exposes the append-style API plugins call through
 * `app.results`.
 */
export class ResultsPane {
  /** @type {ShadowRoot} */
  #root;

  /** Container element inside the shadow root that holds all blocks. */
  #content;

  /** The section blocks append into, or null to append at top level. */
  #currentSection = null;

  /** A host-set section to create **lazily** on the first append of an analysis
   * run (so a cancelled run leaves no empty heading). `{title, attribution}`. */
  #pendingSection = null;

  /** The element to scroll into view when Output is (re)focused after new output —
   * the section heading of the latest analysis, or the latest top-level block. So a
   * newly run analysis snaps the user to the *start* of its output. Cleared on
   * {@link ResultsPane#clear}; not set by a restore (no auto-scroll on rehydrate). */
  #lastAnchor = null;

  /** Plot handle → its SVG holder element, for {@link ResultsPane#updatePlot}. */
  #plots = new Map();

  /** Next plot handle id. */
  #nextPlotId = 1;

  /** Optional event bus, so appendError can ask the workspace to surface Output. */
  #bus = null;

  /**
   * The **result model**: an ordered, structured record of everything appended to
   * the pane, parallel to the DOM. This is the single source the export plugins
   * read (via {@link ResultsPane#getModel}) so output export honours the
   * "everything is a plugin" model rather than scraping the host's shadow DOM.
   * Item kinds: `{kind:'section', title, attribution?, ts?}` (ts = epoch ms run time),
   * `{kind:'text', html}` (rendered),
   * `{kind:'table', html}` (sanitised), `{kind:'plot', svg, id}`,
   * `{kind:'error', message}`.
   * @type {Array<object>}
   */
  #model = [];

  /** Host-tracked attribution of the plugin whose `results.*` call is currently
   * being dispatched (set by the broker around each call; see {@link ResultsPane#setActiveAttribution}).
   * While set, an append made with no open section is placed in a fallback
   * attributed section rather than landing unattributed — so a plugin can never
   * produce an unattributed block, even if it skips `beginAnalysis` or escapes its
   * host-opened bracket with `endAnalysis` (#106). Null for host-originated output
   * (imports, transforms, R notices), which legitimately stays top-level. */
  #activeAttribution = null;

  /**
   * @param {HTMLElement} host - The element to attach the shadow root to.
   * @param {{bus?: import('./event-bus.js').EventBus}} [opts]
   */
  constructor(host, { bus } = {}) {
    this.#bus = bus ?? null;
    this.#root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = RESULTS_STYLES;
    this.#root.append(style);

    this.#content = document.createElement('div');
    this.#content.className = 'results-root';
    this.#root.append(this.#content);

    this.#renderEmptyState();
  }

  /**
   * Start a new titled section. Subsequent appends are nested under it until the
   * next `beginSection` or {@link ResultsPane#clear}. This mirrors SPSS's
   * grouping of an analysis's tables under one heading.
   *
   * @param {string} title - Section heading, e.g. "Frequencies".
   */
  beginSection(title) {
    this.#clearEmptyState();
    this.#pendingSection = null;
    this.#currentSection = this.#createSection({ title: String(title ?? ''), attribution: null });
  }

  /**
   * Host-facing: open an analysis's output section **lazily**. The host calls this
   * before invoking a plugin's `run` (the plugin no longer titles its own output —
   * see the declarative plugin API). The section's heading is the menu label the
   * user clicked, and `attribution` (plugin name + host-tracked origin) is stamped
   * under it so output is always traceable and a plugin can't mislabel it. Nothing
   * is created until the first append, so a cancelled/empty run shows no heading.
   *
   * @param {string} title - The clicked menu item's label (host-owned).
   * @param {string} [attribution] - e.g. "Descriptive Statistics · built-in".
   */
  beginAnalysis(title, attribution) {
    this.#clearEmptyState();
    this.#currentSection = null;
    this.#pendingSection = { title: String(title ?? ''), attribution: attribution || null };
  }

  /** Host-facing: close the current analysis section so later output starts fresh. */
  endAnalysis() {
    this.#currentSection = null;
    this.#pendingSection = null;
  }

  /**
   * Broker-facing (NOT plugin-reachable — it is deliberately absent from the
   * broker's RPC allowlist): set the host-tracked attribution of the plugin whose
   * `results.*` call is being dispatched, then clear it (null) afterwards. This is
   * what lets {@link ResultsPane#place} stamp a fallback attributed section for any
   * append a plugin makes outside an explicit analysis bracket — closing the
   * unattributed/forgeable output path (#106). Host output (no broker in the call
   * path) never sets this, so it stays top-level.
   *
   * @param {string|null} attribution - e.g. "Word Cloud · from example.com".
   */
  setActiveAttribution(attribution) {
    this.#activeAttribution = attribution || null;
  }

  /** Build a section element (heading + optional attribution + run timestamp), record
   * it in the model, and append it to the content. `ts` (epoch ms) is when this
   * section was produced; defaults to now for a live run, or carries the saved value
   * on restore so reopened output shows when each result was *originally* run (#124,
   * fresh-vs-stale). The attribution and timestamp share one meta line under the
   * heading; the model keeps them as separate fields. */
  #createSection({ title, attribution, ts }) {
    const stamp = Number.isFinite(ts) ? ts : Date.now();
    const section = document.createElement('section');
    section.className = 'results-section';

    const heading = document.createElement('h2');
    heading.className = 'results-section__title';
    heading.textContent = title;
    section.append(heading);

    const meta = [attribution, formatRunTime(stamp)].filter(Boolean).join('  ·  ');
    if (meta) {
      const el = document.createElement('div');
      el.className = 'results-section__attr';
      el.textContent = meta;
      el.title = new Date(stamp).toString(); // full date/time on hover
      section.append(el);
    }

    this.#content.append(section);
    this.#model.push({ kind: 'section', title, attribution: attribution || undefined, ts: stamp });
    this.#lastAnchor = section; // scroll target: the start of this analysis's output
    return section;
  }

  /**
   * Append a table from **structured data**, rendered host-side — so a plugin
   * ships no markup (the big injection surface is gone; only plots remain SVG).
   *
   * `data` is either a WebR data.frame result (`{names, values}` — hand the result
   * of `app.webr.run` straight in) or an explicit spec
   * `{caption?, columns, rows, rowHeaders?}` where a cell is a `string|number` or
   * a `string[]` (rendered stacked, e.g. correlation's r/p/N). Cells are inserted
   * as text nodes, never parsed as HTML — so a plugin ships no markup here.
   *
   * @param {object} data
   * @param {{caption?: string, rowHeaders?: boolean}} [opts]
   */
  appendTable(data, opts = {}) {
    const block = this.#makeBlock();
    const spec = normalizeTableData(data, opts);
    const tableEl = renderTableEl(spec);
    block.append(tableEl);
    this.#place(block);
    // Store the spec (for structured exporters) plus the host-rendered HTML (the
    // output exporters read `.html` to reproduce the table).
    this.#model.push({ kind: 'table', table: spec, html: tableEl.outerHTML });
    this.#bus?.emit?.('output:written');
  }

  /**
   * Append a plot supplied as an SVG string. SVG (rather than a raster image) is
   * preferred so plots stay crisp on high-DPI displays and scale to width.
   *
   * @param {string} svgString - An `<svg>…</svg>` fragment; sanitised before
   *   insertion (the sanitiser allows a conservative SVG drawing subset).
   */
  appendPlot(svgString, opts = {}) {
    const block = this.#makeBlock();
    // Resizable wrapper: a lower-right grip scales the plot (vector → crisp).
    block.classList.add('results-plot');
    const holder = document.createElement('div');
    holder.className = 'results-plot__svg';
    holder.innerHTML = sanitizeHtml(svgString);
    block.append(holder);

    const handle = this.#nextPlotId++;
    this.#plots.set(handle, holder);
    this.#model.push({ kind: 'plot', svg: sanitizeHtml(svgString), id: handle });

    // If the plot knows how to redraw itself (a plugin callback), offer a button
    // that re-runs it at the box's *current* dimensions — the only way to change
    // the plot's aspect ratio without distorting it (drag alone just scales).
    if (typeof opts.onRedraw === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'results-plot__redraw';
      btn.textContent = '⟳ Redraw at this size';
      btn.title = 'Re-render at the current box size — re-lays-out at the new ratio';
      btn.addEventListener('click', () => {
        opts.onRedraw(Math.max(1, holder.clientWidth), Math.max(1, holder.clientHeight));
      });
      block.append(btn);
    }

    // A "save this plot" control: SVG is direct (the plot already is SVG); PNG is
    // rasterised from it via a canvas. Hover-revealed, like the redraw button.
    const save = document.createElement('div');
    save.className = 'results-plot__save';
    save.append(
      makeSaveBtn('⬇ SVG', () => savePlotSvg(holder, handle)),
      makeSaveBtn('⬇ PNG', () => savePlotPng(holder, handle)),
    );
    block.append(save);

    this.#place(block);
    this.#bus?.emit?.('output:written');
    return handle;
  }

  /**
   * Replace the SVG of a previously appended plot, in place (keeps the box size
   * and the redraw button). Used by the plot plugin after a "Redraw at this
   * size" re-render. No-op if the handle is unknown.
   *
   * @param {number} handle - The id returned by {@link ResultsPane#appendPlot}.
   * @param {string} svgString - The new plot SVG; sanitised before insertion.
   */
  updatePlot(handle, svgString) {
    const holder = this.#plots.get(handle);
    if (!holder) return;
    const safe = sanitizeHtml(svgString);
    holder.innerHTML = safe;
    const item = this.#model.find((m) => m.kind === 'plot' && m.id === handle);
    if (item) item.svg = safe;
  }

  /**
   * Append explanatory text written in a small subset of Markdown (headings,
   * **bold**, *italic*, `code`, and paragraphs). For anything richer, render to
   * HTML upstream and use {@link ResultsPane#appendTable}.
   *
   * @param {string} markdown - Markdown source.
   */
  appendText(markdown) {
    const block = this.#makeBlock();
    block.className += ' results-note';
    const html = renderMiniMarkdown(markdown);
    block.innerHTML = html;
    this.#place(block);
    this.#model.push({ kind: 'text', html });
    this.#bus?.emit?.('output:written');
  }

  /**
   * Append an error message in a distinct, monospaced error block. Used by the
   * engine (and plugins) to surface a failed analysis without breaking layout.
   *
   * @param {string} message - Plain-text error detail.
   */
  appendError(message) {
    const block = this.#makeBlock();
    block.className = 'results-block results-error';
    block.textContent = message;
    this.#place(block);
    this.#model.push({ kind: 'error', message: String(message ?? '') });
    // Surface the error: ask the workspace to switch to Output (errors fired
    // outside an analysis — imports, transforms, plugin loads — otherwise land on
    // a tab the user isn't looking at).
    this.#bus?.emit?.('output:error');
  }

  /** Remove all output and reset to the empty state. */
  clear() {
    this.#content.replaceChildren();
    this.#currentSection = null;
    this.#pendingSection = null;
    this.#lastAnchor = null;
    this.#plots.clear();
    this.#model = [];
    this.#renderEmptyState();
  }

  /**
   * The result model — a deep copy of the structured output record, for export
   * plugins (`app.results.getModel`). Plot items carry their SVG and an `id` that
   * {@link ResultsPane#getPlotPng} can rasterise.
   * @returns {Array<object>}
   */
  getModel() {
    return this.#model.map((m) => ({ ...m }));
  }

  /**
   * Rebuild the pane from a saved model (the inverse of {@link ResultsPane#getModel})
   * — so reopening a project shows its output without re-running. Also CLEARS first,
   * so switching to a project with no/old output never leaves stale results on
   * screen. Does not emit 'output:written' (a restore isn't a new result).
   *
   * @param {Array<object>} model - A model array from a prior getModel().
   */
  restoreModel(model) {
    this.clear(); // wipes DOM + model; shows empty state if nothing to restore
    if (!Array.isArray(model) || model.length === 0) return;
    this.#clearEmptyState();
    this.#currentSection = null;
    this.#pendingSection = null;
    for (const item of model) {
      if (!item || !item.kind) continue;
      if (item.kind === 'section') {
        this.#currentSection = this.#createSection({ title: item.title || '', attribution: item.attribution || null, ts: item.ts });
      } else if (item.kind === 'table') {
        const block = this.#makeBlock();
        let html = item.html || '';
        if (item.table) {
          const tableEl = renderTableEl(item.table); // re-render from spec (host DOM, no injection)
          block.append(tableEl);
          html = tableEl.outerHTML;
        } else {
          // No spec to re-render from — the saved html comes from a project file that
          // may be untrusted (shared .crosstab), so sanitise before it hits the host
          // DOM. The live append path produces escaped DOM; this guards restore (#89).
          html = sanitizeHtml(html);
          block.innerHTML = html;
        }
        this.#place(block);
        this.#model.push({ kind: 'table', table: item.table, html });
      } else if (item.kind === 'text') {
        const block = this.#makeBlock();
        block.className += ' results-note';
        // Saved html can come from an untrusted project file — sanitise on restore (#89).
        const safe = sanitizeHtml(item.html || '');
        block.innerHTML = safe;
        this.#place(block);
        this.#model.push({ kind: 'text', html: safe });
      } else if (item.kind === 'plot') {
        const block = this.#makeBlock();
        block.classList.add('results-plot');
        const holder = document.createElement('div');
        holder.className = 'results-plot__svg';
        const safe = sanitizeHtml(item.svg || '');
        holder.innerHTML = safe;
        block.append(holder);
        const handle = this.#nextPlotId++;
        this.#plots.set(handle, holder);
        const save = document.createElement('div');
        save.className = 'results-plot__save';
        save.append(
          makeSaveBtn('⬇ SVG', () => savePlotSvg(holder, handle)),
          makeSaveBtn('⬇ PNG', () => savePlotPng(holder, handle)),
        );
        block.append(save);
        this.#place(block);
        this.#model.push({ kind: 'plot', svg: safe, id: handle });
      } else if (item.kind === 'error') {
        const block = this.#makeBlock();
        block.className = 'results-block results-error';
        block.textContent = item.message || '';
        this.#place(block);
        this.#model.push({ kind: 'error', message: item.message || '' });
      }
    }
    // A divider at the BOTTOM of the restored output: everything above it is from
    // the last save; results you run this session append below it, so live work is
    // always distinguishable from the restored snapshot. It persists until the next
    // save+reload — which restores everything above a fresh divider (the line moves
    // down past it).
    const divider = document.createElement('div');
    divider.dataset.restoreDivider = 'true';
    divider.textContent = '↑ above: restored from your last save · new results appear below';
    divider.style.cssText =
      'text-align:center;font-size:12px;color:#7a8590;font-style:italic;margin:16px 12px 4px;padding-top:10px;border-top:1px dashed #c8d0d8;';
    this.#content.append(divider);
  }

  /** The canonical results stylesheet, so an HTML export can reproduce the look
   * (`app.results.getStyles`). */
  getStyles() {
    return RESULTS_STYLES;
  }

  /**
   * Rasterise a plot to PNG bytes (`app.results.getPlotPng`). Done host-side from
   * the live SVG element (the proven path) so export plugins don't need canvas in
   * their sandbox. Resolves null if the id is unknown.
   * @param {number} id - A plot item's `id` from {@link ResultsPane#getModel}.
   * @returns {Promise<Uint8Array|null>}
   */
  async getPlotPng(id) {
    const holder = this.#plots.get(id);
    const svg = holder?.querySelector('svg');
    if (!svg) return null;
    return svgElToPngBytes(svg);
  }

  /**
   * The frozen object exposed to plugins as `app.results`.
   * @returns {Readonly<{
   *   beginSection: (title: string) => void,
   *   appendTable: (html: string) => void,
   *   appendPlot: (svg: string) => void,
   *   appendText: (md: string) => void,
   *   appendError: (msg: string) => void,
   *   clear: () => void,
   * }>}
   */
  get api() {
    return Object.freeze({
      beginSection: (t) => this.beginSection(t),
      // A workspace brackets its own output with these; the broker stamps the
      // (unspoofable) attribution, so plugin-driven output is traceable too.
      beginAnalysis: (t, a) => this.beginAnalysis(t, a),
      endAnalysis: () => this.endAnalysis(),
      appendTable: (data, opts) => this.appendTable(data, opts),
      appendPlot: (s, opts) => this.appendPlot(s, opts),
      updatePlot: (handle, s) => this.updatePlot(handle, s),
      appendText: (m) => this.appendText(m),
      appendError: (m) => this.appendError(m),
      clear: () => this.clear(),
      // Read surface for output-export plugins (honours "everything is a plugin").
      getModel: () => this.getModel(),
      getStyles: () => this.getStyles(),
      getPlotPng: (id) => this.getPlotPng(id),
      // Host/broker-only: NOT in the broker's RPC allowlist, so a sandboxed plugin
      // cannot call it — only host code with a direct reference can (the broker, to
      // stamp the calling plugin's attribution for fallback sections; see #106).
      setActiveAttribution: (a) => this.setActiveAttribution(a),
    });
  }

  // --- internals -------------------------------------------------------------

  #makeBlock() {
    const block = document.createElement('div');
    block.className = 'results-block';
    return block;
  }

  /** Place a block into the current section, materialising a host-set pending
   * section on first use, or appending at top level if there is none. */
  #place(block) {
    this.#clearEmptyState();
    if (!this.#currentSection && !this.#pendingSection && this.#activeAttribution) {
      // A plugin appended with no open analysis section — it skipped beginAnalysis,
      // or escaped its host-opened bracket via endAnalysis. Don't let the block
      // land unattributed at top level: open a fallback section stamped with the
      // host-tracked attribution of the calling plugin (which it cannot forge).
      this.#pendingSection = { title: 'Plugin output', attribution: this.#activeAttribution };
    }
    if (!this.#currentSection && this.#pendingSection) {
      this.#currentSection = this.#createSection(this.#pendingSection);
      this.#pendingSection = null;
    }
    const target = this.#currentSection ?? this.#content;
    target.append(block);
    // A bare top-level block (host output with no section) is its own scroll anchor;
    // for sectioned output the anchor is the section heading (set in #createSection).
    if (target === this.#content) this.#lastAnchor = block;
  }

  /**
   * Scroll the start of the most recent output into view. Called by the host when
   * it (re)focuses the Output tab after new output, so a freshly run analysis snaps
   * the user to the top of its results rather than leaving them wherever they were.
   * Deferred a frame so it runs after the just-revealed panel has laid out. No-op if
   * nothing new has been appended since the last {@link ResultsPane#clear}.
   */
  scrollToLatest() {
    const anchor = this.#lastAnchor;
    if (!anchor) return;
    requestAnimationFrame(() => {
      if (anchor.isConnected) anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  #renderEmptyState() {
    if (this.#content.childElementCount > 0) return;
    const empty = document.createElement('div');
    empty.className = 'results-empty';
    empty.dataset.emptyState = 'true';
    empty.textContent = 'No results yet. Run an analysis to see output here.';
    this.#content.append(empty);
  }

  #clearEmptyState() {
    const empty = this.#content.querySelector('[data-empty-state]');
    if (empty) empty.remove();
  }
}

/**
 * Normalise table input into `{caption, columns, rows, rowHeaders}`. Accepts a
 * WebR data.frame result (`{names, values}`, column-oriented) or an explicit spec.
 * @param {object} data
 * @param {{caption?: string, rowHeaders?: boolean}} opts
 */
function normalizeTableData(data, opts) {
  if (data && Array.isArray(data.names) && Array.isArray(data.values)) {
    const columns = data.names.map(String);
    const cols = data.values.map((c) => (Array.isArray(c?.values) ? c.values : [].concat(c)));
    const n = cols.length ? cols[0].length : 0;
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(cols.map((c) => c[i]));
    return { caption: opts.caption ?? '', columns, rows, rowHeaders: !!opts.rowHeaders };
  }
  return {
    caption: data.caption ?? opts.caption ?? '',
    columns: (data.columns ?? []).map(String),
    rows: data.rows ?? [],
    rowHeaders: !!(data.rowHeaders ?? opts.rowHeaders),
  };
}

/** Build a `<table>` from a normalised spec, entirely via DOM APIs so cell text
 * is inserted as text nodes — never parsed as HTML (no injection possible). */
function renderTableEl(spec) {
  const table = document.createElement('table');
  if (spec.caption) {
    const cap = document.createElement('caption');
    cap.textContent = spec.caption;
    table.append(cap);
  }
  if (spec.columns.length) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const c of spec.columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      tr.append(th);
    }
    thead.append(tr);
    table.append(thead);
  }
  const tbody = document.createElement('tbody');
  for (const row of spec.rows) {
    const tr = document.createElement('tr');
    row.forEach((cell, i) => {
      const isHeader = spec.rowHeaders && i === 0;
      const el = document.createElement(isHeader ? 'th' : 'td');
      if (isHeader) el.scope = 'row';
      appendCellLines(el, cell);
      tr.append(el);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/** Format a section's run time (epoch ms) for the meta line: compact month/day +
 * time (full date/time is on the element's hover title). Falls back to '' if invalid. */
function formatRunTime(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Append a cell's content; an array renders as stacked lines (e.g. r / p / N). */
function appendCellLines(el, cell) {
  const lines = Array.isArray(cell) ? cell : [cell];
  lines.forEach((line, i) => {
    if (i) el.append(document.createElement('br'));
    el.append(document.createTextNode(fmtCellValue(line)));
  });
}

/** Format a scalar cell value for display (numbers as-is, NA/NaN/null blank). */
function fmtCellValue(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}

/** A small hover-revealed plot-save button. */
function makeSaveBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'results-plot__savebtn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Serialise an `<svg>` element to a standalone SVG string (xmlns guaranteed).
 * @param {SVGElement} svgEl
 * @returns {string}
 */
function serializeSvgEl(svgEl) {
  const clone = svgEl.cloneNode(true);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Rasterise an `<svg>` element to PNG bytes via a canvas. The SVG is
 * self-contained (svglite output, no external refs) so the canvas isn't tainted
 * and `toBlob` works. Drawn at ~`scale`× device pixels on a white background.
 *
 * @param {SVGElement} svgEl
 * @param {number} [scale=2] - Extra crispness multiplier on top of devicePixelRatio.
 * @returns {Promise<Uint8Array>}
 */
function svgElToPngBytes(svgEl, scale = 2) {
  return new Promise((resolve, reject) => {
    const svgStr = serializeSvgEl(svgEl);
    const rect = svgEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const s = Math.max(1, window.devicePixelRatio || 1) * scale;
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * s);
      canvas.height = Math.round(h * s);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(async (b) => {
        if (!b) return reject(new Error('canvas toBlob failed'));
        resolve(new Uint8Array(await b.arrayBuffer()));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG failed to load for rasterisation'));
    };
    img.src = url;
  });
}

/** Download the plot as a vector `.svg` file. */
function savePlotSvg(holder, handle) {
  const svg = holder.querySelector('svg');
  if (svg) downloadFile(`plot-${handle}.svg`, 'image/svg+xml;charset=utf-8', serializeSvgEl(svg));
}

/** Rasterise the plot's SVG to a `.png` and download it. */
function savePlotPng(holder, handle) {
  const svg = holder.querySelector('svg');
  if (!svg) return;
  svgElToPngBytes(svg)
    .then((bytes) => downloadFile(`plot-${handle}.png`, 'image/png', bytes))
    .catch((err) => console.error('[results] PNG export failed', err));
}

/**
 * Convert a tiny subset of Markdown to HTML. Intentionally minimal — enough for
 * analysis notes and captions, with no external dependency. Input is HTML-escaped
 * first, so it is safe for untrusted text.
 *
 * Supported: `# / ## / ###` headings, `**bold**`, `*italic*`, `` `code` ``,
 * blank-line-separated paragraphs.
 *
 * @param {string} md
 * @returns {string} HTML
 */
function renderMiniMarkdown(md) {
  const escape = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (s) =>
    escape(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return md
    .split(/\n{2,}/)
    .map((para) => {
      const heading = para.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${inline(heading[2])}</h${level}>`;
      }
      return `<p>${inline(para).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}
