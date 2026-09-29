/**
 * @file plugins/builtin-mixture/index.js
 * Built-in plugin: **latent class and latent profile analysis** — the mixture models that
 * define Mplus's niche (#141, driven by Gerontology faculty).
 *
 * Both answer the same question with different data: *are there unobserved subgroups of people
 * whose answers hang together?* Latent CLASS analysis takes categorical indicators (yes/no
 * items, ordinal ratings); latent PROFILE analysis takes continuous ones (scale scores). They
 * are the single most common reason a department buys an Mplus licence.
 *
 * ## Feasibility, checked before a line was written
 *
 * WebR's binary repo (R 4.6) was read directly rather than probed by trial:
 *  - `poLCA` — **available**, dependency closure of THREE (poLCA, scatterplot3d, MASS). Nothing
 *    like the ~20-shared-object ceiling that makes heavier packages fail ([[webr-package-feasibility]]).
 *  - `flexmix` — **available**, closure of four (flexmix, lattice, modeltools, nnet).
 *  - `mclust` — **not built for WebR at all**, which matters because it is the usual LPA engine
 *    and the reason `tidyLPA` (closure 115, and missing mclust) is not an option either. A
 *    Gaussian mixture from `flexmix` is the same model by a different route.
 *
 * ## Two things this does that a thin wrapper would not
 *
 * **It fits every k from 1 up and compares them.** Choosing the number of classes IS the
 * analysis — nobody knows it in advance, and the Mplus workflow is to fit several and read BIC,
 * entropy and the smallest class against each other. A tool that fitted only the k you typed
 * would be answering a question you cannot yet ask.
 *
 * **The random seed is an input, and it is reported.** Both engines use random starts, so the
 * same data can produce differently-numbered (or genuinely different) classes on two runs. That
 * is incompatible with a replayable log — an analysis that cannot be reproduced cannot be a
 * recorded step — so the seed is explicit, defaulted, and printed with the results.
 *
 * Class membership can be saved, because assigning people to classes and then analysing those
 * classes is the whole point. It lands in a NEW dataset: a plugin's data surface is read-only
 * apart from `data.create` (the op log belongs to the host), which is also the rule that makes
 * import offer a Swap rather than an in-place replace ([[no-inplace-replace]]).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-mixture',
  name: 'Latent Class & Profile Analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Analyze',
  keywords: [
    'latent class', 'lca', 'latent profile', 'lpa', 'mixture model', 'finite mixture',
    'poLCA', 'flexmix', 'mplus', 'typology', 'subgroups', 'clustering', 'model-based clustering',
    'class membership', 'entropy', 'BIC',
  ],
  disciplines: ['Psychology', 'Sociology', 'Public Health', 'Gerontology', 'Education', 'Social Science'],
  howto:
    'GUI: Analyze ▸ Latent class analysis (categorical items) or Latent profile analysis (continuous items). '
    + 'Pick the indicators, say how many classes to consider, and you get a comparison table for every k from 1 up '
    + '(AIC, BIC, entropy, smallest class) plus the detail for the largest k: class sizes, the profile of each class, '
    + 'and optionally each case\'s class saved to a new dataset.\n'
    + 'Syntax: run builtin-mixture.lca {"items": ["q1", "q2", "q3", "q4"], "classes": 3, "seed": 12345, "save": "no"}\n'
    + 'Syntax: run builtin-mixture.lpa {"items": ["anx", "dep", "som"], "classes": 3, "seed": 12345, "save": "yes"}\n'
    + '  • items — the indicators. LCA wants categorical (its categories are recoded to 1…K and the mapping is printed); LPA wants numeric.\n'
    + '  • classes — the most classes to consider. Every k from 1 to this is fitted and compared; the detail is for this k.\n'
    + '  • seed — random starts make these models seed-dependent, so it is explicit and reported (default 12345).\n'
    + '  • save — "yes" puts each case\'s class and its probability in a new dataset.',
  // poLCA closure: poLCA, scatterplot3d, MASS. flexmix closure: flexmix, lattice, modeltools,
  // nnet. Both tiny — checked against repo.r-wasm.org's index for R 4.6, not guessed.
  rPackages: ['poLCA', 'flexmix'],
  menu: [
    {
      label: 'Latent class analysis (categorical items)…',
      run: 'lca',
      order: 60,
      inputs: [
        { name: 'items', kind: 'variables', label: 'Indicators (categorical)', hint: 'The items whose pattern of answers might reveal subgroups. Their categories are recoded to 1…K for the model, and the mapping is printed.', multiple: true },
        { name: 'classes', kind: 'number', label: 'Most classes to consider', hint: 'Every number of classes from 1 up to this is fitted and compared; the detail is reported for this one.', default: 3, min: 1, max: 10, step: 1 },
        { name: 'seed', kind: 'number', label: 'Random seed', hint: 'These models start from random values, so the seed is what makes the result reproducible. Change it to check the solution is stable.', default: 12345, step: 1 },
        { name: 'save', kind: 'choice', label: 'Save each case’s class?', hint: 'Puts the class and its probability in a new dataset, so classes can be crosstabbed or compared.', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes — new dataset with class membership' }], default: 'no' },
      ],
    },
    {
      label: 'Latent profile analysis (continuous items)…',
      run: 'lpa',
      order: 61,
      inputs: [
        { name: 'items', kind: 'variables', label: 'Indicators (numeric)', hint: 'The measures whose pattern might reveal subgroups — scale scores, symptom counts, test results.', multiple: true, types: ['numeric'] },
        { name: 'classes', kind: 'number', label: 'Most profiles to consider', hint: 'Every number of profiles from 1 up to this is fitted and compared; the detail is reported for this one.', default: 3, min: 1, max: 10, step: 1 },
        { name: 'seed', kind: 'number', label: 'Random seed', hint: 'These models start from random values, so the seed is what makes the result reproducible. Change it to check the solution is stable.', default: 12345, step: 1 },
        { name: 'save', kind: 'choice', label: 'Save each case’s profile?', hint: 'Puts the profile and its probability in a new dataset, so profiles can be crosstabbed or compared.', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes — new dataset with profile membership' }], default: 'no' },
      ],
    },
  ],
};

/**
 * Relative entropy of a posterior matrix, the way Mplus reports it: 1 means every case is
 * classified with certainty, 0 means the classes carry no information about who is in them.
 * Computed in R alongside each fit; this is the shared R helper text.
 */
const ENTROPY_R = `
  ct_entropy <- function(post) {
    k <- ncol(post)
    if (is.null(k) || k < 2) return(NA_real_)
    p <- pmax(post, 1e-12)
    1 - (-sum(post * log(p))) / (nrow(post) * log(k))
  }`;

/**
 * @param {object} app
 * @param {{items: string[], classes: number, seed: number, save: string}} inputs
 */
export async function lca(app, { items, classes, seed, save }) {
  const names = Array.isArray(items) ? items : items ? [items] : [];
  if (names.length < 3) {
    await app.results.appendError(
      'Latent class analysis needs at least three indicators — with two, more than one class '
      + 'cannot be identified.',
    );
    return;
  }
  const kMax = clampK(classes);
  const seedVal = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 12345;
  const meta = metaMap(await app.data.getVariableMeta());

  // poLCA requires every manifest variable coded 1…K with no gaps. Real data is coded 0/1, or
  // 1/5, or with a missing code left in — so each item is recoded to the rank of its observed
  // values and the mapping is printed. Recoding silently is exactly what #187 was about.
  const rCode = `
    suppressMessages(library(poLCA))
    ${ENTROPY_R}
    d <- as.data.frame(items)
    # Model on safe symbols, report on the real names: a variable called "Q1 (wave 1)" is legal in
    # CrossTab and would break the formula poLCA needs.
    nm <- names(d)
    names(d) <- paste0("v", seq_along(d))
    vv <- names(d)
    maps <- list()
    for (j in seq_along(d)) {
      v <- d[[j]]
      lv <- sort(unique(v[!is.na(v)]))
      maps[[nm[j]]] <- as.character(lv)
      d[[j]] <- match(v, lv)
    }
    ncat <- sapply(d, function(v) length(unique(v[!is.na(v)])))
    if (any(ncat < 2)) stop("one or more indicators take only a single value")
    f <- as.formula(paste0("cbind(", paste(vv, collapse = ","), ") ~ 1"))
    set.seed(${seedVal})
    fits <- list(); rows <- list()
    for (k in 1:${kMax}) {
      fit <- try(poLCA(f, d, nclass = k, nrep = if (k == 1) 1 else 10, verbose = FALSE,
                       maxiter = 5000), silent = TRUE)
      if (inherits(fit, "try-error")) next
      ent <- if (k > 1) ct_entropy(fit$posterior) else NA_real_
      small <- if (k > 1) min(fit$P) else 1
      rows[[length(rows) + 1]] <- c(k, fit$npar, fit$aic, fit$bic, fit$Gsq, fit$resid.df, ent, small)
      fits[[as.character(k)]] <- fit
    }
    if (!length(rows)) stop("no model converged")
    cmp <- do.call(rbind, rows)
    best <- fits[[as.character(max(as.integer(names(fits))))]]
    kBest <- max(as.integer(names(fits)))
    # Item-response probabilities, flattened: one row per item x class, plus the category.
    pr <- best$probs
    pItem <- c(); pClass <- c(); pCat <- c(); pVal <- c()
    for (j in seq_along(pr)) {
      m <- pr[[j]]
      for (cl in seq_len(nrow(m))) for (ct in seq_len(ncol(m))) {
        pItem <- c(pItem, nm[j]); pClass <- c(pClass, cl); pCat <- c(pCat, ct); pVal <- c(pVal, m[cl, ct])
      }
    }
    list(
      k = kBest, n = sum(!is.na(rowSums(as.matrix(d)))),
      cmpK = cmp[, 1], cmpNpar = cmp[, 2], cmpAic = cmp[, 3], cmpBic = cmp[, 4],
      cmpG2 = cmp[, 5], cmpDf = cmp[, 6], cmpEnt = cmp[, 7], cmpSmall = cmp[, 8],
      share = best$P, pItem = pItem, pClass = pClass, pCat = pCat, pVal = pVal,
      mapItem = rep(nm, sapply(maps, length)), mapCode = unlist(maps, use.names = FALSE),
      mapRank = unlist(lapply(maps, seq_along), use.names = FALSE),
      assign = best$predclass, maxPost = apply(best$posterior, 1, max)
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  await app.results.beginAnalysis('Latent class analysis');
  await reportMixture(app, r, {
    kind: 'class',
    names,
    meta,
    seedVal,
    save: String(save ?? 'no') === 'yes',
    detail: async () => {
      // The category mapping, first: every probability below is stated in terms of it.
      const mi = r.strs('mapItem');
      const mc = r.strs('mapCode');
      const mr = r.nums('mapRank');
      const byItem = new Map();
      mi.forEach((it, i) => {
        if (!byItem.has(it)) byItem.set(it, []);
        byItem.get(it).push(`${mr[i]} = ${labelValue(meta, it, mc[i])}`);
      });
      await app.results.appendTable({
        columns: ['Indicator', 'Categories, as modelled'],
        rows: [...byItem].map(([it, parts]) => [labelOf(meta, it), parts.join(', ')]),
        rowHeaders: true,
      }, { caption: 'How each indicator was coded' });

      // Item-response probabilities: the profile of each class, which IS the interpretation.
      const pItem = r.strs('pItem');
      const pClass = r.nums('pClass');
      const pCat = r.nums('pCat');
      const pVal = r.nums('pVal');
      const k = r.num('k');
      const cats = new Map();
      pItem.forEach((it, i) => {
        if (!cats.has(it)) cats.set(it, new Set());
        cats.get(it).add(pCat[i]);
      });
      const rows = [];
      for (const [it, catSet] of cats) {
        for (const ct of [...catSet].sort((a, b) => a - b)) {
          const cells = [];
          for (let cl = 1; cl <= k; cl += 1) {
            const i = pItem.findIndex((x, j) => x === it && pClass[j] === cl && pCat[j] === ct);
            cells.push(i < 0 ? '—' : f(pVal[i], 3));
          }
          const code = mc[mi.findIndex((x, j) => x === it && mr[j] === ct)];
          rows.push([`${labelOf(meta, it)} = ${labelValue(meta, it, code)}`, ...cells]);
        }
      }
      await app.results.appendTable({
        columns: ['', ...Array.from({ length: k }, (_, i) => `Class ${i + 1}`)],
        rows,
        rowHeaders: true,
      }, { caption: 'Probability of each answer, by class' });
      await app.results.appendText(
        'Read down a class: the answers with high probability are what defines it. Read across a '
        + 'row: how much that answer separates the classes.',
      );
    },
  });
  await app.results.endAnalysis();
}

/**
 * @param {object} app
 * @param {{items: string[], classes: number, seed: number, save: string}} inputs
 */
export async function lpa(app, { items, classes, seed, save }) {
  const names = Array.isArray(items) ? items : items ? [items] : [];
  if (names.length < 2) {
    await app.results.appendError('Latent profile analysis needs at least two indicators.');
    return;
  }
  const kMax = clampK(classes);
  const seedVal = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 12345;
  const meta = metaMap(await app.data.getVariableMeta());

  // `mclust` is not built for WebR, so the Gaussian mixture comes from flexmix. `diagonal = TRUE`
  // is the usual LPA specification: indicators are independent WITHIN a profile (their
  // correlation is what the profiles are meant to explain), with variances free to differ
  // between profiles.
  const rCode = `
    suppressMessages(library(flexmix))
    ${ENTROPY_R}
    d <- as.data.frame(items)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    if (nrow(d) < 20) stop("too few complete cases for a mixture model")
    X <- as.matrix(d)
    set.seed(${seedVal})
    fits <- list(); rows <- list()
    for (k in 1:${kMax}) {
      fit <- try(flexmix(X ~ 1, k = k, model = FLXMCmvnorm(diagonal = TRUE),
                         control = list(iter.max = 1000, minprior = 0)), silent = TRUE)
      if (inherits(fit, "try-error") || is.null(fit) || fit@k < 1) next
      post <- flexmix::posterior(fit)
      ent <- if (fit@k > 1) ct_entropy(post) else NA_real_
      small <- if (fit@k > 1) min(fit@prior) else 1
      rows[[length(rows) + 1]] <- c(k, fit@k, length(fit@prior) * (2 * ncol(X)) + fit@k - 1,
                                    AIC(fit), BIC(fit), as.numeric(logLik(fit)), ent, small)
      fits[[as.character(k)]] <- fit
    }
    if (!length(rows)) stop("no model converged")
    cmp <- do.call(rbind, rows)
    kBest <- max(as.integer(names(fits)))
    best <- fits[[as.character(kBest)]]
    # parameters() stacks centres and covariances; only the center.* rows are the profile means.
    pars <- parameters(best)
    keep <- grepl("^center", rownames(pars))
    cen <- as.matrix(pars[keep, , drop = FALSE])
    list(
      k = best@k, n = nrow(X),
      cmpK = cmp[, 2], cmpNpar = cmp[, 3], cmpAic = cmp[, 4], cmpBic = cmp[, 5],
      cmpLL = cmp[, 6], cmpEnt = cmp[, 7], cmpSmall = cmp[, 8],
      share = as.numeric(best@prior),
      cenVals = as.numeric(cen), cenItem = rep(names(d), ncol(cen)),
      cenClass = rep(seq_len(ncol(cen)), each = nrow(cen)),
      assign = flexmix::clusters(best), maxPost = apply(flexmix::posterior(best), 1, max)
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  await app.results.beginAnalysis('Latent profile analysis');
  await reportMixture(app, r, {
    kind: 'profile',
    names,
    meta,
    seedVal,
    save: String(save ?? 'no') === 'yes',
    detail: async () => {
      const k = r.num('k');
      const ci = r.strs('cenItem');
      const cc = r.nums('cenClass');
      const cv = r.nums('cenVals');
      const rows = names.map((nm) => {
        const cells = [];
        for (let cl = 1; cl <= k; cl += 1) {
          const i = ci.findIndex((x, j) => x === nm && cc[j] === cl);
          cells.push(i < 0 ? '—' : f(cv[i], 3));
        }
        return [labelOf(meta, nm), ...cells];
      });
      await app.results.appendTable({
        columns: ['', ...Array.from({ length: k }, (_, i) => `Profile ${i + 1}`)],
        rows,
        rowHeaders: true,
      }, { caption: 'Mean of each indicator, by profile' });
      await app.results.appendText(
        'Means are in the indicators’ own units, so profiles are read by comparing across a row. '
        + '**Indicators on very different scales let the widest-ranging one dominate** — if one is '
        + 'in years and another is a 1–5 rating, standardise them first (Transform ▸ Compute) and '
        + 're-run. Within a profile the indicators are modelled as independent, with variances '
        + 'free to differ between profiles.',
      );
    },
  });
  await app.results.endAnalysis();
}

// --- shared reporting --------------------------------------------------------

/**
 * Everything both models say the same way: the k-comparison table (the real output of a mixture
 * analysis), the class sizes, the caller's detail, the seed, and the optional saved membership.
 */
async function reportMixture(app, r, { kind, names, meta, seedVal, save, detail }) {
  const Kind = kind === 'class' ? 'Class' : 'Profile';
  // "class" does not pluralise by adding an s, and the first version of this printed
  // "2 classs" in the guidance the whole table hangs on.
  const many = kind === 'class' ? 'classes' : 'profiles';
  const some = (n) => `${f(n, 0)} ${n === 1 ? kind : many}`;
  const k = r.num('k');
  const cmpK = r.nums('cmpK');
  const ent = r.nums('cmpEnt');
  const small = r.nums('cmpSmall');
  const hasG2 = r.nums('cmpG2').length > 0;

  await app.results.appendText(
    `Indicators: ${names.map((nm) => labelOf(meta, nm)).join(', ')}. `
    + `N = ${f(r.num('n'), 0)} complete cases. Random seed ${seedVal} — `
    + 'these models start from random values, so the seed is part of the result.',
  );

  await app.results.appendTable({
    columns: hasG2
      ? [`${Kind}es`, 'Parameters', 'AIC', 'BIC', 'G²', 'df', 'Entropy', `Smallest ${kind} %`]
      : [`${Kind}s`, 'Parameters', 'AIC', 'BIC', 'log L', 'Entropy', `Smallest ${kind} %`],
    rows: cmpK.map((kk, i) => (hasG2
      ? [f(kk, 0), f(r.nums('cmpNpar')[i], 0), f(r.nums('cmpAic')[i], 1), f(r.nums('cmpBic')[i], 1),
        f(r.nums('cmpG2')[i], 2), f(r.nums('cmpDf')[i], 0), f(ent[i], 3), pct(small[i])]
      : [f(kk, 0), f(r.nums('cmpNpar')[i], 0), f(r.nums('cmpAic')[i], 1), f(r.nums('cmpBic')[i], 1),
        f(r.nums('cmpLL')[i], 2), f(ent[i], 3), pct(small[i])])),
    rowHeaders: true,
  }, { caption: `Choosing the number of ${kind}s` });

  // The rule for reading that table, which is the part users get wrong.
  const bicAt = r.nums('cmpBic');
  let bestI = 0;
  for (let i = 1; i < bicAt.length; i += 1) if (bicAt[i] < bicAt[bestI]) bestI = i;
  const tiny = small.map((s, i) => ({ k: cmpK[i], s })).filter((x) => Number.isFinite(x.s) && x.s < 0.05);
  const guide = [
    `**Lower BIC is better, and BIC is the measure to trust** for these models — it is lowest at ${some(cmpK[bestI])} here.`,
    'Entropy says how cleanly cases separate (1 is perfect, below about 0.8 the classes overlap enough that assigning people to one is shaky).',
  ];
  if (tiny.length) {
    guide.push(`A ${kind} holding under 5% of cases is usually not a finding — at k = ${tiny.map((x) => f(x.k, 0)).join(', ')} the smallest is that small, which often means the model is fitting a handful of unusual cases.`);
  }
  guide.push('And the statistics do not decide: a solution has to be interpretable, and a k that fits slightly better but describes nothing is the wrong answer.');
  // Close the loop the comparison table opens. The detail below is for the k the user ASKED for,
  // not the one BIC prefers — choosing for them would contradict the sentence above — so say
  // plainly how to see the other one.
  if (cmpK[bestI] !== k) {
    guide.push(`The detail below is for **${some(k)}**, because that is what you asked to see. Re-run with ${f(cmpK[bestI], 0)} to read the solution BIC prefers.`);
  }
  await app.results.appendText(guide.join(' '));

  const share = r.nums('share');
  await app.results.appendTable({
    columns: ['', 'Share', 'Cases (modal)'],
    rows: share.map((p, i) => {
      const assign = r.nums('assign');
      const n = assign.filter((a) => a === i + 1).length;
      return [`${Kind} ${i + 1}`, pct(p), f(n, 0)];
    }),
    rowHeaders: true,
  }, { caption: `${Kind} sizes (k = ${f(k, 0)})` });

  await detail();

  if (save) await saveMembership(app, r, { kind, Kind, meta });
}

/** Write each case's class and its probability into a new dataset (#141's SAVEDATA equivalent). */
async function saveMembership(app, r, { kind, Kind, meta }) {
  const assign = r.nums('assign');
  const post = r.nums('maxPost');
  const cols = await app.data.getColumns();
  const colNames = Object.keys(cols || {});
  const n = colNames.length ? (cols[colNames[0]]?.length ?? 0) : 0;
  if (assign.length !== n) {
    // The model drops incomplete cases, so the vectors are shorter than the dataset and there is
    // no honest way to line them up. Say so rather than writing a misaligned column.
    await app.results.appendText(
      `_${Kind} membership was not saved: the model used ${assign.length} complete cases out of `
      + `${n} rows, so the classes cannot be matched back to rows one-for-one. Filter or impute the `
      + 'missing values on the indicators first, then re-run._',
    );
    return;
  }
  const varMeta = (await app.data.getVariableMeta()) || [];
  const byName = Object.fromEntries(varMeta.map((m) => [m.name, m]));
  const cname = uniqueName(kind === 'class' ? 'latent_class' : 'latent_profile', colNames);
  const pname = uniqueName(`${cname}_prob`, [...colNames, cname]);
  const columns = {};
  for (const nm of colNames) {
    columns[nm] = Array.from(cols[nm], (v) => (typeof v === 'number' && Number.isNaN(v) ? null : v));
  }
  columns[cname] = assign.map((a) => String(a));
  columns[pname] = post.map((p) => (Number.isFinite(p) ? p : null));
  await app.data.create({
    name: `${kind === 'class' ? 'Classes' : 'Profiles'} (k = ${f(r.num('k'), 0)})`,
    variables: [
      ...colNames.map((nm) => byName[nm] || { name: nm }),
      { name: cname, type: 'string', measurementLevel: 'nominal', label: `${Kind} membership (modal)` },
      { name: pname, type: 'numeric', measurementLevel: 'scale', label: `Probability of assigned ${kind}` },
    ],
    columns,
  });
  await app.results.appendText(
    `_Saved to a new dataset: **${cname}** (each case's most likely ${kind}) and **${pname}** (how `
    + `certain that is). Cases with a low probability sit between ${kind}s — worth checking before `
    + `treating ${kind} as a variable. The original data is unchanged._`,
  );
  void meta;
}

// --- helpers -----------------------------------------------------------------

/** 1…10 classes. Below 1 is not a model; above 10 is not an interpretable typology, and each
 * extra k is another fit of every start. */
function clampK(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(10, n));
}

function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function labelOf(meta, name) {
  return meta.get(name)?.label || name;
}
/** A value's own label where the codebook has one, so a class profile reads "Agree", not "4". */
function labelValue(meta, name, code) {
  const vl = meta.get(name)?.valueLabels;
  if (!vl) return String(code);
  return vl[code] ?? vl[Number(code)] ?? String(code);
}
function f(n, d) {
  return Number.isFinite(n) ? Number(n).toFixed(d) : '—';
}
function pct(p) {
  return Number.isFinite(p) ? `${(p * 100).toFixed(1)}%` : '—';
}
function uniqueName(name, taken) {
  const used = new Set(taken || []);
  if (!used.has(name)) return name;
  for (let i = 2; i < 1000; i += 1) if (!used.has(`${name}_${i}`)) return `${name}_${i}`;
  return `${name}_x`;
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
