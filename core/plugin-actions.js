/**
 * @file plugin-actions.js
 * Host-side wiring for **declarative** plugins. A declarative plugin ships no
 * registration code; it declares its menu items (and their inputs) as manifest
 * data and exports named functions. This module reads that manifest and does all
 * the wiring the plugin used to do imperatively:
 *
 *  - registers each `manifest.menu` item under the plugin's `category` (host-owned
 *    placement — a plugin can't choose where its menu lands);
 *  - on click, **gathers the item's declared `inputs`** with host dialogs (so the
 *    plugin writes no picker code), binds them into R by name (via the broker's
 *    active-inputs), opens the output section (host-owned heading + attribution),
 *    then **invokes the named function** with the gathered inputs;
 *  - emits the analysis lifecycle events around the call.
 *
 * The plugin function therefore receives ready inputs and only does the analysis.
 */

import { CoreEvents } from './event-bus.js';

export class PluginActions {
  #loader;
  #menus;
  #results;
  #ui;
  #bus;
  #importers;
  #exporters;
  #outputExporters;

  /** pluginId → menu disposers, so unwiring on unload removes its menu items. */
  #disposers = new Map();

  /**
   * @param {Object} deps
   * @param {import('./loader.js').PluginLoader} deps.loader
   * @param {object} deps.menus - MenuShell#api (`register` returns a disposer).
   * @param {import('./results-pane.js').ResultsPane} deps.results - The instance
   *   (needs the host-facing `beginAnalysis`/`endAnalysis`, not just the api).
   * @param {object} deps.ui - UiService#api.
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {object} deps.importers - ImportService#api (register/deliver).
   * @param {object} deps.exporters - ExportService#api (register/deliver).
   * @param {object} deps.outputExporters - OutputExportService#api.
   */
  constructor({ loader, menus, results, ui, bus, importers, exporters, outputExporters }) {
    this.#loader = loader;
    this.#menus = menus;
    this.#results = results;
    this.#ui = ui;
    this.#bus = bus;
    this.#importers = importers;
    this.#exporters = exporters;
    this.#outputExporters = outputExporters;
  }

  /** True if a manifest uses the declarative model (this module should wire it). */
  static isDeclarative(manifest) {
    return ['menu', 'imports', 'exports', 'outputExports'].some(
      (k) => Array.isArray(manifest?.[k]) && manifest[k].length > 0,
    );
  }

  /**
   * Wire a loaded declarative plugin's menu items.
   * @param {object} manifest
   * @param {string} originLabel - Host-tracked origin for attribution
   *   (e.g. "built-in", "from example.com").
   */
  wire(manifest, originLabel) {
    const id = manifest.id;
    const category =
      typeof manifest.category === 'string' && manifest.category ? manifest.category : 'Other';
    const disposers = [];
    for (const item of manifest.menu ?? []) {
      const dispose = this.#menus.register({
        id: `${id}:${item.run}`,
        path: [category],
        label: item.label,
        order: item.order,
        command: () => this.#run(manifest, originLabel, item),
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }

    // Importers/exporters: bridge the declarative named function to each host
    // service's ticket/deliver flow — invoke the function, deliver its return.
    for (const imp of manifest.imports ?? []) {
      const dispose = this.#importers.register({
        id: `${id}:${imp.parse}`,
        label: imp.label,
        order: imp.order,
        extensions: imp.extensions,
        multiple: imp.multiple,
        source: imp.source,
        stage: imp.stage,
        parse: (req) =>
          this.#bridge(this.#importers, req.ticket, () =>
            this.#loader.invoke(id, imp.parse, [{ name: req.name, file: req.file, path: req.path }]),
          ),
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }
    for (const exp of manifest.exports ?? []) {
      const dispose = this.#exporters.register({
        id: `${id}:${exp.export}`,
        label: exp.label,
        order: exp.order,
        extensions: exp.extensions,
        export: (req) =>
          this.#bridge(this.#exporters, req.ticket, () => this.#loader.invoke(id, exp.export, [])),
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }
    for (const exp of manifest.outputExports ?? []) {
      const dispose = this.#outputExporters.register({
        id: `${id}:${exp.export}`,
        label: exp.label,
        order: exp.order,
        extensions: exp.extensions,
        export: (req) =>
          this.#bridge(this.#outputExporters, req.ticket, () =>
            this.#loader.invoke(id, exp.export, [{ title: req.title }]),
          ),
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }

    this.#disposers.set(id, disposers);
  }

  /** Run a declarative parse/export function and deliver its return to the host
   * service's ticket (delivering null on failure so the in-flight op resolves). */
  #bridge(service, ticket, invoke) {
    invoke()
      .then((payload) => service.deliver(ticket, payload))
      .catch((err) => {
        this.#results.appendError(`Plugin failed: ${err.message}`);
        console.error('[plugin]', err);
        service.deliver(ticket, null);
      });
  }

  /** Remove a plugin's menu items (called on unload). */
  unwire(id) {
    for (const dispose of this.#disposers.get(id) ?? []) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    this.#disposers.delete(id);
  }

  /** Run one menu action: gather inputs → open section → invoke the function. */
  async #run(manifest, originLabel, item) {
    const specs = Array.isArray(item.inputs) ? item.inputs : [];
    const gathered = await gatherInputs(this.#ui, specs, item);
    if (gathered === null) return; // a required input was cancelled

    this.#bus.emit(CoreEvents.ANALYSIS_STARTED, { plugin: manifest.id, title: item.label });
    this.#results.beginAnalysis(stripEllipsis(item.label), `${manifest.name} · ${originLabel}`);
    // Watchdog: if a run goes quiet for a long time it may be a legitimately slow
    // analysis (resampling/MCMC/first-run installs) OR a stuck R job. Either way,
    // don't leave the user staring at a silent spinner — post a non-destructive
    // notice so they know it's still going and what to do if it's wedged.
    const watchdog = setTimeout(() => {
      this.#results.appendText(
        '_Still working… resampling, MCMC, and first-run package installs can take a while. ' +
          'If it seems stuck, reloading the page is safe — your saved project is kept._',
      );
    }, 45000);
    try {
      this.#loader.setActiveInputs(manifest.id, toInjectInputs(specs, gathered));
      await this.#loader.invoke(manifest.id, item.run, [gathered]);
    } catch (err) {
      this.#results.appendError(`${item.label}: ${err.message}`);
      console.error(`[plugin ${manifest.id}]`, err);
    } finally {
      clearTimeout(watchdog);
      this.#loader.clearActiveInputs(manifest.id);
      this.#results.endAnalysis();
      this.#bus.emit(CoreEvents.ANALYSIS_FINISHED, { plugin: manifest.id });
    }
  }
}

// --- input gathering ---------------------------------------------------------

/**
 * Gather an action's declared inputs with host dialogs, in order. Returns a map
 * of input name → value (single-variable → name string, multi → string[],
 * number → Number, choice/text → string), or `null` if a *required* input was
 * cancelled. A cancelled `optional` input yields a null/empty value and continues.
 *
 * @param {object} ui - UiService#api
 * @param {Array<object>} specs
 * @param {object} item - The menu item (for composing dialog titles).
 */
async function gatherInputs(ui, specs, item) {
  const out = {};
  const takenUnique = []; // variables chosen by earlier `unique` inputs → excluded later

  for (const spec of specs) {
    const title = composeTitle(item.label, spec.label);
    const kind = spec.kind || 'variables';

    if (kind === 'variables') {
      const res = await ui.selectVariables({
        title,
        multiple: !!spec.multiple,
        types: spec.types,
        exclude: spec.unique ? takenUnique.slice() : undefined,
      });
      if (res === null) {
        if (spec.optional) {
          out[spec.name] = spec.multiple ? [] : null;
          continue;
        }
        return null;
      }
      out[spec.name] = spec.multiple ? res : res[0] ?? null;
      if (spec.unique) takenUnique.push(...(spec.multiple ? res : res.slice(0, 1)));
    } else if (kind === 'number' || kind === 'text') {
      const r = await ui.showForm({
        title,
        fields: [
          {
            name: spec.name,
            label: spec.label || spec.name,
            type: kind === 'number' ? 'number' : 'text',
            value: spec.default != null ? String(spec.default) : '',
          },
        ],
      });
      if (r === null) {
        if (spec.optional) {
          out[spec.name] = spec.default ?? null;
          continue;
        }
        return null;
      }
      out[spec.name] = kind === 'number' ? Number(r[spec.name]) : r[spec.name];
    } else if (kind === 'choice') {
      const items = (spec.options || []).map((o) =>
        typeof o === 'object' ? { value: String(o.value), label: o.label } : { value: String(o) },
      );
      const r = await ui.selectFromList({ title, items, multiple: false });
      if (r === null) {
        if (spec.optional) {
          out[spec.name] = spec.default ?? null;
          continue;
        }
        return null;
      }
      out[spec.name] = r[0] ?? null;
    } else {
      out[spec.name] = null;
    }
  }
  return out;
}

/** Build the R-binding descriptor (for {@link webr.run}'s `injectInputs`). */
function toInjectInputs(specs, gathered) {
  const inj = {};
  for (const spec of specs) {
    const v = gathered[spec.name];
    const kind = spec.kind || 'variables';
    if (kind === 'variables') {
      const columns = v == null ? [] : Array.isArray(v) ? v : [v];
      inj[spec.name] = { kind: 'variables', columns, multiple: !!spec.multiple };
    } else if (kind === 'number') {
      inj[spec.name] = { kind: 'number', value: v };
    } else {
      inj[spec.name] = { kind: 'text', value: v == null ? null : String(v) };
    }
  }
  return inj;
}

/** Dialog title from the menu label (minus its trailing "…") and an input role. */
function composeTitle(label, role) {
  const base = stripEllipsis(label);
  return role ? `${base} — ${role}` : base;
}

/** Strip a trailing ellipsis (…/...) from a menu label for use as a heading. */
function stripEllipsis(s) {
  return String(s ?? '').replace(/\s*(…|\.\.\.)\s*$/, '');
}
