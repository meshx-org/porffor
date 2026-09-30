import * as PrecompiledBuiltins from './builtins_precompiled.js';
import { TYPES, TYPE_NAMES } from './types.js';
import { Bin, Un, T, K, Const, JvConst, Box, JvType, JvNum, JvPtr, JvIsNum, Select, Convert, Reinterpret, CONVERT_SIGNED, N_KIND, N_TYPE, N_A, N_B, Local, Assign, Call, CallDynamic, If, TypeSwitch, Return, RawC, BlockStmt } from './ir.js';
import './prefs.js';
import { prototypeDescriptors, NAMESPACE_TO_STRING_TAGS, TYPED_ARRAY_KINDS } from './builtinDescriptors.js';

const f64FromBytes = bytes => {
  const floats = new Float64Array(1);
  const raw = new Uint8Array(floats.buffer);
  for (let i = 0; i < 8; i++) raw[i] = bytes[i];
  return floats[0];
};

export const BuiltinVars = ({ builtinFuncs }) => {
  const _ = Object.create(null);
  _.undefined = () => JvConst(TYPES.undefined, 0);
  _.undefined.type = TYPES.undefined;

  _.null = () => JvConst(TYPES.object, 0);
  _.null.type = TYPES.object;

  _.NaN = () => Box(Const(T.f64, NaN), Const(T.i32, TYPES.number));
  _.Infinity = () => Box(Const(T.f64, Infinity), Const(T.i32, TYPES.number));

  for (const x in TYPES) {
   _['__Porffor_TYPES_' + x] = () => Const(T.i32, TYPES[x]);
  }

  _.__performance_timeOrigin = () => Box(Call('porf_performance_time_origin', [], T.f64), Const(T.i32, TYPES.number));
  _.__performance_timeOrigin.type = TYPES.number;

  // builtin objects
  const makePrefix = name => (name.startsWith('__') ? '' : '__') + name + '_';

  // a well-known symbol's value (Symbol.toStringTag): a global each
  const wellKnownSymbol = (includeBuiltin, global, makeString, x) => {
    includeBuiltin('Symbol');
    return global(`#wellknown_${x}`, T.jsval, Call('Symbol', [ makeString(`Symbol.${x}`) ], T.jsval));
  };

  // the namespace objects made (Math, JSON, Reflect): globalThis has them
  const namespaces = [];
  const object = (name, props) => {
    const prefix = name === 'globalThis' ? '' : makePrefix(name);
    const lazyKind = name === 'globalThis' ? 'global' : null;

    const existingFunc = builtinFuncs[name];
    if (!existingFunc && !name.startsWith('__') && name !== 'globalThis') namespaces.push(name);

    const getName = '#get_' + name;
    builtinFuncs[getName] = existingFunc ? {
      params: [],
      retType: T.ptr,
      returnType: TYPES.function,
      body: ({ funcRefPtr }) => [
        Return(globalThis.precompile ? Const(T.ptr, 0) : funcRefPtr(name))
      ]
    } : {
      params: [],
      localNames: [ 'obj' ],
      localTypes: [ T.jsval ],
      retType: T.ptr,
      returnType: TYPES.object,
      body: ({ includeBuiltin, funcRefPtr, global, makeString, globalThisUserSync, whenFact }) => {
        if (globalThis.precompile) return [ Return(Const(T.ptr, 0)) ];

        includeBuiltin('__Porffor_object_new');

        const getPtr = global(`getptr_${name}`, T.ptr);
        const obj = Local('obj', T.jsval);

        // globalThis: user top-level decls are own props, re-synced from bindings on access (globalThisUserSync)
        const sync = [];
        if (name === 'globalThis') globalThisUserSync(Box(getPtr, Const(T.i32, TYPES.object)), sync);

        const out = [
          If(getPtr, [ BlockStmt(sync), Return(getPtr) ]),
          Assign(obj, Call('__Porffor_object_new', [ Const(T.i32, Object.keys(props).length) ])),
          Assign(getPtr, JvPtr(obj))
        ];

        const funcValue = name => Box(funcRefPtr(name), Const(T.i32, TYPES.function));
        const propValue = (key, d) => {
          if (key === name) return obj;
          if (key in builtinFuncs) return funcValue(key);
          if (key === 'undefined') return JvConst(TYPES.undefined, 0);
          if (key === 'null') return JvConst(TYPES.object, 0);
          if (key === 'NaN') return Box(Const(T.f64, NaN), Const(T.i32, TYPES.number));
          if (key === 'Infinity') return Box(Const(T.f64, Infinity), Const(T.i32, TYPES.number));
          const getter = '#get_' + key;
          if (getter in builtinFuncs) {
            includeBuiltin(getter);
            return Box(Call(getter, [], T.ptr), Const(T.i32, _[key]?.type ?? TYPES.object));
          }
          if ('value' in d) {
            const value = d.value;
            if (typeof value === 'function') return value(_, { includeBuiltin, funcRefPtr, makeString });
            if (typeof value === 'number') return Box(Const(T.f64, value), Const(T.i32, TYPES.number));
            if (typeof value === 'string') return makeString(value);
            if (value === null) return JvConst(TYPES.object, 0);
          }

          throw new Error(`unsupported builtin object property ${name}.${key}`);
        };

        includeBuiltin('__Porffor_object_fastAdd');
        const emitProp = (out, x, d) => {
          const key = prefix + x;
          const value = propValue(key, d);

          if (x === '__proto__') {
            includeBuiltin('__Porffor_object_setPrototype');
            out.push(Call('__Porffor_object_setPrototype', [ obj, value ], T.none));
            return;
          }

          let flags = 0b0000;
          if (d.configurable) flags |= 0b0010;
          if (d.enumerable) flags |= 0b0100;
          if (d.writable) flags |= 0b1000;

          out.push(Call('__Porffor_object_fastAdd', [ obj, makeString(x), value, Const(T.i32, flags) ], T.none));
        };

        if (lazyKind && Prefs.lazyObjects) {
          // globalThis: entries only for the globals in the program (each in its place)
          const keys = Object.keys(props);
          const slots = keys.map(() => null);
          const adds = [];
          keys.forEach((x, i) => {
            const key = prefix + x;
            const emit = () => {
              const one = [];
              emitProp(one, x, props[x]);
              slots[i] = BlockStmt(one);
              adds.length = 0;
              for (const y of slots) if (y) adds.push(y);
            };
            // a global in the program, or read by name (globalThis.Math: it brings it in)
            if (key in builtinFuncs) whenFact([ [ 'hasFunc', key ], [ 'member', x ] ], emit);
              else if (('#get_' + key) in builtinFuncs) whenFact([ [ 'hasFunc', '#get_' + key ], [ 'member', x ] ], emit);
              else emit();
          });
          out.push(BlockStmt(adds));
        } else {
          for (const x in props) emitProp(out, x, props[x]);
        }

        // only a program that names .toStringTag can read one
        if (NAMESPACE_TO_STRING_TAGS.includes(name)) {
          const tagAdd = [];
          whenFact([ [ 'member', 'toStringTag' ] ], () => {
            tagAdd.push(Call('__Porffor_object_fastAdd', [ obj, wellKnownSymbol(includeBuiltin, global, makeString, 'toStringTag'), makeString(name), Const(T.i32, 0b0010) ], T.none));
          });
          out.push(BlockStmt(tagAdd));
        }

        out.push(BlockStmt(sync));
        out.push(Return(getPtr));
        return out;
      }
    };

   _[name] = (_scope, { includeBuiltin }) => {
      includeBuiltin('#get_' + name);
      return Box(Call('#get_' + name, [], T.ptr), Const(T.i32, existingFunc ? TYPES.function : TYPES.object));
    };
    _[name].type = existingFunc ? TYPES.function : TYPES.object;

    for (const x in props) {
      const d = props[x];
      const k = prefix + x;

      if ('value' in d && !(k in builtinFuncs) && !(k in _)) {
        if (Array.isArray(d.value) || typeof d.value === 'function') {
         _[k] = d.value;
          continue;
        }

        if (typeof d.value === 'number') {
         _[k] = () => Box(Const(T.f64, d.value), Const(T.i32, TYPES.number));
         _[k].type = TYPES.number;
          continue;
        }

        if (typeof d.value === 'string') {
         _[k] = (_scope, { makeString }) => makeString(d.value);
         _[k].type = TYPES.bytestring;
          continue;
        }

        if (d.value === null) {
         _[k] = _.null;
          continue;
        }

        throw new Error(`unsupported value type (${typeof d.value})`);
      }
    }
  };

  const props = (base, vals) => {
    const out = {};

    if (Array.isArray(vals)) {
      for (const x of vals) {
        out[x] = {
          ...base
        };
      }
    } else for (const x in vals) {
      out[x] = {
        ...base,
        value: vals[x]
      };
    }

    return out;
  };

  const builtinFuncKeys = Object.keys(builtinFuncs);
  const autoFuncKeys = name => {
    const prefix = makePrefix(name);
    return builtinFuncKeys.filter(x => x.startsWith(prefix)).map(x => x.slice(prefix.length)).filter(x => !x.startsWith('prototype_'));
  };
  const autoFuncs = name => ({
    ...props({
      writable: true,
      enumerable: false,
      configurable: true
    }, autoFuncKeys(name)),
    ...(_[`__${name}_prototype`] ? {
      prototype: {
        writable: false,
        enumerable: false,
        configurable: false
      }
    } : {})
  });

  object('Math', {
    ...props({
      writable: false,
      enumerable: false,
      configurable: false
    }, {
      E: Math.E,
      LN10: Math.LN10,
      LN2: Math.LN2,
      LOG10E: Math.LOG10E,
      LOG2E: Math.LOG2E,
      PI: Math.PI,
      SQRT1_2: Math.SQRT1_2,
      SQRT2: Math.SQRT2,

      // https://github.com/rwaldron/proposal-math-extensions/issues/10
      RAD_PER_DEG: Math.PI / 180,
      DEG_PER_RAD: 180 / Math.PI
    }),

    ...autoFuncs('Math')
  });

  const typedArrayBytesPerElement = {
    Uint8Array: 1,
    Int8Array: 1,
    Uint8ClampedArray: 1,
    Uint16Array: 2,
    Int16Array: 2,
    Uint32Array: 4,
    Int32Array: 4,
    Float16Array: 2,
    Float32Array: 4,
    Float64Array: 8,
    BigInt64Array: 8,
    BigUint64Array: 8
  };

  const wellKnownSymbols = [
    'asyncIterator', 'hasInstance',
    'isConcatSpreadable', 'iterator',
    'match', 'matchAll', 'replace',
    'search', 'species', 'split',
    'toPrimitive', 'toStringTag', 'unscopables',
    'dispose', 'asyncDispose'
  ];

  const wellKnownSymbolProps = props({
    writable: false,
    enumerable: false,
    configurable: false
  }, Object.fromEntries(wellKnownSymbols.map(x => [x, (_scope, { includeBuiltin, makeString, global }) => {
    includeBuiltin('Symbol');
    return global(`#wellknown_${x}`, T.jsval, Call('Symbol', [ makeString(`Symbol.${x}`) ], T.jsval));
  }])));

  for (const x of wellKnownSymbols) {
    wellKnownSymbolProps[x].value.type = TYPES.symbol;
  }

  const attrFlags = a => (a.configurable ? 0b0010 : 0) | (a.enumerable ? 0b0100 : 0) | (a.writable ? 0b1000 : 0);

  // a prototype object, built from its descriptor (builtinDescriptors.js). Its properties go
  // on when the program is known: a method or accessor only when its function is in the
  // program, or all of them when the program reads the object itself (X.prototype)
  const prototypeObject = desc => {
    const { name } = desc;
    const getName = '#get_' + name;
    builtinFuncs[getName] = {
      params: [],
      localNames: [ 'obj' ],
      localTypes: [ T.jsval ],
      retType: T.ptr,
      returnType: TYPES.object,
      body: ({ includeBuiltin, funcRefPtr, global, makeString, whenFact }) => {
        if (globalThis.precompile) return [ Return(Const(T.ptr, 0)) ];

        includeBuiltin('__Porffor_object_new');
        const getPtr = global(`getptr_${name}`, T.ptr);
        const obj = Local('obj', T.jsval);
        const out = [
          If(getPtr, [ Return(getPtr) ]),
          Assign(obj, Call('__Porffor_object_new', [ Const(T.i32, desc.props.length) ])),
          Assign(getPtr, JvPtr(obj))
        ];

        const funcValue = f => Box(funcRefPtr(f), Const(T.i32, TYPES.function));
        const objectValue = o => {
          includeBuiltin('#get_' + o);
          return Box(Call('#get_' + o, [], T.ptr), Const(T.i32, TYPES.object));
        };
        const keyValue = p => p.symbol ? wellKnownSymbol(includeBuiltin, global, makeString, p.symbol) : makeString(p.key);
        const dataValue = p => p.func ? funcValue(p.func)
          : typeof p.value === 'number' ? Box(Const(T.f64, p.value), Const(T.i32, TYPES.number))
          : typeof p.value === 'string' ? makeString(p.value)
          : JvConst(TYPES.object, 0);

        // each part in its place, however the facts come: the parent, then the properties
        const slots = [ null, ...desc.props.map(() => null) ];
        const adds = [];
        const place = (i, node) => {
          slots[i] = node;
          adds.length = 0;
          for (const x of slots) if (x) adds.push(x);
        };

        // its parent (a new object's is Object.prototype already)
        const setParent = parent => () => {
          includeBuiltin('__Porffor_object_setPrototype');
          place(0, Call('__Porffor_object_setPrototype', [ obj, parent === null ? JvConst(TYPES.object, 0) : objectValue(parent) ], T.none));
        };
        const parent = desc.parent;
        if (parent?.flag) whenFact([ [ 'program', parent.flag ] ], setParent(parent.object), parent.otherwise ? setParent(parent.otherwise) : null);
          else if (parent !== undefined) setParent(parent === null ? null : parent.object)();

        desc.props.forEach((p, i) => {
          const emit = () => {
            if (p.kind === 'accessor') {
              includeBuiltin('__Porffor_object_fastAddAccessor');
              place(i + 1, Call('__Porffor_object_fastAddAccessor', [ obj, keyValue(p), funcValue(p.get), Const(T.i32, attrFlags(p.attrs)) ], T.none));
            } else {
              includeBuiltin('__Porffor_object_fastAdd');
              place(i + 1, Call('__Porffor_object_fastAdd', [ obj, keyValue(p), p.kind === 'method' ? funcValue(p.func) : dataValue(p), Const(T.i32, attrFlags(p.attrs)) ], T.none));
            }
          };

          // a method or accessor once its function is in the program, or the object is read
          // whole (X.prototype: then it brings the function in)
          const f = p.func ?? p.get;
          const gated = f && !p.always && Prefs.lazyObjects ? () => whenFact([ [ 'hasFunc', f ], [ 'full', getName ] ], emit) : emit;
          const unlessGated = p.unless ? () => whenFact([ [ 'program', p.unless ] ], () => {}, gated) : gated;
          if (p.demand) whenFact([ [ 'member', p.demand ] ], unlessGated);
            else unlessGated();
        });

        out.push(BlockStmt(adds));
        out.push(Return(getPtr));
        return out;
      }
    };

    // the object read as a value (X.prototype): all of it
    _[name] = (_scope, { includeBuiltin, fact }) => {
      fullPrototypes.add(getName);
      fact('full', getName);
      includeBuiltin(getName);
      return Box(Call(getName, [], T.ptr), Const(T.i32, TYPES.object));
    };
    _[name].type = TYPES.object;

    // its data properties read statically (TypeError.prototype.name, Map.prototype.constructor)
    for (const p of desc.props) {
      if (p.kind !== 'data' || p.symbol) continue;
      const k = name + '_' + p.key;
      if (k in builtinFuncs || k in _) continue;
      if (p.func) {
        _[k] = (_scope, { funcRefPtr }) => Box(funcRefPtr(p.func), Const(T.i32, TYPES.function));
        _[k].type = TYPES.function;
      } else if (typeof p.value === 'number') {
        _[k] = () => Box(Const(T.f64, p.value), Const(T.i32, TYPES.number));
        _[k].type = TYPES.number;
      } else if (typeof p.value === 'string') {
        _[k] = (_scope, { makeString }) => makeString(p.value);
        _[k].type = TYPES.bytestring;
      }
    }
  };

  for (const desc of prototypeDescriptors(builtinFuncKeys, x => !!builtinFuncs[x]?.constr).values()) prototypeObject(desc);


  object('Number', {
    ...props({
      writable: false,
      enumerable: false,
      configurable: false
    }, {
      NaN: NaN,
      POSITIVE_INFINITY: Infinity,
      NEGATIVE_INFINITY: -Infinity,
      MAX_VALUE: f64FromBytes([ 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xef, 0x7f ]),
      MIN_VALUE: f64FromBytes([ 1, 0, 0, 0, 0, 0, 0, 0 ]),
      MAX_SAFE_INTEGER: 9007199254740991,
      MIN_SAFE_INTEGER: -9007199254740991,
      EPSILON: f64FromBytes([ 0, 0, 0, 0, 0, 0, 0xb0, 0x3c ])
    }),

    ...autoFuncs('Number')
  });

  // these technically not spec compliant as it should be classes or non-enumerable but eh
  object('navigator', {
    ...props({
      writable: false,
      enumerable: true,
      configurable: false
    }, {
      userAgent: `Porffor/${globalThis.version}`
    })
  });

  for (const x of [
    'console',
    'performance',
    'crypto',
  ]) {
    object(x, props({
      writable: true,
      enumerable: true,
      configurable: true
    }, autoFuncKeys(x).slice(0, 12)));
  }

  for (const x of [ 'Array', 'ArrayBuffer', 'Atomics', 'Date', 'Error', 'JSON', 'Object', 'Promise', 'Reflect', 'String', 'Symbol', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'SharedArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'AggregateError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError', 'SuppressedError', 'DisposableStack', 'AsyncDisposableStack', 'Function', 'Map', 'RegExp', 'Set', 'WeakMap', 'WeakRef', 'WeakSet', 'TextEncoder', 'TextDecoder', 'Iterator' ]) {
    object(x, {
      ...(typedArrayBytesPerElement[x] == null ? {} : props({
        writable: false,
        enumerable: false,
        configurable: false
      }, {
        BYTES_PER_ELEMENT: typedArrayBytesPerElement[x]
      })),
      ...(x === 'Symbol' ? wellKnownSymbolProps : {}),
      ...autoFuncs(x)
    });
  }

  const enumerableGlobals = [ 'atob', 'btoa', 'performance', 'navigator', 'crypto' ];
  object('globalThis', {
    // 19.1 Value Properties of the Global Object
    // https://tc39.es/ecma262/#sec-value-properties-of-the-global-object
    // 19.1.1 globalThis
    globalThis: {
      writable: true,
      enumerable: false,
      configurable: true
    },

    // 19.1.2 Infinity
    // 19.1.3 NaN
    // 19.1.4 undefined
    ...props({
      writable: false,
      enumerable: false,
      configurable: false
    }, [ 'Infinity', 'NaN', 'undefined' ]),

    // 19.2 Function Properties of the Global Object
    // https://tc39.es/ecma262/#sec-function-properties-of-the-global-object
    // 19.3 Constructor Properties of the Global Object
    // https://tc39.es/ecma262/#sec-constructor-properties-of-the-global-object
    ...props({
      writable: true,
      enumerable: false,
      configurable: true
    }, builtinFuncKeys.filter(x => !x.startsWith('__') && !enumerableGlobals.includes(x) && !x.startsWith('f64') && !x.startsWith('i32'))),

    ...props({
      writable: true,
      enumerable: true,
      configurable: true
    }, enumerableGlobals),

    // the namespaces (Math, JSON, Reflect, Atomics)
    ...props({
      writable: true,
      enumerable: false,
      configurable: true
    }, namespaces.filter(x => !enumerableGlobals.includes(x)))
  });

  return _;
};

export const fullPrototypes = new Set();

export const BuiltinFuncs = () => {
  const _ = Object.create(null);
  // libm-backed Math: jsval params so public methods do ToNumber, boxed returns for builtin
  // callers. A number argument skips the ToNumber call
  const nativeMathArg = name => Select(JvIsNum(Local(name, T.jsval)), JvNum(Local(name, T.jsval)),
    JvNum(Call('__ecma262_ToNumber', [ Local(name, T.jsval) ])));
  const nativeMathUnary = name => {
    _[`__Math_${name}`] = {
      params: [ { name: 'x', type: T.jsval } ],
      localNames: [ 'n' ],
      localTypes: [ T.f64 ],
      retType: T.jsval,
      returnType: TYPES.number,
      body: [
        Assign(Local('n', T.f64), nativeMathArg('x')),
        RawC(`return porf_box_num(${name}(n));`, false)
      ]
    };
  };

  for (const name of [
    'exp', 'log2', 'log', 'log10', 'expm1', 'log1p', 'sqrt', 'cbrt',
    'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh',
    'atanh', 'asin', 'acos', 'atan'
  ]) nativeMathUnary(name);

  _.__Math_atan2 = {
    params: [ { name: 'y', type: T.jsval }, { name: 'x', type: T.jsval } ],
    localNames: [ 'yNum', 'xNum' ],
    localTypes: [ T.f64, T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('yNum', T.f64), nativeMathArg('y')),
      Assign(Local('xNum', T.f64), nativeMathArg('x')),
      RawC('return porf_box_num(atan2(yNum, xNum));', false)
    ]
  };

  // C pow() returns 1 where JS requires NaN
  _.__Math_pow = {
    params: [ { name: 'base', type: T.jsval }, { name: 'exponent', type: T.jsval } ],
    localNames: [ 'baseNum', 'exponentNum' ],
    localTypes: [ T.f64, T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('baseNum', T.f64), nativeMathArg('base')),
      Assign(Local('exponentNum', T.f64), nativeMathArg('exponent')),
      RawC(`if (exponentNum != exponentNum) return porf_box_num(NAN);
if ((baseNum == 1.0 || baseNum == -1.0) && isinf(exponentNum)) return porf_box_num(NAN);
return porf_box_num(pow(baseNum, exponentNum));`, false)
    ]
  };

  for (const [ name, op ] of [
    [ 'abs', 'abs' ],
    [ 'floor', 'floor' ],
    [ 'ceil', 'ceil' ],
    [ 'round', 'nearest' ],
    [ 'trunc', 'trunc' ]
  ]) {
   _[`__Math_${name}`] = {
      params: [ { name: 'x', type: T.jsval } ],
      localNames: [ 'n' ],
      localTypes: [ T.f64 ],
      retType: T.jsval,
      returnType: TYPES.number,
      body: [
        Assign(Local('n', T.f64), nativeMathArg('x')),
        Return(Box(Un(op, T.f64, Local('n', T.f64)), Const(T.i32, TYPES.number)))
      ]
    };
  }

  _.__Math_sign = {
    params: [ { name: 'x', type: T.jsval } ],
    localNames: [ 'n' ],
    localTypes: [ T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('n', T.f64), nativeMathArg('x')),
      RawC('if (n != n || n == 0.0) return porf_box_num(n);\nreturn porf_box_num(copysign(1.0, n));', false)
    ]
  };

  _.__Math_clz32 = {
    params: [ { name: 'x', type: T.jsval } ],
    localNames: [ 'n' ],
    localTypes: [ T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('n', T.f64), nativeMathArg('x')),
      RawC('return porf_box_num((f64)porf_clz32(porf_to_u32(n)));', false)
    ]
  };

  // binary16's rounding (Math.f16round): through porf_f64_to_f16, back
  _.__Math_f16round = {
    params: [ { name: 'x', type: T.jsval } ],
    localNames: [ 'n' ],
    localTypes: [ T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('n', T.f64), nativeMathArg('x')),
      RawC('return porf_box_num(porf_f16_to_f64(porf_f64_to_f16(n)));', false)
    ]
  };

  _.__Math_fround = {
    params: [ { name: 'x', type: T.jsval } ],
    localNames: [ 'n' ],
    localTypes: [ T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('n', T.f64), nativeMathArg('x')),
      RawC('return porf_box_num((f64)(f32)n);', false)
    ]
  };

  _.__Math_imul = {
    params: [ { name: 'x', type: T.jsval }, { name: 'y', type: T.jsval } ],
    localNames: [ 'xNum', 'yNum' ],
    localTypes: [ T.f64, T.f64 ],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [
      Assign(Local('xNum', T.f64), nativeMathArg('x')),
      Assign(Local('yNum', T.f64), nativeMathArg('y')),
      RawC('return porf_box_num((f64)(i32)(porf_to_u32(xNum) * porf_to_u32(yNum)));', false)
    ]
  };

  _.__Porffor_prng = {
    params: [],
    localNames: [ 's1', 's0', 'result' ],
    localTypes: [ T.u64, T.u64, T.u64 ],
    retType: T.u64,
    body: ({ global }) => {
      const state0 = global('state0', T.u64);
      const state1 = global('state1', T.u64);
      const s1 = Local('s1', T.u64);
      const s0 = Local('s0', T.u64);
      const result = Local('result', T.u64);

      return [
        // seeded on first use from the platform's random bytes, so every instance draws
        // its own sequence; an all-zero seed (the one state xorshift cannot leave) falls
        // back to a constant
        If(Bin('==', T.u64, Bin('|', T.u64, state0, state1), Const(T.u64, 0)), [
          Assign(state0, Call('porf_random_u64', [], T.u64)),
          Assign(state1, Call('porf_random_u64', [], T.u64)),
          If(Bin('==', T.u64, Bin('|', T.u64, state0, state1), Const(T.u64, 0)), [
            Assign(state0, Const(T.u64, 0x7b1dcdaf)),
            Assign(state1, Const(T.u64, 0x21b965f5))
          ])
        ]),
        Assign(s1, state1),
        Assign(s0, state0),
        Assign(result, Bin('+', T.u64, s0, s1)),
        Assign(s1, Bin('^', T.u64, s1, s0)),
        Assign(state0, Bin('^', T.u64,
          Bin('^', T.u64, Bin('rotl', T.u64, s0, Const(T.u64, 24)), s1),
          Bin('<<', T.u64, s1, Const(T.u64, 16)))),
        Assign(state1, Bin('rotl', T.u64, s1, Const(T.u64, 37))),
        Return(result)
      ];
    }
  };

  _.__Math_random = {
    params: [],
    retType: T.f64,
    returnType: TYPES.number,
    body: [ Return(Bin('*', T.f64, Convert(T.f64, Bin('>>', T.u64, Call('__Porffor_prng', [], T.u64), Const(T.u64, 11)), 0), Const(T.f64, 2 ** -53))) ]
  };

  // round(x * 10^k) as decimal digits, exactly, for toFixed, toPrecision and
  // toExponential: porf_round_scaled in the C runtime
  _.__Porffor_number_roundScaled = {
    params: [ { name: 'x', type: T.jsval }, { name: 'k', type: T.i32 } ],
    retType: T.jsval,
    returnType: TYPES.bytestring,
    body: [ Return(Call('porf_round_scaled', [ JvNum(Local('x', T.jsval)), Local('k', T.i32) ], T.jsval)) ]
  };

  // toExponential() with no digit count: porf_num_to_exp in the C runtime
  _.__Porffor_number_toExponentialShortest = {
    params: [ { name: 'x', type: T.jsval } ],
    retType: T.jsval,
    returnType: TYPES.bytestring,
    body: [ Return(Call('porf_num_to_exp', [ JvNum(Local('x', T.jsval)) ], T.jsval)) ]
  };

  _.__performance_now = {
    params: [],
    retType: T.jsval,
    returnType: TYPES.number,
    body: [ Return(Box(Call('porf_performance_now', [], T.f64), Const(T.i32, TYPES.number))) ]
  };

  _.__Porffor_typeName = {
    params: [ { name: 'type', type: T.i32 } ],
    retType: T.jsval,
    returnType: TYPES.bytestring,
    body: ({ makeString }) => [
      TypeSwitch(Local('type', T.i32),
        Object.entries(TYPE_NAMES).map(([ type, name ]) => [ [ +type ], [ Return(makeString(name)) ] ]),
        [ Return(makeString('unknown')) ])
    ]
  };

  _.__Porffor_bytestringToString = {
    params: [ { name: 'src', type: T.ptr } ],
    retType: T.jsval,
    returnType: TYPES.string,
    body: [ RawC(`u32 len = *(u32*)(MEM + src);
u32 dst = porf_alloc(6u + len * 2u, ${TYPES.string});
*(u32*)(MEM + dst) = len;
porf_simd_widen(dst, 0, src, 0, (i32)len);
return porf_box((f64)dst, ${TYPES.string});`, false) ]
  };

  // Function.prototype.length/flags/name from render-emitted tables (porf_fnlen/fnflags/fnname),
  // indexed by fn index: `*(u32*)(MEM + (u32)fn.val)`, same decode as porf_call_dynamic
  const lutFn = (returnType, body) => ({ params: [ { name: 'fn', type: T.jsval } ], retType: T.jsval, returnType, body: [ RawC(body, false) ] });
  const lutRead = table => `${table}[*(u32*)(MEM + (u32)fn.val)]`;

  _.__Porffor_funcLut_length = lutFn(TYPES.number, `return porf_box_num((f64)${lutRead('porf_fnlen')});`);

  _.__Porffor_funcLut_flags = lutFn(TYPES.number, `return porf_box_num((f64)((${lutRead('porf_fnflags')} >> 3) & 3));`);
  // what kind of function the program's own is: 1 async, 2 generator, 4 async generator, 0 any
  // other and every builtin (ir.js FN_*; render.js porf_fnkind)
  _.__Porffor_funcLut_kind = lutFn(TYPES.number, `return porf_box_num((f64)${lutRead('porf_fnkind')});`);
  // a class's constructor (its prototype is read-only)
  _.__Porffor_funcLut_isClass = lutFn(TYPES.boolean, `return porf_box((f64)((${lutRead('porf_fnflags')} >> 7) & 1), ${TYPES.boolean});`);

  _.__Porffor_funcLut_name = lutFn(TYPES.bytestring, `return porf_box((f64)${lutRead('porf_fnname')}, ${TYPES.bytestring});`);

  _.__Porffor_number_getExponent = {
    params: [ { name: 'x', type: T.f64 } ],
    retType: T.i32,
    returnType: TYPES.number,
    body: [ Return(Bin('-', T.i32, Convert(T.i32, Bin('&', T.u64, Bin('>>', T.u64, Reinterpret(T.u64, Local('x', T.f64)), Const(T.u64, 52)), Const(T.u64, 0x7ff))), Const(T.i32, 1023))) ]
  };

  _.__Porffor_bigint_fromU64 = {
    params: [ { name: 'x', type: T.i64 } ],
    retType: T.jsval,
    returnType: TYPES.bigint,
    body: [ RawC(`u64 ux = (u64)x;
u32 hi = (u32)(ux >> 32);
u32 lo = (u32)ux;
if (hi < 0x200u) return porf_box((f64)ux, ${TYPES.bigint}); // inline below 2^41
u32 ptr = porf_alloc(16, ${TYPES.bigint});
*(u8*)(MEM + ptr) = 0;
*(u16*)(MEM + ptr + 2) = 2;
*(u32*)(MEM + ptr + 4) = hi;
*(u32*)(MEM + ptr + 8) = lo;
return porf_box((f64)ptr + 2251799813685248.0, ${TYPES.bigint});`, false) ]
  };

  _.__Porffor_bigint_fromS64 = {
    params: [ { name: 'x', type: T.i64 } ],
    retType: T.jsval,
    returnType: TYPES.bigint,
    body: [ RawC(`i64 signBits = x >> 63;
u64 ax = (u64)((x ^ signBits) - signBits);
u32 hi = (u32)(ax >> 32);
u32 lo = (u32)ax;
if (hi < 0x200u) return porf_box((f64)x, ${TYPES.bigint}); // inline below 2^41
u32 ptr = porf_alloc(16, ${TYPES.bigint});
*(u8*)(MEM + ptr) = x != (i64)ax;
*(u16*)(MEM + ptr + 2) = 2;
*(u32*)(MEM + ptr + 4) = hi;
*(u32*)(MEM + ptr + 8) = lo;
return porf_box((f64)ptr + 2251799813685248.0, ${TYPES.bigint});`, false) ]
  };

  _.__Porffor_bigint_toI64 = {
    params: [ { name: 'x', type: T.jsval } ],
    retType: T.i64,
    returnType: TYPES.bigint,
    body: [ RawC(`f64 d = x.val;
if (fabs(d) < 2251799813685248.0) return (i64)d;
u32 ptr = (u32)(d - 2251799813685248.0);
i64 sign = *(u8*)(MEM + ptr) ? -1 : 1;
u32 digits = *(u16*)(MEM + ptr + 2);
if (digits == 0) return 0;
if (digits == 1) return sign * (i64)(u64)*(u32*)(MEM + ptr + 4);
if (digits > 2) ptr += (digits - 2) * 4;
return sign * (i64)((((u64)*(u32*)(MEM + ptr + 4)) << 32) + (u64)*(u32*)(MEM + ptr + 8));`, false) ]
  };

  // BigInt: the arithmetic is the C runtime's (render.js, porf_bigint_*); these reach it
  // from the TypeScript builtins
  _.__Porffor_bigint_parse = {
    params: [ { name: 's', type: T.jsval }, { name: 'literal', type: T.i32 } ],
    retType: T.jsval,
    returnTypes: [ TYPES.bigint, TYPES.undefined ],
    body: [ RawC('return porf_bigint_parse(s, literal);', false) ]
  };

  _.__Porffor_bigint_toRadixString = {
    params: [ { name: 'x', type: T.jsval }, { name: 'radix', type: T.i32 } ],
    retType: T.jsval,
    returnType: TYPES.bytestring,
    body: [ RawC('return porf_bigint_to_str(x, radix);', false) ]
  };

  _.__Porffor_bigint_toNumber = {
    params: [ { name: 'x', type: T.jsval } ],
    retType: T.f64,
    returnType: TYPES.number,
    body: [ RawC('return porf_bigint_to_f64(x);', false) ]
  };

  _.__Porffor_bigint_fromIntegral = {
    params: [ { name: 'x', type: T.f64 } ],
    retType: T.jsval,
    returnType: TYPES.bigint,
    body: [ RawC('return porf_bigint_from_f64(x);', false) ]
  };

  _.__Porffor_bigint_asN = {
    params: [ { name: 'x', type: T.jsval }, { name: 'bits', type: T.f64 }, { name: 'sign', type: T.i32 } ],
    retType: T.jsval,
    returnType: TYPES.bigint,
    body: [ RawC('return porf_bigint_as_n(x, bits, sign);', false) ]
  };

  // ++ / -- on a value ToNumeric has given: a Number or a BigInt
  _.__Porffor_numericStep = {
    params: [ { name: 'x', type: T.jsval }, { name: 'dec', type: T.i32 } ],
    retType: T.jsval,
    returnTypes: [ TYPES.number, TYPES.bigint ],
    body: [ RawC('return porf_numeric_step(x, dec);', false) ]
  };

  _.__Porffor_bigint_hash = {
    params: [ { name: 'x', type: T.jsval } ],
    retType: T.i32,
    returnType: TYPES.number,
    body: [ RawC('return porf_bigint_hash(x);', false) ]
  };

  _.__Porffor_memorySize = {
    params: [],
    retType: T.i32,
    returnType: TYPES.number,
    body: [ RawC('return (i32)porf_heap_committed;', false) ]
  };

  // s in upper (1) or lower (0) case, by full Unicode mapping (render.js porf_case_convert)
  _.__Porffor_caseConvert = {
    params: [ { name: 's', type: T.jsval }, { name: 'upper', type: T.i32 } ],
    retType: T.jsval,
    body: [ RawC('return porf_case_convert(s, upper);', false) ]
  };

  // len random bytes at MEM + ptr (crypto.getRandomValues, crypto.randomUUID)
  _.__Porffor_randomFill = {
    params: [ { name: 'ptr', type: T.i32 }, { name: 'len', type: T.i32 } ],
    retType: T.none,
    returnType: TYPES.undefined,
    body: [ RawC('porf_random_fill((u8*)(MEM + (u32)ptr), (u32)len);', false) ]
  };

  // SIMD scans and copies (render.js porf_simd_*; scalar where the target has no SIMD). A base is a
  // data pointer (units at base + 4), indices count units from it
  const i32Param = name => ({ name, type: T.i32 });
  const simdScan = (fn, params) => ({
    params: params.map(i32Param),
    retType: T.i32,
    returnType: TYPES.number,
    body: [ RawC(`return ${fn}(${params.map(x => x === 'base' || x === 'c' || x === 'set' ? `(u32)${x}` : x).join(', ')});`, false) ]
  });
  // the first index in [from, to) holding c, or -1
  _.__Porffor_simd_findU8 = simdScan('porf_simd_find_u8', [ 'base', 'from', 'to', 'c' ]);
  _.__Porffor_simd_findU16 = simdScan('porf_simd_find_u16', [ 'base', 'from', 'to', 'c' ]);
  // the last index in [from, to) holding c, or -1
  _.__Porffor_simd_rfindU8 = simdScan('porf_simd_rfind_u8', [ 'base', 'from', 'to', 'c' ]);
  // the first index in [from, to) whose unit is in the 256-bit set at set, or -1
  _.__Porffor_simd_findSetU8 = simdScan('porf_simd_find_set_u8', [ 'base', 'from', 'to', 'set' ]);
  _.__Porffor_simd_findSetU16 = simdScan('porf_simd_find_set_u16', [ 'base', 'from', 'to', 'set' ]);
  // the first index in [from, to) whose unit is not in the set, or to
  _.__Porffor_simd_spanSetU8 = simdScan('porf_simd_span_set_u8', [ 'base', 'from', 'to', 'set' ]);
  _.__Porffor_simd_spanSetU16 = simdScan('porf_simd_span_set_u16', [ 'base', 'from', 'to', 'set' ]);
  // the first index in [from, to) that is not ASCII, or to
  _.__Porffor_simd_asciiU8 = simdScan('porf_simd_ascii_u8', [ 'base', 'from', 'to' ]);
  _.__Porffor_simd_asciiU16 = simdScan('porf_simd_ascii_u16', [ 'base', 'from', 'to' ]);
  // the first index in [from, to) that JSON escapes (and, two-byte, above 0xff), or to
  _.__Porffor_simd_jsonU8 = simdScan('porf_simd_json_u8', [ 'base', 'from', 'to' ]);
  _.__Porffor_simd_jsonU16 = simdScan('porf_simd_json_u16', [ 'base', 'from', 'to' ]);
  const simdCopy = fn => ({
    params: [ 'dst', 'di', 'src', 'si', 'n' ].map(i32Param),
    retType: T.none,
    returnType: TYPES.undefined,
    body: [ RawC(`${fn}((u32)dst, di, (u32)src, si, n);`, false) ]
  });
  // n bytes to two-byte units, and two-byte units (below 0x100) to bytes
  _.__Porffor_simd_widen = simdCopy('porf_simd_widen');
  _.__Porffor_simd_narrow = simdCopy('porf_simd_narrow');

  // base64 and hex (render.js porf_b64_* / porf_hex_*): data pointers, lengths in units
  const cHelper = (fn, params, ret = true) => ({
    params: params.map(i32Param),
    retType: ret ? T.i32 : T.none,
    returnType: ret ? TYPES.number : TYPES.undefined,
    body: [ RawC(`${ret ? 'return ' : ''}${fn}(${params.join(', ')});`, false) ]
  });
  // the chars written
  _.__Porffor_base64_encode = cHelper('porf_b64_encode', [ 'src', 'n', 'dst', 'url', 'pad' ]);
  // the bytes written, or -1 - written on a SyntaxError; __Porffor_base64_read gives the units read
  _.__Porffor_base64_decode = cHelper('porf_b64_decode', [ 'src', 'two', 'len', 'url', 'lch', 'dst', 'max' ]);
  _.__Porffor_base64_read = { params: [], retType: T.i32, returnType: TYPES.number, body: [ RawC('return porf_b64_read;', false) ] };
  _.__Porffor_hex_encode = cHelper('porf_hex_encode', [ 'src', 'n', 'dst' ], false);
  // the bytes written before the first pair that is not two hex digits
  _.__Porffor_hex_decode = cHelper('porf_hex_decode', [ 'src', 'two', 'n', 'dst' ]);

  // string search and order (render.js porf_str_*): data pointers, w* 1 for two-byte units
  // the first index from at (last index up to at, for rfind) where the needle occurs, or -1
  _.__Porffor_string_find = cHelper('porf_str_find', [ 'hay', 'wh', 'len', 'ndl', 'wn', 'n', 'at' ]);
  _.__Porffor_string_rfind = cHelper('porf_str_rfind', [ 'hay', 'wh', 'len', 'ndl', 'wn', 'n', 'at' ]);
  // the first of n units where a from ai and b from bi differ, or n
  _.__Porffor_string_mismatch = cHelper('porf_str_mismatch', [ 'a', 'wa', 'ai', 'b', 'wb', 'bi', 'n' ]);
  // -1, 0 or 1 by UTF-16 code units
  _.__Porffor_string_order = cHelper('porf_str_order', [ 'a', 'wa', 'b', 'wb' ]);

  _.__Porffor_gc = {
    params: [],
    retType: T.none,
    returnType: TYPES.undefined,
    body: [ RawC('porf_gc_collect(0);', false) ]
  };

  // allow non-comptime redefinition later in precompiled
  const comptime = (name, returnType, comptime, jsLength = 0) => {
    let v = {
      returnType,
      comptime,
      jsLength,
      params: [],
      locals: [],
      returns: []
    };

    Object.defineProperty(_, name, {
      configurable: true,
      get() {
        return v;
      },
      set(x) {
        x.comptime = comptime;
        x.returnType = returnType;
        v = x;
        // a real function now (Array.of): listed like any builtin, so a static read through
        // its constructor as a value finds it
        Object.defineProperty(_, name, { enumerable: true });
      }
    });
  };

  // no return type: Array.of.call(C, ...) (array.ts) makes a C, not an array; a direct call's
  // literal carries its own
  comptime('__Array_of', undefined, (scope, decl, { generate }) => generate(scope, {
    type: 'ArrayExpression',
    elements: decl.arguments
  }));

  const fastBoolArg = x => x[N_TYPE] === T.i32 ? x :
    x[N_KIND] === K.Box && x[N_B][N_KIND] === K.Const && x[N_B][N_A] === TYPES.boolean && (x[N_A][N_TYPE] === T.i32 || x[N_A][N_TYPE] === T.u32) ? Un('!', T.i32, Un('!', T.i32, x[N_A])) :
    Convert(T.i32, JvNum(x), CONVERT_SIGNED);
  const fastBool = x => Box(x, Const(T.i32, TYPES.boolean));

  comptime('__Porffor_fastOr', TYPES.boolean, (scope, decl, { generate }) =>
    fastBool(decl.arguments.map(a => fastBoolArg(generate(scope, a))).reduce((x, y) => Bin('|', T.i32, x, y))));

  comptime('__Porffor_fastAnd', TYPES.boolean, (scope, decl, { generate }) =>
    fastBool(decl.arguments.map(a => fastBoolArg(generate(scope, a))).reduce((x, y) => Bin('&', T.i32, x, y))));

  // array storage is the C runtime's porf_arr_*
  const rawPtr = x => x[N_TYPE] === T.jsval ? JvPtr(x) : x;
  const rawNum = x => x[N_TYPE] === T.jsval ? JvNum(x) : x;
  const rawI32 = x => x[N_TYPE] === T.i32 ? x : Convert(T.i32, rawNum(x));

  comptime('__Porffor_array_new', TYPES.array, (scope, decl, { generate }) =>
    Box(Call('porf_arr_new', [ Const(T.i32, 0), rawI32(generate(scope, decl.arguments[0])) ], T.u32), Const(T.i32, TYPES.array)));

  comptime('__Porffor_array_ensure', TYPES.number, (scope, decl, { generate }) =>
    Call('porf_arr_grow', [ rawPtr(generate(scope, decl.arguments[0])), rawI32(generate(scope, decl.arguments[1])) ], T.u32));

  comptime('__Porffor_array_has', TYPES.boolean, (scope, decl, { generate }) =>
    Box(Call('porf_arr_has_own', [ rawPtr(generate(scope, decl.arguments[0])), rawI32(generate(scope, decl.arguments[1])) ], T.i32), Const(T.i32, TYPES.boolean)));

  comptime('__Porffor_array_delete', TYPES.undefined, (scope, decl, { generate, exprStmt }) => {
    exprStmt(scope, Call('porf_arr_delete', [ rawPtr(generate(scope, decl.arguments[0])), rawI32(generate(scope, decl.arguments[1])) ], T.none));
    return JvConst(TYPES.undefined, 0);
  });

  comptime('__Porffor_array_setLength', TYPES.undefined, (scope, decl, { generate, exprStmt }) => {
    exprStmt(scope, Call('porf_arr_set_len', [ rawPtr(generate(scope, decl.arguments[0])), Convert(T.u32, rawNum(generate(scope, decl.arguments[1])), 0) ], T.none));
    return JvConst(TYPES.undefined, 0);
  });

  comptime('__Porffor_printStatic', TYPES.undefined, (scope, decl, { printStaticStr }) => {
    const str = decl.arguments[0].value;
    const out = printStaticStr(scope, str);
    out.push(JvConst(TYPES.undefined, 0));
    return out;
  });

  comptime('__Porffor_type', TYPES.number, (scope, decl, { generate, getNodeType, knownType }) => {
    const type = knownType(scope, getNodeType(scope, decl.arguments[0]));
    if (type != null) return Const(T.i32, type);
    return JvType(generate(scope, decl.arguments[0]));
  });

  comptime('__Porffor_as', undefined, (scope, decl, { generate }) => {
    const typeArg = decl.arguments[1];
    if (typeArg?.type === 'Identifier' && typeArg.name.startsWith('__Porffor_TYPES_')) {
      return Box(generate(scope, decl.arguments[0]), Const(T.i32, TYPES[typeArg.name.slice('__Porffor_TYPES_'.length)]));
    }

    return Box(generate(scope, decl.arguments[0]), generate(scope, typeArg));
  });

  // Porffor.call(func, argArray, this, newTarget)
  comptime('__Porffor_call', undefined, (scope, decl, { generate, createThisArg }) => {
    const noNewTarget = decl.arguments[3].value === null ||
      (decl.arguments[3].type === 'Identifier' && decl.arguments[3].name === 'undefined');
    const newTarget = noNewTarget ? null : generate(scope, decl.arguments[3]);
    const thisArg = decl.arguments[2].value === null
      ? createThisArg(scope, noNewTarget
        ? { type: 'CallExpression', callee: decl.arguments[0], arguments: [] }
        : { type: 'NewExpression', callee: decl.arguments[3], arguments: [], _new: true, _forceCreateThis: true })
      : generate(scope, decl.arguments[2]);

    return CallDynamic(generate(scope, decl.arguments[0]), thisArg, [], newTarget, generate(scope, decl.arguments[1]));
  });

  // Porffor.callThis(func, this, ...args)
  comptime('__Porffor_callThis', undefined, (scope, decl, { generate }) => generate(scope, {
    type: 'CallExpression',
    callee: decl.arguments[0],
    arguments: decl.arguments.slice(2),
    _thisArg: decl.arguments[1]
  }));

  // compile-time aware console.log to optimize fast paths
  // todo: this breaks console.group, etc - disable this if those are used but edge case for now
  comptime('__console_log', TYPES.undefined, (scope, decl, { generate, getNodeType, knownType, printStaticStr, exprStmt }) => {
    const slow = () => {
      decl._noComptime = true;
      return generate(scope, decl);
    };
    const fast = (name, before = '', after = '\n') => {
      if (before) for (const x of printStaticStr(scope, before)) exprStmt(scope, x);
      if (name) exprStmt(scope, generate(scope, {
          ...decl,
          callee: {
            type: 'Identifier',
            name
          }
        }));
      if (after) for (const x of printStaticStr(scope, after)) exprStmt(scope, x);
      return JvConst(TYPES.undefined, 0);
    };

    if (decl.arguments.length === 0) return fast();
    if (decl.arguments.length !== 1) return slow();

    const type = knownType(scope, getNodeType(scope, decl.arguments[0]));

    // if we know the type skip the entire print logic, use type's func directly
    if (type === TYPES.string || type === TYPES.bytestring) {
      return fast('__Porffor_printString');
    } else if (type === TYPES.number) {
      return fast('__Porffor_print');
    }

    // one arg, skip most of console to avoid rest arg etc
    return fast('__Porffor_consolePrint');
  });

  PrecompiledBuiltins.BuiltinFuncs(_);
  _.__Math_hypot.jsLength = 2;
  // the options argument (for a cause) is not counted
  for (const name of [ 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError' ]) _[name].jsLength = 1;
  _.AggregateError.jsLength = 2;
  // absent only while precompile first builds it
  if (_.SuppressedError) _.SuppressedError.jsLength = 3;
  _.__BigInt_prototype_toString.jsLength = 0;

  // the spec's lengths where an implementation's parameters say otherwise (optional arguments
  // are plain parameters there, a rest one counts nothing)
  const SPEC_LENGTHS = {
    Array: 1, Map: 0, Set: 0, WeakMap: 0, WeakSet: 0, Symbol: 0, Date: 7, DataView: 1,
    __Array_from: 1, __Math_max: 2, __Math_min: 2, __Object_assign: 2, __String_fromCodePoint: 1,
    __Atomics_notify: 3, __Atomics_wait: 4, __Iterator_prototype_reduce: 1, __Iterator_zip: 1, __Iterator_zipKeyed: 1,
    __ArrayBuffer_prototype_transfer: 0, __ArrayBuffer_prototype_transferToFixedLength: 0,
    __FinalizationRegistry_prototype_register: 2,
    __Date_prototype_toLocaleString: 0, __Date_prototype_toLocaleDateString: 0, __Date_prototype_toLocaleTimeString: 0
  };
  const ARRAY_LIKE_LENGTHS = {
    every: 1, some: 1, forEach: 1, map: 1, filter: 1, find: 1, findIndex: 1, findLast: 1, findLastIndex: 1,
    reduce: 1, reduceRight: 1, indexOf: 1, lastIndexOf: 1, includes: 1, fill: 1, copyWithin: 2, set: 1
  };
  for (const [ method, n ] of Object.entries(ARRAY_LIKE_LENGTHS)) {
    if (method !== 'set') SPEC_LENGTHS['__Array_prototype_' + method] = n;
    SPEC_LENGTHS['__Porffor_TypedArray_prototype_' + method] = n;
    for (const kind of TYPED_ARRAY_KINDS) SPEC_LENGTHS[`__${kind}_prototype_${method}`] = n;
  }
  Object.assign(SPEC_LENGTHS, { __Array_prototype_push: 1, __Array_prototype_unshift: 1, __Array_prototype_concat: 1 });
  for (const [ name, n ] of Object.entries(SPEC_LENGTHS)) if (_[name]) _[name].jsLength = n;

  return _;
};
