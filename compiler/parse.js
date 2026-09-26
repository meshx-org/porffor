import './prefs.js';
import parse from './parser/index.js';
import link from './modules.js';

// Whether the program can make an iterator of its own: it names Symbol.iterator or
// Symbol.asyncIterator (the only way to define one) or the Iterator global (Iterator.from
// wraps any object with a next). Without that, for...of, spread and destructuring only
// ever see built-in iterables, and the iterator protocol (a try/finally per loop, the
// protocol builtins) is left out of the program.
const usesIterProtocol = node => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesIterProtocol);

  if (node.type === 'Identifier') return node.name === 'Iterator';
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
            { ...node, type: node.type === 'ClassExpression' ? 'ClassDeclaration' : 'FunctionDeclaration' },
            { type: 'ReturnStatement', ...at, argument: { type: 'Identifier', ...at, name: node.id.name } }
          ]
        }
      }
    };
  }
  return node;
};

// entry: link options for a program entry ({ file?, scripts? }), null for a lone source
export default (input, entry = null) => {
  const types = Prefs.parseTypes || Prefs.t || globalThis.file?.endsWith('.ts');
  globalThis.typedInput = types && Prefs.optTypes;

  const file = entry?.file ?? globalThis.file;
  const ast = entry && Prefs.module && !globalThis.precompile ? link(input, file[0] === '/' ? file : process.cwd() + '/' + file, { ts: types, scripts: entry.scripts }) : parse(input, { module: !!Prefs.module, ts: types });
  if (ast._ts) globalThis.typedInput = Prefs.optTypes;
  bindOwnNames(ast);
  if (usesTemporal(ast)) ast._usesTemporal = true;
  if (usesIterProtocol(ast)) ast._usesIterProtocol = true;
  if (usesBigInt(ast)) ast._usesBigInt = true;
  return ast;
};
