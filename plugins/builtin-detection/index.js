/**
 * @file plugins/builtin-detection/index.js
 * Built-in plugin: **detection-corrected abundance** — the estimators that answer
 * "how many are there?" when you know you did not see them all.
 *
 * Two method families, one premise. **Distance sampling** (`mrds`) models how
 * detectability falls off with distance from a line or a point, then corrects the raw
 * count by the area it effectively searched. **Occupancy and N-mixture models**
 * use repeated visits to the same sites to separate "absent" from "present
 * and missed", estimating site occupancy or local abundance alongside detection
 * probability.
 *
 * ## Why this is not inside `builtin-ecology`
 *
 * A plugin's `category` is both its section in the manager and its top-level menu — the
 * host owns placement and a plugin cannot vary it per item. `builtin-ecology` is filed
 * under **Multivariate**, which is right for diversity indices and NMDS and wrong for a
 * detection function. Filing these here under **Ecology** puts each family where it
 * belongs, and has a second benefit: `rPackages` installs on first *invoke*, so someone
 * who only runs a diversity index never pays for `mrds`.
 *
 * ## Why occupancy is hand-rolled and distance sampling is not
 *
 * **`unmarked` does not exist on WebR.** It is listed in repo.r-wasm.org's PACKAGES
 * index at 1.5.2, and its wasm binary is a 403 — checked for R 4.4 and 4.5, against
 * `mrds_3.0.1.tgz` and its own dependency `reformulas_0.4.1.tgz` as controls, both 200.
 * Every dependency installs; only the package itself does not, and
 * `webr::install("unmarked")` returns *successfully* having installed nothing. So reading
 * the index settles the dependency CLOSURE and does not establish that a package exists.
 *
 * Both occupancy likelihoods are short, published and fully specified, so they are
 * computed here in base R rather than shipped as a menu item that always errors:
 * **MacKenzie et al. 2002** for single-season occupancy, **Royle 2004** for the N-mixture
 * model, each maximised with `optim` and standard errors from the numerical Hessian.
 *
 * Validated against `unmarked` on local R 4.6.0, which is the rule for anything
 * hand-rolled. Occupancy comes out IDENTICAL to ten decimal places — psi 0.8000000207,
 * p 0.5000000078, AIC 43.46002813 and both standard errors. The N-mixture AIC agrees to
 * seven decimals (91.0785981 vs 91.0785979) with lambda 1.9e-4 apart, which is optimiser
 * tolerance rather than a different likelihood: an identical AIC on a different surface
 * is not a thing that happens.
 *
 * ## The shared-object budget
 *
 * WebR tolerates roughly twenty loaded shared objects and its failures do not name the
 * package that caused them, so this was measured against the binary repo's index before
 * anything was written: `mrds` resolves to 17 packages / **8 `.so`**, which with
 * `svglite` and `builtin-ecology`'s `vegan` leaves plenty of room. Hand-rolling the
 * occupancy half removed a further 6 that `unmarked` would have cost.
 *
 * The `Distance` package was rejected on the same measurement. It is a convenience
 * wrapper over `mrds` and costs 17 `.so` by itself, nine of them a tidyverse chain that
 * computes nothing here.
 *
 * ## What was verified against the authority before this was written
 *
 * Against `mrds` 3.0.1 and `unmarked` on local R 4.6.0, because guessing at an API is
 * how a wrapper ends up confidently wrong:
 *  - A `dsmodel` built from a STRING and parsed with `as.formula` fits for all three
 *    keys. It has to be a string: the key is an input, and a literal formula would
 *    capture the symbol `key` rather than its value, since `mrds` parses the formula
 *    instead of evaluating it.
 *  - `ddf` fits ONE observation without complaint, returning a detection function
 *    estimated from a single number. The sample-size floor therefore has to be ours.
 *  - A bare `unif` key fits and reports p = 1 — a flat detection function, i.e. "you saw
 *    everything", which is the assumption the whole analysis exists to avoid. It is
 *    offered only with a cosine adjustment term, which is the standard third CDS model.
 *  - `fit$fitted` is constant with no covariates, so `[1]` is the average detection
 *    probability.
 *  - `detfct` is exported but evaluates against the DESIGN MATRICES, which carry one row
 *    per observation — so a grid call recycles, returning the right values repeated n
 *    times. `plot.ds` shows the fix, which is to replicate those rows to the grid's
 *    length first; that is what this plugin does, and it returns exactly as many values
 *    as the grid has for all three keys (the half-normal matching exp(-x^2/2sigma^2) to
 *    five decimals).
 */

/** The host's reporting formatters, from core/plugin-stdlib.js. */
const { fixed: f, ci, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-detection',
  name: 'Detection & abundance',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Ecology',
  keywords: ['distance sampling', 'detection function', 'detectability', 'abundance',
    'density', 'transect', 'line transect', 'point count', 'occupancy', 'n-mixture',
    'mrds', 'wildlife', 'survey', 'half-normal', 'hazard rate',
    'effective strip width', 'imperfect detection', 'camera trap'],
  disciplines: ['Ecology', 'Wildlife Biology', 'Environmental Studies', 'Anthropology'],
  howto:
    'GUI: Ecology ▸ Distance sampling… fits a detection function to distances measured from a line or point, and reports density/abundance if you give it the survey effort.\n'
    + 'GUI: Ecology ▸ Occupancy / N-mixture… takes one column per repeat visit and separates "absent" from "present but missed".\n'
    + 'Syntax: run builtin-detection.distance {"dist": ["perp_m"], "shape": "line", "key": "hn", "truncation": 0, "effort": 50, "area": 1000}\n'
    + 'Syntax: run builtin-detection.occupancy {"visits": ["v1", "v2", "v3"], "model": "occu", "kmax": 0}\n'
    + '  • Both print the uncorrected figure beside the corrected one, because the gap between them is the result.',
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'detection-distance',
      title: 'Distance sampling (line and point transects)',
      category: 'Ecology',
      keywords: ['distance sampling', 'detection function', 'half-normal', 'hazard rate',
        'effective strip width', 'esw', 'edr', 'line transect', 'point transect',
        'density', 'abundance', 'truncation', 'mrds', 'detectability'],
      needs: ['builtin-detection'],
      seeAlso: ['detection-occupancy', 'ecology-diversity'],
    },
    {
      id: 'detection-occupancy',
      title: 'Occupancy and N-mixture models',
      category: 'Ecology',
      keywords: ['occupancy', 'psi', 'detection probability', 'n-mixture', 'pcount',
        'repeat visits', 'naive occupancy', 'false absence', 'camera trap',
        'acoustic', 'site', 'closure', 'mackenzie', 'royle'],
      needs: ['builtin-detection'],
      seeAlso: ['detection-distance', 'ecology-diversity'],
    },
  ],
  rPackages: ['mrds'],
  menu: [
    {
      howto: 'detection-distance',
      label: 'Distance sampling…',
      run: 'distance',
      order: 10,
      inputs: [
        { name: 'dist', kind: 'variables', label: 'Distance from the line or point', hint: 'One numeric column, one row per detected object.', types: ['numeric'] },
        {
          name: 'shape',
          kind: 'choice',
          label: 'Survey shape',
          default: 'line',
          options: [
            { value: 'line', label: 'Line transect (perpendicular distance)' },
            { value: 'point', label: 'Point transect (radial distance)' },
          ],
        },
        {
          name: 'key',
          kind: 'choice',
          label: 'Detection function',
          default: 'hn',
          options: [
            { value: 'hn', label: 'Half-normal' },
            { value: 'hr', label: 'Hazard-rate' },
            { value: 'unifcos', label: 'Uniform with cosine adjustment' },
          ],
        },
        { name: 'truncation', kind: 'number', label: 'Truncation distance (0 = largest observed)', default: 0, optional: true },
        { name: 'effort', kind: 'number', label: 'Effort — total line length, or number of points (0 = skip density)', default: 0, optional: true },
        { name: 'area', kind: 'number', label: 'Study area, in the same units squared (0 = skip abundance)', default: 0, optional: true },
      ],
    },
    {
      howto: 'detection-occupancy',
      label: 'Occupancy / N-mixture…',
      run: 'occupancy',
      order: 11,
      inputs: [
        { name: 'visits', kind: 'variables', label: 'One column per repeat visit', hint: 'Each row a site, each column one visit to it. Two or more.', multiple: true, types: ['numeric'], unique: true },
        {
          name: 'model',
          kind: 'choice',
          label: 'Model',
          default: 'occu',
          options: [
            { value: 'occu', label: 'Occupancy — was it there at all (detection/non-detection)' },
            { value: 'pcount', label: 'N-mixture — how many were there (counts)' },
          ],
        },
        { name: 'kmax', kind: 'number', label: 'N-mixture: largest plausible site abundance (0 = choose for me)', default: 0, optional: true },
      ],
    },
  ],
};


/**
 * The `dsmodel` formula text for each offered key — see the file header for why these are
 * strings and why bare `unif` is absent.
 */
export const DSMODEL = {
  hn: '~mcds(key = "hn", formula = ~1)',
  hr: '~mcds(key = "hr", formula = ~1)',
  unifcos: '~cds(key = "unif", formula = ~1, adj.series = "cos", adj.order = c(1))',
};

const KEY_LABEL = { hn: 'Half-normal', hr: 'Hazard-rate', unifcos: 'Uniform + cosine' };

/**
 * The smallest sample worth attempting.
 *
 * `ddf` fits one observation without complaint — verified — so this floor is ours or
 * there is none. The distance-sampling literature wants 60–80 detections for a reliable
 * function; ten is the point below which the output would be theatre rather than merely
 * imprecise, and the note on the result says so for anything under sixty.
 */
export const MIN_DETECTIONS = 10;

/** Detections below which the write-up should call the fit provisional. */
const PROVISIONAL_BELOW = 60;

export async function distance(app, { dist, shape, key, truncation, effort, area }) {
  if (!dist || (Array.isArray(dist) && !dist.length)) {
    await app.results.appendError('Distance sampling: choose the column holding the distances.');
    return;
  }
  const model = DSMODEL[key] ?? DSMODEL.hn;
  const isPoint = shape === 'point';
  const POINT = isPoint ? 'TRUE' : 'FALSE';
  await app.webr.installPackages(['mrds']);

  // The host injects this action's gathered inputs into R by name (`dist`, `truncation`,
  // `effort`, `area`), so `webr.run` takes the code alone — a second argument here would
  // be read as WebR options, not as bindings.
  const rCode = `
    suppressMessages(library(mrds))
    d <- as.numeric(dist); d <- d[is.finite(d) & d >= 0]
    W <- if (truncation > 0) truncation else max(d, 0)
    kept <- d[d <= W]; dropped <- length(d) - length(kept)
    # The floor is checked HERE because a single-column variables input reaches the plugin
    # as a column NAME; only R has the values.
    if (length(kept) < ${MIN_DETECTIONS} || W <= 0) {
      list(tooFew = TRUE, n = length(kept), W = as.numeric(W))
    } else {
      df <- data.frame(object = seq_along(kept), distance = kept)
      meta <- list(width = W)${isPoint ? '; meta$point <- TRUE' : ''}
      fit <- ddf(dsmodel = as.formula(${JSON.stringify(model)}), data = df,
                 method = "ds", meta.data = meta)
      p <- as.numeric(fit$fitted[1])
      # Effective strip width (line) or effective detection radius (point): the distance
      # at which a perfect detector would have found the same number. A point's searched
      # area grows with the square of the radius, hence the sqrt.
      eff <- if (${POINT}) sqrt(p) * W else p * W
      n <- nrow(df)
      # Density from the area effort actually covered:
      #   line  — 2 * L * ESW       (both sides of every line)
      #   point — k * pi * EDR^2
      covered <- if (effort > 0) (if (${POINT}) effort * pi * eff^2 else 2 * effort * eff) else NA_real_
      dens <- if (is.na(covered) || covered <= 0) NA_real_ else n / covered
      abund <- if (is.na(dens) || area <= 0) NA_real_ else dens * area
      # mrds draws its own canonical figure — histogram of distances with the fitted
      # function over it — which is right for every key. Re-deriving the curve would mean
      # a second implementation of the hazard-rate and adjusted forms to get wrong.
      # The fitted function as NUMBERS on a grid, which is the #140 rule — the host
      # draws the picture. detfct evaluates against the design matrices, which carry one
      # row per observation, so a grid call recycles unless those rows are replicated to
      # the grid's length first. That replication is mrds' own technique, lifted from
      # plot.ds; without it the curve comes back as the right values repeated n times.
      gx <- seq(0, W, length.out = 101)
      dobj <- fit$ds$aux$ddfobj
      if (!is.null(dobj$scale)) dobj$scale$dm <- dobj$scale$dm[rep(1, length(gx)), , drop = FALSE]
      if (!is.null(dobj$shape)) dobj$shape$dm <- dobj$shape$dm[rep(1, length(gx)), , drop = FALSE]
      g <- tryCatch(as.numeric(detfct(gx, dobj, width = W)),
                    error = function(e) rep(NA_real_, length(gx)))
      # Handed over as a DENSITY, the one unit the histogram can rescale as the reader
      # switches between counts, percent and density. The normalisation differs by shape:
      # a line searches a strip of constant width, a point searches a disc whose area
      # grows with the radius, so the radial case carries the extra r.
      w <- if (${POINT}) gx * g else g
      area <- if (all(is.na(w))) NA_real_ else sum(diff(gx) * (head(w, -1) + tail(w, -1)) / 2)
      fx <- if (is.na(area) || area <= 0) rep(NA_real_, length(gx)) else w / area
      list(tooFew = FALSE, aic = as.numeric(fit$criterion), npar = length(fit$par),
           p = p, eff = as.numeric(eff), n = n, W = as.numeric(W), dropped = dropped,
           dens = dens, abund = abund, covered = covered,
           gx = gx, fx = fx, curve = g, used = kept)
    }`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  if (r.num1('tooFew') === 1 || r.str1('tooFew') === 'TRUE') {
    const got = r.num1('n');
    await app.results.appendError(
      `Distance sampling: needs at least ${MIN_DETECTIONS} usable distances within the`
      + ` truncation width, found ${Number.isFinite(got) ? f(got, 0) : '0'}.`
      + ' A detection function fitted to a handful of observations is not an estimate.',
    );
    return;
  }

  const n = r.num1('n');
  const W = r.num1('W');
  const dropped = r.num1('dropped');
  const effName = isPoint ? 'Effective detection radius' : 'Effective strip width';

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Detection function', KEY_LABEL[key] ?? key],
        ['Detections used', f(n, 0)],
        ['Truncation distance (W)', f(W, 3)],
        ['AIC', f(r.num1('aic'), 3)],
        ['Parameters', f(r.num1('npar'), 0)],
      ],
      rowHeaders: true,
    },
    {
      caption: `Detection function — ${isPoint ? 'point' : 'line'} transect`
        + (dropped > 0 ? `, ${f(dropped, 0)} detection(s) beyond W excluded` : ''),
    },
  );

  const dens = r.num1('dens');
  const abund = r.num1('abund');
  const detRows = [
    ['Average detection probability (p̂)', f(r.num1('p'), 4)],
    [effName, f(r.num1('eff'), 3)],
  ];
  if (Number.isFinite(dens)) {
    detRows.push(['Area effectively searched', f(r.num1('covered'), 3)]);
    detRows.push(['Density (per unit area)', f(dens, 5)]);
  }
  if (Number.isFinite(abund)) detRows.push(['Abundance in the study area', f(abund, 1)]);
  detRows.push(['Uncorrected count', f(n, 0)]);

  await app.results.appendTable(
    { columns: ['', 'Estimate'], rows: detRows, rowHeaders: true },
    {
      caption: Number.isFinite(dens)
        ? 'Detection and density'
        : 'Detection — supply an effort figure to get density',
    },
  );

  // A chart MODEL, not a finished SVG: the observed distances as a histogram with the
  // fitted function over them. The reader can rebin, which on this figure is not a
  // cosmetic choice — the agreement between bars and curve is how a detection function is
  // judged by eye, and that judgement changes with the intervals.
  const gx = r.nums('gx');
  const fx = r.nums('fx');
  const used = r.nums('used');
  const pairs = gx.map((x, i) => [x, fx[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (used.length && pairs.length >= 2) {
    await app.results.appendChart({
      kind: 'histogram',
      title: `Fitted detection function — ${KEY_LABEL[key] ?? key}`,
      values: used,
      overlay: {
        x: pairs.map(([x]) => x),
        y: pairs.map(([, y]) => y),
        label: 'Fitted detection function',
      },
      axes: { x: { title: isPoint ? 'Radial distance' : 'Perpendicular distance' } },
      // `valueMeasure`, not `measure` — the latter is silently ignored, which had this
      // figure rendering as counts while claiming density.
      view: { valueMeasure: 'density' },
    });
  } else {
    // Still said out loud. A result that quietly omits part of itself is worse than one
    // that admits a gap — that silence is what hid the `col` collision for a whole run.
    await app.results.appendText(
      '*The detection-function figure could not be drawn — the fitted function did not'
      + ' evaluate.* The estimates above are unaffected.',
    );
  }

  await app.results.appendText(
    `**p̂** is the probability that an object within ${f(W, 3)} of the line or point was`
    + ` detected; the **${effName.toLowerCase()}** is the distance at which a perfect`
    + ' detector would have found the same number, and it is what turns effort into area'
    + ' searched.'
    + '\n\nThree assumptions carry this estimate and none of them is testable from the'
    + ' output: everything **on** the line or point is detected (p = 1 at distance zero),'
    + ' objects do not **move** in response to you before detection, and distances are'
    + ' **measured** rather than eyeballed. Compare AIC across the three detection'
    + ' functions before settling on one.'
    + (n < PROVISIONAL_BELOW
      ? `\n\n**Treat this fit as provisional:** ${f(n, 0)} detections is below the 60–80 the`
        + ' distance-sampling literature asks for, so the shape of the function is poorly'
        + ' determined even though the arithmetic is exact.'
      : ''),
  );
}

export async function occupancy(app, { visits, model, kmax }) {
  const cols = Array.isArray(visits) ? visits : [];
  if (cols.length < 2) {
    await app.results.appendError(
      'Occupancy: choose at least two visit columns. With a single visit there is nothing'
      + ' to separate "absent" from "present but missed", which is the entire mechanism.',
    );
    return;
  }
  const isCount = model === 'pcount';
  const COUNT = isCount ? 'TRUE' : 'FALSE';

  const rCode = `
    # A column name that does not exist reaches here as something that is not a column,
    # and the bare failure is R's "Can't construct data.frame. Source object is not
    # eligible" — true and useless. Unreachable from the menu, where the picker only
    # offers real columns; reachable from a do-file with a typo in it.
    built <- tryCatch({
      Y <- as.matrix(as.data.frame(lapply(visits, as.numeric))); TRUE
    }, error = function(e) FALSE)
    if (!isTRUE(built) || !is.matrix(Y) || ncol(Y) < 2 || nrow(Y) < 1) {
      list(badInput = TRUE)
    } else {
    # A site never visited contributes nothing and makes the optimiser work for it.
    Y <- Y[rowSums(!is.na(Y)) > 0, , drop = FALSE]
    nSites <- nrow(Y); nVisits <- ncol(Y)
    if (nSites < 2) {
      list(tooFew = TRUE, nSites = nSites)
    } else {
      naive <- mean(apply(Y, 1, function(row) max(row, na.rm = TRUE) > 0))
      maxObs <- mean(apply(Y, 1, function(row) max(row, na.rm = TRUE)))
      if (${COUNT}) {
        # Royle (2004) N-mixture, constant lambda and p: the true abundance at a site is
        # unobserved, so its likelihood sums over every value it could have been, from the
        # largest count seen there up to K.
        K <- if (kmax > 0) kmax else max(Y, na.rm = TRUE) + 50
        nll <- function(par) {
          lambda <- exp(par[1]); p <- plogis(par[2]); tot <- 0
          for (i in seq_len(nrow(Y))) {
            row <- Y[i, ]; row <- row[!is.na(row)]
            Ns <- max(row):K
            terms <- vapply(Ns, function(N) dpois(N, lambda) * prod(dbinom(row, N, p)), 0)
            tot <- tot - log(max(sum(terms), 1e-300))
          }
          tot
        }
        start <- c(log(mean(apply(Y, 1, max, na.rm = TRUE)) + 1), 0)
      } else {
        # MacKenzie et al. (2002) single-season occupancy, constant psi and p. The whole
        # model is the second branch: a site with no detections is EITHER occupied and
        # missed every time, OR unoccupied — and that ambiguity is what detection
        # probability is estimated from.
        Z <- (Y > 0) * 1L
        nll <- function(par) {
          psi <- plogis(par[1]); p <- plogis(par[2]); tot <- 0
          for (i in seq_len(nrow(Z))) {
            row <- Z[i, ]; row <- row[!is.na(row)]
            n <- length(row); y <- sum(row)
            lik <- if (y > 0) psi * p^y * (1 - p)^(n - y) else psi * (1 - p)^n + (1 - psi)
            tot <- tot - log(max(lik, 1e-300))
          }
          tot
        }
        start <- c(0, 0); K <- NA_real_
      }
      fit <- optim(start, nll, method = "BFGS", hessian = TRUE)
      b <- fit$par
      # Standard errors from the numerical Hessian. A singular Hessian means the data do
      # not identify the model — report the estimate without an interval rather than a
      # fabricated one.
      se <- tryCatch(sqrt(diag(solve(fit$hessian))), error = function(e) c(NA_real_, NA_real_))
      aic <- 2 * fit$value + 2 * length(b)
      # Back-transform the LINK-scale interval, which keeps the bounds inside the
      # parameter's range — a symmetric interval on psi can run outside [0, 1].
      link <- if (${COUNT}) exp else plogis
      bounds <- function(i, fn) {
        if (is.na(se[i])) c(NA_real_, NA_real_)
        else c(fn(b[i] - 1.96 * se[i]), fn(b[i] + 1.96 * se[i]))
      }
      sCI <- bounds(1, link); dCI <- bounds(2, plogis)
      list(tooFew = FALSE, nSites = nSites, nVisits = nVisits, naive = naive,
           maxObs = maxObs, aic = as.numeric(aic), K = as.numeric(K),
           converged = fit$convergence == 0,
           stateEst = as.numeric(link(b[1])),
           stateLo = as.numeric(sCI[1]), stateHi = as.numeric(sCI[2]),
           detEst = as.numeric(plogis(b[2])),
           detLo = as.numeric(dCI[1]), detHi = as.numeric(dCI[2]))
    }
    }`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  if (r.num1('badInput') === 1 || r.str1('badInput') === 'TRUE') {
    await app.results.appendError(
      `Occupancy: could not read ${cols.length} visit column(s) — ${cols.join(', ')}.`
      + ' Check the names exist in the active dataset and hold numbers.',
    );
    return;
  }

  if (r.num1('tooFew') === 1 || r.str1('tooFew') === 'TRUE') {
    await app.results.appendError(
      'Occupancy: needs at least two sites with a visit between them. These models borrow'
      + ' detection information across sites, so a single site has nothing to borrow from.',
    );
    return;
  }

  const nVisits = r.num1('nVisits');
  const stateLabel = isCount ? 'Abundance per site (λ)' : 'Occupancy (ψ)';
  const naiveLabel = isCount ? 'Mean maximum count seen' : 'Naive occupancy (ever detected)';
  const naive = isCount ? r.num1('maxObs') : r.num1('naive');
  const stateEst = r.num1('stateEst');
  const p = r.num1('detEst');

  await app.results.appendTable(
    {
      columns: ['', 'Estimate', '95% CI'],
      rows: [
        [stateLabel, f(stateEst, 4), ci(r.num1('stateLo'), r.num1('stateHi'), 4)],
        ['Detection probability per visit (p)', f(p, 4), ci(r.num1('detLo'), r.num1('detHi'), 4)],
      ],
      rowHeaders: true,
    },
    {
      caption: `${isCount ? 'N-mixture' : 'Occupancy'} model — ${f(r.num1('nSites'), 0)} sites ×`
        + ` ${f(nVisits, 0)} visits (AIC ${f(r.num1('aic'), 3)}`
        + `${isCount ? `, K = ${f(r.num1('K'), 0)}` : ''})`,
    },
  );

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        [naiveLabel, f(naive, 4)],
        [`Corrected ${isCount ? 'λ' : 'ψ'}`, f(stateEst, 4)],
        ['Difference', f(stateEst - naive, 4)],
      ],
      rowHeaders: true,
    },
    { caption: 'What the detection correction changed' },
  );

  const missedAll = (1 - p) ** nVisits;
  await app.results.appendText(
    '**The second table is the point of the first.** The naive figure counts only sites'
    + ' where you happened to detect the species, so it is a floor rather than an estimate.'
    + ' The model reads the pattern ACROSS visits — detected on the second visit but not'
    + ' the first proves a miss is possible — to estimate how often you miss, and corrects'
    + ' for it.'
    + `\n\n**p = ${f(p, 3)} per visit** means an occupied site missed on every one of`
    + ` ${f(nVisits, 0)} visits has probability ${f(missedAll, 4)}. That is the hole the`
    + ' correction fills.'
    + (isCount
      ? '\n\nN-mixture estimates are sensitive to **K**, the assumed ceiling on site'
        + ' abundance. Re-run with a larger K and check the estimate holds still.'
      : '\n\nCount columns are read as presence/absence here, because that is what an'
        + ' occupancy model is. Choose N-mixture if the counts themselves matter.')
    + ' Both models assume the sites are **closed** across the visits — nothing arrives or'
    + ' leaves — and that detections are independent between visits.',
  );
}
