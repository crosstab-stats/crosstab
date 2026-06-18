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
   * The frozen object exposed to plugins as `app.ui`.
   * @returns {Readonly<{ selectVariables: (opts?: SelectVariablesOptions) => Promise<string[]|null> }>}
   */
  get api() {
    return Object.freeze({
      selectVariables: (opts) => this.selectVariables(opts),
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
