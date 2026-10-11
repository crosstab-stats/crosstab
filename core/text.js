/**
 * @file text.js
 * The host's door onto the two text transforms that must behave identically everywhere.
 *
 * ## Why this is a re-export and not an implementation
 *
 * These live in `plugin-stdlib.js`, which is the module shipped as source into the plugin
 * sandbox. Putting the implementation there and re-exporting it here means the host and
 * every plugin run **the same code**, rather than two copies that agree today.
 *
 * That matters more than it sounds. The whole reason the stdlib exists is that copies
 * drift: the audit of 2026-10-10 found HTML escaping in 17 spellings across 14 files and
 * four character sets, with two call sites feeding a text-only escaper into an HTML
 * attribute. Solving that by adding a *seventeenth* copy for plugins to use would have
 * been the joke writing itself. So the stdlib is the source of truth, and the host's own
 * ~74 escaping call sites exercise exactly what the plugins get.
 *
 * Kept as a separate module rather than importing `plugin-stdlib.js` everywhere because
 * the name says what a core caller means: this is text handling, not "the thing plugins
 * are given". If that stops being true — if core wants the formatters or `el()` too —
 * import them from `plugin-stdlib.js` directly rather than widening this shim.
 *
 * **This is not a sanitiser.** See `sanitize-html.js` for untrusted plugin markup.
 * Escaping turns a string into text that cannot be markup; sanitising takes markup and
 * removes the dangerous parts. Reaching for one when you need the other is its own
 * hazard, which is why they are not in the same file.
 */

export { escapeHtml, stripEllipsis } from './plugin-stdlib.js';
