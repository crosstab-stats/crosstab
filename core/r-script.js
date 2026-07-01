/**
 * @file r-script.js
 * "Run R script…" (#136 Phase 1 + #137 Phase 2) — an interop lane: run a user's `.R`
 * against the active dataset in the persistent WebR session, append its text output +
 * plots to the **Output pane as a replayable, persisted step**, then optionally import
 * a data frame the script produced as a NEW CrossTab dataset (the reverse bridge — the
 * only R→CrossTab data path).
 *
 * Architecture:
 *  - The RUN is a HOST ACTION recorded in the analysis log (`pluginActions.runHost`),
 *    so it shows in History, persists in the project, and re-runs on replay/undo —
 *    framed exactly like a plugin analysis. The registered runner does the work:
 *    bind the active data as `data`, `evalConsole` the script (persistent global env —
 *    so plots + frames survive), append the printed output + plot images to Output.
 *  - Because the script runs in the PERSISTENT env, the frames it created are still
 *    alive afterward for the reverse bridge (a separate, user-picked import).
 *  - R (WebR) and the data store (DuckDB) are separate WASM sandboxes: a script can't
 *    touch the DB or the real disk. The import step is the only R→CrossTab path.
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
 * Register the "rscript" host runner with PluginActions — the code that actually runs
 * a script and appends its output to the Output pane (called on run AND on replay).
 * @param {{ pluginActions: object, results: object, webr: object, datasets: object }} deps
 */
export function registerRScriptRunner({ pluginActions, results, webr, datasets }) {
  pluginActions.registerHost('rscript', async ({ script }) => {
    const meta = (await datasets.getVariableMeta?.()) ?? [];
    const cols = meta.map((m) => m.name);
    if (cols.length) await webr.bindGlobalFrame('data', cols);

    const res = await webr.evalConsole(String(script ?? ''));
    const out = (res.output || '').trim();
    if (out) results.appendText('```\n' + out + '\n```'); // fenced → monospace, whitespace kept
    for (const img of res.images || []) {
      const src = bitmapToPng(img);
      if (src) results.appendImage(src, { alt: 'R plot' });
    }
    if (!out && !(res.images || []).length) results.appendText('_The script ran with no printed output or plots._');
    if (res.error) results.appendError('R reported an error (see the output above).');
  });
}

/**
 * Menu command: pick a `.R`, run it as a recorded Output/History step, then offer to
 * import a resulting data frame as a new dataset.
 * @param {{ pluginActions: object, webr: object, datasets: object }} deps
 */
export function runRScript({ pluginActions, webr, datasets }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FILE_ACCEPT;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    const script = await file.text();
    const label = `R script: ${file.name}`;
    await pluginActions.runHost({ host: 'rscript', label, inputs: { script } });
    await offerImport({ webr, datasets });
  });
  document.body.append(input);
  input.click();
}

/** After a run, if the script left data frames in R, offer to import one. */
async function offerImport({ webr, datasets }) {
  let frames = [];
  try {
    const { result } = await webr.run(ENUM_R);
    frames = parseEnum(result).filter((f) => f.name !== 'data');
  } catch { return; }
  if (!frames.length) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog';
  dialog.style.cssText = 'max-width:520px; width:92vw;';
  const form = el('form', null, 'ct-dialog__form');
  form.method = 'dialog';
  form.append(el('h2', 'Import a result as a dataset', 'ct-dialog__title'));
  const hint = el('p', 'Your R script produced these data frames. Import one as a new CrossTab dataset (optional).');
  hint.style.cssText = 'margin:0 0 14px; font-size:13px; color:#5a6470; line-height:1.5;';
  form.append(hint);

  const row = el('div', null);
  row.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 12px;';
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
  nameInput.value = frames[0].name;
  nameInput.style.cssText = 'font:inherit; font-size:13px; padding:6px 8px; border:1px solid var(--line,#d8dee4); border-radius:6px; flex:1 1 140px; min-width:110px;';
  select.addEventListener('change', () => { nameInput.value = select.value; });
  row.append(select, nameInput);
  form.append(row);

  const msg = el('div');
  msg.style.cssText = 'font-size:12.5px; margin:0 0 12px; min-height:16px;';
  form.append(msg);

  const menu = el('menu', null, 'ct-dialog__buttons');
  menu.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; margin:0; padding:0;';
  const close = el('button', 'Done');
  close.type = 'submit';
  close.value = 'cancel';
  const importBtn = el('button', 'Import', 'ct-dialog__primary');
  importBtn.type = 'button';
  importBtn.style.cssText = 'background:var(--accent,#2980b9); color:#fff; border:1px solid var(--accent,#2980b9); border-radius:6px; padding:6px 14px; cursor:pointer;';
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    msg.textContent = 'Importing…';
    msg.style.color = '#5a6470';
    try {
      const { result } = await webr.run(extractR(select.value));
      const { variables, columns } = frameToDataset(result);
      if (!variables.length) throw new Error('no columns found in that frame');
      const name = (nameInput.value || select.value).trim() || select.value;
      await datasets.createWithData({ name, variables, columns, activate: true });
      msg.textContent = `Imported “${name}” as a new dataset.`;
      msg.style.color = '#1a7a3a';
    } catch (err) {
      msg.textContent = `Import failed: ${err?.message || err}`;
      msg.style.color = '#7a201a';
    } finally {
      importBtn.disabled = false;
    }
  });
  menu.append(importBtn, close);
  form.append(menu);

  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// --- toJs parsing ------------------------------------------------------------

function colValues(c) {
  return Array.isArray(c?.values) ? c.values : Array.isArray(c) ? c : [];
}

function parseEnum(result) {
  const v = result?.values;
  if (!Array.isArray(v) || v.length < 3) return [];
  const names = colValues(v[0]);
  const nrow = colValues(v[1]);
  const ncol = colValues(v[2]);
  return names.map((name, i) => ({ name: String(name), nrow: Number(nrow[i] ?? 0), ncol: Number(ncol[i] ?? 0) }));
}

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

// --- helpers -----------------------------------------------------------------

/** Rasterise a captured plot (ImageBitmap) to a PNG data URL for the Output pane. */
function bitmapToPng(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
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
