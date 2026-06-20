/**
 * @file sanitize-html.js
 * A conservative allowlist sanitiser for plugin-supplied result fragments.
 *
 * Every plugin — built-in or third-party — runs in a sandboxed iframe and is
 * therefore *untrusted*. The HTML/SVG strings a plugin sends to the results pane
 * cross the postMessage boundary as plain text and are then inserted into the
 * host DOM, so they MUST be sanitised first or a plugin could inject script,
 * event handlers, or navigation into the host page.
 *
 * This is a deliberately small, allowlist-based sanitiser covering the markup
 * analyses actually produce (tables and simple inline SVG plots): unknown
 * elements are unwrapped (their text kept), dangerous elements are dropped
 * entirely, only known-safe attributes survive (no `on*`, no URL-bearing attrs),
 * `style` is value-filtered against URL/escape/expression tricks, and the whole
 * fragment is size-capped against a denial-of-service blob.
 *
 * It is still NOT a fully audited XSS library. For a public release, vendoring
 * **DOMPurify** (and adding a host-page CSP tuned around the WebR/DuckDB CDNs as
 * defence-in-depth) remains the recommended upgrade — see the hardening TODO.
 */

/** Elements we render and keep, lowercased. Anything else is unwrapped. */
const ALLOWED_TAGS = new Set([
  // tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // text / structure
  'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'b', 'i', 'u', 'sub', 'sup', 'small', 'abbr', 'code', 'pre',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption',
  // inline SVG (drawing subset only)
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'title', 'desc',
]);

/** Elements removed wholesale (including their subtree). (`<style>` is handled
 * specially in cleanChildren — svglite plots embed a CSS block — kept only if its
 * content can't fetch/execute.) */
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'textarea', 'button', 'select', 'option',
  'foreignobject', 'use', 'image', 'animate', 'animatetransform', 'animatemotion', 'set',
]);

/** Attributes allowed on any element. SVG presentation attrs included. */
const ALLOWED_ATTRS = new Set([
  // generic
  'class', 'title', 'dir', 'lang',
  // tables
  'colspan', 'rowspan', 'scope', 'headers', 'span',
  // svg geometry / presentation
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'preserveaspectratio',
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'fill-opacity', 'stroke-opacity',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'font-size', 'font-family',
  'gradientunits', 'gradienttransform', 'offset', 'stop-color', 'stop-opacity', 'clip-path',
]);

/** Reject `style` values that can fetch, execute, or smuggle via CSS escapes. The
 * backslash catch kills escape bypasses like `u\72l(` that decode to `url(`. */
const UNSAFE_STYLE = /(url\s*\(|image-set|expression\s*\(|javascript:|@import|behavior\s*:|binding\s*:|\\|<)/i;

/** Hard cap on elements in one fragment — a defence against a plugin sending a
 * pathologically huge/deep blob to hang the parser. Real result fragments are
 * tiny (summarised tables, one plot); this is orders of magnitude above that. */
const MAX_ELEMENTS = 50000;

/**
 * Sanitise an HTML/SVG fragment string, returning safe HTML.
 *
 * @param {string} html - Untrusted fragment from a plugin.
 * @returns {string} Sanitised HTML safe to assign to `innerHTML` in the host.
 */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  if (doc.body.getElementsByTagName('*').length > MAX_ELEMENTS) {
    return '<div class="results-error">[output too large to display]</div>';
  }
  cleanChildren(doc.body);
  return doc.body.innerHTML;
}

/**
 * Recursively clean an element's children in place.
 * @param {Element} parent
 */
function cleanChildren(parent) {
  // Snapshot the list because we mutate during iteration.
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove(); // comments, processing instructions, etc.
      continue;
    }
    const tag = node.localName.toLowerCase();

    if (tag === 'style') {
      // svglite plots embed a <style> block (default fill/stroke for the panel
      // box, axes, etc.); without it, unfilled shapes fall back to solid black.
      // Keep it, but only if the CSS can't fetch or execute — same URL/escape/
      // expression check used for inline styles.
      if (UNSAFE_STYLE.test(node.textContent || '')) node.remove();
      continue; // kept verbatim; its CSS text is not unwrapped
    }
    if (DANGEROUS_TAGS.has(tag)) {
      node.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but not obviously dangerous: keep its text, drop the element.
      cleanChildren(node);
      node.replaceWith(...node.childNodes);
      continue;
    }
    cleanAttributes(node);
    cleanChildren(node);
  }
}

/**
 * Strip every attribute that is not explicitly allowed (and sanitise `style`).
 * @param {Element} el
 */
function cleanAttributes(el) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const ok =
      name === 'style'
        ? !UNSAFE_STYLE.test(attr.value)
        : ALLOWED_ATTRS.has(name) && !name.startsWith('on');
    if (!ok) el.removeAttribute(attr.name);
  }
}
