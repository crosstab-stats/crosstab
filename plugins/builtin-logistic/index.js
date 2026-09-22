/**
 * @file plugins/builtin-logistic/index.js
 * Built-in plugin: Regression ▸ Binary Logistic.
 *
 * `glm` binomial logistic regression. The outcome is recoded to 0/1 (modelling
 * the higher category, named in the caption); SPSS-style Model Summary (−2LL,
 * Cox & Snell / Nagelkerke R²) + Variables in the Equation (B, S.E., Wald=z², df,
 * Sig., Exp(B)). Factor predictors are dummy-coded; user-missing recoded to NA.
 *
 * Everything SPSS puts behind its **Options** button is here too (#178), because a
 * methods class is assigned that exact click-path: CI for Exp(B), Hosmer–Lemeshow
 * goodness-of-fit (with its contingency table), the classification table, the
 * classification plot, and the casewise listing of residuals. SPSS's **Categorical…**
 * sub-dialog is the `cats` + `ref` pair: which predictors are dummy-coded, and
 * against which reference category.
 *
 * Declarative plugin: the host binds the outcome in R as the vector `dv` and the
 * predictors as the data.frame `ivs`.
 */

/** Confidence level for the Exp(B) interval. SPSS offers a box here; we fix it at
 * the 95% every course assignment uses, rather than spending a whole extra dialog
 * on a number nobody changes. */
const CI_LEVEL = 95;

/** SPSS's casewise list prints cases whose |ZResid| exceeds this many SDs. */
const CASEWISE_SD = 2;

/** Cap on printed casewise rows. A model over a large file can flag thousands of
 * cases, and a table that long is a scroll, not a reading. Truncation is announced
 * under the table rather than silently applied. */
const CASEWISE_CAP = 500;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-logistic',
  name: 'Binary Logistic Regression',
  version: '0.3.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['glm', 'logistic', 'odds', 'binary', 'regression', 'hosmer', 'lemeshow', 'classification', 'casewise', 'residuals'],
  disciplines: ['Political Science', 'Sociology', 'Psychology', 'Public Health', 'Economics', 'Criminology', 'Social Science'],
  howto:
    'GUI: Regression ▸ Binary Logistic…, then pick a binary outcome and one or more predictors. You get a Model Summary (−2LL, Cox & Snell / Nagelkerke R²) and Variables in the Equation (B, Wald, Sig., Exp(B)).\n'
    + 'Syntax: run builtin-logistic.run {"dv": "passed", "ivs": ["studyhrs", "attendance"], "cats": ["attendance"], "ref": "first", "opts": ["class", "ci", "hl"]}\n'
    + '  • dv — binary outcome (exactly two categories).\n'
    + '  • ivs — one or more predictors.\n'
    + '  • cats — predictors to dummy-code (SPSS\'s "Categorical…"). Variables already typed as factor/text are dummy-coded anyway; list a NUMERICALLY CODED one here so it is fitted as categories rather than as a slope.\n'
    + '  • ref — "first" (default) or "last": which category of each dummy-coded predictor is the reference. SPSS defaults to LAST, which is why assignments tell you to change it; CrossTab defaults to first.\n'
    + '  • opts — any of "class" (classification table, on by default, as in SPSS), "ci" (95% CI for Exp(B)), "hl" (Hosmer–Lemeshow + its contingency table), "plot" (classification plot), "casewise" (cases with |ZResid| > 2).\n'
    + 'Entry is the only method, so there are no steps and nothing for SPSS\'s "Display: at last step" to choose between.',
  rPackages: [],
  menu: [
    {
      label: 'Binary Logistic…',
      run: 'run',
      order: 20,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome (binary)', hint: 'The yes/no outcome to model; must have exactly two categories.', multiple: false, unique: true },
        { name: 'modelled', kind: 'level', of: 'dv', preferLast: true, label: 'Which category is being modelled?', hint: 'Exp(B) is the odds of THIS category. SPSS models the higher code; with 1 = Yes / 2 = No that is No, so pick Yes if you want the odds of Yes.' },
        { name: 'ivs', kind: 'variables', label: 'Predictors', hint: 'The variables you think predict the outcome.', multiple: true, unique: true },
        {
          name: 'cats',
          kind: 'variables',
          label: 'Categorical predictors (optional)',
          hint: 'SPSS\'s "Categorical…": predictors to dummy-code. Text and factor predictors are dummy-coded automatically — list one here only if it is stored as NUMERIC CODES (1/2/3) and should be fitted as categories, not as a straight-line slope. Skip if none.',
          multiple: true,
          optional: true,
        },
        {
          name: 'ref',
          kind: 'choice',
          label: 'Reference category',
          hint: 'Which category each dummy-coded predictor is compared against. SPSS defaults to Last; CrossTab defaults to First, so an assignment that says "select First, click Change" already matches.',
          options: [{ value: 'first', label: 'First' }, { value: 'last', label: 'Last' }],
          default: 'first',
          optional: true,
        },
        {
          name: 'opts',
          kind: 'choice',
          label: 'Statistics and plots',
          hint: 'Tick the extra output you want, as in SPSS\'s Options dialog.',
          multiple: true,
          options: [
            { value: 'class', label: 'Classification table' },
            { value: 'ci', label: `CI for Exp(B) (${CI_LEVEL}%)` },
            { value: 'hl', label: 'Hosmer–Lemeshow goodness-of-fit' },
            { value: 'plot', label: 'Classification plot' },
            { value: 'casewise', label: `Casewise listing of residuals (|ZResid| > ${CASEWISE_SD})` },
          ],
          default: ['class'],
          optional: true,
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[], cats?: string[], ref?: string, opts?: string[]}} inputs
 */
export async function run(app, { dv: dvName, ivs: ivNames, modelled, cats, ref, opts }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Binary Logistic: choose an outcome and at least one predictor.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const want = new Set([].concat(opts ?? []).map(String));
  const refLast = String(ref ?? 'first').toLowerCase() === 'last';

  // Which predictors are dummy-coded: anything CrossTab already calls categorical,
  // plus anything the user named in "Categorical…". A name ticked there that isn't
  // actually a predictor is ignored — the picker lists every variable, so a stray
  // pick is a slip, not an instruction to add a term to the model.
  const asked = new Set([].concat(cats ?? []).filter(Boolean).map(String));
  const catNames = ivNames.filter(
    (n) => asked.has(n) || ['factor', 'string'].includes(meta.get(n)?.type),
  );
  const strays = [...asked].filter((n) => !ivNames.includes(n));

  const formula = `.y ~ ${ivNames.map((n) => `\`${n}\``).join(' + ')}`;
  // Which outcome category is the "1". NULL keeps the old rule — the higher of the two
  // codes, which is also SPSS's — so a recorded script replays to the same model (#187).
  const modelWant = modelled != null && modelled !== '' ? rStr(String(modelled)) : 'NULL';
  const needPred = want.has('class') || want.has('plot') || want.has('casewise');

  const rCode = `
    u <- sort(unique(as.character(dv[!is.na(dv)])))
    if (length(u) != 2) stop("dependent must have exactly 2 categories (found ", length(u), ")")
    # The modelled category, named rather than assumed. Ordering u so the modelled one
    # is SECOND keeps the rest of the block (and positive/negative below) unchanged.
    .want <- ${modelWant}
    if (!is.null(.want) && .want %in% u) u <- c(u[u != .want][1], .want)
    d <- cbind(.y = as.integer(factor(as.character(dv), levels = u)) - 1L, ivs)
    # Row names carry the DATASET row number through glm's NA drop, so the casewise
    # listing can name a case the user can go and look at. Injection hands R every
    # row in dataset order, so seq_len() IS that number.
    rownames(d) <- seq_len(nrow(d))
    catv <- ${rChr(catNames)}
    for (nm in catv) {
      f <- factor(d[[nm]])
      if (${refLast ? 'TRUE' : 'FALSE'} && nlevels(f) > 1) f <- relevel(f, ref = levels(f)[nlevels(f)])
      d[[nm]] <- f
    }
    fit <- glm(as.formula(${rStr(formula)}), data = d, family = binomial())
    s <- summary(fit); co <- s$coefficients
    p <- fitted(fit); yv <- fit$model$.y

    # Split each coefficient name into (variable, level) using the model's own level
    # table, so "LANGUAGE2" can be printed with its value label instead of guessing
    # where the variable name ends and the level begins.
    xl <- fit$xlevels
    tvar <- character(nrow(co)); tlev <- character(nrow(co))
    for (i in seq_len(nrow(co))) {
      nm <- rownames(co)[i]; tvar[i] <- nm; tlev[i] <- ""
      for (v in names(xl)) {
        if (startsWith(nm, v)) {
          lv <- substring(nm, nchar(v) + 1L)
          if (lv %in% xl[[v]]) { tvar[i] <- v; tlev[i] <- lv; break }
        }
      }
    }

    zc <- qnorm(1 - (1 - ${CI_LEVEL / 100}) / 2)
    res <- list(
      terms = rownames(co), termVar = tvar, termLevel = tlev,
      estimate = co[, 1], se = co[, 2], z = co[, 3], p = co[, 4],
      expb = exp(co[, 1]), n = nobs(fit),
      nulldev = fit$null.deviance, resdev = fit$deviance,
      positive = as.character(u[2]), negative = as.character(u[1]),
      catVar = names(xl),
      catRef = if (length(xl)) vapply(xl, function(l) l[1], character(1), USE.NAMES = FALSE) else character(0),
      expbLo = exp(co[, 1] - zc * co[, 2]), expbHi = exp(co[, 1] + zc * co[, 2])
    )
${needPred ? '    pred <- as.integer(p >= 0.5)\n' : ''}${want.has('class') ? `
    res <- c(res, list(
      ct00 = sum(yv == 0 & pred == 0), ct01 = sum(yv == 0 & pred == 1),
      ct10 = sum(yv == 1 & pred == 0), ct11 = sum(yv == 1 & pred == 1)
    ))
` : ''}${want.has('hl') ? `
    # Hosmer–Lemeshow, deciles of risk. This is ResourceSelection::hoslem.test's
    # algorithm written out in base R (validated against it to machine epsilon):
    # cut on the UNIQUE quantiles of the fitted probabilities, sum observed and
    # expected in each bin for BOTH outcomes, chi-square on (bins - 2) df. The
    # unique() matters — tied quantiles collapse bins, and the df has to follow the
    # bins that actually exist, not the ten that were asked for.
    g <- 10
    qq <- unique(quantile(p, probs = seq(0, 1, 1 / g)))
    bin <- cut(p, breaks = qq, include.lowest = TRUE)
    z0 <- function(x) { x[is.na(x)] <- 0; x }
    o1 <- z0(tapply(yv, bin, sum)); o0 <- z0(tapply(1 - yv, bin, sum))
    e1 <- z0(tapply(p, bin, sum));  e0 <- z0(tapply(1 - p, bin, sum))
    keep <- (o1 + o0) > 0
    o1 <- o1[keep]; o0 <- o0[keep]; e1 <- e1[keep]; e0 <- e0[keep]
    hlchi <- sum((o0 - e0)^2 / e0) + sum((o1 - e1)^2 / e1)
    hldf <- sum(keep) - 2
    res <- c(res, list(
      hlChisq = hlchi, hlDf = hldf, hlP = 1 - pchisq(hlchi, hldf),
      hlBin = levels(bin)[keep],
      hlO0 = as.numeric(o0), hlE0 = as.numeric(e0),
      hlO1 = as.numeric(o1), hlE1 = as.numeric(e1)
    ))
` : ''}${want.has('casewise') ? `
    # ZResid is SPSS's name for the Pearson residual (verified identical to
    # residuals(fit, type = "pearson")).
    zres <- (yv - p) / sqrt(p * (1 - p))
    sel <- which(abs(zres) > ${CASEWISE_SD})
    sel <- sel[order(-abs(zres[sel]))]
    total <- length(sel)
    sel <- head(sel, ${CASEWISE_CAP})
    res <- c(res, list(
      cwTotal = total,
      cwRow = as.integer(rownames(fit$model))[sel],
      cwObs = yv[sel], cwPred = p[sel], cwGroup = pred[sel],
      cwResid = (yv - p)[sel], cwZ = zres[sel]
    ))
` : ''}${want.has('plot') ? `
    br <- seq(0, 1, by = 0.05)
    pb <- cut(p, breaks = br, include.lowest = TRUE)
    zz <- function(x) { x[is.na(x)] <- 0; as.numeric(x) }
    res <- c(res, list(
      plBin = levels(pb),
      plC0 = zz(tapply(1 - yv, pb, sum)), plC1 = zz(tapply(yv, pb, sum))
    ))
` : ''}
    res`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const m = normalizeResult(result);
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const dvLabel = labelOf(meta.get(dvName), dvName);
  /** A category shown through its value label, as everywhere else in the app. */
  const textOf = (varName, code) => {
    const vl = meta.get(varName)?.valueLabels || {};
    const lab = vl[code] ?? vl[Number(code)];
    return lab != null && lab !== '' ? String(lab) : String(code);
  };
  const outcomeText = (code) => textOf(dvName, code);

  if (strays.length) {
    await app.results.appendText(
      `_Ignored in “Categorical…”: ${strays.join(', ')} — not among this model's predictors._`,
    );
  }

  const coxSnell =
    Number.isFinite(m.nulldev) && m.n ? 1 - Math.exp((m.resdev - m.nulldev) / m.n) : NaN;
  const nagelkerke = Number.isFinite(coxSnell)
    ? coxSnell / (1 - Math.exp(-m.nulldev / m.n))
    : NaN;

  await app.results.appendTable(
    {
      columns: ['−2 Log likelihood', 'Cox & Snell R Square', 'Nagelkerke R Square', 'N'],
      rows: [[f(m.resdev, 3), f(coxSnell, 3), f(nagelkerke, 3), f(m.n, 0)]],
    },
    { caption: `Model Summary — dependent: ${dvLabel} (modelling ${outcomeText(m.positive)})` },
  );

  // --- Hosmer–Lemeshow ----------------------------------------------------------
  if (want.has('hl') && Number.isFinite(m.hlChisq)) {
    await app.results.appendTable(
      {
        columns: ['Chi-square', 'df', 'Sig.'],
        rows: [[f(m.hlChisq, 3), String(m.hlDf), fmtP(m.hlP)]],
      },
      {
        caption:
          'Hosmer and Lemeshow Test — a LARGE Sig. is the good result here: it means '
          + 'the observed counts do not differ from what the model predicts.',
      },
    );
    await app.results.appendTable(
      {
        columns: [
          'Predicted probability',
          `${outcomeText(m.negative)} — Observed`, `${outcomeText(m.negative)} — Expected`,
          `${outcomeText(m.positive)} — Observed`, `${outcomeText(m.positive)} — Expected`,
          'Total',
        ],
        rows: m.hlBin.map((b, i) => [
          b,
          f(m.hlO0[i], 0), f(m.hlE0[i], 3),
          f(m.hlO1[i], 0), f(m.hlE1[i], 3),
          f(m.hlO0[i] + m.hlO1[i], 0),
        ]),
        rowHeaders: true,
      },
      {
        caption:
          'Contingency Table for Hosmer and Lemeshow Test — cases split into groups of '
          + 'roughly equal size by predicted probability (deciles of risk)',
      },
    );
  }

  // --- Classification table -----------------------------------------------------
  if (want.has('class') && Number.isFinite(m.ct00)) {
    const row0 = m.ct00 + m.ct01;
    const row1 = m.ct10 + m.ct11;
    const tot = row0 + row1;
    const pct = (num, den) => (den ? f((100 * num) / den, 1) : '—');
    await app.results.appendTable(
      {
        columns: [
          '', `Predicted: ${outcomeText(m.negative)}`, `Predicted: ${outcomeText(m.positive)}`,
          'Percentage Correct',
        ],
        rows: [
          [`Observed: ${outcomeText(m.negative)}`, f(m.ct00, 0), f(m.ct01, 0), pct(m.ct00, row0)],
          [`Observed: ${outcomeText(m.positive)}`, f(m.ct10, 0), f(m.ct11, 0), pct(m.ct11, row1)],
          ['Overall Percentage', '', '', pct(m.ct00 + m.ct11, tot)],
        ],
        rowHeaders: true,
      },
      { caption: 'Classification Table — the cut value is .500' },
    );
  }

  // --- Variables in the Equation ------------------------------------------------
  const ci = want.has('ci');
  await app.results.appendTable(
    {
      columns: [
        '', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)',
        ...(ci ? [`${CI_LEVEL}% C.I. for Exp(B) — Lower`, `${CI_LEVEL}% C.I. for Exp(B) — Upper`] : []),
      ],
      rows: m.terms.map((t, i) => {
        const wald = Number.isFinite(m.z[i]) ? m.z[i] * m.z[i] : NaN;
        const v = m.termVar[i] || t;
        const lv = m.termLevel[i] || '';
        const name = t === '(Intercept)'
          ? 'Constant'
          : lv
            ? `${labelOf(meta.get(v), v)} = ${textOf(v, lv)}`
            : labelOf(meta.get(v), v);
        return [
          name,
          f(m.estimate[i], 3), f(m.se[i], 3), f(wald, 3), '1', fmtP(m.p[i]), f(m.expb[i], 3),
          ...(ci ? [f(m.expbLo[i], 3), f(m.expbHi[i], 3)] : []),
        ];
      }),
      rowHeaders: true,
    },
    {
      caption: 'Variables in the Equation'
        + (m.catVar.length
          ? ` — reference category: ${m.catVar
            .map((v, i) => `${labelOf(meta.get(v), v)} = ${textOf(v, m.catRef[i])}`)
            .join('; ')}`
          : ''),
    },
  );

  // --- Casewise listing of residuals ---------------------------------------------
  if (want.has('casewise')) {
    if (!m.cwRow.length) {
      await app.results.appendText(
        `_Casewise listing: no case has a standardised residual beyond ${CASEWISE_SD} SD._`,
      );
    } else {
      await app.results.appendTable(
        {
          columns: ['Case', `Observed: ${dvLabel}`, 'Predicted', 'Predicted Group', 'Resid', 'ZResid'],
          rows: m.cwRow.map((r, i) => [
            String(r),
            outcomeText(m.cwObs[i] === 1 ? m.positive : m.negative),
            f(m.cwPred[i], 3),
            outcomeText(m.cwGroup[i] === 1 ? m.positive : m.negative),
            f(m.cwResid[i], 3),
            f(m.cwZ[i], 3),
          ]),
          rowHeaders: true,
        },
        {
          caption:
            `Casewise List — cases with a standardised residual beyond ${CASEWISE_SD} SD, `
            + 'largest first. “Case” is the dataset row number.',
        },
      );
      if (m.cwTotal > m.cwRow.length) {
        await app.results.appendText(
          `_Showing the ${m.cwRow.length.toLocaleString()} largest of ${m.cwTotal.toLocaleString()} `
            + `cases beyond ${CASEWISE_SD} SD._`,
        );
      }
    }
  }

  // --- Classification plot --------------------------------------------------------
  if (want.has('plot') && m.plBin.length) {
    await app.results.appendChart({
      kind: 'categorical',
      title: `Predicted probability of ${dvLabel} = ${outcomeText(m.positive)}, by observed group`,
      categories: m.plBin.map((b) => ({ key: b, label: b })),
      series: [
        { key: 'obs0', label: `Observed: ${outcomeText(m.negative)}`, values: m.plC0 },
        { key: 'obs1', label: `Observed: ${outcomeText(m.positive)}`, values: m.plC1 },
      ],
      counts: true,
      axes: { x: { title: 'Predicted probability' } }, // the y axis is named by the measure
      view: { mark: 'bar', stack: 'stacked', legend: 'right' },
    });
  }
}

// --- helpers -----------------------------------------------------------------

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
}

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const num = (v) => arr(v).map((x) => (x == null ? NaN : Number(x)));
  const str = (v) => arr(v).map((x) => (x == null ? '' : String(x)));
  const scalar = (v) => {
    const a = arr(v);
    return a.length ? a[0] : v;
  };
  const one = (v) => (v == null ? NaN : Number(scalar(v)));
  return {
    terms: str(byName.terms),
    termVar: str(byName.termVar),
    termLevel: str(byName.termLevel),
    estimate: num(byName.estimate),
    se: num(byName.se),
    z: num(byName.z),
    p: num(byName.p),
    expb: num(byName.expb),
    expbLo: num(byName.expbLo),
    expbHi: num(byName.expbHi),
    n: one(byName.n),
    nulldev: one(byName.nulldev),
    resdev: one(byName.resdev),
    positive: String(scalar(byName.positive) ?? ''),
    negative: String(scalar(byName.negative) ?? ''),
    catVar: str(byName.catVar),
    catRef: str(byName.catRef),
    hlChisq: one(byName.hlChisq),
    hlDf: one(byName.hlDf),
    hlP: one(byName.hlP),
    hlBin: str(byName.hlBin),
    hlO0: num(byName.hlO0),
    hlE0: num(byName.hlE0),
    hlO1: num(byName.hlO1),
    hlE1: num(byName.hlE1),
    ct00: one(byName.ct00),
    ct01: one(byName.ct01),
    ct10: one(byName.ct10),
    ct11: one(byName.ct11),
    cwTotal: one(byName.cwTotal),
    cwRow: num(byName.cwRow),
    cwObs: num(byName.cwObs),
    cwPred: num(byName.cwPred),
    cwGroup: num(byName.cwGroup),
    cwResid: num(byName.cwResid),
    cwZ: num(byName.cwZ),
    plBin: str(byName.plBin),
    plC0: num(byName.plC0),
    plC1: num(byName.plC1),
  };
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** An R character vector literal, e.g. c("a","b") — or character(0) when empty. */
function rChr(list) {
  const items = [].concat(list ?? []).filter(Boolean);
  return items.length ? `c(${items.map(rStr).join(', ')})` : 'character(0)';
}
