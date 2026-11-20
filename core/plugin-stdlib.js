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

/**
 * Strip the two things a JavaScript string can hold that the rest of the pipeline cannot.
 *
 * Not a sanitiser in the security sense — it removes nothing for being rude, only for
 * being unrepresentable. Everything else is left exactly as the user or the file gave it,
 * because altering data to make it tidy is how you lose the thing you were asked to keep.
 *
 * **U+0000.** An R character string cannot contain a NUL at all; there is no escape to
 * emit, so `rStr` had nothing it could do and emitted a raw byte that R's parser then
 * rejected. Found 2026-10-17 in an imported column name, where a NUL means the file is
 * damaged or binary. The failure was loud, which is why it was recorded rather than
 * patched — but it was loud in the WRONG PLACE: an R parse error about generated source,
 * minutes later, naming nothing the user recognises.
 *
 * **Lone surrogates.** The worse of the two, and the one nobody had filed. A string
 * holding an unpaired `\uD800` survives `JSON.stringify`, `JSON.parse` and
 * `structuredClone` intact — so it rides through a save, through IndexedDB and across a
 * sync to a peer, looking fine the whole way. Then the first thing that UTF-8 encodes it
 * — writing a file, posting to WebR, any `TextEncoder` — silently replaces it with
 * U+FFFD. Measured, both ways round. That is two peers disagreeing about a value with
 * nothing anywhere reporting a problem, which is the failure mode this project treats as
 * worse than a crash.
 *
 * Control characters other than NUL are deliberately KEPT: they are legal in both UTF-8
 * and an R string, `rStr` already escapes the ones that would break a line, and a tab
 * inside a label is data rather than damage.
 */
export function safeText(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex -- the point is the control character
    .replace(/\u0000/g, '')
    // A surrogate NOT part of a valid pair, from either side.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD');
}

/**
 * A user-typed DISPLAY name, bounded and free of control characters.
 *
 * Not {@link slug}: that makes a filename, lowercasing and dashing everything. This
 * keeps the name a person typed — spaces, capitals, punctuation — and only removes what
 * nothing downstream wants.
 *
 * It exists because a name is not just shown. A project or dataset name becomes an
 * APPENDED OP in the log, which is written on every save and replicated to every
 * collaborator, so an unbounded one is carried forever by every copy of the project.
 * `max` is generous enough that no real name meets it and small enough that a pasted
 * document does not reach the log.
 *
 * Control characters go to spaces rather than being dropped, so words either side of a
 * stray newline do not weld together.
 */
export function cleanName(s, { max = 200, fallback = '' } = {}) {
  // Order matters. The control-character sweep runs FIRST, so a NUL becomes a SPACE like
  // every other control character — `safeText` would delete it outright and weld the
  // words either side together, which is the one thing this function exists to prevent.
  // `safeText` then takes the surrogates, which are not a formatting problem and have no
  // "either side" to protect.
  const cleaned = safeText(String(s ?? '')
    // C0, DEL + C1, and the two Unicode line separators — which are not line breaks to
    // `split('\n')` but are whitespace to a regex, so they break tokenisers quietly.
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned) || fallback;
}

/**
 * Formatting-only invisible characters: the bidi overrides and isolates, the zero-width
 * SPACE, and the byte-order mark. Every one of these changes what a string LOOKS like
 * without changing what it IS, and none of them is ever a letter in any script.
 *
 * Deliberately NOT here: U+200C and U+200D, the zero-width non-joiner and joiner. Those
 * are letters — they are required to spell words correctly in Persian, Hindi and others,
 * and an author whose name needs one would have it quietly deleted. They do enable
 * confusable strings, and that risk is closed on the ID instead (see
 * {@link module:core/loader~qualifyId}, which restricts an id to ASCII), because an id is
 * a machine identifier that can be restricted without damaging anyone's name.
 */
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/g;

/**
 * Clean a string that asserts an IDENTITY — a plugin's name, its author, its category.
 *
 * Distinct from {@link cleanName} by purpose, not by strictness. `cleanName` protects
 * CONTENT the user typed: it turns a control character into a space precisely so that the
 * words either side do not weld together, because the user's text is the thing being
 * preserved. This protects a TRUST DECISION about text somebody else wrote, so the
 * requirement is the opposite — **the stored string must equal what the reader sees.** A
 * zero-width space is therefore DELETED rather than spaced: the reader sees `ab`, so `ab`
 * is what the string has to be, and leaving a boundary nobody can see is the whole defect.
 *
 * Why this matters more than it looks. `qualifyId` namespaces a non-built-in id so that,
 * in its own words, a would-be forgery "reads as exactly what it is:
 * `sdsu-builtin-frequencies`" — an explicit anti-impersonation measure that assumes the
 * string renders as its characters. A single U+202E breaks that assumption, and a plugin
 * name reaches two confirm() prompts in the plugin manager where a newline forges extra
 * lines of dialog text. Neither is reachable once a name equals its rendering.
 *
 * @param {*} s
 * @param {{max?: number, fallback?: string}} [opts]
 * @returns {string}
 */
export function identityText(s, { max = 120, fallback = '' } = {}) {
  // Invisibles first, so the length cap and the whitespace collapse in `cleanName` both
  // see the string the reader will actually see.
  return cleanName(String(s ?? '').replace(INVISIBLE, ''), { max, fallback });
}

/**
 * Who made a record — the display name for the #148 author stamp.
 *
 * Two plugins need this and they must not disagree, because they report on the same
 * people: `builtin-agreement` names the coders it compares, and the CAQDAS quantitiser
 * names the per-coder columns it emits. A coder who is "RB" in one and "Rebecca B" in
 * the other is two coders as far as the reader can tell.
 *
 * It reads BOTH places a stamp can sit. The host puts the creating author on the record
 * envelope (`rec.author`, from the op), while a plugin that stamps its own in-memory
 * objects puts it in the fields (`rec.fields.author`, or directly on the object the
 * workspace is holding). Which one a caller has depends on whether the record came back
 * from `items.list` or is still live in a workspace, and that is not a distinction worth
 * making at every call site.
 *
 * Falls through name → initials → id, because identity is what matters and the display
 * fields are optional: an unnamed author is still a distinct author.
 *
 * @param {object} rec a record, or a plugin's live object
 * @returns {string|null} null when there is no stamp at all — an UNATTRIBUTED record,
 *   which is a real state (imported codings are deliberately unstamped) and not an error.
 */
export function coderName(rec) {
  const a = rec?.author ?? rec?.fields?.author;
  if (!a) return null;
  return String(a.name || a.initials || a.authorId || '').trim() || null;
}

/**
 * A file size as a person reads them: `900 B`, `1.5 KB`, `512 MB`, `5.0 GB`.
 *
 * Two significant figures below ten and none above, because the digit after the point
 * stops meaning anything once the unit is right — "9.4 GB" is useful, "9.43 GB" is noise,
 * and "512.0 MB" is a false claim about precision the estimate never had.
 *
 * Clamped at zero: a negative size is nonsense, and `freeBytes` is derived from
 * `navigator.storage.estimate()`, which can report usage above quota on some engines.
 * "-5 B free" would make the one dialog that has to be trusted look broken.
 */
export function humanBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
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
// Statistical reporting — one convention for numbers that end up in a paper
// =============================================================================

/*
 * These came out of a drift scan of the 60 compute plugins on 2026-10-12. They are here
 * for a sharper reason than the formatters above: the copies had **already diverged in
 * output a reader can see**, and output is what these plugins exist to produce.
 *
 *   fmtP     32 copies,  5 variants, THREE different spellings of the same p-value
 *   rStr     32 copies,  2 variants — and the fix lived in 2 of them
 *   f        38 copies,  4 variants (cosmetic; all four agreed)
 *   metaMap  34 copies,  3 variants, one of them a different signature
 *   labelOf  27 copies,  3 variants, one of them a different signature
 *   ci       18 copies,  3 variants, 3 dp in thirteen and 4 dp in three
 *
 * Nobody decided any of that. Each file got a helper when it was written, and whichever
 * convention its author happened to type became that plugin's house style. The el() sweep
 * never reached here, because none of these plugins draw any DOM.
 */

/**
 * What a results table prints when there is no value: an em dash.
 *
 * Shared by the formatters below so the blank cell is one decision rather than six. Every
 * copy they replace already used this character — the one thing all 32 `fmtP` variants
 * agreed on.
 */
const EMPTY = '\u2014';

/**
 * A p-value as a journal expects it.
 *
 * **Three spellings were in the tree**: `< .001` in thirty plugins, `<.001` in
 * builtin-sced, `< 0.001` in builtin-spatial. The same session could print all three
 * depending on which menu item you ran, and someone pasting two of our tables into one
 * manuscript would be fixing it by hand.
 *
 * The settled form is **three decimals, no leading zero, and `< .001` below the floor**:
 * `.034`, `.500`, `< .001`. Spatial's `< 0.001` and SCED's `<.001` both moved, and so did
 * the leading zero every copy in the tree printed.
 *
 * **Why the zero goes** (owner's call, 2026-10-12 — "good to be consistent"): a p cannot
 * exceed 1, so a digit reserved for the part before the decimal point can only ever be 0
 * or 1 and carries no information. This is APA's rule and SPSS's Sig. column, and it is
 * what the floor case already did — printing `0.034` beside `< .001` was the app
 * disagreeing with itself inside a single column.
 *
 * It reports `< .001` rather than a run of zeros because `0.000` claims a precision the
 * test does not have, and reads as "exactly zero", which no p-value is.
 *
 * **`1.000` keeps its digit**, because that one is not a leading zero. p = 1 is a real
 * result — a χ² of exactly 0, or a two-sided test on a perfectly symmetric split — and
 * `.000` would say the opposite of what happened. So the zero is stripped by looking at
 * the formatted string rather than by assuming the value is below 1.
 */
export function fmtP(p) {
  if (!Number.isFinite(p)) return EMPTY;
  if (p < 0.001) return '< .001';
  return dropLeadingZero(p.toFixed(3));
}

/** The same value mid-sentence: `p < .001` / `p = .034`, for a results note rather than a
 * table cell. Was already identical in builtin-causal, builtin-mediation, builtin-meta. */
export function fmtPInline(p) {
  if (!Number.isFinite(p)) return `p = ${EMPTY}`;
  return p < 0.001 ? 'p < .001' : `p = ${fmtP(p)}`;
}

/**
 * `0.034` -> `.034`, for a quantity that cannot exceed 1.
 *
 * Operates on the formatted STRING, so `1.000` is left alone — only a literal leading
 * `0` before the point goes. `-0.250` would pass through untouched, though `fmtP` never
 * gets that far: a negative trips its `< .001` floor first, as it did in all 32 copies.
 */
function dropLeadingZero(s) {
  return s.startsWith('0.') ? s.slice(1) : s;
}

/**
 * A number to a fixed number of decimals, or the em dash when there is nothing to show.
 *
 * Bound as `f` at most call sites — these dense table-building plugins read better with a
 * one-letter formatter, and renaming 38 plugins' worth of call sites would be a large
 * diff for no behavioural gain. The alias is local; the implementation is this one.
 *
 * **Not finite is a first-class answer here.** R hands back `NaN` for a statistic it could
 * not compute and `null` for one it never reached, and a results table still has to print
 * something; `0` and `NaN` would both read as findings.
 */
export function fixed(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : EMPTY;
}

/** A count: rounded, no decimals, no thousands separator — degrees of freedom and cell
 * counts sit inside statistical tables, where `1,024` is read as a decimal in much of the
 * world. `formatNumber` is the one for counts in prose. Bound as `int` at call sites. */
export function rounded(x) {
  return Number.isFinite(x) ? String(Math.round(x)) : EMPTY;
}

/**
 * A confidence interval as one cell: `[-0.214, 1.038]`.
 *
 * `d` defaults to 3 because that is what thirteen of the eighteen copies used. The three
 * that used 4 (margins, meta, trend) were not wrong — a marginal effect or a trend slope
 * can be small enough that 3 dp prints `[0.000, 0.001]` — so the precision stays the
 * caller's choice rather than being flattened to a majority vote.
 */
export function ci(lo, hi, d = 3) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(d)}, ${hi.toFixed(d)}]` : EMPTY;
}

/**
 * How a variable is named to the reader: `Household income (hhinc)`.
 *
 * Both halves earn their place — the label is what the analyst understands, the column
 * name is what they will look for in the data editor and in the exported script. A
 * variable with no label is just its name, never `undefined (hhinc)`.
 *
 * `qualify: false` gives the bare label, for somewhere the column name would be noise:
 * builtin-var uses it for plot series names, where `Label (col)` in a legend is clutter.
 * That copy was a real distinction, not drift, and survives as an option.
 *
 * **Takes the resolved meta ENTRY, not the map** — `labelOf(metaMap(meta).get(name), name)`.
 * builtin-mixture's copy took the map and resolved internally, which is the same
 * mirror-image hazard `el()` had: pass the wrong one of the two and you silently get the
 * bare column name, because `undefined?.label` is falsy and the fallback is `name`.
 */
export function labelOf(meta, name, { qualify = true } = {}) {
  if (!meta?.label) return name;
  return qualify ? `${meta.label} (${name})` : String(meta.label);
}

/** Variable metadata as a Map keyed by column name, which is how every caller wants it —
 * `app.data.getVariableMeta()` hands back an array. Tolerates a missing list rather than
 * throwing, since a plugin can be invoked before any dataset is open. */
export function metaMap(meta) {
  return new Map((meta ?? []).map((m) => [m.name, m]));
}

/**
 * A JavaScript string as an R string literal, quotes included.
 *
 * Every R-generating plugin needs this, because a variable name or a value label is the
 * user's own text and goes straight into code we then evaluate. Thirty copies escaped the
 * backslash and the double quote. **Two — builtin-mediation and builtin-sem — also
 * escaped the newline, and they were the right ones**: a raw newline inside the literal is
 * legal R but splits the generated line, which breaks anything that reads that code a line
 * at a time. The captured R we persist for audit is exactly that, and so is the
 * `# df <- …` comment prelude, where a newline in a column name would push the rest of
 * the comment onto a live code line. The carriage return goes the same way, since a label
 * pasted from Windows-authored data carries one.
 *
 * So the superset wins. This is the one helper here whose variants were not a matter of
 * taste: twenty-eight plugins were missing a fix that two had already made locally.
 */
export function rStr(s) {
  // `safeText` FIRST, because the rest of this function is escaping — and a NUL has no
  // escape. R cannot hold one, so emitting it produced source R's own parser rejected:
  // loud, but minutes downstream and naming generated code rather than the column it
  // came from. There is no faithful encoding to choose between here; the only options
  // were "drop it" and "emit a file R cannot read".
  return `"${safeText(String(s)).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

// =============================================================================
// Reading an R result — where a missing statistic must stay missing
// =============================================================================

/*
 * `flat()` / `normalizeResult()` existed in 45 plugins, and the copies disagreed about
 * both WHAT THEY RETURN and WHAT A MISSING VALUE IS. Three defects, found 2026-10-12:
 *
 * 1. **`num` meant two different types.** A numeric SCALAR in 28 plugins, a numeric
 *    VECTOR in 10. Same spelling, opposite type — the `el()` mirror image again, except
 *    here it is the data path, so the failure is a wrong number rather than a wrong style.
 *    `str` was overloaded too: a vector in builtin-agreement, a scalar in builtin-epi.
 *
 * 2. **12 copies turned a missing number into `0`.** WebR's `toJs()` renders R's `NA` and
 *    `NaN` alike as JS `null`, and `[null].map(Number)` is `[0]`. So a statistic R could
 *    not compute printed as `0.000` — a finding — instead of the em dash that means "not
 *    computed". Confirmed in the live app: a regression with a perfectly collinear
 *    predictor printed **`VIF 0.00`**, which is impossible, since a VIF is never below 1.
 *
 * 3. **20 copies turned a missing string into the literal text `"null"`**, because
 *    `String(null)` is `'null'`. A row label read `null` rather than being blank.
 *
 * `Inf` and `-Inf` are NOT affected: they survive `toJs()` as JS infinities and are
 * already non-finite, so they reach the em dash on their own. (They look like `null` if
 * you inspect a result with `JSON.stringify`, which is a trap in the console, not a bug.)
 */

/**
 * Turn a WebR result into named accessors.
 *
 * Bound as `flat` at most call sites, which is what the 45 local copies were called; the
 * implementation is this one.
 *
 * ## The names
 *
 * | accessor | returns | missing becomes |
 * |---|---|---|
 * | `nums(k)` | `number[]` | `NaN` per element |
 * | `num1(k)` | `number` | `NaN` |
 * | `strs(k)` | `string[]` | `''` per element |
 * | `str1(k)` | `string` | `''` (or `opts.missing`) |
 *
 * **Plural is a vector, `1` is a scalar, and `num`/`str` deliberately do not exist.**
 * Retiring the two overloaded names is the point: a line copied from a plugin that
 * predates this throws `r.num is not a function` immediately, rather than silently
 * handing back a scalar where a vector was expected. A migration whose misses are loud
 * is worth more than one whose names look familiar.
 *
 * `missing` on `str1` is for builtin-epi, whose `lv()` renders an absent factor attribute
 * as `?` and therefore needs to tell absent from empty.
 *
 * @param {any} result - `app.webr.run()`'s `result`: `{names, values}`, or a plain object.
 */
export function unpackR(result) {
  const byName = {};
  if (result && Array.isArray(result.names) && Array.isArray(result.values)) {
    result.names.forEach((n, i) => { byName[n] = result.values[i]; });
  } else {
    Object.assign(byName, result ?? {});
  }
  // An R vector arrives as `{type, values}`; a bare scalar may arrive unwrapped, and a
  // one-element vector is indistinguishable from a scalar in R anyway.
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const one = (k) => {
    const a = arr(byName[k]);
    return a.length ? a[0] : null;
  };
  return {
    /** Does the result carry this name at all? Distinct from carrying it as NA. */
    has: (k) => Object.prototype.hasOwnProperty.call(byName, k),
    /** The underlying value, for a caller shaping fields of its own. */
    raw: (k) => byName[k],
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? '' : String(x))),
    num1: (k) => {
      const v = one(k);
      return v == null ? NaN : Number(v);
    },
    str1: (k, { missing = '' } = {}) => {
      const v = one(k);
      return v == null ? missing : String(v);
    },
  };
}

// =============================================================================
// R output — the two shapes every analysis plugin reshapes by hand
// =============================================================================

/**
 * An R plot as an SVG that will scale.
 *
 * `svglite` writes a fixed `width`/`height` on the root element, so the plot arrives at
 * whatever size R thought it was and ignores the column it is dropped into. Stripping
 * both leaves the `viewBox`, which is what makes it responsive.
 *
 * Eight plugins carried this, in two spellings that differed only in where the line
 * breaks fell. Nothing had drifted — it is lifted because the next plot-producing plugin
 * should not have to know the trick.
 */
export function cleanSvg(svg) {
  return String(svg)
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}

/**
 * An R model term, as a reader should see it: `factor(region)South` becomes
 * `region = South`, and stray backticks (R's quoting for a name with a space) go.
 *
 * Eleven plugins had this byte-identical. **builtin-anova deliberately keeps its own**,
 * which is a superset: it renders `Residuals` as `Residual` and splits an interaction on
 * `:` so each half is prettified. That is a real difference, not drift — folding it in
 * here would change how the other eleven print an interaction term, which is a decision
 * about output rather than a tidy-up.
 */
export function prettyTerm(term) {
  const m = /^factor\(`?(.+?)`?\)(.*)$/.exec(term);
  return m ? `${m[1]}${m[2] ? ` = ${m[2]}` : ''}` : String(term).replace(/`/g, '');
}

/**
 * A factor level as a reader should see it: its value label, or the bare code.
 *
 * Bound as `lvl` at call sites. Six copies in three variants, and this is the SUPERSET,
 * because two of the three were missing fixes the third had — the `rStr` pattern again:
 *
 *  - **`'NA'` is not a level.** R hands back the literal string `NA` for a missing factor
 *    value, and a copy without this guard printed it as though a category called "NA"
 *    existed. builtin-ordinal and builtin-survival were printing it.
 *  - **Value labels are often keyed by NUMBER while R returns a string**, so the lookup
 *    tries `[code]` and then `[Number(code)]`. Without the second, a labelled numeric
 *    factor silently showed its raw codes — which is the one thing this function exists
 *    to prevent.
 *  - An EMPTY label falls back to the code rather than rendering a blank cell.
 */
export function levelLabel(meta, code) {
  if (code == null || code === '' || code === 'NA') return '?';
  const v = meta?.valueLabels?.[code] ?? meta?.valueLabels?.[Number(code)];
  return v != null && v !== '' ? String(v) : String(code);
}

/**
 * A name that is not taken yet: `age`, then `age_2`, `age_3`…
 *
 * Five copies, and they disagreed about things a caller can SEE, so both are options
 * rather than a majority vote:
 *
 *  - **What "taken" is.** An Array, a Set, or an object keyed by name — the three
 *    shapes the callers actually had. Accepting all three is why this could replace them
 *    without rewriting their call sites.
 *  - **Where the numbering starts.** builtin-aggregate counts from `_1`, everyone else
 *    from `_2`. That is visible in a generated column name and in a round-trip, so it is
 *    `start` rather than something to flatten.
 *  - `fallback` names an empty base (builtin-wikipedia's scraped columns can be unnamed).
 */
export function uniqueName(base, taken, { start = 2, fallback = '' } = {}) {
  const has = taken instanceof Set ? (n) => taken.has(n)
    : Array.isArray(taken) ? (n) => taken.includes(n)
      : (n) => Object.prototype.hasOwnProperty.call(taken ?? {}, n);
  const name = String(base ?? '') || fallback;
  if (!has(name)) return name;
  let i = start;
  while (has(`${name}_${i}`)) i += 1;
  return `${name}_${i}`;
}

/**
 * A number for a label whose magnitude cannot be predicted: three decimals in the
 * ordinary range, four significant figures once that would be meaningless.
 *
 * The case it exists for is an annotation drawn ON a chart — a fitted slope, an intercept
 * — where the value comes from the data rather than from a scale the chart chose. At
 * 1.2e-7, `toFixed(3)` prints `0.000`; at 4.5e6 it prints a wall of digits. Either way the
 * one number on screen is the one you cannot read.
 *
 * Two copies: `fitNum` in builtin-plots and an inline `coef` in builtin-charts. Identical
 * rule, and only the first guarded a non-finite input — so a coefficient R could not
 * compute was drawn on the chart as the text `NaN`. The guarded form wins, which is the
 * same call made for `fixed` and `levelLabel`.
 */
export function fitNumber(v) {
  if (!Number.isFinite(v)) return EMPTY;
  return Math.abs(v) >= 10000 || (v !== 0 && Math.abs(v) < 0.001)
    ? v.toPrecision(4)
    : v.toFixed(3);
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
  // A quieter rule than `line`, for dividers INSIDE a panel rather than its edges. Added
  // when CAQDAS was migrated (2026-10-10): it had been drawing control borders and list
  // dividers in two different greys, and flattening them to one token would have thrown
  // away a real distinction to make the migration tidier.
  lineSoft: '#e6eaee',
  panel: '#f7f9fb',
  // The colour a pane's content sits ON. Separate from `panel` because they diverge the
  // moment there is a dark theme — and a plugin writing `#fff` is writing the one value
  // that cannot survive one.
  surface: '#ffffff',
  // Text ON an accent-filled surface. The primary button had this as a literal `#fff`,
  // which is the same mistake as `surface` below it and fails in the same way: invert the
  // theme and white-on-accent may be exactly the wrong contrast.
  onAccent: '#ffffff',
  // A wash of the accent, for a hover or a selected row. Named because "the pale blue we
  // use behind a hovered button" was a value repeated in four files, each free to drift,
  // and because a theme has to be able to move it with the accent it belongs to.
  accentWash: '#eef5fb',
  text: '#1a1a1a',
  muted: '#646e77',
  danger: '#b03030',
  // A state is a SET, not a shade. The host had amber chips, red chips and blue chips
  // each spelling out their own background, border and text — nineteen literals for four
  // ideas, and no way for a theme to move one without hunting all three parts of it.
  dangerBg: '#fdf3f2',
  dangerLine: '#f0d8d5',
  warn: '#8a5a00',
  warnBg: '#fdf0d5',
  warnLine: '#f0c674',
  ok: '#2e7d32',
  okBg: '#eaf6ea',
  okLine: '#bcd9bd',
  // The wash under a hovered row, distinct from `accentWash` (which marks a SELECTED or
  // active thing). They were one value in some places and two in others.
  hover: '#f0f3f6',
  // Text that is quieter than `text` but not as quiet as `muted` — a secondary label
  // rather than a hint. The host had six greys in this band.
  textSoft: '#3c4a57',
  // Disabled, and the greys below `muted`: not information, just shape.
  disabled: '#9aa4ae',
  // The application bar: the one surface a plugin never draws, and therefore the one
  // that needs saying out loud rather than being assumed. A dark ground, its foreground,
  // a recessed strip within it, and the link colour that stays legible on all of them —
  // four hexes that were loose in index.html and are a surface when taken together.
  bar: '#2c3e50',
  barFg: '#ecf0f1',
  barSunken: '#1f3243',
  barLink: '#9fd0f0',
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
  --ct-line-soft: ${TOKENS.lineSoft};
  --ct-panel: ${TOKENS.panel};
  --ct-surface: ${TOKENS.surface};
  --ct-on-accent: ${TOKENS.onAccent};
  --ct-accent-wash: ${TOKENS.accentWash};
  --ct-text: ${TOKENS.text};
  --ct-muted: ${TOKENS.muted};
  --ct-danger: ${TOKENS.danger};
  --ct-danger-bg: ${TOKENS.dangerBg};
  --ct-danger-line: ${TOKENS.dangerLine};
  --ct-warn: ${TOKENS.warn};
  --ct-warn-bg: ${TOKENS.warnBg};
  --ct-warn-line: ${TOKENS.warnLine};
  --ct-ok: ${TOKENS.ok};
  --ct-ok-bg: ${TOKENS.okBg};
  --ct-ok-line: ${TOKENS.okLine};
  --ct-hover: ${TOKENS.hover};
  --ct-text-soft: ${TOKENS.textSoft};
  --ct-disabled: ${TOKENS.disabled};
  --ct-bar: ${TOKENS.bar};
  --ct-bar-fg: ${TOKENS.barFg};
  --ct-bar-sunken: ${TOKENS.barSunken};
  --ct-bar-link: ${TOKENS.barLink};
  --ct-radius: ${TOKENS.radius};
}
html, body { margin: 0; }
body { font: ${TOKENS.font}; color: var(--ct-text); }

.ct-btn {
  font: inherit; padding: 5px 9px; border: 1px solid var(--ct-line);
  border-radius: var(--ct-radius); background: var(--ct-surface); color: inherit; cursor: pointer;
}
.ct-btn:hover { background: var(--ct-accent-wash); }
.ct-btn--primary { background: var(--ct-accent); border-color: var(--ct-accent); color: var(--ct-on-accent); }
.ct-btn--danger { color: var(--ct-danger); }
.ct-btn:disabled { opacity: .5; cursor: default; }

/* NOT the "font" shorthand. "font: inherit" resets font-SIZE too, and because a class
   selector outranks the bare "input, select, textarea" floor below, every field built
   from this class dropped back to 14px and would still zoom iOS on focus — the
   standard's own control defeating the standard's own rule. Measured: bare input
   16px, .ct-field input 14px. */
/* A FIELD IS THE DEFAULT, not an opt-in.
   ========================================================================
   ".ct-field" was a class a plugin had to remember to add, and the audit kept finding
   places that had not: the Transcripts selects drew the iOS native pill, four inputs in
   CAQDAS restated these exact declarations under their own names, and each one was a
   separate chance to get it subtly different.
   Styling the ELEMENTS means a pane cannot have an unstyled field by accident. The class
   stays as an explicit marker — useful on a wrapper, and it documents intent — but
   nothing depends on remembering it.
   Checkboxes, radios, ranges and colour wells are excluded: a border and 9px of padding
   around a checkbox is not a tidier checkbox, it is a broken one. */
input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]),
select, textarea,
.ct-field { font-family: inherit; font-size: 16px; padding: 5px 9px;
  border: 1px solid var(--ct-line); border-radius: var(--ct-radius);
  /* BACKGROUND AND COLOUR, stated rather than left to the platform.
     A bordered <select> with no background keeps its NATIVE fill on iOS — a grey rounded
     pill — while the same element in desktop Chrome computes to white. So the standard's
     own field looked correct on every machine a developer tests on and wrong on the
     device the app is used on, sitting beside a plugin's hand-rolled select that DID set
     a background and therefore looked right.
     No measurement here could have caught it: Chrome reports rgb(255,255,255) for both.
     The general rule it teaches: a control the standard claims to style must state every
     property the platform would otherwise decide for it. */
  background: var(--ct-surface); color: var(--ct-text); }

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

/* 16px STOPS iOS ZOOMING THE VIEWPORT when a control takes focus — and it does that
   whenever the focused control is under 16px, having never heard of our screen mode.
   "data-screen" is a USER'S CHOICE of layout, so keying this to it meant a phone in the
   FULL layout zoomed on every tap into a field. Reported from exactly that, 2026-10-30.
   A floor on anything typable or pickable, in every mode. */
button, select, input, textarea { font-size: 16px; }

/* Touch targets follow the POINTER, not the chosen layout: a phone in the full layout is
   still a phone, and "is a finger driving this" is the question actually being asked.
   Measured on the owner's phone before this: every button 31px against a 44px target. */
@media (pointer: coarse) {
  .ct-btn, .ct-field, button, select, input, textarea { min-height: 44px; }
  summary { min-height: 44px; display: flex; align-items: center; }
}

/* Small-screen mode keeps its own touch sizing for anything a pointer query misses
   (a trackpad-driven narrow window the user has deliberately put in small mode). */
[data-screen="small"] .ct-btn,
[data-screen="small"] .ct-field { min-height: 44px; }
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

  // A CONSTRUCTED SHEET FIRST, and this is not an optimisation.
  //
  // Every plugin pane runs under "default-src 'none'; script-src 'unsafe-inline' blob:;
  // connect-src 'none'" — note what is NOT there: a style-src. So style-src falls back to
  // default-src, which is 'none', and a <style> ELEMENT is blocked outright. This
  // function appended one, so the base sheet had never applied inside a workspace pane:
  // no tokens, no .ct-btn, no .ct-field, no touch targets, no no-zoom floor. Everything
  // the standard ships, inert, in the only place it ships to.
  //
  // It was invisible because every pane also sets enough of its own styling to look
  // roughly right, and because `var(--ct-muted)` against an undefined token silently
  // yields an unset property rather than an error. The symptom only surfaced when a pane
  // stopped setting its own font and fell back to serif.
  //
  // adoptedStyleSheets is CSSOM, not markup, and CSP does not police it — which is the
  // same reason builtin-caqdas has always built its OWN sheet this way. The standard
  // simply was not following the rule its clients already knew.
  try {
    const sheet = new doc.defaultView.CSSStyleSheet();
    sheet.replaceSync(css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    // A marker so a second call is a no-op and a pane can ask whether the sheet arrived.
    // It carries no CSS: the constructed sheet above is doing the work.
    const marker = doc.createElement('meta');
    marker.id = ID;
    doc.head.append(marker);
    return marker;
  } catch {
    // No constructed-sheet support (or no defaultView, as in some test documents). Fall
    // back to the element, which works wherever CSP allows it.
    const style = doc.createElement('style');
    style.id = ID;
    style.textContent = css;
    doc.head.append(style);
    return style;
  }
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


// =============================================================================
// Chart models an ANALYSIS builds — the two figures the whole comparison family wants
// =============================================================================
//
// A chart MODEL is the plugin's half of the bargain (#131): the plugin says what the
// figure is OF, the host renders it and hangs the live controls off it. These two
// builders are here rather than in one plugin because the ANOVA, the t-tests, the
// nonparametric tests, ANCOVA and the survey means all want the same two pictures —
// "the group means, with their uncertainty" and "each pair of groups, as a difference
// against zero". Written per plugin they would be the same figure five times, drifting.

/** Above this many subjects, a line each is a smear rather than a figure. */
export const SUBJECT_LINE_LIMIT = 300;

/**
 * Raw observations, bucketed by the cell they belong to.
 *
 * R hands back two flat vectors — every value, and the cell index of every value —
 * rather than a ragged list, because a list of numeric vectors is the one shape that
 * does not survive the bridge cleanly.
 *
 * @param {number[]} values
 * @param {number[]} cellIdx 1-based index into the cell list, as R counts
 * @param {number} nCells
 * @returns {number[][]} one array per cell, aligned to the cell list
 */
export function bucketRaw(values, cellIdx, nCells) {
  const out = Array.from({ length: nCells }, () => []);
  for (let i = 0; i < values.length; i++) {
    const c = cellIdx[i] - 1;
    if (c >= 0 && c < nCells && Number.isFinite(values[i])) out[c].push(values[i]);
  }
  return out;
}

/**
 * The means / profile chart, as a MODEL for the host to render.
 *
 * Categories are the levels of the FIRST factor and each remaining crossing is a series,
 * which is the layout both figures want: as bars it reads as "the means, with their
 * uncertainty"; as lines it reads as the interaction, because non-parallel lines ARE the
 * interaction term in the table above. One model serves both, and the mark is a control
 * on the chart, so a reader who wants the other one does not have to re-run anything.
 *
 * `rawValues` is what makes it adjustable rather than a picture: the host computes SD,
 * SEM or 95% CI from the observations itself, and offers the data-point overlay, so the
 * choice of error bar stays the reader's. The default is the 95% CI, because the question
 * an ANOVA answers is about means, and the SD of individuals is a different question.
 *
 * @param {object} a
 * @param {string[]} a.cells interaction level names, e.g. `['1.1', '2.1']`
 * @param {number[]} a.means cell means, aligned to `cells`
 * @param {?number[][]} a.raw raw observations per cell, aligned to `cells`
 * @param {(factorIndex: number, level: string) => string} a.labelFor display label resolver
 * @param {string} a.title
 * @param {string} a.xTitle
 * @param {string} a.yTitle
 * @param {'bar'|'line'} [a.mark]
 * @returns {object} a chart model for `app.results.appendChart`
 */
export function cellChartModel({
  cells, means, raw = null, labelFor, title, xTitle, yTitle, mark = 'bar',
}) {
  const parts = cells.map((c) => String(c).split('.'));
  const catKeys = [];
  const serKeys = [];
  for (const p of parts) {
    const cat = p[0];
    const ser = p.slice(1).join('.');
    if (!catKeys.includes(cat)) catKeys.push(cat);
    if (!serKeys.includes(ser)) serKeys.push(ser);
  }
  const at = (cat, ser) => parts.findIndex((p) => p[0] === cat && p.slice(1).join('.') === ser);
  const series = serKeys.map((ser) => {
    const idx = catKeys.map((cat) => at(cat, ser));
    return {
      key: ser || 'all',
      // A one-factor call has no series to name, so the measure names itself.
      label: ser ? ser.split('.').map((lvl, j) => labelFor(j + 1, lvl)).join(' × ') : yTitle,
      values: idx.map((i) => (i < 0 ? null : means[i] ?? null)),
      ...(raw ? { rawValues: idx.map((i) => (i < 0 ? [] : raw[i] || [])) } : {}),
    };
  });
  return {
    kind: 'categorical',
    title,
    categories: catKeys.map((k) => ({ key: k, label: labelFor(0, k) })),
    series,
    axes: { x: { title: xTitle }, y: { title: yTitle } },
    view: {
      mark,
      legend: serKeys.length > 1 ? 'right' : 'none',
      ...(raw ? { errorBars: 'ci95' } : {}),
    },
  };
}

/**
 * Pairwise differences as a forest plot — the chart that actually answers "how much
 * more?", which a plot of group means only invites the reader to estimate by eye.
 *
 * The forest kind already draws exactly this (an estimate, its interval, a reference
 * line), so it is reused rather than reinvented; it is given no pooled summary, because
 * these contrasts are not studies to pool.
 *
 * @param {object} a
 * @param {{label: string, diff: number, lo: number, hi: number}[]} a.pairs
 * @param {string} a.title
 * @param {string} a.xTitle
 * @param {string} a.valueHeading
 * @returns {object} a chart model for `app.results.appendChart`
 */
export function pairsForestModel({ pairs, title, xTitle, valueHeading }) {
  return {
    kind: 'forest',
    title,
    refLine: 0, // no difference
    valueHeading,
    axes: { x: { title: xTitle } },
    studies: pairs.map((p, i) => ({
      key: `p${i}`, label: p.label, est: p.diff, lo: p.lo, hi: p.hi,
    })),
  };
}

/**
 * A model's coefficients, as the figure a paper prints beside the table.
 *
 * Every regression in this project ends the same way: a column of terms, an estimate
 * each, and an interval. Eighteen plugins print that table and none drew it, which is
 * the single most repeated missing figure in the whole catalogue — and eighteen
 * hand-rolled forests would be eighteen chances to disagree about the intercept, the
 * reference line and the axis.
 *
 * Three decisions it makes once, for everyone:
 *
 *  - **The intercept is dropped by default.** It is not on the same footing as the
 *    slopes — it is the fitted value at zero on every predictor, often far outside the
 *    data — and leaving it in squashes every term that matters into the middle of the
 *    axis. Pass `keepIntercept` when the model is one where it means something.
 *  - **Ratios get a log axis and a reference at 1.** An odds ratio of 0.5 and one of 2
 *    are the same size of effect in opposite directions, and only a log axis draws them
 *    that way. Differences get a linear axis and a reference at 0.
 *  - **A term with no interval still gets its point.** A missing CI is a gap in the bar,
 *    not a reason to drop the row — the reader is entitled to see that the term was in
 *    the model.
 *
 * @param {object} a
 * @param {string[]} a.terms term labels, already humanised by the caller
 * @param {number[]} a.est point estimates
 * @param {number[]} a.lo lower bounds (may be empty or NaN)
 * @param {number[]} a.hi upper bounds
 * @param {string} a.title
 * @param {string} a.xTitle
 * @param {string} [a.valueHeading] the text column's heading
 * @param {boolean} [a.ratio] the estimates are ratios (OR, HR, IRR, RR)
 * @param {boolean} [a.keepIntercept]
 * @returns {?object} a chart model, or null when nothing is left to draw
 */
export function coefficientForest({
  terms, est, lo = [], hi = [], title, xTitle, valueHeading, ratio = false, keepIntercept = false,
}) {
  const INTERCEPT = /^\(?intercept\)?$|^const(ant)?$/i;
  const rows = (terms || []).map((label, i) => ({
    key: `b${i}`,
    label: String(label),
    est: Number(est?.[i]),
    lo: Number(lo?.[i]),
    hi: Number(hi?.[i]),
  })).filter((rw) => Number.isFinite(rw.est) && (keepIntercept || !INTERCEPT.test(rw.label.trim())));
  if (!rows.length) return null;
  return {
    kind: 'forest',
    title,
    refLine: ratio ? 1 : 0,
    valueHeading: valueHeading || (ratio ? 'Ratio [95% CI]' : 'Estimate [95% CI]'),
    axes: { x: { title: xTitle } },
    studies: rows,
    ...(ratio ? { view: { logScale: true } } : {}),
  };
}

/**
 * A column-major flat vector (R's `unlist` of a k-column frame) back into k columns.
 *
 * @param {number[]} flat
 * @param {number} n rows
 * @param {number} k columns
 * @returns {number[][]} k arrays of n
 */
export function unflattenColumns(flat, n, k) {
  if (!(n > 0) || !(k > 0) || flat.length < n * k) return [];
  return Array.from({ length: k }, (_, c) => flat.slice(c * n, c * n + n));
}

/** k condition-columns → one row per subject, in condition order. */
export function subjectRows(cols) {
  const n = cols[0]?.length ?? 0;
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

/**
 * Should this dataset go to the out-of-core (Parquet) ingest rather than a DuckDB table?
 *
 * One rule, in one place, because two codecs route on it and a routing decision that
 * disagrees with itself sends the same file down different paths depending on which
 * reader opened it. `builtin-readstat-codec` had the only copy and `builtin-csv-codec`
 * had none, so a huge CSV built a table however big it was.
 *
 * ## The threshold is about SIZE, and a width term was tried and rejected
 *
 * A DuckDB table charges per column as well as per value, so it was tempting to route
 * anything very wide — a 3,300-column College Scorecard extract is only 21 million
 * values, under this threshold, and it is what an iPhone died on. Measured on desktop
 * with that shape, the two paths came out at 7.3s/178 MiB of JS heap (parquet) against
 * 8.7s/121 MiB (table): the out-of-core path cost MORE, because it accumulates a whole
 * row group in JS before writing it. Routing on width would have been a guess that made
 * the constrained case worse, so it is not here. If the width cost is ever shown to
 * matter, the number to beat is the one above.
 *
 * @param {number} varCount columns
 * @param {number} rowCount rows, or -1 when the codec cannot know yet
 * @returns {boolean}
 */
// --- typing text columns (one rule, one detector, every codec) ----------------
//
// This used to live inside builtin-csv-codec, and builtin-excel-codec carried a comment
// saying its typing "mirrors the CSV codec" — which is exactly why fixing CSV's
// mistyping left Excel with all of it. Measured on the same 3,379-column file: CSV now
// types 3,360 columns numeric, Excel types 211.
//
// Typing text is a property of TABULAR DATA, not of a file format. A codec's job is
// bytes → values; deciding what those values ARE belongs here, so there is one rule and
// one place to fix.

/** Distinct non-numeric values tracked per column before giving up on it.
 *
 * The memory bound, and the reason the detector is affordable at all: an `INSTNM` column
 * has 6,272 distinct blocking values, and holding those for 3,379 columns is the very
 * thing a wide import already dies of. A column that blows the cap is genuinely text and
 * stops being tracked, so the cost is at most four short strings per numeric-looking
 * column. A missing-value code recurs by definition — a column needing five DIFFERENT
 * ones to become numeric is not a numeric column. */
const MAX_CODES_PER_COLUMN = 4;

/** Distinct codes offered to the host, so a file of columns full of unrelated junk
 * cannot propose thousands. What does not fit is counted, never silently dropped. */
const MAX_CANDIDATES = 12;

/**
 * Accumulate what is needed to type a table of text values, and to notice the recurring
 * non-numeric values that are really missing-value codes.
 *
 * ## The rule
 *
 * A column is numeric iff every non-empty value either parses as finite or is a code the
 * host accepted as missing — and the column had some value at all. That last clause
 * preserves the old answer for an empty column: a string column, because nothing says it
 * is a number and calling it numeric would turn every blank into NaN.
 *
 * ## Fed by ROW, deliberately
 *
 * One call per row rather than per value. At 21 million cells a per-cell call is 21
 * million calls; per row it is six thousand, and both CSV and Excel already have a row
 * in hand at the point they would ask.
 *
 * ## `numeric` is a parameter, because the formats genuinely disagree
 *
 * In a text format every value is text, so "looks like a number" is the only question
 * there is. A spreadsheet already knows: SheetJS hands back a real JS number for a
 * numeric cell and a string for a text one, and Excel's reader has always required the
 * former. That difference is not pedantry — a ZIP code stored as text ("01234") must
 * stay text, and parsing it would silently drop the leading zero.
 *
 * So the default is the text rule and a caller that knows better passes its own. What is
 * shared is everything above it: the bounded blocker tracking, the two guards, the
 * candidate arithmetic, and what "missing" means.
 *
 * @param {object} [opts]
 * @param {number} [opts.columns] - Width, if known; otherwise taken from the first row.
 * @param {(v: any) => boolean} [opts.numeric] - Does this value count as a number?
 * @returns {{observeRow: (values: any[]) => void, rows: () => number, width: () => number,
 *            proposal: () => object, decide: (accepted: Iterable<string>) => object}}
 */
export function createTypeScan({ columns = 0, numeric = (v) => Number.isFinite(Number(v)) } = {}) {
  /** per column: distinct non-numeric values → count, or null once there were too many */
  let blockers = columns ? Array.from({ length: columns }, () => new Map()) : null;
  let hasNumber = columns ? new Array(columns).fill(false) : null;
  let seen = columns ? new Array(columns).fill(false) : null;
  let width = columns;
  let rowCount = 0;

  const widen = (n) => {
    if (!blockers) { blockers = []; hasNumber = []; seen = []; width = 0; }
    for (let c = width; c < n; c++) { blockers.push(new Map()); hasNumber.push(false); seen.push(false); }
    if (n > width) width = n;
  };

  return {
    observeRow(values) {
      if (!values) return;
      if (values.length > width) widen(values.length);
      rowCount += 1;
      for (let c = 0; c < width && c < values.length; c++) {
        const v = values[c];
        if (v === '' || v === undefined || v === null) continue;
        seen[c] = true;
        if (numeric(v)) { hasNumber[c] = true; continue; }
        const b = blockers[c];
        if (b === null) continue; // given up: too many distinct values to be codes
        const key = String(v);
        const n = b.get(key);
        if (n !== undefined) b.set(key, n + 1);
        else if (b.size < MAX_CODES_PER_COLUMN) b.set(key, 1);
        else blockers[c] = null;
      }
    },

    rows: () => rowCount,

    /** Columns observed, which is not always the header's width: a data row wider than
     * the header widens the scan, and a reader that keeps those extra columns needs to
     * know how many to name. */
    width: () => width,

    /**
     * What to offer the host, and the arithmetic its dialog needs.
     *
     * Two stages, and they are not the same set of columns. Stage 1 decides which VALUES
     * may be offered, and only a column that is numeric apart from its codes gets a say —
     * that is what keeps a three-value text column ("Public" / "Private Nonprofit" / …)
     * from having its values proposed as missing codes. Stage 2 then counts every column
     * those offered codes would recover, INCLUDING columns with no number in them at all,
     * whose values are all codes: 2,652 columns of one Scorecard year are withheld for
     * every institution, and they become numeric-and-entirely-missing once the code is
     * ticked. Counting only stage 1's columns reported 695 where the answer was 3,347.
     *
     * `combos` carries the distinct blocker SETS, because the recovery count is not a sum
     * of per-value counts: a column blocked by both codes is recovered by neither alone.
     */
    proposal() {
      const weight = new Map();
      for (let c = 0; c < width; c++) {
        const b = blockers[c];
        if (!b || b.size === 0 || !hasNumber[c]) continue;
        for (const [v, n] of b) weight.set(v, (weight.get(v) || 0) + n);
      }
      const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]);
      const offered = new Set(ranked.slice(0, MAX_CANDIDATES).map(([v]) => v));

      const byValue = new Map();
      const combos = new Map();
      for (let c = 0; c < width; c++) {
        const b = blockers[c];
        if (!b || b.size === 0) continue;
        const keys = [...b.keys()].sort();
        if (!keys.every((v) => offered.has(v))) continue;
        const sig = JSON.stringify(keys);
        const combo = combos.get(sig);
        if (combo) combo.columns += 1;
        else combos.set(sig, { codes: keys, columns: 1 });
        for (const [v, n] of b) {
          const e = byValue.get(v);
          if (e) { e.values += n; e.columns += 1; } else byValue.set(v, { value: v, values: n, columns: 1 });
        }
      }
      return {
        candidates: [...byValue.values()].sort((a, b) => b.values - a.values),
        combos: [...combos.values()].sort((a, b) => b.columns - a.columns),
        omitted: ranked.length - offered.size,
      };
    },

    /**
     * The verdict, given the codes the host accepted.
     *
     * @param {Iterable<string>} accepted
     * @returns {{isNumeric: boolean[], codes: ?Set<string>, isMissing: (v: any) => boolean}}
     */
    decide(accepted) {
      const codes = new Set(accepted ?? []);
      const isNumeric = [];
      for (let c = 0; c < width; c++) {
        const b = blockers[c];
        isNumeric.push(!!(b && seen[c] && [...b.keys()].every((v) => codes.has(v))));
      }
      const live = codes.size ? codes : null;
      return {
        isNumeric,
        codes: live,
        // An accepted code is missing wherever it appears, including in a column that
        // stayed text: the host was asked whether the value means missing and said yes,
        // and storing it as data in one column while striking it out in the next would
        // be incoherent.
        isMissing: (v) => v === '' || v === undefined || v === null || (live !== null && live.has(String(v))),
      };
    },
  };
}

/**
 * The variable names a table of these raw header cells will import as.
 *
 * ## Why this is its own function
 *
 * Two things have to agree on it, and they run at different times. `ingestTable` applies
 * it during an import; a codec's `catalog()` applies it BEFORE the import, to list the
 * variables for the "choose which to import" picker. If they disagree by one character
 * the user ticks `a_2` and the import offers `a2`, and nothing selected matches anything
 * imported — a silent empty dataset rather than an error.
 *
 * The rule itself is small and entirely conventional: trim; a blank or absent name
 * becomes `V<n>` by its POSITION, not by its rank among the blanks; a repeat gets
 * `_2`, `_3`. The only thing worth stating is that position matters, so a header of
 * `['a', '', 'a']` is `['a', 'V2', 'a_2']` and not `['a', 'V1', 'a_2']`.
 *
 * @param {Array<any>} rawNames - header cells, in order, as the format handed them over
 * @returns {string[]} the names the dataset will have
 */
export function tableVariableNames(rawNames) {
  const used = {};
  const out = [];
  for (let c = 0; c < (rawNames?.length ?? 0); c++) {
    const base = String(rawNames[c] ?? '').trim() || `V${c + 1}`;
    const nm = uniqueName(base, used);
    used[nm] = true;
    out.push(nm);
  }
  return out;
}

/**
 * Import a table of RAW values: the host's typing rule, code detection, naming, width
 * routing and batching, applied once, for every format that does not carry its own types.
 *
 * ## What this exists to delete
 *
 * The codec protocol was asking every plugin to re-implement host policy, and each got a
 * different subset right (2026-11-18 audit): three of five codecs did not route on width,
 * three of five did not detect missing-value codes. That is not an accident of care. A
 * typing rule, what "missing" means, how big a batch should be and when a dataset is too
 * big for a table are properties of TABULAR DATA and of OUR storage — none of them is a
 * property of a file format. The Excel codec's own comment said its typing "mirrored the
 * CSV codec", and that mirroring is exactly why fixing CSV's 3,347-mistyped-column bug
 * (e2a3b77) left Excel typing 211 of the same 3,379 columns differently.
 *
 * So a codec's job is reduced to the part that genuinely differs: **bytes → raw rows.**
 * Everything after that is here.
 *
 * ## Why it lives in the stdlib rather than behind a new protocol verb
 *
 * It has to call the codec's parser twice (see below), and a function cannot cross the
 * postMessage boundary — so a host-side verb would have to invert the whole read loop and
 * stream raw cells back out through the sandbox wall, which is more protocol, not less.
 * This module is host-authored, host-versioned code that runs INSIDE the sandbox; putting
 * it here means ONE implementation that no codec reimplements, which is the actual goal,
 * and the protocol gets smaller instead of larger.
 *
 * ## Why two passes
 *
 * A column's type is not known until its last value has been seen: "numeric iff every
 * non-empty value parses as finite" is what keeps a column with one `N/A` in it a string.
 * The old readers could decide after the fact because they held every cell; a streaming
 * reader cannot, so it reads the source twice rather than weaken the rule. Re-reading a
 * local file is cheap. Holding 21 million JS strings is not.
 *
 * `scanRows` is therefore called twice and MUST produce the same rows both times. It gets
 * `(onRow, ctx)`:
 *   - `onRow(values)` takes one row as an array of raw values, and may return a promise —
 *     await it before parsing the next row. Pass 2 returns one exactly when a batch filled
 *     up, and that await is what keeps a batch at its size. (It is also the bug that was
 *     found the hard way: flushing at CHUNK boundaries instead overran the buffers, and
 *     because a Float64Array silently ignores a write past its end while a plain Array
 *     grows, the numeric and string columns of one batch came out DIFFERENT LENGTHS.)
 *   - `ctx.pass` is 1 or 2, for a codec that can skip work on one of them.
 *   - `ctx.tick()` reports progress; call it per source chunk, not per row.
 *
 * @param {object} app - the plugin's app bridge
 * @param {object} spec
 * @param {(onRow: (values: any[]) => (void|Promise<void>), ctx: {pass: 1|2, tick: () => void})
 *          => Promise<void>} spec.scanRows - the codec's parser, callable twice
 * @param {string[]|'first-row'|((width: number) => string[])} [spec.header] - column
 *   names. `'first-row'` (the default) consumes the first row of each pass as the header;
 *   a function is called after pass 1 with the width the scan observed, for a format whose
 *   columns are only known by then (JSON Lines has no header row at all) or whose data
 *   rows can run wider than its header. A blank or missing name becomes `V<n>` wherever it
 *   came from — that is naming policy, so it is applied here rather than per reader.
 * @param {(v: any) => boolean} [spec.numeric] - does this raw value count as a number?
 *   Defaults to the text rule; a format that hands over real JS values should pass its own
 *   (see {@link createTypeScan}).
 * @param {(v: any) => string} [spec.toText] - how a non-missing value becomes text in a
 *   string column. The default keeps a string as-is and `String()`s anything else; a
 *   spreadsheet passes its own, because `String(date)` is a locale-dependent sentence and
 *   an ISO date is what anyone wants back.
 * @param {number} [spec.rowCount] - if the format knows it without counting.
 * @param {boolean} [spec.dropSingleEmptyRow] - treat a one-value row whose value is `''`
 *   as not a row. The trailing-newline quirk of delimited text; off by default so no other
 *   format inherits it.
 * @param {number} [spec.emitCells] - values per batch. A fixed ROW count is fine at ten
 *   columns and fatal at 3,300 — it is the width that decides what a batch costs. The
 *   default is the 1,000,000 that the delimited, spreadsheet and JSON-lines readers had
 *   each arrived at separately; there is now one of it.
 * @param {?Iterable<string>} [spec.select] - import only these variables (by the name
 *   {@link tableVariableNames} gives them), or null/undefined for all of them. Dropped
 *   columns are never scanned and never buffered, so this is a memory saving and not only
 *   a convenience: picking 50 of the GSS's 7,000 is the case it exists for. Names that do
 *   not match anything in the file are ignored — a recorded import may carry a selection
 *   made against a different revision of it, and failing the whole import over a renamed
 *   column would be worse than importing what is still there.
 * @returns {Promise<{variables: object[], rowCount: number, wide: boolean,
 *                    missingCodes: string[], names: string[]}>} what was handed to
 *   `begin`, plus `names` — every variable the FILE had, selected or not, which a caller
 *   that creates extra datasets from the same source needs.
 */
export async function ingestTable(app, {
  scanRows,
  header = 'first-row',
  numeric,
  toText,
  select = null,
  rowCount = null,
  dropSingleEmptyRow = false,
  // ## Why a million values, measured rather than picked
  //
  // Sized for the platform that is tight, not the one this is developed on. A batch
  // crosses the sandbox boundary by postMessage, and iOS/Safari REFUSES the transfer list
  // across an opaque-origin iframe (#91) — so there every batch is CLONED, and the
  // transient peak is the batch twice over. At a million values that is 8 MiB doubled
  // rather than 16.
  //
  // Measured at 3,300 columns, ingest time and JS heap after: 500k -> 11.1s/92 MiB,
  // 1M -> 10.6s/98 MiB, 2M -> 8.7s/121 MiB. The heap figures are one sample each and move
  // with GC timing, so the choice rests on the clone above rather than on them; what the
  // timings do show is that the cost of a smaller batch lands on WIDE files, where a batch
  // is few rows and the per-column overhead is paid more often.
  //
  // (Moved here from the delimited reader, which is where it was measured. The JSON-lines
  // reader independently capped batches at 10,000 ROWS as well, which at three columns
  // meant 30,000 values — far more conservative than anything the measurement supports.
  // The cap is gone; one value, in one place, with the reasoning attached to it.)
  emitCells = 1_000_000,
} = {}) {
  const fromFirstRow = header === 'first-row';
  const numericOpt = numeric ? { numeric } : {};
  const asText = toText ?? ((v) => (typeof v === 'string' ? v : String(v)));
  const skip = (values) => dropSingleEmptyRow && values.length === 1 && values[0] === '';

  // --- pass 1: names, row count, and which columns are numeric -------------------
  //
  // The scan is created with the width when the width is known up front, and widened from
  // the rows when it is not. That distinction is not cosmetic: `proposal()` walks every
  // column it knows about, so a scan told the header width ignores the extra cells of a
  // ragged row rather than letting them propose missing codes — which is what the
  // delimited reader has always done.
  let names = Array.isArray(header) ? header.slice() : null;
  let scan = names ? createTypeScan({ columns: names.length, ...numericOpt }) : null;
  if (!scan && !fromFirstRow) scan = createTypeScan({ columns: 0, ...numericOpt });
  let rows = 0;
  let seenHeader = false;

  await scanRows((values) => {
    if (fromFirstRow && !seenHeader) {
      seenHeader = true;
      names = values.slice();
      scan = createTypeScan({ columns: names.length, ...numericOpt });
      return undefined;
    }
    if (skip(values)) return undefined;
    rows += 1;
    scan.observeRow(values);
    return undefined;
  }, { pass: 1, tick: () => app.codec.progress(rows, -1) });
  // NOTE on why pass 1 still scans everything: the selection is by FINAL name, and the
  // final names are not known until the header has been read — which happens inside this
  // pass for a format with a header row. Narrowing the scan would mean a third pass or a
  // second naming path, and what the selection is actually for is not scanning cheaply
  // but not STORING 6,950 columns of a 7,000-column file. The scan holds tallies, not
  // cells, so it is bounded either way.


  // A format whose columns are only known after a full pass gets told how wide the data
  // actually was, so it can keep columns its header row did not mention.
  if (typeof header === 'function') names = header(scan ? scan.width() : 0);
  if (!names || !names.length) throw new Error('import: no columns found');
  const total = rowCount == null ? rows : rowCount;

  // Which recurring non-numeric values mean "missing"? The host decides, and records the
  // answer against the import so a replay re-applies it rather than re-asking.
  const accepted = await askMissingCodes(app, scan);
  const { isNumeric, isMissing } = scan.decide(accepted);

  // --- the schema ---------------------------------------------------------------
  const final = tableVariableNames(names);
  // Which SOURCE column each output column comes from. Without a selection that is the
  // identity; with one it is the gaps, and pass 2 reads source rows, so the mapping has
  // to be kept rather than the names re-matched per row.
  const wanted = select == null ? null : new Set(select);
  const keep = [];
  for (let c = 0; c < final.length; c++) {
    if (wanted === null || wanted.has(final[c])) keep.push(c);
  }
  if (!keep.length) throw new Error('import: none of the selected variables are in this file');

  const variables = [];
  const storageTypes = {};
  const isNum = [];
  for (const c of keep) {
    const nm = final[c];
    const num = !!isNumeric[c];
    isNum.push(num);
    variables.push({ name: nm, type: num ? 'numeric' : 'string', measurementLevel: num ? 'scale' : 'nominal' });
    storageTypes[nm] = num ? 'numeric' : 'string';
  }

  // A dataset too big for a DuckDB table goes to the out-of-core ingest instead — the host
  // writes Parquet and queries that. This is the decision three of five codecs were not
  // making, so a huge NDJSON file built a table however big it was.
  const wide = isWideDataset(variables.length, total);
  // `missingCodes` travels with the schema so the ingest — and anything reading the
  // dataset's provenance later — can say WHY a column is numeric.
  const opts = { rowCount: total, wide, missingCodes: [...accepted] };
  await app.codec.begin(variables, storageTypes, opts);

  // --- pass 2: fill and emit ----------------------------------------------------
  const width = variables.length;
  const perBatch = Math.max(1, Math.min(total || 1, Math.floor(emitCells / Math.max(1, width))));
  // Source positions, in output order. `keep[c]` for a full import is just `c`.
  const from = keep;
  let buf = newBuffers(width, isNum, perBatch);
  let fill = 0;
  let emitted = 0;
  seenHeader = false;

  const flush = async () => {
    if (!fill) return;
    await app.codec.batch(sliceBuffers(buf, variables, isNum, fill));
    emitted += fill;
    fill = 0;
    buf = newBuffers(width, isNum, perBatch);
  };

  await scanRows((values) => {
    if (fromFirstRow && !seenHeader) { seenHeader = true; return undefined; }
    if (skip(values)) return undefined;
    for (let c = 0; c < width; c++) {
      const at = from[c];
      const v = at < values.length ? values[at] : '';
      // `isMissing` is the scan's, so "which values count as missing" is decided in one
      // place and applied identically by every format — including in a column that stayed
      // text, since the host ticked "NA means missing in this file", not "…in the columns
      // it happened to rescue".
      const missing = isMissing(v);
      if (isNum[c]) buf[c][fill] = missing ? NaN : Number(v);
      // A string column holds strings. Delimited text hands over strings already, so the
      // typeof guard makes this free there; a format that hands over real JS values (a
      // boolean in JSON, a date in a spreadsheet) would otherwise put a non-string into a
      // string column, which the old JSON reader did `String()` for by hand.
      else if (missing) buf[c][fill] = null;
      else buf[c][fill] = asText(v);
    }
    fill += 1;
    return fill >= perBatch ? flush() : undefined;
  }, { pass: 2, tick: () => app.codec.progress(emitted + fill, total) });
  await flush();

  return { variables, rowCount: total, wide, missingCodes: opts.missingCodes, names: final };
}

/**
 * Ask the host which recurring non-numeric values should count as missing.
 *
 * Returns the empty set when the host does not implement the verb — an older host, or a
 * test harness — which reproduces untouched typing byte for byte. The host is asked even
 * when there is nothing to propose, because a REPLAYED import carries the codes accepted
 * the first time and must apply them whether or not this revision of the file still
 * proposes them.
 *
 * @param {object} app
 * @param {{proposal: () => object}} typeScan
 * @returns {Promise<Set<string>>}
 */
export async function askMissingCodes(app, typeScan) {
  if (typeof app.codec?.missingCodes !== 'function') return new Set();
  const answer = await app.codec.missingCodes(typeScan.proposal());
  // Anything the host names is honoured even if it was not offered: a recorded import may
  // legitimately carry codes from a different revision of the file.
  return new Set(Array.isArray(answer) ? answer.filter((v) => typeof v === 'string') : []);
}

/** Column buffers for one batch: Float64Array for numeric, plain array for string. */
function newBuffers(width, isNum, n) {
  const out = new Array(width);
  for (let c = 0; c < width; c++) out[c] = isNum[c] ? new Float64Array(n) : new Array(n);
  return out;
}

/** The filled prefix of each buffer, keyed by variable name. */
function sliceBuffers(buf, variables, isNum, n) {
  const out = {};
  for (let c = 0; c < variables.length; c++) {
    out[variables[c].name] = isNum[c] ? buf[c].subarray(0, n) : buf[c].slice(0, n);
  }
  return out;
}

export function isWideDataset(varCount, rowCount) {
  const cols = Number(varCount) || 0;
  // An unknown row count is assumed substantial: guessing small is the guess that
  // crashes, and the parquet path is only slower, never wrong.
  const rows = rowCount >= 0 ? rowCount : 100000;
  return Math.ceil((cols * rows) / 4_000_000) > 8;
}

/**
 * Rows per Parquet row group for a dataset this wide.
 *
 * The out-of-core writer accumulates a whole row group in JS before writing it, so the
 * group size IS the peak memory of that path — and a flat row count has the same blind
 * spot a flat batch size had: 8,000 rows is 80,000 values at ten columns and 56 million
 * at the 7,000-column GSS this path exists for. The budget is therefore in VALUES, with
 * the old 8,000 kept as the cap so nothing narrow changes.
 *
 * @param {number} varCount columns
 * @returns {number}
 */
export function rowGroupFor(varCount) {
  const cols = Math.max(1, Number(varCount) || 1);
  return Math.max(256, Math.min(8000, Math.floor(4_000_000 / cols)));
}
