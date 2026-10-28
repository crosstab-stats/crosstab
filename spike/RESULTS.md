# Spike results — DuckDB-WASM ↔ WebR data engine

Throwaway proof-of-concept (`duckdb-webr-spike.html`) for the foundational data-engine
decision in [`../TODO.md`](../TODO.md). **Verdict: the architecture is proven viable.**

## Setup

- **Where:** desktop Chrome, served with real COOP `same-origin` + COEP
  `credentialless` (`crossOriginIsolated === true`, `SharedArrayBuffer` available).
- **DuckDB-WASM** `@1.29.0` from jsDelivr `+esm` (core engine **v1.1.1**), worker
  wrapped in a same-origin blob (`importScripts(CDN)`) to satisfy COEP.
- **WebR** `latest` from the official CDN (same loader the app uses).
- **Scale:** 200 columns × 500,000 rows of doubles generated entirely in-engine
  (no file importer needed — DuckDB `range()` + `random()`).
- Memory measured with `performance.measureUserAgentSpecificMemory()` (accurate in
  isolated contexts; counts WASM, not just the JS heap).

## Numbers (first run; WebR assets were warm in HTTP cache)

| Step | Result |
|---|---|
| DuckDB module import | 0.13 s |
| DuckDB instantiate + connect | 1.71 s |
| Generate 200 × 500k in-engine | **1.25 s** |
| Memory after full dataset loaded (~800 MB of data) | **1230.8 MB total** |
| Full-table `GROUP BY` aggregate (avg/stddev over 500k) | **0.02 s** |
| WebR init (cached) | 1.73 s |
| DuckDB sample 5k rows × 3 cols | 0.03 s |
| Arrow columns → JS arrays | ~0 s |
| WebR `lm(v1 ~ v2 + v3)` over bridged data | 1.07 s |
| `nanoparquet` install + probe in WebR | 1.27 s |
| DuckDB write Parquet (5k×3) | 0.63 s (0.1 MB) |
| Parquet → WebR FS → R read | 0.02 s |
| Final memory (both runtimes resident, large data) | **1239.0 MB total** |

## Findings

1. **DuckDB-WASM handles the target scale easily.** 200 × 500k generated in 1.25 s;
   a full-table aggregate is 0.02 s. Peak ~1.2 GB total with the whole dataset
   resident — well under the wasm32 ~4 GB ceiling, and trivial for an M5 iPad Pro.
2. **Both runtimes coexist comfortably.** ~1.24 GB total holds DuckDB (800 MB of
   data + overhead) *and* WebR at once. The "two heavy WASM runtimes" worry is
   not a blocker at this scale.
3. **The DuckDB↔WebR bridge has TWO working paths — the key open question is answered:**
   - **Bridge A (JS arrays) — guaranteed.** DuckDB query result → Arrow JS column
     `.toArray()` → plain JS arrays → WebR `data.frame`. Always available, no extra
     R packages. This is the safe default.
   - **Bridge B (Parquet) — also works.** `nanoparquet` **installs cleanly in WebR**,
     so DuckDB can `COPY … TO parquet`, the bytes go through WebR's virtual FS, and
     R reads them with `nanoparquet::read_parquet`. Avoids materialising JS arrays
     for the hand-off — the lower-copy path we hoped for. (We did *not* need the
     heavyweight R `arrow` package.)
4. **Bundle note:** `selectBundle()` chose `duckdb-eh.wasm` (exception-handling
   build) even under isolation, with `pthreadWorker` supplied. Performance was fine;
   no need to force the `coi` bundle.

## Caveats / not yet tested

- WebR init time (1.73 s) reflects a warm HTTP cache; cold first load is tens of MB.
- **Not run on iPad Safari yet** — the actual target. Two device-specific risks:
  COEP/worker handling for the DuckDB blob-worker, and Parquet/`nanoparquet` in
  WebR on Safari. Fold into the existing Milestone-3 iPad pass.
- Synthetic data is all-numeric with no NULLs; NA/missing handling and string/factor
  columns across the bridge still need exercising.
- The 4 GB wasm ceiling is real: 200 × 500k fit (~1.2 GB), but much larger N will
  eventually need DuckDB's out-of-core spilling — untested here.

## Implication for the build

Proceed to re-back `core/data-store.js` on DuckDB-WASM. Use **Bridge A as the
default** injection path and offer **Bridge B (Parquet)** as the fast lane for large
reduced results. Keep variable metadata (labels/value-labels/missing/measure)
app-side; DuckDB holds the values. Public `app.data` API stays unchanged.

---

# Spike 2 — messy real-world data across the bridge

`messy-data-spike.html`. The first spike used clean all-numeric data; real
survey/admin data is messy. This builds a 5-row dataset with known expected
values exercising every nasty case, and asserts **both bridges** carry it into R
faithfully. **Result: 32/32 fidelity checks pass — after fixing two real bridge
bugs the spike surfaced.**

## What the messy dataset exercises

- **Real NULLs** in numeric (`age`, `income`) and the empty-string-vs-NULL
  distinction in text (`name` has `''` which must stay data, not become NA).
- **SPSS user-defined missing codes** — `age = -99` must be recoded to NA.
- **Categorical factor** (`gender_code` 1/2 with a NULL) whose value labels
  (`{1:Male,2:Female}`) live app-side, not in SQL.
- **Unicode + punctuation** in strings (`Bø`, `Łukasz`, `O'Brien, J.`).
- **A "numeric" column that's actually dirty text** (`messy_num` VARCHAR with
  `'N/A'`, `'abc'`, `''`) — must coerce, turning junk into NA, not erroring.

## The plan it proves: metadata-driven cleaning, pushed into DuckDB SQL

App-side `VariableMeta` drives a generated cleaning `SELECT`:

- `sourceText` (column needs coercion) → `TRY_CAST(col AS DOUBLE)` — junk → NULL,
  never an error.
- `missingValues: [-99,-98]` → `CASE WHEN col IN (-99,-98) THEN NULL ELSE col END`.
- Factors stay as codes through the bridge; `factor(x, levels, labels)` is
  reapplied in R from the app-side labels.

This keeps the heavy per-cell work in DuckDB (vectorised, fast) and keeps SPSS
semantics (labels, user-missing, measure) in the app where they belong.

## Two bridge bugs the spike caught (both real, both would corrupt analyses)

1. **`Arrow .toArray()` silently drops NULLs.** The values buffer and the
   validity bitmap are separate; `.toArray()` returns the values only, so a NULL
   reads as `0`/garbage. **Fix:** read per-cell with `.get(i)`, which returns
   `null` for missing. (Bridge A.)
2. **DuckDB DECIMAL × Arrow-JS = ×10^scale corruption.** DuckDB infers
   `DECIMAL(6,1)` for a literal like `55000.0`; Arrow-JS `.get()` on a decimal
   column returns the *unscaled* integer (`550000`), so values come back 10×
   too big — silently. Caught because `mean(income)` was 590000 not 59000.
   **Fix:** `CAST` numeric columns to `DOUBLE` in SQL before the JS-array
   extraction (Bridge B/Parquet applies the scale correctly and was unaffected).

## Fidelity verdict per bridge

| Concern | Bridge A (JS arrays) | Bridge B (Parquet) |
|---|---|---|
| NULL → R NA | ✓ (with `.get(i)`) | ✓ |
| Empty string ≠ NA | ✓ | ✓ |
| User-missing `-99` → NA | ✓ (SQL `CASE`) | ✓ (SQL `CASE`) |
| Dirty text → NA | ✓ (`TRY_CAST`) | ✓ (`TRY_CAST`) |
| Unicode / punctuation | ✓ | ✓ |
| Factor rebuilt from labels | ✓ | ✓ |
| **DECIMAL scale** | ✗ unless `CAST AS DOUBLE` | ✓ native |
| **Integer type preserved** | ✗ widened to double | ✓ stays `integer` |

**Takeaway:** Bridge A is correct *only with the two fixes baked in* and is
type-lossy (everything numeric → double). Bridge B (Parquet) is higher fidelity
(native types, decimals, NULLs) for free. Lean on **Bridge B as the default**
when `nanoparquet` is present, with the (now-hardened) Bridge A as the fallback —
the opposite of Spike 1's tentative recommendation, on the strength of this
evidence.

## Covered by Spike 3 (below)

The "still not covered" items from this spike — dates/times, long strings,
int64 — are all addressed in Spike 3. Only **iPad Safari** (Milestone 3) remains.

---

# Spike 3 — full data-type coverage across the bridge

`datatypes-spike.html`. The last bridge spike before building for real: confirm
every column type a dataset can contain survives both bridges, with NULLs
throughout. **Result: 52/52 checks pass on both bridges.**

## Types exercised (one column each, 4 rows incl. an all-NULL row)

`BIGINT` (int64, at ±(2⁵³+1) — beyond JS/double safe-integer), `BOOLEAN`,
`DATE` (incl. a leap day and a pre-1970 date), `TIMESTAMP` (incl. pre-epoch),
`DOUBLE` with `+Inf`/`-Inf`/`NaN`, `DECIMAL(9,2)`, and `VARCHAR` with a
beyond-BMP emoji (👋🏽 = base + skin-tone modifier) and a 1000-char string.

## The headline finding: R has no native int64

Empirically confirmed (informational probe in the spike): a native `INT64`
written to Parquet and read by `nanoparquet` comes back as **R `numeric`
(double)**, so `9007199254740993` → `9007199254740992` — the low bit is
**silently lost**. This corrupts large ID columns (Stata/SPSS `long`, database
PKs, etc.).

**Adopted strategy:** carry 64-bit integers as **R `character`** by default
(IDs are identifiers, not arithmetic operands) — `CAST(col AS VARCHAR)` in SQL on
both bridges. Round-trips exactly. Offer `bit64::integer64` only if/when a real
analysis needs 64-bit *arithmetic*.

## Other type rules confirmed

| Type | Strategy (both bridges) | R result |
|---|---|---|
| int64 (`BIGINT`) | `CAST … AS VARCHAR` | `character`, exact |
| boolean | native | `logical` (NULL→NA) |
| `DATE` | A: ISO text → `as.Date`; B: native Parquet | `Date` (leap + pre-epoch OK) |
| `TIMESTAMP` | A: ISO text → `as.POSIXct(tz="UTC")`; B: native | `POSIXct`, **tz pinned UTC** |
| `±Inf` / `NaN` | native double | `Inf`/`-Inf` preserved; `NaN`+`NULL` both count as `is.na` |
| `DECIMAL` | `CAST … AS DOUBLE` (per Spike 2) | `numeric`, exact to scale |
| unicode / long text | native | beyond-BMP emoji + 1000-char string intact |

**Timezone note:** DuckDB `TIMESTAMP` is tz-naive; we pin `tz="UTC"` on
reconstruction so wall-clock values are stable and don't shift by the browser's
local zone. A tz-aware type (`TIMESTAMPTZ`) would need an explicit policy later.

## Net: the bridge is proven for the full type surface

After Spikes 1–3, both bridges carry scale, missingness, messy text, and every
common type faithfully — with two SQL-side rules baked in (`CAST` decimals/int64,
recode user-missing) and temporal reconstruction pinned to UTC. **Cleared to
build the real DuckDB-backed `DataStore`.** Remaining unknown is device-only:
the whole path on **iPad Safari** (Milestone 3).


---

# Spike results — Whisper on-device transcription (`whisper-spike.html`)

De-risking #139 Phase 2 before committing to the epic, at the owner's request: turn July's
feasibility estimates into measurements. **Verdict: viable, materially faster than
estimated, and the measurements invert the intended default.**

## Setup

- **Where:** desktop Chrome, 16 cores, served by the dev server with real COOP
  `same-origin` + COEP `credentialless` (`crossOriginIsolated === true`).
- **transformers.js** `@huggingface/transformers@4.3.1` from jsDelivr, pinned the way every
  other runtime here is.
- **Model:** `onnx-community/whisper-tiny.en`, the smallest practical Whisper.
- **Audio:** the standard public-domain JFK clip (11 s), and the same speech repeated to
  **66 s** for a sustained real-time factor. A timing load, not a transcription-quality
  test — but the text came back correct, which is worth knowing too.
- **Bytes** counted by wrapping `fetch` and summing `content-length`, so the figures are
  what actually crossed the wire, not a published artefact list.

## Numbers

Desktop Chrome, 16 cores:

| config | over the wire | pipeline ready | 11 s clip | 66 s clip | an hour of audio |
|---|---|---|---|---|---|
| WebGPU fp32 | 149.8 MB | 83.8 s | 4.2× | 15.1× | 4.0 min |
| WebGPU q4 | 91.3 MB | 50.9 s | 7.0× | **17.0×** | 3.5 min |
| **WASM q8** | **39.0 MB** | **3.9 s** | 7.1× | 9.4× | 6.4 min |

**Phone, 4 cores, WASM q8** (owner's run on the deployed Pages build, 2026-10-26):

| config | over the wire | pipeline ready | 11 s clip | 66 s clip | an hour of audio |
|---|---|---|---|---|---|
| WASM q8 | 44.3 MB | 5.2 s | 9.1× | **17.0×** | 3.5 min |

`crossOriginIsolated: true` on Pages, so the service worker's isolation reaches `/spike/`
and WASM had SharedArrayBuffer and threads. WebGPU was present but unused (a recent iOS).

The short-clip factors are dominated by first-inference warm-up; the 66 s column is the one
to quote.

## Against the July 2026 estimates

| | estimated | measured |
|---|---|---|
| WebGPU throughput | ~5–8× real-time | **15–17×** |
| WASM throughput | ~2–3× real-time | **9.4×** |
| "tiny" download | 75 MB (Q5 31 MB) | 149.8 MB fp32 · **39.0 MB** quantised WASM |

Two to three times faster on both paths. The size estimate was right only for the
quantised variant.

## What it changes

**WASM q8 should be the default and WebGPU the opt-in**, which is the reverse of the plan.
July said "treat WebGPU as the bonus fast path, WASM as baseline" for mobile reasons; the
numbers make WASM the better default everywhere. A quarter of the download, **twenty times
faster to be ready** (3.9 s against 50–84 s), and still 9.4× real time. WebGPU q4 buys 1.8×
throughput for 2.3× the bytes and a minute of startup — offer it as "faster, bigger"; do
not make a first-time user transcribing one interview wait for it.

## Speaker diarization — yes, but not from the obvious model

Whisper transcribes; it does not say who spoke. The owner asked for `Voice1: … Voice2: …`,
so both candidate models were measured against a conversation with known ground truth:
**JFK (11 s) → MLK (13 s) → JFK (11 s)**, i.e. two speakers, pattern A, B, A.

**`pyannote-segmentation-3.0` (1.5 MB quantised) is the wrong tool on its own.** It loads
in 682 ms and runs at **67× real time**, and it correctly reported *two* speakers — then
alternated them every half second, `A,B,A,B,…` **29 times** through three actual turns. It
is a frame-level speaker-ACTIVITY model whose labels are positional within a local window,
not identities that survive across one. Good for "is anyone talking"; useless for "who".

**`wespeaker-voxceleb-resnet34-LM` (6.4 MB quantised) plus clustering is the answer.**
Slice into 2 s windows, embed each (256-dim), cluster agglomeratively by cosine similarity,
merge adjacent windows in the same cluster. 17 windows embedded in 2.1 s (~17× real time).

| cosine threshold | speakers found | turns | pattern |
|---|---|---|---|
| 0.25 | **2** | **3** | **A,B,A** |
| 0.35 | **2** | **3** | **A,B,A** |
| 0.45 | 3 | 7 | A,B,A,C,A,B,A |
| 0.55 | 8 | 13 | … |
| 0.65 | 11 | 15 | … |

At 0.25–0.35 the result is right: boundaries at **12.0 s and 24.0 s** against ground truth
11 s and 24 s — inside one window. Cost is **~8 MB** on top of Whisper's 44 MB and roughly
half the throughput, which still leaves it comfortably faster than real time.

### What this does not prove

- **Two famous, very distinct male voices in clean studio audio, no overlap, no
  crosstalk.** Real interview audio has all three, plus accents and room noise.
- **The threshold is tuned on one example.** The jump from 2 speakers to 11 across
  0.25 → 0.65 shows how sensitive it is; a different recording may want a different value,
  which argues for exposing it, or for asking the user how many speakers to expect (in an
  interview, usually known).
- **2 s windows put turn boundaries at ±2 s**, and a short interjection — "mm-hm", a
  one-word interruption — is absorbed into the surrounding turn rather than found.

## The phone result overturns the mobile assumption

**The phone is nearly twice the desktop's WASM throughput — 17.0× against 9.4× — and equal
to the desktop's WebGPU-q4 figure**, on a quarter of the download and a tenth of the
startup. Four fast cores beat sixteen slower ones; ORT's WASM threading does not scale the
way a core count suggests.

So July's advice to *"prefer transcript import or desktop-transcribe-then-sync over
grinding a model on-device"* on tablets is wrong, at least for current hardware. So was the
caveat written here before the run (*"says nothing reliable about a phone"* — true, and the
unmeasured guess underneath it, that a phone would be slower, was the wrong way round).
On-device transcription is a **phone-first** feature as much as a desktop one.

## What this still does NOT establish

- **Older devices.** This phone reports WebGPU, so it is recent iOS. An institutional iPad
  several years old is untested, and that is the population July was actually worried about.
- **Sustained load and thermal throttling.** 66 seconds of audio finishes in under four
  seconds; an hour does not, and a phone that throttles mid-transcription will not hold
  17×. The "3.5 minutes per hour" figure is an extrapolation from a short burst.
- **Accuracy on real material.** One clean, famous, well-enunciated clip. Interview audio
  has crosstalk, accents and room noise — and `tiny.en` is the smallest model there is.
- **Anything about the epic.** This ran on the main thread and froze the tab for seconds at
  a time. The feature still needs a worker, chunking, progress, cancellation, model choice
  and cache/offline integration. Feasibility is closed; effort is not.


---

# Spike results — what a transcription worker costs (`transcribe-pressure.html`)

I claimed in a commit message that *"two models and an hour of audio in parallel is how a
phone runs out of memory"*, and had measured none of it. The owner rejected it on three
counts, all correct: **we do not know that**, **transcribing several interviews is a very
likely need**, and **one device being unable to do it should not put it off limits for
every device**. This is the measurement that should have come first.

## Setup

- Desktop Chrome, 16 cores, `deviceMemory` 32, served under real COOP/COEP so
  `performance.measureUserAgentSpecificMemory()` is available and counts WASM.
- Each worker is a real same-origin module worker loading `onnx-community/whisper-tiny`
  at `q8` on WASM — the production default.
- A first draft used a blob-URL worker and hung with no error. Switched to a real file,
  which is also what ships; the blob question is left alone.

## Numbers

| | memory after | this worker | ready in |
|---|---|---|---|
| baseline | 0.9 MB | — | — |
| worker 1 | 219.8 MB | **+219.0 MB** | 4 645 ms |
| worker 2 | 438.7 MB | +218.8 MB | 1 287 ms |
| worker 3 | 657.5 MB | +218.8 MB | 1 106 ms |
| worker 4 | 876.0 MB | +218.5 MB | 933 ms |
| after `terminate()` × 4 | **0.9 MB** | — | — |

**219 MB per worker for a 39 MB model** — the ONNX runtime's arenas are about 5.6× the
weights. **Perfectly linear**: separate memory spaces share nothing. **Fully reclaimed on
terminate**, so per-job workers are fine and reuse is only about skipping the ~1 s reload
(the first load pays for the HTTP fetch; later ones do not).

## The finding that shaped the design

**A device may tell you nothing.** On this desktop every gauge was available. But
`navigator.deviceMemory` is Chromium-only and `measureUserAgentSpecificMemory` requires
cross-origin isolation — on iOS Safari there is no memory reading at all, and that is
where a good deal of this will run. A policy that reads a gauge would silently degrade to
a guess on exactly the devices where guessing is most dangerous.

So `core/transcribe-pool.js` starts from whatever the device *will* say — memory if
offered, otherwise half the core count, capped while blind — and then **adapts on
evidence**. A worker that dies is a signal every device produces, and it costs one
requeued job to learn from. That is what makes "a new phone gets two, an old phone one,
an iPad four, a desktop ten" happen without anyone maintaining a table of devices, and the
user can override the number anyway.

## The phone, and a limit that is permanent

Run on the owner's phone (4 cores), first un-isolated and then isolated once the spikes
learned to register the service worker themselves:

| | isolated? | worker 1 | worker 2 | memory |
|---|---|---|---|---|
| first run | no (SW not controlling) | 1133 ms | 1180 ms | unmeasurable |
| second run | **yes** | 1355 ms | 1243 ms | **still unmeasurable** |

**iOS offers no memory gauge at all, isolated or not.** `navigator.deviceMemory`,
`performance.measureUserAgentSpecificMemory` and `performance.memory` were all ABSENT in
both runs. This is not a symptom of the missing isolation — those APIs are not Safari's,
and isolation does not conjure them. So on an entire platform there is **no number to
read**, permanently, and any allocation policy that depends on reading one is blind there.
That is the single strongest argument for adapting on worker deaths instead.

The isolated run came out ~10% slower across two samples each, which is **noise, not a
finding** — and these are model LOAD times anyway: fetch, parse, arena allocation. Threads
help inference, not loading. The inference figure for this phone is in the Whisper spike
above (17× real time, isolated).

What it does establish: **two workers load fine on a 4-core phone**, in about 1.3 s each,
and 4 cores is exactly what the blind heuristic turns into a limit of 2 — the policy's
guess and the device's behaviour agreeing, arrived at independently.

## Does concurrency pay? Both devices, and the answer is cores — not memory

Phone (4 cores, iOS, isolated) and desktop (16 cores, 32 GB, Chrome, isolated), 60 s
synthetic clips, equal work per worker from a shared queue:

| workers | phone speed-up | desktop speed-up | desktop jobs/s | desktop efficiency |
|---|---|---|---|---|
| 1 | — (896 ms/clip, 67x) | — (968 ms/clip, 62x) | 1.03 | — |
| 2 | **1.8x** | **2.01x** | 2.07 | 100% |
| 3 | **2.01x** | 2.72x | 2.81 | 91% |
| 4 | **out of memory** | **3.06x** | 3.16 | 76% |
| 6 | — | 3.06x | 3.16 | 51% |
| 8 | — | 2.95x | 3.05 | 37% |
| 10 | — | 3.11x | 3.22 | 31% |

**Sixteen cores saturate at four workers.** From 4 to 10 the throughput is 3.16, 3.16,
3.05, 3.22 jobs/s — flat inside noise. Six extra workers cost 1.3 GB of models and return
nothing. The phone saturates at 2–3 and dies at 4.

### This contradicts the pool's own arithmetic

`deviceCapacity()` divides a quarter of reported memory by 219 MB per worker. On this
desktop that is 8192/219 = **37 workers**, which only the hard `min(…, 10)` keeps sane — and
**10 is still 2.5x the measured optimum of 4**. Meanwhile the *blind* path, `cores/2` capped
at 3, gives 3 on the desktop and 2 on the phone: both within one of the measured best.

**The heuristic written for devices that report nothing is more accurate than the one
written for devices that do.** Memory turns out to be a CEILING (the phone's 4th worker
died) and never a target. Cores predict the useful number; memory only vetoes it.

### Three controls, because the plateau was not believable at first

1. **Is the harness biased against large N?** A static round-robin would be: 24 jobs over
   10 workers leaves some doing 3 and some 2, and the wall clock follows the 3 — a ~25%
   penalty that mimics sub-linearity. Simulated in Node with fixed-cost jobs, the shared
   queue returns 92% efficiency flat from 2 to 10 workers. Flat is what matters: no drift
   with N, so the curve is the device's, not the harness's.
2. **Is the hidden tab CPU-starved?** The desktop's serial rate (968 ms/clip) is *slower*
   than the phone's (896 ms) on four times the cores, which would be odd. An identical
   arithmetic loop ran in **1025–1402 ms in the hidden tab vs 1540 ms in Node** on the same
   machine, same checksum. Not starved — it beat Node. The plateau is real, and so is the
   finding that single-stream WASM barely cares which device it is on.
3. **Was the decoder cap distorting it?** No, and not for the reason assumed. Re-running at
   a 220-token cap gave the same curve (2.02x / 3.10x / 3.12x) and the same serial rate.
   Probing one worker directly: **4 characters of output at caps of 16, 48 and 220** — the
   model hits end-of-sequence immediately on noise. The cap was never binding.

### The limitation that control 3 exposes — and which the next section settles

Because noise decodes to nothing, **the figures above measure the encoder and nothing
else.** Real speech is substantially decoder work. At the time this was written I predicted
the decoder would scale *better* across workers, making the numbers above a floor. **That
prediction was wrong — see below. They are a ceiling.**

## Real speech, and the prediction it falsified

Same desktop (16 cores / 32 GB, isolated), same harness, same clip length. Audio:
`ami-ES2002a-mix-headset.wav` — 21.2 minutes of a four-person meeting, CC BY 4.0, fetched
by `scripts/fetch-sample-audio.mjs`. Clips sampled evenly across the recording, each one
processed exactly N times at concurrency N.

**620 transcript characters per clip, against 4 on noise.** The decoder ran.

| workers | jobs/s | speed-up | efficiency | noise, for comparison |
|---|---|---|---|---|
| 1 | 0.22 | — (4457 ms/clip, **13x** real time) | — | 968 ms/clip, 62x |
| 2 | 0.31 | **1.39x** | 70% | 2.01x |
| 3 | 0.36 | 1.62x | 54% | 2.72x |
| 4 | 0.37 | **1.64x** (peak) | 41% | 3.06x |
| 6 | 0.36 | 1.60x | 27% | 3.06x |
| 8 | 0.35 | 1.56x | 19% | 2.95x |
| 10 | 0.35 | 1.56x | 16% | 3.11x |

Two things to take from this:

**Real speech costs 4.6x more per clip** (4457 ms vs 968 ms). About three quarters of the
real work is decode that noise never triggered, which is also why 13x here reconciles with
the phone's 17x on real audio and not at all with 62x on noise.

**Real speech parallelises half as well** — 1.64x peak against 3.11x. So the synthetic
benchmark did not understate concurrency, it **overstated it by about 2x**, and every "these
figures are a floor" note (now corrected here, in TODO.md and in the spike's own output) had
it backwards.

### Why it went the other way

The claim was that the decoder "leaves cores idle, so extra workers fill them". The idle
cores are real; the conclusion does not follow, because **decode is not core-starved, it is
memory-bandwidth bound.** Autoregressive generation streams the weights and the KV cache out
of RAM for every single token, so four workers each holding their own 219 MB contend for
bandwidth and cache rather than occupying spare cores. The encoder is dense matmuls with
good cache reuse, which is precisely why *that* half scaled to 3.1x. Compute-bound work
parallelises; bandwidth-bound work does not.

This is also why more cores did not help: the desktop has 16 and still peaks at 1.64x. The
bottleneck was never the core count.

### What it means for the policy

- **Two workers capture 85% of everything available** (1.39x of a 1.64x peak), for one extra
  219 MB. Three capture 99%.
- **Beyond three, nothing.** 4 through 10 are 1.64, 1.60, 1.56, 1.56 — flat and drifting
  down.
- The memory-budget arithmetic would offer **10 workers to buy 1.56x**, which is five times
  the models for less throughput than two workers get. It is not slightly miscalibrated; it
  is measuring the wrong quantity.
- Absolute performance is still good: **an hour of audio in 4.5 minutes on one worker, 2.7
  minutes on four.** The case for concurrency is real but small, and it is about two
  workers, not ten.

### Still open on real audio

The phone has only ever run the synthetic sweep. Since noise flatters concurrency by 2x,
its 1.8x at two workers is probably nearer 1.3x in truth — worth confirming, which is what
the spike's new file picker is for. Accuracy and speaker detection are also untouched: the
AMI fixture ships word-level transcripts with speaker labels (`ami_public_manual_1.6.2.zip`,
5183 files, per-speaker `words.xml` with start and end times), so word error rate and
diarization error are measurable against it whenever that work starts.

### An instrument bug worth remembering

`performance.measureUserAgentSpecificMemory()` **hangs indefinitely in a hidden tab** — it
resolves at a GC checkpoint a backgrounded renderer may never reach. It deadlocked the
desktop run after one worker (90 s for worker 1; the same run with memory skipped did six
workers in six seconds). `measure()` now races a timeout and is skipped entirely when
`document.hidden`. A `setTimeout` guard alone is not enough: timers in a hidden tab are
throttled to about once a minute, so an 8 s guard can take 60 s to fire.

## The phone, on real speech, over repeated passes

`spike/transcribe-endurance.html`, phone (4 cores, isolated, wake lock held), the
40-minute US Army oral history fetched from archive.org. Six passes over 1, 2 and 3
workers with the direction alternating, the same three workers reused throughout.

| pass | dir | N=1 | N=2 | N=3 | su2 | su3 |
|---|---|---|---|---|---|---|
| 1 | -> | 1391 | 1961 | 2301 | 1.42x | 1.81x |
| 2 | <- | 1182 | 1834 | 2343 | 1.29x | 1.51x |
| 3 | -> | 1171 | 1649 | 2270 | 1.42x | 1.55x |
| 4 | <- | 1385 | 1752 | 2196 | 1.58x | 1.89x |
| 5 | -> | 1205 | 1921 | 2194 | 1.25x | 1.65x |
| 6 | <- | 1553 | 1881 | 2434 | 1.65x | 1.91x |

(ms per clip; `su` is throughput against 1 worker in the same pass.)

### What this settles

**Concurrency on a phone, with real speech: 1.44x at two workers, 1.72x at three.**
These are within-pass ratios over identical clips, so content and drift cancel out —
they are the trustworthy numbers in the table.

**The phone scales BETTER than the 16-core desktop.** Desktop real-audio peaked at 1.64x
(four workers) and gave 1.62x at three; the phone gives 1.72x at three. On four cores.
That fits the memory-bandwidth explanation: a phone's unified memory serves four cores
more evenly than a desktop serves sixteen, and transcription's expensive half is
bandwidth-bound. It also fits the older finding that four fast cores beat sixteen slower
ones.

**Three workers are clearly better than two on the phone** (1.72x against 1.44x), where on
the desktop the third worker added almost nothing. But the phone died loading a FOURTH
worker, so three is also the ceiling, and 3 x 219 MB = 657 MB leaves little room for
DuckDB and WebR in the same tab. Worth deciding deliberately rather than by arithmetic.

### What this does NOT settle, and why

**Thermal behaviour: still unmeasured.** The run took **1.6 minutes**, not the 10-12
predicted, so nothing got hot. The apparent "drift" is negative — N=1 went from 1391 to
1205 ms/clip, i.e. 13% FASTER — which is warm-up (JIT, allocator, CPU boost ramping), not
throttling. Six passes is simply not a thermal test, so the spike now takes a wall-clock
budget (`?minutes=10`) instead of a pass count.

**"66x real time overall" is an artefact, not a result.** It came from transcribing
near-silence. The clips were chosen by POSITION — 0%, 50% and 100% of the recording — with
no check that anyone was talking, so the phone got tape leader and run-out:

| | phone | desktop, same recording |
|---|---|---|
| ms per clip | 1314 | 6366 |
| characters per clip | 276 | 1068 |
| implied speech rate | **55 wpm** | **214 wpm** |

Conversational English runs 120-180 wpm. The phone was transcribing mostly nothing.

### Two of my claims that this falsified

**"Content-normalised cost (ms per 1000 characters) is comparable across devices."** It is
not. On ONE desktop, two different minutes of this same recording measured **9.66 and 5.96
ms per character**. A clip pays a fixed encoder cost per 30 s window whether or not anyone
speaks, so cost is roughly `fixed + rate x characters`, and the per-character figure moves
with speech density. Fitting the two desktop points gives ~3.6 s fixed per 60 s clip plus
~2.6 ms per character — an interpolation through two points rather than a validated model,
but enough to kill the claim.

**"The phone is 1.25x faster per character than the desktop."** That followed from the
assumption above, so it does not stand either. Applying the fitted shape instead suggests
~3.3x, but that extrapolates the desktop's fixed-to-variable ratio onto the phone from a
single phone data point, which is not evidence. **The only sound cross-device comparison is
both devices transcribing identical clips** — so the spike now prints a fingerprint per
clip, and a comparison is only valid when the fingerprints match. Verified deterministic:
two desktop runs chose the same clips (`63228a 723d03 c6ecf7`), the same levels, and
measured 4909 and 4910 ms per clip.

### Instrument bugs this run exposed

**iOS could not decode a mid-file MP3 slice** — "clip 2 by range failed (Decoding failed)"
— so the phone fell back to decoding the whole 40 minutes, about 153 MB of Float32 on a
device that had already died at roughly 880 MB. It survived; a tighter device would not
have. Safari will not decode a slice beginning mid-frame, so the spike now scans forward to
a real MPEG-1 Layer III frame header, requiring three consecutive valid frames so a stray
0xFF inside audio data cannot fool it. Checked against the actual recording at 12 byte
offsets: every probe found a boundary within one frame (~600 bytes) and the frame chain
then covered 100% of the slice.

**Clips are now chosen by level**, not position: the spike samples 8 places and keeps the
loudest 3. On this recording that narrowed the spread rather than eliminating it (kept
0.030/0.021/0.020, skipped down to 0.013) and moved the desktop from 1068 to 508
characters per clip — which is why the fingerprint, not the level, is what makes a
comparison valid.

## Whole interviews — and the bug that invalidates the absolute numbers above

The owner asked whether the spikes were still transcribing clips, since users transcribe
entire interviews. They were, and worse.

### Every "60 s clip" was 30 seconds

`spike/transcribe-pressure-worker.js` called the pipeline with **no `chunk_length_s`**, so
Whisper ran a single pass over its 30-second receptive field and silently truncated
anything longer. Proved by handing it 60 s and 30 s of the same audio: **identical output,
261 characters each**. Meanwhile `core/transcribe-worker.js` — the one that ships — has
always passed `chunk_length_s: 30, stride_length_s: 5, return_timestamps: true`. The spike
was measuring a configuration the app never uses.

With the shipping options the same minute costs **17.0 s instead of 3.0 s**, and reports
coverage of 59.96 s instead of nothing. **Every real-time factor from the clip spikes is
therefore wrong, overstated roughly twofold or more.**

What survives: the concurrency RATIOS, because they compared configurations under
identical (wrong) conditions, and measuring them properly in long-form mode lands close —
1.39x to 1.51x at two workers, 1.62x to 1.71x at three.

### `return_timestamps: true` costs 2.9x

Same minute, same chunking, one option changed (desktop, 16 cores):

| config | 60 s costs | real time | an hour |
|---|---|---|---|
| chunked, no timestamps | 5910 ms | 10.2x | 5.9 min |
| chunked, **with timestamps — ships today** | 17276 ms | **3.5x** | **17 min** |
| chunked, no stride, no timestamps | 5157 ms | 11.6x | 5.2 min |

Timestamps nearly triple the cost of every transcription the app performs, and the stride
adds another 15%. They are needed for WebVTT cues and for aligning diarized speaker turns
to text — but a user who wants a plain transcript is paying 2.9x for neither. **This is the
largest single performance lever in the shipping configuration** and it is a product
decision, so it is recorded rather than changed. It also reconciles the old phone figure
(17x, measured without timestamps) with today's desktop 3.5x.

### One interview, and whether splitting it helps

This is the architectural half. A user transcribes ONE interview in ONE call, and Whisper
then processes ~80 chunks sequentially inside a single worker — so **every concurrency
number measured before this applies only to a BATCH of interviews.** For one interview at
a time, extra workers do nothing at all.

`spike/transcribe-interview.html`, desktop, 3 minutes of the Army interview, 60 s segments
with 2 s overlap:

| config | wall | real time | vs today | characters |
|---|---|---|---|---|
| one call (ships) | 0m50s | 3.59x | — | 3587 |
| split x1 (control) | 0m46s | 3.94x | **1.10x** | 3562 |
| split x2 | 0m33s | 5.42x | 1.51x | 3562 |
| split x3 | 0m29s | 6.13x | **1.71x** | 3562 |

**Segmentation is free — slightly better than free.** On one worker it came out 8.9%
FASTER than the single long call, despite transcribing 2.2% more audio because of the
overlap. So the usual objection (per-call overhead, losing cross-chunk context) does not
show up at this segment size.

**Splitting across three workers takes an hour of audio from 16m44s to 9m48s.** That is the
only route by which extra workers help the common case, and 1.71x matches the phone's
batch figure of 1.72x at three workers.

### A second, independent reason to segment

`core/transcribe-worker.js` reports progress for the model download and for speaker
embedding, but **not during the transcription call itself** — `pipe(audio, …)` is a single
await, and `cancelled` is only checked before and after it. A 40-minute interview is
therefore **11+ minutes of one un-cancellable, un-progressing await**, and the Stop button
cannot take effect until it finishes. Segmenting gives progress and cancellation at
segment granularity for free.

Not the only route, though: transformers.js 4.3.1 exposes `callback_function` and
`streamer` (there is no `chunk_callback`), so token-level progress and `stopping_criteria`
cancellation inside a single call may be possible. Unverified for the ASR pipeline — a
lead, not a fact.

### Hallucination loops are real, and separate from speed

The opening minute of the Army tape returns 2101 characters, 332 words, a **unique-word
ratio of 0.163**, and one four-word phrase repeated **34 times**. A minute from the middle
returns 588 characters at a 0.604 ratio with no repetition. Both take the same ~17 s, so
this barely affects timing — but it makes the transcript worthless, and it is the first
hard evidence on the accuracy question. The spikes now compute and flag these statistics.

It also kills the "ms per 1000 characters" normalisation recorded above: in long-form mode
**time is driven by audio duration, not by text produced** (2101 and 588 characters, same
17 s). The earlier apparent character-scaling was an artefact of the truncated single-pass
mode. Cross-device comparison just needs the same audio duration.

## 40 minutes crashed the phone, and the arithmetic says it had to

The owner ran `?audioMinutes=40` and iOS killed the tab ("A problem repeatedly occurred").
That is out of memory, and nothing about it was marginal:

| | |
|---|---|
| MP3 ArrayBuffer | 56 MB |
| full decode to PCM | 149 MB |
| `pcm.slice(0, 40 min)` — a COPY | 149 MB **(bug)** |
| `segment()` — copies of all of it | 152 MB **(bug)** |
| `postMessage` with no transfer — a structured clone | 149 MB **(bug)** |
| 3 workers at 219 MB | 657 MB |
| **total** | **1312 MB** |

against a phone that already died near 880 MB. **Three of those five lines were mine**: a
needless slice copy, per-segment copies, and `postMessage` without a transfer list, which
clones the entire Float32Array into the worker.

### The fix is a different shape, not smaller numbers

Segments are now decoded **one at a time, on demand, out of the compressed bytes**, using
the frame scanner written for the endurance spike (now shared in `spike/mp3-sync.js` rather
than copied into both). Live audio cost becomes the MP3 plus one segment per worker —
measured at **63 MB** — and **it does not grow with the length of the interview**. Forty
minutes costs the same as four. `postMessage` now transfers rather than clones.

Verified on desktop, 4 minutes, 60 s segments: 1 worker 1m06s (3.61x), 2 workers 0m48s
(5.02x, 1.39x), **identical 4229 characters from both**, which is the check that each
worker count really did transcribe the same audio. 3.61x also matches the 3.59x measured by
the one-call baseline, so on-demand decoding costs nothing.

### The one-call baseline is now opt-in, because it is the risky one

A single call inherently needs the whole recording decoded and live — **that is what
`core/transcribe.js` does today**. So it runs last, with the extra workers terminated
first, and past 15 minutes of audio it is skipped with the requirement printed instead of
a crash. Whether the SHIPPING path survives a 40-minute interview on a phone is therefore
an open measurement with a known cost to attempt: `?baseline=1`, and a tab crash takes the
split results with it.

That question matters beyond the spike. If the shipping path cannot hold a 40-minute
interview on a phone, then **segmenting is not an optimisation, it is the only way the
feature works at all on mobile** — which is a stronger conclusion than the 1.71x speed-up
that first justified it.

## A phone transcribes a 40-minute interview in 3m27s

The run the whole epic was really waiting for. Phone, 4 cores, isolated, wake lock held,
three workers, the full 40-minute Army interview, segments decoded on demand, **timestamps
on** (the shipping configuration):

```
  workers  wall     x real  chars
  3        3m27s    11.59   42359

live audio memory about 78 MB, and it does NOT grow with the length of the interview
```

**11.59x real time. An hour of audio in 5m10s. No crash.**

### The phone is 1.87x faster than the 16-core desktop

| | real time |
|---|---|
| phone, 3 workers, 40 min | **11.59x** |
| desktop, 3 workers, 3 min | 6.21x |
| desktop, one call | 3.60x |

The original whisper spike found the phone at ~1.9x the desktop's WASM figure. Two
completely different workloads, months apart, the same ratio. "Four fast cores beat sixteen
slower ones" is now measured three independent ways.

### What this settles

**Feasibility, completely.** A 40-minute interview takes 3m27s and an hour takes 5m10s, on
a phone, with speaker-timestamp support on. That is not "viable with caveats", it is fast.

**Thermal, for the single-interview case.** The worry was that a throttling phone could not
hold a burst rate for an hour of audio. It does not have to: an hour finishes in five
minutes, which is too short to heat anything. Thermal only comes back for BATCHES — ten
one-hour interviews would be about 52 minutes of continuous load, and that is still
untested.

**The timestamp question, by making it moot.** `return_timestamps` costs 2.9x, so dropping
it would take an hour from 5m10s to 1m47s. Saving three minutes per hour of audio is not
worth losing WebVTT cues and diarized speaker alignment. **Keep timestamps on and stop
treating the 2.9x as a problem.**

**That memory is a shape question, not a budget question.** 78 MB held, flat, against the
146 MB a full decode would need and the 655 MB the buggy version held.

### What it does not settle

**Whether splitting is worth it on the phone**, because only the 3-worker width was timed.
The batch endurance run suggests ~1.72x, which would put one worker near 6.7x real time and
a 40-minute interview near 6 minutes — usable either way, so this decides how much the
stitching problem is worth, not whether the feature ships. `?configs=1,3` answers it.

**Whether the shipping one-call path survives**, which the spike now skips past 15 minutes.
With the bugs fixed it would need 56 MB (MP3) + 146 MB (PCM, transferred not cloned) +
219 MB (one worker) = **421 MB**, and the phone just held 735 MB without complaint — so it
is probably safe to ask now, where before it was certainly not. The real path also runs
diarization over the whole recording, which this does not.

**Accuracy.** 42359 characters for 40 minutes is ~212 wpm, which is above conversational
and consistent with the hallucination loops already measured. Still the biggest open
question, and the AMI fixture with ground-truth transcripts and speaker labels is the way
to answer it.

## Accuracy: the shipping configuration produces a loop, not a transcript

`spike/transcribe-accuracy.html` scores Whisper against the AMI human transcript - 2600
annotated words, four speakers, CC BY 4.0 - using Levenshtein alignment over normalised
word sequences. `scripts/extract-ami-reference.mjs` turns the annotation bundle into a
reference JSON; the scorer was verified against fourteen hand-computed cases first,
including that substitutions + deletions + insertions always equal the total.

### The first result was not a recognition result

| | |
|---|---|
| reference | `okay right um well this is the kick off meeting for our our project` |
| transcript | `okay okay all right all right all right all right all right all right` |

Unique-word ratio **0.287**, bag-of-words recall 40.7%. The model starts correctly and
collapses into a **repetition loop** - the same failure already seen on the Army tape's
opening minute (one four-word phrase 34 times). A word error rate computed over that
measures a malfunction, which is why the spike now prints the unique ratio next to it.

### Whisper's own anti-loop mechanism is not available here

The reference implementation catches loops by retrying a chunk at higher temperature when
its compression ratio looks degenerate. transformers.js 4.3.1 exposes **no**
`compression_ratio_threshold`, `logprob_threshold`, `no_speech_threshold` or
`condition_on_prev_tokens` - so the shipping worker has no guard at all. What it does expose
is `repetition_penalty`, `no_repeat_ngram_size`, `temperature` and `num_beams`.

Three minutes of ES2002a, 363 reference words:

| setting | WER | uniq | recall | x real time |
|---|---|---|---|---|
| **default (what ships)** | **105.5%** | 0.224 | 47.1% | 4.6 |
| rep1.1 | 93.7% | 0.338 | 55.9% | 11.8 |
| **rep1.2** | **81.8%** | **0.435** | 55.9% | **12.9** |
| ngram6 | 108.8% | 0.220 | 45.7% | 9.4 |
| beams2 | 105.5% | 0.224 | 47.1% | 5.0 |

**`repetition_penalty: 1.2` is worth 23.7 points of WER, drops insertions from 105 to 2,
and runs 2.8x faster** - the loop was burning time generating garbage, which means every
speed figure recorded in this file is partly a measurement of looping.

`no_repeat_ngram_size` makes it WORSE, and `num_beams: 2` is byte-identical to the default,
so it is not reaching the generate call.

### The control that would separate model size from overlap - and did not

81.8% cannot distinguish "whisper-tiny is too small" from "four people are talking over each
other", and those have opposite consequences: an interview is one or two people taking
turns. So the spike grew a `?solo=1` mode keeping only stretches where exactly one person
speaks - 98 stretches, 10.2 min, 1747 words from the same recording.

| | WER | uniq | sub | del | ins |
|---|---|---|---|---|---|
| solo, default | 180.8% | 0.087 | 1049 | 93 | 2032 |
| solo, rep1.2 | **72.7%** | 0.286 | 651 | **589** | 36 |

`rep1.2` is worth 108 points here, which reinforces the headline. But **this control is
confounded and should not be quoted as a verdict on overlap**: concatenating 98 stretches
creates 97 abrupt joins, and deletions jumped from 34 (on the mix) to 589. That is about six
words lost per join, where the mode's own note predicted one. The joins are doing the
damage, not the isolation.

The clean version transcribes **each solo stretch as its own segment** and scores it against
its own words, so no artificial joins exist at all. That is the next measurement, and it is
a small change to the same spike.

### Where this leaves accuracy

- **A real bug, in the product, found by measuring**: the shipping configuration loops on
  real audio and emits more wrong words than there are right ones. `repetition_penalty`
  should go into `core/transcribe-worker.js` regardless of anything else here.
- **whisper-tiny on a four-way meeting mix is not usable** at 81.8%, even fixed.
- **Whether it is usable on interview audio is still open.** One or two people on a close
  mic is a much easier problem than AMI, and nothing has measured it cleanly yet.
- **`base` and `small` are untested.** The worker hard-codes tiny; the model is the most
  obvious lever and the one with a known cost (73 MB and 238 MB against 39 MB).

## The model ladder: tiny was the problem, and base fixes most of it

The owner asked for the best model Whisper has, with a threshold: "if it still can't get
over 90% I'm hesitant to even use Whisper at all." `medium` and `large-v3` are not published
under onnx-community, so **large-v3-turbo** is the best model a browser can actually load.
Same two-minute window of ES2002a, 305 reference words, one worker:

| model | q8 weights | WER | fillers dropped | uniq | recall | x real time |
|---|---|---|---|---|---|---|
| tiny (what ships) | 39 MB | **105.5%** | 111.8% | 0.224 | 47.1% | 4.6 |
| tiny + rep1.2 | 39 MB | 81.8% | 82.7% | 0.435 | 55.9% | 12.9 |
| **base** | **73 MB** | **37.0%** | **31.0%** | 0.508 | 72.8% | **3.7** |
| small | 238 MB | 32.8% | 26.7% | 0.477 | 77.4% | 1.4 |
| large-v3-turbo | 1035 MB | **27.2%** | **21.3%** | 0.525 | 77.4% | 0.5 |

**`base` costs 34 MB more than tiny and is worth 68 points of word error rate.** It lands
within 10 points of a model fourteen times its size, and it does not loop.

### The repetition loop was a tiny problem, not a Whisper problem

Every larger model has a healthy unique-word ratio at default settings — 0.508, 0.477,
0.525 against tiny's 0.224. Nothing loops except tiny.

Which overturns the previous entry's recommendation. **`repetition_penalty: 1.2` must NOT be
shipped**: on `small` it makes things actively worse, 32.8% -> 47.9%, with deletions jumping
from 44 to 101, because it suppresses the genuinely repeated words that speech is full of.
It is a crutch for a model that is failing, and the fix is to stop using that model.

### About the 90% threshold

It is not reachable on this benchmark by anything, and that is a fact about AMI rather than
about Whisper. Published figures for Whisper large-v2 are **16.9% WER on AMI-IHM and 36.4%
on AMI-SDM** ([Whisper paper](https://cdn.openai.com/papers/whisper.pdf)) — 83.1% and 63.6%
accuracy from the best model there is. Our 27.2% on the mixed-headset variant sits exactly
between those two, which is where it should sit: Mix-Headset has IHM's close-mic quality
and SDM's cross-talk. **The harness agrees with the published model**, so the numbers above
can be trusted as a measurement of the models rather than of our plumbing.

AMI is four people in a meeting interrupting each other. It was chosen because it is the
only free corpus with word-level ground truth AND speaker labels, not because it resembles
the product. **An interview — one or two people taking turns on a close mic — is a much
easier problem, and nothing has measured it yet.** Judging "should we use Whisper at all"
on AMI is judging a car by how it handles off-road.

### Speed, which now cuts the other way

`large-v3-turbo` runs at **0.5x real time** on desktop WASM: an hour of audio takes two
hours. It also needs a gigabyte of weights, which the phone cannot hold at all. `small` is
1.4x (43 min per hour). `base` is 3.7x — about 16 minutes per hour on this desktop, and the
phone measured ~1.9x the desktop, so roughly 8 minutes per hour there, or 5 with the
three-way split.

Note that tiny's 4.6x was never real speed: it was looping, and generating garbage takes
time. The honest comparison is base at 3.7x against tiny+rep1.2 at 12.9x — base is ~3.5x
slower than a tiny that has been forced to behave, and 68 points more accurate.

### What this makes the recommendation

- **Default to `base`, not `tiny`.** 73 MB is the same order as the R packages already
  fetched on demand, and it is the difference between a transcript and a loop.
- **Offer `small`** where the user wants quality and will wait: 4 points better, 2.6x slower,
  238 MB.
- **Do not ship `repetition_penalty`.** It helps only the model we should stop using.
- **`large-v3-turbo` is not a product option** at 1 GB and 0.5x real time, but it is a
  useful ceiling: it says the best available answer on this audio is 27.2%, so `small` at
  32.8% is giving up very little.
- **Measure interview audio before deciding anything final.** Every number here is from a
  four-way meeting.

### Caveat on sample size

These are two-minute windows, 305 reference words. The gaps (105 -> 37 -> 33 -> 27) are far
larger than sampling noise could explain, but the individual percentages carry real
uncertainty and should not be quoted to a decimal place.

## The ladder over the WHOLE file, and what it costs to be wrong about samples

The owner rejected the two-minute ladder: "a test that doesn't run the path the user will
run is not a valid test", and users transcribe whole interviews. Rerun over the complete
annotated span — 17.7 minutes, 2633 reference words, 8.6x the previous sample — segmented
across workers, which is the shape that ships:

| model | weights | WER | no fillers | accuracy | sub | del | ins | uniq | recall | x real |
|---|---|---|---|---|---|---|---|---|---|---|
| tiny | 39 MB | **174.7%** | 184.6% | — | 1761 | 142 | 2698 | 0.063 | 55.1% | 5.2 |
| base | 73 MB | 37.7% | 33.8% | 62 / 66% | 320 | 537 | 136 | 0.246 | 76.3% | 6.4 |
| small | 238 MB | 31.2% | 26.9% | 69 / 73% | 219 | 515 | 87 | 0.252 | 77.9% | 2.7 |
| large-v3-turbo | 1035 MB | **27.0%** | **22.9%** | **73 / 77%** | 176 | 470 | 66 | 0.254 | 80.0% | 0.5 |

**base and small were well estimated by the short window** (37.0 -> 37.7, 32.8 -> 31.2).
**tiny was not**: 105.5% -> 174.7%. The two-minute sample flattered the one model that
fails, which is the worst possible direction for a sampling error to point.

Practical cost per hour of audio: base 9 min, small 22 min, large 118 min (one worker;
large cannot be multiplied across workers at a gigabyte of weights, and a phone cannot hold
it at all).

### The loop detector was wrong, and the human transcript fixed it

A fixed unique-word-ratio threshold of 0.35 flagged `base` at 0.246 as looping. It is not.
**Vocabulary saturates with length**: this reference scores 0.463 unique over two minutes
and **0.237 over seventeen**. The control is the human transcript, not a constant:

| | uniq | vs human |
|---|---|---|
| reference | 0.237 | — |
| tiny | 0.063 | **0.27x — looping** |
| base | 0.246 | 1.04x — normal |
| small | 0.252 | 1.06x — normal |
| large | 0.254 | 1.07x — normal |

Same class of error as reporting "40 speaker turns in 120 seconds" from a word-level
transcript: a derived statistic that was never checked against the thing itself. The owner
listened and counted five. The detector now divides by the reference ratio.

## Disfluencies: "keep fillers" cannot be a toggle

The owner's point, which is sharper than it looks: a Sociology interview probably does not
care about "um", a Linguistics interview may care enormously, and there are Cultural
Anthropology papers whose entire result is a comparison of filler use between speakers.
Can retention be a user option?

**Measured on the human reference:** 168 filler tokens, **6.4% of all words**, and the rate
varies **1.9x between speakers** (4.5% for one participant, 8.5% for another). That spread
is exactly the kind of thing somebody publishes.

**Measured on the best transcript available** (large-v3-turbo, full file):

| | words | fillers | rate |
|---|---|---|---|
| human reference | 2633 | 168 | 6.4% |
| large-v3-turbo | 2229 | **17** | **0.8%** |

**Whisper's best model emits 10.1% of the disfluencies that were spoken.** So:

- **"Hide fillers" is trivially possible** — post-processing on a stored transcript,
  reversible, costs nothing.
- **"Keep fillers" is not possible at all.** The words were never transcribed and no
  post-processing restores them. A toggle offering it would be a lie.
- **Worse than absent**: a researcher comparing filler rates between speakers would get a
  confident number from a 10% sample captured non-uniformly. That is not a degraded finding,
  it is a false one.

### The one lever, and why it is not available either

Whisper's documented way to bias toward verbatim output is `prompt_ids` — prompt the decoder
with disfluent text so it continues in that style. transformers.js 4.3.1 **declares the
field in its generation-config type and does not implement the helper**: `get_prompt_ids`
appears exactly once, in a doc comment, and `prompt_ids` is read nowhere in the code. The
destructure that would consume it is commented out in favour of `...kwargs`, so hand-built
token IDs *might* reach generation — unverified, and a spike of its own.

### What this means for the product

Store whatever the model emits, verbatim, and filter at VIEW time rather than at
transcription time — filtering on the way in is irreversible, and this project already holds
that line elsewhere ([[no-inplace-replace]], output outlives its maker). Offer "hide
disfluencies" as a display option. Do **not** offer a verbatim or filler-retention mode, and
**say so where a researcher will see it**: auto-transcription here is not verbatim, it
captures about a tenth of disfluencies, and anyone studying them should import their own
transcript — a path the product already treats as first-class.

## Cross-device: the numbers are not close, they are identical

The owner repeated the full-file measurement on their phone - `small`, one worker, 17.7
minutes - to see whether the figures hold across devices and browser engines.

| | WER | no fillers | sub | del | ins | hyp | uniq | recall | x real |
|---|---|---|---|---|---|---|---|---|---|
| phone, Safari/WebKit, **1 worker** | 32.7% | 28.6% | 255 | 471 | 136 | 2298 | 0.245 | 79.1% | 1.4 |
| desktop, Chrome/Blink, **3 workers** | 32.7% | 28.6% | 255 | 471 | 136 | 2298 | 0.245 | 79.1% | 2.9 |

**Every figure matches** - the same transcript, across different CPU architectures, browser
engines and worker counts. ONNX q8 inference is deterministic, and worker count does not
affect output at all (independently confirmed: one and two workers on the decode path both
gave 36.7% and 259 words on a two-minute sample).

Only speed differs. Per worker the phone is now slightly SLOWER than the desktop, reversing
the 1.87x advantage it held with `tiny` - consistent with memory bandwidth mattering more
as the weights grow sixfold, and with the phone being warm after twelve minutes of load.

### That identity depended on not decoding the audio

Reading 16-bit PCM directly instead of through the browser's decoder is what made this
comparison clean. On the decode path the same desktop scored **31.2%**, so **1.5 points was
the browser's audio decoder** rather than anything about the device. A fixed divide by
32768 is identical on every engine; each decoder is its own black box, and engine is the
variable a cross-engine comparison must not contain.

## A third of the "errors" were never recognition failures

The error breakdown makes the number interpretable for the first time.

**Most-missed words**: `um x69, yeah x31, uh x25, mm x22, hmm x19, like x12, so x11, a x10,
okay x9, know x9`. Almost the entire head of that list is fillers and backchannels.

**Most-misheard**: `gonna -> to x10, five -> 25 x5, dunno -> know x4, favourite -> favorite
x3, okay -> ok x2, alright -> right x2, fifty -> 1250 x2`. British spelling, digits against
words, and colloquial contractions - not one of them a mishearing.

Standard ASR practice normalises both sides before scoring, and Whisper ships a normaliser
for exactly this. Applied to the full transcript:

| | WER | accuracy | errors |
|---|---|---|---|
| as scored | 32.7% | 67.3% | 862 |
| ignoring fillers | 28.6% | 71.4% | 704 |
| **normalised** | **30.2%** | **69.8%** | 802 |
| **normalised, ignoring fillers** | **26.0%** | **74.0%** | 646 |

So on the hardest free benchmark available - four people interrupting each other - `small`
reads 74% accurate once spelling and disfluencies are set aside, against a raw 67.3%.

The normaliser is verified to collapse only non-errors: `gonna`/`going to`, `twenty five`/`25`,
`favourite`/`favorite` all agree, while `craig`/`greg` and `five`/`four` stay distinct, so
real errors are not being hidden.

### Still visibly wrong, and not ours

A whole clause appears duplicated in the transcript (`DO YOU WANT TO INTRODUCE YOURSELF
AGAIN HI IM LAURA AND IM THE PROJECT MANAGER`). That is Whisper's own 30-second chunking
with `stride_length_s: 5` failing to dedupe its overlap - our segmentation ran with none.
It accounts for a visible share of the 136 insertions and is worth chasing separately.

## Video files work, and nobody had checked

ETHN has faculty working from video recordings of oral histories, so "does this take an
MP4" is a real question. There is no video importer — the plugin named in `core/app.js`'s
comments (#139) does not exist — so the only path is `decodeAudio`, and that turns out to
be enough.

`decodeAudioData` **demuxes the container and decodes the audio track**. Verified against a
real film rather than assumed:

| | |
|---|---|
| input | 45.9 MB MP4, H.264 video track (`avc1`) + AAC audio (`mp4a`) |
| decoded | **663.3 s = 11.06 min**, against a published running time of 664.03 s |
| peak amplitude | 0.0223 — real audio, not a silent track |
| time | 1.6 s |

So MP4, M4V, MOV and WebM carrying speech need no extraction step. What fails is whatever
the browser itself cannot decode — MKV and AVI are the usual disappointments — and that
fails as a plain throw rather than silently.

The caveat is the one already known: the whole file is decoded into memory. Eleven minutes
is 42 MB of Float32; a two-hour video is ~460 MB on top of the file itself. Video files are
large to begin with, so this is where segmentation stops being an optimisation.

### A latent bug the test found

`decodeAudio` passed an `ArrayBuffer` straight to `decodeAudioData`, which **detaches** it,
while a TypedArray argument was copied first and survived. The asymmetry bites on the
SECOND attempt: a caller retrying a failed decode with the same ArrayBuffer hands over an
empty one and gets the browser's "Unable to decode audio data", which blames the file. It
now throws a sentence that says what happened and what to do instead.

## Stitching: the machinery we were about to build is not needed

Segmenting an interview was already known to be free on time and necessary for memory. What
had never been measured is what it costs at the SEAMS — a word cut mid-utterance is lost,
and overlapping the segments to avoid that duplicates the shared seconds instead. Four
rules, scored against the AMI human transcript on identical audio (base, 120 s segments,
same five minutes):

| strategy | WER | sub | del | ins |
|---|---|---|---|---|
| **plain cut, no overlap** | **37.3%** | 100 | 101 | **21** |
| silence-snapped cut (±2 s to the quietest moment) | 37.8% | 93 | 110 | 22 |
| 8 s overlap + timestamp trim + repeated-run drop | 38.2% | 102 | 99 | 26 |
| 8 s overlap + timestamp trim | 38.3% | 108 | 95 | 25 |
| 8 s overlap + repeated-run drop | 41.2% | 105 | 95 | 45 |
| 8 s overlap, naive concatenation | 41.3% | 111 | 91 | 44 |

**The deduplication works and still loses.** Timestamp trimming plus a word-level
repeated-run drop takes insertions from 44 down to 26, against 21 for not overlapping at
all — so it removes most of what overlap duplicates. It just never earns back the cost:
the words rescued at a boundary (deletions 101 -> 99) are fewer than the errors overlap
introduces. The same ordering held on the full file, more strongly (37.7% against 45.3%).

Snapping the cut to the quietest moment nearby — the obvious way to avoid cutting mid-word
without any overlap — also failed to help: substitutions fell (100 -> 93) but deletions rose
(101 -> 110), for a net slightly worse and well inside noise.

So the implementation is the one with nothing in it: **cut at a fixed interval, no overlap,
no deduplication, no silence detection.**

### Why timestamp trimming could not fully work

Diagnosed rather than assumed. Whisper returns chunks, not words, and a chunk straddles the
boundary: segment 0 of a 128-second slice had its last chunk START at 118.86 s, so trimming
"chunks beginning after 120 s" kept it whole, and its text ran several seconds into
territory the next segment also covered. Chunk granularity is simply coarser than the trim
needs to be. Word-level timestamps would fix it, and Whisper does not give them.

## Segmentation is now wired in

`core/transcribe.js` splits anything over 180 seconds into 120-second segments and runs
them through the pool. Measured end to end through the shipping service on the real AMI
recording:

- **283 chunks, 0 out of order** across 11 segment boundaries — the timestamp offsets are
  right, which matters because WebVTT cues and speaker alignment both depend on them.
- Covers 0 to 1275 s of a 1272.6 s recording.
- **A single interview now uses the pool**: the probe climbed 1 -> 2 -> 3 while transcribing
  one file, which was impossible before — segments are jobs, and a long file is a queue.
- **Progress is real**: "Transcribing — part 7 of 11" instead of a clock and an estimate.

Speakers are deliberately NOT segmented. Identity is global, so clustering each segment
separately would make "Speaker 1" a different person in every one. The speakers pass runs
once over the whole recording and the transcribed segments are matched to its turns
afterwards — which is what the worker already did internally, moved out one level.

## Still unmeasured

- **All of the above on a phone.** Every whole-interview number here is desktop. The
  phone has never run long-form with the shipping options, so its true cost per hour of
  audio is unknown — and the old 17x figure was measured without timestamps, which alone
  accounts for 2.9x.
- **Thermal behaviour.** Still open, and now easier to provoke: real long-form work is
  2.9x more expensive than the clip runs that finished in 1.6 minutes.
- **Whether a streamer gives progress and cancellation inside one long call**, which would
  remove the strongest non-speed argument for segmenting.
- **Stitch quality.** Splitting measured free and 1.71x faster, but the spike does not
  reconcile text across segment boundaries: a word cut mid-utterance and duplicated overlap
  text are real problems that a shipping implementation has to solve.
- **Accuracy and speaker detection.** Nothing has measured either. The AMI fixture carries
  the ground truth needed for both.
- **Per-worker memory on iOS.** Not merely unmeasured but unmeasurable. The desktop's
  219 MB is the only figure we will get; whether a phone's arenas match is something only
  a crash will tell us — and one did, at worker 4.
- **`base` and `small`.** `WORKER_MB` scales them from their download size, which the
  linearity result makes plausible and nothing has checked.
- **An identical-clip comparison across devices.** The fingerprint makes it checkable;
  nobody has yet run the phone and the desktop on matching fingerprints, so every
  phone-vs-desktop ratio quoted so far rests on an assumption the fit above undermines.
- **The bigger models.** `base` and `small` are priced in the pool by scaling from their
  download, which assumes the arena cost is mostly fixed. Worth checking before anyone
  runs four `small` workers.

