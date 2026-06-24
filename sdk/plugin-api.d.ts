/**
 * CrossTab Plugin API — type definitions.
 *
 * This file is the formal contract between the engine and a plugin. A plugin is an
 * ES module that exports a {@link PluginManifest}. It then either exports an
 * `activate(app)` function (imperative) and/or — the common path — declares its
 * extension points in the manifest (`menu`/`imports`/`exports`/`outputExports`/
 * `codecs`/`workspaces`) and exports the named functions they reference. Either
 * way the {@link App} object is the ONLY way a plugin talks to the engine.
 *
 * Extension points, all in {@link PluginManifest}:
 *  - **Analyses** — `menu` actions that gather `inputs` and run R / write Output.
 *  - **File import/export** — one-shot `imports`/`exports`, or streaming `codecs`
 *    (the large-file path; see {@link CodecSpec}/{@link CodecApi}).
 *  - **Output export** — `outputExports` (turn the Output pane into a report).
 *  - **Workspaces** — `workspaces` + a `workspace` module (a full sandboxed tab;
 *    see {@link WorkspaceModule}/{@link WorkspaceStateApi}).
 *
 * ## Everything is async
 * Every plugin runs in a sandboxed iframe and reaches the engine over
 * `postMessage`. There is no in-process path — the built-in analyses use this
 * same boundary. Consequently **every method on `app` returns a `Promise`**,
 * even ones that look like simple getters (`app.data.getRowCount()` is a
 * `Promise<number>`). Always `await`. Values that cross the boundary must be
 * structured-cloneable; plain data, typed arrays, and `ImageBitmap`s are fine,
 * arbitrary class instances and DOM nodes are not.
 *
 * @packageDocumentation
 */

/** Storage/semantics of a variable. */
export type VariableType = "numeric" | "string" | "factor";

/** SPSS-style measurement level. */
export type MeasurementLevel = "nominal" | "ordinal" | "scale";

/** Metadata describing one variable (column), modelled on Haven/SPSS. */
export interface VariableMeta {
  /** Machine name / column id. Unique within the dataset. */
  name: string;
  /** Human-readable description shown in the UI. */
  label?: string;
  /** How the column is stored and interpreted. */
  type: VariableType;
  /** Code → label map, e.g. `{ 1: "Low", 2: "Medium", 3: "High" }`. */
  valueLabels?: Record<string | number, string>;
  /** User-defined missing sentinels, e.g. `[-99, -98]`. */
  missingValues?: Array<number | string>;
  /** Analytic role of the variable. */
  measurementLevel?: MeasurementLevel;
}

/** One row of the dataset in the row-oriented public view. */
export type DataRow = Record<string, number | string | null>;

/** Options accepted by data accessors that can be scoped to some variables. */
export interface VariableScope {
  /** Restrict (and reorder) to these variable names. Defaults to all. */
  variables?: string[];
}

/** A function that removes a subscription/registration. */
export type Disposer = () => Promise<void>;

/** Read-mostly access to the canonical dataset. */
export interface DataApi {
  /** Current dataset as row objects: `[{ col: val }, ...]`. */
  getDataFrame(opts?: VariableScope): Promise<DataRow[]>;
  /**
   * Current dataset in columnar form: `{ name: array }`. Numeric columns arrive
   * as `Float64Array` (missing = `NaN`); other columns as `Array<string|null>`.
   */
  getColumns(opts?: VariableScope): Promise<Record<string, Float64Array | Array<string | null>>>;
  /** Variable metadata, in display order. */
  getVariableMeta(opts?: VariableScope): Promise<VariableMeta[]>;
  /** Names of variables the user has highlighted in the UI. */
  getSelectedVariables(): Promise<string[]>;
  /** Number of cases (rows). */
  getRowCount(): Promise<number>;
  /** Largest UTF-8 byte length per column among `names` — for sizing fixed-width
   * exports (e.g. SPSS `.sav` / Stata `.dta` string fields). Resolves to
   * `{ name: maxBytes }`. */
  maxOctetLengths(names: string[]): Promise<Record<string, number>>;
  /** The dataset's **data transform log** — data-only ops (recodes, computes,
   * case filters), not the source load/append/join — the record a reproducible
   * script reads. */
  getTransforms(): Promise<object[]>;
  /** The full ordered operation history (`{ applied }`): sources *and* transforms
   * in applied order — what the History panel shows and the R-syntax export walks. */
  getHistory(): Promise<{ applied: object[] }>;
  /** Emit a **derived dataset** (e.g. bootstrap resamples, simulated draws,
   * predictions) as a new dataset in the workspace; by default it becomes active,
   * so it can immediately be plotted/described/exported like any other. Resolves
   * to the new dataset's id. Same shape as an importer delivers. */
  create(dataset: {
    name?: string;
    variables: VariableMeta[];
    columns?: Record<string, Array<number | string | null>>;
    parquet?: Uint8Array;
    activate?: boolean;
  }): Promise<number>;
}

/** Options for {@link ResultsApi.appendPlot}. */
export interface AppendPlotOptions {
  /** Called when the user clicks "Redraw at this size", with the plot box's
   * current content size in CSS pixels. Re-render at these dimensions (e.g.
   * `svglite` at `width/96 × height/96` inches) and call
   * {@link ResultsApi.updatePlot} with the new SVG. */
  onRedraw?: (widthPx: number, heightPx: number) => void;
}

/** Append-style output into the results pane. Fragments should be pre-rendered
 * and SPSS-like; the pane sanitises and styles them. */
export interface ResultsApi {
  /** Open a titled, **host-attributed** output section for plugin-driven output
   * (e.g. a workspace's own buttons); the host stamps attribution so a plugin can't
   * mislabel its output. Pair with {@link ResultsApi.endAnalysis}. Declarative
   * `menu` actions get their section opened automatically, so they don't call this. */
  beginAnalysis(title: string): Promise<void>;
  /** Close the section opened by {@link ResultsApi.beginAnalysis}. */
  endAnalysis(): Promise<void>;
  /** Append a pre-rendered HTML table (or fragment). Sanitised by the host. */
  appendTable(htmlString: string): Promise<void>;
  /** Append a plot as an SVG string. Sanitised by the host. Resolves to a *handle*
   * for {@link ResultsApi.updatePlot}. The plot is shown in a user-resizable box;
   * pass `options.onRedraw` to offer a "Redraw at this size" button that re-renders
   * the plot at the box's current pixel dimensions (the only way to truly change
   * the plot's aspect ratio — dragging alone just scales the SVG). */
  appendPlot(svgString: string, options?: AppendPlotOptions): Promise<number>;
  /** Replace a previously appended plot's SVG in place (keeps the box size), e.g.
   * after an `onRedraw` re-render. No-op for an unknown handle. */
  updatePlot(handle: number, svgString: string): Promise<void>;
  /** Append a note written in a small Markdown subset. */
  appendText(markdown: string): Promise<void>;
  /** Append an error block. */
  appendError(message: string): Promise<void>;
  /** The current Output result model (the ordered blocks: sections/tables/plots/
   * text/errors) — e.g. for an output exporter to render to HTML/Word. */
  getModel(): Promise<object[]>;
  /** The Output pane's CSS, so an exported report matches the on-screen styling. */
  getStyles(): Promise<string>;
  /** A previously appended plot rendered to PNG bytes, by its plot id — for report
   * formats that can't embed SVG. Resolves `null` for an unknown id. */
  getPlotPng(id: number | string): Promise<Uint8Array | null>;
}

/** Result of a {@link WebrApi.run} call. */
export interface RunResult {
  /** The R return value converted to JS (`toJs()`), or `null` if unconvertible.
   * Make the last expression of your code a list/data.frame for clean output. */
  result: unknown;
  /** Captured stdout, lines joined by `\n`. */
  output: string;
  /** Captured stderr (messages/warnings), joined. */
  stderr: string;
  /** Captured plots, if `captureGraphics` was set; otherwise empty. */
  images: ImageBitmap[];
}

/** Options for {@link WebrApi.run}. */
export interface RunOptions {
  /** Bind the current dataset as an R `data.frame` named `df` before running.
   * Injection happens host-side; the data never enters the plugin sandbox. */
  injectData?: boolean;
  /** When injecting, restrict to these columns (defaults to all). */
  variables?: string[];
  /** Capture base-graphics plots as `ImageBitmap`s. */
  captureGraphics?: boolean;
}

/** Execute R in the shared WebR runtime. Calls are queued and run serially. */
export interface WebrApi {
  /** Run R code; resolves with structured output. */
  run(rCode: string, options?: RunOptions): Promise<RunResult>;
  /** Install R packages into the running session. */
  installPackages(packages: string[]): Promise<void>;
  /** Write bytes into WebR's virtual filesystem. Note the ~128 MB practical
   * limit; for large uploads prefer {@link WebrApi.mountFile}. */
  writeFile(path: string, data: Uint8Array | ArrayBuffer): Promise<void>;
  /** Read a file from WebR's virtual filesystem as bytes (e.g. pull back a
   * Parquet snapshot written in R). */
  readFile(path: string): Promise<Uint8Array>;
  /** Mount a `File`/`Blob` into WebR's filesystem (WORKERFS) and resolve with the
   * path to it. Lazy and copy-free — the bytes are read on demand, so this has no
   * ~128 MB limit. The preferred way to stage a large upload for R to read.
   * Unmount with {@link WebrApi.unmount} when done. */
  mountFile(file: Blob, name?: string): Promise<string>;
  /** Unmount a path previously returned by {@link WebrApi.mountFile}. */
  unmount(path: string): Promise<void>;
}

/** Options for {@link UiApi.selectVariables}. */
export interface SelectVariablesOptions {
  title?: string;
  /** Sub-heading explaining the choice. */
  hint?: string;
  /** Allow multiple selection (checkboxes) vs. single (radios). Default true. */
  multiple?: boolean;
  /** Variable names checked initially. Defaults to the sidebar selection. */
  preselect?: string[];
  /** Restrict the list to these variable types. */
  types?: VariableType[];
  okLabel?: string;
}

/**
 * Host-rendered dialogs. A sandboxed plugin cannot draw onto the host page, so
 * it asks the engine to show UI and awaits the result.
 */
export interface UiApi {
  /** Show a modal variable picker over the *loaded dataset*; resolves to the
   * chosen names, or `null` if the user cancels. */
  selectVariables(options?: SelectVariablesOptions): Promise<string[] | null>;
  /** Show a modal, searchable multi-select over an arbitrary caller-supplied list
   * (e.g. a file's variable catalog *before* import, which can be thousands of
   * entries). Resolves to the chosen `value`s, or `null` if cancelled. */
  selectFromList(options?: SelectFromListOptions): Promise<string[] | null>;
  /** Show a modal form of labelled text inputs (the general options dialog — e.g.
   * a FRED importer asking for a series id and API key). Resolves to a
   * `{ [fieldName]: value }` map, or `null` if the user cancels. */
  showForm(options?: ShowFormOptions): Promise<Record<string, string> | null>;
}

/** One input in a {@link UiApi.showForm} dialog. */
export interface FormField {
  /** Key the entered value is returned under. */
  name: string;
  /** Visible label (defaults to `name`). */
  label?: string;
  /** Input type. `password` masks the value. Default `text`. */
  type?: "text" | "password" | "number";
  /** Initial value. */
  value?: string;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Small helper text beside the label. */
  hint?: string;
}

/** Options for {@link UiApi.showForm}. */
export interface ShowFormOptions {
  title?: string;
  /** Sub-heading explaining the form. */
  hint?: string;
  /** The fields to render, in order. */
  fields: FormField[];
  okLabel?: string;
}

/** Options for {@link UiApi.selectFromList}. */
export interface SelectFromListOptions {
  title?: string;
  /** Sub-heading explaining the choice. */
  hint?: string;
  /** Candidate items. `value` is returned; `label` is shown (defaults to value). */
  items: Array<{ value: string; label?: string }>;
  /** Allow multiple selection (checkboxes) vs. single (radios). Default true. */
  multiple?: boolean;
  okLabel?: string;
  searchPlaceholder?: string;
}

/** A parsed dataset an importer hands back to the engine. Provide ONE of
 * `columns` (JS-parsed) or `parquet` (R-parsed / large); `variables` always
 * carries the SPSS-style metadata, since neither columns nor Parquet convey it. */
export interface ImportedDataset {
  /** Column metadata, in display order. */
  variables: VariableMeta[];
  /** Columnar values: `{ name: array }`. Numeric → numbers (missing = `null`),
   * text/factor → strings (missing = `null`). Use plain arrays. */
  columns?: Record<string, Array<number | string | null>>;
  /** Parquet file bytes (e.g. written by R/`haven`). DuckDB reads it directly. */
  parquet?: Uint8Array;
}

/** The argument the engine passes to a declarative importer's `parse(app, req)`
 * function (`manifest.imports[].parse`). The function returns an
 * {@link ImportedDataset}; the host commits it. */
export interface ImportRequest {
  /** The chosen file's name (use it to pick a delimiter, etc.). Absent for a
   * `"web"` importer. */
  name?: string;
  /** The uploaded file as a `File`/`Blob` handle — passed by reference, so even a
   * large upload isn't copied into your sandbox. JS parsers call
   * `await file.arrayBuffer()`. Absent for a `"web"` importer. */
  file?: Blob;
  /** For a `stage` importer: the host-mounted WebR path to the upload (read it in R
   * directly; the upload is never cloned into the sandbox). In place of `file`. */
  path?: string;
}

/** Where an importer's data comes from. `"file"` (default) opens a picker;
 * `"web"` fetches its own bytes (via {@link WebApi}) and gets no file. */
export type ImporterSource = "file" | "web";

/** Response from {@link WebApi.get}. */
export interface WebResponse {
  /** True for a 2xx status. */
  ok: boolean;
  /** HTTP status code. */
  status: number;
  /** Response body as text (parse JSON yourself with `JSON.parse`). */
  text: string;
}

/**
 * Fetch data over the network from inside a plugin. The engine performs the
 * `fetch` host-side; only `http(s)` URLs are allowed. Useful for `"web"`
 * importers (e.g. pulling a series from an economic-data API). Note: many APIs
 * are not CORS-enabled and must be routed through a CORS proxy.
 */
export interface WebApi {
  /** GET a URL and resolve with `{ ok, status, text }`. Rejects on a network
   * error (e.g. CORS block) just like `fetch`. */
  get(url: string): Promise<WebResponse>;
}

/** The file an exporter hands back to the engine to download. */
export interface ExportPayload {
  /** Suggested download filename, e.g. `"data.csv"`. */
  filename: string;
  /** MIME type, e.g. `"text/csv;charset=utf-8"`. */
  mimeType: string;
  /** File contents — text or bytes. */
  data: string | Uint8Array | ArrayBuffer;
}

/** Identity of the running plugin, surfaced back to it. */
export interface PluginIdentity extends PluginManifest {
  /** The engine API version actually in effect. */
  apiVersion: string;
}

/**
 * The engine surface handed to every plugin. This is the entire contract: if it
 * is not on this object, a plugin cannot reach it. Every method is async.
 */
export interface App {
  readonly plugin: PluginIdentity;
  /** Read the dataset. */
  readonly data: DataApi;
  /** Write to the Output pane. */
  readonly results: ResultsApi;
  /** Run R. */
  readonly webr: WebrApi;
  /** Host-rendered dialogs. */
  readonly ui: UiApi;
  /** Host-side network fetch. */
  readonly web: WebApi;
  /** Workspace state (#93) — **present only for a workspace plugin's `mount`**.
   * The host persists this opaque blob with the project. See {@link WorkspaceStateApi}. */
  readonly state?: WorkspaceStateApi;
  /** Streaming codec surface (#98) — **present only during a codec read/write
   * invocation**. See {@link CodecApi}. */
  readonly codec?: CodecApi;
}

// NOTE: extension points (menus/imports/exports/outputExports/codecs/workspaces)
// are NOT methods on `app` — you declare them in the manifest and the host wires
// them. The runtime `app` surface above is the *only* thing a plugin can call.

/**
 * A plugin's manifest, exported from its entry module.
 *
 * Plugins are **declarative**: you declare your extension points in the manifest
 * (`menu`/`imports`/`exports`/`outputExports`/`codecs`/`workspaces`) and export the
 * named functions they reference. The host does all the wiring — it builds the menu
 * items, gathers an action's `inputs` with its own dialogs, binds them into R, and
 * opens the Output section + attribution for you. There is **no** imperative
 * registration surface (`app` has no `menus.register`/`importers.register`/…); the
 * runtime `app` object is read-data / run-R / write-output / prompt / fetch only.
 * There is no `activate` entry point either — a plugin is purely its `manifest`
 * plus the named functions it references (R deps go in `manifest.rPackages`, which
 * the host pre-installs).
 */
export interface PluginManifest {
  /** Globally unique, stable id, e.g. `"builtin-frequencies"`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The plugin's own semver version. */
  version: string;
  /** Engine API version targeted, e.g. `"0.1.0"`. Major must match the engine. */
  apiVersion: string;
  /** R packages the plugin needs; pre-installed on activation **and** picked up by
   * the offline "Make available offline" closure. Declare every package you use. */
  rPackages?: string[];
  /** Grouping shown in the launcher's plugin picker, e.g. `"Regression"`. The
   * categories `"Import"`/`"Export"`/`"Data"` are treated as infrastructure and
   * default-on. */
  category?: string;
  /** Search keywords for the picker. */
  keywords?: string[];
  /** Disciplines this plugin is pinned under in the launcher (e.g. `["Sociology"]`). */
  disciplines?: string[];
  /** Declarative analysis actions → menu items (the general analysis API). */
  menu?: MenuAction[];
  /** Declarative file importers (one-shot; for the streaming large-file path use
   * `codecs`). */
  imports?: ImportSpec[];
  /** Declarative data exporters (one-shot; for streaming use `codecs`). */
  exports?: ExportSpec[];
  /** Declarative **output** exporters — turn the Output pane (results, not data)
   * into a report format (HTML, Word). */
  outputExports?: OutputExportSpec[];
  /** Declarative streaming **format codecs** (#98) — a unified read/write per file
   * format that streams, so it survives multi-GB files. See {@link CodecSpec}. */
  codecs?: CodecSpec[];
  /** Declarative **workspace** tabs (#93) — a full sandboxed UI pane. See
   * {@link WorkspaceSpec} and the `workspace` module export. */
  workspaces?: WorkspaceSpec[];
}

// --- Declarative analysis model (manifest.menu) ------------------------------

/** The kind of an analysis input the host gathers before invoking the action. */
export type InputKind = "variables" | "number" | "text" | "choice" | "file";

/** One declared input on a {@link MenuAction}. The host renders the right dialog,
 * then passes the gathered value to the action function under `name`, and (except
 * `file`) binds it into R for `webr.run`. */
export interface InputSpec {
  /** Key the gathered value is delivered/bound under. */
  name: string;
  /** What to gather. Default `"variables"`. */
  kind?: InputKind;
  /** Visible label (defaults to `name`). */
  label?: string;
  /** Why this input is needed — shown in the picker. */
  hint?: string;
  /** Treat as optional (don't abort the action if skipped). */
  optional?: boolean;
  /** (`variables`) allow several; delivered as `string[]` vs a single `string`. */
  multiple?: boolean;
  /** (`variables`) restrict the picker to these variable types. */
  types?: VariableType[];
  /** (`variables`) exclude variables already chosen by an earlier `unique` input. */
  unique?: boolean;
  /** (`number`/`text`/`choice`) initial value. */
  default?: string | number;
  /** (`choice`) the options to choose from. */
  options?: Array<{ value: string; label?: string } | string>;
  /** (`file`) accepted extensions for the picker, with the dot, e.g. `[".geojson"]`. */
  extensions?: string[];
}

/** A declarative analysis action: a menu item that gathers `inputs` then calls the
 * exported `run` function. */
export interface MenuAction {
  /** Menu item label, e.g. `"Frequencies…"`. (Placement under a category comes
   * from `manifest.category`; the host owns top-level menu structure.) */
  label: string;
  /** Name of the exported function to invoke: `export async function run(app, inputs)`
   * where `inputs` is `{ [inputName]: value }`. Inputs of kind `variables`/`number`/
   * `text` are also bound into R as `df`/named vars for `app.webr.run`. */
  run: string;
  /** Inputs to gather (with host dialogs) before invoking `run`. */
  inputs?: InputSpec[];
  /** Sort weight within the category (lower first). */
  order?: number;
}

// --- Declarative import / export / output-export specs -----------------------

/** A declarative importer (manifest.imports). The named `parse(app, req)` function
 * gets an {@link ImportRequest} and **returns** an {@link ImportedDataset}; the host
 * commits it. For a `stage` importer it receives a host-mounted WebR `path` instead
 * of `file` (the upload is never cloned into the sandbox). */
export interface ImportSpec {
  label: string;
  /** Exported function name: `export async function parse(app, { name, file, path })`. */
  parse: string;
  source?: ImporterSource;
  extensions?: string[];
  /** Host-mount a large upload into WebR and pass its `path` (no `file`). */
  stage?: boolean;
  multiple?: boolean;
  order?: number;
  id?: string;
}

/** A declarative data exporter (manifest.exports). The named `export` function
 * returns an {@link ExportPayload} (`{ filename, mimeType, data }`). Read the
 * dataset via `app.data`. */
export interface ExportSpec {
  label: string;
  /** Exported function name: `export async function exportFn(app)`. */
  export: string;
  extensions?: string[];
  order?: number;
  id?: string;
}

/** A declarative **output** exporter (manifest.outputExports) — renders the Output
 * pane to a document. The named function gets `{ title }` and returns an
 * {@link ExportPayload}; read the results with `app.results.getModel()` /
 * `getStyles()` / `getPlotPng()`. */
export interface OutputExportSpec {
  label: string;
  /** Exported function name: `export async function exportFn(app, { title })`. */
  export: string;
  extensions?: string[];
  order?: number;
  id?: string;
}

// --- Streaming format codecs (#98) -------------------------------------------

/**
 * A streaming format codec (manifest.codecs): teaches CrossTab one file format end
 * to end. A `read` decodes a file into the dataset; a `write` encodes the dataset
 * to bytes. Unlike one-shot `imports`/`exports`, a codec **streams** (row batches
 * in, byte chunks out), so it handles multi-GB files the one-shot path can't. Both
 * appear in the unified File ▸ Import data… / Export data… picker.
 *
 * The named functions run in a WASM/worker-capable sandbox and use {@link CodecApi}
 * (`app.codec`):
 *  - `export async function read(app, { name })` — `app.codec.read()`/`size()` to
 *    pull source bytes (host does `Blob.slice`, so a >2 GB file is never cloned),
 *    then `app.codec.begin(variables, storageTypes, opts)` and `app.codec.batch(columns)`
 *    to stream rows into the active dataset. Set `opts.wide` for an ultra-wide file
 *    (out-of-core single-Parquet ingest, no DuckDB table).
 *  - `export async function write(app, info)` — pull rows via the normal `app.data`
 *    and emit bytes with `app.codec.writeChunk(bytes)`; return `{ filename, mimeType }`.
 */
export interface CodecSpec {
  /** Stable id for this codec. */
  id?: string;
  /** Menu/picker label, e.g. `"Parquet (.parquet)…"`. */
  label: string;
  /** Extensions handled, with the dot, e.g. `[".parquet"]`. */
  extensions: string[];
  /** Exported read-function name (omit for a write-only codec). */
  read?: string;
  /** Exported write-function name (omit for a read-only codec). */
  write?: string;
  order?: number;
  /** (read) allow selecting several files at once. */
  multiple?: boolean;
}

/**
 * The streaming surface available **only during a codec read/write** as
 * `app.codec`. Read verbs random-access the source file and push row batches into
 * the host's streaming ingest; write verbs emit output bytes; `loadAsset` fetches a
 * host-allowlisted dependency the sandbox can't reach (`connect-src 'none'`).
 */
export interface CodecApi {
  // read: source access
  /** Total size of the source file, in bytes. */
  size(): Promise<number>;
  /** The source `File`/`Blob` by reference — for codecs that must read it
   * synchronously in their own worker (e.g. ReadStat via `FileReaderSync`). */
  sourceFile(): Promise<Blob>;
  /** Read `length` bytes at `offset` (host does `Blob.slice`, so a huge file is
   * never cloned whole). */
  read(offset: number, length?: number): Promise<Uint8Array>;
  // read: streaming ingest
  /** Declare the schema, then push batches. `opts.rowCount` (if known) drives the
   * progress indicator; `opts.wide` routes to the out-of-core wide ingest. */
  begin(
    variables: VariableMeta[],
    storageTypes: Record<string, "numeric" | "string">,
    opts?: { rowCount?: number; wide?: boolean },
  ): Promise<void>;
  /** Push one column batch `{ name: array }`. Resolves when the host has taken it
   * (backpressure — peak memory stays at one batch). */
  batch(columns: Record<string, Array<number | string | null>>): Promise<void>;
  // write: emit output bytes
  /** Append output bytes the host streams to the download. */
  writeChunk(bytes: Uint8Array | ArrayBuffer): Promise<void>;
  // both: host-provided dependency
  /** Fetch a host-allowlisted dependency by name (a JS lib's source, or WASM
   * bytes) — only host-known names resolve, so a codec can't pull arbitrary code. */
  loadAsset(name: string): Promise<string | Uint8Array>;
}

// --- Workspaces (#93) --------------------------------------------------------

/** A workspace tab (manifest.workspaces): a full, sandboxed UI pane that lives as a
 * workspace tab (e.g. the CAQDAS coding workspace). The plugin also exports a
 * `workspace` module (see {@link WorkspaceModule}). */
export interface WorkspaceSpec {
  /** Stable id; also the key its persisted state is stored under. */
  id: string;
  /** Tab title. */
  title: string;
}

/**
 * The `workspace` module a workspace plugin exports alongside `manifest`:
 * `export const workspace = { mount }`.
 */
export interface WorkspaceModule {
  /**
   * Render the workspace into its tab. `root` is a real element in the plugin's own
   * **visible** sandboxed iframe — build your UI with normal DOM. `app` carries the
   * usual surfaces plus `app.state` (persisted blob) and, for pushing results,
   * `app.results`. **Do not write state during mount** — read `app.state.get()` and
   * only `set()` on a real user change, or a mount-before-hydrate can clobber the
   * saved blob. CSP is `default-src 'none'`: style via the CSSOM, not inline style
   * attributes.
   */
  mount(app: App, root: HTMLElement): void | Promise<void>;
}

/** Workspace state (`app.state`) — an opaque, project-persisted blob the host
 * stores per workspace id but never interprets. Carry your own version stamp. */
export interface WorkspaceStateApi {
  /** The saved blob, or `null` if none yet. */
  get(): Promise<unknown>;
  /** Persist the blob (debounce in the plugin; this marks the project dirty). */
  set(value: unknown): Promise<void>;
}

/**
 * The shape of a plugin entry module: a `manifest` plus the named functions it
 * references. There is no `activate` — the host wires everything from the manifest.
 *
 * The referenced exports are each `export async function name(app, …)`:
 *  - `menu[].run` → `run(app, inputs)`
 *  - `imports[].parse` → `parse(app, { name, file, path })` → {@link ImportedDataset}
 *  - `exports[].export` → `export(app)` → {@link ExportPayload}
 *  - `outputExports[].export` → `export(app, { title })` → {@link ExportPayload}
 *  - `codecs[].read`/`write` → `read(app, { name })` / `write(app, info)` (use `app.codec`)
 * and, for a workspace plugin, a `workspace` module (see {@link WorkspaceModule}).
 */
export interface PluginModule {
  manifest: PluginManifest;
  /** A workspace plugin's render module (when `manifest.workspaces` is set). */
  workspace?: WorkspaceModule;
  /** Plus the named functions the manifest references (see above). */
  [namedExport: string]: unknown;
}
