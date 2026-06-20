/**
 * @file plugins/builtin-bootstrap/index.js
 * Built-in plugin: Resampling ▸ Bootstrap the mean.
 *
 * Resamples a numeric variable with replacement `reps` times, takes each
 * resample's mean, and **emits those means as a new (active) dataset** via
 * `app.data.create` — so you can immediately plot/describe the bootstrap
 * distribution. Also reports the observed mean, bootstrap SE, and a 95%
 * percentile CI. The "analyses are data sources too" pattern.
 *
 * Declarative plugin: the manifest declares the variable + resample-count inputs;
 * the host binds them in R as `x` (a vector) and `reps` (a number).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-bootstrap',
  name: 'Bootstrap',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Resampling',
  keywords: ['resample', 'bootstrap', 'ci', 'confidence'],
  rPackages: [],
  menu: [
    {
      label: 'Bootstrap the mean…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'x', kind: 'variables', types: ['numeric'], multiple: false },
        { name: 'reps', kind: 'number', label: 'Number of resamples', default: 2000 },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{x: string, reps: number}} inputs
 */
export async function run(app, { x: name, reps }) {
  if (!name) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const label = meta.get(name)?.label || name;
  const mv = (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));

  const rCode = `
    ${mv.length ? `x[x %in% c(${mv.map(Number).join(', ')})] <- NA` : ''}
    x <- as.numeric(x); x <- x[is.finite(x)]
    n <- length(x)
    if (n < 2) stop("need at least 2 non-missing values")
    B <- if (is.finite(reps) && reps >= 100) as.integer(min(round(reps), 100000)) else 2000L
    boot <- replicate(B, mean(sample(x, n, replace = TRUE)))
    list(boot = boot, observed = mean(x), se = sd(boot),
         ci_lo = unname(quantile(boot, .025)), ci_hi = unname(quantile(boot, .975)),
         n = n, reps = B)`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = normalizeResult(result);

  // Emit the bootstrap distribution as a new (active) dataset.
  await app.data.create({
    name: `Bootstrap mean of ${name}`,
    variables: [
      { name: 'boot_mean', type: 'numeric', measurementLevel: 'scale', label: `Bootstrap mean of ${label}` },
    ],
    columns: { boot_mean: r.boot },
  });

  const f = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');
  await app.results.appendTable(
    {
      columns: ['N', 'Observed mean', 'Bootstrap SE', '95% CI (percentile)'],
      rows: [[Number.isFinite(r.n) ? Math.round(r.n) : '—', f(r.observed), f(r.se), `[${f(r.ci_lo)}, ${f(r.ci_hi)}]`]],
    },
    { caption: `Bootstrap of the mean — ${label} (${(r.reps || reps).toLocaleString()} resamples)` },
  );
  await app.results.appendText(
    `The ${(r.reps || reps).toLocaleString()} resampled means are now a dataset, **Bootstrap mean of ${name}** ` +
      '(the active dataset). Plot it with **Graphs ▸ Histogram** on `boot_mean`.',
  );
}

// --- helpers -----------------------------------------------------------------

function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const scalar = (v) => {
    const a = arr(v);
    return a.length ? Number(a[0]) : Number(v);
  };
  return {
    boot: arr(byName.boot).map(Number),
    observed: scalar(byName.observed),
    se: scalar(byName.se),
    ci_lo: scalar(byName.ci_lo),
    ci_hi: scalar(byName.ci_hi),
    n: scalar(byName.n),
    reps: scalar(byName.reps),
  };
}
