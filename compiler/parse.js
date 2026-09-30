import './prefs.js';
import parse from './parser/index.js';
import link from './modules.js';

const usesImportCall = node => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesImportCall);
  if (node.type === 'ImportExpression') return true;
  for (const key in node) {
    if (key === 'start' || key === 'end') continue;
    if (usesImportCall(node[key])) return true;
  }
  return false;
};

// Whether the program can make an iterator of its own: it names Symbol.iterator or
// Symbol.asyncIterator (the only way to define one), the Iterator global (Iterator.from
// wraps any object with a next) or Proxy (a proxy iterates as its target does). Without
// that, for...of, spread and destructuring only ever see built-in iterables, and the
// iterator protocol (a try/finally per loop, the protocol builtins) is left out.
const usesIterProtocol = node => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesIterProtocol);

  // Iterator.from wraps any object with a next; a Proxy iterates through its target's
  // [Symbol.iterator] (for...of, spread and Array.from over it take the protocol)
  if (node.type === 'Identifier') return node.name === 'Iterator' || node.name === 'Proxy';
  if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === 'Symbol') {
    const key = node.computed ? node.property?.value : node.property?.name;
    if (key === 'iterator' || key === 'asyncIterator') return true;
  }
  if (node.type === 'Literal' || node.type === 'TemplateElement') return false;

  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (usesIterProtocol(node[key])) return true;
  }

  return false;
};

// Whether the program can hold a BigInt: a BigInt literal, or a name that makes one
// (BigInt, the 64-bit typed arrays and DataView accessors). Without that, arithmetic on
// values of unknown type only ever sees Numbers, and has no BigInt branch.
const BIGINT_NAMES = new Set([ 'BigInt', 'BigInt64Array', 'BigUint64Array', 'getBigInt64', 'getBigUint64', 'setBigInt64', 'setBigUint64' ]);
const usesBigInt = node => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesBigInt);

  if (node.type === 'Literal') return node.bigint != null;
  if (node.type === 'Identifier') return BIGINT_NAMES.has(node.name);
  if (node.type === 'TemplateElement') return false;

  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (usesBigInt(node[key])) return true;
  }

  return false;
};

// which regex tables and ops the program can need, from the property escapes and \q{} it names
// in a regex or in a string it could build one from: scripts (\p{sc=...}), strings in classes,
// and the emoji data of the properties of strings
const REGEX_FEATURES = [
  [ '_regexScripts', /[pP]\{(?:sc|scx|Script|Script_Extensions)=/ ],
  [ '_regexStrings', /\\q\{|[pP]\{(?:Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji)/ ],
  [ '_regexEmoji', /[pP]\{(?:Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji)/ ]
];
const markRegexFeatures = (node, ast) => {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(x => markRegexFeatures(x, ast));

  let text = null;
  if (node.type === 'Literal') text = node.regex ? node.regex.pattern : typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateElement') text = node.value.cooked ?? node.value.raw;
  if (text != null) {
    if (text.includes('{')) for (const [ key, re ] of REGEX_FEATURES) if (re.test(text)) ast[key] = true;
    return;
  }

  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    markRegexFeatures(node[key], ast);
  }
};

const usesTemporal = node => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesTemporal);

  if (node.type === 'Identifier') return node.name === 'Temporal';
  if (node.type === 'Literal') return false;
  if (node.type === 'TemplateLiteral') return usesTemporal(node.expressions);
  if (node.type === 'TemplateElement') return false;

  if (node.type === 'Property' || node.type === 'PropertyDefinition' || node.type === 'MethodDefinition') {
    return (node.computed && usesTemporal(node.key)) || usesTemporal(node.value);
  }

  if (node.type === 'VariableDeclarator') return usesTemporal(node.init);
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') return usesTemporal(node.params) || usesTemporal(node.body);
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return usesTemporal(node.superClass) || usesTemporal(node.body);

  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end') continue;
    if (usesTemporal(node[key])) return true;
  }

  return false;
};

// Whether a named function or class expression uses its own name as a value (not only to
// call itself): `class K { static f() { return K.#m(); } }`, `function F() { return F.p; }`.
const usesOwnName = (node, name) => {
  const visit = (n, parent, key) => {
    if (n == null || typeof n !== 'object') return false;
    if (Array.isArray(n)) return n.some(x => visit(x, parent, key));
    if (n.type === 'Identifier' && n.name === name) {
      // a direct call of itself compiles to a direct call, which is right already
      if (parent?.type === 'CallExpression' && key === 'callee' && node.type === 'FunctionExpression') return false;
      // a property named like it (`x.K`, `{ K: 1 }`) is not a reference
      if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
      if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return false;
      return true;
    }
    if (n.type === 'Literal' || n.type === 'TemplateElement') return false;
    for (const k in n) {
      if (k[0] === '_' || k === 'start' || k === 'end' || k === 'loc' || k === 'range' || (n === node && k === 'id')) continue;
      if (visit(n[k], n, k)) return true;
    }
    return false;
  };
  return visit(node, null, null);
};

// A named function or class expression that uses its own name as a value, as a declaration
// in an arrow that returns it: `(() => { class K {...} return K; })()`. Porffor binds an
// expression's own name to a new function object rather than the value itself when the
// expression is inside a function (so K's statics, or F's properties, are not there);
// declarations bind the value. Class bodies that await or yield in a computed key or their
// heritage are left alone (the arrow would change what those mean).
const bindOwnNames = node => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = bindOwnNames(node[i]);
    return node;
  }
  for (const key in node) {
    if (key[0] === '_' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (value && typeof value === 'object') node[key] = bindOwnNames(value);
  }
  if ((node.type === 'ClassExpression' || node.type === 'FunctionExpression') && node.id && usesOwnName(node, node.id.name)) {
    if (node.type === 'ClassExpression' && JSON.stringify([ node.superClass, node.body.body.filter(x => x.computed).map(x => x.key) ], (k, v) => k[0] === '_' ? undefined : v).match(/"(AwaitExpression|YieldExpression)"/)) return node;
    const at = { start: node.start, end: node.end };
    return {
      type: 'CallExpression',
      ...at,
      optional: false,
      arguments: [],
      callee: {
        type: 'ArrowFunctionExpression',
        ...at,
        id: null,
        params: [],
        async: false,
        generator: false,
        expression: false,
        body: {
          type: 'BlockStatement',
          ...at,
          body: [
            // still an expression's own name to semantic/codegen: read-only inside itself
            { ...node, type: node.type === 'ClassExpression' ? 'ClassDeclaration' : 'FunctionDeclaration', _fromExpression: true },
            { type: 'ReturnStatement', ...at, argument: { type: 'Identifier', ...at, name: node.id.name } }
          ]
        }
      }
    };
  }
  return node;
};

// `using` and `await using` (explicit resource management), lowered onto try/finally, which
// codegen already runs on every way out of a scope (return, break, continue, throw):
//   { a; using x = e; b }
// becomes
//   { const L = []; let E, H = false;
//     try { a; const x = e; __Porffor_using_add(L, x, false); b }
//     catch (e) { E = e; H = true }
//     finally { __Porffor_using_dispose(L, E, H) } }
// where the dispose call runs the resources last first and throws what the scope threw, or
// what disposing threw on top of it (a SuppressedError). x stays a plain const declaration,
// so an anonymous function in e is named x. With an await using in the scope, disposal is
// __Porffor_using_disposeAsync, awaited, but only once one has put something on the list
// (an await using never reached does not await). `for (using x of xs) body` keeps x as the
// loop's const (a new one per iteration, in its TDZ while xs is evaluated) and registers it
// first thing in the body; `for (using x = e; ;)` disposes x once the loop is done. A case
// clause cannot hold one directly.
const isUsing = node => node?.type === 'VariableDeclaration' && (node.kind === 'using' || node.kind === 'await using');

const lowerUsing = ast => {
  let next = 0;
  const at = node => ({ start: node.start, end: node.end });
  const id = (name, node) => ({ type: 'Identifier', name, ...at(node) });
  const call = (name, args, node) => ({ type: 'CallExpression', callee: id(name, node), arguments: args, optional: false, ...at(node) });
  const bool = (value, node) => ({ type: 'Literal', value, raw: String(value), ...at(node) });
  const declare = (kind, name, init, node) => ({
    type: 'VariableDeclaration', kind, ...at(node),
    declarations: [ { type: 'VariableDeclarator', id: id(name, node), init, ...at(node) } ]
  });

  // x onto the list, as a statement
  const add = (list, name, async, node) => ({
    type: 'ExpressionStatement', ...at(node),
    expression: call('__Porffor_using_add', [ id(list, node), id(name, node), bool(async, node) ], node)
  });

  // a using declaration in place: each binding a const, then its value onto the list. The
  // for...of lowering leaves a UsingRegister for its loop binding
  const register = (decl, list) => {
    if (decl.type === 'UsingRegister') return [ add(list, decl.name, decl.async, decl) ];
    return decl.declarations.flatMap(d => [
      { ...decl, kind: 'const', declarations: [ d ] },
      add(list, d.id.name, decl.kind === 'await using', d)
    ]);
  };
  const registers = x => isUsing(x) || x?.type === 'UsingRegister';
  const registersAsync = x => (isUsing(x) && x.kind === 'await using') || (x?.type === 'UsingRegister' && x.async);

  // statements run inside the try that disposes list; what goes before it
  const guard = (statements, list, async, node) => {
    const error = `porf$using$error${list.slice(15)}`, has = `porf$using$has${list.slice(15)}`, caught = `porf$using$caught${list.slice(15)}`;
    const args = () => [ id(list, node), id(error, node), id(has, node) ];
    let dispose = { type: 'ExpressionStatement', expression: call('__Porffor_using_dispose', args(), node), ...at(node) };
    if (async) dispose = {
      type: 'IfStatement', ...at(node),
      test: { type: 'MemberExpression', object: id(list, node), property: id('length', node), computed: false, optional: false, ...at(node) },
      consequent: { type: 'ExpressionStatement', ...at(node), expression: { type: 'AwaitExpression', argument: call('__Porffor_using_disposeAsync', args(), node), ...at(node) } },
      // nothing to dispose: only what the scope threw, if it did
      alternate: dispose
    };

    return [
      declare('const', list, { type: 'ArrayExpression', elements: [], ...at(node) }, node),
      declare('let', error, null, node),
      declare('let', has, bool(false, node), node),
      {
        type: 'TryStatement', ...at(node),
        block: { type: 'BlockStatement', body: statements, ...at(node) },
        handler: {
          type: 'CatchClause', param: id(caught, node), ...at(node),
          body: { type: 'BlockStatement', ...at(node), body: [
            { type: 'ExpressionStatement', ...at(node), expression: { type: 'AssignmentExpression', operator: '=', left: id(error, node), right: id(caught, node), ...at(node) } },
            { type: 'ExpressionStatement', ...at(node), expression: { type: 'AssignmentExpression', operator: '=', left: id(has, node), right: bool(true, node), ...at(node) } }
          ] }
        },
        finalizer: { type: 'BlockStatement', ...at(node), body: [ dispose ] }
      }
    ];
  };

  // a statement list holding a using declaration: the list, guarded
  const lowerList = (statements, node) => {
    if (!statements.some(registers)) return statements;
    const list = `porf$using$list${next++}`;
    return guard(statements.flatMap(x => registers(x) ? register(x, list) : [ x ]), list, statements.some(registersAsync), node);
  };

  const visit = node => {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = visit(node[i]);
      return node;
    }
    for (const key in node) {
      if (key[0] === '_' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (value && typeof value === 'object') node[key] = visit(value);
    }

    switch (node.type) {
      case 'BlockStatement':
      case 'StaticBlock':
        node.body = lowerList(node.body, node);
        break;

      case 'ForOfStatement':
      case 'ForInStatement':
        if (isUsing(node.left)) {
          const decl = node.left.declarations[0];
          const register = { type: 'UsingRegister', name: decl.id.name, async: node.left.kind === 'await using', ...at(decl) };
          node.left = { ...node.left, kind: 'const' };
          node.body = visit({ type: 'BlockStatement', body: [ register, node.body ], ...at(node.body) });
        }
        break;

      case 'ForStatement':
        if (isUsing(node.init)) {
          const init = node.init;
          node.init = null;
          return visit({ type: 'BlockStatement', body: [ init, node ], ...at(node) });
        }
        break;
    }
    return node;
  };

  // a module's top-level declarations would move into the try's block: bindings the rest of
  // the module (its exports, its hoisted functions) must see. Left as is there for now.
  if (ast.type === 'Program') {
    for (let i = 0; i < ast.body.length; i++) ast.body[i] = visit(ast.body[i]);
    return ast;
  }
  return visit(ast);
};

// A class method's super.x is read off its [[HomeObject]], which codegen reaches through the
// class's name. Semantic analysis runs before that, so it would not see the method use the
// name, and a class made inside a function would give its methods no capture of it (the
// read is null). Each method that reads super.x gets the name as homeRef, which analysis
// resolves like any reference and codegen reads the home object through. It runs before
// bindOwnNames, which then sees the class use its name. An anonymous class needs a name for
// this: the one it would be given (`const A = class {}` is A), with a # suffix codegen drops
// from the name it shows.
const usesSuperProperty = node => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesSuperProperty);
  if (node.type === 'MemberExpression' && node.object?.type === 'Super') return true;
  // their super is their own (an arrow's is its method's)
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') return false;
  if (node.type === 'Literal' || node.type === 'TemplateElement') return false;
  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (usesSuperProperty(node[key])) return true;
  }
  return false;
};

// the name an anonymous function or class takes from where it is (NamedEvaluation)
const inferredName = (parent, key) => {
  const target = parent?.type === 'VariableDeclarator' && key === 'init' ? parent.id
    : parent?.type === 'AssignmentExpression' && key === 'right' && parent.operator === '=' ? parent.left
    : parent?.type === 'AssignmentPattern' && key === 'right' ? parent.left
    : (parent?.type === 'Property' || parent?.type === 'PropertyDefinition') && key === 'value' && !parent.computed ? parent.key
    : null;
  if (target?.type === 'Identifier') return target.name;
  if (target?.type === 'Literal' && typeof target.value === 'string') return target.value;
  return '';
};

// arrows in a method that read super.x read it off the method's home object: each gets the
// name too (analysis then captures it through every arrow on the way)
const homeArrows = (node, name, isStatic, method) => {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(x => homeArrows(x, name, isStatic, method));
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') return;
  if (node.type === 'ArrowFunctionExpression' && (usesSuperProperty(node.params) || usesSuperProperty(node.body))) {
    node.homeRef = { type: 'Identifier', name, start: method.start, end: method.start };
    node.homeStatic = !!isStatic;
  }
  for (const key in node) {
    if (key[0] === '_' || key === 'loc' || key === 'range' || key === 'homeRef') continue;
    const value = node[key];
    if (value && typeof value === 'object') homeArrows(value, name, isStatic, method);
  }
};

const bindHomeObjects = (node, parent = null, parentKey = null) => {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(x => bindHomeObjects(x, parent, parentKey));
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    for (const x of node.body.body) {
      // (a constructor's too: its this may be another object, a parent's constructor's return)
      if (x.type !== 'MethodDefinition') continue;
      if (!usesSuperProperty(x.value.params) && !usesSuperProperty(x.value.body)) continue;
      node.id ??= { type: 'Identifier', name: `${inferredName(parent, parentKey)}#home_${node.start ?? 0}`, start: node.start, end: node.start };
      x.value.homeRef = { type: 'Identifier', name: node.id.name, start: x.start, end: x.start };
      homeArrows(x.value.params, node.id.name, x.static, x);
      homeArrows(x.value.body, node.id.name, x.static, x);
    }
  }
  for (const key in node) {
    if (key[0] === '_' || key === 'loc' || key === 'range' || key === 'homeRef') continue;
    const value = node[key];
    if (value && typeof value === 'object') bindHomeObjects(value, node, key);
  }
};

// entry: link options for a program entry ({ file?, scripts? }), null for a lone source;
// evalContext: a direct eval's caller's (see the parser)
export default (input, entry = null, evalContext = null) => {
  const types = Prefs.parseTypes || Prefs.t || globalThis.file?.endsWith('.ts');
  globalThis.typedInput = types && Prefs.optTypes;

  const file = entry?.file ?? globalThis.file;
  const linking = entry && file && !globalThis.precompile;
  const path = linking && (file[0] === '/' ? file : process.cwd() + '/' + file);
  // a native build with the runtime (--runtime): its globals set before the program runs (the
  // timers, over libuv's loop)
  const scripts = entry?.scripts ?? [];
  // the runtime's globals (runtime/globals.json), for a native build with it; so is serving an
  // entry's default export { fetch } (porffor:http-server)
  const globals = linking && Prefs.runtime && Prefs.target === 'native';
  let ast = linking && Prefs.module ? link(input, path, { ts: types, scripts, globals, serve: globals }) : parse(input, { module: !!Prefs.module, ts: types, evalContext });
  // a script's import() calls load modules too, and the runtime's globals go before it
  if (linking && !Prefs.module && (globals || (/\bimport\b/.test(input) && usesImportCall(ast)))) ast = link(input, path, { ts: types, script: ast, scripts, globals });
  if (ast._ts) globalThis.typedInput = Prefs.optTypes;
  bindHomeObjects(ast);
  bindOwnNames(ast);
  lowerUsing(ast);
  if (usesTemporal(ast)) ast._usesTemporal = true;
  if (usesIterProtocol(ast)) ast._usesIterProtocol = true;
  if (usesBigInt(ast)) ast._usesBigInt = true;
  markRegexFeatures(ast, ast);
  return ast;
};
