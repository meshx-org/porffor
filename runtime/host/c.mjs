// Native (POSIX libc) host: C helpers the other modules' C calls, emitted once. A Porffor
// string (bytestring 195 or UTF-16 67) to a C string, UTF-8 in and out, rm -rf, and errno's
// names. Under wasi-libc the same C reaches wasi:filesystem.
Porffor.c`
#include <errno.h>
#include <fcntl.h>

// a number JS handed the C, whether Porffor passes it as a jsval or (knowing its type) a double
static inline f64 porf_num_jv(jsval v) { return v.val; }
static inline f64 porf_num_f64(f64 v) { return v; }
#define PORF_NUM(x) _Generic((x), jsval: porf_num_jv, default: porf_num_f64)(x)

static char *__porffor_node_cstr(char *memory, jsval value, i32 type, char **owned) {
  *owned = NULL;
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  i32 len = *((i32*)(memory + ptr));
  if (type == 195) {
    char *out = malloc((size_t)len + 1);
    memcpy(out, memory + ptr + 4, (size_t)len);
    out[len] = 0;
    *owned = out;
    return out;
  }

  if (type == 67) {
    char *out = malloc((size_t)len + 1);
    for (i32 i = 0; i < len; i++) out[i] = (char)(*((u16*)(memory + ptr + 4 + i * 2)) & 0xff);
    out[len] = 0;
    *owned = out;
    return out;
  }

  return memory + ptr + 4;
}

static int __porffor_rm_rf(const char *path) {
  struct stat st;
  if (lstat(path, &st) != 0) return -1;

  if (S_ISDIR(st.st_mode)) {
    DIR *dir = opendir(path);
    if (!dir) return -1;

    struct dirent *entry;
    char child[4096];
    while ((entry = readdir(dir))) {
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
      __porffor_rm_rf(child);
    }

    closedir(dir);
    return rmdir(path);
  }

  return unlink(path);
}

static u32 __porffor_utf8_next(u8 *data, i32 len, i32 *i) {
  u8 b0 = data[(*i)++];
  if (b0 < 0x80) return b0;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    if (*i < len && (data[*i] & 0xc0) == 0x80) return ((u32)(b0 & 0x1f) << 6) | (data[(*i)++] & 0x3f);
  } else if (b0 == 0xe0) {
    if (*i + 1 < len && data[*i] >= 0xa0 && data[*i] <= 0xbf && (data[*i + 1] & 0xc0) == 0x80) {
      u32 cp = ((u32)(b0 & 0x0f) << 12) | ((u32)(data[*i] & 0x3f) << 6) | (data[*i + 1] & 0x3f);
      *i += 2;
      return cp;
    }
  } else if ((b0 >= 0xe1 && b0 <= 0xec) || (b0 >= 0xee && b0 <= 0xef)) {
    if (*i + 1 < len && (data[*i] & 0xc0) == 0x80 && (data[*i + 1] & 0xc0) == 0x80) {
      u32 cp = ((u32)(b0 & 0x0f) << 12) | ((u32)(data[*i] & 0x3f) << 6) | (data[*i + 1] & 0x3f);
      *i += 2;
      return cp;
    }
  } else if (b0 == 0xed) {
    if (*i + 1 < len && data[*i] >= 0x80 && data[*i] <= 0x9f && (data[*i + 1] & 0xc0) == 0x80) {
      u32 cp = ((u32)(b0 & 0x0f) << 12) | ((u32)(data[*i] & 0x3f) << 6) | (data[*i + 1] & 0x3f);
      *i += 2;
      return cp;
    }
  } else if (b0 == 0xf0) {
    if (*i + 2 < len && data[*i] >= 0x90 && data[*i] <= 0xbf && (data[*i + 1] & 0xc0) == 0x80 && (data[*i + 2] & 0xc0) == 0x80) {
      u32 cp = ((u32)(b0 & 0x07) << 18) | ((u32)(data[*i] & 0x3f) << 12) | ((u32)(data[*i + 1] & 0x3f) << 6) | (data[*i + 2] & 0x3f);
      *i += 3;
      return cp;
    }
  } else if (b0 >= 0xf1 && b0 <= 0xf3) {
    if (*i + 2 < len && (data[*i] & 0xc0) == 0x80 && (data[*i + 1] & 0xc0) == 0x80 && (data[*i + 2] & 0xc0) == 0x80) {
      u32 cp = ((u32)(b0 & 0x07) << 18) | ((u32)(data[*i] & 0x3f) << 12) | ((u32)(data[*i + 1] & 0x3f) << 6) | (data[*i + 2] & 0x3f);
      *i += 3;
      return cp;
    }
  } else if (b0 == 0xf4) {
    if (*i + 2 < len && data[*i] >= 0x80 && data[*i] <= 0x8f && (data[*i + 1] & 0xc0) == 0x80 && (data[*i + 2] & 0xc0) == 0x80) {
      u32 cp = ((u32)(b0 & 0x07) << 18) | ((u32)(data[*i] & 0x3f) << 12) | ((u32)(data[*i + 1] & 0x3f) << 6) | (data[*i + 2] & 0x3f);
      *i += 3;
      return cp;
    }
  }
  return 0xfffd;
}

static i32 __porffor_utf8_units(char *memory, jsval value, i32 type) {
  (void)type;
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  i32 len = *((i32*)(memory + ptr));
  u8 *data = (u8*)(memory + ptr + 4);
  i32 units = 0;
  i32 ascii = 1;
  for (i32 i = 0; i < len;) {
    if (data[i] >= 0x80) ascii = 0;
    u32 cp = __porffor_utf8_next(data, len, &i);
    units += cp > 0xffff ? 2 : 1;
  }
  return ascii ? -1 : units;
}

static void __porffor_utf8_decode(char *memory, jsval value, i32 type, jsval out) {
  (void)type;
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
  i32 len = *((i32*)(memory + ptr));
  u8 *data = (u8*)(memory + ptr + 4);
  u16 *dst = (u16*)(memory + out_ptr + 4);
  i32 j = 0;
  for (i32 i = 0; i < len;) {
    u32 cp = __porffor_utf8_next(data, len, &i);
    if (cp <= 0xffff) {
      dst[j++] = (u16)cp;
    } else {
      cp -= 0x10000;
      dst[j++] = 0xd800 | (cp >> 10);
      dst[j++] = 0xdc00 | (cp & 0x3ff);
    }
  }
  dst[j] = 0;
}

static void __porffor_write_utf8(FILE *file, char *memory, u32 ptr) {
  i32 len = *((i32*)(memory + ptr));
  for (i32 i = 0; i < len; i++) {
    u32 cp = *((u16*)(memory + ptr + 4 + i * 2));
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < len) {
      u32 lo = *((u16*)(memory + ptr + 4 + (i + 1) * 2));
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;

    if (cp < 0x80) {
      fputc((int)cp, file);
    } else if (cp < 0x800) {
      fputc((int)(0xc0 | (cp >> 6)), file);
      fputc((int)(0x80 | (cp & 0x3f)), file);
    } else if (cp < 0x10000) {
      fputc((int)(0xe0 | (cp >> 12)), file);
      fputc((int)(0x80 | ((cp >> 6) & 0x3f)), file);
      fputc((int)(0x80 | (cp & 0x3f)), file);
    } else {
      fputc((int)(0xf0 | (cp >> 18)), file);
      fputc((int)(0x80 | ((cp >> 12) & 0x3f)), file);
      fputc((int)(0x80 | ((cp >> 6) & 0x3f)), file);
      fputc((int)(0x80 | (cp & 0x3f)), file);
    }
  }
}

// what JS writes, as bytes: a string of one-byte characters (Latin-1) or of UTF-16 as UTF-8, a
// typed array's or DataView's bytes. A buffer to free, its length in *len
static char *__porffor_bytes(char *memory, jsval value, i32 type, size_t *len) {
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  if (type == 195 || type == 67) {
    i32 n = *((i32*)(memory + ptr));
    char *out = malloc((size_t)n * 3 + 1);
    size_t at = 0;
    for (i32 i = 0; i < n; i++) {
      u32 cp = type == 195 ? *((u8*)(memory + ptr + 4 + i)) : *((u16*)(memory + ptr + 4 + i * 2));
      if (type == 67 && cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
        u32 lo = *((u16*)(memory + ptr + 4 + (i + 1) * 2));
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      if (cp < 0x80) out[at++] = (char)cp;
      else if (cp < 0x800) { out[at++] = (char)(0xc0 | (cp >> 6)); out[at++] = (char)(0x80 | (cp & 0x3f)); }
      else if (cp < 0x10000) { out[at++] = (char)(0xe0 | (cp >> 12)); out[at++] = (char)(0x80 | ((cp >> 6) & 0x3f)); out[at++] = (char)(0x80 | (cp & 0x3f)); }
      else { out[at++] = (char)(0xf0 | (cp >> 18)); out[at++] = (char)(0x80 | ((cp >> 12) & 0x3f)); out[at++] = (char)(0x80 | ((cp >> 6) & 0x3f)); out[at++] = (char)(0x80 | (cp & 0x3f)); }
    }
    *len = at;
    return out;
  }
  size_t n, bytes = 1;
  u32 data;
  if (type >= 80 && type <= 90) {
    n = (size_t)*((i32*)(memory + ptr));
    data = *((u32*)(memory + ptr + 4)) + 4;
    if (type == 83 || type == 84) bytes = 2;
    if (type == 85 || type == 86 || type == 89) bytes = 4;
    if (type == 87 || type == 88 || type == 90) bytes = 8;
  } else {
    n = (size_t)*((i32*)(memory + ptr));
    data = (u32)*((i32*)(memory + ptr + 4));
  }
  *len = n * bytes;
  char *out = malloc(*len + 1);
  memcpy(out, memory + data, *len);
  return out;
}

// errno as libuv (and so Node) names it
static const char *__porffor_errno_name(int e) {
  switch (e) {
    case EACCES: return "EACCES";
    case EADDRINUSE: return "EADDRINUSE";
    case EAGAIN: return "EAGAIN";
    case EBADF: return "EBADF";
    case EBUSY: return "EBUSY";
    case ECANCELED: return "ECANCELED";
    case ECONNREFUSED: return "ECONNREFUSED";
    case ECONNRESET: return "ECONNRESET";
    case EEXIST: return "EEXIST";
    case EFAULT: return "EFAULT";
    case EFBIG: return "EFBIG";
    case EINTR: return "EINTR";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case EMLINK: return "EMLINK";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENFILE: return "ENFILE";
    case ENODEV: return "ENODEV";
    case ENOENT: return "ENOENT";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case ENOSYS: return "ENOSYS";
    case ENOTDIR: return "ENOTDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case ENOTSUP: return "ENOTSUP";
    case EPERM: return "EPERM";
    case EPIPE: return "EPIPE";
    case EROFS: return "EROFS";
    case ESPIPE: return "ESPIPE";
    case ETIMEDOUT: return "ETIMEDOUT";
    case ETXTBSY: return "ETXTBSY";
    case EXDEV: return "EXDEV";
    default: return "UNKNOWN";
  }
}
`;

// a C string the host allocated (buf, a pointer as a number, and its length) as a JS string,
// and freed: ASCII as a bytestring, UTF-8 decoded, bytes that are not UTF-8 as they are
export const takeCString = (len, buf) => {
	const out = Porffor.malloc(len + 6);
	Porffor.c`
u32 out_ptr = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
*((i32*)(MEM + out_ptr)) = (i32)${len}.val;
if ((i32)${len}.val > 0) memcpy(MEM + out_ptr + 4, (void*)(u64)${buf}.val, (size_t)${len}.val);
if (${buf}.val != 0) free((void*)(u64)${buf}.val);
*(MEM + out_ptr + 4 + (i32)${len}.val) = 0;
`;
	return decodeUtf8(Porffor.as(out, Porffor.TYPES.bytestring));
};

// a bytestring of UTF-8 as a string: ASCII as it is, bytes that are not UTF-8 as they are
export const decodeUtf8 = (bytes) => {
	let units = 0;
	Porffor.c`${units} = __porffor_utf8_units(MEM, ${bytes}, 195);`;
	if (units < 0 || units == bytes.length) return bytes;

	const str = Porffor.malloc(units * 2 + 6);
	Porffor.c`
u32 str_ptr = ${str}.val < 0 ? (u32)(i32)${str}.val : (u32)${str}.val;
*((i32*)(MEM + str_ptr)) = (i32)${units};
__porffor_utf8_decode(MEM, ${bytes}, 195, ${str});
`;
	return Porffor.as(str, Porffor.TYPES.string);
};

// errno's name (ENOENT, ...), as Node names it
export const errnoName = (code) => {
	let len = 0;
	let buf = 0;
	Porffor.c`
const char *name = __porffor_errno_name((int)${code}.val);
${len} = strlen(name);
${buf} = (f64)(u64)strdup(name);
`;
	return takeCString(len, buf);
};

// whether this is a WASI build (wasi-libc: files, no processes)
export const isWasi = () => {
	let out = 0;
	Porffor.c`
#ifdef __wasi__
${out} = 1;
#endif
`;
	return out !== 0;
};
