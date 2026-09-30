// Native (POSIX libc) host: the process. Its arguments, environment, working directory,
// platform, standard input and output, and exit.
import { takeCString } from './c.mjs';

export const isTTY = (fd) => {
	let out = 0;
	Porffor.c`out = isatty((int)fd.val);`;
	return out !== 0;
};

export const argCount = () => {
	let out = 0;
	Porffor.c`out = porf_argc;`;
	return out;
};

export const arg = (argIndex) => {
	let len = 0;
	Porffor.c`len = strlen(porf_argv[(i32)argIndex.val]);`;

	const out = Porffor.malloc(len + 6);
	Porffor.c`u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val; *((i32*)(MEM + out_ptr)) = (i32)len; memcpy(MEM + out_ptr + 4, porf_argv[(i32)argIndex.val], (size_t)len); *(MEM + out_ptr + 4 + (i32)len) = 0;`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

export const platform = () => {
	let len = 5;
	Porffor.c`
#ifdef __APPLE__
  len = 6;
#elif defined(_WIN32)
  len = 5;
#else
  len = 5;
#endif
`;

	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
#ifdef __APPLE__
  *((i32*)(MEM + out_ptr)) = 6; memcpy(MEM + out_ptr + 4, "darwin", 6); *(MEM + out_ptr + 10) = 0;
#elif defined(_WIN32)
  *((i32*)(MEM + out_ptr)) = 5; memcpy(MEM + out_ptr + 4, "win32", 5); *(MEM + out_ptr + 9) = 0;
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
if (fgets(line, sizeof(line), stdin) != NULL) len = strlen(line);
`;
	if (len < 0) return undefined;

	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
*((i32*)(MEM + out_ptr)) = (i32)len;
memcpy(MEM + out_ptr + 4, line, (size_t)len);
*(MEM + out_ptr + 4 + (i32)len) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

export const cwd = () => {
	const out = Porffor.malloc(4102);
	Porffor.c`
u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
if (getcwd((char*)(MEM + out_ptr + 4), 4096)) *((i32*)(MEM + out_ptr)) = (i32)strlen((char*)(MEM + out_ptr + 4));
  else *((i32*)(MEM + out_ptr)) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

const envCount = () => {
	let out = 0;
	Porffor.c`extern char **environ; i32 n = 0; while (environ[n]) n++; out = n;`;
	return out;
};

const envEntry = (idx) => {
	let len = 0;
	Porffor.c`extern char **environ; len = strlen(environ[(i32)idx.val]);`;
	const out = Porffor.malloc(len + 6);
	Porffor.c`
{
extern char **environ;
u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
*((i32*)(MEM + out_ptr)) = (i32)len;
memcpy(MEM + out_ptr + 4, environ[(i32)idx.val], (size_t)len);
*(MEM + out_ptr + 4 + (i32)len) = 0;
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

export const exit = (code = 0) => {
	Porffor.c`exit((int)code.val);`;
};

// one environment variable, undefined when it is not set
export const getenv = (name) => {
	const nameType = Porffor.type(name);
	let len = -1;
	let buf = 0;
	Porffor.c`
char *name_owned;
char *name_ptr = __porffor_node_cstr(MEM, name, (i32)nameType.val, &name_owned);
const char *value = getenv(name_ptr);
if (value) {
  len = strlen(value);
  buf = (f64)(u64)strdup(value);
}
if (name_owned) free(name_owned);
`;
	if (len < 0) return undefined;
	return takeCString(len, buf);
};
