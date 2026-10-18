/**
 * @file plugins/builtin-agreement/index.js
 * Built-in plugin: Scale ▸ Inter-rater agreement — Cohen's κ, Fleiss' κ,
 * Krippendorff's α and percent agreement.
 *
 * The coefficient a qualitative or content-analysis paper has to report before anyone
 * will believe its coding. Two coders read the same material, apply the same scheme,
 * and the reader wants to know how much of their agreement was more than luck.
 *
 * Two ways in, because the data arrives in two shapes:
 *
 *  - **Variables** — one column per rater, one row per unit. The universal form, and
 *    what every other package means by inter-rater reliability.
 *  - **CAQDAS codings** — computed straight off the coding records this project already
 *    holds. #148 stamps every segment with its author, so the coder identity is already
 *    in the data and nobody has to reshape anything by hand. That is the whole reason
 *    this can exist as a two-click analysis rather than an export-and-wrangle chore.
 *
 * Everything is computed by `irr`, the package the field cites, rather than hand-rolled
 * (see the project's rule about validating anything hand-written against the official
 * library — the cheapest way to satisfy it is not to hand-write it). `icr` was the other
 * candidate for Krippendorff's α and is BROKEN in WebR: its `cores` default reaches
 * `parallel::detectCores()`, which returns NA there, and every call dies with
 * "non-numeric argument to mathematical function". `irr::kripp.alpha` has no such
 * dependency and covers the same four metrics.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, rounded: int, unpackR: flat, fmtP: fp, coderName: coderOf } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-agreement',
  name: 'Inter-rater Agreement',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Scale',
  keywords: [
    'kappa', 'cohen', 'fleiss', 'krippendorff', 'alpha', 'inter-rater', 'interrater',
    'inter-coder', 'intercoder', 'agreement', 'reliability', 'coding', 'qualitative',
    'content analysis', 'raters', 'coders',
  ],
  disciplines: [
    'Psychology', 'Sociology', 'Communication', 'Education', 'Anthropology',
    'Public Policy & Administration', "Women's & Gender Studies", 'Ethnic Studies',
    'Nursing, Food & Dietetics', 'Family & Consumer Sciences',
  ],
  howto:
    'GUI: Scale ▸ Inter-rater agreement…, then pick one column per rater (2+). You get '
    + "percent agreement, Cohen's κ (2 raters) or Fleiss' κ (3+), and Krippendorff's α "
    + 'with a benchmark reading.\n'
    + 'GUI: Scale ▸ Inter-coder agreement from codings… computes the same coefficients '
    + 'from this project’s CAQDAS coding records, using each coder’s author stamp '
    + '— no reshaping.\n'
    + 'Syntax: run builtin-agreement.run {"vars": ["coder_a", "coder_b"], "metric": "nominal"}\n'
    + '  • vars — one column per rater; rows are the units being coded.\n'
    + '  • metric — "nominal" (default) | "ordinal" | "interval" | "ratio"; sets how α '
    + 'weights a disagreement (nominal treats all disagreements alike).\n'
    + '  • weight — κ weighting for exactly 2 raters: "unweighted" (default) | "equal" | "squared".\n'
    + 'Syntax: run builtin-agreement.fromCodings {"metric": "nominal"}',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'agreement-raters',
      title: 'Inter-rater agreement',
      category: 'Scale',
      keywords: ['agreement', 'kappa', 'cohen', 'fleiss', 'krippendorff', 'alpha', 'inter-rater', 'reliability', 'coders', 'raters'],
      needs: ['builtin-agreement'],
      seeAlso: ['agreement-codings', 'reliability-alpha'],
    },
    {
      id: 'agreement-codings',
      title: 'Inter-coder agreement from codings',
      category: 'Scale',
      keywords: ['inter-coder', 'coding', 'caqdas', 'qualitative', 'agreement', 'kappa', 'coders', 'reliability', 'passages'],
      needs: ['builtin-agreement'],
      seeAlso: ['agreement-raters'],
    },
  ],
  rPackages: ['irr'],
  menu: [
    {
      howto: 'agreement-raters',
      label: 'Inter-rater agreement…',
      run: 'run',
      order: 20,
      inputs: [
        {
          name: 'vars',
          kind: 'variables',
          label: 'Rater columns',
          hint: 'One column per rater; each row is a unit they both coded.',
          multiple: true,
        },
        {
          name: 'metric',
          kind: 'choice',
          label: "Krippendorff's α — level of measurement",
          options: ['nominal', 'ordinal', 'interval', 'ratio'],
          default: 'nominal',
        },
        {
          name: 'weight',
          kind: 'choice',
          label: 'κ weighting (2 raters only)',
          options: ['unweighted', 'equal', 'squared'],
          default: 'unweighted',
        },
      ],
    },
    {
      howto: 'agreement-codings',
      label: 'Inter-coder agreement from codings…',
      run: 'fromCodings',
      order: 21,
      inputs: [
        {
          name: 'metric',
          kind: 'choice',
          label: "Krippendorff's α — level of measurement",
          options: ['nominal', 'ordinal'],
          default: 'nominal',
        },
      ],
    },
  ],
};

// --- the variables path -------------------------------------------------------

/**
 * @param {object} app
 * @param {{vars: string[], metric?: string, weight?: string}} inputs
 */
export async function run(app, { vars, metric = 'nominal', weight = 'unweighted' }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Inter-rater agreement needs at least 2 rater columns — one per rater.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const stats = await compute(app, metric, weight);
  await render(app, stats, {
    caption: 'Inter-rater Agreement',
    units: 'rows',
    raters: vars.map((v) => meta.get(v)?.label || v),
    metric,
    weight,
  });
}

// --- the CAQDAS path ----------------------------------------------------------

/**
 * Agreement computed from this project's coding records.
 *
 * **The unit model, stated plainly because it is a judgement and not a fact:** one unit
 * per (document × code), scored 1 if that coder applied that code anywhere in that
 * document and 0 otherwise. This is what mixed-methods papers usually report, and it is
 * the only model that needs no arbitrary parameter.
 *
 * The alternatives are worse defaults, not unavailable: character-overlap agreement
 * needs a threshold nobody agrees on, and segment-level matching needs a rule for what
 * counts as "the same" segment when two coders start a highlight three words apart.
 * Both are defensible for a specific study and neither should be chosen for the user
 * silently, so this reports which model it used and leaves the others for when someone
 * asks for one.
 *
 * @param {object} app
 * @param {{metric?: string}} inputs
 */
export async function fromCodings(app, { metric = 'nominal' } = {}) {
  const segments = await app.items.list('segments');
  if (!segments || !segments.length) {
    await app.results.appendError(
      'No codings in this project yet. Code some passages in the Coding workspace first — '
      + 'agreement is measured between coders, so you also need more than one person’s work.',
    );
    return;
  }

  // Coder identity comes from the record's author stamp (#148), which is why this needs
  // no setup: every segment already knows who made it.
  const coders = [...new Set(segments.map(coderOf).filter(Boolean))].sort();
  if (coders.length < 2) {
    await app.results.appendError(
      `Only one coder (${coders[0] || 'unattributed'}) has coded in this project. Agreement `
      + 'compares two or more coders, so there is nothing to compare yet.',
    );
    return;
  }

  const codes = new Map((await app.items.list('codes')).map((c) => [c.id, c.fields?.name || c.id]));
  const docs = [...new Set(segments.map((s) => String(s.fields?.doc ?? '')).filter((d) => d !== ''))].sort();
  const codeIds = [...new Set(segments.map((s) => String(s.fields?.codeId ?? '')).filter(Boolean))].sort();
  if (!docs.length || !codeIds.length) {
    await app.results.appendError('The coding records carry no document/code references to compare.');
    return;
  }

  // applied[coder][doc\0code] = 1
  const applied = new Map(coders.map((c) => [c, new Set()]));
  for (const s of segments) {
    const c = coderOf(s);
    const doc = String(s.fields?.doc ?? '');
    const code = String(s.fields?.codeId ?? '');
    if (!c || !doc || !code) continue;
    applied.get(c)?.add(`${doc}\0${code}`);
  }

  // One row per (doc × code), one column per coder.
  const rows = [];
  for (const d of docs) for (const k of codeIds) rows.push(coders.map((c) => (applied.get(c).has(`${d}\0${k}`) ? 1 : 0)));

  await bindMatrix(app, rows, coders.length);
  const stats = await compute(app, metric, 'unweighted', { bound: true });
  await render(app, stats, {
    caption: 'Inter-coder Agreement (from codings)',
    units: `${docs.length} document${docs.length === 1 ? '' : 's'} × ${codeIds.length} code${codeIds.length === 1 ? '' : 's'}`,
    raters: coders,
    metric,
    weight: 'unweighted',
    note:
      `**Unit of analysis:** one unit per document × code (${rows.length} in total), scored 1 where a `
      + 'coder applied that code anywhere in that document. Agreement on *whether* a code belongs to a '
      + 'document, not on where the highlight starts. Codes counted: '
      + `${codeIds.map((k) => codes.get(k) || k).slice(0, 12).join(', ')}${codeIds.length > 12 ? ', …' : ''}.`,
  });
}

/** Bind a plain rows×raters matrix into R as `vars` (the shape `compute` expects). */
async function bindMatrix(app, rows, nRaters) {
  const flatVals = [];
  for (let c = 0; c < nRaters; c++) for (const r of rows) flatVals.push(r[c]);
  await app.webr.run(
    `vars <- as.data.frame(matrix(c(${flatVals.join(',')}), nrow = ${rows.length}, ncol = ${nRaters}), `
    + 'stringsAsFactors = FALSE)',
  );
}

// --- shared computation + rendering -------------------------------------------

/**
 * Every coefficient in one R round-trip.
 *
 * `vars` is already bound — by the host for the variables path, by `bindMatrix` for the
 * codings path — so both paths share one implementation and cannot drift.
 */
async function compute(app, metric, weight, { bound = false } = {}) {
  void bound;
  const rCode = `
    d <- as.data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    d <- d[stats::complete.cases(d), , drop = FALSE]   # listwise: a unit only counts if every rater scored it
    n <- nrow(d); k <- ncol(d)
    m <- as.matrix(d)
    pa <- if (n > 0) tryCatch(irr::agree(d)$value, error = function(e) NA_real_) else NA_real_
    # Cohen's kappa for exactly two raters; Fleiss' for three or more. They answer the
    # same question with different chance models, and reporting the wrong one for the
    # number of raters is a common review comment.
    kap <- if (k == 2) tryCatch(irr::kappa2(d, weight = ${JSON.stringify(weight)}), error = function(e) NULL) else
           tryCatch(irr::kappam.fleiss(d), error = function(e) NULL)
    # Krippendorff's alpha wants raters in ROWS.
    al <- tryCatch(irr::kripp.alpha(t(m), method = ${JSON.stringify(metric)}), error = function(e) NULL)
    list(
      n = n, k = k,
      percentAgree = pa,
      kappa = if (is.null(kap)) NA_real_ else as.numeric(kap$value),
      kappaZ = if (is.null(kap) || is.null(kap$statistic)) NA_real_ else as.numeric(kap$statistic),
      kappaP = if (is.null(kap) || is.null(kap$p.value)) NA_real_ else as.numeric(kap$p.value),
      kappaName = if (is.null(kap)) "" else as.character(kap$method),
      alpha = if (is.null(al)) NA_real_ else as.numeric(al$value)
    )`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return flat(result);
}

async function render(app, r, { caption, units, raters, metric, weight, note }) {
  const n = r.num1('n');
  const k = r.num1('k');
  if (!Number.isFinite(n) || n === 0) {
    await app.results.appendError('No units were scored by every rater, so there is nothing to compare.');
    return;
  }
  const kappa = r.num1('kappa');
  const alpha = r.num1('alpha');
  const kappaLabel = k === 2 ? "Cohen's κ" : "Fleiss' κ";

  await app.results.appendTable(
    {
      columns: ['Statistic', 'Value', 'Interpretation'],
      rows: [
        ['Percent agreement', pct(r.num1('percentAgree')), 'Raw — takes no account of agreement by chance'],
        [kappaLabel + (k === 2 && weight !== 'unweighted' ? ` (${weight}-weighted)` : ''), f(kappa, 3), benchmarkKappa(kappa)],
        [`Krippendorff's α (${metric})`, f(alpha, 3), benchmarkAlpha(alpha)],
      ],
      rowHeaders: true,
    },
    { caption },
  );

  await app.results.appendTable(
    {
      columns: ['Raters', 'Units compared', 'Level of measurement'],
      rows: [[raters.join(', '), `${int(n)} ${units}`, metric]],
    },
    { caption: 'What was compared' },
  );

  if (note) await app.results.appendText(note);

  const z = r.num1('kappaZ');
  const p = r.num1('kappaP');
  if (Number.isFinite(p)) {
    await app.results.appendText(
      `κ test against zero: z = ${f(z, 3)}, p = ${fp(p)}. This asks only whether agreement beats chance — `
      + 'a low bar. Report the coefficient itself, not its p-value, as the evidence of reliability.',
    );
  }
  await app.results.appendText(
    "**Reading these.** κ and α correct for chance agreement, so they run below percent agreement and can go "
    + 'negative (worse than chance). Krippendorff’s α is the more conservative and handles missing scores and '
    + 'any number of coders; **α ≥ .800** is the usual publication threshold, with **.667–.800** acceptable only '
    + 'for tentative conclusions (Krippendorff). For κ, Landis & Koch’s labels are conventional but arbitrary — '
    + 'a field with high stakes should want more than "substantial".',
  );
}

// --- helpers ------------------------------------------------------------------

function benchmarkKappa(v) {
  if (!Number.isFinite(v)) return '—';
  if (v < 0) return 'Worse than chance';
  if (v <= 0.20) return 'Slight (Landis & Koch)';
  if (v <= 0.40) return 'Fair';
  if (v <= 0.60) return 'Moderate';
  if (v <= 0.80) return 'Substantial';
  return 'Almost perfect';
}

function benchmarkAlpha(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 0.8) return 'Acceptable for publication (≥ .800)';
  if (v >= 0.667) return 'Tentative conclusions only (.667–.800)';
  return 'Below the usual threshold (< .667)';
}

const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');
