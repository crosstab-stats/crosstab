/**
 * @file plugin-creator.js
 * In-app plugin creator/editor — let a social scientist (not a programmer) build
 * the plugin they need without leaving the app or standing up a toolchain.
 *
 * It's deliberately *not* an IDE: a template pre-wires the plumbing (manifest,
 * the variable picker, the output channels) so the author only fills in the
 * analysis. "Save & load" hands the source straight to the same sandboxed loader
 * any plugin uses (`PluginManager.saveAuthored` → `loader.loadSource`), and the
 * source persists like a file-loaded plugin so it survives a restart and can be
 * re-opened here to edit.
 *
 * The editor surface is a textarea with a line-number gutter and tab handling —
 * "more than Notepad". Real syntax highlighting is a deferred polish (would mean
 * vendoring CodeMirror); templates + validation + live load carry v1.
 */

export class PluginCreator {
  /** @type {import('./plugin-manager.js').PluginManager} */
  #manager;

  /** @param {{manager: import('./plugin-manager.js').PluginManager}} deps */
  constructor({ manager }) {
    this.#manager = manager;
  }

  /**
   * Open the creator. Pass an authored entry to edit it; omit to start fresh.
   *
   * @param {{key:string, name:string, source:string}|null} [existing]
   * @param {() => void} [onDone] - Called after a successful save (e.g. to
   *   refresh the plugin-manager list if it's open).
   */
  open(existing = null, onDone = null) {
    const editing = !!existing;
    const id = genId();
    // Pre-generate each template's text (with one id) so we can tell whether the
    // editor still holds a pristine template (safe to replace) vs. real edits.
    const pristineTexts = new Set(TEMPLATES.map((t) => t.build(id, 'My Analysis')));

    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-creator';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">${editing ? 'Edit plugin' : 'Create a plugin'}</h2>
        <p class="ct-dialog__hint">${
          editing
            ? 'Edit your plugin’s code, then Save &amp; load. It runs sandboxed like any other plugin.'
            : 'Pick a starting template, fill in the analysis, then Save &amp; load. Your plugin runs sandboxed and is saved across sessions.'
        }</p>
        ${
          editing
            ? ''
            : `<div class="ct-creator__row">
                 <label class="ct-creator__namelbl">Name
                   <input type="text" class="ct-creator__name" value="My Analysis" autocomplete="off">
                 </label>
               </div>
               <div class="ct-creator__templates"></div>`
        }
        <div class="ct-creator__editor">
          <div class="ct-creator__gutter" aria-hidden="true"></div>
          <textarea class="ct-creator__code" spellcheck="false" wrap="off"></textarea>
        </div>
        <div class="ct-creator__status" hidden></div>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="save" type="button" class="ct-dialog__primary">Save &amp; load</button>
        </menu>
      </form>`;

    const code = dialog.querySelector('.ct-creator__code');
    const gutter = dialog.querySelector('.ct-creator__gutter');
    const statusEl = dialog.querySelector('.ct-creator__status');
    const nameEl = dialog.querySelector('.ct-creator__name');
    const setStatus = (msg, isErr = false) => {
      statusEl.textContent = msg || '';
      statusEl.hidden = !msg;
      statusEl.classList.toggle('ct-creator__status--err', isErr);
    };
    const syncGutter = () => {
      const lines = code.value.split('\n').length;
      gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
      gutter.scrollTop = code.scrollTop;
    };

    // Initial content: the existing source, or a sensible default template.
    code.value = existing?.source ?? TEMPLATES[1].build(id, 'My Analysis');
    syncGutter();

    // Template buttons (new plugins only).
    if (!editing) {
      const box = dialog.querySelector('.ct-creator__templates');
      for (const t of TEMPLATES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-creator__tpl';
        b.textContent = t.label;
        b.addEventListener('click', () => {
          const current = code.value.trim();
          const pristine = current === '' || pristineTexts.has(code.value);
          if (!pristine && !confirm('Replace the current code with this template?')) return;
          const nm = (nameEl.value || 'My Analysis').replace(/['"\\]/g, '').trim() || 'My Analysis';
          code.value = t.build(id, nm);
          syncGutter();
          setStatus('');
        });
        box.append(b);
      }
    }

    // Editor behaviour: line-number gutter + Tab-inserts-spaces.
    code.addEventListener('input', syncGutter);
    code.addEventListener('scroll', () => (gutter.scrollTop = code.scrollTop));
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = code.selectionStart;
        const t = code.selectionEnd;
        code.value = code.value.slice(0, s) + '  ' + code.value.slice(t);
        code.selectionStart = code.selectionEnd = s + 2;
        syncGutter();
      }
    });

    // Save & load.
    dialog.querySelector('button[value="save"]').addEventListener('click', async (e) => {
      e.preventDefault();
      const source = code.value;
      const name = (nameEl?.value || existing?.name || 'Authored plugin').trim();
      setStatus('Loading…');
      try {
        await this.#manager.saveAuthored({ name, source, key: existing?.key });
        setStatus('Saved and loaded ✓');
        onDone?.();
        dialog.close();
      } catch (err) {
        setStatus(`Couldn’t load: ${err.message}`, true);
      }
    });

    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    code.focus();
  }
}

// --- helpers -----------------------------------------------------------------

/** A fresh, collision-resistant plugin id. */
function genId() {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `authored-${rnd}`;
}

// --- templates ---------------------------------------------------------------
//
// Each builder returns a COMPLETE, runnable plugin module. The generated R code
// is assembled with string concatenation (no template literals), so the source
// contains no backticks or `${}` — which is what lets these be authored as plain
// template literals here without their contents being interpolated.

/** Common manifest + activate header. */
function header(id, name, category, keywords, rPackages = []) {
  return `export const manifest = {
  id: '${id}',
  name: '${name}',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: '${category}',
  keywords: [${keywords.map((k) => `'${k}'`).join(', ')}],
  rPackages: [${rPackages.map((p) => `'${p}'`).join(', ')}], // R packages to install on load
};

// activate() runs once when the plugin loads — register your menu item(s) here.
// Convention: file your menu under your category (above) as the top-level menu,
// so users find it where the plugin manager groups it.
export async function activate(app) {
  await app.menus.register({
    path: ['${category}'],   // top-level menu = your category
    label: '${name}…',       // the menu item the user clicks
    command: () => run(app),
  });
}
`;
}

/** Reusable JS helpers appended to data templates. */
const TABLE_HELPERS = `
// Turn a column-oriented R result ({names, values}) into an HTML table.
function toTable(result) {
  const names = result.names || [];
  const cols = (result.values || []).map(function (c) {
    return Array.isArray(c && c.values) ? c.values : [].concat(c);
  });
  const nrow = cols.length ? cols[0].length : 0;
  let html = '<table><thead><tr>';
  for (const n of names) html += '<th>' + esc(n) + '</th>';
  html += '</tr></thead><tbody>';
  for (let i = 0; i < nrow; i++) {
    html += '<tr>';
    for (const c of cols) html += '<td>' + esc(c[i]) + '</td>';
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
`;

const TEMPLATES = [
  {
    key: 'blank',
    label: 'Blank',
    build: (id, name) =>
      header(id, name, 'Other', []) +
      `
async function run(app) {
  await app.results.beginSection('${name}');
  await app.results.appendText('<p>Hello from your plugin! Edit run() to do something.</p>');
}
`,
  },
  {
    key: 'one-var',
    label: 'One-variable analysis',
    build: (id, name) =>
      header(id, name, 'Descriptive Statistics', ['summary']) +
      `
async function run(app) {
  // 1) Ask the user to choose numeric variable(s).
  const vars = await app.ui.selectVariables({
    title: '${name}',
    hint: 'Choose one or more numeric variables.',
    multiple: true,
    types: ['numeric'],
  });
  if (!vars || !vars.length) return;

  await app.results.beginSection('${name}');
  try {
    // 2) Build R code. Your chosen data is injected as a data frame named df.
    const rCode =
      'vars <- c(' + vars.map(function (v) { return JSON.stringify(v); }).join(', ') + ')\\n' +
      'data.frame(\\n' +
      '  Variable = vars,\\n' +
      '  N    = sapply(vars, function(v) sum(!is.na(df[[v]]))),\\n' +
      '  Mean = sapply(vars, function(v) round(mean(as.numeric(df[[v]]), na.rm = TRUE), 3)),\\n' +
      '  SD   = sapply(vars, function(v) round(sd(as.numeric(df[[v]]), na.rm = TRUE), 3))\\n' +
      ')';

    // 3) Run it, then render the returned data frame as a table.
    const { result } = await app.webr.run(rCode, { injectData: true, variables: vars });
    await app.results.appendTable(toTable(result));
  } catch (err) {
    await app.results.appendError('Failed: ' + err.message);
  }
}
` +
      TABLE_HELPERS,
  },
  {
    key: 'two-group',
    label: 'Two-group comparison',
    build: (id, name) =>
      header(id, name, 'Comparison', ['compare', 'means', 'group']) +
      `
async function run(app) {
  // Pick a numeric outcome, then a grouping variable.
  const ys = await app.ui.selectVariables({
    title: '${name} — outcome',
    hint: 'Choose a numeric outcome variable.',
    multiple: false,
    types: ['numeric'],
  });
  if (!ys || !ys.length) return;
  const gs = await app.ui.selectVariables({
    title: '${name} — group',
    hint: 'Choose a categorical grouping variable.',
    multiple: false,
    types: ['factor', 'string'],
  });
  if (!gs || !gs.length) return;
  const y = ys[0];
  const g = gs[0];

  await app.results.beginSection('${name}');
  try {
    const rCode =
      'y <- as.numeric(df[[' + JSON.stringify(y) + ']])\\n' +
      'g <- as.factor(df[[' + JSON.stringify(g) + ']])\\n' +
      'agg <- aggregate(y, list(Group = g), function(x) c(\\n' +
      '  N = sum(!is.na(x)), Mean = mean(x, na.rm = TRUE), SD = sd(x, na.rm = TRUE)))\\n' +
      'data.frame(Group = agg$Group, N = agg$x[, "N"],\\n' +
      '  Mean = round(agg$x[, "Mean"], 3), SD = round(agg$x[, "SD"], 3))';
    const { result } = await app.webr.run(rCode, { injectData: true, variables: [y, g] });
    await app.results.appendTable(toTable(result));
  } catch (err) {
    await app.results.appendError('Failed: ' + err.message);
  }
}
` +
      TABLE_HELPERS,
  },
  {
    key: 'plot',
    label: 'Plot (histogram)',
    build: (id, name) =>
      header(id, name, 'Graphs', ['plot', 'histogram'], ['svglite']) +
      `
async function run(app) {
  const vars = await app.ui.selectVariables({
    title: '${name}',
    hint: 'Choose a numeric variable.',
    multiple: false,
    types: ['numeric'],
  });
  if (!vars || !vars.length) return;
  const v = vars[0];

  await app.results.beginSection('${name}');
  try {
    // Draw with base R on an svglite device, which returns an SVG string.
    const rCode =
      'library(svglite)\\n' +
      '.dev <- svgstring(width = 7, height = 4.5, pointsize = 11)\\n' +
      'x <- as.numeric(df[[' + JSON.stringify(v) + ']]); x <- x[is.finite(x)]\\n' +
      'hist(x, col = "#2980b9", border = "white", main = ' + JSON.stringify(v) + ', xlab = ' + JSON.stringify(v) + ')\\n' +
      'dev.off()\\n' +
      '.dev()';
    const { result } = await app.webr.run(rCode, { injectData: true, variables: [v] });
    const svg = String(Array.isArray(result && result.values) ? result.values[0] : result);
    await app.results.appendPlot(svg);
  } catch (err) {
    await app.results.appendError('Failed: ' + err.message);
  }
}
`,
  },
];
