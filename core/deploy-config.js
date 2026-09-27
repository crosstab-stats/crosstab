/**
 * @file deploy-config.js
 * **One file for the facts a deployment knows about itself** (#185).
 *
 * A fork or an institutional deploy has a handful of facts about ITSELF that were constants
 * scattered through our source: where bug reports go, whether the runtimes come from a CDN or
 * from `./vendor/`, and (slice 2) where its own plugins live. This is the single place a
 * self-hoster edits, so those facts stop being a patch against our code.
 *
 * ## The contract, which is what makes this safe to ship
 *
 * - **Absent by default.** No `deploy.json` means every field falls back to the constant it
 *   replaced, so the stock build behaves byte-identically. `deploy.example.json` is the
 *   committed, commented template — the live file is gitignored, because a committed file that
 *   sites edit in place would conflict on every `git pull` of our updates, and merge-resolving
 *   JSON is not a job for whoever administers a department's install.
 * - **A bad file never blocks boot.** Unreachable, unparseable, or full of nonsense values: the
 *   loader warns and returns defaults. A typo must not brick a department's deployment, and it
 *   must not be able to take the app down for everyone who opens it.
 * - **Every field is validated, and an invalid one is dropped individually** — a bad support
 *   email does not cost you the asset mode.
 * - **Comments and trailing commas are allowed.** The example file is commented, and "copy it
 *   and edit" has to be literally true. Both strippers are string-aware because the values here
 *   are exactly the kind that contain `//` — a support URL would otherwise be silently truncated
 *   at `https:`. Trailing commas matter for the same practical reason: **commenting out a field
 *   leaves the comma before it dangling**, which is what a site admin does first and what strict
 *   JSON refuses. This was caught by the example file failing its own parser.
 *
 * ## Load order
 *
 * {@link loadDeployConfig} is awaited once, early in `boot()`, and stashes the result.
 * Consumers then read it synchronously via {@link deployConfig}. Everything that reads it does
 * so on demand (the Help menu when opened, the runtimes when first needed), well after boot —
 * but a NEW consumer that runs during module evaluation would see defaults, so read it inside a
 * function, never at the top level.
 *
 * Not covered, deliberately: `manifest.json` (PWA name, icons, theme colour) is read by the
 * BROWSER, not by us, so a department's app identity cannot be set from here. That file is
 * edited directly — see docs/DEPLOY.md.
 */

/** Where the optional settings file lives, relative to the document. */
export const DEPLOY_FILE = './deploy.json';

/** Ids a site may not claim as its plugin namespace (they mean something to the engine). */
const RESERVED_NAMESPACES = new Set(['builtin', 'core', 'ct', 'crosstab']);

/** The project's own repo — the default every Help link derives from. Exported because
 * `core/help.js` has always published it as `REPO`, and one definition beats two in step. */
export const DEFAULT_REPO = 'crosstab-stats/crosstab';

/** The defaults — every one of these is the constant this file replaced. */
const DEFAULTS = Object.freeze({
  /** GitHub `owner/repo` the Help menu's deep links point at. */
  repo: DEFAULT_REPO,
  /** Full URL for "report a bug"; derived from `repo` when absent. */
  issuesUrl: null,
  /** Full URL for "ask a question"; derived from `repo` when absent. */
  discussionsUrl: null,
  /** A support address for a deploy that would rather take mail than GitHub issues (#175). */
  supportEmail: null,
  /** Who runs this deployment, shown where the support routes are offered. */
  siteName: null,
  /** 'cdn' | 'local' — where the heavy runtimes come from (see core/assets.js). */
  assetsMode: null,
  /** Partial per-URL overrides for the runtimes, e.g. mirror WebR only. */
  assets: null,
  /** Extra hostnames the offline cache may keep runtime payloads from (a local mirror). */
  runtimeHosts: [],
  /** Slice 2: a directory of the site's own plugins, and the namespace they get. */
  pluginDir: null,
  pluginNamespace: 'site',
  /** Fields this deployment set that were dropped, as `{field, why}` — surfaced in the app so
   * the person who edited the file finds out. A console warning nobody reads is not feedback. */
  issues: [],
  /** True once a file was found and applied, so the UI can say "hosted by …" only when it
   * actually means something. */
  applied: false,
});

/** The resolved config for this session. Set once by {@link loadDeployConfig}. */
let resolved = Object.freeze({ ...DEFAULTS });
let loaded = false;

/**
 * The deployment's settings. Safe to call before the load (returns defaults), so a consumer
 * never has to care whether boot has reached the fetch yet.
 */
export function deployConfig() {
  return resolved;
}

/**
 * Merge in problems found reading the deployment's OTHER files (its plugin index), so there is
 * exactly ONE list to read.
 *
 * This exists because there were briefly two: the launcher merged `deployConfig().issues` with a
 * list the caller had already composed from the same source, and reported every settings problem
 * twice (owner, 2026-09-27: "it said two settings not applied even though I only uncommented one
 * line"). One list, one owner.
 *
 * @param {Array<{file?:string, field:string, why:string, line?:number|null}>} extra
 */
export function addDeployIssues(extra) {
  if (!Array.isArray(extra) || !extra.length) return resolved;
  resolved = Object.freeze({ ...resolved, issues: [...resolved.issues, ...extra] });
  return resolved;
}

/**
 * Which line of a hand-edited file a field is on, so a complaint can point at it.
 *
 * Searches the COMMENT-STRIPPED text, which is the trick that makes this reliable: the stripper
 * replaces comments with blank lines rather than deleting them, so line numbers still match the
 * file the user is looking at — and a commented-out `// "repo": …` cannot be mistaken for the
 * live one.
 *
 * @param {string} text the file's raw contents @param {string} field the key (or path) to find
 * @returns {number|null} 1-based line, or null if it is not literally in the text
 */
export function findFieldLine(text, field) {
  if (!text || !field) return null;
  const needle = `"${field}"`;
  const lines = stripJsonComments(String(text)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
}

/** Whether a `deploy.json` was actually found and applied (for the About/diagnostics line). */
export function deployConfigLoaded() {
  return loaded;
}

/**
 * Fetch and apply `deploy.json`, if the deployment ships one. Never throws.
 *
 * @param {{fetch?: typeof fetch, url?: string}} [opts]
 * @returns {Promise<object>} the resolved config (also available via {@link deployConfig})
 */
export async function loadDeployConfig({ fetch: f = globalThis.fetch, url = DEPLOY_FILE } = {}) {
  let text = null;
  try {
    const res = await f(url, { cache: 'no-store' });
    // A 404 is the normal case for the stock build: no file, no configuration, no noise.
    if (res.ok) text = await res.text();
  } catch {
    /* offline, blocked, no fetch — defaults stand */
  }
  if (text == null) return resolved;
  const raw = parseDeployConfig(text);
  if (!raw) {
    console.warn(`[deploy] ${url} could not be parsed — ignoring it and using the built-in defaults.`);
    return resolved;
  }
  const validated = validateDeployConfig(raw);
  // Point at the line, because this file is hand-edited and "expected owner/repo" without a
  // location is a scavenger hunt in a file full of commented examples (owner, 2026-09-27).
  const issues = validated.issues.map((i) => ({ ...i, file: 'deploy.json', line: findFieldLine(text, i.field) }));
  resolved = Object.freeze({ ...validated, issues, applied: true });
  loaded = true;
  return resolved;
}

/**
 * Parse the settings file, tolerating comments. Returns the object, or null if it is not
 * usable — the caller warns and carries on with defaults.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseDeployConfig(text) {
  try {
    const value = JSON.parse(stripTrailingCommas(stripJsonComments(String(text ?? ''))));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remove `//` and slash-star comments from JSON text, **without touching string contents**.
 *
 * The string-awareness is the whole point: the values in this file are repo paths, support
 * URLs and mirror hostnames, so a naive stripper would cut `"https://example.edu"` down to
 * `"https:` and produce either a parse error or — worse — a valid file with a mangled URL.
 *
 * @param {string} src
 * @returns {string} the same text with comments replaced by nothing (newlines preserved, so
 *   a JSON parse error still reports a useful line number)
 */
export function stripJsonComments(src) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'; // keep line numbers honest
        i++;
      }
      i += 1; // the loop's i++ consumes the '/'
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Drop commas that are followed only by whitespace and a closing brace or bracket.
 *
 * Not cosmetic tolerance: comment out a field in this file and the comma on the line before it
 * is suddenly trailing, so a strict parse would reject the file and the deployment would
 * silently fall back to our defaults. String-aware for the same reason as
 * {@link stripJsonComments} — a value may legitimately contain `,}`.
 *
 * @param {string} src @returns {string}
 */
export function stripTrailingCommas(src) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '}' || src[j] === ']') continue; // the comma had nothing after it
    }
    out += c;
  }
  return out;
}

/**
 * Check every field, keep the good ones, drop the bad ones with a reason. One bad value must
 * not cost the others: a department that fat-fingers its support email should still get its
 * asset mode.
 *
 * @param {object} raw
 * @returns {object} defaults with the valid overrides applied
 */
export function validateDeployConfig(raw) {
  const out = { ...DEFAULTS, issues: [] };
  // Both channels on purpose: the console for whoever is looking at it, and the list for the
  // launcher, because the person who edited this file is not watching a console.
  const warn = (field, why) => {
    out.issues.push({ field, why });
    console.warn(`[deploy] ignoring "${field}": ${why}`);
  };

  if ('repo' in raw) {
    // owner/repo, which is all the Help deep links interpolate.
    if (typeof raw.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(raw.repo)) out.repo = raw.repo;
    else warn('repo', 'expected "owner/repo"');
  }
  for (const field of ['issuesUrl', 'discussionsUrl']) {
    if (!(field in raw)) continue;
    const v = raw[field];
    if (v == null || v === '') continue;
    if (isHttpUrl(v)) out[field] = v;
    else warn(field, 'expected an http(s) URL');
  }
  if ('supportEmail' in raw && raw.supportEmail != null && raw.supportEmail !== '') {
    // Deliberately loose: one @, no spaces. Validating email properly is a fool's errand, and
    // the cost of a wrong address here is a mailto that does not reach anyone — visible, not silent.
    if (typeof raw.supportEmail === 'string' && /^[^\s@]+@[^\s@]+$/.test(raw.supportEmail)) {
      out.supportEmail = raw.supportEmail;
    } else warn('supportEmail', 'expected an address like support@example.edu');
  }
  if ('siteName' in raw && raw.siteName != null && raw.siteName !== '') {
    if (typeof raw.siteName === 'string' && raw.siteName.length <= 120) out.siteName = raw.siteName.trim();
    else warn('siteName', 'expected a short string');
  }
  if ('assetsMode' in raw && raw.assetsMode != null) {
    if (raw.assetsMode === 'cdn' || raw.assetsMode === 'local') out.assetsMode = raw.assetsMode;
    else warn('assetsMode', 'expected "cdn" or "local"');
  }
  if ('assets' in raw && raw.assets != null) {
    if (typeof raw.assets === 'object' && !Array.isArray(raw.assets)) out.assets = raw.assets;
    else warn('assets', 'expected an object of URL overrides');
  }
  if ('runtimeHosts' in raw && raw.runtimeHosts != null) {
    const hosts = Array.isArray(raw.runtimeHosts) ? raw.runtimeHosts.filter((h) => isHostname(h)) : [];
    if (Array.isArray(raw.runtimeHosts) && hosts.length === raw.runtimeHosts.length) out.runtimeHosts = hosts;
    else {
      warn('runtimeHosts', 'expected an array of bare hostnames');
      out.runtimeHosts = hosts;
    }
  }
  if ('pluginDir' in raw && raw.pluginDir != null && raw.pluginDir !== '') {
    if (isSafeRelativeDir(raw.pluginDir)) out.pluginDir = String(raw.pluginDir).replace(/\/+$/, '');
    else warn('pluginDir', 'expected a same-origin relative directory like "site-plugins"');
  }
  if ('pluginNamespace' in raw && raw.pluginNamespace != null && raw.pluginNamespace !== '') {
    const ns = String(raw.pluginNamespace).toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(ns)) warn('pluginNamespace', 'expected a short slug like "sdsu"');
    else if (RESERVED_NAMESPACES.has(ns)) warn('pluginNamespace', `"${ns}" is reserved by the engine`);
    else out.pluginNamespace = ns;
  }
  return out;
}

/** The Help menu's routes, derived once so every caller agrees. */
export function supportLinks(cfg = deployConfig()) {
  return {
    repo: `https://github.com/${cfg.repo}`,
    issues: cfg.issuesUrl || `https://github.com/${cfg.repo}/issues/new`,
    discussions: cfg.discussionsUrl || `https://github.com/${cfg.repo}/discussions`,
    email: cfg.supportEmail || null,
    siteName: cfg.siteName || null,
  };
}

function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHostname(h) {
  return typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h) && !h.includes('/') && h.length <= 253;
}

/**
 * A relative, same-origin directory. Absolute URLs, protocol-relative `//host`, and `..`
 * escapes are refused: this names a folder the deployment serves, and a settings file should
 * not be a way to point the plugin loader at somebody else's host.
 */
function isSafeRelativeDir(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const s = v.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.startsWith('/')) return false;
  return !s.split('/').includes('..');
}
