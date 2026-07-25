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
  howto:
    'GUI: Spatial ▸ Spatial autocorrelation (Moran’s I), Spatial lag regression, or Choropleth map — pick the variables ' +
    '(and a GeoJSON boundary file for the map). You get Moran\'s I / Geary\'s C tests, a spatial-lag model, or a shaded region map.\n' +
    'Syntax: run builtin-spatial.autocorrelation {"value": "rate", "xcoord": "lon", "ycoord": "lat", "k": 4}\n' +
    'Syntax: run builtin-spatial.lagregression {"outcome": "price", "preds": ["rooms", "age"], "xcoord": "lon", "ycoord": "lat", "k": 5}\n' +
    'Syntax: run builtin-spatial.choropleth {"region": "GEOID", "value": "rate", "boundary": "counties.geojson", "keyprop": "GEOID"}\n' +
    '  • value / xcoord / ycoord / k — autocorrelation: the measure, its coordinates, and neighbours k (default 4).\n' +
    '  • outcome / preds — lag regression: the numeric outcome and its predictors (k default 5).\n' +
    '  • region / value / boundary / keyprop — choropleth: region key, value to shade, a GeoJSON file, and its matching property.',
  disciplines: ['Environmental Studies', 'Public Policy & Administration', 'Sociology', 'Economics', 'Public Health', 'Ethnic Studies'],
  rPackages: ['sf', 'spdep', 'spatialreg', 'svglite'],
  workspaces: [{
    id: 'spatial-map',
    title: 'Map',
    verbs: [
      { id: 'load-boundaries', label: 'Load boundaries…', run: 'loadBoundaries', category: 'toolbar', needsFile: { extensions: ['.geojson', '.json'] } },
      { id: 'shade-by-variable', label: 'Shade by variable…', run: 'shadeByVariable', category: 'toolbar' },
      { id: 'filter-to-selection', label: 'Filter to selection', run: 'filterToSelection', category: 'toolbar' },
      { id: 'clear-boundaries', label: 'Clear', run: 'clearBoundaries', category: 'toolbar' },
      { id: 'export-map', label: 'Export map', run: 'exportMap', category: 'toolbar' },
    ],
  }],
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

// === Spatial workspace tab ===================================================
//
// An interactive boundary-map viewer. The user loads a GeoJSON of region shapes,
// joins it to their data by a key column, shades regions by a numeric variable,
// and selects regions to filter the dataset for analysis. Boundaries are session-
// only (not persisted — GeoJSON files can be large); settings persist via state.

let _ws = null; // module-level workspace state (fresh per iframe mount)

export const workspace = {
  async mount(app, root) {
    _ws = {
      features: [], regionKeys: [], pathEls: [],
      keyProp: null, dataColumn: null, shadeColumn: null,
      selected: new Set(), fileName: null,
      svgEl: null, listEl: null, statusEl: null, root,
    };
    const saved = await app.state.get();
    if (saved) {
      _ws.keyProp = saved.keyProp || null;
      _ws.dataColumn = saved.dataColumn || null;
      _ws.shadeColumn = saved.shadeColumn || null;
      _ws.selected = new Set(saved.selected || []);
      _ws.fileName = saved.fileName || null;
    }

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host, * { box-sizing: border-box; }
      body { margin: 0; font: 13px/1.4 system-ui, sans-serif; color: #2c3e50; display: flex; height: 100vh; }
      .map-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #e2e6ea; }
      .map-pane svg { flex: 1; background: #fafbfc; cursor: crosshair; }
      .map-pane svg path { stroke: #fff; stroke-width: 0.5; fill: #d5dbe2; transition: fill 0.15s; }
      .map-pane svg path:hover { stroke: #2980b9; stroke-width: 1.2; }
      .map-pane svg path.selected { stroke: #e74c3c; stroke-width: 1.5; }
      .status { padding: 6px 10px; border-top: 1px solid #e2e6ea; font-size: 12px; color: #6b7685; }
      .list-pane { width: 220px; display: flex; flex-direction: column; overflow: hidden; }
      .list-header { padding: 8px 10px; border-bottom: 1px solid #e2e6ea; display: flex; gap: 6px; align-items: center; }
      .list-header strong { flex: 1; }
      .list-body { flex: 1; overflow-y: auto; padding: 2px 0; }
      .region-row { display: flex; align-items: center; gap: 6px; padding: 2px 10px; cursor: pointer; }
      .region-row:hover { background: #f0f4f8; }
      .region-row input { margin: 0; }
      .swatch { width: 12px; height: 12px; border-radius: 2px; border: 1px solid #ccc; flex: none; }
      button.sm { font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid #ccd2d8; border-radius: 4px; background: #fff; cursor: pointer; }
      button.sm:hover { background: #eef3f8; }
      .empty { padding: 20px; text-align: center; color: #8899a6; }
      .demo-links { padding: 16px 20px; text-align: center; color: #5a6a78; line-height: 1.6; }
      .demo-links a { color: #2980b9; cursor: pointer; text-decoration: underline; }
      .demo-links a:hover { color: #1a5276; }
    `);
    document.adoptedStyleSheets = [sheet];

    root.innerHTML = '';
    const mapPane = el('div', 'map-pane');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 800 500');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    _ws.svgEl = svg;
    mapPane.append(svg);
    const status = el('div', 'status');
    status.textContent = _ws.fileName
      ? `Re-load ${_ws.fileName} to continue.`
      : 'Load a GeoJSON boundary file to begin.';
    _ws.statusEl = status;
    mapPane.append(status);

    const listPane = el('div', 'list-pane');
    const listHeader = el('div', 'list-header');
    const title = document.createElement('strong');
    title.textContent = 'Regions';
    const btnAll = document.createElement('button');
    btnAll.className = 'sm'; btnAll.textContent = 'All';
    btnAll.addEventListener('click', () => wsSelectAll(true));
    const btnNone = document.createElement('button');
    btnNone.className = 'sm'; btnNone.textContent = 'None';
    btnNone.addEventListener('click', () => wsSelectAll(false));
    listHeader.append(title, btnAll, btnNone);
    const listBody = el('div', 'list-body');
    _ws.listEl = listBody;
    listPane.append(listHeader, listBody);
    root.append(mapPane, listPane);

    if (saved?.__demoBoundaries?.length) {
      const sets = saved.__demoBoundaries;
      const first = sets[0];
      const fc = { type: 'FeatureCollection', features: first.features };
      await wsApplyBoundaries(app, fc, first.fileName, first.keyProp, first.dataColumn);
      if (sets.length > 1) {
        const links = el('div', null, 'demo-links');
        links.textContent = 'Switch boundaries: ';
        for (let i = 0; i < sets.length; i++) {
          if (i > 0) links.append(document.createTextNode(' · '));
          const s = sets[i];
          const a = document.createElement('a');
          a.textContent = s.fileName;
          a.addEventListener('click', () => {
            wsApplyBoundaries(app, { type: 'FeatureCollection', features: s.features }, s.fileName, s.keyProp, s.dataColumn);
          });
          links.append(a);
        }
        _ws.svgEl.insertAdjacentElement('afterend', links);
      }
    }
  },

  async onDatasetChanged(app) {
    if (!_ws?.features.length || !_ws.shadeColumn) return;
    await wsApplyShading(app);
  },

  async onDeactivate(app) {
    if (!_ws) return;
    await wsSaveState(app);
  },
};

// --- workspace verb functions (run in the workspace iframe) ------------------

export async function loadBoundaries(app, opts) {
  if (!_ws) return { ok: false, message: 'Workspace not mounted.' };
  const file = opts?.__file;
  if (!file) return { ok: false, message: 'No file provided.' };
  let geojson;
  try {
    const text = new TextDecoder().decode(file.bytes);
    geojson = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `Invalid GeoJSON: ${e.message}` };
  }
  return wsApplyBoundaries(app, geojson, file.name);
}

async function wsApplyBoundaries(app, geojson, fileName, presetKeyProp, presetDataCol) {
  const fc = geojson.type === 'FeatureCollection' ? geojson
    : geojson.type === 'Feature' ? { type: 'FeatureCollection', features: [geojson] }
    : null;
  if (!fc?.features?.length) return { ok: false, message: 'No features found in the GeoJSON.' };
  const validFeatures = fc.features.filter(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );
  if (!validFeatures.length) return { ok: false, message: 'No Polygon/MultiPolygon features found.' };

  const allProps = new Set();
  for (const f of validFeatures) {
    if (f.properties) for (const k of Object.keys(f.properties)) allProps.add(k);
  }
  const propList = [...allProps].sort();
  if (!propList.length) return { ok: false, message: 'Features have no properties to use as a region key.' };

  let keyProp = presetKeyProp || _ws.keyProp;
  if (!keyProp || !allProps.has(keyProp)) {
    const items = propList.map((p) => ({ value: p, label: p }));
    const pick = await app.ui.selectFromList({
      title: 'Region key property',
      hint: 'Which property in the GeoJSON identifies each region?',
      items,
      multiple: false,
    });
    if (!pick) return { ok: false, message: 'Cancelled.' };
    keyProp = pick[0];
  }

  const cols = await app.data.getColumns();
  const colNames = cols?.names || cols?.map?.((c) => c.name) || [];
  if (colNames.length) {
    let dataCol = presetDataCol || _ws.dataColumn;
    if (!dataCol || !colNames.includes(dataCol)) {
      const pick = await app.ui.selectVariables({
        title: 'Match to data column',
        hint: `Which column in your data matches the "${keyProp}" property in the map?`,
        multiple: false,
      });
      if (!pick) return { ok: false, message: 'Cancelled.' };
      dataCol = pick[0];
    }
    _ws.dataColumn = dataCol;
  }

  _ws.features = validFeatures;
  _ws.keyProp = keyProp;
  _ws.fileName = fileName;
  _ws.regionKeys = validFeatures.map((f) => String(f.properties?.[keyProp] ?? ''));

  wsRenderMap();
  wsRenderList();
  await wsSaveState(app);

  const n = validFeatures.length;
  _ws.statusEl.textContent = `${fileName} — ${n} region${n !== 1 ? 's' : ''} loaded (key: ${keyProp}).`;
  return { ok: true };
}

export async function shadeByVariable(app) {
  if (!_ws?.features.length) return { ok: false, message: 'Load boundaries first.' };
  const pick = await app.ui.selectVariables({
    title: 'Shade regions by',
    hint: 'Choose a numeric variable — each region is shaded by its mean value.',
    multiple: false,
    types: ['numeric'],
  });
  if (!pick) return { ok: false, message: 'Cancelled.' };
  _ws.shadeColumn = pick[0];
  await wsApplyShading(app);
  await wsSaveState(app);
  return { ok: true };
}

export async function filterToSelection(app) {
  if (!_ws) return { ok: false, message: 'Workspace not mounted.' };
  if (!_ws.selected.size) return { ok: false, message: 'No regions selected.' };
  if (!_ws.dataColumn) return { ok: false, message: 'No data column matched — load boundaries first.' };
  const rows = await app.data.getRows();
  const cols = await app.data.getColumns();
  const colNames = cols?.names || cols?.map?.((c) => c.name) || [];
  const keyIdx = colNames.indexOf(_ws.dataColumn);
  if (keyIdx < 0) return { ok: false, message: `Column "${_ws.dataColumn}" not found in data.` };

  const keep = [];
  for (const row of rows || []) {
    const val = String(row[keyIdx] ?? '');
    if (_ws.selected.has(val)) keep.push(row);
  }
  if (!keep.length) return { ok: false, message: 'No rows match the selected regions.' };

  await app.data.create({
    name: `Selection (${_ws.selected.size} regions)`,
    columns: colNames,
    rows: keep,
  });
  return { ok: true, message: `Created dataset with ${keep.length} rows from ${_ws.selected.size} regions.`, refresh: 'dataset' };
}

export async function clearBoundaries(app) {
  if (!_ws) return { ok: false, message: 'Workspace not mounted.' };
  _ws.features = []; _ws.regionKeys = []; _ws.pathEls = [];
  _ws.keyProp = null; _ws.shadeColumn = null; _ws.selected.clear();
  _ws.svgEl.innerHTML = '';
  _ws.listEl.innerHTML = '';
  _ws.statusEl.textContent = 'Load a GeoJSON boundary file to begin.';
  await wsSaveState(app);
  return { ok: true };
}

export async function exportMap() {
  if (!_ws?.svgEl) return { ok: false, message: 'No map to export.' };
  if (!_ws.features.length) return { ok: false, message: 'Load boundaries first.' };
  const svgMarkup = _ws.svgEl.outerHTML;
  const full = `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}`;
  const blob = new Blob([full], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (_ws.fileName || 'map').replace(/\.\w+$/, '') + '_map.svg';
  a.click();
  URL.revokeObjectURL(a.href);
  return { ok: true, message: 'Map exported.' };
}

// --- workspace rendering helpers ---------------------------------------------

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function wsRenderMap() {
  const svg = _ws.svgEl;
  svg.innerHTML = '';
  _ws.pathEls = [];
  if (!_ws.features.length) return;

  const { project } = wsProjection(_ws.features, 800, 500);
  for (let i = 0; i < _ws.features.length; i++) {
    const f = _ws.features[i];
    const d = wsGeometryToPath(f.geometry, project);
    if (!d) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    const key = _ws.regionKeys[i];
    path.dataset.key = key;
    if (_ws.selected.has(key)) path.classList.add('selected');
    path.addEventListener('click', () => wsToggleRegion(key));
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    label.textContent = key;
    path.append(label);
    svg.append(path);
    _ws.pathEls[i] = path;
  }
}

function wsRenderList() {
  const list = _ws.listEl;
  list.innerHTML = '';
  if (!_ws.regionKeys.length) {
    list.innerHTML = '<div class="empty">No regions loaded.</div>';
    return;
  }
  const sorted = _ws.regionKeys.map((k, i) => ({ key: k, idx: i }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  for (const { key, idx } of sorted) {
    const row = el('label', 'region-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = _ws.selected.has(key);
    cb.addEventListener('change', () => wsToggleRegion(key));
    const swatch = el('span', 'swatch');
    swatch.style.background = _ws.pathEls[idx]?.getAttribute('fill') || '#d5dbe2';
    swatch.dataset.idx = idx;
    const lbl = document.createElement('span');
    lbl.textContent = key;
    row.append(cb, swatch, lbl);
    row.dataset.key = key;
    list.append(row);
  }
}

function wsToggleRegion(key) {
  if (_ws.selected.has(key)) _ws.selected.delete(key);
  else _ws.selected.add(key);
  for (let i = 0; i < _ws.regionKeys.length; i++) {
    if (_ws.regionKeys[i] !== key) continue;
    _ws.pathEls[i]?.classList.toggle('selected', _ws.selected.has(key));
  }
  const row = _ws.listEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const cb = row?.querySelector('input');
  if (cb) cb.checked = _ws.selected.has(key);
}

function wsSelectAll(on) {
  if (on) _ws.regionKeys.forEach((k) => _ws.selected.add(k));
  else _ws.selected.clear();
  for (let i = 0; i < _ws.pathEls.length; i++) {
    _ws.pathEls[i]?.classList.toggle('selected', on);
  }
  for (const cb of _ws.listEl.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = on;
  }
}

async function wsApplyShading(app) {
  if (!_ws?.features.length || !_ws.shadeColumn || !_ws.dataColumn) return;
  let rows, cols;
  try {
    rows = await app.data.getRows();
    cols = await app.data.getColumns();
  } catch { return; }
  const colNames = cols?.names || cols?.map?.((c) => c.name) || [];
  const keyIdx = colNames.indexOf(_ws.dataColumn);
  const valIdx = colNames.indexOf(_ws.shadeColumn);
  if (keyIdx < 0 || valIdx < 0) return;

  const regionSums = new Map();
  const regionCounts = new Map();
  for (const row of rows || []) {
    const rk = String(row[keyIdx] ?? '');
    const v = Number(row[valIdx]);
    if (!rk || !Number.isFinite(v)) continue;
    regionSums.set(rk, (regionSums.get(rk) || 0) + v);
    regionCounts.set(rk, (regionCounts.get(rk) || 0) + 1);
  }
  const means = new Map();
  let lo = Infinity, hi = -Infinity;
  for (const [k, s] of regionSums) {
    const m = s / regionCounts.get(k);
    means.set(k, m);
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  const range = hi - lo || 1;
  const COLORS = ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#084594'];
  for (let i = 0; i < _ws.regionKeys.length; i++) {
    const m = means.get(_ws.regionKeys[i]);
    let fill = '#d5dbe2';
    if (m != null) {
      const t = (m - lo) / range;
      fill = COLORS[Math.min(Math.floor(t * COLORS.length), COLORS.length - 1)];
    }
    _ws.pathEls[i]?.setAttribute('fill', fill);
  }
  // Update swatches in the list
  for (const sw of _ws.listEl.querySelectorAll('.swatch')) {
    const idx = Number(sw.dataset.idx);
    sw.style.background = _ws.pathEls[idx]?.getAttribute('fill') || '#d5dbe2';
  }
  _ws.statusEl.textContent =
    `${_ws.fileName} — shaded by ${_ws.shadeColumn} (${means.size} matched of ${_ws.regionKeys.length} regions).`;
}

async function wsSaveState(app) {
  await app.state.set({
    keyProp: _ws.keyProp, dataColumn: _ws.dataColumn,
    shadeColumn: _ws.shadeColumn, fileName: _ws.fileName,
    selected: [..._ws.selected],
  });
}

// --- GeoJSON → SVG projection ------------------------------------------------

function wsProjection(features, width, height) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      if (coords[0] < minX) minX = coords[0];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[1] > maxY) maxY = coords[1];
    } else { for (const c of coords) visit(c); }
  };
  for (const f of features) visit(f.geometry.coordinates);
  const pad = 20, w = width - 2 * pad, h = height - 2 * pad;
  const scale = Math.min(w / ((maxX - minX) || 1), h / ((maxY - minY) || 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return {
    project: ([lon, lat]) => [
      pad + w / 2 + (lon - cx) * scale,
      pad + h / 2 - (lat - cy) * scale,
    ],
  };
}

function wsGeometryToPath(geom, project) {
  const ring = (coords) =>
    coords.map(([lon, lat], i) => {
      const [x, y] = project([lon, lat]);
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join('') + 'Z';
  if (geom.type === 'Polygon') return geom.coordinates.map(ring).join('');
  if (geom.type === 'MultiPolygon') return geom.coordinates.flatMap((p) => p.map(ring)).join('');
  return '';
}
