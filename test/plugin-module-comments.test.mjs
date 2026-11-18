/**
 * @file plugin-module-comments.test.mjs
 * The module-closure scanner read comments as imports.
 *
 * ## What happened
 *
 * Every built-in plugin carries a JSDoc type import:
 *
 *     \/** @type {import('../../core/loader.js').PluginManifest} *\/
 *
 * `scanRelativeImports` matched it with its dynamic-`import()` pattern, `flatName`
 * rejected the `../`, and the loader warned. Once per plugin, 64 times a session:
 *
 *     [plugin ./plugins/builtin-clusterse/index.js] The plugin imports
 *     “../../core/loader.js”. A plugin's modules must sit beside its entry …
 *
 * Nothing was broken by it — the specifier was skipped, as designed. The cost was that
 * it filled the console, and it was what the owner found there while trying to read the
 * diagnostics for an import that died at 3.1 GiB.
 *
 * ## The asymmetry these tests are really about
 *
 * Comment stripping is not parsing, and the stripper here mis-lexes a regex literal
 * containing a slash-slash. So it gates the WARNINGS only; module collection still walks
 * the raw source. A mis-lex therefore withholds a complaint, and can never drop a module
 * the plugin needs. The last two tests pin that direction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const { collectModuleClosure, scanRelativeImports, stripComments } = await import('../core/plugin-modules.js');

/** A reader over an in-memory set of sibling files. */
const reader = (files) => async (name) => (name in files ? files[name] : null);

// =============================================================================
// The fix
// =============================================================================

test('a JSDoc type import is not reported', async () => {
  const src = [
    "/** @type {import('../../core/loader.js').PluginManifest} */",
    'export const manifest = { id: 1 };',
  ].join('\n');
  const { modules, issues } = await collectModuleClosure(src, reader({}));
  assert.deepEqual(issues, [], 'nothing to complain about');
  assert.deepEqual(modules, {});
});

test('a real “../” import is still reported', async () => {
  const src = "import { x } from '../../core/loader.js';\n";
  const { issues } = await collectModuleClosure(src, reader({}));
  assert.equal(issues.length, 1);
  assert.match(issues[0].why, /must sit beside its entry/);
});

test('a line comment mentioning an import is not reported', async () => {
  const src = "// import './old.js' — removed in v2\nexport const manifest = {};\n";
  const { issues } = await collectModuleClosure(src, reader({}));
  assert.deepEqual(issues, [], 'a stale comment is not a missing file');
});

test('a genuinely missing sibling is still reported', async () => {
  const src = "import './util.js';\n";
  const { issues } = await collectModuleClosure(src, reader({}));
  assert.equal(issues.length, 1);
  assert.match(issues[0].why, /does not include/);
});

test('a real sibling import still works', async () => {
  const src = "import './util.js';\n";
  const { modules, issues } = await collectModuleClosure(src, reader({ 'util.js': 'export const u = 1;' }));
  assert.deepEqual(issues, []);
  assert.deepEqual(Object.keys(modules), ['util.js']);
});

// =============================================================================
// stripComments itself
// =============================================================================

test('a string containing comment syntax is left alone', () => {
  const src = "const a = 'https://example.com/x'; const b = '/* not a comment */'; const c = 1;";
  const out = stripComments(src);
  assert.match(out, /https:\/\/example\.com\/x/, 'a URL is not a line comment');
  assert.match(out, /const c = 1/, "a '/*' inside a string did not swallow the file");
});

test('block and line comments go, newlines stay', () => {
  const src = "a\n/* one\n   two */\nb // three\nc\n";
  const out = stripComments(src);
  assert.doesNotMatch(out, /one|two|three/);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line numbering survives');
});

// =============================================================================
// The asymmetry: a mis-lex costs a warning, never a module
// =============================================================================

test('a regex literal with a slash-slash defeats the stripper, as documented', () => {
  const src = "const re = /https:\\/\\//; import '../nope.js';";
  // Honest about the limitation rather than pretending it is not there.
  assert.ok(!scanRelativeImports(stripComments(src)).includes('../nope.js'),
    'the stripper lost the rest of that line');
});

test('…and collection still finds the module anyway', async () => {
  const src = "const re = /https:\\/\\//; import './util.js';";
  const { modules, issues } = await collectModuleClosure(src, reader({ 'util.js': 'export const u = 1;' }));
  assert.deepEqual(Object.keys(modules), ['util.js'],
    'the walk reads RAW source, so the module is bundled despite the mis-lex');
  assert.deepEqual(issues, [], 'only the warning was withheld');
});

// =============================================================================
// The real workload: every shipped plugin
// =============================================================================

test('no shipped plugin reports a module issue', async () => {
  const dir = new URL('../plugins/', import.meta.url);
  const names = readdirSync(dir).filter((n) => existsSync(new URL(`${n}/index.js`, dir)));
  assert.ok(names.length > 50, `expected the full plugin set, found ${names.length}`);

  const offenders = [];
  for (const name of names) {
    const entry = new URL(`${name}/index.js`, dir);
    const src = readFileSync(entry, 'utf8');
    const { issues } = await collectModuleClosure(src, async (f) => {
      const sibling = new URL(`${name}/${f}`, dir);
      return existsSync(sibling) ? readFileSync(sibling, 'utf8') : null;
    });
    if (issues.length) offenders.push(`${name}: ${issues.map((i) => i.specifier).join(', ')}`);
  }
  assert.deepEqual(offenders, [], `${names.length} plugins scanned; these still complain`);
});
