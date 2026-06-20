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
  rPackages: [],
  menu: [
    {
      label: 'Bivariate…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'vars', kind: 'variables', types: ['numeric'], multiple: true },
        {
          name: 'method',
          kind: 'choice',
          label: 'Method',
          options: [
            { value: 'pearson', label: 'Pearson' },
            { value: 'spearman', label: "Spearman's rho" },
            { value: 'kendall', label: "Kendall's tau" },
          ],
          default: 'pearson',
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
  const kArr = num(byName.k);
  return { k: kArr.length ? kArr[0] : 0, r: num(byName.r), p: num(byName.p), n: num(byName.n) };
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
