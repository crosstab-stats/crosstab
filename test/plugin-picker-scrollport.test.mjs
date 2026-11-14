/**
 * @file plugin-picker-scrollport.test.mjs
 * One picker, two hosts, and exactly one scroller between them.
 *
 * ## The bug this closes
 *
 * On a small screen the picker gives up its own scroll container on purpose: a list that
 * scrolls inside a page that also scrolls traps a touch drag, which is the mobile
 * behaviour the small-screen mode exists to avoid. The rule that does it —
 * `[data-screen="small"] .ctp__list { overflow: visible; max-height: none; ... }` — was
 * written in the LAUNCHER's stylesheet, where the launcher's own body is the scrollport
 * that takes over.
 *
 * But a stylesheet is global. Edit ▸ Plugins mounts the same component in a modal, and the
 * modal inherited "do not scroll" without inheriting a scrollport, so the list sized to its
 * content inside a box nothing clipped. Measured in headless Chrome at 360x640, before the
 * fix: 679px of rows inside a 184px box, painted straight over a Done button that was
 * itself 103px below the dialog's bottom edge — `elementFromPoint` at the button's own
 * centre returned nothing at all. That is what the owner photographed on an iPhone
 * (2026-11-13): the plugin rows sitting on top of Done.
 *
 * ## The invariant
 *
 * The decision belongs to the picker, so it lives in the picker's sheet; and every host
 * that mounts the picker owes it a scrollport, with the buttons OUTSIDE that scrollport so
 * they cannot be scrolled away or painted over. Both halves are asserted here, because
 * either one alone is the bug.
 *
 * What is not covered: the pixels. Those were measured in a real engine at 390x844,
 * 844x390, 360x640 and 1280x800 — rows painted outside the list box went 613px -> 0px and
 * Done moved from 103px below the fold to on screen and hit-testable, with the desktop
 * layout identical to the pixel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const picker = readFileSync('core/plugin-picker.js', 'utf8');
const launcher = readFileSync('core/launcher.js', 'utf8');
const manager = readFileSync('core/plugin-manager.js', 'utf8');

/** The injected stylesheet of a module, as it will actually reach the page. */
function sheet(src) {
  // The newline is what distinguishes the sheet from the one-line template literals the
  // same modules use for status text.
  const open = src.indexOf('.textContent = `\n');
  const start = open + '.textContent = `\n'.length;
  const end = src.indexOf('`', start);
  assert.ok(open > 0 && end > start, 'module injects a stylesheet');
  return src.slice(start, end);
}

const pickerCss = sheet(picker);
const launcherCss = sheet(launcher);

// =============================================================================
// The decision lives with the component
// =============================================================================

test('the picker, not a host, says the list stops scrolling on a small screen', () => {
  assert.match(pickerCss, /\[data-screen="small"\]\s*\.ctp__list\s*\{[^}]*overflow:\s*visible/);
  // The same rule in a host's sheet is how this went wrong: it reached a host that had not
  // agreed to it.
  assert.doesNotMatch(launcherCss, /\.ctp__list\s*\{/);
  assert.doesNotMatch(launcherCss, /\.ctp__sectionhead\s*\{/);
});

// =============================================================================
// ...and every host owes it a scrollport
// =============================================================================

test('the launcher scrolls its body', () => {
  assert.ok(launcher.includes('new PluginPicker('), 'the launcher is still a host');
  assert.match(launcherCss, /\[data-screen="small"\]\s*\.ctl__body\s*\{[^}]*overflow-y:\s*auto/);
});

test('the modal scrolls its body', () => {
  assert.ok(manager.includes('openPluginModal('), 'Edit ▸ Plugins is still a host');
  assert.match(pickerCss, /\[data-screen="small"\]\s*\.ctp-dialog__body\s*\{[^}]*overflow-y:\s*auto/);
  // And the picker inside it sizes to its content, or the list is handed a short definite
  // height again and spills out of it exactly as before.
  assert.match(pickerCss, /\[data-screen="small"\]\s*\.ctp-dialog__body\s*>\s*\.ctp\s*\{[^}]*flex:\s*none/);
});

test('the buttons sit outside the scrollport, at every size', () => {
  // A column dialog: title and buttons keep their measured height, the body gives way.
  assert.match(pickerCss, /\.ctp-dialog\[open\]\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(pickerCss, /\.ctp-dialog\s+\.ct-dialog__form\s*\{[^}]*flex-direction:\s*column/);
  assert.match(pickerCss, /\.ctp-dialog\s+\.ct-dialog__buttons\s*\{\s*flex:\s*none/);
  // Desktop keeps a fixed-height body, so it is the one that must CLIP a squeezed list —
  // the landscape case, where the list's 140px floor used to win and paint over the row.
  assert.match(pickerCss, /\.ctp-dialog__body\s*\{[^}]*overflow:\s*hidden/);
});

test('the button row survives a scrollport it did not expect', () => {
  // The belt and braces for the one engine that cannot be measured here. Verified by
  // breaking the layout on purpose (body { flex: none }, so the form runs taller than the
  // dialog and the dialog scrolls, which is the pre-fix geometry): with the sticky rule,
  // Done stayed on screen and elementFromPoint at its centre still returned the button.
  assert.match(pickerCss, /\.ctp-dialog\s+\.ct-dialog__buttons\s*\{[^}]*position:\s*sticky/);
  // Opaque, or the rows scroll through it; and above .ctp__sectionhead's z-index: 1.
  assert.match(pickerCss, /\.ctp-dialog\s+\.ct-dialog__buttons\s*\{[^}]*background:\s*\w/);
  assert.match(pickerCss, /\.ctp-dialog\s+\.ct-dialog__buttons\s*\{[^}]*z-index:\s*2/);
  assert.match(pickerCss, /\.ctp__sectionhead\s*\{[^}]*z-index:\s*1\b/);
});

test('display:flex on a dialog is qualified by [open]', () => {
  // A bare author `display` outranks the UA's `dialog:not([open]) { display: none }` and
  // pins the dialog open forever — the trap the shell and the launcher both carry notes
  // about, and the reason this rule is not simply `.ctp-dialog { display: flex }`.
  // Only selectors whose SUBJECT is the dialog element itself — `.ctp-dialog__body` is a
  // div inside it and may say display what it likes.
  const isDialog = (sel) => /(^|\s|,)(dialog\b|\.ctl(?![\w-])|\.ctp-dialog(?![\w-]))/.test(sel);
  for (const css of [pickerCss, launcherCss]) {
    for (const rule of css.matchAll(/(^|\})\s*([^{}]+)\{([^}]*)\}/g)) {
      const [, , selector, body] = rule;
      if (!isDialog(selector) || !/display:\s*(flex|block|grid)/.test(body)) continue;
      assert.match(selector, /\[open\]/, `an open-state display needs [open]: ${selector.trim()}`);
    }
  }
});

// =============================================================================
// The stylesheet reaches the page intact
// =============================================================================

test('no backtick inside an injected stylesheet', () => {
  // These sheets are template literals, so a backtick in a CSS comment ends the string
  // early. It still PARSES — the halves rejoin as valid JavaScript — so `node --check`
  // passes while the page silently loses every rule after the comment. Caught twice while
  // writing the fix above, both times in prose quoting a selector.
  for (const [name, css] of [['plugin-picker.js', pickerCss], ['launcher.js', launcherCss]]) {
    // The last declaration of each sheet, reached only if nothing cut the string short.
    assert.match(css, /\}\s*$/, `${name}: the sheet ends on a closing brace`);
    assert.ok(css.length > 1000, `${name}: the sheet is not truncated`);
  }
});
