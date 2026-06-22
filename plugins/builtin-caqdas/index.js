/**
 * @file plugins/builtin-caqdas/index.js
 * Built-in WORKSPACE plugin (#67): qualitative coding (CAQDAS).
 *
 * The first real consumer of the plugin-workspace primitive (#93). Adds a
 * "Coding" tab where you pick a dataset text column (one document per row),
 * highlight passages, and tag them with codes — the core CAQDAS loop. Codes and
 * coded segments are an opaque, project-persisted blob (app.state); the source
 * transcripts stay in the dataset (segments reference row id + character span).
 *
 * Runs in a sandboxed iframe: allow-scripts only (so NO window.prompt/alert/
 * confirm — naming is inline), CSP default-src 'none' (styles via a constructed
 * stylesheet + the CSSOM, never inline <style>/attributes). All host access — the
 * documents, the persisted blob, pushing analyses to Output — is via the `app`
 * proxy over the broker.
 *
 * v1 scope: in-workspace analyses (code frequency, segment export to Output);
 * non-overlapping-friendly highlight rendering (overlaps render layered by the
 * first covering code). Menu-invoked analyses that read the blob, and very large
 * document sets (virtualised list), are follow-ups.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-caqdas',
  name: 'Qualitative Coding (CAQDAS)',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Qualitative',
  keywords: ['qualitative', 'coding', 'caqdas', 'transcript', 'codebook', 'content analysis'],
  disciplines: ['qualitative', 'sociology', 'education', 'communication', 'nursing', 'anthropology'],
  workspaces: [{ id: 'caqdas-coding', title: 'Coding' }],
};

/** Distinct, readable highlight colours (assigned round-robin to new codes). */
const PALETTE = ['#ffd166', '#8ecae6', '#a7c957', '#ffadad', '#bdb2ff', '#ffc6ff', '#caffbf', '#fdffb6', '#9bf6ff', '#ffd6a5'];
const uid = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MAX_DOCS = 10000; // v1 cap; virtualise for larger corpora later.

const STYLES = `
:host, body { margin: 0; }
.caqdas { display: flex; flex-direction: column; height: 100%; min-height: 460px; font: 14px system-ui, sans-serif; color: #1a1a1a; }
.caqdas__bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #e2e6ea; flex-wrap: wrap; }
.caqdas__bar label { color: #555; }
.caqdas__bar select, .caqdas__btn { font: inherit; padding: 5px 9px; border: 1px solid #ccd2d8; border-radius: 6px; background: #fff; }
.caqdas__btn { cursor: pointer; background: #f3f6fa; }
.caqdas__btn:hover { background: #e9eff6; }
.caqdas__btn--primary { background: #2f6fb0; color: #fff; border-color: #2f6fb0; }
.caqdas__body { display: flex; flex: 1; min-height: 0; }
.caqdas__docs { width: 230px; border-right: 1px solid #e2e6ea; overflow: auto; flex: none; }
.caqdas__doc { padding: 8px 12px; border-bottom: 1px solid #f0f2f4; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.caqdas__doc:hover { background: #f5f8fb; }
.caqdas__doc.is-active { background: #e6f0fa; font-weight: 500; }
.caqdas__doc .n { color: #8a93a0; font-size: 12px; margin-right: 6px; }
.caqdas__doc .c { color: #2f6fb0; font-size: 11px; float: right; }
.caqdas__text { flex: 1; overflow: auto; padding: 16px 20px; white-space: pre-wrap; line-height: 1.7; min-width: 0; }
.caqdas__text mark { border-radius: 2px; padding: 0 1px; cursor: pointer; }
.caqdas__empty { color: #99a1ab; font-style: italic; padding: 24px; }
.caqdas__codes { width: 240px; border-left: 1px solid #e2e6ea; overflow: auto; flex: none; padding: 8px; }
.caqdas__codes h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #7a8590; margin: 6px 6px 8px; }
.caqdas__code { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; }
.caqdas__code:hover { background: #f5f8fb; }
.caqdas__sw { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.caqdas__code .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__code .ct { color: #8a93a0; font-size: 12px; }
.caqdas__code .x { cursor: pointer; color: #b04a4a; border: 0; background: none; font: inherit; padding: 0 4px; }
.caqdas__newcode { display: flex; gap: 6px; padding: 8px 6px; }
.caqdas__newcode input { flex: 1; min-width: 0; font: inherit; padding: 5px 8px; border: 1px solid #ccd2d8; border-radius: 6px; }
.caqdas__menu { position: absolute; z-index: 20; background: #fff; border: 1px solid #ccd2d8; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 6px; min-width: 180px; max-height: 260px; overflow: auto; }
.caqdas__menu button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none; font: inherit; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.caqdas__menu button:hover { background: #eef5fb; }
.caqdas__menu .row { display: flex; gap: 6px; padding: 6px 4px 2px; border-top: 1px solid #eef0f2; margin-top: 4px; }
.caqdas__menu .row input { flex: 1; min-width: 0; font: inherit; padding: 5px 8px; border: 1px solid #ccd2d8; border-radius: 6px; }
`;

export const workspace = {
  async mount(app, root) {
    // --- state ---------------------------------------------------------------
    const raw = await app.state.get();
    const state = normalize(raw);
    let docs = []; // [{ rid, text }]
    let activeRid = null;
    let saveTimer = null;
    const save = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => app.state.set(state), 300);
    };

    // --- shell ---------------------------------------------------------------
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      const s = document.createElement('style'); // fallback if constructed sheets blocked
      s.textContent = STYLES;
      document.head.append(s);
    }
    root.textContent = '';
    const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
    const wrap = el('div', 'caqdas');

    const bar = el('div', 'caqdas__bar');
    const colLabel = el('label'); colLabel.textContent = 'Transcript column:';
    const colSel = el('select');
    const freqBtn = el('button', 'caqdas__btn'); freqBtn.textContent = 'Code frequency';
    const expBtn = el('button', 'caqdas__btn'); expBtn.textContent = 'Segments → Output';
    bar.append(colLabel, colSel, freqBtn, expBtn);

    const body = el('div', 'caqdas__body');
    const docList = el('div', 'caqdas__docs');
    const textPane = el('div', 'caqdas__text');
    const codePane = el('div', 'caqdas__codes');
    body.append(docList, textPane, codePane);

    wrap.append(bar, body);
    root.append(wrap);

    // --- column picker -------------------------------------------------------
    const meta = await app.data.getVariableMeta();
    const textCols = meta.filter((m) => m.type !== 'numeric').map((m) => m.name);
    const opt0 = el('option'); opt0.value = ''; opt0.textContent = textCols.length ? '— choose —' : '(no text columns)';
    colSel.append(opt0);
    for (const name of textCols) { const o = el('option'); o.value = name; o.textContent = name; colSel.append(o); }
    if (state.textColumn && textCols.includes(state.textColumn)) colSel.value = state.textColumn;

    colSel.addEventListener('change', async () => {
      state.textColumn = colSel.value || null;
      save();
      await loadDocs();
      renderAll();
    });

    async function loadDocs() {
      docs = [];
      activeRid = null;
      if (!state.textColumn) return;
      const rows = await app.data.getRows({ variables: [state.textColumn], includeRowId: true, limit: MAX_DOCS });
      docs = rows.map((r) => ({ rid: String(r.__rid), text: String(r[state.textColumn] ?? '') }));
      activeRid = docs.length ? docs[0].rid : null;
    }

    // --- rendering -----------------------------------------------------------
    function codeById(id) { return state.codes.find((c) => c.id === id); }
    function segsFor(rid) { return state.segments.filter((s) => s.doc === rid); }

    function renderDocList() {
      docList.textContent = '';
      if (!docs.length) {
        const e = el('div', 'caqdas__empty');
        e.textContent = state.textColumn ? 'No rows.' : 'Pick a transcript column to begin.';
        docList.append(e);
        return;
      }
      docs.forEach((d, i) => {
        const row = el('div', 'caqdas__doc' + (d.rid === activeRid ? ' is-active' : ''));
        const n = el('span', 'n'); n.textContent = '#' + (i + 1);
        const cnt = segsFor(d.rid).length;
        const c = el('span', 'c'); if (cnt) c.textContent = cnt + '▮';
        const t = document.createTextNode(' ' + (d.text.slice(0, 40) || '(empty)'));
        row.append(n, c, t);
        row.addEventListener('click', () => { activeRid = d.rid; renderDocList(); renderText(); });
        docList.append(row);
      });
    }

    function renderText() {
      textPane.textContent = '';
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) { const e = el('div', 'caqdas__empty'); e.textContent = 'Select a document.'; textPane.append(e); return; }
      const segs = segsFor(doc.rid).slice().sort((a, b) => a.start - b.start || a.end - b.end);
      // Boundary-split the text so overlapping codes still render; each run is
      // coloured by the FIRST covering segment (v1).
      const bounds = new Set([0, doc.text.length]);
      for (const s of segs) { bounds.add(Math.max(0, s.start)); bounds.add(Math.min(doc.text.length, s.end)); }
      const points = [...bounds].filter((p) => p >= 0 && p <= doc.text.length).sort((a, b) => a - b);
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        if (b <= a) continue;
        const slice = doc.text.slice(a, b);
        const covering = segs.filter((s) => s.start <= a && s.end >= b);
        if (!covering.length) { textPane.append(document.createTextNode(slice)); continue; }
        const m = el('mark');
        const code = codeById(covering[0].codeId);
        m.style.backgroundColor = code ? code.color : '#eee';
        m.title = covering.map((s) => codeById(s.codeId)?.name).filter(Boolean).join(', ');
        m.textContent = slice;
        // Click a highlight to remove the topmost covering segment.
        m.addEventListener('click', (e) => {
          e.stopPropagation();
          const top = covering[0];
          state.segments = state.segments.filter((s) => s !== top);
          save(); renderText(); renderDocList(); renderCodes();
        });
        textPane.append(m);
      }
    }

    function renderCodes() {
      codePane.textContent = '';
      const h = el('h3'); h.textContent = 'Codebook'; codePane.append(h);
      const counts = {};
      for (const s of state.segments) counts[s.codeId] = (counts[s.codeId] || 0) + 1;
      for (const code of state.codes) {
        const r = el('div', 'caqdas__code');
        const sw = el('span', 'caqdas__sw'); sw.style.backgroundColor = code.color;
        const nm = el('span', 'nm'); nm.textContent = code.name;
        const ct = el('span', 'ct'); ct.textContent = counts[code.id] || 0;
        const x = el('button', 'x'); x.textContent = '✕'; x.title = 'Delete code + its segments';
        x.addEventListener('click', () => {
          state.codes = state.codes.filter((c) => c.id !== code.id);
          state.segments = state.segments.filter((s) => s.codeId !== code.id);
          save(); renderAll();
        });
        r.append(sw, nm, ct, x);
        codePane.append(r);
      }
      // inline "new code"
      const nc = el('div', 'caqdas__newcode');
      const inp = el('input'); inp.placeholder = 'New code…';
      const add = el('button', 'caqdas__btn'); add.textContent = '＋';
      const commit = () => {
        const name = inp.value.trim();
        if (!name) return;
        state.codes.push({ id: uid(), name, color: PALETTE[state.codes.length % PALETTE.length] });
        inp.value = ''; save(); renderCodes();
      };
      add.addEventListener('click', commit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      nc.append(inp, add);
      codePane.append(nc);
    }

    function renderAll() { renderDocList(); renderText(); renderCodes(); }

    // --- coding: select text → assign a code --------------------------------
    let menu = null;
    const closeMenu = () => { menu?.remove(); menu = null; };
    document.addEventListener('click', closeMenu);
    // The coding tab is a focused app surface: suppress the browser's native
    // context menu so a right-click doesn't compete with (or double up on) the
    // code-assign menu. Coding is left-select → menu (see the button guard below).
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    textPane.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return; // left-button selections only
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!textPane.contains(range.commonAncestorContainer)) return;
      const start = offsetWithin(textPane, range.startContainer, range.startOffset);
      const end = offsetWithin(textPane, range.endContainer, range.endOffset);
      const lo = Math.min(start, end), hi = Math.max(start, end);
      if (hi <= lo) return;
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) return;
      const text = doc.text.slice(lo, hi);
      openAssignMenu(lo, hi, text, range);
    });

    function openAssignMenu(lo, hi, text, range) {
      closeMenu();
      menu = el('div', 'caqdas__menu');
      const assign = (codeId) => {
        state.segments.push({ doc: activeRid, codeId, start: lo, end: hi, text });
        save(); closeMenu();
        document.getSelection()?.removeAllRanges();
        renderText(); renderDocList(); renderCodes();
      };
      for (const code of state.codes) {
        const b = el('button');
        const sw = el('span', 'caqdas__sw'); sw.style.backgroundColor = code.color;
        const nm = document.createTextNode(code.name);
        b.append(sw, nm);
        b.addEventListener('click', (e) => { e.stopPropagation(); assign(code.id); });
        menu.append(b);
      }
      const row = el('div', 'row');
      const inp = el('input'); inp.placeholder = 'New code from selection…';
      row.append(inp);
      const mk = () => {
        const name = inp.value.trim();
        if (!name) return;
        const code = { id: uid(), name, color: PALETTE[state.codes.length % PALETTE.length] };
        state.codes.push(code); assign(code.id);
      };
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); mk(); } });
      menu.append(row);
      // position near the selection
      const rect = range.getBoundingClientRect();
      menu.style.left = Math.round(rect.left) + 'px';
      menu.style.top = Math.round(rect.bottom + 4) + 'px';
      document.body.append(menu);
      setTimeout(() => inp.focus(), 0);
    }

    // --- analyses (in-workspace → Output) ------------------------------------
    freqBtn.addEventListener('click', () => {
      const counts = {};
      for (const s of state.segments) counts[s.codeId] = (counts[s.codeId] || 0) + 1;
      const rows = state.codes.map((c) => [c.name, counts[c.id] || 0]);
      if (!rows.length) { app.results.appendError('No codes yet — create some in the Coding tab.'); return; }
      app.results.appendText('### Code frequency');
      app.results.appendTable({ columns: ['Code', 'Segments'], rows });
    });

    expBtn.addEventListener('click', () => {
      if (!state.segments.length) { app.results.appendError('No coded segments yet.'); return; }
      const byRid = Object.fromEntries(docs.map((d, i) => [d.rid, i + 1]));
      const rows = state.segments.map((s) => [byRid[s.doc] ?? '?', codeById(s.codeId)?.name ?? '?', s.text]);
      app.results.appendText('### Coded segments');
      app.results.appendTable({ columns: ['Doc #', 'Code', 'Text'], rows });
    });

    // --- go ------------------------------------------------------------------
    await loadDocs();
    renderAll();
  },
};

/** Coerce a loaded/empty blob into the working shape. */
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    textColumn: typeof s.textColumn === 'string' ? s.textColumn : null,
    codes: Array.isArray(s.codes) ? s.codes.filter((c) => c && c.id) : [],
    segments: Array.isArray(s.segments) ? s.segments.filter((x) => x && x.doc && x.codeId) : [],
  };
}

/** Absolute character offset of (node, offset) within `container`'s text — so a
 * selection over highlight spans maps back to the raw document text (the spans
 * wrap exact substrings, so concatenated text === raw text). */
function offsetWithin(container, node, offset) {
  let total = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return total + offset;
    total += n.nodeValue.length;
  }
  return total + offset;
}
