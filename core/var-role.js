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
/**
 * The MISSING column's text: designated missing codes, short enough to read.
 *
 * A GSS year declares codes like −100 … −10 for one variable, and the Variable View was
 * printing all ninety-one of them, so a single row grew taller than the screen and the
 * table looked broken (owner, on an iPhone, 2026-10-07). The cell is a SUMMARY — the
 * editor beside it still holds the exact list — so it can afford to say the same thing in
 * one line.
 *
 * Two things it does that a plain truncation would not:
 *
 *  - **Collapses consecutive runs**, so "−100, −99, … , −10" becomes `-100 to -10`. That is
 *    not just shorter, it is a better description: those codes were almost certainly
 *    declared as a span in the first place, and `splitMissing` enumerated it because small
 *    integer spans are cheaper to compare than a BETWEEN. One line, nothing lost.
 *  - **Includes declared RANGES**, which the column used to omit entirely — a variable whose
 *    missing is `[[-999999, 0]]` showed an empty cell, which reads as "nothing is missing
 *    here" when the opposite is true.
 *
 * @param {number[]} [values] discrete designated codes
 * @param {Array<[number, number]>} [ranges] declared spans, inclusive
 * @param {{max?: number}} [opts] how many groups to show before eliding
 * @returns {string}
 */
export function summariseMissing(values, ranges, { max = 6 } = {}) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const groups = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    // A run only when every step is exactly 1 — "8, 9, 10" is a span, "8, 10, 12" is not.
    while (j + 1 < nums.length && Number.isInteger(nums[j + 1]) && nums[j + 1] === nums[j] + 1) j += 1;
    // Two in a row is not worth a word: "-9, -8" is shorter than "-9 to -8" and clearer.
    if (j - i >= 2) groups.push(`${nums[i]} to ${nums[j]}`);
    else for (let k = i; k <= j; k += 1) groups.push(String(nums[k]));
    i = j + 1;
  }
  // Count the ranges that SURVIVE, not the ones handed in: a dropped [NaN, 0] must not
  // inflate the total, or the cell claims codes it is not showing and cannot show.
  let kept = 0;
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const [lo, hi] = Array.isArray(r) ? r : [];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    groups.push(`${lo} to ${hi}`);
    kept += 1;
  }
  if (!groups.length) return '';
  const shown = groups.slice(0, max);
  const elided = groups.length > max;
  // The count is what keeps the summary honest: it says how much was folded away, so a
  // short cell never implies a short list.
  const total = nums.length + kept;
  const folded = elided || groups.length < total;
  return shown.join(', ')
    + (elided ? ', …' : '')
    + (folded ? ` (${total} code${total === 1 ? '' : 's'})` : '');
}
