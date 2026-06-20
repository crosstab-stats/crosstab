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

/** Recommended category vocabulary for the Simple-mode dropdown (mirrors the
 * plugin manager's; an author may still type any string in Code mode). */
const CATEGORY_ORDER = [
  'Import',
  'Descriptive Statistics',
  'Comparison',
  'Correlation',
  'Regression',
  'Multivariate',
  'Time Series',
  'Resampling',
  'Graphs',
  'Export',
];

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
    const pristineTexts = new Set(TEMPLATES.map((t) => t.build(id, 'My Analysis')));
    const catOptions = CATEGORY_ORDER.concat('Other')
      .map((c) => `<option>${c}</option>`)
      .join('');

    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-creator';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title">${editing ? 'Edit plugin' : 'Create a plugin'}</h2>
        ${
          editing
            ? ''
            : `<div class="ct-creator__modes">
                 <button type="button" class="ct-creator__mode is-active" data-mode="simple">Simple</button>
                 <button type="button" class="ct-creator__mode" data-mode="code">Code</button>
               </div>`
        }

        <div class="ct-creator__simple">
          <p class="ct-dialog__hint">Fill in the form and write your R — no JavaScript needed. The
            variables you list are handed to R <em>by name</em>; return a data.frame for a Table, or
            draw a plot.</p>
          <label class="ct-creator__field">Name
            <input type="text" class="ct-creator__name" value="My Analysis" autocomplete="off"></label>
          <label class="ct-creator__field">Menu (category)
            <select class="ct-creator__cat">${catOptions}</select></label>
          <div class="ct-creator__field">What the user picks before it runs
            <div class="ct-creator__inputs"></div>
            <button type="button" class="ct-creator__addinput">+ Add input</button>
          </div>
          <div class="ct-creator__field">Output
            <label class="ct-creator__radio"><input type="radio" name="ctout" value="table" checked> Table</label>
            <label class="ct-creator__radio"><input type="radio" name="ctout" value="plot"> Plot</label>
          </div>
          <label class="ct-creator__field">R code
            <textarea class="ct-creator__r" spellcheck="false"></textarea></label>
          <p class="ct-creator__rhint"></p>
        </div>

        <div class="ct-creator__codepanel">
          <p class="ct-dialog__hint">${
            editing
              ? 'Edit your plugin’s code, then Save &amp; load.'
              : 'The full plugin source — edit directly for anything the form can’t express.'
          }</p>
          ${editing ? '' : '<div class="ct-creator__templates"></div>'}
          <div class="ct-creator__editor">
            <div class="ct-creator__gutter" aria-hidden="true"></div>
            <textarea class="ct-creator__code" spellcheck="false" wrap="off"></textarea>
          </div>
        </div>

        <div class="ct-creator__status" hidden></div>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
          <button value="save" type="button" class="ct-dialog__primary">Save &amp; load</button>
        </menu>
      </form>`;

    const q = (s) => dialog.querySelector(s);
    const code = q('.ct-creator__code');
    const gutter = q('.ct-creator__gutter');
    const statusEl = q('.ct-creator__status');
    const nameEl = q('.ct-creator__name');
    const rBox = q('.ct-creator__r');
    const rHint = q('.ct-creator__rhint');
    const inputsBox = q('.ct-creator__inputs');
    const setStatus = (msg, isErr = false) => {
      statusEl.textContent = msg || '';
      statusEl.hidden = !msg;
      statusEl.classList.toggle('ct-creator__status--err', isErr);
    };
    const syncGutter = () => {
      const n = code.value.split('\n').length;
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      gutter.scrollTop = code.scrollTop;
    };

    code.value = existing?.source ?? TEMPLATES[1].build(id, 'My Analysis');
    syncGutter();

    // --- Simple vs Code mode (new plugins only; editing is always Code) --------
    let mode = editing ? 'code' : 'simple';
    const simplePanel = q('.ct-creator__simple');
    const codePanel = q('.ct-creator__codepanel');
    const applyMode = () => {
      simplePanel.style.display = mode === 'simple' ? '' : 'none';
      codePanel.style.display = mode === 'code' ? '' : 'none';
      dialog
        .querySelectorAll('.ct-creator__mode')
        .forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
    };
    dialog.querySelectorAll('.ct-creator__mode').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        applyMode();
      }),
    );
    applyMode();

    // --- Simple form: inputs builder + R hint ----------------------------------
    const readInputs = () =>
      [...inputsBox.querySelectorAll('.ct-creator__inputrow')]
        .map((row) => {
          const name = (row.querySelector('.ct-creator__inname').value || '').trim();
          const preset = INPUT_PRESETS[row.querySelector('.ct-creator__inkind').value];
          const optional = row.querySelector('.ct-creator__inopt input').checked;
          return name && preset ? { name, ...preset.spec, ...(optional ? { optional: true } : {}) } : null;
        })
        .filter(Boolean);
    const updateRHint = () => {
      const names = readInputs().map((i) => `\`${i.name}\``).join(', ') || '(none)';
      const out = q('input[name="ctout"]:checked')?.value;
      rHint.textContent =
        `In R you have: ${names}. ` +
        (out === 'plot' ? 'Draw a base-R plot, e.g. hist(...).' : 'Make the last line a data.frame to show as a table.');
    };
    const addInputRow = (preset = 'numeric-multi', nm = '') => {
      const count = inputsBox.querySelectorAll('.ct-creator__inputrow').length;
      const row = elc('div', 'ct-creator__inputrow');
      const nameI = document.createElement('input');
      nameI.type = 'text';
      nameI.className = 'ct-creator__inname';
      nameI.placeholder = 'name in R';
      nameI.value = nm || (count === 0 ? 'vars' : `var${count + 1}`);
      const sel = document.createElement('select');
      sel.className = 'ct-creator__inkind';
      for (const [k, p] of Object.entries(INPUT_PRESETS)) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = p.label;
        if (k === preset) o.selected = true;
        sel.append(o);
      }
      const opt = elc('label', 'ct-creator__inopt');
      const ob = document.createElement('input');
      ob.type = 'checkbox';
      opt.append(ob, document.createTextNode(' optional'));
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ct-creator__inrm';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        row.remove();
        updateRHint();
      });
      nameI.addEventListener('input', updateRHint);
      sel.addEventListener('change', updateRHint);
      row.append(nameI, sel, opt, rm);
      inputsBox.append(row);
      updateRHint();
    };
    q('.ct-creator__addinput').addEventListener('click', () => addInputRow());
    dialog.querySelectorAll('input[name="ctout"]').forEach((r) => r.addEventListener('change', updateRHint));
    if (!editing) {
      addInputRow('numeric-multi', 'vars');
      rBox.value =
        'data.frame(\n  Variable = names(vars),\n  Mean = round(sapply(vars, function(x) mean(as.numeric(x), na.rm = TRUE)), 3)\n)';
      updateRHint();
    }

    // --- Code mode: templates + editor -----------------------------------------
    if (!editing) {
      const box = q('.ct-creator__templates');
      for (const t of TEMPLATES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-creator__tpl';
        b.textContent = t.label;
        b.addEventListener('click', () => {
          const cur = code.value.trim();
          const pristine = cur === '' || pristineTexts.has(code.value);
          if (!pristine && !confirm('Replace the current code with this template?')) return;
          const nm = (nameEl.value || 'My Analysis').replace(/['"\\]/g, '').trim() || 'My Analysis';
          code.value = t.build(id, nm);
          syncGutter();
          setStatus('');
        });
        box.append(b);
      }
    }
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

    // --- Save & load -----------------------------------------------------------
    q('button[value="save"]').addEventListener('click', async (e) => {
      e.preventDefault();
      let source;
      let name;
      if (mode === 'simple') {
        name = (nameEl.value || 'My Analysis').replace(/['"\\]/g, '').trim() || 'My Analysis';
        source = buildFromForm({
          id,
          name,
          category: q('.ct-creator__cat').value,
          inputs: readInputs(),
          output: q('input[name="ctout"]:checked')?.value || 'table',
          rCode: rBox.value,
        });
      } else {
        source = code.value;
        name = (nameEl.value || existing?.name || 'Authored plugin').trim();
      }
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
    (editing ? code : nameEl).focus();
  }
}

/** Friendly input presets for Simple mode — hide kind/types/multiple behind a
 * single dropdown a non-programmer can reason about. */
const INPUT_PRESETS = {
  'numeric-multi': { label: 'Numeric variable(s)', spec: { kind: 'variables', types: ['numeric'], multiple: true } },
  'numeric-one': { label: 'One numeric variable', spec: { kind: 'variables', types: ['numeric'], multiple: false } },
  'cat-multi': { label: 'Categorical variable(s)', spec: { kind: 'variables', types: ['factor', 'string'], multiple: true } },
  'cat-one': { label: 'One categorical variable', spec: { kind: 'variables', types: ['factor', 'string'], multiple: false } },
  'any-multi': { label: 'Any variable(s)', spec: { kind: 'variables', multiple: true } },
  number: { label: 'A number', spec: { kind: 'number' } },
  text: { label: 'Text', spec: { kind: 'text' } },
};

/** Generate a complete declarative plugin from the Simple-mode form. The user's R
 * is embedded with JSON.stringify (safe for any content); for a plot it's wrapped
 * in an svglite device so the author writes only the plot call. */
function buildFromForm({ id, name, category, inputs, output, rCode }) {
  const isPlot = output === 'plot';
  const rForRun = isPlot
    ? `library(svglite)\n.dev <- svgstring(width = 7, height = 4.5, pointsize = 11)\n${rCode}\ndev.off()\n.dev()`
    : rCode;
  const tail = isPlot
    ? '  const { result } = await app.webr.run(rCode);\n' +
      '  const svg = String(Array.isArray(result && result.values) ? result.values[0] : result);\n' +
      '  await app.results.appendPlot(svg);'
    : '  const { result } = await app.webr.run(rCode);\n  await app.results.appendTable(result);';
  return `export const manifest = {
  id: '${id}',
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: ${JSON.stringify(category)},
  keywords: [],
  rPackages: ${JSON.stringify(isPlot ? ['svglite'] : [])},
  menu: [{ label: ${JSON.stringify(name + '…')}, run: 'run', inputs: ${JSON.stringify(inputs)} }],
};

export async function run(app) {
  const rCode = ${JSON.stringify(rForRun)};
${tail}
}
`;
}

/** Tiny element helper. */
function elc(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
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
