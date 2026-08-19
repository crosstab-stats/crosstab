/**
 * @file anchors.js
 * **Anchors** — a resolvable reference to a *region* of something the log addresses.
 *
 * ## Why this exists
 *
 * The log gives every *thing* an address: `ds:3`, `ds:3/cell:notes:1000003`,
 * `item:builtin\0segments\0s1`, `analysis:<runId>`. What it never had is an address for
 * a **region within** one of those — a passage inside a cell, a span of a recording, a
 * rectangle on an image. A CAQDAS coding needed one and, lacking it, described its
 * location with two integers and hoped; every edit to the text silently moved it (#166).
 *
 * Core already had the beginning of the answer. A memo anchors by `{kind, target, ref?}`,
 * where `ref` was reserved for "a sub-address the target cannot express" and never used —
 * because the case that motivated it (a spreadsheet cell) turned out to *be* a target. A
 * region within a cell is precisely the case it was reserved for. So this module completes
 * an existing primitive rather than inventing one, and its first client is core's own
 * memos rather than any plugin.
 *
 * ## Content is the truth; position is a cache
 *
 * An anchor records **what it refers to**, not only where it sat. Position selectors are
 * kept as a hint — they make the common case a single string comparison — but they are
 * never authoritative. That is what lets a coding survive its text being edited, and it is
 * indifferent to *how* the text moved: a cell edit, a re-import, a transform, a merge and
 * a History replay all land in the same place.
 *
 * ## Resolution never writes
 *
 * {@link resolveAnchor} is a pure function of `(ref, subject)`. It says where the region
 * is *now* and how confident that is; it repairs nothing. Automatic repair-on-read would
 * turn opening a workspace into an edit — filling History with changes nobody made and, in
 * a shared project, having every peer write its own version of the repair. Callers render
 * the resolution; only a user action writes one back.
 *
 * ## What the host understands, and what it does not
 *
 * The host implements a small set of **standard** selector kinds (below). They are general
 * media/data selectors — the shape the W3C Web Annotation Model settled on — not any
 * plugin's schema, so knowing them does not breach "the host never learns the schema"
 * (#152 D1). A plugin may use a private `kind`: it is stored verbatim, reported
 * `unresolvable`, and never guessed at. What the host must NOT accept is a plugin-supplied
 * resolver, for the same reason it refuses plugin-supplied folds — it could only run while
 * that plugin is activated, so a deactivated plugin's records would become unanswerable.
 */

/** Selector kinds the host can resolve by itself. */
export const STANDARD_SELECTORS = new Set([
  'text-quote',     // {exact, prefix?, suffix?}      — content identity for text
  'text-position',  // {start, end}                   — a cache/hint, never truth
  'time-span',      // {tStart, tEnd}                 — audio/video
  'rect',           // {x, y, w, h} normalised 0..1   — an image region
  'rect-track',     // {keys:[{t,x,y,w,h}]}           — a region over time
  'row-set',        // {rids: []}                     — a set of rows
]);

/** How much context either side of a quote we keep, for disambiguating repeats. */
export const CONTEXT_CHARS = 32;

/** Resolution confidence, worst to best — stated once so callers compare rather than
 * hard-code strings. */
export const CONFIDENCE = ['orphaned', 'unresolvable', 'drifted', 'ambiguous', 'moved', 'exact'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * Normalise one selector, dropping anything malformed rather than throwing — a bad
 * selector should cost that one region its precision, never the whole record. An unknown
 * `kind` is PRESERVED verbatim (a plugin's private selector): discarding it would destroy
 * a reference the host merely cannot read.
 * @param {*} raw
 * @returns {object|null}
 */
export function normalizeSelector(raw) {
  const kind = str(raw?.kind).trim();
  if (!kind) return null;
  switch (kind) {
    case 'text-quote': {
      const exact = str(raw.exact);
      if (!exact) return null;
      const out = { kind, exact };
      if (str(raw.prefix)) out.prefix = str(raw.prefix);
      if (str(raw.suffix)) out.suffix = str(raw.suffix);
      return out;
    }
    case 'text-position': {
      if (!isNum(raw.start) || !isNum(raw.end)) return null;
      const start = Math.max(0, Math.floor(raw.start));
      return { kind, start, end: Math.max(start, Math.floor(raw.end)) };
    }
    case 'time-span': {
      if (!isNum(raw.tStart) || !isNum(raw.tEnd)) return null;
      const tStart = Math.max(0, raw.tStart);
      return { kind, tStart, tEnd: Math.max(tStart, raw.tEnd) };
    }
    case 'rect': {
      if (!isNum(raw.x) || !isNum(raw.y) || !isNum(raw.w) || !isNum(raw.h)) return null;
      return { kind, x: raw.x, y: raw.y, w: raw.w, h: raw.h };
    }
    case 'rect-track': {
      const keys = (Array.isArray(raw.keys) ? raw.keys : [])
        .filter((k) => isNum(k?.t) && isNum(k?.x) && isNum(k?.y) && isNum(k?.w) && isNum(k?.h))
        .map((k) => ({ t: k.t, x: k.x, y: k.y, w: k.w, h: k.h }));
      return keys.length ? { kind, keys } : null;
    }
    case 'row-set': {
      const rids = (Array.isArray(raw.rids) ? raw.rids : []).map(String).filter(Boolean);
      return rids.length ? { kind, rids } : null;
    }
    default:
      // A plugin's own selector kind. Kept whole; never interpreted.
      return { ...raw, kind };
  }
}

/**
 * Normalise an anchor `ref` — the sub-address that goes in a memo/segment anchor.
 *
 * `selectors` is a LIST, most-robust first, because one region is often describable
 * several ways and the robust description is not the fast one. Resolution walks the list.
 * `expects` is an integrity assertion about the target's *content* (an asset id, which is
 * a content hash) — modality-independent, and for media it gives an exact answer where
 * text can only manage a fuzzy one.
 *
 * @param {*} raw
 * @returns {{selectors: object[], expects?: string}|null} null when it selects nothing
 */
export function normalizeRef(raw) {
  if (raw == null) return null;
  const list = Array.isArray(raw.selectors) ? raw.selectors : Array.isArray(raw) ? raw : [raw];
  const selectors = list.map(normalizeSelector).filter(Boolean);
  if (!selectors.length) return null;
  const out = { selectors };
  if (str(raw.expects)) out.expects = str(raw.expects);
  return out;
}

/** The first selector of a kind, or null. */
export function selectorOf(ref, kind) {
  return (ref?.selectors ?? []).find((s) => s.kind === kind) ?? null;
}

/**
 * Build a text anchor ref from a span — the constructor a text annotator wants. Records
 * BOTH a quote (truth) and a position (cache), in that order.
 * @param {string} text  the full content the span sits in
 * @param {number} start @param {number} end
 * @returns {{selectors: object[]}|null}
 */
export function textRef(text, start, end) {
  const s = String(text ?? '');
  const a = Math.max(0, Math.min(s.length, Math.floor(start)));
  const b = Math.max(a, Math.min(s.length, Math.floor(end)));
  if (b <= a) return null;
  return normalizeRef({
    selectors: [
      {
        kind: 'text-quote',
        exact: s.slice(a, b),
        prefix: s.slice(Math.max(0, a - CONTEXT_CHARS), a),
        suffix: s.slice(b, Math.min(s.length, b + CONTEXT_CHARS)),
      },
      { kind: 'text-position', start: a, end: b },
    ],
  });
}

/** Build a media anchor ref: a selector plus the content hash it was drawn against. */
export function mediaRef(selector, assetId) {
  return normalizeRef({ selectors: [selector], expects: assetId });
}

// --- resolution --------------------------------------------------------------

/** Every index at which `needle` occurs in `hay`. */
function occurrences(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/** Whichever candidate sits closest to the cached hint. */
const nearest = (positions, hint) =>
  positions.reduce((best, p) => (Math.abs(p - hint) < Math.abs(best - hint) ? p : best), positions[0]);

/** How much of the original quote must still be found for a fuzzy match to be offered
 * at all. Below this we report `orphaned` rather than point somewhere plausible. */
const MIN_FUZZY = 0.6;

/** The longest leading run of `exact` that still occurs in `text`. */
function longestPrefix(text, exact, minLen) {
  for (let n = exact.length - 1; n >= minLen; n--) {
    const i = text.indexOf(exact.slice(0, n));
    if (i !== -1) return { at: i, len: n };
  }
  return null;
}

/** The longest trailing run of `exact` that still occurs in `text`. */
function longestSuffix(text, exact, minLen) {
  for (let n = exact.length - 1; n >= minLen; n--) {
    const i = text.indexOf(exact.slice(exact.length - n));
    if (i !== -1) return { at: i, len: n };
  }
  return null;
}

/**
 * Fuzzy fallback: the quoted text ITSELF was edited, so the exact string is gone.
 *
 * Bracket from both ends rather than shrinking from one. An edit *inside* a coded
 * passage — the ordinary case, someone fixing a typo mid-sentence — leaves the passage's
 * head and tail intact but destroys every substring spanning the change, so a one-ended
 * trim finds nothing while the head and tail together still identify the region
 * precisely. Matching both and spanning between them also recovers the *new* extent, so
 * a passage that grew keeps covering what it covered.
 *
 * A single end is still accepted when it alone carries most of the quote (an edit at one
 * edge). Anything below {@link MIN_FUZZY} of the original is reported `orphaned` rather
 * than guessed at — a wrong highlight is worse than an honest "I lost this".
 */
function fuzzyFind(text, exact) {
  const minTotal = Math.ceil(exact.length * MIN_FUZZY);
  const minPart = Math.max(4, Math.ceil(exact.length * 0.2));
  const head = longestPrefix(text, exact, minPart);
  const tail = longestSuffix(text, exact, minPart);

  // Edit in the middle: head … tail still bracket the region.
  if (head && tail) {
    const end = tail.at + tail.len;
    if (end > head.at && head.len + tail.len >= minTotal) return { start: head.at, end };
  }
  // Edit at one edge: whichever side survived, if it carries enough of the quote.
  if (head && head.len >= minTotal) return { start: head.at, end: head.at + head.len };
  if (tail && tail.len >= minTotal) return { start: tail.at, end: tail.at + tail.len };
  return null;
}

/**
 * Resolve an anchor ref against the thing it points at.
 *
 * @param {object} ref  a ref (raw or normalised — it is normalised here)
 * @param {{kind:'text', text:string}
 *        |{kind:'media', assetId?:string, duration?:number}
 *        |{kind:'rows', rids?:string[]}} subject
 * @returns {{status:string, selector:object|null, start?:number, end?:number, reason?:string}}
 *   `status` is one of {@link CONFIDENCE}. `exact`/`moved` are safe to show as-is;
 *   `ambiguous`/`drifted` should be shown AND flagged; `orphaned`/`unresolvable` must keep
 *   the record and its notes and offer the user a way to re-anchor.
 */
export function resolveAnchor(ref, subject) {
  const r = normalizeRef(ref);
  if (!r) return { status: 'unresolvable', selector: null, reason: 'no selectors' };

  // Integrity first, for every modality: if the anchor asserts which content it was drawn
  // against and that is not what is here now, nothing below can be trusted.
  if (r.expects && subject?.assetId && r.expects !== subject.assetId) {
    return { status: 'drifted', selector: r.selectors[0], reason: 'the file behind this document was replaced' };
  }

  if (subject?.kind === 'text') return resolveText(r, String(subject.text ?? ''));

  if (subject?.kind === 'media') {
    const sel = r.selectors.find((s) => s.kind === 'time-span' || s.kind === 'rect' || s.kind === 'rect-track');
    if (!sel) return { status: 'unresolvable', selector: r.selectors[0], reason: 'no media selector' };
    // A span running past the end of the media cannot point at what it was drawn on — a
    // cheap certainty media gets and text does not.
    if (sel.kind === 'time-span' && isNum(subject.duration) && sel.tEnd > subject.duration + 0.5) {
      return { status: 'orphaned', selector: sel, reason: 'coded span runs past the end of this media' };
    }
    // Content-addressed bytes are immutable, so a matching (or unasserted) asset means the
    // region is exactly where it was drawn.
    return { status: 'exact', selector: sel };
  }

  if (subject?.kind === 'rows') {
    const sel = selectorOf(r, 'row-set');
    if (!sel) return { status: 'unresolvable', selector: r.selectors[0], reason: 'no row selector' };
    const have = new Set((subject.rids ?? []).map(String));
    const found = sel.rids.filter((id) => have.has(id));
    if (!found.length) return { status: 'orphaned', selector: sel, reason: 'none of these rows are present' };
    if (found.length < sel.rids.length) {
      return { status: 'drifted', selector: sel, reason: `${sel.rids.length - found.length} row(s) are gone` };
    }
    return { status: 'exact', selector: sel };
  }

  return { status: 'unresolvable', selector: r.selectors[0], reason: 'unknown subject' };
}

/** The text ladder: exact-at-hint → unique → disambiguated → nearest → fuzzy → orphaned. */
function resolveText(ref, text) {
  const quote = selectorOf(ref, 'text-quote');
  const pos = selectorOf(ref, 'text-position');

  // No quote: a bare position is all we have, so it is authoritative by default — but say
  // so, because a position alone cannot detect that it has drifted.
  if (!quote) {
    if (!pos) return { status: 'unresolvable', selector: null, reason: 'no text selector' };
    return pos.end <= text.length
      ? { status: 'ambiguous', selector: pos, start: pos.start, end: pos.end, reason: 'position only — cannot verify' }
      : { status: 'orphaned', selector: pos, reason: 'position is past the end of this text' };
  }

  const { exact } = quote;
  const hint = pos?.start ?? 0;

  // 1. Still exactly where it was.
  if (pos && text.slice(pos.start, pos.start + exact.length) === exact) {
    return { status: 'exact', selector: quote, start: pos.start, end: pos.start + exact.length };
  }

  const hits = occurrences(text, exact);

  // 2. It moved, but there is only one place it can be.
  if (hits.length === 1) {
    return { status: 'moved', selector: quote, start: hits[0], end: hits[0] + exact.length };
  }

  // 3. Repeated text — this is what prefix/suffix are for.
  if (hits.length > 1) {
    const byContext = hits.filter((i) => {
      const okPrefix = !quote.prefix || text.slice(Math.max(0, i - quote.prefix.length), i).endsWith(quote.prefix);
      const okSuffix = !quote.suffix || text.slice(i + exact.length).startsWith(quote.suffix);
      return okPrefix && okSuffix;
    });
    if (byContext.length === 1) {
      return { status: 'moved', selector: quote, start: byContext[0], end: byContext[0] + exact.length };
    }
    const pick = nearest(byContext.length ? byContext : hits, hint);
    return {
      status: 'ambiguous',
      selector: quote,
      start: pick,
      end: pick + exact.length,
      reason: `this passage appears ${hits.length} times — showing the nearest`,
    };
  }

  // 4. The quoted text itself was edited.
  const fuzzy = fuzzyFind(text, exact);
  if (fuzzy) {
    return {
      status: 'drifted',
      selector: quote,
      start: fuzzy.start,
      end: fuzzy.end,
      reason: 'the coded text was edited — the match is approximate',
    };
  }

  // 5. Gone. Keep the record; the caller offers a re-anchor.
  return { status: 'orphaned', selector: quote, reason: 'the coded text is no longer in this document' };
}

/** Does a resolution need the user told? `exact`/`moved` are silent; the rest are not. */
export function needsAttention(res) {
  return !!res && res.status !== 'exact' && res.status !== 'moved';
}
