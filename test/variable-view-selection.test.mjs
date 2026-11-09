/**
 * @file variable-view-selection.test.mjs
 * Variable View can SET the working set, not just display it.
 *
 * Both variable surfaces float the selection to the top (#180), but only the Data grid's
 * column headers could tick it. So a user scanning several thousand variables in the list
 * that is actually about the variables had to go back to the grid to select the ones they
 * had just found. The row checkbox closes that.
 *
 * The suite runs `node --test` with no DOM, so what is pinned here is the WIRING that is
 * silently breakable — the checkbox not reaching the row's click-to-edit handler, the
 * cross-surface sync subscription, the empty-state colSpan keeping step with the new
 * column. The behaviour itself was driven in a real browser: ticking in Variable View
 * sets `getSelectedVariables()` with no dialog opened, the grid's header boxes already
 * agree when you switch tabs, unticking in the grid updates the rows here, and clicking
 * the row (rather than the box) still opens the editor.
 *
 * Run: `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
/** A correct comment must never be what satisfies an assertion about the code. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const VIEWS = strip(read('../core/data-views.js'));
const APP = strip(read('../core/app.js'));
const CSS = strip(read('../index.html'));

/** VariableView's body — so none of this is accidentally satisfied by the Data grid,
 *  which has had its own selection checkboxes all along. */
const VARVIEW = VIEWS.slice(VIEWS.indexOf('export class VariableView'), VIEWS.indexOf('export class HistoryView'));

test('the Variables list renders a selection checkbox, first in the row', () => {
  assert.match(VARVIEW, /vargrid__selhead/, 'a header for the column');
  assert.match(VARVIEW, /#selectCell\(m, selected\)/, 'and a cell per row');
  // Order matters: it is a gutter beside the row number, not a column buried in the data.
  const row = VARVIEW.slice(VARVIEW.indexOf('const tr = document.createElement'), VARVIEW.indexOf('frag.append(tr)'));
  assert.ok(
    row.indexOf('#selectCell') < row.indexOf('openerCellFor'),
    'the checkbox cell must be appended before the name cell',
  );
});

test('the header column is announced, not left blank', () => {
  // Its visible text is a glyph, so without this a screen reader reads an empty column
  // header for a column of controls.
  assert.match(VARVIEW, /selHead\.setAttribute\('aria-label', 'Selected'\)/);
  assert.match(VARVIEW, /aria-label.*Select \$\{m\.label/, 'and each box names its variable');
});

test('ticking a box does not open the variable editor', () => {
  // The row is click-to-edit. Without stopPropagation, ticking seven variables means
  // dismissing seven modals — which is worse than not having the checkbox.
  assert.match(VARVIEW, /cb\.addEventListener\('click', \(e\) => e\.stopPropagation\(\)\)/);
  assert.match(VARVIEW, /td\.addEventListener\('click', \(e\) => e\.stopPropagation\(\)\)/, 'the cell padding too');
});

test('the box writes the one shared selection, the same call the grid makes', () => {
  assert.match(VARVIEW, /this\.store\.setSelectedVariables\(\[\.\.\.sel\]\)/);
  // Read once per render, not once per row: this list runs to thousands of variables.
  assert.match(VARVIEW, /const selected = new Set\(this\.store\.getSelectedVariables\(\)\)/);
  assert.match(VARVIEW, /cb\.checked = selected\.has\(m\.name\)/);
});

test('both surfaces re-sync when the selection changes anywhere', () => {
  assert.match(VARVIEW, /\n  syncSelection\(\) \{/, 'VariableView has to expose one');
  const sub = APP.slice(APP.indexOf('bus.on(CoreEvents.SELECTION_CHANGED'), APP.indexOf('const shellDeps'));
  assert.match(sub, /dataView\.syncSelection\(\)/);
  assert.match(sub, /variableView\.syncSelection\(\)/, 'the grid alone was the old wiring');
});

test('the count reports the selection here too, as the grid does', () => {
  const body = VARVIEW.slice(VARVIEW.indexOf('#updateCount() {'));
  assert.match(body, /\$\{n\} selected/);
  assert.match(body, /getSelectedVariables\(\)\.length/);
});

test('the empty-state row still spans every column', () => {
  // Seven headers now; a colSpan left at 6 makes the "no variables match" message sit
  // under a stray empty cell.
  const heads = VARVIEW.match(/for \(const h of \[([^\]]+)\]\)/);
  assert.ok(heads, 'the header list should still be a literal array');
  const n = heads[1].split(',').length + 1; // +1 for the selection column
  assert.equal(n, 7);
  assert.match(VARVIEW, new RegExp(`td\\.colSpan = ${n};`));
});

test('the selection column is styled as a gutter, not a data column', () => {
  assert.match(CSS, /\.vargrid__selhead, \.vargrid__selcell \{/);
  assert.match(CSS, /\.vargrid__check \{/);
  // The other cells are top-aligned for wrapping text; a checkbox has none to wrap.
  const rule = CSS.slice(CSS.indexOf('.vargrid__selhead, .vargrid__selcell {'));
  assert.match(rule.slice(0, 220), /vertical-align: middle/);
});
