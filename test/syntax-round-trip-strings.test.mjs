/**
 * @file syntax-round-trip-strings.test.mjs
 * The script language survives strings that fight back.
 *
 * `.ctscript` is sold in the export chooser as "Lossless — imports back into this editor
 * exactly as it is", and the Syntax view re-parses the same text on every Run. That
 * promise only holds if a name or a label can contain whatever the DATA contained, and
 * two things broke it. Both had the same root cause: the writer quoted, and the layers
 * that SPLIT did not know about escapes.
 *
 *  1. **A newline was written raw.** One statement became two and the script stopped
 *     parsing. Reachable rather than theoretical — RFC 4180 permits a newline inside a
 *     quoted CSV header field, and imported names never pass through `varNameError`
 *     (which would reject one; names typed in the UI are strictly validated).
 *  2. **`splitTop` toggled its in-string flag on every `"`, escaped or not.** With an
 *     EVEN number of escaped quotes the toggles paired up and it worked by accident.
 *     With an odd one — a label like `under 5"` — a comma inside the label split the
 *     list mid-label, and the value-label map came back with the code and the label
 *     fused into one key. Silently: no error, just wrong data.
 *
 * Characters are built with `fromCharCode` rather than written as escapes, so that what
 * is being tested cannot be quietly altered by this file's own escaping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { serialize, parse } from '../core/crosstab-syntax.js';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92);
const Q = String.fromCharCode(34);
const BT = String.fromCharCode(96);
const LSEP = String.fromCharCode(0x2028);

/** Serialise one op, parse it back, and return what came out (plus any parse errors). */
function roundTrip(op) {
  const text = serialize([op]);
  const out = parse(text);
  const back = (out.steps[0] && out.steps[0].op) || out.transforms[0];
  return { text, back, errors: out.errors || [] };
}

function survives(op, what) {
  const { back, errors } = roundTrip(op);
  assert.deepEqual(errors, [], `${what}: parse errors`);
  assert.deepEqual(back, op, `${what}: did not survive the round trip`);
}

const setVar = (patch) => ({ type: 'setVariable', name: 'q1', patch });

// =============================================================================
// Line breaks: the defect that turned one statement into two
// =============================================================================

test('a newline in a variable name survives', () => {
  survives({ type: 'renameVar', from: 'a', to: `we${LF}ird` }, 'LF in a name');
});

test('a newline in a name stays ONE statement', () => {
  // The mechanism, not just the symptom: if it is written raw the file gains a line and
  // every later statement shifts, so the error surfaces somewhere else entirely.
  const { text } = roundTrip({ type: 'renameVar', from: 'a', to: `we${LF}ird` });
  const statements = text.split(LF).filter((l) => l && !l.startsWith('#'));
  assert.equal(statements.length, 1, text);
});

test('a newline in a label and in a value label survives', () => {
  survives(setVar({ label: `Age${LF}in years` }), 'LF in a label');
  survives(setVar({ valueLabels: { 1: `two${LF}lines`, 2: 'No' } }), 'LF in a value label');
});

test('CR, tab and U+2028 survive', () => {
  // U+2028 is not a line break to `split('\\n')`, but `\\s` in the tokeniser's regexes
  // matches it — so it failed to parse in a way nothing on screen could explain.
  survives({ type: 'renameVar', from: 'a', to: `we${CR}ird` }, 'CR in a name');
  survives({ type: 'renameVar', from: 'a', to: `we${LSEP}ird` }, 'U+2028 in a name');
  survives(setVar({ label: `a${TAB}b` }), 'tab in a label');
  survives(setVar({ label: `a${CR}${LF}b` }), 'CRLF in a label');
});

test('a NUL survives rather than truncating the rest', () => {
  survives(setVar({ label: `a${NUL}b` }), 'NUL in a label');
  survives({ type: 'renameVar', from: 'a', to: `we${NUL}ird` }, 'NUL in a name');
});

// =============================================================================
// Quotes: the defect that silently fused a code and its label
// =============================================================================

test('an ODD number of quotes in a value label does not corrupt the map', () => {
  // The regression case. `under 5"` is an ordinary survey label.
  const op = setVar({ valueLabels: { 1: `under 5${Q}`, 2: 'taller' } });
  const { back, errors } = roundTrip(op);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(back.patch.valueLabels), ['1', '2'],
    'the codes must still be the keys — this used to fuse a code and a label into one');
  assert.deepEqual(back, op);
});

test('a quote followed by a comma inside one label does not split the list', () => {
  survives(setVar({ valueLabels: { 1: `say ${Q}x${Q}, ok`, 2: 'No' } }), 'balanced quotes + comma');
  survives(setVar({ valueLabels: { 1: `a ${Q} b, c`, 2: 'No' } }), 'one quote + comma');
});

test('backslashes and backticks survive, including at the end', () => {
  survives(setVar({ label: `ends with${BS}` }), 'trailing backslash');
  survives(setVar({ label: `C:${BS}path` }), 'backslash');
  survives(setVar({ valueLabels: { 1: `a${BS}`, 2: `b${Q}` } }), 'backslash then quote');
  survives({ type: 'renameVar', from: 'a', to: `we${BT}ird` }, 'backtick in a name');
  survives({ type: 'renameVar', from: 'a', to: `we${BS}ird` }, 'backslash in a name');
});

// =============================================================================
// The ordinary cases still work
// =============================================================================

test('plain names and labels are unchanged by the escaping', () => {
  survives({ type: 'renameVar', from: 'a', to: 'b' }, 'plain rename');
  survives(setVar({ label: 'Age in years' }), 'plain label');
  survives(setVar({ valueLabels: { 1: 'Yes', 2: 'No' } }), 'plain value labels');
  survives(setVar({ valueLabels: { 1: 'Yes, really', 2: 'No' } }), 'comma inside a label');
  survives({ type: 'dropVars', names: ['a', 'b'] }, 'drop list');
});

test('a plain name is still written bare, not quoted', () => {
  // The escaping must not make every script unreadable — a name that needs no quoting
  // must still appear as itself.
  const { text } = roundTrip({ type: 'renameVar', from: 'age', to: 'age2' });
  assert.match(text, /rename age to age2/);
});
