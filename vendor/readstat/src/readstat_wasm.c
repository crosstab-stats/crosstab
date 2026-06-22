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
#include <math.h>
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

/* Ask JS whether to keep this variable (1) or skip it (0). Lets the caller import
 * only a chosen subset of columns — the value handler is never called for skipped
 * ones, so the result is narrow. Defaults to keep-all when no filter is set. */
EM_JS(int, ct_js_keep_var, (int index, const char *name), {
  return Module.ctKeepVar ? Module.ctKeepVar(index, name ? UTF8ToString(name) : '') : 1;
});

static int meta_handler(readstat_metadata_t *m, void *ctx) {
  (void)ctx;
  ct_js_metadata(readstat_get_row_count(m), readstat_get_var_count(m), readstat_get_file_encoding(m));
  return READSTAT_HANDLER_OK;
}

static int variable_handler(int index, readstat_variable_t *v, const char *val_labels, void *ctx) {
  (void)ctx;
  if (!ct_js_keep_var(index, readstat_variable_get_name(v)))
    return READSTAT_HANDLER_SKIP_VARIABLE;
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

/* =========================================================================
 * Write path — symmetric to read. The worker drives it in three phases so the
 * data can STREAM (one DuckDB batch at a time, bounded memory):
 *   ct_write_begin(format, rows)  → init writer, pull the schema from JS, header
 *   ct_write_batch(nrows)         → write one in-memory batch (called repeatedly)
 *   ct_write_end()                → finalise
 * ReadStat's data-writer callback hands us output bytes, which we push to JS
 * (ctwSink) where a synchronous OPFS access handle streams them to disk — so a
 * multi-GB output never sits in the heap. The writer state lives in statics across
 * the synchronous batch calls; JS fetches the next batch (async) between them.
 * ========================================================================= */
static readstat_writer_t *g_writer = NULL;
static readstat_variable_t **g_wvars = NULL;
static int g_wnvars = 0;

/* Schema pulled from JS (the worker serves these from the dataset metadata). */
EM_JS(int, ctw_nvars, (void), { return Module.ctwNVars(); });
EM_JS(int, ctw_var_type, (int i), { return Module.ctwVarType(i); });   /* 1=double, 0=string */
EM_JS(int, ctw_var_width, (int i), { return Module.ctwVarWidth(i); }); /* string storage width */
EM_JS(char *, ctw_var_name, (int i), { return stringToNewUTF8(Module.ctwVarName(i)); });
EM_JS(char *, ctw_var_label, (int i), { return stringToNewUTF8(Module.ctwVarLabel(i)); });
EM_JS(int, ctw_var_measure, (int i), { return Module.ctwVarMeasure(i); }); /* 0 none,1,2,3 */
EM_JS(int, ctw_var_nlabels, (int i), { return Module.ctwVarNLabels(i); });
EM_JS(int, ctw_label_is_string, (int i), { return Module.ctwLabelIsString(i); });
EM_JS(double, ctw_label_dval, (int i, int j), { return Module.ctwLabelDval(i, j); });
EM_JS(char *, ctw_label_sval, (int i, int j), { return stringToNewUTF8(Module.ctwLabelSval(i, j)); });
EM_JS(char *, ctw_label_text, (int i, int j), { return stringToNewUTF8(Module.ctwLabelText(i, j)); });
EM_JS(int, ctw_var_nmissing, (int i), { return Module.ctwVarNMissing(i); });
EM_JS(double, ctw_missing_lo, (int i, int j), { return Module.ctwMissingLo(i, j); });
EM_JS(double, ctw_missing_hi, (int i, int j), { return Module.ctwMissingHi(i, j); });

/* Per-cell data for the current batch (NaN double / null string → missing). */
EM_JS(double, ctw_cell_double, (int c, int r), { return Module.ctwCellDouble(c, r); });
EM_JS(char *, ctw_cell_string, (int c, int r), {
  var s = Module.ctwCellString(c, r);
  return s == null ? 0 : stringToNewUTF8(s);
});

/* Output sink: hand `len` bytes at heap `ptr` to JS (synchronous OPFS write). */
EM_JS(void, ctw_sink, (const char *ptr, int len), { Module.ctwSink(HEAPU8.subarray(ptr, ptr + len)); });

static ssize_t ct_data_writer(const void *data, size_t len, void *ctx) {
  (void)ctx;
  ctw_sink((const char *)data, (int)len);
  return (ssize_t)len;
}

/* format: 0=sav 1=dta 3=por 4=xport. row_count is the total (header needs it). */
EMSCRIPTEN_KEEPALIVE
int ct_write_begin(int format, double row_count) {
  g_writer = readstat_writer_init();
  readstat_set_data_writer(g_writer, ct_data_writer);
  int n = ctw_nvars();
  g_wnvars = n;
  g_wvars = (readstat_variable_t **)malloc(sizeof(readstat_variable_t *) * (n > 0 ? n : 1));
  for (int i = 0; i < n; i++) {
    int isDouble = ctw_var_type(i);
    char *name = ctw_var_name(i);
    size_t width = isDouble ? 0 : (size_t)(ctw_var_width(i) > 0 ? ctw_var_width(i) : 1);
    readstat_variable_t *v =
        readstat_add_variable(g_writer, name, isDouble ? READSTAT_TYPE_DOUBLE : READSTAT_TYPE_STRING, width);
    char *label = ctw_var_label(i);
    if (label && label[0]) readstat_variable_set_label(v, label);
    int meas = ctw_var_measure(i);
    if (meas >= 1 && meas <= 3) readstat_variable_set_measure(v, (readstat_measure_t)meas);
    int nl = ctw_var_nlabels(i);
    if (nl > 0) {
      int isStr = ctw_label_is_string(i);
      readstat_label_set_t *ls =
          readstat_add_label_set(g_writer, isStr ? READSTAT_TYPE_STRING : READSTAT_TYPE_DOUBLE, name);
      for (int j = 0; j < nl; j++) {
        char *tx = ctw_label_text(i, j);
        if (isStr) {
          char *sv = ctw_label_sval(i, j);
          readstat_label_string_value(ls, sv, tx);
          free(sv);
        } else {
          readstat_label_double_value(ls, ctw_label_dval(i, j), tx);
        }
        free(tx);
      }
      readstat_variable_set_label_set(v, ls);
    }
    int nm = ctw_var_nmissing(i);
    for (int j = 0; j < nm; j++) {
      double lo = ctw_missing_lo(i, j), hi = ctw_missing_hi(i, j);
      if (lo == hi) readstat_variable_add_missing_double_value(v, lo);
      else readstat_variable_add_missing_double_range(v, lo, hi);
    }
    g_wvars[i] = v;
    free(name);
    free(label);
  }
  readstat_error_t err;
  long rc = (long)row_count;
  switch (format) {
    case 0: err = readstat_begin_writing_sav(g_writer, NULL, rc); break;
    case 1: err = readstat_begin_writing_dta(g_writer, NULL, rc); break;
    case 3: err = readstat_begin_writing_por(g_writer, NULL, rc); break;
    case 4: err = readstat_begin_writing_xport(g_writer, NULL, rc); break;
    default: err = READSTAT_ERROR_WRITE; break;
  }
  return (int)err;
}

EMSCRIPTEN_KEEPALIVE
int ct_write_batch(int nrows) {
  for (int r = 0; r < nrows; r++) {
    readstat_error_t e = readstat_begin_row(g_writer);
    if (e != READSTAT_OK) return (int)e;
    for (int c = 0; c < g_wnvars; c++) {
      readstat_variable_t *v = g_wvars[c];
      if (readstat_variable_get_type(v) == READSTAT_TYPE_STRING) {
        char *s = ctw_cell_string(c, r);
        if (s == 0) {
          readstat_insert_missing_value(g_writer, v);
        } else {
          readstat_insert_string_value(g_writer, v, s);
          free(s);
        }
      } else {
        double d = ctw_cell_double(c, r);
        if (isnan(d)) readstat_insert_missing_value(g_writer, v);
        else readstat_insert_double_value(g_writer, v, d);
      }
    }
    e = readstat_end_row(g_writer);
    if (e != READSTAT_OK) return (int)e;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int ct_write_end(void) {
  readstat_error_t err = g_writer ? readstat_end_writing(g_writer) : READSTAT_ERROR_WRITER_NOT_INITIALIZED;
  if (g_writer) readstat_writer_free(g_writer);
  g_writer = NULL;
  if (g_wvars) {
    free(g_wvars);
    g_wvars = NULL;
  }
  g_wnvars = 0;
  return (int)err;
}
