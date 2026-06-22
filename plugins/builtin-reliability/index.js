/**
 * @file plugins/builtin-reliability/index.js
 * Built-in plugin: Scale ▸ Reliability analysis — Cronbach's α for a set of
 * scale items. The first thing a survey researcher reaches for.
 *
 * Computed with `psych::alpha` (installed on demand); rendered SPSS-style: overall
 * Cronbach's α (raw + standardized), and per-item statistics — corrected
 * item-total correlation and "α if item deleted". User-missing recoded to NA.
 * (Reverse-keyed items aren't auto-flipped; recode them first via Transform.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-reliability',
  name: 'Reliability Analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Scale',
  keywords: ['cronbach', 'alpha', 'reliability', 'scale', 'internal consistency', 'items'],
  disciplines: ['Psychology', 'Education', 'Communication', 'Sociology', "Women's & Gender Studies", 'Liberal Studies'],
  rPackages: ['psych'],
  menu: [
    {
      label: 'Reliability analysis…',
      run: 'run',
      order: 10,
      inputs: [{ name: 'vars', kind: 'variables', label: 'Scale items', hint: 'The survey items expected to measure one construct.', multiple: true, types: ['numeric'] }],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function run(app, { vars }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Reliability needs at least 2 items.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const recode = vars
    .map((name) => {
      const mv = (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
      if (!mv.length) return '';
      const col = `vars[[${rStr(name)}]]`;
      return `${col}[${col} %in% c(${mv.map(Number).join(', ')})] <- NA`;
    })
    .filter(Boolean)
    .join('\n');

  const rCode = `
    ${recode}
    d <- as.data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    a <- psych::alpha(d, warnings = FALSE, check.keys = FALSE)
    # McDonald's omega (total) from a single-factor congeneric model. Needs >= 3
    # items to identify the factor; suppress its plotting/printing noise.
    om <- if (ncol(d) >= 3) tryCatch(
      suppressWarnings(suppressMessages(psych::omega(d, nfactors = 1, plot = FALSE, flow = FALSE))),
      error = function(e) NULL) else NULL
    list(
      alpha = a$total$raw_alpha, stdAlpha = a$total$std.alpha,
      omegaTot = if (is.null(om)) NA_real_ else as.numeric(om$omega.tot),
      gSix = a$total$"G6(smc)",
      nItems = ncol(d), nCases = sum(stats::complete.cases(d)),
      items = colnames(d), itemMean = a$item.stats[, "mean"], itemSD = a$item.stats[, "sd"],
      itemR = a$item.stats[, "r.drop"], alphaDrop = a$alpha.drop[, "raw_alpha"]
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  const omega = r.n1('omegaTot');
  await app.results.appendTable(
    {
      columns: ["Cronbach's α", "Cronbach's α (standardized)", "McDonald's ω", 'N of Items', 'N'],
      rows: [[f(r.n1('alpha'), 3), f(r.n1('stdAlpha'), 3), f(omega, 3), int(r.n1('nItems')), int(r.n1('nCases'))]],
    },
    { caption: 'Reliability Statistics' },
  );
  if (Number.isFinite(omega)) {
    await app.results.appendText(
      "**McDonald's ω** (total) doesn't assume every item contributes equally (tau-equivalence), so it's usually preferred over α when item loadings differ. Values are interpreted on the same scale (≥ .70 acceptable, ≥ .80 good).",
    );
  }

  const items = r.str('items');
  await app.results.appendTable(
    {
      columns: ['Item', 'Mean', 'SD', 'Corrected Item-Total Correlation', "Cronbach's α if Item Deleted"],
      rows: items.map((it, i) => [
        label(meta, it),
        f(r.num('itemMean')[i], 3),
        f(r.num('itemSD')[i], 3),
        f(r.num('itemR')[i], 3),
        fAlpha(r.num('alphaDrop')[i]),
      ]),
      rowHeaders: true,
    },
    { caption: 'Item-Total Statistics' },
  );
}

// --- helpers -----------------------------------------------------------------

function label(meta, name) {
  return meta.get(name)?.label || name;
}
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    num: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    str: (k) => arr(byName[k]).map(String),
    n1: (k) => {
      const a = arr(byName[k]);
      return a.length ? (a[0] == null ? NaN : Number(a[0])) : NaN;
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** Alpha can't exceed 1; psych's "if deleted" is degenerate for a 2-item scale. */
const fAlpha = (x) => (Number.isFinite(x) && x <= 1.0001 ? x.toFixed(3) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
