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
 * @property {string[]} [rowRefs] Fields holding a `__ct_rid` ROW id, so a dataset
 *   re-home can remap them (#151). Same reason `assetRefs` is declared rather than
 *   inferred: a string field holding "1000000003" is indistinguishable from any other
 *   string, and guessing would corrupt records rather than move them. A collection that
 *   declares none is assumed to reference no rows, so it moves untouched.
 * @property {'project'|'dataset'} [scope] Which dataset a record belongs to. Omit to
 *   INHERIT the workspace's own scope, which is the existing behaviour and right for
 *   almost everything. Set it only when one collection genuinely differs from its
 *   siblings: CAQDAS codes are project-wide (a codebook is reused across datasets) while
 *   its segments are per-dataset (they anchor to `__ct_rid` row ids that belong to one
 *   dataset and are meaningless in another). Workspace-level scope cannot express that —
 *   it is all-or-nothing — which is why this exists per collection.
 * @property {boolean} [portable=false] May a record be saved to the building-block
 *   library and reused in other projects? **Opt-in**, because meaningfulness outside its
 *   project is a property only the collection's author knows. A map layer travels; a memo
 *   does not — its anchor points at something in the project it was written in, so a copy
 *   elsewhere is a note about nothing. Nothing about a record's SHAPE reveals which it is,
 *   so the host cannot infer it (#153).
 * @property {string[]} [anchorRefs] Fields holding an **anchor** — a reference to a
 *   *region* of something the log addresses (see core/anchors.js). Declared for the same
 *   reason as `assetRefs`/`rowRefs`: the host cannot tell an anchor from any other object,
 *   and guessing would corrupt records rather than resolve them. Knowing where they are
 *   lets the host declare the op's `reads[]`, report staleness, and re-target on a
 *   re-home, generically, for any plugin (#166).
 * @property {{collection: string, field: string}} [parent] This collection's records are
 *   **composed into** records of `collection`, via the id held in `field`. Composition is
 *   not the same relation as a mere reference, and conflating them is not a tidiness
 *   question: children TRAVEL with their parent (a codebook's codes go with it into the
 *   library) and CASCADE with it (deleting a codebook deletes its codes). A `segment`
 *   referencing a `code` is a dependency, not a composition — it cascades on delete but
 *   must never travel, because a shared codebook that carried its codings would carry
 *   passages of real participant data to whoever it was shared with (#166 §8).
 * @property {'lww'|'surface'} [onConcurrentEdit='lww'] What happens when two peers edit
 *   the SAME record concurrently. `lww` — the existing behaviour and the right default —
 *   lets HLC order decide silently; `builtin-spatial` wants exactly that, because you do
 *   not prompt someone about a polygon. `surface` routes it to conflict resolution
 *   instead, for records where a silent discard destroys work that cannot be recovered:
 *   two coders disagreeing about a passage boundary is the case that motivated it, and
 *   silently keeping one of them is the failure per-coder records exist to prevent.
 *   Per collection rather than global, so turning it on for codings does not change
 *   behaviour for every plugin that was happy with LWW.
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
    // null = inherit the workspace's scope. Deliberately tri-state rather than
    // defaulting to 'dataset': a collection that says nothing must keep behaving exactly
    // as it did, including inside a project-scoped workspace like builtin-spatial's.
    scope: raw.scope === 'project' || raw.scope === 'dataset' ? raw.scope : null,
    sidebar,
    assetRefs: Array.isArray(raw.assetRefs) ? raw.assetRefs.filter((f) => typeof f === 'string' && f) : [],
    rowRefs: Array.isArray(raw.rowRefs) ? raw.rowRefs.filter((f) => typeof f === 'string' && f) : [],
    anchorRefs: Array.isArray(raw.anchorRefs) ? raw.anchorRefs.filter((f) => typeof f === 'string' && f) : [],
    // Both coordinates are required: a parent naming no field cannot be traversed, and a
    // field naming no collection cannot be resolved. Half a declaration is dropped rather
    // than half-honoured — a cascade that guessed would delete the wrong records.
    parent: typeof raw.parent?.collection === 'string' && raw.parent.collection
      && typeof raw.parent?.field === 'string' && raw.parent.field
      ? { collection: raw.parent.collection, field: raw.parent.field }
      : null,
    onConcurrentEdit: raw.onConcurrentEdit === 'surface' ? 'surface' : 'lww',
  };
}

/**
 * The `(owner, collection, field)` triples for anchor fields — the shape
 * {@link module:core/asset-refs~itemRefSources} uses, so anchors are walkable by the same
 * machinery that already walks asset refs.
 * @param {Array<CollectionDecl & {owner: string}>} decls
 */
export function anchorRefDecls(decls) {
  const out = [];
  for (const d of decls ?? []) {
    for (const field of d.anchorRefs ?? []) out.push({ owner: d.owner, collection: d.id, field });
  }
  return out;
}

/**
 * The collections composed INTO `(owner, collection)` — its children, in declaration
 * order. Answers "what travels with this record, and what dies with it".
 * @param {Array<CollectionDecl & {owner: string}>} decls
 * @param {string} owner @param {string} collection
 * @returns {Array<CollectionDecl & {owner: string}>}
 */
export function childrenOf(decls, owner, collection) {
  return (decls ?? []).filter((d) => d.owner === owner && d.parent?.collection === collection);
}

/**
 * Does this collection want a concurrent same-record edit surfaced rather than silently
 * resolved? Looked up by address so callers deep in a merge need not carry declarations.
 * @param {Array<CollectionDecl & {owner: string}>} decls
 * @param {string} owner @param {string} collection
 */
export function surfacesConflicts(decls, owner, collection) {
  return (decls ?? []).some((d) => d.owner === owner && d.id === collection && d.onConcurrentEdit === 'surface');
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

/**
 * May this child record travel inside a building block? (#163's second guard.)
 *
 * A block exists to be handed to other people, so anything bound to a DATASET cannot go:
 * it refers to rows that will not exist in the recipient's project, and in the case that
 * motivated the rule those rows are passages of real participant data.
 *
 * Two independent refusals, deliberately. The first states intent, the second is the one
 * that matters: the whole point of a second guard is that a MIS-DECLARED `parent` must
 * still be harmless, and a record's own scope was resolved by the host when it was
 * written, so it is evidence rather than a guess about an omitted declaration.
 *
 * @param {CollectionDecl & {owner: string}} decl  the CHILD collection's declaration
 * @param {{scope?: {dsId?: string|number|null}}} rec  the child record
 */
export function childTravels(decl, rec) {
  if (decl?.scope === 'dataset') return false;
  return rec?.scope?.dsId == null;
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
  //
  // COUNTED, not listed (#168). A memo is written per coding, per analysis, per dataset,
  // so this is the fastest-growing collection in a qualitative project — and unlike a
  // segment, every memo is already readable at the thing it annotates. A row here was a
  // second route to something that had one. Orphaned memos are the exception and keep
  // their own listed section, because nothing else can reach them.
  { id: 'memos', label: 'Memos', labelField: 'text', sidebar: 'count' },
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
