/**
 * @file howto-render.test.mjs
 * The link boundary (#192 H2).
 *
 * This is the first time plugin-authored content may point anywhere. Before it, two
 * things held that closed: `renderMiniMarkdown` has no link grammar at all, and
 * `sanitize-html.js` allows no `<a>` and strips every URL-bearing attribute. The owner's
 * decision was to keep the sanitiser closed and give how-to bodies their own renderer
 * that builds nodes directly — so the href is set as a property on an element we made,
 * after the scheme has been checked, with no HTML string for a parser to disagree about.
 *
 * `classifyTarget` IS that boundary, so it is tested directly rather than through a DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyTarget, linkHost } from '../core/howto-render.js';

// --- the boundary ----------------------------------------------------------------

test('a howto: target is an internal topic link', () => {
  assert.deepEqual(classifyTarget('howto:recode-a-variable'), { kind: 'topic', value: 'recode-a-variable' });
  assert.deepEqual(classifyTarget('HOWTO:Mixed-Case'), { kind: 'topic', value: 'Mixed-Case' });
});

test('http AND https are both external links', () => {
  // The owner: "not everyone is using https".
  assert.equal(classifyTarget('https://example.org/guide').kind, 'external');
  assert.equal(classifyTarget('http://example.org/guide').kind, 'external');
  assert.equal(classifyTarget('https://example.org/guide').host, 'example.org');
});

test('every other scheme is NOT a link', () => {
  // The whole point. A hostile or malformed target degrades to prose rather than a trap —
  // `javascript:` in particular would be script execution in the host origin.
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.org/abc',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'about:blank',
    'ftp://example.org/x',
    'mailto:someone@example.org',
    '//example.org/protocol-relative',
    'example.org',
    '',
    '   ',
  ]) {
    assert.equal(classifyTarget(bad).kind, 'none', bad);
  }
});

test('an asset: target is a local image reference', () => {
  assert.deepEqual(classifyTarget('asset:crosstab.png'), { kind: 'asset', value: 'crosstab.png' });
});

test('an empty howto:/asset: target is not a link', () => {
  assert.equal(classifyTarget('howto:').kind, 'none');
  assert.equal(classifyTarget('asset:  ').kind, 'none');
});

test('a URL whose host cannot be read is not offered as a link', () => {
  // We caption external links with their host; one we cannot caption honestly, we do not
  // render as a link at all.
  assert.equal(linkHost('https://'), null);
  assert.equal(classifyTarget('https://').kind, 'none');
});

test('null and undefined are handled, not thrown on', () => {
  assert.equal(classifyTarget(null).kind, 'none');
  assert.equal(classifyTarget(undefined).kind, 'none');
});

// --- the things that must NOT have changed ---------------------------------------

const sanitizer = readFileSync('core/sanitize-html.js', 'utf8');
const results = readFileSync('core/results-pane.js', 'utf8');
const render = readFileSync('core/howto-render.js', 'utf8');

test('the sanitiser is still closed to anchors and URLs', () => {
  const tags = sanitizer.slice(sanitizer.indexOf('const ALLOWED_TAGS'), sanitizer.indexOf('const ALLOWED_TAGS') + 600);
  assert.doesNotMatch(tags, /'a'/, 'no anchor in the allowlist');
  assert.doesNotMatch(sanitizer, /ALLOWED_ATTRS[^\n]*href/);
});

test('link support did NOT leak into the renderer plugin result notes share', () => {
  // Teaching `renderMiniMarkdown` link syntax would have given every analysis result the
  // power to point anywhere. The blast radius of a shared renderer is the union of its
  // callers' trust levels, not the lowest.
  const mini = results.slice(results.indexOf('function renderMiniMarkdown'), results.indexOf('function renderMiniMarkdown') + 1400);
  assert.doesNotMatch(mini, /<a\b/);
  assert.doesNotMatch(mini, /\]\(/, 'no markdown link grammar');
});

test('external links carry noopener AND noreferrer, and open in a new tab', () => {
  assert.match(render, /a\.rel = 'noopener noreferrer'/);
  assert.match(render, /a\.target = '_blank'/);
});

test('the destination host is shown in the link text', () => {
  // The measure that actually defeats phishing: a link captioned "SPSS documentation"
  // pointing at evil.tld indicts itself, every time, with no dialog to train people to
  // dismiss.
  assert.match(render, /text: ` \(\$\{host\}\)`/);
});

test('the renderer never assigns innerHTML', () => {
  // It builds nodes; there is no HTML string anywhere for a parser to disagree with us
  // about. This is what lets the sanitiser stay closed.
  assert.doesNotMatch(render, /innerHTML/);
  assert.doesNotMatch(render, /insertAdjacentHTML/);
});

test('images are local assets only — never a remote URL', () => {
  // An external link is user-initiated; an external image fetches the moment the topic
  // opens — a beacon reporting the reader's address and reading time, and a broken box in
  // an air-gapped deployment.
  const img = render.slice(render.indexOf('function imageFor'), render.indexOf('export function renderHowto'));
  assert.match(img, /resolveAsset\?\.\(candidate\)/);
  assert.doesNotMatch(img, /https?:/, 'no URL path into an image');
});

test('a screenshot asks for the variant matching the current screen mode', () => {
  // Small-screen mode is not a narrower desktop — the menubar becomes a hamburger — so a
  // desktop screenshot shown to a phone reader depicts a UI they do not have. Shipping
  // one image still works: the other name is the fallback.
  assert.match(render, /\.small\$1/);
  assert.match(render, /const small = \(screen \?\? currentScreenMode\(\)\) === 'small'/);
});
