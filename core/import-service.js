/**
 * @file import-service.js
 * File import as an extension point (`app.importers`).
 *
 * Importers are just plugins. The official CSV / SPSS-Stata-SAS importers
 * register through the exact same call a third party would use for their own
 * file format — there is no privileged importer, same as there is no privileged
 * analysis. What the *engine* owns is only what the security model forces it to:
 *
 *  - The **File ▸ Import** menu entries (a plugin can't draw host UI).
 *  - The **file picker** — opened synchronously on the user's menu click so the
 *    browser's user-activation requirement for file dialogs is satisfied. (A
 *    plugin-driven picker would lose activation across the postMessage hops.)
 *  - The **commit** into the dataset (`DataStore.loadDataset`). A plugin only
 *    ever *describes* the parsed data; the engine commits it, and only as part
 *    of a user-initiated import — so no plugin can replace your data unprompted.
 *
 * ## Flow
 * 1. A plugin calls `app.importers.register({ label, extensions, parse })`.
 *    `parse` is a plugin-side callback (marshalled by the broker).
 * 2. The importer joins the unified `File ▸ Import data…` picker (one host item;
 *    see "One menu item, not one per format" below).
 * 3. On click (user activation live) the engine opens the picker, mints a
 *    `ticket`, and invokes `parse({ ticket, name, file })` (a one-way callback
 *    into the iframe). The `file` is a `File`/`Blob` handle — passed by
 *    reference, so even a large upload is not copied into the sandbox.
 * 4. The plugin parses and calls `app.importers.deliver(ticket, dataset)` — an
 *    RPC back to the engine — with `{ variables, columns }` or
 *    `{ variables, parquet }` (the dual contract).
 * 5. The engine resolves that ticket and commits via `DataStore.loadDataset`.
 *
 * This rides entirely on the existing protocol (one-way callbacks + plugin→host
 * RPC); no wire-protocol change was needed.
 *
 * ## One menu item, not one per format
 * The host exposes a single **File ▸ Import data…** entry (not one item per
 * importer). It opens the {@link showFormatPicker} dialog, built fresh from the
 * importers registered right now — so the File menu stays short no matter how many
 * codecs are activated, and the picker doubles as the cross-platform labelled
 * format chooser. Each importer still describes itself (label, extensions, group);
 * the picker just gathers them.
 */

import { showFormatPicker, groupFor, byGroupThenOrder } from './format-picker.js';

/**
 * @typedef {Object} ImporterSpec
 * @property {string} label - Menu label, e.g. `'CSV…'` or `'SPSS / Stata / SAS…'`.
 * @property {'file'|'web'} [source='file'] - Where the data comes from. `'file'`
 *   importers parse an uploaded file (the engine opens a picker). `'web'`
 *   importers fetch their own bytes (e.g. a FRED series) and get no file — the
 *   engine calls `parse({ ticket })` once, with no `name`/`file`.
 * @property {string[]} [extensions] - File extensions handled, with the dot, e.g.
 *   `['.csv']` or `['.sav', '.dta', '.sas7bdat']`. Used for the picker filter.
 *   Required for `'file'` importers; ignored for `'web'`.
 * @property {(req: {ticket: number, name?: string, file?: Blob, path?: string}) => void} parse
 *   - Plugin callback that parses the source and calls `importers.deliver`. For
 *   `'file'` importers it gets the upload as a `File` (Blob handle): JS parsers
 *   call `file.arrayBuffer()`. For `'web'` importers it gets only the `ticket`.
 *   For a `stage` importer it gets `path` (the host-mounted WebR path) instead of
 *   `file` — read it in R directly; the host owns the mount lifecycle.
 * @property {boolean} [stage] - Host-mount the upload into WebR and pass the
 *   plugin its `path` (no `file`). For large, R-parsed formats: avoids cloning a
 *   multi-GB file through the sandbox. Ignored for `'web'` importers.
 * @property {string} [id] - Stable id (defaults to `label`).
 * @property {number} [order] - Sort weight within File ▸ Import.
 * @property {boolean} [multiple=false] - Allow selecting several files at once
 *   (they stack/append into one pooled dataset). `parse` is still called once
 *   per file.
 */

export class ImportService {
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** @type {import('./data-store.js').DataStore} */
  #data;
  /** ResultsPane#api, for surfacing import errors. @type {{appendError: Function}} */
  #results;
  /** @type {import('./event-bus.js').EventBus} */
  #bus;
  /** WebRManager, for host-side staging of large uploads. @type {?import('./webr-manager.js').WebRManager} */
  #webr;

  /** ReadStatManager, for streaming SPSS/Stata/SAS imports. @type {?import('./readstat-manager.js').ReadStatManager} */
  #readstat;

  /** UiService, for the pre-import variable picker. @type {?import('./ui-service.js').UiService} */
  #ui;

  /** id → spec. @type {Map<string, ImporterSpec>} */
  #importers = new Map();

  /** ticket → deferred for an in-flight import. @type {Map<number, {resolve: Function, reject: Function}>} */
  #pending = new Map();

  /** Monotonic ticket id. */
  #nextTicket = 1;

  /** Disposer for the single "Import data…" menu item, or null when no importers
   * are registered (the item is created lazily and removed when the last one goes). */
  #menuDispose = null;

  /**
   * @param {Object} deps
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./data-store.js').DataStore} deps.data
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {import('./webr-manager.js').WebRManager} [deps.webr] - For staging
   *   large uploads host-side (see the `stage` importer option).
   * @param {import('./readstat-manager.js').ReadStatManager} [deps.readstat] - For
   *   streaming SPSS/Stata/SAS imports (see {@link ImportService#registerStreaming}).
   * @param {import('./ui-service.js').UiService} [deps.ui] - For the pre-import
   *   variable picker (a `pick` streaming importer).
   */
  constructor({ menus, data, results, bus, webr, readstat, ui }) {
    this.#menus = menus;
    this.#data = data;
    this.#results = results;
    this.#bus = bus;
    this.#webr = webr ?? null;
    this.#readstat = readstat ?? null;
    this.#ui = ui ?? null;
  }

  /**
   * Register a file importer. Adds it to the unified **File ▸ Import data…** picker
   * and returns a disposer that removes it (the loader runs it on plugin unload).
   *
   * @param {ImporterSpec} spec
   * @returns {() => void}
   */
  register(spec) {
    if (!spec || typeof spec.parse !== 'function') {
      throw new TypeError('importers.register: `parse` must be a function');
    }
    // File importers describe the extensions they accept; a `web` importer
    // fetches its own bytes and opens no file picker, so it needs none.
    const isWeb = spec.source === 'web';
    if (!isWeb && (!Array.isArray(spec.extensions) || spec.extensions.length === 0)) {
      throw new TypeError('importers.register: `extensions` must be a non-empty array');
    }
    const id = spec.id ?? spec.label;
    this.#importers.set(id, spec);
    this.#ensureMenu();
    return () => {
      this.#importers.delete(id);
      this.#refreshMenu();
    };
  }

  /**
   * Register a **streaming** importer (host-side, e.g. ReadStat for SPSS/Stata/SAS).
   * Unlike {@link ImportService#register}, this doesn't go through the plugin
   * deliver/`{variables,columns}` contract — it can't, because the whole point is
   * to never hold the dataset in memory. Instead it streams the file's rows
   * straight into the active dataset via {@link DataStore#loadStreaming}, in
   * batches. The engine still owns the menu entry, the file picker, and the commit.
   *
   * @param {Object} spec
   * @param {string} spec.label - Menu label.
   * @param {string[]} spec.extensions - Accepted extensions (picker filter).
   * @param {(name: string) => (string|null)} spec.formatFor - Map a file name to a
   *   format key the ReadStat manager understands (or null if unsupported).
   * @param {string} [spec.id]
   * @param {number} [spec.order]
   * @param {boolean} [spec.multiple]
   * @returns {() => void} disposer
   */
  registerStreaming(spec) {
    if (!spec || typeof spec.formatFor !== 'function' || !Array.isArray(spec.extensions)) {
      throw new TypeError('registerStreaming: `extensions` and `formatFor` are required');
    }
    const id = spec.id ?? spec.label;
    this.#importers.set(id, { ...spec, streaming: true });
    this.#ensureMenu();
    return () => {
      this.#importers.delete(id);
      this.#refreshMenu();
    };
  }

  /**
   * Register a **streaming codec** importer (#98). Like {@link registerStreaming},
   * it streams batches straight into the dataset — but the source is a generic
   * `ingest(file, ctx)` callback (a sandboxed plugin codec driving the pump),
   * rather than the host ReadStat worker. The engine still owns the menu, picker,
   * and commit.
   *
   * @param {Object} spec
   * @param {string} spec.label
   * @param {string[]} spec.extensions
   * @param {(file: Blob) => {begin: () => Promise<{variables, storageTypes, rowCount, wide}>, drain: (cb: Function) => Promise<void>}} spec.startRead
   *   - Start a read; returns a reader. `begin()` resolves with the catalog head
   *   (incl. a `wide` hint); `drain(cb)` pumps each column batch through `cb`.
   * @param {string} [spec.id]
   * @param {number} [spec.order]
   * @param {boolean} [spec.multiple]
   * @returns {() => void}
   */
  registerCodec(spec) {
    if (!spec || typeof spec.startRead !== 'function' || !Array.isArray(spec.extensions)) {
      throw new TypeError('registerCodec: `extensions` and `startRead` are required');
    }
    const id = spec.id ?? spec.label;
    this.#importers.set(id, { ...spec, codec: true });
    this.#ensureMenu();
    return () => {
      this.#importers.delete(id);
      this.#refreshMenu();
    };
  }

  /** Create the single "Import data…" File-menu item once (idempotent). It opens
   * the unified format picker, built from whatever importers are registered then. */
  #ensureMenu() {
    if (this.#menuDispose) return;
    this.#menuDispose = this.#menus.register({
      id: 'core:import-data',
      path: ['File'],
      label: 'Import data…',
      order: 30,
      command: () => this.#openPicker(),
    });
  }

  /** Drop the menu item when the last importer unregisters (re-created on the next
   * registration). Keeps the menu honest if every importer is deactivated. */
  #refreshMenu() {
    if (this.#importers.size === 0 && this.#menuDispose) {
      this.#menuDispose();
      this.#menuDispose = null;
    }
  }

  /** Open the unified Import-data picker. The chosen row runs `#runImport(id)`
   * synchronously (preserving the click's user activation for the file picker). */
  #openPicker() {
    const entries = [...this.#importers.entries()]
      .map(([id, spec]) => ({
        id,
        label: spec.label,
        extensions: spec.source === 'web' ? [] : spec.extensions,
        group: groupFor(spec),
        order: spec.order ?? 100,
        command: () => void this.#runImport(id),
      }))
      .sort(byGroupThenOrder);
    showFormatPicker({
      title: 'Import data',
      hint: 'Choose a format to import. Type to filter.',
      emptyText: 'No import formats are enabled. Turn some on in the plugin manager.',
      entries,
    });
  }

  /**
   * Receive parsed data from a plugin for a previously issued ticket. Resolves
   * the matching in-flight import.
   *
   * @param {number} ticket
   * @param {{variables: object[], columns?: object, parquet?: Uint8Array}} dataset
   */
  deliver(ticket, dataset) {
    const pending = this.#pending.get(ticket);
    if (!pending) throw new Error(`importers.deliver: unknown or expired ticket ${ticket}`);
    pending.resolve(dataset);
  }

  /**
   * The object exposed to plugins as `app.importers`.
   * @returns {Readonly<{ register: (spec: ImporterSpec) => (() => void), deliver: (ticket: number, dataset: object) => void }>}
   */
  get api() {
    return Object.freeze({
      register: (spec) => this.register(spec),
      deliver: (ticket, dataset) => this.deliver(ticket, dataset),
    });
  }

  // --- internals -------------------------------------------------------------

  /**
   * Run an import. For a `web` importer the plugin fetches its own data, so
   * there is no file picker — we mint one ticket and commit what it delivers.
   * For a file importer we pick file(s) and stack/replace each in turn.
   */
  async #runImport(id) {
    const spec = this.#importers.get(id);
    if (!spec) return;
    if (spec.source === 'web') return this.#runWebImport(id, spec);

    let files;
    try {
      files = await pickFiles(spec.extensions, spec.multiple === true);
    } catch (err) {
      this.#results.appendError(`Import: could not open file picker: ${err.message}`);
      return;
    }
    if (!files.length) return; // user cancelled

    // No data loaded → straight import (no mode dialog). Data loaded → ask how to
    // combine; join is offered only for a single incoming file.
    if (this.#data.rowCount === 0) {
      await this.#importFiles(spec, files, 'replace', id);
      return;
    }
    // Join needs inline columns to preview matches; a streaming importer delivers
    // none, so it offers only replace/append.
    const mode = await askMode(files.length, files.length === 1 && !spec.streaming && !spec.codec);
    if (!mode) return; // cancelled
    if (mode === 'join') {
      await this.#importJoin(spec, files[0], id);
    } else {
      await this.#importFiles(spec, files, mode, id);
    }
  }

  /**
   * Stream each file straight into the active dataset (no in-memory dataset). The
   * first file of a Replace creates the table; the rest append. Mirrors the
   * provenance-tagging rules of {@link ImportService#importFiles}.
   */
  async #importStreamingFiles(spec, files, mode, id) {
    let committed = 0;
    for (const file of files) {
      const format = spec.formatFor(file.name);
      if (!format) {
        this.#results.appendError(`Import: "${file.name}" isn't a supported SPSS/Stata/SAS file.`);
        continue;
      }

      // `selected` = a chosen subset of columns (null = all). `wide` = import the
      // whole file out-of-core (one Parquet file). `cat` = the file's catalog.
      let selected = null;
      let wide = false;
      let cat = null;

      if (spec.pick) {
        // Explicit "choose variables" importer: catalog, then pick a subset.
        cat = await this.#catalogOrError(file, format);
        if (!cat) continue;
        selected = await this.#pickVariables(file.name, cat);
        if (!selected || selected.length === 0) continue;
      } else {
        // "Import all": small files go into a DuckDB table (snappy). Large files
        // can't — DuckDB-WASM's store can't accumulate much past ~600 MB — so they
        // import out-of-core to a single Parquet file read in place. This is a
        // lossless full import either way (the storage choice is just an
        // implementation detail), so it's automatic: no prompt. Users who want a
        // subset use the "choose variables" importer.
        cat = await this.#catalogOrError(file, format);
        if (!cat) continue;
        const rows = cat.rowCount >= 0 ? cat.rowCount : 100000;
        const estParts = Math.ceil((cat.varCount * rows) / 4_000_000);
        if (estParts > 8) wide = true;
      }

      const fileMode = mode === 'replace' && committed === 0 ? 'replace' : 'append';
      const tag = mode === 'replace' && files.length === 1 ? undefined : baseName(file.name);
      const progress = this.#progressEmitter(file.name, cat.rowCount);
      this.#bus.emit('import:started', { importer: id, file: file.name });
      try {
        if (wide) {
          // One streaming pass, encoded to a single out-of-core Parquet file (the
          // only path that handles the full GSS without OOMing DuckDB's write side).
          await this.#data.loadWide({
            mode: fileMode,
            source: tag,
            variables: cat.variables,
            rowCount: cat.rowCount,
            onProgress: (done) => progress(done),
            stream: (onBatch) =>
              this.#readstat.stream(file, format, { onVariables: () => {}, onBatch }),
          });
        } else {
          let seen = 0;
          await this.#data.loadStreaming({
            mode: fileMode,
            source: tag,
            ingest: async (ctx) => {
              await this.#readstat.stream(file, format, {
                variables: selected, // null = all columns (moderate whole import)
                onVariables: (variables, storageTypes) => ctx.begin(variables, storageTypes),
                onBatch: (columns) => {
                  const k = Object.keys(columns)[0];
                  seen += k ? columns[k].length : 0;
                  progress(seen);
                  return ctx.batch(columns);
                },
              });
            },
          });
        }
        committed += 1;
      } catch (err) {
        this.#results.appendError(`Import of "${file.name}" failed: ${err.message}`);
        console.error('[import]', err);
      } finally {
        this.#bus.emit('import:ended', { importer: id, file: file.name });
      }
    }
    if (committed > 0) {
      this.#bus.emit('import:finished', {
        importer: id,
        files: files.length,
        committed,
        rowCount: this.#data.rowCount,
      });
    }
  }

  /**
   * Stream each file into the active dataset through a plugin **codec** (#98). The
   * codec's reader yields a catalog head (with a `wide` hint) then a stream of
   * column batches; the host commits via {@link DataStore#loadStreaming} normally, or
   * {@link DataStore#loadWide} (out-of-core single-Parquet, no DuckDB table) when the
   * codec flags an ultra-wide file — the GSS path. First file of a Replace creates
   * the source; the rest append. Mirrors importStreamingFiles' provenance rules.
   */
  async #importCodecFiles(spec, files, mode, id) {
    let committed = 0;
    for (const file of files) {
      const fileMode = mode === 'replace' && committed === 0 ? 'replace' : 'append';
      const tag = mode === 'replace' && files.length === 1 ? undefined : baseName(file.name);
      this.#bus.emit('import:started', { importer: id, file: file.name });
      try {
        const reader = spec.startRead(file);
        const head = await reader.begin();
        const progress = this.#progressEmitter(file.name, head.rowCount);
        let seen = 0;
        const tick = (columns) => {
          const k = Object.keys(columns)[0];
          seen += k ? columns[k].length : 0;
          progress(seen);
        };
        if (head.wide) {
          await this.#data.loadWide({
            mode: fileMode,
            source: tag,
            variables: head.variables,
            rowCount: head.rowCount,
            onProgress: (done) => progress(done),
            stream: (onBatch) => reader.drain((columns) => { tick(columns); onBatch(columns); }),
          });
        } else {
          await this.#data.loadStreaming({
            mode: fileMode,
            source: tag,
            ingest: async (ctx) => {
              ctx.begin(head.variables, head.storageTypes);
              await reader.drain((columns) => { tick(columns); return ctx.batch(columns); });
            },
          });
        }
        committed += 1;
      } catch (err) {
        this.#results.appendError(`Import of "${file.name}" failed: ${err.message}`);
        console.error('[import]', err);
      } finally {
        this.#bus.emit('import:ended', { importer: id, file: file.name });
      }
    }
    if (committed > 0) {
      this.#bus.emit('import:finished', {
        importer: id,
        files: files.length,
        committed,
        rowCount: this.#data.rowCount,
      });
    }
  }

  /** A throttled "rows read" progress reporter for one file: emits `import:progress`
   * at most every ~1,000 rows (and once at the end). Exact counts don't matter — it
   * just keeps the busy indicator's "X / Y rows" climbing. */
  #progressEmitter(fileName, total) {
    let last = 0;
    return (done) => {
      if (done - last >= 1000 || (total >= 0 && done >= total)) {
        last = done;
        this.#bus.emit('import:progress', { file: fileName, done, total });
      }
    };
  }

  /** Read a file's variable catalog, reporting any error to the results pane. */
  async #catalogOrError(file, format) {
    try {
      return await this.#readstat.catalog(file, format);
    } catch (err) {
      this.#results.appendError(`Could not read "${file.name}": ${err.message}`);
      return null;
    }
  }

  /** Show the searchable variable picker over a catalog; resolves to chosen names
   * (or null/empty if cancelled). */
  #pickVariables(name, cat) {
    return this.#ui.selectFromList({
      title: `Choose variables — ${name}`,
      hint:
        `${cat.varCount.toLocaleString()} variables` +
        (cat.rowCount >= 0 ? ` · ${cat.rowCount.toLocaleString()} rows` : '') +
        '. Pick the ones to import (search to filter).',
      items: cat.variables.map((v) => ({ value: v.name, label: v.label ? `${v.label} (${v.name})` : v.name })),
      multiple: true,
      okLabel: 'Import selected',
      searchPlaceholder: 'Filter by name or label…',
    });
  }

  /**
   * Parse each file and commit it — the first of a Replace creates the table,
   * everything else stacks (append). Used for replace/append (not join).
   */
  async #importFiles(spec, files, mode, id) {
    if (spec.codec) return this.#importCodecFiles(spec, files, mode, id);
    if (spec.streaming) return this.#importStreamingFiles(spec, files, mode, id);
    let committed = 0;
    for (const file of files) {
      try {
        const dataset = await this.#parseOne(spec, file);
        // null / empty = the importer aborted (and reported its own error).
        if (!dataset || !Array.isArray(dataset.variables) || dataset.variables.length === 0) {
          continue;
        }
        const fileMode = mode === 'replace' && committed === 0 ? 'replace' : 'append';
        // A lone single-file replace stays clean (no source_file column); any
        // multi-file or append run tags provenance with each file's name.
        const tag = mode === 'replace' && files.length === 1 ? undefined : baseName(file.name);
        await this.#data.loadDataset({ ...dataset, mode: fileMode, source: tag });
        committed += 1;
      } catch (err) {
        this.#results.appendError(`Import of "${file.name}" failed: ${err.message}`);
        console.error('[import]', err);
      }
    }
    if (committed > 0) {
      this.#bus.emit('import:finished', {
        importer: id,
        files: files.length,
        committed,
        rowCount: this.#data.rowCount,
      });
    }
  }

  /**
   * Parse one file and merge it into the loaded data by a key: run the join
   * review (key pick + match preview + manual pairing), then commit a LEFT JOIN.
   */
  async #importJoin(spec, file, id) {
    let dataset;
    try {
      dataset = await this.#parseOne(spec, file);
    } catch (err) {
      this.#results.appendError(`Import of "${file.name}" failed: ${err.message}`);
      return;
    }
    const review = await this.#reviewAndJoin(dataset, baseName(file.name), id);
    if (review) this.#emitFinished(id, 1);
  }

  /**
   * Shared join path for file and web imports: validate the incoming dataset has
   * inline columns (needed to preview matches), run the review dialog, and commit
   * the join. Returns true if a join was committed.
   *
   * @param {object|null} dataset - The parsed incoming dataset.
   * @param {string} fallbackTag - Provenance label if the dataset has none.
   * @returns {Promise<boolean>}
   */
  async #reviewAndJoin(dataset, fallbackTag, id) {
    if (!dataset || !Array.isArray(dataset.variables) || dataset.variables.length === 0) {
      return false; // importer aborted
    }
    if (!dataset.columns) {
      this.#results.appendError(
        'Join isn’t available for this importer yet (it delivers data without inline columns).',
      );
      return false;
    }
    const review = await showJoinReview({
      baseMeta: this.#data.getVariableMeta(),
      getBaseColumn: async (name) => {
        const c = await this.#data.getColumns({ variables: [name] });
        return Array.from(c[name] ?? []);
      },
      incoming: dataset,
    });
    if (!review) return false; // cancelled
    try {
      await this.#data.loadDataset({
        ...dataset,
        mode: 'join',
        source: dataset.source ?? fallbackTag,
        joinKey: review.joinKey,
        aliases: review.aliases,
      });
      return true;
    } catch (err) {
      this.#results.appendError(`Join failed: ${err.message}`);
      console.error('[import]', err);
      return false;
    }
  }

  /** Emit the import:finished event (focuses the Data view). */
  #emitFinished(id, committed) {
    this.#bus.emit('import:finished', {
      importer: id,
      files: 1,
      committed,
      rowCount: this.#data.rowCount,
    });
  }

  /**
   * Run a `web` importer: no file picker. Mint a ticket, let the plugin fetch
   * and deliver one dataset, then commit it (asking replace-vs-append if data
   * is already loaded). The plugin owns its own provenance tag via
   * `dataset.source` (e.g. a FRED series id).
   */
  async #runWebImport(id, spec) {
    let dataset;
    try {
      dataset = await this.#awaitTicket((ticket) => spec.parse({ ticket }));
    } catch (err) {
      this.#results.appendError(`Import failed: ${err.message}`);
      console.error('[import]', err);
      return;
    }
    // null / empty = the importer aborted (and reported its own error).
    if (!dataset || !Array.isArray(dataset.variables) || dataset.variables.length === 0) {
      return;
    }

    let mode = 'replace';
    if (this.#data.rowCount > 0) {
      mode = await askMode(1, true);
      if (!mode) return; // cancelled
    }
    if (mode === 'join') {
      const ok = await this.#reviewAndJoin(dataset, dataset.source ?? id, id);
      if (ok) this.#emitFinished(id, 1);
      return;
    }
    // A clean single-source replace stays untagged; an append carries provenance
    // (the plugin's own label, falling back to the id).
    const tag = mode === 'replace' ? undefined : dataset.source ?? id;
    try {
      await this.#data.loadDataset({ ...dataset, mode, source: tag });
    } catch (err) {
      this.#results.appendError(`Import failed: ${err.message}`);
      console.error('[import]', err);
      return;
    }
    this.#emitFinished(id, 1);
  }

  /** Hand one file to the plugin and resolve with the dataset it delivers.
   *
   * A `stage` importer (large, R-parsed — e.g. haven) gets the file **mounted
   * host-side** and is handed only its WebR path: the host holds the fresh `File`
   * straight from the picker and mounts it itself, so the upload is never
   * structured-cloned through the sandbox (truly by-reference, no double-clone,
   * no giant copy into the plugin). The host owns the mount lifecycle. A normal
   * importer (JS-parsed — e.g. CSV) still gets the `File` to read in JS. */
  async #parseOne(spec, file) {
    if (spec.stage && this.#webr) {
      let path;
      try {
        path = await this.#webr.mountFile(file, file.name);
      } catch (err) {
        const m = err?.message || String(err);
        // The browser can't read a single file blob past ~2 GB (NotReadableError),
        // which is the wall multi-GB extracts hit on the way into WebR.
        throw new Error(
          /could not be read|NotReadableError|permission problems that have occurred after a reference/i.test(m)
            ? `“${file.name}” is too large for the browser to read directly (over ~2 GB). Use a smaller extract — fewer variables or years.`
            : `could not stage “${file.name}”: ${m}`,
        );
      }
      try {
        return await this.#awaitTicket((ticket) => spec.parse({ ticket, name: file.name, path }));
      } finally {
        try {
          await this.#webr.unmount(path);
        } catch {
          /* best-effort unmount */
        }
      }
    }
    return this.#awaitTicket((ticket) => spec.parse({ ticket, name: file.name, file }));
  }

  /**
   * Mint a ticket, run `invoke(ticket)` (which kicks off the plugin's parse),
   * and resolve with whatever the plugin `deliver`s for that ticket.
   * @param {(ticket: number) => void} invoke
   * @returns {Promise<object|null>}
   */
  #awaitTicket(invoke) {
    const ticket = this.#nextTicket++;
    const done = new Promise((resolve, reject) => {
      this.#pending.set(ticket, { resolve, reject });
    });
    invoke(ticket);
    return done.finally(() => this.#pending.delete(ticket));
  }
}

/** File name without directory or extension, for the provenance tag. */
function baseName(name) {
  return String(name).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

/**
 * Ask how an import should combine with the loaded data. Resolves to
 * `'replace'`, `'append'`, `'join'`, or `null` (cancelled). `'join'` is only
 * offered when `canJoin` (a single incoming dataset — joining a batch is
 * ambiguous).
 *
 * @param {number} fileCount
 * @param {boolean} [canJoin=false]
 * @returns {Promise<'replace'|'append'|'join'|null>}
 */
function askMode(fileCount, canJoin = false) {
  const noun = fileCount > 1 ? `${fileCount} files` : 'this file';
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const joinBtn = canJoin
      ? `<button value="join" type="submit">Join (match on a key)…</button>`
      : '';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">Import ${fileCount > 1 ? `${fileCount} files` : 'data'}</h2>
        <p class="ct-dialog__hint">A dataset is already loaded. Add ${noun} to it
          (stack rows), join it on a key (add columns), or replace what's loaded?</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="replace" type="submit">Replace</button>
          ${joinBtn}
          <button value="append" type="submit" class="ct-dialog__primary">Add rows</button>
        </menu>
      </form>`;
    dialog.addEventListener('close', () => {
      const v = dialog.returnValue;
      dialog.remove();
      resolve(['append', 'replace', 'join'].includes(v) ? v : null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Open a host file picker and resolve with the chosen files (empty array if the
 * user cancels). Must be called within a user gesture (we are — straight off the
 * menu click) so the browser allows the dialog.
 *
 * @param {string[]} extensions - Accept filter, e.g. `['.csv']`.
 * @param {boolean} multiple - Allow selecting several files at once.
 * @returns {Promise<File[]>}
 */
function pickFiles(extensions, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.multiple = multiple;
    input.style.display = 'none';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    // `cancel` fires when the dialog is dismissed (recent browsers). Harmless
    // where unsupported — change still resolves the happy path.
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/** Normalised key for matching: text, trimmed, lower-cased. */
function normKey(v) {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Match base key values against incoming key values, honouring manual aliases
 * (incoming value → base value applied before normalising). Pure; the join
 * review's live preview and the engine's SQL use the same normalise rule.
 *
 * @param {Array} baseValues
 * @param {Array} incomingValues
 * @param {Array<{base: string, incoming: string}>} aliases
 * @returns {{matched: number, baseCount: number, incomingCount: number,
 *   unmatchedBase: string[], unmatchedIncoming: string[]}}
 */
function computeMatch(baseValues, incomingValues, aliases) {
  const baseByNorm = new Map();
  for (const v of baseValues) {
    const n = normKey(v);
    if (!baseByNorm.has(n)) baseByNorm.set(n, v);
  }
  const incByNorm = new Map();
  for (const v of incomingValues) {
    const n = normKey(v);
    if (!incByNorm.has(n)) incByNorm.set(n, v);
  }
  const aliasMap = new Map(); // incoming-norm → base-norm
  for (const a of aliases) aliasMap.set(normKey(a.incoming), normKey(a.base));

  let matched = 0;
  const matchedBaseNorms = new Set();
  const unmatchedIncoming = [];
  for (const [n, orig] of incByNorm) {
    const bn = aliasMap.has(n) ? aliasMap.get(n) : n;
    if (baseByNorm.has(bn)) {
      matched++;
      matchedBaseNorms.add(bn);
    } else {
      unmatchedIncoming.push(orig);
    }
  }
  const unmatchedBase = [];
  for (const [n, orig] of baseByNorm) if (!matchedBaseNorms.has(n)) unmatchedBase.push(orig);
  return {
    matched,
    baseCount: baseByNorm.size,
    incomingCount: incByNorm.size,
    unmatchedBase: unmatchedBase.map(String).sort(),
    unmatchedIncoming: unmatchedIncoming.map(String).sort(),
  };
}

/** Guess a likely key column: first string/factor variable, else the first. */
function guessKey(metas) {
  const s = metas.find((m) => m.type === 'string' || m.type === 'factor');
  return (s ?? metas[0])?.name;
}

/**
 * Interactive join review: pick the key on each side, see the live match preview,
 * and manually pair leftover values (the visible-not-fuzzy step). Resolves to
 * `{ joinKey:{left,right}, aliases:[{base,incoming}] }` or `null` if cancelled.
 *
 * @param {Object} opts
 * @param {import('./data-store.js').VariableMeta[]} opts.baseMeta
 * @param {(name: string) => Promise<Array>} opts.getBaseColumn
 * @param {{variables: object[], columns: Object<string, Array>}} opts.incoming
 * @returns {Promise<{joinKey: {left: string, right: string}, aliases: Array}|null>}
 */
function showJoinReview({ baseMeta, getBaseColumn, incoming }) {
  const incMetas = incoming.variables;
  return new Promise((resolve) => {
    let baseKey = guessKey(baseMeta);
    let incKey = guessKey(incMetas);
    const aliases = []; // {base, incoming}
    let baseValues = [];
    let selBase = null;
    let selInc = null;

    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form ct-join">
        <h2 class="ct-dialog__title">Join — match on a key</h2>
        <p class="ct-dialog__hint">Match your rows to the incoming rows by a key.
          Unmatched rows keep your data with the new columns left blank; pair up any
          that should match below.</p>
        <div class="ct-join__keys"></div>
        <p class="ct-join__summary"></p>
        <div class="ct-join__cols">
          <div class="ct-join__side">
            <div class="ct-join__side-head">Current — unmatched</div>
            <ul class="ct-join__list" data-side="base"></ul>
          </div>
          <div class="ct-join__side">
            <div class="ct-join__side-head">Incoming — unmatched</div>
            <ul class="ct-join__list" data-side="inc"></ul>
          </div>
        </div>
        <button type="button" class="ct-join__pair" disabled>Match selected ↔</button>
        <div class="ct-join__manual"></div>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Join</button>
        </menu>
      </form>`;

    const keysEl = dialog.querySelector('.ct-join__keys');
    const summaryEl = dialog.querySelector('.ct-join__summary');
    const baseListEl = dialog.querySelector('.ct-join__list[data-side="base"]');
    const incListEl = dialog.querySelector('.ct-join__list[data-side="inc"]');
    const pairBtn = dialog.querySelector('.ct-join__pair');
    const manualEl = dialog.querySelector('.ct-join__manual');

    const makeSelect = (metas, cur) => {
      const s = document.createElement('select');
      for (const m of metas) {
        const o = document.createElement('option');
        o.value = m.name;
        o.textContent = m.label ? `${m.label} (${m.name})` : m.name;
        if (m.name === cur) o.selected = true;
        s.append(o);
      }
      return s;
    };
    const baseSel = makeSelect(baseMeta, baseKey);
    const incSel = makeSelect(incMetas, incKey);
    keysEl.append(
      document.createTextNode('Current '),
      baseSel,
      document.createTextNode(' ↔ incoming '),
      incSel,
    );

    const render = (match) => {
      summaryEl.textContent =
        `${match.matched} matched · ${match.unmatchedBase.length} current unmatched · ` +
        `${match.unmatchedIncoming.length} incoming unmatched`;
      const fill = (ul, vals, side) => {
        ul.replaceChildren();
        for (const v of vals) {
          const li = document.createElement('li');
          li.textContent = v;
          if ((side === 'base' && v === selBase) || (side === 'inc' && v === selInc)) {
            li.classList.add('sel');
          }
          li.addEventListener('click', () => {
            if (side === 'base') selBase = selBase === v ? null : v;
            else selInc = selInc === v ? null : v;
            [...ul.children].forEach((c) =>
              c.classList.toggle('sel', c.textContent === (side === 'base' ? selBase : selInc)),
            );
            pairBtn.disabled = !(selBase && selInc);
          });
          ul.append(li);
        }
      };
      fill(baseListEl, match.unmatchedBase, 'base');
      fill(incListEl, match.unmatchedIncoming, 'inc');

      manualEl.replaceChildren();
      if (aliases.length) {
        const head = document.createElement('div');
        head.className = 'ct-join__manual-head';
        head.textContent = 'Manual matches';
        manualEl.append(head);
        aliases.forEach((a, i) => {
          const row = document.createElement('div');
          row.className = 'ct-join__manual-row';
          row.append(document.createTextNode(`${a.base} ↔ ${a.incoming}`));
          const x = document.createElement('button');
          x.type = 'button';
          x.textContent = '✕';
          x.addEventListener('click', () => {
            aliases.splice(i, 1);
            recompute();
          });
          row.append(x);
          manualEl.append(row);
        });
      }
    };

    const recompute = () => render(computeMatch(baseValues, incoming.columns[incKey] ?? [], aliases));
    const reloadBase = async () => {
      baseValues = await getBaseColumn(baseKey);
      recompute();
    };

    baseSel.addEventListener('change', () => {
      baseKey = baseSel.value;
      selBase = null;
      reloadBase();
    });
    incSel.addEventListener('change', () => {
      incKey = incSel.value;
      selInc = null;
      recompute();
    });
    pairBtn.addEventListener('click', () => {
      if (!selBase || !selInc) return;
      aliases.push({ base: selBase, incoming: selInc });
      selBase = null;
      selInc = null;
      pairBtn.disabled = true;
      recompute();
    });

    dialog.addEventListener('close', () => {
      const ok = dialog.returnValue === 'ok';
      dialog.remove();
      resolve(ok ? { joinKey: { left: baseKey, right: incKey }, aliases } : null);
    });
    document.body.append(dialog);
    dialog.showModal();
    reloadBase();
  });
}
