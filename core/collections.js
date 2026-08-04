/**
 * @file collections.js
 * What a plugin (or core) declares about its **item collections** — the single
 * description the host reads for every generic behaviour it provides over records it
 * cannot otherwise interpret (#152).
 *
 * ## Why one declaration rather than several lists
 *
 * The host does three unrelated-looking things with plugin records, and every one of them
 * needs a different scrap of knowledge about the same collection:
 *
 *  - **Reference counting** needs to know which field holds an `asset:` ref, or a deleted
 *    boundary set leaks its bytes forever (#150).
 *  - **The sidebar inventory** needs a human label for the collection and which field is a
 *    record's display name, or it renders a heading called "boundarySets" and cannot offer
 *    rename (user, 2026-08-03: the sidebar is the project's inventory — the objection to
 *    plugin data was loss of visibility that "this project has data here").
 *  - **Presentation volume** needs to know that boundary sets should be listed but CAQDAS
 *    segments, which run to thousands, must not be.
 *
 * Three parallel manifest lists keyed by collection name would drift. One record per
 * collection cannot.
 *
 * The host still never learns the *schema*: `labelField` and `assetRefs` name fields, they
 * do not describe them. Everything else in `fields` stays opaque (#152 D1).
 */

/**
 * @typedef {Object} CollectionDecl
 * @property {string} id            Collection name, as passed to `app.items.*`.
 * @property {string} [label]       Human heading ("Map layers"). Defaults to `id`.
 * @property {string} [labelField]  Field holding a record's display name. Without it a
 *   record shows as its id and cannot be renamed generically.
 * @property {string} [summaryField] Field shown where a dataset shows its row count — a
 *   bare value, so "11" reads the same way "60" does on a dataset (#153 D3).
 * @property {'list'|'count'|'none'} [sidebar='none']  How it appears in the inventory:
 *   every record, a summary line, or not at all. Defaults to `none` so a collection is
 *   never surfaced by accident — visibility is a deliberate choice by its author.
 * @property {string[]} [assetRefs] Fields holding `asset:` refs, for reference counting.
 * @property {boolean} [portable=false] May a record be saved to the building-block
 *   library and reused in other projects? **Opt-in**, because meaningfulness outside its
 *   project is a property only the collection's author knows. A map layer travels; a memo
 *   does not — its anchor points at something in the project it was written in, so a copy
 *   elsewhere is a note about nothing. Nothing about a record's SHAPE reveals which it is,
 *   so the host cannot infer it (#153).
 */

/** Presentation modes, in increasing order of how much room a collection takes. */
const SIDEBAR_MODES = new Set(['list', 'count', 'none']);

/**
 * Normalise one declaration, dropping anything malformed rather than throwing: a bad
 * manifest should cost that plugin its sidebar entry, never the whole sidebar.
 * @param {*} raw
 * @returns {CollectionDecl|null}
 */
export function normalizeCollection(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const sidebar = SIDEBAR_MODES.has(raw.sidebar) ? raw.sidebar : 'none';
  return {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
    labelField: typeof raw.labelField === 'string' && raw.labelField ? raw.labelField : null,
    summaryField: typeof raw.summaryField === 'string' && raw.summaryField ? raw.summaryField : null,
    portable: raw.portable === true,
    sidebar,
    assetRefs: Array.isArray(raw.assetRefs) ? raw.assetRefs.filter((f) => typeof f === 'string' && f) : [],
  };
}

/**
 * Every collection an active plugin declares, tagged with the owner token the host will
 * key its records by. `ownerOf` is injected so this module stays free of the workspace
 * store (and headlessly testable).
 *
 * @param {Array<object>} plugins        from PluginManager#list()
 * @param {(plugin: object) => string} ownerOf
 * @returns {Array<CollectionDecl & {owner: string, pluginId: string}>}
 */
export function declaredCollections(plugins, ownerOf) {
  const out = [];
  for (const p of plugins ?? []) {
    if (!Array.isArray(p?.collections)) continue;
    const owner = ownerOf(p);
    for (const raw of p.collections) {
      const decl = normalizeCollection(raw);
      if (decl) out.push({ ...decl, owner, pluginId: p.id ?? null });
    }
  }
  return out;
}

/**
 * The `(owner, collection, field)` triples reference counting needs, flattened out of the
 * declarations. Shape matches {@link module:core/asset-refs~itemRefSources}.
 * @param {Array<CollectionDecl & {owner: string}>} decls
 * @returns {Array<{owner: string, collection: string, field: string}>}
 */
export function assetRefDecls(decls) {
  const out = [];
  for (const d of decls ?? []) {
    for (const field of d.assetRefs ?? []) out.push({ owner: d.owner, collection: d.id, field });
  }
  return out;
}

/** The collections that want to appear in the sidebar inventory, in declaration order. */
export function sidebarCollections(decls) {
  return (decls ?? []).filter((d) => d.sidebar === 'list' || d.sidebar === 'count');
}

/**
 * Collections **core itself** owns. Core has no manifest, so without this its records
 * look undeclared to {@link undeclaredItemsGuard} and every sweep would abstain.
 */
export const CORE_COLLECTIONS = [
  // Deliberately NOT portable: a memo's anchor points into the project it was written
  // in, so a copy in another project would annotate nothing.
  { id: 'memos', label: 'Memos', labelField: 'text', sidebar: 'list' },
].map((c) => ({ ...normalizeCollection(c), owner: 'core', pluginId: null }));

/**
 * A guard source that **fails** when the item tier holds records from an (owner,
 * collection) no declaration covers.
 *
 * Found by browser-testing the real thing: the abstain rule protects against a scanner
 * that throws, but NOT against a declaration that was never written. A plugin author who
 * stores `asset:` refs in an item field and forgets `collections[].assetRefs` would have
 * had those bytes silently swept — the exact unrecoverable failure the abstain rule
 * exists to prevent, reached by a different road.
 *
 * Deliberately coarse: it fires on any undeclared collection, not just ones that look
 * like they hold refs, because "looks like a ref" is a guess and the cost of guessing
 * wrong is a user's only copy of their data.
 *
 * @param {Array<{owner: string, collection: string}>} records  from ItemStore#all()
 * @param {Array<{owner: string, id: string}>} decls
 * @returns {import('./asset-refs.js').RefSource}
 */
export function undeclaredItemsGuard(records, decls) {
  return {
    name: 'undeclared-collections',
    ids: () => {
      const covered = new Set((decls ?? []).map((d) => `${d.owner}\u0000${d.id}`));
      const missing = new Set();
      for (const r of records ?? []) {
        if (!covered.has(`${r.owner}\u0000${r.collection}`)) missing.add(`${r.owner}/${r.collection}`);
      }
      if (missing.size) {
        throw new Error(`item collections with no manifest declaration: ${[...missing].sort().join(', ')}`);
      }
      return [];
    },
  };
}

/** A record's display name: its declared label field, else its id. */
export function recordLabel(decl, record) {
  const v = decl?.labelField ? record?.fields?.[decl.labelField] : null;
  return typeof v === 'string' && v.trim() ? v : record?.id ?? '';
}
