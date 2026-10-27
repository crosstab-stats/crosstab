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

## Still unmeasured

### An instrument bug worth remembering

`performance.measureUserAgentSpecificMemory()` **hangs indefinitely in a hidden tab** — it
resolves at a GC checkpoint a backgrounded renderer may never reach. It deadlocked the
desktop run after one worker (90 s for worker 1; the same run with memory skipped did six
workers in six seconds). `measure()` now races a timeout and is skipped entirely when
`document.hidden`. A `setTimeout` guard alone is not enough: timers in a hidden tab are
throttled to about once a minute, so an 8 s guard can take 60 s to fire.

## Still unmeasured

- **The same sweep on a phone, with real audio.** Done on the desktop (above); the phone
  has only run synthetic noise, which flatters concurrency by about 2x. Its 1.8x at two
  workers is likely nearer 1.3x. The file picker in the spike exists for this.
- **Accuracy and speaker detection.** Nothing has measured either. The AMI fixture carries
  the ground truth needed for both.
- **Per-worker memory on iOS.** Not merely unmeasured but unmeasurable. The desktop's
  219 MB is the only figure we will get; whether a phone's arenas match is something only
  a crash will tell us — and one did, at worker 4.
- **`base` and `small`.** `WORKER_MB` scales them from their download size, which the
  linearity result makes plausible and nothing has checked.
- **Sustained load.** Every figure here is a burst of minutes. An hour of audio on a
  throttling phone is still an extrapolation.
- **The bigger models.** `base` and `small` are priced in the pool by scaling from their
  download, which assumes the arena cost is mostly fixed. Worth checking before anyone
  runs four `small` workers.

