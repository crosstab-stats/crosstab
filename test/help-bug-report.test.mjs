/**
 * @file help-bug-report.test.mjs
 * The server-free bug report (#175) — and above all, what it must NOT contain.
 *
 * These are privacy tests before they are formatting tests. A GitHub issue is
 * world-readable and the report is assembled from a live session, so "diagnostics, never
 * data" has to be a property of the code and not a habit. The fixtures below deliberately
 * carry recognisable payloads — a participant's name as a cell value, an identifying
 * variable name, a file path — and every one of them must be absent from the output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `collectDiagnostics` reads `navigator` and `crossOriginIsolated` directly. Node 24
// ships a real `navigator` whose property is getter-only, so plain assignment throws —
// defineProperty is the way to stand a fake in front of it.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (TestOS) Chrome/1.0', platform: 'TestOS', onLine: true },
  configurable: true,
});
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
globalThis.fetch = async () => ({ headers: { get: () => 'Tue, 16 Sep 2026 12:00:00 GMT' } });

const { collectDiagnostics, bugReportBody, bugReportUrl, REPO } = await import('../core/help.js');

/** A session holding data nobody would want in a public issue. */
const SECRETS = ['Jane Doe', 'participant_hiv_status', 'C:/studies/confidential.sav', 'Secret Study 2026'];

const datasets = {
  active: {
    name: 'Secret Study 2026',
    rowCount: 1200,
    getVariableMeta: () => [
      { name: 'participant_hiv_status', label: 'HIV status', type: 'factor' },
      { name: 'name', label: 'Jane Doe', type: 'string' },
    ],
    getColumns: () => ({ name: ['Jane Doe'] }),
  },
  all: () => [{ name: 'Secret Study 2026' }, { name: 'C:/studies/confidential.sav' }],
};
const plugins = { list: () => [
  { id: 'builtin-logistic', activated: true },
  { id: 'builtin-sem', activated: false },
] };

test('the report carries dataset SHAPE and nothing else about the data', async () => {
  const diag = await collectDiagnostics({ datasets, plugins });
  assert.equal(diag.shape, '2 variables × 1200 rows');
  assert.equal(diag.datasets, '2');
  const text = JSON.stringify(diag);
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked: ${s}`);
});

test('nothing identifying survives into the issue body either', async () => {
  const diag = await collectDiagnostics({ datasets, plugins });
  const body = bugReportBody(diag);
  for (const s of SECRETS) assert.ok(!body.includes(s), `leaked: ${s}`);
  // …while the things that actually help a maintainer are all present.
  assert.match(body, /1200 rows/);
  assert.match(body, /Cross-origin isolated: true/);
  assert.match(body, /builtin-logistic/);
});

const loader = { list: () => [{ id: 'builtin-logistic' }, { id: 'builtin-frequencies' }] };

test('the plugin list comes from the LOADER, which is what is actually wired', async () => {
  const diag = await collectDiagnostics({ datasets, loader, plugins });
  assert.equal(diag.plugins, 'builtin-logistic, builtin-frequencies');
});

test('a not-yet-probed catalog cannot empty the plugin list (iPhone PWA, 2026-09-21)', async () => {
  // The first real report off a device said "Plugins enabled: (none)" for a session with
  // every core plugin running. Cause: the manager reports `activated` by joining the
  // loaded set against the persisted CATALOG, and a CATALOG_VERSION bump clears that
  // catalog — so right after installing a new build, every entry reads activated:false.
  // That is precisely when someone files a bug, so the report has to not depend on it.
  const blindManager = { list: () => [
    { id: 'builtin-logistic', activated: false },
    { id: 'builtin-frequencies', activated: false },
  ] };
  const diag = await collectDiagnostics({ datasets, loader, plugins: blindManager });
  assert.match(diag.plugins, /builtin-logistic/);
  assert.match(diag.plugins, /builtin-frequencies/);
});

test('with no loader it falls back to the manager, and still filters to enabled', async () => {
  const diag = await collectDiagnostics({ datasets, plugins });
  assert.match(diag.plugins, /builtin-logistic/);
  assert.ok(!diag.plugins.includes('builtin-sem'), 'a disabled plugin is not part of the session');
});

test('a genuinely plugin-free session reports none, and says so in the body', async () => {
  // Not every "(none)" is the bug above — this is what the honest empty case looks like.
  const diag = await collectDiagnostics({ datasets, loader: { list: () => [] }, plugins: { list: () => [] } });
  assert.equal(diag.plugins, '');
  assert.match(bugReportBody(diag), /Plugins enabled: \(none\)/);
});

test('no dataset open is reported as such, not as a crash', async () => {
  const diag = await collectDiagnostics({ datasets: { all: () => [], active: null }, plugins });
  assert.equal(diag.datasets, '0');
  assert.equal(diag.shape, 'none open');
});

test('an unreadable session degrades to a word, never an exception', async () => {
  const diag = await collectDiagnostics({
    datasets: { all: () => { throw new Error('duckdb gone'); } },
    plugins: { list: () => { throw new Error('loader gone'); } },
  });
  assert.equal(diag.shape, 'unreadable');
  assert.equal(diag.plugins, 'unreadable');
  // A bug report that cannot be built is the one moment you most need a bug report.
  assert.match(bugReportBody(diag), /Cross-origin isolated/);
});

test('the three prompts are left blank for the reporter to fill in', async () => {
  const body = bugReportBody(await collectDiagnostics({ datasets, plugins }));
  assert.match(body, /### What happened/);
  assert.match(body, /### What you expected instead/);
  assert.match(body, /### Steps to reproduce/);
  // A pre-filled "1. ..." reads as already answered and gets submitted untouched.
  assert.ok(!/### Steps to reproduce\n\n1\./.test(body));
});

test('the body warns that the issue is public', async () => {
  const body = bugReportBody(await collectDiagnostics({ datasets, plugins }));
  assert.match(body, /will be public/i);
});

// --- the URL budget ----------------------------------------------------------

test('a normal report fits the URL and is not clipped', async () => {
  const { url, clipped } = bugReportUrl(await collectDiagnostics({ datasets, plugins }));
  assert.equal(clipped, false);
  assert.ok(url.startsWith(`https://github.com/${REPO}/issues/new?labels=bug`));
  assert.ok(url.length < 6000, `url was ${url.length}`);
});

test('a huge error sheds the error rather than the report', () => {
  const diag = {
    build: 'x', browser: 'y', platform: '', isolated: 'true', online: 'true',
    datasets: '1', shape: '2 variables × 3 rows', plugins: 'p',
    error: 'boom\n'.repeat(4000),
  };
  const { url, clipped } = bugReportUrl(diag);
  assert.equal(clipped, true);
  assert.ok(url.length <= 6000, `url was ${url.length}`);
  // The prompts must survive — they are the part only the human can supply.
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.match(body, /### What happened/);
  assert.match(body, /### Steps to reproduce/);
  assert.match(body, /too long for this link/);
});

test('even an absurd plugin list cannot produce an over-long URL', () => {
  const diag = {
    build: 'x', browser: 'y'.repeat(300), platform: 'z'.repeat(100), isolated: 'true',
    online: 'true', datasets: '9', shape: 's', plugins: 'plugin-name, '.repeat(2000),
    error: 'e'.repeat(5000),
  };
  const { url, clipped } = bugReportUrl(diag);
  assert.equal(clipped, true);
  assert.ok(url.length <= 6000, `url was ${url.length}`);
});

test('a blank project says it is blank, not just 0 x 0', async () => {
  // 0 variables x 0 rows is the TRUE reading for a blank start, and it looks exactly
  // like a diagnostics failure. Saying which removes a wrong guess from triage.
  const blank = {
    all: () => [{}],
    active: { rowCount: 0, getVariableMeta: () => [] },
  };
  const diag = await collectDiagnostics({ datasets: blank, loader });
  assert.equal(diag.datasets, '1');
  assert.match(diag.shape, /^0 variables × 0 rows \(blank project/);
});
