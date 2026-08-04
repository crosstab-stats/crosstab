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
 * @property {'list'|'count'|'none'} [sidebar='none']  How it appears in the inventory:
 *   every record, a summary line, or not at all. Defaults to `none` so a collection is
 *   never surfaced by accident — visibility is a deliberate choice by its author.
 * @property {string[]} [assetRefs] Fields holding `asset:` refs, for reference counting.
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

/** A record's display name: its declared label field, else its id. */
export function recordLabel(decl, record) {
  const v = decl?.labelField ? record?.fields?.[decl.labelField] : null;
  return typeof v === 'string' && v.trim() ? v : record?.id ?? '';
}
