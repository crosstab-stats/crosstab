/**
 * @file string-ingress.test.mjs
 * Every route a string takes into the project, and the two characters it may not carry.
 *
 * The filed bug was narrow: a NUL in an imported column name reached R as a raw byte, and
 * R's parser rejected it. The entry called that a loud failure and left it open as a
 * policy question. The owner asked for it resolved, and for a sweep of every other way a
 * malformed string gets in — typed, read from a file, or arriving through sync.
 *
 * The sweep found something the report had not. Measured in Node, both ways round:
 *
 *   NUL              survives JSON, survives structuredClone, survives UTF-8.
 *                    Only R cannot hold one — and there is no escape to emit, so the
 *                    only options were "drop it" or "emit a file R cannot read".
 *   lone surrogate   survives JSON, survives structuredClone — so it rides a save, an
 *                    IndexedDB write and a sync hop looking perfectly intact — and then
 *                    silently becomes U+FFFD the first time anything UTF-8 encodes it.
 *                    Two peers holding different text with nothing reporting a problem.
 *
 * So the line this draws is not "clean user input". It is: remove what is UNREPRESENTABLE,
 * keep everything else exactly as given. A tab in a label is data. A control character is
 * legal in UTF-8 and in an R string. A sanitiser that tidies data is one you cannot trust
 * with the thing you handed it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { safeText } from '../core/plugin-stdlib.js';

const NUL = 'a' + String.fromCharCode(0) + 'b';
const LONE_HIGH = 'a\uD800b';
const LONE_LOW = 'a\uDC00b';
const EMOJI = 'a\uD83D\uDE00b';

// ---------------------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------------------

test('safeText removes a NUL and repairs a lone surrogate, and nothing else', () => {
  assert.equal(safeText(NUL), 'ab');
  assert.equal(safeText(LONE_HIGH), 'a\uFFFDb');
  assert.equal(safeText(LONE_LOW), 'a\uFFFDb');

  // Everything that is merely unusual is DATA and survives untouched.
  assert.equal(safeText(EMOJI), EMOJI, 'a valid surrogate pair is an emoji, not damage');
  assert.equal(safeText('a\tb'), 'a\tb');
  assert.equal(safeText('a\nb'), 'a\nb');
  assert.equal(safeText('a\u0001b'), 'a\u0001b');
  assert.equal(safeText('Montréal — naïve'), 'Montréal — naïve');
});

// ---------------------------------------------------------------------------------------
// Where it is applied — asserted at each ingress, because the point of the sweep was that
// patching one route leaves the others open
// ---------------------------------------------------------------------------------------

test('column names are cleaned at the ONE ingress every route shares', () => {
  // A file import, a plugin calling data.create, and a sync op replayed from a peer all
  // reach the dataset through #createSource. Cleaning in the CSV parser would have left
  // the other two open, which is what the original report assumed was the whole surface.
  const src = readFileSync('core/data-store.js', 'utf8');
  const at = src.indexOf('async #createSource({');
  assert.ok(at > 0, '#createSource is where columns are materialised');
  const body = src.slice(at, src.indexOf('\n  }', at));
  assert.ok(body.includes('safeText(meta.name)'), 'every incoming column name is cleaned');
  assert.ok(body.includes('console.warn'), 'and a name that changed is not changed silently');

  // The meta that comes back must carry the SAME names the table now has, or every later
  // lookup by name misses the column that was just written.
  assert.ok(/meta: variables\.map\(\(m\) => \(\{ \.\.\.m, name: safeText\(m\.name\) \}\)\)/.test(src),
    'the returned meta agrees with the table');
});

test('a text VALUE is repaired only where it is unrepresentable, never tidied', () => {
  const src = readFileSync('core/data-store.js', 'utf8');
  const at = src.indexOf('function coerceColumn(');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.ok(body.includes('SURROGATE.test(str)'), 'a cheap pre-test, so ordinary strings pay nothing');
  assert.ok(body.includes('safeText(str)'));
  // A NUL in a VALUE is left alone: it survives JSON and UTF-8, and only rStr — which
  // now drops it — ever had a problem with one.
  assert.ok(!/safeText\(str\)\s*:\s*safeText/.test(body), 'values are not double-cleaned');
});

test('record fields are repaired on the SYNCED path, not just the local one', () => {
  // A code name or a memo arriving from a collaborator has crossed a transport but not
  // necessarily an encoder. #applyPut is where both a local write-through and an op
  // folded in from a peer land, which is why the repair sits there.
  const src = readFileSync('core/item-store.js', 'utf8');
  assert.ok(src.includes('function repairFields('), 'the repair exists');
  const at = src.indexOf('#applyPut(owner, collection, id, payload, author, target) {');
  const body = src.slice(at, at + 400);
  assert.ok(body.includes('repairFields(payload.fields)'), 'applied where both directions meet');
});

test('a display NAME keeps its documented behaviour as well as being transportable', () => {
  // cleanName sweeps control characters to SPACES so words either side of a stray newline
  // do not weld together. safeText would delete a NUL outright, so the order matters and
  // is asserted here: the sweep first, the surrogate repair after.
  const src = readFileSync('core/plugin-stdlib.js', 'utf8');
  const at = src.indexOf('export function cleanName(');
  const body = src.slice(at, src.indexOf('\n}', at));
  const sweepAt = body.indexOf('u0000-');
  const safeAt = body.indexOf('safeText(');
  assert.ok(sweepAt > 0 && safeAt > 0);
  assert.ok(safeAt < sweepAt, 'safeText wraps the sweep, so the sweep runs on the inside');
});

test('rStr can no longer emit source R cannot parse', () => {
  const src = readFileSync('core/plugin-stdlib.js', 'utf8');
  const at = src.indexOf('export function rStr(');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.ok(body.includes('safeText(String(s))'),
    'cleaned before escaping — and String(s) kept, so rStr(null) is still "null"');
});
