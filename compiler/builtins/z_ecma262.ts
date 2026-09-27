// general widely used ecma262/spec functions
import type {} from './porffor.d.ts';

// https://tc39.es/ecma262/#sec-samevaluezero: === but NaN equals NaN
export const __ecma262_SameValueZero = (x: any, y: any): boolean => {
  if (x === y) return true;
  // NaN !== NaN, but SameValueZero(NaN, NaN) should be true
  if (Porffor.type(x) == Porffor.TYPES.number && Number.isNaN(x) && Number.isNaN(y)) return true;
  return false;
};

// GetMethod(input, @@toPrimitive): undefined when absent (or null), a TypeError when not callable
export const __Porffor_toPrimitiveMethod = (input: any): any => {
  const method: any = input[Symbol.toPrimitive];
  if (method == null) return undefined;
  if (typeof method !== 'function') throw new TypeError('Symbol.toPrimitive is not a function');
  return method;
};

// the method's result, which has to be a primitive
export const __Porffor_callToPrimitive = (method: any, input: any, hint: bytestring): any => {
  const result: any = Porffor.callThis(method, input, hint);
  if (Porffor.object.isObject(result)) throw new TypeError('Cannot convert object to primitive value');
  return result;
};

// 7.1.1.1 OrdinaryToPrimitive: the first of the two methods that is callable and returns
// a primitive wins. A method that returns null or undefined has returned a primitive (it
// is not skipped: only a missing or non-callable method, or an object result, is).
// 7.1.1.1 OrdinaryToPrimitive, inline in each (an extra call per conversion cost a third
// on conversion-heavy code): the first of the two methods that is callable and returns a
// primitive wins (null and undefined are primitives). Each is read once: a getter runs once
export const __ecma262_ToPrimitive_Number = (input: any): any => {
  // an object's own [Symbol.toPrimitive] decides first: only in a program that names
  // .toPrimitive can there be one (each conversion would look it up otherwise)
  if (Porffor.comptime.flag`member.toPrimitive`) {
    const exotic: any = __Porffor_toPrimitiveMethod(input);
    if (exotic !== undefined) return __Porffor_callToPrimitive(exotic, input, 'number');
  }

  const valueOf: any = input.valueOf;
  if (typeof valueOf === 'function') {
    const value: any = Porffor.callThis(valueOf, input);
    if (!Porffor.object.isObject(value)) return value;
  }

  const toString: any = input.toString;
  if (typeof toString === 'function') {
    const value: any = Porffor.callThis(toString, input);
    if (!Porffor.object.isObject(value)) return value;
  }

  throw new TypeError('Cannot convert an object to primitive');
};

export const __ecma262_ToPrimitive_String = (input: any): any => {
  if (Porffor.comptime.flag`member.toPrimitive`) {
    const exotic: any = __Porffor_toPrimitiveMethod(input);
    if (exotic !== undefined) return __Porffor_callToPrimitive(exotic, input, 'string');
  }

  const toString: any = input.toString;
  if (typeof toString === 'function') {
    const value: any = Porffor.callThis(toString, input);
    if (!Porffor.object.isObject(value)) return value;
  }

  const valueOf: any = input.valueOf;
  if (typeof valueOf === 'function') {
    const value: any = Porffor.callThis(valueOf, input);
    if (!Porffor.object.isObject(value)) return value;
  }

  throw new TypeError('Cannot convert an object to primitive');
};

// the hint "default" (+ and ==): given to the method as it is; with none, as "number", but a
// Date takes it as "string" (Date.prototype[@@toPrimitive]). Primitives pass through
export const __ecma262_ToPrimitive_Default = (input: any): any => {
  if (!Porffor.object.isObject(input)) return input;
  if (Porffor.comptime.flag`member.toPrimitive`) {
    const exotic: any = __Porffor_toPrimitiveMethod(input);
    if (exotic !== undefined) return __Porffor_callToPrimitive(exotic, input, 'default');
  }
  if (Porffor.type(input) == Porffor.TYPES.date) return __ecma262_ToPrimitive_String(input);
  return __ecma262_ToPrimitive_Number(input);
};

// 7.1.4 ToNumber (argument)
// https://tc39.es/ecma262/#sec-tonumber
export const __ecma262_ToNumber = (argument: unknown): number => {
  // 1. If argument is a Number, return argument.
  if (Porffor.type(argument) == Porffor.TYPES.number) return argument;

  // 2. If argument is either a Symbol or a BigInt, throw a TypeError exception.
  if (Porffor.fastOr(
    Porffor.type(argument) == Porffor.TYPES.symbol,
    Porffor.type(argument) == Porffor.TYPES.bigint)) throw new TypeError('Cannot convert Symbol or BigInt to a number');

  // 3. If argument is undefined, return NaN.
  if (Porffor.type(argument) == Porffor.TYPES.undefined) return NaN;

  // 4. If argument is either null or false, return +0𝔽.
  if (Porffor.fastOr(
    argument === null,
    argument === false
  )) return 0;

  // 5. If argument is true, return 1𝔽.
  if (argument === true) return 1;

  // 6. If argument is a String, return StringToNumber(argument).
  if ((Porffor.type(argument) | 0b10000000) == Porffor.TYPES.bytestring)
    return __ecma262_StringToNumber(argument);

  // 7. Assert: argument is an Object.
  // 8. Let primValue be ? ToPrimitive(argument, number).
  const primValue: any = __ecma262_ToPrimitive_Number(argument);

  // 9. Assert: primValue is not an Object.
  // 10. Return ? ToNumber(primValue).
  return __ecma262_ToNumber(primValue);
};


// 7.1.3 ToNumeric (value)
// https://tc39.es/ecma262/#sec-tonumeric
export const __ecma262_ToNumeric = (value: unknown): number => {
  // 1. Let primValue be ? ToPrimitive(value, number).
  // only run ToPrimitive if pure object for perf
  let primValue: any = value;
  if (Porffor.type(value) == Porffor.TYPES.object && Porffor.IR.ptr(value) != 0)
    primValue = __ecma262_ToPrimitive_Number(value);

  // 2. If primValue is a BigInt, return primValue.
  if (Porffor.comptime.flag`hasType.bigint`) {
    if (Porffor.type(primValue) == Porffor.TYPES.bigint) return primValue;
  }

  // 3. Return ? ToNumber(primValue).
  return __ecma262_ToNumber(primValue);
};

// 7.1.5 ToIntegerOrInfinity (argument)
// https://tc39.es/ecma262/#sec-tointegerorinfinity
export const __ecma262_ToIntegerOrInfinity = (argument: unknown): number => {
  // 1. Let number be ? ToNumber(argument).
  let number: number = __ecma262_ToNumber(argument);

  // 2. If number is one of NaN, +0𝔽, or -0𝔽, return 0.
  if (Number.isNaN(number)) return 0;

  // 3. If number is +∞𝔽, return +∞.
  // 4. If number is -∞𝔽, return -∞.
  if (!Number.isFinite(number)) return number;

  // 5. Return truncate(ℝ(number)).
  number = Math.trunc(number);

  // return 0 for -0
  if (number == 0) return 0;
  return number;
};

// 7.1.22 ToIndex (value)
export const __ecma262_ToIndex = (value: unknown): number => {
  // 1. Let integer be ? ToIntegerOrInfinity(value).
  const integer: number = __ecma262_ToIntegerOrInfinity(value);

  // 2. If integer is not in the inclusive interval from 0 to 2**53 - 1, throw a RangeError exception.
  if (Porffor.fastOr(
    integer < 0,
    integer > 9007199254740991
  )) throw new RangeError('Invalid index');

  // 3. Return integer.
  return integer;
};

// 7.1.17 ToString (argument)
// https://tc39.es/ecma262/#sec-tostring
export const __ecma262_ToString = (argument: unknown): any => {
  // 1. If argument is a String, return argument.
  if ((Porffor.type(argument) | 0b10000000) == Porffor.TYPES.bytestring)
    return argument;

  // 2. If argument is a Symbol, throw a TypeError exception.
  if (Porffor.type(argument) == Porffor.TYPES.symbol) throw new TypeError('Cannot convert a Symbol value to a string');

  // 3. If argument is undefined, return "undefined".
  if (Porffor.type(argument) == Porffor.TYPES.undefined) return 'undefined';

  // 4. If argument is null, return "null".
  if (argument === null) return 'null';

  if (Porffor.type(argument) == Porffor.TYPES.boolean) {
    // 5. If argument is true, return "true".
    if (argument == true) return 'true';

    // 6. If argument is false, return "false".
    return 'false';
  }

  // 7. If argument is a Number, return Number::toString(argument, 10).
  if (Porffor.type(argument) == Porffor.TYPES.number) return Porffor.callThis(__Number_prototype_toString, argument, 10);

  // 8. If argument is a BigInt, return BigInt::toString(argument, 10).
  if (Porffor.comptime.flag`hasType.bigint`) {
    if (Porffor.type(argument) == Porffor.TYPES.bigint) return __Porffor_bigint_toString(argument, 10);
  }

  // hack: StringObject -> String
  if (Porffor.type(argument) == Porffor.TYPES.stringobject) {
    return argument as string;
  }

  // 9. Assert: argument is an Object.
  // 10. Let primValue be ? ToPrimitive(argument, string).
  const primValue: any = __ecma262_ToPrimitive_String(argument);

  // 11. Assert: primValue is not an Object.
  // 12. Return ? ToString(primValue).
  return __ecma262_ToString(primValue);
};

// 7.1.19 ToPropertyKey (argument)
// https://tc39.es/ecma262/#sec-topropertykey
export const __ecma262_ToPropertyKey = (argument: any): any => {
  // 1. Let key be ? ToPrimitive(argument, string).
  // only run ToPrimitive if pure object for perf
  let key: any = argument;
  if (Porffor.type(argument) == Porffor.TYPES.object && Porffor.IR.ptr(argument) != 0)
    key = __ecma262_ToPrimitive_String(argument);

  // 2. If key is a Symbol, then
  if (Porffor.type(key) == Porffor.TYPES.symbol) {
    // a. Return key.
    return key;
  }

  // 3. Return ! ToString(key).
  return __ecma262_ToString(key);
};

export const __ecma262_IsConstructor = (argument: any): boolean => {
  if (Porffor.type(argument) != Porffor.TYPES.function) return false;
  return (__Porffor_funcLut_flags(argument) & 0b10) == 2;
};
