/**
 * @file plugins/builtin-manova/index.js
 * Built-in plugin: Multivariate ▸ MANOVA — several numeric outcomes tested at
 * once against a grouping factor. Reports the four multivariate tests (Pillai's
 * trace, Wilks' lambda, Hotelling–Lawley, Roy's largest root) with approximate F,
 * then the per-outcome univariate ANOVAs as a follow-up.
 *
 * Base R (`manova`) — no extra packages. User-missing recoded to NA; listwise.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-manova',
  name: 'MANOVA',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['manova', 'multivariate', 'pillai', 'wilks', 'hotelling', 'roy'],
  rPackages: [],
  menu: [
    {
      label: 'MANOVA…',
      run: 'run',
      order: 20,
      inputs: [
        { name: 'dvs', kind: 'variables', label: 'Outcomes (2+ numeric)', multiple: true, types: ['numeric'], unique: true },
        { name: 'group', kind: 'variables', label: 'Factor', types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
  ],
};

export async function run(app, { dvs, group }) {
  const dvNames = Array.isArray(dvs) ? dvs : dvs ? [dvs] : [];
  if (dvNames.length < 2 || !group) {
    await app.results.appendError('MANOVA needs at least 2 numeric outcomes and a factor.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [...dvNames.map((n, i) => recode(`dvs[[${i + 1}]]`, missing(meta, n))), recode('group', missing(meta, group))]
    .filter(Boolean)
    .join('\n');

  const rCode = `
    ${recodes}
    Y <- as.matrix(as.data.frame(dvs, check.names = FALSE))
    g <- as.factor(group)
    ok <- stats::complete.cases(Y) & !is.na(g)
    Y <- Y[ok, , drop = FALSE]; g <- droplevels(g[ok])
    if (nlevels(g) < 2) stop("need at least 2 groups")
    fit <- manova(Y ~ g)
    ext <- function(tt) summary(fit, test = tt)$stats[1, ]
    pil <- ext("Pillai"); wil <- ext("Wilks"); hl <- ext("Hotelling-Lawley"); roy <- ext("Roy")
    ua <- summary.aov(fit)
    .tab <- function(z) if (is.data.frame(z)) z else z[[1]]
    uF <- sapply(ua, function(z) .tab(z)["g", "F value"])
    uP <- sapply(ua, function(z) .tab(z)["g", "Pr(>F)"])
    list(
      stat = c(pil[2], wil[2], hl[2], roy[2]),
      approxF = c(pil[3], wil[3], hl[3], roy[3]),
      df1 = c(pil[4], wil[4], hl[4], roy[4]),
      df2 = c(pil[5], wil[5], hl[5], roy[5]),
      p = c(pil[6], wil[6], hl[6], roy[6]),
      uF = unname(uF), uP = unname(uP), n = nrow(Y), k = nlevels(g)
    )`;

  const r = flat((await app.webr.run(rCode)).result);
  const tests = ["Pillai's Trace", "Wilks' Lambda", 'Hotelling–Lawley Trace', "Roy's Largest Root"];
  const stat = r.num('stat');
  const aF = r.num('approxF');
  const df1 = r.num('df1');
  const df2 = r.num('df2');
  const p = r.num('p');
  await app.results.appendTable(
    {
      columns: ['Test', 'Value', 'Approx. F', 'Hypothesis df', 'Error df', 'Sig.'],
      rows: tests.map((t, i) => [t, f(stat[i], 3), f(aF[i], 3), int(df1[i]), int(df2[i]), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: `Multivariate Tests — effect: ${label(meta, group)} (N = ${int(r.n1('n'))})` },
  );

  const uF = r.num('uF');
  const uP = r.num('uP');
  await app.results.appendTable(
    {
      columns: ['Outcome', 'F', 'Sig.'],
      rows: dvNames.map((nm, i) => [label(meta, nm), f(uF[i], 3), fmtP(uP[i])]),
      rowHeaders: true,
    },
    { caption: 'Univariate ANOVAs (follow-up, per outcome)' },
  );
  await app.results.appendText('A significant multivariate test means the groups differ on the outcomes jointly; the univariate ANOVAs show which outcomes drive it (consider a multiple-comparison correction).');
}

// --- helpers -----------------------------------------------------------------

function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function label(meta, name) {
  return meta.get(name)?.label || name;
}
function missing(meta, name) {
  return (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v))).map(Number);
}
function recode(rvar, mv) {
  return mv.length ? `${rvar}[${rvar} %in% c(${mv.join(', ')})] <- NA` : '';
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
    n1: (k) => {
      const a = arr(byName[k]);
      return a.length ? (a[0] == null ? NaN : Number(a[0])) : NaN;
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
