// WASI host: the process over wasi-libc: its arguments, environment, working directory,
// platform, standard input and output, exit, and what WASI says of the machine (little: one
// processor, no memory totals). runtime/host/native/process.mjs is the same over libuv.
import { takeCString } from '../c.mjs';

export const isTTY = (fd) => {
	let out = 0;
	Porffor.c`${out} = isatty((int)${fd}.val);`;
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

export const cwd = () => {
	const out = Porffor.malloc(4102);
	Porffor.c`
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
if (getcwd((char*)(MEM + out_ptr + 4), 4096)) *((i32*)(MEM + out_ptr)) = (i32)strlen((char*)(MEM + out_ptr + 4));
  else *((i32*)(MEM + out_ptr)) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

const envCount = () => {
	let out = 0;
	Porffor.c`extern char **environ; i32 n = 0; while (environ[n]) n++; ${out} = n;`;
	return out;
};

const envEntry = (idx) => {
	let len = 0;
	Porffor.c`extern char **environ; ${len} = strlen(environ[(i32)${idx}.val]);`;
	const out = Porffor.malloc(len + 6);
	Porffor.c`
{
extern char **environ;
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
*((i32*)(MEM + out_ptr)) = (i32)${len};
memcpy(MEM + out_ptr + 4, environ[(i32)${idx}.val], (size_t)${len});
*(MEM + out_ptr + 4 + (i32)${len}) = 0;
}
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

export const env = () => {
	const env = {};
	const n = envCount();
	for (let i = 0; i < n; i++) {
		const entry = envEntry(i);
		const eq = entry.indexOf('=');
		if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return env;
};

// a write to standard output, flushed: raw writes are often \r-only progress updates, which
// stdio would hold until a newline
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

// one environment variable, undefined when it is not set
export const getenv = (name) => {
	const nameType = Porffor.type(name);
	let len = -1;
	let buf = 0;
	Porffor.c`
char *name_owned;
char *name_ptr = __porffor_node_cstr(MEM, ${name}, (i32)${nameType}.val, &name_owned);
const char *value = getenv(name_ptr);
if (value) {
  ${len} = strlen(value);
  ${buf} = (f64)(u64)strdup(value);
}
if (name_owned) free(name_owned);
`;
	if (len < 0) return undefined;
	return takeCString(len, buf);
};

// 0 or the error (-errno)
export const chdir = (path) => {
	const pathType = Porffor.type(path);
	let err = 0;
	Porffor.c`
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
if (chdir(path_ptr) != 0) ${err} = -errno;
if (path_owned) free(path_owned);
`;
	return err;
};

// value undefined: unset
export const setenv = (name, value) => {
	const nameType = Porffor.type(name);
	const valueType = Porffor.type(value);
	Porffor.c`
char *name_owned, *value_owned = NULL;
char *name_ptr = __porffor_node_cstr(MEM, ${name}, (i32)${nameType}.val, &name_owned);
if ((i32)${valueType}.val == 0) {
  unsetenv(name_ptr);
} else {
  char *value_ptr = __porffor_node_cstr(MEM, ${value}, (i32)${valueType}.val, &value_owned);
  setenv(name_ptr, value_ptr, 1);
}
if (name_owned) free(name_owned);
if (value_owned) free(value_owned);
`;
};

export const homedir = () => {
	const home = getenv('HOME');
	return home === undefined || home === '' ? '/' : home;
};

export const tmpdir = () => {
	let dir = getenv('TMPDIR');
	if (dir === undefined || dir === '') dir = getenv('TMP');
	if (dir === undefined || dir === '') dir = getenv('TEMP');
	if (dir === undefined || dir === '') return '/tmp';
	if (dir.length > 1 && dir[dir.length - 1] === '/') return dir.slice(0, -1);
	return dir;
};

export const hostname = () => 'localhost';

// uname: 0 the system's name, 1 its release, 2 the machine, 3 its version
export const systemInfo = (field) => (field === 0 ? 'WASI' : field === 2 ? 'wasm32' : '');

export const cpuCount = () => 1;
// [ model, speed, user, nice, sys, idle, irq ] each: WASI tells nothing of them
export const cpus = () => [];
export const totalMemory = () => 0;
export const freeMemory = () => 0;
export const execPath = () => '';
export const uptime = () => 0;
export const pid = () => 1;
export const residentMemory = () => 0;

// a monotonic clock, in nanoseconds (as a number)
export const hrtime = () => {
	let ns = 0;
	Porffor.c`
struct timespec ts;
clock_gettime(CLOCK_MONOTONIC, &ts);
${ns} = (f64)ts.tv_sec * 1e9 + (f64)ts.tv_nsec;
`;
	return ns;
};
