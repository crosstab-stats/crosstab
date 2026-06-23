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
  ['npv', 'Cost-benefit (NPV)'],
  ['ev', 'Expected value (payoff table)'],
  ['tree', 'Decision tree'],
  ['sens', 'Sensitivity & threshold'],
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

const uid = () => 'n_' + Math.random().toString(36).slice(2, 9);
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

    const RENDERERS = { icer: renderICER, matrix: renderMatrix, npv: renderNPV, ev: renderEV, tree: renderTree, sens: renderSens };
    const render = () => { body.textContent = ''; (RENDERERS[state.tool] || renderICER)(); };

    // --- Tool: Cost-effectiveness (ICER) -------------------------------------
    function renderICER() {
      body.textContent = '';
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
      body.textContent = '';
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

    // --- Tool: Cost-benefit (NPV) --------------------------------------------
    function renderNPV() {
      body.textContent = '';
      const t = state.npv;
      const hint = el('p', 'ds__hint');
      hint.textContent = 'Enter cost and benefit per period (period 0 = today). Future flows are discounted at your rate; reports NPV, benefit-cost ratio, and the discounted payback period.';
      body.append(hint);
      const rRow = el('div', 'ds__row');
      const rl = el('label'); rl.textContent = 'Discount rate (%):';
      const ri = el('input'); ri.type = 'number'; ri.value = t.rate; ri.style.width = '100px';
      ri.addEventListener('input', () => { t.rate = num(ri.value) ?? 0; save(); });
      rRow.append(rl, ri); body.append(rRow);
      const table = el('table'); const thead = el('thead'); const htr = el('tr');
      for (const h of ['Period', 'Cost', 'Benefit', '']) { const th = el('th'); th.textContent = h; htr.append(th); }
      thead.append(htr); table.append(thead);
      const tb = el('tbody');
      t.rows.forEach((r, i) => {
        const tr = el('tr');
        const ptd = el('td'); ptd.textContent = String(i); tr.append(ptd);
        tr.append(inputCell(r.cost, 'number', (v) => { r.cost = v; save(); }, 'num'));
        tr.append(inputCell(r.benefit, 'number', (v) => { r.benefit = v; save(); }, 'num'));
        const dtd = el('td'); const del = el('button', 'del'); del.textContent = '✕';
        del.addEventListener('click', () => { t.rows.splice(i, 1); save(); renderNPV(); });
        dtd.append(del); tr.append(dtd); tb.append(tr);
      });
      table.append(tb); body.append(table);
      const add = el('button', 'ds__btn'); add.textContent = '＋ Add period';
      add.addEventListener('click', () => { t.rows.push({ cost: '', benefit: '' }); save(); renderNPV(); });
      const go = el('button', 'ds__btn ds__btn--go'); go.textContent = 'Compute → Output';
      go.addEventListener('click', () => runNPV());
      const a = el('div', 'ds__row'); a.append(add, go); body.append(a);
    }
    async function runNPV() {
      const t = state.npv; const res = computeNPV(t.rows, t.rate);
      if (!res) { app.results.appendError('Decisions: add at least one period.'); return; }
      await app.results.beginAnalysis('Cost-benefit (NPV)');
      await app.results.appendText(`Discount rate **${fmt(num(t.rate))}%**. NPV = **${fmt(res.npv)}**; benefit-cost ratio = **${res.bcr == null ? '—' : fmt(res.bcr)}**; discounted payback = **${res.payback == null ? 'never' : 'period ' + res.payback}**.`);
      await app.results.appendTable({ columns: ['Period', 'Cost', 'Benefit', 'Disc. net', 'Cumulative net'], rows: res.detail.map((d) => [String(d.year), fmt(d.cost), fmt(d.benefit), fmt(d.discNet), fmt(d.cumNet)]) });
      await app.results.endAnalysis();
    }

    // --- Tool: Expected value (payoff table) ---------------------------------
    function renderEV() {
      body.textContent = '';
      const m = state.ev;
      const hint = el('p', 'ds__hint');
      hint.textContent = 'List scenarios with probabilities, then each option’s payoff under each. Computes expected value (probabilities normalised), worst case (maximin), and maximum regret (minimax-regret).';
      body.append(hint);
      body.append(Object.assign(el('h3'), { textContent: 'Scenarios' }));
      const st = el('table'); const sth = el('thead'); const str = el('tr');
      for (const h of ['Scenario', 'Probability', '']) { const th = el('th'); th.textContent = h; str.append(th); }
      sth.append(str); st.append(sth); const stb = el('tbody');
      m.scenarios.forEach((s, i) => {
        const tr = el('tr');
        const nameTd = inputCell(s.name, 'text', (v) => { s.name = v; save(); });
        nameTd.querySelector('input').addEventListener('blur', renderEV);
        tr.append(nameTd);
        tr.append(inputCell(s.prob, 'number', (v) => { s.prob = v; save(); }, 'num'));
        const dtd = el('td'); const del = el('button', 'del'); del.textContent = '✕';
        del.addEventListener('click', () => { m.scenarios.splice(i, 1); for (const o of m.options) o.payoffs.splice(i, 1); save(); renderEV(); });
        dtd.append(del); tr.append(dtd); stb.append(tr);
      });
      st.append(stb); body.append(st);
      const addS = el('button', 'ds__btn'); addS.textContent = '＋ Add scenario';
      addS.addEventListener('click', () => { m.scenarios.push({ name: '', prob: '' }); save(); renderEV(); });
      body.append(addS);
      body.append(Object.assign(el('h3'), { textContent: 'Options & payoffs' }));
      const ot = el('table'); const oth = el('thead'); const otr = el('tr');
      const oh = el('th'); oh.textContent = 'Option'; otr.append(oh);
      m.scenarios.forEach((s) => { const th = el('th'); th.textContent = s.name || '(scenario)'; otr.append(th); });
      otr.append(el('th')); oth.append(otr); ot.append(oth); const otb = el('tbody');
      m.options.forEach((o, oi) => {
        const tr = el('tr'); tr.append(inputCell(o.name, 'text', (v) => { o.name = v; save(); }));
        m.scenarios.forEach((s, si) => { tr.append(inputCell(o.payoffs[si], 'number', (v) => { o.payoffs[si] = v; save(); }, 'num')); });
        const dtd = el('td'); const del = el('button', 'del'); del.textContent = '✕';
        del.addEventListener('click', () => { m.options.splice(oi, 1); save(); renderEV(); });
        dtd.append(del); tr.append(dtd); otb.append(tr);
      });
      ot.append(otb); body.append(ot);
      const addO = el('button', 'ds__btn'); addO.textContent = '＋ Add option';
      addO.addEventListener('click', () => { m.options.push({ name: '', payoffs: [] }); save(); renderEV(); });
      const go = el('button', 'ds__btn ds__btn--go'); go.textContent = 'Compute → Output';
      go.addEventListener('click', () => runEV());
      const a = el('div', 'ds__row'); a.append(addO, go); body.append(a);
    }
    async function runEV() {
      const m = state.ev; const res = computeEV(m.scenarios, m.options);
      if (!res.length) { app.results.appendError('Decisions: add at least one option and scenario.'); return; }
      const byEV = res.slice().sort((a, b) => b.ev - a.ev)[0];
      const byMaximin = res.slice().sort((a, b) => b.min - a.min)[0];
      const byRegret = res.slice().sort((a, b) => a.maxRegret - b.maxRegret)[0];
      await app.results.beginAnalysis('Expected value (payoff table)');
      await app.results.appendText(`Best by expected value: **${byEV.name}**. Best worst-case (maximin): **${byMaximin.name}**. Best by minimax-regret: **${byRegret.name}**.`);
      await app.results.appendTable({ columns: ['Option', 'Expected value', 'Worst case', 'Max regret'], rows: res.map((r) => [r.name, fmt(r.ev), fmt(r.min), fmt(r.maxRegret)]) });
      await app.results.endAnalysis();
    }

    // --- Tool: Decision tree (outline editor + fold-back) --------------------
    function renderTree() {
      body.textContent = '';
      const t = state.tree;
      const hint = el('p', 'ds__hint');
      hint.textContent = 'Build the tree as an outline: ▢ decision (pick the best branch), ○ chance (probability-weighted), △ terminal (a payoff). Put a probability on each child of a chance node. “Compute” folds back the expected value, the optimal choice, and a tree diagram.';
      body.append(hint);
      const treeBox = el('div'); body.append(treeBox);
      const drawNode = (node, parent, idx, parentKind, depth) => {
        const row = el('div', 'ds__row'); row.style.marginLeft = depth * 22 + 'px';
        const kindSel = el('select');
        for (const [v, l] of [['decision', '▢ decision'], ['chance', '○ chance'], ['terminal', '△ terminal']]) { const o = el('option'); o.value = v; o.textContent = l; kindSel.append(o); }
        kindSel.value = node.kind;
        kindSel.addEventListener('change', () => { node.kind = kindSel.value; save(); renderTree(); });
        row.append(kindSel);
        if (parentKind === 'chance') {
          const pl = el('span'); pl.textContent = 'p='; pl.style.color = '#7a8590';
          const pi = el('input'); pi.type = 'number'; pi.step = '0.01'; pi.value = node.prob ?? ''; pi.style.width = '64px';
          pi.addEventListener('input', () => { node.prob = pi.value; save(); });
          row.append(pl, pi);
        }
        const li = el('input'); li.type = 'text'; li.value = node.label ?? ''; li.placeholder = 'label'; li.style.minWidth = '130px';
        li.addEventListener('input', () => { node.label = li.value; save(); });
        row.append(li);
        if (node.kind === 'terminal') {
          const vl = el('span'); vl.textContent = 'payoff='; vl.style.color = '#7a8590';
          const vi = el('input'); vi.type = 'number'; vi.value = node.payoff ?? ''; vi.style.width = '90px';
          vi.addEventListener('input', () => { node.payoff = vi.value; save(); });
          row.append(vl, vi);
        } else {
          const addb = el('button', 'ds__btn'); addb.textContent = '＋ child'; addb.style.padding = '2px 7px';
          addb.addEventListener('click', () => { (node.children ||= []).push({ id: uid(), kind: 'terminal', label: '', payoff: 0, prob: '', children: [] }); save(); renderTree(); });
          row.append(addb);
        }
        if (parent) {
          const del = el('button', 'del'); del.textContent = '✕';
          del.addEventListener('click', () => { parent.children.splice(idx, 1); save(); renderTree(); });
          row.append(del);
        }
        treeBox.append(row);
        if (node.kind !== 'terminal') (node.children || []).forEach((c, i) => drawNode(c, node, i, node.kind, depth + 1));
      };
      drawNode(t.root, null, 0, null, 0);
      const go = el('button', 'ds__btn ds__btn--go'); go.textContent = 'Compute → Output'; go.style.marginTop = '10px';
      go.addEventListener('click', () => runTree());
      body.append(go);
    }
    async function runTree() {
      const root = state.tree.root;
      const res = computeTree(root);
      await app.results.beginAnalysis('Decision tree');
      const rootChoice = res.choice != null && root.children?.[res.choice] ? (root.children[res.choice].label || `branch ${res.choice + 1}`) : null;
      await app.results.appendText(`Expected value (fold-back): **${fmt(res.value)}**.${rootChoice ? ` Optimal first decision: **${rootChoice}**.` : ''}`);
      const svg = treeSvg(root);
      if (svg) await app.results.appendPlot(svg);
      await app.results.endAnalysis();
    }

    // --- Tool: Sensitivity & threshold (live in-workspace chart) --------------
    // Reads another tool's model (NPV/EV/tree) and probes how its outcome responds
    // to one input. The chart redraws live as you drag — the exploration happens
    // here, in the workspace; "Send to Output" snapshots the current view.
    function renderSens() {
      body.textContent = '';
      const cfg = state.sens;
      const hint = el('p', 'ds__hint');
      hint.textContent = 'Vary one input and watch the result move — this is where a decision earns trust. One-way traces the outcome across a range and marks the break-even threshold + where the recommendation flips; Tornado ranks every input by how much it swings the result. Drag the slider for a live read; “Send to Output” snapshots the chart.';
      body.append(hint);

      if (!SENS_MODELS[cfg.model]) cfg.model = 'npv';
      const model = SENS_MODELS[cfg.model];
      const params = model.params(state);
      if (!params.some((p) => p.key === cfg.param)) cfg.param = params[0]?.key || '';
      const param = params.find((p) => p.key === cfg.param) || params[0];

      const row1 = el('div', 'ds__row');
      const ml = el('label'); ml.textContent = 'Model:';
      const modelSel = el('select');
      for (const k of Object.keys(SENS_MODELS)) { const o = el('option'); o.value = k; o.textContent = SENS_MODELS[k].label; modelSel.append(o); }
      modelSel.value = cfg.model;
      modelSel.addEventListener('change', () => { cfg.model = modelSel.value; cfg.param = ''; cfg.lo = null; cfg.hi = null; save(); renderSens(); });
      const tl = el('label'); tl.textContent = 'Mode:';
      const modeSel = el('select');
      for (const [v, l] of [['oneway', 'One-way (line)'], ['tornado', 'Tornado']]) { const o = el('option'); o.value = v; o.textContent = l; modeSel.append(o); }
      modeSel.value = cfg.mode === 'tornado' ? 'tornado' : 'oneway';
      modeSel.addEventListener('change', () => { cfg.mode = modeSel.value; save(); renderSens(); });
      row1.append(ml, modelSel, tl, modeSel);
      body.append(row1);

      if (!param) { const e = el('p', 'ds__hint'); e.textContent = `Add inputs in the ${model.label} tool first.`; body.append(e); return; }

      const chart = el('div'); chart.style.cssText = 'margin: 10px 0; overflow: auto;';
      const summary = el('div', 'ds__hint'); summary.style.marginTop = '0';
      let currentSvg = '';

      if (cfg.mode === 'tornado') {
        const sp = el('div', 'ds__row');
        const spl = el('label'); spl.textContent = 'Vary each input by ±%:';
        const spi = el('input'); spi.type = 'number'; spi.value = Math.round((cfg.spread ?? 0.5) * 100); spi.style.width = '80px';
        const baseline = model.evalAt(state, param.key, param.base).y;
        const redrawT = () => {
          const pct = num(spi.value) ?? 50;
          const bars = sensTornado(model, state, params, pct / 100);
          currentSvg = sensTornadoSvg(bars, { title: `${model.label}: tornado (±${Math.round(pct)}%)`, outLabel: model.outLabel, baseline });
          chart.innerHTML = currentSvg;
          summary.textContent = bars.length ? `Most influential: ${bars[0].label} (swings ${model.outLabel} by ${fmt(bars[0].swing)}).` : 'No parameter has a non-zero base to vary.';
        };
        spi.addEventListener('input', () => { cfg.spread = (num(spi.value) ?? 50) / 100; save(); redrawT(); });
        sp.append(spl, spi); body.append(sp, chart, summary);
        redrawT();
      } else {
        const r2 = el('div', 'ds__row');
        const pl = el('label'); pl.textContent = 'Parameter:';
        const paramSel = el('select');
        for (const p of params) { const o = el('option'); o.value = p.key; o.textContent = p.label; paramSel.append(o); }
        paramSel.value = param.key;
        paramSel.addEventListener('change', () => { cfg.param = paramSel.value; cfg.lo = null; cfg.hi = null; save(); renderSens(); });
        r2.append(pl, paramSel); body.append(r2);

        const base = param.base;
        if (cfg.lo == null || cfg.hi == null) { const span = base === 0 ? 1 : Math.abs(base) * 0.5; cfg.lo = base - span; cfg.hi = base + span; }
        const r3 = el('div', 'ds__row');
        const lol = el('label'); lol.textContent = 'From:';
        const loi = el('input'); loi.type = 'number'; loi.value = cfg.lo; loi.style.width = '90px';
        const hil = el('label'); hil.textContent = 'To:';
        const hii = el('input'); hii.type = 'number'; hii.value = cfg.hi; hii.style.width = '90px';
        r3.append(lol, loi, hil, hii); body.append(r3);

        const r4 = el('div', 'ds__row');
        const slider = el('input'); slider.type = 'range'; slider.style.flex = '1';
        const readout = el('span'); readout.style.minWidth = '210px';
        r4.append(slider, readout); body.append(r4, chart, summary);

        const setBounds = () => {
          slider.min = String(cfg.lo); slider.max = String(cfg.hi);
          slider.step = String((cfg.hi - cfg.lo) / 100 || 1);
          if (+slider.value < cfg.lo || +slider.value > cfg.hi) slider.value = String(base);
        };
        const redraw = () => {
          const pts = sensSweep(model, state, param.key, cfg.lo, cfg.hi, 61);
          const thr = sensThreshold(pts, model.reference);
          const flips = sensFlips(pts);
          const at = +slider.value;
          const cur = model.evalAt(state, param.key, at);
          currentSvg = sensLineSvg(pts, { title: `${model.label}: ${param.label}`, xLabel: param.label, yLabel: model.outLabel, reference: model.reference, base, threshold: thr, flips, marker: { x: at, y: cur.y } });
          chart.innerHTML = currentSvg;
          readout.textContent = `${param.label} = ${fmt(at)} → ${model.outLabel} ${fmt(cur.y)}${cur.choice ? ` · ${cur.choice}` : ''}`;
          const bits = [];
          if (thr != null) bits.push(`Break-even (${model.outLabel} = ${fmt(model.reference)}) at ${param.label} = ${fmt(thr)}.`);
          if (flips.length) bits.push(`Recommendation changes at ${flips.map((f) => `${fmt(f.x)} (→ ${f.to})`).join(', ')}.`);
          summary.textContent = bits.join(' ') || 'No threshold crossing within this range — the result is robust here.';
        };
        loi.addEventListener('input', () => { cfg.lo = num(loi.value) ?? cfg.lo; save(); setBounds(); redraw(); });
        hii.addEventListener('input', () => { cfg.hi = num(hii.value) ?? cfg.hi; save(); setBounds(); redraw(); });
        slider.addEventListener('input', redraw);
        setBounds(); slider.value = String(base); redraw();
      }

      const go = el('button', 'ds__btn ds__btn--go'); go.textContent = 'Send to Output'; go.style.marginTop = '10px';
      go.addEventListener('click', async () => {
        if (!currentSvg) return;
        await app.results.beginAnalysis(`Sensitivity — ${model.label}`);
        await app.results.appendText(summary.textContent || `${cfg.mode === 'tornado' ? 'Tornado' : 'One-way'} sensitivity of ${model.outLabel}.`);
        await app.results.appendPlot(currentSvg);
        await app.results.endAnalysis();
      });
      body.append(go);
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

/** Cost-benefit: discount each period's cost/benefit at `ratePct`, then NPV, PVs,
 * benefit-cost ratio, and discounted payback period. Period = row index (0 = now).
 * Exported for unit testing. */
export function computeNPV(rows, ratePct) {
  const r = (num(ratePct) ?? 0) / 100;
  const valid = (rows || []).map((x) => ({ cost: num(x.cost) ?? 0, benefit: num(x.benefit) ?? 0 }));
  if (!valid.length) return null;
  let pvC = 0, pvB = 0, cum = 0, payback = null;
  const detail = valid.map((x, t) => {
    const d = Math.pow(1 + r, t);
    const dc = x.cost / d, db = x.benefit / d;
    cum += db - dc; pvC += dc; pvB += db;
    if (payback === null && cum >= 0) payback = t;
    return { year: t, cost: x.cost, benefit: x.benefit, discNet: db - dc, cumNet: cum };
  });
  return { npv: pvB - pvC, pvCost: pvC, pvBenefit: pvB, bcr: pvC > 0 ? pvB / pvC : null, payback, detail };
}

/** Expected value under uncertainty: per option, EV (probabilities normalised),
 * worst-case payoff (maximin), and max regret (minimax-regret). Exported for tests. */
export function computeEV(scenarios, options) {
  const sc = (scenarios || []).map((s) => ({ prob: num(s.prob) ?? 0 }));
  const opts = options || [];
  if (!opts.length || !sc.length) return [];
  const psum = sc.reduce((a, s) => a + s.prob, 0) || 1;
  const probs = sc.map((s) => s.prob / psum);
  const rows = opts.map((o) => {
    const pays = sc.map((s, i) => num(o.payoffs?.[i]) ?? 0);
    return { name: o.name || '(option)', pays, ev: pays.reduce((a, p, i) => a + probs[i] * p, 0), min: Math.min(...pays) };
  });
  const colMax = sc.map((s, j) => Math.max(...rows.map((o) => o.pays[j])));
  rows.forEach((o) => { o.maxRegret = Math.max(...o.pays.map((p, j) => colMax[j] - p)); });
  return rows.map((o) => ({ name: o.name, ev: o.ev, min: o.min, maxRegret: o.maxRegret }));
}

/** Fold-back (rollback) one decision-tree node: terminal → payoff; chance →
 * probability-weighted average of children (probs normalised); decision → max
 * child, recording which (`choice`). */
function rollTree(node) {
  if (!node) return { value: 0, choice: null };
  if (node.kind === 'terminal') return { value: num(node.payoff) ?? 0, choice: null };
  const kids = node.children || [];
  if (!kids.length) return { value: num(node.payoff) ?? 0, choice: null };
  if (node.kind === 'chance') {
    const psum = kids.reduce((a, k) => a + (num(k.prob) ?? 0), 0) || 1;
    const value = kids.reduce((a, k) => a + ((num(k.prob) ?? 0) / psum) * rollTree(k).value, 0);
    return { value, choice: null };
  }
  let choice = -1, best = -Infinity;
  kids.forEach((k, i) => { const v = rollTree(k).value; if (v > best) { best = v; choice = i; } });
  return { value: best, choice };
}

/** Decision-tree expected value + the optimal choice at the root. Exported for tests. */
export function computeTree(root) {
  return rollTree(root);
}

/** Render a decision tree as an SVG (left→right): ▢ decision, ○ chance, △ terminal;
 * each node labelled with its folded-back value, chance edges with probabilities,
 * the optimal decision branch bolded green. */
function treeSvg(root) {
  if (!root) return null;
  const dx = 150, dy = 44, padX = 24, padY = 18;
  const pos = new Map();
  let leaf = 0;
  const layout = (node, depth) => {
    const kids = node.kind !== 'terminal' ? (node.children || []) : [];
    let y;
    if (!kids.length) { y = padY + leaf * dy + dy / 2; leaf++; }
    else { const ys = kids.map((k) => layout(k, depth + 1)); y = (ys[0] + ys[ys.length - 1]) / 2; }
    pos.set(node, { x: padX + depth * dx, y, depth });
    return y;
  };
  layout(root, 0);
  const depths = [...pos.values()].map((p) => p.depth);
  const W = padX * 2 + Math.max(0, ...depths) * dx + 140;
  const H = padY * 2 + (leaf || 1) * dy;
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="11">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  const edges = (node) => {
    if (node.kind === 'terminal') return;
    const pp = pos.get(node); const r = rollTree(node);
    (node.children || []).forEach((k, i) => {
      const cp = pos.get(k); if (!cp) return;
      const chosen = node.kind === 'decision' && i === r.choice;
      s += `<line x1="${(pp.x + 9).toFixed(1)}" y1="${pp.y.toFixed(1)}" x2="${cp.x.toFixed(1)}" y2="${cp.y.toFixed(1)}" stroke="${chosen ? '#2e7d32' : '#a8b0ba'}" stroke-width="${chosen ? 2.5 : 1}"/>`;
      if (node.kind === 'chance' && k.prob != null && k.prob !== '') s += `<text x="${((pp.x + cp.x) / 2).toFixed(1)}" y="${((pp.y + cp.y) / 2 - 3).toFixed(1)}" fill="#7a8590">p=${esc(k.prob)}</text>`;
      edges(k);
    });
  };
  edges(root);
  for (const [node, p] of pos) {
    const r = rollTree(node);
    if (node.kind === 'decision') s += `<rect x="${(p.x - 8).toFixed(1)}" y="${(p.y - 8).toFixed(1)}" width="16" height="16" fill="#2f6fb0"/>`;
    else if (node.kind === 'chance') s += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="8" fill="#e0a52e"/>`;
    else s += `<path d="M${(p.x - 8).toFixed(1)} ${(p.y - 8).toFixed(1)} L${(p.x - 8).toFixed(1)} ${(p.y + 8).toFixed(1)} L${(p.x + 8).toFixed(1)} ${p.y.toFixed(1)} Z" fill="#555"/>`;
    const label = node.label ? esc(node.label) + ' ' : '';
    const val = node.kind === 'terminal' ? fmt(num(node.payoff) ?? 0) : fmt(r.value);
    s += `<text x="${(p.x + 12).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" fill="#1a1a1a">${label}<tspan fill="#2f6fb0">${val}</tspan></text>`;
  }
  return s + '</svg>';
}

// ---- Sensitivity engine -----------------------------------------------------
// Model adapters expose a tool's inputs as a flat parameter list and a pure
// "evaluate with one input overridden → {outcome, recommended choice}". That
// makes one-way sweeps, thresholds, and tornado diagrams tool-agnostic.

const sclone = (o) => JSON.parse(JSON.stringify(o));
const esc2 = (x) => String(x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export const SENS_MODELS = {
  npv: {
    label: 'Cost-benefit (NPV)', outLabel: 'NPV', reference: 0,
    params(s) {
      const out = [{ key: 'rate', label: 'Discount rate (%)', base: num(s.npv.rate) ?? 0 }];
      (s.npv.rows || []).forEach((r, i) => {
        out.push({ key: `c${i}`, label: `Period ${i} cost`, base: num(r.cost) ?? 0 });
        out.push({ key: `b${i}`, label: `Period ${i} benefit`, base: num(r.benefit) ?? 0 });
      });
      return out;
    },
    evalAt(s, key, val) {
      const rows = (s.npv.rows || []).map((r) => ({ cost: num(r.cost) ?? 0, benefit: num(r.benefit) ?? 0 }));
      let rate = num(s.npv.rate) ?? 0;
      if (key === 'rate') rate = val; else { const m = /^([cb])(\d+)$/.exec(key); if (m && rows[+m[2]]) { if (m[1] === 'c') rows[+m[2]].cost = val; else rows[+m[2]].benefit = val; } }
      const r = computeNPV(rows, rate);
      return { y: r ? r.npv : 0, choice: (r && r.npv >= 0) ? 'Accept' : 'Reject' };
    },
  },
  ev: {
    label: 'Expected value (payoff)', outLabel: 'EV of best option', reference: null,
    params(s) {
      const out = [];
      (s.ev.scenarios || []).forEach((sc, i) => out.push({ key: `prob:${i}`, label: `p(${sc.name || 'scenario ' + (i + 1)})`, base: num(sc.prob) ?? 0 }));
      (s.ev.options || []).forEach((o, oi) => (s.ev.scenarios || []).forEach((sc, si) => out.push({ key: `pay:${oi}:${si}`, label: `${o.name || 'opt ' + (oi + 1)} × ${sc.name || 'sc ' + (si + 1)}`, base: num(o.payoffs?.[si]) ?? 0 })));
      return out;
    },
    evalAt(s, key, val) {
      const scen = (s.ev.scenarios || []).map((x) => ({ name: x.name, prob: num(x.prob) ?? 0 }));
      const opts = (s.ev.options || []).map((o) => ({ name: o.name, payoffs: (s.ev.scenarios || []).map((_, si) => num(o.payoffs?.[si]) ?? 0) }));
      const p = key.split(':');
      if (p[0] === 'prob') { if (scen[+p[1]]) scen[+p[1]].prob = val; }
      else if (opts[+p[1]]) opts[+p[1]].payoffs[+p[2]] = val;
      const res = computeEV(scen, opts);
      if (!res.length) return { y: 0, choice: '—' };
      const best = res.slice().sort((a, b) => b.ev - a.ev)[0];
      return { y: best.ev, choice: best.name };
    },
  },
  tree: {
    label: 'Decision tree', outLabel: 'Expected value', reference: null,
    params(s) {
      const out = [];
      const walk = (node) => {
        if (!node) return;
        if (node.kind === 'terminal') out.push({ key: `pay:${node.id}`, label: `payoff: ${node.label || node.id}`, base: num(node.payoff) ?? 0 });
        (node.children || []).forEach((c) => { if (node.kind === 'chance') out.push({ key: `prob:${c.id}`, label: `p: ${c.label || c.id}`, base: num(c.prob) ?? 0 }); walk(c); });
      };
      walk(s.tree.root);
      return out;
    },
    evalAt(s, key, val) {
      const root = sclone(s.tree.root);
      const [kind, id] = key.split(':');
      const apply = (node) => { if (!node) return; if (node.id === id) { if (kind === 'pay') node.payoff = val; else if (kind === 'prob') node.prob = val; } (node.children || []).forEach(apply); };
      apply(root);
      const r = computeTree(root);
      const choice = r.choice != null && root.children?.[r.choice] ? (root.children[r.choice].label || `branch ${r.choice + 1}`) : '—';
      return { y: r.value, choice };
    },
  },
};

/** Sweep one parameter across [lo,hi], returning [{x, y, choice}]. Exported for tests. */
export function sensSweep(model, state, key, lo, hi, n = 41) {
  n = Math.max(2, n | 0);
  const pts = [];
  for (let i = 0; i < n; i++) { const x = lo + (hi - lo) * (i / (n - 1)); const r = model.evalAt(state, key, x); pts.push({ x, y: r.y, choice: r.choice }); }
  return pts;
}

/** First x where the swept outcome crosses `reference` (linear interp), or null. */
function sensThreshold(pts, reference) {
  if (reference == null) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].y - reference, b = pts[i + 1].y - reference;
    if (a === 0) return pts[i].x;
    if ((a < 0) !== (b < 0)) { const t = a / (a - b); return pts[i].x + t * (pts[i + 1].x - pts[i].x); }
  }
  return null;
}

/** x-values where the recommended choice changes across the sweep. */
function sensFlips(pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].choice !== pts[i + 1].choice) out.push({ x: (pts[i].x + pts[i + 1].x) / 2, from: pts[i].choice, to: pts[i + 1].choice });
  }
  return out;
}

/** Tornado: each parameter's outcome at base·(1∓spread), sorted by |swing|. Exported for tests. */
export function sensTornado(model, state, params, spread = 0.5) {
  return params
    .map((p) => { const lo = model.evalAt(state, p.key, p.base * (1 - spread)).y, hi = model.evalAt(state, p.key, p.base * (1 + spread)).y; return { label: p.label, lo, hi, swing: Math.abs(hi - lo) }; })
    .filter((b) => b.swing > 0)
    .sort((a, b) => b.swing - a.swing);
}

function sensLineSvg(pts, o) {
  const W = 560, H = 300, mL = 64, mR = 18, mT = 32, mB = 48;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (o.reference != null) { ymin = Math.min(ymin, o.reference); ymax = Math.max(ymax, o.reference); }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const px = (x) => mL + (xmax === xmin ? 0 : (x - xmin) / (xmax - xmin)) * (W - mL - mR);
  const py = (y) => H - mB - (y - ymin) / (ymax - ymin) * (H - mT - mB);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="11">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<text x="${mL}" y="18" font-size="12" font-weight="600" fill="#1a1a1a">${esc2(o.title || '')}</text>`;
  // axes
  s += `<line x1="${mL}" y1="${H - mB}" x2="${W - mR}" y2="${H - mB}" stroke="#333"/><line x1="${mL}" y1="${mT}" x2="${mL}" y2="${H - mB}" stroke="#333"/>`;
  // reference line
  if (o.reference != null) s += `<line x1="${mL}" y1="${py(o.reference).toFixed(1)}" x2="${W - mR}" y2="${py(o.reference).toFixed(1)}" stroke="#bbb" stroke-dasharray="3 3"/>`;
  // flips
  for (const f of o.flips || []) s += `<line x1="${px(f.x).toFixed(1)}" y1="${mT}" x2="${px(f.x).toFixed(1)}" y2="${H - mB}" stroke="#e0a52e" stroke-dasharray="4 3"/><text x="${(px(f.x) + 3).toFixed(1)}" y="${mT + 10}" fill="#b07d12">→ ${esc2(f.to)}</text>`;
  // threshold
  if (o.threshold != null) s += `<line x1="${px(o.threshold).toFixed(1)}" y1="${mT}" x2="${px(o.threshold).toFixed(1)}" y2="${H - mB}" stroke="#2e7d32" stroke-width="1.5"/><text x="${(px(o.threshold) + 3).toFixed(1)}" y="${H - mB - 4}" fill="#2e7d32">break-even</text>`;
  // curve
  s += `<polyline fill="none" stroke="#2f6fb0" stroke-width="2" points="${pts.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')}"/>`;
  // base + marker
  if (o.base != null) { const r = pts.find((p) => p.x >= o.base) || pts[0]; if (r) s += `<circle cx="${px(o.base).toFixed(1)}" cy="${py(r.y).toFixed(1)}" r="3" fill="#888"/>`; }
  if (o.marker) s += `<circle cx="${px(o.marker.x).toFixed(1)}" cy="${py(o.marker.y).toFixed(1)}" r="4" fill="#d24"/>`;
  // tick labels
  s += `<text x="${mL}" y="${H - mB + 14}" fill="#555">${fmt(xmin)}</text><text x="${W - mR}" y="${H - mB + 14}" text-anchor="end" fill="#555">${fmt(xmax)}</text>`;
  s += `<text x="${mL - 6}" y="${py(ymax).toFixed(1)}" text-anchor="end" fill="#555">${fmt(ymax)}</text><text x="${mL - 6}" y="${py(ymin).toFixed(1)}" text-anchor="end" fill="#555">${fmt(ymin)}</text>`;
  s += `<text x="${(W / 2).toFixed(0)}" y="${H - 6}" text-anchor="middle" fill="#444">${esc2(o.xLabel || '')}</text>`;
  s += `<text x="14" y="${(H / 2).toFixed(0)}" transform="rotate(-90 14 ${(H / 2).toFixed(0)})" text-anchor="middle" fill="#444">${esc2(o.yLabel || '')}</text>`;
  return s + '</svg>';
}

function sensTornadoSvg(bars, o) {
  if (!bars.length) { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 60" width="400" height="60"><rect width="400" height="60" fill="#fff"/><text x="12" y="34" font-family="system-ui" font-size="12" fill="#777">No parameter has a non-zero base to vary.</text></svg>`; }
  const rowH = 26, mL = 180, mR = 24, mT = 36, mB = 30, W = 600;
  const H = mT + mB + bars.length * rowH;
  const lo = Math.min(...bars.map((b) => Math.min(b.lo, b.hi)), o.baseline ?? Infinity);
  const hi = Math.max(...bars.map((b) => Math.max(b.lo, b.hi)), o.baseline ?? -Infinity);
  const span = hi === lo ? 1 : hi - lo;
  const px = (v) => mL + (v - lo) / span * (W - mL - mR);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="11">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<text x="12" y="18" font-size="12" font-weight="600" fill="#1a1a1a">${esc2(o.title || '')}</text>`;
  if (o.baseline != null) s += `<line x1="${px(o.baseline).toFixed(1)}" y1="${mT - 6}" x2="${px(o.baseline).toFixed(1)}" y2="${H - mB + 4}" stroke="#888" stroke-dasharray="3 3"/><text x="${px(o.baseline).toFixed(1)}" y="${mT - 10}" text-anchor="middle" fill="#777">base ${fmt(o.baseline)}</text>`;
  bars.forEach((b, i) => {
    const y = mT + i * rowH, x0 = px(Math.min(b.lo, b.hi)), x1 = px(Math.max(b.lo, b.hi));
    s += `<rect x="${x0.toFixed(1)}" y="${(y + 3).toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${rowH - 8}" fill="#2f6fb0" opacity="0.85"/>`;
    s += `<text x="${mL - 8}" y="${(y + rowH / 2 + 1).toFixed(1)}" text-anchor="end" fill="#333">${esc2(b.label)}</text>`;
    s += `<text x="${(x1 + 4).toFixed(1)}" y="${(y + rowH / 2 + 1).toFixed(1)}" fill="#555">${fmt(b.swing)}</text>`;
  });
  return s + '</svg>';
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
  const npv = s.npv && typeof s.npv === 'object' ? s.npv : {};
  const ev = s.ev && typeof s.ev === 'object' ? s.ev : {};
  const tree = s.tree && typeof s.tree === 'object' ? s.tree : {};
  const sens = s.sens && typeof s.sens === 'object' ? s.sens : {};
  return {
    version: 1,
    tool: ['icer', 'matrix', 'npv', 'ev', 'tree', 'sens'].includes(s.tool) ? s.tool : 'icer',
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
    npv: {
      rate: num(npv.rate) ?? 5,
      rows: Array.isArray(npv.rows) && npv.rows.length
        ? npv.rows.map((r) => ({ cost: r.cost ?? '', benefit: r.benefit ?? '' }))
        : [{ cost: 1000, benefit: 0 }, { cost: 0, benefit: 400 }, { cost: 0, benefit: 400 }, { cost: 0, benefit: 400 }],
    },
    ev: {
      scenarios: Array.isArray(ev.scenarios) && ev.scenarios.length
        ? ev.scenarios.map((x) => ({ name: String(x.name ?? ''), prob: x.prob ?? '' }))
        : [{ name: 'Good', prob: 0.5 }, { name: 'Bad', prob: 0.5 }],
      options: Array.isArray(ev.options) && ev.options.length
        ? ev.options.map((o) => ({ name: String(o.name ?? ''), payoffs: Array.isArray(o.payoffs) ? o.payoffs.slice() : [] }))
        : [{ name: 'Invest', payoffs: [] }, { name: 'Hold', payoffs: [] }],
    },
    tree: {
      root: tree.root && typeof tree.root === 'object'
        ? tree.root
        : {
            id: uid(), kind: 'decision', label: 'Decision', payoff: 0, prob: '', children: [
              { id: uid(), kind: 'terminal', label: 'Option A', payoff: 100, prob: '', children: [] },
              { id: uid(), kind: 'terminal', label: 'Option B', payoff: 80, prob: '', children: [] },
            ],
          },
    },
    sens: {
      model: ['npv', 'ev', 'tree'].includes(sens.model) ? sens.model : 'npv',
      param: typeof sens.param === 'string' ? sens.param : '',
      mode: sens.mode === 'tornado' ? 'tornado' : 'oneway',
      lo: typeof sens.lo === 'number' ? sens.lo : null,
      hi: typeof sens.hi === 'number' ? sens.hi : null,
      spread: typeof sens.spread === 'number' ? sens.spread : 0.5,
    },
  };
}
