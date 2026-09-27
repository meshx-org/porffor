import type {} from './porffor.d.ts';

// TextEncoder and TextDecoder (WHATWG Encoding Standard), UTF-8 only.
// https://encoding.spec.whatwg.org/
//
// The legacy encodings a full TextDecoder supports need index tables of a few hundred
// KB, and the label that picks one is a runtime string, so they could not be compiled
// out of a program that did not use them. Any other label is a RangeError, the spec's
// answer to an unsupported one.
//
// Neither object holds a JS value: the collector marks their blocks and, as for any type
// porf_gc_scan_body does not list, scans nothing inside them.
// TextDecoder's body (12 bytes) is the streaming decoder's state:
//   0  i32  code point being built
//   4  u8   bytes needed          5  u8  bytes seen
//   6  u8   lower boundary        7  u8  upper boundary
//   8  u8   flags: 1 fatal, 2 ignoreBOM, 4 BOM seen, 8 do not flush

export const TextEncoder = function (): TextEncoder {
  if (!new.target) throw new TypeError("Constructor TextEncoder requires 'new'");
  const out: TextEncoder = Porffor.malloc(4);
  return out;
};

export const __TextEncoder_prototype_encoding$get = function (this: TextEncoder) {
  return 'utf-8';
};

// The UTF-8 length of a string's code units: a surrogate pair is 4 bytes, a lone
// surrogate becomes U+FFFD (3 bytes), as USVString conversion does.
export const __Porffor_utf8_length = (s: any): i32 => {
  const len: i32 = s.length;
  const ptr: i32 = Porffor.IR.ptr(s);
  let n: i32 = 0;
  if (Porffor.type(s) == Porffor.TYPES.bytestring) {
    for (let i: i32 = 0; i < len; i++) n += Porffor.IR.loadU8(ptr + i, 4) < 0x80 ? 1 : 2;
    return n;
  }
  for (let i: i32 = 0; i < len; i++) {
    const c: i32 = Porffor.IR.loadU16(ptr + i * 2, 4);
    if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
        const d: i32 = Porffor.IR.loadU16(ptr + i * 2 + 2, 4);
        if (d >= 0xdc00 && d <= 0xdfff) {
          n += 4;
          i++;
        } else n += 3;
      } else n += 3;
  }
  return n;
};

// Writes s as UTF-8 at dst (a data pointer, bytes at dst + 4), at most cap bytes, whole
// characters only. Returns (units read << 32 packed as read * 2^32 + written).
export const __Porffor_utf8_write = (s: any, dst: i32, cap: i32): number => {
  const len: i32 = s.length;
  const ptr: i32 = Porffor.IR.ptr(s);
  let w: i32 = 0;
  let i: i32 = 0;
  if (Porffor.type(s) == Porffor.TYPES.bytestring) {
    for (; i < len; i++) {
      const c: i32 = Porffor.IR.loadU8(ptr + i, 4);
      if (c < 0x80) {
        if (w + 1 > cap) break;
        Porffor.IR.storeU8(dst + w++, 4, c);
      } else {
        if (w + 2 > cap) break;
        Porffor.IR.storeU8(dst + w++, 4, 0xc0 | (c >> 6));
        Porffor.IR.storeU8(dst + w++, 4, 0x80 | (c & 0x3f));
      }
    }
    return i * 4294967296 + w;
  }
  while (i < len) {
    let c: i32 = Porffor.IR.loadU16(ptr + i * 2, 4);
    let units: i32 = 1;
    if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
      const hi: i32 = Porffor.IR.loadU16(ptr + i * 2, 4);
      if (hi <= 0xdbff && i + 1 < len) {
        const lo: i32 = Porffor.IR.loadU16(ptr + i * 2 + 2, 4);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          c = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
          units = 2;
        }
      }
    }
    if (c < 0x80) {
      if (w + 1 > cap) break;
      Porffor.IR.storeU8(dst + w++, 4, c);
    } else if (c < 0x800) {
      if (w + 2 > cap) break;
      Porffor.IR.storeU8(dst + w++, 4, 0xc0 | (c >> 6));
      Porffor.IR.storeU8(dst + w++, 4, 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      if (w + 3 > cap) break;
      Porffor.IR.storeU8(dst + w++, 4, 0xe0 | (c >> 12));
      Porffor.IR.storeU8(dst + w++, 4, 0x80 | ((c >> 6) & 0x3f));
      Porffor.IR.storeU8(dst + w++, 4, 0x80 | (c & 0x3f));
    } else {
      if (w + 4 > cap) break;
      Porffor.IR.storeU8(dst + w++, 4, 0xf0 | (c >> 18));
      Porffor.IR.storeU8(dst + w++, 4, 0x80 | ((c >> 12) & 0x3f));
      Porffor.IR.storeU8(dst + w++, 4, 0x80 | ((c >> 6) & 0x3f));
      Porffor.IR.storeU8(dst + w++, 4, 0x80 | (c & 0x3f));
    }
    i += units;
  }
  return i * 4294967296 + w;
};

export const __TextEncoder_prototype_encode = function (this: TextEncoder, input: any) {
  const s: any = input === undefined ? '' : ecma262.ToString(input);
  const n: i32 = __Porffor_utf8_length(s);
  const out: Uint8Array = new Uint8Array(n);
  __Porffor_utf8_write(s, Porffor.IR.loadI32(Porffor.IR.ptr(out), 4), n);
  return out;
};

// Whole characters only: stops before one that does not fit.
export const __TextEncoder_prototype_encodeInto = function (this: TextEncoder, source: any, destination: any) {
  if (Porffor.type(destination) != Porffor.TYPES.uint8array) throw new TypeError('TextEncoder.encodeInto: destination must be a Uint8Array');
  const s: any = ecma262.ToString(source);
  const r: number = __Porffor_utf8_write(s, Porffor.IR.loadI32(Porffor.IR.ptr(destination), 4), destination.length);
  const out: object = {};
  out.read = Math.floor(r / 4294967296);
  out.written = r % 4294967296;
  return out;
};

export const __TextEncoder_prototype_toString = function (this: TextEncoder) { return '[object TextEncoder]'; };

// The labels the Encoding Standard maps to UTF-8.
export const __Porffor_utf8_label = (label: any): boolean => {
  const l: any = ecma262.ToString(label).trim().toLowerCase();
  return Porffor.fastOr(
    l == 'utf-8', l == 'utf8', l == 'unicode-1-1-utf-8', l == 'unicode11utf8',
    l == 'unicode20utf8', l == 'x-unicode20utf8'
  );
};

export const TextDecoder = function (label: any, options: any): TextDecoder {
  if (!new.target) throw new TypeError("Constructor TextDecoder requires 'new'");
  if (label !== undefined) if (!__Porffor_utf8_label(label))
    throw new RangeError('TextDecoder: the "' + ecma262.ToString(label) + '" encoding is not supported (UTF-8 only)');

  let flags: i32 = 0;
  if (options != null) {
    if (!Porffor.object.isObject(options)) throw new TypeError('TextDecoder: options must be an object');
    if (!!options.fatal) flags |= 1;
    if (!!options.ignoreBOM) flags |= 2;
  }

  const out: TextDecoder = Porffor.malloc(12);
  Porffor.IR.storeI32(out, 0, 0);
  Porffor.IR.storeI32(out, 4, 0xbf800000); // needed 0, seen 0, lower 0x80, upper 0xbf
  Porffor.IR.storeI32(out, 8, flags);
  return out;
};

export const __TextDecoder_prototype_encoding$get = function (this: TextDecoder) {
  return 'utf-8';
};

export const __TextDecoder_prototype_fatal$get = function (this: TextDecoder) {
  return (Porffor.IR.loadU8(this, 8) & 1) != 0;
};

export const __TextDecoder_prototype_ignoreBOM$get = function (this: TextDecoder) {
  return (Porffor.IR.loadU8(this, 8) & 2) != 0;
};

// https://encoding.spec.whatwg.org/#dom-textdecoder-decode, with the UTF-8 decoder
// (https://encoding.spec.whatwg.org/#utf-8-decoder) inlined. The decoder state lives
// in the body between calls, so { stream: true } carries a partial sequence over.
export const __TextDecoder_prototype_decode = function (this: TextDecoder, input: any, options: any) {
  let stream: boolean = false;
  if (options != null) {
    if (!Porffor.object.isObject(options)) throw new TypeError('TextDecoder.decode: options must be an object');
    stream = !!options.stream;
  }

  // the bytes: an ArrayBuffer, or a view (typed array or DataView) on one
  let base: i32 = 0; // data pointer: bytes at base + 4
  let len: i32 = 0;
  if (input !== undefined) {
    const t: i32 = Porffor.type(input);
    if (Porffor.fastOr(t == Porffor.TYPES.arraybuffer, t == Porffor.TYPES.sharedarraybuffer)) {
      base = Porffor.IR.ptr(input);
      len = input.byteLength;
    } else if (Porffor.fastOr(
      t == Porffor.TYPES.dataview, t == Porffor.TYPES.uint8array, t == Porffor.TYPES.int8array,
      t == Porffor.TYPES.uint8clampedarray, t == Porffor.TYPES.uint16array, t == Porffor.TYPES.int16array,
      t == Porffor.TYPES.uint32array, t == Porffor.TYPES.int32array, t == Porffor.TYPES.float16array, t == Porffor.TYPES.float32array,
      t == Porffor.TYPES.float64array, t == Porffor.TYPES.bigint64array, t == Porffor.TYPES.biguint64array
    )) {
      base = Porffor.IR.ptr(input.buffer) + input.byteOffset;
      len = input.byteLength;
    } else throw new TypeError('TextDecoder.decode: input must be an ArrayBuffer or ArrayBufferView');
  }

  let flags: i32 = Porffor.IR.loadU8(this, 8);
  // a call that is not continuing a stream starts from a fresh decoder
  if ((flags & 8) == 0) {
    Porffor.IR.storeI32(this, 0, 0);
    Porffor.IR.storeI32(this, 4, 0xbf800000);
    flags &= ~4;
  }
  const fatal: boolean = (flags & 1) != 0;
  const ignoreBOM: boolean = (flags & 2) != 0;

  let cp: i32 = Porffor.IR.loadI32(this, 0);
  let needed: i32 = Porffor.IR.loadU8(this, 4);
  let seen: i32 = Porffor.IR.loadU8(this, 5);
  let lower: i32 = Porffor.IR.loadU8(this, 6);
  let upper: i32 = Porffor.IR.loadU8(this, 7);
  let bomSeen: boolean = (flags & 4) != 0;

  // UTF-16 out: at most one unit per byte, plus one U+FFFD for a truncated tail
  const tmp: string = Porffor.malloc(4 + (len + 1) * 2);
  const tmpPtr: i32 = Porffor.IR.ptr(tmp);
  let n: i32 = 0;
  let maxUnit: i32 = 0;

  let i: i32 = 0;
  while (i <= len) {
    let out: i32 = -1; // a code point to emit, or -1
    let error: boolean = false;
    if (i == len) {
      // end of queue: only a flush ends a partial sequence
      if (stream) break;
      if (needed != 0) {
        needed = 0;
        seen = 0;
        cp = 0;
        error = true;
      }
      i++;
      if (!error) break;
    } else {
      const b: i32 = Porffor.IR.loadU8(base + i, 4);
      if (needed == 0) {
        i++;
        if (b <= 0x7f) out = b;
          else if (b >= 0xc2 && b <= 0xdf) {
            needed = 1;
            cp = b & 0x1f;
          } else if (b >= 0xe0 && b <= 0xef) {
            if (b == 0xe0) lower = 0xa0;
            if (b == 0xed) upper = 0x9f;
            needed = 2;
            cp = b & 0x0f;
          } else if (b >= 0xf0 && b <= 0xf4) {
            if (b == 0xf0) lower = 0x90;
            if (b == 0xf4) upper = 0x8f;
            needed = 3;
            cp = b & 0x07;
          } else error = true;
      } else if (b < lower || b > upper) {
        // not a continuation here: the sequence so far is one error, and this byte is
        // read again as the start of the next
        cp = 0;
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
        error = true;
      } else {
        i++;
        lower = 0x80;
        upper = 0xbf;
        cp = (cp << 6) | (b & 0x3f);
        seen++;
        if (seen == needed) {
          out = cp;
          cp = 0;
          needed = 0;
          seen = 0;
        }
      }
    }

    if (error) {
      if (fatal) {
        // a fatal error leaves a fresh decoder behind
        Porffor.IR.storeI32(this, 0, 0);
        Porffor.IR.storeI32(this, 4, 0xbf800000);
        Porffor.IR.storeU8(this, 8, flags & 3);
        throw new TypeError('TextDecoder.decode: the encoded data was not valid UTF-8');
      }
      out = 0xfffd;
    }
    if (out < 0) continue;

    // the BOM is dropped once, from the start of the stream
    if (!bomSeen) {
      bomSeen = true;
      if (out == 0xfeff) if (!ignoreBOM) continue;
    }

    if (out >= 0x10000) {
      out -= 0x10000;
      Porffor.IR.storeU16(tmpPtr + n * 2, 4, 0xd800 + (out >> 10));
      Porffor.IR.storeU16(tmpPtr + n * 2 + 2, 4, 0xdc00 + (out & 0x3ff));
      n += 2;
      maxUnit = 0xffff;
    } else {
      Porffor.IR.storeU16(tmpPtr + n * 2, 4, out);
      n++;
      if (out > maxUnit) maxUnit = out;
    }
  }

  Porffor.IR.storeI32(this, 0, cp);
  Porffor.IR.storeU8(this, 4, needed);
  Porffor.IR.storeU8(this, 5, seen);
  Porffor.IR.storeU8(this, 6, lower);
  Porffor.IR.storeU8(this, 7, upper);
  flags = (flags & 3) | (bomSeen ? 4 : 0) | (stream ? 8 : 0);
  if (!stream) flags &= 3; // a flush forgets the BOM, ready for the next stream
  Porffor.IR.storeU8(this, 8, flags);

  if (maxUnit > 0xff) {
    tmp.length = n;
    return tmp;
  }
  const narrow: bytestring = Porffor.malloc(6 + n);
  const narrowPtr: i32 = Porffor.IR.ptr(narrow);
  for (let j: i32 = 0; j < n; j++) Porffor.IR.storeU8(narrowPtr + j, 4, Porffor.IR.loadU16(tmpPtr + j * 2, 4));
  narrow.length = n;
  return narrow;
};

export const __TextDecoder_prototype_toString = function (this: TextDecoder) { return '[object TextDecoder]'; };
