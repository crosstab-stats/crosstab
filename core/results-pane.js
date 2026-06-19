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

  /** Plot handle → its SVG holder element, for {@link ResultsPane#updatePlot}. */
  #plots = new Map();

  /** Next plot handle id. */
  #nextPlotId = 1;

  /**
   * @param {HTMLElement} host - The element to attach the shadow root to.
   */
  constructor(host) {
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
    const section = document.createElement('section');
    section.className = 'results-section';

    const heading = document.createElement('h2');
    heading.className = 'results-section__title';
    heading.textContent = title;

    section.append(heading);
    this.#content.append(section);
    this.#currentSection = section;
  }

  /**
   * Append a pre-rendered HTML table (or any HTML fragment). Wrapped in a
   * horizontally scrollable block so wide tables behave on narrow iPad screens.
   *
   * @param {string} htmlString - Untrusted HTML; sanitised before insertion.
   */
  appendTable(htmlString) {
    const block = this.#makeBlock();
    block.innerHTML = sanitizeHtml(htmlString);
    this.#place(block);
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
    if (holder) holder.innerHTML = sanitizeHtml(svgString);
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
    block.innerHTML = renderMiniMarkdown(markdown);
    this.#place(block);
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
  }

  /** Remove all output and reset to the empty state. */
  clear() {
    this.#content.replaceChildren();
    this.#currentSection = null;
    this.#plots.clear();
    this.#renderEmptyState();
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
      appendTable: (h) => this.appendTable(h),
      appendPlot: (s, opts) => this.appendPlot(s, opts),
      updatePlot: (handle, s) => this.updatePlot(handle, s),
      appendText: (m) => this.appendText(m),
      appendError: (m) => this.appendError(m),
      clear: () => this.clear(),
    });
  }

  // --- internals -------------------------------------------------------------

  #makeBlock() {
    const block = document.createElement('div');
    block.className = 'results-block';
    return block;
  }

  /** Place a block into the current section, or at top level if none. */
  #place(block) {
    this.#clearEmptyState();
    (this.#currentSection ?? this.#content).append(block);
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
 * Exported so the output-export module can reuse it for the report/docx paths.
 * @param {SVGElement} svgEl
 * @returns {string}
 */
export function serializeSvgEl(svgEl) {
  const clone = svgEl.cloneNode(true);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Rasterise an `<svg>` element to PNG bytes via a canvas. The SVG is
 * self-contained (svglite output, no external refs) so the canvas isn't tainted
 * and `toBlob` works. Drawn at ~`scale`× device pixels on a white background.
 * Exported for reuse by the docx exporter (which needs raster, not SVG).
 *
 * @param {SVGElement} svgEl
 * @param {number} [scale=2] - Extra crispness multiplier on top of devicePixelRatio.
 * @returns {Promise<Uint8Array>}
 */
export function svgElToPngBytes(svgEl, scale = 2) {
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
