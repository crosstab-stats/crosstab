/**
 * @file plugins/builtin-factor/index.js
 * Built-in plugin: Multivariate ▸ Factor analysis — exploratory factor analysis
 * / principal components, the dimension-reduction tool for survey/psych work.
 *
 * Computed with `psych` (KMO, Bartlett, fa/principal); SPSS-style output: the
 * KMO & Bartlett sampling-adequacy table, Total Variance Explained, a scree plot
 * (svglite), and the (rotated) factor loadings matrix. User-missing recoded to
 * NA; analysis is listwise on the chosen items.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-factor',
  name: 'Factor Analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['factor', 'efa', 'pca', 'principal components', 'dimension reduction', 'loadings'],
  disciplines: ['Psychology', 'Sociology', 'Political Science', 'Communication', "Women's & Gender Studies", 'Education', 'Liberal Studies'],
  rPackages: ['psych', 'GPArotation', 'svglite'],
  menu: [
    {
      label: 'Factor analysis…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Items', multiple: true, types: ['numeric'] },
        { name: 'nfactors', kind: 'number', label: 'Number of factors (0 = auto, eigenvalue > 1)', default: 0 },
        {
          name: 'method',
          kind: 'choice',
          label: 'Extraction',
          options: [
            { value: 'principal', label: 'Principal components' },
            { value: 'pa', label: 'Principal axis' },
            { value: 'ml', label: 'Maximum likelihood' },
          ],
          default: 'principal',
        },
        {
          name: 'rotation',
          kind: 'choice',
          label: 'Rotation',
          options: [
            { value: 'varimax', label: 'Varimax' },
            { value: 'none', label: 'None' },
            { value: 'oblimin', label: 'Oblimin' },
            { value: 'promax', label: 'Promax' },
          ],
          default: 'varimax',
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[], nfactors: number, method: string, rotation: string}} inputs
 */
export async function run(app, { vars, nfactors, method, rotation }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Factor analysis needs at least 2 items.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const fm = method === 'pa' || method === 'ml' ? method : null; // null → principal()
  const rot = ['none', 'varimax', 'oblimin', 'promax'].includes(rotation) ? rotation : 'varimax';
  const nf = Number.isFinite(nfactors) && nfactors >= 1 ? Math.round(nfactors) : 0;

  const recode = vars
    .map((name) => {
      const mv = (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
      if (!mv.length) return '';
      const col = `vars[[${rStr(name)}]]`;
      return `${col}[${col} %in% c(${mv.map(Number).join(', ')})] <- NA`;
    })
    .filter(Boolean)
    .join('\n');

  const fitExpr = fm
    ? `psych::fa(d, nfactors = nf, rotate = ${rStr(rot)}, fm = ${rStr(fm)})`
    : `psych::principal(d, nfactors = nf, rotate = ${rStr(rot)})`;

  const rCode = `
    ${recode}
    d <- as.data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    if (ncol(d) < 2 || nrow(d) < 3) stop("need at least 2 items and 3 complete cases")
    Rm <- cor(d)
    ev <- eigen(Rm, only.values = TRUE)$values
    nf <- ${nf}; if (nf < 1) nf <- max(1, sum(ev > 1))
    km <- tryCatch(psych::KMO(Rm)$MSA, error = function(e) NA_real_)
    bt <- tryCatch(psych::cortest.bartlett(Rm, n = nrow(d)), error = function(e) NULL)
    fit <- ${fitExpr}
    load <- unclass(fit$loadings)
    library(svglite)
    .dev <- svgstring(width = 6, height = 4, pointsize = 11)
    par(mar = c(4.2, 4.2, 2.2, 1))
    plot(ev, type = "b", pch = 19, col = "#2980b9", xlab = "Component", ylab = "Eigenvalue", main = "Scree Plot")
    abline(h = 1, lty = 2, col = "#999999")
    dev.off()
    list(
      kmo = km, bartChi = if (is.null(bt)) NA_real_ else bt$chisq,
      bartDf = if (is.null(bt)) NA_real_ else bt$df, bartP = if (is.null(bt)) NA_real_ else bt$p.value,
      ev = ev, nf = nf, n = nrow(d), items = colnames(d),
      loadings = as.numeric(load), nItems = nrow(load), nFac = ncol(load),
      scree = .dev()
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  // KMO & Bartlett.
  await app.results.appendTable(
    {
      columns: ['Kaiser-Meyer-Olkin (KMO)', "Bartlett's χ²", 'df', 'Sig.'],
      rows: [[f(r.n1('kmo'), 3), f(r.n1('bartChi'), 3), int(r.n1('bartDf')), fmtP(r.n1('bartP'))]],
    },
    { caption: 'KMO and Bartlett’s Test' },
  );

  // Total Variance Explained (initial eigenvalues).
  const ev = r.num('ev');
  const total = ev.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  let cum = 0;
  await app.results.appendTable(
    {
      columns: ['Component', 'Eigenvalue', '% of Variance', 'Cumulative %'],
      rows: ev.map((e, i) => {
        const pct = total ? (e / total) * 100 : NaN;
        cum += pct;
        return [String(i + 1), f(e, 3), f(pct, 2), f(cum, 2)];
      }),
      rowHeaders: true,
    },
    { caption: `Total Variance Explained — ${int(r.n1('nf'))} factor(s) extracted` },
  );

  // Scree plot.
  const scree = r.s1('scree');
  if (scree && /<svg[\s>]/i.test(scree)) {
    await app.results.appendPlot(stripSize(scree));
  }

  // Factor loadings (rotated), small loadings (|λ| < .30) blanked for legibility.
  const nItems = r.n1('nItems');
  const nFac = r.n1('nFac');
  const load = r.num('loadings'); // column-major: load[j*nItems + i]
  const items = r.str('items');
  const facCols = Array.from({ length: nFac }, (_, j) => `Factor ${j + 1}`);
  await app.results.appendTable(
    {
      columns: ['Item', ...facCols],
      rows: items.map((it, i) => [
        label(meta, it),
        ...Array.from({ length: nFac }, (_, j) => {
          const v = load[j * nItems + i];
          return Number.isFinite(v) && Math.abs(v) >= 0.3 ? v.toFixed(3) : '';
        }),
      ]),
      rowHeaders: true,
    },
    { caption: `Factor Loadings (${rot === 'none' ? 'unrotated' : rot}) — loadings below |.30| hidden` },
  );
}

// --- helpers -----------------------------------------------------------------

function label(meta, name) {
  return meta.get(name)?.label || name;
}
/** svglite emits a fixed pt width/height; drop them so the plot fills its box. */
function stripSize(svg) {
  return svg.replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
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
    s1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
