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

// =============================================================================
// Styling
// =============================================================================

/**
 * The host's design tokens, for a plugin that writes its own CSS.
 *
 * A plugin pane is a separate document in an opaque-origin iframe, so it inherits
 * nothing — not the stylesheet, not the custom properties, not the font stack. Every
 * workspace plugin has therefore hand-matched the host's look with literal hex: CAQDAS
 * carries `#ccd2d8` borders and `6px` radii copied by eye. That is invisible today and
 * visibly stale the moment the host grows a dark or high-contrast theme.
 */
export const TOKENS = {
  accent: '#2572a5',
  line: '#d8dde2',
  panel: '#f7f9fb',
  text: '#1a1a1a',
  muted: '#646e77',
  danger: '#b03030',
  radius: '6px',
  font: '14px system-ui, -apple-system, "Segoe UI", sans-serif',
};

/**
 * A base stylesheet for a plugin pane: the tokens as custom properties, a few primitives,
 * and — the part that cannot be done any other way — **small-screen rules**.
 *
 * ## Why the reflow lives here
 *
 * The host decides the layout mode; it is a USER'S CHOICE, not a viewport width, and a
 * pane keyed to its own iframe width would override someone who deliberately picked the
 * full layout on a narrow screen. The host posts the decision and the frame mirrors it to
 * `data-screen` on its root, so these rules key off exactly the selector the host's own
 * stylesheet uses. A plugin gets reflow by USING these classes rather than by
 * implementing it, which is the whole point of shipping components rather than tokens.
 *
 * ## What is deliberately not here
 *
 * Anything resembling a layout framework. These are the primitives a pane needs to stop
 * being unusable on a phone — a stack that stacks, a row that wraps, controls that meet
 * the 44px touch target and the 16px font that stops iOS zooming on focus. A plugin's
 * actual design remains its own.
 */
export const BASE_CSS = `
:root {
  --ct-accent: ${TOKENS.accent};
  --ct-line: ${TOKENS.line};
  --ct-panel: ${TOKENS.panel};
  --ct-text: ${TOKENS.text};
  --ct-muted: ${TOKENS.muted};
  --ct-danger: ${TOKENS.danger};
  --ct-radius: ${TOKENS.radius};
}
html, body { margin: 0; }
body { font: ${TOKENS.font}; color: var(--ct-text); }

.ct-btn {
  font: inherit; padding: 5px 9px; border: 1px solid var(--ct-line);
  border-radius: var(--ct-radius); background: #fff; color: inherit; cursor: pointer;
}
.ct-btn:hover { background: #eef5fb; }
.ct-btn--primary { background: var(--ct-accent); border-color: var(--ct-accent); color: #fff; }
.ct-btn--danger { color: var(--ct-danger); }
.ct-btn:disabled { opacity: .5; cursor: default; }

.ct-field { font: inherit; padding: 5px 8px; border: 1px solid var(--ct-line); border-radius: var(--ct-radius); }

/* A row of controls. Wraps rather than overflowing: a control you cannot see is a
   control you do not have, and a pane has no horizontal scrollbar to rescue it. */
.ct-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* Panes side by side at full width, stacked when the user is in small-screen mode.
   min-width:0 on the children because a flex item defaults to min-content and a long
   unbroken word would otherwise push the row wider than the pane. */
.ct-split { display: flex; flex: 1; min-height: 0; }
.ct-split > * { min-width: 0; }

[data-screen="small"] .ct-split { flex-direction: column; }
[data-screen="small"] .ct-split > * { width: auto !important; flex: none; }

/* Touch targets and the 16px that stops iOS zooming the viewport on focus — the same
   two rules the host applies to itself in small-screen mode. */
[data-screen="small"] .ct-btn,
[data-screen="small"] .ct-field { font-size: 16px; min-height: 44px; }
[data-screen="small"] button, [data-screen="small"] select,
[data-screen="small"] input, [data-screen="small"] textarea { font-size: 16px; }
`;

/**
 * Put {@link BASE_CSS} into a document, once.
 *
 * Idempotent by id, because a plugin that re-renders its pane should not accumulate
 * stylesheets. Returns the element so a caller can inspect or remove it.
 */
export function injectStdlibStyles(doc = globalThis.document, css = BASE_CSS) {
  const ID = 'ct-stdlib-styles';
  const existing = doc.getElementById(ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = ID;
  style.textContent = css;
  doc.head.append(style);
  return style;
}

/**
 * Which layout the user is in: `'small'` or `'full'`.
 *
 * Read from the attribute the host posted, never measured. Defaults to `'full'` when
 * nothing has been posted — a plugin on an older host gets the layout it has always had,
 * rather than guessing from a width and getting it wrong in the one case that matters.
 */
export function screenMode(doc = globalThis.document) {
  return doc?.documentElement?.getAttribute('data-screen') === 'small' ? 'small' : 'full';
}
