/**
 * @file plugins/builtin-meta/index.js
 * Built-in plugin: **meta-analysis** — pool effect sizes across studies to a
 * single summary estimate, quantify heterogeneity, and (optionally) explain it
 * with study-level moderators. The backbone of systematic reviews and evidence
 * synthesis. Uses `metafor::rma` directly.
 *
 * Input is one row per study: an effect size (yi) and its precision (standard
 * error or sampling variance). Reports the pooled effect (random- or
 * fixed-effects), the Q test / I² / τ² heterogeneity statistics, a forest plot,
 * and — if moderators are supplied — a meta-regression with the omnibus test.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fmtP, fmtPInline, fixed: f, labelOf, metaMap, rStr, ci: ciAt, unpackR: flat } = globalThis.ctStd;

/** This plugin reports four decimals: a marginal effect or a trend slope can be small
 * enough that three prints `[0.000, 0.001]`. The precision is the caller's; the
 * formatting is the stdlib's. */
const ci = (lo, hi) => ciAt(lo, hi, 4);

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-meta',
  name: 'Meta-analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['meta-analysis', 'meta analysis', 'effect size', 'forest plot', 'heterogeneity', 'random effects', 'metafor', 'evidence synthesis', 'systematic review', 'meta-regression'],
  disciplines: ['Public Health', 'Psychology', 'Nutrition, Food & Dietetics', 'Education'],
  howto:
    'GUI: Regression ▸ Meta-analysis…, then pick the effect-size and precision columns (one row per study), the model, and optional moderators. ' +
    'You get the pooled effect, heterogeneity (Q / I² / τ²), and a forest plot.\n' +
    'Syntax: run builtin-meta.metaAnalysis {"yi": "effect", "prec": "se", "precType": "se", "model": "REML"}\n' +
    '  • yi — each study\'s effect size; prec — its standard error or sampling variance.\n' +
    '  • precType — "se" (default) | "var".\n' +
    '  • model — "REML" random effects (default) | "FE" fixed/common effect.\n' +
    '  • mods — optional moderators (meta-regression); label — optional study label for the forest plot.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'meta-analysis',
      title: 'Meta-analysis',
      category: 'Regression',
      keywords: ['meta-analysis', 'meta analysis', 'pooled', 'forest plot', 'heterogeneity', 'i2', 'tau', 'random effects', 'reml', 'effect size', 'studies'],
      needs: ['builtin-meta'],
      seeAlso: ['regression-linear'],
    },
  ],
  rPackages: ['metafor'],
  menu: [
    {
      howto: 'meta-analysis',
      label: 'Meta-analysis…',
      run: 'metaAnalysis',
      order: 140,
      inputs: [
        { name: 'yi', kind: 'variables', label: 'Effect size (one row per study)', hint: 'Each study\'s reported effect size, one row per study.', multiple: false, types: ['numeric'], unique: true },
        { name: 'prec', kind: 'variables', label: 'Precision (SE or variance)', hint: 'Each effect size\'s standard error or sampling variance.', multiple: false, types: ['numeric'], unique: true },
        { name: 'precType', kind: 'choice', label: 'Precision is', hint: 'Whether the precision column holds a standard error or a variance.', default: 'se', options: [
          { value: 'se', label: 'Standard error' },
          { value: 'var', label: 'Sampling variance' },
        ] },
        { name: 'model', kind: 'choice', label: 'Model', hint: 'Random effects allows studies to differ; fixed assumes one true effect.', default: 'REML', options: [
          { value: 'REML', label: 'Random effects (REML)' },
          { value: 'FE', label: 'Fixed / common effect' },
        ] },
        { name: 'mods', kind: 'variables', label: 'Moderators (meta-regression, optional)', hint: 'Study-level variables that may explain differing effects.', multiple: true, optional: true, unique: true },
        { name: 'label', kind: 'variables', label: 'Study label (optional)', hint: 'A name for each study, used to label the forest plot.', multiple: false, types: ['string', 'factor', 'numeric'], optional: true, unique: true },
      ],
    },
  ],
};

export async function metaAnalysis(app, { yi: yiName, prec: precName, precType, model, mods: modNames, label: labelName }) {
  if (!yiName || !precName) {
    await app.results.appendError('Meta-analysis: choose an effect-size column and its precision (SE or variance).');
    return;
  }
  await app.webr.installPackages(['metafor']);
  const meta = metaMap(await app.data.getVariableMeta());
  const mods = modNames || [];
  const modTok = mods.map((_, i) => `M${i + 1}`);
  const hasLabel = !!labelName;
  const modMk = mods.map((n, i) => {
    const fac = meta.get(n)?.categorical;
    return `d$${modTok[i]} <- ${fac ? `factor(mods[[${rStr(n)}]])` : `as.numeric(mods[[${rStr(n)}]])`}`;
  }).join('\n');
  const viExpr = precType === 'var' ? 'as.numeric(prec)' : 'as.numeric(prec)^2';
  const rCode = `
    suppressMessages(library(metafor))
    d <- data.frame(.yi = as.numeric(yi), .vi = ${viExpr})
    ${hasLabel ? 'd$.slab <- as.character(label)' : 'd$.slab <- paste("Study", seq_len(nrow(d)))'}
    ${modMk}
    d <- d[is.finite(d$.yi) & is.finite(d$.vi) & d$.vi > 0, , drop = FALSE]
    m <- rma(.yi, .vi, data = d, method = ${rStr(model)}, slab = d$.slab)
    .crit <- qnorm(0.975)
    .se <- sqrt(d$.vi)
    out <- list(est = as.numeric(m$b)[1], se = m$se[1], z = m$zval[1], p = m$pval[1], lo = m$ci.lb[1], hi = m$ci.ub[1],
                QE = m$QE, QEdf = m$k - m$p, QEp = m$QEp, I2 = m$I2, tau2 = m$tau2, k = m$k,
                fpLab = as.character(d$.slab), fpEst = d$.yi,
                fpLo = d$.yi - .crit * .se, fpHi = d$.yi + .crit * .se,
                fpW = as.numeric(weights(m)),
                hasMods = FALSE)
    ${mods.length ? `
    mr <- rma(.yi, .vi, mods = ~ ${modTok.join(' + ')}, data = d, method = ${rStr(model)})
    out$hasMods <- TRUE
    out$mrTerms <- rownames(mr$b); out$mrEst <- as.numeric(mr$b); out$mrSe <- mr$se
    out$mrZ <- mr$zval; out$mrP <- mr$pval
    out$QM <- mr$QM; out$QMdf <- mr$m; out$QMp <- mr$QMp; out$I2res <- mr$I2` : ''}
    out`;
  const r = flat(await runR(app, rCode));

  await app.results.appendTable(
    {
      columns: ['', 'Estimate', 'Std. Error', 'z', 'Sig.', '95% CI'],
      rows: [['Pooled effect', f(r.num1('est'), 4), f(r.num1('se'), 4), f(r.num1('z'), 2), fmtP(r.num1('p')), ci(r.num1('lo'), r.num1('hi'))]],
      rowHeaders: true,
    },
    { caption: `Meta-Analysis — ${model === 'FE' ? 'fixed/common effect' : 'random effects (REML)'}, k = ${r.num1('k')} studies` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Q (heterogeneity)', `${f(r.num1('QE'), 2)} (df ${f(r.num1('QEdf'), 0)})`],
        ['p (Q)', fmtP(r.num1('QEp'))],
        ['I²', `${f(r.num1('I2'), 1)}%`],
        ['τ² (between-study variance)', f(r.num1('tau2'), 4)],
      ],
      rowHeaders: true,
    },
    { caption: 'Heterogeneity' },
  );
  const fpLab = r.strs('fpLab');
  const fpEst = r.nums('fpEst');
  const fpLo = r.nums('fpLo');
  const fpHi = r.nums('fpHi');
  const fpW = r.nums('fpW');
  if (fpEst.length) {
    await app.results.appendChart({
      kind: 'forest',
      title: 'Forest plot',
      // The user picked an arbitrary effect-size column, so we cannot know whether it
      // holds a difference or a log ratio. Null at 0 is right for the former and the
      // "Log scale" control is there for the latter — guessing would silently mislabel
      // the reference line, which is the one mark a reader trusts without checking.
      refLine: 0,
      valueHeading: 'Effect [95% CI]',
      axes: { x: { title: labelOf(meta.get(yiName), yiName) } },
      studies: fpEst.map((est, i) => ({
        key: `s${i}`,
        label: fpLab[i] || `Study ${i + 1}`,
        est,
        lo: fpLo[i],
        hi: fpHi[i],
        weight: fpW[i],
      })),
      summary: {
        label: model === 'FE' ? 'Pooled (fixed effect)' : 'Pooled (random effects)',
        est: r.num1('est'),
        lo: r.num1('lo'),
        hi: r.num1('hi'),
      },
    });
  }

  if (r.num1('hasMods') === 1 || r.strs('mrTerms').length) {
    const mt = r.strs('mrTerms'), me = r.nums('mrEst'), ms = r.nums('mrSe'), mz = r.nums('mrZ'), mp = r.nums('mrP');
    await app.results.appendTable(
      {
        columns: ['', 'B', 'Std. Error', 'z', 'Sig.'],
        rows: mt.map((t, i) => [metaRegTerm(t, mods, meta), f(me[i], 4), f(ms[i], 4), f(mz[i], 2), fmtP(mp[i])]),
        rowHeaders: true,
      },
      { caption: 'Meta-Regression (moderators)' },
    );
    await app.results.appendText(
      `Omnibus test of moderators: QM(${f(r.num1('QMdf'), 0)}) = ${f(r.num1('QM'), 2)}, ${fmtPInline(r.num1('QMp'))}. Residual I² = ${f(r.num1('I2res'), 1)}% (heterogeneity left unexplained by the moderators).`,
    );
  }

  await app.results.appendText(
    'The **pooled effect** is the precision-weighted average across studies. **I²** is the share of variation due to real between-study differences rather than sampling error (rules of thumb: 25% low, 50% moderate, 75% high). A significant **Q** / large I² means a random-effects model (and possibly moderators) is warranted.',
  );
}

// --- helpers -----------------------------------------------------------------

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function metaRegTerm(term, mods, meta) {
  if (term === 'intrcpt') return '(Intercept)';
  const m = /^M(\d+)/.exec(term);
  if (m && mods[+m[1] - 1] != null) {
    const suffix = term.slice(`M${m[1]}`.length);
    return `${labelOf(meta.get(mods[+m[1] - 1]), mods[+m[1] - 1])}${suffix ? ` = ${suffix}` : ''}`;
  }
  return term;
}
