import type {} from './porffor.d.ts';

// The crypto object's random half (https://w3c.github.io/webcrypto/#crypto-interface):
// getRandomValues and randomUUID, from the platform's CSPRNG (porf_random_fill:
// getentropy, on WASI wasi:random/random). No subtle: its algorithms would have to be
// compiled in. Where the spec throws a DOMException (Porffor has none), a TypeError or
// RangeError names it.

// crypto.getRandomValues(integerTypedArray): fills it and returns it
export const __crypto_getRandomValues = (array: any): any => {
  const t: i32 = Porffor.type(array);
  if (!Porffor.fastOr(
    t == Porffor.TYPES.uint8array, t == Porffor.TYPES.int8array, t == Porffor.TYPES.uint8clampedarray,
    t == Porffor.TYPES.uint16array, t == Porffor.TYPES.int16array,
    t == Porffor.TYPES.uint32array, t == Porffor.TYPES.int32array,
    t == Porffor.TYPES.bigint64array, t == Porffor.TYPES.biguint64array
  )) throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': TypeMismatchError: the array is not an integer typed array");

  const len: i32 = array.byteLength;
  if (len > 65536) throw new RangeError("Failed to execute 'getRandomValues' on 'Crypto': QuotaExceededError: the array is longer than 65536 bytes");

  // the view's bytes start 4 past its buffer's pointer, at its byte offset
  __Porffor_randomFill(Porffor.IR.ptr(array.buffer) + 4 + array.byteOffset, len);
  return array;
};

// crypto.randomUUID(): a version 4 UUID, lowercase, as 8-4-4-4-12 hex digits
export const __crypto_randomUUID = (): bytestring => {
  const bytes: Uint8Array = new Uint8Array(16);
  __Porffor_randomFill(Porffor.IR.ptr(bytes.buffer) + 4, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex: bytestring = '0123456789abcdef';
  let out: bytestring = '';
  for (let i: i32 = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out += '-';
    const b: i32 = bytes[i];
    out += hex[b >> 4];
    out += hex[b & 15];
  }
  return out;
};
