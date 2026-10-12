/**
 * @file reporting-formatters.test.mjs
 * One implementation of each reporting formatter, and no local copies growing back.
 *
 * ## Why a source scan
 *
 * The companion file, `stdlib-reporting.test.mjs`, pins what the formatters DO. This one
 * pins where they come from, because the failure being prevented is not a wrong answer —
 * it is a *second* answer. On 2026-10-12 a scan of the 60 compute plugins found:
 *
 *     fmtP     32 copies, 5 variants, THREE spellings of the same p-value
 *     rStr     32 copies, 2 variants, the newline fix in only two of them
 *     metaMap  34 copies, 3 variants
 *     f        38 copies, 4 variants
 *     labelOf  27 copies, 3 variants
 *     ci       18 copies, 3 variants
 *
 * None of it was decided. Each plugin got a helper when it was written and whichever
 * convention its author typed became that file's house style — and writing a one-line
 * formatter is faster than finding the one that already exists, which is why this needs a
 * test and not a note. A new plugin that types `function fmtP` fails here.
 *
 * Two local copies survive ON PURPOSE, as wrappers over the shared implementation rather
 * than reimplementations: a four-decimal `ci` where three would print `[0.000, 0.001]`,
 * and a bare-label `labelOf` for plot legends and prose. Those are parameter choices, and
 * the asserts below require them to be exactly that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as std from '../core/plugin-stdlib.js';

/** The names that must have exactly one implementation. Local alias in parentheses. */
const SHARED = ['fmtP', 'fmtPInline', 'fixed', 'rounded', 'ci', 'labelOf', 'metaMap', 'rStr'];
/** What a plugin calls them, which is not always what the stdlib exports them as. */
const LOCAL = { fixed: 'f', rounded: 'int' };

function plugins() {
  const out = [];
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = `plugins/${d.name}/index.js`;
    if (existsSync(f)) out.push([d.name, f]);
  }
  return out;
}

/** Source with comments removed — a formatter named in prose is not a definition. */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

test('the stdlib exports every shared formatter', () => {
  for (const name of SHARED) {
    assert.equal(typeof std[name], 'function', `plugin-stdlib must export ${name}`);
  }
});

test('no plugin defines its own copy of a shared formatter', () => {
  // Wrappers are declared here and checked for shape in the next test. Anything else is
  // a reimplementation, which is how 188 copies accumulated.
  const ALLOWED = new Map([
    ['builtin-margins', ['ci']],
    ['builtin-meta', ['ci']],
    ['builtin-trend', ['ci']],
    ['builtin-var', ['labelOf']],
    ['builtin-mixture', ['labelOf']],
    ['builtin-compare', ['metaMap']],
    ['builtin-nonparametric', ['metaMap']],
    ['builtin-plots', ['metaMap']],
  ]);
  const offenders = [];
  for (const [name, file] of plugins()) {
    const src = code(file);
    for (const shared of SHARED) {
      const local = LOCAL[shared] ?? shared;
      if (ALLOWED.get(name)?.includes(local)) continue;
      // A top-level `function x(` or `const x =`. Indented matches are inner helpers with
      // their own scope and are not the duplication this guards.
      const def = new RegExp(`^(?:async )?(?:function ${local}\\s*\\(|const ${local} = )`, 'm');
      if (def.test(src)) offenders.push(`${name}: defines ${local}`);
    }
  }
  assert.deepEqual(offenders, [], 'take these from globalThis.ctStd instead');
});

test('nobody writes the p-value convention out by hand', () => {
  // Three copies hid from the by-name scan under other spellings: `fp` in builtin-agreement
  // (dead) and builtin-crosstabs, `pFmt` in builtin-correlation, and builtin-trend had it
  // inline in a template string mid-sentence. Guarding the NAMES would have missed all
  // four, so this guards the convention — the `< .001` literal and the 0.001 threshold
  // that goes with it. The stdlib is the only place those belong.
  // The PRINTED literal, not the 0.001 threshold — `Math.abs(v) < 0.001` is how the chart
  // tick formatters switch to scientific notation, which is unrelated and legitimate.
  const PRINTED = /['"`][^'"`\n]*<\s*0?\.001/g;
  const offenders = [];
  for (const [name, file] of plugins()) {
    const src = code(file);
    for (const m of src.matchAll(PRINTED)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], 'use fmtP / fmtPInline from globalThis.ctStd');
});

test('the copies that survive are wrappers, not reimplementations', () => {
  // The point of allowing them is that the FORMATTING is still the stdlib's; only a
  // parameter differs. A wrapper that stopped delegating would be drift with a comment.
  for (const name of ['builtin-margins', 'builtin-meta', 'builtin-trend']) {
    const src = code(`plugins/${name}/index.js`);
    assert.match(src, /ci: ciAt/, `${name} must bind the shared ci`);
    assert.match(src, /const ci = \(lo, hi\) => ciAt\(lo, hi, 4\);/, `${name} must delegate`);
  }
  for (const name of ['builtin-var', 'builtin-mixture']) {
    const src = code(`plugins/${name}/index.js`);
    assert.match(src, /labelOf: labelOfStd/, `${name} must bind the shared labelOf`);
    assert.match(
      src,
      /const labelOf = \(meta, name\) => labelOfStd\(meta, name, \{ qualify: false \}\);/,
      `${name} must delegate with qualify:false`,
    );
  }
  for (const name of ['builtin-compare', 'builtin-nonparametric', 'builtin-plots']) {
    const src = code(`plugins/${name}/index.js`);
    assert.match(src, /metaMap: metaMapOf/, `${name} must bind the shared metaMap`);
    assert.match(src, /const metaMap = async \(app\) => metaMapOf\(await app\.data\.getVariableMeta\(\)\)/, name);
  }
});

test('every plugin that calls a shared formatter binds it', () => {
  // The failure this catches is a ReferenceError at analysis time: the file parses, and
  // the error arrives when a user runs it. `node --check` cannot see it.
  const offenders = [];
  for (const [name, file] of plugins()) {
    const src = code(file);
    const bind = /^const \{ ([^}]+) \} = globalThis\.ctStd;$/m.exec(src);
    const bound = new Set();
    for (const part of (bind?.[1] ?? '').split(',')) {
      const t = part.trim();
      if (t) bound.add(t.includes(':') ? t.split(':').pop().trim() : t);
    }
    // A declaration at ANY indent puts the name in scope — a wrapper at the top level, or
    // a function-scoped local that merely shares a spelling. Several of those exist and
    // are not formatters at all: `const ci = want.has('ci')` is a boolean in
    // builtin-logistic, `const f = bandFrame(…)` is a chart frame in builtin-charts, and
    // builtin-plots' `const labelOf = labelMapper(meta, name)` maps a key to a label.
    // Short names collide; what matters here is only whether the name resolves.
    for (const shared of SHARED) {
      const local = LOCAL[shared] ?? shared;
      if (new RegExp(`^[ \\t]*(?:const|let|function) ${local}\\s*[=(]`, 'm').test(src)) bound.add(local);
    }
    for (const shared of SHARED) {
      const local = LOCAL[shared] ?? shared;
      const used = new RegExp(`(?<![\\w.$])${local}\\s*\\(`).test(src);
      // `f` and `int` are short enough to collide with a parameter of the same name.
      const shadowed = new RegExp(`\\(\\s*(?:[^()]*,\\s*)?${local}\\s*[,)]`).test(src);
      if (used && !bound.has(local) && !shadowed) offenders.push(`${name}: calls ${local}()`);
    }
  }
  assert.deepEqual(offenders, [], 'these would throw ReferenceError when the analysis runs');
});

test('a plugin reads the formatters from the frame global, not from app.std', () => {
  // `app` exists only inside an invoked function, and these are module-scope helpers in
  // 36 plugins — several exporting up to nineteen entry points. Binding per entry point
  // would be ~100 sites where a missed one silently keeps a local copy.
  const binders = plugins().filter(([, f]) => code(f).includes('globalThis.ctStd'));
  assert.ok(binders.length >= 44, `expected the compute plugins to bind it, found ${binders.length}`);
  for (const [name, file] of binders) {
    assert.match(
      code(file),
      /^const \{ [^}]+ \} = globalThis\.ctStd;$/m,
      `${name}: one destructuring line, so the dependency is visible at the top of the file`,
    );
  }
});

test('the sandbox runtime assigns the global before it imports the plugin', () => {
  // Ordering is the whole mechanism: a module body runs on import and reads ctStd during
  // evaluation. Assign it after, and every migrated plugin fails to load.
  const host = readFileSync('plugin-host.html', 'utf8');
  const assign = host.indexOf('globalThis.ctStd =');
  const importCall = host.indexOf('await importPlugin(');
  assert.ok(assign > 0, 'plugin-host.html must assign globalThis.ctStd');
  assert.ok(importCall > 0, 'plugin-host.html must call importPlugin');
  assert.ok(assign < importCall, 'ctStd must be assigned BEFORE importPlugin()');
});

test('the test runner stands in for the sandbox with the real stdlib', () => {
  // Tests import plugin modules directly, with no frame to provide the global. The
  // preload supplies it — and supplies the REAL library, since a plugin tested against
  // stub formatters would be testing the stub.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.test, /--import \.\/scripts\/test-globals\.mjs/);
  const pre = readFileSync('scripts/test-globals.mjs', 'utf8');
  assert.match(pre, /from '\.\.\/core\/plugin-stdlib\.js'/);
  assert.match(pre, /globalThis\.ctStd = Object\.freeze/);
  assert.equal(typeof globalThis.ctStd?.fmtP, 'function', 'the preload should have run');
  assert.equal(globalThis.ctStd.fmtP, std.fmtP, 'and it must be the same function');
});
