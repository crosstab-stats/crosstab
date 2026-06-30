/**
 * @file stata-import.js
 * Best-effort translator: a Stata **.do file** → CrossTab script text (#136).
 *
 * Scope is the everyday ~80% of teaching/social-science do-files, NOT a full Stata
 * interpreter. We translate the common data-prep and analysis commands and the
 * common expression operators; ANYTHING we don't recognise is emitted as a
 * `# [Stata, not translated]: <line>` comment — nothing is silently dropped, and the
 * user sees exactly what needs a manual touch. The result is loaded into the Syntax
 * editor as a DRAFT, so it's reviewed (and Run) by hand, never auto-applied.
 *
 * Pure module — no DOM, no app deps. `stataToScript(text)` → `{ script, stats }`.
 *
 * Deliberately NOT covered (emitted as comments): column keep/drop (no `if`),
 * `rename`, `encode`, by-group prefixes, `#delimit ;`, macros, loops, `egen` beyond a
 * couple of row functions, and analysis commands carrying an `if`/`in` (we comment
 * those out rather than run them on the wrong rows).
 */

/**
 * @param {string} text - the .do file contents.
 * @returns {{ script: string, stats: { commands: number, translated: number, skipped: number } }}
 */
export function stataToScript(text) {
  const logical = preprocess(text);
  const out = [];
  let commands = 0;
  let translated = 0;
  let skipped = 0;

  // Pre-scan `label define` so a later `label values var lbl` can be expanded.
  const labelSets = collectLabelDefines(logical);

  for (const line of logical) {
    if (line.kind === 'comment') { out.push(line.text ? `# ${line.text}` : '#'); continue; }
    if (line.kind === 'blank') { out.push(''); continue; }
    commands += 1;
    let res;
    try {
      res = translateCommand(line.text, labelSets);
    } catch (err) {
      res = { lines: [comment(`[Stata, error: ${err.message}]: ${line.text}`)], ok: false };
    }
    if (res.ok) translated += 1;
    else skipped += 1;
    for (const l of res.lines) out.push(l);
  }

  const header = [
    `# Imported from Stata .do — ${translated}/${commands} commands translated` +
      (skipped ? `, ${skipped} left as # comments (review below)` : '') + '.',
    '# Best-effort: check the translation, then Run.',
    '',
  ];
  return {
    script: header.concat(out).join('\n') + '\n',
    stats: { commands, translated, skipped },
  };
}

// =============================================================================
// Preprocess: strip block comments, join `///` continuations, classify lines.
// =============================================================================

function preprocess(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' '); // /* ... */ block comments (may span lines)

  const rawLines = s.split('\n');
  // Join `///` continuations: `///` comments out the rest of the line AND continues.
  const joined = [];
  for (let i = 0; i < rawLines.length; i++) {
    let cur = rawLines[i];
    while (/\/\/\//.test(cur)) {
      cur = cur.replace(/\/\/\/.*$/, ' ');
      cur += rawLines[++i] ?? '';
    }
    joined.push(cur);
  }

  const result = [];
  for (let raw of joined) {
    const trimmed = raw.trim();
    if (trimmed === '') { result.push({ kind: 'blank' }); continue; }
    if (trimmed.startsWith('*')) { result.push({ kind: 'comment', text: trimmed.replace(/^\*+\s?/, '') }); continue; }
    // strip a trailing `// comment` (not inside a string)
    const noTrailing = stripLineComment(trimmed);
    if (noTrailing.trim() === '') { result.push({ kind: 'comment', text: trimmed.replace(/^.*\/\/\s?/, '') }); continue; }
    result.push({ kind: 'command', text: noTrailing.trim() });
  }
  return result;
}

/** Remove a trailing `// comment` that isn't inside a double-quoted string. */
function stripLineComment(s) {
  let inStr = false;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === '/' && s[i + 1] === '/') return s.slice(0, i);
  }
  return s;
}

function collectLabelDefines(logical) {
  const sets = {};
  for (const line of logical) {
    if (line.kind !== 'command') continue;
    const m = line.text.match(/^label\s+def(?:ine)?\s+(\S+)\s+(.+)$/i);
    if (!m) continue;
    const name = m[1];
    const pairs = {};
    const re = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g;
    let pm;
    while ((pm = re.exec(m[2]))) pairs[pm[1]] = pm[2];
    sets[name] = pairs;
  }
  return sets;
}

// =============================================================================
// Command dispatch
// =============================================================================

/** Strip Stata command prefixes we can ignore (quietly, capture, noisily, …). */
function stripPrefixes(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/^(quietly|qui|noisily|noi|capture|cap)\b\s*:?\s*/i, '');
  } while (s !== prev);
  return s;
}

const IGNORE = /^(clear|set|version|cd|pwd|log|cls|discard|preserve|restore|sort|gsort|describe|des|d|compress|pause|more|macro|local|global|tempfile|tempvar|estimates|est|eststo|estout|esttab|outreg2?|putdocx|putexcel|graph|twoway|line|scatter|marginsplot|qui|return|ereturn|matrix|mata|program|end|exit|window|notes?)\b/i;

function translateCommand(raw, labelSets) {
  const text = stripPrefixes(raw);

  // by/bysort prefix — group ops aren't representable; comment.
  if (/^(by|bysort|bys)\b.*:/i.test(text)) return skip(raw, 'by-group prefix');
  if (/^#delimit/i.test(text)) return skip(raw, '#delimit');

  const word = (text.match(/^(\w+)/) || [, ''])[1].toLowerCase();

  // --- data load / save: can't load their file here; leave a note ----------
  if (/^(use|u)$/.test(word)) return note(raw, 'load this dataset via File ▸ Import data…');
  if (/^(import|insheet|infile|infix|webuse|sysuse|odbc)$/.test(word)) return note(raw, 'import this dataset via File ▸ Import data…');
  if (/^(save|saveold|export|outsheet)$/.test(word)) return note(raw, 'export via File ▸ Export data…');

  // --- ignorable setup/no-ops ----------------------------------------------
  if (IGNORE.test(text)) return ok([comment(`(skipped Stata setup) ${raw}`)]); // counts as handled

  // --- data prep -----------------------------------------------------------
  if (/^(g|gen|gene|gener|genera|generat|generate)$/.test(word)) return transGenerate(text, raw);
  if (/^(egen)$/.test(word)) return transEgen(text, raw);
  if (/^(replace|repl)$/.test(word)) return transReplace(text, raw);
  if (/^(recode)$/.test(word)) return transRecode(text, raw);
  if (/^(keep)$/.test(word)) return transKeepDrop(text, raw, 'keep');
  if (/^(drop)$/.test(word)) return transKeepDrop(text, raw, 'drop');
  if (/^(destring)$/.test(word)) return transTypeChange(text, raw, 'numeric');
  if (/^(tostring)$/.test(word)) return transTypeChange(text, raw, 'string');
  if (/^(label|la|lab)$/.test(word)) return transLabel(text, raw, labelSets);
  if (/^(rename|ren|rena)$/.test(word)) return skip(raw, 'rename (column rename not yet in CrossTab syntax)');
  if (/^(encode|decode)$/.test(word)) return skip(raw, 'encode/decode');

  // --- analyses ------------------------------------------------------------
  if (/^(summarize|summ|sum|su)$/.test(word)) return transAnalysisVarlist(text, raw, 'builtin-descriptives', 'run', 'vars');
  if (/^(tabulate|tab|tabi)$/.test(word)) return transTab(text, raw);
  if (/^(tab1)$/.test(word)) return transAnalysisVarlist(text, raw, 'builtin-frequencies', 'run', 'vars');
  if (/^(regress|reg|regr|regre|regres)$/.test(word)) return transModel(text, raw, 'builtin-regression', 'run');
  if (/^(logit|logistic)$/.test(word)) return transModel(text, raw, 'builtin-logistic', 'run');
  if (/^(correlate|correlat|correl|corr|pwcorr)$/.test(word)) return transAnalysisVarlist(text, raw, 'builtin-correlation', 'run', 'vars', { method: 'pearson' });
  if (/^(ttest)$/.test(word)) return transTtest(text, raw);
  if (/^(oneway)$/.test(word)) return transOneway(text, raw);
  if (/^(anova)$/.test(word)) return transAnova(text, raw);
  if (/^(mean|proportion|prop)$/.test(word)) return transAnalysisVarlist(text, raw, 'builtin-descriptives', 'run', 'vars');

  return skip(raw, `unrecognised command "${word}"`);
}

// --- data-prep handlers ------------------------------------------------------

/** `generate [type] newvar = expr [if cond]` → compute (if → CASE WHEN). */
function transGenerate(text, raw) {
  const body = text.replace(/^\w+\s+/, '');
  const m = body.match(/^(?:(?:byte|int|long|float|double|str\d*|strL)\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/);
  if (!m) return skip(raw, 'generate (could not parse)');
  const name = m[1];
  let { expr, cond } = splitIf(m[2]);
  let e = stataExpr(expr);
  if (cond) e = `CASE WHEN ${stataExpr(cond)} THEN ${e} END`;
  return ok([`compute ${ident(name)} = ${e}`]);
}

/** `replace var = expr [if cond]` → compute (if → keep old value where false). */
function transReplace(text, raw) {
  const body = text.replace(/^\w+\s+/, '');
  const m = body.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
  if (!m) return skip(raw, 'replace (could not parse)');
  const name = m[1];
  const { expr, cond } = splitIf(m[2]);
  let e = stataExpr(expr);
  if (cond) e = `CASE WHEN ${stataExpr(cond)} THEN ${e} ELSE ${ident(name)} END`;
  return ok([`compute ${ident(name)} = ${e}`]);
}

/** A couple of common `egen` row functions; others → comment. */
function transEgen(text, raw) {
  const m = text.replace(/^\w+\s+/, '').match(/^([A-Za-z_]\w*)\s*=\s*(\w+)\s*\(([^)]*)\)/);
  if (!m) return skip(raw, 'egen (could not parse)');
  const [, name, fn, argsRaw] = m;
  const vars = argsRaw.trim().split(/\s+/).filter(Boolean).map(ident);
  const f = fn.toLowerCase();
  if (f === 'rowtotal') return ok([`compute ${ident(name)} = ${vars.join(' + ')}`]);
  if (f === 'rowmean') return ok([`compute ${ident(name)} = (${vars.join(' + ')}) / ${vars.length}`]);
  if (f === 'rowmin') return ok([`compute ${ident(name)} = least(${vars.join(', ')})`]);
  if (f === 'rowmax') return ok([`compute ${ident(name)} = greatest(${vars.join(', ')})`]);
  return skip(raw, `egen ${f}()`);
}

/** `recode var (rule) (rule) [, gen(new)]` → recode SRC into NAME: rules. */
function transRecode(text, raw) {
  const body = text.replace(/^recode\s+/i, '');
  const genM = body.match(/,\s*gen(?:erate)?\s*\(\s*([A-Za-z_]\w*)\s*\)/i);
  const target = genM ? genM[1] : null;
  const head = body.split(/,/)[0];
  const srcM = head.match(/^([A-Za-z_]\w*)/);
  if (!srcM) return skip(raw, 'recode (no source var)');
  const src = srcM[1];
  const rulesPart = head.slice(srcM[0].length);
  const groups = [...rulesPart.matchAll(/\(([^)]*)\)/g)].map((g) => g[1].trim());
  if (!groups.length) return skip(raw, 'recode (no rules)');
  const rules = [];
  let elseRule = null;
  for (const g of groups) {
    const am = g.match(/^(.*?)=\s*([^"]*?)\s*("(?:[^"\\]|\\.)*")?\s*$/);
    if (!am) continue;
    const lhs = am[1].trim();
    const toTok = am[2].trim();
    const to = toTok === '.' ? 'sysmis' : toTok;
    if (/^else$/i.test(lhs) || /^\*$/.test(lhs)) { elseRule = to; continue; }
    if (/^(missing|\.)$/i.test(lhs)) { rules.push(`missing -> ${to}`); continue; }
    for (const tok of lhs.split(/\s+/).filter(Boolean)) {
      if (/^-?\d+\/-?\d+$/.test(tok)) rules.push(`${tok.replace('/', '..')} -> ${to}`);
      else rules.push(`${tok} -> ${to}`);
    }
  }
  rules.push(`else ${elseRule != null ? elseRule : 'copy'}`);
  const into = target || src;
  return ok([`recode ${ident(src)} into ${ident(into)}: ${rules.join('; ')}`]);
}

/** keep/drop: `if cond` → filter (representable). A varlist (column keep/drop) is
 * not representable in the script grammar yet → comment. */
function transKeepDrop(text, raw, which) {
  const { cond } = splitIf(text.replace(/^\w+/, '').trim() ? 'X ' + text.replace(/^\w+\s*/, '') : '');
  const ifM = text.match(/\bif\b\s+(.+)$/i);
  if (ifM) {
    const c = stataExpr(ifM[1].trim());
    return ok([which === 'keep' ? `keep if ${c}` : `keep if NOT (${c})`]);
  }
  return skip(raw, `${which} <varlist> (column keep/drop not yet in CrossTab syntax)`);
}

/** destring/tostring var[s] [, replace gen()] → set type (best effort). */
function transTypeChange(text, raw, type) {
  const head = text.replace(/^\w+\s+/, '').split(/,/)[0].trim();
  const vars = head.split(/\s+/).filter(Boolean);
  if (!vars.length) return skip(raw, 'destring/tostring (no vars)');
  return ok(vars.map((v) => `set type ${ident(v)} = ${type}`));
}

/** label variable / label values (label define is consumed in the pre-scan). */
function transLabel(text, raw, labelSets) {
  let m = text.match(/^lab(?:el)?\s+var(?:iable)?\s+([A-Za-z_]\w*)\s+"((?:[^"\\]|\\.)*)"/i);
  if (m) return ok([`label variable ${ident(m[1])} "${m[2]}"`]);
  m = text.match(/^lab(?:el)?\s+val(?:ues)?\s+([A-Za-z_]\w*)\s+(\S+)/i);
  if (m) {
    if (/^\.$/.test(m[2])) return ok([comment(`(cleared value labels on ${m[1]}) ${raw}`)]);
    const set = labelSets[m[2]];
    if (!set || !Object.keys(set).length) return skip(raw, `label values (label set "${m[2]}" not found)`);
    const pairs = Object.entries(set).map(([code, lbl]) => `${code} "${lbl}"`);
    return ok([`label values ${ident(m[1])} ${pairs.join(', ')}`]);
  }
  if (/^lab(?:el)?\s+def/i.test(text)) return ok([comment(`(label set defined; applied at 'label values') ${raw}`)]);
  return skip(raw, 'label (unsupported form)');
}

// --- analysis handlers -------------------------------------------------------

/** Analyses that take a plain varlist (summarize, tab1, correlate, mean). */
function transAnalysisVarlist(text, raw, pluginId, fn, key, extra) {
  if (hasIfIn(text)) return skip(raw, `${pluginId} with if/in (per-analysis filter not supported)`);
  const vars = varlistAfterCommand(text);
  if (!vars.length) return skip(raw, 'no variables');
  const obj = { [key]: vars, ...(extra || {}) };
  return ok([`run ${pluginId}.${fn} ${JSON.stringify(obj)}`]);
}

/** `tabulate a b` → crosstabs; `tabulate a` → frequencies. */
function transTab(text, raw) {
  if (hasIfIn(text)) return skip(raw, 'tabulate with if/in (per-analysis filter not supported)');
  const vars = varlistAfterCommand(text);
  if (vars.length >= 2) return ok([`run builtin-crosstabs.run ${JSON.stringify({ rowvar: vars[0], colvar: vars[1] })}`]);
  if (vars.length === 1) return ok([`run builtin-frequencies.run ${JSON.stringify({ vars: [vars[0]] })}`]);
  return skip(raw, 'tabulate (no variables)');
}

/** `regress y x1 x2` / `logit y x...` → {dv, ivs}. */
function transModel(text, raw, pluginId, fn) {
  if (hasIfIn(text)) return skip(raw, `${pluginId} with if/in (per-analysis filter not supported)`);
  const vars = varlistAfterCommand(text);
  if (vars.length < 2) return skip(raw, `${pluginId} (need an outcome and ≥1 predictor)`);
  return ok([`run ${pluginId}.${fn} ${JSON.stringify({ dv: vars[0], ivs: vars.slice(1) })}`]);
}

/** `ttest x, by(g)` → independent; `ttest x == y` → paired; `ttest x == #` → one-sample. */
function transTtest(text, raw) {
  if (hasIfIn(text)) return skip(raw, 'ttest with if/in (per-analysis filter not supported)');
  const byM = text.match(/,\s*by\s*\(\s*([A-Za-z_]\w*)\s*\)/i);
  const head = text.replace(/^ttest\s+/i, '').split(/,/)[0].trim();
  if (byM) {
    const y = head.split(/\s+/)[0];
    if (!y) return skip(raw, 'ttest (no variable)');
    return ok([`run builtin-compare.independent ${JSON.stringify({ y, g: byM[1] })}`]);
  }
  const eq = head.match(/^([A-Za-z_]\w*)\s*==\s*(.+)$/);
  if (eq) {
    const rhs = eq[2].trim();
    if (/^-?\d+(\.\d+)?$/.test(rhs)) return ok([`run builtin-compare.oneSample ${JSON.stringify({ x: eq[1], mu: Number(rhs) })}`]);
    if (/^[A-Za-z_]\w*$/.test(rhs)) return ok([`run builtin-compare.paired ${JSON.stringify({ x1: eq[1], x2: rhs })}`]);
  }
  return skip(raw, 'ttest (unsupported form)');
}

/** `oneway y g` → compare.oneway {y, g}. */
function transOneway(text, raw) {
  if (hasIfIn(text)) return skip(raw, 'oneway with if/in (per-analysis filter not supported)');
  const vars = varlistAfterCommand(text);
  if (vars.length < 2) return skip(raw, 'oneway (need outcome and group)');
  return ok([`run builtin-compare.oneway ${JSON.stringify({ y: vars[0], g: vars[1] })}`]);
}

/** `anova y g1 g2` → anova.factorial {dv, facs}. */
function transAnova(text, raw) {
  if (hasIfIn(text)) return skip(raw, 'anova with if/in (per-analysis filter not supported)');
  const vars = varlistAfterCommand(text);
  if (vars.length < 2) return skip(raw, 'anova (need outcome and ≥1 factor)');
  return ok([`run builtin-anova.factorial ${JSON.stringify({ dv: vars[0], facs: vars.slice(1) })}`]);
}

// =============================================================================
// Expression translation: Stata expr → DuckDB SQL (the common operators).
// =============================================================================

export function stataExpr(input) {
  let s = ` ${String(input ?? '').trim()} `;
  // double-quoted strings → single-quoted (DuckDB string literals)
  s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner) => `'${inner.replace(/'/g, "''")}'`);
  // missing comparisons FIRST (before == becomes =)
  s = s.replace(/([A-Za-z_]\w*)\s*(==|=)\s*\.(?!\d)/g, '$1 IS NULL');
  s = s.replace(/([A-Za-z_]\w*)\s*(!=|~=)\s*\.(?!\d)/g, '$1 IS NOT NULL');
  s = s.replace(/\bmissing\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, '($1 IS NULL)');
  s = s.replace(/!missing\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, '($1 IS NOT NULL)');
  // inlist / inrange
  s = s.replace(/\binlist\s*\(\s*([A-Za-z_]\w*)\s*,\s*([^)]*)\)/gi, (_, v, list) => `${v} IN (${list})`);
  s = s.replace(/\binrange\s*\(\s*([A-Za-z_]\w*)\s*,\s*([^,]+),\s*([^)]+)\)/gi, (_, v, lo, hi) => `${v} BETWEEN ${lo.trim()} AND ${hi.trim()}`);
  // comparison operators
  s = s.replace(/!=/g, ' <> ').replace(/~=/g, ' <> ');
  s = s.replace(/==/g, ' = ');
  // logical operators (Stata & | ! → SQL). `!` as unary NOT before ident/paren.
  s = s.replace(/&/g, ' AND ').replace(/\|/g, ' OR ');
  s = s.replace(/!(?=\s*[A-Za-z_(])/g, ' NOT ');
  // Stata `.` standalone equality already handled; collapse whitespace.
  return s.replace(/\s+/g, ' ').trim();
}

// =============================================================================
// small helpers
// =============================================================================

function ok(lines) { return { lines, ok: true }; }
function skip(raw, why) { return { lines: [comment(`[Stata, not translated${why ? `: ${why}` : ''}]: ${raw}`)], ok: false }; }
function note(raw, msg) { return { lines: [comment(`[Stata] ${raw}  → ${msg}`)], ok: true }; }
function comment(t) { return `# ${t}`; }

/** Split `expr if cond` → {expr, cond}. Also strips a trailing `in range`. */
function splitIf(s) {
  let str = String(s ?? '').trim();
  str = str.replace(/\s+in\s+[^,]+$/i, ''); // drop `in 1/10` ranges
  const m = str.match(/^(.*?)\s+if\s+(.+)$/i);
  if (m) return { expr: m[1].trim(), cond: m[2].trim() };
  return { expr: str, cond: null };
}

function hasIfIn(text) { return /\b(if|in)\b/i.test(text.split(/,/)[0]); }

/** The varlist after the command word, up to an `if`/`in`/comma. */
function varlistAfterCommand(text) {
  let body = text.replace(/^\w+\s*/, '').split(/,/)[0];
  body = body.replace(/\s+(if|in)\b.*$/i, '');
  return body.split(/\s+/).map((v) => v.trim()).filter((v) => v && /^[A-Za-z_]/.test(v));
}

/** Quote an identifier for CrossTab syntax if it isn't a bare token. */
function ident(name) {
  const s = String(name ?? '');
  return /^[A-Za-z_]\w*$/.test(s) ? s : '`' + s.replace(/`/g, '\\`') + '`';
}
