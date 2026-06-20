/**
 * @file webr-manager.js
 * Owns the WebR runtime: loading it, queueing jobs, injecting data, and
 * returning structured results.
 *
 * WebR (R compiled to WebAssembly) runs the actual R interpreter inside its own
 * dedicated Web Worker — that is part of WebR's own design, so the main thread
 * never blocks on R execution. This manager lives on the main thread and acts
 * as the single gateway to that worker. Two responsibilities justify its
 * existence:
 *
 *  1. **Serialisation.** There is one R process. Two analyses cannot run R code
 *     concurrently without corrupting each other's global environment. So every
 *     `run()` is funnelled through a promise-chained job queue and executed one
 *     at a time, in order.
 *
 *  2. **Data marshalling.** Plugins think in terms of "run this R against the
 *     current dataset". This manager injects the dataset as an R `data.frame`
 *     named `df`, runs the code in a {@link https://docs.r-wasm.org/webr/latest/objects.html Shelter}
 *     (so intermediate R objects are reliably freed), and converts the result
 *     back to plain JS.
 *
 * The manager is lazy: WebR (~tens of MB of WASM) is not fetched until the first
 * job is enqueued, so opening the app is cheap.
 */

import { CoreEvents } from './event-bus.js';

/**
 * Default ES-module entry point for WebR, served from the official CDN.
 *
 * NOTE: `latest` favours "it just works" over reproducibility. For a release
 * build, pin a specific version (e.g. `.../v0.4.2/webr.mjs`) and vendor the
 * assets locally so the PWA works offline. Tracked as an open question:
 * package/runtime pre-loading strategy.
 *
 * @type {string}
 */
const DEFAULT_WEBR_URL = 'https://webr.r-wasm.org/latest/webr.mjs';

/** Path in WebR's virtual filesystem where the Parquet injection snapshot is
 * written before R reads it. Overwritten each injecting run. */
const INJECT_PATH = '/tmp/ct_inject.parquet';

/** WebR FS path the R console stages each evaluated line to. */
const CONSOLE_PATH = '/tmp/ct_console.R';

/** An R string literal (escapes backslash + double-quote). */
function rLit(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The union of all columns referenced by `variables`-kind inputs, deduped — the
 * set `df` must contain so the per-input aliases can slice from it.
 * @param {Object<string, {kind:string, columns?:string[]}>} injectInputs
 * @returns {string[]}
 */
function inputColumns(injectInputs) {
  const set = new Set();
  for (const d of Object.values(injectInputs)) {
    if (d?.kind === 'variables' && Array.isArray(d.columns)) d.columns.forEach((c) => set.add(c));
  }
  return [...set];
}

/**
 * R prelude that binds each declared input under its own name, sliced from `df`:
 *  - multi variables → a `data.frame` (`name <- df[c("a","b")]`)
 *  - single variable → a vector (`name <- df[["a"]]`)
 *  - number/choice/text → the scalar value
 * Skipped optional inputs bind to `NULL`/`NA` so the plugin can test for them.
 * @param {Object<string, object>} injectInputs
 * @returns {string}
 */
function buildInputAliases(injectInputs) {
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  let out = '';
  for (const [name, d] of Object.entries(injectInputs)) {
    if (d?.kind === 'variables') {
      const cols = Array.isArray(d.columns) ? d.columns : [];
      if (!cols.length) out += `${name} <- NULL\n`;
      else if (d.multiple) out += `${name} <- df[c(${cols.map(q).join(', ')})]\n`;
      else out += `${name} <- df[[${q(cols[0])}]]\n`;
    } else if (d?.kind === 'number') {
      out += `${name} <- ${Number.isFinite(d.value) ? d.value : 'NA'}\n`;
    } else {
      // text / choice → an R string (or NULL when skipped)
      out += d.value == null ? `${name} <- NULL\n` : `${name} <- ${q(d.value)}\n`;
    }
  }
  return out;
}

/**
 * @typedef {Object} RunResult
 * @property {any} result - The R return value converted to JS (`toJs()`), or
 *   `null` if it could not be converted (e.g. an R closure). Analyses should
 *   compute an explicit data structure (list/data.frame) as the last expression
 *   so this is meaningful.
 * @property {string} output - Captured stdout, lines joined by `\n`.
 * @property {string} stderr - Captured stderr (R messages/warnings), joined.
 * @property {Array<ImageBitmap>} images - Captured plots, if `captureGraphics`
 *   was requested; otherwise empty.
 */

/**
 * @typedef {Object} RunOptions
 * @property {boolean} [injectData=false] - If true, the current dataset is
 *   bound as an R `data.frame` named `df` before `code` runs.
 * @property {string[]} [variables] - When injecting, restrict to these columns
 *   (defaults to all). Lets a dialog pass only the variables it needs.
 * @property {boolean} [captureGraphics=false] - Capture base-graphics plots as
 *   `ImageBitmap`s. Off by default because it requires the canvas device.
 * @property {Object<string, object>} [injectInputs] - New plugin API: a map of
 *   declared input name → descriptor (`{kind:'variables', columns, multiple}` or
 *   `{kind:'number'|'choice'|'text', value}`). Each is bound into R under its name
 *   before `code` runs (see {@link buildInputAliases}). Supersedes `injectData`/
 *   `variables` for declarative plugins.
 */

/**
 * Manages the lifecycle of, and access to, the single WebR runtime.
 */
export class WebRManager {
  /** @type {import('./event-bus.js').EventBus} */
  #bus;

  /** Returns the current dataset as `{ name: array }` (async — it queries the
   * DuckDB-backed store). Injected, not imported, so this module stays decoupled
   * from DataStore internals. */
  #getColumns;

  /** Returns the current dataset (or a subset) as Parquet bytes, or `null`. The
   * preferred injection path: it preserves column types natively in R. Optional;
   * if absent, injection uses the JS-array fallback. @type {?(opts?: object) => Promise<Uint8Array|null>} */
  #getInjectionParquet;

  /** Cached probe: has `nanoparquet` been installed in WebR? `undefined` until
   * first checked, then a `Promise<boolean>`. @type {Promise<boolean>|undefined} */
  #nanoparquet;

  /** WebR module URL. */
  #url;

  /** Packages to install immediately after init (the default plugin set's deps). */
  #preload;

  /** The live WebR instance once initialised. @type {any} */
  #webR = null;

  /** In-flight init promise, so concurrent first-callers share one init. */
  #initPromise = null;

  /** Tail of the job queue. Each job awaits the previous one. @type {Promise<any>} */
  #queue = Promise.resolve();

  /** Monotonic job id for logging/telemetry. */
  #nextJobId = 1;

  /** Monotonic id for unique WORKERFS mountpoints. */
  #nextMount = 1;

  /**
   * @param {Object} deps
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {(opts?: {variables?: string[]}) => Promise<Object<string, Array>>} deps.getColumns
   *   - Supplies the current dataset in columnar form (typically
   *   `dataStore.getColumns`). Async: it queries the DuckDB-backed store.
   * @param {(opts?: {variables?: string[]}) => Promise<Uint8Array|null>} [deps.getInjectionParquet]
   *   - Optional. Supplies the dataset as Parquet bytes for the fast injection
   *   path (typically `dataStore.getInjectionParquet`).
   * @param {Object} [opts]
   * @param {string} [opts.url] - Override the WebR module URL.
   * @param {string[]} [opts.preloadPackages] - Install on init.
   */
  constructor({ bus, getColumns, getInjectionParquet }, opts = {}) {
    this.#bus = bus;
    this.#getColumns = getColumns;
    this.#getInjectionParquet = getInjectionParquet ?? null;
    this.#url = opts.url ?? DEFAULT_WEBR_URL;
    this.#preload = opts.preloadPackages ?? [];
  }

  /** @returns {boolean} True once WebR is initialised and ready for jobs. */
  get isReady() {
    return this.#webR !== null;
  }

  /**
   * Begin loading WebR now, rather than on first job. Optional — useful to call
   * during app idle time so the first analysis is snappy. Safe to call repeatedly.
   *
   * @returns {Promise<void>} Resolves when the runtime is ready.
   */
  async preload() {
    await this.#ensureReady();
  }

  /**
   * Install one or more R packages into the running WebR session. Packages come
   * from the WebR binary repository (or a configured repo). Queued like any
   * other job so it cannot interleave with running analyses.
   *
   * @param {string[]} packages - Package names, e.g. `['summarytools']`.
   * @returns {Promise<void>}
   */
  installPackages(packages) {
    return this.#enqueue(async (webR) => {
      await webR.installPackages(packages, { quiet: true });
    }, 'installPackages');
  }

  /**
   * Write bytes to a path in WebR's virtual filesystem. Lets an importer stage
   * an uploaded file where R can read it (e.g. `haven::read_sav`). Queued so it
   * is ordered relative to the `run` that consumes the file.
   *
   * Note: this is a convenience, not a new capability — a plugin could already
   * write the FS via `webr.run('writeBin(...)')`. It just makes binary I/O clean.
   *
   * @param {string} path - Destination path, e.g. `/tmp/import.sav`.
   * @param {Uint8Array | ArrayBuffer} data
   * @returns {Promise<void>}
   */
  writeFile(path, data) {
    return this.#enqueue(async (webR) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await webR.FS.writeFile(path, bytes);
    }, 'writeFile');
  }

  /**
   * Read a file from WebR's virtual filesystem as bytes — e.g. to pull a Parquet
   * snapshot an importer wrote in R back out for ingestion.
   *
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  readFile(path) {
    return this.#enqueue(async (webR) => webR.FS.readFile(path), 'readFile');
  }

  /**
   * Mount a `File`/`Blob` into WebR's filesystem via **WORKERFS** and return the
   * path to it. Unlike {@link WebRManager#writeFile}, this is **lazy and
   * copy-free**: the bytes stay in the Blob and are read on demand by the worker,
   * so it sidesteps the ~128 MB `FS.writeFile` channel limit. Use it to stage a
   * large upload (e.g. a `.sav` for haven) before reading it in R. Call
   * {@link WebRManager#unmount} with the returned path when done.
   *
   * WebR's WORKERFS only accepts Emscripten "package" descriptors, so we wrap the
   * single file in a one-entry descriptor (the File *is* the blob).
   *
   * @param {Blob} file - The upload (a `File` is a `Blob`).
   * @param {string} [name] - Filename to expose it under (defaults to `file.name`).
   * @returns {Promise<string>} Path to the mounted file.
   */
  mountFile(file, name) {
    return this.#enqueue(async (webR) => {
      const mountpoint = `/mnt/ct_import_${this.#nextMount++}`;
      const fname = String(name || file.name || 'import.dat').replace(/[\\/]/g, '_');
      try {
        await webR.FS.mkdir('/mnt');
      } catch {
        /* already exists */
      }
      await webR.FS.mkdir(mountpoint);
      const metadata = {
        files: [{ filename: `/${fname}`, start: 0, end: file.size }],
        remote_package_size: file.size,
      };
      await webR.FS.mount('WORKERFS', { packages: [{ blob: file, metadata }] }, mountpoint);
      return `${mountpoint}/${fname}`;
    }, 'mountFile');
  }

  /**
   * Unmount a path previously returned by {@link WebRManager#mountFile}.
   *
   * @param {string} path
   * @returns {Promise<void>}
   */
  unmount(path) {
    return this.#enqueue(async (webR) => {
      const mountpoint = path.slice(0, path.lastIndexOf('/'));
      await webR.FS.unmount(mountpoint);
      try {
        await webR.FS.rmdir(mountpoint);
      } catch {
        /* best-effort */
      }
    }, 'unmount');
  }

  /**
   * Run R code, optionally with the current dataset injected as `df`, and get
   * back structured output.
   *
   * The code runs inside a fresh {@link Shelter}; every R object allocated
   * during the call is freed when the call returns, regardless of success or
   * failure. Make the *last expression* of `code` the value you want back in
   * {@link RunResult.result} — e.g. a list or data.frame, which converts cleanly
   * to JS. Avoid returning raw model objects; extract what you need in R first.
   *
   * @param {string} code - R source to evaluate.
   * @param {RunOptions} [options]
   * @returns {Promise<RunResult>}
   */
  run(code, options = {}) {
    const { injectData = false, variables, captureGraphics = false, injectInputs = null } = options;
    return this.#enqueue(async (webR) => {
      const shelter = await new webR.Shelter();
      try {
        const env = {};
        let prelude = '';
        if (injectInputs) {
          // New plugin API: bind each declared input into R under its own name —
          // a single-variable input → a vector, a multi → a data.frame, a scalar
          // input → its value. `df` is built (union of all chosen columns) as the
          // source the aliases slice from.
          const cols = inputColumns(injectInputs);
          if (cols.length) prelude = await this.#buildInjection(webR, env, cols);
          prelude += buildInputAliases(injectInputs);
        } else if (injectData) {
          prelude = await this.#buildInjection(webR, env, variables);
        }

        const capture = await shelter.captureR(prelude + code, {
          env,
          captureGraphics,
        });

        let result = null;
        try {
          result = await capture.result.toJs();
        } catch {
          // Result was not convertible (e.g. an R function/closure). Leave null;
          // the analysis was expected to return a plain data structure.
          result = null;
        }

        const stdout = [];
        const stderr = [];
        for (const msg of capture.output) {
          if (msg.type === 'stderr') stderr.push(msg.data);
          else stdout.push(msg.data);
        }

        return {
          result,
          output: stdout.join('\n'),
          stderr: stderr.join('\n'),
          images: capture.images ?? [],
        };
      } finally {
        await shelter.purge();
      }
    }, 'run');
  }

  /**
   * Evaluate a line of R **in the persistent global environment** — for the R
   * console (REPL). Unlike {@link WebRManager#run}, assignments persist across
   * calls (`x <- 5` then `mean(x)`), and visible values auto-print as at an R
   * prompt. Captures stdout/stderr; an R error is returned as text, not thrown.
   *
   * @param {string} code - One or more R expressions.
   * @returns {Promise<{output: string, error: boolean}>}
   */
  evalConsole(code) {
    return this.#enqueue(async (webR) => {
      // Run via source(print.eval=TRUE) so visible values auto-print like the R
      // prompt (captureR alone does not echo them). The code is staged to a file
      // to avoid escaping it into an R string; `local=FALSE` evaluates in globalenv
      // so assignments persist across lines.
      await webR.FS.writeFile(CONSOLE_PATH, new TextEncoder().encode(code));
      const shelter = await new webR.Shelter();
      try {
        const capture = await shelter.captureR(
          `source(${rLit(CONSOLE_PATH)}, echo = FALSE, print.eval = TRUE, max.deparse.length = Inf, local = FALSE)`,
          { env: webR.objs.globalEnv, captureGraphics: false },
        );
        const out = capture.output
          .map((m) => (typeof m.data === 'string' ? m.data : String(m.data)))
          .join('\n');
        const hadErr = capture.output.some((m) => m.type === 'stderr');
        return { output: out, error: hadErr };
      } catch (err) {
        // A parse/eval error surfaces as a thrown condition; strip the source() wrapper.
        const msg = String(err?.message ?? err).replace(/\bin eval\b.*$/, '').trim();
        return { output: msg, error: true };
      } finally {
        await shelter.purge(); // frees capture buffers; globalenv user vars persist
      }
    }, 'console');
  }

  /**
   * Bind the console's checked variables into the persistent global env as `vars`
   * — **exactly as a plugin receives them**: a data.frame when several are
   * checked, a plain vector when one is (a plugin's single-variable input). So R
   * typed here copy/pastes straight into a plugin's `run`. Re-call on selection
   * change; pass no columns to clear `vars`.
   *
   * @param {string[]} columns - Checked variable names.
   * @param {boolean} multiple - Bind as a data.frame (true) or vector (false).
   * @returns {Promise<{names: string[], multiple: boolean}>}
   */
  consoleBind(columns, multiple) {
    return this.#enqueue(async (webR) => {
      const G = webR.objs.globalEnv;
      const shelter = await new webR.Shelter();
      try {
        if (!columns || !columns.length) {
          await shelter.captureR('if (exists("vars", envir = globalenv())) rm("vars", envir = globalenv())', { env: G });
          return { names: [], multiple: false };
        }
        const assign = multiple
          ? 'assign("vars", .d, envir = globalenv())'
          : 'assign("vars", .d[[1]], envir = globalenv())';

        // Prefer the Parquet bridge (native types); fall back to JS arrays.
        if (this.#getInjectionParquet && (await this.#ensureNanoparquet(webR))) {
          const bytes = await this.#getInjectionParquet({ variables: columns });
          if (bytes && bytes.byteLength) {
            await webR.FS.writeFile(INJECT_PATH, bytes);
            await shelter.captureR(
              `local({ .d <- as.data.frame(nanoparquet::read_parquet(${rLit(INJECT_PATH)}), check.names = FALSE); ${assign} })`,
              { env: G },
            );
            return { names: columns, multiple };
          }
        }
        const rawCols = await this.#getColumns({ variables: columns });
        const cols = {};
        for (const [k, v] of Object.entries(rawCols)) {
          cols[k] = Array.from(v, (x) => (typeof x === 'number' && Number.isNaN(x) ? null : x));
        }
        await shelter.captureR(
          `local({ .d <- as.data.frame(.crosstab_data, stringsAsFactors = FALSE, check.names = FALSE); ${assign} })`,
          { env: { '.crosstab_data': cols } },
        );
        return { names: columns, multiple };
      } finally {
        await shelter.purge();
      }
    }, 'consoleBind');
  }

  /**
   * Shut the runtime down and reset the manager. After this, the next job will
   * cold-start a new runtime. Mainly for tests and "restart R" UX.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    const webR = this.#webR;
    this.#webR = null;
    this.#initPromise = null;
    this.#queue = Promise.resolve();
    if (webR) await webR.close();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Append a unit of work to the serial job queue.
   *
   * @template T
   * @param {(webR: any) => Promise<T>} task - Receives the ready WebR instance.
   * @param {string} kind - Label for lifecycle events.
   * @returns {Promise<T>}
   */
  #enqueue(task, kind) {
    const id = this.#nextJobId++;
    // Chain onto the queue tail. We swallow the previous job's rejection here
    // (the original caller already received it) so one failed job does not
    // poison every subsequent job.
    const run = this.#queue.then(
      () => this.#execute(id, kind, task),
      () => this.#execute(id, kind, task),
    );
    this.#queue = run.catch(() => {}); // keep the tail un-rejected
    return run;
  }

  /**
   * Bind the current dataset as the R data.frame `df` and return the prelude
   * that materialises it. Prefers the Parquet bridge (types preserved natively
   * in R, no per-cell JS boxing); falls back to JS columnar arrays when Parquet
   * isn't available (no `getInjectionParquet`, `nanoparquet` won't install, or
   * any error). The fallback is the hardened JS-array path from the spikes.
   *
   * @param {any} webR
   * @param {Object} env - captureR env; the fallback binds `.crosstab_data` here.
   * @param {string[]} [variables]
   * @returns {Promise<string>} R prelude source.
   */
  async #buildInjection(webR, env, variables) {
    const opts = variables ? { variables } : undefined;

    if (this.#getInjectionParquet && (await this.#ensureNanoparquet(webR))) {
      try {
        const bytes = await this.#getInjectionParquet(opts);
        if (bytes && bytes.byteLength) {
          await webR.FS.writeFile(INJECT_PATH, bytes);
          return (
            `df <- as.data.frame(nanoparquet::read_parquet("${INJECT_PATH}"), ` +
            `stringsAsFactors = FALSE, check.names = FALSE)\n`
          );
        }
      } catch (err) {
        console.warn('[webr] Parquet injection failed; using JS-array fallback', err);
      }
    }

    // Fallback: WebR's JS→R conversion wants a named object of *plain* arrays.
    // Convert each column and map NaN (our numeric "missing") to null → R NA.
    // Bind under a dot-prefixed name (valid R, conventionally "hidden").
    const rawCols = await this.#getColumns(opts);
    const cols = {};
    for (const [name, vec] of Object.entries(rawCols)) {
      cols[name] = Array.from(vec, (v) =>
        typeof v === 'number' && Number.isNaN(v) ? null : v,
      );
    }
    env['.crosstab_data'] = cols;
    return 'df <- as.data.frame(.crosstab_data, stringsAsFactors = FALSE, check.names = FALSE)\n';
  }

  /**
   * Ensure `nanoparquet` is installed, once. Cached so the (~1s) install is paid
   * at most once per session; returns `false` if it can't be installed, so the
   * caller falls back to the JS-array bridge.
   *
   * @param {any} webR
   * @returns {Promise<boolean>}
   */
  #ensureNanoparquet(webR) {
    if (this.#nanoparquet === undefined) {
      this.#nanoparquet = (async () => {
        try {
          await webR.installPackages(['nanoparquet'], { quiet: true });
          const ok = await webR.evalRString(
            'tryCatch({ requireNamespace("nanoparquet", quietly=TRUE); "y" }, error=function(e) "n")',
          );
          return ok === 'y';
        } catch (err) {
          console.warn('[webr] nanoparquet unavailable; Parquet bridge disabled', err);
          return false;
        }
      })();
    }
    return this.#nanoparquet;
  }

  /** Execute a single job with lifecycle events around it. */
  async #execute(id, kind, task) {
    const webR = await this.#ensureReady();
    this.#bus.emit(CoreEvents.WEBR_JOB, { id, kind, status: 'started' });
    try {
      const value = await task(webR);
      this.#bus.emit(CoreEvents.WEBR_JOB, { id, kind, status: 'finished' });
      return value;
    } catch (err) {
      this.#bus.emit(CoreEvents.WEBR_JOB, { id, kind, status: 'failed', error: err });
      throw err;
    }
  }

  /** Lazily load + init WebR, sharing one init across concurrent callers. */
  async #ensureReady() {
    if (this.#webR) return this.#webR;
    if (!this.#initPromise) this.#initPromise = this.#init();
    return this.#initPromise;
  }

  /** One-time runtime construction. */
  async #init() {
    // Dynamic import so the WASM payload is only fetched when first needed and
    // so the URL can be configured at runtime.
    const { WebR } = await import(/* @vite-ignore */ this.#url);
    const webR = new WebR();
    await webR.init();
    if (this.#preload.length) {
      await webR.installPackages(this.#preload, { quiet: true });
    }
    this.#webR = webR;
    this.#bus.emit(CoreEvents.WEBR_READY);
    return webR;
  }
}
