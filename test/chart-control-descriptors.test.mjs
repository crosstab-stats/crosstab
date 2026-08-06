/**
 * @file chart-control-descriptors.test.mjs
 * Chart control descriptors are DATA, and the host is what reads and writes them.
 *
 * They used to carry `get`/`set`/`visible` closures. Every one turned out to be one of
 * three shapes, so the closures were data wearing a function costume — and a closure can
 * never cross a postMessage boundary, which is precisely what a chart kind living in a
 * plugin has to do. The load-bearing test in this file is the last one: every descriptor
 * every kind produces must survive `structuredClone`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Core ships no chart kinds; the builtin-charts plugin does. Register its real
// kinds locally so these tests drive the shipping code, not a stub.
await import('./chart-kinds-harness.mjs');

const {
  chartUiSpec, defaultView, controlValue, setControlValue, controlVisible, getChartKind,
} = await import('../core/chart-renderer.js');

const KINDS = ['categorical', 'scatter', 'pie', 'sced', 'violin', 'dots', 'paired',
  'box', 'wordcloud', 'steps', 'forest'];

/** A minimal but non-degenerate model per kind, so `controls(model)` takes its real path. */
const MODELS = {
  categorical: {
    kind: 'categorical', title: 'T', axes: { x: { title: 'X' }, y: { title: 'Y' } },
    categories: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    series: [{ key: 's1', label: 'S1', values: [1, 2] }, { key: 's2', label: 'S2', values: [3, 4] }],
  },
  scatter: {
    kind: 'scatter', points: [{ x: 1, y: 2, g: 'a' }, { x: 2, y: 3, g: 'b' }],
    groups: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], trend: { slope: 1, intercept: 0, r2: 0.5 },
  },
  pie: { kind: 'pie', slices: [{ key: 'a', label: 'A', value: 1 }, { key: 'b', label: 'B', value: 2 }] },
  sced: {
    kind: 'sced',
    phases: [{ key: 'base', label: 'Baseline' }, { key: 'int', label: 'Intervention' }],
    panels: [
      { key: 'p1', label: 'Ann', points: [{ x: 1, y: 2, phase: 'base' }, { x: 2, y: 8, phase: 'int' }] },
      { key: 'p2', label: 'Bo', points: [{ x: 1, y: 3, phase: 'base' }, { x: 2, y: 9, phase: 'int' }] },
    ],
  },
  violin: { kind: 'violin', groups: [{ key: 'a', label: 'A', values: [1, 2, 3, 4] }, { key: 'b', label: 'B', values: [2, 3, 4, 5] }] },
  dots: { kind: 'dots', groups: [{ key: 'a', label: 'A', values: [1, 2, 3], reps: ['r1', 'r2', 'r1'] }, { key: 'b', label: 'B', values: [2, 3, 4], reps: ['r1', 'r2', 'r2'] }] },
  paired: {
    kind: 'paired', conditions: [{ key: 'pre', label: 'Pre' }, { key: 'post', label: 'Post' }],
    subjects: [{ key: 's1', label: 'S1', values: [1, 3] }, { key: 's2', label: 'S2', values: [2, 1] }],
  },
  box: { kind: 'box', groups: [{ key: 'a', label: 'A', values: [1, 2, 3, 9] }, { key: 'b', label: 'B', values: [2, 3, 4] }] },
  wordcloud: {
    kind: 'wordcloud',
    words: [{ word: 'x', count: 5, theme: 't1', themeName: 'One' }, { word: 'y', count: 3, theme: 't2', themeName: 'Two' }],
  },
  steps: {
    kind: 'steps',
    series: [
      { key: 'a', label: 'A', points: [{ x: 0, y: 1, lo: 1, hi: 1 }, { x: 2, y: 0.5, lo: 0.2, hi: 0.8 }], marks: [{ x: 1, y: 1 }] },
      { key: 'b', label: 'B', points: [{ x: 0, y: 1 }, { x: 3, y: 0.4 }] },
    ],
  },
  forest: {
    kind: 'forest',
    studies: [{ key: 's1', label: 'S1', est: 0.4, lo: 0.1, hi: 0.7, weight: 60 }, { key: 's2', label: 'S2', est: 0.2, lo: -0.1, hi: 0.5, weight: 40 }],
    summary: { label: 'Pooled', est: 0.3, lo: 0.1, hi: 0.5 },
  },
};

const ctl = (o) => ({ id: 'x', type: 'number', ...o });

// --- reading -------------------------------------------------------------------

test('a stored value wins over the default — including false and 0', () => {
  // The old getters were written `v.gridlines !== false` precisely to protect these two.
  // `??` in controlValue has to do the same job, or switching a toggle off would read
  // as "unset" and snap straight back on.
  assert.equal(controlValue(ctl({ id: 'g', type: 'check', default: true }), { g: false }), false);
  assert.equal(controlValue(ctl({ id: 'n', default: 5 }), { n: 0 }), 0);
  assert.equal(controlValue(ctl({ id: 'g', type: 'check', default: true }), {}), true);
  assert.equal(controlValue(ctl({ id: 'n', default: 5 }), {}), 5);
});

test('`key` lets a control write somewhere other than its own id', () => {
  assert.equal(controlValue(ctl({ id: 'a', key: 'b', default: 1 }), { b: 9 }), 9);
  const v = {};
  setControlValue(ctl({ id: 'a', key: 'b' }), v, '3');
  assert.deepEqual(v, { b: 3 });
});

// --- writing -------------------------------------------------------------------

test('numbers are clamped to the declared range', () => {
  // The widget's min/max only constrain the spinner. Typing 999 into a "max 10" box
  // used to store 999 and hand it to the renderer.
  const v = {};
  const c = ctl({ id: 'pointSize', min: 1, max: 10 });
  setControlValue(c, v, '999');
  assert.equal(v.pointSize, 10);
  setControlValue(c, v, '-4');
  assert.equal(v.pointSize, 1);
});

test('rotation wraps instead of clamping', () => {
  // 370° is a legitimate way to type 10°; clamping would silently mean "no rotation".
  const v = {};
  const c = ctl({ id: 'pieRotation', min: 0, max: 360, wrap: 360 });
  setControlValue(c, v, '370');
  assert.equal(v.pieRotation, 10);
  setControlValue(c, v, '-30');
  assert.equal(v.pieRotation, 330);
});

test('blank clears back to auto, and garbage is never stored', () => {
  const v = { yAxisMin: 5 };
  const c = ctl({ id: 'yAxisMin' });
  setControlValue(c, v, '');
  assert.equal(v.yAxisMin, undefined, 'blank means auto');
  setControlValue(c, v, 'abc');
  assert.equal(v.yAxisMin, undefined, 'NaN must never reach the view');
  // A NaN in the view silently breaks every downstream scale, so this is the one
  // coercion that matters more than convenience.
  assert.ok(!Number.isNaN(v.yAxisMin));
});

test('a select can carry numbers, and text clears to undefined when emptied', () => {
  const v = {};
  setControlValue({ id: 'pointSize', type: 'select', valueType: 'number' }, v, '6');
  assert.strictEqual(v.pointSize, 6);
  setControlValue({ id: 'titleText', type: 'text' }, v, 'Hi');
  assert.equal(v.titleText, 'Hi');
  setControlValue({ id: 'titleText', type: 'text' }, v, '');
  assert.equal(v.titleText, undefined, 'an emptied title falls back to the model title');
});

// --- visibility -----------------------------------------------------------------

test('visibleWhen names a CONTROL, so the dependency is default-agnostic', () => {
  // This is the whole reason it references a control rather than a view key. The box
  // kind defaults showPoints OFF and the violin kind defaults it ON, yet both express
  // "show point size when points are shown" with the identical declaration.
  const dependent = { id: 'pointSize', type: 'number', visibleWhen: { control: 'showPoints', truthy: true } };
  const offByDefault = [{ id: 'showPoints', type: 'check', default: false }, dependent];
  const onByDefault = [{ id: 'showPoints', type: 'check', default: true }, dependent];

  assert.equal(controlVisible(dependent, {}, offByDefault), false);
  assert.equal(controlVisible(dependent, {}, onByDefault), true);
  assert.equal(controlVisible(dependent, { showPoints: true }, offByDefault), true);
  assert.equal(controlVisible(dependent, { showPoints: false }, onByDefault), false);
});

test('truthy:false inverts, equals matches, and no clause means always', () => {
  const controls = [
    { id: 'mono', type: 'check', default: false },
    { id: 'mark', type: 'select', default: 'bar' },
  ];
  assert.equal(controlVisible({ visibleWhen: { control: 'mono', truthy: false } }, { mono: true }, controls), false);
  assert.equal(controlVisible({ visibleWhen: { control: 'mono', truthy: false } }, { mono: false }, controls), true);
  assert.equal(controlVisible({ visibleWhen: { control: 'mark', equals: 'bar' } }, {}, controls), true);
  assert.equal(controlVisible({ visibleWhen: { control: 'mark', equals: 'line' } }, {}, controls), false);
  assert.equal(controlVisible({}, {}, controls), true);
});

test('a dangling visibleWhen shows the control rather than hiding it silently', () => {
  // Failing open: a typo in a reference should be noticeable, not invisible.
  assert.equal(controlVisible({ visibleWhen: { control: 'nope', truthy: true } }, {}, []), true);
});

// --- the whole registry ----------------------------------------------------------

test('every kind exposes only declarative descriptors — no closures survive', () => {
  for (const kind of KINDS) {
    for (const c of chartUiSpec(MODELS[kind]).controls) {
      for (const banned of ['get', 'set', 'visible']) {
        assert.equal(typeof c[banned], 'undefined', `${kind}.${c.id} still carries a ${banned}() closure`);
      }
      assert.equal(typeof c.options, c.options === undefined ? 'undefined' : 'object',
        `${kind}.${c.id} options must be data, not a function`);
      assert.ok(c.id, `${kind}: a control with no id`);
      assert.ok(['check', 'number', 'text', 'select', 'note'].includes(c.type), `${kind}.${c.id}: bad type ${c.type}`);
    }
  }
});

test('THE GATE: every descriptor survives structuredClone', () => {
  // This is what makes a chart kind in a sandboxed plugin possible at all. A descriptor
  // has to cross postMessage intact; anything unclonable here is a closure or a live
  // object that would throw a DataCloneError the moment the kind moved out of core.
  for (const kind of KINDS) {
    const spec = chartUiSpec(MODELS[kind]);
    assert.doesNotThrow(() => structuredClone(spec.controls), `${kind}: controls are not clonable`);
    assert.doesNotThrow(() => structuredClone(spec.colorItems), `${kind}: colorItems are not clonable`);
    const round = structuredClone(spec.controls);
    assert.deepEqual(round, spec.controls, `${kind}: descriptors lost data in a round-trip`);
  }
});

test('every control default agrees with what the renderer actually draws', () => {
  // A descriptor default that disagrees with the renderer means the panel opens showing
  // a value the chart is not using — the control looks broken until you touch it.
  for (const kind of KINDS) {
    const model = MODELS[kind];
    const view = defaultView(model);
    const spec = chartUiSpec(model);
    const base = getChartKind(kind).baseView?.(model) || {};
    for (const c of spec.controls) {
      if (c.type === 'note' || c.default === undefined) continue;
      const key = c.key || c.id;
      if (!(key in base)) continue; // only the ones baseView also has an opinion about
      assert.deepEqual(controlValue(c, view), c.type === 'select' ? String(base[key]) : base[key],
        `${kind}.${c.id}: descriptor default disagrees with baseView`);
    }
  }
});
