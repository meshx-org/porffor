import type {} from './porffor.d.ts';

// atob and btoa over the C runtime's base64 (porf_b64_*). Where HTML throws an
// InvalidCharacterError DOMException (Porffor has none), a TypeError names it.

export const btoa = (input: any): bytestring => {
  if (Porffor.type(input) != Porffor.TYPES.bytestring && Porffor.type(input) != Porffor.TYPES.string) input = ecma262.ToString(input);

  const len: i32 = input.length;
  let bytes: i32 = Porffor.IR.ptr(input);
  if (Porffor.type(input) == Porffor.TYPES.string) {
    // a two-byte string: every unit must be a byte
    for (let i: i32 = 0; i < len; i++) {
      if (Porffor.IR.loadU16(bytes + i * 2, 4) > 0xff) throw new TypeError('InvalidCharacterError: btoa input has a character above U+00FF');
    }
    const narrow: i32 = Porffor.malloc(len + 8);
    __Porffor_simd_narrow(narrow, 0, bytes, 0, len);
    bytes = narrow;
  }

  const output: bytestring = Porffor.malloc(len * 2 + 16);
  const outPtr: i32 = Porffor.IR.ptr(output);
  Porffor.IR.storeI32(outPtr, 0, __Porffor_base64_encode(bytes, len, outPtr, 0, 1));
  return output;
};

// forgiving-base64 decode is FromBase64 with the loose last chunk: whitespace skipped,
// padding optional, a lone final char or anything outside the alphabet a failure
export const atob = (input: any): bytestring => {
  if (Porffor.type(input) != Porffor.TYPES.bytestring && Porffor.type(input) != Porffor.TYPES.string) input = ecma262.ToString(input);

  const len: i32 = input.length;
  const max: i32 = len * 3 / 4 + 3;
  const output: bytestring = Porffor.malloc(max + 8);
  const outPtr: i32 = Porffor.IR.ptr(output);
  const two: i32 = Porffor.type(input) == Porffor.TYPES.string ? 1 : 0;
  const written: i32 = __Porffor_base64_decode(Porffor.IR.ptr(input), two, len, 0, 0, outPtr, max);
  if (written < 0) throw new TypeError('InvalidCharacterError: atob input is not valid base64');

  Porffor.IR.storeI32(outPtr, 0, written);
  return output;
};
