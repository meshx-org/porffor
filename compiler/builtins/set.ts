import type {} from './porffor.d.ts';

// shares the ordered hash table container from map.ts (vals slot @4 = 0)

export const __Set_prototype_size$get = function (this: Set) {
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  return keys.length - Porffor.IR.loadI32(this, 16);
};

export const __Porffor_set_valuesArray = function (this: Set) {
  // todo: this should return an iterator not array
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  const keysEntries: i32 = Porffor.IR.loadI32(keys, 4);
  const out: any[] = Porffor.array.new(4);

  const size: i32 = keys.length;
  for (let i: i32 = 0; i < size; i++) {
    if (Porffor.IR.loadU64(keysEntries + i * 8, 0) == -1) continue;
    Porffor.array.fastPush(out, keys[i]);
  }

  return out;
};

export const __Porffor_set_keysArray = function (this: Set) {
  return Porffor.callThis(__Porffor_set_valuesArray, this);
};

export const __Set_prototype_has = function (this: Set, value: any) {
  return __Porffor_hashtableLookup(this, value) != -1;
};

export const __Set_prototype_add = function (this: Set, value: any) {
  if (__Porffor_hashtableLookup(this, value) == -1) {
    __Porffor_hashtableAppend(this, value);
  }

  return this;
};

export const __Set_prototype_delete = function (this: Set, value: any) {
  const index: i32 = __Porffor_hashtableLookup(this, value);
  if (index == -1) return false;

  __Porffor_hashtableTombstone(this, value, index);
  return true;
};

export const __Set_prototype_clear = function (this: Set) {
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  __Porffor_array_ensure(keys, 0);
  keys.length = 0;

  Porffor.IR.storeI32(this, 8, 0);
  Porffor.IR.storeI32(this, 12, 0);
  Porffor.IR.storeI32(this, 16, 0);
};

export const __Set_prototype_forEach = function (this: Set, callbackFn: any, thisArg: any = undefined) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('callbackFn is not a function');

  for (const x of this) {
    callbackFn.call(thisArg, x, x, this);
  }
};

export const Set = function (iterable: any): Set {
  if (!new.target) throw new TypeError("Constructor Set requires 'new'");

  const out: Set = __Porffor_hashtableNew(false);
  Porffor.IR.gcBarrier(out, Porffor.TYPES.set);

  if (iterable != null) for (const x of iterable) {
    Porffor.callThis(__Set_prototype_add, out, x);
  }

  return out;
};

export const __Porffor_set_entriesArray = function (this: Set) {
  const values: any[] = Porffor.callThis(__Porffor_set_valuesArray, this);
  const out: any[] = Porffor.array.new(4);

  const size: i32 = values.length;
  for (let i: i32 = 0; i < size; i++) {
    const entry: any[] = Porffor.array.new(2);
    Porffor.array.fastPush(entry, values[i]);
    Porffor.array.fastPush(entry, values[i]);
    Porffor.array.fastPush(out, entry);
  }

  return out;
};

// GetSetRecord (ES2025): any object with a numeric size, and has and keys methods, is a set-like
// the Set methods take ([set, size, has, keys])
export const __Porffor_set_getSetRecord = (obj: any): any[] => {
  if (!Porffor.object.isObject(obj)) throw new TypeError('Set method argument must be an object');
  const numSize: number = ecma262.ToNumber(obj.size);
  if (Number.isNaN(numSize)) throw new TypeError('Set method argument has no numeric size');
  const intSize: number = ecma262.ToIntegerOrInfinity(numSize);
  if (intSize < 0) throw new RangeError('Set method argument has a negative size');
  const has: any = obj.has;
  if (Porffor.type(has) != Porffor.TYPES.function) throw new TypeError('Set method argument has no has method');
  const keys: any = obj.keys;
  if (Porffor.type(keys) != Porffor.TYPES.function) throw new TypeError('Set method argument has no keys method');
  const rec: any[] = Porffor.array.new(4);
  rec[0] = obj; rec[1] = intSize; rec[2] = has; rec[3] = keys;
  return rec;
};

// GetIteratorFromMethod(set, keys): its iterator ([iterator, next])
export const __Porffor_set_keysIterator = (rec: any[]): any[] => {
  const iter: any = Porffor.call(rec[3], Porffor.array.new(0), rec[0], null);
  if (!Porffor.object.isObject(iter)) throw new TypeError('keys() did not return an object');
  const out: any[] = Porffor.array.new(2);
  out[0] = iter; out[1] = iter.next;
  return out;
};

// IteratorStepValue: the next value (-0 as +0), or a hole-free sentinel: the record itself when done
export const __Porffor_set_keysStep = (it: any[]): any => {
  const res: any = Porffor.call(it[1], Porffor.array.new(0), it[0], null);
  if (!Porffor.object.isObject(res)) throw new TypeError('iterator result is not an object');
  if (res.done) return it;
  const v: any = res.value;
  if (Porffor.fastAnd(Porffor.type(v) == Porffor.TYPES.number, v == 0)) return 0;
  return v;
};

export const __Porffor_set_keysClose = (it: any[]): void => {
  const ret: any = it[0].return;
  if (ret != null) Porffor.call(ret, Porffor.array.new(0), it[0], null);
};

export const __Porffor_set_otherHas = (rec: any[], v: any): boolean => {
  const args: any[] = Porffor.array.new(1);
  args[0] = v;
  return !!Porffor.call(rec[2], args, rec[0], null);
};

export const __Set_prototype_union = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  const it: any[] = __Porffor_set_keysIterator(rec);
  const out: Set = new Set(this);
  while (true) {
    const v: any = __Porffor_set_keysStep(it);
    if (v === it) break;
    out.add(v);
  }
  return out;
};

export const __Set_prototype_intersection = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  const out: Set = new Set();
  if (this.size <= rec[1]) {
    const values: any[] = Porffor.callThis(__Porffor_set_valuesArray, this);
    for (let i: i32 = 0; i < values.length; i++) {
      const e: any = values[i];
      if (Porffor.fastAnd(this.has(e), __Porffor_set_otherHas(rec, e))) out.add(e);
    }
  } else {
    const it: any[] = __Porffor_set_keysIterator(rec);
    while (true) {
      const v: any = __Porffor_set_keysStep(it);
      if (v === it) break;
      if (this.has(v)) out.add(v);
    }
  }
  return out;
};

export const __Set_prototype_difference = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  const out: Set = new Set(this);
  if (this.size <= rec[1]) {
    const values: any[] = Porffor.callThis(__Porffor_set_valuesArray, this);
    for (let i: i32 = 0; i < values.length; i++) {
      const e: any = values[i];
      if (Porffor.fastAnd(this.has(e), __Porffor_set_otherHas(rec, e))) out.delete(e);
    }
  } else {
    const it: any[] = __Porffor_set_keysIterator(rec);
    while (true) {
      const v: any = __Porffor_set_keysStep(it);
      if (v === it) break;
      out.delete(v);
    }
  }
  return out;
};

export const __Set_prototype_symmetricDifference = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  const it: any[] = __Porffor_set_keysIterator(rec);
  const out: Set = new Set(this);
  while (true) {
    const v: any = __Porffor_set_keysStep(it);
    if (v === it) break;
    if (this.has(v)) out.delete(v);
      else out.add(v);
  }
  return out;
};

export const __Set_prototype_isSubsetOf = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  if (this.size > rec[1]) return false;
  const values: any[] = Porffor.callThis(__Porffor_set_valuesArray, this);
  for (let i: i32 = 0; i < values.length; i++) {
    if (!__Porffor_set_otherHas(rec, values[i])) return false;
  }
  return true;
};

export const __Set_prototype_isSupersetOf = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  if (this.size < rec[1]) return false;
  const it: any[] = __Porffor_set_keysIterator(rec);
  while (true) {
    const v: any = __Porffor_set_keysStep(it);
    if (v === it) break;
    if (!this.has(v)) {
      __Porffor_set_keysClose(it);
      return false;
    }
  }
  return true;
};

export const __Set_prototype_isDisjointFrom = function (this: Set, other: any) {
  const rec: any[] = __Porffor_set_getSetRecord(other);
  if (this.size <= rec[1]) {
    const values: any[] = Porffor.callThis(__Porffor_set_valuesArray, this);
    for (let i: i32 = 0; i < values.length; i++) {
      if (__Porffor_set_otherHas(rec, values[i])) return false;
    }
  } else {
    const it: any[] = __Porffor_set_keysIterator(rec);
    while (true) {
      const v: any = __Porffor_set_keysStep(it);
      if (v === it) break;
      if (this.has(v)) {
        __Porffor_set_keysClose(it);
        return false;
      }
    }
  }
  return true;
};

export const __Set_prototype_toString = function (this: Set) { return '[object Set]'; };
export const __Set_prototype_toLocaleString = function (this: Set) { return Porffor.callThis(__Set_prototype_toString, this); };

// values/keys/entries/[Symbol.iterator]: iterators over a snapshot taken when made
export const __Set_prototype_values = function (this: Set) {
  return __Porffor_iter_newValues(Porffor.callThis(__Porffor_set_valuesArray, this));
};

export const __Set_prototype_keys = function (this: Set) {
  return __Porffor_iter_newValues(Porffor.callThis(__Porffor_set_valuesArray, this));
};

export const __Set_prototype_entries = function (this: Set) {
  return __Porffor_iter_newValues(Porffor.callThis(__Porffor_set_entriesArray, this));
};
