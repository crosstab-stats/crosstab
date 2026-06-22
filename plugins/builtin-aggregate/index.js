/**
 * @file plugins/builtin-aggregate/index.js
 * Built-in plugin: Transform ▸ Aggregate / collapse — summarise rows into one row
 * per group. Pick grouping variable(s), the numeric variable(s) to summarise, and
 * a function (mean / sum / median / min / max / SD / count); the result becomes a
 * new dataset (one row per group, plus an N column).
 *
 * General-purpose data prep (group means, category counts, proportions via the
 * mean of a 0/1 variable). Also the bridge from a repeated cross-section like the
 * GSS to a time series: aggregate a variable **by year** and the collapsed dataset
 * is a yearly series the Time Series tools can read.
 *
 * Pure host-side data work — reads columns with `app.data.getColumns`, aggregates
 * in JS, and emits the result with `app.data.create`. No R involved.
 */

const FUNCS = {
  mean: { label: 'Mean', fn: (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN) },
  sum: { label: 'Sum', fn: (a) => a.reduce((s, x) => s + x, 0) },
  median: {
    label: 'Median',
    fn: (a) => {
      if (!a.length) return NaN;
      const s = [...a].sort((x, y) => x - y);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
  },
  min: { label: 'Minimum', fn: (a) => (a.length ? a.reduce((m, x) => (x < m ? x : m), Infinity) : NaN) },
  max: { label: 'Maximum', fn: (a) => (a.length ? a.reduce((m, x) => (x > m ? x : m), -Infinity) : NaN) },
  sd: {
    label: 'Std. Dev.',
    fn: (a) => {
      if (a.length < 2) return NaN;
      const m = a.reduce((s, x) => s + x, 0) / a.length;
      return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
    },
  },
  count: { label: 'Count', fn: (a) => a.length },
};

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-aggregate',
  name: 'Aggregate',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Transform',
  keywords: ['aggregate', 'collapse', 'group by', 'summarise', 'group means', 'counts', 'pivot'],
  rPackages: [],
  menu: [
    {
      label: 'Aggregate / collapse…',
      run: 'run',
      order: 30,
      inputs: [
        { name: 'groupby', kind: 'variables', label: 'Group by', hint: 'The variable(s) that define the groups; one output row per group.', multiple: true, unique: true },
        { name: 'measures', kind: 'variables', label: 'Summarise (numeric)', hint: 'The numeric variable(s) to summarise within each group.', multiple: true, types: ['numeric'], unique: true },
        {
          name: 'func',
          kind: 'choice',
          label: 'Function',
          hint: 'How to summarise each variable, such as mean or count.',
          options: Object.entries(FUNCS).map(([value, { label }]) => ({ value, label })),
          default: 'mean',
        },
      ],
    },
  ],
};

export async function run(app, { groupby, measures, func }) {
  const gby = asArr(groupby);
  const meas = asArr(measures);
  if (!gby.length || !meas.length) {
    await app.results.appendError('Aggregate needs at least one group-by variable and one variable to summarise.');
    return;
  }
  const fn = FUNCS[func] ? func : 'mean';
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const cols = await app.data.getColumns({ variables: [...new Set([...gby, ...meas])] });
  const n = cols[gby[0]]?.length ?? 0;
  if (!n) {
    await app.results.appendError('No data to aggregate.');
    return;
  }

  // Build groups, skipping rows whose group key is missing.
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const keyVals = gby.map((g) => cols[g][i]);
    if (keyVals.some((v) => v == null || (typeof v === 'number' && Number.isNaN(v)))) continue;
    const key = keyVals.map((v) => String(v)).join('');
    let grp = groups.get(key);
    if (!grp) {
      grp = { keyVals, idx: [] };
      groups.set(key, grp);
    }
    grp.idx.push(i);
  }
  // Sort groups by key (numeric-aware) — so e.g. a year group-by comes out in order.
  const sorted = [...groups.values()].sort((a, b) => cmpKeys(a.keyVals, b.keyVals));

  const aggFn = FUNCS[fn].fn;
  const countName = uniqueName('N', [...gby, ...meas.map((m) => `${fn}_${m}`)]);
  const out = {};
  gby.forEach((g, gi) => (out[g] = sorted.map((grp) => grp.keyVals[gi])));
  for (const mv of meas) {
    out[`${fn}_${mv}`] = sorted.map((grp) => {
      const vals = grp.idx.map((i) => cols[mv][i]).filter((v) => v != null && !Number.isNaN(v));
      const r = aggFn(vals);
      return Number.isFinite(r) ? r : null;
    });
  }
  out[countName] = sorted.map((grp) => grp.idx.length);

  const fLabel = FUNCS[fn].label;
  const variables = [
    ...gby.map((g) => {
      const m = meta.get(g) || {};
      return { name: g, type: m.type || 'numeric', label: m.label || g, valueLabels: m.valueLabels, measurementLevel: m.measurementLevel };
    }),
    ...meas.map((mv) => ({ name: `${fn}_${mv}`, type: 'numeric', measurementLevel: 'scale', label: `${fLabel} of ${meta.get(mv)?.label || mv}` })),
    { name: countName, type: 'numeric', measurementLevel: 'scale', label: 'N (rows per group)' },
  ];

  const labelList = (names) => names.map((nm) => meta.get(nm)?.label || nm).join(', ');
  const dsName = `${fLabel} of ${labelList(meas)} by ${labelList(gby)}`.slice(0, 80);
  await app.data.create({ name: dsName, variables, columns: out });

  await app.results.appendText(
    `Aggregated into **${dsName}** — ${sorted.length} group${sorted.length === 1 ? '' : 's'} ` +
      `(one row per ${gby.map((g) => meta.get(g)?.label || g).join(' × ')}). It's now the active dataset.`,
  );
}

// --- helpers -----------------------------------------------------------------

function asArr(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}
/** Compare two group-key tuples position by position, numerically when both are
 * numbers, else lexicographically. */
function cmpKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
/** A name not already taken by a group/measure column. */
function uniqueName(base, taken) {
  if (!taken.includes(base)) return base;
  let i = 1;
  while (taken.includes(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
