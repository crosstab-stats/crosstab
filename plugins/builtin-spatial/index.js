/**
 * @file plugins/builtin-spatial/index.js
 * Built-in plugin: **Spatial analysis** — the on-brand analytical wing of GIS
 * (no tile servers, nothing leaves the device). Two tools to start:
 *
 *  - **Spatial autocorrelation (Moran's I / Geary's C)** — is a value clustered
 *    geographically, or scattered at random? Builds a k-nearest-neighbour spatial
 *    weights matrix from point coordinates and tests global autocorrelation.
 *  - **Choropleth map** — shade regions by a value. Ships nothing proprietary:
 *    bring your own boundaries as a GeoJSON (counties, districts, countries…) via
 *    the file input, joined to your data by a key column. Rendered server-side in
 *    R (sf + svglite) → SVG, so no map tiles and no data ever leaves the browser.
 *
 * Uses sf + spdep (WebR ships GDAL/GEOS/PROJ in WASM). Interactive tiled maps are
 * deliberately out of scope — they'd require a tile server (network + leaking the
 * user's map view), which fights CrossTab's privacy/offline promise.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-spatial',
  name: 'Spatial analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Spatial',
  keywords: ['spatial', 'gis', 'moran', 'geary', 'autocorrelation', 'choropleth', 'map', 'sf', 'spdep', 'geojson', 'lisa'],
  disciplines: ['Environmental Studies', 'Public Policy & Administration', 'Sociology', 'Economics', 'Public Health', 'Ethnic Studies'],
  rPackages: ['sf', 'spdep', 'spatialreg', 'svglite'],
  menu: [
    {
      label: 'Spatial autocorrelation (Moran’s I)…',
      run: 'autocorrelation',
      order: 10,
      inputs: [
        { name: 'value', kind: 'variables', label: 'Value to test', hint: 'The measure to check for geographic clustering.', multiple: false, types: ['numeric'], unique: true },
        { name: 'xcoord', kind: 'variables', label: 'X / longitude', hint: 'The east–west coordinate of each case.', multiple: false, types: ['numeric'], unique: true },
        { name: 'ycoord', kind: 'variables', label: 'Y / latitude', hint: 'The north–south coordinate of each case.', multiple: false, types: ['numeric'], unique: true },
        { name: 'k', kind: 'number', label: 'Neighbours (k)', hint: 'How many nearest neighbours define each point’s local area.', default: 4 },
      ],
    },
    {
      label: 'Spatial lag regression…',
      run: 'lagregression',
      order: 15,
      inputs: [
        { name: 'outcome', kind: 'variables', label: 'Outcome', hint: 'The numeric outcome to model.', multiple: false, types: ['numeric'], unique: true },
        { name: 'preds', kind: 'variables', label: 'Predictors', hint: 'The numeric predictors of the outcome.', multiple: true, types: ['numeric'], unique: true },
        { name: 'xcoord', kind: 'variables', label: 'X / longitude', hint: 'The east–west coordinate of each case.', multiple: false, types: ['numeric'], unique: true },
        { name: 'ycoord', kind: 'variables', label: 'Y / latitude', hint: 'The north–south coordinate of each case.', multiple: false, types: ['numeric'], unique: true },
        { name: 'k', kind: 'number', label: 'Neighbours (k)', hint: 'How many nearest neighbours define the spatial weights.', default: 5 },
      ],
    },
    {
      label: 'Choropleth map…',
      run: 'choropleth',
      order: 20,
      inputs: [
        { name: 'region', kind: 'variables', label: 'Region key (in your data)', hint: 'The column identifying each region (e.g. county FIPS, state code).', multiple: false, unique: true },
        { name: 'value', kind: 'variables', label: 'Value to map', hint: 'The measure to shade each region by (averaged per region).', multiple: false, types: ['numeric'], unique: true },
        { name: 'boundary', kind: 'file', label: 'Boundary map (GeoJSON)', extensions: ['.geojson', '.json'], hint: 'A GeoJSON of region shapes — bring any geography (no map tiles, stays on-device).' },
        { name: 'keyprop', kind: 'text', label: 'Matching property in the map', hint: 'The GeoJSON property that matches your region key (e.g. GEOID).', default: 'GEOID' },
      ],
    },
  ],
};

// --- Spatial autocorrelation -------------------------------------------------

export async function autocorrelation(app, { value, xcoord, ycoord, k }) {
  if (!value || !xcoord || !ycoord) {
    await app.results.appendError('Spatial autocorrelation: choose a value and its X and Y coordinates.');
    return;
  }
  const K = Number.isFinite(k) ? Math.max(1, Math.floor(k)) : 4;
  const rCode = `
    suppressMessages({library(sf); library(spdep)})
    v <- as.numeric(value); x <- as.numeric(xcoord); y <- as.numeric(ycoord)
    ok <- is.finite(v) & is.finite(x) & is.finite(y); v <- v[ok]; x <- x[ok]; y <- y[ok]
    n <- length(v)
    if (n < 5) {
      list(err = sprintf("Need at least 5 located cases (have %d).", n))
    } else {
      k <- min(${K}, n - 1L)
      nb <- knn2nb(knearneigh(cbind(x, y), k = k))
      lw <- nb2listw(nb, style = "W", zero.policy = TRUE)
      mi <- moran.test(v, lw, zero.policy = TRUE)
      gc <- geary.test(v, lw, zero.policy = TRUE)
      list(n = n, k = k,
           moranI = mi$estimate[[1]], moranE = mi$estimate[[2]], moranP = mi$p.value,
           gearyC = gc$estimate[[1]], gearyP = gc$p.value, err = "")
    }`;
  let result;
  try {
    ({ result } = await app.webr.run(rCode));
  } catch (e) {
    await app.results.appendError(`Spatial autocorrelation failed: ${e.message}`);
    return;
  }
  const r = flat(result);
  const err = r.str1('err');
  if (err) {
    await app.results.appendText(err);
    return;
  }
  const I = r.num('moranI'), E = r.num('moranE'), mp = r.num('moranP');
  const C = r.num('gearyC'), gp = r.num('gearyP');
  await app.results.appendTable(
    {
      columns: ['Statistic', 'Value', 'Expected (no autocorrelation)', 'p-value'],
      rows: [
        ['Moran’s I', I.toFixed(4), E.toFixed(4), fmtP(mp)],
        ['Geary’s C', C.toFixed(4), '1.0000', fmtP(gp)],
      ],
      rowHeaders: false,
    },
    { caption: `Spatial Autocorrelation — ${r.num('n')} cases, k = ${r.num('k')} nearest neighbours` },
  );
  const dir = I > E ? 'positive (similar values cluster together)' : 'negative (neighbours tend to differ — a checkerboard pattern)';
  const sig = mp < 0.05 ? `statistically significant (p = ${fmtP(mp)})` : `not statistically significant (p = ${fmtP(mp)})`;
  await app.results.appendText(
    `**Moran’s I = ${I.toFixed(3)}** indicates ${dir}, ${sig}. Moran’s I runs from −1 to +1 (0 ≈ random); Geary’s C is an inverse complement (≈1 random, <1 positive autocorrelation). Both here use a k-nearest-neighbour spatial weights matrix.`,
  );
}

// --- Spatial lag regression (SAR) -------------------------------------------

export async function lagregression(app, { outcome, preds, xcoord, ycoord, k }) {
  const nPreds = Array.isArray(preds) ? preds.length : preds ? 1 : 0;
  if (!outcome || !nPreds || !xcoord || !ycoord) {
    await app.results.appendError('Spatial lag regression: choose an outcome, predictor(s), and X/Y coordinates.');
    return;
  }
  const K = Number.isFinite(k) ? Math.max(1, Math.floor(k)) : 5;
  const rCode = `
    suppressMessages({library(sf); library(spdep); library(spatialreg)})
    y <- as.numeric(outcome); P <- as.data.frame(preds); x <- as.numeric(xcoord); yy <- as.numeric(ycoord)
    df <- data.frame(.y = y); for (nm in names(P)) df[[nm]] <- P[[nm]]; df$.x <- x; df$.yy <- yy
    df <- df[stats::complete.cases(df), , drop = FALSE]
    n <- nrow(df)
    if (n < 10) {
      list(err = sprintf("Need at least 10 complete located cases (have %d).", n))
    } else {
      nb <- knn2nb(knearneigh(cbind(df$.x, df$.yy), k = min(${K}, n - 1L)))
      lw <- nb2listw(nb, style = "W", zero.policy = TRUE)
      pn <- setdiff(names(df), c(".y", ".x", ".yy"))
      form <- as.formula(paste(".y ~", paste(sprintf("\`%s\`", pn), collapse = " + ")))
      m <- lagsarlm(form, data = df, listw = lw, zero.policy = TRUE)
      s <- summary(m); co <- s$Coef
      list(terms = rownames(co), est = as.numeric(co[, 1]), se = as.numeric(co[, 2]), p = as.numeric(co[, 4]),
           rho = m$rho, rhoP = s$LR1$p.value, n = n, err = "")
    }`;
  let result;
  try {
    ({ result } = await app.webr.run(rCode));
  } catch (e) {
    await app.results.appendError(`Spatial lag regression failed: ${e.message}`);
    return;
  }
  const r = flat(result);
  const err = r.str1('err');
  if (err) {
    await app.results.appendText(err);
    return;
  }
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), p = r.nums('p');
  await app.results.appendTable(
    {
      columns: ['Term', 'Estimate', 'Std. error', 'p-value'],
      rows: terms.map((t, i) => [t.replace(/^`|`$/g, ''), est[i].toFixed(4), se[i].toFixed(4), fmtP(p[i])]),
      rowHeaders: false,
    },
    { caption: `Spatial Lag Regression (SAR) — ${r.num('n')} cases` },
  );
  const rho = r.num('rho'), rhoP = r.num('rhoP');
  await app.results.appendText(
    `**Spatial lag ρ = ${rho.toFixed(3)}** (likelihood-ratio test p = ${fmtP(rhoP)}) — ${rhoP < 0.05 ? 'significant' : 'no significant'} spatial dependence: a case’s outcome ${rho >= 0 ? 'moves with' : 'moves opposite to'} its neighbours’. The coefficients are direct effects; when ρ is significant, total effects also include spillover through the neighbour network.`,
  );
}

// --- Choropleth map ----------------------------------------------------------

export async function choropleth(app, { region, value, boundary, keyprop }) {
  if (!region || !value) {
    await app.results.appendError('Choropleth: choose a region-key column and a value to map.');
    return;
  }
  if (!boundary || !boundary.bytes) {
    await app.results.appendError('Choropleth: choose a boundary GeoJSON file.');
    return;
  }
  const key = (keyprop && String(keyprop).trim()) || 'GEOID';
  const path = '/tmp/ct_boundary.geojson';
  await app.webr.writeFile(path, boundary.bytes);
  const rCode = `
    suppressMessages({library(sf); library(svglite)})
    shp <- st_read(${rStr(path)}, quiet = TRUE)
    key <- ${rStr(key)}
    if (!key %in% names(shp)) {
      list(err = sprintf("The map has no property '%s'. Available: %s", key, paste(head(setdiff(names(shp), attr(shp, "sf_column")), 15), collapse = ", ")))
    } else {
      reg <- trimws(as.character(region)); val <- as.numeric(value)
      dat <- data.frame(.key = reg, .val = val, stringsAsFactors = FALSE)
      dat <- dat[!is.na(dat$.key) & nzchar(dat$.key), , drop = FALSE]
      agg <- aggregate(.val ~ .key, data = dat, FUN = function(z) mean(z, na.rm = TRUE))
      shpkey <- trimws(as.character(shp[[key]]))
      # Try a direct match; if poor, zero-pad the data key to the map key's width
      # (the classic FIPS '6075' vs '06075' trap).
      w <- as.integer(stats::median(nchar(shpkey), na.rm = TRUE))
      matched0 <- sum(agg$.key %in% shpkey)
      padded <- formatC(agg$.key, width = w, flag = "0")
      matched1 <- sum(padded %in% shpkey)
      if (matched1 > matched0) agg$.key <- padded
      shp$.key <- shpkey
      m <- merge(shp, agg, by = ".key", all.x = TRUE)
      nMatched <- sum(!is.na(m$.val)); nRegions <- nrow(shp); nData <- nrow(agg)
      .ct <- svgstring(width = 8, height = 5.5, pointsize = 11)
      plot(m[".val"], main = "", key.pos = 1, border = "#ffffff", lwd = 0.3, pal = function(x) hcl.colors(x, "YlGnBu", rev = TRUE))
      dev.off(); svg <- .ct()
      list(svg = svg, nMatched = nMatched, nRegions = nRegions, nData = nData, err = "")
    }`;
  let result;
  try {
    ({ result } = await app.webr.run(rCode));
  } catch (e) {
    await app.results.appendError(`Choropleth failed: ${e.message}`);
    return;
  }
  const r = flat(result);
  const err = r.str1('err');
  if (err) {
    await app.results.appendError(err);
    return;
  }
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  const nMatched = r.num('nMatched'), nRegions = r.num('nRegions'), nData = r.num('nData');
  await app.results.appendText(
    `Shaded **${nMatched} of ${nRegions}** regions from **${nData}** data rows.` +
      (nMatched === 0
        ? ' **No regions matched** — check that your region key matches the map’s key format (e.g. county FIPS need leading zeros: `06075`, not `6075`), or pick the right matching property.'
        : nMatched < nData
          ? ' Some data rows didn’t match a region — usually a key-format mismatch (leading zeros) or regions absent from this map.'
          : ''),
  );
}

// --- helpers -----------------------------------------------------------------

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}

function cleanSvg(svg) {
  return String(svg)
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
    str1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
