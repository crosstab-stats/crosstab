/**
 * @file unpacker-single.test.mjs
 * One R-result unpacker, and no local copy growing back.
 *
 * `stdlib-unpack.test.mjs` pins what `unpackR` DOES. This pins that nothing reimplements
 * it, because the defects it replaced were not wrong answers so much as *second* answers:
 * 47 copies across 45 plugins, `num` meaning a scalar in 28 of them and a vector in 10,
 * and 12 turning R's NA into `0`.
 *
 * ## Why this scans for the plumbing and not for a name
 *
 * The copies were called `flat`, `normalizeResult`, `flatList` AND `plain`. A by-name
 * scan found 45 of them and missed `flatList` in builtin-bootstrap — which is how a
 * `r.num(` survived the first sweep. What they all share is the `{names, values}` →
 * `byName` + `arr` plumbing, so that is what this looks for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { unpackR } from '../core/plugin-stdlib.js';

function plugins() {
  const out = [];
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = `plugins/${d.name}/index.js`;
    if (existsSync(f)) out.push([d.name, f]);
  }
  return out;
}

const code = (f) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('no plugin reimplements the unpacker plumbing', () => {
  // builtin-descriptives keeps its own `plain()`: its R returns a NESTED list (a list of
  // named vectors, one per group) which unpackR does not model, and it had ALREADY found
  // and fixed the NA-becomes-zero bug locally — its comment records a trimmed mean
  // printing as 0. Rewriting a correct plugin to share a shape it does not have would be
  // churn with a real chance of breaking it.
  const ALLOWED = new Set(['builtin-descriptives']);
  const offenders = [];
  for (const [name, file] of plugins()) {
    if (ALLOWED.has(name)) continue;
    const src = code(file);
    // The signature of every copy: unwrapping an R vector's `.values`.
    if (/Array\.isArray\(\w+\?\.values\)/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'take unpackR from globalThis.ctStd instead');
});

test('no plugin rebuilds the names/values pairing by hand', () => {
  const ALLOWED = new Set(['builtin-descriptives']);
  const offenders = [];
  for (const [name, file] of plugins()) {
    if (ALLOWED.has(name)) continue;
    if (/\.names\.forEach\(\(\w+, \w+\) => \(?\w+\[\w+\] = /.test(code(file))) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'unpackR does this');
});

test('the retired accessor names are called nowhere', () => {
  // `num` was a scalar in 28 plugins and a vector in 10; `str` a vector in one and a
  // scalar in another. They do not exist on the shared object, so a stale call throws —
  // but a stale call is still a bug, and this says so at the source rather than at run
  // time in front of a user.
  const offenders = [];
  for (const [name, file] of plugins()) {
    const src = code(file);
    for (const m of src.matchAll(/(?<![\w.$])r\.(num|str|n1|s1)\(/g)) {
      offenders.push(`${name}: r.${m[1]}() — ambiguous, use nums/num1/strs/str1`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every plugin that unpacks a result binds unpackR', () => {
  const offenders = [];
  for (const [name, file] of plugins()) {
    const src = code(file);
    const uses = /(?<![\w.$])r\.(nums|num1|strs|str1|has|raw)\(/.test(src);
    if (!uses) continue;
    const bind = /^const \{ ([^}]+) \} = globalThis\.ctStd;$/m.exec(src);
    const bound = new Set((bind?.[1] ?? '').split(',').map((s) => s.trim()));
    const hasIt = [...bound].some((b) => b === 'unpackR' || b.startsWith('unpackR:'));
    if (!hasIt) offenders.push(`${name}: uses the accessors without binding unpackR`);
  }
  assert.deepEqual(offenders, [], 'these would throw ReferenceError when the analysis runs');
});

test('a field-mapping unpacker maps every field its plugin reads', () => {
  // This is the test whose absence let a whole table ship empty. builtin-regression's R
  // has computed ssReg/ssRes/dfReg/dfResid/sigma since its ANOVA table landed (fe4c4f1),
  // the tables read `m.ssReg` and friends — and normalizeResult never mapped any of them,
  // so every Sum of Squares, df and Mean Square cell, plus Model Summary's Std. Error of
  // the Estimate, rendered as an em dash from the day it shipped.
  //
  // The structure WAS tested ("regression splits Model Summary from the ANOVA table"),
  // but only the captions and column headers. Nothing read a value out of a cell, and a
  // table full of dashes looks exactly like a table of genuinely missing statistics.
  const offenders = [];
  for (const [name, file] of plugins()) {
    const src = code(file);
    const def = new RegExp('^function (normalizeResult|flat)\\((\\w+)\\) \\{([\\s\\S]*?)^\\}', 'm').exec(src);
    if (!def) continue;
    const keys = new Set([...def[3].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]));
    if (!keys.size) continue; // accessor-style, covered by the binding test above
    // Which variable holds the unpacked result, and what is read off it.
    for (const asg of src.matchAll(new RegExp(`const (\\w+) = ${def[1]}\\(`, 'g'))) {
      const v = asg[1];
      // Skip a line that binds the same short name as an arrow PARAMETER — both
      // builtin-regression and builtin-logistic write
      // `getVariableMeta()).map((m) => [m.name, m])` while also holding the unpacked
      // result in `m`, and that `m.name` is the metadata's, not the result's. Judging it
      // per line keeps the check sharp everywhere else rather than disabling it for the
      // whole file.
      const shadow = new RegExp(`\\(\\s*${v}\\s*[,)]\\s*(?:=>|\\w)`);
      for (const line of src.split('\n')) {
        if (shadow.test(line)) continue;
        for (const use of line.matchAll(new RegExp(`(?<![\\w.$])${v}\\.(\\w+)\\b(?!\\s*\\()`, 'g'))) {
          if (!keys.has(use[1])) offenders.push(`${name}: reads ${v}.${use[1]}, which ${def[1]} does not map`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], [], 'an unmapped field is undefined, and prints as an em dash');
});

test('a missing number cannot reach a results cell as zero', () => {
  // The defect, stated once as a property rather than per plugin. R's NA and NaN both
  // arrive as null; `Number(null)` is 0; a results table then shows a finding where the
  // statistic was never computed. Demonstrated in the live app before the fix: a
  // regression on a collinear predictor printed `VIF 0.00`, and a VIF is never below 1.
  const r = unpackR({ names: ['v'], values: [{ type: 'double', values: [null, 2] }] });
  assert.ok(Number.isNaN(r.nums('v')[0]));
  assert.ok(Number.isNaN(r.num1('v')));
  assert.notEqual(r.nums('v')[0], 0);
});
