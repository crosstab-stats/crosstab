/**
 * @file spss-import.js
 * Best-effort translator: an SPSS **.sps syntax file** → CrossTab script text (#135).
 *
 * Sibling of {@link module:core/stata-import}. Scope is the everyday ~80% of
 * teaching/social-science SPSS syntax — the common data-prep and analysis commands
 * and expression operators. Anything unrecognised becomes a
 * `# [SPSS, not translated]: <cmd>` comment (nothing silently dropped). Loads into the
 * Syntax editor as a DRAFT for review, never auto-applied.
 *
 * The big structural difference from Stata: SPSS statements are **terminated by a `.`
 * at end of line** and span multiple lines with `/SUBCOMMAND` clauses — so we
 * accumulate lines until a period-terminated one, then flatten to a single logical
 * command before dispatch.
 *
 * Pure module — no DOM, no app deps. `spssToScript(text)` → `{ script, stats }`.
 */

/** @param {string} text @returns {{script:string, stats:{commands:number,translated:number,skipped:number}}} */
export function spssToScript(text) {
  const stmts = preprocess(text);
  const out = [];
  let commands = 0;
  let translated = 0;
  let skipped = 0;

  // Track variables the script has ASSIGNED so far, so an `IF` onto an existing var
  // preserves other rows (ELSE var) while an `IF` creating a NEW var leaves them NULL
  // (as SPSS does) — without this, a new-var IF emits `ELSE newvar` and fails on Run.
  const state = { seen: new Set() };

  for (const s of stmts) {
    if (s.kind === 'comment') { out.push(s.text ? `# ${s.text}` : '#'); continue; }
    if (s.kind === 'blank') { out.push(''); continue; }
    commands += 1;
    let res;
    try {
      res = translateCommand(s.text, state);
    } catch (err) {
      res = { lines: [comment(`[SPSS, error: ${err.message}]: ${s.text}`)], ok: false };
    }
    if (res.ok) translated += 1;
    else skipped += 1;
    for (const l of res.lines) out.push(l);
  }

  const header = [
    `# Imported from SPSS syntax — ${translated}/${commands} commands translated` +
      (skipped ? `, ${skipped} left as # comments (review below)` : '') + '.',
    '# Best-effort: check the translation, then Run.',
    '',
  ];
  return { script: header.concat(out).join('\n') + '\n', stats: { commands, translated, skipped } };
}

// =============================================================================
// Preprocess: strip block comments, split into period-terminated statements.
// =============================================================================

function preprocess(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const lines = s.split('\n');
  const stmts = [];
  let buf = [];
  const flush = () => {
    const raw = buf.join('\n').trim();
    buf = [];
    if (raw !== '') stmts.push(raw);
  };
  for (const line of lines) {
    if (line.trim() === '' && buf.length === 0) { stmts.push('__BLANK__'); continue; }
    buf.push(line);
    if (/\.\s*$/.test(line)) flush(); // a period at end-of-line terminates the command
  }
  flush();

  return stmts.map((raw) => {
    if (raw === '__BLANK__') return { kind: 'blank' };
    const t = raw.replace(/\.\s*$/, '').trim(); // drop the terminating period
    if (!t) return { kind: 'blank' };
    // A statement beginning with `*` (or COMMENT) is a comment, through its period.
    if (t.startsWith('*') || /^comment\b/i.test(t)) {
      return { kind: 'comment', text: t.replace(/^\*+\s?/, '').replace(/^comment\b\s*/i, '').replace(/\s+/g, ' ') };
    }
    return { kind: 'command', text: t.replace(/\s+/g, ' ') }; // flatten multi-line to one
  });
}

// =============================================================================
// Command dispatch
// =============================================================================

const IGNORE = /^(EXECUTE|DATASET|SET|SHOW|TITLE|SUBTITLE|OUTPUT|PRESERVE|RESTORE|SORT\s+CASES|FORMATS|VARIABLE\s+LEVEL|VARIABLE\s+WIDTH|DISPLAY|SUBST|INSERT|CD|N\s+OF\s+CASES|CACHE|APPLY\s+DICTIONARY)\b/i;

function translateCommand(text, state) {
  const word = firstWord(text);

  // data load / save → File menu
  if (/^(GET|IMPORT|GET\s+DATA)$/i.test(word) || /^GET\b/i.test(text)) return note(text, 'load this dataset via File ▸ Import data…');
  if (/^(SAVE|EXPORT|WRITE)$/i.test(word)) return note(text, 'export via File ▸ Export data…');

  if (IGNORE.test(text)) return ok([comment(`(skipped SPSS setup) ${text}`)]);

  // data prep
  if (/^COMPUTE$/i.test(word)) return transCompute(text, state);
  if (/^IF$/i.test(word)) return transIf(text, state);
  if (/^RECODE$/i.test(word)) return transRecode(text, state);
  if (/^(SELECT)$/i.test(word) && /^select\s+if\b/i.test(text)) return transSelectIf(text);
  if (/^RENAME$/i.test(word)) return transRename(text, state);
  if (/^DELETE$/i.test(word) && /^delete\s+variables\b/i.test(text)) return transDelete(text);
  if (/^MISSING$/i.test(word) && /^missing\s+values\b/i.test(text)) return transMissing(text);
  if (/^VARIABLE$/i.test(word) && /^variable\s+labels\b/i.test(text)) return transVarLabels(text);
  if (/^VALUE$/i.test(word) && /^value\s+labels\b/i.test(text)) return transValueLabels(text);

  // analyses
  if (/^(FREQUENCIES|FREQ)$/i.test(word)) return transVarlistAnalysis(text, 'builtin-frequencies', 'run', 'vars');
  if (/^(DESCRIPTIVES|DESCRIPTIVE)$/i.test(word)) return transVarlistAnalysis(text, 'builtin-descriptives', 'run', 'vars');
  if (/^CROSSTABS$/i.test(word)) return transCrosstabs(text);
  if (/^(REGRESSION|REG)$/i.test(word)) return transRegression(text);
  if (/^(CORRELATIONS|CORRELATION)$/i.test(word)) return transVarlistAnalysis(text, 'builtin-correlation', 'run', 'vars', { method: 'pearson' });
  if (/^(T-TEST|TTEST)$/i.test(word) || /^t-test\b/i.test(text)) return transTtest(text);
  if (/^ONEWAY$/i.test(word)) return transOneway(text);

  return skip(text, `unrecognised command "${word}"`);
}

// --- data-prep handlers ------------------------------------------------------

/** COMPUTE var = expr */
function transCompute(text, state) {
  const m = text.replace(/^compute\s+/i, '').match(/^([A-Za-z_][\w.]*)\s*=\s*(.+)$/);
  if (!m) return skip(text, 'compute (could not parse)');
  state?.seen?.add(m[1]);
  return ok([`compute ${ident(m[1])} = ${spssExpr(m[2])}`]);
}

/** IF (cond) var = expr  → conditional compute. `ELSE var` (preserve other rows) only
 * when the target already exists — assigned earlier in the script, or referenced in
 * the condition/expression; otherwise NULL elsewhere (SPSS's new-var behaviour). */
function transIf(text, state) {
  const mp = text.match(/^if\s+\((.+?)\)\s+([A-Za-z_][\w.]*)\s*=\s*(.+)$/i);
  const m = mp || text.replace(/^if\s+/i, '').match(/^\(?\s*(.+?)\s*\)?\s+([A-Za-z_][\w.]*)\s*=\s*(.+)$/);
  if (!m) return skip(text, 'if (could not parse)');
  const [, cond, name, expr] = m;
  const mentioned = new RegExp(`\\b${name.replace(/[.]/g, '\\.')}\\b`).test(`${cond} ${expr}`);
  const existing = state?.seen?.has(name) || mentioned;
  state?.seen?.add(name);
  const tail = existing ? ` ELSE ${ident(name)}` : '';
  return ok([`compute ${ident(name)} = CASE WHEN ${spssExpr(cond)} THEN ${spssExpr(expr)}${tail} END`]);
}

/** RECODE var (rules) [INTO newvar]  — SPSS THRU/LO/HI/MISSING/SYSMIS/ELSE/COPY. */
function transRecode(text, state) {
  const body = text.replace(/^recode\s+/i, '');
  const intoM = body.match(/\)\s*into\s+([A-Za-z_][\w.]*)\s*$/i);
  const target = intoM ? intoM[1] : null;
  const head = body.replace(/\s*into\s+[A-Za-z_][\w.]*\s*$/i, '');
  const srcM = head.match(/^([A-Za-z_][\w.]*)/);
  if (!srcM) return skip(text, 'recode (no source var)');
  const src = srcM[1];
  const groups = [...head.slice(srcM[0].length).matchAll(/\(([^)]*)\)/g)].map((x) => x[1].trim());
  if (!groups.length) return skip(text, 'recode (no rules)');
  const rules = [];
  let elseRule = null;
  for (const g of groups) {
    const eq = g.split('=');
    if (eq.length < 2) continue;
    const lhs = eq[0].trim();
    const rhsRaw = eq.slice(1).join('=').trim();
    const to = /^sysmis$/i.test(rhsRaw) ? 'sysmis' : /^copy$/i.test(rhsRaw) ? 'copy' : recodeVal(rhsRaw);
    if (/^else$/i.test(lhs)) { elseRule = to; continue; }
    if (/^missing$/i.test(lhs) || /^sysmis$/i.test(lhs)) { rules.push(`missing -> ${to}`); continue; }
    // THRU ranges (incl. LO/LOWEST/HI/HIGHEST)
    const thru = lhs.match(/^(\S+)\s+thru\s+(\S+)$/i);
    if (thru) {
      const lo = /^(lo|lowest)$/i.test(thru[1]) ? '-1e308' : num(thru[1]);
      const hi = /^(hi|highest)$/i.test(thru[2]) ? '1e308' : num(thru[2]);
      rules.push(`${lo}..${hi} -> ${to}`);
      continue;
    }
    for (const tok of lhs.split(/[\s,]+/).filter(Boolean)) rules.push(`${recodeVal(tok)} -> ${to}`);
  }
  rules.push(`else ${elseRule != null ? elseRule : 'copy'}`);
  state?.seen?.add(target || src);
  return ok([`recode ${ident(src)} into ${ident(target || src)}: ${rules.join('; ')}`]);
}

/** SELECT IF (cond) → keep if */
function transSelectIf(text) {
  const m = text.match(/^select\s+if\s*\(?\s*(.+?)\s*\)?\s*$/i);
  if (!m) return skip(text, 'select if (could not parse)');
  return ok([`keep if ${spssExpr(m[1])}`]);
}

/** RENAME VARIABLES (old=new) / (o1 o2 = n1 n2) [ (…)…] */
function transRename(text, state) {
  if (!/^rename\s+variables\b/i.test(text) && !/^rename\s+vars\b/i.test(text)) return skip(text, 'rename (unsupported form)');
  const groups = [...text.matchAll(/\(([^)]*)\)/g)].map((x) => x[1]);
  const lines = [];
  for (const g of groups) {
    const [lhs, rhs] = g.split('=');
    if (!rhs) continue;
    const olds = lhs.trim().split(/\s+/).filter(Boolean);
    const news = rhs.trim().split(/\s+/).filter(Boolean);
    if (olds.length !== news.length) return skip(text, 'rename (mismatched name lists)');
    olds.forEach((o, i) => { lines.push(`rename ${ident(o)} to ${ident(news[i])}`); state?.seen?.add(news[i]); });
  }
  return lines.length ? ok(lines) : skip(text, 'rename (could not parse)');
}

/** DELETE VARIABLES x y → drop */
function transDelete(text) {
  const vars = text.replace(/^delete\s+variables\s+/i, '').split(/[\s,]+/).filter((v) => v && /^[A-Za-z_]/.test(v));
  return vars.length ? ok([`drop ${vars.map(ident).join(', ')}`]) : skip(text, 'delete variables (no vars)');
}

/** MISSING VALUES x (99) y (98 99) → set missing */
function transMissing(text) {
  const body = text.replace(/^missing\s+values\s+/i, '');
  const re = /([A-Za-z_][\w.\s]*?)\s*\(([^)]*)\)/g;
  const lines = [];
  let m;
  while ((m = re.exec(body))) {
    const vars = m[1].trim().split(/\s+/).filter(Boolean);
    const vals = m[2].trim().split(/[\s,]+/).filter(Boolean).map(recodeVal);
    for (const v of vars) lines.push(`set missing ${ident(v)} = ${vals.join(', ')}`);
  }
  return lines.length ? ok(lines) : skip(text, 'missing values (could not parse)');
}

/** VARIABLE LABELS v1 "l1" v2 "l2" … */
function transVarLabels(text) {
  const body = text.replace(/^variable\s+labels\s+/i, '');
  const re = /([A-Za-z_][\w.]*)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  const lines = [];
  let m;
  while ((m = re.exec(body))) lines.push(`label variable ${ident(m[1])} "${(m[2] ?? m[3]).replace(/"/g, '\\"')}"`);
  return lines.length ? ok(lines) : skip(text, 'variable labels (could not parse)');
}

/** VALUE LABELS [/] v1 [v2 …] 1 "a" 2 "b" [/ v3 …] */
function transValueLabels(text) {
  const body = text.replace(/^value\s+labels\s+/i, '').replace(/^\/\s*/, '');
  const groups = body.split(/\s+\/\s+|\s*\/\s*/).map((g) => g.trim()).filter(Boolean);
  const lines = [];
  for (const g of groups) {
    // leading tokens up to the first code (number or quoted) are variable names
    const firstCode = g.search(/(^|\s)(-?\d|["'])/);
    // find where the code/label pairs start: the first token that's a number or quote
    const mHead = g.match(/^((?:[A-Za-z_][\w.]*\s+)+?)((?:-?\d|["']).*)$/);
    if (!mHead) continue;
    const vars = mHead[1].trim().split(/\s+/).filter(Boolean);
    const rest = mHead[2];
    const pairs = [];
    const re = /(-?\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
    let pm;
    while ((pm = re.exec(rest))) {
      const code = pm[1].replace(/^["']|["']$/g, '');
      const label = (pm[2] ?? pm[3]).replace(/"/g, '\\"');
      pairs.push(`${recodeVal(code)} "${label}"`);
    }
    if (pairs.length) for (const v of vars) lines.push(`label values ${ident(v)} ${pairs.join(', ')}`);
    void firstCode;
  }
  return lines.length ? ok(lines) : skip(text, 'value labels (could not parse)');
}

// --- analysis handlers -------------------------------------------------------

/** FREQUENCIES / DESCRIPTIVES / CORRELATIONS — a varlist from /VARIABLES= or bare. */
function transVarlistAnalysis(text, pluginId, fn, key, extra) {
  const vars = subVarlist(text, 'VARIABLES') || bareVarlist(text);
  if (!vars.length) return skip(text, 'no variables');
  return ok([`run ${pluginId}.${fn} ${JSON.stringify({ [key]: vars, ...(extra || {}) })}`]);
}

/** CROSSTABS /TABLES=a BY b */
function transCrosstabs(text) {
  const m = text.match(/tables\s*=\s*(.+?)(?:\/|$)/i);
  const body = m ? m[1] : text.replace(/^crosstabs\s*/i, '');
  const by = body.split(/\s+by\s+/i);
  if (by.length < 2) return skip(text, 'crosstabs (need row BY col)');
  const rowvar = by[0].trim().split(/\s+/)[0];
  const colvar = by[1].trim().split(/\s+/)[0];
  if (!rowvar || !colvar) return skip(text, 'crosstabs (could not parse)');
  return ok([`run builtin-crosstabs.run ${JSON.stringify({ rowvar, colvar })}`]);
}

/** REGRESSION /DEPENDENT=y /METHOD=ENTER x1 x2 */
function transRegression(text) {
  const dep = (text.match(/dependent\s*=?\s*([A-Za-z_][\w.]*)/i) || [])[1];
  const meth = text.match(/method\s*=?\s*enter\s+(.+?)(?:\/|$)/i);
  const ivs = meth ? meth[1].trim().split(/[\s,]+/).filter((v) => v && /^[A-Za-z_]/.test(v)) : [];
  if (!dep || !ivs.length) return skip(text, 'regression (need /DEPENDENT and /METHOD=ENTER)');
  return ok([`run builtin-regression.run ${JSON.stringify({ dv: dep, ivs })}`]);
}

/** T-TEST GROUPS=g(1 2) /VARIABLES=x  |  PAIRS=x WITH y  |  /TESTVAL=n /VARIABLES=x */
function transTtest(text) {
  const grp = text.match(/groups\s*=\s*([A-Za-z_][\w.]*)/i);
  if (grp) {
    const v = (subVarlist(text, 'VARIABLES') || [])[0];
    if (!v) return skip(text, 't-test (no test variable)');
    return ok([`run builtin-compare.independent ${JSON.stringify({ y: v, g: grp[1] })}`]);
  }
  const pairs = text.match(/pairs\s*=\s*([A-Za-z_][\w.]*)\s+with\s+([A-Za-z_][\w.]*)/i);
  if (pairs) return ok([`run builtin-compare.paired ${JSON.stringify({ x1: pairs[1], x2: pairs[2] })}`]);
  const tv = text.match(/testval\s*=\s*(-?\d+(?:\.\d+)?)/i);
  if (tv) {
    const v = (subVarlist(text, 'VARIABLES') || [])[0];
    if (!v) return skip(text, 't-test (no test variable)');
    return ok([`run builtin-compare.oneSample ${JSON.stringify({ x: v, mu: Number(tv[1]) })}`]);
  }
  return skip(text, 't-test (unsupported form)');
}

/** ONEWAY y BY g */
function transOneway(text) {
  const body = text.replace(/^oneway\s*/i, '');
  const by = body.split(/\s+by\s+/i);
  if (by.length < 2) return skip(text, 'oneway (need y BY g)');
  const y = by[0].trim().split(/\s+/)[0];
  const g = by[1].trim().split(/\s+/)[0];
  if (!y || !g) return skip(text, 'oneway (could not parse)');
  return ok([`run builtin-compare.oneway ${JSON.stringify({ y, g })}`]);
}

// =============================================================================
// Expression translation: SPSS → DuckDB SQL
// =============================================================================

export function spssExpr(input) {
  let s = ` ${String(input ?? '').trim()} `;
  // strings: double → single-quoted (DuckDB); leave single quotes as-is
  s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner) => `'${inner.replace(/'/g, "''")}'`);
  // missing tests
  s = s.replace(/\b(sysmis|missing)\s*\(\s*([A-Za-z_][\w.]*)\s*\)/gi, '($2 IS NULL)');
  s = s.replace(/\$sysmis\b/gi, 'NULL');
  // symbolic → SQL operators
  s = s.replace(/~=/g, ' <> ').replace(/~/g, ' NOT ');
  s = s.replace(/&/g, ' AND ').replace(/\|/g, ' OR ');
  // keyword operators (word-boundaried, case-insensitive)
  s = s.replace(/\bEQ\b/gi, '=').replace(/\bNE\b/gi, '<>')
    .replace(/\bLE\b/gi, '<=').replace(/\bGE\b/gi, '>=')
    .replace(/\bLT\b/gi, '<').replace(/\bGT\b/gi, '>');
  // functions that differ
  s = s.replace(/\bLG10\s*\(/gi, 'log10(').replace(/\bRND\s*\(/gi, 'round(').replace(/\bTRUNC\s*\(/gi, 'trunc(');
  return s.replace(/\s+/g, ' ').trim();
}

// =============================================================================
// small helpers
// =============================================================================

function ok(lines) { return { lines, ok: true }; }
function skip(text, why) { return { lines: [comment(`[SPSS, not translated${why ? `: ${why}` : ''}]: ${text}`)], ok: false }; }
function note(text, msg) { return { lines: [comment(`[SPSS] ${text}  → ${msg}`)], ok: true }; }
function comment(t) { return `# ${t}`; }

function firstWord(text) {
  const m = String(text).match(/^\s*([A-Za-z][\w-]*)/);
  return m ? m[1] : '';
}

/** A `/NAME=` (or `NAME=`) subcommand's value tokens as a varlist, up to the next `/`. */
function subVarlist(text, name) {
  const re = new RegExp(`(?:/|\\b)${name}\\s*=\\s*([^/]*)`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim().split(/[\s,]+/).filter((v) => v && /^[A-Za-z_]/.test(v));
}

/** The varlist right after the command word (e.g. `FREQUENCIES q1 q2`), pre-`/`. */
function bareVarlist(text) {
  const body = text.replace(/^\s*[A-Za-z][\w-]*\s*/, '').split('/')[0];
  return body.split(/[\s,]+/).filter((v) => v && /^[A-Za-z_]/.test(v));
}

/** A recode/label VALUE: bare if numeric, else a quoted string. */
function recodeVal(s) {
  const t = String(s).trim().replace(/^["']|["']$/g, '');
  if (t !== '' && Number.isFinite(Number(t))) return t;
  return `"${t.replace(/"/g, '\\"')}"`;
}

function num(n) {
  return Number.isFinite(Number(n)) ? String(Number(n)) : '0';
}

/** Bare identifier, or backtick-quoted if it has spaces/punctuation. */
function ident(name) {
  const s = String(name ?? '');
  return /^[A-Za-z_][\w.]*$/.test(s) ? s : '`' + s.replace(/`/g, '\\`') + '`';
}
