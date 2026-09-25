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
 * Scope, matching the import side and #176's decision: **transforms only.**
 * `run pluginId.fn {…}` analysis lines become comments — translating them would need
 * every plugin to declare its own Stata/SPSS spelling, the same blocker the R-syntax
 * export has.
 *
 * Pure module — no DOM, no app deps. Each entry point returns
 * `{ text, stats: { statements, translated, skipped } }`.
 */

import { parse } from './crosstab-syntax.js';

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
  abs: { stata: 'abs', spss: 'ABS', arity: [1] },
  sqrt: { stata: 'sqrt', spss: 'SQRT', arity: [1] },
  ln: { stata: 'ln', spss: 'LN', arity: [1] },
  // DuckDB's log() is base-10 (ln() is the natural one), which is why both map here.
  log: { stata: 'log10', spss: 'LG10', arity: [1] },
  log10: { stata: 'log10', spss: 'LG10', arity: [1] },
  exp: { stata: 'exp', spss: 'EXP', arity: [1] },
  round: { stata: 'round', spss: 'RND', arity: [1] },
  floor: { stata: 'floor', spss: null, arity: [1] },
  ceil: { stata: 'ceil', spss: null, arity: [1] },
  ceiling: { stata: 'ceil', spss: null, arity: [1] },
  // Row-wise in both languages (Stata's min()/max() and SPSS's MIN()/MAX() take a list).
  least: { stata: 'min', spss: 'MIN', arity: null },
  greatest: { stata: 'max', spss: 'MAX', arity: null },
  upper: { stata: 'upper', spss: 'UPCASE', arity: [1] },
  lower: { stata: 'lower', spss: 'LOWER', arity: [1] },
  length: { stata: 'strlen', spss: 'LENGTH', arity: [1] },
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

/** The filename an export should be offered under. */
export function scriptFileName(dialect, base = 'analysis') {
  return `${base}.${dialect === 'spss' ? 'sps' : 'do'}`;
}

/**
 * Walk the script one line at a time. The native grammar is one statement per line, so
 * one line in means one statement out (or one comment) — which is what lets a single
 * untranslatable line be commented in place without disturbing anything around it.
 *
 * Each line is re-parsed with the REAL parser rather than a private copy of it, so the
 * export can never disagree with what Run would do.
 */
function translate(text, D) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const body = [];
  const ctx = { labelSets: new Set(), needsExecute: false, sawFilter: false };
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

  const head = [
    `Exported from CrossTab — best-effort ${D.label} translation.`,
    `${translated} of ${statements} statement${statements === 1 ? '' : 's'} translated` +
      (skipped ? `; ${skipped} left as comments — search “not translated”.` : '.'),
    'The data is NOT in this file: open your dataset first, then run this.',
  ];
  if (skipped) head.push('Read every commented line: those steps have NOT been applied.');
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
  if (analyses.length) {
    // Out of scope by decision (#176): an analysis is a plugin call, and only the plugin
    // knows its Stata/SPSS spelling. Keep the line verbatim so nothing is lost.
    const a = analyses[0];
    return notTranslated(line, `analysis (${a.pluginId}.${a.run}) — run it in ${D.label} by hand`, D);
  }
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
  ctx.needsExecute = true;
  return ok([`SELECT IF (${expr}).`]);
}

/** `drop a, b` → column drop. */
function transDrop(op, D) {
  const names = (op.names || []).map((n) => varName(n, D));
  if (!names.length) bail('drop with no variables');
  return ok(D.id === 'stata' ? [`drop ${names.join(' ')}`] : [`DELETE VARIABLES ${names.join(' ')}.`]);
}

/** `keep a, b` → keep only these columns. Stata has the verb; SPSS does not. */
function transKeep(op, D, line) {
  const names = (op.names || []).map((n) => varName(n, D));
  if (!names.length) bail('keep with no variables');
  if (D.id === 'stata') return ok([`keep ${names.join(' ')}`]);
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
  ctx.needsExecute = true;
  return ok([note, note2, `IF ($CASENUM = ${row}) ${col} = ${value}.`]);
}

/** `label variable` / `label values` / `set type|measure|missing` — all one op type. */
function transSetVariable(op, D, ctx, line) {
  const name = varName(op.name, D);
  const p = op.patch || {};

  if ('label' in p) {
    return ok(
      D.id === 'stata'
        ? [`label variable ${name} ${D.str(String(p.label ?? ''))}`]
        : [`VARIABLE LABELS ${name} ${D.str(String(p.label ?? ''))}.`],
    );
  }

  if ('valueLabels' in p && p.valueLabels) {
    const pairs = Object.entries(p.valueLabels);
    if (!pairs.length) bail('value labels with no codes');
    if (D.id === 'spss') {
      const body = pairs.map(([code, lbl]) => `${recodeValue(code, D)} ${D.str(String(lbl))}`).join(' ');
      return ok([`VALUE LABELS ${name} ${body}.`]);
    }
    // Stata keeps value labels in a named SET attached to the variable, so one CrossTab
    // line becomes two Stata commands — and the set name has to be unique in the file.
    const set = labelSetName(op.name, ctx);
    const body = pairs
      .map(([code, lbl]) => {
        if (!/^-?\d+$/.test(String(code))) bail('Stata value labels must have integer codes');
        return `${Number(code)} ${D.str(String(lbl))}`;
      })
      .join(' ');
    return ok([`label define ${set} ${body}, replace`, `label values ${name} ${set}`]);
  }

  if ('type' in p) {
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
    return notTranslated(line, 'Stata has no measurement level', D);
  }

  if ('missingValues' in p) {
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
