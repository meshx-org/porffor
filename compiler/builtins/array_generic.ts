import type {} from './porffor.d.ts';

// Array.prototype's iteration methods on a receiver that is not an array (an array-like, a
// primitive): the spec's steps on the object itself, LengthOfArrayLike first, then for each
// index HasProperty, Get and the call, so what a callback or a getter changes on the way is
// seen as the spec says. codegen sends a non-array this here (a proxy, whose traps the array
// versions' snapshot handles, still goes there).

// ToObject(this) and LengthOfArrayLike
export const __Porffor_arrayGeneric_object = (value: any): any => {
  if (value == null) throw new TypeError('Array.prototype method called on null or undefined');
  return ecma262.ToObject(value);
};

export const __Porffor_arrayGeneric_length = (o: any): number => {
  // (a builtin's .length is a raw load only an array or a string answers: read as the property)
  const len: number = ecma262.ToIntegerOrInfinity(__Porffor_object_get(o, 'length'));
  if (len <= 0) return 0;
  if (len > 9007199254740991) return 9007199254740991;
  return len;
};

export const __Porffor_arrayGeneric_forEach = (value: any, callbackFn: any, thisArg: any): void => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  for (let k: number = 0; k < len; k++) {
    if (k in o) callbackFn.call(thisArg, o[k], k, o);
  }
};

export const __Porffor_arrayGeneric_map = (value: any, callbackFn: any, thisArg: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const out: any = __Porffor_array_speciesCreate(o, len);
  for (let k: number = 0; k < len; k++) {
    if (k in o) __Porffor_array_createDataProperty(out, k, callbackFn.call(thisArg, o[k], k, o));
  }
  return out;
};

export const __Porffor_arrayGeneric_filter = (value: any, callbackFn: any, thisArg: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const out: any = __Porffor_array_speciesCreate(o, 0);
  let to: number = 0;
  for (let k: number = 0; k < len; k++) {
    if (k in o) {
      const v: any = o[k];
      if (!!callbackFn.call(thisArg, v, k, o)) __Porffor_array_createDataProperty(out, to++, v);
    }
  }
  return out;
};

export const __Porffor_arrayGeneric_some = (value: any, callbackFn: any, thisArg: any): boolean => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  for (let k: number = 0; k < len; k++) {
    if (k in o) {
      if (!!callbackFn.call(thisArg, o[k], k, o)) return true;
    }
  }
  return false;
};

export const __Porffor_arrayGeneric_every = (value: any, callbackFn: any, thisArg: any): boolean => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  for (let k: number = 0; k < len; k++) {
    if (k in o) {
      if (!callbackFn.call(thisArg, o[k], k, o)) return false;
    }
  }
  return true;
};

export const __Porffor_arrayGeneric_reduce = (value: any, callbackFn: any, initialValue: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  let k: number = 0;
  let acc: any = initialValue;
  if (acc === undefined) {
    let found: boolean = false;
    while (k < len) {
      if (k in o) {
        acc = o[k];
        found = true;
        k++;
        break;
      }
      k++;
    }
    if (!found) throw new TypeError('Reduce of empty array with no initial value');
  }
  for (; k < len; k++) {
    if (k in o) acc = callbackFn(acc, o[k], k, o);
  }
  return acc;
};

export const __Porffor_arrayGeneric_reduceRight = (value: any, callbackFn: any, initialValue: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  let k: number = len - 1;
  let acc: any = initialValue;
  if (acc === undefined) {
    let found: boolean = false;
    while (k >= 0) {
      if (k in o) {
        acc = o[k];
        found = true;
        k--;
        break;
      }
      k--;
    }
    if (!found) throw new TypeError('Reduce of empty array with no initial value');
  }
  for (; k >= 0; k--) {
    if (k in o) acc = callbackFn(acc, o[k], k, o);
  }
  return acc;
};

// find and friends read every index, present or not (Get, no HasProperty)
export const __Porffor_arrayGeneric_find = (value: any, predicate: any, thisArg: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(predicate) != Porffor.TYPES.function) throw new TypeError('Predicate must be a function');
  for (let k: number = 0; k < len; k++) {
    const v: any = o[k];
    if (!!predicate.call(thisArg, v, k, o)) return v;
  }
  return undefined;
};

export const __Porffor_arrayGeneric_findIndex = (value: any, predicate: any, thisArg: any): number => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(predicate) != Porffor.TYPES.function) throw new TypeError('Predicate must be a function');
  for (let k: number = 0; k < len; k++) {
    if (!!predicate.call(thisArg, o[k], k, o)) return k;
  }
  return -1;
};

export const __Porffor_arrayGeneric_findLast = (value: any, predicate: any, thisArg: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(predicate) != Porffor.TYPES.function) throw new TypeError('Predicate must be a function');
  for (let k: number = len - 1; k >= 0; k--) {
    const v: any = o[k];
    if (!!predicate.call(thisArg, v, k, o)) return v;
  }
  return undefined;
};

export const __Porffor_arrayGeneric_findLastIndex = (value: any, predicate: any, thisArg: any): number => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (Porffor.type(predicate) != Porffor.TYPES.function) throw new TypeError('Predicate must be a function');
  for (let k: number = len - 1; k >= 0; k--) {
    if (!!predicate.call(thisArg, o[k], k, o)) return k;
  }
  return -1;
};

export const __Porffor_arrayGeneric_indexOf = (value: any, searchElement: any, fromIndex: any): number => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (len == 0) return -1;
  let n: number = ecma262.ToIntegerOrInfinity(fromIndex);
  if (n == Infinity) return -1;
  if (n == -Infinity) n = 0;
  let k: number = n >= 0 ? n : len + n;
  if (k < 0) k = 0;
  for (; k < len; k++) {
    if (k in o) {
      if (o[k] === searchElement) return k;
    }
  }
  return -1;
};

export const __Porffor_arrayGeneric_lastIndexOf = (value: any, searchElement: any, fromIndex: any): number => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (len == 0) return -1;
  let n: number = fromIndex === undefined ? len - 1 : ecma262.ToIntegerOrInfinity(fromIndex);
  if (n == -Infinity) return -1;
  let k: number = n >= 0 ? (n < len - 1 ? n : len - 1) : len + n;
  for (; k >= 0; k--) {
    if (k in o) {
      if (o[k] === searchElement) return k;
    }
  }
  return -1;
};

export const __Porffor_arrayGeneric_includes = (value: any, searchElement: any, fromIndex: any): boolean => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  if (len == 0) return false;
  let n: number = ecma262.ToIntegerOrInfinity(fromIndex);
  if (n == Infinity) return false;
  if (n == -Infinity) n = 0;
  let k: number = n >= 0 ? n : len + n;
  if (k < 0) k = 0;
  for (; k < len; k++) {
    const v: any = o[k];
    // SameValueZero
    if (v === searchElement || (v !== v && searchElement !== searchElement)) return true;
  }
  return false;
};

// ArraySpeciesCreate: a plain array, or what an array's constructor's @@species makes of the
// length (in a program that names constructor or species, or subclasses: else neither can
// have changed)
export const __Porffor_array_speciesCreate = (original: any, length: number): any => {
  if (Porffor.comptime.flag`member.species`) return __Porffor_array_speciesConstruct(original, length);
  if (Porffor.comptime.flag`member.constructor`) return __Porffor_array_speciesConstruct(original, length);
  if (length > 4294967295) throw new RangeError('Invalid array length');
  const out: any[] = Porffor.array.new(4);
  out.length = length;
  return out;
};

export const __Porffor_array_speciesConstruct = (original: any, length: number): any => {
  if (Array.isArray(original)) {
    let C: any = original.constructor;
    if (Porffor.fastOr(Porffor.type(C) == Porffor.TYPES.object, Porffor.type(C) == Porffor.TYPES.function)) {
      if (C !== null) {
        C = C[Symbol.species];
        if (C === null) C = undefined;
      }
    }
    if (C !== undefined) {
      if (C !== Array) {
        if (!__ecma262_IsConstructor(C)) throw new TypeError('Array species is not a constructor');
        const args: any[] = Porffor.array.new(1);
        args[0] = length;
        return Porffor.call(C, args, null, C);
      }
    }
  }
  if (length > 4294967295) throw new RangeError('Invalid array length');
  const out: any[] = Porffor.array.new(4);
  out.length = length;
  return out;
};

// CreateDataPropertyOrThrow: an element defined (a setter does not run, a non-extensible or
// non-configurable target throws), directly on a plain array
export const __Porffor_array_createDataProperty = (target: any, index: number, value: any): void => {
  // (only a species makes anything else)
  if (Porffor.comptime.flag`member.species`) {} else if (Porffor.comptime.flag`member.constructor`) {} else {
    target[index] = value;
    return;
  }
  __Porffor_object_createDataProperty(target, index, value);
};

// CreateDataPropertyOrThrow on any object: a writable, enumerable, configurable data property
export const __Porffor_object_createDataProperty = (target: any, key: any, value: any): void => {
  if (Porffor.type(target) == Porffor.TYPES.array) {
    if (Porffor.type(key) == Porffor.TYPES.number) if (key < 4294967295) {
      // (an array with a side table may hold a property of its own there, a non-writable one
      // included, that the definition replaces)
      const table: any = __Porffor_object_underlyingFind(target);
      if (Porffor.IR.ptr(table) != 0) {
        const p: any = ecma262.ToPropertyKey(key);
        if (__Porffor_object_lookup(table, p, __Porffor_object_hash(p)) != 0) {
          // redefined where it is (a non-configurable one throws), as defineProperty does
          __Porffor_object_define(target, p, value, 0b1110);
          if (key >= (target as any[]).length) __Porffor_array_setLength(target as any[], key + 1);
          __Porffor_array_delete(target as any[], key);
          return;
        }
      }
      target[key] = value;
      return;
    }
  }
  if (Porffor.comptime.flag`hasType.proxy`) {
    if (Porffor.type(target) == Porffor.TYPES.proxy) {
      Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
      return;
    }
  }
  // (an array's other keys live in its property store, which define reaches)
  __Porffor_object_define(target, ecma262.ToPropertyKey(key), value, 0b1110);
};

// IsConcatSpreadable
export const __Porffor_arrayGeneric_spreadable = (value: any): boolean => {
  if (Porffor.fastOr(Porffor.type(value) == Porffor.TYPES.undefined, value === null)) return false;
  const t: i32 = Porffor.type(value);
  if (Porffor.fastOr(t == Porffor.TYPES.number, t == Porffor.TYPES.boolean, t == Porffor.TYPES.string, t == Porffor.TYPES.bytestring, t == Porffor.TYPES.symbol, t == Porffor.TYPES.bigint)) return false;
  const spreadable: any = value[Symbol.isConcatSpreadable];
  if (spreadable !== undefined) return !!spreadable;
  return Array.isArray(value);
};

// Array.prototype.concat, as the spec says
export const __Porffor_arrayGeneric_concat = (value: any, items: any[]): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const out: any = __Porffor_array_speciesCreate(o, 0);
  let n: number = 0;
  const count: i32 = items.length;
  for (let i: i32 = -1; i < count; i++) {
    const e: any = i < 0 ? o : items[i];
    if (__Porffor_arrayGeneric_spreadable(e)) {
      const len: number = __Porffor_arrayGeneric_length(e);
      if (n + len > 9007199254740991) throw new TypeError('Array length exceeds the maximum');
      for (let k: number = 0; k < len; k++) {
        if (k in e) __Porffor_array_createDataProperty(out, n, e[k]);
        n++;
      }
    } else {
      if (n >= 9007199254740991) throw new TypeError('Array length exceeds the maximum');
      __Porffor_array_createDataProperty(out, n, e);
      n++;
    }
  }
  __Porffor_array_setResultLength(out, n);
  return out;
};

// a relative index (start, end) clamped to [0, len]
export const __Porffor_arrayGeneric_relative = (value: any, len: number): number => {
  const rel: number = ecma262.ToIntegerOrInfinity(value);
  if (rel < 0) {
    const k: number = len + rel;
    return k < 0 ? 0 : k;
  }
  return rel > len ? len : rel;
};

// Set(O, "length", len, true)
export const __Porffor_arrayGeneric_setLength = (o: any, len: number): void => {
  if (Porffor.type(o) == Porffor.TYPES.array) {
    o.length = len;
    return;
  }
  // an array-like itself (Array.prototype.splice.call(obj)) has any length set
  __Porffor_arrayGeneric_setObjectLength(o, len);
};

export const __Porffor_arrayGeneric_setObjectLength = (o: any, len: number): void => {
  const boxed: any = len;
  __Porffor_object_setStrict(o, 'length', boxed);
};

// Set(A, "length", n, true) of what ArraySpeciesCreate made: an array, but for a species
export const __Porffor_array_setResultLength = (out: any, len: number): void => {
  if (Porffor.comptime.flag`member.species`) {} else if (Porffor.comptime.flag`member.constructor`) {} else {
    out.length = len;
    return;
  }
  __Porffor_arrayGeneric_setLength(out, len);
};

// DeletePropertyOrThrow
export const __Porffor_arrayGeneric_delete = (o: any, k: number): void => {
  __Porffor_object_deleteStrict(o, ecma262.ToPropertyKey(k));
};

// Set(O, k, v, true)
export const __Porffor_arrayGeneric_set = (o: any, k: number, v: any): void => {
  __Porffor_object_setStrict(o, k, v);
};

// Array.prototype.slice, as the spec says
export const __Porffor_arrayGeneric_slice = (value: any, start: any, end: any): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  let k: number = __Porffor_arrayGeneric_relative(start, len);
  const final: number = Porffor.type(end) == Porffor.TYPES.undefined ? len : __Porffor_arrayGeneric_relative(end, len);
  let count: number = final - k;
  if (count < 0) count = 0;
  const out: any = __Porffor_array_speciesCreate(o, count);
  let n: number = 0;
  for (; k < final; k++) {
    if (k in o) __Porffor_array_createDataProperty(out, n, o[k]);
    n++;
  }
  __Porffor_array_setResultLength(out, n);
  return out;
};

// Array.prototype.splice, as the spec says
export const __Porffor_arrayGeneric_splice = (value: any, start: any, deleteCount: any, items: any[]): any => {
  const o: any = __Porffor_arrayGeneric_object(value);
  const len: number = __Porffor_arrayGeneric_length(o);
  const actualStart: number = __Porffor_arrayGeneric_relative(start, len);
  const itemCount: number = items.length;
  // (how many arguments came is read from which are undefined: splice() deletes nothing,
  // splice(start) the rest)
  let actualDeleteCount: number = 0;
  if (Porffor.fastAnd(Porffor.type(start) == Porffor.TYPES.undefined, Porffor.type(deleteCount) == Porffor.TYPES.undefined)) actualDeleteCount = 0;
  else if (Porffor.type(deleteCount) == Porffor.TYPES.undefined) actualDeleteCount = len - actualStart;
  else {
    const dc: number = ecma262.ToIntegerOrInfinity(deleteCount);
    actualDeleteCount = dc < 0 ? 0 : dc;
    if (actualDeleteCount > len - actualStart) actualDeleteCount = len - actualStart;
  }
  if (len + itemCount - actualDeleteCount > 9007199254740991) throw new TypeError('Array length exceeds the maximum');

  const removed: any = __Porffor_array_speciesCreate(o, actualDeleteCount);
  for (let k: number = 0; k < actualDeleteCount; k++) {
    const from: number = actualStart + k;
    if (from in o) __Porffor_array_createDataProperty(removed, k, o[from]);
  }
  __Porffor_array_setResultLength(removed, actualDeleteCount);
  // an array's own elements move as the fast splice moves them
  if (Porffor.type(o) == Porffor.TYPES.array) {
    __Porffor_array_spliceElements(o, actualStart, actualDeleteCount, items);
    return removed;
  }

  if (itemCount < actualDeleteCount) {
    for (let k: number = actualStart; k < len - actualDeleteCount; k++) {
      const from: number = k + actualDeleteCount;
      const to: number = k + itemCount;
      if (from in o) __Porffor_arrayGeneric_set(o, to, o[from]);
      else __Porffor_arrayGeneric_delete(o, to);
    }
    for (let k: number = len; k > len - actualDeleteCount + itemCount; k--) __Porffor_arrayGeneric_delete(o, k - 1);
  } else if (itemCount > actualDeleteCount) {
    for (let k: number = len - actualDeleteCount; k > actualStart; k--) {
      const from: number = k + actualDeleteCount - 1;
      const to: number = k + itemCount - 1;
      if (from in o) __Porffor_arrayGeneric_set(o, to, o[from]);
      else __Porffor_arrayGeneric_delete(o, to);
    }
  }
  for (let i: i32 = 0; i < itemCount; i++) __Porffor_arrayGeneric_set(o, actualStart + i, items[i]);
  __Porffor_arrayGeneric_setLength(o, len - actualDeleteCount + itemCount);
  return removed;
};
