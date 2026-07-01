/**
 * @file r-script.js
 * "Run R script…" (#136, Phase 1) — a host-side interop lane: run a user's `.R`
 * against the active dataset in the persistent WebR session, show its text output +
 * plots, then optionally import a data frame the script produced as a NEW CrossTab
 * dataset (the reverse bridge — the only R→CrossTab data path).
 *
 * Design notes:
 *  - Runs in the SAME persistent R global env as the R Console (via `evalConsole`),
 *    so the script's data frames survive the call for the reverse bridge. The active
 *    dataset is bound as a data.frame named `data` (via `bindGlobalFrame`).
 *  - R (WebR) and the data store (DuckDB) are separate WASM sandboxes with no shared
 *    memory — a script CANNOT touch the DB or the real disk. `write.csv(...)` etc.
 *    write to R's own throwaway VFS. Data only crosses back via the explicit,
 *    user-chosen "import a frame" action here.
 *  - Phase 1 shows results in a modal; Phase 2 will promote this to a persisted,
 *    replayable Output/History step.
 */

const FILE_ACCEPT = '.R,.r,.txt,text/plain';

/** Enumerate data.frames in the R global env → {names[], nrow[], ncol[]}. */
const ENUM_R =
  'local({ nms <- ls(envir = globalenv()); ' +
  'keep <- nms[vapply(nms, function(n) is.data.frame(get(n, envir = globalenv())), logical(1))]; ' +
  'data.frame(name = keep, ' +
  'nrow = vapply(keep, function(n) nrow(get(n, envir = globalenv())), integer(1)), ' +
  'ncol = vapply(keep, function(n) ncol(get(n, envir = globalenv())), integer(1)), ' +
  'stringsAsFactors = FALSE) })';

/** R to extract one frame by name, factors coerced to character for a clean import. */
function extractR(name) {
  return (
    `local({ .d <- as.data.frame(get(${rStr(name)}, envir = globalenv()), ` +
    'stringsAsFactors = FALSE, check.names = FALSE); ' +
    '.d[] <- lapply(.d, function(c) if (is.factor(c)) as.character(c) else c); .d })'
  );
}

/**
 * Open the "Run R script…" flow: pick a file, run it, show output + plots, offer to
 * import a resulting frame.
 * @param {{ webr: object, datasets: object }} deps
 */
export function runRScript({ webr, datasets }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FILE_ACCEPT;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    const text = await file.text();
    openRunDialog({ webr, datasets, filename: file.name, script: text });
  });
  document.body.append(input);
  input.click();
}

function openRunDialog({ webr, datasets, filename, script }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog';
  dialog.style.cssText = 'max-width:820px; width:94vw;';
  const form = el('form', null, 'ct-dialog__form');
  form.method = 'dialog';
  form.style.cssText = 'padding:0; display:flex; flex-direction:column; max-height:88vh;';

  const head = el('div', null);
  head.style.cssText = 'display:flex; align-items:baseline; gap:10px; padding:16px 20px 10px; border-bottom:1px solid var(--line,#e2e7ec);';
  const title = el('h2', 'Run R script', 'ct-dialog__title');
  title.style.margin = '0';
  const fname = el('span', filename);
  fname.style.cssText = 'font-size:12.5px; color:#7a8590;';
  const closeX = el('button', '✕');
  closeX.type = 'submit';
  closeX.value = 'cancel';
  closeX.title = 'Close';
  closeX.style.cssText = 'margin-left:auto; border:0; background:none; font-size:16px; cursor:pointer; color:#5a6470;';
  head.append(title, fname, closeX);

  const body = el('div', null);
  body.style.cssText = 'overflow:auto; padding:14px 20px 20px;';
  const note = el('p', 'Your active dataset is available in R as a data.frame named `data`. Output and plots appear below; the script runs in R only — it can’t change your dataset.');
  note.style.cssText = 'margin:0 0 12px; font-size:12.5px; color:#5a6470; line-height:1.5;';
  const status = el('div', 'Running…');
  status.style.cssText = 'font-size:13px; color:#5a6470; margin:0 0 12px;';
  const outWrap = el('div', null);
  const importWrap = el('div', null);
  body.append(note, status, outWrap, importWrap);

  form.append(head, body);
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  void execute({ webr, datasets, script, status, outWrap, importWrap });
}

async function execute({ webr, datasets, script, status, outWrap, importWrap }) {
  try {
    const meta = (await datasets.getVariableMeta?.()) ?? [];
    const cols = meta.map((m) => m.name);
    if (cols.length) await webr.bindGlobalFrame('data', cols);

    const res = await webr.evalConsole(script);
    status.remove();

    if (res.output && res.output.trim()) {
      const pre = el('pre');
      pre.textContent = res.output;
      pre.style.cssText =
        'margin:0 0 12px; padding:10px 12px; background:#f6f8fa; border:1px solid var(--line,#e2e7ec); ' +
        'border-radius:6px; overflow:auto; max-height:340px; white-space:pre-wrap; word-break:break-word; ' +
        `font:12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color:${res.error ? '#7a201a' : '#243'};`;
      outWrap.append(pre);
    }
    for (const img of res.images || []) outWrap.append(plotCanvas(img));
    if (!(res.output && res.output.trim()) && !(res.images || []).length) {
      outWrap.append(hint('The script ran with no printed output or plots.'));
    }

    await buildImportSection({ webr, datasets, importWrap });
  } catch (err) {
    status.textContent = '';
    outWrap.append(errorBox(`Could not run the script: ${err?.message || err}`));
  }
}

/** After a run, list the data frames the script produced and offer to import one. */
async function buildImportSection({ webr, datasets, importWrap }) {
  let frames = [];
  try {
    const { result } = await webr.run(ENUM_R);
    frames = parseEnum(result).filter((f) => f.name !== 'data'); // exclude the bound input
  } catch { /* enumeration failed — just skip the import offer */ }
  if (!frames.length) return;

  const wrap = el('div', null);
  wrap.style.cssText = 'margin-top:14px; padding-top:14px; border-top:1px solid var(--line,#e2e7ec);';
  wrap.append(sectionHeading('Import a result as a new dataset'));

  const row = el('div', null);
  row.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';
  const select = document.createElement('select');
  select.style.cssText = 'font:inherit; font-size:13px; padding:6px 8px; border:1px solid var(--line,#d8dee4); border-radius:6px;';
  for (const f of frames) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = `${f.name}  (${f.nrow} × ${f.ncol})`;
    select.append(opt);
  }
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'New dataset name';
  nameInput.value = frames[0].name;
  nameInput.style.cssText = 'font:inherit; font-size:13px; padding:6px 8px; border:1px solid var(--line,#d8dee4); border-radius:6px; flex:1 1 160px; min-width:120px;';
  select.addEventListener('change', () => { nameInput.value = select.value; });
  const btn = el('button', 'Import', 'ct-dialog__primary');
  btn.type = 'button';
  btn.style.cssText = 'font:inherit; font-size:13px; padding:6px 14px; border-radius:6px; cursor:pointer; background:var(--accent,#2980b9); color:#fff; border:1px solid var(--accent,#2980b9);';
  const msg = el('span');
  msg.style.cssText = 'font-size:12.5px; margin-left:4px;';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = 'Importing…';
    msg.style.color = '#5a6470';
    try {
      const { result } = await webr.run(extractR(select.value));
      const { variables, columns } = frameToDataset(result);
      if (!variables.length) throw new Error('no columns found in that frame');
      await datasets.createWithData({ name: (nameInput.value || select.value).trim() || select.value, variables, columns, activate: true });
      msg.textContent = `Imported “${(nameInput.value || select.value).trim()}” as a new dataset.`;
      msg.style.color = '#1a7a3a';
    } catch (err) {
      msg.textContent = `Import failed: ${err?.message || err}`;
      msg.style.color = '#7a201a';
    } finally {
      btn.disabled = false;
    }
  });

  row.append(select, nameInput, btn);
  wrap.append(row, msg);
  importWrap.append(wrap);
}

// --- toJs parsing ------------------------------------------------------------

/** WebR toJs of a column is `{type, values:[…]}`; sometimes a bare array. */
function colValues(c) {
  return Array.isArray(c?.values) ? c.values : Array.isArray(c) ? c : [];
}

/** Parse the ENUM_R result → [{name, nrow, ncol}]. */
function parseEnum(result) {
  const v = result?.values;
  if (!Array.isArray(v) || v.length < 3) return [];
  const names = colValues(v[0]);
  const nrow = colValues(v[1]);
  const ncol = colValues(v[2]);
  return names.map((name, i) => ({ name: String(name), nrow: Number(nrow[i] ?? 0), ncol: Number(ncol[i] ?? 0) }));
}

/** Parse an extracted data.frame → {variables, columns} for createWithData. */
function frameToDataset(result) {
  const names = result?.names || [];
  const vals = result?.values || [];
  const variables = [];
  const columns = {};
  names.forEach((name, i) => {
    const col = vals[i];
    const numeric = col?.type === 'double' || col?.type === 'integer';
    variables.push({ name: String(name), type: numeric ? 'numeric' : 'string', measurementLevel: numeric ? 'scale' : 'nominal' });
    columns[String(name)] = colValues(col);
  });
  return { variables, columns };
}

// --- small DOM helpers -------------------------------------------------------

function plotCanvas(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.style.cssText = 'max-width:100%; height:auto; border:1px solid var(--line,#e2e7ec); border-radius:6px; margin:0 0 12px; display:block;';
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas;
}

function errorBox(text) {
  const d = el('div', text);
  d.style.cssText = 'background:#fdf3f2; color:#7a201a; font-size:13px; padding:10px 12px; border:1px solid #f0d8d5; border-radius:6px; white-space:pre-wrap;';
  return d;
}

function hint(text) {
  const d = el('div', text);
  d.style.cssText = 'font-size:12.5px; color:#7a8590;';
  return d;
}

function sectionHeading(text) {
  const h = el('h3', text);
  h.style.cssText = 'margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#7a8590;';
  return h;
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

/** A double-quoted R string literal. */
function rStr(s) {
  return '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
