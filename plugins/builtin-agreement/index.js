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
 * Read a collection somebody else owns, through the cross-plugin read path (#196).
 *
 * Finds it by ASKING what is readable rather than naming an owner: `app.items.listFrom`
 * needs an owner token, and hard-coding `builtin` would re-create the privilege this
 * plugin just gave up — it would read CAQDAS's codings and no one else's. A second
 * qualitative plugin that publishes `segments` is then readable on the same terms.
 *
 * When more than one owner publishes the same collection name, the first is taken and the
 * rest are ignored. Deliberately not "merge them": codings from two different plugins are
 * two different coding schemes, and averaging agreement across them would produce a
 * number that describes nothing. `owner` is threaded into the follow-up read so the codes
 * come from the same plugin as the codings.
 *
 * @param {object} app
 * @param {string} collection
 * @param {string} [owner] skip discovery and read this owner (for a second, paired read)
 * @returns {Promise<{records: object[], owner: string|null}>}
 */
async function readPublic(app, collection, owner) {
  if (owner) return { records: (await app.items.listFrom(owner, collection)) ?? [], owner };
  const published = (await app.items.publicCollections?.()) ?? [];
  const match = published.filter((c) => c.collection === collection);
  if (!match.length) return { records: [], owner: null };
  const from = match[0].owner;
  return { records: (await app.items.listFrom(from, collection)) ?? [], owner: from };
}

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
  // Read the codings as ANY plugin would, not as a built-in (#196).
  //
  // This used to be `app.items.list('segments')`, which worked for one reason: every
  // built-in shares the `builtin` owner token, so CAQDAS's records were already "ours".
  // That made reading somebody else's codings a privilege of being shipped by us — the
  // opposite of what #185 decided a plugin's standing should be, and it meant a
  // third-party agreement plugin could not be written at all.
  //
  // CAQDAS now declares these collections `read: 'public'`, and this reads them through
  // the cross-plugin path on exactly the terms a third party gets. So this function is
  // also the proof that the path works: if `listFrom` ever stops returning codings, the
  // built-in that needs them stops working too, rather than silently falling back to a
  // privilege nobody noticed it had.
  const codings = await readPublic(app, 'segments');
  const segments = codings.records;
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

  // Code NAMES come from the same owner as the codings — resolved from the discovery
  // listing rather than assumed, so a different qualitative plugin publishing `segments`
  // and `codes` would be read correctly instead of having CAQDAS's owner hard-coded.
  const codes = new Map(
    (await readPublic(app, 'codes', codings.owner)).records.map((c) => [c.id, c.fields?.name || c.id]),
  );
  const docs = [...new Set(segments.map((s) => String(s.fields?.doc ?? '')).filter((d) => d !== ''))].sort();
  const codeIds = [...new Set(segments.map((s) => String(s.fields?.codeId ?? '')).filter(Boolean))].sort();
  if (!docs.length || !codeIds.length) {
    await app.results.appendError('The coding records carry no document/code references to compare.');
    return;
  }

  // applied[coder][doc\0code] = 1
  const applied = new Map(coders.map((c) => [c, new Set()]));
  // One quote per unit, for the disagreement listing (#202). The FIRST one seen, not a
  // concatenation: the point is to identify which passage is being argued about, and a
  // cell holding three overlapping highlights identifies nothing.
  const quoteOf = new Map();
  for (const s of segments) {
    const c = coderOf(s);
    const doc = String(s.fields?.doc ?? '');
    const code = String(s.fields?.codeId ?? '');
    if (!c || !doc || !code) continue;
    const unit = `${doc}\0${code}`;
    applied.get(c)?.add(unit);
    const q = String(s.fields?.quote ?? '').trim();
    if (q && !quoteOf.has(unit)) quoteOf.set(unit, q);
  }

  // One row per (doc × code), one column per coder.
  const rows = [];
  for (const d of docs) for (const k of codeIds) rows.push(coders.map((c) => (applied.get(c).has(`${d}\0${k}`) ? 1 : 0)));

  // ONE round trip, with the matrix as a prelude rather than a previous call. Each
  // `app.webr.run` is evaluated in a FRESH environment (core/webr-manager.js hands
  // `captureR` an `env` built per call), so an assignment in one call is gone by the
  // next — which is why this used to bind `vars` and then not find it. See `matrixSource`.
  const stats = await compute(app, metric, 'unweighted', {
    prelude: matrixSource(rows, coders.length),
  });
  // Held for the disagreement listing below, which has to run AFTER the coefficients:
  // the coefficient is the reason anyone looked, and a reader who scrolls past a long
  // table to reach the number they came for will not scroll back.
  const disagreements = findDisagreements({ docs, codeIds, coders, applied, codes, quoteOf });
  await render(app, stats, {
    caption: 'Inter-coder Agreement (from codings)',
    // `units` is a NOUN that `render` prefixes with the count ("6 rows" on the variables
    // path). This passed a whole phrase, so the row read "6 3 documents x 2 codes" --
    // visible only from today, because the codings path could never complete before #200.
    // The shape of the grid is already stated in `note` below, where it belongs.
    units: `units (document × code, from ${docs.length} document${docs.length === 1 ? '' : 's'} and ${codeIds.length} code${codeIds.length === 1 ? '' : 's'})`,
    raters: coders,
    metric,
    weight: 'unweighted',
    note:
      `**Unit of analysis:** one unit per document × code (${rows.length} in total), scored 1 where a `
      + 'coder applied that code anywhere in that document. Agreement on *whether* a code belongs to a '
      + 'document, not on where the highlight starts. Codes counted: '
      + `${codeIds.map((k) => codes.get(k) || k).slice(0, 12).join(', ')}${codeIds.length > 12 ? ', …' : ''}.`,
  });
  await renderDisagreements(app, disagreements, { coders, total: rows.length });
}

/**
 * The units the coders did not agree on (#202).
 *
 * **Why this exists at all.** A coefficient says HOW MUCH two coders agree; it does not
 * say WHERE they differed, and the where is the thing a team acts on — it is the input to
 * a coding-scheme revision, and κ alone cannot start that conversation. The data needed
 * no new storage: the (document × code) presence matrix was already being built to
 * compute the coefficient, so the disagreeing units are the rows where the coders differ.
 *
 * **Two kinds of disagreement, kept apart on purpose.** Collapsing them into one
 * "disagreement" count throws away the distinction a revision needs:
 *   - *presence* — one coder applied a code to a document and another did not. The common
 *     case, and usually a question about the code's definition or its boundary.
 *   - *choice* — within the same document, each coder used a code the other did not use
 *     at all. That is not a threshold argument, it is two different readings, and it is
 *     the one worth a conversation.
 *
 * **What this deliberately does not claim.** The unit is the DOCUMENT, not the passage —
 * so "A used *Waiting* here and B used *Neglect*" means within the same document, not
 * necessarily over the same words. Saying "the same passage" would be the easy phrasing
 * and would be wrong, and a reader acting on it would go looking for an overlap that the
 * unit model never established.
 *
 * Exported for `test/agreement-disagreements.test.mjs`: the presence/choice split is
 * real logic with real edge cases (a unit nobody coded, one side holding an extra), and
 * asserting it through a browser run would mean fabricating coders to reach it.
 *
 * @returns {{rows: Array<object>, choices: Array<object>, count: number}}
 */
export function findDisagreements({ docs, codeIds, coders, applied, codes, quoteOf }) {
  const out = [];
  for (const d of docs) {
    for (const k of codeIds) {
      const unit = `${d}\0${k}`;
      const yes = coders.filter((c) => applied.get(c).has(unit));
      // Unanimous either way is agreement. A unit NO ONE coded is not a disagreement
      // either — it is the empty majority of any coding project and listing it would bury
      // the real rows under thousands of blanks.
      if (!yes.length || yes.length === coders.length) continue;
      out.push({
        doc: d,
        code: codes.get(k) || k,
        appliedBy: yes,
        notBy: coders.filter((c) => !yes.includes(c)),
        quote: quoteOf.get(unit) || '',
      });
    }
  }

  // The CHOICE pairs: same document, each coder holding a code the other did not use.
  const choices = [];
  for (const d of docs) {
    const byCoder = new Map(coders.map((c) => [c, codeIds.filter((k) => applied.get(c).has(`${d}\0${k}`))]));
    for (let i = 0; i < coders.length; i++) {
      for (let j = i + 1; j < coders.length; j++) {
        const a = byCoder.get(coders[i]) || [];
        const b = byCoder.get(coders[j]) || [];
        if (!a.length || !b.length) continue;
        const onlyA = a.filter((k) => !b.includes(k));
        const onlyB = b.filter((k) => !a.includes(k));
        // Both sides must hold something the other does not: if only one side has an
        // extra, that is presence (already listed above), not a different reading.
        if (!onlyA.length || !onlyB.length) continue;
        choices.push({
          doc: d,
          pair: [coders[i], coders[j]],
          onlyA: onlyA.map((k) => codes.get(k) || k),
          onlyB: onlyB.map((k) => codes.get(k) || k),
        });
      }
    }
  }
  return { rows: out, choices, count: out.length };
}

/** How many disagreement rows to print before summarising. */
const MAX_DISAGREEMENTS = 200;

/** Render the disagreement listing — the half of reliability a team can act on (#202). */
async function renderDisagreements(app, { rows, choices, count }, { coders, total }) {
  if (!count) {
    await app.results.appendText(
      '**No disagreements.** Every unit was scored the same way by all coders, which is '
      + 'what a κ of 1 means in words.',
    );
    return;
  }

  const shown = rows.slice(0, MAX_DISAGREEMENTS);
  await app.results.appendTable(
    {
      columns: ['Document', 'Code', 'Applied by', 'Did not apply', 'Passage'],
      rows: shown.map((r) => [
        r.doc, r.code, r.appliedBy.join(', '), r.notBy.join(', '),
        // The quote as the coder who applied it stored it. Truncated for the table, which
        // is a review INDEX — the passage itself is in the Coding workspace.
        r.quote.length > 120 ? `${r.quote.slice(0, 120)}…` : r.quote,
      ]),
    },
    { caption: `Disagreements — ${int(count)} of ${int(total)} units` },
  );

  if (count > shown.length) {
    await app.results.appendText(
      `Showing the first ${int(shown.length)} of ${int(count)}. The rest are the same shape; `
      + 'a project with this many disagreements is usually telling you about the scheme '
      + 'rather than about one passage.',
    );
  }

  if (choices.length) {
    await app.results.appendTable(
      {
        columns: ['Document', 'Coders', 'Only the first used', 'Only the second used'],
        rows: choices.slice(0, MAX_DISAGREEMENTS).map((c) => [
          c.doc, c.pair.join(' vs '), c.onlyA.join(', '), c.onlyB.join(', '),
        ]),
      },
      { caption: 'Different codes chosen in the same document' },
    );
    await app.results.appendText(
      '**These are different readings, not boundary arguments**, which is why they are '
      + 'listed apart: each coder used a code the other did not use in that document at '
      + 'all. The unit here is the DOCUMENT, so this does not assert that both coders '
      + 'marked the same words — only that they reached for different codes in the same '
      + 'material.',
    );
  }

  await app.results.appendText(
    `**How to read this.** Each row is one (document × code) unit where ${coders.length === 2
      ? 'the two coders'
      : 'the coders'} did not agree, which is the unit the coefficient above is computed `
    + 'over — so this listing and that number describe exactly the same comparison. The '
    + 'passage shown is the one stored by whoever applied the code; open the document in '
    + 'the Coding workspace to see it in context.',
  );
}

/**
 * R source binding a plain rows×raters matrix as `vars` — the shape {@link compute} wants.
 *
 * **Returns source rather than running it, and that is the bug fix (#200).** This used to
 * be `await app.webr.run('vars <- …')` followed by a separate `compute` call that
 * referenced `vars`, and it could never have worked: `core/webr-manager.js` evaluates every
 * run with `shelter.captureR(prelude + code, { env })` where `env` is built fresh per
 * call, so an `<-` assignment does not outlive the call that made it. The symptom was
 * `Error in eval(expr, env): object 'vars' not found`, and `compute` even took a
 * `{ bound: true }` flag that it discarded with `void bound` — the contract was described
 * and never plumbed.
 *
 * The variables path never hit this because its data arrives as a host-built PRELUDE
 * inside the same evaluation. So this makes the codings path work the same way instead of
 * relying on cross-call state that does not exist.
 *
 * Found by browser-testing #196, and confirmed pre-existing by running the identical
 * scenario against the pre-#196 plugin, which failed the same way. It needs two coders to
 * reach, which is why nobody had.
 */
function matrixSource(rows, nRaters) {
  const flatVals = [];
  for (let c = 0; c < nRaters; c++) for (const r of rows) flatVals.push(r[c]);
  return `vars <- as.data.frame(matrix(c(${flatVals.join(',')}), nrow = ${rows.length}, ncol = ${nRaters}), `
    + 'stringsAsFactors = FALSE)\n';
}

// --- shared computation + rendering -------------------------------------------

/**
 * Every coefficient in one R round-trip.
 *
 * `vars` is bound inside THIS call — by the host's injected prelude for the variables
 * path, by `matrixSource` for the
 * codings path — so both paths share one implementation and cannot drift.
 */
async function compute(app, metric, weight, { prelude = '' } = {}) {
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
  // The prelude goes in the SAME call: see `matrixSource` for why a prior call cannot
  // leave anything behind. Empty for the variables path, whose `vars` the host injects.
  const { result } = await app.webr.run(prelude + rCode);
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
