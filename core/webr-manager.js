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
import { getAssets } from './assets.js';
import { debug } from './debug.js';

/** Path in WebR's virtual filesystem where the Parquet injection snapshot is
 * written before R reads it. Overwritten each injecting run. */
/** The console's own R environment — a child of globalenv, so it can READ what a
 * recorded script produced but nothing it defines leaks back the other way (#160). */
const CONSOLE_ENV = '.crosstab_console';
/** Idempotent bootstrap, inlined before any use (cheap, and survives a session reset). */
const ENSURE_CONSOLE_ENV =
  `if (!exists(${JSON.stringify(CONSOLE_ENV)}, envir = globalenv(), inherits = FALSE) || `
  + `!is.environment(get(${JSON.stringify(CONSOLE_ENV)}, envir = globalenv()))) `
  + `assign(${JSON.stringify(CONSOLE_ENV)}, new.env(parent = globalenv()), envir = globalenv())
`;

/** Per-message ceiling for pulling bytes out of WebR. The channel fails somewhere
 * around 128 MB; 64 MB leaves headroom and costs one extra hop on a 100 MB export. */
const READ_CHUNK = 64 * 1024 * 1024;

const INJECT_PATH = '/tmp/ct_inject.parquet';

/** WebR FS path the R console stages each evaluated line to. */
const CONSOLE_PATH = '/tmp/ct_console.R';

/** An R string literal (escapes backslash + double-quote). */
function rLit(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Does this error mean the runtime is unrecoverable (out of memory / WASM
 * abort), as opposed to an ordinary R error? A WASM heap exhaustion typically
 * corrupts the worker, so we flag the runtime crashed and prompt a restart. A
 * file that's merely too big to read (NotReadableError) is NOT fatal — the worker
 * is fine — so it's deliberately excluded. */
function isFatalRuntimeError(err) {
  const m = String((err && (err.message ?? err)) || '');
  return /cannot allocate|out of memory|memory exhausted|allocation failed|std::bad_alloc|abort(ed)?\b|memory access out of bounds|RuntimeError|unreachable executed/i.test(m);
}

/** Coerce a captured-output datum to a string without throwing. WebR usually
 * gives string `data`, but some conditions/warnings carry a non-stringable object
 * (coercing it throws "Cannot convert object to primitive value"). */
function safeStr(x) {
  if (typeof x === 'string') return x;
  try {
    return String(x);
  } catch {
    return '';
  }
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
 * @property {boolean} [keepMissing=false] - With `injectInputs`, skip the central
 *   missing-value strip so the analysis receives the raw designated codes (for
 *   analyses that report missingness themselves, e.g. Frequencies). Ignored for the
 *   raw `injectData` path, which is never stripped. (#missing-values)
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

  /** WebR constructor options (baseUrl/repoUrl in self-hosted mode). @type {object} */
  #webrOptions;

  /** Packages to install immediately after init (the default plugin set's deps). */
  #preload;

  /** The live WebR instance once initialised. @type {any} */
  #webR = null;

  /** In-flight init promise, so concurrent first-callers share one init. */
  #initPromise = null;

  /** Set once a job fails with a fatal runtime error (out of memory / WASM abort).
   * A WASM OOM can leave the worker corrupted, so every later job would fail with
   * a cryptic cascade — instead we fail fast with a clear "restart R" message
   * until {@link WebRManager#restart}. @type {boolean} */
  #crashed = false;

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
   * @param {string} [opts.url] - Override the WebR module URL (else from assets.js).
   * @param {object} [opts.webrOptions] - Override WebR constructor options.
   * @param {string[]} [opts.preloadPackages] - Install on init.
   */
  constructor({ bus, getColumns, getInjectionParquet }, opts = {}) {
    this.#bus = bus;
    this.#getColumns = getColumns;
    this.#getInjectionParquet = getInjectionParquet ?? null;
    // The module URL and WebR options (baseUrl/repoUrl for the self-hosted,
    // air-gapped build) come from the central asset registry; opts can override.
    const assets = getAssets();
    this.#url = opts.url ?? assets.webrUrl;
    this.#webrOptions = opts.webrOptions ?? assets.webrOptions ?? {};
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
   * Read a file from WebR's virtual filesystem as bytes — an exporter pulling back the
   * `.RData`/`.docx` R just wrote, or an importer collecting a Parquet snapshot.
   *
   * **Chunked above ~128 MB.** A single `FS.readFile` moves the whole buffer across the
   * worker channel in one message, and past roughly 128 MB that transfer fails — so
   * exporting a large dataset died at the last step, after all the work. R slices the
   * file to a scratch path and JS stitches the slices, which is the same trick that
   * proved the 181 MB inbound case; it was described in the TODO and never wired up.
   *
   * Transparent to callers: the fast single-hop path is unchanged for ordinary sizes,
   * and nothing downstream sees a difference beyond getting its bytes.
   *
   * @param {string} path
   * @param {{chunkSize?: number}} [opts]
   * @returns {Promise<Uint8Array>}
   */
  readFile(path, { chunkSize = READ_CHUNK } = {}) {
    return this.#enqueue(async (webR) => {
      // Size first, from R — cheap, and it decides whether the channel can take it.
      let size = -1;
      try {
        const n = await webR.evalRString(`as.character(file.info(${rLit(path)})$size)`);
        size = Number(n);
      } catch { size = -1; }

      // Small enough (or unknown): one hop, exactly as before.
      if (!Number.isFinite(size) || size <= chunkSize) return webR.FS.readFile(path);

      // Too big for one transfer. R slices the file to a scratch path, JS reads each
      // slice through the ordinary channel and stitches them. One chunk exists at a
      // time and is unlinked immediately, so peak extra memory is one chunk, not a
      // second copy of the file.
      debug('webr', 'chunked readFile', { path, size, chunkSize });
      const out = new Uint8Array(size);
      const part = `${path}.ctpart`;
      let offset = 0;
      try {
        while (offset < size) {
          const n = Math.min(chunkSize, size - offset);
          // `seek` on a fresh connection each time: a long-lived connection across
          // await points is state we would have to unwind on every error path.
          await webR.evalRString(
            `local({ .i <- file(${rLit(path)}, "rb"); on.exit(close(.i));`
            + ` seek(.i, where = ${offset}, origin = "start");`
            + ` .b <- readBin(.i, "raw", n = ${n});`
            + ` writeBin(.b, ${rLit(part)}); "ok" })`,
          );
          const slice = await webR.FS.readFile(part);
          if (!slice || !slice.length) throw new Error(`chunked read stalled at ${offset} of ${size}`);
          out.set(slice, offset);
          offset += slice.length;
        }
      } finally {
        try { await webR.evalRString(`{ if (file.exists(${rLit(part)})) unlink(${rLit(part)}); "ok" }`); } catch { /* scratch */ }
      }
      if (offset !== size) throw new Error(`chunked read returned ${offset} bytes, expected ${size}`);
      return out;
    }, 'readFile');
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
    const { injectData = false, variables, captureGraphics = false, injectInputs = null, keepMissing = false } = options;
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
          // Designated missing codes are folded to NA at injection so every analysis
          // honours them centrally (#missing-values) — unless the analysis opts out
          // via `keepMissing` (e.g. Frequencies, which reports the missing breakdown).
          const cols = inputColumns(injectInputs);
          if (cols.length) prelude = await this.#buildInjection(webR, env, cols, !keepMissing);
          prelude += buildInputAliases(injectInputs);
        } else if (injectData) {
          // Raw dataset bind (r-console / manual R) stays raw — the escape hatch.
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
          if (msg.type === 'stderr') stderr.push(safeStr(msg.data));
          else stdout.push(safeStr(msg.data));
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
   * Any plots the code draws are captured (base graphics / printed ggplot) and
   * returned as `ImageBitmap`s for the console to render inline.
   *
   * @param {string} code - One or more R expressions.
   * @returns {Promise<{output: string, error: boolean, images: ImageBitmap[]}>}
   */
  /**
   * Evaluate R for the CONSOLE or for a recorded script (#160).
   *
   * `scope` is an isolation boundary, not a convenience. Both lanes used to evaluate in
   * globalenv, so a "replayable" Run R script step could silently depend on a helper the
   * user had defined in the console — replaying correctly here and differently on a
   * co-author's machine, with no error to point at. An unlogged scratchpad cannot share
   * mutable state with a logged lane and still let that lane call itself reproducible.
   *
   * The asymmetry is deliberate. The console gets its own environment whose PARENT is
   * globalenv: it can read everything a script produced (that is the point of poking at
   * results, and what the reverse-bridge import enumerates), but nothing it defines can
   * reach a script. The recorded lane stays authoritative; the scratchpad stays private.
   *
   * @param {string} code
   * @param {{scope?: 'console'|'global'}} [opts]
   */
  evalConsole(code, { scope = 'console' } = {}) {
    return this.#enqueue(async (webR) => {
      // Run via source(print.eval=TRUE) so visible values auto-print like the R
      // prompt (captureR alone does not echo them). The code is staged to a file
      // to avoid escaping it into an R string; `local=FALSE` evaluates in globalenv
      // so assignments persist across lines.
      await webR.FS.writeFile(CONSOLE_PATH, new TextEncoder().encode(code));
      const shelter = await new webR.Shelter();
      try {
        const console_ = scope === 'console';
        const capture = await shelter.captureR(
          (console_ ? ENSURE_CONSOLE_ENV : '')
          + `source(${rLit(CONSOLE_PATH)}, echo = FALSE, print.eval = TRUE, max.deparse.length = Inf, `
          + `local = ${console_ ? CONSOLE_ENV : 'FALSE'})`,
          { env: webR.objs.globalEnv, captureGraphics: true },
        );
        const out = capture.output.map((m) => safeStr(m.data)).join('\n');
        const hadErr = capture.output.some((m) => m.type === 'stderr');
        return { output: out, error: hadErr, images: capture.images ?? [] };
      } catch (err) {
        // A parse/eval error surfaces as a thrown condition; strip the source() wrapper.
        const msg = String(err?.message ?? err).replace(/\bin eval\b.*$/, '').trim();
        return { output: msg, error: true, images: [] };
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
  consoleBind(columns, multiple, { keepMissing = false } = {}) {
    return this.#enqueue(async (webR) => {
      const G = webR.objs.globalEnv;
      const shelter = await new webR.Shelter();
      try {
        if (!columns || !columns.length) {
          await shelter.captureR(
            `${ENSURE_CONSOLE_ENV}if (exists("vars", envir = ${CONSOLE_ENV}, inherits = FALSE)) rm("vars", envir = ${CONSOLE_ENV})`,
            { env: G },
          );
          return { names: [], multiple: false };
        }
        // `vars` belongs to the console, not to globalenv (#160) — otherwise a recorded
        // script could pick it up and appear to work because of what the user happened
        // to have checked in a panel that is not part of the project.
        const CONSOLE_REF = `get(${JSON.stringify(CONSOLE_ENV)}, envir = globalenv())`;
        const assign = multiple
          ? `assign("vars", .d, envir = ${CONSOLE_REF})`
          : `assign("vars", .d[[1]], envir = ${CONSOLE_REF})`;

        // Prefer the Parquet bridge (native types); fall back to JS arrays.
        // Fold designated missing codes to NA by DEFAULT — the same treatment a plugin's
        // bound variables get (#159). This path used to bind raw values, so the console,
        // which exists partly so plugin authors can prototype, handed out data that
        // differed from what their code would receive in a plugin. `loader.js` documented
        // the console as never stripped while `r-console.js` documented it as mirroring
        // the plugin contract; both could not be true.
        const applyMissing = !keepMissing;
        if (this.#getInjectionParquet && (await this.#ensureNanoparquet(webR))) {
          const bytes = await this.#getInjectionParquet({ variables: columns, applyMissing });
          if (bytes && bytes.byteLength) {
            await webR.FS.writeFile(INJECT_PATH, bytes);
            await shelter.captureR(
              ENSURE_CONSOLE_ENV
              + `local({ .d <- as.data.frame(nanoparquet::read_parquet(${rLit(INJECT_PATH)}), check.names = FALSE); ${assign} })`,
              { env: G },
            );
            return { names: columns, multiple };
          }
        }
        const rawCols = await this.#getColumns({ variables: columns, applyMissing });
        const cols = {};
        for (const [k, v] of Object.entries(rawCols)) {
          cols[k] = Array.from(v, (x) => (typeof x === 'number' && Number.isNaN(x) ? null : x));
        }
        await shelter.captureR(
          ENSURE_CONSOLE_ENV
          + `local({ .d <- as.data.frame(.crosstab_data, stringsAsFactors = FALSE, check.names = FALSE); ${assign} })`,
          { env: { '.crosstab_data': cols } },
        );
        return { names: columns, multiple };
      } finally {
        await shelter.purge();
      }
    }, 'consoleBind');
  }

  /**
   * Bind a data.frame built from the given columns into the persistent global env
   * under `name` (e.g. `data`) — used by "Run R script" so a user's script can
   * reference the active dataset. Mirrors {@link WebRManager#consoleBind} but with a
   * caller-chosen name, always a data.frame. Pass no columns to remove it.
   *
   * @param {string} name - R variable name to assign in globalenv.
   * @param {string[]} columns - Variable names to include as columns.
   * @returns {Promise<{name:string, columns:string[]}>}
   */
  bindGlobalFrame(name, columns, { keepMissing = false } = {}) {
    return this.#enqueue(async (webR) => {
      const G = webR.objs.globalEnv;
      const shelter = await new webR.Shelter();
      try {
        if (!columns || !columns.length) {
          await shelter.captureR(`if (exists(${rLit(name)}, envir = globalenv())) rm(list = ${rLit(name)}, envir = globalenv())`, { env: G });
          return { name, columns: [] };
        }
        const target = `assign(${rLit(name)}, .d, envir = globalenv())`;
        // Same default as a plugin and as the console (#159): `data` arrives with
        // designated missing codes already NA. A user script is a plugin rehearsal too,
        // and having the two disagree is how a script that looks right here returns
        // different numbers once it is a plugin.
        const applyMissing = !keepMissing;
        // Prefer the Parquet bridge (native types); fall back to JS arrays.
        if (this.#getInjectionParquet && (await this.#ensureNanoparquet(webR))) {
          const bytes = await this.#getInjectionParquet({ variables: columns, applyMissing });
          if (bytes && bytes.byteLength) {
            await webR.FS.writeFile(INJECT_PATH, bytes);
            await shelter.captureR(
              `local({ .d <- as.data.frame(nanoparquet::read_parquet(${rLit(INJECT_PATH)}), check.names = FALSE); ${target} })`,
              { env: G },
            );
            return { name, columns };
          }
        }
        const rawCols = await this.#getColumns({ variables: columns, applyMissing });
        const cols = {};
        for (const [k, v] of Object.entries(rawCols)) {
          cols[k] = Array.from(v, (x) => (typeof x === 'number' && Number.isNaN(x) ? null : x));
        }
        await shelter.captureR(
          `local({ .d <- as.data.frame(.crosstab_data, stringsAsFactors = FALSE, check.names = FALSE); ${target} })`,
          { env: { '.crosstab_data': cols } },
        );
        return { name, columns };
      } finally {
        await shelter.purge();
      }
    }, 'bindGlobalFrame');
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

  /** @returns {boolean} True if the runtime crashed and needs a restart. */
  get isCrashed() {
    return this.#crashed;
  }

  /**
   * Restart the R subsystem: tear down the (possibly crashed) worker and reset so
   * the next job cold-starts a fresh one. Everything outside WebR — datasets,
   * projects, output — is untouched; only installed R packages and the R Console's
   * variables are lost (they re-install / can be redefined on demand). Much less
   * destructive than a full page reload. Tolerant of a dead worker.
   *
   * @returns {Promise<void>}
   */
  async restart() {
    this.#crashed = false;
    this.#nanoparquet = undefined;
    const webR = this.#webR;
    this.#webR = null;
    this.#initPromise = null;
    this.#queue = Promise.resolve();
    if (webR) {
      try {
        await webR.close();
      } catch {
        /* a crashed worker may not close cleanly — that's fine, we're discarding it */
      }
    }
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
  async #buildInjection(webR, env, variables, applyMissing = false) {
    const opts = { ...(variables ? { variables } : {}), applyMissing };

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
    // After a fatal error the worker is unusable; fail fast with a clear message
    // rather than letting every call throw a different cryptic error. Re-offer the
    // restart each attempt, so dismissing it once isn't a dead end.
    if (this.#crashed) {
      this.#bus.emit(CoreEvents.WEBR_CRASHED);
      throw new Error('R stopped after running out of memory — restart R to continue (your data and output are kept).');
    }
    const webR = await this.#ensureReady();
    this.#bus.emit(CoreEvents.WEBR_JOB, { id, kind, status: 'started' });
    try {
      const value = await task(webR);
      this.#bus.emit(CoreEvents.WEBR_JOB, { id, kind, status: 'finished' });
      return value;
    } catch (err) {
      this.#bus.emit(CoreEvents.WEBR_JOB, { id, kind, status: 'failed', error: err });
      if (!this.#crashed && isFatalRuntimeError(err)) {
        this.#crashed = true;
        this.#bus.emit(CoreEvents.WEBR_CRASHED);
      }
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
    // In self-hosted mode #webrOptions carries baseUrl (runtime payload) + repoUrl
    // (the vendored package mirror), so installs resolve from ./vendor/ too. Empty
    // in cdn mode — WebR then uses its own CDN defaults.
    const webR = new WebR(this.#webrOptions);
    await webR.init();
    if (this.#preload.length) {
      await webR.installPackages(this.#preload, { quiet: true });
    }
    this.#webR = webR;
    this.#bus.emit(CoreEvents.WEBR_READY);
    return webR;
  }
}
