// Native host: the process over libuv: its arguments, environment, working directory,
// platform, standard input and output, exit, and the machine (uv_os_*, uv_cpu_info, memory,
// uv_hrtime). runtime/host/wasi/process.mjs is the same over wasi-libc.
import { takeCString } from '../c.mjs';

Porffor.c`
#include <uv.h>

// a string libuv writes into a buffer it sizes (uv_cwd, uv_os_homedir...): the call, with a
// larger buffer when it asks for one. malloc'd (or NULL), its length in *len
typedef int (*porf_uv_str_fn)(char *buf, size_t *size);
static char *porf_uv_str(porf_uv_str_fn fn, size_t *len) {
  size_t size = 256;
  char *buf = malloc(size);
  int rc = fn(buf, &size);
  if (rc == UV_ENOBUFS) {
    buf = realloc(buf, size + 1);
    rc = fn(buf, &size);
  }
  if (rc < 0) { free(buf); return NULL; }
  *len = size;
  return buf;
}
`;

export const isTTY = (fd) => {
	let out = 0;
	Porffor.c`${out} = uv_guess_handle((int)PORF_NUM(${fd})) == UV_TTY;`;
	return out !== 0;
};

export const argCount = () => {
	let out = 0;
	Porffor.c`${out} = porf_argc;`;
	return out;
};

export const arg = (argIndex) => {
	let len = 0;
	Porffor.c`${len} = strlen(porf_argv[(i32)${argIndex}.val]);`;

	const out = Porffor.malloc(len + 6);
	Porffor.c`u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val; *((i32*)(MEM + out_ptr)) = (i32)${len}; memcpy(MEM + out_ptr + 4, porf_argv[(i32)${argIndex}.val], (size_t)${len}); *(MEM + out_ptr + 4 + (i32)${len}) = 0;`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

export const platform = () => {
	let len = 5;
	Porffor.c`
#ifdef __APPLE__
  ${len} = 6;
#elif defined(_WIN32)
  ${len} = 5;
#elif defined(__wasi__)
  ${len} = 4;
#else
  ${len} = 5;
#endif
`;

	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
#ifdef __APPLE__
  *((i32*)(MEM + out_ptr)) = 6; memcpy(MEM + out_ptr + 4, "darwin", 6); *(MEM + out_ptr + 10) = 0;
#elif defined(_WIN32)
  *((i32*)(MEM + out_ptr)) = 5; memcpy(MEM + out_ptr + 4, "win32", 5); *(MEM + out_ptr + 9) = 0;
#elif defined(__wasi__)
  *((i32*)(MEM + out_ptr)) = 4; memcpy(MEM + out_ptr + 4, "wasi", 4); *(MEM + out_ptr + 8) = 0;
#else
  *((i32*)(MEM + out_ptr)) = 5; memcpy(MEM + out_ptr + 4, "linux", 5); *(MEM + out_ptr + 9) = 0;
#endif
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

export const readLine = () => {
	let len = -1;
	Porffor.c`
char line[8192];
if (fgets(line, sizeof(line), stdin) != NULL) ${len} = strlen(line);
`;
	if (len < 0) return undefined;

	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
*((i32*)(MEM + out_ptr)) = (i32)${len};
memcpy(MEM + out_ptr + 4, line, (size_t)${len});
*(MEM + out_ptr + 4 + (i32)${len}) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

export const write = (value) => {
	Porffor.printString(value);
	Porffor.c`fflush(stdout);`;
};

// a write of a string (as UTF-8) or a typed array's bytes to standard output (fd 1) or error
// (fd 2), flushed: process.stdout.write / process.stderr.write
export const writeTo = (fd, value) => {
	const valueType = Porffor.type(value);
	Porffor.c`
{
size_t len;
char *bytes = __porffor_bytes(MEM, ${value}, (i32)${valueType}.val, &len);
FILE *file = (int)PORF_NUM(${fd}) == 2 ? stderr : stdout;
fwrite(bytes, 1, len, file);
fflush(file);
free(bytes);
}
`;
};

export const exit = (code = 0) => {
	Porffor.c`exit((int)${code}.val);`;
};

export const cwd = () => {
	let len = 0;
	let buf = 0;
	Porffor.c`
size_t n = 0;
char *s = porf_uv_str(uv_cwd, &n);
${len} = s ? (f64)n : 0;
${buf} = (f64)(u64)s;
`;
	return takeCString(len, buf);
};

// 0 or the error (libuv's code)
export const chdir = (path) => {
	const pathType = Porffor.type(path);
	let err = 0;
	Porffor.c`
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
${err} = uv_chdir(path_ptr);
if (path_owned) free(path_owned);
`;
	return err;
};

// the environment's count, then each entry "KEY=value" (uv_os_environ, taken once per env())
const envCount = () => {
	let n = 0;
	Porffor.c`
uv_env_item_t *items;
int count;
if (uv_os_environ(&items, &count) == 0) {
  ${n} = count;
  uv_os_free_environ(items, count);
}
`;
	return n;
};

const envEntry = (index) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
uv_env_item_t *items;
int count;
if (uv_os_environ(&items, &count) == 0) {
  const int i = (int)PORF_NUM(${index});
  if (i < count) {
    const size_t kl = strlen(items[i].name), vl = strlen(items[i].value);
    char *s = malloc(kl + vl + 2);
    memcpy(s, items[i].name, kl);
    s[kl] = '=';
    memcpy(s + kl + 1, items[i].value, vl + 1);
    ${len} = (f64)(kl + vl + 1);
    ${buf} = (f64)(u64)s;
  }
  uv_os_free_environ(items, count);
}
`;
	return takeCString(len, buf);
};

export const env = () => {
	const out = {};
	const n = envCount();
	for (let i = 0; i < n; i++) {
		const entry = envEntry(i);
		const eq = entry.indexOf('=');
		if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return out;
};

// one environment variable, undefined when it is not set
export const getenv = (name) => {
	const nameType = Porffor.type(name);
	let len = -1;
	let buf = 0;
	Porffor.c`
char *name_owned;
char *name_ptr = __porffor_node_cstr(MEM, ${name}, (i32)${nameType}.val, &name_owned);
size_t size = 256;
char *value = malloc(size);
int rc = uv_os_getenv(name_ptr, value, &size);
if (rc == UV_ENOBUFS) {
  value = realloc(value, size + 1);
  rc = uv_os_getenv(name_ptr, value, &size);
}
if (rc == 0) {
  ${len} = (f64)size;
  ${buf} = (f64)(u64)value;
} else {
  free(value);
}
if (name_owned) free(name_owned);
`;
	if (len < 0) return undefined;
	return takeCString(len, buf);
};

// value undefined: unset
export const setenv = (name, value) => {
	const nameType = Porffor.type(name);
	const valueType = Porffor.type(value);
	Porffor.c`
char *name_owned, *value_owned = NULL;
char *name_ptr = __porffor_node_cstr(MEM, ${name}, (i32)${nameType}.val, &name_owned);
if ((i32)${valueType}.val == 0) {
  uv_os_unsetenv(name_ptr);
} else {
  char *value_ptr = __porffor_node_cstr(MEM, ${value}, (i32)${valueType}.val, &value_owned);
  uv_os_setenv(name_ptr, value_ptr);
}
if (name_owned) free(name_owned);
if (value_owned) free(value_owned);
`;
};

const uvString = (which) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
size_t n = 0;
const int w = (int)PORF_NUM(${which});
char *s = porf_uv_str(w == 0 ? uv_os_homedir : w == 1 ? uv_os_tmpdir : w == 2 ? uv_os_gethostname : uv_exepath, &n);
${len} = s ? (f64)n : 0;
${buf} = (f64)(u64)s;
`;
	return takeCString(len, buf);
};

export const homedir = () => uvString(0);
export const tmpdir = () => uvString(1);
export const hostname = () => uvString(2);
export const execPath = () => uvString(3);

// uname: 0 the system's name, 1 its release, 2 the machine, 3 its version
export const systemInfo = (field) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
uv_utsname_t u;
if (uv_os_uname(&u) == 0) {
  const int f = (int)PORF_NUM(${field});
  const char *v = f == 0 ? u.sysname : f == 1 ? u.release : f == 2 ? u.machine : u.version;
  ${len} = (f64)strlen(v);
  ${buf} = (f64)(u64)strdup(v);
}
`;
	return takeCString(len, buf);
};

export const cpuCount = () => {
	let n = 1;
	Porffor.c`${n} = (f64)uv_available_parallelism();`;
	return n;
};

// one processor of uv_cpu_info's: [ model, speed, user, nice, sys, idle, irq ]
const cpuField = (index, field) => {
	let value = 0;
	Porffor.c`
uv_cpu_info_t *infos;
int count;
if (uv_cpu_info(&infos, &count) == 0) {
  const int i = (int)PORF_NUM(${index});
  if (i < count) {
    const struct uv_cpu_times_s *t = &infos[i].cpu_times;
    switch ((int)PORF_NUM(${field})) {
      case 1: ${value} = infos[i].speed; break;
      case 2: ${value} = (f64)t->user; break;
      case 3: ${value} = (f64)t->nice; break;
      case 4: ${value} = (f64)t->sys; break;
      case 5: ${value} = (f64)t->idle; break;
      case 6: ${value} = (f64)t->irq; break;
    }
  }
  uv_free_cpu_info(infos, count);
}
`;
	return value;
};

const cpuModel = (index) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
uv_cpu_info_t *infos;
int count;
if (uv_cpu_info(&infos, &count) == 0) {
  const int i = (int)PORF_NUM(${index});
  if (i < count && infos[i].model) {
    ${len} = (f64)strlen(infos[i].model);
    ${buf} = (f64)(u64)strdup(infos[i].model);
  }
  uv_free_cpu_info(infos, count);
}
`;
	return takeCString(len, buf);
};

const cpuTotal = () => {
	let n = 0;
	Porffor.c`
uv_cpu_info_t *infos;
int count;
if (uv_cpu_info(&infos, &count) == 0) {
  ${n} = count;
  uv_free_cpu_info(infos, count);
}
`;
	return n;
};

// [ model, speed, user, nice, sys, idle, irq ] each
export const cpus = () => {
	const out = [];
	const n = cpuTotal();
	for (let i = 0; i < n; i++) {
		out.push([
			cpuModel(i),
			cpuField(i, 1),
			cpuField(i, 2),
			cpuField(i, 3),
			cpuField(i, 4),
			cpuField(i, 5),
			cpuField(i, 6)
		]);
	}
	return out;
};

export const totalMemory = () => {
	let n = 0;
	Porffor.c`${n} = (f64)uv_get_total_memory();`;
	return n;
};

export const freeMemory = () => {
	let n = 0;
	Porffor.c`${n} = (f64)uv_get_free_memory();`;
	return n;
};

export const uptime = () => {
	let n = 0;
	Porffor.c`
double seconds = 0;
if (uv_uptime(&seconds) == 0) ${n} = seconds;
`;
	return n;
};

export const pid = () => {
	let n = 0;
	Porffor.c`${n} = (f64)uv_os_getpid();`;
	return n;
};

// a monotonic clock, in nanoseconds (as a number)
export const hrtime = () => {
	let ns = 0;
	Porffor.c`${ns} = (f64)uv_hrtime();`;
	return ns;
};

// the resident set size, in bytes (uv_resident_set_memory), 0 when it cannot be told
export const residentMemory = () => {
	let n = 0;
	Porffor.c`
size_t rss = 0;
if (uv_resident_set_memory(&rss) == 0) ${n} = (f64)rss;
`;
	return n;
};
