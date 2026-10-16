/**
 * @file plugins/builtin-inequality/index.js
 * Built-in plugin: **inequality & segregation measures** — distributional /
 * disparity statistics for stratification, economic-sociology, and urban
 * research.
 *
 *  - **Inequality** (`ineq`) — Gini, Theil, Atkinson and the coefficient of
 *    variation for a quantity (income, wealth, firm size), plus a Lorenz curve.
 *  - **Segregation** — the dissimilarity index D, isolation and interaction
 *    indices across spatial units, from two group-count columns (e.g. minority
 *    and majority population per tract). Standard closed-form indices (verified
 *    against the `seg` package).
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, labelOf, metaMap, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-inequality',
  name: 'Inequality & segregation',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['inequality', 'gini', 'theil', 'atkinson', 'lorenz', 'segregation', 'dissimilarity', 'isolation', 'disparity', 'concentration'],
  disciplines: ['Economics', 'Sociology', 'Ethnic Studies', 'Public Policy & Administration', 'Social Science'],
  howto:
    'GUI: Descriptive Statistics ▸ Inequality (Gini / Theil / Lorenz)… or Segregation indices…, then pick the variable(s). You get the indices plus a Lorenz curve.\n' +
    'Syntax: run builtin-inequality.inequality {"x": "income"}\n' +
    '  • inequality: x — non-negative quantity (Gini, Theil, Atkinson, CV + Lorenz curve).\n' +
    'Syntax: run builtin-inequality.segregation {"groupA": "minority", "groupB": "majority"}\n' +
    '  • segregation: groupA / groupB — per-unit group counts (dissimilarity, isolation, interaction).',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'inequality-indices',
      title: 'Inequality (Gini / Theil / Lorenz)',
      category: 'Descriptive Statistics',
      keywords: ['inequality', 'gini', 'theil', 'atkinson', 'lorenz', 'income', 'distribution', 'concentration', 'dispersion'],
      needs: ['builtin-inequality'],
      seeAlso: ['inequality-segregation', 'descriptives-basics'],
    },
    {
      id: 'inequality-segregation',
      title: 'Segregation indices',
      category: 'Descriptive Statistics',
      keywords: ['segregation', 'dissimilarity', 'isolation', 'interaction', 'index', 'neighbourhood', 'spatial', 'groups'],
      needs: ['builtin-inequality'],
      seeAlso: ['inequality-indices', 'spatial-autocorrelation'],
    },
  ],
  // No svglite: the Lorenz curve is a chart MODEL now, drawn by the host, so this
  // plugin asks R for numbers and never for a picture.
  rPackages: ['ineq'],
  menu: [
    {
      howto: 'inequality-indices',
      label: 'Inequality (Gini / Theil / Lorenz)…',
      run: 'inequality',
      order: 50,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Quantity (e.g. income; non-negative)', hint: 'The amount per case whose spread you want to measure.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      howto: 'inequality-segregation',
      label: 'Segregation indices…',
      run: 'segregation',
      order: 55,
      inputs: [
        { name: 'groupA', kind: 'variables', label: 'Group A count per unit', hint: 'Headcount of the first group in each area or unit.', multiple: false, types: ['numeric'], unique: true },
        { name: 'groupB', kind: 'variables', label: 'Group B count per unit', hint: 'Headcount of the second group in each area or unit.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
  ],
};

// --- Inequality --------------------------------------------------------------

export async function inequality(app, { x: xName }) {
  if (!xName) { await app.results.appendError('Inequality: choose a numeric quantity.'); return; }
  await app.webr.installPackages(['ineq']);
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    suppressMessages(library(ineq))
    v <- as.numeric(x); v <- v[is.finite(v) & v >= 0]
    g <- Gini(v); th <- Theil(v); at <- Atkinson(v, parameter = 0.5); cv <- sd(v) / mean(v)
    # The curve IS these two vectors. It used to be drawn here and the numbers discarded.
    lc <- Lc(v)
    list(gini = g, theil = th, atkinson = at, cv = cv, n = length(v), mean = mean(v),
         lp = as.numeric(lc$p), lq = as.numeric(lc$L))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['Measure', 'Value'],
      rows: [
        ['Gini coefficient', f(r.num1('gini'), 4)],
        ['Theil index', f(r.num1('theil'), 4)],
        ['Atkinson (ε = 0.5)', f(r.num1('atkinson'), 4)],
        ['Coefficient of variation', f(r.num1('cv'), 4)],
      ],
      rowHeaders: true,
    },
    { caption: `Inequality — ${labelOf(meta.get(xName), xName)} (N = ${r.num1('n')}, mean = ${f(r.num1('mean'), 2)})` },
  );
  // A chart model rather than a baked SVG, so the figure keeps its data: the title,
  // legend and plot are separately editable layers, the curve can be recoloured or shown
  // as points, and all of it survives a reload without re-running R.
  const px = r.nums('lp');
  const py = r.nums('lq');
  if (px.length && px.length === py.length) {
    await app.results.appendChart({
      kind: 'scatter',
      title: 'Lorenz curve',
      points: px.map((xv, i) => ({ x: xv, y: py[i] })),
      // Not a cloud of observations: these points are one continuous curve, and as dots
      // the shape — which is the finding — disappears.
      line: true,
      // The 45-degree line is what the plot MEANS, not a finding about the data, which is
      // exactly the distinction `reference` carries (grey, dashed, behind, no equation).
      reference: { slope: 1, intercept: 0, label: 'Line of equality' },
      axes: {
        x: { title: 'Cumulative share of population' },
        y: { title: 'Cumulative share of quantity' },
      },
    });
  }
  await app.results.appendText(
    'All indices are 0 at perfect equality and rise with inequality (**Gini** 0–1 is the share of the area above the Lorenz curve; **Theil** and **Atkinson** are entropy/welfare-based and decomposable). The **Lorenz curve** plots cumulative quantity against cumulative population — the further it bows below the 45° line, the more unequal.',
  );
}

// --- Segregation -------------------------------------------------------------

export async function segregation(app, { groupA: aName, groupB: bName }) {
  if (!aName || !bName) { await app.results.appendError('Segregation: choose two group-count columns (one row per spatial unit).'); return; }
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    A <- as.numeric(groupA); B <- as.numeric(groupB)
    ok <- is.finite(A) & is.finite(B) & (A + B) > 0; A <- A[ok]; B <- B[ok]
    TA <- sum(A); TB <- sum(B); Tot <- TA + TB
    D <- 0.5 * sum(abs(A / TA - B / TB))
    iso <- sum((A / TA) * (A / (A + B)))        # isolation of A (xPx)
    inter <- sum((A / TA) * (B / (A + B)))       # interaction A with B (xPy)
    # Gini index of segregation
    p <- A / (A + B); tt <- A + B
    Gseg <- sum(outer(tt, tt) * abs(outer(p, p, "-"))) / (2 * Tot^2 * (TA / Tot) * (1 - TA / Tot))
    list(D = D, iso = iso, inter = inter, gseg = Gseg, nUnits = length(A), TA = TA, TB = TB)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['Index', 'Value'],
      rows: [
        ['Dissimilarity (D)', f(r.num1('D'), 4)],
        ['Gini segregation', f(r.num1('gseg'), 4)],
        [`Isolation (${labelOf(meta.get(aName), aName)})`, f(r.num1('iso'), 4)],
        [`Interaction (A with B)`, f(r.num1('inter'), 4)],
      ],
      rowHeaders: true,
    },
    { caption: `Segregation — ${labelOf(meta.get(aName), aName)} vs ${labelOf(meta.get(bName), bName)} (${r.num1('nUnits')} units; totals ${r.num1('TA')} / ${r.num1('TB')})` },
  );
  await app.results.appendText(
    '**Dissimilarity (D)** is the share of one group that would have to move to even out the distribution (0 = even, 1 = complete segregation; > .6 is high). **Isolation** is the average own-group share in the typical A-member\'s unit; **interaction** is the average exposure to group B. Indices depend on the spatial unit (the modifiable areal unit problem).',
  );
}

// --- helpers -----------------------------------------------------------------
