/**
 * @file ui-service.js
 * Host-rendered dialogs for plugins (`app.ui`).
 *
 * Because every plugin runs in a sandboxed iframe with no access to the host
 * DOM, a plugin cannot draw its own dialog onto the page. Instead it *describes*
 * the interaction it needs and the engine renders it, in the host document, and
 * returns the result across the postMessage boundary. This also gives every
 * analysis a consistent, SPSS-like dialog look without each plugin reinventing
 * one.
 *
 * The first primitive is {@link UiService#selectVariables} — the variable picker
 * almost every analysis opens with. A general declarative form dialog
 * (`showForm`) is the natural next primitive once a second analysis needs
 * options beyond variable choice; it is intentionally not built yet.
 */

/**
 * @typedef {Object} SelectVariablesOptions
 * @property {string} [title='Select variables']
 * @property {string} [hint] - Sub-heading explaining the choice.
 * @property {boolean} [multiple=true] - Allow multiple selection (checkboxes)
 *   vs. single (radios).
 * @property {string[]} [preselect] - Variable names checked initially. Defaults
 *   to the user's current sidebar selection.
 * @property {Array<'numeric'|'string'|'factor'>} [types] - Restrict the list to
 *   these variable types (e.g. only categorical variables for a crosstab).
 * @property {string} [okLabel='OK']
 */

export class UiService {
  /** @type {import('./data-store.js').DataStore} */
  #store;

  /**
   * @param {import('./data-store.js').DataStore} dataStore - Source of variable
   *   metadata and the current selection.
   */
  constructor(dataStore) {
    this.#store = dataStore;
  }

  /**
   * Show a modal variable picker and resolve with the chosen variable names, or
   * `null` if the user cancels.
   *
   * @param {SelectVariablesOptions} [options]
   * @returns {Promise<string[] | null>}
   */
  selectVariables(options = {}) {
    const {
      title = 'Select variables',
      hint,
      multiple = true,
      preselect,
      types,
      okLabel = 'OK',
    } = options;

    let meta = this.#store.getVariableMeta();
    if (types?.length) meta = meta.filter((m) => types.includes(m.type));
    const checked = new Set(preselect ?? this.#store.getSelectedVariables());
    const inputType = multiple ? 'checkbox' : 'radio';

    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      dialog.innerHTML = `
        <form method="dialog" class="ct-dialog__form">
          <h2 class="ct-dialog__title">${esc(title)}</h2>
          ${hint ? `<p class="ct-dialog__hint">${esc(hint)}</p>` : ''}
          <ul class="ct-dialog__vars">
            ${meta
              .map(
                (m) => `
              <li>
                <label>
                  <input type="${inputType}" name="var" value="${attr(m.name)}"
                         ${checked.has(m.name) ? 'checked' : ''}>
                  <span>${esc(m.label ?? m.name)}</span>
                  <code>${esc(m.name)}</code>
                </label>
              </li>`,
              )
              .join('')}
          </ul>
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">${esc(okLabel)}</button>
          </menu>
        </form>`;

      document.body.append(dialog);
      dialog.addEventListener('close', () => {
        const chosen = [...dialog.querySelectorAll('input[name="var"]:checked')].map(
          (el) => el.value,
        );
        dialog.remove();
        resolve(dialog.returnValue === 'ok' ? chosen : null);
      });
      dialog.showModal();
    });
  }

  /**
   * Show a modal, **searchable** multi-select over an arbitrary list of items —
   * for choosing from data the engine doesn't hold yet (e.g. the variable
   * catalog of a file *before* import, which can be thousands of entries).
   * Unlike {@link UiService#selectVariables}, the candidate list is supplied by
   * the caller rather than read from the dataset.
   *
   * @param {Object} [options]
   * @param {string} [options.title='Select']
   * @param {string} [options.hint]
   * @param {Array<{value: string, label?: string}>} [options.items]
   * @param {boolean} [options.multiple=true]
   * @param {string} [options.okLabel='OK']
   * @param {string} [options.searchPlaceholder='Filter…']
   * @returns {Promise<string[] | null>} Chosen values, or `null` if cancelled.
   */
  selectFromList(options = {}) {
    const {
      title = 'Select',
      hint,
      items = [],
      multiple = true,
      okLabel = 'OK',
      searchPlaceholder = 'Filter…',
    } = options;
    const CAP = 500; // max rows rendered at once; refine search to see more
    const selected = new Set();

    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      const form = document.createElement('form');
      form.method = 'dialog';
      form.className = 'ct-dialog__form';

      const h2 = document.createElement('h2');
      h2.className = 'ct-dialog__title';
      h2.textContent = title;
      form.append(h2);
      if (hint) {
        const p = document.createElement('p');
        p.className = 'ct-dialog__hint';
        p.textContent = hint;
        form.append(p);
      }

      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = searchPlaceholder;
      search.style.cssText =
        'width:100%; padding:8px; margin:0 0 8px; border:1px solid var(--line,#ccc);' +
        ' border-radius:6px; font:inherit;';
      // Enter in the search box would submit the form (= Cancel); suppress it.
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
      });
      form.append(search);

      const bar = document.createElement('div');
      bar.style.cssText =
        'display:flex; justify-content:space-between; align-items:center;' +
        ' margin:0 0 8px; font-size:13px; color:#5a6470;';
      const count = document.createElement('span');
      bar.append(count);
      if (multiple) {
        const selAll = document.createElement('button');
        selAll.type = 'button';
        selAll.textContent = 'Select all shown';
        selAll.style.cssText =
          'font:inherit; font-size:13px; background:none; border:none;' +
          ' color:var(--accent,#2980b9); cursor:pointer; padding:0;';
        selAll.addEventListener('click', () => {
          for (const it of shown) selected.add(it.value);
          render();
        });
        bar.append(selAll);
      }
      form.append(bar);

      const list = document.createElement('ul');
      list.className = 'ct-dialog__vars';
      form.append(list);

      const menu = document.createElement('menu');
      menu.className = 'ct-dialog__buttons';
      const cancel = document.createElement('button');
      cancel.type = 'submit';
      cancel.value = 'cancel';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.type = 'submit';
      ok.value = 'ok';
      ok.className = 'ct-dialog__primary';
      ok.textContent = okLabel;
      menu.append(cancel, ok);
      form.append(menu);
      dialog.append(form);

      let shown = [];
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const matches = q
          ? items.filter(
              (it) =>
                (it.label ?? it.value).toLowerCase().includes(q) ||
                it.value.toLowerCase().includes(q),
            )
          : items;
        shown = matches.slice(0, CAP);
        list.replaceChildren();
        for (const it of shown) {
          const li = document.createElement('li');
          const label = document.createElement('label');
          const input = document.createElement('input');
          input.type = multiple ? 'checkbox' : 'radio';
          input.name = 'item';
          input.value = it.value;
          input.checked = selected.has(it.value);
          input.addEventListener('change', () => {
            if (!multiple) selected.clear();
            if (input.checked) selected.add(it.value);
            else selected.delete(it.value);
            count.textContent = `${selected.size} selected`;
          });
          const span = document.createElement('span');
          span.textContent = it.label ?? it.value;
          const code = document.createElement('code');
          code.textContent = it.value;
          label.append(input, span, code);
          li.append(label);
          list.append(li);
        }
        if (matches.length > CAP) {
          const li = document.createElement('li');
          li.style.cssText = 'color:#7a8590; padding:6px;';
          li.textContent = `Showing first ${CAP} of ${matches.length} — refine your filter.`;
          list.append(li);
        }
        count.textContent = `${selected.size} selected`;
      };
      search.addEventListener('input', render);
      render();

      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(dialog.returnValue === 'ok' ? [...selected] : null);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /**
   * Show a modal form of text inputs and resolve with the entered values (or
   * `null` if cancelled). The general declarative input dialog — for analysis
   * options or, e.g., a FRED importer asking for a series ID and API key.
   *
   * @param {Object} [options]
   * @param {string} [options.title='Form']
   * @param {string} [options.hint]
   * @param {Array<{name: string, label?: string, type?: 'text'|'password'|'number', value?: string, placeholder?: string, hint?: string}>} [options.fields]
   * @param {string} [options.okLabel='OK']
   * @returns {Promise<Record<string,string> | null>}
   */
  showForm(options = {}) {
    const { title = 'Form', hint, fields = [], okLabel = 'OK' } = options;
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-dialog';
      const fieldHtml = fields
        .map((f) => {
          const type = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
          return `
            <label class="ct-field">${esc(f.label ?? f.name)}${
              f.hint ? ` <span class="ct-hint">${esc(f.hint)}</span>` : ''
            }
              <input name="${attr(f.name)}" type="${type}" value="${attr(f.value ?? '')}"
                     placeholder="${attr(f.placeholder ?? '')}" autocomplete="off">
            </label>`;
        })
        .join('');
      dialog.innerHTML = `
        <form method="dialog" class="ct-dialog__form ct-edit">
          <h2 class="ct-dialog__title">${esc(title)}</h2>
          ${hint ? `<p class="ct-dialog__hint">${esc(hint)}</p>` : ''}
          ${fieldHtml}
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">${esc(okLabel)}</button>
          </menu>
        </form>`;
      dialog.addEventListener('close', () => {
        const ok = dialog.returnValue === 'ok';
        const out = {};
        if (ok) {
          for (const f of fields) {
            const el = dialog.querySelector(`input[name="${attr(f.name)}"]`);
            out[f.name] = el ? el.value : '';
          }
        }
        dialog.remove();
        resolve(ok ? out : null);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /**
   * The frozen object exposed to plugins as `app.ui`.
   * @returns {Readonly<{
   *   selectVariables: (opts?: SelectVariablesOptions) => Promise<string[]|null>,
   *   selectFromList: (opts?: object) => Promise<string[]|null>,
   *   showForm: (opts?: object) => Promise<Record<string,string>|null>,
   * }>}
   */
  get api() {
    return Object.freeze({
      selectVariables: (opts) => this.selectVariables(opts),
      selectFromList: (opts) => this.selectFromList(opts),
      showForm: (opts) => this.showForm(opts),
    });
  }
}

/** HTML-escape text content. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for an HTML attribute value. */
function attr(s) {
  return esc(s).replace(/"/g, '&quot;');
}
