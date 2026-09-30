// Native host: child processes over libuv (uv_spawn), synchronously: a private loop runs until
// the child has exited and its pipes are drained, as Node's spawnSync does. node/child_process.mjs
// makes Node's calls of it. runtime/host/wasi/child_process.mjs is the same for WASI, which has no
// processes.
import { takeCString } from '../c.mjs';

Porffor.c`
#include <uv.h>

// a pipe the child writes (its stdout or stderr), read into a growing buffer
typedef struct {
  uv_pipe_t pipe;
  char *buf;
  size_t len, cap;
} porf_cp_out;

// the child and what became of it
typedef struct {
  uv_process_t process;
  int64_t status;
  int signal;
} porf_cp_child;

static void porf_cp_alloc(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
  porf_cp_out *out = (porf_cp_out *)handle;
  if (out->cap - out->len < suggested) {
    size_t cap = out->cap * 2 + suggested;
    char *next = realloc(out->buf, cap);
    if (!next) { *buf = uv_buf_init(NULL, 0); return; }
    out->buf = next;
    out->cap = cap;
  }
  *buf = uv_buf_init(out->buf + out->len, (unsigned int)(out->cap - out->len));
}

static void porf_cp_read(uv_stream_t *stream, ssize_t n, const uv_buf_t *buf) {
  porf_cp_out *out = (porf_cp_out *)stream;
  if (n > 0) out->len += (size_t)n;
  else if (n < 0) uv_close((uv_handle_t *)stream, NULL);
}

static void porf_cp_exit(uv_process_t *process, int64_t status, int signal) {
  porf_cp_child *child = (porf_cp_child *)process;
  child->status = status;
  child->signal = signal;
  uv_close((uv_handle_t *)process, NULL);
}

static void porf_cp_stdin_closed(uv_handle_t *handle) {
  (void)handle;
}

static void porf_cp_written(uv_write_t *req, int status) {
  (void)status;
  uv_close((uv_handle_t *)req->handle, porf_cp_stdin_closed);
  free(req);
}
`;

// runs file with args (an array of strings, argv[0] being file), env (an array of "KEY=value",
// or undefined for this process's) in cwd (or here), stdin its input when stdio[0] is a pipe.
// stdio: 0 a pipe (captured), 1 inherited, 2 ignored, for each of stdin, stdout, stderr.
// [ status, signal, stdout, stderr, spawn error (libuv's code, 0 when it ran) ]
export const spawnSync = (file, args, env, cwd, input, stdin, stdout, stderr) => {
	const fileType = Porffor.type(file);
	const envType = Porffor.type(env);
	const cwdType = Porffor.type(cwd);
	const inputType = Porffor.type(input);
	let status = 0;
	let signal = 0;
	let spawnError = 0;
	let outLen = 0,
		outBuf = 0,
		errLen = 0,
		errBuf = 0;
	Porffor.c`
{
  char *file_owned;
  char *file_ptr = __porffor_node_cstr(MEM, ${file}, (i32)${fileType}.val, &file_owned);

  const u32 arr = ${args}.val < 0 ? (u32)(i32)${args}.val : (u32)${args}.val;
  const i32 argn = *((i32*)(MEM + arr));
  const u32 ent = *((u32*)(MEM + arr + 4));
  char **cargv = calloc((size_t)argn + 1, sizeof(char*));
  char **argown = calloc((size_t)argn + 1, sizeof(char*));
  for (i32 i = 0; i < argn; i++) {
    const jsval av = porf_unpack(*(jsbits*)(MEM + ent + (u64)i * 8));
    cargv[i] = __porffor_node_cstr(MEM, av, porf_jv_type(av), &argown[i]);
  }

  char **cenv = NULL, **envown = NULL;
  i32 envn = 0;
  if ((i32)${envType}.val == 72 /* array */) {
    const u32 earr = ${env}.val < 0 ? (u32)(i32)${env}.val : (u32)${env}.val;
    envn = *((i32*)(MEM + earr));
    const u32 eent = *((u32*)(MEM + earr + 4));
    cenv = calloc((size_t)envn + 1, sizeof(char*));
    envown = calloc((size_t)envn + 1, sizeof(char*));
    for (i32 i = 0; i < envn; i++) {
      const jsval ev = porf_unpack(*(jsbits*)(MEM + eent + (u64)i * 8));
      cenv[i] = __porffor_node_cstr(MEM, ev, porf_jv_type(ev), &envown[i]);
    }
  }

  char *cwd_owned = NULL, *cwd_ptr = NULL;
  if ((i32)${cwdType}.val != 0 /* undefined */) cwd_ptr = __porffor_node_cstr(MEM, ${cwd}, (i32)${cwdType}.val, &cwd_owned);

  uv_loop_t loop;
  uv_loop_init(&loop);
  porf_cp_child child = { 0 };
  uv_pipe_t in_pipe;
  porf_cp_out out = { 0 }, err = { 0 };
  const int modes[3] = { (int)PORF_NUM(${stdin}), (int)PORF_NUM(${stdout}), (int)PORF_NUM(${stderr}) };

  uv_stdio_container_t stdio[3];
  for (int i = 0; i < 3; i++) {
    if (modes[i] == 1) { stdio[i].flags = UV_INHERIT_FD; stdio[i].data.fd = i; }
    else if (modes[i] == 2) stdio[i].flags = UV_IGNORE;
    else {
      uv_pipe_t *pipe = i == 0 ? &in_pipe : i == 1 ? &out.pipe : &err.pipe;
      uv_pipe_init(&loop, pipe, 0);
      stdio[i].flags = UV_CREATE_PIPE | (i == 0 ? UV_READABLE_PIPE : UV_WRITABLE_PIPE);
      stdio[i].data.stream = (uv_stream_t *)pipe;
    }
  }

  uv_process_options_t options = { 0 };
  options.exit_cb = porf_cp_exit;
  options.file = file_ptr;
  options.args = cargv;
  options.env = cenv;
  options.cwd = cwd_ptr;
  options.stdio_count = 3;
  options.stdio = stdio;

  const int rc = uv_spawn(&loop, &child.process, &options);
  if (rc < 0) {
    ${spawnError} = rc;
    for (int i = 0; i < 3; i++) if (modes[i] == 0) uv_close((uv_handle_t *)stdio[i].data.stream, NULL);
  } else {
    // the output read as it comes, while the input is written (a child that writes before it
    // has read all its input would block on a full pipe otherwise)
    if (modes[1] == 0) uv_read_start((uv_stream_t *)&out.pipe, porf_cp_alloc, porf_cp_read);
    if (modes[2] == 0) uv_read_start((uv_stream_t *)&err.pipe, porf_cp_alloc, porf_cp_read);
    char *bytes = NULL;
    if (modes[0] == 0) {
      // the input (a string as UTF-8, a typed array's bytes), then the child's stdin closed
      size_t len = 0;
      if ((i32)${inputType}.val != 0 /* undefined */) bytes = __porffor_bytes(MEM, ${input}, (i32)${inputType}.val, &len);
      if (len > 0) {
        uv_write_t *write = malloc(sizeof(uv_write_t));
        uv_buf_t chunk = uv_buf_init(bytes, (unsigned int)len);
        uv_write(write, (uv_stream_t *)&in_pipe, &chunk, 1, porf_cp_written);
      } else {
        uv_close((uv_handle_t *)&in_pipe, NULL);
      }
    }
    uv_run(&loop, UV_RUN_DEFAULT);
    free(bytes);
    ${status} = (f64)child.status;
    ${signal} = (f64)child.signal;
  }
  uv_run(&loop, UV_RUN_DEFAULT);
  uv_loop_close(&loop);

  ${outLen} = (f64)out.len; ${outBuf} = (f64)(u64)out.buf;
  ${errLen} = (f64)err.len; ${errBuf} = (f64)(u64)err.buf;

  for (i32 i = 0; i < argn; i++) if (argown[i]) free(argown[i]);
  if (envown) for (i32 i = 0; i < envn; i++) if (envown[i]) free(envown[i]);
  free(cargv);
  free(argown);
  if (cenv) free(cenv);
  if (envown) free(envown);
  if (cwd_owned) free(cwd_owned);
  if (file_owned) free(file_owned);
}
`;
	return [status, signal, takeBytes(outLen, outBuf), takeBytes(errLen, errBuf), spawnError];
};

// a buffer the C allocated, as a bytestring of its bytes, freed
const takeBytes = (len, buf) => {
	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
*((i32*)(MEM + out_ptr)) = (i32)PORF_NUM(${len});
if ((i32)PORF_NUM(${len}) > 0) memcpy(MEM + out_ptr + 4, (void*)(u64)PORF_NUM(${buf}), (size_t)PORF_NUM(${len}));
if (PORF_NUM(${buf}) != 0) free((void*)(u64)PORF_NUM(${buf}));
*(MEM + out_ptr + 4 + (i32)PORF_NUM(${len})) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

// bytes (a bytestring) to this process's stderr, as they are
export const writeStderr = (bytes) => {
	Porffor.c`
u32 bytes_ptr = ${bytes}.val < 0 ? (u32)(i32)${bytes}.val : (u32)${bytes}.val;
fwrite(MEM + bytes_ptr + 4, 1, (size_t)*((i32*)(MEM + bytes_ptr)), stderr);
fflush(stderr);
`;
};

export const errorName = (code) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
const char *name = uv_err_name((int)PORF_NUM(${code}));
${len} = strlen(name);
${buf} = (f64)(u64)strdup(name);
`;
	return takeCString(len, buf);
};

export const errorMessage = (code) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
const char *message = uv_strerror((int)PORF_NUM(${code}));
${len} = strlen(message);
${buf} = (f64)(u64)strdup(message);
`;
	return takeCString(len, buf);
};
