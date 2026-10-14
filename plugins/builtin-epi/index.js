/**
 * @file plugins/builtin-epi/index.js
 * Built-in plugin: **epidemiological measures** for a 2×2 exposure-by-outcome
 * table — the effect measures clinical/public-health and program-evaluation work
 * report instead of (or alongside) a chi-square: **risk ratio**, **odds ratio**,
 * **risk difference**, **number needed to treat/harm (NNT)**, and the
 * **attributable fraction**, each with a 95% confidence interval.
 *
 * Computed with the standard closed-form (Wald) formulas; verified against
 * epitools::riskratio / oddsratio.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, ci, labelOf, metaMap, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-epi',
  name: 'Epidemiological measures',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Categorical',
  keywords: ['epidemiology', 'risk ratio', 'relative risk', 'odds ratio', 'risk difference', 'nnt', 'number needed to treat', 'attributable', 'rr', 'or'],
  disciplines: ['Public Health', 'Nutrition, Food & Dietetics', 'Gerontology'],
  howto:
    'GUI: Categorical ▸ Risk / odds ratios (2×2)…, then pick a binary exposure and a binary outcome. You get the 2×2 table plus RR, OR, risk difference, NNT/NNH and attributable fraction with 95% CIs.\n' +
    'Syntax: run builtin-epi.run {"exposure": "treated", "outcome": "relapse"}\n' +
    '  • exposure — binary exposure/treatment (1 = exposed).\n' +
    '  • outcome — binary outcome (1 = case/event).',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'epi-measures',
      title: 'Risk and odds ratios (2×2)',
      category: 'Categorical',
      keywords: ['risk ratio', 'relative risk', 'odds ratio', 'rr', 'or', 'nnt', 'nnh', 'attributable fraction', 'risk difference', 'epidemiology', '2x2'],
      needs: ['builtin-epi'],
      seeAlso: ['categorical-twoprop', 'logistic-binary'],
    },
  ],
  rPackages: [],
  menu: [
    {
      howto: 'epi-measures',
      label: 'Risk / odds ratios (2×2)…',
      run: 'run',
      order: 60,
      inputs: [
        { name: 'exposure', kind: 'variables', label: 'Exposure / treatment', hint: 'The yes/no exposure or treatment whose effect you want.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'exposed', kind: 'level', of: 'exposure', preferLast: true, label: 'Which category is EXPOSED?', hint: 'Every measure below is the effect of being in this category. With 1 = Yes / 2 = No coding, pick Yes — otherwise the risk ratio describes the effect of being unexposed.' },
        { name: 'outcome', kind: 'variables', label: 'Outcome', hint: 'The yes/no outcome marking who became a case.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'case', kind: 'level', of: 'outcome', preferLast: true, label: 'Which category is a CASE?', hint: 'The outcome you are counting — the event, illness or relapse, rather than its absence.' },
      ],
    },
  ],
};

export async function run(app, { exposure: expName, outcome: outName, exposed, case: caseLevel }) {
  if (!expName || !outName) {
    await app.results.appendError('Choose an exposure variable and an outcome variable (both binary).');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  // The chosen positive levels, inlined as R string literals. `NULL` means an older
  // recorded script that predates the picker: R then falls back to the higher of the
  // two observed codes, which is what this plugin always did, so old logs replay to the
  // same numbers (#186). What changes for them is that the LABELS now name the level
  // actually used instead of asserting the code literal '1'.
  const want = (v) => (v != null && v !== '' ? JSON.stringify(String(v)) : 'NULL');
  const rCode = `
    ${BIN01_R}
    e <- bin01(exposure, ${want(exposed)}); o <- bin01(outcome, ${want(caseLevel)})
    ok <- !is.na(e) & !is.na(o); e <- e[ok]; o <- o[ok]
    a <- sum(e == 1 & o == 1); b <- sum(e == 1 & o == 0)
    cc <- sum(e == 0 & o == 1); dd <- sum(e == 0 & o == 0)
    # Hand back the levels the RECODE used, so the table is labelled from the same
    # decision rather than from a literal. This is the whole fix for #186: there is now
    # exactly one place where "which category is positive" is decided.
    list(a = a, b = b, c = cc, d = dd, n = length(e),
         expPos = attr(e, "pos"), expNeg = attr(e, "neg"),
         outPos = attr(o, "pos"), outNeg = attr(o, "neg"))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const a = r.num1('a'), b = r.num1('b'), c = r.num1('c'), d = r.num1('d');
  if ([a, b, c, d].some((x) => !Number.isFinite(x)) || a + b === 0 || c + d === 0) {
    await app.results.appendError('Need a complete 2×2 table — make sure both variables are binary with cases in each group.');
    return;
  }

  // Labels come from the levels the RECODE reported, never from a code literal.
  // The absent case renders `?`. This plugin's own `str` accessor returned null for a
  // missing factor attribute while the shared `str1` returns '', so the guard tests
  // both rather than relying on which one it is. Not `!code`: a level code of "0" is
  // falsy-looking and must still be looked up.
  const lv = (m, code) => (code == null || code === '' ? '?' : meta.get(m)?.valueLabels?.[code] ?? code);
  const expLab = labelOf(meta.get(expName), expName), outLab = labelOf(meta.get(outName), outName);
  const expPos = r.str1('expPos'), expNeg = r.str1('expNeg');
  const outPos = r.str1('outPos'), outNeg = r.str1('outNeg');

  // 2x2 counts table.
  await app.results.appendTable(
    {
      columns: [`${expLab} \\ ${outLab}`, `${lv(outName, outPos)} (case)`, `${lv(outName, outNeg)} (non-case)`, 'Total'],
      rows: [
        [`${lv(expName, expPos)} (exposed)`, String(a), String(b), String(a + b)],
        [`${lv(expName, expNeg)} (unexposed)`, String(c), String(d), String(c + d)],
        ['Total', String(a + c), String(b + d), String(a + b + c + d)],
      ],
      rowHeaders: true,
    },
    { caption: `2×2 Table — ${expLab} × ${outLab} (N = ${r.num1('n')})` },
  );

  const re = a / (a + b), ru = c / (c + d);
  const rr = re / ru;
  const seLogRr = Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d));
  const or = (a * d) / (b * c);
  const seLogOr = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const rd = re - ru;
  const seRd = Math.sqrt((re * (1 - re)) / (a + b) + (ru * (1 - ru)) / (c + d));
  const nnt = 1 / Math.abs(rd);
  const af = (rr - 1) / rr; // attributable fraction among exposed

  await app.results.appendTable(
    {
      columns: ['Measure', 'Estimate', '95% CI'],
      rows: [
        ['Risk in exposed', pct(re), ''],
        ['Risk in unexposed', pct(ru), ''],
        ['Risk ratio (RR)', f(rr, 3), ci(Math.exp(Math.log(rr) - 1.96 * seLogRr), Math.exp(Math.log(rr) + 1.96 * seLogRr))],
        ['Odds ratio (OR)', f(or, 3), ci(Math.exp(Math.log(or) - 1.96 * seLogOr), Math.exp(Math.log(or) + 1.96 * seLogOr))],
        ['Risk difference (RD)', f(rd, 4), ci(rd - 1.96 * seRd, rd + 1.96 * seRd)],
        [`${rd < 0 ? 'NNT (benefit)' : 'NNH (harm)'}`, f(nnt, 1), ''],
        ['Attributable fraction (exposed)', pct(af), ''],
      ],
      rowHeaders: true,
    },
    {
      caption: `Effect Measures — exposed = ${lv(expName, expPos)}, case = ${lv(outName, outPos)}`,
    },
  );
  await app.results.appendText(
    '**RR** and **OR** > 1 mean exposure raises the outcome; **RD** is the absolute risk change; **NNT/NNH** = 1/|RD| is how many exposed for one extra (averted) case. RR and risk difference are interpretable only with cohort/experimental sampling; in case-control designs use the OR. CIs are Wald.',
  );
}

// --- helpers -----------------------------------------------------------------

// Recode to 0/1 against a NAMED positive level, and carry the two level names back on
// the result. Both halves matter: the caller labels from `pos`/`neg` rather than from
// the literal codes '1'/'0', so the printed table cannot disagree with the arithmetic
// it describes (#186). `want` NULL keeps the old rule — the higher of the two codes.
const BIN01_R = `bin01 <- function(v, want = NULL){
  ch <- as.character(v); u <- sort(unique(ch[!is.na(ch)]))
  if (length(u) != 2) return(structure(rep(NA_integer_, length(v)), pos = NA_character_, neg = NA_character_))
  pos <- if (!is.null(want) && want %in% u) want else u[2]
  neg <- u[u != pos][1]
  structure(as.integer(ch == pos), pos = pos, neg = neg) }`;

function pct(x) { return Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—'; }
