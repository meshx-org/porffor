import './prefs.js';
import parse from './parser/index.js';
import { analyzeSelectors, selectedFiles } from './selectors.js';

const fs = (typeof process?.version !== 'undefined' ? (await import('node:fs')) : undefined);

const dirname = p => p.slice(0, p.lastIndexOf('/')) || '/';
const joinPath = (dir, rel) => {
  const parts = [];
  for (const x of (rel[0] === '/' ? rel : dir + '/' + rel).split('/')) {
    if (x === '..') parts.pop();
    else if (x !== '.' && x !== '') parts.push(x);
  }
  return '/' + parts.join('/');
};
// The runtime's modules resolve to paths under RUNTIME, which read from runtime/ beside the
// compiler or, in the selfhosted compiler (no import.meta), from the copies selfhosted/build.mjs
// puts in place of the line below. Node's modules are its files in runtime/node (node:fs or fs is
// node/fs.mjs, node:timers/promises node/timers/promises.mjs), the platform layer its files in
// runtime/host/native (porffor:fs is host/native/fs.mjs)
// @noble/hashes' scrypt.js, which the runtime replaces with scrypt's C (runtime/scrypt.mjs)
const NOBLE_SCRYPT = /[\\/]@noble[\\/]hashes[\\/](?:esm[\\/])?scrypt\.js$/;
const RUNTIME = '/$porffor/runtime';
const RUNTIME_FILES = null, RUNTIME_DIR = fs ? import.meta.dirname + '/../runtime' : null;
const runtimeFile = p => p.startsWith(RUNTIME + '/') ? p.slice(RUNTIME.length + 1) : null;

// the runtime's directory on disk, for what is not embedded (its C, runtime/c)
export const runtimeDir = () => RUNTIME_DIR;
// one of the runtime's files (a path under runtime/), as the linker reads and resolves it
export const runtimeSource = rel => readSource(`${RUNTIME}/${rel}`);

const isFile = p => {
  const rel = runtimeFile(p);
  if (rel !== null && RUNTIME_FILES) return Object.hasOwn(RUNTIME_FILES, rel);
  try { return fs.statSync(rel !== null ? RUNTIME_DIR + '/' + rel : p).isFile(); } catch { return false; }
};
const readSource = p => {
  const rel = runtimeFile(p);
  if (rel === null) return fs.readFileSync(p, 'utf8');
  return RUNTIME_FILES ? RUNTIME_FILES[rel] : fs.readFileSync(RUNTIME_DIR + '/' + rel, 'utf8');
};
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

export const hashId = str => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

const EXTENSIONS = [ '.ts', '.tsx', '.js', '.mjs', '.mts', '.cjs', '.json' ];
const resolveFile = p => {
  if (isFile(p)) return p;
  for (const ext of EXTENSIONS) if (isFile(p + ext)) return p + ext;
  // ts sources import their siblings as .js
  const stripped = p.replace(/\.[cm]?js$/, '');
  if (stripped !== p) for (const ext of EXTENSIONS) if (isFile(stripped + ext)) return stripped + ext;
  for (const ext of EXTENSIONS) if (isFile(p + '/index' + ext)) return p + '/index' + ext;
  return null;
};

const findPackage = (dir, name) => {
  for (;;) {
    const pkgDir = dir + '/node_modules/' + name;
    if (isFile(pkgDir + '/package.json')) return pkgDir;
    if (dir === '/') return null;
    dir = dirname(dir);
  }
};

// package.json "exports": subpath map with conditions, "*" patterns and array fallbacks
const resolveTarget = (target, conditions, star) => {
  if (typeof target === 'string') return star != null ? target.replace('*', star) : target;
  if (Array.isArray(target)) {
    for (const x of target) {
      const r = resolveTarget(x, conditions, star);
      if (r) return r;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const key in target) {
      if (key === 'default' || conditions.includes(key)) {
        const r = resolveTarget(target[key], conditions, star);
        if (r) return r;
      }
    }
  }
  return null;
};
// "exports" subpaths and "imports" #specifiers: exact keys, then "*" patterns
const resolveMap = (map, key, conditions) => {
  if (key in map) return resolveTarget(map[key], conditions);
  for (const pattern in map) {
    const i = pattern.indexOf('*');
    if (i === -1) continue;
    const pre = pattern.slice(0, i), post = pattern.slice(i + 1);
    if (key.startsWith(pre) && key.endsWith(post) && key.length >= pattern.length) {
      return resolveTarget(map[pattern], conditions, key.slice(pre.length, key.length - post.length));
    }
  }
  return null;
};
const resolveExports = (exports, subpath, conditions) => {
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports) || !Object.keys(exports).some(x => x[0] === '.')) {
    return subpath === '.' ? resolveTarget(exports, conditions) : null;
  }
  return resolveMap(exports, subpath, conditions);
};

const nearestPackage = dir => {
  for (;; dir = dirname(dir)) {
    if (isFile(dir + '/package.json')) return dir;
    if (dir === '/') return null;
  }
};

// the directory packages are looked up from: a runtime module's (whose path is virtual) is the
// runtime's on disk, so its own dependencies (@noble) resolve from Porffor's node_modules
const diskDir = from => {
  const rel = runtimeFile(from);
  return rel === null ? dirname(from) : dirname(RUNTIME_DIR + '/' + rel);
};

const resolve = (spec, from, cjs) => {
  // the platform layer the runtime is written against (porffor:async, clock, fs, ...): libuv's,
  // natively (a WASI build points these at its host's, runtime/host/wasi: wasi/scripts/bundle.mjs)
  if (spec.startsWith('porffor:')) {
    if (!Prefs.runtime) throw new Error(`porffor: ${spec} needs the runtime (--runtime)`);
    const file = `${RUNTIME}/host/native/${spec.slice(8)}.mjs`;
    if (!isFile(file)) throw new Error(`porffor: ${spec} is not a platform module`);
    return file;
  }
  // Node's modules are the runtime's: a program built without it (--runtime) has none, and a bare
  // name is Node's module only with the runtime (without it, a package's), as Node's win in Node
  if (spec.startsWith('node:')) {
    if (!Prefs.runtime) throw new Error(`porffor: ${spec} needs the runtime (--runtime)`);
    const file = `${RUNTIME}/node/${spec.slice(5)}.mjs`;
    if (!isFile(file)) throw new Error(`porffor: ${spec} is not provided`);
    return file;
  }
  if (Prefs.runtime && /^[a-z_]+(\/[a-z_]+)?$/.test(spec) && isFile(`${RUNTIME}/node/${spec}.mjs`)) return `${RUNTIME}/node/${spec}.mjs`;
  const conditions = [ 'porffor', 'worker', cjs ? 'require' : 'import', 'module', 'default', ...(Prefs.conditions ? String(Prefs.conditions).split(',') : []) ];
  let out = null;
  if (spec[0] === '.' || spec[0] === '/') out = resolveFile(joinPath(dirname(from), spec));
  else if (spec[0] === '#') {
    const pkgDir = nearestPackage(diskDir(from));
    const target = pkgDir && resolveMap(readJson(pkgDir + '/package.json').imports ?? {}, spec, conditions);
    out = target ? resolveFile(joinPath(pkgDir, target)) : null;
  } else {
    const scoped = spec[0] === '@';
    const nameEnd = spec.indexOf('/', scoped ? spec.indexOf('/') + 1 : 0);
    const name = nameEnd === -1 ? spec : spec.slice(0, nameEnd);
    const subpath = nameEnd === -1 ? '.' : '.' + spec.slice(nameEnd);
    const pkgDir = findPackage(diskDir(from), name);
    if (pkgDir) {
      const pkg = readJson(pkgDir + '/package.json');
      if (pkg.exports != null) {
        const target = resolveExports(pkg.exports, subpath, conditions);
        out = target ? resolveFile(joinPath(pkgDir, target)) : null;
      } else if (subpath === '.') out = resolveFile(joinPath(pkgDir, pkg.module ?? pkg.main ?? 'index.js'));
      else out = resolveFile(joinPath(pkgDir, subpath));
    }
  }
  if (!out) throw new Error(`porffor: cannot resolve '${spec}' from ${from}`);
  // @noble/hashes' scrypt, however it is imported: the runtime's, over scrypt's C
  if (Prefs.runtime && NOBLE_SCRYPT.test(out)) return `${RUNTIME}/scrypt.mjs`;
  return out;
};

// The globals a browser and WinterCG runtimes have, and Node's (runtime/globals.json), that the
// program names: a module installing them on globalThis (as the platform's own are: writable,
// configurable, not enumerable), and each global's provider file, whose export the program's own
// references are bound to (as esbuild's inject binds them in a WASI build: a bare `crypto` is
// the runtime's, not Porffor's builtin one). Null for none. A native build with the runtime can
// back every provider. What names a global is the program's code and Node's modules it imports
// (written as Node code, which assumes Node's globals); the runtime's other modules import what
// they use. A local that only looks like a global costs its provider's code; a property does not
const namesGlobals = mod => {
  const rel = runtimeFile(mod.file);
  return rel === null || rel.startsWith('node/');
};
// the names code may read as globals: every identifier but a property's name (obj.x, a key in an
// object literal, a method's or class field's: a server's `{ fetch(request) {} }` is no use of
// fetch), a globalThis property's (globalThis.fetch), and the words of every string
// (globalThis['fetch'], a source eval runs)
const GLOBAL_OBJECTS = [ 'globalThis', 'self', 'window', 'global' ];
const nameRefs = programs => {
  const out = new Set();
  const words = text => { for (const w of text.match(/[A-Za-z_$][\w$]*/g) ?? []) out.add(w); };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    switch (node.type) {
      case 'Identifier': out.add(node.name); return;
      case 'Literal': if (typeof node.value === 'string') words(node.value); return;
      case 'TemplateElement': words(node.value.raw); return;
      case 'MemberExpression':
        walk(node.object);
        if (node.computed || (node.object.type === 'Identifier' && GLOBAL_OBJECTS.includes(node.object.name))) walk(node.property);
        return;
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition': case 'AccessorProperty':
        if (node.computed) walk(node.key);
        walk(node.value);
        return;
    }
    for (const key in node) if (key !== 'start' && key !== 'end') walk(node[key]);
  };
  for (const program of programs) walk(program.body);
  return out;
};

const globalsPrelude = (mods, extraPrograms = []) => {
  const own = [ ...new Set(mods) ].filter(namesGlobals);
  const text = own.map(m => m.src).join('\n');
  const programs = [ ...own.filter(m => m.body).map(m => ({ type: 'Program', body: m.body })), ...extraPrograms ];
  const refs = nameRefs(programs);
  const manifest = JSON.parse(readSource(`${RUNTIME}/globals.json`));
  // the variants the program's selector values choose (a compression format, a Web Crypto
  // algorithm, an encoding label), every one of a selector passed a value it cannot see
  const selected = selectedFiles(manifest, analyzeSelectors(programs, manifest));
  const imports = [], defines = [], bindings = [];
  for (const provider of manifest.providers) {
    if (provider.trigger && !provider.trigger.some(word => new RegExp(`\\b${word}\\b`).test(text))) continue;
    if (selected.has(provider.file)) imports.push(`import './${provider.file}';`);
    // loaded for what it does on loading (byte streams plugging into ReadableStream)
    if (provider.load && new RegExp(provider.load).test(text)) imports.push(`import './${provider.file}';`);
    for (const name of provider.names) {
      if (!refs.has(name)) continue;
      imports.push(`import { ${name} as ${name}$ } from './${provider.file}';`);
      defines.push(`Object.defineProperty(globalThis, '${name}', { value: ${name}$, writable: true, configurable: true, enumerable: false });`);
      bindings.push({ name, file: `${RUNTIME}/${provider.file}` });
    }
  }
  return imports.length === 0 ? null : { source: imports.join('\n') + '\n' + defines.join('\n') + '\n', bindings };
};

// an entry that is CommonJS: a .cjs file, or a script (no module syntax, not a module by its
// package) that requires or exports
const isCommonJsEntry = (file, src) => !isEsmSource(file, src) && (/\.c[jt]s$/.test(file) || /\brequire\s*\(|\bmodule\.exports\b|\bexports\.\w/.test(src));

const isEsmSource = (file, src) => {
  if (/\.m[jt]s$/.test(file)) return true;
  if (/\.c[jt]s$/.test(file)) return false;
  const pkgDir = nearestPackage(dirname(file));
  if (pkgDir && readJson(pkgDir + '/package.json').type === 'module') return true;
  return /^\s*(?:import|export)\b/m.test(src);
};

// a script that names none of commonjs's bindings means the same as a module
const CJS_NAMES = new Set([ 'require', 'module', 'exports', '__filename', '__dirname' ]);
const usesCommonJs = node => {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesCommonJs);
  if (node.type === 'Identifier') return CJS_NAMES.has(node.name);
  for (const key in node) if (key !== 'start' && key !== 'end' && usesCommonJs(node[key])) return true;
  return false;
};

const ident = name => ({ type: 'Identifier', name });
const staticString = node => node.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
const errorName = name => [ 'SyntaxError', 'TypeError', 'ReferenceError', 'RangeError' ].includes(name) ? name : 'Error';
const funcDecl = (name, params, body) => ({ type: 'FunctionDeclaration', id: { type: 'Identifier', name }, params, async: false, generator: false, strict: true, body: { type: 'BlockStatement', body } });
const exprStmt = expression => ({ type: 'ExpressionStatement', expression });
const assign = (left, right) => ({ type: 'AssignmentExpression', operator: '=', left, right });
const callName = name => ({ type: 'CallExpression', callee: { type: 'Identifier', name }, arguments: [], optional: false });
const literal = value => ({ type: 'Literal', value });
const member = (object, name) => ({ type: 'MemberExpression', object, property: ident(name), computed: false, optional: false });
const property = (key, value, kind = 'init') => ({ type: 'Property', kind, computed: false, shorthand: false, method: false, key, value });
const varDecl = (kind, name, init) => ({
  type: 'VariableDeclaration', kind,
  declarations: [ { type: 'VariableDeclarator', id: ident(name), init } ]
});
const jsonToAst = value => {
  if (Array.isArray(value)) return { type: 'ArrayExpression', elements: value.map(jsonToAst) };
  if (value !== null && typeof value === 'object') {
    return { type: 'ObjectExpression', properties: Object.keys(value).map(key => property(literal(key), jsonToAst(value[key]))) };
  }
  return literal(value);
};

const patternNames = (node, out) => {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern': for (const x of node.properties) patternNames(x.type === 'Property' ? x.value : x.argument, out); break;
    case 'ArrayPattern': for (const x of node.elements) patternNames(x, out); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
  }
  return out;
};

const isFunc = node => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';

// names declared directly in a statement list (let/const/class/function)
const lexicalNames = (body, out) => {
  for (const x of body) {
    if (x.type === 'VariableDeclaration' && x.kind !== 'var') for (const d of x.declarations) patternNames(d.id, out);
    else if (x.type === 'FunctionDeclaration' || x.type === 'ClassDeclaration' || x.type === 'TSEnumDeclaration') { if (x.id) out.push(x.id.name); }
  }
  return out;
};
// var-declared names anywhere below, not crossing function boundaries
const varNames = (node, out) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) varNames(x, out); return out; }
  if (isFunc(node) || node.type === 'ClassExpression' || node.type === 'ClassDeclaration') return out;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const d of node.declarations) patternNames(d.id, out);
  for (const key in node) if (key !== 'start' && key !== 'end') varNames(node[key], out);
  return out;
};
const funcScopeNames = node => {
  const out = [];
  for (const p of node.params) patternNames(p, out);
  if (node.body.type === 'BlockStatement') { lexicalNames(node.body.body, out); varNames(node.body.body, out); }
  return out;
};

const SKIP_KEYS = new Set([ 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeArguments', 'implements', 'start', 'end' ]);
const TS_EXPR = new Set([ 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSInstantiationExpression' ]);

// side-effect free on evaluation, so droppable when unreferenced (src for @__PURE__ annotations)
const PURE_NEW = new Set([ 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp' ]);
const pureClass = (node, src) => (!node.superClass || node.superClass.type === 'Identifier') &&
  node.body.body.every(x => x.type !== 'StaticBlock' && !x.computed && (x.type !== 'PropertyDefinition' || !x.static || !x.value || pure(x.value, src)));
const pure = (node, src) => {
  switch (node.type) {
    case 'Literal': case 'Identifier': case 'FunctionExpression': case 'ArrowFunctionExpression': return true;
    case 'ClassExpression': return pureClass(node, src);
    case 'TemplateLiteral': return node.expressions.every(x => pure(x, src));
    case 'ArrayExpression': return node.elements.every(x => x === null || (x.type !== 'SpreadElement' && pure(x, src)));
    case 'ObjectExpression': return node.properties.every(x => x.type === 'Property' && !x.computed && pure(x.value, src));
    case 'UnaryExpression': return node.operator !== 'delete' && pure(node.argument, src);
    case 'BinaryExpression': case 'LogicalExpression': return pure(node.left, src) && pure(node.right, src);
    case 'ConditionalExpression': return pure(node.test, src) && pure(node.consequent, src) && pure(node.alternate, src);
    case 'NewExpression': case 'CallExpression': {
      const callee = node.callee;
      const known = callee.type === 'Identifier' && (node.type === 'NewExpression' ? PURE_NEW.has(callee.name) : callee.name === 'Symbol');
      const annotated = node.start != null && /\/\*\s*[@#]__PURE__\s*\*\/\s*$/.test(src.slice(Math.max(0, node.start - 40), node.start));
      return (known || annotated) && node.arguments.every(x => x.type !== 'SpreadElement' && pure(x, src));
    }
  }
  return false;
};
const countRefs = (node, refs) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) countRefs(x, refs); return; }
  if (node.type === 'Identifier') { if (node.name.includes('#m')) refs[node.name] = (refs[node.name] ?? 0) + 1; return; }
  for (const key in node) if (key !== 'start' && key !== 'end') countRefs(node[key], refs);
};

const constValue = node => {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '!') { const v = constValue(node.argument); return v === undefined ? undefined : !v; }
  if (node.type === 'BinaryExpression') {
    const l = constValue(node.left), r = constValue(node.right);
    if (l === undefined || r === undefined) return undefined;
    switch (node.operator) {
      case '===': case '==': return l === r;
      case '!==': case '!=': return l !== r;
    }
  }
  return undefined;
};

export default (entrySource, entryFile, opts = {}) => {
  const modules = new Map();
  const entryDir = dirname(entryFile);
  const nodeEnv = Prefs.d ? 'development' : 'production';
  let anyTs = false;

  // dynamic: a target of import(), which is a module unless it reads as commonjs
  const load = (file, source = null, kind = null, entry = false, dynamic = false) => {
    // the same file imported as text is a module of its own
    const key = kind === 'text' ? file + '\0text' : file;
    let mod = modules.get(key);
    if (mod) return mod;

    source ??= readSource(file);
    const rel = file.startsWith(entryDir + '/') ? file.slice(entryDir.length + 1) : file;
    mod = { file, rel, src: source, id: hashId(kind === 'text' ? rel + '\0text' : rel), entry, esm: true, exports: new Map(), stars: [], imports: [], deps: [], body: null, nsUsed: false };
    modules.set(key, mod);

    if (kind === 'json' || kind === 'text') {
      mod.json = kind === 'json';
      mod.body = [ varDecl('const', 'default', kind === 'json' ? jsonToAst(JSON.parse(source)) : literal(source)) ];
      mod.exports.set('default', { local: 'default' });
      return mod;
    }

    const ts = /\.[cm]?tsx?$/.test(file) || !!(entry ? opts.ts : Prefs.parseTypes || Prefs.t);
    anyTs ||= ts;
    // the entry is a module, but with the runtime a CommonJS one runs as Node runs it
    mod.esm = entry ? !(Prefs.runtime && isCommonJsEntry(file, source)) : isEsmSource(file, source);
    if (mod.esm) mod.body = parse(source, { module: true, ts }).body;
      else try {
        mod.body = parse(source, { module: false, ts }).body;
      } catch (e) {
        // as Node's syntax detection: a file that is no script but is a module (a top-level
        // await with no import or export to give it away) is a module
        try {
          mod.body = parse(source, { module: true, ts }).body;
          mod.esm = true;
        } catch {
          throw e;
        }
      }
    if (!mod.esm && dynamic && !usesCommonJs(mod.body)) {
      mod.body = parse(source, { module: true, ts }).body;
      mod.esm = true;
    }
    if (mod.esm) collectModule(mod);
    else mod.body.unshift(
      varDecl('const', 'module', { type: 'ObjectExpression', properties: [ property(ident('exports'), { type: 'ObjectExpression', properties: [] }) ] }),
      varDecl('let', 'exports', member(ident('module'), 'exports'))
    );
    return mod;
  };

  const dep = (mod, node, lazy = false) => {
    const attrs = node.attributes ?? [];
    const type = attrs.find(x => (x.key.name ?? x.key.value) === 'type')?.value.value;
    let file;
    try {
      file = resolve(node.source.value, mod.file, !mod.esm);
    } catch (e) {
      // dynamic import() and require() of something unresolvable fail when they run
      if (!lazy) throw e;
      return { error: e.message };
    }
    const kind = type === 'json' || type === 'text' ? type : (file.endsWith('.json') ? 'json' : null);
    const d = load(file, null, kind);
    if (!mod.deps.includes(d)) mod.deps.push(d);
    return d;
  };
  // import() of a module that fails to load (unresolvable, a syntax error, a static import of
  // its failing) rejects when it runs, so the failure is kept and what it loaded dropped
  const dynamicDep = (mod, spec, type) => {
    const before = new Set(modules.keys());
    let file = null;
    try {
      file = resolve(spec, mod.file, false);
      return load(file, null, type === 'json' || type === 'text' ? type : (file.endsWith('.json') ? 'json' : null), false, true);
    } catch (e) {
      for (const key of [ ...modules.keys() ]) if (!before.has(key)) modules.delete(key);
      return { error: e.message, name: e.name, resolved: file != null };
    }
  };
  const loadName = d => { d.loadUsed = true; return ident(`#load#m${d.id}`); };
  const throwingFunc = (name, message) => ({ type: 'FunctionExpression', id: null, params: [], async: false, generator: false, body: { type: 'BlockStatement', body: [
    { type: 'ThrowStatement', argument: { type: 'NewExpression', callee: ident(errorName(name)), arguments: [ literal(message) ] } }
  ] } });
  // the type attribute when the options are written out: import(x, { with: { type: 'json' } })
  const attributeType = options => {
    const key = x => !x.computed && (x.key.name ?? x.key.value);
    const attrs = options?.type === 'ObjectExpression' && options.properties.find(x => x.type === 'Property' && key(x) === 'with')?.value;
    const type = attrs?.type === 'ObjectExpression' && attrs.properties.find(x => x.type === 'Property' && key(x) === 'type')?.value;
    return type?.type === 'Literal' ? type.value : null;
  };
  // import(specifier, options): the call checks and ToStrings its arguments, then runs the load
  // function its specifier resolves to. a computed specifier resolves at run time, among the
  // relative paths the importing file spells out
  const importCall = (mod, node, walk) => {
    const spec = staticString(node.source);
    const source = walk(node.source), options = node.options ? walk(node.options) : { type: 'UnaryExpression', operator: 'void', prefix: true, argument: literal(0) };
    let load;
    if (node.phase === 'source') load = throwingFunc('SyntaxError', 'porffor: source phase imports are not supported');
      else if (spec != null) {
        const d = dynamicDep(mod, spec, attributeType(node.options));
        load = d.error ? throwingFunc(d.name, d.error) : loadName(d);
      } else {
        mod.resolver ??= resolverCases(mod);
        load = ident(`#resolve#m${mod.id}`);
      }
    return { type: 'CallExpression', callee: ident('__Porffor_import'), arguments: [ load, source, options ], optional: false };
  };
  const resolverCases = mod => {
    const cases = new Map();
    for (const [ , , spec ] of mod.src.matchAll(/(['"`])(\.{0,2}\/[^'"`\\\n$]*)\1/g)) {
      if (cases.has(spec)) continue;
      const d = dynamicDep(mod, spec, null);
      if (!d.error) cases.set(spec, loadName(d));
        else if (d.resolved) cases.set(spec, throwingFunc(d.name, d.error));
    }
    return cases;
  };
  const resolverFunc = mod => {
    const key = ident('key');
    const cases = [ ...mod.resolver ].map(([ spec, load ]) => ({ type: 'SwitchCase', test: literal(spec), consequent: [
      { type: 'ReturnStatement', argument: { type: 'CallExpression', callee: load, arguments: [], optional: false } }
    ] }));
    const message = { type: 'BinaryExpression', operator: '+', left: { type: 'BinaryExpression', operator: '+', left: literal(`porffor: cannot resolve '`), right: key }, right: literal(`' from ${mod.file}`) };
    return funcDecl(`#resolve#m${mod.id}`, [ key ], [
      { type: 'SwitchStatement', discriminant: key, cases },
      { type: 'ThrowStatement', argument: { type: 'NewExpression', callee: ident('Error'), arguments: [ message ] } }
    ]);
  };

  const exportName = node => node.name ?? node.value;
  const throwExpr = (message, error = 'Error') => ({ type: 'CallExpression', optional: false, arguments: [], callee: { type: 'ArrowFunctionExpression', params: [], async: false, generator: false, expression: false, body: { type: 'BlockStatement', body: [
    { type: 'ThrowStatement', argument: { type: 'NewExpression', callee: ident(error), arguments: [ literal(message) ] } }
  ] } } });

  // import/export syntax becomes binding records, the rest of the body stays
  const collectModule = mod => {
    const body = [];
    for (const node of mod.body) {
      switch (node.type) {
        case 'ImportDeclaration': {
          if (node.importKind === 'type') break;
          const d = dep(mod, node);
          for (const spec of node.specifiers) {
            if (spec.importKind === 'type') continue;
            const name = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : exportName(spec.imported);
            mod.imports.push({ local: spec.local.name, dep: d, name, spec: node.source.value });
          }
          break;
        }

        case 'ExportAllDeclaration': {
          const d = dep(mod, node);
          if (node.exported) mod.exports.set(exportName(node.exported), { ns: d });
          else mod.stars.push(d);
          break;
        }

        case 'ExportNamedDeclaration': {
          if (node.exportKind === 'type') break;
          if (node.declaration) {
            const decl = node.declaration;
            body.push(decl);
            if (decl.type.startsWith('TS') && decl.type !== 'TSEnumDeclaration') break;
            if (decl.type === 'VariableDeclaration') {
              for (const d of decl.declarations) for (const name of patternNames(d.id, [])) mod.exports.set(name, { local: name });
            } else mod.exports.set(decl.id.name, { local: decl.id.name });
            break;
          }
          const d = node.source ? dep(mod, node) : null;
          for (const spec of node.specifiers) {
            if (spec.exportKind === 'type') continue;
            const local = exportName(spec.local);
            mod.exports.set(exportName(spec.exported), d ? { from: d, name: local } : { local });
          }
          break;
        }

        case 'ExportDefaultDeclaration': {
          const decl = node.declaration;
          if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
            decl.id ??= ident('default');
            body.push(decl);
            mod.exports.set('default', { local: decl.id.name });
          } else if (!decl.type.startsWith('TS')) {
            body.push(varDecl('const', 'default', decl));
            mod.exports.set('default', { local: 'default' });
          }
          break;
        }

        case 'TSExportAssignment':
          body.push(varDecl('const', 'default', node.expression));
          mod.exports.set('default', { local: 'default' });
          break;

        case 'TSImportEqualsDeclaration':
          if (node.moduleReference.type !== 'TSExternalModuleReference') break;
          body.push(varDecl('const', node.id.name, { type: 'CallExpression', callee: ident('require'), arguments: [ node.moduleReference.expression ], optional: false }));
          if (node.isExport) mod.exports.set(node.id.name, { local: node.id.name });
          break;

        default:
          body.push(node);
      }
    }
    mod.body = body;
  };

  let exoticNamespaces = false;
  const globalName = (mod, name) => `${name}#m${mod.id}`;
  const nsName = mod => { mod.nsUsed = true; return `#ns#m${mod.id}`; };
  const exportsOf = mod => member(ident(globalName(mod, 'module')), 'exports');

  // where an export lives: { global } renamed esm binding, { ns } a namespace, { cjs, prop } a property of module.exports
  const resolveExport = (mod, name, seen = Object.create(null)) => {
    if (!mod.esm) return { cjs: mod, prop: name === 'default' ? null : name };
    const key = mod.id + ':' + name;
    if (seen[key]) return null;
    seen[key] = true;

    const own = mod.exports.get(name);
    if (own) {
      if (own.ns) return { ns: own.ns };
      if (own.local == null) return resolveExport(own.from, own.name, seen);
      // exporting an import binding forwards to where it came from
      const imp = mod.imports.find(x => x.local === own.local);
      if (!imp) return { global: globalName(mod, own.local) };
      if (imp.name === '*') return imp.dep.esm ? { ns: imp.dep } : { cjs: imp.dep, prop: null };
      return resolveExport(imp.dep, imp.name, seen);
    }
    if (name === 'default') return null;
    for (const star of mod.stars) {
      const r = resolveExport(star, name, seen);
      if (r) return r;
    }
    return null;
  };
  const exportNames = (mod, out = Object.create(null), seen = Object.create(null)) => {
    if (seen[mod.id]) return out;
    seen[mod.id] = true;
    for (const name of mod.exports.keys()) out[name] = true;
    for (const star of mod.stars) for (const name in exportNames(star, Object.create(null), seen)) if (name !== 'default') out[name] = true;
    return out;
  };
  const exportExpr = r => r.global ? ident(r.global) : r.ns ? ident(nsName(r.ns)) : r.prop != null ? member(exportsOf(r.cjs), r.prop) : exportsOf(r.cjs);

  // esm namespace: live getters. cjs: module.exports itself
  const namespaceExpr = mod => {
    if (!mod.esm) return exportsOf(mod);
    const properties = [];
    for (const name of Object.keys(exportNames(mod)).sort()) {
      const r = resolveExport(mod, name);
      if (!r || strictResolve(mod, name) === AMBIGUOUS) continue;
      properties.push(property(literal(name), { type: 'FunctionExpression', id: null, params: [], async: false, generator: false, body: { type: 'BlockStatement', body: [ { type: 'ReturnStatement', argument: exportExpr(r) } ] } }, 'get'));
    }
    const bindings = { type: 'ObjectExpression', properties };
    // with import() in the program, a namespace is the exotic object; else plain getters do
    return exoticNamespaces ? { type: 'CallExpression', callee: ident('__Porffor_namespace'), arguments: [ bindings ], optional: false } : bindings;
  };

  // ResolveExport as the spec has it: null for a missing or circular export, AMBIGUOUS when
  // star exports provide it from two bindings
  const AMBIGUOUS = { ambiguous: true };
  const sameBinding = (a, b) => a.global ? a.global === b.global : a.ns ? a.ns === b.ns : a.cjs === b.cjs && a.prop === b.prop;
  const strictResolve = (mod, name, seen = new Set()) => {
    if (!mod.esm) return { cjs: mod, prop: name === 'default' ? null : name };
    const key = mod.id + ':' + name;
    if (seen.has(key)) return null;
    seen.add(key);

    const own = mod.exports.get(name);
    if (own) {
      if (own.ns) return { ns: own.ns };
      if (own.local == null) return strictResolve(own.from, own.name, seen);
      const imp = mod.imports.find(x => x.local === own.local);
      if (!imp) return { global: globalName(mod, own.local) };
      if (imp.name === '*') return imp.dep.esm ? { ns: imp.dep } : { cjs: imp.dep, prop: null };
      return strictResolve(imp.dep, imp.name, seen);
    }
    if (name === 'default') return null;
    let found = null;
    for (const star of mod.stars) {
      const r = strictResolve(star, name, seen);
      if (r === AMBIGUOUS) return r;
      if (!r) continue;
      if (found && !sameBinding(found, r)) return AMBIGUOUS;
      found ??= r;
    }
    return found;
  };
  // what linking a module import() reaches throws, as [ error name, message ]: an indirect
  // export or an import that does not resolve to one binding
  const linkFailure = mod => {
    for (const [ name, own ] of mod.exports) {
      if (own.local != null && !mod.imports.some(x => x.local === own.local)) continue;
      const r = strictResolve(mod, name);
      if (!r || r === AMBIGUOUS) return [ 'SyntaxError', `The export '${name}' of ${mod.rel} ${r ? 'is ambiguous' : 'cannot be resolved'}` ];
    }
    for (const imp of mod.imports) {
      if (imp.name === '*') continue;
      const r = strictResolve(imp.dep, imp.name);
      if (!r || r === AMBIGUOUS) return [ 'SyntaxError', `The requested module '${imp.spec}' ${r ? 'has an ambiguous export' : 'does not provide an export'} named '${imp.name}'` ];
    }
    return null;
  };
  const topLevelForAwait = node => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(topLevelForAwait);
    if (isFunc(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return false;
    if (node.type === 'ForOfStatement' && node.await) return true;
    for (const key in node) if (key !== 'start' && key !== 'end' && topLevelForAwait(node[key])) return true;
    return false;
  };
  // a top-level await waits as the program's own do, running jobs until it settles
  const awaitSync = node => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = awaitSync(node[i]); return node; }
    if (isFunc(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return node;
    if (node.type === 'AwaitExpression') return { type: 'CallExpression', callee: ident('__Porffor_promise_awaitSync'), arguments: [ awaitSync(node.argument) ], optional: false };
    for (const key in node) if (key !== 'start' && key !== 'end') node[key] = awaitSync(node[key]);
    return node;
  };

  // a module import() loads: its bindings become program globals and its statements a function
  // that runs it once, on the first import (its static imports first), keeping how it failed
  const lazyBody = mod => {
    const lets = [], out = [], run = [];
    // a function declaration is its own global
    const declared = new Set(mod.body.filter(x => x.type === 'FunctionDeclaration').map(x => x.id.name));
    const declare = name => { if (!declared.has(name)) { declared.add(name); lets.push(varDecl('let', name, null)); } };
    for (const name of varNames(mod.body, [])) declare(name);

    // var declarations anywhere at its top level assign the globals instead
    const unvar = (node, pos = 'stmt') => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = unvar(node[i]); return node; }
      if (isFunc(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return node;
      if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        if (pos === 'left') return node.declarations[0].id;
        const assigns = node.declarations.filter(d => d.init).map(d => assign(d.id, d.init));
        const expr = assigns.length === 0 ? null : assigns.length === 1 ? assigns[0] : { type: 'SequenceExpression', expressions: assigns };
        if (pos === 'init') return expr;
        return expr ? exprStmt(expr) : { type: 'EmptyStatement' };
      }
      for (const key in node) {
        if (key === 'start' || key === 'end' || !node[key] || typeof node[key] !== 'object') continue;
        const pos = key === 'init' && node.type === 'ForStatement' ? 'init' : key === 'left' && (node.type === 'ForInStatement' || node.type === 'ForOfStatement') ? 'left' : 'stmt';
        node[key] = unvar(node[key], pos);
      }
      return node;
    };

    for (const x of mod.body) {
      if (x.type === 'FunctionDeclaration') { x.strict = true; out.push(x); continue; }
      if (x.type === 'ClassDeclaration') {
        declare(x.id.name);
        run.push(exprStmt(assign(ident(x.id.name), { ...x, type: 'ClassExpression' })));
        continue;
      }
      if (x.type === 'VariableDeclaration' && x.kind !== 'var') {
        for (const d of x.declarations) {
          for (const name of patternNames(d.id, [])) declare(name);
          if (d.init) run.push(exprStmt(assign(d.id, d.init)));
        }
        continue;
      }
      run.push(unvar(x));
    }

    const ran = `#ran#m${mod.id}`, error = `#error#m${mod.id}`;
    lets.push(varDecl('let', ran, literal(false)), varDecl('let', error, null));

    const deps = mod.deps.filter(d => d.lazy).map(d => exprStmt(callName(`#run#m${d.id}`)));
    out.push(funcDecl(`#run#m${mod.id}`, [], [
      { type: 'IfStatement', test: ident(error), consequent: { type: 'ThrowStatement', argument: { type: 'MemberExpression', object: ident(error), property: literal(0), computed: true, optional: false } }, alternate: null },
      { type: 'IfStatement', test: ident(ran), consequent: { type: 'ReturnStatement', argument: null }, alternate: null },
      exprStmt(assign(ident(ran), literal(true))),
      ...(mod.nsExpr ? [ exprStmt(assign(ident(nsName(mod)), mod.nsExpr)) ] : []),
      { type: 'TryStatement', block: { type: 'BlockStatement', body: [ ...deps, ...awaitSync(run) ] }, handler: { type: 'CatchClause', param: ident('e'), body: { type: 'BlockStatement', body: [
        exprStmt(assign(ident(error), { type: 'ArrayExpression', elements: [ ident('e') ] })),
        { type: 'ThrowStatement', argument: ident('e') }
      ] } }, finalizer: null }
    ]));
    return { lets, out };
  };

  // map: original name -> new name or replacement node
  const rename = (mod, map, imported) => {
    const scopes = [];
    const shadowed = name => scopes.some(s => s.includes(name));
    const firstRef = new Map();
    const requireTarget = node => {
      // (a module's own top-level require, createRequire's, is its to call)
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'require' || shadowed('require') || map.has('require') || node.arguments.length !== 1 || typeof node.arguments[0].value !== 'string') return null;
      const d = dep(mod, { source: node.arguments[0] }, true);
      if (d.error) return throwExpr(d.error);
      if (d.json) return ident(globalName(d, 'default'));
      if (!d.esm) return exportsOf(d);
      // Node's modules (the runtime's, ES modules) are what Node's require gives: their default
      const rel = runtimeFile(d.file);
      if (rel !== null && rel.startsWith('node/') && d.exports.has('default')) return member(ident(nsName(d)), 'default');
      return ident(nsName(d));
    };
    const scoped = (names, fn) => { scopes.push(names); fn(); scopes.pop(); };
    const walkKeys = node => {
      for (const key in node) {
        if (SKIP_KEYS.has(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object') v[i] = walk(v[i]); }
        else if (v && typeof v === 'object' && v.type) node[key] = walk(v);
      }
      return node;
    };
    const walk = node => {
      switch (node.type) {
        case 'Identifier': {
          const to = map.get(node.name);
          if (to === undefined || shadowed(node.name)) return node;
          if (node.start < (firstRef.get(node.name) ?? Infinity)) firstRef.set(node.name, node.start);
          if (typeof to === 'string') { node.name = to; return node; }
          if (to.ns) { node.name = nsName(to.ns); return node; }
          return to;
        }

        case 'MemberExpression': {
          if (!node.computed && node.property.name === 'NODE_ENV' && node.object.type === 'MemberExpression' && !node.object.computed &&
              node.object.property.name === 'env' && node.object.object.type === 'Identifier' && node.object.object.name === 'process' && !shadowed('process')) return literal(nodeEnv);
          // ns.name reads the export directly: the namespace object only exists for other uses
          const ns = node.object.type === 'Identifier' && !shadowed(node.object.name) ? map.get(node.object.name)?.ns : null;
          if (ns && !node.computed) {
            const r = resolveExport(ns, node.property.name);
            if (r) return exportExpr(r);
          }
          node.object = walk(node.object);
          if (node.computed) node.property = walk(node.property);
          return node;
        }

        case 'MetaProperty':
          if (node.meta.name === 'import') return { type: 'ObjectExpression', properties: [ property(ident('url'), literal('file://' + mod.file)) ] };
          return node;

        case 'ImportExpression':
          return importCall(mod, node, walk);

        case 'CallExpression':
          return requireTarget(node) ?? walkKeys(node);

        case 'AssignmentExpression':
        case 'UpdateExpression': {
          const target = node.left ?? node.argument;
          if (target.type === 'Identifier' && imported[target.name] && !shadowed(target.name)) return throwExpr('Assignment to constant variable.', 'TypeError');
          return walkKeys(node);
        }

        case 'Property':
        case 'MethodDefinition':
        case 'PropertyDefinition':
          if (node.computed) node.key = walk(node.key);
          if (node.value) node.value = walk(node.value);
          if (node.shorthand && (node.value.name ?? node.value.left?.name) !== node.key.name) node.shorthand = false;
          return node;

        case 'LabeledStatement':
          node.body = walk(node.body);
          return node;
        case 'BreakStatement':
        case 'ContinueStatement':
        case 'PrivateIdentifier':
          return node;

        case 'IfStatement':
        case 'ConditionalExpression': {
          node.test = walk(node.test);
          const v = constValue(node.test);
          if (v === undefined) return walkKeys(node);
          const branch = v ? node.consequent : node.alternate;
          const kept = branch ? walk(branch) : { type: 'EmptyStatement' };
          // keep the dropped branch's vars declared
          const vars = varNames(v ? node.alternate : node.consequent, []);
          if (vars.length === 0) return kept;
          const decl = { type: 'VariableDeclaration', kind: 'var', declarations: vars.map(x => ({ type: 'VariableDeclarator', id: ident(x), init: null })) };
          return { type: 'BlockStatement', body: [ walk(decl), kept ] };
        }

        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          if (node.id && node.type === 'FunctionDeclaration') node.id = walk(node.id);
          scoped(funcScopeNames(node).concat(node.type === 'FunctionExpression' && node.id ? [ node.id.name ] : []), () => walkKeys(node));
          return node;

        case 'ClassDeclaration':
        case 'ClassExpression':
          if (node.id && node.type === 'ClassDeclaration') node.id = walk(node.id);
          if (node.superClass) node.superClass = walk(node.superClass);
          scoped(node.id ? [ node.id.name ] : [], () => { node.body = walk(node.body); });
          return node;

        case 'BlockStatement':
        case 'StaticBlock':
          scoped(lexicalNames(node.body, []), () => walkKeys(node));
          return node;
        case 'SwitchStatement':
          node.discriminant = walk(node.discriminant);
          scoped(lexicalNames(node.cases.flatMap(x => x.consequent), []), () => { node.cases = node.cases.map(walk); });
          return node;
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement': {
          const head = node.init ?? node.left;
          scoped(head?.type === 'VariableDeclaration' && head.kind !== 'var' ? lexicalNames([ head ], []) : [], () => walkKeys(node));
          return node;
        }
        case 'CatchClause':
          scoped(patternNames(node.param, []), () => walkKeys(node));
          return node;

        case 'TSEnumDeclaration':
          node.id = walk(node.id);
          for (const m of node.members) if (m.initializer) m.initializer = walk(m.initializer);
          return node;

        default:
          if (node.type.startsWith('TS')) {
            if (TS_EXPR.has(node.type)) node.expression = walk(node.expression);
            return node;
          }
          return walkKeys(node);
      }
    };
    const classes = mod.body.filter(x => x.type === 'ClassDeclaration').map(x => [ x, x.id.name ]);
    for (let i = 0; i < mod.body.length; i++) mod.body[i] = walk(mod.body[i]);

    // classes used before their declaration become hoisted vars
    for (const [ decl, name ] of classes) {
      if (!(firstRef.get(name) < decl.start)) continue;
      mod.body[mod.body.indexOf(decl)] = varDecl('var', decl.id.name, { ...decl, type: 'ClassExpression' });
    }
  };

  // a script entry is no module: its names stay as they are, only its import() calls change
  let entryMod, script = null;
  if (opts.script) {
    const rel = entryFile.slice(entryDir.length + 1);
    entryMod = { file: entryFile, rel, src: entrySource, id: hashId(rel), script: true, deps: [] };
    const walk = node => {
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) if (node[i] && typeof node[i] === 'object') node[i] = walk(node[i]); return node; }
      if (node.type === 'ImportExpression') return importCall(entryMod, node, walk);
      for (const key in node) if (key !== 'start' && key !== 'end' && node[key] && typeof node[key] === 'object') node[key] = walk(node[key]);
      return node;
    };
    script = walk(opts.script.body);
  } else entryMod = load(entryFile, entrySource, null, true);
  // a program whose entry exports default { fetch } is a server, as in Bun (and as a WASI build
  // makes it the wasi:http handler export): a module after the entry serves it
  // (porffor:http-server, runtime/serve.mjs). Only such an entry brings the server in
  let root = entryMod;
  if (opts.serve && entryMod.esm && entryMod.exports.has('default') && /\bfetch\b/.test(entrySource)) {
    root = load(`${RUNTIME}/serve.gen.mjs`, `import app from ${JSON.stringify(entryFile)};\nimport { serve } from 'porffor:http-server';\n\nif (typeof app?.fetch === 'function') serve(app);\n`);
  }
  // the runtime's globals the program names, installed before it runs
  let globalBindings = [];
  if (opts.globals) {
    const prelude = globalsPrelude([ entryMod, ...modules.values() ], script ? [ { type: 'Program', body: script } ] : []);
    if (prelude !== null) {
      entryMod.deps.unshift(load(`${RUNTIME}/globals.gen.mjs`, prelude.source));
      globalBindings = prelude.bindings.map(x => ({ ...x, pattern: new RegExp(`\\b${x.name}\\b`), dep: modules.get(x.file) }));
    }
  }

  // evaluation order: dependencies first. A dependency still being visited is a cycle: every
  // module on the path back to it is in one (cyclic)
  const order = [];
  const visiting = [];
  const visitPost = mod => {
    if (mod.ordered) {
      const at = visiting.indexOf(mod);
      if (at !== -1) for (let i = at; i < visiting.length; i++) visiting[i].cyclic = true;
      return;
    }
    mod.ordered = true;
    visiting.push(mod);
    for (const d of mod.deps) visitPost(d);
    visiting.pop();
    order.push(mod);
  };

  // cjs require() targets are discovered while renaming, so rename in load order first
  for (;;) {
    const pending = [ ...modules.values() ].filter(m => !m.renamed);
    if (pending.length === 0) break;
    for (const mod of pending) {
      mod.renamed = true;
      const map = new Map();
      for (const name of lexicalNames(mod.body, varNames(mod.body, []))) map.set(name, globalName(mod, name));
      // a CommonJS module's file and directory, and (as Bun has them) an ES module's that does not
      // declare its own
      if (!mod.esm || (opts.globals && namesGlobals(mod))) {
        if (!map.has('__filename')) map.set('__filename', literal(mod.file));
        if (!map.has('__dirname')) map.set('__dirname', literal(dirname(mod.file)));
      }
      // the runtime's globals it names, bound to their providers' exports (unless it declares them)
      if (!mod.script && namesGlobals(mod)) {
        for (const g of globalBindings) {
          if (map.has(g.name) || !g.pattern.test(mod.src)) continue;
          const r = resolveExport(g.dep, g.name);
          if (r?.global) map.set(g.name, r.global);
        }
      }
      const snapshots = [];
      const imported = Object.create(null);
      for (const imp of mod.imports) {
        imported[imp.local] = true;
        const r = imp.name === '*' ? (imp.dep.esm ? { ns: imp.dep } : { cjs: imp.dep, prop: null }) : resolveExport(imp.dep, imp.name);
        // only import() may reach this module, where it fails as the import() rejecting
        if (!r) { mod.linkError = new SyntaxError(`The requested module '${imp.spec}' does not provide an export named '${imp.name}'`); break; }
        if (r.global) { map.set(imp.local, r.global); continue; }
        if (r.ns) { map.set(imp.local, r.ns.esm ? { ns: r.ns } : nsName(r.ns)); continue; }
        // cjs exports are read once after the module ran. default follows __esModule interop
        const value = imp.name === 'default' ? {
          type: 'ConditionalExpression', test: member(exportsOf(r.cjs), '__esModule'), consequent: member(exportsOf(r.cjs), 'default'), alternate: exportsOf(r.cjs)
        } : exportExpr(r);
        const name = globalName(mod, imp.local);
        map.set(imp.local, name);
        snapshots.push(varDecl('const', name, value));
      }
      if (mod.linkError) continue;
      rename(mod, map, imported);
      mod.body.unshift(...snapshots);
    }
  }

  // (a script entry is not a module: what it depends on is only the runtime's prelude)
  if (!script) visitPost(root);
  else for (const d of entryMod.deps) visitPost(d);
  for (const mod of order) if (mod.linkError) throw mod.linkError;

  // modules only import() reaches run on the first import that does, their static imports first
  const lazy = [];
  const visitLazy = mod => {
    if (mod.ordered) return;
    mod.ordered = true;
    mod.lazy = true;
    for (const d of mod.deps) visitLazy(d);
    lazy.push(mod);
  };
  for (const mod of modules.values()) visitLazy(mod);
  for (const mod of lazy) {
    if (mod.linkError) mod.failure = [ 'SyntaxError', mod.linkError.message ];
      else if (mod.esm) mod.failure = linkFailure(mod) ?? (topLevelForAwait(mod.body) ? [ 'Error', 'porffor: top-level for await in a module import() loads is not supported' ] : null);
  }
  for (let more = true; more;) {
    more = false;
    for (const mod of lazy) {
      const failed = !mod.failure && mod.deps.find(d => d.failure);
      if (failed) { mod.failure = failed.failure; more = true; }
    }
  }

  const loaders = [];
  for (const mod of [ ...order, ...lazy ]) {
    if (!mod.loadUsed) continue;
    const name = `#load#m${mod.id}`;
    if (mod.failure) loaders.push(funcDecl(name, [], throwingFunc(...mod.failure).body.body));
      else loaders.push(funcDecl(name, [], [
        ...(mod.lazy ? [ exprStmt(callName(`#run#m${mod.id}`)) ] : []),
        { type: 'ReturnStatement', argument: mod.esm ? ident(nsName(mod)) : exportsOf(mod) }
      ]));
  }
  for (const mod of new Set([ entryMod, ...modules.values() ])) if (mod.resolver) loaders.push(resolverFunc(mod));

  exoticNamespaces = [ ...modules.values() ].some(mod => mod.loadUsed);
  const live = [ ...order, ...lazy.filter(mod => !mod.failure) ];
  for (let more = true; more;) {
    more = false;
    for (const mod of live) {
      if (!mod.nsUsed || mod.nsExpr) continue;
      mod.nsExpr = namespaceExpr(mod);
      more = true;
    }
  }
  const body = [];
  // host scripts define globals, so they stay unrenamed and run first
  for (let i = 0; i < (opts.scripts ?? []).length; i++) {
    for (const x of parse(opts.scripts[i], { module: false }).body) { x._unit = 'script' + i; body.push(x); }
  }
  // a script's directives stay first
  if (script) while (script[0]?.directive) body.push(script.shift());
  // namespaces declared up front for cycles, filled after the module's last class
  for (const mod of live) {
    if (mod.nsExpr) body.push(varDecl('let', nsName(mod), null));
  }
  // what import() reaches is declared before all else, in no unit: a unit only sees the
  // functions of units before it, and import() goes both ways. the functions are generated
  // once the program is (so is a namespace, made when its module first runs)
  const lazyBodies = lazy.filter(mod => !mod.failure).map(lazyBody);
  for (const { lets } of lazyBodies) body.push(...lets);
  body.push(...loaders);
  for (const { out } of lazyBodies) body.push(...out);
  // the function declarations of modules in a cycle exist before any of them runs (linking
  // instantiates them): one that runs first can call another's (a unit only sees the functions
  // of units before it), so they go first, in no unit
  for (const mod of order) {
    if (!mod.cyclic || !mod.esm) continue;
    for (const x of mod.body) if (x.type === 'FunctionDeclaration') { x.strict = true; body.push(x); }
  }
  for (const mod of order) {
    if (mod.nsExpr) {
      const at = mod.body.findLastIndex(x => x.type === 'ClassDeclaration') + 1;
      mod.body.splice(at, 0, { type: 'ExpressionStatement', expression: { type: 'AssignmentExpression', operator: '=', left: ident(nsName(mod)), right: mod.nsExpr } });
    }
    for (const x of mod.body) {
      if (mod.cyclic && mod.esm && x.type === 'FunctionDeclaration') continue;
      x._unit = mod.id;
      body.push(x);
    }
  }
  if (script) body.push(...script);

  // tree shaking: renamed names are unique program-wide, so one ref count covers all modules
  const srcs = Object.create(null);
  for (const mod of live) srcs[mod.id] = mod.src;

  // cjs export shaking: drop unread top-level exports.x writes
  const cjsIds = new Set(order.filter(mod => !mod.esm).map(mod => mod.id));
  const moduleOf = name => name.startsWith('module#m') && cjsIds.has(name.slice(8)) ? name.slice(8) : null;
  const baseRef = node => node.type === 'MemberExpression' && !node.computed && node.property.name === 'exports' && node.object.type === 'Identifier' ? moduleOf(node.object.name) : null;
  const shakeExports = () => {
    const alias = Object.create(null), forward = Object.create(null), rebound = [];
    const collect = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) collect(x); return; }
      const assign = node.type === 'AssignmentExpression' && node.operator === '=';
      const name = node.type === 'VariableDeclarator' ? node.id.name : assign ? node.left.name : null;
      const value = node.type === 'VariableDeclarator' ? node.init : assign ? node.right : null;
      const x = value && name?.includes('#m') && baseRef(value);
      if (assign && name?.includes('#m') && (!x || alias[name] != null)) rebound.push(name);
      if (x) alias[name] = alias[name] == null || alias[name] === x ? x : false;

      const from = assign && baseRef(node.left);
      const to = from && baseRef(node.right);
      if (to) forward[from] = forward[from] == null || forward[from] === to ? to : false;
      for (const key in node) if (key !== 'start' && key !== 'end') collect(node[key]);
    };
    collect(body);
    const follow = x => forward[x] ? follow(forward[x]) : x;
    const rawRef = node => node.type === 'Identifier' ? alias[node.name] || null : baseRef(node);
    const refOf = node => {
      const x = rawRef(node);
      // exports keeps the object module.exports had before being replaced
      return node.name === `exports#m${x}` ? x : follow(x);
    };

    const used = Object.create(null), escaped = Object.create(null);
    for (const name of rebound) if (alias[name]) escaped[alias[name]] = escaped[follow(alias[name])] = true;
    const visit = (node, parent) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) visit(x, parent); return; }
      const x = refOf(node);
      if (x) {
        if (parent.type === 'MemberExpression' && parent.object === node && !parent.computed) {
          (used[x] ??= new Set()).add(parent.property.name);
          return;
        }
        const aliased = parent.type === 'VariableDeclarator'
          ? alias[parent.id.name] === rawRef(node)
          : parent.type === 'AssignmentExpression' && parent.operator === '=' && alias[parent.left.name] === rawRef(node);
        if (!aliased) escaped[x] = true;
        return;
      }
      if (node.type === 'Identifier') {
        if (moduleOf(node.name) && parent.id !== node) escaped[moduleOf(node.name)] = true;
        return;
      }
      // method calls expose exports as this
      const callee = node.type === 'CallExpression' ? node.callee : node.tag;
      if (callee?.type === 'MemberExpression' && refOf(callee.object)) escaped[refOf(callee.object)] = true;
      if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && refOf(node.left.object)) return visit(node.right, node);
      if (node.type === 'AssignmentExpression' && node.operator === '=' && forward[baseRef(node.left)] && parent.type === 'ExpressionStatement') return;
      for (const key in node) if (key !== 'start' && key !== 'end') visit(node[key], node);
    };
    visit(body, null);

    let dropped = false;
    for (let i = body.length - 1; i >= 0; i--) {
      const e = body[i].expression;
      if (body[i].type !== 'ExpressionStatement' || e.type !== 'AssignmentExpression' || e.operator !== '=' || e.left.type !== 'MemberExpression' || e.left.computed) continue;
      const x = refOf(e.left.object);
      if (!x || escaped[x] || used[x]?.has(e.left.property.name)) continue;
      const readsExport = e.right.type === 'MemberExpression' && !e.right.computed && refOf(e.right.object) && !escaped[refOf(e.right.object)];
      if (!readsExport && !pure(e.right, srcs[body[i]._unit] ?? '')) continue;
      body.splice(i, 1);
      dropped = true;
    }
    return dropped;
  };

  for (let dropped = true; dropped;) {
    dropped = shakeExports();
    const refs = Object.create(null);
    countRefs(body, refs);
    for (let i = body.length - 1; i >= 0; i--) {
      const x = body[i], src = srcs[x._unit] ?? '';
      let name, self = 1;
      if (x.type === 'FunctionDeclaration' || (x.type === 'ClassDeclaration' && pureClass(x, src))) name = x.id.name;
      else if (x.type === 'VariableDeclaration' && x.declarations.length === 1 && x.declarations[0].id.type === 'Identifier' && (!x.declarations[0].init || pure(x.declarations[0].init, src))) {
        name = x.declarations[0].id.name;
        if (x.declarations[0].init?.id?.name === name) self = 2;
      }
      if (!name?.includes('#m') || refs[name] > self) continue;
      body.splice(i, 1);
      dropped = true;
    }
  }

  if (script) return { type: 'Program', sourceType: 'script', body, _ts: anyTs };
  return {
    type: 'Program', sourceType: 'module', body,
    _ts: anyTs,
    _units: order.map(mod => ({ id: mod.id, name: mod.rel }))
  };
};
