// Selectors: arguments that choose which of the runtime's modules a program needs. A compression
// format (new CompressionStream('gzip')), a Web Crypto algorithm (subtle.encrypt({ name:
// 'AES-GCM' }, ...)), a TextDecoder label: runtime/globals.json declares where each selector is
// passed (its sites) and which provider serves each of its values (a provider's `select`).
//
// The program's syntax trees say which values it passes. What the analysis can see is a string
// literal, a template without expressions, an object literal's `name` (and, for a selector that
// reads more keys, those: an algorithm's `hash`, itself a string or { name }), a const bound to
// one of those, a property of a const object literal, and either side of a ?:, || or ??. Anything
// else (a parameter, a value read from JSON, a string built at run time) is dynamic, and a
// dynamic value brings every variant of its selector: the program is bigger, and still does what
// it would in Node. A lint rule (eslint/, the same analysis) points those out, so an author can
// pass a literal instead.
//
// One analysis for the native linker (compiler/modules.js), the WASI bundler
// (wasi/scripts/bundle.mjs) and ESLint (eslint/rules/static-selector.js): an ESTree from
// Porffor's parser, or ESLint's (whose nodes carry `parent`).

/** A value the analysis cannot know. */
export const DYNAMIC = Symbol('dynamic');

// keys that are not children (ESLint's parent pointers and positions)
const SKIP = new Set([ 'parent', 'loc', 'range', 'start', 'end', 'tokens', 'comments', 'leadingComments', 'trailingComments' ]);

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, visit); return; }
  if (typeof node.type === 'string') visit(node);
  for (const key in node) {
    if (SKIP.has(key) || key[0] === '_') continue;
    const child = node[key];
    if (child && typeof child === 'object') walk(child, visit);
  }
};

const propertyKey = prop => {
  if (prop.computed) return prop.key.type === 'Literal' && typeof prop.key.value === 'string' ? prop.key.value : null;
  return prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'Literal' ? String(prop.key.value) : null;
};

// the programs' const bindings by name, each name's initializers (a name bound more than once has
// all of them: its value is any of theirs)
const constBindings = programs => {
  const out = new Map();
  for (const program of programs) walk(program, node => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
    for (const decl of node.declarations) {
      if (decl.id.type !== 'Identifier' || !decl.init) continue;
      if (!out.has(decl.id.name)) out.set(decl.id.name, []);
      out.get(decl.id.name).push(decl.init);
    }
  });
  return out;
};

/**
 * What a program passes to its selectors.
 * @param {object[]} programs ESTree Program nodes (the program's modules)
 * @param {{ selectors: object }} manifest runtime/globals.json
 * @param {{ receivers?: boolean }} [options] receivers: a method site counts only on the receiver
 *   it names (subtle.digest, not hash.digest). ESLint's choice: it warns only where it is sure.
 *   The compiler's is the default, every call of the method name: a subtle it cannot follow (a
 *   parameter, a property) would otherwise leave the variants out, and the program would fail
 * @returns {{ values: Map<string, Set<string>>, dynamic: Map<string, object[]> }} each selector's
 *   values (normalized), and the call nodes whose value is dynamic, by selector
 */
export const analyzeSelectors = (programs, manifest, { receivers = false } = {}) => {
  const selectors = manifest.selectors ?? {};
  const consts = constBindings(programs);
  const values = new Map(), dynamic = new Map();

  const add = (name, value) => {
    const selector = selectors[name];
    let v = value;
    if (selector.trim) v = v.trim();
    if (selector.caseInsensitive) v = v.toLowerCase();
    if (!values.has(name)) values.set(name, new Set());
    values.get(name).add(v);
  };

  const addDynamic = (name, node) => {
    if (!dynamic.has(name)) dynamic.set(name, []);
    if (!dynamic.get(name).includes(node)) dynamic.get(name).push(node);
  };

  // a const's initializers read by read; seen guards against a const bound to itself through others
  const bound = (name, seen, read) => {
    const inits = consts.get(name);
    if (!inits || seen.has(name)) return [ DYNAMIC ];
    seen.add(name);
    const out = inits.flatMap(init => read(init, seen));
    seen.delete(name);
    return out;
  };

  // an object literal's property, read by read (none when it has no such property)
  const property = (node, key, read, seen) => {
    let out = [];
    for (const prop of node.properties) {
      // a spread may hold the property: anything
      if (prop.type === 'SpreadElement') { out = [ DYNAMIC ]; continue; }
      const name = propertyKey(prop);
      if (name === null) { out.push(DYNAMIC); continue; }
      if (name === key) out = read(prop.value, seen);
    }
    return out;
  };

  // ALGORITHMS.aes, where ALGORITHMS is a const object literal
  const member = (node, seen, read) => {
    if (node.object.type !== 'Identifier') return [ DYNAMIC ];
    const key = node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : null) : node.property.name;
    if (key === null) return [ DYNAMIC ];
    return bound(node.object.name, seen, (init, s) => init.type === 'ObjectExpression' ? property(init, key, read, s) : [ DYNAMIC ]);
  };

  // the strings an expression can be (DYNAMIC among them when it can be something unknown)
  const strings = (node, seen = new Set()) => {
    switch (node.type) {
      case 'Literal': return typeof node.value === 'string' ? [ node.value ] : [ DYNAMIC ];
      case 'TemplateLiteral': return node.expressions.length === 0 ? [ node.quasis[0].value.cooked ] : [ DYNAMIC ];
      case 'ConditionalExpression': return [ ...strings(node.consequent, seen), ...strings(node.alternate, seen) ];
      case 'LogicalExpression': return [ ...strings(node.left, seen), ...strings(node.right, seen) ];
      case 'Identifier': return bound(node.name, seen, strings);
      case 'MemberExpression': return member(node, seen, strings);
      default: return [ DYNAMIC ];
    }
  };

  // the strings a value names that is a string or an object naming one ({ name }), as an
  // algorithm and its hash are: keys are the object's keys read
  const named = (node, keys, seen = new Set()) => {
    switch (node.type) {
      case 'Literal': case 'TemplateLiteral': return strings(node, seen);
      case 'ObjectExpression': return keys.flatMap(key => property(node, key, (v, s) => named(v, [ 'name' ], s), seen));
      case 'ConditionalExpression': return [ ...named(node.consequent, keys, seen), ...named(node.alternate, keys, seen) ];
      case 'LogicalExpression': return [ ...named(node.left, keys, seen), ...named(node.right, keys, seen) ];
      case 'Identifier': return bound(node.name, seen, (init, s) => named(init, keys, s));
      case 'MemberExpression': return member(node, seen, (v, s) => named(v, keys, s));
      default: return [ DYNAMIC ];
    }
  };

  // a site's receiver (the object a method is called on) is the one it names: subtle.encrypt,
  // crypto.subtle.encrypt, or a const bound to one (const s = crypto.subtle)
  // (subtle2 is subtle too: a bundler renames a name that two scopes share, and esbuild's output
  // is what the WASI build analyses)
  const receiverNamed = (node, name, seen = new Set()) => {
    if (node.type === 'Identifier') {
      if (node.name === name || (node.name.startsWith(name) && /^\d+$/.test(node.name.slice(name.length)))) return true;
      const inits = consts.get(node.name);
      if (!inits || seen.has(node.name)) return false;
      seen.add(node.name);
      return inits.some(init => receiverNamed(init, name, seen));
    }
    if (node.type === 'MemberExpression' && !node.computed) return node.property.name === name;
    return false;
  };

  const record = (name, site, node) => {
    const selector = selectors[name];
    for (const index of [].concat(site.argument)) {
      const arg = node.arguments[index];
      // an argument left out is the selector's default (TextDecoder's utf-8): no variant
      if (arg === undefined) continue;
      const found = arg.type === 'SpreadElement' ? [ DYNAMIC ]
        : selector.objectKeys ? named(arg, selector.objectKeys) : strings(arg);
      for (const value of found) {
        if (value === DYNAMIC) addDynamic(name, node);
          else add(name, value);
      }
    }
  };

  for (const program of programs) walk(program, node => {
    const isNew = node.type === 'NewExpression';
    if (!isNew && node.type !== 'CallExpression') return;
    const callee = node.callee;
    for (const name in selectors) {
      for (const site of selectors[name].sites) {
        if (site.new) {
          if (!isNew) continue;
          const ctor = callee.type === 'Identifier' ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : null;
          if (ctor !== site.new) continue;
        } else if (site.method) {
          if (isNew || callee.type !== 'MemberExpression' || callee.computed) continue;
          if (!site.method.includes(callee.property.name)) continue;
          if (receivers && site.receiver && !receiverNamed(callee.object, site.receiver)) continue;
        } else continue;
        // a site whose value is always data (FileReader.readAsText reads the blob's charset)
        if (site.dynamic) { addDynamic(name, node); continue; }
        record(name, site, node);
      }
    }
  });

  return { values, dynamic };
};

/**
 * The provider files a program's selector values bring in: each value's provider, and for a
 * selector passed a dynamic value, every provider of that selector.
 * @param {{ providers: object[], selectors: object }} manifest runtime/globals.json
 * @param {{ values: Map<string, Set<string>>, dynamic: Map<string, object[]> }} analysis
 * @returns {Set<string>} provider files (relative to runtime/)
 */
export const selectedFiles = (manifest, { values, dynamic }) => {
  const out = new Set();
  for (const provider of manifest.providers) {
    if (!provider.select) continue;
    for (const name in provider.select) {
      const selector = manifest.selectors[name];
      const norm = v => selector.caseInsensitive ? v.toLowerCase() : v;
      if (dynamic.has(name) || provider.select[name].some(v => values.get(name)?.has(norm(v)))) out.add(provider.file);
    }
  }
  return out;
};
