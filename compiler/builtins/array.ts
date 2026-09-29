import type {} from './porffor.d.ts';

export const Array = function (...args: any[]): any[] {
  const argsLen: number = args.length;
  if (argsLen == 0) {
    // no args: empty array
    const out: any[] = Porffor.array.new(4);
    return out;
  }

  if (argsLen == 1) {
    // 1 arg, length (number) or first element (non-number)
    const arg: any = args[0];
    if (Porffor.type(arg) == Porffor.TYPES.number) {
      // number so use as length
      const n: number = args[0];
      if (Porffor.fastOr(
        n < 0, // negative
        n > 4294967295, // over 2**32 - 1
        !Number.isInteger(n) // non-integer/non-finite
      )) throw new RangeError('Invalid array length');

      const out: any[] = Porffor.array.new(n);
      out.length = n;
      return out;
    }

    // not number, leave to fallthrough as same as >1
  }

  // >1 arg, just return args array
  return args;
};

export const __Array_isArray = (x: unknown): boolean => {
  if (Porffor.type(x) == Porffor.TYPES.array) return !__Porffor_array_isArguments(x);
  // a proxy is an array when its target is (a revoked one throws)
  if (Porffor.comptime.flag`hasType.proxy`) {
    if (Porffor.type(x) == Porffor.TYPES.proxy) {
      __Porffor_proxy_handler(x);
      return __Array_isArray(__Porffor_proxy_target(x));
    }
  }
  return false;
};

// Array.of as a value (Array.of.call(C, ...), a reference to it): the arguments as elements
// of a new C(length) when this is a constructor, else of a plain array. A direct Array.of(...)
// call never gets here: it compiles to an array literal (builtins.js)
export const __Array_of = function (this: any, ...items: any[]): any {
  if (!__ecma262_IsConstructor(this)) return items;

  const len: i32 = items.length;
  const args: any[] = Porffor.array.new(1);
  args[0] = len;
  const out: any = Porffor.call(this, args, null, this);
  // CreateDataPropertyOrThrow, not a set: a setter on the instance must not run
  for (let k: i32 = 0; k < len; k++) {
    Object.defineProperty(out, k, { value: items[k], writable: true, enumerable: true, configurable: true });
  }
  out.length = len;
  return out;
};

// Array.from on a constructor other than Array (a subclass, Array.from.call(C, ...)): the
// elements, gathered as for Array, then defined on what C constructs
export const __Array_from = function (this: any, arg: any, mapFn: any, thisArg: any): any {
  const items: any[] = __Porffor_array_from(arg, mapFn, thisArg);
  // (a subclass names species; another receiver comes by Array.from.call. An apply or a
  // bind of it is not looked for: the check would cost every program that applies anything)
  if (Porffor.comptime.flag`member.species`) return __Porffor_array_fromConstruct(this, arg, items);
  if (Porffor.comptime.flag`member.call`) return __Porffor_array_fromConstruct(this, arg, items);
  return items;
};

export const __Porffor_array_fromConstruct = (C: any, arg: any, items: any[]): any => {
  if (C === Array) return items;
  if (!__ecma262_IsConstructor(C)) return items;

  const len: i32 = items.length;
  const args: any[] = Porffor.array.new(1);
  args[0] = len;
  // an array-like gives C its length, an iterable nothing
  let iterable: boolean = Porffor.fastOr(Porffor.type(arg) != Porffor.TYPES.object, arg.__kind !== undefined);
  if (Porffor.comptime.flag`program.usesIterProtocol`) {
    if (!iterable) iterable = typeof arg[Symbol.iterator] === 'function';
  }
  if (iterable) args.length = 0;
  const out: any = Porffor.call(C, args, null, C);
  for (let k: i32 = 0; k < len; k++) __Porffor_object_createDataProperty(out, k, items[k]);
  __Porffor_arrayGeneric_setLength(out, len);
  return out;
};

export const __Porffor_array_from = (arg: any, mapFn: any, thisArg: any): any[] => {
  if (arg == null) throw new TypeError('Argument cannot be nullish');

  const out: any[] = Porffor.array.new(4);
  if (Porffor.fastOr(
    Porffor.type(arg) == Porffor.TYPES.array,
    (Porffor.type(arg) | 0b10000000) == Porffor.TYPES.bytestring,
    Porffor.type(arg) == Porffor.TYPES.set,
    Porffor.fastAnd(Porffor.type(arg) >= Porffor.TYPES.uint8clampedarray, Porffor.type(arg) <= Porffor.TYPES.float64array)
  )) {
    let i: i32 = 0;
    if (Porffor.type(mapFn) != Porffor.TYPES.undefined) {
      if (Porffor.type(mapFn) != Porffor.TYPES.function) throw new TypeError('Called Array.from with a non-function mapFn');

      for (const x of arg) {
        out[i] = mapFn.call(thisArg, x, i);
        i++;
      }
    } else {
      for (const x of arg) {
        out[i++] = x;
      }
    }

    out.length = i;
    return out;
  }

  // an iterable (a Map, a generator, an object with [Symbol.iterator]) by the iterator protocol
  // (a built-in iterator object is known by its __kind; [Symbol.iterator] is read only in a
  // program that can name it)
  let iterable: boolean = Porffor.fastOr(
    Porffor.type(arg) == Porffor.TYPES.map,
    Porffor.type(arg) == Porffor.TYPES.__porffor_generator
  );
  if (!iterable) if (Porffor.object.isObject(arg)) iterable = arg.__kind !== undefined;
  if (Porffor.comptime.flag`program.usesIterProtocol`) {
    if (!iterable) iterable = typeof arg[Symbol.iterator] === 'function';
  }
  if (iterable) {
    let i: i32 = 0;
    const mapping: boolean = Porffor.type(mapFn) != Porffor.TYPES.undefined;
    if (mapping && Porffor.type(mapFn) != Porffor.TYPES.function) throw new TypeError('Called Array.from with a non-function mapFn');
    for (const x of arg) {
      out[i] = mapping ? mapFn.call(thisArg, x, i) : x;
      i++;
    }
    out.length = i;
    return out;
  }

  if (__Porffor_object_isObject(arg)) {
    const obj: object = Porffor.type(arg) == Porffor.TYPES.object ? arg : __Porffor_object_underlying(arg);
    // check before i32 truncation: huge lengths saturate to exactly 2147483647
    const lenRaw: number = ecma262.ToIntegerOrInfinity(obj['length']);
    if (lenRaw > 2147483647) throw new RangeError('Invalid array length');
    let len: i32 = lenRaw;
    if (len < 0) len = 0;

    if (Porffor.type(mapFn) != Porffor.TYPES.undefined) {
      if (Porffor.type(mapFn) != Porffor.TYPES.function) throw new TypeError('Called Array.from with a non-function mapFn');

      for (let i: i32 = 0; i < len; i++) {
        out[i] = mapFn.call(thisArg, obj[i], i);
      }
    } else {
      for (let i: i32 = 0; i < len; i++) {
        out[i] = obj[i];
      }
    }

    out.length = len;
    return out;
  }

  return out;
};

// 23.1.2.2 Array.fromAsync (items [, mapper [, thisArg]])
// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.fromasync
export const __Array_fromAsync = async function (items: any, mapper: any = undefined, thisArg: any = undefined) {
  if (items == null) throw new TypeError('Argument cannot be nullish');

  const out: any[] = Porffor.array.new(4);
  const mapping: boolean = Porffor.type(mapper) != Porffor.TYPES.undefined;
  if (mapping && Porffor.type(mapper) != Porffor.TYPES.function) throw new TypeError('Called Array.fromAsync with a non-function mapper');

  if (Porffor.fastOr(
    Porffor.type(items) == Porffor.TYPES.array,
    (Porffor.type(items) | 0b10000000) == Porffor.TYPES.bytestring,
    Porffor.type(items) == Porffor.TYPES.set,
    Porffor.type(items) == Porffor.TYPES.map,
    Porffor.type(items) == Porffor.TYPES.__porffor_generator,
    Porffor.type(items) == Porffor.TYPES.__porffor_asyncgenerator,
    Porffor.fastAnd(Porffor.type(items) >= Porffor.TYPES.uint8clampedarray, Porffor.type(items) <= Porffor.TYPES.float64array)
  )) {
    let i: i32 = 0;
    if (mapping) {
      for await (const x of items) {
        out[i] = await mapper.call(thisArg, x, i);
        i++;
      }
    } else {
      for await (const x of items) {
        out[i++] = x;
      }
    }

    out.length = i;
    return out;
  }

  if (__Porffor_object_isObject(items)) {
    const obj: object = Porffor.type(items) == Porffor.TYPES.object ? items : __Porffor_object_underlying(items);
    const lenRaw: number = ecma262.ToIntegerOrInfinity(obj['length']);
    if (lenRaw > 2147483647) throw new RangeError('Invalid array length');
    let len: i32 = lenRaw;
    if (len < 0) len = 0;

    if (mapping) {
      for (let i: i32 = 0; i < len; i++) {
        out[i] = await mapper.call(thisArg, await obj[i], i);
      }
    } else {
      for (let i: i32 = 0; i < len; i++) {
        out[i] = await obj[i];
      }
    }

    out.length = len;
    return out;
  }

  return out;
};

// 23.1.3.1 Array.prototype.at (index)
// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.at
export const __Array_prototype_at = function (this: any[], index: any) {
  // 1. Let O be ? ToObject(this value).
  // 2. Let len be ? LengthOfArrayLike(O).
  const len: i32 = this.length;

  // 3. Let relativeIndex be ? ToIntegerOrInfinity(index).
  index = ecma262.ToIntegerOrInfinity(index);

  // 4. If relativeIndex ≥ 0, then
  //        a. Let k be relativeIndex.
  // 5. Else,
  //        a. Let k be len + relativeIndex.
  if (index < 0) index = len + index;

  // 6. If k < 0 or k ≥ len, return undefined.
  if (Porffor.fastOr(index < 0, index >= len)) return undefined;

  // 7. Return ? Get(O, ! ToString(𝔽(k))).
  return this[index];
};

export const __Array_prototype_push = function (this: any[], ...items: any[]) {
  let len: i32 = this.length;
  const itemsLen: i32 = items.length;
  const newLen: i32 = len + itemsLen;
  this.length = newLen;

  for (let i: i32 = 0; i < itemsLen; i++) {
    this[i + len] = items[i];
  }

  return newLen;
};

// An Array.prototype method whose this is not an array (a proxy, an array-like) runs on a
// copy of it (codegen's #this guard): its length and elements read through [[Get]], so a
// proxy's traps run. By index, never by iterator: iterating a proxy of an array calls the
// array iterator with the proxy as this, which would copy through this again.
export const __Porffor_array_snapshot = (obj: any): any[] => {
  const o: any = obj;
  // ToLength: an integer, clamped at 0. Builtins compile .length as a raw load
  // (--fast-length), which only an array or a string can answer: anything else (a proxy,
  // whose get trap then runs, or an array-like) is read as the property it is
  let len: number = 0;
  if (Porffor.type(o) == Porffor.TYPES.array) len = o.length;
    else len = ecma262.ToIntegerOrInfinity(__Porffor_object_get(o, 'length'));
  if (len < 0) len = 0;
  if (len > 268435455) throw new RangeError('Invalid array length');
  const n: i32 = len;
  const out: any[] = Porffor.array.new(n);
  for (let i: i32 = 0; i < n; i++) out[i] = o[i];
  out.length = n;
  return out;
};

// After a mutating method ran on the copy: what changed goes back through [[Set]] and
// [[Delete]] (new or different elements, those past the new length), then the length
export const __Porffor_array_writeBack = (obj: any, before: any[], after: any[]): void => {
  const o: any = obj;
  const oldLen: i32 = before.length;
  const newLen: i32 = after.length;
  for (let i: i32 = 0; i < newLen; i++) {
    if (i >= oldLen || !Object.is(before[i], after[i])) o[i] = after[i];
  }
  for (let i: i32 = newLen; i < oldLen; i++) delete o[i];
  // boxed first: an i32 set on an untyped object leaves an unboxed result behind
  const boxedLen: any = newLen;
  if (newLen != oldLen) o.length = boxedLen;
};

export const __Porffor_array_spread = (arr: any[], src: any) => {
  let len: i32 = arr.length;

  switch (Porffor.type(src)) {
    case Porffor.TYPES.set:
      return __Porffor_array_spread(arr, Porffor.callThis(__Porffor_set_valuesArray, src));

    case Porffor.TYPES.map:
      return __Porffor_array_spread(arr, Porffor.callThis(__Porffor_map_entriesArray, src));

    case Porffor.TYPES.__porffor_generator:
      while (!Porffor.coroutine.resume(src, undefined, 0 as i32)) {
        arr[len] = Porffor.coroutine.value(src);
        len++;
      }

      return len;

    case Porffor.TYPES.__porffor_asyncgenerator:
      throw new TypeError('Cannot spread async generator');

    // by code point: a surrogate pair is one element
    case Porffor.TYPES.string: {
      const units: i32 = src.length;
      for (let i: i32 = 0; i < units; ) {
        const ch: string = __Porffor_string_iterAt(src, i);
        arr[len++] = ch;
        i += ch.length;
      }
      return len;
    }
  }

  // anything but an array, a typed array or a bytestring: the iterator protocol
  const t: i32 = Porffor.type(src);
  if (!Porffor.fastOr(
    t == Porffor.TYPES.array,
    t == Porffor.TYPES.bytestring,
    Porffor.fastAnd(t >= Porffor.TYPES.uint8clampedarray, t <= Porffor.TYPES.float64array)
  )) {
    if (Porffor.comptime.flag`program.usesIterProtocol`) {
      const rec: any = __Porffor_iter_open(src);
      while (true) {
        const v: any = __Porffor_iter_step(rec);
        if (rec.done) break;
        arr[len++] = v;
      }
    } else {
      // a program that cannot make its own iterators: a built-in iterator object, or nothing
      while (true) {
        const v: any = __Porffor_iter_stepBuiltinOnly(src);
        if (src.__done) break;
        arr[len++] = v;
      }
    }
    return len;
  }

  const srcLen: i32 = src.length;
  const newLen: i32 = len + srcLen;
  arr.length = newLen;

  for (let i: i32 = 0; i < srcLen; i++) {
    arr[i + len] = src[i];
  }

  return newLen;
};

export const __Array_prototype_pop = function (this: any[]) {
  const len: i32 = this.length;
  if (len == 0) return undefined;

  const lastIndex: i32 = len - 1;
  const element: any = this[lastIndex];
  __Porffor_array_setLength(this, lastIndex);

  return element;
};

export const __Array_prototype_shift = function (this: any[]) {
  const len: i32 = this.length;
  if (len == 0) return undefined;

  const element: any = this[0];
  // an array without holes: its entries moved down at once (a hole reads through the
  // prototype chain, which the element by element move below does)
  let dense: boolean = Porffor.type(this) == Porffor.TYPES.array;
  if (dense) for (let i: i32 = 1; i < len; i++) if (!__Porffor_array_has(this, i)) {
    dense = false;
    break;
  }

  if (dense) {
    const entries: i32 = __Porffor_array_ensure(this, len);
    Porffor.IR.copy(entries, entries + 8, (len - 1) * 8);
    Porffor.IR.gcBarrier(this, Porffor.TYPES.array);
  } else {
    const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
    for (let i: i32 = 1; i < len; i++) {
      if (__Porffor_array_hasIndex(this, i)) this[i - 1] = this[i];
      else if (isArray) __Porffor_array_delete(this, i - 1);
      else __Porffor_object_deleteStrict(this, Porffor.callThis(__Number_prototype_toString, i - 1));
    }
  }
  __Porffor_array_setLength(this, len - 1);

  return element;
};

export const __Array_prototype_unshift = function (this: any[], ...items: any[]) {
  let len: i32 = this.length;
  const itemsLen: i32 = items.length;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;

  let i: i32 = len;
  while (i > 0) {
    i--;
    if (__Porffor_array_hasIndex(this, i)) this[i + itemsLen] = this[i];
      else __Porffor_array_delete(this, i + itemsLen);
  }

  for (let i: i32 = 0; i < itemsLen; i++) {
    this[i] = items[i];
  }

  const newLen: i32 = len + itemsLen;
  __Porffor_array_setLength(this, newLen);
  return newLen;
};

export const __Array_prototype_slice = function (this: any[], _start: any, _end: any) {
  // a subclass's species, or a constructor of its own, can be in a program that names them
  if (Porffor.type(this) == Porffor.TYPES.array) {
    if (Porffor.comptime.flag`member.species`) return __Porffor_arrayGeneric_slice(this, _start, _end);
    if (Porffor.comptime.flag`member.constructor`) return __Porffor_arrayGeneric_slice(this, _start, _end);
  }
  const len: i32 = this.length;
  if (Porffor.type(_end) == Porffor.TYPES.undefined) _end = len;

  let start: i32 = ecma262.ToIntegerOrInfinity(_start);
  let end: i32 = ecma262.ToIntegerOrInfinity(_end);

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

  if (len == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  const out: any[] = Porffor.array.new(4);

  if (start > end) return out;

  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  let j: i32 = 0;
  for (let i: i32 = start; i < end; i++) {
    if (__Porffor_array_hasIndex(this, i)) out[j] = this[i];
    j++;
  }

  out.length = end - start;
  return out;
};

export const __Array_prototype_splice = function (this: any[], _start: any, _deleteCount: any, ...items: any[]) {
  // a subclass's species, or a constructor of its own, can be in a program that names them
  if (Porffor.type(this) == Porffor.TYPES.array) {
    if (Porffor.comptime.flag`member.species`) return __Porffor_arrayGeneric_splice(this, _start, _deleteCount, items);
    if (Porffor.comptime.flag`member.constructor`) return __Porffor_arrayGeneric_splice(this, _start, _deleteCount, items);
  }
  const len: i32 = this.length;

  let start: i32 = ecma262.ToIntegerOrInfinity(_start);
  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }
  if (start > len) start = len;

  if (Porffor.type(_deleteCount) == Porffor.TYPES.undefined) _deleteCount = len - start;
  let deleteCount: i32 = ecma262.ToIntegerOrInfinity(_deleteCount);

  if (deleteCount < 0) deleteCount = 0;
  if (deleteCount > len - start) deleteCount = len - start;

  return __Porffor_array_spliceElements(this, start, deleteCount, items);
};

// splice's moves on an array's elements, the removed ones handed back as an array
export const __Porffor_array_spliceElements = (arr: any[], start: i32, deleteCount: i32, items: any[]): any[] => {
  const len: i32 = arr.length;
  let outCapacity: i32 = deleteCount;
  if (outCapacity < 4) outCapacity = 4;

  const out: any[] = Porffor.array.new(outCapacity);

  const itemsLen: i32 = items.length;
  const newLen: i32 = len - deleteCount + itemsLen;
  const tailLen: i32 = len - start - deleteCount;
  const entries: i32 = __Porffor_array_ensure(arr, newLen);

  if (deleteCount > 0) {
    const outEntries: i32 = Porffor.IR.loadI32(out, 4);
    Porffor.IR.copy(outEntries, entries + start * 8, deleteCount * 8);
  }
  out.length = deleteCount;

  if (itemsLen < deleteCount) {
    Porffor.IR.copy(entries + (start + itemsLen) * 8, entries + (start + deleteCount) * 8, tailLen * 8);
  } else if (itemsLen > deleteCount) {
    Porffor.IR.copy(entries + (start + itemsLen) * 8, entries + (start + deleteCount) * 8, tailLen * 8);
  }

  if (itemsLen > 0) {
    const itemsEntries: i32 = __Porffor_array_ensure(items, 0);
    Porffor.IR.copy(entries + start * 8, itemsEntries, itemsLen * 8);
    Porffor.IR.gcBarrier(arr, Porffor.TYPES.array);
  }

  __Porffor_array_setLength(arr, newLen);

  return out;
};

// @porf-typed-array
export const __Array_prototype_fill = function (this: any[], value: any, _start: any, _end: any) {
  const len: i32 = this.length;

  if (Porffor.type(_start) == Porffor.TYPES.undefined) _start = 0;
  if (Porffor.type(_end) == Porffor.TYPES.undefined) _end = len;

  let start: i32 = ecma262.ToIntegerOrInfinity(_start);
  let end: i32 = ecma262.ToIntegerOrInfinity(_end);

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

  // a byte array's fill: the first store converts the value, the rest is one memset of its byte
  if (Porffor.fastOr(Porffor.type(this) == Porffor.TYPES.uint8array, Porffor.type(this) == Porffor.TYPES.uint8clampedarray, Porffor.type(this) == Porffor.TYPES.int8array)) {
    if (start < end) {
      this[start] = value;
      const data: i32 = Porffor.IR.loadI32(this, 4) + 4;
      Porffor.IR.fill(data + start + 1, Porffor.IR.loadU8(data + start, 0), end - start - 1);
    }
    return this;
  }

  for (let i: i32 = start; i < end; i++) {
    this[i] = value;
  }

  return this;
};

// @porf-typed-array
export const __Array_prototype_indexOf = function (this: any[], searchElement: any, _position: any) {
  const len: i32 = this.length;
  if (len == 0) return -1;

  let position: i32 = ecma262.ToIntegerOrInfinity(_position);
  if (position >= 0) {
    if (position > len) position = len;
  } else {
    position = len + position;
    if (position < 0) position = 0;
  }

  // a byte array's search is a SIMD scan for the byte; a value that is no byte is never there
  if (Porffor.fastOr(Porffor.type(this) == Porffor.TYPES.uint8array, Porffor.type(this) == Porffor.TYPES.uint8clampedarray)) {
    if (Porffor.type(searchElement) != Porffor.TYPES.number) return -1;
    if (!Number.isInteger(searchElement) || searchElement < 0 || searchElement > 255) return -1;
    const found: i32 = __Porffor_simd_findU8(Porffor.IR.loadI32(this, 4), position, len, searchElement);
    return found;
  }

  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  for (let i: i32 = position; i < len; i++) {
    if (!__Porffor_array_hasIndex(this, i)) continue;
    if (this[i] === searchElement) return i;
  }

  return -1;
};

// @porf-typed-array
export const __Array_prototype_lastIndexOf = function (this: any[], searchElement: any, _position: any) {
  const len: i32 = this.length;
  if (len == 0) return -1;

  let position: i32 = _position == null ? len - 1 : ecma262.ToIntegerOrInfinity(_position);
  if (position >= 0) {
    if (position > len - 1) position = len - 1;
  } else {
    position = len + position;
  }

  // a byte array's search is a SIMD scan backwards for the byte
  if (Porffor.fastOr(Porffor.type(this) == Porffor.TYPES.uint8array, Porffor.type(this) == Porffor.TYPES.uint8clampedarray)) {
    if (position < 0) return -1;
    if (Porffor.type(searchElement) != Porffor.TYPES.number) return -1;
    if (!Number.isInteger(searchElement) || searchElement < 0 || searchElement > 255) return -1;
    return __Porffor_simd_rfindU8(Porffor.IR.loadI32(this, 4), 0, position + 1, searchElement);
  }

  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  for (let i: i32 = position; i >= 0; i--) {
    if (!__Porffor_array_hasIndex(this, i)) continue;
    if (this[i] === searchElement) return i;
  }

  return -1;
};

// @porf-typed-array
export const __Array_prototype_includes = function (this: any[], searchElement: any, _position: any) {
  const len: i32 = this.length;
  if (len == 0) return false;

  let position: i32 = ecma262.ToIntegerOrInfinity(_position);
  if (position >= 0) {
    if (position > len) position = len;
  } else {
    position = len + position;
    if (position < 0) position = 0;
  }

  // a byte array's search is a SIMD scan for the byte; a value that is no byte is never there
  if (Porffor.fastOr(Porffor.type(this) == Porffor.TYPES.uint8array, Porffor.type(this) == Porffor.TYPES.uint8clampedarray)) {
    if (Porffor.type(searchElement) != Porffor.TYPES.number) return false;
    if (!Number.isInteger(searchElement) || searchElement < 0 || searchElement > 255) return false;
    const found: i32 = __Porffor_simd_findU8(Porffor.IR.loadI32(this, 4), position, len, searchElement);
    return found != -1;
  }

  for (let i: i32 = position; i < len; i++) {
    if (__ecma262_SameValueZero(this[i], searchElement)) return true;
  }

  return false;
};

// @porf-typed-array
export const __Array_prototype_with = function (this: any[], _index: any, value: any) {
  const len: i32 = this.length;

  let index: i32 = ecma262.ToIntegerOrInfinity(_index);
  if (index < 0) {
    index = len + index;
    if (index < 0) {
      throw new RangeError('Invalid index');
    }
  }

  if (index >= len) {
    throw new RangeError('Invalid index');
  }

  const out: any[] = Porffor.array.new(len);

  out.length = len;
  // (the replaced index is never read: a getter on it does not run)
  for (let i: i32 = 0; i < len; i++) out[i] = i == index ? value : this[i];

  return out;
};

// @porf-typed-array
export const __Array_prototype_copyWithin = function (this: any[], _target: any, _start: any, _end: any) {
  const len: i32 = this.length;

  let targetNum: number = ecma262.ToIntegerOrInfinity(_target);
  if (targetNum < 0) {
    targetNum = len + targetNum;
    if (targetNum < 0) targetNum = 0;
  }
  if (targetNum > len) targetNum = len;
  let target: i32 = targetNum;

  let startNum: number = ecma262.ToIntegerOrInfinity(_start);
  if (startNum < 0) {
    startNum = len + startNum;
    if (startNum < 0) startNum = 0;
  }
  if (startNum > len) startNum = len;
  let start: i32 = startNum;

  let end: i32;
  if (Porffor.type(_end) == Porffor.TYPES.undefined) {
    end = len;
  } else {
    let endNum: number = ecma262.ToIntegerOrInfinity(_end);
    if (endNum < 0) {
      endNum = len + endNum;
      if (endNum < 0) endNum = 0;
    }
    if (endNum > len) endNum = len;
    end = endNum;
  }

  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  let count: i32 = 0;
  if (end > start) count = end - start;
  const targetRoom: i32 = len - target;
  if (count > targetRoom) count = targetRoom;
  if (count <= 0) return this;
  let direction: i32 = 1;
  if (Porffor.fastAnd(start < target, target < start + count)) {
    direction = -1;
    start += count - 1;
    target += count - 1;
  }

  while (count > 0) {
    if (__Porffor_array_hasIndex(this, start)) this[target] = this[start];
      else __Porffor_array_delete(this, target);
    start += direction;
    target += direction;
    count--;
  }

  return this;
};

// @porf-typed-array
export const __Array_prototype_concat = function (this: any[], ...vals: any[]) {
  // a spreadable object or a species of its own can be in a program that names them: the
  // spec's steps (builtins/array_generic.ts)
  if (Porffor.comptime.flag`member.isConcatSpreadable`) return __Porffor_arrayGeneric_concat(this, vals);
  if (Porffor.comptime.flag`member.species`) return __Porffor_arrayGeneric_concat(this, vals);
  if (Porffor.comptime.flag`member.constructor`) return __Porffor_arrayGeneric_concat(this, vals);
  let len: i32 = this.length;
  const out: any[] = Porffor.array.new(len);

  out.length = len;
  for (let i: i32 = 0; i < len; i++) {
    if (__Porffor_array_hasIndex(this, i)) out[i] = this[i];
  }

  for (const x of vals) {
    if (Porffor.type(x) == Porffor.TYPES.array) {
      // todo: for..of is broken here because ??
      const l: i32 = x.length;
      for (let i: i32 = 0; i < l; i++) {
        if (__Porffor_array_hasIndex(x, i)) out[len] = x[i];
        len++;
      }
    } else {
      out[len++] = x;
    }
  }

  out.length = len;
  return out;
};

// @porf-typed-array
export const __Array_prototype_reverse = function (this: any[]) {
  const len: i32 = this.length;

  let start: i32 = 0;
  let end: i32 = len;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;

  while (start < end) {
    end--;
    if (start >= end) break;
    if (isArray) {
      const startHas: boolean = __Porffor_array_has(this, start);
      const endHas: boolean = __Porffor_array_has(this, end);
      if (startHas) {
        const tmp: any = this[start];
        if (endHas) this[start] = this[end];
          else __Porffor_array_delete(this, start);
        this[end] = tmp;
      } else if (endHas) {
        this[start] = this[end];
        __Porffor_array_delete(this, end);
      }
    } else {
      const tmp: any = this[start];
      this[start] = this[end];
      this[end] = tmp;
    }
    start++;
  }

  return this;
};


// HasProperty(O, index) for the iteration methods: an array's stored element (the fast case)
// or a typed array's index (every one below its length exists), else the spec's lookup: an
// accessor defined on the index, the prototype chain, an array-like's own keys
export const __Porffor_array_hasIndex = (obj: any, index: i32): boolean => {
  const t: i32 = Porffor.type(obj);
  if (t == Porffor.TYPES.array) {
    if (__Porffor_array_has(obj, index)) return true;
  } else if (Porffor.fastAnd(t >= Porffor.TYPES.uint8clampedarray, t <= Porffor.TYPES.float64array)) return true;
  return __Porffor_object_in(obj, index);
};

// @porf-typed-array
export const __Array_prototype_forEach = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let i: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    callbackFn.call(thisArg, this[i], i++, this);
  }
};

// @porf-typed-array
export const __Array_prototype_filter = function (this: any[], callbackFn: any, thisArg: any) {
  // a subclass's species, or a constructor of its own, can be in a program that names them
  if (Porffor.type(this) == Porffor.TYPES.array) {
    if (Porffor.comptime.flag`member.species`) return __Porffor_arrayGeneric_filter(this, callbackFn, thisArg);
    if (Porffor.comptime.flag`member.constructor`) return __Porffor_arrayGeneric_filter(this, callbackFn, thisArg);
  }
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  if (len == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  const out: any[] = Porffor.array.new(4);
  let i: i32 = 0;
  let j: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    const el: any = this[i];
    if (!!callbackFn.call(thisArg, el, i++, this)) out[j++] = el;
  }

  out.length = j;
  return out;
};

// @porf-typed-array
export const __Array_prototype_map = function (this: any[], callbackFn: any, thisArg: any) {
  // a subclass's species, or a constructor of its own, can be in a program that names them
  if (Porffor.type(this) == Porffor.TYPES.array) {
    if (Porffor.comptime.flag`member.species`) return __Porffor_arrayGeneric_map(this, callbackFn, thisArg);
    if (Porffor.comptime.flag`member.constructor`) return __Porffor_arrayGeneric_map(this, callbackFn, thisArg);
  }
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  if (len == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  const out: any[] = Porffor.array.new(4);
  out.length = len;

  let i: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    out[i] = callbackFn.call(thisArg, this[i], i++, this);
  }

  return out;
};

export const __Array_prototype_flatMap = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  if (len == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  const out: any[] = Porffor.array.new(4);

  let i: i32 = 0, j: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    let x: any = callbackFn.call(thisArg, this[i], i++, this);
    if (Porffor.type(x) == Porffor.TYPES.array) {
      for (const y of x) out[j++] = y;
    } else out[j++] = x;
  }

  out.length = j;
  return out;
};

// @porf-typed-array
export const __Array_prototype_find = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let i: i32 = 0;
  while (i < len) {
    const el: any = this[i];
    if (!!callbackFn.call(thisArg, el, i++, this)) return el;
  }
};

// @porf-typed-array
export const __Array_prototype_findLast = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  let i: i32 = this.length;
  while (i > 0) {
    const el: any = this[--i];
    if (!!callbackFn.call(thisArg, el, i, this)) return el;
  }
};

// @porf-typed-array
export const __Array_prototype_findIndex = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let i: i32 = 0;
  while (i < len) {
    if (!!callbackFn.call(thisArg, this[i], i, this)) return i;
    i++;
  }
  return -1;
};

// @porf-typed-array
export const __Array_prototype_findLastIndex = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  let i: i32 = this.length;
  while (i > 0) {
    if (!!callbackFn.call(thisArg, this[--i], i, this)) return i;
  }
  return -1;
};

// @porf-typed-array
export const __Array_prototype_every = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let i: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    if (!!callbackFn.call(thisArg, this[i], i++, this)) {}
      else return false;
  }

  return true;
};

// @porf-typed-array
export const __Array_prototype_some = function (this: any[], callbackFn: any, thisArg: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let i: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    if (!!callbackFn.call(thisArg, this[i], i++, this)) return true;
  }

  return false;
};

// @porf-typed-array
export const __Array_prototype_reduce = function (this: any[], callbackFn: any, initialValue: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let acc: any = initialValue;
  let i: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  if (acc === undefined) {
    while (Porffor.fastAnd(i < len, !__Porffor_array_hasIndex(this, i))) i++;
    if (i == len) throw new TypeError('Reduce of empty array with no initial value');
    acc = this[i++];
  }

  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    acc = callbackFn(acc, this[i], i++, this);
  }

  return acc;
};

// @porf-typed-array
export const __Array_prototype_reduceRight = function (this: any[], callbackFn: any, initialValue: any) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  const len: i32 = this.length;
  let acc: any = initialValue;
  let i: i32 = len;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  if (acc === undefined) {
    while (Porffor.fastAnd(i > 0, !__Porffor_array_hasIndex(this, i - 1))) i--;
    if (i == 0) throw new TypeError('Reduce of empty array with no initial value');
    acc = this[--i];
  }

  while (i > 0) {
    if (!__Porffor_array_hasIndex(this, i - 1)) {
      i--;
      continue;
    }
    acc = callbackFn(acc, this[--i], i, this);
  }

  return acc;
};

// a < b for strings
export const __Porffor_strlt = (a: string|bytestring, b: string|bytestring) => {
  const aLen: i32 = a.length;
  const bLen: i32 = b.length;
  const len: i32 = aLen < bLen ? aLen : bLen;
  for (let i: i32 = 0; i < len; i++) {
    const ac: i32 = a.charCodeAt(i);
    const bc: i32 = b.charCodeAt(i);

    if (ac < bc) return true;
    if (ac > bc) return false;
  }

  return aLen < bLen;
};

// SortCompare(x, y) > 0, x sorting after y. mode 0 calls the comparefn; mode 1 compares the
// elements' string keys kx and ky (an Array's default); mode 2 orders numbers, -0 before +0
// and NaN last (a typed array's default)
export const __Porffor_array_sortAfter = (x: any, y: any, kx: any, ky: any, mode: i32, comparefn: any): boolean => {
  if (mode == 1) {
    return __Porffor_string_order(Porffor.IR.ptr(kx), __Porffor_string_wide(kx), Porffor.IR.ptr(ky), __Porffor_string_wide(ky)) > 0;
  }
  if (mode == 2) {
    if (x != x) return y == y;
    if (y != y) return false;
    if (x > y) return true;
    if (x < y) return false;
    // +0 after -0
    if (Porffor.fastAnd(Porffor.type(x) == Porffor.TYPES.number, x == 0)) return 1 / x > 0 && 1 / y < 0;
    return false;
  }
  const v: number = comparefn(x, y);
  return v > 0;
};

// a stable merge sort of n elements with their keys (moved alongside; the elements again when
// there are none): runs of 8 by insertion, then merged pairwise through a second buffer
export const __Porffor_array_mergeSort = (vals: any[], keys: any[], n: i32, mode: i32, comparefn: any): void => {
  for (let lo: i32 = 0; lo < n; lo += 8) {
    const hi: i32 = lo + 8 < n ? lo + 8 : n;
    for (let i: i32 = lo + 1; i < hi; i++) {
      const x: any = vals[i];
      const kx: any = keys[i];
      let j: i32 = i;
      while (j > lo && __Porffor_array_sortAfter(vals[j - 1], x, keys[j - 1], kx, mode, comparefn)) {
        vals[j] = vals[j - 1];
        keys[j] = keys[j - 1];
        j--;
      }
      vals[j] = x;
      keys[j] = kx;
    }
  }
  if (n <= 8) return;

  let a: any[] = vals, ka: any[] = keys;
  let b: any[] = Porffor.array.new(n), kb: any[] = Porffor.array.new(n);
  b.length = n;
  kb.length = n;
  for (let width: i32 = 8; width < n; width *= 2) {
    for (let lo: i32 = 0; lo < n; lo += width * 2) {
      const mid: i32 = lo + width < n ? lo + width : n;
      const hi: i32 = lo + width * 2 < n ? lo + width * 2 : n;
      let i: i32 = lo, j: i32 = mid, k: i32 = lo;
      while (i < mid && j < hi) {
        if (__Porffor_array_sortAfter(a[i], a[j], ka[i], ka[j], mode, comparefn)) {
          b[k] = a[j];
          kb[k++] = ka[j++];
        } else {
          b[k] = a[i];
          kb[k++] = ka[i++];
        }
      }
      while (i < mid) {
        b[k] = a[i];
        kb[k++] = ka[i++];
      }
      while (j < hi) {
        b[k] = a[j];
        kb[k++] = ka[j++];
      }
    }
    const t: any[] = a, kt: any[] = ka;
    a = b;
    ka = kb;
    b = t;
    kb = kt;
  }
  if (a !== vals) {
    for (let i: i32 = 0; i < n; i++) vals[i] = a[i];
  }
};

// @porf-typed-array
export const __Array_prototype_sort = function (this: any[], callbackFn: any) {
  // 23.1.3.30 SortIndexedProperties: the present elements, undefined left out and put last,
  // sorted (stable), written back; holes end up at the end
  let mode: i32 = 0;
  if (Porffor.type(callbackFn) == Porffor.TYPES.undefined) {
    mode = Porffor.type(this) == Porffor.TYPES.array ? 1 : 2;
  } else if (Porffor.type(callbackFn) != Porffor.TYPES.function) {
    throw new TypeError('Callback must be a function');
  }

  const len: i32 = this.length;
  const plain: boolean = Porffor.type(this) == Porffor.TYPES.array;
  const vals: any[] = Porffor.array.new(len);
  const keys: any[] = Porffor.array.new(len);
  let n: i32 = 0;
  let undefs: i32 = 0;
  for (let i: i32 = 0; i < len; i++) {
    if (plain && !__Porffor_array_has(this, i)) continue;
    const x: any = this[i];
    if (Porffor.type(x) == Porffor.TYPES.undefined) {
      undefs++;
      continue;
    }
    Porffor.array.fastPush(vals, x);
    // an Array's default order compares ToString of each element, taken once
    n = Porffor.array.fastPush(keys, mode == 1 ? ecma262.ToString(x) : x);
  }
  __Porffor_array_mergeSort(vals, keys, n, mode, callbackFn);

  let i: i32 = 0;
  for (; i < n; i++) this[i] = vals[i];
  for (; i < n + undefs; i++) this[i] = undefined;
  if (plain) {
    for (; i < len; i++) __Porffor_array_delete(this, i);
  }
  return this;
};

// @porf-typed-array
export const __Array_prototype_toString = function (this: any[]) {
  // todo: this is bytestring only!

  const len: i32 = this.length;
  if (len == 0) return '';

  const parts: any[] = Porffor.array.new(len);
  const partLens: i32 = Porffor.malloc(len * 4);

  let outLen: i32 = 0;
  if (len > 1) outLen = len - 1;

  let i: i32 = 0;
  while (i < len) {
    const element: any = this[i++];
    let partLen: i32 = 0;
    if (element != 0 || Porffor.fastAnd(
      Porffor.type(element) != Porffor.TYPES.undefined, // undefined
      Porffor.type(element) != Porffor.TYPES.object // null
    )) {
      const part: bytestring = ecma262.ToString(element);
      parts[i - 1] = part;
      partLen = part.length;
      outLen += partLen;
    }

    Porffor.IR.storeI32(partLens + (i - 1) * 4, 0, partLen);
  }

  const out: bytestring = Porffor.malloc(outLen + 6);
  Porffor.IR.storeI32(out, 0, outLen);

  let outPtr: i32 = Porffor.IR.ptr(out);
  i = 0;
  while (i < len) {
    if (i > 0) Porffor.IR.storeU8(outPtr++, 4, 44);

    const part: bytestring = parts[i];
    const partLen: i32 = Porffor.IR.loadI32(partLens + i * 4, 0);
    i++;
    if (partLen != 0) {
      Porffor.IR.copy(outPtr + 4, Porffor.IR.ptr(part) + 4, partLen);
      outPtr += partLen;
    }
  }

  return out;
};

// @porf-typed-array
export const __Array_prototype_toLocaleString = function (this: any[]) { return Porffor.callThis(__Array_prototype_toString, this); };

// @porf-typed-array
export const __Array_prototype_join = function (this: any[], _separator: any) {
  // the length before the separator's conversion (which may change it)
  const len: i32 = this.length;
  let separator: any = ',';
  if (Porffor.type(_separator) != Porffor.TYPES.undefined)
    separator = ecma262.ToString(_separator);

  if (len == 0) return '';

  const separatorLen: i32 = separator.length;
  let outLen: i32 = len > 1 ? separatorLen * (len - 1) : 0;
  let bytesOnly: boolean = Porffor.type(separator) == Porffor.TYPES.bytestring;
  const parts: any[] = Porffor.array.new(len);
  const partLens: i32 = Porffor.malloc(len * 4);

  let i: i32 = 0;
  while (i < len) {
    const element: any = this[i++];
    const elementType: i32 = Porffor.type(element);
    let partLen: i32 = 0;
    if (Porffor.fastAnd(elementType != Porffor.TYPES.undefined, Porffor.fastOr(
      elementType != Porffor.TYPES.object,
      Porffor.IR.ptr(element) != 0
    ))) {
      const part: any = ecma262.ToString(element);
      parts[i - 1] = part;
      partLen = part.length;
      outLen += partLen;
      if (Porffor.type(part) != Porffor.TYPES.bytestring) bytesOnly = false;
    }

    Porffor.IR.storeI32(partLens + (i - 1) * 4, 0, partLen);
  }

  if (bytesOnly) {
    const out: bytestring = Porffor.malloc(outLen + 6);
    Porffor.IR.storeI32(out, 0, outLen);

    let outPtr: i32 = Porffor.IR.ptr(out);
    i = 0;
    while (i < len) {
      if (i > 0) {
        Porffor.IR.copy(outPtr + 4, Porffor.IR.ptr(separator) + 4, separatorLen);
        outPtr += separatorLen;
      }

      const part: bytestring = parts[i];
      const partLen: i32 = Porffor.IR.loadI32(partLens + i * 4, 0);
      i++;
      if (partLen != 0) {
        Porffor.IR.copy(outPtr + 4, Porffor.IR.ptr(part) + 4, partLen);
        outPtr += partLen;
      }
    }

    return out;
  }

  const out: string = Porffor.malloc(outLen * 2 + 6);
  Porffor.IR.storeI32(out, 0, outLen);

  let outPtr: i32 = Porffor.IR.ptr(out);
  i = 0;
  while (i < len) {
    if (i > 0) {
      if (Porffor.type(separator) == Porffor.TYPES.bytestring) {
        for (let j: i32 = 0; j < separatorLen; j++)
          Porffor.IR.storeU16(outPtr + j * 2, 4, Porffor.IR.loadU8(Porffor.IR.ptr(separator) + j, 4));
      } else {
        Porffor.IR.copy(outPtr + 4, Porffor.IR.ptr(separator) + 4, separatorLen * 2);
      }
      outPtr += separatorLen * 2;
    }

    const part: any = parts[i];
    const partLen: i32 = Porffor.IR.loadI32(partLens + i * 4, 0);
    i++;
    if (partLen != 0) {
      if (Porffor.type(part) == Porffor.TYPES.bytestring) {
        for (let j: i32 = 0; j < partLen; j++)
          Porffor.IR.storeU16(outPtr + j * 2, 4, Porffor.IR.loadU8(Porffor.IR.ptr(part) + j, 4));
      } else {
        Porffor.IR.copy(outPtr + 4, Porffor.IR.ptr(part) + 4, partLen * 2);
      }
      outPtr += partLen * 2;
    }
  }

  return out;
};

// @porf-typed-array
export const __Array_prototype_valueOf = function (this: any[]) {
  return this;
};

// @porf-typed-array
export const __Array_prototype_toReversed = function (this: any[]) {
  const len: i32 = this.length;
  if (len == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  let start: i32 = 0;
  let end: i32 = len - 1;

  const out: any[] = Porffor.array.new(4);
  out.length = len;

  while (true) {
    out[start] = this[end];
    if (start >= end) {
      break;
    }
    out[end--] = this[start++];
  }

  return out;
};

// @porf-typed-array
export const __Array_prototype_toSorted = function (this: any[], callbackFn: any) {
  // todo/perf: could be rewritten to be its own instead of cloning and using normal sort()
  if (Porffor.type(callbackFn) != Porffor.TYPES.undefined) {
    if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('Callback must be a function');
  }

  const len: i32 = this.length;
  if (len == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  const out: any[] = Porffor.array.new(len);
  out.length = len;
  for (let i: i32 = 0; i < len; i++) out[i] = this[i];

  return Porffor.callThis(__Array_prototype_sort, out, callbackFn);
};

export const __Array_prototype_toSpliced = function (this: any[], _start: any, _deleteCount: any, ...items: any[]) {
  const len: i32 = this.length;

  let start: i32 = ecma262.ToIntegerOrInfinity(_start);
  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }
  if (start > len) start = len;

  if (Porffor.type(_deleteCount) == Porffor.TYPES.undefined) _deleteCount = len - start;
  let deleteCount: i32 = ecma262.ToIntegerOrInfinity(_deleteCount);

  if (deleteCount < 0) deleteCount = 0;
  if (deleteCount > len - start) deleteCount = len - start;

  const itemsLen: i32 = items.length;
  const outLen: i32 = len - deleteCount + itemsLen;
  const out: any[] = Porffor.array.new(outLen);
  out.length = outLen;

  let i: i32 = 0;
  while (i < start) {
    out[i] = this[i];
    i++;
  }

  let j: i32 = 0;
  while (j < itemsLen) {
    out[start + j] = items[j];
    j++;
  }

  i = start + deleteCount;
  j = start + itemsLen;
  while (i < len) out[j++] = this[i++];

  return out;
};


export const __Array_prototype_flat = function (this: any[], _depth: any) {
  if (Porffor.type(_depth) == Porffor.TYPES.undefined) _depth = 1;
  let depth: i32 = ecma262.ToIntegerOrInfinity(_depth);

  if (this.length == 0) {
    const out: any[] = Porffor.array.new(6);
    return out;
  }

  const len: i32 = this.length;
  const out: any[] = Porffor.array.new(len);
  if (depth <= 0) {
    out.length = len;
    const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
    for (let i: i32 = 0; i < len; i++) {
      if (__Porffor_array_hasIndex(this, i)) out[i] = this[i];
    }
    return out;
  }

  let i: i32 = 0, j: i32 = 0;
  const isArray: boolean = Porffor.type(this) == Porffor.TYPES.array;
  while (i < len) {
    if (!__Porffor_array_hasIndex(this, i)) {
      i++;
      continue;
    }
    let x: any = this[i++];
    if (Porffor.type(x) == Porffor.TYPES.array) {
      if (depth > 1) x = Porffor.callThis(__Array_prototype_flat, x, depth - 1);
      for (const y of x) out[j++] = y;
    } else out[j++] = x;
  }

  out.length = j;

  return out;
};


export const __Porffor_array_fastPush = (arr: any[], el: any): i32 => {
  let len: i32 = arr.length;
  arr[len] = el;
  arr.length = ++len;
  return len;
};

// keys/values/entries: array snapshots, the convention Map and Set follow here (not
// lazy iterators, so spread, for-of and Array.from work but .next() does not). Holes
// are indices and read as undefined, as the spec's array iterator would give them.
export const __Porffor_array_keysArray = function (this: any[]) {
  const len: i32 = this.length;
  const out: any[] = Porffor.array.new(len);
  for (let i: i32 = 0; i < len; i++) Porffor.array.fastPush(out, i);
  return out;
};

export const __Porffor_array_valuesArray = function (this: any[]) {
  const len: i32 = this.length;
  const out: any[] = Porffor.array.new(len);
  for (let i: i32 = 0; i < len; i++) Porffor.array.fastPush(out, this[i]);
  return out;
};

export const __Porffor_array_entriesArray = function (this: any[]) {
  const len: i32 = this.length;
  const out: any[] = Porffor.array.new(len);
  for (let i: i32 = 0; i < len; i++) {
    const entry: any[] = Porffor.array.new(2);
    Porffor.array.fastPush(entry, i);
    Porffor.array.fastPush(entry, this[i]);
    Porffor.array.fastPush(out, entry);
  }
  return out;
};

// keys/values/entries/[Symbol.iterator]: iterators (iterator.ts) over the array, read as
// they go (the *Array functions above are the snapshots the builtins use internally)
export const __Array_prototype_keys = function (this: any[]) {
  return __Porffor_iter_newKeys(this);
};

export const __Array_prototype_values = function (this: any[]) {
  return __Porffor_iter_newValues(this);
};

export const __Array_prototype_entries = function (this: any[]) {
  return __Porffor_iter_newEntries(this);
};
