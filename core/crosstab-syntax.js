/**
 * @file crosstab-syntax.js
 * CrossTab's native command syntax — the textual form of the script (#133/#134).
 *
 * This is the canonical, **lossless, bidirectional** serialization of the operation
 * timeline: the data-store's log (loads/transforms) plus the analysis log. Unlike
 * the R-syntax export (which *translates* CrossTab's stored DuckDB expressions into
 * R — one-way and lossy), this keeps each expression **verbatim**, so `serialize`
 * then `parse` round-trips exactly. That's what lets the Syntax-mode editor treat
 * the text as an editable view of the real pipeline.
 *
 * Pure module — no DOM, no app deps. `serialize` returns a string; `parse` returns
 * `{ transforms, analyses, errors }`.
 *
 * ## The grammar (one statement per line; `#` starts a comment; blank lines ignored)
 *   Data sources (READ-ONLY anchors — data isn't embedded in text, so these are
 *   emitted as comments and ignored on parse; edit them via File ▸ import / History):
 *     # use "Label"        # append "Label"        # join "Label" on key
 *     # edit row N: col = value          (a manual cell override)
 *   Editable data transforms:
 *     compute NAME [as TYPE] = EXPR            (EXPR is a DuckDB scalar expression)
 *     recode SRC into NAME [as TYPE]: RULE; RULE; …; else TO
 *         RULE := VALUE -> TO | LO..HI -> TO | missing -> TO
 *         TO   := VALUE | copy | sysmis
 *     keep if EXPR                             (row filter; EXPR is DuckDB boolean)
 *     drop VAR1, VAR2 …                        (remove columns from the view)
 *     keep VAR1, VAR2 …                        (keep only these columns)
 *     rename OLD to NEW                        (rename a column)
 *     label variable NAME "Text"
 *     label values NAME code "Label", code "Label", …
 *     set type NAME = numeric|string|factor
 *     set measure NAME = nominal|ordinal|scale
 *     set missing NAME = v1, v2   (or `none`)
 *   Analyses:
 *     run pluginId.fn {json-inputs}            # Label
 *
 * NAME/SRC are bare identifiers, or backtick-quoted if they contain spaces/punct.
 * String VALUEs are double-quoted; numbers are bare.
 */

const TYPES = new Set(['numeric', 'string', 'factor']);
const MEASURES = new Set(['nominal', 'ordinal', 'scale']);
/** Op types that count as a "data transform" (what getTransforms returns) — used to
 * position analyses in the timeline by how many transforms preceded them. */
const TRANSFORM_TYPES = new Set(['setVariable', 'setCell', 'computeVar', 'recodeVar', 'filterCases', 'dropVars', 'keepVars', 'renameVar']);

// =============================================================================
// SERIALIZE  (timeline → text)
// =============================================================================

/**
 * @param {object[]} applied - the data-store log (history.applied).
 * @param {import('./analysis-log.js').AnalysisEntry[]} [analyses] - analysis log entries.
 * @returns {string}
 */
export function serialize(applied, analyses = []) {
  const lines = ['# CrossTab syntax — edit and Run to rebuild. Lines starting with # are comments.', ''];

  // Place each analysis at the data position it was run at (`at` = number of data
  // transforms applied then), so the script shows — and Run reproduces — its output
  // against the data AS OF that point, not the final dataset.
  const byAt = new Map();
  for (const a of analyses || []) {
    const k = Number.isFinite(a.at) ? a.at : Infinity;
    if (!byAt.has(k)) byAt.set(k, []);
    byAt.get(k).push(a);
  }
  const flush = (k) => {
    for (const a of byAt.get(k) || []) lines.push(analysisToLine(a));
    byAt.delete(k);
  };

  let tcount = 0;
  let flushedZero = false;
  const flushZeroOnce = () => { if (!flushedZero) { flush(0); flushedZero = true; } };
  for (const op of applied || []) {
    const isT = TRANSFORM_TYPES.has(op.type);
    if (isT) flushZeroOnce(); // analyses run before any transform sit after the sources
    const out = opToLines(op);
    if (out) for (const l of out) lines.push(l);
    if (isT) { tcount++; flush(tcount); }
  }
  flushZeroOnce(); // (no transforms at all)
  // Any analyses whose recorded position is past the last transform (or unpositioned)
  // go at the end, in ascending order.
  for (const k of [...byAt.keys()].sort((a, b) => a - b)) flush(k);

  return lines.join('\n') + '\n';
}

/**
 * The ordered, interleaved timeline used by the aligned Syntax grid (#134): one row
 * per data op (in log order) with analyses spliced in at their `at` position — the
 * same ordering {@link serialize} produces, but as structured rows so the UI can put
 * each step's text on the same line as its GUI step.
 *
 * @param {object[]} applied - the data-store log (history.applied).
 * @param {import('./analysis-log.js').AnalysisEntry[]} [analyses]
 * @returns {Array<{kind:'transform'|'source'|'analysis', op?:object, entry?:object, text:string, editable:boolean}>}
 */
export function timeline(applied, analyses = []) {
  const byAt = new Map();
  for (const a of analyses || []) {
    const k = Number.isFinite(a.at) ? a.at : Infinity;
    if (!byAt.has(k)) byAt.set(k, []);
    byAt.get(k).push(a);
  }
  const rows = [];
  const pushAnalyses = (k) => {
    for (const a of byAt.get(k) || []) rows.push({ kind: 'analysis', entry: a, text: analysisToLine(a), editable: true });
    byAt.delete(k);
  };
  let tcount = 0;
  let flushedZero = false;
  const flushZero = () => { if (!flushedZero) { pushAnalyses(0); flushedZero = true; } };
  for (const op of applied || []) {
    const isT = TRANSFORM_TYPES.has(op.type);
    if (isT) flushZero();
    const lines = opToLines(op) || [];
    // Every data transform — including a cell edit — is editable as text; only the
    // data sources (load/append/join) are read-only (you can't re-type the data).
    const editable = isT;
    rows.push({ kind: editable ? 'transform' : 'source', op, text: lines.join('\n'), editable });
    if (isT) { tcount += 1; pushAnalyses(tcount); }
  }
  flushZero();
  for (const k of [...byAt.keys()].sort((a, b) => a - b)) pushAnalyses(k);
  return rows;
}

function opToLines(op) {
  switch (op.type) {
    case 'load':
      return [`# use ${str(srcLabel(op))}`];
    case 'append':
      return [`# append ${str(srcLabel(op))}`];
    case 'join':
      return [`# join ${str(srcLabel(op))}${op.joinKey ? ` on ${ident(String(op.joinKey))}` : ''}`];
    case 'setCell':
      return [`set cell row ${op.row != null ? op.row + 1 : 1} ${ident(op.column)} = ${val(op.value)}`];
    case 'computeVar':
      return [`compute ${ident(op.name)}${typeSuffix(op.varType)} = ${op.expr}`];
    case 'filterCases':
      return [`keep if ${op.expr}`];
    case 'dropVars':
      return [`drop ${(op.names || []).map(ident).join(', ')}`];
    case 'keepVars':
      return [`keep ${(op.names || []).map(ident).join(', ')}`];
    case 'renameVar':
      return [`rename ${ident(op.from)} to ${ident(op.to)}`];
    case 'recodeVar':
      return [recodeToLine(op)];
    case 'setVariable':
      return setVarToLines(op);
    default:
      return null; // unknown op kind: skip (kept in the live log, not shown)
  }
}

function srcLabel(op) {
  return op.src?.label || op.src?.table || 'data';
}

function typeSuffix(varType) {
  return varType && varType !== 'numeric' ? ` as ${varType}` : '';
}

function recodeToLine(op) {
  const parts = [];
  for (const r of op.rules || []) {
    if (r.from === 'missing') parts.push(`missing -> ${toStr(r.to)}`);
    else if (r.from === 'range') parts.push(`${num(r.lo)}..${num(r.hi)} -> ${toStr(r.to)}`);
    else parts.push(`${val(r.value)} -> ${toStr(r.to)}`);
  }
  parts.push(`else ${toStr(op.elseRule || { kind: 'copy' })}`);
  return `recode ${ident(op.source)} into ${ident(op.name)}${typeSuffix(op.varType)}: ${parts.join('; ')}`;
}

function toStr(to) {
  if (!to || to.kind === 'copy') return 'copy';
  if (to.kind === 'sysmis') return 'sysmis';
  return val(to.value);
}

function setVarToLines(op) {
  const name = ident(op.name);
  const p = op.patch || {};
  const out = [];
  if ('type' in p && TYPES.has(p.type)) out.push(`set type ${name} = ${p.type}`);
  if ('measurementLevel' in p && MEASURES.has(p.measurementLevel)) out.push(`set measure ${name} = ${p.measurementLevel}`);
  if ('missingValues' in p) {
    const mv = p.missingValues;
    out.push(`set missing ${name} = ${mv && mv.length ? mv.map(val).join(', ') : 'none'}`);
  }
  if ('valueLabels' in p && p.valueLabels) {
    const pairs = Object.entries(p.valueLabels).map(([code, lbl]) => `${val(code)} ${str(lbl)}`);
    if (pairs.length) out.push(`label values ${name} ${pairs.join(', ')}`);
  }
  if ('label' in p) out.push(`label variable ${name} ${str(p.label ?? '')}`);
  return out.length ? out : [`# (no-op metadata edit on ${op.name})`];
}

function analysisToLine(a) {
  // Host actions (e.g. "Run R script", #137) aren't native CrossTab commands — they
  // run R, not the declarative grammar — so they can't round-trip as `run id.fn`.
  // Emit a comment so the script stays valid and notes the step; the R step itself
  // lives in History/Output and is preserved across a Run (see replayScript).
  if (a.host) return `# ${stripEllipsis(a.label || 'R script')} — R script (Transform ▸ Run R script; not editable here)`;
  const json = JSON.stringify(a.inputs ?? {});
  const label = a.label ? `   # ${stripEllipsis(a.label)}` : '';
  return `run ${a.pluginId}.${a.run} ${json}${label}`;
}

// --- value/identifier formatting ---

/** A bare identifier, or backtick-quoted if it has spaces/punctuation. */
function ident(name) {
  const s = String(name ?? '');
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) ? s : '`' + s.replace(/`/g, '\\`') + '`';
}

/** A double-quoted string literal. */
function str(s) {
  return '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** A recode/cell VALUE: bare if a finite number, else a quoted string. null → sysmis-ish blank. */
function val(v) {
  if (v == null) return '""';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return v; // numeric-looking code, keep bare
  return str(v);
}

function num(n) {
  return Number.isFinite(Number(n)) ? String(Number(n)) : '0';
}

function stripEllipsis(s) {
  return String(s ?? '').replace(/…\s*$/, '').trim();
}

// =============================================================================
// PARSE  (text → ops)
// =============================================================================

/**
 * @param {string} text
 * @returns {{transforms: object[], analyses: {pluginId:string,run:string,inputs:object}[], errors: {line:number,message:string}[]}}
 */
export function parse(text) {
  const transforms = [];
  const analyses = [];
  const steps = []; // ordered, interleaved: { kind:'transform', op } | { kind:'analysis', ref }
  const errors = [];
  const raw = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = stripComment(raw[i]).trim();
    if (!line) continue;
    try {
      const op = parseLine(line);
      if (!op) continue;
      if (op.__analysis) {
        analyses.push(op.__analysis);
        steps.push({ kind: 'analysis', ref: op.__analysis });
      } else {
        transforms.push(op);
        steps.push({ kind: 'transform', op });
      }
    } catch (err) {
      errors.push({ line: i + 1, message: err.message });
    }
  }
  return { transforms, analyses, steps, errors };
}

/** Strip a trailing ` # comment` (a `#` not inside quotes/backticks). Keeps `#`
 * that appears within a quoted string or a `run … {json}` payload intact. */
function stripComment(s) {
  let inS = false; // "
  let inB = false; // `
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inB) inS = !inS;
    else if (c === '`' && !inS) inB = !inB;
    else if (c === '#' && !inS && !inB) return s.slice(0, i);
  }
  return s;
}

function parseLine(line) {
  // run pluginId.fn {json}
  let m = line.match(/^run\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*(\{.*\})?\s*$/);
  if (m) {
    let inputs = {};
    if (m[3]) {
      try { inputs = JSON.parse(m[3]); } catch { throw new Error(`invalid analysis inputs (not JSON): ${m[3]}`); }
    }
    return { __analysis: { pluginId: m[1], run: m[2], inputs } };
  }

  // compute NAME [as TYPE] = EXPR
  m = line.match(/^compute\s+(.+?)(?:\s+as\s+(numeric|string|factor))?\s*=\s*(.+)$/i);
  if (/^compute\b/i.test(line)) {
    if (!m) throw new Error('compute: expected `compute NAME [as TYPE] = EXPR`');
    return { type: 'computeVar', name: readIdent(m[1].trim()), varType: m[2] || 'numeric', expr: m[3].trim() };
  }

  // keep if EXPR
  if (/^keep\s+if\b/i.test(line)) {
    const expr = line.replace(/^keep\s+if\b/i, '').trim();
    if (!expr) throw new Error('keep if: expected a condition');
    return { type: 'filterCases', expr, label: expr };
  }

  // keep VAR1, VAR2 …  (column keep — distinct from `keep if`)
  if (/^keep\b/i.test(line)) {
    const names = parseIdentList(line.replace(/^keep\b/i, ''));
    if (!names.length) throw new Error('keep: expected `keep if EXPR` or `keep VAR1, VAR2 …`');
    return { type: 'keepVars', names };
  }

  // drop VAR1, VAR2 …  (column drop). `drop if` isn't a thing here — use keep if NOT(…).
  if (/^drop\s+if\b/i.test(line)) throw new Error('drop if isn’t supported — use `keep if NOT (…)` for a row filter');
  if (/^drop\b/i.test(line)) {
    const names = parseIdentList(line.replace(/^drop\b/i, ''));
    if (!names.length) throw new Error('drop: expected `drop VAR1, VAR2 …`');
    return { type: 'dropVars', names };
  }

  // rename OLD to NEW
  if (/^rename\b/i.test(line)) {
    const m = line.match(/^rename\s+(.+?)\s+to\s+(.+)$/i);
    if (!m) throw new Error('rename: expected `rename OLD to NEW`');
    return { type: 'renameVar', from: readIdent(m[1].trim()), to: readIdent(m[2].trim()) };
  }

  // recode SRC into NAME [as TYPE]: RULES
  if (/^recode\b/i.test(line)) return parseRecode(line);

  // label variable NAME "Text"
  m = line.match(/^label\s+variable\s+(.+?)\s+("(?:[^"\\]|\\.)*")\s*$/i);
  if (m) return setVar(readIdent(m[1].trim()), { label: readStr(m[2]) });

  // label values NAME code "Label", …
  if (/^label\s+values\b/i.test(line)) return parseLabelValues(line);

  // set cell row N COL = VALUE
  if (/^set\s+cell\b/i.test(line)) return parseSetCell(line);

  // set type|measure|missing NAME = …
  if (/^set\s+(type|measure|missing)\b/i.test(line)) return parseSet(line);

  throw new Error(`unrecognised command: ${line.split(/\s+/)[0]}`);
}

function parseRecode(line) {
  const m = line.match(/^recode\s+(.+?)\s+into\s+(.+?)(?:\s+as\s+(numeric|string|factor))?\s*:\s*(.+)$/i);
  if (!m) throw new Error('recode: expected `recode SRC into NAME[ as TYPE]: rules`');
  const source = readIdent(m[1].trim());
  const name = readIdent(m[2].trim());
  const varType = m[3] || 'numeric';
  const segs = splitTop(m[4], ';').map((s) => s.trim()).filter(Boolean);
  const rules = [];
  let elseRule = { kind: 'copy' };
  for (const seg of segs) {
    const em = seg.match(/^else\s+(.+)$/i);
    if (em) { elseRule = readTo(em[1].trim()); continue; }
    const am = seg.match(/^(.+?)->(.+)$/);
    if (!am) throw new Error(`recode rule: expected \`X -> Y\` in "${seg}"`);
    const lhs = am[1].trim();
    const to = readTo(am[2].trim());
    if (/^missing$/i.test(lhs)) rules.push({ from: 'missing', to });
    else if (/\.\./.test(lhs)) {
      const [lo, hi] = lhs.split('..');
      rules.push({ from: 'range', lo: Number(lo), hi: Number(hi), to });
    } else rules.push({ from: 'value', value: readVal(lhs), to });
  }
  return { type: 'recodeVar', name, source, varType, rules, elseRule };
}

function readTo(s) {
  if (/^copy$/i.test(s)) return { kind: 'copy' };
  if (/^sysmis$/i.test(s)) return { kind: 'sysmis' };
  return { kind: 'value', value: readVal(s) };
}

function parseLabelValues(line) {
  const rest = line.replace(/^label\s+values\s+/i, '');
  // first token is the NAME (bare or backticked), the remainder is `code "lbl", …`
  const { value: name, rest: after } = takeIdent(rest);
  const labels = {};
  for (const pair of splitTop(after, ',')) {
    const t = pair.trim();
    if (!t) continue;
    const pm = t.match(/^(.+?)\s+("(?:[^"\\]|\\.)*")$/);
    if (!pm) throw new Error(`label values: expected \`code "label"\` in "${t}"`);
    labels[String(readVal(pm[1].trim()))] = readStr(pm[2]);
  }
  return setVar(name, { valueLabels: labels });
}

function parseSetCell(line) {
  const m = line.match(/^set\s+cell\s+row\s+(\d+)\s+([\s\S]+)$/i);
  if (!m) throw new Error('set cell: expected `set cell row N COLUMN = VALUE`');
  const row = parseInt(m[1], 10) - 1; // shown 1-based; stored 0-based
  const { value: column, rest } = takeIdent(m[2]);
  const em = rest.match(/^\s*=\s*([\s\S]+)$/);
  if (!em) throw new Error('set cell: expected `= VALUE` after the column');
  // rid is resolved at apply time (reuse the existing edit's id, or look it up by
  // row) — the text only carries the display row.
  return { type: 'setCell', row: row < 0 ? 0 : row, column, value: readVal(em[1].trim()) };
}

function parseSet(line) {
  const m = line.match(/^set\s+(type|measure|missing)\s+(.+?)\s*=\s*(.+)$/i);
  if (!m) throw new Error('set: expected `set type|measure|missing NAME = value`');
  const kind = m[1].toLowerCase();
  const name = readIdent(m[2].trim());
  const rhs = m[3].trim();
  if (kind === 'type') {
    if (!TYPES.has(rhs)) throw new Error(`set type: expected numeric|string|factor, got "${rhs}"`);
    return setVar(name, { type: rhs });
  }
  if (kind === 'measure') {
    if (!MEASURES.has(rhs)) throw new Error(`set measure: expected nominal|ordinal|scale, got "${rhs}"`);
    return setVar(name, { measurementLevel: rhs });
  }
  // missing
  const mv = /^none$/i.test(rhs) ? [] : splitTop(rhs, ',').map((s) => readVal(s.trim()));
  return setVar(name, { missingValues: mv });
}

function setVar(name, patch) {
  return { type: 'setVariable', name, patch };
}

// --- parsing helpers ---

/** Read a single identifier that should be the WHOLE token (bare or `backticked`). */
function readIdent(s) {
  const { value, rest } = takeIdent(s);
  if (rest.trim()) throw new Error(`unexpected text after name: "${rest.trim()}"`);
  return value;
}

/** Take a leading identifier (bare or backtick-quoted) off `s`; return {value, rest}. */
function takeIdent(s) {
  s = s.trim();
  if (s[0] === '`') {
    let out = '';
    let i = 1;
    for (; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
      if (s[i] === '`') { i++; break; }
      out += s[i];
    }
    return { value: out, rest: s.slice(i) };
  }
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
  if (!m) throw new Error(`expected a variable name at "${s}"`);
  return { value: m[1], rest: s.slice(m[1].length) };
}

/** Parse a list of identifiers separated by commas and/or whitespace (for
 * `drop`/`keep` varlists — accepts both `a, b` and Stata-style `a b`). */
function parseIdentList(s) {
  const names = [];
  let rest = String(s ?? '').trim();
  while (rest) {
    const taken = takeIdent(rest);
    names.push(taken.value);
    rest = taken.rest.replace(/^[\s,]+/, '');
  }
  return names;
}

/** Read a VALUE token: a double-quoted string, or a bare number/word. Returns a
 * number when it looks numeric, else the string. */
function readVal(s) {
  s = s.trim();
  if (s[0] === '"') return readStr(s);
  if (s !== '' && Number.isFinite(Number(s))) return Number(s);
  return s;
}

/** Decode a double-quoted string literal. */
function readStr(s) {
  s = s.trim();
  if (s[0] !== '"') return s;
  let out = '';
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
    if (s[i] === '"') break;
    out += s[i];
  }
  return out;
}

/** Split `s` on `sep`, but not inside quotes/backticks/parens (so an expression
 * with commas or a quoted label with `;` stays intact). */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let inS = false;
  let inB = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inB) { inS = !inS; cur += c; continue; }
    if (c === '`' && !inS) { inB = !inB; cur += c; continue; }
    if (!inS && !inB) {
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}
