// Escape analysis (--escape): an object literal that never leaves the function making it is
// replaced by one local per field, so it is never allocated. `const p = { x: a, y: b }` read
// as `p.x` and `p.y` becomes `p#x = a, p#y = b` and reads of those locals: no allocation, no
// collection, no property lookup, and a field known to be a number can be a raw f64 local.
//
// A literal qualifies when its fields are plain (no spread, method, accessor, computed or
// __proto__ key) and every reference to its binding, in the function that declares it, reads
// or writes one of those fields by name: `p.x`, `p.x = v`, `p.x += v`, `p.x++`. Anything else
// is an escape and keeps the object: the binding passed, returned, stored, compared or
// captured by an inner function; a call `p.m()` (it binds this); a field the literal lacks
// (the read reaches the prototype); `delete`; and eval or with anywhere in the function (they
// reach bindings by name). Nothing that runs can tell the object is gone, since nothing but
// those field accesses ever saw it.
//
// Runs on the AST after the semantic pass, whose resolution ties each reference to its
// declaration (_resolvedVariable). Off by default, like any new pass; --escape-log lists
// what it replaced.

const FUNCS = new Set([ 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression' ]);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const PATTERNS = new Set([ 'ArrayPattern', 'ObjectPattern', 'RestElement' ]);

/** Whether a child of `node` at `key` (a name, or an index in a list) is a binding target. */
const targetPosition = (node, key) => PATTERNS.has(node.type) ||
  (node.type === 'AssignmentPattern' && key === 'left') ||
  ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && key === 'left') ||
  (node.type === 'AssignmentExpression' && key === 'left' && PATTERNS.has(node.left.type));

/** A property name a field access or a literal key names statically, else null. */
const staticKey = (key, computed) => {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string' && IDENT.test(key.value)) return key.value;
  return null;
};

/** The fields of a literal that can be split into locals, in order; else null. */
const literalFields = init => {
  if (init?.type !== 'ObjectExpression') return null;
  const fields = [];
  for (const p of init.properties) {
    if (p.type !== 'Property' || p.kind !== 'init' || p.method) return null;
    const key = staticKey(p.key, p.computed);
    if (key == null || key === '__proto__') return null;
    fields.push([ key, p.value ]);
  }
  return fields;
};

/** Every child node of `node`, with the key (and index) it sits under. */
const children = function* (node) {
  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (value[i] && typeof value[i].type === 'string') yield [ value[i], value, i ];
    } else if (value && typeof value.type === 'string') yield [ value, node, key ];
  }
};

/** Whether a function body reaches bindings by name: a direct eval, or with. */
const reachesByName = body => {
  let found = false;
  const walk = node => {
    if (found) return;
    if (node.type === 'WithStatement' || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')) {
      found = true;
      return;
    }
    // an inner function's eval reaches this function's bindings too
    for (const [ child ] of children(node)) walk(child);
  };
  walk(body);
  return found;
};

/**
 * Candidates in `fn`'s own body (not inner functions'): declarators of a literal, each with
 * its declaration and the place that declaration sits in a statement list.
 */
const findCandidates = body => {
  const out = [];
  const walk = (node, parent, slot) => {
    if (node !== body && FUNCS.has(node.type)) return;
    if (node.type === 'VariableDeclaration' && node.kind !== 'var' && Array.isArray(parent)) {
      for (const d of node.declarations) {
        const fields = d.id.type === 'Identifier' ? literalFields(d.init) : null;
        if (fields) out.push({ declarator: d, declaration: node, fields, keys: new Set(fields.map(x => x[0])), accesses: [], escaped: false });
      }
    }
    for (const [ child, p, k ] of children(node)) walk(child, p, k);
  };
  walk(body, null, null);
  return out;
};

/** Why a use of the whole object (not a field of it) lets it escape, by where it sits. */
const wholeUse = (parent, key) => {
  switch (parent?.type) {
    case 'ReturnStatement': case 'ArrowFunctionExpression': return 'returned';
    case 'CallExpression': return key === 'callee' ? 'called' : 'passed to a call';
    case 'NewExpression': return 'passed to new';
    case 'AssignmentExpression': return key === 'right' ? 'stored (assigned)' : 'reassigned';
    case 'Property': case 'ArrayExpression': case 'SpreadElement': return 'stored in an object or array';
    case 'VariableDeclarator': return 'copied to another variable';
    case 'BinaryExpression': return `compared (${parent.operator})`;
    case 'MemberExpression': return 'indexed or used as a key';
    case 'UnaryExpression': return `${parent.operator} of it`;
    case 'YieldExpression': case 'AwaitExpression': return 'yielded or awaited';
    case 'ConditionalExpression': case 'LogicalExpression': case 'SequenceExpression': return 'flows through ?:, && or ,';
    case 'TemplateLiteral': return 'in a template';
    case 'ForOfStatement': case 'ForInStatement': return 'iterated';
    default: return `used whole (${parent?.type ?? '?'})`;
  }
};

/** Marks each candidate escaped or not, recording its field accesses. */
const analyse = (body, candidates) => {
  const byDecl = new Map(candidates.map(c => [ c.declarator.id, c ]));
  // a node, where it sits (container and key), its parent and grandparent, the grandparent's
  // place, whether it is inside an inner function, and whether inside a binding target
  const walk = (node, container, key, parentNode, grandNode, grandContainer, grandKey, inner, target) => {
    if (node.type === 'Identifier') {
      const c = byDecl.get(node._resolvedVariable?.node);
      if (c && node !== c.declarator.id) {
        const member = parentNode?.type === 'MemberExpression' && parentNode.object === node ? parentNode : null;
        const field = member ? staticKey(member.property, member.computed) : null;
        const call = member && (grandNode?.type === 'CallExpression' && grandNode.callee === member);
        const deleted = member && grandNode?.type === 'UnaryExpression' && grandNode.operator === 'delete';
        const written = member && ((grandNode?.type === 'AssignmentExpression' && grandNode.left === member) || grandNode?.type === 'UpdateExpression');
        // a destructuring target is kept whole: the rewrite is for plain reads and writes
        const reason = inner ? 'captured by an inner function'
          : target ? 'a destructuring target'
          : !member ? wholeUse(parentNode, key)
          : member.optional ? 'read with ?.'
          : field == null ? 'a computed field'
          : c.optimistic ? (deleted ? 'delete' : null)
          : call ? (c.keys.has(field) ? `a call of its field .${field}()` : `a method call .${field}()`)
          : !c.keys.has(field) ? `a field it lacks (.${field}, the prototype's)`
          : deleted ? 'delete' : null;
        if (reason) { c.escaped = true; c.reason ??= reason; }
        else c.accesses.push({ member, container: grandContainer, key: grandKey, field, written });
      }
      return;
    }
    const isFunc = node !== body && FUNCS.has(node.type);
    for (const [ child, cont, k ] of children(node)) {
      const childTarget = target || targetPosition(node, k);
      walk(child, cont, k, node, parentNode, container, key, inner || isFunc, childTarget);
    }
  };
  walk(body, null, null, null, null, null, null, false, false);
};

/**
 * Whether the literal `declarator` initialises would be replaced by locals in `body`: nothing
 * reaches bindings by name there, and every use of it is a field access (the inliner asks,
 * after putting a callee's returned literal in place).
 */
export const literalStaysLocal = (body, declarator) => literalEscape(body, declarator) == null;

/** Why the literal `declarator` initialises would not stay local in `body`; null if it would. */
export const literalEscape = (body, declarator) => {
  if (reachesByName(body)) return 'eval or with in the function';
  const candidates = findCandidates(body);
  const c = candidates.find(x => x.declarator === declarator);
  if (!c) return 'not a plain literal';
  analyse(body, candidates);
  return c.escaped ? c.reason ?? 'escapes' : null;
};

/**
 * Why the object a declaration holds would escape even at best: any field read or written by
 * name, and any method called on it, taken as fine (as if every method were inlined). What
 * is left is a use no inlining removes (returned, stored, passed, captured); null if none.
 */
export const certainEscape = (body, declarator) => {
  if (reachesByName(body)) return 'eval or with in the function';
  const c = { declarator, keys: null, optimistic: true, accesses: [], escaped: false };
  analyse(body, [ c ]);
  return c.escaped ? c.reason ?? 'escapes' : null;
};

/** Every literal of a program's functions that is not replaced, and why: [reason, where]. */
export const literalEscapes = program => {
  const out = [];
  const visit = (node, where) => {
    if (FUNCS.has(node.type)) {
      const name = node.id?.name ?? where;
      if (node.body.type === 'BlockStatement') {
        const byName = reachesByName(node.body);
        const candidates = findCandidates(node.body);
        if (!byName) analyse(node.body, candidates);
        for (const c of candidates) if (byName || c.escaped) out.push([ byName ? 'eval or with in the function' : c.reason ?? 'escapes', `${name}: ${c.declarator.id.name}` ]);
      }
      for (const [ child ] of children(node)) visit(child, name);
      return;
    }
    for (const [ child ] of children(node)) visit(child, where);
  };
  visit(program, '(top level)');
  return out;
};

let log = null;

/** Replaces the non-escaping literals of one function body. */
const replaceIn = (body, where) => {
  if (reachesByName(body)) return;
  const candidates = findCandidates(body);
  if (candidates.length === 0) return;
  analyse(body, candidates);

  for (const c of candidates) {
    if (c.escaped) continue;
    const name = c.declarator.id.name;
    const local = field => ({ type: 'Identifier', name: `${name}#${field}` });

    // one declarator per field, the literal's values in its order (a repeated key: the
    // last write wins, as in the literal); a field written later needs a let
    const written = new Set(c.accesses.filter(a => a.written).map(a => a.field));
    const decls = c.declaration.declarations;
    const at = decls.indexOf(c.declarator);
    decls.splice(at, 1, ...c.fields.map(([ field, value ]) => ({
      type: 'VariableDeclarator', id: local(field), init: value
    })));
    if (c.declaration.kind === 'const' && written.size > 0) c.declaration.kind = 'let';

    // each access is now its field's local
    for (const a of c.accesses) {
      if (Array.isArray(a.container)) a.container[a.container.indexOf(a.member)] = local(a.field);
      else a.container[a.key] = local(a.field);
    }
    if (log) log.push(`${where}: ${name} {${c.fields.map(x => x[0]).join(', ')}}, ${c.accesses.length} accesses`);
  }
};

/** Runs over every function in the program (and its top level). */
export default program => {
  log = Prefs.escapeLog ? [] : null;
  const visit = (node, where) => {
    if (FUNCS.has(node.type)) {
      const name = node.id?.name ?? where;
      if (node.body.type === 'BlockStatement') replaceIn(node.body, name);
      for (const [ child ] of children(node)) visit(child, name);
      return;
    }
    for (const [ child ] of children(node)) visit(child, where);
  };
  visit(program, '(top level)');
  if (log) for (const line of log) console.log(`escape: ${line}`);
  return program;
};
