/**
 * @file plugins/builtin-doe/index.js
 * Built-in plugin: **response-surface analysis** (design of experiments) — fits a
 * second-order (quadratic) response surface in 2+ continuous factors, the core
 * of RSM for process optimization (engineering, agronomy, food science,
 * experimental psych). Reports the model, finds the **stationary point**, and
 * does the canonical (eigenvalue) analysis that classifies it as a maximum,
 * minimum or saddle. Uses the `rsm` package.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-doe',
  name: 'Response surface (DOE)',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['doe', 'design of experiments', 'response surface', 'rsm', 'optimization', 'quadratic', 'stationary point', 'canonical'],
  disciplines: ['Nutrition, Food & Dietetics', 'Family & Consumer Sciences', 'Business', 'Environmental Studies'],
  howto:
    'GUI: Regression ▸ Response surface (second-order)…, pick a response and 2+ continuous factors. You get the quadratic model, the stationary point, and a canonical (max/min/saddle) classification.\n' +
    'Syntax: run builtin-doe.run {"y": "yield", "factors": ["temp", "time"]}\n' +
    '  • y — the numeric response to optimize.\n' +
    '  • factors — two or more continuous factor variables.',
  rPackages: ['rsm'],
  menu: [
    {
      label: 'Response surface (second-order)…',
      run: 'run',
      order: 190,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Response', hint: 'The measured result you want to optimize.', multiple: false, types: ['numeric'], unique: true },
        { name: 'factors', kind: 'variables', label: 'Factors (2+ continuous)', hint: 'The dials you varied in the experiment, two or more.', multiple: true, types: ['numeric'], unique: true },
      ],
    },
  ],
};

export async function run(app, { y: yName, factors: facNames }) {
  if (!yName || !facNames || facNames.length < 2) {
    await app.results.appendError('Response surface: choose a response and at least two continuous factors.');
    return;
  }
  await app.webr.installPackages(['rsm']);
  const meta = metaMap(await app.data.getVariableMeta());
  const tok = facNames.map((_, i) => `x${i + 1}`);
  const recodes = [recodeLine('y', meta.get(yName)), ...facNames.map((n) => recodeLine(`factors[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const mk = facNames.map((n, i) => `d$${tok[i]} <- as.numeric(factors[[${rStr(n)}]])`).join('\n');
  const rCode = `
    suppressMessages(library(rsm))
    ${recodes}
    d <- data.frame(.y = as.numeric(y))
    ${mk}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- rsm(as.formula(paste0(".y ~ SO(", paste(c(${tok.map(rStr).join(', ')}), collapse = ", "), ")")), data = d)
    s <- summary(fit); co <- s$coefficients
    can <- s$canonical
    list(terms = rownames(co), est = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
         r2 = s$r.squared, n = nrow(d),
         stat = as.numeric(can$xs), statNames = names(can$xs), eig = as.numeric(can$eigen$values),
         facNames = c(${facNames.map((n) => rStr(labelOf(meta.get(n), n))).join(', ')}))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), tv = r.nums('t'), p = r.nums('p');
  const fac = r.strs('facNames');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 't', 'Sig.'],
      rows: terms.map((t, i) => [doeTerm(t, fac), f(est[i], 4), f(se[i], 4), f(tv[i], 2), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: `Response Surface (second-order) — ${labelOf(meta.get(yName), yName)} (N = ${r.num('n')}, R² = ${f(r.num('r2'), 3)})` },
  );

  const stat = r.nums('stat'), eig = r.nums('eig');
  const kind = eig.every((e) => e < 0) ? 'maximum' : eig.every((e) => e > 0) ? 'minimum' : 'saddle point';
  await app.results.appendTable(
    {
      columns: ['Factor', 'Stationary point'],
      rows: fac.map((fn, i) => [fn, f(stat[i], 4)]),
      rowHeaders: true,
    },
    { caption: `Stationary Point (canonical analysis: ${kind})` },
  );
  await app.results.appendText(
    `The fitted surface is quadratic in the factors. The **stationary point** is where the surface flattens; the canonical eigenvalues (${eig.map((e) => f(e, 3)).join(', ')}) classify it — all negative ⇒ **maximum**, all positive ⇒ **minimum**, mixed signs ⇒ **saddle**. Here it is a **${kind}**. FO = linear, TWI = interaction, PQ = pure-quadratic terms.`,
  );
}

// --- helpers -----------------------------------------------------------------
function doeTerm(t, fac) {
  let s = t;
  fac.forEach((fn, i) => { s = s.replace(new RegExp(`\\bx${i + 1}\\b`, 'g'), fn); });
  if (s === '(Intercept)') return '(Constant)';
  return s.replace(/:/g, ' × ').replace(/I\((.+?)\^2\)/g, '$1²').replace(/\^2/g, '²');
}
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function labelOf(meta, name) { return meta?.label ? `${meta.label} (${name})` : name; }
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function fmtP(p) { return !Number.isFinite(p) ? '—' : p < 0.001 ? '< .001' : p.toFixed(3); }
function rStr(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  else Object.assign(byName, rList || {});
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? 'NA' : String(x))),
    num: (k) => { const a = arr(byName[k]); return a.length ? Number(a[0]) : NaN; },
  };
}
