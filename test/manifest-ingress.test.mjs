/**
 * @file manifest-ingress.test.mjs
 * A plugin manifest is untrusted input, and until #197 nothing in it was checked.
 *
 * The earlier string-ingress sweep covered file imports, plugin `data.create` calls and
 * ops replayed from a peer. It did not cover the manifest — so a plugin's own declared
 * id, author, name, category and collection ids reached storage keys, the picker and two
 * `confirm()` prompts exactly as written. The only check in the whole path was "is there
 * an id at all".
 *
 * ## Why the two policies differ, which is the point of this file
 *
 * **A key is VALIDATED and the manifest REJECTED.** `#ensureIdAvailable` guarantees
 * qualified-id uniqueness (#102) by comparing exact strings; cleaning an id after that
 * comparison would leave the guarantee checking a value that no longer exists, which is
 * how two plugins come to share one key. So an id outside the class costs that plugin the
 * load — the rule the rest of the manifest already followed, where a half-written
 * `parent` is dropped rather than guessed at.
 *
 * **Display text is CLEANED so that it equals its own rendering.** This is the opposite
 * of `cleanName`'s rule and deliberately so: `cleanName` turns a control character into a
 * space to stop the words either side welding together, because it is protecting content
 * the USER typed. `identityText` is protecting a trust DECISION about text somebody else
 * wrote, so a zero-width space is deleted rather than spaced — the reader sees "ab", so
 * "ab" is what the string must be.
 *
 * ## What made this exploitable rather than merely untidy
 *
 * `qualifyId` namespaces a non-built-in id so that, in its own comment, a would-be forgery
 * "reads as exactly what it is: `sdsu-builtin-frequencies`". That is an explicit
 * anti-impersonation measure, and it assumes a string renders as its characters. One
 * U+202E breaks it. And `core/plugin-manager.js` interpolates both the id and the name
 * into `confirm()` prompts, where a newline forges extra lines of dialog text under the
 * app's own voice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { qualifyId } from '../core/loader.js';
import { ownerToken } from '../core/workspace-store.js';
import { normalizeCollection } from '../core/collections.js';
import { identityText, cleanName } from '../core/plugin-stdlib.js';

const NUL = '\u0000';
const fromFile = (manifest) => qualifyId({ kind: 'file' }, manifest);

// ---------------------------------------------------------------------------------------
// Keys: rejected, never repaired
// ---------------------------------------------------------------------------------------

test('an id outside the class is refused, not cleaned', () => {
  const bad = {
    'a NUL': 'a' + NUL + 'b',
    'a lone surrogate': 'a\uD800b',
    'a newline (forges a confirm prompt)': 'a\nb',
    'a tab': 'a\tb',
    'a slash': 'a/b',
    'a colon (the namespace separator)': 'a:b',
    'a bidi override': 'a\u202Eb',
    'a zero-width space': 'a\u200Bb',
    'a space': 'a b',
    'non-ASCII': 'café',
    'a leading hyphen': '-lead',
    'over 64 characters': 'z'.repeat(65),
    'empty': '',
    'whitespace only': '   ',
  };
  for (const [what, id] of Object.entries(bad)) {
    assert.throws(() => fromFile({ id, author: 'me' }), /not usable|missing an id/, what);
  }
});

test('the complaint about an unsafe id does not itself carry it', () => {
  // The message names the offending id and lands in the same confirm()/alert() surfaces
  // the id was going to abuse. A validator that quotes its input verbatim re-introduces
  // exactly what it exists to stop.
  for (const id of ['a\nb', 'a\u202Eb', 'a' + NUL + 'b', 'a\uD800b']) {
    let msg = '';
    try { fromFile({ id, author: 'me' }); } catch (e) { msg = e.message; }
    assert.ok(msg, 'it threw');
    assert.ok(!/[\n\r\t\u0000\u202A-\u202E\u2066-\u2069\u200B]/.test(msg),
      'no control or formatting character survives into the message: ' + JSON.stringify(msg));
    assert.ok(!/[\uD800-\uDFFF]/.test(msg), 'and no stray surrogate either');
  }
});

test('everything the project actually ships is inside the class', () => {
  // The class describes what CrossTab uses rather than inventing a convention. If this
  // fails, the class is wrong, not the plugin.
  const real = [
    'builtin-caqdas', 'builtin-agreement', 'builtin-spatial', 'builtin-charts',
    'builtin-sced', 'builtin-timeseries', 'builtin-decisions', 'builtin-ordination',
    'authored-a1b2c3d4', // what the in-app creator generates
    'boundarySets', 'x', 'X9', 'a.b', 'a_b', 'a-b', 'z'.repeat(64),
  ];
  for (const id of real) assert.doesNotThrow(() => qualifyId({ kind: 'builtin' }, { id }), id);
});

test('a collection id is dropped the same way, and the shipped ones survive', () => {
  for (const id of ['a/b', 'a' + NUL + 'b', 'a\uD800b', 'a\nb', 'a b', '-lead', 'z'.repeat(65)]) {
    assert.equal(normalizeCollection({ id, label: 'L' }), null, JSON.stringify(id));
  }
  // camelCase and hyphens both ship — boundarySets is builtin-spatial's.
  for (const id of ['boundarySets', 'agreement-codings', 'codebooks', 'codes', 'segments', 'memos']) {
    assert.equal(normalizeCollection({ id, label: 'L' })?.id, id);
  }
});

// ---------------------------------------------------------------------------------------
// Namespaces: slugged, because they name rather than authorise
// ---------------------------------------------------------------------------------------

test('a self-declared author is slugged into the id class', () => {
  // It grants nothing since #196 (ownerToken stopped reading authority off the prefix),
  // so mangling it costs only legibility — which is why this cleans where the id rejects.
  assert.equal(fromFile({ id: 'x', author: 'ac' + NUL + 'me' }), 'ac-me:x');
  assert.equal(fromFile({ id: 'x', author: 'ac\u202Eme' }), 'ac-me:x');
  assert.equal(fromFile({ id: 'x', author: 'Acme Labs' }), 'acme-labs:x');
  assert.equal(fromFile({ id: 'x', author: '   ' }), 'local:x');
  assert.equal(fromFile({ id: 'x' }), 'local:x');
  // Bounded: an author tag is part of a key written into every op in the log.
  const huge = fromFile({ id: 'x', author: 'z'.repeat(2000) });
  assert.ok(huge.length < 60, 'got ' + huge.length);
});

test('EXACTLY ONE colon in a qualified id, which is what the token split assumes', () => {
  // The regression this caught: `URL.host` carries the PORT, so a plugin served from
  // https://example.com:8080/p.js produced "example.com:8080:thing" — and ownerToken
  // splits on the FIRST colon, so the namespace became example.com with "8080:thing"
  // dangling. An IPv6 literal arrives bracketed and full of colons.
  const cases = [
    [{ kind: 'url', url: 'https://example.com:8080/p.js' }, { id: 'thing' }],
    [{ kind: 'url', url: 'http://[::1]/p.js' }, { id: 'thing' }],
    [{ kind: 'url', url: 'https://a.example/p.js' }, { id: 'thing' }],
    [{ kind: 'file' }, { id: 'thing', author: 'a:b:c' }],
    [{ kind: 'authored' }, { id: 'thing' }],
  ];
  for (const [origin, manifest] of cases) {
    const qid = qualifyId(origin, manifest);
    assert.equal((qid.match(/:/g) || []).length, 1, qid);
  }
  // And the port no longer leaks into the namespace.
  assert.equal(ownerToken({
    id: qualifyId({ kind: 'url', url: 'https://example.com:8080/p.js' }, { id: 'thing' }),
    origin: 'url',
  }), 'ns:example.com');
});

// ---------------------------------------------------------------------------------------
// Display text: equal to its rendering
// ---------------------------------------------------------------------------------------

test('identityText removes what changes a rendering without changing a string', () => {
  assert.equal(identityText('Freq\u202Euencies'), 'Frequencies', 'bidi override');
  assert.equal(identityText('a\u2066b\u2069c'), 'abc', 'bidi isolates');
  assert.equal(identityText('a\u200Bb'), 'ab', 'zero-width space is DELETED, not spaced');
  assert.equal(identityText('a\uFEFFb'), 'ab', 'byte-order mark');
  assert.equal(identityText('line\none'), 'line one', 'control characters still become spaces');
  assert.equal(identityText('a\uD800b'), 'a�b', 'a lone surrogate is still repaired');
  assert.equal(identityText('  spaced   out  '), 'spaced out');
  assert.equal(identityText('x'.repeat(500)).length, 120, 'bounded');
  assert.equal(identityText(null, { fallback: 'id-9' }), 'id-9');
});

test('a zero-width JOINER survives, because it is a letter in real scripts', () => {
  // U+200C/U+200D are required to spell words correctly in Persian, Hindi and others.
  // Deleting them would quietly corrupt an author's name. They do enable confusables,
  // and that risk is closed on the ID — which is ASCII-only and is the string uniqueness
  // is actually checked against — rather than by mangling anyone's name.
  assert.equal(identityText('zero\u200Cwidth'), 'zero\u200Cwidth');
  assert.equal(identityText('zero\u200Dwidth'), 'zero\u200Dwidth');
  assert.throws(() => qualifyId({ kind: 'builtin' }, { id: 'zero\u200Cwidth' }), /not usable/);
});

test('identityText is STRICTER than cleanName, and only where it must be', () => {
  // Same treatment for everything cleanName handles...
  for (const s of ['line\none', 'a\uD800b', '  trim  ', 'Montréal — naïve']) {
    assert.equal(identityText(s, { max: 200 }), cleanName(s, { max: 200 }), JSON.stringify(s));
  }
  // ...and different only for the invisibles, which cleanName leaves alone because a
  // user's own typed name is content, not a claim about who someone is.
  assert.equal(cleanName('a\u200Bb'), 'a\u200Bb');
  assert.equal(identityText('a\u200Bb'), 'ab');
});

// ---------------------------------------------------------------------------------------
// Applied at the boundary, not at each use site
// ---------------------------------------------------------------------------------------

test('the catalogue cleans display text where an outside manifest becomes stored state', () => {
  // core/plugin-manager.js cannot be imported in Node, so this reads the source. One
  // boundary, not one call per render: the picker, the attribution line, the project
  // panel and two confirm() prompts all read the catalogue.
  const src = readFileSync('core/plugin-manager.js', 'utf8');
  const at = src.indexOf('this.#catalog[key] = {');
  assert.ok(at > 0, '#recordCatalog is the boundary');
  const body = src.slice(at, src.indexOf('\n    };', at));
  assert.match(body, /name: identityText\(manifest\.name/, 'the name is cleaned');
  assert.match(body, /category: identityText\(manifest\.category/, 'and the category');
  assert.match(body, /identityText\(k,/, 'and each keyword');
  assert.match(body, /slice\(0, 40\)/, 'with the keyword LIST bounded too — it is localStorage');
});

test('the collection label is cleaned, and falls back to the validated id', () => {
  const d = normalizeCollection({ id: 'notes', label: 'My\u202ENotes' });
  assert.equal(d.label, 'MyNotes');
  assert.equal(normalizeCollection({ id: 'notes', label: '   ' }).label, 'notes');
  assert.equal(normalizeCollection({ id: 'notes' }).label, 'notes');
  assert.ok(normalizeCollection({ id: 'notes', label: 'x'.repeat(200) }).label.length <= 60);
});
