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

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-anova',
  name: 'ANOVA (factorial & repeated measures)',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Comparison',
  keywords: ['anova', 'factorial', 'two-way', 'interaction', 'repeated measures', 'within-subjects', 'eta squared'],
  rPackages: [],
  menu: [
    {
      label: 'Factorial ANOVA…',
      run: 'factorial',
      order: 50,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', types: ['numeric'], unique: true },
        { name: 'facs', kind: 'variables', label: 'Factors (2+)', multiple: true, unique: true },
      ],
    },
    {
      label: 'Repeated-measures ANOVA…',
      run: 'repeated',
      order: 60,
      inputs: [{ name: 'vars', kind: 'variables', label: 'Repeated measures (2+ columns)', multiple: true, types: ['numeric'] }],
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
  const recodes = [recode('dv', missing(meta, dv)), ...facNames.map((n, i) => recode(`facs[[${i + 1}]]`, missing(meta, n)))]
    .filter(Boolean)
    .join('\n');
  const rhs = facNames.map((n) => `factor(\`${n}\`)`).join(' * ');

  const rCode = `
    ${recodes}
    d <- data.frame(.y = dv, facs, check.names = FALSE)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- aov(as.formula(${rStr(`.y ~ ${rhs}`)}), data = d)
    a <- summary(fit)[[1]]
    list(terms = trimws(rownames(a)), ss = a[, "Sum Sq"], df = a[, "Df"], ms = a[, "Mean Sq"],
         F = a[, "F value"], p = a[, "Pr(>F)"], n = nrow(d))`;

  const r = flat((await app.webr.run(rCode)).result);
  const terms = r.str('terms');
  const ss = r.num('ss');
  const residIdx = terms.findIndex((t) => /^Residuals$/i.test(t));
  const residSS = residIdx >= 0 ? ss[residIdx] : NaN;
  const df = r.num('df');
  const ms = r.num('ms');
  const F = r.num('F');
  const p = r.num('p');

  await app.results.appendTable(
    {
      columns: ['Source', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.', 'Partial η²'],
      rows: terms.map((t, i) => [
        prettyTerm(t),
        f(ss[i], 3),
        int(df[i]),
        f(ms[i], 3),
        f(F[i], 3),
        fmtP(p[i]),
        /^Residuals$/i.test(t) || !Number.isFinite(residSS) ? '' : f(ss[i] / (ss[i] + residSS), 3),
      ]),
      rowHeaders: true,
    },
    { caption: `Tests of Between-Subjects Effects — dependent: ${label(meta, dv)} (N = ${int(r.n1('n'))})` },
  );
  await app.results.appendText('Type I (sequential) sums of squares; for a balanced design these match Type II/III. Partial η² = SS / (SS + SS_residual).');
}

export async function repeated(app, { vars }) {
  const names = Array.isArray(vars) ? vars : vars ? [vars] : [];
  if (names.length < 2) {
    await app.results.appendError('Repeated-measures ANOVA needs at least 2 measurement columns.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = names.map((n, i) => recode(`d[[${i + 1}]]`, missing(meta, n))).filter(Boolean).join('\n');

  const rCode = `
    d <- as.data.frame(vars, check.names = FALSE)
    ${recodes}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    n <- nrow(d); k <- ncol(d)
    if (n < 2 || k < 2) stop("need at least 2 complete rows and 2 columns")
    val <- as.numeric(unlist(d, use.names = FALSE))
    subj <- factor(rep(seq_len(n), times = k))
    cond <- factor(rep(seq_len(k), each = n))
    fit <- aov(val ~ cond + Error(subj / cond))
    ss <- summary(fit); ws <- ss[[length(ss)]][[1]]
    list(
      means = colMeans(d), sds = apply(d, 2, sd), n = n, k = k,
      ssCond = ws["cond", "Sum Sq"], dfCond = ws["cond", "Df"], msCond = ws["cond", "Mean Sq"],
      F = ws["cond", "F value"], p = ws["cond", "Pr(>F)"],
      ssRes = ws["Residuals", "Sum Sq"], dfRes = ws["Residuals", "Df"], msRes = ws["Residuals", "Mean Sq"]
    )`;

  const r = flat((await app.webr.run(rCode)).result);
  const means = r.num('means');
  const sds = r.num('sds');
  await app.results.appendTable(
    {
      columns: ['Measure', 'Mean', 'SD', 'N'],
      rows: names.map((nm, i) => [label(meta, nm), f(means[i], 3), f(sds[i], 3), int(r.n1('n'))]),
      rowHeaders: true,
    },
    { caption: 'Descriptive Statistics' },
  );

  const ssCond = r.n1('ssCond');
  const ssRes = r.n1('ssRes');
  await app.results.appendTable(
    {
      columns: ['Source', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.', 'Partial η²'],
      rows: [
        ['Condition (within)', f(ssCond, 3), int(r.n1('dfCond')), f(r.n1('msCond'), 3), f(r.n1('F'), 3), fmtP(r.n1('p')), f(ssCond / (ssCond + ssRes), 3)],
        ['Residual', f(ssRes, 3), int(r.n1('dfRes')), f(r.n1('msRes'), 3), '', '', ''],
      ],
      rowHeaders: true,
    },
    { caption: 'Tests of Within-Subjects Effects' },
  );
  await app.results.appendText('Sphericity is assumed (no Greenhouse–Geisser correction). With only two levels, sphericity is not an issue.');
}

// --- helpers -----------------------------------------------------------------

function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function label(meta, name) {
  return meta.get(name)?.label || name;
}
function missing(meta, name) {
  return (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v))).map(Number);
}
function recode(rvar, mv) {
  return mv.length ? `${rvar}[${rvar} %in% c(${mv.join(', ')})] <- NA` : '';
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
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    num: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    str: (k) => arr(byName[k]).map((x) => (x == null ? '' : String(x))),
    n1: (k) => {
      const a = arr(byName[k]);
      return a.length ? (a[0] == null ? NaN : Number(a[0])) : NaN;
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
