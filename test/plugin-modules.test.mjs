/**
 * @file plugin-modules.test.mjs
 * Multi-file plugins: the host half — working out which of its own files a plugin needs.
 *
 * **These tests carry more weight than usual, and it is worth being precise about what they
 * can and cannot show.** The owner cannot test this remotely, so there will be no browser
 * pass. What was verified on a real device is the *platform mechanism*:
 * `spike/multi-file-plugin-probe.html` ran on iOS 18.7 and confirmed that an import map
 * injected into an opaque-origin sandbox resolves a blob module's relative specifier. These
 * tests cover the code that drives that mechanism — scanning, resolving, and the shapes handed
 * to the frame. The join between the two (the frame actually installing the map) is exercised
 * by the probe, not by node.
 *
 * The rules under test, and why each exists:
 *
 *  1. **Every import form is found.** A missed specifier means a module never gets sent and
 *     the plugin fails at run time with a resolution error — so the scanner is tested against
 *     each spelling, including the side-effect import that an earlier version silently ate.
 *  2. **A missing or unsupported module is reported, never fatal.** Specifiers are found by
 *     scanning text, so a commented-out import looks exactly like a real one. Throwing would
 *     turn a stale comment into a broken plugin.
 *  3. **The walk terminates.** Cycles are normal in module graphs; a plugin importing itself
 *     in a loop must not hang an activation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MODULES,
  collectModuleClosure,
  flatName,
  moduleKeyAliases,
  scanRelativeImports,
} from '../core/plugin-modules.js';

/** A reader over a fake plugin directory. */
const reader = (files) => async (name) => (name in files ? files[name] : null);

// =============================================================================
// Finding the imports
// =============================================================================

test('every import form a plugin might use is found', () => {
  const src = [
    "import { a } from './named.js';",
    "import def from './default.js';",
    "import def2, { x as y } from './mixed.js';",
    "import './side-effect.js';", // no binding — the one an earlier regex swallowed
    "import './no-semicolon.js'",
    "export { b } from './reexport.js';",
    "export * from './star.js';",
    "const lazy = await import('./dynamic.js');",
    "import {\n  over,\n  lines,\n} from './multiline.js';",
  ].join('\n');
  assert.deepEqual(scanRelativeImports(src).sort(), [
    './default.js', './dynamic.js', './mixed.js', './multiline.js', './named.js',
    './no-semicolon.js', './reexport.js', './side-effect.js', './star.js',
  ]);
});

test('only the plugin’s own files are collected', () => {
  const src = [
    "import a from './mine.js';",
    "import b from 'bare-package';",
    "import c from 'https://cdn.example/thing.js';",
    "import d from '/absolute.js';",
    "import e from 'node:fs';",
  ].join('\n');
  assert.deepEqual(scanRelativeImports(src), ['./mine.js']);
});

test('a specifier is reported once however often it appears', () => {
  const src = "import { a } from './util.js';\nimport { b } from './util.js';";
  assert.deepEqual(scanRelativeImports(src), ['./util.js']);
});

test('nothing is found in a single-file plugin — the case every built-in is today', () => {
  // This is what keeps the feature free for the 63 existing plugins: no specifiers, no
  // closure walk, no extra fetches on activation.
  assert.deepEqual(scanRelativeImports('export const manifest = { id: "x" };\nexport function run() {}'), []);
});

// =============================================================================
// What v1 supports, and what it says about the rest
// =============================================================================

test('a flat sibling is supported; a subdirectory or a climb is not', () => {
  assert.equal(flatName('./util.js'), 'util.js');
  assert.equal(flatName('./deep-name.mjs'), 'deep-name.mjs');
  for (const bad of ['./lib/util.js', '../shared.js', './a/b/c.js', './util.js?v=2', './util.js#x', 'util.js', '', './']) {
    assert.equal(flatName(bad), null, `should not be supported: ${bad}`);
  }
});

test('an unsupported layout is named in the issue, not silently skipped', async () => {
  const { modules, issues } = await collectModuleClosure("import './lib/deep.js';", reader({}));
  assert.deepEqual(modules, {});
  assert.equal(issues.length, 1);
  assert.match(issues[0].why, /must sit beside its entry/);
  assert.match(issues[0].why, /lib\/deep\.js/, 'the message has to name the file');
});

// =============================================================================
// Walking the graph
// =============================================================================

test('a module’s own imports are collected too', () => {
  return collectModuleClosure("import './a.js';", reader({
    'a.js': "import './b.js'; export const a = 1;",
    'b.js': "import './c.js'; export const b = 2;",
    'c.js': 'export const c = 3;',
  })).then(({ modules, issues }) => {
    assert.deepEqual(Object.keys(modules).sort(), ['a.js', 'b.js', 'c.js']);
    assert.deepEqual(issues, []);
  });
});

test('a cycle terminates rather than hanging the activation', async () => {
  const { modules } = await collectModuleClosure("import './a.js';", reader({
    'a.js': "import './b.js'; export const a = 1;",
    'b.js': "import './a.js'; export const b = 2;", // back to a
  }));
  assert.deepEqual(Object.keys(modules).sort(), ['a.js', 'b.js']);
});

test('a runaway graph stops at the cap', async () => {
  // Generated or pathological sources must not turn one activation into a thousand fetches.
  const files = {};
  for (let i = 0; i < MAX_MODULES + 20; i++) files[`m${i}.js`] = `import './m${i + 1}.js'; export const v = ${i};`;
  const { modules, issues } = await collectModuleClosure("import './m0.js';", reader(files));
  assert.equal(Object.keys(modules).length, MAX_MODULES);
  assert.ok(issues.some((i) => /at most/.test(i.why)));
});

// =============================================================================
// Not fatal — the rule that protects the plugins that already work
// =============================================================================

test('a module that cannot be read is reported, and the rest still load', async () => {
  const { modules, issues } = await collectModuleClosure(
    "import './present.js';\nimport './absent.js';",
    reader({ 'present.js': 'export const p = 1;' }),
  );
  assert.deepEqual(Object.keys(modules), ['present.js'], 'one bad specifier must not cost the others');
  assert.equal(issues.length, 1);
  assert.match(issues[0].why, /does not include/);
});

test('a reader that throws is an issue, not an exception', async () => {
  // A fetch can reject outright (offline, blocked). Activation should still proceed and let
  // the import decide, rather than failing here with a network error.
  const { modules, issues } = await collectModuleClosure("import './x.js';", async () => {
    throw new Error('network down');
  });
  assert.deepEqual(modules, {});
  assert.match(issues[0].why, /network down/);
});

test('a commented-out import costs nothing but a warning', async () => {
  // The reason none of this throws: the scan is textual, so this looks exactly like a real
  // import. A plugin that works today must not start failing because of a stale comment.
  const src = "// import { old } from './removed.js';\nexport const manifest = { id: 'x' };";
  const { modules, issues } = await collectModuleClosure(src, reader({}));
  assert.deepEqual(modules, {});
  assert.equal(issues.length, 1, 'reported…');
  assert.match(issues[0].why, /does not include/); // …and the caller only warns
});

// =============================================================================
// The keys the frame's import map needs
// =============================================================================

test('several spellings of each module are registered', () => {
  // The match is literal text, because a blob base makes the specifier unresolvable as a URL.
  // "./util.js" and "util.js" are the same file to a person and different keys to the resolver.
  assert.deepEqual(moduleKeyAliases('util.js'), ['./util.js', 'util.js', './util', 'util']);
  assert.deepEqual(moduleKeyAliases('helpers.mjs'), ['./helpers.mjs', 'helpers.mjs', './helpers', 'helpers']);
  assert.deepEqual(moduleKeyAliases('data.json'), ['./data.json', 'data.json']);
  assert.deepEqual(moduleKeyAliases(''), []);
});

// =============================================================================
// The frame's copy of the rule
// =============================================================================

/**
 * The alias rule exists twice: here in `moduleKeyAliases`, and inline in plugin-host.html,
 * because a sandbox runtime cannot import a module — it has to be self-contained (a sandboxed
 * opaque-origin document cannot fetch same-origin files).
 *
 * Two copies of one rule is exactly the shape that produced the diverged plugin tooltip, the
 * "built-in" origin label and the double-counted deploy issues, all in one week. It cannot be
 * deduplicated here, so it is tested instead: the frame's code is extracted between markers
 * and run against the same inputs.
 */
test('the sandbox frame computes the same aliases as the host', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('plugin-host.html', 'utf8');
  const block = html.match(/\/\/ aliases:start[\s\S]*?\/\/ aliases:end/);
  assert.ok(block, 'the aliases:start/end seam is gone from plugin-host.html — restore it or this check is blind');

  // Run the frame's own lines, with `name` supplied and `aliases` returned.
  const frameAliases = new Function('name', `${block[0]}
return aliases;`);
  for (const name of ['util.js', 'helpers.mjs', 'data.json', 'a-b_c.js']) {
    assert.deepEqual(frameAliases(name), moduleKeyAliases(name), `diverged for ${name}`);
  }
});
