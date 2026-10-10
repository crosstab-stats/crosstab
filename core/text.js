/**
 * @file text.js
 * Small text transforms that must behave **identically everywhere**.
 *
 * That is the whole charter, and it is narrower than "utilities". A function belongs here
 * when it is applied at many call sites, when every call site wants the same answer, and
 * when a divergent local copy is a defect rather than a variation. Anything that one caller
 * might legitimately want to do differently belongs with that caller instead.
 *
 * ## Why it exists
 *
 * An audit on 2026-10-10 found the two functions below had been written out by hand, over
 * and over, with the copies no longer agreeing:
 *
 * - **Escaping: 16 helpers across 13 files, in 4 different character sets** — `&<>`,
 *   `&<>"`, `&<>"'`, and a quotes-only `attr()`. Two call sites were using a text-only
 *   escaper inside an HTML attribute, which is a bug in both (see {@link escapeHtml}).
 * - **Ellipsis stripping: 9 sites, 2 behaviours.** Three handled a literal `...`; six
 *   handled only the single character `…`, so a menu item written with three dots kept its
 *   dots on some screens and lost them on others.
 *
 * Neither drifted because anyone decided anything. They drifted because writing a
 * three-line helper is faster than finding the one that already exists — which is exactly
 * the failure a shared module prevents, and exactly why the bar for adding to it is "every
 * caller wants the same answer", not "more than one caller needs it".
 *
 * **This is not a sanitiser.** See `sanitize-html.js` for untrusted plugin markup. Escaping
 * turns a string into text that cannot be markup; sanitising takes markup and removes the
 * dangerous parts. Reaching for one when you need the other is its own hazard, which is why
 * they are not in the same file.
 */

/** The five characters, and what they become. Shared so there is one table, not five. */
const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a string so it is text wherever it lands — element content, a double-quoted
 * attribute, or a single-quoted one.
 *
 * **One function, not a text/attribute pair, deliberately.** Several files had both and
 * most had neither, and the two confirmed bugs the audit turned up were both of the same
 * shape: a text-only escaper interpolated into an attribute.
 *
 *   - `core/app.js` put a user-typed WebDAV path into `value="…"` through an escaper that
 *     left `"` alone, so a quote in the path broke the markup.
 *   - `builtin-html-export` put plugin-supplied image `alt` text into an attribute the same
 *     way — and that one writes a file people then share and open.
 *
 * Offering a choice between a safe escaper and a less safe one means the choice gets made
 * at every call site, forever, by whoever is writing that line. Escaping the quotes in
 * element content costs nothing and is invisible in rendered output, so there is no reason
 * to offer the unsafe option at all. (The same argument the project applies elsewhere: a
 * state that only exists to be got wrong should not exist.)
 *
 * `&` is replaced first by virtue of being in the same pass — a two-pass version that
 * escaped `<` before `&` would double-escape its own output.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/**
 * Drop a trailing ellipsis from a label.
 *
 * Menu items are written `Frequencies…` because they open a dialog; a heading, a history
 * row or an exported comment naming that command should not keep the dots, which promise
 * an interaction that is not on offer there.
 *
 * Handles **both** spellings — the single character `…` and three full stops — because
 * both are typed in practice, and the copies that handled only the first were silently
 * leaving `...` on screen. Trailing whitespace goes with it; leading whitespace is the
 * caller's business and is left alone.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function stripEllipsis(s) {
  return String(s ?? '').replace(/\s*(?:…|\.\.\.)\s*$/, '');
}
