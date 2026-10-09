/**
 * @file manage-projects-small.test.mjs
 * The Manage-projects row on a phone.
 *
 * Reported from an iPhone: "manage projects on small screen can't fit the project
 * names" — the name rendered as a single character while the location and three
 * buttons took the width.
 *
 * The row is one flex line: name, where it lives, then Open / Rename / Delete. None of
 * the buttons shrink and `.ctpm__where` was `nowrap` with no shrink either, so the name
 * — the only part with `text-overflow: ellipsis` — absorbed the entire shortfall.
 * Measured in Chrome at a 390px dialog: the name box was **43px wide**, which is where
 * the reported "2" came from. Stacked, it is 283px and not truncated at all.
 *
 * CSS cannot be executed here, so this guards the rules themselves; the measurement
 * above is what verified them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const HTML = await readFile(new URL('../index.html', import.meta.url), 'utf8');
/** The declarations of one CSS rule, by selector. */
const rule = (selector) => {
  const i = HTML.indexOf(`${selector} {`);
  assert.ok(i > 0, `no rule for ${selector}`);
  return HTML.slice(i, HTML.indexOf('}', i));
};

test('the row stacks on a small screen so the name gets a line of its own', () => {
  assert.match(rule('[data-screen="small"] .ctpm__row'), /flex-wrap:\s*wrap/);
  const main = rule('[data-screen="small"] .ctpm__rowmain');
  assert.match(main, /flex:\s*1 0 100%/, 'the name block takes the full width');
  assert.match(main, /flex-direction:\s*column/, 'with the location under it, not beside it');
  assert.match(rule('[data-screen="small"] .ctpm__acts'), /flex:\s*1 0 100%/,
    'and the buttons drop to their own line');
});

test('the buttons are a touch target once they have the width', () => {
  const act = rule('[data-screen="small"] .ctpm__act');
  assert.match(act, /min-height:\s*44px/, '44px is this app\'s touch floor');
  assert.match(act, /flex:\s*1/, 'and they share the line evenly');
});

test('the NAME outranks the location when space runs short, on any screen', () => {
  // The general half of the fix: both can ellipsise, but the flex basis decides which
  // gives way first. Before this, the location held its full width unconditionally and
  // the name paid for all of it.
  const name = rule('.ctpm__name');
  const where = rule('.ctpm__where');
  assert.match(name, /flex:\s*1 1 auto/, 'the name grows into spare room');
  assert.match(where, /flex:\s*0 1 auto/, 'the location only shrinks');
  for (const [sel, decls] of [['.ctpm__name', name], ['.ctpm__where', where]]) {
    assert.match(decls, /min-width:\s*0/, `${sel} needs min-width:0 or flex refuses to shrink it`);
    assert.match(decls, /text-overflow:\s*ellipsis/, `${sel} should ellipsise rather than clip`);
  }
});

test('five tabs scroll rather than wrapping mid-label', () => {
  // "Store in" was breaking across two lines and leaving the tab row ragged.
  const tabs = rule('[data-screen="small"] .ctpm__tabs');
  assert.match(tabs, /overflow-x:\s*auto/);
  assert.match(tabs, /flex-wrap:\s*nowrap/);
  assert.match(rule('[data-screen="small"] .ctpm__tab'), /white-space:\s*nowrap/);
});
