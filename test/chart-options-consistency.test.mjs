/**
 * @file chart-options-consistency.test.mjs
 * The ⚙ Chart options panel means the same thing on every chart.
 *
 * Twelve chart kinds each declare their own controls, and a control's section
 * and wording are decided where that control is written — so nothing stops the
 * twelfth author from filing "Point size" under Chart when the other four filed
 * it under Style, or from calling the same switch "Show" here and "Bar height"
 * there. Nobody reads the other eleven files, and the panel is the surface a
 * reader is supposed to learn once.
 *
 * That is not a bug any single kind's test would catch, because each kind is
 * individually fine. It is only visible across the set, which is what this file
 * looks at: every shared control lands in the same section under the same name
 * everywhere, sections appear in one order, and formatting travels with the
 * thing it formats.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { KINDS } = await import('./chart-kinds-harness.mjs');

/** A plausible model per kind — enough for `describe()` to decide its controls. */
const cats = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
const ser = (n) => Array.from({ length: n }, (_, i) => ({ key: `s${i}`, label: `S${i}`, values: [1, 2] }));
const grp = (n) => Array.from({ length: n }, (_, i) => ({ key: `g${i}`, label: `G${i}`, values: [1, 2, 3, 4, 5] }));

const MODELS = {
  categorical: { kind: 'categorical', title: 'T', categories: cats, series: ser(2), counts: true },
  scatter: { kind: 'scatter', title: 'T', points: [{ x: 1, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 5 }], trend: { slope: 1, intercept: 0, r2: 0.9 } },
  pie: { kind: 'pie', title: 'T', slices: [{ key: 'a', label: 'A', value: 3 }, { key: 'b', label: 'B', value: 1 }] },
  violin: { kind: 'violin', title: 'T', groups: grp(2) },
  dots: { kind: 'dots', title: 'T', groups: grp(2) },
  paired: { kind: 'paired', title: 'T', groups: grp(2), lines: [[1, 2]] },
  box: { kind: 'box', title: 'T', groups: grp(2) },
  histogram: { kind: 'histogram', title: 'T', values: [1, 2, 3, 4, 5, 6, 7, 8] },
  steps: { kind: 'steps', title: 'T', curves: [{ key: 'c', label: 'C', points: [{ t: 0, s: 1 }, { t: 1, s: 0.5 }] }] },
  forest: { kind: 'forest', title: 'T', rows: [{ key: 'r', label: 'R', est: 1, lo: 0, hi: 2 }] },
  sced: { kind: 'sced', title: 'T', cases: [{ key: 'c', label: 'C', phases: [{ key: 'A', label: 'A', points: [{ t: 1, y: 2 }] }] }] },
  wordcloud: { kind: 'wordcloud', title: 'T', words: [{ text: 'a', weight: 3 }, { text: 'b', weight: 1 }] },
};

/** The canonical section order the panel presents. */
const ORDER = ['Chart', 'Bins', 'Phases', 'Panels', 'Style', 'Labels', 'Titles & axes'];

const describe = (name) => KINDS[name].describe(MODELS[name]);
const names = Object.keys(KINDS);

test('every kind has a model here — a new kind must be added to this file', () => {
  // Not bureaucracy: a kind nobody added is a kind nobody checked, and it would
  // pass this whole file by being absent from it.
  for (const n of names) assert.ok(MODELS[n], `no test model for the "${n}" chart kind`);
});

test('a control id means one thing: the same section and the same label everywhere', () => {
  const seen = new Map(); // id -> { kind, group, label }
  const drift = [];
  for (const n of names) {
    for (const c of describe(n).controls) {
      const first = seen.get(c.id);
      if (!first) { seen.set(c.id, { kind: n, group: c.group, label: c.label }); continue; }
      if (first.group !== c.group) {
        drift.push(`${c.id}: "${first.kind}" files it under ${first.group}, "${n}" under ${c.group}`);
      }
      if (first.label !== c.label) {
        drift.push(`${c.id}: "${first.kind}" calls it "${first.label}", "${n}" calls it "${c.label}"`);
      }
    }
  }
  assert.deepEqual(drift, [], `\n  ${drift.join('\n  ')}\n`);
});

test('sections appear in one order, on every kind', () => {
  for (const n of names) {
    const groups = [];
    for (const c of describe(n).controls) {
      if (groups[groups.length - 1] !== c.group) groups.push(c.group);
    }
    // Each section appears once...
    assert.equal(new Set(groups).size, groups.length, `${n} splits a section in two: ${groups.join(' > ')}`);
    // ...and in the canonical sequence, skipping any it has no controls for.
    const ranks = groups.map((g) => ORDER.indexOf(g));
    assert.ok(ranks.every((r) => r >= 0), `${n} uses an unknown section: ${groups.join(' > ')}`);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${n} is out of order: ${groups.join(' > ')}`);
  }
});

test('wherever a chart labels its values, it can format those labels', () => {
  // The pie could show value labels and offered no way to size them, which is
  // how the inconsistency was noticed in the first place.
  for (const n of names) {
    const ids = describe(n).controls.map((c) => c.id);
    if (!ids.includes('valueLabels')) continue;
    for (const f of ['valueLabelSize', 'valueLabelBold', 'valueLabelItalic']) {
      assert.ok(ids.includes(f), `${n} shows value labels but has no ${f}`);
    }
  }
});

test('every chart can be retitled', () => {
  for (const n of names) {
    assert.ok(describe(n).controls.some((c) => c.id === 'titleText'), `${n} cannot be retitled`);
  }
});

test('a control that depends on another names one that exists on the same kind', () => {
  for (const n of names) {
    const controls = describe(n).controls;
    const ids = new Set(controls.map((c) => c.id));
    for (const c of controls) {
      const dep = c.visibleWhen?.control;
      if (dep) assert.ok(ids.has(dep), `${n}: "${c.id}" is shown only when "${dep}" is set, but ${n} has no "${dep}"`);
    }
  }
});

test('no kind offers two controls with the same id', () => {
  for (const n of names) {
    const ids = describe(n).controls.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${n} declares a duplicate control id`);
  }
});

test('every control is usable: a label, a known type, and options where it needs them', () => {
  const TYPES = new Set(['select', 'check', 'number', 'text', 'note']);
  for (const n of names) {
    for (const c of describe(n).controls) {
      assert.ok(c.id, `${n} has a control with no id`);
      assert.ok(c.label && String(c.label).trim(), `${n}: "${c.id}" has no label`);
      assert.ok(TYPES.has(c.type), `${n}: "${c.id}" has type "${c.type}"`);
      if (c.type === 'select') {
        assert.ok(Array.isArray(c.options) && c.options.length > 1, `${n}: "${c.id}" is a select with nothing to choose`);
      }
    }
  }
});
