/**
 * @file plugin-presets.test.mjs
 * #162 — saving a working set of plugins under a name.
 *
 * The case: a researcher doing *qualitative psychology with a regional dimension* needs CAQDAS
 * and spatial and the usual psych set — a combination no single discipline names, so the
 * `Recommended for <discipline>` pin cannot express it and they rebuild it by hand on every
 * fresh launch.
 *
 * What is worth testing is not the storage (a JSON array) but the three rules that decide
 * whether a preset can be trusted a year after it was saved:
 *
 *  1. **Ids, not just keys.** A key is an install-location detail that dies on a repackage;
 *     a manifest id survives. Both are written, either resolves.
 *  2. **Infrastructure is unioned in.** A preset saved before the Parquet codec existed must
 *     not leave its owner unable to open a Parquet file.
 *  3. **A plugin this install does not have is REPORTED, not dropped.** Silently applying a
 *     smaller set than the one that was saved is the failure this feature could most easily
 *     have shipped with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deletePreset,
  exportPresetFile,
  listPresets,
  presetExists,
  presetFileName,
  parsePresetFile,
  presetFromSelection,
  renamePreset,
  resolvePreset,
  savePreset,
} from '../core/plugin-presets.js';

/** A localStorage stand-in, so none of this needs a browser. */
function memStore(initial = null) {
  const mem = new Map();
  if (initial != null) mem.set('crosstab.plugin.presets', initial);
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    get raw() { return mem.get('crosstab.plugin.presets'); },
  };
}

/** A catalogue shaped like `PluginManager#list()`. */
const CATALOGUE = [
  { key: './plugins/builtin-caqdas/index.js', id: 'builtin-caqdas', category: 'Analyze' },
  { key: './plugins/builtin-spatial/index.js', id: 'builtin-spatial', category: 'Analyze' },
  { key: './plugins/builtin-sem/index.js', id: 'builtin-sem', category: 'Analyze' },
  { key: './plugins/builtin-csv-codec/index.js', id: 'builtin-csv-codec', category: 'Data' },
  { key: './plugins/builtin-html-export/index.js', id: 'builtin-html-export', category: 'Export' },
];
const INFRA = new Set(['Data', 'Export', 'Import']);
const short = (keys) => [...keys].map((k) => k.split('/')[2]).sort();

// =============================================================================
// Saving
// =============================================================================

test('a preset records both id and key for every plugin', () => {
  const store = memStore();
  const chosen = presetFromSelection(CATALOGUE, ['./plugins/builtin-caqdas/index.js']);
  savePreset('Qual', chosen, store);
  assert.deepEqual(listPresets(store), [
    { name: 'Qual', plugins: [{ id: 'builtin-caqdas', key: './plugins/builtin-caqdas/index.js' }] },
  ]);
});

test('a preset stores plugins and nothing else', () => {
  // The built-in launch presets carry a data source because they back `?launch=` links. A
  // user's preset must compose with ANY start choice, so a source would only get in the way.
  const store = memStore();
  savePreset('Qual', presetFromSelection(CATALOGUE, ['./plugins/builtin-caqdas/index.js']), store);
  const saved = listPresets(store)[0];
  assert.deepEqual(Object.keys(saved).sort(), ['name', 'plugins']);
  assert.deepEqual(Object.keys(saved.plugins[0]).sort(), ['id', 'key']);
});

test('saving over a name replaces it rather than making a second one', () => {
  const store = memStore();
  savePreset('Set', presetFromSelection(CATALOGUE, ['./plugins/builtin-caqdas/index.js']), store);
  savePreset('set', presetFromSelection(CATALOGUE, ['./plugins/builtin-sem/index.js']), store);
  assert.equal(listPresets(store).length, 1, 'two presets differing only in case is a useless dropdown');
  assert.equal(listPresets(store)[0].plugins[0].id, 'builtin-sem');
  assert.ok(presetExists('SET', store));
});

test('a nameless or empty preset is refused', () => {
  const store = memStore();
  assert.throws(() => savePreset('   ', [{ id: 'x' }], store), /needs a name/);
  assert.throws(() => savePreset('Empty', [], store), /at least one plugin/);
  assert.deepEqual(listPresets(store), []);
});

test('rename refuses a collision; delete is idempotent', () => {
  const store = memStore();
  savePreset('A', [{ id: 'builtin-sem' }], store);
  savePreset('B', [{ id: 'builtin-caqdas' }], store);
  assert.throws(() => renamePreset('A', 'b', store), /already exists/);
  renamePreset('A', 'A2', store);
  assert.deepEqual(listPresets(store).map((p) => p.name), ['A2', 'B']);
  deletePreset('B', store);
  deletePreset('B', store); // already gone — not an error
  assert.deepEqual(listPresets(store).map((p) => p.name), ['A2']);
  assert.throws(() => renamePreset('ghost', 'x', store), /no preset called/);
});

test('a corrupt or hand-edited store reads as "no presets" rather than throwing', () => {
  // The launcher is the first screen; a bad value here must not be able to stop it.
  for (const bad of ['not json', '{"not":"an array"}', '[1,2,3]', '[{"name":"x"}]', '']) {
    assert.deepEqual(listPresets(memStore(bad)), [], `threw or kept junk for ${bad}`);
  }
});

// =============================================================================
// Applying
// =============================================================================

test('a preset resolves by id when the install location has changed', () => {
  // The repackage case: same plugin, new path. Matching on key alone would lose it.
  const moved = [{ key: './site-plugins/caqdas/index.js', id: 'builtin-caqdas', category: 'Analyze' }];
  const { keys, missing } = resolvePreset({ plugins: [{ id: 'builtin-caqdas', key: './plugins/builtin-caqdas/index.js' }] }, moved);
  assert.deepEqual([...keys], ['./site-plugins/caqdas/index.js']);
  assert.deepEqual(missing, []);
});

test('infrastructure is unioned in, never left to the preset', () => {
  // Saved before the codecs existed: applying it must not leave the user unable to open a file.
  const { keys } = resolvePreset({ plugins: [{ id: 'builtin-caqdas' }] }, CATALOGUE, { infraCategories: INFRA });
  assert.deepEqual(short(keys), ['builtin-caqdas', 'builtin-csv-codec', 'builtin-html-export']);
});

test('without infra categories a preset selects exactly what it names', () => {
  const { keys } = resolvePreset({ plugins: [{ id: 'builtin-caqdas' }] }, CATALOGUE);
  assert.deepEqual(short(keys), ['builtin-caqdas']);
});

test('a plugin this install does not have is reported, not silently dropped', () => {
  const { keys, missing } = resolvePreset(
    { plugins: [{ id: 'builtin-caqdas' }, { id: 'lab-custom-thing' }, { key: './gone/index.js' }] },
    CATALOGUE,
  );
  assert.deepEqual(short(keys), ['builtin-caqdas'], 'what IS here still applies');
  assert.deepEqual(missing, ['lab-custom-thing', './gone/index.js']);
});

test('an empty or malformed preset resolves to nothing rather than everything', () => {
  // The dangerous failure would be treating "no plugins named" as "select all".
  for (const preset of [{ plugins: [] }, {}, null, { plugins: 'nope' }]) {
    const { keys, missing } = resolvePreset(preset, CATALOGUE);
    assert.equal(keys.size, 0, `selected something for ${JSON.stringify(preset)}`);
    assert.deepEqual(missing, []);
  }
  // ...though infra still comes in, because that is not the preset's choice to make.
  assert.equal(resolvePreset({ plugins: [] }, CATALOGUE, { infraCategories: INFRA }).keys.size, 2);
});

test('presetFromSelection reads the picker’s chosen keys', () => {
  const chosen = presetFromSelection(CATALOGUE, new Set([
    './plugins/builtin-sem/index.js',
    './plugins/builtin-spatial/index.js',
    './nonexistent/index.js', // a stale key in the selection must not invent an entry
  ]));
  assert.deepEqual(chosen.map((p) => p.id), ['builtin-spatial', 'builtin-sem']);
});

// =============================================================================
// The file form (#162 phase 2) — a preset a lab lead can hand out
// =============================================================================

/**
 * The owner's use for it: a course handbook whose chapter one says *"import this file to
 * enable the plugins you'll need"*. That makes the format a teaching artefact, which sets the
 * bar for two things — it round-trips exactly, and when it cannot be read it says something a
 * student can act on instead of "unexpected token".
 *
 * The safety property is worth stating because it is what makes handing the file to a class
 * reasonable: **a preset names plugins, it does not carry them.** Importing selects from what
 * the install already has and reports the rest; a file from a stranger is no more dangerous
 * than a list of names.
 */
test('a preset survives export and import unchanged', () => {
  const preset = { name: 'Soc 301 — Week 1', plugins: [{ id: 'builtin-crosstabs', key: './plugins/builtin-crosstabs/index.js' }] };
  assert.deepEqual(parsePresetFile(exportPresetFile(preset)), preset);
});

test('the file names itself in a way a student and an LMS will both accept', () => {
  assert.equal(presetFileName('Soc 301 — Week 1'), 'crosstab-preset-soc-301-week-1.json');
  assert.equal(presetFileName(''), 'crosstab-preset-preset.json');
  // .json rather than a house extension: an LMS that blocks unknown types would stop a
  // handbook's chapter one dead.
  assert.ok(presetFileName('x').endsWith('.json'));
});

test('a bare list of ids is accepted — the hand-written case', () => {
  // A lab lead may well write this by hand rather than exporting one.
  const out = parsePresetFile('{"name":"Lab kit","plugins":["builtin-sem","builtin-caqdas"]}');
  assert.deepEqual(out.plugins, [{ id: 'builtin-sem', key: null }, { id: 'builtin-caqdas', key: null }]);
});

test('a file that cannot be used says what is wrong with it', () => {
  // Opened from a file picker, where a parser's own wording tells the reader nothing.
  const cases = [
    ['not json at all', /not JSON/],
    ['[]', /one object/],
    ['{"plugins":["a"]}', /no name/],
    ['{"name":"Empty","plugins":[]}', /lists no plugins/],
    ['{"crosstabPreset":99,"name":"X","plugins":["a"]}', /newer CrossTab/],
  ];
  for (const [text, why] of cases) {
    assert.throws(() => parsePresetFile(text), why, `accepted ${text}`);
  }
});

test('an imported preset is resolved like any other — reported, not silently shrunk', () => {
  // The handbook case with a plugin this install lacks: the student has to be told, or they
  // work through chapter two wondering why a menu is missing.
  const file = exportPresetFile({ name: 'Kit', plugins: [{ id: 'builtin-caqdas' }, { id: 'lab-only-thing' }] });
  const { keys, missing } = resolvePreset(parsePresetFile(file), CATALOGUE, { infraCategories: INFRA });
  assert.ok(keys.has('./plugins/builtin-caqdas/index.js'));
  assert.deepEqual(missing, ['lab-only-thing']);
});
