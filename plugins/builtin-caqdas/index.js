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
  version: '0.8.0',
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
  imports: [
    {
      label: 'Text files → one row per file…',
      extensions: ['.txt', '.text', '.md'],
      group: 'Qualitative',
      order: 15,
      multiple: true,
      parse: 'parseTextFile',
    },
    {
      label: 'Image files (PNG, JPEG, …) → one row per file…',
      extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'],
      group: 'Media',
      datasetName: 'Images',
      order: 20,
      multiple: true,
      parse: 'parseImageFile',
    },
    {
      label: 'Audio files (MP3, WAV, M4A, …) → one row per file…',
      extensions: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba'],
      group: 'Media',
      datasetName: 'Audio',
      order: 21,
      multiple: true,
      parse: 'parseAudioFile',
    },
    {
      label: 'Video files (MP4, WebM, MOV, …) → one row per file…',
      extensions: ['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv'],
      group: 'Media',
      datasetName: 'Video',
      order: 22,
      multiple: true,
      parse: 'parseVideoFile',
    },
  ],
  // Item collections this plugin owns (#152 Layer 3). Codes and segments used to live
  // inside one opaque state blob, so the log recorded "the coding workspace changed" and
  // nothing finer: no per-coding undo, nothing in History, and merge that needed a
  // hand-written add-wins function. As records they get all three for free.
  //
  // `sidebar: 'count'` rather than 'list' — a project can hold thousands of segments, and
  // the inventory's job is to show that data EXISTS here, which a count does without
  // drowning the panel.
  // Scope is per-collection because this plugin genuinely needs two different ones.
  // A CODEBOOK is project-wide: the whole point of a coding scheme is that it outlives
  // and spans the documents it was applied to, and researchers reuse one across studies.
  // A CODING cannot be — it anchors to a `__ct_rid` row id, which belongs to exactly one
  // dataset and means nothing in another. The workspace-level `scope` flag can only say
  // one thing for both, which is why `collections[].scope` exists (see core/collections.js).
  collections: [
    { id: 'codebooks', label: 'Codebooks', labelField: 'name', sidebar: 'list', scope: 'project' },
    { id: 'codes', label: 'Codes', labelField: 'name', sidebar: 'count', scope: 'project' },
    { id: 'segments', label: 'Codings', sidebar: 'count' },
  ],
  workspaces: [{
    id: 'caqdas-coding',
    title: 'Coding',
    // Collaboration merge (#143): this workspace's blob is a *composite* (codebook
    // + coded segments + config), so it can't use a single built-in strategy —
    // it declares a custom merger, the module's `mergeState` export. The host
    // resolves `via` → the named export and calls it with the merge helpers.
    merge: { via: 'mergeState' },
    verbs: [
      { id: 'import-qdpx', label: 'REFI-QDA / QDPX project (.qdpx)…', run: 'parseQdpx', category: 'import', needsFile: { extensions: ['.qdpx'] }, group: 'Qualitative' },
      { id: 'export-qdpx', label: 'REFI-QDA / QDPX project (.qdpx)…', run: 'exportQdpx', category: 'export', group: 'Qualitative' },
    ],
  }],
};

/** Distinct, readable highlight colours (assigned round-robin to new codes). */
const PALETTE = ['#ffd166', '#8ecae6', '#a7c957', '#ffadad', '#bdb2ff', '#ffc6ff', '#caffbf', '#fdffb6', '#9bf6ff', '#ffd6a5'];
const uid = (pfx = 'c') => pfx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
.caqdas__menu { position: absolute; z-index: 20; background: #fff; border: 1px solid #ccd2d8; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 6px; min-width: 270px; max-width: 340px; max-height: 340px; overflow: auto; }
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
/* memo/annotation thread (#148) */
.caqdas__thread { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; min-width: 0; }
.caqdas__notes { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; overflow-x: hidden; }
.caqdas__notesempty { font-size: 12px; color: #99a1ab; font-style: italic; }
.caqdas__note { background: #f6f8fa; border: 1px solid #e3e8ee; border-radius: 6px; padding: 5px 7px; min-width: 0; }
.caqdas__note--legacy { background: #fbfaf3; }
.caqdas__noterow { display: flex; align-items: center; gap: 6px; margin: 0 0 3px; min-width: 0; }
.caqdas__notechip { flex: none; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.caqdas__notewho { font-size: 11px; font-weight: 600; color: #41505e; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__notemeta { font-size: 10.5px; color: #9aa3ab; font-style: italic; margin: 0 0 2px; }
.caqdas__notedel { flex: none; border: 0; background: none; color: #b04a4a; cursor: pointer; font-size: 11px; padding: 0 2px; }
.caqdas__notebody { font-size: 12px; color: #2c3742; white-space: pre-wrap; word-break: break-word; }
.caqdas__noteadd { display: flex; flex-direction: column; gap: 4px; }
.caqdas__noteinput { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid #ccd2d8; border-radius: 6px; resize: vertical; }
.caqdas__noteadd .caqdas__btn { align-self: flex-end; font-size: 12px; padding: 3px 10px; }
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
    const state = await loadState(app);
    // Who's coding (#148): stamp each code/segment THIS user creates with an identity
    // snapshot, so a team can run inter-coder reliability (κ/α). Self-asserted; the
    // authorId is always present even before a name is set. Imported codings (resolved
    // from a QDPX) are left unstamped — they aren't this user's work.
    let me = null;
    try { me = await app.identity?.get?.(); } catch { /* identity is optional */ }
    // Stamp a stable id + the author. The id makes each coder's application a DISTINCT
    // record so two coders coding the same passage don't collapse under the add-wins
    // merge (which would silently discard one and defeat inter-coder reliability) — and
    // it gives a memo (#148 step 3) a durable anchor. Agreement is a DERIVED view over
    // these per-coder records, not a storage-level coalescing. id is added even when no
    // identity is set (authorId still distinguishes coders); a code keeps its own id.
    const authored = (o) => {
      const r = { id: o.id || uid(), ...o };
      if (me) r.author = me;
      return r;
    };
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
      saveTimer = setTimeout(() => { void syncState(app, state); }, 300);
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

    // --- memos / annotation threads (#148 step 3) ----------------------------
    // Flat, chronological, author-stamped notes anchored to a segment or code by id.
    // Separate add-wins collection (state.memos) so faculty + student can both annotate
    // the same coding without clobbering. Replaces the old single inline `memo` string
    // (any legacy value shows as a read-only "earlier note").
    const memosFor = (anchorId) =>
      (state.memos || (state.memos = [])).filter((n) => n.anchorId === anchorId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const hasNotes = (obj) => !!(obj && ((typeof obj.memo === 'string' && obj.memo.trim()) || (obj.id && memosFor(obj.id).length)));
    // Ensure an anchor has a stable id (legacy segments predate ids) so a note can point
    // at it; a fresh id here is a rare one-off for old data.
    const anchorIdOf = (obj) => { if (!obj.id) { obj.id = uid(); save(); } return obj.id; };
    const addMemo = (anchorKind, anchorId, text) => {
      const t = String(text || '').trim();
      if (!t) return;
      (state.memos || (state.memos = [])).push({ id: uid(), anchorKind, anchorId, text: t, ...(me ? { author: me } : {}), createdAt: Date.now() });
      save();
    };
    const deleteMemo = (id) => { state.memos = (state.memos || []).filter((n) => n.id !== id); save(); };

    /** Build a notes-thread panel for one anchor (a segment or code): a chronological,
     * author-stamped list + an add-note box. `onChange` refreshes any has-note markers. */
    function renderThread(anchorKind, anchorObj, onChange) {
      const anchorId = anchorIdOf(anchorObj);
      const wrap = el('div', 'caqdas__thread');
      const list = el('div', 'caqdas__notes');
      const rebuild = () => {
        list.replaceChildren();
        const legacy = typeof anchorObj.memo === 'string' && anchorObj.memo.trim();
        if (legacy) {
          const n = el('div', 'caqdas__note caqdas__note--legacy');
          const meta = el('div', 'caqdas__notemeta'); meta.textContent = 'earlier note';
          const body = el('div', 'caqdas__notebody'); body.textContent = anchorObj.memo;
          n.append(meta, body); list.append(n);
        }
        for (const note of memosFor(anchorId)) {
          const a = note.author || {};
          const n = el('div', 'caqdas__note');
          const row = el('div', 'caqdas__noterow');
          const chip = el('span', 'caqdas__notechip'); chip.textContent = a.initials || '·';
          chip.style.background = a.color || '#8a94a0'; chip.title = a.name || a.initials || 'Unknown';
          const who = el('span', 'caqdas__notewho'); who.textContent = a.name || a.initials || 'Unknown';
          row.append(chip, who);
          if (me && a.authorId === me.authorId) {
            const del = el('button', 'caqdas__notedel'); del.textContent = '✕'; del.title = 'Delete your note';
            del.addEventListener('click', (e) => { e.stopPropagation(); deleteMemo(note.id); rebuild(); onChange?.(); });
            row.append(del);
          }
          const body = el('div', 'caqdas__notebody'); body.textContent = note.text;
          n.append(row, body); list.append(n);
        }
        if (!list.children.length) { const e0 = el('div', 'caqdas__notesempty'); e0.textContent = 'No notes yet.'; list.append(e0); }
      };
      rebuild();
      const addRow = el('div', 'caqdas__noteadd');
      const ta = el('textarea', 'caqdas__noteinput'); ta.rows = 2; ta.placeholder = 'Add a note…';
      ta.addEventListener('click', (e) => e.stopPropagation());
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } });
      const btn = el('button', 'caqdas__btn'); btn.textContent = 'Add note';
      const post = () => { if (!ta.value.trim()) return; addMemo(anchorKind, anchorId, ta.value); ta.value = ''; rebuild(); onChange?.(); };
      btn.addEventListener('click', (e) => { e.stopPropagation(); post(); });
      addRow.append(ta, btn);
      wrap.append(list, addRow);
      return wrap;
    }
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
        const memoed = covering.some((s) => hasNotes(s));
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
    // never inlined in the dataset; the host hands us a Blob via app.assets.load and we
    // render it from an in-realm blob: URL (allowed by the media-CSP sandbox).
    async function renderMedia(doc) {
      textPane.textContent = '';
      imageSel = null; timeSel = null;
      currentOverlay = null; currentTimeline = null; currentLanes = null; currentMediaEl = null; currentMedium = null;
      const loading = el('div', 'caqdas__empty'); loading.textContent = 'Loading media…';
      textPane.append(loading);
      const token = ++mediaLoadToken;
      let blob = null;
      try { blob = await app.assets.load(doc.refs[0]); } catch { blob = null; }
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
        const box = el('div', 'caqdas__region' + (hasNotes(s) ? ' has-memo' : ''));
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
      state.segments.push(authored({
        doc: activeRid,
        codeId,
        region: { x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) },
        text: regionLabel(region), // a human label so retrieve/export/counts work unchanged
      }));
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
          const bar = el('div', 'caqdas__lanebar' + (hasNotes(s) ? ' has-memo' : '') + (s.keys ? ' is-track' : ''));
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
      state.segments.push(authored({
        doc: activeRid,
        codeId,
        tStart: round3(span.tStart),
        tEnd: round3(span.tEnd),
        text: timeLabel(span.tStart, span.tEnd),
      }));
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
      const seg = authored({
        doc: activeRid, codeId,
        keys: [{ t, x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) }],
        tStart: t, tEnd: t, text: timeLabel(t, t),
      });
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
      for (const code of codesInBook(state)) { const g = code.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(code); }
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
          const mb = el('button', 'caqdas__iconbtn' + (hasNotes(code) ? ' has' : '')); mb.textContent = '✎'; mb.title = 'Notes + theme group (code details)';
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
            panel.append(gi, renderThread('code', code, renderCodes)); // author-stamped notes thread (#148)
            codePane.append(panel);
          }
        }
      }
      // inline "new code"
      const nc = el('div', 'caqdas__newcode');
      const inp = el('input'); inp.placeholder = 'New code…';
      const add = el('button', 'caqdas__btn'); add.textContent = '＋';
      add.setAttribute('aria-label', 'Add code'); add.title = 'Add code';
      const commit = () => {
        const name = inp.value.trim();
        if (!name) return;
        const mine = codesInBook(state);
        state.codes.push(authored({ id: uid(), name, color: PALETTE[mine.length % PALETTE.length], group: '', memo: '', codebookId: state.codebookId }));
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
        const merged = authored({ doc: activeRid, codeId, start: lo, end: hi, text: doc ? doc.text.slice(lo, hi) : span.text });
        if (memos.length) merged.memo = memos.join('\n'); // keep any legacy inline notes
        // Re-anchor annotation notes from the absorbed segments onto the merged one (#148).
        const hitIds = new Set(hits.map((s) => s.id).filter(Boolean));
        if (hitIds.size && Array.isArray(state.memos)) {
          for (const n of state.memos) if (hitIds.has(n.anchorId)) n.anchorId = merged.id;
        }
        state.segments = state.segments.filter((s) => !hits.includes(s));
        state.segments.push(merged);
        save();
      } else {
        state.segments.push(authored({ doc: activeRid, codeId, start: lo, end: hi, text: span.text }));
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
      for (const code of codesInBook(state)) {
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
        const code = authored({ id: uid(), name, color: PALETTE[codesInBook(state).length % PALETTE.length], group: '', memo: '', codebookId: state.codebookId });
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
        menu.append(renderThread('segment', seg, refreshView)); // author-stamped notes thread (#148)
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
      if (!codesInBook(state).length) { app.results.appendError('No codes yet — create some in the Coding tab.'); return; }
      // Order by theme group (matching the codebook), so the table reads as a
      // themed code summary; show each code's memo when present.
      const ordered = codesInBook(state).slice().sort((a, b) => (a.group || '~').localeCompare(b.group || '~') || a.name.localeCompare(b.name));
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
      // A chart MODEL rather than a hand-rolled SVG: the host owns layout (grouped by
      // theme, or one pooled cloud — a view this never had), sizing and persistence.
      // The codebook COLOUR travels with each word and beats the palette control,
      // because in CAQDAS a code's colour is data: it appears on every other surface,
      // and a cloud that repainted it would silently disagree with all of them.
      await app.results.appendChart({
        kind: 'wordcloud',
        title: 'Themed word cloud',
        words: model.themes.flatMap((t) => t.words.map((w) => ({
          word: w.word,
          count: w.count,
          theme: t.name,
          themeName: t.name,
          color: w.color,
        }))),
      });
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

    /** Resolve a just-imported QDPX project's codings (keyed by row index) into real
     * segments now that docs (with row-ids) are loaded, then clear the marker + save.
     * Rows are in source order, so `docs[row]` is the source that coding belongs to. */
    function resolvePendingImport() {
      const pending = state.pendingImport;
      if (!pending) return;
      const have = new Set(state.codes.map((c) => c.id));
      const { codes, segments, dropped } = resolveImportedCodings(pending, docs, have);
      // Codes FIRST: the segments reference them, and `save()` writes both collections
      // in one pass, so a code has to exist in `state` before its codings do.
      state.codes.push(...codes);
      state.segments.push(...segments);
      if (dropped) console.warn(`[caqdas] ${dropped} imported coding(s) dropped — no matching document or code`);
      delete state.pendingImport;
      save();
    }

    // --- dataset-change refresh ------------------------------------------------
    // Stash a callback so onDatasetChanged (outside mount's closure) can trigger
    // a full state reload without tearing down the iframe.
    workspace._onDsChanged = async () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      const fresh = await loadState(app);
      Object.assign(state, fresh);
      resetPersisted(state);
      docs = [];
      activeRid = null;
      activeCodeId = null;
      retrieveCodeId = null;
      memoOpen.clear();
      hiddenCodes.clear();
      if (mediaObjectUrl) { URL.revokeObjectURL(mediaObjectUrl); mediaObjectUrl = null; }
      mediaLoadToken++;
      imageSel = null; currentOverlay = null;
      timeSel = null; currentTimeline = null; currentLanes = null; currentMediaEl = null;
      currentMedium = null;
      activeTrack = null; videoSel = null; currentVideoOverlay = null; trackToolbarEl = null;
      tracking = false;
      await populateColumns();
      await loadDocs();
      if (state.pendingImport) resolvePendingImport();
      renderAll();
    };

    // --- go ------------------------------------------------------------------
    await loadDocs();
    if (state.pendingImport) resolvePendingImport();
    renderAll();
  },

  async onDatasetChanged(app) {
    if (app.debug) console.debug('[caqdas] onDatasetChanged');
    if (workspace._onDsChanged) await workspace._onDsChanged();
    if (app.debug) console.debug('[caqdas] onDatasetChanged OK');
  },

  // A collaborator's coding arrived (folder/live sync merged the codebook) — re-read the
  // now-merged state and re-render IN PLACE. Critical for co-authoring: the host must NOT
  // tear down + remount this iframe on a peer's change (a remount re-runs the sandbox
  // handshake, which times out when the window is backgrounded — the "workspace crashed"
  // two-window bug). Reuses the dataset-change reload (re-reads app.state.get()).
  async onRefresh(app) {
    if (app.debug) console.debug('[caqdas] onRefresh');
    if (workspace._onDsChanged) await workspace._onDsChanged();
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

/** Coerce a loaded/empty blob into the working shape. */
/**
 * Collaboration merge for the CAQDAS **config blob** (#143, narrowed by #152 Layer 3).
 *
 * Codes, segments and memos are no longer here. They are item records and host memos,
 * which merge by op-UNION in the kernel: disjoint records union automatically, and a
 * concurrent edit to one record resolves per FIELD by HLC. The hand-written add-wins
 * pass this function used to run was reimplementing, less well, what op identity gives
 * for free — two coders on the same passage stay distinct because their codings are
 * separate records, and two annotations on one coding both survive because they are
 * separate memos. Neither property needs a custom merger any more.
 *
 * What is left is genuinely blob-shaped: which column holds the documents and which
 * holds their labels. Config, no identity worth addressing, last-writer-wins (#152 D2).
 *
 * Pure: receives the merge helpers, imports nothing (headlessly testable).
 *
 * @param {{ancestor:object, mine:object, theirs:object, helpers:object}} arg
 * @returns {{resolved:object, conflicts:object[]}}
 */
export function mergeState({ ancestor, mine, theirs, helpers }) {
  const a = normalize(ancestor);
  const m = normalize(mine);
  const t = normalize(theirs);
  const OWNER = 'builtin-caqdas';
  const conflicts = [];

  const cfg = (key) => {
    const r = helpers.lww(a[key], { value: m[key] }, { value: t[key] }, OWNER, key);
    conflicts.push(...r.conflicts);
    return r.resolved;
  };

  return {
    resolved: {
      version: 1,
      textColumn: cfg('textColumn'),
      labelColumn: cfg('labelColumn'),
    },
    conflicts,
  };
}

// =====================================================================
// Item-backed persistence (#152 Layer 3)
// =====================================================================
//
// The in-memory `state` shape is unchanged — a hundred call sites read
// `state.codes` / `state.segments` / `state.memos` and none of them had to move. What
// changed is the boundary: load builds that shape from item records, and save DIFFS it
// back to per-record ops instead of overwriting one blob.
//
// Diffing rather than rewriting each call site is a deliberate trade. It keeps the change
// contained to two functions, and it still produces the granularity that matters: apply a
// code and the log gets one `putItem` for that coding, not a fresh copy of the entire
// codebook. Coarse enough that a 300 ms burst of edits coalesces, fine enough that undo
// and History have something meaningful to point at.
//
// `textColumn` / `labelColumn` stay in the workspace BLOB. They are config, they have no
// identity worth addressing, and the blob path exists precisely for that (#152 D2).

/** Shadow of what is currently persisted, so save can diff. Per mount. */
let persisted = { codebooks: new Map(), codes: new Map(), segments: new Map(), memos: new Map() };

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Rebuild the diff shadow after a load, so the next save writes only real changes. */
function resetPersisted(state) {
  persisted = {
    codebooks: new Map((state.codebooks ?? []).map((b) => [b.id, clone(b)])),
    codes: new Map((state.codes ?? []).map((c) => [c.id, clone(c)])),
    segments: new Map((state.segments ?? []).map((x) => [x.id, clone(x)])),
    memos: new Map((state.memos ?? []).map((m) => [m.id, clone(m)])),
  };
}

/** A CAQDAS memo's anchor as a host memo anchor: the item target of the code or
 * segment it hangs on. This is why memos could move to the host without inventing an
 * addressing scheme — an anchored note points at a target, and records have targets. */
function memoAnchor(anchorKind, anchorId) {
  const collection = anchorKind === 'code' ? 'codes' : 'segments';
  return { kind: 'item', target: `item:builtin\u0000${collection}\u0000${anchorId}`, ref: anchorKind };
}

/** Is this host memo one of ours? (anchored to a code or segment record) */
const isOurMemo = (m) => typeof m?.anchor?.target === 'string'
  && m.anchor.target.startsWith('item:builtin\u0000')
  && (m.anchor.target.includes('\u0000codes\u0000') || m.anchor.target.includes('\u0000segments\u0000'));

/** The anchor id + kind a host memo refers to, in the shape the UI expects. */
function memoBack(m) {
  const parts = String(m.anchor.target).split('\u0000');
  return {
    id: m.id,
    anchorKind: parts[1] === 'codes' ? 'code' : 'segment',
    anchorId: parts[2],
    text: m.text,
    ...(m.author ? { author: m.author } : {}),
    createdAt: m.createdAt || 0,
  };
}

/** Build the working state from the host's records + the config blob. */
async function loadState(app) {
  const cfg = normalize(await app.state.get());
  let codes = [];
  let segments = [];
  let memos = [];
  let codebooks = [];
  try {
    codebooks = (await app.items.list('codebooks')).map((r) => ({ id: r.id, ...r.fields }));
    codes = (await app.items.list('codes')).map((r) => ({ id: r.id, ...r.fields }));
    segments = (await app.items.list('segments')).map((r) => ({ id: r.id, ...r.fields }));
  } catch (e) {
    console.warn('[caqdas] item load failed', e);
  }
  try {
    memos = (await app.memos.list()).filter(isOurMemo).map(memoBack);
  } catch (e) {
    console.warn('[caqdas] memo load failed', e);
  }
  const state = {
    ...cfg,
    codebooks,
    codes,
    segments,
    memos,
  };
  // Snapshot what was actually LOADED before bootstrapping, so anything the bootstrap
  // invents registers as a pending change rather than as already-saved.
  resetPersisted(state);
  // …then create the default codebook in memory only. Nothing is written here: mounting
  // a workspace must never write state (the mount-before-hydrate clobber), and a user
  // who opens the Coding tab and closes it again should leave no trace. The default book
  // is flushed by the first real save, alongside whatever prompted it.
  adoptIntoCodebook(state);
  return state;
}

/** Write whatever actually changed: one op per changed record, plus the config blob. */
async function syncState(app, state) {
  // Config (small, identity-free) stays a blob — but strip the collections out of it so
  // the same data never lives in two places.
  const { codebooks, codes, segments, memos, ...cfg } = state;
  await app.state.set(cfg);

  for (const [collection, arr] of [['codebooks', codebooks ?? []], ['codes', codes ?? []], ['segments', segments ?? []]]) {
    const now = new Map(arr.filter((x) => x && x.id).map((x) => [x.id, x]));
    for (const [id, val] of now) {
      const prev = persisted[collection].get(id);
      if (prev && same(prev, val)) continue;
      const { id: _drop, ...fields } = val;
      await app.items.put(collection, id, fields);
    }
    for (const id of persisted[collection].keys()) {
      if (!now.has(id)) await app.items.remove(collection, id);
    }
    persisted[collection] = new Map([...now].map(([k, v]) => [k, clone(v)]));
  }

  // Memos go to the HOST collection, not one of ours (#152 Layer 2): a note written on a
  // coding and one written on an analysis must be the same kind of record.
  const nowMemos = new Map((memos ?? []).filter((m) => m && m.id).map((m) => [m.id, m]));
  for (const [id, m] of nowMemos) {
    const prev = persisted.memos.get(id);
    if (!prev) {
      // Newly composed in the UI: mint it host-side and adopt the id it gives back.
      const newId = await app.memos.add(memoAnchor(m.anchorKind, m.anchorId), m.text);
      if (newId) m.id = newId;
    } else if (prev.text !== m.text) {
      await app.memos.setText(id, m.text);
    }
  }
  for (const id of persisted.memos.keys()) {
    if (!nowMemos.has(id)) await app.memos.remove(id);
  }
  persisted.memos = new Map([...nowMemos].map(([, v]) => [v.id, clone(v)]));
}

/**
 * Turn a just-imported QDPX payload into codes + segments, given the loaded documents.
 *
 * Pure, and separate from the mount, for two reasons: this is the step that silently
 * lost every imported code (see `parseQdpx`), and the row-index → row-id mapping it
 * performs is the sort of thing that should be checkable without standing up an iframe.
 *
 * `pending.codings` address documents by ROW INDEX, because at import time no dataset
 * exists yet and therefore no `__ct_rid` values do either. They are resolved here, at
 * mount, against the docs actually loaded.
 *
 * @param {{codes?:object[], codings?:object[]}} pending
 * @param {{rid:string, kind:string, text?:string}[]} docs
 * @param {Set<string>} haveCodeIds ids already present, so a re-run cannot duplicate
 * @returns {{codes:object[], segments:object[], dropped:number}}
 */
export function resolveImportedCodings(pending, docs, haveCodeIds = new Set()) {
  const out = { codes: [], segments: [], dropped: 0 };
  if (!pending || typeof pending !== 'object') return out;

  for (const c of Array.isArray(pending.codes) ? pending.codes : []) {
    if (c && c.id && !haveCodeIds.has(c.id)) out.codes.push(c);
  }
  const known = new Set([...haveCodeIds, ...out.codes.map((c) => c.id)]);

  for (const pc of Array.isArray(pending.codings) ? pending.codings : []) {
    const doc = docs[pc && pc.row];
    // A coding whose code did not survive is dropped rather than kept as a dangling
    // reference: a segment pointing at a missing code renders as "(code)" and cannot be
    // repaired by hand. Counting them makes the loss reportable instead of invisible.
    if (!doc || !pc.codeId || !pc.data || !known.has(pc.codeId)) { out.dropped++; continue; }
    const memo = typeof pc.memo === 'string' ? pc.memo : '';
    if (pc.type === 'text') {
      const start = pc.data.start | 0;
      const end = pc.data.end | 0;
      const text = doc.kind === 'text' ? String(doc.text || '').slice(start, end) : '';
      out.segments.push({ doc: doc.rid, codeId: pc.codeId, start, end, text, memo });
    } else if (pc.type === 'region') {
      const g = pc.data;
      out.segments.push({ doc: doc.rid, codeId: pc.codeId, region: { x: round4(g.x), y: round4(g.y), w: round4(g.w), h: round4(g.h) }, text: regionLabel(g), memo });
    } else if (pc.type === 'time') {
      out.segments.push({ doc: doc.rid, codeId: pc.codeId, tStart: round3(pc.data.tStart), tEnd: round3(pc.data.tEnd), text: timeLabel(pc.data.tStart, pc.data.tEnd), memo });
    } else {
      out.dropped++;
    }
  }
  return out;
}

/**
 * Make sure there is a codebook, and that every code belongs to one.
 *
 * Runs on load rather than as a migration, which is the whole reason no migration was
 * needed: codes became project-scoped, so a project's existing codes simply appear in
 * the project-wide list and get adopted into a default book the first time it opens.
 * Nothing is rewritten ahead of time and nothing is lost if the feature is never used.
 *
 * The active book is remembered per DATASET (it lives in the config blob, which is
 * dataset-scoped) — so two datasets in one project can be coded against different
 * schemes, or the same one, and each remembers its own choice.
 */
function adoptIntoCodebook(state) {
  if (!state.codebooks.length) {
    state.codebooks.push({ id: uid('b'), name: 'Codebook' });
  }
  const known = new Set(state.codebooks.map((b) => b.id));
  if (!state.codebookId || !known.has(state.codebookId)) {
    state.codebookId = state.codebooks[0].id;
  }
  for (const c of state.codes) {
    if (!c.codebookId || !known.has(c.codebookId)) c.codebookId = state.codebookId;
  }
}

/** The codes in the currently-selected codebook — what the coding UI works with. */
function codesInBook(state) {
  return state.codes.filter((c) => c.codebookId === state.codebookId);
}

function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    textColumn: typeof s.textColumn === 'string' ? s.textColumn : null,
    labelColumn: typeof s.labelColumn === 'string' ? s.labelColumn : null,
    // Which codebook THIS dataset is coded against. Config, not content — it is a
    // per-dataset choice about project-wide data, so it belongs in the blob.
    codebookId: typeof s.codebookId === 'string' ? s.codebookId : null,
    codebooks: [],
    // Codes, segments and memos are no longer part of this blob — they are item records
    // and host memos (#152 Layer 3). Defaults keep the working shape intact for callers
    // that build a state object without loading one.
    codes: [],
    segments: [],
    memos: [],
    // A just-imported QDPX project stashes codings keyed by row index here; the mount
    // resolves them to row-ids once docs are loaded, then clears it (#139).
    ...(s.pendingImport && typeof s.pendingImport === 'object' ? { pendingImport: s.pendingImport } : {}),
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

// =====================================================================
// REFI-QDA / QDPX export (#139)
// The host invokes this from File ▸ Export data… (declared in manifest.exports). It
// runs in the plugin's COMPUTE frame, reads its OWN codings via app.state.read (the
// owner-scoped capability), reads the source docs from the active dataset, maps them
// to the QDPX schema, and builds the .qdpx ZIP with app.zip. A .qdpx is a ZIP holding
// `project.qde` (the XML) + a `Sources/` folder of the actual text/media files.
//
// Fidelity: text spans, image rectangles, and audio/video time spans round-trip;
// region-over-time exports as its TIME SPAN only (QDPX has no moving-region concept).
//
// SCHEMA CAVEATS to validate against a real tool (NVivo/ATLAS/MAXQDA) and adjust:
//   - TIME UNITS: begin/end are emitted in MILLISECONDS. If the target expects
//     seconds, flip TIME_SCALE to 1.
//   - Exact element/attribute names follow the published REFI-QDA structure; verify
//     against the .xsd before relying on interop.
// =====================================================================

const TIME_SCALE = 1000; // seconds → the unit QDPX begin/end expect (ms). See caveat above.

export async function exportQdpx(app) {
  // Runs in the compute frame, so `app.items` here is the plugin-id-bound binding from
  // core/loader.js rather than a workspace mount's (#152).
  const cfg = normalize(await app.state.read('caqdas-coding'));
  const state = {
    ...cfg,
    codes: (await app.items.list('codes')).map((r) => ({ id: r.id, ...r.fields })),
    segments: (await app.items.list('segments')).map((r) => ({ id: r.id, ...r.fields })),
  };
  if (!state.textColumn) throw new Error('Open the Coding tab and pick a documents column before exporting.');
  if (!state.segments.length) throw new Error('Nothing to export yet — code some passages first.');

  const codeGuid = new Map();
  for (const c of state.codes) codeGuid.set(c.id, qdpxUuid());

  const meta = await app.data.getVariableMeta();
  const has = (n) => meta.some((m) => m.name === n);
  const vars = [state.textColumn];
  if (state.labelColumn && state.labelColumn !== state.textColumn) vars.push(state.labelColumn);
  for (const c of ['width', 'height']) if (has(c) && !vars.includes(c)) vars.push(c);
  const rows = await app.data.getRows({ variables: vars, includeRowId: true, limit: 100000 });

  const byDoc = new Map();
  for (const s of state.segments) { if (!byDoc.has(s.doc)) byDoc.set(s.doc, []); byDoc.get(s.doc).push(s); }

  const sourceEls = [];
  const files = []; // ZIP entries for Sources/
  for (const r of rows) {
    const rid = String(r.__rid);
    const segs = byDoc.get(rid);
    if (!segs || !segs.length) continue; // only export coded documents
    const label = state.labelColumn && r[state.labelColumn] != null ? String(r[state.labelColumn]) : `Document ${rid}`;
    const cell = String(r[state.textColumn] ?? '');
    const refs = parseMediaRefs(cell);
    const guid = qdpxUuid();

    if (!refs) {
      // Text document → TextSource + PlainTextSelections.
      const fname = guid + '.txt';
      files.push({ name: 'Sources/' + fname, data: cell });
      const sels = segs.filter((s) => s.start != null).map((s) =>
        `<PlainTextSelection guid="${qdpxUuid()}" startPosition="${s.start}" endPosition="${s.end}">${codingXml(s, codeGuid)}</PlainTextSelection>`,
      );
      sourceEls.push(`<TextSource guid="${guid}" name="${xesc(label)}" plainTextPath="internal://${fname}">${sels.join('')}</TextSource>`);
      continue;
    }

    const blob = await app.assets.load(refs[0]);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const medium = String(blob.type || '').split('/')[0];
    const fname = guid + '.' + extForType(blob.type);
    files.push({ name: 'Sources/' + fname, data: bytes });

    if (medium === 'image') {
      const W = Number(r.width) || 1000, H = Number(r.height) || 1000;
      const sels = segs.filter((s) => s.region).map((s) => {
        const g = s.region;
        return `<PictureSelection guid="${qdpxUuid()}" firstX="${Math.round(g.x * W)}" firstY="${Math.round(g.y * H)}" secondX="${Math.round((g.x + g.w) * W)}" secondY="${Math.round((g.y + g.h) * H)}">${codingXml(s, codeGuid)}</PictureSelection>`;
      });
      sourceEls.push(`<PictureSource guid="${guid}" name="${xesc(label)}" path="internal://${fname}">${sels.join('')}</PictureSource>`);
    } else if (medium === 'audio' || medium === 'video') {
      const stag = medium === 'video' ? 'VideoSource' : 'AudioSource';
      const seltag = medium === 'video' ? 'VideoSelection' : 'AudioSelection';
      // time-only AND region-over-time both export as a time span (region-over-time
      // drops its spatial keyframes — QDPX can't represent them).
      const sels = segs.filter((s) => s.tStart != null).map((s) =>
        `<${seltag} guid="${qdpxUuid()}" begin="${Math.round(s.tStart * TIME_SCALE)}" end="${Math.round(s.tEnd * TIME_SCALE)}">${codingXml(s, codeGuid)}</${seltag}>`,
      );
      sourceEls.push(`<${stag} guid="${guid}" name="${xesc(label)}" path="internal://${fname}">${sels.join('')}</${stag}>`);
    }
  }

  const codeEls = state.codes.map((c) =>
    `<Code guid="${codeGuid.get(c.id)}" name="${xesc(c.name)}" isCodable="true"${c.color ? ` color="${xesc(c.color)}"` : ''}/>`,
  ).join('');
  const qde =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<Project xmlns="urn:QDA-XML:project:1.0" name="${xesc(state.labelColumn || 'CrossTab coding')}" origin="CrossTab">` +
    `<CodeBook><Codes>${codeEls}</Codes></CodeBook>` +
    `<Sources>${sourceEls.join('')}</Sources>` +
    `</Project>`;
  files.unshift({ name: 'project.qde', data: qde });

  const zipBytes = await app.zip.make(files);
  return { filename: 'coding.qdpx', mimeType: 'application/zip', data: zipBytes };
}

/** A `<Coding>` wrapping a `<CodeRef>` to the segment's code (+ its memo as a note). */
function codingXml(s, codeGuid) {
  const ref = codeGuid.get(s.codeId);
  if (!ref) return '';
  const note = s.memo ? `<Description>${xesc(s.memo)}</Description>` : '';
  return `<Coding guid="${qdpxUuid()}"><CodeRef targetGUID="${ref}"/>${note}</Coding>`;
}

/** XML-escape text/attribute content. */
function xesc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A file extension for a media MIME type (for the internal Sources/ filename). */
function extForType(type) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  };
  return map[type] || (String(type).split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
}

/** A GUID for QDPX entities. */
function qdpxUuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// =====================================================================
// REFI-QDA / QDPX import (#139) — the mirror of the exporter (manifest.imports).
// Does the whole job with capabilities (no host commit): unzip, parse project.qde,
// put media into the store, CREATE a dataset (inactive), write its coding blob keyed
// by ROW INDEX, then activate it. caqdas resolves row-index → row-id at mount (see
// resolvePendingImport) — sidestepping the row-id chicken-and-egg. Faithful: text
// spans → text codings, picture rects → image regions, audio/video time → time
// codings (no region-over-time — the user adds spatial later). Same schema caveats as
// the exporter (TIME_SCALE ms vs s; not XSD-verified).
// =====================================================================

export async function parseQdpx(app, { name, file }) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = await app.zip.read(buf);
  const byName = new Map(entries.map((e) => [e.name.replace(/^\.\//, ''), e.data]));
  const qde = entries.find((e) => /(^|\/)project\.qde$/i.test(e.name));
  if (!qde) throw new Error('Not a QDPX project — no project.qde inside the archive.');
  const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(qde.data), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not parse the QDPX project XML.');

  // Codes: guid → a fresh caqdas code.
  const codeIdByGuid = new Map();
  const codes = [];
  for (const el of doc.getElementsByTagName('Code')) {
    const guid = el.getAttribute('guid');
    if (!guid || codeIdByGuid.has(guid)) continue;
    const id = 'c_' + guid;
    codeIdByGuid.set(guid, id);
    codes.push({ id, name: el.getAttribute('name') || '(code)', color: el.getAttribute('color') || PALETTE[codes.length % PALETTE.length], group: '', memo: '' });
  }

  const names = [];
  const content = [];
  const codings = []; // { row, type, data, codeId, memo }
  const sourcesEl = doc.getElementsByTagName('Sources')[0];
  const internal = (p) => String(p || '').replace(/^internal:\/\//, '');
  const codeRefs = (sel) => Array.from(sel.getElementsByTagName('CodeRef')).map((r) => codeIdByGuid.get(r.getAttribute('targetGUID'))).filter(Boolean);
  const memoOf = (sel) => {
    const d = sel.getElementsByTagName('Description')[0];
    return d ? d.textContent || '' : '';
  };
  let row = 0;
  for (const s of sourcesEl ? Array.from(sourcesEl.children) : []) {
    const tag = s.localName;
    const label = s.getAttribute('name') || `Source ${row + 1}`;
    if (tag === 'TextSource') {
      const raw = byName.get('Sources/' + internal(s.getAttribute('plainTextPath')));
      names.push(label);
      content.push(raw ? new TextDecoder('utf-8').decode(raw) : s.textContent || '');
      for (const sel of s.getElementsByTagName('PlainTextSelection')) {
        const data = { start: parseInt(sel.getAttribute('startPosition'), 10) || 0, end: parseInt(sel.getAttribute('endPosition'), 10) || 0 };
        for (const cid of codeRefs(sel)) codings.push({ row, type: 'text', data, codeId: cid, memo: memoOf(sel) });
      }
    } else if (tag === 'PictureSource') {
      const bytes = byName.get('Sources/' + internal(s.getAttribute('path')));
      const ref = bytes ? await putImportedMedia(app, bytes, internal(s.getAttribute('path')), label) : null;
      names.push(label);
      content.push(ref ? JSON.stringify([ref]) : '');
      const dims = bytes ? await decodeImageDims(bytes, mimeForPath(internal(s.getAttribute('path')))) : { w: 0, h: 0 };
      const W = dims.w || 1000, H = dims.h || 1000;
      for (const sel of s.getElementsByTagName('PictureSelection')) {
        const x1 = num(sel.getAttribute('firstX')), y1 = num(sel.getAttribute('firstY'));
        const x2 = num(sel.getAttribute('secondX')), y2 = num(sel.getAttribute('secondY'));
        const data = { x: Math.min(x1, x2) / W, y: Math.min(y1, y2) / H, w: Math.abs(x2 - x1) / W, h: Math.abs(y2 - y1) / H };
        for (const cid of codeRefs(sel)) codings.push({ row, type: 'region', data, codeId: cid, memo: memoOf(sel) });
      }
    } else if (tag === 'AudioSource' || tag === 'VideoSource') {
      const p = internal(s.getAttribute('path'));
      const bytes = byName.get('Sources/' + p);
      const ref = bytes ? await putImportedMedia(app, bytes, p, label) : null;
      names.push(label);
      content.push(ref ? JSON.stringify([ref]) : '');
      const seltag = tag === 'VideoSource' ? 'VideoSelection' : 'AudioSelection';
      for (const sel of s.getElementsByTagName(seltag)) {
        const data = { tStart: num(sel.getAttribute('begin')) / TIME_SCALE, tEnd: num(sel.getAttribute('end')) / TIME_SCALE };
        for (const cid of codeRefs(sel)) codings.push({ row, type: 'time', data, codeId: cid, memo: memoOf(sel) });
      }
    } else {
      continue; // PDF / unknown source types skipped for now
    }
    row++;
  }
  if (!names.length) throw new Error('No text/image/audio/video sources found in the QDPX project.');

  const variables = [
    { name: 'name', type: 'string', measurementLevel: 'nominal', label: 'Source' },
    { name: 'source', type: 'string', measurementLevel: 'nominal', label: 'Document' },
  ];
  const projName = doc.documentElement.getAttribute('name') || String(name || '').replace(/\.[^.]+$/, '') || 'Imported coding';
  // Create the dataset WITHOUT activating, attach the coding blob, THEN switch to it —
  // so the blob is present before the workspace mounts (no race).
  const newId = await app.data.create({ name: projName, variables, columns: { name: names, source: content }, activate: false });
  // Codes ride inside `pendingImport`, NOT at the top level of the blob.
  //
  // #152 moved codes and segments out of the blob into item records, and `normalize()`
  // now hard-resets `codes: []` on load — so a top-level `codes` here was silently
  // dropped on the way in, leaving every imported coding pointing at a codeId that no
  // longer existed. `pendingImport` is the one key `normalize()` passes through intact,
  // which is exactly what this needs: the mount turns it into real item records once it
  // is bound to a dataset and can write them with the right scope.
  const blob = { version: 1, textColumn: 'source', labelColumn: 'name', pendingImport: { codes, codings } };
  await app.state.write('caqdas-coding', blob, newId);
  await app.data.setActive(newId);
  // Self-committing importer (manifest `selfCommit`): we created the dataset +
  // codings ourselves, so we deliver a receipt (not a dataset) — the host runs no
  // merge dialog and no commit, just reports success from this.
  return { name: projName, rows: names.length, codings: codings.length };
}

/** Store an imported media file, returning its asset ref. */
async function putImportedMedia(app, bytes, path, name) {
  const blob = new Blob([bytes], { type: mimeForPath(path) });
  const info = await app.assets.put(blob, { name, type: blob.type });
  return info && info.ref;
}

/** Decode an image's natural dimensions (needs the media-CSP frame). Never rejects. */
function decodeImageDims(bytes, type) {
  return new Promise((resolve) => {
    let url;
    try { url = URL.createObjectURL(new Blob([bytes], { type: type || 'image/png' })); } catch { resolve({ w: 0, h: 0 }); return; }
    const done = (o) => { URL.revokeObjectURL(url); resolve(o); };
    const t = setTimeout(() => done({ w: 0, h: 0 }), 10000);
    const img = new Image();
    img.onload = () => { clearTimeout(t); done({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(t); done({ w: 0, h: 0 }); };
    img.src = url;
  });
}

/** A MIME type from a Sources/ filename extension. */
function mimeForPath(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  };
  return map[ext] || 'application/octet-stream';
}

/** Parse a numeric attribute, defaulting to 0. */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// =====================================================================
// Media importers (#139) — formerly standalone plugins, now CAQDAS-owned
// so they only appear in File ▸ Import when CAQDAS is activated.
// =====================================================================

export async function parseTextFile(_app, { name, file }) {
  const text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
  const document = String(name).replace(/\.[^.]+$/, '') || String(name);
  return {
    variables: [
      { name: 'document', type: 'string', measurementLevel: 'nominal', label: 'Source file' },
      { name: 'text', type: 'string', measurementLevel: 'nominal', label: 'Document text' },
    ],
    columns: { document: [document], text: [text] },
  };
}

export async function parseImageFile(app, { name, file }) {
  const dims = await probeMedia(file, 'image');
  const { ref } = await app.assets.put(file, { type: file.type || '', name, medium: 'image', ...dims });
  return importMediaRow({ name, ref, medium: 'image', size: file.size, dims });
}

export async function parseAudioFile(app, { name, file }) {
  const dims = await probeMedia(file, 'audio');
  const { ref } = await app.assets.put(file, { type: file.type || '', name, medium: 'audio', ...dims });
  return importMediaRow({ name, ref, medium: 'audio', size: file.size, dims });
}

export async function parseVideoFile(app, { name, file }) {
  const dims = await probeMedia(file, 'video');
  const { ref } = await app.assets.put(file, { type: file.type || '', name, medium: 'video', ...dims });
  return importMediaRow({ name, ref, medium: 'video', size: file.size, dims });
}

function probeMedia(file, medium) {
  return new Promise((resolve) => {
    let url;
    try { url = URL.createObjectURL(file); } catch { resolve({}); return; }
    let settled = false;
    const done = (out) => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(out); };
    const timer = setTimeout(() => done({}), 15000);
    if (medium === 'image') {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onerror = () => done({});
      img.src = url;
    } else {
      const el = document.createElement(medium === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      if (medium === 'video') el.muted = true;
      el.onloadedmetadata = () => {
        const out = {};
        if (Number.isFinite(el.duration) && el.duration > 0) out.duration = Math.round(el.duration * 1000) / 1000;
        if (el.videoWidth) out.width = el.videoWidth;
        if (el.videoHeight) out.height = el.videoHeight;
        done(out);
      };
      el.onerror = () => done({});
      el.src = url;
    }
  });
}

function importMediaRow({ name, ref, medium, size, dims }) {
  const variables = [
    { name: 'name', type: 'string', measurementLevel: 'nominal', label: 'File name' },
    { name: 'media', type: 'string', measurementLevel: 'nominal', label: 'Media' },
    { name: 'type', type: 'string', measurementLevel: 'nominal', label: 'Kind' },
    { name: 'size', type: 'numeric', measurementLevel: 'scale', label: 'Size (bytes)' },
  ];
  const columns = { name: [name], media: [JSON.stringify([ref])], type: [medium], size: [size] };
  if (dims.duration != null) {
    variables.push({ name: 'duration', type: 'numeric', measurementLevel: 'scale', label: 'Duration (s)' });
    columns.duration = [dims.duration];
  }
  if (dims.width != null) {
    variables.push({ name: 'width', type: 'numeric', measurementLevel: 'scale', label: 'Width (px)' });
    columns.width = [dims.width];
  }
  if (dims.height != null) {
    variables.push({ name: 'height', type: 'numeric', measurementLevel: 'scale', label: 'Height (px)' });
    columns.height = [dims.height];
  }
  return { variables, columns, source: name };
}
