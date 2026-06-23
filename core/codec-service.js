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
 *  - both:  `loadAsset(name)` — fetch a host-allowlisted dependency (a JS lib's
 *           source, or WASM bytes) the sandbox can't fetch itself (`connect-src
 *           'none'`). Only host-known names resolve — a codec can't pull arbitrary
 *           code; it bundles anything else itself.
 *
 * The session is a single mutable slot: codec import/export are user-initiated and
 * strictly serial, so there's never more than one in flight.
 */

/**
 * Host-allowlisted codec dependencies. A codec declares the names it needs in its
 * manifest (`codecs[].assets`); only names listed here resolve, and the host
 * decides the URL — so a codec can't request arbitrary code. esm.sh `?bundle`
 * gives a single self-contained module (no external imports), which is required
 * because the sandbox imports it from a `blob:` URL.
 *
 * @type {Object<string, {url: string, kind: 'text'|'bytes'}>}
 */
const ASSETS = {
  // `?bundle&target=es2022` inlines all deps into one self-contained module (no
  // cross-origin sub-imports) — required because the sandbox imports it from a
  // `blob:` URL and can't fetch anything itself. Same pattern the vendor script uses.
  hyparquet: { url: 'https://esm.sh/hyparquet@1?bundle&target=es2022', kind: 'text' },
  'hyparquet-writer': { url: 'https://esm.sh/hyparquet-writer@0.16.1?bundle&target=es2022', kind: 'text' },
  // ReadStat (SPSS/Stata/SAS) — local, self-contained host files served to the codec
  // sandbox (which can't fetch them itself). `raw` = serve as-is, no shim-following.
  'readstat-wasm': { url: new URL('../vendor/readstat/readstat.wasm', import.meta.url).href, kind: 'bytes' },
  'readstat-glue': { url: new URL('../vendor/readstat/readstat.mjs', import.meta.url).href, kind: 'text', raw: true },
  'readstat-worker': { url: new URL('../plugins/builtin-readstat-codec/codec-worker.js', import.meta.url).href, kind: 'text', raw: true },
};

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
          ingest: (file, ctx) => this.#runRead(spec, file, ctx),
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
      begin: (variables, storageTypes) => need('read').ctx.begin(variables, storageTypes),
      batch: (columns) => need('read').ctx.batch(columns),
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

  /** Drive one streaming read: bind the session, invoke the plugin's read fn (which
   * calls back through `app.codec`), then unbind. */
  async #runRead(spec, file, ctx) {
    this.#session = { kind: 'read', file, ctx };
    try {
      await this.#loader.invoke(spec.pluginId, spec.read, [{ name: file.name }]);
    } finally {
      this.#session = null;
    }
  }

  /** Drive one streaming write: collect the plugin's emitted chunks, then deliver
   * the assembled bytes to the export ticket. The plugin's return value carries the
   * filename/mimeType. */
  async #runWrite(spec, ticket) {
    this.#session = { kind: 'write', chunks: [] };
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

  /** Fetch a host-allowlisted dependency once and cache it. Text assets (JS module
   * source) come back as a single self-contained module the plugin blob-imports;
   * binary assets (WASM) as a Uint8Array. */
  async #loadAsset(name) {
    if (this.#assetCache.has(name)) return this.#assetCache.get(name);
    const entry = ASSETS[name];
    if (!entry) throw new Error(`app.codec.loadAsset: unknown asset "${name}" (not host-allowlisted)`);
    let value;
    if (entry.kind === 'bytes') {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`codec asset "${name}" failed to load (${res.status})`);
      value = new Uint8Array(await res.arrayBuffer());
    } else if (entry.raw) {
      value = await this.#fetchText(entry.url); // local, already self-contained
    } else {
      value = await this.#fetchSelfContainedModule(entry.url);
    }
    this.#assetCache.set(name, value);
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
