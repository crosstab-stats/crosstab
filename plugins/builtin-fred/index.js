/**
 * @file plugins/builtin-fred/index.js
 * Built-in importer plugin: File ▸ Import data… ▸ FRED (economic time series).
 *
 * Economics is a social science too — FRED (Federal Reserve Economic Data, from
 * the St. Louis Fed) is the standard public source for macroeconomic series
 * (GDP, unemployment, CPI, …). This plugin pulls one series straight off the web
 * into a dataset, with `date` and value columns ready to analyse or pool.
 *
 * It demonstrates the **`web` importer** contract: unlike a file importer, there
 * is no upload. The plugin declares `source: 'web'`, the engine calls
 * `parse({ ticket })` with no file, and the plugin fetches its own bytes via
 * `app.web.get(url)` and delivers a dataset back.
 *
 * ## The CORS wrinkle
 * FRED's API sends no `Access-Control-Allow-Origin` header, so a browser blocks
 * a direct `fetch` from our (cross-origin-isolated) page. We route the request
 * through a public CORS proxy, which re-serves the response with permissive CORS
 * headers. The FRED API key therefore transits a third party — acceptable here
 * because a FRED key is a free, public-data rate-limit identifier, not a secret
 * granting access to anything private. (We would never proxy a real credential.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-fred',
  name: 'FRED Import',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Import',
  keywords: ['economic', 'time series', 'fed', 'fred', 'macro'],
  howto:
    'GUI: File ▸ Import data… ▸ FRED (economic data)…, then enter a series id (e.g. UNRATE) and your free FRED API key. You get a date + value dataset.\n' +
    'Used through the File menu, not a run command.',
  rPackages: [],
  imports: [{ label: 'FRED (economic data)…', source: 'web', order: 50, parse: 'importSeries' }],
};

/** Public CORS proxy: re-serves a target URL with permissive CORS headers. */
const CORS_PROXY = 'https://corsproxy.io/?url=';
const FRED_BASE = 'https://api.stlouisfed.org/fred';

/**
 * Declarative `web` importer: no file. Prompt for a series id + API key, fetch the
 * observations through the proxy, and **return** a `{date, <series>}` dataset (or
 * `null` if the user cancels; throw on error — the host reports it).
 *
 * @param {object} app
 * @returns {Promise<object|null>}
 */
export async function importSeries(app) {
  const form = await app.ui.showForm({
    title: 'Import from FRED',
    hint: 'Pull a Federal Reserve economic time series by its id.',
    okLabel: 'Fetch',
    fields: [
      { name: 'series', label: 'Series ID', placeholder: 'e.g. GDP, UNRATE, CPIAUCSL', hint: '(from fred.stlouisfed.org)' },
      { name: 'apiKey', label: 'FRED API key', type: 'password', hint: '(free at fredaccount.stlouisfed.org)' },
    ],
  });
  if (!form) return null; // cancelled

  const series = (form.series || '').trim().toUpperCase();
  const apiKey = (form.apiKey || '').trim();
  if (!series) throw new Error('a series id is required');
  if (!apiKey) throw new Error('a FRED API key is required');
  return fetchSeries(app, series, apiKey);
}

/**
 * Fetch one series' observations and shape them into the importer dataset.
 * Best-effort fetches the series title first for a friendly variable label.
 *
 * @param {object} app
 * @param {string} series - FRED series id (e.g. `'UNRATE'`).
 * @param {string} apiKey
 * @returns {Promise<{variables: object[], columns: Object<string, Array>, source: string}>}
 */
async function fetchSeries(app, series, apiKey) {
  const label = await fetchTitle(app, series, apiKey);

  const url = `${FRED_BASE}/series/observations?series_id=${encodeURIComponent(series)}` +
    `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
  const json = await getJson(app, url);

  const observations = json.observations;
  if (!Array.isArray(observations)) {
    throw new Error('unexpected response (no observations)');
  }

  const dates = [];
  const values = [];
  for (const obs of observations) {
    dates.push(obs.date);
    // FRED encodes a missing observation as the string ".".
    const v = obs.value === '.' || obs.value == null ? null : Number(obs.value);
    values.push(v === null || Number.isFinite(v) ? v : null);
  }

  return {
    variables: [
      { name: 'date', type: 'string', measurementLevel: 'ordinal', label: 'Observation date' },
      { name: series, type: 'numeric', measurementLevel: 'scale', label },
    ],
    columns: { date: dates, [series]: values },
    // Provenance tag if this series is pooled with other data.
    source: series,
  };
}

/**
 * Best-effort lookup of the human-readable series title for the variable label.
 * Returns the series id unchanged if the metadata call fails.
 */
async function fetchTitle(app, series, apiKey) {
  try {
    const url = `${FRED_BASE}/series?series_id=${encodeURIComponent(series)}` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const json = await getJson(app, url);
    const title = json?.seriess?.[0]?.title;
    return typeof title === 'string' && title ? title : series;
  } catch {
    return series;
  }
}

/**
 * GET a URL through the CORS proxy and parse the JSON body. FRED reports errors
 * as a JSON `{ error_code, error_message }` (often with HTTP 400), so we surface
 * that message rather than a bare status code.
 */
async function getJson(app, targetUrl) {
  const proxied = CORS_PROXY + encodeURIComponent(targetUrl);
  const res = await app.web.get(proxied);

  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    if (!res.ok) throw new Error(`request failed (HTTP ${res.status})`);
    throw new Error('response was not valid JSON');
  }
  if (json && json.error_message) {
    throw new Error(json.error_message);
  }
  if (!res.ok) throw new Error(`request failed (HTTP ${res.status})`);
  return json;
}
