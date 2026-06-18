/**
 * CrossTab Plugin API — type definitions.
 *
 * This file is the formal contract between the engine and a plugin. A plugin is
 * an ES module that exports a {@link PluginManifest} and an {@link activate}
 * function; `activate` receives an {@link App} object, which is the ONLY way a
 * plugin may talk to the engine.
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
  /** Subscribe to dataset replacement/mutation. Resolves to an unsubscribe fn. */
  onDataChanged(fn: (summary: { rowCount: number; variables: string[] }) => void): Promise<Disposer>;
  /** Subscribe to selection changes. Resolves to an unsubscribe fn. */
  onSelectionChanged(fn: (names: string[]) => void): Promise<Disposer>;
}

/** Append-style output into the results pane. Fragments should be pre-rendered
 * and SPSS-like; the pane sanitises and styles them. */
export interface ResultsApi {
  /** Start a titled section; later appends nest under it. */
  beginSection(title: string): Promise<void>;
  /** Append a pre-rendered HTML table (or fragment). Sanitised by the host. */
  appendTable(htmlString: string): Promise<void>;
  /** Append a plot as an SVG string. Sanitised by the host. */
  appendPlot(svgString: string): Promise<void>;
  /** Append a note written in a small Markdown subset. */
  appendText(markdown: string): Promise<void>;
  /** Append an error block. */
  appendError(message: string): Promise<void>;
  /** Clear all output. */
  clear(): Promise<void>;
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

/** A menu entry contributed by a plugin. */
export interface MenuItem {
  /** Menu hierarchy, top-level first, e.g. `["Analyze", "Regression"]`. */
  path: string[];
  /** Visible item text, e.g. `"Linear…"`. */
  label: string;
  /** Invoked when chosen (runs in the plugin sandbox). */
  command: () => void;
  /** Stable id; re-registering the same id replaces the item. */
  id?: string;
  /** Sort weight within its submenu (lower first). Default 100. */
  order?: number;
}

/** Register menu entries. Resolves to a disposer (also auto-run on unload). */
export interface MenusApi {
  register(item: MenuItem): Promise<Disposer>;
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
  /** Show a modal variable picker; resolves to the chosen names, or `null` if
   * the user cancels. */
  selectVariables(options?: SelectVariablesOptions): Promise<string[] | null>;
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

/** The request the engine passes to an importer's {@link Importer.parse}. */
export interface ImportRequest {
  /** Opaque token identifying this import; pass it back to `deliver`. */
  ticket: number;
  /** The chosen file's name (use it to pick a delimiter, etc.). */
  name: string;
  /** The uploaded file as a `File`/`Blob` handle — passed by reference, so even a
   * large upload isn't copied into your sandbox. JS parsers call
   * `await file.arrayBuffer()`; runtime parsers stage it with
   * `app.webr.mountFile(file)`. */
  file: Blob;
}

/** An importer registration. */
export interface Importer {
  /** Menu label under File ▸ Import, e.g. `"CSV…"`. */
  label: string;
  /** File extensions handled, with the dot, e.g. `[".csv"]` or
   * `[".sav", ".dta", ".sas7bdat"]`. Used for the picker's accept filter. */
  extensions: string[];
  /** Called by the engine (in your sandbox) with the chosen file's bytes. Parse
   * them and call {@link ImportersApi.deliver} with the result. Return value is
   * ignored — delivery is via `deliver`, so async work is fine. */
  parse: (request: ImportRequest) => void;
  /** Stable id (defaults to `label`). */
  id?: string;
  /** Sort weight within File ▸ Import (lower first). Default 100. */
  order?: number;
}

/**
 * File import as an extension point. Register an importer and the engine adds a
 * File ▸ Import menu item, shows the picker, and commits what you deliver — so a
 * third-party format is a first-class citizen, same as the built-in CSV importer.
 */
export interface ImportersApi {
  /** Register an importer; resolves to a disposer (also auto-run on unload). */
  register(importer: Importer): Promise<Disposer>;
  /** Deliver a parsed dataset for the given request `ticket`. */
  deliver(ticket: number, dataset: ImportedDataset): Promise<void>;
}

/** App-wide publish/subscribe. Payloads must be structured-cloneable. */
export interface EventsApi {
  /** Subscribe; resolves to an unsubscribe fn (also auto-run on unload). */
  on(eventName: string, fn: (payload: unknown) => void): Promise<Disposer>;
  /** Emit an event to the host bus. */
  emit(eventName: string, payload?: unknown): Promise<void>;
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
  readonly data: DataApi;
  readonly results: ResultsApi;
  readonly webr: WebrApi;
  readonly menus: MenusApi;
  readonly ui: UiApi;
  readonly importers: ImportersApi;
  readonly events: EventsApi;
}

/** A plugin's manifest, exported from its entry module. */
export interface PluginManifest {
  /** Globally unique, stable id, e.g. `"builtin-frequencies"`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The plugin's own semver version. */
  version: string;
  /** Engine API version targeted, e.g. `"0.1.0"`. Major must match the engine. */
  apiVersion: string;
  /** R packages the plugin needs; pre-installed on activation. */
  rPackages?: string[];
}

/** The shape of a plugin entry module. */
export interface PluginModule {
  manifest: PluginManifest;
  activate(app: App): void | Promise<void>;
}
