// Native host: the file system's calls over libuv (its uv_fs_* calls, synchronous: no callback).
// A call that fails returns undefined (or its error for one that returns nothing) and leaves the
// error for error(); node/fs.mjs makes Node's errors of it, named and worded by libuv as Node's
// are. Paths are Porffor strings, UTF-8 to libuv. runtime/host/wasi/fs.mjs is the same over
// wasi-libc.
import { takeCString } from '../c.mjs';

let lastError = 0;

// the error of the last call that failed: libuv's code (-errno), as Node has it
export const error = () => lastError;

// an error's name (ENOENT) and message, libuv's (Node's own)
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

Porffor.c`
#include <uv.h>

`;

// a file's bytes (a bytestring), undefined when it cannot be read
export const readFile = (path) => {
	const pathType = Porffor.type(path);
	let len = -1;
	let buf = 0;
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
uv_fs_t req;
int fd = uv_fs_open(NULL, &req, path_ptr, UV_FS_O_RDONLY, 0, NULL);
uv_fs_req_cleanup(&req);
if (fd < 0) {
  ${err} = fd;
} else {
  size_t cap = 65536, used = 0;
  char *tmp = malloc(cap);
  while (tmp) {
    if (used == cap) {
      char *next = realloc(tmp, cap * 2);
      if (!next) { free(tmp); tmp = NULL; ${err} = UV_ENOMEM; break; }
      tmp = next;
      cap *= 2;
    }
    uv_buf_t chunk = uv_buf_init(tmp + used, (unsigned int)(cap - used));
    int n = uv_fs_read(NULL, &req, fd, &chunk, 1, -1, NULL);
    uv_fs_req_cleanup(&req);
    if (n < 0) { ${err} = n; free(tmp); tmp = NULL; break; }
    if (n == 0) break;
    used += (size_t)n;
  }
  if (tmp) {
    ${len} = (i32)used;
    ${buf} = (f64)(u64)tmp;
  }
  uv_fs_close(NULL, &req, fd, NULL);
  uv_fs_req_cleanup(&req);
}
if (path_owned) free(path_owned);
}
`;
	if (len < 0) {
		lastError = err;
		return undefined;
	}

	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
*((i32*)(MEM + out_ptr)) = (i32)${len};
if ((i32)${len} > 0) memcpy(MEM + out_ptr + 4, (void*)(u64)${buf}, (size_t)${len});
if (${buf} != 0) free((void*)(u64)${buf});
*(MEM + out_ptr + 4 + (i32)${len}) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

// data (a string: UTF-8; a typed array or DataView: its bytes) to a file, replacing it or
// (append) after it, not over one that exists when exclusive. 0 or the error
export const writeFile = (path, data, append, exclusive, mode) => {
	const pathType = Porffor.type(path);
	const dataType = Porffor.type(data);
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
int flags = UV_FS_O_WRONLY | UV_FS_O_CREAT | (PORF_NUM(${append}) ? UV_FS_O_APPEND : UV_FS_O_TRUNC);
if (PORF_NUM(${exclusive})) flags |= UV_FS_O_EXCL;
uv_fs_t req;
int fd = uv_fs_open(NULL, &req, path_ptr, flags, (int)PORF_NUM(${mode}), NULL);
uv_fs_req_cleanup(&req);
if (fd < 0) {
  ${err} = fd;
} else {
  size_t len;
  char *bytes = __porffor_bytes(MEM, ${data}, (i32)${dataType}.val, &len);
  size_t done = 0;
  while (done < len) {
    uv_buf_t chunk = uv_buf_init(bytes + done, (unsigned int)(len - done));
    int n = uv_fs_write(NULL, &req, fd, &chunk, 1, -1, NULL);
    uv_fs_req_cleanup(&req);
    if (n < 0) { ${err} = n; break; }
    done += (size_t)n;
  }
  free(bytes);
  int rc = uv_fs_close(NULL, &req, fd, NULL);
  uv_fs_req_cleanup(&req);
  if (rc < 0 && ${err} == 0) ${err} = rc;
}
if (path_owned) free(path_owned);
}
`;
	if (err !== 0) lastError = err;
	return err;
};

// stat (lstat when not follow): [ dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks,
// atimeMs, mtimeMs, ctimeMs, birthtimeMs ], undefined when it fails
export const stat = (path, follow) => {
	const pathType = Porffor.type(path);
	let ok = 0;
	let err = 0;
	let dev = 0,
		ino = 0,
		mode = 0,
		nlink = 0,
		uid = 0,
		gid = 0,
		rdev = 0,
		size = 0;
	let blksize = 0,
		blocks = 0,
		atimeMs = 0,
		mtimeMs = 0,
		ctimeMs = 0,
		birthtimeMs = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
uv_fs_t req;
int rc = PORF_NUM(${follow}) ? uv_fs_stat(NULL, &req, path_ptr, NULL) : uv_fs_lstat(NULL, &req, path_ptr, NULL);
if (rc < 0) {
  ${err} = rc;
} else {
  const uv_stat_t *st = &req.statbuf;
  ${ok} = 1;
  ${dev} = (f64)st->st_dev; ${ino} = (f64)st->st_ino; ${mode} = (f64)st->st_mode; ${nlink} = (f64)st->st_nlink;
  ${uid} = (f64)st->st_uid; ${gid} = (f64)st->st_gid; ${rdev} = (f64)st->st_rdev; ${size} = (f64)st->st_size;
  ${blksize} = (f64)st->st_blksize; ${blocks} = (f64)st->st_blocks;
  ${atimeMs} = st->st_atim.tv_sec * 1e3 + st->st_atim.tv_nsec / 1e6;
  ${mtimeMs} = st->st_mtim.tv_sec * 1e3 + st->st_mtim.tv_nsec / 1e6;
  ${ctimeMs} = st->st_ctim.tv_sec * 1e3 + st->st_ctim.tv_nsec / 1e6;
  ${birthtimeMs} = st->st_birthtim.tv_sec * 1e3 + st->st_birthtim.tv_nsec / 1e6;
}
uv_fs_req_cleanup(&req);
if (path_owned) free(path_owned);
}
`;
	if (ok === 0) {
		lastError = err;
		return undefined;
	}
	return [
		dev,
		ino,
		mode,
		nlink,
		uid,
		gid,
		rdev,
		size,
		blksize,
		blocks,
		atimeMs,
		mtimeMs,
		ctimeMs,
		birthtimeMs
	];
};

// a directory's entries (not . and ..): [ name, type ] each, the type 0 unknown, 1 file,
// 2 directory, 3 symbolic link, 4 FIFO, 5 socket, 6 character device, 7 block device.
// undefined when it cannot be read
export const readdir = (path) => {
	const pathType = Porffor.type(path);
	let len = -1;
	let buf = 0;
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
uv_fs_t req;
int rc = uv_fs_scandir(NULL, &req, path_ptr, 0, NULL);
if (rc < 0) {
  ${err} = rc;
} else {
  size_t cap = 4096, used = 0;
  char *tmp = malloc(cap);
  uv_dirent_t entry;
  while (tmp && uv_fs_scandir_next(&req, &entry) != UV_EOF) {
    const size_t nl = strlen(entry.name);
    if (used + nl + 2 > cap) {
      cap = cap * 2 + nl;
      char *next = realloc(tmp, cap);
      if (!next) { free(tmp); tmp = NULL; ${err} = UV_ENOMEM; break; }
      tmp = next;
    }
    char type = '0';
    switch (entry.type) {
      case UV_DIRENT_FILE: type = '1'; break;
      case UV_DIRENT_DIR: type = '2'; break;
      case UV_DIRENT_LINK: type = '3'; break;
      case UV_DIRENT_FIFO: type = '4'; break;
      case UV_DIRENT_SOCKET: type = '5'; break;
      case UV_DIRENT_CHAR: type = '6'; break;
      case UV_DIRENT_BLOCK: type = '7'; break;
      default: break;
    }
    // each entry: its type, its name, a NUL (a name can hold anything else)
    tmp[used++] = type;
    memcpy(tmp + used, entry.name, nl);
    used += nl;
    tmp[used++] = 0;
  }
  if (tmp) {
    ${len} = (i32)used;
    ${buf} = (f64)(u64)tmp;
  }
}
uv_fs_req_cleanup(&req);
if (path_owned) free(path_owned);
}
`;
	if (len < 0) {
		lastError = err;
		return undefined;
	}

	const joined = takeCString(len, buf);
	const out = [];
	let start = 0;
	for (let i = 0; i < joined.length; i++) {
		if (joined.charCodeAt(i) !== 0) continue;
		out.push([joined.slice(start + 1, i), joined.charCodeAt(start) - 48]);
		start = i + 1;
	}
	return out;
};

// one path, one call: 0 or the error. op 0 mkdir (arg: mode), 1 rmdir, 2 unlink
export const pathCall = (op, path, arg) => {
	const pathType = Porffor.type(path);
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
uv_fs_t req;
int rc = 0;
switch ((i32)PORF_NUM(${op})) {
  case 0: rc = uv_fs_mkdir(NULL, &req, path_ptr, (int)PORF_NUM(${arg}), NULL); break;
  case 1: rc = uv_fs_rmdir(NULL, &req, path_ptr, NULL); break;
  case 2: rc = uv_fs_unlink(NULL, &req, path_ptr, NULL); break;
}
uv_fs_req_cleanup(&req);
if (rc < 0) ${err} = rc;
if (path_owned) free(path_owned);
}
`;
	if (err !== 0) lastError = err;
	return err;
};

// two paths, one call: 0 or the error. op 0 rename(from, to), 1 symlink(target, path)
export const pathPairCall = (op, from, to) => {
	const fromType = Porffor.type(from);
	const toType = Porffor.type(to);
	let err = 0;
	Porffor.c`
{
char *from_owned, *to_owned;
char *from_ptr = __porffor_node_cstr(MEM, ${from}, (i32)${fromType}.val, &from_owned);
char *to_ptr = __porffor_node_cstr(MEM, ${to}, (i32)${toType}.val, &to_owned);
uv_fs_t req;
int rc = (i32)PORF_NUM(${op}) == 0 ? uv_fs_rename(NULL, &req, from_ptr, to_ptr, NULL) : uv_fs_symlink(NULL, &req, from_ptr, to_ptr, 0, NULL);
uv_fs_req_cleanup(&req);
if (rc < 0) ${err} = rc;
if (from_owned) free(from_owned);
if (to_owned) free(to_owned);
}
`;
	if (err !== 0) lastError = err;
	return err;
};

// a new directory, made unique from a prefix; undefined when it fails
export const mkdtemp = (path) => {
	const pathType = Porffor.type(path);
	let len = -1;
	let buf = 0;
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, ${path}, (i32)${pathType}.val, &path_owned);
size_t pl = strlen(path_ptr);
char *template = malloc(pl + 7);
memcpy(template, path_ptr, pl);
memcpy(template + pl, "XXXXXX", 7);
uv_fs_t req;
int rc = uv_fs_mkdtemp(NULL, &req, template, NULL);
if (rc < 0) {
  ${err} = rc;
} else {
  ${len} = strlen(req.path);
  ${buf} = (f64)(u64)strdup(req.path);
}
uv_fs_req_cleanup(&req);
free(template);
if (path_owned) free(path_owned);
}
`;
	if (len < 0) {
		lastError = err;
		return undefined;
	}
	return takeCString(len, buf);
};

// a file's bytes to another path (its mode too), which exclusive does not let exist: 0 or the error
export const copyFile = (from, to, exclusive) => {
	const fromType = Porffor.type(from);
	const toType = Porffor.type(to);
	let err = 0;
	Porffor.c`
{
char *from_owned, *to_owned;
char *from_ptr = __porffor_node_cstr(MEM, ${from}, (i32)${fromType}.val, &from_owned);
char *to_ptr = __porffor_node_cstr(MEM, ${to}, (i32)${toType}.val, &to_owned);
uv_fs_t req;
int rc = uv_fs_copyfile(NULL, &req, from_ptr, to_ptr, PORF_NUM(${exclusive}) ? UV_FS_COPYFILE_EXCL : 0, NULL);
uv_fs_req_cleanup(&req);
if (rc < 0) ${err} = rc;
if (from_owned) free(from_owned);
if (to_owned) free(to_owned);
}
`;
	if (err !== 0) lastError = err;
	return err;
};
