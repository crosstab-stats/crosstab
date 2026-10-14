/**
 * @file plugins/builtin-anova/index.js
 * Built-in plugin: Comparison ▸ ANOVA beyond one-way —
 *  - **Factorial ANOVA**: an outcome by two or more factors, with all
 *    interactions (Type I / sequential sums of squares; for balanced data this
 *    matches Type II/III). Reports SS/df/MS/F/Sig. and partial η² per term.
 *  - **Repeated-measures ANOVA**: a within-subjects factor given as several
 *    numeric columns measured on the same rows (e.g. time1, time2, time3). Uses
 *    an `Error(subject/condition)` model. (Sphericity is not corrected — basic
 *    within-subjects F.)
 *
 * Lives under the existing Comparison menu alongside the t-tests and one-way
 * ANOVA. User-missing codes are recoded to NA; analysis is listwise.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fmtP, fixed: f, rounded: int, metaMap, rStr, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-anova',
  name: 'ANOVA (factorial & repeated measures)',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Comparison',
  keywords: ['anova', 'factorial', 'two-way', 'interaction', 'repeated measures', 'within-subjects', 'eta squared'],
  disciplines: ['Psychology', 'Nutrition, Food & Dietetics', 'Education', 'Family & Consumer Sciences', 'Gerontology', 'Public Health'],
  howto:
    "GUI: Comparison ▸ Factorial ANOVA, pick an outcome and 2+ factors; you get SPSS's three blocks — Descriptive Statistics, Levene's Test of Equality of Error Variances, and Tests of Between-Subjects Effects with Type III sums of squares and partial η². Or Comparison ▸ Repeated-measures ANOVA for a within-subjects factor given as several numeric columns.\n" +
    'Syntax: run builtin-anova.factorial {"dv": "score", "facs": ["group", "time"]}\n' +
    'Syntax: run builtin-anova.repeated {"vars": ["time1", "time2", "time3"]}\n' +
    "  • Repeated-measures output follows SPSS: Descriptive Statistics, Mauchly's Test of\n" +
    '    Sphericity (W, approx. chi-square, df, Sig. and the three epsilons), then Tests of\n' +
    '    Within-Subjects Effects with the Sphericity Assumed / Greenhouse-Geisser / Huynh-Feldt\n' +
    '    / Lower-bound rows. With only two conditions sphericity cannot be violated, so no test\n' +
    '    is run and the single row stands.\n' +
    '  • dv — the numeric outcome to compare; facs — two or more grouping factors.\n' +
    '  • vars — the repeated-measure columns (same people at each time/condition).',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'anova-factorial',
      title: 'Factorial ANOVA',
      category: 'Comparison',
      keywords: ['factorial', 'anova', 'two way', 'interaction', 'main effect', 'factors', 'between subjects', 'design'],
      needs: ['builtin-anova'],
      seeAlso: ['compare-oneway', 'anova-repeated', 'ancova-adjusted'],
    },
    {
      id: 'anova-repeated',
      title: 'Repeated-measures ANOVA',
      category: 'Comparison',
      keywords: ['repeated measures', 'within subjects', 'anova', 'sphericity', 'time points', 'wide format', 'same subjects'],
      needs: ['builtin-anova'],
      seeAlso: ['anova-factorial', 'ancova-mixed', 'compare-paired'],
    },
  ],
  rPackages: [],
  menu: [
    {
      howto: 'anova-factorial',
      label: 'Factorial ANOVA…',
      run: 'factorial',
      order: 50,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose averages you want to compare.', types: ['numeric'], unique: true },
        { name: 'facs', kind: 'variables', label: 'Factors (2+)', hint: 'Two or more grouping variables whose effects you want to test.', multiple: true, unique: true },
      ],
    },
    {
      howto: 'anova-repeated',
      label: 'Repeated-measures ANOVA…',
      run: 'repeated',
      order: 60,
      inputs: [{ name: 'vars', kind: 'variables', label: 'Repeated measures (2+ columns)', hint: 'The columns measuring the same people at each time or condition.', multiple: true, types: ['numeric'] }],
    },
  ],
};

export async function factorial(app, { dv, facs }) {
  const facNames = Array.isArray(facs) ? facs : facs ? [facs] : [];
  if (!dv || facNames.length < 2) {
    await app.results.appendError('Factorial ANOVA needs an outcome and at least 2 factors.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  // Factors are renamed F1..Fk inside R. The names a user picks can contain anything,
  // and they end up inside formula terms and row labels; tokens keep the formula sane
  // and the display names are put back on this side, where the value labels live.
  const tok = facNames.map((_, i) => `F${i + 1}`);
  const rhs = tok.join(' * ');

  const rCode = `
    d <- data.frame(.y = as.numeric(dv))
    ${facNames.map((n, i) => `d$${tok[i]} <- factor(facs[[${rStr(n)}]])`).join('\n    ')}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    if (nrow(d) < 3) stop("not enough complete cases")

    # SPSS's UNIANOVA reports **Type III** sums of squares, and this reported Type I.
    # On a balanced design they are the same number; on anything unbalanced — which is
    # every real survey — they are not, and not by a little (a 2x2 on GSS-shaped data
    # moved a main effect from 641 to 419). Type III is each term's contribution given
    # every other term, which is what drop1 computes, and it is only correct under
    # sum-to-zero contrasts, hence the options() dance.
    op <- options(contrasts = c("contr.sum", "contr.poly"))
    fit <- stats::lm(stats::as.formula(${rStr(`.y ~ ${rhs}`)}), data = d)
    a3 <- stats::drop1(fit, ~ ., test = "F")
    options(op)
    keep <- rownames(a3) != "<none>"

    rssF <- sum(stats::resid(fit)^2)
    dfRes <- stats::df.residual(fit)
    ssTot <- sum((d$.y - mean(d$.y))^2)

    # Levene across the CELLS: a one-way ANOVA on each case's absolute deviation from
    # its own cell mean, which is the same mean-centred variant the t-test and the
    # one-way ANOVA report, applied to the design's cells rather than to one factor.
    cell <- interaction(d[, c(${tok.map(rStr).join(', ')}), drop = FALSE], drop = TRUE)
    z <- abs(d$.y - ave(d$.y, cell, FUN = mean))
    lv <- stats::anova(stats::lm(z ~ cell))
    levF <- lv[1, "F value"]; levP <- lv[1, "Pr(>F)"]
    levDf1 <- lv[1, "Df"]; levDf2 <- lv[2, "Df"]

    # Cell descriptives, in the order the cells appear as a crossing.
    cm <- tapply(d$.y, cell, mean); cs <- tapply(d$.y, cell, stats::sd)
    cn <- tapply(d$.y, cell, length)
    # The Corrected Model row: every term together against the error. R does not hand
    # this back from drop1, but it is the same F any model summary reports.
    ssModel <- ssTot - rssF
    dfModel <- dfRes0 <- NULL
    dfModel <- sum(a3[keep, "Df"])
    fModel <- (ssModel / dfModel) / (rssF / dfRes)
    pModel <- stats::pf(fModel, dfModel, dfRes, lower.tail = FALSE)

    list(terms = rownames(a3)[keep],
         fModel = fModel, pModel = pModel,
         ss = a3[keep, "Sum of Sq"], df = a3[keep, "Df"],
         F = a3[keep, "F value"], p = a3[keep, "Pr(>F)"],
         ssRes = rssF, dfRes = dfRes, ssTot = ssTot, n = nrow(d),
         levF = levF, levP = levP, levDf1 = levDf1, levDf2 = levDf2,
         cellName = levels(cell), cellMean = as.numeric(cm),
         cellSD = as.numeric(cs), cellN = as.numeric(cn),
         grandMean = mean(d$.y), grandSD = stats::sd(d$.y))`;

  const r = flat((await app.webr.run(rCode)).result);
  const terms = r.strs('terms');
  const ss = r.nums('ss');
  const df = r.nums('df');
  const F = r.nums('F');
  const p = r.nums('p');
  const ssRes = r.num1('ssRes');
  const dfRes = r.num1('dfRes');
  const ssTot = r.num1('ssTot');
  const msRes = ssRes / dfRes;
  const dispName = (t) => t.split(':').map((part) => {
    const i = tok.indexOf(part.trim());
    return i >= 0 ? label(meta, facNames[i]) : part.trim();
  }).join(' × ');

  // SPSS's order: the cell means first, because on a 2x2 they are what gets
  // interpreted and the F table only says whether the pattern is real.
  const cells = r.strs('cellName');
  await app.results.appendTable(
    {
      columns: [facNames.map((n) => label(meta, n)).join(' × '), 'Mean', 'Std. Deviation', 'N'],
      rows: [
        ...cells.map((c, i) => [
          c.split('.').map((lvl, j) => valueLabel(meta, facNames[j], lvl)).join(' × '),
          f(r.nums('cellMean')[i], 3), f(r.nums('cellSD')[i], 3), int(r.nums('cellN')[i]),
        ]),
        ['Total', f(r.num1('grandMean'), 3), f(r.num1('grandSD'), 3), int(r.num1('n'))],
      ],
      rowHeaders: true,
    },
    { caption: `Descriptive Statistics — dependent: ${label(meta, dv)}` },
  );

  if (Number.isFinite(r.num1('levF'))) {
    await app.results.appendTable(
      {
        columns: ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
        rows: [['Based on Mean', f(r.num1('levF'), 3), int(r.num1('levDf1')), int(r.num1('levDf2')), fmtP(r.num1('levP'))]],
        rowHeaders: true,
      },
      { caption: `Levene's Test of Equality of Error Variances — dependent: ${label(meta, dv)}` },
    );
  }

  // Corrected Model and Corrected Total bracket the terms, as SPSS prints them: the
  // model row is every term together, which is the test a reader checks before asking
  // which term did the work.
  const ssModel = ssTot - ssRes;
  const dfModel = df.reduce((a, b) => a + b, 0);
  const effect = (name, SS, DF, Fv, P, eta) => [
    name, f(SS, 3), int(DF), DF > 0 ? f(SS / DF, 3) : '',
    Number.isFinite(Fv) ? f(Fv, 3) : '', Number.isFinite(P) ? fmtP(P) : '',
    eta == null ? '' : f(eta, 3),
  ];
  await app.results.appendTable(
    {
      columns: ['Source', 'Type III Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.', 'Partial η²'],
      rows: [
        effect('Corrected Model', ssModel, dfModel, r.num1('fModel'), r.num1('pModel'),
          ssModel / (ssModel + ssRes)),
        ...terms.map((t, i) => effect(dispName(t), ss[i], df[i], F[i], p[i], ss[i] / (ss[i] + ssRes))),
        effect('Error', ssRes, dfRes, NaN, NaN, null),
        effect('Corrected Total', ssTot, r.num1('n') - 1, NaN, NaN, null),
      ],
      rowHeaders: true,
    },
    { caption: `Tests of Between-Subjects Effects — dependent: ${label(meta, dv)} (N = ${int(r.num1('n'))})` },
  );

  await app.results.appendText(
    '**Type III** sums of squares: the contribution each term makes given every other '
    + 'term, '
    + "which is what SPSS's UNIANOVA reports. On a balanced design Type I, II and III "
    + 'agree; on an unbalanced one they do not, so the type has to be stated rather than '
    + 'left to be inferred. Partial η² = SS / (SS + SS_error).' + '\n\n'
    + "**Levene's test** asks whether the cells have equal spread. Above .05, the F table "
    + 'stands as printed; below it, treat the result with care — a factorial ANOVA has no '
    + 'Welch equivalent to fall back on. SPSS also prints an Intercept row and three more '
    + 'Levene rows (median, median with adjusted df, trimmed mean); these are the ones a '
    + 'reader interprets.',
  );
}

export async function repeated(app, { vars }) {
  const names = Array.isArray(vars) ? vars : vars ? [vars] : [];
  if (names.length < 2) {
    await app.results.appendError('Repeated-measures ANOVA needs at least 2 measurement columns.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());

  const rCode = `
    d <- as.data.frame(vars, check.names = FALSE)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    n <- nrow(d); k <- ncol(d)
    if (n < 2 || k < 2) stop("need at least 2 complete rows and 2 columns")
    val <- as.numeric(unlist(d, use.names = FALSE))
    subj <- factor(rep(seq_len(n), times = k))
    cond <- factor(rep(seq_len(k), each = n))
    fit <- aov(val ~ cond + Error(subj / cond))
    ss <- summary(fit); ws <- ss[[length(ss)]][[1]]

    # --- Sphericity -----------------------------------------------------------
    # The assumption this design stands on, and the one a methods course spends the
    # lesson on: with three or more conditions the F above is only valid if the
    # variances of all the pairwise DIFFERENCES are equal. Printing the F without
    # saying whether that holds is the part that was missing.
    #
    # mauchly.test and anova.mlm are both base stats, so nothing here is hand-rolled
    # except the two epsilons — which anova.mlm computes but exposes only inside its
    # printed heading, never as data. Those are checked against that heading in
    # scripts/validation/sphericity-reference.R.
    mauW <- NA_real_; mauChi <- NA_real_; mauDf <- NA_real_; mauP <- NA_real_
    ggE <- NA_real_; hfE <- NA_real_; lbE <- NA_real_
    ggP <- NA_real_; hfP <- NA_real_; lbP <- NA_real_
    if (k > 2 && n > k) {
      m <- as.matrix(d)
      mlm <- stats::lm(m ~ 1)
      idata <- data.frame(cond = factor(seq_len(k)))
      dcon <- k - 1
      # An orthonormal basis for the contrasts orthogonal to the unit vector — the
      # space sphericity is a claim about.
      C  <- qr.Q(qr(cbind(1, stats::contr.poly(k))))[, -1, drop = FALSE]
      Sc <- t(C) %*% stats::cov(m) %*% C
      lam <- eigen(Sc, symmetric = TRUE, only.values = TRUE)$values
      ggE <- sum(lam)^2 / (dcon * sum(lam^2))
      hfE <- min(1, (n * dcon * ggE - 2) / (dcon * (n - 1 - dcon * ggE)))
      lbE <- 1 / dcon
      mau <- try(stats::mauchly.test(mlm, X = ~1, idata = idata), silent = TRUE)
      if (!inherits(mau, "try-error")) {
        mauW <- unname(mau$statistic)
        # SPSS reports the chi-square approximation; mauchly.test's own p uses a finer
        # expansion and differs in the far tail. The approximation is the one with a
        # df column next to it, which is what a student is reading.
        mauChi <- -(n - 1 - (2 * dcon^2 + dcon + 2) / (6 * dcon)) * log(mauW)
        mauDf  <- dcon * (dcon + 1) / 2 - 1
        mauP   <- stats::pchisq(mauChi, mauDf, lower.tail = FALSE)
      }
      sph <- try(stats::anova(mlm, X = ~1, idata = idata, test = "Spherical"), silent = TRUE)
      if (!inherits(sph, "try-error")) {
        ggP <- sph[1, "G-G Pr"]; hfP <- sph[1, "H-F Pr"]
      }
      lbP <- stats::pf(ws["cond", "F value"], ws["cond", "Df"] * lbE, ws["Residuals", "Df"] * lbE,
                       lower.tail = FALSE)
    }

    list(
      means = colMeans(d), sds = apply(d, 2, sd), n = n, k = k,
      ssCond = ws["cond", "Sum Sq"], dfCond = ws["cond", "Df"], msCond = ws["cond", "Mean Sq"],
      F = ws["cond", "F value"], p = ws["cond", "Pr(>F)"],
      ssRes = ws["Residuals", "Sum Sq"], dfRes = ws["Residuals", "Df"], msRes = ws["Residuals", "Mean Sq"],
      mauW = mauW, mauChi = mauChi, mauDf = mauDf, mauP = mauP,
      ggE = ggE, hfE = hfE, lbE = lbE, ggP = ggP, hfP = hfP, lbP = lbP
    )`;

  const r = flat((await app.webr.run(rCode)).result);
  const means = r.nums('means');
  const sds = r.nums('sds');
  await app.results.appendTable(
    {
      columns: ['Measure', 'Mean', 'SD', 'N'],
      rows: names.map((nm, i) => [label(meta, nm), f(means[i], 3), f(sds[i], 3), int(r.num1('n'))]),
      rowHeaders: true,
    },
    { caption: 'Descriptive Statistics' },
  );

  const ssCond = r.num1('ssCond');
  const ssRes = r.num1('ssRes');
  const dfCond = r.num1('dfCond');
  const dfRes = r.num1('dfRes');
  const Fv = r.num1('F');
  const ggE = r.num1('ggE');
  const hfE = r.num1('hfE');
  const lbE = r.num1('lbE');
  const tested = Number.isFinite(r.num1('mauW'));

  if (tested) {
    await app.results.appendTable(
      {
        columns: ["Mauchly's W", 'Approx. Chi-Square', 'df', 'Sig.',
          'ε Greenhouse-Geisser', 'ε Huynh-Feldt', 'ε Lower-bound'],
        rows: [[
          f(r.num1('mauW'), 3), f(r.num1('mauChi'), 3), int(r.num1('mauDf')), fmtP(r.num1('mauP')),
          f(ggE, 3), f(hfE, 3), f(lbE, 3),
        ]],
        rowHeaders: false,
      },
      { caption: "Mauchly's Test of Sphericity" },
    );
  }

  // SPSS's four rows per effect: the uncorrected test, then the same F read against
  // degrees of freedom multiplied by each epsilon. The sums of squares and F do not
  // change — only what they are judged against, which is the whole idea of the
  // correction and the thing a four-row table makes visible that a footnote does not.
  const row = (name, eps, p) => [
    name,
    f(ssCond, 3), f(dfCond * eps, 3), f(ssCond / (dfCond * eps), 3), f(Fv, 3), fmtP(p),
    f(ssCond / (ssCond + ssRes), 3),
  ];
  const resRow = (name, eps) => [name, f(ssRes, 3), f(dfRes * eps, 3), f(ssRes / (dfRes * eps), 3), '', '', ''];
  const effect = [row('Sphericity Assumed', 1, r.num1('p'))];
  const resid = [resRow('Sphericity Assumed', 1)];
  if (tested) {
    effect.push(row('Greenhouse-Geisser', ggE, r.num1('ggP')));
    effect.push(row('Huynh-Feldt', hfE, r.num1('hfP')));
    effect.push(row('Lower-bound', lbE, r.num1('lbP')));
    resid.push(resRow('Greenhouse-Geisser', ggE), resRow('Huynh-Feldt', hfE), resRow('Lower-bound', lbE));
  }
  await app.results.appendTable(
    {
      columns: ['Source', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.', 'Partial η²'],
      rows: [
        ...effect.map((e, i) => [`Condition (within) — ${e[0]}`, ...e.slice(1)]),
        ...resid.map((e) => [`Residual — ${e[0]}`, ...e.slice(1)]),
      ],
      rowHeaders: true,
    },
    { caption: 'Tests of Within-Subjects Effects' },
  );

  if (tested) {
    await app.results.appendText(
      "**Mauchly's test** asks whether the variances of all the pairwise differences "
      + 'between conditions are equal — the assumption this design rests on. If its Sig. '
      + 'is above .05, read the **Sphericity Assumed** row; if it is below, read '
      + '**Greenhouse-Geisser** (the conservative choice, and the usual one) or '
      + '**Huynh-Feldt** when ε is above about .75. The correction multiplies the degrees '
      + 'of freedom by ε, leaving F unchanged and making it harder to clear — '
      + 'Lower-bound is the most severe case, ε = 1/(k−1).',
    );
  } else {
    await app.results.appendText(
      'With only two conditions there is a single difference, so sphericity cannot be '
      + 'violated and no correction applies.',
    );
  }
}

// --- helpers -----------------------------------------------------------------

function label(meta, name) {
  return meta.get(name)?.label || name;
}
/** Clean an aov term: factor(`x`) → x; an interaction's ":" → " × ". */
function prettyTerm(t) {
  if (/^Residuals$/i.test(t)) return 'Residual';
  return t
    .split(':')
    .map((part) => {
      const m = /^factor\(`?(.+?)`?\)$/.exec(part.trim());
      return m ? m[1] : part.replace(/`/g, '').trim();
    })
    .join(' × ');
}
