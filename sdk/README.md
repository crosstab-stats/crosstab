# Writing a CrossTab plugin

Everything in CrossTab is a plugin. The core engine has **no** statistical
functionality — even the built-in Analyze menu items are plugins that load
through the same public API, behind the same sandbox, as anything you write.
There is no privileged first-party path. This page is the developer guide; the
formal contract is [`plugin-api.d.ts`](./plugin-api.d.ts).

## A plugin in 30 seconds

A plugin is an ES module that exports a `manifest` **declaring** its extension
points, plus the named functions they reference. The host does the wiring:

```js
/** @type {import('../../sdk/plugin-api.d.ts').PluginManifest} */
export const manifest = {
  id: 'acme-means',
  name: 'Group Means',
  version: '0.1.0',
  apiVersion: '0.1.0',          // must match the engine's MAJOR version
  category: 'Compare Means',    // where it lands in the menu / plugin picker
  rPackages: [],                // R deps, pre-installed + offline-cached
  menu: [
    {
      label: 'Means…',
      run: 'runMeans',          // the exported function the host calls
      inputs: [
        { name: 'dv',    kind: 'variables', hint: 'Outcome(s) to average.' },
        { name: 'group', kind: 'variables', multiple: false, hint: 'Grouping variable.' },
      ],
    },
  ],
};

/** The host gathers the declared `inputs` with its own dialogs, binds them into R,
 *  opens the (attributed) Output section, then calls this.
 *  @param {import('../../sdk/plugin-api.d.ts').App} app */
export async function runMeans(app, { dv, group }) {
  const { result } = await app.webr.run(`aggregate(...)`); // dv/group are bound in R
  await app.results.appendTable(renderTable(result));
}
```

You declare *what* (a menu item and its inputs); the host handles the picker
dialogs, the R binding, and the Output section. The `app` object passed to your
function is the **only** way to talk to the engine — if a capability isn't on
`app`, you can't reach it. (Extension points like menus/imports/exports are
declared in the manifest, **not** registered through `app`.)

## Everything is async

Your plugin runs in a **sandboxed iframe** and reaches the engine over
`postMessage`. So **every `app` method returns a `Promise`** — even getters:

```js
const n = await app.data.getRowCount();   // Promise<number>, not number
```

Always `await`. Anything you pass across the boundary (R code is just a string,
but event payloads, callback arguments, etc.) must be structured-cloneable.

## The `app` object

| Surface        | What it's for                                                        |
| -------------- | -------------------------------------------------------------------- |
| `app.data`     | Read the dataset, variable metadata, the selection; emit a derived dataset (`create`). |
| `app.webr`     | Run R (queued, serial), install packages, read/write its filesystem. |
| `app.results`  | Append SPSS-style tables, plots, and notes to the Output pane.       |
| `app.ui`       | Ask the engine to show dialogs (you can't draw your own).            |
| `app.web`      | GET a URL host-side (for `"web"` importers).                          |
| `app.plugin`   | Your manifest, plus the effective `apiVersion`.                      |
| `app.state`    | *(workspace plugins)* read/write the project-persisted state blob.   |
| `app.codec`    | *(codecs, during a read/write)* stream source bytes / row batches / output chunks. |

Menus, imports, exports, codecs, and workspaces are **declared in the manifest** —
there's no `app.menus.register`/`app.importers.register`; the host wires them.

### Reading data

```js
const meta   = await app.data.getVariableMeta();        // labels, types, valueLabels…
const cols   = await app.data.getColumns(['income']);   // { income: Float64Array }
const chosen = await app.data.getSelectedVariables();   // what the user highlighted
```

### Asking for input

You cannot create DOM in the host page. Instead, ask the engine to render a
dialog and await the result:

```js
const vars = await app.ui.selectVariables({
  title: 'Frequencies',
  hint: 'Choose one or more variables to tabulate.',
  multiple: true,
});
if (!vars) return; // user cancelled
```

`selectVariables` picks from the *loaded dataset*. To choose from an arbitrary
list you supply — e.g. a file's variable catalog *before* import, which can be
thousands of entries — use `selectFromList` (searchable, returns the chosen
`value`s, or `null` if cancelled):

```js
const chosen = await app.ui.selectFromList({
  title: 'Choose variables',
  items: catalog.map(c => ({ value: c.name, label: c.label })),
  multiple: true,
});
```

### Running R

```js
const { result } = await app.webr.run(
  `
    fit <- lm(income ~ age, data = df)
    co <- summary(fit)$coefficients
    list(terms = rownames(co), estimate = co[, 1], p = co[, 4])
  `,
  { injectData: true, variables: ['income', 'age'] },
);
```

- `injectData: true` binds the current dataset as an R `data.frame` named `df`
  **before** your code runs. Injection happens host-side — the data never enters
  your sandbox. Use `variables` to inject only what you need.
- Calls are **serialised** — there is one R process.
- Make the **last expression** a `list(...)`/`data.frame(...)`; it returns in
  `result` as plain JS. Don't return raw model objects.

Need to move binary data in or out of R? For a **large upload**, mount it
(lazy, copy-free, no size limit) rather than `writeFile` (which has a ~128 MB
practical cap):

```js
const path = await app.webr.mountFile(file);   // file: a File/Blob → WORKERFS mount
await app.webr.run(`d <- haven::read_sav("${path}"); nanoparquet::write_parquet(d, "/tmp/out.parquet")`);
const parquet = await app.webr.readFile('/tmp/out.parquet'); // Uint8Array
await app.webr.unmount(path);
```

`writeFile(path, bytes)` / `readFile(path)` are also available for smaller blobs.
Calls are queued like `run`, so a `mountFile` → `run` → `readFile` sequence stays
ordered. Install R packages you depend on first: `await app.webr.installPackages(['haven'])`.

### Producing output

Compute in R, then render clean tables yourself (the pane is for SPSS-style
output, not console text). For a declarative `menu` action the host has already
opened a titled, attributed section for you — just append:

```js
await app.results.appendTable(`<table><caption>Coefficients</caption>…</table>`);
await app.results.appendText('*Dependent variable:* income');
```

(Pushing output from *outside* an action — e.g. a workspace's own button — bracket
it yourself with `app.results.beginAnalysis('Coding summary')` … `endAnalysis()`;
the host stamps the attribution either way.)

The pane lives in a shadow root with a built-in stylesheet, so a plain `<table>`
already looks the part. **Your HTML is sanitised** (allowlist) before insertion,
so `<script>`, event handlers, and external references are stripped — keep to
tables, basic formatting, and simple inline SVG.

### Importing files

File import is just a plugin. **Declare** an importer in the manifest and export the
named `parse` function; it joins the unified **File ▸ Import data…** picker (a
searchable, grouped list of every enabled format). The engine owns the file picker
and commits whatever your `parse` **returns** — so a new file format is a
first-class citizen, exactly like the built-in CSV codec.

```js
export const manifest = {
  id: 'acme-import', name: 'Acme import', version: '1.0.0', apiVersion: '0.1.0',
  category: 'Import',
  imports: [{ label: 'Acme Survey…', extensions: ['.acme'], parse: 'parseAcme' }],
};

// The engine calls this in your sandbox with the chosen file (a File/Blob by
// reference — not copied in). Parse in JS, or stage into R with
// app.webr.mountFile(file). Return the dataset; the host commits it.
export async function parseAcme(app, { name, file }) {
  const buf = await file.arrayBuffer();
  const { variables, columns } = decode(buf);
  return { variables, columns };
}
```

`parse` **returns** one of two shapes (the dual contract):

- `{ variables, columns }` — columnar JS arrays (`{ name: [...] }`). Best for
  formats you parse in JS. Numeric columns: numbers with `null` for missing;
  text/factor: strings with `null`. Use plain arrays.
- `{ variables, parquet }` — a Parquet `Uint8Array` (e.g. one R wrote via
  `nanoparquet`). DuckDB reads it directly; best for runtime-parsed data.

`variables` is always `VariableMeta[]` — it carries the labels, value labels, and
missing codes that neither columns nor Parquet convey. (A `"web"` importer sets
`source: 'web'`, gets no file, and fetches its own bytes via `app.web.get`.)

One-shot `imports`/`exports` hold the whole dataset in memory, so they're best for
small-to-medium files. For large files (or any format you want to stream), use a
**codec** instead — see "Large files & new formats" below.

### Exporting files

The mirror of importing, and it joins the same unified **File ▸ Export data…**
picker. Read the current (derived, transformed) dataset via `app.data` and return
the bytes:

```js
export const manifest = {
  id: 'acme-export', name: 'Acme export', version: '1.0.0', apiVersion: '0.1.0',
  category: 'Export',
  exports: [{ label: 'Acme (.acme)…', extensions: ['.acme'], export: 'exportAcme' }],
};

export async function exportAcme(app) {
  const meta = await app.data.getVariableMeta();
  const cols = await app.data.getColumns({ variables: meta.map((m) => m.name) });
  return { filename: 'data.acme', mimeType: 'application/octet-stream', data: encode(meta, cols) };
}
```

`data` may be a string or a `Uint8Array`. Need R to produce the bytes (e.g. a
native `.rds`)? Build it in R from `app.data` and read it back with
`app.webr.readFile` — see [`plugins/builtin-rdata-export`](../plugins/builtin-rdata-export/index.js).
To export the **Output pane** (results, not data) as a report, use `outputExports`
instead and read `app.results.getModel()`/`getStyles()`/`getPlotPng()`.

### Large files & new formats: streaming codecs

A **codec** teaches CrossTab one file format end to end — a `read`, a `write`, or
both — and **streams** (row batches in, byte chunks out) instead of holding the
whole dataset in memory. That's the path for multi-GB files (the cumulative GSS
imports this way). Declare it in the manifest; the codec runs in a
WASM/worker-capable sandbox and uses `app.codec`:

```js
export const manifest = {
  id: 'acme-codec', name: 'Acme codec', version: '1.0.0', apiVersion: '0.1.0',
  category: 'Data',
  codecs: [{ id: 'acme', label: 'Acme (.acme)…', extensions: ['.acme'], read: 'readAcme', write: 'writeAcme' }],
};

export async function readAcme(app, { name }) {
  const size = await app.codec.size();
  const head = await app.codec.read(0, 4096);            // random-access source bytes
  await app.codec.begin(variables, storageTypes, { rowCount, wide: false });
  for (const batch of decodeInBatches(app)) await app.codec.batch(batch); // backpressured
}

export async function writeAcme(app) {
  const total = await app.data.getRowCount();
  for (let off = 0; off < total; off += 50000) {
    const rows = await app.data.getRows({ offset: off, limit: 50000 });
    await app.codec.writeChunk(encode(rows));
  }
  return { filename: 'data.acme', mimeType: 'application/octet-stream' };
}
```

`app.codec.read`/`size` random-access the source (the host does `Blob.slice`, so a
>2 GB file is never copied whole); `begin`+`batch` stream rows into the active
dataset (`batch` resolves only once the host has taken it, so peak memory is one
batch); set `begin(..., { wide: true })` for an ultra-wide file (out-of-core
single-Parquet ingest). `loadAsset(name)` fetches a host-allowlisted dependency
(JS lib source or WASM bytes) the sandbox can't reach itself. Reference codecs:
[`builtin-csv-codec`](../plugins/builtin-csv-codec/index.js) (pure JS),
[`builtin-parquet-codec`](../plugins/builtin-parquet-codec/index.js), and
[`builtin-readstat-codec`](../plugins/builtin-readstat-codec/index.js)
(SPSS/Stata/SAS via WASM + an in-sandbox worker).

## Workspaces

A **workspace** is a full, sandboxed UI pane that lives as its own tab (the CAQDAS
coding workspace is the flagship example). Declare it and export a `workspace`
module:

```js
export const manifest = {
  id: 'acme-ws', name: 'Acme workspace', version: '1.0.0', apiVersion: '0.1.0',
  category: 'Workspaces',
  workspaces: [{ id: 'acme-coding', title: 'Coding' }],
};

export const workspace = {
  async mount(app, root) {
    const state = (await app.state.get()) ?? { items: [] }; // rehydrate
    // …build your UI in `root` (a real element in your visible sandboxed iframe)…
    // persist on a real user change (debounced), never during mount:
    saveButton.onclick = () => app.state.set(state);
  },
};
```

`app.state` is an **opaque, project-persisted blob** the host stores per workspace
id but never interprets — carry your own version stamp. The pane can read host data
(`app.data`), run R (`app.webr`), and push results to Output (`app.results`).

> **Don't write state during `mount`.** Read `app.state.get()` and only `set()` in
> response to a genuine user change. A mount-time write can persist an empty default
> over real saved data if the workspace ever mounts before its state is hydrated
> (this caused a real codebook-loss bug). Deriving a default on mount is fine — set
> it in memory and let it persist on the first real edit. CSP is `default-src
> 'none'`: style via the CSSOM (`el.style.*`), not inline `style` attributes.

Reference: [`plugins/builtin-hello-workspace`](../plugins/builtin-hello-workspace/index.js)
(the minimal seam) and [`plugins/builtin-caqdas`](../plugins/builtin-caqdas/index.js)
(the real one).

## Isolation model

**All plugins are equal.** Every plugin — official or third-party — loads the
same way: the engine fetches your entry module's source and runs it inside an
`<iframe sandbox="allow-scripts">`. That gives you a separate JS heap and a
unique opaque origin, so you cannot reach the engine's objects or the host DOM,
and the engine cannot reach yours. All interaction is the async `app` RPC
described above. The built-in Frequencies plugin is subject to exactly this.

Practical implications:

- **Single-file (at runtime).** A blob-imported module can't resolve relative
  `import` specifiers. Author against the `.d.ts` with JSDoc (type-only, erased)
  and keep runtime code in one file, or import from absolute/CDN URLs.
- **No host DOM.** Use `app.ui` for input and `app.results` for output.
- **Untrusted output.** Result HTML/SVG is sanitised; don't rely on scripts or
  custom CSS surviving.

The wire protocol is documented in
[`core/plugin-broker.js`](../core/plugin-broker.js) (host side) and
[`plugin-host.html`](../plugin-host.html) (sandbox side).

## Versioning

`manifest.apiVersion` is checked against the engine at load time: same **major**,
engine **minor** ≥ yours. Bump your `apiVersion` when you start using newly added
API; bump `version` for your own releases.

## Open questions

Deliberately unresolved while the contract settles — feedback welcome:

1. **Major API-version migration** — what a breaking engine bump means for
   already-installed plugins, and whether the engine ships compatibility shims.
2. **R package pre-loading** — which packages ship with the default plugin set
   vs. install on demand, and how plugins share heavy dependencies.
3. **Multi-file plugins** — an import map / bundling story so plugins can split
   across files inside the sandbox.
