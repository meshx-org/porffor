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

export const __Porffor_iter_self = function (this: any): any {
  return this;
};

export const __Porffor_string_iterator = function (this: any): object {
  return __Porffor_iter_new(this, ITER_STRING);
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
