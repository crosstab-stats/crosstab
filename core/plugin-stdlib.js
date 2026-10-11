/**
 * @file plugin-stdlib.js
 * The small functions a plugin would otherwise write out for itself — and the host's
 * own implementation of them, not a copy.
 *
 * ## Why this module exists
 *
 * A plugin runs in a sandboxed, opaque-origin iframe and cannot import from `core/`. So
 * every helper core shares, a plugin has had to re-derive. An audit on 2026-10-10 found
 * our own built-ins proving the cost:
 *
 * - `filenameFor()` **byte-identical in three places** — `core/output-export.js`,
 *   `builtin-docx-export`, `builtin-html-export`.
 * - HTML escaping in **17 spellings across 14 files**, in four different character sets.
 *   `builtin-html-export` had the attribute-unsafe one and was feeding it into `src` and
 *   `alt` of a file people then share.
 * - `el()` in **509 call sites and four signatures**, two of which take the same three
 *   arguments in opposite order — so the same call yields either a div classed `warning`
 *   reading "Careful" or one classed `Careful` reading "warning", with nothing to tell
 *   you which.
 *
 * None of that drifted by decision. It drifted because writing a three-line helper is
 * faster than finding the one that already exists.
 *
 * ## The rule for what goes in
 *
 * **Every caller wants the same answer, and a divergent copy is a defect** — not merely
 * "more than one caller needs it". A plugin that wants to format a number its own way
 * still can; what it should not have to do is guess at how the host says "5,456 rows".
 *
 * Nothing stateful and nothing that touches the host belongs here: that is what the
 * `app.*` service surface is for, and it crosses postMessage for a reason. `sanitizeHtml`
 * stays host-side too — it is the host's defence *against* the plugin, so handing it to
 * the plugin would be pointing the guard the wrong way.
 *
 * ## How it reaches a plugin
 *
 * As source, over the same path the chart stdlib already uses: the host fetches this
 * file's text, posts it with the `load` message, and the frame blob-imports it in its own
 * realm (a blob URL minted in the host's realm is not fetchable from an opaque origin).
 * The namespace is then hung on `app.std`, so every plugin shape gets it — declarative,
 * workspace, codec — with no manifest declaration to adopt.
 *
 * **`app.std` is local and synchronous**, unlike every other `app.*` namespace, which is
 * an async postMessage proxy. That asymmetry is deliberate: these are pure functions, and
 * making a plugin `await` an escaper would be absurd.
 *
 * ## This file has no imports, on purpose
 *
 * It is imported standalone inside the sandbox, where a relative specifier would resolve
 * against a blob URL and fail. So it is self-contained — and it is the host's source of
 * truth rather than a parallel copy: `core/text.js` re-exports from here, which means the
 * host's own ~74 escaping call sites exercise exactly the code the plugins get.
 */

/**
 * Bumped when something here changes in a way a plugin could notice.
 *
 * A plugin can feature-detect (`app.std?.formatRows`) for additions; this is for the
 * cases detection cannot cover, like a changed return shape. Not yet load-bearing — no
 * plugin reads it — but it cannot be added retrospectively to builds already shipped.
 */
export const STDLIB_VERSION = '1.0.0';

// =============================================================================
// Text
// =============================================================================

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
 * most had neither, and both confirmed bugs the audit turned up were the same shape: a
 * text-only escaper interpolated into an attribute. Offering a choice between a safe
 * escaper and a less safe one means the choice gets made at every call site, forever, by
 * whoever is writing that line. Escaping quotes in element content costs nothing and is
 * invisible once rendered, so there is no reason to offer the unsafe option at all.
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/**
 * Drop a trailing ellipsis from a label.
 *
 * Menu items are written `Frequencies…` because they open a dialog; a heading or an
 * exported comment naming that command should not keep the dots, which promise an
 * interaction that is not on offer there. Handles **both** spellings — six of the nine
 * copies this replaced handled only the single character and silently left `...` on
 * screen.
 */
export function stripEllipsis(s) {
  return String(s ?? '').replace(/\s*(?:…|\.\.\.)\s*$/, '');
}

// =============================================================================
// Names
// =============================================================================

/**
 * A filesystem-safe slug: lowercase, runs of anything else collapsed to one dash, no
 * leading or trailing dash, capped so a long title cannot produce an unusable filename.
 */
export function slug(s, { max = 60, fallback = 'crosstab-output' } = {}) {
  const base = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return base || fallback;
}

/** `slug` plus an extension — the exact function three exporters had written out. */
export function filenameFor(title, ext, opts) {
  return `${slug(title, opts)}.${ext}`;
}

// =============================================================================
// Formatting — where the app's "voice" lives
// =============================================================================

/** A number with thousands separators: `5456` reads as `5,456`. */
export function formatNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '';
}

/** `1 row` / `2 rows`, with the count grouped. English plural only — a word whose plural
 * is not "+s" should be passed in full via `plural`. */
export function formatCount(n, one, plural) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `${formatNumber(v)} ${v === 1 ? one : (plural ?? `${one}s`)}`;
}

/**
 * A date a reader can act on: relative while that is the more useful answer, absolute
 * once it stops being.
 *
 * "3 days ago" beats a date when you are looking for what you had open this week; past
 * that, "5 Oct 2026" is the form people actually remember. A timestamp in the future
 * (clock skew between devices is ordinary) renders absolute rather than as negative time.
 */
export function formatWhen(ts, { now = Date.now(), style = 'relative' } = {}) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const abs = () => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (style === 'absolute') return new Date(t).toLocaleString();
  const ms = now - t;
  if (ms < 0) return abs();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return formatCount(mins, 'min') + ' ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return formatCount(hours, 'hour') + ' ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return formatCount(days, 'day') + ' ago';
  return abs();
}

/**
 * Join the parts of a one-line description, dropping the ones that are not known.
 *
 * The separator is the app's, and the omission rule matters as much: a fact the caller
 * does not have is left out rather than rendered as `0` or `unknown`. A project saved
 * before row counts were recorded says less, instead of saying something false.
 */
export function joinMeta(parts) {
  return (parts ?? []).filter((p) => p != null && p !== '').join(' · ');
}

// =============================================================================
// DOM
// =============================================================================

/**
 * Create an element.
 *
 * **Options object, not positional arguments**, and that is the whole point. The helper
 * this replaces existed in four incompatible signatures across 509 call sites — two of
 * them taking the same three arguments in opposite order, so a line copied from one file
 * to another silently swapped an element's class with its text. Both render. One is
 * nonsense. Nothing errors.
 *
 * `el('div', { class: 'warn', text: 'Careful' })` cannot be ordered wrong, says what it
 * means at the call site, and lets the old positional copies live alongside it while
 * callers migrate — which matters when the failure mode is silent and there are 509 of
 * them.
 *
 * @param {string} tag
 * @param {{class?: string, text?: string, attrs?: object, style?: string,
 *          children?: Array<Node|string>}} [opts]
 */
export function el(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  // `textContent`, never innerHTML: this takes a STRING, so markup in it is content and
  // not markup. A caller that wants structure passes `children`.
  if (opts.text != null) e.textContent = String(opts.text);
  if (opts.style) e.style.cssText = opts.style;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) {
    if (v == null || v === false) continue;
    e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of opts.children ?? []) e.append(c);
  return e;
}
