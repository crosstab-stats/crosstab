/**
 * @file history-touch-layout.test.mjs
 * The History panel on a touch screen, and why the Syntax gutter drifted (#191).
 *
 * Reported from an iPhone: *"the history panel has a number of elements that seem a bit
 * small on touch. Are those arrows and whatnot the right size? And the computation that
 * aligns the steps with the text in syntax mode appears off."*
 *
 * Both answers were yes. The controls were 20×22 with no small-screen rule at all — a gap
 * the contrast/keyboard pass never covered, made worse by this release adding a re-run
 * button and a delete on record rows. And the gutter positioned every label at
 * `pad + i * 26px` against a textarea given `font:13px/26px` INLINE: a fixed-metrics
 * contract held in two places, which breaks the moment anything changes the rendered size.
 * On mobile WebKit that is text auto-inflation, and the error is cumulative — further off
 * with every line, which is exactly what the screenshot showed.
 *
 * Source-level, because there is no DOM here. The geometry itself was measured in the
 * running app: markers land on whole line indices in both screen modes (26px and 44px),
 * and the glyph-to-marker offset is a constant −12px per line rather than a growing one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const view = readFileSync('core/data-views.js', 'utf8');

test('the document opts out of mobile text auto-inflation', () => {
  // results-pane.js has carried this for its tables since iPad Safari did the same thing
  // to them ("keep table text stable on iPad Safari"); the document itself never had it.
  assert.match(html, /html \{ -webkit-text-size-adjust: 100%; text-size-adjust: 100%; \}/);
});

test('100%, not `none` — a reader who raised their system text size keeps it', () => {
  assert.doesNotMatch(html, /text-size-adjust:\s*none/);
});

test('the editor and its colour backdrop share ONE metrics rule', () => {
  // The caret is positioned by the textarea and the glyphs are drawn by the backdrop. If
  // their font, line height or padding differ by so much as a pixel the two slide apart.
  const rule = html.slice(html.indexOf('.history-panel__ta,'), html.indexOf('[data-screen="small"] .history-panel__ta'));
  assert.match(rule, /\.history-panel__code \{/);
  assert.match(rule, /font: 13px\/26px ui-monospace/);
});

test('those metrics are in CSS, not inline — or no screen-mode rule could reach them', () => {
  // This is why `[data-screen="small"] textarea { font-size: 16px }` had no effect on the
  // Syntax editor: an inline `font:` shorthand beats every stylesheet rule there is.
  const editor = view.slice(view.indexOf('ensureSyntaxStyles();'), view.indexOf('#renderGutter()'));
  assert.doesNotMatch(editor, /font:13px/, 'the font must not be set inline any more');
  assert.doesNotMatch(editor, /\$\{FONT\}/);
});

test('the gutter MEASURES the line box instead of assuming the constant', () => {
  const metrics = view.slice(view.indexOf('#metrics() {'), view.indexOf('#renderGutter() {'));
  assert.match(metrics, /getComputedStyle\(this\.#ta\)/);
  assert.match(metrics, /parseFloat\(cs\.lineHeight\)/);
  assert.match(metrics, /parseFloat\(cs\.paddingTop\)/);
  // ...and falls back rather than producing NaN geometry if it cannot.
  assert.match(metrics, /Number\.isFinite\(lh\) && lh > 0 \? lh : SYN_LINE_H/);
});

test('marker positions use the measured values', () => {
  // A fixed window from the method start:  is CALLED earlier in the
  // file than it is declared, so slicing between the two names ran backwards.
  const start = view.indexOf('#renderGutter() {');
  const render = view.slice(start, start + 4000);
  assert.match(render, /const \{ lineH, pad \} = this\.#metrics\(\)/);
  assert.match(render, /height:\$\{lineH\}px; top:\$\{pad \+ i \* lineH\}px/);
  assert.doesNotMatch(render, /i \* SYN_LINE_H/, 'the hard-coded stride is gone');
});

test('a screen-mode change redraws the gutter', () => {
  // The line height differs between modes, so a mode change invalidates every marker
  // position. Nothing was redrawing them: the gutter kept the old spacing until the next
  // keystroke happened to trigger a render. Caught by toggling the mode in the app.
  assert.match(view, /SCREEN_MODE_CHANGED, \(\) => \{\s*if \(this\.#syntax && this\.#ta\) this\.#renderGutter\(\);/);
});

test('every History control is a 44px target on a small screen', () => {
  assert.match(html, /\[data-screen="small"\] \.history__ctlbtn \{\s*min-width: 44px; height: 44px;/);
});

test('the controls wrap rather than squeezing the step name', () => {
  // A stale analysis carries five (↻ R ▲ ▼ ✕) = 244px, which left the title 82px wide
  // until the body was given a floor. Measured before and after in the app.
  assert.match(html, /\[data-screen="small"\] \.history__step \{ flex-wrap: wrap; \}/);
  assert.match(html, /\[data-screen="small"\] \.history__btn \{ min-width: 60%; \}/);
});

test('that floor is a PERCENTAGE — a px floor is what breaks reflow', () => {
  // The known 1.4.10 leak in this codebase is `.ct-edit`'s 380px min-width breaking
  // dialogs under ~404px. Do not add a second one.
  const rule = html.slice(html.indexOf('[data-screen="small"] .history__btn {'));
  assert.doesNotMatch(rule.slice(0, 80), /min-width: \d+px/);
});

test('the gutter copies stay inside their line box', () => {
  // They sit in one absolutely-positioned row, so they can only be as tall as the line —
  // which is why the small-screen line height is 44px rather than the controls being
  // shrunk back down.
  assert.match(html, /\[data-screen="small"\] \.history-panel__gctl \.history__ctlbtn \{\s*min-width: 40px; height: 40px;/);
  assert.match(html, /\[data-screen="small"\] \.history-panel__ta,\s*\[data-screen="small"\] \.history-panel__code \{ font-size: 16px; line-height: 44px; \}/);
});
