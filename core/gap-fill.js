/**
 * @file gap-fill.js
 * Byte gap-fill for collaboration (#143, generalised to assets in #155) — when a merged manifest references a
 * Parquet **source** a peer doesn't hold (the other peer created that dataset), fetch
 * the bytes over the channel. The op-log's first ops are `load`/`append`/`join`
 * pointing at immutable sources; a joiner replaying a merged log hits a source it
 * lacks → that's the gap.
 *
 * Editing **shared** data (recodes, coding) needs none of this — both peers already
 * hold the base. Gap-fill is only for *new* data introduced mid-session (or the
 * "combine two field studies, both directions" case).
 *
 * ## Design
 *
 *  - **Identity = the source op id** (already carried in every manifest source entry),
 *    so no manifest schema change and no per-file content-hash bookkeeping. "Do I have
 *    this source?" is `held.has(id)`.
 *  - **Integrity = a transfer-time SHA-256** the sender includes; the receiver verifies
 *    the reassembled bytes before storing. Corrupt/wrong bytes are rejected loudly.
 *  - **Chunked** so multi-GB sources stream (with progress) instead of one giant
 *    message, and so it's transport-agnostic + testable.
 *  - **Consent/size-gated:** the holder decides whether to send via an `allowSend(ref,
 *    size)` predicate — auto-streaming a 3 GB file over a field-site link is rude; the
 *    UI can prompt. Both sides see the size.
 *
 * Pure orchestration over callbacks (`readSource`/`storeSource`/`send`), so the whole
 * request→chunk→verify→store round-trip is headlessly testable with in-memory bytes.
 * Bytes actually come from {@link ProjectStore}; the wire is {@link LiveSession}'s
 * channel (messages tagged `t:'need'`/`'src-chunk'`, which LiveDoc ignores).
 */

const DEFAULT_CHUNK = 256 * 1024; // 256 KiB

/** The stable key for a source ref — its op id, else a dataset+file fallback. */
export function refKey(ref) {
  return ref.id ?? `${ref.dsId}:${ref.file}`;
}

/** Every materialisable source in a manifest's flat op-log, as `{ dsId, file, id }`.
 * Identity is the source op's id (stable across peers); byte-less (retracted) sources
 * have no `file` and are skipped (nothing to fetch). */
export function sourceRefs(manifest) {
  const out = [];
  for (const op of manifest?.log ?? []) {
    if (op.type !== 'load' && op.type !== 'append' && op.type !== 'join') continue;
    const file = op.payload?.src?.file;
    if (!file) continue;
    const m = /^ds:([^/]+)\//.exec(op.target || '');
    out.push({ dsId: m ? m[1] : null, file, id: op.id });
  }
  return out;
}

/**
 * Every ASSET a manifest references, as `{ id, name, type }` (#155).
 *
 * Assets are the second thing a peer can lack, and the reason this module stopped being
 * source-only: #152 moved spatial geometry out of the workspace blob and into a
 * content-addressed asset. The blob travelled inside `manifest.log`, so a peer used to
 * receive the geometry for free; an asset ref does not carry its bytes, so a co-authored
 * map layer arrived with a valid `assetId` and nothing behind it.
 *
 * Easier than sources in one important way: an asset's id **is** its SHA-256, so identity
 * and integrity are the same value — there is nothing to reconcile between them.
 *
 * `removeAsset` ops are honoured so a peer never fetches bytes the project has dropped.
 */
export function assetRefs(manifest) {
  const seen = new Map();
  const removed = new Set();
  for (const op of manifest?.log ?? []) {
    if (op.type === 'removeAsset' && op.payload?.id) removed.add(op.payload.id);
    else if (op.type === 'addAsset' && op.payload?.id) {
      seen.set(op.payload.id, { id: op.payload.id, name: op.payload.name ?? '', type: op.payload.type ?? '' });
    }
  }
  return [...seen.values()].filter((r) => !removed.has(r.id));
}

/** The asset refs a peer lacks, given the ids it holds. */
export function missingAssets(manifest, held) {
  const have = held instanceof Set ? held : new Set(held);
  return assetRefs(manifest).filter((r) => !have.has(r.id));
}

/** The source refs a peer lacks, given the keys it holds. */
export function missingSources(manifest, held) {
  const have = held instanceof Set ? held : new Set(held);
  return sourceRefs(manifest).filter((r) => !have.has(refKey(r)));
}

/** Split bytes into ≤`size` chunks (always ≥1 chunk, so empty sources transfer). */
export function chunk(bytes, size = DEFAULT_CHUNK) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out.length ? out : [bytes.subarray(0, 0)];
}

/** Concatenate chunks back into one buffer. */
export function reassemble(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** SHA-256 of bytes as a hex string (integrity check). */
export async function sha256hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Drives transfer of one KIND of byte payload over a channel. One per peer per kind;
 * both sides run one of each.
 *
 * Was `SourceExchange`, Parquet-only. Generalised (#155) because assets need exactly the
 * same request → chunk → verify → store round-trip, and duplicating it would have meant
 * two copies of the integrity logic — the part you least want drifting.
 *
 * **`kind` is not decoration.** Both exchanges ride the same ops channel, so without it
 * the asset exchange would answer the source exchange's `need` and try to ingest its
 * chunks. Every message carries its kind and each instance ignores the others'.
 *
 * @param {object} opts
 * @param {string} opts.kind               'source' | 'asset' — channel discriminator
 * @param {(manifest) => object[]} opts.refsOf   the refs of this kind a manifest needs
 * @param {Set<string>} opts.held          keys this peer already has (mutated as it receives)
 * @param {(ref) => Promise<Uint8Array|null>} opts.read   read a held payload's bytes (or null)
 * @param {(ref, bytes) => Promise<void>} opts.store      persist a received payload
 * @param {(msg, toPeerId?) => void} opts.send            send a protocol message
 * @param {(ev) => void} [opts.onReceived]  `{ key, ok, … }` when one arrives (or fails integrity)
 * @param {(ref, size) => boolean} [opts.allowSend]  consent/size gate (default: allow)
 * @param {number} [opts.chunkSize]
 */
export class BlobExchange {
  #kind;
  #refsOf;
  #held;
  #read;
  #store;
  #send;
  #onReceived;
  #allowSend;
  #chunkSize;
  #incoming = new Map(); // key → { total, hash, chunks: [] }

  constructor({ kind, refsOf, held, read, store, send, onReceived, allowSend, chunkSize = DEFAULT_CHUNK }) {
    if (!kind) throw new Error('BlobExchange: kind is required (two exchanges share one channel)');
    this.#kind = kind;
    this.#refsOf = refsOf ?? sourceRefs;
    this.#held = held instanceof Set ? held : new Set(held);
    this.#read = read;
    this.#store = store;
    this.#send = send;
    this.#onReceived = onReceived;
    this.#allowSend = allowSend;
    this.#chunkSize = chunkSize;
  }

  get kind() { return this.#kind; }

  get held() {
    return this.#held;
  }

  /** Ask peers for any sources this manifest needs that we don't hold. Returns the
   * missing refs (empty ⇒ nothing to fetch). */
  requestMissing(manifest) {
    const have = this.#held;
    const missing = this.#refsOf(manifest).filter((r) => !have.has(refKey(r)));
    if (missing.length) this.#send({ t: 'need', kind: this.#kind, refs: missing });
    return missing;
  }

  /** Handle an inbound gap-fill message. Anything of another kind — or not gap-fill at
   * all — is ignored, which is what lets both exchanges share one channel. */
  async receive(msg, from) {
    if (!msg || (msg.kind && msg.kind !== this.#kind)) return;
    if (msg.t === 'need') { await this.#serve(msg.refs, from); return; }
    if (msg.t === 'gap-chunk') { await this.#ingest(msg); }
  }

  async #serve(refs, to) {
    for (const ref of refs ?? []) {
      const key = refKey(ref);
      if (!this.#held.has(key)) continue; // we don't have it either
      const bytes = await this.#read(ref);
      if (!bytes) continue;
      if (this.#allowSend && !this.#allowSend(ref, bytes.length)) continue; // declined / too big
      const hash = await sha256hex(bytes);
      const chunks = chunk(bytes, this.#chunkSize);
      for (let seq = 0; seq < chunks.length; seq++) {
        this.#send({ t: 'gap-chunk', kind: this.#kind, key, ref, seq, total: chunks.length, hash, bytes: chunks[seq] }, to);
      }
    }
  }

  async #ingest(msg) {
    let rec = this.#incoming.get(msg.key);
    if (!rec) { rec = { total: msg.total, hash: msg.hash, chunks: new Array(msg.total) }; this.#incoming.set(msg.key, rec); }
    rec.chunks[msg.seq] = msg.bytes;
    if (rec.chunks.filter((c) => c != null).length !== rec.total) return; // still assembling

    this.#incoming.delete(msg.key);
    const bytes = reassemble(rec.chunks);
    if ((await sha256hex(bytes)) !== rec.hash) {
      this.#onReceived?.({ kind: this.#kind, key: msg.key, ok: false }); // integrity failure — do not store
      return;
    }
    await this.#store(msg.ref ?? { id: msg.key }, bytes);
    this.#held.add(msg.key);
    this.#onReceived?.({ kind: this.#kind, key: msg.key, ok: true, ref: msg.ref ?? { id: msg.key } });
  }
}
