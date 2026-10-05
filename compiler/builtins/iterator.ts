import type {} from './porffor.d.ts';

// The iterator protocol (https://tc39.es/ecma262/#sec-iteration), for what Porffor has no
// fast path for: for...of / for await...of (codegen generateForOf), spread, destructuring
// and Array.from over any object with a [Symbol.iterator] (or [Symbol.asyncIterator]).
// An iterator record is an object { it, next, done, sync }: the iterator, its next method,
// whether it is finished (exhausted or closed), and, for await, whether it is a sync
// iterator standing in for an async one (its values are then awaited).

// Porffor's own generator objects (what a generator function returns, e.g. a
// [Symbol.iterator]() { yield … }) have no next property to read: their methods are
// dispatched by type, so the protocol calls them by name.
export const __Porffor_iter_isGenerator = (it: any): boolean => {
  return Porffor.fastOr(
    Porffor.type(it) == Porffor.TYPES.__porffor_generator,
    Porffor.type(it) == Porffor.TYPES.__porffor_asyncgenerator
  );
};

// GetIterator(obj, sync)
export const __Porffor_iter_open = (obj: any): object => {
  if (obj == null) throw new TypeError('Cannot iterate over undefined or null');
  // a generator is its own iterator
  if (Porffor.comptime.flag`hasType.__porffor_generator`) {
    if (Porffor.type(obj) == Porffor.TYPES.__porffor_generator) return __Porffor_iter_generatorRecord(obj);
  }
  const method: any = obj[Symbol.iterator];
  if (typeof method !== 'function') throw new TypeError('Object is not iterable');
  const it: any = Porffor.callThis(method, obj);
  if (!Porffor.object.isObject(it)) throw new TypeError('Result of the Symbol.iterator method is not an object');

  const rec: object = {};
  rec.it = it;
  rec.next = __Porffor_iter_isGenerator(it) ? undefined : it.next;
  rec.done = false;
  rec.sync = false;
  // a built-in iterator (iterator.ts' own) is stepped directly: no next call, no result object
  rec.builtin = it.__kind !== undefined;
  return rec;
};

// GetIterator(obj, async): [Symbol.asyncIterator], else [Symbol.iterator] with its values awaited
export const __Porffor_iter_openAsync = (obj: any): object => {
  if (obj == null) throw new TypeError('Cannot iterate over undefined or null');
  // an async generator is its own async iterator
  if (Porffor.comptime.flag`hasType.__porffor_asyncgenerator`) {
    if (Porffor.type(obj) == Porffor.TYPES.__porffor_asyncgenerator) return __Porffor_iter_generatorRecord(obj);
  }
  const method: any = obj[Symbol.asyncIterator];
  if (method == null) {
    const rec: object = __Porffor_iter_open(obj);
    rec.sync = true;
    return rec;
  }
  if (typeof method !== 'function') throw new TypeError('Object is not async iterable');
  const it: any = Porffor.callThis(method, obj);
  if (!Porffor.object.isObject(it)) throw new TypeError('Result of the Symbol.asyncIterator method is not an object');

  const rec: object = {};
  rec.it = it;
  rec.next = __Porffor_iter_isGenerator(it) ? undefined : it.next;
  rec.done = false;
  rec.sync = false;
  return rec;
};

// the loop record of a generator for...of steps on its fast path: only for the loop's try
// to close it when the loop is left early (__Porffor_iter_close / closeAsync)
export const __Porffor_iter_generatorRecord = (it: any): object => {
  const rec: object = {};
  rec.it = it;
  rec.next = undefined;
  rec.done = false;
  rec.sync = false;
  return rec;
};

// IteratorStep + IteratorValue: the next value, or undefined with rec.done set at the end
export const __Porffor_iter_step = (rec: any): any => {
  const it: any = rec.it;
  if (rec.builtin) {
    const value: any = __Porffor_iter_builtinStep(it);
    if (it.__done) rec.done = true;
    return value;
  }
  let result: any = undefined;
  // generators only in a program that has them (their runtime is left out otherwise)
  if (Porffor.comptime.flag`hasType.__porffor_generator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_generator) result = Porffor.callThis(__Porffor_Generator_prototype_next, it);
  }
  if (result === undefined) {
    // a function value in a local: Porffor.callThis(rec.next, …) would dispatch a built-in `next`
    const next: any = rec.next;
    result = Porffor.callThis(next, it);
  }
  if (!Porffor.object.isObject(result)) throw new TypeError('Iterator result is not an object');
  if (result.done) {
    rec.done = true;
    return undefined;
  }
  return result.value;
};

// the same for for await...of: the next result awaited (and, from a sync iterator, its value)
export const __Porffor_iter_stepAsync = async (rec: any): any => {
  const it: any = rec.it;
  let result: any = undefined;
  if (Porffor.comptime.flag`hasType.__porffor_asyncgenerator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_asyncgenerator) result = await Porffor.callThis(__Porffor_AsyncGenerator_prototype_next, it);
  }
  if (Porffor.comptime.flag`hasType.__porffor_generator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_generator) result = Porffor.callThis(__Porffor_Generator_prototype_next, it);
  }
  if (result === undefined) {
    const next: any = rec.next;
    result = await Porffor.callThis(next, it);
  }
  if (!Porffor.object.isObject(result)) throw new TypeError('Iterator result is not an object');
  if (result.done) {
    rec.done = true;
    return undefined;
  }
  if (rec.sync) return await result.value;
  return result.value;
};

export const __Porffor_iter_isDone = (rec: any): boolean => {
  return rec.done;
};

// IteratorClose: a loop left before the end calls the iterator's return (a record never
// opened, finished or already closed is left alone)
export const __Porffor_iter_close = (rec: any): void => {
  if (rec === undefined) return;
  if (rec.done) return;
  rec.done = true;
  const it: any = rec.it;
  if (rec.builtin) {
    it.__done = true;
    if (it.__under !== undefined) __Porffor_iter_close(it.__under);
    if (Porffor.comptime.flag`hasFunc.__Iterator_zip`) __Porffor_iter_zipClose(it);
    if (Porffor.comptime.flag`hasFunc.__Iterator_zipKeyed`) __Porffor_iter_zipClose(it);
    return;
  }
  if (Porffor.comptime.flag`hasType.__porffor_generator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_generator) {
      Porffor.coroutine.resume(it, undefined, 2 as i32);
      return;
    }
  }
  if (Porffor.comptime.flag`hasType.__porffor_asyncgenerator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_asyncgenerator) {
      // through its driver (its finally blocks may await), not waited for here
      __Porffor_AsyncGenerator_advance(it, undefined, 2 as i32);
      return;
    }
  }
  const ret: any = rec.it.return;
  if (ret == null) return;
  const result: any = Porffor.callThis(ret, rec.it);
  if (!Porffor.object.isObject(result)) throw new TypeError('Iterator return result is not an object');
};

// yield*'s step of the iterator it delegates to: what the generator was resumed with passed
// on, mode 0 next(value), 1 throw(value), 2 return(value). The inner result { value, done }:
// with no throw method the iterator is closed and yield* throws; with no return method, the
// return completes at once
export const __Porffor_iter_delegate = (rec: any, value: any, mode: i32): object => {
  const it: any = rec.it;
  let result: any = undefined;
  if (rec.builtin) {
    if (mode == 0) {
      result = {};
      result.value = __Porffor_iter_builtinStep(it);
      result.done = it.__done;
      return result;
    }
  } else if (Porffor.comptime.flag`hasType.__porffor_generator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_generator) return __Porffor_Generator_step(it, value, mode);
  }

  if (mode == 0) {
    const next: any = rec.next;
    result = Porffor.callThis(next, it, value);
  } else if (mode == 1) {
    const throwMethod: any = rec.builtin ? undefined : it.throw;
    if (throwMethod == null) {
      __Porffor_iter_close(rec);
      throw new TypeError('The iterator does not provide a throw method');
    }
    result = Porffor.callThis(throwMethod, it, value);
  } else {
    const returnMethod: any = rec.builtin ? undefined : it.return;
    if (returnMethod == null) {
      if (rec.builtin) it.__done = true;
      result = {};
      result.value = value;
      result.done = true;
      return result;
    }
    result = Porffor.callThis(returnMethod, it, value);
  }
  if (!Porffor.object.isObject(result)) throw new TypeError('Iterator result is not an object');
  return result;
};

// the same for yield* in an async generator, awaited: the inner result, and from a sync
// iterator its value too (AsyncFromSyncIterator)
export const __Porffor_iter_delegateAsync = async (rec: any, value: any, mode: i32): object => {
  const it: any = rec.it;
  let result: any = undefined;
  if (Porffor.comptime.flag`hasType.__porffor_asyncgenerator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_asyncgenerator) return await __Porffor_AsyncGenerator_step(it, value, mode);
  }
  if (rec.sync) {
    const step: any = __Porffor_iter_delegate(rec, value, mode);
    result = {};
    result.value = await step.value;
    result.done = step.done;
    return result;
  }

  if (mode == 0) {
    const next: any = rec.next;
    result = await Porffor.callThis(next, it, value);
  } else if (mode == 1) {
    const throwMethod: any = it.throw;
    if (throwMethod == null) {
      await __Porffor_iter_closeAsync(rec);
      throw new TypeError('The iterator does not provide a throw method');
    }
    result = await Porffor.callThis(throwMethod, it, value);
  } else {
    const returnMethod: any = it.return;
    if (returnMethod == null) {
      result = {};
      result.value = await value;
      result.done = true;
      return result;
    }
    result = await Porffor.callThis(returnMethod, it, value);
  }
  if (!Porffor.object.isObject(result)) throw new TypeError('Iterator result is not an object');
  return result;
};

export const __Porffor_iter_closeAsync = async (rec: any): void => {
  if (rec === undefined) return;
  if (rec.done) return;
  rec.done = true;
  const it: any = rec.it;
  if (Porffor.comptime.flag`hasType.__porffor_generator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_generator) {
      Porffor.coroutine.resume(it, undefined, 2 as i32);
      return;
    }
  }
  if (Porffor.comptime.flag`hasType.__porffor_asyncgenerator`) {
    if (Porffor.type(it) == Porffor.TYPES.__porffor_asyncgenerator) {
      // through its driver: its finally blocks may await
      await __Porffor_AsyncGenerator_advance(it, undefined, 2 as i32);
      return;
    }
  }
  const ret: any = rec.it.return;
  if (ret == null) return;
  const result: any = await Porffor.callThis(ret, rec.it);
  if (!Porffor.object.isObject(result)) throw new TypeError('Iterator return result is not an object');
};

// Array destructuring's source: an array as is; anything else as an array of the first
// `count` values (all of them with a rest element), its iterator closed if not finished
export const __Porffor_iter_destructure = (value: any, count: i32, rest: boolean): any => {
  const t: i32 = Porffor.type(value);
  if (t == Porffor.TYPES.array) return value;
  if (Porffor.fastAnd(t >= Porffor.TYPES.uint8clampedarray, t <= Porffor.TYPES.float64array)) return value;

  const out: any[] = Porffor.array.new(4);
  // a generator runs only as far as the pattern reads, then is closed (an empty pattern
  // never starts it)
  if (Porffor.comptime.flag`hasType.__porffor_generator`) if (t == Porffor.TYPES.__porffor_generator) {
    let n: i32 = 0;
    let finished: boolean = false;
    while (rest || n < count) {
      if (Porffor.coroutine.resume(value, undefined, 0 as i32)) {
        finished = true;
        break;
      }
      Porffor.array.fastPush(out, Porffor.coroutine.value(value));
      n++;
    }
    if (!finished) Porffor.coroutine.resume(value, undefined, 2 as i32);
    return out;
  }

  if (Porffor.fastOr(
    (t | 0b10000000) == Porffor.TYPES.bytestring,
    t == Porffor.TYPES.set,
    t == Porffor.TYPES.map
  )) {
    __Porffor_array_spread(out, value);
    return out;
  }

  let n: i32 = 0;
  if (Porffor.comptime.flag`program.usesIterProtocol`) {
    const rec: any = __Porffor_iter_open(value);
    while (rest || n < count) {
      const v: any = __Porffor_iter_step(rec);
      if (rec.done) break;
      Porffor.array.fastPush(out, v);
      n++;
    }
    __Porffor_iter_close(rec);
  } else {
    // a program that cannot make its own iterators: a built-in iterator object, or nothing
    // (checked first: even an empty pattern needs an iterable)
    let isIterator: boolean = false;
    if (Porffor.object.isObject(value)) isIterator = value.__kind !== undefined;
    if (!isIterator) throw new TypeError('Object is not iterable');
    while (rest || n < count) {
      const v: any = __Porffor_iter_stepBuiltinOnly(value);
      if (value.__done) break;
      Porffor.array.fastPush(out, v);
      n++;
    }
  }
  return out;
};

// the character (one code point: one or two UTF-16 units) at unit index i, for iterating
// a string by code points
export const __Porffor_string_iterAt = (str: string, i: i32): string => {
  const hi: i32 = str.charCodeAt(i);
  if (Porffor.fastAnd(hi >= 0xd800, hi <= 0xdbff, i + 1 < str.length)) {
    const lo: i32 = str.charCodeAt(i + 1);
    if (Porffor.fastAnd(lo >= 0xdc00, lo <= 0xdfff)) return str.slice(i, i + 2);
  }
  return str.slice(i, i + 1);
};

// ---- the built-in iterators (Array / Map / Set / string / typed array iterators, the
// iterator helpers, Iterator.from) ----
// An iterator is an object { __kind, __src, __i, … } whose prototype holds next,
// [Symbol.iterator] and the helpers (Iterator.prototype's methods). __kind says what it
// walks, one of the ITER_* kinds below. The helper kinds (and ITER_WRAP) step another
// iterator, held as an iterator record in __under, with __fn and a count __n.

// over an array-like (an array, a typed array, a Map or Set snapshot) in __src:
const ITER_VALUES: i32 = 0; // its values
const ITER_KEYS: i32 = 1; // its indices
const ITER_ENTRIES: i32 = 2; // [index, value] pairs
const ITER_STRING: i32 = 3; // a string in __src, by code point
const ITER_WRAP: i32 = 4; // Iterator.from: an iterator we did not make, given the helpers
const ITER_MAP: i32 = 5;
const ITER_FILTER: i32 = 6;
const ITER_TAKE: i32 = 7;
const ITER_DROP: i32 = 8;
const ITER_FLATMAP: i32 = 9;
const ITER_ZIP: i32 = 10; // Iterator.zip / zipKeyed: records in __recs (__iters: null once one is padded)

// Iterator.zip's modes
const ZIP_SHORTEST: i32 = 0;
const ZIP_LONGEST: i32 = 1;
const ZIP_STRICT: i32 = 2;

let __Porffor_iter_protoObj: any = undefined;
let __Porffor_iter_helperProtoObj: any = undefined;

// the helpers' and Iterator.from's prototype: the base one plus return (array, Map, Set
// and string iterators have no return, as the standard's)
export const __Porffor_iter_helperProto = (): object => {
  if (__Porffor_iter_helperProtoObj !== undefined) return __Porffor_iter_helperProtoObj;
  const p: object = {};
  p.return = function (this: any, value: any): object {
    if (!this.__done) {
      this.__done = true;
      if (this.__under !== undefined) __Porffor_iter_close(this.__under);
      if (Porffor.comptime.flag`hasFunc.__Iterator_zip`) __Porffor_iter_zipClose(this);
      if (Porffor.comptime.flag`hasFunc.__Iterator_zipKeyed`) __Porffor_iter_zipClose(this);
    }
    const result: object = {};
    result.value = value;
    result.done = true;
    return result;
  };
  __Object_setPrototypeOf(p, __Porffor_iter_proto());
  __Porffor_iter_helperProtoObj = p;
  return p;
};

export const __Porffor_iter_new = (src: any, kind: i32): object => {
  const it: object = {};
  it.__kind = kind;
  it.__src = src;
  it.__i = 0;
  it.__done = false;
  __Object_setPrototypeOf(it, kind >= ITER_WRAP ? __Porffor_iter_helperProto() : __Porffor_iter_proto());
  return it;
};

// one step of a built-in iterator: the value, or undefined with it.__done set
export const __Porffor_iter_builtinStep = (it: any): any => {
  if (it.__done) return undefined;
  const kind: i32 = it.__kind;
  if (kind <= ITER_ENTRIES) {
    const src: any = it.__src;
    const i: i32 = it.__i;
    if (i >= src.length) {
      it.__done = true;
      return undefined;
    }
    it.__i = i + 1;
    if (kind == ITER_VALUES) return src[i];
    if (kind == ITER_KEYS) return i;
    const pair: any[] = Porffor.array.new(2);
    Porffor.array.fastPush(pair, i);
    Porffor.array.fastPush(pair, src[i]);
    return pair;
  }
  if (kind == ITER_STRING) {
    const str: any = it.__src;
    const i: i32 = it.__i;
    if (i >= str.length) {
      it.__done = true;
      return undefined;
    }
    const ch: any = __Porffor_string_iterAt(str, i);
    it.__i = i + ch.length;
    return ch;
  }
  if (Porffor.comptime.flag`program.usesIterProtocol`) if (kind == ITER_WRAP) {
    const v: any = __Porffor_iter_step(it.__under);
    if (it.__under.done) it.__done = true;
    return v;
  }
  return __Porffor_iter_runHelper(it, kind);
};

// an iterator helper runs as a generator does: a step taken while its own step runs (its
// function calling next) is a TypeError, and a step that throws completes it (done after)
export const __Porffor_iter_runHelper = (it: any, kind: i32): any => {
  if (it.__running) throw new TypeError('Iterator helper is already running');
  it.__running = true;
  let v: any = undefined;
  let completed: boolean = false;
  try {
    v = __Porffor_iter_helperStep(it, kind);
    completed = true;
  } finally {
    it.__running = false;
    if (!completed) it.__done = true;
  }
  return v;
};

// one step of a helper (map, filter, take, drop, flatMap, zip)
export const __Porffor_iter_helperStep = (it: any, kind: i32): any => {
  if (Porffor.comptime.flag`member.map`) if (kind == ITER_MAP) {
    const v: any = __Porffor_iter_step(it.__under);
    if (it.__under.done) {
      it.__done = true;
      return undefined;
    }
    const fn: any = it.__fn;
    return fn(v, it.__n++);
  }
  if (Porffor.comptime.flag`member.filter`) if (kind == ITER_FILTER) {
    const fn: any = it.__fn;
    while (true) {
      const v: any = __Porffor_iter_step(it.__under);
      if (it.__under.done) {
        it.__done = true;
        return undefined;
      }
      if (fn(v, it.__n++)) return v;
    }
  }
  if (Porffor.comptime.flag`member.take`) if (kind == ITER_TAKE) {
    if (it.__n >= it.__limit) {
      it.__done = true;
      __Porffor_iter_close(it.__under);
      return undefined;
    }
    it.__n++;
    const v: any = __Porffor_iter_step(it.__under);
    if (it.__under.done) it.__done = true;
    return v;
  }
  if (Porffor.comptime.flag`member.drop`) if (kind == ITER_DROP) {
    while (it.__n < it.__limit) {
      it.__n++;
      __Porffor_iter_step(it.__under);
      if (it.__under.done) {
        it.__done = true;
        return undefined;
      }
    }
    const v: any = __Porffor_iter_step(it.__under);
    if (it.__under.done) it.__done = true;
    return v;
  }
  if (Porffor.comptime.flag`hasFunc.__Iterator_zip`) if (kind == ITER_ZIP) return __Porffor_iter_zipStep(it);
  if (Porffor.comptime.flag`hasFunc.__Iterator_zipKeyed`) if (kind == ITER_ZIP) return __Porffor_iter_zipStep(it);

  // ITER_FLATMAP: the inner iterator's values, then the next outer value's
  if (Porffor.comptime.flag`member.flatMap`) while (true) {
    if (it.__inner !== undefined) {
      const v: any = __Porffor_iter_step(it.__inner);
      if (!it.__inner.done) return v;
      it.__inner = undefined;
    }
    const outer: any = __Porffor_iter_step(it.__under);
    if (it.__under.done) {
      it.__done = true;
      return undefined;
    }
    const fn: any = it.__fn;
    const mapped: any = fn(outer, it.__n++);
    if (typeof mapped === 'string' || !Porffor.object.isObject(mapped)) throw new TypeError('Iterator.prototype.flatMap: the mapper must return an iterable');
    it.__inner = __Porffor_iter_open(mapped);
  }
};

// GetIteratorDirect: an iterator record over an iterator object itself (ours, or one with a next method)
export const __Porffor_iter_openDirect = (it: any): object => {
  const rec: object = {};
  rec.it = it;
  rec.next = __Porffor_iter_isGenerator(it) ? undefined : it.next;
  rec.done = false;
  rec.sync = false;
  rec.builtin = Porffor.object.isObject(it) && it.__kind !== undefined;
  return rec;
};

export const __Porffor_iter_newHelper = (self: any, kind: i32, fn: any): object => {
  const it: object = __Porffor_iter_new(undefined, kind);
  it.__under = __Porffor_iter_openDirect(self);
  it.__fn = fn;
  it.__n = 0;
  return it;
};

export const __Porffor_iter_limit = (limit: any, name: any): number => {
  const n: number = Number(limit);
  if (n != n) throw new RangeError('Iterator.prototype.' + name + ': the limit must be a number');
  const whole: number = Math.trunc(n);
  if (whole < 0) throw new RangeError('Iterator.prototype.' + name + ': the limit must not be negative');
  return whole;
};

export const __Porffor_iter_proto = (): object => {
  if (__Porffor_iter_protoObj !== undefined) return __Porffor_iter_protoObj;
  const p: object = {};

  p.next = function (this: any): object {
    const value: any = __Porffor_iter_builtinStep(this);
    const result: object = {};
    result.value = this.__done ? undefined : value;
    result.done = this.__done;
    return result;
  };
  // only a program that names Symbol.iterator can read it
  if (Porffor.comptime.flag`program.usesIterProtocol`) {
    p[Symbol.iterator] = function (this: any): any {
      return this;
    };
  }

  // the helpers are Iterator.prototype's methods (below). Porffor builds prototype objects
  // with only the methods a program names, and a helper reached through this chain is
  // never named, so they are set here too: each only when the program reads a property of
  // its name somewhere. The chain to Iterator.prototype is the spec's.
  if (Porffor.comptime.flag`member.map`) p.map = __Iterator_prototype_map;
  if (Porffor.comptime.flag`member.filter`) p.filter = __Iterator_prototype_filter;
  if (Porffor.comptime.flag`member.take`) p.take = __Iterator_prototype_take;
  if (Porffor.comptime.flag`member.drop`) p.drop = __Iterator_prototype_drop;
  if (Porffor.comptime.flag`member.flatMap`) p.flatMap = __Iterator_prototype_flatMap;
  if (Porffor.comptime.flag`member.toArray`) p.toArray = __Iterator_prototype_toArray;
  if (Porffor.comptime.flag`member.forEach`) p.forEach = __Iterator_prototype_forEach;
  if (Porffor.comptime.flag`member.reduce`) p.reduce = __Iterator_prototype_reduce;
  if (Porffor.comptime.flag`member.some`) p.some = __Iterator_prototype_some;
  if (Porffor.comptime.flag`member.every`) p.every = __Iterator_prototype_every;
  if (Porffor.comptime.flag`member.find`) p.find = __Iterator_prototype_find;
  __Object_setPrototypeOf(p, Iterator.prototype);
  __Porffor_iter_protoObj = p;
  return p;
};

// 27.1.3.1 Iterator (): an abstract class, for subclassing (class It extends Iterator):
// constructed as itself, or called, it throws; super() from a subclass makes nothing (the
// subclass's this is the instance)
export const Iterator = function (): any {
  if (Porffor.fastOr(!new.target, new.target === Iterator)) throw new TypeError('Abstract class Iterator not directly constructable');
};

// ---- Iterator.prototype: the helpers, for every iterator (ours inherit them; native
// generators forward to them from generator.ts) ----

export const __Iterator_prototype_map = function (this: any, fn: any): object {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.map: the mapper is not a function');
  return __Porffor_iter_newHelper(this, ITER_MAP, fn);
};

export const __Iterator_prototype_filter = function (this: any, fn: any): object {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.filter: the predicate is not a function');
  return __Porffor_iter_newHelper(this, ITER_FILTER, fn);
};

export const __Iterator_prototype_take = function (this: any, limit: any): object {
  const it: object = __Porffor_iter_newHelper(this, ITER_TAKE, undefined);
  it.__limit = __Porffor_iter_limit(limit, 'take');
  return it;
};

export const __Iterator_prototype_drop = function (this: any, limit: any): object {
  const it: object = __Porffor_iter_newHelper(this, ITER_DROP, undefined);
  it.__limit = __Porffor_iter_limit(limit, 'drop');
  return it;
};

export const __Iterator_prototype_flatMap = function (this: any, fn: any): object {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.flatMap: the mapper is not a function');
  const it: object = __Porffor_iter_newHelper(this, ITER_FLATMAP, fn);
  it.__inner = undefined;
  return it;
};

export const __Iterator_prototype_toArray = function (this: any): any[] {
  const out: any[] = Porffor.array.new(4);
  const rec: any = __Porffor_iter_openDirect(this);
  while (true) {
    const v: any = __Porffor_iter_step(rec);
    if (rec.done) return out;
    Porffor.array.fastPush(out, v);
  }
};

export const __Iterator_prototype_forEach = function (this: any, fn: any): void {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.forEach: the callback is not a function');
  const rec: any = __Porffor_iter_openDirect(this);
  let n: i32 = 0;
  while (true) {
    const v: any = __Porffor_iter_step(rec);
    if (rec.done) return;
    fn(v, n++);
  }
};

export const __Iterator_prototype_reduce = function (this: any, fn: any, initial: any): any {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.reduce: the reducer is not a function');
  const rec: any = __Porffor_iter_openDirect(this);
  let acc: any = initial;
  let n: i32 = 0;
  // as Array.prototype.reduce here: an undefined initial value counts as none
  if (initial === undefined) {
    acc = __Porffor_iter_step(rec);
    if (rec.done) throw new TypeError('Iterator.prototype.reduce: an empty iterator with no initial value');
    n = 1;
  }
  while (true) {
    const v: any = __Porffor_iter_step(rec);
    if (rec.done) return acc;
    acc = fn(acc, v, n++);
  }
};

export const __Iterator_prototype_some = function (this: any, fn: any): boolean {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.some: the predicate is not a function');
  const rec: any = __Porffor_iter_openDirect(this);
  let n: i32 = 0;
  while (true) {
    const v: any = __Porffor_iter_step(rec);
    if (rec.done) return false;
    if (fn(v, n++)) {
      __Porffor_iter_close(rec);
      return true;
    }
  }
};

export const __Iterator_prototype_every = function (this: any, fn: any): boolean {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.every: the predicate is not a function');
  const rec: any = __Porffor_iter_openDirect(this);
  let n: i32 = 0;
  while (true) {
    const v: any = __Porffor_iter_step(rec);
    if (rec.done) return true;
    if (!fn(v, n++)) {
      __Porffor_iter_close(rec);
      return false;
    }
  }
};

export const __Iterator_prototype_find = function (this: any, fn: any): any {
  if (typeof fn !== 'function') throw new TypeError('Iterator.prototype.find: the predicate is not a function');
  const rec: any = __Porffor_iter_openDirect(this);
  let n: i32 = 0;
  while (true) {
    const v: any = __Porffor_iter_step(rec);
    if (rec.done) return undefined;
    if (fn(v, n++)) {
      __Porffor_iter_close(rec);
      return v;
    }
  }
};


// Iterator.from(obj): an iterator with the helpers, over obj's iterator
export const __Iterator_from = (obj: any): object => {
  if (typeof obj === 'string') return __Porffor_iter_new(obj, ITER_STRING);
  let it: any = obj;
  const method: any = obj == null ? undefined : obj[Symbol.iterator];
  if (typeof method === 'function') it = Porffor.callThis(method, obj);
  if (Porffor.object.isObject(it)) if (it.__kind !== undefined) return it;
  const wrap: object = __Porffor_iter_new(undefined, ITER_WRAP);
  wrap.__under = __Porffor_iter_openDirect(it);
  return wrap;
};

// ---- Iterator.zip / Iterator.zipKeyed (joint iteration) ----

// IteratorCloseAll(records, a throw): each still open closed, last first, their errors ignored
export const __Porffor_iter_closeAllThrow = (recs: any[]): void => {
  for (let i: i32 = recs.length - 1; i >= 0; i--) {
    try {
      __Porffor_iter_close(recs[i]);
    } catch {}
  }
};

// IteratorCloseAll(records, a return): each still open closed, last first; the first error
// is thrown once all are
export const __Porffor_iter_closeAll = (recs: any[]): void => {
  let threw: boolean = false;
  let error: any = undefined;
  for (let i: i32 = recs.length - 1; i >= 0; i--) {
    try {
      __Porffor_iter_close(recs[i]);
    } catch (e) {
      if (!threw) {
        threw = true;
        error = e;
      }
    }
  }
  if (threw) throw error;
};

// a zip's return, or a loop leaving it: what it zips closed
export const __Porffor_iter_zipClose = (it: any): void => {
  if (it.__kind != ITER_ZIP) return;
  __Porffor_iter_closeAll(it.__recs);
};

// GetIteratorFlattenable(value, reject-strings)
export const __Porffor_iter_flattenable = (value: any): object => {
  if (!Porffor.object.isObject(value)) throw new TypeError('Iterator.zip: an iterable is not an object');
  const method: any = value[Symbol.iterator];
  let it: any = value;
  if (method != null) it = Porffor.callThis(method, value);
  if (!Porffor.object.isObject(it)) throw new TypeError('Iterator.zip: an iterator is not an object');
  return __Porffor_iter_openDirect(it);
};

// the options' mode (on the new zip) and, for longest, its padding option
export const __Porffor_iter_zipOptions = (options: any, it: any): any => {
  it.__mode = ZIP_SHORTEST;
  if (options === undefined) return undefined;
  if (!Porffor.object.isObject(options)) throw new TypeError('Iterator.zip: options is not an object');

  const mode: any = options.mode;
  if (Porffor.fastAnd(mode !== undefined, mode !== 'shortest')) {
    if (mode === 'longest') it.__mode = ZIP_LONGEST;
    else if (mode === 'strict') it.__mode = ZIP_STRICT;
    else throw new TypeError('Iterator.zip: mode must be "shortest", "longest" or "strict"');
  }
  if (it.__mode != ZIP_LONGEST) return undefined;

  const padding: any = options.padding;
  if (Porffor.fastAnd(padding !== undefined, !Porffor.object.isObject(padding))) throw new TypeError('Iterator.zip: padding is not an object');
  return padding;
};

export const __Porffor_iter_newZip = (recs: any[], padding: any[], keys: any, it: any): object => {
  it.__recs = recs;
  const iters: any[] = Porffor.array.new(4);
  const len: i32 = recs.length;
  for (let i: i32 = 0; i < len; i++) Porffor.array.fastPush(iters, recs[i]);
  it.__iters = iters;
  it.__padding = padding;
  it.__keys = keys;
  return it;
};

export const __Iterator_zip = (iterables: any, options: any): object => {
  if (!Porffor.object.isObject(iterables)) throw new TypeError('Iterator.zip: iterables is not an object');
  const it: object = __Porffor_iter_new(undefined, ITER_ZIP);
  const paddingOption: any = __Porffor_iter_zipOptions(options, it);

  const recs: any[] = Porffor.array.new(4);
  const input: any = __Porffor_iter_open(iterables);
  while (true) {
    let value: any = undefined;
    try {
      value = __Porffor_iter_step(input);
    } catch (e) {
      __Porffor_iter_closeAllThrow(recs);
      throw e;
    }
    if (input.done) break;

    let rec: any = undefined;
    try {
      rec = __Porffor_iter_flattenable(value);
    } catch (e) {
      __Porffor_iter_closeAllThrow(recs);
      try {
        __Porffor_iter_close(input);
      } catch {}
      throw e;
    }
    Porffor.array.fastPush(recs, rec);
  }

  const count: i32 = recs.length;
  const padding: any[] = Porffor.array.new(4);
  if (it.__mode == ZIP_LONGEST) {
    if (paddingOption === undefined) {
      for (let i: i32 = 0; i < count; i++) Porffor.array.fastPush(padding, undefined);
    } else {
      try {
        const pad: any = __Porffor_iter_open(paddingOption);
        let using: boolean = true;
        for (let i: i32 = 0; i < count; i++) {
          let v: any = undefined;
          if (using) {
            v = __Porffor_iter_step(pad);
            if (pad.done) {
              using = false;
              v = undefined;
            }
          }
          Porffor.array.fastPush(padding, v);
        }
        if (using) __Porffor_iter_close(pad);
      } catch (e) {
        __Porffor_iter_closeAllThrow(recs);
        throw e;
      }
    }
  }

  return __Porffor_iter_newZip(recs, padding, undefined, it);
};

export const __Iterator_zipKeyed = (iterables: any, options: any): object => {
  if (!Porffor.object.isObject(iterables)) throw new TypeError('Iterator.zipKeyed: iterables is not an object');
  const it: object = __Porffor_iter_new(undefined, ITER_ZIP);
  const paddingOption: any = __Porffor_iter_zipOptions(options, it);

  const recs: any[] = Porffor.array.new(4);
  const keys: any[] = Porffor.array.new(4);
  const padding: any[] = Porffor.array.new(4);
  try {
    const all: any[] = __Reflect_ownKeys(iterables);
    const len: i32 = all.length;
    for (let i: i32 = 0; i < len; i++) {
      const key: any = all[i];
      const desc: any = __Reflect_getOwnPropertyDescriptor(iterables, key);
      if (desc === undefined) continue;
      if (!desc.enumerable) continue;
      const value: any = iterables[key];
      if (value === undefined) continue;

      Porffor.array.fastPush(recs, __Porffor_iter_flattenable(value));
      Porffor.array.fastPush(keys, key);
    }

    if (it.__mode == ZIP_LONGEST) {
      const count: i32 = keys.length;
      for (let i: i32 = 0; i < count; i++) Porffor.array.fastPush(padding, paddingOption === undefined ? undefined : paddingOption[keys[i]]);
    }
  } catch (e) {
    __Porffor_iter_closeAllThrow(recs);
    throw e;
  }

  return __Porffor_iter_newZip(recs, padding, keys, it);
};

// one step of a zip: a fresh array (an object for zipKeyed) of each iterator's next value
export const __Porffor_iter_zipStep = (it: any): any => {
  const recs: any[] = it.__recs;
  const iters: any[] = it.__iters;
  const count: i32 = iters.length;
  if (count == 0) {
    it.__done = true;
    return undefined;
  }

  const mode: i32 = it.__mode;
  const results: any[] = Porffor.array.new(4);
  for (let i: i32 = 0; i < count; i++) {
    const rec: any = iters[i];
    let value: any = undefined;
    if (rec === null) {
      value = it.__padding[i];
    } else {
      try {
        value = __Porffor_iter_step(rec);
      } catch (e) {
        rec.done = true;
        it.__done = true;
        __Porffor_iter_closeAllThrow(recs);
        throw e;
      }

      if (rec.done) {
        if (mode == ZIP_SHORTEST) {
          it.__done = true;
          __Porffor_iter_closeAll(recs);
          return undefined;
        }

        if (mode == ZIP_STRICT) {
          it.__done = true;
          if (i != 0) {
            __Porffor_iter_closeAllThrow(recs);
            throw new TypeError('Iterator.zip: the iterables have different lengths');
          }
          for (let k: i32 = 1; k < count; k++) {
            const other: any = iters[k];
            try {
              __Porffor_iter_step(other);
            } catch (e) {
              other.done = true;
              __Porffor_iter_closeAllThrow(recs);
              throw e;
            }
            if (!other.done) {
              __Porffor_iter_closeAllThrow(recs);
              throw new TypeError('Iterator.zip: the iterables have different lengths');
            }
          }
          return undefined;
        }

        // longest: padded from here, until none is left
        iters[i] = null;
        let open: boolean = false;
        for (let k: i32 = 0; k < count; k++) if (iters[k] !== null) open = true;
        if (!open) {
          it.__done = true;
          return undefined;
        }
        value = it.__padding[i];
      }
    }
    Porffor.array.fastPush(results, value);
  }

  const keys: any = it.__keys;
  if (keys === undefined) return results;
  const out: any = __Object_create(null, undefined);
  for (let i: i32 = 0; i < count; i++) out[keys[i]] = results[i];
  return out;
};

// [Symbol.iterator] of the built-in iterables, whose prototype objects carry no symbol
// keys: the method for a value of this type, or undefined
export const __Porffor_iter_builtinMethod = (trueType: i32): any => {
  if (trueType == Porffor.TYPES.array) return __Array_prototype_values;
  if ((trueType | 0b10000000) == Porffor.TYPES.bytestring) return __Porffor_string_iterator;
  if (trueType == Porffor.TYPES.set) return __Set_prototype_values;
  if (trueType == Porffor.TYPES.map) return __Map_prototype_entries;
  if (Porffor.fastAnd(trueType >= Porffor.TYPES.uint8clampedarray, trueType <= Porffor.TYPES.float64array)) return __Porffor_typedArray_values;
  // a generator is its own iterator
  if (trueType == Porffor.TYPES.__porffor_generator) return __Porffor_iter_self;
  return undefined;
};

// [Symbol.iterator] and [Symbol.asyncIterator] found on a built-in prototype, which carries
// no symbol keys, when a read of one missed: Array.prototype's (values), String.prototype's,
// Map.prototype's and Set.prototype's, %IteratorPrototype%'s (returns this), for obj or
// anything on its prototype chain. undefined for any other
export const __Porffor_iter_protoMethod = (obj: any, key: any): any => {
  const sync: boolean = key === Symbol.iterator;
  if (!sync) return undefined;
  let proto: any = obj;
  for (let depth: i32 = 0; depth < 64; depth++) {
    if (proto == null) return undefined;
    if (proto === __Array_prototype) return __Array_prototype_values;
    if (proto === __String_prototype) return __Porffor_string_iterator;
    if (proto === __Iterator_prototype) return __Porffor_iter_self;
    if (Porffor.comptime.flag`hasType.set`) if (proto === __Set_prototype) return __Set_prototype_values;
    if (Porffor.comptime.flag`hasType.map`) if (proto === __Map_prototype) return __Map_prototype_entries;
    if (!Porffor.object.isObject(proto)) return undefined;
    proto = Porffor.object.getPrototypeWithHidden(proto, Porffor.type(proto));
  }
  return undefined;
};

export const __Porffor_iter_self = function (this: any): any {
  return this;
};

export const __Porffor_string_iterator = function (this: any): object {
  // RequireObjectCoercible, then ToString (reached off String.prototype, this is any value)
  if (this == null) throw new TypeError('String.prototype[Symbol.iterator] called on null or undefined');
  if ((Porffor.type(this) | 0b10000000) == Porffor.TYPES.bytestring) return __Porffor_iter_new(this, ITER_STRING);
  return __Porffor_iter_new(ecma262.ToString(this), ITER_STRING);
};

export const __Porffor_typedArray_values = function (this: any): object {
  return __Porffor_iter_new(this, ITER_VALUES);
};

// the iterators the other builtins make (array.ts, map.ts, set.ts, typedarray.js)
export const __Porffor_iter_newValues = (src: any): object => {
  return __Porffor_iter_new(src, ITER_VALUES);
};

export const __Porffor_iter_newKeys = (src: any): object => {
  return __Porffor_iter_new(src, ITER_KEYS);
};

export const __Porffor_iter_newEntries = (src: any): object => {
  return __Porffor_iter_new(src, ITER_ENTRIES);
};

// for...of and friends in a program that cannot make its own iterators (parse.js): the
// only non-built-in iterable is a built-in iterator object (arr.keys() …), stepped directly
export const __Porffor_iter_stepBuiltinOnly = (obj: any): any => {
  if (Porffor.object.isObject(obj)) if (obj.__kind !== undefined) return __Porffor_iter_builtinStep(obj);
  throw new TypeError('Object is not iterable');
};

export const __Porffor_iter_builtinDone = (obj: any): boolean => {
  return obj.__done;
};
