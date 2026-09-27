export default ({ TYPES, TYPE_NAMES }) => {
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

  const ctors = new Set([ 'Object', 'Function', 'Symbol', 'BigInt' ]);
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

  out += `
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

  out += `

export const __Porffor_object_builtinStatics = (f: any, store: object): void => {`;
  for (const [ ctor, methods ] of statics) {
    out += `
  if (Porffor.comptime.flag\`hasFunc.${ctor}\`) {
    if (f == ${ctor}) {`;
    for (const method of methods) out += `
      if (Porffor.comptime.flag\`hasFunc.__${ctor}_${method}\`) __Porffor_object_fastAdd(store, '${method}', __${ctor}_${method}, 0b1010);`;
    out += `
      return;
    }
  }`;
  }
  out += `
};`;

  return out;
};
