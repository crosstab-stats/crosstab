/**
 * @file dataset-ops.js
 * Host UI for dataset-level manipulation under the **Transform** menu (#121):
 *  - **Extract columns to a new dataset…** — copy a chosen subset of columns into a
 *    brand-new dataset (non-destructive; the current dataset is untouched).
 *  - **Join with another dataset…** — add columns from another *open* project
 *    dataset into the active one by matching a key, with the full standard set of
 *    join types (inner / left / right / full outer).
 *
 * Both lean on machinery that already exists: {@link DatasetManager#createWithData}
 * for the new dataset, and the engine's logged `join` op
 * ({@link DataStore#loadDataset} `mode:'join'`) — which already handles all four
 * join types and renames any non-key column whose name collides with the base.
 * Host-owned (draws host dialogs, drives engine methods), same tier as
 * compute-recode.js and the data grid — not a sandboxed plugin.
 */

/** Join types offered everywhere (here + the import dialog), labelled so the
 * "outer" variants read explicitly. Order: most common first. */
export const JOIN_TYPES = [
  { value: 'left', label: 'Left outer — keep all rows from this dataset' },
  { value: 'inner', label: 'Inner — keep only matched rows' },
  { value: 'right', label: 'Right outer — keep all rows from the other dataset' },
  { value: 'full', label: 'Full outer — keep all rows from both' },
];

export class DatasetOps {
  #datasets;
  #menus;
  #results;
  #ui;

  /**
   * @param {Object} deps
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendText: Function, appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./ui-service.js').UiService} deps.ui
   */
  constructor({ datasets, menus, results, ui }) {
    this.#datasets = datasets;
    this.#menus = menus;
    this.#results = results;
    this.#ui = ui;
  }

  activate() {
    this.#menus.register({
      id: 'core:extract-columns',
      path: ['Transform'],
      label: 'Extract columns to a new dataset…',
      order: 40,
      command: () => void this.#extractColumns(),
    });
    this.#menus.register({
      id: 'core:join-datasets',
      path: ['Transform'],
      label: 'Join with another dataset…',
      order: 50,
      command: () => void this.#joinDatasets(),
    });
  }

  // --- extract columns → new dataset -----------------------------------------

  async #extractColumns() {
    const src = this.#datasets.active;
    if (!src || !src.rowCount) {
      this.#results.appendError('Extract columns: no data is loaded.');
      return;
    }
    const names = await this.#ui.selectVariables({
      title: 'Extract columns to a new dataset',
      hint: 'Pick the columns to copy into a new dataset. This is a non-destructive copy — the current dataset is unchanged.',
      multiple: true,
      okLabel: 'Extract',
    });
    if (!names || !names.length) return; // cancelled / nothing chosen

    try {
      // Preserve full metadata (labels, value labels, measurement, missing) by
      // carrying the chosen variables' meta objects through, in the chosen order.
      const metaByName = new Map(src.getVariableMeta().map((m) => [m.name, m]));
      const variables = names.map((n) => metaByName.get(n)).filter(Boolean);
      const columns = await src.getColumns({ variables: names });
      const name = `${src.name} (extract)`;
      await this.#datasets.createWithData({ name, variables, columns, activate: true });
      this.#results.appendText(
        `Extracted ${names.length} column${names.length === 1 ? '' : 's'} into a new dataset **${name}**.`,
      );
    } catch (err) {
      console.error('[dataset-ops] extract failed', err);
      this.#results.appendError(`Extract columns failed: ${err.message}`);
    }
  }

  // --- join with another open dataset ----------------------------------------

  async #joinDatasets() {
    const active = this.#datasets.active;
    if (!active || !active.rowCount) {
      this.#results.appendError('Join: no active dataset with data.');
      return;
    }
    const others = this.#datasets.all().filter((d) => d.id !== active.id && d.rowCount);
    if (!others.length) {
      this.#results.appendError('Join: add a second dataset to this project first (File ▸ Import data…, “into a new dataset”).');
      return;
    }

    // 1) Pick which other dataset to join in.
    const pick = await this.#ui.selectFromList({
      title: 'Join with another dataset',
      hint: `Add columns from another dataset into “${active.name}” by matching a key.`,
      items: others.map((d) => ({ value: String(d.id), label: `${d.name} (${d.rowCount.toLocaleString()} rows)` })),
      multiple: false,
      okLabel: 'Next',
    });
    const otherId = Array.isArray(pick) ? pick[0] : pick;
    if (otherId == null) return;
    const other = this.#datasets.get(Number(otherId));
    if (!other) return;

    // 2) Pick the key columns + join type.
    const review = await this.#askJoin(active, other);
    if (!review) return;

    // 3) Apply: feed the other dataset's columns into the active one as a join
    //    source. The engine's join op renames any non-key name clash with an
    //    " (<other name>)" suffix, so columns never collide silently.
    try {
      const variables = other.getVariableMeta();
      const columns = await other.getColumns();
      await active.loadDataset({
        variables,
        columns,
        mode: 'join',
        source: other.name,
        joinKey: review.joinKey,
        aliases: [],
        joinType: review.joinType,
      });
      const label = JOIN_TYPES.find((t) => t.value === review.joinType)?.label.split(' —')[0] || review.joinType;
      this.#results.appendText(
        `Joined **${other.name}** into **${active.name}** — ${label} join on ` +
          `\`${review.joinKey.left}\` ↔ \`${review.joinKey.right}\`.`,
      );
    } catch (err) {
      console.error('[dataset-ops] join failed', err);
      this.#results.appendError(`Join failed: ${err.message}`);
    }
  }

  /** Modal: choose the left key (active), right key (other), and join type.
   * Resolves `{joinKey:{left,right}, joinType}` or null. */
  #askJoin(active, other) {
    const leftVars = active.getVariableMeta();
    const rightVars = other.getVariableMeta();
    // Smart default: a column name present in both is almost always the key.
    const rightNames = new Set(rightVars.map((m) => m.name));
    const common = leftVars.find((m) => rightNames.has(m.name))?.name;

    const optionsFor = (vars, selectedName) =>
      vars
        .map((m) => {
          const lbl = m.label && m.label !== m.name ? `${m.label} (${m.name})` : m.name;
          return `<option value="${attr(m.name)}"${m.name === selectedName ? ' selected' : ''}>${esc(lbl)}</option>`;
        })
        .join('');

    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'ct-dialog';
      d.innerHTML = `
        <form method="dialog" class="ct-dialog__form">
          <h2 class="ct-dialog__title">Join “${esc(other.name)}” into “${esc(active.name)}”</h2>
          <p class="ct-dialog__hint">Match rows by a key column on each side. Columns from
            “${esc(other.name)}” are added; a name that clashes gets an “ (${esc(other.name)})” suffix.</p>
          <label class="ct-dialog__row"><span>Key in “${esc(active.name)}”</span>
            <select name="left">${optionsFor(leftVars, common)}</select></label>
          <label class="ct-dialog__row"><span>Key in “${esc(other.name)}”</span>
            <select name="right">${optionsFor(rightVars, common)}</select></label>
          <label class="ct-dialog__row"><span>Join type</span>
            <select name="jtype">${JOIN_TYPES.map((t) => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}</select></label>
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary">Join</button>
          </menu>
        </form>`;
      d.addEventListener('close', () => {
        const ok = d.returnValue === 'ok';
        const left = d.querySelector('select[name="left"]').value;
        const right = d.querySelector('select[name="right"]').value;
        const joinType = d.querySelector('select[name="jtype"]').value;
        d.remove();
        resolve(ok && left && right ? { joinKey: { left, right }, joinType } : null);
      });
      document.body.append(d);
      d.showModal();
    });
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function attr(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
