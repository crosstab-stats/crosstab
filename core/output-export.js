/**
 * @file output-export.js
 * Export the **Output pane** (analysis results) as a shareable artifact — the
 * write-up half of export, distinct from *data* export (`app.exporters`).
 *
 * The results live in an *open* shadow root as append-only DOM (sections,
 * tables, inline-SVG plots, notes — see {@link results-pane.js}). There is no
 * separate result model, so the faithful, WYSIWYG approach is to **clone that
 * live markup** and reuse the pane's own stylesheet. Both targets fall out of
 * one renderer:
 *   - **HTML** — write the cloned report to a self-contained `.html` file.
 *   - **PDF** — render the same report into a hidden same-origin iframe and
 *     `print()` it; the user picks "Save as PDF". Zero-dependency, native, and
 *     works on iPad Safari (Save to Files). Printing from a normal-DOM iframe
 *     also sidesteps the shadow-DOM-in-print wrinkle.
 *
 * Host-owned (a sandboxed plugin can't read the results DOM or trigger a
 * download/print), surfaced as **File ▸ Export output…**.
 */

import { downloadFile } from './export-service.js';
import { serializeSvgEl, svgElToPngBytes } from './results-pane.js';

/** OOXML Word MIME type. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class OutputExport {
  /** The results-pane host element (carries the open shadow root). */
  #host;
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** @type {import('./project-sync.js').ProjectSync} */
  #projects;
  /** ResultsPane#api, for surfacing errors/notes. @type {{appendError: Function, appendText: Function}} */
  #results;
  /** @type {import('./webr-manager.js').WebRManager} */
  #webr;
  /** Set once the officer/flextable chain is installed this session. */
  #docxReady = false;

  /**
   * @param {Object} deps
   * @param {HTMLElement} deps.resultsHost - The element hosting the results shadow root.
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./project-sync.js').ProjectSync} deps.projects
   * @param {{appendError: Function, appendText: Function}} deps.results - ResultsPane#api.
   * @param {import('./webr-manager.js').WebRManager} deps.webr - For the docx (officer) path.
   */
  constructor({ resultsHost, menus, projects, results, webr }) {
    this.#host = resultsHost;
    this.#menus = menus;
    this.#projects = projects;
    this.#results = results;
    this.#webr = webr;
  }

  activate() {
    this.#menus.register({
      id: 'core:export-output',
      path: ['File'],
      label: 'Export output…',
      order: 10,
      command: () => this.#open(),
    });
  }

  // --- output inspection -----------------------------------------------------

  /** The `.results-root` element inside the open shadow root, or null. */
  #resultsRoot() {
    return this.#host?.shadowRoot?.querySelector('.results-root') ?? null;
  }

  /** Whether there's any real output (not just the empty-state placeholder). */
  #hasOutput() {
    const root = this.#resultsRoot();
    if (!root) return false;
    if (root.querySelector('[data-empty-state]') && root.childElementCount <= 1) return false;
    return root.childElementCount > 0;
  }

  #open() {
    if (!this.#hasOutput()) {
      this.#results.appendError('Export output: there is no output yet. Run an analysis first.');
      return;
    }
    this.#showDialog();
  }

  #defaultTitle() {
    return this.#projects?.activeName ?? 'CrossTab Output';
  }

  // --- report building -------------------------------------------------------

  /** Build a self-contained report HTML document string from the live output. */
  #buildReport(title) {
    const root = this.#resultsRoot();
    const clone = root.cloneNode(true);
    // Strip interactive-only affordances that don't belong in a static report.
    for (const b of clone.querySelectorAll('.results-plot__redraw, .results-plot__save, button')) {
      b.remove();
    }
    // Drop the resize grip on plot boxes (keep their size).
    for (const p of clone.querySelectorAll('.results-plot')) p.style.resize = 'none';

    const paneStyles = this.#host?.shadowRoot?.querySelector('style')?.textContent ?? '';
    const safeTitle = escapeHtml(title || 'CrossTab Output');
    const when = new Date().toLocaleString();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
${paneStyles}
:root { color-scheme: light; }
body { margin: 0; background: #fff; }
.report-header {
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 24px 16px 0; color: #1a1a1a;
}
.report-header h1 { margin: 0 0 2px; font-size: 22px; }
.report-header .report-meta { color: #666; font-size: 12px; }
.report-header hr { border: 0; border-top: 1px solid #ccc; margin: 14px 0 0; }
@media print {
  .results-plot, table, .results-block { break-inside: avoid; }
  .results-section { break-inside: avoid-page; }
  @page { margin: 18mm 14mm; }
}
</style>
</head>
<body>
<header class="report-header">
  <h1>${safeTitle}</h1>
  <div class="report-meta">Generated by CrossTab · ${escapeHtml(when)}</div>
  <hr>
</header>
${clone.outerHTML}
</body>
</html>`;
  }

  // --- targets ---------------------------------------------------------------

  #exportHtml(title) {
    try {
      const html = this.#buildReport(title);
      downloadFile(filenameFor(title, 'html'), 'text/html;charset=utf-8', html);
    } catch (err) {
      console.error('[output-export] HTML failed', err);
      this.#results.appendError(`Export to HTML failed: ${err.message}`);
    }
  }

  /** Render the report into a hidden same-origin iframe and print it. The user
   * chooses "Save as PDF" in the print dialog. */
  #exportPdf(title) {
    let html;
    try {
      html = this.#buildReport(title);
    } catch (err) {
      console.error('[output-export] PDF build failed', err);
      this.#results.appendError(`Export to PDF failed: ${err.message}`);
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    document.body.append(iframe);
    const cleanup = () => setTimeout(() => iframe.remove(), 1000);
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      // Print once laid out (tables + inline SVG are synchronous, so a frame is enough).
      win.requestAnimationFrame(() => {
        try {
          win.focus();
          win.print();
        } catch (err) {
          console.error('[output-export] print failed', err);
          this.#results.appendError(`Print failed: ${err.message}`);
        }
        cleanup();
      });
    });
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
  }

  // --- docx (officer/flextable in WebR) --------------------------------------

  /** Install the officer/flextable chain once per session (idempotent guard). */
  async #ensureDocx() {
    if (this.#docxReady) return;
    this.#results.appendText?.('Preparing Word export — installing document components (first time only)…');
    await this.#webr.installPackages(['officer', 'flextable']);
    this.#docxReady = true;
  }

  /**
   * Build a true, editable `.docx` via officer + flextable in WebR. Our output is
   * HTML, not R objects, so we walk the live Output pane into a small structured
   * model (headings, table grids, plot PNGs, paragraphs), stage the plot images
   * into WebR's FS, then generate R that assembles the document. Word renders SVG
   * unreliably, so plots go in as PNG (the same canvas rasteriser the per-plot
   * "Save PNG" uses).
   */
  async #exportDocx(title) {
    try {
      // Build the model first (only needs the runtime for writeFile), so the
      // "installing…" note appended by #ensureDocx isn't captured into the doc.
      const model = await this.#buildDocxModel(title);
      await this.#ensureDocx();
      const out = '/tmp/ct_report.docx';
      const code = modelToR(model, out);
      const r = await this.#webr.run(code);
      if (r.stderr && /error/i.test(r.stderr)) throw new Error(firstLine(r.stderr));
      const bytes = await this.#webr.readFile(out);
      if (!bytes || bytes.length < 4) throw new Error('the document came back empty');
      downloadFile(filenameFor(title, 'docx'), DOCX_MIME, bytes);
    } catch (err) {
      console.error('[output-export] docx failed', err);
      this.#results.appendError(`Export to Word failed: ${err.message}`);
    }
  }

  /**
   * Walk the live `.results-root` into a flat content model and stage any plot
   * PNGs into WebR's FS. Returns the model (with image file paths).
   * @returns {Promise<Array<object>>}
   */
  async #buildDocxModel(title) {
    const root = this.#resultsRoot();
    const model = [{ t: 'title', text: title || 'CrossTab Output' }];
    model.push({ t: 'text', text: `Generated by CrossTab · ${new Date().toLocaleString()}` });
    let imgN = 0;
    for (const node of root.children) {
      if (node.classList.contains('results-section')) {
        const h = node.querySelector('.results-section__title');
        if (h) model.push({ t: 'heading', text: h.textContent });
        for (const block of node.querySelectorAll(':scope > .results-block')) {
          imgN = await this.#pushBlock(block, model, imgN);
        }
      } else if (node.classList.contains('results-block')) {
        imgN = await this.#pushBlock(node, model, imgN);
      }
    }
    return model;
  }

  /** Classify one results block and append it to the model (staging plot PNGs). */
  async #pushBlock(block, model, imgN) {
    if (block.classList.contains('results-plot')) {
      const svg = block.querySelector('svg');
      if (svg) {
        try {
          const bytes = await svgElToPngBytes(svg);
          const path = `/tmp/ct_img_${imgN}.png`;
          await this.#webr.writeFile(path, bytes);
          const rect = svg.getBoundingClientRect();
          const ar = rect.width > 0 && rect.height > 0 ? rect.height / rect.width : 0.62;
          const w = 6.0;
          model.push({ t: 'image', path, w, h: Math.min(8, Number((w * ar).toFixed(2))) });
          return imgN + 1;
        } catch (err) {
          model.push({ t: 'text', text: `[plot omitted: ${err.message}]` });
          return imgN;
        }
      }
      return imgN;
    }
    const table = block.querySelector('table');
    if (table) {
      model.push({ t: 'table', ...extractTable(table) });
      return imgN;
    }
    const text = block.textContent.trim();
    if (text) model.push({ t: 'text', text });
    return imgN;
  }

  // --- dialog ----------------------------------------------------------------

  #showDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-export">
        <h2 class="ct-dialog__title">Export output</h2>
        <p class="ct-dialog__hint">Save the Output pane (tables, plots, notes) as a report.</p>
        <label class="ct-field">Report title
          <input name="title" type="text" value="${escapeAttr(this.#defaultTitle())}">
        </label>
        <menu class="ct-dialog__buttons ct-export__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="html" type="submit">Download HTML</button>
          <button value="docx" type="submit">Download Word</button>
          <button value="pdf" type="submit" class="ct-dialog__primary">Print / Save PDF</button>
        </menu>
      </form>`;
    dialog.addEventListener('close', () => {
      const action = dialog.returnValue;
      const title = dialog.querySelector('input[name="title"]')?.value.trim() || this.#defaultTitle();
      dialog.remove();
      if (action === 'html') this.#exportHtml(title);
      else if (action === 'pdf') this.#exportPdf(title);
      else if (action === 'docx') void this.#exportDocx(title);
    });
    document.body.append(dialog);
    dialog.showModal();
  }
}

// --- helpers ---------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function firstLine(s) {
  return String(s).split('\n').find((l) => l.trim()) ?? String(s);
}

/** Extract a results `<table>` into a {caption, header, rows, ncol} grid of text
 * cells, padded to a uniform column count (cell text only — faithful enough for
 * a Word table). */
function extractTable(table) {
  const caption = table.querySelector('caption')?.textContent.trim() ?? '';
  const headRows = [...table.querySelectorAll('thead tr')];
  let header = headRows.length
    ? [...headRows[headRows.length - 1].children].map((c) => c.textContent.trim())
    : [];
  let rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.children].map((c) => c.textContent.trim()),
  );
  if (!rows.length) {
    rows = [...table.querySelectorAll('tr')]
      .filter((tr) => !tr.closest('thead'))
      .map((tr) => [...tr.children].map((c) => c.textContent.trim()));
  }
  const ncol = Math.max(header.length, ...(rows.length ? rows.map((r) => r.length) : [0]), 1);
  const pad = (a) => {
    const out = a.slice(0, ncol);
    while (out.length < ncol) out.push('');
    return out;
  };
  header = pad(header.length ? header : new Array(ncol).fill(''));
  rows = rows.map(pad);
  return { caption, header, rows, ncol };
}

/** Encode a JS string as a valid R double-quoted string literal (non-ASCII via
 * \u/\U escapes, so there are no transport/encoding pitfalls). */
function rstr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) out += '\\u' + code.toString(16).padStart(4, '0');
    else if (code > 126) {
      out += code > 0xffff
        ? '\\U' + code.toString(16).padStart(8, '0')
        : '\\u' + code.toString(16).padStart(4, '0');
    } else out += ch;
  }
  return out + '"';
}

/** Generate the R script that assembles the content model into a `.docx` via
 * officer + flextable and writes it to `outPath`. */
function modelToR(model, outPath) {
  const L = [
    'suppressMessages({ library(officer); library(flextable) })',
    'doc <- read_docx()',
  ];
  for (const it of model) {
    if (it.t === 'title') {
      L.push(`doc <- body_add_par(doc, ${rstr(it.text)}, style = "heading 1")`);
    } else if (it.t === 'heading') {
      L.push(`doc <- body_add_par(doc, ${rstr(it.text)}, style = "heading 2")`);
    } else if (it.t === 'text') {
      L.push(`doc <- body_add_par(doc, ${rstr(it.text)}, style = "Normal")`);
    } else if (it.t === 'image') {
      L.push(`doc <- body_add_img(doc, src = ${rstr(it.path)}, width = ${it.w}, height = ${it.h})`);
    } else if (it.t === 'table') {
      const cells = it.rows.flat();
      L.push(`.hdr <- c(${it.header.map(rstr).join(', ')})`);
      L.push(
        `.m <- matrix(c(${cells.length ? cells.map(rstr).join(', ') : '""'}), ncol = ${it.ncol}, byrow = TRUE)`,
      );
      L.push('.df <- as.data.frame(.m, stringsAsFactors = FALSE); names(.df) <- paste0("c", seq_len(ncol(.df)))');
      L.push('.ft <- set_header_labels(flextable(.df), values = setNames(as.list(.hdr), names(.df)))');
      if (it.caption) L.push(`doc <- body_add_par(doc, ${rstr(it.caption)}, style = "Normal")`);
      L.push('doc <- body_add_flextable(doc, autofit(.ft))');
      L.push('doc <- body_add_par(doc, "", style = "Normal")');
    }
  }
  L.push(`print(doc, target = ${rstr(outPath)})`);
  L.push(`file.info(${rstr(outPath)})$size`);
  return L.join('\n');
}

/** A filesystem-friendly filename from a title + extension. */
function filenameFor(title, ext) {
  const base =
    String(title || 'crosstab-output')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'crosstab-output';
  return `${base}.${ext}`;
}
