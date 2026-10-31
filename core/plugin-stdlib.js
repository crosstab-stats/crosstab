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
  const cleaned = String(s ?? '')
    // C0, DEL + C1, and the two Unicode line separators — which are not line breaks to
    // `split('\n')` but are whitespace to a regex, so they break tokenisers quietly.
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned) || fallback;
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
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
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
.ct-field { font-family: inherit; font-size: 16px; padding: 5px 8px;
  border: 1px solid var(--ct-line); border-radius: var(--ct-radius); }

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
