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

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-meta',
  name: 'Meta-analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['meta-analysis', 'meta analysis', 'effect size', 'forest plot', 'heterogeneity', 'random effects', 'metafor', 'evidence synthesis', 'systematic review', 'meta-regression'],
  disciplines: ['Public Health', 'Psychology', 'Nutrition Food & Dietetics', 'Education'],
  rPackages: ['metafor', 'svglite'],
  menu: [
    {
      label: 'Meta-analysis…',
      run: 'metaAnalysis',
      order: 140,
      inputs: [
        { name: 'yi', kind: 'variables', label: 'Effect size (one row per study)', multiple: false, types: ['numeric'], unique: true },
        { name: 'prec', kind: 'variables', label: 'Precision (SE or variance)', multiple: false, types: ['numeric'], unique: true },
        { name: 'precType', kind: 'choice', label: 'Precision is', default: 'se', options: [
          { value: 'se', label: 'Standard error' },
          { value: 'var', label: 'Sampling variance' },
        ] },
        { name: 'model', kind: 'choice', label: 'Model', default: 'REML', options: [
          { value: 'REML', label: 'Random effects (REML)' },
          { value: 'FE', label: 'Fixed / common effect' },
        ] },
        { name: 'mods', kind: 'variables', label: 'Moderators (meta-regression, optional)', multiple: true, optional: true, unique: true },
        { name: 'label', kind: 'variables', label: 'Study label (optional)', multiple: false, types: ['string', 'factor', 'numeric'], optional: true, unique: true },
      ],
    },
  ],
};

const ACCENT = '#2980b9';

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
  const recodes = [
    recodeLine('yi', meta.get(yiName)), recodeLine('prec', meta.get(precName)),
    ...mods.map((n) => recodeLine(`mods[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const modMk = mods.map((n, i) => {
    const fac = meta.get(n)?.type === 'factor';
    return `d$${modTok[i]} <- ${fac ? `factor(mods[[${rStr(n)}]])` : `as.numeric(mods[[${rStr(n)}]])`}`;
  }).join('\n');
  const viExpr = precType === 'var' ? 'as.numeric(prec)' : 'as.numeric(prec)^2';
  const rCode = `
    suppressMessages({library(metafor); library(svglite)})
    ${recodes}
    d <- data.frame(.yi = as.numeric(yi), .vi = ${viExpr})
    ${hasLabel ? 'd$.slab <- as.character(label)' : 'd$.slab <- paste("Study", seq_len(nrow(d)))'}
    ${modMk}
    d <- d[is.finite(d$.yi) & is.finite(d$.vi) & d$.vi > 0, , drop = FALSE]
    m <- rma(.yi, .vi, data = d, method = ${rStr(model)}, slab = d$.slab)
    h <- max(3, 0.35 * nrow(d) + 1.5)
    .ct_dev <- svgstring(width = 7, height = h, pointsize = 10)
    par(mar = c(4, 1, 1, 1))
    forest(m, col = "${ACCENT}", cex = 0.85)
    dev.off(); svg <- .ct_dev()
    out <- list(est = as.numeric(m$b)[1], se = m$se[1], z = m$zval[1], p = m$pval[1], lo = m$ci.lb[1], hi = m$ci.ub[1],
                QE = m$QE, QEdf = m$k - m$p, QEp = m$QEp, I2 = m$I2, tau2 = m$tau2, k = m$k, svg = svg,
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
      rows: [['Pooled effect', f(r.num('est'), 4), f(r.num('se'), 4), f(r.num('z'), 2), fmtP(r.num('p')), ci(r.num('lo'), r.num('hi'))]],
      rowHeaders: true,
    },
    { caption: `Meta-Analysis — ${model === 'FE' ? 'fixed/common effect' : 'random effects (REML)'}, k = ${r.num('k')} studies` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Q (heterogeneity)', `${f(r.num('QE'), 2)} (df ${f(r.num('QEdf'), 0)})`],
        ['p (Q)', fmtP(r.num('QEp'))],
        ['I²', `${f(r.num('I2'), 1)}%`],
        ['τ² (between-study variance)', f(r.num('tau2'), 4)],
      ],
      rowHeaders: true,
    },
    { caption: 'Heterogeneity' },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));

  if (r.num('hasMods') === 1 || r.strs('mrTerms').length) {
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
      `Omnibus test of moderators: QM(${f(r.num('QMdf'), 0)}) = ${f(r.num('QM'), 2)}, ${fmtPInline(r.num('QMp'))}. Residual I² = ${f(r.num('I2res'), 1)}% (heterogeneity left unexplained by the moderators).`,
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

function cleanSvg(svg) {
  return String(svg)
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
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

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function ci(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(4)}, ${hi.toFixed(4)}]` : '—';
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
    str1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
