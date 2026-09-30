import { DTOA } from './dtoa.js';
import {
  T, K, FX, KNames,
  N_KIND, N_TYPE, N_FX, N_A, N_B, N_C,
  FN_ASYNC, FN_GENERATOR, FN_ASYNC_GENERATOR,
  CONVERT_RANGE_KNOWN, CONVERT_SIGNED
} from './ir.js';
import { TYPES, TYPE_NAMES } from './types.js';
import { ieee754_binary64 } from './encoding.js';
import caseTablesC from './case_tables.js';
import { planStackless, hasTry, hasSuspend } from './stackless.js';

// C type per IR value type
const CT = [];
CT[T.none] = 'void';
CT[T.f64] = 'f64';
CT[T.i32] = 'i32';
CT[T.u32] = 'u32';
CT[T.i64] = 'i64';
CT[T.u64] = 'u64';
CT[T.jsval] = 'jsval';
CT[T.ptr] = 'u32';

// C precedence (higher binds tighter)
const P_COMMA = 1, P_TERNARY = 3, P_LOR = 4, P_LAND = 5, P_BOR = 6, P_BXOR = 7,
  P_BAND = 8, P_EQ = 9, P_REL = 10, P_SHIFT = 11, P_ADD = 12, P_MUL = 13,
  P_UNARY = 14, P_CAST = 15, P_POSTFIX = 16, P_PRIM = 17;

const BIN_PREC = {
  '*': P_MUL, '/': P_MUL, '%': P_MUL,
  '+': P_ADD, '-': P_ADD,
  '<<': P_SHIFT, '>>': P_SHIFT,
  '<': P_REL, '<=': P_REL, '>': P_REL, '>=': P_REL,
  '==': P_EQ, '!=': P_EQ,
  '&': P_BAND, '^': P_BXOR, '|': P_BOR,
  '&&': P_LAND, '||': P_LOR
};

const cReservedNames = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  'asm', 'typeof', 'main', '_return',
  'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'jsval',
  'NULL', 'NAN', 'INFINITY',
  'stdin', 'stdout', 'stderr', 'FILE', 'EOF',
  'printf', 'fprintf', 'putchar', 'exit', 'abort', 'atexit', 'getenv',
  'calloc', 'malloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'strlen',
  'log', 'read', 'write', 'close', 'signal', 'time',
  // unistd / posix
  'fork', 'sleep', 'usleep', 'sync', '_exit', 'pipe', 'dup', 'dup2', 'pause',
  'alarm', 'getpid', 'getppid', 'open', 'link', 'unlink', 'access', 'kill', 'raise',
  // stdlib
  'random', 'srandom', 'rand', 'srand', 'system', 'abs', 'labs', 'div', 'ldiv',
  'qsort', 'bsearch', 'atoi', 'atol', 'atof', 'gets', 'remove', 'rename',
  // math (libm)
  'log2', 'log10', 'log1p', 'pow', 'sqrt', 'cbrt', 'exp', 'exp2', 'expm1',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'fabs', 'floor', 'ceil', 'round', 'trunc', 'fmod', 'hypot', 'remainder',
  'clock', 'times', 'gmtime', 'localtime',
  'HUGE', 'HUGE_VAL', 'HUGE_VALF', 'HUGE_VALL', 'MAXFLOAT', 'FP_NAN', 'FP_INFINITE', 'FP_ZERO', 'FP_NORMAL', 'FP_SUBNORMAL',
  'M_E', 'M_LOG2E', 'M_LOG10E', 'M_LN2', 'M_LN10', 'M_PI', 'M_PI_2', 'M_PI_4', 'M_1_PI', 'M_2_PI', 'M_2_SQRTPI', 'M_SQRT2', 'M_SQRT1_2', 'errno',
  // string.h / strings.h (index is the big one: legacy strchr alias)
  'index', 'rindex', 'bcopy', 'bzero', 'bcmp', 'ffs', 'ffsl', 'ffsll', 'fls', 'flsl', 'flsll',
  'strcasecmp', 'strncasecmp', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strchr', 'strrchr', 'strstr', 'strtok', 'strdup', 'strndup', 'strerror', 'strspn', 'strcspn',
  'strpbrk', 'strcoll', 'strxfrm', 'strsep', 'stpcpy', 'stpncpy', 'strnlen', 'strlcpy', 'strlcat',
  'memchr', 'memcmp', 'memccpy', 'swab',
  // stdio
  'puts', 'fputs', 'fgets', 'fgetc', 'fputc', 'getc', 'putc', 'getchar', 'scanf', 'sscanf',
  'fscanf', 'snprintf', 'sprintf', 'vsnprintf', 'vsprintf', 'vprintf', 'vfprintf', 'fopen',
  'freopen', 'fclose', 'fread', 'fwrite', 'fseek', 'fseeko', 'ftell', 'ftello', 'rewind',
  'perror', 'tmpfile', 'tmpnam', 'setbuf', 'setvbuf', 'fflush', 'ungetc', 'feof', 'ferror',
  'clearerr', 'fileno', 'fdopen', 'popen', 'pclose',
  // setjmp / errno / predefined macros
  'setjmp', 'longjmp', '_setjmp', '_longjmp', 'sigsetjmp', 'siglongjmp', 'errno',
  'bool', 'true', 'false', 'unix', 'linux',
  // stdlib
  'strtol', 'strtoul', 'strtoll', 'strtoull', 'strtod', 'strtof', 'strtold', 'mblen', 'mbtowc',
  'wctomb', 'mbstowcs', 'wcstombs', 'realpath', 'mkstemp', 'mkdtemp', 'mktemp', 'setenv',
  'unsetenv', 'putenv', 'posix_memalign', 'aligned_alloc', 'arc4random', 'valloc', 'alloca',
  // math (libm) continued
  'acosh', 'asinh', 'atanh', 'erf', 'erfc', 'tgamma', 'lgamma', 'fmax', 'fmin', 'fma', 'fdim',
  'copysign', 'nearbyint', 'rint', 'lrint', 'llrint', 'lround', 'llround', 'frexp', 'ldexp',
  'modf', 'scalbn', 'scalbln', 'ilogb', 'logb', 'nan', 'nanf', 'nextafter', 'nexttoward',
  'remquo', 'j0', 'j1', 'jn', 'y0', 'y1', 'yn', 'gamma', 'drem', 'finite', 'significand',
  // signal
  'sigaction', 'sigaddset', 'sigdelset', 'sigemptyset', 'sigfillset', 'sigismember',
  'sigprocmask', 'sigsuspend', 'sigpending', 'sigwait', 'killpg', 'psignal',
  // unistd / posix continued
  'lseek', 'chdir', 'fchdir', 'getcwd', 'isatty', 'ttyname', 'execv', 'execve', 'execvp',
  'execl', 'execlp', 'execle', 'getuid', 'geteuid', 'getgid', 'getegid', 'setuid', 'setgid',
  'seteuid', 'setegid', 'getpgrp', 'setpgid', 'setsid', 'getsid', 'truncate', 'ftruncate',
  'rmdir', 'chown', 'fchown', 'lchown', 'readlink', 'symlink', 'nice', 'crypt', 'encrypt',
  'brk', 'sbrk', 'gethostname', 'sethostname', 'getlogin', 'fsync', 'fdatasync', 'pread',
  'pwrite', 'environ', 'getopt', 'optarg', 'optind', 'opterr', 'optopt', 'confstr', 'pathconf',
  'fpathconf', 'sysconf', 'chroot', 'vfork', 'daemon', 'setgroups', 'getgroups',
  // dirent
  'opendir', 'readdir', 'closedir', 'rewinddir', 'seekdir', 'telldir', 'scandir', 'alphasort',
  'dirfd', 'fdopendir',
  // sys/mman, sys/stat, sys/wait
  'mmap', 'munmap', 'mprotect', 'madvise', 'msync', 'mlock', 'munlock', 'mlockall',
  'munlockall', 'mincore', 'shm_open', 'shm_unlink',
  'stat', 'fstat', 'lstat', 'fstatat', 'chmod', 'fchmod', 'fchmodat', 'mkdir', 'mkdirat',
  'mkfifo', 'mknod', 'umask', 'futimens', 'utimensat',
  'wait', 'waitpid', 'wait3', 'wait4',
  // time.h continued
  'mktime', 'ctime', 'asctime', 'strftime', 'strptime', 'difftime', 'timegm', 'timelocal',
  'tzset', 'daylight', 'timezone', 'tzname', 'nanosleep', 'clock_gettime', 'clock_settime',
  'clock_getres', 'ctime_r', 'asctime_r', 'gmtime_r', 'localtime_r', 'gettimeofday',
  // unistd continued (revoke: Proxy.revocable code names its function that)
  'revoke', 'acct', 'getpagesize', 'getdtablesize', 'getpass', 'getusershell', 'setusershell',
  'endusershell', 'ttyslot', 'profil', 'vhangup', 'swapon', 'lockf', 'ctermid', 'tcgetpgrp',
  'tcsetpgrp', 'setlogin', 'issetugid', 'getentropy', 'faccessat', 'fchownat', 'linkat',
  'unlinkat', 'readlinkat', 'symlinkat', 'renameat', 'openat', 'fcntl', 'ioctl', 'select', 'poll',
  // sys/types typedefs without the _t suffix
  'uint', 'ushort', 'ulong', 'u_char', 'u_short', 'u_int', 'u_long', 'u_quad_t', 'quad_t',
  'caddr_t', 'daddr_t', 'fixpt_t', 'register_t', 'segsz_t', 'swblk_t', 'unchar',
  // math.h and assert.h macros spelled in lowercase
  'isnan', 'isinf', 'isfinite', 'isnormal', 'signbit', 'fpclassify', 'isgreater',
  'isgreaterequal', 'isless', 'islessequal', 'islessgreater', 'isunordered', 'assert',
  'offsetof', 'va_arg', 'va_start', 'va_end', 'va_copy', 'va_list', 'noreturn', 'alignas',
  'alignof', 'static_assert', 'complex', 'imaginary',
  // ctype
  'isalnum', 'isalpha', 'isblank', 'iscntrl', 'isdigit', 'isgraph', 'islower', 'isprint',
  'ispunct', 'isspace', 'isupper', 'isxdigit', 'isascii', 'toascii', 'tolower', 'toupper'
]);

// Whole classes of C names a JS name can collide with that no list keeps up with: an
// all-caps name is how C spells a macro (INT32_MIN, UINT32_MAX, EOF, SIG_ERR, and the
// runtime's own MEM), and a name ending in _t is reserved by POSIX for types. Such JS
// names get a prefix of their own in the C
const cCollisionProne = name => /^[A-Z][A-Z0-9_]*$/.test(name) || /_t$/.test(name);

// inlining these has little perf benefit and significantly increases binary size
const NEVER_INLINE = new Set([
  '__Porffor_object_get_ic', '__Porffor_object_get_icMiss', '__Porffor_object_get_withHash',
  // each built-in prototype's getters are added through it (inlined, one per prototype)
  '__Porffor_object_fastAddAccessor',
  // every RegExp getter's guard path
  '__Porffor_regexp_offTypeGetter',
  // an array's species and a result that is not a plain array: rare, and each inlined copy
  // would sit in every array method that can make one
  '__Porffor_object_createDataProperty', '__Porffor_array_speciesConstruct'
]);
// the array methods' steps on a non-array this or for a species (builtins/array_generic.ts):
// the cold side of each method, compiled for size and kept out of its fast one
const coldBuiltin = name => name.startsWith('__Porffor_arrayGeneric_');

// FNV-1a over a string, base 36
const symHash = str => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

const sanitizeMemo = new Map();
const sanitizeUsed = new Set();
export const sanitize = str => {
  const memod = sanitizeMemo.get(str);
  if (memod != null) return memod;

  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const ok = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || code === 95;
    if (ok) out += String.fromCharCode(code);
      else out += '_' + code.toString(16);
  }
  if (out.length === 0) out = 'anon';
  if (out[0] >= '0' && out[0] <= '9') out = '_' + out;
  if (cCollisionProne(out)) out = 'J_' + out;
  // keep prefixing: one '_' can itself collide (exit -> _exit)
  while (cReservedNames.has(out) || sanitizeUsed.has(out)) out = '_' + out;
  sanitizeUsed.add(out);
  sanitizeMemo.set(str, out);
  return out;
};

// jsval encoding constants (must match runtime header below)
const JV_PATTERN = 0xFFF8000000000000n;
const jvConstBits = (typeId, payload) =>
  JV_PATTERN | (BigInt(typeId & 0xFF) << 43n) | BigInt(payload >>> 0);
const JV_ZERO_BITS = jvConstBits(TYPES.number, 0);

// lz4 block format, chained-hash lazy matching (~lz4hc ratio, ~25% smaller than greedy).
// used by --compress-data to shrink the static data image in the binary
const lz4Compress = src => {
  const n = src.length;
  const out = new Uint8Array(n + ((n / 255) | 0) + 16);
  const head = new Uint32Array(1 << 16);
  const prev = new Uint32Array(n);
  const read32 = i => src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
  let op = 0, anchor = 0, i = 0, ins = 0, mLen = 0, mPos = 0;
  const mflimit = n - 12;

  const emitSeq = (litLen, offset, mlen) => {
    out[op++] = (Math.min(litLen, 15) << 4) | (offset === 0 ? 0 : Math.min(mlen - 4, 15));
    if (litLen >= 15) {
      let rest = litLen - 15;
      while (rest >= 255) { out[op++] = 255; rest -= 255; }
      out[op++] = rest;
    }
    for (let k = 0; k < litLen; k++) out[op++] = src[anchor + k];
    if (offset === 0) return;
    out[op++] = offset & 0xff;
    out[op++] = offset >> 8;
    if (mlen - 4 >= 15) {
      let rest = mlen - 4 - 15;
      while (rest >= 255) { out[op++] = 255; rest -= 255; }
      out[op++] = rest;
    }
  };

  const insertTo = limit => {
    while (ins < limit) {
      const h = (Math.imul(read32(ins), 2654435761) >>> 16) & 0xffff;
      prev[ins] = head[h];
      head[h] = ins + 1;
      ins++;
    }
  };

  const findMatch = at => {
    const maxLen = n - 5 - at;
    const minPos = at > 0xffff ? at - 0xffff : 0;
    let cand = head[(Math.imul(read32(at), 2654435761) >>> 16) & 0xffff] - 1;
    let depth = 64;
    mLen = 3;
    while (cand >= minPos && depth > 0) {
      depth--;
      if (src[cand + mLen] === src[at + mLen]) {
        let len = 0;
        while (len < maxLen && src[cand + len] === src[at + len]) len++;
        if (len > mLen) { mLen = len; mPos = cand; }
      }
      cand = prev[cand] - 1;
    }
  };

  while (i <= mflimit) {
    insertTo(i);
    findMatch(i);
    if (mLen < 4) { i++; continue; }
    let len = mLen, pos = mPos;
    while (i + 1 <= mflimit) { // lazy: prefer a longer match starting one byte later
      insertTo(i + 1);
      findMatch(i + 1);
      if (mLen > len) { i++; len = mLen; pos = mPos; }
        else break;
    }
    emitSeq(i - anchor, i - pos, len);
    i += len;
    anchor = i;
  }
  emitSeq(n - anchor, 0, 0);
  return { out, len: op };
};

const LZ4_DECODE = `static void porf_lz4_decode(const u8* src, u32 slen, u8* dst) {
  const u8* send = src + slen;
  while (src < send) {
    u32 token = *src++;
    u32 len = token >> 4;
    if (len == 15) { u32 b; do { b = *src++; len += b; } while (b == 255); }
    memcpy(dst, src, len); dst += len; src += len;
    if (src >= send) break;
    u32 off = src[0] | ((u32)src[1] << 8); src += 2;
    len = (token & 15) + 4;
    if (len == 19) { u32 b; do { b = *src++; len += b; } while (b == 255); }
    const u8* m = dst - off;
    while (len--) *dst++ = *m++;
  }
}

`;

const f64Lit = value => {
  if (Number.isNaN(value)) return 'NAN';
  if (value === Infinity) return 'INFINITY';
  if (value === -Infinity) return '-INFINITY';
  if (value === 0) return 1 / value === -Infinity ? '-0.0' : '0.0';

  const str = value.toString();
  if (Number.isInteger(value) && !/[eE]/.test(str)) return str.includes('.') ? str : str + '.0';

  const bytes = ieee754_binary64(value);
  let hex = '';
  for (let i = 7; i >= 0; i--) hex += bytes[i].toString(16).padStart(2, '0');
  return `porf_bits_to_f64(0x${hex}ull)`;
};

const ALLOC_PROFILE_C = `// PORF_ALLOC_PROFILE: every allocation counted by where it came from, dumped to stderr at
// exit as "ALLOC <site> <allocator> <type> <count> <bytes>": the site is the nearest compiled
// JS function on the stack (its return address, so each call in it is its own site), the
// allocator the C function that called porf_alloc (a builtin, or the site itself). For
// measuring, not shipping: a stack walk per allocation.
#ifdef PORF_ALLOC_PROFILE
#ifndef PORF_AP_DEFINED
#define PORF_AP_DEFINED
#include <execinfo.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct { void* site; void* alloc; u32 type; u64 count, bytes; } porf_ap_entry;
#define PORF_AP_SLOTS 65536u
static porf_ap_entry porf_ap[PORF_AP_SLOTS];
typedef struct { void* addr; int user; } porf_ap_kind;
static porf_ap_kind porf_ap_kinds[PORF_AP_SLOTS];
static int porf_ap_started = 0;
// compiled JS: p_<module>_name or p__main_name, not a builtin (p_builtins_...)
static int porf_ap_is_user(void* addr) {
  const u32 h = (u32)(((uintptr_t)addr >> 2) * 2654435761u) & (PORF_AP_SLOTS - 1u);
  for (u32 i = h;; i = (i + 1u) & (PORF_AP_SLOTS - 1u)) {
    if (porf_ap_kinds[i].addr == addr) return porf_ap_kinds[i].user;
    if (porf_ap_kinds[i].addr == NULL) {
      Dl_info info;
      int user = 0;
      if (dladdr(addr, &info) && info.dli_sname) {
        const char* n = info.dli_sname;
        if (n[0] == '_') n++;
        user = n[0] == 'p' && n[1] == '_' && strncmp(n, "p_builtins", 10) != 0;
      }
      porf_ap_kinds[i].addr = addr;
      porf_ap_kinds[i].user = user;
      return user;
    }
  }
}
static void porf_ap_dump(void) {
  for (u32 i = 0; i < PORF_AP_SLOTS; i++) {
    const porf_ap_entry* e = &porf_ap[i];
    if (e->count == 0) continue;
    Dl_info a, b;
    const char* site = dladdr(e->site, &a) && a.dli_sname ? a.dli_sname : "?";
    const char* alloc = dladdr(e->alloc, &b) && b.dli_sname ? b.dli_sname : "?";
    fprintf(stderr, "ALLOC %s+%lu %p %s %u %llu %llu\\n", site, (unsigned long)((char*)e->site - (char*)a.dli_saddr),
      e->site, alloc, e->type, (unsigned long long)e->count, (unsigned long long)e->bytes);
  }
}
__attribute__((noinline)) static void porf_ap_record(u32 bytes, u32 typeId) {
  if (!porf_ap_started) { porf_ap_started = 1; atexit(porf_ap_dump); }
  void* frames[24];
  const int n = backtrace(frames, 24);
  // frames[0] is this, frames[1] the function porf_alloc is inlined into
  void* alloc = n > 1 ? frames[1] : NULL;
  void* site = alloc;
  for (int i = 1; i < n; i++) if (porf_ap_is_user(frames[i])) { site = frames[i]; break; }
  const u32 h = (u32)((((uintptr_t)site >> 2) ^ ((uintptr_t)alloc >> 4) ^ typeId) * 2654435761u) & (PORF_AP_SLOTS - 1u);
  for (u32 i = h;; i = (i + 1u) & (PORF_AP_SLOTS - 1u)) {
    porf_ap_entry* e = &porf_ap[i];
    if (e->count == 0) { e->site = site; e->alloc = alloc; e->type = typeId; }
    if (e->site == site && e->alloc == alloc && e->type == typeId) { e->count++; e->bytes += bytes; return; }
  }
}
#define PORF_AP_RECORD(bytes, typeId) porf_ap_record(bytes, typeId)
#endif
#else
#define PORF_AP_RECORD(bytes, typeId) ((void)0)
#endif
`;

export default ({ funcs, data = [], dataUnits = [], dataRelocs = [], globals = [], entry = null, prefs = {}, usedTypes = null, units = null }) => {
  // split: one C file per unit sharing a header, link-time constants as externs
  const split = !!prefs.split;
  const st = split ? '' : 'static ';

  const funcByName = new Map();
  for (const f of funcs) if (f) funcByName.set(f.name, f);
  const funcOf = ref => typeof ref === 'number' ? funcs[ref] : funcByName.get(ref);

  // contiguous function indices per unit in source order: fnbase_<unit> + local
  const unitOf = f => f.internal ? 'builtins' : f.unit ?? 'main';
  const funcsByUnit = new Map();
  for (const f of funcs) {
    if (!f) continue;
    if (!funcsByUnit.has(unitOf(f))) funcsByUnit.set(unitOf(f), []);
    funcsByUnit.get(unitOf(f)).push(f);
  }
  const unitOrder = [ 'builtins', ...(units ?? []).map(u => u.id) ];
  for (const u of funcsByUnit.keys()) if (u !== 'main' && !unitOrder.includes(u)) unitOrder.push(u);
  for (const u of dataUnits) if (u !== 'main' && !unitOrder.includes(u)) unitOrder.push(u);
  unitOrder.push('main');

  const linkFuncs = [], fnBase = {}, linkIdx = [];
  for (const u of unitOrder) {
    fnBase[u] = linkFuncs.length;
    const unitFuncs = funcsByUnit.get(u) ?? [];
    unitFuncs.sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.index - b.index);
    for (const f of unitFuncs) {
      linkIdx[f.index] = linkFuncs.length;
      linkFuncs.push(f);
    }
  }

  const syms = [], symsUsed = Object.create(null);
  const fnSym = f => {
    let sym = syms[f.index];
    if (sym) return sym;
    sym = `p_${sanitize(unitOf(f))}_${sanitize(String(f.name))}`;
    // tcc keeps only an identifier's first 256 characters or so: a longer name (an anonymous
    // function's, named for its source) is cut short, with a hash of the rest to keep it apart,
    // and a name taken already gets a number (a run of '_' grows past that limit when many
    // functions share a name)
    if (sym.length > 200) sym = sym.slice(0, 180) + '_' + symHash(sym);
    if (symsUsed[sym]) {
      let n = 2;
      while (symsUsed[`${sym}_${n}`]) n++;
      sym = `${sym}_${n}`;
    }
    symsUsed[sym] = true;
    syms[f.index] = sym;
    return sym;
  };
  // Porffor.c markers (codegen): \u0001name\u0001 is a variable, \u0002index\u0002 a JS
  // function called from C through its jsval wrapper, `<sym>_c`
  const cCallables = funcs.filter(f => f?.cCallable);
  // a local named in raw C is its frame field in a step (varName), else its C variable
  const resolveRawC = str => str
    .replace(/\u0001([^\u0001]*)\u0001/g, (_, name) => varName(name))
    .replace(/\u0002(\d+)\u0002/g, (_, index) => `${fnSym(funcs[Number(index)])}_c`);
  const cCallableProto = f => {
    const n = f.params.filter(p => !p.name.startsWith('#')).length;
    return `jsval ${fnSym(f)}_c(${Array.from({ length: n }, (_, i) => `jsval a${i}`).join(', ') || 'void'})`;
  };
  const cCallableDef = f => {
    const args = [];
    let j = 0;
    for (const p of f.params) {
      if (p.name === '#this' || p.name === '#newtarget') { args.push('JV_UNDEFINED'); continue; }
      if (p.name.startsWith('#')) throw new Error(`Porffor.c: ${f.name} cannot be called from C (it has ${p.name})`);
      const a = `a${j++}`;
      if (p.type === T.f64) args.push(`${a}.val`);
      else if (p.type === T.i64 || p.type === T.u64) args.push(`(i64)${a}.val`);
      else if (p.type === T.i32 || p.type === T.u32 || p.type === T.ptr) args.push(`(i32)${a}.val`);
      else args.push(a);
    }
    const call = `${fnSym(f)}(${args.join(', ')})`;
    const body = f.retType === T.none ? `${call};\n  return JV_UNDEFINED;`
      : f.retType === T.jsval ? `return ${call};`
      : `return porf_box_num((f64)${call});`;
    return `${cCallableProto(f)} {\n  ${body}\n}\n`;
  };

  // flags are derived here (only consumer), no stored func.flags. coroFlags = FN_* kind, fnFlags byte:
  // bits 0-2 coroutine kind, 3 callable (has return type), 4 constructor, 5 generator init suspension,
  // 6 stackless (runs as a step function over a heap frame, see stackless.js), 7 a class's constructor
  const usesFnKind = funcByName.has('__Porffor_funcLut_kind');
  const FN_CORO_INIT = 1 << 5;
  const FN_STACKLESS = 1 << 6;
  // the coroutines that run without a stack of their own (all but a few: see stackless.js),
  // and their bodies with every await and yield lifted to a statement
  const stackless = new Map();
  for (const f of funcs) {
    const plan = planStackless(f);
    if (plan) stackless.set(f, plan);
  }
  const coroKind = f => f?.async && f?.generator ? FN_ASYNC_GENERATOR : (f?.async ? FN_ASYNC : 0) | (f?.generator ? FN_GENERATOR : 0);
  const coroFlags = f => coroKind(f) | (f?.coroInit ? FN_CORO_INIT : 0) | (stackless.has(f) ? FN_STACKLESS : 0);
  const isCoro = f => !!(f && (f.async || f.generator));
  const needsCoro = f => !!(f && (f.generator || (f.async && f.hasAwait)));
  const isSyncAsync = f => !!(f && f.async && !f.generator && !needsCoro(f));
  const fnFlags = f => f ? (coroFlags(f) | (f.returnType != null ? 1 << 3 : 0) | (f.constr ? 1 << 4 : 0) | (f.isClass ? 1 << 7 : 0)) : 0;
  const jsArg = n => n[N_TYPE] === T.jsval ? rx(n, P_COMMA) : `porf_box_num(${rx(n, P_COMMA)})`;
  const packArg = n => `porf_pack(${jsArg(n)})`;

  let usesMath = false;
  let usesCoro = false;
  let usesSyncAsync = false;
  const gcEnabled = prefs.gc !== false;
  const ropesOn = !!Prefs.ropes && gcEnabled;
  // --ropes: the builtins that only store a value (a property, a Map entry) leave it a rope:
  // flattening it there would copy the whole string on every o.s += x. Their keys are
  // hashed, so those are flattened as any other argument
  const ROPE_KEEPS = {
    __Porffor_object_set: 'value', __Porffor_object_set_withHash: 'value',
    __Porffor_object_setStrict: 'value', __Porffor_object_setStrict_withHash: 'value',
    __Porffor_object_define: 'value', __Porffor_object_fastAdd: 'value', __Porffor_object_expr_init: 'value',
    __Porffor_object_set_ic: 'value', __Porffor_object_set_icMiss: 'value',
    __Map_prototype_set: 'value', __WeakMap_prototype_set: 'value'
  };
  // whether a builtin reads a parameter's characters itself, so needs it flat on entry. A use
  // that only looks at the value does not: its type and truthiness, == and + and relational
  // compares (their helpers flatten), a call (the callee flattens what it reads), returning,
  // throwing or storing it, and its length (a rope keeps it where a flat string does). A copy
  // into a local is the parameter too. Anything else (its pointer or payload, raw C naming
  // it) reads the string: ToNumber flattening on entry kept clang from folding its type
  // checks at every number call site (3.7x on a numeric loop)
  const readsString = (f, param) => {
    const names = new Set([ param ]);
    const isOurs = n => isNode(n) && (n[N_KIND] === K.Local) && names.has(n[N_A]);
    const SAFE = new Set([ K.JvType, K.JvIsNum, K.JvTruthy, K.JvFalsy, K.JvNullish, K.Eq, K.Add, K.Cmp,
      K.Call, K.CallDynamic, K.Return, K.Throw, K.TypeSwitch, K.If, K.Loop, K.Block, K.Switch, K.Try ]);
    let unsafe = false, grew = true;
    const visit = (node, parent, slot) => {
      if (unsafe || !Array.isArray(node)) return;
      if (!isNode(node)) { for (const x of node) visit(x, parent, slot); return; }
      const k = node[N_KIND];
      if (k === K.RawC) { for (const n of names) if (String(node[N_A]).includes(sanitize(n))) unsafe = true; return; }
      if (isOurs(node)) {
        const pk = parent?.[N_KIND];
        if (pk === K.Assign) {
          // copied into a local: that is the parameter too (writing the parameter reads nothing)
          if (slot === N_B && parent[N_A][N_KIND] === K.Local && !names.has(parent[N_A][N_A])) { names.add(parent[N_A][N_A]); grew = true; }
          else if (slot === N_B && parent[N_A][N_KIND] !== K.Local) unsafe = true;
        } else if (pk === K.ArrSet ? slot !== N_C : !SAFE.has(pk)) unsafe = true;
        return;
      }
      // a length read through the pointer is fine
      if (k === K.LenGet && isNode(node[N_A]) && node[N_A][N_KIND] === K.JvPtr && isOurs(node[N_A][N_A])) return;
      for (const slotIdx of [ N_A, N_B, N_C ]) visit(node[slotIdx], node, slotIdx);
    };
    while (grew && !unsafe) {
      grew = false;
      visit(f.body, null, null);
    }
    return unsafe;
  };
  const ropeFlatten = f => {
    if (!ropesOn || !f.internal) return '';
    const keep = ROPE_KEEPS[f.name];
    return f.params.filter(p => p.type === T.jsval && p.name !== keep && readsString(f, p.name))
      .map(p => `  ${sanitize(p.name)} = porf_str_flat(${sanitize(p.name)});\n`).join('');
  };
  for (const f of funcs) {
    if (needsCoro(f)) usesCoro = true;
    if (isSyncAsync(f)) usesSyncAsync = true;
  }
  const promiseResolveFunc = funcByName.get('__Porffor_promise_resolve');
  const settleAsyncResult = promiseResolveFunc
    ? (value, promise) => `(void)${fnSym(promiseResolveFunc)}(${value}, ${promise});`
    : (value, promise) => `porf_promise_settle_direct(${promise}, ${value}, 1);`;

  // static layout: one data block per unit, then function records, then name strings
  const align8 = x => (x + 7) & ~7;
  const dataOffsets = [], dbase = {};
  let off = 16; // 0 reserved (null), small pad
  for (const u of unitOrder) {
    dbase[u] = off;
    for (let i = 0; i < data.length; i++) {
      if (dataUnits[i] !== u) continue;
      dataOffsets[i] = off;
      off += align8(data[i].length);
    }
  }
  const fnrecBase = off;
  off += linkFuncs.length * 8;
  // empty names reuse offset 0 (0-length bytestring in the null region)
  // builtins whose key is a well-known symbol: named [Symbol.x]
  const SYMBOL_KEYED_NAMES = new Map([ [ '__Porffor_regex_symbolMatch', 'match' ], [ '__Porffor_regex_symbolMatchAll', 'matchAll' ],
    [ '__Porffor_regex_symbolSearch', 'search' ], [ '__Porffor_regex_symbolReplace', 'replace' ], [ '__Porffor_regex_symbolSplit', 'split' ] ]);
  const fnNameSegs = [];
  const fnNameOff = [];
  for (const f of linkFuncs) {
    let name = f.jsName ?? f.name;
    // (a private method's, #m or get #m, is as it is: a # elsewhere starts an internal suffix)
    if (!f.privateName) name = name.startsWith('__') ? name.split('_').pop() : name.split('#')[0];
    // a getter's name is "get x" (Map.prototype.size's is "get size"); a symbol's in brackets
    const symbolNamed = SYMBOL_KEYED_NAMES.get(f.name);
    if (symbolNamed) name = `[Symbol.${symbolNamed}]`;
    else if (f.name === '__Porffor_species$get') name = 'get [Symbol.species]';
    else if (name.endsWith('$get')) name = 'get ' + name.slice(0, -4);
    if (name.length === 0) { fnNameOff.push(0); continue; }
    const bytes = [ name.length & 0xff, (name.length >>> 8) & 0xff, (name.length >>> 16) & 0xff, (name.length >>> 24) & 0xff ];
    for (let k = 0; k < name.length; k++) bytes.push(name.charCodeAt(k) & 0xff);
    fnNameOff.push(off);
    fnNameSegs.push({ off, bytes });
    off += align8(bytes.length);
  }
  const staticEnd = off;

  // per-unit output and what it references (externs and prototypes in split mode)
  const unitParts = Object.create(null);
  const partsOf = u => unitParts[u] ??= { out: [], chunks: [], protos: [], globals: Object.create(null), fnbases: Object.create(null), dbases: Object.create(null) };
  let cur = partsOf('main');
  const emit = s => {
    cur.out.push(s);
    if (cur.out.length === 4096) {
      cur.chunks.push(cur.out.join(''));
      cur.out.length = 0;
    }
  };

  const fnIdxExpr = f => {
    // tree-shaken func captured by a closure: traps if ever called
    if (!f) return '0xffffffffu';
    if (!split) return `${linkIdx[f.index]}u`;
    const u = unitOf(f);
    cur.fnbases[u] = true;
    return `(porf_fnbase_${sanitize(u)} + ${linkIdx[f.index] - fnBase[u]}u)`;
  };

  let depth = 1;
  const ind = () => '\t'.repeat(depth);

  // while rendering a stackless function's step: the names that live in its frame (fr->x)
  // and the suspension points emitted so far
  let sl = null;
  const varName = name => sl !== null && sl.fields.has(name) ? `fr->${sanitize(name)}` : sanitize(name);

  // break/continue lower to plain C when targeting the innermost breakable, else goto,
  // labels are only emitted when goto'd
  const loopStack = [];
  const breakStack = [];
  // try depth at each label so a break or continue leaving a try body can unwind porf_try_depth
  const labelTry = new Map();
  let activeTryDepth = 0;
  let usedLabels = new Set();

  const paren = (s, p, need) => p < need ? `(${s})` : s;

  const isNode = node => Array.isArray(node) && typeof node[0] === 'number' &&
    KNames[node[0]] !== undefined && node.length === 6;

  // a naked break here would bind to the enclosing C construct (loops/switches rebind it: don't descend)
  const hasNakedBreak = node => {
    if (!Array.isArray(node)) return false;
    if (isNode(node)) {
      const k = node[N_KIND];
      if (k === K.Break) return !node[N_A];
      if (k === K.Loop || k === K.Switch || k === K.TypeSwitch) return false;
      return hasNakedBreak(node[N_A]) || hasNakedBreak(node[N_B]) || hasNakedBreak(node[N_C]);
    }
    return node.some(hasNakedBreak);
  };

  const hasRawC = node => {
    if (!Array.isArray(node)) return false;
    if (isNode(node)) {
      if (node[N_KIND] === K.RawC) return true;
      return hasRawC(node[N_A]) || hasRawC(node[N_B]) || hasRawC(node[N_C]);
    }
    return node.some(hasRawC);
  };

  // code after these in a list is unreachable
  const TERMINATOR_KINDS = new Set([ K.Return, K.Throw, K.ThrowNew, K.Unreachable, K.Break, K.Continue ]);

  // a builtin's == and + are the runtime's plain ones: the user-code ones (below) hand a string
  // and a number, or an object, to ToNumber and ToPrimitive, which the builtins never need and
  // which inlined at their many sites cost kilobytes
  let renderingBuiltin = false;
  const renderExpr = node => {
    switch (node[N_KIND]) {
      case K.Const: {
        const t = node[N_TYPE], v = node[N_A];
        if (t === T.jsval) return [`porf_box_num(${f64Lit(v)})`, P_POSTFIX]; // number jsval = its f64 bits
        if (t === T.f64) return [f64Lit(v), v < 0 ? P_UNARY : P_PRIM];
        if (t === T.i64) return [`${v}ll`, v < 0 ? P_UNARY : P_PRIM];
        if (t === T.u64) return [`${v}ull`, P_PRIM];
        if (t === T.u32 || t === T.ptr) return [`${v >>> 0}u`, P_PRIM];
        return [String(v | 0), v < 0 ? P_UNARY : P_PRIM];
      }

      case K.JvConst:
        return [`porf_box((f64)${node[N_B] >>> 0}u, ${node[N_A]})`, P_POSTFIX];

      case K.DataRef: {
        const id = node[N_A];
        if (!split) return [`${dataOffsets[id]}u`, P_PRIM];
        const u = dataUnits[id];
        cur.dbases[u] = true;
        return [`(porf_dbase_${sanitize(u)} + ${dataOffsets[id] - dbase[u]}u)`, P_PRIM];
      }

      case K.FuncIdx:
        return [fnIdxExpr(funcOf(node[N_A])), P_PRIM];
      case K.FuncRec: {
        const f = funcOf(node[N_A]);
        return [split ? `(porf_fnrecs + ${fnIdxExpr(f)} * 8u)` : `${fnrecBase + linkIdx[f.index] * 8}u`, P_PRIM];
      }

      case K.Global:
        cur.globals[node[N_A]] = true;
      case K.Local:
        return sl !== null && sl.fields.has(node[N_A]) ? [varName(node[N_A]), P_POSTFIX] : [sanitize(node[N_A]), P_PRIM];

      case K.Bin: {
        const op = node[N_A], t = node[N_B][N_TYPE] === T.none ? node[N_TYPE] : node[N_B][N_TYPE];
        // special spellings
        if (op === 'rotl' || op === 'rotr') {
          const fn = (t === T.i64 || t === T.u64) ? `porf_${op}64` : `porf_${op}32`;
          return [`${fn}(${rx(node[N_B], P_COMMA)}, ${rx(node[N_C], P_COMMA)})`, P_POSTFIX];
        }
        if (op === 'min' || op === 'max' || op === 'copysign') {
          usesMath = true;
          const fn = op === 'copysign' ? 'copysign' : `porf_f64_${op}`;
          return [`${fn}(${rx(node[N_B], P_COMMA)}, ${rx(node[N_C], P_COMMA)})`, P_POSTFIX];
        }
        if (op === '%' && t === T.f64) {
          usesMath = true;
          return [`fmod(${rx(node[N_B], P_COMMA)}, ${rx(node[N_C], P_COMMA)})`, P_POSTFIX];
        }
        if ((op === '==' || op === '!=') && (node[N_B][N_TYPE] === T.jsval || node[N_C][N_TYPE] === T.jsval)) {
          const eq = `porf_jv_eq(${rx(node[N_B], P_COMMA)}, ${rx(node[N_C], P_COMMA)})`;
          return [op === '==' ? eq : `!${eq}`, op === '==' ? P_POSTFIX : P_UNARY];
        }
        const prec = BIN_PREC[op];
        const ct = CT[node[N_B][N_TYPE]] ?? CT[node[N_TYPE]];
        let l = rx(node[N_B], prec);
        let r = rx(node[N_C], prec + 1);
        if (op === '<<' || op === '>>') {
          if (node[N_B][N_KIND] === K.Bin && BIN_PREC[node[N_B][N_A]] === P_ADD) l = `(${l})`;
          if (node[N_C][N_KIND] === K.Bin && BIN_PREC[node[N_C][N_A]] === P_ADD) r = `(${r})`;
        }
        // shifts: C UB on overshift; IR guarantees masked shift via codegen
        return [`${l} ${op} ${r}`, prec];
      }

      case K.Un: {
        const op = node[N_A], v = node[N_B];
        switch (op) {
          case 'neg': return [`-${rx(v, P_CAST)}`, P_UNARY];
          case '!': return [`!${rx(v, P_UNARY)}`, P_UNARY];
          case '~': return [`~${rx(v, P_UNARY)}`, P_UNARY];
          case 'abs': usesMath = true; return [`fabs(${rx(v, P_COMMA)})`, P_POSTFIX];
          case 'floor': case 'ceil': case 'trunc': case 'sqrt':
            usesMath = true; return [`${op}(${rx(v, P_COMMA)})`, P_POSTFIX];
          case 'nearest': usesMath = true; return [`porf_nearest(${rx(v, P_COMMA)})`, P_POSTFIX];
          case 'clz': return [`porf_clz32(${rx(v, P_COMMA)})`, P_POSTFIX];
          case 'ctz': return [`porf_ctz32(${rx(v, P_COMMA)})`, P_POSTFIX];
          case 'popcnt': return [`__builtin_popcount(${rx(v, P_COMMA)})`, P_POSTFIX];
        }
        throw new Error(`render: unknown unary op ${op}`);
      }

      case K.Select:
        return [`${rx(node[N_A], P_LOR)} ? ${rx(node[N_B], P_TERNARY)} : ${rx(node[N_C], P_TERNARY)}`, P_TERNARY];

      case K.Convert: {
        const to = node[N_TYPE], from = node[N_A], v = node[N_B], flags = node[N_C];
        // a 32-bit integer widened to f64 and narrowed back to the other signedness: ToInt32
        // and ToUint32 of an exact 32-bit value wrap (a u32 of 2^31 or more is a negative i32,
        // a negative i32 a large u32), so the bits carry over as they are, never saturated
        if (from === T.f64 && v[N_KIND] === K.Convert && v[N_TYPE] === T.f64 &&
            ((to === T.i32 && v[N_A] === T.u32) || (to === T.u32 && v[N_A] === T.i32))) {
          return [`(${CT[to]})${rx(v[N_B], P_CAST)}`, P_CAST];
        }
        // and back to the same type: every 32-bit integer is exact as an f64, so the round
        // trip is the value itself (builtins' stores of i32 values took it on every store)
        if (from === T.f64 && v[N_KIND] === K.Convert && v[N_TYPE] === T.f64 &&
            ((to === T.i32 && v[N_A] === T.i32) || (to === T.u32 && v[N_A] === T.u32))) {
          return renderExpr(v[N_B]);
        }
        // (f64)a ± (f64)b back to an integer, a and b 32-bit integers (an i32 counter's i++ in
        // a builtin): the sum is exact as an f64, so the same saturated result comes from a
        // 64-bit integer sum, without the round trip through f64
        if (from === T.f64 && (to === T.i32 || to === T.u32) && !(flags & CONVERT_RANGE_KNOWN) &&
            v[N_KIND] === K.Bin && (v[N_A] === '+' || v[N_A] === '-') && exactInt(v[N_B]) && exactInt(v[N_C])) {
          return [`${to === T.i32 ? 'porf_sat_i32' : 'porf_sat_u32'}(${exactInt(v[N_B])} ${v[N_A]} ${exactInt(v[N_C])})`, P_POSTFIX];
        }
        // f64 -> int without range knowledge: saturate (JS ToInt semantics live above this)
        if (from === T.f64 && (to === T.i32 || to === T.u32 || to === T.ptr) && !(flags & CONVERT_RANGE_KNOWN)) {
          return [`${to === T.i32 ? 'porf_f64_to_i32' : 'porf_f64_to_u32'}(${rx(v, P_COMMA)})`, P_POSTFIX];
        }
        if (to === T.f64 && (from === T.u32 || from === T.ptr) && !(flags & CONVERT_SIGNED)) {
          return [`(f64)${rx(v, P_CAST)}`, P_CAST];
        }
        return [`(${CT[to]})${rx(v, P_CAST)}`, P_CAST];
      }

      case K.Reinterpret:
        if (node[N_B] === 'bitsToF32') return [`porf_bits_to_f32(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
        if (node[N_B] === 'f32ToBits') return [`porf_f32_to_bits(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
        if (node[N_B] === 'bitsToF16') return [`porf_f16_to_f64((u16)${rx(node[N_A], P_CAST)})`, P_POSTFIX];
        if (node[N_B] === 'f16ToBits') return [`(i32)porf_f64_to_f16(${rx(node[N_A], P_COMMA)})`, P_CAST];
        return [node[N_TYPE] === T.f64
          ? `porf_bits_to_f64(${rx(node[N_A], P_COMMA)})`
          : `porf_f64_to_bits(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];

      case K.Canon:
        return [`porf_canon(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];

      case K.Box: {
        const v = node[N_A], tExpr = node[N_B];
        const payload = v[N_TYPE] === T.jsval ? `(${rx(v, P_POSTFIX)}.val)` : rx(v, P_COMMA);
        if (tExpr[N_KIND] === K.Const) {
          const tid = tExpr[N_A];
          if (tid === TYPES.number) return [`porf_box_num(${payload})`, P_POSTFIX];
          return [`porf_box(${payload}, ${tid})`, P_POSTFIX];
        }
        return [`porf_box(${payload}, ${rx(tExpr, P_COMMA)})`, P_POSTFIX];
      }
      case K.JvType: return [`porf_jv_type(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
      case K.JvNum: return [`(${rx(node[N_A], P_POSTFIX)}.val)`, P_POSTFIX];
      case K.JvPtr: return [`(u32)${rx(node[N_A], P_POSTFIX)}.val`, P_CAST];
      case K.JvBits: return [`porf_pack(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
      case K.JvFromBits: return [`porf_unpack(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
      case K.JvIsNum: return [`porf_jv_is_num(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
      case K.Eq: return [`${node[N_A] ? 'porf_strict_eq' : renderingBuiltin ? 'porf_loose_eq_plain' : 'porf_loose_eq'}(${jsArg(node[N_B])}, ${jsArg(node[N_C])})`, P_POSTFIX];
      case K.Add: return [`${renderingBuiltin ? 'porf_add_plain' : 'porf_add'}(${jsArg(node[N_A])}, ${jsArg(node[N_B])})`, P_POSTFIX];
      case K.Cmp: return [`porf_cmp(${jsArg(node[N_A])}, ${jsArg(node[N_B])})`, P_POSTFIX];
      case K.JvTruthy: return [`porf_truthy(${jsArg(node[N_A])})`, P_POSTFIX];
      case K.JvFalsy: return [`porf_falsy(${jsArg(node[N_A])})`, P_POSTFIX];
      case K.JvNullish: return [`porf_nullish(${jsArg(node[N_A])})`, P_POSTFIX];

      case K.Load: {
        const ctype = node[N_A];
        const [off, unaligned] = node[N_C];
        const addr = `MEM + ${rx(node[N_B], P_ADD)}${off ? ` + ${off}u` : ''}`;
        if (unaligned) {
          // signed unaligned: load unsigned width, cast (u8/i8 are always aligned)
          if (ctype === 'i16') return [`(int16_t)porf_load_un_u16(${addr})`, P_CAST];
          if (ctype === 'i32') return [`(i32)porf_load_un_u32(${addr})`, P_CAST];
          if (ctype === 'i64') return [`(i64)porf_load_un_u64(${addr})`, P_CAST];
          if (ctype === 'jsval') return [`porf_unpack(porf_load_un_u64(${addr}))`, P_POSTFIX];
          if (ctype === 'f16') return [`porf_f16_to_f64(porf_load_un_u16(${addr}))`, P_POSTFIX];
          return [`porf_load_un_${ctype}(${addr})`, P_POSTFIX];
        }
        if (ctype === 'jsval') return [`porf_unpack(*(jsbits*)(${addr}))`, P_POSTFIX];
        if (ctype === 'f16') return [`porf_f16_to_f64(*(u16*)(${addr}))`, P_POSTFIX];
        return [`*(${ctype === 'i8' ? 'int8_t' : ctype === 'i16' ? 'int16_t' : ctype}*)(${addr})`, P_UNARY];
      }

      case K.Call: {
        if (node[N_A] === '__Porffor_coroutine_resume' || node[N_A] === '__Porffor_coroutine_value' || node[N_A] === '__Porffor_coroutine_awaiting' || node[N_A] === '__Porffor_coroutine_returning') usesCoro = true;
        const f = funcOf(node[N_A]);
        if (f) cur.protos[f.index] = f;
        // direct call to a coroutine starts it instead of running the body: split args into the invocation shape
        if (f && isCoro(f)) {
          let callee = 'JV_UNDEFINED', env = '0', thisv = 'JV_UNDEFINED', newtv = 'JV_UNDEFINED';
          const rawArgv = Array.isArray(node[N_C]) ? node[N_C] : null;
          const argv = rawArgv ?? [];
          node[N_B].forEach((a, i) => {
            const s = rx(a, P_COMMA), pn = f.params[i]?.name;
            if (pn === '#callee') callee = s;
            else if (pn === '#env') env = s;
            else if (pn === '#this') thisv = s;
            else if (pn === '#newtarget') newtv = s;
            else if (!rawArgv) argv.push(a);
          });
          const argvArr = argv.length ? `(jsbits[]){ ${argv.map(a => packArg(a)).join(', ')} }` : '(jsbits[]){JV_UNDEFINED_BITS}';
          return [needsCoro(f)
            ? `porf_coro_start(${coroFlags(f)}u, ${fnIdxExpr(f)}, ${callee}, ${env}, ${thisv}, ${newtv}, ${argv.length}, ${argvArr})`
            : `porf_async_call_sync(${fnIdxExpr(f)}, ${callee}, ${env}, ${thisv}, ${newtv}, ${argv.length}, ${argvArr})`, P_POSTFIX];
        }
        const name = f ? fnSym(f) : sanitize(String(node[N_A]));
        const args = node[N_B].map(a => rx(a, P_COMMA)).join(', ');
        return [`${name}(${args})`, P_POSTFIX];
      }

      case K.CallDynamic: {
        const [args, newTarget, spreadArr] = node[N_C];
        const newt = newTarget ? rx(newTarget, P_COMMA) : 'JV_UNDEFINED';
        if (spreadArr) {
          return [`porf_call_dynamic_arr(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)}, ${newt}, ${rx(spreadArr, P_COMMA)})`, P_POSTFIX];
        }
        // a plain call (no new.target) with up to 3 arguments: PORF_CALLn, which a size build
        // turns into a call to porf_callN (the packing emitted once, not at every site)
        if (args.length <= 3 && (newt === 'JV_UNDEFINED' || newt === `porf_box((f64)0u, ${TYPES.undefined})`)) {
          return [`PORF_CALL${args.length}(${[ node[N_A], node[N_B] ].map(x => rx(x, P_COMMA)).concat(args.map(jsArg)).join(', ')})`, P_POSTFIX];
        }
        const argv = args.length === 0 ? '(jsbits[]){JV_UNDEFINED_BITS}'
          : `(jsbits[]){ ${args.map(packArg).join(', ')} }`;
        return [`porf_call_dynamic(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)}, ${newt}, ${args.length}, ${argv})`, P_POSTFIX];
      }

      case K.Await:
        if (sl !== null) throw new Error('stackless: an await was left inside an expression');
        usesCoro = true;
        return [`porf_await(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
      case K.Yield:
        if (sl !== null) throw new Error('stackless: a yield was left inside an expression');
        usesCoro = true;
        return [`porf_yield(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];

      case K.Alloc: return [`porf_alloc(${rx(node[N_A], P_COMMA)}, ${node[N_B]}u)`, P_POSTFIX];
      case K.ArrAlloc: return [`porf_arr_alloc(${rx(node[N_A], P_COMMA)})`, P_POSTFIX];
      case K.EnvAlloc: return [`porf_env_alloc(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)})`, P_POSTFIX];
      case K.FnAlloc: return [`porf_fn_alloc(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)})`, P_POSTFIX];
      case K.Clone: return [`porf_tmpl_clone(${rx(node[N_A], P_COMMA)}, ${node[N_B]})`, P_POSTFIX];

      case K.ArrGet: return [`porf_arr_get(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)})`, P_POSTFIX];
      case K.LenGet: return [`*(i32*)(MEM + ${rx(node[N_A], P_ADD)})`, P_UNARY];

      default:
        throw new Error(`render: cannot render ${KNames[node[N_KIND]]} as expression`);
    }
  };

  const rx = (node, need) => {
    const [code, prec] = renderExpr(node);
    return paren(code, prec, need);
  };

  // an f64 that is exactly a 32-bit integer (one widened, or an integral constant in range),
  // as an i64 operand; null for anything else
  const exactInt = node => {
    if (node[N_KIND] === K.Convert && node[N_TYPE] === T.f64 && (node[N_A] === T.i32 || node[N_A] === T.u32))
      return `(i64)${rx(node[N_B], P_CAST)}`;
    if (node[N_KIND] === K.Const && typeof node[N_A] === 'number' && Number.isInteger(node[N_A]) &&
        node[N_A] >= -2147483648 && node[N_A] <= 4294967295 && !Object.is(node[N_A], -0)) return `(i64)${node[N_A]}`;
    return null;
  };

  const renderStmts = stmts => {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      renderStmt(s);
      if (s != null && isNode(s) && TERMINATOR_KINDS.has(s[N_KIND]) &&
          !stmts.slice(i + 1).some(hasRawC)) return;
    }
  };

  // a stackless suspension point: the step returns with the awaited promise, and the
  // promise's reaction resumes it at the label with its value or its rejection
  // a state the step can be re-entered in (a resume or a catch), at the label: the way
  // back in goes through each enclosing loop's own dispatch, outermost first
  const slEntry = to => {
    const n = ++sl.resumes;
    const loops = sl.loopStack;
    const hop = (from, label) => (from === 0 ? sl.top : sl.routes.get(from)).push([n, label]);
    for (let i = 0; i <= loops.length; i++) {
      const from = i === 0 ? 0 : loops[i - 1];
      hop(from, i === loops.length ? to(n) : `porf_loop_${loops[i]}`);
    }
    return n;
  };

  // leaving tries for an enclosing depth: pop their setjmp frames, or in a step name the
  // catch still around the target (a step's tries keep no setjmp: see renderStackless)
  const unwindTry = target => {
    if (!(activeTryDepth > target)) return;
    if (sl !== null) emit(`${ind()}fr->porf_handler = ${target === 0 ? 0 : sl.handlers[target - 1]};\n`);
    else emit(`${ind()}porf_try_depth -= ${activeTryDepth - target};\n`);
  };

  // an await hands its driver the promise to wait on; a yield hands the value to next()'s
  // caller (__Porffor_coroutine_value), resuming with what the next next() sends
  const emitAwait = (value, dst, yielding = false) => {
    const n = slEntry(n => `porf_resume_${n}`);
    emit(yielding
      ? `${ind()}call->coro.channel = ${jsArg(value)};\n`
      : `${ind()}call->coro.channel = porf_sl_promise(${jsArg(value)});\n`);
    emit(`${ind()}call->coro.awaiting = ${yielding ? 0 : 1};\n${ind()}call->coro.state = 2;\n`);
    emit(`${ind()}fr->porf_state = ${n};\n${ind()}return 0;\n`);
    emit(`${ind()}porf_resume_${n}:;\n${ind()}porf_resuming = 0;\n`);
    emit(`${ind()}if (porf_in_throw) porf_throw(porf_in);\n`);
    if (dst) emit(`${ind()}${dst} = porf_in;\n`);
  };

  const renderStmt = node => {
    if (node == null) return;
    switch (node[N_KIND]) {
      case K.Assign:
        if (node[N_A][N_KIND] === K.Global) cur.globals[node[N_A][N_A]] = true;
        if (sl !== null && (node[N_B][N_KIND] === K.Await || node[N_B][N_KIND] === K.Yield)) {
          emitAwait(node[N_B][N_A], varName(node[N_A][N_A]), node[N_B][N_KIND] === K.Yield);
          return;
        }
        emit(`${ind()}${varName(node[N_A][N_A])} = ${rx(node[N_B], P_COMMA)};\n`);
        return;

      case K.Store: {
        const ctype = node[N_A];
        const [off, unaligned, value] = node[N_C];
        const addr = `MEM + ${rx(node[N_B], P_ADD)}${off ? ` + ${off}u` : ''}`;
        if (ctype === 'f16') {
          // a half: rounded from the double (porf_f64_to_f16), stored as its bits
          if (unaligned) emit(`${ind()}porf_store_un_u16(${addr}, porf_f64_to_f16(${rx(value, P_COMMA)}));\n`);
            else emit(`${ind()}*(u16*)(${addr}) = porf_f64_to_f16(${rx(value, P_COMMA)});\n`);
        } else if (unaligned) {
          const un = { i16: 'u16', i32: 'u32', i64: 'u64', jsval: 'u64' }[ctype] ?? ctype;
          emit(`${ind()}porf_store_un_${un}(${addr}, ${ctype === 'jsval' ? packArg(value) : rx(value, P_COMMA)});\n`);
        } else if (ctype === 'jsval') emit(`${ind()}*(jsbits*)(${addr}) = ${packArg(value)};\n`);
          else emit(`${ind()}*(${ctype === 'i8' ? 'int8_t' : ctype === 'i16' ? 'int16_t' : ctype}*)(${addr}) = ${rx(value, P_COMMA)};\n`);
        return;
      }

      case K.MemCopy: {
        const [bytes, mayOverlap] = node[N_C];
        emit(`${ind()}${mayOverlap ? 'memmove' : 'memcpy'}(MEM + ${rx(node[N_A], P_ADD)}, MEM + ${rx(node[N_B], P_ADD)}, ${rx(bytes, P_COMMA)});\n`);
        return;
      }

      case K.MemFill:
        emit(`${ind()}memset(MEM + ${rx(node[N_A], P_ADD)}, ${rx(node[N_B], P_COMMA)}, ${rx(node[N_C], P_COMMA)});\n`);
        return;

      case K.If: {
        emit(`${ind()}if (${rx(node[N_A], P_COMMA)}) {\n`);
        depth++; renderStmts(node[N_B]); depth--;
        if (node[N_C] && node[N_C].length) {
          emit(`${ind()}} else {\n`);
          depth++; renderStmts(node[N_C]); depth--;
        }
        emit(`${ind()}}\n`);
        return;
      }

      case K.Loop: {
        const cond = node[N_A], update = node[N_B];
        const [stmts, label] = node[N_C];
        const updateC = update == null ? null
          : update[N_KIND] === K.Assign
            ? `${varName(update[N_A][N_A])} = ${rx(update[N_B], P_COMMA)}`
            : rx(update, P_COMMA);
        // a stackless loop with a suspension point in it is entered only at its top, also
        // when resuming (a goto into its body would make it irreducible, which wasm cannot
        // express: LLVM copies code to repair that): its own dispatch then skips the
        // condition and goes on to the resume point, or to the loop inside holding it
        const slLoop = sl !== null && hasSuspend(stmts) ? ++sl.loops : 0;
        if (slLoop) {
          emit(`${ind()}porf_loop_${slLoop}:;\n`);
          emit(update ? `${ind()}for (;; ${updateC}) {\n` : `${ind()}while (1) {\n`);
          emit(`${ind()}\tif (porf_resuming) {\n\u0003${slLoop}\u0003${ind()}\t}${cond ? ` else if (!(${rx(cond, P_COMMA)})) break;` : ''}\n`);
          sl.loopStack.push(slLoop);
          sl.routes.set(slLoop, []);
        } else if (update) emit(`${ind()}for (; ${cond ? rx(cond, P_COMMA) : ''}; ${updateC}) {\n`);
          else if (cond) emit(`${ind()}while (${rx(cond, P_COMMA)}) {\n`);
        else emit(`${ind()}while (1) {\n`);
        loopStack.push(label);
        breakStack.push(label);
        if (label) labelTry.set(label, activeTryDepth);
        depth++;
        renderStmts(stmts);
        if (label && usedLabels.has(label + '_c')) emit(`${ind()}${sanitize(label)}_c:;\n`);
        depth--;
        breakStack.pop();
        loopStack.pop();
        if (slLoop) sl.loopStack.pop();
        emit(`${ind()}}\n`);
        if (label && usedLabels.has(label + '_b')) emit(`${ind()}${sanitize(label)}_b:;\n`);
        return;
      }

      case K.Break: {
        unwindTry(labelTry.get(node[N_A]));
        if (node[N_A] && node[N_A] !== breakStack[breakStack.length - 1]) {
          usedLabels.add(node[N_A] + '_b');
          emit(`${ind()}goto ${sanitize(node[N_A])}_b;\n`);
        } else emit(`${ind()}break;\n`);
        return;
      }

      case K.Continue: {
        unwindTry(labelTry.get(node[N_A]));
        if (node[N_A] && node[N_A] !== loopStack[loopStack.length - 1]) {
          usedLabels.add(node[N_A] + '_c');
          emit(`${ind()}goto ${sanitize(node[N_A])}_c;\n`);
        } else emit(`${ind()}continue;\n`);
        return;
      }

      case K.Block: {
        if (node[N_A].length === 0 && !node[N_B]) return;
        if (node[N_B]) labelTry.set(node[N_B], activeTryDepth);
        emit(`${ind()}{\n`);
        depth++; renderStmts(node[N_A]); depth--;
        emit(`${ind()}}\n`);
        if (node[N_B] && usedLabels.has(node[N_B] + '_b')) emit(`${ind()}${sanitize(node[N_B])}_b:;\n`);
        return;
      }

      case K.Switch:
      case K.TypeSwitch: {
        const isType = node[N_KIND] === K.TypeSwitch;
        const subj = node[N_A];
        const kept = [];
        for (const [values, stmts, fallthrough] of node[N_B]) {
          const vals = isType && usedTypes ? values.filter(v => usedTypes.has(v)) : values;
          if (vals.length !== 0) kept.push([ vals, stmts, fallthrough ]);
        }
        const def = node[N_C] && node[N_C].length ? node[N_C] : null;

        // 0/1 surviving cases: if/else instead of switch. blocked by a naked break (must
        // bind to the switch) and re-evaluation hazards: dropping the subject needs it
        // effect-free, repeating it (multi-value condition) needs it trivial
        const subjTrivial = subj[N_KIND] === K.Local || subj[N_KIND] === K.Global || subj[N_KIND] === K.Const;
        if (kept.length <= 1 &&
            !hasNakedBreak(kept.length ? kept[0][1] : null) && !hasNakedBreak(def) &&
            (kept.length === 1
              ? kept[0][0].length === 1 || subjTrivial
              : (subj[N_FX] & (FX.call | FX.writeMem | FX.writeLocal)) === 0)) {
          if (kept.length === 0) {
            if (def) renderStmts(def);
            return;
          }
          const [ vals, stmts, fallthrough ] = kept[0];
          const subjS = () => isType && subj[N_TYPE] === T.jsval ? `porf_jv_type(${rx(subj, P_COMMA)})` : rx(subj, P_EQ + 1);
          emit(`${ind()}if (${vals.map(v => `${subjS()} == ${v}`).join(' || ')}) {\n`);
          depth++; renderStmts(stmts); depth--;
          if (def && !fallthrough) {
            emit(`${ind()}} else {\n`);
            depth++; renderStmts(def); depth--;
          }
          emit(`${ind()}}\n`);
          if (def && fallthrough) renderStmts(def);
          return;
        }

        const subjCode = isType && subj[N_TYPE] === T.jsval ? `porf_jv_type(${rx(subj, P_COMMA)})` : rx(subj, P_COMMA);
        emit(`${ind()}switch (${subjCode}) {\n`);
        breakStack.push(null);
        depth++;
        for (const [vals, stmts, fallthrough] of kept) {
          emit(ind());
          for (const v of vals) emit(`case ${v}: `);
          emit('{\n');
          depth++; renderStmts(stmts); depth--;
          emit(`${ind()}}\n`);
          if (!fallthrough) emit(`${ind()}break;\n`);
        }
        if (def) {
          emit(`${ind()}default:\n${ind()}{\n`);
          depth++; renderStmts(def); depth--;
          emit(`${ind()}}\n`);
        }
        depth--;
        breakStack.pop();
        emit(`${ind()}}\n`);
        return;
      }

      case K.Return:
        if (sl !== null) {
          // the step ends: the result goes to the call, which settles its promise (its
          // tries hold no setjmp frames: the wrapper pops its own)
          emit(`${ind()}call->result = ${node[N_A] ? jsArg(node[N_A]) : 'JV_UNDEFINED'};\n`);
          emit(`${ind()}call->coro.state = 3;\n${ind()}return 1;\n`);
          return;
        }
        if (activeTryDepth !== 0 && node[N_A]) {
          emit(`${ind()}{\n`);
          depth++;
          emit(`${ind()}${CT[node[N_A][N_TYPE]]} _return = ${rx(node[N_A], P_COMMA)};\n`);
          emit(`${ind()}porf_try_depth -= ${activeTryDepth};\n`);
          emit(`${ind()}return _return;\n`);
          depth--;
          emit(`${ind()}}\n`);
          return;
        }
        if (activeTryDepth !== 0) emit(`${ind()}porf_try_depth -= ${activeTryDepth};\n`);
        emit(node[N_A] ? `${ind()}return ${rx(node[N_A], P_COMMA)};\n` : `${ind()}return;\n`);
        return;

      case K.Unreachable:
        emit(`${ind()}porf_unreachable(${node[N_A] ? JSON.stringify(String(node[N_A])) : '0'});\n`);
        return;

      case K.Try: {
        if (sl !== null) {
          // no setjmp here: the frame names this catch while the body runs, and a throw
          // reaching the step's wrapper re-enters the step at the catch with the exception
          const outer = activeTryDepth === 0 ? 0 : sl.handlers[activeTryDepth - 1];
          const n = slEntry(n => `porf_catch_${n}`);
          emit(`${ind()}fr->porf_handler = ${n};\n`);
          sl.handlers[activeTryDepth++] = n;
          renderStmts(node[N_A]);
          activeTryDepth--;
          emit(`${ind()}fr->porf_handler = ${outer};\n${ind()}goto porf_try_end_${n};\n`);
          emit(`${ind()}porf_catch_${n}:;\n${ind()}porf_resuming = 0;\n${ind()}fr->porf_handler = ${outer};\n`);
          emit(`${ind()}{\n`);
          depth++;
          emit(sl.fields.has(node[N_B])
            ? `${ind()}${varName(node[N_B])} = porf_in;\n`
            : `${ind()}jsval ${sanitize(node[N_B])} = porf_in;\n`);
          renderStmts(node[N_C]);
          depth--;
          emit(`${ind()}}\n${ind()}porf_try_end_${n}:;\n`);
          return;
        }
        emit(`${ind()}{\n`);
        depth++;
        emit(`${ind()}porf_try_depth++;\n`);
        emit(`${ind()}if (_setjmp(porf_try_ensure()[porf_try_depth - 1]) == 0) {\n`);
        activeTryDepth++;
        depth++; renderStmts(node[N_A]);
        activeTryDepth--;
        emit(`${ind()}porf_try_depth--;\n`);
        depth--;
        emit(`${ind()}} else {\n`);
        depth++;
        emit(`${ind()}porf_try_depth--;\n`);
        emit(sl !== null && sl.fields.has(node[N_B])
          ? `${ind()}${varName(node[N_B])} = porf_exception;\n`
          : `${ind()}jsval ${sanitize(node[N_B])} = porf_exception;\n`);
        renderStmts(node[N_C]);
        depth--;
        emit(`${ind()}}\n`);
        depth--;
        emit(`${ind()}}\n`);
        return;
      }

      case K.Throw:
        emit(`${ind()}porf_throw(${rx(node[N_A], P_COMMA)});\n`);
        return;

      case K.ThrowNew:
        emit(`${ind()}porf_throw_new(${node[N_A]}, ${rx(node[N_B], P_COMMA)});\n`);
        return;

      case K.GcBarrier:
        emit(`${ind()}porf_gc_barrier(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)});\n`);
        return;

      case K.ArrSet:
        emit(`${ind()}porf_arr_set(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)}, ${jsArg(node[N_C])});\n`);
        return;

      case K.ArrLenSet:
        emit(`${ind()}porf_arr_set_len(${rx(node[N_A], P_COMMA)}, ${rx(node[N_B], P_COMMA)});\n`);
        return;

      case K.LenSet:
        emit(`${ind()}*(i32*)(MEM + ${rx(node[N_A], P_ADD)}) = ${rx(node[N_B], P_COMMA)};\n`);
        return;

      case K.RawC:
        emit(`${ind()}${resolveRawC(node[N_A])}${node[N_B] ? ';' : ''}\n`);
        return;

      case K.Await:
      case K.Yield:
        if (sl !== null) {
          emitAwait(node[N_A], null, node[N_KIND] === K.Yield);
          return;
        }
        // falls through: a stackful await or yield, as any other expression statement

      default: {
        if ((node[N_FX] & (FX.call | FX.writeMem | FX.writeLocal)) !== 0) {
          // the cast binds tighter than any binary operator or ?: in the expression
          emit(`${ind()}${node[N_TYPE] !== T.none ? `(void)${rx(node, P_CAST)}` : rx(node, P_COMMA)};\n`);
        }
        return;
      }
    }
  };

  // catch parameters in a body: C locals of their catch blocks, frame fields when stackless
  const catchNames = (node, out) => {
    if (!Array.isArray(node)) return out;
    if (isNode(node)) {
      if (node[N_KIND] === K.Try) out.add(node[N_B]);
      catchNames(node[N_A], out); catchNames(node[N_B], out); catchNames(node[N_C], out);
    } else for (const x of node) catchNames(x, out);
    return out;
  };

  // a stackless async function: its frame, the starter porf_invoke calls (params into a
  // new frame, then the first step), and the step each resumption calls
  const renderStackless = (f, plan) => {
    const sym = fnSym(f);
    const frame = `porf_slf_${sym}`;
    // the params and whatever is live across a suspension go in the frame; every other
    // local is a plain C local of the step, dead at each suspension (stackless.js)
    const fields = new Map();
    const stepLocals = new Map();
    for (const p of f.params) fields.set(p.name, p.type);
    const place = (name, type) => {
      if (fields.has(name) || stepLocals.has(name)) return;
      (plan.frame.has(name) ? fields : stepLocals).set(name, type);
    };
    for (const name in f.locals) place(name, f.locals[name].type);
    for (const name in plan.temps) place(name, plan.temps[name]);
    for (const name of catchNames(plan.body, new Set())) if (plan.frame.has(name)) place(name, T.jsval);

    // a step with a try runs its body under a wrapper holding the one setjmp (see K.Try)
    const tries = hasTry(plan.body);
    emit(`typedef struct ${frame} {\n  i32 porf_state;\n${tries ? '  i32 porf_handler; // the catch a throw now goes to, 0 for none\n' : ''}`);
    for (const [name, t] of fields) emit(`  ${CT[t]} ${sanitize(name)};\n`);
    emit(`} ${frame};\n\n`);
    emit(`static i32 ${sym}_step(porf_coro_call* call, jsval porf_in, i32 porf_in_throw);\n\n`);

    const ret = CT[f.retType];
    const params = f.params.map(p => `${CT[p.type]} ${sanitize(p.name)}`).join(', ');
    emit(`PORF_NOINLINE ${ret} ${sym}(${params || 'void'}) {\n`);
    emit(`  porf_coro_call* call = porf_sl_starting;\n  porf_sl_starting = 0;\n`);
    emit(`  if (!call) porf_unreachable("stackless async function called outside porf_coro_start");\n`);
    emit(`  ${frame}* fr = (${frame}*)calloc(1, sizeof(${frame}));\n  if (!fr) abort();\n`);
    // --ropes: as for any builtin (see renderFunc), strings arrive flat, before the frame keeps them
    emit(ropeFlatten(f));
    for (const [name, t] of fields) {
      if (f.params.some(p => p.name === name)) emit(`  fr->${sanitize(name)} = ${sanitize(name)};\n`);
      else if (t === T.jsval) emit(`  fr->${sanitize(name)} = JV_UNDEFINED;\n`);
    }
    emit(`  call->sl_frame = fr;\n  call->sl_frame_size = (u32)sizeof(${frame});\n  call->sl_step = ${sym}_step;\n`);
    emit(`  (void)${sym}_step(call, JV_UNDEFINED, 0);\n`);
    emit(ret === 'void' ? '}\n\n' : ret === 'jsval' ? '  return JV_UNDEFINED;\n}\n\n' : '  return 0;\n}\n\n');

    // the body first (to know its suspension points), then the dispatch in front of it
    sl = { fields: new Set(fields.keys()), resumes: 0, loops: 0, loopStack: [], top: [], routes: new Map(), handlers: [] };
    const outer = cur;
    cur = { ...outer, out: [], chunks: [] };
    depth = 1;
    activeTryDepth = 0;
    loopStack.length = 0;
    usedLabels = new Set();
    renderStmts(plan.body);
    const cases = (routes, pad) => `${pad}switch (fr->porf_state) {\n` +
      routes.map(([n, to]) => `${pad}  case ${n}: goto ${to};\n`).join('') + `${pad}  default: break;\n${pad}}\n`;
    const routes = sl.routes;
    const body = (cur.chunks.join('') + cur.out.join('')).replace(/\u0003(\d+)\u0003/g, (_, id) => cases(routes.get(+id), '\t\t'));
    const top = sl.top;
    cur = outer;
    sl = null;

    // with tries, the body is its own function under a wrapper holding the setjmp, kept
    // apart: setjmp in an optimised wasm function makes it 10-15x bigger (sjlj lowering)
    const bodySym = tries ? `${sym}_body` : `${sym}_step`;
    emit(`${tries ? 'PORF_NOINLINE ' : ''}static i32 ${bodySym}(porf_coro_call* call, jsval porf_in, i32 porf_in_throw) {\n`);
    emit(`  ${frame}* fr = (${frame}*)call->sl_frame;\n  (void)porf_in; (void)porf_in_throw;\n`);
    for (const [name, t] of stepLocals) emit(`  ${CT[t]} ${sanitize(name)}${t === T.jsval ? ' = JV_UNDEFINED' : ' = 0'};\n`);
    // resuming: to the resume point, or to the loop holding it (see K.Loop)
    emit(`  i32 porf_resuming = 0;\n  PORF_STACK_CHECK();\n`);
    if (top.length > 0) emit(`  if (fr->porf_state != 0) {\n    porf_resuming = 1;\n${cases(top, '    ')}  }\n`);
    emit(body);
    emit(`  call->result = JV_UNDEFINED;\n  call->coro.state = 3;\n  return 1;\n}\n\n`);

    if (tries) {
      // a throw out of the body: to the catch the frame names, entered as a resume is, or
      // on to the step's caller when none is around it
      emit(`static i32 ${sym}_step(porf_coro_call* call, jsval porf_in, i32 porf_in_throw) {\n`);
      emit(`  ${frame}* fr = (${frame}*)call->sl_frame;\n  for (;;) {\n`);
      emit(`    const i32 porf_try_idx = porf_try_depth++;\n`);
      emit(`    if (_setjmp(porf_try_ensure()[porf_try_idx]) == 0) {\n`);
      emit(`      const i32 porf_done = ${bodySym}(call, porf_in, porf_in_throw);\n`);
      emit(`      porf_try_depth = porf_try_idx;\n      return porf_done;\n    }\n`);
      emit(`    porf_try_depth = porf_try_idx;\n`);
      emit(`    if (fr->porf_handler == 0) porf_throw(porf_exception);\n`);
      emit(`    fr->porf_state = fr->porf_handler;\n    porf_in = porf_exception;\n    porf_in_throw = 0;\n  }\n}\n\n`);
    }
  };

  const renderFunc = f => {
    cur = partsOf(unitOf(f));
    renderingBuiltin = !!f.internal;
    const plan = stackless.get(f);
    if (plan) {
      renderStackless(f, plan);
      return;
    }
    const ret = CT[f.retType];
    const params = f.params.map(p => `${CT[p.type]} ${sanitize(p.name)}`).join(', ');
    emit(`${needsCoro(f) ? 'PORF_CORO_BODY ' : f.ast?._module ? 'PORF_ONCE ' : coldBuiltin(f.name) ? 'PORF_COLD ' : NEVER_INLINE.has(f.name) ? 'PORF_NOINLINE ' : ''}${ret} ${fnSym(f)}(${params || 'void'}) {\n`);
    depth = 1;
    activeTryDepth = 0;
    loopStack.length = 0;
    usedLabels = new Set();
    if (needsCoro(f)) emit(`  porf_coro_prologue();\n`);
    const paramNames = new Set(f.params.map(p => p.name));
    for (const name in f.locals) {
      if (paramNames.has(name)) continue;
      const t = f.locals[name].type;
      emit(`  ${CT[t]} ${sanitize(name)}${t === T.jsval ? ' = JV_UNDEFINED' : ' = 0'};\n`);
    }
    // a no-op unless the program runs coroutines on wasm (see PORF_STACK_CHECK)
    emit(`  PORF_STACK_CHECK();\n`);
    // --ropes: a builtin reads the strings it is given as characters, so a rope is
    // flattened on the way in (once: the rope keeps its flat string)
    emit(ropeFlatten(f));
    renderStmts(f.body);
    emit(`}\n\n`);
  };

  for (const f of linkFuncs) renderFunc(f);

  // runtime prelude: porf.h + porf_runtime.c in split mode
  const runtimeRefs = [];
  const prelude = [];
  const toStr = funcs.find(x => x && x.name === '__ecma262_ToString' && x.body);
  if (toStr) runtimeRefs.push(toStr);
  // the builtins the runtime's == and + hand their slow cases to, when the program has them
  const toNum = funcs.find(x => x && x.name === '__ecma262_ToNumber' && x.body);
  if (toNum) runtimeRefs.push(toNum);
  const toPrimDefault = funcs.find(x => x && x.name === '__ecma262_ToPrimitive_Default' && x.body);
  if (toPrimDefault) runtimeRefs.push(toPrimDefault);
  // what < and friends make of an object operand (hint "number"), when a comparison can see one
  const toPrimNumber = funcs.find(x => x && x.name === '__ecma262_ToPrimitive_Number' && x.body);
  if (toPrimNumber) runtimeRefs.push(toPrimNumber);
  // what an array read finds where no element is stored (the prototype chain, an accessor)
  const arrHole = funcs.find(x => x && x.name === '__Porffor_array_holeGet' && x.body);
  if (arrHole) runtimeRefs.push(arrHole);
  if (promiseResolveFunc) runtimeRefs.push(promiseResolveFunc);
  const stackful = funcs.some(f => needsCoro(f) && !stackless.has(f));
  prelude.push(RUNTIME_HEAD(prefs, usesCoro, toStr ? fnSym(toStr) : null, !usedTypes || usedTypes.has(TYPES.bigint), stackful, toNum ? fnSym(toNum) : null, toPrimDefault ? fnSym(toPrimDefault) : null, toPrimNumber ? fnSym(toPrimNumber) : null, arrHole ? fnSym(arrHole) : null));
  // the resolver the coroutine runtime calls is declared later with the other functions
  const resolveDecl = promiseResolveFunc
    ? `${CT[promiseResolveFunc.retType]} ${fnSym(promiseResolveFunc)}(${promiseResolveFunc.params.map(p => CT[p.type]).join(', ') || 'void'});\n` : '';
  // without the promise builtins, an awaited object is a promise fulfilled with it (there is
  // no resolution to call a thenable's then through)
  const settleAwaited = promiseResolveFunc ? settleAsyncResult : (value, promise) =>
    `*(jsbits*)(MEM + (u32)${promise}.val + PORF_PROMISE_RESULT) = porf_pack(${value});\n  *(u8*)(MEM + (u32)${promise}.val + PORF_PROMISE_STATE) = 1;`;
  if (usesCoro) prelude.push(resolveDecl + CORO_RUNTIME(settleAwaited));

  // link unit head: static data image, globals, gc roots, per-function tables
  const link = [];
  if (data.length > 0 || fnNameSegs.length > 0) {
    // static data is constant bytes at fixed offsets: one contiguous image (holes stay
    // zero) init'd by a single memcpy, emitted as string literals (~1 char per ascii byte)
    const imageBase = 16;
    const image = new Uint8Array(staticEnd - imageBase);
    const writeBytes = (off, bytes) => {
      off -= imageBase;
      for (let k = 0; k < bytes.length; k++) image[off + k] = bytes[k];
    };
    const writeU32 = (off, v) => writeBytes(off, [ v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff ]);
    const writeU64 = (off, bits) => {
      off -= imageBase;
      for (let k = 0; k < 8; k++) image[off + k] = Number((bits >> BigInt(k * 8)) & 0xFFn);
    };

    for (let i = 0; i < linkFuncs.length; i++) writeU32(fnrecBase + i * 8, i);
    for (const { off, bytes } of fnNameSegs) writeBytes(off, bytes);
    for (let i = 0; i < data.length; i++) {
      const seg = data[i];
      const off = dataOffsets[i];
      if (seg.staticArray) {
        const items = seg.staticArray;
        writeU32(off, items.length);
        writeU32(off + 4, off + 16);
        writeU32(off + 8, items.length);
        for (let j = 0; j < items.length; j++) {
          const it = items[j];
          const dst = off + 16 + j * 8;
          if (it.num !== undefined) {
            if (it.num === 0 && 1 / it.num === Infinity) writeU64(dst, JV_ZERO_BITS);
              else writeBytes(dst, ieee754_binary64(it.num));
          } else if (it.str !== undefined) {
            writeU64(dst, jvConstBits(TYPES.bytestring, dataOffsets[it.str]));
          } else {
            writeU64(dst, jvConstBits(it.jvType, it.payload));
          }
        }
        continue;
      }
      writeBytes(off, seg);
      // a constant literal's template points at other segments (its strings, nested
      // templates): their addresses, known only now, as a u32, an f64 or a packed jsval
      for (const r of dataRelocs[i] ?? []) {
        const addr = dataOffsets[r.seg];
        if (r.kind === 'u32') writeU32(off + r.off, addr);
          else if (r.kind === 'f64') writeBytes(off + r.off, ieee754_binary64(addr));
          else writeU64(off + r.off, jvConstBits(r.type, addr));
      }
    }

    let blob = image, blobLen = image.length;
    let init = `static void porf_data_init(void) {\n  memcpy(MEM + ${imageBase}, porf_data, ${image.length}u);\n}\n\n`;
    if (prefs.compressData && image.length > 0) {
      const compressed = lz4Compress(image);
      if (compressed.len < image.length) {
        blob = compressed.out;
        blobLen = compressed.len;
        init = LZ4_DECODE + `static void porf_data_init(void) {\n  porf_lz4_decode(porf_data, ${blobLen}u, MEM + ${imageBase});\n}\n\n`;
      }
    }

    // printable ascii stays literal (except " \ ?, dodging trigraphs), the rest fixed-width
    // octal so a following digit can't extend the escape
    const esc = [];
    for (let b = 0; b < 256; b++) {
      esc.push(b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x3f && b !== 0x5c ?
        String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0'));
    }

    const lines = [];
    let parts = [], len = 0;
    for (let i = 0; i < blobLen; i++) {
      const e = esc[blob[i]];
      parts.push(e);
      len += e.length;
      if (len >= 4000) {
        lines.push('"' + parts.join('') + '"');
        parts = [];
        len = 0;
      }
    }
    if (parts.length > 0 || lines.length === 0) lines.push('"' + parts.join('') + '"');

    link.push(`static const u8 porf_data[] =\n${lines.join('\n')};\n${init}`);
  } else {
    link.push('static void porf_data_init(void) {}\n\n');
  }

  const proto = f => `${CT[f.retType]} ${fnSym(f)}(${f.params.map(p => CT[p.type]).join(', ') || 'void'});\n`;
  const linkProtos = [
    `${st}jsval porf_call_dynamic(jsval fn, jsval thisv, jsval newtv, i32 argc, jsbits* argv);\n`,
    `${st}jsval porf_call_dynamic_arr(jsval fn, jsval thisv, jsval newtv, jsval arr);\n`,
    `${st}i32 porf_arr_dense(u32 a);\n`,
    // plain dynamic calls of up to 3 arguments: a size build (-Os/-Oz) calls porf_callN,
    // which packs the arguments, so no site carries the packing; a speed build packs them
    // at the site as any other call, where clang is free to inline the dispatch (going
    // through porf_callN costs richards 1.6%)
    `#ifdef __OPTIMIZE_SIZE__
${st}jsval porf_call0(jsval fn, jsval thisv);
${st}jsval porf_call1(jsval fn, jsval thisv, jsval a0);
${st}jsval porf_call2(jsval fn, jsval thisv, jsval a0, jsval a1);
${st}jsval porf_call3(jsval fn, jsval thisv, jsval a0, jsval a1, jsval a2);
#define PORF_CALL0(fn, thisv) porf_call0(fn, thisv)
#define PORF_CALL1(fn, thisv, a0) porf_call1(fn, thisv, a0)
#define PORF_CALL2(fn, thisv, a0, a1) porf_call2(fn, thisv, a0, a1)
#define PORF_CALL3(fn, thisv, a0, a1, a2) porf_call3(fn, thisv, a0, a1, a2)
#else
#define PORF_CALL0(fn, thisv) porf_call_dynamic(fn, thisv, JV_UNDEFINED, 0, (jsbits[]){ JV_UNDEFINED_BITS })
#define PORF_CALL1(fn, thisv, a0) porf_call_dynamic(fn, thisv, JV_UNDEFINED, 1, (jsbits[]){ porf_pack(a0) })
#define PORF_CALL2(fn, thisv, a0, a1) porf_call_dynamic(fn, thisv, JV_UNDEFINED, 2, (jsbits[]){ porf_pack(a0), porf_pack(a1) })
#define PORF_CALL3(fn, thisv, a0, a1, a2) porf_call_dynamic(fn, thisv, JV_UNDEFINED, 3, (jsbits[]){ porf_pack(a0), porf_pack(a1), porf_pack(a2) })
#endif
`
  ];
  if (usesSyncAsync) linkProtos.push(`${st}jsval porf_async_call_sync(u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv);\n`);
  if (usesCoro) {
    // coroutine entry points called from user code / builtins above their definitions
    linkProtos.push(`${st}jsval porf_coro_start(u8 flags, u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv);\n`);
    linkProtos.push(`${st}i32 __Porffor_coroutine_resume(jsval gen, jsval value, i32 mode);\n`);
    linkProtos.push(`${st}jsval __Porffor_coroutine_value(jsval gen);\n`);
    linkProtos.push(`${st}i32 __Porffor_coroutine_awaiting(jsval gen);\n`);
    linkProtos.push(`${st}i32 __Porffor_coroutine_returning(void);\n`);
  }
  if (!split) {
    for (const f of linkFuncs) link.push(proto(f));
    link.push(...linkProtos);
  }

  // module globals (top-level JS bindings)
  for (const g of globals) link.push(`${st}${CT[g.type]} ${sanitize(g.name)}${g.type === T.jsval ? ` = {0.0, ${TYPES.undefined}}` : ''};\n`);
  link.push('\n');
  if (gcEnabled) {
    const markGlobalRootLines = [];
    const markGlobalRawLines = [];
    // the value globals: a table of their addresses, walked by one loop (a call per global
    // would be code for each)
    const jsvalRoots = [];
    for (const g of globals) {
      const name = sanitize(g.name);
      if (g.type === T.jsval) jsvalRoots.push(`&${name}`);
      // (builtin globals holding a raw block: the miss cache is marked like any other)
      else if (g.type === T.ptr || (g.type === T.i32 && /(?:underlyingStore|underlyingBuckets|__Porffor_regex_cache|missCache|__Porffor_json_buf)$/.test(g.name))) {
        if (/underlyingStore$/.test(g.name)) {
          const buckets = sanitize(g.name.replace(/underlyingStore$/, 'underlyingBuckets'));
          const bucketsCap = sanitize(g.name.replace(/underlyingStore$/, 'underlyingBucketsCap'));
          markGlobalRawLines.push(`  if (porf_gc_mark_underlying_store((i32)${name})) { ${buckets} = 0; ${bucketsCap} = 0; }`);
        }
        else if (/underlyingBuckets$/.test(g.name)) markGlobalRawLines.push(`  porf_gc_mark_raw((i32)${name});`);
        else if (/__Porffor_regex_cache$/.test(g.name)) markGlobalRawLines.push(`  porf_gc_mark_regex_cache((i32)${name});`);
        else if (/getptr_/.test(g.name)) {
          const builtinName = g.name.slice(g.name.lastIndexOf('getptr_') + 'getptr_'.length);
          markGlobalRootLines.push(`  if (${name} != 0) porf_gc_mark_js((f64)${name}, ${funcByName.has(builtinName) ? TYPES.function : TYPES.object});`);
        }
        else markGlobalRawLines.push(`  porf_gc_mark_raw((i32)${name});`);
      }
    }
    if (jsvalRoots.length) {
      link.push(`static jsval* const porf_gc_jsval_roots[] = { ${jsvalRoots.join(', ')} };\n`);
      markGlobalRootLines.unshift(`  for (u32 i = 0; i < ${jsvalRoots.length}u; i++) porf_gc_mark_js(porf_gc_jsval_roots[i]->val, porf_gc_jsval_roots[i]->type);`);
    }
    link.push(`${st}void porf_gc_mark_global_roots(void) {\n${markGlobalRootLines.join('\n') || '  (void)0;'}\n}\n\n`);
    link.push(`${st}void porf_gc_mark_global_raw_roots(void) {\n${markGlobalRawLines.join('\n') || '  (void)0;'}\n}\n\n`);
    link.push(usesCoro
      ? `${st}void porf_gc_mark_coro_roots(void) {\n  for (i32 i = 0; i < porf_coro_live_len; i++) {\n    porf_coro* c = porf_coro_live[i];\n    if (c) porf_coro_gc_mark_suspended(c, 0);\n  }\n  // each coroutine once per collection: under P3, switches on concurrent threads can leave\n  // the parent links in a cycle, which this walk would otherwise follow forever\n  const u32 walk = ++porf_coro_gc_walk_epoch;\n  for (porf_coro* c = porf_coro_cur; c && c->gc_walk != walk; c = c->parent) {\n    c->gc_walk = walk;\n    porf_coro_gc_mark_active(c);\n  }\n}\n\n${st}void porf_gc_mark_coro_handle(uintptr_t raw) {\n  porf_coro_gc_mark_handle((porf_coro_call*)raw);\n}\n\n${st}void porf_gc_finalize_body(i32 body, i32 type) {\n  if (type == ${TYPES.__porffor_generator} || type == ${TYPES.__porffor_asyncgenerator}) {\n    uintptr_t raw = *(uintptr_t*)(MEM + body);\n    *(uintptr_t*)(MEM + body) = 0;\n    porf_coro_call_free((porf_coro_call*)raw);\n  }\n}\n\n`
      : `${st}void porf_gc_mark_coro_roots(void) {}\n${st}void porf_gc_mark_coro_handle(uintptr_t raw) { (void)raw; }\n${st}void porf_gc_finalize_body(i32 body, i32 type) { (void)body; (void)type; }\n\n`);
  }

  // per-function metadata tables, emitted before bodies so __Porffor_funcLut_* can read them.
  // porf_fnflags: bits 0-2 coroutine dispatch (masked off in porf_call_dynamic), bit 3 callable,
  // bit 4 constructor, funcLut.flags recovers legacy callable|constr<<1 via (flags >> 3) & 3
  link.push(`${st}const u8 porf_fnflags[] = { ${linkFuncs.map(fnFlags).join(', ') || '0'} };\n`);
  if (usesSyncAsync) link.push(`${st}const u8 porf_fnneeds_coro[] = { ${linkFuncs.map(f => needsCoro(f) ? 1 : 0).join(', ') || '0'} };\n`);
  // porf_fnkind: a program's own function's coroutine kind (a builtin's 0: Array.fromAsync is
  // no async function to the program), for __Porffor_funcLut_kind
  if (usesFnKind) link.push(`${st}const u8 porf_fnkind[] = { ${linkFuncs.map(f => f?.internal ? 0 : coroKind(f)).join(', ') || '0'} };\n`);
  link.push(`${st}const u16 porf_fnlen[] = { ${linkFuncs.map(f => f.jsLength ?? 0).join(', ') || '0'} };\n`);
  link.push(`${st}const u32 porf_fnname[] = { ${fnNameOff.join(', ') || '0'} };\n`);
  link.push(`const u32 porf_static_end = ${staticEnd}u;\n`);
  if (split) {
    link.push(`const u32 porf_fnrecs = ${fnrecBase}u;\n`);
    for (const u of unitOrder) link.push(`const u32 porf_fnbase_${sanitize(u)} = ${fnBase[u]}u;\nconst u32 porf_dbase_${sanitize(u)} = ${dbase[u]}u;\n`);
  }
  link.push('\n');

  cur = partsOf('main');
  for (const f of linkFuncs) cur.protos[f.index] = f;

  // dynamic call: fn values are records [fnIdx u32][env u32] (payload = offset, nonzero =
  // truthy). porf_invoke adapts the uniform (env,thisv,newtv,argc,argv) ABI to each
  // function's specialized C signature. By default one switch case per function does that
  // inline; with --invoke-table, functions with the same signature share one case and are
  // reached through a table of (shape, pointer), so the adapter code is emitted once per
  // signature rather than once per function (1270 cases -> a few dozen in a large app).
  const invokeAdapter = f => {
    const pre = [];
    const args = [];
    let j = 0;
    for (const p of f.params) {
      if (p.name === '#env') { args.push('env'); continue; }
      if (p.name === '#this') { args.push('thisv'); continue; }
      if (p.name === '#newtarget') { args.push('newtv'); continue; }
      if (p.name === '#callee') { args.push('callee'); continue; }
      if (p.name === '#allargs') {
        pre.push('u32 _aa = porf_arr_new(argc, argc > 4 ? argc : 4);');
        pre.push('for (i32 _k = 0; _k < argc; _k++) porf_arr_set(_aa, (u32)_k, porf_unpack(argv[_k]));');
        args.push(`porf_box((f64)_aa, ${TYPES.array})`);
        continue;
      }
      if (p.name === '#rest') {
        // pack remaining argv into an array (twin helpers; die at step 3)
        pre.push(`u32 _rest = porf_arr_new(0, argc > ${j} ? argc - ${j} : 4);`);
        pre.push(`for (i32 _k = ${j}; _k < argc; _k++) (void)porf_arr_push(_rest, porf_unpack(argv[_k]));`);
        args.push(`porf_box((f64)_rest, ${TYPES.array})`);
        continue;
      }
      const src = `porf_unpack(argc > ${j} ? argv[${j}] : JV_UNDEFINED_BITS)`;
      if (p.type === T.f64) args.push(`(${src}).val`);
        else if (p.type === T.i64 || p.type === T.u64) args.push(`(i64)(${src}).val`);
        else if (p.type === T.i32 || p.type === T.u32 || p.type === T.ptr) args.push(`(i32)(${src}).val`);
        else args.push(src);
      j++;
    }
    const ret = call => f.retType === T.none ? `${call}; return JV_UNDEFINED;`
      : f.retType === T.f64 ? `return porf_box_num(${call});`
      : f.retType === T.i64 || f.retType === T.u64 ? `return porf_box_num((f64)${call});`
      : f.retType === T.i32 || f.retType === T.u32 || f.retType === T.ptr ? `return porf_box_num((f64)${call});`
      : `return ${call};`;
    return { pre, args, ret };
  };
  const invokable = f => f.indirect || needsCoro(f) || isSyncAsync(f);

  const invokeCase = (f, i) => {
    const { pre, args, ret } = invokeAdapter(f);
    const body = ret(`${fnSym(f)}(${args.join(', ')})`);
    return pre.length ? `    case ${i}: { ${pre.join(' ')} ${body} }\n` : `    case ${i}: ${body}\n`;
  };
  // the builtins callable as values (Error, Symbol...) in a dispatch of their own, out of line:
  // the program's own stay a switch small enough for clang to inline at a call site, where a
  // known callee then folds to a direct call (run(f) with f a constant)
  const builtinInvokes = prefs.invokeTable ? [] : linkFuncs.map((f, i) => [ f, i ]).filter(([ f ]) => invokable(f) && f.internal);
  if (builtinInvokes.length > 0) {
    emit(`PORF_NOINLINE static jsval porf_invoke_builtin(u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv) {\n`);
    emit('  (void)callee; (void)env; (void)thisv; (void)newtv; (void)argc; (void)argv;\n');
    emit('  switch (idx) {\n');
    for (const [ f, i ] of builtinInvokes) emit(invokeCase(f, i));
    emit('  }\n  porf_unreachable("uncompiled function");\n  return JV_UNDEFINED;\n}\n');
  }

  emit(`${st}jsval porf_invoke(u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv) {\n`);
    emit('  (void)callee; (void)env; (void)thisv; (void)newtv; (void)argc; (void)argv;\n');
    if (!prefs.invokeTable) {
      emit('  switch (idx) {\n');
      for (let i = 0; i < linkFuncs.length; i++) {
        const f = linkFuncs[i];
        if (!invokable(f) || f.internal && builtinInvokes.length > 0) continue;
        emit(invokeCase(f, i));
      }
      // argv handed on as a copy with constant indices: passed as it is, the call site's
      // argument array escapes and stays in memory, 16 stores a call, where otherwise clang
      // keeps it in registers (an argv of more than 16 is passed as it is)
      if (builtinInvokes.length > 0) emit('    default: {\n' +
        '      if (argc > 16) return porf_invoke_builtin(idx, callee, env, thisv, newtv, argc, argv);\n' +
        '      jsbits copy[16];\n' +
        '      for (i32 k = 0; k < 16; k++) if (k < argc) copy[k] = argv[k];\n' +
        '      return porf_invoke_builtin(idx, callee, env, thisv, newtv, argc, copy);\n' +
        '    }\n');
      emit('  }\n');
    } else {
      // a shape is the exact C signature plus how each parameter is fed; call_indirect
      // checks the signature, so the pointer type must match the function's own exactly
      const shapes = new Map();
      const entries = [];
      for (let i = 0; i < linkFuncs.length; i++) {
        const f = linkFuncs[i];
        if (!invokable(f)) { entries.push(null); continue; }
        const cSig = `${CT[f.retType]} (*)(${f.params.map(p => CT[p.type]).join(', ') || 'void'})`;
        const key = JSON.stringify([ cSig, f.retType, f.params.map(p => p.name.startsWith('#') ? p.name : p.type) ]);
        let shape = shapes.get(key);
        if (!shape) {
          shape = { id: shapes.size + 1, f, cSig };
          shapes.set(key, shape);
        }
        entries.push(`{ ${shape.id}u, (void (*)(void))${fnSym(f)} }`);
      }
      emit('  static const struct { u16 shape; void (*fn)(void); } porf_invoke_table[] = {\n');
      for (const e of entries) emit(`    ${e ?? '{ 0u, 0 }'},\n`);
      emit('  };\n');
      emit(`  if (idx >= ${entries.length}u) porf_unreachable("uncompiled function");\n`);
      emit('  void (*const fn)(void) = porf_invoke_table[idx].fn;\n');
      emit('  switch (porf_invoke_table[idx].shape) {\n');
      for (const shape of shapes.values()) {
        const { pre, args, ret } = invokeAdapter(shape.f);
        const ptr = `((${shape.cSig})fn)`;
        const body = ret(`${ptr}(${args.join(', ')})`);
        emit(pre.length ? `    case ${shape.id}: { ${pre.join(' ')} ${body} }\n` : `    case ${shape.id}: ${body}\n`);
      }
      emit('  }\n');
    }
    emit('  porf_unreachable("uncompiled function");\n  return JV_UNDEFINED;\n}\n');

    if (usesCoro || usesSyncAsync) {
      emit(`
${st}jsval porf_promise_settled(jsval value, i32 state) {
  const u32 p = porf_alloc(PORF_PROMISE_SIZE, ${TYPES.promise});
  *(jsbits*)(MEM + p + PORF_PROMISE_RESULT) = porf_pack(value);
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_TAIL) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_TAIL) = 0;
  *(jsbits*)(MEM + p + PORF_PROMISE_PAYLOAD) = JV_UNDEFINED_BITS;
  *(u8*)(MEM + p + PORF_PROMISE_STATE) = (u8)state;
  *(u8*)(MEM + p + PORF_PROMISE_FLAGS) = 0;
  *(u8*)(MEM + p + PORF_PROMISE_HANDLED) = 0;
  return porf_box((f64)p, ${TYPES.promise});
}

${st}jsval porf_promise_rejected(jsval value) {
  return porf_promise_settled(value, 2);
}
`);
    }

    if (usesSyncAsync) {
      emit(`
${st}jsval porf_async_call_sync(u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv) {
  const i32 try_idx = porf_try_depth++;
  if (_setjmp(porf_try_ensure()[try_idx]) == 0) {
    const jsval result = porf_invoke(idx, callee, env, thisv, newtv, argc, argv);
    porf_try_depth = try_idx;
    const jsval out_promise = porf_promise_settled(JV_UNDEFINED, 0);
    ${settleAsyncResult('result', 'out_promise')}
    return out_promise;
  }

  porf_try_depth = try_idx;
  return porf_promise_rejected(porf_exception);
}
`);
    }

	    if (usesCoro) {
	      emit(`
	static u32 porf_arr_new_typed(i32 len, i32 cap, i32 type) {
	  if (cap < len) cap = len;
	  if (cap < 4) cap = 4;
	  const u32 a = porf_alloc(16 + ((u32)cap << 3), type);
	  PORF_ARR_LEN(a) = len; PORF_ARR_ENT(a) = a + 16; PORF_ARR_CAP(a) = cap;
	  memset(MEM + a + 12, 0, 4 + ((size_t)cap << 3)); // (PORF_ARR_KIND and the entries)
	  return a;
	}

static void porf_coro_call_thunk(void* arg) {
  porf_coro_call* call = (porf_coro_call*)arg;
  call->result = porf_invoke(call->idx, call->callee, call->env, call->thisv, call->newtv, call->argc, call->argv);
}

static porf_coro_call* porf_coro_call_new(u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv) {
  porf_coro_call* call = porf_coro_call_alloc();
  call->coro.live_idx = -1;
  call->idx = idx;
  call->callee = callee;
  call->env = env;
  call->thisv = thisv;
  call->newtv = newtv;
  call->argc = argc;
  call->argv = argc > 0 ? malloc((size_t)argc * sizeof(jsbits)) : 0;
  if (argc > 0 && !call->argv) abort();
  for (i32 i = 0; i < argc; i++) call->argv[i] = argv[i];
  call->result = JV_UNDEFINED;
  return call;
}

static i32 porf_coro_call_step(porf_coro_call* call, jsval value, i32 is_throw) {
  if (call->sl) {
    // on the caller's stack, like any call: porf_coro_cur and the stack top stay as they are
    call->coro.state = 1;
    if (call->started) return call->sl_step(call, value, is_throw);
    call->started = 1;
    porf_coro_live_add(&call->coro);
    porf_sl_starting = call;
    (void)porf_invoke(call->idx, call->callee, call->env, call->thisv, call->newtv, call->argc, call->argv);
    return call->coro.state == 3;
  }
  if (!call->started) {
    call->started = 1;
    return porf_coro_enter(&call->coro, porf_coro_call_thunk, call);
  }

  return is_throw ?
    porf_coro_resume_throw(&call->coro, value) :
    porf_coro_resume(&call->coro, value);
}

static void porf_promise_run_coro_reaction_coro(u32 reaction) {
  porf_coro_call* call = (porf_coro_call*)(uintptr_t)*(u64*)(MEM + reaction + PORF_REACTION_HANDLER);
  const jsval out_promise = porf_unpack(*(jsbits*)(MEM + reaction + PORF_REACTION_OUT_PROMISE));
  const jsval value = porf_unpack(*(jsbits*)(MEM + reaction + PORF_REACTION_VALUE));
  const i32 is_throw = (i32)*(u32*)(MEM + reaction + PORF_REACTION_PAYLOAD);

  const i32 try_idx = porf_try_depth++;
  if (_setjmp(porf_try_ensure()[try_idx]) == 0) {
    const i32 done = porf_coro_call_step(call, value, is_throw);
    porf_try_depth = try_idx;
    if (done) {
      const jsval result = call->result;
      porf_coro_call_free(call);
      ${settleAsyncResult('result', 'out_promise')}
      return;
    }

    porf_promise_attach_coro(call->coro.channel, call, out_promise);
    return;
  }

  porf_try_depth = try_idx;
  if (!call->sl) {
    porf_coro_set_current_stack_top(call->coro.caller_stack_top);
    porf_coro_cur = call->coro.parent;
  }
  call->coro.state = 3;
  porf_coro_call_free(call);
  porf_promise_settle_direct(out_promise, porf_exception, 2);
}

	static jsval porf_coro_box(porf_coro_call* call, i32 type) {
	  const u32 p = porf_alloc((u32)sizeof(uintptr_t), type);
	  *(uintptr_t*)(MEM + p) = (uintptr_t)call;
	  call->box_body = p;
	  call->box_type = type;
	#if PORF_GC_ENABLED
	  porf_gc_set_kind((i32)p, (u32)type);
	#endif
	  return porf_box((f64)p, type);
	}

static porf_coro_call* porf_coro_unbox(jsval gen) {
  const i32 type = porf_jv_type(gen);
  if (type != ${TYPES.__porffor_generator} && type != ${TYPES.__porffor_asyncgenerator}) {
    porf_throw_new(${TYPES.typeerror}, 0);
  }
  return (porf_coro_call*)(uintptr_t)(*(uintptr_t*)(MEM + (u32)gen.val));
}

// TS-facing coroutine mechanism (generator.ts + for-of build the iterator protocol and
// the { value, done } result on top of these). mode: 0 = next, 1 = throw the value at the
// suspend point, 2 = return: at a yield, the body returns the value from there, through its
// finally blocks (codegen checks __Porffor_coroutine_returning after each yield), and not
// yet started or done, completes with the value; 3 = complete with the value without
// running the body. returns 1 once done.
static i32 porf_gen_returning = 0;

${st}i32 __Porffor_coroutine_returning(void) {
  const i32 returning = porf_gen_returning;
  porf_gen_returning = 0;
  return returning;
}

	${st}i32 __Porffor_coroutine_resume(jsval gen, jsval value, i32 mode) {
	  porf_coro_call* call = porf_coro_unbox(gen);
	  if (mode == 3 || call->coro.state == 3 || (mode == 2 && !call->started)) {
	    if (call->coro.state != 3) {
	      porf_coro_live_remove(&call->coro);
	      porf_coro_stack_free(&call->coro);
	    }
	    call->coro.state = 3;
	    call->result = value;
	    return 1;
  }

  // boundary for an exception escaping the coroutine body (uncaught inside, or
  // re-raised by a finally during a throw). without it the throw longjmps across
  // the coroutine's separate stack with no landing pad on the resumer side and
  // hits the top-level uncaught handler. mirrors the guard in porf_coro_start /
  // the promise-reaction resume, but re-raises on the caller's stack since the
  // sync .next/.throw/.return driver has no out-promise to settle.
  porf_gen_returning = mode == 2;
  const i32 try_idx = porf_try_depth++;
  if (_setjmp(porf_try_ensure()[try_idx]) == 0) {
    const i32 done = porf_coro_call_step(call, value, mode == 1);
    porf_try_depth = try_idx;
    porf_gen_returning = 0;
    return done;
  }

  porf_try_depth = try_idx;
  porf_gen_returning = 0;
  if (!call->sl) {
    porf_coro_set_current_stack_top(call->coro.caller_stack_top);
    porf_coro_cur = call->coro.parent;
  }
  porf_coro_live_remove(&call->coro);
  porf_coro_stack_free(&call->coro);
  call->coro.state = 3;
  if (porf_jv_eq(porf_exception, PORF_CORO_RETURN)) return 1;
  porf_throw(porf_exception);
}

// the value the coroutine just produced: its final return value once done, otherwise the
// most recently yielded value
${st}jsval __Porffor_coroutine_value(jsval gen) {
  porf_coro_call* call = porf_coro_unbox(gen);
  return call->coro.state == 3 ? call->result : call->coro.channel;
}

// whether it is suspended at an await (its value is the pending promise) rather than a
// yield: an async generator's driver waits those out instead of handing them to the consumer
${st}i32 __Porffor_coroutine_awaiting(jsval gen) {
  porf_coro_call* call = porf_coro_unbox(gen);
  return call->coro.state == 2 && call->coro.awaiting;
}

${st}jsval porf_coro_start(u8 flags, u32 idx, jsval callee, u32 env, jsval thisv, jsval newtv, i32 argc, jsbits* argv) {
	  porf_promise_run_coro_reaction_impl = porf_promise_run_coro_reaction_coro;
	  porf_coro_call* call = porf_coro_call_new(idx, callee, env, thisv, newtv, argc, argv);
	  call->sl = (flags & ${FN_STACKLESS}u) != 0;
	  const u8 kind = flags & 7u;

	  if (kind == ${FN_GENERATOR} || kind == ${FN_ASYNC_GENERATOR}) {
	    if (flags & ${FN_CORO_INIT}u) {
	      const i32 try_idx = porf_try_depth++;
	      if (_setjmp(porf_try_ensure()[try_idx]) == 0) {
	        (void)porf_coro_call_step(call, JV_UNDEFINED, 0);
	        porf_try_depth = try_idx;
	      } else {
	        porf_try_depth = try_idx;
	        if (!call->sl) {
	          porf_coro_set_current_stack_top(call->coro.caller_stack_top);
	          porf_coro_cur = call->coro.parent;
	        }
	        call->coro.state = 3;
	        porf_coro_call_free(call);
	        porf_throw(porf_exception);
	      }
	    }
	    return porf_coro_box(call, kind == ${FN_GENERATOR} ? ${TYPES.__porffor_generator} : ${TYPES.__porffor_asyncgenerator});
	  }

  const jsval out_promise = porf_promise_pending();
	  const i32 try_idx = porf_try_depth++;
	  if (_setjmp(porf_try_ensure()[try_idx]) == 0) {
	    const i32 done = porf_coro_call_step(call, call->coro.channel, 0);
	    porf_try_depth = try_idx;
	    if (done) {
	      jsval result = call->result;
	      porf_coro_call_free(call);
	      ${settleAsyncResult('result', 'out_promise')}
	    } else {
	      porf_promise_attach_coro(call->coro.channel, call, out_promise);
	    }
	    return out_promise;
	  }

	  porf_try_depth = try_idx;
	  if (!call->sl) {
	    porf_coro_set_current_stack_top(call->coro.caller_stack_top);
	    porf_coro_cur = call->coro.parent;
	  }
	  call->coro.state = 3;
	  porf_coro_call_free(call);
	  porf_promise_settle_direct(out_promise, porf_exception, 2);
	  return out_promise;
	}
	`);
    }
    emit(`${st}jsval porf_call_dynamic(jsval fn, jsval thisv, jsval newtv, i32 argc, jsbits* argv) {
  if (porf_jv_type(fn) != ${TYPES.function}) porf_throw_not_callable(fn);
  const u32 rec = (u32)fn.val;
  const u32 idx = *(u32*)(MEM + rec);
  const u32 env = *(u32*)(MEM + rec + 4);
  if (idx >= ${linkFuncs.length}u) porf_unreachable("bad function index");
  const u8 flags = porf_fnflags[idx] & (7u | ${FN_CORO_INIT}u | ${FN_STACKLESS}u);
  const u8 kind = flags & 7u;
  if (!porf_jv_eq(newtv, JV_UNDEFINED) && kind != 0) porf_throw_new(${TYPES.typeerror}, 0);
  ${usesCoro || usesSyncAsync ? `if (kind != 0) {
    ${usesSyncAsync ? `if (kind == ${FN_ASYNC}u && !porf_fnneeds_coro[idx]) return porf_async_call_sync(idx, fn, env, thisv, newtv, argc, argv);` : ''}
    ${usesCoro ? 'return porf_coro_start(flags, idx, fn, env, thisv, newtv, argc, argv);' : 'porf_unreachable("bad coroutine dispatch");'}
  }` : ''}
  return porf_invoke(idx, fn, env, thisv, newtv, argc, argv);
}
// spread calls use array iteration semantics: holes become present undefined values.
// whether an array stores every entry up to its length (no holes): what apply may pass as
// it is, a hole being a read through the prototype chain
${st}i32 porf_arr_dense(u32 a) {
  const i32 len = PORF_ARR_LEN(a);
  if (len > PORF_ARR_CAP(a)) return 0;
  const jsbits* ent = (const jsbits*)(MEM + PORF_ARR_ENT(a));
  for (i32 i = 0; i < len; i++) if (ent[i] == 0) return 0;
  return 1;
}
${st}jsval porf_call_dynamic_arr(jsval fn, jsval thisv, jsval newtv, jsval arr) {
  const u32 a = (u32)arr.val;
  const i32 argc = PORF_ARR_LEN(a);
  // (every entry up to the length read, so allocated)
  porf_arr_grow(a, argc);
  jsbits* argv = (jsbits*)(MEM + PORF_ARR_ENT(a));
  for (i32 i = 0; i < argc; i++) {
    if (argv[i] == 0) {
      jsbits* dense = argc > 0 ? (jsbits*)malloc((size_t)argc * sizeof(jsbits)) : NULL;
      for (i32 j = 0; j < argc; j++) dense[j] = argv[j] == 0 ? JV_UNDEFINED_BITS : argv[j];
      const jsval out = porf_call_dynamic(fn, thisv, newtv, argc, dense);
      free(dense);
      return out;
    }
  }
  return porf_call_dynamic(fn, thisv, newtv, argc, argv);
}
#ifdef __OPTIMIZE_SIZE__
// plain calls (no new.target) of up to 3 arguments, packed here rather than at each site
PORF_NOINLINE ${st}jsval porf_call0(jsval fn, jsval thisv) {
  jsbits argv[1] = { JV_UNDEFINED_BITS };
  return porf_call_dynamic(fn, thisv, JV_UNDEFINED, 0, argv);
}
PORF_NOINLINE ${st}jsval porf_call1(jsval fn, jsval thisv, jsval a0) {
  jsbits argv[1] = { porf_pack(a0) };
  return porf_call_dynamic(fn, thisv, JV_UNDEFINED, 1, argv);
}
PORF_NOINLINE ${st}jsval porf_call2(jsval fn, jsval thisv, jsval a0, jsval a1) {
  jsbits argv[2] = { porf_pack(a0), porf_pack(a1) };
  return porf_call_dynamic(fn, thisv, JV_UNDEFINED, 2, argv);
}
PORF_NOINLINE ${st}jsval porf_call3(jsval fn, jsval thisv, jsval a0, jsval a1, jsval a2) {
  jsbits argv[3] = { porf_pack(a0), porf_pack(a1), porf_pack(a2) };
  return porf_call_dynamic(fn, thisv, JV_UNDEFINED, 3, argv);
}
#endif\n`);

  cur = partsOf('main');
  // the event loop's hooks (split: defined once, here)
  if (split) emit(`void (*porf_event_loop)(void) = 0;\nint (*porf_event_loop_step)(void) = 0;\n`);
  for (const f of cCallables) {
    cur.protos[f.index] = f;
    emit(cCallableDef(f));
  }

  if (entry) {
    // porf_start runs the program's top level; main is porf_start then exit. An embedder
    // defines PORF_NO_MAIN, calls porf_start once, then calls into the program (Porffor.c
    // functions) and drains its job queue with porf_run_jobs.
    const runJobs = funcByName.get('__Porffor_promise_runJobs');
    if (runJobs) cur.protos[runJobs.index] = runJobs;
    emit(`${st}void porf_run_jobs(void) {\n  ${runJobs ? `(void)${fnSym(runJobs)}();` : '// no job queue'}\n}\n\n`);
    // then its event loop, when the runtime started one (a timer: runtime/host/native/timers.js)
    emit(`${st}void porf_start(int argc, char** argv) {\n  porf_init(argc, argv);\n  porf_data_init();\n  ${gcEnabled ? 'volatile int porf_stack_anchor = 0;\n  porf_c_stack_top = (void*)&porf_stack_anchor;\n  ' : ''}${fnSym(funcByName.get(entry))}();\n  if (porf_event_loop) porf_event_loop();\n}\n\n`);
    emit(`#ifndef PORF_NO_MAIN\nint main(int argc, char** argv) {\n  porf_start(argc, argv);\n  return 0;\n}\n#endif\n`);
  }

  if (usesMath) prelude.splice(1, 0, '#include <math.h>\n');
  for (const f of cCallables) prelude.push(`${cCallableProto(f)};\n`);
  // the event loop, when the runtime's C sets its hooks: porf_event_loop runs it after the
  // program's top level (porf_start); porf_event_loop_step runs one turn of it, what a top-level
  // await waits on once no promise job is left (__Porffor_promise_awaitSync): nonzero while
  // something is still pending on it
  prelude.push(split ? 'extern void (*porf_event_loop)(void);\nextern int (*porf_event_loop_step)(void);\n'
    : 'static void (*porf_event_loop)(void);\nstatic int (*porf_event_loop_step)(void);\n');
  if (prefs.rawHead) prelude.push(resolveRawC(prefs.rawHead) + '\n');

  const globalTypes = Object.create(null);
  for (const g of globals) globalTypes[g.name] = g.type;
  const unitText = (u, parts) => {
    const text = [];
    if (split) {
      text.push('#include "porf.h"\n');
      for (const x of Object.keys(parts.fnbases).sort()) text.push(`extern const u32 porf_fnbase_${sanitize(x)};\n`);
      for (const x of Object.keys(parts.dbases).sort()) text.push(`extern const u32 porf_dbase_${sanitize(x)};\n`);
      for (const x of Object.keys(parts.globals).sort()) text.push(`extern ${CT[globalTypes[x]]} ${sanitize(x)};\n`);
      for (const f of parts.protos.filter(Boolean).sort((a, b) => linkIdx[a.index] - linkIdx[b.index])) text.push(proto(f));
      text.push('\n');
      if (u === 'main') text.push(link.join(''));
    }
    return text.concat(parts.chunks, parts.out).join('');
  };

  if (!split) {
    const text = prelude.concat(link);
    for (const u of unitOrder) if (unitParts[u]) text.push(unitText(u, unitParts[u]));
    return text.join('');
  }

  const rt = splitRuntime(prelude.join(''));
  const header = rt.header +
    `extern const u8 porf_fnflags[];\n${usesSyncAsync ? 'extern const u8 porf_fnneeds_coro[];\n' : ''}${usesFnKind ? 'extern const u8 porf_fnkind[];\n' : ''}extern const u16 porf_fnlen[];\nextern const u32 porf_fnname[];\nextern const u32 porf_fnrecs;\n` +
    linkProtos.join('') +
    (entry ? 'void porf_start(int argc, char** argv);\nvoid porf_run_jobs(void);\n' : '');
  const unitName = u => {
    const name = units?.find(x => x.id === u)?.name;
    return name ? name.replace(/^[/]/, '').replace(/[^\w.-]/g, '_') + '.' + u + '.c' : `porf_${sanitize(u)}.c`;
  };
  const files = [
    { name: 'porf.h', c: header },
    { name: 'porf_runtime.c', c: '#include "porf.h"\n' + runtimeRefs.map(proto).join('') + rt.impl }
  ];
  for (const u of unitOrder) if (unitParts[u]) files.push({ name: unitName(u), c: unitText(u, unitParts[u]) });
  return { files };
};

// split runtime C into header declarations and implementation
const splitRuntime = text => {
  const header = [], impl = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
    if (i >= n) break;
    const start = i;

    if (text[i] === '#') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = n;
      while (text[end - 1] === '\\') end = text.indexOf('\n', end + 1);
      header.push(text.slice(start, end));
      impl.push(text.slice(start, end));
      i = end;
      continue;
    }
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      header.push(text.slice(start, end));
      i = end;
      continue;
    }

    let depth = 0, braceAt = -1, eqAt = -1, parenAt = -1;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '"' || c === "'") {
        for (i++; text[i] !== c; i++) if (text[i] === '\\') i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); continue; }
      if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; continue; }
      if (depth === 0 && c === '\n' && text[i + 1] === '#') break;
      if (depth === 0 && braceAt === -1) {
        if (c === '=' && eqAt === -1 && text[i + 1] !== '=') eqAt = i;
        if (c === '(' && eqAt === -1 && parenAt === -1) parenAt = i;
      }
      if (c === '{') { if (braceAt === -1) braceAt = i; depth++; }
      else if (c === '}') {
        depth--;
        // a type or initializer runs on to its `;`, a function body ends here
        if (depth === 0 && eqAt === -1 && !/^(?:typedef|struct|union|enum)\b/.test(text.slice(start, braceAt))) { i++; break; }
      }
      else if (c === ';' && depth === 0) { i++; break; }
    }
    const chunk = text.slice(start, i);
    const spec = chunk.slice(0, Math.min(...[ parenAt, eqAt, braceAt, i ].filter(x => x !== -1)) - start);
    const isType = /^(?:typedef|struct|union|enum)\b/.test(chunk);
    const isFunc = !isType && parenAt !== -1 && braceAt !== -1 && eqAt === -1;
    const isProto = !isType && parenAt !== -1 && braceAt === -1 && eqAt === -1 && !/\(\*\w+\)/.test(chunk);
    const unstatic = str => str.replace(/\bstatic\s+/, '');

    // top-level assembly defines its symbols: once, in the implementation (as a prototype
    // in the header it would be defined again in every unit)
    if (/^__asm__\s*\(/.test(chunk)) impl.push(chunk);
    else if (isType || /^extern\b/.test(chunk) || (isFunc && /\binline\b/.test(spec)) || /^static\s+const\b/.test(chunk)) header.push(chunk);
    else if (isFunc) {
      header.push(unstatic(chunk.slice(0, braceAt - start)).trim() + ';');
      impl.push(unstatic(chunk));
    } else if (isProto) header.push(/\binline\b/.test(chunk) ? chunk : unstatic(chunk));
    else {
      header.push('extern ' + unstatic(eqAt === -1 ? chunk.slice(0, -1) : chunk.slice(0, eqAt - start)).trim() + ';');
      impl.push(unstatic(chunk));
    }
  }
  return { header: header.join('\n') + '\n', impl: impl.join('\n\n') + '\n' };
};

const PORF_BUMP_ALLOC = () => {
  const st = 'static ';
  const sti = 'static inline ';
  return `// ---- arena ----
// fixed-address reserve; commit-on-demand; NEVER moves. 32-bit offsets.
static u32 porf_heap_base = 0;
static u32 porf_heap_cur = 0;
static u32 porf_heap_committed = 0;

static void porf_commit(u32 end) {
  if (end <= porf_heap_committed) return;
  u32 want = (end + (1u << 20)) & ~((1u << 20) - 1);
  if (!PORF_CAN_DECOMMIT || mprotect(MEM, want, PROT_READ | PROT_WRITE) != 0) {
    porf_err("porffor: out of memory (commit "); porf_err_int(want); porf_err(")\\n");
    exit(1);
  }
  porf_heap_committed = want;
}

static void porf_arena_init(void) {
  void* got = mmap(PORF_ARENA_HINT, PORF_ARENA_RESERVE, PORF_MMAP_RESERVE_PROT,
    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (got == MAP_FAILED) {
    porf_err("porffor: failed to reserve arena\\n");
    exit(1);
  }
  porf_mem = (u8*)got;
  porf_heap_base = (porf_static_end + 4095u) & ~4095u;
  porf_heap_cur = porf_heap_base + 8;
  porf_heap_committed = PORF_CAN_DECOMMIT ? 0u : (u32)PORF_ARENA_RESERVE;
  porf_commit(porf_heap_base + 65536u);
}

${ALLOC_PROFILE_C}${st}u32 porf_alloc_slow(u32 bytes);
${sti}u32 porf_alloc(u32 bytes, u32 typeId) {
  PORF_AP_RECORD(bytes, typeId);
  const u32 size = (bytes + 7u) & ~7u;
  const u32 p = porf_heap_cur;
  const u32 next = p + size;
  (void)typeId;
  if (next <= porf_heap_committed) {
    porf_heap_cur = next;
    return p;
  }
  return porf_alloc_slow(size);
}
${st}u32 porf_alloc_slow(u32 size) {
  porf_commit(porf_heap_cur + size);
  const u32 p = porf_heap_cur;
  porf_heap_cur = p + size;
  return p;
}

${st}void porf_gc_barrier_impl(u32 p, i32 type) { (void)p; (void)type; }
${sti}int porf_gc_type_can_reference(i32 type) { (void)type; return 0; }
static inline u32 porf_gc_barrier_ptr_u32(u32 p) { return p; }
static inline u32 porf_gc_barrier_ptr_i32(i32 p) { return (u32)p; }
static inline u32 porf_gc_barrier_ptr_jsval(jsval v) { return (u32)v.val; }
#define porf_gc_barrier(p, type) porf_gc_barrier_impl(_Generic((p), jsval: porf_gc_barrier_ptr_jsval, i32: porf_gc_barrier_ptr_i32, default: porf_gc_barrier_ptr_u32)(p), (type))
static void* porf_c_stack_top = NULL;
${st}i32 porf_gc_native_root_add(f64 value, i32 type) { (void)value; (void)type; return -1; }
${st}void porf_gc_native_root_remove(i32 slot) { (void)slot; }
${st}void porf_gc_collect(int minor) { (void)minor; }

`;
};

const PORF_GC_ALLOC = prefs => {
  const st = 'static ';
  const sti = 'static inline ';

  // size is implicit from the page so objects need no headers
  const classes = [];
  for (let s = 16; s <= 256; s += 16) classes.push(s);
  for (let s = 288; s <= 512; s += 32) classes.push(s);
  for (let s = 576; s <= 1024; s += 64) classes.push(s);
  for (let s = 1152; s <= 2048; s += 128) classes.push(s);
  for (let s = 2304; s <= 4096; s += 256) classes.push(s);
  for (let s = 4608; s <= 8192; s += 512) classes.push(s);
  const lut = [];
  let ci = 0;
  for (let g = 0; g <= 1024; g++) {
    while (classes[ci] < g * 8) ci++;
    lut.push(ci);
  }
  // use multi-page chunks when they reduce tail waste
  const chunkPages = classes.map(c => {
    let best = 1, bw = (8192 - Math.floor(8192 / c) * c) / 8192;
    for (let n = 2; n <= 6; n++) {
      const waste = (n * 8192 - Math.floor(n * 8192 / c) * c) / (n * 8192);
      if (waste < bw - 0.005) { bw = waste; best = n; }
    }
    return best;
  });

  return `static u32 porf_heap_base = 0;
static u32 porf_heap_top = 0;
static u64 porf_heap_committed = 0;

#define PORF_GC_SPAGE 8192u
#define PORF_GC_SPAGE_MASK 8191u
#define PORF_GC_SPAGE_SHIFT 13
#define PORF_GC_NPAGES (1u << 19)
#define PORF_GC_NCLASSES ${classes.length}
#define PORF_GC_MAX_SMALL 8192u
#ifndef PORF_GC_NURSERY_BYTES
#define PORF_GC_NURSERY_BYTES ${Math.min(((parseInt(prefs.gcNursery) || 32) * 1024 * 1024), 256 * 1024 * 1024)}u
#endif

static const u16 porf_gc_cls_size[PORF_GC_NCLASSES] = { ${classes.join(', ')} };
static const u8 porf_gc_cls_pages[PORF_GC_NCLASSES] = { ${chunkPages.join(', ')} };
static const u16 porf_gc_cls_slots[PORF_GC_NCLASSES] = { ${classes.map((c, i) => Math.floor(chunkPages[i] * 8192 / c)).join(', ')} };
static const u8 porf_gc_cls_lut[1025] = { ${lut.join(',')} };

// kind bytes: 0 conservative, 1..195 type IDs, 248+ internal
#define PORF_GC_KIND_ROPE 247u
#define PORF_GC_KIND_OBJECT_ENTRIES 249u
#define PORF_GC_KIND_ARRAY_ENTRIES 250u
#define PORF_GC_KIND_FUNCTION 251u
#define PORF_GC_KIND_UNDERLYING_STORE 252u
#define PORF_GC_KIND_REGEX_CACHE 253u
#define PORF_GC_KIND_LEAF 254u

#define PORF_GC_PK_SMALL 1u
#define PORF_GC_PK_SPAN 2u
#define PORF_GC_PK_TAIL 3u

#define PORF_GC_PF_TOUCHED 1u
#define PORF_GC_PF_FIN 2u
#define PORF_GC_PF_PARTIAL 4u
#define PORF_GC_PF_TAIL 8u

struct porf_gc_page {
  u16 cls;
  u8 flags;
  u8 cidx;
  u16 cursor;
  u16 pad;
  u32 aux; // span page count, tail head index or next partial chunk plus 1
};

static u8* porf_gc_kinds = NULL;
// interleave metadata planes so each granule shares a cache line
static u64* porf_gc_meta = NULL;
#define PORF_GC_B_ALLOC 0u
#define PORF_GC_B_MARK 1u
#define PORF_GC_B_YOUNG 2u
#define PORF_GC_B_AGED 3u
#define porf_gc_widx(g) ((((size_t)(g) >> 9) << 5) | ((size_t)(((g) >> 6) & 7u) << 2))
static u8* porf_gc_cards = NULL;
static u8* porf_gc_page_kind = NULL;
static struct porf_gc_page* porf_gc_pages = NULL;
static u64 porf_gc_free_pages[PORF_GC_NPAGES / 64];
static u32 porf_gc_free_page_cursor = 0;
static u32 porf_gc_free_page_count = 0;

#define porf_gc_gran(p) ((u32)(p) >> 4)
#define porf_gc_bit(plane, g) ((porf_gc_meta[porf_gc_widx(g) + (plane)] >> ((g) & 63u)) & 1ull)
#define porf_gc_bit_set(plane, g) (porf_gc_meta[porf_gc_widx(g) + (plane)] |= 1ull << ((g) & 63u))
#define porf_gc_bit_clear(plane, g) (porf_gc_meta[porf_gc_widx(g) + (plane)] &= ~(1ull << ((g) & 63u)))

struct porf_gc_window { u32 cur, end, lo; };
static struct porf_gc_window porf_gc_active[PORF_GC_NCLASSES];
static u32 porf_gc_partial[PORF_GC_NCLASSES];

static u64 porf_gc_allocation_debt = 0;
static u64 porf_gc_last_live_bytes = 0;
static u64 porf_gc_live_bytes = 0;
static i64 porf_gc_window_bytes = 0;
static i64 porf_gc_span_bytes = 0;
static i64 porf_gc_claimed_since_full = 0;
static i64 porf_gc_promoted_since_full = 0;
static int porf_gc_minor_mode = 0;
static int porf_gc_scan_young_seen = 0;

static const u64 porf_gc_allocation_debt_min = 1ull * 1024ull * 1024ull;
static const u64 porf_gc_allocation_debt_max = 256ull * 1024ull * 1024ull;

static u32* porf_gc_touched = NULL;
static i32 porf_gc_touched_len = 0;
static i32 porf_gc_touched_cap = 0;

static u32* porf_gc_weakmaps = NULL;
static i32 porf_gc_weakmaps_len = 0;
static i32 porf_gc_weakmaps_cap = 0;

struct porf_gc_mark_item { u32 body; i32 type; };
static struct porf_gc_mark_item* porf_gc_mark_queue = NULL;
static i32 porf_gc_mark_queue_len = 0;
static i32 porf_gc_mark_queue_cap = 0;

struct porf_gc_boxed_mark { f64 value; i32 type; };
static struct porf_gc_boxed_mark* porf_gc_boxed_marks = NULL;
static i32 porf_gc_boxed_marks_len = 0;
static i32 porf_gc_boxed_marks_cap = 0;

static u64* porf_gc_static_marks = NULL;
static i32 porf_gc_static_marks_len = 0;
static i32 porf_gc_static_marks_cap = 0;

${st}void porf_gc_collect(int minor);
static void porf_gc_mark_js(f64 value, i32 type);
static void porf_gc_mark_raw(i32 body);
static int porf_gc_mark_underlying_store(i32 body);
static u32 porf_gc_underlying_old = 0;
static void porf_gc_mark_regex_cache(i32 cache);
static void porf_gc_mark_coro_handle(uintptr_t raw);
static void porf_gc_finalize_body(i32 body, i32 type);
static void porf_gc_cons_scan_range(const u64* lo, const u64* hi);
static void porf_gc_mark_global_roots(void);
static void porf_gc_mark_global_raw_roots(void);
static void porf_gc_mark_coro_roots(void);
static void porf_gc_scan_kind_block(i32 body);
static void porf_gc_scan_body(i32 body, i32 type);
static void porf_gc_scan_object_entries_range(i32 entries, u32 from, u32 to);
static u32 porf_gc_span_alloc(u32 bytes, u32 typeId);

static inline u32 porf_gc_align(u32 size) { return (size + 7u) & ~7u; }

static inline u8 porf_gc_kind_for_type(u32 typeId) {
  if (typeId == 0u) return (u8)PORF_GC_KIND_LEAF;
  return typeId <= 195u ? (u8)typeId : 0u;
}

static void porf_commit(u64 end) {
  if (end <= porf_heap_committed) return;
  const u64 want = (end + (1ull << 20)) & ~((1ull << 20) - 1ull);
  if (want > PORF_ARENA_RESERVE) {
    porf_err("porffor: out of memory (commit "); porf_err_int((long long)want); porf_err(")\\n");
    exit(1);
  }
  if (PORF_CAN_DECOMMIT && mprotect(MEM + porf_heap_committed, (size_t)(want - porf_heap_committed), PROT_READ | PROT_WRITE) != 0) {
    porf_err("porffor: out of memory (commit "); porf_err_int((long long)want); porf_err(")\\n");
    exit(1);
  }
  porf_heap_committed = want;
}

static void porf_arena_init(void) {
  void* got = mmap(PORF_ARENA_HINT, PORF_ARENA_RESERVE, PORF_MMAP_RESERVE_PROT,
    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (got == MAP_FAILED) {
    porf_err("porffor: failed to reserve arena\\n");
    exit(1);
  }
  porf_mem = (u8*)got;
  porf_heap_base = (porf_static_end + PORF_GC_SPAGE_MASK) & ~PORF_GC_SPAGE_MASK;
  porf_heap_top = porf_heap_base;
  porf_heap_committed = PORF_CAN_DECOMMIT ? 0ull : (u64)PORF_ARENA_RESERVE;
  porf_commit(porf_heap_base + 65536u);

  const size_t kinds_bytes = (size_t)(PORF_ARENA_RESERVE >> 4);
  const size_t bits_bytes = (size_t)(PORF_ARENA_RESERVE >> 4 >> 3);
  const size_t cards_bytes = (size_t)(PORF_ARENA_RESERVE >> 9);
  const size_t pk_bytes = (size_t)PORF_GC_NPAGES;
  const size_t pm_bytes = (size_t)PORF_GC_NPAGES * sizeof(struct porf_gc_page);
  const size_t side_bytes = kinds_bytes + bits_bytes * 4 + cards_bytes + pk_bytes + pm_bytes;
  u8* side = (u8*)mmap(NULL, side_bytes, PROT_READ | PROT_WRITE,
    MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (side == MAP_FAILED) {
    porf_err("porffor: failed to reserve gc metadata\\n");
    exit(1);
  }
  porf_gc_kinds = side; side += kinds_bytes;
  porf_gc_meta = (u64*)side; side += bits_bytes * 4;
  porf_gc_cards = side; side += cards_bytes;
  porf_gc_page_kind = side; side += pk_bytes;
  porf_gc_pages = (struct porf_gc_page*)side;
}

static inline int porf_gc_in_heap(i32 body) {
  return body > 0 && (u32)body >= porf_heap_base && (u32)body < porf_heap_top;
}
static inline int porf_gc_in_static(i32 body) {
  return body > 0 && (u32)body < porf_heap_base;
}
static inline int porf_gc_static_range(i32 ptr, u64 bytes) {
  return ptr > 0 && (u64)(u32)ptr + bytes <= (u64)porf_heap_base;
}

// allocation bits are only set on object bases. Bounded by the heap top: the bit
// tables only cover the arena, which on wasi is small (64MB), so an out-of-range
// value must not index them
static inline int porf_gc_is_block_start(i32 body) {
  return body > 0 && (u32)body < porf_heap_top && porf_gc_bit(PORF_GC_B_ALLOC, porf_gc_gran(body)) != 0u;
}
static inline int porf_gc_is_young(i32 body) {
  return porf_gc_bit(PORF_GC_B_YOUNG, porf_gc_gran(body)) != 0u;
}
static inline u32 porf_gc_block_size(i32 body) {
  const u32 pg = (u32)body >> PORF_GC_SPAGE_SHIFT;
  const u8 k = porf_gc_page_kind[pg];
  if (k == PORF_GC_PK_SMALL) return porf_gc_pages[pg].cls;
  if (k == PORF_GC_PK_SPAN) return porf_gc_pages[pg].aux << PORF_GC_SPAGE_SHIFT;
  return 0;
}
static inline u32 porf_gc_kind(i32 body) {
  if (!porf_gc_is_block_start(body)) return 0;
  return porf_gc_kinds[porf_gc_gran(body)];
}
// accept freshly bumped objects before allocation bits are published
static inline u32 porf_gc_chunk_start(u32 pg) {
  const u32 head = (porf_gc_pages[pg].flags & PORF_GC_PF_TAIL) != 0u ? porf_gc_pages[pg].aux : pg;
  return head << PORF_GC_SPAGE_SHIFT;
}

static inline void porf_gc_set_kind(i32 body, u32 kind) {
  if (porf_heap_base == 0 || body <= 0) return;
  const u32 pg = (u32)body >> PORF_GC_SPAGE_SHIFT;
  const u8 k = porf_gc_page_kind[pg];
  if (k == PORF_GC_PK_SMALL) {
    if (((u32)body - porf_gc_chunk_start(pg)) % porf_gc_pages[pg].cls != 0u) return;
  } else if (k == PORF_GC_PK_SPAN) {
    if (((u32)body & PORF_GC_SPAGE_MASK) != 0u) return;
  } else return;
  porf_gc_kinds[porf_gc_gran(body)] = (u8)kind;
  if (kind == ${TYPES.__porffor_generator}u || kind == ${TYPES.__porffor_asyncgenerator}u)
    porf_gc_pages[pg].flags |= PORF_GC_PF_FIN;
}

static inline void porf_gc_set_marked_type(i32 body, i32 type) {
  porf_gc_bit_set(PORF_GC_B_MARK, porf_gc_gran(body));
  porf_gc_kinds[porf_gc_gran(body)] = (u8)type;
}
static inline int porf_gc_has_marked_type(i32 body, i32 type) {
  if (!porf_gc_is_block_start(body)) return 0;
  const u32 g = porf_gc_gran(body);
  return porf_gc_bit(PORF_GC_B_MARK, g) != 0u && porf_gc_kinds[g] == (u8)type;
}

static void porf_gc_touch_list(u32 pg) {
  if ((porf_gc_pages[pg].flags & PORF_GC_PF_TOUCHED) != 0u) return;
  porf_gc_pages[pg].flags |= PORF_GC_PF_TOUCHED;
  if (porf_gc_touched_len == porf_gc_touched_cap) {
    const i32 nc = porf_gc_touched_cap == 0 ? 1024 : porf_gc_touched_cap * 2;
    u32* grown = realloc(porf_gc_touched, (size_t)nc * sizeof(u32));
    if (!grown) abort();
    porf_gc_touched = grown;
    porf_gc_touched_cap = nc;
  }
  porf_gc_touched[porf_gc_touched_len++] = pg;
}

static inline void porf_gc_free_page_release(u32 pg) {
  porf_gc_page_kind[pg] = 0;
  porf_gc_free_pages[pg >> 6] |= 1ull << (pg & 63u);
  porf_gc_free_page_count++;
  if (pg < porf_gc_free_page_cursor) porf_gc_free_page_cursor = pg;
}

static u32 porf_gc_free_page_pop(void) {
  if (porf_gc_free_page_count == 0) return 0;
  u32 w = porf_gc_free_page_cursor >> 6;
  const u32 words = porf_heap_top >> PORF_GC_SPAGE_SHIFT >> 6;
  while (w <= words) {
    const u64 word = porf_gc_free_pages[w];
    if (word != 0) {
      const u32 pg = (w << 6) + (u32)__builtin_ctzll(word);
      porf_gc_free_pages[w] &= word - 1;
      porf_gc_free_page_count--;
      porf_gc_free_page_cursor = pg + 1;
      return pg;
    }
    w++;
  }
  porf_gc_free_page_count = 0;
  return 0;
}

static int porf_gc_full_due(i64 additional_claimed) {
  const u64 live_limit = porf_gc_last_live_bytes > 268435456ull ? porf_gc_last_live_bytes : 268435456ull;
  u64 promoted_limit = porf_gc_last_live_bytes / 2u;
  if (promoted_limit < 134217728ull) promoted_limit = 134217728ull;
  if (promoted_limit > 536870912ull) promoted_limit = 536870912ull;
  const i64 claimed = porf_gc_claimed_since_full + additional_claimed;
  return claimed > (i64)live_limit || porf_gc_promoted_since_full > (i64)promoted_limit ||
    (porf_heap_top > 1610612736u && claimed > 67108864ll);
}

static u32 porf_gc_run_cursor = 0;

// exact-size cache for common same-size churn
#define PORF_GC_RUN_CACHE_MAX 16u
static u32 porf_gc_run_cache[PORF_GC_RUN_CACHE_MAX + 1][8];
static u8 porf_gc_run_cache_len[PORF_GC_RUN_CACHE_MAX + 1];

static void porf_gc_release_run(u32 lo, u32 npg) {
  for (u32 k = 0; k < npg; k++) porf_gc_page_kind[lo + k] = 0;
  if (npg >= 2u && npg <= PORF_GC_RUN_CACHE_MAX && porf_gc_run_cache_len[npg] < 8u) {
    porf_gc_run_cache[npg][porf_gc_run_cache_len[npg]++] = lo;
    return;
  }
  for (u32 k = 0; k < npg; k++) porf_gc_free_page_release(lo + k);
}

static void porf_gc_run_cache_drain(void) {
  for (u32 n = 2; n <= PORF_GC_RUN_CACHE_MAX; n++) {
    while (porf_gc_run_cache_len[n] > 0) {
      const u32 lo = porf_gc_run_cache[n][--porf_gc_run_cache_len[n]];
      for (u32 k = 0; k < n; k++) porf_gc_free_page_release(lo + k);
    }
  }
}

static u32 porf_gc_pool_run(u32 npg) {
  if (npg == 1u) return porf_gc_free_page_pop();
  if (npg <= PORF_GC_RUN_CACHE_MAX && porf_gc_run_cache_len[npg] > 0)
    return porf_gc_run_cache[npg][--porf_gc_run_cache_len[npg]];
  if (porf_gc_free_page_count < npg) return 0;
  u32 lo = 0;
  const u32 base = porf_heap_base >> PORF_GC_SPAGE_SHIFT;
  const u32 top = porf_heap_top >> PORF_GC_SPAGE_SHIFT;
  u32 resume = porf_gc_run_cursor;
  if (resume < base || resume >= top) resume = base;
  for (int pass = 0; pass < 2 && lo == 0; pass++) {
    const u32 from = pass == 0 ? resume : base;
    const u32 until = pass == 0 ? top : resume;
    u32 run = 0, start = 0;
    for (u32 pg = from; pg < until; pg++) {
      if (run == 0 && (pg & 63u) == 0u && porf_gc_free_pages[pg >> 6] == 0ull) {
        pg += 63u;
        continue;
      }
      if ((porf_gc_free_pages[pg >> 6] & (1ull << (pg & 63u))) != 0u) {
        if (run == 0) start = pg;
        if (++run == npg) { lo = start; break; }
      } else run = 0;
    }
  }
  if (lo != 0) {
    for (u32 k = 0; k < npg; k++) {
      const u32 pg = lo + k;
      porf_gc_free_pages[pg >> 6] &= ~(1ull << (pg & 63u));
      porf_gc_free_page_count--;
    }
    porf_gc_run_cursor = lo + npg;
  }
  return lo;
}

static u32 porf_gc_claim_pages(u32 npg) {
  u32 lo = porf_gc_pool_run(npg);
  if (lo == 0) {
    if (porf_gc_full_due((i64)npg * (i64)PORF_GC_SPAGE)) {
#ifdef PORF_GC_DEFER
      porf_gc_pending = 2;
#else
      porf_gc_collect(0);
      lo = porf_gc_pool_run(npg);
#endif
    }
    if (lo == 0) {
      if ((u64)porf_heap_top + (u64)npg * PORF_GC_SPAGE >= PORF_ARENA_RESERVE) {
#ifdef PORF_GC_DEFER
        // never collect inside an allocation here: values in wasm locals are invisible to
        // the scan and would be freed while live. Out of memory instead
        return 0;
#else
        porf_gc_collect(0);
        lo = porf_gc_pool_run(npg);
        if (lo == 0 && (u64)porf_heap_top + (u64)npg * PORF_GC_SPAGE >= PORF_ARENA_RESERVE) return 0;
#endif
      }
      if (lo == 0) {
        porf_commit((u64)porf_heap_top + (u64)npg * PORF_GC_SPAGE);
        lo = porf_heap_top >> PORF_GC_SPAGE_SHIFT;
        porf_heap_top += npg * PORF_GC_SPAGE;
      }
    }
  }
  porf_gc_claimed_since_full += (i64)npg * (i64)PORF_GC_SPAGE;
  porf_gc_allocation_debt += (u64)npg * PORF_GC_SPAGE;
  return lo;
}

static int porf_gc_install_run(i32 ci, u32 pg) {
  struct porf_gc_window* w = &porf_gc_active[ci];
  struct porf_gc_page* m = &porf_gc_pages[pg];
  const u32 cls = porf_gc_cls_size[ci];
  const u32 slots = porf_gc_cls_slots[ci];
  const u32 base_addr = pg << PORF_GC_SPAGE_SHIFT;
  u32 i = m->cursor;
  while (i < slots && porf_gc_bit(PORF_GC_B_ALLOC, porf_gc_gran(base_addr + i * cls)) != 0u) i++;
  if (i >= slots) { m->cursor = (u16)slots; return 0; }
  u32 j = i + 1;
  while (j < slots && porf_gc_bit(PORF_GC_B_ALLOC, porf_gc_gran(base_addr + j * cls)) == 0u) j++;
  m->cursor = (u16)j;
  w->lo = w->cur = base_addr + i * cls;
  w->end = base_addr + j * cls;
  porf_gc_window_bytes += (i64)((j - i) * cls);
  porf_gc_touch_list(pg);
  return 1;
}

static void porf_gc_publish_window(i32 ci) {
  struct porf_gc_window* w = &porf_gc_active[ci];
  const u32 cls = porf_gc_cls_size[ci];
  for (u32 b = w->lo; b < w->cur; b += cls) {
    const u32 g = porf_gc_gran(b);
    porf_gc_bit_set(PORF_GC_B_ALLOC, g);
    porf_gc_bit_set(PORF_GC_B_YOUNG, g);
  }
  w->lo = w->cur;
}

static int porf_gc_refill_window(i32 ci) {
  struct porf_gc_window* w = &porf_gc_active[ci];
  if (w->end != 0) {
    const u32 pg = porf_gc_chunk_start((w->end - 1u) >> PORF_GC_SPAGE_SHIFT) >> PORF_GC_SPAGE_SHIFT;
    porf_gc_publish_window(ci);
    w->cur = w->end = w->lo = 0;
    if (porf_gc_install_run(ci, pg)) return 1;
  }
  while (porf_gc_partial[ci] != 0) {
    const u32 pg = porf_gc_partial[ci] - 1u;
    struct porf_gc_page* m = &porf_gc_pages[pg];
    porf_gc_partial[ci] = m->aux;
    m->aux = 0;
    if (porf_gc_page_kind[pg] != PORF_GC_PK_SMALL || m->cidx != (u8)ci ||
      (m->flags & PORF_GC_PF_PARTIAL) == 0u) continue;
    m->flags &= (u8)~PORF_GC_PF_PARTIAL;
    if (porf_gc_install_run(ci, pg)) return 1;
  }
  const u32 npg = porf_gc_cls_pages[ci];
  const u32 pg = porf_gc_claim_pages(npg);
  if (pg == 0) return 0;
  struct porf_gc_page* m = &porf_gc_pages[pg];
  m->cls = porf_gc_cls_size[ci];
  m->flags = 0;
  m->cidx = (u8)ci;
  m->cursor = (u16)porf_gc_cls_slots[ci];
  m->aux = 0;
  porf_gc_page_kind[pg] = PORF_GC_PK_SMALL;
  for (u32 k = 1; k < npg; k++) {
    struct porf_gc_page* tm = &porf_gc_pages[pg + k];
    tm->cls = porf_gc_cls_size[ci];
    tm->flags = PORF_GC_PF_TAIL;
    tm->cidx = (u8)ci;
    tm->cursor = 0;
    tm->aux = pg;
    porf_gc_page_kind[pg + k] = PORF_GC_PK_SMALL;
  }
  w->lo = w->cur = pg << PORF_GC_SPAGE_SHIFT;
  w->end = (pg << PORF_GC_SPAGE_SHIFT) + (u32)porf_gc_cls_slots[ci] * porf_gc_cls_size[ci];
  porf_gc_window_bytes += (i64)(w->end - w->cur);
  porf_gc_touch_list(pg);
  return 1;
}

${ALLOC_PROFILE_C}${st}u32 porf_alloc_slow(u32 bytes, u32 typeId);
${sti}u32 porf_alloc(u32 bytes, u32 typeId) {
  PORF_AP_RECORD(bytes, typeId);
  if (bytes <= PORF_GC_MAX_SMALL) {
    const u32 ci = porf_gc_cls_lut[(bytes + 7u) >> 3];
    struct porf_gc_window* w = &porf_gc_active[ci];
    const u32 cur = w->cur;
    if (cur < w->end) {
      w->cur = cur + porf_gc_cls_size[ci];
      porf_gc_kinds[cur >> 4] = porf_gc_kind_for_type(typeId);
      if (typeId == 0u) memset(MEM + cur, 0, porf_gc_cls_size[ci]);
      return cur;
    }
  }
  return porf_alloc_slow(bytes, typeId);
}

static void porf_gc_minor(void);

${st}u32 porf_alloc_slow(u32 bytes, u32 typeId) {
  if (porf_heap_base == 0) {
    porf_arena_init();
    return porf_alloc_slow(bytes, typeId);
  }
  if (porf_gc_window_bytes >= (i64)PORF_GC_NURSERY_BYTES || porf_gc_span_bytes >= 8388608ll) {
    porf_gc_window_bytes = 0;
    porf_gc_span_bytes = 0;
#ifdef PORF_GC_DEFER
    if (!porf_gc_pending) porf_gc_pending = 1;
#else
    porf_gc_minor();
#endif
  }
  if (bytes > PORF_GC_MAX_SMALL) return porf_gc_span_alloc(bytes, typeId);
  const u32 ci = porf_gc_cls_lut[(bytes + 7u) >> 3];
  if (porf_gc_refill_window((i32)ci)) return porf_alloc(bytes, typeId);
  porf_err("porffor: out of memory (gc heap limit; req="); porf_err_int(bytes);
  porf_err(" live="); porf_err_int((long long)(porf_gc_live_bytes / 1048576ull));
  porf_err("MB heap_top="); porf_err_int(porf_heap_top); porf_err(")\\n");
  abort();
}

static u32 porf_gc_span_alloc(u32 bytes, u32 typeId) {
  const u32 npg = (bytes + PORF_GC_SPAGE_MASK) >> PORF_GC_SPAGE_SHIFT;
  const u32 lo = porf_gc_claim_pages(npg);
  if (lo == 0) {
    porf_err("porffor: out of memory (span "); porf_err_int(npg);
    porf_err(" pages; heap_top="); porf_err_int(porf_heap_top); porf_err(")\\n");
    abort();
  }
  porf_gc_span_bytes += (i64)npg * (i64)PORF_GC_SPAGE;
  porf_gc_page_kind[lo] = PORF_GC_PK_SPAN;
  porf_gc_pages[lo].cls = 0;
  porf_gc_pages[lo].flags = 0;
  porf_gc_pages[lo].cursor = 0;
  porf_gc_pages[lo].aux = npg;
  for (u32 k = 1; k < npg; k++) {
    porf_gc_page_kind[lo + k] = PORF_GC_PK_TAIL;
    porf_gc_pages[lo + k].aux = lo;
  }
  const u32 body = lo << PORF_GC_SPAGE_SHIFT;
  const u32 g = porf_gc_gran(body);
  porf_gc_bit_set(PORF_GC_B_ALLOC, g);
  porf_gc_bit_set(PORF_GC_B_YOUNG, g);
  porf_gc_bit_clear(PORF_GC_B_AGED, g);
  porf_gc_bit_clear(PORF_GC_B_MARK, g);
  porf_gc_kinds[g] = porf_gc_kind_for_type(typeId);
  if (typeId == 0u) memset(MEM + body, 0, (size_t)npg * PORF_GC_SPAGE);
  porf_gc_touch_list(lo);
  return body;
}

${st}void porf_gc_barrier_reclassify(u32 p, i32 type) {
  const u32 pg = p >> PORF_GC_SPAGE_SHIFT;
  const u8 k = porf_gc_page_kind[pg];
  if (k == PORF_GC_PK_SMALL) {
    if ((p - porf_gc_chunk_start(pg)) % porf_gc_pages[pg].cls != 0u) return;
  } else if (k == PORF_GC_PK_SPAN) {
    if ((p & PORF_GC_SPAGE_MASK) != 0u) return;
  } else return;
  porf_gc_kinds[p >> 4] = (u8)type;
  if (type == ${TYPES.__porffor_generator} || type == ${TYPES.__porffor_asyncgenerator})
    porf_gc_pages[pg].flags |= PORF_GC_PF_FIN;
}
${sti}void porf_gc_barrier_impl(u32 p, i32 type) {
  if (porf_heap_base == 0 || p == 0) return;
  porf_gc_cards[p >> 9] = 1;
  if (type <= 0) return;
  if (type > 195 && type < 248) return;
  if (porf_gc_kinds[p >> 4] == (u8)type) return;
  porf_gc_barrier_reclassify(p, type);
}
static inline u32 porf_gc_barrier_ptr_u32(u32 p) { return p; }
static inline u32 porf_gc_barrier_ptr_i32(i32 p) { return (u32)p; }
static inline u32 porf_gc_barrier_ptr_jsval(jsval v) { return (u32)v.val; }
#define porf_gc_barrier(p, type) porf_gc_barrier_impl(_Generic((p), jsval: porf_gc_barrier_ptr_jsval, i32: porf_gc_barrier_ptr_i32, default: porf_gc_barrier_ptr_u32)(p), (type))

static void* porf_c_stack_top = NULL;

${sti}int porf_gc_type_can_reference(i32 type) {
  switch (type) {
    case ${TYPES.undefined}:
    case ${TYPES.number}:
    case ${TYPES.boolean}:
    case ${TYPES.numberobject}:
    case ${TYPES.booleanobject}:
      return 0;
  }
  return 1;
}

static inline i32 porf_gc_value_body(f64 value, i32 type) {
  if (type == ${TYPES.bigint}) {
    if (value < 2251799813685248.0) return 0;
    value -= 2251799813685248.0;
  }
  return (i32)value;
}

static int porf_gc_object_shape_valid(i32 body) {
  if (!porf_gc_is_block_start(body)) return 0;
  const u32 block_size = porf_gc_block_size(body);
  if (block_size < 16u) return 0;
  const u32 size = *(u16*)(MEM + body);
  const u32 capacity = *(u16*)(MEM + body + 2);
  if (size > capacity) return 0;
  const i32 entries = *(u32*)(MEM + body + 12);
  if (entries == 0) return size == 0;
  const u64 entry_bytes = (u64)capacity * 20ull;
  if (entries == body + 16) return 16ull + entry_bytes <= (u64)block_size;
  if (porf_gc_in_static(entries)) return porf_gc_static_range(entries, entry_bytes);
  if (!porf_gc_is_block_start(entries)) return 0;
  return entry_bytes <= (u64)porf_gc_block_size(entries);
}

static int porf_gc_static_object_shape_valid(i32 body) {
  if (!porf_gc_static_range(body, 16ull)) return 0;
  const u32 size = *(u16*)(MEM + body);
  const u32 capacity = *(u16*)(MEM + body + 2);
  if (size > capacity) return 0;
  const i32 entries = *(u32*)(MEM + body + 12);
  if (entries == 0) return size == 0;
  const u64 entry_bytes = (u64)capacity * 20ull;
  if (entries == body + 16) return porf_gc_static_range(body, 16ull + entry_bytes);
  if (porf_gc_in_static(entries)) return porf_gc_static_range(entries, entry_bytes);
  if (!porf_gc_is_block_start(entries)) return 0;
  return entry_bytes <= (u64)porf_gc_block_size(entries);
}

static int porf_gc_array_like_shape_valid(i32 body) {
  if (!porf_gc_is_block_start(body)) return 0;
  const u32 block_size = porf_gc_block_size(body);
  if (block_size < 16u) return 0;
  u32 len = *(u32*)(MEM + body);
  const i32 entries = *(u32*)(MEM + body + 4);
  const u32 capacity = *(u32*)(MEM + body + 8);
  if (len > capacity) len = capacity;
  const u64 bytes = (u64)len * 8ull;
  if (entries == body + 16) return 16ull + bytes <= (u64)block_size;
  if (porf_gc_in_static(entries)) return porf_gc_static_range(entries, bytes);
  if (!porf_gc_is_block_start(entries)) return 0;
  return bytes <= (u64)porf_gc_block_size(entries);
}

static int porf_gc_static_array_like_shape_valid(i32 body) {
  if (!porf_gc_static_range(body, 16ull)) return 0;
  u32 len = *(u32*)(MEM + body);
  const i32 entries = *(u32*)(MEM + body + 4);
  const u32 capacity = *(u32*)(MEM + body + 8);
  if (len > capacity) len = capacity;
  const u64 bytes = (u64)len * 8ull;
  if (entries == body + 16) return porf_gc_static_range(body, 16ull + bytes);
  return porf_gc_static_range(entries, bytes);
}

static void porf_gc_enqueue_mark(i32 body, i32 type) {
  if (porf_gc_mark_queue_len == porf_gc_mark_queue_cap) {
    const i32 new_cap = porf_gc_mark_queue_cap == 0 ? 4096 : porf_gc_mark_queue_cap * 2;
    struct porf_gc_mark_item* grown = realloc(porf_gc_mark_queue, (size_t)new_cap * sizeof(*grown));
    if (!grown) abort();
    porf_gc_mark_queue = grown;
    porf_gc_mark_queue_cap = new_cap;
  }
  porf_gc_mark_queue[porf_gc_mark_queue_len++] = (struct porf_gc_mark_item){ (u32)body, type };
}

static int porf_gc_mark_body(i32 body) {
  if (body <= 0) return 0;
  const u32 g = porf_gc_gran(body);
  if (porf_gc_bit(PORF_GC_B_ALLOC, g) == 0u) return 0;
  if (porf_gc_minor_mode) {
    if (porf_gc_bit(PORF_GC_B_YOUNG, g) == 0u) return 0;
    porf_gc_scan_young_seen = 1;
  }
  if (porf_gc_bit(PORF_GC_B_MARK, g) != 0u) return 0;
  porf_gc_bit_set(PORF_GC_B_MARK, g);
  return 1;
}

static void porf_gc_mark_raw(i32 body) {
  if (body <= 0) return;
  const u32 g = porf_gc_gran(body);
  if (porf_gc_bit(PORF_GC_B_ALLOC, g) == 0u) return;
  if (porf_gc_minor_mode && porf_gc_bit(PORF_GC_B_YOUNG, g) == 0u) return;
  porf_gc_bit_set(PORF_GC_B_MARK, g);
}

static void porf_gc_mark_boxed_primitive(f64 value, i32 type) {
  for (i32 i = 0; i < porf_gc_boxed_marks_len; i++)
    if (porf_gc_boxed_marks[i].type == type && porf_gc_boxed_marks[i].value == value) return;
  if (porf_gc_boxed_marks_len == porf_gc_boxed_marks_cap) {
    const i32 new_cap = porf_gc_boxed_marks_cap == 0 ? 64 : porf_gc_boxed_marks_cap * 2;
    struct porf_gc_boxed_mark* grown = realloc(porf_gc_boxed_marks, (size_t)new_cap * sizeof(*grown));
    if (!grown) abort();
    porf_gc_boxed_marks = grown;
    porf_gc_boxed_marks_cap = new_cap;
  }
  porf_gc_boxed_marks[porf_gc_boxed_marks_len++] = (struct porf_gc_boxed_mark){ value, type };
}
static int porf_gc_is_marked_boxed_primitive(f64 value, i32 type) {
  for (i32 i = 0; i < porf_gc_boxed_marks_len; i++)
    if (porf_gc_boxed_marks[i].type == type && porf_gc_boxed_marks[i].value == value) return 1;
  return 0;
}

static inline u64 porf_gc_static_mark_key(i32 body, i32 type) {
  return ((u64)(u32)body << 8) | (u64)(u32)(type & 0xff) | (1ull << 63);
}
static inline u64 porf_gc_static_mark_hash(u64 key) {
  key ^= key >> 33;
  key *= 0xff51afd7ed558ccdull;
  key ^= key >> 33;
  return key;
}
static int porf_gc_static_is_marked(i32 body, i32 type) {
  if (porf_gc_static_marks_cap == 0) return 0;
  const u64 key = porf_gc_static_mark_key(body, type);
  const u32 mask = (u32)porf_gc_static_marks_cap - 1u;
  u32 pos = (u32)porf_gc_static_mark_hash(key) & mask;
  while (porf_gc_static_marks[pos] != 0) {
    if (porf_gc_static_marks[pos] == key) return 1;
    pos = (pos + 1u) & mask;
  }
  return 0;
}
static void porf_gc_static_marks_grow(void) {
  const i32 old_cap = porf_gc_static_marks_cap;
  u64* old = porf_gc_static_marks;
  const i32 new_cap = old_cap == 0 ? 1024 : old_cap * 2;
  u64* grown = calloc((size_t)new_cap, sizeof(u64));
  if (!grown) abort();
  porf_gc_static_marks = grown;
  porf_gc_static_marks_cap = new_cap;
  if (old != NULL) {
    const u32 mask = (u32)new_cap - 1u;
    for (i32 i = 0; i < old_cap; i++) {
      const u64 key = old[i];
      if (key == 0) continue;
      u32 pos = (u32)porf_gc_static_mark_hash(key) & mask;
      while (porf_gc_static_marks[pos] != 0) pos = (pos + 1u) & mask;
      porf_gc_static_marks[pos] = key;
    }
    free(old);
  }
}
static int porf_gc_mark_static(i32 body, i32 type) {
  if (porf_gc_static_is_marked(body, type)) return 0;
  if (porf_gc_static_marks_len * 2 >= porf_gc_static_marks_cap) porf_gc_static_marks_grow();
  const u64 key = porf_gc_static_mark_key(body, type);
  const u32 mask = (u32)porf_gc_static_marks_cap - 1u;
  u32 pos = (u32)porf_gc_static_mark_hash(key) & mask;
  while (porf_gc_static_marks[pos] != 0) pos = (pos + 1u) & mask;
  porf_gc_static_marks[pos] = key;
  porf_gc_static_marks_len++;
  return 1;
}

static int porf_gc_is_marked_js(f64 value, i32 type) {
  switch (type) {
    case ${TYPES.undefined}:
    case ${TYPES.number}:
    case ${TYPES.boolean}:
      return 1;
    case ${TYPES.numberobject}:
    case ${TYPES.booleanobject}:
      return porf_gc_is_marked_boxed_primitive(value, type);
  }
  const i32 body = porf_gc_value_body(value, type);
  if (body == 0) return 1;
  if (porf_gc_in_static(body)) return porf_gc_static_is_marked(body, type);
  const u32 g = porf_gc_gran(body);
  if (porf_gc_bit(PORF_GC_B_ALLOC, g) == 0u) return 0;
  if (porf_gc_minor_mode && porf_gc_bit(PORF_GC_B_YOUNG, g) == 0u) return 1;
  return porf_gc_bit(PORF_GC_B_MARK, g) != 0u;
}

struct porf_gc_native_root {
  f64 value;
  i32 type;
};
static struct porf_gc_native_root* porf_gc_native_roots = NULL;
static i32 porf_gc_native_roots_len = 0;
static i32 porf_gc_native_roots_cap = 0;
static i32* porf_gc_native_root_free_slots = NULL;
static i32 porf_gc_native_root_free_slots_len = 0;
static i32* porf_gc_native_root_active = NULL;
static i32* porf_gc_native_root_active_pos = NULL;
static i32 porf_gc_native_root_active_len = 0;
i32 porf_gc_native_root_add(f64 value, i32 type) {
  if (porf_gc_native_root_free_slots_len == 0 && porf_gc_native_roots_len == porf_gc_native_roots_cap) {
    i32 new_cap = porf_gc_native_roots_cap == 0 ? 64 : porf_gc_native_roots_cap * 2;
    struct porf_gc_native_root* grown = realloc(porf_gc_native_roots, (size_t)new_cap * sizeof(*grown));
    i32* grown_free_slots = realloc(porf_gc_native_root_free_slots, (size_t)new_cap * sizeof(*grown_free_slots));
    i32* grown_active = realloc(porf_gc_native_root_active, (size_t)new_cap * sizeof(*grown_active));
    i32* grown_active_pos = realloc(porf_gc_native_root_active_pos, (size_t)new_cap * sizeof(*grown_active_pos));
    if (!grown || !grown_free_slots || !grown_active || !grown_active_pos) abort();
    for (i32 i = porf_gc_native_roots_cap; i < new_cap; i++) {
      grown[i].type = ${TYPES.undefined};
      grown_active_pos[i] = -1;
    }
    porf_gc_native_roots = grown;
    porf_gc_native_root_free_slots = grown_free_slots;
    porf_gc_native_root_active = grown_active;
    porf_gc_native_root_active_pos = grown_active_pos;
    porf_gc_native_roots_cap = new_cap;
  }
  i32 slot;
  if (porf_gc_native_root_free_slots_len > 0) slot = porf_gc_native_root_free_slots[--porf_gc_native_root_free_slots_len];
    else slot = porf_gc_native_roots_len++;
  porf_gc_native_roots[slot].value = value;
  porf_gc_native_roots[slot].type = type;
  porf_gc_native_root_active_pos[slot] = porf_gc_native_root_active_len;
  porf_gc_native_root_active[porf_gc_native_root_active_len++] = slot;
  return slot;
}

void porf_gc_native_root_remove(i32 slot) {
  if (slot < 0 || slot >= porf_gc_native_roots_len) return;
  if (porf_gc_native_roots[slot].type == ${TYPES.undefined}) return;
  porf_gc_native_roots[slot].value = 0;
  porf_gc_native_roots[slot].type = ${TYPES.undefined};
  porf_gc_native_root_free_slots[porf_gc_native_root_free_slots_len++] = slot;
  const i32 pos = porf_gc_native_root_active_pos[slot];
  const i32 last_slot = porf_gc_native_root_active[--porf_gc_native_root_active_len];
  if (pos != porf_gc_native_root_active_len) {
    porf_gc_native_root_active[pos] = last_slot;
    porf_gc_native_root_active_pos[last_slot] = pos;
  }
  porf_gc_native_root_active_pos[slot] = -1;
}

static void porf_gc_mark_native_roots(void) {
  for (i32 i = 0; i < porf_gc_native_root_active_len; i++) {
    const i32 slot = porf_gc_native_root_active[i];
    porf_gc_mark_js(porf_gc_native_roots[slot].value, porf_gc_native_roots[slot].type);
  }
}

static void porf_gc_mark_array_entries(i32 entries, u32 len) {
  for (u32 i = 0; i < len; i++) {
    const jsbits b = *(jsbits*)(MEM + entries + ((u64)i << 3));
    // 0: a hole. All ones: a Map/Set key deleted by __Porffor_hashtableTombstone,
    // which is not a value (it unpacks as type 255 at 0xFFFFFFFF)
    if (b == 0 || b == 0xffffffffffffffffull) continue;
    const jsval v = porf_unpack(b);
    if (porf_gc_type_can_reference(v.type)) porf_gc_mark_js(v.val, v.type);
  }
}

static void porf_gc_mark_array_like(i32 body) {
  u32 len = *(u32*)(MEM + body);
  i32 entries = *(u32*)(MEM + body + 4);
  const u32 capacity = *(u32*)(MEM + body + 8);
  if (len > capacity) len = capacity;
  if (entries == body + 16) {
    if (porf_gc_is_block_start(body)) {
      const u32 block_size = porf_gc_block_size(body);
      const u32 max_len = block_size >= 16u ? (block_size - 16u) / 8u : 0u;
      if (len > max_len) len = max_len;
    } else if (!porf_gc_static_range(body, 16ull + (u64)len * 8ull)) return;
    porf_gc_mark_array_entries(entries, len);
    return;
  }
  if (porf_gc_is_block_start(entries)) {
    const u32 max_len = porf_gc_block_size(entries) / 8u;
    if (len > max_len) len = max_len;
    porf_gc_mark_body(entries);
    porf_gc_set_kind(entries, PORF_GC_KIND_ARRAY_ENTRIES);
    porf_gc_mark_array_entries(entries, len);
    return;
  }
  if (porf_gc_in_static(entries)) {
    if (!porf_gc_static_range(entries, (u64)len * 8ull)) return;
    porf_gc_mark_array_entries(entries, len);
  }
}

static void porf_gc_mark_jsbits(jsbits bits) {
  const jsval v = porf_unpack(bits);
  if (porf_gc_type_can_reference(v.type)) porf_gc_mark_js(v.val, v.type);
}

static void porf_gc_mark_promise_reaction(u32 raw);

static void porf_gc_mark_promise_reaction_chain(u32 raw) {
  while (raw != 0) {
    const u32 next = *(u32*)(MEM + raw + PORF_REACTION_NEXT);
    porf_gc_mark_promise_reaction(raw);
    raw = next;
  }
}

// a reaction's handler, output promise and value. Marking it scans it only when this marks
// it: a reaction marked by another path (a conservative root) is scanned by its kind
// (porf_gc_scan_body), which must not go through the mark (already marked, it would return
// without scanning: its handler, a closure, freed while it waits in a promise's list)
static void porf_gc_scan_promise_reaction(u32 raw);
static void porf_gc_mark_promise_reaction(u32 raw) {
  if (raw == 0 || !porf_gc_is_block_start((i32)raw)) return;
  if (!porf_gc_mark_body((i32)raw) && porf_gc_kind((i32)raw) == PORF_GC_KIND_PROMISE_REACTION) return;
  porf_gc_set_kind((i32)raw, PORF_GC_KIND_PROMISE_REACTION);
  porf_gc_scan_promise_reaction(raw);
}
static void porf_gc_scan_promise_reaction(u32 raw) {
  const u8 kind = *(u8*)(MEM + raw + PORF_REACTION_KIND);
  if (kind == 11) porf_gc_mark_coro_handle((uintptr_t)*(u64*)(MEM + raw + PORF_REACTION_HANDLER));
    else if (kind != 12) porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_HANDLER));
  porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_OUT_PROMISE));
  porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_VALUE));
  porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_CONTEXT));
}

static void porf_gc_mark_promise_jobs(void) {
  porf_gc_mark_jsbits(porf_async_context);
  for (u32 i = 0; i < porf_promise_job_len; i++) {
    porf_gc_mark_promise_reaction(porf_promise_job_queue[(porf_promise_job_head + i) & (porf_promise_job_cap - 1u)]);
  }
}

static void porf_gc_mark_promise_body(i32 body) {
  porf_gc_mark_jsbits(*(jsbits*)(MEM + body + PORF_PROMISE_RESULT));
  porf_gc_mark_promise_reaction_chain(*(u32*)(MEM + body + PORF_PROMISE_FULFILL_HEAD));
  porf_gc_mark_promise_reaction_chain(*(u32*)(MEM + body + PORF_PROMISE_REJECT_HEAD));
  porf_gc_mark_jsbits(*(jsbits*)(MEM + body + PORF_PROMISE_PAYLOAD));
}

static int porf_gc_has_marked_array_like_type(i32 body) {
  return porf_gc_has_marked_type(body, ${TYPES.array});
}
static int porf_gc_has_marked_type_simple(i32 body, i32 type) {
  return porf_gc_has_marked_type(body, type);
}

static int porf_gc_should_rescan_marked_body(i32 body, i32 type) {
  switch (type) {
    case ${TYPES.object}:
      return !porf_gc_has_marked_type(body, type) && porf_gc_object_shape_valid(body);
    case ${TYPES.array}:
      return !porf_gc_has_marked_array_like_type(body) && porf_gc_array_like_shape_valid(body);
    case ${TYPES.promise}:
      return !porf_gc_has_marked_type_simple(body, type);
    case ${TYPES.__porffor_closureenv}:
    case ${TYPES.function}:
    case ${TYPES.map}:
    case ${TYPES.set}:
    case ${TYPES.weakmap}:
    case ${TYPES.weakset}:
    case ${TYPES.__porffor_generator}:
    case ${TYPES.__porffor_asyncgenerator}:
    case ${TYPES.symbol}:
    case ${TYPES.weakref}:
    case ${TYPES.disposablestack}:
    case ${TYPES.asyncdisposablestack}:
    case ${TYPES.proxy}:
    case ${TYPES.error}:
    case ${TYPES.aggregateerror}:
    case ${TYPES.typeerror}:
    case ${TYPES.referenceerror}:
    case ${TYPES.syntaxerror}:
    case ${TYPES.rangeerror}:
    case ${TYPES.evalerror}:
    case ${TYPES.urierror}:
    case ${TYPES.suppressederror}:
    case ${TYPES.regexp}:
    case ${TYPES.dataview}:
    case ${TYPES.uint8clampedarray}:
    case ${TYPES.uint8array}:
    case ${TYPES.int8array}:
    case ${TYPES.uint16array}:
    case ${TYPES.int16array}:
    case ${TYPES.uint32array}:
    case ${TYPES.int32array}:
    case ${TYPES.float16array}:
    case ${TYPES.float32array}:
    case ${TYPES.float64array}:
    case ${TYPES.bigint64array}:
    case ${TYPES.biguint64array}:
      return !porf_gc_has_marked_type(body, type);
  }
  return 0;
}

static void porf_gc_scan_body(i32 body, i32 type) {
  switch (type) {
${Prefs.ropes ? `    case PORF_GC_KIND_ROPE: {
      // [len][left][right][flat][left type][right type][type]
      const u32 left = *(u32*)(MEM + body + 4), right = *(u32*)(MEM + body + 8), flat = *(u32*)(MEM + body + 12);
      if (left != 0) porf_gc_mark_js((f64)left, *(u8*)(MEM + body + 16));
      if (right != 0) porf_gc_mark_js((f64)right, *(u8*)(MEM + body + 17));
      if (flat != 0) porf_gc_mark_js((f64)flat, *(u8*)(MEM + body + 18));
      break;
    }
` : ''}    case ${TYPES.__porffor_closureenv}: {
      const u32 parent = *(u32*)(MEM + body);
      if (parent != 0) porf_gc_mark_js((f64)parent, ${TYPES.__porffor_closureenv});
      const u32 count = *(u32*)(MEM + body + 4);
      for (u32 i = 0; i < count; i++) {
        const u32 slot = body + 8u + i * 16u;
        const u8 tag = *(u8*)(MEM + slot + 8);
        if (porf_gc_type_can_reference(tag)) porf_gc_mark_js(*(f64*)(MEM + slot), tag);
      }
      break;
    }
    case ${TYPES.object}: {
      const i32 proto = *(u32*)(MEM + body + 8);
      const i32 proto_type = *(u8*)(MEM + body + 5);
      if (proto != 0 || proto_type != ${TYPES.undefined}) porf_gc_mark_js((f64)proto, proto_type);
      u32 size = *(u16*)(MEM + body);
      const i32 entries = *(u32*)(MEM + body + 12);
      if (entries != 0) {
        porf_gc_mark_body(entries);
        if (entries != body + 16) {
          porf_gc_set_kind(entries, PORF_GC_KIND_OBJECT_ENTRIES);
          if (porf_gc_is_block_start(entries)) {
            const u32 max_size = porf_gc_block_size(entries) / 20u;
            if (size > max_size) size = max_size;
          }
        }
      }
      porf_gc_scan_object_entries_range(entries, 0, size);
      break;
    }
    case ${TYPES.array}:
      porf_gc_mark_array_like(body);
      break;
    case ${TYPES.promise}:
      porf_gc_mark_promise_body(body);
      break;
    case ${TYPES.__porffor_generator}:
    case ${TYPES.__porffor_asyncgenerator}:
      porf_gc_mark_coro_handle(*(uintptr_t*)(MEM + body));
      break;
    case ${TYPES.function}: {
      const i32 env = *(u32*)(MEM + body + 4);
      if (env != 0) porf_gc_mark_js((f64)env, ${TYPES.__porffor_closureenv});
      break;
    }
    case ${TYPES.map}:
    case ${TYPES.set}:
    case ${TYPES.weakset}: {
      const i32 keys = *(u32*)(MEM + body);
      const i32 vals = *(u32*)(MEM + body + 4);
      const i32 buckets = *(u32*)(MEM + body + 8);
      if (keys != 0) porf_gc_mark_js((f64)keys, ${TYPES.array});
      if (vals != 0) porf_gc_mark_js((f64)vals, ${TYPES.array});
      if (buckets != 0) porf_gc_mark_body(buckets);
      break;
    }
    case ${TYPES.weakmap}: {
      for (i32 i = 0; i < porf_gc_weakmaps_len; i++) if (porf_gc_weakmaps[i] == (u32)body) goto weakmap_seen;
      if (porf_gc_weakmaps_len == porf_gc_weakmaps_cap) {
        const i32 new_cap = porf_gc_weakmaps_cap == 0 ? 64 : porf_gc_weakmaps_cap * 2;
        u32* grown = realloc(porf_gc_weakmaps, (size_t)new_cap * sizeof(*grown));
        if (!grown) abort();
        porf_gc_weakmaps = grown;
        porf_gc_weakmaps_cap = new_cap;
      }
      porf_gc_weakmaps[porf_gc_weakmaps_len++] = (u32)body;
weakmap_seen:
      {
        const i32 keys = *(u32*)(MEM + body);
        const i32 vals = *(u32*)(MEM + body + 4);
        const i32 buckets = *(u32*)(MEM + body + 8);
        if (keys != 0) {
          porf_gc_mark_body(keys);
          porf_gc_set_marked_type(keys, ${TYPES.array});
        }
        if (vals != 0) {
          porf_gc_mark_body(vals);
          porf_gc_set_marked_type(vals, ${TYPES.array});
        }
        if (buckets != 0) porf_gc_mark_body(buckets);
      }
      break;
    }
    case ${TYPES.symbol}:
    case ${TYPES.weakref}:
    case ${TYPES.disposablestack}:
    case ${TYPES.asyncdisposablestack}: {
      const jsval v = porf_unpack(*(jsbits*)(MEM + body));
      porf_gc_mark_js(v.val, v.type);
      break;
    }
    // its cells (an array) and cleanup callback
    case ${TYPES.finalizationregistry}: {
      const jsval cells = porf_unpack(*(jsbits*)(MEM + body));
      porf_gc_mark_js(cells.val, cells.type);
      const jsval cleanup = porf_unpack(*(jsbits*)(MEM + body + 8));
      porf_gc_mark_js(cleanup.val, cleanup.type);
      break;
    }
    case ${TYPES.proxy}: {
      // [target, handler], both strong
      const jsval target = porf_unpack(*(jsbits*)(MEM + body));
      porf_gc_mark_js(target.val, target.type);
      const jsval handler = porf_unpack(*(jsbits*)(MEM + body + 8));
      porf_gc_mark_js(handler.val, handler.type);
      break;
    }
    case ${TYPES.error}:
    case ${TYPES.aggregateerror}:
    case ${TYPES.typeerror}:
    case ${TYPES.referenceerror}:
    case ${TYPES.syntaxerror}:
    case ${TYPES.rangeerror}:
    case ${TYPES.evalerror}:
    case ${TYPES.urierror}:
    case ${TYPES.suppressederror}: {
      const jsval v = porf_unpack(*(jsbits*)(MEM + body));
      porf_gc_mark_js(v.val, v.type);
      break;
    }
    case ${TYPES.regexp}: {
      porf_gc_mark_js((f64)(*(u32*)(MEM + body)), ${TYPES.bytestring});
      const i32 re_blob = *(u32*)(MEM + body + 12);
      if (re_blob != 0) porf_gc_mark_body(re_blob);
      const i32 re_names = *(u32*)(MEM + body + 16);
      if (re_names != 0) porf_gc_mark_js((f64)re_names, ${TYPES.array});
      break;
    }
    case ${TYPES.dataview}: {
      const i32 ptr = *(u32*)(MEM + body + 4);
      const i32 byte_offset = *(u32*)(MEM + body + 8);
      const i32 buffer = ptr - byte_offset;
      if (buffer != 0) porf_gc_mark_body(buffer);
      break;
    }
    case ${TYPES.uint8clampedarray}:
    case ${TYPES.uint8array}:
    case ${TYPES.int8array}:
    case ${TYPES.uint16array}:
    case ${TYPES.int16array}:
    case ${TYPES.uint32array}:
    case ${TYPES.int32array}:
    case ${TYPES.float16array}:
    case ${TYPES.float32array}:
    case ${TYPES.float64array}:
    case ${TYPES.bigint64array}:
    case ${TYPES.biguint64array}: {
      const i32 buffer = *(u32*)(MEM + body + 4) - *(u32*)(MEM + body + 8);
      if (buffer != 0) porf_gc_mark_body(buffer);
      break;
    }
  }
}

static void porf_gc_mark_js(f64 value, i32 type) {
  switch (type) {
    case ${TYPES.undefined}:
    case ${TYPES.number}:
    case ${TYPES.boolean}:
      return;
    case ${TYPES.numberobject}:
    case ${TYPES.booleanobject}:
      porf_gc_mark_boxed_primitive(value, type);
      return;
  }
  const i32 body = porf_gc_value_body(value, type);
  if (body == 0) return;
  // static strings hold no references and are never freed
  if ((u32)body < porf_heap_base && (type == ${TYPES.bytestring} || type == ${TYPES.string})) return;
${Prefs.ropes ? `  // a rope (--ropes) is a string value whose block holds its halves
  if ((type == ${TYPES.bytestring} || type == ${TYPES.string}) && porf_gc_kinds[porf_gc_gran(body)] == PORF_GC_KIND_ROPE) type = PORF_GC_KIND_ROPE;
` : ''}  if (porf_gc_is_block_start(body)) {
    if (type == ${TYPES.object} && !porf_gc_object_shape_valid(body)) return;
    if (!porf_gc_mark_body(body)) {
      if (porf_gc_minor_mode && porf_gc_bit(PORF_GC_B_YOUNG, porf_gc_gran(body)) == 0u) return;
      if (porf_gc_should_rescan_marked_body(body, type)) {
        porf_gc_set_marked_type(body, type);
        porf_gc_enqueue_mark(body, type);
      }
      return;
    }
    porf_gc_set_marked_type(body, type);
    porf_gc_enqueue_mark(body, type);
    return;
  }
  if (!porf_gc_in_static(body)) return;
  switch (type) {
    case ${TYPES.object}:
      if (!porf_gc_static_object_shape_valid(body)) return;
      break;
    case ${TYPES.array}:
      if (!porf_gc_static_array_like_shape_valid(body)) return;
      break;
    case ${TYPES.promise}:
      return;
    case ${TYPES.__porffor_generator}:
    case ${TYPES.__porffor_asyncgenerator}:
      return;
    case ${TYPES.string}:
    case ${TYPES.bytestring}:
    case ${TYPES.function}:
    case ${TYPES.bigint}:
    case ${TYPES.symbol}:
    case ${TYPES.regexp}:
    case ${TYPES.date}:
    case ${TYPES.map}:
    case ${TYPES.set}:
    case ${TYPES.weakmap}:
    case ${TYPES.weakset}:
    case ${TYPES.weakref}:
    case ${TYPES.disposablestack}:
    case ${TYPES.asyncdisposablestack}:
    case ${TYPES.proxy}:
    case ${TYPES.error}:
    case ${TYPES.aggregateerror}:
    case ${TYPES.typeerror}:
    case ${TYPES.referenceerror}:
    case ${TYPES.syntaxerror}:
    case ${TYPES.rangeerror}:
    case ${TYPES.evalerror}:
    case ${TYPES.urierror}:
    case ${TYPES.suppressederror}:
      break;
    default:
      return;
  }
  if (!porf_gc_mark_static(body, type)) return;
  porf_gc_enqueue_mark(body, type);
}

static i32 porf_gc_drain_mark_queue_budget(i32 budget) {
  i32 done = 0;
  while (porf_gc_mark_queue_len > 0 && done < budget) {
    const struct porf_gc_mark_item item = porf_gc_mark_queue[--porf_gc_mark_queue_len];
    porf_gc_scan_body((i32)item.body, item.type);
    done++;
  }
  return done;
}
static void porf_gc_drain_mark_queue(void) {
  while (porf_gc_mark_queue_len > 0) porf_gc_drain_mark_queue_budget(4096);
}

static void porf_gc_scan_object_entries_range(i32 entries, u32 from, u32 to) {
  for (u32 i = from; i < to; i++) {
    const i32 entry = entries + (i32)(i * 20u);
    const i32 key_type = *(u8*)(MEM + entry + 18);
    const u32 key = *(u32*)(MEM + entry + 4);
    if (key >= porf_heap_base && porf_gc_type_can_reference(key_type)) porf_gc_mark_js((f64)key, key_type);
    const u8 flags = *(u8*)(MEM + entry + 16);
    if ((flags & 1u) != 0u) {
      const u32 get = *(u32*)(MEM + entry + 8);
      const u32 set = *(u32*)(MEM + entry + 12);
      if (get != 0) porf_gc_mark_js((f64)get, ${TYPES.function});
      if (set != 0) porf_gc_mark_js((f64)set, ${TYPES.function});
    } else {
      const i32 value_type = *(u8*)(MEM + entry + 17);
      if (porf_gc_type_can_reference(value_type)) porf_gc_mark_js(porf_load_un_f64(MEM + entry + 8), value_type);
    }
  }
}

static void porf_gc_scan_object_entries(i32 entries) {
  if (!porf_gc_is_block_start(entries)) return;
  porf_gc_scan_object_entries_range(entries, 0, porf_gc_block_size(entries) / 20u);
}

static void porf_gc_scan_underlying_store(i32 body) {
  const u32 len = *(u32*)(MEM + body);
  for (u32 i = 0; i < len; i++) {
    const i32 base = body + 8 + (i32)(i * 16u);
    const jsval original = porf_unpack(*(jsbits*)(MEM + base));
    porf_gc_mark_js(original.val, original.type);
    const i32 underlying = *(u32*)(MEM + base + 8);
    if (underlying != 0) porf_gc_mark_js((f64)underlying, ${TYPES.object});
  }
}

// minors skip the promoted prefix (entries are in creation order), returns whether entries were removed
static int porf_gc_mark_underlying_store(i32 body) {
  if (!porf_gc_is_block_start(body)) return 1;
  porf_gc_mark_body(body);
  porf_gc_set_kind(body, PORF_GC_KIND_UNDERLYING_STORE);

  const u32 len = *(u32*)(MEM + body);
  u32 start = 0;
  if (porf_gc_minor_mode) {
    u32 p = porf_gc_underlying_old <= len ? porf_gc_underlying_old : 0u;
    while (p < len) {
      const i32 underlying = *(u32*)(MEM + body + 8 + (i32)(p * 16u) + 8);
      if (underlying <= 0 || porf_gc_bit(PORF_GC_B_YOUNG, porf_gc_gran(underlying)) != 0u) break;
      p++;
    }
    porf_gc_underlying_old = p;
    start = p;
  }
  int changed;
  do {
    changed = 0;
    for (u32 i = start; i < len; i++) {
      const i32 base = body + 8 + (i32)(i * 16u);
      const jsval original = porf_unpack(*(jsbits*)(MEM + base));
      const i32 underlying = *(u32*)(MEM + base + 8);

      if (!porf_gc_in_static(porf_gc_value_body(original.val, original.type)) && !porf_gc_is_marked_js(original.val, original.type)) continue;
      if (underlying == 0) continue;

      const int marked_before = porf_gc_is_marked_js((f64)(u32)underlying, ${TYPES.object});
      porf_gc_mark_js((f64)(u32)underlying, ${TYPES.object});
      if (!marked_before && porf_gc_is_marked_js((f64)(u32)underlying, ${TYPES.object})) changed = 1;
    }

    if (changed) porf_gc_drain_mark_queue();
  } while (changed);

  u32 out = start;
  for (u32 i = start; i < len; i++) {
    const i32 base = body + 8 + (i32)(i * 16u);
    const jsval original = porf_unpack(*(jsbits*)(MEM + base));
    if (!porf_gc_in_static(porf_gc_value_body(original.val, original.type)) && !porf_gc_is_marked_js(original.val, original.type)) continue;

    if (out != i) {
      const i32 dst = body + 8 + (i32)(out * 16u);
      *(u64*)(MEM + dst) = *(u64*)(MEM + base);
      *(u32*)(MEM + dst + 8) = *(u32*)(MEM + base + 8);
      *(u32*)(MEM + dst + 12) = *(u32*)(MEM + base + 12);
    }

    out++;
  }

  *(u32*)(MEM + body) = out;
  // every survivor of a major collection is promoted by its sweep
  if (!porf_gc_minor_mode) porf_gc_underlying_old = out;
  return out != len;
}

static void porf_gc_scan_regex_cache(i32 cache) {
  while (cache != 0 && porf_gc_is_block_start(cache)) {
    porf_gc_mark_js((f64)(*(u32*)(MEM + cache + 4)), ${TYPES.bytestring});
    porf_gc_mark_js((f64)(*(u32*)(MEM + cache + 8)), ${TYPES.bytestring});
    const i32 cache_blob = *(u32*)(MEM + cache + 12);
    if (cache_blob != 0) porf_gc_mark_body(cache_blob);
    const i32 cache_names = *(u32*)(MEM + cache + 16);
    if (cache_names != 0) porf_gc_mark_js((f64)cache_names, ${TYPES.array});
    cache = *(u32*)(MEM + cache);
  }
}

static void porf_gc_mark_regex_cache(i32 cache) {
  while (cache != 0) {
    if (!porf_gc_is_block_start(cache)) return;
    porf_gc_mark_body(cache);
    porf_gc_set_kind(cache, PORF_GC_KIND_REGEX_CACHE);
    porf_gc_scan_regex_cache(cache);
    cache = *(u32*)(MEM + cache);
  }
}

static void porf_gc_scan_kind_block(i32 body) {
  if (!porf_gc_is_block_start(body)) return;
  const u32 kind = porf_gc_kind(body);
  switch (kind) {
    case PORF_GC_KIND_OBJECT_ENTRIES:
      porf_gc_scan_object_entries(body);
      break;
    case PORF_GC_KIND_ARRAY_ENTRIES:
      porf_gc_mark_array_entries(body, porf_gc_block_size(body) / 8u);
      break;
    case PORF_GC_KIND_FUNCTION: {
      const i32 env = *(u32*)(MEM + body + 4);
      if (env != 0) porf_gc_mark_js((f64)env, ${TYPES.__porffor_closureenv});
      break;
    }
    case PORF_GC_KIND_UNDERLYING_STORE:
      porf_gc_scan_underlying_store(body);
      break;
    case PORF_GC_KIND_REGEX_CACHE:
      porf_gc_scan_regex_cache(body);
      break;
    case PORF_GC_KIND_PROMISE_REACTION:
      porf_gc_scan_promise_reaction((u32)body);
      break;
${Prefs.ropes ? `    case PORF_GC_KIND_ROPE:
      porf_gc_scan_body(body, PORF_GC_KIND_ROPE);
      break;
` : ''}    default:
      if (kind >= 1u && kind <= 195u) porf_gc_scan_body(body, (i32)kind);
      break;
  }
}

static u32 porf_gc_weakmap_hash(f64 key) {
  u32 hash = (u32)key;
  hash = hash >> 3;
  hash ^= hash >> 16;
  hash *= 0x7feb352d;
  hash ^= hash >> 15;
  return hash;
}

static void porf_gc_weakmap_insert_bucket(i32 buckets, u32 capacity, f64 key, u32 index) {
  if (buckets == 0 || capacity == 0) return;
  u32 slot = porf_gc_weakmap_hash(key) & (capacity - 1u);
  while (1) {
    const i32 bucket_ptr = buckets + (i32)(slot * 4u);
    if (*(u32*)(MEM + bucket_ptr) == 0u) {
      *(u32*)(MEM + bucket_ptr) = index + 1u;
      return;
    }
    slot = (slot + 1u) & (capacity - 1u);
  }
}

static i32 porf_gc_array_entries_shallow(i32 arr, u32* len_out) {
  if (arr == 0) { *len_out = 0; return 0; }
  u32 len = *(u32*)(MEM + arr);
  const i32 entries = *(u32*)(MEM + arr + 4);
  const u32 capacity = *(u32*)(MEM + arr + 8);
  if (len > capacity) len = capacity;
  if (entries != arr + 16) porf_gc_mark_body(entries);
  *len_out = len;
  return entries;
}

static int porf_gc_mark_weakmap_values_once(void) {
  int changed = 0;
  for (i32 w = 0; w < porf_gc_weakmaps_len; w++) {
    const i32 body = (i32)porf_gc_weakmaps[w];
    if (!porf_gc_is_block_start(body)) continue;
    const i32 keys = *(u32*)(MEM + body);
    const i32 vals = *(u32*)(MEM + body + 4);
    u32 keys_len = 0, vals_len = 0;
    const i32 keys_entries = porf_gc_array_entries_shallow(keys, &keys_len);
    const i32 vals_entries = porf_gc_array_entries_shallow(vals, &vals_len);
    const u32 len = keys_len < vals_len ? keys_len : vals_len;
    for (u32 i = 0; i < len; i++) {
      const jsbits key_bits = *(jsbits*)(MEM + keys_entries + ((u64)i << 3));
      if (key_bits == 0xffffffffffffffffull) continue;
      const jsval key = porf_unpack(key_bits);
      if (!porf_gc_is_marked_js(key.val, key.type)) continue;
      const jsval val = porf_unpack(*(jsbits*)(MEM + vals_entries + ((u64)i << 3)));
      const int marked_before = porf_gc_is_marked_js(val.val, val.type);
      porf_gc_mark_js(val.val, val.type);
      if (!marked_before && porf_gc_is_marked_js(val.val, val.type)) changed = 1;
    }
  }
  return changed;
}

static void porf_gc_sweep_weakmaps(void) {
  for (i32 w = 0; w < porf_gc_weakmaps_len; w++) {
    const i32 body = (i32)porf_gc_weakmaps[w];
    if (!porf_gc_is_block_start(body)) continue;
    const i32 keys = *(u32*)(MEM + body);
    const i32 vals = *(u32*)(MEM + body + 4);
    const i32 buckets = *(u32*)(MEM + body + 8);
    const u32 capacity = *(u32*)(MEM + body + 12);
    u32 keys_len = 0, vals_len = 0;
    const i32 keys_entries = porf_gc_array_entries_shallow(keys, &keys_len);
    const i32 vals_entries = porf_gc_array_entries_shallow(vals, &vals_len);
    const u32 len = keys_len < vals_len ? keys_len : vals_len;
    if (buckets != 0 && capacity != 0) memset(MEM + buckets, 0, (size_t)capacity * 4u);
    for (u32 i = 0; i < len; i++) {
      const i32 key_ptr = keys_entries + (i32)((u64)i << 3);
      const jsbits key_bits = *(jsbits*)(MEM + key_ptr);
      if (key_bits == 0xffffffffffffffffull) continue;
      const jsval key = porf_unpack(key_bits);
      if (porf_gc_is_marked_js(key.val, key.type)) {
        porf_gc_weakmap_insert_bucket(buckets, capacity, key.val, i);
        continue;
      }
      *(jsbits*)(MEM + key_ptr) = 0xffffffffffffffffull;
      *(jsbits*)(MEM + vals_entries + ((u64)i << 3)) = JV_UNDEFINED_BITS;
      *(u32*)(MEM + body + 16) += 1u;
    }
  }
}

static void porf_gc_process_weakmaps(void) {
  while (porf_gc_mark_weakmap_values_once()) porf_gc_drain_mark_queue();
  porf_gc_sweep_weakmaps();
}

static void porf_gc_cons_candidate(u32 c);
static void porf_gc_cons_mark_block(i32 body) {
  if (!porf_gc_mark_body(body)) return;
  const u32 kind = porf_gc_kinds[porf_gc_gran(body)];
  if (kind != 0u) { porf_gc_scan_kind_block(body); return; }
  if (porf_gc_object_shape_valid(body)) { porf_gc_enqueue_mark(body, ${TYPES.object}); return; }
  if (porf_gc_array_like_shape_valid(body)) { porf_gc_enqueue_mark(body, ${TYPES.array}); return; }
  const u32 size = porf_gc_block_size(body);
  for (u32 off = 0; off + 4u <= size; off += 4u) porf_gc_cons_candidate(*(u32*)(MEM + body + off));
  for (u32 off = 0; off + 8u <= size; off += 8u) {
    const f64 d = *(f64*)(MEM + body + off);
    if (d > 0.0 && d < 4294967296.0) {
      const i64 iv = (i64)d;
      if ((f64)iv == d) porf_gc_cons_candidate((u32)(u64)iv);
    } else if (d >= 2251799813685248.0 && d < 2251804108652544.0) {
      // a heap BigInt: payload = pointer + 2^51
      const i64 iv = (i64)(d - 2251799813685248.0);
      if ((f64)iv == d - 2251799813685248.0) porf_gc_cons_candidate((u32)(u64)iv);
    }
  }
}
static void porf_gc_cons_candidate(u32 c) {
  if (c < porf_heap_base || c >= porf_heap_top) return;
  const u32 pg = c >> PORF_GC_SPAGE_SHIFT;
  const u8 k = porf_gc_page_kind[pg];
  u32 base;
  if (k == PORF_GC_PK_SMALL) {
    const u32 cls = porf_gc_pages[pg].cls;
    const u32 sa = porf_gc_chunk_start(pg);
    base = sa + ((c - sa) / cls) * cls;
  } else if (k == PORF_GC_PK_SPAN) {
    base = pg << PORF_GC_SPAGE_SHIFT;
  } else if (k == PORF_GC_PK_TAIL) {
    base = porf_gc_pages[pg].aux << PORF_GC_SPAGE_SHIFT;
  } else return;
  porf_gc_cons_mark_block((i32)base);
}
static void porf_gc_cons_scan_range(const u64* lo, const u64* hi) {
  for (const u64* w = lo; w < hi; w++) {
    const u64 v = *w;
    if (v == 0) continue;
    porf_gc_cons_candidate((u32)v);
    porf_gc_cons_candidate((u32)(v >> 32));
    f64 d;
    memcpy(&d, w, 8);
    if (d > 0.0 && d < 4294967296.0) {
      const i64 iv = (i64)d;
      if ((f64)iv == d) porf_gc_cons_candidate((u32)(u64)iv);
    } else if (d >= 2251799813685248.0 && d < 2251804108652544.0) {
      // a heap BigInt: payload = pointer + 2^51
      const i64 iv = (i64)(d - 2251799813685248.0);
      if ((f64)iv == d - 2251799813685248.0) porf_gc_cons_candidate((u32)(u64)iv);
    }
  }
}

static void porf_gc_mark_cons_roots(void) {
  jmp_buf regs;
#ifdef PORF_NO_EH
  memset(&regs, 0, sizeof(regs));
#endif
  if (_setjmp(regs) == 0) {
    porf_gc_cons_scan_range((const u64*)&regs, (const u64*)((const char*)&regs + sizeof(regs)));
  }
  volatile u64 anchor = 0;
  const u64* lo = (const u64*)(((uintptr_t)&anchor + 7) & ~(uintptr_t)7);
  const u64* hi = (const u64*)porf_c_stack_top;
  if (lo < hi) porf_gc_cons_scan_range(lo, hi);
  if (porf_try_depth > 0) {
    porf_gc_cons_scan_range((const u64*)porf_try_data, (const u64*)(porf_try_data + porf_try_depth));
  }
  porf_gc_mark_promise_jobs();
  porf_gc_mark_coro_roots();
  porf_gc_drain_mark_queue();
}

static void porf_gc_scan_card_object(u32 base, u32 from, u32 to) {
  const u8 kind = porf_gc_kinds[porf_gc_gran(base)];
  if (kind == PORF_GC_KIND_ARRAY_ENTRIES) {
    const u32 bs = porf_gc_block_size((i32)base);
    u32 lo = from > base ? from : base;
    u32 hi = base + bs < to ? base + bs : to;
    lo = base + (((lo - base) >> 3) << 3);
    if (hi > lo) porf_gc_mark_array_entries((i32)lo, (hi - lo) / 8u);
    return;
  }
  if (kind == PORF_GC_KIND_OBJECT_ENTRIES) {
    const u32 capacity = porf_gc_block_size((i32)base) / 20u;
    u32 i0 = from > base ? (from - base) / 20u : 0u;
    u32 i1 = to > base ? (to - base + 19u) / 20u : 0u;
    if (i1 > capacity) i1 = capacity;
    if (i1 > i0) porf_gc_scan_object_entries_range((i32)base, i0, i1);
    return;
  }
  porf_gc_scan_kind_block((i32)base);
}

static void porf_gc_scan_card(u32 card, int* young_base_present) {
  const u32 from = card << 9;
  const u32 to = from + 512u;
  const u32 pg = from >> PORF_GC_SPAGE_SHIFT;
  const u8 k = porf_gc_page_kind[pg];
  if (k == PORF_GC_PK_SMALL) {
    const u32 cls = porf_gc_pages[pg].cls;
    const u32 sa = porf_gc_chunk_start(pg);
    u32 base = sa + ((from - sa) / cls) * cls;
    for (; base < to; base += cls) {
      const u32 g = porf_gc_gran(base);
      if (porf_gc_bit(PORF_GC_B_ALLOC, g) == 0u) continue;
      if (porf_gc_bit(PORF_GC_B_YOUNG, g) != 0u) { *young_base_present = 1; continue; }
      porf_gc_scan_card_object(base, from, to);
    }
    return;
  }
  u32 head;
  if (k == PORF_GC_PK_SPAN) head = pg;
  else if (k == PORF_GC_PK_TAIL) head = porf_gc_pages[pg].aux;
  else return;
  const u32 base = head << PORF_GC_SPAGE_SHIFT;
  const u32 g = porf_gc_gran(base);
  if (porf_gc_bit(PORF_GC_B_ALLOC, g) == 0u) return;
  if (porf_gc_bit(PORF_GC_B_YOUNG, g) != 0u) { *young_base_present = 1; return; }
  porf_gc_scan_card_object(base, from, to);
}

static void porf_gc_scan_cards(void) {
  const u32 c_lo = porf_heap_base >> 9;
  const u32 c_hi = porf_heap_top >> 9;
  for (u32 cw = c_lo & ~7u; cw < c_hi; cw += 8u) {
    u64 w8;
    memcpy(&w8, porf_gc_cards + cw, 8);
    if (w8 == 0) continue;
    for (u32 j = 0; j < 8u; j++) {
      const u32 c = cw + j;
      if (c < c_lo || c >= c_hi || porf_gc_cards[c] == 0) continue;
      int young_base_present = 0;
      porf_gc_scan_young_seen = 0;
      porf_gc_scan_card(c, &young_base_present);
      porf_gc_drain_mark_queue();
      porf_gc_cards[c] = (porf_gc_scan_young_seen || young_base_present) ? 1 : 0;
    }
  }
}

static void porf_gc_partial_push(u32 pg) {
  struct porf_gc_page* m = &porf_gc_pages[pg];
  if ((m->flags & PORF_GC_PF_PARTIAL) != 0u) return;
  m->flags |= PORF_GC_PF_PARTIAL;
  m->aux = porf_gc_partial[m->cidx];
  porf_gc_partial[m->cidx] = pg + 1u;
}

static void porf_gc_partial_remove(u32 pg) {
  struct porf_gc_page* m = &porf_gc_pages[pg];
  u32* link = &porf_gc_partial[m->cidx];
  while (*link != 0) {
    const u32 cur = *link - 1u;
    if (cur == pg) {
      *link = porf_gc_pages[cur].aux;
      m->aux = 0;
      m->flags &= (u8)~PORF_GC_PF_PARTIAL;
      return;
    }
    link = &porf_gc_pages[cur].aux;
  }
}

// 0 freed, 1 live without young, 2 live with young
static int porf_gc_sweep_page_small(u32 pg, int minor, u64* promoted_bytes, u64* live_bytes) {
  struct porf_gc_page* m = &porf_gc_pages[pg];
  const u32 cls = m->cls;
  const u32 npg = porf_gc_cls_pages[m->cidx];
  u64* blk = porf_gc_meta + ((size_t)pg << 5);
  const int fin = (m->flags & PORF_GC_PF_FIN) != 0;
  u32 live = 0, young_left = 0;
  for (u32 w = 0; w < npg * 8u; w++) {
    u64* grp = blk + ((size_t)w << 2);
    u64 a = grp[0], mk = grp[1], y = grp[2], g = grp[3];
    const u64 dead = minor ? (y & ~mk) : (a & ~mk);
    if (fin && dead != 0ull) {
      u64 d = dead;
      while (d != 0ull) {
        const int b = __builtin_ctzll(d);
        d &= d - 1ull;
        const u32 body = (pg << PORF_GC_SPAGE_SHIFT) + (((u32)w * 64u + (u32)b) << 4);
        const u8 kd = porf_gc_kinds[porf_gc_gran(body)];
        if (kd == ${TYPES.__porffor_generator}u || kd == ${TYPES.__porffor_asyncgenerator}u)
          porf_gc_finalize_body((i32)body, (i32)kd);
      }
    }
    a &= ~dead;
    u64 newy = 0;
    if (minor) {
      const u64 survy = y & mk;
      const u64 promote = survy & g;
      newy = survy & ~g;
      if (promote != 0ull) *promoted_bytes += (u64)__builtin_popcountll(promote) * cls;
    }
    grp[0] = a;
    grp[1] = 0;
    grp[2] = newy;
    grp[3] = newy;
    live += (u32)__builtin_popcountll(a);
    young_left += (u32)__builtin_popcountll(newy);
  }
  if (live == 0) {
    if ((m->flags & PORF_GC_PF_PARTIAL) != 0u) porf_gc_partial_remove(pg);
    m->flags = 0;
    m->cursor = 0;
    porf_gc_release_run(pg, npg);
    return 0;
  }
  *live_bytes += (u64)live * cls;
  m->cursor = 0;
  if (live < (u32)porf_gc_cls_slots[m->cidx]) porf_gc_partial_push(pg);
  return young_left > 0 ? 2 : 1;
}

static int porf_gc_sweep_span(u32 pg, int minor, u64* promoted_bytes, u64* live_bytes) {
  struct porf_gc_page* m = &porf_gc_pages[pg];
  const u32 npg = m->aux;
  const u32 body = pg << PORF_GC_SPAGE_SHIFT;
  const u32 g = porf_gc_gran(body);
  const int young = porf_gc_bit(PORF_GC_B_YOUNG, g) != 0u;
  const int marked = porf_gc_bit(PORF_GC_B_MARK, g) != 0u;
  if (minor && !young) { *live_bytes += (u64)npg * PORF_GC_SPAGE; return 1; }
  if (!marked) {
    const u8 kd = porf_gc_kinds[g];
    if (kd == ${TYPES.__porffor_generator}u || kd == ${TYPES.__porffor_asyncgenerator}u)
      porf_gc_finalize_body((i32)body, (i32)kd);
    porf_gc_bit_clear(PORF_GC_B_ALLOC, g);
    porf_gc_bit_clear(PORF_GC_B_YOUNG, g);
    porf_gc_bit_clear(PORF_GC_B_AGED, g);
    m->flags = 0;
    porf_gc_release_run(pg, npg);
    return 0;
  }
  porf_gc_bit_clear(PORF_GC_B_MARK, g);
  *live_bytes += (u64)npg * PORF_GC_SPAGE;
  if (!minor) {
    porf_gc_bit_clear(PORF_GC_B_YOUNG, g);
    porf_gc_bit_clear(PORF_GC_B_AGED, g);
    return 1;
  }
  if (porf_gc_bit(PORF_GC_B_AGED, g) != 0u) {
    porf_gc_bit_clear(PORF_GC_B_YOUNG, g);
    porf_gc_bit_clear(PORF_GC_B_AGED, g);
    *promoted_bytes += (u64)npg * PORF_GC_SPAGE;
    return 1;
  }
  porf_gc_bit_set(PORF_GC_B_AGED, g);
  return 2;
}

static void porf_gc_madv_dontneed(u32 start, size_t len) {
#if PORF_CAN_DECOMMIT && defined(MADV_DONTNEED)
  (void)madvise(MEM + start, len, MADV_DONTNEED);
#elif PORF_CAN_DECOMMIT && defined(MADV_FREE)
  (void)madvise(MEM + start, len, MADV_FREE);
#else
  (void)start;
  (void)len;
#endif
}

static void porf_gc_discard_range(u32 start, u32 end) {
  if (end <= start) return;
  porf_gc_madv_dontneed(start, (size_t)(end - start));
}

static void porf_gc_retreat_heap_top(void) {
  while (porf_heap_top > porf_heap_base) {
    const u32 pg = (porf_heap_top >> PORF_GC_SPAGE_SHIFT) - 1u;
    if ((porf_gc_free_pages[pg >> 6] & (1ull << (pg & 63u))) == 0u) break;
    porf_gc_free_pages[pg >> 6] &= ~(1ull << (pg & 63u));
    if (porf_gc_free_page_count > 0) porf_gc_free_page_count--;
    porf_heap_top -= PORF_GC_SPAGE;
  }
}

static void porf_gc_discard_free_runs(void) {
  const u32 top = porf_heap_top >> PORF_GC_SPAGE_SHIFT;
  u32 run_start = 0, run_len = 0;
  for (u32 pg = porf_heap_base >> PORF_GC_SPAGE_SHIFT; pg < top; pg++) {
    if ((porf_gc_free_pages[pg >> 6] & (1ull << (pg & 63u))) != 0u) {
      if (run_len == 0) run_start = pg;
      run_len++;
    } else {
      if (run_len >= 32u) porf_gc_discard_range(run_start << PORF_GC_SPAGE_SHIFT, (run_start + run_len) << PORF_GC_SPAGE_SHIFT);
      run_len = 0;
    }
  }
  if (run_len >= 32u) porf_gc_discard_range(run_start << PORF_GC_SPAGE_SHIFT, (run_start + run_len) << PORF_GC_SPAGE_SHIFT);
}

static void porf_gc_maybe_trim_memory(void) {
  const u32 trim_granule = 1u << 20;
  const u32 keep_slack = 16u * 1024u * 1024u;

  u64 wanted64 = ((u64)porf_heap_top + keep_slack + trim_granule - 1ull) & ~((u64)trim_granule - 1ull);
  const u64 min_committed = ((u64)porf_heap_base + 65536ull + trim_granule - 1ull) & ~((u64)trim_granule - 1ull);
  if (wanted64 < min_committed) wanted64 = min_committed;
  if (wanted64 >= porf_heap_committed) return;

  const u32 wanted = (u32)wanted64;
  const u64 trim_bytes64 = porf_heap_committed - wanted64;
  if (trim_bytes64 > SIZE_MAX) return;
  const size_t trim_bytes = (size_t)trim_bytes64;
  if (trim_bytes < trim_granule) return;

  if (!PORF_CAN_DECOMMIT) return;
  // replacing the tail drops its pages but keeps the reservation
  if (mmap(MEM + wanted, trim_bytes, PROT_NONE, MAP_FIXED | MAP_PRIVATE | MAP_ANONYMOUS, -1, 0) == MAP_FAILED) return;
  porf_heap_committed = wanted;
}

static inline u64 porf_gc_allocation_debt_threshold(void) {
  u64 threshold = porf_gc_last_live_bytes / 2u;
  if (threshold < porf_gc_allocation_debt_min) return porf_gc_allocation_debt_min;
  if (threshold > porf_gc_allocation_debt_max) return porf_gc_allocation_debt_max;
  return threshold;
}
static inline int porf_gc_can_grow_for_request(u32 request_size) {
  if (porf_gc_last_live_bytes == 0) return 0;
  const u64 allocation_bytes = 8u + (u64)request_size;
  const u64 heap_slack = (u64)(PORF_ARENA_RESERVE - porf_heap_top);
  if (heap_slack <= 16ull * 1024ull * 1024ull + allocation_bytes) return 0;
  const u64 heap_bytes = porf_heap_top > porf_heap_base ? (u64)(porf_heap_top - porf_heap_base) : 0u;
  const u64 live_bytes = porf_gc_last_live_bytes;
  u64 grow_window = live_bytes + 64ull * 1024ull * 1024ull;
  if (grow_window < 1ull * 1024ull * 1024ull) grow_window = 1ull * 1024ull * 1024ull;
  return heap_bytes + allocation_bytes <= grow_window;
}
static inline int porf_gc_should_collect_for(u32 request_size) {
  const u64 threshold = porf_gc_allocation_debt_threshold();
  if (porf_gc_allocation_debt < threshold) return 0;
  if (porf_gc_last_live_bytes == 0) return !porf_gc_can_grow_for_request(request_size);
  if (porf_gc_allocation_debt >= threshold * 4u) return 1;
  if (porf_gc_can_grow_for_request(request_size)) return 0;
  return 1;
}

static void porf_gc_minor(void) {
  porf_gc_collect(1);
  if (porf_gc_full_due(0)) porf_gc_collect(0);
}
#ifdef PORF_GC_DEFER
${st}void porf_gc_run_pending(void) {
  if (!porf_gc_pending) return;
  const int full = porf_gc_pending == 2;
  porf_gc_pending = 0;
  if (full) porf_gc_collect(0); else porf_gc_minor();
}
#endif

${st}void porf_gc_collect(int minor) {
#ifdef PORF_GC_OFF
  // debugging: never collect (the heap only grows), to tell a GC bug from any other
  (void)minor;
  return;
#endif
  if (porf_heap_base == 0) return;
  for (i32 ci = 0; ci < PORF_GC_NCLASSES; ci++) porf_gc_publish_window(ci);
  porf_gc_minor_mode = minor;
  if (!minor) {
    porf_gc_claimed_since_full = 0;
    porf_gc_promoted_since_full = 0;
    const size_t w_lo = (size_t)(porf_heap_base >> 4 >> 6);
    const size_t w_hi = (size_t)(((porf_heap_top >> 4) + 63u) >> 6);
    for (size_t w = w_lo; w < w_hi; w++)
      porf_gc_meta[(((w >> 3) << 5) | ((w & 7u) << 2)) + PORF_GC_B_MARK] = 0;
  }
  porf_gc_allocation_debt = 0;
  porf_gc_static_marks_len = 0;
  if (porf_gc_static_marks != NULL) memset(porf_gc_static_marks, 0, (size_t)porf_gc_static_marks_cap * sizeof(*porf_gc_static_marks));
  porf_gc_mark_queue_len = 0;
  porf_gc_weakmaps_len = 0;
  porf_gc_boxed_marks_len = 0;
  porf_gc_mark_native_roots();
  porf_gc_mark_cons_roots();
  porf_gc_mark_js(porf_exception.val, porf_exception.type);
  porf_gc_mark_global_roots();
  porf_gc_drain_mark_queue();
  if (minor) porf_gc_scan_cards();
  porf_gc_mark_global_raw_roots();
  porf_gc_drain_mark_queue();
  porf_gc_process_weakmaps();
  porf_gc_drain_mark_queue();

  u64 promoted = 0, live_bytes = 0;
  if (minor) {
    i32 out = 0;
    for (i32 i = 0; i < porf_gc_touched_len; i++) {
      const u32 pg = porf_gc_touched[i];
      const u8 k = porf_gc_page_kind[pg];
      int status = 0;
      if (k == PORF_GC_PK_SMALL) status = porf_gc_sweep_page_small(pg, 1, &promoted, &live_bytes);
      else if (k == PORF_GC_PK_SPAN) status = porf_gc_sweep_span(pg, 1, &promoted, &live_bytes);
      if (status == 2) { porf_gc_touched[out++] = pg; continue; }
      porf_gc_pages[pg].flags &= (u8)~PORF_GC_PF_TOUCHED;
    }
    porf_gc_touched_len = out;
    porf_gc_promoted_since_full += (i64)promoted;
    porf_gc_retreat_heap_top();
    porf_gc_maybe_trim_memory();
  } else {
    for (i32 i = 0; i < porf_gc_touched_len; i++)
      porf_gc_pages[porf_gc_touched[i]].flags &= (u8)~PORF_GC_PF_TOUCHED;
    porf_gc_touched_len = 0;
    for (i32 ci = 0; ci < PORF_GC_NCLASSES; ci++) {
      u32 pg1 = porf_gc_partial[ci];
      while (pg1 != 0) {
        const u32 next = porf_gc_pages[pg1 - 1u].aux;
        porf_gc_pages[pg1 - 1u].flags &= (u8)~PORF_GC_PF_PARTIAL;
        pg1 = next;
      }
      porf_gc_partial[ci] = 0;
    }
    const u32 top = porf_heap_top >> PORF_GC_SPAGE_SHIFT;
    for (u32 pg = porf_heap_base >> PORF_GC_SPAGE_SHIFT; pg < top; pg++) {
      const u8 k = porf_gc_page_kind[pg];
      if (k == PORF_GC_PK_SMALL) {
        if ((porf_gc_pages[pg].flags & PORF_GC_PF_TAIL) != 0u) continue;
        porf_gc_sweep_page_small(pg, 0, &promoted, &live_bytes);
      } else if (k == PORF_GC_PK_SPAN) porf_gc_sweep_span(pg, 0, &promoted, &live_bytes);
    }
    porf_gc_last_live_bytes = live_bytes;
    porf_gc_live_bytes = live_bytes;
    memset(porf_gc_cards + (porf_heap_base >> 9), 0, (size_t)((porf_heap_top - porf_heap_base) >> 9) + 1);
    porf_gc_run_cache_drain();
    porf_gc_retreat_heap_top();
    porf_gc_discard_free_runs();
    porf_gc_maybe_trim_memory();
  }
  memset(porf_gc_active, 0, sizeof(porf_gc_active));
  porf_gc_minor_mode = 0;
}
`;
};

// jsval encoding: f64 numbers are themselves, else 0xFFF8 (sign + quiet-NaN) << 48 |
// type:8 << 43 | payload:32. hardware qNaN is 0x7FF8 (sign clear) so never collides,
// sign-set NaNs from raw bytes are canonicalized at Float64Array/DataView reads (porf_canon)
// bigintUsed: the program can hold a BigInt, which packs specially (porf_pack)
// stackful: some coroutine runs on a stack of its own (not stackless, see stackless.js)
const RUNTIME_HEAD = (prefs, usesCoro = false, toStr = null, bigintUsed = true, stackful = false, toNum = null, toPrimDefault = null, toPrimNumber = null, arrHole = null) => {
  const st = 'static ';
  const sti = 'static inline ';
  // --ropes: string concatenation builds ropes (needs the GC to trace them)
  const ropes = !!Prefs.ropes && prefs.gc !== false;
  // --dtoa: how a non-integer number becomes its shortest digits. dragonbox (the default),
  // ryu or grisu3 (dtoa.js, only the chosen one compiled in), or libc (printf and strtod
  // until the digits round-trip: slower, and 17 digits where 16 would do when the correctly
  // rounded 16 do not round-trip)
  const dtoa = typeof Prefs.dtoa === 'string' ? Prefs.dtoa : 'dragonbox';
  if (dtoa !== 'libc' && !Object.hasOwn(DTOA, dtoa)) throw new Error(`unknown --dtoa=${dtoa} (${Object.keys(DTOA).join(', ')} or libc)`);
  return `// generated by porffor ${globalThis.version}
// 1 when some coroutine runs on a stack of its own (on WASI P3, a component-model thread);
// 0 when every one is stackless, and nothing needs a coroutine stack or a thread. An
// embedding reads it too: the component glue lifts async exports with a callback then
#define PORF_STACKFUL ${stackful ? 1 : 0}
// JS rounds after every operation: a * b + c must not become one fused multiply-add (one
// rounding), which C allows by default (0.1 * 10 - 1 is 0, not 5.55e-17). Clang honours
// this; for GCC, which ignores it, the build passes -ffp-contract=off
#pragma STDC FP_CONTRACT OFF
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif
#ifdef PORF_NO_EH
// PORF_NO_EH: no setjmp/longjmp (wasm without the exceptions proposal). A throw with no
// enclosing try still reports and exits; a throw inside a try aborts instead of catching.
typedef unsigned long long jmp_buf[1];
#define _setjmp(b) ((void)(b), 0)
#define setjmp(b) ((void)(b), 0)
#define _longjmp(b, v) (fputs("porffor: exception thrown inside try; built with PORF_NO_EH\\n", stderr), abort())
#else
#include <setjmp.h>
#endif
#include <math.h>

#include <signal.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/mman.h>
#include <sys/stat.h>
#ifndef __wasi__
#include <sys/wait.h>
#endif
#include <sys/random.h>
#include <time.h>

// Printing (console.*) writes to porf_print_out: stdout, or stderr while console.error
// and console.warn print.
static FILE* porf_print_out = NULL;
// The console's two files: stdout and stderr, or under PORF_CONSOLE_FILES the ones the
// embedder defines, for one where a write may not block where it is made (a P3
// component's sync export: wasi-porffor hands in memory streams and writes them out later).
#ifdef PORF_CONSOLE_FILES
extern FILE* porf_console_out;
extern FILE* porf_console_err;
#define PORF_CONSOLE_OUT porf_console_out
#define PORF_CONSOLE_ERR porf_console_err
#else
#define PORF_CONSOLE_OUT stdout
#define PORF_CONSOLE_ERR stderr
#endif
#define PORF_PRINT_OUT (porf_print_out ? porf_print_out : PORF_CONSOLE_OUT)
${prefs.repl ? `static int porf_repl_output_enabled = 1;
#define printf(...) (porf_repl_output_enabled ? fprintf(PORF_PRINT_OUT, __VA_ARGS__) : 0)
` : `#define printf(...) fprintf(PORF_PRINT_OUT, __VA_ARGS__)
`}
// Output without printf: its formatter is the bulk of libc's code in a component, and a
// program's printing needs only strings and integers
static inline void porf_out(const char* s, int n) {
${prefs.repl ? '  if (!porf_repl_output_enabled) return;\n' : ''}  fwrite(s, 1, (size_t)n, PORF_PRINT_OUT);
}
// v in decimal into b (21 bytes suffice), its length returned
static inline int porf_fmt_int(char* b, long long v) {
  char r[20];
  int m = 0, k = 0;
  unsigned long long u = v < 0 ? 0ull - (unsigned long long)v : (unsigned long long)v;
  do { r[m++] = (char)('0' + u % 10u); u /= 10u; } while (u);
  if (v < 0) b[k++] = '-';
  while (m) b[k++] = r[--m];
  return k;
}
static inline void porf_out_int(long long v) { char b[21]; porf_out(b, porf_fmt_int(b, v)); }
static inline void porf_err(const char* s) { fputs(s, stderr); }
static inline void porf_err_int(long long v) { char b[21]; fwrite(b, 1, (size_t)porf_fmt_int(b, v), stderr); }
// One code point as UTF-8 (a lone surrogate as U+FFFD).
static void porf_print_utf8(uint32_t c) {
  char b[4];
  int n;
${prefs.repl ? '  if (!porf_repl_output_enabled) return;\n' : ''}  if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
  if (c < 0x80) { b[0] = (char)c; n = 1; }
  else if (c < 0x800) { b[0] = (char)(0xC0 | (c >> 6)); b[1] = (char)(0x80 | (c & 0x3F)); n = 2; }
  else if (c < 0x10000) { b[0] = (char)(0xE0 | (c >> 12)); b[1] = (char)(0x80 | ((c >> 6) & 0x3F)); b[2] = (char)(0x80 | (c & 0x3F)); n = 3; }
  else { b[0] = (char)(0xF0 | (c >> 18)); b[1] = (char)(0x80 | ((c >> 12) & 0x3F)); b[2] = (char)(0x80 | ((c >> 6) & 0x3F)); b[3] = (char)(0x80 | (c & 0x3F)); n = 4; }
  fwrite(b, 1, (size_t)n, PORF_PRINT_OUT);
}

typedef uint8_t u8;
typedef uint16_t u16;
typedef int32_t i32;
typedef uint32_t u32;
typedef int64_t i64;
typedef uint64_t u64;
typedef float f32;
typedef double f64;
typedef struct jsval { f64 val; i32 type; } jsval;
typedef u64 jsbits;


// arena base: reserved once at init, NEVER moves. a fixed constant VA is
// not reliably free on macOS (per-process dyld/malloc randomization), and
// x86-64 has no [imm64+reg] addressing so a constant folds to a register
// materialization anyway - a once-set global compiles to the same code.
// 0x400000000 is used as a hint for deterministic debugging when free.
${st}u8* porf_mem;
#define MEM porf_mem
#define PORF_NOINLINE __attribute__((noinline))
// run-once code (module init, top level): optimize for size whatever -O the unit gets
// rarely-run code (slow paths): the same, and kept off the hot path's layout
#if defined(__clang__)
#define PORF_ONCE __attribute__((noinline, minsize))
#define PORF_COLD __attribute__((cold, noinline, minsize))
#elif defined(__GNUC__)
#define PORF_ONCE __attribute__((noinline, optimize("Os")))
#define PORF_COLD __attribute__((cold, noinline, optimize("Os")))
#else
#define PORF_ONCE
#define PORF_COLD
#endif
#define PORF_NORETURN __attribute__((cold, noinline, noreturn))
${usesCoro ? `#if defined(__wasm__) && !defined(PORF_NO_STACK_CHECK)
// A coroutine's stack is a block of linear memory with no guard page, so every function
// checks the stack pointer (after its frame is taken) against the running coroutine's
// stack: below its limit and inside the guard region reserved under it is an overflow,
// which traps where it happens instead of overwriting the memory below. Only that region
// counts, so another thread running meanwhile (its stack is elsewhere) is never mistaken
// for one. Both are 0 (unchecked) outside coroutines; the switches set them.
static u32 porf_stack_limit = 0;
static u32 porf_stack_floor = 0; // one per declaration: split output declares each in porf.h
#ifdef __wasm_libcall_thread_context__
// cooperative threads (P3): the stack pointer is thread context, read through the linker's
u32 __wasm_get_stack_pointer(void);
static inline __attribute__((always_inline)) u32 porf_stack_pointer(void) {
  return __wasm_get_stack_pointer();
}
#else
static inline __attribute__((always_inline)) u32 porf_stack_pointer(void) {
  u32 sp;
  __asm__ volatile(".globaltype __stack_pointer, i32\\n\\tglobal.get __stack_pointer\\n\\tlocal.set %0" : "=r"(sp));
  return sp;
}
#endif
PORF_NORETURN static void porf_stack_overflow(void) {
  fputs("porffor: stack overflow in a coroutine (build with a larger -DPORF_CORO_STACK_SIZE)\\n", stderr);
  __builtin_trap();
}
#define PORF_STACK_CHECK() do { \\
  const u32 porf_sp_ = porf_stack_pointer(); \\
  if (__builtin_expect(porf_sp_ < porf_stack_limit && porf_sp_ >= porf_stack_floor, 0)) porf_stack_overflow(); \\
} while (0)
#else
#define PORF_STACK_CHECK() ((void)0)
#endif
` : `#define PORF_STACK_CHECK() ((void)0)
`}\
// A suspended coroutine's body keeps its live values in its frame, and on wasm an
// optimised frame holds them in wasm locals the conservative GC cannot scan. Unoptimised,
// every local lives in the (scannable) shadow stack, so a collection at a safe point
// cannot free what a suspended coroutine still uses. Native scans registers via setjmp.
#if defined(__wasm__) && defined(__clang__)
#define PORF_CORO_BODY __attribute__((optnone, noinline))
#else
#define PORF_CORO_BODY
#endif
#if !defined(MAP_NORESERVE) || defined(__wasi__)
#undef MAP_NORESERVE
#define MAP_NORESERVE 0 // wasi-libc's emulated mmap rejects it
#endif
#ifdef __wasi__
// wasi's malloc-backed mmap ignores fixed hints and cannot change protections
// or decommit, so use a small, fully committed arena
#define PORF_ARENA_HINT NULL
#ifndef PORF_ARENA_RESERVE
#define PORF_ARENA_RESERVE (1ull << 26)
#endif
#define PORF_MMAP_RESERVE_PROT (PROT_READ | PROT_WRITE)
#define PORF_CAN_DECOMMIT 0
#else
#define PORF_ARENA_HINT ((void*)0x400000000ull)
#define PORF_ARENA_RESERVE (1ull << 32)
#define PORF_MMAP_RESERVE_PROT PROT_NONE
#define PORF_CAN_DECOMMIT 1
#endif
extern const u32 porf_static_end;
#define PORF_GC_ENABLED ${prefs.gc === false ? 0 : 1}
#ifdef PORF_GC_DEFER
// PORF_GC_DEFER: a collection due during an allocation is only requested, and runs at
// the next porf_gc_run_pending(). For an embedder whose C frames may hold values the
// conservative scan cannot see (wasm locals), which calls it where none are live.
static int porf_gc_pending = 0; // 1 = minor requested, 2 = full requested
#endif

#define JV_PATTERN 0xFFF8000000000000ull
#define JV_TYPE_MASK 0x07F8000000000000ull
#define JV_UNDEFINED_BITS (JV_PATTERN | ((u64)${TYPES.undefined} << 43))
#define JV_UNDEFINED ((jsval){0.0, ${TYPES.undefined}})
#define JV_ZERO_BITS (JV_PATTERN | ((u64)${TYPES.number} << 43))

#define PORF_PROMISE_RESULT 0
#define PORF_PROMISE_FULFILL_HEAD 8
#define PORF_PROMISE_FULFILL_TAIL 12
#define PORF_PROMISE_REJECT_HEAD 16
#define PORF_PROMISE_REJECT_TAIL 20
#define PORF_PROMISE_PAYLOAD 24
#define PORF_PROMISE_STATE 32
#define PORF_PROMISE_FLAGS 33
#define PORF_PROMISE_HANDLED 34
#define PORF_PROMISE_SIZE 40

#define PORF_REACTION_HANDLER 0
#define PORF_REACTION_OUT_PROMISE 8
#define PORF_REACTION_VALUE 16
#define PORF_REACTION_NEXT 24
#define PORF_REACTION_PAYLOAD 28
#define PORF_REACTION_KIND 32
#define PORF_REACTION_FLAGS 33
// the async context current when the reaction was made (AsyncLocalStorage's frame), current again
// while it runs (__Porffor_promise_runJobs)
#define PORF_REACTION_CONTEXT 40
#define PORF_REACTION_SIZE 48

#define PORF_GC_KIND_PROMISE_REACTION 248u

// the current async context: AsyncLocalStorage's frame (runtime/node/async_hooks.mjs), or none:
// 0, not undefined's bits, so it is zero-filled (an initialised global would be a data section of
// its own, a page of binary on arm64 macOS)
static jsbits porf_async_context = 0;

static inline f64 porf_bits_to_f64_bits(u64 b) { f64 d; memcpy(&d, &b, 8); return d; }
static inline u64 porf_f64_to_bits(f64 d) { u64 b; memcpy(&b, &d, 8); return b; }
static inline f64 porf_bits_to_f32(u32 b) { f32 f; memcpy(&f, &b, 4); return (f64)f; }
static inline u32 porf_f32_to_bits(f64 d) { f32 f = (f32)d; u32 b; memcpy(&b, &f, 4); return b; }
// binary16 (Float16Array, Math.f16round): exact to double; from double rounded once, to
// nearest with ties to even (rint in the default rounding mode), not through float
static inline f64 porf_f16_to_f64(u16 h) {
  const u32 e = (h >> 10) & 0x1f, m = h & 0x3ff;
  const f64 v = e == 0 ? ldexp((f64)m, -24) : e == 31 ? (m ? NAN : INFINITY) : ldexp((f64)(m | 0x400), (i32)e - 25);
  return (h & 0x8000) ? -v : v;
}
static u16 porf_f64_to_f16(f64 d) {
  const u16 sign = signbit(d) ? 0x8000 : 0;
  if (d != d) return 0x7e00;
  const f64 a = fabs(d);
  if (a == INFINITY) return sign | 0x7c00;
  // subnormal: whole multiples of 2^-24 (rounding up to 0x400 is the smallest normal)
  if (a < 0x1p-14) return sign | (u16)rint(a * 0x1p24);
  int x; const f64 f = frexp(a, &x); // a = f * 2^x, f in [0.5, 1)
  f64 sig = rint(f * 2048);          // 11 significant bits
  int e = x - 1 + 15;
  if (sig == 2048) { sig = 1024; e++; }
  if (e >= 31) return sign | 0x7c00;
  return sign | (u16)(e << 10) | (u16)(sig - 1024);
}
static inline f64 porf_jsval_to_f64(jsval v) { return v.val; }
#define porf_bits_to_f64(x) _Generic((x), jsval: porf_jsval_to_f64, default: porf_bits_to_f64_bits)(x)

static inline int porf_jv_is_num(jsval v) { return v.type == ${TYPES.number}; }
static inline i32 porf_jv_type(jsval v) { return v.type; }
static inline jsval porf_box_num(f64 d) { return (jsval){d, ${TYPES.number}}; }
static inline jsval porf_box(f64 payload, i32 type) {
  return type == ${TYPES.number} ? porf_box_num(payload) : (jsval){payload, type};
}
static inline jsbits porf_pack(jsval v) {
  if (v.type == ${TYPES.number}) {
    const jsbits b = porf_f64_to_bits(v.val);
    // negative quiet NaNs collide with the boxed encoding: canonicalize
    return (b & JV_PATTERN) == JV_PATTERN ? 0x7FF8000000000000ull : b;
  }
${bigintUsed ? `  // a BigInt: inline, its value as 42-bit two's complement; heap, bit 42 and its pointer
  if (v.type == ${TYPES.bigint})
    return JV_PATTERN | ((u64)${TYPES.bigint} << 43) | (v.val >= 2251799813685248.0
      ? (1ull << 42) | (u64)(u32)(v.val - 2251799813685248.0)
      : (u64)(i64)v.val & 0x3FFFFFFFFFFull);
` : ''}\
  return JV_PATTERN | ((u64)(v.type & 0xFF) << 43) | (u64)(u32)v.val;
}
${sti}jsbits porf_arr_pack(jsval v) {
  const jsbits b = porf_pack(v);
  return b == 0 ? JV_ZERO_BITS : b;
}
static inline jsval porf_unpack(jsbits b) {
  if ((b & JV_PATTERN) != JV_PATTERN) return porf_box_num(porf_bits_to_f64(b));
${bigintUsed ? `  if (((b >> 43) & 0xFF) == ${TYPES.bigint})
    return (jsval){(b >> 42) & 1 ? (f64)(u32)b + 2251799813685248.0 : (f64)((i64)(b << 22) >> 22), ${TYPES.bigint}};
` : ''}\
  return (jsval){(f64)(u32)b, (i32)((b >> 43) & 0xFF)};
}
static inline f64 porf_canon(f64 d) { return d == d ? d : porf_bits_to_f64(0x7FF8000000000000ull); }

static u32* porf_promise_job_queue = NULL;
static u32 porf_promise_job_head = 0;
static u32 porf_promise_job_len = 0;
static u32 porf_promise_job_cap = 0;

static void (*porf_promise_run_coro_reaction_impl)(u32) = NULL;

static void porf_promise_enqueue_job(u32 reaction) {
  if (reaction == 0) return;
  if (porf_promise_job_len == porf_promise_job_cap) {
    const u32 old_cap = porf_promise_job_cap;
    const u32 new_cap = old_cap == 0 ? 64u : old_cap * 2u;
    u32* next = (u32*)malloc((size_t)new_cap * sizeof(u32));
    if (!next) abort();
    for (u32 i = 0; i < porf_promise_job_len; i++) {
      next[i] = porf_promise_job_queue[(porf_promise_job_head + i) & (old_cap - 1u)];
    }
    free(porf_promise_job_queue);
    porf_promise_job_queue = next;
    porf_promise_job_cap = new_cap;
    porf_promise_job_head = 0;
  }
  porf_promise_job_queue[(porf_promise_job_head + porf_promise_job_len) & (porf_promise_job_cap - 1u)] = reaction;
  porf_promise_job_len++;
}

static u32 porf_promise_dequeue_job(void) {
  if (porf_promise_job_len == 0) return 0;
  const u32 reaction = porf_promise_job_queue[porf_promise_job_head];
  porf_promise_job_head = (porf_promise_job_head + 1u) & (porf_promise_job_cap - 1u);
  porf_promise_job_len--;
  if (porf_promise_job_len == 0) porf_promise_job_head = 0;
  return reaction;
}

static void porf_promise_run_coro_reaction(u32 reaction) {
  if (!porf_promise_run_coro_reaction_impl) abort();
  porf_promise_run_coro_reaction_impl(reaction);
}

static inline i32 porf_jv_eq(jsval a, jsval b) {
  if (a.type != b.type) return 0;
  if (a.type == ${TYPES.number}) return a.val == b.val;
  return (u32)a.val == (u32)b.val;
}

// truthiness: number path = one compare; boxed = payload check, strings load length
static inline i32 porf_truthy(jsval v) {
  if (v.type == ${TYPES.number}) return v.val == v.val && v.val != 0.0;
  if (v.type == ${TYPES.string} || v.type == ${TYPES.bytestring}) return *(u32*)(MEM + (u32)v.val) != 0u;
  return (u32)v.val != 0u;
}

static inline i32 porf_falsy(jsval v) {
  if (v.type == ${TYPES.number}) return v.val != v.val || v.val == 0.0;
  if (v.type == ${TYPES.string} || v.type == ${TYPES.bytestring}) return *(u32*)(MEM + (u32)v.val) == 0u;
  return (u32)v.val == 0u;
}

static inline i32 porf_nullish(jsval v) {
  return v.type == ${TYPES.undefined} || (v.type == ${TYPES.object} && (u32)v.val == 0u);
}

// saturating 64-bit integer -> 32-bit, as porf_f64_to_i32/u32 saturate an exact sum
static inline i32 porf_sat_i32(i64 r) { return r < -2147483648LL ? (i32)-2147483648LL : r > 2147483647LL ? 2147483647 : (i32)r; }
static inline u32 porf_sat_u32(i64 r) { return r < 0 ? 0u : r > 4294967295LL ? 4294967295u : (u32)r; }

// saturating f64 -> int (JS semantics handled above; this is trunc_sat)
static inline i32 porf_f64_to_i32(f64 d) {
  if (d != d) return 0;
  if (d <= -2147483648.0) return -2147483648;
  if (d >= 2147483647.0) return 2147483647;
  return (i32)d;
}
static inline u32 porf_f64_to_u32(f64 d) {
  if (d != d || d <= 0.0) return 0;
  if (d >= 4294967295.0) return 4294967295u;
  return (u32)d;
}
// ToUint32 (and ToInt32, read as i32): truncate, then wrap modulo 2^32. Below 2^63 in
// magnitude a double truncates exactly to an i64, whose low 32 bits are the answer, with no
// float division on the way (bitwise code chains these through its loop); NaN, the
// infinities and the rest go the long way, out of line so the loop stays tight
PORF_COLD static u32 porf_to_u32_slow(f64 d) {
  if (d != d || d == INFINITY || d == -INFINITY) return 0;
  f64 m = fmod(d, 4294967296.0); // exact, and d is already an integer this large
  if (m < 0.0) m += 4294967296.0;
  return (u32)m;
}
static inline u32 porf_to_u32(f64 d) {
  if (__builtin_expect(d > -9223372036854775808.0 && d < 9223372036854775808.0, 1)) return (u32)(u64)(i64)d;
  return porf_to_u32_slow(d);
}

// SIMD scans and copies for the string and byte loops of the builtins (__Porffor_simd_*): with
// wasm's 128-bit SIMD (-msimd128), 16 bytes or 8 units at a time; on any other target (tcc,
// native) the scalar loop alone, which also finishes each vector loop's tail. Indices count
// units from a data pointer's first one: MEM + base + 4.
static i32 porf_simd_find_u8(u32 base, i32 i, i32 to, u32 c) {
  const u8* s = MEM + base + 4u;
#ifdef __wasm_simd128__
  const v128_t n = wasm_i8x16_splat((int8_t)c);
  for (; i + 16 <= to; i += 16) {
    const u32 m = wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(s + i), n));
    if (m) return i + (i32)__builtin_ctz(m);
  }
#else
  // native: libc's memchr, vectorised on every target
  if (i >= to) return -1;
  const u8* hit = (const u8*)memchr(s + i, (int)(u8)c, (size_t)(to - i));
  return hit ? (i32)(hit - s) : -1;
#endif
  for (; i < to; i++) if (s[i] == (u8)c) return i;
  return -1;
}
static i32 porf_simd_find_u16(u32 base, i32 i, i32 to, u32 c) {
  const u8* s = MEM + base + 4u;
#ifdef __wasm_simd128__
  const v128_t n = wasm_i16x8_splat((int16_t)c);
  for (; i + 8 <= to; i += 8) {
    const u32 m = wasm_i16x8_bitmask(wasm_i16x8_eq(wasm_v128_load(s + i * 2), n));
    if (m) return i + (i32)__builtin_ctz(m);
  }
#else
  // native: four units a word, a zero unit in (word ^ c * 0x0001000100010001) marking a hit
  const u64 bcast = 0x0001000100010001ull * (u64)(u16)c;
  for (; i + 4 <= to; i += 4) {
    u64 w;
    memcpy(&w, s + i * 2, 8);
    w ^= bcast;
    if (((w - 0x0001000100010001ull) & ~w & 0x8000800080008000ull) != 0ull) break;
  }
#endif
  for (; i < to; i++) if (*(const u16*)(s + i * 2) == (u16)c) return i;
  return -1;
}
// the last index in [from, to) holding c, or -1
static i32 porf_simd_rfind_u8(u32 base, i32 from, i32 to, u32 c) {
  const u8* s = MEM + base + 4u;
  i32 i = to;
#ifdef __wasm_simd128__
  const v128_t n = wasm_i8x16_splat((int8_t)c);
  for (; i - 16 >= from; i -= 16) {
    const u32 m = wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(s + i - 16), n));
    if (m) return i - 16 + (31 - (i32)__builtin_clz(m));
  }
#endif
  while (i > from) if (s[--i] == (u8)c) return i;
  return -1;
}
// the first index in [i, to) whose unit is in a 256-bit set (a bitmap at MEM + set; a two-byte
// unit above 0xff is in none), or -1: the regex engine's first-character skip. SIMD looks each
// byte's bitmap byte up by swizzling the bitmap's two halves, and its bit by a swizzled mask
static i32 porf_simd_find_set_u8(u32 base, i32 i, i32 to, u32 set) {
  const u8* s = MEM + base + 4u;
  const u8* bits = MEM + set;
#ifdef __wasm_simd128__
  const v128_t lo = wasm_v128_load(bits), hi = wasm_v128_load(bits + 16);
  const v128_t bitOf = wasm_i8x16_make(1, 2, 4, 8, 16, 32, 64, -128, 1, 2, 4, 8, 16, 32, 64, -128);
  const v128_t seven = wasm_i8x16_splat(7), sixteen = wasm_i8x16_splat(16), zero = wasm_i8x16_splat(0);
  for (; i + 16 <= to; i += 16) {
    const v128_t v = wasm_v128_load(s + i);
    const v128_t idx = wasm_u8x16_shr(v, 3);
    const v128_t row = wasm_v128_or(wasm_i8x16_swizzle(lo, idx), wasm_i8x16_swizzle(hi, wasm_i8x16_sub(idx, sixteen)));
    const v128_t bit = wasm_i8x16_swizzle(bitOf, wasm_v128_and(v, seven));
    const u32 m = wasm_i8x16_bitmask(wasm_i8x16_ne(wasm_v128_and(row, bit), zero));
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) { const u32 u = s[i]; if (bits[u >> 3] & (1u << (u & 7))) return i; }
  return -1;
}
static i32 porf_simd_find_set_u16(u32 base, i32 i, i32 to, u32 set) {
  const u8* s = MEM + base + 4u;
  const u8* bits = MEM + set;
#ifdef __wasm_simd128__
  const v128_t lo = wasm_v128_load(bits), hi = wasm_v128_load(bits + 16);
  const v128_t bitOf = wasm_i8x16_make(1, 2, 4, 8, 16, 32, 64, -128, 1, 2, 4, 8, 16, 32, 64, -128);
  const v128_t seven = wasm_i8x16_splat(7), sixteen = wasm_i8x16_splat(16), zero = wasm_i8x16_splat(0);
  const v128_t byte = wasm_i16x8_splat(0xff);
  for (; i + 16 <= to; i += 16) {
    const v128_t a = wasm_v128_load(s + i * 2), b = wasm_v128_load(s + i * 2 + 16);
    // units above 0xff: in no set (a signed narrow keeps their all-ones mask all ones)
    const v128_t big = wasm_i8x16_narrow_i16x8(wasm_u16x8_gt(a, byte), wasm_u16x8_gt(b, byte));
    const v128_t v = wasm_u8x16_narrow_i16x8(wasm_v128_and(a, byte), wasm_v128_and(b, byte));
    const v128_t idx = wasm_u8x16_shr(v, 3);
    const v128_t row = wasm_v128_or(wasm_i8x16_swizzle(lo, idx), wasm_i8x16_swizzle(hi, wasm_i8x16_sub(idx, sixteen)));
    const v128_t bit = wasm_i8x16_swizzle(bitOf, wasm_v128_and(v, seven));
    const v128_t hit = wasm_v128_andnot(wasm_i8x16_ne(wasm_v128_and(row, bit), zero), big);
    const u32 m = wasm_i8x16_bitmask(hit);
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) { const u32 u = *(const u16*)(s + i * 2); if (u <= 0xff && (bits[u >> 3] & (1u << (u & 7)))) return i; }
  return -1;
}
// the first index in [i, to) whose unit is NOT in the 256-bit set (a two-byte unit above 0xff is
// in none), or to: the end of a class run (/[a-z]+/)
static i32 porf_simd_span_set_u8(u32 base, i32 i, i32 to, u32 set) {
  const u8* s = MEM + base + 4u;
  const u8* bits = MEM + set;
#ifdef __wasm_simd128__
  const v128_t lo = wasm_v128_load(bits), hi = wasm_v128_load(bits + 16);
  const v128_t bitOf = wasm_i8x16_make(1, 2, 4, 8, 16, 32, 64, -128, 1, 2, 4, 8, 16, 32, 64, -128);
  const v128_t seven = wasm_i8x16_splat(7), sixteen = wasm_i8x16_splat(16), zero = wasm_i8x16_splat(0);
  for (; i + 16 <= to; i += 16) {
    const v128_t v = wasm_v128_load(s + i);
    const v128_t idx = wasm_u8x16_shr(v, 3);
    const v128_t row = wasm_v128_or(wasm_i8x16_swizzle(lo, idx), wasm_i8x16_swizzle(hi, wasm_i8x16_sub(idx, sixteen)));
    const v128_t bit = wasm_i8x16_swizzle(bitOf, wasm_v128_and(v, seven));
    const u32 m = wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_and(row, bit), zero));
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) { const u32 u = s[i]; if (!(bits[u >> 3] & (1u << (u & 7)))) return i; }
  return to;
}
static i32 porf_simd_span_set_u16(u32 base, i32 i, i32 to, u32 set) {
  const u8* s = MEM + base + 4u;
  const u8* bits = MEM + set;
#ifdef __wasm_simd128__
  const v128_t lo = wasm_v128_load(bits), hi = wasm_v128_load(bits + 16);
  const v128_t bitOf = wasm_i8x16_make(1, 2, 4, 8, 16, 32, 64, -128, 1, 2, 4, 8, 16, 32, 64, -128);
  const v128_t seven = wasm_i8x16_splat(7), sixteen = wasm_i8x16_splat(16), zero = wasm_i8x16_splat(0);
  const v128_t byte = wasm_i16x8_splat(0xff);
  for (; i + 16 <= to; i += 16) {
    const v128_t a = wasm_v128_load(s + i * 2), b = wasm_v128_load(s + i * 2 + 16);
    const v128_t big = wasm_i8x16_narrow_i16x8(wasm_u16x8_gt(a, byte), wasm_u16x8_gt(b, byte));
    const v128_t v = wasm_u8x16_narrow_i16x8(wasm_v128_and(a, byte), wasm_v128_and(b, byte));
    const v128_t idx = wasm_u8x16_shr(v, 3);
    const v128_t row = wasm_v128_or(wasm_i8x16_swizzle(lo, idx), wasm_i8x16_swizzle(hi, wasm_i8x16_sub(idx, sixteen)));
    const v128_t bit = wasm_i8x16_swizzle(bitOf, wasm_v128_and(v, seven));
    const v128_t miss = wasm_v128_or(wasm_i8x16_eq(wasm_v128_and(row, bit), zero), big);
    const u32 m = wasm_i8x16_bitmask(miss);
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) { const u32 u = *(const u16*)(s + i * 2); if (u > 0xff || !(bits[u >> 3] & (1u << (u & 7)))) return i; }
  return to;
}
// the first index from i whose unit is not ASCII (0x80 or above), or to
static i32 porf_simd_ascii_u8(u32 base, i32 i, i32 to) {
  const u8* s = MEM + base + 4u;
#ifdef __wasm_simd128__
  for (; i + 16 <= to; i += 16) {
    const u32 m = wasm_i8x16_bitmask(wasm_v128_load(s + i));
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) if (s[i] >= 0x80) return i;
  return to;
}
static i32 porf_simd_ascii_u16(u32 base, i32 i, i32 to) {
  const u8* s = MEM + base + 4u;
#ifdef __wasm_simd128__
  const v128_t high = wasm_i16x8_splat((int16_t)0xff80);
  for (; i + 8 <= to; i += 8) {
    const v128_t v = wasm_v128_and(wasm_v128_load(s + i * 2), high);
    const u32 m = wasm_i16x8_bitmask(wasm_i16x8_ne(v, wasm_i16x8_splat(0)));
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) if (*(const u16*)(s + i * 2) >= 0x80) return i;
  return to;
}
// JSON: the first index from i whose byte needs an escape (below 0x20, a quote, a backslash), or to
static i32 porf_simd_json_u8(u32 base, i32 i, i32 to) {
  const u8* s = MEM + base + 4u;
#ifdef __wasm_simd128__
  const v128_t space = wasm_i8x16_splat(0x20), quote = wasm_i8x16_splat(0x22), slash = wasm_i8x16_splat(0x5c);
  for (; i + 16 <= to; i += 16) {
    const v128_t v = wasm_v128_load(s + i);
    const v128_t bad = wasm_v128_or(wasm_u8x16_lt(v, space), wasm_v128_or(wasm_i8x16_eq(v, quote), wasm_i8x16_eq(v, slash)));
    const u32 m = wasm_i8x16_bitmask(bad);
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) { const u8 c = s[i]; if (c < 0x20 || c == 0x22 || c == 0x5c) return i; }
  return to;
}
// JSON, two-byte: the first index from i whose unit needs an escape or is above 0xff, or to
static i32 porf_simd_json_u16(u32 base, i32 i, i32 to) {
  const u8* s = MEM + base + 4u;
#ifdef __wasm_simd128__
  const v128_t space = wasm_i16x8_splat(0x20), quote = wasm_i16x8_splat(0x22), slash = wasm_i16x8_splat(0x5c), byte = wasm_i16x8_splat(0xff);
  for (; i + 8 <= to; i += 8) {
    const v128_t v = wasm_v128_load(s + i * 2);
    const v128_t bad = wasm_v128_or(wasm_v128_or(wasm_u16x8_lt(v, space), wasm_u16x8_gt(v, byte)),
      wasm_v128_or(wasm_i16x8_eq(v, quote), wasm_i16x8_eq(v, slash)));
    const u32 m = wasm_i16x8_bitmask(bad);
    if (m) return i + (i32)__builtin_ctz(m);
  }
#endif
  for (; i < to; i++) { const u16 c = *(const u16*)(s + i * 2); if (c < 0x20 || c == 0x22 || c == 0x5c || c > 0xff) return i; }
  return to;
}
// n bytes from source unit si to two-byte units from destination unit di
static void porf_simd_widen(u32 dst, i32 di, u32 src, i32 si, i32 n) {
  u8* d = MEM + dst + 4u + (u32)di * 2u;
  const u8* s = MEM + src + 4u + (u32)si;
  i32 k = 0;
#ifdef __wasm_simd128__
  for (; k + 16 <= n; k += 16) {
    const v128_t v = wasm_v128_load(s + k);
    wasm_v128_store(d + k * 2, wasm_u16x8_extend_low_u8x16(v));
    wasm_v128_store(d + k * 2 + 16, wasm_u16x8_extend_high_u8x16(v));
  }
#endif
  for (; k < n; k++) *(u16*)(d + k * 2) = s[k];
}
// n two-byte units, each below 0x100, from source unit si to bytes from destination unit di
static void porf_simd_narrow(u32 dst, i32 di, u32 src, i32 si, i32 n) {
  u8* d = MEM + dst + 4u + (u32)di;
  const u8* s = MEM + src + 4u + (u32)si * 2u;
  i32 k = 0;
#ifdef __wasm_simd128__
  for (; k + 16 <= n; k += 16)
    wasm_v128_store(d + k, wasm_u8x16_narrow_i16x8(wasm_v128_load(s + k * 2), wasm_v128_load(s + k * 2 + 16)));
#endif
  for (; k < n; k++) d[k] = (u8)*(const u16*)(s + k * 2);
}
// ASCII letters' case flipped (lo is 'a' to upper-case a..z, 'A' to lower-case A..Z), n units
// that are all ASCII: bytes to bytes, and one- or two-byte units to two-byte ones
static inline u32 porf_case_ascii(u32 c, u32 lo) { return c - lo < 26u ? c ^ 0x20u : c; }
static void porf_simd_case_u8(u32 dst, i32 di, u32 src, i32 si, i32 n, u32 lo) {
  u8* d = MEM + dst + 4u + (u32)di;
  const u8* s = MEM + src + 4u + (u32)si;
  i32 k = 0;
#ifdef __wasm_simd128__
  const v128_t low = wasm_i8x16_splat((int8_t)lo), bit = wasm_i8x16_splat(0x20), span = wasm_i8x16_splat(25);
  for (; k + 16 <= n; k += 16) {
    const v128_t v = wasm_v128_load(s + k);
    const v128_t letter = wasm_u8x16_le(wasm_i8x16_sub(v, low), span);
    wasm_v128_store(d + k, wasm_v128_xor(v, wasm_v128_and(letter, bit)));
  }
#endif
  for (; k < n; k++) d[k] = (u8)porf_case_ascii(s[k], lo);
}
static void porf_simd_case_u16(u32 dst, i32 di, u32 src, i32 si, i32 n, i32 swide, u32 lo) {
  u8* d = MEM + dst + 4u + (u32)di * 2u;
  const u8* s = MEM + src + 4u + (u32)si * (swide ? 2u : 1u);
  i32 k = 0;
#ifdef __wasm_simd128__
  if (swide) {
    const v128_t low = wasm_i16x8_splat((int16_t)lo), bit = wasm_i16x8_splat(0x20), span = wasm_i16x8_splat(25);
    for (; k + 8 <= n; k += 8) {
      const v128_t v = wasm_v128_load(s + k * 2);
      const v128_t letter = wasm_u16x8_le(wasm_i16x8_sub(v, low), span);
      wasm_v128_store(d + k * 2, wasm_v128_xor(v, wasm_v128_and(letter, bit)));
    }
  } else {
    const v128_t low = wasm_i8x16_splat((int8_t)lo), bit = wasm_i8x16_splat(0x20), span = wasm_i8x16_splat(25);
    for (; k + 16 <= n; k += 16) {
      v128_t v = wasm_v128_load(s + k);
      v = wasm_v128_xor(v, wasm_v128_and(wasm_u8x16_le(wasm_i8x16_sub(v, low), span), bit));
      wasm_v128_store(d + k * 2, wasm_u16x8_extend_low_u8x16(v));
      wasm_v128_store(d + k * 2 + 16, wasm_u16x8_extend_high_u8x16(v));
    }
  }
#endif
  for (; k < n; k++) *(u16*)(d + k * 2) = (u16)porf_case_ascii(swide ? *(const u16*)(s + k * 2) : s[k], lo);
}

// Base64 and hex for Uint8Array's toBase64/fromBase64/toHex/fromHex, atob and btoa. Sources
// and destinations are data pointers (units at MEM + p + 4); a string source has one- or
// two-byte units (two). With wasm SIMD, 12 bytes to 16 base64 chars (or back), and 16 bytes to
// 32 hex digits (or back), per step; the scalar loops finish the tails and are all a target
// without SIMD runs.
static const u8 porf_b64_std[65] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const u8 porf_b64_url[65] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static const u8 porf_hex_digits[17] = "0123456789abcdef";
static inline u32 porf_unit(const u8* s, i32 two, i32 k) { return two ? (u32)*(const u16*)(s + (u32)k * 2u) : (u32)s[k]; }

// base64 (url: the base64url alphabet; pad: '=' padding) of n bytes at src into dst: the chars
// written. SIMD swizzles each 3-byte group big-endian into a 32-bit lane, shifts it apart into
// four 6-bit indices, and adds each the offset to its letter, which a 16-entry table gives by
// the index's range (0 upper case, 26 lower case, 52 digits, 62, 63)
static i32 porf_b64_encode(u32 src, i32 n, u32 dst, i32 url, i32 pad) {
  const u8* s = MEM + src + 4u;
  u8* d = MEM + dst + 4u;
  const u8* abc = url ? porf_b64_url : porf_b64_std;
  i32 i = 0, j = 0;
#ifdef __wasm_simd128__
  const v128_t order = wasm_i8x16_make(2, 1, 0, -1, 5, 4, 3, -1, 8, 7, 6, -1, 11, 10, 9, -1);
  const v128_t offsets = url
    ? wasm_i8x16_make(71, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -17, 32, 65, 0, 0)
    : wasm_i8x16_make(71, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -19, -16, 65, 0, 0);
  const v128_t m0 = wasm_i32x4_splat(0x3f), m1 = wasm_i32x4_splat(0x3f00), m2 = wasm_i32x4_splat(0x3f0000), m3 = wasm_i32x4_splat(0x3f000000);
  const v128_t c51 = wasm_i8x16_splat(51), c26 = wasm_i8x16_splat(26), c13 = wasm_i8x16_splat(13);
  for (; i + 16 <= n; i += 12, j += 16) {
    const v128_t v = wasm_i8x16_swizzle(wasm_v128_load(s + i), order);
    const v128_t idx = wasm_v128_or(
      wasm_v128_or(wasm_v128_and(wasm_u32x4_shr(v, 18), m0), wasm_v128_and(wasm_u32x4_shr(v, 4), m1)),
      wasm_v128_or(wasm_v128_and(wasm_i32x4_shl(v, 10), m2), wasm_v128_and(wasm_i32x4_shl(v, 24), m3)));
    const v128_t range = wasm_v128_or(wasm_u8x16_sub_sat(idx, c51), wasm_v128_and(wasm_u8x16_lt(idx, c26), c13));
    wasm_v128_store(d + j, wasm_i8x16_add(idx, wasm_i8x16_swizzle(offsets, range)));
  }
#endif
  for (; i + 3 <= n; i += 3, j += 4) {
    const u32 v = (u32)s[i] << 16 | (u32)s[i + 1] << 8 | s[i + 2];
    d[j] = abc[v >> 18]; d[j + 1] = abc[v >> 12 & 63u]; d[j + 2] = abc[v >> 6 & 63u]; d[j + 3] = abc[v & 63u];
  }
  if (n - i == 1) {
    const u32 v = (u32)s[i] << 16;
    d[j++] = abc[v >> 18]; d[j++] = abc[v >> 12 & 63u];
    if (pad) { d[j++] = 61; d[j++] = 61; }
  } else if (n - i == 2) {
    const u32 v = (u32)s[i] << 16 | (u32)s[i + 1] << 8;
    d[j++] = abc[v >> 18]; d[j++] = abc[v >> 12 & 63u]; d[j++] = abc[v >> 6 & 63u];
    if (pad) d[j++] = 61;
  }
  return j;
}

static inline i32 porf_b64_value(u32 c, i32 url) {
  if (c - 65u < 26u) return (i32)c - 65;
  if (c - 97u < 26u) return (i32)c - 71;
  if (c - 48u < 10u) return (i32)c + 4;
  if (c == (url ? 45u : 43u)) return 62;
  if (c == (url ? 95u : 47u)) return 63;
  return -1;
}
static inline i32 porf_ascii_space(u32 c) { return c == 32 || c == 9 || c == 10 || c == 12 || c == 13; }

// the units read by the last porf_b64_decode
static i32 porf_b64_read;

// FromBase64 over len units at src, into at most max bytes at dst (lch, the lastChunkHandling:
// 0 loose, 1 strict, 2 stop-before-partial): the bytes written, or -1 - written for a
// SyntaxError; porf_b64_read gets the units read. Whole chunks of 16 alphabet chars with room
// for their 12 bytes decode by SIMD (range compares to 6-bit values, shifts packing four into
// three bytes a lane); whitespace, padding, a partial chunk and errors take the scalar path
static i32 porf_b64_decode(u32 src, i32 two, i32 len, i32 url, i32 lch, u32 dst, i32 max) {
  const u8* s = MEM + src + 4u;
  u8* d = MEM + dst + 4u;
  i32 i = 0, w = 0, n = 0, read = 0;
  u32 chunk = 0;
  porf_b64_read = 0;
  if (max == 0) return 0;
#ifdef __wasm_simd128__
  const v128_t cA = wasm_i8x16_splat(65), ca = wasm_i8x16_splat(97), c0 = wasm_i8x16_splat(48);
  const v128_t c71 = wasm_i8x16_splat(71), c4 = wasm_i8x16_splat(4), c26 = wasm_i8x16_splat(26), c10 = wasm_i8x16_splat(10);
  const v128_t plus = wasm_i8x16_splat(url ? 45 : 43), slash = wasm_i8x16_splat(url ? 95 : 47);
  const v128_t c62 = wasm_i8x16_splat(62), c63 = wasm_i8x16_splat(63);
  const v128_t m0 = wasm_i32x4_splat(0x3f), m1 = wasm_i32x4_splat(0x3f00), m2 = wasm_i32x4_splat(0x3f0000);
  const v128_t order = wasm_i8x16_make(2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, -1, -1, -1, -1);
#endif
  for (;;) {
#ifdef __wasm_simd128__
    if (n == 0) {
      const i32 from = i;
      for (; i + 16 <= len && max - w >= 12; i += 16, w += 12) {
        const v128_t v = two
          ? wasm_u8x16_narrow_i16x8(wasm_v128_load(s + i * 2), wasm_v128_load(s + i * 2 + 16))
          : wasm_v128_load(s + i);
        const v128_t up = wasm_u8x16_lt(wasm_i8x16_sub(v, cA), c26), lo = wasm_u8x16_lt(wasm_i8x16_sub(v, ca), c26);
        const v128_t dg = wasm_u8x16_lt(wasm_i8x16_sub(v, c0), c10);
        const v128_t pl = wasm_i8x16_eq(v, plus), sl = wasm_i8x16_eq(v, slash);
        if (!wasm_i8x16_all_true(wasm_v128_or(wasm_v128_or(up, lo), wasm_v128_or(dg, wasm_v128_or(pl, sl))))) break;
        const v128_t x = wasm_v128_or(
          wasm_v128_or(wasm_v128_and(up, wasm_i8x16_sub(v, cA)), wasm_v128_and(lo, wasm_i8x16_sub(v, c71))),
          wasm_v128_or(wasm_v128_and(dg, wasm_i8x16_add(v, c4)), wasm_v128_or(wasm_v128_and(pl, c62), wasm_v128_and(sl, c63))));
        const v128_t packed = wasm_v128_or(
          wasm_v128_or(wasm_i32x4_shl(wasm_v128_and(x, m0), 18), wasm_i32x4_shl(wasm_v128_and(x, m1), 4)),
          wasm_v128_or(wasm_u32x4_shr(wasm_v128_and(x, m2), 10), wasm_u32x4_shr(x, 24)));
        const v128_t bytes = wasm_i8x16_swizzle(packed, order);
        wasm_v128_store64_lane(d + w, bytes, 0);
        wasm_v128_store32_lane(d + w + 8, bytes, 2);
      }
      if (i != from) {
        read = i;
        if (w == max) { porf_b64_read = read; return w; }
      }
    }
#endif
    while (i < len && porf_ascii_space(porf_unit(s, two, i))) i++;
    if (i == len) {
      if (n > 0) {
        if (lch == 2) { porf_b64_read = read; return w; }
        if (lch == 1 || n == 1) goto fail;
        chunk <<= (u32)(4 - n) * 6u;
        d[w++] = (u8)(chunk >> 16);
        if (n == 3) d[w++] = (u8)(chunk >> 8);
      }
      porf_b64_read = len;
      return w;
    }
    const u32 c = porf_unit(s, two, i++);
    if (c == 61) {
      if (n < 2) goto fail;
      while (i < len && porf_ascii_space(porf_unit(s, two, i))) i++;
      if (n == 2) {
        if (i == len) {
          if (lch == 2) { porf_b64_read = read; return w; }
          goto fail;
        }
        if (porf_unit(s, two, i) == 61) {
          i++;
          while (i < len && porf_ascii_space(porf_unit(s, two, i))) i++;
        }
      }
      if (i < len) goto fail;
      chunk <<= (u32)(4 - n) * 6u;
      if (lch == 1 && (chunk & (n == 2 ? 0xffffu : 0xffu)) != 0) goto fail;
      d[w++] = (u8)(chunk >> 16);
      if (n == 3) d[w++] = (u8)(chunk >> 8);
      porf_b64_read = len;
      return w;
    }
    const i32 v = porf_b64_value(c, url);
    if (v < 0) goto fail;
    const i32 remaining = max - w;
    if ((remaining == 1 && n == 2) || (remaining == 2 && n == 3)) { porf_b64_read = read; return w; }
    chunk = chunk << 6 | (u32)v;
    if (++n == 4) {
      d[w++] = (u8)(chunk >> 16); d[w++] = (u8)(chunk >> 8); d[w++] = (u8)chunk;
      chunk = 0; n = 0; read = i;
      if (w == max) { porf_b64_read = read; return w; }
    }
  }
fail:
  porf_b64_read = read;
  return -1 - w;
}

// the hex digits of n bytes at src into dst. SIMD swizzles each nibble to its digit and
// interleaves the high and low digits
static void porf_hex_encode(u32 src, i32 n, u32 dst) {
  const u8* s = MEM + src + 4u;
  u8* d = MEM + dst + 4u;
  i32 i = 0;
#ifdef __wasm_simd128__
  const v128_t digits = wasm_i8x16_make(48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102);
  const v128_t low = wasm_i8x16_splat(15);
  for (; i + 16 <= n; i += 16) {
    const v128_t v = wasm_v128_load(s + i);
    const v128_t hi = wasm_i8x16_swizzle(digits, wasm_u8x16_shr(v, 4)), lo = wasm_i8x16_swizzle(digits, wasm_v128_and(v, low));
    wasm_v128_store(d + i * 2, wasm_i8x16_shuffle(hi, lo, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23));
    wasm_v128_store(d + i * 2 + 16, wasm_i8x16_shuffle(hi, lo, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31));
  }
#endif
  for (; i < n; i++) { d[i * 2] = porf_hex_digits[s[i] >> 4]; d[i * 2 + 1] = porf_hex_digits[s[i] & 15u]; }
}

static inline i32 porf_hex_value(u32 c) {
  if (c - 48u < 10u) return (i32)c - 48;
  c |= 32u;
  return c - 97u < 6u ? (i32)c - 87 : -1;
}

// n bytes from the hex digit pairs at src into dst, stopping at the first pair that is not two
// hex digits: the bytes written. SIMD splits 32 digits into high and low, range-checks both and
// packs them; a two-byte unit above 0xff narrows to 0 or 0xff, neither a digit
static i32 porf_hex_decode(u32 src, i32 two, i32 n, u32 dst) {
  const u8* s = MEM + src + 4u;
  u8* d = MEM + dst + 4u;
  i32 i = 0;
#ifdef __wasm_simd128__
  const v128_t c0 = wasm_i8x16_splat(48), ca = wasm_i8x16_splat(97), c32 = wasm_i8x16_splat(32);
  const v128_t c10 = wasm_i8x16_splat(10), c6 = wasm_i8x16_splat(6);
  for (; i + 16 <= n; i += 16) {
    v128_t a, b;
    if (two) {
      const u8* p = s + i * 4;
      a = wasm_u8x16_narrow_i16x8(wasm_v128_load(p), wasm_v128_load(p + 16));
      b = wasm_u8x16_narrow_i16x8(wasm_v128_load(p + 32), wasm_v128_load(p + 48));
    } else {
      a = wasm_v128_load(s + i * 2);
      b = wasm_v128_load(s + i * 2 + 16);
    }
    const v128_t hi = wasm_i8x16_shuffle(a, b, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
    const v128_t lo = wasm_i8x16_shuffle(a, b, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
    const v128_t hd = wasm_i8x16_sub(hi, c0), ld = wasm_i8x16_sub(lo, c0);
    const v128_t hl = wasm_i8x16_sub(wasm_v128_or(hi, c32), ca), ll = wasm_i8x16_sub(wasm_v128_or(lo, c32), ca);
    const v128_t hdig = wasm_u8x16_lt(hd, c10), ldig = wasm_u8x16_lt(ld, c10);
    const v128_t ok = wasm_v128_and(wasm_v128_or(hdig, wasm_u8x16_lt(hl, c6)), wasm_v128_or(ldig, wasm_u8x16_lt(ll, c6)));
    if (!wasm_i8x16_all_true(ok)) break;
    const v128_t hv = wasm_v128_bitselect(hd, wasm_i8x16_add(hl, c10), hdig), lv = wasm_v128_bitselect(ld, wasm_i8x16_add(ll, c10), ldig);
    wasm_v128_store(d + i, wasm_v128_or(wasm_i8x16_shl(hv, 4), lv));
  }
#endif
  for (; i < n; i++) {
    const i32 h = porf_hex_value(porf_unit(s, two, i * 2)), l = porf_hex_value(porf_unit(s, two, i * 2 + 1));
    if ((h | l) < 0) break;
    d[i] = (u8)(h << 4 | l);
  }
  return i;
}

// String comparison and search over one- or two-byte units (wa, wb: two-byte), for ===, <,
// sort and the String.prototype searches. Strings are data pointers (units at MEM + p + 4)
// with unit offsets; SIMD compares 16 one-byte or 8 two-byte units a step, a one-byte side
// widened when the widths differ.

// the first k below n where unit ai + k of a differs from unit bi + k of b, or n
static i32 porf_str_mismatch(u32 a, i32 wa, i32 ai, u32 b, i32 wb, i32 bi, i32 n) {
  const u8* p = MEM + a + 4u + (u32)ai * (wa ? 2u : 1u);
  const u8* q = MEM + b + 4u + (u32)bi * (wb ? 2u : 1u);
  i32 k = 0;
#ifdef __wasm_simd128__
  if (!wa && !wb) {
    for (; k + 16 <= n; k += 16) {
      const u32 m = wasm_i8x16_bitmask(wasm_i8x16_ne(wasm_v128_load(p + k), wasm_v128_load(q + k)));
      if (m) return k + (i32)__builtin_ctz(m);
    }
  } else if (wa && wb) {
    for (; k + 8 <= n; k += 8) {
      const u32 m = wasm_i16x8_bitmask(wasm_i16x8_ne(wasm_v128_load(p + k * 2), wasm_v128_load(q + k * 2)));
      if (m) return k + (i32)__builtin_ctz(m);
    }
  } else {
    const u8* one = wa ? q : p;
    const u8* two = wa ? p : q;
    for (; k + 8 <= n; k += 8) {
      const u32 m = wasm_i16x8_bitmask(wasm_i16x8_ne(wasm_u16x8_load8x8(one + k), wasm_v128_load(two + k * 2)));
      if (m) return k + (i32)__builtin_ctz(m);
    }
  }
#endif
  if (!wa && !wb) {
    for (; k < n; k++) if (p[k] != q[k]) return k;
    return n;
  }
  for (; k < n; k++) if (porf_unit(p, wa, k) != porf_unit(q, wb, k)) return k;
  return n;
}

// whether the needle's n units match the haystack's from at, given its first and last match
static inline i32 porf_str_middle(u32 hay, i32 wh, i32 at, u32 ndl, i32 wn, i32 n) {
  return n <= 2 || porf_str_mismatch(hay, wh, at + 1, ndl, wn, 1, n - 2) == n - 2;
}

// the first index in [at, len - n] where the needle (n units) occurs in the haystack (len
// units), or -1. SIMD finds where both the needle's first and last units line up, and compares
// the middle only there
static i32 porf_str_find(u32 hay, i32 wh, i32 len, u32 ndl, i32 wn, i32 n, i32 at) {
  if (at < 0) at = 0;
  const i32 last = len - n;
  if (at > last) return -1;
  if (n == 0) return at;
  const u8* h = MEM + hay + 4u;
  const u32 f = porf_unit(MEM + ndl + 4u, wn, 0), l = porf_unit(MEM + ndl + 4u, wn, n - 1);
  if (!wh && (f > 0xffu || l > 0xffu)) return -1;
#ifdef __wasm_simd128__
  if (!wh) {
    const v128_t vf = wasm_i8x16_splat((int8_t)f), vl = wasm_i8x16_splat((int8_t)l);
    for (; at + 16 <= last + 1; at += 16) {
      u32 m = wasm_i8x16_bitmask(wasm_v128_and(wasm_i8x16_eq(wasm_v128_load(h + at), vf), wasm_i8x16_eq(wasm_v128_load(h + at + n - 1), vl)));
      for (; m; m &= m - 1) {
        const i32 k = at + (i32)__builtin_ctz(m);
        if (porf_str_middle(hay, wh, k, ndl, wn, n)) return k;
      }
    }
  } else {
    const v128_t vf = wasm_i16x8_splat((int16_t)f), vl = wasm_i16x8_splat((int16_t)l);
    for (; at + 8 <= last + 1; at += 8) {
      u32 m = wasm_i16x8_bitmask(wasm_v128_and(wasm_i16x8_eq(wasm_v128_load(h + at * 2), vf), wasm_i16x8_eq(wasm_v128_load(h + (at + n - 1) * 2), vl)));
      for (; m; m &= m - 1) {
        const i32 k = at + (i32)__builtin_ctz(m);
        if (porf_str_middle(hay, wh, k, ndl, wn, n)) return k;
      }
    }
  }
#endif
  for (; at <= last; at++)
    if (porf_unit(h, wh, at) == f && porf_unit(h, wh, at + n - 1) == l && porf_str_middle(hay, wh, at, ndl, wn, n)) return at;
  return -1;
}

// the last index in [0, at] (at clamped to len - n) where the needle occurs, or -1
static i32 porf_str_rfind(u32 hay, i32 wh, i32 len, u32 ndl, i32 wn, i32 n, i32 at) {
  if (at > len - n) at = len - n;
  if (at < 0) return -1;
  if (n == 0) return at;
  const u8* h = MEM + hay + 4u;
  const u32 f = porf_unit(MEM + ndl + 4u, wn, 0), l = porf_unit(MEM + ndl + 4u, wn, n - 1);
  if (!wh && (f > 0xffu || l > 0xffu)) return -1;
#ifdef __wasm_simd128__
  if (!wh) {
    const v128_t vf = wasm_i8x16_splat((int8_t)f), vl = wasm_i8x16_splat((int8_t)l);
    for (; at >= 15; at -= 16) {
      const i32 from = at - 15;
      u32 m = wasm_i8x16_bitmask(wasm_v128_and(wasm_i8x16_eq(wasm_v128_load(h + from), vf), wasm_i8x16_eq(wasm_v128_load(h + from + n - 1), vl)));
      while (m) {
        const i32 bit = 31 - (i32)__builtin_clz(m);
        if (porf_str_middle(hay, wh, from + bit, ndl, wn, n)) return from + bit;
        m &= ~(1u << bit);
      }
    }
  } else {
    const v128_t vf = wasm_i16x8_splat((int16_t)f), vl = wasm_i16x8_splat((int16_t)l);
    for (; at >= 7; at -= 8) {
      const i32 from = at - 7;
      u32 m = wasm_i16x8_bitmask(wasm_v128_and(wasm_i16x8_eq(wasm_v128_load(h + from * 2), vf), wasm_i16x8_eq(wasm_v128_load(h + (from + n - 1) * 2), vl)));
      while (m) {
        const i32 bit = 31 - (i32)__builtin_clz(m);
        if (porf_str_middle(hay, wh, from + bit, ndl, wn, n)) return from + bit;
        m &= ~(1u << bit);
      }
    }
  }
#endif
  for (; at >= 0; at--)
    if (porf_unit(h, wh, at) == f && porf_unit(h, wh, at + n - 1) == l && porf_str_middle(hay, wh, at, ndl, wn, n)) return at;
  return -1;
}

// -1, 0 or 1 as a sorts before, with or after b by UTF-16 code units (IsLessThan's order)
static i32 porf_str_order(u32 a, i32 wa, u32 b, i32 wb) {
  const i32 la = (i32)*(u32*)(MEM + a), lb = (i32)*(u32*)(MEM + b);
  const i32 n = la < lb ? la : lb;
  const i32 k = porf_str_mismatch(a, wa, 0, b, wb, 0, n);
  if (k < n) return porf_unit(MEM + a + 4u, wa, k) < porf_unit(MEM + b + 4u, wb, k) ? -1 : 1;
  return la < lb ? -1 : la > lb ? 1 : 0;
}

static inline i32 porf_clz32(u32 x) { return x ? __builtin_clz(x) : 32; }
static inline i32 porf_ctz32(u32 x) { return x ? __builtin_ctz(x) : 32; }
static inline u32 porf_rotl32(u32 x, u32 k) { k &= 31u; return (x << k) | (x >> ((0u - k) & 31u)); }
static inline u32 porf_rotr32(u32 x, u32 k) { k &= 31u; return (x >> k) | (x << ((0u - k) & 31u)); }
static inline u64 porf_rotl64(u64 x, u64 k) { k &= 63ull; return (x << k) | (x >> ((0ull - k) & 63ull)); }
static inline u64 porf_rotr64(u64 x, u64 k) { k &= 63ull; return (x >> k) | (x << ((0ull - k) & 63ull)); }
static inline f64 porf_nearest(f64 d) { f64 r = round(d); if (fabs(d - trunc(d)) == 0.5 && ((i64)r & 1)) r -= d < 0 ? -1.0 : 1.0; return r; }
static inline f64 porf_f64_min(f64 a, f64 b) { return a != a ? a : b != b ? b : a < b ? a : b; }
static inline f64 porf_f64_max(f64 a, f64 b) { return a != a ? a : b != b ? b : a > b ? a : b; }

static struct timespec porf_performance_start;
static f64 porf_performance_time_origin_value = 0.0;
static int porf_performance_started = 0;

static inline void porf_performance_init(void) {
  if (!porf_performance_started) {
    struct timespec real;
    clock_gettime(CLOCK_REALTIME, &real);
    clock_gettime(CLOCK_MONOTONIC, &porf_performance_start);
    porf_performance_time_origin_value = (f64)real.tv_sec * 1000.0 + (f64)real.tv_nsec / 1.0e6;
    porf_performance_started = 1;
  }
}

${sti}f64 porf_performance_now(void) {
  porf_performance_init();

  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);

  i64 sec = (i64)now.tv_sec - (i64)porf_performance_start.tv_sec;
  i64 nsec = (i64)now.tv_nsec - (i64)porf_performance_start.tv_nsec;
  if (nsec < 0) {
    sec--;
    nsec += 1000000000ll;
  }
  return (f64)sec * 1000.0 + (f64)nsec / 1.0e6;
}

${sti}f64 porf_performance_time_origin(void) {
  porf_performance_init();
  return porf_performance_time_origin_value;
}

// Random bytes from the platform's CSPRNG: getentropy (on WASI, wasi:random/random's
// get-random-bytes). crypto.getRandomValues and randomUUID fill from it, and it seeds
// Math.random's generator.
${sti}void porf_random_fill(u8* p, u32 n) {
  while (n > 0) {
    const u32 k = n < 256u ? n : 256u;  // getentropy's limit per call
    if (getentropy(p, k) != 0) {
      fputs("porffor: no random bytes from the platform (getentropy)\\n", stderr);
      abort();
    }
    p += k;
    n -= k;
  }
}

${sti}u64 porf_random_u64(void) {
  u64 v;
  porf_random_fill((u8*)&v, 8u);
  return v;
}

// ---- String.prototype.toUpperCase / toLowerCase: full Unicode case mapping ----
// Tables from compiler/gen_case_tables.js (Node's ICU data). The linker drops them from
// programs that never convert case.
${caseTablesC}

// the delta for cp in a table of runs, or 0
static i32 porf_case_delta(const porf_case_run* runs, i32 n, u32 cp) {
  i32 lo = 0, hi = n - 1, at = -1;
  while (lo <= hi) {
    const i32 mid = (lo + hi) >> 1;
    if (runs[mid].start <= cp) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (at < 0) return 0;
  const porf_case_run r = runs[at];
  const u32 off = cp - r.start;
  if (off % r.stride != 0 || off / r.stride >= r.count) return 0;
  return r.delta;
}

// the mapping of cp to several code points, or NULL
static const u32* porf_case_special(const u32 (*table)[4], i32 n, u32 cp) {
  i32 lo = 0, hi = n - 1;
  while (lo <= hi) {
    const i32 mid = (lo + hi) >> 1;
    if (table[mid][0] == cp) return table[mid] + 1;
    if (table[mid][0] < cp) lo = mid + 1; else hi = mid - 1;
  }
  return NULL;
}

static int porf_case_in(const u32 (*ranges)[2], i32 n, u32 cp) {
  i32 lo = 0, hi = n - 1;
  while (lo <= hi) {
    const i32 mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return 1;
  }
  return 0;
}
#define PORF_CASE_N(t) ((i32)(sizeof(t) / sizeof((t)[0])))

// the code point at unit i of a string (u16 units, or u8 for a bytestring); *w: its units
static u32 porf_case_cp(u32 chars, i32 wide, u32 len, u32 i, u32* w) {
  *w = 1;
  if (!wide) return *(u8*)(MEM + chars + i);
  const u32 u = *(u16*)(MEM + chars + i * 2);
  if (u >= 0xd800 && u <= 0xdbff && i + 1 < len) {
    const u32 v = *(u16*)(MEM + chars + i * 2 + 2);
    if (v >= 0xdc00 && v <= 0xdfff) { *w = 2; return 0x10000 + ((u - 0xd800) << 10) + (v - 0xdc00); }
  }
  return u;
}

// Final_Sigma: Σ at unit i lowercases to ς when a cased letter comes before it (past any
// case-ignorable ones) and none comes after it (likewise)
static int porf_case_final_sigma(u32 chars, i32 wide, u32 len, u32 i) {
  int before = 0;
  for (u32 j = i; j > 0;) {
    j--;
    if (wide && j > 0) {
      const u32 u = *(u16*)(MEM + chars + j * 2);
      if (u >= 0xdc00 && u <= 0xdfff) {
        const u32 h = *(u16*)(MEM + chars + j * 2 - 2);
        if (h >= 0xd800 && h <= 0xdbff) j--;
      }
    }
    u32 w;
    const u32 cp = porf_case_cp(chars, wide, len, j, &w);
    if (porf_case_in(porf_case_ignorable_ranges, PORF_CASE_N(porf_case_ignorable_ranges), cp)) continue;
    before = porf_case_in(porf_cased_ranges, PORF_CASE_N(porf_cased_ranges), cp);
    break;
  }
  if (!before) return 0;
  for (u32 j = i + 1; j < len;) {
    u32 w;
    const u32 cp = porf_case_cp(chars, wide, len, j, &w);
    j += w;
    if (porf_case_in(porf_case_ignorable_ranges, PORF_CASE_N(porf_case_ignorable_ranges), cp)) continue;
    return !porf_case_in(porf_cased_ranges, PORF_CASE_N(porf_cased_ranges), cp);
  }
  return 1;
}

${sti}u32 porf_alloc(u32 bytes, u32 typeId);

// s (a string or bytestring) in upper or lower case. An ASCII bytestring stays a
// bytestring; anything else becomes a string (a Latin-1 letter's case can leave Latin-1).
${ropes ? `static inline __attribute__((always_inline)) jsval porf_str_flat(jsval v);
` : ''}static jsval porf_case_convert(jsval s, i32 upper) {
${ropes ? `  s = porf_str_flat(s);
` : ''}  const i32 wide = porf_jv_type(s) == ${TYPES.string};
  const u32 src = (u32)s.val;
  const u32 len = *(u32*)(MEM + src);
  const u32 chars = src + 4;

  // ASCII has no special mappings: a one-byte string all of ASCII is converted by a SIMD flip
  const u32 lo = upper ? 'a' : 'A';
  if (!wide && porf_simd_ascii_u8(src, 0, (i32)len) == (i32)len) {
    const u32 dst = porf_alloc(4 + len, ${TYPES.bytestring});
    *(u32*)(MEM + dst) = len;
    porf_simd_case_u8(dst, 0, src, 0, (i32)len, lo);
    return porf_box((f64)dst, ${TYPES.bytestring});
  }

  // at most 3 units out per unit in (the longest special mapping: 3 BMP code points)
  const u32 dst = porf_alloc(4 + len * 6, ${TYPES.string});
  u32 n = 0;
  for (u32 i = 0; i < len;) {
    // an ASCII run: flipped (and widened) in one go
    if ((wide ? *(u16*)(MEM + chars + i * 2) : *(u8*)(MEM + chars + i)) < 0x80) {
      const u32 run = (u32)(wide ? porf_simd_ascii_u16(src, (i32)i, (i32)len) : porf_simd_ascii_u8(src, (i32)i, (i32)len)) - i;
      porf_simd_case_u16(dst, (i32)n, src, (i32)i, (i32)run, wide, lo);
      n += run;
      i += run;
      continue;
    }
    u32 w;
    const u32 cp = porf_case_cp(chars, wide, len, i, &w);
    u32 outs[3] = { cp, 0, 0 };
    u32 count = 1;
    const u32* special = upper
      ? porf_case_special(porf_upper_special, PORF_CASE_N(porf_upper_special), cp)
      : porf_case_special(porf_lower_special, PORF_CASE_N(porf_lower_special), cp);
    if (special) {
      count = special[2] ? 3 : special[1] ? 2 : 1;
      outs[0] = special[0]; outs[1] = special[1]; outs[2] = special[2];
    } else if (!upper && cp == 0x3a3) {
      outs[0] = porf_case_final_sigma(chars, wide, len, i) ? 0x3c2 : 0x3c3;
    } else {
      outs[0] = (u32)((i32)cp + (upper
        ? porf_case_delta(porf_upper_runs, PORF_CASE_N(porf_upper_runs), cp)
        : porf_case_delta(porf_lower_runs, PORF_CASE_N(porf_lower_runs), cp)));
    }
    for (u32 k = 0; k < count; k++) {
      const u32 o = outs[k];
      if (o >= 0x10000) {
        *(u16*)(MEM + dst + 4 + n * 2) = (u16)(0xd800 + ((o - 0x10000) >> 10));
        *(u16*)(MEM + dst + 4 + n * 2 + 2) = (u16)(0xdc00 + ((o - 0x10000) & 0x3ff));
        n += 2;
      } else {
        *(u16*)(MEM + dst + 4 + n * 2) = (u16)o;
        n++;
      }
    }
    i += w;
  }
  *(u32*)(MEM + dst) = n;
  return porf_box((f64)dst, ${TYPES.string});
}

// unaligned access (DataView, object entry values): memcpy folds to plain loads on x86/arm
// tcc: plain derefs instead - it emits real memcpy calls, and it never optimizes on alignment UB
#ifdef __TINYC__
#define porf_load_un_u16(p) (*(const u16*)(p))
#define porf_load_un_u32(p) (*(const u32*)(p))
#define porf_load_un_u64(p) (*(const u64*)(p))
#define porf_load_un_f32(p) (*(const f32*)(p))
#define porf_load_un_f64(p) (*(const f64*)(p))
#define porf_store_un_u16(p, v) (*(u16*)(p) = (v))
#define porf_store_un_u32(p, v) (*(u32*)(p) = (v))
#define porf_store_un_u64(p, v) (*(u64*)(p) = (v))
#define porf_store_un_f32(p, v) (*(f32*)(p) = (v))
#define porf_store_un_f64(p, v) (*(f64*)(p) = (v))
#else
#define PORF_UN(ctype) \\
  static inline ctype porf_load_un_##ctype(const u8* p) { ctype v; memcpy(&v, p, sizeof v); return v; } \\
  static inline void porf_store_un_##ctype(u8* p, ctype v) { memcpy(p, &v, sizeof v); }
PORF_UN(u16) PORF_UN(u32) PORF_UN(u64) PORF_UN(f32) PORF_UN(f64)
#endif

// exceptions: setjmp-based, exception is a jsval
${st}jmp_buf* porf_try_data;
${st}i32 porf_try_cap = 0;
${st}i32 porf_try_depth = 0;
${st}jsval porf_exception = {0.0, ${TYPES.undefined}};

${sti}jmp_buf* porf_try_ensure(void) {
  if (porf_try_depth > porf_try_cap) {
    while (porf_try_depth > porf_try_cap) porf_try_cap = porf_try_cap ? porf_try_cap << 1 : 8;
    porf_try_data = (jmp_buf*)realloc(porf_try_data, (size_t)porf_try_cap * sizeof(jmp_buf));
    if (!porf_try_data) abort();
  }
  return porf_try_data;
}

${toStr ? `jsval ${toStr}(jsval);
` : ''}${toNum ? `jsval ${toNum}(jsval);
` : ''}${toPrimDefault ? `jsval ${toPrimDefault}(jsval);
` : ''}${toPrimNumber ? `jsval ${toPrimNumber}(jsval);
` : ''}${arrHole ? `jsval ${arrHole}(jsval, jsval);
` : ''}\
PORF_NORETURN ${st}void porf_throw(jsval v) {
  porf_exception = v;
#ifdef PORF_TRACE_THROW
  // debugging: every throw, caught or not, with an Error's message
  {
    const i32 t = porf_jv_type(v);
    const char* text = "";
    i32 len = 0;
    if (t >= ${TYPES.error} && t <= ${TYPES.suppressederror} && (u32)v.val) {
      const jsval m = porf_unpack(*(jsbits*)(MEM + (u32)v.val));
      if (porf_jv_type(m) == ${TYPES.bytestring} && (u32)m.val) { len = (i32)*(u32*)(MEM + (u32)m.val); text = (const char*)(MEM + (u32)m.val + 4); }
    }
    fprintf(stderr, "porffor: throw (type %d, try depth %d) %.*s\\n", t, porf_try_depth, len, text);
  }
#endif
  if (porf_try_depth > 0) _longjmp(porf_try_data[porf_try_depth - 1], 1);
${toStr ? `
  static i32 _uncaught_busy = 0;
  if (!_uncaught_busy) {
    _uncaught_busy = 1;
    const jsval _s = ${toStr}(v);
    const i32 _st = porf_jv_type(_s);
    const u32 _sp = (u32)_s.val;
    if (_st == ${TYPES.bytestring} && _sp) { porf_err("Uncaught "); fwrite(MEM + _sp + 4, 1, *(u32*)(MEM + _sp), stderr); porf_err("\\n"); exit(1); }
    if (_st == ${TYPES.string} && _sp) {
      const u32 _sl = *(u32*)(MEM + _sp);
      porf_err("Uncaught ");
      for (u32 _i = 0; _i < _sl; _i++) { const u16 _c = porf_load_un_u16(MEM + _sp + 4 + _i * 2); fputc(_c < 128 ? (int)_c : '?', stderr); }
      fputc('\\n', stderr);
      exit(1);
    }
  }
` : ''}\
  porf_err("Uncaught exception\\n");
  exit(1);
}

// internal throws construct a standard error (message jsval at +0, like the error
// builtins) so a caught internal error behaves identically to a \`new X(msg)\` one
${sti}u32 porf_alloc(u32 bytes, u32 typeId);
PORF_NORETURN ${st}void porf_throw_new(i32 errType, u32 msgId) {
#ifdef PORF_TRAP_INTERNAL_THROW
  // debugging: stop at the Nth of the runtime's own throws (a null property read, a bad
  // call), caught or not, so the host shows where (a backtrace); PORF_TRACE_THROW lists them
  { static u32 _seen = 0; if (++_seen == (u32)(PORF_TRAP_INTERNAL_THROW)) __builtin_trap(); }
#endif
  const u32 p = porf_alloc(8, (u32)errType);
  *(jsbits*)(MEM + p) = JV_PATTERN | ((u64)${TYPES.bytestring} << 43) | msgId;
  porf_throw(porf_box((f64)p, errType));
}

// TypeError for calling something that is not a function, naming what it was
// ("undefined is not a function"): the dynamic call site has no source text for it
PORF_NORETURN ${st}void porf_throw_not_callable(jsval fn) {
#ifdef PORF_TRAP_NOT_CALLABLE
  // debugging: stop here, so the host shows where (a backtrace), instead of throwing
  __builtin_trap();
#endif
  const i32 t = porf_jv_type(fn);
  const char* what = t == ${TYPES.undefined} ? "undefined"
    : t == ${TYPES.object} && (u32)fn.val == 0 ? "null"
    : t == ${TYPES.number} ? "a number"
    : t == ${TYPES.boolean} ? "a boolean"
    : t == ${TYPES.bytestring} || t == ${TYPES.string} ? "a string"
    : t == ${TYPES.symbol} ? "a symbol"
    : t == ${TYPES.bigint} ? "a bigint"
    : "an object";
  char text[48];
  const int w = (int)strlen(what);
  memcpy(text, what, (size_t)w);
  memcpy(text + w, " is not a function", 18);
  const int n = w + 18;
  const u32 s = porf_alloc(4 + (u32)n, ${TYPES.bytestring});
  *(u32*)(MEM + s) = (u32)n;
  memcpy(MEM + s + 4, text, (size_t)n);
  porf_throw_new(${TYPES.typeerror}, s);
}

PORF_NORETURN ${st}void porf_unreachable(const char* msg) {
  porf_err("porffor: unreachable");
  if (msg) { porf_err(": "); porf_err(msg); }
  porf_err("\\n");
  abort();
}

${prefs.gc === false ? PORF_BUMP_ALLOC() : PORF_GC_ALLOC(prefs)}

// ---- core layouts ----
// array:      [len i32 @0][ent u32 @4][cap i32 @8]; entries = jsval[cap]
// object:     [count i32 @0][bcap i32 @4][ent u32 @8][buckets u32 @12]
//             entries = {key jsval, val jsval}[count] in insertion order
//             buckets = i32[bcap] entry indices, -1 empty (ordered hashmap)
// bytestring: [len u32 @0][bytes @4]
// function:   [fnIdx u32 @0][env u32 @4]; env = jsval slots
// array header padded to 16 so inline entries stay 8-aligned
#define PORF_ARR_LEN(a) (*(i32*)(MEM + (a)))
#define PORF_ARR_ENT(a) (*(u32*)(MEM + (a) + 4))
#define PORF_ARR_CAP(a) (*(i32*)(MEM + (a) + 8))
// the header's last word: PORF_ARR_ARGUMENTS marks a function's arguments object (an array
// underneath, with Object.prototype and no Array identity); 0 for any other array
#define PORF_ARR_KIND(a) (*(u32*)(MEM + (a) + 12))
#define PORF_ARR_ARGUMENTS 0x41524753u

// an array literal's storage: exactly cap slots, zeroed, no elements yet (K.ArrAlloc)
${st}u32 porf_arr_alloc(i32 cap) {
  const u32 a = porf_alloc(16 + ((u32)cap << 3), ${TYPES.array});
  PORF_ARR_LEN(a) = 0; PORF_ARR_ENT(a) = a + 16; PORF_ARR_CAP(a) = cap;
  memset(MEM + a + 12, 0, 4 + ((size_t)cap << 3)); // (PORF_ARR_KIND and the entries)
  return a;
}

// a closure env, [parent u32][count u32] then count slots of [payload f64, type u8, pad x7],
// every slot undefined (K.EnvAlloc)
${st}u32 porf_env_alloc(u32 parent, i32 count) {
  const u32 e = porf_alloc(8 + ((u32)count << 4), ${TYPES.__porffor_closureenv});
  *(u32*)(MEM + e) = parent;
  *(u32*)(MEM + e + 4) = (u32)count;
  for (i32 i = 0; i < count; i++) {
    *(f64*)(MEM + e + 8 + (i << 4)) = 0.0;
    *(u8*)(MEM + e + 16 + (i << 4)) = ${TYPES.undefined};
  }
  return e;
}

// a fresh copy of a constant literal's template (K.Clone): the object's entries or the
// array's storage repointed into the copy, and each nested template (an object or array
// value) copied in turn
${st}u32 porf_tmpl_clone(u32 t, i32 type) {
  if (type == ${TYPES.array}) {
    const i32 len = PORF_ARR_LEN(t);
    const u32 bytes = 16 + ((u32)PORF_ARR_CAP(t) << 3);
    const u32 a = porf_alloc(bytes, ${TYPES.array});
    memcpy(MEM + a, MEM + t, bytes);
    PORF_ARR_ENT(a) = a + 16;
    int nested = 0;
    for (i32 i = 0; i < len; i++) {
      jsbits* slot = (jsbits*)(MEM + a + 16 + ((u32)i << 3));
      const jsval v = porf_unpack(*slot);
      if ((v.type == ${TYPES.object} || v.type == ${TYPES.array}) && v.val != 0) {
        *slot = porf_pack(porf_box((f64)porf_tmpl_clone((u32)v.val, v.type), v.type));
        nested = 1;
      }
    }
    if (nested) porf_gc_barrier(a, ${TYPES.array});
    return a;
  }
  const u32 count = *(u16*)(MEM + t);
  const u32 bytes = 16 + (u32)*(u16*)(MEM + t + 2) * 20;
  const u32 o = porf_alloc(bytes, ${TYPES.object});
  memcpy(MEM + o, MEM + t, bytes);
  *(u32*)(MEM + o + 12) = o + 16;
  int nested = 0;
  for (u32 i = 0; i < count; i++) {
    const u32 e = o + 16 + i * 20;
    const u8 vt = *(u8*)(MEM + e + 17);
    f64 payload;
    memcpy(&payload, MEM + e + 8, 8);
    if ((vt == ${TYPES.object} || vt == ${TYPES.array}) && payload != 0) {
      payload = (f64)porf_tmpl_clone((u32)payload, vt);
      memcpy(MEM + e + 8, &payload, 8);
      nested = 1;
    }
  }
  if (nested) porf_gc_barrier(o, ${TYPES.object});
  return o;
}

// a function value's record: [func link index u32][env u32] (K.FnAlloc)
${st}u32 porf_fn_alloc(u32 idx, u32 env) {
  const u32 r = porf_alloc(8, ${TYPES.function});
  *(u32*)(MEM + r) = idx;
  *(u32*)(MEM + r + 4) = env;
  return r;
}

${st}u32 porf_arr_new(i32 len, i32 cap) {
  if (cap < len) cap = len;
  if (cap < 4) cap = 4;
  const u32 a = porf_alloc(16 + ((u32)cap << 3), ${TYPES.array});
  PORF_ARR_LEN(a) = len; PORF_ARR_ENT(a) = a + 16; PORF_ARR_CAP(a) = cap;
  memset(MEM + a + 12, 0, 4 + ((size_t)cap << 3)); // (PORF_ARR_KIND and the entries)
  return a;
}

// (a length set past the capacity, a.length = 100, leaves the entries beyond it unallocated:
// they read as holes)
${sti}int porf_arr_has_own(u32 a, u32 i) {
  if (i >= (u32)PORF_ARR_LEN(a) || i >= (u32)PORF_ARR_CAP(a)) return 0;
  return *(jsbits*)(MEM + PORF_ARR_ENT(a) + ((u64)i << 3)) != 0;
}

${arrHole ? `// a hole or an index past the end: what the spec's Get finds (out of line: rare)
PORF_NOINLINE ${st}jsval porf_arr_hole(u32 a, u32 i) {
  return ${arrHole}(porf_box((f64)a, ${TYPES.array}), porf_box_num((f64)i));
}
` : ''}\
${sti}jsval porf_arr_get(u32 a, u32 i) {
  if (i >= (u32)PORF_ARR_LEN(a) || i >= (u32)PORF_ARR_CAP(a)) return ${arrHole ? 'porf_arr_hole(a, i)' : 'JV_UNDEFINED'};
  const jsbits b = *(jsbits*)(MEM + PORF_ARR_ENT(a) + ((u64)i << 3));
  if (b == 0) return ${arrHole ? 'porf_arr_hole(a, i)' : 'JV_UNDEFINED'};
  return porf_unpack(b);
}

${st}u32 porf_arr_grow(u32 a, i32 need) {
  i32 cap = PORF_ARR_CAP(a);
  if (need <= cap) return PORF_ARR_ENT(a);
  const i32 copy = PORF_ARR_LEN(a) < cap ? PORF_ARR_LEN(a) : cap;
  while (cap < need) cap += cap >> 1 > 4 ? cap >> 1 : 4;
  const u32 ent = porf_alloc((u32)cap << 3, 0);
  memcpy(MEM + ent, MEM + PORF_ARR_ENT(a), (size_t)copy << 3);
  memset(MEM + ent + ((u64)copy << 3), 0, ((size_t)cap - (size_t)copy) << 3);
  PORF_ARR_ENT(a) = ent; PORF_ARR_CAP(a) = cap;
  porf_gc_barrier(a, ${TYPES.array});
  return ent;
}

${st}void porf_arr_set(u32 a, u32 i, jsval v) {
  const i32 len = PORF_ARR_LEN(a);
  if (i >= (u32)PORF_ARR_CAP(a)) porf_arr_grow(a, (i32)i + 1);
  if (i >= (u32)len) PORF_ARR_LEN(a) = (i32)i + 1;
  *(jsbits*)(MEM + PORF_ARR_ENT(a) + ((u64)i << 3)) = porf_arr_pack(v);
  if (porf_gc_type_can_reference(v.type)) porf_gc_barrier(a, ${TYPES.array});
}

${st}void porf_arr_mark_arguments(u32 a) {
  PORF_ARR_KIND(a) = PORF_ARR_ARGUMENTS;
}

${st}void porf_arr_delete(u32 a, u32 i) {
  if (i >= (u32)PORF_ARR_LEN(a) || i >= (u32)PORF_ARR_CAP(a)) return;
  *(jsbits*)(MEM + PORF_ARR_ENT(a) + ((u64)i << 3)) = 0;
}

${st}void porf_arr_set_len(u32 a, u32 new_len) {
  const u32 old_len = (u32)PORF_ARR_LEN(a);
  if (new_len < old_len) {
    const u32 cap = (u32)PORF_ARR_CAP(a);
    const u32 clear = old_len < cap ? old_len : cap;
    if (new_len < clear) memset(MEM + PORF_ARR_ENT(a) + ((u64)new_len << 3), 0, ((size_t)clear - new_len) << 3);
  }
  PORF_ARR_LEN(a) = (i32)new_len;
}

${st}jsval porf_arr_push(u32 a, jsval v) {
  const i32 len = PORF_ARR_LEN(a);
  porf_arr_grow(a, len + 1);
  *(jsbits*)(MEM + PORF_ARR_ENT(a) + ((u64)len << 3)) = porf_arr_pack(v);
  PORF_ARR_LEN(a) = len + 1;
  if (porf_gc_type_can_reference(v.type)) porf_gc_barrier(a, ${TYPES.array});
  return porf_box_num((f64)(len + 1));
}

// ---- strings ----
${st}u32 porf_bstr_new(u32 len) {
  const u32 s = porf_alloc(4 + len, ${TYPES.bytestring});
  *(u32*)(MEM + s) = len;
  return s;
}

${ropes ? `// ropes (--ropes): a concatenation long enough is a node holding its two halves, flattened
// into one string once something reads its characters, and cached (read again, it is O(1)).
// The node is [u32 length][u32 left][u32 right][u32 flat][u8 left type][u8 right type]
// [u8 type]: its length where a flat string's is, so a raw length load reads it right, and
// its value's type the string type it flattens to. It is told apart by its block kind.
#define PORF_ROPE_MIN 64u
// (the kind table directly, as the allocator writes it: a freshly bumped block has its
// kind before its allocation bit is published, which porf_gc_kind waits for)
${sti}int porf_rope_is(u32 p) {
  return p >= porf_heap_base && porf_gc_kinds[porf_gc_gran((i32)p)] == PORF_GC_KIND_ROPE;
}
${st}u32 porf_rope_flatten(u32 r) {
  const u32 cached = *(u32*)(MEM + r + 12);
  if (cached != 0) return cached;
  volatile u32 keep = r;
  const u32 len = *(u32*)(MEM + r);
  const u8 type = *(u8*)(MEM + r + 18);
  const int wide = type != ${TYPES.bytestring};
  const u32 out = porf_alloc(4 + (wide ? len * 2 : len), type);
  r = keep;
  *(u32*)(MEM + out) = len;
  // the leaves left to right: a stack of what is still to write, the left half on top
  u32 cap = 64, sp = 1, pos = 0;
  u32* stack = (u32*)malloc(cap * 2 * sizeof(u32));
  if (!stack) abort();
  stack[0] = r; stack[1] = type;
  while (sp > 0) {
    sp--;
    u32 p = stack[sp * 2];
    const u32 t = stack[sp * 2 + 1];
    if (porf_rope_is(p)) {
      const u32 flat = *(u32*)(MEM + p + 12);
      if (flat == 0) {
        if (sp + 2 > cap) {
          cap *= 2;
          stack = (u32*)realloc(stack, cap * 2 * sizeof(u32));
          if (!stack) abort();
        }
        stack[sp * 2] = *(u32*)(MEM + p + 8); stack[sp * 2 + 1] = *(u8*)(MEM + p + 17); sp++;
        stack[sp * 2] = *(u32*)(MEM + p + 4); stack[sp * 2 + 1] = *(u8*)(MEM + p + 16); sp++;
        continue;
      }
      // flattened already: its flat string, of the same type
      p = flat;
    }
    const u32 n = *(u32*)(MEM + p);
    if (!wide) memcpy(MEM + out + 4 + pos, MEM + p + 4, n);
    else if (t == ${TYPES.bytestring}) {
      porf_simd_widen(out, (i32)pos, p, 0, (i32)n);
    } else memcpy((u16*)(MEM + out + 4) + pos, MEM + p + 4, (size_t)n * 2);
    pos += n;
  }
  free(stack);
  // only the flat string is kept alive from now on, not the halves
  *(u32*)(MEM + r + 12) = out;
  *(u32*)(MEM + r + 4) = 0;
  *(u32*)(MEM + r + 8) = 0;
  porf_gc_barrier(r, PORF_GC_KIND_ROPE);
  return out;
}
PORF_NOINLINE static jsval porf_str_flat_slow(jsval v) {
  return porf_box((f64)porf_rope_flatten((u32)v.val), v.type);
}
// a string value readable as characters: a rope's flat string, anything else as it is.
// Every builtin argument goes through this, so it is a few compares, inlined, for the
// values that are not ropes, and a load for a rope already flattened (a variable keeps
// holding the rope after its first read, so a loop over it comes here every time)
static inline __attribute__((always_inline)) jsval porf_str_flat(jsval v) {
  if (__builtin_expect((v.type == ${TYPES.bytestring} || v.type == ${TYPES.string}) && porf_rope_is((u32)v.val), 0)) {
    const u32 flat = *(u32*)(MEM + (u32)v.val + 12);
    return flat ? porf_box((f64)flat, v.type) : porf_str_flat_slow(v);
  }
  return v;
}

` : ''}// String.prototype.charCodeAt with a number index, for the call site: the builtin's
// ToIntegerOrInfinity (NaN is 0, truncated toward zero) and a load
static inline jsval porf_str_char_code(jsval s, f64 i) {
${ropes ? `  s = porf_str_flat(s);
` : ''}  const u32 p = (u32)s.val;
  f64 t = trunc(i);
  if (t != t) t = 0.0;
  if (!(t >= 0.0 && t < (f64)*(u32*)(MEM + p))) return porf_box_num(NAN);
  const u32 k = (u32)t;
  return porf_box_num(s.type == ${TYPES.bytestring} ? (f64)*(u8*)(MEM + p + 4 + k) : (f64)*(u16*)(MEM + p + 4 + k * 2));
}

${st}jsval porf_str_concat(jsval a, jsval b) {
  volatile u32 keep_a = (u32)a.val, keep_b = (u32)b.val;
  const u32 pa = keep_a, pb = keep_b;
  const u32 la = *(u32*)(MEM + pa), lb = *(u32*)(MEM + pb);
${ropes ? `  if (la + lb >= PORF_ROPE_MIN && la != 0 && lb != 0) {
    const u32 r = porf_alloc(20, 0);
    porf_gc_kinds[porf_gc_gran((i32)r)] = (u8)PORF_GC_KIND_ROPE;
    const u8 type = a.type == ${TYPES.bytestring} && b.type == ${TYPES.bytestring} ? ${TYPES.bytestring} : ${TYPES.string};
    *(u32*)(MEM + r) = la + lb;
    *(u32*)(MEM + r + 4) = keep_a;
    *(u32*)(MEM + r + 8) = keep_b;
    *(u32*)(MEM + r + 12) = 0;
    *(u8*)(MEM + r + 16) = (u8)a.type;
    *(u8*)(MEM + r + 17) = (u8)b.type;
    *(u8*)(MEM + r + 18) = type;
    return porf_box((f64)r, type);
  }
  // one side empty: the other, as it is (a string never changes); else below copies the
  // characters of both, so a rope among them (too short to stay one) is read flat
  if (la == 0) return b;
  if (lb == 0) return a;
  if (porf_rope_is(pa) || porf_rope_is(pb)) return porf_str_concat(porf_str_flat(a), porf_str_flat(b));
` : ''}  if (a.type == ${TYPES.bytestring} && b.type == ${TYPES.bytestring}) {
    const u32 s = porf_bstr_new(la + lb);
    memcpy(MEM + s + 4, MEM + pa + 4, la);
    memcpy(MEM + s + 4 + la, MEM + pb + 4, lb);
    return porf_box((f64)s, ${TYPES.bytestring});
  }

  const u32 s = porf_alloc(4 + (la + lb) * 2, ${TYPES.string});
  *(u32*)(MEM + s) = la + lb;
  u16* out = (u16*)(MEM + s + 4);
  if (a.type == ${TYPES.bytestring}) {
    porf_simd_widen(s, 0, pa, 0, (i32)la);
  } else {
    memcpy(out, MEM + pa + 4, (size_t)la * 2);
  }
  out += la;
  if (b.type == ${TYPES.bytestring}) {
    porf_simd_widen(s, (i32)la, pb, 0, (i32)lb);
  } else {
    memcpy(out, MEM + pb + 4, (size_t)lb * 2);
  }
  return porf_box((f64)s, ${TYPES.string});
}

${st}i32 porf_str_eq(jsval a, jsval b) {
  const u32 pa = (u32)a.val, pb = (u32)b.val;
  if (pa == pb) return 1;
${ropes ? `  if (porf_rope_is(pa) || porf_rope_is(pb)) return porf_str_eq(porf_str_flat(a), porf_str_flat(b));
` : ''}  const u32 la = *(u32*)(MEM + pa);
  if (la != *(u32*)(MEM + pb)) return 0;
  const i32 ta = porf_jv_type(a), tb = porf_jv_type(b);
  return porf_str_mismatch(pa, ta == ${TYPES.string}, 0, pb, tb == ${TYPES.string}, 0, (i32)la) == (i32)la;
}

${dtoa === 'libc' ? '' : DTOA[dtoa].c}
// an exponent as JS writes it (e+21, e-7) into o, its length returned
static int porf_fmt_exp(char* o, int e) {
  o[0] = 'e';
  o[1] = e >= 0 ? '+' : '-';
  return 2 + porf_fmt_int(o + 2, e >= 0 ? e : -e);
}

// the shortest digits that round-trip to d (finite, > 0), as --dtoa finds them: into digs,
// their count returned and *pt the decimal point's position (n in Number::toString)
static int porf_shortest(f64 d, char* digs, int* pt) {
  int k = 0;
${dtoa !== 'libc' ? `  uint64_t bits;
  memcpy(&bits, &d, 8);
  uint64_t sig;
  int exp10;
  ${DTOA[dtoa].fn}(bits, &sig, &exp10);
  char rev[24];
  int m = 0;
  do { rev[m++] = (char)('0' + sig % 10u); sig /= 10u; } while (sig);
  while (m) digs[k++] = rev[--m];
  *pt = exp10 + k;` : `  // from %e (%g differs: exponent below 1e-4 instead of 1e-6, "e-07" not "e-7", and
  // exponent form for long non-integers that JS writes out in full up to 1e21)
  char e[40];
  for (int prec = isnormal(d) ? 15 : 1;; prec++) {
    snprintf(e, sizeof e, "%.*e", prec - 1, d);
    if (strtod(e, NULL) == d || prec == 17) break;
  }
  const char* q = e;
  for (; *q && *q != 'e'; q++) if (*q >= '0' && *q <= '9') digs[k++] = *q;
  while (k > 1 && digs[k - 1] == '0') k--; // %e pads with trailing zeros
  *pt = atoi(q + 1) + 1;`}
  return k;
}

// a number's text (Number::toString) into buf (32 bytes): its length. No allocation, so printing
// a number (console.log) needs no heap string, and no allocator in a program that only prints
${st}int porf_num_to_buf(f64 d, char* buf) {
  int n;
  if (d != d) { memcpy(buf, "NaN", 3); n = 3; }
    else if (d == INFINITY) { memcpy(buf, "Infinity", 8); n = 8; }
    else if (d == -INFINITY) { memcpy(buf, "-Infinity", 9); n = 9; }
    // exact digits are the shortest round-tripping ones only up to 2^53; above it JS
    // prints the shortest digits padded with zeros (2^60 is "1152921504606847000")
    else if (d == trunc(d) && fabs(d) < 9007199254740992.0) {
      char* p = buf + 32;
      u64 v = (u64)fabs(d);
      do { *--p = (char)('0' + v % 10u); v /= 10u; } while (v);
      if (d < 0) *--p = '-';
      n = (int)(buf + 32 - p);
      memmove(buf, p, (size_t)n);
    } else {
      // the shortest round-tripping digits, then laid out by Number::toString's rules
      char digs[24];
      int pt;
      const int neg = d < 0;
      const int k = porf_shortest(fabs(d), digs, &pt);
      char* o = buf;
      if (neg) *o++ = '-';
      if (k <= pt && pt <= 21) {
        memcpy(o, digs, (size_t)k); o += k;
        for (int i = k; i < pt; i++) *o++ = '0';
      } else if (0 < pt && pt <= 21) {
        memcpy(o, digs, (size_t)pt); o += pt;
        *o++ = '.';
        memcpy(o, digs + pt, (size_t)(k - pt)); o += k - pt;
      } else if (-6 < pt && pt <= 0) {
        *o++ = '0'; *o++ = '.';
        for (int i = 0; i < -pt; i++) *o++ = '0';
        memcpy(o, digs, (size_t)k); o += k;
      } else {
        *o++ = digs[0];
        if (k > 1) { *o++ = '.'; memcpy(o, digs + 1, (size_t)(k - 1)); o += k - 1; }
        o += porf_fmt_exp(o, pt - 1);
      }
      n = (int)(o - buf);
    }
  return n;
}

${st}jsval porf_num_to_str(f64 d) {
  char buf[32];
  const int n = porf_num_to_buf(d, buf);
  const u32 s = porf_bstr_new((u32)n);
  memcpy(MEM + s + 4, buf, (size_t)n);
  return porf_box((f64)s, ${TYPES.bytestring});
}

// Number.prototype.toExponential() with no digit count: the shortest round-tripping
// digits, as d.ddde+n (finite d)
${st}jsval porf_num_to_exp(f64 d) {
  char digs[24] = "0", buf[40];
  char* o = buf;
  int k = 1, pt = 1;
  if (d < 0) { *o++ = '-'; d = -d; }
  if (d != 0) k = porf_shortest(d, digs, &pt);
  *o++ = digs[0];
  if (k > 1) { *o++ = '.'; memcpy(o, digs + 1, (size_t)(k - 1)); o += k - 1; }
  o += porf_fmt_exp(o, pt - 1);
  const int n = (int)(o - buf);
  const u32 s = porf_bstr_new((u32)n);
  memcpy(MEM + s + 4, buf, (size_t)n);
  return porf_box((f64)s, ${TYPES.bytestring});
}

// The host's time zone, which Date's local time and Temporal.Now read: its offset from UTC
// at an instant (ms since the epoch, in ms) and its IANA name. Natively libc's: localtime_r
// for the offset, TZ or the /etc/localtime link for the name. An embedder that can ask its
// host defines PORF_HOST_TIMEZONE and the two porf_host_tz_* functions (yel-porffor, over
// wasi:clocks/timezone). Else UTC, as on plain WASI: wasi-libc has no zone data.
#if defined(PORF_HOST_TIMEZONE)
f64 porf_host_tz_offset_ms(f64 t);
int porf_host_tz_id(char* buf, int cap);
${sti}f64 porf_tz_offset_ms(f64 t) { return t == t ? porf_host_tz_offset_ms(t) : 0; }
${sti}int porf_tz_id_c(char* buf, int cap) { return porf_host_tz_id(buf, cap); }
#elif !defined(__wasi__)
${st}f64 porf_tz_offset_ms(f64 t) {
  static int ready = 0;
  if (!ready) { tzset(); ready = 1; }
  if (t != t) return 0;
  const time_t s = (time_t)floor(t / 1000.0);
  struct tm tm;
  return localtime_r(&s, &tm) ? (f64)tm.tm_gmtoff * 1000.0 : 0;
}
${st}int porf_tz_id_c(char* buf, int cap) {
  // TZ=":Europe/Budapest", TZ="Europe/Budapest" or a path into a zoneinfo directory (an
  // empty TZ is UTC); with no TZ, what /etc/localtime links to
  // (/usr/share/zoneinfo/Europe/Budapest)
  const char* tz = getenv("TZ");
  char link[256];
  if (tz && *tz == ':') tz++;
  if (!tz) {
    const ssize_t n = readlink("/etc/localtime", link, sizeof link - 1);
    if (n <= 0) return 0;
    link[n] = 0;
    tz = link;
  }
  const char* zi = strstr(tz, "zoneinfo/");
  if (zi) tz = zi + 9;
  int n = 0;
  for (; tz[n] && n < cap; n++) {
    const char c = tz[n];
    // a POSIX rule (EST5EDT,M3.2.0) or a path is no IANA name: the offset stands in for it
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '/' || c == '_' || c == '-' || c == '+')) return 0;
    buf[n] = c;
  }
  return tz[n] || *tz == '/' ? 0 : n;
}
#else
${sti}f64 porf_tz_offset_ms(f64 t) { (void)t; return 0; }
${sti}int porf_tz_id_c(char* buf, int cap) { (void)buf; (void)cap; return 0; }
#endif

// the host time zone's name as a string, "UTC" when it has none, else its offset (+01:00)
// when it gives no IANA name
${st}jsval porf_tz_id(void) {
  char buf[64];
  int n = porf_tz_id_c(buf, sizeof buf);
  if (n <= 0) {
    const i32 off = (i32)(porf_tz_offset_ms(porf_performance_time_origin() + porf_performance_now()) / 60000.0);
    if (off == 0) { memcpy(buf, "UTC", 3); n = 3; }
      else {
        const i32 h = abs(off) / 60, m = abs(off) % 60;
        buf[0] = off < 0 ? '-' : '+';
        buf[1] = (char)('0' + h / 10 % 10); buf[2] = (char)('0' + h % 10); buf[3] = ':';
        buf[4] = (char)('0' + m / 10); buf[5] = (char)('0' + m % 10);
        n = 6;
      }
  }
  const u32 s = porf_bstr_new((u32)n);
  memcpy(MEM + s + 4, buf, (size_t)n);
  return porf_box((f64)s, ${TYPES.bytestring});
}

// round(x * 10^k) for a finite x >= 0 and an integer k, as decimal digits ("0" for zero),
// from x's exact value and the larger integer on a tie: what toFixed, toPrecision and
// toExponential ask for (builtins/number.ts). x = m / 2^e exactly, so m * 10^k is built
// in 32-bit limbs, the powers of ten below one divided out (keeping the last digit out),
// then 2^e, rounding on the last bit shifted out. With the callers' k (-400 to 450) the
// product stays under 2^1600, 50 limbs
${st}jsval porf_round_scaled(f64 x, i32 k) {
  u64 bits;
  memcpy(&bits, &x, 8);
  const i32 be = (i32)((bits >> 52) & 0x7ff);
  u64 m = bits & ((1ull << 52) - 1);
  i32 e = be ? 1075 - be : 1074;
  if (be) m |= 1ull << 52;
  u32 d[56];
  i32 n = 0;
  if (m != 0) {
    while (e > 0 && !(m & 1)) { m >>= 1; e--; }
    d[0] = (u32)m;
    d[1] = (u32)(m >> 32);
    n = d[1] ? 2 : 1;
  }

  // e < 0: an integer, times 2^-e
  if (n && e < 0) {
    const i32 limbs = -e / 32, r = -e % 32;
    d[n] = 0;
    for (i32 i = n; i >= 0; i--) d[i + limbs] = r ? (d[i] << r) | (i ? d[i - 1] >> (32 - r) : 0) : d[i];
    for (i32 i = 0; i < limbs; i++) d[i] = 0;
    n += limbs + 1;
    while (n && !d[n - 1]) n--;
    e = 0;
  }

  // * 10^k, nine digits at a time
  static const u32 pow10[10] = { 1u, 10u, 100u, 1000u, 10000u, 100000u, 1000000u, 10000000u, 100000000u, 1000000000u };
  for (i32 j = k; n && j > 0; j -= 9) {
    const u32 f = pow10[j >= 9 ? 9 : j];
    u64 carry = 0;
    for (i32 i = 0; i < n; i++) { carry += (u64)d[i] * f; d[i] = (u32)carry; carry >>= 32; }
    if (carry) d[n++] = (u32)carry;
  }

  // / 10^-k, keeping the last (most significant) digit divided out
  u32 last = 0;
  for (i32 j = 0; n && j < -k; j++) {
    u64 rem = 0;
    for (i32 i = n - 1; i >= 0; i--) { const u64 cur = (rem << 32) | d[i]; d[i] = (u32)(cur / 10u); rem = cur % 10u; }
    last = (u32)rem;
    while (n && !d[n - 1]) n--;
  }

  // / 2^e, rounding half up: on the digit divided out last when there is no binary
  // fraction, else on bit e-1 (a remainder below it never reaches half)
  int up = e == 0 && k < 0 && last >= 5;
  if (n && e > 0) {
    const i32 bit = e - 1;
    up = bit / 32 < n && ((d[bit / 32] >> (bit % 32)) & 1);
    const i32 whole = e / 32, part = e % 32;
    i32 o = 0;
    for (i32 i = whole; i < n; i++) d[o++] = part ? (d[i] >> part) | (i + 1 < n ? d[i + 1] << (32 - part) : 0) : d[i];
    n = o;
    while (n && !d[n - 1]) n--;
  }
  if (up) {
    i32 i = 0;
    while (i < n && ++d[i] == 0) i++;
    if (i == n) d[n++] = 1;
  }

  // to decimal, nine digits at a time, least significant first
  char rev[560];
  i32 len = 0;
  while (n) {
    u64 rem = 0;
    for (i32 i = n - 1; i >= 0; i--) { const u64 cur = (rem << 32) | d[i]; d[i] = (u32)(cur / 1000000000u); rem = cur % 1000000000u; }
    while (n && !d[n - 1]) n--;
    for (i32 t = 0; t < 9 && (n || rem); t++) { rev[len++] = (char)('0' + rem % 10u); rem /= 10u; }
  }
  if (len == 0) rev[len++] = '0';
  const u32 out = porf_bstr_new((u32)len);
  for (i32 i = 0; i < len; i++) MEM[out + 4 + i] = (u8)rev[len - 1 - i];
  return porf_box((f64)out, ${TYPES.bytestring});
}

// ToString for + and template literals
${st}jsval porf_to_str(jsval v);
${st}jsval porf_str_concat(jsval a, jsval b);
${bigintUsed ? `${st}jsval porf_bigint_to_str(jsval v, i32 radix);
` : ''}\
${st}jsval porf_to_str(jsval v) {
  if (porf_jv_is_num(v)) return porf_num_to_str(v.val);
  const i32 t = v.type;
  if (t == ${TYPES.bytestring} || t == ${TYPES.string}) return v;
${bigintUsed ? `  if (t == ${TYPES.bigint}) return porf_bigint_to_str(v, 10);
` : ''}\
  if (t == ${TYPES.array}) {
    // join(',')
    const u32 a = (u32)v.val;
    const i32 n = PORF_ARR_LEN(a);
    jsval acc = porf_box((f64)porf_bstr_new(0), ${TYPES.bytestring});
    for (i32 i = 0; i < n; i++) {
      if (i) {
        const u32 c = porf_bstr_new(1); MEM[c + 4] = 44;
        acc = porf_str_concat(acc, porf_box((f64)c, ${TYPES.bytestring}));
      }
      const jsval e = porf_arr_get(a, (u32)i);
      const i32 et = porf_jv_type(e);
      if (et != ${TYPES.undefined} && !(et == ${TYPES.object} && (u32)e.val == 0))
        acc = porf_str_concat(acc, porf_to_str(e));
    }
    return acc;
  }
  const char* lit =
    t == ${TYPES.undefined} ? "undefined" :
    t == ${TYPES.boolean} ? ((u32)v.val ? "true" : "false") :
    t == ${TYPES.object} && (u32)v.val == 0 ? "null" :
    t == ${TYPES.function} ? "function" : "[object Object]";
  const u32 len = (u32)strlen(lit);
  const u32 s = porf_bstr_new(len);
  memcpy(MEM + s + 4, lit, len);
  return porf_box((f64)s, ${TYPES.bytestring});
}

// basic ToNumber (string parsing arrives with builtins port)
${sti}f64 porf_to_num(jsval v) {
  if (porf_jv_is_num(v)) return v.val;
  const i32 t = v.type;
  if (t == ${TYPES.boolean}) return (f64)(u32)v.val;
  if (t == ${TYPES.object} && (u32)v.val == 0) return 0.0; // null
  return porf_bits_to_f64(0x7FF8000000000000ull); // NaN
}

static inline int porf_bigint_is_heap(jsval v) {
  return v.type == ${TYPES.bigint} && v.val >= 2251799813685248.0;
}

static inline u32 porf_bigint_ptr(jsval v) {
  return (u32)(v.val - 2251799813685248.0);
}

static inline int porf_bigint_is_negative(jsval v) {
  return porf_bigint_is_heap(v) ? *(u8*)(MEM + porf_bigint_ptr(v)) != 0 : v.val < 0;
}

static u32 porf_bigint_trimmed_len(u32 p) {
  const u32 len = *(u16*)(MEM + p + 2);
  u32 i = 0;
  while (i < len && *(u32*)(MEM + p + 4 + (i << 2)) == 0) i++;
  return len - i;
}

static i32 porf_bigint_cmp_abs(jsval a, jsval b) {
  const int ah = porf_bigint_is_heap(a), bh = porf_bigint_is_heap(b);
  if (!ah && !bh) {
    const f64 av = a.val < 0 ? -a.val : a.val;
    const f64 bv = b.val < 0 ? -b.val : b.val;
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  if (ah && !bh) return 1;
  if (!ah && bh) return -1;

  const u32 ap = porf_bigint_ptr(a), bp = porf_bigint_ptr(b);
  const u32 alen = porf_bigint_trimmed_len(ap), blen = porf_bigint_trimmed_len(bp);
  if (alen != blen) return alen < blen ? -1 : 1;

  const u32 astart = *(u16*)(MEM + ap + 2) - alen;
  const u32 bstart = *(u16*)(MEM + bp + 2) - blen;
  for (u32 i = 0; i < alen; i++) {
    const u32 av = *(u32*)(MEM + ap + 4 + ((astart + i) << 2));
    const u32 bv = *(u32*)(MEM + bp + 4 + ((bstart + i) << 2));
    if (av != bv) return av < bv ? -1 : 1;
  }
  return 0;
}

static i32 porf_bigint_cmp(jsval a, jsval b) {
  const int an = porf_bigint_is_negative(a), bn = porf_bigint_is_negative(b);
  if (an != bn) return an ? -1 : 1;
  const i32 c = porf_bigint_cmp_abs(a, b);
  return an ? -c : c;
}

// ---- BigInt arithmetic ----
// A BigInt is inline (|n| < 2^41: the f64 payload is the value, and it packs into a
// 42-bit field, see porf_pack) or on the heap (payload = ptr + 2^51): [u8 negative][u8 0]
// [u16 digit count][u32 digits, most significant first].
// Every operation reads its operands into little-endian u32 limbs in scratch memory (libc,
// never the GC heap), computes there, and allocates once, for the result, which is
// canonical: inline whenever it fits, so equal values have equal inline payloads.
#define PORF_BN_HEAP 2251799813685248.0
#define PORF_BN_SMALL 2199023255552.0
#define PORF_BN_MAX_DIGITS 16383u

PORF_NORETURN static void porf_bn_throw(i32 type, const char* msg) {
  const u32 len = (u32)strlen(msg);
  const u32 s = porf_bstr_new(len);
  memcpy(MEM + s + 4, msg, len);
  porf_throw_new(type, s);
}

static u32* porf_bn_scratch(u32 n) {
  u32* p = (u32*)calloc(n ? n : 1u, 4);
  if (!p) {
    fputs("porffor: out of memory (BigInt)", stderr);
    exit(1);
  }
  return p;
}

// how many limbs porf_bn_load writes for v
static u32 porf_bn_cap(jsval v) {
  return porf_bigint_is_heap(v) ? (u32)*(u16*)(MEM + porf_bigint_ptr(v) + 2) : 2u;
}

// v's magnitude into out (little-endian, porf_bn_cap(v) limbs) and its sign; the length
// without leading zero limbs
static u32 porf_bn_load(jsval v, u32* out, int* neg) {
  if (!porf_bigint_is_heap(v)) {
    const f64 d = v.val;
    const u64 m = (u64)(d < 0 ? -d : d);
    *neg = d < 0;
    out[0] = (u32)m;
    out[1] = (u32)(m >> 32);
    return out[1] ? 2u : out[0] ? 1u : 0u;
  }
  const u32 p = porf_bigint_ptr(v);
  const u32 len = *(u16*)(MEM + p + 2);
  *neg = *(u8*)(MEM + p) != 0;
  for (u32 i = 0; i < len; i++) out[i] = *(u32*)(MEM + p + 4 + ((len - 1 - i) << 2));
  u32 n = len;
  while (n > 0 && out[n - 1] == 0) n--;
  return n;
}

// the BigInt with this sign and magnitude
static jsval porf_bn_make(int neg, const u32* d, u32 n) {
  while (n > 0 && d[n - 1] == 0) n--;
  if (n == 0) return porf_box(0.0, ${TYPES.bigint});
  if (n <= 2) {
    const u64 m = (u64)d[0] | (n == 2 ? (u64)d[1] << 32 : 0ull);
    if (m < 2199023255552ull) return porf_box(neg ? -(f64)m : (f64)m, ${TYPES.bigint});
  }
  if (n > PORF_BN_MAX_DIGITS) porf_bn_throw(${TYPES.rangeerror}, "Maximum BigInt size exceeded");
  const u32 p = porf_alloc(4 + (n << 2), ${TYPES.bigint});
  *(u8*)(MEM + p) = neg ? 1 : 0;
  *(u8*)(MEM + p + 1) = 0;
  *(u16*)(MEM + p + 2) = (u16)n;
  for (u32 i = 0; i < n; i++) *(u32*)(MEM + p + 4 + (i << 2)) = d[n - 1 - i];
  return porf_box((f64)p + PORF_BN_HEAP, ${TYPES.bigint});
}

static int porf_bn_cmp_mag(const u32* a, u32 an, const u32* b, u32 bn) {
  if (an != bn) return an < bn ? -1 : 1;
  for (u32 i = an; i-- > 0;)
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// r = a + b; r has room for max(an, bn) + 1 limbs
static u32 porf_bn_add_mag(u32* r, const u32* a, u32 an, const u32* b, u32 bn) {
  if (an < bn) {
    const u32* t = a; a = b; b = t;
    const u32 tn = an; an = bn; bn = tn;
  }
  u64 c = 0;
  for (u32 i = 0; i < an; i++) {
    c += (u64)a[i] + (i < bn ? b[i] : 0u);
    r[i] = (u32)c;
    c >>= 32;
  }
  r[an] = (u32)c;
  return an + 1;
}

// r = a - b, for a >= b; r has room for an limbs
static u32 porf_bn_sub_mag(u32* r, const u32* a, u32 an, const u32* b, u32 bn) {
  u64 borrow = 0;
  for (u32 i = 0; i < an; i++) {
    const u64 x = (u64)a[i] - (i < bn ? b[i] : 0u) - borrow;
    r[i] = (u32)x;
    borrow = (x >> 63) & 1u;
  }
  return an;
}

// r = a * b; r is zeroed and has room for an + bn limbs
static u32 porf_bn_mul_mag(u32* r, const u32* a, u32 an, const u32* b, u32 bn) {
  for (u32 i = 0; i < an; i++) {
    u64 c = 0;
    for (u32 j = 0; j < bn; j++) {
      c += (u64)a[i] * b[j] + r[i + j];
      r[i + j] = (u32)c;
      c >>= 32;
    }
    r[i + bn] = (u32)c;
  }
  return an + bn;
}

// q = u / v and r = u % v (Knuth's algorithm D, after Hacker's Delight divmnu). v has
// vn >= 1 limbs with v[vn - 1] != 0, and un >= vn; q has room for un - vn + 1 limbs and
// r for vn.
static void porf_bn_divmod_mag(u32* q, u32* r, const u32* u, u32 un, const u32* v, u32 vn) {
  if (vn == 1) {
    u64 rem = 0;
    for (u32 i = un; i-- > 0;) {
      const u64 cur = (rem << 32) | u[i];
      q[i] = (u32)(cur / v[0]);
      rem = cur % v[0];
    }
    r[0] = (u32)rem;
    return;
  }
  const int s = __builtin_clz(v[vn - 1]);
  u32* vs = porf_bn_scratch(vn);
  u32* us = porf_bn_scratch(un + 1);
  for (u32 i = vn - 1; i > 0; i--) vs[i] = (v[i] << s) | (s ? v[i - 1] >> (32 - s) : 0u);
  vs[0] = v[0] << s;
  us[un] = s ? u[un - 1] >> (32 - s) : 0u;
  for (u32 i = un - 1; i > 0; i--) us[i] = (u[i] << s) | (s ? u[i - 1] >> (32 - s) : 0u);
  us[0] = u[0] << s;

  for (i64 j = (i64)un - (i64)vn; j >= 0; j--) {
    const u64 num = ((u64)us[j + vn] << 32) | us[j + vn - 1];
    u64 qhat = num / vs[vn - 1];
    u64 rhat = num % vs[vn - 1];
    while (qhat >= 4294967296ull || qhat * vs[vn - 2] > ((rhat << 32) | us[j + vn - 2])) {
      qhat--;
      rhat += vs[vn - 1];
      if (rhat >= 4294967296ull) break;
    }
    i64 k = 0, t;
    for (u32 i = 0; i < vn; i++) {
      const u64 p = qhat * vs[i];
      t = (i64)us[i + j] - k - (i64)(p & 0xFFFFFFFFull);
      us[i + j] = (u32)t;
      k = (i64)(p >> 32) - (t >> 32);
    }
    t = (i64)us[j + vn] - k;
    us[j + vn] = (u32)t;
    q[j] = (u32)qhat;
    if (t < 0) {
      q[j]--;
      k = 0;
      for (u32 i = 0; i < vn; i++) {
        t = (i64)us[i + j] + vs[i] + k;
        us[i + j] = (u32)t;
        k = t >> 32;
      }
      us[j + vn] += (u32)k;
    }
  }
  for (u32 i = 0; i < vn - 1; i++) r[i] = (us[i] >> s) | (s ? (u32)((u64)us[i + 1] << (32 - s)) : 0u);
  r[vn - 1] = us[vn - 1] >> s;
  free(vs);
  free(us);
}

// r = a << bits; r is zeroed and has room for an + bits / 32 + 1 limbs
static u32 porf_bn_shl_mag(u32* r, const u32* a, u32 an, u32 bits) {
  const u32 limbs = bits >> 5, s = bits & 31;
  for (u32 i = 0; i < an; i++) {
    r[i + limbs] |= a[i] << s;
    if (s) r[i + limbs + 1] = a[i] >> (32 - s);
  }
  return an + limbs + 1;
}

// r = a >> bits (truncating); *lost is whether any 1 bits were shifted out
static u32 porf_bn_shr_mag(u32* r, const u32* a, u32 an, u64 bits, int* lost) {
  const u64 limbs = bits >> 5;
  const u32 s = (u32)(bits & 31);
  *lost = 0;
  for (u64 i = 0; i < limbs && i < an; i++)
    if (a[i]) *lost = 1;
  if (limbs >= an) return 0;
  if (s && (a[limbs] << (32 - s))) *lost = 1;
  const u32 n = an - (u32)limbs;
  for (u32 i = 0; i < n; i++) {
    const u32 lo = a[i + limbs] >> s;
    const u32 hi = s && i + 1 < n ? a[i + limbs + 1] << (32 - s) : 0u;
    r[i] = lo | hi;
  }
  return n;
}

// the value as n limbs of two's complement
static void porf_bn_to_twos(u32* out, u32 n, const u32* mag, u32 mn, int neg) {
  if (!neg) {
    for (u32 i = 0; i < n; i++) out[i] = i < mn ? mag[i] : 0u;
    return;
  }
  u64 borrow = 1;
  for (u32 i = 0; i < n; i++) {
    const u64 x = (u64)(i < mn ? mag[i] : 0u) - borrow;
    borrow = (x >> 63) & 1u;
    out[i] = ~(u32)x;
  }
}

// the BigInt n limbs of two's complement hold (t is overwritten)
static jsval porf_bn_from_twos(u32* t, u32 n) {
  if (n == 0 || !(t[n - 1] >> 31)) return porf_bn_make(0, t, n);
  u64 c = 1;
  for (u32 i = 0; i < n; i++) {
    c += (u64)(u32)~t[i];
    t[i] = (u32)c;
    c >>= 32;
  }
  return porf_bn_make(1, t, n);
}

static u32 porf_bn_bitlen(const u32* a, u32 an) {
  return an == 0 ? 0u : (an - 1) * 32u + (32u - (u32)__builtin_clz(a[an - 1]));
}

// the value of a finite, integral f64 as a BigInt
${st}jsval porf_bigint_from_f64(f64 d) {
  if ((d < 0 ? -d : d) < PORF_BN_SMALL) return porf_box(d == 0 ? 0.0 : d, ${TYPES.bigint});
  u64 bits;
  memcpy(&bits, &d, 8);
  const int neg = (int)(bits >> 63);
  const i32 exp = (i32)((bits >> 52) & 0x7ff) - 1075;
  const u64 mant = (bits & 0xFFFFFFFFFFFFFull) | 0x10000000000000ull;
  const u32 m[2] = { (u32)mant, (u32)(mant >> 32) };
  if (exp <= 0) {
    const u64 v = mant >> (u32)-exp;
    const u32 w[2] = { (u32)v, (u32)(v >> 32) };
    return porf_bn_make(neg, w, 2);
  }
  const u32 cap = 2 + ((u32)exp >> 5) + 1;
  u32* r = porf_bn_scratch(cap);
  porf_bn_shl_mag(r, m, 2, (u32)exp);
  const jsval out = porf_bn_make(neg, r, cap);
  free(r);
  return out;
}

static f64 porf_bn_pow2(i32 k) {
  f64 r = 1.0;
  while (k > 0) {
    const i32 step = k > 1000 ? 1000 : k;
    const u64 b = (u64)(1023 + step) << 52;
    f64 f;
    memcpy(&f, &b, 8);
    r *= f;
    k -= step;
  }
  return r;
}

// Number(v): the nearest f64, ties to even
${st}f64 porf_bigint_to_f64(jsval v) {
  if (!porf_bigint_is_heap(v)) return v.val;
  const u32 cap = porf_bn_cap(v);
  u32* a = porf_bn_scratch(cap);
  int neg;
  const u32 an = porf_bn_load(v, a, &neg);
  const u32 bitlen = porf_bn_bitlen(a, an);
  f64 out;
  if (bitlen <= 64) out = (f64)((u64)a[0] | (an > 1 ? (u64)a[1] << 32 : 0ull));
  else {
    // the top 64 bits, the rest folded into the lowest as a sticky bit, then scaled
    const u32 shift = bitlen - 64;
    int lost;
    u32* t = porf_bn_scratch(an);
    porf_bn_shr_mag(t, a, an, shift, &lost);
    const u64 top = ((u64)t[0] | (u64)t[1] << 32) | (u64)(lost != 0);
    free(t);
    out = (f64)top * porf_bn_pow2((i32)shift);
  }
  free(a);
  return neg ? -out : out;
}

// a op b for two BigInts; op: 0 + 1 - 2 * 3 / 4 % 5 ** 6 & 7 | 8 ^ 9 << 10 >> 11 >>>
${st}jsval porf_bigint_arith(i32 op, jsval a, jsval b) {
  if (porf_jv_type(a) != ${TYPES.bigint} || porf_jv_type(b) != ${TYPES.bigint})
    porf_bn_throw(${TYPES.typeerror}, "Cannot mix BigInt and other types, use explicit conversions");
  if (op == 11) porf_bn_throw(${TYPES.typeerror}, "BigInts have no unsigned right shift, use >> instead");

  // both inline and the result exact: no limbs
  if (!porf_bigint_is_heap(a) && !porf_bigint_is_heap(b) && op <= 2) {
    const f64 r = op == 0 ? a.val + b.val : op == 1 ? a.val - b.val : a.val * b.val;
    if ((r < 0 ? -r : r) < PORF_BN_SMALL) return porf_box(r == 0 ? 0.0 : r, ${TYPES.bigint});
  }

  const u32 acap = porf_bn_cap(a), bcap = porf_bn_cap(b);
  u32* x = porf_bn_scratch(acap);
  u32* y = porf_bn_scratch(bcap);
  int xneg, yneg;
  const u32 xn = porf_bn_load(a, x, &xneg);
  const u32 yn = porf_bn_load(b, y, &yneg);
  jsval out = porf_box(0.0, ${TYPES.bigint});

  if (op == 0 || op == 1) {
    // a - b is a + (-b)
    if (op == 1) yneg = !yneg;
    const u32 cap = (xn > yn ? xn : yn) + 1;
    u32* r = porf_bn_scratch(cap);
    if (xneg == yneg) out = porf_bn_make(xneg, r, porf_bn_add_mag(r, x, xn, y, yn));
    else if (porf_bn_cmp_mag(x, xn, y, yn) >= 0) out = porf_bn_make(xneg, r, porf_bn_sub_mag(r, x, xn, y, yn));
    else out = porf_bn_make(yneg, r, porf_bn_sub_mag(r, y, yn, x, xn));
    free(r);
  } else if (op == 2) {
    u32* r = porf_bn_scratch(xn + yn);
    out = porf_bn_make(xneg != yneg, r, porf_bn_mul_mag(r, x, xn, y, yn));
    free(r);
  } else if (op == 3 || op == 4) {
    if (yn == 0) porf_bn_throw(${TYPES.rangeerror}, "Division by zero");
    if (porf_bn_cmp_mag(x, xn, y, yn) < 0) out = op == 3 ? porf_box(0.0, ${TYPES.bigint}) : a;
    else {
      u32* q = porf_bn_scratch(xn - yn + 1);
      u32* r = porf_bn_scratch(yn);
      porf_bn_divmod_mag(q, r, x, xn, y, yn);
      // truncating: the quotient's sign is the signs' xor, the remainder's the dividend's
      out = op == 3 ? porf_bn_make(xneg != yneg, q, xn - yn + 1) : porf_bn_make(xneg, r, yn);
      free(q);
      free(r);
    }
  } else if (op == 5) {
    if (yneg) porf_bn_throw(${TYPES.rangeerror}, "Exponent must be non-negative");
    if (yn == 0) out = porf_box(1.0, ${TYPES.bigint});
    else if (xn == 0) out = porf_box(0.0, ${TYPES.bigint});
    else if (xn == 1 && x[0] == 1) out = porf_box(xneg && (y[0] & 1) ? -1.0 : 1.0, ${TYPES.bigint});
    else {
      if (yn > 1 || (u64)porf_bn_bitlen(x, xn) * y[0] > (u64)PORF_BN_MAX_DIGITS * 32u)
        porf_bn_throw(${TYPES.rangeerror}, "Maximum BigInt size exceeded");
      // square and multiply; no intermediate is longer than twice the result
      const u32 cap = (u32)(((u64)porf_bn_bitlen(x, xn) * y[0]) >> 5) * 2 + 4;
      u32* acc = porf_bn_scratch(cap);
      u32* base = porf_bn_scratch(cap);
      u32* tmp = porf_bn_scratch(cap);
      u32 accn = 1, basen = xn;
      acc[0] = 1;
      memcpy(base, x, xn * 4);
      for (u32 e = y[0];;) {
        if (e & 1) {
          memset(tmp, 0, (accn + basen) * 4);
          accn = porf_bn_mul_mag(tmp, acc, accn, base, basen);
          while (accn > 0 && tmp[accn - 1] == 0) accn--;
          memcpy(acc, tmp, accn * 4);
        }
        e >>= 1;
        if (!e) break;
        memset(tmp, 0, basen * 2 * 4);
        basen = porf_bn_mul_mag(tmp, base, basen, base, basen);
        while (basen > 0 && tmp[basen - 1] == 0) basen--;
        memcpy(base, tmp, basen * 4);
      }
      out = porf_bn_make(xneg && (y[0] & 1), acc, accn);
      free(acc);
      free(base);
      free(tmp);
    }
  } else if (op >= 6 && op <= 8) {
    const u32 n = (xn > yn ? xn : yn) + 1;
    u32* s = porf_bn_scratch(n);
    u32* t = porf_bn_scratch(n);
    porf_bn_to_twos(s, n, x, xn, xneg);
    porf_bn_to_twos(t, n, y, yn, yneg);
    for (u32 i = 0; i < n; i++) s[i] = op == 6 ? s[i] & t[i] : op == 7 ? s[i] | t[i] : s[i] ^ t[i];
    out = porf_bn_from_twos(s, n);
    free(s);
    free(t);
  } else if (op == 9 || op == 10) {
    // a negative count shifts the other way
    const int left = (op == 9) != (yneg != 0);
    if (xn == 0) out = porf_box(0.0, ${TYPES.bigint});
    else if (left) {
      if (yn > 1 || y[0] > PORF_BN_MAX_DIGITS * 32u) porf_bn_throw(${TYPES.rangeerror}, "Maximum BigInt size exceeded");
      const u32 cap = xn + (y[0] >> 5) + 1;
      u32* r = porf_bn_scratch(cap);
      out = porf_bn_make(xneg, r, porf_bn_shl_mag(r, x, xn, y[0]));
      free(r);
    } else {
      // rounds toward -infinity: a negative value that lost bits is one further from zero
      const u64 count = yn > 2 ? ~0ull : (u64)y[0] | (yn > 1 ? (u64)y[1] << 32 : 0ull);
      u32* r = porf_bn_scratch(xn + 1);
      int lost;
      u32 n = porf_bn_shr_mag(r, x, xn, count, &lost);
      if (xneg && lost) {
        const u32 one = 1;
        u32* s = porf_bn_scratch(n + 1);
        n = porf_bn_add_mag(s, r, n, &one, 1);
        free(r);
        r = s;
      }
      out = porf_bn_make(xneg, r, n);
      free(r);
    }
  }
  free(x);
  free(y);
  return out;
}

${st}jsval porf_bigint_neg(jsval a) {
  if (!porf_bigint_is_heap(a)) return porf_box(a.val == 0 ? 0.0 : -a.val, ${TYPES.bigint});
  const u32 cap = porf_bn_cap(a);
  u32* x = porf_bn_scratch(cap);
  int neg;
  const u32 n = porf_bn_load(a, x, &neg);
  const jsval out = porf_bn_make(!neg, x, n);
  free(x);
  return out;
}

// ~a is -a - 1
${st}jsval porf_bigint_not(jsval a) {
  return porf_bigint_arith(1, porf_bigint_neg(a), porf_box(1.0, ${TYPES.bigint}));
}

// BigInt.asIntN (sign) / asUintN (!sign): v modulo 2^bits
${st}jsval porf_bigint_as_n(jsval v, f64 bitsf, i32 sign) {
  if (bitsf == 0) return porf_box(0.0, ${TYPES.bigint});
  const u32 cap = porf_bn_cap(v);
  u32* x = porf_bn_scratch(cap);
  int neg;
  const u32 xn = porf_bn_load(v, x, &neg);
  const u32 bitlen = porf_bn_bitlen(x, xn);
  // already in range: unchanged
  if ((sign && bitsf > (f64)bitlen) || (!sign && !neg && bitsf >= (f64)bitlen)) {
    free(x);
    return v;
  }
  if (bitsf > (f64)PORF_BN_MAX_DIGITS * 32.0) porf_bn_throw(${TYPES.rangeerror}, "Maximum BigInt size exceeded");
  const u32 bits = (u32)bitsf;
  const u32 k = (bits + 31) >> 5;
  const u32 n = (xn > k ? xn : k) + 1;
  u32* t = porf_bn_scratch(n);
  porf_bn_to_twos(t, n, x, xn, neg);
  // keep the low bits
  const u32 top = bits & 31;
  if (top) t[k - 1] &= (1u << top) - 1u;
  jsval out;
  if (sign && ((t[k - 1] >> ((bits - 1) & 31)) & 1u)) {
    // the top kept bit is set: negative, sign-extended over the limb
    if (top) t[k - 1] |= ~((1u << top) - 1u);
    out = porf_bn_from_twos(t, k);
  } else out = porf_bn_make(0, t, k);
  free(t);
  free(x);
  return out;
}

static int porf_bn_is_space(u32 c) {
  return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xA0 || c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F ||
    c == 0x3000 || c == 0xFEFF;
}

// StringToBigInt (literal = 0), or a source literal's digits (literal = 1: a sign may come
// before a radix prefix, nothing is trimmed): the BigInt, or undefined when s is not one
${st}jsval porf_bigint_parse(jsval s, i32 literal) {
${ropes ? `  s = porf_str_flat(s);
` : ''}  const u32 p = (u32)s.val;
  const u32 len = *(u32*)(MEM + p);
  const int wide = porf_jv_type(s) == ${TYPES.string};
#define PORF_BN_CH(i) (wide ? (u32)*(u16*)(MEM + p + 4 + ((i) << 1)) : (u32)*(u8*)(MEM + p + 4 + (i)))
  u32 i = 0, end = len;
  if (!literal) {
    while (i < end && porf_bn_is_space(PORF_BN_CH(i))) i++;
    while (end > i && porf_bn_is_space(PORF_BN_CH(end - 1))) end--;
    if (i == end) return porf_box(0.0, ${TYPES.bigint});
  }
  int neg = 0, signed_ = 0;
  if (i < end && (PORF_BN_CH(i) == '-' || PORF_BN_CH(i) == '+')) {
    neg = PORF_BN_CH(i) == '-';
    signed_ = 1;
    i++;
  }
  u32 radix = 10;
  if (end - i >= 2 && PORF_BN_CH(i) == '0') {
    const u32 c = PORF_BN_CH(i + 1) | 0x20;
    radix = c == 'x' ? 16 : c == 'o' ? 8 : c == 'b' ? 2 : 10;
    if (radix != 10) {
      // StringToBigInt takes no sign before a radix prefix
      if (signed_ && !literal) return JV_UNDEFINED;
      i += 2;
    }
  }
  if (i == end) return JV_UNDEFINED;
  u32* r = porf_bn_scratch(end - i + 1);
  u32 n = 0;
  for (; i < end; i++) {
    const u32 c = PORF_BN_CH(i);
    u32 digit = c >= '0' && c <= '9' ? c - '0' : (c | 0x20) >= 'a' && (c | 0x20) <= 'z' ? (c | 0x20) - 'a' + 10 : 99;
    if (digit >= radix) {
      free(r);
      return JV_UNDEFINED;
    }
    u64 carry = digit;
    for (u32 j = 0; j < n; j++) {
      carry += (u64)r[j] * radix;
      r[j] = (u32)carry;
      carry >>= 32;
    }
    if (carry) r[n++] = (u32)carry;
  }
#undef PORF_BN_CH
  const jsval out = porf_bn_make(neg, r, n);
  free(r);
  return out;
}

// v in radix 2..36, as a bytestring
${st}jsval porf_bigint_to_str(jsval v, i32 radix) {
  const u32 cap = porf_bn_cap(v);
  u32* x = porf_bn_scratch(cap);
  int neg;
  u32 n = porf_bn_load(v, x, &neg);
  // the most digits of radix whose power fits in 2^21, so rem * 2^32 + limb stays exact in u64
  u32 chunk = radix, per = 1;
  while ((u64)chunk * radix < 2097152ull) {
    chunk *= radix;
    per++;
  }
  const u32 max = n * 32 + 2;
  char* out = (char*)malloc(max);
  u32 len = 0;
  static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (n == 0) out[len++] = '0';
  while (n > 0) {
    u64 rem = 0;
    for (u32 i = n; i-- > 0;) {
      const u64 cur = (rem << 32) | x[i];
      x[i] = (u32)(cur / chunk);
      rem = cur % chunk;
    }
    while (n > 0 && x[n - 1] == 0) n--;
    // this chunk's digits, least significant first; zero-padded unless it is the last
    for (u32 d = 0; d < per && (n > 0 || rem > 0); d++) {
      out[len++] = digits[rem % radix];
      rem /= radix;
    }
  }
  if (neg) out[len++] = '-';
  const u32 s = porf_bstr_new(len);
  for (u32 i = 0; i < len; i++) *(u8*)(MEM + s + 4 + i) = (u8)out[len - 1 - i];
  free(out);
  free(x);
  return porf_box((f64)s, ${TYPES.bytestring});
}

// a hash of v's value (equal BigInts hash equal, whichever representation)
${st}i32 porf_bigint_hash(jsval v) {
  const u32 cap = porf_bn_cap(v);
  u32* x = porf_bn_scratch(cap);
  int neg;
  const u32 n = porf_bn_load(v, x, &neg);
  u32 h = neg ? 0x9e3779b9u : 0x85ebca6bu;
  for (u32 i = 0; i < n; i++) {
    h ^= x[i];
    h *= 0x7feb352du;
    h ^= h >> 15;
  }
  free(x);
  return (i32)h;
}

// BigInt a against Number y: -1/0/1, 2 when y is NaN
static i32 porf_bigint_cmp_num(jsval a, f64 y) {
  if (y != y) return 2;
  if (!porf_bigint_is_heap(a)) return a.val < y ? -1 : a.val > y ? 1 : 0;
  if (y - y != 0) return y > 0 ? -1 : 1; // infinite
  // y's integral part: from 2^52 up every f64 is integral
  const f64 whole = (y < 0 ? -y : y) >= 4503599627370496.0 ? y : (f64)(i64)y;
  const i32 c = porf_bigint_cmp(a, porf_bigint_from_f64(whole));
  if (c != 0) return c;
  return y > whole ? -1 : y < whole ? 1 : 0;
}

// a BigInt and something else compared by value (a relational or ==): -1/0/1, 2 unordered
static i32 porf_bigint_cmp_any(jsval big, jsval other) {
  const i32 t = porf_jv_type(other);
  if (t == ${TYPES.bigint}) return porf_bigint_cmp(big, other);
  if (t == ${TYPES.bytestring} || t == ${TYPES.string}) {
    const jsval parsed = porf_bigint_parse(other, 0);
    if (porf_jv_type(parsed) != ${TYPES.bigint}) return 2;
    return porf_bigint_cmp(big, parsed);
  }
  return porf_bigint_cmp_num(big, porf_to_num(other));
}

// ++ / -- on a numeric value (a Number or a BigInt)
${st}jsval porf_numeric_step(jsval v, i32 dec) {
  if (porf_jv_type(v) == ${TYPES.bigint}) return porf_bigint_arith(dec ? 1 : 0, v, porf_box(1.0, ${TYPES.bigint}));
  return porf_box_num(v.val + (dec ? -1.0 : 1.0));
}

${sti}int porf_is_strlike(jsval v) {
  if (porf_jv_is_num(v)) return 0;
  const i32 t = v.type;
  return t == ${TYPES.bytestring} || t == ${TYPES.string} ||
    t == ${TYPES.object} && (u32)v.val != 0 || t == ${TYPES.array} || t == ${TYPES.function};
}

// JS + : string-ish on either side concats; else numeric coercion
${toPrimDefault || toPrimNumber ? `// not a primitive (what ToPrimitive calls a method on): the primitive types are all at most
// ${TYPES.symbol} but the two string ones, and null is an object with no pointer
static inline int porf_is_object(jsval v) {
  const i32 t = porf_jv_type(v);
  return t > ${TYPES.symbol} && (t & 0x7f) != ${TYPES.string} && !(t == ${TYPES.object} && (u32)v.val == 0);
}
` : ''}\
${[ [ 'porf_add', toPrimDefault ], [ 'porf_add_plain', null ] ].map(([ name, hook ]) => `${hook ? `${sti}jsval ${name}(jsval a, jsval b);
// an object operand of + is a primitive first, hint "default" (valueOf before toString, a
// Date as a string): out of line, so the + inlined everywhere grows only by the check
PORF_NOINLINE ${st}jsval ${name}_objects(jsval a, jsval b) {
  if (porf_is_object(a)) a = ${hook}(a);
  if (porf_is_object(b)) b = ${hook}(b);
  return ${name}(a, b);
}
` : ''}// the + of two numbers inlined everywhere; the rest (strings, objects, BigInts) out of line,
// or the body is too big for clang to inline in a hot loop
PORF_NOINLINE ${st}jsval ${name}_slow(jsval a, jsval b);
${sti}jsval ${name}(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b))
    return porf_box_num(a.val + b.val);
  return ${name}_slow(a, b);
}
PORF_NOINLINE ${st}jsval ${name}_slow(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b))
    return porf_box_num(a.val + b.val);
${hook ? `  if (porf_is_object(a) || porf_is_object(b)) return ${name}_objects(a, b);
` : ''}\
  if (porf_is_strlike(a) || porf_is_strlike(b)) {
    jsval sa = porf_to_str(a);
    volatile u32 keep_sa = porf_gc_type_can_reference(sa.type) ? (u32)sa.val : 0u;
    jsval sb = porf_to_str(b);
    (void)keep_sa;
    return porf_str_concat(sa, sb);
  }
${bigintUsed ? `  if (a.type == ${TYPES.bigint} || b.type == ${TYPES.bigint}) return porf_bigint_arith(0, a, b);
` : ''}\
  return porf_box_num(porf_to_num(a) + porf_to_num(b));
}
`).join('')}
// numeric -, *, / on two unknown-typed operands: a single combined both-number fast-path (one
// hoistable/unswitchable condition) rather than two independent porf_to_num branches.
${sti}jsval porf_sub(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b)) return porf_box_num(a.val - b.val);
  return porf_box_num(porf_to_num(a) - porf_to_num(b));
}
${sti}jsval porf_mul(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b)) return porf_box_num(a.val * b.val);
  return porf_box_num(porf_to_num(a) * porf_to_num(b));
}
${sti}jsval porf_div(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b)) return porf_box_num(a.val / b.val);
  return porf_box_num(porf_to_num(a) / porf_to_num(b));
}

// JS abstract relational comparison: -1/0/1, 2 = unordered (NaN involved).
// numeric coercion, or lexicographic when both sides are strings.
// twin helper: dies when string.ts/coercion builtins port (step 3).
PORF_NOINLINE ${st}i32 porf_cmp_slow(jsval a, jsval b);
// two numbers compared inline everywhere; the rest (objects, BigInts, strings) out of line
${sti}i32 porf_cmp(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b)) {
    const f64 x = a.val, y = b.val;
    if (x != x || y != y) return 2;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return porf_cmp_slow(a, b);
}
PORF_NOINLINE ${st}i32 porf_cmp_slow(jsval a, jsval b) {
${toPrimNumber ? `  // IsLessThan: an object operand is a primitive first (hint "number"), the left one first
  if (porf_is_object(a)) a = ${toPrimNumber}(a);
  if (porf_is_object(b)) b = ${toPrimNumber}(b);
` : ''}\
  const i32 ta = porf_jv_type(a), tb = porf_jv_type(b);
${bigintUsed ? `  if (ta == ${TYPES.bigint}) return porf_bigint_cmp_any(a, b);
  if (tb == ${TYPES.bigint}) {
    const i32 c = porf_bigint_cmp_any(b, a);
    return c == 2 ? 2 : -c;
  }
` : ''}\
  if ((ta == ${TYPES.bytestring} || ta == ${TYPES.string}) && (tb == ${TYPES.bytestring} || tb == ${TYPES.string})) {
${ropes ? `    a = porf_str_flat(a);
    b = porf_str_flat(b);
` : ''}    // by UTF-16 code unit: a one-byte string's bytes are its code units
    return porf_str_order((u32)a.val, ta == ${TYPES.string}, (u32)b.val, tb == ${TYPES.string});
  }
  const f64 x = porf_to_num(a), y = porf_to_num(b);
  if (x != x || y != y) return 2;
  return x < y ? -1 : x > y ? 1 : 0;
}

// loose ==: common matrix (num/num, str/str, bool->num, null<->undefined);
// str<->num coercion arrives with the ToNumber builtin port
${[ [ 'porf_loose_eq', toNum, toPrimDefault ], [ 'porf_loose_eq_plain', null, null ] ].map(([ name, num, prim ]) => `${num ? `${st}i32 ${name}_numeric(jsval a, jsval b);
` : ''}${prim ? `${st}i32 ${name}_object(jsval a, jsval b);
` : ''}${sti}i32 ${name}(jsval a, jsval b) {
  const i32 ta = porf_jv_type(a), tb = porf_jv_type(b);
  if (ta == ${TYPES.number} && tb == ${TYPES.number}) return a.val == b.val;
  const int an = ta == ${TYPES.undefined} || (ta == ${TYPES.object} && (u32)a.val == 0);
  const int bn = tb == ${TYPES.undefined} || (tb == ${TYPES.object} && (u32)b.val == 0);
  if (an || bn) return an && bn;
${bigintUsed ? `  if (ta == ${TYPES.bigint} || tb == ${TYPES.bigint}) {
    // by value against a BigInt, Number, Boolean or String; an object never equals one here
    const jsval big = ta == ${TYPES.bigint} ? a : b, other = ta == ${TYPES.bigint} ? b : a;
    const i32 to = porf_jv_type(other);
    if (to != ${TYPES.bigint} && to != ${TYPES.number} && to != ${TYPES.boolean} && to != ${TYPES.bytestring} && to != ${TYPES.string}) return 0;
    return porf_bigint_cmp_any(big, other) == 0;
  }
` : ''}\
  if ((ta == ${TYPES.bytestring} || ta == ${TYPES.string}) && (tb == ${TYPES.bytestring} || tb == ${TYPES.string}))
    return porf_str_eq(a, b);
${num ? `  // a string and a number: the string as a number (ToNumber, out of line)
  if (((ta == ${TYPES.bytestring} || ta == ${TYPES.string}) && tb == ${TYPES.number}) ||
      (ta == ${TYPES.number} && (tb == ${TYPES.bytestring} || tb == ${TYPES.string}))) return ${name}_numeric(a, b);
` : `  // (a string and a number: only the empty string is known to be 0 here)
  if ((ta == ${TYPES.bytestring} || ta == ${TYPES.string}) && tb == ${TYPES.number})
    return b.val == 0.0 && ((u32)a.val == 0u || *(u32*)(MEM + (u32)a.val) == 0u);
  if (ta == ${TYPES.number} && (tb == ${TYPES.bytestring} || tb == ${TYPES.string}))
    return a.val == 0.0 && ((u32)b.val == 0u || *(u32*)(MEM + (u32)b.val) == 0u);
`}\
  if (ta == ${TYPES.boolean}) return ${name}(porf_box_num((f64)(u32)a.val), b);
  if (tb == ${TYPES.boolean}) return ${name}(a, porf_box_num((f64)(u32)b.val));
${prim ? `  // an object and a primitive: the object as a primitive, hint "default" (out of line)
  if (porf_is_object(a) != porf_is_object(b)) return ${name}_object(a, b);
` : ''}\
  return porf_jv_eq(a, b);
}
${num ? `PORF_NOINLINE ${st}i32 ${name}_numeric(jsval a, jsval b) {
  const f64 x = porf_jv_is_num(a) ? a.val : ${num}(a).val;
  const f64 y = porf_jv_is_num(b) ? b.val : ${num}(b).val;
  return x == y;
}
` : ''}${prim ? `PORF_NOINLINE ${st}i32 ${name}_object(jsval a, jsval b) {
  return porf_is_object(a) ? ${name}(${prim}(a), b) : ${name}(a, ${prim}(b));
}
` : ''}`).join('')}
// === : numbers as f64, strings by content, else identity
${sti}i32 porf_strict_eq(jsval a, jsval b) {
  if (porf_jv_is_num(a)) return porf_jv_is_num(b) && a.val == b.val;
  const i32 ta = porf_jv_type(a), tb = porf_jv_type(b);
  if ((ta == ${TYPES.bytestring} || ta == ${TYPES.string}) && (tb == ${TYPES.bytestring} || tb == ${TYPES.string})) return porf_str_eq(a, b);
  if (ta != tb) return 0;
${bigintUsed ? `  if (ta == ${TYPES.bigint}) return porf_bigint_cmp(a, b) == 0;
` : ''}\
  return (u32)a.val == (u32)b.val;
}

static int porf_argc;
static char** porf_argv;
static void porf_init(int argc, char** argv) {
  porf_argc = argc;
  porf_argv = argv;
  porf_arena_init();
}

`;
};

// settleAsyncResult(value, promise): C resolving promise with value (a thenable's then called)
const CORO_RUNTIME = settleAsyncResult => `// ---- coroutines (fiber stacks) ----
#if defined(__wasip3__) && PORF_STACKFUL
// WASI P3: wasm cannot switch C stacks itself, so each coroutine is a component-model
// cooperative thread (the host switches) with its own shadow stack. With none stackful,
// the stand-ins below: no thread builtin is referenced, and the component needs none
#define PORF_CORO_USE_P3 1
#define PORF_CORO_USE_UCONTEXT 0
#elif defined(__wasi__)
// WASI before P3, or P3 with every coroutine stackless: wasm cannot switch C stacks, and
// there are no threads to switch to (or none wanted). The ucontext path compiles against
// these stand-ins, so a program whose stackful coroutines never run (the iterator helpers
// reference them) builds; starting one aborts with this message.
#define PORF_CORO_USE_P3 0
#define PORF_CORO_USE_UCONTEXT 1
typedef struct { void* ss_sp; size_t ss_size; } porf_no_stack_t;
typedef struct porf_no_ucontext { porf_no_stack_t uc_stack; struct porf_no_ucontext* uc_link; } ucontext_t;
static void porf_no_coroutines(void) {
  fputs("porffor: generators and awaits need coroutines, which on wasm need WASI P3 (target wasm32-wasip3)\\n", stderr);
  abort();
}
static int getcontext(ucontext_t* c) { (void)c; porf_no_coroutines(); return -1; }
static void makecontext(ucontext_t* c, void (*fn)(void), int argc, ...) { (void)c; (void)fn; (void)argc; porf_no_coroutines(); }
static int swapcontext(ucontext_t* a, const ucontext_t* b) { (void)a; (void)b; porf_no_coroutines(); return -1; }
static int setcontext(const ucontext_t* c) { (void)c; porf_no_coroutines(); return -1; }
#elif defined(__TINYC__) || (!defined(__x86_64__) && !defined(__aarch64__))
#define PORF_CORO_USE_P3 0
#define PORF_CORO_USE_UCONTEXT 1
#include <ucontext.h>
#else
#define PORF_CORO_USE_P3 0
#define PORF_CORO_USE_UCONTEXT 0
#endif

#if PORF_CORO_USE_P3
__attribute__((__import_module__("$root"), __import_name__("[thread-index]")))
extern u32 porf_p3_thread_index(void);
__attribute__((__import_module__("$root"), __import_name__("[thread-new-indirect-v0]")))
extern u32 porf_p3_thread_new_indirect(void (*start)(void*), void* arg);
__attribute__((__import_module__("$root"), __import_name__("[thread-suspend-then-resume]")))
extern u32 porf_p3_thread_suspend_then_resume(u32 thread);
__attribute__((__import_module__("$root"), __import_name__("[thread-resume-later]")))
extern void porf_p3_thread_resume_later(u32 thread);
// the stack pointer is per thread on P3, behind these linker-made accessors; a new
// thread starts without one
extern void __wasm_set_stack_pointer(void* sp);
// so is the TLS base (wasi-libc's errno, stdio's stream state, ...). Coroutines are
// cooperative, never running at once, so they share their creator's TLS as native
// coroutines share their thread's; a thread left without one reads TLS from address 0
extern void __wasm_set_tls_base(void* base);
extern void* __wasm_get_tls_base(void);
static void* porf_coro_p3_tls = NULL;
#ifdef PORF_CORO_TRACE
#define PORF_CT(what, c, t) fprintf(stderr, "[coro] %s c=%p tid=%u caller=%u on=%u\\n", what, (void*)(c), (unsigned)(c)->tid, (unsigned)(t), (unsigned)porf_p3_thread_index())
#else
#define PORF_CT(what, c, t) ((void)0)
#endif
#endif

#ifndef PORF_CORO_STACK_SIZE
#if PORF_CORO_USE_P3
// no guard page under P3: an overflow overwrites memory before the canary is checked,
// so room for deep recursion
#define PORF_CORO_STACK_SIZE (1024u * 1024u)
#else
#define PORF_CORO_STACK_SIZE (256u * 1024u)
#endif
#endif
#define PORF_CORO_P3_CANARY 0x504f5246434f524full // bottom-of-stack marker (P3: no guard page)
// the region reserved under each P3 coroutine stack, which PORF_STACK_CHECK watches
#if defined(__wasm__) && !defined(PORF_NO_STACK_CHECK)
#define PORF_STACK_GUARD (64u * 1024u)
#else
#define PORF_STACK_GUARD 0u
#endif
#define PORF_CORO_MAX 16384

typedef struct porf_coro {
  char* stack_map;        // mmap reservation, including the low guard page
  size_t stack_map_size;
  char* stack_lo;         // first usable byte, above the guard page
  char* stack_top;        // high end of the downward-growing usable stack
  char* sp;               // saved stack pointer for GC while suspended
  char* caller_sp;        // inactive caller stack lower bound while running
  void* caller_stack_top;
  u32 gc_walk;            // the collection that last walked it (porf_gc_mark_coro_roots)
#if PORF_CORO_USE_UCONTEXT
  ucontext_t ctx;
  ucontext_t caller_ctx;
  void (*fn)(void*);
  void* arg;
  i32 ctx_init;
#elif PORF_CORO_USE_P3
  u32 tid;                // this coroutine's thread
  u32 caller_tid;         // the thread that last started or resumed it
  u32 caller_stack_limit; // the caller's stack limit and floor, restored when the coroutine
  u32 caller_stack_floor; // yields back
  void (*fn)(void*);
  void* arg;
  i32 escaped;            // an exception left the body: rethrown on the caller's thread
  // each coroutine thread has its own try stack: a jmp_buf only works on its thread, and
  // a coroutine's entries are restored at fixed indexes, so sharing one stack lets a
  // coroutine resumed from a deeper try overwrite its resumer's entries
  jmp_buf* own_try_data;
  i32 own_try_cap;
  i32 own_try_depth;
  jmp_buf* caller_try_data;
  i32 caller_try_cap;
  i32 caller_try_depth;
#else
  jmp_buf resume_pt;      // inside the coroutine, at the await/yield
  jmp_buf caller_pt;      // latest frame that ran/resumed it
#endif
  jsval channel;          // value (or thrown exception) crossing the boundary
  i32 state;              // 0 idle, 1 running, 2 suspended, 3 done
  i32 awaiting;           // suspended at an await (channel: the promise), not a yield
  i32 throw_pending;      // resume delivers channel as a throw at the await
  i32 entry_try_depth;    // porf_try_depth when the coroutine started
  i32 saved_try_depth;    // porf_try_depth at suspension
  jmp_buf* try_save;      // try-stack entries [entry..saved) opened inside
  i32 try_save_cap;
  i32 live_idx;           // index in porf_coro_live, or -1 if not tracked
  struct porf_coro* parent;
} porf_coro;

typedef struct porf_coro_call {
  porf_coro coro;
  u32 idx;
  jsval callee;
  u32 env;
  jsval thisv;
  jsval newtv;
  i32 argc;
  jsbits* argv;
  jsval result;
  i32 started;
  u32 box_body;
  i32 box_type;
  i32 sl;                 // stackless: runs as sl_step over sl_frame, never on a stack of its own
  void* sl_frame;
  u32 sl_frame_size;
  i32 (*sl_step)(struct porf_coro_call* call, jsval in, i32 is_throw);
} porf_coro_call;

// the call a stackless function's starter takes its frame for (set just before porf_invoke)
static porf_coro_call* porf_sl_starting = 0;

// a stackless await's operand: a promise as it is, a primitive as it is (porf_promise_attach_coro
// queues its resume as the reaction of a promise fulfilled with it would be, from a microtask,
// with no promise made), an object a promise resolved with it (a thenable's then is called)
static jsval porf_sl_promise(jsval v) {
  const i32 t = porf_jv_type(v);
  if (t == ${TYPES.promise} || t <= ${TYPES.symbol} || t == ${TYPES.string} || t == ${TYPES.bytestring} ||
      (t == ${TYPES.object} && (u32)v.val == 0u)) return v;
  const u32 p = porf_alloc(PORF_PROMISE_SIZE, ${TYPES.promise});
  *(jsbits*)(MEM + p + PORF_PROMISE_RESULT) = JV_UNDEFINED_BITS;
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_TAIL) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_TAIL) = 0;
  *(jsbits*)(MEM + p + PORF_PROMISE_PAYLOAD) = JV_UNDEFINED_BITS;
  *(u8*)(MEM + p + PORF_PROMISE_STATE) = 0;
  *(u8*)(MEM + p + PORF_PROMISE_FLAGS) = 0;
  *(u8*)(MEM + p + PORF_PROMISE_HANDLED) = 0;
  const jsval promise = porf_box((f64)p, ${TYPES.promise});
  ${settleAsyncResult('v', 'promise')}
  return promise;
}

static porf_coro* porf_coro_cur = 0;
#define PORF_CORO_RETURN porf_box(0.0, ${TYPES.__porffor_generator})
static u32 porf_coro_gc_walk_epoch = 0;
static porf_coro* porf_coro_live[PORF_CORO_MAX];
static i32 porf_coro_live_len = 0;

static jsval porf_promise_pending(void) {
  const u32 p = porf_alloc(PORF_PROMISE_SIZE, ${TYPES.promise});
  *(jsbits*)(MEM + p + PORF_PROMISE_RESULT) = JV_UNDEFINED_BITS;
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_TAIL) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_TAIL) = 0;
  *(jsbits*)(MEM + p + PORF_PROMISE_PAYLOAD) = JV_UNDEFINED_BITS;
  *(u8*)(MEM + p + PORF_PROMISE_STATE) = 0;
  *(u8*)(MEM + p + PORF_PROMISE_FLAGS) = 0;
  *(u8*)(MEM + p + PORF_PROMISE_HANDLED) = 0;
  return porf_box((f64)p, ${TYPES.promise});
}

static void porf_promise_trigger_reactions(u32 reaction, jsval value) {
  while (reaction != 0) {
    const u32 next = *(u32*)(MEM + reaction + PORF_REACTION_NEXT);
    *(u32*)(MEM + reaction + PORF_REACTION_NEXT) = 0;
    *(jsbits*)(MEM + reaction + PORF_REACTION_VALUE) = porf_pack(value);
    porf_gc_barrier(reaction, PORF_GC_KIND_PROMISE_REACTION);
    porf_promise_enqueue_job(reaction);
    reaction = next;
  }
}

static void porf_promise_settle_direct(jsval promise, jsval value, i32 state) {
  if (promise.type != ${TYPES.promise}) return;
  const u32 p = (u32)promise.val;
  if (*(u8*)(MEM + p + PORF_PROMISE_STATE) != 0) return;
  const u32 reactions = *(u32*)(MEM + p + (state == 1 ? PORF_PROMISE_FULFILL_HEAD : PORF_PROMISE_REJECT_HEAD));
  *(jsbits*)(MEM + p + PORF_PROMISE_RESULT) = porf_pack(value);
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_FULFILL_TAIL) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_HEAD) = 0;
  *(u32*)(MEM + p + PORF_PROMISE_REJECT_TAIL) = 0;
  *(u8*)(MEM + p + PORF_PROMISE_STATE) = (u8)state;
  porf_gc_barrier(p, ${TYPES.promise});
  porf_promise_trigger_reactions(reactions, value);
}

static u32 porf_promise_new_coro_reaction(porf_coro_call* call, jsval out_promise, i32 is_throw) {
  const u32 reaction = porf_alloc(PORF_REACTION_SIZE, 0);
  *(u64*)(MEM + reaction + PORF_REACTION_HANDLER) = (u64)(uintptr_t)call;
  *(jsbits*)(MEM + reaction + PORF_REACTION_OUT_PROMISE) = porf_pack(out_promise);
  *(jsbits*)(MEM + reaction + PORF_REACTION_VALUE) = JV_UNDEFINED_BITS;
  *(u32*)(MEM + reaction + PORF_REACTION_NEXT) = 0;
  *(u32*)(MEM + reaction + PORF_REACTION_PAYLOAD) = (u32)is_throw;
  *(u8*)(MEM + reaction + PORF_REACTION_KIND) = 11;
  *(u8*)(MEM + reaction + PORF_REACTION_FLAGS) = 0;
  *(jsbits*)(MEM + reaction + PORF_REACTION_CONTEXT) = porf_async_context;
  porf_gc_barrier(reaction, PORF_GC_KIND_PROMISE_REACTION);
  return reaction;
}

static void porf_promise_append_raw_reaction(u32 promise, u32 reaction, i32 reject) {
  const u32 head_off = reject ? PORF_PROMISE_REJECT_HEAD : PORF_PROMISE_FULFILL_HEAD;
  const u32 tail_off = reject ? PORF_PROMISE_REJECT_TAIL : PORF_PROMISE_FULFILL_TAIL;
  const u32 tail = *(u32*)(MEM + promise + tail_off);
  if (tail == 0) {
    *(u32*)(MEM + promise + head_off) = reaction;
  } else {
    *(u32*)(MEM + tail + PORF_REACTION_NEXT) = reaction;
    porf_gc_barrier(tail, PORF_GC_KIND_PROMISE_REACTION);
  }
  *(u32*)(MEM + promise + tail_off) = reaction;
  porf_gc_barrier(promise, ${TYPES.promise});
}

static void porf_promise_attach_coro(jsval awaited, porf_coro_call* call, jsval out_promise) {
  // not a promise: resumed with it from a microtask, as from a promise already fulfilled with it
  if (awaited.type != ${TYPES.promise}) {
    porf_promise_trigger_reactions(porf_promise_new_coro_reaction(call, out_promise, 0), awaited);
    return;
  }
  const u32 p = (u32)awaited.val;
  *(u8*)(MEM + p + PORF_PROMISE_HANDLED) = 1;
  // already settled (a stackless await always suspends): its reaction is queued now
  const u8 state = *(u8*)(MEM + p + PORF_PROMISE_STATE);
  if (state != 0) {
    porf_promise_trigger_reactions(porf_promise_new_coro_reaction(call, out_promise, state == 2),
      porf_unpack(*(jsbits*)(MEM + p + PORF_PROMISE_RESULT)));
    return;
  }
  porf_promise_append_raw_reaction(p, porf_promise_new_coro_reaction(call, out_promise, 0), 0);
  porf_promise_append_raw_reaction(p, porf_promise_new_coro_reaction(call, out_promise, 1), 1);
}

static void porf_coro_prologue(void) {
  // stack selection happens at coroutine entry; the compiled body stays plain C.
}

static size_t porf_coro_page_size(void) {
  const long p = sysconf(_SC_PAGESIZE);
  return p > 0 ? (size_t)p : 4096u;
}

static char* porf_coro_read_sp(void) {
  void* sp;
#if !PORF_CORO_USE_UCONTEXT && defined(__x86_64__)
  __asm__ volatile("mov %%rsp, %0" : "=r"(sp));
#elif !PORF_CORO_USE_UCONTEXT && defined(__aarch64__)
  __asm__ volatile("mov %0, sp" : "=r"(sp));
#else
  char probe;
  sp = &probe;
#endif
  return (char*)sp;
}

static inline char* porf_coro_align_lo(char* p) {
  return (char*)(((uintptr_t)p + 7u) & ~(uintptr_t)7u);
}

static inline char* porf_coro_align_hi(char* p) {
  return (char*)((uintptr_t)p & ~(uintptr_t)7u);
}

static inline void* porf_coro_current_stack_top(void) {
#if PORF_GC_ENABLED
  return porf_c_stack_top;
#else
  return 0;
#endif
}

static inline void porf_coro_set_current_stack_top(void* top) {
#if PORF_GC_ENABLED
  porf_c_stack_top = top;
#else
  (void)top;
#endif
}

typedef struct porf_coro_stack_pool_entry {
  char* stack_map;
  size_t stack_map_size;
  char* stack_lo;
  char* stack_top;
} porf_coro_stack_pool_entry;

#define PORF_CORO_STACK_POOL_MAX 8192
static porf_coro_stack_pool_entry porf_coro_stack_pool[PORF_CORO_STACK_POOL_MAX];
static i32 porf_coro_stack_pool_len = 0;

static void porf_coro_stack_ensure(porf_coro* c) {
  if (c->stack_top) return;
  if (porf_coro_stack_pool_len > 0) {
    porf_coro_stack_pool_entry e = porf_coro_stack_pool[--porf_coro_stack_pool_len];
    c->stack_map = e.stack_map;
    c->stack_map_size = e.stack_map_size;
    c->stack_lo = e.stack_lo;
    c->stack_top = e.stack_top;
    c->sp = 0;
    return;
  }
#if PORF_CORO_USE_P3
  // no mprotect on WASI: a plain allocation, with a guard region below the stack that
  // nothing else can be allocated in (PORF_STACK_CHECK traps on reaching it)
  char* block = (char*)malloc((size_t)PORF_CORO_STACK_SIZE + PORF_STACK_GUARD);
  if (!block) {
    porf_err("porffor: failed to allocate coroutine stack\\n");
    abort();
  }
  c->stack_map = block;
  c->stack_map_size = (size_t)PORF_CORO_STACK_SIZE + PORF_STACK_GUARD;
  c->stack_lo = block + PORF_STACK_GUARD;
  c->stack_top = (char*)(((uintptr_t)c->stack_lo + (size_t)PORF_CORO_STACK_SIZE) & ~(uintptr_t)15u);
  c->sp = 0;
  *(u64*)c->stack_lo = PORF_CORO_P3_CANARY;
  return;
#endif
  const size_t page = porf_coro_page_size();
  const size_t usable = ((size_t)PORF_CORO_STACK_SIZE + page - 1u) & ~(page - 1u);
  const size_t map_size = usable + page;
  void* mem = mmap(NULL, map_size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (mem == MAP_FAILED) {
    porf_err("porffor: failed to reserve coroutine stack\\n");
    abort();
  }
  char* lo = (char*)mem + page;
  if (mprotect(lo, usable, PROT_READ | PROT_WRITE) != 0) {
    munmap(mem, map_size);
    porf_err("porffor: failed to commit coroutine stack\\n");
    abort();
  }
  c->stack_map = (char*)mem;
  c->stack_map_size = map_size;
  c->stack_lo = lo;
  c->stack_top = lo + usable;
  c->sp = 0;
}

static void porf_coro_stack_free(porf_coro* c) {
  if (c->stack_map) {
    if (porf_coro_stack_pool_len < PORF_CORO_STACK_POOL_MAX) {
      porf_coro_stack_pool_entry e;
      e.stack_map = c->stack_map;
      e.stack_map_size = c->stack_map_size;
      e.stack_lo = c->stack_lo;
      e.stack_top = c->stack_top;
      porf_coro_stack_pool[porf_coro_stack_pool_len++] = e;
    } else {
#if PORF_CORO_USE_P3
      free(c->stack_map);
#else
      munmap(c->stack_map, c->stack_map_size);
#endif
    }
    c->stack_map = 0;
    c->stack_map_size = 0;
    c->stack_lo = 0;
    c->stack_top = 0;
    c->sp = 0;
  }
  free(c->try_save);
  c->try_save = 0;
  c->try_save_cap = 0;
#if PORF_CORO_USE_P3
  free(c->own_try_data);
  c->own_try_data = 0;
  c->own_try_cap = 0;
  c->own_try_depth = 0;
#endif
}

static void porf_coro_live_add(porf_coro* c) {
  if (c->live_idx >= 0) return;
  if (porf_coro_live_len < PORF_CORO_MAX) {
    c->live_idx = porf_coro_live_len;
    porf_coro_live[porf_coro_live_len++] = c;
  }
}

static void porf_coro_live_remove(porf_coro* c) {
  const i32 idx = c->live_idx;
  if (idx < 0) return;
  const i32 last = --porf_coro_live_len;
  porf_coro* moved = porf_coro_live[last];
  porf_coro_live[idx] = moved;
  moved->live_idx = idx;
  c->live_idx = -1;
}

#define PORF_CORO_CALL_POOL_MAX 8192
static porf_coro_call* porf_coro_call_pool[PORF_CORO_CALL_POOL_MAX];
static i32 porf_coro_call_pool_len = 0;

static porf_coro_call* porf_coro_call_alloc(void) {
  porf_coro_call* call;
  if (porf_coro_call_pool_len > 0) {
    call = porf_coro_call_pool[--porf_coro_call_pool_len];
    memset(call, 0, sizeof(*call));
  } else {
    call = calloc(1, sizeof(porf_coro_call));
    if (!call) abort();
  }
  return call;
}

static void porf_coro_call_free(porf_coro_call* call) {
  if (!call) return;
#if defined(PORF_CORO_TRACE) && PORF_CORO_USE_P3
  fprintf(stderr, "[coro] free c=%p tid=%u state=%d on=%u\\n", (void*)&call->coro, (unsigned)call->coro.tid, (int)call->coro.state, (unsigned)porf_p3_thread_index());
#endif
  porf_coro_live_remove(&call->coro);
  porf_coro_stack_free(&call->coro);
  free(call->argv);
  free(call->sl_frame);
  if (porf_coro_call_pool_len < PORF_CORO_CALL_POOL_MAX) {
    porf_coro_call_pool[porf_coro_call_pool_len++] = call;
  } else {
    free(call);
  }
}

#if PORF_GC_ENABLED
static void porf_coro_gc_scan_mem(const void* lo0, const void* hi0) {
  char* lo = porf_coro_align_lo((char*)lo0);
  char* hi = porf_coro_align_hi((char*)hi0);
  if (lo < hi) porf_gc_cons_scan_range((const u64*)lo, (const u64*)hi);
}

static void porf_coro_gc_scan_stack(porf_coro* c, char* sp) {
  if (!c || !sp || !c->stack_top) return;
  porf_coro_gc_scan_mem(sp, c->stack_top);
}

static void porf_coro_gc_scan_saved_context(porf_coro* c) {
#if PORF_CORO_USE_UCONTEXT
  porf_coro_gc_scan_mem(&c->ctx, (const char*)&c->ctx + sizeof(c->ctx));
#elif PORF_CORO_USE_P3
  (void)c; // the host keeps a suspended thread's state; its shadow stack is scanned by sp
#else
  porf_coro_gc_scan_mem(&c->resume_pt, (const char*)&c->resume_pt + sizeof(c->resume_pt));
#endif
}

static void porf_coro_gc_scan_caller_context(porf_coro* c) {
#if PORF_CORO_USE_UCONTEXT
  porf_coro_gc_scan_mem(&c->caller_ctx, (const char*)&c->caller_ctx + sizeof(c->caller_ctx));
#elif PORF_CORO_USE_P3
  (void)c;
#else
  porf_coro_gc_scan_mem(&c->caller_pt, (const char*)&c->caller_pt + sizeof(c->caller_pt));
#endif
}

static void porf_coro_gc_mark_call_fields(porf_coro_call* call, i32 mark_box) {
  if (!call) return;
  if (mark_box && call->box_body) porf_gc_mark_js((f64)call->box_body, call->box_type);
  porf_gc_mark_js(call->callee.val, call->callee.type);
  porf_gc_mark_js(call->thisv.val, call->thisv.type);
  porf_gc_mark_js(call->newtv.val, call->newtv.type);
  porf_gc_mark_js(call->result.val, call->result.type);
  porf_gc_mark_js(call->coro.channel.val, call->coro.channel.type);
  // a stackless call's locals live in its frame: scanned as a stack would be
  if (call->sl_frame) porf_coro_gc_scan_mem(call->sl_frame, (const char*)call->sl_frame + call->sl_frame_size);
  for (i32 i = 0; i < call->argc; i++) {
    const jsval v = porf_unpack(call->argv[i]);
    porf_gc_mark_js(v.val, v.type);
  }
}

static void porf_coro_gc_mark_suspended(porf_coro* c, i32 mark_box) {
  porf_coro_gc_mark_call_fields((porf_coro_call*)c, mark_box);
  if (c->sp) porf_coro_gc_scan_stack(c, c->sp);
  porf_coro_gc_scan_saved_context(c);
  if (c->try_save && c->saved_try_depth > c->entry_try_depth)
    porf_coro_gc_scan_mem(c->try_save, (const char*)c->try_save + (size_t)(c->saved_try_depth - c->entry_try_depth) * sizeof(jmp_buf));
}

static void porf_coro_gc_mark_handle(porf_coro_call* call) {
  if (!call) return;
  if (call->coro.state == 2) porf_coro_gc_mark_suspended(&call->coro, 0);
  else porf_coro_gc_mark_call_fields(call, 0);
}

static void porf_coro_gc_mark_active(porf_coro* c) {
  porf_coro_gc_mark_call_fields((porf_coro_call*)c, 1);
  if (c->caller_sp && c->caller_stack_top) porf_coro_gc_scan_mem(c->caller_sp, c->caller_stack_top);
  porf_coro_gc_scan_caller_context(c);
}
#endif

static void porf_coro_save_try_stack(porf_coro* c) {
  c->saved_try_depth = porf_try_depth;
  const i32 try_n = porf_try_depth - c->entry_try_depth;
  if (try_n > 0) {
    if (try_n > c->try_save_cap) {
      free(c->try_save);
      c->try_save = malloc((size_t)try_n * sizeof(jmp_buf));
      if (!c->try_save) abort();
      c->try_save_cap = try_n;
    }
    memcpy(c->try_save, porf_try_data + c->entry_try_depth, (size_t)try_n * sizeof(jmp_buf));
  }
}

static void porf_coro_restore_try_stack(porf_coro* c) {
  const i32 try_n = c->saved_try_depth - c->entry_try_depth;
  c->entry_try_depth = porf_try_depth;
  c->saved_try_depth = porf_try_depth += try_n;
  if (try_n > 0) memcpy(porf_try_ensure() + c->entry_try_depth, c->try_save, (size_t)try_n * sizeof(jmp_buf));
}

static void porf_coro_prepare_run(porf_coro* c) {
  c->caller_sp = porf_coro_read_sp();
  c->caller_stack_top = porf_coro_current_stack_top();
  c->parent = porf_coro_cur;
  porf_coro_cur = c;
  porf_coro_set_current_stack_top(c->stack_top);
}

static void porf_coro_restore_caller(porf_coro* c) {
  porf_coro_set_current_stack_top(c->caller_stack_top);
  porf_coro_cur = c->parent;
  if (c->state == 3) porf_coro_stack_free(c);
}

#if PORF_CORO_USE_P3
// runs on the coroutine's thread. An exception leaving the body cannot longjmp to a try
// on the caller's thread (wasm sjlj unwinds one thread's stack), so it is caught here and
// rethrown by porf_coro_enter/resume on the caller's side.
__attribute__((noinline, used))
void porf_coro_p3_run(porf_coro* c) {
  __wasm_set_tls_base(porf_coro_p3_tls);
  const i32 depth = porf_try_depth++;
  if (_setjmp(porf_try_ensure()[depth]) == 0) {
    c->fn(c->arg);
  } else {
    c->escaped = 1;
    c->channel = porf_exception;
  }
  porf_try_depth = depth;
  c->state = 3;
  porf_coro_set_current_stack_top(c->caller_stack_top);
  PORF_CT("finish", c, c->caller_tid);
  porf_p3_thread_resume_later(c->caller_tid); // the thread ends as this returns
}

// No mprotect on WASI means no guard page: an overflowing coroutine would silently
// overwrite whatever malloc put below its stack. A canary at the bottom turns that into
// an error at the next switch back (build with a larger -DPORF_CORO_STACK_SIZE).
static void porf_coro_p3_check_stack(porf_coro* c) {
  if (c->stack_lo && *(u64*)c->stack_lo != PORF_CORO_P3_CANARY)
    porf_unreachable("coroutine stack overflow (raise PORF_CORO_STACK_SIZE)");
}

// on the caller's thread, around each switch into c: install c's try stack, then the caller's
// room above the stack's bottom for the runtime's and libc's own (unchecked) frames
#define PORF_STACK_MARGIN (16u * 1024u)

static void porf_coro_p3_trys_in(porf_coro* c) {
#if defined(__wasm__) && !defined(PORF_NO_STACK_CHECK)
  c->caller_stack_limit = porf_stack_limit;
  c->caller_stack_floor = porf_stack_floor;
  porf_stack_limit = c->stack_lo ? (u32)(uintptr_t)c->stack_lo + PORF_STACK_MARGIN : 0;
  porf_stack_floor = c->stack_lo ? (u32)(uintptr_t)c->stack_lo - PORF_STACK_GUARD : 0;
#endif
  c->caller_try_data = porf_try_data;
  c->caller_try_cap = porf_try_cap;
  c->caller_try_depth = porf_try_depth;
  porf_try_data = c->own_try_data;
  porf_try_cap = c->own_try_cap;
  porf_try_depth = c->own_try_depth;
}

static void porf_coro_p3_trys_out(porf_coro* c) {
  porf_coro_p3_check_stack(c);
#if defined(__wasm__) && !defined(PORF_NO_STACK_CHECK)
  porf_stack_limit = c->caller_stack_limit;
  porf_stack_floor = c->caller_stack_floor;
#endif
  c->own_try_data = porf_try_data;
  c->own_try_cap = porf_try_cap;
  c->own_try_depth = porf_try_depth;
  porf_try_data = c->caller_try_data;
  porf_try_cap = c->caller_try_cap;
  porf_try_depth = c->caller_try_depth;
}

// The thread's entry. A new thread has no stack pointer yet (it reads as 0), and any C
// function may open a shadow-stack frame in its prologue (at -O0 every one does), so the
// entry is assembly: its argument is the coroutine's stack top, with the coroutine
// pointer stored in the 16 bytes just below it (porf_coro_enter puts it there).
//   sp = top - 16; porf_coro_p3_run(*(porf_coro**)(top - 16))
void porf_coro_p3_start(void* top);
__asm__(
  ".functype __wasm_set_stack_pointer (i32) -> ()\\n"
  ".functype porf_coro_p3_run (i32) -> ()\\n"
  ".globl porf_coro_p3_start\\n"
  ".type porf_coro_p3_start,@function\\n"
  "porf_coro_p3_start:\\n"
  ".functype porf_coro_p3_start (i32) -> ()\\n"
  "  local.get 0\\n"
  "  i32.const 16\\n"
  "  i32.sub\\n"
  "  call __wasm_set_stack_pointer\\n"
  "  local.get 0\\n"
  "  i32.const 16\\n"
  "  i32.sub\\n"
  "  i32.load 0\\n"
  "  call porf_coro_p3_run\\n"
  "  end_function\\n"
);
#endif

#if PORF_CORO_USE_UCONTEXT
static porf_coro* porf_coro_starting = 0;

static void porf_coro_ucontext_bootstrap(void) {
  porf_coro* c = porf_coro_starting;
  porf_coro_starting = 0;
  c->fn(c->arg);
  c->state = 3;
  porf_coro_set_current_stack_top(c->caller_stack_top);
  setcontext(&c->caller_ctx);
  abort();
}
#elif !PORF_CORO_USE_P3
__attribute__((noreturn, noinline))
static void porf_coro_bootstrap(porf_coro* c, void (*fn)(void*), void* arg) {
  fn(arg);
  c->state = 3;
  porf_coro_set_current_stack_top(c->caller_stack_top);
  _longjmp(c->caller_pt, 1);
}

__attribute__((noreturn, noinline))
static void porf_coro_switch_start(char* stack_top, porf_coro* c, void (*fn)(void*), void* arg) {
  uintptr_t sp = (uintptr_t)stack_top & ~(uintptr_t)15u;
#if defined(__x86_64__)
  __asm__ volatile(
    "mov %0, %%rsp\\n"
    "call *%1\\n"
    :
    : "r"(sp), "r"(porf_coro_bootstrap), "D"(c), "S"(fn), "d"(arg)
    : "memory");
#elif defined(__aarch64__)
  __asm__ volatile(
    "mov sp, %0\\n"
    "mov x0, %1\\n"
    "mov x1, %2\\n"
    "mov x2, %3\\n"
    "br %4\\n"
    :
    : "r"(sp), "r"(c), "r"(fn), "r"(arg), "r"(porf_coro_bootstrap)
    : "memory");
#endif
  __builtin_unreachable();
}
#endif

// run fn-with-context as a coroutine; returns 1 if it completed, 0 if it
// suspended. completion leaves through the latest caller context/jump point.
__attribute__((noinline))
static int porf_coro_enter(porf_coro* c, void (*fn)(void*), void* arg) {
  porf_coro_stack_ensure(c);
  c->state = 1;
  c->entry_try_depth = porf_try_depth;
  volatile i32 outer_try = porf_try_depth;
  porf_coro_prepare_run(c);
#if PORF_CORO_USE_UCONTEXT
  c->fn = fn;
  c->arg = arg;
  if (!c->ctx_init) {
    if (getcontext(&c->ctx) != 0) abort();
    c->ctx.uc_stack.ss_sp = c->stack_lo;
    c->ctx.uc_stack.ss_size = (size_t)(c->stack_top - c->stack_lo);
    c->ctx.uc_link = NULL;
    makecontext(&c->ctx, porf_coro_ucontext_bootstrap, 0);
    c->ctx_init = 1;
  }
  porf_coro_starting = c;
  if (swapcontext(&c->caller_ctx, &c->ctx) != 0) abort();
#elif PORF_CORO_USE_P3
  c->fn = fn;
  c->arg = arg;
  c->escaped = 0;
  c->own_try_data = 0;
  c->own_try_cap = 0;
  c->own_try_depth = 0;
  c->caller_tid = porf_p3_thread_index();
  *(porf_coro**)(c->stack_top - 16) = c; // read by porf_coro_p3_start
  porf_coro_p3_tls = __wasm_get_tls_base(); // adopted by porf_coro_p3_run
  c->tid = porf_p3_thread_new_indirect(porf_coro_p3_start, c->stack_top);
  PORF_CT("enter", c, c->caller_tid);
  porf_coro_p3_trys_in(c);
  porf_p3_thread_suspend_then_resume(c->tid);
  porf_coro_p3_trys_out(c);
#else
  if (_setjmp(c->caller_pt) == 0) porf_coro_switch_start(c->stack_top, c, fn, arg);
#endif
  porf_try_depth = outer_try; // suspension left the coroutine's depth active
  porf_coro_restore_caller(c);
#if PORF_CORO_USE_P3
  if (c->escaped) {
    c->escaped = 0;
    porf_throw(c->channel);
  }
#endif
  return c->state == 3;
}

__attribute__((noinline))
static jsval porf_coro_suspend(jsval out) {
  porf_coro* c = porf_coro_cur;
  if (!c) porf_unreachable("await outside coroutine");
  c->channel = out;
#if !PORF_CORO_USE_P3
  porf_coro_save_try_stack(c);
#endif
  porf_coro_live_add(c);
  c->state = 2;
#if PORF_CORO_USE_UCONTEXT
  c->sp = porf_coro_read_sp();
  porf_coro_set_current_stack_top(c->caller_stack_top);
  if (swapcontext(&c->ctx, &c->caller_ctx) != 0) abort();
#elif PORF_CORO_USE_P3
  c->sp = porf_coro_read_sp();
  porf_coro_set_current_stack_top(c->caller_stack_top);
  PORF_CT("suspend", c, c->caller_tid);
  porf_p3_thread_suspend_then_resume(c->caller_tid);
#else
  if (_setjmp(c->resume_pt) == 0) {
    c->sp = porf_coro_read_sp();
    porf_coro_set_current_stack_top(c->caller_stack_top);
    _longjmp(c->caller_pt, 1);
  }
#endif
  // resumed: stack + try entries restored; deliver value or throw
  if (c->throw_pending) {
    c->throw_pending = 0;
    porf_throw(c->channel);
  }
  return c->channel;
}

__attribute__((noinline))
static int porf_coro_resume_inner(porf_coro* c, jsval in, i32 is_throw) {
  if (c->state != 2) porf_unreachable("resume of non-suspended coroutine");
  porf_coro_live_remove(c);
  c->sp = 0;
  c->channel = in;
  c->throw_pending = is_throw;
  c->state = 1;
  volatile i32 my_try = porf_try_depth;
#if !PORF_CORO_USE_P3
  porf_coro_restore_try_stack(c);
#endif
  porf_coro_prepare_run(c);
#if PORF_CORO_USE_UCONTEXT
  if (swapcontext(&c->caller_ctx, &c->ctx) != 0) abort();
#elif PORF_CORO_USE_P3
  c->caller_tid = porf_p3_thread_index();
  PORF_CT("resume", c, c->caller_tid);
  porf_coro_p3_trys_in(c);
  porf_p3_thread_suspend_then_resume(c->tid);
  porf_coro_p3_trys_out(c);
#else
  if (_setjmp(c->caller_pt) == 0) _longjmp(c->resume_pt, 1);
#endif
  porf_try_depth = my_try; // restore resumer's depth (coroutine's was active)
  porf_coro_restore_caller(c);
#if PORF_CORO_USE_P3
  if (c->escaped) {
    c->escaped = 0;
    porf_throw(c->channel);
  }
#endif
  return c->state == 3;
}
static int porf_coro_resume(porf_coro* c, jsval in) { return porf_coro_resume_inner(c, in, 0); }
static int porf_coro_resume_throw(porf_coro* c, jsval err) { return porf_coro_resume_inner(c, err, 1); }

static jsval porf_await(jsval v) {
  if (!porf_coro_cur) return v;
  if (porf_jv_type(v) != ${TYPES.promise}) return v;

  const u32 p = (u32)v.val;
  const u8 state = *(u8*)(MEM + p + PORF_PROMISE_STATE);
  if (state) *(u8*)(MEM + p + PORF_PROMISE_HANDLED) = 1;
  if (state == 1) return porf_unpack(*(jsbits*)(MEM + p + PORF_PROMISE_RESULT));
  if (state == 2) porf_throw(porf_unpack(*(jsbits*)(MEM + p + PORF_PROMISE_RESULT)));

  porf_coro_cur->awaiting = 1;
  return porf_coro_suspend(v);
}
static jsval porf_yield(jsval v) {
  if (porf_coro_cur) porf_coro_cur->awaiting = 0;
  return porf_coro_suspend(v);
}

`;
