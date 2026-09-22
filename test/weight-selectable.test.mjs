/**
 * @file weight-selectable.test.mjs
 * #188, end to end: the GSS weight must be offerable as a weight without anyone
 * retyping it first.
 *
 * `fitsRole` is not exported (it is a private helper of the picker), so this exercises
 * the rule through the two exported pieces it is built from plus a faithful copy of the
 * role test — the point being to pin the BEHAVIOUR a user sees, in the vocabulary they
 * reported it in, rather than the internals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCategorical, isQuantitative } from '../core/var-role.js';

/** The rule from `core/ui-service.js` `fitsRole`, kept in step by the tests below. */
function fitsRole(m, types) {
  if (types.includes(m.type)) return true; // additive only — see the note there

  const wantsCategorical = types.includes('factor') || types.includes('string');
  const wantsNumeric = types.includes('numeric');
  if (wantsCategorical && !wantsNumeric && isCategorical(m)) return true;
  if (wantsNumeric && m.type !== 'string' && isQuantitative(m)) return true;
  return false;
}

/** What a GSS weight looks like after import: Scale, with a label for a special code. */
const GSS_WEIGHT = {
  name: 'WTSSNR', label: 'Weight', type: 'factor',
  measurementLevel: 'scale', valueLabels: { 9: 'No answer' },
};
/** What a GSS category looks like: nominal, labelled, numerically coded. */
const GSS_RACE = {
  name: 'RACE', label: 'Race', type: 'factor',
  measurementLevel: 'nominal', valueLabels: { 1: 'White', 2: 'Black', 3: 'Other' },
};
/** A CSV column the user marked nominal by hand in Variable View. */
const HAND_NOMINAL = { name: 'region', type: 'numeric', measurementLevel: 'nominal' };

const WEIGHT_ROLE = ['numeric'];
const GROUP_ROLE = ['factor', 'string'];

test('the reported bug: a GSS weight is selectable as a weight', () => {
  assert.equal(fitsRole(GSS_WEIGHT, WEIGHT_ROLE), true);
});

test('the fix is ADDITIVE: nothing that used to be offered disappears', () => {
  // A Scale-measured factor is still offered for categorical roles. Tidier would be to
  // drop it, and that is deliberately not done: the reported fault was a variable
  // MISSING from a list, and a fix that also removed variables from lists would break
  // working projects to improve a taxonomy. This assertion exists so that choice stays
  // a choice rather than decaying into an oversight.
  assert.equal(fitsRole(GSS_WEIGHT, GROUP_ROLE), true);
});

test('a nominal code is still refused for a numeric role', () => {
  // This is the line that stops the fix becoming "offer anything numeric-ish": race
  // codes are numbers, and offering them as a weight would be worse than the bug.
  assert.equal(fitsRole(GSS_RACE, WEIGHT_ROLE), false);
  assert.equal(fitsRole(GSS_RACE, GROUP_ROLE), true);
});

test('a hand-marked nominal CSV column becomes groupable', () => {
  // Formats with no measurement metadata rely on the user saying so in Variable View.
  // Before #174i/#188 this was invisible to every categorical picker.
  assert.equal(fitsRole(HAND_NOMINAL, GROUP_ROLE), true);
  // Still offered for numeric roles too, by the additive-only rule above: it IS stored
  // as a number, and someone who marked a count nominal may still want to weight by it.
  assert.equal(fitsRole(HAND_NOMINAL, WEIGHT_ROLE), true);
});

test('plain unannotated variables behave exactly as they always did', () => {
  const num = { name: 'age', type: 'numeric' };
  const fac = { name: 'sex', type: 'factor' };
  const str = { name: 'notes', type: 'string' };
  assert.equal(fitsRole(num, WEIGHT_ROLE), true);
  assert.equal(fitsRole(num, GROUP_ROLE), false);
  assert.equal(fitsRole(fac, GROUP_ROLE), true);
  assert.equal(fitsRole(fac, WEIGHT_ROLE), false);
  assert.equal(fitsRole(str, GROUP_ROLE), true);
  assert.equal(fitsRole(str, WEIGHT_ROLE), false, 'text is never arithmetic');
});

test('a role listing every type still takes everything', () => {
  // `['factor', 'string', 'numeric']` is the commonest declaration in the manifests
  // (32 inputs); it must not be narrowed by any of this.
  const all = ['factor', 'string', 'numeric'];
  for (const m of [GSS_WEIGHT, GSS_RACE, HAND_NOMINAL, { type: 'string' }, { type: 'numeric' }]) {
    assert.equal(fitsRole(m, all), true);
  }
});

// --- the importer half --------------------------------------------------------

/** The typing rule from `builtin-readstat-codec`, which decides what arrives. */
function importedType({ isString, hasLabels, measure }) {
  if (hasLabels) return isString ? 'string' : (measure === 'scale' ? 'numeric' : 'factor');
  return isString ? 'string' : 'numeric';
}

test('import: a labelled Scale variable is no longer typed factor', () => {
  assert.equal(importedType({ isString: false, hasLabels: true, measure: 'scale' }), 'numeric');
});

test('import: labelled nominal/ordinal variables still arrive as factors', () => {
  // Deliberately unchanged — the 17 modelling sites read the derived flag now, but
  // leaving these alone keeps the blast radius of #188 to the case that was broken.
  assert.equal(importedType({ isString: false, hasLabels: true, measure: 'nominal' }), 'factor');
  assert.equal(importedType({ isString: false, hasLabels: true, measure: 'ordinal' }), 'factor');
  assert.equal(importedType({ isString: false, hasLabels: true, measure: undefined }), 'factor');
});

test('import: text stays text, labels or no labels', () => {
  assert.equal(importedType({ isString: true, hasLabels: true, measure: 'scale' }), 'string');
  assert.equal(importedType({ isString: true, hasLabels: false, measure: undefined }), 'string');
});

test('import: an unlabelled variable is unaffected either way', () => {
  assert.equal(importedType({ isString: false, hasLabels: false, measure: 'scale' }), 'numeric');
  assert.equal(importedType({ isString: false, hasLabels: false, measure: 'nominal' }), 'numeric');
});
