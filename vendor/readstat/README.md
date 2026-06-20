# ReadStat → WebAssembly

A WebAssembly build of [ReadStat](https://github.com/WizardMac/ReadStat) (Evan
Miller, **MIT** — see `LICENSE.readstat`) that reads SPSS, Stata and SAS data
files **in the browser**, streaming, with no 2 GB limit.

This is the engine behind R's `haven` and Python's `pyreadstat`, so its metadata
model (variable labels, value labels, user-missing ranges, measure) matches what
CrossTab's `VariableMeta` already expects.

## Why this exists

WebR/`haven` can't read a file larger than R's ~4 GB wasm heap (the full GSS
`.sav`/`.dta` OOMs on whole-file import). This build sidesteps R entirely for
ingest: it reads the file in `File.slice()` chunks via a custom IO handler, so
nothing larger than a small buffer is ever in memory, and emits schema + rows
through callbacks for batching into OPFS-backed DuckDB.

## What's here

| File | What |
|------|------|
| `readstat.wasm`, `readstat.mjs` | The compiled module (ES6, `web,worker`). |
| `src/readstat_wasm.c` | Glue: custom `open/read/seek/close` IO that calls back to JS (`Module.ctReadAt`), plus metadata/variable/value/value_label callbacks forwarded to `Module.ct*`. Entry point `ct_parse(format, fileSize, rowLimit)`; `rowLimit==0` yields catalog-only (the variable-picker path). |
| `build.sh` | Reference build script (paths are machine-specific). |
| `LICENSE.readstat` | ReadStat's MIT license. |

## Provenance

- ReadStat: `WizardMac/ReadStat` @ `3add3a5eaac6df24d938beffb9148792e362d9ef`
- Emscripten: `emcc 6.0.0`
- Built read-side `.c` only (all `src/*.c`, `src/spss/*.c`, `src/stata/*.c`,
  `src/sas/*.c` except per-format `*_write.c`). zsav support via the bundled
  zlib port.

## Rebuilding

```
emcc <readstat read-side .c> src/readstat_wasm.c \
  -I <ReadStat>/src -O2 \
  -D_FILE_OFFSET_BITS=64 \   # 64-bit readstat_off_t -> seek past 2 GB
  -sUSE_ZLIB=1 \             # zsav ($FL3) support
  -sWASM_BIGINT \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=5MB \         # sav data reader puts a 64 KB buffer on the stack;
                            # Emscripten's default 64 KB stack overflows -> heap corruption
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sEXPORTED_FUNCTIONS='["_ct_parse","_ct_error_message","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8"]' \
  -o readstat.mjs
```

## `format` codes

`0`=sav · `1`=dta · `2`=sas7bdat · `3`=por · `4`=xport

## Validated

Round-tripped haven-written files: SPSS `.sav` and **Stata v118 `.dta`** both
parse with correct variable labels, value labels, types/formats, and
system-missing values — in Node and in the COEP browser. (v118 is the modern
Unicode Stata format the pure-JS readers can't open.)
