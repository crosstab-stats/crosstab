/**
 * @file output-export.js
 * **Output/report export** — the write-up half of export, distinct from *data*
 * export ({@link export-service.js}).
 *
 * Honouring "everything is a plugin": the actual formats (HTML, Word, …) are
 * **plugins** that register through `app.outputExporters` and read the Output
 * pane via the result-model surface (`app.results.getModel/getStyles/getPlotPng`).
 * What the host keeps is only what the security model forces it to:
 *
 *  - the **File ▸ Export output…** menu entry + the format-picker dialog (a
 *    sandboxed plugin can't draw host UI),
 *  - the **download** of returned bytes (a sandboxed iframe can't trigger one),
 *  - the **Print / Save PDF** action — the one export that genuinely needs the
 *    host, because it calls `window.print()` on a host-controlled iframe. (R can
 *    render a PDF via `pdf()`, but a full *report* PDF would need pandoc/LaTeX,
 *    which aren't in WebR; native print is pixel-perfect and zero-dep, so it
 *    stays the PDF path and stays host.)
 *
 * ## Flow (mirrors data export)
 * 1. A plugin calls `app.outputExporters.register({ id, label, extensions, export })`.
 * 2. The dialog lists a button per registered format (plus the host Print button).
 * 3. On pick, the host mints a `ticket` and calls `export({ ticket, title })`; the
 *    plugin reads `app.results.getModel()`, formats it, and calls
 *    `app.outputExporters.deliver(ticket, { filename, mimeType, data })`.
 * 4. The host downloads the bytes.
 */

import { downloadFile } from './export-service.js';

export class OutputExportService {
  /** The results-pane host element (carries the open shadow root) — for print. */
  #host;
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** ResultsPane#api — read surface (getModel) + appendError. */
  #results;
  /** @type {import('./event-bus.js').EventBus} */
  #bus;
  /** @type {?import('./project-sync.js').ProjectSync} */
  #projects = null;

  /** id → registered output-exporter spec. @type {Map<string, object>} */
  #exporters = new Map();
  /** ticket → deferred for an in-flight export. @type {Map<number, {resolve, reject}>} */
  #pending = new Map();
  #nextTicket = 1;

  /**
   * @param {Object} deps
   * @param {HTMLElement} deps.resultsHost - Element hosting the results shadow root.
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{getModel: Function, appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./event-bus.js').EventBus} deps.bus
   */
  constructor({ resultsHost, menus, results, bus }) {
    this.#host = resultsHost;
    this.#menus = menus;
    this.#results = results;
    this.#bus = bus;
  }

  /** Register the File menu entry. `projects` (optional) supplies the default
   * report title from the active project name. */
  activate(projects = null) {
    this.#projects = projects;
    this.#menus.register({
      id: 'core:export-output',
      path: ['File'],
      label: 'Export output…',
      order: 10,
      command: () => this.#open(),
    });
  }

  // --- plugin-facing registry ------------------------------------------------

  /**
   * Register an output-export format. Returns a disposer (run on plugin unload).
   * @param {{id?: string, label: string, extensions?: string[], export: Function, order?: number}} spec
   * @returns {() => void}
   */
  register(spec) {
    if (!spec || typeof spec.export !== 'function') {
      throw new TypeError('outputExporters.register: `export` must be a function');
    }
    const id = spec.id ?? spec.label;
    this.#exporters.set(id, { ...spec, id });
    return () => this.#exporters.delete(id);
  }

  /**
   * Receive formatted bytes from a plugin for a previously issued ticket.
   * @param {number} ticket
   * @param {{filename?: string, mimeType?: string, data: string|Uint8Array}|null} payload
   */
  deliver(ticket, payload) {
    const pending = this.#pending.get(ticket);
    if (!pending) throw new Error(`outputExporters.deliver: unknown or expired ticket ${ticket}`);
    pending.resolve(payload);
  }

  /** `app.outputExporters`. */
  get api() {
    return Object.freeze({
      register: (spec) => this.register(spec),
      deliver: (ticket, payload) => this.deliver(ticket, payload),
    });
  }

  // --- output inspection -----------------------------------------------------

  #hasOutput() {
    try {
      return (this.#results.getModel() ?? []).length > 0;
    } catch {
      return false;
    }
  }

  #defaultTitle() {
    return this.#projects?.activeName ?? 'CrossTab Output';
  }

  #open() {
    if (!this.#hasOutput()) {
      this.#results.appendError('Export output: there is no output yet. Run an analysis first.');
      return;
    }
    this.#showDialog();
  }

  // --- running a format plugin -----------------------------------------------

  async #runExporter(id, title) {
    const spec = this.#exporters.get(id);
    if (!spec) return;
    let payload;
    try {
      payload = await this.#awaitTicket((ticket) => spec.export({ ticket, title }));
    } catch (err) {
      this.#results.appendError(`Export to ${spec.label} failed: ${err.message}`);
      console.error('[output-export]', err);
      return;
    }
    if (!payload || payload.data == null) return; // plugin aborted (reported its own error)
    try {
      const ext = (spec.extensions && spec.extensions[0]) ? spec.extensions[0].replace(/^\./, '') : 'bin';
      downloadFile(payload.filename || filenameFor(title, ext), payload.mimeType || 'application/octet-stream', payload.data);
    } catch (err) {
      this.#results.appendError(`Export download failed: ${err.message}`);
      console.error('[output-export]', err);
    }
  }

  #awaitTicket(invoke) {
    const ticket = this.#nextTicket++;
    const done = new Promise((resolve, reject) => this.#pending.set(ticket, { resolve, reject }));
    invoke(ticket);
    return done.finally(() => this.#pending.delete(ticket));
  }

  // --- host-only print / PDF path --------------------------------------------

  /** Build a self-contained report HTML document from the live output DOM (the
   * print path stays WYSIWYG over the rendered shadow DOM). */
  #buildPrintReport(title) {
    const root = this.#host?.shadowRoot?.querySelector('.results-root');
    const clone = root.cloneNode(true);
    // Strip interactive chrome — buttons, the plot save/redraw bars, and the
    // data-driven chart's options panel — so the report shows just the results.
    for (const b of clone.querySelectorAll('.results-plot__redraw, .results-plot__save, .results-chart__controls, button')) b.remove();
    for (const p of clone.querySelectorAll('.results-plot')) p.style.resize = 'none';
    const paneStyles = this.#host?.shadowRoot?.querySelector('style')?.textContent ?? '';
    const safeTitle = escapeHtml(title || 'CrossTab Output');
    const when = new Date().toLocaleString();
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
${paneStyles}
body { margin: 0; background: #fff; }
.report-header { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 16px 0; color: #1a1a1a; }
.report-header h1 { margin: 0 0 2px; font-size: 22px; }
.report-header .report-meta { color: #666; font-size: 12px; }
.report-header hr { border: 0; border-top: 1px solid #ccc; margin: 14px 0 0; }
@media print {
  .results-plot, table, .results-block { break-inside: avoid; }
  .results-section { break-inside: avoid-page; }
  @page { margin: 18mm 14mm; }
}
</style></head><body>
<header class="report-header"><h1>${safeTitle}</h1>
<div class="report-meta">Generated by CrossTab · ${escapeHtml(when)}</div><hr></header>
${clone.outerHTML}
</body></html>`;
  }

  /** Render the report into a hidden iframe and print it (user picks Save as PDF). */
  #print(title) {
    let html;
    try {
      html = this.#buildPrintReport(title);
    } catch (err) {
      this.#results.appendError(`Print failed: ${err.message}`);
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    document.body.append(iframe);
    const cleanup = () => setTimeout(() => iframe.remove(), 1000);
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      win.requestAnimationFrame(() => {
        try {
          win.focus();
          win.print();
        } catch (err) {
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

  // --- dialog ----------------------------------------------------------------

  #showDialog() {
    const formats = [...this.#exporters.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label),
    );
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    const fmtButtons = formats
      .map((f) => `<button value="fmt:${escapeAttr(f.id)}" type="submit">${escapeHtml(f.label)}</button>`)
      .join('');
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-export">
        <h2 class="ct-dialog__title">Export output</h2>
        <p class="ct-dialog__hint">Save the Output pane (tables, plots, notes) as a report.</p>
        <label class="ct-field">Report title
          <input name="title" type="text" value="${escapeAttr(this.#defaultTitle())}">
        </label>
        <menu class="ct-dialog__buttons ct-export__buttons">
          <button value="cancel" type="submit">Cancel</button>
          ${fmtButtons}
          <button value="print" type="submit" class="ct-dialog__primary">Print / Save PDF</button>
        </menu>
      </form>`;
    dialog.addEventListener('close', () => {
      const action = dialog.returnValue;
      const title = dialog.querySelector('input[name="title"]')?.value.trim() || this.#defaultTitle();
      dialog.remove();
      if (action === 'print') this.#print(title);
      else if (action && action.startsWith('fmt:')) void this.#runExporter(action.slice(4), title);
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
