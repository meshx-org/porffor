// Inlining for escape analysis (--inline): calls that make a fresh object, and the method
// calls made on it, are replaced by their bodies where that lets escape analysis (escape.js)
// turn the object into locals. Inlined for that alone: clang already inlines Porffor's C for
// call overhead, but never removes an allocation, which only this level can see is private.
//
//   class Vec { constructor(x, y) { this.x = x; this.y = y; }  add(o) { return new Vec(this.x + o.x, this.y + o.y); } }
//   const a = new Vec(1, 2);        ->   const a = { x: 1, y: 2 };                    (then escape.js:
//   const s = a.add(b);                  const s = new Vec(a.x + b.x, a.y + b.y);     a#x, a#y, s#x …)
//
// Three things are inlined, each only where the object it makes then stays local in the
// caller (literalStaysLocal); anywhere else every change is undone (a journal of them), so
// nothing is copied for nothing:
// - `const x = f(args)`, f a function or arrow nothing reassigns whose body is consts and one
//   `return` of an object literal;
// - `const x = new C(args)`, C a class (no extends, getters, setters or private names) or a
//   constructor function (its prototype's methods assigned once, at the top level, and the
//   function used for nothing else), whose constructor only assigns `this.k = expr`: x
//   becomes the literal of those fields;
// - `x.m(args)` on such an x, m a method of C whose body is one `return expr` and whose
//   arguments are variables nothing reassigns or literals: the call becomes expr, with this
//   as x. A method that makes a new C leaves a `new C` for the next round.
// Inlined code may name its own parameters and consts, this (a method), bindings of the
// program's top level nothing reassigns, and a few builtin globals, none of them shadowed
// where it is copied to. The pass repeats over each function until nothing more is inlined.
//
// Runs after the semantic pass (its resolution ties names to declarations) and before the
// escape pass, which --inline turns on. Off by default; --inline-log lists what it inlined.

import { certainEscape, literalEscape, literalEscapes } from './escape.js';

const FUNCS = new Set([ 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression' ]);
// globals inlined code may name: builtins whose meaning cannot change between callee and caller
const SAFE_GLOBALS = new Set([ 'Math', 'Number', 'String', 'Boolean', 'undefined', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt', 'parseFloat' ]);
const REFUSE = new Set([ 'Super', 'MetaProperty', 'YieldExpression', 'AwaitExpression', 'ClassExpression', 'ClassDeclaration', 'WithStatement', 'PrivateIdentifier' ]);
const BUILTIN_NAME = /^__[A-Za-z]/;
const MAX_ROUNDS = 8;

/** Every child node of `node`, with its container and key (as escape.js walks). */
const children = function* (node) {
  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (value[i] && typeof value[i].type === 'string') yield [ value[i], value, i ];
    } else if (value && typeof value.type === 'string') yield [ value, node, key ];
  }
};

/** A deep copy of an AST, keeping the semantic links (_ keys) as they are. */
const clone = node => {
  if (Array.isArray(node)) return node.map(clone);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const key in node) {
    const value = node[key];
    out[key] = key[0] === '_' || key === 'loc' ? value : clone(value);
  }
  return out;
};

const identifier = name => ({ type: 'Identifier', name });
/**
 * A binding the pass makes (a bound argument, a callee's const): its declaring identifier and
 * a variable its references resolve to, as the semantic pass would have made, so escape.js
 * and later rounds see every use of it.
 */
const fresh = name => {
  const id = identifier(name);
  return { name, id, variable: { node: id } };
};
const constDecl = (binding, init) => {
  const declarator = { type: 'VariableDeclarator', id: binding.id, init };
  binding.id._declarator = declarator;
  return { type: 'VariableDeclaration', kind: 'const', declarations: [ declarator ] };
};
const isPropertyName = (node, parent, key) =>
  (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
  ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed);

// ---- the journal: every change, so an attempt that does not pay can be undone ----

const journal = [];
const setAt = (container, key, value) => {
  const old = container[key];
  journal.push(() => { container[key] = old; });
  container[key] = value;
};
const insertBefore = (list, anchor, items) => {
  if (items.length === 0) return;
  list.splice(list.indexOf(anchor), 0, ...items);
  journal.push(() => { list.splice(list.indexOf(items[0]), items.length); });
};
const undoTo = mark => { while (journal.length > mark) journal.pop()(); };

// ---- what inlined code may name ----

let topLevel = new Set();   // declaration nodes of the program's top level

/**
 * Checks an expression that is to be copied: it names only `own` bindings (params, consts),
 * this (when thisOk: a method's, replaced by its receiver), top-level bindings nothing reassigns and
 * builtin globals. The names it borrows go into `names` (to check for shadowing). False if
 * it cannot be copied.
 */
const copyable = (expr, own, thisOk, names, why = null) => {
  let ok = true;
  const fail = reason => { ok = false; if (why) why.reason ??= reason; };
  const walk = (node, parent, key) => {
    if (!ok) return;
    if (REFUSE.has(node.type) || FUNCS.has(node.type)) { fail(FUNCS.has(node.type) ? 'makes a function' : `has ${node.type}`); return; }
    // this becomes the receiver, a variable: used whole, escape.js sees it escape
    if (node.type === 'ThisExpression') {
      if (!thisOk) fail('reads this');
      return;
    }
    if (node.type === 'Identifier') {
      if (isPropertyName(node, parent, key)) return;
      const variable = node._resolvedVariable;
      if (variable) {
        if (own.has(variable.node)) return;
        if (topLevel.has(variable.node) && !variable.node._writes) { names.add(node.name); return; }
        fail(topLevel.has(variable.node) ? `names ${node.name}, which is reassigned` : `names ${node.name}, a binding of an outer function`);
      } else if (SAFE_GLOBALS.has(node.name)) names.add(node.name);
      // a builtin the object hack named (Math.sqrt is __Math_sqrt by now): not a user binding
      else if (!BUILTIN_NAME.test(node.name)) fail(`names the global ${node.name}`);
      return;
    }
    for (const [ child, cont, k ] of children(node)) walk(child, node, Array.isArray(cont) ? null : k);
  };
  walk(expr, null, null);
  return ok;
};

// ---- functions, constructors and methods that can be inlined ----

/** A function's plain parameters (none reassigned, so each can be bound once); else null. */
const plainParams = fn => !fn.async && !fn.generator && fn.params.every(p => p.type === 'Identifier' && !p._writes) ? fn.params : null;

/** A function returning a literal: { params, consts, result, names }; else null. */
const literalFunction = fn => {
  const params = plainParams(fn);
  if (!params) return null;
  let consts = [], result;
  if (fn.body.type === 'ObjectExpression') result = fn.body;
  else if (fn.body.type === 'BlockStatement') {
    const body = fn.body.body;
    const last = body.at(-1);
    if (last?.type !== 'ReturnStatement' || last.argument?.type !== 'ObjectExpression') return null;
    for (const x of body.slice(0, -1)) {
      if (x.type !== 'VariableDeclaration' || x.kind !== 'const' || !x.declarations.every(d => d.id.type === 'Identifier' && d.init)) return null;
      consts.push(...x.declarations);
    }
    result = last.argument;
  } else return null;

  const own = new Set([ ...params, ...consts.map(d => d.id) ]);
  const names = new Set();
  if (!consts.every(d => copyable(d.init, own, false, names)) || !copyable(result, own, false, names)) return null;
  return { params, consts, result, names };
};

/** Why a constructor is not one that only assigns fields; null when it is. */
const constructorProblem = fn => {
  if (!fn) return null;
  if (!plainParams(fn)) return 'its constructor has default, rest, destructured or reassigned params';
  for (const x of fn.body.body) {
    const e = x.type === 'ExpressionStatement' ? x.expression : null;
    const field = e?.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'MemberExpression' &&
      e.left.object.type === 'ThisExpression' && !e.left.computed && e.left.property.type === 'Identifier' && e.left.property.name !== '__proto__';
    if (!field) {
      const what = e?.type === 'CallExpression' ? 'calls something' : e ? `has a ${e.type}` : `has a ${x.type}`;
      return `its constructor ${what} (not only this.k = …)`;
    }
    const why = {};
    if (!copyable(e.right, new Set(fn.params), false, new Set(), why)) return `its constructor's this.${e.left.property.name} = … ${why.reason}`;
  }
  return null;
};

/** A constructor that only assigns fields: { params, assigns: [[key, expr]], names }; else null. */
const fieldConstructor = fn => {
  const params = fn ? plainParams(fn) : [];
  if (!params || (fn && fn.body.type !== 'BlockStatement')) return null;
  const assigns = [];
  const names = new Set();
  const own = new Set(params);
  for (const x of fn?.body.body ?? []) {
    const e = x.type === 'ExpressionStatement' ? x.expression : null;
    if (e?.type !== 'AssignmentExpression' || e.operator !== '=' || e.left.type !== 'MemberExpression' ||
        e.left.object.type !== 'ThisExpression' || e.left.computed || e.left.property.type !== 'Identifier' ||
        e.left.property.name === '__proto__' || !copyable(e.right, own, false, names)) return null;
    assigns.push([ e.left.property.name, e.right ]);
  }
  return { params, assigns, names };
};

/** A method that is one `return expr`: { params, result, names }; else null. */
const expressionMethod = fn => {
  const params = fn?.type === 'FunctionExpression' ? plainParams(fn) : null;
  const body = fn?.body.body;
  if (!params || body?.length !== 1 || body[0].type !== 'ReturnStatement' || !body[0].argument) return null;
  const names = new Set();
  if (!copyable(body[0].argument, new Set(params), true, names)) return null;
  return { params, result: body[0].argument, names };
};

/** How a constructor function is used other than with new (why its prototype could be reached). */
const functionUse = (parent, key) => {
  if (parent?.type === 'CallExpression') return key === 'callee' ? 'called without new' : 'passed to a call';
  if (parent?.type === 'MemberExpression' && key === 'object') return parent.property.name === 'prototype' ? 'used through .prototype otherwise' : `used for .${parent.property.name ?? '[…]'}`;
  if (parent?.type === 'AssignmentExpression' || parent?.type === 'Property' || parent?.type === 'VariableDeclarator') return 'stored as a value';
  return `used as a value (${parent?.type})`;
};

// diagnostics (--inline-why): why each class does not qualify, and each attempt's outcome
let rejected = new Map();
let outcomes = new Map();   // the original new C(…) node -> 'removed', or why not

/**
 * The classes whose instances can be built as literals, by declaration node (a class, its
 * name, or a constructor function): { name, fields: [[key, expr]], ctor, methods }.
 */
const collectClasses = program => {
  const classes = new Map();
  const reject = (keys, reason) => { for (const k of keys) if (k) rejected.set(k, reason); };

  // class C { … } (no extends): fields, a constructor assigning fields, methods
  const esClass = (node, keys) => {
    if (node.superClass) return reject(keys, 'the class extends another');
    const fields = [], methods = new Map();
    let ctorFn = null;
    const names = new Set();
    for (const m of node.body.body) {
      if (m.type === 'StaticBlock' || m.static) continue;
      if (m.computed || m.key?.type !== 'Identifier') return reject(keys, 'the class has a computed or private member');
      if (m.type === 'PropertyDefinition') {
        const why = {};
        if (m.value && !copyable(m.value, new Set(), false, names, why)) return reject(keys, `the class field ${m.key.name} ${why.reason}`);
        fields.push([ m.key.name, m.value ?? identifier('undefined') ]);
      } else if (m.type === 'MethodDefinition') {
        // an accessor would run on a field's assignment, which a literal skips
        if (m.kind === 'get' || m.kind === 'set') return reject(keys, `the class has a ${m.kind}ter (${m.key.name})`);
        if (m.kind === 'constructor') ctorFn = m.value;
        else methods.set(m.key.name, m.value);
      } else return reject(keys, `the class has a ${m.type}`);
    }
    const ctor = fieldConstructor(ctorFn);
    if (!ctor) return reject(keys, constructorProblem(ctorFn) ?? 'its constructor');
    const cls = { name: node.id?.name ?? 'class', fields, ctor, methods, names };
    for (const k of keys) if (k) classes.set(k, cls);
  };

  // function F(…) { this.k = … } with F.prototype.m = function … at the top level, F used
  // for nothing else (anything else could reach its prototype)
  const protoMethods = new Map();   // F's declaration -> Map(name -> function), or null
  const protoAssigns = new Set();   // the F.prototype.m = … statements
  for (const x of program.body) {
    const e = x.type === 'ExpressionStatement' ? x.expression : null;
    const left = e?.type === 'AssignmentExpression' && e.operator === '=' ? e.left : null;
    const proto = left?.type === 'MemberExpression' && !left.computed ? left.object : null;
    const fnRef = proto?.type === 'MemberExpression' && !proto.computed && proto.property.name === 'prototype' ? proto.object : null;
    const decl = fnRef?.type === 'Identifier' ? fnRef._resolvedVariable?.node : null;
    if (decl?.type !== 'FunctionDeclaration') continue;
    const map = protoMethods.get(decl) ?? new Map();
    // assigned twice: which one runs depends on when
    if (map.has(left.property.name) || e.right.type !== 'FunctionExpression') protoMethods.set(decl, null);
    else if (protoMethods.get(decl) !== null) { map.set(left.property.name, e.right); protoMethods.set(decl, map); }
    protoAssigns.add(x);
  }

  const references = new Map();   // FunctionDeclaration -> whether every use is allowed
  const walk = (node, parent, key, grand, statement) => {
    if (node.type === 'ClassDeclaration') esClass(node, [ node, node.id ]);
    if (node.type === 'VariableDeclarator' && node.init?.type === 'ClassExpression') esClass(node.init, [ node.id ]);
    if (node.type === 'Identifier' && !isPropertyName(node, parent, key)) {
      const decl = node._resolvedVariable?.node;
      if (decl?.type === 'FunctionDeclaration') {
        const allowed = (parent?.type === 'NewExpression' && key === 'callee') ||
          (parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && key === 'right') ||
          (parent?.type === 'MemberExpression' && key === 'object' && parent.property.name === 'prototype' && protoAssigns.has(statement));
        if (!allowed) {
          if (references.get(decl) !== false) rejected.set(decl, `the constructor function is ${functionUse(parent, key)}`);
          references.set(decl, false);
        } else if (!references.has(decl)) references.set(decl, true);
      }
    }
    for (const [ child, cont, k ] of children(node))
      walk(child, node, Array.isArray(cont) ? null : k, parent, cont === program.body ? child : statement);
  };
  walk(program, null, null, null, null);

  for (const [ decl, ok ] of references) {
    if (!ok) continue;
    if (decl._writes) { rejected.set(decl, 'the constructor function is reassigned'); continue; }
    if (!topLevel.has(decl)) { rejected.set(decl, 'the constructor function is not at the top level'); continue; }
    if (protoMethods.get(decl) === null) { rejected.set(decl, 'a prototype method is assigned twice, or not a function'); continue; }
    const ctor = fieldConstructor(decl);
    if (ctor) classes.set(decl, { name: decl.id.name, fields: [], ctor, methods: protoMethods.get(decl) ?? new Map(), names: new Set() });
    else rejected.set(decl, constructorProblem(decl) ?? 'its constructor');
  }
  return classes;
};

// ---- rewriting ----

let counter = 0;
let log = null;

/** A variable nothing reassigns, or a literal: an argument a body may read in its place. */
const passable = arg => (arg?.type === 'Identifier' && arg._resolvedVariable && !arg._resolvedVariable.node?._writes) ||
  (arg?.type === 'Literal' && arg.regex == null) ||
  (arg?.type === 'UnaryExpression' && arg.operator === '-' && arg.argument.type === 'Literal' && typeof arg.argument.value === 'number');

/**
 * A copy of `node` with the bindings in `map` (declaration node -> a fresh binding, or a node
 * to read instead) replaced, and `this` replaced by `self` (a copy of it at each use).
 */
const substitute = (node, map, self = null) => {
  const out = clone(node);
  const walk = (n, container, key, parent) => {
    if (n.type === 'ThisExpression' && self) { container[key] = clone(self); return; }
    if (n.type === 'Identifier' && n._resolvedVariable && map.has(n._resolvedVariable.node) && !isPropertyName(n, parent, key)) {
      const to = map.get(n._resolvedVariable.node);
      if (to.variable) {
        n.name = to.name;
        n._resolvedVariable = to.variable;
        delete n._resolvedBinding;
      } else container[key] = clone(to);
      // { a } names the field a: the key keeps it once the value is replaced
      if (parent?.type === 'Property' && parent.shorthand) parent.shorthand = false;
      return;
    }
    for (const [ child, cont, k ] of children(n)) walk(child, cont, k, n);
  };
  const holder = { out };
  walk(out, holder, 'out', null);
  return holder.out;
};

/**
 * Binds a call's arguments to its params: a passable argument is read in place, any other is
 * a const evaluated where the call was (as are arguments past the params). Returns the map
 * and the statements to put before the call's statement.
 */
const bindArgs = (params, args, prefix) => {
  const map = new Map(), before = [];
  params.forEach((p, i) => {
    if (passable(args[i])) map.set(p, args[i]);
    else {
      const name = `${prefix}#${p.name}`;
      const binding = fresh(name);
      map.set(p, binding);
      before.push(constDecl(binding, args[i] ?? identifier('undefined')));
    }
  });
  for (const extra of args.slice(params.length)) before.push({ type: 'ExpressionStatement', expression: extra });
  return { map, before };
};

/** The function a call names, when it is one nothing reassigns; else null. */
const calleeFunction = call => {
  if (call.type !== 'CallExpression' || call.optional || call.callee.type !== 'Identifier') return null;
  const decl = call.callee._resolvedVariable?.node;
  if (!decl || decl._writes) return null;
  if (decl.type === 'FunctionDeclaration') return decl;
  const init = decl._declarator?.init;
  return init && (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') ? init : null;
};

/** The names a function declares for itself (params, and bindings in its own body). */
const declaredNames = fn => {
  const names = new Set();
  const addPattern = p => {
    if (p.type === 'Identifier') names.add(p.name);
    else for (const [ child ] of children(p)) addPattern(child);
  };
  for (const p of fn.params) addPattern(p);
  const walk = node => {
    if (node !== fn && FUNCS.has(node.type)) {
      if (node.type === 'FunctionDeclaration' && node.id) names.add(node.id.name);
      return;
    }
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if ((node.type === 'ClassDeclaration') && node.id) names.add(node.id.name);
    for (const [ child ] of children(node)) walk(child);
  };
  walk(fn.body);
  return names;
};

/** A method call's escape, said precisely: why that method could not be inlined. */
const methodDetail = (reason, cls) => {
  const m = /^a method call \.(\w+)\(\)$/.exec(reason);
  if (!m) return reason;
  const fn = cls.methods.get(m[1]);
  if (!fn) return `a call of .${m[1]}(), not a method of the class (inherited or a field)`;
  const why = {};
  if (!expressionMethod(fn)) {
    const body = fn.body?.body;
    if (body?.length !== 1 || body[0].type !== 'ReturnStatement') return `a call of .${m[1]}(), whose body is not one return`;
    copyable(body[0].argument, new Set(fn.params), true, new Set(), why);
    return `a call of .${m[1]}(), whose expression ${why.reason ?? 'cannot be copied'}`;
  }
  return `a call of .${m[1]}() with arguments it cannot pass`;
};

/**
 * Inlines what pays in one function body. Objects depend on each other (a stays local once
 * d.dot(a) is inlined, d exists once c = a.add(b) is), so they are decided together: every
 * qualifying construction, call and method call is inlined, round after round until none is
 * left; then each object made is checked. If any would not stay local, every change is
 * undone, those are ruled out, and it starts again; each try rules out one more, so it ends.
 */
const inlineIn = (caller, callerBody, enclosing, classes) => {
  const shadowed = new Set();
  for (const fn of enclosing) for (const name of declaredNames(fn)) shadowed.add(name);
  const clear = names => ![ ...names ].some(n => shadowed.has(n));
  const where = caller.id?.name ?? '(anonymous)';

  const ruledOut = new Set();   // declarators whose object does not stay local
  let made, madeById, changed, notes;
  const homes = new Map();   // declarator -> { list, statement }: where a declaration sits   // declarator -> its class (null: a function's literal), and by its name's node

  const note = (declarator, text) => notes.set(declarator, text);

  // x.m(…) on an object made here: the method's expression, this as x
  const inlineMethods = () => {
    const walk = (node, container, key) => {
      if (node !== callerBody && FUNCS.has(node.type)) return;
      for (const [ child, cont, k ] of children(node)) walk(child, cont, k);
      if (node.type === 'CallExpression' && !node.optional && node.callee.type === 'MemberExpression' &&
          !node.callee.computed && !node.callee.optional && node.callee.object.type === 'Identifier') {
        const cls = madeById.get(node.callee.object._resolvedVariable?.node);
        const method = cls && expressionMethod(cls.methods.get(node.callee.property.name));
        // a call that is a declaration's whole value: its other arguments become consts just
        // before that statement, evaluated in the same order (p.add(v.scale(k)) -> const t =
        // v.scale(k), inlined in turn, then p.add(t))
        const home = container?.type === 'VariableDeclarator' && key === 'init' ? homes.get(container) : null;
        if (method && clear(method.names) && home && !node.arguments.every(passable) &&
            !node.arguments.some(a => a.type === 'SpreadElement')) {
          const before = [];
          node.arguments.forEach((arg, i) => {
            if (passable(arg)) return;
            const binding = fresh(`${cls.name}#${++counter}#arg`);
            before.push(constDecl(binding, arg));
            setAt(node.arguments, i, clone(binding.id));
            node.arguments[i]._resolvedVariable = binding.variable;
          });
          insertBefore(home.list, home.statement, before);
          changed = true;
        }
        if (method && clear(method.names) && node.arguments.every(passable)) {
          const map = new Map(method.params.map((p, i) => [ p, node.arguments[i] ?? identifier('undefined') ]));
          setAt(container, key, substitute(method.result, map, node.callee.object));
          changed = true;
        }
      }
      // new C(pure args).k: the field's expression, nothing else to evaluate
      if (node.type === 'MemberExpression' && !node.computed && !node.optional && node.object.type === 'NewExpression' &&
          node.object.callee.type === 'Identifier' && node.object.arguments.every(passable)) {
        const cls = classes.get(node.object.callee._resolvedVariable?.node);
        const assign = cls && clear(cls.names) && clear(cls.ctor.names) && cls.fields.length === 0 &&
          cls.ctor.assigns.findLast(([ k ]) => k === node.property.name);
        if (assign) {
          const map = new Map(cls.ctor.params.map((p, i) => [ p, node.object.arguments[i] ?? identifier('undefined') ]));
          setAt(container, key, substitute(assign[1], map));
          changed = true;
        }
      }
    };
    walk(callerBody, null, null);
  };

  const construct = (list, statement, declarator, cls) => {
    const call = declarator.init;
    if (call.arguments.some(a => a.type === 'SpreadElement') || !clear(cls.names) || !clear(cls.ctor.names)) return;
    const { map, before } = bindArgs(cls.ctor.params, call.arguments, `${cls.name}#${++counter}`);
    insertBefore(list, statement, before);
    const properties = [ ...cls.fields.map(([ k, v ]) => [ k, substitute(v, new Map()) ]), ...cls.ctor.assigns.map(([ k, v ]) => [ k, substitute(v, map) ]) ]
      .map(([ k, value ]) => ({ type: 'Property', kind: 'init', key: identifier(k), value, computed: false, method: false, shorthand: false }));
    declarator._inlinedNew ??= call;
    setAt(declarator, 'init', { type: 'ObjectExpression', properties });
    made.set(declarator, cls);
    madeById.set(declarator.id, cls);
    note(declarator, `new ${cls.name}(…)`);
    changed = true;
  };

  const inlineCall = (list, statement, declarator, fn) => {
    const call = declarator.init;
    const parts = fn !== caller && !call.arguments.some(a => a.type === 'SpreadElement') ? literalFunction(fn) : null;
    if (!parts || !clear(parts.names)) return;
    const prefix = `${call.callee.name}#${++counter}`;
    const { map, before } = bindArgs(parts.params, call.arguments, prefix);
    for (const d of parts.consts) map.set(d.id, fresh(`${prefix}#${d.id.name}`));
    insertBefore(list, statement, [ ...before, ...parts.consts.map(d => constDecl(map.get(d.id), substitute(d.init, map))) ]);
    setAt(declarator, 'init', substitute(parts.result, map));
    made.set(declarator, null);
    note(declarator, `${call.callee.name}(…)`);
    changed = true;
  };

  // last statement first: a value's uses come after it
  const visitList = list => {
    for (let i = list.length - 1; i >= 0; i--) {
      const statement = list[i];
      if (statement.type === 'VariableDeclaration' && statement.kind !== 'var' && statement.declarations.length === 1 &&
          statement.declarations[0].id.type === 'Identifier' && statement.declarations[0].init) {
        const declarator = statement.declarations[0];
        const init = declarator.init;
        homes.set(declarator, { list, statement });
        if (!made.has(declarator) && !ruledOut.has(declarator)) {
          const cls = init.type === 'NewExpression' && init.callee.type === 'Identifier' ? classes.get(init.callee._resolvedVariable?.node) : null;
          if (cls) construct(list, statement, declarator, cls);
          else {
            const fn = calleeFunction(init);
            if (fn) inlineCall(list, statement, declarator, fn);
          }
        }
      }
      for (const [ child ] of children(statement)) visitNode(child);
    }
  };
  const visitNode = node => {
    if (FUNCS.has(node.type)) return;
    if (node.type === 'BlockStatement') return visitList(node.body);
    for (const [ child ] of children(node)) visitNode(child);
  };

  for (;;) {
    const mark = journal.length;
    made = new Map();
    madeById = new Map();
    notes = new Map();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      changed = false;
      visitList(callerBody.body);
      inlineMethods();
      if (!changed) break;
    }
    if (made.size === 0) return;

    const reasons = new Map();
    for (const d of made.keys()) {
      const reason = literalEscape(callerBody, d);
      if (reason != null) reasons.set(d, reason);
    }
    if (reasons.size === 0) {
      if (log) for (const [ d, text ] of notes) log.push(`${where}: ${d.id.name} = ${text}`);
      for (const [ d, cls ] of made) if (cls) outcomes.set(d._inlinedNew, 'removed');
      return;
    }
    undoTo(mark);
    for (const [ d, reason ] of reasons) {
      ruledOut.add(d);
      const cls = made.get(d);
      if (cls && !outcomes.has(d._inlinedNew)) outcomes.set(d._inlinedNew, `escapes: ${methodDetail(reason, cls)}`);
    }
  }
};

export default program => {
  log = Prefs.inlineLog ? [] : null;
  journal.length = 0;
  rejected = new Map();
  outcomes = new Map();

  topLevel = new Set();
  for (const x of program.body) {
    if (x.type === 'FunctionDeclaration' || x.type === 'ClassDeclaration') { topLevel.add(x); if (x.id) topLevel.add(x.id); }
    if (x.type === 'VariableDeclaration') for (const d of x.declarations) if (d.id.type === 'Identifier') topLevel.add(d.id);
  }
  const classes = collectClasses(program);

  const visit = (node, enclosing) => {
    if (FUNCS.has(node.type)) {
      const chain = [ ...enclosing, node ];
      if (node.body.type === 'BlockStatement') inlineIn(node, node.body, chain, classes);
      for (const [ child ] of children(node)) visit(child, chain);
      return;
    }
    for (const [ child ] of children(node)) visit(child, enclosing);
  };
  visit(program, []);
  journal.length = 0;
  if (log) for (const line of log) console.log(`inline: ${line}`);
  if (Prefs.inlineWhy) report(program, classes);
  return program;
};

/** Where a `new` that is not a declaration's value goes. */
const newPosition = (parent, key) => {
  switch (parent?.type) {
    case 'ReturnStatement': case 'ArrowFunctionExpression': return 'returned right away';
    case 'CallExpression': return 'passed straight to a call';
    case 'NewExpression': return 'passed straight to another new';
    case 'AssignmentExpression': return 'assigned (to a field or variable)';
    case 'Property': case 'ArrayExpression': return 'put in an object or array';
    case 'MemberExpression': return 'used at once (new C().x or new C().m())';
    case 'VariableDeclarator': return 'declared with var, or beside other declarations';
    case 'ExpressionStatement': return 'made for its side effects only';
    case 'ConditionalExpression': case 'LogicalExpression': case 'SequenceExpression': return 'in ?:, && or ,';
    default: return `in a ${parent?.type}`;
  }
};

/**
 * --inline-why: every `new` of the program and what became of it, then the object literals
 * that stay objects, each reason with its count and a few places.
 */
const report = (program, classes) => {
  const tally = new Map();
  const add = (reason, where) => {
    const e = tally.get(reason) ?? { count: 0, where: [] };
    e.count++;
    if (where && e.where.length < 3 && !e.where.includes(where)) e.where.push(where);
    tally.set(reason, e);
  };
  for (const result of outcomes.values()) if (result === 'removed') add('removed', '');

  // a new the class rules block: does its object escape even at best (then the rules are not
  // what stops it), or only because of them (an opportunity)?
  const blocked = (rule, parent, key, body, where) => {
    const declared = parent?.type === 'VariableDeclarator' && key === 'init' && parent.id.type === 'Identifier';
    const escape = declared ? certainEscape(body, parent) : newPosition(parent, key);
    if (escape != null) add(`escapes anyway (${escape}); also: ${rule}`, where);
    else add(`OPPORTUNITY, only the rules stop it: ${rule}`, where);
  };

  const walk = (node, parent, key, where, body) => {
    if (FUNCS.has(node.type)) {
      where = node.id?.name ?? (parent?.type === 'MethodDefinition' ? parent.key?.name : null) ?? where;
      body = node.body.type === 'BlockStatement' ? node.body : body;
    }
    if (node.type === 'NewExpression') {
      const result = outcomes.get(node);
      const callee = node.callee;
      if (result != null) { if (result !== 'removed') add(`new ${callee.name}: ${result}`, where); }
      else if (callee.type !== 'Identifier') blocked(`new of a member expression (new a.${callee.property?.name ?? '?'})`, parent, key, body, where);
      else if (!callee._resolvedVariable) blocked(`new of a global or builtin (${callee.name})`, parent, key, body, where);
      else {
        const decl = callee._resolvedVariable.node;
        if (!classes.has(decl)) blocked(`class ${callee.name}: ${rejected.get(decl) ?? 'not a class or constructor function it can see'}`, parent, key, body, where);
        else if (parent?.type === 'VariableDeclarator' && key === 'init') add(`new ${callee.name} declared with var, or beside other declarations`, where);
        else add(`new ${callee.name} ${newPosition(parent, key)}`, where);
      }
    }
    for (const [ child, cont, k ] of children(node)) walk(child, node, Array.isArray(cont) ? null : k, where, body);
  };
  walk(program, null, null, '(top level)', program);

  const print = (title, t) => {
    const total = [ ...t.values() ].reduce((a, e) => a + e.count, 0);
    console.log(`inline-why: ${title}, ${total} in all`);
    for (const [ reason, e ] of [ ...t ].sort((a, b) => b[1].count - a[1].count))
      console.log(`  ${String(e.count).padStart(5)}  ${reason}${e.where.length ? `   (${e.where.join(', ')})` : ''}`);
  };
  print('new sites', tally);

  const literals = new Map();
  for (const [ reason, where ] of literalEscapes(program)) {
    const e = literals.get(reason) ?? { count: 0, where: [] };
    e.count++;
    if (e.where.length < 3) e.where.push(where);
    literals.set(reason, e);
  }
  print('object literals kept as objects (const x = { … })', literals);
};
