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
import { renderChart, defaultView, getChartKind } from './chart-renderer.js';
import { buildChartControls } from './chart-controls.js';

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
    font-size: 11px; color: #727272; margin: -8px 0 12px; letter-spacing: .01em;
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
  /* An unmet condition the user can actually DO something about — amber, not red,
     because nothing is broken; something is merely missing. */
  .results-blocked {
    border-left: 3px solid #d68910; background: #fdf8ef;
    padding: 10px 12px; color: #6b4b09; font-size: 13px;
  }
  .results-blocked__msg { margin: 0 0 8px; white-space: pre-wrap; }
  .results-blocked__btn {
    font: inherit; font-size: 12px; padding: 4px 10px;
    background: #fff; border: 1px solid #b9770e; color: #8a5a0b;
    border-radius: 6px; cursor: pointer;
  }
  .results-blocked__btn:hover { background: #fdf1dd; }
  .results-blocked__btn[disabled] { opacity: .6; cursor: default; }
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
    background: #fff; border: 1px solid var(--accent, #2572a5);
    color: var(--accent, #2572a5); border-radius: 6px; cursor: pointer;
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
    background: #fff; border: 1px solid var(--accent, #2572a5);
    color: var(--accent, #2572a5); border-radius: 6px; cursor: pointer;
  }
  /* Layer-1 universal frame: a host-owned editable title above, caption below, any
     chart body (svglite plot OR model chart). Title/caption are host text, never
     baked into the SVG, so they're renameable + persisted. */
  .results-plot-wrap { max-width: 672px; }
  .results-plot__title {
    font: inherit; font-size: 15px; font-weight: 600; color: #222;
    margin: 0 0 6px; padding: 2px 4px; border-radius: 4px; outline: none; cursor: text;
  }
  .results-plot__caption {
    font: inherit; font-size: 12.5px; font-style: italic; color: #667;
    margin: 6px 0 0; padding: 2px 4px; border-radius: 4px; outline: none; cursor: text;
  }
  .results-plot__title:hover, .results-plot__caption:hover { background: #f2f4f7; }
  .results-plot__title:focus, .results-plot__caption:focus {
    background: #eef3f8; box-shadow: 0 0 0 1px var(--accent, #2572a5);
  }
  .results-plot__title:empty, .results-plot__caption:empty { min-height: 1em; }
  /* Empty title/caption is invisible until you hover the block (or focus it), so a
     titleless plot isn't cluttered with placeholder text. */
  .results-plot__title:empty:before, .results-plot__caption:empty:before { content: ''; }
  .results-plot-wrap:hover .results-plot__title:empty:before,
  .results-plot-wrap:hover .results-plot__caption:empty:before,
  .results-plot__title:focus:empty:before, .results-plot__caption:focus:empty:before {
    content: attr(data-placeholder); color: #b0b7bf; font-weight: 400; font-style: italic;
  }
  .results-empty { color: #727272; font-style: italic; }
  /* Data-driven charts (appendChart): a responsive SVG with an options panel and
     save buttons below it (auto height, so the controls aren't clipped like the
     fixed-box .results-plot). */
  /* The chart's bordered box IS the resizable element (drag the lower-right grip),
     so resizing grows the box itself instead of overflowing a fixed outer frame.
     The wrapper is borderless and just stacks the box + controls + save beneath it.
     A fixed default height (not aspect-ratio, which older iPad Safari lacks) keeps
     the chart visible everywhere; the viewBox keeps it undistorted as it scales;
     max-width:100% stops a drag from spilling past the pane (no scrollbar). */
  .results-chart { position: relative; box-sizing: border-box; max-width: 100%; }
  .results-chart .results-plot__svg {
    width: min(100%, 672px); height: 420px; max-width: 100%; max-height: 78vh;
    resize: both; overflow: hidden; box-sizing: border-box;
    border: 1px solid #e3e7eb; border-radius: 6px; background: #fff;
  }
  .results-chart .results-plot__svg svg { width: 100%; height: 100%; display: block; max-width: none; }
  .results-chart .results-plot__save { position: static; opacity: 1; margin-top: 6px; }
  /* A static chart is a real result, not an error — so this reads as a quiet note, not
     a warning. #646e77 on #fff measures 5.20:1, past WCAG 1.4.3's 4.5:1 at this size.
     The left rule is decorative (1.56:1, same as the chart gridlines): it groups the
     note with the figure, and carries no meaning that the text does not already say. */
  .results-chart__static-note {
    margin: 6px 0 0; padding: 4px 0 4px 9px; border-left: 3px solid #c8d0d9;
    font-size: 12px; line-height: 1.45; color: #646e77; max-width: 672px;
  }
  .results-chart__opts-toggle {
    font: inherit; font-size: 12px; padding: 3px 9px; margin-top: 6px;
    background: #f5f7f9; border: 1px solid #d8dee4; color: #333; border-radius: 6px; cursor: pointer;
  }
  .results-chart__opts-toggle.is-open { background: #eef5fb; border-color: var(--accent,#2572a5); color: var(--accent,#2572a5); }
  .results-chart__opts {
    margin-top: 8px; padding: 10px; border: 1px solid #e3e7eb; border-radius: 6px;
    background: #fafbfc; display: flex; flex-direction: column; gap: 8px; max-width: 380px;
  }
  /* An author display rule beats the UA [hidden]{display:none}; restore it so the
     toggle actually shows/hides the panel (it defaults hidden). */
  .results-chart__opts[hidden] { display: none; }
  .results-chart__row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .results-chart__row--check { gap: 6px; cursor: pointer; }
  .results-chart__rowlabel { color: #555; min-width: 72px; }
  .results-chart__select { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid #d8dee4; border-radius: 5px; background: #fff; flex: 1; }
  .results-chart__num { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid #d8dee4; border-radius: 5px; background: #fff; width: 90px; }
  .results-chart__text { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid #d8dee4; border-radius: 5px; background: #fff; flex: 1; min-width: 0; }
  .results-chart__seriesheader { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #646e77; margin-top: 4px; }
  /* Collapsible control sections. Only the first is open — see chart-controls.js on
     why a flat list stopped being viable. */
  .results-chart__group { border: 1px solid #e6eaee; border-radius: 6px; background: #fff; }
  .results-chart__group[open] { padding-bottom: 8px; }
  .results-chart__group > *:not(summary) { margin: 6px 10px 0; }
  .results-chart__grouphead {
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #58616a;
    padding: 7px 10px; cursor: pointer; user-select: none; list-style: none; font-weight: 600;
  }
  .results-chart__grouphead::-webkit-details-marker { display: none; }
  .results-chart__grouphead::before { content: '▸ '; color: #98a2ac; }
  .results-chart__group[open] > .results-chart__grouphead::before { content: '▾ '; }
  .results-chart__grouphead:hover { color: #1b7fc4; }
  .results-chart__series { display: flex; flex-direction: column; gap: 4px; }
  .results-chart__srow { display: flex; align-items: center; gap: 6px; }
  .results-chart__swatch { width: 28px; height: 22px; padding: 0; border: 1px solid #d8dee4; border-radius: 4px; background: none; cursor: pointer; flex: 0 0 auto; }
  .results-chart__sname { flex: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .results-chart__ord {
    font: inherit; font-size: 12px; width: 24px; height: 22px; line-height: 1; flex: 0 0 auto;
    background: #fff; border: 1px solid #d8dee4; border-radius: 4px; cursor: pointer; color: #555;
  }
  .results-chart__ord:disabled { opacity: .35; cursor: default; }
  .results-chart__reset {
    align-self: flex-start; font: inherit; font-size: 12px; padding: 3px 8px;
    background: #fff; border: 1px solid #d8dee4; border-radius: 5px; cursor: pointer; color: #555;
  }
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

  /** Host hook called once a run's id is known: `(sectionEl, runId) => void` (#152).
   * The pane stays ignorant of memos — it just says "this DOM section is that run". */
  #decorateRun = null;

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
    const item = {
      kind: 'plot',
      svg: sanitizeHtml(svgString),
      id: 0,
      // Layer-1 frame: host-owned title/caption (plain text), NOT baked into the SVG,
      // so they're renameable and persist across save/reload.
      title: typeof opts.title === 'string' ? opts.title : '',
      caption: typeof opts.caption === 'string' ? opts.caption : '',
    };
    const block = this.#buildPlotBlock(item, { onRedraw: opts.onRedraw });
    // Place BEFORE recording: #place is what lazily creates the analysis section, and
    // that pushes its own `section` entry. Pushing the plot first put it AHEAD of its
    // own heading in the model — invisible on screen (the DOM nests correctly) but
    // wrong everywhere the model is the source of truth: exported reports and reopened
    // projects showed the figure above the analysis it belongs to.
    this.#place(block);
    this.#model.push(item);
    this.#bus?.emit?.('output:written');
    return item.id;
  }

  /** Build the DOM block for a `plot` item: the universal Layer-1 frame (editable
   * title above, caption below) wrapping the fixed resizable SVG box (with the
   * redraw + SVG/PNG controls). Registers the holder for PNG export and stamps
   * `item.id`. Shared by {@link ResultsPane#appendPlot} and {@link ResultsPane#restoreModel}. */
  #buildPlotBlock(item, { onRedraw } = {}) {
    const block = this.#makeBlock();
    const wrap = document.createElement('div');
    wrap.className = 'results-plot-wrap';
    block.append(wrap);

    wrap.append(
      makeEditable(item.title || '', 'Add a title…', 'results-plot__title', (t) => {
        item.title = t;
        this.#bus?.emit?.('output:written');
      }),
    );

    // Resizable box: a lower-right grip scales the plot (vector → crisp).
    const box = document.createElement('div');
    box.className = 'results-plot';
    const holder = document.createElement('div');
    holder.className = 'results-plot__svg';
    holder.innerHTML = sanitizeHtml(item.svg || '');
    box.append(holder);

    const handle = this.#nextPlotId++;
    item.id = handle;
    this.#plots.set(handle, holder);

    // If the plot knows how to redraw itself (a plugin callback), offer a button that
    // re-runs it at the box's current dimensions — the only way to change the aspect
    // ratio without distorting (drag alone just scales).
    if (typeof onRedraw === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'results-plot__redraw';
      btn.textContent = '⟳ Redraw at this size';
      btn.title = 'Re-render at the current box size — re-lays-out at the new ratio';
      btn.addEventListener('click', () => onRedraw(Math.max(1, holder.clientWidth), Math.max(1, holder.clientHeight)));
      box.append(btn);
    }

    // "Save this plot": SVG direct (already SVG); PNG rasterised via canvas.
    const save = document.createElement('div');
    save.className = 'results-plot__save';
    save.append(
      makeSaveBtn('⬇ SVG', () => savePlotSvg(holder, handle)),
      makeSaveBtn('⬇ PNG', () => savePlotPng(holder, handle)),
    );
    box.append(save);
    wrap.append(box);

    wrap.append(
      makeEditable(item.caption || '', 'Add a caption…', 'results-plot__caption', (c) => {
        item.caption = c;
        this.#bus?.emit?.('output:written');
      }),
    );
    return block;
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
   * Append a raster image supplied as a `data:image/…` URL — e.g. an R plot captured
   * as a bitmap by "Run R script" (#137), where plots come back rasterised, not as
   * SVG. Persisted in the model as the data URL, so it survives save/reload and flows
   * into exports. Only inline `data:image/` URLs are accepted (no remote/script srcs).
   *
   * @param {string} src - A `data:image/...;base64,…` URL.
   * @param {{alt?: string}} [opts]
   */
  appendImage(src, opts = {}) {
    const safe = String(src || '');
    if (!/^data:image\//.test(safe)) return;
    const block = this.#makeBlock();
    block.classList.add('results-plot');
    const img = document.createElement('img');
    img.src = safe;
    img.alt = opts.alt || 'R plot';
    img.style.cssText = 'max-width:100%; height:auto; display:block;';
    block.append(img);
    this.#model.push({ kind: 'image', src: safe, alt: img.alt });
    this.#place(block);
    this.#bus?.emit?.('output:written');
  }

  /**
   * Append a **data-driven chart** (`app.results.appendChart`). Unlike
   * {@link ResultsPane#appendPlot} — which takes a finished SVG baked in R — the
   * plugin hands a structured {@link ChartModel} (categories + series + values), and
   * the host renders it to SVG in JS via {@link renderChart}. That's what lets the
   * chart's interactive controls (order, colour, stacking, legend) re-render it
   * instantly with no WebR round-trip. The model + view are persisted, so a reopened
   * chart stays editable.
   *
   * @param {import('./chart-renderer.js').ChartModel} model
   * @returns {number} a plot handle (usable with {@link ResultsPane#getPlotPng}).
   */
  appendChart(model) {
    const safeModel = JSON.parse(JSON.stringify(model)); // detach from the plugin's object
    const item = {
      kind: 'chart',
      model: safeModel,
      view: defaultView(safeModel),
      id: 0,
      svg: '',
      // Who supplies this kind, recorded NOW because the registry is the only place
      // that knows and it will not be able to answer on restore — a chart is reopened
      // precisely when its kind may be missing. Undefined for kinds that ship in core.
      kindProvider: getChartKind(safeModel.kind)?.provider,
    };
    const block = this.#buildChartBlock(item);
    this.#place(block); // before the push — see appendPlot on why the order matters
    this.#model.push(item);
    this.#bus?.emit?.('output:written');
    return item.id;
  }

  /** Build the DOM block for a chart item: the SVG holder (re-rendered live from the
   * model+view), the interactive controls, and the SVG/PNG save buttons. Registers
   * the holder for PNG export and stamps `item.id`/`item.svg`. Shared by
   * {@link ResultsPane#appendChart} and {@link ResultsPane#restoreModel}. */
  #buildChartBlock(item) {
    // A saved chart whose kind is no longer registered still has its last-rendered SVG
    // in the project file. Show that rather than re-rendering, which would only produce
    // "Unsupported chart kind" and throw away a figure we are holding in our hand.
    // Only on RESTORE (`item.svg` already populated) — a live append of an unknown kind
    // is a plugin bug and keeps the diagnostic.
    if (chartNeedsStaticFallback(item, getChartKind)) {
      return this.#buildStaticChartBlock(item);
    }
    const block = this.#makeBlock();
    block.classList.add('results-chart');
    const holder = document.createElement('div');
    holder.className = 'results-plot__svg';
    block.append(holder);

    const handle = this.#nextPlotId++;
    item.id = handle;
    this.#plots.set(handle, holder);

    const rerender = () => {
      // renderChart output is host-generated, but model text can come from an
      // untrusted project on restore — sanitise like every other fragment.
      item.svg = sanitizeHtml(renderChart(item.model, item.view));
      holder.innerHTML = item.svg;
    };
    rerender();

    block.append(buildChartControls(item, rerender));

    const save = document.createElement('div');
    save.className = 'results-plot__save';
    save.append(
      makeSaveBtn('⬇ SVG', () => savePlotSvg(holder, handle)),
      makeSaveBtn('⬇ PNG', () => savePlotPng(holder, handle)),
    );
    block.append(save);
    return block;
  }

  /**
   * Build a **static** chart block: the figure as saved, with no controls.
   *
   * The case this exists for is a project reopened where the chart's kind is not
   * registered — a kind supplied by a plugin that is switched off, or a project written
   * by a newer CrossTab. Before this, `restoreModel` re-rendered unconditionally and an
   * unknown kind produced "Unsupported chart kind", **discarding a perfectly good SVG
   * that was sitting in the same save file**. Output has to outlive whatever drew it:
   * that is already true of `appendPlot` figures, and there was no reason for charts to
   * be the exception.
   *
   * Deliberately keeps the SVG/PNG buttons and the `#plots` registration, so the figure
   * still exports (the DOCX exporter rasterises via `getPlotPng`) and still prints. The
   * only thing lost is editing, which is exactly what the notice says.
   *
   * **This is the finished state, not a fallback to be engineered away.** Editability
   * is a plugin capability, not a property of the output: a chart is editable when the
   * plugin owning its kind is installed, exactly as a Frequencies table is re-derivable
   * only when builtin-frequencies is activated. The output stays visible, quotable and
   * exportable either way; making a *new* one with different settings is what needs the
   * plugin. A design was floated to persist kind definitions inside the project so
   * charts would stay editable regardless — rejected, because it would make charts
   * uniquely more durable than every other plugin output in the app. See
   * {@link ResultsPane#appendNotice} (#156), which is the same move for the same reason.
   */
  #buildStaticChartBlock(item) {
    const block = this.#makeBlock();
    block.classList.add('results-chart', 'results-chart--static');

    const holder = document.createElement('div');
    holder.className = 'results-plot__svg';
    // Saved SVG comes from an untrusted project file — same sanitising as appendPlot.
    holder.innerHTML = sanitizeHtml(item.svg || '');
    block.append(holder);

    const handle = this.#nextPlotId++;
    item.id = handle;
    this.#plots.set(handle, holder);

    const note = document.createElement('p');
    note.className = 'results-chart__static-note';
    note.textContent = staticChartNotice(item);
    block.append(note);

    const save = document.createElement('div');
    save.className = 'results-plot__save';
    save.append(
      makeSaveBtn('⬇ SVG', () => savePlotSvg(holder, handle)),
      makeSaveBtn('⬇ PNG', () => savePlotPng(holder, handle)),
    );
    block.append(save);
    return block;
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

  /**
   * Append a block for something the user can FIX, with a button that fixes it.
   *
   * Distinct from {@link ResultsPane#appendError} because the two say different things.
   * An error is a report: this run failed, here is why. This is an offer: this run has
   * not happened yet, here is the one thing standing in the way, press here. The case
   * that motivated it (#156) is a co-author's analysis arriving for a plugin this peer
   * has not activated — a dead-end red message would have been a poor answer to "why is
   * there a step in my History with nothing under it".
   *
   * The button is live DOM only. On restore the model rebuilds as plain text, exactly as
   * a restored plot loses its `onRedraw` — the callback belonged to a session that has
   * ended, and a button that silently does nothing is worse than no button.
   *
   * @param {string} message      plain text (not HTML — this is never a formatting hook)
   * @param {object} [action]
   * @param {string} [action.label]     button text; omitted ⇒ no button
   * @param {() => any} [action.onClick] runs on click; the button disables while it runs
   * @param {string} [action.runId]     the analysis this notice stands in for, so
   *   {@link ResultsPane#removeRun} takes it down when the run finally happens. Passed
   *   directly rather than via `assignRun`, which also stamps the last SECTION — and a
   *   notice opens no section of its own, so that would have re-labelled someone else's.
   */
  appendNotice(message, { label, onClick, runId } = {}) {
    const block = this.#makeBlock();
    block.className = 'results-block results-blocked';
    const p = document.createElement('p');
    p.className = 'results-blocked__msg';
    p.textContent = String(message ?? '');
    block.append(p);
    if (label && typeof onClick === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'results-blocked__btn';
      btn.textContent = label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await onClick(); } finally { btn.disabled = false; }
      });
      block.append(btn);
    }
    this.#place(block);
    // Persisted as text: the words survive a save, the button does not. Escaped via the
    // DOM node we just built rather than a hand-rolled escaper.
    this.#model.push({ kind: 'text', html: p.outerHTML, notice: true, ...(runId ? { runId } : {}) });
    this.#bus?.emit?.('output:written');
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
  restoreModel(model, { divider = true } = {}) {
    this.clear(); // wipes DOM + model; shows empty state if nothing to restore
    if (!Array.isArray(model) || model.length === 0) return;
    this.#clearEmptyState();
    this.#currentSection = null;
    this.#pendingSection = null;
    for (const item of model) {
      if (!item || !item.kind) continue;
      const runMark = this.#model.length; // preserve runId ownership across the rebuild (unit 5b)
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
        // Rebuild through the shared frame so a restored plot keeps its editable
        // title/caption (Layer 1). No onRedraw on restore — the plugin callback is gone.
        const restored = {
          kind: 'plot',
          svg: sanitizeHtml(item.svg || ''),
          id: 0,
          title: typeof item.title === 'string' ? item.title : '',
          caption: typeof item.caption === 'string' ? item.caption : '',
        };
        const block = this.#buildPlotBlock(restored);
        this.#place(block);
        this.#model.push(restored);
      } else if (item.kind === 'image') {
        const safe = String(item.src || '');
        if (!/^data:image\//.test(safe)) continue; // reject non-inline srcs from an untrusted save
        const block = this.#makeBlock();
        block.classList.add('results-plot');
        const img = document.createElement('img');
        img.src = safe;
        img.alt = item.alt || 'R plot';
        img.style.cssText = 'max-width:100%; height:auto; display:block;';
        block.append(img);
        this.#place(block);
        this.#model.push({ kind: 'image', src: safe, alt: img.alt });
      } else if (item.kind === 'chart' && ((item.model && item.model.kind) || item.svg)) {
        // Re-render from the saved model+view so the chart stays fully editable
        // (not a frozen image). Fill any view fields a stale save might lack.
        //
        // The saved `svg` is carried through rather than blanked. For a live chart the
        // first render overwrites it immediately, so nothing changes; for a chart whose
        // kind is missing it is the whole figure, and blanking it here was how a
        // reopened project used to lose the picture it had faithfully saved.
        const restored = {
          kind: 'chart',
          model: item.model || null,
          view: item.model ? { ...defaultView(item.model), ...(item.view || {}) } : {},
          id: 0,
          svg: sanitizeHtml(item.svg || ''),
          kindProvider: typeof item.kindProvider === 'string' ? item.kindProvider : undefined,
        };
        const block = this.#buildChartBlock(restored);
        this.#place(block);
        this.#model.push(restored);
      } else if (item.kind === 'error') {
        const block = this.#makeBlock();
        block.className = 'results-block results-error';
        block.textContent = item.message || '';
        this.#place(block);
        this.#model.push({ kind: 'error', message: item.message || '' });
      }
      // Re-stamp the block(s) this item produced with its analysis runId, so by-id
      // removal keeps working after any rebuild (save/reload, a sibling's removeRun).
      if (item.runId) for (let j = runMark; j < this.#model.length; j++) this.#model[j].runId = item.runId;
    }
    // A divider at the BOTTOM of the restored output: everything above it is from
    // the last save; results you run this session append below it, so live work is
    // always distinguishable from the restored snapshot. It persists until the next
    // save+reload — which restores everything above a fresh divider (the line moves
    // down past it).
    if (divider) {
      const div = document.createElement('div');
      div.dataset.restoreDivider = 'true';
      div.textContent = '↑ above: restored from your last save · new results appear below';
      div.style.cssText =
        'text-align:center;font-size:12px;color:#646e77;font-style:italic;margin:16px 12px 4px;padding-top:10px;border-top:1px dashed #c8d0d8;';
      this.#content.append(div);
    }
    // Re-attach run identity to the rebuilt DOM (#152). Sections are recreated from the
    // model, so dataset.runId and any host-injected control are lost on every restore —
    // which would silently strip the memo button from all reopened output. Section
    // elements appear in the same order as their model entries, so they pair up.
    const sections = [...this.#content.querySelectorAll('.results-section')];
    let si = 0;
    for (const b of this.#model) {
      if (b.kind !== 'section') continue;
      const elx = sections[si++];
      if (!elx || !b.runId) continue;
      elx.dataset.runId = b.runId;
      try { this.#decorateRun?.(elx, b.runId); } catch { /* keep restoring */ }
    }
  }

  /** Drop output blocks from index `n` onward and re-render — used by undo to remove
   * a just-run analysis's output (no "restored" divider). Legacy fallback for entries
   * with no `runId`; prefer {@link ResultsPane#removeRun}. */
  truncateTo(n) {
    if (!Number.isFinite(n) || n < 0) return;
    if (n >= this.#model.length) return;
    this.restoreModel(this.#model.slice(0, n), { divider: false });
  }

  /** Tag every output block from `fromIndex` to the end with the analysis `runId` that
   * produced it — so its output can later be removed by IDENTITY (undo / history-delete)
   * instead of by fragile position (see docs/ARCHITECTURE-unified-log.md, unit 5b). Only
   * stamps blocks that aren't already owned, so it never steals an earlier run's output. */
  assignRun(fromIndex, runId) {
    if (!runId || !Number.isFinite(fromIndex)) return;
    for (let i = Math.max(0, fromIndex); i < this.#model.length; i++) {
      if (this.#model[i].runId == null) this.#model[i].runId = runId;
    }
    // The run's identity only exists NOW — the section was built before the analysis
    // finished. This is the first moment anything can be anchored to it (#152).
    const section = this.#lastAnchor;
    if (section && section.classList?.contains('results-section')) {
      section.dataset.runId = runId;
      try { this.#decorateRun?.(section, runId); } catch (e) { console.warn('[results] decorate failed', e); }
    }
  }

  /** Register the run-section decorator (see {@link ResultsPane##decorateRun}). */
  onRunSection(fn) {
    this.#decorateRun = typeof fn === 'function' ? fn : null;
    return this;
  }

  /** Re-run the decorator over every section already on screen — needed after a
   * restore, which rebuilds the DOM from the model and loses the injected controls. */
  redecorateRuns() {
    if (!this.#decorateRun) return;
    for (const section of this.#content.querySelectorAll('.results-section')) {
      const runId = section.dataset.runId;
      if (runId) {
        try { this.#decorateRun(section, runId); } catch { /* keep going */ }
      }
    }
  }

  /** Remove exactly the output blocks produced by analysis `runId` and re-render (no
   * "restored" divider). Precise by-id removal: a MIDDLE analysis's output goes without
   * disturbing later analyses' output — the thing positional `truncateTo` can't do. */
  removeRun(runId) {
    if (!runId) return;
    const kept = this.#model.filter((b) => b.runId !== runId);
    if (kept.length !== this.#model.length) this.restoreModel(kept, { divider: false });
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
   *   appendChart: (model: object) => number,
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
      appendImage: (s, opts) => this.appendImage(s, opts),
      appendChart: (model) => this.appendChart(model),
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
/**
 * Should this chart item be shown as a frozen figure rather than re-rendered?
 *
 * Yes exactly when we HAVE a saved picture and CANNOT redraw it. Both halves matter:
 *
 *  - Without a saved SVG there is nothing to fall back to, so an unknown kind should
 *    still produce the "Unsupported chart kind" diagnostic — that is a live append
 *    from a buggy plugin, not a reopened project, and hiding it would hide the bug.
 *  - With a registered kind we always re-render, because a live chart is strictly
 *    better than a frozen one and the saved SVG may be from an older renderer.
 *
 * Pure, and takes the registry lookup as an argument, so the rule can be tested
 * without a DOM (this repo has no DOM test shim and takes no dependencies).
 *
 * @param {{svg?:string, model?:{kind?:string}|null}} item
 * @param {(kind:string)=>object|undefined} lookupKind
 */
export function chartNeedsStaticFallback(item, lookupKind) {
  if (!item || !item.svg) return false;
  return !(item.model && item.model.kind && lookupKind(item.model.kind));
}

/**
 * The one line a static chart shows in place of its controls.
 *
 * Names the plugin when the chart recorded one, because "activate something" is not an
 * instruction. When it did not — a core kind this build no longer has, or a project
 * from a newer CrossTab — naming the missing kind is the most actionable thing left.
 */
export function staticChartNotice(item) {
  if (item.kindProvider) {
    return `Showing the saved figure. Activate ${item.kindProvider} to edit this chart.`;
  }
  if (item.model && item.model.kind) {
    return `Showing the saved figure — “${item.model.kind}” charts aren’t available in this version, so the options are switched off.`;
  }
  return 'Showing the saved figure — this chart’s data wasn’t saved with it, so it can’t be edited.';
}

function makeSaveBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'results-plot__savebtn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** An inline-editable single-line text element (host-owned chart title/caption, the
 * Layer-1 frame). Shows `placeholder` (dimmed, on hover/focus) when empty; commits the
 * trimmed text via `onCommit` on blur or Enter, reverts on Escape. Plain text only —
 * never HTML — so it can't inject into the results DOM. */
function makeEditable(text, placeholder, className, onCommit) {
  const el = document.createElement('div');
  el.className = className;
  el.contentEditable = 'plaintext-only';
  el.spellcheck = false;
  el.setAttribute('role', 'textbox');
  el.setAttribute('aria-label', placeholder);
  el.dataset.placeholder = placeholder;
  el.textContent = text || '';
  let last = el.textContent;
  const commit = () => {
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t !== el.textContent) el.textContent = t;
    if (t !== last) { last = t; onCommit(t); }
  };
  el.addEventListener('blur', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); el.textContent = last; el.blur(); }
  });
  return el;
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
