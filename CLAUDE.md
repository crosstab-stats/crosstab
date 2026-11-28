# CrossTab — orientation for contributors (human or model)

A browser-native statistics and qualitative-analysis environment. No server, no account,
no install: DuckDB-WASM holds the data out-of-core in OPFS, WebR runs the statistics, and
analyses are supplied by plugins. Runs from a static host — live at
<https://crosstab-stats.github.io/crosstab/>.

This file is the short version. It exists because most of what follows is **counterintuitive
on purpose**, and a reasonable contributor who has not read it will "fix" things that are
deliberate.

## Where the real documentation is

| Question | File |
|---|---|
| What is planned, in progress, decided, or rejected — the backlog of record | `TODO.md` (large; grep it) |
| How to drive and verify the app, and what cannot be verified by automation | `docs/AUTOMATION.md` |
| Manual test checklist, per feature | `docs/TESTING.md` |
| Threat model and accepted residual risks | `docs/SECURITY.md` |
| Plugin states and what each word means | `docs/ARCHITECTURE-plugin-lifecycle.md` |
| The op log that everything persists through | `docs/ARCHITECTURE-unified-log.md`, `docs/MIGRATION-one-true-log.md` |
| Anchors (how a reference to data survives edits) | `docs/ARCHITECTURE-coding-anchors.md` |
| Air-gapped / offline deployment | `docs/OFFLINE.md` |
| Deployment settings and site plugins | `docs/DEPLOY.md` |
| Workspaces (panes other than the data grid) | `docs/WORKSPACES.md` |
| Writing how-to topics | `docs/howto-core.md` |

`npm test` runs the suite (plain `node --test`, no dependencies). There is no build step.
`npm run dev` serves the repo with the cross-origin-isolation headers WebR and DuckDB need.

## Decisions that look like defects — do not "fix" these

Each of these was decided deliberately, usually after the obvious alternative was tried and
rejected. If you think one is wrong, say so and make the argument; don't quietly change it.

- **Dependencies are pinned and pulled from a CDN, never vendored.** Vendoring means owning
  pinning, CVE tracking and bundling forever, which is explicitly rejected. Pinning is not
  vendoring and is wanted. Air-gap vendoring (`scripts/vendor-assets.mjs` → `./vendor/`,
  `core/assets.js` local mode) is an opt-in deploy step, never the default. A hardening
  proposal whose main cost is a vendored dependency will be declined — lead with the
  maintenance trade and offer a no-dependency alternative.
- **CrossTab never privileges its own file format.** SPSS/Stata/SAS/R formats get full,
  equal support including large-file write. `.crosstab` is the native convenience, not a
  privileged path. Never gate another tool's format behind a size cap or worse UX than ours.
- **Qualitative analysis is first-class**, an equal owner of the word "stats". Never frame it
  as out of scope or as a lesser branch.
- **No courses, no curriculum, ever.** Guides are narrow and about *the tool* ("how do I run
  a crosstab with weights"), never about a discipline's methods. When something wants a
  course, build the tooling a course author needs instead. Never reuse prose, examples or
  sequence from anyone's teaching materials.
- **Project-level settings are pre-filled into each run's own control, never applied
  invisibly.** Frequency weights are the shipped example: the weight appears in every
  analysis's input, pre-filled, and can be cleared for one run without changing the project
  setting. The per-run override is the feature, not a rough edge — hiding the control to
  reduce clutter would be a regression.
- **"Everything you do is saved" is inviolable.** Only *loading* regenerable seed data
  (launcher Demo/Blank) is exempt from autosave. The moment a user does any work — an
  analysis, an edit, a code, an import — it is real and must be saved, demo data included.
  Never suppress saving to reduce clutter.
- **The op log is never compacted.** Deletion is a `retract` op, reorder is a `reorder` op;
  a verbose log is the price of audit, reproducibility and merge safety. Physical removal is
  merge-unsafe (an op dropped from a shared ancestor resurrects on merge). The deliberate
  answer to log size is Seal, never silent compaction.
- **A live dataset is never cleared and refilled.** Import offers *Swap in* — a new dataset
  that inherits the old one's name, with the old one binned after the import succeeds. The
  engine's `loadDataset({mode:'replace'})` stays: it is how an *empty* dataset gets filled,
  and the `load` op is the replace barrier in the fold.
- **Saved output outlives whatever drew it.** A chart whose plugin is absent renders from its
  persisted SVG and says so plainly; the R each analysis ran is persisted for audit.
  Editability is a plugin capability, so "static because the plugin is off" is the
  *finished* state, not a degradation to engineer away. Capture provenance at write time —
  the registry cannot answer once the provider is gone.
- **Information available only on hover, or only from a keyboard, is not shipped.** A `title`
  tooltip is not an affordance; it is silent to touch, keyboard and screen readers alike.
  Hover-revealed controls are worse than missing ones — a transparent element still takes
  taps. Dim controls with size and colour, never `opacity`.
- **Small-screen mode is attribute-driven, not width-driven.** One root attribute
  (`data-screen="small"|"full"`, `core/screen-mode.js`); no CSS keys off viewport width. The
  viewport supplies a default only while the preference is unset, and an explicit choice then
  wins forever — including `full` while narrow. Exactly one layout `@media` query is the
  architecture, not a gap.
- **The data grid keeps 2-D scrolling on purpose** (WCAG 1.4.10 exempts data tables).

## Security

Threat model is local-first and single-user; activated plugins are trusted with the active
dataset. Judge a mitigation by whether it raises attacker cost against what it costs to keep
working, and name non-fixes as non-fixes — a text blocklist over R source is theatre, because
R is dynamic. Accepted gaps are recorded as deliberate residual risks in `docs/SECURITY.md`,
not as TODOs.

## Vocabulary that must be used exactly

Plugin states are four independent axes plus two derived terms: **catalogued** (manifest
readable here), **registered** (a persistent local entry exists), **enabled** (selected to
run), **activated** (actually running — menus and workspaces live), **failed** (enabled +
deactivated), **referenced** (named in a project's saved set, possibly unregistered here).
Healthy invariant: enabled ⟺ activated.

**Never use "loaded" or "active" as a plugin state.** The word "load" once pointed at two
different states in different modules and that ambiguity caused real bugs; the cleanup
retired it. (Data-side `load` — `loadDataset`, `loadBundle` — is a different domain and is
fine.) Plugin *ids* are globally unique by construction (origin namespace + the author's
local id); the load *key* identifies a registered entry. Ids and keys are not interchangeable.

## Working discipline

These are not style preferences. Each one is here because skipping it produced a confidently
wrong answer that had to be retracted later.

- **Open the module before making any design claim about it** — trivial or not, and
  especially in fast design discussion. Reasoning from recall about this codebase has a bad
  track record; reading first has a good one. The cost of checking is seconds.
- **Test the entry point, not the method.** Drive the menu item or the button a user clicks.
  After a rename, grep for the old name.
- **Test the real workload.** A test that does not run the path the user runs is not a valid
  test. If users transcribe whole interviews, test a whole interview — not a convenient clip.
  Prefer a slow correct run to a fast unrepresentative one.
- **Own a negative control.** Before claiming something works, run the case where working and
  broken give *different* answers. A feature can pass every test and still be a lie if all
  the fixtures sit on the same side of the thing it decides. A library API that *looks* like
  it does something is not evidence that it does — read its implementation or prove it
  behaviourally.
- **An assertion that something is ABSENT from source must read comment-stripped code.** A
  guard written against raw text matches the doc comment explaining why the thing is absent.
  This has happened repeatedly. Prefer matching a definition (`/name\s*[=:]/`) over a mention.
- **Keep work in reviewable units:** one commit plus one in-browser check per item.
- **Never hold a layout metric in two places.** Measure it from computed style rather than
  duplicating it in a constant; an inline `font:` shorthand cannot be overridden by a later
  rule.
- **A guard whose only purpose is to neutralise a state is evidence the state should not
  exist.** Fix the representation instead, and say so plainly rather than offering a menu of
  policies — a menu of policies over a missing representation is itself the tell. A
  rationalisation written into a comment ("untidy but harmless") is worth re-reading as a bug
  report.
- **Decide synced state by naming who WRITES a key, not who wins.** Per-user or per-view state
  is keyed by `authorId` and each peer writes only its own key. Note `authorId` is minted per
  *device*. In `decideSync`, `mine` is the lexicographically smaller content signature, not
  this machine — never describe it as "mine wins".

### Two traps that keep recurring

- **Any `display` declaration that outranks the hide rule beats `[hidden]`**, and there are
  two ways to outrank it: an inline `style="display:flex"`, or a class rule of equal
  specificity appearing *later* in the stylesheet. Four separate bugs so far. Write
  `.thing:not([hidden]) { display: flex }` — while hidden the rule does not match at all, so
  neither specificity nor source order can defeat it. Verify with
  `getComputedStyle(el).display`, never `el.hidden`, and check every sibling state.
- **Shells silently mangle code.** Quotes, backslashes and backticks inside `node -e '…'` or
  an unquoted heredoc get edited on the way through, and the file still parses — so
  `node --check` passes and the breakage appears at runtime. Write the snippet to a file and
  splice it in. Backticks and `${` are additionally fatal inside a JS template literal (every
  `injectStyles()` sheet is one). If you splice with Python, pass `newline=''` on write or it
  converts the whole file to CRLF on Windows.
- **Never chain a push behind a grepped test run.** `npm test | grep … && git push` pushes
  whenever *grep* succeeds, which it does when the suite fails. Check the fail count, or run
  the push separately.

## Verifying a change

The hard bugs here are runtime, not static: four separate `display`-beats-`[hidden]` hits, a
`<dialog>` `close` event that never fires in a hidden tab, a transcription "auto-detect" that
was hardcoded English. The test suite cannot see any of them. **A change to the UI, to a
plugin's output, or to anything WebR or DuckDB touches is not verified until the app has run
it.** `docs/AUTOMATION.md` has the recipes and the traps.

When an analysis hand-rolls *or wraps* a standard R routine, check it against the real package
on a desktop R install. A wrapper must match exactly — same data, same seed, bit-identical. A
substitution (different implementation of the same model) gets a measured distance and an
explicit statement of what is not reproduced. Recovery from simulated data is not validation.
Always add a negative control: perturb the reference and confirm the comparison fires.

## Git

Local commits whenever work reaches a checkpoint — no need to ask. **Never push until the
owner explicitly asks.** Pushes to `main` deploy the live site, and Pages lags a push by
minutes: poll `curl -sI …/core/app.js` for `last-modified` to move before asking anyone to
test, or you will diagnose a stale build.
