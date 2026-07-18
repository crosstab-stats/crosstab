# CrossTab

A browser-based statistical analysis platform for social science researchers — a
web-native alternative to SPSS/Stata that runs on any device (including iPad)
with no installation.

CrossTab runs **R in your browser** via [WebR](https://docs.r-wasm.org/webr/)
(R compiled to WebAssembly) and stores data in
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html). Statistics are
computed by real R; results are rendered as clean, SPSS-style tables. Your data
never leaves the machine.

## What it does

- **60+ analysis plugins** covering the methods social science departments
  actually teach — t-tests, ANOVA, regression, factor analysis, SEM/CFA,
  survival, multilevel, meta-analysis, causal inference, time series, Bayesian,
  nonparametric, and more.
- **Qualitative coding workspace** (CAQDAS) — tag passages, build a codebook,
  export code frequencies. Text analytics (sentiment, TF-IDF, topic modeling).
- **Import anything** — CSV, SPSS (.sav), Stata (.dta), SAS (.sas7bdat),
  Parquet, NDJSON, plain text, or paste a URL. Export to the same formats.
- **Decision support tools** — cost-effectiveness (ICER), decision matrix,
  cost-benefit, expected value, decision trees.
- **Interactive charts** — bar, line, scatter, pie, stacked; colourblind-safe
  palette; reorderable, re-editable, persisted with the project.
- **Reproducible** — every operation (import, recode, compute, cell edit) is an
  ordered, undoable transform over immutable source data. The transform log is
  an exportable script.
- **Do-file editor** — view your analysis history as editable syntax; run it to
  rebuild the dataset and replay analyses.
- **Works offline** — PWA with a "Make available offline" toggle; also supports
  fully air-gapped deployment for sensitive data environments.
- **iPad Safari tested** and working.

## Architecture

The core engine has **zero** statistical functionality. It is pure
infrastructure: a plugin loader, the WebR and DuckDB runtime managers, a data
store, a results renderer, a menu shell, and an event bus. Every analysis,
importer, and exporter is a plugin.

**All plugins are equal.** Every plugin — built-in or third-party — runs in its
own sandboxed `<iframe>` and reaches the engine only over `postMessage`. There is
no privileged loading path. The official content is just the official mod.

**Source data is immutable.** The imported dataset is never overwritten. Every
change is recorded as an ordered transform applied over the immutable source. The
data you analyse is `source + transforms`; the transforms are a log you can
inspect, undo, reorder, and export — in effect, a re-runnable script.

The plugin contract is documented in
[`sdk/README.md`](./sdk/README.md) and
[`sdk/plugin-api.d.ts`](./sdk/plugin-api.d.ts).

## Running locally

Everything is static files and native ES modules — no build step. Serve it over
HTTP (ES modules and service workers don't work from `file://`):

```sh
python -m http.server 8080
# open http://localhost:8080/
```

The bundled `sw.js` injects the COOP/COEP headers needed for cross-origin
isolation (SharedArrayBuffer for WebR). On first load the page registers the
service worker and reloads once; WebR downloads in the background the first time
you run an analysis.

## Deployment

The live instance is on **GitHub Pages** at
[crosstab-stats.github.io/crosstab/](https://crosstab-stats.github.io/crosstab/).

For air-gapped or offline deployment, see [`docs/OFFLINE.md`](./docs/OFFLINE.md).

## Tech

WebR (R via WASM) in a Web Worker · DuckDB-WASM as the data engine, with Apache
Arrow as the bridge · OPFS for dataset persistence · SharedArrayBuffer +
service-worker COI · vanilla JS ES modules (no framework, no build step).

## License

[Unlicense](./LICENSE) (public domain). The ReadStat module under `vendor/readstat/`
is MIT-licensed per its own [`LICENSE.readstat`](./vendor/readstat/LICENSE.readstat).
