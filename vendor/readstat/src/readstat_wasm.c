/*
 * readstat_wasm.c — thin glue exposing ReadStat's read path to JS.
 *
 * IO is fully custom: ReadStat never touches a real filesystem. Its read/seek
 * handlers call back into JS (Module.ctReadAt), which reads File.slice() bytes
 * synchronously via FileReaderSync inside a Worker. Offsets are 64-bit
 * (_FILE_OFFSET_BITS=64 + WASM_BIGINT), so files past 2 GB seek fine.
 *
 * Data is delivered through ReadStat's metadata/variable/value/value_label
 * callbacks, each forwarded to a JS function on Module. (Per-cell calls are fine
 * for correctness; batching can come later if profiling demands it.)
 */
#include <stdlib.h>
#include <stdint.h>
#include <sys/types.h>
#include <emscripten.h>
#include "readstat.h"

/* ---- single-file IO state ---- */
static int64_t g_pos = 0;
static int64_t g_size = 0;

/* JS reads `nbyte` at absolute `pos` into HEAPU8[buf..]; returns bytes read (<0 = error). */
EM_JS(int, ct_js_read, (double pos, char *buf, int nbyte), {
  return Module.ctReadAt(pos, buf, nbyte);
});

static int io_open(const char *path, void *io_ctx) { (void)path; (void)io_ctx; g_pos = 0; return 0; }
static int io_close(void *io_ctx) { (void)io_ctx; return 0; }

static readstat_off_t io_seek(readstat_off_t offset, readstat_io_flags_t whence, void *io_ctx) {
  (void)io_ctx;
  int64_t base = 0;
  if (whence == READSTAT_SEEK_CUR) base = g_pos;
  else if (whence == READSTAT_SEEK_END) base = g_size;
  g_pos = base + (int64_t)offset;
  return (readstat_off_t)g_pos;
}

static ssize_t io_read(void *buf, size_t nbyte, void *io_ctx) {
  (void)io_ctx;
  int got = ct_js_read((double)g_pos, (char *)buf, (int)nbyte);
  if (got < 0) return -1;
  g_pos += got;
  return (ssize_t)got;
}

/* ---- data callbacks -> JS ---- */
EM_JS(void, ct_js_metadata, (int row_count, int var_count, const char *enc), {
  Module.ctMetadata(row_count, var_count, enc ? UTF8ToString(enc) : "");
});
EM_JS(void, ct_js_variable, (int index, const char *name, const char *label, int type,
      const char *format, int measure, const char *label_set), {
  Module.ctVariable(index, UTF8ToString(name), label ? UTF8ToString(label) : "",
    type, format ? UTF8ToString(format) : "", measure, label_set ? UTF8ToString(label_set) : "");
});
EM_JS(void, ct_js_missing_range, (int var_index, double lo, double hi), {
  Module.ctMissingRange(var_index, lo, hi);
});
EM_JS(void, ct_js_value_double, (int obs, int var_index, double v, int is_missing), {
  Module.ctValueDouble(obs, var_index, v, is_missing);
});
EM_JS(void, ct_js_value_string, (int obs, int var_index, const char *v, int is_missing), {
  Module.ctValueString(obs, var_index, v ? UTF8ToString(v) : "", is_missing);
});
EM_JS(void, ct_js_value_label, (const char *label_set, double dval, const char *sval, const char *label), {
  Module.ctValueLabel(UTF8ToString(label_set), dval, sval ? UTF8ToString(sval) : null, UTF8ToString(label));
});

static int meta_handler(readstat_metadata_t *m, void *ctx) {
  (void)ctx;
  ct_js_metadata(readstat_get_row_count(m), readstat_get_var_count(m), readstat_get_file_encoding(m));
  return READSTAT_HANDLER_OK;
}

static int variable_handler(int index, readstat_variable_t *v, const char *val_labels, void *ctx) {
  (void)ctx;
  ct_js_variable(index, readstat_variable_get_name(v), readstat_variable_get_label(v),
    (int)readstat_variable_get_type(v), readstat_variable_get_format(v),
    (int)readstat_variable_get_measure(v), val_labels);
  int n = readstat_variable_get_missing_ranges_count(v);
  for (int i = 0; i < n; i++) {
    readstat_value_t lo = readstat_variable_get_missing_range_lo(v, i);
    readstat_value_t hi = readstat_variable_get_missing_range_hi(v, i);
    ct_js_missing_range(index, readstat_double_value(lo), readstat_double_value(hi));
  }
  return READSTAT_HANDLER_OK;
}

static int value_handler(int obs, readstat_variable_t *v, readstat_value_t value, void *ctx) {
  (void)ctx;
  int vi = readstat_variable_get_index(v);
  /* Only system/tagged missing becomes NA. User-defined (SPSS) missing keeps its
   * raw sentinel value - the variable's missingValues metadata carries the recode
   * intent, matching how the rest of the engine (and haven) treat user-missing. */
  int sysmiss = readstat_value_is_system_missing(value) || readstat_value_is_tagged_missing(value);
  if (readstat_value_type_class(value) == READSTAT_TYPE_CLASS_STRING)
    ct_js_value_string(obs, vi, readstat_string_value(value), sysmiss);
  else
    ct_js_value_double(obs, vi, readstat_double_value(value), sysmiss);
  return READSTAT_HANDLER_OK;
}

static int value_label_handler(const char *val_labels, readstat_value_t value, const char *label, void *ctx) {
  (void)ctx;
  if (readstat_value_type_class(value) == READSTAT_TYPE_CLASS_STRING)
    ct_js_value_label(val_labels, 0.0, readstat_string_value(value), label);
  else
    ct_js_value_label(val_labels, readstat_double_value(value), NULL, label);
  return READSTAT_HANDLER_OK;
}

/*
 * Parse the staged file. format: 0=sav 1=dta 2=sas7bdat 3=por 4=xport.
 * row_limit < 0 means "all rows"; row_limit == 0 yields catalog only
 * (metadata + variables + value labels, no data) — the variable-picker path.
 * Returns a readstat_error_t (0 == OK).
 */
EMSCRIPTEN_KEEPALIVE
int ct_parse(int format, double file_size, int row_limit) {
  g_pos = 0;
  g_size = (int64_t)file_size;

  readstat_parser_t *p = readstat_parser_init();
  readstat_set_open_handler(p, io_open);
  readstat_set_close_handler(p, io_close);
  readstat_set_seek_handler(p, io_seek);
  readstat_set_read_handler(p, io_read);
  readstat_set_metadata_handler(p, meta_handler);
  readstat_set_variable_handler(p, variable_handler);
  readstat_set_value_label_handler(p, value_label_handler);
  if (row_limit != 0) readstat_set_value_handler(p, value_handler);
  if (row_limit >= 0) readstat_set_row_limit(p, row_limit);

  readstat_error_t err;
  const char *path = "file"; /* ignored by our open handler */
  switch (format) {
    case 0: err = readstat_parse_sav(p, path, NULL); break;
    case 1: err = readstat_parse_dta(p, path, NULL); break;
    case 2: err = readstat_parse_sas7bdat(p, path, NULL); break;
    case 3: err = readstat_parse_por(p, path, NULL); break;
    case 4: err = readstat_parse_xport(p, path, NULL); break;
    default: err = READSTAT_ERROR_PARSE; break;
  }
  readstat_parser_free(p);
  return (int)err;
}

EMSCRIPTEN_KEEPALIVE
const char *ct_error_message(int code) { return readstat_error_message((readstat_error_t)code); }
