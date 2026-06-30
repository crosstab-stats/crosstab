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
  #codecs;
  #analysisLog;
  #dataStore;

  /** pluginId → menu disposers, so unwiring on unload removes its menu items. */
  #disposers = new Map();

  /** `pluginId\0run` → { manifest, item, origin } for every wired menu action, so a
   * script `run id.fn` line can be enriched back into a replayable entry (#134). */
  #runnable = new Map();

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
  constructor({ loader, menus, results, ui, bus, importers, exporters, outputExporters, codecs, analysisLog, dataStore }) {
    this.#loader = loader;
    this.#menus = menus;
    this.#results = results;
    this.#ui = ui;
    this.#bus = bus;
    this.#importers = importers;
    this.#exporters = exporters;
    this.#outputExporters = outputExporters;
    this.#codecs = codecs ?? null;
    this.#analysisLog = analysisLog ?? null;
    this.#dataStore = dataStore ?? null;
  }

  /** True if a manifest uses the declarative model (this module should wire it). */
  static isDeclarative(manifest) {
    return ['menu', 'imports', 'exports', 'outputExports', 'codecs'].some(
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
      // Index it so the script editor can rebuild a replayable entry from a
      // `run <id>.<fn>` line (it needs the item's label/inputs + plugin name).
      this.#runnable.set(`${id}::${item.run}`, { manifest, item, origin: originLabel });
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

    // Streaming format codecs (#98): a unified read/write per format, routed through
    // the codec service's streaming invocation (not the one-shot deliver flow).
    for (const codec of manifest.codecs ?? []) {
      if (!this.#codecs) break;
      const dispose = this.#codecs.register({
        id: `${id}:${codec.id ?? codec.label}`,
        label: codec.label,
        extensions: codec.extensions,
        order: codec.order,
        multiple: codec.multiple,
        pluginId: id,
        read: codec.read,
        write: codec.write,
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }

    this.#disposers.set(id, disposers);
  }

  /** Every wired analysis action as a callable `run id.fn {…}` descriptor — the data
   * behind the Syntax guide's "running analyses" section. Reads the live #runnable
   * registry, so it lists exactly what a script can actually invoke (active plugins
   * only), with each item's inputs and the plugin's optional `howto`. */
  listRunnable() {
    return [...this.#runnable.values()]
      .map(({ manifest, item, origin }) => ({
        pluginId: manifest.id,
        pluginName: manifest.name || manifest.id,
        category: (typeof manifest.category === 'string' && manifest.category) || 'Other',
        origin: origin || null,
        run: item.run,
        label: String(item.label ?? '').replace(/\s*[.…]+\s*$/, ''),
        howto: typeof manifest.howto === 'string' ? manifest.howto : null,
        inputs: Array.isArray(item.inputs)
          ? item.inputs.map((i) => ({
              name: i.name,
              kind: i.kind || 'variables',
              label: i.label || null,
              multiple: !!i.multiple,
              optional: !!i.optional,
              options: Array.isArray(i.options) ? i.options : null,
              default: i.default,
            }))
          : [],
      }))
      .sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.label.localeCompare(b.label));
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
    for (const key of this.#runnable.keys()) {
      if (key.startsWith(`${id}::`)) this.#runnable.delete(key);
    }
  }

  /**
   * Rebuild a replayable analysis entry from a script `run <pluginId>.<fn>` line
   * (#134): the line carries only the plugin id, function and inputs, so we enrich
   * it with the live menu item's label, declared inputs and plugin name. Returns
   * null if no active plugin provides that action (caller skips it with a warning).
   * @param {{pluginId:string, run:string, inputs?:object}} a
   * @returns {import('./analysis-log.js').AnalysisEntry|null}
   */
  analysisEntryFor(a) {
    const t = this.#runnable.get(`${a.pluginId}::${a.run}`);
    if (!t) return null;
    return {
      pluginId: a.pluginId,
      pluginName: t.manifest.name,
      origin: t.origin,
      label: t.item.label,
      run: a.run,
      specs: Array.isArray(t.item.inputs) ? t.item.inputs : [],
      inputs: a.inputs || {},
    };
  }

  /** Run one menu action: gather inputs → execute → record it for replay (the
   * script). A cancelled input or a failed run is NOT recorded. */
  async #run(manifest, originLabel, item) {
    const specs = Array.isArray(item.inputs) ? item.inputs : [];
    const gathered = await gatherInputs(this.#ui, specs, item);
    if (gathered === null) return; // a required input was cancelled

    const entry = {
      pluginId: manifest.id,
      pluginName: manifest.name,
      origin: originLabel,
      label: item.label,
      run: item.run,
      specs,
      inputs: gathered,
      // The data position this analysis was run at: how many data transforms were
      // applied at the time. The script places/replays it here so its output
      // reflects the data AS OF this point (e.g. before a later filter), not the
      // final dataset — the order shown is the order computed.
      at: this.#dataStore?.getTransforms?.().length ?? 0,
      // Output position before this run, so undo can remove exactly this analysis's
      // output blocks (the tail it's about to append).
      outputMark: this.#results.getModel ? this.#results.getModel().length : 0,
    };
    const ok = await this.#execute(entry);
    if (ok) this.#analysisLog?.record(entry);
  }

  /**
   * Execute one analysis (live or replayed): emit lifecycle events, open the
   * host-owned output section, bind R inputs, and invoke the plugin function.
   * Returns true on success (so the caller can decide whether to log it). Shared by
   * {@link PluginActions#run} and {@link PluginActions#replay} so a replayed analysis
   * is framed identically to a live one.
   * @param {import('./analysis-log.js').AnalysisEntry} e
   * @returns {Promise<boolean>}
   */
  async #execute(e) {
    this.#bus.emit(CoreEvents.ANALYSIS_STARTED, { plugin: e.pluginId, title: e.label });
    this.#results.beginAnalysis(stripEllipsis(e.label), `${e.pluginName} · ${e.origin}`);
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
    let ok = false;
    try {
      this.#loader.setActiveInputs(e.pluginId, toInjectInputs(e.specs || [], e.inputs));
      await this.#loader.invoke(e.pluginId, e.run, [e.inputs]);
      ok = true;
    } catch (err) {
      this.#results.appendError(`${e.label}: ${err.message}`);
      console.error(`[plugin ${e.pluginId}]`, err);
    } finally {
      clearTimeout(watchdog);
      this.#loader.clearActiveInputs(e.pluginId);
      this.#results.endAnalysis();
      this.#bus.emit(CoreEvents.ANALYSIS_FINISHED, { plugin: e.pluginId });
    }
    return ok;
  }

  /**
   * Re-execute one recorded analysis entry (does NOT re-record it — replay must be
   * idempotent). Used by {@link PluginActions#replayAnalyses} and the script editor.
   * @param {import('./analysis-log.js').AnalysisEntry} entry
   */
  async replay(entry) {
    return this.#execute(entry);
  }

  /**
   * Replay every logged analysis in order, against the CURRENT dataset, reproducing
   * the Output pane. Optionally clears Output first. The plugin functions run via
   * the same path as a live run, so output framing/attribution match.
   * @param {{clear?: boolean}} [opts]
   */
  async replayAnalyses({ clear = false } = {}) {
    if (!this.#analysisLog) return;
    if (clear) this.#results.clear?.();
    for (const entry of this.#analysisLog.entries()) {
      // eslint-disable-next-line no-await-in-loop -- analyses must run in order
      await this.#execute(entry);
    }
  }

  /**
   * Run a parsed script (#134), **position-faithfully**: each analysis is executed
   * against the dataset AS OF its place in the script, so the output matches the
   * order shown (an analysis above a `keep if` reflects the pre-filter data, not the
   * final dataset). Walks the interleaved steps, growing the transform set and
   * rebuilding the data to that prefix before each analysis, then leaves the dataset
   * at its final state. Atomic: the full transform set is validated first, so a bad
   * data step aborts the whole Run before any output is cleared.
   *
   * @param {Array<{kind:'transform',op:object}|{kind:'analysis',ref:object}>} steps
   * @returns {Promise<{unknown:number}>} count of analysis lines whose plugin wasn't active.
   */
  async replayScript(steps) {
    const allTransforms = steps.filter((s) => s.kind === 'transform').map((s) => s.op);
    // Validate + apply the whole transform set first — throws (and changes nothing)
    // if a data step is invalid, BEFORE we clear the output pane.
    await this.#dataStore.replaceTransforms(allTransforms);

    this.#results.clear?.();
    const acc = [];
    const entries = [];
    let unknown = 0;
    let appliedLen = allTransforms.length; // data currently reflects all transforms
    for (const step of steps) {
      if (step.kind === 'transform') { acc.push(step.op); continue; }
      const entry = this.analysisEntryFor(step.ref);
      if (!entry) { unknown += 1; continue; }
      entry.at = acc.length;
      if (appliedLen !== acc.length) {
        // eslint-disable-next-line no-await-in-loop -- rebuild to this analysis's data state
        await this.#dataStore.replaceTransforms(acc.slice());
        appliedLen = acc.length;
      }
      // eslint-disable-next-line no-await-in-loop -- analyses run in script order
      await this.#execute(entry);
      entries.push(entry);
    }
    // Leave the dataset at its final state.
    if (appliedLen !== allTransforms.length) await this.#dataStore.replaceTransforms(allTransforms);
    this.#analysisLog?.load(entries);
    return { unknown };
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
    const hint = hintFor(spec); // explicit manifest hint, else a sensible default

    if (kind === 'variables') {
      const res = await ui.selectVariables({
        title,
        hint,
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
            hint,
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
      const r = await ui.selectFromList({ title, hint, items, multiple: false });
      if (r === null) {
        if (spec.optional) {
          out[spec.name] = spec.default ?? null;
          continue;
        }
        return null;
      }
      out[spec.name] = r[0] ?? null;
    } else if (kind === 'file') {
      // A supplementary file the analysis needs (boundary map, dictionary, weights
      // matrix…) — distinct from the importer flow, which produces a dataset. The
      // plugin receives { name, bytes } and does what it likes (e.g. writes the
      // bytes to WebR's FS and reads them in R).
      const file = await pickFile(spec.extensions);
      if (!file) {
        if (spec.optional) {
          out[spec.name] = null;
          continue;
        }
        return null;
      }
      out[spec.name] = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } else {
      out[spec.name] = null;
    }
  }
  return out;
}

/** The sub-heading shown under a picker explaining the choice. Uses the input's
 * explicit `hint` when the plugin author provided one; otherwise synthesises a
 * sensible default from the input's kind/types so *no* picker is ever a bare
 * "pick variable". Plugins should still add a `hint` to say *why* a variable is
 * needed for that specific analysis. */
function hintFor(spec) {
  if (spec && typeof spec.hint === 'string' && spec.hint.trim()) return spec.hint;
  const kind = spec?.kind || 'variables';
  if (kind === 'number') return 'Enter a number for this setting.';
  if (kind === 'text') return 'Enter a value for this setting.';
  if (kind === 'choice') return 'Choose one of the options.';
  if (kind === 'file') return 'Choose a file to use for this analysis.';
  const types = Array.isArray(spec?.types) ? spec.types : [];
  const numeric = types.length === 1 && types[0] === 'numeric';
  const categorical = types.length > 0 && types.every((t) => t === 'factor' || t === 'string');
  const adj = numeric ? 'numeric ' : categorical ? 'categorical ' : '';
  let s = spec?.multiple
    ? `Choose one or more ${adj}variables to include.`
    : `Choose the ${adj}variable for this role.`;
  if (spec?.unique) s += ' Each variable can be used in only one role.';
  return s;
}

/** Build the R-binding descriptor (for {@link webr.run}'s `injectInputs`). */
function toInjectInputs(specs, gathered) {
  const inj = {};
  for (const spec of specs) {
    const v = gathered[spec.name];
    const kind = spec.kind || 'variables';
    if (kind === 'file') continue; // not an R binding — the plugin handles the bytes
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

/** Open a native file picker and resolve the chosen File, or null if cancelled.
 * `extensions` (e.g. ['.geojson','.json']) filters the picker. */
function pickFile(extensions) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (Array.isArray(extensions) && extensions.length) input.accept = extensions.join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
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
