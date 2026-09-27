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
// with attrs { writable, enumerable, configurable } (an accessor has no writable). A method or
// accessor is on the object only when its function is in the program (or the whole object is
// asked for); demand: only in a program that reads a property of that name; always: whenever
// the object is made.

export const NATIVE_ERRORS = [ 'AggregateError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError', 'SuppressedError' ];
export const TYPED_ARRAY_KINDS = [ 'Uint8', 'Int8', 'Uint8Clamped', 'Uint16', 'Int16', 'Uint32', 'Int32', 'Float32', 'Float64', 'BigInt64', 'BigUint64' ].map(x => x + 'Array');

// the prototypes whose [Symbol.toStringTag] is a plain string (Object.prototype.toString
// reads it, so a program can delete or change it); the others have a builtinTag of their own
const TO_STRING_TAGS = [ 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'BigInt', 'Symbol', 'TextEncoder', 'TextDecoder', 'DisposableStack', 'AsyncDisposableStack' ];

// symbol-keyed methods, the same function as a string-keyed one: using reads them (inside a
// builtin, so no member demand), so they are always there
const SYMBOL_METHODS = {
  DisposableStack: [ [ 'dispose', 'dispose' ] ],
  AsyncDisposableStack: [ [ 'asyncDispose', 'disposeAsync' ] ]
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

    for (const [ symbol, method ] of SYMBOL_METHODS[base] ?? [])
      props.push({ symbol, kind: 'method', func: name + '_' + method, attrs: METHOD_ATTRS, always: true });
    if (TO_STRING_TAGS.includes(base))
      props.push({ symbol: 'toStringTag', kind: 'data', value: base, attrs: { writable: false, enumerable: false, configurable: true }, demand: 'toStringTag' });

    out.set(name, { name, ctor: hasCtor ? ctor : null, parent, props });
  }

  return out;
};

// the namespaces whose [Symbol.toStringTag] is a plain string
export const NAMESPACE_TO_STRING_TAGS = [ 'Math', 'JSON', 'Reflect', 'Atomics' ];
