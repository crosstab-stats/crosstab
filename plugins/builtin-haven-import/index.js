/**
 * @file plugins/builtin-haven-import/index.js
 * Built-in importer plugin: File ▸ Import ▸ SPSS / Stata / SAS (via R `haven`).
 *
 * This is what makes a real **GSS** extract open in CrossTab — the General Social
 * Survey ships only as SPSS `.sav`, Stata `.dta`, or SAS `.sas7bdat`. It is also
 * the worked example of the heavier importer pattern: parse in R, return Parquet.
 *
 * Flow (all through the public `app` API — nothing imported from `core/`):
 *  1. Stage the uploaded bytes into WebR's filesystem (`app.webr.writeFile`).
 *  2. Run R: `haven::read_*` reads the file; we pull variable labels, value
 *     labels, user-missing and measurement level out of haven's attributes as
 *     JSON; then write the (label-stripped) data to Parquet with `nanoparquet`.
 *  3. Read the Parquet bytes back (`app.webr.readFile`).
 *  4. Deliver `{ variables, parquet }` — the engine loads the Parquet straight
 *     into DuckDB and applies our metadata.
 *
 * haven returns exactly the SPSS/Haven model `VariableMeta` was based on, so
 * labels and missing codes survive the round-trip — the whole point of going
 * through R rather than a thinner reader.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-haven-import',
  name: 'SPSS/Stata/SAS Import',
  version: '0.1.0',
  apiVersion: '0.1.0',
  // Installed on first use rather than up front (haven is a heavy download).
  rPackages: [],
};

/** Map a file extension to the haven reader function that handles it. */
const READERS = {
  '.sav': 'read_sav',
  '.zsav': 'read_sav',
  '.por': 'read_por',
  '.dta': 'read_dta',
  '.sas7bdat': 'read_sas',
  '.xpt': 'read_xpt',
};

const OUT_PATH = '/tmp/ct_haven_out.parquet';

/** @param {object} app */
export async function activate(app) {
  await app.importers.register({
    id: 'haven',
    label: 'SPSS / Stata / SAS…',
    extensions: Object.keys(READERS),
    order: 20,
    parse: ({ ticket, name, file }) => importHaven(app, ticket, name, file, false),
  });
  // Filtered variant: read the variable catalog first and let the user pick a
  // subset, so a file too big to load whole (the full GSS exceeds R's ~4 GB)
  // still imports — only the chosen columns are materialised.
  await app.importers.register({
    id: 'haven-filtered',
    label: 'SPSS / Stata / SAS — choose variables…',
    extensions: Object.keys(READERS),
    order: 21,
    parse: ({ ticket, name, file }) => importHaven(app, ticket, name, file, true),
  });
}

/**
 * Parse a statistical-software file via R `haven` and deliver `{variables,
 * parquet}` to the engine. When `pickVariables` is set, first read the variable
 * catalog (cheap, zero data rows) and let the user choose a subset, then read
 * only those columns (`col_select`) — the memory-bounded path for huge files.
 *
 * @param {object} app
 * @param {number} ticket
 * @param {string} name
 * @param {Blob} file - The uploaded file (a `File` is a `Blob`).
 * @param {boolean} pickVariables
 */
async function importHaven(app, ticket, name, file, pickVariables) {
  let mounted = null;
  try {
    const ext = extensionOf(name);
    const reader = READERS[ext];
    if (!reader) throw new Error(`unsupported extension "${ext}"`);

    // haven (+ helpers) installed lazily; the first import pays the download.
    await app.webr.installPackages(['haven', 'nanoparquet', 'jsonlite']);

    // Stage via WORKERFS (lazy, copy-free) rather than writeFile — this avoids
    // the ~128 MB FS.writeFile channel wall. The remaining ceiling is R's memory
    // when haven materialises the frame (wasm32 ~4 GB), not staging.
    mounted = await app.webr.mountFile(file, name);

    let cols = null;
    if (pickVariables) {
      // 1) Read the variable catalog with zero data rows (essentially free).
      const cat = await app.webr.run(catalogR(reader, mounted));
      const catJson = Array.isArray(cat.result?.values) ? cat.result.values[0] : cat.result;
      if (typeof catJson !== 'string') {
        throw new Error(cat.stderr ? cat.stderr.split('\n')[0] : 'could not read variable list');
      }
      const catalog = JSON.parse(catJson);
      // 2) Let the user choose which variables to import.
      const chosen = await app.ui.selectFromList({
        title: `Choose variables — ${name}`,
        hint: `${catalog.length} variables in this file. Pick the ones to import (search to filter).`,
        items: catalog.map((c) => ({ value: c.name, label: c.label || c.name })),
        multiple: true,
        okLabel: 'Import selected',
        searchPlaceholder: 'Filter by name or label…',
      });
      if (!chosen || chosen.length === 0) {
        await app.importers.deliver(ticket, null); // cancelled / nothing picked → abort
        return;
      }
      cols = chosen;
    }

    // 3) Read (subset or whole), extract metadata, write Parquet for DuckDB.
    const { result, stderr } = await app.webr.run(buildR(reader, mounted, cols));
    const json = Array.isArray(result?.values) ? result.values[0] : result;
    if (typeof json !== 'string') {
      throw new Error(stderr ? stderr.split('\n')[0] : 'R returned no metadata');
    }
    const variables = mapVariables(JSON.parse(json));

    const parquet = await app.webr.readFile(OUT_PATH);
    await app.importers.deliver(ticket, { variables, parquet });
  } catch (err) {
    await app.results.appendError(`Import of "${name}" failed: ${friendlyError(err.message)}`);
    await app.importers.deliver(ticket, null); // settle the ticket; abort (don't clobber)
  } finally {
    if (mounted) {
      try {
        await app.webr.unmount(mounted);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * R source: read the file, emit per-variable metadata as JSON (the *last*
 * expression, so it lands in `result`), and write label-stripped data to Parquet
 * for DuckDB. Reads attributes BEFORE zapping them.
 *
/**
 * R source that reads just the variable catalog (zero data rows) and emits
 * `[{name, label}, …]` as JSON — cheap even for a multi-GB / thousands-of-column
 * file, since no values are read.
 *
 * @param {string} reader
 * @param {string} inPath
 * @returns {string}
 */
function catalogR(reader, inPath) {
  const spss = reader === 'read_sav' || reader === 'read_por';
  const readCall = `haven::${reader}(${rstr(inPath)}, n_max = 0${spss ? ', user_na = TRUE' : ''})`;
  return `
suppressMessages({ library(haven); library(jsonlite) })
d <- ${readCall}
toJSON(lapply(names(d), function(nm) list(
  name  = nm,
  label = { l <- attr(d[[nm]], "label", exact = TRUE); if (is.null(l)) "" else as.character(l)[1] }
)), auto_unbox = TRUE)
`;
}

/**
 * @param {string} reader - haven reader fn name, e.g. `read_sav`.
 * @param {string} inPath - Path to the (WORKERFS-mounted) input file.
 * @param {string[]|null} [cols] - If set, read only these columns (`col_select`).
 * @returns {string}
 */
function buildR(reader, inPath, cols) {
  // SPSS readers default to user_na=FALSE, which silently collapses user-defined
  // missing codes (e.g. GSS's distinct "Don't know"/"Refused"/"NAP") into NA.
  // Read with user_na=TRUE so the sentinel values and their na_values metadata
  // survive; analyses can then recode per the missing codes we carry along.
  const spss = reader === 'read_sav' || reader === 'read_por';
  const colSel = cols && cols.length ? `, col_select = c(${cols.map(rstr).join(', ')})` : '';
  const readCall = `haven::${reader}(${rstr(inPath)}${spss ? ', user_na = TRUE' : ''}${colSel})`;
  return `
suppressMessages({ library(haven); library(nanoparquet); library(jsonlite) })
d <- ${readCall}
meta <- lapply(names(d), function(nm) {
  col <- d[[nm]]
  lbls <- attr(col, "labels", exact = TRUE)
  nav  <- attr(col, "na_values", exact = TRUE)
  lab  <- attr(col, "label", exact = TRUE)
  meas <- attr(col, "measure", exact = TRUE)
  list(
    name   = nm,
    label  = if (is.null(lab)) "" else as.character(lab)[1],
    rclass = class(col)[1],
    valueLabels = if (!is.null(lbls) && length(lbls))
      as.list(setNames(as.character(names(lbls)), as.character(unname(lbls)))) else NULL,
    missingValues = if (!is.null(nav) && length(nav)) as.list(unname(nav)) else NULL,
    measure = if (is.null(meas)) NULL else as.character(meas)[1]
  )
})
d2 <- as.data.frame(lapply(d, function(col) {
  # Keep temporal classes; otherwise strip ALL haven attributes down to the raw
  # underlying vector. This preserves user-missing sentinel values (e.g. -99) as
  # plain data — the missingValues metadata carries the recode intent, matching
  # how the rest of the engine treats user-missing.
  if (inherits(col, c("Date", "POSIXct", "POSIXt"))) return(col)
  v <- unclass(col); attributes(v) <- NULL; v
}), stringsAsFactors = FALSE, check.names = FALSE)
nanoparquet::write_parquet(d2, ${rstr(OUT_PATH)})
jsonlite::toJSON(meta, auto_unbox = TRUE, null = "null", na = "null")
`;
}

/**
 * Turn the R-side metadata into `VariableMeta[]`. A column with value labels is a
 * factor; otherwise type follows the R class.
 *
 * @param {Array<object>} raw
 * @returns {object[]}
 */
function mapVariables(raw) {
  return raw.map((m) => {
    const out = { name: m.name };
    if (m.label) out.label = m.label;

    const hasLabels = m.valueLabels && Object.keys(m.valueLabels).length > 0;
    if (hasLabels) {
      out.type = 'factor';
      out.valueLabels = m.valueLabels;
    } else if (m.rclass === 'character') {
      out.type = 'string';
    } else if (m.rclass === 'Date' || m.rclass === 'POSIXct' || m.rclass === 'hms') {
      // No dedicated date type yet; stored natively in DuckDB via Parquet, this
      // is only a UI hint. Treat as string for now.
      out.type = 'string';
    } else {
      out.type = 'numeric';
    }

    if (Array.isArray(m.missingValues) && m.missingValues.length) {
      out.missingValues = m.missingValues;
    }
    const measure = mapMeasure(m.measure);
    if (measure) out.measurementLevel = measure;
    return out;
  });
}

/** Map haven's `measure` attribute to our MeasurementLevel (or undefined). */
function mapMeasure(measure) {
  if (measure === 'nominal' || measure === 'ordinal') return measure;
  if (measure === 'scale') return 'scale';
  return undefined; // "unknown" / absent
}

/**
 * Translate R/WebR's cryptic out-of-memory error into a plain-language message.
 * A large file can exhaust WebR's wasm32 ~4 GB heap while haven materialises the
 * whole data frame; R reports this as e.g. "cannot allocate vector of size …".
 *
 * @param {string} msg
 * @returns {string}
 */
function friendlyError(msg) {
  if (/cannot allocate|out of memory|memory exhausted|allocation failed/i.test(msg)) {
    return (
      'ran out of memory reading this file. The in-browser R runtime is capped at ' +
      '~4 GB (WebAssembly), which a very large file exceeds. Use a smaller extract ' +
      '— e.g. fewer variables or years.'
    );
  }
  return msg;
}

/** Lowercased file extension including the dot, e.g. `.sav`. */
function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** Render a JS string as a double-quoted R string literal. */
function rstr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
