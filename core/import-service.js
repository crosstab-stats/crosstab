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
import { readZipEntries } from './zip.js';

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
   */
  constructor({ menus, data, results, bus, webr }) {
    this.#menus = menus;
    this.#data = data;
    this.#results = results;
    this.#bus = bus;
    this.#webr = webr ?? null;
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
   * Register a **streaming codec** importer (#98). It streams batches straight into
   * the dataset — the source is a generic
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
    // A cross-cutting "fetch a data file by URL" entry — routed to the right codec
    // by the URL's extension, so it needs no per-format registration. Sits atop the
    // Online sources group with the web importers.
    if (this.#fileImporters().length) {
      entries.push({
        id: 'core:import-url',
        label: 'From a web address (URL)…',
        extensions: [],
        group: 'Online sources',
        order: -1,
        command: () => void this.#runUrlImport(),
      });
      entries.sort(byGroupThenOrder);
    }
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
    await this.#dispatchFiles(spec, files, id);
  }

  /**
   * Given resolved file(s) + their importer, run the combine flow: straight import
   * when nothing is loaded, else ask replace / add rows / join / new dataset. Shared
   * by the file-picker path ({@link #runImport}) and the URL path
   * ({@link #runUrlImport}) so both behave identically once the bytes are in hand.
   */
  async #dispatchFiles(spec, files, id) {
    // No data loaded → straight import (no mode dialog). Data loaded → ask how to
    // combine; join is offered only for a single incoming file.
    if (this.#data.rowCount === 0) {
      await this.#importFiles(spec, files, 'replace', id);
      return;
    }
    // Join needs inline columns to preview matches; a streaming codec delivers
    // none, so it offers only replace/append.
    const mode = await askMode(files.length, files.length === 1 && !spec.codec);
    if (!mode) return; // cancelled
    if (mode === 'join') {
      await this.#importJoin(spec, files[0], id);
    } else if (mode === 'new') {
      // Import into a brand-new dataset in this project — the current one is left
      // untouched. Create + activate an empty dataset, then load as a replace into it.
      const name = files.length === 1 ? baseName(files[0].name) : 'Imported data';
      this.#data.add(name, { activate: true });
      await this.#importFiles(spec, files, 'replace', id);
    } else {
      await this.#importFiles(spec, files, mode, id);
    }
  }

  /** Registered file (non-`web`) importers as `[id, spec]` pairs. */
  #fileImporters() {
    return [...this.#importers.entries()].filter(([, s]) => s.source !== 'web');
  }

  /** Find the file importer that handles `ext` (with the dot, lower-case), or null. */
  #importerForExt(ext) {
    for (const [id, spec] of this.#fileImporters()) {
      if ((spec.extensions || []).some((e) => e.toLowerCase() === ext)) return [id, spec];
    }
    return null;
  }

  /** Every extension a file importer accepts (for "supported formats" messages). */
  #knownExts() {
    const s = new Set();
    for (const [, spec] of this.#fileImporters()) for (const e of spec.extensions || []) s.add(e.toLowerCase());
    return [...s].sort();
  }

  /**
   * Import a data file straight from a URL — the "every device" path for tablets/
   * phones where saving to a filesystem first is painful. Fetches the bytes host-
   * side (a real download, distinct from the consent-gated plugin `web.get`), so it
   * follows redirects; unwraps a `.zip` to the data file inside; then routes the
   * bytes to the codec matched by extension and runs the normal combine flow.
   *
   * Direct-fetch only: a cross-origin URL works when its server allows CORS (GitHub
   * "raw", jsDelivr, S3-with-CORS, many open-data portals). If it doesn't, the
   * browser blocks it and we say so — no third-party proxy is involved.
   */
  async #runUrlImport() {
    const url = await promptImportUrl(this.#knownExts());
    if (!url) return; // cancelled
    let resolved;
    try {
      const { blob, name } = await this.#download(url);
      resolved = await this.#resolveDownload(blob, name);
    } catch (err) {
      this.#results.appendError(`Import from URL failed: ${err.message}`);
      console.error('[import:url]', err);
      return;
    }
    await this.#dispatchFiles(resolved.spec, [resolved.file], resolved.id);
  }

  /** Fetch a user-supplied URL to a Blob + a best-guess filename. Host-side, follows
   * redirects (a plain download the user asked for — no plugin, no consent grant to
   * launder, so the plugin `web.get` redirect block doesn't apply here). */
  async #download(url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('please enter an http(s) URL.');
    let res;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (e) {
      throw new Error(
        `couldn’t reach the URL. The server may block cross-origin downloads (CORS) — ` +
          `try a direct/"raw" link, or download the file and use Import data…. (${e.message})`,
      );
    }
    if (!res.ok) throw new Error(`the server returned HTTP ${res.status}.`);
    const blob = await res.blob();
    return { blob, name: filenameFromResponse(res, url) };
  }

  /**
   * Turn a downloaded Blob into `{ file, spec, id }` ready for {@link #dispatchFiles}:
   * unwrap a `.zip` to the first data file a codec can handle, then match the codec
   * by extension. Throws (with a clear message) if nothing matches.
   */
  async #resolveDownload(blob, name) {
    let dataBlob = blob;
    let dataName = name;
    if (/\.zip$/i.test(name) || (await looksLikeZip(blob))) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const entries = (await readZipEntries(buf)).filter((e) => !e.name.endsWith('/'));
      const match = entries.find((e) => this.#importerForExt(extOf(e.name)));
      if (!match) {
        throw new Error(
          `the ZIP has no importable data file (looked for ${this.#knownExts().join(', ') || 'known formats'}).`,
        );
      }
      dataBlob = new Blob([match.data]);
      dataName = match.name.replace(/^.*[\\/]/, '');
    }
    const ext = extOf(dataName);
    const found = this.#importerForExt(ext);
    if (!found) {
      throw new Error(
        ext
          ? `no importer for "${ext}" files. Supported: ${this.#knownExts().join(', ') || '(none enabled)'}.`
          : `couldn’t tell the file type from the URL. Make sure it ends in a data extension ` +
            `(${this.#knownExts().join(', ') || 'e.g. .csv'}) or points to a .zip.`,
      );
    }
    const [id, spec] = found;
    return { file: new File([dataBlob], dataName), spec, id };
  }

  /**
   * Stream each file into the active dataset through a plugin **codec** (#98). The
   * codec's reader yields a catalog head (with a `wide` hint) then a stream of
   * column batches; the host commits via {@link DataStore#loadStreaming} normally, or
   * {@link DataStore#loadWide} (out-of-core single-Parquet, no DuckDB table) when the
   * codec flags an ultra-wide file — the GSS path. First file of a Replace creates
   * the source; the rest append.
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
              // MUST await: begin() is async (it creates the DuckDB ingester); without
              // the await, reader.drain() could deliver the first batch before the
              // ingester exists → "batch before begin()". Desktop usually won the race;
              // slower iPad Safari lost it (#91).
              await ctx.begin(head.variables, head.storageTypes);
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

  /**
   * Parse each file and commit it — the first of a Replace creates the table,
   * everything else stacks (append). Used for replace/append (not join).
   */
  async #importFiles(spec, files, mode, id) {
    if (spec.codec) return this.#importCodecFiles(spec, files, mode, id);
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
        joinType: review.joinType,
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
    if (mode === 'new') {
      // New dataset in this project; load as a replace into the fresh active one.
      this.#data.add(dataset.source || id || 'Imported data', { activate: true });
      mode = 'replace';
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

/** Lower-cased extension (with the dot) of a filename, or '' if none. Handles
 * digits so `.sas7bdat` matches. */
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

/** Best-guess download filename: the response's Content-Disposition if exposed,
 * else the last path segment of the URL, else 'download'. */
function filenameFromResponse(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
  } catch { /* fall through */ }
  return 'download';
}

/** True if the Blob starts with the ZIP local-file-header signature (`PK`). */
async function looksLikeZip(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b;
}

/**
 * Prompt for a data-file URL. Resolves to the trimmed URL, or null if cancelled.
 * @param {string[]} exts - Supported extensions, shown in the hint.
 * @returns {Promise<string|null>}
 */
function promptImportUrl(exts) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const list = exts && exts.length ? exts.join(', ') : '.csv, .sav, .dta, .parquet, …';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">Import from a web address</h2>
        <p class="ct-dialog__hint">Paste a direct link to a data file (${escapeText(list)}) — or a
          <code>.zip</code> containing one. The site must allow cross-origin downloads (most
          “raw”/open-data links do); if it doesn’t, download the file and use <strong>Import data…</strong>.</p>
        <label class="ct-dialog__row">
          <span>URL</span>
          <input type="url" class="ct-url__input" placeholder="https://…" autocomplete="off"
            spellcheck="false" style="flex:1 1 auto; min-width:340px;" />
        </label>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="button" class="ct-url__cancel">Cancel</button>
          <button value="ok" type="submit" class="ct-dialog__primary">Fetch</button>
        </menu>
      </form>`;
    const input = dialog.querySelector('.ct-url__input');
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      dialog.close();
    };
    dialog.querySelector('.ct-url__cancel').addEventListener('click', () => finish(null));
    dialog.querySelector('.ct-dialog__form').addEventListener('submit', (e) => {
      e.preventDefault();
      finish((input.value || '').trim() || null);
    });
    dialog.addEventListener('cancel', () => finish(null));
    dialog.addEventListener('close', () => { dialog.remove(); finish(null); });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

/** Minimal text escape for the one interpolation in the URL prompt. */
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Ask how an import should combine with the loaded data. Resolves to
 * `'replace'`, `'append'`, `'join'`, or `null` (cancelled). `'join'` is only
 * offered when `canJoin` (a single incoming dataset — joining a batch is
 * ambiguous).
 *
 * @param {number} fileCount
 * @param {boolean} [canJoin=false]
 * @returns {Promise<'replace'|'append'|'join'|'new'|null>}
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
        <p class="ct-dialog__hint">A dataset is already loaded. Open ${noun} as a new
          dataset in this project, add it to the current one (stack rows), join it on a
          key (add columns), or replace what's loaded?</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="replace" type="submit">Replace</button>
          ${joinBtn}
          <button value="new" type="submit">New dataset</button>
          <button value="append" type="submit" class="ct-dialog__primary">Add rows</button>
        </menu>
      </form>`;
    dialog.addEventListener('close', () => {
      const v = dialog.returnValue;
      dialog.remove();
      resolve(['append', 'replace', 'join', 'new'].includes(v) ? v : null);
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
 * `{ joinKey:{left,right}, aliases:[{base,incoming}], joinType }` or `null` if cancelled.
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
        <p class="ct-dialog__hint">Match your rows to the incoming rows by a key, and
          choose which unmatched rows to keep (the join type). Pair up any values that
          should match below.</p>
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
    // Join type: which side's unmatched rows to keep. Left preserves the current
    // behaviour (keep all current rows, blank new columns where no match).
    let joinType = 'left';
    const typeSel = document.createElement('select');
    typeSel.className = 'ct-join__type';
    for (const [v, label] of [
      ['left', 'Left outer — keep all current rows'],
      ['inner', 'Inner — keep only matched rows'],
      ['right', 'Right outer — keep all incoming rows'],
      ['full', 'Full outer — keep all rows from both'],
    ]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      typeSel.append(o);
    }
    typeSel.value = joinType;
    typeSel.addEventListener('change', () => { joinType = typeSel.value; });
    keysEl.append(
      document.createTextNode('Current '),
      baseSel,
      document.createTextNode(' ↔ incoming '),
      incSel,
      document.createTextNode('  ·  Join type: '),
      typeSel,
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
      resolve(ok ? { joinKey: { left: baseKey, right: incKey }, aliases, joinType } : null);
    });
    document.body.append(dialog);
    dialog.showModal();
    reloadBase();
  });
}
