import type {} from './porffor.d.ts';

// A BigInt is inline (|n| < 2^51, the value itself) or a heap block (ptr + 2^51). The
// arithmetic, parsing, printing and conversions are the C runtime's (render.js,
// porf_bigint_*), reached through the __Porffor_bigint_* builtins in builtins.js; these
// are the spec's steps around them.

// 21.2.1.1.1 NumberToBigInt (number)
export const __Porffor_bigint_fromNumber = (n: number): bigint => {
  if (!Number.isInteger(n) || !Number.isFinite(n)) throw new RangeError('Cannot convert a non-integer Number to a BigInt');
  return __Porffor_bigint_fromIntegral(n);
};

// a source literal's digits (a sign may come before a radix prefix: folded negative literals)
export const __Porffor_bigint_fromLiteral = (n: bytestring): bigint => {
  return __Porffor_bigint_parse(n, 1);
};

// 7.1.14 StringToBigInt (str), throwing when it is not one
export const __Porffor_bigint_fromString = (n: string|bytestring): bigint => {
  const out: any = __Porffor_bigint_parse(n, 0);
  if (Porffor.type(out) != Porffor.TYPES.bigint) throw new SyntaxError('Cannot convert string to a BigInt');
  return out;
};

// x is `any`: a jsval, so a heap BigInt's tag and payload both reach C
export const __Porffor_bigint_toString = (x: any, radix: any): bytestring => {
  return __Porffor_bigint_toRadixString(x, radix);
};

// 7.1.13 ToBigInt (argument)
// https://tc39.es/ecma262/#sec-tobigint
export const __ecma262_ToBigInt = (argument: any): bigint => {
  // BigInt: already primitive, ToPrimitive would return it unchanged
  if (Porffor.type(argument) == Porffor.TYPES.bigint) return argument;

  // 1. Let prim be ? ToPrimitive(argument, number).
  const prim: any = ecma262.ToPrimitive.Number(argument);

  // 2. Return the value that prim corresponds to in Table 12.
  if (Porffor.type(prim) == Porffor.TYPES.bigint) return prim;

  // String: StringToBigInt, a SyntaxError when it is not one
  if ((Porffor.type(prim) | 0b10000000) == Porffor.TYPES.bytestring) return __Porffor_bigint_fromString(prim);

  // Boolean: 1n or 0n
  if (Porffor.type(prim) == Porffor.TYPES.boolean) return prim ? 1n : 0n;

  // Number, Symbol, Undefined, Null
  throw new TypeError('Cannot convert to BigInt');
};

// 21.2.1.1 BigInt (value)
// https://tc39.es/ecma262/#sec-bigint-constructor-number-value
export const BigInt = (value: any): bigint => {
  // 1. If NewTarget is not undefined, throw a TypeError exception.
  // 2. Let prim be ? ToPrimitive(value, number).
  const prim: any = ecma262.ToPrimitive.Number(value);

  // 3. If prim is a Number, return ? NumberToBigInt(prim).
  if (Porffor.type(prim) == Porffor.TYPES.number) return __Porffor_bigint_fromNumber(prim);

  // 4. Otherwise, return ? ToBigInt(prim).
  return __ecma262_ToBigInt(prim);
};

// 21.2.2.1 BigInt.asIntN (bits, bigint)
export const __BigInt_asIntN = (bits: any, bigint: any): bigint => {
  bits = ecma262.ToIndex(bits);
  bigint = __ecma262_ToBigInt(bigint);
  return __Porffor_bigint_asN(bigint, bits, 1);
};

// 21.2.2.2 BigInt.asUintN (bits, bigint)
export const __BigInt_asUintN = (bits: any, bigint: any): bigint => {
  bits = ecma262.ToIndex(bits);
  bigint = __ecma262_ToBigInt(bigint);
  return __Porffor_bigint_asN(bigint, bits, 0);
};

// 21.2.3.3 BigInt.prototype.toString ([radix])
export const __BigInt_prototype_toString = function (this: bigint, radix: any) {
  if (Porffor.type(this) != Porffor.TYPES.bigint) throw new TypeError('BigInt.prototype.toString requires a BigInt');

  let r: number = 10;
  if (radix !== undefined) {
    r = ecma262.ToIntegerOrInfinity(radix);
    if (r < 2 || r > 36) throw new RangeError('toString() radix must be between 2 and 36');
  }

  return __Porffor_bigint_toRadixString(this, r);
};

export const __BigInt_prototype_toLocaleString = function (this: bigint) {
  return __Porffor_bigint_toRadixString(this, 10);
};

export const __BigInt_prototype_valueOf = function (this: bigint) {
  if (Porffor.type(this) != Porffor.TYPES.bigint) throw new TypeError('BigInt.prototype.valueOf requires a BigInt');
  return this;
};
