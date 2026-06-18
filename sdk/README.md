# Writing a CrossTab plugin

Everything in CrossTab is a plugin. The core engine has **no** statistical
functionality — even the built-in Analyze menu items are plugins that load
through the same public API, behind the same sandbox, as anything you write.
There is no privileged first-party path. This page is the developer guide; the
formal contract is [`plugin-api.d.ts`](./plugin-api.d.ts).

## A plugin in 30 seconds

A plugin is an ES module that exports a `manifest` and an `activate` function:

```js
/** @type {import('../../sdk/plugin-api.d.ts').PluginManifest} */
export const manifest = {
  id: 'acme-means',
  name: 'Group Means',
  version: '0.1.0',
  apiVersion: '0.1.0',   // must match the engine's MAJOR version
  rPackages: [],         // R deps, pre-installed on activation
};

/** @param {import('../../sdk/plugin-api.d.ts').App} app */
export async function activate(app) {
  await app.menus.register({
    path: ['Analyze', 'Compare Means'],
    label: 'Means…',
    command: () => runMeans(app),
  });
}
```

`activate` receives the `app` object — the **only** way to talk to the engine.
If a capability is not on `app`, your plugin cannot reach it.

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
| `app.data`     | Read the dataset, variable metadata, and the user's selection.       |
| `app.webr`     | Run R code (queued, serial) and install R packages.                  |
| `app.results`  | Append SPSS-style tables, plots, and notes to the results pane.      |
| `app.ui`       | Ask the engine to show dialogs (you can't draw your own).            |
| `app.menus`    | Register menu items.                                                 |
| `app.events`   | Publish/subscribe on the app-wide event bus.                         |
| `app.plugin`   | Your manifest, plus the effective `apiVersion`.                      |

### Reading data

```js
const meta   = await app.data.getVariableMeta();        // labels, types, valueLabels…
const cols   = await app.data.getColumns(['income']);   // { income: Float64Array }
const chosen = await app.data.getSelectedVariables();   // what the user highlighted
const off    = await app.data.onDataChanged(() => {});  // subscribe; await off() to stop
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

### Producing output

Compute in R, then render clean tables yourself (the pane is for SPSS-style
output, not console text):

```js
await app.results.beginSection('Linear Regression');
await app.results.appendTable(`<table><caption>Coefficients</caption>…</table>`);
await app.results.appendText('*Dependent variable:* income');
```

The pane lives in a shadow root with a built-in stylesheet, so a plain `<table>`
already looks the part. **Your HTML is sanitised** (allowlist) before insertion,
so `<script>`, event handlers, and external references are stripped — keep to
tables, basic formatting, and simple inline SVG.

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
