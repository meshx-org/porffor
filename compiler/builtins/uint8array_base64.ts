import type {} from './porffor.d.ts';

// Uint8Array base64 and hex: the options and checks here, the encoding and decoding in the C
// runtime (porf_b64_* / porf_hex_*, SIMD under wasm)

// ValidateUint8Array
export const __Porffor_uint8array_check = (ta: any) => {
  if (Porffor.type(ta) != Porffor.TYPES.uint8array) {
    throw new TypeError('Method called on incompatible receiver');
  }
};

// GetUint8ArrayBytes' detached check
export const __Porffor_uint8array_validate = (ta: any) => {
  __Porffor_uint8array_check(ta);
  if (Porffor.IR.loadI32(Porffor.IR.loadI32(Porffor.IR.ptr(ta), 4), 0) == 4294967295) {
    throw new TypeError('Uint8Array has a detached ArrayBuffer');
  }
};

// a string argument's unit width: 1 for two-byte units, 0 for one-byte
export const __Porffor_uint8array_stringWidth = (str: any): i32 => {
  const t: i32 = Porffor.type(str);
  if (t == Porffor.TYPES.bytestring) return 0;
  if (t == Porffor.TYPES.string) return 1;
  throw new TypeError('First argument must be a string');
};

// GetOptionsObject
export const __Porffor_uint8array_options = (options: any): any => {
  if (Porffor.type(options) != Porffor.TYPES.undefined && !__Porffor_object_isObject(options)) {
    throw new TypeError('Options must be an object');
  }
  return options;
};

// the alphabet option: 1 for base64url, 0 for base64
export const __Porffor_uint8array_alphabet = (options: any): i32 => {
  if (Porffor.type(options) == Porffor.TYPES.undefined) return 0;
  const alphabet: any = options.alphabet;
  const t: i32 = Porffor.type(alphabet);
  if (t == Porffor.TYPES.undefined) return 0;
  if (t == Porffor.TYPES.bytestring) {
    if (Porffor.strcmp(alphabet, 'base64')) return 0;
    if (Porffor.strcmp(alphabet, 'base64url')) return 1;
  }
  throw new TypeError('Invalid alphabet');
};

// the lastChunkHandling option: 0 loose, 1 strict, 2 stop-before-partial
export const __Porffor_uint8array_lastChunk = (options: any): i32 => {
  if (Porffor.type(options) == Porffor.TYPES.undefined) return 0;
  const handling: any = options.lastChunkHandling;
  const t: i32 = Porffor.type(handling);
  if (t == Porffor.TYPES.undefined) return 0;
  if (t == Porffor.TYPES.bytestring) {
    if (Porffor.strcmp(handling, 'loose')) return 0;
    if (Porffor.strcmp(handling, 'strict')) return 1;
    if (Porffor.strcmp(handling, 'stop-before-partial')) return 2;
  }
  throw new TypeError('Invalid lastChunkHandling');
};

// the { read, written } result of setFromBase64 and setFromHex
export const __Porffor_uint8array_readWritten = (read: i32, written: i32): object => {
  const result: object = {};
  result.read = read;
  result.written = written;
  return result;
};

export const __Uint8Array_prototype_toBase64 = function (this: Uint8Array, options: any = undefined) {
  __Porffor_uint8array_check(this);
  options = __Porffor_uint8array_options(options);
  const url: i32 = __Porffor_uint8array_alphabet(options);
  let pad: i32 = 1;
  if (Porffor.type(options) != Porffor.TYPES.undefined && !!options.omitPadding) pad = 0;
  __Porffor_uint8array_validate(this);

  const taPtr: i32 = Porffor.IR.ptr(this);
  const len: i32 = Porffor.IR.loadI32(taPtr, 0);
  const output: bytestring = Porffor.malloc(len * 2 + 16);
  const outPtr: i32 = Porffor.IR.ptr(output);
  Porffor.IR.storeI32(outPtr, 0, __Porffor_base64_encode(Porffor.IR.loadI32(taPtr, 4), len, outPtr, url, pad));
  return output;
};

export const __Uint8Array_prototype_toHex = function (this: Uint8Array) {
  __Porffor_uint8array_validate(this);
  const taPtr: i32 = Porffor.IR.ptr(this);
  const len: i32 = Porffor.IR.loadI32(taPtr, 0);
  const output: bytestring = Porffor.malloc(len * 2 + 8);
  const outPtr: i32 = Porffor.IR.ptr(output);
  __Porffor_hex_encode(Porffor.IR.loadI32(taPtr, 4), len, outPtr);
  Porffor.IR.storeI32(outPtr, 0, len * 2);
  return output;
};

export const __Uint8Array_fromBase64 = (str: any, options: any = undefined) => {
  const two: i32 = __Porffor_uint8array_stringWidth(str);
  options = __Porffor_uint8array_options(options);
  const url: i32 = __Porffor_uint8array_alphabet(options);
  const lastChunk: i32 = __Porffor_uint8array_lastChunk(options);

  // room for every byte the chars could hold, and a chunk more, so the limit never stops it
  const len: i32 = str.length;
  const max: i32 = len * 3 / 4 + 3;
  const scratch: i32 = Porffor.malloc(max + 8);
  const written: i32 = __Porffor_base64_decode(Porffor.IR.ptr(str), two, len, url, lastChunk, scratch, max);
  if (written < 0) throw new SyntaxError('Invalid base64 string');

  const ta: Uint8Array = new Uint8Array(written);
  Porffor.IR.copy(Porffor.IR.loadI32(Porffor.IR.ptr(ta), 4) + 4, scratch + 4, written);
  return ta;
};

export const __Uint8Array_prototype_setFromBase64 = function (this: Uint8Array, str: any, options: any = undefined) {
  __Porffor_uint8array_check(this);
  const two: i32 = __Porffor_uint8array_stringWidth(str);
  options = __Porffor_uint8array_options(options);
  const url: i32 = __Porffor_uint8array_alphabet(options);
  const lastChunk: i32 = __Porffor_uint8array_lastChunk(options);
  __Porffor_uint8array_validate(this);

  // decodes in place: bytes before an error stay written, as the spec's SetUint8ArrayBytes
  const taPtr: i32 = Porffor.IR.ptr(this);
  const written: i32 = __Porffor_base64_decode(Porffor.IR.ptr(str), two, str.length, url, lastChunk, Porffor.IR.loadI32(taPtr, 4), Porffor.IR.loadI32(taPtr, 0));
  if (written < 0) throw new SyntaxError('Invalid base64 string');
  return __Porffor_uint8array_readWritten(__Porffor_base64_read(), written);
};

export const __Uint8Array_fromHex = (str: any) => {
  const two: i32 = __Porffor_uint8array_stringWidth(str);
  const len: i32 = str.length;
  if ((len & 1) != 0) throw new SyntaxError('Hex string must have an even length');

  const n: i32 = len >> 1;
  const ta: Uint8Array = new Uint8Array(n);
  if (__Porffor_hex_decode(Porffor.IR.ptr(str), two, n, Porffor.IR.loadI32(Porffor.IR.ptr(ta), 4)) < n) {
    throw new SyntaxError('Invalid hex character');
  }
  return ta;
};

export const __Uint8Array_prototype_setFromHex = function (this: Uint8Array, str: any) {
  __Porffor_uint8array_check(this);
  const two: i32 = __Porffor_uint8array_stringWidth(str);
  __Porffor_uint8array_validate(this);

  const len: i32 = str.length;
  if ((len & 1) != 0) throw new SyntaxError('Hex string must have an even length');

  const taPtr: i32 = Porffor.IR.ptr(this);
  const byteLength: i32 = Porffor.IR.loadI32(taPtr, 0);
  let n: i32 = len >> 1;
  if (n > byteLength) n = byteLength;
  const written: i32 = __Porffor_hex_decode(Porffor.IR.ptr(str), two, n, Porffor.IR.loadI32(taPtr, 4));
  if (written < n) throw new SyntaxError('Invalid hex character');
  return __Porffor_uint8array_readWritten(written * 2, written);
};
