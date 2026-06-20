#!/usr/bin/env bash
# Build ReadStat -> WASM (read path) as an ES6 module.
set -e
cd "$(dirname "$0")"

source /c/Users/Ryan/ct-wasm-build/emsdk/emsdk_env.sh >/dev/null 2>&1

RS=/c/Users/Ryan/ct-wasm-build/ReadStat
# read-side sources only (drop per-format *_write.c; keep readstat_writer.c core)
SRCS=$(ls "$RS"/src/*.c "$RS"/src/spss/*.c "$RS"/src/stata/*.c "$RS"/src/sas/*.c | grep -vE '_write\.c$')

mkdir -p dist

emcc \
  $SRCS readstat_wasm.c \
  -I "$RS/src" \
  -O2 \
  -D_FILE_OFFSET_BITS=64 \
  -sUSE_ZLIB=1 \
  -sWASM_BIGINT \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=5MB \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker \
  -sEXPORTED_FUNCTIONS='["_ct_parse","_ct_error_message","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","stringToUTF8","getValue","setValue","HEAPU8"]' \
  -o dist/readstat.mjs

echo "=== BUILD OK ==="
ls -la dist
