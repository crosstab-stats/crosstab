/**
 * @file plugins/builtin-limdep/index.js
 * Built-in plugin: **limited / censored / selected dependent variables** — three
 * regressions for outcomes that OLS handles badly.
 *
 *  - **Quantile regression** (`quantreg::rq`) — model conditional quantiles, not
 *    just the mean; shows how a predictor's effect differs across the low, middle
 *    and high end of the outcome (e.g. effects on the wage distribution).
 *  - **Tobit / censored regression** (`AER::tobit`) — for outcomes piled up at a
 *    floor or ceiling (bottom-coded income, hours, scores at the cap).
 *  - **Heckman selection** (`sampleSelection::heckit`) — corrects for sample
 *    selection / non-random missingness in the outcome (the classic wage-offer
 *    problem), reporting the inverse-Mills term and ρ.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-limdep',
  name: 'Quantile / Tobit / Heckman',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['quantile regression', 'tobit', 'censored', 'heckman', 'selection', 'rq', 'limited dependent', 'quantreg', 'inverse mills'],
  rPackages: ['quantreg', 'AER', 'sampleSelection'],
  menu: [
    {
      label: 'Quantile regression…',
      run: 'quantile',
      order: 150,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
        { name: 'taus', kind: 'text', label: 'Quantiles (comma-separated)', default: '0.25, 0.5, 0.75' },
      ],
    },
    {
      label: 'Tobit (censored) regression…',
      run: 'tobit',
      order: 160,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
        { name: 'left', kind: 'number', label: 'Lower censoring limit (blank = none)', default: 0, optional: true },
        { name: 'right', kind: 'number', label: 'Upper censoring limit (blank = none)', default: 0, optional: true },
      ],
    },
    {
      label: 'Heckman selection model…',
      run: 'heckman',
      order: 170,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome (observed only when selected)', multiple: false, types: ['numeric'], unique: true },
        { name: 'outIv', kind: 'variables', label: 'Outcome predictors', multiple: true, unique: true },
        { name: 'sel', kind: 'variables', label: 'Selection indicator (1 = observed)', multiple: false, unique: true },
        { name: 'selIv', kind: 'variables', label: 'Selection predictors', multiple: true, unique: true },
      ],
    },
  ],
};

const term = (n, meta) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);

// --- Quantile regression -----------------------------------------------------

export async function quantile(app, { y: yName, ivs: ivNames, taus }) {
  if (!yName || !ivNames || !ivNames.length) {
    await app.results.appendError('Quantile regression: choose an outcome and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['quantreg']);
  const meta = metaMap(await app.data.getVariableMeta());
  const tauList = String(taus || '').split(',').map((x) => Number(x.trim())).filter((x) => x > 0 && x < 1);
  const tv = tauList.length ? tauList : [0.25, 0.5, 0.75];
  const recodes = [recodeLine('y', meta.get(yName)), ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const formula = `.y ~ ${ivNames.map((n) => term(n, meta)).join(' + ')}`;
  const rCode = `
    suppressMessages(library(quantreg))
    ${recodes}
    d <- data.frame(.y = as.numeric(y)); d <- cbind(d, ivs); d <- d[stats::complete.cases(d), , drop = FALSE]
    taus <- c(${tv.join(', ')})
    fit <- rq(as.formula(${rStr(formula)}), tau = taus, data = d)
    ss <- summary(fit, se = "nid"); if (inherits(ss, "summary.rq")) ss <- list(ss)
    est <- sapply(ss, function(s) s$coefficients[, 1]); pv <- sapply(ss, function(s) s$coefficients[, 4])
    if (is.null(dim(est))) { est <- t(as.matrix(est)); pv <- t(as.matrix(pv)) }
    list(terms = rownames(ss[[1]]$coefficients), taus = taus, est = as.numeric(est), p = as.numeric(pv), n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), taus2 = r.nums('taus'), est = r.nums('est'), p = r.nums('p');
  const nT = terms.length;

  await app.results.appendTable(
    {
      columns: ['', ...taus2.map((t) => `τ = ${t}`)],
      rows: terms.map((tm, i) => [tm === '(Intercept)' ? '(Constant)' : prettyTerm(tm),
        ...taus2.map((_, j) => withStars(est[j * nT + i], p[j * nT + i]))]),
      rowHeaders: true,
    },
    { caption: `Quantile Regression — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('n')})` },
  );
  await app.results.appendText(
    'Each column is a separate regression at that quantile of the outcome. Comparing a predictor\'s coefficient across quantiles shows whether its effect is larger at the bottom vs the top of the distribution (e.g. a policy that helps low earners more than high earners). Stars: * p<.05, ** p<.01.',
  );
}

// --- Tobit -------------------------------------------------------------------

export async function tobit(app, { y: yName, ivs: ivNames, left, right }) {
  if (!yName || !ivNames || !ivNames.length) {
    await app.results.appendError('Tobit: choose an outcome and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['AER']);
  const meta = metaMap(await app.data.getVariableMeta());
  const L = Number.isFinite(left) ? left : null;
  const R = Number.isFinite(right) && right !== 0 && right > (L ?? -Infinity) ? right : null;
  const leftArg = L != null ? `left = ${L}` : 'left = -Inf';
  const rightArg = R != null ? `right = ${R}` : 'right = Inf';
  const recodes = [recodeLine('y', meta.get(yName)), ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const formula = `.y ~ ${ivNames.map((n) => term(n, meta)).join(' + ')}`;
  const rCode = `
    suppressMessages(library(AER))
    ${recodes}
    d <- data.frame(.y = as.numeric(y)); d <- cbind(d, ivs); d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- AER::tobit(as.formula(${rStr(formula)}), ${leftArg}, ${rightArg}, data = d)
    s <- summary(fit); co <- s$coefficients
    nLeft <- if (is.finite(${L != null ? L : '-Inf'})) sum(d$.y <= ${L != null ? L : '-Inf'}) else 0
    nRight <- if (is.finite(${R != null ? R : 'Inf'})) sum(d$.y >= ${R != null ? R : 'Inf'}) else 0
    list(terms = rownames(co), est = co[, 1], se = co[, 2], z = co[, 3], p = co[, 4],
         n = nrow(d), nLeft = nLeft, nRight = nRight)`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 'z', 'Sig.'],
      rows: terms.map((t, i) => [tobitTerm(t), f(est[i], 4), f(se[i], 4), f(z[i], 2), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: `Tobit Regression — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('n')}; censored: ${r.num('nLeft')} low, ${r.num('nRight')} high)` },
  );
  await app.results.appendText(
    'Tobit models a **latent** outcome that is observed only within the censoring limits; coefficients are on that latent scale (the direction and significance read like OLS). Use it when many cases pile up exactly at a floor or ceiling. `Log(scale)` is the log residual SD.',
  );
}

// --- Heckman -----------------------------------------------------------------

export async function heckman(app, { y: yName, outIv: outNames, sel: selName, selIv: selNames }) {
  if (!yName || !outNames || !outNames.length || !selName || !selNames || !selNames.length) {
    await app.results.appendError('Heckman: choose an outcome + its predictors, a selection indicator, and selection predictors.');
    return;
  }
  await app.webr.installPackages(['sampleSelection']);
  const meta = metaMap(await app.data.getVariableMeta());
  const allIv = Array.from(new Set([...outNames, ...selNames]));
  const srcOf = (n) => (outNames.includes(n) ? 'outIv' : 'selIv');
  const recodes = [
    recodeLine('y', meta.get(yName)), recodeLine('sel', meta.get(selName)),
    ...allIv.map((n) => recodeLine(`${srcOf(n)}[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const mk = allIv.map((n) => `d[[${rStr(n)}]] <- ${srcOf(n)}[[${rStr(n)}]]`).join('\n');
  const selF = `.sel ~ ${selNames.map((n) => term(n, meta)).join(' + ')}`;
  const outF = `.y ~ ${outNames.map((n) => term(n, meta)).join(' + ')}`;
  const nSel = selNames.length + 1;
  const nOut = outNames.length + 1;
  const rCode = `
    suppressMessages(library(sampleSelection))
    ${recodes}
    d <- data.frame(.y = as.numeric(y), .sel = as.integer(as.numeric(sel) > 0))
    ${mk}
    fit <- heckit(as.formula(${rStr(selF)}), as.formula(${rStr(outF)}), data = d)
    co <- coef(summary(fit))
    list(terms = rownames(co), est = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
         nSel = ${nSel}, nOut = ${nOut}, n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), t = r.nums('t'), p = r.nums('p');
  const section = (i) => (i < nSel ? 'Selection: ' : i < nSel + nOut ? 'Outcome: ' : '');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 't', 'Sig.'],
      rows: terms.map((t2, i) => [`${section(i)}${heckLabel(t2)}`, f(est[i], 4), f(se[i], 4), f(t[i], 2), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: `Heckman Selection — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('n')})` },
  );
  await app.results.appendText(
    'The **selection** equation models who is observed; the **outcome** equation is corrected for that selection. A significant **invMillsRatio** (or **ρ** far from 0) means selection bias was present and OLS on the observed cases alone would be biased. ρ is the correlation between the two equations\' errors.',
  );
}

// --- helpers -----------------------------------------------------------------

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function withStars(b, p) {
  if (!Number.isFinite(b)) return '—';
  const s = !Number.isFinite(p) ? '' : p < 0.01 ? '**' : p < 0.05 ? '*' : '';
  return `${b.toFixed(3)}${s}`;
}

function tobitTerm(t) {
  if (t === '(Intercept)') return '(Constant)';
  if (/^Log\(scale\)$/.test(t)) return 'Log(scale)';
  return prettyTerm(t);
}

function heckLabel(t) {
  if (t === '(Intercept)') return '(Constant)';
  if (t === 'invMillsRatio') return 'inverse Mills ratio (λ)';
  if (t === 'sigma') return 'σ';
  if (t === 'rho') return 'ρ';
  return prettyTerm(t);
}

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
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? 'NA' : String(x))),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
