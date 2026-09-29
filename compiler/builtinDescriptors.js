// The built-ins' prototype objects as the spec describes them: each property's key (a string,
// or a well-known symbol), kind (a method, an accessor, a data value) and attributes, and the
// object's constructor and parent. Made from the builtin functions' names (__Map_prototype_get
// is Map.prototype.get, __Map_prototype_size$get the getter of its size) and the table below,
// for what a name cannot say. builtins.js builds the objects from these.
//
// A descriptor:
//   { name: '__Map_prototype', ctor: 'Map', parent, props: [ prop, ... ] }
// parent: undefined (Object.prototype, as a new object has), null (none), or
//   { object: '__Error_prototype' }, optionally { ..., flag, otherwise } (the parent only in a
//   program with that program flag, else the object otherwise)
// prop:
//   { key: 'get', kind: 'method', func: '__Map_prototype_get' }
//   { key: 'size', kind: 'accessor', get: '__Map_prototype_size$get' }
//   { key: 'name', kind: 'data', value: 'TypeError' }       (a number, string or null)
//   { key: 'constructor', kind: 'data', func: 'Map' }       (a builtin function's value)
//   { symbol: 'toStringTag', kind: 'data', value: 'Map', demand: 'toStringTag' }
//   { symbol: 'dispose', kind: 'method', func: '...', always: true }
//   { key: 'map', kind: 'method', func: '...', unless: 'typedArrayCtorValue' } (only in a
//     program without that program flag)
// with attrs { writable, enumerable, configurable } (an accessor has no writable). A method or
// accessor is on the object only when its function is in the program (or the whole object is
// asked for); demand: only in a program that reads a property of that name; always: whenever
// the object is made.

export const NATIVE_ERRORS = [ 'AggregateError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError', 'SuppressedError' ];
export const ERRORS = [ 'Error', ...NATIVE_ERRORS ];
export const TYPED_ARRAY_KINDS = [ 'Uint8', 'Int8', 'Uint8Clamped', 'Uint16', 'Int16', 'Uint32', 'Int32', 'Float16', 'Float32', 'Float64', 'BigInt64', 'BigUint64' ].map(x => x + 'Array');
const BYTES_PER_ELEMENT = { Uint8Array: 1, Int8Array: 1, Uint8ClampedArray: 1, Uint16Array: 2, Int16Array: 2, Uint32Array: 4, Int32Array: 4, Float16Array: 2, Float32Array: 4, Float64Array: 8, BigInt64Array: 8, BigUint64Array: 8 };

// the prototypes whose [Symbol.toStringTag] is a plain string (Object.prototype.toString
// reads it, so a program can delete or change it); the others have a builtinTag of their own
const TO_STRING_TAGS = [ 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'BigInt', 'Symbol', 'TextEncoder', 'TextDecoder', 'DisposableStack', 'AsyncDisposableStack', 'FinalizationRegistry' ];

// symbol-keyed methods, the same function as a string-keyed one: using reads them (inside a
// builtin, so no member demand), so they are always there
const SYMBOL_METHODS = {
  DisposableStack: [ [ 'dispose', 'dispose' ] ],
  AsyncDisposableStack: [ [ 'asyncDispose', 'disposeAsync' ] ],
  // a __ name is a function of its own (not also a string-keyed method), made when a program
  // names the symbol
  RegExp: [ [ 'match', '__Porffor_regex_symbolMatch' ], [ 'matchAll', '__Porffor_regex_symbolMatchAll' ],
    [ 'search', '__Porffor_regex_symbolSearch' ], [ 'replace', '__Porffor_regex_symbolReplace' ],
    [ 'split', '__Porffor_regex_symbolSplit' ] ]
};

const METHOD_ATTRS = { writable: true, enumerable: false, configurable: true };
const ACCESSOR_ATTRS = { enumerable: false, configurable: true };

// the constructor a prototype belongs to: Map for __Map_prototype (%TypedArray%'s keeps its
// __ prefix: it is no global)
const prototypeCtor = name => name === '__Porffor_TypedArray_prototype' ? '__Porffor_TypedArray' : name.slice(2, name.indexOf('_', 2));

export const prototypeDescriptors = (funcNames, isConstructor) => {
  // each prototype's members, in the order of the functions' names
  const members = new Map();
  for (const x of funcNames) {
    const ind = x.indexOf('_prototype_');
    if (ind === -1 || !x.startsWith('__')) continue;
    const name = x.slice(0, ind + 10);
    if (!members.has(name)) members.set(name, []);
    members.get(name).push(x.slice(ind + 11));
  }

  const out = new Map();
  for (const [ name, keys ] of members) {
    const base = name.slice(2, -'_prototype'.length);
    const isError = base === 'Error' || NATIVE_ERRORS.includes(base);
    const isTypedArrayKind = TYPED_ARRAY_KINDS.includes(base);

    // data properties of the object's own, which a getter of the same name does not replace:
    // the errors' name and message are the prototype's, their getters an error's
    const data = [];
    if (isError) {
      data.push({ key: 'name', kind: 'data', value: base, attrs: { writable: true, enumerable: false, configurable: true } });
      data.push({ key: 'message', kind: 'data', value: '', attrs: { writable: true, enumerable: false, configurable: true } });
    }
    if (base === 'Function') {
      data.push({ key: 'length', kind: 'data', value: 0, attrs: { writable: false, enumerable: false, configurable: true } });
      data.push({ key: 'name', kind: 'data', value: '', attrs: { writable: false, enumerable: false, configurable: true } });
    }
    // per spec Array.prototype is an array exotic object with length 0
    if (base === 'Array') data.push({ key: 'length', kind: 'data', value: 0, attrs: { writable: true, enumerable: false, configurable: false } });


    const ctor = prototypeCtor(name);
    const hasCtor = isConstructor(ctor);
    const own = new Set(data.map(x => x.key));
    if (hasCtor) own.add('constructor');

    const props = [];
    for (const key of keys) {
      const func = name + '_' + key;
      if (key.endsWith('$get')) {
        const prop = key.slice(0, -4);
        // (a typed array kind's are %TypedArray%.prototype's, inherited)
        if (own.has(prop) || isTypedArrayKind) continue;
        props.push({ key: prop, kind: 'accessor', get: func, attrs: ACCESSOR_ATTRS });
      } else if (isTypedArrayKind) {
        // a typed array kind's methods are %TypedArray%.prototype's (inherited), in a program
        // that can reach it; else its own
        props.push({ key, kind: 'method', func, attrs: METHOD_ATTRS, unless: 'typedArrayCtorValue' });
      } else {
        props.push({ key, kind: 'method', func, attrs: METHOD_ATTRS });
      }
    }

    let parent;
    if (name === '__Object_prototype') parent = null;
    // the native errors' prototypes inherit from Error.prototype (a TypeError is an Error)
    if (NATIVE_ERRORS.includes(base)) parent = { object: '__Error_prototype' };
    // the typed arrays' from %TypedArray%.prototype, in a program that can reach it
    if (isTypedArrayKind) parent = { object: '__Porffor_TypedArray_prototype', flag: 'typedArrayCtorValue', otherwise: '__Object_prototype' };

    props.push(...data);
    if (hasCtor) props.push({ key: 'constructor', kind: 'data', func: ctor, attrs: METHOD_ATTRS });
    // a typed array kind's prototype has its element size, as its constructor does
    if (isTypedArrayKind) props.push({ key: 'BYTES_PER_ELEMENT', kind: 'data', value: BYTES_PER_ELEMENT[base], attrs: { writable: false, enumerable: false, configurable: false } });

    for (const [ symbol, method ] of SYMBOL_METHODS[base] ?? []) {
      if (method.startsWith('__')) props.push({ symbol, kind: 'method', func: method, attrs: METHOD_ATTRS, always: true, demand: symbol });
        else props.push({ symbol, kind: 'method', func: name + '_' + method, attrs: METHOD_ATTRS, always: true });
    }
    // a typed array's tag is a getter on %TypedArray%.prototype; a kind's own too, in a program
    // whose kinds do not inherit from it
    if (name === '__Porffor_TypedArray_prototype' || isTypedArrayKind)
      props.push({ symbol: 'toStringTag', kind: 'accessor', get: '__Porffor_typedArray_toStringTag', attrs: ACCESSOR_ATTRS, demand: 'toStringTag', unless: isTypedArrayKind ? 'typedArrayCtorValue' : undefined });
    if (TO_STRING_TAGS.includes(base))
      props.push({ symbol: 'toStringTag', kind: 'data', value: base, attrs: { writable: false, enumerable: false, configurable: true }, demand: 'toStringTag' });

    out.set(name, { name, ctor: hasCtor ? ctor : null, parent, props });
  }

  return out;
};

// the namespaces whose [Symbol.toStringTag] is a plain string
export const NAMESPACE_TO_STRING_TAGS = [ 'Math', 'JSON', 'Reflect', 'Atomics' ];

// the builtins by the property they implement, for codegen's typed paths (which call a type's
// own without reading its prototype): a type's methods and getters (__Map_prototype_get is
// get for a Map), each prototype object's builder (#get___Map_prototype) and the constructors'
// statics (__Object_keys is keys, read off Object used as a value)
export const memberIndex = (funcNames, isBuiltin) => {
  const methods = new Map(), getters = new Map(), prototypeObjects = new Map(), statics = new Map();
  const add = (map, key, x) => {
    const entries = map.get(key);
    if (entries) entries.push(x);
      else map.set(key, [ x ]);
  };

  for (const x of funcNames) {
    const ind = x.indexOf('_prototype_');
    if (x.startsWith('__') && ind !== -1) {
      const name = x.slice(ind + '_prototype_'.length);
      if (name.endsWith('$get')) add(getters, name.slice(0, -'$get'.length), x);
        else add(methods, name, x);
    } else if (x.startsWith('#get___') && x.endsWith('_prototype')) {
      prototypeObjects.set(x.slice(7, -'_prototype'.length), x);
    } else {
      const found = /^__([A-Z][A-Za-z0-9]*)_([a-zA-Z][a-zA-Z0-9]*)$/.exec(x);
      if (found && found[2] !== 'prototype' && isBuiltin(found[1])) add(statics, found[2], [ found[1], x ]);
    }
  }

  return { methods, getters, prototypeObjects, statics };
};
