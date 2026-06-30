/**
 * @file plugins/builtin-survival/index.js
 * Built-in plugin: **survival analysis** (time-to-event) — the core toolkit for
 * gerontology, public health, criminology (recidivism), event-history sociology
 * and any "how long until X happens, accounting for cases that haven't yet"
 * question. Right-censoring is handled throughout.
 *
 *  - **Kaplan–Meier & log-rank** — non-parametric survival curves by group, median
 *    survival with 95% CI, the log-rank test of equal survival, and a plotted
 *    survival curve.
 *  - **Cox proportional hazards** — semi-parametric regression of the hazard on
 *    covariates, reported as hazard ratios, with the concordance (C) index, the
 *    likelihood-ratio test, and a `cox.zph` check of the proportional-hazards
 *    assumption.
 *
 * Uses R's `survival` package directly.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-survival',
  name: 'Survival analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Survival',
  keywords: ['survival', 'kaplan-meier', 'kaplan meier', 'log-rank', 'cox', 'proportional hazards', 'hazard ratio', 'time to event', 'censoring', 'event history'],
  disciplines: ['Public Health', 'Gerontology', 'Nutrition, Food & Dietetics', 'Sociology'],
  howto:
    'GUI: Survival ▸ Kaplan–Meier & log-rank… or Cox proportional hazards…, then pick a time variable and an event indicator (1 = event, 0 = censored). You get survival curves with median survival, or hazard ratios.\n' +
    'Syntax: run builtin-survival.kaplanMeier {"time": "months", "status": "died", "group": "treatment"}\n' +
    'Syntax: run builtin-survival.cox {"time": "months", "status": "died", "preds": ["age", "treatment"]}\n' +
    '  • time — follow-up time until the event or censoring.\n' +
    '  • status — event indicator (1 = event, 0 = censored).\n' +
    '  • group — optional grouping variable (Kaplan–Meier); preds — covariates (Cox).',
  rPackages: ['survival', 'svglite'],
  menu: [
    {
      label: 'Kaplan–Meier & log-rank…',
      run: 'kaplanMeier',
      order: 10,
      inputs: [
        { name: 'time', kind: 'variables', label: 'Time to event', hint: 'Follow-up time until the event or censoring.', multiple: false, types: ['numeric'], unique: true },
        { name: 'status', kind: 'variables', label: 'Event (1 = event, 0 = censored)', hint: 'Marks whether the event happened or the case was censored.', multiple: false, unique: true },
        { name: 'group', kind: 'variables', label: 'Compare groups (optional)', hint: 'Splits cases into groups whose survival curves are compared.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
      ],
    },
    {
      label: 'Cox proportional hazards…',
      run: 'cox',
      order: 20,
      inputs: [
        { name: 'time', kind: 'variables', label: 'Time to event', hint: 'Follow-up time until the event or censoring.', multiple: false, types: ['numeric'], unique: true },
        { name: 'status', kind: 'variables', label: 'Event (1 = event, 0 = censored)', hint: 'Marks whether the event happened or the case was censored.', multiple: false, unique: true },
        { name: 'preds', kind: 'variables', label: 'Predictors', hint: 'The variables you think speed up or slow down the event.', multiple: true, unique: true },
      ],
    },
  ],
};

const ACCENT = '#2980b9';
const PALETTE = ['#2980b9', '#e67e22', '#27ae60', '#c0392b', '#8e44ad', '#16a085'];

// --- Kaplan–Meier & log-rank -------------------------------------------------

export async function kaplanMeier(app, { time: timeName, status: statusName, group: groupName }) {
  if (!timeName || !statusName) {
    await app.results.appendError('Kaplan–Meier: choose a time variable and an event indicator.');
    return;
  }
  await app.webr.installPackages(['survival']);
  const meta = metaMap(await app.data.getVariableMeta());
  const hasGroup = !!groupName;
  const recodes = [
    recodeLine('time', meta.get(timeName)), recodeLine('status', meta.get(statusName)),
    hasGroup ? recodeLine('group', meta.get(groupName)) : '',
  ].filter(Boolean).join('\n');
  const rhs = hasGroup ? 'grp' : '1';
  const cols = PALETTE.slice(0, 6).map((c) => `"${c}"`).join(', ');
  const rCode = `
    suppressMessages({library(survival); library(svglite)})
    ${STATUS01_R}
    ${recodes}
    .time <- as.numeric(time); .st <- status01(status)
    ${hasGroup ? 'grp <- factor(group)' : ''}
    d <- data.frame(.time = .time, .st = .st${hasGroup ? ', grp = grp' : ''})
    d <- d[stats::complete.cases(d) & d$.time >= 0, , drop = FALSE]
    sf <- survfit(Surv(.time, .st) ~ ${rhs}, data = d)
    tb <- summary(sf)$table
    if (is.null(dim(tb))) tb <- t(as.matrix(tb))
    rn <- rownames(tb); if (is.null(rn)) rn <- "Overall"
    cols_pal <- c(${cols})
    .ct_dev <- svgstring(width = 7, height = 4.8, pointsize = 11)
    par(mar = c(4.2, 4.4, 2.2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
    plot(sf, col = cols_pal[seq_len(max(1, length(sf$strata)))], lwd = 2, mark.time = TRUE,
         xlab = "Time", ylab = "Survival probability", main = "Kaplan–Meier survival")
    ${hasGroup ? 'legend("topright", legend = sub("grp=", "", names(sf$strata)), col = cols_pal, lwd = 2, bty = "n")' : ''}
    dev.off(); svg <- .ct_dev()
    lr <- NULL
    if (${hasGroup ? 'TRUE' : 'FALSE'} && nlevels(d$grp) > 1) {
      sd <- survdiff(Surv(.time, .st) ~ grp, data = d)
      lr <- list(chi = sd$chisq, df = length(sd$n) - 1, p = pchisq(sd$chisq, length(sd$n) - 1, lower.tail = FALSE))
    }
    list(groups = sub("^[^=]*=", "", rn), n = tb[, "records"], events = tb[, "events"],
         median = tb[, "median"], lcl = tb[, "0.95LCL"], ucl = tb[, "0.95UCL"],
         lrChi = if (is.null(lr)) NA_real_ else lr$chi, lrDf = if (is.null(lr)) NA_real_ else lr$df,
         lrP = if (is.null(lr)) NA_real_ else lr$p, svg = svg)`;
  const r = flat(await runR(app, rCode));
  const groups = r.strs('groups'), nn = r.nums('n'), ev = r.nums('events'), med = r.nums('median'), lcl = r.nums('lcl'), ucl = r.nums('ucl');

  await app.results.appendTable(
    {
      columns: [hasGroup ? labelOf(meta.get(groupName), groupName) : '', 'N', 'Events', 'Median survival', '95% CI'],
      rows: groups.map((g, i) => [hasGroup ? lvl(meta.get(groupName), g) : 'Overall', String(nn[i]), String(ev[i]), f(med[i], 3), ci(lcl[i], ucl[i])]),
      rowHeaders: true,
    },
    { caption: `Kaplan–Meier — time: ${labelOf(meta.get(timeName), timeName)}` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));

  if (Number.isFinite(r.num('lrChi'))) {
    await app.results.appendTable(
      { columns: ['', 'Chi-Square', 'df', 'Sig.'], rows: [['Log-rank (Mantel–Cox)', f(r.num('lrChi'), 3), f(r.num('lrDf'), 0), fmtP(r.num('lrP'))]], rowHeaders: true },
      { caption: 'Test of Equality of Survival Distributions' },
    );
    await app.results.appendText(
      'The **log-rank** test compares the whole survival curves across groups (H₀: identical survival). The plotted curves show *when* groups diverge; median survival is the time by which half the cases have had the event. "+" marks are censored cases.',
    );
  }
}

// --- Cox proportional hazards ------------------------------------------------

export async function cox(app, { time: timeName, status: statusName, preds: predNames }) {
  if (!timeName || !statusName || !predNames || !predNames.length) {
    await app.results.appendError('Cox regression: choose a time variable, an event indicator, and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['survival']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [
    recodeLine('time', meta.get(timeName)), recodeLine('status', meta.get(statusName)),
    ...predNames.map((n) => recodeLine(`preds[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `Surv(.time, .st) ~ ${predNames.map(term).join(' + ')}`;
  const rCode = `
    suppressMessages(library(survival))
    ${STATUS01_R}
    ${recodes}
    .time <- as.numeric(time); .st <- status01(status)
    d <- data.frame(.time = .time, .st = .st)
    d <- cbind(d, preds)
    d <- d[stats::complete.cases(d) & d$.time >= 0, , drop = FALSE]
    fit <- coxph(as.formula(${rStr(formula)}), data = d)
    s <- summary(fit); co <- s$coefficients; ci_ <- s$conf.int
    zph <- tryCatch(cox.zph(fit), error = function(e) NULL)
    zt <- if (is.null(zph)) NULL else zph$table
    list(terms = rownames(co), coef = co[, "coef"], hr = co[, "exp(coef)"], se = co[, "se(coef)"],
         z = co[, "z"], p = co[, "Pr(>|z|)"], lo = ci_[, "lower .95"], hi = ci_[, "upper .95"],
         n = s$n, nevent = s$nevent, concordance = unname(s$concordance["C"]),
         lrTest = unname(s$logtest["test"]), lrDf = unname(s$logtest["df"]), lrP = unname(s$logtest["pvalue"]),
         zphTerms = if (is.null(zt)) character(0) else rownames(zt),
         zphChi = if (is.null(zt)) numeric(0) else zt[, "chisq"], zphP = if (is.null(zt)) numeric(0) else zt[, "p"])`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), coef = r.nums('coef'), hr = r.nums('hr'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p'), lo = r.nums('lo'), hi = r.nums('hi');

  await app.results.appendTable(
    {
      columns: ['', 'B (log-HR)', 'SE', 'z', 'Sig.', 'Hazard ratio', '95% CI (HR)'],
      rows: terms.map((t, i) => [prettyTerm(t), f(coef[i], 3), f(se[i], 3), f(z[i], 2), fmtP(p[i]), f(hr[i], 3), ci(lo[i], hi[i])]),
      rowHeaders: true,
    },
    { caption: `Cox Proportional Hazards — time: ${labelOf(meta.get(timeName), timeName)} (N = ${r.num('n')}, events = ${r.num('nevent')})` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Concordance (C)', f(r.num('concordance'), 3)],
        ['Likelihood-ratio test χ² (df)', `${f(r.num('lrTest'), 2)} (${f(r.num('lrDf'), 0)})`],
        ['p (model)', fmtP(r.num('lrP'))],
      ],
      rowHeaders: true,
    },
    { caption: 'Model Fit' },
  );

  const zt = r.strs('zphTerms'), zc = r.nums('zphChi'), zp = r.nums('zphP');
  if (zt.length) {
    await app.results.appendTable(
      {
        columns: ['', 'Chi-Square', 'Sig.'],
        rows: zt.map((t, i) => [t === 'GLOBAL' ? 'GLOBAL' : prettyTerm(t), f(zc[i], 3), fmtP(zp[i])]),
        rowHeaders: true,
      },
      { caption: 'Proportional-Hazards Assumption (cox.zph)' },
    );
    await app.results.appendText(
      'Hazard ratio > 1 means higher hazard (shorter time to event); HR < 1 is protective. **Concordance** is the share of case pairs whose predicted and actual ordering agree (like AUC; .5 = chance). For the **cox.zph** check, a *small* p (especially GLOBAL) flags a violation of proportional hazards — the effect changes over time — so interpret that term cautiously.',
    );
  }
}

// --- helpers -----------------------------------------------------------------

/** R helper: coerce an event indicator to 0/1 (1 = event). 0/1 kept as-is; two
 * other values map the larger to 1; logical/factor handled by as.numeric path. */
const STATUS01_R = `status01 <- function(v){
  if (is.logical(v)) return(as.integer(v))
  vn <- suppressWarnings(as.numeric(v)); u <- sort(unique(vn[is.finite(vn)]))
  if (all(u %in% c(0,1))) return(as.integer(vn))
  if (length(u) == 2) return(as.integer(vn == u[2]))
  stop("event indicator must be 0/1 (0 = censored, 1 = event)") }`;

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function cleanSvg(svg) {
  return String(svg)
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}

function lvl(meta, code) {
  return meta?.valueLabels?.[code] ?? code;
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
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
    str1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
