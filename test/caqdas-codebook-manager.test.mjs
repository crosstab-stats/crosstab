/**
 * @file caqdas-codebook-manager.test.mjs
 * The parsing and formatting behind the codebook manager's bulk operations.
 *
 * Only the pure parts are tested here: the manager's UI lives inside a sandboxed
 * workspace iframe that nothing outside it can reach, by design. What CAN be pinned is
 * the bit that eats other people's data — a pasted spreadsheet column — and the CSV it
 * writes back out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseCodeList, addCodesFromText, codebookToCsv, toHex } =
  await import('../plugins/builtin-caqdas/index.js');

// --- parsing a pasted list ------------------------------------------------------

test('a bare list of names is a valid codebook', () => {
  // The realistic minimum: someone types or pastes a column of names, nothing else.
  const out = parseCodeList('Trust\nDelay\nAmbivalence');
  assert.deepEqual(out.map((c) => c.name), ['Trust', 'Delay', 'Ambivalence']);
  assert.deepEqual(out.map((c) => c.group), ['', '', '']);
  assert.deepEqual(out.map((c) => c.color), [null, null, null]);
});

test('name, theme and colour are read in any order the colour appears', () => {
  // A colour is recognised by SHAPE, not position, because sheets differ. Everything
  // left over is the theme.
  const a = parseCodeList('Trust, Relational, #8ecae6')[0];
  assert.deepEqual([a.name, a.group, a.color], ['Trust', 'Relational', '#8ecae6']);
  const b = parseCodeList('Trust, #8ecae6, Relational')[0];
  assert.deepEqual([b.name, b.group, b.color], ['Trust', 'Relational', '#8ecae6']);
  // Three-digit hex and a missing # both normalise.
  assert.equal(parseCodeList('X, T, abc')[0].color, '#aabbcc');
});

test('tab-separated input works — that is what a spreadsheet paste actually is', () => {
  const out = parseCodeList('Trust\tRelational\nDelay\tProcess');
  assert.deepEqual(out.map((c) => [c.name, c.group]), [['Trust', 'Relational'], ['Delay', 'Process']]);
});

test('a quoted name containing a comma survives', () => {
  const out = parseCodeList('"Delay, unexplained", Process');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Delay, unexplained');
  assert.equal(out[0].group, 'Process');
});

test('names already in the book are skipped, so re-pasting a growing sheet is safe', () => {
  // The expected workflow: a codebook maintained in a spreadsheet, pasted again as it
  // grows. Duplicating every existing code each time would make the feature useless.
  const out = parseCodeList('Trust\nDelay\nNew one', new Set(['trust', 'delay']));
  assert.deepEqual(out.map((c) => c.name), ['New one']);
});

test('duplicates WITHIN one paste collapse too', () => {
  assert.deepEqual(parseCodeList('Trust\ntrust\nTRUST').map((c) => c.name), ['Trust']);
});

test('blank lines, stray whitespace and empty names are dropped, never thrown on', () => {
  const out = parseCodeList('\n  \nTrust  \n,,,\n , Relational\n');
  assert.deepEqual(out.map((c) => c.name), ['Trust']);
  for (const junk of [null, undefined, '', 42, {}]) {
    assert.doesNotThrow(() => parseCodeList(junk));
    assert.deepEqual(parseCodeList(junk), []);
  }
});

// --- adding to a codebook --------------------------------------------------------

const bookState = () => ({
  codebookId: 'b1',
  codebooks: [{ id: 'b1', name: 'Main' }],
  codes: [],
  segments: [],
});

test('added codes join the ACTIVE codebook and get palette colours', () => {
  const st = bookState();
  const n = addCodesFromText(st, 'Trust\nDelay');
  assert.equal(n, 2);
  assert.ok(st.codes.every((c) => c.codebookId === 'b1'), 'all in the active book');
  assert.ok(st.codes.every((c) => /^#[0-9a-f]{6}$/i.test(c.color)), 'every code has a colour');
  assert.notEqual(st.codes[0].color, st.codes[1].color, 'palette advances rather than repeating');
});

test('an explicit colour beats the palette', () => {
  const st = bookState();
  addCodesFromText(st, 'Trust, Relational, #123456');
  assert.equal(st.codes[0].color, '#123456');
  assert.equal(st.codes[0].group, 'Relational');
});

test('adding twice adds nothing the second time', () => {
  const st = bookState();
  addCodesFromText(st, 'Trust\nDelay');
  const n = addCodesFromText(st, 'Trust\nDelay');
  assert.equal(n, 0);
  assert.equal(st.codes.length, 2);
});

test('the same name in a DIFFERENT codebook is not a duplicate', () => {
  // Two books legitimately hold a code called "Trust" — they are separate schemes.
  const st = bookState();
  st.codebooks.push({ id: 'b2', name: 'Other' });
  st.codes.push({ id: 'x', name: 'Trust', codebookId: 'b2', color: '#fff', group: '' });
  assert.equal(addCodesFromText(st, 'Trust'), 1);
  assert.equal(st.codes.filter((c) => c.name === 'Trust').length, 2);
});

// --- writing CSV back out ---------------------------------------------------------

test('CSV round-trips through the parser', () => {
  // The export has to be re-importable, or "copy this codebook to another project"
  // silently loses themes and colours.
  const codes = [
    { name: 'Trust', group: 'Relational', color: '#8ecae6' },
    { name: 'Delay', group: '', color: '#ffd166' },
  ];
  const back = parseCodeList(codebookToCsv(codes).split('\n').slice(1).join('\n'));
  assert.deepEqual(back.map((c) => [c.name, c.group, c.color]),
    [['Trust', 'Relational', '#8ecae6'], ['Delay', '', '#ffd166']]);
});

test('CSV quotes commas, quotes and newlines', () => {
  const csv = codebookToCsv([{ name: 'Delay, unexplained', group: 'He said "no"', color: '#fff' }]);
  assert.match(csv, /"Delay, unexplained"/);
  assert.match(csv, /"He said ""no"""/);
  // …and the quoted name survives a round-trip.
  assert.equal(parseCodeList(csv.split('\n')[1])[0].name, 'Delay, unexplained');
});

test('CSV starts with a header row', () => {
  assert.equal(codebookToCsv([]).split('\n')[0], 'name,theme,colour');
});

// --- colour coercion ---------------------------------------------------------------

test('toHex never returns something <input type=color> will reject', () => {
  assert.equal(toHex('#8ecae6'), '#8ecae6');
  assert.equal(toHex('8ecae6'), '#8ecae6');
  assert.equal(toHex('#abc'), '#aabbcc');
  assert.equal(toHex('ABC'), '#aabbcc');
  for (const junk of ['', null, undefined, 'red', '#12345', 'rgb(1,2,3)', 42]) {
    assert.match(toHex(junk), /^#[0-9a-f]{6}$/, `${junk} produced an invalid colour`);
  }
});

// --- the CSV file pair -------------------------------------------------------------

test('an exported CSV re-imports without creating a code called "name"', () => {
  // The round-trip that matters: export a codebook, hand the file to a colleague, they
  // import it. Without a header skip the first code in every imported file is "name".
  const csv = codebookToCsv([{ name: 'Trust', group: 'Relational', color: '#8ecae6' }]);
  const back = parseCodeList(csv);
  assert.deepEqual(back.map((c) => c.name), ['Trust']);
});

test('the header skip is exact, not a guess at the first line', () => {
  // Only a real three-column header is dropped. A bare list whose first entry happens
  // to be an ordinary word must survive intact.
  assert.deepEqual(parseCodeList('name\ntheme').map((c) => c.name), ['name', 'theme']);
  assert.deepEqual(parseCodeList('Trust\nDelay').map((c) => c.name), ['Trust', 'Delay']);
  // …including the tab-separated and quoted spellings a spreadsheet emits.
  assert.deepEqual(parseCodeList('name\ttheme\tcolour\nTrust').map((c) => c.name), ['Trust']);
  assert.deepEqual(parseCodeList('"name","theme","color"\nTrust').map((c) => c.name), ['Trust']);
});
