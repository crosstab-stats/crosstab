/**
 * @file script-export.js
 * Best-effort translator: CrossTab script text → a **Stata `.do`** or **SPSS `.sps`**
 * command file (#176) — the inverse of {@link module:core/stata-import} and
 * {@link module:core/spss-import}.
 *
 * Why this is not the `.ctscript` export: that one is **lossless and re-importable**
 * (it is `serialize()` output, kept verbatim). This one leaves CrossTab entirely, so it
 * is one-way and lossy by nature — a DuckDB expression is not a Stata expression, and
 * CrossTab's analyses are plugin calls with no Stata/SPSS spelling at all.
 *
 * The contract, and the reason the code is shaped the way it is: **clean valid output or
 * an honest comment — never a half-translated guess.** Each statement is either
 * translated in full or emitted verbatim inside a `[CrossTab, not translated: why]`
 * comment. That is why the expression translator is a tokenizer over an explicit
 * whitelist rather than a pile of regex substitutions: an unrecognised function,
 * operator or character makes the whole statement fall back to a comment instead of
 * producing something that parses but means something else. Two traps that rule caught,
 * either of which a regex pass would have shipped silently:
 *   - `round(x, 2)` is "two decimal places" in DuckDB and "to the nearest multiple of 2"
 *     in Stata, so two-argument `round` is refused rather than renamed;
 *   - `"x"` is a *quoted identifier* in SQL and a *string literal* in Stata, so the
 *     tokenizer keeps the two apart instead of passing the quotes through.
 *
 * Scope: every transform, plus the analyses the matching IMPORTER can read back — see
 * {@link ANALYSES} for why that is the boundary. An analysis outside it becomes a comment
 * holding the original line: translating the other fifty plugins needs each to declare its
 * own Stata/SPSS spelling, the same blocker the R-syntax export has.
 *
 * Pure module — no DOM, no app deps. Each entry point returns
 * `{ text, stats: { statements, translated, skipped } }`.
 */

import { parse } from './crosstab-syntax.js';

/** Banners and breadcrumbs our own .do/.sps importers write into a script. See
 * {@link commentThrough} for why an export drops them instead of passing them on. */
const IMPORTER_NOTE = /^(Imported from (Stata|SPSS)|Best-effort: check the translation|[(]label set defined; applied at)/;

/** Thrown when a construct has no clean equivalent. Caught per statement, which then
 * becomes a comment — so one untranslatable line never costs the rest of the file. */
class Unsupported extends Error {}

function bail(why) {
  throw new Unsupported(why);
}

// =============================================================================
// Dialects
// =============================================================================

/**
 * Scalar functions we are willing to translate, with **both** spellings in one row so
 * the two dialects cannot drift apart. `arity: null` means variadic; a function whose
 * target spelling is `null` does not exist in that dialect and bails there.
 *
 * Deliberately absent (they all bail): anything whose meaning shifts between the two
 * languages — `trim` (SPSS trims one side per call), `coalesce`, `mod`, `power`, string
 * concatenation — plus every function not listed at all.
 */
const FUNCS = {
  abs: { stata: 'abs', spss: 'ABS', r: 'abs', arity: [1] },
  sqrt: { stata: 'sqrt', spss: 'SQRT', r: 'sqrt', arity: [1] },
  ln: { stata: 'ln', spss: 'LN', r: 'log', arity: [1] },
  // DuckDB's log() is base-10 (ln() is the natural one), which is why both map here.
  log: { stata: 'log10', spss: 'LG10', r: 'log10', arity: [1] },
  log10: { stata: 'log10', spss: 'LG10', r: 'log10', arity: [1] },
  exp: { stata: 'exp', spss: 'EXP', r: 'exp', arity: [1] },
  round: { stata: 'round', spss: 'RND', r: 'round', arity: [1] },
  floor: { stata: 'floor', spss: null, r: 'floor', arity: [1] },
  ceil: { stata: 'ceil', spss: null, r: 'ceiling', arity: [1] },
  ceiling: { stata: 'ceil', spss: null, r: 'ceiling', arity: [1] },
  // Row-wise in both languages (Stata's min()/max() and SPSS's MIN()/MAX() take a list).
  least: { stata: 'min', spss: 'MIN', r: 'pmin', arity: null },
  greatest: { stata: 'max', spss: 'MAX', r: 'pmax', arity: null },
  upper: { stata: 'upper', spss: 'UPCASE', r: 'toupper', arity: [1] },
  lower: { stata: 'lower', spss: 'LOWER', r: 'tolower', arity: [1] },
  length: { stata: 'strlen', spss: 'LENGTH', r: 'nchar', arity: [1] },
};

const STATA = {
  id: 'stata',
  label: 'Stata',
  /** A comment line. Stata's `*` comment runs to end of line — no escaping needed. */
  comment: (t) => `* ${String(t).replace(/\s+$/, '')}`,
  /** Stata names: ≤32 chars, letters/digits/underscore, not starting with a digit. */
  validName: (n) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(n),
  /** Stata has no escape inside a plain "…" literal, so a string containing a quote
   * needs compound quotes. */
  str: (s) => (s.includes('"') ? '`"' + s + '"\'' : '"' + s + '"'),
  and: '&',
  or: '|',
  not: '!',
  eq: '==',
  ne: '!=',
  isNull: (v) => `missing(${v})`,
  notNull: (v) => `!missing(${v})`,
  inList: (v, args) => `inlist(${v}, ${args.join(', ')})`,
  inRange: (v, lo, hi) => `inrange(${v}, ${lo}, ${hi})`,
  sysmis: '.',
  fn: (f) => FUNCS[f]?.stata ?? null,
};

const SPSS = {
  id: 'spss',
  label: 'SPSS',
  /** An SPSS comment command runs until a period, so an internal terminator would end
   * the comment early and leave the rest to be parsed as a command. Drop the periods
   * that would terminate it (end of text, or before whitespace); keep decimal points. */
  comment: (t) => `* ${String(t).replace(/\.(?=\s|$)/g, '').replace(/\s+$/, '')}.`,
  /** SPSS names: begin with a letter, ≤64 chars, may contain . _ @ # $, no trailing dot. */
  validName: (n) => /^[A-Za-z][A-Za-z0-9_.@#$]{0,63}$/.test(n) && !n.endsWith('.'),
  /** SPSS string literal: single-quoted, internal quote doubled. */
  str: (s) => "'" + s.replace(/'/g, "''") + "'",
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  eq: '=',
  ne: '~=',
  isNull: (v) => `MISSING(${v})`,
  notNull: (v) => `NOT MISSING(${v})`,
  inList: (v, args) => `ANY(${v}, ${args.join(', ')})`,
  inRange: (v, lo, hi) => `RANGE(${v}, ${lo}, ${hi})`,
  sysmis: '$SYSMIS',
  fn: (f) => FUNCS[f]?.spss ?? null,
};

const R = {
  id: 'r',
  label: 'R',
  comment: (t) => `# ${String(t).replace(/\s+$/, '')}`,
  /** R names: letters, digits, . and _, not starting with a digit or `.`+digit. Anything
   * else is still legal if backticked, which `varName` falls back to — unlike SPSS and
   * Stata, R has no name it cannot express, so nothing has to bail here. */
  validName: (n) => /^[A-Za-z.][A-Za-z0-9._]*$/.test(n) && !/^\.[0-9]/.test(n),
  str: (s) => JSON.stringify(String(s)),   // R and JSON agree on double-quoted string escaping
  and: '&',
  or: '|',
  not: '!',
  eq: '==',
  ne: '!=',
  isNull: (v) => `is.na(${v})`,
  notNull: (v) => `!is.na(${v})`,
  inList: (v, args) => `${v} %in% c(${args.join(', ')})`,
  inRange: (v, lo, hi) => `(${v} >= ${lo} & ${v} <= ${hi})`,
  sysmis: 'NA',
  fn: (f) => FUNCS[f]?.r ?? null,
};

// =============================================================================
// Public API
// =============================================================================

/**
 * @param {string} text CrossTab script text (what the Syntax editor holds).
 * @returns {{text:string, stats:{statements:number,translated:number,skipped:number}}}
 */
export function scriptToStata(text) {
  return translate(text, STATA);
}

/**
 * @param {string} text CrossTab script text (what the Syntax editor holds).
 * @returns {{text:string, stats:{statements:number,translated:number,skipped:number}}}
 */
export function scriptToSpss(text) {
  return translate(text, SPSS);
}

/**
 * CrossTab script → a runnable R script.
 *
 * The reason this dialect is worth more than the other two: CrossTab's analyses already
 * RUN in R, so the exported script is not a translation into a language the app does
 * not speak — it is the same engine, written the way a person would write it. The
 * audience is faculty moving a methods course to R who are stuck on the base language:
 * load the data here, run the analysis here, export, and read what the script that
 * produced it looks like (owner, 2026-10-09).
 *
 * @param {string} text CrossTab script text (what the Syntax editor holds).
 * @param {{analyses?: import('./analysis-log.js').AnalysisEntry[]}} [opts] the analysis
 *   log entries behind that text. Optional, and the export is complete without them —
 *   they carry the two things the syntax text cannot: each run's label, and the R it
 *   actually evaluated (see exactBlock).
 */
export function scriptToR(text, opts = {}) {
  return translate(text, R, opts);
}

/** The filename an export should be offered under. */
export function scriptFileName(dialect, base = 'analysis') {
  const ext = dialect === 'spss' ? 'sps' : dialect === 'r' ? 'R' : 'do';
  return `${base}.${ext}`;
}

/**
 * Walk the script one line at a time. The native grammar is one statement per line, so
 * one line in means one statement out (or one comment) — which is what lets a single
 * untranslatable line be commented in place without disturbing anything around it.
 *
 * Each line is re-parsed with the REAL parser rather than a private copy of it, so the
 * export can never disagree with what Run would do.
 */
function translate(text, D, opts = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const body = [];
  const ctx = {
    labelSets: new Set(),
    labelSetByLabels: new Map(),
    needsExecute: false,
    sawFilter: false,
    sawWeight: false,
    sawAnalysis: false,
    sawExact: false,
    sources: sourceIndex(opts.analyses),
  };
  let statements = 0;
  let translated = 0;
  let skipped = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      body.push('');
      continue;
    }
    if (line.startsWith('#')) {
      const c = commentThrough(line, D);
      if (c != null) body.push(c);
      continue;
    }
    statements += 1;
    let res;
    try {
      res = translateStatement(line, D, ctx);
    } catch (err) {
      const why = err instanceof Unsupported ? err.message : `error: ${err.message}`;
      res = notTranslated(line, why, D);
    }
    if (res.ok) translated += 1;
    else skipped += 1;
    for (const l of res.lines) body.push(l);
  }

  // SPSS runs transformations lazily; one EXECUTE at the end makes the file do what it
  // says standing alone, without one after every COMPUTE.
  if (D.id === 'spss' && ctx.needsExecute) {
    if (body[body.length - 1] !== '') body.push('');
    body.push('EXECUTE.');
  }

  // R is the one dialect where the script can stand entirely on its own: it reads the
  // data, builds the frame every later line edits, and loads what the analyses need.
  // SPSS and Stata assume the dataset is already open in the application; a .R file is
  // handed to someone who has only the file.
  if (D.id === 'r') {
    const pre = [
      D.comment('--- 1. Load the data -------------------------------------------------'),
      D.comment('Export your data from CrossTab (File ▸ Export data…) and point this at it.'),
      D.comment('A .sav or .dta needs haven: install.packages("haven"); haven::read_sav(path)'),
      'd <- read.csv("your-data.csv", stringsAsFactors = FALSE)',
      '',
      D.comment('--- 2. Prepare the data ----------------------------------------------'),
    ];
    const first = body.findIndex((l) => l !== '');
    body.splice(first < 0 ? 0 : first, 0, ...pre);
    if (ctx.sawAnalysis) {
      body.push('');
      body.push(D.comment('Every result above prints to the console; assign one to keep it.'));
    }
  }

  const head = [
    `Exported from CrossTab — best-effort ${D.label} translation.`,
    `${translated} of ${statements} statement${statements === 1 ? '' : 's'} translated` +
      (skipped ? `; ${skipped} left as comments — search “not translated”.` : '.'),
    D.id === 'r'
      ? 'Edit the read.csv() path at the top, then run the file top to bottom.'
      : 'The data is NOT in this file: open your dataset first, then run this.',
  ];
  if (skipped) head.push('Read every commented line: those steps have NOT been applied.');
  // Said once at the top rather than repeated under every analysis: the commented R is a
  // record of what ran, not a second copy of the script to run.
  if (ctx.sawExact) {
    head.push('Under each result is the R CrossTab actually ran, commented. That is there to be');
    head.push('read, not run — it binds its own data, and may differ from the line above it.');
  }
  // A weight is the input most likely to change the numbers, so the one place the two
  // languages do not line up exactly has to be said out loud rather than left to be found.
  if (ctx.sawWeight) {
    head.push(
      D.id === 'stata'
        ? 'A weighted analysis is written [fweight=w], which is what CrossTab computes — but Stata'
        : 'A weighted analysis is bracketed WEIGHT BY / WEIGHT OFF, since SPSS weighting is a mode',
    );
    head.push(
      D.id === 'stata'
        ? 'wants whole-number fweights, so a fractional survey weight needs aweight/pweight instead.'
        : 'rather than a per-command option. Check nothing between them expects unweighted data.',
    );
  }
  // Stata's missing value sorts ABOVE every number, so `keep if x > 5` KEEPS the rows a
  // SQL filter drops, and cond() returns missing where CASE would have taken the ELSE.
  // Both are silent differences in the numbers, so they are worth saying out loud — but
  // only when the file actually contains the construct.
  if (D.id === 'stata' && (ctx.sawFilter || body.some((l) => l.includes('cond(')))) {
    head.push('Watch the missing values: Stata treats missing as larger than any number, so');
    head.push('a keep if can keep rows CrossTab dropped, and cond() yields missing where a');
    head.push('CASE would have taken the ELSE branch.');
  }

  return {
    text: head.map((h) => D.comment(h)).concat('', body).join('\n') + '\n',
    stats: { statements, translated, skipped },
  };
}

/** A `#` comment from the native script, rendered in the target dialect. Returns null
 * for the native banner, which this file's own header replaces. */
function commentThrough(line, D) {
  const t = line.replace(/^#+\s?/, '').trim();
  // A banner or breadcrumb written by OUR OWN importers is a statement about a DIFFERENT
  // file. Left in, the exported file carried "Imported from Stata .do — 46/46 commands
  // translated" directly under this file's own "35 of 36" header, and a commented-out
  // `label define Party ...` directly above the real one we generate from the same
  // labels. Both read as facts about the file you are holding, and neither is.
  if (IMPORTER_NOTE.test(t)) return null;
  if (/^CrossTab syntax\b/.test(t)) return null;
  if (!t) return D.comment('');
  // A data-source anchor is the one comment worth rewording: in a do-file it is an
  // instruction (open this first), not a note about something already done.
  const src = t.match(/^(use|append|join)\s+(".*)$/);
  if (src) return D.comment(`CrossTab data source (${src[1]}): ${src[2]} — open it before running this.`);
  return D.comment(t);
}

function ok(lines) {
  return { lines, ok: true };
}

function notTranslated(line, why, D) {
  return { lines: [D.comment(`[CrossTab, not translated${why ? `: ${why}` : ''}]: ${line}`)], ok: false };
}

// =============================================================================
// Statement dispatch
// =============================================================================

function translateStatement(line, D, ctx) {
  const { transforms, analyses, errors } = parse(line);
  if (errors.length) return notTranslated(line, errors[0].message, D);
  if (analyses.length) return transAnalysis(analyses[0], D, ctx, line);
  const op = transforms[0];
  if (!op) return notTranslated(line, 'nothing to translate', D);

  switch (op.type) {
    case 'computeVar':
      return transCompute(op, D, ctx);
    case 'recodeVar':
      return transRecode(op, D, ctx);
    case 'filterCases':
      return transFilter(op, D, ctx);
    case 'dropVars':
      return transDrop(op, D);
    case 'keepVars':
      return transKeep(op, D, line);
    case 'renameVar':
      return transRename(op, D);
    case 'setCell':
      return transSetCell(op, D, ctx);
    case 'setVariable':
      return transSetVariable(op, D, ctx, line);
    case 'setWeight':
      return transSetWeight(op, D, ctx);
    default:
      return notTranslated(line, `unsupported step "${op.type}"`, D);
  }
}

/** `compute NAME = EXPR`. */
function transCompute(op, D, ctx) {
  const name = varName(op.name, D);
  const tokens = tokenize(op.expr);
  const kase = wholeCase(tokens);

  if (D.id === 'stata') {
    // A self-referential expression is how a conditional overwrite is stored (the
    // importer turns `replace x = … if c` into `CASE WHEN c THEN … ELSE x END`), and
    // Stata spells those two cases differently: `generate` errors on an existing
    // variable, `replace` errors on a new one.
    const verb = referencesName(tokens, op.name) ? 'replace' : 'generate';
    return ok([`${verb} ${name} = ${renderExpr(tokens, D)}`]);
  }

  if (D.id === 'r') {
    // `with(d, …)` evaluates bare column names against the frame, so the shared
    // expression renderer works unchanged — no R-specific `d$` pass to keep in step.
    // A CASE needs no statement block either: R's ifelse() is an expression, which is
    // why this branch is three lines where SPSS's is twenty.
    if (!kase) return ok([`d$${op.name} <- with(d, ${renderExpr(tokens, D)})`]);
    let expr = kase.otherwise ? renderExpr(kase.otherwise, D) : 'NA';
    for (const b of [...kase.branches].reverse()) {
      expr = `ifelse(${renderExpr(b.when, D)}, ${renderExpr(b.then, D)}, ${expr})`;
    }
    return ok([`d$${op.name} <- with(d, ${expr})`]);
  }

  ctx.needsExecute = true;
  if (!kase) return ok([`COMPUTE ${name} = ${renderExpr(tokens, D)}.`]);

  // SPSS has no inline conditional, so a CASE becomes a statement, not an expression.
  // One branch whose ELSE is either absent or the target itself is exactly SPSS's `IF`
  // (other rows keep their value / stay sysmis) — the shape the importer reads back.
  const elseIsTarget = kase.otherwise && isJustName(kase.otherwise, op.name);
  if (kase.branches.length === 1 && (!kase.otherwise || elseIsTarget)) {
    const b = kase.branches[0];
    return ok([`IF (${renderExpr(b.when, D)}) ${name} = ${renderExpr(b.then, D)}.`]);
  }
  // Anything richer is a DO IF block, which is general and stays readable.
  const out = [];
  kase.branches.forEach((b, i) => {
    out.push(`${i === 0 ? 'DO IF' : 'ELSE IF'} (${renderExpr(b.when, D)}).`);
    out.push(`COMPUTE ${name} = ${renderExpr(b.then, D)}.`);
  });
  if (kase.otherwise) {
    out.push('ELSE.');
    out.push(`COMPUTE ${name} = ${renderExpr(kase.otherwise, D)}.`);
  }
  out.push('END IF.');
  return ok(out);
}

/** `recode SRC into NAME: RULES` → Stata `recode`, SPSS `RECODE`. */
function transRecode(op, D, ctx) {
  const src = varName(op.source, D);
  const into = op.name === op.source ? null : varName(op.name, D);
  const groups = [];
  let dropped = 0;

  for (const r of op.rules || []) {
    const to = recodeTo(r.to, D);
    if (to == null) {
      // `-> copy` means "leave this value alone", which is what an unmatched value
      // already does in both languages — so the rule is a no-op, not a translation gap.
      dropped += 1;
      continue;
    }
    if (r.from === 'missing') {
      groups.push(D.id === 'stata' ? `(missing = ${to})` : `(MISSING = ${to})`);
    } else if (r.from === 'range') {
      const lo = rangeEnd(r.lo, 'lo', D);
      const hi = rangeEnd(r.hi, 'hi', D);
      groups.push(D.id === 'stata' ? `(${lo}/${hi} = ${to})` : `(${lo} THRU ${hi} = ${to})`);
    } else {
      groups.push(`(${recodeValue(r.value, D)} = ${to})`);
    }
  }
  if (!groups.length) bail('recode has no rule with an effect');

  const els = op.elseRule || { kind: 'copy' };
  if (D.id === 'stata') {
    // Stata copies unmatched values by default, so only a non-copy else needs saying.
    if (els.kind !== 'copy') groups.push(`(else = ${recodeTo(els, D)})`);
    const tail = into ? `, gen(${into})` : '';
    const note = dropped ? `  // ${dropped} “-> copy” rule(s) omitted: unmatched values are copied` : '';
    return ok([`recode ${src} ${groups.join(' ')}${tail}${note}`]);
  }

  // SPSS RECODE … INTO leaves unmatched values SYSMIS unless told to copy, so the else
  // is always explicit — dropping it would silently blank every value CrossTab kept.
  groups.push(els.kind === 'copy' ? '(ELSE = COPY)' : `(ELSE = ${recodeTo(els, D)})`);
  ctx.needsExecute = true;
  const out = [];
  if (dropped) out.push(D.comment(`${dropped} “-> copy” rule(s) omitted: ELSE = COPY already keeps them`));
  out.push(`RECODE ${src} ${groups.join(' ')}${into ? ` INTO ${into}` : ''}.`);
  return ok(out);
}

/** A recode target: a literal, `sysmis`, or null for `copy` (a no-op rule). */
function recodeTo(to, D) {
  if (!to || to.kind === 'copy') return null;
  if (to.kind === 'sysmis') return D.id === 'stata' ? '.' : 'SYSMIS';
  return recodeValue(to.value, D);
}

/** A recode value. Stata's `recode` is numeric-only; SPSS can recode strings. */
function recodeValue(v, D) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v ?? '');
  if (s !== '' && Number.isFinite(Number(s))) return String(Number(s));
  if (D.id === 'stata') bail('recode with a string value (Stata’s recode is numeric-only)');
  return D.str(s);
}

/** A range end. The importers write ±1e308 for SPSS's LO/HI, so write them back. */
function rangeEnd(n, which, D) {
  const v = Number(n);
  if (!Number.isFinite(v)) bail('recode range with a non-numeric bound');
  if (Math.abs(v) >= 1e300) {
    const open = v < 0 ? which === 'lo' : which === 'hi';
    if (!open) bail('recode range bound is out of range');
    if (v < 0) return D.id === 'stata' ? 'min' : 'LO';
    return D.id === 'stata' ? 'max' : 'HI';
  }
  return String(v);
}

/** `keep if EXPR` → row filter. */
function transFilter(op, D, ctx) {
  const expr = renderExpr(tokenize(op.expr), D);
  ctx.sawFilter = true;
  if (D.id === 'stata') return ok([`keep if ${expr}`]);
  // `subset` evaluates bare column names against the frame, which is why the shared
  // expression renderer needs no R-specific pass — and it drops NA rows, matching
  // SELECT IF rather than R's own `d[cond, ]`, which keeps them as rows of NA.
  if (D.id === 'r') return ok([`d <- subset(d, ${expr})`]);
  ctx.needsExecute = true;
  return ok([`SELECT IF (${expr}).`]);
}

/** `drop a, b` → column drop. */
function transDrop(op, D) {
  const names = (op.names || []).map((n) => varName(n, D));
  if (!names.length) bail('drop with no variables');
  if (D.id === 'r') return ok([`d[c(${(op.names || []).map((n) => D.str(n)).join(', ')})] <- NULL`]);
  return ok(D.id === 'stata' ? [`drop ${names.join(' ')}`] : [`DELETE VARIABLES ${names.join(' ')}.`]);
}

/** `keep a, b` → keep only these columns. Stata has the verb; SPSS does not. */
function transKeep(op, D, line) {
  const names = (op.names || []).map((n) => varName(n, D));
  if (!names.length) bail('keep with no variables');
  if (D.id === 'stata') return ok([`keep ${names.join(' ')}`]);
  // R can express keep-only directly, where SPSS cannot — one of the few places the
  // R translation is simpler than the other two rather than harder.
  if (D.id === 'r') {
    return ok([`d <- d[, c(${(op.names || []).map((n) => D.str(n)).join(', ')}), drop = FALSE]`]);
  }
  // SPSS can only do this by writing a new file (SAVE /KEEP) or by deleting the
  // complement, and we do not know the complement — so say so rather than guess.
  return notTranslated(
    line,
    `SPSS has no in-place “keep only” — use SAVE OUTFILE=… /KEEP=${names.join(' ')}, or DELETE VARIABLES for the rest`,
    D,
  );
}

/** `rename OLD to NEW`. */
function transRename(op, D) {
  const from = varName(op.from, D);
  const to = varName(op.to, D);
  if (D.id === 'r') return ok([`names(d)[names(d) == ${D.str(op.from)}] <- ${D.str(op.to)}`]);
  return ok(D.id === 'stata' ? [`rename ${from} ${to}`] : [`RENAME VARIABLES (${from} = ${to}).`]);
}

/** `set cell row N COL = VALUE` — a manual one-cell override. */
function transSetCell(op, D, ctx) {
  const col = varName(op.column, D);
  const row = (Number(op.row) || 0) + 1; // stored 0-based, addressed 1-based in both
  const value = literal(op.value, D);
  const note = D.comment('CrossTab manual cell edit — it addresses a row number, so it only');
  const note2 = D.comment('lands on the same case if the data is in the same order.');
  if (D.id === 'stata') return ok([note, note2, `replace ${col} = ${value} in ${row}`]);
  if (D.id === 'r') return ok([note, note2, `d[${row}, ${D.str(op.column)}] <- ${value}`]);
  ctx.needsExecute = true;
  return ok([note, note2, `IF ($CASENUM = ${row}) ${col} = ${value}.`]);
}

/** `label variable` / `label values` / `set type|measure|missing` — all one op type. */
function transSetVariable(op, D, ctx, line) {
  const name = varName(op.name, D);
  const p = op.patch || {};

  if ('label' in p) {
    // Base R has no variable labels. `attr(x, "label")` is the convention haven, labelled
    // and the tidyverse read and write, so it is the one that survives a round trip
    // through read_sav() — said in a comment rather than silently emitted as if base R
    // understood it.
    if (D.id === 'r') {
      return ok([
        D.comment('base R has no variable labels; this is the haven/labelled convention'),
        `attr(d$${op.name}, "label") <- ${D.str(String(p.label ?? ''))}`,
      ]);
    }
    return ok(
      D.id === 'stata'
        ? [`label variable ${name} ${D.str(String(p.label ?? ''))}`]
        : [`VARIABLE LABELS ${name} ${D.str(String(p.label ?? ''))}.`],
    );
  }

  if ('valueLabels' in p && p.valueLabels) {
    const pairs = Object.entries(p.valueLabels);
    if (!pairs.length) bail('value labels with no codes');
    if (D.id === 'r') {
      // A labelled code in R is a factor: levels are the codes, labels are the text.
      // This CHANGES the column's type, which is what R users expect of a labelled
      // categorical — and why the comment says so rather than leaving it to be noticed.
      const codes = pairs.map(([code]) => recodeValue(code, D)).join(', ');
      const labs = pairs.map(([, lbl]) => D.str(String(lbl))).join(', ');
      return ok([
        D.comment(`labelled codes become a factor in R — ${op.name} is categorical after this`),
        `d$${op.name} <- factor(d$${op.name}, levels = c(${codes}), labels = c(${labs}))`,
      ]);
    }
    if (D.id === 'spss') {
      const body = pairs.map(([code, lbl]) => `${recodeValue(code, D)} ${D.str(String(lbl))}`).join(' ');
      return ok([`VALUE LABELS ${name} ${body}.`]);
    }
    // Stata keeps value labels in a named SET attached to the variable, so one CrossTab
    // line becomes two Stata commands — and the set name has to be unique in the file.
    //
    // Variables carrying the SAME labels share one set, which is how a real do-file is
    // written: a survey defines `support` once and attaches it to q2 q3 q4 q5. CrossTab's
    // model has no shared sets (labels live per variable, so the import expanded them),
    // and without this the export wrote four identical `label define`s — valid, but not
    // something a person would hand a colleague.
    const body = pairs
      .map(([code, lbl]) => {
        if (!/^-?\d+$/.test(String(code))) bail('Stata value labels must have integer codes');
        return `${Number(code)} ${D.str(String(lbl))}`;
      })
      .join(' ');
    const shared = ctx.labelSetByLabels.get(body);
    if (shared) return ok([`label values ${name} ${shared}`]);
    const set = labelSetName(op.name, ctx);
    ctx.labelSetByLabels.set(body, set);
    return ok([`label define ${set} ${body}, replace`, `label values ${name} ${set}`]);
  }

  if ('type' in p) {
    if (D.id === 'r') {
      const fn = p.type === 'numeric' ? 'as.numeric' : p.type === 'string' ? 'as.character' : 'factor';
      return ok([`d$${op.name} <- ${fn}(d$${op.name})`]);
    }
    if (p.type === 'numeric') {
      return ok(D.id === 'stata' ? [`destring ${name}, replace`] : [`ALTER TYPE ${name} (F8.2).`]);
    }
    if (p.type === 'string') {
      return ok(D.id === 'stata' ? [`tostring ${name}, replace`] : [`ALTER TYPE ${name} (A255).`]);
    }
    // "factor" is a CrossTab storage type. Neither language has one: Stata spells it as
    // a numeric variable wearing a value label, SPSS as a measurement level.
    return notTranslated(line, `${D.label} has no “factor” type (it is a labelled numeric variable there)`, D);
  }

  if ('measurementLevel' in p) {
    if (D.id === 'spss') return ok([`VARIABLE LEVEL ${name} (${String(p.measurementLevel).toUpperCase()}).`]);
    if (D.id === 'r') {
      // Nominal/ordinal/scale is a claim about meaning. R carries it in the TYPE —
      // an ordered factor for ordinal — so the only faithful thing is to say so.
      return ok([D.comment(
        `measurement level (${p.measurementLevel}) has no R equivalent; `
        + `an ordinal variable is an ordered factor: factor(d$${op.name}, ordered = TRUE)`,
      )]);
    }
    return notTranslated(line, 'Stata has no measurement level', D);
  }

  if ('missingValues' in p) {
    if (D.id === 'r') {
      const mv = (p.missingValues || []).map((v) => literal(v, D));
      // R has ONE missing value, NA — there is no user-missing tier to declare, so the
      // only faithful translation is to convert the codes. That is destructive in a way
      // the SPSS original is not, which is what the comment is for.
      if (!mv.length) return ok([D.comment(`no user-missing codes declared for ${op.name}`)]);
      return ok([
        D.comment('R has no user-missing tier — these codes become NA, which cannot be undone'),
        `d$${op.name}[d$${op.name} %in% c(${mv.join(', ')})] <- NA`,
      ]);
    }
    const mv = p.missingValues || [];
    if (D.id === 'spss') {
      const body = mv.map((v) => recodeValue(v, D)).join(', ');
      return ok([`MISSING VALUES ${name} (${body}).`]);
    }
    if (!mv.length) return notTranslated(line, 'Stata cannot un-designate missing values', D);
    const vals = mv.map((v) => {
      if (!Number.isFinite(Number(v))) bail('Stata’s mvdecode takes numeric codes only');
      return String(Number(v));
    });
    // mvdecode CONVERTS those values to missing, where CrossTab only marks them. Same
    // effect on every analysis, so it is the honest translation — but it edits the data.
    return ok([
      D.comment('CrossTab marks these codes missing; mvdecode converts them (same effect on results).'),
      `mvdecode ${name}, mv(${vals.join(' ')})`,
    ]);
  }

  return notTranslated(line, 'metadata edit with nothing to set', D);
}

/** A Stata `label define` set name for a variable: unique, and within Stata's 32. */
function labelSetName(varname, ctx) {
  const base = String(varname).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 27) || 'v';
  let name = `${base}_lbl`;
  let n = 2;
  while (ctx.labelSets.has(name)) name = `${base.slice(0, 25)}_lbl${n++}`;
  ctx.labelSets.add(name);
  return name;
}

/** A variable name, validated for the target dialect (a name that is legal in CrossTab
 * but not in Stata/SPSS makes the whole statement a comment rather than broken code). */
function varName(n, D) {
  const s = String(n ?? '');
  if (!D.validName(s)) bail(`“${s}” is not a valid ${D.label} variable name`);
  return s;
}

/** A stored scalar (cell value) as a target-dialect literal. */
function literal(v, D) {
  if (v == null) return D.id === 'stata' ? '.' : '$SYSMIS';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v);
  if (s !== '' && Number.isFinite(Number(s))) return s;
  return D.str(s);
}

// =============================================================================
// Analyses
// =============================================================================

/**
 * The analyses this translator will WRITE, and why it is these and not all sixty.
 *
 * #176 originally put analyses out of scope on the grounds that each plugin would have to
 * declare its own Stata/SPSS spelling. That holds for the fifty-odd plugins nothing has
 * ever translated — but not for the handful the IMPORTERS already read, where the mapping
 * is established in this codebase and was simply never inverted. An exported do-file whose
 * one analysis line is a comment produces no output at all, which is most of the point of
 * handing it to a colleague.
 *
 * The boundary is therefore: **emit only what the matching importer can read back.** Every
 * entry below is covered by a round-trip test (script → .do/.sps → script), so the syntax
 * is checked by the pair rather than by trusting that it looks right. Two entries are
 * Stata-only for exactly that reason — `spss-import` reads no `LOGISTIC REGRESSION` or
 * `UNIANOVA` — and they say so rather than guessing.
 *
 * `keys` lists every input the entry accounts for. An input OUTSIDE that list, carrying a
 * value, refuses the whole line: a future input that changes the numbers must never be
 * dropped in silence. Inputs the target language cannot print (the Statistics panel in
 * Stata, the association measures) are named in a comment above the command — the command
 * is still the right analysis, just without that extra detail.
 */
const ANALYSES = {
  'builtin-frequencies.run': {
    keys: ['vars', 'statistics', 'weight'],
    // `tabulate` is the one-variable form the importer reads; `tab1` is its n-variable
    // sibling. Both come back as this same call.
    stata: (i, D, ctx) => ({
      lines: [
        `${asList(i.vars).length > 1 ? 'tab1' : 'tabulate'} ${vlist(i.vars, D)}${stataWeight(i.weight, D, ctx)}`,
      ],
      dropped: asList(i.statistics).length ? ['the Statistics panel (tabulate cannot print it)'] : [],
    }),
    spss: (i, D, ctx) => ({
      lines: spssWeighted(i.weight, D, ctx, [`FREQUENCIES VARIABLES=${vlist(i.vars, D)}${spssStats(i.statistics)}.`]),
    }),
  },

  'builtin-descriptives.run': {
    keys: ['vars', 'weight'],
    stata: (i, D, ctx) => ({ lines: [`summarize ${vlist(i.vars, D)}${stataWeight(i.weight, D, ctx)}`] }),
    spss: (i, D, ctx) => ({ lines: spssWeighted(i.weight, D, ctx, [`DESCRIPTIVES VARIABLES=${vlist(i.vars, D)}.`]) }),
  },

  'builtin-crosstabs.run': {
    keys: ['rowvar', 'colvar', 'pmethod', 'percent', 'measures', 'weight'],
    stata: (i, D, ctx) => ({
      lines: [
        `tabulate ${varName(i.rowvar, D)} ${varName(i.colvar, D)}${stataWeight(i.weight, D, ctx)}, chi2` +
          ({ row: ' row', column: ' col', total: ' cell' }[i.percent] || ''),
      ],
      dropped: crosstabExtras(i),
    }),
    spss: (i, D, ctx) => ({
      lines: spssWeighted(i.weight, D, ctx, [
        `CROSSTABS /TABLES=${varName(i.rowvar, D)} BY ${varName(i.colvar, D)} /STATISTICS=CHISQ /CELLS=COUNT` +
          ({ row: ' ROW', column: ' COLUMN', total: ' TOTAL' }[i.percent] || '') + '.',
      ]),
      dropped: crosstabExtras(i),
    }),
  },

  'builtin-regression.run': {
    keys: ['dv', 'ivs'],
    stata: (i, D) => ({ lines: [`regress ${varName(i.dv, D)} ${vlist(i.ivs, D)}`] }),
    spss: (i, D) => ({ lines: [`REGRESSION /DEPENDENT=${varName(i.dv, D)} /METHOD=ENTER ${vlist(i.ivs, D)}.`] }),
  },

  'builtin-logistic.run': {
    keys: ['dv', 'modelled', 'ivs', 'cats', 'ref', 'opts'],
    stata: (i, D) => {
      // Stata's logit models the NON-ZERO category of a 0/1 outcome; it cannot be pointed
      // at a chosen level. CrossTab can (#187), and for 1/2-coded survey data the two
      // disagree about which category is the event — the #186 bug class exactly. So a run
      // that names its level is refused rather than quietly modelling the other one.
      if (!isEmpty(i.modelled)) {
        bail(
          `Stata’s logit models the non-zero category of a 0/1 outcome, and this run models ` +
            `“${i.modelled}” — the outcome has to be recoded first`,
        );
      }
      const cats = new Set(asList(i.cats));
      // Stata's factor notation: `i.var` dummy-codes with the LOWEST level as base;
      // `ib(last).` moves the base to the highest, which is CrossTab's "Last".
      const prefix = i.ref === 'last' ? 'ib(last).' : 'i.';
      const ivs = asList(i.ivs).map((v) => (cats.has(v) ? `${prefix}${varName(v, D)}` : varName(v, D)));
      if (!ivs.length) bail('the analysis has no predictors');
      return {
        lines: [`logit ${varName(i.dv, D)} ${ivs.join(' ')}`],
        dropped: asList(i.opts).length
          ? ['the extra tables (classification, CI for Exp(B), Hosmer–Lemeshow, residuals)']
          : [],
      };
    },
    // `spss-import` learned LOGISTIC REGRESSION (the #176 follow-up), so this is round-trip
    // checked now and no longer has to be refused.
    spss: (i, D) => {
      // Same refusal as Stata, same reason: SPSS models the higher code of the outcome and
      // cannot be aimed at a chosen level, so a run that names one would fit the opposite
      // event for 1/2-coded data — the #186 bug class.
      if (!isEmpty(i.modelled)) {
        bail(
          `SPSS's LOGISTIC REGRESSION models the higher code of the outcome, and this run models `
            + `“${i.modelled}” — the outcome has to be recoded first`,
        );
      }
      const dv = varName(i.dv, D);
      const ivs = vlist(i.ivs, D);
      const cats = asList(i.cats).map((v) => varName(v, D));
      let line = `LOGISTIC REGRESSION VARIABLES ${dv} WITH ${ivs} /METHOD=ENTER ${ivs}`;
      if (cats.length) {
        line += ` /CATEGORICAL=${cats.join(' ')}`;
        // Indicator(1) names the FIRST category as the reference. SPSS's own default is the
        // last, so "last" is written by leaving the contrast out — and CrossTab's default is
        // first, which is why it has to be stated rather than assumed either way (#178).
        if (i.ref !== 'last') for (const c of cats) line += ` /CONTRAST(${c})=Indicator(1)`;
      }
      return {
        lines: [`${line}.`],
        dropped: asList(i.opts).length
          ? ['the extra tables (classification, CI for Exp(B), Hosmer–Lemeshow, residuals)']
          : [],
      };
    },
  },

  'builtin-correlation.run': {
    keys: ['vars', 'method', 'weight'],
    stata: (i, D, ctx) => {
      const cmd = { spearman: 'spearman', kendall: 'ktau' }[i.method] || 'correlate';
      if (!isEmpty(i.weight) && cmd !== 'correlate') bail('a weighted rank correlation has no Stata equivalent');
      return { lines: [`${cmd} ${vlist(i.vars, D)}${cmd === 'correlate' ? stataWeight(i.weight, D, ctx) : ''}`] };
    },
    spss: (i, D, ctx) => {
      const rank = { spearman: 'SPEARMAN', kendall: 'KENDALL' }[i.method];
      if (!isEmpty(i.weight) && rank) bail('a weighted rank correlation has no SPSS equivalent');
      const line = rank
        ? `NONPAR CORR /VARIABLES=${vlist(i.vars, D)} /PRINT=${rank}.`
        : `CORRELATIONS /VARIABLES=${vlist(i.vars, D)}.`;
      return { lines: spssWeighted(i.weight, D, ctx, [line]) };
    },
  },

  'builtin-compare.oneSample': {
    keys: ['x', 'mu', 'weight'],
    stata: (i, D, ctx) => ({
      lines: [`ttest ${varName(i.x, D)} == ${numLit(i.mu)}${stataWeight(i.weight, D, ctx)}`],
    }),
    spss: (i, D, ctx) => ({
      lines: spssWeighted(i.weight, D, ctx, [`T-TEST /TESTVAL=${numLit(i.mu)} /VARIABLES=${varName(i.x, D)}.`]),
    }),
  },

  'builtin-compare.independent': {
    keys: ['y', 'g', 'g1', 'g2', 'weight'],
    stata: (i, D, ctx) => ({
      // Stata's by() needs the grouping variable to take exactly two values, and CrossTab
      // lets you pick which two out of many (#187) — so the pick becomes a row filter.
      lines: [
        `ttest ${varName(i.y, D)}${pickedGroups(i.g, groupsOf(i.g1, i.g2), D)}` +
          `${stataWeight(i.weight, D, ctx)}, by(${varName(i.g, D)})`,
      ],
    }),
    spss: (i, D, ctx) => ({
      lines: spssWeighted(i.weight, D, ctx, [
        `T-TEST GROUPS=${varName(i.g, D)}${groupPair(i.g1, i.g2, D)} /VARIABLES=${varName(i.y, D)}.`,
      ]),
    }),
  },

  'builtin-compare.paired': {
    keys: ['x1', 'x2', 'weight'],
    stata: (i, D, ctx) => ({
      lines: [`ttest ${varName(i.x1, D)} == ${varName(i.x2, D)}${stataWeight(i.weight, D, ctx)}`],
    }),
    spss: (i, D, ctx) => ({
      lines: spssWeighted(i.weight, D, ctx, [`T-TEST PAIRS=${varName(i.x1, D)} WITH ${varName(i.x2, D)}.`]),
    }),
  },

  'builtin-compare.oneway': {
    keys: ['y', 'g', 'groups', 'weight'],
    stata: (i, D, ctx) => ({
      lines: [
        `oneway ${varName(i.y, D)} ${varName(i.g, D)}${pickedGroups(i.g, asList(i.groups), D)}` +
          `${stataWeight(i.weight, D, ctx)}`,
      ],
    }),
    spss: (i, D, ctx) => ({
      lines: spssWeighted(i.weight, D, ctx, [`ONEWAY ${varName(i.y, D)} BY ${varName(i.g, D)}.`]),
      dropped: asList(i.groups).length ? ['the pick of which groups to include (SPSS would need a filter)'] : [],
    }),
  },

  'builtin-anova.factorial': {
    keys: ['dv', 'facs'],
    // The plugin fits `.y ~ f1 * f2` (full factorial), so the Stata model is `##`. A
    // space-separated list would be main effects only — silently a different model.
    stata: (i, D) => {
      const facs = asList(i.facs).map((f) => varName(f, D));
      if (facs.length < 2) bail('a factorial ANOVA needs two or more factors');
      return { lines: [`anova ${varName(i.dv, D)} ${facs.join('##')}`] };
    },
    // `spss-import` learned UNIANOVA (the #176 follow-up). No /DESIGN is written: SPSS's
    // default for `y BY f1 f2` is the full factorial, which is the model the plugin fits.
    spss: (i, D) => {
      const facs = asList(i.facs).map((f) => varName(f, D));
      if (facs.length < 2) bail('a factorial ANOVA needs two or more factors');
      return { lines: [`UNIANOVA ${varName(i.dv, D)} BY ${facs.join(' ')}.`] };
    },
  },
};

/** Options a crosstab carries that neither `tabulate` nor `CROSSTABS` prints here. */
function crosstabExtras(i) {
  const out = [];
  if (i.pmethod === 'montecarlo') out.push('the Monte Carlo p-value (this is the asymptotic chi-square)');
  if (i.measures && i.measures !== 'none') out.push('the association measures');
  return out;
}

/**
 * The R spelling of each analysis — the line a tutor would put on a slide.
 *
 * Kept in its own table rather than threaded into ANALYSES above because it answers a
 * different question. The Stata and SPSS columns exist so somebody can carry on in the
 * tool they already use; this one exists so somebody can LEARN the tool, which is why
 * it prefers the idiom over the closest mechanical equivalent (`aov()` and `TukeyHSD()`
 * rather than a hand-rolled sum of squares) and why it is willing to print more than
 * one line per analysis.
 *
 * `d` is the frame the preamble builds. `w` is spelled out per call because R has no
 * global weight — the thing SPSS has and Stata does not.
 */
const R_ANALYSES = {
  'builtin-frequencies.run': (i, D) => rVars(i.vars, D).map((v) => `table(d$${v}, useNA = "ifany")`),
  'builtin-descriptives.run': (i, D) => [`summary(d[, c(${rVars(i.vars, D).map((v) => D.str(v)).join(', ')})])`],
  'builtin-crosstabs.run': (i, D) => [
    `tbl <- table(d$${rVar(i.rowvar, D)}, d$${rVar(i.colvar, D)})`,
    'tbl',
    'prop.table(tbl, 1)   # row percentages',
    'chisq.test(tbl)',
  ],
  'builtin-regression.run': (i, D) => [
    `fit <- lm(${rVar(i.dv, D)} ~ ${rVars(i.ivs, D).join(' + ')}, data = d)`,
    'summary(fit)',
    'anova(fit)',
  ],
  'builtin-logistic.run': (i, D) => [
    `fit <- glm(${rVar(i.dv, D)} ~ ${rVars(i.ivs, D).join(' + ')}, data = d, family = binomial)`,
    'summary(fit)',
    'exp(cbind(OR = coef(fit), confint(fit)))   # odds ratios',
  ],
  'builtin-correlation.run': (i, D) => [
    `cor(d[, c(${rVars(i.vars, D).map((v) => D.str(v)).join(', ')})], use = "pairwise.complete.obs"`
      + `${i.method && i.method !== 'pearson' ? `, method = ${D.str(i.method)}` : ''})`,
  ],
  'builtin-compare.oneSample': (i, D) => [`t.test(d$${rVar(i.x, D)}, mu = ${numLit(i.mu)})`],
  'builtin-compare.independent': (i, D) => [
    `t.test(${rVar(i.y, D)} ~ ${rVar(i.g, D)}, data = d, var.equal = TRUE)`
      + '   # Levene first; drop var.equal for Welch',
  ],
  'builtin-compare.paired': (i, D) => [`t.test(d$${rVar(i.x1, D)}, d$${rVar(i.x2, D)}, paired = TRUE)`],
  'builtin-compare.oneway': (i, D) => [
    `fit <- aov(${rVar(i.y, D)} ~ factor(${rVar(i.g, D)}), data = d)`,
    'summary(fit)',
    'TukeyHSD(fit)',
    `bartlett.test(${rVar(i.y, D)} ~ factor(${rVar(i.g, D)}), data = d)   # homogeneity of variances`,
  ],
  'builtin-anova.factorial': (i, D) => {
    const facs = rVars(i.facs, D);
    if (facs.length < 2) bail('a factorial ANOVA needs two or more factors');
    return [
      `fit <- aov(${rVar(i.dv, D)} ~ ${facs.map((f) => `factor(${f})`).join(' * ')}, data = d)`,
      'summary(fit)',
      D.comment('CrossTab reports Type III sums of squares; aov() gives Type I.'),
      D.comment('For Type III: car::Anova(fit, type = 3) with contr.sum contrasts.'),
    ];
  },
};

/**
 * The R an analysis ACTUALLY evaluated, as a comment block under the idiomatic line.
 *
 * This is the half the owner asked for alongside the idiom: the tutor's version as live
 * code, and the engine's version recorded beneath it. They can legitimately differ, and
 * where they do, this is the only place a reader can find out why —
 *
 *   - the weighted procedures avoid `t.test`/`aov` on purpose, because those take
 *     ANALYTIC weights and CrossTab's are FREQUENCY weights;
 *   - the factorial reports Type III where `aov()` gives Type I;
 *   - the one-way computes from weighted group statistics rather than from the frame.
 *
 * Commented, never live: it binds its own vectors (`y <- df[["prestg10"]]`) from a frame
 * this script does not build, so pasting it in would not run. Saying that once, here, is
 * cheaper than a reader discovering it by running the file.
 *
 * @param {{rSource?: string[], rSourceDropped?: number}} entry the analysis log entry.
 */
function exactBlock(entry, D) {
  const runs = Array.isArray(entry?.rSource) ? entry.rSource.filter(Boolean) : [];
  if (!runs.length) return [];
  // An empty comment, without the trailing space `# ${''}` would leave behind.
  const rule = D.comment('').replace(/\s+$/, '');
  const out = [
    rule,
    D.comment(runs.length > 1
      ? `The ${runs.length} R evaluations CrossTab ran for this result, verbatim —`
      : 'The R CrossTab ran for this result, verbatim —'),
    D.comment('recorded for audit. It binds its own data, so it does not run in this file.'),
  ];
  runs.forEach((src, n) => {
    if (n) out.push(rule);
    for (const l of String(src).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')) {
      out.push(D.comment(`  ${l}`).replace(/\s+$/, ''));
    }
  });
  if (entry.rSourceDropped) {
    out.push(D.comment(`  … and ${entry.rSourceDropped} further evaluation(s), past the record size cap.`));
  }
  // One blank line, so a long run of analyses does not read as one block of comments.
  out.push('');
  return out;
}

/**
 * Pair each `run` line with the log entry it came from, so the exporter can reach what
 * the SYNTAX TEXT cannot carry: the label the user gave the run, and the R it evaluated.
 *
 * Keyed by identity (`plugin.fn` plus the inputs JSON) rather than by position, because
 * the text may have been hand-edited in the Syntax editor between being generated and
 * being exported. An edited line simply finds no entry and loses its extras, which is
 * right — the recorded source described the line as it was.
 */
function sourceIndex(analyses) {
  const byKey = new Map();
  for (const e of analyses || []) {
    if (!e || !e.pluginId) continue;
    const key = `${e.pluginId}.${e.run}|${JSON.stringify(e.inputs ?? {})}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  return {
    /** The next unclaimed entry for this parsed analysis, or null. */
    claim(a) {
      const queue = byKey.get(`${a.pluginId}.${a.run}|${JSON.stringify(a.inputs ?? {})}`);
      return queue && queue.length ? queue.shift() : null;
    },
  };
}

/** The weight note R needs, since it has no global weight to turn on. */
function rWeightNote(w, D) {
  return isEmpty(w)
    ? []
    : [D.comment(`CrossTab weighted this by ${w}; R has no global weight — pass weights= to the`),
       D.comment('model, or use the survey package for a real survey design.')];
}

/**
 * Translate one `run pluginId.fn {…}` line.
 * @param {{pluginId:string, run:string, inputs?:object}} a
 */
function transAnalysis(a, D, ctx, line) {
  // Claimed FIRST, before any bail below, so one untranslatable analysis cannot throw the
  // rest of the script out of step with the log.
  const entry = ctx.sources ? ctx.sources.claim(a) : null;
  const exact = D.id === 'r' ? exactBlock(entry, D) : [];
  if (exact.length) ctx.sawExact = true;
  const spec = ANALYSES[`${a.pluginId}.${a.run}`];
  // R's spellings live in their own table (see R_ANALYSES) — same keys, so the
  // "options this translator does not account for" guard below still applies, which is
  // the check that stops a silently-different model being handed to a student.
  const emit = D.id === 'r'
    ? (R_ANALYSES[`${a.pluginId}.${a.run}`]
      && ((i, DD, cx) => ({ lines: [...rWeightNote(i.weight, DD), ...R_ANALYSES[`${a.pluginId}.${a.run}`](i, DD, cx)] })))
    : spec && spec[D.id];
  if (!emit) {
    // Either nothing has ever translated this analysis, or only the other language has a
    // verified spelling. Say which, and keep the line verbatim in the comment.
    const why = spec
      ? `no ${D.label} spelling is round-trip verified for it`
      : `no ${D.label} spelling is declared for it`;
    const res = notTranslated(line, `analysis (${a.pluginId}.${a.run}) — ${why}; run it by hand`, D);
    // The case where the recorded source earns the most: there is no idiomatic spelling
    // for this analysis, so the R that ran is the only account of it this file can give.
    // That is also exactly the plugin an auditor is least likely to have.
    return exact.length ? { ...res, lines: [...res.lines, ...exact] } : res;
  }
  const inputs = a.inputs || {};
  const unaccounted = Object.keys(inputs).filter((k) => !spec.keys.includes(k) && !isEmpty(inputs[k]));
  if (unaccounted.length) {
    bail(
      `the analysis carries options this translator does not account for (${unaccounted.join(', ')}), ` +
        `which could change the result`,
    );
  }
  const { lines, dropped } = emit(inputs, D, ctx);
  if (D.id === 'r') ctx.sawAnalysis = true;
  const out = [];
  // The label the user gave the run, so a long script says which result is which. It comes
  // from the LOG ENTRY, not from `a`: the syntax line carries the label as a trailing
  // comment, and the parser strips comments before handing the statement over — so `a.label`
  // was always undefined here and this heading never actually printed.
  const label = entry?.label ?? a.label;
  if (D.id === 'r' && label) out.push(D.comment(`--- ${stripTrailingEllipsis(label)} ---`));
  if (dropped && dropped.length) out.push(D.comment(`The next command leaves out ${dropped.join('; ')}.`));
  out.push(...lines);
  out.push(...exact);
  return ok(out);
}

/** Menu labels end in an ellipsis ("One-way ANOVA…"); a heading should not. */
function stripTrailingEllipsis(s) {
  return String(s).replace(/\s*(?:\u2026|\.\.\.)\s*$/, '');
}

/** An input with no value: absent, blank, or an empty list. */
function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** An input as an array, whether it arrived as one or as a bare value. */
function asList(v) {
  return Array.isArray(v) ? v.filter((x) => !isEmpty(x)) : isEmpty(v) ? [] : [v];
}

/**
 * The one variable a single-variable input slot holds, validated as a name in `D`.
 *
 * Interpolating the slot directly reads fine and works for the single variable these
 * slots actually carry — a one-element array stringifies without its brackets. It fails
 * silently for anything else: two variables become `a,b`, and a name needing quoting
 * becomes broken code. Both produce a script that looks right and does not run, which is
 * the one outcome this exporter is built to avoid.
 */
function rVar(v, D) {
  const list = asList(v);
  if (!list.length) bail('an input that should name a variable arrived empty');
  if (list.length > 1) {
    bail(`one variable expected here, but the run carries ${list.length} (${list.join(', ')})`);
  }
  return varName(list[0], D);
}

/** Every variable in a multi-variable slot, each validated. */
function rVars(v, D) {
  return asList(v).map((x) => varName(x, D));
}

/** A space-separated, dialect-validated variable list. */
function vlist(v, D) {
  const arr = asList(v);
  if (!arr.length) bail('the analysis names no variables');
  return arr.map((n) => varName(n, D)).join(' ');
}

/** A number input as a literal. */
function numLit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) bail('a numeric input is not a number');
  return String(n);
}

/** A chosen category as a literal (codes may be numeric or text). */
function levelLit(v, D) {
  if (isEmpty(v)) bail('a group pick is missing');
  const s = String(v);
  return s !== '' && Number.isFinite(Number(s)) ? s : D.str(s);
}

/**
 * Stata weight clause. CrossTab reads a weight as a **frequency** weight (N is `sum(w)`,
 * variances divide by `sum(w) - 1`), so `fweight` is the faithful spelling — and it is why
 * a weighted export adds a header note, because Stata's `fweight` wants whole numbers.
 */
function stataWeight(w, D, ctx) {
  if (isEmpty(w)) return '';
  ctx.sawWeight = true;
  return ` [fweight=${varName(w, D)}]`;
}

/**
 * The DATASET's weight (Transform ▸ Weight cases…), which is the one place CrossTab and
 * SPSS mean exactly the same thing: a global mode.
 *
 * It is emitted even though every weighted analysis below already brackets itself with
 * its own WEIGHT BY / WEIGHT OFF. The brackets are what make each command correct; this
 * line is what makes the file SAY what the project was set to, so a reader of the
 * syntax is not left to infer a standing setting from a repeated one. A later
 * `WEIGHT OFF.` from a bracketed analysis does turn this one off — harmless, because
 * nothing after it relies on the global mode.
 */
function transSetWeight(op, D, ctx) {
  // Stata has no global weight at all — weighting is per command, which is what
  // `stataWeight` already attaches to each analysis. Emitting SPSS's mode statement into
  // a .do file would be a syntax error dressed as a translation, so it becomes a note.
  if (D.id !== 'spss') {
    return {
      lines: [D.comment(op.name
        ? `CrossTab weights this dataset by ${op.name}; Stata weights per command, so each analysis below carries it`
        : 'CrossTab weighting turned off here')],
    };
  }
  if (!op.name) return { lines: ['WEIGHT OFF.'] };
  ctx.sawWeight = true;
  return { lines: [`WEIGHT BY ${varName(op.name, D)}.`] };
}

/** SPSS has no per-command weight — `WEIGHT BY` is a global mode — so bracket the command
 * and switch it back off, which is the closest thing to CrossTab's per-analysis weight. */
function spssWeighted(w, D, ctx, lines) {
  if (isEmpty(w)) return lines;
  ctx.sawWeight = true;
  return [`WEIGHT BY ${varName(w, D)}.`, ...lines, 'WEIGHT OFF.'];
}

/** SPSS's `GROUPS=g(1 2)`, or a bare `GROUPS=g` when no pick was recorded (SPSS then uses
 * the two values present, which is what an imported `ttest y, by(g)` meant). */
function groupsOf(g1, g2) {
  if (isEmpty(g1) && isEmpty(g2)) return [];
  if (isEmpty(g1) || isEmpty(g2)) bail('only one of the two groups was recorded');
  return [g1, g2];
}

function groupPair(g1, g2, D) {
  if (isEmpty(g1) && isEmpty(g2)) return '';
  if (isEmpty(g1) || isEmpty(g2)) bail('only one of the two groups was recorded');
  return `(${levelLit(g1, D)} ${levelLit(g2, D)})`;
}

/** A row filter for the groups the user picked out of a larger factor. */
function pickedGroups(g, picks, D) {
  const vals = asList(picks);
  if (!vals.length) return '';
  return ` if inlist(${varName(g, D)}, ${vals.map((v) => levelLit(v, D)).join(', ')})`;
}

/** The `/STATISTICS=` clause for SPSS FREQUENCIES, from the plugin's tick-list. */
function spssStats(stats) {
  const MAP = {
    mean: 'MEAN', median: 'MEDIAN', mode: 'MODE', sum: 'SUM', sd: 'STDDEV',
    variance: 'VARIANCE', se: 'SEMEAN', range: 'RANGE', min: 'MINIMUM',
    max: 'MAXIMUM', quartiles: 'QUARTILES',
  };
  const picked = asList(stats).map((s) => MAP[s]).filter(Boolean);
  return picked.length ? ` /STATISTICS=${picked.join(' ')}` : '';
}

// =============================================================================
// Expressions: DuckDB SQL → Stata / SPSS
// =============================================================================

/** SQL words we understand structurally. Anything else that looks like a bare word is
 * either a function (must be in {@link FUNCS}) or a variable name. */
const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE',
]);

/**
 * Tokenize a DuckDB scalar expression. Bails on any character we have not thought
 * about — `||`, `::`, `%`, `[`, a subquery — because a token we cannot classify is a
 * meaning we cannot preserve.
 *
 * @returns {{t:string, v:string}[]} t: str | num | name | kw | op | punc
 */
function tokenize(sql) {
  const s = String(sql ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    // 'string literal' — SQL doubles an internal quote.
    if (c === "'") {
      let v = '';
      i += 1;
      for (;;) {
        if (i >= s.length) bail('unterminated string in the expression');
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        v += s[i++];
      }
      out.push({ t: 'str', v });
      continue;
    }
    // "quoted identifier" — a NAME in SQL, not a string.
    if (c === '"') {
      let v = '';
      i += 1;
      for (;;) {
        if (i >= s.length) bail('unterminated quoted name in the expression');
        if (s[i] === '"') {
          i += 1;
          break;
        }
        v += s[i++];
      }
      out.push({ t: 'name', v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = s.slice(i).match(/^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      const up = m[0].toUpperCase();
      out.push(KEYWORDS.has(up) ? { t: 'kw', v: up } : { t: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: 'punc', v: c });
      i += 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<>' || two === '!=' || two === '<=' || two === '>=') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/<>='.includes(c)) {
      out.push({ t: 'op', v: c });
      i += 1;
      continue;
    }
    bail(`the expression uses “${c}”, which has no clean equivalent`);
  }
  if (!out.length) bail('empty expression');
  return out;
}

/**
 * Render a token list in the target dialect. Throws {@link Unsupported} rather than
 * guessing, which is what keeps a half-translated expression out of the file.
 */
function renderExpr(tokens, D) {
  const parts = [];
  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i];

    if (tk.t === 'kw' && tk.v === 'CASE') {
      if (D.id !== 'stata') bail('SPSS has no inline conditional (CASE WHEN) inside an expression');
      const kase = readCase(tokens, i);
      parts.push(renderCond(kase, D));
      i = kase.end;
      continue;
    }

    // `x IS [NOT] NULL` → missing(x) / MISSING(x). The operand is the name we just
    // emitted, so it comes back off the output.
    if (tk.t === 'kw' && tk.v === 'IS') {
      const negated = tokens[i + 1]?.t === 'kw' && tokens[i + 1].v === 'NOT';
      const nullTok = tokens[i + (negated ? 2 : 1)];
      if (!nullTok || nullTok.t !== 'kw' || nullTok.v !== 'NULL') bail('IS without NULL');
      const operand = popOperand(parts);
      parts.push(negated ? D.notNull(operand) : D.isNull(operand));
      i += negated ? 3 : 2;
      continue;
    }

    // `x IN (a, b, …)` → inlist(x, a, b) / ANY(x, a, b)
    if (tk.t === 'kw' && tk.v === 'IN') {
      if (tokens[i + 1]?.v !== '(') bail('IN without a list');
      const close = matchParen(tokens, i + 1);
      const args = splitArgs(tokens.slice(i + 2, close)).map((a) => renderExpr(a, D));
      if (!args.length) bail('IN with an empty list');
      parts.push(D.inList(popOperand(parts), args));
      i = close + 1;
      continue;
    }

    // `x BETWEEN a AND b` → inrange(x, a, b) / RANGE(x, a, b)
    if (tk.t === 'kw' && tk.v === 'BETWEEN') {
      const andAt = findTopLevel(tokens, i + 1, (t) => t.t === 'kw' && t.v === 'AND');
      if (andAt < 0) bail('BETWEEN without AND');
      const lo = renderExpr(tokens.slice(i + 1, andAt), D);
      const hiEnd = endOfOperand(tokens, andAt + 1);
      const hi = renderExpr(tokens.slice(andAt + 1, hiEnd), D);
      parts.push(D.inRange(popOperand(parts), lo, hi));
      i = hiEnd;
      continue;
    }

    if (tk.t === 'kw') {
      if (tk.v === 'AND') parts.push(D.and);
      else if (tk.v === 'OR') parts.push(D.or);
      else if (tk.v === 'NOT') parts.push(D.not);
      else if (tk.v === 'TRUE') parts.push('1');
      else if (tk.v === 'FALSE') parts.push('0');
      // A bare NULL that `IS NULL` did not consume is a VALUE — the conditional
      // "blank this out" shape (`CASE WHEN bad THEN NULL ELSE x END`).
      else if (tk.v === 'NULL') parts.push(D.sysmis);
      else bail(`SQL keyword ${tk.v} has no ${D.label} equivalent here`);
      i += 1;
      continue;
    }

    if (tk.t === 'str') {
      parts.push(D.str(tk.v));
      i += 1;
      continue;
    }
    if (tk.t === 'num') {
      parts.push(tk.v);
      i += 1;
      continue;
    }
    if (tk.t === 'op') {
      parts.push(tk.v === '=' ? D.eq : tk.v === '<>' || tk.v === '!=' ? D.ne : tk.v);
      i += 1;
      continue;
    }
    if (tk.t === 'punc') {
      parts.push(tk.v);
      i += 1;
      continue;
    }

    // A bare word: a function call if `(` follows, otherwise a variable.
    if (tokens[i + 1]?.v === '(') {
      const spelling = D.fn(tk.v.toLowerCase());
      if (!spelling) bail(`function ${tk.v}() has no ${D.label} equivalent`);
      const close = matchParen(tokens, i + 1);
      const args = splitArgs(tokens.slice(i + 2, close));
      const arity = FUNCS[tk.v.toLowerCase()].arity;
      if (arity && !arity.includes(args.length)) {
        bail(`${tk.v}() with ${args.length} argument(s) does not mean the same thing in ${D.label}`);
      }
      parts.push(`${spelling}(${args.map((a) => renderExpr(a, D)).join(', ')})`);
      i = close + 1;
      continue;
    }
    parts.push(varName(tk.v, D));
    i += 1;
  }
  return joinParts(parts);
}

/** Space the rendered atoms the way a person would: none inside call parentheses or
 * before a comma, one around operators. */
function joinParts(parts) {
  let out = '';
  for (const p of parts) {
    const last = out.slice(-1);
    const noSpace =
      out === '' || p === ',' || p === ')' || last === '(' || last === '!' ||
      (p === '(' && /[A-Za-z0-9_)]$/.test(out));
    out += noSpace ? p : ` ${p}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** The last rendered atom, for the operators SQL writes postfix (IS NULL, IN, BETWEEN). */
function popOperand(parts) {
  const v = parts.pop();
  if (v == null || v === '(' || v === ',') bail('IS NULL / IN / BETWEEN without a variable in front of it');
  return v;
}

/** Read `CASE WHEN c THEN v [WHEN …] [ELSE v] END` starting at `i`. */
function readCase(tokens, i) {
  const branches = [];
  let otherwise = null;
  let depth = 0;
  let j = i + 1;
  let mode = null; // 'when' | 'then' | 'else'
  let buf = [];
  let when = null;
  const closeMode = () => {
    if (mode === 'when') when = buf;
    else if (mode === 'then') branches.push({ when, then: buf });
    else if (mode === 'else') otherwise = buf;
    buf = [];
  };
  for (; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.t === 'kw' && t.v === 'CASE') depth += 1;
    if (t.t === 'kw' && depth === 0 && ['WHEN', 'THEN', 'ELSE', 'END'].includes(t.v)) {
      closeMode();
      if (t.v === 'END') {
        if (!branches.length) bail('CASE with no WHEN');
        return { branches, otherwise, end: j + 1 };
      }
      mode = t.v.toLowerCase();
      continue;
    }
    if (t.t === 'kw' && t.v === 'END') depth -= 1;
    buf.push(t);
  }
  bail('CASE without END');
}

/** Stata's conditional is an expression: cond(c, a, cond(c2, b, else)). */
function renderCond(kase, D) {
  const last = kase.otherwise ? renderExpr(kase.otherwise, D) : D.sysmis;
  return kase.branches.reduceRight(
    (acc, b) => `cond(${renderExpr(b.when, D)}, ${renderExpr(b.then, D)}, ${acc})`,
    last,
  );
}

/** The whole expression as a single CASE, or null. Used by the SPSS compute path, which
 * has to turn a conditional into statements rather than an expression. */
function wholeCase(tokens) {
  if (tokens[0]?.t !== 'kw' || tokens[0].v !== 'CASE') return null;
  let kase;
  try {
    kase = readCase(tokens, 0);
  } catch {
    return null;
  }
  return kase.end === tokens.length ? kase : null;
}

/** Whether a token list is exactly one reference to `name` (`CASE … ELSE x END`). */
function isJustName(tokens, name) {
  return tokens.length === 1 && tokens[0].t === 'name' && tokens[0].v === name;
}

/** Whether the expression mentions `name` at all — a conditional overwrite of itself. */
function referencesName(tokens, name) {
  return tokens.some((t, i) => t.t === 'name' && t.v === name && tokens[i + 1]?.v !== '(');
}

/** Index of the token after the `(` at `open`'s match. */
function matchParen(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].v === '(') depth += 1;
    else if (tokens[i].v === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  bail('unbalanced parentheses in the expression');
}

/** Split a comma-separated argument list (already inside its parentheses). */
function splitArgs(tokens) {
  const args = [];
  let depth = 0;
  let cur = [];
  for (const t of tokens) {
    if (t.v === '(') depth += 1;
    if (t.v === ')') depth -= 1;
    if (t.v === ',' && depth === 0) {
      args.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) args.push(cur);
  return args;
}

/** First index at/after `from` satisfying `pred` at paren depth 0. */
function findTopLevel(tokens, from, pred) {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].v === '(') depth += 1;
    else if (tokens[i].v === ')') depth -= 1;
    else if (depth === 0 && pred(tokens[i])) return i;
  }
  return -1;
}

/** End of the single operand starting at `from` — a literal/name, or a paren group.
 * Used for BETWEEN's upper bound, which ends before the next logical operator. */
function endOfOperand(tokens, from) {
  if (!tokens[from]) bail('BETWEEN without an upper bound');
  if (tokens[from].v === '(') return matchParen(tokens, from) + 1;
  if (tokens[from].t === 'name' && tokens[from + 1]?.v === '(') return matchParen(tokens, from + 1) + 1;
  return from + 1;
}
