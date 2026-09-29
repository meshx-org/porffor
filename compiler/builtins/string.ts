import type {} from './porffor.d.ts';

export const __Porffor_strcmp = (a: any, b: any): boolean => {
  // a and b must be string or bytestring
  // fast path: check if pointers are equal
  if (Porffor.IR.ptr(a) == Porffor.IR.ptr(b)) return true;

  const len: i32 = Porffor.IR.loadI32(a, 0);
  if (len != Porffor.IR.loadI32(b, 0)) return false;
  return __Porffor_string_mismatch(Porffor.IR.ptr(a), __Porffor_string_wide(a), 0, Porffor.IR.ptr(b), __Porffor_string_wide(b), 0, len) == len;
};

// --ropes: the string itself, as characters to read (a rope flattened: every builtin's
// arguments are, on the way in, so this only has to hand its argument back)
export const __Porffor_string_flat = (s: any): any => s;

export const __Porffor_strcat = (a: any, b: any): any => {
  // a and b must be string or bytestring

  const al: i32 = Porffor.IR.loadI32(a, 0);
  const bl: i32 = Porffor.IR.loadI32(b, 0);
  const aPtr: i32 = Porffor.IR.ptr(a);
  const bPtr: i32 = Porffor.IR.ptr(b);

  if (Porffor.type(a) == Porffor.TYPES.bytestring) {
    if (Porffor.type(b) == Porffor.TYPES.bytestring) {
      // bytestring, bytestring
      const out: bytestring = Porffor.malloc(6 + al + bl);

      Porffor.IR.storeI32(out, 0, al + bl);

      // copy left (fast memcpy)
      Porffor.IR.copy(Porffor.IR.ptr(out) + 4, aPtr + 4, al);

      // copy right (fast memcpy)
      Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + al, bPtr + 4, bl);

      return out;
    } else {
      // bytestring, string
      const out: string = Porffor.malloc(6 + (al + bl) * 2);

      Porffor.IR.storeI32(out, 0, al + bl);

      // copy left (slow bytestring -> string)
      for (let i: i32 = 0; i < al; i++) {
        Porffor.IR.storeU16(Porffor.IR.ptr(out) + i*2, 4, Porffor.IR.loadU8(aPtr + i, 4));
      }

      // copy right (fast memcpy)
      Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + al*2, bPtr + 4, bl * 2);

      return out;
    }
  } else {
    if (Porffor.type(b) == Porffor.TYPES.bytestring) {
      // string, bytestring
      const out: string = Porffor.malloc(6 + (al + bl) * 2);

      Porffor.IR.storeI32(out, 0, al + bl);

      // copy left (fast memcpy)
      Porffor.IR.copy(Porffor.IR.ptr(out) + 4, aPtr + 4, al * 2);

      // copy right (slow bytestring -> string)
      let ptr: i32 = Porffor.IR.ptr(out) + al*2;
      for (let i: i32 = 0; i < bl; i++) {
        Porffor.IR.storeU16(ptr + i*2, 4, Porffor.IR.loadU8(bPtr + i, 4));
      }

      return out;
    } else {
      // string, string
      const out: string = Porffor.malloc(6 + (al + bl) * 2);

      Porffor.IR.storeI32(out, 0, al + bl);

      // copy left (fast memcpy)
      Porffor.IR.copy(Porffor.IR.ptr(out) + 4, aPtr + 4, al * 2);

      // copy right (fast memcpy)
      Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + al*2, bPtr + 4, bl * 2);

      return out;
    }
  }
};


export const __String_prototype_at = function (this: string, index: number) {
  const len: i32 = this.length;

  if (index < 0) index = len + index;
  if (Porffor.fastOr(index < 0, index >= len)) return undefined;

  const out: string = Porffor.malloc(8);
  Porffor.IR.storeI32(out, 0, 1); // out.length = 1

  Porffor.IR.storeU16(Porffor.IR.ptr(out), 4, Porffor.IR.loadU16(Porffor.IR.ptr(this) + index * 2, 4));
  return out;
};

export const __ByteString_prototype_at = function (this: bytestring, index: number) {
  const len: i32 = this.length;

  if (index < 0) index = len + index;
  if (Porffor.fastOr(index < 0, index >= len)) return undefined;

  const out: bytestring = Porffor.malloc(8);
  Porffor.IR.storeI32(out, 0, 1); // out.length = 1

  Porffor.IR.storeU8(Porffor.IR.ptr(out), 4, Porffor.IR.loadU8(Porffor.IR.ptr(this) + index, 4));
  return out;
};

export const __String_prototype_charAt = function (this: string, index: number) {
  const len: i32 = this.length;

  if (Porffor.fastOr(index < 0, index >= len)) return '';

  const out: string = Porffor.malloc(8);
  Porffor.IR.storeI32(out, 0, 1); // out.length = 1

  Porffor.IR.storeU16(Porffor.IR.ptr(out), 4, Porffor.IR.loadU16(Porffor.IR.ptr(this) + index * 2, 4));
  return out;
};

export const __ByteString_prototype_charAt = function (this: bytestring, index: number) {
  const len: i32 = this.length;

  if (Porffor.fastOr(index < 0, index >= len)) return '';

  const out: bytestring = Porffor.malloc(8);
  Porffor.IR.storeI32(out, 0, 1); // out.length = 1

  Porffor.IR.storeU8(Porffor.IR.ptr(out), 4, Porffor.IR.loadU8(Porffor.IR.ptr(this) + index, 4));
  return out;
};

// Full Unicode case mapping (render.js porf_case_convert, tables from gen_case_tables.js):
// ß -> SS, Σ -> ς at the end of a word, supplementary letters. An ASCII bytestring stays
// a bytestring; a Latin-1 one may not (ÿ -> Ÿ, µ -> Μ leave Latin-1).
export const __String_prototype_toUpperCase = function (this: string) {
  return __Porffor_caseConvert(this, 1);
};

export const __ByteString_prototype_toUpperCase = function (this: bytestring) {
  return __Porffor_caseConvert(this, 1);
};

export const __String_prototype_toLowerCase = function (this: string) {
  return __Porffor_caseConvert(this, 0);
};

export const __ByteString_prototype_toLowerCase = function (this: bytestring) {
  return __Porffor_caseConvert(this, 0);
};

export const __String_prototype_toLocaleUpperCase = function (this: string) { return Porffor.callThis(__String_prototype_toUpperCase, this); };
export const __ByteString_prototype_toLocaleUpperCase = function (this: bytestring) { return Porffor.callThis(__ByteString_prototype_toUpperCase, this); };
export const __String_prototype_toLocaleLowerCase = function (this: string) { return Porffor.callThis(__String_prototype_toLowerCase, this); };
export const __ByteString_prototype_toLocaleLowerCase = function (this: bytestring) { return Porffor.callThis(__ByteString_prototype_toLowerCase, this); };

export const __String_prototype_codePointAt = function (this: string, index: number) {
  const len: i32 = this.length;

  if (Porffor.fastOr(index < 0, index >= len)) return undefined;

  index *= 2;
  const c1: i32 = Porffor.IR.loadU16(Porffor.IR.ptr(this) + index, 4);
  if (Porffor.fastAnd(c1 >= 0xD800, c1 <= 0xDBFF)) {
    // 1st char is leading surrogate, handle 2nd char
    // check oob
    if (index + 1 >= len) return c1;

    const c2: i32 = Porffor.IR.loadU16(Porffor.IR.ptr(this) + index + 2, 4);
    if (Porffor.fastAnd(c2 >= 0xDC00, c2 <= 0xDFFF)) {
      // 2nd char is trailing surrogate, return code point
      return (c1 << 10) + c2 - 56613888;
    }
  }

  return c1;
};

export const __ByteString_prototype_codePointAt = function (this: bytestring, index: number) {
  const len: i32 = this.length;

  if (Porffor.fastOr(index < 0, index >= len)) return undefined;

  // bytestrings cannot have surrogates, so just do charCodeAt
  return Porffor.IR.loadU8(Porffor.IR.ptr(this) + index, 4);
};

export const __String_prototype_startsWith = function (this: string, searchString: any, position: any = 0) {
  return __Porffor_string_startsWith(this, searchString, position);
};

export const __ByteString_prototype_startsWith = function (this: bytestring, searchString: any, position: any = 0) {
  return __Porffor_string_startsWith(this, searchString, position);
};


export const __String_prototype_endsWith = function (this: string, searchString: any, endPosition: any = undefined) {
  return __Porffor_string_endsWith(this, searchString, endPosition);
};

export const __ByteString_prototype_endsWith = function (this: bytestring, searchString: any, endPosition: any = undefined) {
  return __Porffor_string_endsWith(this, searchString, endPosition);
};


// a string's unit width for the __Porffor_string_* C helpers: 1 for two-byte units, 0 for one-byte
export const __Porffor_string_wide = (s: any): i32 => Porffor.type(s) == Porffor.TYPES.string ? 1 : 0;

// indexOf, lastIndexOf, includes, startsWith and endsWith for both string kinds, the search in
// either kind: SIMD searches and compares over the units as they are, nothing widened

export const __Porffor_string_indexOf = (str: any, searchString: any, position: any): i32 => {
  searchString = ecma262.ToString(searchString);
  const pos: number = ecma262.ToIntegerOrInfinity(position);
  const len: i32 = str.length;
  let start: i32 = 0;
  if (pos > 0) start = pos > len ? len : pos;
  return __Porffor_string_find(Porffor.IR.ptr(str), __Porffor_string_wide(str), len,
    Porffor.IR.ptr(searchString), __Porffor_string_wide(searchString), searchString.length, start);
};

export const __Porffor_string_lastIndexOf = (str: any, searchString: any, position: any): i32 => {
  searchString = ecma262.ToString(searchString);
  const numPos: number = ecma262.ToNumber(position);
  const len: i32 = str.length;
  // NaN (and undefined) searches from the end
  let start: i32 = len;
  if (numPos == numPos) {
    const pos: number = ecma262.ToIntegerOrInfinity(numPos);
    if (pos < len) start = pos > 0 ? pos : 0;
  }
  return __Porffor_string_rfind(Porffor.IR.ptr(str), __Porffor_string_wide(str), len,
    Porffor.IR.ptr(searchString), __Porffor_string_wide(searchString), searchString.length, start);
};

export const __Porffor_string_startsWith = (str: any, searchString: any, position: any): boolean => {
  searchString = ecma262.ToString(searchString);
  const pos: number = ecma262.ToIntegerOrInfinity(position);
  const len: i32 = str.length;
  let start: i32 = 0;
  if (pos > 0) start = pos > len ? len : pos;
  const n: i32 = searchString.length;
  if (n > len - start) return false;
  return __Porffor_string_mismatch(Porffor.IR.ptr(str), __Porffor_string_wide(str), start,
    Porffor.IR.ptr(searchString), __Porffor_string_wide(searchString), 0, n) == n;
};

export const __Porffor_string_endsWith = (str: any, searchString: any, endPosition: any): boolean => {
  searchString = ecma262.ToString(searchString);
  const len: i32 = str.length;
  let end: i32 = len;
  if (Porffor.type(endPosition) != Porffor.TYPES.undefined) {
    const pos: number = ecma262.ToIntegerOrInfinity(endPosition);
    end = pos > 0 ? (pos > len ? len : pos) : 0;
  }
  const n: i32 = searchString.length;
  const start: i32 = end - n;
  if (start < 0) return false;
  return __Porffor_string_mismatch(Porffor.IR.ptr(str), __Porffor_string_wide(str), start,
    Porffor.IR.ptr(searchString), __Porffor_string_wide(searchString), 0, n) == n;
};

// the first index from at where the search string (searchLen units at data pointer search)
// occurs in a string of len units at data pointer base, or -1: the search's first unit found by
// a SIMD scan (__Porffor_simd_find*), the rest compared only there
export const __Porffor_string_findU8 = (base: i32, len: i32, search: i32, searchLen: i32, at: i32): i32 => {
  if (searchLen == 0) return at;
  const first: i32 = Porffor.IR.loadU8(search, 4);
  const last: i32 = len - searchLen;
  while (at <= last) {
    at = __Porffor_simd_findU8(base, at, last + 1, first);
    if (at < 0) return -1;
    let i: i32 = 1;
    while (i < searchLen) {
      if (Porffor.IR.loadU8(base + at + i, 4) != Porffor.IR.loadU8(search + i, 4)) break;
      i++;
    }
    if (i == searchLen) return at;
    at++;
  }
  return -1;
};

export const __Porffor_string_findU16 = (base: i32, len: i32, search: i32, searchLen: i32, at: i32): i32 => {
  if (searchLen == 0) return at;
  const first: i32 = Porffor.IR.loadU16(search, 4);
  const last: i32 = len - searchLen;
  while (at <= last) {
    at = __Porffor_simd_findU16(base, at, last + 1, first);
    if (at < 0) return -1;
    let i: i32 = 1;
    while (i < searchLen) {
      if (Porffor.IR.loadU16(base + (at + i) * 2, 4) != Porffor.IR.loadU16(search + i * 2, 4)) break;
      i++;
    }
    if (i == searchLen) return at;
    at++;
  }
  return -1;
};

export const __String_prototype_indexOf = function (this: string, searchString: any, position: any = 0) {
  return __Porffor_string_indexOf(this, searchString, position);
};

export const __ByteString_prototype_indexOf = function (this: bytestring, searchString: any, position: any = 0) {
  return __Porffor_string_indexOf(this, searchString, position);
};


export const __String_prototype_lastIndexOf = function (this: string, searchString: any, position: any = undefined) {
  return __Porffor_string_lastIndexOf(this, searchString, position);
};

export const __ByteString_prototype_lastIndexOf = function (this: bytestring, searchString: any, position: any = undefined) {
  return __Porffor_string_lastIndexOf(this, searchString, position);
};


export const __String_prototype_includes = function (this: string, searchString: any, position: any = 0) {
  return __Porffor_string_indexOf(this, searchString, position) != -1;
};

export const __ByteString_prototype_includes = function (this: bytestring, searchString: any, position: any = 0) {
  return __Porffor_string_indexOf(this, searchString, position) != -1;
};


export const __String_prototype_padStart = function (this: string, targetLength: number, padString: any = undefined) {
  const len: i32 = this.length;
  const todo: i32 = targetLength - len;
  const out: string = Porffor.malloc((todo > 0 ? len + todo : len) * 2 + 6);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  if (todo > 0) {
    if (Porffor.type(padString) == Porffor.TYPES.undefined) {
      for (let i: i32 = 0; i < todo; i++) {
        Porffor.IR.storeU16(outPtr, 4, 32);
        outPtr += 2;
      }

      out.length = targetLength;
    } else {
      padString = ecma262.ToString(padString);
      // utf-16 access below needs a full string
      if (Porffor.type(padString) == Porffor.TYPES.bytestring) {
        padString = Porffor.bytestringToString(padString);
      }
      const padStringLen: i32 = padString.length;
      if (padStringLen > 0) {
        for (let i: i32 = 0; i < todo; i++) {
          Porffor.IR.storeU16(outPtr, 4, Porffor.IR.loadU16(Porffor.IR.ptr(padString) + (i % padStringLen) * 2, 4));
          outPtr += 2;
        }
        out.length = targetLength;
      } else out.length = len;
    }
  } else out.length = len;

  const thisPtrEnd: i32 = thisPtr + len * 2;

  while (thisPtr < thisPtrEnd) {
    Porffor.IR.storeU16(outPtr, 4, Porffor.IR.loadU16(thisPtr, 4));

    thisPtr += 2;
    outPtr += 2;
  }

  return out;
};

export const __ByteString_prototype_padStart = function (this: bytestring, targetLength: number, padString: any = undefined) {
  const len: i32 = this.length;
  const todo: i32 = targetLength - len;
  const out: bytestring = Porffor.malloc((todo > 0 ? len + todo : len) + 5);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  if (todo > 0) {
    if (Porffor.type(padString) == Porffor.TYPES.undefined) {
      for (let i: i32 = 0; i < todo; i++) {
        Porffor.IR.storeU8(outPtr++, 4, 32);
      }

      out.length = targetLength;
    } else {
      padString = ecma262.ToString(padString);
      // non-bytestring pad: delegate to the string version
      if (Porffor.type(padString) != Porffor.TYPES.bytestring) {
        return Porffor.callThis(__String_prototype_padStart, Porffor.bytestringToString(this), targetLength, padString);
      }
      const padStringLen: i32 = padString.length;
      if (padStringLen > 0) {
        for (let i: i32 = 0; i < todo; i++) {
          Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU8(Porffor.IR.ptr(padString) + (i % padStringLen), 4));
        }

        out.length = targetLength;
      } else out.length = len;
    }
  } else out.length = len;

  const thisPtrEnd: i32 = thisPtr + len;

  while (thisPtr < thisPtrEnd) {
    Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU8(thisPtr++, 4));
  }

  return out;
};


export const __String_prototype_padEnd = function (this: string, targetLength: number, padString: any = undefined) {
  const len: i32 = this.length;
  const todo: i32 = targetLength - len;
  const out: string = Porffor.malloc((todo > 0 ? len + todo : len) * 2 + 6);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrEnd: i32 = thisPtr + len * 2;

  while (thisPtr < thisPtrEnd) {
    Porffor.IR.storeU16(outPtr, 4, Porffor.IR.loadU16(thisPtr, 4));

    thisPtr += 2;
    outPtr += 2;
  }

  if (todo > 0) {
    if (Porffor.type(padString) == Porffor.TYPES.undefined) {
      for (let i: i32 = 0; i < todo; i++) {
        Porffor.IR.storeU16(outPtr, 4, 32);
        outPtr += 2;
      }

      out.length = targetLength;
    } else {
      padString = ecma262.ToString(padString);
      // utf-16 access below needs a full string
      if (Porffor.type(padString) == Porffor.TYPES.bytestring) {
        padString = Porffor.bytestringToString(padString);
      }
      const padStringLen: i32 = padString.length;
      if (padStringLen > 0) {
        for (let i: i32 = 0; i < todo; i++) {
          Porffor.IR.storeU16(outPtr, 4, Porffor.IR.loadU16(Porffor.IR.ptr(padString) + (i % padStringLen) * 2, 4));
          outPtr += 2;
        }
        out.length = targetLength;
      } else out.length = len;
    }
  } else out.length = len;
  return out;
};

export const __ByteString_prototype_padEnd = function (this: bytestring, targetLength: number, padString: any = undefined) {
  const len: i32 = this.length;
  const todo: i32 = targetLength - len;
  const out: bytestring = Porffor.malloc((todo > 0 ? len + todo : len) + 5);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrEnd: i32 = thisPtr + len;

  while (thisPtr < thisPtrEnd) {
    Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU8(thisPtr++, 4));
  }

  if (todo > 0) {
    if (Porffor.type(padString) == Porffor.TYPES.undefined) {
      for (let i: i32 = 0; i < todo; i++) {
        Porffor.IR.storeU8(outPtr++, 4, 32);
      }

      out.length = targetLength;
    } else {
      padString = ecma262.ToString(padString);
      // non-bytestring pad: delegate to the string version
      if (Porffor.type(padString) != Porffor.TYPES.bytestring) {
        return Porffor.callThis(__String_prototype_padEnd, Porffor.bytestringToString(this), targetLength, padString);
      }
      const padStringLen: i32 = padString.length;
      if (padStringLen > 0) {
        for (let i: i32 = 0; i < todo; i++) {
          Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU8(Porffor.IR.ptr(padString) + (i % padStringLen), 4));
        }

        out.length = targetLength;
      } else out.length = len;
    }
  } else out.length = len;
  return out;
};


export const __Porffor_string_substringToBest = (str: string, start: number, end: number): bytestring|string => {
  const outLen: i32 = end - start;
  let thisPtr: i32 = Porffor.IR.ptr(str);
  const thisPtrEnd: i32 = thisPtr + end * 2;
  thisPtr += start * 2;

  let string: boolean = false;
  let scanPtr: i32 = thisPtr;
  while (scanPtr < thisPtrEnd) {
    if (Porffor.IR.loadU16(scanPtr, 4) > 0xff) {
      string = true;
      break;
    }

    scanPtr += 2;
  }

  if (!string) {
    const out: bytestring = Porffor.malloc(6 + outLen);
    let outPtr: i32 = Porffor.IR.ptr(out);
    while (thisPtr < thisPtrEnd) {
      Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU16(thisPtr, 4));
      thisPtr += 2;
    }

    out.length = outLen;
    return out;
  }

  const out: string = Porffor.malloc(6 + outLen * 2);
  if (outLen > 0) Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(str) + 4 + start * 2, outLen * 2);

  out.length = outLen;
  return out;
};

export const __String_prototype_substring = function (this: string, _start: any, _end: any) {
  const len: i32 = this.length;
  if (Porffor.type(_end) == Porffor.TYPES.undefined) _end = len;

  let start: number = ecma262.ToIntegerOrInfinity(_start);
  let end: number = ecma262.ToIntegerOrInfinity(_end);

  if (start < 0) start = 0;
  if (start > len) start = len;
  if (end < 0) end = 0;
  if (end > len) end = len;

  if (start > end) {
    const tmp: i32 = end;
    end = start;
    start = tmp;
  }

  return __Porffor_string_substringToBest(this, start, end);
};

export const __ByteString_prototype_substring = function (this: bytestring, _start: any, _end: any) {
  const len: i32 = this.length;
  if (Porffor.type(_end) == Porffor.TYPES.undefined) _end = len;

  let start: number = ecma262.ToIntegerOrInfinity(_start);
  let end: number = ecma262.ToIntegerOrInfinity(_end);

  if (start < 0) start = 0;
  if (start > len) start = len;
  if (end < 0) end = 0;
  if (end > len) end = len;

  if (start > end) {
    const tmp: i32 = end;
    end = start;
    start = tmp;
  }

  const outLen: i32 = end - start;
  const out: bytestring = Porffor.malloc(6 + outLen);
  if (outLen > 0) Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(this) + 4 + start, outLen);

  out.length = outLen;
  return out;
};


export const __String_prototype_substr = function (this: string, _start: any, _length: any) {
  const len: i32 = this.length;
  let start: number = ecma262.ToIntegerOrInfinity(_start);
  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }

  if (Porffor.type(_length) == Porffor.TYPES.undefined) _length = len - start;

  let length: number = ecma262.ToIntegerOrInfinity(_length);
  if (start + length > len) length = len - start;

  return __Porffor_string_substringToBest(this, start, start + length);
};

export const __ByteString_prototype_substr = function (this: bytestring, _start: any, _length: any) {
  const len: i32 = this.length;
  let start: number = ecma262.ToIntegerOrInfinity(_start);
  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }

  if (Porffor.type(_length) == Porffor.TYPES.undefined) _length = len - start;

  let length: number = ecma262.ToIntegerOrInfinity(_length);
  if (start + length > len) length = len - start;

  const out: bytestring = Porffor.malloc(6 + length);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  thisPtr += start;

  const thisPtrEnd: i32 = thisPtr + length;

  while (thisPtr < thisPtrEnd) {
    Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU8(thisPtr++, 4));
  }

  out.length = length;
  return out;
};


export const __String_prototype_slice = function (this: string, start: number, end: any) {
  const len: i32 = this.length;
  if (Porffor.type(end) == Porffor.TYPES.undefined) end = len;

  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }
  if (start > len) start = len;
  if (end < 0) {
    end = len + end;
    if (end < 0) end = 0;
  }
  if (end > len) end = len;

  if (start > end) end = start;

  return __Porffor_string_substringToBest(this, start, end);
};

export const __ByteString_prototype_slice = function (this: bytestring, start: number, end: any) {
  const len: i32 = this.length;
  if (Porffor.type(end) == Porffor.TYPES.undefined) end = len;

  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }
  if (start > len) start = len;
  if (end < 0) {
    end = len + end;
    if (end < 0) end = 0;
  }
  if (end > len) end = len;

  if (start > end) end = start;

  const out: bytestring = Porffor.malloc(6 + (end - start));

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrEnd: i32 = thisPtr + end;

  thisPtr += start;

  while (thisPtr < thisPtrEnd) {
    Porffor.IR.storeU8(outPtr++, 4, Porffor.IR.loadU8(thisPtr++, 4));
  }

  out.length = end - start;
  return out;
};


export const __String_prototype_trimStart = function (this: string) {
  const len: i32 = this.length;
  const out: string = Porffor.malloc(6 + len * 2);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrEnd: i32 = thisPtr + len * 2;

  let n: i32 = 0, start: boolean = true;
  while (thisPtr < thisPtrEnd) {
    const chr: i32 = Porffor.IR.loadU16(thisPtr, 4);
    thisPtr += 2;

    if (start) {
      // todo: not spec compliant, needs more unicode chars
      if (Porffor.fastOr(chr == 0x9, chr == 0xb, chr == 0xc, chr == 0xfeff, chr == 0x20, chr == 0xa0, chr == 0x1680, chr == 0x2000, chr == 0x2001, chr == 0x2002, chr == 0x2003, chr == 0x2004, chr == 0x2005, chr == 0x2006, chr == 0x2007, chr == 0x2008, chr == 0x2009, chr == 0x200a, chr == 0x202f, chr == 0x205f, chr == 0x3000, chr == 0xa, chr == 0xd, chr == 0x2028, chr == 0x2029)) {
        n++;
        continue;
      }

      start = false;
    }

    Porffor.IR.storeU16(outPtr, 4, chr);
    outPtr += 2;
  }

  out.length = len - n;
  return out;
};

export const __ByteString_prototype_trimStart = function (this: bytestring) {
  const len: i32 = this.length;
  const out: bytestring = Porffor.malloc(6 + len);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrEnd: i32 = thisPtr + len;

  let n: i32 = 0, start: boolean = true;
  while (thisPtr < thisPtrEnd) {
    const chr: i32 = Porffor.IR.loadU8(thisPtr++, 4);

    if (start) {
      // todo: not spec compliant, needs more unicode chars
      if (Porffor.fastOr(chr == 0x9, chr == 0xb, chr == 0xc, chr == 0xfeff, chr == 0x20, chr == 0xa0, chr == 0x1680, chr == 0x2000, chr == 0x2001, chr == 0x2002, chr == 0x2003, chr == 0x2004, chr == 0x2005, chr == 0x2006, chr == 0x2007, chr == 0x2008, chr == 0x2009, chr == 0x200a, chr == 0x202f, chr == 0x205f, chr == 0x3000, chr == 0xa, chr == 0xd, chr == 0x2028, chr == 0x2029)) {
        n++;
        continue;
      }

      start = false;
    }

    Porffor.IR.storeU8(outPtr++, 4, chr);
  }

  out.length = len - n;
  return out;
};


export const __String_prototype_trimEnd = function (this: string) {
  const len: i32 = this.length;
  const out: string = Porffor.malloc(6 + len * 2);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrStart: i32 = thisPtr;

  thisPtr += len * 2;
  outPtr += len * 2;

  let n: i32 = 0, start: boolean = true;
  while (thisPtr > thisPtrStart) {
    thisPtr -= 2;
    const chr: i32 = Porffor.IR.loadU16(thisPtr, 4);

    outPtr -= 2;

    if (start) {
      // todo: not spec compliant, needs more unicode chars
      if (Porffor.fastOr(chr == 0x9, chr == 0xb, chr == 0xc, chr == 0xfeff, chr == 0x20, chr == 0xa0, chr == 0x1680, chr == 0x2000, chr == 0x2001, chr == 0x2002, chr == 0x2003, chr == 0x2004, chr == 0x2005, chr == 0x2006, chr == 0x2007, chr == 0x2008, chr == 0x2009, chr == 0x200a, chr == 0x202f, chr == 0x205f, chr == 0x3000, chr == 0xa, chr == 0xd, chr == 0x2028, chr == 0x2029)) {
        n++;
        continue;
      }

      start = false;
    }

    Porffor.IR.storeU16(outPtr, 4, chr);
  }

  out.length = len - n;
  return out;
};

export const __ByteString_prototype_trimEnd = function (this: bytestring) {
  const len: i32 = this.length;
  const out: bytestring = Porffor.malloc(6 + len);

  let outPtr: i32 = Porffor.IR.ptr(out);
  let thisPtr: i32 = Porffor.IR.ptr(this);

  const thisPtrStart: i32 = thisPtr;

  thisPtr += len;
  outPtr += len;

  let n: i32 = 0, start: boolean = true;
  while (thisPtr > thisPtrStart) {
    const chr: i32 = Porffor.IR.loadU8(--thisPtr, 4);

    outPtr--;

    if (start) {
      // todo: not spec compliant, needs more unicode chars
      if (Porffor.fastOr(chr == 0x9, chr == 0xb, chr == 0xc, chr == 0xfeff, chr == 0x20, chr == 0xa0, chr == 0x1680, chr == 0x2000, chr == 0x2001, chr == 0x2002, chr == 0x2003, chr == 0x2004, chr == 0x2005, chr == 0x2006, chr == 0x2007, chr == 0x2008, chr == 0x2009, chr == 0x200a, chr == 0x202f, chr == 0x205f, chr == 0x3000, chr == 0xa, chr == 0xd, chr == 0x2028, chr == 0x2029)) {
        n++;
        continue;
      }

      start = false;
    }

    Porffor.IR.storeU8(outPtr, 4, chr);
  }

  out.length = len - n;
  return out;
};

export const __String_prototype_trim = function (this: string) {
  // todo/perf: optimize and not just reuse
  return Porffor.callThis(__String_prototype_trimStart, Porffor.callThis(__String_prototype_trimEnd, this));
};

export const __ByteString_prototype_trim = function (this: bytestring) {
  // todo/perf: optimize and not just reuse
  return Porffor.callThis(__ByteString_prototype_trimStart, Porffor.callThis(__ByteString_prototype_trimEnd, this));
};


export const __String_prototype_concat = function (this: string, ...vals: any[]) {
  let out: any = this;
  const valsLen: i32 = vals.length;
  for (let i: i32 = 0; i < valsLen; i++) {
    out = __Porffor_concatStrings(out, vals[i]);
  }

  return out;
};

export const __ByteString_prototype_concat = function (this: bytestring, ...vals: any[]) {
  let out: any = this;
  const valsLen: i32 = vals.length;
  for (let i: i32 = 0; i < valsLen; i++) {
    out = __Porffor_concatStrings(out, vals[i]);
  }

  return out;
};

export const __String_prototype_repeat = function (this: string, cnt: any) {
  const count: number = ecma262.ToIntegerOrInfinity(cnt);
  if (count < 0) throw new RangeError('Invalid count value');

  const thisLen: i32 = this.length * 2;
  if (thisLen == 0) return '';

  const out: string = Porffor.malloc(6 + thisLen * count);
  for (let i: i32 = 0; i < count; i++) {
    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);
  }

  Porffor.IR.storeI32(out, 0, this.length * count);
  return out;
};

export const __ByteString_prototype_repeat = function (this: bytestring, cnt: any) {
  const count: number = ecma262.ToIntegerOrInfinity(cnt);
  if (count < 0) throw new RangeError('Invalid count value');

  const thisLen: i32 = this.length;
  if (thisLen == 0) return '';

  const out: bytestring = Porffor.malloc(6 + thisLen * count);
  for (let i: i32 = 0; i < count; i++) {
    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);
  }

  Porffor.IR.storeI32(out, 0, thisLen * count);
  return out;
};

export const __Porffor_string_substringLike = (str: any, start: number, end: number) => {
  if (Porffor.type(str) == Porffor.TYPES.bytestring) {
    return Porffor.callThis(__ByteString_prototype_substring, str, start, end);
  }

  return Porffor.callThis(__String_prototype_substring, str, start, end);
};

export const __Porffor_string_indexOfLike = (str: any, searchString: any, position: any = 0) => {
  if (Porffor.type(str) == Porffor.TYPES.bytestring) {
    return Porffor.callThis(__ByteString_prototype_indexOf, str, searchString, position);
  }

  return Porffor.callThis(__String_prototype_indexOf, str, searchString, position);
};

export const __Porffor_string_emptyLike = (str: any) => __Porffor_string_substringLike(str, 0, 0);

export const __Porffor_string_getSubstitution = (str: any, match: any[], position: number, replacement: any) => {
  replacement = ecma262.ToString(replacement);

  let out: any = __Porffor_string_emptyLike(replacement);
  let i: i32 = 0;
  const len: i32 = replacement.length;

  while (i < len) {
    if (replacement.charCodeAt(i) != 36 || i + 1 >= len) {
      out = __Porffor_strcat(out, __Porffor_string_substringLike(replacement, i, i + 1));
      i++;
      continue;
    }

    const next: i32 = replacement.charCodeAt(i + 1);
    if (next == 36) {
      out = __Porffor_strcat(out, __Porffor_string_substringLike(replacement, i, i + 1));
      i += 2;
      continue;
    }

    if (next == 38) {
      const matchValue: any = match[0];
      out = __Porffor_strcat(out, matchValue);
      i += 2;
      continue;
    }

    if (next == 96) {
      out = __Porffor_strcat(out, __Porffor_string_substringLike(str, 0, position));
      i += 2;
      continue;
    }

    if (next == 39) {
      const matchValue: any = match[0];
      const matchLen: i32 = matchValue.length;
      const thisLen: i32 = str.length;
      out = __Porffor_strcat(out, __Porffor_string_substringLike(str, position + matchLen, thisLen));
      i += 2;
      continue;
    }

    if (next == 60) { // $<name>
      const groups: any = match.groups;
      if (groups !== undefined) {
        let gt: i32 = -1;
        for (let j: i32 = i + 2; j < len; j++) {
          if (replacement.charCodeAt(j) == 62) { gt = j; break; }
        }
        if (gt != -1) {
          const name: any = __Porffor_string_substringLike(replacement, i + 2, gt);
          const capture: any = Porffor.object.get(groups, name);
          if (capture !== undefined) out = __Porffor_strcat(out, ecma262.ToString(capture));
          i = gt + 1;
          continue;
        }
      }
    }

    if (next >= 48 && next <= 57) {
      let captureIndex: i32 = next - 48;
      let consumed: i32 = 2;

      if (i + 2 < len) {
        const nextNext: i32 = replacement.charCodeAt(i + 2);
        if (captureIndex != 0 && nextNext >= 48 && nextNext <= 57) {
          const twoDigit: i32 = captureIndex * 10 + nextNext - 48;
          if (twoDigit < match.length) {
            captureIndex = twoDigit;
            consumed = 3;
          }
        }
      }

      if (captureIndex > 0 && captureIndex < match.length) {
        const capture: any = match[captureIndex];
        if (capture !== undefined) out = __Porffor_strcat(out, capture);
        i += consumed;
        continue;
      }
    }

    out = __Porffor_strcat(out, __Porffor_string_substringLike(replacement, i, i + 1));
    i++;
  }

  return out;
};

export const __Porffor_array_getI32 = (arr: any[], index: i32): any => {
  return arr[index];
};

export const __Porffor_string_applyReplacer = (str: any, match: any[], position: number, replaceValue: any) => {
  if (Porffor.type(replaceValue) == Porffor.TYPES.function) {
    const len: i32 = match.length;
    const m0: any = __Porffor_array_getI32(match, 0);
    if (len <= 1) return ecma262.ToString(replaceValue(m0, position, str));
    const m1: any = __Porffor_array_getI32(match, 1);
    if (len == 2) return ecma262.ToString(replaceValue(m0, m1, position, str));
    const m2: any = __Porffor_array_getI32(match, 2);
    if (len == 3) return ecma262.ToString(replaceValue(m0, m1, m2, position, str));
    const m3: any = __Porffor_array_getI32(match, 3);
    if (len == 4) return ecma262.ToString(replaceValue(m0, m1, m2, m3, position, str));
    const m4: any = __Porffor_array_getI32(match, 4);
    if (len == 5) return ecma262.ToString(replaceValue(m0, m1, m2, m3, m4, position, str));

    throw new RangeError('String.prototype.replace callback supports up to 4 capture groups');
  }

  return __Porffor_string_getSubstitution(str, match, position, replaceValue);
};

export const __Porffor_string_replace = (str: any, searchValue: any, replaceValue: any) => {
  const thisLen: i32 = str.length;

  if (Porffor.type(searchValue) == Porffor.TYPES.regexp) {
    const global: boolean = Porffor.callThis(__RegExp_prototype_global$get, searchValue);
    const strType: i32 = Porffor.type(str);
    const uv: boolean = (Porffor.IR.loadU16(searchValue, 4) & 0b10010000) != 0;

    let out: any = __Porffor_string_emptyLike(str);
    let matched: boolean = false;
    let appendIndex: i32 = 0;
    let searchIndex: i32 = 0;
    // a single replacement is one RegExpExec: sticky starts at lastIndex
    if (!global && (Porffor.IR.loadU16(searchValue, 4) & 0b00100000) != 0) {
      searchIndex = Porffor.IR.loadI32(searchValue, 8);
      if (searchIndex < 0) searchIndex = 0;
      if (searchIndex > thisLen) {
        Porffor.IR.storeI32(searchValue, 8, 0);
        return str;
      }
    }

    // plain replacement (no '$') only needs match positions
    let plain: boolean = false;
    let repl: any = replaceValue;
    if (Porffor.type(replaceValue) != Porffor.TYPES.function) {
      repl = ecma262.ToString(replaceValue);
      plain = __Porffor_string_indexOfLike(repl, '$', 0) == -1;
    }

    // all-bytestring case builds one growing buffer instead of strcat chains
    if (plain && strType == Porffor.TYPES.bytestring && Porffor.type(repl) == Porffor.TYPES.bytestring) {
      const replLen: i32 = (repl as bytestring).length;
      let cap: i32 = thisLen + replLen + 16;
      let buf: i32 = Porffor.malloc(cap + 8);
      let bufLen: i32 = 0;
      while (searchIndex <= thisLen) {
        const matchEnd: i32 = __Porffor_regex_interpretFrom(searchValue, str, 2, searchIndex);
        if (matchEnd == -1) break;
        const matchIndex: i32 = __Porffor_regex_matchStart();
        matched = true;
        const segLen: i32 = matchIndex - appendIndex;
        if (bufLen + segLen + replLen > cap) {
          while (cap < bufLen + segLen + replLen) cap *= 2;
          const nbuf: i32 = Porffor.malloc(cap + 8);
          Porffor.IR.copy(nbuf + 4, buf + 4, bufLen);
          buf = nbuf;
        }
        Porffor.IR.copy(buf + 4 + bufLen, Porffor.IR.ptr(str) + 4 + appendIndex, segLen);
        bufLen += segLen;
        Porffor.IR.copy(buf + 4 + bufLen, Porffor.IR.ptr(repl) + 4, replLen);
        bufLen += replLen;

        appendIndex = matchEnd;
        if (!global) break;
        if (matchEnd == matchIndex) {
          if (matchEnd >= thisLen) break;
          searchIndex = matchEnd + 1;
          continue;
        }
        searchIndex = matchEnd;
      }
      if (!matched) return str;
      const tailLen: i32 = thisLen - appendIndex;
      if (bufLen + tailLen > cap) {
        cap = bufLen + tailLen;
        const nbuf: i32 = Porffor.malloc(cap + 8);
        Porffor.IR.copy(nbuf + 4, buf + 4, bufLen);
        buf = nbuf;
      }
      Porffor.IR.copy(buf + 4 + bufLen, Porffor.IR.ptr(str) + 4 + appendIndex, tailLen);
      bufLen += tailLen;
      Porffor.IR.storeI32(buf, 0, bufLen);
      return buf as bytestring;
    }

    while (searchIndex <= thisLen) {
      let matchIndex: i32 = 0;
      let matchEnd: i32 = 0;
      if (plain) {
        matchEnd = __Porffor_regex_interpretFrom(searchValue, str, 2, searchIndex);
        if (matchEnd == -1) break;
        matchIndex = __Porffor_regex_matchStart();
        matched = true;
        out = __Porffor_strcat(out, __Porffor_regex_inputSubstring(str, strType, appendIndex, matchIndex));
        out = __Porffor_strcat(out, repl);
      } else {
        const match: any = __Porffor_regex_interpretFrom(searchValue, str, 0, searchIndex);
        if (match == null) break;
        matched = true;
        matchIndex = match.index;
        const matchValue: any = match[0];
        matchEnd = matchIndex + matchValue.length;
        out = __Porffor_strcat(out, __Porffor_regex_inputSubstring(str, strType, appendIndex, matchIndex));
        out = __Porffor_strcat(out, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));
      }

      appendIndex = matchEnd;
      if (!global) break;

      if (matchEnd == matchIndex) {
        if (matchEnd >= thisLen) break;
        searchIndex = matchEnd + 1;
        if (uv && strType == Porffor.TYPES.string && searchIndex < thisLen) {
          const u1: i32 = Porffor.IR.loadU16(Porffor.IR.ptr(str) + matchEnd * 2, 4);
          const u2: i32 = Porffor.IR.loadU16(Porffor.IR.ptr(str) + searchIndex * 2, 4);
          if (u1 >= 0xD800 && u1 <= 0xDBFF && u2 >= 0xDC00 && u2 <= 0xDFFF) searchIndex += 1;
        }
        continue;
      }

      searchIndex = matchEnd;
    }

    if (!matched) return str;
    return __Porffor_strcat(out, __Porffor_regex_inputSubstring(str, strType, appendIndex, thisLen));
  }

  searchValue = ecma262.ToString(searchValue);
  const searchLen: i32 = searchValue.length;
  const matchIndex: i32 = searchLen == 0 ? 0 : __Porffor_string_indexOfLike(str, searchValue, 0);
  if (matchIndex == -1) return str;

  const match: any[] = Porffor.array.new(1);
  match[0] = searchValue;
  match.index = matchIndex;
  match.input = str;

  let out: any = __Porffor_string_emptyLike(str);
  out = __Porffor_strcat(out, __Porffor_string_substringLike(str, 0, matchIndex));
  out = __Porffor_strcat(out, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));
  return __Porffor_strcat(out, __Porffor_string_substringLike(str, matchIndex + searchLen, thisLen));
};

export const __String_prototype_replace = function (this: string, searchValue: any, replaceValue: any) {
  return __Porffor_string_replace(this, searchValue, replaceValue);
};

export const __ByteString_prototype_replace = function (this: bytestring, searchValue: any, replaceValue: any) {
  return __Porffor_string_replace(this, searchValue, replaceValue);
};

// n units of a string (from unit si) into a result being built (from unit di), widened into a
// two-byte result
export const __Porffor_string_copyUnits = (dst: i32, dstWide: i32, di: i32, src: any, si: i32, n: i32): void => {
  if (Porffor.type(src) == Porffor.TYPES.string) {
    Porffor.IR.copy(dst + 4 + di * 2, Porffor.IR.ptr(src) + 4 + si * 2, n * 2);
  } else if (dstWide) {
    __Porffor_simd_widen(dst, di, Porffor.IR.ptr(src), si, n);
  } else {
    Porffor.IR.copy(dst + 4 + di, Porffor.IR.ptr(src) + 4 + si, n);
  }
};

// replaceAll with one replacement for every match: the matches counted, then found again while
// the result is copied out
export const __Porffor_string_replaceAllPlain = (str: any, hay: i32, hayWide: i32, ndl: i32, ndlWide: i32, searchLen: i32, advance: i32, repl: any) => {
  const len: i32 = str.length;
  let count: i32 = 0;
  let at: i32 = __Porffor_string_find(hay, hayWide, len, ndl, ndlWide, searchLen, 0);
  while (at != -1) {
    count++;
    at = __Porffor_string_find(hay, hayWide, len, ndl, ndlWide, searchLen, at + advance);
  }
  if (count == 0) return str;

  const replLen: i32 = repl.length;
  const outLen: i32 = len + count * (replLen - searchLen);
  if (hayWide || Porffor.type(repl) == Porffor.TYPES.string) {
    const out: string = Porffor.malloc(8 + outLen * 2);
    __Porffor_string_replaceAllPlainFill(Porffor.IR.ptr(out), 1, str, hay, hayWide, ndl, ndlWide, searchLen, advance, repl);
    Porffor.IR.storeI32(Porffor.IR.ptr(out), 0, outLen);
    return out;
  }
  const out: bytestring = Porffor.malloc(8 + outLen);
  __Porffor_string_replaceAllPlainFill(Porffor.IR.ptr(out), 0, str, hay, hayWide, ndl, ndlWide, searchLen, advance, repl);
  Porffor.IR.storeI32(Porffor.IR.ptr(out), 0, outLen);
  return out;
};

export const __Porffor_string_replaceAllPlainFill = (dst: i32, dstWide: i32, str: any, hay: i32, hayWide: i32, ndl: i32, ndlWide: i32, searchLen: i32, advance: i32, repl: any): void => {
  const len: i32 = str.length;
  const replLen: i32 = repl.length;
  let di: i32 = 0;
  let from: i32 = 0;
  let at: i32 = __Porffor_string_find(hay, hayWide, len, ndl, ndlWide, searchLen, 0);
  while (at != -1) {
    __Porffor_string_copyUnits(dst, dstWide, di, str, from, at - from);
    di += at - from;
    __Porffor_string_copyUnits(dst, dstWide, di, repl, 0, replLen);
    di += replLen;
    from = at + searchLen;
    at = __Porffor_string_find(hay, hayWide, len, ndl, ndlWide, searchLen, at + advance);
  }
  __Porffor_string_copyUnits(dst, dstWide, di, str, from, len - from);
};

// units [from, to) of a string as a new string of its kind
export const __Porffor_string_piece = (str: any, from: i32, to: i32) => {
  const n: i32 = to - from;
  if (Porffor.type(str) == Porffor.TYPES.string) {
    const out: string = Porffor.malloc(8 + n * 2);
    Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(str) + 4 + from * 2, n * 2);
    Porffor.IR.storeI32(Porffor.IR.ptr(out), 0, n);
    return out;
  }
  const out: bytestring = Porffor.malloc(8 + n);
  Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(str) + 4 + from, n);
  Porffor.IR.storeI32(Porffor.IR.ptr(out), 0, n);
  return out;
};

// replaceAll's result: the string between matches and each replacement, in order
export const __Porffor_string_replaceAllFill = (dst: i32, dstWide: i32, str: any, positions: any[], replacements: any[], count: i32, searchLen: i32): void => {
  let di: i32 = 0;
  let from: i32 = 0;
  for (let i: i32 = 0; i < count; i++) {
    const p: i32 = positions[i];
    __Porffor_string_copyUnits(dst, dstWide, di, str, from, p - from);
    di += p - from;
    const r: any = replacements[i];
    const rLen: i32 = r.length;
    __Porffor_string_copyUnits(dst, dstWide, di, r, 0, rLen);
    di += rLen;
    from = p + searchLen;
  }
  __Porffor_string_copyUnits(dst, dstWide, di, str, from, str.length - from);
};

export const __Porffor_string_replaceAll = (str: any, searchValue: any, replaceValue: any) => {
  const thisLen: i32 = str.length;

  if (Porffor.type(searchValue) == Porffor.TYPES.regexp) {
    if (!Porffor.callThis(__RegExp_prototype_global$get, searchValue)) {
      throw new TypeError('String.prototype.replaceAll called with a non-global RegExp argument');
    }

    return __Porffor_string_replace(str, searchValue, replaceValue);
  }

  searchValue = ecma262.ToString(searchValue);
  const searchLen: i32 = searchValue.length;
  const hay: i32 = Porffor.IR.ptr(str), hayWide: i32 = __Porffor_string_wide(str);
  const ndl: i32 = Porffor.IR.ptr(searchValue), ndlWide: i32 = __Porffor_string_wide(searchValue);
  const advance: i32 = searchLen > 0 ? searchLen : 1;

  // a replacement string, converted once; without '$' it is the same at every match
  if (Porffor.type(replaceValue) != Porffor.TYPES.function) {
    replaceValue = ecma262.ToString(replaceValue);
    if (__Porffor_string_indexOfLike(replaceValue, '$', 0) == -1) {
      return __Porffor_string_replaceAllPlain(str, hay, hayWide, ndl, ndlWide, searchLen, advance, replaceValue);
    }
  }

  const positions: any[] = Porffor.array.new(8);
  let count: i32 = 0;
  let at: i32 = __Porffor_string_find(hay, hayWide, thisLen, ndl, ndlWide, searchLen, 0);
  while (at != -1) {
    count = Porffor.array.fastPush(positions, at);
    at = __Porffor_string_find(hay, hayWide, thisLen, ndl, ndlWide, searchLen, at + advance);
  }
  if (count == 0) return str;

  // the replacements, in match order, and the result's length and width
  const match: any[] = Porffor.array.new(1);
  match[0] = searchValue;
  match.input = str;
  const replacements: any[] = Porffor.array.new(count);
  let outLen: i32 = thisLen - count * searchLen;
  let wide: i32 = hayWide;
  for (let i: i32 = 0; i < count; i++) {
    const p: i32 = positions[i];
    match.index = p;
    const r: any = __Porffor_string_applyReplacer(str, match, p, replaceValue);
    Porffor.array.fastPush(replacements, r);
    outLen += r.length;
    if (Porffor.type(r) == Porffor.TYPES.string) wide = 1;
  }

  if (wide) {
    const out: string = Porffor.malloc(8 + outLen * 2);
    __Porffor_string_replaceAllFill(Porffor.IR.ptr(out), 1, str, positions, replacements, count, searchLen);
    Porffor.IR.storeI32(Porffor.IR.ptr(out), 0, outLen);
    return out;
  }
  const out: bytestring = Porffor.malloc(8 + outLen);
  __Porffor_string_replaceAllFill(Porffor.IR.ptr(out), 0, str, positions, replacements, count, searchLen);
  Porffor.IR.storeI32(Porffor.IR.ptr(out), 0, outLen);
  return out;
};

export const __String_prototype_replaceAll = function (this: string, searchValue: any, replaceValue: any) {
  return __Porffor_string_replaceAll(this, searchValue, replaceValue);
};

export const __ByteString_prototype_replaceAll = function (this: bytestring, searchValue: any, replaceValue: any) {
  return __Porffor_string_replaceAll(this, searchValue, replaceValue);
};



// regex split per spec: split between separator matches, splicing captures in, uses the engine's positions mode
export const __Porffor_string_splitRegex = (str: any, separator: any, limit: number, out: any[]): any[] => {
  let outLen: i32 = 0;
  const strType: i32 = Porffor.type(str);
  const thisLen: i32 = str.length;
  const nCaps: i32 = Porffor.IR.loadU16(separator, 6);
  const uv: boolean = (Porffor.IR.loadU16(separator, 4) & 0b10010000) != 0;
  // split matches with a fresh splitter: the separator's own lastIndex stays as it was
  const lastIndex: i32 = Porffor.IR.loadI32(separator, 8);

  if (thisLen == 0) {
    const e0: i32 = __Porffor_regex_interpretFrom(separator, str, 2, 0);
    out.length = 0;
    if (e0 == -1) Porffor.array.fastPush(out, str);
    Porffor.IR.storeI32(separator, 8, lastIndex);
    return out;
  }

  let p: i32 = 0;
  let q: i32 = 0;
  while (q < thisLen) {
    const e: i32 = __Porffor_regex_interpretFrom(separator, str, 2, q);
    if (e == -1) break;
    const mi: i32 = __Porffor_regex_matchStart();
    if (e == p) { // empty match at previous split point: advance
      q = mi + 1;
      if (uv && strType == Porffor.TYPES.string && q < thisLen) {
        const u1: i32 = Porffor.IR.loadU16(Porffor.IR.ptr(str) + (q - 1) * 2, 4);
        const u2: i32 = Porffor.IR.loadU16(Porffor.IR.ptr(str) + q * 2, 4);
        if (u1 >= 0xD800 && u1 <= 0xDBFF && u2 >= 0xDC00 && u2 <= 0xDFFF) q += 1;
      }
      continue;
    }

    outLen = Porffor.array.fastPush(out, __Porffor_regex_inputSubstring(str, strType, p, mi));
    if (outLen >= limit) { out.length = outLen; Porffor.IR.storeI32(separator, 8, lastIndex); return out; }
    for (let k: i32 = 0; k < nCaps; k++) {
      const cs: i32 = __Porffor_regex_capsRead(k * 2);
      const ce: i32 = __Porffor_regex_capsRead(k * 2 + 1);
      if (cs != -1 && ce != -1) outLen = Porffor.array.fastPush(out, __Porffor_regex_inputSubstring(str, strType, cs, ce));
        else outLen = Porffor.array.fastPush(out, undefined);
      if (outLen >= limit) { out.length = outLen; Porffor.IR.storeI32(separator, 8, lastIndex); return out; }
    }
    p = e;
    q = e;
  }

  outLen = Porffor.array.fastPush(out, __Porffor_regex_inputSubstring(str, strType, p, thisLen));
  out.length = outLen;
  Porffor.IR.storeI32(separator, 8, lastIndex);
  return out;
};

// split by a string separator: its matches found by SIMD search, the pieces between them
export const __Porffor_string_splitString = (str: any, separator: any, limit: number, out: any[]): any[] => {
  let outLen: i32 = 0;
  const len: i32 = str.length, sepLen: i32 = separator.length;
  if (sepLen == 0) {
    // every code unit on its own
    for (let i: i32 = 0; i < len && outLen < limit; i++) {
      outLen = Porffor.array.fastPush(out, __Porffor_string_substringLike(str, i, i + 1));
    }
    out.length = outLen;
    return out;
  }

  const hay: i32 = Porffor.IR.ptr(str), hayWide: i32 = __Porffor_string_wide(str);
  const sep: i32 = Porffor.IR.ptr(separator), sepWide: i32 = __Porffor_string_wide(separator);
  let start: i32 = 0;
  while (true) {
    const at: i32 = __Porffor_string_find(hay, hayWide, len, sep, sepWide, sepLen, start);
    if (at == -1) break;
    outLen = Porffor.array.fastPush(out, __Porffor_string_piece(str, start, at));
    if (outLen >= limit) {
      out.length = outLen;
      return out;
    }
    start = at + sepLen;
  }

  outLen = Porffor.array.fastPush(out, __Porffor_string_piece(str, start, len));
  out.length = outLen;
  return out;
};

export const __String_prototype_split = function (this: string, separator: any, limit: any) {
  const out: any[] = Porffor.array.new(4);
  let outLen: i32 = 0;

  if (Porffor.type(limit) == Porffor.TYPES.undefined) {
    limit = Number.MAX_SAFE_INTEGER;
  } else {
    limit = ecma262.ToIntegerOrInfinity(limit);
    if (limit < 0) limit = Number.MAX_SAFE_INTEGER;
  }

  if (Porffor.type(separator) == Porffor.TYPES.undefined) {
    if (limit == 0) {
      out.length = 0;
      return out;
    }

    out.length = 1;
    Porffor.IR.storeJv(Porffor.IR.loadI32(out, 4), 0, this);
    return out;
  }

  if (Porffor.type(separator) == Porffor.TYPES.regexp) {
    if (limit == 0) {
      out.length = 0;
      return out;
    }

    return __Porffor_string_splitRegex(this, separator, limit, out);
  }

  separator = ecma262.ToString(separator);
  if (limit == 0) {
    out.length = 0;
    return out;
  }

  return __Porffor_string_splitString(this, separator, limit, out);
};

export const __ByteString_prototype_split = function (this: bytestring, separator: any, limit: any) {
  const out: any[] = Porffor.array.new(4);
  let outLen: i32 = 0;

  if (Porffor.type(limit) == Porffor.TYPES.undefined) {
    limit = Number.MAX_SAFE_INTEGER;
  } else {
    limit = ecma262.ToIntegerOrInfinity(limit);
    if (limit < 0) limit = Number.MAX_SAFE_INTEGER;
  }

  if (Porffor.type(separator) == Porffor.TYPES.undefined) {
    if (limit == 0) {
      out.length = 0;
      return out;
    }

    out.length = 1;
    Porffor.IR.storeJv(Porffor.IR.loadI32(out, 4), 0, this);
    return out;
  }

  if (Porffor.type(separator) == Porffor.TYPES.regexp) {
    if (limit == 0) {
      out.length = 0;
      return out;
    }

    return __Porffor_string_splitRegex(this, separator, limit, out);
  }

  separator = ecma262.ToString(separator);
  if (limit == 0) {
    out.length = 0;
    return out;
  }

  return __Porffor_string_splitString(this, separator, limit, out);
};


export const __String_prototype_localeCompare = function (this: string, compareString: any) {
  compareString = ecma262.ToString(compareString);

  const thisLen: i32 = this.length;
  const compareLen: i32 = compareString.length;
  const maxLen: i32 = thisLen > compareLen ? thisLen : compareLen;
  const thisPtr: i32 = Porffor.IR.ptr(this);
  const comparePtr: i32 = Porffor.IR.ptr(compareString);
  const thisString: boolean = Porffor.type(this) == Porffor.TYPES.string;
  const compareStringType: i32 = Porffor.type(compareString);
  const compareStringString: boolean = compareStringType == Porffor.TYPES.string;

  for (let i: i32 = 0; i < maxLen; i++) {
    const a: i32 = thisString ? Porffor.IR.loadU16(thisPtr + i * 2, 4) : Porffor.IR.loadU8(thisPtr + i, 4);
    const b: i32 = compareStringString ? Porffor.IR.loadU16(comparePtr + i * 2, 4) : Porffor.IR.loadU8(comparePtr + i, 4);

    if (a > b) return 1;
    if (b > a) return -1;
  }

  if (thisLen > compareLen) return 1;
  if (compareLen > thisLen) return -1;

  return 0;
};

export const __ByteString_prototype_localeCompare = function (this: bytestring, compareString: any) {
  compareString = ecma262.ToString(compareString);

  const thisLen: i32 = this.length;
  const compareLen: i32 = compareString.length;
  const maxLen: i32 = thisLen > compareLen ? thisLen : compareLen;
  const thisPtr: i32 = Porffor.IR.ptr(this);
  const comparePtr: i32 = Porffor.IR.ptr(compareString);
  const compareStringType: i32 = Porffor.type(compareString);
  const compareStringString: boolean = compareStringType == Porffor.TYPES.string;

  for (let i: i32 = 0; i < maxLen; i++) {
    const a: i32 = Porffor.IR.loadU8(thisPtr + i, 4);
    const b: i32 = compareStringString ? Porffor.IR.loadU16(comparePtr + i * 2, 4) : Porffor.IR.loadU8(comparePtr + i, 4);

    if (a > b) return 1;
    if (b > a) return -1;
  }

  if (thisLen > compareLen) return 1;
  if (compareLen > thisLen) return -1;

  return 0;
};


export const __String_prototype_isWellFormed = function (this: string) {
  let ptr: i32 = Porffor.IR.ptr(this);
  const endPtr: i32 = ptr + this.length * 2;
  while (ptr < endPtr) {
    const c1: i32 = Porffor.IR.loadU16(ptr, 4);

    if (Porffor.fastAnd(c1 >= 0xDC00, c1 <= 0xDFFF)) {
      // lone trailing surrogate, bad
      return false;
    }

    if (Porffor.fastAnd(c1 >= 0xD800, c1 <= 0xDBFF)) {
      // leading surrogate, peek if next is trailing
      const c2: i32 = ptr + 2 < endPtr ? Porffor.IR.loadU16(ptr + 2, 4) : 0;

      if (Porffor.fastAnd(c2 >= 0xDC00, c2 <= 0xDFFF)) {
        // next is trailing surrogate, skip it too
        ptr += 2;
      } else {
        // lone leading surrogate, bad
        return false;
      }
    }

    ptr += 2;
  }

  return true;
};

export const __ByteString_prototype_isWellFormed = function (this: bytestring) {
  // bytestrings cannot have surrogates, so always true
  return true;
};

export const __String_prototype_toWellFormed = function (this: string) {
  const len: i32 = this.length;
  const out: string = Porffor.malloc(6 + len * 2);
  Porffor.IR.copy(out, this, 4 + len * 2);

  let ptr: i32 = Porffor.IR.ptr(out);
  const endPtr: i32 = ptr + len * 2;
  while (ptr < endPtr) {
    const c1: i32 = Porffor.IR.loadU16(ptr, 4);

    if (Porffor.fastAnd(c1 >= 0xDC00, c1 <= 0xDFFF)) {
      // lone trailing surrogate, bad
      Porffor.IR.storeU16(ptr, 4, 0xFFFD);
    }

    if (Porffor.fastAnd(c1 >= 0xD800, c1 <= 0xDBFF)) {
      // leading surrogate, peek if next is trailing
      const c2: i32 = ptr + 2 < endPtr ? Porffor.IR.loadU16(ptr + 2, 4) : 0;

      if (Porffor.fastAnd(c2 >= 0xDC00, c2 <= 0xDFFF)) {
        // next is trailing surrogate, skip it too
        ptr += 2;
      } else {
        // lone leading surrogate, bad
        Porffor.IR.storeU16(ptr, 4, 0xFFFD);
      }
    }

    ptr += 2;
  }

  return out;
};

export const __ByteString_prototype_toWellFormed = function (this: bytestring) {
  // bytestrings cannot have surrogates, so just return this
  return this;
};


// 22.1.3.29 String.prototype.toString ()
// https://tc39.es/ecma262/#sec-string.prototype.tostring
export const __String_prototype_toString = function (this: string) {
  // 1. Return ? ThisStringValue(this value).
  return this;
};

export const __ByteString_prototype_toString = function (this: bytestring) {
  // 1. Return ? ThisStringValue(this value).
  return this;
};

export const __String_prototype_toLocaleString = function (this: string) { return Porffor.callThis(__String_prototype_toString, this); };
export const __ByteString_prototype_toLocaleString = function (this: bytestring) { return Porffor.callThis(__ByteString_prototype_toString, this); };

// 22.1.3.35 String.prototype.valueOf ()
// https://tc39.es/ecma262/#sec-string.prototype.valueof
export const __String_prototype_valueOf = function (this: string) {
  // 1. Return ? ThisStringValue(this value).
  return this;
};

export const __ByteString_prototype_valueOf = function (this: bytestring) {
  // 1. Return ? ThisStringValue(this value).
  return this;
};
