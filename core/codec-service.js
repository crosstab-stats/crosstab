/**
 * @file codec-service.js
 * Streaming format-codec registry (#98).
 *
 * A *codec* teaches CrossTab one file format, end to end: a `read` that decodes a
 * file into the dataset and/or a `write` that encodes the dataset into bytes. It's
 * the third extension point alongside analyses and workspaces — and, like those,
 * it's just a plugin. The host owns only what the security model forces it to (the
 * File-menu entries, the file picker, the OPFS/DuckDB plumbing, the download); the
 * codec owns the *format logic* and runs sandboxed.
 *
 * ## Why a streaming contract (not the one-shot importer/exporter)
 * The declarative `imports`/`exports` deliver/return a whole dataset in one blob —
 * fine for small files, but it can't survive a multi-GB .sav. A codec instead
 * *streams*: on read it pushes row batches into the host's streaming ingest (the
 * same OPFS-Parquet-parts pump ReadStat uses); on write it pulls rows in batches
 * and emits byte chunks. So the host never has to hold the whole thing.
 *
 * ## The `app.codec` surface (only live during a codec invocation)
 *  - read:  `read(offset,len)` / `size()` — random access to the source file bytes
 *           (host does `Blob.slice`, so a >2 GB file is never cloned whole);
 *           `begin(variables, storageTypes)` then `batch(columns)` — push schema +
 *           row batches into the active streaming ingest.
 *  - write: pull data via the normal `app.data.*`; `writeChunk(bytes)` — append
 *           output bytes the host streams to the download.
 *  - both:  `loadAsset(name)` — fetch a dependency (a JS lib's source, or WASM
 *           bytes) the sandbox can't fetch itself (`connect-src 'none'`). Resolves
 *           in two tiers: first the calling plugin's own **declared** assets (from
 *           its `.ctplugin` bundle or a same-origin sibling of its entry URL — the
 *           no-lock-in path, #119), then the host's narrow shared-library allowlist
 *           ({@link ASSETS}). A codec can't pull arbitrary code or reach off-origin.
 *
 * The session is a single mutable slot: codec import/export are user-initiated and
 * strictly serial, so there's never more than one in flight.
 */

import { debug } from './debug.js';

/**
 * Host-vetted **shared-library** assets — the narrow allowlist of dependencies the
 * *host* provides to any codec, kept ONLY for CrossTab's own shared runtimes/libs
 * (e.g. the hyparquet Parquet engine). A plugin that needs its *own* dependencies
 * bundles them and declares them in its manifest — those resolve per-plugin via
 * {@link PluginLoader#resolveAsset} (its bundle or a same-origin sibling of its
 * entry URL), NOT here (#119). So a codec can neither request arbitrary code from
 * the host nor reach off-origin: the host only knows these few vetted URLs, and
 * per-plugin assets only resolve from the plugin's own author-controlled origin.
 *
 * esm.sh `?bundle` gives a single self-contained module (no external imports),
 * required because the sandbox imports it from a `blob:` URL.
 *
 * @type {Object<string, {url: string, kind: 'text'|'bytes'}>}
 */
const ASSETS = {
  // `?bundle&target=es2022` inlines all deps into one self-contained module (no
  // cross-origin sub-imports) — required because the sandbox imports it from a
  // `blob:` URL and can't fetch anything itself. Same pattern the vendor script uses.
  hyparquet: { url: 'https://esm.sh/hyparquet@1?bundle&target=es2022', kind: 'text' },
  'hyparquet-writer': { url: 'https://esm.sh/hyparquet-writer@0.16.1?bundle&target=es2022', kind: 'text' },
  // SheetJS (Excel .xlsx/.xls) for builtin-excel-codec. 0.18.5 is the last version
  // published to npm (SheetJS later self-host only), so esm.sh mirrors it; `?bundle`
  // inlines its deps into one self-contained module the sandbox blob-imports.
  xlsx: { url: 'https://esm.sh/xlsx@0.18.5?bundle&target=es2022', kind: 'text' },
};

/** What `app.codec`'s ingest verbs do during a `catalog` call: refuse, by name. A sink
 * of no-ops would let a codec "declare variables" into a void and look like it worked. */
const CATALOG_SINK = Object.freeze({
  begin: () => { throw new Error('app.codec.begin is not available in a catalog call — return {variables} instead'); },
  batch: () => { throw new Error('app.codec.batch is not available in a catalog call — a catalog carries no data'); },
  progress: () => {},
  missingCodes: async () => [],
});

/**
 * Both catalogue shapes, as one list of sources.
 *
 * A codec with a single table may answer `{variables, rowCount}` — which is what CSV,
 * JSON Lines, Parquet and readstat do, and what they should keep doing: a format with
 * nothing to choose between should not have to invent a source id to say so. One that
 * holds several answers `{sources: [...]}`.
 *
 * Normalising HERE rather than in each codec is the point: every codec that gained a
 * catalogue before this existed keeps working untouched, and the host downstream has
 * exactly one shape to reason about.
 *
 * @param {any} out - whatever the codec returned
 * @param {string} fileName - names the implicit single source, so the picker's heading
 *   reads as the file rather than as an invented word like "default"
 */
function normaliseCatalog(out, fileName) {
  const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((v) => v && typeof v.name === 'string')
    .map((v) => ({ name: v.name, ...(v.label ? { label: String(v.label) } : {}) }));

  if (Array.isArray(out?.sources)) {
    return out.sources
      .map((src, i) => ({
        // An id is what a selection is keyed by and what the read is told to open, so it
        // must exist even if the codec forgot one.
        id: String(src?.id ?? src?.label ?? `source-${i + 1}`),
        label: String(src?.label ?? src?.id ?? `Source ${i + 1}`),
        rowCount: Number(src?.rowCount ?? -1),
        variables: clean(src?.variables),
      }))
      .filter((src) => src.variables.length);
  }
  const variables = clean(out?.variables);
  if (!variables.length) return [];
  return [{ id: '', label: fileName, rowCount: Number(out?.rowCount ?? -1), variables }];
}

/**
 * The variable list for a codec that holds ONE table, out of whatever plan the host made.
 *
 * A single-source catalogue is keyed by the empty string (see `normaliseCatalog`), so the
 * plan for a flat format has exactly one entry and this is its value. For a multi-source
 * plan there is no single answer and the codec is expected to read `plan.sources`
 * instead — returning the first source's list would silently narrow a workbook's second
 * sheet to the first sheet's columns, which is the sort of help nobody wants.
 *
 * @param {?{sources: Object<string, ?string[]>}} plan
 * @returns {?string[]} names, or null for "everything"
 */
function flatSelect(plan) {
  const entries = Object.entries(plan?.sources ?? {});
  if (entries.length !== 1) return null;
  const [id, names] = entries[0];
  return id === '' ? names ?? null : null;
}

export class CodecService {
  /** @type {import('./import-service.js').ImportService} */
  #importers;
  /** @type {import('./export-service.js').ExportService} */
  #exporters;
  /** PluginLoader, to invoke a codec's named read/write function. */
  #loader;
  /** ResultsPane#api, for surfacing codec errors. @type {{appendError: Function}} */
  #results;

  /** id → { spec, disposers[] }. @type {Map<string, object>} */
  #codecs = new Map();

  /** The in-flight codec invocation, or null. Read verbs bind to `file`+`ctx`;
   * write verbs bind to `chunks`. @type {?object} */
  #session = null;

  /** name → fetched asset (cached). @type {Map<string, string|Uint8Array>} */
  #assetCache = new Map();

  /**
   * @param {Object} deps
   * @param {import('./import-service.js').ImportService} deps.importers
   * @param {import('./export-service.js').ExportService} deps.exporters
   * @param {object} deps.loader - PluginLoader (has `invoke(pluginId, fn, args)`).
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   */
  constructor({ importers, exporters, loader, results }) {
    this.#importers = importers;
    this.#exporters = exporters;
    this.#loader = loader;
    this.#results = results;
  }

  /**
   * Register a codec (called by the host wiring from a plugin's `manifest.codecs`).
   * A codec with `read` adds a File ▸ Import entry; one with `write` adds a
   * File ▸ Export entry. Returns a disposer that removes both.
   *
   * @param {Object} spec
   * @param {string} spec.id
   * @param {string} spec.label
   * @param {string[]} spec.extensions
   * @param {string} spec.pluginId - The owning plugin's id (for loader.invoke).
   * @param {string} [spec.read] - Name of the plugin's read function.
   * @param {string} [spec.catalog] - Name of a function returning the TABLE OF CONTENTS
   *   without the data, so the host can offer "choose which variables to import".
   *   Optional: a format that cannot name its columns without reading everything simply
   *   does not declare it, and the host says so rather than pretending. See
   *   {@link CodecService##runCatalog} for the shape and why it is a list of sources.
   * @param {string} [spec.write] - Name of the plugin's write function.
   * @param {number} [spec.order]
   * @param {boolean} [spec.multiple]
   * @returns {() => void}
   */
  register(spec) {
    const id = spec.id;
    const disposers = [];
    if (spec.read) {
      disposers.push(
        this.#importers.registerCodec({
          id: `codec:${id}:read`,
          label: spec.label,
          extensions: spec.extensions,
          order: spec.order,
          multiple: spec.multiple,
          startRead: (file, opts) => this.#startRead(spec, file, opts),
          // Declared only when the codec has one, so the host can tell "this format
          // cannot list its variables" from "the user did not ask".
          ...(spec.catalog ? { readCatalog: (file) => this.#runCatalog(spec, file) } : {}),
        }),
      );
    }
    if (spec.write) {
      disposers.push(
        this.#exporters.register({
          id: `codec:${id}:write`,
          label: spec.label,
          extensions: spec.extensions,
          order: spec.order,
          export: ({ ticket }) => void this.#runWrite(spec, ticket),
        }),
      );
    }
    this.#codecs.set(id, { spec, disposers });
    return () => {
      for (const d of disposers) {
        try { d(); } catch { /* best-effort */ }
      }
      this.#codecs.delete(id);
    };
  }

  /**
   * The object exposed to plugins as `app.codec`. All verbs operate on the current
   * invocation's session; calling one outside a codec invocation throws.
   */
  get serviceApi() {
    const need = (kind) => {
      if (!this.#session) throw new Error('app.codec used outside a codec invocation');
      if (kind && this.#session.kind !== kind) {
        throw new Error(`app.codec: this verb is only valid during a ${kind} codec call`);
      }
      return this.#session;
    };
    return Object.freeze({
      // --- read: source access + streaming ingest ---
      size: () => need('read').file.size,
      // The whole source File (cloned by reference) — for codecs that must read it
      // synchronously in their own worker (e.g. ReadStat via FileReaderSync).
      sourceFile: () => need('read').file,
      read: async (offset, length) => {
        const s = need('read');
        const start = Math.max(0, offset | 0);
        const end = length == null ? s.file.size : Math.min(s.file.size, start + (length | 0));
        const buf = await s.file.slice(start, end).arrayBuffer();
        return new Uint8Array(buf);
      },
      begin: (variables, storageTypes, opts) => need('read').sink.begin(variables, storageTypes, opts),
      batch: (columns) => need('read').sink.batch(columns),
      // Advisory: "still working, this many rows". A codec with a long pass that emits
      // no batches — a CSV counting its rows — has nothing else to say so with.
      progress: (done, total) => need('read').sink.progress(done, total),
      // Which recurring non-numeric values mean "missing". Asked BEFORE begin(), because
      // the answer decides the column types the codec is about to declare. Resolves to
      // the accepted values, or `[]` when nobody is listening — which is what keeps the
      // old typing exactly as it was.
      missingCodes: (proposal) => need('read').sink.missingCodes(proposal),
      // --- write: emit output bytes ---
      writeChunk: (bytes) => {
        const s = need('write');
        s.chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      },
      // --- both: host-provided dependencies ---
      loadAsset: (name) => this.#loadAsset(name),
    });
  }

  // --- internals -------------------------------------------------------------

  /**
   * Start a streaming read and return a reader the host (import-service) consumes.
   * The plugin read fn runs as a producer: its `app.codec.begin(variables,
   * storageTypes, {rowCount})` resolves `reader.begin()`, and each
   * `app.codec.batch(columns)` is handed to `reader.drain(cb)` with backpressure
   * (the plugin's batch() doesn't resolve until the consumer has taken it, so peak
   * memory is one batch).
   *
   * Decoupling producer from consumer is what lets the host choose the ingest route
   * *after* seeing the schema: `begin` resolves with the columns, their types and the row
   * count, and `DataStore#load` plans from those. This used to say the host picked
   * "`loadStreaming` vs `loadWide` after seeing the catalog's `wide` hint" — both
   * functions are now one `load`, and the hint is gone: a codec declared `wide` from a
   * cells rule that was measured and deleted (2026-11-23). What a codec declares is what
   * it read; where it lands is the engine's call.
   */
  #startRead(spec, file, { plan = null } = {}) {
    const queue = [];
    let notify = null;
    let ended = false;
    let error = null;
    let head = null;
    let seenBatches = 0; // how far the read got, for the log line on finish/failure
    let headResolve, headReject;
    // Where a codec's progress reports go once someone asks for them. Set before the
    // read starts, so a codec that reports during its FIRST pass — before it knows the
    // variables, and so before `begin()` — is still heard. That pass is exactly the one
    // that used to look like a hang: a big CSV spent it tokenising with nothing on
    // screen but a spinner the blocked main thread could not even turn.
    let onProgress = null;
    /** Answers the codec's missing-code question. Set by the host before the read. */
    let onMissingCodes = null;
    const headPromise = new Promise((res, rej) => { headResolve = res; headReject = rej; });
    const wake = () => { if (notify) { const n = notify; notify = null; n(); } };

    this.#session = {
      kind: 'read',
      file,
      pluginId: spec.pluginId, // whose declared assets loadAsset() may resolve (#119)
      sink: {
        begin: (variables, storageTypes, opts = {}) => {
          head = {
            variables, storageTypes, rowCount: opts.rowCount ?? -1,
            // What the codec was told to treat as missing. Carried so the import can
            // RECORD it: a script that re-reads the file without these codes reads
            // different data, which is the one thing an exported script must not do.
            missingCodes: Array.isArray(opts.missingCodes) ? opts.missingCodes : [],
          };
          // The whole shape of the import, in one line, at the moment it is decided.
          // The owner's OOM reproduced with logging ON and left NOTHING in the log,
          // because this path had no instrumentation at all: the route (a DuckDB table
          // vs the out-of-core ingest) is chosen from these numbers, and recovering
          // them afterwards meant re-measuring the file by hand. Counts only — no
          // variable names, no values.
          //
          // `strings` is here because it is a ROUTING INPUT and it was invisible. A
          // VARCHAR column costs a table 16 bytes a row against a double's 8, which is
          // exactly the term the deleted cells rule could not see — so a route that looks
          // surprising next to `columns` and `rows` is usually explained by this.
          debug('codec', 'begin', {
            codec: spec.pluginId,
            columns: variables?.length ?? 0,
            strings: Object.values(storageTypes ?? {}).filter((t) => t === 'string').length,
            rows: head.rowCount,
            cells: (variables?.length ?? 0) * Math.max(0, head.rowCount),
            missingCodes: Array.isArray(opts.missingCodes) ? opts.missingCodes.length : 0,
            // Said rather than silently dropped. `wide` was a real field until 2026-11-23
            // and a third-party codec may still declare it; it has no effect now, and a
            // log that does not mention it is a log that cannot explain why.
            ...('wide' in opts ? { ignoredWideHint: !!opts.wide } : {}),
          });
          headResolve(head);
        },
        batch: (columns) => new Promise((ack) => { queue.push({ columns, ack }); wake(); }),
        // Advisory and one-way: a count, and a total when the codec knows one. It is
        // deliberately NOT awaited by the caller the way `batch` is — a progress report
        // that applies backpressure would be a progress report that can stall an import.
        progress: (done, total = -1) => { onProgress?.(Number(done) || 0, Number(total)); },
        // Like `progress`, this is registered before the read starts, because the codec
        // asks during its FIRST pass — before it has declared any variables. Unlike
        // `progress` it is awaited: the codec cannot type its columns until it knows.
        missingCodes: async (proposal) => {
          if (!onMissingCodes) return [];
          const codes = await onMissingCodes(proposal ?? {});
          debug('codec', 'missing codes', {
            offered: proposal?.candidates?.length ?? 0,
            accepted: Array.isArray(codes) ? codes.length : 0,
          });
          return Array.isArray(codes) ? codes : [];
        },
      },
    };

    // Deferred by a microtask, so that a host registering its callbacks SYNCHRONOUSLY on
    // the reader this function returns is always in place before the codec can call
    // back. Today that holds anyway — `invoke` crosses into the sandbox, which cannot
    // complete inside a microtask — but it held by luck, and `onMissingCodes` is awaited
    // by the codec rather than being advisory like `onProgress`, so losing that race
    // would silently type every column as text instead of merely dropping a progress
    // report. This is the same shape as the begin()/batch() race in #91, where desktop
    // won it and iPad Safari did not.
    Promise.resolve()
      // The import plan rides on the same `info` argument as `name`, which is the channel
      // that already existed. A codec that ignores it imports everything, which is the
      // behaviour every codec had before there was anything to ignore.
      //
      // Two shapes, because most formats hold one table and should not have to care that
      // some hold several: `select` is the variable list for a single-source format, and
      // `plan.sources` is the per-source map for a multi-source one. Derived here rather
      // than in each codec — a flat codec never sees a source id, and the Excel codec
      // never sees a bare array.
      .then(() => this.#loader.invoke(spec.pluginId, spec.read, [{
        name: file.name,
        select: flatSelect(plan),
        plan: plan ?? null,
      }]))
      .then(() => { ended = true; debug('codec', 'read finished', { batches: seenBatches }); if (!head) headReject(new Error('codec read produced no variables')); })
      // The failure the user is about to read off the results pane, with the count of
      // batches that made it through — which is how far in it got.
      .catch((e) => { error = e; ended = true; debug('codec', 'read FAILED', { batches: seenBatches, message: String(e?.message ?? e) }); if (!head) headReject(e); })
      .finally(() => { this.#session = null; wake(); });

    return {
      begin: () => headPromise,
      onProgress: (cb) => { onProgress = cb; },
      onMissingCodes: (cb) => { onMissingCodes = cb; },
      drain: async (cb) => {
        for (;;) {
          if (queue.length) { const it = queue.shift(); seenBatches += 1; try { await cb(it.columns); } finally { it.ack(); } continue; }
          if (error) throw error;
          if (ended) return;
          // eslint-disable-next-line no-await-in-loop -- block until the next batch
          await new Promise((r) => { notify = r; });
        }
      },
    };
  }

  /**
   * Ask a codec for its table of contents, without the data.
   *
   * ## Why this is a separate verb and not a flag on `read`
   *
   * The host has to put a dialog between "what is in here" and "read this" — so the two
   * cannot be one call. It is also the whole point that this is CHEAP: a Parquet footer, a
   * CSV header line, an SPSS header block. A codec that cannot answer cheaply should not
   * declare `catalog` at all rather than answer expensively, because the host's offer to
   * the user is a promise that choosing costs less than importing.
   *
   * ## Why a LIST of sources rather than a list of variables
   *
   * Because the host cannot know whether a format holds one table or several, and that is
   * not a thing it should try to guess. A workbook has sheets; a `.RData` has named
   * objects; a SQLite or Access file has tables; a zip of CSVs has members. The codec is
   * the only thing that knows, so it says — and a flat format answers with one source,
   * which it may do by returning the older `{variables}` shape and letting this wrap it.
   *
   * That also moved a dialog out of plugin code. The Excel codec used to ask "which
   * sheets?" itself, mid-read, AFTER the host had already asked which variables — so a
   * multi-sheet import produced two dialogs from two owners in an order nobody designed,
   * and the variables on offer were a guess at the first sheet's. One catalogue answers
   * both questions before the read starts. (A codec DECIDING whether to ask, and what to
   * show, was always right and still is; what was wrong was two deciders and no sequence.)
   *
   * Each selected source becomes its own dataset, because sheets are heterogeneous —
   * pooling or row-stacking them would be wrong, and a keyed join is Merge's deliberate
   * job. So "ABC from sheet 1 and DEF from sheet 2" means two datasets, each narrowed,
   * with their own honest row counts.
   *
   * Runs in a `read` session, so the codec has `size`, `read`, `sourceFile` and
   * `loadAsset` — but no `begin`/`batch`/`missingCodes`, which `need('read')` would allow
   * and which would make no sense here. That looseness is deliberate rather than
   * overlooked: tightening it means a fourth session kind and a second set of verb
   * guards, and the failure it would catch is a codec calling `begin` from its catalog,
   * which produces a head nobody awaits and is visible immediately.
   *
   * @param {object} spec
   * @param {File} file
   * @returns {Promise<{sources: Array<{id: string, label: string, rowCount: number,
   *   variables: Array<{name: string, label?: string}>}>}>}
   */
  async #runCatalog(spec, file) {
    this.#session = { kind: 'read', file, pluginId: spec.pluginId, sink: CATALOG_SINK };
    try {
      const out = await this.#loader.invoke(spec.pluginId, spec.catalog, [{ name: file.name }]);
      const sources = normaliseCatalog(out, file.name);
      debug('codec', 'catalog', {
        codec: spec.pluginId,
        sources: sources.length,
        columns: sources.reduce((n, src) => n + src.variables.length, 0),
      });
      return { sources };
    } finally {
      this.#session = null;
    }
  }

  /** Drive one streaming write: collect the plugin's emitted chunks, then deliver
   * the assembled bytes to the export ticket. The plugin's return value carries the
   * filename/mimeType. */
  async #runWrite(spec, ticket) {
    this.#session = { kind: 'write', chunks: [], pluginId: spec.pluginId };
    try {
      const meta = await this.#loader.invoke(spec.pluginId, spec.write, [{}]);
      const chunks = this.#session.chunks;
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { data.set(c, at); at += c.byteLength; }
      this.#exporters.deliver(ticket, {
        filename: meta?.filename || `export${spec.extensions?.[0] || ''}`,
        mimeType: meta?.mimeType || 'application/octet-stream',
        data,
      });
    } catch (err) {
      this.#results.appendError(`Export failed: ${err.message}`);
      try { this.#exporters.deliver(ticket, null); } catch { /* ticket may be gone */ }
    } finally {
      this.#session = null;
    }
  }

  /** Resolve a codec dependency once and cache it. Two tiers (#119): first the
   * calling plugin's own **declared** asset (its `.ctplugin` bundle, or a same-origin
   * sibling of its entry URL) via the loader; then the host's narrow shared-library
   * allowlist. Text assets come back as a self-contained module string the plugin
   * blob-imports; binary assets (WASM) as a Uint8Array. Cache is keyed per plugin so
   * two plugins declaring the same asset name don't collide. */
  async #loadAsset(name) {
    const pluginId = this.#session?.pluginId || null;
    const cacheKey = `${pluginId || '*'}\0${name}`;
    if (this.#assetCache.has(cacheKey)) return this.#assetCache.get(cacheKey);

    // Tier 1 — the plugin brought it: its own bundle or a same-origin sibling.
    if (pluginId) {
      const resolved = await this.#loader.resolveAsset(pluginId, name);
      if (resolved) {
        this.#assetCache.set(cacheKey, resolved.value);
        return resolved.value;
      }
    }

    // Tier 2 — a host-vetted shared library (CrossTab's own runtimes).
    const entry = ASSETS[name];
    if (!entry) {
      throw new Error(
        `app.codec.loadAsset: "${name}" is neither declared by the plugin nor a host-vetted shared library`,
      );
    }
    // A codec's library arrives over the network on first use — multi-megabyte bundles
    // (SheetJS, hyparquet, duckdb) fetched from a pinned CDN. When one of these is slow or
    // blocked, the symptom is an import that hangs with nothing on screen, and the log has
    // had nothing to say about it. URL, because these are OUR pinned dependencies rather
    // than anything the user typed.
    const t0 = Date.now();
    debug('net', 'asset →', { name, url: entry.url, kind: entry.kind });
    let value;
    if (entry.kind === 'bytes') {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`codec asset "${name}" failed to load (${res.status})`);
      value = new Uint8Array(await res.arrayBuffer());
    } else {
      value = await this.#fetchSelfContainedModule(entry.url);
    }
    this.#assetCache.set(cacheKey, value);
    // Size and timing, which together say "the import was waiting on the network" rather
    // than leaving a gap in the log where the wait was. Cached on the way back, so this
    // fires once per asset per session.
    debug('net', 'asset ←', {
      name,
      bytes: value?.length ?? null,
      ms: Date.now() - t0,
    });
    return value;
  }

  /** Fetch a JS module as a single self-contained source string. esm.sh serves
   * *browsers* a tiny re-export shim that points at the real inlined bundle via a
   * relative path — fine for a direct `import()`, but the sandbox imports from a
   * `blob:` URL and can't resolve that relative path. So follow the shim to the
   * real bundle (which inlines all deps → no further imports). */
  async #fetchSelfContainedModule(url) {
    let text = await this.#fetchText(url);
    for (let i = 0; i < 3; i++) {
      const m = text.match(/from\s*["'](\/[^"']+)["']/);
      if (!m || text.length > 8000) break; // a real bundle is large + has no relative imports
      text = await this.#fetchText(new URL(m[1], 'https://esm.sh').href);
    }
    return text;
  }

  async #fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`codec asset fetch failed (${res.status})`);
    return res.text();
  }
}
