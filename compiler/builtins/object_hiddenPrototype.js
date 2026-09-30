export default ({ TYPES, TYPE_NAMES, TYPED_ARRAY_KINDS }) => {
  // no imports above: precompile knows a generator by its first line (export default)
  const { readdirSync, readFileSync } = process.getBuiltinModule('node:fs');
  const { dirname, join } = process.getBuiltinModule('node:path');
  const { fileURLToPath } = process.getBuiltinModule('node:url');

  let out = `export const __Porffor_object_getHiddenPrototype = (trueType: i32): any => {
  if (Porffor.comptime.flag\`hasFunc.#get___String_prototype\`) {
    if (Porffor.fastOr(
      (trueType | 0b10000000) == Porffor.TYPES.bytestring,
      trueType == Porffor.TYPES.stringobject
    )) return __String_prototype;
  }

  if (Porffor.comptime.flag\`hasFunc.#get___Number_prototype\`) {
    if (Porffor.fastOr(
      trueType == Porffor.TYPES.number,
      trueType == Porffor.TYPES.numberobject
    )) return __Number_prototype;
  }

  if (Porffor.comptime.flag\`hasFunc.#get___Boolean_prototype\`) {
    if (Porffor.fastOr(
      trueType == Porffor.TYPES.boolean,
      trueType == Porffor.TYPES.booleanobject
    )) return __Boolean_prototype;
  }`;

  for (const x in TYPES) {
    if (['object', 'undefined', 'string', 'bytestring', 'stringobject', 'number', 'numberobject', 'boolean', 'booleanobject'].includes(x)) continue;

    const proto = (TYPE_NAMES[TYPES[x]].startsWith('__') ? '' : '__') + TYPE_NAMES[TYPES[x]] + '_prototype';
    out += `
  if (Porffor.comptime.flag\`hasFunc.#get_${proto}\`) {
    if (trueType == Porffor.TYPES.${x}) return ${proto};
  }`;
  }

  // if (trueType == Porffor.TYPES.function) return __Function_prototype;
  out += `
  return __Object_prototype;
};

export const __Porffor_object_builtinPrototype = (f: any): any => {`;

  const ctors = new Set([ 'Object', 'Function', 'Symbol', 'BigInt', 'Iterator' ]);
  for (const x in TYPES) {
    if (x === 'object' || x === 'undefined' || x.startsWith('__')) continue;
    ctors.add(TYPE_NAMES[TYPES[x]].replace('Object', ''));
  }
  for (const x of ctors) {
    out += `
  if (Porffor.comptime.flag\`hasFunc.${x}\`) {
    if (f == ${x}) return __${x}_prototype;
  }`;
  }

  // %AsyncFunction%'s is %AsyncFunction.prototype% (function.ts), made on first use
  out += `
  if (Porffor.comptime.flag\`hasFunc.__Porffor_AsyncFunction\`) {
    if (f == __Porffor_AsyncFunction) return __Porffor_asyncFunction_proto();
  }`;

  // %TypedArray% is reached only through a kind (its own prototype): gated on the kinds, as
  // __Porffor_object_builtinParent is (it is brought in there, after these flags are settled)
  const typedArrayKinds = TYPED_ARRAY_KINDS.map(x => x.slice(0, -5));
  // (only a program using a kind's constructor as a value reaches either)
  out += `
  if (Porffor.comptime.flag\`program.typedArrayCtorValue\`) {`;
  for (const x of typedArrayKinds) {
    out += `
    if (Porffor.comptime.flag\`hasFunc.${x}Array\`) {
      if (f == __Porffor_TypedArray) return __Porffor_TypedArray_prototype;
    }`;
  }
  out += `
  }`;
  out += `
  return undefined;
};

// a built-in constructor's own prototype, when it is not Function.prototype: the typed
// arrays' is %TypedArray%, and the native errors' is Error (TypeError's [[Prototype]] is
// Error, so walking up from a subclass reaches it)
export const __Porffor_object_builtinParent = (f: any): any => {`;
  for (const x of [ 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'SuppressedError' ]) {
    out += `
  if (Porffor.comptime.flag\`hasFunc.${x}\`) {
    if (f == ${x}) return Error;
  }`;
  }
  out += `
  if (Porffor.comptime.flag\`program.typedArrayCtorValue\`) {`;
  for (const x of typedArrayKinds) {
    out += `
    if (Porffor.comptime.flag\`hasFunc.${x}Array\`) {
      if (f == ${x}Array) return __Porffor_TypedArray;
    }`;
  }
  out += `
  }
  return undefined;
};`;

  // A built-in constructor read as a value (const O = Object; O.keys, or passed around)
  // has its static methods as properties of its function object: added to its property
  // store when that is made (_internal_object.ts). Each only when the program has it:
  // codegen includes those a program may read (resolveMemberDemandsOnce).
  const statics = new Map();
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const file of readdirSync(dir).filter(x => x.endsWith('.ts')).sort()) {
    for (const [ , ctor, method ] of readFileSync(join(dir, file), 'utf8').matchAll(/export const __([A-Z][A-Za-z0-9]*)_([a-zA-Z][a-zA-Z0-9]*) = /g)) {
      if (!ctors.has(ctor) || method === 'prototype') continue;
      if (!statics.has(ctor)) statics.set(ctor, new Set());
      statics.get(ctor).add(method);
    }
  }

  // typedarray.js makes the typed arrays' (not a .ts file this reads)
  for (const ctor of TYPED_ARRAY_KINDS) {
    if (!ctors.has(ctor)) continue;
    if (!statics.has(ctor)) statics.set(ctor, new Set());
    statics.get(ctor).add('from').add('of');
  }

  // and their static values (Number.EPSILON, Uint8Array.BYTES_PER_ELEMENT), read off the
  // constructor itself: each only in a program that reads a member of its name. Not
  // Symbol's well-known symbols: a builtin reading one does not bring in its initialiser
  const staticValues = new Map([
    [ 'Number', [ 'NaN', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY', 'MAX_VALUE', 'MIN_VALUE', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'EPSILON' ] ],
    ...TYPED_ARRAY_KINDS.map(x => [ x, [ 'BYTES_PER_ELEMENT' ] ])
  ]);

  out += `

export const __Porffor_object_builtinStatics = (f: any, store: object): void => {`;
  // get [Symbol.species] (returns this) on the constructors that have one, in a program that
  // names species (which also brings in the symbol)
  out += `
  if (Porffor.comptime.flag\`member.species\`) {`;
  for (const ctor of [ 'Array', 'Map', 'Set', 'RegExp', 'Promise', 'ArrayBuffer', 'SharedArrayBuffer', '__Porffor_TypedArray' ]) {
    if (!ctor.startsWith('__') && !ctors.has(ctor)) continue;
    out += `
    if (Porffor.comptime.flag\`hasFunc.${ctor}\`) {
      if (f == ${ctor}) __Porffor_object_fastAddAccessor(store, Symbol.species, __Porffor_species$get, 0b0010);
    }`;
  }
  out += `
  }`;
  for (const [ ctor, methods ] of statics) {
    out += `
  if (Porffor.comptime.flag\`hasFunc.${ctor}\`) {
    if (f == ${ctor}) {`;
    for (const method of methods) out += `
      if (Porffor.comptime.flag\`hasFunc.__${ctor}_${method}\`) __Porffor_object_fastAdd(store, '${method}', __${ctor}_${method}, 0b1010);`;
    for (const value of staticValues.get(ctor) ?? []) out += `
      if (Porffor.comptime.flag\`member.${value}\`) __Porffor_object_fastAdd(store, '${value}', ${ctor}.${value}, 0b0000);`;
    out += `
      return;
    }
  }`;
  }
  out += `
};`;

  return out;
};
