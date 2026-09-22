/**
 * @file var-role.js
 * Is this variable categorical? One predicate, one answer, one place (#188).
 *
 * ## Why this file exists
 *
 * `type` was being asked four different questions by four different callers — how is it
 * stored, may it fill a categorical slot, should R dummy-code it, and should the grid
 * print a value label — and `factor` answered *yes* to all four at once. The four
 * answers are not the same variable-by-variable, and the first real complaint was a GSS
 * weight: it carries a value label or two for special codes, the importer typed it
 * `factor` on that basis alone, and it then could not be picked as a weight. Nothing
 * about the data was different; `storageTypes` had it as a number the whole time.
 *
 * So the model here is SPSS's, which CrossTab already half-implements:
 *
 *   - **`type`** is storage — numeric or string (`factor` survives as a legacy spelling).
 *   - **`measurementLevel`** is role — nominal, ordinal or scale.
 *   - **`valueLabels`** is decoration, and is valid on *any* type.
 *
 * ## The rule, and why measure wins
 *
 * When a file states a measurement level, that statement is the author's, about meaning;
 * `type` is at best an inference drawn from the presence of labels. So measure wins:
 *
 *   scale             → not categorical, whatever the type says
 *   nominal / ordinal → categorical, whatever the type says
 *   (neither stated)  → fall back to `type === 'factor' || 'string'`
 *
 * That fallback is load-bearing for compatibility rather than for principle. Every
 * project saved before this existed has factors with no measurement level, and they all
 * keep answering exactly as they did — this predicate changes no existing behaviour by
 * itself. What it changes is that a variable which DOES state its level is now believed.
 */

/**
 * Does this variable fill a categorical role — a grouping variable, a crosstab row, a
 * factor in an ANOVA, a predictor R should dummy-code?
 *
 * @param {{type?: string, measurementLevel?: string}} meta
 * @returns {boolean}
 */
export function isCategorical(meta) {
  if (!meta) return false;
  // A string is categorical whatever anyone says about its measure: there is no
  // arithmetic to do on it, so "scale text" is not a claim we can act on.
  if (meta.type === 'string') return true;
  const ml = meta.measurementLevel;
  if (ml === 'scale') return false;
  if (ml === 'nominal' || ml === 'ordinal') return true;
  return meta.type === 'factor';
}

/**
 * Does this variable carry arithmetic — a weight, an outcome to average, an x-axis?
 *
 * Not simply `!isCategorical`: an ORDINAL variable is legitimately both, which is why
 * nonparametric tests accept one and a mean of it is a judgement call rather than an
 * error. Callers that mean "may I add these up" should ask this; callers that mean "may
 * I group by this" should ask {@link isCategorical}.
 *
 * @param {{type?: string, measurementLevel?: string}} meta
 * @returns {boolean}
 */
export function isQuantitative(meta) {
  if (!meta) return false;
  if (meta.type === 'string') return false; // no arithmetic on text, ever
  if (meta.measurementLevel === 'scale') return true;
  if (meta.measurementLevel === 'nominal') return false;
  if (meta.measurementLevel === 'ordinal') return true; // ranks are numbers
  return meta.type !== 'factor';
}

/**
 * The label to print for a stored code, or null to print the code itself.
 *
 * Deliberately independent of `type`: a value label is a fact about a CODE, not about
 * the variable's storage. Gating this on `factor` is what made a weight's "no answer"
 * marker print as a bare number while the same marker on a nominal variable printed as
 * text.
 *
 * @param {{valueLabels?: Record<string, string>}} meta
 * @param {unknown} code
 * @returns {string|null}
 */
export function labelForValue(meta, code) {
  const vl = meta?.valueLabels;
  if (!vl || code === null || code === undefined) return null;
  const hit = vl[code] ?? vl[String(code)] ?? (Number.isFinite(Number(code)) ? vl[Number(code)] : undefined);
  return hit != null && hit !== '' ? String(hit) : null;
}
