/**
 * @file r-console.js
 * The **R Console** workspace tab — a live REPL against the persistent WebR
 * session, for power users and for plugin authors who want to poke at R one line
 * at a time before wiring it into a plugin.
 *
 * It mirrors the plugin data contract on purpose: the variables you check are
 * bound in R as `vars` — a **data.frame** when several are checked, a plain
 * **vector** when one is (exactly what a plugin's multi- vs. single-variable
 * input receives) — so code you get working here copy/pastes straight into a
 * plugin's `run`. State persists across lines (`x <- 5` then `mean(x)`).
 *
 * Host feature, not a plugin: a sandboxed plugin can't draw an interactive
 * terminal. Output is R-generated text, inserted as text nodes (no HTML).
 */

export class RConsole {
  #host;
  #webr;
  #store;

  /** Checked variable names (local to the console — independent of the analysis
   * selection, so poking here doesn't change what pickers pre-select). */
  #checked = new Set();
  /** Submitted command history for ↑/↓ recall. */
  #history = [];
  #histIdx = -1;
  #booted = false;

  /** Variable-list filter text (matches name or label). */
  #filter = '';

  // elements
  #varsBox;
  #filterInput;
  #varsInfo;
  #libsInfo;
  #out;
  #input;

  /**
   * @param {HTMLElement} host - The tab panel element.
   * @param {{ webr: import('./webr-manager.js').WebRManager, store: object }} deps
   *   `store` is the DatasetManager#api (getVariableMeta).
   */
  constructor(host, { webr, store }) {
    this.#host = host;
    this.#webr = webr;
    this.#store = store;
    this.#build();
  }

  #build() {
    this.#host.classList.add('rconsole');
    this.#host.innerHTML = `
      <div class="rc-varsbar">
        <input class="rc-filter" type="search" placeholder="Filter…" aria-label="Filter variables" autocomplete="off">
        <div class="rc-vars" role="group" aria-label="Variables to expose in R"></div>
      </div>
      <div class="rc-info">
        <div class="rc-info__line"><span class="rc-info__k">In R you have:</span> <span class="rc-vars-info">nothing checked</span></div>
        <div class="rc-info__line">
          <span class="rc-info__k">Libraries:</span>
          <input class="rc-lib-add" type="text" placeholder="+ load library…" autocomplete="off" spellcheck="false">
          <span class="rc-libs-info">…</span>
        </div>
      </div>
      <div class="rc-term">
        <div class="rc-out" aria-live="polite"></div>
        <div class="rc-prompt"><span class="rc-caret">&gt;</span><input class="rc-input" type="text" spellcheck="false" autocomplete="off" aria-label="R input"></div>
      </div>`;

    this.#varsBox = this.#host.querySelector('.rc-vars');
    this.#filterInput = this.#host.querySelector('.rc-filter');
    this.#filterInput.addEventListener('input', () => {
      this.#filter = this.#filterInput.value;
      this.#renderVars();
    });
    this.#varsInfo = this.#host.querySelector('.rc-vars-info');
    this.#libsInfo = this.#host.querySelector('.rc-libs-info');
    this.#out = this.#host.querySelector('.rc-out');
    this.#input = this.#host.querySelector('.rc-input');

    this.#input.addEventListener('keydown', (e) => this.#onKey(e));
    // Clicking anywhere in the terminal focuses the input.
    this.#host.querySelector('.rc-term').addEventListener('click', () => this.#input.focus());

    const libAdd = this.#host.querySelector('.rc-lib-add');
    libAdd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = libAdd.value.trim();
        libAdd.value = '';
        if (name) void this.#loadLibrary(name);
      }
    });

    this.#renderVars();
  }

  /** Called when the tab becomes visible: refresh the variable list and, on first
   * view, boot the session line + library list (which warms up WebR). */
  async onShow() {
    this.#renderVars();
    this.#input.focus();
    if (this.#booted) return;
    this.#booted = true;
    try {
      const v = await this.#webr.run('paste0(R.version$major, ".", R.version$minor)');
      const ver = String(Array.isArray(v.result?.values) ? v.result.values[0] : v.result || '');
      this.#append(`R ${ver || ''} ready — type R and press Enter. Checked variables are in \`vars\`.`, 'rc-note');
    } catch {
      this.#append('R ready.', 'rc-note');
    }
    void this.#refreshLibs();
  }

  /** Re-render the variable checkboxes (on dataset change), keeping the checked
   * set intersected with what still exists, and re-bind if it changed. */
  refresh() {
    this.#renderVars();
  }

  // --- variables -------------------------------------------------------------

  #renderVars() {
    const meta = this.#store.getVariableMeta?.() ?? [];
    const names = new Set(meta.map((m) => m.name));
    // Drop checked vars that no longer exist.
    let changed = false;
    for (const n of [...this.#checked]) if (!names.has(n)) { this.#checked.delete(n); changed = true; }

    this.#varsBox.replaceChildren();
    const q = this.#filter.trim().toLowerCase();
    const shown = q
      ? meta.filter((m) => m.name.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q))
      : meta;
    if (!meta.length) {
      this.#varsBox.append(el('span', 'No data loaded.', 'rc-vars__empty'));
    } else if (!shown.length) {
      this.#varsBox.append(el('span', 'No variables match the filter.', 'rc-vars__empty'));
    } else {
      for (const m of shown) {
        const label = el('label', null, 'rc-var');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = m.name;
        cb.checked = this.#checked.has(m.name);
        cb.addEventListener('change', () => {
          if (cb.checked) this.#checked.add(m.name);
          else this.#checked.delete(m.name);
          this.#rebind();
        });
        label.append(cb, el('span', m.label || m.name));
        label.title = m.label ? `${m.label} (${m.name})` : m.name;
        this.#varsBox.append(label);
      }
    }
    if (changed) this.#rebind();
  }

  /** Bind the checked variables into R as `vars` and update the info line. */
  async #rebind() {
    const cols = [...this.#checked];
    const multiple = cols.length > 1;
    try {
      await this.#webr.consoleBind(cols, multiple);
    } catch (err) {
      this.#append(`Could not expose variables: ${err.message}`, 'rc-err');
      return;
    }
    if (!cols.length) {
      this.#varsInfo.textContent = 'nothing checked';
    } else if (multiple) {
      this.#varsInfo.textContent = `vars — a data.frame (${cols.join(', ')})`;
    } else {
      this.#varsInfo.textContent = `vars — a vector (${cols[0]})`;
    }
  }

  // --- libraries -------------------------------------------------------------

  async #refreshLibs() {
    try {
      const r = await this.#webr.run('paste(rev(.packages()), collapse = ", ")');
      const s = String(Array.isArray(r.result?.values) ? r.result.values[0] : r.result || '');
      this.#libsInfo.textContent = s || '(none)';
    } catch {
      this.#libsInfo.textContent = '(unavailable)';
    }
  }

  async #loadLibrary(name) {
    if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name)) {
      this.#append(`Not a valid package name: ${name}`, 'rc-err');
      return;
    }
    this.#append(`# loading library ${name}…`, 'rc-note');
    try {
      await this.#webr.installPackages([name]);
    } catch {
      /* may already be installed, or not in the WebR repo — library() reports it */
    }
    const res = await this.#webr.evalConsole(`suppressPackageStartupMessages(library(${name}))`);
    if (res.error) this.#append(res.output || `could not load ${name}`, 'rc-err');
    else this.#append(`${name} loaded.`, 'rc-note');
    void this.#refreshLibs();
  }

  // --- REPL ------------------------------------------------------------------

  #onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = this.#input.value;
      if (code.trim()) void this.#submit(code);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.#recall(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.#recall(1);
    }
  }

  #recall(dir) {
    if (!this.#history.length) return;
    if (this.#histIdx === -1) this.#histIdx = this.#history.length;
    this.#histIdx = Math.max(0, Math.min(this.#history.length, this.#histIdx + dir));
    this.#input.value = this.#history[this.#histIdx] ?? '';
    // caret to end
    const v = this.#input.value;
    this.#input.value = '';
    this.#input.value = v;
  }

  async #submit(code) {
    this.#history.push(code);
    this.#histIdx = -1;
    this.#append(code, 'rc-cmd');
    this.#input.value = '';
    this.#input.disabled = true;
    try {
      const res = await this.#webr.evalConsole(code);
      if (res.output) this.#append(res.output, res.error ? 'rc-err' : 'rc-result');
    } catch (err) {
      this.#append(String(err?.message ?? err), 'rc-err');
    } finally {
      this.#input.disabled = false;
      this.#input.focus();
    }
  }

  /** Append a text block to the terminal and scroll to it. */
  #append(text, cls) {
    const div = el('div', text, cls);
    if (cls === 'rc-cmd') div.textContent = `> ${text}`;
    this.#out.append(div);
    this.#out.scrollTop = this.#out.scrollHeight;
  }
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
