/**
 * @file script-export.test.mjs
 * #176 — exporting the script as a Stata `.do` / SPSS `.sps` command file.
 *
 * Two kinds of assertion here, and the second is the point of the feature:
 *
 *  1. **The mappings are right** — a CASE becomes `cond()` in Stata and a `DO IF` block
 *     in SPSS, a recode's `else copy` is implicit in Stata and explicit in SPSS, and so
 *     on. These pin the everyday shapes a teaching script is made of.
 *  2. **The honesty contract holds** — anything without a clean equivalent comes out as
 *     a comment that still contains the original line verbatim, and is COUNTED as
 *     skipped. A silent mistranslation is the failure mode that matters: a file that
 *     runs but computes something else is worse than one that says what it couldn't do.
 *
 * The last block round-trips the Stata output back through `stataToScript` — the two
 * translators are inverses for the statements that map cleanly both ways, and that is a
 * stronger check on either one than reading its output ever is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scriptToStata, scriptToSpss, scriptFileName } from '../core/script-export.js';
import { stataToScript } from '../core/stata-import.js';

/** The translated lines only — no header, no comments, no blanks. */
function code(out) {
  return out.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'));
}

/** The `[CrossTab, not translated…]` comment lines. */
function refusals(out) {
  return out.text.split('\n').filter((l) => l.includes('[CrossTab, not translated'));
}

// =============================================================================
// Expressions and computes
// =============================================================================

test('a CASE becomes nested cond() in Stata and a DO IF block in SPSS', () => {
  const src = 'compute agegrp = CASE WHEN age < 30 THEN 1 WHEN age < 60 THEN 2 ELSE 3 END';
  assert.deepEqual(code(scriptToStata(src)), ['generate agegrp = cond(age < 30, 1, cond(age < 60, 2, 3))']);
  assert.deepEqual(code(scriptToSpss(src)), [
    'DO IF (age < 30).',
    'COMPUTE agegrp = 1.',
    'ELSE IF (age < 60).',
    'COMPUTE agegrp = 2.',
    'ELSE.',
    'COMPUTE agegrp = 3.',
    'END IF.',
    'EXECUTE.',
  ]);
});

test('one branch whose ELSE is the variable itself is SPSS’s IF — the shape the importer reads back', () => {
  const src = 'compute income = CASE WHEN income < 0 THEN NULL ELSE income END';
  // A bare NULL is a VALUE here (blank this row out), not an `IS NULL` test.
  assert.deepEqual(code(scriptToSpss(src)), ['IF (income < 0) income = $SYSMIS.', 'EXECUTE.']);
  // Stata: the expression mentions the target, so it is a `replace`, not a `generate`
  // (generate errors on an existing variable and replace errors on a new one).
  assert.deepEqual(code(scriptToStata(src)), ['replace income = cond(income < 0, ., income)']);
});

test('a new variable is generate; only a self-reference is replace', () => {
  assert.deepEqual(code(scriptToStata('compute z = age * 2')), ['generate z = age * 2']);
  assert.deepEqual(code(scriptToStata('compute age = age * 2')), ['replace age = age * 2']);
});

test('a SQL quoted identifier stays a NAME, not a string literal', () => {
  // "region" is a column in SQL; a regex pass would have made it a Stata string.
  const out = code(scriptToStata(`compute north = CASE WHEN "region" = 'North' THEN 1 ELSE 0 END`));
  assert.deepEqual(out, ['generate north = cond(region == "North", 1, 0)']);
});

test('IS NULL / IN / BETWEEN map to each language’s own function', () => {
  const src = 'keep if age IS NOT NULL AND marital IN (1, 2) AND income BETWEEN 0 AND 100000';
  assert.deepEqual(code(scriptToStata(src)), [
    'keep if !missing(age) & inlist(marital, 1, 2) & inrange(income, 0, 100000)',
  ]);
  assert.deepEqual(code(scriptToSpss(src)), [
    'SELECT IF (NOT MISSING(age) AND ANY(marital, 1, 2) AND RANGE(income, 0, 100000)).',
    'EXECUTE.',
  ]);
});

test('DuckDB log() is base-10, so it maps to log10 / LG10 — not ln', () => {
  assert.deepEqual(code(scriptToStata('compute l = log(income)')), ['generate l = log10(income)']);
  assert.deepEqual(code(scriptToSpss('compute l = log(income)')), ['COMPUTE l = LG10(income).', 'EXECUTE.']);
  assert.deepEqual(code(scriptToStata('compute l = ln(income)')), ['generate l = ln(income)']);
});

// =============================================================================
// Recode
// =============================================================================

test('recode: ranges, missing, and an into-variable', () => {
  const src = 'recode educ into educ3: 0..11 -> 1; 12 -> 2; 13..20 -> 3; missing -> sysmis; else copy';
  assert.deepEqual(code(scriptToStata(src)), [
    'recode educ (0/11 = 1) (12 = 2) (13/20 = 3) (missing = .), gen(educ3)',
  ]);
  // SPSS's RECODE INTO blanks every unmatched value unless told to copy, so the else
  // CrossTab leaves implicit has to be written out or the data silently changes.
  assert.deepEqual(code(scriptToSpss(src)), [
    'RECODE educ (0 THRU 11 = 1) (12 = 2) (13 THRU 20 = 3) (MISSING = SYSMIS) (ELSE = COPY) INTO educ3.',
    'EXECUTE.',
  ]);
});

test('recode in place omits the target; a non-copy else is always written', () => {
  const src = 'recode q1 into q1: 9 -> sysmis; else sysmis';
  assert.deepEqual(code(scriptToStata(src)), ['recode q1 (9 = .) (else = .)']);
  assert.deepEqual(code(scriptToSpss(src)), ['RECODE q1 (9 = SYSMIS) (ELSE = SYSMIS).', 'EXECUTE.']);
});

test('the ±1e308 bounds the importers write for LO/HI come back as min/max and LO/HI', () => {
  const src = 'recode inc into inc3: -1e308..20000 -> 1; 20001..1e308 -> 2; else copy';
  assert.match(code(scriptToStata(src))[0], /\(min\/20000 = 1\) \(20001\/max = 2\)/);
  assert.match(code(scriptToSpss(src))[0], /\(LO THRU 20000 = 1\) \(20001 THRU HI = 2\)/);
});

test('Stata’s recode is numeric-only, so a string rule is refused rather than guessed', () => {
  const src = 'recode region into reg2: "North" -> 1; else copy';
  assert.equal(scriptToStata(src).stats.skipped, 1);
  assert.match(refusals(scriptToStata(src))[0], /numeric-only/);
  // SPSS can recode strings, so the same line translates there.
  assert.equal(scriptToSpss(src).stats.skipped, 0);
  assert.match(code(scriptToSpss(src))[0], /RECODE region \('North' = 1\)/);
});

// =============================================================================
// Metadata
// =============================================================================

test('value labels: one CrossTab line becomes Stata’s label set + attachment', () => {
  const src = 'label values educ3 1 "No HS", 2 "HS"\nlabel values marital 1 "Married", 2 "Single"';
  assert.deepEqual(code(scriptToStata(src)), [
    'label define educ3_lbl 1 "No HS" 2 "HS", replace',
    'label values educ3 educ3_lbl',
    'label define marital_lbl 1 "Married" 2 "Single", replace',
    'label values marital marital_lbl',
  ]);
  assert.deepEqual(code(scriptToSpss(src)), [
    "VALUE LABELS educ3 1 'No HS' 2 'HS'.",
    "VALUE LABELS marital 1 'Married' 2 'Single'.",
  ]);
});

test('label / type / measure / missing each go to the nearest real command', () => {
  const src = [
    'label variable age "Age in years"',
    'set type zip = string',
    'set measure educ3 = ordinal',
    'set missing income = 999998, 999999',
  ].join('\n');
  assert.deepEqual(code(scriptToStata(src)), [
    'label variable age "Age in years"',
    'tostring zip, replace',
    // Stata has no measurement level — that line is a comment, not a command.
    'mvdecode income, mv(999998 999999)',
  ]);
  assert.match(refusals(scriptToStata(src))[0], /measurement level/);
  assert.deepEqual(code(scriptToSpss(src)), [
    "VARIABLE LABELS age 'Age in years'.",
    'ALTER TYPE zip (A255).',
    'VARIABLE LEVEL educ3 (ORDINAL).',
    'MISSING VALUES income (999998, 999999).',
  ]);
});

test('clearing missing values works in SPSS and is refused in Stata', () => {
  assert.deepEqual(code(scriptToSpss('set missing income = none')), ['MISSING VALUES income ().']);
  assert.match(refusals(scriptToStata('set missing income = none'))[0], /un-designate/);
});

// =============================================================================
// Column and row operations
// =============================================================================

test('drop / keep / rename', () => {
  const src = 'drop pad1, pad2\nrename educ3 to educat';
  assert.deepEqual(code(scriptToStata(src)), ['drop pad1 pad2', 'rename educ3 educat']);
  assert.deepEqual(code(scriptToSpss(src)), ['DELETE VARIABLES pad1 pad2.', 'RENAME VARIABLES (educ3 = educat).']);
  // Stata has `keep`; SPSS has no in-place equivalent, so it says what to do instead.
  assert.deepEqual(code(scriptToStata('keep age, income')), ['keep age income']);
  assert.match(refusals(scriptToSpss('keep age, income'))[0], /SAVE OUTFILE/);
});

test('a manual cell edit addresses the row, and says so', () => {
  const stata = scriptToStata('set cell row 7 age = 44');
  assert.deepEqual(code(stata), ['replace age = 44 in 7']);
  assert.match(stata.text, /same order/);
  assert.deepEqual(code(scriptToSpss('set cell row 7 age = 44')), ['IF ($CASENUM = 7) age = 44.', 'EXECUTE.']);
});

// =============================================================================
// The honesty contract
// =============================================================================

test('an untranslatable construct is commented verbatim and counted, never guessed at', () => {
  const cases = [
    ['compute w = x % 3', /uses “%”/],
    ['compute r = round(income, 2)', /does not mean the same thing/], // decimals vs multiples
    ['compute c = list_value(1, 2)', /no Stata equivalent|has no/],
    ['compute s = a || b', /uses “|”/],
    ['run builtin-frequencies.run {"vars": ["educ"]}', /analysis/],
  ];
  for (const [line, why] of cases) {
    const out = scriptToStata(line);
    assert.equal(out.stats.skipped, 1, `expected ${line} to be refused`);
    assert.equal(out.stats.translated, 0, `expected ${line} not to be translated`);
    assert.equal(code(out).length, 0, `expected no command line for ${line}`);
    const refusal = refusals(out)[0];
    assert.match(refusal, why);
    // The original survives inside the comment, so nothing is silently dropped.
    assert.ok(refusal.includes(line), `expected the original line inside: ${refusal}`);
  }
});

test('a name that is legal in CrossTab but not in the target language is refused', () => {
  // Backtick-quoted names are fine in CrossTab; Stata allows neither spaces nor dots.
  assert.match(refusals(scriptToStata('drop `my col`'))[0], /not a valid Stata variable name/);
  assert.match(refusals(scriptToStata('drop some.var'))[0], /not a valid Stata variable name/);
  // SPSS does allow a dot inside a name.
  assert.deepEqual(code(scriptToSpss('drop some.var')), ['DELETE VARIABLES some.var.']);
});

test('one refused line never costs the lines around it', () => {
  const out = scriptToStata('drop pad1\ncompute w = x % 3\nrename a to b');
  assert.deepEqual(code(out), ['drop pad1', 'rename a b']);
  assert.deepEqual(out.stats, { statements: 3, translated: 2, skipped: 1 });
});

test('the header counts match the body, and warns when anything was skipped', () => {
  const out = scriptToStata('drop pad1\ncompute w = x % 3');
  assert.match(out.text, /1 of 2 statements translated; 1 left as comments/);
  assert.match(out.text, /have NOT been applied/);
  const clean = scriptToStata('drop pad1');
  assert.match(clean.text, /1 of 1 statement translated\./);
  assert.ok(!/have NOT been applied/.test(clean.text));
});

test('Stata’s missing-is-large trap is called out only when the file can hit it', () => {
  assert.match(scriptToStata('keep if age > 30').text, /larger than any number/);
  assert.match(scriptToStata('compute a = CASE WHEN b > 1 THEN 1 ELSE 0 END').text, /larger than any number/);
  assert.ok(!/larger than any number/.test(scriptToStata('drop pad1').text));
  // SPSS's missing handling matches SQL's here, so the note would be noise.
  assert.ok(!/larger than any number/.test(scriptToSpss('keep if age > 30').text));
});

// =============================================================================
// File-level shape
// =============================================================================

test('every SPSS command is period-terminated, and EXECUTE appears once', () => {
  const src = [
    'compute z = age * 2',
    'recode educ into educ3: 1..3 -> 1; else copy',
    'keep if age > 20',
    'label variable z "Doubled age"',
  ].join('\n');
  const out = scriptToSpss(src);
  for (const line of code(out)) assert.ok(line.endsWith('.'), `not terminated: ${line}`);
  assert.equal(out.text.split('\n').filter((l) => l.trim() === 'EXECUTE.').length, 1);
  // Metadata-only scripts change nothing pending, so they need no EXECUTE.
  assert.ok(!/EXECUTE\./.test(scriptToSpss('label variable age "Age"').text));
});

test('an SPSS comment cannot terminate itself early', () => {
  // A period followed by whitespace would end the comment command and leave the rest to
  // be parsed as SPSS. Decimal points must survive.
  const out = scriptToSpss('# Ran this. Then checked 3.5 twice.');
  const line = out.text.split('\n').find((l) => l.includes('Ran this'));
  assert.equal(line, '* Ran this Then checked 3.5 twice.');
});

test('the CrossTab banner is replaced, and a data source becomes an instruction', () => {
  const out = scriptToStata('# CrossTab syntax — edit and Run to rebuild.\n# use "GSS 2014"');
  assert.ok(!/edit and Run/.test(out.text));
  assert.match(out.text, /CrossTab data source \(use\): "GSS 2014" — open it before running this\./);
  assert.deepEqual(out.stats, { statements: 0, translated: 0, skipped: 0 });
});

test('scriptFileName picks the extension', () => {
  assert.equal(scriptFileName('stata'), 'analysis.do');
  assert.equal(scriptFileName('spss'), 'analysis.sps');
  assert.equal(scriptFileName('spss', 'wave1'), 'wave1.sps');
});

// =============================================================================
// Round trip: the export and the import are inverses where both are clean
// =============================================================================

test('the statements that map cleanly both ways survive a Stata round trip', () => {
  const src = [
    'recode educ into educ3: 0..11 -> 1; 12 -> 2; else copy',
    'rename educ3 to educat',
    'drop pad1, pad2',
    'label variable age "Age in years"',
    'keep if age > 20 AND income IS NOT NULL',
  ].join('\n');
  const back = stataToScript(scriptToStata(src).text).script;
  const lines = back
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, [
    'recode educ into educ3: 0..11 -> 1; 12 -> 2; else copy',
    'rename educ3 to educat',
    'drop pad1, pad2',
    'label variable age "Age in years"',
    // Not textually identical, and it does not need to be: the export writes
    // `!missing(income)` and the importer reads that back as `NOT (income IS NULL)`
    // -- the same condition spelled the other way. What matters is that it survives
    // AS a condition on the same variable rather than degrading to a comment.
    'keep if age > 20 AND NOT (income IS NULL)',
  ]);
});
