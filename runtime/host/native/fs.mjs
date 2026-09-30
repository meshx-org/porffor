// Native (POSIX libc) host: the file system's calls, each a thin layer over libc. A call that
// fails returns undefined (or its errno for one that returns nothing) and leaves errno for
// error(); node/fs.mjs makes Node's errors of it. Paths are Porffor strings, UTF-8 to libc.
import { takeCString } from './c.mjs';

let lastErrno = 0;

// the errno of the last call that failed
export const error = () => lastErrno;

// a file's bytes (a bytestring), undefined when it cannot be read
export const readFile = (path) => {
	const pathType = Porffor.type(path);
	let len = -1;
	let buf = 0;
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, path, (i32)pathType.val, &path_owned);
FILE *file = fopen(path_ptr, "rb");
if (!file) {
  err = errno;
} else {
  struct stat st;
  if (fstat(fileno(file), &st) == 0 && S_ISDIR(st.st_mode)) {
    err = EISDIR;
  } else {
    size_t cap = 65536, used = 0;
    char *tmp = malloc(cap);
    while (tmp) {
      if (used == cap) {
        char *next = realloc(tmp, cap * 2);
        if (!next) { free(tmp); tmp = NULL; err = ENOMEM; break; }
        tmp = next;
        cap *= 2;
      }
      size_t n = fread(tmp + used, 1, cap - used, file);
      used += n;
      if (n == 0) {
        if (ferror(file)) { err = errno ? errno : EIO; free(tmp); tmp = NULL; }
        break;
      }
    }
    if (tmp) {
      len = (i32)used;
      buf = (f64)(u64)tmp;
    }
  }
  fclose(file);
}
if (path_owned) free(path_owned);
}
`;
	if (len < 0) {
		lastErrno = err;
		return undefined;
	}

	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
*((i32*)(MEM + out_ptr)) = (i32)len;
if ((i32)len > 0) memcpy(MEM + out_ptr + 4, (void*)(u64)buf, (size_t)len);
if (buf != 0) free((void*)(u64)buf);
*(MEM + out_ptr + 4 + (i32)len) = 0;
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
};

// data (a bytestring: its bytes; a string: UTF-8; a typed array or DataView: its bytes) to a
// file, replacing it or (append) after it. flags: O_EXCL too (exclusive) when set. 0 or errno
export const writeFile = (path, data, append, exclusive, mode) => {
	const pathType = Porffor.type(path);
	const dataType = Porffor.type(data);
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, path, (i32)pathType.val, &path_owned);
int flags = O_WRONLY | O_CREAT | (porf_truthy(append) ? O_APPEND : O_TRUNC);
if (porf_truthy(exclusive)) flags |= O_EXCL;
int fd = open(path_ptr, flags, (mode_t)(i32)mode.val);
FILE *file = fd < 0 ? NULL : fdopen(fd, porf_truthy(append) ? "ab" : "wb");
if (!file) {
  err = errno;
  if (fd >= 0) close(fd);
} else {
  u32 data_ptr = data.val < 0 ? (u32)(i32)data.val : (u32)data.val;
  if ((i32)dataType.val == 195) {
    // a string of one-byte characters (Latin-1): as UTF-8, the ones past ASCII two bytes each
    i32 len = *((i32*)(MEM + data_ptr));
    const u8 *chars = (const u8 *)(MEM + data_ptr + 4);
    i32 run = 0;
    for (i32 i = 0; i < len; i++) {
      if (chars[i] < 0x80) continue;
      if (i > run) fwrite(chars + run, 1, (size_t)(i - run), file);
      fputc(0xc0 | (chars[i] >> 6), file);
      fputc(0x80 | (chars[i] & 0x3f), file);
      run = i + 1;
    }
    if (len > run) fwrite(chars + run, 1, (size_t)(len - run), file);
  } else if ((i32)dataType.val == 67) {
    __porffor_write_utf8(file, MEM, data_ptr);
  } else if ((i32)dataType.val >= 80 && (i32)dataType.val <= 90) {
    i32 len = *((i32*)(MEM + data_ptr));
    u32 buffer = *((u32*)(MEM + data_ptr + 4));
    i32 bytes = 1;
    if ((i32)dataType.val == 83 || (i32)dataType.val == 84) bytes = 2;
    if ((i32)dataType.val == 85 || (i32)dataType.val == 86 || (i32)dataType.val == 89) bytes = 4;
    if ((i32)dataType.val == 87 || (i32)dataType.val == 88 || (i32)dataType.val == 90) bytes = 8;
    fwrite(MEM + buffer + 4, 1, (size_t)len * (size_t)bytes, file);
  } else {
    i32 len = *((i32*)(MEM + data_ptr));
    i32 buffer = *((i32*)(MEM + data_ptr + 4));
    fwrite(MEM + (u32)buffer, 1, (size_t)len, file);
  }
  if (fclose(file) != 0) err = errno;
}
if (path_owned) free(path_owned);
}
`;
	if (err !== 0) lastErrno = err;
	return err;
};

// stat(2) (lstat(2) when not follow): [ dev, ino, mode, nlink, uid, gid, rdev, size, blksize,
// blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs ], undefined when it fails
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
char *path_ptr = __porffor_node_cstr(MEM, path, (i32)pathType.val, &path_owned);
struct stat st;
if ((porf_truthy(follow) ? stat(path_ptr, &st) : lstat(path_ptr, &st)) != 0) {
  err = errno;
} else {
  ok = 1;
  dev = (f64)st.st_dev; ino = (f64)st.st_ino; mode = (f64)st.st_mode; nlink = (f64)st.st_nlink;
  uid = (f64)st.st_uid; gid = (f64)st.st_gid; rdev = (f64)st.st_rdev; size = (f64)st.st_size;
  blksize = (f64)st.st_blksize; blocks = (f64)st.st_blocks;
#ifdef __APPLE__
  atimeMs = st.st_atimespec.tv_sec * 1e3 + st.st_atimespec.tv_nsec / 1e6;
  mtimeMs = st.st_mtimespec.tv_sec * 1e3 + st.st_mtimespec.tv_nsec / 1e6;
  ctimeMs = st.st_ctimespec.tv_sec * 1e3 + st.st_ctimespec.tv_nsec / 1e6;
  birthtimeMs = st.st_birthtimespec.tv_sec * 1e3 + st.st_birthtimespec.tv_nsec / 1e6;
#else
  atimeMs = st.st_atim.tv_sec * 1e3 + st.st_atim.tv_nsec / 1e6;
  mtimeMs = st.st_mtim.tv_sec * 1e3 + st.st_mtim.tv_nsec / 1e6;
  ctimeMs = st.st_ctim.tv_sec * 1e3 + st.st_ctim.tv_nsec / 1e6;
  birthtimeMs = 0;
#endif
}
if (path_owned) free(path_owned);
}
`;
	if (ok === 0) {
		lastErrno = err;
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
char *path_ptr = __porffor_node_cstr(MEM, path, (i32)pathType.val, &path_owned);
DIR *dir = opendir(path_ptr);
if (!dir) {
  err = errno;
} else {
  size_t cap = 4096, used = 0;
  char *tmp = malloc(cap);
  struct dirent *entry;
  errno = 0;
  while (tmp && (entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    const size_t nl = strlen(entry->d_name);
    if (used + nl + 2 > cap) {
      cap = cap * 2 + nl;
      char *next = realloc(tmp, cap);
      if (!next) { free(tmp); tmp = NULL; err = ENOMEM; break; }
      tmp = next;
    }
    char type = '0';
#ifdef DT_REG
    switch (entry->d_type) {
      case DT_REG: type = '1'; break;
      case DT_DIR: type = '2'; break;
      case DT_LNK: type = '3'; break;
      case DT_FIFO: type = '4'; break;
      case DT_SOCK: type = '5'; break;
      case DT_CHR: type = '6'; break;
      case DT_BLK: type = '7'; break;
    }
#endif
    // each entry: its type, its name, a NUL (a name can hold anything else)
    tmp[used++] = type;
    memcpy(tmp + used, entry->d_name, nl);
    used += nl;
    tmp[used++] = 0;
  }
  closedir(dir);
  if (tmp) {
    len = (i32)used;
    buf = (f64)(u64)tmp;
  }
}
if (path_owned) free(path_owned);
}
`;
	if (len < 0) {
		lastErrno = err;
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

// one path, one libc call: 0 or errno. op 0 mkdir (arg: mode), 1 rmdir, 2 unlink
export const pathCall = (op, path, arg) => {
	const pathType = Porffor.type(path);
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, path, (i32)pathType.val, &path_owned);
int rc = 0;
switch ((i32)op.val) {
  case 0: rc = mkdir(path_ptr, (mode_t)(i32)arg.val); break;
  case 1: rc = rmdir(path_ptr); break;
  case 2: rc = unlink(path_ptr); break;
}
if (rc != 0) err = errno;
if (path_owned) free(path_owned);
}
`;
	if (err !== 0) lastErrno = err;
	return err;
};

// two paths, one libc call: 0 or errno. op 0 rename(from, to), 1 symlink(target, path)
export const pathPairCall = (op, from, to) => {
	const fromType = Porffor.type(from);
	const toType = Porffor.type(to);
	let err = 0;
	Porffor.c`
{
char *from_owned, *to_owned;
char *from_ptr = __porffor_node_cstr(MEM, from, (i32)fromType.val, &from_owned);
char *to_ptr = __porffor_node_cstr(MEM, to, (i32)toType.val, &to_owned);
int rc = (i32)op.val == 0 ? rename(from_ptr, to_ptr) : symlink(from_ptr, to_ptr);
if (rc != 0) err = errno;
if (from_owned) free(from_owned);
if (to_owned) free(to_owned);
}
`;
	if (err !== 0) lastErrno = err;
	return err;
};

// a new directory, made unique from a prefix (mkdtemp); undefined when it fails
export const mkdtemp = (path) => {
	const pathType = Porffor.type(path);
	let len = -1;
	let buf = 0;
	let err = 0;
	Porffor.c`
{
char *path_owned;
char *path_ptr = __porffor_node_cstr(MEM, path, (i32)pathType.val, &path_owned);
char *result = NULL;
size_t pl = strlen(path_ptr);
char *template = malloc(pl + 7);
if (template) {
  memcpy(template, path_ptr, pl);
  memcpy(template + pl, "XXXXXX", 7);
  if (mkdtemp(template)) result = template;
  else free(template);
}
if (result) {
  len = strlen(result);
  buf = (f64)(u64)result;
} else {
  err = errno;
}
if (path_owned) free(path_owned);
}
`;
	if (len < 0) {
		lastErrno = err;
		return undefined;
	}
	return takeCString(len, buf);
};

// a file's bytes to another path (its mode too), which exclusive does not let exist: 0 or errno
export const copyFile = (from, to, exclusive) => {
	const fromType = Porffor.type(from);
	const toType = Porffor.type(to);
	let err = 0;
	Porffor.c`
{
char *from_owned, *to_owned;
char *from_ptr = __porffor_node_cstr(MEM, from, (i32)fromType.val, &from_owned);
char *to_ptr = __porffor_node_cstr(MEM, to, (i32)toType.val, &to_owned);
int in = open(from_ptr, O_RDONLY);
struct stat st;
if (in < 0 || fstat(in, &st) != 0) {
  err = errno;
} else if (S_ISDIR(st.st_mode)) {
  err = EISDIR;
} else {
  int out = open(to_ptr, O_WRONLY | O_CREAT | O_TRUNC | (porf_truthy(exclusive) ? O_EXCL : 0), st.st_mode & 07777);
  if (out < 0) {
    err = errno;
  } else {
    char chunk[65536];
    ssize_t n;
    while ((n = read(in, chunk, sizeof(chunk))) > 0) {
      ssize_t done = 0;
      while (done < n) {
        ssize_t w = write(out, chunk + done, (size_t)(n - done));
        if (w < 0) { err = errno; break; }
        done += w;
      }
      if (err) break;
    }
    if (n < 0) err = errno;
    if (close(out) != 0 && !err) err = errno;
  }
}
if (in >= 0) close(in);
if (from_owned) free(from_owned);
if (to_owned) free(to_owned);
}
`;
	if (err !== 0) lastErrno = err;
	return err;
};
