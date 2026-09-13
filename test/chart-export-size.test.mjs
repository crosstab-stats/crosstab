/**
 * @file chart-export-size.test.mjs
 * A chart exports at the size it is on screen.
 *
 * Charts in the output pane are resizable by a corner grip, and that grip is the
 * resolution control: the point of dragging a chart bigger is to see the size it
 * will export at. The ⬇ PNG button broke that promise twice over — it multiplied
 * the on-screen size by 2, and then again by `devicePixelRatio`, so a chart set
 * to 595 wide landed on disk at 1190, and would have landed at 2380 on a HiDPI
 * laptop. The dimensions of a file should not depend on the monitor that made it.
 *
 * Rasterising needs a canvas, so what is pinned here is the wiring rather than
 * the bytes (the bytes were measured in the browser: a chart shown at 510 × 328
 * produced a PNG whose header reads 510 × 328). These checks are the ones that
 * would catch the multiplier creeping back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../core/results-pane.js', import.meta.url), 'utf8');

/** The body of a named top-level function, up to the next one. */
function bodyOf(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `expected a function ${name}`);
  const next = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

test('the download button asks for the on-screen size, not a multiple of it', () => {
  assert.match(bodyOf('savePlotPng'), /svgElToPngBytes\(svg,\s*1\)/,
    'the ⬇ PNG button must export at 1× — the grip is what changes the size');
});

test('the raster size never depends on the display', () => {
  const body = bodyOf('svgElToPngBytes');
  assert.doesNotMatch(body, /devicePixelRatio/,
    'a file\'s dimensions must not vary with the monitor it was exported from');
});

test('report embeds still get a denser raster than the screen', () => {
  // The other caller is getPlotPng, used by the HTML/Word exporters, where the
  // image is resampled into a document and 1× would look soft. It relies on the
  // default, so the default has to stay above 1.
  const sig = SRC.match(/function svgElToPngBytes\(svgEl,\s*scale\s*=\s*(\d+)\)/);
  assert.ok(sig, 'svgElToPngBytes should keep a default scale');
  assert.ok(Number(sig[1]) > 1, 'embedded rasters should be denser than the screen');
  // getPlotPng is a class method, so it is matched where it is written.
  const method = SRC.slice(SRC.indexOf('async getPlotPng(id)'));
  assert.ok(method, 'expected a getPlotPng method');
  assert.match(method.slice(0, 300), /svgElToPngBytes\(svg\)/,
    'the report path should take the default, not the button\'s 1×');
});

test('both buttons measure the same thing', () => {
  // One reader for "how big is this chart right now", so the vector and raster
  // exports cannot disagree about it.
  assert.match(SRC, /function shownSize\(svgEl\)/, 'expected a single size reader');
  for (const fn of ['svgElToPngBytes', 'serializeSvgEl']) {
    assert.match(bodyOf(fn), /shownSize\(/, `${fn} should measure through shownSize`);
  }
});

test('the exported SVG carries an intrinsic size, not just a viewBox', () => {
  // On the page a bare viewBox is right: the chart stretches to its box. In a
  // file it means the image has no natural size and every consumer invents one —
  // a browser opened the old export at 235 × 150.
  const body = bodyOf('serializeSvgEl');
  assert.match(body, /setAttribute\('width'/);
  assert.match(body, /setAttribute\('height'/);
});

test('the buttons say what size they will produce before they are pressed', () => {
  const body = bodyOf('exportButtons');
  assert.match(body, /pointerenter/, 'the size is read on hover, since the chart is resizable');
  assert.match(body, /shownSize\(/);
  assert.match(body, /title\s*=/, 'the size belongs in the tooltip, not only in the file');
});
