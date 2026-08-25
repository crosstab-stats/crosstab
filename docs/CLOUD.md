# Cloud storage

CrossTab can keep a project on a WebDAV server — ownCloud, Nextcloud, Synology, Seafile,
or anything else speaking the protocol. **File ▸ Open from WebDAV…**

WebDAV is a protocol rather than a product, so one implementation reaches all of them.
There is no CrossTab account, no server component and no third party in the path: your
browser talks to your server directly.

**Dropbox** is supported too — **File ▸ Open from Dropbox…** — and needs no server
configuration, which makes it the easier of the two to get working. See *Dropbox* below.

---

## Dropbox

### You register the app, not us

CrossTab ships no Dropbox registration of its own. You create one and paste in its **app
key**, which means the permission screen names *your* app, no stranger's registration sits
in the path, and an institution that will not approve a third-party app can register its
own instead.

At [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps):

1. **Create app** → *Scoped access* → **Full Dropbox** → name it.
   Choose Full Dropbox even if it sounds like more than you need. *App folder* access
   confines the app to `/Apps/<name>/`, and a folder someone shares with you lands
   **outside** that — so collaborators could not open a shared project. The access type
   cannot be changed after creation.
2. **Permissions tab** (it only appears after the app exists) → tick
   `files.content.read`, `files.content.write`, `files.metadata.read` → **Submit** at the
   bottom. Unticked scopes fail at runtime, not at sign-in, so this is easy to miss.
3. **Settings tab** → OAuth 2 → Redirect URIs → add the callback page:
   `https://<wherever you load CrossTab>/oauth-callback.html`. It must match exactly.
4. Copy the **App key**. Ignore the app *secret* — a browser app has nowhere safe to keep
   one, and this never asks for it.

A new app is in **development** mode, which caps how many accounts can link it. That is
fine for your own use; sharing a project with colleagues means applying for production.

### What is stored

**Remembered:** the app key and folder path, in `localStorage`. The app key is an OAuth
client id — published by every browser client by design — so this is not a secret being
left lying about.

**Never remembered:** the sign-in itself. Access and refresh tokens live in memory for the
session, so you sign in again after a reload, and a machine at rest holds no key to your
Dropbox.

### Limits

- Development mode caps linked accounts until you apply for production.
- Dropbox rate-limits; CrossTab waits and retries when it says to.
- Large files upload in chunks and appear only when complete, so a collaborator never
  sees a half-written file.

---

## WebDAV

### Before it will work: CORS

**This is the step people get stuck on, and it is not optional.** A browser refuses to
send `PROPFIND`, `MKCOL` and `MOVE` to another origin unless that origin says it is
allowed. Nextcloud and ownCloud do **not** send those headers on their WebDAV endpoints
by default, so out of the box the browser blocks CrossTab before a single byte moves —
and it reports it as a generic network failure, with nothing useful in the message.

Add this to the reverse proxy in front of your instance (nginx, Apache, Caddy, whatever
terminates TLS), replacing the origin with wherever you load CrossTab from:

```
Access-Control-Allow-Origin: https://crosstab-stats.github.io
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, PUT, DELETE, HEAD, OPTIONS, PROPFIND, MKCOL, MOVE
Access-Control-Allow-Headers: Authorization, Content-Type, Depth, Destination, Overwrite
Access-Control-Expose-Headers: Content-Length, Last-Modified
```

`OPTIONS` must return 200 with those headers and no authentication, because the browser
sends its preflight before it sends your credentials.

If you cannot change the server's headers, this route is closed to you — but the
**folder** route is not: sync the project folder with your provider's desktop client and
use *File ▸ Move project to a folder…*. That needs no server cooperation at all.

---

### Use an app password

Create one in your account settings (Nextcloud and ownCloud both call it an *app
password*; Synology issues application-specific passwords). Do not use your account
password.

An app password is revocable on its own, works without a second factor, and cannot log
in to the web interface. If you ever want to cut CrossTab off, revoke that one password
and nothing else you use is affected.

---

### What CrossTab stores, and what it does not

**Remembered:** the address and the username, in `localStorage`. Plain text on purpose —
you can read it yourself and confirm there is nothing else in there.

**Never remembered:** the password. You type it each session.

That is a deliberate trade of convenience for a smaller blast radius. The obvious
alternative — storing the password encrypted behind a passphrase — means typing a secret
to unlock a secret, which is barely different from typing the password itself, and it
leaves a copy of your cloud credentials on the machine where there was none before. If
you want it saved, save it in your **browser's** password manager: the login form is
marked up for it, and that is a vault you already trust and control.

If the server rejects your credentials mid-session — an app password revoked from another
device, say — CrossTab tells you rather than reporting a failed save.

---

### Known limits

- **One project per location.** The collection you point at *is* the project, the same
  way a folder-backed project works. Point at a different collection for a different
  project.
- **Changes arrive on a poll, not a push.** Neither WebDAV nor Dropbox offers a usable
  push here, so CrossTab re-reads a remote project every 15 seconds and merges what it
  finds — the same merge a synced folder uses, so two people editing at once do not
  overwrite each other. A folder is polled every 3 seconds because that is a local file
  read; a remote costs a network round trip against a provider that rate-limits.
  For instant co-authoring use the peer-to-peer path (**Go live**), which is independent
  of where the project is stored.
- **Large files cross the network whole.** There is no resumable upload here yet, so a
  multi-gigabyte source on a poor connection is a bad time.

---

## Encryption — applies to every backend

Storage encryption is **separate** from whatever credential reaches your cloud, and one is
not a substitute for the other.

The credential — a WebDAV app password, a Dropbox sign-in — protects the **account**. It
stops other people reaching the files. It does nothing about the provider, the provider's
administrators, or a backup of their disks.

A project passphrase (**File ▸ Protect project…**) protects the **data**. CrossTab
encrypts before anything is written and decrypts after it is read, so a server holding a
protected project holds ciphertext and nothing else. Encryption sits above the storage
layer, so this is true of every backend equally — Dropbox, WebDAV, a synced folder.

For participant data on infrastructure you do not personally administer, use it.
