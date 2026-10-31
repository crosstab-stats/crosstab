/**
 * @file plugin-screen-mode.test.mjs
 * Part 2 of the plugin stdlib: the host's layout decision reaches a plugin pane, and the
 * shared stylesheet turns it into a layout.
 *
 * ## The gap this closes
 *
 * A workspace pane is a separate document in an opaque-origin iframe and inherits nothing
 * from the host — not the stylesheet, not the custom properties. Before this, screen mode
 * was **never sent across the boundary**: no `data-screen` anywhere in the broker,
 * workspace-manager or loader, `onScreenModeChange` had exactly one subscriber (the host
 * re-laying-out itself), and no plugin contained a single layout `@media` query.
 *
 * So CAQDAS laid out identically at 1400px and 390px. The owner's iPhone screenshot
 * (2026-10-10) showed what that costs: the body is a flex ROW holding a 230px document
 * list, a flexible text column and a 240px codebook — 470px of fixed rails at a 390px
 * viewport, leaving the text column nothing. It squeezed to about one character per line
 * while the codebook ran off the edge. "Unusable" was the owner's word and it was fair.
 *
 * ## Why POST the mode rather than let a plugin measure
 *
 * `screen-mode.js` is explicit that no CSS anywhere keys off viewport width, because the
 * mode is a USER'S CHOICE. A pane keyed to its own iframe width would override someone
 * who deliberately picked the full layout on a narrow screen — the exact objection the
 * feature was built around. The host owns state the plugin needs and cannot derive.
 *
 * ## What is NOT covered here
 *
 * That the pane visually reflows. The frame is opaque-origin, so the host page cannot read
 * into its `contentDocument`, and a screenshot of a backgrounded tab does not reliably
 * paint it. Everything up to the frame boundary is asserted below; the pixels need a
 * device, which is how the bug was found in the first place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BASE_CSS, TOKENS, screenMode, injectStdlibStyles } from '../core/plugin-stdlib.js';

const broker = readFileSync('core/plugin-broker.js', 'utf8');
const manager = readFileSync('core/workspace-manager.js', 'utf8');
const host = readFileSync('plugin-host.html', 'utf8');
const caqdas = readFileSync('plugins/builtin-caqdas/index.js', 'utf8');
const spatial = readFileSync('plugins/builtin-spatial/index.js', 'utf8');
const decisions = readFileSync('plugins/builtin-decisions/index.js', 'utf8');

// =============================================================================
// The chain, link by link
// =============================================================================

test('the broker has a verb for it', () => {
  assert.match(broker, /sendScreen\(mode\) \{\s*this\.#post\(\{ t: 'screen', mode \}\);/);
});

test('a pane is told at mount, before it renders', () => {
  // Otherwise it lays out for the default and then reflows, which is a visible flinch on
  // the one screen where it matters.
  assert.match(manager, /broker\.sendScreen\(currentScreenMode\(\)\)/);
});

test('…and again whenever the user toggles', () => {
  assert.match(manager, /onScreenModeChange\(\(mode\) => \{/);
  assert.match(manager, /entry\.broker\?\.sendScreen\?\.\(mode\)/);
});

test('the frame mirrors it onto its own root, using the host’s own attribute', () => {
  // Same attribute name and same values, so a plugin's CSS selector is identical to the
  // host's. Anything else would be a second convention to remember.
  assert.match(host, /case 'screen':/);
  assert.match(host, /document\.documentElement\.setAttribute\('data-screen', msg\.mode\)/);
  assert.match(host, /msg\.mode === 'small' \|\| msg\.mode === 'full'/, 'and refuses anything else');
});

test('workspace plugins get the stdlib too — the gap part 1 left', () => {
  // The workspace mount path is NOT the one in loader.js, and it passed only `source`.
  // That is how the pane plugins — the ones that build the most UI — ended up as the only
  // plugins without app.std.
  assert.match(manager, /sendLoad\(source, null, null, await pluginStdlibSource\(\)\)/);
});

// =============================================================================
// What a plugin can do with it
// =============================================================================

test('screenMode reads the attribute and never measures', () => {
  const doc = (v) => ({ documentElement: { getAttribute: () => v } });
  assert.equal(screenMode(doc('small')), 'small');
  assert.equal(screenMode(doc('full')), 'full');
});

test('an unset mode is "full", not a guess from a width', () => {
  // A plugin on an older host gets the layout it has always had. Guessing from a width is
  // exactly the thing that would override a deliberate choice.
  assert.equal(screenMode({ documentElement: { getAttribute: () => null } }), 'full');
  assert.equal(screenMode(undefined), 'full');
});

test('the base stylesheet carries the tokens a pane cannot inherit', () => {
  assert.match(BASE_CSS, /--ct-accent: #2572a5/);
  assert.equal(TOKENS.accent, '#2572a5');
  assert.match(BASE_CSS, /--ct-radius/);
});

test('its components reflow themselves, so a plugin gets it by USING them', () => {
  assert.match(BASE_CSS, /\[data-screen="small"\] \.ct-split \{ flex-direction: column; \}/);
  assert.match(BASE_CSS, /\[data-screen="small"\][\s\S]*font-size: 16px/, 'iOS zooms a focused control under 16px');
  assert.match(BASE_CSS, /min-height: 44px/, 'touch target');
});

test('the stylesheet is injected once, however often a pane re-renders', () => {
  const made = [];
  const doc = {
    getElementById: (id) => made.find((e) => e.id === id) || null,
    createElement: () => { const e = { id: '', textContent: '' }; return e; },
    head: { append: (e) => made.push(e) },
  };
  injectStdlibStyles(doc, 'x{}');
  injectStdlibStyles(doc, 'x{}');
  assert.equal(made.length, 1);
});

test('no backtick hides in the CSS template — that has bitten three times today', () => {
  // A backtick inside a CSS comment terminates the JS template literal early. What remains
  // still parses, so `node --check` passes and the stylesheet silently truncates.
  const src = readFileSync('core/plugin-stdlib.js', 'utf8');
  const open = src.indexOf('export const BASE_CSS = `');
  const close = src.indexOf('`;', open + 30);
  assert.ok(open > 0 && close > open);
  assert.doesNotMatch(src.slice(open + 25, close), /`/);
});

// =============================================================================
// CAQDAS, the pane that proved the need
// =============================================================================

test('CAQDAS stacks its three columns in small mode', () => {
  assert.match(caqdas, /\[data-screen="small"\] \.caqdas__body \{ flex-direction: column; \}/);
});

test('…and its fixed rails stop being fixed', () => {
  // 230px + 240px of rails at a 390px viewport is what left the text column nothing.
  const rule = caqdas.slice(caqdas.indexOf('[data-screen="small"] .caqdas__docs'));
  assert.match(rule.slice(0, 400), /width: auto; flex: none; max-height/);
});

test('…while the text column keeps room to be read', () => {
  assert.match(caqdas, /\[data-screen="small"\] \.caqdas__text \{ flex: 1 1 auto; min-height: 40vh/);
});

test('…and its controls meet the touch target', () => {
  assert.match(caqdas, /\[data-screen="small"\][\s\S]{0,200}min-height: 44px/);
});

test('…but the no-zoom font is NOT conditional on our screen mode', () => {
  // These two used to be one rule under [data-screen="small"], and that was wrong for
  // the font half. iOS zooms the viewport whenever a FOCUSED control is under 16px and
  // has never heard of our setting — so a phone in the FULL layout zoomed on every tap
  // into a time field, which is how this was reported. 44px is a touch-target decision
  // and stays keyed to small mode; 16px is a floor that applies everywhere.
  const rule = caqdas.slice(caqdas.indexOf('.caqdas input, .caqdas select'));
  assert.ok(rule.startsWith('.caqdas input, .caqdas select'), 'the unconditional rule exists');
  assert.match(rule.slice(0, 200), /font-size: 16px/);
  assert.ok(
    !caqdas.slice(0, caqdas.indexOf('.caqdas input, .caqdas select')).endsWith('[data-screen="small"] '),
    'and is not nested under a screen-mode selector',
  );
  // The Transcripts tab is covered too — it had no stylesheet of its own at all.
  assert.match(rule.slice(0, 200), /\.caqdas-tx input/);
});

test('touch targets follow the POINTER, not the chosen layout', () => {
  // Every other 44px rule here is keyed to [data-screen="small"], which is a user's
  // CHOICE of layout. Reported from a phone in the FULL layout, where none of them
  // applied: measured buttons at 31px. "pointer: coarse" asks the question that actually
  // matters — is a finger driving this — and a phone in the full layout is still a phone.
  assert.match(caqdas, /@media \(pointer: coarse\)/, 'the pointer query exists');
  const at = caqdas.indexOf('@media (pointer: coarse)');
  const block = caqdas.slice(at, at + 420);
  assert.match(block, /\.caqdas-tx button[^}]*min-height: 44px/);
  assert.match(block, /\.caqdas-tx summary[^}]*min-height: 44px/, 'including the caveat disclosures');
});

test('the Transcripts tab takes the shared sheets, like the Coding tab', () => {
  // Measured before this: zero stylesheets in that frame, controls at 12px, every one of
  // them a viewport zoom on iOS.
  const at = caqdas.indexOf('async function mountTranscripts');
  // Wide enough to clear the local helpers between the injection and the class hook.
  const head = caqdas.slice(at, at + 2200);
  assert.match(head, /app\.std\?\.injectStdlibStyles\?\.\(document\)/, 'host tokens first');
  assert.match(head, /sheet\.replaceSync\(STYLES\)/, 'then the plugin rules');
  assert.match(head, /classList\.add\('caqdas-tx'\)/, 'and a hook for them to reach');
});

test('CAQDAS takes the host base sheet before layering its own', () => {
  assert.match(caqdas, /app\.std\?\.injectStdlibStyles\?\.\(document\)/);
  // Optional-chained: a build that failed to serve the stdlib must not take the pane down.
  assert.ok(caqdas.indexOf('injectStdlibStyles') < caqdas.indexOf('sheet.replaceSync(STYLES)'),
    'host tokens first, plugin rules on top');
});

// ---------------------------------------------------------------------------------------
// builtin-spatial (2026-10-12) — the second pane to reflow, and the first caller of the
// stdlib's layout COMPONENTS rather than a hand-rolled copy of them.
//
// Measured in a browser against the real stylesheets before these were written. At 390px:
//
//                      before              after
//   map pane           170 x 780           390 x 351   (stacked above, not squeezed beside)
//   region list        220 wide at x=170   390 wide at y=351
//   All / None button  25px tall, 12px     44px tall, 16px
//   region row         23px                44px
//
// 170px of map is not a map, which is the same failure CAQDAS had. The full-width layout
// is unchanged: 980 + 220 side by side at 1200px, 30px buttons, 22px rows.
// ---------------------------------------------------------------------------------------

test('spatial OWNS its layout rather than borrowing it from an optional sheet', () => {
  // Corrected 2026-10-12 after the owner photographed the bug on a phone: the stacked
  // region list sat in half the pane, because `.ct-split` lives in BASE_CSS and BASE_CSS
  // arrives through `app.std?.injectStdlibStyles?.(document)` — an optional chain. When
  // that did not land, `.ct-split` was an unstyled block, the rail kept its 220px desktop
  // width, and the pane looked exactly like the screenshot.
  //
  // Optional is right for a token or a button style, where the loss is cosmetic. It is
  // wrong for LAYOUT. So the pane carries its own `.sp-split`, the way builtin-caqdas
  // carries its own rules — which is why CAQDAS never had this failure. Measured in a
  // browser: with BASE_CSS and without it, small mode is identical (map 430x405, list
  // 430x360, 44px button, 44px row); only the button's appearance degrades at full width.
  assert.match(spatial, /const split = el\('div', \{ class: 'sp-split ct-split' \}\);/);
  assert.match(spatial, /split\.append\(mapPane, listPane\);/);
  assert.match(spatial, /root\.append\(split\);/);
  // body becomes the column that holds the split, so the split is the row that flips.
  assert.match(spatial, /body \{[^}]*display: flex; flex-direction: column; height: 100vh/);
});

test('the stacking rules are in the plugin’s own sheet, not only the stdlib’s', () => {
  // The duplication of .ct-split is deliberate and commented as such. Without these the
  // pane is one failed injection away from the 220px-rail bug again.
  assert.match(spatial, /\.sp-split \{ display: flex; flex: 1; min-height: 0; \}/);
  assert.match(spatial, /\[data-screen="small"\] \.sp-split \{ flex-direction: column; \}/);
  assert.match(spatial, /\[data-screen="small"\] \.sp-split > \* \{ width: auto; flex: none; \}/);
  // A 44px target and the 16px no-zoom font are accessibility, not decoration, so they
  // are stated locally too rather than riding on the optional sheet.
  assert.match(spatial, /\[data-screen="small"\] \.list-header button \{ font-size: 16px; min-height: 44px; \}/);
});

test('spatial says so when the base sheet is missing, instead of just looking wrong', () => {
  // Same reasoning as plugin-host's import-map canary: a silent layout fallback is
  // something a maintainer would otherwise have to reverse-engineer from a photograph.
  assert.match(spatial, /getElementById\('ct-stdlib-styles'\)/);
  assert.match(spatial, /console\.warn\('\[builtin-spatial\] stdlib base sheet absent/);
});

test('spatial takes the host base sheet before layering its own', () => {
  assert.match(spatial, /app\.std\?\.injectStdlibStyles\?\.\(document\)/);
  assert.ok(spatial.indexOf('injectStdlibStyles') < spatial.indexOf('sheet.replaceSync('),
    'host tokens first, plugin rules on top');
});

test('the map keeps room to be a map, and the list is capped so it cannot push it away', () => {
  // .ct-split sets `flex: none` on its children when stacked, so each pane's height has to
  // be stated — the component cannot know which pane is the point of the pane.
  assert.match(spatial, /\[data-screen="small"\] \.map-pane \{[\s\S]{0,320}min-height: 45vh/);
  assert.match(spatial, /\[data-screen="small"\] \.list-pane \{ max-height: 40vh; \}/);
  // The divider has to move with the layout, or it draws between stacked rows.
  assert.match(spatial, /\[data-screen="small"\] \.map-pane \{[\s\S]{0,360}border-right: 0/);
});

test('a region row is a touch target, because selecting regions is what the pane is for', () => {
  assert.match(spatial, /\[data-screen="small"\] \.region-row \{ min-height: 44px/);
  assert.match(spatial, /\[data-screen="small"\] \.region-row input \{ width: 20px; height: 20px; \}/);
});

test('the All / None buttons are the host button, so they inherit the 44px and the 16px', () => {
  // `.ct-btn` is reached by the stdlib's own small-screen rules; the old local `button.sm`
  // (12px in 2px of padding) was not, and its rules are gone rather than left dangling.
  assert.match(spatial, /el\('button', \{ class: 'ct-btn', text: 'All' \}\)/);
  assert.match(spatial, /el\('button', \{ class: 'ct-btn', text: 'None' \}\)/);
  assert.ok(!/button\.sm \{/.test(spatial), 'the superseded .sm rules should be deleted');
});

test('spatial keys off the mode attribute and never measures its own width', () => {
  // The mode is the user's CHOICE. A pane that measured its iframe would override someone
  // who deliberately picked the full layout on a narrow screen.
  assert.ok(!/@media[^{]*width/.test(spatial), 'no width media query belongs in a pane');
  assert.ok(spatial.includes('[data-screen="small"]'));
});

test('the FRAME injects the base sheet, so a plugin cannot lose its theme to a missing call', () => {
  // Moved host-side 2026-10-12. builtin-spatial DID call injectStdlibStyles and the sheet
  // did not arrive — photographed on a phone, reproduced in a harness, root cause never
  // pinned (an opaque-origin pane has no reachable console). Injecting from the frame, off
  // the same `std` that `globalThis.ctStd` is built from, cannot fail in any scenario
  // consistent with the symptom: the symptom REQUIRES std to have imported, because a
  // migrated plugin destructures ctStd at module-evaluation time and the pane rendered.
  assert.match(host, /std\?\.injectStdlibStyles\?\.\(document\)/);
  const inject = host.indexOf('std?.injectStdlibStyles?.(document)');
  const imp = host.indexOf('await importPlugin(');
  assert.ok(inject > 0 && imp > 0 && inject < imp,
    'inject before importPlugin, so a module body sees a styled document');
});

test('injecting twice is harmless, so the plugins that also call it keep working', () => {
  // CAQDAS and Spatial both still call it. The function returns the existing <style>.
  const lib = readFileSync('core/plugin-stdlib.js', 'utf8');
  const fn = lib.slice(lib.indexOf('export function injectStdlibStyles'), lib.indexOf('export function screenMode'));
  assert.ok(fn.includes('const existing = doc.getElementById(ID);'), 'it looks for an existing sheet');
  assert.ok(fn.includes('if (existing) return existing;'), 'and returns it rather than adding a second');
});

// ---------------------------------------------------------------------------------------
// builtin-decisions (2026-10-13) — the third and last pane. It never had the stacking
// problem the TODO attributed to it: it is single-column. Its gap was entirely controls.
//
// Measured against the real stylesheets. Small mode, 390px: button, segmented button,
// select, table input and the row-delete glyph are ALL 44px tall at 16px, and the body
// does not scroll sideways. Full mode, 1200px: 33 / 29 / 23 / 27px at 14px — desktop
// density untouched.
// ---------------------------------------------------------------------------------------

test('decisions sizes every control for a thumb, not just its buttons', () => {
  // The table is where the work happens — you type costs and effects into it — so its
  // inputs matter as much as the buttons do.
  assert.match(decisions, /\[data-screen="small"\] \.ds \{ font-size: 16px; min-height: 0; \}/);
  assert.match(decisions, /\[data-screen="small"\] \.ds__segbtn \{ font-size: 16px; min-height: 44px;/);
  assert.match(decisions, /\[data-screen="small"\] \.ds input \{ font-size: 16px; min-height: 44px; \}/);
  assert.match(decisions, /\[data-screen="small"\] \.ds td input \{ font-size: 16px; min-height: 44px;/);
});

test('the row-delete glyph gets a target, since it sits beside what it would discard', () => {
  assert.match(decisions, /\[data-screen="small"\] \.ds \.del \{ min-width: 44px; min-height: 44px;/);
});

test('decisions states its touch rules locally, not through the optional base sheet', () => {
  // Same lesson builtin-spatial paid for: a touch target and the no-zoom font are
  // accessibility, so they must not ride on an injection that can silently not happen.
  assert.ok(!/injectStdlibStyles/.test(decisions),
    'decisions relies on nothing optional for its control sizing');
  assert.ok(!/@media[^{]*width/.test(decisions), 'the mode is a choice, never a measurement');
});

// ---------------------------------------------------------------------------------------
// The workspace pane's own toolbar (2026-10-13). Reported from an iPhone: the Decisions
// pane's "Restart" was "SUPER tiny". It was 12px text in 3px of padding — about 22px tall,
// the smallest control in the app — and the verb buttons beside it were 13px/25px.
//
// The cause was not a missing rule. The toolbar set `style.cssText`, and an inline style
// outranks every rule in index.html, so the small-screen pass could not reach it however
// it was written. Measured after the fix: 44px/16px for all seven of builtin-spatial's
// verbs AND Restart, and 28px/13px at full width.
// ---------------------------------------------------------------------------------------

test('the workspace verb toolbar is styled by CLASS, never inline', () => {
  // The actual defect. A control styled inline has opted out of the app's layout rules,
  // and nothing downstream can put it back — which is why this is the assertion rather
  // than "a rule exists somewhere".
  assert.ok(!/\.style\.cssText/.test(manager.slice(manager.indexOf('function buildVerbToolbar'))),
    'buildVerbToolbar must not set inline styles');
  assert.match(manager, /bar\.className = 'ws-verb-toolbar';/);
  assert.match(manager, /btn\.className = 'ws-verb';/);
  assert.match(manager, /restart\.className = 'ws-verb ws-verb--restart';/);
});

test('…and those classes are sized for a thumb in small-screen mode', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /\.ws-verb \{[\s\S]{0,200}font-size: 13px/, 'a desktop size exists');
  assert.match(html,
    /\[data-screen="small"\] \.ws-verb \{ font-size: 16px; min-height: 44px;/,
    'and the small-screen size the inline styles used to block');
});

test('Restart stays visually secondary without being too small to hit', () => {
  // It is a recovery action, so it is de-emphasised by COLOUR rather than by being
  // shrunk below a usable target — which is what it was before.
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /\.ws-verb--restart \{ color: #5a6470; \}/);
});
