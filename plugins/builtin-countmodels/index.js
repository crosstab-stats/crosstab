/**
 * @file plugins/builtin-countmodels/index.js
 * Built-in plugin: **count regression** — Poisson and negative binomial GLMs for
 * count outcomes (events, incidents, bill/protest counts, visits). Reports
 * coefficients with **incidence-rate ratios** (exp B), the standard count-model
 * interpretation, plus an overdispersion check that points to NB when Poisson's
 * equal-mean-variance assumption fails.
 *
 * Poisson is base R `glm`; negative binomial is `MASS::glm.nb`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-countmodels',
  name: 'Count models',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['poisson', 'negative binomial', 'count', 'glm', 'rate', 'incidence', 'overdispersion', 'irr'],
  disciplines: ['Public Health', 'Criminology', 'Political Science'],
  rPackages: ['MASS'],
  menu: [
    {
      label: 'Poisson regression…',
      run: 'poisson',
      order: 40,
      inputs: COUNT_INPUTS('Count outcome'),
    },
    {
      label: 'Negative binomial regression…',
      run: 'negbin',
      order: 50,
      inputs: COUNT_INPUTS('Count outcome'),
    },
  ],
};

function COUNT_INPUTS(dvLabel) {
  return [
    { name: 'dv', kind: 'variables', label: dvLabel, multiple: false, types: ['numeric'], unique: true },
    { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
  ];
}

export async function poisson(app, inputs) {
  await fitCount(app, inputs, false);
}

export async function negbin(app, inputs) {
  await fitCount(app, inputs, true);
}

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[]}} inputs
 * @param {boolean} nb - negative binomial vs Poisson
 */
async function fitCount(app, { dv: dvName, ivs: ivNames }, nb) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Count model: choose a count outcome and at least one predictor.');
    return;
  }
  if (nb) await app.webr.installPackages(['MASS']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [recodeLine('dv', meta.get(dvName)), ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.dv ~ ${ivNames.map(term).join(' + ')}`;
  const fitCall = nb
    ? `MASS::glm.nb(as.formula(${rStr(formula)}), data = d)`
    : `glm(as.formula(${rStr(formula)}), data = d, family = poisson())`;
  const rCode = `
    ${nb ? 'suppressMessages(library(MASS))' : ''}
    ${recodes}
    dv <- as.numeric(dv)
    if (any(dv[is.finite(dv)] < 0, na.rm = TRUE)) stop("count outcome must be non-negative")
    d <- cbind(.dv = dv, ivs); d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- ${fitCall}
    s <- summary(fit); co <- s$coefficients
    ci <- suppressMessages(confint.default(fit))
    disp <- sum(residuals(fit, type = "pearson")^2) / fit$df.residual
    list(terms = rownames(co), est = co[, 1], se = co[, 2], z = co[, 3], p = co[, 4],
         lo = ci[, 1], hi = ci[, 2], dispersion = disp, n = nrow(d),
         theta = if (${nb ? 'TRUE' : 'FALSE'}) fit$theta else NA_real_)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p'), lo = r.nums('lo'), hi = r.nums('hi');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 'z', 'Sig.', 'IRR (exp B)', '95% CI (IRR)'],
      rows: terms.map((t, i) => [
        t === '(Intercept)' ? '(Constant)' : prettyTerm(t),
        f(est[i], 3), f(se[i], 3), f(z[i], 3), fmtP(p[i]),
        f(Math.exp(est[i]), 3), ci(Math.exp(lo[i]), Math.exp(hi[i])),
      ]),
      rowHeaders: true,
    },
    { caption: `${nb ? 'Negative Binomial' : 'Poisson'} Regression — outcome: ${labelOf(meta.get(dvName), dvName)} (N = ${r.num('n')})` },
  );
  const disp = r.num('dispersion');
  const note = nb
    ? `Negative binomial (θ = ${f(r.num('theta'), 3)}) allows variance > mean. IRRs are exp(B): an IRR of 1.2 means a 20% higher expected count per unit.`
    : `Pearson dispersion = ${f(disp, 2)}. ` +
      (disp > 1.5
        ? '**> 1.5 suggests overdispersion** — the Poisson SEs are likely too small; re-run as **Negative binomial**.'
        : 'Near 1 is consistent with the Poisson equal-mean-variance assumption.') +
      ' IRRs are exp(B): an IRR of 1.2 means a 20% higher expected count per unit.';
  await app.results.appendText(note);
}

// --- helpers -----------------------------------------------------------------

function metaMap(meta) {
  return new Map(meta.map((m) => [m.name, m]));
}

function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
}

function prettyTerm(term) {
  const m = /^factor\(`?(.+?)`?\)(.*)$/.exec(term);
  return m ? `${m[1]}${m[2] ? ` = ${m[2]}` : ''}` : term.replace(/`/g, '');
}

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function ci(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—';
}

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map(Number),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
