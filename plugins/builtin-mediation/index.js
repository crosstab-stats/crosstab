/**
 * @file plugins/builtin-mediation/index.js
 * Built-in plugin: **mediation & moderation** — the two "how/when does X affect
 * Y" questions that dominate social and health psychology.
 *
 *  - **Mediation** — does X affect Y *through* a mediator M? A path model
 *    (lavaan) decomposing the total effect into direct (X→Y) and indirect
 *    (X→M→Y) components, with the indirect effect's standard error from the
 *    delta method (optionally bootstrap), plus the proportion mediated.
 *  - **Moderation** — does the X→Y effect *depend on* a moderator W? An OLS model
 *    with an X×W interaction, plus **simple slopes** of X at low / mean / high W
 *    (mean ± 1 SD) to probe the interaction.
 *
 * Mediation uses lavaan directly; the moderation simple-slope estimates and SEs
 * are linear combinations of the OLS coefficients (validated against
 * interactions::sim_slopes).
 */

/** Shared lavaan WebR shim — neutralises the spurious-NA option check. */
const LAVAAN_PRELUDE = `
suppressMessages(library(lavaan))
if (!isTRUE(getOption("ct.lavaan.patched"))) {
  local({ ns <- asNamespace("lavaan"); orig <- get("lav_options_checkinterval", ns)
    suppressWarnings({ unlockBinding("lav_options_checkinterval", ns)
      assign("lav_options_checkinterval", function(...) { r <- tryCatch(orig(...), error = function(e) NA)
        if (length(r) != 1 || is.na(r)) TRUE else r }, ns) }) })
  options(ct.lavaan.patched = TRUE) }`;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-mediation',
  name: 'Mediation & moderation',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['mediation', 'moderation', 'indirect effect', 'simple slopes', 'interaction', 'process', 'path analysis', 'lavaan', 'sobel'],
  rPackages: ['lavaan'],
  menu: [
    {
      label: 'Mediation (X → M → Y)…',
      run: 'mediation',
      order: 120,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Predictor (X)', multiple: false, types: ['numeric'], unique: true },
        { name: 'm', kind: 'variables', label: 'Mediator (M)', multiple: false, types: ['numeric'], unique: true },
        { name: 'y', kind: 'variables', label: 'Outcome (Y)', multiple: false, types: ['numeric'], unique: true },
        { name: 'covs', kind: 'variables', label: 'Covariates (numeric, optional)', multiple: true, types: ['numeric'], optional: true, unique: true },
        { name: 'se', kind: 'choice', label: 'Indirect-effect inference', default: 'delta', options: [
          { value: 'delta', label: 'Delta method (fast)' },
          { value: 'bootstrap', label: 'Bootstrap (1000 resamples, slower)' },
        ] },
      ],
    },
    {
      label: 'Moderation (X × W)…',
      run: 'moderation',
      order: 130,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome (Y)', multiple: false, types: ['numeric'], unique: true },
        { name: 'x', kind: 'variables', label: 'Focal predictor (X)', multiple: false, types: ['numeric'], unique: true },
        { name: 'w', kind: 'variables', label: 'Moderator (W)', multiple: false, types: ['numeric'], unique: true },
        { name: 'covs', kind: 'variables', label: 'Covariates (optional)', multiple: true, optional: true, unique: true },
      ],
    },
  ],
};

// --- Mediation (lavaan) ------------------------------------------------------

export async function mediation(app, { x: xName, m: mName, y: yName, covs: covNames, se }) {
  if (!xName || !mName || !yName) {
    await app.results.appendError('Mediation: choose a predictor (X), a mediator (M), and an outcome (Y).');
    return;
  }
  await app.webr.installPackages(['lavaan']);
  const meta = metaMap(await app.data.getVariableMeta());
  const covs = covNames || [];
  const covTok = covs.map((_, i) => `C${i + 1}`);
  const recodes = [
    recodeLine('x', meta.get(xName)), recodeLine('m', meta.get(mName)), recodeLine('y', meta.get(yName)),
    ...covs.map((n) => recodeLine(`covs[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const covMk = covs.map((n, i) => `d$${covTok[i]} <- as.numeric(covs[[${rStr(n)}]])`).join('\n');
  const covPart = covTok.length ? ' + ' + covTok.join(' + ') : '';
  const boot = se === 'bootstrap';
  const model = `M ~ a*X${covPart}\nY ~ b*M + cp*X${covPart}\nindirect := a*b\ntotal := cp + a*b\nprop := (a*b)/(cp + a*b)`;
  const semCall = boot
    ? `sem(${rStr(model)}, data = d, se = "bootstrap", bootstrap = 1000L)`
    : `sem(${rStr(model)}, data = d)`;
  const ciType = boot ? '"perc"' : '"standard"';
  const rCode = `
    ${LAVAAN_PRELUDE}
    ${recodes}
    d <- data.frame(X = as.numeric(x), M = as.numeric(m), Y = as.numeric(y))
    ${covMk}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- ${semCall}
    pe <- parameterEstimates(fit, boot.ci.type = ${ciType})
    ord <- c("a", "b", "cp", "indirect", "total", "prop")
    pe <- pe[match(ord, pe$label), ]
    list(label = pe$label, est = pe$est, se = pe$se, z = pe$z, p = pe$pvalue,
         lo = pe$ci.lower, hi = pe$ci.upper, n = lavInspect(fit, "nobs"))`;
  const r = flat(await runR(app, rCode));
  const lab = r.strs('label'), est = r.nums('est'), sev = r.nums('se'), z = r.nums('z'), p = r.nums('p'), lo = r.nums('lo'), hi = r.nums('hi');
  const nameMap = {
    a: `a: ${shortLabel(meta, xName)} → ${shortLabel(meta, mName)}`,
    b: `b: ${shortLabel(meta, mName)} → ${shortLabel(meta, yName)}`,
    cp: `c′ (direct): ${shortLabel(meta, xName)} → ${shortLabel(meta, yName)}`,
    indirect: 'Indirect (a × b)',
    total: 'Total effect',
    prop: 'Proportion mediated',
  };

  await app.results.appendTable(
    {
      columns: ['Path', 'Estimate', 'Std. Error', 'z', 'Sig.', '95% CI'],
      rows: lab.map((l, i) => [nameMap[l] || l, f(est[i], 3), f(sev[i], 3), f(z[i], 2), fmtP(p[i]), ci(lo[i], hi[i])]),
      rowHeaders: true,
    },
    { caption: `Mediation — ${shortLabel(meta, xName)} → ${shortLabel(meta, mName)} → ${shortLabel(meta, yName)} (N = ${r.num('n')}${boot ? ', bootstrap' : ''})` },
  );
  await app.results.appendText(
    `The **indirect effect (a × b)** is the part of X's effect that runs through the mediator; a significant indirect effect is the evidence for mediation. **c′** is the remaining direct effect. ` +
      (boot ? 'Bootstrap percentile CIs are used (recommended — the indirect effect is not normally distributed).' : 'Standard errors are delta-method (Sobel-type); for the indirect effect, **bootstrap** CIs are generally preferred — re-run with that option if needed.'),
  );
}

// --- Moderation (OLS + simple slopes) ---------------------------------------

export async function moderation(app, { y: yName, x: xName, w: wName, covs: covNames }) {
  if (!yName || !xName || !wName) {
    await app.results.appendError('Moderation: choose an outcome (Y), a focal predictor (X), and a moderator (W).');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const covs = covNames || [];
  const covTok = covs.map((_, i) => `C${i + 1}`);
  const recodes = [
    recodeLine('y', meta.get(yName)), recodeLine('x', meta.get(xName)), recodeLine('w', meta.get(wName)),
    ...covs.map((n) => recodeLine(`covs[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const covMk = covs.map((n, i) => {
    const fac = meta.get(n)?.type === 'factor';
    return `d$${covTok[i]} <- ${fac ? `factor(covs[[${rStr(n)}]])` : `as.numeric(covs[[${rStr(n)}]])`}`;
  }).join('\n');
  const covPart = covTok.length ? ' + ' + covTok.join(' + ') : '';
  const rCode = `
    ${recodes}
    d <- data.frame(Y = as.numeric(y), X = as.numeric(x), W = as.numeric(w))
    ${covMk}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- lm(as.formula(paste0("Y ~ X*W", ${rStr(covPart)})), data = d)
    s <- summary(fit); co <- s$coefficients; b <- coef(fit); V <- vcov(fit)
    wm <- mean(d$W); wsd <- sd(d$W); lv <- c(wm - wsd, wm, wm + wsd)
    bX <- b[["X"]]; bXW <- b[["X:W"]]
    vXX <- V["X", "X"]; vII <- V["X:W", "X:W"]; vXI <- V["X", "X:W"]
    slope <- bX + bXW * lv; sse <- sqrt(vXX + lv^2 * vII + 2 * lv * vXI)
    df <- df.residual(fit); tt <- slope / sse; pp <- 2 * pt(-abs(tt), df)
    list(terms = rownames(co), est = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
         levels = lv, wlabels = c("Low (−1 SD)", "Mean", "High (+1 SD)"),
         slope = slope, sslope = sse, st = tt, sp = pp, df = df, n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), sev = r.nums('se'), tv = r.nums('t'), p = r.nums('p');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 't', 'Sig.'],
      rows: terms.map((t, i) => [modTerm(t, meta, xName, wName), f(est[i], 3), f(sev[i], 3), f(tv[i], 2), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: `Moderation — ${shortLabel(meta, yName)} regressed on ${shortLabel(meta, xName)} × ${shortLabel(meta, wName)} (N = ${r.num('n')})` },
  );

  const wl = r.strs('wlabels'), lv = r.nums('levels'), sl = r.nums('slope'), sse = r.nums('sslope'), st = r.nums('st'), sp = r.nums('sp');
  await app.results.appendTable(
    {
      columns: [`Moderator (${shortLabel(meta, wName)})`, 'Value', `Slope of ${shortLabel(meta, xName)}`, 'Std. Error', 't', 'Sig.'],
      rows: wl.map((w, i) => [w, f(lv[i], 3), f(sl[i], 3), f(sse[i], 3), f(st[i], 2), fmtP(sp[i])]),
      rowHeaders: true,
    },
    { caption: 'Simple Slopes of X at Levels of W' },
  );
  const interP = (() => { const idx = terms.indexOf('X:W'); return idx >= 0 ? p[idx] : NaN; })();
  await app.results.appendText(
    `The **X × W interaction** ${Number.isFinite(interP) ? `(${fmtPInline(interP)}) ` : ''}is the moderation effect: a significant interaction means X's effect on Y changes with W. The simple slopes show X's effect at low, average, and high W (mean ± 1 SD) — read them to describe *how* the effect changes.`,
  );
}

// --- helpers -----------------------------------------------------------------

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function shortLabel(meta, name) {
  return meta.get(name)?.label || name;
}

function modTerm(term, meta, xName, wName) {
  const map = {
    '(Intercept)': '(Constant)',
    X: shortLabel(meta, xName),
    W: shortLabel(meta, wName),
    'X:W': `${shortLabel(meta, xName)} × ${shortLabel(meta, wName)}`,
  };
  return map[term] || prettyTerm(term);
}

function metaMap(meta) {
  return new Map(meta.map((m) => [m.name, m]));
}

function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
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

function fmtPInline(p) {
  if (!Number.isFinite(p)) return 'p = —';
  return p < 0.001 ? 'p < .001' : `p = ${p.toFixed(3)}`;
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
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
