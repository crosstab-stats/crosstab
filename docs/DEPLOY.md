# Hosting your own CrossTab

CrossTab is static files. Serving them from your own web space gives a department its own
install — no accounts, no server, no database. This page is the settings that make that install
*yours*, and the handful of things that settings file deliberately cannot do.

If you only want to *use* CrossTab, you do not need any of this:
<https://crosstab-stats.github.io/crosstab/>.

---

## 1. Serve it

```sh
git clone https://github.com/crosstab-stats/crosstab.git
cd crosstab
npm run dev        # local check: http://localhost:8000
```

For a real deployment, copy the repository to any static host. Two requirements:

- **Serve `index.html` and everything beside it from the same origin.** No build step exists —
  the app is native ES modules, so what you clone is what runs.
- **Cross-origin isolation**, which R (WebR) needs for its fast, multi-threaded path. If your
  host can send headers, send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. If it cannot (GitHub Pages, most static hosts),
  nothing to do: `sw.js` installs a service worker that supplies them, at the cost of one
  self-reload on a visitor's first load.

## 2. Tell it about itself

Copy the template and edit what you need:

```sh
cp deploy.example.json deploy.json
```

`deploy.json` is **optional and gitignored**. Absent, every setting falls back to the built-in
default, so a plain clone behaves exactly like ours. Gitignored because a file you edit in place
and we keep adding fields to would conflict on every `git pull` — copy it once and pull freely.

The template is commented, and the parser tolerates comments and trailing commas, so you can
comment a field out without the file breaking. What you can set:

| Field | What it does |
| --- | --- |
| `repo` | Your fork as `owner/repo`. Every Help ▸ GitHub link derives from it. |
| `issuesUrl`, `discussionsUrl` | Point "Report a bug" / "Ask a question" anywhere, including off GitHub. |
| `supportEmail` | Take mail instead of tickets: the bug dialog's main button becomes **Email support…**. |
| `siteName` | Who runs this install. Shown where a user is about to send a report. |
| `assetsMode` | `cdn` (default) or `local` — see [OFFLINE.md](OFFLINE.md) for the air-gapped build. |
| `assets` | Override individual runtime URLs, e.g. mirror WebR only. |
| `runtimeHosts` | Extra hostnames the offline cache may keep runtime files from (add your mirror). |
| `pluginDir`, `pluginNamespace` | Your own plugin directory — see below. |

**A bad file cannot break your install.** Each field is validated on its own and a bad one is
dropped with a warning in the browser console; if the whole file fails to parse, CrossTab boots
on its defaults. Check the console after editing: a silent fallback is the failure mode to look
for, not a crash.

### What this file cannot do

`manifest.json` — the installed app's **name, icons and theme colour** — is read by the browser,
not by CrossTab, so no runtime setting can change it. Edit `manifest.json` (and the icons in
`vendor/`) directly if you want the PWA to install under your own name.

## 3. Your own plugins

*(Coming in the second half of #185 — `pluginDir` is already accepted and validated, and the
index format is specified in `deploy.example.json`.)*

A group can keep its own plugins in its own directory alongside the clone, list them in an index
file inside that directory, and have CrossTab register them at boot exactly like the built-ins —
no fork of our source, and `git pull` stays clean because nothing of yours lives in our tree.

Your plugins get their own id namespace (`pluginNamespace`, default `site`) so they can never
collide with ours or with a plugin a user loads from a file. **Pick that namespace once**: it
becomes part of every one of your plugin ids, and a saved project refers to them by it, so
changing it later orphans those references.

## 4. Offline and air-gapped

Both are covered in [OFFLINE.md](OFFLINE.md): the "Make available offline" toggle for ordinary
use, and `assetsMode: "local"` plus `scripts/vendor-assets.mjs` for a machine that never touches
the internet.

## 5. Keeping up to date

```sh
git pull
```

That is the whole update. Your `deploy.json`, your plugin directory and your `manifest.json`
edits are the only local state — the first two are gitignored, so only `manifest.json` can
conflict, and only if we change it too.
