/**
 * @file deploy-config.test.mjs
 * #185 slice 1 — the one file a deployment edits to describe itself.
 *
 * Two things are being protected here, and the second is the reason the module exists at all:
 *
 *  1. **The values mean what they say** — a repo, a support address, an asset mode, a plugin
 *     namespace, with each bad field dropped on its own rather than costing the others.
 *  2. **Nothing a site can put in this file may break CrossTab.** It is edited by whoever
 *     administers a department's install, by hand, in JSON. So: a truncated file, a stray
 *     comma, a hostile value, an absent file — every one of them has to end with the app
 *     booting on its built-in defaults. A settings file that can brick the deployment is worse
 *     than the scattered constants it replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REPO,
  addDeployIssues,
  deployConfig,
  findFieldLine,
  loadDeployConfig,
  parseDeployConfig,
  stripJsonComments,
  stripTrailingCommas,
  supportLinks,
  validateDeployConfig,
} from '../core/deploy-config.js';

/** Quiet the intentional warnings so the test output stays readable. */
function mute(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

// =============================================================================
// Comments — because "copy the example file and edit it" has to be literally true
// =============================================================================

test('a URL inside a string is not mistaken for a comment', () => {
  // The trap that makes a naive stripper dangerous here: nearly every value in this file is a
  // URL, and `"https://x"` truncated to `"https:` is either a parse error or, worse, a valid
  // file with a silently wrong support address.
  const text = '{ "discussionsUrl": "https://forum.example.edu/c/crosstab" }';
  assert.equal(stripJsonComments(text), text);
  assert.equal(parseDeployConfig(text).discussionsUrl, 'https://forum.example.edu/c/crosstab');
});

test('line and block comments are stripped, and line numbers survive', () => {
  const text = [
    '{',
    '  // where reports go',
    '  "repo": "dept/crosstab", /* inline */',
    '  /* a block',
    '     over lines */',
    '  "siteName": "Example Lab"',
    '}',
  ].join('\n');
  const cfg = parseDeployConfig(text);
  assert.deepEqual(cfg, { repo: 'dept/crosstab', siteName: 'Example Lab' });
  // The stripper replaces comments with blank lines rather than deleting them, so a JSON error
  // still reports the line the human is looking at.
  assert.equal(stripJsonComments(text).split('\n').length, text.split('\n').length);
});

test('commenting out a field leaves a dangling comma, and that still parses', () => {
  // The first thing a site admin does is comment out a line they do not need — which strands
  // the comma before it. Strict JSON refuses the file; the deployment would then silently run
  // on our defaults. Found by the committed example file failing its own parser.
  const text = [
    '{',
    '  "repo": "dept/crosstab",',
    '  // "supportEmail": "help@example.edu",',
    '  // "assetsMode": "local"',
    '}',
  ].join('\n');
  assert.deepEqual(parseDeployConfig(text), { repo: 'dept/crosstab' });
  // ...and a comma that legitimately has a value after it is untouched.
  assert.deepEqual(parseDeployConfig('{ "a": 1, "b": [1, 2, ] }'), { a: 1, b: [1, 2] });
  // A value containing ",}" is not mangled.
  assert.equal(parseDeployConfig('{ "siteName": "Lab ,} of Stats" }').siteName, 'Lab ,} of Stats');
});

test('an escaped quote inside a string does not end the string early', () => {
  const text = '{ "siteName": "The \\"Stats\\" Lab // not a comment" }';
  assert.equal(parseDeployConfig(text).siteName, 'The "Stats" Lab // not a comment');
});

test('the committed example file parses, and is all-defaults', async () => {
  // It is the thing users copy, so it has to survive its own parser. And every field in it is
  // commented out or set to its default, so copying it verbatim changes nothing.
  const { readFileSync } = await import('node:fs');
  const text = readFileSync('deploy.example.json', 'utf8');
  const raw = parseDeployConfig(text);
  assert.ok(raw, 'deploy.example.json must parse');
  const cfg = mute(() => validateDeployConfig(raw));
  assert.equal(cfg.repo, DEFAULT_REPO);
  assert.deepEqual(supportLinks(cfg), {
    repo: `https://github.com/${DEFAULT_REPO}`,
    issues: `https://github.com/${DEFAULT_REPO}/issues/new`,
    discussions: `https://github.com/${DEFAULT_REPO}/discussions`,
    email: null,
    siteName: null,
  });
});

// =============================================================================
// Values
// =============================================================================

test('support routes: a fork, a custom tracker, or a mailbox', () => {
  const fork = validateDeployConfig({ repo: 'sdsu/crosstab' });
  assert.equal(supportLinks(fork).issues, 'https://github.com/sdsu/crosstab/issues/new');

  const own = validateDeployConfig({
    issuesUrl: 'https://helpdesk.example.edu/new',
    discussionsUrl: 'https://forum.example.edu',
    siteName: 'Example Lab',
  });
  const links = supportLinks(own);
  assert.equal(links.issues, 'https://helpdesk.example.edu/new');
  assert.equal(links.discussions, 'https://forum.example.edu');
  assert.equal(links.siteName, 'Example Lab');
  // The repo link still falls back to ours — they overrode where reports go, not what this is.
  assert.equal(links.repo, `https://github.com/${DEFAULT_REPO}`);

  assert.equal(supportLinks(validateDeployConfig({ supportEmail: 'help@example.edu' })).email, 'help@example.edu');
});

test('the plugin namespace is a slug, and the engine’s own prefixes are refused', () => {
  assert.equal(validateDeployConfig({ pluginNamespace: 'SDSU' }).pluginNamespace, 'sdsu');
  assert.equal(validateDeployConfig({ pluginNamespace: 'jacks-stats' }).pluginNamespace, 'jacks-stats');
  // Reserved: a site must not be able to mint ids that read as ours.
  for (const ns of ['builtin', 'core', 'crosstab', 'CT']) {
    assert.equal(mute(() => validateDeployConfig({ pluginNamespace: ns }).pluginNamespace), 'site', ns);
  }
  // Nonsense shapes fall back rather than producing broken ids.
  for (const ns of ['x', '9lives', 'has space', 'a'.repeat(40), 42, {}]) {
    assert.equal(mute(() => validateDeployConfig({ pluginNamespace: ns }).pluginNamespace), 'site', JSON.stringify(ns));
  }
});

test('a plugin directory must be relative and same-origin', () => {
  assert.equal(validateDeployConfig({ pluginDir: 'site-plugins' }).pluginDir, 'site-plugins');
  assert.equal(validateDeployConfig({ pluginDir: 'dept/plugins/' }).pluginDir, 'dept/plugins');
  // The settings file must not be a way to point the plugin loader at another host, or to
  // climb out of the deployment's own directory.
  for (const dir of ['https://evil.example/p', '//evil.example/p', '/etc', '../../secrets', 'ok/../../up']) {
    assert.equal(mute(() => validateDeployConfig({ pluginDir: dir }).pluginDir), null, dir);
  }
});

test('one bad field does not cost the others', () => {
  const cfg = mute(() => validateDeployConfig({
    repo: 'not a repo!!',
    supportEmail: 'nope',
    assetsMode: 'sideways',
    siteName: 'Example Lab',
    runtimeHosts: ['mirror.example.edu', 'https://not-a-host/x'],
  }));
  assert.equal(cfg.repo, DEFAULT_REPO); // dropped
  assert.equal(cfg.supportEmail, null); // dropped
  assert.equal(cfg.assetsMode, null); // dropped
  assert.equal(cfg.siteName, 'Example Lab'); // kept
  assert.deepEqual(cfg.runtimeHosts, ['mirror.example.edu']); // the good one kept
});

// =============================================================================
// Boot safety — the property that makes this safe to put in front of every user
// =============================================================================

test('an absent file leaves every default standing', async () => {
  const cfg = await loadDeployConfig({ fetch: async () => ({ ok: false, status: 404 }), url: './x.json' });
  assert.equal(cfg.repo, DEFAULT_REPO);
  assert.equal(cfg.pluginDir, null);
});

test('a broken file is ignored rather than fatal', async () => {
  for (const text of ['{ "repo": ', 'null', '[]', 'not json at all', '']) {
    const cfg = await mute(async () =>
      loadDeployConfig({ fetch: async () => ({ ok: true, text: async () => text }), url: './x.json' }));
    assert.equal(cfg.repo, DEFAULT_REPO, JSON.stringify(text));
  }
});

test('a fetch that throws is not fatal either', async () => {
  const cfg = await loadDeployConfig({
    fetch: async () => { throw new Error('offline'); },
    url: './x.json',
  });
  assert.equal(cfg.repo, DEFAULT_REPO);
});

test('a good file is applied and readable synchronously afterwards', async () => {
  const text = '{ "repo": "dept/crosstab", "assetsMode": "local", "pluginNamespace": "dept" }';
  const cfg = await loadDeployConfig({ fetch: async () => ({ ok: true, text: async () => text }), url: './x.json' });
  assert.equal(cfg.assetsMode, 'local');
  // Consumers read it without awaiting anything — that is why boot loads it first.
  assert.equal(deployConfig().repo, 'dept/crosstab');
  assert.equal(deployConfig().pluginNamespace, 'dept');
});

// =============================================================================
// Reporting a problem to the person who caused it (owner, on the bench, 2026-09-27)
// =============================================================================

/**
 * Two bugs from one screenshot, both about the ignored-settings panel:
 *
 *  - **One bad field was reported twice.** The launcher merged `deployConfig().issues` with a
 *    list the caller had already composed from the same source. Two copies of one list is the
 *    bug; the fix is one owner, which is what `addDeployIssues` is for.
 *  - **It named the field but not where it is.** In a hand-edited file full of commented-out
 *    examples of the very same key, "repo — expected owner/repo" is a scavenger hunt.
 */
test('an issue is recorded once, and carries where to fix it', async () => {
  const text = [
    '{',
    '  "siteName": "Example Lab",',
    '  // "repo": "a commented-out example of the same key",',
    '  "repo": "not a repo!!"',
    '}',
  ].join('\n');
  const warn = console.warn;
  console.warn = () => {};
  let cfg;
  try {
    cfg = await loadDeployConfig({ fetch: async () => ({ ok: true, text: async () => text }), url: './x.json' });
  } finally {
    console.warn = warn;
  }
  assert.equal(cfg.issues.length, 1, 'one bad field is one issue');
  assert.equal(cfg.issues[0].field, 'repo');
  assert.equal(cfg.issues[0].file, 'deploy.json');
  // Line 4, not line 3: the commented-out example of the same key must not be what it points at.
  assert.equal(cfg.issues[0].line, 4);
  assert.equal(cfg.siteName, 'Example Lab', 'the good field still applied');
});

test('the config owns the one list, and other files add to it', () => {
  const before = deployConfig().issues.length;
  addDeployIssues([{ file: 'site-plugins/index.json', field: 'bad.js', why: 'nope', line: 3 }]);
  const after = deployConfig().issues;
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).file, 'site-plugins/index.json');
  // Adding nothing changes nothing (the empty/absent cases callers actually hit).
  addDeployIssues([]);
  addDeployIssues(undefined);
  assert.equal(deployConfig().issues.length, before + 1);
});

test('findFieldLine reads the file the user sees, comments and all', () => {
  const text = ['{', '  // "a": 1,', '', '  "a": 2,', '  "b": 3', '}'].join('\n');
  assert.equal(findFieldLine(text, 'a'), 4); // the live one, not the commented example
  assert.equal(findFieldLine(text, 'b'), 5);
  assert.equal(findFieldLine(text, 'missing'), null);
  assert.equal(findFieldLine('', 'a'), null);
  assert.equal(findFieldLine(text, ''), null);
});
