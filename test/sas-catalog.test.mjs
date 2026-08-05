/**
 * @file sas-catalog.test.mjs
 * Joining a SAS `.sas7bdat` to its companion `.sas7bcat` (#150-adjacent).
 *
 * SAS keeps value labels OUT of the data file: the data records a FORMAT NAME per
 * variable and the labels live in a separate catalog. Importing only the data gives
 * bare codes where SAS itself shows labels — complete-looking, and half the story.
 *
 * The join is by format name, and it only works once ReadStat's width/decimal suffix
 * is stripped off (readstat_sas7bdat_read.c appends them: `AGEGRP` → `AGEGRP8.2`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sasFormatKey } = await import('../plugins/builtin-readstat-codec/index.js');

test('a bare format name is unchanged', () => {
  assert.equal(sasFormatKey('AGEGRP'), 'AGEGRP');
});

test('ReadStat\'s width suffix is stripped', () => {
  assert.equal(sasFormatKey('AGEGRP8'), 'AGEGRP');
});

test('width AND decimal suffix are stripped', () => {
  assert.equal(sasFormatKey('AGEGRP8.2'), 'AGEGRP');
});

test('a trailing dot with no digits goes too', () => {
  // SAS writes format references with a trailing period; the catalog files them without.
  assert.equal(sasFormatKey('AGEGRP.'), 'AGEGRP');
  assert.equal(sasFormatKey('AGEGRP8.'), 'AGEGRP');
});

test('a character format keeps its leading $ — that is the name, not a width', () => {
  assert.equal(sasFormatKey('$REGION'), '$REGION');
  assert.equal(sasFormatKey('$REGION12.'), '$REGION');
});

test('digits inside the name survive; only the trailing run is a suffix', () => {
  // A format legitimately named e.g. `Q1GRP` must not become `Q1GRP` minus anything
  // internal — the suffix is anchored at the end.
  assert.equal(sasFormatKey('Q1GRP'), 'Q1GRP');
  assert.equal(sasFormatKey('Q1GRP8.2'), 'Q1GRP');
});

test('empty / missing formats resolve to an empty key, never a crash', () => {
  for (const v of ['', null, undefined]) assert.equal(sasFormatKey(v), '');
});

test('an empty key must not accidentally match a label set', () => {
  // The importer only prompts when `sasFormatKey(format)` is truthy, so a variable
  // with no format cannot collide with a catalog set — this pins the precondition.
  assert.equal(Boolean(sasFormatKey('')), false);
  assert.equal(Boolean(sasFormatKey('AGEGRP8.')), true);
});
