/**
 * @file rehome-ui.js
 * The dialog for moving or copying a dataset's coding and analyses to another dataset
 * (#151). The decisions live in ./rehome.js; this only gathers the choices and shows
 * what will happen.
 *
 * Offered from two places, because the problem arrives two ways:
 *  - **Proactively at a swap** — you imported a corrected file over a dataset that had
 *    coding on it. This is the moment the work would otherwise be silently orphaned, so
 *    it is the moment to ask; by the time someone goes looking for a menu item they may
 *    already have re-done it by hand.
 *  - **From the Data menu** — you imported to a NEW dataset, keeping the old as a
 *    backup. Nothing detached, so nothing prompted, but you still want the coding moved.
 */

import { planRowMap, planRehome, gatherRehome, applyRehome } from './rehome.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Ask, then do. Resolves to a result summary, or null if the user cancelled.
 *
 * @param {object} arg
 * @param {string|number} arg.fromId
 * @param {string|number} [arg.toId]  fixed at a swap; chosen in the dialog otherwise
 * @param {object} arg.deps  { datasets, itemStore, analysisLog, decls, replay, newId }
 * @param {string} [arg.reason]  why this is being offered (the swap case explains itself)
 */
export async function openRehomeDialog({ fromId, toId, deps, reason }) {
  const { datasets, itemStore, analysisLog, decls } = deps;
  const from = datasets.get(fromId);
  const gathered = gatherRehome({ fromId, itemStore, decls, analysisLog });

  // Nothing attached is worth saying rather than showing an empty dialog — and at a
  // swap it means saying nothing at all, since an unprompted "nothing happened" dialog
  // in the middle of an import is pure noise.
  if (!gathered.items.length && !gathered.analyses.length) return { nothing: true };

  const targets = datasets.list().filter((d) => String(d.id) !== String(fromId));
  if (!targets.length) return { nothing: true };

  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog';
  const fromName = from?.name ?? datasets.list().find((d) => String(d.id) === String(fromId))?.name ?? 'the old dataset';

  dialog.innerHTML = `
    <form method="dialog" class="ct-dialog__form ct-edit">
      <h2 class="ct-dialog__title">Bring coding and analyses across?</h2>
      <p class="ct-dialog__hint">${esc(reason
        || `“${fromName}” has work attached that is not part of the data itself.`)}</p>
      <label class="ct-field">Move to
        <select name="to">${targets.map((d) => `<option value="${esc(d.id)}"${String(d.id) === String(toId) ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      </label>
      <label class="ct-field">What to do
        <select name="mode">
          <option value="move">Move — leave nothing behind</option>
          <option value="copy">Copy — keep the original intact too</option>
        </select>
        <span class="ct-hint">Copy if you are splitting the data, or keeping the old dataset as a backup.</span>
      </label>
      <label class="ct-field">Match rows by
        <select name="key"><option value="">Row position (works when the rows are unchanged)</option></select>
        <span class="ct-hint">Only needed if rows were added, removed or reordered — then pick a column that identifies a row, like a participant id.</span>
      </label>
      <div class="ct-dialog__hint" data-plan style="min-height:3.2em"></div>
      <menu class="ct-dialog__buttons">
        <button value="cancel" type="submit">Not now</button>
        <button value="ok" type="submit" class="ct-dialog__primary">Bring it across</button>
      </menu>
    </form>`;

  const toSel = dialog.querySelector('[name=to]');
  const modeSel = dialog.querySelector('[name=mode]');
  const keySel = dialog.querySelector('[name=key]');
  const planEl = dialog.querySelector('[data-plan]');

  /** Row ids (and optionally a key column) for one dataset, read without activating it. */
  const readRows = async (id, keyVar) => {
    const store = datasets.get(id);
    if (!store) return { rids: [], keys: null };
    // At least one variable must be named or no rows come back at all — `includeRowId`
    // adds `__rid` to a projection, it does not create one. When there is no key column
    // we only want the ids, so any single column will do as the carrier.
    const first = store.getVariableMeta?.()?.[0]?.name;
    const vars = keyVar ? [keyVar] : (first ? [first] : []);
    if (!vars.length) return { rids: [], keys: null };
    const rows = await store.getRows({ variables: vars, includeRowId: true, limit: 1e6 });
    return {
      rids: rows.map((r) => String(r.__rid)),
      keys: keyVar ? rows.map((r) => r[keyVar]) : null,
    };
  };

  /** Columns both datasets share — the only ones that could match rows across them. */
  const fillKeys = async () => {
    const a = datasets.get(fromId)?.getVariableMeta?.() ?? [];
    const b = datasets.get(toSel.value)?.getVariableMeta?.() ?? [];
    const bNames = new Set(b.map((v) => v.name));
    const shared = a.map((v) => v.name).filter((n) => bNames.has(n));
    keySel.innerHTML = '<option value="">Row position (works when the rows are unchanged)</option>'
      + shared.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  };

  let current = null;
  const refresh = async () => {
    planEl.textContent = 'Checking…';
    const keyVar = keySel.value || null;
    const [a, b] = await Promise.all([readRows(fromId, keyVar), readRows(toSel.value, keyVar)]);
    const rowMap = planRowMap({ fromRids: a.rids, toRids: b.rids, fromKeys: a.keys, toKeys: b.keys });
    const plan = planRehome({ items: gathered.items, decls, analyses: gathered.analyses, rowMap });
    current = { rowMap, plan };

    const bits = [];
    for (const c of plan.collections) bits.push(`${c.move} ${c.collection}`);
    if (plan.analyses) bits.push(`${plan.analyses} ${plan.analyses === 1 ? 'analysis' : 'analyses'} (re-run against the new data)`);
    let msg = bits.length ? `Will bring across: ${bits.join(', ')}.` : 'Nothing can be brought across.';
    if (plan.stranded) {
      msg += ` ${plan.stranded} cannot be matched to a row in the new data and will stay behind`
        + `${keyVar ? '' : ' — try matching by a column instead'}.`;
    }
    if (rowMap.ambiguous.length) msg += ` ${rowMap.ambiguous.length} row(s) share a key value, so they are ambiguous and were skipped.`;
    planEl.textContent = msg;
  };

  toSel.addEventListener('change', async () => { await fillKeys(); await refresh(); });
  keySel.addEventListener('change', refresh);
  await fillKeys();
  await refresh();

  document.body.append(dialog);
  const choice = await new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
  const mode = modeSel.value;
  const toChosen = toSel.value;
  dialog.remove();
  if (choice !== 'ok' || !current) return null;

  return applyRehome({
    fromId,
    toId: toChosen,
    rowMap: current.rowMap,
    items: gathered.items,
    decls,
    analyses: gathered.analyses,
    itemStore,
    analysisLog,
    replay: deps.replay,
    newId: deps.newId,
    mode,
  });
}
