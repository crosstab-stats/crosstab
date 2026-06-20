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
// Each builder returns a COMPLETE, runnable **declarative** plugin: a manifest
// with one menu item (+ its inputs) and a `run(app, inputs)` function. The host
// gathers the declared inputs and binds them into R *by name*, so the R is static
// (no string interpolation). Generated R is assembled by string concatenation, so
// the source has no backticks/`${}` — which lets these be authored as plain
// template literals here without their contents being interpolated.

/** Manifest source with one menu item. `inputs` is the inputs array as source
 * text, e.g. "[{ name: 'vars', kind: 'variables', multiple: true }]". */
function manifestSrc(id, name, category, keywords, rPackages, inputs) {
  return `export const manifest = {
  id: '${id}',
  name: '${name}',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: '${category}',   // where it's filed in the menu + grouped in the manager
  keywords: [${keywords.map((k) => `'${k}'`).join(', ')}],
  rPackages: [${rPackages.map((p) => `'${p}'`).join(', ')}],
  menu: [{ label: '${name}…', run: 'run', inputs: ${inputs} }],
};

`;
}

const TEMPLATES = [
  {
    key: 'blank',
    label: 'Blank',
    build: (id, name) =>
      manifestSrc(id, name, 'Other', [], [], '[]') +
      `// run(app, inputs) is your plugin's entry point. The host adds your menu item
// (under your category) and calls run when the user clicks it.
export async function run(app) {
  await app.results.appendText('Hello from your plugin! Edit run() to do something.');
}
`,
  },
  {
    key: 'one-var',
    label: 'One-variable analysis',
    build: (id, name) =>
      manifestSrc(
        id,
        name,
        'Descriptive Statistics',
        ['summary'],
        [],
        "[{ name: 'vars', kind: 'variables', types: ['numeric'], multiple: true }]",
      ) +
      `// Your chosen columns are bound in R as the data.frame \`vars\`. Build a
// data.frame of results and hand it to appendTable — the host renders the table.
export async function run(app, { vars }) {
  const rCode =
    'data.frame(\\n' +
    '  Variable = names(vars),\\n' +
    '  N    = sapply(vars, function(x) sum(!is.na(x))),\\n' +
    '  Mean = round(sapply(vars, function(x) mean(as.numeric(x), na.rm = TRUE)), 3),\\n' +
    '  SD   = round(sapply(vars, function(x) sd(as.numeric(x), na.rm = TRUE)), 3),\\n' +
    '  check.names = FALSE)';
  const { result } = await app.webr.run(rCode);
  await app.results.appendTable(result);
}
`,
  },
  {
    key: 'two-group',
    label: 'Two-group comparison',
    build: (id, name) =>
      manifestSrc(
        id,
        name,
        'Comparison',
        ['compare', 'means'],
        [],
        "[{ name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true }, " +
          "{ name: 'g', kind: 'variables', label: 'Group', multiple: false, types: ['factor', 'string'], unique: true }]",
      ) +
      `// 'y' (numeric) and 'g' (grouping) are bound in R as vectors.
export async function run(app, { y, g }) {
  const rCode =
    'agg <- aggregate(as.numeric(y), list(Group = as.factor(g)), function(v) c(\\n' +
    '  N = sum(!is.na(v)), Mean = mean(v, na.rm = TRUE), SD = sd(v, na.rm = TRUE)))\\n' +
    'data.frame(Group = agg$Group, N = agg$x[, "N"],\\n' +
    '  Mean = round(agg$x[, "Mean"], 3), SD = round(agg$x[, "SD"], 3))';
  const { result } = await app.webr.run(rCode);
  await app.results.appendTable(result);
}
`,
  },
  {
    key: 'plot',
    label: 'Plot (histogram)',
    build: (id, name) =>
      manifestSrc(
        id,
        name,
        'Graphs',
        ['plot', 'histogram'],
        ['svglite'],
        "[{ name: 'v', kind: 'variables', multiple: false, types: ['numeric'] }]",
      ) +
      `// 'v' (numeric) is bound in R as a vector. Draw with svglite → an SVG string.
export async function run(app, { v }) {
  const rCode =
    'library(svglite)\\n' +
    '.dev <- svgstring(width = 7, height = 4.5, pointsize = 11)\\n' +
    'x <- as.numeric(v); x <- x[is.finite(x)]\\n' +
    'hist(x, col = "#2980b9", border = "white", main = "Histogram", xlab = "")\\n' +
    'dev.off()\\n' +
    '.dev()';
  const { result } = await app.webr.run(rCode);
  const svg = String(Array.isArray(result && result.values) ? result.values[0] : result);
  await app.results.appendPlot(svg);
}
`,
  },
];
