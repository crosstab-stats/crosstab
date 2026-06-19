/**
 * @file plugins/builtin-bootstrap/index.js
 * Built-in plugin: Analyze ▸ Resample ▸ Bootstrap the mean.
 *
 * The first analysis that **emits a derived dataset** rather than only rendering
 * output. It resamples a numeric variable with replacement `B` times, takes the
 * mean of each resample, and hands the engine those `B` bootstrap means as a new
 * dataset via `app.data.create` — which becomes the active dataset, so you can
 * immediately plot its distribution (Graphs ▸ Histogram) or describe it. It also
 * prints the observed mean, bootstrap SE, and a 95% percentile CI to the Output.
 *
 * This is the "analyses are data sources too" pattern: the bootstrap distribution
 * didn't exist in the source, but it's now a first-class dataset every other tool
 * (plots, descriptives, export) can consume.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-bootstrap',
  name: 'Bootstrap',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Resampling',
  keywords: ['resample', 'bootstrap', 'ci', 'confidence'],
  rPackages: [], // base R (sample/replicate/quantile)
};

/** @param {object} app */
export async function activate(app) {
  await app.menus.register({
    id: 'builtin-bootstrap:mean',
    path: ['Analyze', 'Resample'],
    label: 'Bootstrap the mean…',
    order: 10,
    command: () => openBootstrap(app),
  });
}

async function openBootstrap(app) {
  const chosen = await app.ui.selectVariables({
    title: 'Bootstrap the mean',
    hint: 'Choose a numeric variable to resample.',
    multiple: false,
    types: ['numeric'],
  });
  if (!chosen?.length) return;
  const form = await app.ui.showForm({
    title: 'Bootstrap the mean',
    hint: `Resample “${chosen[0]}” with replacement and take the mean each time.`,
    okLabel: 'Run',
    fields: [{ name: 'reps', label: 'Number of resamples', type: 'number', value: '2000' }],
  });
  if (!form) return;
  let reps = Math.round(Number(form.reps));
  if (!Number.isFinite(reps) || reps < 100) reps = 2000;
  reps = Math.min(reps, 100000);
  await runBootstrap(app, chosen[0], reps);
}

/**
 * @param {object} app
 * @param {string} name
 * @param {number} reps
 */
async function runBootstrap(app, name, reps) {
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Bootstrap' });
  await app.results.beginSection('Bootstrap the mean');

  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const label = meta.get(name)?.label || name;
  const missing = (meta.get(name)?.missingValues ?? []).map(rlit).join(', ');

  try {
    const R = `
      ${missing ? `df[[${rlit(name)}]][df[[${rlit(name)}]] %in% c(${missing})] <- NA` : ''}
      x <- as.numeric(df[[${rlit(name)}]]); x <- x[is.finite(x)]
      n <- length(x)
      if (n < 2) stop("need at least 2 non-missing values")
      boot <- replicate(${reps}, mean(sample(x, n, replace = TRUE)))
      list(
        boot     = boot,
        observed = mean(x),
        se       = sd(boot),
        ci_lo    = unname(quantile(boot, 0.025)),
        ci_hi    = unname(quantile(boot, 0.975)),
        n        = n
      )`;
    const { result } = await app.webr.run(R, { injectData: true, variables: [name] });
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

    await app.results.appendTable(renderSummary(r, label, reps));
    await app.results.appendText(
      `The ${reps.toLocaleString()} resampled means are now a dataset, **Bootstrap mean of ${name}** ` +
        `(it’s the active dataset). Plot it with **Graphs ▸ Histogram** on \`boot_mean\`.`,
    );
  } catch (err) {
    await app.results.appendError(`Bootstrap failed: ${err.message}`);
    console.error(err);
  }
  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Bootstrap' });
}

/** @param {any} rList */
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
  };
}

/**
 * @param {ReturnType<typeof normalizeResult>} r
 * @param {string} label
 * @param {number} reps
 * @returns {string} HTML
 */
function renderSummary(r, label, reps) {
  const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');
  return `
    <table class="ct-desc">
      <caption>Bootstrap of the mean — ${esc(label)} (${reps.toLocaleString()} resamples)</caption>
      <thead>
        <tr>
          <th scope="col">N</th><th scope="col">Observed mean</th>
          <th scope="col">Bootstrap SE</th><th scope="col">95% CI (percentile)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${Number.isFinite(r.n) ? Math.round(r.n) : '—'}</td>
          <td>${f(r.observed)}</td>
          <td>${f(r.se)}</td>
          <td>[${f(r.ci_lo)}, ${f(r.ci_hi)}]</td>
        </tr>
      </tbody>
    </table>`;
}

/** HTML-escape text content. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a JS value as an R literal for safe interpolation into R source. */
function rlit(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
