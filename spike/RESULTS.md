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
