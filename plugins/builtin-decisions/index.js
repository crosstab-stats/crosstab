/**
 * @file plugins/builtin-decisions/index.js
 * Built-in WORKSPACE plugin (#53/#54): Decision Support.
 *
 * The second flagship workspace plugin (with CAQDAS, #67). One "Decisions" tab
 * that houses several decision-analysis TOOLS, selected inside the tab — so it's
 * one cohesive plugin, not a dozen. v1 ships two:
 *   • Cost-effectiveness (ICER) — interventions table → CE frontier + ICERs vs a
 *     willingness-to-pay threshold + a cost-effectiveness-plane plot.
 *   • Decision matrix (weighted MCDA) — options × weighted criteria → ranked score.
 * Pure JS (no WebR). Inputs persist in the project (app.state); results push to the
 * Output tab via the bracketed, host-attributed path (beginAnalysis → … → endAnalysis).
 *
 * Sandbox notes (same as CAQDAS): allow-scripts only (no prompt/alert), styles via
 * the CSSOM. UI pattern: cell inputs write to state on `input` (no re-render, so
 * focus is never lost mid-typing); add/remove buttons mutate state and re-render.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-decisions',
  name: 'Decision Support',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Decision',
  keywords: ['decision', 'cost-effectiveness', 'icer', 'cea', 'mcda', 'decision matrix', 'trade-off', 'willingness to pay'],
  disciplines: ['economics', 'health', 'public health', 'policy', 'management', 'operations'],
  workspaces: [{ id: 'decision-support', title: 'Decisions' }],
};

const TOOLS = [
  ['icer', 'Cost-effectiveness (ICER)'],
  ['matrix', 'Decision matrix (weighted)'],
];

const STYLES = `
:host, body { margin: 0; }
.ds { display: flex; flex-direction: column; height: 100%; min-height: 460px; font: 14px system-ui, sans-serif; color: #1a1a1a; }
.ds__bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #e2e6ea; }
.ds__bar select, .ds__btn, .ds input { font: inherit; }
.ds__body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px; max-width: 820px; }
.ds__hint { color: #555; line-height: 1.5; margin: 0 0 12px; }
.ds__row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.ds__btn { padding: 6px 10px; border: 1px solid #ccd2d8; border-radius: 6px; background: #f3f6fa; cursor: pointer; }
.ds__btn:hover { background: #e9eff6; }
.ds__btn--go { background: #2f6fb0; color: #fff; border-color: #2f6fb0; }
.ds__btn--go:hover { background: #285f8f; border-color: #285f8f; }
.ds h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #7a8590; margin: 16px 0 6px; }
.ds table { border-collapse: collapse; width: 100%; margin: 4px 0; }
.ds th, .ds td { border: 1px solid #e2e6ea; padding: 4px 6px; text-align: left; }
.ds th { background: #f5f8fb; font-weight: 500; font-size: 13px; }
.ds td input { width: 100%; box-sizing: border-box; border: 0; padding: 4px; background: transparent; }
.ds td input:focus { outline: 2px solid #bcd4ec; border-radius: 3px; }
.ds td.num input { text-align: right; }
.ds .del { border: 0; background: none; color: #b04a4a; cursor: pointer; font: inherit; }
`;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const fmt = (n) => (n == null || !Number.isFinite(n) ? '—' : Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(4)).toString());

export const workspace = {
  async mount(app, root) {
    const state = normalizeState(await app.state.get());
    let saveT = null;
    const save = () => { if (saveT) clearTimeout(saveT); saveT = setTimeout(() => app.state.set(state), 300); };

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      const s = document.createElement('style'); s.textContent = STYLES; document.head.append(s);
    }
    const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
    const inputCell = (value, type, onInput, cls) => {
      const td = el('td', cls);
      const inp = el('input'); inp.type = type; inp.value = value ?? '';
      inp.addEventListener('input', () => onInput(inp.value));
      td.append(inp); return td;
    };
    root.textContent = '';

    const wrap = el('div', 'ds');
    const bar = el('div', 'ds__bar');
    const lab = el('label'); lab.textContent = 'Tool:';
    const sel = el('select');
    for (const [v, label] of TOOLS) { const o = el('option'); o.value = v; o.textContent = label; sel.append(o); }
    sel.value = state.tool;
    sel.addEventListener('change', () => { state.tool = sel.value; save(); render(); });
    bar.append(lab, sel);
    const body = el('div', 'ds__body');
    wrap.append(bar, body);
    root.append(wrap);

    const render = () => { body.textContent = ''; if (state.tool === 'matrix') renderMatrix(); else renderICER(); };

    // --- Tool: Cost-effectiveness (ICER) -------------------------------------
    function renderICER() {
      const t = state.icer;
      const hint = el('p', 'ds__hint');
      hint.textContent = 'Enter each option’s total cost and effect (e.g. QALYs). Computes the cost-effectiveness frontier and the incremental cost-effectiveness ratio (ICER) of each non-dominated option vs the next-cheaper one, judged against your willingness-to-pay.';
      body.append(hint);

      const wtpRow = el('div', 'ds__row');
      const wl = el('label'); wl.textContent = 'Willingness-to-pay per unit effect:';
      const wi = el('input'); wi.type = 'number'; wi.value = t.wtp; wi.style.width = '140px';
      wi.addEventListener('input', () => { t.wtp = num(wi.value) ?? 0; save(); });
      wtpRow.append(wl, wi); body.append(wtpRow);

      const table = el('table');
      const thead = el('thead');
      const htr = el('tr');
      for (const h of ['Option', 'Cost', 'Effect', '']) { const th = el('th'); th.textContent = h; htr.append(th); }
      thead.append(htr); table.append(thead);
      const tb = el('tbody');
      t.rows.forEach((r, i) => {
        const tr = el('tr');
        tr.append(inputCell(r.name, 'text', (v) => { r.name = v; save(); }));
        tr.append(inputCell(r.cost, 'number', (v) => { r.cost = v; save(); }, 'num'));
        tr.append(inputCell(r.effect, 'number', (v) => { r.effect = v; save(); }, 'num'));
        const dtd = el('td'); const del = el('button', 'del'); del.textContent = '✕';
        del.addEventListener('click', () => { t.rows.splice(i, 1); save(); renderICER(); });
        dtd.append(del); tr.append(dtd); tb.append(tr);
      });
      table.append(tb); body.append(table);

      const add = el('button', 'ds__btn'); add.textContent = '＋ Add option';
      add.addEventListener('click', () => { t.rows.push({ name: '', cost: '', effect: '' }); save(); renderICER(); });
      const go = el('button', 'ds__btn ds__btn--go'); go.textContent = 'Compute → Output';
      go.addEventListener('click', () => runICER());
      const actions = el('div', 'ds__row'); actions.append(add, go); body.append(actions);
    }

    async function runICER() {
      const t = state.icer;
      const res = computeICER(t.rows, num(t.wtp));
      if (!res.length) { app.results.appendError('Decisions: enter at least one option with a numeric cost and effect.'); return; }
      const rows = res.map((r) => [
        r.name, fmt(r.cost), fmt(r.effect),
        r.icer == null ? (r.status === 'baseline' ? '— (baseline)' : '— (dominated)') : fmt(r.icer),
        r.status === 'baseline' || r.status === 'dominated' ? r.status : r.status || '',
      ]);
      await app.results.beginAnalysis('Cost-effectiveness (ICER)');
      await app.results.appendText(`Willingness-to-pay: **${fmt(num(t.wtp))}** per unit effect. ICER = Δcost ÷ Δeffect vs the next-cheaper non-dominated option. (Simple frontier — no extended-dominance pass.)`);
      await app.results.appendTable({ columns: ['Option', 'Cost', 'Effect', 'ICER', 'Status'], rows });
      const plot = cePlaneSvg(res);
      if (plot) await app.results.appendPlot(plot);
      await app.results.endAnalysis();
    }

    // --- Tool: Decision matrix (weighted MCDA) -------------------------------
    function renderMatrix() {
      const m = state.matrix;
      const hint = el('p', 'ds__hint');
      hint.textContent = 'Score each option against weighted criteria. The recommendation is the weighted average score (weights are normalised), ranked high-to-low.';
      body.append(hint);

      body.append(Object.assign(el('h3'), { textContent: 'Criteria' }));
      const ct = el('table'); const cth = el('thead');
      const ctr = el('tr'); for (const h of ['Criterion', 'Weight', '']) { const th = el('th'); th.textContent = h; ctr.append(th); }
      cth.append(ctr); ct.append(cth);
      const ctb = el('tbody');
      m.criteria.forEach((c, i) => {
        const tr = el('tr');
        const nameTd = inputCell(c.name, 'text', (v) => { c.name = v; save(); });
        // Renaming a criterion changes the score-grid header → re-render on blur.
        nameTd.querySelector('input').addEventListener('blur', renderMatrix);
        tr.append(nameTd);
        tr.append(inputCell(c.weight, 'number', (v) => { c.weight = v; save(); }, 'num'));
        const dtd = el('td'); const del = el('button', 'del'); del.textContent = '✕';
        del.addEventListener('click', () => { m.criteria.splice(i, 1); for (const o of m.options) o.scores.splice(i, 1); save(); renderMatrix(); });
        dtd.append(del); tr.append(dtd); ctb.append(tr);
      });
      ct.append(ctb); body.append(ct);
      const addC = el('button', 'ds__btn'); addC.textContent = '＋ Add criterion';
      addC.addEventListener('click', () => { m.criteria.push({ name: '', weight: 1 }); save(); renderMatrix(); });
      body.append(addC);

      body.append(Object.assign(el('h3'), { textContent: 'Options & scores' }));
      const ot = el('table'); const oth = el('thead'); const otr = el('tr');
      const oh = el('th'); oh.textContent = 'Option'; otr.append(oh);
      m.criteria.forEach((c) => { const th = el('th'); th.textContent = c.name || '(criterion)'; otr.append(th); });
      otr.append(el('th')); oth.append(otr); ot.append(oth);
      const otb = el('tbody');
      m.options.forEach((o, oi) => {
        const tr = el('tr');
        tr.append(inputCell(o.name, 'text', (v) => { o.name = v; save(); }));
        m.criteria.forEach((c, ci) => {
          tr.append(inputCell(o.scores[ci], 'number', (v) => { o.scores[ci] = v; save(); }, 'num'));
        });
        const dtd = el('td'); const del = el('button', 'del'); del.textContent = '✕';
        del.addEventListener('click', () => { m.options.splice(oi, 1); save(); renderMatrix(); });
        dtd.append(del); tr.append(dtd); otb.append(tr);
      });
      ot.append(otb); body.append(ot);
      const addO = el('button', 'ds__btn'); addO.textContent = '＋ Add option';
      addO.addEventListener('click', () => { m.options.push({ name: '', scores: [] }); save(); renderMatrix(); });
      const go = el('button', 'ds__btn ds__btn--go'); go.textContent = 'Compute → Output';
      go.addEventListener('click', () => runMatrix());
      const actions = el('div', 'ds__row'); actions.append(addO, go); body.append(actions);
    }

    async function runMatrix() {
      const m = state.matrix;
      const res = computeMatrix(m.criteria, m.options);
      if (!res.length) { app.results.appendError('Decisions: add at least one option and criterion.'); return; }
      const rows = res.map((r) => [String(r.rank), r.name, fmt(r.total)]);
      await app.results.beginAnalysis('Decision matrix');
      await app.results.appendText(`Weighted average of ${m.criteria.length} criterion(s), weights normalised. Higher is better.`);
      await app.results.appendTable({ columns: ['Rank', 'Option', 'Weighted score'], rows });
      await app.results.endAnalysis();
    }

    render();
  },
};

/** Cost-effectiveness analysis: sort by cost, drop strongly-dominated options, and
 * compute each non-dominated option's ICER vs the next-cheaper one; tag against the
 * willingness-to-pay threshold. Simple frontier (no extended-dominance pass).
 * Exported for unit testing.
 * @returns {Array<{name,cost,effect,icer:(number|null),status:string}>}
 */
export function computeICER(rows, wtp) {
  const valid = (rows || [])
    .map((r) => ({ name: r.name || '(unnamed)', cost: num(r.cost), effect: num(r.effect) }))
    .filter((r) => r.cost != null && r.effect != null);
  if (!valid.length) return [];
  const sorted = valid.slice().sort((a, b) => a.cost - b.cost || a.effect - b.effect);
  const out = [];
  let ref = null;
  for (const r of sorted) {
    if (!ref) { out.push({ ...r, icer: null, status: 'baseline' }); ref = r; continue; }
    if (r.effect <= ref.effect) { out.push({ ...r, icer: null, status: 'dominated' }); continue; }
    const icer = (r.cost - ref.cost) / (r.effect - ref.effect);
    const status = wtp != null && wtp > 0 ? (icer <= wtp ? 'cost-effective' : 'not cost-effective') : '';
    out.push({ ...r, icer, status });
    ref = r;
  }
  return out;
}

/** Weighted decision matrix (MCDA): weighted average of scores per option (weights
 * normalised to sum 1), ranked high-to-low. Exported for unit testing.
 * @returns {Array<{name,total:number,rank:number}>}
 */
export function computeMatrix(criteria, options) {
  const crit = (criteria || []).map((c) => ({ weight: num(c.weight) ?? 0 }));
  const wsum = crit.reduce((s, c) => s + c.weight, 0) || 1;
  const scored = (options || []).map((o) => {
    const total = crit.reduce((s, c, i) => s + (c.weight / wsum) * (num(o.scores?.[i]) ?? 0), 0);
    return { name: o.name || '(option)', total };
  });
  scored.sort((a, b) => b.total - a.total);
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

/** A tiny cost-effectiveness plane (cost vs effect scatter), as an SVG string. */
function cePlaneSvg(res) {
  const pts = res.filter((r) => r.cost != null && r.effect != null);
  if (pts.length < 1) return null;
  const W = 420, H = 280, pad = 44;
  const xs = pts.map((p) => p.effect), ys = pts.map((p) => p.cost);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const sx = (x) => pad + ((x - xmin) / (xmax - xmin || 1)) * (W - pad - 16);
  const sy = (y) => H - pad - ((y - ymin) / (ymax - ymin || 1)) * (H - pad - 16);
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="11">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  s += `<line x1="${pad}" y1="${H - pad}" x2="${W - 16}" y2="${H - pad}" stroke="#888"/><line x1="${pad}" y1="16" x2="${pad}" y2="${H - pad}" stroke="#888"/>`;
  s += `<text x="${(W) / 2}" y="${H - 10}" text-anchor="middle" fill="#555">Effect</text>`;
  s += `<text x="14" y="${H / 2}" text-anchor="middle" fill="#555" transform="rotate(-90 14 ${H / 2})">Cost</text>`;
  for (const p of pts) {
    const cx = sx(p.effect), cy = sy(p.cost);
    const color = p.status === 'dominated' ? '#b04a4a' : p.status === 'cost-effective' ? '#2e7d32' : '#2f6fb0';
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${color}"/>`;
    s += `<text x="${(cx + 7).toFixed(1)}" y="${(cy + 3).toFixed(1)}" fill="#333">${esc(p.name)}</text>`;
  }
  s += `</svg>`;
  return s;
}

/** Coerce a saved/empty blob into the working shape (with sensible starter rows). */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const icer = s.icer && typeof s.icer === 'object' ? s.icer : {};
  const matrix = s.matrix && typeof s.matrix === 'object' ? s.matrix : {};
  return {
    version: 1,
    tool: s.tool === 'matrix' ? 'matrix' : 'icer',
    icer: {
      wtp: num(icer.wtp) ?? 50000,
      rows: Array.isArray(icer.rows) && icer.rows.length
        ? icer.rows.map((r) => ({ name: String(r.name ?? ''), cost: r.cost ?? '', effect: r.effect ?? '' }))
        : [{ name: 'Usual care', cost: 0, effect: 0 }, { name: 'New treatment', cost: '', effect: '' }],
    },
    matrix: {
      criteria: Array.isArray(matrix.criteria) && matrix.criteria.length
        ? matrix.criteria.map((c) => ({ name: String(c.name ?? ''), weight: c.weight ?? 1 }))
        : [{ name: 'Cost', weight: 2 }, { name: 'Quality', weight: 3 }],
      options: Array.isArray(matrix.options) && matrix.options.length
        ? matrix.options.map((o) => ({ name: String(o.name ?? ''), scores: Array.isArray(o.scores) ? o.scores.slice() : [] }))
        : [{ name: 'Option A', scores: [] }, { name: 'Option B', scores: [] }],
    },
  };
}
