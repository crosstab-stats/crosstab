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
  version: '0.6.0',
  apiVersion: '0.1.0',
  category: 'Qualitative',
  // Renders media (text, image regions, audio/video time-ranges) from the host media
  // store, so it mounts in the media-CSP sandbox (img-src/media-src blob:). #139.
  media: true,
  keywords: ['qualitative', 'coding', 'caqdas', 'transcript', 'codebook', 'content analysis', 'image', 'audio', 'video', 'media'],
  disciplines: ['Qualitative', 'Sociology', 'Education', 'Communication', 'Nursing', 'Anthropology'],
  howto:
    'GUI: appears as a workspace tab (Coding) — pick a dataset column of documents (a text column, or a media column from an image/audio/video import), then tag passages/regions with codes and export code frequencies/segments to Output.\n' +
    'Used through its workspace tab, not a run command.',
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
.caqdas__paint { display: none; align-items: center; gap: 10px; padding: 6px 12px; background: #2f6fb0; color: #fff; font-size: 13px; }
.caqdas__paint.is-on { display: flex; }
.caqdas__paint .stop { margin-left: auto; cursor: pointer; border: 1px solid rgba(255,255,255,.6); background: transparent; color: #fff; font: inherit; border-radius: 6px; padding: 2px 8px; }
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
.caqdas__codes h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #7a8590; margin: 6px 6px 4px; }
.caqdas__hint { font-size: 12px; color: #8a93a0; margin: 0 6px 10px; line-height: 1.4; transition: color .15s; }
.caqdas__code { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.caqdas__code:hover { background: #f5f8fb; }
.caqdas__code.is-armed { outline: 2px solid #2f6fb0; outline-offset: -2px; background: #eef5fb; }
.caqdas__code .pb { cursor: pointer; border: 0; background: none; font: inherit; padding: 0 4px; opacity: .45; }
.caqdas__code:hover .pb { opacity: .8; }
.caqdas__code .pb.is-on { opacity: 1; }
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
.caqdas__group { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #9aa3ab; font-weight: 600; margin: 16px 6px 2px; }
.caqdas__group--none { font-weight: 500; font-style: italic; text-transform: none; letter-spacing: 0; color: #b3bac1; }
.caqdas__code .caqdas__iconbtn { cursor: pointer; border: 0; background: none; font: inherit; padding: 0 3px; opacity: .4; }
.caqdas__code:hover .caqdas__iconbtn { opacity: .8; }
.caqdas__code .caqdas__iconbtn.has { opacity: .95; }
.caqdas__details { display: flex; flex-direction: column; gap: 6px; margin: 0 6px 8px; }
.caqdas__details .caqdas__grpinp { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid #ccd2d8; border-radius: 6px; }
.caqdas__details .caqdas__memo { font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid #ccd2d8; border-radius: 6px; resize: vertical; }
.caqdas__retrhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.caqdas__retrhead h3 { margin: 0; }
.caqdas__retr { border: 1px solid #e2e6ea; border-radius: 6px; padding: 8px 10px; margin: 8px 0; cursor: pointer; }
.caqdas__retr:hover { background: #f5f8fb; }
.caqdas__retr .rl { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #7a8590; margin-bottom: 3px; }
.caqdas__retr .rl > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__retr .rl .caqdas__segrm { flex: 0 0 auto; font-size: 13px; line-height: 1; }
mark.has-memo { box-shadow: inset 0 -2px 0 rgba(0,0,0,.35); }
.caqdas__seghead { display: flex; align-items: center; gap: 8px; padding: 4px 4px 2px; }
.caqdas__seghead .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__segrm { border: 0; background: none; font: inherit; color: #b04a4a; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.caqdas__segrm:hover { background: #fbeaea; }
.caqdas__segmemo { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid #ccd2d8; border-radius: 6px; resize: vertical; margin: 0 0 6px; }
/* --- media (image) coding --- */
.caqdas__imgwrap { position: relative; display: inline-block; max-width: 100%; margin: 0 auto; line-height: 0; }
.caqdas__img { display: block; max-width: 100%; max-height: calc(100vh - 220px); user-select: none; -webkit-user-select: none; }
.caqdas__overlay { position: absolute; inset: 0; cursor: crosshair; }
.caqdas__region { position: absolute; border: 2px solid; box-sizing: border-box; pointer-events: none; }
.caqdas__region .caqdas__rlabel { position: absolute; top: -18px; left: -2px; font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 3px 3px 0 0; color: #fff; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.caqdas__region.has-memo { box-shadow: 0 0 0 2px rgba(0,0,0,.35) inset; }
.caqdas__regionsel { position: absolute; border: 2px dashed #2f6fb0; background: rgba(47,111,176,.12); box-sizing: border-box; pointer-events: none; }
.caqdas__mediahint { font-size: 12px; color: #8a93a0; padding: 8px 20px 0; }
/* --- media (audio/video) coding: player + timeline lanes --- */
.caqdas__audioel { width: 100%; max-width: 640px; display: block; margin: 8px 20px 0; }
.caqdas__vidwrap { position: relative; display: inline-block; max-width: calc(100% - 40px); margin: 8px 20px 0; line-height: 0; }
.caqdas__video { display: block; max-width: 100%; max-height: calc(100vh - 340px); background: #000; }
.caqdas__vidoverlay { position: absolute; inset: 0; pointer-events: none; }
.caqdas__vidoverlay.is-drawing { pointer-events: auto; cursor: crosshair; }
.caqdas__trackbox { position: absolute; border: 2px solid; box-sizing: border-box; pointer-events: none; }
.caqdas__trackbox.is-active { box-shadow: 0 0 0 1px rgba(0,0,0,.4), 0 0 0 3px rgba(255,255,255,.35); }
.caqdas__trackbox.is-editing { pointer-events: auto; cursor: move; }
.caqdas__trackbox.is-editing .caqdas__rlabel { pointer-events: none; }
.caqdas__handle { position: absolute; width: 11px; height: 11px; background: #fff; border: 1px solid #2f6fb0; box-sizing: border-box; border-radius: 2px; }
.caqdas__h-nw { left: -6px; top: -6px; cursor: nwse-resize; }
.caqdas__h-ne { right: -6px; top: -6px; cursor: nesw-resize; }
.caqdas__h-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.caqdas__h-sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.caqdas__h-n { left: 50%; top: -6px; margin-left: -6px; cursor: ns-resize; }
.caqdas__h-s { left: 50%; bottom: -6px; margin-left: -6px; cursor: ns-resize; }
.caqdas__h-e { right: -6px; top: 50%; margin-top: -6px; cursor: ew-resize; }
.caqdas__h-w { left: -6px; top: 50%; margin-top: -6px; cursor: ew-resize; }
.caqdas__tracktb { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 20px 0; }
.caqdas__tracklabel { font-size: 12px; font-weight: 600; }
.caqdas__tracktb .caqdas__btn { font-size: 12px; padding: 3px 8px; }
.caqdas__lanebar.is-track { box-shadow: inset 0 0 0 1px rgba(255,255,255,.6); border-radius: 5px; }
.caqdas__mediactrl { display: flex; align-items: center; gap: 6px; padding: 8px 20px 0; }
.caqdas__speedlabel { font-size: 12px; color: #7a8590; margin-right: 2px; }
.caqdas__speedbtn { font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid #ccd2d8; border-radius: 6px; background: #fff; cursor: pointer; }
.caqdas__speedbtn.is-on { background: #2f6fb0; color: #fff; border-color: #2f6fb0; }
.caqdas__transport { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 20px; background: #eef2f6; border-top: 1px solid #e2e6ea; border-bottom: 1px solid #e2e6ea; }
.caqdas__ctlbtn { font: inherit; font-size: 12px; padding: 3px 9px; border: 1px solid #ccd2d8; border-radius: 6px; background: #fff; cursor: pointer; }
.caqdas__ctlbtn.is-on { background: #2f6fb0; color: #fff; border-color: #2f6fb0; }
.caqdas__playbtn { min-width: 40px; font-size: 12px; }
.caqdas__regionbtn { margin-left: auto; }
.caqdas__timeline { padding: 6px 20px 16px; }
.caqdas__tltrack { position: relative; height: 22px; background: #eef1f4; border: 1px solid #e2e6ea; border-radius: 4px; cursor: crosshair; overflow: hidden; touch-action: none; }
.caqdas__tlsel { position: absolute; top: 0; bottom: 0; background: rgba(47,111,176,.18); border-left: 2px solid #2f6fb0; border-right: 2px solid #2f6fb0; box-sizing: border-box; pointer-events: none; }
.caqdas__playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #b04a4a; pointer-events: none; }
.caqdas__scrub { position: absolute; top: 0; bottom: 0; width: 16px; margin-left: -8px; cursor: ew-resize; z-index: 3; touch-action: none; }
.caqdas__scrub::before { content: ''; position: absolute; top: 1px; bottom: 1px; left: 5px; width: 6px; background: rgba(176,74,74,.28); border-radius: 3px; }
.caqdas__scrub:hover::before { background: rgba(176,74,74,.5); }
.caqdas__vol { width: 84px; vertical-align: middle; }
.caqdas__lanes { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.caqdas__lane { display: flex; align-items: center; gap: 8px; }
.caqdas__lanelabel { flex: 0 0 120px; font-size: 12px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__lanestrip { position: relative; flex: 1; height: 16px; background: #f5f7f9; border-radius: 3px; }
.caqdas__lanebar { position: absolute; top: 1px; bottom: 1px; min-width: 3px; border-radius: 3px; cursor: pointer; opacity: .85; }
.caqdas__lanebar:hover { opacity: 1; }
.caqdas__lanebar.has-memo { box-shadow: inset 0 0 0 2px rgba(0,0,0,.35); }
.caqdas__lanesempty { font-size: 12px; color: #99a1ab; font-style: italic; padding: 4px 0; }
`;

export const workspace = {
  async mount(app, root) {
    // --- state ---------------------------------------------------------------
    const raw = await app.state.get();
    const state = normalize(raw);
    let docs = []; // [{ rid, text }]
    let activeRid = null;
    let activeCodeId = null; // armed code for "paint mode" (session-only, not saved)
    let retrieveCodeId = null; // when set, the transcript pane shows this code's segments
    const memoOpen = new Set(); // code ids whose memo editor is expanded (session-only)
    // --- media (image) session state -----------------------------------------
    let mediaObjectUrl = null; // object URL of the loaded media blob (revoked on doc switch)
    let mediaLoadToken = 0; // guards against a slow load landing after a doc switch
    let imageSel = null; // pending drawn region {x,y,w,h} (normalised 0..1), session-only
    let currentOverlay = null; // the live image overlay, for in-place region refreshes
    let timeSel = null; // pending drawn time span {tStart,tEnd} (seconds), session-only
    let currentTimeline = null, currentLanes = null, currentMediaEl = null; // live audio/video timeline refs
    let currentMedium = null; // 'image' | 'audio' | 'video' of the loaded doc
    // --- video spatiotemporal (region-over-time) state ------------------------
    let activeTrack = null; // the keyframed region segment being edited (or null)
    let videoSel = null; // pending drawn box on a video frame (for a NEW track)
    let currentVideoOverlay = null; // the live video frame overlay
    let trackToolbarEl = null; // the track-editing toolbar element
    let tracking = false; // the auto-tracker loop is running
    const hiddenCodes = new Set(); // codes whose regions/lanes are hidden (per-code layer visibility, session-only)
    const docActive = () => docs.find((d) => d.rid === activeRid);
    const docLabel = (rid) => {
      const i = docs.findIndex((d) => d.rid === rid);
      return (i >= 0 && docs[i].label) || `#${i + 1}`;
    };
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
    const colLabel = el('label'); colLabel.textContent = 'Documents column:';
    const colSel = el('select');
    const labelLabel = el('label'); labelLabel.textContent = 'Label by:';
    const labelSel = el('select');
    labelSel.title = 'Column that identifies each document (e.g. a filename or participant id) — used in the document list and the segments export.';
    const freqBtn = el('button', 'caqdas__btn'); freqBtn.textContent = 'Code frequency';
    const expBtn = el('button', 'caqdas__btn'); expBtn.textContent = 'Segments → Output';
    const cloudBtn = el('button', 'caqdas__btn'); cloudBtn.textContent = 'Word cloud';
    cloudBtn.title = 'Word cloud of the coded passages — grouped and coloured by your codebook themes.';
    bar.append(colLabel, colSel, labelLabel, labelSel, freqBtn, expBtn, cloudBtn);

    // Paint-mode banner (shown while a code is armed).
    const paintBanner = el('div', 'caqdas__paint');
    const paintMsg = el('span');
    const stopBtn = el('button', 'stop'); stopBtn.textContent = 'Stop (Esc)';
    paintBanner.append(paintMsg, stopBtn);

    const body = el('div', 'caqdas__body');
    const docList = el('div', 'caqdas__docs');
    const textPane = el('div', 'caqdas__text');
    const codePane = el('div', 'caqdas__codes');
    body.append(docList, textPane, codePane);

    wrap.append(bar, paintBanner, body);
    root.append(wrap);

    // --- paint mode: arm a code, then selections auto-apply it ---------------
    function updatePaintUI() {
      const c = activeCodeId ? codeById(activeCodeId) : null;
      paintBanner.classList.toggle('is-on', !!c);
      if (c) paintMsg.textContent = `🖌 Painting with "${c.name}" — select passages to apply it.`;
      textPane.style.cursor = c ? 'crosshair' : '';
    }
    function setArmed(codeId) {
      activeCodeId = activeCodeId === codeId ? null : codeId; // toggle
      updatePaintUI();
      renderCodes();
    }
    const disarm = () => { if (activeCodeId) { activeCodeId = null; updatePaintUI(); renderCodes(); } };
    stopBtn.addEventListener('click', disarm);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarm(); });

    // --- column picker -------------------------------------------------------
    // Build (and re-build) the pickers from the ACTIVE dataset's variables. Re-runnable
    // so the tab can refresh when it's shown — the active dataset may have changed since
    // mount (e.g. a just-imported one), and the picker is otherwise frozen. Returns
    // whether the codeable-column set changed, so the caller can skip a needless reload.
    let lastColsSig = null;
    async function populateColumns() {
      const meta = await app.data.getVariableMeta();
      const cols = meta.filter((m) => m.type !== 'numeric').map((m) => m.name);
      const sig = cols.join('');
      // Document (codeable) column.
      colSel.textContent = '';
      const opt0 = el('option'); opt0.value = ''; opt0.textContent = cols.length ? '— choose —' : '(no columns to code)';
      colSel.append(opt0);
      for (const name of cols) { const o = el('option'); o.value = name; o.textContent = name; colSel.append(o); }
      if (state.textColumn && !cols.includes(state.textColumn)) state.textColumn = null; // stale (dataset changed)
      colSel.value = state.textColumn || '';
      // "Label by" — the column that identifies each document (filename, participant id,
      // …), for the doc list + segments export. Any column qualifies; default Row number.
      labelSel.textContent = '';
      const lopt0 = el('option'); lopt0.value = ''; lopt0.textContent = 'Row number'; labelSel.append(lopt0);
      for (const m of meta) { const o = el('option'); o.value = m.name; o.textContent = m.name; labelSel.append(o); }
      if (!state.labelColumn || !meta.some((m) => m.name === state.labelColumn)) {
        // Auto-pick a source-attribution-looking column (e.g. the importers' `name`).
        // Memory-only — never save() here (a mount-time write can clobber a not-yet-
        // hydrated codebook); it's deterministic and re-derived, persisted on real edits.
        state.labelColumn = meta.map((m) => m.name)
          .find((n) => n !== state.textColumn && /^(document|source|file|filename|doc|id|name|participant|case|respondent|speaker)$/i.test(n)) || null;
      }
      labelSel.value = state.labelColumn || '';
      const changed = sig !== lastColsSig;
      lastColsSig = sig;
      return changed;
    }

    colSel.addEventListener('change', async () => {
      state.textColumn = colSel.value || null;
      save();
      await loadDocs();
      renderAll();
    });
    labelSel.addEventListener('change', async () => {
      state.labelColumn = labelSel.value || null;
      save();
      await loadDocs();
      renderAll();
    });

    await populateColumns();

    async function loadDocs() {
      docs = [];
      activeRid = null;
      if (!state.textColumn) return;
      const vars = [state.textColumn];
      if (state.labelColumn && state.labelColumn !== state.textColumn) vars.push(state.labelColumn);
      const rows = await app.data.getRows({ variables: vars, includeRowId: true, limit: MAX_DOCS });
      docs = rows.map((r) => {
        const raw = String(r[state.textColumn] ?? '');
        const label = state.labelColumn && r[state.labelColumn] != null ? String(r[state.labelColumn]) : '';
        // A media column holds a JSON array of `asset:`/`data:` refs (list-shaped even
        // for a single clip). Anything else is a plain text document.
        const refs = parseMediaRefs(raw);
        return refs
          ? { rid: String(r.__rid), kind: 'media', refs, label }
          : { rid: String(r.__rid), kind: 'text', text: raw, label };
      });
      activeRid = docs.length ? docs[0].rid : null;
    }

    // --- rendering -----------------------------------------------------------
    function codeById(id) { return state.codes.find((c) => c.id === id); }
    function segsFor(rid) { return state.segments.filter((s) => s.doc === rid); }

    function renderDocList() {
      docList.textContent = '';
      if (!docs.length) {
        const e = el('div', 'caqdas__empty');
        e.textContent = state.textColumn ? 'No rows.' : 'Pick a column of documents (text or media) to begin.';
        docList.append(e);
        return;
      }
      docs.forEach((d, i) => {
        const row = el('div', 'caqdas__doc' + (d.rid === activeRid ? ' is-active' : ''));
        const n = el('span', 'n'); n.textContent = d.label || '#' + (i + 1);
        const cnt = segsFor(d.rid).length;
        const c = el('span', 'c'); if (cnt) c.textContent = cnt + '▮';
        const preview = d.kind === 'media' ? '▸ media' : (d.text.slice(0, 40) || '(empty)');
        const t = document.createTextNode(' ' + preview);
        row.append(n, c, t);
        row.addEventListener('click', () => { activeRid = d.rid; renderDocList(); renderText(); });
        docList.append(row);
      });
    }

    function renderText() {
      textPane.textContent = '';
      if (retrieveCodeId) { renderRetrieve(); return; }
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) { const e = el('div', 'caqdas__empty'); e.textContent = 'Select a document.'; textPane.append(e); return; }
      if (doc.kind === 'media') { void renderMedia(doc); return; }
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
        const memoed = covering.some((s) => s.memo);
        m.title = covering.map((s) => codeById(s.codeId)?.name + (s.memo ? ` — ${s.memo}` : '')).filter(Boolean).join(', ');
        if (memoed) m.classList.add('has-memo');
        m.textContent = slice;
        // Click a highlight to open its segment popup (memo + remove per covering code).
        m.addEventListener('click', (e) => { e.stopPropagation(); openSegmentMenu(covering, e); });
        textPane.append(m);
      }
    }

    // Retrieve-by-code: the transcript pane lists every segment carrying one code,
    // across all documents — the core "show me everything I called X" move. Click an
    // item to jump to its document.
    function renderRetrieve() {
      const code = codeById(retrieveCodeId);
      const head = el('div', 'caqdas__retrhead');
      const back = el('button', 'caqdas__btn'); back.textContent = '← Back';
      back.addEventListener('click', () => { retrieveCodeId = null; renderText(); });
      const h = el('h3'); h.textContent = code ? `Coded “${code.name}”` : 'Coded segments';
      head.append(back, h); textPane.append(head);
      const segs = state.segments.filter((s) => s.codeId === retrieveCodeId);
      if (!segs.length) { const e = el('div', 'caqdas__empty'); e.textContent = 'No passages carry this code yet.'; textPane.append(e); return; }
      for (const s of segs) {
        const item = el('div', 'caqdas__retr');
        const rl = el('div', 'rl');
        const lab = el('span'); lab.textContent = docLabel(s.doc); rl.append(lab);
        // Delete this coding straight from the list — faster than finding the
        // highlight in the transcript and removing it there. Removes only THIS
        // segment (the code itself stays in the codebook).
        const rm = el('button', 'caqdas__segrm'); rm.textContent = '✕'; rm.title = 'Remove this coding';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          state.segments = state.segments.filter((x) => x !== s);
          save(); renderText(); renderDocList(); renderCodes(); // renderText re-runs the retrieve list
        });
        rl.append(rm);
        item.append(rl);
        const tx = el('div'); tx.textContent = s.text; item.append(tx);
        item.addEventListener('click', () => { activeRid = s.doc; retrieveCodeId = null; renderDocList(); renderText(); });
        textPane.append(item);
      }
    }

    // --- media (image) coding ------------------------------------------------
    // The image analogue of the text coder: the selector is a 2-D region (normalised
    // 0..1 so it survives any display size) instead of a character span. Everything
    // else — codebook, retrieve, memos, frequencies, export — is shared. The media is
    // never inlined in the dataset; the host hands us a Blob via app.media.load and we
    // render it from an in-realm blob: URL (allowed by the media-CSP sandbox).
    async function renderMedia(doc) {
      textPane.textContent = '';
      imageSel = null; timeSel = null;
      currentOverlay = null; currentTimeline = null; currentLanes = null; currentMediaEl = null; currentMedium = null;
      const loading = el('div', 'caqdas__empty'); loading.textContent = 'Loading media…';
      textPane.append(loading);
      const token = ++mediaLoadToken;
      let blob = null;
      try { blob = await app.media.load(doc.refs[0]); } catch { blob = null; }
      if (token !== mediaLoadToken) return; // a newer doc switch superseded this load
      if (mediaObjectUrl) { URL.revokeObjectURL(mediaObjectUrl); mediaObjectUrl = null; }
      textPane.textContent = '';
      if (!blob) {
        const e = el('div', 'caqdas__empty');
        e.textContent = 'Media unavailable — this asset isn’t in the browser’s store on this device.';
        textPane.append(e);
        return;
      }
      const kind = String(blob.type || '').split('/')[0];
      mediaObjectUrl = URL.createObjectURL(blob);
      currentMedium = kind;
      if (kind === 'image') renderImage(doc);
      else if (kind === 'audio' || kind === 'video') renderTimeMedia(doc, kind);
      else {
        const e = el('div', 'caqdas__empty'); e.textContent = 'This media type isn’t supported for coding.';
        textPane.append(e);
      }
    }

    /** Render an image doc: the picture + a region overlay (the 2-D selector). */
    function renderImage(doc) {
      const hint = el('div', 'caqdas__mediahint');
      hint.textContent = 'Drag on the image to draw a region, then click a code to tag it (right-click, or 🖌 to paint). Click a region to memo or remove it.';
      const wrap = el('div', 'caqdas__imgwrap');
      const img = el('img', 'caqdas__img');
      const overlay = el('div', 'caqdas__overlay');
      currentOverlay = overlay;
      wrap.append(img, overlay);
      img.addEventListener('load', () => drawRegions(overlay, doc));
      img.src = mediaObjectUrl;
      attachRegionDrawing(overlay, doc);
      textPane.append(hint, wrap);
    }

    /** Render an audio/video doc: the player + a timeline with per-code lanes. The
     * selector is a time range — the 1-D-in-time analogue of the image region — and
     * each code is a lane (the ELAN tier model, the time version of image layers). */
    function renderTimeMedia(doc, kind) {
      const isVideo = kind === 'video';
      const mediaEl = document.createElement(isVideo ? 'video' : 'audio');
      mediaEl.controls = !isVideo; // video uses the custom transport bar below (frame is for drawing)
      mediaEl.preload = 'metadata';
      mediaEl.crossOrigin = 'anonymous'; // blob is same-origin; keeps the canvas untainted for tracking
      mediaEl.className = isVideo ? 'caqdas__video' : 'caqdas__audioel';
      mediaEl.src = mediaObjectUrl;
      currentMediaEl = mediaEl;
      activeTrack = null; videoSel = null; currentVideoOverlay = null; trackToolbarEl = null; tracking = false;

      // Video gets a frame overlay for spatiotemporal (region-over-time) coding.
      let playerNode = mediaEl, overlay = null;
      if (isVideo) {
        const wrap = el('div', 'caqdas__vidwrap');
        overlay = el('div', 'caqdas__vidoverlay'); // pointer-events:none until "Region" mode is on
        currentVideoOverlay = overlay;
        wrap.append(mediaEl, overlay);
        playerNode = wrap;
        attachVideoRegionDrawing(overlay, doc, mediaEl);
      }

      // Transport bar — a clear off-frame strip (play/pause for video + speed [+ ✎ Region]).
      // For video it sits right above the ruler so the whole frame is free for drawing;
      // for audio it's a plain speed row alongside the native controls.
      const ctrl = el('div', isVideo ? 'caqdas__transport' : 'caqdas__mediactrl');
      if (isVideo) {
        const playBtn = el('button', 'caqdas__ctlbtn caqdas__playbtn'); playBtn.textContent = '▶'; playBtn.title = 'Play / pause';
        const syncPlay = () => { playBtn.textContent = mediaEl.paused ? '▶' : '⏸'; };
        playBtn.addEventListener('click', () => { if (mediaEl.paused) mediaEl.play(); else mediaEl.pause(); });
        mediaEl.addEventListener('play', syncPlay);
        mediaEl.addEventListener('pause', syncPlay);
        // Click the frame itself (when not in Region mode) to play/pause too.
        mediaEl.addEventListener('click', () => { if (!overlay.classList.contains('is-drawing')) { if (mediaEl.paused) mediaEl.play(); else mediaEl.pause(); } });
        ctrl.append(playBtn);
      }
      const sl = el('span', 'caqdas__speedlabel'); sl.textContent = 'Speed';
      ctrl.append(sl);
      const speedBtns = [];
      for (const rate of [0.5, 1, 1.5, 2]) {
        const b = el('button', 'caqdas__ctlbtn caqdas__speedbtn' + (rate === 1 ? ' is-on' : ''));
        b.textContent = rate + '×';
        b.addEventListener('click', () => { mediaEl.playbackRate = rate; speedBtns.forEach((x) => x.classList.toggle('is-on', x === b)); });
        speedBtns.push(b); ctrl.append(b);
      }
      if (isVideo) {
        // Volume / mute (lost with the native controls).
        const volBtn = el('button', 'caqdas__ctlbtn'); volBtn.title = 'Mute / unmute';
        const vol = el('input', 'caqdas__vol'); vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.value = '1'; vol.title = 'Volume';
        const syncVol = () => { volBtn.textContent = mediaEl.muted || mediaEl.volume === 0 ? '🔇' : '🔊'; };
        volBtn.addEventListener('click', () => {
          mediaEl.muted = !mediaEl.muted;
          if (!mediaEl.muted && mediaEl.volume === 0) { mediaEl.volume = 1; }
        });
        vol.addEventListener('input', () => { mediaEl.volume = Number(vol.value); mediaEl.muted = Number(vol.value) === 0; });
        mediaEl.addEventListener('volumechange', () => { vol.value = String(mediaEl.muted ? 0 : mediaEl.volume); syncVol(); });
        syncVol();
        ctrl.append(volBtn, vol);
        // "Region" mode: while on, the overlay captures drawing; while off, the frame
        // plays normally (click to play/pause) and the overlay just shows tracked boxes.
        const dt = el('button', 'caqdas__ctlbtn caqdas__regionbtn'); dt.textContent = '✎ Region';
        dt.title = 'Draw region-over-time boxes on the frame';
        dt.addEventListener('click', () => dt.classList.toggle('is-on', overlay.classList.toggle('is-drawing')));
        ctrl.append(dt);
      }

      const hint = el('div', 'caqdas__mediahint');
      hint.textContent = isVideo
        ? 'Play/scrub with the controls below the frame (or click the frame to play/pause; drag the ruler thumb to scrub). Time coding: drag the ruler → pick a code. Region-over-time: turn on ✎ Region, draw a box on a subject, pick a code, then scrub and drag/resize the box (or ⦿ Auto-track) to add keyframes — nudge a drifted box back on target with its handles.'
        : 'Drag on the timeline to select a span, then click a code to tag it (right-click, or 🖌 to paint). Click a coding bar to memo/remove; click the ruler to seek.';

      const trackToolbar = el('div', 'caqdas__tracktb'); trackToolbar.style.display = 'none';
      trackToolbarEl = trackToolbar;

      const timeline = el('div', 'caqdas__timeline');
      currentTimeline = timeline;
      const track = el('div', 'caqdas__tltrack');
      const tlsel = el('div', 'caqdas__tlsel'); tlsel.style.display = 'none';
      const playhead = el('div', 'caqdas__playhead');
      const scrub = el('div', 'caqdas__scrub'); // draggable thumb over the playhead (scrub)
      track.append(tlsel, playhead, scrub);
      const lanes = el('div', 'caqdas__lanes');
      currentLanes = lanes;
      timeline.append(track, lanes);

      attachTimelineDrawing(track, doc, mediaEl);
      const sync = () => {
        const d = mediaEl.duration || 0;
        if (d > 0) { const p = (mediaEl.currentTime / d) * 100 + '%'; playhead.style.left = p; scrub.style.left = p; }
        if (isVideo && !tracking) drawTrackBoxes(overlay, doc, mediaEl.currentTime || 0);
      };
      // Draggable scrubber: grab the playhead thumb and drag to seek. A plain drag on the
      // rest of the ruler still creates a time coding; a click still jumps.
      let scrubbing = false;
      const scrubTo = (e) => {
        const r = track.getBoundingClientRect();
        const d = mediaEl.duration || 0;
        if (d > 0) mediaEl.currentTime = clamp01((e.clientX - r.left) / r.width) * d;
      };
      scrub.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); // don't start a time-coding drag
        scrubbing = true;
        try { scrub.setPointerCapture(e.pointerId); } catch { /* ok */ }
      });
      scrub.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
      const endScrub = () => { scrubbing = false; };
      scrub.addEventListener('pointerup', endScrub);
      scrub.addEventListener('pointercancel', endScrub);
      mediaEl.addEventListener('timeupdate', sync);
      mediaEl.addEventListener('seeked', sync);
      mediaEl.addEventListener('loadedmetadata', () => { sync(); drawLanes(lanes, doc, mediaEl.duration || 1); });

      // Video: player, hint, track toolbar, then the transport strip RIGHT above the
      // ruler (controls off the frame). Audio: player (native controls) + speed row.
      if (isVideo) textPane.append(playerNode, hint, trackToolbar, ctrl, timeline);
      else textPane.append(playerNode, ctrl, hint, timeline);
      if (mediaEl.readyState >= 1) drawLanes(lanes, doc, mediaEl.duration || 1); // metadata already cached
    }

    /** Redraw the region boxes over the live image without re-fetching it (used after
     * add/remove/memo so the image doesn't flicker), and clear any pending drag box. */
    function refreshRegions() {
      if (!currentOverlay) return;
      currentOverlay.querySelectorAll('.caqdas__regionsel').forEach((n) => n.remove());
      const doc = docs.find((d) => d.rid === activeRid);
      if (doc && doc.kind === 'media') drawRegions(currentOverlay, doc);
    }

    /** Re-render after a segment change, the light way for each doc kind: a media doc
     * repaints its regions/lanes in place (no reload); a text doc re-renders normally.
     * The codebook + doc list (counts) refresh either way. */
    function refreshView() {
      const doc = docs.find((d) => d.rid === activeRid);
      if (doc && doc.kind === 'media') refreshMedia();
      else renderText();
      renderDocList();
      renderCodes();
    }

    /** Repaint the live media view in place (no reload): image regions or timeline lanes. */
    function refreshMedia() {
      if (currentMedium === 'image') refreshRegions();
      else if (currentMedium === 'audio' || currentMedium === 'video') refreshLanes();
    }

    /** Redraw the timeline lanes in place, clearing any pending selection span. */
    function refreshLanes() {
      if (!currentLanes || !currentMediaEl) return;
      currentTimeline?.querySelectorAll('.caqdas__tlsel').forEach((n) => { n.style.display = 'none'; });
      const doc = docs.find((d) => d.rid === activeRid);
      if (doc && doc.kind === 'media') {
        drawLanes(currentLanes, doc, currentMediaEl.duration || 1);
        if (currentVideoOverlay) drawTrackBoxes(currentVideoOverlay, doc, currentMediaEl.currentTime || 0);
      }
    }

    /** Draw a doc's regions as translucent coloured boxes, one visual layer per code.
     * Hidden codes are skipped (per-code visibility), and boxes are pointer-events:none
     * so the OVERLAY handles clicks — that's what makes overlapping regions all
     * selectable (a click surfaces every coding under the point, see finish()). */
    function drawRegions(overlay, doc) {
      overlay.querySelectorAll('.caqdas__region').forEach((n) => n.remove());
      const order = new Map(state.codes.map((c, i) => [c.id, i]));
      const segs = segsFor(doc.rid)
        .filter((s) => s.region && !hiddenCodes.has(s.codeId))
        .sort((a, b) => (order.get(a.codeId) ?? 0) - (order.get(b.codeId) ?? 0)); // codebook order = layer order
      for (const s of segs) {
        const code = codeById(s.codeId);
        const color = code ? code.color : '#888';
        const box = el('div', 'caqdas__region' + (s.memo ? ' has-memo' : ''));
        positionPct(box, s.region);
        box.style.borderColor = color;
        box.style.backgroundColor = hexToRgba(color, 0.18);
        const lbl = el('span', 'caqdas__rlabel');
        lbl.textContent = code ? code.name : '(code)';
        lbl.style.backgroundColor = color;
        box.append(lbl);
        overlay.append(box);
      }
    }

    /** Wire drag-to-draw on the image overlay: a finished rectangle becomes the pending
     * `imageSel`, applied when a code is clicked (or immediately in paint mode). */
    function attachRegionDrawing(overlay, doc) {
      let start = null; // {x,y} normalised
      let selEl = null;
      const norm = (e) => {
        const r = overlay.getBoundingClientRect();
        return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
      };
      overlay.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        overlay.querySelectorAll('.caqdas__regionsel').forEach((n) => n.remove());
        try { overlay.setPointerCapture(e.pointerId); } catch { /* ok */ }
        start = norm(e);
        imageSel = null;
        selEl = el('div', 'caqdas__regionsel');
        overlay.append(selEl);
        positionPct(selEl, { x: start.x, y: start.y, w: 0, h: 0 });
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!start) return;
        const p = norm(e);
        positionPct(selEl, rectOf(start, p));
      });
      const finish = (e) => {
        if (!start) return;
        const rect = rectOf(start, norm(e));
        start = null;
        if (rect.w < 0.01 || rect.h < 0.01) {
          // A click, not a drag → open every coding under this point (all overlapping
          // regions across codes, not just the top layer).
          selEl?.remove(); selEl = null; imageSel = null;
          const hits = regionsAt(doc, rect.x, rect.y);
          if (hits.length) openSegmentMenu(hits, e);
          return;
        }
        imageSel = rect;
        if (activeCodeId) addRegionSegment(activeCodeId, imageSel); // paint mode
      };
      overlay.addEventListener('pointerup', finish);
      overlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (imageSel) openAssignMenu({ kind: 'region', region: imageSel }, e);
      });
    }

    /** Record a region-coding segment (the 2-D analogue of {@link addSegment}). */
    function addRegionSegment(codeId, region) {
      state.segments.push({
        doc: activeRid,
        codeId,
        region: { x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) },
        text: regionLabel(region), // a human label so retrieve/export/counts work unchanged
      });
      imageSel = null;
      save();
      refreshView();
    }

    /** Every visible region coding of a doc whose box contains the normalised point —
     * so a click surfaces all overlapping codes, not just the topmost. */
    function regionsAt(doc, x, y) {
      return segsFor(doc.rid).filter(
        (s) => s.region && !hiddenCodes.has(s.codeId)
          && x >= s.region.x && x <= s.region.x + s.region.w
          && y >= s.region.y && y <= s.region.y + s.region.h,
      );
    }

    /** Draw the timeline lanes: one row per code that has codings (in codebook order),
     * each coding a bar positioned by its time span. Hidden codes are skipped. Bars are
     * clickable (memo/remove). This is the time-dimension twin of {@link drawRegions}. */
    function drawLanes(lanesEl, doc, duration) {
      lanesEl.textContent = '';
      const dur = duration > 0 ? duration : 1;
      const order = new Map(state.codes.map((c, i) => [c.id, i]));
      const byCode = new Map();
      for (const s of segsFor(doc.rid)) {
        if (s.tStart == null || hiddenCodes.has(s.codeId)) continue;
        if (!byCode.has(s.codeId)) byCode.set(s.codeId, []);
        byCode.get(s.codeId).push(s);
      }
      const ids = [...byCode.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      if (!ids.length) {
        const e = el('div', 'caqdas__lanesempty');
        e.textContent = 'No codings yet — drag on the ruler above, then click a code.';
        lanesEl.append(e);
        return;
      }
      for (const cid of ids) {
        const code = codeById(cid);
        const color = code ? code.color : '#888';
        const lane = el('div', 'caqdas__lane');
        const label = el('span', 'caqdas__lanelabel'); label.textContent = code ? code.name : '(code)'; label.style.color = color;
        lane.append(label);
        const strip = el('div', 'caqdas__lanestrip');
        for (const s of byCode.get(cid)) {
          const bar = el('div', 'caqdas__lanebar' + (s.memo ? ' has-memo' : '') + (s.keys ? ' is-track' : ''));
          bar.style.left = (s.tStart / dur) * 100 + '%';
          bar.style.width = Math.max(0.4, ((s.tEnd - s.tStart) / dur) * 100) + '%';
          bar.style.backgroundColor = color;
          const kind = s.keys ? ` · region-over-time (${s.keys.length} kf)` : '';
          bar.title = `${code ? code.name : ''} ${fmtTime(s.tStart)}–${fmtTime(s.tEnd)}${kind}${s.memo ? ' — ' + s.memo : ''}`;
          // A tracked region opens for editing; a plain time coding opens its memo/remove menu.
          bar.addEventListener('click', (e) => { e.stopPropagation(); if (s.keys) activateTrack(s); else openSegmentMenu([s], e); });
          strip.append(bar);
        }
        lane.append(strip);
        lanesEl.append(lane);
      }
    }

    /** Wire drag-to-select on the timeline ruler: a finished span becomes the pending
     * `timeSel` (applied on code-click, or immediately in paint mode); a plain click
     * seeks the player. The time twin of {@link attachRegionDrawing}. */
    function attachTimelineDrawing(track, doc, mediaEl) {
      let start = null;
      const tlsel = track.querySelector('.caqdas__tlsel');
      const posOf = (e) => { const r = track.getBoundingClientRect(); return clamp01((e.clientX - r.left) / r.width); };
      track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.caqdas__scrub')) return; // grabbing the scrubber, not coding
        e.preventDefault();
        try { track.setPointerCapture(e.pointerId); } catch { /* ok */ }
        start = posOf(e);
        timeSel = null;
        tlsel.style.display = 'block';
        tlsel.style.left = start * 100 + '%';
        tlsel.style.width = '0%';
      });
      track.addEventListener('pointermove', (e) => {
        if (start == null) return;
        const p = posOf(e);
        tlsel.style.left = Math.min(start, p) * 100 + '%';
        tlsel.style.width = Math.abs(p - start) * 100 + '%';
      });
      const finish = (e) => {
        if (start == null) return;
        const p = posOf(e);
        const lo = Math.min(start, p), hi = Math.max(start, p);
        start = null;
        const dur = mediaEl.duration || 0;
        if (hi - lo < 0.005 || dur <= 0) {
          // A click, not a drag → seek the player to that point.
          tlsel.style.display = 'none';
          timeSel = null;
          if (dur > 0) mediaEl.currentTime = lo * dur;
          return;
        }
        timeSel = { tStart: lo * dur, tEnd: hi * dur };
        if (activeCodeId) addTimeSegment(activeCodeId, timeSel); // paint mode
      };
      track.addEventListener('pointerup', finish);
      track.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (timeSel) openAssignMenu({ kind: 'time', span: timeSel }, e);
      });
    }

    /** Record a time-range coding segment (the time twin of {@link addRegionSegment}). */
    function addTimeSegment(codeId, span) {
      state.segments.push({
        doc: activeRid,
        codeId,
        tStart: round3(span.tStart),
        tEnd: round3(span.tEnd),
        text: timeLabel(span.tStart, span.tEnd),
      });
      timeSel = null;
      save();
      refreshView();
    }

    // --- video: region-over-time (spatiotemporal) ----------------------------
    // A tracked region is a segment with `keys:[{t,x,y,w,h}]` — a box that moves by
    // interpolating between keyframes (rung 2). Keyframes are set by hand (draw the box
    // at a time) or suggested by the rough tracker (rung 3). It still has tStart/tEnd +
    // text, so it appears on the lanes and in retrieve/export like any other segment.

    /** Draw on the video frame overlay (only while ✎ Region mode is on): a drag adds a
     * keyframe to the active track (or, with none active, a pending box for a new one);
     * a click selects/deselects a track box. */
    function attachVideoRegionDrawing(overlay, doc, mediaEl) {
      let start = null, selEl = null;
      const norm = (e) => { const r = overlay.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
      overlay.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !overlay.classList.contains('is-drawing')) return;
        e.preventDefault();
        try { overlay.setPointerCapture(e.pointerId); } catch { /* ok */ }
        overlay.querySelectorAll('.caqdas__regionsel').forEach((n) => n.remove());
        start = norm(e); videoSel = null;
        selEl = el('div', 'caqdas__regionsel'); overlay.append(selEl);
        positionPct(selEl, { x: start.x, y: start.y, w: 0, h: 0 });
      });
      overlay.addEventListener('pointermove', (e) => { if (start) positionPct(selEl, rectOf(start, norm(e))); });
      overlay.addEventListener('pointerup', (e) => {
        if (start == null) return;
        const rect = rectOf(start, norm(e));
        start = null;
        const t = mediaEl.currentTime || 0;
        if (rect.w < 0.01 || rect.h < 0.01) {
          selEl?.remove(); selEl = null; videoSel = null;
          const hit = trackBoxAt(doc, t, rect.x, rect.y);
          if (hit) activateTrack(hit);
          else { activeTrack = null; renderTrackToolbar(); drawTrackBoxes(overlay, doc, t); }
          return;
        }
        selEl?.remove(); selEl = null;
        if (activeTrack) upsertKeyframe(activeTrack, t, rect); // add a keyframe to the active track
        else { videoSel = rect; if (activeCodeId) createTrack(activeCodeId, rect); } // else stage a new track
      });
      overlay.addEventListener('contextmenu', (e) => {
        if (!overlay.classList.contains('is-drawing')) return;
        e.preventDefault();
        if (videoSel) openAssignMenu({ kind: 'vregion', region: videoSel }, e);
      });
    }

    /** Start a new tracked region for a code at the current time (its first keyframe). */
    function createTrack(codeId, region) {
      const t = round3(currentMediaEl?.currentTime || 0);
      const seg = {
        doc: activeRid, codeId,
        keys: [{ t, x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) }],
        tStart: t, tEnd: t, text: timeLabel(t, t),
      };
      state.segments.push(seg);
      activeTrack = seg; videoSel = null;
      save();
      refreshLanes(); renderCodes(); renderTrackToolbar();
      drawTrackBoxes(currentVideoOverlay, docActive(), t);
    }

    /** Insert or replace the keyframe at (about) time `t`, keeping keys time-sorted. */
    function upsertKeyframe(seg, t, region, quiet) {
      const key = { t: round3(t), x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) };
      const i = seg.keys.findIndex((k) => Math.abs(k.t - key.t) < 0.05);
      if (i >= 0) seg.keys[i] = key; else seg.keys.push(key);
      seg.keys.sort((a, b) => a.t - b.t);
      seg.tStart = seg.keys[0].t; seg.tEnd = seg.keys[seg.keys.length - 1].t;
      seg.text = timeLabel(seg.tStart, seg.tEnd);
      if (!quiet) {
        save(); refreshLanes(); renderTrackToolbar();
        drawTrackBoxes(currentVideoOverlay, docActive(), currentMediaEl?.currentTime || 0);
      }
    }

    /** Delete the keyframe near the current time (removing the whole track if it was
     * the last one). */
    function deleteKeyframeAt(seg, t) {
      const i = seg.keys.findIndex((k) => Math.abs(k.t - t) < 0.25);
      if (i < 0) return;
      seg.keys.splice(i, 1);
      if (!seg.keys.length) { state.segments = state.segments.filter((s) => s !== seg); activeTrack = null; }
      else { seg.tStart = seg.keys[0].t; seg.tEnd = seg.keys[seg.keys.length - 1].t; seg.text = timeLabel(seg.tStart, seg.tEnd); }
      save(); refreshLanes(); renderCodes(); renderTrackToolbar();
      drawTrackBoxes(currentVideoOverlay, docActive(), t);
    }

    /** Remove an entire tracked region. */
    function removeTrack(seg) {
      state.segments = state.segments.filter((s) => s !== seg);
      if (activeTrack === seg) activeTrack = null;
      save(); refreshLanes(); renderCodes(); renderTrackToolbar();
      drawTrackBoxes(currentVideoOverlay, docActive(), currentMediaEl?.currentTime || 0);
    }

    /** Make a track the one being edited and seek to its start. */
    function activateTrack(seg) {
      activeTrack = seg;
      if (currentMediaEl && seg.keys?.length) currentMediaEl.currentTime = seg.tStart;
      renderTrackToolbar();
      drawTrackBoxes(currentVideoOverlay, docActive(), seg.tStart);
    }

    /** The topmost tracked region whose interpolated box contains the point at time t. */
    function trackBoxAt(doc, t, x, y) {
      const segs = segsFor(doc.rid).filter((s) => s.keys && !hiddenCodes.has(s.codeId));
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        if (t < s.tStart - 0.001 || t > s.tEnd + 0.001) continue;
        const r = regionAtTime(s.keys, t);
        if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return s;
      }
      return null;
    }

    /** Draw every visible tracked region's interpolated box at time `t` on the overlay. */
    function drawTrackBoxes(overlay, doc, t) {
      if (!overlay) return;
      overlay.querySelectorAll('.caqdas__trackbox').forEach((n) => n.remove());
      for (const s of segsFor(doc.rid)) {
        if (!s.keys || hiddenCodes.has(s.codeId)) continue;
        if (t < s.tStart - 0.001 || t > s.tEnd + 0.001) continue;
        const r = regionAtTime(s.keys, t);
        if (!r) continue;
        const code = codeById(s.codeId);
        const color = code ? code.color : '#888';
        const box = el('div', 'caqdas__trackbox' + (s === activeTrack ? ' is-active' : ''));
        positionPct(box, r);
        box.style.borderColor = color;
        box.style.backgroundColor = hexToRgba(color, 0.12);
        const lbl = el('span', 'caqdas__rlabel'); lbl.textContent = code ? code.name : '(code)'; lbl.style.backgroundColor = color;
        box.append(lbl);
        overlay.append(box);
        // The active track's box is directly editable while in ✎ Region mode: drag to
        // move, or a handle to resize — the fast way to fix tracker drift.
        if (s === activeTrack && overlay.classList.contains('is-drawing')) attachBoxEditing(box, s, overlay);
      }
    }

    /** Make a track box draggable (move) + resizable (8 handles). Committing a gesture
     * upserts the keyframe at the current time, so nudging a drifted box back on target
     * is one drag. */
    function attachBoxEditing(box, seg, overlay) {
      box.classList.add('is-editing');
      for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const hd = el('div', 'caqdas__handle caqdas__h-' + h);
        hd.addEventListener('pointerdown', (e) => startEdit(e, h));
        box.append(hd);
      }
      box.addEventListener('pointerdown', (e) => { if (e.target === box) startEdit(e, null); });

      function startEdit(e, handle) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); // don't start a new-box draw
        const orect = overlay.getBoundingClientRect();
        const t = currentMediaEl?.currentTime || 0;
        const r0 = regionAtTime(seg.keys, t);
        if (!r0) return;
        const sx = clamp01((e.clientX - orect.left) / orect.width);
        const sy = clamp01((e.clientY - orect.top) / orect.height);
        let rect = { x: r0.x, y: r0.y, w: r0.w, h: r0.h };
        let moved = false;
        const onMove = (ev) => {
          moved = true;
          const dx = clamp01((ev.clientX - orect.left) / orect.width) - sx;
          const dy = clamp01((ev.clientY - orect.top) / orect.height) - sy;
          if (!handle) {
            const x = Math.min(Math.max(0, r0.x + dx), 1 - r0.w);
            const y = Math.min(Math.max(0, r0.y + dy), 1 - r0.h);
            rect = { x, y, w: r0.w, h: r0.h };
          } else {
            let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
            if (handle.includes('w')) x1 = r0.x + dx;
            if (handle.includes('e')) x2 = r0.x + r0.w + dx;
            if (handle.includes('n')) y1 = r0.y + dy;
            if (handle.includes('s')) y2 = r0.y + r0.h + dy;
            const nx = clamp01(Math.min(x1, x2)), nx2 = clamp01(Math.max(x1, x2));
            const ny = clamp01(Math.min(y1, y2)), ny2 = clamp01(Math.max(y1, y2));
            rect = { x: nx, y: ny, w: Math.max(0.01, nx2 - nx), h: Math.max(0.01, ny2 - ny) };
          }
          positionPct(box, rect);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (moved) upsertKeyframe(seg, t, rect);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }
    }

    /** Show/refresh the track-editing toolbar for the active track (or hide it). */
    function renderTrackToolbar() {
      if (!trackToolbarEl) return;
      trackToolbarEl.textContent = '';
      if (!activeTrack) { trackToolbarEl.style.display = 'none'; return; }
      trackToolbarEl.style.display = 'flex';
      const code = codeById(activeTrack.codeId);
      const n = activeTrack.keys.length;
      const label = el('span', 'caqdas__tracklabel');
      label.textContent = `⦿ ${code ? code.name : '?'} · ${n} keyframe${n === 1 ? '' : 's'}`;
      if (code) label.style.color = code.color;
      const trackBtn = el('button', 'caqdas__btn');
      trackBtn.textContent = tracking ? '■ Stop' : '⦿ Auto-track ▶';
      trackBtn.title = 'Follow the box forward frame-by-frame (rough — correct any drift by re-drawing)';
      trackBtn.addEventListener('click', () => { if (tracking) tracking = false; else void trackForward(activeTrack, currentMediaEl); });
      const delBtn = el('button', 'caqdas__btn'); delBtn.textContent = '⌫ keyframe';
      delBtn.title = 'Delete the keyframe at the current time';
      delBtn.addEventListener('click', () => deleteKeyframeAt(activeTrack, currentMediaEl?.currentTime || 0));
      const rmBtn = el('button', 'caqdas__btn'); rmBtn.textContent = '🗑 track';
      rmBtn.title = 'Remove this whole tracked region';
      rmBtn.addEventListener('click', () => removeTrack(activeTrack));
      const doneBtn = el('button', 'caqdas__btn caqdas__btn--primary'); doneBtn.textContent = '✓ Done';
      doneBtn.addEventListener('click', () => { activeTrack = null; renderTrackToolbar(); drawTrackBoxes(currentVideoOverlay, docActive(), currentMediaEl?.currentTime || 0); });
      trackToolbarEl.append(label, trackBtn, delBtn, rmBtn, doneBtn);
    }

    /** Rough auto-tracker (rung 3): step forward from the current time, template-matching
     * the box's patch frame-to-frame and dropping a keyframe each step. Runs on a
     * downscaled canvas; bails gracefully if the browser taints the canvas. */
    async function trackForward(seg, mediaEl) {
      if (tracking || !mediaEl) return;
      const dur = mediaEl.duration || 0;
      const vw = mediaEl.videoWidth || 0;
      if (!dur || !vw) return;
      const W = Math.min(720, vw); // downscale for speed, but keep enough detail to lock on
      const H = Math.round((mediaEl.videoHeight || 270) * (W / vw));
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const seekTo = (tt) => new Promise((res) => {
        const on = () => { mediaEl.removeEventListener('seeked', on); res(); };
        mediaEl.addEventListener('seeked', on);
        mediaEl.currentTime = Math.min(dur, Math.max(0, tt));
      });
      const step = 0.4;
      let t = mediaEl.currentTime || 0;
      let region = regionAtTime(seg.keys, t);
      if (!region) return;
      mediaEl.pause();
      tracking = true; renderTrackToolbar();
      try {
        await seekTo(t);
        ctx.drawImage(mediaEl, 0, 0, W, H);
        // ADAPTIVE template: re-grabbed from the matched box each frame so it follows
        // gradual appearance change. (Can drift long-term as small misalignments
        // accumulate; correct a keyframe + re-run Auto-track to re-anchor. A fixed
        // template was tried and was worse on real footage.)
        let tmpl = grayPatch(ctx, region, W, H); // throws here first if tainted
        let cur = { x: region.x, y: region.y, w: region.w, h: region.h };
        let added = 0;
        // Cap per click (~a minute of footage) so a long video can't spin forever;
        // click Auto-track again to continue from where it left off.
        while (tracking && t + step <= dur && added < 150) {
          t += step;
          added++;
          await seekTo(t);
          if (!tracking) break;
          ctx.drawImage(mediaEl, 0, 0, W, H);
          cur = matchTemplate(ctx, tmpl, cur, W, H);
          upsertKeyframe(seg, t, cur, true);
          drawTrackBoxes(currentVideoOverlay, docActive(), t);
          tmpl = grayPatch(ctx, cur, W, H); // adapt to slow appearance change
        }
      } catch (err) {
        app.results?.appendError?.(
          'Auto-track couldn’t read the video pixels on this device (the browser blocked it). Manual keyframes still work — scrub and re-draw the box.',
        );
      } finally {
        tracking = false;
        save(); refreshLanes(); renderTrackToolbar();
        drawTrackBoxes(currentVideoOverlay, docActive(), mediaEl.currentTime || 0);
      }
    }

    function renderCodes() {
      codePane.textContent = '';
      const h = el('h3'); h.textContent = 'Codebook'; codePane.append(h);
      const hint = el('div', 'caqdas__hint');
      hint.textContent = 'Select a passage, then click a code to apply it (right-click, or 🖌 to paint). 🔍 lists a code’s segments; ✎ opens its memo + theme group.';
      codePane.append(hint);
      const counts = {};
      for (const s of state.segments) counts[s.codeId] = (counts[s.codeId] || 0) + 1;
      const armed = activeCodeId;
      // Per-code region-visibility toggles are only meaningful on an image doc.
      const activeDoc = docs.find((d) => d.rid === activeRid);
      const activeIsMedia = !!activeDoc && activeDoc.kind === 'media';
      // Group codes into themes by their `group`; ungrouped fall to the bottom.
      const groups = new Map();
      for (const code of state.codes) { const g = code.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(code); }
      const groupNames = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
      const hasThemes = groupNames.some((g) => g !== '');
      for (const g of groupNames) {
        // Every section gets a header so its boundary is unambiguous — including a
        // muted "No theme" header for ungrouped codes when themes are in play (else
        // an ungrouped code reads as part of the theme above it).
        if (g) { const gh = el('div', 'caqdas__group'); gh.textContent = g; codePane.append(gh); }
        else if (hasThemes) { const gh = el('div', 'caqdas__group caqdas__group--none'); gh.textContent = 'No theme'; codePane.append(gh); }
        for (const code of groups.get(g)) {
          const r = el('div', 'caqdas__code' + (armed === code.id ? ' is-armed' : ''));
          r.title = 'Click to code the selected passage';
          const sw = el('span', 'caqdas__sw'); sw.style.backgroundColor = code.color;
          const nm = el('span', 'nm'); nm.textContent = code.name;
          if (code.memo) nm.title = code.memo;
          const ct = el('span', 'ct'); ct.textContent = counts[code.id] || 0;
          const rb = el('button', 'caqdas__iconbtn'); rb.textContent = '🔍'; rb.title = 'Show every passage coded with this';
          rb.addEventListener('click', (e) => { e.stopPropagation(); retrieveCodeId = code.id; renderText(); });
          const mb = el('button', 'caqdas__iconbtn' + (code.memo ? ' has' : '')); mb.textContent = '✎'; mb.title = 'Memo + theme group (code details)';
          mb.addEventListener('click', (e) => { e.stopPropagation(); memoOpen.has(code.id) ? memoOpen.delete(code.id) : memoOpen.add(code.id); renderCodes(); });
          const pb = el('button', 'pb' + (armed === code.id ? ' is-on' : ''));
          pb.textContent = '🖌';
          pb.title = 'Paint mode: arm this code so selecting passages auto-applies it';
          pb.addEventListener('click', (e) => { e.stopPropagation(); setArmed(code.id); });
          // Per-code region-layer visibility (image docs only): hide/show this code's
          // boxes so overlapping codings can be isolated or compared.
          let vb = null;
          if (activeIsMedia) {
            const hidden = hiddenCodes.has(code.id);
            vb = el('button', 'caqdas__iconbtn' + (hidden ? '' : ' has'));
            vb.textContent = hidden ? '◌' : '👁';
            vb.title = hidden ? 'Show this code’s regions' : 'Hide this code’s regions';
            vb.addEventListener('click', (e) => {
              e.stopPropagation();
              if (hidden) hiddenCodes.delete(code.id); else hiddenCodes.add(code.id);
              refreshMedia();
              renderCodes();
            });
          }
          const x = el('button', 'x'); x.textContent = '✕'; x.title = 'Delete code + its segments';
          x.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activeCodeId === code.id) activeCodeId = null;
            state.codes = state.codes.filter((c) => c.id !== code.id);
            state.segments = state.segments.filter((s) => s.codeId !== code.id);
            save(); updatePaintUI(); renderAll();
          });
          // The workhorse gesture: apply this code to the current selection. mousedown
          // + preventDefault keeps the text selection alive through the click (the
          // selection would otherwise collapse when focus leaves the transcript).
          // Skip when the press lands on a control inside the row.
          // pointerdown (not mousedown) so the gesture also fires on iPad touch (#126).
          r.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('button, input, textarea')) return;
            e.preventDefault();
            // Media doc: apply to the drawn region (the 2-D analogue of a text span).
            const activeDoc = docs.find((d) => d.rid === activeRid);
            if (activeDoc && activeDoc.kind === 'media') {
              if (imageSel) addRegionSegment(code.id, imageSel);
              else if (videoSel) createTrack(code.id, videoSel);
              else if (timeSel) addTimeSegment(code.id, timeSel);
              else flashHint(hint);
              return;
            }
            const span = currentSpan();
            if (!span) { flashHint(hint); return; }
            // Tap-to-toggle: if the selection sits inside an existing coding of THIS
            // code, the tap REMOVES it (untag); otherwise it applies/extends. Gives
            // touch a remove gesture without a right-click, and a natural on/off rhythm.
            const enclosing = state.segments.filter(
              (s) => s.doc === activeRid && s.codeId === code.id && s.start <= span.lo && span.hi <= s.end,
            );
            if (enclosing.length) {
              state.segments = state.segments.filter((s) => !enclosing.includes(s));
              save(); renderText(); renderDocList(); renderCodes();
              setSelectionRange(textPane, span.lo, span.hi); // keep selection for re-toggling
            } else {
              addSegment(code.id, span);
            }
          });
          r.append(sw, nm, ct, rb, mb, pb);
          if (vb) r.append(vb);
          r.append(x);
          codePane.append(r);
          // ✎ details: theme group + analytic memo, both persisted on the code.
          if (memoOpen.has(code.id)) {
            const panel = el('div', 'caqdas__details');
            const gi = el('input', 'caqdas__grpinp'); gi.placeholder = 'theme / group'; gi.value = code.group || '';
            gi.addEventListener('input', () => { code.group = gi.value; save(); });
            gi.addEventListener('blur', renderCodes);
            const ta = el('textarea', 'caqdas__memo'); ta.rows = 3; ta.placeholder = 'Memo — analytic note on this code…'; ta.value = code.memo || '';
            ta.addEventListener('input', () => { code.memo = ta.value; save(); });
            panel.append(gi, ta); codePane.append(panel);
          }
        }
      }
      // inline "new code"
      const nc = el('div', 'caqdas__newcode');
      const inp = el('input'); inp.placeholder = 'New code…';
      const add = el('button', 'caqdas__btn'); add.textContent = '＋';
      const commit = () => {
        const name = inp.value.trim();
        if (!name) return;
        state.codes.push({ id: uid(), name, color: PALETTE[state.codes.length % PALETTE.length], group: '', memo: '' });
        inp.value = ''; save(); renderCodes();
      };
      add.addEventListener('click', commit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      nc.append(inp, add);
      codePane.append(nc);
    }

    function renderAll() { renderDocList(); renderText(); renderCodes(); }

    // --- coding: assign codes to selections ---------------------------------
    let menu = null;
    const closeMenu = () => { menu?.remove(); menu = null; };
    document.addEventListener('click', closeMenu);

    // The current text selection within the active document, as {lo,hi,text,range}
    // (or null). Shared by the right-click menu and the click-a-code gesture.
    const currentSpan = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!textPane.contains(range.commonAncestorContainer)) return null;
      const a = offsetWithin(textPane, range.startContainer, range.startOffset);
      const b = offsetWithin(textPane, range.endContainer, range.endOffset);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi <= lo) return null;
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) return null;
      return { lo, hi, text: doc.text.slice(lo, hi), range };
    };

    // Record a segment for a span, re-render, and KEEP the passage selected so more
    // codes can be layered onto it (multi-coding — the NVivo/MAXQDA rhythm). The
    // re-render rebuilds the transcript DOM, so the live selection is restored over
    // the same characters afterwards.
    //
    // Merge-on-overlap: if the new span OVERLAPS an existing segment of the SAME code
    // in this document, the two (or more) are fused into ONE segment spanning their
    // union — so re-coding or extending a passage (e.g. 10–15, then 9–15) yields a
    // single coding rather than stacked duplicates. An exact re-code is just the
    // degenerate overlap (a no-op union). Adjacent-but-separate codings (no overlap)
    // are left alone — they may be deliberate, distinct references. Layering a
    // DIFFERENT code over the same text is unaffected (overlap is per-code).
    const addSegment = (codeId, span, restore = true) => {
      let { lo, hi } = span;
      const overlaps = (s) => s.doc === activeRid && s.codeId === codeId && s.start < hi && lo < s.end;
      const hits = state.segments.filter(overlaps);
      if (hits.length) {
        const memos = [];
        for (const s of hits) { lo = Math.min(lo, s.start); hi = Math.max(hi, s.end); if (s.memo) memos.push(s.memo); }
        const doc = docs.find((d) => d.rid === activeRid);
        const merged = { doc: activeRid, codeId, start: lo, end: hi, text: doc ? doc.text.slice(lo, hi) : span.text };
        if (memos.length) merged.memo = memos.join('\n'); // keep any per-coding notes
        state.segments = state.segments.filter((s) => !hits.includes(s));
        state.segments.push(merged);
        save();
      } else {
        state.segments.push({ doc: activeRid, codeId, start: lo, end: hi, text: span.text });
        save();
      }
      renderText(); renderDocList(); renderCodes();
      // Pick mode keeps the (possibly grown) passage selected (layer more codes);
      // paint mode clears it so the user moves straight on to the next passage.
      if (restore) setSelectionRange(textPane, lo, hi);
      else document.getSelection()?.removeAllRanges();
    };

    const flashHint = (elm) => { elm.style.color = '#b04a4a'; setTimeout(() => { elm.style.color = ''; }, 900); };

    // Coding is deliberately NOT auto-pop-on-selection (the Dedoose/Taguette way) —
    // coders select text to read, compare, and copy, so a menu on every selection
    // gets in the way of reading. Two intentional gestures instead, matching the
    // desktop CAQDAS tools (NVivo/ATLAS.ti/MAXQDA):
    //   • select a passage, then CLICK a code in the codebook (the workhorse), or
    //   • RIGHT-CLICK a passage → the code menu (also suppresses the native menu).
    textPane.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const span = currentSpan();
      if (span) openAssignMenu(span, e);
    });
    // Keep the native menu off the rest of the coding tab too (codebook, menu).
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // Paint mode (opt-in): when a code is armed, finishing a selection auto-applies
    // it — the highlighter-pen rhythm for fast first-pass coding. Inert otherwise,
    // so reading-by-selecting stays friction-free in the default mode.
    // pointerup (not mouseup) so paint mode also fires on iPad touch (#126).
    textPane.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !activeCodeId) return;
      const span = currentSpan();
      if (span) addSegment(activeCodeId, span, false); // paint: clear selection, move on
    });

    function openAssignMenu(span, evt) {
      closeMenu();
      menu = el('div', 'caqdas__menu');
      const choose = (codeId) => {
        closeMenu();
        if (span && span.kind === 'region') addRegionSegment(codeId, span.region);
        else if (span && span.kind === 'vregion') createTrack(codeId, span.region);
        else if (span && span.kind === 'time') addTimeSegment(codeId, span.span);
        else addSegment(codeId, span);
      };
      for (const code of state.codes) {
        const b = el('button');
        const sw = el('span', 'caqdas__sw'); sw.style.backgroundColor = code.color;
        const nm = document.createTextNode(code.name);
        b.append(sw, nm);
        b.addEventListener('click', (e) => { e.stopPropagation(); choose(code.id); });
        menu.append(b);
      }
      const row = el('div', 'row');
      const inp = el('input'); inp.placeholder = 'New code from selection…';
      row.append(inp);
      const mk = () => {
        const name = inp.value.trim();
        if (!name) return;
        const code = { id: uid(), name, color: PALETTE[state.codes.length % PALETTE.length], group: '', memo: '' };
        state.codes.push(code); choose(code.id);
      };
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); mk(); } });
      menu.append(row);
      // Position at the cursor for a right-click, else just under the selection.
      const x = typeof evt?.clientX === 'number' ? evt.clientX : span.range.getBoundingClientRect().left;
      const y = typeof evt?.clientY === 'number' ? evt.clientY + 4 : span.range.getBoundingClientRect().bottom + 4;
      menu.style.left = Math.round(x) + 'px';
      menu.style.top = Math.round(y) + 'px';
      document.body.append(menu);
      setTimeout(() => inp.focus(), 0);
    }

    // Click a highlight → a popup listing each code covering that span, with a memo
    // field and a Remove button per coding. Replaces the old click-to-delete (too
    // easy to lose a coding by accident) and gives segment-level analytic notes.
    function openSegmentMenu(covering, evt) {
      closeMenu();
      menu = el('div', 'caqdas__menu');
      for (const seg of covering) {
        const code = codeById(seg.codeId);
        const head = el('div', 'caqdas__seghead');
        const sw = el('span', 'caqdas__sw'); sw.style.backgroundColor = code ? code.color : '#ccc';
        const nm = el('span', 'nm'); nm.textContent = code ? code.name : '(code)';
        const rm = el('button', 'caqdas__segrm'); rm.textContent = 'Remove'; rm.title = 'Remove this coding';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          state.segments = state.segments.filter((s) => s !== seg);
          save(); closeMenu(); refreshView();
        });
        head.append(sw, nm, rm); menu.append(head);
        const ta = el('textarea', 'caqdas__segmemo'); ta.rows = 2; ta.placeholder = 'Memo on this coding…'; ta.value = seg.memo || '';
        ta.addEventListener('click', (e) => e.stopPropagation());
        ta.addEventListener('input', () => { seg.memo = ta.value; save(); });
        menu.append(ta);
      }
      menu.style.left = Math.round(evt.clientX) + 'px';
      menu.style.top = Math.round(evt.clientY + 4) + 'px';
      document.body.append(menu);
      setTimeout(() => menu.querySelector('textarea')?.focus(), 0);
    }

    // --- analyses (in-workspace → Output) ------------------------------------
    freqBtn.addEventListener('click', async () => {
      const counts = {};
      for (const s of state.segments) counts[s.codeId] = (counts[s.codeId] || 0) + 1;
      if (!state.codes.length) { app.results.appendError('No codes yet — create some in the Coding tab.'); return; }
      // Order by theme group (matching the codebook), so the table reads as a
      // themed code summary; show each code's memo when present.
      const ordered = state.codes.slice().sort((a, b) => (a.group || '~').localeCompare(b.group || '~') || a.name.localeCompare(b.name));
      const rows = ordered.map((c) => [c.group || '—', c.name, counts[c.id] || 0, c.memo || '']);
      // Bracket the output so the host stamps attribution (like a menu analysis).
      await app.results.beginAnalysis('Code frequency');
      await app.results.appendTable({ columns: ['Theme', 'Code', 'Segments', 'Memo'], rows });
      await app.results.endAnalysis();
    });

    expBtn.addEventListener('click', async () => {
      if (!state.segments.length) { app.results.appendError('No coded segments yet.'); return; }
      // Identify each document by the chosen label column (e.g. filename), else by
      // row number. Header takes the column's name when one is chosen.
      const labelFor = {};
      docs.forEach((d, i) => { labelFor[d.rid] = d.label || `Doc ${i + 1}`; });
      const header = state.labelColumn || 'Document';
      const rows = state.segments.map((s) => {
        const c = codeById(s.codeId);
        return [labelFor[s.doc] ?? '?', c?.group || '—', c?.name ?? '?', s.text, s.memo || ''];
      });
      await app.results.beginAnalysis('Coded segments');
      await app.results.appendTable({ columns: [header, 'Theme', 'Code', 'Text', 'Memo'], rows });
      await app.results.endAnalysis();
    });

    // A word cloud built FROM the coding: words inside coded passages, grouped and
    // coloured by the codebook's own themes/colours (not auto-detected). This lives
    // here, not in the standalone Text-analytics cloud, because the codebook is this
    // workspace's private state — another plugin can't see it.
    cloudBtn.addEventListener('click', async () => {
      if (!state.segments.length) { app.results.appendError('No coded segments yet — code some passages first.'); return; }
      const model = buildThemedCloud(state, codeById);
      if (!model.themes.length) { app.results.appendError('No words found in the coded passages (after dropping very short/common words).'); return; }
      await app.results.beginAnalysis('Themed word cloud');
      const render = (w, h) => themedCloudSvg(model.themes, w, h);
      let handle;
      handle = await app.results.appendPlot(render(720, 480), { onRedraw: (w, h) => app.results.updatePlot(handle, render(w, h)) });
      await app.results.appendTable(
        { columns: ['Theme', 'Code', 'Word', 'Count'], rows: model.tableRows, rowHeaders: false },
        { caption: `Themed Word Cloud — top ${model.tableRows.length} words across ${model.themes.length} theme(s)` },
      );
      await app.results.appendText(
        '**Size** = how often the word appears in that theme’s coded passages; **colour** = your codebook colours; **position** groups each theme together. A word coded under more than one theme appears in each, sized by its use there. Drag the lower-right grip to resize, then click **⟳ Redraw at this size** to re-pack.',
      );
      await app.results.endAnalysis();
    });

    // Refresh the pickers whenever the tab is shown again — the active dataset may have
    // changed since mount (e.g. a freshly-imported one whose columns loaded AFTER the
    // mount), and the picker would otherwise stay frozen. IntersectionObserver fires when
    // this (previously display:none) workspace frame becomes visible. Reload documents
    // only when the codeable columns actually changed, so a plain revisit stays cheap;
    // the initial observe fires a no-op (signature already set by the mount populate).
    try {
      const io = new IntersectionObserver(async (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const changed = await populateColumns();
        if (changed) { await loadDocs(); renderAll(); }
      });
      io.observe(document.documentElement);
    } catch {
      /* no IntersectionObserver → mount populate + the active-dataset-switch remount still apply */
    }

    // --- go ------------------------------------------------------------------
    await loadDocs();
    renderAll();
  },
};

/** A compact English stop-word list for the word cloud. Deliberately small — the
 * cloud is over short coded passages, not a full corpus, so this just removes the
 * obvious filler. (The standalone Text-analytics cloud uses tidytext's fuller list.) */
const STOPWORDS = new Set(
  ('a about above after again against all am an and any are aren as at be because been before being below ' +
    'between both but by can cannot could did do does doing don down during each few for from further had has ' +
    'have having he her here hers herself him himself his how i if in into is it its itself just me more most ' +
    'my myself no nor not of off on once only or other our ours ourselves out over own re s same she should so ' +
    'some such t than that the their theirs them themselves then there these they this those through to too under ' +
    'until up very was we were what when where which while who whom why will with would you your yours yourself ' +
    'yourselves').split(' '),
);

/** Tokenise text into lower-cased word tokens, dropping stop-words and tokens
 * shorter than `minlen`. Splits on any non-letter (so punctuation/digits vanish). */
function tokenize(text, minlen) {
  const out = [];
  for (const raw of String(text).toLowerCase().split(/[^\p{L}']+/u)) {
    const w = raw.replace(/^'+|'+$/g, '');
    if (w.length >= minlen && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

/** XML-escape text for safe inclusion in the SVG (re-sanitised host-side too). */
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the themed-cloud model from the codebook + coded segments. Words come from
 * the text inside each coded segment, attributed to that segment's code → its theme
 * (`code.group`, or the code's own name when it isn't grouped). A word is counted
 * per theme, so one coded under several themes yields a token in each (sized by its
 * use there); its colour is the codebook colour of the code it most came from in
 * that theme.
 *
 * @returns {{themes: Array<{name:string, words:Array<{word,count,color,codeName}>}>, tableRows: string[][]}}
 */
function buildThemedCloud(state, codeById) {
  const themeMap = new Map(); // theme name -> Map(word -> {count, byCode:{id:count}})
  const order = [];
  for (const s of state.segments) {
    if (s.region || s.tStart != null) continue; // region/time codings have no text passage — skip the cloud
    const code = codeById(s.codeId);
    if (!code) continue;
    const theme = (code.group && code.group.trim()) || code.name;
    if (!themeMap.has(theme)) { themeMap.set(theme, new Map()); order.push(theme); }
    const wmap = themeMap.get(theme);
    for (const w of tokenize(s.text || '', 3)) {
      let rec = wmap.get(w);
      if (!rec) { rec = { count: 0, byCode: {} }; wmap.set(w, rec); }
      rec.count++;
      rec.byCode[code.id] = (rec.byCode[code.id] || 0) + 1;
    }
  }
  const themes = [];
  for (const name of order) {
    const words = [...themeMap.get(name).entries()]
      .map(([word, rec]) => {
        let bestId = null, best = -1;
        for (const [cid, c] of Object.entries(rec.byCode)) { if (c > best) { best = c; bestId = cid; } }
        const code = codeById(bestId);
        return { word, count: rec.count, color: code?.color || '#666666', codeName: code?.name || '?' };
      })
      .sort((a, b) => b.count - a.count);
    if (words.length) themes.push({ name, words });
  }
  const all = [];
  for (const t of themes) for (const w of t.words) all.push([t.name, w.codeName, w.word, String(w.count)]);
  all.sort((a, b) => Number(b[3]) - Number(a[3]));
  return { themes, tableRows: all.slice(0, 40) };
}

/**
 * Render the themed cloud as SVG. Each theme gets a labelled cell on a grid; its
 * words spiral out from the cell centre with collision avoidance (so they group
 * spatially by theme and never overlap), sized by a global sqrt scale of their
 * per-theme counts and coloured with the codebook colour. Deterministic, so a
 * redraw at the same size is stable.
 */
function themedCloudSvg(themes, W, H) {
  const W2 = Math.max(360, Math.round(W));
  const H2 = Math.max(240, Math.round(H));
  let fmin = Infinity, fmax = 0;
  for (const t of themes) for (const w of t.words) { if (w.count < fmin) fmin = w.count; if (w.count > fmax) fmax = w.count; }
  if (!Number.isFinite(fmin)) fmin = 1;
  const MINPX = Math.max(10, Math.round(H2 * 0.026));
  const MAXPX = Math.max(MINPX + 8, Math.round(H2 * 0.12));
  const sq = (v) => Math.sqrt(Math.max(0, v));
  const sizeOf = (f) => {
    const t = fmax > fmin ? (sq(f) - sq(fmin)) / (sq(fmax) - sq(fmin)) : 0.5;
    return Math.round(MINPX + t * (MAXPX - MINPX));
  };
  const T = themes.length;
  const cols = Math.ceil(Math.sqrt(T));
  const cellW = W2 / cols;
  const cellH = H2 / Math.ceil(T / cols);
  const placed = [];
  const overlaps = (b) => placed.some((p) => !(b.x1 < p.x0 || b.x0 > p.x1 || b.y1 < p.y0 || b.y0 > p.y1));
  const parts = [];
  themes.forEach((theme, ti) => {
    const col = ti % cols, rowi = Math.floor(ti / cols);
    const cxc = (col + 0.5) * cellW;
    const cyc = (rowi + 0.5) * cellH;
    const labelY = rowi * cellH + 14;
    parts.push(
      `<text x="${cxc.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="12" fill="#8a93a0" text-anchor="middle" ` +
        `font-family="system-ui, sans-serif" style="font-weight:600; text-transform:uppercase; letter-spacing:.05em">` +
        `${escapeXml(theme.name)}</text>`,
    );
    placed.push({ x0: cxc - 64, x1: cxc + 64, y0: labelY - 11, y1: labelY + 4 }); // keep words clear of the label
    for (const w of theme.words) {
      const fs = sizeOf(w.count);
      const halfW = w.word.length * fs * 0.30 + 3;
      const halfH = fs * 0.62;
      const step = Math.max(2, fs * 0.22);
      let fx = cxc, fy = cyc, found = false;
      for (let sI = 0; sI < 1200; sI++) {
        const ang = 0.5 * sI;
        const rad = step * 0.18 * ang;
        const px = cxc + rad * Math.cos(ang);
        const py = cyc + rad * Math.sin(ang);
        const box = { x0: px - halfW, x1: px + halfW, y0: py - halfH, y1: py + halfH };
        if (box.x0 < 3 || box.x1 > W2 - 3 || box.y0 < 18 || box.y1 > H2 - 3) continue;
        if (!overlaps(box)) { fx = px; fy = py; placed.push(box); found = true; break; }
      }
      if (!found) {
        fx = Math.min(W2 - halfW - 3, Math.max(halfW + 3, cxc));
        fy = Math.min(H2 - halfH - 3, Math.max(halfH + 3, cyc));
        placed.push({ x0: fx - halfW, x1: fx + halfW, y0: fy - halfH, y1: fy + halfH });
      }
      const weight = fs >= (MINPX + MAXPX) / 2 ? 600 : 400;
      parts.push(
        `<text x="${fx.toFixed(1)}" y="${fy.toFixed(1)}" font-size="${fs}" fill="${w.color}" ` +
          `text-anchor="middle" dominant-baseline="central" ` +
          `font-family="system-ui, -apple-system, Segoe UI, sans-serif" style="font-weight:${weight}">` +
          `<title>${escapeXml(w.word)} — ${escapeXml(theme.name)} (${w.count})</title>${escapeXml(w.word)}</text>`,
      );
    }
  });
  return (
    `<svg viewBox="0 0 ${W2} ${H2}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Themed word cloud">` +
    `<rect x="0" y="0" width="${W2}" height="${H2}" fill="#ffffff"/>${parts.join('')}</svg>`
  );
}

/** Coerce a loaded/empty blob into the working shape. */
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    textColumn: typeof s.textColumn === 'string' ? s.textColumn : null,
    labelColumn: typeof s.labelColumn === 'string' ? s.labelColumn : null,
    codes: Array.isArray(s.codes)
      ? s.codes.filter((c) => c && c.id).map((c) => ({ ...c, group: typeof c.group === 'string' ? c.group : '', memo: typeof c.memo === 'string' ? c.memo : '' }))
      : [],
    segments: Array.isArray(s.segments)
      ? s.segments.filter((x) => x && x.doc && x.codeId).map((x) => ({ ...x, memo: typeof x.memo === 'string' ? x.memo : '' }))
      : [],
  };
}

/** Parse a media cell — a JSON array of `asset:`/`data:` refs — into a ref list, or
 * null if the cell isn't a media reference (i.e. it's a plain text document). */
function parseMediaRefs(raw) {
  const s = String(raw).trim();
  if (s[0] !== '[') return null;
  let arr;
  try { arr = JSON.parse(s); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const refs = arr.filter((x) => typeof x === 'string' && (x.startsWith('asset:') || x.startsWith('data:')));
  return refs.length ? refs : null;
}

/** Clamp to [0,1]. */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
/** Round a normalised coordinate to 4 dp — ample precision, compact in the blob. */
function round4(v) { return Math.round(v * 1e4) / 1e4; }
/** A normalised rectangle {x,y,w,h} from two corner points. */
function rectOf(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
/** Position an absolutely-placed element from a normalised rect (percent units). */
function positionPct(elm, r) {
  elm.style.left = r.x * 100 + '%';
  elm.style.top = r.y * 100 + '%';
  elm.style.width = r.w * 100 + '%';
  elm.style.height = r.h * 100 + '%';
}
/** A short human label for a region coding — shown in retrieve and exports. */
function regionLabel(r) {
  const p = (v) => Math.round(v * 100);
  return `▭ ${p(r.x)},${p(r.y)} ${p(r.w)}×${p(r.h)}%`;
}

/** Round to 3 dp — sub-millisecond time precision, compact in the blob. */
function round3(v) { return Math.round(v * 1e3) / 1e3; }
/** Format seconds as `M:SS` (or `H:MM:SS` past an hour). */
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/** A human label for a time-range coding — shown in retrieve and exports. */
function timeLabel(t0, t1) { return `${fmtTime(t0)}–${fmtTime(t1)}`; }

/** Linear interpolate. */
function lerp(a, b, f) { return a + (b - a) * f; }

/** The interpolated region {x,y,w,h} of a keyframed track at time `t` (clamped to the
 * end keyframes outside the span). Null if no keyframes. This is what turns a handful
 * of keyframes into a box that moves every frame (rung 2). */
function regionAtTime(keys, t) {
  if (!keys || !keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), w: lerp(a.w, b.w, f), h: lerp(a.h, b.h, f) };
    }
  }
  return last;
}

/** Grab a grayscale template patch for a normalised region from a canvas context.
 * Throws if the canvas is tainted (blob videos shouldn't taint, but we surface it). */
function grayPatch(ctx, region, W, H) {
  const px = Math.max(0, Math.min(W - 2, Math.round(region.x * W)));
  const py = Math.max(0, Math.min(H - 2, Math.round(region.y * H)));
  const pw = Math.max(2, Math.min(W - px, Math.round(region.w * W)));
  const ph = Math.max(2, Math.min(H - py, Math.round(region.h * H)));
  const img = ctx.getImageData(px, py, pw, ph); // SecurityError if tainted
  const g = new Float32Array(pw * ph);
  const d = img.data;
  for (let i = 0; i < pw * ph; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { g, w: pw, h: ph };
}

/** Rough translation tracker (rung 3): slide the grayscale template around the last
 * position and return the best-SSD match as a new normalised region (size preserved).
 * Deliberately simple — translation only, subsampled, early-terminated — a *suggestion*
 * the user corrects, not a robust tracker (that's the deferred WASM rung 4). */
function matchTemplate(ctx, tmpl, near, W, H) {
  const pw = tmpl.w, ph = tmpl.h;
  const cx = Math.round(near.x * W), cy = Math.round(near.y * H);
  // Search radius: enough for the motion between 0.4 s steps, capped so a big subject at
  // 1px precision doesn't blow up the inner loop.
  const rx = Math.min(Math.round(pw * 0.6) + 8, 64), ry = Math.min(Math.round(ph * 0.6) + 8, 64);
  const ax = Math.max(0, cx - rx), ay = Math.max(0, cy - ry);
  const aw = Math.min(W - ax, pw + 2 * rx), ah = Math.min(H - ay, ph + 2 * ry);
  if (aw < pw || ah < ph) return { ...near };
  const img = ctx.getImageData(ax, ay, aw, ah);
  const d = img.data, iw = aw;
  const grayAt = (X, Y) => { const i = (Y * iw + X) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  let best = Infinity, bx = cx, by = cy;
  for (let oy = 0; oy + ph <= ah; oy += 1) {
    for (let ox = 0; ox + pw <= aw; ox += 1) {
      let ssd = 0;
      for (let ty = 0; ty < ph && ssd < best; ty += 2) {
        for (let tx = 0; tx < pw; tx += 2) {
          const diff = grayAt(ox + tx, oy + ty) - tmpl.g[ty * pw + tx];
          ssd += diff * diff;
          if (ssd >= best) break;
        }
      }
      if (ssd < best) { best = ssd; bx = ax + ox; by = ay + oy; }
    }
  }
  return { x: bx / W, y: by / H, w: near.w, h: near.h };
}

/** A translucent `rgba()` fill from a `#rgb`/`#rrggbb` hex + alpha (region layers). */
function hexToRgba(hex, alpha) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (h.length !== 6 || !Number.isFinite(n)) return `rgba(136,136,136,${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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

/** Re-establish a text selection over [lo, hi) character offsets within
 * `container` — the inverse of {@link offsetWithin}. Lets a passage stay selected
 * after the transcript re-renders (so codes can be layered on it). No-op if the
 * range can't be mapped. */
function setSelectionRange(container, lo, hi) {
  const range = document.createRange();
  let acc = 0;
  let startDone = false;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (!startDone && lo <= acc + len) {
      range.setStart(n, lo - acc);
      startDone = true;
    }
    if (startDone && hi <= acc + len) {
      range.setEnd(n, hi - acc);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    acc += len;
  }
}
