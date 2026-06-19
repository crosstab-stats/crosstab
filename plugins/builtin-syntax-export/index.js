/**
 * @file plugins/builtin-syntax-export/index.js
 * Built-in **export-to-syntax** plugin: File ▸ Export ▸ R syntax.
 *
 * Turns the dataset's **transform log** (the same record the History panel shows)
 * into a runnable R script that reproduces the recodes — the do-file an academic
 * pastes into RStudio or drops in a methods appendix. Reads the log through the
 * `app.data.getTransforms()` surface (the log is exposed to plugins, so this
 * honours "everything is a plugin"), and delivers `.R` bytes via the data-export
 * channel.
 *
 * Scope (v1): the **data-preparation** do-file — sources are emitted as an
 * editable load stub, then each logged metadata transform (retype, designate
 * missing, value labels, relabel) becomes R. It is a best-effort, readable
 * reproduction, not a byte-exact replay of the engine's derive order; analyses
 * (plugin runs) aren't logged yet, so they aren't included.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-syntax-export',
  name: 'R Syntax Export',
  version: '0.1.0',
  apiVersion: '0.1.0',
  rPackages: [],
};

/** @param {object} app */
export async function activate(app) {
  await app.exporters.register({
    id: 'r-syntax',
    label: 'R syntax (.R)…',
    extensions: ['.R'],
    order: 30,
    export: ({ ticket }) => exportSyntax(app, ticket),
  });
}

async function exportSyntax(app, ticket) {
  try {
    const transforms = await app.data.getTransforms();
    const meta = await app.data.getVariableMeta();
    const code = buildRSyntax(transforms, meta);
    await app.exporters.deliver(ticket, {
      filename: 'crosstab-syntax.R',
      mimeType: 'text/plain;charset=utf-8',
      data: code,
    });
  } catch (err) {
    await app.results.appendError(`R syntax export failed: ${err.message}`);
    await app.exporters.deliver(ticket, null);
  }
}

/** Render the transform log as an R script. */
function buildRSyntax(transforms, meta) {
  const L = [];
  L.push('# ---------------------------------------------------------------------------');
  L.push('# CrossTab — data-preparation syntax (R)');
  L.push(`# Generated ${new Date().toLocaleString()}`);
  L.push('#');
  L.push('# Best-effort reproduction of the recodes in the transform log (the steps');
  L.push('# shown in the History panel). Edit the load line to point at your data;');
  L.push('# the recodes below then recreate the working dataset. Analyses are not');
  L.push('# included (they are not logged yet).');
  L.push('# ---------------------------------------------------------------------------');
  L.push('');
  L.push('# 1. Load your data into a data frame called `d`, e.g.:');
  L.push('#    d <- read.csv("your-data.csv", stringsAsFactors = FALSE)');
  L.push('#    d <- haven::read_sav("your-data.sav")   # SPSS');
  L.push('d <- read.csv("your-data.csv", stringsAsFactors = FALSE)');
  L.push('');

  const typeOf = new Map((meta || []).map((m) => [m.name, m.type]));
  const kinds = ['setVariable', 'setCell', 'computeVar', 'recodeVar'];
  const steps = transforms.filter((t) => t && kinds.includes(t.type));
  if (steps.length === 0) {
    L.push('# (No transforms recorded — the dataset is as imported.)');
  } else {
    let n = 0;
    for (const t of steps) {
      n += 1;
      if (t.type === 'setCell') {
        L.push(`# Step ${n}: edit cell — ${t.column}, row ${t.row + 1}`);
        L.push(cellToR(t, typeOf.get(t.column) === 'numeric'));
      } else if (t.type === 'computeVar') {
        L.push(`# Step ${n}: compute ${t.name}`);
        L.push(...computeVarToR(t));
      } else if (t.type === 'recodeVar') {
        L.push(`# Step ${n}: recode ${t.source} → ${t.name}`);
        L.push(...recodeVarToR(t));
      } else if (t.name) {
        L.push(`# Step ${n}: ${t.name}`);
        L.push(...transformToR(t.name, t.patch || {}));
      }
      L.push('');
    }
  }

  // A short metadata reference so the script is self-documenting.
  if (meta && meta.length) {
    L.push('# ---------------------------------------------------------------------------');
    L.push('# Variables (final state): name — label');
    for (const m of meta) L.push(`#   ${m.name}${m.label ? ` — ${m.label}` : ''}`);
  }
  L.push('');
  return L.join('\n');
}

/** R for a computed variable. The expression is a DuckDB scalar expr; double-
 * quoted SQL identifiers become R backticks so `with(d, …)` resolves columns.
 * Arithmetic carries over directly; uncommon SQL functions may need a tweak. */
function computeVarToR(t) {
  return [
    `d[[${rChar(t.name)}]] <- with(d, ${sqlExprToR(t.expr)})`,
    `# (from the expression: ${t.expr} — verify any SQL functions in R)`,
  ];
}

/** R for a recoded variable: initialise from the else-rule, then apply rules in
 * reverse so the first matching rule wins (matching DuckDB's CASE order). */
function recodeVarToR(t) {
  const v = `d[[${rChar(t.name)}]]`;
  const s = `d[[${rChar(t.source)}]]`;
  const isNum = t.varType === 'numeric';
  const out = [];
  out.push(`${v} <- ${recodeToR(t.elseRule || { kind: 'copy' }, s, isNum)}`);
  const rules = t.rules || [];
  const needsNum = rules.some((r) => r.from === 'range');
  if (needsNum) out.push(`.x <- suppressWarnings(as.numeric(as.character(${s})))`);
  for (const r of [...rules].reverse()) {
    let cond;
    if (r.from === 'range') cond = `!is.na(.x) & .x >= ${Number(r.lo)} & .x <= ${Number(r.hi)}`;
    else if (r.from === 'missing') cond = `is.na(${s})`;
    else cond = `!is.na(${s}) & as.character(${s}) == ${rChar(String(r.value ?? ''))}`;
    const to = r.to && r.to.kind === 'copy' ? `${s}[${cond}]` : recodeToR(r.to, s, isNum);
    out.push(`${v}[${cond}] <- ${to}`);
  }
  if (needsNum) out.push('rm(.x)');
  return out;
}

/** R scalar for a recode target used as a whole-column initialiser. */
function recodeToR(to, s, isNum) {
  if (!to || to.kind === 'sysmis') return 'NA';
  if (to.kind === 'copy') return s;
  if (to.value === '' || to.value == null) return 'NA';
  if (isNum) {
    const n = Number(to.value);
    return Number.isFinite(n) ? String(n) : 'NA';
  }
  return rChar(to.value);
}

/** Turn double-quoted SQL identifiers into R backtick names (so column refs in a
 * computed expression resolve under `with(d, …)`); leaves the rest as-is. */
function sqlExprToR(expr) {
  return String(expr).replace(/"((?:[^"]|"")*)"/g, (_, g) => '`' + g.replace(/""/g, '"') + '`');
}

/** R line for one `setCell` override (1-based row; NA for blank). */
function cellToR(t, isNumeric) {
  const v = `d[[${rChar(t.column)}]][${t.row + 1}]`;
  if (t.value === null || t.value === undefined || t.value === '') return `${v} <- NA`;
  if (isNumeric) {
    const num = Number(t.value);
    return `${v} <- ${Number.isFinite(num) ? num : 'NA'}`;
  }
  return `${v} <- ${rChar(t.value)}`;
}

/** R lines for one `setVariable` patch on `name`. */
function transformToR(name, patch) {
  const v = `d[[${rChar(name)}]]`;
  const out = [];

  // Designate user-missing first (on the raw codes, before any type change).
  if ('missingValues' in patch) {
    const mv = patch.missingValues;
    if (mv && mv.length) out.push(`${v}[${v} %in% c(${mv.map(rLit).join(', ')})] <- NA`);
    else out.push(`# cleared user-missing codes on ${name}`);
  }

  // Value labels => a factor with explicit levels/labels (supersedes a plain
  // factor type change). Codes are matched as character.
  const vl = patch.valueLabels;
  const hasLabels = vl && typeof vl === 'object' && Object.keys(vl).length > 0;

  if ('type' in patch && !(hasLabels && patch.type === 'factor')) {
    if (patch.type === 'numeric') out.push(`${v} <- suppressWarnings(as.numeric(as.character(${v})))`);
    else if (patch.type === 'string') out.push(`${v} <- as.character(${v})`);
    else if (patch.type === 'factor') out.push(`${v} <- factor(${v})`);
  }

  if (hasLabels) {
    const codes = Object.keys(vl);
    const labels = codes.map((c) => vl[c]);
    out.push(
      `${v} <- factor(${v}, levels = c(${codes.map(rChar).join(', ')}), labels = c(${labels
        .map(rChar)
        .join(', ')}))`,
    );
  } else if ('valueLabels' in patch) {
    out.push(`# cleared value labels on ${name}`);
  }

  if ('label' in patch) {
    out.push(patch.label ? `attr(${v}, "label") <- ${rChar(patch.label)}` : `attr(${v}, "label") <- NULL`);
  }

  if ('measurementLevel' in patch) {
    out.push(`# measurement level: ${patch.measurementLevel || '(cleared)'} (no base-R equivalent)`);
  }

  if (out.length === 0) out.push(`# (no reproducible change for ${name})`);
  return out;
}

/** An R string literal (double-quoted; non-ASCII via \\u/\\U escapes). */
function rChar(s) {
  let out = '"';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) out += '\\u' + code.toString(16).padStart(4, '0');
    else if (code > 126) {
      out += code > 0xffff ? '\\U' + code.toString(16).padStart(8, '0') : '\\u' + code.toString(16).padStart(4, '0');
    } else out += ch;
  }
  return out + '"';
}

/** An R literal for a missing-code value: numbers bare, everything else quoted. */
function rLit(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : rChar(v);
}
