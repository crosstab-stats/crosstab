/**
 * @file gap-fill.js
 * Base-data gap-fill for collaboration (#143) — when a merged manifest references a
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
 * Drives base-data transfer over a channel. One per peer; both sides run one.
 *
 * @param {object} opts
 * @param {Set<string>} opts.held          keys of sources this peer already has (mutated as it receives)
 * @param {(ref) => Promise<Uint8Array|null>} opts.readSource   read a held source's bytes (or null)
 * @param {(ref, bytes) => Promise<void>} opts.storeSource      persist a received source
 * @param {(msg, toPeerId?) => void} opts.send                  send a protocol message
 * @param {(ev) => void} [opts.onReceived]  `{ key, ok, dsId?, file? }` when a source arrives (or fails integrity)
 * @param {(ref, size) => boolean} [opts.allowSend]  consent/size gate for sending (default: allow)
 * @param {number} [opts.chunkSize]
 */
export class SourceExchange {
  #held;
  #readSource;
  #storeSource;
  #send;
  #onReceived;
  #allowSend;
  #chunkSize;
  #incoming = new Map(); // key → { total, hash, chunks: [] }

  constructor({ held, readSource, storeSource, send, onReceived, allowSend, chunkSize = DEFAULT_CHUNK }) {
    this.#held = held instanceof Set ? held : new Set(held);
    this.#readSource = readSource;
    this.#storeSource = storeSource;
    this.#send = send;
    this.#onReceived = onReceived;
    this.#allowSend = allowSend;
    this.#chunkSize = chunkSize;
  }

  get held() {
    return this.#held;
  }

  /** Ask peers for any sources this manifest needs that we don't hold. Returns the
   * missing refs (empty ⇒ nothing to fetch). */
  requestMissing(manifest) {
    const missing = missingSources(manifest, this.#held);
    if (missing.length) this.#send({ t: 'need', refs: missing.map((r) => ({ id: r.id, dsId: r.dsId, file: r.file })) });
    return missing;
  }

  /** Handle an inbound gap-fill message (ignore anything else). */
  async receive(msg, from) {
    if (!msg) return;
    if (msg.t === 'need') { await this.#serve(msg.refs, from); return; }
    if (msg.t === 'src-chunk') { await this.#ingest(msg); }
  }

  async #serve(refs, to) {
    for (const ref of refs ?? []) {
      const key = refKey(ref);
      if (!this.#held.has(key)) continue; // we don't have it either
      const bytes = await this.#readSource(ref);
      if (!bytes) continue;
      if (this.#allowSend && !this.#allowSend(ref, bytes.length)) continue; // declined / too big
      const hash = await sha256hex(bytes);
      const chunks = chunk(bytes, this.#chunkSize);
      for (let seq = 0; seq < chunks.length; seq++) {
        this.#send({ t: 'src-chunk', key, dsId: ref.dsId, file: ref.file, seq, total: chunks.length, hash, bytes: chunks[seq] }, to);
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
      this.#onReceived?.({ key: msg.key, ok: false }); // integrity failure — do not store
      return;
    }
    await this.#storeSource({ id: msg.key, dsId: msg.dsId, file: msg.file }, bytes);
    this.#held.add(msg.key);
    this.#onReceived?.({ key: msg.key, ok: true, dsId: msg.dsId, file: msg.file });
  }
}
