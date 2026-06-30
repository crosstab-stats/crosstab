/**
 * @file syntax-guide.js
 * The "Syntax guide" overlay opened from the History ▸ Syntax editor (#135).
 *
 * Two parts: a STATIC reference for CrossTab's command grammar (kept in step with
 * core/crosstab-syntax.js), and a LIVE list of the analyses/plugins you can call via
 * `run pluginId.fn {…}` — enumerated from {@link PluginActions.listRunnable} so it
 * shows exactly what the *currently active* plugins accept, plus each plugin's
 * optional `howto`. (That live half is why this is an in-app overlay, not a static
 * doc page: a flat HTML file couldn't reflect which plugins are active.)
 *
 * All dynamic text is set via textContent — an authored `howto`/label can never
 * inject markup.
 */

/** The command grammar, mirrored from crosstab-syntax.js. Each: the form, what it
 * does, and a runnable example. */
const COMMANDS = [
  { syntax: 'compute NAME [as TYPE] = EXPR', desc: 'Create or overwrite a variable from a DuckDB expression.', eg: 'compute bmi = weight / pow(height / 100, 2)' },
  { syntax: 'recode SRC into NAME [as TYPE]: RULES', desc: 'Map values into a new variable. Rules: `V -> TO`, `LO..HI -> TO`, `missing -> TO`, and a trailing `else TO`. TO is a value, `copy`, or `sysmis`.', eg: 'recode age into agegrp: 0..17 -> 1; 18..64 -> 2; else 3' },
  { syntax: 'keep if EXPR', desc: 'Filter rows — keep only those where the boolean expression holds.', eg: 'keep if region = 1 and age >= 18' },
  { syntax: 'set cell row N COLUMN = VALUE', desc: 'Edit one cell. Row is 1-based; an empty string ("") sets it blank (NA).', eg: 'set cell row 8 income = 52000' },
  { syntax: 'label variable NAME "Text"', desc: 'Set a variable’s descriptive label.', eg: 'label variable agegrp "Age group"' },
  { syntax: 'label values NAME code "Label", …', desc: 'Attach value labels to codes.', eg: 'label values agegrp 1 "Minor", 2 "Adult", 3 "Senior"' },
  { syntax: 'set type NAME = numeric | string | factor', desc: 'Change a variable’s storage type.', eg: 'set type agegrp = factor' },
  { syntax: 'set measure NAME = nominal | ordinal | scale', desc: 'Set the measurement level.', eg: 'set measure agegrp = ordinal' },
  { syntax: 'set missing NAME = v1, v2   (or none)', desc: 'Declare user-missing codes (or clear them with `none`).', eg: 'set missing income = -99, -98' },
  { syntax: 'run pluginId.fn {json-inputs}', desc: 'Run an analysis or plugin, passing its inputs as JSON. See “Running analyses” below for each plugin’s exact call.', eg: 'run builtin-frequencies.run {"vars": ["gender"]}' },
  { syntax: '# comment', desc: 'A comment line, ignored on Run. Data sources (imports/appends/joins) appear as # comments — they’re read-only anchors; re-import to change them.', eg: '# use "survey.sav"' },
];

const NOTES = [
  'Expressions (EXPR) are DuckDB SQL, kept verbatim — anything DuckDB can evaluate works.',
  'Variable names with spaces or punctuation go in `backticks`. Strings use "double quotes"; numbers are bare.',
  'Tip: run any analysis once from the menu, then open History ▸ ✎ Syntax — its exact `run …` line is right there to copy as a template.',
];

/** A placeholder inputs object for a menu item, by input kind, for the example call. */
function exampleInputs(inputs) {
  const o = {};
  for (const i of inputs || []) {
    if (i.kind === 'number') o[i.name] = i.default ?? 0;
    else if (i.kind === 'choice') o[i.name] = i.default ?? i.options?.[0]?.value ?? 'choice';
    else if (i.kind === 'file') o[i.name] = 'filename';
    else if (i.kind === 'text') o[i.name] = i.default ?? 'text';
    else o[i.name] = i.multiple ? ['var1', 'var2'] : 'var1'; // variables (default kind)
  }
  return o;
}

/** Human description of one input for the guide. */
function inputLine(i) {
  const bits = [i.kind];
  if (i.kind === 'variables' && i.multiple) bits.push('one or more');
  if (i.optional) bits.push('optional');
  if (i.kind === 'choice' && i.options?.length) bits.push('one of: ' + i.options.map((o) => o.value).join(', '));
  const tail = i.label ? ` — ${i.label}` : '';
  return `${i.name} (${bits.join(', ')})${tail}`;
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function code(text) {
  const c = el('code', text);
  c.style.cssText =
    'font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#f4f6f8; ' +
    'border:1px solid var(--line,#e2e7ec); border-radius:5px; padding:2px 6px; display:inline-block; ' +
    'white-space:pre-wrap; word-break:break-word; color:#243; max-width:100%;';
  return c;
}

/**
 * Open the Syntax guide overlay.
 * @param {{ pluginActions?: { listRunnable: () => Array<object> } }} deps
 */
export function openSyntaxGuide({ pluginActions } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog';
  dialog.style.cssText = 'max-width:820px; width:94vw;';

  const form = el('form', null, 'ct-dialog__form');
  form.method = 'dialog';
  form.style.cssText = 'padding:0; display:flex; flex-direction:column; max-height:86vh;';

  // header
  const head = el('div', null, 'syntax-guide__head');
  head.style.cssText = 'display:flex; align-items:center; gap:10px; padding:16px 20px 10px; border-bottom:1px solid var(--line,#e2e7ec);';
  const title = el('h2', 'CrossTab syntax guide', 'ct-dialog__title');
  title.style.margin = '0';
  const closeX = el('button', '✕');
  closeX.type = 'submit';
  closeX.value = 'cancel';
  closeX.title = 'Close';
  closeX.style.cssText = 'margin-left:auto; border:0; background:none; font-size:16px; cursor:pointer; color:#5a6470;';
  head.append(title, closeX);

  // scroll body
  const body = el('div', null, 'syntax-guide__body');
  body.style.cssText = 'overflow:auto; padding:14px 20px 20px;';

  const intro = el(
    'p',
    'The script is CrossTab’s own command language — a lossless text view of your data steps and analyses. Edit it like a text file and Run to rebuild. One statement per line.',
  );
  intro.style.cssText = 'margin:0 0 14px; color:#5a6470; line-height:1.5; font-size:14px;';
  body.append(intro);

  // --- Commands ------------------------------------------------------------
  body.append(sectionHeading('Commands'));
  for (const c of COMMANDS) {
    const card = el('div', null, 'syntax-guide__cmd');
    card.style.cssText = 'margin:0 0 12px; padding:0 0 12px; border-bottom:1px solid #eef1f4;';
    card.append(code(c.syntax));
    const d = el('p', c.desc);
    d.style.cssText = 'margin:6px 0 6px; font-size:13px; line-height:1.5; color:#2a323a;';
    card.append(d);
    const egRow = el('div', null);
    egRow.style.cssText = 'display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;';
    const egLabel = el('span', 'e.g.');
    egLabel.style.cssText = 'font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#9aa4ae;';
    egRow.append(egLabel, code(c.eg));
    card.append(egRow);
    body.append(card);
  }

  const notes = el('ul', null);
  notes.style.cssText = 'margin:4px 0 8px; padding-left:18px; color:#5a6470; font-size:12.5px; line-height:1.5;';
  for (const n of NOTES) notes.append(el('li', n));
  body.append(notes);

  // --- Running analyses (live plugin list) ---------------------------------
  body.append(sectionHeading('Running analyses & plugins'));
  const runnable = (() => { try { return pluginActions?.listRunnable?.() || []; } catch { return []; } })();

  if (!runnable.length) {
    body.append(el('p', 'No active analyses to list. Enable plugins in the Plugin manager and they’ll appear here.'));
  } else {
    const lead = el('p', `Each analysis is called with \`run pluginId.fn {…}\`. ${runnable.length} action${runnable.length === 1 ? '' : 's'} from your active plugins:`);
    lead.style.cssText = 'margin:0 0 12px; font-size:13px; color:#5a6470; line-height:1.5;';
    body.append(lead);

    // filter box
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Filter analyses…';
    filter.style.cssText = 'width:100%; box-sizing:border-box; font:inherit; font-size:13px; padding:7px 10px; margin:0 0 12px; border:1px solid var(--line,#d8dee4); border-radius:6px;';
    body.append(filter);

    const list = el('div', null, 'syntax-guide__plugins');
    const rows = [];
    for (const r of runnable) {
      const card = el('div', null, 'syntax-guide__plugin');
      card.style.cssText = 'margin:0 0 12px; padding:0 0 12px; border-bottom:1px solid #eef1f4;';
      const h = el('div', null);
      h.style.cssText = 'display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin:0 0 6px;';
      const nm = el('strong', r.label || r.run);
      nm.style.fontSize = '13.5px';
      const tag = el('span', r.pluginName);
      tag.style.cssText = 'font-size:11.5px; color:#7a8590;';
      h.append(nm, tag);
      card.append(h);

      const call = `run ${r.pluginId}.${r.run} ${JSON.stringify(exampleInputs(r.inputs))}`;
      card.append(code(call));

      if (r.inputs.length) {
        const ul = el('ul', null);
        ul.style.cssText = 'margin:8px 0 0; padding-left:18px; font-size:12.5px; line-height:1.5; color:#3a424a;';
        for (const i of r.inputs) ul.append(el('li', inputLine(i)));
        card.append(ul);
      } else {
        const none = el('p', 'No inputs — call with {}.');
        none.style.cssText = 'margin:6px 0 0; font-size:12.5px; color:#7a8590;';
        card.append(none);
      }

      if (r.howto) {
        const ht = el('p', r.howto);
        ht.style.cssText = 'margin:8px 0 0; font-size:12.5px; line-height:1.5; color:#2a323a; white-space:pre-wrap; border-left:3px solid var(--accent,#2980b9); padding-left:10px;';
        card.append(ht);
      }

      list.append(card);
      rows.push({ card, hay: `${r.label} ${r.pluginName} ${r.pluginId} ${r.run} ${r.howto || ''}`.toLowerCase() });
    }
    body.append(list);

    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const { card, hay } of rows) card.style.display = !q || hay.includes(q) ? '' : 'none';
    });
  }

  form.append(head, body);
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function sectionHeading(text) {
  const h = el('h3', text);
  h.style.cssText = 'margin:18px 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#7a8590;';
  return h;
}
