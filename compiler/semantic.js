import parse from './parse.js';
import { TYPES } from './types.js';

const varId = name => {
  const lastFunc = scopes[scopes.lastFuncs.at(-1)];
  lastFunc._variableIds ??= Object.create(null);
  lastFunc._variableIds[name] ??= 0;
  return lastFunc._variableIds[name]++;
};

const isFunctionScope = node =>
  node?.type === 'FunctionDeclaration' ||
  node?.type === 'FunctionExpression' ||
  node?.type === 'ArrowFunctionExpression';

const findLexicalThisOwner = (currentFunc, boundary) => {
  if (currentFunc?.type !== 'ArrowFunctionExpression' || currentFunc === boundary) return null;

  let owner = currentFunc._parentFunc;
  while (owner && owner !== boundary) {
    if (owner.type !== 'ArrowFunctionExpression') return owner;
    owner = owner._parentFunc;
  }

  return null;
};

const markClosurePassThrough = (currentFunc, owner) => {
  let cursor = currentFunc?._parentFunc;
  while (cursor && cursor !== owner) {
    cursor._closurePassThrough = true;
    cursor = cursor._parentFunc;
  }
};

const isSelfReferenceContext = (currentFunc, owner) => {
  if (!currentFunc || !owner) return false;
  if (!isFunctionScope(currentFunc)) return false;

  let cursor = currentFunc;
  while (cursor) {
    if (cursor === owner) return true;
    cursor = cursor._parentFunc;
  }

  return false;
};

// a loop's body block is entered afresh each iteration (a while loop's too): its lets are
// per-iteration bindings even when the loop header declares none
const isLoopScope = scope =>
  scope?.type === 'ForStatement' ||
  scope?.type === 'ForInStatement' ||
  scope?.type === 'ForOfStatement' ||
  !!scope?._loopBody;

const bindingHasLoopScope = variable => {
  const funcInd = scopes.indexOf(variable.func);
  const scopeInd = scopes.indexOf(variable.scope);
  for (let i = funcInd + 1; i <= scopeInd; i++) {
    if (isLoopScope(scopes[i])) return true;
  }

  return false;
};

const renameBindingNode = (node, name) => {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Identifier') {
    node.name = name;
  } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id?.name) {
    node.id.name = name;
  }
};

const resolveVariable = name => {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const variable = scopes[i]._variables?.[name];
    if (variable) return variable;
  }
};

const nodeWithin = (node, outer) =>
  outer != null && node.start >= outer.start && node.end <= outer.end;

const markWrite = node => {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Identifier') {
    const variable = node._resolvedVariable ?? node._variable ?? resolveVariable(node.name);
    if (variable) {
      variable.node._writes = (variable.node._writes ?? 0) + 1;
      // a for (let ...) binding written outside its test and update: the value a closure
      // snapshots at creation can go stale (codegen boxes it per iteration instead)
      const loop = variable.scope;
      if (loop?.type === 'ForStatement' && !nodeWithin(node, loop.test) && !nodeWithin(node, loop.update))
        variable.node._loopBodyWrites = (variable.node._loopBodyWrites ?? 0) + 1;
    }
    return;
  }

  if (node.type === 'ArrayPattern') {
    for (const x of node.elements) markWrite(x);
    return;
  }

  if (node.type === 'ObjectPattern') {
    for (const x of node.properties) markWrite(x.value ?? x.argument);
    return;
  }

  if (node.type === 'AssignmentPattern') {
    markWrite(node.left);
    return;
  }

  if (node.type === 'RestElement') markWrite(node.argument);
};

const recordStorageWrite = (target, value) => {
  if (!target || typeof target !== 'object') return;

  if (target.type === 'Identifier') {
    const variable = target._resolvedVariable ?? target._variable ?? resolveVariable(target.name);
    if (!variable) return;

    if (variable.node._storageType !== null) {
      variable.node._storageType = storageExpressionType(value) === TYPES.number ? TYPES.number : null;
    }
    return;
  }

  if (target.type === 'ArrayPattern') {
    for (const x of target.elements) recordStorageWrite(x, null);
    return;
  }

  if (target.type === 'ObjectPattern') {
    for (const x of target.properties) recordStorageWrite(x.value ?? x.argument, null);
    return;
  }

  if (target.type === 'AssignmentPattern') {
    recordStorageWrite(target.left, value);
    return;
  }

  if (target.type === 'RestElement') recordStorageWrite(target.argument, null);
};

const markMaybeUndefinedStorage = node => {
  if (node?.type !== 'Identifier') return;

  const variable = node._resolvedVariable ?? node._variable ?? resolveVariable(node.name);
  if (variable?.node?._uninitialized) variable.node._storageType = null;
};

const undefinedCheckTarget = (left, right) => {
  if (left?.type === 'Identifier' && right?.type === 'Identifier' && right.name === 'undefined') return left;
  if (right?.type === 'Identifier' && left?.type === 'Identifier' && left.name === 'undefined') return right;
};

// what -x, ~x or x++ gives for an operand of this type: a Number or a BigInt, else unknown
const numericOf = type => type === TYPES.number || type === TYPES.bigint ? type : null;

const storageExpressionType = node => {
  if (!node) return null;
  if (node._type != null) return typeof node._type === 'number' ? node._type : null;

  if (node.type === 'Literal') {
    if (node.bigint != null) return TYPES.bigint;
    if (node.regex) return TYPES.regexp;
    if (typeof node.value === 'string') return TYPES.bytestring;
    return TYPES[typeof node.value] ?? null;
  }

  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return TYPES.undefined;
    if (node.name === 'NaN' || node.name === 'Infinity') return TYPES.number;
    return !node._noStorageInfer && (node._resolvedVariable ?? resolveVariable(node.name))?.node?._storageType === TYPES.number ? TYPES.number : null;
  }

  if (node.type === 'UnaryExpression') {
    if (node.operator === '!') return TYPES.boolean;
    if (node.operator === 'void') return TYPES.undefined;
    if (node.operator === 'delete') return TYPES.boolean;
    if (node.operator === 'typeof') return TYPES.bytestring;
    if (node.operator === '+' || !bigintPossible) return TYPES.number;
    return numericOf(storageExpressionType(node.argument));
  }

  if (node.type === 'UpdateExpression') return bigintPossible ? numericOf(storageExpressionType(node.argument)) : TYPES.number;

  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    if (['==', '===', '!=', '!==', '>', '>=', '<', '<=', 'instanceof', 'in'].includes(node.operator)) return TYPES.boolean;
    if (node.type === 'LogicalExpression') return null;

    const l = storageExpressionType(node.left), r = storageExpressionType(node.right);
    if (l === TYPES.bigint || r === TYPES.bigint) return TYPES.bigint;
    // a Number on either side makes a Number (a BigInt on the other throws)
    if (node.operator !== '+') return !bigintPossible || node.operator === '>>>' || l === TYPES.number || r === TYPES.number ? TYPES.number : null;
    if (l === TYPES.number && r === TYPES.number) return TYPES.number;
    if (l === TYPES.string || r === TYPES.string) return TYPES.string;
    if (l === TYPES.bytestring && r === TYPES.bytestring) return TYPES.bytestring;
    return null;
  }

  if (node.type === 'AssignmentExpression') {
    const op = node.operator.slice(0, -1) || '=';
    return op === '=' ? storageExpressionType(node.right) : storageExpressionType({
      type: ['||', '&&', '??'].includes(op) ? 'LogicalExpression' : 'BinaryExpression',
      left: node.left,
      right: node.right,
      operator: op
    });
  }

  if (node.type === 'SequenceExpression') return storageExpressionType(node.expressions.at(-1));
  if (node.type === 'TemplateLiteral') return TYPES.bytestring;
  if (node.type === 'ObjectExpression') return TYPES.object;
  if (node.type === 'ArrayExpression') return TYPES.array;

  return null;
};

const nearestEvalScope = () => {
  const lastFunc = scopes.lastFuncs.at(-1);
  for (let i = scopes.length - 1; i > lastFunc; i--) {
    const scope = scopes[i];
    if (scope._evalScope) return scope;
  }

  return null;
};

const nearestStrictEvalScope = () => {
  const scope = nearestEvalScope();
  return scope && (scope._strictEval || scope._strict) ? scope : null;
};

// Annex B.3.3: a sloppy function declared in a block is also a var of its function, unless
// replacing it with `var name` would be an early error: a lexical binding of the name in a scope
// between the block and the function (for (let f of ...) { { function f() {} } }). Then it is
// the block's alone
const annexBConflict = name => {
  const funcInd = scopes.lastFuncs.at(-1);
  if (scopes.length - 1 - funcInd <= 1) return false; // directly in the function body
  for (let i = funcInd + 1; i < scopes.length; i++) {
    const variable = scopes[i]._variables?.[name];
    if (variable && variable.kind !== 'var' && variable.kind !== 'function-name') return true;
  }
  return false;
};

const evalLexicalConflict = name => {
  const evalScope = nearestEvalScope();
  if (!evalScope) return false;

  const evalInd = scopes.indexOf(evalScope);
  for (let i = evalInd + 1; i < scopes.length; i++) {
    const variable = scopes[i]._variables?.[name];
    if (variable && variable.kind !== 'var' && variable.kind !== 'function-name') return true;
  }

  return false;
};

export const unknownValue = Symbol('Porffor.unknownValue');
export const knownValue = (scope, node) => {
  if (!node) return undefined;

  if (node.type === 'Literal' && node.value !== undefined) return node.value;

  if (node.type === 'TemplateLiteral') {
    let out = '';

    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked;

      if (i < node.expressions.length) {
        const value = knownValue(scope, node.expressions[i]);
        if (value === unknownValue) return unknownValue;

        out += String(value);
      }
    }

    return out;
  }

  if (node.type === 'BinaryExpression') {
    const left = knownValue(scope, node.left);
    if (left === unknownValue) return unknownValue;

    const right = knownValue(scope, node.right);
    if (right === unknownValue) return unknownValue;

    switch (node.operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '==': return left == right;
      case '===': return left === right;
      case '!=': return left != right;
      case '!==': return left !== right;
    }
  }

  return unknownValue;
};

const knownEvalSource = node => {
  const value = knownValue(null, node);
  return value === unknownValue ? null : String(value);
};

const parseEval = node => {
  const code = knownEvalSource(node._evalSource ?? node.arguments[0]);
  if (code == null) return;

  try {
    node._evalParsed = {
      type: 'BlockStatement',
      body: semantic(semantic.objectHack(parse(code, null, node._indirectEval || node.optional ? null : evalContext())), node._semanticScopes).body
    };
  } catch (e) {
    if (e.name !== 'SyntaxError') throw e;
    node._evalSyntaxError = e.message;
  }
};

const evalCallKind = node => {
  if (node.callee.name === 'eval') return 'direct';
  if (node.callee.type === 'SequenceExpression' && node.callee.expressions.at(-1)?.name === 'eval') return 'indirect';
  if (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.name === 'eval' &&
    node.callee.property.name === 'call'
  ) return 'call';
};

const declVar = (name, kind, node) => {
  const func = scopes[scopes.lastFuncs.at(-1)];
  // sloppy function decls hoist as var, but each loop iteration still makes a fresh binding
  if (kind === 'var' && node?.type === 'FunctionDeclaration') {
    const scope = scopes.at(-1);
    if (scopes.length - 1 - scopes.lastFuncs.at(-1) > 1 || !Array.isArray(scope.body) || !scope.body.includes(node)) node._writes = 1;
    for (let i = scopes.lastFuncs.at(-1) + 1; i < scopes.length; i++) {
      if (isLoopScope(scopes[i])) { node._loopScopedFuncDecl = true; break; }
    }
  }
  let parent;
  if (kind === 'var') {
    parent = nearestStrictEvalScope() ?? func;
    if (parent._variables?.[name]) {
      const existing = parent._variables[name];
      if (node?._writes && existing.node.type === 'Identifier' && !existing.node._declarator) node._skipVarUpdate = true;
      if (existing.node._writes) node._writes = 1;
      existing.node = node;
      if (node && typeof node === 'object') node._variable = existing;

      if (existing.internalName) renameBindingNode(node, existing.internalName);
      return;
    }
  } else {
    parent = scopes.at(-1);
  }

  parent._variables ??= Object.create(null);
  if (node && typeof node === 'object') node._refs ??= 0;

  const id = varId(name);
  let shadowsOuterFuncBinding = false;
  if (kind !== 'var') {
    const currentFuncInd = scopes.lastFuncs.at(-1);
    for (let i = currentFuncInd - 1; i >= 0; i--) {
      const variable = scopes[i]._variables?.[name];
      if (!variable) continue;
      shadowsOuterFuncBinding = variable.func !== func && variable.scope?.type !== 'Program';
      break;
    }
  }
  const activeEvalScope = nearestEvalScope();
  const evalScope = parent._evalScope ? parent : (kind === 'var' ? null : activeEvalScope);
  const internalName = evalScope ? `${evalScope._evalName}_${name}${id > 0 ? `#${id}` : ''}` :
    (id > 0 || shadowsOuterFuncBinding ? `${name}#${id}` : null);
  const variable = { node, id, func, kind, scope: parent, internalName };
  parent._variables[name] = variable;
  if (node && typeof node === 'object') node._variable = variable;

  if (internalName) renameBindingNode(node, internalName);
};

const analyzePattern = (kind, node) => {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      node._binding = true;
      declVar(node.name, kind, node);
      break;

    case 'RestElement':
      analyzePattern(kind, node.argument);
      break;

    case 'AssignmentPattern':
      analyzePattern(kind, node.left);
      break;

    case 'Property':
      analyzePattern(kind, node.value);
      break;

    case 'ObjectPattern':
      // each entry: a Property (its value is the pattern) or a RestElement (`...rest`)
      for (const x of node.properties) {
        analyzePattern(kind, x);
      }
      break;

    case 'ArrayPattern':
      for (const x of node.elements) {
        analyzePattern(kind, x);
      }
      break;
  }
};

let scopes;
let evalScopeId = 0;
const analyze = (node, strict = false) => {
  if (!node) return;

  const top = scopes.at(-1);
  if (node.directive === 'use strict') {
    top._strict = true;
  }

  let openedScope = false;
  switch (node.type) {
    case 'IfStatement':
      // Annex B.3.3: if (x) function f() {} is as if the function were in a block of its own
      for (const k of [ 'consequent', 'alternate' ]) {
        if (node[k]?.type === 'FunctionDeclaration') node[k] = { type: 'BlockStatement', body: [ node[k] ], start: node[k].start, end: node[k].end };
      }
      break;

    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      if (node.body?.type === 'BlockStatement') node.body._loopBody = true;
      if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') break;
    case 'SwitchStatement':
    case 'BlockStatement':
      scopes.push(node);
      openedScope = true;
      break;

    case 'CatchClause':
      scopes.push(node);
      if (node.param) analyzePattern('let', node.param);
      openedScope = true;
      break;

    case 'VariableDeclaration':
      for (const x of node.declarations) {
        if (x.id?.type === 'Identifier') x.id._declarator = x;
        analyzePattern(node.kind, x.id);
      }
      // only an initializer at the top of the func body dominates later reads
      if (scopes.length - 1 - scopes.lastFuncs.at(-1) <= 1) {
        for (const x of node.declarations) {
          if (x.init && x.id?.type === 'Identifier') x.id._storageTopDecl = true;
        }
      }
      break;

    case 'CallExpression':
      if (evalCallKind(node)) {
        node._directEval = evalCallKind(node) === 'direct' && !node.optional;
        node._strictEval = node._directEval && (strict || top._strict);
      }
      break;

    case 'ClassDeclaration':
      if (node.id?.name) {
        node.id._binding = true;
        declVar(node.id.name, 'let', node);
      }
      break;

    case 'ClassExpression':
      scopes.push(node);
      openedScope = true;
      if (node.id?.name) {
        node.id._binding = true;
        declVar(node.id.name, 'function-name', node);
      }
      break;

    case 'FunctionDeclaration':
      if (node.id?.name) {
        node.id._binding = true;
        declVar(node.id.name, (strict || evalLexicalConflict(node.id.name) || annexBConflict(node.id.name)) ? 'let' : 'var', node);
      }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      node._parentFunc = scopes[scopes.lastFuncs.at(-1)];
      scopes.lastFuncs.push(scopes.length);
      scopes.push(node);
      openedScope = true;

      // named function expressions bind their own name
      if (node.type === 'FunctionExpression' && node.id?.name) {
        node.id._binding = true;
        declVar(node.id.name, 'function-name', node);
      }

      for (const p of node.params) analyzePattern('var', p);
      break;
  }

  for (const x in node) {
    if (x[0] === '_') continue;
    const value = node[x];
    if (value != null && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const y of value) analyze(y, strict || top._strict);
      } else if (value.type) analyze(value, strict || top._strict);
    }
  }

  if (openedScope) {
    scopes.pop();
  }

  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    scopes.lastFuncs.pop();
  }
};

// what a direct eval's source may use of its caller's: the enclosing classes' private
// names, super.x (in a method, a field initialiser or a static block), super() (in a derived
// class's constructor) and new.target (in a function other than an arrow)
const evalContextStack = [];
const evalContextEntry = (node, parent, key) => {
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
    return { cls: node, names: node.body.body.filter(x => x.key?.type === 'PrivateIdentifier').map(x => x.key.name) };
  if (node.type === 'ArrowFunctionExpression') return { arrow: true };
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
    const method = parent?.type === 'MethodDefinition' || (parent?.type === 'Property' && (parent.method || parent.kind === 'get' || parent.kind === 'set'));
    const cls = evalContextStack.findLast(x => x.cls)?.cls;
    return { home: method, derivedCtor: parent?.type === 'MethodDefinition' && parent.kind === 'constructor' && !!cls?.superClass };
  }
  if ((parent?.type === 'PropertyDefinition' && key === 'value') || node.type === 'StaticBlock') return { home: true, derivedCtor: false };
  return null;
};

const evalContext = () => {
  const ctx = { privateNames: [], superProperty: false, superCall: false, newTarget: false };
  let settled = false;
  for (let i = evalContextStack.length - 1; i >= 0; i--) {
    const x = evalContextStack[i];
    if (x.names) ctx.privateNames.push(...x.names);
    else if (!settled && !x.arrow) {
      settled = true;
      ctx.newTarget = true;
      ctx.superProperty = x.home;
      ctx.superCall = x.derivedCtor;
    }
  }
  return ctx;
};

const annotate = (node, parent = null, key = null) => {
  if (!node) return;
  const ctx = evalContextEntry(node, parent, key);
  if (ctx) evalContextStack.push(ctx);
  annotateNode(node, parent, key);
  if (ctx) evalContextStack.pop();
};

const annotateNode = (node, parent, key) => {

  let openedScope = false;
  let openedFunc = false;
  if (node._variables || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    scopes.push(node);
    openedScope = true;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      scopes.lastFuncs.push(scopes.length - 1);
      openedFunc = true;
    }
  }

  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      for (const param of node.params) recordStorageWrite(param, null);
      break;

    case 'VariableDeclarator':
      annotate(node.id, node, 'id');
      annotate(node.init, node, 'init');
      if (node.init) recordStorageWrite(node.id, node.init);
        else if (node.id.type === 'Identifier') node.id._uninitialized = true;
      if (node.init && node.id._storageTopDecl) {
        const variable = node.id._variable ?? resolveVariable(node.id.name);
        if (variable) variable.node._storageInitSeen = true;
      }
      return;

    case 'ForInStatement':
    case 'ForOfStatement':
      recordStorageWrite(node.left.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : node.left, null);
      break;

    case 'CatchClause':
      recordStorageWrite(node.param, null);
      break;

    case 'AssignmentExpression':
      annotate(node.left, node, 'left');
      annotate(node.right, node, 'right');
      markWrite(node.left);
      recordStorageWrite(node.left, node.operator === '=' ? node.right : {
        type: ['||=', '&&=', '??='].includes(node.operator) ? 'LogicalExpression' : 'BinaryExpression',
        left: node.left,
        right: node.right,
        operator: node.operator.slice(0, -1)
      });
      return;

    case 'UpdateExpression':
      markWrite(node.argument);
      recordStorageWrite(node.argument, node);
      break;

    case 'BinaryExpression':
      if (['==', '===', '!=', '!=='].includes(node.operator)) {
        const target = undefinedCheckTarget(node.left, node.right);
        if (target) markMaybeUndefinedStorage(target);
      }
      break;

    case 'Identifier':
      if (node._binding) break;
      if (semantic.objectHackers.includes(node.name)) break;
      // labels are their own namespace: never a variable, never renamed with one
      if (key === 'label' && (parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement')) break;

      const name = node.name;
      const currentFunc = scopes[scopes.lastFuncs.at(-1)];
      const variable = resolveVariable(name);
      if (variable) {
        node._resolvedBinding = true;
        node._resolvedVariable = variable;
        variable.node._refs = (variable.node._refs ?? 0) + 1;
        // a function declaration whose name is assigned: calls to it go through the
        // binding, not straight to the function (babel's helpers rebind their own names)
        if (variable.node.type === 'FunctionDeclaration' &&
            ((parent?.type === 'AssignmentExpression' && key === 'left') || parent?.type === 'UpdateExpression'))
          variable.node._reassigned = true;
        // reads from other funcs or before the dominating init can see undefined
        if (variable.func !== currentFunc || !variable.node._storageInitSeen) {
          node._noStorageInfer = true;
          variable.node._storageHazardRef = true;
        }
        if (parent?.type === 'CallExpression' && key === 'callee' && !parent.optional && !parent.arguments.some(x => x?.type === 'SpreadElement')) {
          variable.node._directCallRefs = (variable.node._directCallRefs ?? 0) + 1;
          // eval bodies are compiled without direct param type inference
          if (!inEval) {
            if (variable.node._directCalls) variable.node._directCalls.push(parent);
            else {
              variable.node._directCalls = [ parent ];
              (scopes[0]._directCallDecls ??= []).push(variable.node);
            }
          }
          variable.node._directCallMinStart = variable.node._directCallMinStart == null ?
            node.start : Math.min(variable.node._directCallMinStart, node.start);
        } else {
          variable.node._valueRefs = (variable.node._valueRefs ?? 0) + 1;
        }
        if (variable.internalName) node.name = variable.internalName;

        if (
          (variable.node.type === 'FunctionDeclaration' || variable.node.type === 'FunctionExpression' || variable.node.type === 'ClassExpression') &&
          variable.node.id?.name === node.name &&
          isSelfReferenceContext(currentFunc, variable.node)
        ) {
          if (variable.node.type !== 'ClassExpression') variable.node._selfAware = true;
          node._selfBinding = variable.node;
        }
        // a class's own name inside the class (heritage, keys, body) is its inner binding,
        // read-only for a declaration too; by position, a class not being a function scope
        const insideClass = variable.node.type === 'ClassDeclaration' && variable.node.id &&
          node.start > variable.node.id.end && node.end <= variable.node.end;
        if ((variable.node.type === 'ClassExpression' && variable.scope?.type === 'ClassExpression') ||
            (variable.node.type === 'ClassDeclaration' && (variable.node._fromExpression || insideClass))) {
          node._selfBinding = variable.node;
          node._classBinding = true;
        }

        if (variable.func && variable.scope?.type !== 'ClassExpression') {
          if (classFieldInitializerFunc === currentFunc && variable.func === currentFunc && variable.scope?.type !== 'Program') {
            node._closureFunc = variable.func;

            variable.func._capturedVars ??= Object.create(null);
            variable.func._capturedVars[node.name] = {
              kind: variable.kind,
              node: variable.node
            };
          } else if (variable.func !== currentFunc) {
            if (variable.scope?.type !== 'Program') {
              node._closureFunc = variable.func;

              currentFunc._captures ??= Object.create(null);
              currentFunc._captures[node.name] = {
                func: variable.func,
                kind: variable.kind,
                node: variable.node,
                perIteration: (variable.kind !== 'var' && bindingHasLoopScope(variable)) || !!variable.node?._loopScopedFuncDecl
              };

              variable.func._capturedVars ??= Object.create(null);
              variable.func._capturedVars[node.name] = {
                kind: variable.kind,
                node: variable.node
              };

              markClosurePassThrough(currentFunc, variable.func);
              // pass loop captures through intermediate closures
              const capture = currentFunc._captures[node.name];
              if (capture.perIteration) {
                variable.node._perIterationCaptured = true;
                for (let cursor = currentFunc._parentFunc; cursor !== variable.func; cursor = cursor._parentFunc) {
                  cursor._captures ??= Object.create(null);
                  cursor._captures[node.name] ??= capture;
                }
              }
            }
          } else if (currentFunc._capturedVars?.[node.name]) {
            node._closureFunc = currentFunc;
          }
        }
      }

      if (!variable && name === 'arguments') {
        for (let i = scopes.length - 1; i >= 0; i--) {
          const scope = scopes[i];
          if (scope.type === 'FunctionDeclaration' || scope.type === 'FunctionExpression') {
            scope._usesArguments = true;
            return;
          }
        }
      }
      break;

    // super.x in an arrow reads the method's this as well as its home object
    case 'ThisExpression':
    case 'Super': {
      const currentFunc = scopes[scopes.lastFuncs.at(-1)];
      const owner = findLexicalThisOwner(currentFunc, classFieldInitializerFunc);
      if (owner) {
        node._closureThisFunc = owner;
        currentFunc._capturesThis = owner;
        owner._capturedThis = true;
        // super() in an arrow constructs with the constructor's new.target as well
        if (node.type === 'Super' && parent?.type === 'CallExpression' && key === 'callee') owner._capturedNewTarget = owner._capturedSuperCall = true;
        markClosurePassThrough(currentFunc, owner);
      }
      break;
    }

    // new.target in an arrow is its enclosing function's
    case 'MetaProperty': {
      if (node.meta.name !== 'new') break;
      const currentFunc = scopes[scopes.lastFuncs.at(-1)];
      const owner = findLexicalThisOwner(currentFunc);
      if (owner) {
        node._closureThisFunc = owner;
        currentFunc._capturesThis = owner;
        owner._capturedNewTarget = true;
        markClosurePassThrough(currentFunc, owner);
      }
      break;
    }

    case 'MemberExpression':
      if (node.computed) annotate(node.property, node, 'property');
      annotate(node.object, node, 'object');
      return;

    case 'PropertyDefinition':
      if (node.computed) annotate(node.key, node, 'key');
      if (node.static) {
        annotate(node.value, node, 'value');
      } else {
        const previous = classFieldInitializerFunc;
        classFieldInitializerFunc = scopes[scopes.lastFuncs.at(-1)];
        annotate(node.value, node, 'value');
        classFieldInitializerFunc = previous;
      }
      return;

    case 'Property':
      if (node.computed) annotate(node.key, node, 'key');
      annotate(node.value, node, 'value');
      return;

    case 'CallExpression': {
      // f('a', 1): each named function's calls with only literal arguments, for codegen to
      // specialise a new Function in it whose source is made of its parameters
      if (node.callee.type === 'Identifier' && node.arguments.length > 0 && node.arguments.every(x => x.type === 'Literal')) {
        const calls = semantic.literalCalls;
        if (!calls.has(node.callee.name)) calls.set(node.callee.name, []);
        const list = calls.get(node.callee.name);
        if (list.length < 16) list.push(node.arguments.map(x => x.value));
      }

      const evalKind = evalCallKind(node);
      if (evalKind) {
        node._evalScope = true;
        node._evalName ??= `#eval_${evalScopeId++}`;
        if (evalKind !== 'direct' || node.optional) {
          // indirect eval, only top scope
          node._indirectEval = true;
          node._semanticScopes = [ scopes[0], node ];
          node._semanticScopes.lastFuncs = [ 0 ];
        } else {
          // direct eval, use existing scope
          node._semanticScopes = Object.assign([], scopes);
          node._semanticScopes.lastFuncs = scopes.lastFuncs.slice();
          node._semanticScopes.push(node);
        }

        if (evalKind === 'call') node._evalSource = node.arguments[1];
        parseEval(node);
      }
      break;
    }

    case 'NewExpression':
      if (node.callee.name === 'Function') {
        // new Function(...) - use global scope and self as scope
        node._semanticScopes = [ scopes[0], node ];
        node._semanticScopes.lastFuncs = [ 0, 1 ];
      }
      break;
  }

  for (const x in node) {
    if (x[0] === '_') continue;
    const value = node[x];
    if (value != null && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const y of value) annotate(y, node, x);
      } else if (value.type) annotate(value, node, x);
    }
  }

  if (openedScope) {
    scopes.pop();
  }

  if (openedFunc) {
    scopes.lastFuncs.pop();
  }
};

let inEval = false, classFieldInitializerFunc = null;
// the program can hold BigInts (parse.js): arithmetic on unknown types may give one
let bigintPossible = false;
const semantic = (node, _scopes = null) => {
  const oldScopes = scopes, oldInEval = inEval, oldClassFieldInitializerFunc = classFieldInitializerFunc;
  inEval = !!_scopes;
  classFieldInitializerFunc = null;
  // an eval body keeps its program's answer; builtins are typed (as codegen has it)
  if (!_scopes) bigintPossible = !globalThis.precompile && !!node._usesBigInt;
  if (!_scopes) {
    _scopes = [ node ];
    _scopes.lastFuncs = [ 0 ];
    semantic.literalCalls = new Map();
  }
  scopes = _scopes;

  analyze(node, !!scopes.at(-1)?._strictEval);
  if (scopes.length !== _scopes.length) throw new Error('Scope mismatch');

  annotate(node);
  scopes = oldScopes;
  inEval = oldInEval;
  classFieldInitializerFunc = oldClassFieldInitializerFunc;
  return node;
};
export default semantic;
semantic.objectHack = x => x;
semantic.literalCalls = new Map();
