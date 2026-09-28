/**
 * @file var-ref.js
 * **A variable reference, optionally qualified by the dataset it lives in** (#179).
 *
 * Every plugin input has always passed bare variable NAMES — `{"ivs": ["age", "income"]}` —
 * which works precisely as long as there is one dataset to look them up in. Two open datasets
 * may both have `AGE`, so a reference that can reach across them has to say which one it
 * means.
 *
 * ## The spelling, and why it is this one
 *
 * `dataset:variable`, with the qualifier **optional**:
 *
 *     income              → whatever dataset this analysis is running against
 *     Wave 2:income       → the dataset named "Wave 2"
 *     `Odd:Name`:income   → a dataset whose own name contains a colon
 *
 * A colon cannot appear in a bare identifier in CrossTab syntax (the lexer takes
 * `[A-Za-z_][A-Za-z0-9_.]*`), so every reference ever written stays unambiguous and keeps
 * parsing unchanged. A dot would not have worked: dots are legal *inside* variable names and
 * R/Stata users write them constantly, so `wave2.income` is already a plausible variable.
 *
 * ## One owner
 *
 * This module is the only thing that knows the spelling. The picker writes references with
 * {@link formatVarRef}, the injection layer reads them with {@link parseVarRef}, and the
 * syntax grammar inherits both by passing the strings through untouched. That is deliberate:
 * two copies of a format rule is the shape that produced the diverged plugin tooltip, the
 * "built-in" origin label and the double-counted deploy issues in one week.
 *
 * ## What a qualifier does NOT do
 *
 * It does not imply that row *i* of one dataset corresponds to row *i* of another. The host
 * hands each input exactly its own values and takes no view on whether they are related —
 * see `buildInputAliases` in webr-manager.js for why that is the only honest option.
 */

/** A dataset name needs quoting when a bare one could not be read back. */
function needsQuote(name) {
  return /[`:]/.test(String(name));
}

/**
 * Split a reference into its dataset qualifier (or null) and its variable name.
 *
 * Never throws: an unparseable string is treated as an unqualified name, because these
 * arrive from saved projects and hand-edited scripts and a reference that is merely odd
 * should fail at lookup — where the message can name the variable — rather than here.
 *
 * @param {string} ref
 * @returns {{dataset: string|null, name: string}}
 */
export function parseVarRef(ref) {
  const s = String(ref ?? '');
  if (s.startsWith('`')) {
    const end = s.indexOf('`', 1);
    if (end > 0 && s[end + 1] === ':') {
      return { dataset: s.slice(1, end), name: s.slice(end + 2) };
    }
    return { dataset: null, name: s };
  }
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return { dataset: null, name: s };
  return { dataset: s.slice(0, i), name: s.slice(i + 1) };
}

/**
 * Compose a reference. A null/empty dataset yields a bare name, so the qualifier only ever
 * appears where it carries information — which is what keeps a single-dataset project's
 * recorded inputs and scripts byte-identical to what they were before this existed.
 *
 * @param {string|null|undefined} dataset
 * @param {string} name
 * @returns {string}
 */
export function formatVarRef(dataset, name) {
  const ds = dataset == null ? '' : String(dataset).trim();
  if (!ds) return String(name);
  return `${needsQuote(ds) ? `\`${ds}\`` : ds}:${name}`;
}

/** Just the variable name, qualifier discarded — for a caption or a label. */
export function refName(ref) {
  return parseVarRef(ref).name;
}

/** Just the dataset qualifier, or null. */
export function refDataset(ref) {
  return parseVarRef(ref).dataset;
}

/** Whether any reference in a list reaches outside the analysis's own dataset. */
export function anyQualified(refs) {
  return (Array.isArray(refs) ? refs : [refs]).some((r) => parseVarRef(r).dataset != null);
}

/**
 * Every dataset named across a gathered input set, in first-mention order.
 *
 * `null` stands for "this analysis's own dataset" and is included when any reference is
 * unqualified, so `datasetsNamed(...).length > 1` is exactly the test for "this run spans more
 * than one dataset" — the condition the output has to disclose.
 *
 * **Only VARIABLE inputs are read**, which is why the specs are required rather than optional.
 * A text input is free-form user prose: a chart title like "Results: Wave 2" would otherwise
 * be parsed as a dataset qualifier and invent a dataset that was never mentioned.
 *
 * @param {Object<string, any>} inputs gathered plugin inputs
 * @param {Array<{name: string, kind?: string}>} specs the declared inputs
 * @returns {Array<string|null>}
 */
export function datasetsNamed(inputs, specs) {
  const varNames = new Set(
    (Array.isArray(specs) ? specs : [])
      .filter((sp) => (sp?.kind || 'variables') === 'variables')
      .map((sp) => sp.name),
  );
  const out = [];
  const note = (v) => {
    const { dataset } = parseVarRef(v);
    if (!out.some((d) => d === dataset)) out.push(dataset);
  };
  for (const [key, v] of Object.entries(inputs || {})) {
    if (!varNames.has(key)) continue;
    if (typeof v === 'string') note(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') note(x);
  }
  return out;
}

/**
 * Re-point every reference to `oldName` at `newName`, across one gathered input set (#179).
 *
 * Lives here because this module owns the spelling: a rename that rewrote references by string
 * surgery somewhere else would be the second implementation of the format, and the first one to
 * disagree with the parser wins silently.
 *
 * Only VARIABLE inputs are touched — for the same reason {@link datasetsNamed} requires the
 * specs. Rewriting a text input that happens to contain "Wave 2:" would corrupt a chart title.
 *
 * Matching is case-insensitive because resolution is: a rename that only changes case still has
 * to leave the stored references spelled the way the dataset now is.
 *
 * @param {Object<string, any>} inputs
 * @param {Array<{name: string, kind?: string}>} specs
 * @param {string} oldName @param {string} newName
 * @returns {Object<string, any>|null} a new inputs object, or null if nothing referenced it
 */
export function retargetRefs(inputs, specs, oldName, newName) {
  const from = String(oldName ?? '').trim().toLowerCase();
  const to = String(newName ?? '').trim();
  if (!from || !to) return null;
  const varNames = new Set(
    (Array.isArray(specs) ? specs : [])
      .filter((sp) => (sp?.kind || 'variables') === 'variables')
      .map((sp) => sp.name),
  );
  let touched = false;
  const one = (v) => {
    if (typeof v !== 'string') return v;
    const { dataset, name } = parseVarRef(v);
    if (dataset == null || dataset.trim().toLowerCase() !== from) return v;
    touched = true;
    return formatVarRef(to, name);
  };
  const out = {};
  for (const [key, v] of Object.entries(inputs || {})) {
    if (!varNames.has(key)) { out[key] = v; continue; }
    out[key] = Array.isArray(v) ? v.map(one) : one(v);
  }
  return touched ? out : null;
}
