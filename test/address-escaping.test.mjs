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
import { rStr, safeText } from '../core/plugin-stdlib.js';
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

test('U+0000 is REMOVED on the way into R, because R cannot hold one', () => {
  // This test used to assert the opposite, and said so deliberately: "unescaped, by
  // design", on the grounds that an R string cannot hold a NUL so there is no escape to
  // emit, and that R's parser rejecting the source is a loud failure.
  //
  // The first half is still true and is exactly why dropping it is the only option. The
  // second half was wrong about WHERE the loudness lands: the user who imported a damaged
  // CSV got an R parse error about generated source, minutes later, naming nothing they
  // recognised. That is not a loud failure, it is an unattributable one.
  //
  // Changed on the owner's instruction (2026-11-01) to resolve the open entry. There is
  // no faithful encoding to choose between here — the options were "drop it" and "emit a
  // file R cannot read".
  const nul = 'a' + String.fromCharCode(0) + 'b';
  assert.equal(rStr(nul), '"ab"', 'no NUL reaches the generated source');

  // And it never gets that far anyway: a column name is cleaned at the DataStore ingress
  // that every route shares — file import, a plugin calling data.create, and a sync op
  // replayed from a peer.
  assert.equal(safeText(nul), 'ab');

  // A NUL remains harmless in an ADDRESS, which is what the rest of this file is about:
  // it is not a delimiter, so it cannot address another column the way a colon could.
  assert.equal(addressPart(nul), nul);
  assert.ok(!readAncestors(`ds:7/cell:${addressPart(nul)}:3`).includes('ds:7/cell:a'));
});

test('a LONE SURROGATE is replaced, which is the one that was corrupting silently', () => {
  // Not in the original report, and worse than what was. An unpaired \uD800 survives
  // JSON.stringify, JSON.parse and structuredClone intact — so it rides through a save,
  // through IndexedDB and across a sync hop looking perfectly fine — and then the first
  // thing that UTF-8 encodes it (writing a file, posting to WebR, any TextEncoder)
  // silently turns it into U+FFFD. Measured both ways round before this was written.
  //
  // That is two peers holding different strings with nothing reporting a problem, which
  // this project treats as worse than a crash.
  assert.equal(safeText('a\uD800b'), 'a\uFFFDb', 'an unpaired high surrogate');
  assert.equal(safeText('a\uDC00b'), 'a\uFFFDb', 'and an unpaired low one');

  // A VALID pair is ordinary data and must survive untouched — an emoji in a label is
  // not damage.
  assert.equal(safeText('a\uD83D\uDE00b'), 'a\uD83D\uDE00b');
});

test('safeText removes only the unrepresentable, never the merely untidy', () => {
  // The line this draws matters: a sanitiser that tidies data is a sanitiser that loses
  // it. Tabs, newlines and other control characters are legal in both UTF-8 and an R
  // string — rStr already escapes the ones that would break a line — and a tab inside a
  // label is data.
  assert.equal(safeText('a\tb'), 'a\tb');
  assert.equal(safeText('a\nb'), 'a\nb');
  assert.equal(safeText('a\u0001b'), 'a\u0001b', 'a C0 control is legal in UTF-8');
  assert.equal(safeText('a\u202Eb'), 'a\u202Eb', 'an RTL override is a display concern, not a storage one');
  assert.equal(safeText('café'), 'café');
});
