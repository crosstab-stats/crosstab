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
 *  - The **destructive commit** into your loaded data — replace / append / join
 *    (`DataStore.loadDataset` with those modes). This is host-only and is never
 *    exposed to a plugin: in the default contract the plugin only *describes* the
 *    parsed data and the engine commits it, as part of a user-initiated import —
 *    so no plugin can replace or overwrite your active dataset unprompted.
 *
 *    A plugin *can* create **new** datasets (that is `app.data.create`, an
 *    additive capability any activated plugin already has — it can't touch an
 *    existing dataset) and write its **own** workspace state (`app.state.write`,
 *    owner-scoped: host-asserted identity + manifest-declared + reservation). A
 *    `selfCommit` importer (see {@link ImporterSpec}) uses exactly those to build
 *    its own dataset(s) instead of delivering one — so the engine still runs no
 *    merge and performs no `loadDataset`. The boundary is *additive vs
 *    destructive*, not *host vs plugin*: creating alongside your data is open;
 *    replacing your data is the engine's alone.
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
 * A `selfCommit` importer (`manifest.imports[].selfCommit`) inverts steps 4–5:
 * instead of delivering a dataset it *creates* its own via `app.data.create` +
 * `app.state.write` (e.g. a QDPX project → a new dataset with its own coding blob
 * + media), then delivers a **receipt** (any truthy value) purely to report
 * success. The engine shows no replace/append/join/new dialog and calls no
 * `loadDataset` — there is nothing to merge into your active data. Still additive
 * only; the destructive path above stays host-owned.
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

import { pickFiles } from './pick-file.js';
import { showFormatPicker, chooseFormat, groupFor, byGroupThenOrder } from './format-picker.js';
import { readZipEntries } from './zip.js';
import { isSelfContained, decryptSelfContained } from './crypto-envelope.js';
import { passphraseFor } from './at-rest.js';

/**
 * @typedef {Object} ImporterSpec
 * @property {string} label - Menu label, e.g. `'CSV…'` or `'SPSS / Stata / SAS…'`.
 * @property {'file'|'web'} [source='file'] - Where the data comes from. `'file'`
 *   importers parse an uploaded file (the engine opens a picker). `'web'`
 *   importers fetch their own bytes (e.g. a Wikipedia table) and get no file — the
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
 * @property {boolean} [selfCommit=false] - This importer **creates and commits its
 *   own dataset(s)** rather than delivering one for the host to load — e.g. a QDPX
 *   project that mints a new dataset with its own coding blob + media, or any
 *   archive that fans a file out into several datasets. For these the host runs no
 *   replace/append/join/new merge (there is nothing to merge into the active
 *   dataset) and performs no commit: `parse` does the committing via `app.data.*`
 *   / `app.state.write` and then **delivers a receipt** (any truthy value — a
 *   `{ name, rows }` is nice) to report success, or `null` to signal it aborted
 *   (having surfaced its own error). Just another declared contract, open to any
 *   plugin — no importer is privileged.
 */

import { escapeHtml } from './text.js';
import { estimateTableBytes } from './duckdb-manager.js';
import { debug, recordError } from './debug.js';
import { looksLikeZip as looksLikeZipBytes } from './plugin-package.js';

/**
 * The `selectFromList` options for the missing-value-code question, or null when there
 * is nothing to ask.
 *
 * Pure, and separate from the asking, because the arithmetic in the hint is the part
 * that can be wrong: see below.
 *
 * @param {string} fileName
 * @param {{candidates?: Array<{value: string, values: number, columns: number}>,
 *          combos?: Array<{codes: string[], columns: number}>, omitted?: number}} proposal
 * @returns {?object}
 */
export function missingCodesPrompt(fileName, proposal, { files = 1, selected = null } = {}) {
  const candidates = proposal?.candidates ?? [];
  if (!candidates.length) return null;
  const n = (x) => Number(x).toLocaleString();

  // What ticking EVERYTHING achieves. Computed from the blocker-set signatures rather
  // than by summing the per-value column counts, because a column blocked by BOTH codes
  // is recovered by neither alone — on the owner's file the per-value counts are 2,933
  // and 504, which sums to 3,437 for an answer that is 3,347.
  //
  // (Recomputing this live as each box is ticked is exactly what `combos` carries enough
  // information for. `selectFromList` has no hook for it, so this shows the all-ticked
  // figure — and the boxes all start ticked.)
  const all = (proposal?.combos ?? []).reduce((a, k) => a + k.columns, 0);

  const items = candidates.map((c) => ({
    value: c.value,
    label: `${c.value} — ${n(c.values)} values in ${n(c.columns)} columns`,
  }));
  return {
    title: 'Missing-value codes',
    // Naming one file while governing four would be a quiet lie, so it says which.
    hint: `These values appear in ${files > 1 ? `“${fileName}” and the other ${files - 1} file${files === 2 ? '' : 's'}` : `“${fileName}”`} where numbers are expected, and look like `
      + `missing-value codes. Ticked, they are read as missing${all ? `, which makes ${n(all)} more columns numeric` : ''}`
      + '. Unticked, they stay text — and so does every column containing them. '
      + 'Cancel imports everything as text.'
      + (proposal?.omitted ? ` (${n(proposal.omitted)} rarer values are not listed.)` : ''),
    items,
    multiple: true,
    // Pre-selected: the detector proposes, you dispose. On a later file in the same
    // import, `selected` carries what was already agreed so an existing answer is not
    // silently dropped by a prompt that only appeared because of a NEW code.
    selected: Array.isArray(selected) ? selected : items.map((i) => i.value),
    okLabel: 'Import',
  };
}

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
  /** UiService, for the questions an import has to ask. @type {?import('./ui-service.js').UiService} */
  #ui;

  /** Called after a SWAP lands and BEFORE the outgoing dataset is binned, so anything
   * attached to it (coding, analyses) can be offered a new home while it still exists
   * to be read from. `({fromId, toId}) => Promise<void>` (#151). */
  #onSwap;

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
  constructor({ menus, data, results, bus, webr, onSwap, ui }) {
    this.#menus = menus;
    this.#data = data;
    this.#results = results;
    this.#bus = bus;
    this.#webr = webr ?? null;
    this.#onSwap = onSwap ?? null;
    this.#ui = ui ?? null;
  }

  /**
   * Ask which recurring non-numeric values mean "missing", ONCE per import rather than
   * once per file.
   *
   * ## Why once
   *
   * Selecting four Scorecard years produced four identical prompts — tedious, but that is
   * not the reason this changed. Stacked sources are combined with `UNION ALL BY NAME`,
   * and DuckDB resolves a column that is DOUBLE in one source and VARCHAR in another by
   * casting to the common supertype: VARCHAR. So ticking the codes on files 1-2 and
   * declining on file 3 silently reverts every recovered column to text across the WHOLE
   * dataset — including the rows where they were accepted. No error, just the original
   * mistyping back over all 27,252 rows.
   *
   * Carrying one answer across the import makes that impossible by construction, which is
   * better than making it unlikely.
   *
   * ## Why it can still ask again
   *
   * Files genuinely differ — one of the owner's four offered a single code where the
   * others offered two — so "ask once and reuse" would be wrong for a file that
   * introduces a code nobody has been asked about. It is therefore asked again only for
   * values not yet offered, with what was already accepted pre-ticked and kept. A file
   * whose candidates are all old reuses the answer in silence.
   *
   * @param {string} fileName
   * @param {object} proposal - `{candidates, combos, omitted}` from the codec
   * @param {{accepted: Set<string>, offered: Set<string>, files: number}} run - per-import state
   * @returns {Promise<string[]>}
   */
  async #askMissingCodes(fileName, proposal, run) {
    const candidates = proposal?.candidates ?? [];
    const fresh = candidates.filter((c) => !run.offered.has(c.value));
    if (!fresh.length) {
      // Nothing new to decide. Reuse so the stack stays consistently typed.
      if (candidates.length) {
        debug('import', 'missing codes reused', { file: fileName, accepted: run.accepted.size });
      }
      return [...run.accepted];
    }

    const opts = missingCodesPrompt(fileName, proposal, {
      // Say so when the answer governs more than the file being named.
      files: run.files,
      // Previously accepted codes stay ticked; newly-found ones are proposed as usual.
      selected: candidates.map((c) => c.value).filter((v) => run.accepted.has(v) || !run.offered.has(v)),
    });
    if (!opts || !this.#ui?.selectFromList) return [...run.accepted];

    const chosen = await this.#ui.selectFromList(opts);
    for (const c of candidates) run.offered.add(c.value);
    // Cancel keeps what was already agreed rather than retracting it mid-import.
    if (Array.isArray(chosen)) {
      run.accepted.clear();
      for (const v of chosen) if (typeof v === 'string') run.accepted.add(v);
    }
    debug('import', 'missing codes', {
      file: fileName,
      offered: opts.items.length,
      fresh: fresh.length,
      accepted: run.accepted.size,
      cancelled: chosen == null,
    });
    return [...run.accepted];
  }

  /**
   * Ask which variables to import, once for the whole selection.
   *
   * ## Once, not once per file
   *
   * The same rule as `#askMissingCodes`, for the same reason: stacked sources are
   * combined with `UNION ALL BY NAME`, so a different answer for the second file does not
   * import a different subset — it retypes or hollows out the first one. So the FIRST
   * file's catalog is what is offered, and the answer governs every file in the run. The
   * prompt says so when there is more than one.
   *
   * ## When the codec cannot answer, say so
   *
   * A format that cannot name its variables without reading everything does not declare
   * `catalog`, and the honest response is a note rather than silence: the user ticked a
   * box and is entitled to know it did nothing. Silently importing all 3,379 columns
   * after being asked to choose is the failure mode this avoids.
   *
   * @param {object} spec - the importer spec (carries `readCatalog` when supported)
   * @param {File} file - the first file of the run; its catalog is the one offered
   * @param {{names: ?string[], asked: boolean, files: number}} run - carried across files
   * @returns {Promise<?string[]>} the chosen names, or null for "import everything"
   */
  async #pickVariables(spec, file, run) {
    if (run.asked) return run.names;
    run.asked = true;
    // Normally unreachable: `#runImport` turns the option off and explains itself before
    // getting here, because the picker also lists importers that never reach this path at
    // all. Kept as the guard for any OTHER caller, silent because the explaining has
    // already been done once and twice would be worse than not at all.
    if (typeof spec.readCatalog !== 'function') return null;
    let cat;
    try {
      cat = await spec.readCatalog(file);
    } catch (err) {
      // A failed catalog must not sink the import: it is an optional convenience, and
      // everything still works without it.
      this.#results.appendError(
        `Could not list the variables in ${file.name} (${err?.message ?? err}). Importing all of them.`,
      );
      return null;
    }
    const variables = cat?.variables ?? [];
    if (!variables.length) {
      this.#results.appendText(`No variables could be listed in ${file.name}; importing all of them.`);
      return null;
    }
    if (!this.#ui?.selectFromList) return null;

    const rows = Number(cat.rowCount ?? -1);
    const chosen = await this.#ui.selectFromList({
      title: `Choose variables — ${file.name}`,
      hint: `${variables.length.toLocaleString()} variables`
        + (rows >= 0 ? ` · ${rows.toLocaleString()} rows` : '')
        + '. Pick the ones to import (search to filter).'
        + (run.files > 1 ? ` This choice applies to all ${run.files} files.` : ''),
      items: variables.map((v) => ({
        value: v.name,
        label: v.label ? `${v.label} (${v.name})` : v.name,
      })),
      multiple: true,
      // Everything ticked: the dialog's job is to let a subset be chosen, not to make
      // choosing mandatory, and an all-unticked list reads as "nothing will import".
      selected: variables.map((v) => v.name),
      okLabel: 'Import selected',
      searchPlaceholder: 'Filter by name or label…',
    });
    // Cancel means cancel the import, not "import everything" — the user asked to choose.
    if (chosen == null) throw new Error('Import cancelled.');
    if (!chosen.length) throw new Error('No variables were selected, so nothing was imported.');
    run.names = chosen.length === variables.length ? null : chosen;
    debug('import', 'variable pick', {
      importer: spec.id ?? spec.label,
      available: variables.length,
      chosen: chosen.length,
      // null means "all of them", which is worth distinguishing in the log from a
      // selection that happens to cover everything.
      narrowed: run.names !== null,
    });
    return run.names;
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
    // `readCatalog` is optional and its ABSENCE is meaningful — it is how the host tells
    // "this format cannot name its variables without reading the data" from "the user did
    // not ask to choose". See `#pickVariables`.
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
        command: (opts) => void this.#runImport(id, opts),
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
      // Open a passphrase-protected export (#144). Format-agnostic: it wraps ANY
      // exported format, so after decrypting we recover the inner format from the
      // filename (exports are named `<original>.enc`) and route to the real importer.
      entries.push({
        id: 'core:import-enc',
        label: 'Encrypted CrossTab file (.enc)…',
        extensions: ['.enc'],
        group: 'Encrypted files',
        order: -1,
        command: () => void this.#runEncImport(),
      });
      entries.sort(byGroupThenOrder);
    }
    showFormatPicker({
      title: 'Import data',
      hint: 'Choose a format to import. Type to filter.',
      emptyText: 'No import formats are enabled. Turn some on in the plugin manager.',
      entries,
      // One capability, offered for every format, instead of a second menu item for the
      // one codec that happened to implement it. "SPSS / Stata / SAS — choose variables…"
      // was a real feature behind an arbitrary door: picking 50 of the GSS's 7,000
      // variables was possible, and the same thing on a 3,379-column CSV was not.
      options: [{
        id: 'pick',
        label: 'Choose which variables to import',
        hint: 'Lists the variables first, so you can import a subset of a wide file.',
      }],
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
  async #runImport(id, pickerOptions = {}) {
    const spec = this.#importers.get(id);
    if (!spec) return;
    // The checkbox is on the picker, which lists every importer — including web sources
    // that fetch their own bytes and legacy `parse`-based importers that never reach the
    // codec path. Ticking it for one of those used to do nothing and say nothing, which
    // is the exact failure `#pickVariables` exists to avoid, one layer up. Checked HERE,
    // before the branch, so there is one answer for all three kinds.
    let options = pickerOptions;
    if (options.pick && typeof spec.readCatalog !== 'function') {
      this.#results.appendText(
        `${spec.label ?? 'This format'} cannot list its variables without reading the whole file, `
        + 'so everything will be imported. (Drop the columns you do not want afterwards.)',
      );
      debug('import', 'variable pick unsupported', { importer: spec.id ?? spec.label });
      options = { ...options, pick: false };
    }
    if (spec.source === 'web') return this.#runWebImport(id, spec);

    let files;
    try {
      files = await pickFiles(spec.extensions, spec.multiple === true);
    } catch (err) {
      this.#results.appendError(`Import: could not open file picker: ${err.message}`);
      return;
    }
    if (!files.length) return; // user cancelled
    // Safety net: a self-contained encrypted export (.enc) can be chosen under any
    // format if the OS picker allowed it. Decrypt + reroute rather than feeding
    // ciphertext to the wrong parser. (The "Encrypted CrossTab file…" entry is the
    // discoverable path; this catches the picked-it-anyway case.)
    if (files.length === 1 && (await looksEncrypted(files[0]))) {
      return this.#decryptAndDispatch(files[0]);
    }
    await this.#dispatchFiles(spec, files, id, options);
  }

  /**
   * Given resolved file(s) + their importer, run the combine flow: straight import
   * when nothing is loaded, else ask replace / add rows / join / new dataset. Shared
   * by the file-picker path ({@link #runImport}) and the URL path
   * ({@link #runUrlImport}) so both behave identically once the bytes are in hand.
   */
  async #dispatchFiles(spec, files, id, pickerOptions = {}) {
    // A self-committing importer owns its own dataset creation (QDPX → new dataset
    // + coding blob + media; any multi-dataset archive). There is nothing to merge
    // into the active dataset, so the replace/append/join/new dialog would be a
    // meaningless prompt — skip it and let each file's parse commit itself.
    if (spec.selfCommit) return this.#runSelfCommit(spec, files, id);
    // No data loaded → straight import (no mode dialog). Data loaded → ask how to
    // combine; join is offered only for a single incoming file.
    if (this.#data.rowCount === 0) {
      await this.#importFiles(spec, files, 'replace', id, pickerOptions);
      // An importer that declares a collection name (e.g. media → "Images") shouldn't
      // leave the dataset as the blank boot seed's "Dataset 1".
      if (spec.datasetName && this.#data.activeId != null) {
        this.#data.rename(this.#data.activeId, spec.datasetName);
      }
      return;
    }
    // Join needs inline columns to preview matches; a streaming codec delivers
    // none, so it offers only replace/append.
    const mode = await askMode(files.length, files.length === 1 && !spec.codec);
    if (!mode) return; // cancelled
    if (mode === 'join') {
      await this.#importJoin(spec, files[0], id);
    } else if (mode === 'new' || mode === 'swap') {
      // Import into a brand-new dataset in this project. `new` leaves the current one
      // alone; `swap` inherits its name and bins it afterwards (#149 A7/A8a) — the
      // honest form of the old in-place "replace", which destroyed the rows under a
      // still-live dataset id.
      const outgoing = mode === 'swap' ? this.#data.activeId : null;
      const outgoingName = outgoing != null ? (this.#data.list().find((d) => d.id === outgoing)?.name ?? null) : null;
      // An importer that names its collection (media → "Images") wins over the
      // single-file basename, which would misname a media dataset after one photo.
      const name = outgoingName
        ?? spec.datasetName
        ?? (files.length === 1 ? baseName(files[0].name) : 'Imported data');
      this.#data.add(name, { activate: true });
      await this.#importFiles(spec, files, 'replace', id, pickerOptions);
      // Offer to bring across whatever was attached to the outgoing dataset — BEFORE it
      // is binned, while its records and rows can still be read. This is the moment the
      // work would otherwise be quietly orphaned, which is why the offer belongs here
      // rather than only behind a menu item somebody has to know to look for (#151).
      if (outgoing != null && this.#onSwap) {
        try {
          await this.#onSwap({ fromId: outgoing, toId: this.#data.activeId });
        } catch (err) {
          // An import that succeeded must not be reported as failed because the
          // follow-up offer stumbled.
          this.#results?.appendError?.(`Couldn’t move the previous dataset’s coding: ${err.message}`);
        }
      }
      // Bin the outgoing dataset only after the import lands, so a failed import never
      // costs the user the data they still have.
      if (outgoing != null) await this.#data.remove(outgoing);
    } else {
      await this.#importFiles(spec, files, mode, id, pickerOptions);
    }
  }

  /** Registered file (non-`web`) importers as `[id, spec]` pairs. */
  #fileImporters() {
    return [...this.#importers.entries()].filter(([, s]) => s.source !== 'web');
  }

  /** All file importers that handle `ext` (with the dot, lower-case). More than one
   * can claim an extension (e.g. `.txt` = CSV table vs text-as-data). */
  #importersForExt(ext) {
    return this.#fileImporters().filter(([, spec]) =>
      (spec.extensions || []).some((e) => e.toLowerCase() === ext),
    );
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
      this.#failed(`Import from URL failed: ${err.message}`, err, 'import:url');
      console.error('[import:url]', err);
      return;
    }
    if (!resolved) return; // user cancelled the format chooser
    await this.#dispatchFiles(resolved.spec, [resolved.file], resolved.id);
  }

  /**
   * Open a passphrase-protected export (`.enc`, #144) — the receiving end of the
   * default-on export encryption. Pick the file, then decrypt + route via the shared
   * {@link #decryptAndDispatch}.
   */
  async #runEncImport() {
    let files;
    try {
      files = await pickFiles(['.enc'], false);
    } catch (err) {
      this.#results.appendError(`Import: could not open file picker: ${err.message}`);
      return;
    }
    if (!files.length) return; // cancelled
    await this.#decryptAndDispatch(files[0]);
  }

  /**
   * Decrypt a self-contained encrypted export and hand the plaintext to the normal
   * import flow. The inner format is recovered from the filename (an export is named
   * `<original>.enc`, e.g. `study.csv.enc` → `study.csv`); {@link #resolveDownload}
   * then unwraps a `.zip` if needed and matches the importer by extension, offering a
   * chooser when the name is ambiguous. A wrong passphrase fails cleanly (AES-GCM
   * auth) — the file's contents never reach a parser.
   * @param {File} encFile
   */
  async #decryptAndDispatch(encFile) {
    let raw;
    try {
      raw = new Uint8Array(await encFile.arrayBuffer());
    } catch (err) {
      this.#results.appendError(`Couldn’t read “${encFile.name}”: ${err.message}`);
      return;
    }
    if (!isSelfContained(raw)) {
      this.#results.appendError(`“${encFile.name}” isn’t an encrypted CrossTab file.`);
      return;
    }
    const pass = await passphraseFor('open-export', { filename: encFile.name });
    if (!pass) return; // cancelled — nothing decrypted
    let plain;
    try {
      plain = await decryptSelfContained(pass, raw);
    } catch {
      this.#results.appendError('Wrong passphrase — couldn’t decrypt the file. Run Import again to retry.');
      return;
    }
    const innerName = encFile.name.replace(/\.enc$/i, '') || 'data';
    let resolved;
    try {
      resolved = await this.#resolveDownload(new Blob([plain]), innerName);
    } catch (err) {
      this.#results.appendError(`Import failed: ${err.message}`);
      console.error('[import:enc]', err);
      return;
    }
    if (!resolved) return; // user cancelled the format chooser
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
      const match = entries.find((e) => this.#importersForExt(extOf(e.name)).length);
      if (!match) {
        throw new Error(
          `the ZIP has no importable data file (looked for ${this.#knownExts().join(', ') || 'known formats'}).`,
        );
      }
      dataBlob = new Blob([match.data]);
      dataName = match.name.replace(/^.*[\\/]/, '');
    }
    const chosen = await this.#resolveImporter(extOf(dataName), dataName);
    if (chosen === null) return null; // user cancelled the chooser
    const [id, spec] = chosen;
    return { file: new File([dataBlob], dataName), spec, id };
  }

  /**
   * Pick the importer for a downloaded file. One claimant → use it. Several claim the
   * extension → let the user choose (a `.txt` can be a CSV table or text-as-data).
   * Extension unknown/unmatched → offer the full list rather than dead-ending (a URL
   * may end in `/download` or `.php` yet still be a CSV). Returns `[id, spec]`, or
   * `null` if the user cancels. Throws only when no importer could possibly apply.
   *
   * @param {string} ext - Lower-cased extension with the dot, or '' if none.
   * @param {string} dataName - The file's display name, for the chooser hint.
   * @returns {Promise<[string, object]|null>}
   */
  async #resolveImporter(ext, dataName) {
    const matches = ext ? this.#importersForExt(ext) : [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const entry = await chooseFormat({
        title: 'Choose a format',
        hint: `More than one importer reads “${ext}”. Which should open ${dataName}?`,
        entries: matches.map(([id, spec]) => ({ id, label: spec.label, extensions: spec.extensions })),
      });
      return entry ? matches.find(([id]) => id === entry.id) : null;
    }
    const all = this.#fileImporters();
    if (all.length === 0) throw new Error('no import formats are enabled.');
    const entry = await chooseFormat({
      title: 'Choose a format',
      hint: ext
        ? `No importer is registered for “${ext}”. Pick the format ${dataName} really is:`
        : `Couldn’t tell ${dataName}’s format from the URL. Pick the format it is:`,
      entries: all.map(([id, spec]) => ({ id, label: spec.label, extensions: spec.extensions })),
    });
    return entry ? all.find(([id]) => id === entry.id) : null;
  }

  /**
   * Stream each file into the active dataset through a plugin **codec** (#98). The
   * codec's reader yields a catalog head (with a `wide` hint) then a stream of
   * column batches; the host commits via {@link DataStore#loadStreaming} normally, or
   * {@link DataStore#loadWide} (out-of-core single-Parquet, no DuckDB table) when the
   * codec flags an ultra-wide file — the GSS path. First file of a Replace creates
   * the source; the rest append.
   */
  async #importCodecFiles(spec, files, mode, id, pickerOptions = {}) {
    let committed = 0;
    // One answer for the whole selection: see `#askMissingCodes`. Stacked sources are
    // UNIONed BY NAME, so an inconsistent answer across files silently retypes the lot.
    const codeRun = { accepted: new Set(), offered: new Set(), files: files.length };
    // Asked once, before the first read, and reused for the rest — see `#pickVariables`.
    const pickRun = { names: null, asked: !pickerOptions.pick, files: files.length };
    for (const file of files) {
      const fileMode = mode === 'replace' && committed === 0 ? 'replace' : 'append';
      const tag = mode === 'replace' && files.length === 1 ? undefined : baseName(file.name);
      this.#bus.emit('import:started', { importer: id, file: file.name });
      // Outside the try so the catch can say how far the ingest got. The OOM that
      // started all this is thrown by the CONSUMER — `ctx.batch` below, inside DuckDB —
      // not by the codec, so the codec's own promise never settles and the log line on
      // it never ran. "Died after N rows" is the number that distinguishes a table that
      // could not be created from an ingest that ran out of room.
      let seen = 0;
      try {
        // Before `startRead`, because the chosen subset is an input to the read: a codec
        // that can skip columns should never decode them, and one that cannot at least
        // never stores them.
        const select = await this.#pickVariables(spec, file, pickRun);
        const reader = spec.startRead(file, { select });
        // Registered BEFORE begin(): a codec's first pass runs before it can declare
        // its variables, and on a large file that pass is most of the wait.
        const progress = this.#progressEmitter(file.name);
        reader.onProgress?.((done, total) => progress(done, total));
        // Same reason, and it must be the same side of begin(): the codec asks during
        // pass 1, because the answer decides the types it declares IN begin().
        reader.onMissingCodes?.((proposal) => this.#askMissingCodes(file.name, proposal, codeRun));
        const head = await reader.begin();
        const tick = (columns) => {
          const k = Object.keys(columns)[0];
          seen += k ? columns[k].length : 0;
          progress(seen, head.rowCount);
        };
        // The codec decides "wide" from the FILE. The ceiling it protects — DuckDB-WASM's
        // checkpoint, which cannot accumulate past ~600 MB and cannot spill — belongs to
        // the DATABASE, so a run of individually-modest imports walks into it together.
        // Three Scorecard years did exactly that (owner, 2026-11-18): every row ingested,
        // then `Failed to create checkpoint: Out of Memory Error` — which is FATAL, so
        // the two tables that had already loaded died with it.
        // NOT optional-called. The first version wrote `wouldExceedTableBudget?.(…)`,
        // the method was never forwarded through DatasetManager, and `?.` turned a
        // missing wiring into a silent `false` — so the budget reported `loadedMiB: 0`
        // for three imports running and the third FATAL-ed exactly as it had before the
        // budget existed. A guard that quietly neutralises the feature it guards is
        // worse than the crash it was meant to prevent.
        const overBudget = !head.wide && await this.#data.wouldExceedTableBudget(head.variables, head.rowCount);
        const wide = head.wide || overBudget;
        // Everything the decision was made FROM, not just what it decided. Two runs were
        // spent reasoning about `canStream` from the outside when printing it would have
        // ended the question — a log line that reports a verdict without its inputs
        // invites exactly that.
        debug('import', 'route', {
          wide,
          declaredWide: head.wide,
          overBudget,
          loadedMiB: Math.round((this.#data.loadedTableBytes ?? 0) / 1048576),
          estMiB: Math.round(estimateTableBytes(head.variables, head.rowCount) / 1048576),
          canStream: this.#data.canStreamOutOfCore,
        });
        if (wide) {
          await this.#data.loadWide({
            mode: fileMode,
            source: tag,
            variables: head.variables,
            rowCount: head.rowCount,
            missingCodes: head.missingCodes,
            onProgress: (done) => progress(done, head.rowCount),
            // RETURN onBatch's promise: `drain` awaits the callback, so this is the whole
            // backpressure chain for the streaming Parquet write. Dropping it would let
            // every row group's OPFS write race, which is the bug this path exists to avoid.
            stream: (onBatch) => reader.drain((columns) => { tick(columns); return onBatch(columns); }),
          });
        } else {
          await this.#data.loadStreaming({
            mode: fileMode,
            source: tag,
            missingCodes: head.missingCodes,
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
        debug('import', 'FAILED', { rowsIngested: seen, message: String(err?.message ?? err).slice(0, 200) });
        this.#failed(`Import of "${file.name}" failed: ${err.message}`, err, 'import:file');
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
  /**
   * A throttled `import:progress` emitter for one file.
   *
   * The total arrives per CALL rather than up front, because the first thing a codec
   * does may be the long thing: a CSV has to scan the file before it can say how many
   * rows are in it, and that scan is exactly the stretch that used to show nothing.
   * So a codec reports `(rowsSoFar, -1)` while it is still counting and
   * `(rowsSoFar, total)` once it knows.
   */
  #progressEmitter(fileName) {
    let last = 0;
    return (done, total = -1) => {
      if (done - last >= 1000 || (total >= 0 && done >= total)) {
        last = done;
        this.#bus.emit('import:progress', { file: fileName, done, total });
      }
    };
  }

  /**
   * Run a **self-committing** importer (`spec.selfCommit`): the plugin creates and
   * commits its own dataset(s) — the host neither merges nor loads. We just invoke
   * `parse` per file (inside the started/ended progress bracket) and treat its
   * delivered receipt as the success signal: any truthy value counts as committed,
   * `null` means the importer aborted (and already reported why). No mode dialog,
   * no `loadDataset`.
   */
  async #runSelfCommit(spec, files, id) {
    let committed = 0;
    for (const file of files) {
      this.#bus.emit('import:started', { importer: id, file: file.name });
      try {
        const receipt = await this.#parseOne(spec, file);
        if (receipt) committed += 1; // null/undefined/false = aborted (self-reported)
      } catch (err) {
        this.#failed(`Import of "${file.name}" failed: ${err.message}`, err, 'import:file');
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
   * Parse each file and commit it — the first of a Replace creates the table,
   * everything else stacks (append). Used for replace/append (not join).
   */
  async #importFiles(spec, files, mode, id, pickerOptions = {}) {
    if (spec.codec) return this.#importCodecFiles(spec, files, mode, id, pickerOptions);
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
        // `source` is the provenance COLUMN's value and stays absent on a clean
        // single-file replace; `origin` is the filename, and is always recorded.
        await this.#data.loadDataset({ ...dataset, mode: fileMode, source: tag, origin: file.name, importer: id });
        committed += 1;
      } catch (err) {
        this.#failed(`Import of "${file.name}" failed: ${err.message}`, err, 'import:file');
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
   * Report a failure that was caught here: on screen, and into the always-on error slot.
   *
   * `appendError` alone is not enough. A handled error never reaches the global capture
   * in debug.js, and that capture is the only thing that fills the single `lastError`
   * slot a bug report carries — so the most common real failure in the app was the one
   * failure a report could never describe. The owner's 3.1 GiB OOM on a 67 MB CSV
   * reached the results pane, was read aloud off the screen, and the debug export
   * exported from the same session said `lastError: null`.
   *
   * `where` is a STATIC label, never a filename: it travels into a world-readable issue
   * via `collectDiagnostics`, where a file path counts as the user's data (and
   * help-bug-report.test.mjs asserts as much).
   *
   * @param {string} message - what the user sees
   * @param {any} err - the caught error
   * @param {string} where - a short static hint, e.g. `'import:file'`
   */
  #failed(message, err, where) {
    recordError(err, where);
    this.#results.appendError(message);
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
      this.#failed(`Import of "${file.name}" failed: ${err.message}`, err, 'import:join');
      return;
    }
    const review = await this.#reviewAndJoin(dataset, baseName(file.name), id, file.name);
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
   * `dataset.source` (e.g. a Wikipedia article title).
   */
  async #runWebImport(id, spec) {
    let dataset;
    try {
      dataset = await this.#awaitTicket((ticket) => spec.parse({ ticket }));
    } catch (err) {
      this.#failed(`Import failed: ${err.message}`, err, 'import:web');
      console.error('[import]', err);
      return;
    }
    // A self-committing web importer delivers a receipt, not a dataset: it already
    // created + committed its own data, so there's nothing to merge — just report.
    if (spec.selfCommit) {
      if (dataset) this.#emitFinished(id, 1);
      return;
    }
    // null / empty = the importer aborted (and reported its own error).
    if (!dataset || !Array.isArray(dataset.variables) || dataset.variables.length === 0) {
      return;
    }

    // A web import has no file, so its origin is whatever the importer can say about
    // where the rows came from — a Wikipedia article title, say. Better than nothing,
    // and better than inventing a filename that is on nobody's disk.
    const origin = dataset.source ?? null;

    let mode = 'replace';
    if (this.#data.rowCount > 0) {
      mode = await askMode(1, true);
      if (!mode) return; // cancelled
    }
    if (mode === 'join') {
      const ok = await this.#reviewAndJoin(dataset, dataset.source ?? id, id, origin);
      if (ok) this.#emitFinished(id, 1);
      return;
    }
    let outgoing = null;
    if (mode === 'new' || mode === 'swap') {
      // New dataset in this project; load as a replace into the fresh (empty) one.
      // `swap` additionally inherits the outgoing dataset's name and bins it (#149 A7).
      if (mode === 'swap') outgoing = this.#data.activeId;
      const outgoingName = outgoing != null ? (this.#data.list().find((d) => d.id === outgoing)?.name ?? null) : null;
      this.#data.add(outgoingName || dataset.source || id || 'Imported data', { activate: true });
      mode = 'replace';
    }
    // A clean single-source replace stays untagged; an append carries provenance
    // (the plugin's own label, falling back to the id).
    const tag = mode === 'replace' ? undefined : dataset.source ?? id;
    try {
      await this.#data.loadDataset({ ...dataset, mode, source: tag });
    } catch (err) {
      this.#failed(`Import failed: ${err.message}`, err, 'import:load');
      console.error('[import]', err);
      return;
    }
    // Only once the new data is in: bin the dataset it replaced.
    if (outgoing != null) await this.#data.remove(outgoing);
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
/**
 * A Blob-shaped wrapper over the ONE PK-magic check (`plugin-package.js`), which takes
 * bytes. This used to be a second copy of the two-byte comparison — the same question
 * asked twice, so only the reading of the bytes differs now.
 */
async function looksLikeZip(blob) {
  return looksLikeZipBytes(new Uint8Array(await blob.slice(0, 2).arrayBuffer()));
}

/** True if the file begins with the self-contained encrypted-export magic (#144),
 * so it can be rerouted to decryption regardless of the chosen format. Reads a
 * prefix long enough to clear isSelfContained's minimum-header length guard (any
 * real envelope is far larger; a file too short to hold the header can't be one). */
async function looksEncrypted(file) {
  try {
    return isSelfContained(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  } catch {
    return false;
  }
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
        <p class="ct-dialog__hint">Paste a direct link to a data file (${escapeHtml(list)}) — or a
          <code>.zip</code> containing one. The site must allow cross-origin downloads (most
          “raw”/open-data links do); if it doesn’t, download the file and use <strong>Import data…</strong>.</p>
        <label class="ct-dialog__row">
          <span>URL</span>
          <input type="url" class="ct-url__input" placeholder="https://…" autocomplete="off"
            spellcheck="false" style="flex:1 1 auto; min-width:min(340px, 100%);" />
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


/**
 * Ask how an import should combine with the loaded data. Resolves to
 * `'swap'`, `'append'`, `'join'`, `'new'`, or `null` (cancelled). `'join'` is only
 * offered when `canJoin` (a single incoming dataset — joining a batch is ambiguous).
 *
 * There is deliberately **no in-place replace** (#149 A7/A8a). Clearing a live dataset
 * and refilling it kept the dataset's id while destroying the rows underneath it, which
 * stranded everything keyed to that id — a CAQDAS codebook stayed attached with its
 * segments anchored to `__ct_rid` values that no longer existed, and the outgoing data
 * had no durable recovery. `'swap'` gives the same one-click gesture honestly: import
 * into a NEW dataset that inherits the old one's name, then bin the old one (recoverable,
 * and its coding stays valid because its rows still exist).
 *
 * @param {number} fileCount
 * @param {boolean} [canJoin=false]
 * @returns {Promise<'swap'|'append'|'join'|'new'|null>}
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
          key (add columns), or swap it in for what's loaded (the current dataset keeps
          its data and moves to the bin, where you can restore it)?</p>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="swap" type="submit">Swap in (old one goes to the bin)</button>
          ${joinBtn}
          <button value="new" type="submit">New dataset</button>
          <button value="append" type="submit" class="ct-dialog__primary">Add rows</button>
        </menu>
      </form>`;
    dialog.addEventListener('close', () => {
      const v = dialog.returnValue;
      dialog.remove();
      resolve(['append', 'swap', 'join', 'new'].includes(v) ? v : null);
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
          // Glyph-only and destructive: without a name this is just "button".
          x.setAttribute('aria-label', `Remove the match ${a.base} to ${a.incoming}`);
          x.title = 'Remove this column match';
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
