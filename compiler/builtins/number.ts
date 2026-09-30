import type {} from './porffor.d.ts';

// 21.1.1.1 Number (value)
// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number-constructor-number-value
export const Number = function (_argc: i32, value: any): number|any {
  let n: number = 0;

  // 1. If value is present, then (an undefined given is NaN, none at all 0)
  if (_argc > 0) {
    // a. Let prim be ? ToNumeric(value).
    const prim: any = ecma262.ToNumeric(value);

    // b. If prim is a BigInt, let n be 𝔽(ℝ(prim)).
    // c. Otherwise, let n be prim.
    n = prim;
    if (Porffor.comptime.flag`hasType.bigint`) {
      if (Porffor.type(prim) == Porffor.TYPES.bigint) n = Porffor.bigint.toNumber(prim);
    }
  }

  // 2. Else,
  // a. Let n be +0𝔽.
  // n is already 0 (from init value)

  // 3. If NewTarget is undefined, return n.
  if (!new.target) return n;

  // 4. Let O be ? OrdinaryCreateFromConstructor(NewTarget, "%Number.prototype%", « [[NumberData]] »).
  // 5. Set O.[[NumberData]] to n.
  // 6. Return O.
  // retagged, keeping the number (a cast to an object type would make it a pointer: -5 was 0)
  return Porffor.as(n, Porffor.TYPES.numberobject);
};

export const isNaN = (value: any): boolean => {
  const number: number = ecma262.ToNumber(value);
  return number != number;
};

export const __Number_isNaN = (value: any): boolean =>
  Porffor.type(value) == Porffor.TYPES.number && value != value;

export const isFinite = (value: any): boolean => {
  const number: number = ecma262.ToNumber(value);
  const delta: number = number - number;
  return delta == delta;
};

export const __Number_isFinite = (value: any): boolean => {
  if (Porffor.type(value) != Porffor.TYPES.number) return false;
  const delta: number = value - value;
  return delta == delta;
};

// IsIntegralNumber: a Number (no conversion: a string or a boolean is not one), finite,
// and whole
export const __Number_isInteger = (value: any): boolean => {
  if (Porffor.type(value) != Porffor.TYPES.number) return false;
  const delta: number = value - value;
  if (delta != delta) return false;
  return value % 1 == 0;
};

export const __Number_isSafeInteger = (value: any): boolean => {
  if (!__Number_isInteger(value)) return false;
  return value >= -9007199254740991 && value <= 9007199254740991;
};

// radix: number|any for type check
export const __Number_prototype_toString = function (this: number, radix: number|any) {
  let n: number = this;
  if (Porffor.type(radix) != Porffor.TYPES.number) {
    // todo: string to number
    radix = 10;
  }

  radix = Math.trunc(radix);
  if (radix < 2 || radix > 36) {
    throw new RangeError('toString() radix argument must be between 2 and 36');
  }

  if (!Number.isFinite(n)) {
    if (Number.isNaN(n)) return 'NaN';
    if (n == Infinity) return 'Infinity';
    return '-Infinity';
  }

  if (n == 0) {
    return '0';
  }

  if (radix == 10) {
    let out: bytestring = '';
    Porffor.c`out = porf_num_to_str(n);`;
    return out;
  }

  const out: bytestring = Porffor.malloc(512);
  let outPtr: i32 = Porffor.IR.ptr(out);
  let negative: i32 = 0;

  // if negative value
  if (n < 0) {
    negative = 1;
    n = -n; // turn value positive for later use
    Porffor.IR.storeU8(outPtr++, 4, 45); // prepend -
  }

  let i: f64 = Math.trunc(n);

  let digits: bytestring = Porffor.malloc(512); // byte "array"

  let l: i32 = 0;
  if (radix == 10) {
    if (i >= 1e21) {
      let exponential: bytestring = '';
      Porffor.c`exponential = porf_num_to_str(negative ? -n : n);`;
      return exponential;
    }

    if (n < 1e-6) {
      // small exponential
      let decimal: f64 = n;

      let e: i32 = 0;
      while (decimal < 1) {
        decimal *= radix;
        e++;
      }

      let lastNonZero: i32 = 0;
      while (l < 17) {
        const intPart: i32 = Math.trunc(decimal);
        Porffor.IR.storeU8(Porffor.IR.ptr(digits) + l, 4, intPart);
        if (intPart != 0) lastNonZero = l;
        l++;

        decimal = (decimal - intPart) * radix;
        if (decimal < 1e-12) break;
      }
      l = lastNonZero + 1;

      let digitsPtr: i32 = Porffor.IR.ptr(digits);
      let endPtr: i32 = outPtr + l;
      let dotPlace: i32 = outPtr + 1;
      while (outPtr < endPtr) {
        let digit: i32 = Porffor.IR.loadU8(digitsPtr++, 4);

        if (outPtr == dotPlace) {
          Porffor.IR.storeU8(outPtr++, 4, 46); // .
          endPtr++;
        }

        if (digit < 10) digit += 48; // 0-9
          else digit += 87; // a-z

        Porffor.IR.storeU8(outPtr++, 4, digit);
      }

      Porffor.IR.storeU8(outPtr++, 4, 101); // e
      Porffor.IR.storeU8(outPtr++, 4, 45); // -

      l = 0;
      for (; e > 0; l++) {
        Porffor.IR.storeU8(Porffor.IR.ptr(digits) + l, 4, e % radix);
        e = Math.trunc(e / radix);
      }

      digitsPtr = Porffor.IR.ptr(digits) + l;

      endPtr = outPtr + l;
      while (outPtr < endPtr) {
        let digit: i32 = Porffor.IR.loadU8(--digitsPtr, 4);

        if (digit < 10) digit += 48; // 0-9
          else digit += 87; // a-z

        Porffor.IR.storeU8(outPtr++, 4, digit);
      }

      out.length = outPtr - Porffor.IR.ptr(out);

      return out;
    }
  }

  if (i == 0) {
    Porffor.IR.storeU8(Porffor.IR.ptr(digits), 4, 0);
    l = 1;
  } else {
    for (; i > 0; l++) {
      Porffor.IR.storeU8(Porffor.IR.ptr(digits) + l, 4, i % radix);
      i = Math.trunc(i / radix);
    }
  }

  let digitsPtr: i32 = Porffor.IR.ptr(digits) + l;
  let endPtr: i32 = outPtr + l;
  while (outPtr < endPtr) {
    let digit: i32 = Porffor.IR.loadU8(--digitsPtr, 4);

    if (digit < 10) digit += 48; // 0-9
      else digit += 87; // a-z

    Porffor.IR.storeU8(outPtr++, 4, digit);
  }

  let decimal: f64 = n - Math.trunc(n);
  if (decimal > 0) {
    Porffor.IR.storeU8(outPtr++, 4, 46); // .

    decimal += 1;

    // todo: doesn't handle non-10 radix properly
    let decimalDigits: i32 = 16 - l;
    for (let j: i32 = 0; j < decimalDigits; j++) {
      decimal *= radix;
    }

    decimal = Math.round(decimal);

    l = 0;
    let trailing: boolean = true;
    while (decimal > 1) {
      const digit: f64 = decimal % radix;
      decimal = Math.trunc(decimal / radix);

      if (trailing) {
        if (digit == 0) { // skip trailing 0s
          continue;
        }
        trailing = false;
      }

      Porffor.IR.storeU8(Porffor.IR.ptr(digits) + l, 4, digit);
      l++;
    }

    digitsPtr = Porffor.IR.ptr(digits) + l;

    endPtr = outPtr + l;
    while (outPtr < endPtr) {
      let digit: i32 = Porffor.IR.loadU8(--digitsPtr, 4);

      if (digit < 10) digit += 48; // 0-9
        else digit += 87; // a-z

      Porffor.IR.storeU8(outPtr++, 4, digit);
    }
  }

  out.length = outPtr - Porffor.IR.ptr(out);
  return out;
};

// Number.prototype.toFixed, exactly as the spec defines it: n is the integer for which
// n / 10^f - x is closest to zero, using x's exact value, and the larger n on a tie.
export const __Number_prototype_toFixed = function (this: number, fractionDigits: number) {
  let x: number = this;
  let f: number = Math.trunc(fractionDigits);
  if (Number.isNaN(f)) f = 0;
  if (f < 0 || f > 100) throw new RangeError('toFixed() fractionDigits argument must be between 0 and 100');

  if (!Number.isFinite(x)) return ecma262.ToString(x);

  let sign: bytestring = '';
  if (x < 0) {
    sign = '-';
    x = -x;
  }
  if (x >= 1e21) return sign + ecma262.ToString(x);

  let digits: bytestring = __Porffor_number_roundScaled(x, f);
  if (f == 0) return sign + digits;

  // at least one digit before the point
  while (digits.length <= f) digits = '0' + digits;
  const point: i32 = digits.length - f;
  return sign + digits.slice(0, point) + '.' + digits.slice(point);
};

// The p significant digits of x >= 0 (x != 0) and the decimal exponent e of the first,
// per the spec's toPrecision/toExponential: n with p digits for which n * 10^(e-p+1) - x
// is closest to zero, the larger n on a tie. The log estimate of e is only a start:
// rounding decides the digit count, and e moves until there are exactly p.
export const __Porffor_number_precise = (x: number, p: i32): any[] => {
  let e: i32 = Math.floor(Math.log(x) / Math.LN10);
  let digits: bytestring = '';
  while (true) {
    digits = __Porffor_number_roundScaled(x, p - 1 - e);
    if (digits.length > p) e++;
      else if (digits.length < p) e--;
      else break;
  }
  // 10^(p-1) (a 1 then zeros) can also be x just below 10^e rounded up: then the
  // exponent below still has p digits and is the closer of the two (1e-7 is
  // 9.99...e-8, so its 17 digits are 99999999999999995, not 10000000000000000)
  if (digits.charCodeAt(0) == 49) {
    let rest: boolean = true;
    for (let j: i32 = 1; j < p; j++) if (digits.charCodeAt(j) != 48) rest = false;
    if (rest) {
      const below: bytestring = __Porffor_number_roundScaled(x, p - e);
      if (below.length == p) {
        digits = below;
        e--;
      }
    }
  }
  const out: any[] = Porffor.array.new(4);
  out[0] = digits;
  out[1] = e;
  return out;
};

// 21.1.3.5 Number.prototype.toPrecision (precision)
// https://tc39.es/ecma262/#sec-number.prototype.toprecision
export const __Number_prototype_toPrecision = function (this: number, precision: any) {
  let x: number = this;
  if (precision === undefined) return ecma262.ToString(x);
  const p: number = ecma262.ToIntegerOrInfinity(precision);
  if (!Number.isFinite(x)) return ecma262.ToString(x);
  if (p < 1 || p > 100) throw new RangeError('toPrecision() argument must be between 1 and 100');

  let sign: bytestring = '';
  if (x < 0) {
    sign = '-';
    x = -x;
  }

  let digits: bytestring = '';
  let e: i32 = 0;
  if (x == 0) {
    for (let j: i32 = 0; j < p; j++) digits += '0';
  } else {
    const r: any[] = __Porffor_number_precise(x, p);
    digits = r[0];
    e = r[1];
  }

  if (e < -6 || e >= p) {
    let m: bytestring = digits.slice(0, 1);
    if (p != 1) m += '.' + digits.slice(1);
    if (e >= 0) return sign + m + 'e+' + ecma262.ToString(e);
    return sign + m + 'e-' + ecma262.ToString(-e);
  }
  if (e == p - 1) return sign + digits;
  if (e >= 0) return sign + digits.slice(0, e + 1) + '.' + digits.slice(e + 1);
  let zeros: bytestring = '';
  for (let j: i32 = 0; j < -(e + 1); j++) zeros += '0';
  return sign + '0.' + zeros + digits;
};

export const __Number_prototype_toLocaleString = function (this: number) { return Porffor.callThis(__Number_prototype_toString, this, 10); };

// Number.prototype.toExponential: f digits after the point, exactly, as toPrecision; with
// no digit count, the shortest digits that tell the number apart, as Number::toString
export const __Number_prototype_toExponential = function (this: number, fractionDigits: any) {
  let n: number = this;
  const f: number = ecma262.ToIntegerOrInfinity(fractionDigits);
  if (!Number.isFinite(n)) return ecma262.ToString(n);
  if (f < 0 || f > 100) throw new RangeError('toExponential() fractionDigits argument must be between 0 and 100');
  if (fractionDigits === undefined) return __Porffor_number_toExponentialShortest(n);

  let sign: bytestring = '';
  if (n < 0) {
    sign = '-';
    n = -n;
  }
  let digits: bytestring = '';
  let e: i32 = 0;
  if (n == 0) {
    for (let j: i32 = 0; j <= f; j++) digits += '0';
  } else {
    const r: any[] = __Porffor_number_precise(n, f + 1);
    digits = r[0];
    e = r[1];
  }
  let m: bytestring = digits.slice(0, 1);
  if (f > 0) m += '.' + digits.slice(1);
  if (e >= 0) return sign + m + 'e+' + ecma262.ToString(e);
  return sign + m + 'e-' + ecma262.ToString(-e);
};

// 21.1.3.7 Number.prototype.valueOf ()
// https://tc39.es/ecma262/#sec-number.prototype.valueof
export const __Number_prototype_valueOf = function (this: any): number {
  // 1. Return ? ThisNumberValue(this value): the primitive, a Number object's unwrapped
  if (Porffor.fastOr(Porffor.type(this) == Porffor.TYPES.number, Porffor.type(this) == Porffor.TYPES.numberobject)) {
    // the payload, retagged (a cast alone keeps the object's tag)
    const value: f64 = this;
    return value;
  }
  throw new TypeError('Number.prototype.valueOf requires a Number');
};


// parseInt's digits [from, to) (character indices of input) again, exactly: in radix 10 more than
// 15 digits through StringToNumber (correctly rounded, where n * 10 + d rounds at every step);
// in a power-of-two radix the first 53 significant bits, the next one to round on and whether
// any below it is set (round half to even), as the spec asks for these radixes
export const __Porffor_parseInt_exact = (input: string|bytestring, from: i32, to: i32, radix: i32): f64 => {
  if (radix == 10) return __ecma262_StringToNumber(input.substring(from, to));

  let bits: i32 = 1;
  while ((1 << bits) < radix) bits++;
  let m: f64 = 0, shift: i32 = 0, round: i32 = -1, sticky: boolean = false;
  for (let k: i32 = from; k < to; k++) {
    const c: i32 = input.charCodeAt(k);
    const d: i32 = c <= 57 ? c - 48 : (c >= 97 ? c - 87 : c - 55);
    for (let b: i32 = bits - 1; b >= 0; b--) {
      const bit: i32 = (d >> b) & 1;
      if (shift == 0 && m * 2 + bit < 9007199254740992) { m = m * 2 + bit; continue; }
      // m holds 53 bits: this one is below them
      shift++;
      if (round < 0) round = bit;
        else if (bit != 0) sticky = true;
    }
  }
  if (round == 1 && (sticky || m % 2 == 1)) m += 1;
  return m * Math.pow(2, shift);
};

export const parseInt = (input: any, radix: any): f64 => {
  // todo/perf: optimize this instead of doing a naive algo (https://kholdstare.github.io/technical/2020/05/26/faster-integer-parsing.html)
  // todo/perf: use i32s here once that becomes not annoying

  input = ecma262.ToString(input).trim();

  let defaultRadix: boolean = false;
  radix = ecma262.ToIntegerOrInfinity(radix);
  if (!Number.isFinite(radix)) radix = 0; // infinity/NaN -> default

  if (radix == 0) {
    defaultRadix = true;
    radix = 10;
  }
  if (radix < 2 || radix > 36) return NaN;

  let nMax: i32 = 58;
  if (radix < 10) nMax = 48 + radix;

  let n: f64 = NaN;

  const inputPtr: i32 = Porffor.IR.ptr(input);
  const len: i32 = Porffor.IR.loadI32(inputPtr, 0);
  let i: i32 = inputPtr;

  let negative: boolean = false;

  if (Porffor.type(input) == Porffor.TYPES.bytestring) {
    const endPtr: i32 = i + len;

    // check start of string
    const startChr: i32 = Porffor.IR.loadU8(i, 4);

    // +, ignore
    if (startChr == 43) i++;

    // -, switch to negative
    if (startChr == 45) {
      negative = true;
      i++;
    }

    // 0, potential start of hex
    if ((defaultRadix || radix == 16) && startChr == 48) {
      const second: i32 = Porffor.IR.loadU8(i + 1, 4);
      // 0x or 0X
      if (second == 120 || second == 88) {
        // set radix to 16 and skip leading 2 chars
        i += 2;
        radix = 16;
      }
    }

    const digitsFrom: i32 = i - inputPtr;
    let digitsTo: i32 = digitsFrom;
    while (i < endPtr) {
      const chr: i32 = Porffor.IR.loadU8(i++, 4);

      if (chr >= 48 && chr < nMax) {
        if (Number.isNaN(n)) n = 0;
        n = (n * radix) + chr - 48;
        digitsTo = i - inputPtr;
      } else if (radix > 10) {
        if (chr >= 97 && chr < (87 + radix)) {
          if (Number.isNaN(n)) n = 0;
          n = (n * radix) + chr - 87;
        digitsTo = i - inputPtr;
        } else if (chr >= 65 && chr < (55 + radix)) {
          if (Number.isNaN(n)) n = 0;
          n = (n * radix) + chr - 55;
        digitsTo = i - inputPtr;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    // past what n * radix + d keeps exact: again, exactly
    if (Porffor.fastOr(Porffor.fastAnd(n >= 9007199254740992, (radix & (radix - 1)) == 0), Porffor.fastAnd(radix == 10, digitsTo - digitsFrom > 15)))
      n = __Porffor_parseInt_exact(input, digitsFrom, digitsTo, radix);

    if (negative) return -n;
    return n;
  }

  const endPtr: i32 = i + len * 2;

  // check start of string
  const startChr: i32 = Porffor.IR.loadU16(i, 4);

  // +, ignore
  if (startChr == 43) i += 2;

  // -, switch to negative
  if (startChr == 45) {
    negative = true;
    i += 2;
  }

  // 0, potential start of hex
  if ((defaultRadix || radix == 16) && startChr == 48) {
    const second: i32 = Porffor.IR.loadU16(i + 2, 4);
    // 0x or 0X
    if (second == 120 || second == 88) {
      // set radix to 16 and skip leading 2 chars
      i += 4;
      radix = 16;
    }
  }

  const digitsFrom: i32 = (i - inputPtr) >> 1;
  let digitsTo: i32 = digitsFrom;
  while (i < endPtr) {
    const chr: i32 = Porffor.IR.loadU16(i, 4);
    i += 2;

    if (chr >= 48 && chr < nMax) {
      if (Number.isNaN(n)) n = 0;
      n = (n * radix) + chr - 48;
      digitsTo = (i - inputPtr) >> 1;
    } else if (radix > 10) {
      if (chr >= 97 && chr < (87 + radix)) {
        if (Number.isNaN(n)) n = 0;
        n = (n * radix) + chr - 87;
      digitsTo = (i - inputPtr) >> 1;
      } else if (chr >= 65 && chr < (55 + radix)) {
        if (Number.isNaN(n)) n = 0;
        n = (n * radix) + chr - 55;
      digitsTo = (i - inputPtr) >> 1;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (Porffor.fastOr(Porffor.fastAnd(n >= 9007199254740992, (radix & (radix - 1)) == 0), Porffor.fastAnd(radix == 10, digitsTo - digitsFrom > 15)))
    n = __Porffor_parseInt_exact(input, digitsFrom, digitsTo, radix);

  if (negative) return -n;
  return n;
};

export const __Number_parseInt = (input: any, radix: any): f64 => parseInt(input, radix);

export const parseFloat = (input: any): f64 => {
  input = ecma262.ToString(input).trim();

  let negative: boolean = false;

  let i: i32 = 0;
  const len: i32 = input.length;

  if (len == 0) return NaN;

  const start: i32 = input.charCodeAt(0);

  // +, ignore
  if (start == 43) {
    i++;
  }

  // -, negative
  if (start == 45) {
    i++;
    negative = true;
  }

  // 'Infinity'?
  if (len - i >= 8) {
    if (input.charCodeAt(i) == 73 &&      // I
        input.charCodeAt(i + 1) == 110 && // n
        input.charCodeAt(i + 2) == 102 && // f
        input.charCodeAt(i + 3) == 105 && // i
        input.charCodeAt(i + 4) == 110 && // n
        input.charCodeAt(i + 5) == 105 && // i
        input.charCodeAt(i + 6) == 116 && // t
        input.charCodeAt(i + 7) == 121) { // y
      if (negative) return -Infinity;
      return Infinity;
    }
  }

  const n: f64 = __Porffor_stn_float(input, i, false);

  if (negative) return -n;
  return n;
};

export const __Number_parseFloat = (input: any): f64 => parseFloat(input);
