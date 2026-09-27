export default async () => {
  let out = '';

  // An Array method as a typed array's: Array and any[] read as the typed array, except a
  // plain array the method makes for itself (Porffor.array.new: join's parts, map's out),
  // which stays one; typed as the typed array, its stores were bytes and its reads garbage
  // A method whose result is such an array (map, filter, with, toReversed, toSorted) gives
  // back a typed array of the same kind instead, as the spec has it: made from it on return
  const typedArrayVersion = (code, name) => {
    const plainOut = code.includes('const out: any[] = Porffor.array.new');
    code = code
      .replace('// @porf-typed-array\n', '')
      .replaceAll(': any[] = Porffor.array.new', ': __PLAIN_ARRAY__ = Porffor.array.new')
      .replaceAll('Array', name)
      .replaceAll('any[]', name)
      .replaceAll('__PLAIN_ARRAY__', 'any[]');
    if (plainOut) code = code
      .replaceAll(`Porffor.callThis(__${name}_prototype_sort, out,`, `Porffor.callThis(__${name}_prototype_sort, new ${name}(out),`)
      .replaceAll('return out;', `return new ${name}(out);`);
    return code;
  };

  const arrayCode = (await import('node:fs')).readFileSync(globalThis.precompileCompilerPath + '/builtins/array.ts', 'utf8');
  const typedArrayFuncs = [...arrayCode.matchAll(/\/\/ @porf-typed-array[\s\S]+?^};$/gm)].map(x => x[0]);

  // typedarray layout: length (i32), bufferPtr (i32, buffer + byteOffset), byteOffset (i32, getter only)

  for (const x of [ 'Uint8', 'Int8', 'Uint8Clamped', 'Uint16', 'Int16', 'Uint32', 'Int32', 'Float32', 'Float64', 'BigInt64', 'BigUint64' ]) {
    const name = x + 'Array';
    out += `export const ${name} = function (arg: any, byteOffset: any, length: any): ${name} {
  if (!new.target) throw new TypeError("Constructor ${name} requires 'new'");

  const out: ${name} = Porffor.malloc(12);
  const outPtr: i32 = Porffor.IR.ptr(out);
  Porffor.IR.storeI32(outPtr, 0, 0);
  Porffor.IR.storeI32(outPtr, 4, 0);
  Porffor.IR.storeI32(outPtr, 8, 0);

  let len: i32 = 0;
  let byteLength: number = 0;
  let bufferPtr: i32;

  if (Porffor.fastOr(
    Porffor.type(arg) == Porffor.TYPES.arraybuffer,
    Porffor.type(arg) == Porffor.TYPES.sharedarraybuffer
  )) {
    bufferPtr = Porffor.IR.ptr(arg);
    if (arg.detached) throw new TypeError('Constructed ${name} with a detached ArrayBuffer');

    let offset: i32 = 0;
    if (Porffor.type(byteOffset) != Porffor.TYPES.undefined) offset = Math.trunc(byteOffset);
    if (offset < 0) throw new RangeError('Invalid DataView byte offset (negative)');

    Porffor.IR.storeI32(outPtr, 8, offset);
    Porffor.IR.storeI32(outPtr, 4, bufferPtr + offset);

    if (Porffor.type(length) == Porffor.TYPES.undefined) {
      const bufferLen: i32 = Porffor.IR.loadI32(bufferPtr, 0);
      len = (bufferLen - offset) / ${name}.BYTES_PER_ELEMENT;

      if (!Number.isInteger(len)) throw new RangeError('Byte length of ${name} should be divisible by BYTES_PER_ELEMENT');
    } else len = Math.trunc(length);

    byteLength = len * ${name}.BYTES_PER_ELEMENT;
  } else {
    if (Porffor.fastOr(
      Porffor.type(arg) == Porffor.TYPES.array,
      (Porffor.type(arg) | 0b10000000) == Porffor.TYPES.bytestring,
      Porffor.type(arg) == Porffor.TYPES.set,
      Porffor.fastAnd(Porffor.type(arg) >= Porffor.TYPES.uint8clampedarray, Porffor.type(arg) <= Porffor.TYPES.float64array)
    )) {
      len = arg.length;
    } else if (Porffor.type(arg) == Porffor.TYPES.number) {
      len = Math.trunc(arg);
    }

    byteLength = len * ${name}.BYTES_PER_ELEMENT;

    if (len < 0) throw new RangeError('Invalid TypedArray length (negative)');
    if (byteLength > 2147483643) throw new RangeError('Invalid ArrayBuffer length (over maximum supported length)');

    bufferPtr = Porffor.malloc(4 + byteLength);
    Porffor.IR.storeI32(outPtr, 4, bufferPtr);
    Porffor.IR.storeI32(bufferPtr, 0, byteLength);
    Porffor.IR.fill(bufferPtr + 4, 0, byteLength);

    if (Porffor.fastOr(
      Porffor.type(arg) == Porffor.TYPES.array,
      (Porffor.type(arg) | 0b10000000) == Porffor.TYPES.bytestring,
      Porffor.type(arg) == Porffor.TYPES.set,
      Porffor.fastAnd(Porffor.type(arg) >= Porffor.TYPES.uint8clampedarray, Porffor.type(arg) <= Porffor.TYPES.float64array)
    )) {
      let i: i32 = 0;
      for (const x of arg) {
        out[i++] = x;
      }
    }
  }

  if (len < 0) throw new RangeError('Invalid TypedArray length (negative)');
  if (byteLength > 2147483643) throw new RangeError('Invalid ArrayBuffer length (over maximum supported length)');

  Porffor.IR.storeI32(outPtr, 0, len);
  // the buffer malloc above can run a minor that promotes out in place; the raw
  // buffer store has no barrier, so remember it before the frame's locals die
  Porffor.IR.gcBarrier(out, Porffor.type(out));
  return out;
};

// of and from make the result with this: a TypeError for a non-constructor, and a
// subclass or custom constructor makes its own (__Porffor_typedArrayCreate)
export const __${name}_of = function (this: any, ...items: any[]): any {
  if (!__ecma262_IsConstructor(this)) throw new TypeError('${name}.of: this is not a constructor');
  if (this == ${name}) return new ${name}(items);
  return __Porffor_typedArrayFrom${name}(this, items);
};

export const __${name}_from = function (this: any, arg: any, mapFn: any): any {
  if (!__ecma262_IsConstructor(this)) throw new TypeError('${name}.from: this is not a constructor');
  if (Porffor.fastAnd(Porffor.type(mapFn) != Porffor.TYPES.undefined, Porffor.type(mapFn) != Porffor.TYPES.function)) throw new TypeError('${name}.from: mapFn is not a function');
  const arr: any[] = Porffor.array.new(4);
  let len: i32 = 0;

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
        arr[i] = mapFn(x, i);
        i++;
      }
    } else {
      for (const x of arg) {
        arr[i++] = x;
      }
    }
    len = i;
  }

  arr.length = len;

  if (this == ${name}) return new ${name}(arr);
  return __Porffor_typedArrayFrom${name}(this, arr);
};

// another constructor as this can only come through call or apply (or a subclass's
// inherited static, which subclassing typed arrays does not reach yet): the construct
// machinery only in a program that has those, else the kind itself
export const __Porffor_typedArrayFrom${name} = (C: any, items: any[]): any => {
  if (Porffor.comptime.flag\`member.call\`) return __Porffor_typedArrayCreate(C, items);
  if (Porffor.comptime.flag\`member.apply\`) return __Porffor_typedArrayCreate(C, items);
  return new ${name}(items);
};

export const __${name}_prototype_buffer$get = function (this: ${name}): any|ArrayBuffer {
  return Porffor.IR.loadI32(this, 4) - Porffor.IR.loadI32(this, 8) as ArrayBuffer;
};

// a detached buffer's views are 0 long, at 0 (only a program that can detach one checks)
export const __${name}_prototype_byteLength$get = function (this: ${name}) {
  if (Porffor.comptime.flag\`hasFunc.__Porffor_arraybuffer_detach\`) if (__Porffor_typedArray_detached(this)) return 0;
  return Porffor.IR.loadI32(this, 0) * ${name}.BYTES_PER_ELEMENT;
};

export const __${name}_prototype_byteOffset$get = function (this: ${name}) {
  if (Porffor.comptime.flag\`hasFunc.__Porffor_arraybuffer_detach\`) if (__Porffor_typedArray_detached(this)) return 0;
  return Porffor.IR.loadI32(this, 8);
};

// keys/values/entries: iterators (iterator.ts) over the typed array, read as they go
export const __${name}_prototype_keys = function (this: ${name}) {
  return __Porffor_iter_newKeys(this);
};

export const __${name}_prototype_values = function (this: ${name}) {
  return __Porffor_iter_newValues(this);
};

export const __${name}_prototype_entries = function (this: ${name}) {
  return __Porffor_iter_newEntries(this);
};

export const __${name}_prototype_at = function (this: ${name}, index: any) {
  index = ecma262.ToIntegerOrInfinity(index);

  const len: i32 = this.length;
  if (index < 0) {
    index = len + index;
    if (index < 0) return undefined;
  }
  if (index >= len) return undefined;

  return this[index];
};

export const __${name}_prototype_slice = function (this: ${name}, start: any, end: any) {
  const len: i32 = this.length;
  start = ecma262.ToIntegerOrInfinity(start);
  if (Porffor.type(end) == Porffor.TYPES.undefined) end = len;
    else end = ecma262.ToIntegerOrInfinity(end);

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

  const outLen: i32 = start > end ? 0 : end - start;
  const out: ${name} = new ${name}(outLen);

  let i: i32 = start;
  let j: i32 = 0;
  while (j < outLen) {
    out[j++] = this[i++];
  }

  return out;
};

export const __${name}_prototype_set = function (this: ${name}, array: any, offset: number) {
  const len: i32 = this.length;

  offset = Math.trunc(offset);
  if (Porffor.fastOr(offset < 0, offset > len)) throw new RangeError('Offset out of bounds');

  if (Porffor.fastOr(
    Porffor.type(array) == Porffor.TYPES.array,
    (Porffor.type(array) | 0b10000000) == Porffor.TYPES.bytestring,
    Porffor.type(array) == Porffor.TYPES.set,
    Porffor.fastAnd(Porffor.type(array) >= Porffor.TYPES.uint8clampedarray, Porffor.type(array) <= Porffor.TYPES.float64array)
  )) {
    let i: i32 = offset;
    for (const x of array) {
      this[i++] = Porffor.type(x) == Porffor.TYPES.number ? x : 0;
      if (i > len) throw new RangeError('Array is too long for given offset');
    }
  }
};

export const __${name}_prototype_subarray = function (this: ${name}, start: any, end: any) {
  const len: i32 = this.length;
  start = ecma262.ToIntegerOrInfinity(start);
  if (Porffor.type(end) == Porffor.TYPES.undefined) end = len;
    else end = ecma262.ToIntegerOrInfinity(end);

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

  const out: ${name} = Porffor.malloc(12);
  Porffor.IR.storeI32(out, 0, end - start);
  Porffor.IR.storeI32(out, 4, Porffor.IR.loadI32(this, 4) + start * ${name}.BYTES_PER_ELEMENT);
  Porffor.IR.storeI32(out, 8, Porffor.IR.loadI32(this, 8) + start * ${name}.BYTES_PER_ELEMENT);

  return out;
};

${typedArrayFuncs.reduce((acc, x) => acc + typedArrayVersion(x, name) + '\n\n', '')}`;
  };


  out += `
// TypedArrayCreate: C(len) through a constructor that is not the typed array itself, which
// has to give a typed array at least that long; the items then set into it
export const __Porffor_typedArrayCreate = (C: any, items: any[]): any => {
  const len: i32 = items.length;
  const args: any[] = Porffor.array.new(1);
  args[0] = len;
  const out: any = Porffor.call(C, args, null, C);
  const t: i32 = Porffor.type(out);
  if (Porffor.fastOr(t < Porffor.TYPES.uint8clampedarray, t > Porffor.TYPES.float64array)) throw new TypeError('constructor did not make a typed array');
  if (out.length < len) throw new TypeError('constructor made a typed array too short');
  for (let k: i32 = 0; k < len; k++) out[k] = items[k];
  return out;
};

// a view of a detached buffer (its length word is -1)
export const __Porffor_typedArray_detached = (ta: any): boolean =>
  Porffor.IR.loadI32(Porffor.IR.loadI32(ta, 4) - Porffor.IR.loadI32(ta, 8), 0) == 4294967295;

// ValidateTypedArray: such a view throws
export const __Porffor_typedArray_validate = (ta: any): void => {
  if (__Porffor_typedArray_detached(ta)) throw new TypeError('Cannot perform %TypedArray%.prototype method on a detached ArrayBuffer');
};`;

  // %TypedArray%: the typed arrays' abstract parent (not a global: its name is the last
  // segment). Its prototype has the methods every kind shares, each one calling the kind's
  // own, read off the kind's prototype object by name (so no dispatcher names a kind)
  out += `
export const __Porffor_TypedArray = function (): any {
  throw new TypeError('Abstract class TypedArray not directly constructable');
};

// this's kind's own method called name (an own property of its prototype object: the
// chain would lead back to %TypedArray%.prototype) called on it, a TypeError for anything
// else. One for all the dispatchers: none takes more than three arguments
export const __Porffor_typedArray_call = (ta: any, name: any, a: any, b: any, c: any): any => {
  const t: i32 = Porffor.type(ta);
  if (Porffor.fastOr(t < Porffor.TYPES.uint8clampedarray, t > Porffor.TYPES.float64array))
    throw new TypeError('%TypedArray%.prototype method called on a non-TypedArray');
  const proto: any = __Porffor_object_getHiddenPrototype(t);
  const entry: i32 = __Porffor_object_lookup(proto, name, __Porffor_object_hash(name));
  if (entry == 0) throw new TypeError('%TypedArray%.prototype method called on a non-TypedArray');
  const method: any = __Porffor_object_readValue(entry);
  return Porffor.callThis(method, ta, a, b, c);
};
`;
  // %TypedArray%.prototype's getters read the view itself (length, pointer, offset: the same
  // for every kind), a TypeError for anything else; 0 for a view of a detached buffer
  const getter = (name, body) => `
export const __Porffor_TypedArray_prototype_${name}$get = function (this: any) {
  const t: i32 = Porffor.type(this);
  if (Porffor.fastOr(t < Porffor.TYPES.uint8clampedarray, t > Porffor.TYPES.float64array))
    throw new TypeError('%TypedArray%.prototype.${name} called on a non-TypedArray');
${body}
};
`;
  const detachedZero = `  if (Porffor.comptime.flag\`hasFunc.__Porffor_arraybuffer_detach\`) if (__Porffor_typedArray_detached(this)) return 0;`;
  out += getter('length', `${detachedZero}
  return Porffor.IR.loadI32(this, 0);`);
  out += getter('byteOffset', `${detachedZero}
  return Porffor.IR.loadI32(this, 8);`);
  out += getter('buffer', `  return Porffor.IR.loadI32(this, 4) - Porffor.IR.loadI32(this, 8) as ArrayBuffer;`);
  out += getter('byteLength', `${detachedZero}
  let size: i32 = 1;
  if (Porffor.fastOr(t == Porffor.TYPES.uint16array, t == Porffor.TYPES.int16array)) size = 2;
    else if (Porffor.fastOr(t == Porffor.TYPES.uint32array, t == Porffor.TYPES.int32array, t == Porffor.TYPES.float32array)) size = 4;
    else if (Porffor.fastOr(t == Porffor.TYPES.float64array, t == Porffor.TYPES.bigint64array, t == Porffor.TYPES.biguint64array)) size = 8;
  return Porffor.IR.loadI32(this, 0) * size;`);
  const notShared = new Set([ 'concat', 'valueOf' ]);
  for (const [ , method, params ] of out.matchAll(/export const __Uint8Array_prototype_([A-Za-z]+(?:\$get)?) = function \(this: Uint8Array,? ?([^)]*)\)/g)) {
    if (notShared.has(method) || params.includes('...') || method.endsWith('$get')) continue;
    if (params.split(',').filter(x => x.trim()).length > 3) throw new Error(`%TypedArray%.prototype.${method} takes more than __Porffor_typedArray_call passes`);
    const names = params.split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(':')[0].trim());
    out += `
export const __Porffor_TypedArray_prototype_${method} = function (this: any${names.map(x => `, ${x}: any`).join('')}) {
  return __Porffor_typedArray_call(this, '${method}'${[ 0, 1, 2 ].map(i => ', ' + (names[i] ?? 'undefined')).join('')});
};
`;
  }

  // every prototype method validates this first (not the getters, nor subarray: its new view
  // throws for a detached buffer itself), only in a program that can detach a buffer
  out = out.replace(/(export const __\w+Array_prototype_(\w+) = function \(this: \w+[^\n]*\{\n)/g, (m, head, method) =>
    method.endsWith('$get') || method === 'subarray' || head.includes('__Porffor_TypedArray_') ? m
      : head + '  if (Porffor.comptime.flag`hasFunc.__Porffor_arraybuffer_detach`) __Porffor_typedArray_validate(this);\n');

  return out;
};
