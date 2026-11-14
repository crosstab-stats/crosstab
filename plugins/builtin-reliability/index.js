/**
 * @file plugins/builtin-reliability/index.js
 * Built-in plugin: Scale ▸ Reliability analysis — Cronbach's α for a set of
 * scale items. The first thing a survey researcher reaches for.
 *
 * Computed with `psych::alpha` (installed on demand); rendered SPSS-style: overall
 * Cronbach's α (raw + standardized), and per-item statistics — corrected
 * item-total correlation and "α if item deleted".
 * (Reverse-keyed items aren't auto-flipped; recode them first via Transform.)
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, rounded: int, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-reliability',
  name: 'Reliability Analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Scale',
  keywords: ['cronbach', 'alpha', 'reliability', 'scale', 'internal consistency', 'items'],
  disciplines: ['Psychology', 'Education', 'Communication', 'Sociology', "Women's & Gender Studies", 'Liberal Studies'],
  howto:
    'GUI: Scale ▸ Reliability analysis, then pick the scale items (2+). ' +
    "You get Cronbach's α (raw + standardized), McDonald's ω, and per-item statistics (item-total r, α if deleted).\n" +
    'Syntax: run builtin-reliability.run {"vars": ["q1", "q2", "q3"]}\n' +
    '  • vars — the numeric scale items expected to measure one construct.' +
    '\n' +
    '  • plots — optional, and nothing is drawn unless you ask. The dialog lists\n'
    + '    what this analysis offers; every chart arrives live, with its error bars,\n'
    + '    marks and palette as controls on the chart itself.',

  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'reliability-alpha',
      title: 'Reliability analysis',
      category: 'Scale',
      keywords: ['reliability', 'cronbach', 'alpha', 'internal consistency', 'scale', 'items', 'item total', 'if deleted'],
      needs: ['builtin-reliability'],
      seeAlso: ['factor-analysis', 'agreement-raters'],
    },
  ],
  rPackages: ['psych'],
  menu: [
    {
      howto: 'reliability-alpha',
      label: 'Reliability analysis…',
      run: 'run',
      order: 10,
      inputs: [{ name: 'vars', kind: 'variables', label: 'Scale items', hint: 'The survey items expected to measure one construct.', multiple: true, types: ['numeric'] },
        {
          name: 'plots',
          kind: 'choice',
          label: 'Plots',
          hint: 'Tick the charts you want beside the tables.',
          multiple: true,
          optional: true,
          options: [
            { value: 'items', label: 'Item-total correlations' },
            { value: 'drop', label: 'Alpha if item deleted' },
          ],
          default: [],
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function run(app, { vars, plots }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Reliability needs at least 2 items.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const rCode = `
    d <- as.data.frame(lapply(vars, function(c) suppressWarnings(as.numeric(c))), check.names = FALSE)
    a <- psych::alpha(d, warnings = FALSE, check.keys = FALSE)
    # McDonald's omega (total) from a single-factor congeneric model. Needs >= 3
    # items to identify the factor; suppress its plotting/printing noise.
    om <- if (ncol(d) >= 3) tryCatch(
      suppressWarnings(suppressMessages(psych::omega(d, nfactors = 1, plot = FALSE, flow = FALSE))),
      error = function(e) NULL) else NULL
    list(
      alpha = a$total$raw_alpha, stdAlpha = a$total$std.alpha,
      omegaTot = if (is.null(om)) NA_real_ else as.numeric(om$omega.tot),
      gSix = a$total$"G6(smc)",
      nItems = ncol(d), nCases = sum(stats::complete.cases(d)),
      items = colnames(d), itemMean = a$item.stats[, "mean"], itemSD = a$item.stats[, "sd"],
      itemR = a$item.stats[, "r.drop"], alphaDrop = a$alpha.drop[, "raw_alpha"]
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  const omega = r.num1('omegaTot');
  await app.results.appendTable(
    {
      columns: ["Cronbach's α", "Cronbach's α (standardized)", "McDonald's ω", 'N of Items', 'N'],
      rows: [[f(r.num1('alpha'), 3), f(r.num1('stdAlpha'), 3), f(omega, 3), int(r.num1('nItems')), int(r.num1('nCases'))]],
    },
    { caption: 'Reliability Statistics' },
  );
  if (Number.isFinite(omega)) {
    await app.results.appendText(
      "**McDonald's ω** (total) doesn't assume every item contributes equally (tau-equivalence), so it's usually preferred over α when item loadings differ. Values are interpreted on the same scale (≥ .70 acceptable, ≥ .80 good).",
    );
  }

  const items = r.strs('items');
  await app.results.appendTable(
    {
      columns: ['Item', 'Mean', 'SD', 'Corrected Item-Total Correlation', "Cronbach's α if Item Deleted"],
      rows: items.map((it, i) => [
        label(meta, it),
        f(r.nums('itemMean')[i], 3),
        f(r.nums('itemSD')[i], 3),
        f(r.nums('itemR')[i], 3),
        fAlpha(r.nums('alphaDrop')[i]),
      ]),
      rowHeaders: true,
    },
    { caption: 'Item-Total Statistics' },
  );

  const wantRel = new Set([].concat(plots ?? []));
  if (wantRel.size) {
    const itemNames = r.strs('items');
    const itemLabels = itemNames.map((n) => meta.get(n)?.label || n);
    if (wantRel.has('items')) {
      // Scale development is iterative, and this is the figure you scan to decide what to
      // drop: the items correlating least with the rest of the scale are the ones not
      // measuring what the others are. The .30 line is the convention, drawn as a guide
      // rather than left in a footnote.
      await app.results.appendChart({
        kind: 'categorical',
        title: 'Corrected item-total correlation',
        categories: itemLabels.map((lab, i) => ({ key: `i${i}`, label: lab })),
        series: [{ key: 'r', label: 'r (item vs rest)', values: r.nums('itemR') }],
        axes: { x: { title: 'Item' }, y: { title: 'Correlation' } },
        guides: [{ axis: 'y', at: 0.3, label: 'Conventional floor (.30)' }],
        view: { mark: 'bar', legend: 'none' },
      });
    }
    if (wantRel.has('drop')) {
      // The alpha the scale WOULD have without each item, against the alpha it has: a bar
      // above the line is an item whose removal would improve the scale.
      await app.results.appendChart({
        kind: 'categorical',
        title: 'Alpha if item deleted',
        categories: itemLabels.map((lab, i) => ({ key: `i${i}`, label: lab })),
        series: [{ key: 'a', label: 'Alpha without this item', values: r.nums('alphaDrop') }],
        axes: { x: { title: 'Item' }, y: { title: 'Alpha' } },
        guides: [{ axis: 'y', at: r.num1('alpha'), label: 'Alpha of the full scale' }],
        view: { mark: 'bar', legend: 'none' },
      });
    }
  }
}

// --- helpers -----------------------------------------------------------------

function label(meta, name) {
  return meta.get(name)?.label || name;
}
/** Alpha can't exceed 1; psych's "if deleted" is degenerate for a 2-item scale. */
const fAlpha = (x) => (Number.isFinite(x) && x <= 1.0001 ? x.toFixed(3) : '—');
