/**
 * @file install-facts.test.mjs
 * The read-only "This install" section of the Settings screen.
 *
 * ## Why these are on a settings screen at all
 *
 * The owner's framing, and it is the right one: these are not settings in the sense of
 * "the user can change them", but they are settings in the sense of **details that change
 * how the thing works**. Whether the fast multi-threaded R path is available, which
 * deployment this copy came from, and what build is actually running are the first three
 * questions of nearly every "why is my app not working" — and the only way to see them
 * used to be to start filing a bug report, which someone only does once they have already
 * decided something is broken.
 *
 * ## Why they are NOT in the registry
 *
 * `defineSetting` is keyed on `localStorage`: a spec without a key cannot be read, written
 * or cleared. These values have no key — they are computed, some of them live, and the
 * build stamp is fetched. Forcing them in would mean inventing keys for values that have
 * none and breaking "one key, one owner" to do it, and it would put read-only facts in the
 * same list as things with Clear buttons.
 *
 * So they ride the seam `projectSettings` already established: a provider, its own row
 * renderer, its own scope heading and visible break. Same reason, different contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { environmentRows } from '../core/help.js';

const SCREEN = readFileSync('core/settings-screen.js', 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Stand in for the globals `collectDiagnostics` reads.
 *
 * ASYNC, and that is not incidental: the first version restored the globals in a sync
 * `finally`, which ran the moment `fn()` handed back its promise — i.e. before the thing
 * under test had read anything. Every case silently measured Node's own `navigator` and
 * an absent `crossOriginIsolated`, so the offline assertion passed for entirely the wrong
 * reason while the isolation one failed and gave the game away.
 */
async function withEnv({ isolated = true, online = true }, fn) {
  const g = globalThis;
  const prev = {
    nav: Object.getOwnPropertyDescriptor(g, 'navigator'),
    iso: Object.getOwnPropertyDescriptor(g, 'crossOriginIsolated'),
  };
  Object.defineProperty(g, 'navigator', {
    value: { userAgent: 'TestBrowser/1.0', platform: 'TestOS', onLine: online },
    configurable: true,
  });
  Object.defineProperty(g, 'crossOriginIsolated', { value: isolated, configurable: true });
  try {
    return await fn();
  } finally {
    if (prev.nav) Object.defineProperty(g, 'navigator', prev.nav); else delete g.navigator;
    if (prev.iso) Object.defineProperty(g, 'crossOriginIsolated', prev.iso);
    else delete g.crossOriginIsolated;
  }
}

const byLabel = (rows, label) => rows.find((r) => r.label === label);

// =============================================================================
// What the facts say
// =============================================================================

test('the rows answer the first questions of a support call', async () => {
  const rows = await withEnv({}, () => environmentRows());
  const labels = rows.map((r) => r.label);
  for (const want of ['App build', 'Install', 'Fast R path', 'Connection']) {
    assert.ok(labels.includes(want), `missing "${want}" — got ${labels.join(', ')}`);
  }
});

test('isolation is reported as what it costs you, not as a header name', async () => {
  // "Cross-origin isolation: false" is a fact about a response header. "R runs
  // single-threaded here" is the thing a person can act on or quote.
  const on = await withEnv({ isolated: true }, () => environmentRows());
  const off = await withEnv({ isolated: false }, () => environmentRows());
  assert.match(byLabel(on, 'Fast R path').value, /Available/);
  assert.match(byLabel(off, 'Fast R path').value, /single-threaded/i);
  for (const rows of [on, off]) {
    assert.doesNotMatch(byLabel(rows, 'Fast R path').value, /true|false/i,
      'a raw flag value is not an answer');
  }
});

test('the stock build says so rather than leaving a blank', async () => {
  // `installLabel()` answers '' when no deploy.json was applied, and an empty row reads as
  // a failed lookup. "Which build is this" is exactly what a support person is asking when
  // a department ships its own.
  const rows = await withEnv({}, () => environmentRows());
  const install = byLabel(rows, 'Install').value;
  assert.ok(install && install.trim(), 'never empty');
  assert.match(install, /stock/i);
});

test('offline is a fact, not an error', async () => {
  const rows = await withEnv({ online: false }, () => environmentRows());
  assert.equal(byLabel(rows, 'Connection').value, 'Offline');
  assert.match(byLabel(rows, 'Connection').hint, /cached|device/i,
    'and says what still works');
});

test('every row carries a value and reads as a sentence', async () => {
  const rows = await withEnv({}, () => environmentRows());
  for (const r of rows) {
    assert.ok(typeof r.label === 'string' && r.label, 'labelled');
    assert.ok(typeof r.value === 'string' && r.value, `"${r.label}" has a value`);
  }
});

test('a diagnostics failure does not take the section down', async () => {
  // `collectDiagnostics` already swallows its own failures; this pins that the row builder
  // does not add a new way to throw on top of it.
  await assert.doesNotReject(() => withEnv({}, () => environmentRows({ datasets: null })));
});

// =============================================================================
// Where they live, and where they do not
// =============================================================================

test('install facts are NOT declared as settings', async () => {
  // The registry is keyed on localStorage. A spec with no key cannot be read, written or
  // cleared, so putting these there would mean inventing keys for values that have none.
  const { listSettings } = await import('../core/settings.js');
  const labels = listSettings().map((s) => s.label);
  for (const fact of ['App build', 'Fast R path', 'Connection']) {
    assert.ok(!labels.includes(fact), `${fact} must not be a declared setting`);
  }
});

test('the screen renders them through a provider, like the project rows', () => {
  const src = stripComments(SCREEN);
  assert.match(src, /environment = null/, 'injected, not imported');
  assert.match(src, /text: 'This install'/, 'its own scope heading');
  assert.match(src, /ct-settings__group--install/, 'and its own visible break');
});

test('the screen never learns what any fact MEANS', () => {
  // The lesson this file already paid for once with the weight descriptor: domain
  // knowledge in a generic screen is how the wording goes wrong in two places at once.
  const src = stripComments(SCREEN);
  for (const domain of ['isolat', 'SharedArrayBuffer', 'deploy', 'single-threaded', 'build stamp']) {
    assert.doesNotMatch(src, new RegExp(domain, 'i'),
      `settings-screen.js must not mention "${domain}" — that belongs in help.js`);
  }
});

test('a read-only fact gets no control', () => {
  // The whole point of the separate renderer: there is nothing here to set, so there must
  // be no select, no Clear and no Default sitting beside a value nobody can change.
  const src = stripComments(SCREEN);
  const at = src.indexOf('const factRow =');
  assert.ok(at > 0, 'factRow is gone or renamed');
  // Bounded at the NEXT declaration, not at `row`: `projectRow` sits between them and is
  // full of selects, so the wider slice could never have failed.
  const body = src.slice(at, src.indexOf('const projectRow =', at));
  assert.ok(body.length > 100 && body.length < 1200, `factRow slice looks wrong (${body.length})`);
  assert.doesNotMatch(body, /select|clearSetting|setSetting|Default/i);
  assert.match(body, /ct-settings__value/, 'just the value');
});

test('the diagnostics are fetched once per opening, not once per render', () => {
  // `render()` runs again after every write, and collectDiagnostics fetches the build
  // stamp over the network. Re-reading it on each keystroke-driven re-render would turn a
  // settings change into a burst of requests.
  const src = stripComments(SCREEN);
  const renderAt = src.indexOf('const render = () => {');
  const renderEnd = src.indexOf('const factRow =');
  const renderBody = src.slice(renderAt, renderEnd);
  assert.doesNotMatch(renderBody, /await environment\(\)|environment\(\)\.then/,
    'render must read the cache, never call the provider');
  assert.match(renderBody, /envRows/, 'it reads the cached rows');
  assert.match(src, /envRows = \(await environment\(\)\) \|\| \[\]/, 'fetched once, outside render');
});

test('the section is honest while it is still loading, and if it fails', () => {
  const src = stripComments(SCREEN);
  assert.match(src, /envRows === null/, '"not back yet" is distinct from "empty"');
  assert.match(src, /Checking…/);
  assert.match(src, /envError/, 'and a failure says so rather than showing an empty scope');
});

test('the full details are reachable without filing a bug', () => {
  // The complete set (browser, platform, dataset shape, loaded plugins, last error) still
  // lives in the bug-report dialog, which is also the only thing that sends any of it
  // anywhere. The point is that seeing it no longer requires starting a report.
  const src = stripComments(SCREEN);
  assert.match(src, /onDetails/, 'the screen offers a way through');
  const help = stripComments(readFileSync('core/help.js', 'utf8'));
  assert.match(help, /export function showBugReport/, 'and the dialog is exported for it');
  const app = stripComments(readFileSync('core/app.js', 'utf8'));
  assert.match(app, /onShowDetails = \(\) => void showBugReport/, 'wired with the real deps');
  assert.match(app, /onEnvironment = \(\) => environmentRows\(\{ datasets, loader, plugins \}\)/,
    'and the facts read the LOADER, the authority on what is actually wired');
});
