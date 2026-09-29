// The world-independent half of the glue: the value queue JS and C exchange
// primitives through, string conversion, and the export entry/exit protocol.
// Included by the generated glue.c after Porffor's output (built with PORF_NO_MAIN and
// PORF_GC_DEFER), so it can use Porffor's runtime (porf_box, porf_alloc, MEM, ...).

static void rt_import(int id);

static PORF_NORETURN void rt_fail(const char* what) {
  // (fputs, not fprintf: printf's formatter would be most of libc's code in a component)
  fputs("porffor component glue: ", stderr);
  fputs(what, stderr);
  fputs("\n", stderr);
  abort();
}

// ---- the queue ----
// One sequence of jsvals, written from index 0 and read from index 0. Every call
// resets it before writing (rtQ in JS, rt_reset in C), and each side reads what
// the other wrote in full before it writes again.

static jsval* rt_q = NULL;
static u32 rt_n = 0, rt_cap = 0, rt_i = 0;

static void rt_reset(void) { rt_n = 0; rt_i = 0; }

static void rt_push(jsval v) {
  if (rt_n == rt_cap) {
    rt_cap = rt_cap ? rt_cap * 2 : 256;
    rt_q = realloc(rt_q, (size_t)rt_cap * sizeof(jsval));
    if (!rt_q) rt_fail("out of memory growing the queue");
  }
  rt_q[rt_n++] = v;
}

static jsval rt_pop(void) {
  if (rt_i >= rt_n) rt_fail("read past the end of the queue (JS and C disagree on a type)");
  return rt_q[rt_i++];
}

// ---- primitives ----

static f64 rt_pop_num(void) {
  const jsval v = rt_pop();
  if (porf_jv_is_num(v)) return v.val;
  if (v.type == 2) return v.val;  // boolean
  if (v.type == 0) return 0;      // undefined
  rt_fail("expected a number");
}

static bool rt_pop_bool(void) { return porf_truthy(rt_pop()) != 0; }

static void rt_push_num(f64 d) { rt_push(porf_box_num(d)); }
static void rt_push_bool(bool b) { rt_push(porf_box(b ? 1 : 0, 2)); }

// ---- strings: Porffor (Latin-1 byte strings or UTF-16) <-> UTF-8 ----

/** A Porffor string -> freshly malloc'd UTF-8. */
static void rt_pop_string(uint8_t** ptr, size_t* out_len) {
  const jsval v = rt_pop();
  if (v.type != 195 && v.type != 67) rt_fail("expected a string");
  const u32 p = (u32)v.val;
  const u32 len = *(u32*)(MEM + p);
  uint8_t* buf;
  size_t n = 0;
  if (v.type == 195) {  // one byte per char, Latin-1
    buf = malloc((size_t)len * 2 + 1);
    for (u32 i = 0; i < len; i++) {
      const u8 c = MEM[p + 4 + i];
      if (c < 0x80) buf[n++] = c;
      else { buf[n++] = 0xC0 | (c >> 6); buf[n++] = 0x80 | (c & 0x3F); }
    }
  } else {  // UTF-16 code units
    const u16* s = (const u16*)(MEM + p + 4);
    buf = malloc((size_t)len * 3 + 1);
    for (u32 i = 0; i < len; i++) {
      u32 cp = s[i];
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < len && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF)
        cp = 0x10000 + ((cp - 0xD800) << 10) + (s[++i] - 0xDC00);
      else if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;  // lone surrogate
      if (cp < 0x80) buf[n++] = cp;
      else if (cp < 0x800) { buf[n++] = 0xC0 | (cp >> 6); buf[n++] = 0x80 | (cp & 0x3F); }
      else if (cp < 0x10000) {
        buf[n++] = 0xE0 | (cp >> 12); buf[n++] = 0x80 | ((cp >> 6) & 0x3F); buf[n++] = 0x80 | (cp & 0x3F);
      } else {
        buf[n++] = 0xF0 | (cp >> 18); buf[n++] = 0x80 | ((cp >> 12) & 0x3F);
        buf[n++] = 0x80 | ((cp >> 6) & 0x3F); buf[n++] = 0x80 | (cp & 0x3F);
      }
    }
  }
  *ptr = buf;
  *out_len = n;
}

/** UTF-8 -> a new Porffor string (a byte string when Latin-1 fits, UTF-16 otherwise). */
static void rt_push_string(const uint8_t* s, size_t len) {
  int ascii = 1;
  for (size_t i = 0; i < len; i++) if (s[i] >= 0x80) { ascii = 0; break; }
  if (ascii) {
    const u32 p = porf_bstr_new((u32)len);
    memcpy(MEM + p + 4, s, len);
    rt_push(porf_box((f64)p, 195));
    return;
  }
  // At most one UTF-16 unit per UTF-8 byte.
  u16* tmp = malloc(len * 2);
  u32 n = 0;
  for (size_t i = 0; i < len;) {
    u32 c = s[i], cp, extra;
    if (c < 0x80) { cp = c; extra = 0; }
    else if ((c >> 5) == 6) { cp = c & 0x1F; extra = 1; }
    else if ((c >> 4) == 14) { cp = c & 0x0F; extra = 2; }
    else { cp = c & 0x07; extra = 3; }
    for (u32 k = 1; k <= extra && i + k < len; k++) cp = (cp << 6) | (s[i + k] & 0x3F);
    i += 1 + extra;
    if (cp >= 0x10000) { cp -= 0x10000; tmp[n++] = 0xD800 + (cp >> 10); tmp[n++] = 0xDC00 + (cp & 0x3FF); }
    else tmp[n++] = (u16)cp;
  }
  const u32 p = porf_alloc(4 + n * 2, 67);
  *(u32*)(MEM + p) = n;
  memcpy(MEM + p + 4, tmp, (size_t)n * 2);
  free(tmp);
  rt_push(porf_box((f64)p, 67));
}

/** A one-character string -> its code point. */
static uint32_t rt_pop_char(void) {
  uint8_t* s;
  size_t n;
  rt_pop_string(&s, &n);
  uint32_t cp = 0;
  if (n) {
    const u32 c = s[0];
    const u32 extra = c < 0x80 ? 0 : (c >> 5) == 6 ? 1 : (c >> 4) == 14 ? 2 : 3;
    cp = extra == 0 ? c : extra == 1 ? (c & 0x1F) : extra == 2 ? (c & 0x0F) : (c & 0x07);
    for (u32 k = 1; k <= extra && k < n; k++) cp = (cp << 6) | (s[k] & 0x3F);
  }
  free(s);
  return cp;
}

static void rt_push_char(uint32_t cp) {
  uint8_t b[4];
  size_t n;
  if (cp < 0x80) { b[0] = cp; n = 1; }
  else if (cp < 0x800) { b[0] = 0xC0 | (cp >> 6); b[1] = 0x80 | (cp & 0x3F); n = 2; }
  else if (cp < 0x10000) { b[0] = 0xE0 | (cp >> 12); b[1] = 0x80 | ((cp >> 6) & 0x3F); b[2] = 0x80 | (cp & 0x3F); n = 3; }
  else { b[0] = 0xF0 | (cp >> 18); b[1] = 0x80 | ((cp >> 12) & 0x3F); b[2] = 0x80 | ((cp >> 6) & 0x3F); b[3] = 0x80 | (cp & 0x3F); n = 4; }
  rt_push_string(b, n);
}

// ---- what js/rt.mjs's functions call (Porffor.c) ----

jsval rt_js_Q(void) { rt_reset(); return JV_UNDEFINED; }
jsval rt_js_P(jsval v) { rt_push(v); return JV_UNDEFINED; }
jsval rt_js_R(void) { return rt_pop(); }
jsval rt_js_Imp(jsval id) {
  rt_import((int)(porf_jv_is_num(id) ? id.val : -1));
  return JV_UNDEFINED;
}
// RT_JSVAL's two cases (js/rt.mjs): a parameter as it is, or a number Porffor unboxed
jsval rt_jsval(jsval v) { return v; }
jsval rt_jsnum(f64 v) { return porf_box_num(v); }

// ---- export entry and exit ----

static int rt_ready = 0;
static char* rt_argv[] = {"guest", NULL};

// In an async world, stdout and stderr are streams: a write waits on the host, which a sync
// export cannot (the host may run the wait as a suspending call). So the console writes
// into memory (PORF_CONSOLE_FILES: two open_memstream files, growing as needed, never a
// host call), and an async export's loop writes that out (rt_stdio_flush): what a sync
// export prints goes out when the next async one runs.
#ifdef RT_ASYNC
FILE* porf_console_out = NULL;
FILE* porf_console_err = NULL;
static char *rt_out_text = NULL, *rt_err_text = NULL;
static size_t rt_out_len = 0, rt_err_len = 0;

/** A console file: an empty memory stream. */
static FILE* rt_console_open(char** text, size_t* len) {
  FILE* f = open_memstream(text, len);
  if (!f) rt_fail("out of memory opening the console");
  return f;
}

/** Writes out what a console file holds, and gives it a fresh one. */
static void rt_console_drain(FILE** f, char** text, size_t* len, FILE* to) {
  fflush(*f);
  if (*len == 0) return;
  fclose(*f);
  fwrite(*text, 1, *len, to);
  free(*text);
  *text = NULL;
  *len = 0;
  *f = rt_console_open(text, len);
}

/** The console's output so far to stdout and stderr (an async export's loop only). */
static void rt_stdio_flush(void) {
  rt_console_drain(&porf_console_out, &rt_out_text, &rt_out_len, stdout);
  rt_console_drain(&porf_console_err, &rt_err_text, &rt_err_len, stderr);
  fflush(stdout);
  fflush(stderr);
}
#endif

/** Starts the program (porf_start: Porffor's runtime and data, then its top level). */
static void rt_init(void) {
  rt_ready = 1;
#ifdef RT_ASYNC
  porf_console_out = rt_console_open(&rt_out_text, &rt_out_len);
  porf_console_err = rt_console_open(&rt_err_text, &rt_err_len);
#endif
  porf_start(1, rt_argv);
}

/**
 * Every export starts here. The host has just called in, so nothing of the guest is
 * on the wasm stack: this frame is the stack top for the conservative scan, and a
 * deferred collection is safe (all guest state is reachable from globals).
 */
#define ENTER()                              \
  volatile int rt_anchor_ = 0;              \
  porf_c_stack_top = (void*)&rt_anchor_;    \
  if (!rt_ready) rt_init();                \
  else porf_gc_run_pending()

/**
 * Every export ends here: the microtask checkpoint, then stdio. Porffor only drains
 * its job queue at the end of the top-level program, so jobs queued by an export would
 * otherwise never run; and a component never exits, so buffered output would never be
 * written.
 */
#ifdef RT_ASYNC
// a sync export also delivers whatever async work finished meanwhile (starting none of it:
// see rt_async_poll_with), and leaves the console to the next async export (rt_stdio_flush)
static void rt_async_deliver(void);
static void rt_drain_yields(void);
#define LEAVE() (porf_run_jobs(), rt_async_deliver(), rt_drain_yields())
#else
#define LEAVE() (porf_run_jobs(), fflush(stdout), fflush(stderr))
#endif
