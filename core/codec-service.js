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
 * @type {Object<string, {url: string, kind: 'text'|'bytes', raw?: boolean}>}
 */
const ASSETS = {
  // `?bundle&target=es2022` inlines all deps into one self-contained module (no
  // cross-origin sub-imports) — required because the sandbox imports it from a
  // `blob:` URL and can't fetch anything itself. Same pattern the vendor script uses.
  hyparquet: { url: 'https://esm.sh/hyparquet@1?bundle&target=es2022', kind: 'text' },
  'hyparquet-writer': { url: 'https://esm.sh/hyparquet-writer@0.16.1?bundle&target=es2022', kind: 'text' },
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
          startRead: (file) => this.#startRead(spec, file),
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
   * storageTypes, {rowCount, wide})` resolves `reader.begin()`, and each
   * `app.codec.batch(columns)` is handed to `reader.drain(cb)` with backpressure
   * (the plugin's batch() doesn't resolve until the consumer has taken it, so peak
   * memory is one batch). Decoupling producer from consumer is what lets the host
   * pick `loadStreaming` vs `loadWide` *after* seeing the catalog's `wide` hint.
   */
  #startRead(spec, file) {
    const queue = [];
    let notify = null;
    let ended = false;
    let error = null;
    let head = null;
    let headResolve, headReject;
    const headPromise = new Promise((res, rej) => { headResolve = res; headReject = rej; });
    const wake = () => { if (notify) { const n = notify; notify = null; n(); } };

    this.#session = {
      kind: 'read',
      file,
      pluginId: spec.pluginId, // whose declared assets loadAsset() may resolve (#119)
      sink: {
        begin: (variables, storageTypes, opts = {}) => {
          head = { variables, storageTypes, rowCount: opts.rowCount ?? -1, wide: !!opts.wide };
          headResolve(head);
        },
        batch: (columns) => new Promise((ack) => { queue.push({ columns, ack }); wake(); }),
      },
    };

    this.#loader
      .invoke(spec.pluginId, spec.read, [{ name: file.name }])
      .then(() => { ended = true; if (!head) headReject(new Error('codec read produced no variables')); })
      .catch((e) => { error = e; ended = true; if (!head) headReject(e); })
      .finally(() => { this.#session = null; wake(); });

    return {
      begin: () => headPromise,
      drain: async (cb) => {
        for (;;) {
          if (queue.length) { const it = queue.shift(); try { await cb(it.columns); } finally { it.ack(); } continue; }
          if (error) throw error;
          if (ended) return;
          // eslint-disable-next-line no-await-in-loop -- block until the next batch
          await new Promise((r) => { notify = r; });
        }
      },
    };
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
    const cacheKey = `${pluginId || '*'} ${name}`;
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
    this.#assetCache.set(cacheKey, value);
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
