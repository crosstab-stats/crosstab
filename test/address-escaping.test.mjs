/**
 * @file address-escaping.test.mjs
 * A column or variable NAME is escaped before it goes into an op-log address.
 *
 * ## The defect this fixes
 *
 * Addresses are delimited by `/` and `:`, and `readAncestors` strips `:`-segments from the
 * right **on purpose** — that is what lets a whole-dataset `load` satisfy a read of one of
 * its cells, which is why anchors stopped reporting as dangling on every merge (#166).
 *
 * So a colon inside a name is not cosmetic: it addresses something else.
 *
 *     readAncestors('ds:7/cell:time:start:1000003')
 *       → [..., 'ds:7/cell:time:start', 'ds:7/cell:time', 'ds:7/cell', 'ds:7']
 *                                        ^^^^^^^^^^^^^^^ a DIFFERENT column
 *
 * **What that breaks is the stale badge.** Measured, before and after escaping:
 *
 *     staleReaders     edit `time` after a reader of `time:start`
 *       unescaped: 1 stale          escaped: 0 stale      ← the defect, fixed
 *
 *     unresolvedReads  write to `time`, read of `time:start`
 *       unescaped: 0 problems       escaped: 0 problems   ← unchanged
 *
 * I first wrote this up as "both consumers, in opposite directions", and the escaped test
 * below failed on the `unresolvedReads` half, which is how I learned that half was wrong.
 * `unresolvedReads` is permissive whatever the name, because `ds:7/cell` is itself an
 * ancestor: stripping `:`-segments leaves an intermediate that collapses every column, so
 * any cell write counts as evidence that any cell exists. That is pre-existing and
 * harmless for the question it asks — a `load` of `ds:7` already satisfies everything
 * inside it — so it is recorded here rather than chased.
 *
 * The stale badge is different: it is shown to the reader, it says "a variable this result
 * used was changed", and with an unescaped colon it pointed at the wrong column.
 *
 * ## Why it is reachable
 *
 * Typed names are validated (`varNameError`: a letter, then letters/digits/`_`/`.`), and
 * SPSS and Stata forbid colons in their own names. But **import takes a header as the file
 * gives it**, and `time:start`, `Q1: satisfaction` and `10:30` are ordinary CSV headers.
 *
 * ## Why escaping and not cleaning
 *
 * The owner's call: fix the grammar, not the user's data. A header is what the file said,
 * and the variable list is where someone looks for the name they expect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addressPart, decodeAddressPart, readAncestors, unresolvedReads, staleReaders,
} from '../core/op-log.js';
import { cellTarget, variableTarget } from '../core/memo-store.js';

const op = (id, target, reads = []) => ({ id, target, reads, hlc: id });

// =============================================================================
// The primitive
// =============================================================================

test('only the delimiters and the escape character are touched', () => {
  // Every ordinary name has to come through unchanged, or every existing address in every
  // saved project stops matching the ones built from now on.
  for (const plain of ['age', 'income_2024', 'Q1.a', 'HÖHE', 'a b', 'x-y', '名前', 'v1']) {
    assert.equal(addressPart(plain), plain, plain);
  }
  assert.equal(addressPart('time:start'), 'time%3Astart');
  assert.equal(addressPart('a/b'), 'a%2Fb');
  assert.equal(addressPart('100%'), '100%25');
});

test('it round-trips, which is why it is percent-encoding and not substitution', () => {
  for (const name of ['time:start', 'a/b', '100%', 'Q1: satisfaction', '10:30',
    '%3A', 'a%2Fb', ':', '/', '%', '::/%']) {
    assert.equal(decodeAddressPart(addressPart(name)), name, name);
  }
});

test('escaping `%` is what makes it reversible', () => {
  // A name that already looks encoded must not decode to something else: `%3A` is three
  // characters a user may legitimately have typed.
  assert.equal(addressPart('%3A'), '%253A');
  assert.equal(decodeAddressPart('%253A'), '%3A', 'not a colon');
});

test('null and undefined are the empty name, not the string "null"', () => {
  assert.equal(addressPart(null), '');
  assert.equal(addressPart(undefined), '');
  assert.equal(decodeAddressPart(null), '');
});

// =============================================================================
// The defect, reproduced against the unescaped form
// =============================================================================

test('REPRODUCTION: unescaped, editing `time` marks readers of `time:start` stale', () => {
  const ancestors = readAncestors('ds:7/cell:time:start:1000003');
  assert.ok(ancestors.includes('ds:7/cell:time'),
    'this is the bug: a different column is an ancestor');

  const stale = staleReaders([
    op('1', 'ds:7/cell:time:start:3'),
    op('2', 'item:code1', ['ds:7/cell:time:start:3']),
    op('3', 'ds:7/cell:time'),
  ]);
  assert.equal(stale.length, 1, 'wrongly marked stale by an edit to another column');
  assert.deepEqual(stale[0].writers.map((w) => w.target), ['ds:7/cell:time'],
    'and it names the wrong column as the writer');
});

test('`unresolvedReads` is permissive whatever the name — pre-existing, not this bug', () => {
  // `ds:7/cell` is an ancestor of every cell, so any cell write is evidence that any cell
  // exists. Asserted so the breadth is a recorded property rather than something a later
  // reader mistakes for the colon defect — and so that if it is ever tightened, whoever
  // does it can see what used to be true.
  const unescaped = unresolvedReads([
    op('w', 'ds:7/cell:time'),
    op('r', 'item:code1', ['ds:7/cell:time:start:1000003']),
  ]);
  const escaped = unresolvedReads([
    op('w', `ds:7/cell:${addressPart('time')}`),
    op('r', 'item:code1', [`ds:7/cell:${addressPart('time:start')}:1000003`]),
  ]);
  assert.equal(unescaped.length, 0);
  assert.equal(escaped.length, 0, 'escaping changes nothing here, by design');
});

test('ESCAPED, the two columns no longer address each other', () => {
  const target = `ds:7/cell:${addressPart('time:start')}:1000003`;
  assert.equal(target, 'ds:7/cell:time%3Astart:1000003');
  const ancestors = readAncestors(target);
  assert.ok(!ancestors.includes('ds:7/cell:time'), 'no longer a cross-column ancestor');
  assert.ok(ancestors.includes('ds:7/cell:time%3Astart'), 'its own column still is');

  const stale = staleReaders([
    op('1', target),
    op('2', 'item:code1', [target]),
    op('3', `ds:7/cell:${addressPart('time')}`),
  ]);
  assert.equal(stale.length, 0, 'and an edit to `time` no longer touches it');
});

test('a whole-dataset write still covers its own cells — the behaviour #166 needed', () => {
  // The escaping must not break what the `:`-splitting was for.
  const target = cellTarget(7, 'time:start', 1000003);
  const problems = unresolvedReads([op('load', 'ds:7'), op('r', 'item:c', [target])]);
  assert.equal(problems.length, 0, 'a load of ds:7 still satisfies a read inside it');
});

// =============================================================================
// Every builder, because they must agree byte for byte
// =============================================================================

test('the anchor builders escape, and agree with what the op writes', () => {
  // `memo-store.js` documents `cellTarget` as byte-identical to what `DataStore#setCell`
  // writes, and `data-views.js` builds the same string for its cell anchors. If one
  // escapes and another does not, anchors silently stop matching — worse than the
  // ambiguity being fixed. So this checks the SOURCE of each builder, not just the two
  // that can be imported without DuckDB.
  assert.equal(cellTarget(7, 'time:start', 3), 'ds:7/cell:time%3Astart:3');
  assert.equal(variableTarget(7, 'a/b'), 'ds:7/var:a%2Fb');

  const files = {
    'core/data-store.js': [/`cell:\$\{addressPart\(column\)\}:\$\{String\(rid\)\}`/,
      /`var:\$\{addressPart\(t\.name\)\}`/,
      /`cell:\$\{addressPart\(t\.column\)\}:\$\{t\.rid\}`/],
    'core/data-views.js': [/cell:\$\{addressPart\(column\)\}:\$\{rid\}/],
    'core/merge.js': [/`var:\$\{addressPart\(op\.name\)\}`/,
      /`cell:\$\{addressPart\(op\.column\)\}:\$\{op\.rid\}`/],
  };
  for (const [path, pats] of Object.entries(files)) {
    const src = readFileSync(path, 'utf8');
    for (const p of pats) assert.match(src, p, `${path} ${p}`);
    // And no builder left unescaped: a bare `${column}` or `${op.column}` in a target.
    assert.doesNotMatch(src, /`cell:\$\{(?:column|t\.column|op\.column)\}/, `${path} has a raw column`);
  }
});

test('the merge key and the op target escape the same way, or peers disagree', () => {
  // `merge.js` builds a conflict key and `data-store.js` builds the op target from the
  // same name. Two peers that escape differently would not see each other's edits as
  // touching the same thing.
  const store = readFileSync('core/data-store.js', 'utf8');
  const merge = readFileSync('core/merge.js', 'utf8');
  for (const src of [store, merge]) {
    assert.match(src, /import \{[^}]*addressPart[^}]*\} from '\.\/op-log\.js'/);
  }
});

// =============================================================================
// The duplicate rStr found alongside
// =============================================================================

test('there is ONE rStr, and it escapes the newlines the local copy missed', async () => {
  const { rStr } = await import('../core/plugin-stdlib.js');
  assert.equal(rStr('a\nb'), '"a\\nb"');
  assert.equal(rStr('a\rb'), '"a\\rb"');
  assert.equal(rStr('say "hi"'), '"say \\"hi\\""');
  assert.equal(rStr('C:\\path'), '"C:\\\\path"');

  const script = readFileSync('core/r-script.js', 'utf8');
  assert.doesNotMatch(script, /^function rStr\(/m, 'the local copy is gone');
  assert.match(script, /import \{ el, rStr \} from '\.\/plugin-stdlib\.js'/);
});

test('U+0000 is still passed through, which is a deliberate limit', async () => {
  // The original report, and the reason it stays open rather than being patched: an R
  // character string cannot hold a NUL at all, so there is no escape to emit. The failure
  // is R's parser rejecting the source — loud, and a NUL in a CSV header means the file is
  // damaged. Asserted so that "we pass it through" is a recorded decision and not an
  // oversight someone later fixes by inventing an escape that does not exist.
  const { rStr } = await import('../core/plugin-stdlib.js');
  assert.equal(rStr(('a' + String.fromCharCode(0) + 'b')), ('"a' + String.fromCharCode(0) + 'b"'), 'unescaped, by design');

  // But it is NOT a problem for an address: a NUL is not a delimiter, so it cannot
  // address another column the way a colon could.
  assert.equal(addressPart(('a' + String.fromCharCode(0) + 'b')), ('a' + String.fromCharCode(0) + 'b'));
  assert.ok(!readAncestors(`ds:7/cell:${addressPart(('a' + String.fromCharCode(0) + 'b'))}:3`).includes('ds:7/cell:a'));
});
