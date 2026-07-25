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

/**
 * A spatial demo: fabricated survey responses across Sacramento County zip codes
 * and congressional districts, so the Map workspace has something to shade and
 * filter out of the box. Includes numeric outcomes (satisfaction, commute, income)
 * and two geographic keys (zip_code, district) for loading overlapping boundary
 * sets from sample-data/*.geojson.
 * @returns {{ variables: import('./data-store.js').VariableMeta[], columns: Object<string, Array> }}
 */
export function makeSpatialDemoDataset() {
  const zips = ['95814','95816','95817','95819','95822','95823','95826','95828','95833','95834','95841'];
  const zipDistrict = {
    '95814': 'CA-07', '95816': 'CA-07', '95817': 'CA-07', '95819': 'CA-07',
    '95822': 'CA-07', '95823': 'CA-07', '95826': 'CA-07', '95828': 'CA-07',
    '95833': 'CA-06', '95834': 'CA-06', '95841': 'CA-06',
  };
  const N = 60;
  const zip_code = [], district = [], satisfaction = [], commute_min = [], income_k = [], household_size = [];
  for (let i = 0; i < N; i++) {
    const z = zips[((i * 7) + (i >> 2)) % zips.length];
    zip_code.push(z);
    district.push(zipDistrict[z]);
    const base = ((zips.indexOf(z) + 1) * 13 + i * 3) % 10;
    satisfaction.push(Math.min(10, Math.max(1, base + 1)));
    commute_min.push(15 + ((i * 11 + zips.indexOf(z) * 7) % 55));
    const incBase = 38 + zips.indexOf(z) * 6 + ((i * 13) % 30);
    income_k.push(incBase);
    household_size.push(1 + ((i * 3 + zips.indexOf(z)) % 5));
  }
  const variables = [
    { name: 'zip_code', label: 'ZIP code', type: 'string', measurementLevel: 'nominal' },
    { name: 'district', label: 'Congressional district', type: 'string', measurementLevel: 'nominal' },
    { name: 'satisfaction', label: 'Satisfaction (1-10)', type: 'numeric', measurementLevel: 'scale' },
    { name: 'commute_min', label: 'Commute time (minutes)', type: 'numeric', measurementLevel: 'scale' },
    { name: 'income_k', label: 'Household income ($K)', type: 'numeric', measurementLevel: 'scale' },
    { name: 'household_size', label: 'Household size', type: 'numeric', measurementLevel: 'scale' },
  ];
  const boundaries = [
    {
      fileName: 'Sacramento ZIP codes',
      keyProp: 'ZCTA', dataColumn: 'zip_code',
      features: [
        {type:'Feature',properties:{ZCTA:'95814',name:'Downtown'},geometry:{type:'Polygon',coordinates:[[[-121.51,38.575],[-121.49,38.575],[-121.49,38.59],[-121.51,38.59],[-121.51,38.575]]]}},
        {type:'Feature',properties:{ZCTA:'95816',name:'Midtown'},geometry:{type:'Polygon',coordinates:[[[-121.49,38.565],[-121.47,38.565],[-121.47,38.585],[-121.49,38.585],[-121.49,38.565]]]}},
        {type:'Feature',properties:{ZCTA:'95817',name:'Elmhurst / Med Center'},geometry:{type:'Polygon',coordinates:[[[-121.49,38.545],[-121.47,38.545],[-121.47,38.565],[-121.49,38.565],[-121.49,38.545]]]}},
        {type:'Feature',properties:{ZCTA:'95819',name:'East Sacramento'},geometry:{type:'Polygon',coordinates:[[[-121.47,38.555],[-121.44,38.555],[-121.44,38.58],[-121.47,38.58],[-121.47,38.555]]]}},
        {type:'Feature',properties:{ZCTA:'95822',name:'South Sacramento'},geometry:{type:'Polygon',coordinates:[[[-121.52,38.52],[-121.49,38.52],[-121.49,38.545],[-121.52,38.545],[-121.52,38.52]]]}},
        {type:'Feature',properties:{ZCTA:'95823',name:'Parkway / South'},geometry:{type:'Polygon',coordinates:[[[-121.47,38.50],[-121.44,38.50],[-121.44,38.525],[-121.47,38.525],[-121.47,38.50]]]}},
        {type:'Feature',properties:{ZCTA:'95826',name:'College Greens'},geometry:{type:'Polygon',coordinates:[[[-121.44,38.545],[-121.41,38.545],[-121.41,38.57],[-121.44,38.57],[-121.44,38.545]]]}},
        {type:'Feature',properties:{ZCTA:'95828',name:'Vineyard'},geometry:{type:'Polygon',coordinates:[[[-121.44,38.50],[-121.40,38.50],[-121.40,38.53],[-121.44,38.53],[-121.44,38.50]]]}},
        {type:'Feature',properties:{ZCTA:'95833',name:'Natomas'},geometry:{type:'Polygon',coordinates:[[[-121.54,38.60],[-121.50,38.60],[-121.50,38.635],[-121.54,38.635],[-121.54,38.60]]]}},
        {type:'Feature',properties:{ZCTA:'95834',name:'North Natomas'},geometry:{type:'Polygon',coordinates:[[[-121.54,38.635],[-121.49,38.635],[-121.49,38.665],[-121.54,38.665],[-121.54,38.635]]]}},
        {type:'Feature',properties:{ZCTA:'95841',name:'Arden-Arcade'},geometry:{type:'Polygon',coordinates:[[[-121.41,38.58],[-121.37,38.58],[-121.37,38.61],[-121.41,38.61],[-121.41,38.58]]]}},
      ],
    },
    {
      fileName: 'Sacramento congressional districts',
      keyProp: 'district', dataColumn: 'district',
      features: [
        {type:'Feature',properties:{district:'CA-06',representative:'Matsui'},geometry:{type:'Polygon',coordinates:[[[-121.56,38.58],[-121.44,38.58],[-121.37,38.58],[-121.37,38.61],[-121.41,38.635],[-121.44,38.665],[-121.54,38.665],[-121.56,38.635],[-121.56,38.58]]]}},
        {type:'Feature',properties:{district:'CA-07',representative:'Bera'},geometry:{type:'Polygon',coordinates:[[[-121.56,38.49],[-121.37,38.49],[-121.37,38.58],[-121.44,38.58],[-121.56,38.58],[-121.56,38.49]]]}},
      ],
    },
  ];
  return { variables, columns: { zip_code, district, satisfaction, commute_min, income_k, household_size }, boundaries };
}

/** An empty starter dataset (one placeholder column) for "Start blank" — the user
 * imports their own data. Kept minimal so the grid renders without erroring. */
export function makeBlankDataset() {
  return {
    variables: [{ name: 'v1', label: '', type: 'numeric', measurementLevel: 'scale' }],
    columns: { v1: [] },
  };
}
