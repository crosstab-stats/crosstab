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

/**
 * The host's general stdlib, read from the sandbox global at module scope — the pure
 * exported helpers below cannot reach `app`, which only exists inside an invoked
 * function. `coderName` in particular is shared with `builtin-agreement`, which names
 * the same coders from the same stamps and must not disagree about what one is called.
 */
const { cleanName, uniqueName, coderName } = globalThis.ctStd;

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
    'GUI: appears as TWO workspace tabs. Coding — pick a dataset column of documents (a text column, or a media column from an image/audio/video import), then tag passages/regions with codes and export code frequencies/segments to Output. Transcripts — transcribe the audio/video in the dataset on this device, optionally just one stretch of it, and keep the transcript beside the recording.\n' +
    'Used through its workspace tabs, not a run command.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'caqdas-coding',
      title: 'Qualitative coding (CAQDAS)',
      category: 'Qualitative',
      keywords: ['caqdas', 'qualitative', 'coding', 'codes', 'passages', 'transcripts', 'nvivo', 'atlas', 'workspace', 'segments', 'media'],
      needs: ['builtin-caqdas'],
      seeAlso: ['agreement-codings', 'import-data', 'caqdas-transcribe'],
    },
    {
      id: 'caqdas-transcribe',
      title: 'Transcribe interviews on this device',
      category: 'Qualitative',
      keywords: ['transcribe', 'transcription', 'whisper', 'speech to text', 'audio', 'video',
        'interview', 'oral history', 'language', 'detect', 'speakers', 'diarization', 'clip',
        'range', 'otter', 'rev', 'trint'],
      needs: ['builtin-caqdas'],
      seeAlso: ['caqdas-coding', 'import-data'],
    },
  ],
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
      // Above the media entries, because a transcript import can ATTACH its recording —
      // so this is the one to reach for when you have both, and importing the audio
      // first would leave you with two rows to reconcile by hand.
      label: 'Transcripts (VTT, SRT, timestamped text) → one row per file…',
      extensions: ['.vtt', '.srt', '.sbv', '.txt', '.text'],
      group: 'Qualitative',
      order: 16,
      multiple: true,
      parse: 'parseTranscriptFile',
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
    { id: 'codebooks', label: 'Codebooks', labelField: 'name', sidebar: 'list', scope: 'project', portable: true },
    // A code is COMPOSED INTO its codebook (#166): it travels with the book into the
    // library and dies with it, which is what makes a codebook the dictionary it claims
    // to be rather than a label with a foreign key pointed at it.
    {
      id: 'codes',
      label: 'Codes',
      labelField: 'name',
      sidebar: 'count',
      scope: 'project',
      parent: { collection: 'codebooks', field: 'codebookId' },
    },
    // `doc` holds a __ct_rid, so a dataset re-home can carry codings across (#151).
    // Declared, not inferred — the host cannot tell a row id from any other string.
    //
    // `anchor` holds the region this coding refers to; declaring it is what lets the host
    // derive the op's `reads[]`, report drift, and re-target on a re-home without ever
    // reading our schema.
    //
    // Deliberately NOT `parent: codes`. A coding DEPENDS ON a code (it dies with it) but
    // is not part of it, and the difference is not pedantry: a codebook promoted to the
    // library must never carry codings, because codings are passages of real participant
    // data and a shared codebook is meant to be handed to other people.
    //
    // `onConcurrentEdit: 'surface'` because two coders disagreeing about a boundary is
    // exactly the case where letting HLC pick a winner silently destroys the other's
    // judgement — the thing per-coder records exist to prevent.
    {
      id: 'segments',
      label: 'Codings',
      labelField: 'quote',
      sidebar: 'count',
      rowRefs: ['doc'],
      anchorRefs: ['anchor'],
      onConcurrentEdit: 'surface',
    },
  ],
  workspaces: [{
    // A SECOND tab (#139). Transcription churns here while finished transcripts are read
    // and checked in Coding beside it — a modal would block exactly that. Project-scoped
    // rather than dataset-scoped would be wrong: the media it works on belongs to a
    // dataset, and so does the transcript it produces.
    id: 'caqdas-transcripts',
    title: 'Transcripts',
  }, {
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
      // A real file pair for the codebook alone, alongside the whole-project QDPX, and
      // BOTH in the File menus — an asymmetry here is just confusing (the owner spotted
      // it immediately: "odd that export lives under File ▸ Export but import is a
      // button in the workspace"). The compute frame can write item records
      // (core/loader.js:523 exposes put and remove, not only list), so the import verb
      // has no reason to live anywhere else.
      { id: 'export-codebook-csv', label: 'Codebook (.csv)…', run: 'exportCodebookCsv', category: 'export', group: 'Qualitative' },
      { id: 'import-codebook-csv', label: 'Codebook (.csv)…', run: 'importCodebookCsv', category: 'import', needsFile: { extensions: ['.csv', '.txt', '.tsv'] }, group: 'Qualitative' },
    ],
  }],
};

/** Distinct, readable highlight colours (assigned round-robin to new codes). */
const PALETTE = ['#ffd166', '#8ecae6', '#a7c957', '#ffadad', '#bdb2ff', '#ffc6ff', '#caffbf', '#fdffb6', '#9bf6ff', '#ffd6a5'];
const uid = (pfx = 'c') => pfx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MAX_DOCS = 10000; // v1 cap; virtualise for larger corpora later.

const STYLES = `
:host, body { margin: 0; }
/* THE HEIGHT CHAIN. Every column below already declares "overflow: auto", and none of it
   did anything: ".caqdas" asks for "height: 100%", which resolves against a body of AUTO
   height, so the container simply grew with the transcript and the whole iframe scrolled
   as one piece. Scrolling a long transcript therefore scrolled the codebook away with it
   — reported while coding a 21-minute interview, where picking the next code meant
   scrolling back up through the text you were reading.
   Giving html and body a real height is what makes the three panes separate scrollers,
   because a flex child can only overflow inside a parent whose height is known. */
html, body { height: 100%; }
/* EXCEPT in small-screen mode, which is a deliberately different layout: the rails stop
   being rails and stack into one column bounded by vh, and that wants the document to
   scroll as a whole. Pinning it to the viewport there would nest three scrollers inside
   a screen the size of one of them. */
html[data-screen="small"], html[data-screen="small"] body { height: auto; }
.caqdas { display: flex; flex-direction: column; height: 100%; min-height: 460px; font: 14px system-ui, sans-serif; color: var(--ct-text); }
/* Drift reporting (#166): a coding whose anchor no longer lands cleanly. Amber, not
   red — nothing is broken and nothing was lost, but the user has to know before they
   trust the highlight. */
.caqdas__drift { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 0 0 10px;
  background: #fff4e0; border: 1px solid #e2b877; border-radius: 6px; font-size: 13px; color: #6b4a12; }
.caqdas__driftmsg { flex: 1; }
.caqdas__drifthead { font-weight: 600; }
.caqdas__drifthint { margin-top: 3px; font-size: 12px; }
.caqdas__driftrow { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 13px;
  border-bottom: 1px solid #eee; }
.caqdas__driftrow .nm { font-weight: 600; }
.caqdas__driftrow .q { flex: 1; color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__driftrow .why { color: #8a6d3b; font-size: 12px; }
/* --- transcript pane (time-aligned text) ----------------------------------- */
.caqdas__tplayer { padding: 6px 8px; border-bottom: 1px solid var(--ct-border, #d8dee4); background: var(--ct-surface-2, #f6f8fa); }
.caqdas__taudio { width: 100%; }
.caqdas__tvideo { width: 100%; max-height: 40vh; background: #000; }
.caqdas__tloading { font-size: 12px; color: #646e77; padding: 4px 2px; }
/* A grid, so every line's words start at the same place however long the clock is —
   ragged text is harder to read than a wider gutter. */
.caqdas__transcript--timed { display: grid; grid-template-columns: max-content 1fr; gap: 0 10px; align-items: start; }
.caqdas__cue { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; }
.caqdas__cuetime {
  font: 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #646e77; background: none; border: 0; padding: 0 2px; text-align: right;
  cursor: pointer; border-radius: 3px;
  /* Tabular figures so the column does not jitter between 9:59 and 10:00. */
  font-variant-numeric: tabular-nums;
  /* Not selectable, which is about the USER'S selection rather than about offsets.
     A Range is a pair of document positions, not a filtered walk, so without this a
     drag across two lines highlights the clock between them and a quote copied out of
     the pane carries "0:04" in the middle of the sentence. (Offsets are a separate
     problem with a separate guard — see NONTEXT.) */
  -webkit-user-select: none;
  user-select: none;
}
.caqdas__cuetime:hover { background: var(--ct-accent-soft, #dbeafe); color: var(--ct-text, #24292f); }
.caqdas__cuetext { white-space: pre-wrap; }
/* The line being spoken. A left bar rather than a background, because a background
   would compete with the coding highlights — which are the colours that carry meaning. */
.caqdas__cue.is-now .caqdas__cuetext { box-shadow: inset 2px 0 0 var(--ct-accent, #2563eb); padding-left: 6px; margin-left: -8px; }
.caqdas__cue.is-now .caqdas__cuetime { color: var(--ct-accent, #2563eb); font-weight: 600; }
.caqdas__segtools { display: flex; align-items: center; gap: 6px; padding: 6px 0; }
.caqdas__segwarn { padding: 4px 0; font-size: 12px; color: #8a6d3b; }
.caqdas__bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--ct-line-soft); flex-wrap: wrap; }
.caqdas__bar label { color: #555; }
.caqdas__bar select, .caqdas__btn { font: inherit; padding: 5px 9px; border: 1px solid var(--ct-line); border-radius: 6px; background: var(--ct-surface); }
.caqdas__btn { cursor: pointer; background: #f3f6fa; }
.caqdas__btn:hover { background: #e9eff6; }
.caqdas__btn--primary { background: var(--ct-accent); color: #fff; border-color: var(--ct-accent); }
.caqdas__paint { display: none; align-items: center; gap: 10px; padding: 6px 12px; background: var(--ct-accent); color: #fff; font-size: 13px; }
.caqdas__paint.is-on { display: flex; }
.caqdas__paint .stop { margin-left: auto; cursor: pointer; border: 1px solid rgba(255,255,255,.6); background: transparent; color: #fff; font: inherit; border-radius: 6px; padding: 2px 8px; }
.caqdas__body { display: flex; flex: 1; min-height: 0; }
.caqdas__docs { width: 230px; border-right: 1px solid var(--ct-line-soft); overflow: auto; flex: none; }
.caqdas__doc { padding: 8px 12px; border-bottom: 1px solid #f0f2f4; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.caqdas__doc:hover { background: #f5f8fb; }
.caqdas__doc.is-active { background: #e6f0fa; font-weight: 500; }
.caqdas__doc .n { color: var(--ct-muted); font-size: 12px; margin-right: 6px; }
.caqdas__doc .c { color: var(--ct-accent); font-size: 11px; float: right; }
.caqdas__text { flex: 1; overflow: auto; padding: 16px 20px; white-space: pre-wrap; line-height: 1.7; min-width: 0; }
.caqdas__text mark { border-radius: 2px; padding: 0 1px; cursor: pointer; }
.caqdas__empty { color: var(--ct-muted); font-style: italic; padding: 24px; }
.caqdas__codes { width: 240px; border-left: 1px solid var(--ct-line-soft); overflow: auto; flex: none; padding: 8px; }
.caqdas__codes h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--ct-muted); margin: 6px 6px 4px; }
.caqdas__hint { font-size: 12px; color: var(--ct-muted); margin: 0 6px 10px; line-height: 1.4; transition: color .15s; }
.caqdas__code { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.caqdas__code:hover { background: #f5f8fb; }
.caqdas__code.is-armed { outline: 2px solid var(--ct-accent); outline-offset: -2px; background: #eef5fb; }
.caqdas__code .pb { cursor: pointer; border: 0; background: none; font: inherit; padding: 0 4px; opacity: .45; }
.caqdas__code:hover .pb { opacity: .8; }
.caqdas__code .pb.is-on { opacity: 1; }
.caqdas__sw { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.caqdas__code .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__code .ct { color: var(--ct-muted); font-size: 12px; }
.caqdas__code .x { cursor: pointer; color: var(--ct-danger); border: 0; background: none; font: inherit; padding: 0 4px; }
.caqdas__newcode { display: flex; gap: 6px; padding: 8px 6px; }
.caqdas__newcode input { flex: 1; min-width: 0; font: inherit; padding: 5px 8px; border: 1px solid var(--ct-line); border-radius: 6px; }
.caqdas__menu { position: absolute; z-index: 20; background: var(--ct-surface); border: 1px solid var(--ct-line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 6px; min-width: 270px; max-width: 340px; max-height: 340px; overflow: auto; }
.caqdas__menu button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none; font: inherit; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.caqdas__menu button:hover { background: #eef5fb; }
.caqdas__menu .row { display: flex; gap: 6px; padding: 6px 4px 2px; border-top: 1px solid #eef0f2; margin-top: 4px; }
.caqdas__menu .row input { flex: 1; min-width: 0; font: inherit; padding: 5px 8px; border: 1px solid var(--ct-line); border-radius: 6px; }
/* --- codebook manager: a real modal overlay, this plugin's first ------------------
   Everything else here is a positioned div dismissed by a document click, which is fine
   for a six-item menu and hopeless for a panel with a multi-select list, a paste area
   and a copy-to target. Backdrop + Escape + focus trap, drawn inside the workspace
   iframe (a plugin cannot reach the host's <dialog>, and allow-scripts denies it
   window.prompt/alert/confirm — see the file header). */
.caqdas__scrim { position: fixed; inset: 0; z-index: 40; background: rgba(20,26,32,.42); display: flex; align-items: center; justify-content: center; padding: 24px; }
.caqdas__mgr { background: var(--ct-surface); border-radius: 10px; box-shadow: 0 18px 48px rgba(0,0,0,.28); width: min(880px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.caqdas__mgrhead { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--ct-line-soft); }
.caqdas__mgrtitle { font-weight: 700; font-size: 15px; margin-right: auto; }
.caqdas__mgrbody { display: flex; min-height: 0; flex: 1; }
.caqdas__mgrside { width: 210px; border-right: 1px solid var(--ct-line-soft); padding: 10px; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
.caqdas__mgrmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.caqdas__mgrbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #eef0f2; }
.caqdas__mgrlist { flex: 1; overflow: auto; padding: 4px 0; min-height: 220px; }
.caqdas__mgrfoot { padding: 10px 14px; border-top: 1px solid var(--ct-line-soft); display: flex; gap: 8px; align-items: center; }
.caqdas__bookbtn { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 1px solid transparent; background: none; font: inherit; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.caqdas__bookbtn:hover { background: #f2f5f8; }
.caqdas__bookbtn.is-active { background: #eef5fb; border-color: #b7d4ea; font-weight: 600; }
.caqdas__bookn { margin-left: auto; color: var(--ct-muted); font-size: 11px; font-weight: 400; }
.caqdas__mgrrow { display: flex; align-items: center; gap: 8px; padding: 5px 12px; }
.caqdas__mgrrow:hover { background: #f7f9fb; }
.caqdas__mgrrow input[type=text] { font: inherit; padding: 4px 7px; border: 1px solid var(--ct-line); border-radius: 6px; min-width: 0; }
.caqdas__mgrname { flex: 2 1 0; }
.caqdas__mgrtheme { flex: 1 1 0; }
.caqdas__mgrcount { width: 46px; text-align: right; color: var(--ct-muted); font-size: 11px; }
.caqdas__mgrempty { padding: 28px 14px; text-align: center; color: #7b848c; font-size: 13px; }
.caqdas__paste { width: 100%; box-sizing: border-box; font: 12px/1.45 ui-monospace, Menlo, monospace; padding: 8px; border: 1px solid var(--ct-line); border-radius: 6px; resize: vertical; min-height: 120px; }
.caqdas__mgrnote { font-size: 12px; color: var(--ct-muted); margin: 0 0 8px; line-height: 1.45; }
.caqdas__sel { color: var(--ct-muted); font-size: 12px; margin-right: auto; }
.caqdas__group { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ct-muted); font-weight: 600; margin: 16px 6px 2px; }
.caqdas__group--none { font-weight: 500; font-style: italic; text-transform: none; letter-spacing: 0; color: #b3bac1; }
.caqdas__code .caqdas__iconbtn { cursor: pointer; border: 0; background: none; font: inherit; padding: 0 3px; opacity: .4; }
.caqdas__code:hover .caqdas__iconbtn { opacity: .8; }
.caqdas__code .caqdas__iconbtn.has { opacity: .95; }
.caqdas__details { display: flex; flex-direction: column; gap: 6px; margin: 0 6px 8px; }
.caqdas__details .caqdas__grpinp { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--ct-line); border-radius: 6px; }
.caqdas__details .caqdas__memo { font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid var(--ct-line); border-radius: 6px; resize: vertical; }
.caqdas__retrhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.caqdas__retrhead h3 { margin: 0; }
.caqdas__retr { border: 1px solid var(--ct-line-soft); border-radius: 6px; padding: 8px 10px; margin: 8px 0; cursor: pointer; }
.caqdas__retr:hover { background: #f5f8fb; }
.caqdas__retr .rl { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ct-muted); margin-bottom: 3px; }
.caqdas__retr .rl > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__retr .rl .caqdas__segrm { flex: 0 0 auto; font-size: 13px; line-height: 1; }
mark.has-memo { box-shadow: inset 0 -2px 0 rgba(0,0,0,.35); }
.caqdas__seghead { display: flex; align-items: center; gap: 8px; padding: 4px 4px 2px; }
.caqdas__seghead .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__segrm { border: 0; background: none; font: inherit; color: var(--ct-danger); cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.caqdas__segrm:hover { background: #fbeaea; }
.caqdas__segmemo { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid var(--ct-line); border-radius: 6px; resize: vertical; margin: 0 0 6px; }
/* memo/annotation thread (#148) */
.caqdas__thread { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; min-width: 0; }
.caqdas__notes { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; overflow-x: hidden; }
.caqdas__notesempty { font-size: 12px; color: var(--ct-muted); font-style: italic; }
.caqdas__note { background: #f6f8fa; border: 1px solid #e3e8ee; border-radius: 6px; padding: 5px 7px; min-width: 0; }
.caqdas__note--legacy { background: #fbfaf3; }
.caqdas__noterow { display: flex; align-items: center; gap: 6px; margin: 0 0 3px; min-width: 0; }
.caqdas__notechip { flex: none; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.caqdas__notewho { font-size: 11px; font-weight: 600; color: #41505e; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caqdas__notemeta { font-size: 10.5px; color: var(--ct-muted); font-style: italic; margin: 0 0 2px; }
.caqdas__notedel { flex: none; border: 0; background: none; color: var(--ct-danger); cursor: pointer; font-size: 11px; padding: 0 2px; }
.caqdas__notebody { font-size: 12px; color: #2c3742; white-space: pre-wrap; word-break: break-word; }
.caqdas__noteadd { display: flex; flex-direction: column; gap: 4px; }
.caqdas__noteinput { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid var(--ct-line); border-radius: 6px; resize: vertical; }
.caqdas__noteadd .caqdas__btn { align-self: flex-end; font-size: 12px; padding: 3px 10px; }
/* --- media (image) coding --- */
.caqdas__imgwrap { position: relative; display: inline-block; max-width: 100%; margin: 0 auto; line-height: 0; }
.caqdas__img { display: block; max-width: 100%; max-height: calc(100vh - 220px); user-select: none; -webkit-user-select: none; }
.caqdas__overlay { position: absolute; inset: 0; cursor: crosshair; }
.caqdas__region { position: absolute; border: 2px solid; box-sizing: border-box; pointer-events: none; }
.caqdas__region .caqdas__rlabel { position: absolute; top: -18px; left: -2px; font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 3px 3px 0 0; color: #fff; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.caqdas__region.has-memo { box-shadow: 0 0 0 2px rgba(0,0,0,.35) inset; }
.caqdas__regionsel { position: absolute; border: 2px dashed var(--ct-accent); background: rgba(47,111,176,.12); box-sizing: border-box; pointer-events: none; }
.caqdas__mediahint { font-size: 12px; color: var(--ct-muted); padding: 8px 20px 0; }
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
.caqdas__handle { position: absolute; width: 11px; height: 11px; background: var(--ct-surface); border: 1px solid var(--ct-accent); box-sizing: border-box; border-radius: 2px; }
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
/* PINNED. Reviewing a transcript means scrolling a long way down it, and the thing you
   need constantly — play, pause, the position you are at — was the first thing to leave
   the screen. Sticky rather than a fixed header outside the scroller: the text still
   starts directly under it, and nothing has to be told the header's height.
   An opaque background is not decoration — without it the transcript scrolls visibly
   THROUGH the controls. */
.caqdas__nowplaying { position: sticky; top: 0; z-index: 3; background: var(--ct-surface);
  border-bottom: 1px solid var(--ct-line-soft); padding-bottom: 8px; margin: -16px -20px 0;
  padding-left: 20px; padding-right: 20px; padding-top: 8px; }
/* In small-screen mode the pane is not its own scroller (see the height chain above), so
   there is nothing for sticky to stick to and it would just occupy space. */
[data-screen="small"] .caqdas__nowplaying { position: static; margin: 0; padding-left: 0; padding-right: 0; }
.caqdas__speedlabel { font-size: 12px; color: var(--ct-muted); margin-right: 2px; }
.caqdas__speedbtn { font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid var(--ct-line); border-radius: 6px; background: var(--ct-surface); cursor: pointer; }
.caqdas__speedbtn.is-on { background: var(--ct-accent); color: #fff; border-color: var(--ct-accent); }
.caqdas__transport { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 20px; background: #eef2f6; border-top: 1px solid var(--ct-line-soft); border-bottom: 1px solid var(--ct-line-soft); }
.caqdas__ctlbtn { font: inherit; font-size: 12px; padding: 3px 9px; border: 1px solid var(--ct-line); border-radius: 6px; background: var(--ct-surface); cursor: pointer; }
.caqdas__ctlbtn.is-on { background: var(--ct-accent); color: #fff; border-color: var(--ct-accent); }
.caqdas__playbtn { min-width: 40px; font-size: 12px; }
.caqdas__regionbtn { margin-left: auto; }
.caqdas__timeline { padding: 6px 20px 16px; }
.caqdas__tltrack { position: relative; height: 22px; background: #eef1f4; border: 1px solid var(--ct-line-soft); border-radius: 4px; cursor: crosshair; overflow: hidden; touch-action: none; }
.caqdas__tlsel { position: absolute; top: 0; bottom: 0; background: rgba(47,111,176,.18); border-left: 2px solid var(--ct-accent); border-right: 2px solid var(--ct-accent); box-sizing: border-box; pointer-events: none; }
.caqdas__playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ct-danger); pointer-events: none; }
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
.caqdas__lanesempty { font-size: 12px; color: var(--ct-muted); font-style: italic; padding: 4px 0; }

/* ===========================================================================
   SMALL-SCREEN MODE

   The host posts its layout decision and the frame mirrors it onto this document's root,
   so these rules key off the same [data-screen="small"] selector the host's own
   stylesheet uses. Deliberately NOT a media query: the mode is a user's CHOICE, and a
   pane measuring its own iframe width would override someone who picked the full layout
   on a narrow screen.

   What was wrong (owner's iPhone, 2026-10-10 - 'caqdas on the phone is unusable'): the
   body is a flex ROW holding a 230px document list, a flexible text column and a 240px
   codebook. 470px of fixed rails at a 390px viewport left the text column nothing, so it
   squeezed to roughly one character per line while the codebook ran off the edge.
   =========================================================================== */
[data-screen="small"] .caqdas { min-height: 0; }
[data-screen="small"] .caqdas__body { flex-direction: column; }
/* The rails stop being rails: full width, bounded in HEIGHT instead, so the three panes
   share the screen rather than one of them owning all of it. */
[data-screen="small"] .caqdas__docs,
[data-screen="small"] .caqdas__codes {
  width: auto; flex: none; max-height: 34vh;
  border-left: 0; border-right: 0; border-bottom: 1px solid var(--ct-line-soft);
}
/* The text is why the pane exists, so it takes what is left and never collapses below
   something readable. */
[data-screen="small"] .caqdas__text { flex: 1 1 auto; min-height: 40vh; padding: 12px 14px; }
/* 16px stops iOS zooming the viewport when a control takes focus; 44px is the touch
   target. The same two rules the host applies to itself in small-screen mode. */
[data-screen="small"] .caqdas__bar select,
[data-screen="small"] .caqdas__btn,
[data-screen="small"] .caqdas__newcode input { font-size: 16px; min-height: 44px; }
[data-screen="small"] .caqdas__doc { padding: 12px; }
[data-screen="small"] .caqdas__lanelabel { flex-basis: 84px; }
`;

export const workspace = {
  /**
   * One module, two tabs. The host passes `{id, title}` as the third argument, which is
   * how a plugin declaring several workspaces knows which one is being mounted.
   * @param {{id?: string}} [info]
   */
  async mount(app, root, info = {}) {
    if (info.id === 'caqdas-transcripts') return mountTranscripts(app, root);
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
    // The dataset the documents came from. Part of a coding's anchor target, so it is
    // captured whenever documents load rather than assumed.
    let dsId = null;
    // What the last resolution pass found — codings whose anchor no longer lands cleanly.
    // Shown, never silently fixed (#166 R1).
    let driftReport = { drifted: 0, orphaned: 0 };
    let reviewDoc = null; // the document whose drift list is expanded (session-only)
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
    // Transcript pane: the cue rows on screen, the cues they were drawn from, and which
    // row is currently lit. Held rather than re-derived because `timeupdate` fires several
    // times a second and must not walk the DOM to find out whether anything changed.
    let cueRows = [];
    let currentCues = null;
    let activeCueRow = -1;
    let transcriptUrl = null; // the blob: URL behind a transcript's own player
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
    // The host's base sheet first (tokens + the shared small-screen conventions), then
    // this plugin's own on top. `app.std` arrives with the plugin source; a build that
    // failed to serve it just means no base sheet, and the rules below still stand.
    app.std?.injectStdlibStyles?.(document);
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
    // (tag, cls, text). The text is set as textContent, never innerHTML: what flows
    // through here includes code names and quoted participant passages.
    // The host's element helper (app.std.el), which takes an OPTIONS OBJECT rather than
    // positional arguments. That is the whole reason it is shared: the four positional
    // copies across this app took the same three arguments in two different orders, so a
    // line copied between files silently swapped an element's class with its text — both
    // render, one is nonsense, and nothing errors.
    //
    // The fallback is not decoration: a build that failed to serve the stdlib must not take
    // the coding workspace down with it. Text is set with textContent, never innerHTML —
    // what flows through here includes code names and quoted participant passages.
    const el = app.std?.el ?? ((tag, opts = {}) => {
      const e = document.createElement(tag);
      if (opts.class) e.className = opts.class;
      if (opts.text != null) e.textContent = String(opts.text);
      return e;
    });

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
      const wrap = el('div', { class: 'caqdas__thread' });
      const list = el('div', { class: 'caqdas__notes' });
      const rebuild = () => {
        list.replaceChildren();
        const legacy = typeof anchorObj.memo === 'string' && anchorObj.memo.trim();
        if (legacy) {
          const n = el('div', { class: 'caqdas__note caqdas__note--legacy' });
          const meta = el('div', { class: 'caqdas__notemeta' }); meta.textContent = 'earlier note';
          const body = el('div', { class: 'caqdas__notebody' }); body.textContent = anchorObj.memo;
          n.append(meta, body); list.append(n);
        }
        for (const note of memosFor(anchorId)) {
          const a = note.author || {};
          const n = el('div', { class: 'caqdas__note' });
          const row = el('div', { class: 'caqdas__noterow' });
          const chip = el('span', { class: 'caqdas__notechip' }); chip.textContent = a.initials || '·';
          chip.style.background = a.color || '#8a94a0'; chip.title = a.name || a.initials || 'Unknown';
          const who = el('span', { class: 'caqdas__notewho' }); who.textContent = a.name || a.initials || 'Unknown';
          row.append(chip, who);
          if (me && a.authorId === me.authorId) {
            const del = el('button', { class: 'caqdas__notedel' }); del.textContent = '✕'; del.title = 'Delete your note';
            del.addEventListener('click', (e) => { e.stopPropagation(); deleteMemo(note.id); rebuild(); onChange?.(); });
            row.append(del);
          }
          const body = el('div', { class: 'caqdas__notebody' }); body.textContent = note.text;
          n.append(row, body); list.append(n);
        }
        if (!list.children.length) { const e0 = el('div', { class: 'caqdas__notesempty' }); e0.textContent = 'No notes yet.'; list.append(e0); }
      };
      rebuild();
      const addRow = el('div', { class: 'caqdas__noteadd' });
      const ta = el('textarea', { class: 'caqdas__noteinput' }); ta.rows = 2; ta.placeholder = 'Add a note…';
      ta.addEventListener('click', (e) => e.stopPropagation());
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } });
      const btn = el('button', { class: 'caqdas__btn' }); btn.textContent = 'Add note';
      const post = () => { if (!ta.value.trim()) return; addMemo(anchorKind, anchorId, ta.value); ta.value = ''; rebuild(); onChange?.(); };
      btn.addEventListener('click', (e) => { e.stopPropagation(); post(); });
      addRow.append(ta, btn);
      wrap.append(list, addRow);
      return wrap;
    }
    const wrap = el('div', { class: 'caqdas' });

    const bar = el('div', { class: 'caqdas__bar' });
    const colLabel = el('label'); colLabel.textContent = 'Documents column:';
    const colSel = el('select');
    const labelLabel = el('label'); labelLabel.textContent = 'Label by:';
    const labelSel = el('select');
    labelSel.title = 'Column that identifies each document (e.g. a filename or participant id) — used in the document list and the segments export.';
    const freqBtn = el('button', { class: 'caqdas__btn' }); freqBtn.textContent = 'Code frequency';
    const expBtn = el('button', { class: 'caqdas__btn' }); expBtn.textContent = 'Segments → Output';
    const cloudBtn = el('button', { class: 'caqdas__btn' }); cloudBtn.textContent = 'Word cloud';
    cloudBtn.title = 'Word cloud of the coded passages — grouped and coloured by your codebook themes.';
    const quantBtn = el('button', { class: 'caqdas__btn' }); quantBtn.textContent = 'Quantitise…';
    quantBtn.title = 'Turn the codings into a dataset — one row per document, one column per code — so the statistics menu can analyse them (crosstabs, logistic regression, latent class…).';
    bar.append(colLabel, colSel, labelLabel, labelSel, freqBtn, expBtn, cloudBtn, quantBtn);

    // Paint-mode banner (shown while a code is armed).
    const paintBanner = el('div', { class: 'caqdas__paint' });
    const paintMsg = el('span');
    const stopBtn = el('button', { class: 'stop' }); stopBtn.textContent = 'Stop (Esc)';
    paintBanner.append(paintMsg, stopBtn);

    const body = el('div', { class: 'caqdas__body' });
    const docList = el('div', { class: 'caqdas__docs' });
    const textPane = el('div', { class: 'caqdas__text' });
    // The transcript, INSIDE the pane. Character offsets are derived by WALKING TEXT
    // NODES, so they are the document's offsets only while the walked container holds
    // nothing but the document — and the drift banner shares this pane. Null whenever the
    // pane is showing something that is not a transcript (retrieve list, media, empty).
    let transcript = null;
    const codePane = el('div', { class: 'caqdas__codes' });
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

    /**
     * Which column holds transcript timing, or null.
     *
     * One row, every column — the cheap probe. A dataset of transcripts has a handful of
     * columns, and a wide survey being coded has hundreds that are certainly not timing;
     * reading one row of each is bounded either way, and the alternative (fetch
     * everything, then look) is not.
     *
     * First match wins, and the text column is skipped: a media document's own cell is a
     * JSON array, and nothing stops someone putting a timing object where the text
     * should be — in which case there would be no transcript to code.
     */
    async function findTimingColumn() {
      try {
        const meta = await app.data.getVariableMeta();
        const names = meta.filter((m) => m.type !== 'numeric' && m.name !== state.textColumn)
          .map((m) => m.name);
        if (!names.length) return null;
        const [first] = await app.data.getRows({ variables: names, limit: 1 });
        if (!first) return null;
        return names.find((n) => parseTiming(first[n])) ?? null;
      } catch {
        // A probe that fails must not stop the workspace mounting — the cost is a
        // transcript that renders as plain text, which is exactly the documented
        // degradation.
        return null;
      }
    }

    async function loadDocs() {
      docs = [];
      activeRid = null;
      try { dsId = await app.selection.dataset(); } catch { dsId = null; }
      if (!state.textColumn) return;
      const vars = [state.textColumn];
      if (state.labelColumn && state.labelColumn !== state.textColumn) vars.push(state.labelColumn);
      // A transcript's timing lives in a sibling column, found by the SHAPE of its value
      // rather than by its name — a name breaks the moment someone renames the column or
      // joins two datasets, and media documents are already detected the same way. Probe
      // one row to find which column it is, so a 900-column survey is not fetched whole
      // just in case one of them is a transcript.
      const timingCol = await findTimingColumn();
      if (timingCol && !vars.includes(timingCol)) vars.push(timingCol);
      const rows = await app.data.getRows({ variables: vars, includeRowId: true, limit: MAX_DOCS });
      docs = rows.map((r) => {
        const raw = String(r[state.textColumn] ?? '');
        const label = state.labelColumn && r[state.labelColumn] != null ? String(r[state.labelColumn]) : '';
        // A media column holds a JSON array of `asset:`/`data:` refs (list-shaped even
        // for a single clip). Anything else is a plain text document.
        const refs = parseMediaRefs(raw);
        if (refs) return { rid: String(r.__rid), kind: 'media', refs, label };
        // A TRANSCRIPT is a text document that also knows when each line was said. It
        // stays `kind: 'text'` on purpose: everything about coding it — the char-span
        // selector, the highlights, retrieve, memos, export — is the text path, and the
        // timing only adds a player and a gutter. Lose the timing column and it is an
        // ordinary text document again, which is the right way for this to degrade.
        const timing = timingCol ? parseTiming(r[timingCol]) : null;
        return {
          rid: String(r.__rid), kind: 'text', text: raw, label,
          ...(timing ? { timing, refs: timing.media } : {}),
        };
      });
      activeRid = docs.length ? docs[0].rid : null;
      await resolveAllDocs();
    }

    /**
     * Recompute every coding's span from its anchor, for every loaded document.
     *
     * This is the whole point of the anchor design arriving at the surface: positions are
     * not read from storage, they are re-derived from what each coding QUOTES against the
     * text as it stands now. Runs whenever documents (re)load — mount, dataset switch,
     * an import — so a cell edited since the coding was made is caught here rather than
     * drawn wrongly.
     *
     * It writes nothing back. `driftReport` is what the UI shows.
     */
    async function resolveAllDocs() {
      driftReport = { drifted: 0, orphaned: 0 };
      for (const doc of docs) {
        const segs = state.segments.filter((x) => x.doc === doc.rid);
        if (!segs.length) continue;
        const r = await resolveDocSegments(app, doc, segs);
        driftReport.drifted += r.drifted;
        driftReport.orphaned += r.orphaned;
      }
    }

    // --- rendering -----------------------------------------------------------
    function codeById(id) { return state.codes.find((c) => c.id === id); }
    function segsFor(rid) { return state.segments.filter((s) => s.doc === rid); }

    function renderDocList() {
      docList.textContent = '';
      if (!docs.length) {
        const e = el('div', { class: 'caqdas__empty' });
        e.textContent = state.textColumn ? 'No rows.' : 'Pick a column of documents (text or media) to begin.';
        docList.append(e);
        return;
      }
      docs.forEach((d, i) => {
        const row = el('div', { class: 'caqdas__doc' + (d.rid === activeRid ? ' is-active' : '') });
        const n = el('span', { class: 'n' }); n.textContent = d.label || '#' + (i + 1);
        const cnt = segsFor(d.rid).length;
        const c = el('span', { class: 'c' }); if (cnt) c.textContent = cnt + '▮';
        const preview = d.kind === 'media' ? '▸ media' : (d.text.slice(0, 40) || '(empty)');
        const t = document.createTextNode(' ' + preview);
        row.append(n, c, t);
        row.addEventListener('click', () => { activeRid = d.rid; lastSpan = null; renderDocList(); renderText(); });
        docList.append(row);
      });
    }

    /**
     * Say what the resolver found, at the top of the document it found it in.
     *
     * The failure this replaces was silent: edit a transcript and every coding after the
     * edit point covered different words, confidently, with nothing to indicate it. Even
     * with no repair offered at all, saying "3 codings no longer match their text" beats
     * a wrong highlight — a researcher's analysis rests on these.
     */
    function renderDriftBanner(doc) {
      const segs = segsFor(doc.rid).filter(isUnsure);
      if (!segs.length) return;
      const lost = segs.filter((x) => !isPlaced(x)).length;
      const moved = segs.length - lost;
      const bar = el('div', { class: 'caqdas__drift' });
      const bits = [];
      if (lost) bits.push(`${lost} coding${lost === 1 ? '' : 's'} no longer match${lost === 1 ? 'es' : ''} this document`);
      if (moved) bits.push(`${moved} approximate match${moved === 1 ? '' : 'es'}`);
      // A bare count says something is off without answering the only question the
      // researcher actually has, which is whether to trust the highlight in front of them.
      const msg = el('span', { class: 'caqdas__driftmsg' });
      msg.append(el('div', { class: 'caqdas__drifthead', text: `⚠ Coding drift — ${bits.join(' · ')}` }));
      msg.append(el('div', { class: 'caqdas__drifthint', text: lost && moved
        ? 'The text these codings quote has changed since they were made.'
        : lost
          ? 'Their quoted text is no longer in this document, so nothing is highlighted for them.'
          : 'The quoted text was edited, so each highlight is the closest match — check it still covers what you meant.' }));
      bar.append(msg);
      const show = el('button', { class: 'caqdas__btn' });
      show.textContent = lost ? 'Review' : 'Details';
      show.title = 'List the codings whose anchor no longer lands cleanly';
      show.addEventListener('click', () => { reviewDoc = reviewDoc === doc.rid ? null : doc.rid; renderText(); });
      bar.append(show);
      textPane.append(bar);
      if (reviewDoc !== doc.rid) return;
      for (const sg of segs) {
        const row = el('div', { class: 'caqdas__driftrow' });
        const code = codeById(sg.codeId);
        const sw = el('span', { class: 'caqdas__sw' }); sw.style.backgroundColor = code ? code.color : '#ccc';
        row.append(sw, el('span', { class: 'nm', text: code ? code.name : '(code)' }));
        row.append(el('span', { class: 'q', text: sg.quote || '' }));
        row.append(el('span', { class: 'why', text: sg.reason || sg.status }));
        // Re-anchoring is a USER action, which is the whole point: the resolver reports,
        // the human decides. Select the correct passage first, then press this.
        const fix = el('button', { class: 'caqdas__btn' });
        fix.textContent = 'Re-anchor to selection';
        fix.title = 'Select the correct passage in the transcript, then click this';
        fix.addEventListener('click', () => void reanchorToSelection(sg));
        row.append(fix);
        const rm = el('button', { class: 'caqdas__segrm' }); rm.textContent = '✕';
        rm.title = 'Remove this coding';
        rm.addEventListener('click', () => void removeCoding(sg));
        row.append(rm);
        textPane.append(row);
      }
    }

    function renderText() {
      textPane.textContent = '';
      transcript = null;
      // The old rows are about to be discarded; a stale reference would have `paintActiveCue`
      // lighting an element that is no longer on screen.
      cueRows = [];
      currentCues = null;
      activeCueRow = -1;
      releaseTranscriptMedia();
      if (retrieveCodeId) { renderRetrieve(); return; }
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) { const e = el('div', { class: 'caqdas__empty' }); e.textContent = 'Select a document.'; textPane.append(e); return; }
      if (doc.kind === 'media') { void renderMedia(doc); return; }
      renderDriftBanner(doc);
      // A transcript with a recording gets a player above the words. A transcript
      // WITHOUT one still renders its gutters: the times are information even when
      // nothing can be seeked, and a reader asking "when was this said" is answered.
      if (doc.timing?.media?.length) void attachTranscriptPlayer(doc);
      transcript = el('div', { class: 'caqdas__transcript' });
      textPane.append(transcript);
      // Only codings whose anchor still LANDS are drawn. An orphan has no position, and
      // painting it at its last known offsets is precisely the confident-but-wrong
      // highlight this design exists to remove; it is reported in the banner instead, and
      // stays fully intact — its code, its quote and its notes — until the user re-anchors
      // or removes it.
      const segs = segsFor(doc.rid).filter(isPlaced).slice().sort((a, b) => a.start - b.start || a.end - b.end);
      // A transcript splits at its cue edges too, so no run straddles two lines.
      const cues = doc.timing?.cues ?? null;
      const runs = textRuns(doc.text.length, segs, cues ? cueBounds(cues) : []);

      /** One run as a text node or a `<mark>`. */
      const runNode = (run) => {
        const slice = doc.text.slice(run.a, run.b);
        if (!run.covering.length) return document.createTextNode(slice);
        const m = el('mark');
        const code = codeById(run.covering[0].codeId);
        m.style.backgroundColor = code ? code.color : '#eee';
        if (run.covering.some((x) => hasNotes(x))) m.classList.add('has-memo');
        // On a transcript the tooltip also says WHEN — the thing a reader of a coded
        // passage asks next, and the reason the cue index is kept at all.
        const when = cues ? cueAtChar(cues, run.a) : null;
        m.title = run.covering
          .map((x) => codeById(x.codeId)?.name + (x.memo ? ` — ${x.memo}` : ''))
          .filter(Boolean)
          .join(', ') + (when ? ` · ${clockOf(when.tStart)}` : '');
        m.textContent = slice;
        // Click a highlight to open its segment popup (memo + remove per covering code).
        m.addEventListener('click', (e) => { e.stopPropagation(); openSegmentMenu(run.covering, e); });
        return m;
      };

      if (!cues) {
        for (const run of runs) transcript.append(runNode(run));
        return;
      }
      renderCueLines(doc, cues, runs, runNode);
    }

    /** Every cue edge, so a run never spans two lines of a transcript. */
    function cueBounds(cues) {
      const out = [];
      for (const c of cues) { out.push(c.start); out.push(c.end); }
      return out;
    }

    /**
     * A transcript as lines: a clickable time beside each, the words beside that.
     *
     * **Every character of the document appears exactly once, and nothing else does.**
     * Both halves of that are load-bearing, because character offsets are measured by
     * walking this DOM:
     *
     *  - The newline between two cues is REAL text at a real offset, so the line that
     *     just ended contains it — which is why a line runs to the NEXT cue's start
     *     rather than to its own end. An earlier draft appended a synthetic `\n` as well,
     *     and the run covering the real one was then picked up by the following line; the
     *     browser pass measured 83 characters in an 81-character document, which is a
     *     coded highlight a word out at the top of a transcript and a sentence out at the
     *     bottom.
     *  - The gutters are the reverse case: on the screen, not in the text. They carry
     *     {@link NONTEXT} so the walker skips them.
     *
     * Taking a line as "up to the next cue's start" also means anything in the gap
     * between two cues belongs to the line before it, so no part of the document can go
     * undrawn.
     */
    function renderCueLines(doc, cues, runs, runNode) {
      transcript.classList.add('caqdas__transcript--timed');
      const lineOf = [];
      let at = 0;
      // A line owns everything up to where the next one starts — including the newline
      // between them, and any gap a hand-edited timing value might leave.
      const lineEnd = (i) => (i < cues.length - 1 ? cues[i + 1].start : doc.text.length);
      for (const [i, cue] of cues.entries()) {
        const row = el('div', { class: 'caqdas__cue' });
        const gut = el('button', { class: 'caqdas__cuetime' });
        gut.setAttribute(NONTEXT, '');
        gut.type = 'button';
        gut.textContent = clockOf(cue.tStart);
        // The speaker goes in the TOOLTIP, not on the line: the label is already in the
        // transcript text (and in any quote taken from it), so drawing it again would be
        // a second copy that can disagree with the first. The gutter is the one place
        // that does not already say who is talking.
        const when = `${clockOf(cue.tStart)}\u2013${clockOf(cue.tEnd)}`;
        gut.title = [
          cue.speaker || null,
          currentMediaEl ? `play from ${when}` : `${when} \u2014 no recording is attached`,
        ].filter(Boolean).join(' \u00b7 ');
        gut.addEventListener('click', () => seekTo(cue.tStart));
        const body = el('div', { class: 'caqdas__cuetext' });
        const stop = lineEnd(i);
        while (at < runs.length && runs[at].b <= stop) { body.append(runNode(runs[at])); at += 1; }
        if (at < runs.length && runs[at].a < stop) {
          // A coding that runs past where this line ends: draw the part inside it and
          // leave the remainder for the next. Cue edges are already run boundaries, so
          // this only fires on a timing value whose cues overlap — kept as a guard,
          // because the alternative is silently dropping text.
          const run = runs[at];
          body.append(runNode({ ...run, b: stop }));
          runs[at] = { ...run, a: stop };
        }
        row.append(gut, body);
        transcript.append(row);
        lineOf.push(row);
      }
      // Anything after the last cue. With `lineEnd` running the final line to the end of
      // the text there should be nothing left, but a timing value whose last cue stops
      // short is possible, and silently not drawing part of a document is the worst
      // outcome available here.
      const tail = el('div', { class: 'caqdas__cue' });
      const tailBody = el('div', { class: 'caqdas__cuetext' });
      while (at < runs.length) { tailBody.append(runNode(runs[at])); at += 1; }
      if (tailBody.childNodes.length) {
        const gut = el('span', { class: 'caqdas__cuetime' });
        gut.setAttribute(NONTEXT, '');
        gut.textContent = '—';
        gut.title = 'Not covered by the transcript timing';
        tail.append(gut, tailBody);
        transcript.append(tail);
      }
      cueRows = lineOf;
      currentCues = cues;
      paintActiveCue();
    }

    /**
     * Load a transcript's recording and put a player above the text.
     *
     * Async and fire-and-forget: the transcript must be codable the instant it is drawn,
     * not after a media file has loaded. `token` is the same guard the image/video coder
     * uses — click through three documents quickly and the first load must not plant its
     * player over the third one's text.
     */
    async function attachTranscriptPlayer(doc) {
      const token = ++mediaLoadToken;
      const host = el('div', { class: 'caqdas__tplayer' });
      const loading = el('div', { class: 'caqdas__tloading' });
      loading.textContent = 'Loading the recording…';
      host.append(loading);
      textPane.prepend(host);
      let blob;
      try {
        blob = await app.assets.load(doc.timing.media[0]);
      } catch (err) {
        loading.textContent = `The recording could not be loaded: ${err.message}. The transcript is still codable.`;
        return;
      }
      if (token !== mediaLoadToken || !host.isConnected) return; // a later document won
      if (!blob) {
        loading.textContent = 'The recording is missing from this project. The transcript is still codable.';
        return;
      }
      const isVideo = String(blob.type || '').startsWith('video');
      transcriptUrl = URL.createObjectURL(blob);
      const player = document.createElement(isVideo ? 'video' : 'audio');
      player.controls = true;
      player.preload = 'metadata';
      player.className = isVideo ? 'caqdas__tvideo' : 'caqdas__taudio';
      player.src = transcriptUrl;
      currentMediaEl = player;
      currentMedium = isVideo ? 'video' : 'audio';
      // One listener driving one class change. `paintActiveCue` returns immediately
      // unless the cue actually changed, which is what makes a 4-per-second event safe.
      player.addEventListener('timeupdate', paintActiveCue);
      player.addEventListener('seeked', paintActiveCue);
      host.textContent = '';
      host.append(player);
      paintActiveCue();
    }

    /** Give back the blob: URL behind a transcript's player. */
    function releaseTranscriptMedia() {
      if (!transcriptUrl) return;
      // Revoking is not housekeeping here: each URL pins the whole media file in memory,
      // and a session spent clicking through thirty interviews would hold all thirty.
      URL.revokeObjectURL(transcriptUrl);
      transcriptUrl = null;
      currentMediaEl = null;
      currentMedium = null;
    }

    /** Move the playhead, if there is one to move. */
    function seekTo(t) {
      if (!currentMediaEl) return;
      try { currentMediaEl.currentTime = Math.max(0, Number(t) || 0); } catch { /* not seekable yet */ }
      if (currentMediaEl.paused) void currentMediaEl.play().catch(() => {});
    }

    /** Mark the line being spoken, so the transcript follows the recording. */
    function paintActiveCue() {
      if (!cueRows.length || !currentCues) return;
      const i = currentMediaEl ? activeCueIndex(currentCues, currentMediaEl.currentTime) : -1;
      if (i === activeCueRow) return;
      cueRows[activeCueRow]?.classList.remove('is-now');
      cueRows[i]?.classList.add('is-now');
      activeCueRow = i;
    }

    // Retrieve-by-code: the transcript pane lists every segment carrying one code,
    // across all documents — the core "show me everything I called X" move. Click an
    // item to jump to its document.
    function renderRetrieve() {
      const code = codeById(retrieveCodeId);
      const head = el('div', { class: 'caqdas__retrhead' });
      const back = el('button', { class: 'caqdas__btn' }); back.textContent = '← Back';
      back.addEventListener('click', () => { retrieveCodeId = null; renderText(); });
      const h = el('h3'); h.textContent = code ? `Coded “${code.name}”` : 'Coded segments';
      head.append(back, h); textPane.append(head);
      const segs = state.segments.filter((s) => s.codeId === retrieveCodeId);
      if (!segs.length) { const e = el('div', { class: 'caqdas__empty' }); e.textContent = 'No passages carry this code yet.'; textPane.append(e); return; }
      for (const s of segs) {
        const item = el('div', { class: 'caqdas__retr' });
        const rl = el('div', { class: 'rl' });
        const lab = el('span'); lab.textContent = docLabel(s.doc); rl.append(lab);
        // Delete this coding straight from the list — faster than finding the
        // highlight in the transcript and removing it there. Removes only THIS
        // segment (the code itself stays in the codebook).
        const rm = el('button', { class: 'caqdas__segrm' }); rm.textContent = '✕'; rm.title = 'Remove this coding and its notes';
        rm.addEventListener('click', (e) => { e.stopPropagation(); void removeCoding(s); });
        rl.append(rm);
        item.append(rl);
        const tx = el('div'); tx.textContent = s.quote ?? ''; item.append(tx);
        // A coding whose anchor no longer lands is still listed — it keeps its code and
        // its notes — but it says so rather than pretending to point somewhere.
        if (isUnsure(s)) item.append(el('div', { class: 'caqdas__segwarn', text: `⚠ ${s.reason || s.status}` }));
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
      const loading = el('div', { class: 'caqdas__empty' }); loading.textContent = 'Loading media…';
      textPane.append(loading);
      const token = ++mediaLoadToken;
      let blob = null;
      try { blob = await app.assets.load(doc.refs[0]); } catch { blob = null; }
      if (token !== mediaLoadToken) return; // a newer doc switch superseded this load
      if (mediaObjectUrl) { URL.revokeObjectURL(mediaObjectUrl); mediaObjectUrl = null; }
      textPane.textContent = '';
      if (!blob) {
        const e = el('div', { class: 'caqdas__empty' });
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
        const e = el('div', { class: 'caqdas__empty' }); e.textContent = 'This media type isn’t supported for coding.';
        textPane.append(e);
      }
    }

    /** Render an image doc: the picture + a region overlay (the 2-D selector). */
    function renderImage(doc) {
      const hint = el('div', { class: 'caqdas__mediahint' });
      hint.textContent = 'Drag on the image to draw a region, then click a code to tag it (right-click, or 🖌 to paint). Click a region to memo or remove it.';
      const wrap = el('div', { class: 'caqdas__imgwrap' });
      const img = el('img', { class: 'caqdas__img' });
      const overlay = el('div', { class: 'caqdas__overlay' });
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
        const wrap = el('div', { class: 'caqdas__vidwrap' });
        overlay = el('div', { class: 'caqdas__vidoverlay' }); // pointer-events:none until "Region" mode is on
        currentVideoOverlay = overlay;
        wrap.append(mediaEl, overlay);
        playerNode = wrap;
        attachVideoRegionDrawing(overlay, doc, mediaEl);
      }

      // Transport bar — a clear off-frame strip (play/pause for video + speed [+ ✎ Region]).
      // For video it sits right above the ruler so the whole frame is free for drawing;
      // for audio it's a plain speed row alongside the native controls.
      const ctrl = el('div', { class: isVideo ? 'caqdas__transport' : 'caqdas__mediactrl' });
      if (isVideo) {
        const playBtn = el('button', { class: 'caqdas__ctlbtn caqdas__playbtn' }); playBtn.textContent = '▶'; playBtn.title = 'Play / pause';
        const syncPlay = () => { playBtn.textContent = mediaEl.paused ? '▶' : '⏸'; };
        playBtn.addEventListener('click', () => { if (mediaEl.paused) mediaEl.play(); else mediaEl.pause(); });
        mediaEl.addEventListener('play', syncPlay);
        mediaEl.addEventListener('pause', syncPlay);
        // Click the frame itself (when not in Region mode) to play/pause too.
        mediaEl.addEventListener('click', () => { if (!overlay.classList.contains('is-drawing')) { if (mediaEl.paused) mediaEl.play(); else mediaEl.pause(); } });
        ctrl.append(playBtn);
      }
      const sl = el('span', { class: 'caqdas__speedlabel' }); sl.textContent = 'Speed';
      ctrl.append(sl);
      const speedBtns = [];
      for (const rate of [0.5, 1, 1.5, 2]) {
        const b = el('button', { class: 'caqdas__ctlbtn caqdas__speedbtn' + (rate === 1 ? ' is-on' : '') });
        b.textContent = rate + '×';
        b.addEventListener('click', () => { mediaEl.playbackRate = rate; speedBtns.forEach((x) => x.classList.toggle('is-on', x === b)); });
        speedBtns.push(b); ctrl.append(b);
      }
      if (isVideo) {
        // Volume / mute (lost with the native controls).
        const volBtn = el('button', { class: 'caqdas__ctlbtn' }); volBtn.title = 'Mute / unmute';
        const vol = el('input', { class: 'caqdas__vol' }); vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.value = '1'; vol.title = 'Volume';
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
        const dt = el('button', { class: 'caqdas__ctlbtn caqdas__regionbtn' }); dt.textContent = '✎ Region';
        dt.title = 'Draw region-over-time boxes on the frame';
        dt.addEventListener('click', () => dt.classList.toggle('is-on', overlay.classList.toggle('is-drawing')));
        ctrl.append(dt);
      }

      const hint = el('div', { class: 'caqdas__mediahint' });
      hint.textContent = isVideo
        ? 'Play/scrub with the controls below the frame (or click the frame to play/pause; drag the ruler thumb to scrub). Time coding: drag the ruler → pick a code. Region-over-time: turn on ✎ Region, draw a box on a subject, pick a code, then scrub and drag/resize the box (or ⦿ Auto-track) to add keyframes — nudge a drifted box back on target with its handles.'
        : 'Drag on the timeline to select a span, then click a code to tag it (right-click, or 🖌 to paint). Click a coding bar to memo/remove; click the ruler to seek.';

      const trackToolbar = el('div', { class: 'caqdas__tracktb' }); trackToolbar.style.display = 'none';
      trackToolbarEl = trackToolbar;

      const timeline = el('div', { class: 'caqdas__timeline' });
      currentTimeline = timeline;
      const track = el('div', { class: 'caqdas__tltrack' });
      const tlsel = el('div', { class: 'caqdas__tlsel' }); tlsel.style.display = 'none';
      const playhead = el('div', { class: 'caqdas__playhead' });
      const scrub = el('div', { class: 'caqdas__scrub' }); // draggable thumb over the playhead (scrub)
      track.append(tlsel, playhead, scrub);
      const lanes = el('div', { class: 'caqdas__lanes' });
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
      if (isVideo) {
        // Video is left alone deliberately. The frame IS the thing being watched, and a
        // pinned frame would take a third of the pane before a word of transcript showed;
        // pinning the transport without it would strand the buttons away from the picture
        // they drive. The ask came from transcripts, so that is what this changes.
        textPane.append(playerNode, hint, trackToolbar, ctrl, timeline);
      } else {
        // Audio: the player and its transport ride along at the top while the transcript
        // scrolls under them. The hint and the timeline scroll — the hint is read once,
        // and the timeline grows a lane per code, so pinning it would eat the pane.
        const nowPlaying = el('div', { class: 'caqdas__nowplaying' });
        nowPlaying.append(playerNode, ctrl);
        textPane.append(nowPlaying, hint, timeline);
      }
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
        const box = el('div', { class: 'caqdas__region' + (hasNotes(s) ? ' has-memo' : '') });
        positionPct(box, s.region);
        box.style.borderColor = color;
        box.style.backgroundColor = hexToRgba(color, 0.18);
        const lbl = el('span', { class: 'caqdas__rlabel' });
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
        selEl = el('div', { class: 'caqdas__regionsel' });
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
        if (activeCodeId) void addRegionSegment(activeCodeId, imageSel); // paint mode
      };
      overlay.addEventListener('pointerup', finish);
      overlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (imageSel) openAssignMenu({ kind: 'region', region: imageSel }, e);
      });
    }

    /**
     * The anchor for a media coding: the same cell target a text coding uses, plus the
     * ASSET the region was drawn on.
     *
     * That last part is the whole difference. Media was the modality assumed safe because
     * normalised coordinates cannot be moved by a text edit — but a media document is a
     * cell holding asset *refs*, so the same `setCell` repoints it at different bytes, and
     * a span at 4:32 stays a perfectly valid coordinate over a completely different
     * recording. Asset ids are content hashes, so recording one turns that from
     * undetectable into a single comparison.
     */
    const mediaAnchorFor = async (doc, selector) => ({
      kind: 'cell',
      target: docTarget(dsId, state.textColumn, doc.rid),
      ref: await app.anchors.media(selector, doc.refs?.[0] ?? null),
    });

    /** Record a region-coding segment (the 2-D analogue of {@link addSegment}). */
    async function addRegionSegment(codeId, region) {
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) return;
      const box = { x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) };
      state.segments.push(authored({
        doc: activeRid,
        codeId,
        region: box,
        anchor: await mediaAnchorFor(doc, { kind: 'rect', ...box }),
        quote: regionLabel(region), // a human label so retrieve/export/counts work unchanged
        status: 'exact',
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
        const e = el('div', { class: 'caqdas__lanesempty' });
        e.textContent = 'No codings yet — drag on the ruler above, then click a code.';
        lanesEl.append(e);
        return;
      }
      for (const cid of ids) {
        const code = codeById(cid);
        const color = code ? code.color : '#888';
        const lane = el('div', { class: 'caqdas__lane' });
        const label = el('span', { class: 'caqdas__lanelabel' }); label.textContent = code ? code.name : '(code)'; label.style.color = color;
        lane.append(label);
        const strip = el('div', { class: 'caqdas__lanestrip' });
        for (const s of byCode.get(cid)) {
          const bar = el('div', { class: 'caqdas__lanebar' + (hasNotes(s) ? ' has-memo' : '') + (s.keys ? ' is-track' : '') });
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
        if (activeCodeId) void addTimeSegment(activeCodeId, timeSel); // paint mode
      };
      track.addEventListener('pointerup', finish);
      track.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (timeSel) openAssignMenu({ kind: 'time', span: timeSel }, e);
      });
    }

    /** Record a time-range coding segment (the time twin of {@link addRegionSegment}). */
    async function addTimeSegment(codeId, span) {
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) return;
      const tStart = round3(span.tStart);
      const tEnd = round3(span.tEnd);
      state.segments.push(authored({
        doc: activeRid,
        codeId,
        tStart,
        tEnd,
        anchor: await mediaAnchorFor(doc, { kind: 'time-span', tStart, tEnd }),
        quote: timeLabel(span.tStart, span.tEnd),
        status: 'exact',
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
        selEl = el('div', { class: 'caqdas__regionsel' }); overlay.append(selEl);
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
        else { videoSel = rect; if (activeCodeId) void createTrack(activeCodeId, rect); } // else stage a new track
      });
      overlay.addEventListener('contextmenu', (e) => {
        if (!overlay.classList.contains('is-drawing')) return;
        e.preventDefault();
        if (videoSel) openAssignMenu({ kind: 'vregion', region: videoSel }, e);
      });
    }

    /** Start a new tracked region for a code at the current time (its first keyframe). */
    async function createTrack(codeId, region) {
      const t = round3(currentMediaEl?.currentTime || 0);
      const doc = docActive();
      if (!doc) return;
      const keys = [{ t, x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) }];
      const seg = authored({
        doc: activeRid, codeId,
        keys,
        tStart: t, tEnd: t,
        anchor: await mediaAnchorFor(doc, { kind: 'rect-track', keys }),
        quote: timeLabel(t, t),
        status: 'exact',
      });
      state.segments.push(seg);
      activeTrack = seg; videoSel = null;
      save();
      refreshLanes(); renderCodes(); renderTrackToolbar();
      drawTrackBoxes(currentVideoOverlay, docActive(), t);
    }

    /** A tracked region's keyframes ARE its selector, so editing them has to update the
     * anchor too — otherwise the stored reference slowly diverges from what is drawn, and
     * the anchor stops describing the coding it belongs to. One place owns both, which is
     * the field-ownership rule the same design applies to a text quote. */
    function retrackAnchor(seg) {
      seg.quote = timeLabel(seg.tStart, seg.tEnd);
      if (!seg.anchor?.ref) return;
      seg.anchor = {
        ...seg.anchor,
        ref: { ...seg.anchor.ref, selectors: [{ kind: 'rect-track', keys: seg.keys.map((k) => ({ ...k })) }] },
      };
    }

    /** Insert or replace the keyframe at (about) time `t`, keeping keys time-sorted. */
    function upsertKeyframe(seg, t, region, quiet) {
      const key = { t: round3(t), x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) };
      const i = seg.keys.findIndex((k) => Math.abs(k.t - key.t) < 0.05);
      if (i >= 0) seg.keys[i] = key; else seg.keys.push(key);
      seg.keys.sort((a, b) => a.t - b.t);
      seg.tStart = seg.keys[0].t; seg.tEnd = seg.keys[seg.keys.length - 1].t;
      retrackAnchor(seg);
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
      if (!seg.keys.length) { removeSegmentAndNotes(seg); activeTrack = null; }
      else { seg.tStart = seg.keys[0].t; seg.tEnd = seg.keys[seg.keys.length - 1].t; retrackAnchor(seg); }
      save(); refreshLanes(); renderCodes(); renderTrackToolbar();
      drawTrackBoxes(currentVideoOverlay, docActive(), t);
    }

    /** Remove an entire tracked region. */
    function removeTrack(seg) {
      removeSegmentAndNotes(seg);
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
        const box = el('div', { class: 'caqdas__trackbox' + (s === activeTrack ? ' is-active' : '') });
        positionPct(box, r);
        box.style.borderColor = color;
        box.style.backgroundColor = hexToRgba(color, 0.12);
        const lbl = el('span', { class: 'caqdas__rlabel' }); lbl.textContent = code ? code.name : '(code)'; lbl.style.backgroundColor = color;
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
        const hd = el('div', { class: 'caqdas__handle caqdas__h-' + h });
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
      const label = el('span', { class: 'caqdas__tracklabel' });
      label.textContent = `⦿ ${code ? code.name : '?'} · ${n} keyframe${n === 1 ? '' : 's'}`;
      if (code) label.style.color = code.color;
      const trackBtn = el('button', { class: 'caqdas__btn' });
      trackBtn.textContent = tracking ? '■ Stop' : '⦿ Auto-track ▶';
      trackBtn.title = 'Follow the box forward frame-by-frame (rough — correct any drift by re-drawing)';
      trackBtn.addEventListener('click', () => { if (tracking) tracking = false; else void trackForward(activeTrack, currentMediaEl); });
      const delBtn = el('button', { class: 'caqdas__btn' }); delBtn.textContent = '⌫ keyframe';
      delBtn.title = 'Delete the keyframe at the current time';
      delBtn.addEventListener('click', () => deleteKeyframeAt(activeTrack, currentMediaEl?.currentTime || 0));
      const rmBtn = el('button', { class: 'caqdas__btn' }); rmBtn.textContent = '🗑 track';
      rmBtn.title = 'Remove this whole tracked region';
      rmBtn.addEventListener('click', () => removeTrack(activeTrack));
      const doneBtn = el('button', { class: 'caqdas__btn caqdas__btn--primary' }); doneBtn.textContent = '✓ Done';
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

    // --- codebook manager ------------------------------------------------------
    //
    // Everything a codebook needs that the coding panel deliberately does not carry.
    // The panel is for CODING — pick a passage, click a code — and it was the only
    // surface, so the vocabulary stopped at "add" and "delete". You could not rename a
    // code, change its colour, rename a theme in one place, merge two codes, or move any
    // of it anywhere. That work belongs behind a button, not permanently on screen next
    // to the transcript.

    /** Open the manager. Returns nothing; it owns its own teardown. */
    function openManager() {
      const scrim = el('div', { class: 'caqdas__scrim' });
      const panel = el('div', { class: 'caqdas__mgr' });
      // The scrim is the modal boundary: a click on it (but not inside the panel)
      // closes, Escape closes, and focus is trapped until it does.
      scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key !== 'Tab') return;
        const f = [...panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((n) => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', onKey, true);
      const restoreTo = document.activeElement;
      function close() {
        document.removeEventListener('keydown', onKey, true);
        scrim.remove();
        // Everything the manager touched is in `state`; the coding panel re-reads it.
        renderCodes(); renderDocList(); renderText();
        try { restoreTo?.focus?.(); } catch { /* gone */ }
      }

      /** Codes selected for a bulk action, by id. Cleared whenever the book changes. */
      let picked = new Set();

      const head = el('div', { class: 'caqdas__mgrhead' });
      const title = el('div', { class: 'caqdas__mgrtitle' }); title.textContent = 'Codebook manager';
      const closeBtn = el('button', { class: 'caqdas__btn' }); closeBtn.textContent = 'Done';
      closeBtn.addEventListener('click', close);
      head.append(title, closeBtn);

      const bodyEl = el('div', { class: 'caqdas__mgrbody' });
      const side = el('div', { class: 'caqdas__mgrside' });
      const main = el('div', { class: 'caqdas__mgrmain' });
      const bar = el('div', { class: 'caqdas__mgrbar' });
      const list = el('div', { class: 'caqdas__mgrlist' });
      const foot = el('div', { class: 'caqdas__mgrfoot' });
      main.append(bar, list, foot);
      bodyEl.append(side, main);
      panel.append(head, bodyEl);
      scrim.append(panel);
      document.body.append(scrim);

      // --- the codebook list (left) --------------------------------------------
      function renderBooks() {
        side.textContent = '';
        const h = el('div', { class: 'caqdas__group' }); h.textContent = 'Codebooks';
        side.append(h);
        for (const b of state.codebooks) {
          const btn = el('button', { class: 'caqdas__bookbtn' + (b.id === state.codebookId ? ' is-active' : '') });
          const nm = el('span'); nm.textContent = b.name || '(unnamed)';
          const n = el('span', { class: 'caqdas__bookn' });
          n.textContent = state.codes.filter((c) => c.codebookId === b.id).length;
          btn.append(nm, n);
          btn.addEventListener('click', () => {
            if (b.id === state.codebookId) return;
            state.codebookId = b.id;
            picked = new Set();
            save();
            renderAll();
          });
          side.append(btn);
        }
        const add = el('button', { class: 'caqdas__btn' });
        add.textContent = '＋ New codebook';
        add.style.marginTop = '8px';
        add.addEventListener('click', () => {
          const b = { id: uid('b'), name: nextBookName() };
          state.codebooks.push(b);
          state.codebookId = b.id;
          picked = new Set();
          save();
          renderAll();
        });
        side.append(add);
      }

      function nextBookName() {
        const taken = new Set(state.codebooks.map((b) => b.name));
        for (let i = 2; ; i++) if (!taken.has(`Codebook ${i}`)) return `Codebook ${i}`;
      }

      // --- the toolbar (above the code list) ------------------------------------
      function renderBar() {
        bar.textContent = '';
        const book = state.codebooks.find((b) => b.id === state.codebookId);

        const nameInp = el('input'); nameInp.type = 'text';
        nameInp.value = book?.name ?? '';
        nameInp.title = 'Rename this codebook';
        nameInp.style.flex = '1 1 160px';
        nameInp.addEventListener('input', () => { if (book) { book.name = nameInp.value; save(); renderBooks(); } });
        bar.append(nameInp);

        const del = el('button', { class: 'caqdas__btn' });
        del.textContent = 'Delete codebook';
        // Never leave codings orphaned: a segment whose code is gone renders as "(code)"
        // and cannot be repaired. Deleting the last book is refused outright rather than
        // silently recreating one behind the user.
        del.disabled = state.codebooks.length < 2;
        del.title = del.disabled ? 'A project keeps at least one codebook' : 'Delete this codebook and its codes';
        del.addEventListener('click', () => {
          const doomed = codesInBook(state).map((c) => c.id);
          const n = state.segments.filter((sg) => doomed.includes(sg.codeId)).length;
          if (!confirmInline(del, n
            ? `Delete “${book?.name}”, its ${doomed.length} code(s) and ${n} coding(s)?`
            : `Delete “${book?.name}” and its ${doomed.length} code(s)?`)) return;
          dropCodes(doomed);
          state.codebooks = state.codebooks.filter((b) => b.id !== state.codebookId);
          state.codebookId = state.codebooks[0].id;
          picked = new Set();
          save();
          renderAll();
        });
        bar.append(del);

        const imp = el('button', { class: 'caqdas__btn' }); imp.textContent = '⇪ Paste codes…';
        imp.title = 'Add many codes at once from a pasted list or CSV';
        imp.addEventListener('click', showPaste);
        bar.append(imp);

        const exp = el('button', { class: 'caqdas__btn' }); exp.textContent = '⇩ Copy as CSV';
        exp.title = 'Copy this codebook to the clipboard as CSV';
        exp.addEventListener('click', () => copyCsv(exp));
        bar.append(exp);
      }

      // --- the code list (right) -------------------------------------------------
      function renderList() {
        list.textContent = '';
        const mine = codesInBook(state);
        if (!mine.length) {
          const e = el('div', { class: 'caqdas__mgrempty' });
          e.textContent = 'No codes in this codebook yet. Add them in the coding panel, or paste a list.';
          list.append(e);
          renderFoot();
          return;
        }
        const counts = {};
        for (const sg of state.segments) counts[sg.codeId] = (counts[sg.codeId] || 0) + 1;

        const hdr = el('div', { class: 'caqdas__mgrrow' });
        const all = el('input'); all.type = 'checkbox';
        all.checked = mine.every((c) => picked.has(c.id));
        all.title = 'Select all';
        all.addEventListener('change', () => {
          picked = all.checked ? new Set(mine.map((c) => c.id)) : new Set();
          renderList();
        });
        const hn = el('span', { class: 'caqdas__mgrname' }); hn.textContent = 'Code';
        hn.style.color = '#8b949c'; hn.style.fontSize = '11px';
        const ht = el('span', { class: 'caqdas__mgrtheme' }); ht.textContent = 'Theme';
        ht.style.color = '#8b949c'; ht.style.fontSize = '11px';
        const hc = el('span', { class: 'caqdas__mgrcount' }); hc.textContent = 'Uses';
        hdr.append(all, el('span'), hn, ht, hc);
        list.append(hdr);

        for (const code of mine) {
          const row = el('div', { class: 'caqdas__mgrrow' });
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = picked.has(code.id);
          cb.addEventListener('change', () => {
            if (cb.checked) picked.add(code.id); else picked.delete(code.id);
            renderFoot();
          });
          // A colour picker at last — the palette assigned one round-robin at creation
          // and nothing could ever change it.
          const col = el('input'); col.type = 'color'; col.value = toHex(code.color);
          col.title = 'Colour';
          col.addEventListener('input', () => { code.color = col.value; save(); });

          const nm = el('input', { class: 'caqdas__mgrname' }); nm.type = 'text'; nm.value = code.name;
          nm.title = 'Rename';
          nm.addEventListener('input', () => { code.name = nm.value; save(); });

          const th = el('input', { class: 'caqdas__mgrtheme' }); th.type = 'text'; th.value = code.group || '';
          th.placeholder = 'theme';
          th.setAttribute('list', 'caqdas-themes');
          th.addEventListener('input', () => { code.group = th.value; save(); });

          const ct = el('span', { class: 'caqdas__mgrcount' }); ct.textContent = counts[code.id] || 0;
          row.append(cb, col, nm, th, ct);
          list.append(row);
        }

        // Existing themes as suggestions, so a theme is retyped consistently rather
        // than re-invented with a typo — which used to silently split it in two.
        const dl = el('datalist'); dl.id = 'caqdas-themes';
        for (const g of [...new Set(state.codes.map((c) => c.group).filter(Boolean))]) {
          const o = el('option'); o.value = g; dl.append(o);
        }
        list.append(dl);
        renderFoot();
      }

      // --- bulk actions (below the list) -----------------------------------------
      function renderFoot() {
        foot.textContent = '';
        const n = picked.size;
        const lbl = el('span', { class: 'caqdas__sel' });
        lbl.textContent = n ? `${n} selected` : 'Select codes for bulk actions';
        foot.append(lbl);
        if (!n) return;

        // Copy / move to another codebook — the thing that had nowhere to go before
        // codebooks were addressable.
        const sel = el('select');
        const none = el('option'); none.value = ''; none.textContent = 'Copy to…'; sel.append(none);
        for (const b of state.codebooks) {
          if (b.id === state.codebookId) continue;
          const o = el('option'); o.value = b.id; o.textContent = b.name; sel.append(o);
        }
        const nb = el('option'); nb.value = '__new'; nb.textContent = 'a new codebook…'; sel.append(nb);
        sel.addEventListener('change', () => { if (sel.value) copyTo(sel.value, false); });
        foot.append(sel);

        const mv = el('select');
        const mnone = el('option'); mnone.value = ''; mnone.textContent = 'Move to…'; mv.append(mnone);
        for (const b of state.codebooks) {
          if (b.id === state.codebookId) continue;
          const o = el('option'); o.value = b.id; o.textContent = b.name; mv.append(o);
        }
        const mnb = el('option'); mnb.value = '__new'; mnb.textContent = 'a new codebook…'; mv.append(mnb);
        mv.title = 'Move takes the codings with it — the code keeps its id, so nothing is orphaned.';
        mv.addEventListener('change', () => { if (mv.value) copyTo(mv.value, true); });
        foot.append(mv);

        const merge = el('button', { class: 'caqdas__btn' });
        merge.textContent = 'Merge';
        merge.disabled = n < 2;
        merge.title = n < 2 ? 'Select two or more codes to merge' : 'Fold the selected codes into the first, keeping every coding';
        merge.addEventListener('click', mergePicked);
        foot.append(merge);

        const del = el('button', { class: 'caqdas__btn' });
        del.textContent = 'Delete';
        del.addEventListener('click', deletePicked);
        foot.append(del);
      }

      /**
       * Copy or move the selected codes into another codebook.
       *
       * COPY duplicates them under fresh ids and leaves the codings behind — a copy is a
       * starting point for other data, and codings belong to the dataset they were made
       * in. MOVE keeps the ids, so every existing coding follows automatically and
       * nothing is orphaned.
       */
      function copyTo(target, isMove) {
        let bookId = target;
        if (target === '__new') {
          const b = { id: uid('b'), name: nextBookName() };
          state.codebooks.push(b);
          bookId = b.id;
        }
        const chosen = state.codes.filter((c) => picked.has(c.id));
        if (isMove) {
          for (const c of chosen) c.codebookId = bookId;
        } else {
          for (const c of chosen) {
            state.codes.push({ ...c, id: uid(), codebookId: bookId });
          }
        }
        picked = new Set();
        save();
        renderAll();
      }

      /** Fold the selected codes into the first, re-pointing every coding. */
      function mergePicked() {
        const chosen = codesInBook(state).filter((c) => picked.has(c.id));
        if (chosen.length < 2) return;
        const keep = chosen[0];
        const gone = chosen.slice(1).map((c) => c.id);
        // Re-point BEFORE removing, so no segment is ever briefly dangling.
        for (const sg of state.segments) if (gone.includes(sg.codeId)) sg.codeId = keep.id;
        state.codes = state.codes.filter((c) => !gone.includes(c.id));
        picked = new Set([keep.id]);
        save();
        renderAll();
      }

      function deletePicked() {
        const doomed = [...picked];
        const n = state.segments.filter((sg) => doomed.includes(sg.codeId)).length;
        const btn = foot.querySelector('button:last-child');
        if (!confirmInline(btn, n
          ? `Delete ${doomed.length} code(s) and ${n} coding(s)?`
          : `Delete ${doomed.length} code(s)?`)) return;
        dropCodes(doomed);
        picked = new Set();
        save();
        renderAll();
      }

      // --- paste-in --------------------------------------------------------------
      function showPaste() {
        list.textContent = '';
        foot.textContent = '';
        const note = el('p', { class: 'caqdas__mgrnote' });
        note.textContent = 'One code per line. Optionally "name, theme, #colour" — a plain list of names works too. '
          + 'Existing names are skipped, so you can paste the same sheet twice safely.';
        const ta = el('textarea', { class: 'caqdas__paste' });
        ta.placeholder = 'Trust, Relational, #8ecae6\nDelay, Process\nAmbivalence';
        const wrap = el('div'); wrap.style.padding = '12px';
        wrap.append(note, ta);
        list.append(wrap);

        const cancel = el('button', { class: 'caqdas__btn' }); cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => renderAll());
        const go = el('button', { class: 'caqdas__btn' }); go.textContent = 'Add codes';
        go.addEventListener('click', () => {
          const added = addCodesFromText(state, ta.value);
          save();
          renderAll();
          if (!added) note.textContent = 'Nothing added — every name was already in this codebook.';
        });
        const sp = el('span', { class: 'caqdas__sel' }); sp.textContent = '';
        foot.append(sp, cancel, go);
        ta.focus();
      }

      async function copyCsv(btn) {
        const csv = codebookToCsv(codesInBook(state));
        try {
          await navigator.clipboard.writeText(csv);
          flash(btn, 'Copied');
        } catch {
          // Clipboard can be refused in a sandboxed frame; fall back to selecting the
          // text so the user can copy it by hand rather than getting nothing.
          showText(csv);
        }
      }

      function showText(csv) {
        list.textContent = '';
        const wrap = el('div'); wrap.style.padding = '12px';
        const note = el('p', { class: 'caqdas__mgrnote' });
        note.textContent = 'Copy this text (the clipboard was not available).';
        const ta = el('textarea', { class: 'caqdas__paste' }); ta.value = csv; ta.readOnly = true;
        wrap.append(note, ta);
        list.append(wrap);
        ta.select();
        foot.textContent = '';
        const back = el('button', { class: 'caqdas__btn' }); back.textContent = 'Back';
        back.addEventListener('click', () => renderAll());
        foot.append(el('span', { class: 'caqdas__sel' }), back);
      }

      function renderAll() { renderBooks(); renderBar(); renderList(); }
      renderAll();
      closeBtn.focus();
    }

    /** A yes/no in place of `confirm`, which a sandboxed frame does not have. */
    function confirmInline(anchorEl, message) {
      // Synchronous confirmation is impossible without `confirm`, so this is deliberately
      // a plain check the caller can skip: destructive actions here are all undoable by
      // the host's op log, and blocking the whole panel on a modal-within-a-modal for
      // every delete would be worse than the risk.
      const ok = anchorEl?.dataset.armed === '1';
      if (ok) { delete anchorEl.dataset.armed; return true; }
      if (anchorEl) {
        anchorEl.dataset.armed = '1';
        const was = anchorEl.textContent;
        anchorEl.textContent = 'Sure?';
        anchorEl.title = message;
        setTimeout(() => {
          if (anchorEl.dataset.armed === '1') { delete anchorEl.dataset.armed; anchorEl.textContent = was; }
        }, 4000);
      }
      return false;
    }

    function flash(btn, text) {
      const was = btn.textContent;
      btn.textContent = text;
      setTimeout(() => { btn.textContent = was; }, 1200);
    }

    function renderCodes() {
      codePane.textContent = '';
      const h = el('h3'); h.textContent = 'Codebook';
      // The manager lives behind a button, not permanently beside the transcript: the
      // panel's job is coding, and bulk editing is a different job done occasionally.
      const mgrBtn = el('button', { class: 'caqdas__btn' });
      mgrBtn.textContent = '⚙';
      mgrBtn.title = 'Codebook manager — rename, recolour, merge, bulk-add, and move codes between codebooks';
      mgrBtn.style.cssText = 'float:right; padding:2px 8px;';
      mgrBtn.addEventListener('click', openManager);
      h.append(mgrBtn);
      codePane.append(h);
      const hint = el('div', { class: 'caqdas__hint' });
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
        if (g) { const gh = el('div', { class: 'caqdas__group' }); gh.textContent = g; codePane.append(gh); }
        else if (hasThemes) { const gh = el('div', { class: 'caqdas__group caqdas__group--none' }); gh.textContent = 'No theme'; codePane.append(gh); }
        for (const code of groups.get(g)) {
          const r = el('div', { class: 'caqdas__code' + (armed === code.id ? ' is-armed' : '') });
          r.title = 'Click to code the selected passage';
          const sw = el('span', { class: 'caqdas__sw' }); sw.style.backgroundColor = code.color;
          const nm = el('span', { class: 'nm' }); nm.textContent = code.name;
          if (code.memo) nm.title = code.memo;
          const ct = el('span', { class: 'ct' }); ct.textContent = counts[code.id] || 0;
          const rb = el('button', { class: 'caqdas__iconbtn' }); rb.textContent = '🔍'; rb.title = 'Show every passage coded with this';
          rb.addEventListener('click', (e) => { e.stopPropagation(); retrieveCodeId = code.id; renderText(); });
          const mb = el('button', { class: 'caqdas__iconbtn' + (hasNotes(code) ? ' has' : '') }); mb.textContent = '✎'; mb.title = 'Notes + theme group (code details)';
          mb.addEventListener('click', (e) => { e.stopPropagation(); memoOpen.has(code.id) ? memoOpen.delete(code.id) : memoOpen.add(code.id); renderCodes(); });
          const pb = el('button', { class: 'pb' + (armed === code.id ? ' is-on' : '') });
          pb.textContent = '🖌';
          pb.title = 'Paint mode: arm this code so selecting passages auto-applies it';
          pb.addEventListener('click', (e) => { e.stopPropagation(); setArmed(code.id); });
          // Per-code region-layer visibility (image docs only): hide/show this code's
          // boxes so overlapping codings can be isolated or compared.
          let vb = null;
          if (activeIsMedia) {
            const hidden = hiddenCodes.has(code.id);
            vb = el('button', { class: 'caqdas__iconbtn' + (hidden ? '' : ' has') });
            vb.textContent = hidden ? '◌' : '👁';
            vb.title = hidden ? 'Show this code’s regions' : 'Hide this code’s regions';
            vb.addEventListener('click', (e) => {
              e.stopPropagation();
              if (hidden) hiddenCodes.delete(code.id); else hiddenCodes.add(code.id);
              refreshMedia();
              renderCodes();
            });
          }
          const x = el('button', { class: 'x' }); x.textContent = '✕'; x.title = 'Delete code + its segments';
          x.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activeCodeId === code.id) activeCodeId = null;
            dropCodes([code.id]);
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
              if (imageSel) void addRegionSegment(code.id, imageSel);
              else if (videoSel) createTrack(code.id, videoSel);
              else if (timeSel) void addTimeSegment(code.id, timeSel);
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
              dropSegments((s) => enclosing.includes(s));
              save(); renderText(); renderDocList(); renderCodes();
              setSelectionRange(transcript, span.lo, span.hi); // keep selection for re-toggling
            } else {
              void addSegment(code.id, span);
            }
          });
          r.append(sw, nm, ct, rb, mb, pb);
          if (vb) r.append(vb);
          r.append(x);
          codePane.append(r);
          // ✎ details: theme group + analytic memo, both persisted on the code.
          if (memoOpen.has(code.id)) {
            const panel = el('div', { class: 'caqdas__details' });
            const gi = el('input', { class: 'caqdas__grpinp' }); gi.placeholder = 'theme / group'; gi.value = code.group || '';
            gi.addEventListener('input', () => { code.group = gi.value; save(); });
            gi.addEventListener('blur', renderCodes);
            panel.append(gi, renderThread('code', code, renderCodes)); // author-stamped notes thread (#148)
            codePane.append(panel);
          }
        }
      }
      // inline "new code"
      const nc = el('div', { class: 'caqdas__newcode' });
      const inp = el('input'); inp.placeholder = 'New code…';
      const add = el('button', { class: 'caqdas__btn' }); add.textContent = '＋';
      add.setAttribute('aria-label', 'Add code'); add.title = 'Add code';
      const commit = () => {
        const name = inp.value.trim();
        if (!name) return;
        const mine = codesInBook(state);
        state.codes.push(authored({ id: uid(), name, color: PALETTE[mine.length % PALETTE.length], group: '', memo: '', codebookId: state.codebookId, sort: nextSortKey(mine) }));
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
      if (!transcript || !transcript.contains(range.commonAncestorContainer)) return null;
      const a = offsetWithin(transcript, range.startContainer, range.startOffset);
      const b = offsetWithin(transcript, range.endContainer, range.endOffset);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi <= lo) return null;
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) return null;
      const text = doc.text.slice(lo, hi);
      // A span covering no characters cannot anchor anything, and saying so beats writing
      // it: while offsets were measured against the wrong container they ran past the end
      // of short documents, and re-anchor wrote a quote of "" without complaint.
      if (!text) return null;
      return { lo, hi, text, range };
    };

    /**
     * The last passage the user actually selected in this document.
     *
     * Re-anchoring needs a selection that OUTLIVES a click, and a live selection does not:
     * you select the correct passage, click the mis-placed highlight to reach its menu,
     * and the click collapses what you just selected — so the re-anchor button had
     * nothing to work with (reported from real use). Remembering the last non-empty
     * selection makes the gesture work in the order a person actually performs it, and
     * makes the button reachable from the drift list too, where the same click problem
     * applies.
     *
     * Cleared when the document changes: a span means nothing in another transcript.
     */
    let lastSpan = null;
    document.addEventListener('selectionchange', () => {
      const span = currentSpan();
      if (span) lastSpan = { ...span, rid: activeRid };
    });
    /** The span to re-anchor to: what is selected now, else what was selected last. */
    const spanForReanchor = () => currentSpan() ?? (lastSpan?.rid === activeRid ? lastSpan : null);

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
    /**
     * Build a text coding for a span of the active document: the anchor (what it quotes),
     * the display quote, and the derived span for this session. One helper so the anchor
     * and its label are written together and cannot drift apart.
     */
    const textCoding = async (codeId, doc, lo, hi) => {
      const anchor = {
        kind: 'cell',
        target: docTarget(dsId, state.textColumn, doc.rid),
        ref: await app.anchors.text(doc.text ?? '', lo, hi),
      };
      return {
        doc: doc.rid,
        codeId,
        anchor,
        quote: quoteOf(anchor),
        // Derived for this session; stripped before storage.
        start: lo,
        end: hi,
        status: 'exact',
      };
    };

    // --- the edit vocabulary (#166 step 2) -----------------------------------
    //
    // Adjusting a coding used to be impossible: the only action was Remove, so fixing a
    // one-character overshoot cost a delete and a re-mark — and with it the note thread,
    // because notes anchor to the SEGMENT id. Charging a paragraph of analytic reasoning
    // for a boundary nudge was the real defect, not the keystrokes.
    //
    // These three operations all preserve the segment's id, which is the entire trick.
    // Notes survive because identity survives; there is no separate mechanism for it.

    // --- cascade (#166 §8) ----------------------------------------------------
    //
    // A note DEPENDS ON what it annotates: it cascades on delete, and it never travels.
    // Every removal path used to be a bare array filter, so notes outlived the codings
    // and codes they were written about — reachable only through the host's orphan sweep.
    // These helpers are the one place a removal happens, so the dependency is honoured
    // whichever gesture triggered it.

    /** Drop the notes anchored to a set of ids. */
    const dropNotesFor = (ids) => {
      if (!ids.size) return;
      state.memos = (state.memos ?? []).filter((n) => !ids.has(n.anchorId));
    };

    /** Drop every coding matching `pred`, taking its notes with it. */
    const dropSegments = (pred) => {
      const going = state.segments.filter(pred);
      if (!going.length) return 0;
      dropNotesFor(new Set(going.map((x) => x.id).filter(Boolean)));
      state.segments = state.segments.filter((x) => !going.includes(x));
      return going.length;
    };

    /** Drop codes by id, cascading to their codings and every note on either. */
    const dropCodes = (ids) => {
      const doomed = new Set(ids);
      if (!doomed.size) return;
      dropSegments((sg) => doomed.has(sg.codeId));
      dropNotesFor(doomed); // notes written on the CODE itself
      state.codes = state.codes.filter((c) => !doomed.has(c.id));
    };

    /** Drop a coding and the notes that annotate it, without re-rendering — for callers
     * mid-way through their own update. See {@link removeCoding} for the user action. */
    const removeSegmentAndNotes = (seg) => { dropSegments((x) => x === seg); };

    /** Move a coding to the passage the user has selected. */
    const reanchorToSelection = async (seg) => {
      const span = spanForReanchor();
      if (!span) {
        app.results?.appendError?.('Select the correct passage in the transcript first, then re-anchor.');
        return;
      }
      const doc = docs.find((d) => d.rid === seg.doc);
      if (!doc || doc.kind === 'media') return;
      const fields = await textCoding(seg.codeId, doc, span.lo, span.hi);
      // `textRef` returns null for a span that covers nothing, and this path OVERWRITES a
      // coding that already exists — so refuse rather than replace a working anchor with
      // one that points nowhere. That trade cost a real coding once.
      if (!fields.anchor?.ref) {
        app.results?.appendError?.('That passage could not be anchored — the coding was left as it was.');
        return;
      }
      // Assign onto the SAME object: same id, same author, same notes.
      seg.anchor = fields.anchor;
      seg.quote = fields.quote;
      seg.start = fields.start;
      seg.end = fields.end;
      seg.status = 'exact';
      seg.reason = null;
      lastSpan = null; // consumed — so a second click cannot silently reuse it
      save();
      renderText(); renderDocList(); renderCodes();
    };

    /** Change which code a coding carries, keeping the coding (and its notes) intact. */
    const recodeSegment = (seg, codeId) => {
      if (!codeId || codeId === seg.codeId) return;
      seg.codeId = codeId;
      save();
      closeMenu();
      refreshView();
    };

    /**
     * Remove a coding AND the notes anchored to it.
     *
     * The old path was a bare array filter, so every note written on that coding outlived
     * it — reachable only through the host's orphan sweep. A note depends on the coding it
     * annotates; deleting one without the other leaves a note about nothing.
     */
    const removeCoding = async (seg) => {
      removeSegmentAndNotes(seg);
      save();
      closeMenu();
      refreshView();
    };

    const addSegment = async (codeId, span, restore = true) => {
      let { lo, hi } = span;
      // Overlap is judged on RESOLVED positions, so a coding whose anchor no longer lands
      // (orphaned) can neither absorb nor be absorbed. Fusing a passage with something
      // whose whereabouts are unknown is how two unrelated spans become one coding — the
      // second-order hazard #164 flagged in this very function.
      const overlaps = (s) => s.doc === activeRid && s.codeId === codeId && isPlaced(s) && s.start < hi && lo < s.end;
      const hits = state.segments.filter(overlaps);
      const doc = docs.find((d) => d.rid === activeRid);
      if (!doc) return;
      if (hits.length) {
        const memos = [];
        for (const s of hits) { lo = Math.min(lo, s.start); hi = Math.max(hi, s.end); if (s.memo) memos.push(s.memo); }
        const merged = authored(await textCoding(codeId, doc, lo, hi));
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
        state.segments.push(authored(await textCoding(codeId, doc, lo, hi)));
        save();
      }
      renderText(); renderDocList(); renderCodes();
      // Pick mode keeps the (possibly grown) passage selected (layer more codes);
      // paint mode clears it so the user moves straight on to the next passage.
      if (restore) setSelectionRange(transcript, lo, hi);
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
      if (span) void addSegment(activeCodeId, span, false); // paint: clear selection, move on
    });

    function openAssignMenu(span, evt) {
      closeMenu();
      menu = el('div', { class: 'caqdas__menu' });
      const choose = (codeId) => {
        closeMenu();
        if (span && span.kind === 'region') void addRegionSegment(codeId, span.region);
        else if (span && span.kind === 'vregion') createTrack(codeId, span.region);
        else if (span && span.kind === 'time') void addTimeSegment(codeId, span.span);
        else void addSegment(codeId, span);
      };
      for (const code of codesInBook(state)) {
        const b = el('button');
        const sw = el('span', { class: 'caqdas__sw' }); sw.style.backgroundColor = code.color;
        const nm = document.createTextNode(code.name);
        b.append(sw, nm);
        b.addEventListener('click', (e) => { e.stopPropagation(); choose(code.id); });
        menu.append(b);
      }
      const row = el('div', { class: 'row' });
      const inp = el('input'); inp.placeholder = 'New code from selection…';
      row.append(inp);
      const mk = () => {
        const name = inp.value.trim();
        if (!name) return;
        const inBook = codesInBook(state);
        const code = authored({ id: uid(), name, color: PALETTE[inBook.length % PALETTE.length], group: '', memo: '', codebookId: state.codebookId, sort: nextSortKey(inBook) });
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
      menu = el('div', { class: 'caqdas__menu' });
      for (const seg of covering) {
        const code = codeById(seg.codeId);
        const head = el('div', { class: 'caqdas__seghead' });
        const sw = el('span', { class: 'caqdas__sw' }); sw.style.backgroundColor = code ? code.color : '#ccc';
        const nm = el('span', { class: 'nm' }); nm.textContent = code ? code.name : '(code)';
        const rm = el('button', { class: 'caqdas__segrm' }); rm.textContent = 'Remove'; rm.title = 'Remove this coding and its notes';
        rm.addEventListener('click', (e) => { e.stopPropagation(); void removeCoding(seg); });
        head.append(sw, nm, rm); menu.append(head);

        // Adjust, rather than delete-and-redo. Both keep the segment id, so the notes
        // thread below survives the edit — which is the whole reason these exist.
        const tools = el('div', { class: 'caqdas__segtools' });
        const move = el('button', { class: 'caqdas__btn' });
        move.textContent = '⇔ Re-anchor to selection';
        move.title = 'Select the correct passage, then click this — the coding keeps its notes';
        move.addEventListener('click', (e) => { e.stopPropagation(); void reanchorToSelection(seg); });
        tools.append(move);

        const swap = el('select');
        swap.title = 'Change which code this passage carries (keeps its notes)';
        const none = el('option'); none.value = ''; none.textContent = 'Change code…'; swap.append(none);
        for (const c of codesInBook(state)) {
          if (c.id === seg.codeId) continue;
          const o = el('option'); o.value = c.id; o.textContent = c.name; swap.append(o);
        }
        swap.addEventListener('click', (e) => e.stopPropagation());
        swap.addEventListener('change', () => recodeSegment(seg, swap.value));
        tools.append(swap);
        menu.append(tools);

        if (isUnsure(seg)) {
          menu.append(el('div', { class: 'caqdas__segwarn', text: `⚠ ${seg.reason || seg.status}` }));
        }
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
        return [labelFor[s.doc] ?? '?', c?.group || '—', c?.name ?? '?', s.quote ?? '', s.memo || ''];
      });
      await app.results.beginAnalysis('Coded segments');
      await app.results.appendTable({ columns: [header, 'Theme', 'Code', 'Text', 'Memo'], rows });
      await app.results.endAnalysis();
    });



    /**
     * The attributes to carry across, read from the documents' own rows.
     *
     * Shared by both shapes because it is the same question with the same answer: a
     * document's attributes are the other columns of its row, and which of them travel
     * is the user's choice, not the shape's.
     */
    async function carriedAttrs(carry) {
      if (carry === 'none') return [];
      const meta = await app.data.getVariableMeta();
      const wanted = carry === 'label'
        ? meta.filter((m) => m.name === state.labelColumn)
        : meta.filter((m) => m.name !== state.textColumn && m.name !== state.labelColumn);
      if (!wanted.length) return [];
      const rows = await app.data.getRows({
        variables: wanted.map((m) => m.name), includeRowId: true, limit: MAX_DOCS,
      });
      const at = new Map(rows.map((r) => [String(r.__rid), r]));
      return wanted.map((m) => ({ meta: m, values: docs.map((d) => at.get(d.rid)?.[m.name] ?? null) }));
    }

    /** The document list in the shape the pure functions take. */
    const docRows = () => docs.map((d) => ({
      rid: d.rid,
      label: d.label,
      chars: d.kind === 'text' ? (d.text ?? '').length : 0,
      // A row with nothing in it is not a document that declined to mention the theme,
      // and counting it would deflate every prevalence on the table.
      isDoc: d.kind === 'media' || String(d.text ?? '').trim() !== '',
    }));



    /**
     * Shape D: counts per case per occasion, where an occasion is a DOCUMENT and a case
     * spans several of them.
     *
     * Case and occasion are columns the user nominates rather than a new concept: the
     * grouping is already in the data (a document is a row), and a second place to
     * declare it would only drift from the first.
     */
    async function quantitiseOccasions() {
      const meta = await app.data.getVariableMeta();
      const names = meta.filter((m) => m.name !== state.textColumn);
      if (names.length < 2) {
        app.results.appendError(
          'This shape needs two more columns in the data: one naming the case (the participant '
          + 'followed across documents) and one giving the occasion (interview 1, 2, 3…).',
        );
        return;
      }
      const opt = (m) => ({ value: m.name, label: m.label && m.label !== m.name ? `${m.name} — ${m.label}` : m.name });
      // Guessed from the column names, because these two are usually called what they
      // are — and a guess that is visible in a select costs nothing to correct.
      const guess = (re, fallback) => (names.find((m) => re.test(m.name)) || fallback || {}).name || '';
      const form = await app.ui.showForm({
        title: 'Quantitise codings — a series across occasions',
        hint: 'One row per case, occasion and code. This is the shape the single-case design tools read: '
          + 'case, session, measure, value.',
        okLabel: 'Create dataset',
        fields: [
          {
            name: 'caseCol', type: 'select', label: 'Case is', value: guess(/^(case|participant|subject|respondent|id|person|child|client)$/i, names.find((m) => m.name === state.labelColumn)),
            hint: 'The participant or unit followed across documents — one series, and one graph panel, per value.',
            options: names.map(opt),
          },
          {
            name: 'occCol', type: 'select', label: 'Occasion is', value: guess(/^(session|wave|occasion|visit|round|time|timepoint|day|week|month|interview)$/i),
            hint: 'Which measurement occasion each document is. Numbers are used as they are; words are ordered by where they first appear in the data.',
            options: names.map(opt),
          },
          {
            name: 'rollup', type: 'select', label: 'Measures are', value: 'code',
            options: [{ value: 'code', label: 'Codes' }, { value: 'theme', label: 'Themes' }],
          },
          {
            name: 'scope', type: 'select', label: 'Codes from', value: 'book',
            options: [
              { value: 'book', label: 'The open codebook' },
              { value: 'all', label: 'Every codebook in the project' },
            ],
          },
          {
            name: 'carry', type: 'select', label: 'Carry across', value: 'all',
            hint: 'Keep every column if you want a PHASE: the single-case tools require one, and no coding can supply it.',
            options: [
              { value: 'all', label: 'Every other column of the source' },
              { value: 'none', label: 'Nothing' },
            ],
          },
        ],
      });
      if (!form) return;
      if (!form.caseCol || !form.occCol) { app.results.appendError('Both a case column and an occasion column are needed.'); return; }
      if (form.caseCol === form.occCol) {
        app.results.appendError('The case and the occasion must be different columns — otherwise every case has exactly one occasion and there is no series.');
        return;
      }

      // The two nominated columns ride on the document list itself, so the pure function
      // never has to know where they came from.
      const keyed = await app.data.getRows({
        variables: [form.caseCol, form.occCol], includeRowId: true, limit: MAX_DOCS,
      });
      const at = new Map(keyed.map((r) => [String(r.__rid), r]));
      const withKeys = docRows().map((d) => ({
        ...d,
        caseKey: at.get(d.rid)?.[form.caseCol] ?? '',
        occasion: at.get(d.rid)?.[form.occCol] ?? '',
      }));

      // The nominated columns are not carried as attributes too — they are already the
      // `case` and `occasion` columns, and a second copy under its original name is a
      // column that can disagree with the one beside it.
      const attrs = (await carriedAttrs(form.carry))
        .filter((a) => a.meta.name !== form.caseCol && a.meta.name !== form.occCol);

      const { variables, columns, report } = occasionCounts({
        docs: withKeys,
        segments: state.segments,
        codes: state.codes,
        bookId: state.codebookId,
        scope: form.scope,
        rollup: form.rollup,
        attrs,
      });
      if (!report.nRows) {
        app.results.appendError(
          'No case-and-occasion pairs were found. Every document needs a value in both columns '
          + 'to sit in a series.',
        );
        return;
      }

      const noun = form.rollup === 'theme' ? 'themes' : 'codes';
      const name = 'Codings — per case and occasion';
      await app.data.create({ name, variables, columns, activate: false });
      const phaseish = variables.find((v) => /phase|condition|block|stage/i.test(v.name));
      await app.results.beginAnalysis('Quantitise codings');
      await app.results.appendText(
        `**Dataset created: ${name}.** ${report.nRows} rows — ${report.nCases} case`
        + `${report.nCases === 1 ? '' : 's'} × ${report.nOccasions} occasion`
        + `${report.nOccasions === 1 ? '' : 's'} × the ${noun} in scope. Switch to it in the Data tab. `
        + `For a single-case graph use **\`count\`** as the outcome, **\`measure\`**, `
        + `**\`case\`** and **\`session\`**`
        + (phaseish ? ` — and \`${phaseish.name}\` looks like your phase column.` : '.'),
      );
      await app.results.appendText(
        '**How this was built:**\n\n'
        + `- **A case is \`${form.caseCol}\` and an occasion is \`${form.occCol}\`**, both read from each `
        + 'document’s own row. Nothing in the coding records says which participant or which '
        + 'interview a document is; those are facts about the data, so they are nominated rather '
        + 'than invented.\n'
        + `- **The occasion axis** ${report.numericOccasions
          ? 'came from the column as numbers.'
          : 'is not numeric, so `session` numbers the occasions in the order they first appear in the data — the same rule the single-case tools use when no session column is given. The original label is in `occasion`, so the ordering can be checked.'}\n`
        + `- **Zeros are rows.** ${report.zeros} of ${report.nRows} rows are a code that did not occur `
        + 'in that occasion, which is an observation rather than a gap — a missing row would have a '
        + 'line drawn straight through it. Occasions a case does not have are NOT invented: a '
        + 'participant who stopped after session two has no session three.\n'
        + '- **A phase is required by the single-case tools and no coding can supply one** — when an '
        + 'intervention started is a fact about the study design. It has to be one of the carried '
        + 'columns.\n'
        + '- **The non-overlap indices take ONE measure at a time.** The graph reads the `measure` '
        + 'column, but NAP/PND/Tau-U do not, so run against this table as it stands they would pool '
        + 'every code into one series per case and report a number for nothing. Use Transform ▸ '
        + 'Select cases to keep a single `measure` first.'
        + (report.conflicts ? `\n- ${report.conflicts} cell(s) drew a carried value from several documents that disagreed; the first was used. Check your phase column if one of those is it.` : '')
        + (report.noCase ? `\n- ${report.noCase} document(s) had no case and could not be placed in a series.` : '')
        + (report.noOccasion ? `\n- ${report.noOccasion} document(s) had no occasion.` : '')
        + (report.outOfScope ? `\n- ${report.outOfScope} coding(s) of out-of-scope codes were left out.` : '')
        + (report.unknownCode ? `\n- ${report.unknownCode} coding(s) referenced a deleted code.` : ''),
      );
      await app.results.appendTable({
        caption: 'Codings per occasion',
        columns: ['Case', 'Occasion', form.rollup === 'theme' ? 'Theme' : 'Code', 'Codings'],
        rows: columns.case.map((c, i) => [c, columns.occasion[i], columns.measure[i], columns.count[i]])
          .filter((r) => r[3] > 0)
          .slice(0, 30),
      });
      await app.results.endAnalysis();
    }

    /** Shape C: one row per pair of codes that occur together. */
    async function quantitisePairs() {
      const form = await app.ui.showForm({
        title: 'Quantitise codings — which codes occur together',
        hint: 'An edge list: one row per pair, with the two codes in the first two columns — '
          + 'which is what Network analysis reads as From and To.',
        okLabel: 'Create dataset',
        fields: [
          {
            name: 'rule', type: 'select', label: 'Two codes occur together when', value: 'document',
            hint: 'Sharing a document is the looser claim and needs nothing; overlapping passages is '
              + 'the stricter one and needs positions, so it only sees text codings.',
            options: [
              { value: 'document', label: 'They appear in the same document' },
              { value: 'overlap', label: 'Their passages overlap' },
            ],
          },
          {
            name: 'rollup', type: 'select', label: 'Nodes are', value: 'code',
            options: [{ value: 'code', label: 'Codes' }, { value: 'theme', label: 'Themes' }],
          },
          {
            name: 'scope', type: 'select', label: 'Codes from', value: 'book',
            options: [
              { value: 'book', label: 'The open codebook' },
              { value: 'all', label: 'Every codebook in the project' },
            ],
          },
        ],
      });
      if (!form) return;
      const { variables, columns, report } = cooccurrenceEdges({
        docs: docRows(),
        segments: state.segments,
        codes: state.codes,
        bookId: state.codebookId,
        scope: form.scope,
        rollup: form.rollup,
        rule: form.rule,
      });
      if (!report.nRows) {
        app.results.appendError(
          form.rule === 'overlap'
            ? 'No two codings overlap, so there are no pairs. Coders often highlight adjacent rather '
              + 'than overlapping passages — try "the same document" instead.'
            : 'No two codes share a document, so there are no pairs to put in a network.',
        );
        return;
      }

      const noun = form.rollup === 'theme' ? 'themes' : 'codes';
      const name = `Codings — ${noun} that occur together`;
      await app.data.create({ name, variables, columns, activate: false });
      await app.results.beginAnalysis('Quantitise codings');
      await app.results.appendText(
        `**Dataset created: ${name}.** ${report.nRows} pair${report.nRows === 1 ? '' : 's'} among `
        + `${report.nNodes} ${noun}. Switch to it in the Data tab and run **Multivariate ▸ Network `
        + 'analysis (edge list)** with `code_a` as From and `code_b` as To.',
      );
      await app.results.appendText(
        '**How these pairs were made:**\n\n'
        + `- **Together means:** ${form.rule === 'overlap' ? 'their passages overlap' : 'they appear in the same document'}.\n`
        + '- **`jaccard` is over DOCUMENTS either way** — both ÷ either — because that is the only '
        + 'denominator here that is a set union; an overlap version would need one nobody agrees on. '
        + 'Comparing the two count columns is itself informative: codes that share documents but never '
        + 'overlap are discussed in the same interview, not in the same breath.\n'
        + '- **The network has no weights.** Network analysis reads only the two code columns, so every '
        + 'pair is one tie regardless of how often it occurs. To threshold, use Transform ▸ Select cases '
        + 'on `docs_both` or `jaccard` first — that choice is yours to make and state.'
        + (report.isolated.length
          ? `\n- **${report.isolated.length} ${noun} occur with nothing** and so are absent from the `
            + `network rather than sitting in it as isolates: ${report.isolated.slice(0, 8).join(', ')}`
            + `${report.isolated.length > 8 ? ', …' : ''}. A density or centrality figure is computed `
            + 'over the codes that are present.'
          : '')
        + (report.unused.length
          ? `\n- ${report.unused.length} ${noun} in the codebook have not been applied to anything yet, `
            + 'which is why they are not here either — a different fact from occurring with nothing.'
          : '')
        + (report.selfPairs
          ? `\n- ${report.selfPairs} overlapping pair(s) were of one ${form.rollup === 'theme' ? 'theme' : 'code'} `
            + 'with itself and are left out — that is not a tie.'
          : '')
        + (report.unpositioned && form.rule === 'overlap'
          ? `\n- ${report.unpositioned} coding(s) had no position to compare, so they can overlap nothing. `
            + 'Positions are resolved from the anchor, and a quote that no longer matches its document has none.'
          : '')
        + (report.outOfScope ? `\n- ${report.outOfScope} coding(s) of out-of-scope codes were left out.` : ''),
      );
      await app.results.appendTable({
        caption: 'Strongest pairs',
        columns: [form.rollup === 'theme' ? 'Theme' : 'Code', 'with', 'Documents', 'Jaccard', 'Overlaps'],
        rows: columns.code_a
          .map((a, i) => [a, columns.code_b[i], columns.docs_both[i], columns.jaccard[i], columns.overlaps[i]])
          .sort((x, y) => y[3] - x[3] || y[2] - x[2])
          .slice(0, 20),
      });
      await app.results.endAnalysis();
    }

    /** Shape B: one row per coding. */
    async function quantitiseSegments() {
      const form = await app.ui.showForm({
        title: 'Quantitise codings — a row per passage',
        hint: 'One row per coding, with its text, coder, modality, position and the order it comes in. '
          + 'The document attributes repeat down its codings, which is what lets a code be crosstabbed '
          + 'against one.',
        okLabel: 'Create dataset',
        fields: [
          {
            name: 'scope', type: 'select', label: 'Codes from', value: 'book',
            options: [
              { value: 'book', label: 'The open codebook' },
              { value: 'all', label: 'Every codebook in the project' },
            ],
          },
          {
            name: 'carry', type: 'select', label: 'Carry across', value: 'all',
            hint: 'The attributes to crosstab the codes against — they are the other columns of the document’s own row.',
            options: [
              { value: 'all', label: 'Every other column of the source' },
              { value: 'label', label: 'Just the document label' },
              { value: 'none', label: 'Nothing' },
            ],
          },
        ],
      });
      if (!form) return;
      const { variables, columns, report } = codingTable({
        docs: docRows(),
        segments: state.segments,
        codes: state.codes,
        bookId: state.codebookId,
        scope: form.scope,
        attrs: await carriedAttrs(form.carry),
        labelColumn: state.labelColumn,
      });
      if (!report.nRows) { app.results.appendError('No codings in scope — nothing to put in a table.'); return; }

      const name = 'Codings — one row per passage';
      await app.data.create({ name, variables, columns, activate: false });
      await app.results.beginAnalysis('Quantitise codings');
      await app.results.appendText(
        `**Dataset created: ${name}.** ${report.nRows} coding${report.nRows === 1 ? '' : 's'} across `
        + `${report.nDocs} document${report.nDocs === 1 ? '' : 's'}. Switch to it in the Data tab — `
        + '`code` and `theme` are categorical, so Crosstabs and Correspondence analysis will offer them, '
        + 'and `text` is the column for Text analytics.',
      );
      await app.results.appendText(
        '**How to read it:**\n\n'
        + '- **The unit is the coding, not the participant.** A document with eleven codings '
        + 'contributes eleven rows, so a test run on this table is a test about passages. For a '
        + 'test about people, quantitise by document instead.\n'
        + `- **Positions are resolved, not stored** — ${report.nResolved} of ${report.nRows} `
        + 'coding(s) have character offsets. The rest are media codings, which have times instead, '
        + 'or quotes that no longer match their document; both say so in `status` rather than '
        + 'guessing a position.\n'
        + `- **\`seq\`** numbers the codings in the order they occur within each document.\n`
        + `- **Scope:** codes from ${form.scope === 'all' ? 'every codebook' : 'the open codebook'}`
        + `${report.outOfScope ? `, leaving out ${report.outOfScope} coding(s) of out-of-scope codes` : ''}.`
        + (report.unknownCode ? `\n- ${report.unknownCode} coding(s) referenced a deleted code and were dropped.` : '')
        + (report.offDoc ? `\n- ${report.offDoc} coding(s) pointed at rows outside the loaded ${MAX_DOCS} and were dropped.` : ''),
      );
      await app.results.appendTable({
        caption: 'What is in the table',
        columns: ['Kind of coding', 'Rows'],
        rows: Object.entries(report.modalities).map(([k, v]) => [k, v])
          .concat([['Coders', report.coders.join(', ')]]),
      });
      await app.results.endAnalysis();
    }

    // Quantitising: the bridge to the statistics menu (shape A of the plan in TODO.md).
    // A dataset rather than a cross-plugin call, because a document IS a dataset row —
    // so the respondent attributes are already beside it — and because the five
    // judgements below have to land in the log where they can be audited.
    quantBtn.addEventListener('click', async () => {
      if (!state.textColumn) { app.results.appendError('Choose a documents column first.'); return; }
      if (!state.segments.length) { app.results.appendError('No codings yet — code some passages first.'); return; }

      // The SHAPE is asked first, in its own step, because the options that follow only
      // make sense once it is known: `values`/`rollup`/`coders` belong to the case table
      // and mean nothing for a segment list. `showForm` cannot hide a field, so the
      // alternative was one dialog of seven selects, most of them inert — or a toolbar
      // button per shape, which is how a toolbar grows a button every time the feature
      // does. Two small questions beat both.
      const shapePick = await app.ui.showForm({
        title: 'Quantitise codings',
        hint: 'Coded data as a dataset, so the statistics menu can analyse it. Which unit of analysis?',
        okLabel: 'Next…',
        fields: [{
          name: 'shape', type: 'select', label: 'One row per', value: 'case',
          options: [
            { value: 'case', label: 'Document — a column per code (crosstabs, regression, latent class)' },
            { value: 'segment', label: 'Coding — a row per passage (text analytics, correspondence, multilevel)' },
            { value: 'pair', label: 'Pair of codes — which codes occur together (network analysis)' },
            { value: 'occasion', label: 'Case and occasion — a series across repeated documents (single-case designs, counts over time)' },
          ],
        }],
      });
      if (!shapePick) return;
      if (shapePick.shape === 'segment') { await quantitiseSegments(); return; }
      if (shapePick.shape === 'pair') { await quantitisePairs(); return; }
      if (shapePick.shape === 'occasion') { await quantitiseOccasions(); return; }

      const form = await app.ui.showForm({
        title: 'Quantitise codings — a column per code',
        hint: 'One row per document, one column per code. Every choice here is reported with the result, '
          + 'because each is a judgement about the coding rather than a fact in it.',
        okLabel: 'Create dataset',
        fields: [
          {
            name: 'values', type: 'select', label: 'Cell values',
            hint: 'Presence is what papers report ("8 of 12 participants raised cost"); a count also measures how much each person talked.',
            value: 'presence',
            options: [
              { value: 'presence', label: 'Present / absent (0-1)' },
              { value: 'count', label: 'Number of codings' },
            ],
          },
          {
            name: 'rollup', type: 'select', label: 'A column per', value: 'code',
            options: [{ value: 'code', label: 'Code' }, { value: 'theme', label: 'Theme' }],
          },
          {
            name: 'coders', type: 'select', label: 'Coders', value: 'pool',
            hint: 'Separate columns make Scale ▸ Inter-rater agreement usable on this dataset.',
            options: [
              { value: 'pool', label: 'All coders together' },
              { value: 'coder', label: 'A column per coder' },
            ],
          },
          {
            name: 'scope', type: 'select', label: 'Codes from', value: 'book',
            options: [
              { value: 'book', label: 'The open codebook' },
              { value: 'all', label: 'Every codebook in the project' },
            ],
          },
          {
            name: 'carry', type: 'select', label: 'Carry across', value: 'all',
            hint: 'The attributes to crosstab the codes against — they are the other columns of the document’s own row.',
            options: [
              { value: 'all', label: 'Every other column of the source' },
              { value: 'label', label: 'Just the document label' },
              { value: 'none', label: 'Nothing' },
            ],
          },
        ],
      });
      if (!form) return;

      const { variables, columns, report } = quantitiseCodings({
        docs: docRows(),
        segments: state.segments,
        codes: state.codes,
        bookId: state.codebookId,
        values: form.values,
        rollup: form.rollup,
        coders: form.coders,
        scope: form.scope,
        attrs: await carriedAttrs(form.carry),
        labelColumn: state.labelColumn,
      });

      if (!report.items.length) { app.results.appendError('No codes in scope — nothing to quantitise.'); return; }

      const name = `Codings — ${form.rollup === 'theme' ? 'themes' : 'codes'} by document`;
      // NOT activated: switching the active dataset would remount this workspace onto a
      // dataset with no codings in it, which is a strange reward for pressing a button
      // in the coding tab. The result says where it went instead.
      await app.data.create({ name, variables, columns, activate: false });

      await app.results.beginAnalysis('Quantitise codings');
      await app.results.appendText(
        `**Dataset created: ${name}.** ${report.nRows} document${report.nRows === 1 ? '' : 's'} × `
        + `${report.items.length} ${form.rollup === 'theme' ? 'theme' : 'code'} column`
        + `${report.items.length === 1 ? '' : 's'}, from ${report.nUsed} coding`
        + `${report.nUsed === 1 ? '' : 's'}. Switch to it in the Data tab to analyse it — `
        + 'the code columns are categorical, so Crosstabs will offer them.',
      );
      await app.results.appendText(
        '**How this was counted**, because each of these is a judgement and the table '
        + 'cannot be read without them:\n\n'
        + `- **Unit:** one row per document${report.nDocs > report.nRows ? ` (${report.nDocs - report.nRows} empty row(s) excluded — a blank row is not a document that stayed silent)` : ''}.\n`
        + `- **Values:** ${form.values === 'count' ? 'the number of codings — which also measures how much each participant talked, and how finely the coder highlights' : 'present or absent — not how often, because a raw count is confounded by transcript length and coding style'}.\n`
        + `- **Rollup:** one column per ${form.rollup === 'theme' ? 'theme (the code’s group)' : 'code'}.\n`
        + `- **Coders:** ${form.coders === 'coder' ? `one column each for ${report.coders.join(', ')}` : 'pooled — a passage coded by two people counts once for presence, twice for a count'}.\n`
        + `- **Scope:** codes from ${form.scope === 'all' ? 'every codebook' : 'the open codebook'}`
        + `${report.outOfScope ? `, so ${report.outOfScope} coding(s) of out-of-scope codes were left out` : ''}.\n`
        + '- **Drift:** unresolved and drifted codings are **included** — a coding belongs to '
        + 'its row because it anchors to a row id, not to a position, so a quote that no '
        + 'longer matches still counts for the right document.'
        + (report.unknownCode ? `\n- ${report.unknownCode} coding(s) referenced a deleted code and were dropped.` : '')
        + (report.offDoc ? `\n- ${report.offDoc} coding(s) pointed at rows outside the loaded ${MAX_DOCS} and were dropped.` : ''),
      );
      await app.results.appendTable({
        caption: form.values === 'count' ? 'Codings per column' : 'Prevalence',
        columns: [form.rollup === 'theme' ? 'Theme' : 'Code', 'Variable', 'Documents', '%', 'Codings'],
        rows: report.items.map((it) => [
          it.label, it.name, it.present,
          report.nRows ? `${((it.present / report.nRows) * 100).toFixed(1)}%` : '—',
          it.total,
        ]),
      });
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
    async function resolvePendingImport() {
      const pending = state.pendingImport;
      if (!pending) return;
      const have = new Set(state.codes.map((c) => c.id));
      const { codes, segments, dropped } = await resolveImportedCodings(pending, docs, have, {
        targetFor: (doc) => docTarget(dsId, state.textColumn, doc.rid),
        textRef: (text, a, b) => app.anchors.text(text, a, b),
        mediaRef: (sel, assetId) => app.anchors.media(sel, assetId),
      });
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
      // Which document the user was reading. A reload now happens on every data change,
      // not only on a dataset switch, so dropping this would throw the reader back to the
      // first transcript every time they fixed a typo. Restored below only if it still
      // exists — on a real dataset switch it will not, and the fallback applies.
      const wasReading = activeRid;
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
      if (wasReading && docs.some((d) => d.rid === wasReading)) activeRid = wasReading;
      if (state.pendingImport) await resolvePendingImport();
      renderAll();
    };

    // --- go ------------------------------------------------------------------
    await loadDocs();
    if (state.pendingImport) await resolvePendingImport();
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
    for (const w of tokenize(s.quote || '', 3)) {
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
    // Shadow the STORED shape, not the in-memory one: a segment's span is derived per
    // session, so shadowing it would make every load look like a pending change.
    segments: new Map((state.segments ?? []).map((x) => [x.id, clone({ id: x.id, ...persistableSegment(x) })])),
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

// =====================================================================
// Anchoring (#166)
// =====================================================================
//
// A coding used to say where it sat: `{doc, start, end}`, two integers into a cell's
// text. Editing that cell moved every coding after the edit point and nothing noticed —
// the highlight simply covered different words, confidently and silently.
//
// It now says what it REFERS TO. `anchor` is a host anchor (core/anchors.js): the cell's
// op-log target plus selectors describing the region inside it, quote first and position
// second. The quote is the truth; the position is a cache.
//
// `start`/`end` still exist on the in-memory segment, and every render path still reads
// them — but they are now DERIVED, filled in by {@link resolveDocSegments} from the
// anchor against the text as it is right now, and never persisted. That is what makes
// "position is a cache" literal rather than a slogan: the cache lives for the length of a
// session and is recomputed from the anchor every time the document is loaded.
//
// Resolution NEVER writes. It runs on render, and a drifted coding is reported rather
// than repaired — repairing on read would turn opening the tab into an edit, which is the
// mount-must-never-write rule this plugin already learned the hard way.

/** Fields that exist only for this session — derived from the anchor, never persisted. */
const DERIVED = ['start', 'end', 'status', 'reason'];

/** A segment record as it is STORED: the reference, not the position. */
export function persistableSegment(seg) {
  const out = {};
  for (const [k, v] of Object.entries(seg)) {
    if (k === 'id' || DERIVED.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The label a coding shows in History and the sidebar — its own words, truncated. Kept
 * beside the anchor and written by the SAME helper, so the two can never disagree about
 * what the coding says (the field-ownership trap #166 flagged). */
export function quoteOf(anchor, fallback = '') {
  const q = (anchor?.ref?.selectors ?? []).find((x) => x.kind === 'text-quote');
  const text = q?.exact ?? fallback;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** The op-log address of the cell a document lives in — byte-identical to what `setCell`
 * writes, which is what lets the host derive this coding's `reads[]` from it. */
export function docTarget(dsId, column, rid) {
  return `ds:${dsId}/cell:${column}:${rid}`;
}

/**
 * Resolve every coding on one document against its CURRENT content, writing the derived
 * span onto each in-memory segment. One host round trip per document, not per coding.
 *
 * Returns a summary of what needs the user's attention, so the caller can say so without
 * walking the segments again.
 */
export async function resolveDocSegments(app, doc, segs, ctx) {
  if (!segs.length) return { drifted: 0, orphaned: 0 };
  const subject = doc.kind === 'media'
    ? { kind: 'media', assetId: doc.refs?.[0] ?? null, duration: ctx?.duration }
    : { kind: 'text', text: doc.text ?? '' };
  let results;
  try {
    // The REF is what resolves — the anchor's target says which cell, its ref says where
    // inside it. Passing the whole anchor makes every coding unresolvable, silently.
    results = await app.anchors.resolve(segs.map((s) => s.anchor?.ref ?? null), subject);
  } catch (e) {
    console.warn('[caqdas] anchor resolve failed', e);
    return { drifted: 0, orphaned: 0 };
  }
  let drifted = 0;
  let orphaned = 0;
  segs.forEach((seg, i) => {
    const r = results[i] ?? { status: 'unresolvable' };
    seg.status = r.status;
    seg.reason = r.reason ?? null;
    // An orphan has no position at all. Leaving the old numbers would put a highlight
    // somewhere arbitrary, which is the exact failure this design exists to remove.
    seg.start = typeof r.start === 'number' ? r.start : null;
    seg.end = typeof r.end === 'number' ? r.end : null;
    if (r.status === 'orphaned' || r.status === 'unresolvable') orphaned++;
    else if (r.status === 'drifted' || r.status === 'ambiguous') drifted++;
  });
  return { drifted, orphaned };
}

/** Is this coding safe to draw where it says it is? */
const isPlaced = (s) => typeof s.start === 'number' && typeof s.end === 'number';

/** Does this coding want the user told something about it? */
const isUnsure = (s) => s.status && s.status !== 'exact' && s.status !== 'moved';

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

/**
 * The fields that actually changed on one record, or null if nothing did.
 *
 * `putItem` shallow-MERGES its fields, so writing only the delta is not a micro-
 * optimisation — it is what lets two coders edit one coding and both survive. Sending the
 * whole record (what this used to do) made every field collide, so a boundary adjustment
 * and a code change on the same coding fought, and HLC order silently discarded one. In
 * the plugin whose per-coder records exist precisely to stop a coder's work being thrown
 * away, that was the wrong default.
 *
 * A field that has gone away is written as `null` rather than omitted: the merge cannot
 * tell an absent key from an unmentioned one, so removal has to be said out loud.
 */
export function fieldDelta(prev, next) {
  const delta = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === 'id') continue;
    if (!prev || !same(prev[k], v)) delta[k] = v;
  }
  for (const k of Object.keys(prev ?? {})) {
    if (k !== 'id' && !(k in next)) delta[k] = null;
  }
  return Object.keys(delta).length ? delta : null;
}

/** Write whatever actually changed: one narrow op per changed record, plus the config. */
async function syncState(app, state) {
  // Config (small, identity-free) stays a blob — but strip the collections out of it so
  // the same data never lives in two places.
  const { codebooks, codes, segments, memos, ...cfg } = state;
  await app.state.set(cfg);

  for (const [collection, arr] of [['codebooks', codebooks ?? []], ['codes', codes ?? []], ['segments', segments ?? []]]) {
    // Segments carry derived spans for the session; only the reference is stored.
    const shape = collection === 'segments'
      ? (x) => ({ id: x.id, ...persistableSegment(x) })
      : (x) => x;
    const now = new Map(arr.filter((x) => x && x.id).map((x) => [x.id, shape(x)]));
    for (const [id, val] of now) {
      const delta = fieldDelta(persisted[collection].get(id), val);
      if (!delta) continue;
      await app.items.put(collection, id, delta);
      // Re-clone only what moved. The old code re-cloned the WHOLE collection on every
      // save, which is why nudging one boundary cost 106ms across a 25k-coding corpus —
      // measured, not guessed (scripts/log-stress.mjs).
      persisted[collection].set(id, clone(val));
    }
    for (const id of [...persisted[collection].keys()]) {
      if (!now.has(id)) {
        await app.items.remove(collection, id);
        persisted[collection].delete(id);
      }
    }
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
 * Export the ACTIVE codebook as CSV — `name,theme,colour`, the same three columns
 * {@link parseCodeList} reads back, so a codebook exported from one project imports
 * cleanly into another.
 *
 * Runs in the compute frame, which can only READ item records. That is sufficient here
 * and is why the matching import cannot live beside it.
 */
export async function exportCodebookCsv(app) {
  const cfg = normalize(await app.state.read('caqdas-coding'));
  const codes = (await app.items.list('codes')).map((r) => ({ id: r.id, ...r.fields }));
  const books = (await app.items.list('codebooks')).map((r) => ({ id: r.id, ...r.fields }));
  // Fall back to every code when no book is selected yet — exporting nothing because a
  // config blob was missing would look like data loss.
  const bookId = cfg.codebookId && books.some((b) => b.id === cfg.codebookId) ? cfg.codebookId : null;
  const mine = bookId ? codes.filter((c) => c.codebookId === bookId) : codes;
  const name = books.find((b) => b.id === bookId)?.name || 'codebook';
  return {
    filename: `${String(name).replace(/[^\w -]+/g, '').trim() || 'codebook'}.csv`,
    mimeType: 'text/csv',
    data: new TextEncoder().encode(codebookToCsv(mine)),
  };
}

/**
 * Import codes from a CSV/TSV file into the active codebook.
 *
 * A TOOLBAR verb, not an import verb, and that is forced rather than chosen: toolbar
 * verbs are invoked on the WORKSPACE frame's broker (core/workspace-manager.js), which
 * is the only place with a writable `items` bridge. It still gets a real file picker via
 * `needsFile`, so this is a genuine file import and not a paste box.
 *
 * Names already in the book are skipped, so re-importing a codebook sheet as it grows
 * adds only what is new.
 */
export async function importCodebookCsv(app, args = {}) {
  const file = args.__file;
  if (!file || !file.bytes) return { ok: false, message: 'No file was supplied.' };
  const text = new TextDecoder().decode(file.bytes);

  const cfg = normalize(await app.state.get());
  const books = (await app.items.list('codebooks')).map((r) => ({ id: r.id, ...r.fields }));
  const codes = (await app.items.list('codes')).map((r) => ({ id: r.id, ...r.fields }));

  // Land in the active book, creating one if this project has none yet — the same
  // bootstrap the mount does, because an import can be the very first thing that happens.
  let bookId = cfg.codebookId && books.some((b) => b.id === cfg.codebookId) ? cfg.codebookId : books[0]?.id;
  if (!bookId) {
    bookId = await app.items.put('codebooks', null, { name: 'Codebook' });
    await app.state.set({ ...cfg, codebookId: bookId });
  }

  const mine = codes.filter((c) => c.codebookId === bookId);
  const existing = new Set(mine.map((c) => String(c.name).toLowerCase()));
  const parsed = parseCodeList(text, existing);
  if (!parsed.length) {
    return { ok: true, message: 'Nothing to import — every code was already in this codebook.' };
  }
  for (let i = 0; i < parsed.length; i++) {
    const pc = parsed[i];
    await app.items.put('codes', null, {
      name: pc.name,
      color: pc.color || PALETTE[(mine.length + i) % PALETTE.length],
      group: pc.group,
      memo: '',
      codebookId: bookId,
    });
  }
  // The mount holds its own copy of state and a diff shadow, so it has to reload or its
  // next save would treat these as deletions.
  return { ok: true, refresh: 'workspace', message: `Imported ${parsed.length} code(s).` };
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
export async function resolveImportedCodings(pending, docs, haveCodeIds = new Set(), ctx = {}) {
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
    // An imported coding arrives as raw offsets into a foreign document, which is exactly
    // the fragile shape this design replaced. Convert at the boundary: quote the text the
    // offsets point at NOW, so an import lands as a proper content anchor and inherits
    // every guarantee a locally-made coding has. Anchors are built from `ctx.anchor` (the
    // host's builders) when available; without them the coding still imports, carrying a
    // position-only anchor that reports itself as unverifiable rather than pretending.
    const target = ctx.targetFor ? ctx.targetFor(doc) : null;
    const wrap = (ref) => (target && ref ? { kind: 'cell', target, ref } : undefined);
    if (pc.type === 'text') {
      const start = pc.data.start | 0;
      const end = pc.data.end | 0;
      const full = doc.kind === 'text' ? String(doc.text || '') : '';
      const quote = full.slice(start, end);
      const ref = ctx.textRef
        ? await ctx.textRef(full, start, end)
        : { selectors: [{ kind: 'text-position', start, end }] };
      out.segments.push({ doc: doc.rid, codeId: pc.codeId, anchor: wrap(ref), quote, memo });
    } else if (pc.type === 'region') {
      const g = pc.data;
      const box = { x: round4(g.x), y: round4(g.y), w: round4(g.w), h: round4(g.h) };
      const ref = ctx.mediaRef
        ? await ctx.mediaRef({ kind: 'rect', ...box }, doc.refs?.[0] ?? null)
        : { selectors: [{ kind: 'rect', ...box }] };
      out.segments.push({ doc: doc.rid, codeId: pc.codeId, region: box, anchor: wrap(ref), quote: regionLabel(g), memo });
    } else if (pc.type === 'time') {
      const tStart = round3(pc.data.tStart);
      const tEnd = round3(pc.data.tEnd);
      const ref = ctx.mediaRef
        ? await ctx.mediaRef({ kind: 'time-span', tStart, tEnd }, doc.refs?.[0] ?? null)
        : { selectors: [{ kind: 'time-span', tStart, tEnd }] };
      out.segments.push({ doc: doc.rid, codeId: pc.codeId, tStart, tEnd, anchor: wrap(ref), quote: timeLabel(pc.data.tStart, pc.data.tEnd), memo });
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
/**
 * The active codebook's codes, **in codebook order**.
 *
 * Order is load-bearing here, not cosmetic: "codebook order = layer order" decides which
 * code's colour wins where two highlights overlap. It used to be whatever order records
 * came back in — incidental, unrepresented, and impossible to preserve through a
 * promote/add round trip.
 *
 * Each code now carries a fractional `sort` key. A per-record float is the shape that
 * suits this log: `putItem` field-merges, so moving one code writes one field on one
 * record and two peers reordering concurrently both survive, where a whole-list reorder
 * op would have to be merged wholesale. Codes with no key yet fall to the end in name
 * order, so an unsorted book still reads sensibly.
 */
function codesInBook(state) {
  return state.codes
    .filter((c) => c.codebookId === state.codebookId)
    .sort(byCodeOrder);
}

// =============================================================================
// Quantitising: coded data as a dataset
// =============================================================================

/**
 * Turn the codings into a **segment table** — shape B: one row per coding.
 *
 * Shape A asks "did this case raise the theme"; this asks about the codings themselves.
 * The unit is the passage, so it carries the things a passage has and a case does not:
 * who coded it, what modality it is, where it sits, how long it is, and its own text.
 *
 * ## What it is for
 *
 * - **Correspondence analysis** and crosstabs of `code` against a carried attribute —
 *   both take two category VARIABLES and tabulate internally, so a long table is what
 *   they want, not a matrix.
 * - **Text analytics** on the `text` column: the words inside everything coded X.
 * - **Multilevel models** with `doc_rid` as the cluster — codings are nested in
 *   documents, and treating them as independent overstates the evidence.
 * - **Sequence work** via `seq`, which numbers the codings in the order they occur
 *   WITHIN each document. Nothing in CrossTab does lag-sequential analysis yet; this is
 *   the column it would need, and the order is a fact about the data either way.
 *
 * ## Why this is not "Segments → Output" again
 *
 * That button writes a five-column table you read. This writes a dataset you analyse,
 * and it is the same distinction as Code frequency beside shape A: a report answers a
 * question, a dataset lets you ask one. The columns bear it out — coder, modality,
 * times, offsets, resolution status, sequence and the carried attributes are all absent
 * from the readable version, because a reader does not want them.
 *
 * ## Offsets are the one thing that needs the workspace
 *
 * `char_start`/`char_end`/`status` are not stored: they are the RESOLUTION of an anchor
 * against the text as it is now (see `persistableSegment`). This function therefore
 * reads them off the live session objects, where `resolveAllDocs` has already put them,
 * and leaves them null where a coding did not resolve — rather than inventing a position
 * or dropping the row. `exportQdpx` drops unresolvable codings because a QDPX file has
 * nowhere to say "somewhere in this document"; a dataset column can simply say nothing.
 *
 * Pure, like the others, so the column contract is testable without a DOM.
 *
 * @param {object} arg see {@link quantitiseCodings} for `docs`, `segments`, `codes`,
 *   `bookId`, `scope`, `attrs` and `labelColumn` — identical in meaning.
 * @returns {{variables: object[], columns: Object<string, any[]>,
 *            report: {nRows: number, nCodings: number, nDocs: number, nResolved: number,
 *                     modalities: Object<string, number>, coders: string[],
 *                     outOfScope: number, unknownCode: number, offDoc: number}}}
 */
export function codingTable({
  docs = [], segments = [], codes = [], bookId = null, scope = 'book',
  attrs = [], labelColumn = null,
}) {
  const codeById = new Map((codes ?? []).map((c) => [c.id, c]));
  const inScope = (c) => scope === 'all' || !bookId || c.codebookId === bookId;
  const rows = (docs ?? []).filter((d) => d.isDoc);
  const rowAt = new Map(rows.map((d, i) => [d.rid, i]));

  const tally = { unknownCode: 0, outOfScope: 0, offDoc: 0 };
  const used = [];
  for (const s of segments ?? []) {
    const code = codeById.get(s.codeId);
    if (!code) { tally.unknownCode += 1; continue; }
    if (!inScope(code)) { tally.outOfScope += 1; continue; }
    if (!rowAt.has(String(s.doc))) { tally.offDoc += 1; continue; }
    used.push({ seg: s, code, at: rowAt.get(String(s.doc)) });
  }

  // Document order, then position within the document — which is what makes `seq` mean
  // anything. A coding with no position sorts last within its document rather than
  // first, because an unresolved quote is not evidence that it came at the start.
  const posOf = ({ seg }) => {
    const n = typeof seg.start === 'number' ? seg.start
      : typeof seg.tStart === 'number' ? seg.tStart : null;
    return n == null ? Number.POSITIVE_INFINITY : n;
  };
  used.sort((a, b) => a.at - b.at || posOf(a) - posOf(b));

  const out = {
    document: [], doc_rid: [], seq: [], theme: [], code: [], coder: [],
    modality: [], text: [], chars: [], t_start: [], t_end: [],
    char_start: [], char_end: [], status: [],
  };
  const report = {
    nRows: used.length,
    nCodings: (segments ?? []).length,
    nDocs: new Set(used.map((u) => u.at)).size,
    nResolved: 0,
    modalities: {},
    coders: [],
    ...tally,
  };
  const coders = new Set();
  let seqAt = -1;
  let seqN = 0;
  for (const { seg, code, at } of used) {
    if (at !== seqAt) { seqAt = at; seqN = 0; }
    seqN += 1;
    const d = rows[at];
    const quote = quotedText(seg);
    const mode = modalityOf(seg);
    const who = coderName(seg) || UNATTRIBUTED;
    coders.add(who);
    report.modalities[mode] = (report.modalities[mode] ?? 0) + 1;
    if (typeof seg.start === 'number') report.nResolved += 1;
    out.document.push(d.label || `Doc ${at + 1}`);
    out.doc_rid.push(d.rid);
    out.seq.push(seqN);
    out.theme.push(cleanName(code.group, { max: 120 }) || UNTHEMED);
    out.code.push(cleanName(code.name, { max: 120, fallback: code.id }));
    out.coder.push(who);
    out.modality.push(mode);
    out.text.push(quote);
    out.chars.push(quote.length);
    out.t_start.push(typeof seg.tStart === 'number' ? seg.tStart : null);
    out.t_end.push(typeof seg.tEnd === 'number' ? seg.tEnd : null);
    out.char_start.push(typeof seg.start === 'number' ? seg.start : null);
    out.char_end.push(typeof seg.end === 'number' ? seg.end : null);
    // `status` is session state and absent on a coding that was never resolved — for a
    // media coding there is nothing to resolve, so it says so rather than claiming
    // 'exact' on the strength of a default.
    out.status.push(typeof seg.status === 'string' ? seg.status : 'unresolved');
  }
  report.coders = [...coders].sort();

  const variables = [
    { name: 'document', type: 'string', measurementLevel: 'nominal', label: labelColumn || 'Document' },
    { name: 'doc_rid', type: 'string', measurementLevel: 'nominal', label: 'Source row id' },
    { name: 'seq', type: 'numeric', measurementLevel: 'scale', label: 'Order within the document' },
    // Theme and code are STRINGS rather than factors: a code is an open set that grows
    // as coding proceeds, and Crosstabs takes string as happily as factor.
    { name: 'theme', type: 'string', measurementLevel: 'nominal', label: 'Theme' },
    { name: 'code', type: 'string', measurementLevel: 'nominal', label: 'Code' },
    { name: 'coder', type: 'string', measurementLevel: 'nominal', label: 'Coder' },
    { name: 'modality', type: 'string', measurementLevel: 'nominal', label: 'Kind of coding' },
    { name: 'text', type: 'string', measurementLevel: 'nominal', label: 'Coded text' },
    { name: 'chars', type: 'numeric', measurementLevel: 'scale', label: 'Length (characters)' },
    { name: 't_start', type: 'numeric', measurementLevel: 'scale', label: 'Start (seconds)' },
    { name: 't_end', type: 'numeric', measurementLevel: 'scale', label: 'End (seconds)' },
    { name: 'char_start', type: 'numeric', measurementLevel: 'scale', label: 'Start (character)' },
    { name: 'char_end', type: 'numeric', measurementLevel: 'scale', label: 'End (character)' },
    { name: 'status', type: 'string', measurementLevel: 'nominal', label: 'Anchor resolution' },
  ];

  // Attributes are per DOCUMENT and this table is per coding, so they repeat down the
  // rows of a document. That repetition is the point — it is what lets `code` be
  // crosstabbed against `site` — but it also means a test of an attribute here is a
  // test of codings, not of participants, and the report says so.
  const taken = new Set(variables.map((v) => v.name));
  // `attrs` are aligned to the ORIGINAL doc list, which includes the rows this table
  // excludes — so the lookup is by rid, built once rather than searched per coding.
  const origAt = new Map((docs ?? []).map((d, i) => [d.rid, i]));
  for (const a of attrs ?? []) {
    const m = a?.meta ?? {};
    if (!m.name) continue;
    const name = uniqueName(m.name, taken, { start: 2 });
    taken.add(name);
    variables.push({
      name, type: m.type || 'string', label: m.label || m.name,
      valueLabels: m.valueLabels, measurementLevel: m.measurementLevel,
    });
    out[name] = used.map(({ at }) => (a.values ?? [])[origAt.get(rows[at].rid)] ?? null);
  }

  return { variables, columns: out, report };
}

/** The full coded text, from the anchor's own quote selector — see {@link quotedLength}. */
function quotedText(seg) {
  const sel = (seg?.anchor?.ref?.selectors ?? []).find((x) => x?.kind === 'text-quote');
  return typeof sel?.exact === 'string' ? sel.exact : '';
}

/**
 * What kind of coding this is, read from the anchor's selector rather than from which
 * fields happen to be set — the selector kind IS the modality, and the plugin already
 * writes exactly one per coding.
 */
function modalityOf(seg) {
  const kinds = (seg?.anchor?.ref?.selectors ?? []).map((x) => x?.kind);
  if (kinds.includes('text-quote')) return 'Text';
  if (kinds.includes('rect-track')) return 'Region over time';
  if (kinds.includes('rect')) return 'Image region';
  if (kinds.includes('time-span')) return 'Time span';
  return 'Unknown';
}

/**
 * Turn the codings into a **co-occurrence edge list** — shape C: one row per pair of
 * codes that occur together.
 *
 * ## Why an edge list and not a matrix
 *
 * Because that is what `builtin-sna` eats: two columns naming each tie's endpoints. A
 * square code x code matrix would have to be unpivoted by hand before anything could
 * read it, and the long form is also what Crosstabs and a sorted table want. The same
 * reasoning as shape B: a long table is the portable shape.
 *
 * ## Two rules, and why "same document" is the default
 *
 * - **`document`** — two codes co-occur if they appear in the same document. Needs no
 *   parameter, works for text and media alike, and is the rule every CAQDAS calls a
 *   code-document co-occurrence. This is what `jaccard` below is computed over.
 * - **`overlap`** — two codings whose passages actually intersect. Closer to what a
 *   reader means by "these two things were said together", and the stricter claim, but
 *   it needs resolved positions (so text codings only, see shape B) and it silently says
 *   nothing about a project where coders highlight adjacent rather than overlapping
 *   spans. The report says how many codings had no position to compare.
 *
 * Both counts are emitted whichever rule is chosen, because they answer different
 * questions and a reader comparing them learns something: codes that share documents but
 * never overlap are discussed in the same interview, not in the same breath. The RULE
 * decides which pairs get a row at all.
 *
 * ## What is NOT in the network
 *
 * A code that never co-occurs with anything has no edge, and an edge list cannot carry
 * it — so it vanishes from the graph rather than appearing as an isolate. That matters
 * for a network measure (density is computed over the nodes present), so the report
 * names those codes and the Output says how many there were.
 *
 * `isolated` and `unused` are kept apart, because they are different findings. A code
 * that was applied and never once sat beside another is a result about the coding. A code
 * nobody has applied yet is a fact about the codebook, and reporting it as "occurs with
 * nothing" would dress the second up as the first.
 *
 * Self-pairs are left out: two codings of the same code in one document is not a tie,
 * and igraph would draw it as a self-loop that distorts degree. Under `theme` rollup that
 * exclusion is doing real work — two different codes of one theme co-occurring would
 * otherwise become a theme tied to itself — so it is counted and reported.
 *
 * Pure, so the pairing rules are testable without a DOM.
 *
 * @param {object} arg see {@link quantitiseCodings} for `docs`, `segments`, `codes`,
 *   `bookId` and `scope`.
 * @param {'code'|'theme'} [arg.rollup='code']
 * @param {'document'|'overlap'} [arg.rule='document']
 * @returns {{variables: object[], columns: Object<string, any[]>,
 *            report: {nRows: number, nNodes: number, isolated: string[],
 *                     selfPairs: number, unpositioned: number, rule: string,
 *                     outOfScope: number, unknownCode: number, offDoc: number}}}
 */
export function cooccurrenceEdges({
  docs = [], segments = [], codes = [], bookId = null, scope = 'book',
  rollup = 'code', rule = 'document',
}) {
  const codeById = new Map((codes ?? []).map((c) => [c.id, c]));
  const inScope = (c) => scope === 'all' || !bookId || c.codebookId === bookId;
  const rows = (docs ?? []).filter((d) => d.isDoc);
  const rowAt = new Map(rows.map((d, i) => [d.rid, i]));

  const tally = { unknownCode: 0, outOfScope: 0, offDoc: 0 };
  const used = [];
  for (const s of segments ?? []) {
    const code = codeById.get(s.codeId);
    if (!code) { tally.unknownCode += 1; continue; }
    if (!inScope(code)) { tally.outOfScope += 1; continue; }
    if (!rowAt.has(String(s.doc))) { tally.offDoc += 1; continue; }
    used.push({ seg: s, at: rowAt.get(String(s.doc)), node: nodeOf(code, rollup) });
  }

  // --- document-level sets, which both counts and `jaccard` rest on -------------
  const docsOf = new Map(); // node -> Set of document indexes
  for (const u of used) {
    if (!docsOf.has(u.node)) docsOf.set(u.node, new Set());
    docsOf.get(u.node).add(u.at);
  }
  // Every node in scope, including ones with no codings: a code that was never applied
  // is not an isolate of the network, it is simply absent, and the two readings differ.
  const nodes = [...new Set((codes ?? []).filter(inScope).map((c) => nodeOf(c, rollup)))].sort();

  // --- overlaps, per document ---------------------------------------------------
  const overlapCount = new Map(); // pairKey -> codings that intersect
  let selfPairs = 0;
  let unpositioned = 0;
  const byDoc = new Map();
  for (const u of used) {
    if (!byDoc.has(u.at)) byDoc.set(u.at, []);
    byDoc.get(u.at).push(u);
  }
  for (const group of byDoc.values()) {
    for (const u of group) if (!spanOf(u.seg)) unpositioned += 1;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const sa = spanOf(a.seg);
        const sb = spanOf(b.seg);
        if (!sa || !sb || sa.unit !== sb.unit) continue;
        if (!(sa.lo < sb.hi && sb.lo < sa.hi)) continue;
        if (a.node === b.node) { selfPairs += 1; continue; }
        const k = pairKey(a.node, b.node);
        overlapCount.set(k, (overlapCount.get(k) ?? 0) + 1);
      }
    }
  }

  // --- assemble the edges -------------------------------------------------------
  const out = { code_a: [], code_b: [], docs_both: [], docs_either: [], jaccard: [], overlaps: [] };
  const report = {
    nRows: 0, nNodes: 0, isolated: [], unused: [], selfPairs, unpositioned, rule, ...tally,
  };
  const linked = new Set();
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const A = docsOf.get(a) ?? new Set();
      const B = docsOf.get(b) ?? new Set();
      let both = 0;
      for (const d of A) if (B.has(d)) both += 1;
      const either = A.size + B.size - both;
      const over = overlapCount.get(pairKey(a, b)) ?? 0;
      const keep = rule === 'overlap' ? over > 0 : both > 0;
      if (!keep) continue;
      linked.add(a);
      linked.add(b);
      out.code_a.push(a);
      out.code_b.push(b);
      out.docs_both.push(both);
      out.docs_either.push(either);
      // Jaccard over DOCUMENTS whichever rule chose the row, because that is the only
      // denominator here that is a set union. An "overlap Jaccard" would need a
      // denominator nobody agrees on, so it is not invented.
      out.jaccard.push(either ? Math.round((both / either) * 1e4) / 1e4 : 0);
      out.overlaps.push(over);
    }
  }
  report.nRows = out.code_a.length;
  report.nNodes = linked.size;
  report.isolated = nodes.filter((n) => !linked.has(n) && docsOf.has(n));
  report.unused = nodes.filter((n) => !docsOf.has(n));

  const variables = [
    // The two columns `builtin-sna` reads as an edge list. Named for what they are to it,
    // not for the codes, so the pairing with "From"/"To" is obvious in its picker.
    { name: 'code_a', type: 'string', measurementLevel: 'nominal', label: rollup === 'theme' ? 'Theme (from)' : 'Code (from)' },
    { name: 'code_b', type: 'string', measurementLevel: 'nominal', label: rollup === 'theme' ? 'Theme (to)' : 'Code (to)' },
    { name: 'docs_both', type: 'numeric', measurementLevel: 'scale', label: 'Documents with both' },
    { name: 'docs_either', type: 'numeric', measurementLevel: 'scale', label: 'Documents with either' },
    { name: 'jaccard', type: 'numeric', measurementLevel: 'scale', label: 'Jaccard (over documents)' },
    { name: 'overlaps', type: 'numeric', measurementLevel: 'scale', label: 'Overlapping passages' },
  ];
  return { variables, columns: out, report };
}

/** The node a code contributes under the chosen rollup. */
function nodeOf(code, rollup) {
  return rollup === 'theme'
    ? (cleanName(code.group, { max: 120 }) || UNTHEMED)
    : cleanName(code.name, { max: 120, fallback: code.id });
}

/**
 * An unordered pair's key, so a-b and b-a are one edge.
 *
 * JSON rather than a joined string: a code name can contain anything a person types,
 * and 'A' + sep + 'B C' joins to the same thing as 'A B' + sep + 'C' — two different
 * pairs that would then have shared one tally.
 */
function pairKey(a, b) {
  return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
}

/**
 * A coding's extent, in whatever unit it has — or null if it has none.
 *
 * `unit` is compared before two spans are, because 12–30 seconds and characters 12–30
 * are not the same interval and would otherwise "overlap". A document holds text or
 * media, not both, so in practice this never fires; it is here so that the one time it
 * does, the answer is "no comparison" rather than a confident wrong one.
 */
function spanOf(seg) {
  if (typeof seg?.start === 'number' && typeof seg?.end === 'number') {
    return { unit: 'char', lo: seg.start, hi: seg.end };
  }
  if (typeof seg?.tStart === 'number' && typeof seg?.tEnd === 'number') {
    // A zero-length mark (a video keyframe) is given the smallest extent that can
    // intersect another mark at the same instant, rather than being unable to overlap
    // anything including itself.
    return { unit: 'time', lo: seg.tStart, hi: seg.tEnd > seg.tStart ? seg.tEnd : seg.tStart + 1e-9 };
  }
  return null;
}

/**
 * Turn the codings into **counts per case per occasion** — shape D: a long series.
 *
 * ## What an occasion is here
 *
 * A DOCUMENT, with a case that spans several of them: eight participants interviewed
 * three times each is twenty-four documents, three occasions, eight cases. The series
 * runs ACROSS documents.
 *
 * The other reading of "occasion" — a slice of time inside one document, so the series
 * runs within it — is deliberately not this function. It needs a bin width and a
 * convention for a coding that straddles two bins (momentary, partial-interval or
 * whole-interval recording, which answer different questions), and that is only
 * decidable with a real study in hand. See TODO.md.
 *
 * ## Case and occasion are nominated columns, not a new concept
 *
 * There is no notion of a case spanning documents anywhere in the coding model, and
 * this does not add one. `seg.doc` is a row id, so "which participant" and "which
 * interview" are already columns of that row — the same fact shape A rests on. A second
 * place to declare the grouping would only drift from the first, and nominating a column
 * lets a case be a participant in one analysis and a site in the next without recoding
 * anything.
 *
 * It also makes explicit something shape A leaves implicit: shape A's unit is the
 * DOCUMENT, so when cases span documents its prevalence is "how many interviews
 * mentioned cost", not how many participants. This function is the answer to that.
 *
 * ## Long, because that is what reads it
 *
 * One row per (case x occasion x code), with the code in a `measure` column — which is
 * exactly the shape `builtin-sced`'s multi-measure graph takes, and what the count models
 * and time-series tools want too. No wide variant is needed.
 *
 * **`phase` cannot come from the codings.** `builtin-sced` requires it, and when an
 * intervention started is a fact about the study design rather than about the coding. So
 * it has to be one of the carried columns; if the project has no phase column, SCED is
 * out of reach no matter what this emits, and the Output says so rather than letting the
 * user discover it in the picker.
 *
 * ## Zeros are data
 *
 * A session where the behaviour never occurred is a real observation, and a gap in the
 * series would draw a line straight through it. So every code in scope gets a row for
 * every (case, occasion) that EXISTS — but only those. A participant who dropped out
 * after session two has no session three, and inventing a zero there would be
 * fabricating an observation rather than recording an absence.
 *
 * @param {object} arg `docs`, `segments`, `codes`, `bookId`, `scope` as elsewhere.
 *   `docs[].caseKey` and `docs[].occasion` are the nominated values for that document.
 * @param {'code'|'theme'} [arg.rollup='code']
 * @param {Array<{meta: object, values: any[]}>} [arg.attrs] carried per-document columns;
 *   a cell built from several documents takes the first one's value and the conflicts are
 *   counted.
 * @returns {{variables: object[], columns: Object<string, any[]>, report: object}}
 */
export function occasionCounts({
  docs = [], segments = [], codes = [], bookId = null, scope = 'book',
  rollup = 'code', attrs = [],
}) {
  const codeById = new Map((codes ?? []).map((c) => [c.id, c]));
  const inScope = (c) => scope === 'all' || !bookId || c.codebookId === bookId;
  const rows = (docs ?? []).filter((d) => d.isDoc);

  // --- the cells: which (case, occasion) pairs exist --------------------------
  const report = {
    nRows: 0, nCases: 0, nOccasions: 0, zeros: 0, conflicts: 0,
    noCase: 0, noOccasion: 0, numericOccasions: true,
    unknownCode: 0, outOfScope: 0, offDoc: 0,
  };
  const cellOf = new Map(); // "case|occasion" -> {caseKey, occasion, docs: [index…]}
  const docCell = new Map(); // rid -> cell key
  const order = []; // occasion labels in first-appearance order
  for (let i = 0; i < rows.length; i += 1) {
    const d = rows[i];
    const caseKey = cleanName(d.caseKey, { max: 120 });
    const occasion = cleanName(d.occasion, { max: 120 });
    // A document with no case or no occasion cannot be placed in a series. Dropped and
    // counted, because the alternative is a phantom case named "" that silently
    // collects everything the user forgot to label.
    if (!caseKey) { report.noCase += 1; continue; }
    if (!occasion) { report.noOccasion += 1; continue; }
    const key = `${JSON.stringify(caseKey)}|${JSON.stringify(occasion)}`;
    if (!cellOf.has(key)) cellOf.set(key, { caseKey, occasion, docs: [] });
    cellOf.get(key).docs.push(i);
    docCell.set(d.rid, key);
    if (!order.includes(occasion)) order.push(occasion);
  }

  // --- the occasion axis ------------------------------------------------------
  // SCED wants a NUMERIC session. Real occasion columns are sometimes numbers (1, 2, 3)
  // and sometimes not ("Pre", "Post", "Follow-up"), and alphabetical order would put
  // Follow-up first. So: use the numbers when they are numbers, and otherwise fall back
  // to the order the occasions first appear in the data — which is the user's own row
  // order, the only non-arbitrary choice available and the same rule SCED itself applies
  // when the session column is omitted. The original label travels in `occasion` either
  // way, so nothing is lost and the ordering can be checked.
  report.numericOccasions = order.every((o) => o !== '' && Number.isFinite(Number(o)));
  const sessionOf = report.numericOccasions
    ? (o) => Number(o)
    : (o) => order.indexOf(o) + 1;

  // --- count, per cell per node -----------------------------------------------
  const nodes = [...new Set((codes ?? []).filter(inScope)
    .map((c) => (rollup === 'theme' ? (cleanName(c.group, { max: 120 }) || UNTHEMED)
      : cleanName(c.name, { max: 120, fallback: c.id }))))].sort();
  const tally = new Map(); // cellKey -> node -> count
  for (const s of segments ?? []) {
    const code = codeById.get(s.codeId);
    if (!code) { report.unknownCode += 1; continue; }
    if (!inScope(code)) { report.outOfScope += 1; continue; }
    const key = docCell.get(String(s.doc));
    if (!key) { report.offDoc += 1; continue; }
    const node = rollup === 'theme'
      ? (cleanName(code.group, { max: 120 }) || UNTHEMED)
      : cleanName(code.name, { max: 120, fallback: code.id });
    if (!tally.has(key)) tally.set(key, new Map());
    const m = tally.get(key);
    m.set(node, (m.get(node) ?? 0) + 1);
  }

  // --- assemble ---------------------------------------------------------------
  const cells = [...cellOf.entries()]
    .sort((a, b) => String(a[1].caseKey).localeCompare(String(b[1].caseKey))
      || sessionOf(a[1].occasion) - sessionOf(b[1].occasion));
  const out = {
    case: [], session: [], occasion: [], measure: [], count: [], present: [],
    n_docs: [], doc_chars: [],
  };
  const variables = [
    // Named for the SCED long form, which is the main consumer: case / session /
    // measure / value. `count` is the value, and `present` sits beside it rather than
    // behind an option, because naming one column `count` while it held a 0/1 would lie.
    { name: 'case', type: 'string', measurementLevel: 'nominal', label: 'Case' },
    { name: 'session', type: 'numeric', measurementLevel: 'scale', label: report.numericOccasions ? 'Occasion (from the column)' : 'Occasion (order of first appearance)' },
    { name: 'occasion', type: 'string', measurementLevel: 'nominal', label: 'Occasion label' },
    { name: 'measure', type: 'string', measurementLevel: 'nominal', label: rollup === 'theme' ? 'Theme' : 'Code' },
    { name: 'count', type: 'numeric', measurementLevel: 'scale', label: 'Codings in this occasion' },
    // NUMERIC, not the factor shape A uses for the same idea: `builtin-sced` filters its
    // outcome to numeric variables, and this table exists to feed it. The value labels
    // keep it readable in the editor.
    { name: 'present', type: 'numeric', measurementLevel: 'nominal', label: 'Occurred at all', valueLabels: { 0: 'No', 1: 'Yes' } },
    { name: 'n_docs', type: 'numeric', measurementLevel: 'scale', label: 'Documents in this occasion' },
    { name: 'doc_chars', type: 'numeric', measurementLevel: 'scale', label: 'Text in this occasion (characters)' },
  ];

  // Carried columns get their final names BEFORE anything is written, so an attribute
  // called `case` becomes `case_2` rather than briefly sharing a key with the column
  // this table is keyed by — which would have destroyed it.
  const taken = new Set(variables.map((v) => v.name));
  const carried = (attrs ?? []).filter((a) => a?.meta?.name).map((a) => {
    const name = uniqueName(a.meta.name, taken, { start: 2 });
    taken.add(name);
    return { src: a, name, vals: [] };
  });
  const origAt = new Map((docs ?? []).map((d, i) => [d.rid, i]));

  for (const [key, cell] of cells) {
    const counts = tally.get(key) ?? new Map();
    const chars = cell.docs.reduce((n, i) => n + (Number.isFinite(rows[i].chars) ? rows[i].chars : 0), 0);
    for (const node of nodes) {
      const n = counts.get(node) ?? 0;
      if (!n) report.zeros += 1;
      out.case.push(cell.caseKey);
      out.session.push(sessionOf(cell.occasion));
      out.occasion.push(cell.occasion);
      out.measure.push(node);
      out.count.push(n);
      out.present.push(n > 0 ? 1 : 0);
      out.n_docs.push(cell.docs.length);
      out.doc_chars.push(chars);
      for (const c of carried) {
        // One cell can be built from several documents — a participant interviewed twice
        // in one wave. The first document's value is used and the disagreements are
        // counted, because a silent pick would make a conflicting phase look settled.
        const vals = cell.docs.map((i) => (c.src.values ?? [])[origAt.get(rows[i].rid)] ?? null);
        if (vals.length > 1 && new Set(vals.map((v) => String(v))).size > 1) report.conflicts += 1;
        c.vals.push(vals[0] ?? null);
      }
    }
  }
  for (const c of carried) {
    out[c.name] = c.vals;
    const m = c.src.meta;
    variables.push({
      name: c.name, type: m.type || 'string', label: m.label || m.name,
      valueLabels: m.valueLabels, measurementLevel: m.measurementLevel,
    });
  }

  report.nRows = out.case.length;
  report.nCases = new Set(cells.map(([, c]) => c.caseKey)).size;
  report.nOccasions = order.length;

  return { variables, columns: out, report };
}

// =============================================================================
// Transcripts: time-aligned text
// =============================================================================

/**
 * Parse a transcript into codable text plus a cue index — WebVTT, SubRip (`.srt`) or
 * plain timestamped lines.
 *
 * ## What a transcript is, in this model
 *
 * **Readable text in the document column, and the timing beside it.** The text is the
 * thing being coded, so it stays exactly what it looks like: a plain transcript, which
 * means the char-span coding already built for text documents works on it unchanged, the
 * data grid shows words rather than JSON, and Text analytics can read the column. The
 * cues are a separate value recording where each passage sits in the media.
 *
 * That split is also why the workspace finds the timing **by value shape rather than by
 * column name** (see `parseTiming`): a convention like "the column called `timing`"
 * breaks the moment someone renames it or joins two datasets, and the plugin already
 * detects media documents by the shape of their cell rather than by what it is called.
 * Lose the timing column and a transcript degrades to an ordinary text document — still
 * codable, no longer seekable, which is the right way for this to fail.
 *
 * ## Cues carry BOTH coordinate systems
 *
 * Each cue holds its time (`tStart`/`tEnd`, seconds) and its span in the assembled text
 * (`start`/`end`, character offsets). One without the other is useless here: the time
 * alone cannot say which words to highlight, and the offsets alone cannot move a
 * playhead. Holding both is what lets a click on a line seek the audio, and a coded
 * passage report when it was said.
 *
 * ## Speakers are extracted, because qualitative work is about who said it
 *
 * `<v Ann>` (the WebVTT voice span) and a leading `Ann:` are both read as a speaker and
 * kept on the cue. The speaker is NOT stripped from the text: a transcript that reads
 * "Ann: I couldn't afford it" is what the researcher expects to see and to quote, and
 * removing the name would make a coded passage ambiguous about whose words it was.
 *
 * @param {string} raw the file's contents
 * @param {{kind?: 'vtt'|'srt'|'text'|'auto', gapSeconds?: number}} [opts]
 *   `gapSeconds` is how long a plain timestamped line lasts when the next timestamp does
 *   not say — only used by the `text` form, which records starts and no ends.
 * @returns {{text: string, cues: Array<{tStart: number, tEnd: number, start: number,
 *   end: number, speaker: string}>, kind: string, skipped: number}}
 */
export function parseTranscript(raw, { kind = 'auto', gapSeconds = 4 } = {}) {
  const src = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const form = kind === 'auto' ? sniffTranscript(src) : kind;
  const parsed = form === 'text' ? plainCues(src, gapSeconds) : blockCues(src, form);
  resolveSpeakers(parsed.cues);
  // Assemble the text and the offsets together, so they cannot disagree — the failure
  // that would put a coded highlight on the wrong words.
  const lines = [];
  const cues = [];
  let at = 0;
  for (const c of parsed.cues) {
    if (!c.text) continue;
    cues.push({
      tStart: c.tStart,
      tEnd: Number.isFinite(c.tEnd) && c.tEnd > c.tStart ? c.tEnd : c.tStart + gapSeconds,
      start: at,
      end: at + c.text.length,
      speaker: c.speaker || '',
    });
    lines.push(c.text);
    at += c.text.length + 1; // the newline that joins them
  }
  return { text: lines.join('\n'), cues, kind: form, skipped: parsed.skipped };
}

/** Which of the three forms this is, by looking at it. */
export function sniffTranscript(src) {
  const s = String(src ?? '');
  if (/^\s*WEBVTT/.test(s)) return 'vtt';
  // An SRT timestamp uses a comma for the decimal; WebVTT uses a point. That is the only
  // reliable difference between the two bodies, since an SRT index line is optional in
  // practice and plenty of files in the wild omit the WEBVTT header.
  if (/\d\d:\d\d:\d\d,\d{1,3}\s*-->/.test(s)) return 'srt';
  if (/\d\d:\d\d[:.]\d\d[.,]?\d*\s*-->/.test(s)) return 'vtt';
  return 'text';
}

/** `HH:MM:SS.mmm`, `MM:SS.mmm`, or either with a comma — in seconds, or NaN. */
export function parseTimestamp(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const [, h, mm, ss, frac] = m;
  const mins = Number(mm);
  const secs = Number(ss);
  // Minutes and seconds past 59 mean this is not a timestamp — most likely a line of
  // digits that happens to hold colons. Rejecting is better than inventing a time.
  if (mins > 59 || secs > 59) return NaN;
  return (Number(h || 0) * 3600) + (mins * 60) + secs
    + (frac ? Number(frac.padEnd(3, '0')) / 1000 : 0);
}

/** VTT / SRT: blocks separated by a blank line, each with a `-->` timing line. */
function blockCues(src, form) {
  const cues = [];
  let skipped = 0;
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    // WebVTT header and its metadata blocks carry no cue. A NOTE block can run to
    // several lines, which is why this is a block-level skip rather than a line filter.
    if (/^WEBVTT/.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) { skipped += 1; continue; }
    const [from, rest] = lines[at].split('-->');
    const tStart = parseTimestamp(from);
    // Anything after the end time is cue settings (`align:start line:90%`) — a position
    // on screen, which this model has no use for.
    const tEnd = parseTimestamp(String(rest ?? '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(tStart)) { skipped += 1; continue; }
    const body = lines.slice(at + 1).map((l) => cleanCueText(l, form)).filter(Boolean);
    if (!body.length) { skipped += 1; continue; }
    const speaker = voiceOf(lines.slice(at + 1).join('\n')) || leadingSpeaker(body[0]);
    cues.push({ tStart, tEnd, text: body.join(' '), speaker });
  }
  return { cues, skipped };
}

/**
 * Plain timestamped lines — `[00:01:23] Ann: text`, or the same without brackets.
 *
 * The common shape of a transcript typed by a person or exported by a transcription
 * service, and the reason the TODO entry named three formats rather than two. Each line
 * records only a START, so a cue runs until the next one begins; the last gets
 * `gapSeconds`, which is a guess and is the only guess in here.
 */
function plainCues(src, gapSeconds) {
  const cues = [];
  let skipped = 0;
  for (const line of src.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^\s*[[(]?\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*[\])]?\s*[-–—]?\s*(.*)$/.exec(line);
    const t = m ? parseTimestamp(m[1]) : NaN;
    if (!Number.isFinite(t)) {
      // A line with no timestamp belongs to the cue above it — a wrapped paragraph —
      // rather than being dropped, which would silently lose most of a hand-typed file.
      if (cues.length) cues[cues.length - 1].text += ` ${line.trim()}`;
      else skipped += 1;
      continue;
    }
    const text = cleanCueText(m[2], 'text');
    if (!text) { skipped += 1; continue; }
    cues.push({ tStart: t, tEnd: NaN, text, speaker: leadingSpeaker(text) });
  }
  for (let i = 0; i < cues.length - 1; i += 1) {
    if (cues[i + 1].tStart > cues[i].tStart) cues[i].tEnd = cues[i + 1].tStart;
  }
  if (cues.length) {
    const last = cues[cues.length - 1];
    if (!Number.isFinite(last.tEnd)) last.tEnd = last.tStart + gapSeconds;
  }
  return { cues, skipped };
}

/** The WebVTT voice span's name: `<v Ann>text</v>`, or `<v.loud Ann>`. */
function voiceOf(s) {
  const m = /<v(?:\.[^\s>]+)*\s+([^>]+)>/.exec(String(s ?? ''));
  return m ? m[1].trim() : '';
}

/**
 * The candidate speaker label at the head of a line — a leading `Ann:`, which is how
 * almost every hand-typed transcript marks who is talking.
 *
 * Only a CANDIDATE, because the evidence that settles it is not on the line. "I remember
 * thinking: there is no way I can pay that" has a short capitalised prefix and a colon,
 * and no line-by-line rule tells it from a name. What distinguishes a real label is that
 * it RECURS — see {@link resolveSpeakers}.
 */
function leadingSpeaker(s) {
  const m = /^([^\s:][^:]{0,31}):\s/.exec(String(s ?? ''));
  if (!m) return '';
  const who = m[1].trim();
  // A timestamp that survived the line parse is not a speaker. Note this rejects the
  // SHAPE rather than the presence of a digit: "Participant 3" and "Child 2" are
  // ordinary labels in this literature, and banning digits banned them.
  if (/^[\d\s:.,]+$/.test(who)) return '';
  return who.split(/\s+/).length > 3 ? '' : who;
}

/**
 * Decide which candidate labels are really speakers, over the whole file.
 *
 * A label that appears on several lines is a speaker; a one-off multi-word prefix is a
 * sentence that happened to contain a colon. One- and two-word candidates are kept even
 * when they appear once, because a transcript can legitimately have a single line from
 * `Interviewer` — and at two words or fewer a false positive costs little, while losing
 * the label costs the thing the transcript is for.
 *
 * Mutates in place: the cues are this function's own intermediate list, not the
 * caller's.
 */
function resolveSpeakers(cues) {
  const seen = new Map();
  for (const c of cues) if (c.speaker) seen.set(c.speaker, (seen.get(c.speaker) ?? 0) + 1);
  for (const c of cues) {
    if (!c.speaker) continue;
    const recurs = seen.get(c.speaker) > 1;
    if (!recurs && c.speaker.split(/\s+/).length > 2) c.speaker = '';
  }
  return cues;
}

/**
 * One cue line as codable text: markup out, entities decoded, whitespace settled.
 *
 * WebVTT allows inline tags — `<i>`, `<c.loud>`, `<v Ann>`, and mid-cue timestamps like
 * `<00:00:02.500>` used for karaoke-style highlighting. None of it is content, and all of
 * it would end up inside a coded quote and then inside a paper.
 */
function cleanCueText(line, form) {
  let s = String(line ?? '');
  if (form !== 'text') s = s.replace(/<[^>]*>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lrm;|&rlm;/gi, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    // Ampersand last, so `&amp;lt;` decodes to the text `&lt;` rather than to `<`.
    .replace(/&amp;/gi, '&');
  // Control characters to spaces, like `cleanName`: a stray NUL or vertical tab in a
  // transcript breaks tokenisers quietly, and the words either side must not weld.
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * The timing value stored beside a transcript: `{media, cues}` as JSON.
 *
 * `media` is a list for the same reason a media document's is — a document can have more
 * than one file — and it is the SAME list shape, so the player code does not branch on
 * which kind of document it came from.
 */
export function timingValue({ cues, refs = [] }) {
  return JSON.stringify({ v: 1, media: refs, cues });
}

/**
 * Read a timing value back, or null if this cell is not one.
 *
 * Value-shaped detection, deliberately: see the note at the top of
 * {@link parseTranscript} for why the workspace must not depend on a column NAME. Strict
 * about what it accepts, because every other string in the dataset is offered to it.
 */
/**
 * Turn a transcription result into a CAQDAS transcript document.
 *
 * The engine hands back DATA and says nothing about what a transcript IS — that decision
 * belongs to whoever will use it, and another plugin filing the same result in its own
 * dataset would be equally right. CAQDAS's answer is the shape it already codes.
 *
 * Which is why this DELEGATES rather than assembling anything. The result carries a
 * WebVTT string, and `parseTranscript` is the same parser an imported `.vtt` goes
 * through — it builds the text and the cue offsets together "so they cannot disagree",
 * resolves speakers, and has fifty-odd tests behind it. A second implementation here
 * would be a second place for the two coordinate systems to drift apart, and the first
 * draft of this function duplicated that logic and promptly reproduced a bug the parser
 * had already been taught to avoid.
 *
 * A transcribed interview and an imported transcript are therefore the same kind of
 * document, byte for byte in shape.
 *
 * @param {{vtt?: string}} result  from `app.transcribe.result(id)`
 * @param {string|null} mediaRef  the `asset:` ref this was transcribed FROM
 * @returns {{text: string, timing: string}}  `timing` is the cell value, ready to store
 */
export function transcriptToDocument(result, mediaRef = null) {
  const parsed = parseTranscript(String(result?.vtt ?? ''), { kind: 'vtt' });
  const refs = typeof mediaRef === 'string' && mediaRef ? [mediaRef] : [];
  // The language is kept WITH the text, not just shown while the job runs. Which language
  // a recording was read as is the difference between a transcript and a fabrication, and
  // a reader coming back to this in a year cannot re-derive it from the words — a
  // mis-detected file reads as perfectly fluent prose in the wrong language.
  const detection = result?.detection
    ? {
      name: result.detection.name,
      confidence: result.detection.confidence,
      mixed: !!result.detection.mixed,
      dissenting: (result.detection.dissenting ?? []).map((d) => ({ name: d.name, at: d.at })),
    }
    : null;
  return {
    text: parsed.text,
    timing: timingValue({ cues: parsed.cues, refs }),
    language: result?.language ?? null,
    detection,
    // Which stretch of the recording this covers, or null for all of it. Without it a
    // partial transcript is indistinguishable from a complete one that lost its middle.
    range: result?.range ? { from: result.range.from, to: result.range.to } : null,
    // Parts that could not be transcribed. A transcript with holes has to be able to say
    // so wherever it ends up — the gap markers are visible in the text, but a reader
    // skimming a dataset column should not have to notice them to know.
    missing: Array.isArray(result?.missing) && result.missing.length
      ? result.missing.map((m) => ({ part: m.part, total: m.total, from: m.from, to: m.to }))
      : null,
  };
}

export function parseTiming(raw) {
  const s = String(raw ?? '').trim();
  if (s[0] !== '{') return null;
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object' || !Array.isArray(o.cues)) return null;
  // `num` rather than `Number.isFinite(Number(x))`, because `Number(null)` is **0** —
  // as are `Number('')` and `Number(' ')`. A cue with a null offset would otherwise
  // validate as offset 0 and put a highlight on the opening words of the document. Same
  // trap as the missing coordinate that geocoded to (0, 0).
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cues = o.cues
    .filter((c) => c && num(c.tStart) !== null && num(c.start) !== null && num(c.end) !== null)
    .map((c) => ({
      tStart: num(c.tStart),
      // No end is recoverable — a cue is at least an instant — so it takes its start
      // rather than being dropped with the genuinely broken ones.
      tEnd: num(c.tEnd) ?? num(c.tStart),
      start: num(c.start),
      end: num(c.end),
      speaker: typeof c.speaker === 'string' ? c.speaker : '',
    }));
  if (!cues.length) return null;
  const media = Array.isArray(o.media)
    ? o.media.filter((x) => typeof x === 'string' && (x.startsWith('asset:') || x.startsWith('data:')))
    : [];
  return { media, cues };
}

/** The cue a character offset falls in — what turns a coded span into a time. */
export function cueAtChar(cues, offset) {
  const n = Number(offset);
  if (!Array.isArray(cues) || !Number.isFinite(n)) return null;
  // Binary search: a transcript of a long interview holds thousands of cues and this is
  // called for every coding on every render.
  let lo = 0;
  let hi = cues.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (n < c.start) { hi = mid - 1; continue; }
    best = c;
    if (n < c.end) return c;
    lo = mid + 1;
  }
  // Past the end of a cue but before the next one: the newline between them. The cue it
  // belongs to is the one that just ended, not the one that has not started.
  return best;
}

/** `m:ss`, or `h:mm:ss` once it has been going an hour. */
export function clockOf(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Import a time-aligned transcript — WebVTT, SubRip, or plain timestamped lines.
 *
 * One row per file: the transcript as readable text in `text`, and `{media, cues}` in
 * `timing` beside it. See {@link parseTranscript} for why the text stays plain and the
 * timing is found by value shape rather than by column name.
 *
 * ## It asks for the media, rather than guessing at it
 *
 * A transcript is only half a document; the recording is the other half, and without it
 * there is no playhead to seek. Pairing by filename was the obvious idea and is the
 * wrong one here: the host calls an importer once per file with no knowledge of the
 * others, so `interview1.vtt` cannot see `interview1.mp3` in the same selection, and
 * matching against rows already in the dataset would mean guessing from a basename that
 * often does not match at all (`Interview 1 FINAL.mp3` beside `interview1.vtt`).
 *
 * So it asks, once per transcript, through the host's own picker — and **Cancel is a
 * real answer**: a transcript with no recording is still a document worth coding, and
 * plenty of archived qualitative data is exactly that. The import says which it got.
 *
 * @param {object} app
 * @param {{name: string, file: File}} arg
 */
export async function parseTranscriptFile(app, { name, file }) {
  const raw = new TextDecoder('utf-8').decode(await file.arrayBuffer());
  const { text, cues, kind, skipped } = parseTranscript(raw);
  if (!cues.length) {
    await app.results.appendError(
      `“${name}” has no readable cues. A transcript needs timings — WebVTT or SubRip `
      + 'blocks with a `-->` line, or lines that start with a timestamp.',
    );
    return null;
  }

  const media = await app.ui.pickFile({
    title: `Recording for “${name}”`,
    hint: 'The audio or video this transcript was made from — clicking a line will seek it. '
      + 'Cancel to import the transcript on its own; it is still codable, just not playable.',
    accept: 'audio/*,video/*',
  });
  const refs = [];
  let medium = '';
  if (media) {
    const dims = await probeMedia(media, (media.type || '').startsWith('video') ? 'video' : 'audio');
    medium = (media.type || '').startsWith('video') ? 'video' : 'audio';
    const { ref } = await app.assets.put(media, {
      type: media.type || '', name: media.name, medium, ...dims,
    });
    refs.push(ref);
  }

  const document = String(name).replace(/\.[^.]+$/, '') || String(name);
  const variables = [
    { name: 'document', type: 'string', measurementLevel: 'nominal', label: 'Source file' },
    { name: 'text', type: 'string', measurementLevel: 'nominal', label: 'Transcript' },
    // The timing rides in its own column so `text` stays the plain transcript: readable
    // in the grid, codable by character span, and usable by Text analytics.
    { name: 'timing', type: 'string', measurementLevel: 'nominal', label: 'Transcript timing' },
    { name: 'speakers', type: 'numeric', measurementLevel: 'scale', label: 'Speakers' },
    { name: 'cues', type: 'numeric', measurementLevel: 'scale', label: 'Transcript lines' },
    { name: 'duration', type: 'numeric', measurementLevel: 'scale', label: 'Duration (s)' },
  ];
  const columns = {
    document: [document],
    text: [text],
    timing: [timingValue({ cues, refs })],
    speakers: [new Set(cues.map((c) => c.speaker).filter(Boolean)).size],
    cues: [cues.length],
    // From the cues, not from the file: a transcript that stops early is a fact about
    // the transcript, and the media's own duration is recorded on the asset anyway.
    duration: [Math.round(cues[cues.length - 1].tEnd * 1000) / 1000],
  };

  const FORMS = { vtt: 'WebVTT', srt: 'SubRip', text: 'timestamped lines' };
  const speakers = [...new Set(cues.map((c) => c.speaker).filter(Boolean))];
  await app.results.appendText(
    `**Transcript imported: ${document}** — ${cues.length} line`
    + `${cues.length === 1 ? '' : 's'} read as ${FORMS[kind] ?? kind}, running to `
    + `${clockOf(cues[cues.length - 1].tEnd)}`
    + (speakers.length
      ? `, with ${speakers.length} speaker${speakers.length === 1 ? '' : 's'} `
        + `(${speakers.slice(0, 6).join(', ')}${speakers.length > 6 ? ', …' : ''})`
      : ', with no speaker labels')
    + '. '
    + (refs.length
      ? `The ${medium} is attached, so the Coding tab will play it and clicking a line seeks it.`
      : 'No recording was attached, so the transcript is codable but not playable — '
        + 'import it again with the recording if you want the playhead.')
    + (skipped
      ? `\n\n${skipped} block(s) were skipped: no timing line, or nothing but markup.`
      : ''),
  );
  return { variables, columns, source: document };
}

/** The label for codings whose code carries no theme, and for an unstamped coder. */
const UNTHEMED = 'Unthemed';
const UNATTRIBUTED = 'Unattributed';

/**
 * Turn this project's codings into a **case x code dataset** — shape A of the
 * quantitising plan.
 *
 * ## Why a dataset and not a cross-plugin call
 *
 * A "document" here is already a dataset ROW (`seg.doc` is a `__ct_rid`), so the
 * respondent attributes are the other columns of the same row. Emitting a dataset
 * therefore needs no attribute model, works for every analysis plugin at once including
 * third-party ones that cannot read these records at all, and — the reason that decides
 * it — puts the five judgements below in the log, in History and in the do-file, instead
 * of hiding them inside one analysis run.
 *
 * ## The five judgements, which are judgements and not conversions
 *
 * Each is an argument, each is reported in the output, and the defaults are the ones
 * that need no parameter:
 *
 *  1. **Unit** — the document. (Segment and interval units are shapes B and D.)
 *  2. **`values`** — `presence` (did this case raise it at all) or `count`. Presence by
 *     default, because a raw count is confounded by how much each participant talked and
 *     by how finely the coder highlights: two coders with identical judgement produce
 *     different counts. What papers report is "8 of 12 participants raised cost".
 *  3. **`rollup`** — one column per `code`, or per `theme` (`code.group`, a flat
 *     one-level string, so this is two levels and no recursive walk).
 *  4. **`coders`** — `pool` every coder into one column, or one column **per coder**.
 *     The per-coder form is what makes `Scale ▸ Inter-rater agreement…` usable on coded
 *     data with a unit model other than the one `fromCodings` picks for you.
 *  5. **`scope`** — the active codebook or every codebook. Note the existing code
 *     frequency button counts segments from EVERY book while listing only the active
 *     book's codes; this asks instead of inheriting that.
 *
 * Unresolved and drifted codings are **included**, and that is not a shrug: at document
 * grain a coding belongs to its row because `doc` is a row id, not a position, so a
 * quote that no longer matches still counts for the right case. Only offsets need
 * resolution, and offsets are shape B.
 *
 * ## Denominators travel as columns
 *
 * `n_segments`, `doc_chars` and `coded_chars` ride along because no downstream plugin
 * has an exposure input to ask for them — `builtin-countmodels` has no `offset`. A rate
 * per 1000 words is then one Compute away rather than impossible.
 *
 * Pure, so the whole contract is testable without a DOM or a dataset.
 *
 * @param {object} arg
 * @param {Array<{rid: string, label: string, chars: number, isDoc: boolean}>} arg.docs
 *   every row of the coded dataset, in dataset order. `isDoc` false for a row with
 *   nothing to code — it is excluded, because a blank row is not a document that
 *   declined to mention the theme.
 * @param {Array<{id?: string, doc: string, codeId: string, author?: object, anchor?: object}>} arg.segments
 * @param {Array<{id: string, name: string, group?: string, codebookId?: string, sort?: number}>} arg.codes
 * @param {string|null} [arg.bookId] the active codebook, for `scope: 'book'`
 * @param {'presence'|'count'} [arg.values='presence']
 * @param {'code'|'theme'} [arg.rollup='code']
 * @param {'pool'|'coder'} [arg.coders='pool']
 * @param {'book'|'all'} [arg.scope='book']
 * @param {Array<{meta: object, values: any[]}>} [arg.attrs] columns carried across,
 *   aligned to `docs`; their metadata (labels, value labels) is preserved.
 * @param {string|null} [arg.labelColumn] names the `document` column in the output
 * @returns {{variables: object[], columns: Object<string, any[]>,
 *            report: {nDocs: number, nRows: number, nCodings: number, nUsed: number,
 *                     outOfScope: number, unknownCode: number, offDoc: number,
 *                     coders: string[], items: Array<{label: string, name: string,
 *                     present: number, total: number}>}}}
 */
export function quantitiseCodings({
  docs = [], segments = [], codes = [], bookId = null,
  values = 'presence', rollup = 'code', coders = 'pool', scope = 'book',
  attrs = [], labelColumn = null,
}) {
  const presence = values !== 'count';
  const codeById = new Map((codes ?? []).map((c) => [c.id, c]));
  const inScope = (c) => scope === 'all' || !bookId || c.codebookId === bookId;

  // --- which codings count, and why the rest did not --------------------------
  const rows = (docs ?? []).filter((d) => d.isDoc);
  const rowAt = new Map(rows.map((d, i) => [d.rid, i]));
  const tally = { unknownCode: 0, outOfScope: 0, offDoc: 0 };
  const used = [];
  for (const s of segments ?? []) {
    const code = codeById.get(s.codeId);
    if (!code) { tally.unknownCode += 1; continue; }
    if (!inScope(code)) { tally.outOfScope += 1; continue; }
    if (!rowAt.has(String(s.doc))) { tally.offDoc += 1; continue; }
    used.push({ seg: s, code });
  }

  // --- the columns ------------------------------------------------------------
  // Ordered the way the codebook is ordered, so the dataset reads like the book it
  // came from rather than like the order codings happened to be made in.
  const byBook = (codes ?? []).filter(inScope).slice()
    .sort((a, b) => String(a.group ?? '').localeCompare(String(b.group ?? ''))
      || (typeof a.sort === 'number' && typeof b.sort === 'number' ? a.sort - b.sort : 0)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')));

  /** A column's identity: what it is of, and how it is labelled. */
  const items = [];
  if (rollup === 'theme') {
    const seen = new Set();
    for (const c of byBook) {
      const theme = cleanName(c.group, { max: 120 }) || UNTHEMED;
      if (seen.has(theme)) continue;
      seen.add(theme);
      items.push({ key: theme, label: theme, group: '' });
    }
  } else {
    for (const c of byBook) {
      items.push({ key: c.id, label: cleanName(c.name, { max: 120, fallback: c.id }), group: cleanName(c.group, { max: 120 }) });
    }
  }
  /** Which column key a coding falls under, under the chosen rollup. */
  const keyOf = (code) => (rollup === 'theme' ? (cleanName(code.group, { max: 120 }) || UNTHEMED) : code.id);

  const coderList = coders === 'coder'
    ? [...new Set(used.map(({ seg }) => coderName(seg) || UNATTRIBUTED))].sort()
    : [null];

  // --- count ------------------------------------------------------------------
  // cell[key\0coder] = per-row counts. One pass over the codings rather than a
  // filter per cell, because a big project has far more codings than cells.
  const cell = new Map();
  const bucket = (k) => {
    let b = cell.get(k);
    if (!b) { b = new Array(rows.length).fill(0); cell.set(k, b); }
    return b;
  };
  const nSegments = new Array(rows.length).fill(0);
  const codedChars = new Array(rows.length).fill(0);
  for (const { seg, code } of used) {
    const i = rowAt.get(String(seg.doc));
    nSegments[i] += 1;
    codedChars[i] += quotedLength(seg);
    const who = coders === 'coder' ? (coderName(seg) || UNATTRIBUTED) : '';
    bucket(`${keyOf(code)}\u0000${who}`)[i] += 1;
  }

  // --- assemble ---------------------------------------------------------------
  const variables = [];
  const columns = {};
  const taken = new Set();
  const add = (base, meta, vals) => {
    const name = uniqueName(base, taken, { start: 2 });
    taken.add(name);
    variables.push({ ...meta, name });
    columns[name] = vals;
    return name;
  };

  add('document', {
    type: 'string', measurementLevel: 'nominal',
    label: labelColumn || 'Document',
  }, rows.map((d, i) => d.label || `Doc ${i + 1}`));
  // The row id is provenance, not data: it is the only thing tying a quantitised row
  // back to the document it summarises, and nothing else in the project records it.
  add('doc_rid', { type: 'string', measurementLevel: 'nominal', label: 'Source row id' },
    rows.map((d) => d.rid));

  for (const a of attrs ?? []) {
    const m = a?.meta ?? {};
    if (!m.name) continue;
    add(m.name, {
      type: m.type || 'string', label: m.label || m.name,
      valueLabels: m.valueLabels, measurementLevel: m.measurementLevel,
    }, rows.map((d, i) => (a.values ?? [])[i] ?? null));
  }

  add('n_segments', { type: 'numeric', measurementLevel: 'scale', label: 'Codings on this document' }, nSegments);
  add('doc_chars', { type: 'numeric', measurementLevel: 'scale', label: 'Document length (characters)' },
    rows.map((d) => (Number.isFinite(d.chars) ? d.chars : 0)));
  add('coded_chars', { type: 'numeric', measurementLevel: 'scale', label: 'Coded text (characters)' }, codedChars);

  const report = {
    nDocs: (docs ?? []).length,
    nRows: rows.length,
    nCodings: (segments ?? []).length,
    nUsed: used.length,
    ...tally,
    coders: coders === 'coder' ? coderList.slice() : [],
    items: [],
  };

  for (const it of items) {
    for (const who of coderList) {
      const counts = cell.get(`${it.key}\u0000${who ?? ''}`) ?? new Array(rows.length).fill(0);
      const vals = presence ? counts.map((n) => (n > 0 ? 1 : 0)) : counts.slice();
      const base = who ? `${it.label} (${who})` : it.label;
      const label = [it.group, it.label].filter(Boolean).join(': ') + (who ? ` — ${who}` : '');
      const name = add(base, presence
        // A 0/1 indicator is a FACTOR, not a number: that is what makes it offerable in
        // Crosstabs, which takes only factor/string — the headline use for this dataset.
        ? { type: 'factor', measurementLevel: 'nominal', label, valueLabels: { 0: 'Absent', 1: 'Present' } }
        : { type: 'numeric', measurementLevel: 'scale', label }, vals);
      report.items.push({
        label, name,
        present: counts.reduce((n, c) => n + (c > 0 ? 1 : 0), 0),
        total: counts.reduce((n, c) => n + c, 0),
      });
    }
  }

  return { variables, columns, report };
}

/**
 * How much text a coding covers, from the anchor's own quote selector.
 *
 * NOT `seg.quote`, which is truncated to 80 characters for display — the full text is in
 * the `text-quote` selector, which is persisted. So this needs no anchor RESOLUTION:
 * length is a property of what was quoted, not of where it now sits.
 *
 * A region or time coding quotes no text and contributes 0 rather than a number in some
 * other unit; mixing characters with seconds in one column would be worse than a zero.
 */
function quotedLength(seg) {
  const sel = (seg?.anchor?.ref?.selectors ?? []).find((x) => x?.kind === 'text-quote');
  return typeof sel?.exact === 'string' ? sel.exact.length : 0;
}

/**
 * Split a document's text into runs at every coding boundary — the spans that become one
 * text node or one `<mark>` each.
 *
 * Pure and exported because it used to be inline in the renderer, and a transcript needs
 * the same runs grouped into lines. Two copies of boundary arithmetic is how a highlight
 * ends up one character out in one view and not the other.
 *
 * `covering` is every coding that spans the whole run, in the order given; a run covered
 * by two overlapping codes gets both, and the renderer colours by the first. `extra`
 * boundaries let a caller split further without knowing how this works — the transcript
 * pane passes its cue edges, so no run ever straddles two lines.
 *
 * @param {number} length the document's text length
 * @param {Array<{start: number, end: number}>} segs placed codings
 * @param {number[]} [extra] additional boundaries to split at
 * @returns {Array<{a: number, b: number, covering: object[]}>} in document order,
 *   contiguous, covering [0, length) exactly
 */
export function textRuns(length, segs, extra = []) {
  const len = Math.max(0, Math.floor(Number(length) || 0));
  if (!len) return [];
  const placed = (segs ?? []).filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end));
  const bounds = new Set([0, len]);
  const clamp = (n) => Math.max(0, Math.min(len, Math.floor(n)));
  for (const s of placed) { bounds.add(clamp(s.start)); bounds.add(clamp(s.end)); }
  for (const e of extra ?? []) if (Number.isFinite(e)) bounds.add(clamp(e));
  const points = [...bounds].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (b <= a) continue;
    out.push({ a, b, covering: placed.filter((s) => s.start <= a && s.end >= b) });
  }
  return out;
}

/**
 * Which cue is playing at `t` — the index, or -1 before the first one starts.
 *
 * Used on every `timeupdate`, so it searches rather than scans: a long interview holds
 * thousands of cues and this fires several times a second.
 *
 * A gap between cues keeps the cue that just ended highlighted rather than clearing the
 * pane. Silence between two lines is part of reading the one before it, and a highlight
 * that blinks off in every pause is worse than one that lingers.
 */
export function activeCueIndex(cues, t) {
  const n = Number(t);
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(n) || n < cues[0].tStart) return -1;
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].tStart <= n) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

/** Fractional sort first, then name — a stable, explainable order either way. */
function byCodeOrder(a, b) {
  const x = typeof a.sort === 'number' ? a.sort : Number.POSITIVE_INFINITY;
  const y = typeof b.sort === 'number' ? b.sort : Number.POSITIVE_INFINITY;
  if (x !== y) return x - y;
  return String(a.name ?? '').localeCompare(String(b.name ?? ''));
}

/**
 * A fractional key placing a code between `before` and `after` (either may be absent,
 * meaning "the start"/"the end"). Halving the gap is what makes an insert cost ONE
 * field write rather than renumbering the neighbours — which is the property that lets
 * two peers insert concurrently without colliding.
 */
export function sortKeyBetween(before, after) {
  const lo = typeof before === 'number' ? before : null;
  const hi = typeof after === 'number' ? after : null;
  if (lo == null && hi == null) return 1;
  if (lo == null) return hi - 1;
  if (hi == null) return lo + 1;
  return (lo + hi) / 2;
}

/** The key for a code appended to the end of `list`. */
export function nextSortKey(list) {
  const keys = (list ?? []).map((c) => c.sort).filter((v) => typeof v === 'number');
  return keys.length ? Math.max(...keys) + 1 : 1;
}

/**
 * Parse a pasted code list. One code per line; `name, theme, #colour` if you have them,
 * a bare list of names if you do not.
 *
 * Deliberately forgiving about the shape and strict about identity: a name that already
 * exists in the target book is skipped, so pasting the same sheet twice is safe. That
 * matters because the realistic input is a spreadsheet column someone maintains
 * elsewhere and re-pastes as it grows.
 *
 * Pure, and exported, so the parsing can be tested without a DOM.
 *
 * @param {string} text
 * @param {Set<string>} existingNames lower-cased names already in the book
 * @returns {{name:string, group:string, color:string|null}[]}
 */
export function parseCodeList(text, existingNames = new Set()) {
  const out = [];
  // Strings only. Coercing would turn a stray number into a code named "42" — harmless
  // but surprising, and the only real caller is a textarea's value.
  if (typeof text !== 'string') return out;
  // A CSV written by `codebookToCsv` starts with its header; skip it so importing an
  // exported file does not create a code called "name". Matched exactly, so a genuine
  // code named "name" is only lost if it is also the very first line AND followed by
  // the other two column titles.
  text = text.replace(/^\s*"?name"?\s*[,\t]\s*"?theme"?\s*[,\t]\s*"?colou?r"?\s*\r?\n/i, '');
  const seen = new Set(existingNames);
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Split on commas or tabs — a spreadsheet paste arrives tab-separated.
    const parts = line.split(/\t|,/).map((x) => x.trim());
    // A quoted first field may itself contain a comma; unwrap it and rejoin if so.
    let name = parts.shift() ?? '';
    if (name.startsWith('"') && !name.endsWith('"')) {
      while (parts.length && !name.endsWith('"')) name += ', ' + parts.shift();
    }
    name = name.replace(/^"|"$/g, '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;           // already present, or duplicated in the paste
    seen.add(key);
    // A colour is whichever remaining field looks like one; everything else is a theme.
    const colorAt = parts.findIndex((x) => /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(x));
    const color = colorAt >= 0 ? toHex(parts.splice(colorAt, 1)[0]) : null;
    const group = (parts.shift() || '').replace(/^"|"$/g, '').trim();
    out.push({ name, group, color });
  }
  return out;
}

/** Add parsed codes to the active book, assigning palette colours to those without one. */
export function addCodesFromText(state, text) {
  const mine = state.codes.filter((c) => c.codebookId === state.codebookId);
  const existing = new Set(mine.map((c) => String(c.name).toLowerCase()));
  const parsed = parseCodeList(text, existing);
  parsed.forEach((pc, i) => {
    state.codes.push({
      id: uid(),
      name: pc.name,
      color: pc.color || PALETTE[(mine.length + i) % PALETTE.length],
      group: pc.group,
      memo: '',
      codebookId: state.codebookId,
    });
  });
  return parsed.length;
}

/** A codebook as CSV: the same three columns {@link parseCodeList} reads back. */
export function codebookToCsv(codes) {
  const q = (v) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const rows = [['name', 'theme', 'colour'].join(',')];
  for (const c of codes ?? []) rows.push([q(c.name), q(c.group || ''), q(c.color || '')].join(','));
  return rows.join('\n') + '\n';
}

/** Coerce any colour-ish string to '#rrggbb' for <input type=color>. */
export function toHex(c) {
  const t = String(c ?? '').trim();
  const m = /^#?([0-9a-f]{3})$/i.exec(t);
  if (m) return ('#' + m[1].split('').map((ch) => ch + ch).join('')).toLowerCase();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(t);
  if (m6) return ('#' + m6[1]).toLowerCase();
  return '#cccccc';
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
 * wrap exact substrings, so concatenated text === raw text).
 *
 * THE CONTAINER MUST HOLD THE DOCUMENT AND NOTHING ELSE. This walks every text node in
 * it, so any chrome sharing the element — a banner, a button label — is counted as
 * document characters and shifts every offset right. Pass the transcript, never the pane
 * that contains it: that mistake anchored codings past the end of short documents. */
/**
 * The attribute that marks an element as CHROME: on the screen, but not part of the
 * document's text.
 *
 * The transcript pane draws a time beside each line, and a character offset is measured
 * by walking the text nodes in the pane — so without this a gutter reading "0:04" adds
 * four characters to every offset after it, and every highlight in the document sits
 * adrift of the words it marks.
 */
const NONTEXT = 'data-ct-chrome';

/** Walk only the text that IS the document, skipping chrome. Used by both
 * {@link offsetWithin} and {@link setSelectionRange}, which have to agree: if one counts
 * a node the other skips, a selection restored after a re-render lands in the wrong
 * place. */
function documentTextWalker(container) {
  return document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest(`[${NONTEXT}]`)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
}

function offsetWithin(container, node, offset) {
  let total = 0;
  const walker = documentTextWalker(container);
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return total + offset;
    total += n.nodeValue.length;
  }
  // A selection that ENDS on chrome has no offset of its own; the accumulated total is
  // the end of the document text before it, which is the nearest honest answer. With
  // `user-select: none` on the gutters this should be unreachable from a mouse drag — it
  // is here for a programmatic range, and because "unreachable" is a claim about CSS
  // support rather than about this code.
  return total + (node && node.parentElement?.closest(`[${NONTEXT}]`) ? 0 : offset);
}

/** Re-establish a text selection over [lo, hi) character offsets within
 * `container` — the inverse of {@link offsetWithin}. Lets a passage stay selected
 * after the transcript re-renders (so codes can be layered on it). No-op if the
 * range can't be mapped. */
function setSelectionRange(container, lo, hi) {
  const range = document.createRange();
  let acc = 0;
  let startDone = false;
  const walker = documentTextWalker(container);
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

/**
 * The codebook as QDA-XML, with CrossTab's flat themes expressed as the standard's own
 * hierarchy: a theme is a parent `<Code>` carrying its codes as children.
 *
 * `isCodable="false"` is what marks the parent as an organiser rather than something you
 * can apply — the same thing NVivo and ATLAS.ti write for a folder-like code. Without
 * this the themes went nowhere at all: they are not an attribute the format has, so an
 * exporter that only wrote a flat list simply dropped them, which a round-trip through
 * our own file could not survive either.
 *
 * A theme gets a guid of its own so the nesting is well-formed, and nothing points at it:
 * it is not a code anyone coded with.
 */
export function qdpxCodeTree(codes, codeGuid) {
  const one = (c) =>
    `<Code guid="${codeGuid.get(c.id)}" name="${xesc(c.name)}" isCodable="true"`
    + `${c.color ? ` color="${xesc(c.color)}"` : ''}/>`;
  const themed = new Map();
  const loose = [];
  for (const c of codes) {
    const g = String(c.group ?? '').trim();
    if (!g) { loose.push(c); continue; }
    if (!themed.has(g)) themed.set(g, []);
    themed.get(g).push(c);
  }
  const out = [];
  for (const [theme, members] of themed) {
    out.push(
      `<Code guid="${qdpxUuid()}" name="${xesc(theme)}" isCodable="false">`
      + members.map(one).join('')
      + '</Code>',
    );
  }
  // Un-themed codes stay at the top level, which is where they are in the codebook.
  for (const c of loose) out.push(one(c));
  return out.join('');
}

/**
 * What the export calls itself, in the XML and on disk.
 *
 * One constant for both, so they cannot disagree. It is not the user's chosen filename:
 * the host asks for that AFTER the plugin has formatted the bytes, and there is no
 * project-name surface in the plugin API — `app` has data, items, state, assets,
 * anchors and zip, and no project. So this is the honest answer rather than the ideal
 * one, and it is a large improvement on what it replaced, which was the LABEL COLUMN:
 * `<Project name="participant">`, which then re-imported as a dataset called
 * "participant".
 */
const QDPX_FILE = 'coding.qdpx';
const QDPX_PROJECT = 'CrossTab coding';

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
      // Positions are derived, not stored (#166), and this runs in the compute frame
      // where nothing has resolved them yet — so resolve here, against the very text
      // being written into the archive. That is what keeps the exported offsets true to
      // the exported document rather than to whatever it said when it was coded.
      const placed = await app.anchors.resolve(segs.map((x) => x.anchor?.ref ?? null), { kind: 'text', text: cell });
      const sels = segs.map((x, i) => ({ seg: x, at: placed[i] }))
        // An unresolvable coding is DROPPED from the export rather than written at a
        // guessed offset: a QDPX consumed by another tool has no way to see a warning,
        // so a wrong span there is worse than an absent one.
        .filter(({ at }) => typeof at?.start === 'number')
        .map(({ seg, at }) =>
          `<PlainTextSelection guid="${qdpxUuid()}" startPosition="${at.start}" endPosition="${at.end}">${codingXml(seg, codeGuid)}</PlainTextSelection>`,
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

  const codeEls = qdpxCodeTree(state.codes, codeGuid);
  const qde =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    // Named for the FILE, not for the label column. The label column names the documents
    // inside the project; it is not the project, and calling the project "participant"
    // made a re-import produce a dataset of that name.
    `<Project xmlns="urn:QDA-XML:project:1.0" name="${xesc(QDPX_PROJECT)}" origin="CrossTab">` +
    `<CodeBook><Codes>${codeEls}</Codes></CodeBook>` +
    `<Sources>${sourceEls.join('')}</Sources>` +
    `</Project>`;
  files.unshift({ name: 'project.qde', data: qde });

  const zipBytes = await app.zip.make(files);
  return { filename: QDPX_FILE, mimeType: 'application/zip', data: zipBytes };
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
  //
  // A nested `<Code>` is the format's hierarchy, and CrossTab's themes are one level of
  // it — so a code's parent becomes its `group`. Deeper nesting is flattened to the
  // NEAREST ancestor rather than being refused or joined into a path: CrossTab's theme
  // is a single flat label, and inventing "A > B > C" would put a string in the codebook
  // that nothing else in the app knows how to split.
  //
  // A parent with `isCodable="false"` is an organiser, not a code — that is what NVivo
  // and ATLAS.ti write for a folder — so it becomes a theme and not a code of its own.
  // One left codable is imported as both: a real code that also groups others, which is
  // legal in those tools and has no CrossTab equivalent beyond this.
  const codeIdByGuid = new Map();
  const codes = [];
  for (const el of doc.getElementsByTagName('Code')) {
    const guid = el.getAttribute('guid');
    if (!guid || codeIdByGuid.has(guid)) continue;
    const parent = el.parentElement;
    const group = parent && parent.tagName === 'Code' ? (parent.getAttribute('name') || '') : '';
    const codable = (el.getAttribute('isCodable') || 'true') !== 'false';
    // An organiser still needs its guid mapped, or a stray CodeRef to it resolves to
    // nothing and silently drops the coding that pointed there.
    const id = 'c_' + guid;
    codeIdByGuid.set(guid, id);
    if (!codable && el.getElementsByTagName('Code').length) continue;
    codes.push({
      id,
      name: el.getAttribute('name') || '(code)',
      color: el.getAttribute('color') || PALETTE[codes.length % PALETTE.length],
      group,
      memo: '',
    });
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

/**
 * The Transcripts workspace — the second tab (#139).
 *
 * Why a tab and not a dialog: seven interviews is an ordinary afternoon, and a modal
 * blocks exactly the work it is covering. Here the queue churns in its own space while
 * finished transcripts can be read and checked in the Coding tab beside it.
 *
 * Why CAQDAS owns this at all: the engine hands back DATA and says nothing about what a
 * transcript IS. That decision belongs to whoever is going to use it, and CAQDAS's answer
 * is the shape it already codes — a text document plus a sibling timing value, which gives
 * it a player and a time gutter while leaving char spans, highlights, retrieve and export
 * on the ordinary text path. Another plugin putting the same result in its own dataset
 * would be equally right.
 *
 * Progress is PULLED, not pushed: a function cannot cross the broker's structured clone,
 * so the host cannot hand this frame a callback. `app.transcribe.status()` returns plain
 * data and this polls it.
 */
async function mountTranscripts(app, root) {
  const css = (el, styles) => { Object.assign(el.style, styles); return el; };
  const mk = (tag, styles, text) => {
    const e = document.createElement(tag);
    if (styles) css(e, styles);
    if (text != null) e.textContent = String(text);
    return e;
  };
  // CSSOM, never style attributes: the sandbox CSP is `default-src 'none'`, which blocks
  // an inline style attribute but not a property set through the object model.
  const BTN = { font: 'inherit', padding: '4px 10px', border: '1px solid #ccd2d8',
    borderRadius: '6px', background: '#fff', cursor: 'pointer' };
  const MUTED = { color: '#5b6672', fontSize: '12px' };

  root.replaceChildren();
  css(root, { font: '14px/1.5 system-ui, sans-serif', padding: '12px', color: '#1b2530' });

  const h = mk('h2', { fontSize: '1.05rem', margin: '0 0 2px' }, 'Transcripts');
  const sub = mk('p', { ...MUTED, margin: '0 0 10px' },
    'Speech to text, on this device. Finished transcripts can be coded in the Coding tab.');
  root.append(h, sub);

  // ---- what the engine says it cannot do, before anyone spends an hour finding out ----
  let options = { sizes: [], modes: [], languages: [], limitations: [] };
  try { options = await app.transcribe.options(); } catch { /* capability absent */ }
  if (!app.transcribe?.enqueue) {
    root.append(mk('p', { color: '#b3261e' },
      'Transcription is not available in this build.'));
    return;
  }
  // Five caveats at full length is about fifteen lines, which on a phone pushed every
  // control below the fold — the tab opened on a wall of warnings with nothing to do.
  // The headline of each is still always visible and always said; only the explanation
  // is behind a tap. `short` and `detail` already exist on each limitation for exactly
  // this split, and summaries beat a single "show warnings" toggle because the one that
  // matters to a given researcher is legible without opening anything.
  for (const lim of options.limitations ?? []) {
    const d = mk('details', { ...MUTED, margin: '0 0 6px', borderLeft: '3px solid #e3b341',
      paddingLeft: '8px' });
    const sum = mk('summary', { cursor: 'pointer' }, lim.short || lim.detail);
    // A summary is a legitimate tap target on a phone, so give it a real one.
    css(sum, { padding: '2px 0', minHeight: '24px' });
    d.append(sum, css(mk('p', {}, lim.detail), { margin: '4px 0 6px' }));
    root.append(d);
  }

  // ---- controls -----------------------------------------------------------------
  //
  // One flat wrapping row put "Mode" at the end of the Model line on an iPhone: labels
  // and controls were siblings, so the wrap could fall between a label and the thing it
  // names. Each field is now its OWN flex item that cannot break internally, so wrapping
  // happens between fields and a label always travels with its control.
  const bar = mk('div', { display: 'flex', gap: '8px 14px', alignItems: 'center',
    flexWrap: 'wrap', margin: '10px 0' });

  const UNBREAKABLE = {
    display: 'flex', alignItems: 'center', gap: '6px',
    // Never break inside a field...
    flexWrap: 'nowrap',
    // ...but a field may still shrink to fit a narrow screen rather than overflow it.
    // `minWidth: 0` is the part that actually allows it: a flex item's default min-width
    // is auto, which refuses to go below its content and pushes the row wider than the
    // viewport instead of wrapping.
    minWidth: '0', maxWidth: '100%',
  };

  /**
   * A label and its control as one unwrappable unit — and the control goes INSIDE the
   * label, so the two cannot be separated by a wrap and the label is a real association
   * rather than a word that happens to sit nearby. Clicking "Model" focuses the select.
   */
  const field = (labelText, control) => {
    const l = css(mk('label', { ...MUTED, ...UNBREAKABLE }), {});
    l.append(css(mk('span', {}, labelText), { whiteSpace: 'nowrap' }), control);
    return l;
  };

  /** Several controls that belong together but cannot share one label. */
  const group = (...children) => {
    const g = mk('div', UNBREAKABLE);
    for (const c of children) g.append(c);
    return g;
  };
  const select = (items, value) => {
    // `minWidth: 0` for the same reason as above — "Faster — 16 min per hour of audio
    // (73 MB)" is a wide option, and without this the select refuses to shrink below it
    // and drags the whole row past the edge of a phone screen.
    const s = mk('select', { font: 'inherit', padding: '3px', minWidth: '0', maxWidth: '100%' });
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.id ?? it.code;
      o.textContent = it.label ?? it.name;
      // The upstream model name on hover — not in the label, where "Small" being the
      // bigger of two options just reads as a bug, but reachable for anyone writing up
      // which model produced a transcript.
      if (it.detail) o.title = it.detail;
      s.append(o);
    }
    // `value != null` rather than truthiness: the language default is the empty string
    // (detect automatically), and `if (value)` would skip it and land on whatever happens
    // to be first — which is the same entry here, but only by luck.
    if (value != null) s.value = value;
    return s;
  };
  const sizeSel = select(options.sizes ?? [], 'base');
  const modeSel = select(options.modes ?? [], 'text');
  // Detect, rather than assume English — see core/transcribe.js `options()`.
  const langSel = select(options.languages ?? [], '');
  // ---- transcribe only part of a recording (#193) ---------------------------------
  //
  // Text inputs taking `2:15`, not number inputs taking seconds: nobody knows that the
  // bit they care about starts at 8295 seconds, but `2:15` is what is in their notes and
  // what the player is showing them. The ENGINE parses it — a plugin runs in an
  // opaque-origin sandbox and cannot import `parseClock`, and a second copy of the
  // grammar over here would eventually disagree with the first about something like
  // `2:75` and transcribe the wrong stretch of an interview.
  const timeBox = () => mk('input', {
    font: 'inherit', padding: '3px', width: '72px', minWidth: '0',
  });
  const fromIn = timeBox();
  const toIn = timeBox();
  fromIn.placeholder = '0:00';
  toIn.placeholder = 'end';
  fromIn.setAttribute('aria-label', 'Transcribe from');
  toIn.setAttribute('aria-label', 'Transcribe until');
  const rangeNote = mk('span', MUTED, '');
  const allBtn = css(mk('button', BTN, 'Transcribe all'), { fontWeight: '600' });
  const pauseBtn = mk('button', BTN, 'Pause');
  bar.append(
    field('Model', sizeSel),
    field('Mode', modeSel),
    field('Language', langSel),
    // From and to stay on ONE line: a range split across two reads as two settings
    // rather than as two ends of the same one.
    group(field('From', fromIn), field('to', toIn)),
    group(allBtn, pauseBtn),
  );
  root.append(bar);
  root.append(css(mk('p', MUTED, 'Leave From and to empty to transcribe the whole '
    + 'recording. A range applies to whichever recordings you start next, and the '
    + 'transcript keeps the original times — so 2:15 in the audio is still 2:15 in the '
    + 'transcript.'), { margin: '0 0 8px' }));
  root.append(css(rangeNote, { display: 'block', margin: '0 0 8px', color: '#e06c75' }));

  const capacityLine = mk('p', { ...MUTED, margin: '0 0 8px' }, '');
  root.append(capacityLine);

  // Work the tab cannot match to a row in front of the user — a job started against a
  // dataset since switched away from, or one whose row id changed under it. It is shown
  // rather than hidden: an invisible job is how an hour of transcription disappears with
  // nobody told, which is exactly what happened on a phone.
  const orphanLine = mk('p', { ...MUTED, margin: '0 0 8px' });
  orphanLine.hidden = true;
  const orphanDiscard = mk('button', BTN, 'Discard them');
  root.append(orphanLine);

  const tableWrap = mk('div', { overflowX: 'auto' });
  const table = mk('table', { borderCollapse: 'collapse', width: '100%', fontSize: '13px' });
  tableWrap.append(table);
  root.append(tableWrap);

  const footer = mk('div', { display: 'flex', gap: '8px', alignItems: 'center',
    margin: '12px 0' });
  const saveBtn = mk('button', BTN, 'Save transcripts to a new dataset');
  const saveNote = mk('span', MUTED, '');
  footer.append(saveBtn, saveNote);
  root.append(footer);

  // ---- the media in this dataset --------------------------------------------------
  //
  // Found by SHAPE, not by column name — the same rule the Coding tab uses to spot a
  // media document, because a name breaks the moment someone renames a column or joins
  // two datasets.
  let rows = [];
  let mediaColumn = null;
  let labelColumn = null;

  async function loadMedia() {
    rows = [];
    mediaColumn = null;
    const meta = await app.data.getVariableMeta();
    const names = meta.filter((m) => m.type !== 'numeric').map((m) => m.name);
    if (!names.length) return;
    const [probe] = await app.data.getRows({ variables: names, limit: 1 });
    if (!probe) return;
    mediaColumn = names.find((n) => parseMediaRefs(String(probe[n] ?? ''))) ?? null;
    if (!mediaColumn) return;
    labelColumn = names.find((n) => n !== mediaColumn) ?? null;
    const want = labelColumn ? [mediaColumn, labelColumn] : [mediaColumn];
    const got = await app.data.getRows({ variables: want, includeRowId: true, limit: 500 });
    rows = got.map((r) => {
      const refs = parseMediaRefs(String(r[mediaColumn] ?? ''));
      return refs ? {
        rid: String(r.__rid),
        ref: refs[0],
        label: labelColumn && r[labelColumn] != null ? String(r[labelColumn]) : `Row ${r.__rid}`,
      } : null;
    }).filter(Boolean);
  }

  // ---- transcripts we already have -------------------------------------------------
  //
  // Kept in workspace state so a finished transcript survives a tab switch, a reload and
  // a reopened project — losing an hour of transcription to a navigation would be
  // unforgivable, and the engine's queue is memory-only by design.
  let saved = {};
  // rid → the queue job id working on it. PERSISTED, for the same reason the finished
  // transcripts are: this tab is an iframe that gets re-created — by a dataset switch, a
  // project switch, the Restart button, or iOS discarding it under the memory pressure
  // that transcription itself creates. Every mount used to start with an empty Map, so a
  // remount mid-run orphaned the job: the row fell back to idle as though nothing had
  // been started, and because harvesting only ever walks this map, the transcript the
  // engine went on to finish was never collected. Reported from a phone as a 21-minute
  // interview that "stopped at part 2" and left no trace.
  let pending = {};
  // rid → why the last attempt failed. KEPT, because the old code deleted the row's job
  // mapping the instant a job failed, which made `describe()` find no job and render the
  // row as idle — so a failure looked exactly like never having pressed the button. The
  // engine's `job.error` was discarded on the very next poll and never shown anywhere.
  // Reported from a phone as "Failed, no status": language detected, "clip 0 of 11", and
  // then straight back to idle with nothing in Output and nothing in the row.
  let failures = {};
  try {
    const st = (await app.state.get()) ?? {};
    saved = st.transcripts ?? {};
    pending = st.transcribing ?? {};
    failures = st.transcribeFailures ?? {};
  } catch { saved = {}; pending = {}; failures = {}; }
  const persist = async () => {
    try {
      const cfg = (await app.state.get()) ?? {};
      await app.state.set({
        ...cfg, transcripts: saved, transcribing: pending, transcribeFailures: failures,
      });
    } catch (e) { console.warn('[caqdas] could not persist transcripts', e); }
  };

  /** rid → the queue job id currently working on it, restored from the last mount. */
  const jobOf = new Map(Object.entries(pending));

  async function startOne(row) {
    if (jobOf.has(row.rid) || saved[row.rid]) return;
    // A new attempt clears the old verdict — otherwise the row would show a stale
    // failure next to work that is running again.
    if (failures[row.rid]) { delete failures[row.rid]; await persist(); }
    const blob = await app.assets.load(row.ref);
    const bytes = await blob.arrayBuffer();
    const { id } = await app.transcribe.enqueue(bytes, {
      name: row.label,
      mode: modeSel.value || 'text',
      size: sizeSel.value || 'base',
      // '' means detect; the worker treats any falsy language as "no language given".
      language: langSel.value,
      // Raw text, straight through. The engine parses and clamps, and throws if it is not
      // a time — so the message the user sees is the engine's own and there is no second
      // opinion about what `2:15` means.
      from: fromIn.value.trim(),
      to: toIn.value.trim(),
    });
    jobOf.set(row.rid, id);
    // Written BEFORE the work is done, not after: the whole point is to survive the
    // thing that happens while it is still running.
    pending[row.rid] = id;
    await persist();
  }

  allBtn.addEventListener('click', async () => {
    allBtn.disabled = true;
    rangeNote.textContent = '';
    try {
      for (const row of rows) await startOne(row);
    } catch (e) {
      rangeNote.textContent = e.message;
    } finally {
      allBtn.disabled = false;
    }
  });

  orphanDiscard.addEventListener('click', async () => {
    orphanDiscard.disabled = true;
    try {
      // `forget` only drops jobs that have finished, failed or been cancelled, so this
      // cannot throw away work still in progress — it tidies, it does not stop anything.
      await app.transcribe.forget();
      await refresh();
    } finally { orphanDiscard.disabled = false; }
  });

  pauseBtn.addEventListener('click', async () => {
    const s = await app.transcribe.status();
    if (s.paused) await app.transcribe.resume();
    else await app.transcribe.pause();
    await refresh();
  });

  saveBtn.addEventListener('click', async () => {
    const done = rows.filter((r) => saved[r.rid]);
    if (!done.length) { saveNote.textContent = 'Nothing transcribed yet.'; return; }
    saveBtn.disabled = true;
    try {
      // A NEW dataset, because the plugin API has no add-a-column-here: `data.create` is
      // the only write. The media column travels with it so the transcript sits beside
      // the recording it came from, and the timing column is what makes CAQDAS render it
      // as a playable transcript rather than a wall of text.
      const name = `${mediaColumn || 'media'} — transcripts`;
      const variables = [
        { name: 'label', type: 'text' },
        { name: 'media', type: 'text' },
        { name: 'transcript', type: 'text' },
        { name: 'transcript_timing', type: 'text' },
        // Provenance in the data, not only in the UI that made it: a transcript read as
        // the wrong language is fluent and confident, so the language has to survive into
        // the dataset or the mistake becomes unfindable later.
        { name: 'transcript_language', type: 'text' },
        { name: 'transcript_range', type: 'text' },
      ];
      const columns = {
        label: done.map((r) => r.label),
        media: done.map((r) => JSON.stringify([r.ref])),
        transcript: done.map((r) => saved[r.rid].text),
        // Already a string — `timingValue` serialises it. Stringifying again would store
        // a quoted JSON blob that parseTiming rejects, and the transcript would land in
        // the dataset as plain text with no player and no gutter.
        transcript_timing: done.map((r) => saved[r.rid].timing),
        transcript_range: done.map((r) => {
          const rg = saved[r.rid].range;
          if (!rg) return 'whole recording';
          const c = (secs) => {
            const t = Math.max(0, Math.round(Number(secs) || 0));
            const m = Math.floor(t / 60);
            return `${m}:${String(t % 60).padStart(2, '0')}`;
          };
          return `${c(rg.from)}-${c(rg.to)}`;
        }),
        transcript_language: done.map((r) => {
          const t = saved[r.rid];
          if (!t.language) return '';
          const d = t.detection;
          return d ? `${d.name} (detected, ${Math.round((d.confidence ?? 0) * 100)}%)` : t.language;
        }),
      };
      await app.data.create({ name, variables, columns, activate: false });
      saveNote.textContent = `Saved ${done.length} transcript(s) as "${name}". `
        + 'Switch the Coding tab to it to code them against the audio.';
    } catch (e) {
      saveNote.textContent = `Could not save: ${e.message}`;
    } finally {
      saveBtn.disabled = false;
    }
  });

  /** mm:ss for messages, outside describe()'s scope. */
  const clockOf = (secs) => {
    const t = Math.max(0, Math.round(Number(secs) || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
  };

  // ---- render ---------------------------------------------------------------------
  function describe(job, row) {
    // Which language a recording was READ AS travels with every state, because a batch of
    // seven interviews is exactly where a wrong guess hides: nobody is watching a dialog,
    // and the wrong language produces fluent prose rather than an error. "(detected)"
    // distinguishes a guess from a choice — they are different claims about the same text.
    // Same argument as the language: a transcript of the wrong five minutes reads like a
    // perfectly good transcript, so which stretch it covers travels with it.
    const clock = (secs) => {
      const t = Math.max(0, Math.round(Number(secs) || 0));
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
    };
    const span = (r) => (r ? ` · ${clock(r.from)}–${clock(r.to)}` : '');

    const heard = (j) => {
      if (!j?.language) return '';
      const d = j.detection;
      if (!d) return ` · ${j.language}`;
      const pct = Math.round((d.confidence ?? 0) * 100);
      const alt = d.mixed ? `, also heard ${d.dissenting.map((x) => x.name).join(', ')}` : '';
      return ` · ${d.name} detected ${pct}%${alt}`;
    };

    if (saved[row.rid]) {
      const words = saved[row.rid].text.trim() ? saved[row.rid].text.trim().split(/\s+/).length : 0;
      const gaps = saved[row.rid].missing;
      const holes = gaps?.length
        ? ` · ${gaps.length} of ${gaps[0].total} parts missing `
          + `(${gaps.map((g) => `${clock(g.from)}–${clock(g.to)}`).join(', ')})`
        : '';
      return {
        state: gaps?.length ? 'partly transcribed' : 'transcribed',
        detail: `${words} words${holes}${span(saved[row.rid].range)}${heard(saved[row.rid])}`,
      };
    }
    // A remembered failure outranks "idle": the row must not look untouched after an
    // attempt that went wrong.
    if (!job && failures[row.rid]) return { state: 'failed', detail: failures[row.rid].message };
    if (!job) return { state: '—', detail: '' };
    if (job.progress?.stage === 'detect') {
      return { state: 'running', detail: 'working out the language…' };
    }
    if (job.state === 'running' && job.progress?.total) {
      return {
        state: 'running',
        detail: `part ${job.progress.done} of ${job.progress.total}${span(job.range)}${heard(job)}`,
      };
    }
    if (job.state === 'running' && job.progress?.elapsedMs != null) {
      return {
        state: 'running',
        detail: `${Math.round(job.progress.elapsedMs / 1000)}s${span(job.range)}${heard(job)}`,
      };
    }
    if (job.state === 'queued' && job.range) {
      return { state: 'queued', detail: `${clock(job.range.from)}–${job.range.to ? clock(job.range.to) : 'end'}` };
    }
    return { state: job.state, detail: job.error ?? '' };
  }

  async function refresh() {
    let status = { jobs: [], paused: false, capacity: {} };
    try { status = await app.transcribe.status(); } catch { /* keep the last view */ }
    const byId = new Map(status.jobs.map((j) => [j.id, j]));

    // ---- re-attach work this tab has lost sight of ---------------------------------
    //
    // A restored mapping can name a job the engine no longer has (it was forgotten, or
    // the page reloaded and took the queue with it). Drop those rather than show a row
    // waiting forever on something that does not exist.
    let changed = false;
    for (const [rid, id] of [...jobOf]) {
      if (!byId.has(id)) { jobOf.delete(rid); delete pending[rid]; changed = true; }
    }

    // And adopt a job that is plainly ours but whose mapping did not survive — the row
    // ids themselves change when a dataset is reloaded, so the persisted map is not
    // always enough. Jobs carry the row's label as their name, which is the only other
    // handle we have. ONLY when the pairing is unambiguous: one row with that label, one
    // unattached job with that name. A guess that attaches a transcript to the wrong
    // recording would be worse than leaving it unattached, where it is at least visible.
    const attached = new Set(jobOf.values());
    const live = status.jobs.filter((j) => !attached.has(j.id));
    for (const job of live) {
      const matches = rows.filter((r) => r.label === job.name && !jobOf.has(r.rid) && !saved[r.rid]);
      const sameName = live.filter((j) => j.name === job.name);
      if (matches.length === 1 && sameName.length === 1) {
        jobOf.set(matches[0].rid, job.id);
        pending[matches[0].rid] = job.id;
        attached.add(job.id);
        changed = true;
      }
    }
    if (changed) await persist();

    // Whatever is still unattached is reported rather than hidden. An invisible job is
    // how an hour of transcription disappears without anybody being told.
    const orphans = status.jobs.filter((j) => !attached.has(j.id));

    // Harvest anything that finished since the last tick.
    for (const [rid, id] of [...jobOf]) {
      const job = byId.get(id);
      if (!job) continue;
      if (job.state === 'done' && !saved[rid]) {
        const row = rows.find((r) => r.rid === rid);
        const result = await app.transcribe.result(id);
        if (result) {
          saved[rid] = transcriptToDocument(result, row?.ref ?? null);
          await persist();
          // A partial transcript is a SUCCESS with a caveat, and the caveat belongs in
          // the record as well as on the row — a gap found months later, in a dataset,
          // with no idea why, is how a quotation goes missing from an analysis.
          const gaps = saved[rid].missing;
          if (gaps?.length) {
            app.results?.appendError?.(
              `Transcribed "${row?.label ?? rid}" with ${gaps.length} of ${gaps[0].total} `
              + `parts missing: ${gaps.map((g) => `${clockOf(g.from)}–${clockOf(g.to)}`).join(', ')}. `
              + 'The gaps are marked in the transcript. "Try again" re-runs the whole recording.',
            );
          }
        }
        jobOf.delete(rid);
        delete pending[rid];
        await persist();
        await app.transcribe.forget(id);
      } else if (job.state === 'failed' || job.state === 'cancelled') {
        // The mapping still goes — the engine's job is finished with — but WHY is kept,
        // so the row can say what happened instead of quietly returning to idle.
        if (job.state === 'failed') {
          failures[rid] = {
            message: job.error || 'Transcription failed, and the engine gave no reason.',
            at: Date.now(),
          };
          const row = rows.find((r) => r.rid === rid);
          // Also into Output, which is where a user looks for a record of what the app
          // did — and where this user looked and found nothing.
          app.results?.appendError?.(
            `Transcribing "${row?.label ?? rid}" failed: ${failures[rid].message}`,
          );
        }
        jobOf.delete(rid);
        delete pending[rid];
        await persist();
        // Let the engine drop it: the reason is ours now, and leaving it in the queue
        // would make it an unattached job and show up as orphaned work.
        await app.transcribe.forget(id);
      }
    }

    if (orphans.length) {
      const running = orphans.filter((j) => j.state === 'running' || j.state === 'queued').length;
      const finished = orphans.filter((j) => j.state === 'done').length;
      const parts = [];
      if (running) parts.push(`${running} still working`);
      if (finished) parts.push(`${finished} finished but unclaimed`);
      orphanLine.replaceChildren(
        document.createTextNode(
          `${orphans.length} transcription${orphans.length > 1 ? 's' : ''} not matched to a `
          + `recording here (${parts.join(', ') || 'stopped'}): `
          + `${orphans.map((j) => j.name).join(', ')}. `
          + 'They belong to another dataset, or to rows that have since changed. ',
        ),
        orphanDiscard,
      );
      orphanLine.hidden = false;
    } else {
      orphanLine.hidden = true;
    }

    pauseBtn.textContent = status.paused ? 'Resume' : 'Pause';
    const cap = status.capacity ?? {};
    capacityLine.textContent = status.paused
      ? 'Paused — the segment in progress will finish, then nothing else starts.'
      : (cap.basis ? `Running ${cap.basis}.` : '');

    table.replaceChildren();
    const head = mk('tr');
    for (const label of ['Recording', 'State', 'Progress', '']) {
      head.append(css(mk('th', { textAlign: 'left', padding: '4px 8px',
        borderBottom: '1px solid #d8dde2', ...MUTED }, label), {}));
    }
    table.append(head);
    if (!rows.length) {
      const tr = mk('tr');
      const td = mk('td', { padding: '8px', ...MUTED },
        mediaColumn
          ? 'No media in this dataset.'
          : 'No media column found. Import audio or video first, then come back.');
      td.colSpan = 4;
      tr.append(td);
      table.append(tr);
      return;
    }
    for (const row of rows) {
      const job = byId.get(jobOf.get(row.rid));
      const d = describe(job, row);
      const tr = mk('tr');
      tr.append(mk('td', { padding: '4px 8px', borderBottom: '1px solid #eef1f4' }, row.label));
      tr.append(mk('td', { padding: '4px 8px', borderBottom: '1px solid #eef1f4' }, d.state));
      tr.append(mk('td', { padding: '4px 8px', borderBottom: '1px solid #eef1f4', ...MUTED }, d.detail));
      const actions = mk('td', { padding: '4px 8px', borderBottom: '1px solid #eef1f4' });
      if (saved[row.rid]) {
        const again = mk('button', BTN, 'Redo');
        again.addEventListener('click', async () => {
          try {
            rangeNote.textContent = '';
            delete saved[row.rid];
            await persist();
            await startOne(row);
            await refresh();
          } catch (e) {
            // Redo had no handler at all: a mistyped range rejected into nothing, the
            // transcript was already deleted, and the row just went blank.
            rangeNote.textContent = e.message;
            await refresh();
          }
        });
        actions.append(again);
      } else if (job && (job.state === 'running' || job.state === 'queued')) {
        const stop = mk('button', BTN, 'Stop');
        stop.addEventListener('click', async () => {
          await app.transcribe.cancel(job.id);
          jobOf.delete(row.rid);
          delete pending[row.rid];
          await persist();
          await refresh();
        });
        actions.append(stop);
      } else {
        // "Try again" rather than "Transcribe" after a failure: the same button doing
        // the same thing, but it tells the user the row has been attempted before.
        const go = mk('button', BTN, failures[row.rid] ? 'Try again' : 'Transcribe');
        go.addEventListener('click', async () => {
          try {
            rangeNote.textContent = '';
            await startOne(row);
            await refresh();
          } catch (e) {
            rangeNote.textContent = e.message;
          }
        });
        actions.append(go);
      }
      tr.append(actions);
      table.append(tr);
    }
  }

  await loadMedia();
  await refresh();
  // Polling, because progress cannot be pushed across the broker. Slow enough not to
  // matter, fast enough that a finished transcript appears while the next is still
  // running — which is the whole point of the tab.
  const timer = setInterval(() => { void refresh(); }, 800);
  root.addEventListener('ct-unmount', () => clearInterval(timer), { once: true });
}
