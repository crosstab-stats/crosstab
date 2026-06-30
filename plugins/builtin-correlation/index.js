/**
 * @file plugins/builtin-correlation/index.js
 * Built-in plugin: Correlation ▸ Bivariate.
 *
 * Pearson correlation matrix over two or more scale variables. For each pair: the
 * coefficient (with significance stars), its 2-tailed p, and the pairwise N —
 * stacked in one cell, the SPSS layout. Computed in R (`cor.test`); the host
 * renders the structured table. User-missing codes are recoded to NA first
 * (pairwise-complete), matching SPSS.
 *
 * Declarative plugin: the manifest declares the menu item + its input; the host
 * gathers the chosen variables and binds them in R as the data.frame `vars`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-correlation',
  name: 'Correlation',
  version: '0.2.0',
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
export async function run(app, { vars, method }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Correlation needs at least two variables.');
    return;
  }
  const m = method === 'spearman' || method === 'kendall' ? method : 'pearson';
  const methodLabel = { pearson: 'Pearson', spearman: "Spearman's rho", kendall: "Kendall's tau" }[m];
  const meta = new Map((await app.data.getVariableMeta()).map((mm) => [mm.name, mm]));

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
    d <- data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    k <- ncol(d)
    r <- matrix(NA_real_, k, k); p <- matrix(NA_real_, k, k); n <- matrix(0, k, k)
    for (i in 1:k) for (j in 1:k) {
      x <- d[[i]]; y <- d[[j]]
      ok <- is.finite(x) & is.finite(y); nn <- sum(ok); n[i, j] <- nn
      if (i == j) { r[i, j] <- 1 }
      else if (nn >= 3) {
        ct <- tryCatch(suppressWarnings(cor.test(x[ok], y[ok], method = ${rStr(m)}, exact = FALSE)), error = function(e) NULL)
        if (!is.null(ct)) { r[i, j] <- unname(ct$estimate); p[i, j] <- ct$p.value }
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

  await app.results.appendTable({ columns, rows, rowHeaders: true }, { caption: `Correlations (${methodLabel})` });
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
  const recodeOne = (name, holder) => {
    const mv = (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
    if (!mv.length) return '';
    const col = `${holder}[[${rStr(name)}]]`;
    return `${col}[${col} %in% c(${mv.map(Number).join(', ')})] <- NA`;
  };
  const recode = [...vars.map((n) => recodeOne(n, 'vars')), ...controls.map((n) => recodeOne(n, 'controls'))]
    .filter(Boolean)
    .join('\n');

  const rCode = `
    ${recode}
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
