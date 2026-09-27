import type {} from './porffor.d.ts';

// JSON.stringify and JSON.parse.
//
// stringify writes one byte buffer, in one pass: an offset into it is what the serializer
// passes around, so the buffer can grow (and move) as it fills. A code unit above 0xff is
// written as the marker byte 0x01 and its two bytes (never raw in JSON output: control
// characters are escaped), and the result widened to a UTF-16 string at the end. Strings are
// scanned for what needs escaping and copied in runs; a plain object's own entries are
// walked directly (own enumerable properties, index keys first, as EnumerableOwnProperties
// orders them); integers are written as digits.
//
// parse reads the text's characters straight from memory (a byte or two a character), makes
// a string without escapes in one copy, numbers without making a string, and reuses the
// strings of keys it has just seen.

// the buffer: a byte string, [u32 length][bytes]; offsets count from its first byte. A GC
// root while it is filled (render.js marks it, as the underlying store)
let __Porffor_json_buf: i32 = 0;
let __Porffor_json_cap: i32 = 0;
// set when a serialized string held a code unit above 0xff
let __Porffor_json_wide: boolean = false;
// the replacer: a function called on every value, or an array's list of the keys to write
let __Porffor_json_replacer: any = undefined;
let __Porffor_json_allow: any = undefined;
// set by putProperty, putEntry and putEntries when they wrote nothing (the offset they
// return is then the one they were given); read right after the call
let __Porffor_json_skipped: boolean = false;

// room for n more bytes at off, the buffer moved to a bigger one if there is not
export const __Porffor_json_ensure = (off: i32, n: i32): void => {
  if (off + n <= __Porffor_json_cap) return;
  let cap: i32 = __Porffor_json_cap * 2;
  while (cap < off + n) cap *= 2;
  const grown: i32 = Porffor.malloc(8 + cap);
  Porffor.IR.copy(grown + 4, __Porffor_json_buf + 4, off);
  __Porffor_json_buf = grown;
  __Porffor_json_cap = cap;
};

export const __Porffor_json_putChar = (off: i32, c: i32): i32 => {
  __Porffor_json_ensure(off, 1);
  Porffor.IR.storeU8(__Porffor_json_buf + off, 4, c);
  return off + 1;
};

export const __Porffor_json_put2 = (off: i32, c1: i32, c2: i32): i32 => {
  __Porffor_json_ensure(off, 2);
  Porffor.IR.storeU8(__Porffor_json_buf + off, 4, c1);
  Porffor.IR.storeU8(__Porffor_json_buf + off, 5, c2);
  return off + 2;
};

// a one-byte string's bytes, as they are
export const __Porffor_json_putBytes = (off: i32, str: bytestring): i32 => {
  const len: i32 = str.length;
  __Porffor_json_ensure(off, len);
  Porffor.IR.copy(__Porffor_json_buf + 4 + off, Porffor.IR.ptr(str) + 4, len);
  return off + len;
};

// \uXXXX, lowercase as the spec's UnicodeEscape
export const __Porffor_json_putEscape = (off: i32, c: i32): i32 => {
  off = __Porffor_json_put2(off, 92, 117);
  for (let shift: i32 = 12; shift >= 0; shift -= 4) {
    const h: i32 = (c >> shift) & 0xf;
    off = __Porffor_json_putChar(off, h < 10 ? h + 48 : h + 87);
  }
  return off;
};

// the escape of a code unit below 0x20, a quote or a backslash
export const __Porffor_json_putEscaped = (off: i32, c: i32): i32 => {
  if (c == 0x22) return __Porffor_json_put2(off, 92, 34); // \"
  if (c == 0x5c) return __Porffor_json_put2(off, 92, 92); // \\
  if (c == 0x08) return __Porffor_json_put2(off, 92, 98); // \b
  if (c == 0x09) return __Porffor_json_put2(off, 92, 116); // \t
  if (c == 0x0a) return __Porffor_json_put2(off, 92, 110); // \n
  if (c == 0x0c) return __Porffor_json_put2(off, 92, 102); // \f
  if (c == 0x0d) return __Porffor_json_put2(off, 92, 114); // \r
  return __Porffor_json_putEscape(off, c);
};

// a string, quoted and escaped (QuoteJSONString)
export const __Porffor_json_putString = (off: i32, str: any): i32 => {
  off = __Porffor_json_putChar(off, 34);
  const len: i32 = str.length;
  const p: i32 = Porffor.IR.ptr(str);

  if (Porffor.type(str) == Porffor.TYPES.bytestring) {
    // runs of bytes that need no escape are copied as they are
    let i: i32 = 0;
    while (i < len) {
      const runStart: i32 = i;
      while (i < len) {
        const c: i32 = Porffor.IR.loadU8(p + i, 4);
        if (Porffor.fastOr(c < 0x20, c == 0x22, c == 0x5c)) break;
        i++;
      }
      if (i > runStart) {
        __Porffor_json_ensure(off, i - runStart);
        Porffor.IR.copy(__Porffor_json_buf + 4 + off, p + 4 + runStart, i - runStart);
        off += i - runStart;
      }
      if (i < len) off = __Porffor_json_putEscaped(off, Porffor.IR.loadU8(p + i++, 4));
    }
    return __Porffor_json_putChar(off, 34);
  }

  // UTF-16
  for (let i: i32 = 0; i < len; i++) {
    const c: i32 = Porffor.IR.loadU16(p + i * 2, 4);
    if (Porffor.fastOr(c < 0x20, c == 0x22, c == 0x5c)) {
      off = __Porffor_json_putEscaped(off, c);
      continue;
    }
    if (c <= 0xff) {
      off = __Porffor_json_putChar(off, c);
      continue;
    }
    // a lone surrogate stays escaped (well-formed JSON.stringify)
    if (Porffor.fastAnd(c >= 0xd800, c <= 0xdfff)) {
      const next: i32 = i + 1 < len ? Porffor.IR.loadU16(p + (i + 1) * 2, 4) : 0;
      const prev: i32 = i > 0 ? Porffor.IR.loadU16(p + (i - 1) * 2, 4) : 0;
      const paired: boolean = c <= 0xdbff ? Porffor.fastAnd(next >= 0xdc00, next <= 0xdfff) : Porffor.fastAnd(prev >= 0xd800, prev <= 0xdbff);
      if (!paired) {
        off = __Porffor_json_putEscape(off, c);
        continue;
      }
    }
    // the marker, then the unit's two bytes: stringify widens the result
    __Porffor_json_wide = true;
    off = __Porffor_json_putChar(off, 1);
    off = __Porffor_json_put2(off, c >> 8, c & 0xff);
  }
  return __Porffor_json_putChar(off, 34);
};

// a finite number: an integer's digits written here, anything else as Number::toString
export const __Porffor_json_putNumber = (off: i32, n: number): i32 => {
  if (Porffor.fastAnd(n == Math.trunc(n), n < 1e15, n > -1e15)) {
    let v: number = n;
    if (v < 0) {
      off = __Porffor_json_putChar(off, 45);
      v = -v;
    }
    let digits: i32 = 1;
    let scale: number = 1;
    while (scale * 10 <= v) {
      scale *= 10;
      digits++;
    }
    __Porffor_json_ensure(off, digits);
    let at: i32 = off + digits - 1;
    for (let d: i32 = 0; d < digits; d++) {
      const q: number = Math.trunc(v / 10);
      const digit: i32 = v - q * 10;
      Porffor.IR.storeU8(__Porffor_json_buf + at, 4, 48 + digit);
      v = q;
      at--;
    }
    return off + digits;
  }
  return __Porffor_json_putBytes(off, Porffor.callThis(__Number_prototype_toString, n, 10));
};

// whether a value is serialized at all (undefined, functions and symbols are not)
export const __Porffor_json_canSerialize = (value: any): boolean => {
  const t: i32 = Porffor.type(value);
  if (Porffor.fastOr(t == Porffor.TYPES.undefined, t == Porffor.TYPES.function, t == Porffor.TYPES.symbol)) return false;
  return true;
};

// a key that is an array index (canonical: digits, no leading zero, below 2^32 - 1): such
// keys come first, ascending, in an object's own keys
export const __Porffor_json_indexKey = (key: any): number => {
  if ((Porffor.type(key) | 0b10000000) != Porffor.TYPES.bytestring) return -1;
  const len: i32 = key.length;
  if (Porffor.fastOr(len == 0, len > 10)) return -1;
  let n: number = 0;
  for (let i: i32 = 0; i < len; i++) {
    const c: i32 = key.charCodeAt(i);
    if (Porffor.fastOr(c < 48, c > 57)) return -1;
    if (Porffor.fastAnd(i == 0, c == 48, len > 1)) return -1;
    n = n * 10 + (c - 48);
  }
  if (n >= 4294967295) return -1;
  return n;
};

// one property: "key":value (or nothing, when the value is not serialized)
export const __Porffor_json_putProperty = (off: i32, holder: any, key: any, val: any, depth: i32, space: any, first: boolean): i32 => {
  const was: i32 = off;
  if (!first) off = __Porffor_json_putChar(off, 44); // ,
  if (space !== undefined) {
    off = __Porffor_json_putChar(off, 10);
    for (let i: i32 = 0; i < depth; i++) off = __Porffor_json_putBytes(off, space);
  }
  off = __Porffor_json_putString(off, key);
  off = __Porffor_json_putChar(off, 58); // :
  if (space !== undefined) off = __Porffor_json_putChar(off, 32);
  const end: i32 = __Porffor_json_serialize(off, holder, val, key, depth, space);
  // nothing to write: the property is left out
  __Porffor_json_skipped = end == -1;
  if (end == -1) return was;
  return end;
};

// an object's own enumerable string-keyed data, walked from its entries: index keys first,
// ascending, then the rest in the order they were made. The keys are those it has now; a
// getter adding one does not add to them
export const __Porffor_json_putEntries = (off: i32, holder: any, obj: any, depth: i32, space: any): i32 => {
  const count: i32 = Porffor.IR.loadU16(obj, 0);
  let first: boolean = true;

  // index keys, if there are any
  let indices: any = null;
  for (let i: i32 = 0; i < count; i++) {
    const entryPtr: i32 = Porffor.IR.loadI32(obj, 12) + i * 20;
    if (Porffor.IR.loadU8(entryPtr, 18) == Porffor.TYPES.symbol) continue;
    const key: any = Porffor.as(Porffor.IR.loadI32(entryPtr, 4), Porffor.IR.loadU8(entryPtr, 18));
    const index: number = __Porffor_json_indexKey(key);
    if (index != -1) {
      if (indices == null) indices = Porffor.array.new(4);
      Porffor.array.fastPush(indices, index);
      Porffor.array.fastPush(indices, i);
    }
  }
  if (indices != null) {
    // insertion sort of (index, entry) pairs: few, and usually in order already
    const pairs: i32 = indices.length / 2;
    for (let a: i32 = 1; a < pairs; a++) {
      const ki: number = indices[a * 2];
      const ei: number = indices[a * 2 + 1];
      let b: i32 = a - 1;
      while (b >= 0) {
        if (indices[b * 2] <= ki) break;
        indices[(b + 1) * 2] = indices[b * 2];
        indices[(b + 1) * 2 + 1] = indices[b * 2 + 1];
        b--;
      }
      indices[(b + 1) * 2] = ki;
      indices[(b + 1) * 2 + 1] = ei;
    }
    for (let a: i32 = 0; a < pairs; a++) {
      const i: i32 = indices[a * 2 + 1];
      off = __Porffor_json_putEntry(off, holder, obj, i, depth, space, first);
      if (!__Porffor_json_skipped) first = false;
    }
  }

  for (let i: i32 = 0; i < count; i++) {
    const entryPtr: i32 = Porffor.IR.loadI32(obj, 12) + i * 20;
    if (Porffor.IR.loadU8(entryPtr, 18) == Porffor.TYPES.symbol) continue;
    if (indices != null) if (__Porffor_json_indexKey(Porffor.as(Porffor.IR.loadI32(entryPtr, 4), Porffor.IR.loadU8(entryPtr, 18))) != -1) continue;
    off = __Porffor_json_putEntry(off, holder, obj, i, depth, space, first);
    if (!__Porffor_json_skipped) first = false;
  }
  __Porffor_json_skipped = first;
  return off;
};

// entry i of obj, if enumerable: the offset after it (skipped set when nothing was written)
export const __Porffor_json_putEntry = (off: i32, holder: any, obj: any, i: i32, depth: i32, space: any, first: boolean): i32 => {
  __Porffor_json_skipped = true;
  if (i >= Porffor.IR.loadU16(obj, 0)) return off;
  const entryPtr: i32 = Porffor.IR.loadI32(obj, 12) + i * 20;
  const flags: i32 = Porffor.IR.loadU8(entryPtr, 16);
  if ((flags & 0b0100) == 0) return off; // not enumerable
  const key: any = Porffor.as(Porffor.IR.loadI32(entryPtr, 4), Porffor.IR.loadU8(entryPtr, 18));
  let val: any = undefined;
  if (flags & 0b0001) {
    const get: any = __Porffor_object_accessorGet(entryPtr);
    if (get != null) val = Porffor.callThis(get, holder);
  } else val = __Porffor_object_readValue(entryPtr);
  return __Porffor_json_putProperty(off, holder, key, val, depth, space, first);
};

// SerializeJSONProperty: the offset after the value, or -1 when it is not serialized
export const __Porffor_json_serialize = (off: i32, holder: any, value: any, key: any, depth: i32, space: any): i32 => {
  let t: i32 = Porffor.type(value);

  // toJSON (a Date's, or any object's; key is an array element's index as a number)
  if (Porffor.fastAnd(t > Porffor.TYPES.function, (t | 0b10000000) != Porffor.TYPES.bytestring, value !== null)) {
    const toJSON: any = value.toJSON;
    if (Porffor.type(toJSON) == Porffor.TYPES.function) {
      if (Porffor.type(key) == Porffor.TYPES.number) key = Porffor.callThis(__Number_prototype_toString, key, 10);
      value = Porffor.callThis(toJSON, value, key);
      t = Porffor.type(value);
    }
  }

  // boxed primitives are their primitive
  if (t == Porffor.TYPES.numberobject) {
    value = ecma262.ToNumber(value);
    t = Porffor.TYPES.number;
  } else if (t == Porffor.TYPES.stringobject) {
    value = ecma262.ToString(value);
    t = Porffor.type(value);
  } else if (t == Porffor.TYPES.booleanobject) {
    value = Porffor.callThis(__Boolean_prototype_valueOf, value);
    t = Porffor.TYPES.boolean;
  }

  if (value === null) return __Porffor_json_putBytes(off, 'null');
  if (value === true) return __Porffor_json_putBytes(off, 'true');
  if (value === false) return __Porffor_json_putBytes(off, 'false');
  if ((t | 0b10000000) == Porffor.TYPES.bytestring) return __Porffor_json_putString(off, value);
  if (t == Porffor.TYPES.number) {
    if (Number.isFinite(value)) return __Porffor_json_putNumber(off, value);
    return __Porffor_json_putBytes(off, 'null');
  }
  if (t == Porffor.TYPES.bigint) throw new TypeError('Cannot serialize BigInts');
  if (!__Porffor_json_canSerialize(value)) return -1;

  const hasSpace: boolean = space !== undefined;

  if (t == Porffor.TYPES.array) {
    off = __Porffor_json_putChar(off, 91); // [
    const len: i32 = (value as any[]).length;
    for (let i: i32 = 0; i < len; i++) {
      if (i > 0) off = __Porffor_json_putChar(off, 44); // ,
      if (hasSpace) {
        off = __Porffor_json_putChar(off, 10);
        for (let d: i32 = 0; d <= depth; d++) off = __Porffor_json_putBytes(off, space);
      }
      const x: any = (value as any[])[i];
      const end: i32 = __Porffor_json_serialize(off, value, x, i, depth + 1, space);
      off = end == -1 ? __Porffor_json_putBytes(off, 'null') : end;
    }
    if (Porffor.fastAnd(hasSpace, len > 0)) {
      off = __Porffor_json_putChar(off, 10);
      for (let d: i32 = 0; d < depth; d++) off = __Porffor_json_putBytes(off, space);
    }
    return __Porffor_json_putChar(off, 93); // ]
  }

  // an object: its own enumerable properties. A plain object's are its entries; another
  // kind (a Map, a RegExp, a Date without toJSON...) has them in its side table, if it has
  // any. Typed arrays (indexed elements) and proxies (traps) go through for-in
  let entries: any = null;
  if (t == Porffor.TYPES.object) entries = value;
    else if (Porffor.fastAnd(t != Porffor.TYPES.proxy, Porffor.fastOr(t < Porffor.TYPES.uint8clampedarray, t > Porffor.TYPES.float64array))) {
      entries = __Porffor_object_underlyingFind(value);
      if (Porffor.IR.ptr(entries) == 0) return __Porffor_json_putBytes(off, '{}');
    }

  off = __Porffor_json_putChar(off, 123); // {
  let empty: boolean = true;
  if (entries != null) {
    off = __Porffor_json_putEntries(off, value, entries, depth + 1, space);
    empty = __Porffor_json_skipped;
  } else {
    for (const k in (value as object)) {
      if (Porffor.type(k) == Porffor.TYPES.symbol) continue;
      off = __Porffor_json_putProperty(off, value, k, (value as object)[k], depth + 1, space, empty);
      if (!__Porffor_json_skipped) empty = false;
    }
  }
  if (Porffor.fastAnd(hasSpace, !empty)) {
    off = __Porffor_json_putChar(off, 10);
    for (let d: i32 = 0; d < depth; d++) off = __Porffor_json_putBytes(off, space);
  }
  return __Porffor_json_putChar(off, 125); // }
};

export const __JSON_stringify = (value: any, replacer: any, space: any) => {
  // todo: replacer

  if (space !== undefined) {
    if (Porffor.fastOr(
      Porffor.type(space) == Porffor.TYPES.number,
      Porffor.type(space) == Porffor.TYPES.numberobject
    )) {
      space = Math.min(Math.trunc(space), 10);

      if (space < 1) {
        space = undefined;
      } else {
        const spaceStr: bytestring = Porffor.malloc(6 + space);
        Porffor.IR.storeI32(spaceStr, 0, 0);
        for (let i: i32 = 0; i < space; i++) Porffor.bytestring.appendChar(spaceStr, 32);

        space = spaceStr;
      }
    } else if (Porffor.fastOr(
      (Porffor.type(space) | 0b10000000) == Porffor.TYPES.bytestring,
      Porffor.type(space) == Porffor.TYPES.stringobject
    )) {
      // if empty, make it undefined
      const len: i32 = space.length;
      if (len == 0) {
        space = undefined;
      } else if (len > 10) {
        space = space.slice(0, 10);
      }
    } else {
      // not a number or string, make it undefined
      space = undefined;
    }
  }

  // a getter or toJSON may stringify too: the buffer being filled is put back after
  const outerBuf: i32 = __Porffor_json_buf;
  const outerCap: i32 = __Porffor_json_cap;
  const outerWide: boolean = __Porffor_json_wide;

  __Porffor_json_cap = 4096;
  __Porffor_json_buf = Porffor.malloc(8 + __Porffor_json_cap);
  __Porffor_json_wide = false;
  const root: any = undefined;
  const len: i32 = __Porffor_json_serialize(0, root, value, '', 0, space);
  const buffer: bytestring = __Porffor_json_buf as bytestring;
  const wideOut: boolean = __Porffor_json_wide;

  __Porffor_json_buf = outerBuf;
  __Porffor_json_cap = outerCap;
  __Porffor_json_wide = outerWide;

  if (len == -1) return undefined;

  Porffor.IR.storeI32(buffer, 0, len);
  if (!wideOut) return buffer;

  // widen: every byte is a code unit, except a marker (0x01) and the two bytes of the
  // unit it stands for
  let units: i32 = 0;
  for (let i: i32 = 0; i < len; i++) {
    if (Porffor.IR.loadU8(Porffor.IR.ptr(buffer) + i, 4) == 1) i += 2;
    units++;
  }
  const wide: string = Porffor.malloc(4 + units * 2);
  wide.length = units;
  let w: i32 = Porffor.IR.ptr(wide);
  for (let i: i32 = 0; i < len; i++) {
    const b: i32 = Porffor.IR.loadU8(Porffor.IR.ptr(buffer) + i, 4);
    if (b == 1) {
      Porffor.IR.storeU16(w, 4, (Porffor.IR.loadU8(Porffor.IR.ptr(buffer) + i + 1, 4) << 8) | Porffor.IR.loadU8(Porffor.IR.ptr(buffer) + i + 2, 4));
      i += 2;
    } else Porffor.IR.storeU16(w, 4, b);
    w += 2;
  }
  return wide;
};


// ---- parse ----

// the text's code unit at i: its bytes are at base (+ 4), one or two a unit
export const __Porffor_json_at = (base: i32, wide: boolean, i: i32): i32 => {
  if (wide) return Porffor.IR.loadU16(base + i * 2, 4);
  return Porffor.IR.loadU8(base + i, 4);
};

export const __Porffor_json_skipWhitespace = (base: i32, wide: boolean, pos: i32, len: i32): i32 => {
  while (pos < len) {
    const c: i32 = __Porffor_json_at(base, wide, pos);
    if (c > 32) break;
    if (Porffor.fastOr(c == 32, c == 9, c == 10, c == 13)) pos++;
      else break;
  }
  return pos;
};

// keys just seen, reused: an array of records has the same few keys over and over
let __Porffor_json_keys: any = undefined;

// the string from start to end (the closing quote), none of it escaped: made in one copy,
// one byte a character when every one fits
export const __Porffor_json_plainString = (base: i32, wide: boolean, start: i32, end: i32, maxUnit: i32, isKey: boolean): any => {
  const n: i32 = end - start;

  // a key seen lately: its string again
  let slot: i32 = 0;
  if (Porffor.fastAnd(isKey, maxUnit <= 0xff, n > 0, n <= 24)) {
    let h: i32 = n;
    for (let i: i32 = start; i < end; i++) h = (h * 31 + __Porffor_json_at(base, wide, i)) & 255;
    slot = h;
    if (__Porffor_json_keys === undefined) {
      __Porffor_json_keys = Porffor.array.new(256);
      for (let i: i32 = 0; i < 256; i++) __Porffor_json_keys[i] = undefined;
    }
    const seen: any = __Porffor_json_keys[slot];
    if (seen !== undefined) if (seen.length == n) {
      const sp: i32 = Porffor.IR.ptr(seen);
      let same: boolean = true;
      for (let i: i32 = 0; i < n; i++) {
        if (Porffor.IR.loadU8(sp + i, 4) != __Porffor_json_at(base, wide, start + i)) {
          same = false;
          break;
        }
      }
      if (same) return seen;
    }
  }

  if (maxUnit > 0xff) {
    const out: string = Porffor.malloc(4 + n * 2);
    Porffor.IR.copy(Porffor.IR.ptr(out) + 4, base + 4 + start * 2, n * 2);
    out.length = n;
    return out;
  }

  const out: bytestring = Porffor.malloc(6 + n);
  if (wide) {
    const op: i32 = Porffor.IR.ptr(out);
    for (let i: i32 = 0; i < n; i++) Porffor.IR.storeU8(op + i, 4, Porffor.IR.loadU16(base + (start + i) * 2, 4));
  } else Porffor.IR.copy(Porffor.IR.ptr(out) + 4, base + 4 + start, n);
  out.length = n;
  if (Porffor.fastAnd(isKey, n > 0, n <= 24)) __Porffor_json_keys[slot] = out;
  return out;
};

// the string at pos (its opening quote), pos left after its closing one
export const __Porffor_json_parseString = (base: i32, wide: boolean, posPtr: i32, len: i32, isKey: boolean): any => {
  let pos: i32 = Porffor.IR.loadI32(posPtr, 0) + 1;
  const start: i32 = pos;
  let escaped: boolean = false;
  let maxUnit: i32 = 0;
  while (true) {
    if (pos >= len) throw new SyntaxError('Unterminated string');
    const ch: i32 = __Porffor_json_at(base, wide, pos);
    if (ch == 34) break;
    if (ch == 92) {
      escaped = true;
      pos += 2;
      continue;
    }
    if (ch <= 0x1f) throw new SyntaxError('Unescaped control character');
    if (ch > maxUnit) maxUnit = ch;
    pos++;
  }
  if (pos > len) throw new SyntaxError('Unterminated string');
  const end: i32 = pos;
  Porffor.IR.storeI32(posPtr, 0, end + 1);
  if (!escaped) return __Porffor_json_plainString(base, wide, start, end, maxUnit, isKey);

  // escapes: decoded as UTF-16 (never longer than the source), then narrowed to a byte
  // string when every code unit fits in one
  const tmp: string = Porffor.malloc(4 + (end - start) * 2);
  const tmpPtr: i32 = Porffor.IR.ptr(tmp);
  let n: i32 = 0;
  maxUnit = 0;
  pos = start;
  while (pos < end) {
    let unit: i32 = __Porffor_json_at(base, wide, pos++);
    if (unit == 92) { // backslash
      const esc: i32 = __Porffor_json_at(base, wide, pos++);
      if (esc == 34) unit = 34; // \"
        else if (esc == 92) unit = 92; // \\
        else if (esc == 47) unit = 47; // \/
        else if (esc == 98) unit = 8; // \b
        else if (esc == 102) unit = 12; // \f
        else if (esc == 110) unit = 10; // \n
        else if (esc == 114) unit = 13; // \r
        else if (esc == 116) unit = 9; // \t
        else if (esc == 117) { // \u
          if (pos + 4 > end) throw new SyntaxError('Invalid unicode escape');
          unit = 0;
          for (let i: i32 = 0; i < 4; i++) {
            const hex: i32 = __Porffor_json_at(base, wide, pos + i);
            unit <<= 4;
            if (Porffor.fastAnd(hex >= 48, hex <= 57)) unit |= hex - 48; // 0-9
              else if (Porffor.fastAnd(hex >= 65, hex <= 70)) unit |= hex - 55; // A-F
              else if (Porffor.fastAnd(hex >= 97, hex <= 102)) unit |= hex - 87; // a-f
              else throw new SyntaxError('Invalid unicode escape');
          }
          pos += 4;
        } else throw new SyntaxError('Invalid escape sequence');
    }

    Porffor.IR.storeU16(tmpPtr + n * 2, 4, unit);
    n++;
    if (unit > maxUnit) maxUnit = unit;
  }

  if (maxUnit > 0xff) {
    tmp.length = n;
    return tmp;
  }
  const out: bytestring = Porffor.malloc(6 + n);
  const outPtr: i32 = Porffor.IR.ptr(out);
  for (let i: i32 = 0; i < n; i++) Porffor.IR.storeU8(outPtr + i, 4, Porffor.IR.loadU16(tmpPtr + i * 2, 4));
  out.length = n;
  return out;
};

// a number, by the JSON grammar: -? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?. An
// integer of up to 15 digits is added up here; any other goes through StringToNumber
export const __Porffor_json_parseNumber = (text: any, base: i32, wide: boolean, posPtr: i32, len: i32): number => {
  let pos: i32 = Porffor.IR.loadI32(posPtr, 0);
  const start: i32 = pos;
  let neg: boolean = false;
  if (__Porffor_json_at(base, wide, pos) == 45) {
    neg = true;
    pos++;
  }
  if (pos >= len) throw new SyntaxError('Invalid number');
  let c: i32 = __Porffor_json_at(base, wide, pos);
  let acc: number = 0;
  let digits: i32 = 0;
  if (c == 48) {
    pos++;
    digits = 1;
  } else if (Porffor.fastAnd(c >= 49, c <= 57)) {
    while (pos < len) {
      c = __Porffor_json_at(base, wide, pos);
      if (Porffor.fastOr(c < 48, c > 57)) break;
      acc = acc * 10 + (c - 48);
      digits++;
      pos++;
    }
  } else throw new SyntaxError('Invalid number');

  let simple: boolean = digits <= 15;
  if (pos < len) {
    c = __Porffor_json_at(base, wide, pos);
    if (c == 46) { // .
      simple = false;
      pos++;
      const fracStart: i32 = pos;
      while (pos < len) {
        c = __Porffor_json_at(base, wide, pos);
        if (Porffor.fastOr(c < 48, c > 57)) break;
        pos++;
      }
      if (pos == fracStart) throw new SyntaxError('Invalid number');
    }
  }
  if (pos < len) {
    c = __Porffor_json_at(base, wide, pos);
    if (Porffor.fastOr(c == 101, c == 69)) { // e E
      simple = false;
      pos++;
      if (pos < len) {
        c = __Porffor_json_at(base, wide, pos);
        if (Porffor.fastOr(c == 43, c == 45)) pos++;
      }
      const expStart: i32 = pos;
      while (pos < len) {
        c = __Porffor_json_at(base, wide, pos);
        if (Porffor.fastOr(c < 48, c > 57)) break;
        pos++;
      }
      if (pos == expStart) throw new SyntaxError('Invalid number');
    }
  }

  Porffor.IR.storeI32(posPtr, 0, pos);
  if (simple) return neg ? -acc : acc;
  // the number's own characters, sliced as the text's kind of string
  if (wide) return ecma262.StringToNumber(Porffor.callThis(__String_prototype_slice, text, start, pos));
  return ecma262.StringToNumber(Porffor.callThis(__ByteString_prototype_slice, text, start, pos));
};

export const __Porffor_json_parseValue = (text: any, base: i32, wide: boolean, posPtr: i32, len: i32): any => {
  let pos: i32 = __Porffor_json_skipWhitespace(base, wide, Porffor.IR.loadI32(posPtr, 0), len);
  if (pos >= len) throw new SyntaxError('Unexpected end of JSON input');

  const c: i32 = __Porffor_json_at(base, wide, pos);
  if (c == 34) { // '"' - string
    Porffor.IR.storeI32(posPtr, 0, pos);
    return __Porffor_json_parseString(base, wide, posPtr, len, false);
  }

  if (Porffor.fastOr(Porffor.fastAnd(c >= 48, c <= 57), c == 45)) { // number
    Porffor.IR.storeI32(posPtr, 0, pos);
    return __Porffor_json_parseNumber(text, base, wide, posPtr, len);
  }

  if (c == 123) { // '{' - object
    const obj: any = {};
    pos = __Porffor_json_skipWhitespace(base, wide, pos + 1, len);
    if (Porffor.fastAnd(pos < len, __Porffor_json_at(base, wide, pos) == 125)) { // empty object
      Porffor.IR.storeI32(posPtr, 0, pos + 1);
      return obj;
    }

    while (true) {
      pos = __Porffor_json_skipWhitespace(base, wide, pos, len);
      if (Porffor.fastOr(pos >= len, __Porffor_json_at(base, wide, pos) != 34)) throw new SyntaxError('Expected string key');
      Porffor.IR.storeI32(posPtr, 0, pos);
      const key: any = __Porffor_json_parseString(base, wide, posPtr, len, true);

      pos = __Porffor_json_skipWhitespace(base, wide, Porffor.IR.loadI32(posPtr, 0), len);
      if (Porffor.fastOr(pos >= len, __Porffor_json_at(base, wide, pos) != 58)) throw new SyntaxError('Expected :');
      Porffor.IR.storeI32(posPtr, 0, pos + 1);
      const value: any = __Porffor_json_parseValue(text, base, wide, posPtr, len);
      obj[key] = value;

      pos = __Porffor_json_skipWhitespace(base, wide, Porffor.IR.loadI32(posPtr, 0), len);
      if (pos >= len) throw new SyntaxError('Unterminated object');
      const next: i32 = __Porffor_json_at(base, wide, pos);
      if (next == 125) { // }
        Porffor.IR.storeI32(posPtr, 0, pos + 1);
        return obj;
      }
      if (next != 44) throw new SyntaxError('Expected , or }');
      pos++;
    }
  }

  if (c == 91) { // '[' - array
    const arr: any[] = Porffor.array.new(4);
    pos = __Porffor_json_skipWhitespace(base, wide, pos + 1, len);
    if (Porffor.fastAnd(pos < len, __Porffor_json_at(base, wide, pos) == 93)) { // empty array
      Porffor.IR.storeI32(posPtr, 0, pos + 1);
      return arr;
    }

    while (true) {
      Porffor.IR.storeI32(posPtr, 0, pos);
      Porffor.array.fastPush(arr, __Porffor_json_parseValue(text, base, wide, posPtr, len));
      pos = __Porffor_json_skipWhitespace(base, wide, Porffor.IR.loadI32(posPtr, 0), len);
      if (pos >= len) throw new SyntaxError('Unterminated array');
      const next: i32 = __Porffor_json_at(base, wide, pos);
      if (next == 93) { // ]
        Porffor.IR.storeI32(posPtr, 0, pos + 1);
        return arr;
      }
      if (next != 44) throw new SyntaxError('Expected , or ]');
      pos++;
    }
  }

  if (c == 110) { // 'n' - null
    if (Porffor.fastAnd(pos + 4 <= len, __Porffor_json_at(base, wide, pos + 1) == 117, __Porffor_json_at(base, wide, pos + 2) == 108, __Porffor_json_at(base, wide, pos + 3) == 108)) {
      Porffor.IR.storeI32(posPtr, 0, pos + 4);
      return null;
    }
    throw new SyntaxError('Unexpected token');
  }

  if (c == 116) { // 't' - true
    if (Porffor.fastAnd(pos + 4 <= len, __Porffor_json_at(base, wide, pos + 1) == 114, __Porffor_json_at(base, wide, pos + 2) == 117, __Porffor_json_at(base, wide, pos + 3) == 101)) {
      Porffor.IR.storeI32(posPtr, 0, pos + 4);
      return true;
    }
    throw new SyntaxError('Unexpected token');
  }

  if (c == 102) { // 'f' - false
    if (Porffor.fastAnd(pos + 5 <= len, __Porffor_json_at(base, wide, pos + 1) == 97, __Porffor_json_at(base, wide, pos + 2) == 108, __Porffor_json_at(base, wide, pos + 3) == 115, __Porffor_json_at(base, wide, pos + 4) == 101)) {
      Porffor.IR.storeI32(posPtr, 0, pos + 5);
      return false;
    }
    throw new SyntaxError('Unexpected token');
  }

  throw new SyntaxError('Unexpected token');
};

// InternalizeJSONProperty: the reviver called on every value, innermost first
export const __Porffor_json_revive = (holder: any, key: any, reviver: any): any => {
  const val: any = holder[key];
  if (Porffor.type(val) == Porffor.TYPES.array) {
    const len: i32 = (val as any[]).length;
    for (let i: i32 = 0; i < len; i++) {
      const k: any = Porffor.callThis(__Number_prototype_toString, i, 10);
      const el: any = __Porffor_json_revive(val, k, reviver);
      if (el === undefined) delete val[k];
        else val[k] = el;
    }
  } else if (Porffor.fastAnd(Porffor.type(val) == Porffor.TYPES.object, val !== null)) {
    const keys: any[] = __Object_keys(val);
    const len: i32 = keys.length;
    for (let i: i32 = 0; i < len; i++) {
      const k: any = keys[i];
      const el: any = __Porffor_json_revive(val, k, reviver);
      if (el === undefined) delete val[k];
        else val[k] = el;
    }
  }
  return Porffor.callThis(reviver, holder, key, val);
};

// not typed bytestring: that annotation re-tags a UTF-16 string, which then reads as bytes
export const __JSON_parse = (_: any, reviver: any) => {
  const text: any = ecma262.ToString(_);
  const len: i32 = text.length;
  const base: i32 = Porffor.IR.ptr(text);
  const wide: boolean = Porffor.type(text) == Porffor.TYPES.string;
  const posPtr: i32 = Porffor.malloc(4);
  Porffor.IR.storeI32(posPtr, 0, 0);

  const value: any = __Porffor_json_parseValue(text, base, wide, posPtr, len);
  if (__Porffor_json_skipWhitespace(base, wide, Porffor.IR.loadI32(posPtr, 0), len) != len) throw new SyntaxError('Unexpected token after JSON');

  if (Porffor.type(reviver) == Porffor.TYPES.function) {
    const root: object = {};
    root[''] = value;
    return __Porffor_json_revive(root, '', reviver);
  }
  return value;
};
