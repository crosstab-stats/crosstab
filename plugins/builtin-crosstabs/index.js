/**
 * @file plugins/builtin-crosstabs/index.js
 * Built-in plugin: Descriptive Statistics ▸ Crosstabs.
 *
 * A two-way contingency table plus a Pearson chi-square test. User-missing codes
 * on either variable are recoded to NA first. Computed in R; the host renders the
 * structured tables (counts + value labels).
 *
 * Declarative plugin: the manifest declares two categorical inputs marked
 * `unique` (so the column picker excludes the already-chosen row variable); the
 * host binds them in R as the vectors `rowvar` and `colvar`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-crosstabs',
  name: 'Crosstabs',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['chi-square', 'contingency', 'crosstab', 'association'],
  rPackages: [],
  menu: [
    {
      label: 'Crosstabs…',
      run: 'run',
      order: 30,
      inputs: [
        { name: 'rowvar', kind: 'variables', label: 'Row variable', multiple: false, types: ['factor', 'string'], unique: true },
        { name: 'colvar', kind: 'variables', label: 'Column variable', multiple: false, types: ['factor', 'string'], unique: true },
        {
          name: 'pmethod',
          kind: 'choice',
          label: 'P-value',
          default: 'asymptotic',
          options: [
            { value: 'asymptotic', label: 'Asymptotic (default)' },
            { value: 'montecarlo', label: 'Monte Carlo (for sparse tables)' },
          ],
        },
        {
          name: 'measures',
          kind: 'choice',
          label: 'Association measures',
          default: 'auto',
          options: [
            { value: 'auto', label: 'Auto — add ordinal measures if both variables are ordinal' },
            { value: 'ordinal', label: 'Include ordinal/directional measures' },
            { value: 'nominal', label: 'Nominal only (χ², φ, Cramér\'s V, lambda)' },
          ],
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{rowvar: string, colvar: string}} inputs
 */
export async function run(app, { rowvar: rowName, colvar: colName, pmethod, measures }) {
  if (!rowName || !colName) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const rCode = `
    ${ORD_MEASURES_R}
    ${recode('rowvar', meta.get(rowName))}
    ${recode('colvar', meta.get(colName))}
    tab <- table(rowvar, colvar)
    om <- tryCatch(ord_measures(tab), error = function(e) NULL)
    chi <- tryCatch(suppressWarnings(chisq.test(tab)), error = function(e) NULL)
    minExp <- if (is.null(chi)) NA_real_ else min(chi$expected, na.rm = TRUE)
    mc <- identical(pmethod, "montecarlo")
    simB <- 10000L
    pMC <- if (mc) tryCatch(suppressWarnings(chisq.test(tab, simulate.p.value = TRUE, B = simB))$p.value, error = function(e) NA_real_) else NA_real_
    pFisher <- if (mc) tryCatch(fisher.test(tab, simulate.p.value = TRUE, B = simB)$p.value, error = function(e) NA_real_) else NA_real_
    list(
      rowLevels = rownames(tab), colLevels = colnames(tab),
      counts = as.integer(t(tab)),
      rowTotals = as.integer(rowSums(tab)), colTotals = as.integer(colSums(tab)),
      total = sum(tab),
      chisq = if (is.null(chi)) NA_real_ else unname(chi$statistic),
      dfree = if (is.null(chi)) NA_real_ else unname(chi$parameter),
      p     = if (is.null(chi)) NA_real_ else chi$p.value,
      minExp = minExp, pMC = pMC, pFisher = pFisher, simB = simB,
      cramerV = if (is.null(chi)) NA_real_ else sqrt(unname(chi$statistic) / (sum(tab) * (min(nrow(tab), ncol(tab)) - 1))),
      phi = if (!is.null(chi) && nrow(tab) == 2 && ncol(tab) == 2) sqrt(unname(chi$statistic) / sum(tab)) else NA_real_,
      gamma = num(om$gamma), taub = num(om$taub), tauc = num(om$tauc), spearman = num(om$spear), pearson = num(om$pear),
      somersSym = num(om$somSym), somersRC = num(om$somXY), somersCR = num(om$somYX),
      pOrdinal = num(om$pS), pSpearman = num(om$psp), pPearson = num(om$ppe),
      lambdaSym = num(om$lamSym), lambdaRC = num(om$lamXY), lambdaCR = num(om$lamYX)
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const x = normalizeResult(result);

  const rowMeta = meta.get(rowName);
  const colMeta = meta.get(colName);
  const lv = (m, code) => m?.valueLabels?.[code] ?? code;
  const ncol = x.colLevels.length;

  // Contingency table.
  const rows = x.rowLevels.map((r, i) => [
    lv(rowMeta, r),
    ...x.colLevels.map((_, j) => x.counts[i * ncol + j] ?? 0),
    x.rowTotals[i],
  ]);
  rows.push(['Total', ...x.colTotals, x.total]);
  await app.results.appendTable(
    {
      columns: ['', ...x.colLevels.map((c) => lv(colMeta, c)), 'Total'],
      rows,
      rowHeaders: true,
    },
    { caption: `${labelOf(rowMeta, rowName)} × ${labelOf(colMeta, colName)}` },
  );

  // Chi-square test.
  const fmt = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const fp = (v) => (Number.isFinite(v) ? (v < 0.001 ? '< .001' : v.toFixed(3)) : '—');
  const p = fp(x.p);
  const chiRows = [['Pearson Chi-Square', fmt(x.chisq, 3), fmt(x.dfree, 0), p]];
  if (Number.isFinite(x.pMC)) {
    chiRows.push(['Pearson Chi-Square — Monte Carlo', fmt(x.chisq, 3), '', fp(x.pMC)]);
  }
  if (Number.isFinite(x.pFisher)) {
    chiRows.push(["Fisher's Exact — Monte Carlo", '', '', fp(x.pFisher)]);
  }
  chiRows.push(['N of Valid Cases', x.total, '', '']);
  await app.results.appendTable(
    {
      columns: ['', 'Value', 'df', Number.isFinite(x.pMC) ? 'Sig. (2-sided)' : 'Asymp. Sig. (2-sided)'],
      rows: chiRows,
      rowHeaders: true,
    },
    { caption: 'Chi-Square Tests' },
  );
  // Sparse-table guidance: the asymptotic χ² is unreliable when expected counts
  // are small; nudge toward the Monte Carlo option (or note it's already in use).
  if (Number.isFinite(x.minExp) && x.minExp < 5) {
    await app.results.appendText(
      Number.isFinite(x.pMC)
        ? `Smallest expected count is ${fmt(x.minExp, 2)} (< 5), so the Monte Carlo p-values above (${(x.simB || 10000).toLocaleString()} simulations) are more trustworthy than the asymptotic one here.`
        : `⚠️ Smallest expected count is ${fmt(x.minExp, 2)} (< 5) — the asymptotic χ² may be inaccurate. Re-run with **P-value: Monte Carlo** for a simulation-based p-value.`,
    );
  }

  const bothOrdinal = rowMeta?.measurementLevel === 'ordinal' && colMeta?.measurementLevel === 'ordinal';
  const wantOrdinal = measures === 'ordinal' || (measures !== 'nominal' && bothOrdinal);

  // Symmetric Measures: nominal (phi, Cramér's V) + ordinal correlations.
  const sym = [];
  if (Number.isFinite(x.phi)) sym.push(['Nominal — Phi', fmt(x.phi, 3), p]);
  if (Number.isFinite(x.cramerV)) sym.push(["Nominal — Cramér's V", fmt(x.cramerV, 3), p]);
  if (wantOrdinal) {
    if (Number.isFinite(x.gamma)) sym.push(['Ordinal — Goodman & Kruskal Gamma', fmt(x.gamma, 3), fp(x.pOrdinal)]);
    if (Number.isFinite(x.taub)) sym.push(["Ordinal — Kendall's tau-b", fmt(x.taub, 3), fp(x.pOrdinal)]);
    if (Number.isFinite(x.tauc)) sym.push(["Ordinal — Kendall's tau-c", fmt(x.tauc, 3), fp(x.pOrdinal)]);
    if (Number.isFinite(x.spearman)) sym.push(['Ordinal — Spearman Correlation', fmt(x.spearman, 3), fp(x.pSpearman)]);
    if (Number.isFinite(x.pearson)) sym.push(["Interval — Pearson's R", fmt(x.pearson, 3), fp(x.pPearson)]);
  }
  if (sym.length) {
    await app.results.appendTable(
      { columns: ['', 'Value', 'Approx. Sig.'], rows: sym, rowHeaders: true },
      { caption: 'Symmetric Measures' },
    );
  }

  // Directional Measures: lambda (nominal) + Somers' d (ordinal).
  const rowLab = labelOf(rowMeta, rowName);
  const colLab = labelOf(colMeta, colName);
  const dir = [];
  if (Number.isFinite(x.lambdaSym)) dir.push(['Nominal — Lambda (symmetric)', fmt(x.lambdaSym, 3), '—']);
  if (Number.isFinite(x.lambdaRC)) dir.push([`Nominal — Lambda (${rowLab} dependent)`, fmt(x.lambdaRC, 3), '—']);
  if (Number.isFinite(x.lambdaCR)) dir.push([`Nominal — Lambda (${colLab} dependent)`, fmt(x.lambdaCR, 3), '—']);
  if (wantOrdinal) {
    if (Number.isFinite(x.somersSym)) dir.push(["Ordinal — Somers' d (symmetric)", fmt(x.somersSym, 3), fp(x.pOrdinal)]);
    if (Number.isFinite(x.somersRC)) dir.push([`Ordinal — Somers' d (${rowLab} dependent)`, fmt(x.somersRC, 3), fp(x.pOrdinal)]);
    if (Number.isFinite(x.somersCR)) dir.push([`Ordinal — Somers' d (${colLab} dependent)`, fmt(x.somersCR, 3), fp(x.pOrdinal)]);
  }
  if (dir.length) {
    await app.results.appendTable(
      { columns: ['', 'Value', 'Approx. Sig.'], rows: dir, rowHeaders: true },
      { caption: 'Directional Measures' },
    );
  }
  if (wantOrdinal) {
    await app.results.appendText(
      "Ordinal measures assume the categories are **ordered** (by the order of the codes / value labels). Gamma, Kendall's tau-b/c and Somers' d share one test of no monotonic association (tie-corrected Kendall-S z); Spearman and Pearson use their own t-tests. Lambda is a proportional-reduction-in-error measure (no significance shown).",
    );
  }
}

// --- R: ordinal / directional association measures ---------------------------

/**
 * Base-R implementation of the ordinal and directional association measures
 * (no DescTools — its deps don't compile in WebR). Point estimates verified
 * against R's own cor(method="kendall"/"spearman"); the significance test is the
 * tie-corrected Kendall-S z, the common null shared by gamma/tau/Somers.
 */
const ORD_MEASURES_R = `
num <- function(x) if (is.null(x) || length(x) == 0 || !is.finite(x)) NA_real_ else as.numeric(x)
ord_measures <- function(tab){
  R <- nrow(tab); Cn <- ncol(tab); N <- sum(tab); Ri <- rowSums(tab); Cj <- colSums(tab)
  if (R < 2 || Cn < 2 || N < 3) return(NULL)
  C <- 0; D <- 0
  for (i in 1:R) for (j in 1:Cn) {
    conc <- 0; disc <- 0
    if (i < R && j < Cn) conc <- conc + sum(tab[(i+1):R, (j+1):Cn])
    if (i > 1 && j > 1)  conc <- conc + sum(tab[1:(i-1), 1:(j-1)])
    if (i < R && j > 1)  disc <- disc + sum(tab[(i+1):R, 1:(j-1)])
    if (i > 1 && j < Cn) disc <- disc + sum(tab[1:(i-1), (j+1):Cn])
    C <- C + tab[i,j]*conc; D <- D + tab[i,j]*disc
  }
  C <- C/2; D <- D/2
  wX <- (N^2 - sum(Ri^2))/2; wY <- (N^2 - sum(Cj^2))/2; m <- min(R, Cn)
  gamma <- if ((C+D) > 0) (C-D)/(C+D) else NA_real_
  taub  <- if (wX > 0 && wY > 0) (C-D)/sqrt(wX*wY) else NA_real_
  tauc  <- if (m > 1) 2*m*(C-D)/(N^2*(m-1)) else NA_real_
  somYX <- if (wX > 0) (C-D)/wX else NA_real_   # column (Y) dependent
  somXY <- if (wY > 0) (C-D)/wY else NA_real_   # row (X) dependent
  somSym <- if ((wX+wY) > 0) 2*(C-D)/(wX+wY) else NA_real_
  t1 <- (N*(N-1)*(2*N+5) - sum(Ri*(Ri-1)*(2*Ri+5)) - sum(Cj*(Cj-1)*(2*Cj+5)))/18
  t2 <- if (N > 2) (sum(Ri*(Ri-1)*(Ri-2)) * sum(Cj*(Cj-1)*(Cj-2)))/(9*N*(N-1)*(N-2)) else 0
  t3 <- (sum(Ri*(Ri-1)) * sum(Cj*(Cj-1)))/(2*N*(N-1))
  varS <- t1 + t2 + t3
  zS <- if (varS > 0) (C-D)/sqrt(varS) else NA_real_
  pS <- if (is.finite(zS)) 2*pnorm(-abs(zS)) else NA_real_
  rrank <- cumsum(Ri) - (Ri-1)/2; crank <- cumsum(Cj) - (Cj-1)/2
  Rbar <- sum(Ri*rrank)/N; Cbar <- sum(Cj*crank)/N
  cov <- 0; for (i in 1:R) for (j in 1:Cn) cov <- cov + tab[i,j]*(rrank[i]-Rbar)*(crank[j]-Cbar)
  vR <- sum(Ri*(rrank-Rbar)^2); vC <- sum(Cj*(crank-Cbar)^2)
  spear <- if (vR > 0 && vC > 0) cov/sqrt(vR*vC) else NA_real_
  psp <- if (is.finite(spear) && abs(spear) < 1) { tt <- spear*sqrt((N-2)/(1-spear^2)); 2*pt(-abs(tt), N-2) } else NA_real_
  rv <- suppressWarnings(as.numeric(rownames(tab))); cv <- suppressWarnings(as.numeric(colnames(tab)))
  pear <- NA_real_; ppe <- NA_real_
  if (!any(is.na(rv)) && !any(is.na(cv))) {
    mrx <- sum(Ri*rv)/N; mcy <- sum(Cj*cv)/N
    sxy <- 0; for (i in 1:R) for (j in 1:Cn) sxy <- sxy + tab[i,j]*(rv[i]-mrx)*(cv[j]-mcy)
    sxx <- sum(Ri*(rv-mrx)^2); syy <- sum(Cj*(cv-mcy)^2)
    if (sxx > 0 && syy > 0) { pear <- sxy/sqrt(sxx*syy)
      if (abs(pear) < 1) { tt <- pear*sqrt((N-2)/(1-pear^2)); ppe <- 2*pt(-abs(tt), N-2) } }
  }
  rmax <- apply(tab, 1, max); cmax <- apply(tab, 2, max); maxR <- max(Ri); maxC <- max(Cj)
  lamYX <- if ((N-maxC) > 0) (sum(rmax)-maxC)/(N-maxC) else NA_real_
  lamXY <- if ((N-maxR) > 0) (sum(cmax)-maxR)/(N-maxR) else NA_real_
  lamSym <- if ((2*N-maxC-maxR) > 0) (sum(rmax)+sum(cmax)-maxC-maxR)/(2*N-maxC-maxR) else NA_real_
  list(C=C, D=D, gamma=num(gamma), taub=num(taub), tauc=num(tauc),
       somYX=num(somYX), somXY=num(somXY), somSym=num(somSym), pS=num(pS),
       spear=num(spear), psp=num(psp), pear=num(pear), ppe=num(ppe),
       lamYX=num(lamYX), lamXY=num(lamXY), lamSym=num(lamSym))
}`;

// --- helpers -----------------------------------------------------------------

/** R line recoding a bound vector's user-missing codes to NA. */
function recode(varName, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${varName}[${varName} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
}

function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const scalar = (v) => {
    const a = arr(v);
    const first = a.length ? a[0] : v;
    return first == null ? NaN : Number(first); // R NA (a null element) → NaN, so it renders "—"/hides
  };
  return {
    rowLevels: arr(byName.rowLevels).map(String),
    colLevels: arr(byName.colLevels).map(String),
    counts: arr(byName.counts).map(Number),
    rowTotals: arr(byName.rowTotals).map(Number),
    colTotals: arr(byName.colTotals).map(Number),
    total: scalar(byName.total),
    chisq: scalar(byName.chisq),
    dfree: scalar(byName.dfree),
    p: scalar(byName.p),
    minExp: scalar(byName.minExp),
    pMC: scalar(byName.pMC),
    pFisher: scalar(byName.pFisher),
    simB: scalar(byName.simB),
    cramerV: scalar(byName.cramerV),
    phi: scalar(byName.phi),
    gamma: scalar(byName.gamma),
    taub: scalar(byName.taub),
    tauc: scalar(byName.tauc),
    spearman: scalar(byName.spearman),
    pearson: scalar(byName.pearson),
    somersSym: scalar(byName.somersSym),
    somersRC: scalar(byName.somersRC),
    somersCR: scalar(byName.somersCR),
    pOrdinal: scalar(byName.pOrdinal),
    pSpearman: scalar(byName.pSpearman),
    pPearson: scalar(byName.pPearson),
    lambdaSym: scalar(byName.lambdaSym),
    lambdaRC: scalar(byName.lambdaRC),
    lambdaCR: scalar(byName.lambdaCR),
  };
}
