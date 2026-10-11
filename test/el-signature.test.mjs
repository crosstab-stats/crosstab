/**
 * @file el-signature.test.mjs
 * One element helper, one signature, everywhere.
 *
 * ## What this is defending
 *
 * `el()` is three lines, which is exactly why it was written out nine times in core and
 * once more in each plugin that draws its own UI. By 2026-10-10 those copies had drifted
 * into **four signatures across 612 call sites**, and two of them took the same three
 * arguments in opposite order:
 *
 *     el(tag, text, className)   app, data-views, launcher, compute-recode, …   (most of core)
 *     el(tag, cls,  text)        help, encryption-settings, project-manager, caqdas
 *     el(tag, className)         builtin-spatial
 *     el(t,   c)                 builtin-decisions
 *
 * So `el('div', 'warning', 'Careful')` produced either a div classed `warning` reading
 * "Careful", or one classed `Careful` reading "warning", depending on which file you were
 * in. **Both render. One is nonsense. Nothing throws and no test fails.** Copying a line
 * between modules — the ordinary thing to do with a helper this small — silently inverted
 * it.
 *
 * The migration (2026-10-11) moved every call onto the stdlib's options form,
 * `el(tag, { class, text })`, which cannot be ordered wrong. This test is the part that
 * keeps it that way: the failure mode is invisible at runtime, so the only real defence is
 * refusing the shape.
 *
 * Why a source scan: the fault is a static one, and there is no DOM here. The rendering
 * was checked separately in the browser after the migration — the swap-detector below has
 * a live counterpart that looked for a class reading like prose, or text reading like a
 * class name, across every dialog in the app. Both came back empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

/** Every file that could call the helper. */
function sources() {
  const out = readdirSync('core').filter((f) => f.endsWith('.js')).map((f) => `core/${f}`);
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = `plugins/${d.name}/index.js`;
    if (existsSync(f)) out.push(f);
  }
  return out;
}

// `el(` — but not `.el(`, not `label(`/`cancel(`/`model(`, and not the declaration — with
// a second argument that does not begin an object literal.
const POSITIONAL = /(?<![\w.$])el\s*\(\s*[^,()]+,\s*([^,(){\s])/g;
/** `function el(tag, opts = {})` is the DECLARATION, not a call — and it takes two
 * parameters, so it reads exactly like the shape being banned. */
const IS_DECLARATION = /\bfunction\s+$/;

test('no file calls el() positionally', () => {
  const offenders = [];
  for (const file of sources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(POSITIONAL)) {
      if (IS_DECLARATION.test(src.slice(0, m.index))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], 'use el(tag, { class, text }) — the positional forms are gone');
});

test('no file reimplements it with the old positional shape', () => {
  // A new local copy is how this started. Core imports from plugin-stdlib; a plugin takes
  // app.std.el with a fallback that uses the SAME options signature.
  const offenders = [];
  for (const file of sources()) {
    if (file === 'core/plugin-stdlib.js') continue;
    const src = readFileSync(file, 'utf8');
    if (/function el\(tag,\s*(text|cls|className)/.test(src)
        || /const el = \((tag|t),\s*(cls|c|text|className)/.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'import el from plugin-stdlib (core) or take app.std.el (plugins)');
});

test('core imports the one implementation rather than keeping its own', () => {
  const importers = sources().filter((f) => f.startsWith('core/'))
    .filter((f) => readFileSync(f, 'utf8').includes("import { el } from './plugin-stdlib.js'"));
  assert.ok(importers.length >= 12, `expected the core callers to import it, found ${importers.length}`);
});

test('the plugins that draw UI take it from the host, with a fallback', () => {
  // The fallback is not decoration: a build that failed to serve the stdlib must not take
  // a workspace down with it. It has to match the stdlib's signature, or the fallback is a
  // fifth variant and the whole exercise is undone.
  for (const f of ['plugins/builtin-caqdas/index.js', 'plugins/builtin-decisions/index.js']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /const el = app\.std\?\.el \?\? \(\(tag, opts = \{\}\) => \{/, f);
    assert.match(src, /if \(opts\.class\) e\.className = opts\.class;/, f);
  }
  // Spatial's helper sits at MODULE scope, where `app` does not exist, so it is a binding
  // that mount() upgrades rather than a const taking app.std directly.
  const spatial = readFileSync('plugins/builtin-spatial/index.js', 'utf8');
  assert.match(spatial, /^let el = \(tag, opts = \{\}\) => \{/m);
  assert.match(spatial, /el = app\.std\?\.el \?\? el;/);
});
