/**
 * @file weight-syntax.test.mjs
 * The frequency weight in exported syntax, and marked in Variable View.
 *
 * Two gaps left by the Weight Cases feature. The first was the more serious: a
 * `.ctscript` that cannot say which weight was in force does not reproduce the numbers
 * it claims to, and this file's own header calls that serialization "lossless,
 * bidirectional" — so a silently-dropped setting was a broken promise, not an omission.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serialize, parse } from '../core/crosstab-syntax.js';
import { scriptToSpss, scriptToStata } from '../core/script-export.js';

const VIEWS = await readFile(new URL('../core/data-views.js', import.meta.url), 'utf8');
const MGR = await readFile(new URL('../core/dataset-manager.js', import.meta.url), 'utf8');

const APPLIED = [
  { type: 'load', src: { label: 'GSS 2024', meta: [] } },
  { type: 'setWeight', name: 'wtssps' },
  { type: 'computeVar', name: 'z', expr: 'age * 2' },
  { type: 'setWeight', name: null },
];

test('the weight survives a serialize/parse round trip exactly', () => {
  const text = serialize(APPLIED, []);
  assert.match(text, /^weight by wtssps$/m);
  assert.match(text, /^weight off$/m);
  const back = parse(text);
  assert.deepEqual(back.errors, []);
  const w = back.transforms.filter((t) => t.type === 'setWeight');
  assert.deepEqual(w, [{ type: 'setWeight', name: 'wtssps' }, { type: 'setWeight', name: null }]);
});

test('a weight line is a TRANSFORM, so analyses keep their place around it', () => {
  // Analyses are positioned by how many transforms preceded them. If `setWeight` were
  // not counted, every analysis after one would be spliced back in at the wrong point
  // on a re-parse — and would then run against the wrong data.
  const text = serialize(APPLIED, [
    { pluginId: 'p', run: 'f', inputs: {}, at: 2, label: 'after the weight and the compute' },
  ]);
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(lines.indexOf('weight by wtssps'), 0);
  assert.ok(lines.findIndex((l) => l.startsWith('run ')) > lines.indexOf('compute z = age * 2'),
    'the analysis stays after the second transform');
});

test('a malformed weight line says what it expected', () => {
  const bad = parse('# x\nweight sideways\n');
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0].message ?? String(bad.errors[0]), /weight by NAME.*weight off/);
});

test('SPSS gets WEIGHT BY; Stata gets a note, not invalid syntax', () => {
  const script = 'weight by wtssps\ncompute z = age * 2\nweight off\n';
  const sps = scriptToSpss(script).text;
  assert.match(sps, /^WEIGHT BY wtssps\.$/m);
  assert.match(sps, /^WEIGHT OFF\.$/m);
  // Stata has no global weight — weighting is per command — so the mode statement would
  // be a syntax error dressed as a translation.
  const dta = scriptToStata(script).text;
  assert.ok(!/^WEIGHT BY/m.test(dta), 'no SPSS mode statement in a .do file');
  assert.match(dta, /Stata weights per command/);
});

test('Variable View marks WHICH column is the weight', () => {
  // The status bar says a weight is on; this says which, in the one list that is about
  // the variables themselves.
  assert.match(VIEWS, /const weight = this\.store\.weightVar;/);
  assert.match(VIEWS, /if \(m\.name === weight\) tr\.classList\.add\('is-weight'\)/);
  assert.match(VIEWS, /vargrid__weight/, 'and a chip, not only a row tint');
  // Colour alone is not information a colourblind or screen-reader user receives
  // (WCAG 1.4.1), and this variable silently changes the N of every analysis.
  assert.match(VIEWS, /the frequency weight'/, 'the accessible name says so too');
});

test('the manager delegates weightVar, because that is what gets passed around', () => {
  // VariableView and the gather flow are both handed the MANAGER where the JSDoc says
  // DataStore. Without the delegation `store.weightVar` reads undefined and the marker
  // silently never appears — which is exactly what happened before this line existed.
  assert.match(MGR, /get weightVar\(\) \{\s*\n\s*return this\.active\?\.weightVar \?\? null;/);
});
