/**
 * @file demo-data.js
 * A small, synthetic dataset used to bring up the app before file import exists.
 *
 * TEMPORARY: this exists only so the engine and the first plugin can be proven
 * end-to-end (run a frequency table, fit an `lm()`) without an importer. It will
 * be deleted once CSV/.sav import lands. The shape it returns is exactly what
 * {@link DataStore#setDataset} expects, so it doubles as a worked example of the
 * dataset format (columnar values + Haven/SPSS-style variable metadata).
 *
 * The data is fabricated (no real respondents). Values are chosen so that a few
 * relationships exist — income rises with education and age — making `lm()`
 * output non-trivial.
 */

/**
 * @returns {{ variables: import('./data-store.js').VariableMeta[],
 *             columns: Object<string, Array> }}
 */
export function makeDemoDataset() {
  // 30 fabricated cases. Columns are parallel arrays (columnar form).
  const gender = [1, 2, 1, 2, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 1, 2, 1, 2, 1, 2, 2, 1, 2, 1];
  const education = [3, 2, 1, 3, 2, 2, 1, 3, 2, 1, 3, 3, 2, 1, 2, 3, 1, 2, 3, 2, 1, 3, 2, 2, 1, 3, 2, 1, 3, 2];
  const region = [1, 1, 2, 3, 2, 1, 3, 2, 1, 3, 2, 1, 3, 2, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1];
  const age = [45, 33, 28, 52, 41, 39, 25, 58, 36, 29, 49, 61, 44, 31, 38, 55, 27, 42, 50, 35, 30, 57, 40, 43, 26, 60, 37, 32, 53, 34];

  // Income loosely follows education and age, with noise, in thousands.
  const income = age.map((a, i) => {
    const base = 18 + education[i] * 9 + (a - 25) * 0.6;
    const noise = ((i * 37) % 11) - 5; // deterministic pseudo-noise, no RNG
    return Math.round((base + noise) * 1000);
  });
  // Seed a couple of user-defined missing codes to exercise metadata handling.
  income[7] = -99;
  income[19] = -99;

  /** @type {import('./data-store.js').VariableMeta[]} */
  const variables = [
    {
      name: 'gender',
      label: 'Respondent gender',
      type: 'factor',
      valueLabels: { 1: 'Male', 2: 'Female' },
      measurementLevel: 'nominal',
    },
    {
      name: 'education',
      label: 'Highest education level',
      type: 'factor',
      valueLabels: { 1: 'High school', 2: 'Bachelor', 3: 'Postgraduate' },
      measurementLevel: 'ordinal',
    },
    {
      name: 'region',
      label: 'Region of residence',
      type: 'factor',
      valueLabels: { 1: 'North', 2: 'Central', 3: 'South' },
      measurementLevel: 'nominal',
    },
    {
      name: 'age',
      label: 'Age in years',
      type: 'numeric',
      measurementLevel: 'scale',
    },
    {
      name: 'income',
      label: 'Annual income (USD)',
      type: 'numeric',
      missingValues: [-99, -98],
      measurementLevel: 'scale',
    },
  ];

  return {
    variables,
    columns: { gender, education, region, age, income },
  };
}

/**
 * A tiny qualitative demo: open-ended responses + a group, so the Text analytics
 * tools (word frequency, sentiment, TF-IDF, KWIC) have something to chew on out
 * of the box. Fabricated.
 * @returns {{ variables: import('./data-store.js').VariableMeta[], columns: Object<string, Array> }}
 */
export function makeQualDemoDataset() {
  const response = [
    'The staff were wonderful, kind and genuinely helpful throughout my visit.',
    'Terrible experience — the waiting was awful and the room felt cold and unwelcoming.',
    'A warm, friendly team made a difficult process feel easy and reassuring.',
    'Service was slow and disappointing; I left frustrated and unheard.',
    'Clean, well organised, and the people clearly cared about doing good work.',
    'Rude reception and a long, confusing wait. Would not recommend to anyone.',
    'I felt respected and listened to — a genuinely positive, supportive visit.',
    'Disorganised and stressful. Nobody seemed to know what was going on.',
    'Friendly, patient, and thorough. Easily the best experience I have had here.',
    'Cold, impersonal, and far too rushed. It left a bad impression.',
    'Helpful staff and a calm atmosphere made everything straightforward.',
    'Frustrating from start to finish; poor communication and little empathy.',
  ];
  const site = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  const variables = [
    { name: 'response', label: 'Open-ended feedback', type: 'string', measurementLevel: 'nominal' },
    { name: 'site', label: 'Location', type: 'factor', valueLabels: { 1: 'Clinic', 2: 'Call centre' }, measurementLevel: 'nominal' },
  ];
  return { variables, columns: { response, site } };
}

/** An empty starter dataset (one placeholder column) for "Start blank" — the user
 * imports their own data. Kept minimal so the grid renders without erroring. */
export function makeBlankDataset() {
  return {
    variables: [{ name: 'v1', label: '', type: 'numeric', measurementLevel: 'scale' }],
    columns: { v1: [] },
  };
}
