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

const IN_PATH = '/tmp/ct_haven_in';
const OUT_PATH = '/tmp/ct_haven_out.parquet';

/** @param {object} app */
export async function activate(app) {
  await app.importers.register({
    id: 'haven',
    label: 'SPSS / Stata / SAS…',
    extensions: Object.keys(READERS),
    order: 20,
    parse: ({ ticket, name, bytes }) => importHaven(app, ticket, name, bytes),
  });
}

/**
 * Parse a statistical-software file via R `haven` and deliver `{variables,
 * parquet}` to the engine.
 *
 * @param {object} app
 * @param {number} ticket
 * @param {string} name
 * @param {ArrayBuffer} bytes
 */
async function importHaven(app, ticket, name, bytes) {
  try {
    const ext = extensionOf(name);
    const reader = READERS[ext];
    if (!reader) throw new Error(`unsupported extension "${ext}"`);

    // haven (+ helpers) installed lazily; the first import pays the download.
    await app.webr.installPackages(['haven', 'nanoparquet', 'jsonlite']);

    await app.webr.writeFile(IN_PATH, bytes);
    const { result, stderr } = await app.webr.run(buildR(reader));
    const json = Array.isArray(result?.values) ? result.values[0] : result;
    if (typeof json !== 'string') {
      throw new Error(stderr ? stderr.split('\n')[0] : 'R returned no metadata');
    }
    const variables = mapVariables(JSON.parse(json));

    const parquet = await app.webr.readFile(OUT_PATH);
    await app.importers.deliver(ticket, { variables, parquet });
  } catch (err) {
    await app.results.appendError(`Import of "${name}" failed: ${err.message}`);
    await app.importers.deliver(ticket, { variables: [] }); // settle the ticket
  }
}

/**
 * R source: read the file, emit per-variable metadata as JSON (the *last*
 * expression, so it lands in `result`), and write label-stripped data to Parquet
 * for DuckDB. Reads attributes BEFORE zapping them.
 *
 * @param {string} reader - haven reader fn name, e.g. `read_sav`.
 * @returns {string}
 */
function buildR(reader) {
  // SPSS readers default to user_na=FALSE, which silently collapses user-defined
  // missing codes (e.g. GSS's distinct "Don't know"/"Refused"/"NAP") into NA.
  // Read with user_na=TRUE so the sentinel values and their na_values metadata
  // survive; analyses can then recode per the missing codes we carry along.
  const spss = reader === 'read_sav' || reader === 'read_por';
  const readCall = `haven::${reader}(${rstr(IN_PATH)}${spss ? ', user_na = TRUE' : ''})`;
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

/** Lowercased file extension including the dot, e.g. `.sav`. */
function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** Render a JS string as a double-quoted R string literal. */
function rstr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
