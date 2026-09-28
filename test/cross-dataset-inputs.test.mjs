/**
 * @file cross-dataset-inputs.test.mjs
 * #179 step 2 — a variable input may name a dataset, and nothing is joined.
 *
 * The owner's case: *"if I'm selecting A from dataset1 and B from dataset2 and then run
 * frequencies there's no reason for any kind of truncation or implied relationship — frequencies
 * just returns the table per variable."*
 *
 * That rules out both obvious implementations of a combined frame, and the reason is worth
 * keeping because either would have looked fine in a screenshot:
 *
 *  - **Inner join / truncate to the shortest** silently drops cases. A variable from a 1,200-row
 *    dataset, picked beside a 1,540-row one, would report 1,200 — for an analysis with no
 *    relationship to the second dataset at all.
 *  - **Outer join / pad with NA** inflates instead. `builtin-frequencies` computes
 *    `n_valid <- sum(w[!is.na(x)])` and prints a Missing row, so that variable would report
 *    N = 1,540 with 340 missing values that never existed.
 *
 * Both are the host asserting a relationship only the analysis knows about. So the host asserts
 * nothing: **one R frame per dataset, each input bound from its own**, and each analysis's own R
 * decides. `lm(y ~ x)` across mismatched lengths raises R's "variable lengths differ" — loud,
 * and the plugin's rule rather than ours.
 *
 * What is tested here is the host half: the reference format (one owner), the grouping, the
 * prelude, and the two things a plugin would otherwise get silently wrong — colliding bare
 * names, and metadata that only knows the active dataset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  anyQualified, datasetsNamed, formatVarRef, parseVarRef, refName,
} from '../core/var-ref.js';

// =============================================================================
// The reference format
// =============================================================================

test('an unqualified reference is a bare name, exactly as before', () => {
  // The back-compat guarantee: thousands of recorded inputs and every existing script.
  assert.deepEqual(parseVarRef('income'), { dataset: null, name: 'income' });
  assert.equal(formatVarRef(null, 'income'), 'income');
  assert.equal(formatVarRef('', 'income'), 'income');
  assert.equal(anyQualified(['age', 'income']), false);
});

test('a colon qualifies, and round-trips', () => {
  assert.deepEqual(parseVarRef('Wave 2:income'), { dataset: 'Wave 2', name: 'income' });
  assert.equal(formatVarRef('Wave 2', 'income'), 'Wave 2:income');
  assert.equal(refName('Wave 2:income'), 'income');
  assert.ok(anyQualified(['age', 'Wave 2:income']));
});

test('a dataset name containing a colon is backtick-quoted', () => {
  const ref = formatVarRef('Study 3: follow-up', 'income');
  assert.equal(ref, '`Study 3: follow-up`:income');
  assert.deepEqual(parseVarRef(ref), { dataset: 'Study 3: follow-up', name: 'income' });
});

test('a variable name may itself contain a colon after the qualifier', () => {
  // Split on the FIRST colon only, so the rest belongs to the variable.
  assert.deepEqual(parseVarRef('a:b:c'), { dataset: 'a', name: 'b:c' });
});

test('an odd reference is read as an unqualified name, not an error', () => {
  // These arrive from saved projects and hand-edited scripts. Failing here would abort the
  // whole run; failing at lookup names the variable that could not be found.
  for (const odd of [':x', 'x:', '', '`unclosed', null, undefined]) {
    assert.equal(parseVarRef(odd).dataset, null, `${JSON.stringify(odd)} should not qualify`);
  }
});

test('a dot could not have been the separator', () => {
  // Dots are legal inside variable names and R/Stata users write them constantly, so
  // `wave2.income` is already a plausible single variable. The lexer takes [A-Za-z0-9_.]*.
  assert.deepEqual(parseVarRef('wave2.income'), { dataset: null, name: 'wave2.income' });
});

// =============================================================================
// Which datasets a run spans
// =============================================================================

const SPECS = [{ name: 'vars', kind: 'variables' }, { name: 'weight', kind: 'variables' }, { name: 'title', kind: 'text' }];

test('the datasets a run spans are read from its VARIABLE inputs only', () => {
  // A text input is free-form prose. A chart title like "Results: Wave 2" read as a qualifier
  // would invent a dataset nobody mentioned — and then the output would disclose a span that
  // does not exist.
  assert.deepEqual(
    datasetsNamed({ vars: ['age', 'Wave 2:income'], title: 'Results: Wave 2' }, SPECS),
    [null, 'Wave 2'],
  );
  assert.deepEqual(datasetsNamed({ vars: ['age'], title: 'A: B' }, SPECS), [null]);
});

test('“spans more than one dataset” is exactly `length > 1`', () => {
  // `null` stands for the analysis's own dataset, so it counts.
  assert.equal(datasetsNamed({ vars: ['a', 'b'] }, SPECS).length, 1);
  assert.equal(datasetsNamed({ vars: ['a', 'W2:b'] }, SPECS).length, 2);
  // Two variables from the SAME other dataset is still a span: its rows are not our rows.
  assert.equal(datasetsNamed({ vars: ['W2:a', 'W2:b'] }, SPECS).length, 1);
  assert.equal(datasetsNamed({ vars: ['W2:a'], weight: 'W3:w' }, SPECS).length, 2);
});

// =============================================================================
// The R prelude
// =============================================================================

/** The host's two prelude functions, lifted out of webr-manager (they are module-private). */
function preludeFns() {
  const src = readFileSync('core/webr-manager.js', 'utf8');
  const a = src.indexOf('function groupInputColumns');
  const b = src.indexOf('/**\n * @typedef {Object} RunResult');
  assert.ok(a > 0 && b > a, 'the prelude builders moved — this test is blind');
  return new Function('parseVarRef', `${src.slice(a, b)}
return { groupInputColumns, buildInputAliases };`)(parseVarRef);
}

const FRAMES = new Map([['', 'df'], ['Wave 2', '.ct_ds1']]);

test('a single-dataset run emits exactly the prelude it always did', () => {
  // The line that matters most in this file: 63 plugins depend on this shape.
  const { buildInputAliases } = preludeFns();
  const out = buildInputAliases({
    vars: { kind: 'variables', columns: ['a', 'b'], multiple: true },
    dv: { kind: 'variables', columns: ['c'], multiple: false },
    k: { kind: 'number', value: 3 },
    how: { kind: 'text', value: 'mean' },
    skipped: { kind: 'variables', columns: [], multiple: false },
  });
  assert.equal(out, [
    'vars <- df[c("a", "b")]',
    'dv <- df[["c"]]',
    'k <- 3',
    'how <- "mean"',
    'skipped <- NULL',
    '',
  ].join('\n'));
});

test('columns are grouped by dataset, with the active one first', () => {
  const { groupInputColumns } = preludeFns();
  const groups = [...groupInputColumns({
    vars: { kind: 'variables', columns: ['age', 'Wave 2:income'], multiple: true },
    weight: { kind: 'variables', columns: ['Wave 2:wt'], multiple: false },
    title: { kind: 'text', value: 'x' },
  })];
  assert.deepEqual(groups, [['', ['age']], ['Wave 2', ['income', 'wt']]]);
});

test('each input is bound from the frame of its own dataset', () => {
  const { buildInputAliases } = preludeFns();
  const out = buildInputAliases({
    dv: { kind: 'variables', columns: ['Wave 2:income'], multiple: false },
    iv: { kind: 'variables', columns: ['age'], multiple: false },
  }, FRAMES);
  assert.match(out, /dv <- \.ct_ds1\[\["income"\]\]/);
  assert.match(out, /iv <- df\[\["age"\]\]/);
});

test('a multi input spanning datasets becomes a LIST, never a data.frame', () => {
  // `data.frame` recycles shorter columns to a common length. That is the fabrication this
  // whole design refuses, and it would happen silently whenever one length divides the other.
  const { buildInputAliases } = preludeFns();
  const out = buildInputAliases({
    vars: { kind: 'variables', columns: ['age', 'Wave 2:income'], multiple: true },
  }, FRAMES);
  assert.match(out, /^vars <- list\(/);
  assert.equal(out.includes('data.frame'), false);
});

test('the R key is the reference, so two datasets’ `age` stay two columns', () => {
  // Keyed by bare name, `list("age" = …, "age" = …)` would give `vars[["age"]]` the first one
  // twice: the same variable reported under two labels, with no error anywhere.
  const { buildInputAliases } = preludeFns();
  const out = buildInputAliases({
    vars: { kind: 'variables', columns: ['age', 'Wave 2:age'], multiple: true },
  }, FRAMES);
  assert.match(out, /"age" = df\[\["age"\]\]/);
  assert.match(out, /"Wave 2:age" = \.ct_ds1\[\["age"\]\]/);
});

test('a qualified reference is quoted safely into R', () => {
  const { buildInputAliases } = preludeFns();
  const out = buildInputAliases({
    v: { kind: 'variables', columns: ['W:od"d', 'x'], multiple: true },
  }, new Map([['', 'df'], ['W', '.ct_ds1']]));
  assert.ok(out.includes('\\"'), 'a quote inside a name must be escaped, not closed');
});

// =============================================================================
// The two things a plugin would otherwise get wrong
// =============================================================================

test('frequencies’ own lookup shape works on a list', () => {
  // `x <- vars[[name]]` — the plugin indexes by the reference it was handed, which a named
  // list supports exactly as a data.frame does. This is why the flagship case (one multi-select
  // spanning two datasets) needs no plugin change at all.
  const src = readFileSync('plugins/builtin-frequencies/index.js', 'utf8');
  assert.match(src, /x <- vars\[\[\$\{rStr\(name\)\}\]\]/,
    'if this lookup changed shape, the list binding needs revisiting');
});

test('the host appends a note naming each dataset and its row count', () => {
  // The one thing the host is entitled to do: disclose, not decide.
  const src = readFileSync('core/plugin-actions.js', 'utf8');
  assert.match(src, /Rows are not matched across datasets/);
  assert.match(src, /#discloseSpan/);
});

test('a level input follows the reference to the right dataset', () => {
  // `variableCategories` reads the column to enumerate its categories. Against the active
  // dataset a qualified reference finds nothing, which reads as "no categories" — and for a
  // non-optional level input that aborts the whole dialog with no message at all.
  const src = readFileSync('core/plugin-actions.js', 'utf8');
  const start = src.indexOf('async function variableCategories');
  const fn = src.slice(start, src.indexOf('return keys.map', start));
  assert.match(fn, /parseVarRef\(varName\)/);
  assert.match(fn, /variables: \[name\], \.\.\.where/, 'the read must be scoped to the named dataset');
  assert.match(fn, /getVariableMeta\?\.\(where\)/, 'and so must the value labels');
});

test('a plugin reading columns itself gets them keyed by the reference it asked for', () => {
  // Five plugins bypass the R injection and read columns directly. Keyed by bare name, two
  // datasets' `age` would collapse into one and the plugin would work on the wrong data.
  const src = readFileSync('core/plugin-broker.js', 'utf8');
  assert.match(src, /#columnsAcross/);
  const fn = src.slice(src.indexOf('async #columnsAcross'), src.indexOf('/** @see the `data.getVariableMeta`'));
  assert.match(fn, /if \(!wanted \|\| !wanted\.some/, 'an ordinary request must pass straight through');
  assert.match(fn, /out\[ref\] = got\[name\]/, 'keyed by reference, read by bare name');
});

test('cross-dataset metadata is served for the datasets a run names', () => {
  // Without this a `Wave 2:income` input arrives with no label, no value labels, and its
  // user-missing codes silently un-folded — the analysis would be quietly wrong, not broken.
  const src = readFileSync('core/plugin-broker.js', 'utf8');
  assert.match(src, /#withQualifiedMeta/);
  assert.match(src, /formatVarRef\(ds, m\.name\)/, 'the extra entries must be keyed by the reference');
});

// =============================================================================
// Which dataset the RESULT belongs to
// =============================================================================

test('a cross-dataset analysis is invalidated by a re-import of EITHER parent', async () => {
  // The conservative reading, on purpose: a stale entry the user can re-run is a much smaller
  // harm than output that silently quotes data no longer there. An ordinary run is unaffected —
  // it records no `datasetIds` at all, so nothing about a saved project grows.
  const { AnalysisLog } = await import('../core/analysis-log.js');
  const { ProjectLog } = await import('../core/project-log.js');
  const log = new AnalysisLog(new ProjectLog());
  log.record({ runId: 'a', pluginId: 'p', run: 'x', label: 'own', inputs: {}, at: 0, datasetId: 1 });
  log.record({ runId: 'b', pluginId: 'p', run: 'x', label: 'spanning', inputs: {}, at: 0, datasetId: 1, datasetIds: ['1', '2'] });
  log.clearFor(2); // dataset 2 was re-imported; nothing of dataset 1's own is touched
  assert.deepEqual(log.entries().map((e) => e.label), ['own']);
});

test('the parent list is ids, so it survives a rename', () => {
  // Matched by `clearFor` against a dataset id; a renamed dataset is still the same data.
  const src = readFileSync('core/plugin-actions.js', 'utf8');
  const start = src.indexOf('#parentDatasets(inputs, specs) {');
  const fn = src.slice(start, src.indexOf('@see the disclosure note', start));
  assert.match(fn, /hit \? hit\.id : null/);
  assert.match(fn, /named\.length < 2\) return \{\}/, 'an ordinary run records no extra field');
});
