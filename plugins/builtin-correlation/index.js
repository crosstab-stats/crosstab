/**
 * @file plugins/builtin-correlation/index.js
 * Built-in plugin: Correlation ▸ Bivariate.
 *
 * Pearson correlation matrix over two or more scale variables. For each pair: the
 * coefficient (with significance stars), its 2-tailed p, and the pairwise N —
 * stacked in one cell, the SPSS layout. Computed in R (`cor.test`); the host
 * renders the structured table.
 *
 * Declarative plugin: the manifest declares the menu item + its input; the host
 * gathers the chosen variables and binds them in R as the data.frame `vars`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-correlation',
  name: 'Correlation',
  version: '0.3.0',
  apiVersion: '0.1.0',
  category: 'Correlation',
  keywords: ['pearson', 'correlation', 'bivariate', 'r'],
  howto:
    'GUI: Correlation ▸ Bivariate…, pick 2+ numeric variables and a method; or Correlation ▸ Partial / part correlation… to control for covariates. You get an SPSS-style correlation matrix.\n' +
    'Syntax: run builtin-correlation.run {"vars": ["age", "income"], "method": "pearson"}\n' +
    '  • vars — 2+ numeric measures to correlate.\n' +
    '  • method — "pearson" (default) | "spearman" | "kendall".\n' +
    'Syntax: run builtin-correlation.partial {"vars": ["age", "income"], "controls": ["education"], "type": "partial"}\n' +
    '  • controls — variables to partial out.\n' +
    '  • type — "partial" (default) | "semipartial".',
  rPackages: [],
  menu: [
    {
      label: 'Bivariate…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'vars', kind: 'variables', hint: 'Two or more numeric measures to correlate with each other.', types: ['numeric'], multiple: true },
        {
          name: 'method',
          kind: 'choice',
          label: 'Method',
          hint: 'Pearson for straight-line links; rank methods for ordinal or skewed data.',
          options: [
            { value: 'pearson', label: 'Pearson' },
            { value: 'spearman', label: "Spearman's rho" },
            { value: 'kendall', label: "Kendall's tau" },
          ],
          default: 'pearson',
        },
        {
          name: 'weight',
          kind: 'variables',
          label: 'Weight cases by (optional)',
          optional: true,
          multiple: false,
          types: ['numeric'],
          hint:
            'A survey weight (e.g. WTSSNR), so the correlation describes the population rather ' +
            'than the sample. Pearson only. Cancel this to count each case once.',
        },
      ],
    },
    {
      label: 'Partial / part correlation…',
      run: 'partial',
      order: 20,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Variables', hint: 'The numeric measures whose correlations you want, net of the controls.', types: ['numeric'], multiple: true, unique: true },
        { name: 'controls', kind: 'variables', label: 'Control for (partial out)', hint: 'The variables whose influence you want removed from each pair.', types: ['numeric'], multiple: true, unique: true },
        {
          name: 'type',
          kind: 'choice',
          label: 'Type',
          hint: 'Partial removes controls from both variables; semipartial from the row only.',
          default: 'partial',
          options: [
            { value: 'partial', label: 'Partial — remove controls from both variables' },
            { value: 'semipartial', label: 'Semipartial (part) — remove controls from the row variable only' },
          ],
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function run(app, { vars, method, weight }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Correlation needs at least two variables.');
    return;
  }
  const m = method === 'spearman' || method === 'kendall' ? method : 'pearson';
  // Weighting a rank method needs weighted ranks, and there is more than one
  // defensible way to rank 2.5 cases. Rather than pick one silently and print a
  // rho nobody can reproduce, say so and stop (#174f).
  if (weight && m !== 'pearson') {
    await app.results.appendError(
      `Correlation: a weight can only be applied to Pearson here. ${m === 'spearman' ? "Spearman's rho" : "Kendall's tau"} ` +
        'ranks the cases first, and weighted ranking has no single agreed definition — ' +
        'run it unweighted, or switch the method to Pearson.',
    );
    return;
  }
  const methodLabel = { pearson: 'Pearson', spearman: "Spearman's rho", kendall: "Kendall's tau" }[m];
  const meta = new Map((await app.data.getVariableMeta()).map((mm) => [mm.name, mm]));

  const rCode = `
    d <- data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    k <- ncol(d)
    W0 <- ${weight ? 'suppressWarnings(as.numeric(weight))' : 'rep(1, nrow(d))'}
    W0[!is.finite(W0) | W0 <= 0] <- NA
    # Weighted Pearson, pairwise: every N is sum(w) over the pairs that survive,
    # and the t test carries that N into its degrees of freedom. Verified against
    # case expansion — with integer weights this equals cor.test on the
    # physically replicated data.
    wcor <- function(x, y, w) {
      n <- sum(w); mx <- sum(w * x) / n; my <- sum(w * y) / n
      sxy <- sum(w * (x - mx) * (y - my))
      sxx <- sum(w * (x - mx)^2); syy <- sum(w * (y - my)^2)
      if (sxx <= 0 || syy <= 0) return(list(r = NA_real_, p = NA_real_))
      r <- sxy / sqrt(sxx * syy)
      if (n <= 2 || abs(r) >= 1) return(list(r = r, p = NA_real_))
      t <- r * sqrt((n - 2) / (1 - r^2))
      list(r = r, p = 2 * pt(-abs(t), n - 2))
    }
    r <- matrix(NA_real_, k, k); p <- matrix(NA_real_, k, k); n <- matrix(0, k, k)
    for (i in 1:k) for (j in 1:k) {
      x <- d[[i]]; y <- d[[j]]
      ok <- is.finite(x) & is.finite(y) & !is.na(W0)
      nn <- sum(W0[ok]); n[i, j] <- nn
      if (i == j) { r[i, j] <- 1 }
      else if (nn >= 3) {
        ct <- if (all(W0[ok] == 1))
          tryCatch(suppressWarnings(cor.test(x[ok], y[ok], method = ${rStr(m)}, exact = FALSE)), error = function(e) NULL)
        else
          tryCatch(wcor(x[ok], y[ok], W0[ok]), error = function(e) NULL)
        if (!is.null(ct)) { r[i, j] <- unname(if (is.null(ct$estimate)) ct$r else ct$estimate); p[i, j] <- if (is.null(ct$p.value)) ct$p else ct$p.value }
      }
    }
    list(k = k, r = as.vector(t(r)), p = as.vector(t(p)), n = as.vector(t(n)))`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');

  const c = normalizeResult(result);
  const k = c.k || vars.length;
  const at = (m, i, j) => m[i * k + j];
  const label = (name) => meta.get(name)?.label || name;

  const columns = ['', ...vars.map(label)];
  const rows = vars.map((rowName, i) => {
    const cells = vars.map((_, j) => {
      if (i === j) return ['1'];
      const r = at(c.r, i, j);
      const p = at(c.p, i, j);
      const n = at(c.n, i, j);
      if (!Number.isFinite(r)) return [''];
      return [rFmt(r, p), pFmt(p), `N = ${nFmt(n)}`];
    });
    return [label(rowName), ...cells];
  });

  await app.results.appendTable({ columns, rows, rowHeaders: true }, { caption: `Correlations (${methodLabel})` + (weight ? ` — weighted by ${meta.get(weight)?.label ?? weight}` : '') });
  await app.results.appendText(
    'Significance (two-tailed): a single star = p < .05, a double star = p < .01. N is pairwise.',
  );
}

/**
 * Partial / semipartial correlation, controlling for a set of covariates.
 * @param {object} app
 * @param {{vars: string[], controls: string[], type: string}} inputs
 */
export async function partial(app, { vars, controls, type }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Partial correlation needs at least two variables.');
    return;
  }
  if (!controls || controls.length < 1) {
    await app.results.appendError('Choose at least one control variable to partial out (otherwise use Bivariate).');
    return;
  }
  const semip = type === 'semipartial';
  const meta = new Map((await app.data.getVariableMeta()).map((mm) => [mm.name, mm]));

  const rCode = `
    V <- data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    Z <- data.frame(lapply(controls, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    ok <- stats::complete.cases(cbind(V, Z))
    V <- V[ok, , drop = FALSE]; Z <- Z[ok, , drop = FALSE]
    n <- nrow(V); k <- ncol(V); q <- ncol(Z)
    if (n < q + 3) stop("too few complete cases for this many control variables")
    Zc <- cbind(1, as.matrix(Z))
    H <- Zc %*% solve(crossprod(Zc)) %*% t(Zc)
    Vm <- as.matrix(V)
    res <- Vm - H %*% Vm
    semip <- ${semip ? 'TRUE' : 'FALSE'}
    M <- matrix(NA_real_, k, k)
    for (i in 1:k) for (j in 1:k) {
      a <- res[, i]
      b <- if (semip) Vm[, j] else res[, j]
      M[i, j] <- suppressWarnings(stats::cor(a, b))
    }
    diag(M) <- 1
    df <- n - 2 - q
    P <- matrix(NA_real_, k, k)
    for (i in 1:k) for (j in 1:k) if (i != j) {
      rr <- M[i, j]
      if (is.finite(rr) && abs(rr) < 1) { tt <- rr * sqrt(df / (1 - rr^2)); P[i, j] <- 2 * pt(-abs(tt), df) }
    }
    list(k = k, n = n, q = q, df = df, r = as.vector(t(M)), p = as.vector(t(P)))`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const c = normalizeResult(result);
  const k = c.k || vars.length;
  const at = (m, i, j) => m[i * k + j];
  const label = (name) => meta.get(name)?.label || name;

  const columns = ['', ...vars.map(label)];
  const rows = vars.map((rowName, i) => {
    const cells = vars.map((_, j) => {
      if (i === j) return ['1'];
      const r = at(c.r, i, j);
      const p = at(c.p, i, j);
      if (!Number.isFinite(r)) return [''];
      return [rFmt(r, p), pFmt(p)];
    });
    return [label(rowName), ...cells];
  });

  const ctrlLabel = controls.map(label).join(', ');
  await app.results.appendTable(
    { columns, rows, rowHeaders: true },
    { caption: `${semip ? 'Semipartial (Part)' : 'Partial'} Correlations — controlling for ${ctrlLabel} (N = ${c.nScalar}, df = ${c.df})` },
  );
  await app.results.appendText(
    semip
      ? `Semipartial (part) correlation: the control variable(s) are removed from the **row** variable only, so the table is **not symmetric**. Each value is the unique association of the row variable (net of ${ctrlLabel}) with the raw column variable. Stars: * p < .05, ** p < .01.`
      : `Partial correlation: the linear effect of ${ctrlLabel} is removed from **both** variables in each pair. Stars: * p < .05, ** p < .01.`,
  );
}

// --- helpers -----------------------------------------------------------------

function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((nm, i) => (byName[nm] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const num = (v) => arr(v).map((x) => (x == null ? NaN : Number(x)));
  const first = (v) => {
    const a = num(v);
    return a.length ? a[0] : NaN;
  };
  const kArr = num(byName.k);
  return { k: kArr.length ? kArr[0] : 0, r: num(byName.r), p: num(byName.p), n: num(byName.n), nScalar: first(byName.n), df: first(byName.df) };
}

/** Coefficient with significance stars. */
function rFmt(val, p) {
  const stars = !Number.isFinite(p) ? '' : p < 0.01 ? '**' : p < 0.05 ? '*' : '';
  return `${val.toFixed(3)}${stars}`;
}
function pFmt(val) {
  return Number.isFinite(val) ? `p ${val < 0.001 ? '< .001' : '= ' + val.toFixed(3)}` : 'p = —';
}
function nFmt(val) {
  return Number.isFinite(val) ? String(Math.round(val)) : '';
}
function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
