/**
 * @file library.js
 * The **building-block dataset library** — tier 2 of the two-tier model.
 *
 * A building block is a canonical, reusable dataset saved to OPFS
 * ({@link DatasetStore}): a cleaned GSS extract, a FRED series, a derived set.
 * Unlike a *project* (the living, autosaved working set — see
 * {@link ProjectSync}), the library is **explicit-save only**: you choose to
 * "Save dataset to library", and you "Add dataset from library" to pull a
 * **copy** into the current project. Because it's a copy, editing it in a project
 * never mutates the shared building block, and the project autosaves the copy.
 *
 * (There is intentionally no per-dataset autosave/binding here anymore — that
 * moved up to the project tier.)
 */

/** Bus event: the building-block library changed (block saved/deleted) — the
 * sidebar's Building Blocks zone re-renders on this. */
import { newItemId } from './item-store.js';
import { childrenOf } from './collections.js';

export const LIBRARY_CHANGED = 'library:changed';

/** The library's linked-dataset overlay boundary is the count of **transform** ops in a
 * recipe (the block's base transforms; a linked dataset's *local* edits are the ops
 * beyond it). Source ops (load/append/join) don't count. Works on the op recipe
 * {@link module:core/data-store~DataStore#exportState} / {@link DatasetStore#load} produce. */
const transformCount = (ops) => (Array.isArray(ops) ? ops.filter((o) => !['load', 'append', 'join'].includes(o.type)).length : 0);

export class DatasetLibrary {
  #store;
  #data;
  #ui;
  #menus;
  #results;
  #bus;

  /**
   * @param {Object} deps
   * @param {import('./dataset-store.js').DatasetStore} deps.datasetStore
   * @param {import('./dataset-manager.js').DatasetManager} deps.data
   * @param {import('./ui-service.js').UiService} deps.ui
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendError: Function, appendText: Function}} deps.results
   * @param {import('./event-bus.js').EventBus} deps.bus
   */
  /** Item tier + asset store + collection declarations, for RECORD blocks (#153 step 4).
   * Absent ⇒ record promotion is simply unavailable and datasets behave as before. */
  #items = null;
  #assets = null;
  #decls = () => [];

  constructor({ datasetStore, data, ui, menus, results, bus, items, assets, collections }) {
    this.#store = datasetStore;
    this.#data = data;
    this.#ui = ui;
    this.#menus = menus;
    this.#results = results;
    this.#bus = bus;
    this.#items = items ?? null;
    this.#assets = assets ?? null;
    this.#decls = collections ?? (() => []);
  }

  /** List building blocks (for the sidebar). */
  list() {
    return this.#store.list();
  }

  activate() {
    if (!this.#store.available) return; // no OPFS → no library
    this.#menus.register({
      id: 'core:lib-save',
      path: ['File'],
      label: 'Save dataset to library…',
      order: 20,
      command: () => void this.saveToLibrary(),
    });
    this.#menus.register({
      id: 'core:lib-add',
      path: ['File'],
      label: 'Add dataset from library…',
      order: 21,
      command: () => void this.addFromLibrary(),
    });
  }

  /** Save the active dataset to the building-block library. If it's the working
   * copy of an existing block (has a `libraryOrigin`), this UPDATES that block;
   * otherwise it creates a new one. Either way it's an explicit, intentional push
   * — no autosave to the library (the project owns autosave). */
  async saveToLibrary() {
    const ds = this.#data.active;
    if (!ds || ds.rowCount === 0) {
      this.#results.appendError('Save to library: no data is loaded.');
      return;
    }
    // Does this dataset already correspond to a still-existing block?
    let existing = null;
    if (ds.libraryLink) {
      try {
        existing = (await this.#store.list()).find((e) => e.id === ds.libraryLink.id) ?? null;
      } catch {
        existing = null;
      }
    }
    const form = await this.#ui.showForm({
      title: existing ? 'Update building block' : 'Save dataset to library',
      hint: existing
        ? `Update the existing building block “${existing.name}” (→ v${(existing.version || 1) + 1}).`
        : 'Make this dataset a reusable building block you can add to any project.',
      fields: [{ name: 'name', label: 'Name', value: existing?.name ?? ds.name }],
      okLabel: existing ? 'Update' : 'Save',
    });
    const name = form?.name?.trim();
    if (!name) return;
    try {
      const state = await ds.exportState({ includeParquet: true });
      const { id, version } = await this.#store.save(
        { id: existing?.id, name, savedAt: Date.now(), state },
        { writeSources: true },
      );
      // The whole current state is now the block, so there's no local overlay:
      // baseLen = all transforms.
      ds.libraryLink = { id, version, baseLen: transformCount(state.ops) };
      this.#bus?.emit(LIBRARY_CHANGED);
      this.#results.appendText(
        existing ? `Updated **${name}** in the library (v${version}).` : `Saved **${name}** to the library (v${version}).`,
      );
    } catch (err) {
      console.error('[library] save failed', err);
      this.#results.appendError(`Save to library failed: ${err.message}`);
    }
  }

  /**
   * Promote a dataset to a NEW building block (v1) and link the dataset to it —
   * the drag-to-Building-Blocks gesture. The dataset keeps its (cached) copy and
   * is now marked "linked to v1".
   *
   * @param {number} datasetId
   */
  async promoteToBlock(datasetId) {
    const ds = this.#data.get(datasetId);
    if (!ds || ds.rowCount === 0) return;
    try {
      const state = await ds.exportState({ includeParquet: true });
      const { id, version } = await this.#store.save(
        { name: ds.name, savedAt: Date.now(), state },
        { writeSources: true },
      );
      ds.libraryLink = { id, version, baseLen: transformCount(state.ops) };
      this.#bus?.emit(LIBRARY_CHANGED);
      this.#data.touch?.(); // refresh the sidebar's "linked" badge
      this.#results.appendText(`Promoted **${ds.name}** to a building block (v${version}).`);
    } catch (err) {
      console.error('[library] promote failed', err);
      this.#results.appendError(`Promote to building block failed: ${err.message}`);
    }
  }

  /**
   * Promote a plugin RECORD to a building block (#153 step 4) — a map layer, say.
   *
   * A record block is the record's fields plus the bytes of every asset its declared
   * `assetRefs` point at. That declaration is what makes this possible at all: the host
   * cannot read a plugin's schema, but it knows which fields hold refs, so it can gather
   * exactly the bytes the record needs and nothing else.
   */
  async promoteRecordToBlock(owner, collection, recordId) {
    if (!this.#items || !this.#assets) return;
    const rec = this.#items.get(owner, collection, recordId);
    if (!rec) return;
    const decls = this.#decls();
    const decl = decls.find((d) => d.owner === owner && d.id === collection) ?? null;
    const name = (decl?.labelField && rec.fields?.[decl.labelField]) || rec.id;
    try {
      // Everything that COMPOSES into this record travels with it: a codebook without its
      // codes is a name and nothing else. Composition is declared (`parent`), never
      // inferred — and a mere dependency is deliberately NOT collected, which is what
      // stops a shared codebook carrying its codings, i.e. passages of real participant
      // data, to whoever it is handed to.
      const kids = childrenOf(decls, owner, collection);
      const children = [];
      for (const kid of kids) {
        for (const child of this.#items.list(owner, kid.id)) {
          if (String(child.fields?.[kid.parent.field] ?? '') !== String(recordId)) continue;
          children.push({
            collection: kid.id,
            id: child.id,
            parentField: kid.parent.field,
            fields: { ...child.fields },
            assetRefs: kid.assetRefs ?? [],
          });
        }
      }

      // Gather the bytes for the parent AND every child, so the block is whole.
      const assets = [];
      const seen = new Set();
      const gather = async (fields, fieldNames, label) => {
        for (const field of fieldNames ?? []) {
          const ref = fields?.[field];
          if (!ref) continue;
          const assetId = String(ref).replace(/^asset:/, '');
          if (seen.has(assetId)) continue;
          seen.add(assetId);
          const got = await this.#assets.get(assetId);
          if (got) assets.push({ id: assetId, bytes: got.bytes, type: got.type, name: got.name });
          else this.#results.appendError(`"${label}": the file behind ${field} is missing — saved without it.`);
        }
      };
      await gather(rec.fields, decl?.assetRefs, name);
      for (const child of children) await gather(child.fields, child.assetRefs, name);

      const { version } = await this.#store.saveRecord({
        name,
        savedAt: Date.now(),
        // The record keeps its ID in the block. That identity is what lets a later pull
        // match this project's copy against the block's, and what lets two projects that
        // adopted the same block recognise it as shared ancestry rather than duplicating
        // every record (#166 §13.2).
        record: { owner, collection, id: recordId, fields: { ...rec.fields } },
        children,
        assets,
      });
      this.#bus?.emit(LIBRARY_CHANGED);
      this.#results.appendText(`Saved **${name}** as a building block (v${version}).`);
    } catch (err) {
      console.error('[library] record promote failed', err);
      this.#results.appendError(`Save to library failed: ${err.message}`);
    }
  }

  /**
   * Add a record block into the current project.
   *
   * **Ids are preserved, not re-minted (#166).** They used to be re-minted so a copy was
   * self-contained — but the copy is self-contained either way (the records live in this
   * project's log; deleting the library entry dangles nothing), and re-minting cost two
   * things that matter more. A later *pull* had nothing to match my code against the
   * block's, so an updated codebook could not be merged at all; and two projects that
   * adopted the same codebook shared no identity, so collaborating later would have
   * duplicated every code instead of recognising them as common ancestry.
   *
   * Adding the same block twice is therefore a no-op rather than a second copy, which is
   * the right default: adopting one codebook twice should not double it. Wanting a
   * divergent copy is a *duplicate* action inside the project, not a second add.
   *
   * Asset ids are content hashes, so re-storing identical bytes yields the same id and
   * two projects that add the same block do not duplicate the file.
   */
  async #addRecordBlock(block) {
    if (!this.#items || !this.#assets) return;
    const { owner, collection, fields, id } = block.record ?? {};
    if (!owner || !collection) return;

    // Re-store the bytes first, so every record written below points at ids that exist.
    const idMap = new Map();
    for (const a of block.assets ?? []) {
      try {
        const info = await this.#assets.put(a.bytes, { type: a.type, name: a.name });
        idMap.set(a.id, info.id);
      } catch (err) {
        console.error('[library] asset restore failed', err);
        this.#results.appendError(`Adding "${block.name}": a referenced file could not be stored.`);
      }
    }
    const remap = (f) => {
      const out = { ...f };
      for (const [k, v] of Object.entries(out)) {
        if (typeof v !== 'string') continue;
        const bare = v.replace(/^asset:/, '');
        if (idMap.has(bare)) out[k] = `asset:${idMap.get(bare)}`;
      }
      return out;
    };

    const parentId = id || newItemId();
    this.#items.put(owner, collection, parentId, remap(fields), { scope: { dsId: null } });

    // Children COMPOSE into the parent, so they arrive with it — that is the difference
    // between a codebook and a label with a foreign key pointed at it. Their parent field
    // is repointed at the id used here, so a block added under a fresh id still hangs
    // together.
    let kids = 0;
    for (const child of block.children ?? []) {
      if (!child?.collection || !child.id) continue;
      const f = remap(child.fields ?? {});
      if (child.parentField) f[child.parentField] = parentId;
      this.#items.put(owner, String(child.collection), child.id, f, { scope: { dsId: null } });
      kids++;
    }
    this.#results.appendText(
      `Added **${block.name}** to this project${kids ? ` (${kids} item${kids === 1 ? '' : 's'})` : ''}.`,
    );
  }

  /** Add a copy of a building block into the current project, linked to its
   * current version. Public entry point for the sidebar / drag. */
  async addBlockToProject(id) {
    // Record blocks take their own path — they have no op recipe to replay.
    try {
      const probe = await this.#store.load(id);
      if (probe?.kind === 'record') { await this.#addRecordBlock(probe); this.#bus?.emit(LIBRARY_CHANGED); return; }
    } catch (err) {
      console.error('[library] block load failed', err);
      this.#results.appendError(`Could not open that building block: ${err.message}`);
      return;
    }
    await this.#add(id);
  }

  /** Delete a building block from the library. */
  async deleteBlock(id) {
    await this.#delete(id);
  }

  /**
   * Pull a linked dataset up to its building block's latest version: fetch the
   * new block data and **re-apply the dataset's local transforms** (those it
   * added after linking) on top — the feature-3 propagation. The dataset opts in
   * (pull, not push); other linked projects update only when they choose.
   *
   * Best-effort reconciliation: a local transform that now references a missing
   * variable simply no-ops (everything stays saved + undoable). Local *source*
   * additions to a linked dataset are not preserved (the block's sources replace
   * them) — linked datasets are expected to diverge via transforms.
   *
   * @param {number} datasetId
   */
  async pullLatest(datasetId) {
    const ds = this.#data.get(datasetId);
    if (!ds?.libraryLink) return;
    const { id, baseLen = 0 } = ds.libraryLink;
    try {
      const loaded = await this.#store.load(id); // { name, version, state:{ops} }
      const cur = ds.getTransforms();
      const local = cur.slice(Math.min(baseLen, cur.length)); // edits made after linking
      const blockOps = loaded.state.ops || []; // the block's sources + base transforms
      // Re-home the block's recipe with the dataset's local transforms re-applied on top.
      // APPENDED, never swapped in (#149 A2): this dataset is established and its ops may
      // already sit on a collaborator's copy, so physically dropping them would take them
      // out of the shared-id ancestor and the next merge would read the peer's copies as
      // additions — the old pipeline returning alongside the pulled one. The recipe opens
      // with a `load`, which is the replace barrier, so the superseded ops fold away on
      // every peer without being removed from anyone's log.
      await ds.restoreState({ ops: [...blockOps, ...local] }, { replaceHistory: false });
      ds.libraryLink = { id, version: loaded.version, baseLen: transformCount(blockOps) };
      this.#data.touch?.();
      this.#results.appendText(
        `Pulled **${ds.name}** to v${loaded.version}` +
          (local.length ? ` (re-applied ${local.length} local change${local.length === 1 ? '' : 's'}).` : '.'),
      );
    } catch (err) {
      console.error('[library] pull failed', err);
      this.#results.appendError(`Pull update failed: ${err.message}`);
    }
  }

  /** Browse building blocks and add a copy of one into the current project. */
  async addFromLibrary() {
    let entries;
    try {
      entries = await this.#store.list();
    } catch (err) {
      this.#results.appendError(`Library failed: ${err.message}`);
      return;
    }
    this.#showBrowseModal(entries);
  }

  /** Add a copy of a building block into the current project (as a new active
   * dataset). */
  async #add(id) {
    try {
      const { name, version, state } = await this.#store.load(id);
      const ds = this.#data.add(name, { activate: true });
      await ds.restoreState(state);
      // Linked @ this version; the block's transforms are the base, no overlay yet.
      ds.libraryLink = { id, version, baseLen: transformCount(state.ops) };
      this.#data.touch?.(); // refresh the "linked" badge
    } catch (err) {
      console.error('[library] add failed', err);
      this.#results.appendError(`Add from library failed: ${err.message}`);
    }
  }

  async #delete(id) {
    try {
      await this.#store.delete(id);
      this.#bus?.emit(LIBRARY_CHANGED);
    } catch (err) {
      this.#results.appendError(`Delete failed: ${err.message}`);
    }
  }

  // --- browse modal ----------------------------------------------------------

  #showBrowseModal(entries) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';
    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = 'Add dataset from library';
    form.append(h2);

    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'ct-dialog__hint';
      p.textContent = 'No building blocks yet. Use File ▸ Save dataset to library.';
      form.append(p);
    } else {
      const list = document.createElement('ul');
      list.className = 'ct-dialog__vars ct-lib__list';
      for (const e of entries) list.append(this.#entryRow(e, dialog));
      form.append(list);
    }

    const menu = document.createElement('menu');
    menu.className = 'ct-dialog__buttons';
    const close = document.createElement('button');
    close.type = 'submit';
    close.value = 'cancel';
    close.textContent = 'Close';
    menu.append(close);
    form.append(menu);
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  #entryRow(entry, dialog) {
    const li = document.createElement('li');
    li.className = 'ct-lib__row';
    const info = document.createElement('div');
    info.className = 'ct-lib__info';
    const name = document.createElement('div');
    name.className = 'ct-lib__name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'ct-lib__meta';
    const when = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : '';
    meta.textContent = `${entry.rowCount.toLocaleString()} rows · ${entry.varCount} vars${
      entry.sourceCount > 1 ? ` · ${entry.sourceCount} sources` : ''
    }${when ? ` · ${when}` : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'ct-lib__actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ct-dialog__primary';
    add.textContent = 'Add';
    add.addEventListener('click', () => {
      dialog.close('cancel');
      void this.#add(entry.id);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ct-lib__delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      del.disabled = true;
      await this.#delete(entry.id);
      li.remove();
    });
    actions.append(add, del);
    li.append(info, actions);
    return li;
  }
}
