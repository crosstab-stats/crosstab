/**
 * @file live-invite.js
 * Rendezvous addressing + invitation for live P2P collaboration (#143) — the pure,
 * headlessly-testable half of the Trystero signaling channel.
 *
 * Two separate concerns, deliberately kept apart (per the access-control design):
 *
 *  - **Addressing — the room id.** A public MQTT broker routes by topic, so the topic
 *    must be *unguessable and non-enumerable* — never "is anyone editing
 *    `dissertation`?". It's `SHA-256(app-namespace ‖ project-UUID)`, truncated to a
 *    128-bit hex topic. The owner derives it from the project's own random UUID (no
 *    extra state); the broker sees an opaque id.
 *  - **Confidentiality — the invite secret.** A high-entropy key that AES-encrypts the
 *    signaling + presence beacon (Trystero's `password`). Kept **orthogonal** to the
 *    room id: folding the secret into the topic would mean rotating it changes the
 *    address (collaborators lose each other) and a weak secret becomes an enumerable
 *    topic. Delivered in the invite link's **fragment** (`#…`), which browsers never
 *    send to a server — the Jitsi/Excalidraw E2EE-link pattern.
 *
 * Honest residual (no theatre): even fully encrypted, the broker still sees the topic
 * exists, how many subscribers it has, and message timing/sizes. Encryption hides
 * content, not participation.
 */

const APP_NS = 'crosstab-collab-v1';

/** base64url (no padding) — URL-fragment-safe, unlike standard base64. */
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The opaque broker topic for a project — `SHA-256(APP_NS ‖ uuid)` as 128-bit hex.
 * Stable for a project (derived from its UUID), unguessable, and namespaced so it
 * can't collide with another app on the same public broker.
 * @param {string} projectUuid
 * @returns {Promise<string>} 32 hex chars
 */
export async function deriveRoomId(projectUuid) {
  const data = new TextEncoder().encode(`${APP_NS}:${projectUuid}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh high-entropy invite secret (256-bit). Generate ONCE per project and store
 * it (so re-inviting keeps the same room reachable); default to this rather than a
 * user-typed password — it's immune to the offline dictionary grind a memorable
 * password invites. (A user-chosen memorable-but-weaker password stays an option.)
 * @returns {string} base64url
 */
export function newInviteSecret() {
  return b64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Build a shareable invite link. The room id + secret live in the URL **fragment**,
 * so they never reach a server. `baseUrl` is typically `location.href` sans hash.
 * @param {{baseUrl: string, projectUuid: string, secret: string}} arg
 * @returns {Promise<string>}
 */
export async function createInviteLink({ baseUrl, projectUuid, secret }) {
  const roomId = await deriveRoomId(projectUuid);
  const frag = new URLSearchParams({ r: roomId, k: secret }).toString();
  const base = String(baseUrl).split('#')[0];
  return `${base}#collab=${frag}`;
}

/**
 * Ensure a project has a **collab identity** — a stable `collabId` and a
 * `collabSecret`, minted once and carried in the manifest. This is what makes the
 * **folder path seamless**: both fields ride the OneDrive sync to the receiving
 * faculty, so opening the shared folder is itself entry to the signaling room — no
 * separate invite link needed. The secret's protection equals the folder's (its ACL,
 * plus at-rest encryption); folder members are already authorized collaborators.
 *
 * Pass a manifest/bundle; returns the (possibly newly minted) identity + whether it
 * changed, so the caller persists it back on save.
 * @param {{collabId?: string, collabSecret?: string}|null} obj
 * @returns {{collabId: string, collabSecret: string, minted: boolean}}
 */
export function ensureCollabIdentity(obj) {
  const collabId = obj?.collabId || globalThis.crypto.randomUUID();
  const collabSecret = obj?.collabSecret || newInviteSecret();
  return { collabId, collabSecret, minted: !obj?.collabId || !obj?.collabSecret };
}

/**
 * The signaling room + secret for a project, derived from its manifest's collab
 * identity — the folder path's entry point. Both peers holding the folder-synced
 * manifest compute the **identical** room id + secret, so they meet in the same
 * encrypted room. Null if the project has no collab identity yet.
 * @param {{collabId?: string, collabSecret?: string}} manifest
 * @returns {Promise<{roomId: string, secret: string} | null>}
 */
export async function roomFor(manifest) {
  if (!manifest?.collabId || !manifest?.collabSecret) return null;
  return { roomId: await deriveRoomId(manifest.collabId), secret: manifest.collabSecret };
}

/**
 * A shareable invite link for a project (the pure-live path, when there's no shared
 * folder to carry the identity). Same room + secret as {@link roomFor}.
 * @param {{baseUrl: string, manifest: {collabId: string, collabSecret: string}}} arg
 * @returns {Promise<string>}
 */
export function inviteLinkFor({ baseUrl, manifest }) {
  return createInviteLink({ baseUrl, projectUuid: manifest.collabId, secret: manifest.collabSecret });
}

/**
 * Parse an invite link's fragment → `{ roomId, secret }`, or null if it isn't one.
 * @param {string} url
 * @returns {{roomId: string, secret: string} | null}
 */
export function parseInviteLink(url) {
  let hash = '';
  try { hash = new URL(url).hash; } catch { hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''; }
  const m = /#collab=(.*)$/.exec(hash);
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const roomId = p.get('r');
  const secret = p.get('k');
  return roomId && secret ? { roomId, secret } : null;
}
