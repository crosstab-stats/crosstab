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
dropped; if the whole file fails to parse, CrossTab boots on its defaults.

**How to tell it worked.** The launcher's About rail shows **"Hosted by …"** — your `siteName`,
or your host if you did not set one — and that line appears *only* when a settings file actually
applied. No line means CrossTab did not find or could not read one. If some fields were dropped,
the same panel says how many and lists them with reasons, so you do not have to go looking in a
console. The install is also named in Help ▸ Report a bug, so a report from your deployment
says where it came from.

### What this file cannot do

`manifest.json` — the installed app's **name, icons and theme colour** — is read by the browser,
not by CrossTab, so no runtime setting can change it. Edit `manifest.json` (and the icons in
`vendor/`) directly if you want the PWA to install under your own name.

## 3. Your own plugins

Keep them in their own directory beside the clone, list them in an index file **inside that
directory**, and CrossTab registers them at boot exactly like the built-ins.

```
crosstab/
  deploy.json            <- "pluginDir": "site-plugins"
  site-plugins/          <- yours; gitignored, so `git pull` never touches it
    index.json
    attendance/index.js
    gradebook/index.js
```

`site-plugins/index.json`:

```jsonc
{
  // Comments and trailing commas are fine here too.
  "plugins": [
    // "default": true switches it on for a fresh launch, the way the curated core is on.
    // Leave it off and the plugin is listed in Edit > Plugins for people to enable.
    { "entry": "attendance/index.js", "default": true },
    { "entry": "gradebook/index.js" }
  ]
}
```

A bare list works when you do not need the marker: `["attendance/index.js", "gradebook/index.js"]`.

**The index lives in your directory on purpose.** You add a plugin by editing the file next to
it — `deploy.json` names the directory once and then stays out of your way.

Notes worth knowing before you build one:

- **They are provided, not privileged.** A site plugin runs in the same sandboxed iframe as
  every other plugin, ours included, and talks to the engine over `postMessage`. Being served by
  the deployment gets it registered automatically; it grants no extra access.
- **Entries must stay inside the directory.** An absolute URL, a `//host`, or a `..` is refused
  with a message rather than fetched — this file names files *you* serve.
- **Ids are namespaced by you.** `pluginNamespace` (default `site`) is prepended by CrossTab, so
  `attendance` becomes `sdsu-attendance`. A site plugin cannot mint a `builtin-…` id, and two
  universities' plugins cannot collide inside one shared project. **Pick the namespace once** —
  it is part of every id, and a saved project refers to your plugins by it.
- **Users stay in charge.** `"default": true` seeds a *fresh* launch. Someone who switches your
  plugin off keeps it off.
- **Nothing is fatal.** A missing index, a bad entry, a plugin that fails to load: CrossTab says
  so on the launcher and carries on with everything else.

Start from any built-in as a worked example — `plugins/builtin-frequencies/` is about the
smallest complete one — or use **Edit ▸ Create plugin…** in the app and export the result into
your directory.

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
