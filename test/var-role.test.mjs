/**
 * @file var-role.test.mjs
 * #188 — one predicate for "is this categorical", and the compatibility it must keep.
 *
 * The reported symptom was small: a GSS weight could not be chosen as a weight until it
 * was retyped, though no data changed. The cause was that `type` answered four different
 * questions at once and `factor` said yes to all of them. These tests pin the rule that
 * replaced it, and — more importantly — pin the fallback that makes it a no-op for every
 * project saved before it existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCategorical, isQuantitative, labelForValue } from '../core/var-role.js';

// --- the compatibility floor --------------------------------------------------

test('a legacy factor with no measurement level is still categorical', () => {
  // Every project saved before #188 looks like this. If this test fails, the change is
  // not a refinement — it is a migration, and it silently reclassifies stored work.
  assert.equal(isCategorical({ type: 'factor' }), true);
  assert.equal(isQuantitative({ type: 'factor' }), false);
});

test('a plain numeric with no measurement level is still quantitative', () => {
  assert.equal(isCategorical({ type: 'numeric' }), false);
  assert.equal(isQuantitative({ type: 'numeric' }), true);
});

test('text is categorical no matter what the measure claims', () => {
  // "Scale text" is not a claim anything can act on: there is no arithmetic to do.
  assert.equal(isCategorical({ type: 'string', measurementLevel: 'scale' }), true);
  assert.equal(isQuantitative({ type: 'string', measurementLevel: 'scale' }), false);
});

// --- the fix ------------------------------------------------------------------

test('measure beats type: a factor the FILE calls Scale is a quantity', () => {
  // The GSS weight. It carries value labels for special codes, so the importer typed it
  // `factor`; SPSS itself says Scale. The file's statement is about meaning and wins.
  const weight = { type: 'factor', measurementLevel: 'scale', valueLabels: { 9: 'No answer' } };
  assert.equal(isCategorical(weight), false);
  assert.equal(isQuantitative(weight), true);
});

test('measure beats type the other way too: a numeric marked nominal is categorical', () => {
  // The mirror, and the reason the 17 modelling sites had to migrate: a site still
  // testing `type === 'factor'` would fit this as a straight-line SLOPE.
  const race = { type: 'numeric', measurementLevel: 'nominal', valueLabels: { 1: 'A', 2: 'B' } };
  assert.equal(isCategorical(race), true);
  assert.equal(isQuantitative(race), false);
});

test('ordinal is deliberately BOTH', () => {
  // A Likert scale groups and it ranks. Refusing either would be the same over-claiming
  // the old single field did, pointed the other way.
  const likert = { type: 'factor', measurementLevel: 'ordinal' };
  assert.equal(isCategorical(likert), true);
  assert.equal(isQuantitative(likert), true);
});

test('quantitative is not simply the negation of categorical', () => {
  // If it were, one predicate would do — and ordinal would have to be wrongly forced
  // into one camp.
  const likert = { type: 'factor', measurementLevel: 'ordinal' };
  assert.notEqual(isQuantitative(likert), !isCategorical(likert));
});

test('a missing or empty meta answers no to both rather than throwing', () => {
  for (const m of [null, undefined, {}]) {
    assert.equal(isCategorical(m), false);
    assert.equal(isQuantitative(m), m === null || m === undefined ? false : true);
  }
});

// --- labels are about codes, not about storage --------------------------------

test('a value label is found whatever the variable type says', () => {
  const numericWithLabels = { type: 'numeric', valueLabels: { 9: 'No answer' } };
  assert.equal(labelForValue(numericWithLabels, 9), 'No answer');
  assert.equal(labelForValue(numericWithLabels, '9'), 'No answer', 'string and number codes agree');
  assert.equal(labelForValue(numericWithLabels, 5), null, 'an unlabelled code prints itself');
});

test('no labels, no label — and no crash', () => {
  assert.equal(labelForValue({ type: 'factor' }, 1), null);
  assert.equal(labelForValue(null, 1), null);
  assert.equal(labelForValue({ valueLabels: { 1: 'x' } }, null), null);
  assert.equal(labelForValue({ valueLabels: { 1: '' } }, 1), null, 'an empty label is not a label');
});
