/**
 * @file charts/kinds/pie.js
 * Chart kind: slices, start-angle rotation, percentage labels.
 */
import {
  colorFor,
  registerChartKind,
  paletteControl,
  legendControl,
  valueLabelsControl,
  W,
  H,
  text,
  r,
  esc,
  legendBlock,
  ordered,
  svgOpen,
  chartAltText,
} from '../runtime.js';

// =============================================================================
// KIND: pie (slices, start-angle rotation, % labels)
// =============================================================================

registerChartKind('pie', {
  altNoun: 'Pie chart',
  colorLabel: 'Slices',
  reorderCategories: false,
  colorItems: (model) => (model.slices || []).map((s) => ({ key: s.key, label: s.label || s.key })),
  baseView: () => ({ legend: 'right', valueLabels: true, pieRotation: 0 }),
  controls: (model) => {
    const multi = (model.slices || []).length > 1;
    return [
      // `wrap` rather than clamp: 370° is a legitimate way to type 10°, and clamping it
      // to 360 would silently mean "no rotation" instead.
      { id: 'pieRotation', group: 'Chart', label: 'Rotate (°)', type: 'number', min: 0, max: 360, step: 15, wrap: 360, default: 0 },
      paletteControl(multi),
      legendControl(multi, 'right'),
      valueLabelsControl('Show %'),
    ];
  },
  render: (model, view) => renderPie(model, view),
});

function renderPie(model, view) {
  const slices = ordered(model.slices, view.seriesOrder).filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;

  const legendRight = view.legend === 'right' && slices.length > 1;
  const mRight = legendRight ? Math.min(220, Math.max(80, Math.max(0, ...slices.map((s) => (s.label || s.key).length)) * 7 + 40)) : 24;
  const mTop = model.title ? 38 : 18;
  const cx = (24 + (W - mRight)) / 2;
  const cy = mTop + (H - mTop - 24) / 2;
  const radius = Math.min((W - mRight - 24) / 2, (H - mTop - 24) / 2) - 6;

  const out = [svgOpen(chartAltText(model, view, `${slices.length} slices.`))];
  if (model.title) out.push(text(W / 2, 22, esc(model.title), { size: 15, weight: 600, anchor: 'middle', fill: '#222' }));

  let ang = -90 + (view.pieRotation || 0); // start at top, + rotation, clockwise
  const items = [];
  slices.forEach((s, i) => {
    const frac = s.value / total;
    const sweep = frac * 360;
    const a0 = ang;
    const a1 = ang + sweep;
    const color = colorFor(view, s.key, i);
    if (slices.length === 1) {
      out.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(radius)}" fill="${color}"/>`);
    } else {
      out.push(`<path d="${arcPath(cx, cy, radius, a0, a1)}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
    }
    if (view.valueLabels && frac > 0.03) {
      const mid = (a0 + a1) / 2;
      const lr = radius * 0.62;
      const lx = cx + lr * Math.cos((mid * Math.PI) / 180);
      const ly = cy + lr * Math.sin((mid * Math.PI) / 180);
      out.push(text(lx, ly + 3, `${Math.round(frac * 100)}%`, { size: 11, anchor: 'middle', fill: '#fff', weight: 600 }));
    }
    items.push({ label: `${s.label || s.key}`, color });
    ang = a1;
  });

  const box = { x0: 24, x1: W - mRight, y0: H - 24, y1: mTop };
  if (slices.length > 1) out.push(legendBlock(items, view.legend, box));

  out.push('</svg>');
  return out.join('');
}

/** SVG arc wedge path from `cx,cy` out to radius `rad`, sweeping start→end degrees
 * (0° = east, clockwise because SVG y grows downward). */
function arcPath(cx, cy, rad, startDeg, endDeg) {
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = (endDeg * Math.PI) / 180;
  const x0 = cx + rad * Math.cos(a0);
  const y0 = cy + rad * Math.sin(a0);
  const x1 = cx + rad * Math.cos(a1);
  const y1 = cy + rad * Math.sin(a1);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${r(cx)} ${r(cy)} L ${r(x0)} ${r(y0)} A ${r(rad)} ${r(rad)} 0 ${large} 1 ${r(x1)} ${r(y1)} Z`;
}
