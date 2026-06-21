/**
 * @file plugins/builtin-sem/index.js
 * Built-in plugin: **Confirmatory Factor Analysis & SEM** (lavaan).
 *
 * Two actions:
 *  - **Confirmatory factor analysis** — confirm that a set of items measures one
 *    latent factor (scale validation): standardized loadings + the standard fit
 *    indices (χ², CFI, TLI, RMSEA, SRMR). The natural confirmatory companion to the
 *    exploratory Factor analysis tool.
 *  - **Structural equation model (syntax)** — a free-form lavaan model for
 *    multi-factor CFA / path / structural models (power users).
 *
 * WebR/R-4.6 quirk handled: lavaan's pre-flight option validation chokes on NA
 * environment defaults (e.g. parallel::detectCores() returns NA in WebR), throwing
 * "missing value where TRUE/FALSE needed" before estimation even starts. The
 * prelude relaxes ONLY that spurious-NA case in `lav_options_checkinterval`
 * (genuine out-of-range still returns FALSE and is caught); estimation is
 * unaffected — verified against textbook values (Holzinger-Swineford cfi=0.975).
 */

/** Run once per session before any lavaan fit: neutralise the spurious-NA option
 * check that WebR's environment triggers. Guarded so it only wraps once. */
const LAVAAN_PRELUDE = `
suppressMessages(library(lavaan))
if (!isTRUE(getOption("ct.lavaan.patched"))) {
  local({
    ns <- asNamespace("lavaan")
    orig <- get("lav_options_checkinterval", ns)
    suppressWarnings({
      unlockBinding("lav_options_checkinterval", ns)
      assign("lav_options_checkinterval", function(...) {
        r <- tryCatch(orig(...), error = function(e) NA)
        if (length(r) != 1 || is.na(r)) TRUE else r
      }, ns)
    })
  })
  options(ct.lavaan.patched = TRUE)
}`;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-sem',
  name: 'CFA & SEM',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['cfa', 'sem', 'lavaan', 'confirmatory factor analysis', 'structural equation', 'latent', 'fit indices', 'loadings'],
  disciplines: ['Psychology', 'Sociology'],
  rPackages: ['lavaan'],
  menu: [
    {
      label: 'Confirmatory factor analysis…',
      run: 'cfa',
      order: 30,
      inputs: [
        { name: 'items', kind: 'variables', label: 'Items (one factor)', multiple: true, types: ['numeric'] },
        { name: 'factorName', kind: 'text', label: 'Factor name', default: 'Factor', optional: true },
      ],
    },
    {
      label: 'Structural equation model (syntax)…',
      run: 'sem',
      order: 40,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Variables used in the model', multiple: true },
        {
          name: 'model',
          kind: 'text',
          label: "lavaan model syntax — separate equations with ';' (e.g. f1 =~ x1+x2+x3 ; f2 =~ x4+x5+x6 ; f1 ~~ f2)",
        },
      ],
    },
  ],
};

// --- Confirmatory factor analysis (single factor) ----------------------------

/**
 * @param {object} app
 * @param {{items: string[], factorName: ?string}} inputs
 */
export async function cfa(app, { items, factorName }) {
  if (!items || items.length < 2) {
    await app.results.appendError('CFA needs at least 2 items.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const fac = sanitizeName(factorName) || 'Factor';
  const recodes = items.map((n) => recodeLine(`items[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  // lavaan model syntax uses plain names (NOT R backticks).
  const model = `${fac} =~ ${items.join(' + ')}`;
  const rCode = `
    ${LAVAAN_PRELUDE}
    ${recodes}
    fit <- cfa(${rStr(model)}, data = items, std.lv = TRUE)
    fm <- fitMeasures(fit, c("chisq","df","pvalue","cfi","tli","rmsea","rmsea.ci.lower","rmsea.ci.upper","srmr"))
    ld <- standardizedSolution(fit); ld <- ld[ld$op == "=~", ]
    list(items = ld$rhs, std = ld$est.std, se = ld$se, z = ld$z, p = ld$pvalue,
         chisq = unname(fm["chisq"]), df = unname(fm["df"]), pval = unname(fm["pvalue"]),
         cfi = unname(fm["cfi"]), tli = unname(fm["tli"]), rmsea = unname(fm["rmsea"]),
         rlo = unname(fm["rmsea.ci.lower"]), rhi = unname(fm["rmsea.ci.upper"]), srmr = unname(fm["srmr"]),
         n = lavInspect(fit, "nobs"))`;
  const r = flat(await runR(app, rCode));

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['χ² (df)', `${f(r.num('chisq'), 2)} (${f(r.num('df'), 0)})`],
        ['p (χ²)', fmtP(r.num('pval'))],
        ['CFI', f(r.num('cfi'), 3)],
        ['TLI', f(r.num('tli'), 3)],
        ['RMSEA [90% CI]', `${f(r.num('rmsea'), 3)} [${f(r.num('rlo'), 3)}, ${f(r.num('rhi'), 3)}]`],
        ['SRMR', f(r.num('srmr'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: `CFA Fit — ${fac} =~ ${items.length} items (N = ${r.num('n')})` },
  );

  const its = r.strs('items'), std = r.nums('std'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p');
  await app.results.appendTable(
    {
      columns: ['Item', 'Std. loading', 'SE', 'z', 'Sig.'],
      rows: its.map((it, i) => [labelOf(meta.get(it), it), f(std[i], 3), f(se[i], 3), f(z[i], 2), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: 'Standardized Loadings' },
  );
  await app.results.appendText(
    'Good fit (rules of thumb): **CFI/TLI ≥ .95**, **RMSEA ≤ .06**, **SRMR ≤ .08**. Standardized loadings ≥ .5 (ideally ≥ .7) indicate items that represent the factor well. χ² is sensitive to N, so lean on the descriptive indices.',
  );
}

// --- Structural equation model (free-form lavaan syntax) ---------------------

/**
 * @param {object} app
 * @param {{model: string}} inputs
 */
export async function sem(app, { vars, model }) {
  if (!vars || !vars.length || !model || !model.trim()) {
    await app.results.appendError('Choose the variables used in the model and enter lavaan syntax (e.g. `f1 =~ x1+x2+x3 ; f2 =~ x4+x5+x6`).');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = vars.map((n) => recodeLine(`d[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  // Users type one line with ';' separators; lavaan wants newline-separated.
  const modelSyntax = model.replace(/;/g, '\n');
  const rCode = `
    ${LAVAAN_PRELUDE}
    d <- vars
    ${recodes}
    fit <- sem(${rStr(modelSyntax)}, data = d)
    fm <- fitMeasures(fit, c("chisq","df","pvalue","cfi","tli","rmsea","srmr"))
    ps <- standardizedSolution(fit); ps <- ps[ps$op %in% c("=~","~","~~"), ]
    list(lhs = ps$lhs, op = ps$op, rhs = ps$rhs, std = ps$est.std, se = ps$se, z = ps$z, p = ps$pvalue,
         chisq = unname(fm["chisq"]), df = unname(fm["df"]), pval = unname(fm["pvalue"]),
         cfi = unname(fm["cfi"]), tli = unname(fm["tli"]), rmsea = unname(fm["rmsea"]), srmr = unname(fm["srmr"]),
         n = lavInspect(fit, "nobs"))`;
  const r = flat(await runR(app, rCode));

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['χ² (df)', `${f(r.num('chisq'), 2)} (${f(r.num('df'), 0)})`],
        ['p (χ²)', fmtP(r.num('pval'))],
        ['CFI', f(r.num('cfi'), 3)],
        ['TLI', f(r.num('tli'), 3)],
        ['RMSEA', f(r.num('rmsea'), 3)],
        ['SRMR', f(r.num('srmr'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: `SEM Fit (N = ${r.num('n')})` },
  );
  const lhs = r.strs('lhs'), op = r.strs('op'), rhs = r.strs('rhs'), std = r.nums('std'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p');
  const opLabel = { '=~': 'loads', '~': 'on', '~~': 'with' };
  await app.results.appendTable(
    {
      columns: ['Parameter', 'Std. est.', 'SE', 'z', 'Sig.'],
      rows: lhs.map((l, i) => [`${l} ${opLabel[op[i]] || op[i]} ${rhs[i]}`, f(std[i], 3), f(se[i], 3), f(z[i], 2), fmtP(p[i])]),
      rowHeaders: true,
    },
    { caption: 'Standardized Estimates' },
  );
  await app.results.appendText(
    'Estimates are standardized. `=~` measurement (loadings), `~` structural (regressions), `~~` (co)variances. ' +
      'Use the same variable names in the model syntax as in the dataset.',
  );
}

// --- helpers -----------------------------------------------------------------

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function sanitizeName(s) {
  const n = String(s ?? '').trim().replace(/[^A-Za-z0-9_]/g, '');
  return /^[A-Za-z]/.test(n) ? n : '';
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

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
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
