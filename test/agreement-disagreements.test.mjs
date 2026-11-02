/**
 * @file agreement-disagreements.test.mjs
 * WHERE the coders differed, not just how much (#202).
 *
 * A coefficient says how much two coders agree. It does not say where they differed, and
 * the where is the thing a team acts on — it is the input to a coding-scheme revision,
 * and κ alone cannot start that conversation. The data needed no new storage: the
 * (document × code) presence matrix was already built to compute the coefficient, so the
 * disagreeing units are the rows where the coders differ.
 *
 * ## The distinction this file mostly exists to pin
 *
 * Two kinds of disagreement, and collapsing them loses what a revision needs:
 *
 *  - **presence** — one coder applied a code to a document, another did not. Usually a
 *    question about a code's definition or where its boundary sits.
 *  - **choice** — in the same document, each coder used a code the other did not use at
 *    all. Not a threshold argument: two different readings, and the one worth a meeting.
 *
 * And one thing it must NOT claim. The unit is the DOCUMENT, not the passage. "A used
 * *Waiting* and B used *Neglect*" means within the same document, not necessarily over
 * the same words — the easy phrasing would be "the same passage", and a reader acting on
 * it would go hunting for an overlap the unit model never established.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { findDisagreements } = await import('../plugins/builtin-agreement/index.js');

/** Build the shape `fromCodings` hands over, from a readable spec of who coded what. */
function fixture(spec, { quotes = {} } = {}) {
  const coders = Object.keys(spec);
  const docs = [...new Set(Object.values(spec).flat().map((u) => u.split('/')[0]))].sort();
  const codeIds = [...new Set(Object.values(spec).flat().map((u) => u.split('/')[1]))].sort();
  const applied = new Map(coders.map((c) => [c, new Set(spec[c].map((u) => u.replace('/', '\0')))]));
  const codes = new Map(codeIds.map((k) => [k, k]));
  const quoteOf = new Map(Object.entries(quotes).map(([u, q]) => [u.replace('/', '\0'), q]));
  return { docs, codeIds, coders, applied, codes, quoteOf };
}

// ---------------------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------------------

test('a unit one coder applied and another did not is a disagreement', () => {
  const d = findDisagreements(fixture({ A: ['d1/waiting'], B: [] }));
  assert.equal(d.count, 1);
  assert.deepEqual(d.rows[0].appliedBy, ['A']);
  assert.deepEqual(d.rows[0].notBy, ['B']);
  assert.equal(d.rows[0].doc, 'd1');
  assert.equal(d.rows[0].code, 'waiting');
});

test('unanimous is agreement, in BOTH directions', () => {
  // Both applied it.
  assert.equal(findDisagreements(fixture({ A: ['d1/x'], B: ['d1/x'] })).count, 0);
  // And neither did. This is the case that matters for size: in a real project the
  // overwhelming majority of (document × code) cells are empty, and listing them would
  // bury the handful of real rows under thousands of blanks.
  const none = findDisagreements({
    docs: ['d1', 'd2', 'd3'], codeIds: ['x', 'y', 'z'], coders: ['A', 'B'],
    applied: new Map([['A', new Set()], ['B', new Set()]]),
    codes: new Map(), quoteOf: new Map(),
  });
  assert.equal(none.count, 0, 'nine empty units, no rows');
});

test('three coders: a lone dissenter is listed with the majority named', () => {
  const d = findDisagreements(fixture({ A: ['d1/x'], B: ['d1/x'], C: [] }));
  assert.equal(d.count, 1);
  assert.deepEqual(d.rows[0].appliedBy, ['A', 'B']);
  assert.deepEqual(d.rows[0].notBy, ['C']);
});

test('the passage comes from whoever applied the code', () => {
  const d = findDisagreements(fixture({ A: ['d1/x'], B: [] }, { quotes: { 'd1/x': 'three hours' } }));
  assert.equal(d.rows[0].quote, 'three hours');
  // Absent is empty, not undefined: the cell is rendered either way.
  assert.equal(findDisagreements(fixture({ A: ['d1/x'], B: [] })).rows[0].quote, '');
});

// ---------------------------------------------------------------------------------------
// Choice — the half that would be lost by collapsing
// ---------------------------------------------------------------------------------------

test('different codes in the same document are reported SEPARATELY', () => {
  const d = findDisagreements(fixture({ A: ['d1/waiting'], B: ['d1/neglect'] }));
  // It is two presence disagreements...
  assert.equal(d.count, 2);
  // ...AND one choice. Both, because they are different findings about the same material:
  // the presence rows say which codes are in dispute, the choice row says the coders read
  // the document differently.
  assert.equal(d.choices.length, 1);
  assert.deepEqual(d.choices[0].pair, ['A', 'B']);
  assert.deepEqual(d.choices[0].onlyA, ['waiting']);
  assert.deepEqual(d.choices[0].onlyB, ['neglect']);
});

test('one side merely having an EXTRA code is presence, not a different reading', () => {
  // A and B agree on x; A also applied y. That is a boundary/definition question about y,
  // not two readings of the document — B did not reach for something else, B reached for
  // nothing. Reporting it as a "choice" would manufacture a disagreement.
  const d = findDisagreements(fixture({ A: ['d1/x', 'd1/y'], B: ['d1/x'] }));
  assert.equal(d.count, 1, 'the y unit');
  assert.equal(d.choices.length, 0, 'and no choice row');
});

test('a document only one coder touched at all is not a choice', () => {
  // B coded nothing in d1. There is no competing reading to report; the presence rows
  // already say everything known.
  const d = findDisagreements(fixture({ A: ['d1/x', 'd1/y'], B: ['d2/x'] }));
  assert.equal(d.choices.length, 0);
  assert.ok(d.count > 0);
});

test('choices are per PAIR, so three coders can disagree in more than one way', () => {
  const d = findDisagreements(fixture({ A: ['d1/x'], B: ['d1/y'], C: ['d1/z'] }));
  // A-B, A-C, B-C: each pair holds a code the other does not.
  assert.equal(d.choices.length, 3);
  assert.deepEqual(d.choices.map((c) => c.pair.join('/')), ['A/B', 'A/C', 'B/C']);
});

// ---------------------------------------------------------------------------------------
// What it refuses to say
// ---------------------------------------------------------------------------------------

test('nothing in the output or its prose claims the same PASSAGE', () => {
  const src = readFileSync('plugins/builtin-agreement/index.js', 'utf8');
  const at = src.indexOf('async function renderDisagreements(');
  const body = src.slice(at, src.indexOf('\n}', at));
  // The caption and the note must stay at document granularity, because that is the unit
  // the coefficient is computed over and the only thing the data establishes.
  assert.match(body, /the unit here is the DOCUMENT/i, 'it says so outright');
  assert.ok(!/same passage/i.test(body), 'and never claims the stronger thing');
  // The listing is capped — a scheme-level problem should read as one, not as a wall.
  assert.match(body, /MAX_DISAGREEMENTS/);
  assert.match(body, /Showing the first/);
});

test('zero disagreements says so in words rather than printing an empty table', () => {
  const src = readFileSync('plugins/builtin-agreement/index.js', 'utf8');
  const at = src.indexOf('async function renderDisagreements(');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.match(body, /No disagreements/);
  assert.match(body, /what a κ of 1 means in words/, 'tied back to the coefficient above');
});

test('the listing runs after the coefficients, not before', () => {
  // The coefficient is the reason anyone opened this. A reader who has to scroll past a
  // 200-row table to reach the number they came for will not scroll back.
  const src = readFileSync('plugins/builtin-agreement/index.js', 'utf8');
  const at = src.indexOf('export async function fromCodings(');
  const body = src.slice(at, src.indexOf('\n}', src.indexOf('renderDisagreements(app', at)));
  assert.ok(body.indexOf('await render(app, stats') < body.indexOf('await renderDisagreements('));
});
