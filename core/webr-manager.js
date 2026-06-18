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
    const { injectData = false, variables, captureGraphics = false } = options;
    return this.#enqueue(async (webR) => {
      const shelter = await new webR.Shelter();
      try {
        const env = {};
        let prelude = '';
        if (injectData) {
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
