/**
 * @file baked-params.test.mjs
 * Parameter controls on an R-drawn figure (#203).
 *
 * The owner's constraint was "where reasonable", and the line was already drawn by the
 * 2026-10-15 investigation — this file is mostly here to keep it drawn:
 *
 *  - **Appearance** (title, caption, legend text and position, layer placement, plot size)
 *    is already live and needs no R, because a baked figure is a chart whose plot layer
 *    holds a foreign SVG. Nothing was added for it and nothing should be.
 *  - **Parameters** (a layout, a k, a distance metric, a projection) necessarily re-invoke
 *    R, and that is acceptable *precisely because* the user expects a recompute when they
 *    change one. The investigation's own test: "a legend dropdown that takes three seconds
 *    and spins up R is worse than no dropdown."
 *
 * So the whole design question is which side a control falls on, and the answer is carried
 * in the data: `params` re-invoke, everything else is a view edit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { bakedModel } = await import('../core/charts/baked.js');
// `baked` REGISTERS itself (core/charts/baked.js calls registerChartKind) rather than
// exporting a kind object, so the controls are read back the way the host reads them.
// Importing baked.js above for its side effect is what puts it in the registry.
const { getChartKind } = await import('../core/charts/runtime.js');
const bakedKind = getChartKind('baked');
const BAKED = readFileSync('core/charts/baked.js', 'utf8');
const PANE = readFileSync('core/results-pane.js', 'utf8');
const CONTROLS = readFileSync('core/chart-controls.js', 'utf8');
const SNA = readFileSync('plugins/builtin-sna/index.js', 'utf8');

const SVG = '<svg viewBox="0 0 10 10"></svg>';
const withParams = (params, redraw = { plugin: 'p', fn: 'f' }) =>
  bakedModel({ svg: SVG, params, redraw });

// ---------------------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------------------

test('a figure with no parameters is unchanged — the default stays free', () => {
  const m = bakedModel({ svg: SVG });
  assert.deepEqual(m.params, []);
  assert.equal(m.redraw, null);
});

test('a half-written parameter costs that parameter, not the figure', () => {
  // Same rule as every other declaration the host takes from a plugin. A parameter with
  // no options could only draw an empty select; one with no id could not be read back.
  const m = withParams([
    { id: 'ok', label: 'Fine', options: [['a', 'A'], ['b', 'B']] },
    { id: 'no-options', label: 'Broken' },
    { label: 'No id', options: [['a', 'A']] },
    null,
    'nonsense',
  ]);
  assert.deepEqual(m.params.map((p) => p.id), ['ok']);
});

test('a parameter without a redraw function is not a control', () => {
  // It would render a select that could do nothing. The pair is the unit.
  const m = bakedModel({ svg: SVG, params: [{ id: 'k', options: [['1', '1']] }], redraw: null });
  const controls = bakedKind.controls(m);
  assert.ok(!controls.some((c) => c.id.startsWith('param:')), 'no orphan control');
  // And a redraw that names no function is dropped rather than half-kept.
  assert.equal(bakedModel({ svg: SVG, redraw: { plugin: 'p' } }).redraw, null);
});

test('options normalise to [value, label] pairs, and a bare value is both', () => {
  const m = withParams([{ id: 'k', options: ['fr', ['kk', 'Kamada-Kawai'], '', null] }]);
  assert.deepEqual(m.params[0].options, [['fr', 'fr'], ['kk', 'Kamada-Kawai']]);
  assert.equal(m.params[0].default, 'fr', 'the first option, when none is declared');
  assert.equal(m.params[0].label, 'k', 'the id, when no label is declared');
});

// ---------------------------------------------------------------------------------------
// Where the controls sit
// ---------------------------------------------------------------------------------------

test('parameter controls come LAST and say what they cost', () => {
  const m = withParams([{ id: 'layout', label: 'Layout', options: [['fr', 'FR'], ['kk', 'KK']] }]);
  const controls = bakedKind.controls(m);
  const paramAt = controls.findIndex((c) => c.id === 'param:layout');
  assert.ok(paramAt > 0, 'it is there');
  assert.equal(paramAt, controls.length - 1, 'and it is last');
  // A reader scanning for the title box must not pass a control that spins up R on the
  // way, so the group name warns rather than the control being quietly expensive.
  assert.match(controls[paramAt].group, /recompute/i);
  // The furniture is still there and still first.
  assert.ok(controls.some((c) => c.id === 'captionText'), 'the caption survives');
});

test('the panel reports WHICH control moved, or the pane cannot tell them apart', () => {
  // Every other caller in chart-controls passes nothing and still works; the argument is
  // additive. But a view repaint cannot satisfy a parameter change, so the id is the only
  // thing that distinguishes "move the legend" from "recompute the figure".
  assert.match(CONTROLS, /onChange\(ctl\.id\)/);
  assert.match(PANE, /changed\.startsWith\('param:'\)/);
});

// ---------------------------------------------------------------------------------------
// What a redraw must and must not do
// ---------------------------------------------------------------------------------------

test('a failed redraw keeps the figure that is on screen', () => {
  // The previous SVG is still correct for the previous parameters. Replacing a valid
  // figure with an error would destroy what the reader was looking at in order to report
  // that they cannot have a different one.
  const at = PANE.indexOf('async #redrawFigure(');
  const body = PANE.slice(at, PANE.indexOf('\n  }', at));
  assert.match(body, /catch/, 'it is guarded');
  assert.ok(!/item\.model\.svg = ''/.test(body), 'the old figure is never cleared');
  // And the control goes back, so the panel never advertises a setting the picture does
  // not reflect.
  assert.match(body, /before\[k\]/, 'the previous parameter value is restored');
  assert.match(body, /data-busy/, 'and the wait is shown rather than hidden');
});

test('the SVG a plugin returns is sanitised like any other', () => {
  const at = PANE.indexOf('async #redrawFigure(');
  const body = PANE.slice(at, PANE.indexOf('\n  }', at));
  assert.match(body, /sanitizeHtml\(svg\)/, 'a redraw is not a trusted path');
  assert.match(body, /<svg\[/, 'and a non-figure reply is rejected rather than inserted');
});

test('the pane is HANDED the redraw, it does not reach for the loader', () => {
  assert.match(PANE, /redrawBaked = null/, 'injected, with no default behaviour');
  // Matching CODE, not prose: the comment above the field explains that this pane does not
  // reach for the loader, and an `includes('loader')` check failed on that explanation --
  // the third time this session a correct comment broke an absence assertion.
  const code = PANE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bloader\b/.test(code), 'the pane never learns what a plugin loader is');
});

// ---------------------------------------------------------------------------------------
// The first plugin to use it
// ---------------------------------------------------------------------------------------

test('builtin-sna offers a layout and nothing cosmetic', () => {
  assert.match(SNA, /id: 'layout'/);
  // Matches the fn and the ARGS separately, because the redraw must carry the run's
  // context: the first version named only plugin+fn and the redraw failed at runtime with
  // "object 'from' not found" -- a bare invoke binds no analysis inputs.
  assert.match(SNA, /fn: 'redrawNetwork', args: \{ from: fromName, to: toName, directed \}/);
  assert.match(SNA, /export async function redrawNetwork\(/);
  // The point of "where reasonable": a layout is a claim about the graph that the reader
  // is expected to recompute. A colour or a font would not be.
  const at = SNA.indexOf("params: [{");
  const block = SNA.slice(at, SNA.indexOf('}],', at));
  for (const cosmetic of ['color', 'colour', 'font', 'title']) {
    assert.ok(!block.toLowerCase().includes(cosmetic), `no ${cosmetic} parameter`);
  }
});

test('one definition of the plot call, shared by the first draw and every redraw', () => {
  // Two copies drift: the redraw would keep the old vertex sizing or palette, and the
  // figure would change in ways the reader did not ask for when they picked a layout.
  assert.match(SNA, /function plotSource\(layout\)/);
  assert.equal((SNA.match(/plotSource\(/g) || []).length, 3, 'defined once, called twice');
  assert.equal((SNA.match(/svgstring\(/g) || []).length, 1, 'one svgstring in the file');
});

test('a layout the figure was saved with but the code dropped still draws', () => {
  // The view persists, so an unknown id must fall back rather than throw -- otherwise a
  // chart saved today stops rendering after a release that renames a layout.
  const at = SNA.indexOf('function layoutCall(');
  const body = SNA.slice(at, SNA.indexOf('\n}', at));
  assert.match(body, /default:/, 'there is a fallback');
  assert.match(body, /layout_with_fr/, 'and it is a real layout');
});

test('the same layout redraws identically', () => {
  // A figure that reshuffled every time the panel was touched would be unreadable, and
  // uncitable: a methods section cannot describe a picture that changes on its own.
  const at = BAKED.indexOf('function paramControls(');
  assert.ok(at > 0);
  assert.match(SNA, /set\.seed\(1\)/);
  assert.equal((SNA.match(/set\.seed\(/g) || []).length, 1, 'seeded in the shared source only');
});
