import {
  K, T, FX, N_KIND, N_TYPE, N_FX, N_A, N_B, N_C,
  Const, JvConst, DataRef, Local, Global, Assign,
  Bin, Un, Select, Convert, CONVERT_SIGNED, CONVERT_RANGE_KNOWN,
  Reinterpret, Box, JvType, JvNum, JvPtr, JvIsNum, Eq, Add, Cmp, JvTruthy, JvFalsy, JvNullish,
  Load, Store, MemCopy, MemFill,
  If, Loop, Break, Continue, BlockStmt, TypeSwitch, Return, Unreachable,
  Call, CallDynamic, Try, Throw, ThrowNew, Await, Yield,
  Alloc, GcBarrier, ArrGet, ArrSet, ArrLenSet, LenGet, LenSet, RawC, FuncIdx, FuncRec, ArrAlloc, EnvAlloc, FnAlloc, Clone
} from './ir.js';
import { BuiltinFuncs, BuiltinVars, fullPrototypes } from './builtins.js';
import { memberIndex, TYPED_ARRAY_KINDS } from './builtinDescriptors.js';
import { TYPES, TYPE_FLAGS, TYPE_NAMES } from './types.js';
import semantic, { knownValue, unknownValue } from './semantic.js';
import escapeAnalysis from './escape.js';
import inlineCalls from './inline.js';
import parse from './parse.js';
import temporalPolyfillSource from './temporal.js';
import './prefs.js';

// jsval constants
const valNum = x => Const(T.jsval, x);
const valUndefined = () => JvConst(TYPES.undefined, 0);
const valNull = () => JvConst(TYPES.object, 0);
const valBool = b => JvConst(TYPES.boolean, b ? 1 : 0);
const valOf = (payloadExpr, typeExpr) => Box(payloadExpr, typeof typeExpr === 'number' ? Const(T.i32, typeExpr) : typeExpr);
const valNumber = x => x[N_TYPE] === T.jsval ? x : Box(x, Const(T.i32, TYPES.number));
const numValue = x => x[N_TYPE] === T.f64 ? x
  : x[N_TYPE] === T.i32 ? Convert(T.f64, x, CONVERT_SIGNED)
  : x[N_TYPE] === T.u32 || x[N_TYPE] === T.ptr ? Convert(T.f64, x)
  : JvNum(x);
const isRawNum = x => x[N_TYPE] === T.f64 || x[N_TYPE] === T.i32 || x[N_TYPE] === T.u32 || x[N_TYPE] === T.ptr;
const intLiteralValue = x => {
  if (x[N_KIND] === K.Const && (x[N_TYPE] === T.jsval || x[N_TYPE] === T.f64) && Number.isInteger(x[N_A])) return x[N_A];
  if (x[N_KIND] === K.Box && x[N_B]?.[N_KIND] === K.Const && x[N_B][N_A] === TYPES.number) return intLiteralValue(x[N_A]);
};
const isIntLiteral = x => intLiteralValue(x) !== undefined;
const isRawInt = x => x[N_TYPE] === T.i32 || x[N_TYPE] === T.u32 || x[N_TYPE] === T.i64 || x[N_TYPE] === T.u64 || x[N_TYPE] === T.ptr;
// a literal fits a raw int type if representable at that width by EITHER signedness:
// wrapping +/-/* are bit-identical for i32/u32, so e.g. 3266489917 (> INT32_MAX) must stay
// raw i32 (Math.imul / >>> semantics), only genuinely-out-of-width values fall back to f64
const intLiteralFits = (type, value) =>
  type === T.i32 || type === T.u32 || type === T.ptr ? value >= -2147483648 && value <= 4294967295
  : type === T.i64 || type === T.u64 ? value >= -9007199254740991 && value <= 9007199254740991
  : false;
const rawIntType = (left, right) => {
  if (!isRawInt(left) && !isRawInt(right)) return null;
  if (!isRawInt(left) && !isIntLiteral(left)) return null;
  if (!isRawInt(right) && !isIntLiteral(right)) return null;
  const type =
    left[N_TYPE] === T.i64 || right[N_TYPE] === T.i64 ? T.i64
    : left[N_TYPE] === T.u64 || right[N_TYPE] === T.u64 ? T.u64
    : left[N_TYPE] === T.ptr || right[N_TYPE] === T.ptr ? T.u32
    : left[N_TYPE] === T.u32 || right[N_TYPE] === T.u32 ? T.u32
    : T.i32;
  const leftLiteral = intLiteralValue(left);
  const rightLiteral = intLiteralValue(right);
  if (leftLiteral !== undefined && !intLiteralFits(type, leftLiteral)) return null;
  if (rightLiteral !== undefined && !intLiteralFits(type, rightLiteral)) return null;
  return type;
};
const rawIntValue = (type, v) => v[N_TYPE] === type ? v
  : isIntLiteral(v) ? Const(type, intLiteralValue(v))
  : Convert(type, v, type === T.i32 || type === T.i64 ? CONVERT_SIGNED : 0);
const rawAddType = (left, right) => {
  const rawInt = rawIntType(left, right);
  if (rawInt != null) return left[N_TYPE] === T.ptr ? T.ptr : rawInt;
  if (!isRawNum(left) || !isRawNum(right)) return null;
  if (left[N_TYPE] === T.f64 || right[N_TYPE] === T.f64) return T.f64;
  if (left[N_TYPE] === T.ptr || left[N_TYPE] === T.u32) return left[N_TYPE];
  if (right[N_TYPE] === T.ptr || right[N_TYPE] === T.u32) return right[N_TYPE];
  return T.i32;
};
const coerceValue = (v, type) => type === T.jsval ? (v[N_TYPE] === T.jsval ? v : valNumber(v))
  : v[N_TYPE] === type ? v
  : type === T.ptr ? (isRawInt(v) ? Convert(T.ptr, v, 0) : JvPtr(v))
  : type === T.f64 ? numValue(v)
  : (type === T.i32 || type === T.u32) && isRawInt(v) ? Convert(type, v, type === T.i32 ? CONVERT_SIGNED : 0)
  : Convert(type, numValue(v), type === T.i32 ? CONVERT_SIGNED : 0);
const coerceReturnValue = (scope, v) => {
  if (scope.retType !== T.jsval) return coerceValue(v, scope.retType);
  if (v[N_TYPE] === T.jsval) {
    if (scope.returnType > 5) return Box(JvPtr(v), Const(T.i32, scope.returnType));
    return v;
  }
  if (scope.returnType != null && scope.returnType !== TYPES.number) return Box(v, Const(T.i32, scope.returnType));
  return valNumber(v);
};

// a derived constructor knows whether super() was called when every super() in it is its
// own (not an arrow's) and no direct eval could make one
const tracksSuperCall = scope => scope._tracksSuperCall ??= !!scope.subclass && !!scope.constr && (() => {
  let direct = true;
  const walk = (node, nested) => {
    if (!direct || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, nested); return; }
    if (node.type === 'CallExpression' && ((node.callee.type === 'Super' && nested) ||
      (node.callee.type === 'Identifier' && node.callee.name === 'eval'))) { direct = false; return; }
    const inner = nested || isFuncType(node.type);
    for (const k in node) if (k[0] !== '_' && k !== 'parent' && k !== 'loc' && k !== 'range') walk(node[k], inner);
  };
  walk(scope.ast?.body, false);
  return direct;
})();

const initBuilder = scope => {
  scope.body = [];
  scope.blockStack = [ scope.body ];
  scope.thisDefaulted = false;
  scope.locals ??= Object.create(null);
  scope.tmpPool = Object.create(null);
  scope.tmpBusy = [];
  scope.tmpCount = Object.create(null);
  scope.labelId ??= 0;
};

const curBlock = scope => scope.blockStack[scope.blockStack.length - 1];
const stmt = (scope, node) => { if (node != null) curBlock(scope).push(node); };
const CLASS_FIELD_INIT_MARKER = Symbol('class field init');

// evaluate for effects, discard value
const exprStmt = (scope, node) => {
  if (node == null) return;
  const isIRNode = Array.isArray(node) && typeof node[N_KIND] === 'number' && typeof node[N_TYPE] === 'number' && typeof node[N_FX] === 'number';
  if (!isIRNode && Array.isArray(node)) {
    for (const x of node) exprStmt(scope, x);
    return;
  }
  if (node[N_TYPE] === T.none) { stmt(scope, node); return; }
  if ((node[N_FX] & (FX.call | FX.writeMem | FX.writeLocal)) !== 0) stmt(scope, node);
};

const collect = (scope, fn) => {
  const list = [];
  const m = mark(scope);
  scope.blockStack.push(list);
  try { fn(); } finally { scope.blockStack.pop(); }
  release(scope, m);
  return list;
};

// scratch temp from the per-type pool, minted on first use
const tmp = (scope, type = T.jsval, init = null) => {
  const pool = scope.tmpPool[type] ??= [];
  let name = pool.pop();
  if (name === undefined) {
    name = `#${type}${scope.tmpCount[type] = (scope.tmpCount[type] ?? 0) + 1}`;
    scope.locals[name] = { type, temp: true };
  }
  scope.tmpBusy.push({ name, type });
  const node = Local(name, type);
  if (init != null) stmt(scope, Assign(node, init));
  return node;
};

// release() returns temps taken since mark, only release where provably dead (reuse-while-live miscompiles)
const mark = scope => scope.tmpBusy.length;
const release = (scope, m) => {
  const busy = scope.tmpBusy;
  while (busy.length > m) {
    const { name, type } = busy.pop();
    scope.tmpPool[type].push(name);
  }
};

// named local that survives the whole function, never pooled
const local = (scope, name, type = T.jsval) => {
  const l = scope.locals[name];
  if (l) return Local(name, l.type);
  scope.locals[name] = { type };
  return Local(name, type);
};

// make expr safe to reference twice: consts/locals as-is, the rest into a temp
const reuse = (scope, expr) => {
  const k = expr[N_KIND];
  if (k === K.Const || k === K.Local || k === K.JvConst || k === K.Global || k === K.DataRef) return expr;
  if (k === K.Box &&
      (expr[N_A][N_KIND] === K.Const || expr[N_A][N_KIND] === K.DataRef) &&
      expr[N_B][N_KIND] === K.Const) return expr;
  return tmp(scope, expr[N_TYPE], expr);
};

// reuse but always a named node (Local/Global): callers mint an AST Identifier from N_A
const reuseNamed = (scope, expr) => {
  const k = expr[N_KIND];
  if (k === K.Local || k === K.Global) return expr;
  return tmp(scope, expr[N_TYPE], expr);
};

const assign = (scope, target, value) => stmt(scope, Assign(target, value));

// A write barrier on an object allocated since the last point a collection could run does
// nothing: the object is young (card scans skip young objects) and its GC kind is already its
// type. freshMark, right after the allocation, notes where the code stands; stillFresh says
// whether nothing emitted since can collect (no call or allocation, nested bodies included),
// so the barrier can be left out. A different block (a branch opened since) is not fresh.
const mayCollect = node => {
  if (!Array.isArray(node)) return false;
  if (typeof node[N_KIND] === 'number' && typeof node[N_FX] === 'number') {
    if ((node[N_FX] & FX.call) !== 0) return true;
    for (let i = 3; i < node.length; i++) if (mayCollect(node[i])) return true;
    return false;
  }
  for (const x of node) if (mayCollect(x)) return true;
  return false;
};
const freshMark = scope => {
  const block = curBlock(scope);
  return { block, pos: block.length, dead: false };
};
const stillFresh = (scope, mark) => {
  if (mark == null || mark.dead || curBlock(scope) !== mark.block) return false;
  const block = mark.block;
  for (; mark.pos < block.length; mark.pos++) {
    if (mayCollect(block[mark.pos])) { mark.dead = true; return false; }
  }
  return true;
};

const emitIf = (scope, cond, thenFn, elseFn = null) => {
  const then = collect(scope, thenFn);
  const els = elseFn ? collect(scope, elseFn) : null;
  stmt(scope, If(cond, then, els));
};

const fresh = scope => `L${scope.labelId++}`;
const identNode = name => typeof name === 'string' ? { type: 'Identifier', name } : name;
const memberNode = (object, property, computed = false, extra = null) => extra
  ? { type: 'MemberExpression', object, property, computed, ...extra }
  : { type: 'MemberExpression', object, property, computed };

const genStmt = (scope, node) => {
  const m = mark(scope);
  exprStmt(scope, generate(scope, node));
  release(scope, m);
};

// bytes pushed to `data` are referenced by DataRef(id), render assigns the offsets
const i32Bytes = x => [ x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff ];

// static data lives in its user's unit so each unit's text is self-contained
const unitOf = scope => scope.internal ? 'builtins' : scope.unit ?? 'main';
const dataSeg = (unit, key, bytes) => {
  if (!modular) unit = 'main';
  if (key != null) {
    const cached = dataCache.get(unit + '\0' + key);
    if (cached !== undefined) return cached;
  }
  const id = data.push(bytes) - 1;
  dataUnits[id] = unit;
  if (key != null) dataCache.set(unit + '\0' + key, id);
  return id;
};
const dataRef = (unit, key, bytes) => DataRef(dataSeg(unit, key, bytes));

const isFuncType = type =>
  type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression' ||
  type === 'ClassDeclaration' || type === 'ClassExpression';
const hasFuncWithName = name =>
  name in funcIndex || name in builtinFuncs;

let doNotMarkFuncRef = false;

// an escaping coroutine func can be called dynamically: mark its generator/promise type
// used so prototype dispatch (.next/.then) is included, mirroring generateCall's direct path
const coroTypeUsed = func => {
  if (!func.generator && !func.async) return;
  useType(func.async ? (func.generator ? TYPES.__porffor_asyncgenerator : TYPES.promise) : TYPES.__porffor_generator);
  if (func.async && func.generator) useType(TYPES.promise);
};

const useFunctionValue = (func, markReferenced = true) => {
  if (markReferenced && !doNotMarkFuncRef) func.referenced = true;
  if (!func.indirect) {
    func.indirect = true;
    factSet('indirect', func.name);
  }
  coroTypeUsed(func);
  if (markReferenced) func.generate?.();
};

// function value with no env: one static [fnIdx][0] record per func
const funcRef = (func, markReferenced = true) => {
  useFunctionValue(func, markReferenced);
  return valOf(FuncRec(func.index), TYPES.function);
};

const closureAwareFunc = func =>
  Prefs.closures &&
  !func.internal &&
  !func.noClosureEnv &&
  !func.topLevel &&
  !!(func.closureCaptures || func.closureCapturesThis || func.closurePassThrough);

const hasClosureOwnEnv = scope => closureLayout(scope).count > 0;

const hasClosureCaptures = func =>
  !!(func.closureCaptures || func.closureCapturesThis || func.closurePassThrough);

const directCallOnlyFunctionBinding = (scope, kind, name, node, func) =>
  (kind === 'const' || (kind === 'var' && (node._directCallMinStart ?? -1) > (node._declarator?.end ?? node.end ?? node.start ?? 0))) &&
  !func.selfAware &&
  (node._directCallRefs ?? 0) > 0 &&
  (node._valueRefs ?? 0) === 0 &&
  (node._writes ?? 0) === 0 &&
  !scope.closureOwnLocals?.[name];

const directCallOnlyRefs = node =>
  (node?._directCallRefs ?? 0) > 0 &&
  (node?._valueRefs ?? 0) === 0 &&
  (node?._writes ?? 0) === 0;

const nodeHasPerIterationCaptures = node => {
  const captures = node?._captures ?? {};
  for (const name in captures) if (captures[name].perIteration) return true;
  return false;
};

const directCallOnlyFunctionNode = node =>
  isFuncType(node?.type) &&
  !node._selfAware &&
  !node._usesArguments &&
  !nodeHasPerIterationCaptures(node) &&
  directCallOnlyRefs(node);

// a closure snapshots a per-iteration binding's value when it is made. That is only right
// while nothing writes the binding afterwards: one written in the loop body or by a closure
// lives in a box instead (a one-slot env, a fresh one per iteration), and the snapshot copies
// the box. A for (let ...) binding written only by its test and update keeps the snapshot.
const perIterationBox = node => {
  if (!node?._perIterationCaptured || node.type !== 'Identifier') return false;
  const variable = node._variable;
  if (variable?.kind === 'const') return false;
  return variable?.scope?.type === 'ForStatement' ? (node._loopBodyWrites ?? 0) > 0 : (node._writes ?? 0) > 0;
};

const boxLocalName = name => `#box_${name}`;

// the binding node behind a name a function snapshots (its own capture, or one of a captured
// function's)
const snapshotCaptureNode = (func, name) => {
  const own = func.closureCaptures?.[name];
  if (own) return own.node;
  for (const n in func.closureCaptures ?? {}) {
    const inner = func.closureCaptures[n]?.node?._func?.closureCaptures?.[name];
    if (inner) return inner.node;
  }
  return null;
};

const ownBoxedBinding = (scope, name) => perIterationBox(scope.closureOwnLocals?.[name]?.node);

// a new box for a boxed binding, holding value
const allocBindingBox = (scope, name, value = valUndefined()) => {
  const v = reuse(scope, value);
  assign(scope, local(scope, boxLocalName(name)), makeClosureEnv(scope, valUndefined(), 1, [ v ]));
};

// the next iteration's copy of each boxed for (let ...) binding (CreatePerIterationEnvironment)
const copyLoopBindingBoxes = (scope, init) => {
  if (init?.type !== 'VariableDeclaration' || init.kind !== 'let') return;
  for (const d of init.declarations) {
    if (d.id?.type !== 'Identifier' || !ownBoxedBinding(scope, d.id.name)) continue;
    const box = boxSlotNode(identNode(boxLocalName(d.id.name)));
    allocBindingBox(scope, d.id.name, generate(scope, box));
  }
};

const boxSlotNode = box => memberNode(box, { type: 'Literal', value: 1 }, true, {
  _closureSlot: 1,
  _skipChainDepth: true
});

const closureBindingNeedsSlot = capture =>
  !directCallOnlyFunctionNode(capture?.node) && !perIterationBox(capture?.node);

// own env layout: name -> 1-based slot
const closureLayout = scope => {
  if (scope.closureLayout) return scope.closureLayout;

  const slots = Object.create(null);
  let count = 0;
  for (const name in scope.closureOwnLocals ?? {}) {
    if (closureBindingNeedsSlot(scope.closureOwnLocals[name])) slots[name] = ++count;
  }
  if (scope.closureOwnThis) slots['#this'] = ++count;
  if (scope.closureOwnNewTarget) slots['#newtarget'] = ++count;
  if (scope.closureOwnCallee) slots['#callee'] = ++count;

  return scope.closureLayout = { slots, count };
};

const getPerIterationClosureCaptureNames = func => {
  if (!func) return [];
  if (func.perIterationClosureCaptureNames) return func.perIterationClosureCaptureNames;

  const out = [];
  for (const name in func.closureCaptures ?? {}) {
    if (func.closureCaptures[name]?.perIteration) out.push(name);
  }

  return func.perIterationClosureCaptureNames = out;
};

const getClosureSnapshotCaptureNames = func => {
  if (!func) return [];
  if (func.closureSnapshotCaptureNames) return func.closureSnapshotCaptureNames;

  const out = new Set(getPerIterationClosureCaptureNames(func));

  for (const name in func.closureCaptures ?? {}) {
    const capture = func.closureCaptures[name];
    const capturedFunc = capture?.node?._func;
    if (!capturedFunc) continue;

    for (const name of getPerIterationClosureCaptureNames(capturedFunc)) {
      out.add(name);
    }
  }

  return func.closureSnapshotCaptureNames = [ ...out ];
};

const closureOwnerMatches = (scope, owner) =>
  scope?.ast === owner ||
  scope?.ast?._closureSource === owner ||
  (
    owner?.type === 'Program' &&
    scope?.ast?.type === 'Program' &&
    scope.ast._variables === owner._variables
  );

// rawBox: a boxed binding's box itself (what a snapshot copies), not the value in it
const closureEnvNode = (scope, name, owner, rawBox = false) => {
  let node = identNode(hasClosureOwnEnv(scope) ? '#closure_env_local' : '#closure_env');
  let slot;
  const start = scope;
  for (;; scope = scope.parentFunc) {
    if (closureOwnerMatches(scope, owner)) {
      if (name == null) return node;
      if (ownBoxedBinding(scope, name)) {
        // the box sits in the owner's local, other functions reach it through their snapshot
        if (scope !== start) throw new Error(`boxed binding ${name} read outside a snapshot in ${start.name}`);
        const box = identNode(boxLocalName(name));
        return rawBox ? box : boxSlotNode(box);
      }
      slot = closureLayout(scope).slots[name] ?? 0;
      break;
    }
    if (hasClosureOwnEnv(scope)) {
      node = memberNode(node, { type: 'Literal', value: 0 }, true, { _closureSlot: 0 });
    }
    // snapshots sit between a function's own env and its parent's
    const names = getClosureSnapshotCaptureNames(scope);
    slot = names.indexOf(name) + 1;
    if (slot) {
      if (perIterationBox(snapshotCaptureNode(scope, name))) {
        const box = memberNode(node, { type: 'Literal', value: slot }, true, { _closureSlot: slot, _skipChainDepth: true });
        return rawBox ? box : boxSlotNode(box);
      }
      break;
    }
    if (names.length) {
      node = memberNode(node, { type: 'Literal', value: 0 }, true, { _closureSlot: 0 });
    }
  }
  return memberNode(node, { type: 'Literal', value: slot }, true, {
    _closureSlot: slot,
    _skipChainDepth: true
  });
};
const closureLocalReadNode = (name, markReferenced = true) => ({
  type: 'Identifier',
  name,
  _skipClosureOwnLocals: true,
  _markFunctionReferenced: markReferenced
});

// mirror a binding into the scope's own closure env
const mirrorToClosureEnv = (scope, name, right = closureLocalReadNode(name)) =>
  genStmt(scope, { type: 'AssignmentExpression', operator: '=',
    left: closureEnvNode(scope, name, scope.ast), right });

const closureOwnLocalReadIsLocal = (scope, name) =>
  name in scope.locals &&
  !scope.closureOwnLocals?.[name]?.node?._writes;

const currentClosureEnv = scope => {
  if (hasClosureOwnEnv(scope)) {
    if (!scope.locals['#closure_env_local']) {
      throw new Error(`missing #closure_env_local in ${scope.name}`);
    }
    return Local('#closure_env_local', T.jsval);
  }
  if (scope.closureAware) return valOf(Local('#env', T.ptr), TYPES.__porffor_closureenv);
  return valUndefined();
};

// [parent u32][count u32][payload f64, type u8, padding x7]...
const makeClosureEnv = (scope, parent, count, values = null) => {
  // parent and count filled in, every slot undefined (porf_env_alloc)
  const pointer = reuse(scope, EnvAlloc(JvPtr(parent), Const(T.i32, count)));
  const allocated = freshMark(scope);
  if (values) {
    for (let i = 0; i < values.length; i++) {
      stmt(scope, Store('f64', pointer, 8 + i * 16, JvNum(values[i])));
      stmt(scope, Store('u8', pointer, 16 + i * 16, JvType(values[i])));
    }
  }
  if (!stillFresh(scope, allocated)) stmt(scope, GcBarrier(pointer, Const(T.i32, TYPES.__porffor_closureenv)));
  typeUsed(scope, TYPES.__porffor_closureenv);
  return valOf(pointer, TYPES.__porffor_closureenv);
};

// the env a closure of func runs with, made here: the current one, under a snapshot of its
// per-iteration captures when it has any (closureEnvNode reads them one level below its own)
const closureEnvFor = (scope, func) => {
  const env = currentClosureEnv(scope);
  const snap = getClosureSnapshotCaptureNames(func);
  if (snap.length === 0) return env;

  const parent = reuse(scope, env);
  const values = [];
  for (const name of snap) {
    values.push(reuse(scope, generate(scope, { type: 'Identifier', name, _closureFunc: func.closureCaptures?.[name]?.func, _rawBox: true })));
  }
  return reuse(scope, makeClosureEnv(scope, parent, values.length, values));
};

// closure value: heap [fnIdx][env] record, per-iteration captures get a snapshot env chained to the parent
const makeClosureRecord = (scope, func, markReferenced = true) => {
  useFunctionValue(func, markReferenced);

  const env = closureEnvFor(scope, func);
  const rec = reuse(scope, FnAlloc(FuncIdx(func.index), JvPtr(env)));
  return valOf(rec, TYPES.function);
};

// builtins and top-level funcs only ever have one instance, so one static record
const staticFuncIdentity = func =>
  func.internal || !func.parentFunc || func.parentFunc.topLevel;

// non-capturing nested funcs still mint a fresh record per evaluation for identity
const makeFreshFuncRecord = (scope, func, markReferenced = true) => {
  useFunctionValue(func, markReferenced);
  const rec = reuse(scope, FnAlloc(FuncIdx(func.index), Const(T.u32, 0)));
  return valOf(rec, TYPES.function);
};

const makeFunctionValue = (scope, func, markReferenced = true) => {
  if (hasClosureCaptures(func)) return makeClosureRecord(scope, func, markReferenced);
  if (staticFuncIdentity(func)) return funcRef(func, markReferenced);
  return makeFreshFuncRecord(scope, func, markReferenced);
};

// a function expression is a new object each evaluation, never the static record
const materializeFunctionExpr = (scope, func, markReferenced = true) => {
  if (hasClosureCaptures(func)) return makeClosureRecord(scope, func, markReferenced);
  if (func.internal) return funcRef(func, markReferenced);
  return makeFreshFuncRecord(scope, func, markReferenced);
};

const materializeFunctionValue = (scope, func, markReferenced = true) => {
  if (staticFuncIdentity(func) && !hasClosureCaptures(func)) return funcRef(func, markReferenced);
  // per-iteration captures snapshot on every read, a cache can't tell iterations apart
  if (getPerIterationClosureCaptureNames(func).length > 0) return makeFunctionValue(scope, func, markReferenced);
  return cachedFunctionValue(scope, func, markReferenced);
};

// one record per activation: shared within it, fresh next call (cache resets to undefined)
const cachedFunctionValue = (scope, func, markReferenced = true) => {
  const cache = local(scope, `#func_cache_${func.start ?? func.index}`, T.jsval);
  emitIf(scope, Bin('!=', T.i32, JvType(cache), Const(T.i32, TYPES.function)),
    () => assign(scope, cache, makeFunctionValue(scope, func, markReferenced)));
  return cache;
};

const generate = (scope, decl, name = undefined, valueUnused = false) => {
  if (valueUnused && !Prefs.optUnused) valueUnused = false;

  switch (decl.type) {
    case 'BinaryExpression':
      return generateBinaryExp(scope, decl);

    case 'LogicalExpression':
      return generateLogicExp(scope, decl);

    case 'Identifier':
      return generateIdent(scope, decl);

    case 'FunctionDeclaration': {
      const [ func, out ] = generateFunc(scope, decl);
      if (decl._writes && !decl._skipVarUpdate) {
        const name = decl.id.name, global = scope.topLevel;
        allocVar(scope, name, global);
        setLocalWithType(scope, name, global, materializeFunctionValue(scope, func), false, TYPES.function);
      }
      const capture = scope.closureOwnLocals?.[decl.id?.name];
      // never reassigned, the binding is this function: read by name, a global of the same
      // name would win over it
      if (capture && closureBindingNeedsSlot(capture))
        mirrorToClosureEnv(scope, decl.id.name, { ...closureLocalReadNode(decl.id.name, false), _funcValue: decl._writes ? null : func });
      return out;
    }

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return generateFunc(scope, decl)[1];

    case 'BlockStatement':
      return generateBlock(scope, decl);

    case 'ReturnStatement':
      return generateReturn(scope, decl);

    case 'ExpressionStatement':
      return generateExp(scope, decl);

    case 'SequenceExpression':
      return generateSequence(scope, decl);

    case 'ChainExpression':
      return generateChain(scope, decl);

    case 'CallExpression':
    case 'NewExpression':
      return generateCall(scope, decl);

    case 'ThisExpression':
      return generateThis(scope, decl);

    case 'Super':
      return generateSuper(scope, decl);

    case 'Literal':
      return generateLiteral(scope, decl);

    case 'VariableDeclaration':
      return generateVar(scope, decl);

    case 'AssignmentExpression':
      return generateAssign(scope, decl, valueUnused);

    case 'UnaryExpression':
      return generateUnary(scope, decl);

    case 'UpdateExpression':
      return generateUpdate(scope, decl, valueUnused);

    case 'IfStatement':
      return generateIf(scope, decl);

    case 'ForStatement':
      return genLoop(scope, decl, 'for');

    case 'WhileStatement':
      return genLoop(scope, decl, 'while');

    case 'DoWhileStatement':
      return genLoop(scope, decl, 'dowhile');

    case 'ForOfStatement':
      return generateForOf(scope, decl);

    case 'ForInStatement':
      return generateForIn(scope, decl);

    case 'SwitchStatement':
      return generateSwitch(scope, decl);

    case 'BreakStatement':
      return generateBreak(scope, decl);

    case 'ContinueStatement':
      return generateContinue(scope, decl);

    case 'LabeledStatement':
      return generateLabel(scope, decl);

    case 'EmptyStatement':
      return valUndefined();

    case 'MetaProperty':
      return generateMeta(scope, decl);

    // the linker turns import() into a call loading what it resolves to. unlinked (no file to
    // resolve from), it still evaluates its arguments and rejects
    case 'ImportExpression':
      return generate(scope, { type: 'CallExpression', optional: false, callee: { type: 'Identifier', name: '__Porffor_import' }, arguments: [
        { type: 'ArrowFunctionExpression', params: [], async: false, generator: false, expression: false, body: { type: 'BlockStatement', body: [
          { type: 'ThrowStatement', argument: { type: 'NewExpression', callee: { type: 'Identifier', name: 'Error' }, arguments: [ { type: 'Literal', value: 'porffor: import() without a file to resolve from' } ] } }
        ] } },
        decl.source,
        decl.options ?? { type: 'UnaryExpression', operator: 'void', prefix: true, argument: { type: 'Literal', value: 0 } }
      ] });

    case 'ConditionalExpression':
      return generateConditional(scope, decl);

    case 'ThrowStatement':
      return generateThrow(scope, decl);

    case 'TryStatement':
      return generateTry(scope, decl);

    case 'DebuggerStatement':
      return valUndefined();

    case 'ArrayExpression':
      return generateArray(scope, decl, name, globalThis.precompile);

    case 'ObjectExpression':
      return generateObject(scope, decl);

    case 'MemberExpression':
      return generateMember(scope, decl);

    case 'ClassExpression':
    case 'ClassDeclaration':
      return generateClass(scope, decl);

    case 'AwaitExpression':
      return generateAwait(scope, decl);

    case 'YieldExpression':
      return generateYield(scope, decl);

    case 'TemplateLiteral':
      return generateTemplate(scope, decl);

    case 'TaggedTemplateExpression':
      return generateTaggedTemplate(scope, decl);

    case 'ExportNamedDeclaration':
      if (!decl.declaration) {
        for (const spec of decl.specifiers ?? []) {
          const local = spec.local?.name;
          if (!local) continue;

          const func = resolveNamedFunction(scope, local);
          if (!func || func.internal) {
            return internalThrow(scope, 'Error', `porffor: unsupported export '${local}'`);
          }

          func.export = true;
          if (spec.exported?.name && spec.exported.name !== local) func.exportName = spec.exported.name;
          func.generate?.();
        }

        return valUndefined();
      }

      {
        const funcsBefore = new Set(funcs);
        generate(scope, decl.declaration);
        for (const x of funcs) {
          if (funcsBefore.has(x) || x.internal) continue;
          x.export = true;
          x.exportName ??= x.name;
          x.generate?.();
        }
      }

      return valUndefined();

    case 'TSAsExpression': {
      const value = generate(scope, decl.expression);
      const type = extractTypeAnnotation(decl);
      if (type.irType) {
        if (value[N_TYPE] === type.irType) return value;
        if (type.irType === T.f64) return numValue(value);
        if (type.irType === T.ptr) return JvPtr(value);
        return Convert(type.irType, numValue(value), type.irType === T.i32 ? CONVERT_SIGNED : 0);
      }
      if (type.type === TYPES.bigint) return Box(numValue(value), Const(T.i32, TYPES.bigint));
      if (type.type != null && value[N_TYPE] !== T.jsval)
        return Box(type.type === TYPES.number ? numValue(value) : value, Const(T.i32, type.type));
      if (type.type > 5) return Box(JvPtr(value), Const(T.i32, type.type));
      return value;
    }

    case 'WithStatement': return generate(scope, decl.body);

    case 'PrivateIdentifier':
      if (decl._private) return Global(decl._private.global, T.jsval);
      return generate(scope, {
        type: 'Literal',
        value: privateIDName(decl.name)
      });

    case 'TSEnumDeclaration':
      return generateEnum(scope, decl);

    default:
      // ignore typescript nodes
      if (decl.type.startsWith('TS') ||
          decl.type === 'ImportDeclaration' && decl.importKind === 'type') {
        return valUndefined();
      }

      return internalThrow(scope, 'Error', `porffor: no generation for ${decl.type}`);
  }
};

const generateEnum = (scope, decl) => {
  // todo: opt const enum into compile-time values
  const properties = [];

  let value = -1;
  for (const x of decl.members) {
    if (x.initializer) {
      value = x.initializer;
    } else {
      if (typeof value === 'number') {
        value = {
          type: 'Literal',
          value: value + 1
        };
      } else {
        value = {
          type: 'Identifier',
          value: undefined
        };
      }
    }

    // enum.key = value
    properties.push({
      key: x.id,
      value,
      kind: 'init'
    });

    // enum[value] = key
    properties.push({
      key: value,
      value: {
        type: 'Literal',
        value: x.id.name
      },
      computed: true,
      kind: 'init'
    });

    value = value?.value;
  }

  generateVarDstr(scope, decl.const ? 'const' : 'let', decl.id, {
    type: 'ObjectExpression',
    properties
  }, undefined, false);
  return valUndefined();
};

const lookupName = (scope, name) => {
  if (name === undefined) return [ undefined, undefined ];
  if (name in scope.locals) return [ scope.locals[name], false ];
  if (name in globals) return [ globals[name], true ];

  return [ undefined, undefined ];
};

// a builtin global shadowed by a user binding (e.g. sta.js `function Test262Error() {}`)
// no longer refers to the builtin: name-based special-casing must not apply
const builtinShadowed = (scope, name) => {
  if (lookupName(scope, name)[0] != null) return true;
  const named = resolveNamedFunction(scope, name);
  return named != null && !named.internal;
};

// lightweight throw: a bare error-typed jsval carrying the message bytestring offset (ThrowNew)
const internalThrow = (scope, constructor, message) => {
  message = Prefs.d ? `${message} (in ${scope.name})` : message;
  const msg = message
    ? dataRef(unitOf(scope), `#msg:${message}`, [ ...i32Bytes(message.length), ...[...message].map(c => c.charCodeAt(0) & 0xff) ])
    : Const(T.u32, 0);
  const errType = TYPES[constructor.toLowerCase()] ?? TYPES.error;
  typeUsed(scope, errType);
  stmt(scope, ThrowNew(errType, msg));
  return valUndefined();
};

const lookup = (scope, name, allowImplicitArguments = true, markFunctionReferenced = true) => {
  if (globalThis.precompile && name === '_argc' && scope.usesArguments)
    return Box(Convert(T.f64, LenGet(JvPtr(Local('#allargs', T.jsval)))), Const(T.i32, TYPES.number));

  if (name in scope.locals) {
    const local = Local(name, scope.locals[name].type);
    return scope.locals[name].type === T.f64 ? valNumber(local) : local;
  }

  // undefined/NaN/Infinity are values, not bindings
  if (name === 'undefined') return valUndefined();
  if (name === 'NaN') return valNum(NaN);
  if (name === 'Infinity') return valNum(Infinity);

  // implicit `arguments`: the #allargs param (render materialises all args, no raw argv access)
  if (allowImplicitArguments && scope.usesArguments && name === 'arguments' && !scope.arrow)
    return Local('#allargs', T.jsval);

  // self-reference reads the function's own value (#callee), preserving identity; a
  // declaration whose name is assigned is read through its binding, which may differ now
  if (scope.selfAware && name === scope.name && !scope.ast?._reassigned) return Local('#callee', T.jsval);

  if (name in globals) {
    const global = Global(name, globals[name].type ?? T.jsval);
    return (globals[name].type ?? T.jsval) === T.f64 ? valNumber(global) : global;
  }

  const hoisted = !(name in funcIndex) && lookupHoistedVar(scope, name);
  if (hoisted) return hoisted;

  // Porffor.TYPES.x folds to its id
  if (name.startsWith('__Porffor_TYPES_')) return Const(T.i32, TYPES[name.slice(16)]);

  // builtin value globals like Number.MAX_VALUE
  if (name in builtinVars) {
    // Symbol.toPrimitive arrives here as __Symbol_toPrimitive: a read of that member, for the
    // member.<name> comptime flags (a builtin checks for one only in a program that names it)
    if (!globalThis.precompile && name.startsWith('__Symbol_')) demandMember(name.slice(9));
    const v = builtinVars[name];
    return typeof v === 'function' ? v(scope, irBuiltinHelpers(scope, name, {})) : v;
  }

  const namedFunc = resolveNamedFunction(scope, name);
  if (namedFunc) return materializeFunctionValue(scope, namedFunc, markFunctionReferenced);
  if (name in builtinFuncs && !(name in funcIndex)) includeBuiltin(scope, name);
  if (name in funcIndex) return materializeFunctionValue(scope, funcByName(name));

  // missing member of an existing namespace reads as undefined
  if (name.startsWith('__')) {
    if ((name + '$get') in builtinFuncs) return internalThrow(scope, 'TypeError', 'Accessor called without object');
    let parent = name.slice(2).split('_').slice(0, -1).join('_');
    if (parent.includes('_')) parent = '__' + parent;
    if (lookup(scope, parent) != null) return valUndefined();
  }

  // the func referencing itself under another name, the static record keeps identity
  if (scope.name === name) return materializeFunctionValue(scope, funcByIndex(scope.index));

  // the global object inherits Object.prototype: a bare toString (hasOwnProperty, valueOf...)
  // nothing else defines is its method
  if (!name.startsWith('__') && `__Object_prototype_${name}` in builtinFuncs)
    return materializeFunctionValue(scope, includeBuiltin(scope, `__Object_prototype_${name}`), markFunctionReferenced);

  return null;
};

const generateIdent = (scope, decl) => {
  // TDZ: read before its let/const initializer (static flag from binding resolver)
  if (decl._tdz) return internalThrow(scope, 'ReferenceError', `Cannot access '${unhackName(decl.name)}' before initialization`);

  // a typed array's constructor as a value can lead to %TypedArray% (whenTypedArrayReachable)
  if (!globalThis.precompile && TYPED_ARRAY_KINDS.includes(decl.name) && !typedArrayCtorValue) {
    typedArrayCtorValue = true;
    factSet('program', 'typedArrayCtorValue');
  }

  if (decl.name === '#closure_env') {
    if (!scope.closureAware) throw new Error(`missing closure env in ${scope.name}`);
    return currentClosureEnv(scope);
  }

  // a function declaration's own value (closureLocalReadNode for a declaration)
  if (decl._funcValue) return materializeFunctionValue(scope, decl._funcValue, decl._markFunctionReferenced !== false);

  let closureOwner = null;
  if (decl._closureFunc && !(decl.name in scope.locals)) closureOwner = decl._closureFunc;
  else if (!decl._skipClosureOwnLocals && scope.closureOwnLocals?.[decl.name] && !closureOwnLocalReadIsLocal(scope, decl.name)) closureOwner = scope.ast;
  if (closureOwner) {
    const func = decl._resolvedVariable?.node?._porfforFunc ?? resolveNamedFunction(scope, decl.name);
    if (func) useFunctionValue(func, decl._markFunctionReferenced !== false);
    return generate(scope, closureEnvNode(scope, decl.name, closureOwner, decl._rawBox));
  }

  if (decl._builtinMember && decl.name in builtinFuncs) return materializeFunctionValue(scope, includeBuiltin(scope, decl.name));

  // a name from the source the scope analysis found no binding for is not a user function of
  // that name declared somewhere else (a block's function, Annex B skipped: out of its scope)
  // (a let/const local of that name is another block's binding: out of its scope here)
  if (!globalThis.precompile && !decl._resolvedBinding && decl.start != null && decl.name in scope.locals &&
      (scope.locals[decl.name].metadata?.kind === 'let' || scope.locals[decl.name].metadata?.kind === 'const') && !scope.inEval)
    return unresolvedName(scope, unhackName(decl.name));
  if (!globalThis.precompile && !decl._resolvedBinding && decl.start != null && !(decl.name in scope.locals) && !(decl.name in globals)) {
    let bound = false;
    for (let cursor = scope; cursor && !bound; cursor = cursor.parentFunc) bound = !!cursor.namedFuncBindings?.[decl.name];
    const byName = bound ? null : funcByName(decl.name);
    if (byName && !byName.internal) return unresolvedName(scope, unhackName(decl.name));
  }

  const boundFunc = decl._resolvedVariable?.node?._porfforFunc;
  if (boundFunc && decl._resolvedVariable.scope.type !== 'Program' && !decl._resolvedVariable.node._writes) return materializeFunctionValue(scope, boundFunc);
  // a const holding a function expression that no binding stores (generateVarDstr keeps it
  // lazy): the function it was declared with, not whichever function has its name
  const constFunc = decl._resolvedVariable?.kind === 'const' ? decl._resolvedVariable.node?._func : null;
  if (constFunc && !(decl.name in scope.locals) && !(decl.name in globals)) return materializeFunctionValue(scope, constFunc);

  if (decl.name in scope.locals) (scope.locals[decl.name].metadata ??= {}).read = true;
  return lookup(scope, decl.name, !(decl.name === 'arguments' && decl._resolvedBinding), decl._markFunctionReferenced !== false)
    ?? unresolvedName(scope, unhackName(decl.name));
};

// a name nothing defines: the global object's property of that name, which the program may
// have made at run time (UMD's `global.THREE = factory()`), else a ReferenceError where it is
// read. PORF_LIST_UNDEFINED=1 lists them all at the end of the compile (what globals a program
// expects that are not there)
const unresolvedNames = new Set();
const unresolvedName = (scope, name) => {
  if (process.env.PORF_LIST_UNDEFINED && !globalThis.precompile && !unresolvedNames.has(name)) {
    unresolvedNames.add(name);
    process.once('exit', () => { if (unresolvedNames.size) console.error(`undefined names: ${[ ...unresolvedNames ].sort().join(' ')}`); unresolvedNames.clear(); });
  }
  // a name the program assigns bare (sloppy `x = 1` makes it a global) is its binding, which
  // this read comes before: not yet made
  if (globalThis.precompile || name === 'globalThis' || implicitGlobalNames.has(name)) return internalThrow(scope, 'ReferenceError', `${name} is not defined`);

  const has = generate(scope, { type: 'BinaryExpression', operator: 'in', left: { type: 'Literal', value: name }, right: identNode('globalThis') });
  emitIf(scope, falsy(scope, has, TYPES.boolean), () => exprStmt(scope, internalThrow(scope, 'ReferenceError', `${name} is not defined`)));
  // read here, in evaluation order (x + (x = 1) reads x before the assignment makes it)
  const value = tmp(scope, T.jsval);
  assign(scope, value, coerceValue(generate(scope, memberNode(identNode('globalThis'), identNode(name))), T.jsval));
  return value;
};

const generateYield = (scope, decl) => {
  let arg = decl.argument ?? DEFAULT_VALUE;

  if (!scope.generator) {
    // todo: access upper-scoped generator. evaluate for effects, value undefined
    exprStmt(scope, generate(scope, arg));
    return valUndefined();
  }

  if (decl.delegate) {
    const known = knownType(scope, getNodeType(scope, arg));
    if (known === TYPES.__porffor_generator) {
      const delegate = reuse(scope, generate(scope, arg));
      const sent = tmp(scope, T.jsval, valUndefined());
      const result = tmp(scope, T.jsval, valUndefined());
      // 2 once return() reached this yield: passed on to the delegate, whose own finally
      // blocks run (and may yield on), and when it is done this generator returns too
      const mode = tmp(scope, T.i32, Const(T.i32, 0));
      const L = fresh(scope);
      stmt(scope, Loop(null, null, collect(scope, () => {
        const done = reuse(scope, Call('__Porffor_coroutine_resume', [ delegate, sent, mode ], T.i32));
        emitIf(scope, done, () => {
          emitIf(scope, mode, () => generatorReturn(scope, Call('__Porffor_coroutine_value', [ delegate ])));
          assign(scope, result, Call('__Porffor_coroutine_value', [ delegate ]));
          stmt(scope, Break(L));
        });
        assign(scope, sent, Yield(Call('__Porffor_coroutine_value', [ delegate ])));
        assign(scope, mode, Bin('*', T.i32, Call('__Porffor_coroutine_returning', [], T.i32), Const(T.i32, 2)));
      }), L));
      return result;
    }

    // in an async generator, yield* takes async iterables: a for await over them
    const valueName = '#yieldstar' + uniqId(scope);
    generateForOf(scope, {
      type: 'ForOfStatement',
      await: scope.async === true,
      left: {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [ {
          type: 'VariableDeclarator',
          id: { type: 'Identifier', name: valueName },
          init: null
        } ]
      },
      right: arg,
      body: {
        type: 'ExpressionStatement',
        expression: {
          type: 'YieldExpression',
          argument: { type: 'Identifier', name: valueName },
          delegate: false
        }
      }
    });
    return valUndefined();
  }

  return yieldPoint(scope, generate(scope, arg));
};

// a yield, and after it what return() asks for: the generator returns the value sent
const yieldPoint = (scope, value) => {
  const sent = tmp(scope, T.jsval, Yield(value));
  emitIf(scope, Call('__Porffor_coroutine_returning', [], T.i32), () => generatorReturn(scope, sent));
  return sent;
};

// a generator's return of an IR value (return() resuming it at a yield): through any finally
const generatorReturn = (scope, value) => {
  const fin = scope.finallyStack?.[scope.finallyStack.length - 1];
  if (fin) {
    if (scope.retType !== T.none) assign(scope, Local(fin.val, T.jsval), value);
    finallyExit(scope, fin, FIN_RETURN);
    return;
  }
  closeLoops(scope, null, true);
  stmt(scope, scope.retType === T.none ? Return() : Return(value));
};

const generateReturn = (scope, decl) => {
  let arg = decl.argument ?? DEFAULT_VALUE;

  // inside try/catch with a finally: park the value and let the finalizer complete the return
  const fin = scope.finallyStack?.[scope.finallyStack.length - 1];
  if (!fin && depth.some(d => d.genOpen && d.scope === scope)) {
    // leaving for...of loops over generators: the value first, then they close (closeLoops)
    if (scope.retType === T.none) {
      if (arg.type !== 'Identifier') exprStmt(scope, generate(scope, arg));
      arg = { type: 'Identifier', name: 'undefined' };
    } else if (arg.type !== 'Identifier' && arg.type !== 'Literal') {
      const name = '#ret_close' + uniqId(scope);
      allocVar(scope, name);
      assign(scope, Local(name, T.jsval), coerceValue(generate(scope, arg), T.jsval));
      arg = identNode(name);
    }
    closeLoops(scope, null, true);
  }
  if (fin) {
    if (scope.retType === T.none) {
      if (arg.type !== 'Identifier') exprStmt(scope, generate(scope, arg));
    } else {
      assign(scope, Local(fin.val, T.jsval), coerceValue(generate(scope, arg), T.jsval));
    }
    finallyExit(scope, fin, FIN_RETURN);
    return;
  }

  // void IR retType (distinct from porffor returnType): evaluate arg for effects only
  if (scope.retType === T.none) {
    if (arg.type !== 'Identifier') exprStmt(scope, generate(scope, arg));
    stmt(scope, Return());
    return;
  }

  // constructors coerce their return value
  if (scope.constr && !globalThis.precompile) {
    const constructing = () => JvTruthy(Local('#newtarget', T.jsval));
    const retThis = () => {
      // a derived constructor gives back this only once super() has made it
      if (tracksSuperCall(scope)) emitIf(scope, Un('!', T.i32, local(scope, '#super_called', T.i32)),
        () => internalThrow(scope, 'ReferenceError', "Must call super constructor in derived class before returning"));
      stmt(scope, Return(Local('#this', T.jsval)));
    };

    // return undefined / return this give back the new instance when constructing
    if ((arg.type === 'Identifier' && arg.name === 'undefined') || arg.type === 'ThisExpression') {
      if (scope._onlyConstr) return void retThis();
      emitIf(scope, constructing(), retThis, () => stmt(scope, Return(generate(scope, arg))));
      return;
    }

    const ret = reuse(scope, generate(scope, arg));
    const returnRet = () => stmt(scope, Return(coerceReturnValue(scope, ret)));
    if (ret[N_TYPE] !== T.jsval) {
      const primitiveReturn = () => {
        if (scope.subclass) internalThrow(scope, 'TypeError', 'Subclass can only return an object or undefined');
        else retThis();
      };
      if (scope._onlyConstr) primitiveReturn();
      else emitIf(scope, constructing(), primitiveReturn);
      returnRet();
      return;
    }

    const checks = () => {
      // undefined from a subclass gives back the new instance
      if (scope.subclass)
        emitIf(scope, Bin('==', T.i32, JvType(ret), Const(T.i32, TYPES.undefined)), retThis);
      // non-object return -> the new instance (TypeError for subclasses). inlined so a plain
      // class never drags in the object machinery: object iff type id > symbol (strings have
      // length/parity flags, so excluded) and not null (object type, null pointer)
      const t = reuse(scope, JvType(ret));
      const isObject = Bin('&&', T.i32,
        Bin('&&', T.i32,
          Bin('>', T.i32, t, Const(T.i32, TYPES.symbol)),
          Bin('||', T.i32, Bin('!=', T.i32, JvPtr(ret), Const(T.i32, 0)), Bin('!=', T.i32, t, Const(T.i32, TYPES.object)))),
        Bin('&&', T.i32,
          Bin('!=', T.i32, t, Const(T.i32, TYPES.string)),
          Bin('!=', T.i32, t, Const(T.i32, TYPES.bytestring))));
      emitIf(scope, Un('!', T.i32, isObject), () => {
        if (scope.subclass) internalThrow(scope, 'TypeError', 'Subclass can only return an object or undefined');
        else retThis();
      });
    };
    if (scope._onlyConstr) checks();
    else emitIf(scope, constructing(), checks);
    returnRet();
    return;
  }

  stmt(scope, Return(coerceReturnValue(scope, generate(scope, arg))));
};

// a + b: both known primitive strings -> direct strcat, else the coercing concatStrings builtin
const knownStr = ty => ty === TYPES.string || ty === TYPES.bytestring;
// (--ropes: the runtime's +, which coerces as + does when a side is unknown, and makes a
// rope rather than a copy; the builtins take their arguments flat)
const concatStrings = (scope, left, right, leftType, rightType) => {
  if (Prefs.ropes) {
    const jv = (v, ty) => v[N_TYPE] === T.jsval ? v : ty != null ? Box(v, Const(T.i32, ty)) : valNumber(v);
    // a side not known to be a string is ToString'd as the builtin does (a user toString
    // runs), unless it is one at run time: then it is kept as it is, a rope unflattened
    const str = (v, ty) => {
      if (knownStr(ty)) return reuse(scope, jv(v, ty));
      const out = tmp(scope, T.jsval, jv(v, ty));
      const t = reuse(scope, JvType(out));
      emitIf(scope, Bin('&&', T.i32, Bin('!=', T.i32, t, Const(T.i32, TYPES.string)), Bin('!=', T.i32, t, Const(T.i32, TYPES.bytestring))),
        () => assign(scope, out, builtinCall(scope, '__ecma262_ToString', [ out ])));
      return out;
    };
    const l = str(left, leftType);
    return Add(l, str(right, rightType));
  }
  return builtinCall(scope, knownStr(leftType) && knownStr(rightType) ? '__Porffor_strcat' : '__Porffor_concatStrings', [ reuse(scope, left), reuse(scope, right) ]);
};

// truthiness as i32. JvTruthy is the shared runtime helper, statically-known
// types collapse to the cheap path. `type` = inferred porffor type (TYPES|null)
const truthy = (scope, node, type = null) => {
  const t = node[N_TYPE];
  if (t === T.f64) {
    const d = reuse(scope, node);
    return Bin('&', T.i32, Bin('!=', T.f64, d, Const(T.f64, 0)), Bin('==', T.f64, d, d));
  }
  if (t === T.i32 || t === T.u32 || t === T.ptr) return Bin('!=', t, node, Const(t, 0));

  if (type === TYPES.number) {
    const d = reuse(scope, numValue(node));
    return Bin('&', T.i32, Bin('!=', T.f64, d, Const(T.f64, 0)), Bin('==', T.f64, d, d));
  }
  if (type === TYPES.string || type === TYPES.bytestring)
    return Bin('!=', T.i32, LenGet(JvPtr(node)), Const(T.i32, 0));
  if (type === TYPES.undefined) return Const(T.i32, 0);

  return JvTruthy(node);
};

const falsy = (scope, node, type = null) => {
  const t = node[N_TYPE];
  if (t === T.f64 || t === T.i32 || t === T.u32 || t === T.ptr || type === TYPES.number || type === TYPES.string || type === TYPES.bytestring || type === TYPES.undefined)
    return Un('!', T.i32, truthy(scope, node, type));

  return JvFalsy(node);
};

// 1 if null/undefined: both are singletons with fixed bit patterns, so a plain bit compare
const nullish = (scope, node, type = null) => {
  if (type === TYPES.undefined) return Const(T.i32, 1);
  if (type === TYPES.object) return Bin('==', T.jsval, node, valNull());
  if (type != null) return Const(T.i32, 0);
  return JvNullish(node);
};

// ToUint32 for bitwise operands: trunc, then wrap into [0, 2^32)
const toUint32 = (scope, d) => Call('porf_to_u32', [ d ], T.u32);

// bitwise on f64s: ToUint32 both, run it as i32, mask shifts, back to f64
const bitwiseOp = (scope, op, l, r) => {
  const li = toUint32(scope, l), ri = toUint32(scope, r);
  if (op === '>>>')
    return Convert(T.f64, Bin('>>', T.u32, li, Bin('&', T.u32, ri, Const(T.u32, 31))), 0);
  const a = Convert(T.i32, li, CONVERT_RANGE_KNOWN | CONVERT_SIGNED);
  const b = Convert(T.i32, ri, CONVERT_RANGE_KNOWN | CONVERT_SIGNED);
  const shift = op === '<<' || op === '>>';
  return Convert(T.f64, Bin(op, T.i32, a, shift ? Bin('&', T.i32, b, Const(T.i32, 31)) : b), CONVERT_SIGNED);
};

// f64 op f64 for everything but +
const numericOp = (scope, op, l, r) => {
  switch (op) {
    case '-': case '*': case '/': return Bin(op, T.f64, l, r);
    case '%': return Bin('%', T.f64, reuse(scope, l), reuse(scope, r));
    case '**': return JvNum(builtinCall(scope, '__Math_pow', [ Box(l, Const(T.i32, TYPES.number)), Box(r, Const(T.i32, TYPES.number)) ]));
    default: return bitwiseOp(scope, op, l, r);
  }
};

// the C runtime's BigInt operators (porf_bigint_arith in render.js)
const BIGINT_OPS = { '+': 0, '-': 1, '*': 2, '/': 3, '%': 4, '**': 5, '&': 6, '|': 7, '^': 8, '<<': 9, '>>': 10, '>>>': 11 };
const bigintOp = (op, left, right) => Call('porf_bigint_arith', [ Const(T.i32, BIGINT_OPS[op]), left, right ], T.jsval);
const isBigint = v => Bin('==', T.i32, JvType(v), Const(T.i32, TYPES.bigint));

const rawIntOp = (op, left, right) => {
  if (rawIntType(left, right) == null) return null;
  const l = rawIntValue(T.u32, left);
  const r = rawIntValue(T.u32, right);
  if (op === '>>>') return Bin('>>', T.u32, l, Bin('&', T.u32, r, Const(T.u32, 31)));
  if (op === '<<' || op === '>>') return Bin(op, T.u32, l, Bin('&', T.u32, r, Const(T.u32, 31)));
  if (op === '*' || op === '&' || op === '|' || op === '^') return Bin(op, T.u32, l, r);
  if (op === '-') return Bin('-', T.u32, l, r);
  return null;
};

// any binary op on two values, types are inferred TYPES or null, gives a jsval
const performOp = (scope, op, left, right, leftType, rightType) => {
  const knownLeft = leftType, knownRight = rightType;
  const strict = op === '===' || op === '!==';
  const neg = op === '!=' || op === '!==';
  const eqEq = op === '==' || op === '===' || op === '!=' || op === '!==';
  const relOp = op === '<' || op === '<=' || op === '>' || op === '>=';
  const bothNum = knownLeft === TYPES.number && knownRight === TYPES.number;
  const isStr = ty => ty === TYPES.string || ty === TYPES.bytestring || ty === TYPES.stringobject;
  const boolBox = e => Box(e, Const(T.i32, TYPES.boolean));
  // unknown runtime type: full coercion path (StringToNumber/ToPrimitive)
  const numOperand = (node, ty) => isRawNum(node) || ty === TYPES.number || ty === TYPES.bigint
    ? numValue(node)
    : numValue(builtinCall(scope, '__ecma262_ToNumeric', [ node ]));

  if (eqEq) {
    let r;
    const rawInt = rawIntType(left, right);
    if (rawInt != null) r = Bin(neg ? '!=' : '==', rawInt, rawIntValue(rawInt, left), rawIntValue(rawInt, right));
    else if ((knownLeft === TYPES.number || isRawNum(left)) && (knownRight === TYPES.number || isRawNum(right))) r = Bin(neg ? '!=' : '==', T.f64, numValue(left), numValue(right));
    else {
      // the runtime's == turns a string compared with a number into one (ToNumber) and an
      // object compared with a primitive into one (hint "default"): those builtins brought
      // in unless both sides are known one kind
      // (not for == null / == undefined, which the runtime answers itself)
      const nullish = x => x[N_KIND] === K.JvConst && x[N_B] === 0 && (x[N_A] === TYPES.undefined || x[N_A] === TYPES.object);
      if (!strict && !(knownLeft != null && knownLeft === knownRight) && !(isStr(knownLeft) && isStr(knownRight)) &&
          !nullish(left) && !nullish(right)) {
        includeBuiltin(scope, '__ecma262_ToNumber');
        if ('__ecma262_ToPrimitive_Default' in builtinFuncs) includeBuiltin(scope, '__ecma262_ToPrimitive_Default');
      }
      r = Eq(strict, left, right);
      if (neg) r = Un('!', T.i32, r);
    }
    return boolBox(r);
  }

  // relational: porf_cmp gives -1/0/1, 2 = unordered/NaN so every compare is false
  if (relOp) {
    const rawInt = rawIntType(left, right);
    if (rawInt != null) return boolBox(Bin(op, rawInt, rawIntValue(rawInt, left), rawIntValue(rawInt, right)));
    if ((knownLeft === TYPES.number || isRawNum(left)) && (knownRight === TYPES.number || isRawNum(right))) return boolBox(Bin(op, T.f64, numValue(left), numValue(right)));
    // an operand that may be an object is made a primitive first (the runtime's porf_cmp
    // calls the builtin for it)
    const primitive = ty => ty === TYPES.number || ty === TYPES.bigint || ty === TYPES.boolean || ty === TYPES.undefined || isStr(ty) && ty !== TYPES.stringobject;
    if ((!primitive(knownLeft) && !isRawNum(left)) || (!primitive(knownRight) && !isRawNum(right))) {
      if ('__ecma262_ToPrimitive_Number' in builtinFuncs) includeBuiltin(scope, '__ecma262_ToPrimitive_Number');
    }
    const c = reuse(scope, Cmp(left, right));
    let r;
    if (op === '<') r = Bin('==', T.i32, c, Const(T.i32, -1));
    else if (op === '>') r = Bin('==', T.i32, c, Const(T.i32, 1));
    else if (op === '<=') r = Bin('<=', T.i32, c, Const(T.i32, 0));
    else r = Bin('|', T.i32, Bin('==', T.i32, c, Const(T.i32, 0)), Bin('==', T.i32, c, Const(T.i32, 1)));
    return boolBox(r);
  }

  // +: concat when either side is stringish, else numeric
  if (op === '+') {
    if (isStr(knownLeft) || isStr(knownRight)) return concatStrings(scope, left, right, knownLeft, knownRight);
    const rawType = rawAddType(left, right);
    if (rawType != null) return Bin('+', rawType, Convert(rawType, left, rawType === T.i32 ? CONVERT_SIGNED : 0), Convert(rawType, right, rawType === T.i32 ? CONVERT_SIGNED : 0));
    if ((knownLeft === TYPES.number || isRawNum(left)) && (knownRight === TYPES.number || isRawNum(right))) return Box(Bin('+', T.f64, numValue(left), numValue(right)), Const(T.i32, TYPES.number));
    if (bothNum) return Box(Bin('+', T.f64, numValue(left), numValue(right)), Const(T.i32, TYPES.number));
    // a side not known to be a number, a boolean or undefined may be an object: the runtime's +
    // makes it a primitive with the hint "default" first (a Date adds as a string)
    const numish = ty => ty === TYPES.number || ty === TYPES.boolean || ty === TYPES.undefined;
    // (user code: the builtins add no objects, and would grow a + inlined at each such site)
    if (knownLeft == null || knownRight == null || (!globalThis.precompile && (!numish(knownLeft) || !numish(knownRight)))) {
      if (knownLeft !== TYPES.bigint && knownRight !== TYPES.bigint && knownLeft !== TYPES.symbol && knownRight !== TYPES.symbol) {
        if ('__ecma262_ToPrimitive_Default' in builtinFuncs) includeBuiltin(scope, '__ecma262_ToPrimitive_Default');
        const l = reuse(scope, left[N_TYPE] === T.jsval ? left : valNumber(left));
        const r = reuse(scope, right[N_TYPE] === T.jsval ? right : valNumber(right));
        return Add(l, r);
      }
    }
    if (knownLeft === TYPES.bigint || knownRight === TYPES.bigint) {
      const numeric = ty => ty === TYPES.bigint || ty === TYPES.number;
      // an object may convert to either a string or a BigInt: the runtime's +
      if (numeric(knownLeft) && numeric(knownRight)) return bigintOp(op, valNumber(left), valNumber(right));
      return Add(reuse(scope, valNumber(left)), reuse(scope, valNumber(right)));
    }
    return Box(Bin('+', T.f64, numOperand(left, knownLeft), numOperand(right, knownRight)), Const(T.i32, TYPES.number));
  }

  // BigInt arithmetic is the C runtime's, which also throws for a BigInt mixed with a
  // Number. Each side is ToNumeric'd first, left then right (an object's valueOf may give
  // a BigInt), and then it is BigInt arithmetic if either is one.
  const kl = isRawNum(left) ? TYPES.number : knownLeft, kr = isRawNum(right) ? TYPES.number : knownRight;
  if (op in BIGINT_OPS && (kl === TYPES.bigint || kr === TYPES.bigint || (usesBigInt && (kl == null || kr == null)))) {
    const numericJv = (node, ty) => ty === TYPES.number || ty === TYPES.bigint
      ? valNumber(node)
      : builtinCall(scope, '__ecma262_ToNumeric', [ valNumber(node) ]);
    const l = reuse(scope, numericJv(left, kl)), r = reuse(scope, numericJv(right, kr));
    // a known BigInt side: BigInt arithmetic, or its TypeError for a Number on the other
    if (kl === TYPES.bigint || kr === TYPES.bigint) return bigintOp(op, l, r);
    const number = () => Box(numericOp(scope, op, numValue(l), numValue(r)), Const(T.i32, TYPES.number));
    const anyBig = Bin('|', T.i32, isBigint(l), isBigint(r));
    // a known Number side: a Number, or the TypeError a BigInt on the other side throws
    if (kl === TYPES.number || kr === TYPES.number) {
      emitIf(scope, anyBig, () => stmt(scope, bigintOp(op, l, r)));
      return number();
    }
    return Select(anyBig, bigintOp(op, l, r), number());
  }

  // arithmetic and bitwise: mixing BigInt with non-BigInt throws
  const lb = knownLeft === TYPES.bigint, rb = knownRight === TYPES.bigint;
  if (lb !== rb && (lb || rb)) {
    if (knownLeft != null && knownRight != null)
      internalThrow(scope, 'TypeError', 'Cannot mix BigInts and non-BigInts in numeric expressions');
    else emitIf(scope, Bin('!=', T.i32, JvType(lb ? right : left), Const(T.i32, TYPES.bigint)),
      () => internalThrow(scope, 'TypeError', 'Cannot mix BigInts and non-BigInts in numeric expressions'));
  }

  const rawInt = rawIntOp(op, left, right);
  if (rawInt) return rawInt;

  return Box(numericOp(scope, op, numOperand(left, knownLeft), numOperand(right, knownRight)), Const(T.i32, TYPES.number));
};

const knownNullish = decl => {
  if (decl.type === 'Literal' && decl.value === null) return true;
  if (decl.type === 'Identifier' && decl.name === 'undefined') return true;

  return false;
};

const generateBinaryExp = (scope, decl) => {
  if (decl.operator === 'instanceof') {
    // hack: check type for primitive objects
    const rightName = decl.right.name;
    if (rightName) {
      let checkType = TYPES[rightName.toLowerCase()];
      // not Object: every object is one, not only the object type (functions, arrays, maps)
      if (checkType != null && rightName === TYPE_NAMES[checkType] && !rightName.endsWith('Error') && checkType !== TYPES.object) {
        if (checkType === TYPES.number) checkType = TYPES.numberobject;
        else if (checkType === TYPES.boolean) checkType = TYPES.booleanobject;
        else if (checkType === TYPES.string) checkType = TYPES.stringobject;
        return Box(Bin('==', T.i32, JvType(reuse(scope, generate(scope, decl.left))), Const(T.i32, checkType)), Const(T.i32, TYPES.boolean));
      }
    }

    // each side once, left first: (o = 0, C) as the right may change what the left reads
    const leftValue = generate(scope, decl.left);
    const left = decl.right.type === 'Identifier' ? reuse(scope, leftValue) : tmp(scope, leftValue[N_TYPE], leftValue);
    const right = reuse(scope, generate(scope, decl.right));
    // a builtin's prototype by name (objectHack), else read off the right's value
    const protoNode = getObjProp(decl.right, 'prototype');
    const proto = protoNode.type === 'MemberExpression' ? generateMember(scope, protoNode, right) : generate(scope, protoNode);
    return builtinCall(scope, '__Porffor_object_instanceof', [ left, right, proto ]);
  }

  if (decl.operator === 'in' && decl.left.type === 'PrivateIdentifier' && decl.left._private) {
    const key = reuse(scope, generate(scope, decl.left));
    return builtinCall(scope, '__Porffor_object_hasPrivate', [ generate(scope, decl.right), key ]);
  }

  if (decl.operator === 'in') {
    // 'size' in set: a use of the property, as a read is: its method, or its getter (a read
    // calls that directly, so nothing else puts it on the prototype), once its type is in
    if (decl.left.type === 'Literal' && typeof decl.left.value === 'string') {
      demandMember(decl.left.value);
      for (const x of builtinPrototypeGetters.get(decl.left.value) ?? []) {
        const t = TYPES[x.split('_prototype_')[0].slice(2).toLowerCase()];
        if (t != null) whenFact([ [ 'hasType', t ] ], () => includeBuiltin(topLevelFunc, x));
      }
    }
    return generate(scope, {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__Porffor_object_in' },
      arguments: [ decl.right, decl.left ]
    });
  }

  // two strings (known, or narrowed to string types): == is ===, a content compare with no
  // conversion, pure, so an unused one goes
  if (decl.operator === '==' || decl.operator === '!=') {
    const strs = node => {
      const t = knownTypeOrSet(scope, node);
      const ts = Array.isArray(t) ? t : t == null ? null : [ t ];
      return ts != null && ts.every(x => x === TYPES.string || x === TYPES.bytestring);
    };
    if (strs(decl.left) && strs(decl.right)) return generateBinaryExp(scope, { ...decl, operator: decl.operator + '=' });
  }

  // opt: x == null|undefined -> nullish(x)
  if (decl.operator === '==' || decl.operator === '!=') {
    const other = knownNullish(decl.right) ? decl.left : knownNullish(decl.left) ? decl.right : null;
    if (other) {
      let r = nullish(scope, generate(scope, other), getNodeType(scope, other));
      if (decl.operator === '!=') r = Un('!', T.i32, r);
      return Box(r, Const(T.i32, TYPES.boolean));
    }
  }

  // opt: typeof x === 'number' -> a test of x's type tag, not a string built and compared
  const typeofTest = typeofComparison(decl);
  if (typeofTest != null && !ifIdentifierErrors(scope, typeofTest.arg)) {
    const exact = knownType(scope, getNodeType(scope, typeofTest.arg));
    const set = exact != null ? [ exact ] : typeSet(scope, typeofTest.arg);
    const value = generate(scope, typeofTest.arg);
    const types = TYPEOF_TYPES[typeofTest.name];
    // when every type it may be answers the same, any one of them stands for all
    const answers = set?.map(t => typeofTest.name === 'object' ? !TYPEOF_LISTED.includes(t) : types?.includes(t) === true);
    const known = answers?.every(x => x === answers[0]) ? set[0] : null;
    let test;
    if (known != null) {
      exprStmt(scope, value);
      const is = typeofTest.name === 'object' ? !TYPEOF_LISTED.includes(known) : types?.includes(known) === true;
      test = Const(T.i32, is ? 1 : 0);
    } else if (typeofTest.name === 'object') {
      test = Un('!', T.i32, typeIsOneOf(JvType(reuse(scope, coerceValue(value, T.jsval))), TYPEOF_LISTED));
    } else if (types != null) {
      test = typeIsOneOf(JvType(reuse(scope, coerceValue(value, T.jsval))), types);
    } else {
      // a name typeof never answers
      exprStmt(scope, value);
      test = Const(T.i32, 0);
    }
    if (typeofTest.negated) test = Un('!', T.i32, test);
    return Box(test, Const(T.i32, TYPES.boolean));
  }

  return performOp(scope, decl.operator, generate(scope, decl.left), generate(scope, decl.right), getNodeType(scope, decl.left), getNodeType(scope, decl.right));
};

const usesAnyType = types => {
  for (let i = 0; i < types.length; i++) {
    if (usedTypes.has(types[i])) return true;
  }

  return false;
};

const irBuiltinHelpers = (scope, name, def) => ({
  includeBuiltin: builtin => includeBuiltin(scope, builtin),
  typeUsed: x => typeUsed(scope, x),
  funcRefPtr: name => JvPtr(funcRef(includeBuiltin(scope, name))),
  hasBuiltin: name => name in builtinFuncs,
  makeString: str => makeString(scope, str),
  usesAnyType,
  hasFunc: name => funcIndex[name] != null,
  whenFact,
  fact: factSet,
  onFinalize,
  remapData: id => {
    if (!def.data || !Object.hasOwn(def.data, id)) throw new Error(`${name}: missing precompiled data segment ${id}`);
    // the one-character strings are shared, never written: one table, not one per builtin
    if (isOneCharStrings(def.data[id])) return oneCharStringsSeg();
    return dataSeg('builtins', `builtin:${name}:${id}`, def.data[id]);
  },
  remapAllocSite: id => id,
  global: (name, type, init) => {
    if (!(name in globals)) {
      const idx = globals['#ind']++;
      globals[name] = { idx, type };
    }
    if (init !== undefined && !includedBuiltinGlobalInits.has(name)) {
      includedBuiltinGlobalInits.add(name);
      builtinGlobalInits.push(Assign(Global(name, type), init));
    }
    return Global(name, type);
  },
  // top-level user bindings are own props of the global object: fill `sync` (inside
  // #get_globalThis) with add-or-update writes reading current binding values, deferred
  // until all globals exist. rerun-safe (the finalizer fixpoint runs every finalizer each pass)
  globalThisUserSync: (objJv, sync) => {
    const finalizer = () => {
      sync.length = 0;
      const seen = new Set();
      const push = (key, value) => {
        seen.add(key);
        sync.push(builtinCall(scope, '__Porffor_object_set', [ objJv, makeString(scope, key), value ]));
      };

      for (const name in topLevelFunc?.namedFuncBindings ?? {}) {
        if (name[0] === '#' || seen.has(name)) continue;
        const func = topLevelFunc.namedFuncBindings[name];
        if (!func || func.internal) continue;
        // a function whose name is also a variable (written: f = …, globalThis.f = …) is
        // the variable's current value, which the loop below reads
        if (globals[name]?.metadata?.kind === 'var') continue;
        push(name, funcRef(func));
      }

      for (const name in globals) {
        if (name[0] === '#' || seen.has(name) || globals[name].metadata?.kind !== 'var') continue;
        const type = globals[name].type ?? T.jsval;
        push(name, type === T.jsval ? Global(name, T.jsval) : valNumber(Global(name, type)));
      }
    };

    onFinalize(finalizer);
  }
});

const includeIRBuiltinCallDeps = (scope, node) => {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length === 6 && node[N_KIND] === K.Call && typeof node[N_A] === 'string' && node[N_A] in builtinFuncs) {
      includeBuiltin(scope, node[N_A]);
    }

    for (const x of node) includeIRBuiltinCallDeps(scope, x);
    return;
  }

  for (const x of Object.values(node)) includeIRBuiltinCallDeps(scope, x);
};

const materializeIRBuiltin = (func, name, def) => {
  const params = (def.params ?? []).map(p => Array.isArray(p) ? { name: p[0], type: p[1] } : { name: p.name, type: p.type });
  func.params = params;
  func.retType = def.retType ?? T.jsval;
  func.returnType = def.returnType;
  func.returnTypes = def.returnTypes;
  func.constr = !!def.constr;
  // an async or generator builtin is a coroutine of its own (called, it starts one)
  if (def.async) func.async = true;
  if (def.generator) func.generator = true;
  if (def.hasAwait) func.hasAwait = true;
  func.locals = Object.create(null);
  for (const p of func.params) func.locals[p.name] = { type: p.type, metadata: { param: true } };
  if (def.localTypes) {
    for (let i = 0; i < def.localTypes.length; i++) {
      const localName = def.localNames?.[i] ?? `l${i}`;
      if (!(localName in func.locals)) func.locals[localName] = { type: def.localTypes[i] };
    }
  }
  if (def.localMetadata) {
    for (let i = 0; i < def.localMetadata.length; i += 2) {
      const localName = def.localNames?.[def.localMetadata[i]] ?? `l${def.localMetadata[i]}`;
      func.locals[localName] ??= { type: def.localTypes?.[def.localMetadata[i]] ?? T.jsval };
      func.locals[localName].metadata = { type: def.localMetadata[i + 1] };
    }
  }
  func.jsLength = def.jsLength ?? func.params.filter(p => p.name[0] !== '#').length;

  const helpers = irBuiltinHelpers(func, name, def);
  const bodyFn = typeof def.body === 'function' ? def.body : null;
  func.body = globalThis.precompile ? [] : bodyFn ? bodyFn(helpers) : def.body;
  if (!globalThis.precompile && def.globalInits) {
    for (const initName in def.globalInits) {
      if (includedBuiltinGlobalInits.has(initName)) continue;
      includedBuiltinGlobalInits.add(initName);
      const initFn = def.globalInits[initName];
      const init = initFn(helpers);
      builtinGlobalInits.push(init);
      if (!initFn.precompiled) includeIRBuiltinCallDeps(func, init);
    }
  }
  if (!bodyFn?.precompiled) includeIRBuiltinCallDeps(func, func.body);
  if (func.returnTypes) {
    for (const x of func.returnTypes) typeUsed(func, x);
  } else if (func.returnType != null) {
    typeUsed(func, func.returnType);
  }
  return func;
};

const irBuiltin = (name, def) => {
  const func = {
    internal: true,
    name,
    index: currentFuncIndex++,
    params: [],
    constr: false,
    locals: Object.create(null)
  };

  funcs.push(func);
  funcsByIndex[func.index] = func;
  setFuncIndex(name, func.index);
  return materializeIRBuiltin(func, name, def);
};

const asmFunc = (name, func) => {
  const existing = builtinFuncByName(name);
  if (existing) {
    if (!existing.body && existing.generate) existing.generate();
    return existing;
  }

  if (func.body) return irBuiltin(name, func);

  throw new Error(`${name} has no IR built-in`);
};

const includeBuiltin = (scope, builtin) => {
  scope.includes ??= new Set();
  scope.includes.add(builtin);

  return asmFunc(builtin, builtinFuncs[builtin]);
};
const builtinCall = (scope, name, args, retType) => {
  const f = name in builtinFuncs ? includeBuiltin(scope, name) : null;
  if (!f) return Call(name, args, retType ?? T.jsval);

  return Call(f.index, args.map((arg, i) => coerceValue(arg, f.params[i]?.type ?? T.jsval)), retType ?? f.retType ?? T.jsval);
};

const assignmentOp = op => op.slice(0, -1) || '=';
const logicalChecks = { '||': falsy, '&&': truthy, '??': nullish };

// short-circuit && / || / ??: right is generated lazily inside the branch
const generateLogicExp = (scope, decl) => {
  const check = logicalChecks[decl.operator];
  const res = tmp(scope, T.jsval, coerceValue(generate(scope, decl.left), T.jsval));
  // the right runs only where the left was truthy (&&) or falsy (||): what that proves holds
  const facts = decl.operator === '??' ? [] : guardFacts(scope, decl.left, decl.operator === '&&');
  emitIf(scope, check(scope, res, getNodeType(scope, decl.left)), () => {
    if (facts.length === 0) return assign(scope, res, coerceValue(generate(scope, decl.right), T.jsval));
    inferBranchStart(scope);
    narrow(scope, facts);
    assign(scope, res, coerceValue(generate(scope, decl.right), T.jsval));
    inferBranchEnd(scope);
  });
  return res;
};

const getInferred = (scope, name, global = false) => {
  const isConst = getVarMetadata(scope, name, global)?.kind === 'const';
  if (global) {
    // in a loop, only a global nothing ever reassigns keeps the type its declaration gave it
    if (name in globalInfer && (isConst || inferLoopPrev.length === 0 || !programWrittenNames.has(name))) return globalInfer[name];
  } else if (scope.inferTree) {
    for (let i = scope.inferTree.length - 1; i >= 0; i--) {
      const x = scope.inferTree[i];
      if (name in x) return x[name];
    }
  }

  return null;
};

const setInferred = (scope, name, type, global = false) => {
  const isConst = getVarMetadata(scope, name, global)?.kind === 'const';
  scope.inferTree ??= [ Object.create(null) ];

  if (global) {
    // set inferred type in global if not already and not in a loop, else make it null
    globalInfer[name] = name in globalInfer || (!isConst && inferLoopPrev.length > 0) ? null : type;
  } else {
    for (const assigned of inferLoopAssigned) assigned.add(name);
    for (const assigned of inferBranchAssigned) assigned.add(name);

    const top = scope.inferTree.at(-1);
    top[name] = type;

    // invalidate inferred type above if mismatched
    for (let i = scope.inferTree.length - 2; i >= 0; i--) {
      const x = scope.inferTree[i];
      if (name in x && x[name] !== type) x[name] = null;
    }
  }
};

const getType = (scope, name) => {
  if (name in builtinVars) return builtinVars[name].type ?? TYPES.number;

  let metadata, global = false, bound = false;
  if (name in scope.locals) {
    bound = true;
    if (scope.locals[name].type === T.f64) return TYPES.number;
    metadata = scope.locals[name].metadata;
  } else if (name in globals) {
    bound = true;
    if (globals[name].type === T.f64) return TYPES.number;
    metadata = globals[name].metadata; global = true;
  }

  if (name === 'arguments' && !scope.arrow) return TYPES.array;
  if (metadata?.type != null) return metadata.type;

  const inferred = getInferred(scope, name, global);
  if (inferred != null) return inferred;

  if (!bound && hasFuncWithName(name)) return TYPES.function;
  return null;
};

// record the compile-time inference on assignment (the runtime type travels with the jsval)
const setType = (scope, name, type, noInfer = false) => {
  const known = knownType(scope, type);
  typeUsed(scope, known);

  let metadata, global = false;
  if (name in scope.locals) metadata = scope.locals[name].metadata;
  else if (name in globals) { metadata = globals[name].metadata; global = true; }

  if (metadata?.type != null) return; // annotated type is fixed
  if (!noInfer) setInferred(scope, name, known, global);
};

const getNodeType = (scope, node) => {
  if (node._type != null) return knownType(scope, node._type);

  let ret = null;
  if (node.type === 'TSAsExpression') ret = extractTypeAnnotation(node).type;
  else if (node.type === 'Literal') {
    if (node.bigint != null) ret = TYPES.bigint;
    else if (node.regex) ret = TYPES.regexp;
    else if (typeof node.value === 'string' && byteStringable(node.value)) ret = TYPES.bytestring;
    else ret = TYPES[typeof node.value] ?? null;
  }
  else if (isFuncType(node.type)) ret = node.type.endsWith('Declaration') ? TYPES.undefined : TYPES.function;
  else if (node.type === 'Identifier') {
    if (node._closureFunc && !(node.name in scope.locals))
      return getNodeType(scope, closureEnvNode(scope, node.name, node._closureFunc));
    if (!node._skipClosureOwnLocals && scope.closureOwnLocals?.[node.name] && !closureOwnLocalReadIsLocal(scope, node.name))
      return getNodeType(scope, closureEnvNode(scope, node.name, scope.ast));
    ret = getType(scope, node.name);
  }
  else if (node.type === 'ObjectExpression' || node.type === 'Super') ret = TYPES.object;
  else if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    let name = node.callee.name;
    if (node.type === 'NewExpression' && (name == null || !builtinShadowed(scope, name))) {
      if (name === 'Number') ret = TYPES.numberobject;
      else if (name === 'Boolean') ret = TYPES.booleanobject;
      else if (name === 'String') ret = TYPES.stringobject;
      else { const tn = name?.toLowerCase(); if (tn != null && TYPES[tn] != null) ret = TYPES[tn]; }
    }
    if (ret == null) {
      // `x.call(...)` -> type of x
      if (name == null && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'call') name = node.callee.object.name;
      if (name != null) {
        // (a name several functions share resolves to none: taking any one of them, by
        // funcByName, typed a call by another function's return)
        const func = resolveNamedFunction(scope, name);
        if (node.type === 'CallExpression' && (func?.generator || func?.async)) ret = func.async
          ? (func.generator ? TYPES.__porffor_asyncgenerator : TYPES.promise)
          : TYPES.__porffor_generator;
        else if (func?.returnType != null) ret = func.returnType;
        else if (name in builtinFuncs && builtinFuncs[name].returnType != null && !builtinShadowed(scope, name)) ret = builtinFuncs[name].returnType;
      }
    }
  }
  else if (node.type === 'ExpressionStatement') ret = getNodeType(scope, node.expression);
  else if (node.type === 'AssignmentExpression') {
    const op = assignmentOp(node.operator);
    ret = op === '='
      ? getNodeType(scope, node.right)
      : getNodeType(scope, { type: logicalChecks[op] ? 'LogicalExpression' : 'BinaryExpression', left: node.left, right: node.right, operator: op });
  }
  else if (node.type === 'ArrayExpression') ret = TYPES.array;
  else if (node.type === 'BinaryExpression') {
    if (['==', '===', '!=', '!==', '>', '>=', '<', '<=', 'instanceof', 'in'].includes(node.operator)) ret = TYPES.boolean;
    else {
      const stack = [ node ];
      let anyBigint = false, anyNumber = false, anyKnown = false, anyUnknown = false, anyStringLike = false, anyString = false, allBytes = true;
      while (stack.length !== 0) {
        const n = stack.pop();
        if (n.type === 'BinaryExpression' && n.operator === node.operator) {
          stack.push(n.right, n.left);
          continue;
        }

        const known = getNodeType(scope, n);
        if (known === TYPES.bigint) anyBigint = true;
        if (known === TYPES.number) anyNumber = true;
        if (known != null) anyKnown = true;
        else anyUnknown = true;
        if (known === TYPES.string || known === TYPES.bytestring || known === TYPES.stringobject) anyStringLike = true;
        if (known === TYPES.string || known === TYPES.stringobject) anyString = true;
        if (known !== TYPES.bytestring) allBytes = false;
      }

      // a template's pieces are always a string: so each substitution is ToString'd (hint
      // "string") by the + that adds it, as a template does, not made a primitive as + would
      if (node._template) ret = TYPES.string;
      else if (anyBigint && node.operator !== '+') ret = TYPES.bigint;
      else if (anyBigint) ret = anyStringLike || anyUnknown ? null : TYPES.bigint;
      // an operand of unknown type may be a BigInt, unless a Number is in it too (a BigInt
      // would throw), or it is >>> (never a BigInt)
      else if (usesBigInt && anyUnknown && !anyNumber && node.operator !== '>>>') ret = null;
      else if (node.operator !== '+') ret = TYPES.number;
      else if (anyKnown && !anyStringLike) ret = TYPES.number;
      else if (anyString) ret = TYPES.string;
      else if (allBytes) ret = TYPES.bytestring;
      else ret = null; // string or number, only known at runtime
    }
  }
  else if (node.type === 'UnaryExpression') {
    if (node.operator === '!') ret = TYPES.boolean;
    else if (node.operator === 'void') ret = TYPES.undefined;
    else if (node.operator === 'delete') ret = TYPES.boolean;
    else if (node.operator === 'typeof') ret = TYPES.bytestring;
    else if (node.operator === '+') ret = TYPES.number;
    else {
      const arg = getNodeType(scope, node.argument);
      ret = arg === TYPES.bigint ? TYPES.bigint : usesBigInt && arg == null ? null : TYPES.number;
    }
  }
  else if (node.type === 'UpdateExpression') {
    const arg = getNodeType(scope, node.argument);
    ret = arg === TYPES.bigint ? TYPES.bigint : usesBigInt && arg !== TYPES.number ? null : TYPES.number;
  }
  else if (node.type === 'MemberExpression') {
    // o[length] reads the variable length's value as the key, not .length
    const name = node.computed ? null : node.property.name;
    if (name === 'length' && (hasFuncWithName(node.object.name) || Prefs.fastLength)) ret = TYPES.number;
    else {
      const objType = getNodeType(scope, node.object);
      if (objType != null) {
        // (s[i] is a string within the length, undefined past it: known only where the
        // index is, markInBoundsIndexes)
        if (name === 'length' && (objType & TYPE_FLAGS.length) !== 0) ret = TYPES.number;
        else if (node.computed && node._inBounds && (objType === TYPES.string || objType === TYPES.bytestring)) ret = objType;
      }
    }
  }
  else if (node.type === 'TemplateLiteral') ret = TYPES.bytestring;
  else if (node.type === 'TaggedTemplateExpression') {
    switch (node.tag.name) {
      case '__Porffor_bs': ret = TYPES.bytestring; break;
      case '__Porffor_s': ret = TYPES.string; break;
      default: ret = getNodeType(scope, { type: 'CallExpression', callee: node.tag, arguments: [] });
    }
  }
  else if (node.type === 'ThisExpression') {
    if (node._closureThisFunc) return getNodeType(scope, closureEnvNode(scope, '#this', node._closureThisFunc));
    if (scope.overrideThisType) ret = scope.overrideThisType;
    else if (scope.ast?.type === 'Program' && scope.strict) ret = TYPES.undefined;
    else if (!scope.constr && !scope.method) ret = getType(scope, 'globalThis');
    else ret = null; // runtime `this` type
  }
  else if (node.type === 'MetaProperty')
    ret = scope.constr && node.meta.name === 'new' && node.property.name === 'target' ? null : TYPES.undefined;
  else if (node.type === 'SequenceExpression') ret = getNodeType(scope, node.expressions.at(-1));
  else if (node.type === 'ChainExpression') ret = getNodeType(scope, node.expression);
  else if (node.type === 'BlockStatement') ret = getNodeType(scope, getLastNode(node.body));
  else if (node.type === 'LabeledStatement') ret = getNodeType(scope, node.body);
  else if (node.type === 'PrivateIdentifier') ret = getNodeType(scope, { type: 'Literal', value: privateIDName(node.name) });
  else if (node.type.endsWith('Statement') || node.type.endsWith('Declaration')) ret = TYPES.undefined;

  if (!node._doNotMarkTypeUsed) typeUsed(scope, ret);
  return ret;
};

const generateLiteral = (scope, decl) => {
  if (decl.bigint != null) {
    // todo/opt: parse and inline small BigInt literals instead of constructing them at runtime
    return builtinCall(scope, '__Porffor_bigint_fromLiteral', [ makeString(scope, decl.bigint) ]);
  }

  if (decl.value === null) return valNull();

  switch (typeof decl.value) {
    case 'number':
      return valNum(decl.value);

    case 'boolean':
      return valBool(decl.value);

    case 'string':
      return makeString(scope, decl.value);
  }

  if (decl.regex) {
    // compiled now when it can be (regexAot): the blob is data, and the program carries no
    // regex parser or emitter unless something compiles a pattern at run time
    const aot = regexAot(decl.regex.pattern, decl.regex.flags);
    if (aot) {
      const [ bytes, caps, names, flags ] = aot;
      const seg = dataSeg(unitOf(scope), `#regex:${decl.regex.flags}:${decl.regex.pattern}`, Array.from(bytes));
      return builtinCall(scope, '__Porffor_regex_fromBlob', [
        generate(scope, { type: 'Literal', value: decl.regex.pattern }),
        Const(T.i32, flags),
        Const(T.i32, caps),
        DataRef(seg),
        names == null ? valUndefined() : generate(scope, { type: 'ArrayExpression', elements: Array.from(names).map(value => ({ type: 'Literal', value })) })
      ]);
    }

    // literals use the intrinsic constructor, not the mutable global RegExp binding
    return builtinCall(scope, '__Porffor_regex_compile', [
      generate(scope, { type: 'Literal', value: decl.regex.pattern }),
      generate(scope, { type: 'Literal', value: decl.regex.flags })
    ]);
  }
};

// A regex literal compiled at compile time, by the regex compiler itself: [blob bytes, caps,
// names, flags], or null to compile it at run time as before. Only the selfhosted compiler (a
// Porffor program, so the __Porffor_regex_aot builtin is in it) can; under Node there is no
// such function. Patterns needing tables that compiler binary may not carry (Unicode
// properties, string sets, v mode) and programs whose flags change what the compiler emits
// stay at run time, so a blob is always the one the program would have built
const regexAot = (pattern, flags) => {
  if (globalThis.precompile || typeof __Porffor_regex_aot !== 'function') return null;
  if (regexStrings || regexScripts || regexEmoji) return null;
  if (/\\[pPq]/.test(pattern) || flags.includes('v')) return null;
  try {
    return __Porffor_regex_aot(pattern, flags);
  } catch {
    // an invalid pattern: the run-time compile throws its SyntaxError as before
    return null;
  }
};

const generateExp = (scope, decl) => {
  if (decl.directive === 'use strict') {
    scope.strict = true;
    return valUndefined();
  }

  return generate(scope, decl.expression, undefined, !scope.inEval);
};

const generateSequence = (scope, decl) => {
  const exprs = decl.expressions;
  for (let i = 0; i < exprs.length - 1; i++) exprStmt(scope, generate(scope, exprs[i]));
  return generate(scope, exprs[exprs.length - 1]);
};

const generateChain = (scope, decl) => {
  const expression = decl.expression.type === 'CallExpression' && decl.expression.callee?.optional ?
    { ...decl.expression, optional: true } :
    decl.expression;

  const label = fresh(scope);
  const res = tmp(scope, T.jsval);
  const prevLabel = scope.chainLabel, prevRes = scope.chainRes;
  scope.chainLabel = label;
  scope.chainRes = res;

  const body = collect(scope, () => assign(scope, res, generate(scope, expression)));

  scope.chainLabel = prevLabel;
  scope.chainRes = prevRes;

  stmt(scope, BlockStmt(body, label));
  return res;
};

const getObjProp = (obj, prop) => objectHack(memberNode(
  identNode(obj), identNode(prop), false, { optional: false }
));

const setObjProp = (obj, prop, value) => objectHack({
  type: 'AssignmentExpression',
  operator: '=',
  left: memberNode(identNode(obj), identNode(prop), false, { optional: false }),
  right: value
});

const aliasPrimObjsBC = bc => {
  const add = (x, y) => {
    if (bc[x] == null) return;

    // intentionally duplicate to avoid extra bc for prim objs as rarely used
    bc[y] = bc[x];
  };

  add(TYPES.boolean, TYPES.booleanobject);
  add(TYPES.number, TYPES.numberobject);
  add(TYPES.string, TYPES.stringobject);
};

const typeIsIterable = t => Bin('|', T.i32,
  typeIsOneOf(t, [ TYPES.array, TYPES.set, TYPES.map, TYPES.string, TYPES.bytestring, TYPES.__porffor_generator ]),
  Bin('&', T.i32,
    Bin('>=', T.i32, t, Const(T.i32, TYPES.uint8clampedarray)),
    Bin('<=', T.i32, t, Const(T.i32, TYPES.float64array))));
const typeIsAsyncIterable = t => Bin('==', T.i32, t, Const(T.i32, TYPES.__porffor_asyncgenerator));

const coroReturnSignal = () => JvConst(TYPES.__porffor_generator, 0);

const getKnownThisSlots = node => {
  const slots = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'AssignmentExpression' &&
        node.left?.type === 'MemberExpression' &&
        node.left.object?.type === 'ThisExpression' &&
        !node.left.computed && node.left.property?.type === 'Identifier') {
      slots.add(node.left.property.name);
      return;
    }

    if (isFuncType(node.type)) {
      return;
    }

    for (const key in node) {
      if (key[0] === '_') continue;

      const value = node[key];
      if (value == null || typeof value !== 'object') continue;

      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        continue;
      }

      if (value.type) {
        walk(value);
      }
    }
  };

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    for (const x of node.body.body) {
      if (x.type === 'PropertyDefinition' && !x.static && x.key?.type === 'Identifier') {
        slots.add(x.key.name);
      }

      if (x.kind === 'constructor' && x.value?.body) walk(x.value.body);
    }
  } else if (isFuncType(node.type)) {
    walk(node.body);
  }

  return slots;
};

const createThisArg = (scope, decl) => {
  const name = decl.callee?.name;
  if (decl._new) {
    if (!decl._forceCreateThis && globalThis.precompile) return valNull();

    // a builtin constructor creates its own `this` -> null, unless a user binding
    // shadows it (then it's a plain constructor needing a real `this`)
    if (!decl._forceCreateThis && name in builtinFuncs && !builtinShadowed(scope, name)) return valNull();

    // a fresh object whose prototype is callee.prototype
    const knownSlots = name ? resolveNamedFunction(scope, name)?.knownThisSlots?.size : null;
    let knownSlotCount = knownSlots == null ? 4 : Math.max(knownSlots, 2);
    if (knownSlotCount > 4) {
      let capacity = 8;
      while (capacity < knownSlotCount) capacity *= 2;
      knownSlotCount = capacity;
    }

    const obj = reuse(scope, builtinCall(scope, '__Porffor_object_new', [ Const(T.i32, knownSlotCount) ]));
    // a top-level class's prototype, kept when it was defined; read from the class until
    // then (a new before the class is defined fails as it would)
    const target = decl.callee?.type === 'Identifier' ? decl.callee._resolvedVariable?.node : null;
    const protoGlobal = (target?._classDeclaration ?? target)?._protoGlobal;
    if (protoGlobal) {
      allocVar(scope, protoGlobal, true);
      const proto = reuse(scope, Global(protoGlobal, T.jsval));
      emitIf(scope, Bin('==', T.i32, JvType(proto), Const(T.i32, TYPES.undefined)),
        () => exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrototype', [ obj, generate(scope, getObjProp(decl.callee, 'prototype')) ])),
        // the prototype (an object) written straight into the new object's header, as
        // setPrototype writes it; a new object is no one's prototype, so nothing is watched
        () => {
          const ptr = reuse(scope, JvPtr(obj));
          stmt(scope, Store('i32', ptr, 8, Convert(T.i32, JvPtr(proto))));
          stmt(scope, Store('u8', ptr, 5, JvType(proto)));
          stmt(scope, GcBarrier(ptr, Const(T.i32, TYPES.object)));
        });
      return obj;
    }
    exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrototype', [ obj, generate(scope, getObjProp(decl.callee, 'prototype')) ]));
    return obj;
  }

  // primitive receivers of builtin prototype methods get boxed (ToObject)
  if (name && name.startsWith('__')) {
    const obj = name.slice(2, name.indexOf('_', 2));
    if (name.includes('_prototype_') && ['Object', 'String', 'Boolean', 'Number'].includes(obj)) {
      return generate(scope, { type: 'NewExpression', callee: { type: 'Identifier', name: obj }, arguments: [] });
    }

    const node = { type: 'Identifier', name: obj };
    if (!ifIdentifierErrors(scope, node)) return generate(scope, node);
  }

  // undefined here, the callee's generateThis lazily falls back to globalThis
  return valUndefined();
};

const isEmptyNode = x => x && (x.type === 'EmptyStatement' || (x.type === 'BlockStatement' && x.body.length === 0));
const getLastNode = body => {
  let offset = 1, node = body[body.length - offset];
  while (isEmptyNode(node)) node = body[body.length - ++offset];

  return node ?? { type: 'EmptyStatement' };
};

const makeArrayFromValues = (scope, values) => {
  const capacity = Math.max(values.length, 2);
  const pointer = reuse(scope, ArrAlloc(Const(T.i32, capacity)));
  const allocated = freshMark(scope);
  for (let i = 0; i < values.length; i++) stmt(scope, ArrSet(pointer, Const(T.u32, i), values[i]));
  stmt(scope, LenSet(pointer, Const(T.i32, values.length)));
  if (values.some(v => v[N_TYPE] === T.jsval || v[N_TYPE] === T.ptr) && !stillFresh(scope, allocated))
    stmt(scope, GcBarrier(pointer, Const(T.i32, TYPES.array)));
  typeUsed(scope, TYPES.array);
  return valOf(pointer, TYPES.array);
};

// positional args for a direct call: walk the callee's params, filling hidden params
// (#callee/#env/#newtarget/#this/#allargs/#rest) and the already-evaluated user args
const buildDirectArgs = (scope, decl, func, userArgs, newTargetVal, thisVal, envVal = null) => {
  const out = [];
  let ui = 0;
  for (const p of func.params) {
    switch (p.name) {
      case '#callee': out.push(materializeFunctionValue(scope, func, false)); break;
      case '#env': out.push(JvPtr(envVal ?? closureEnvFor(scope, func))); break;
      case '#newtarget': out.push(newTargetVal ?? valUndefined()); break;
      case '#this': out.push(coerceValue(thisVal ?? createThisArg(scope, decl), p.type)); break;
      case '#allargs': out.push(makeArrayFromValues(scope, userArgs)); break;
      case '#rest': out.push(makeArrayFromValues(scope, userArgs.slice(ui))); break;
      default: {
        const arg = userArgs[ui++] ?? valUndefined();
        out.push(coerceValue(arg, p.type));
      }
    }
  }
  return out;
};

// runtime check: can this jsval hold a GC reference? (not undefined/number/boolean or their objects)
const canReferenceCheck = (scope, v) => {
  const t = reuse(scope, JvType(v));
  return Bin('&&', T.i32,
    Bin('&&', T.i32,
      Bin('!=', T.i32, t, Const(T.i32, TYPES.undefined)),
      Bin('!=', T.i32, t, Const(T.i32, TYPES.number))),
    Bin('&&', T.i32,
      Bin('!=', T.i32, t, Const(T.i32, TYPES.boolean)),
      Bin('&&', T.i32,
        Bin('!=', T.i32, t, Const(T.i32, TYPES.numberobject)),
        Bin('!=', T.i32, t, Const(T.i32, TYPES.booleanobject)))));
};

const generateIRIntrinsic = (scope, op, args) => {
  const a = i => {
    const v = knownValue(scope, args[i]);
    return v !== unknownValue && typeof v === 'number' ? Const(Number.isInteger(v) ? T.i32 : T.f64, v) : generate(scope, args[i]);
  };
  const rawPtr = v => v[N_TYPE] === T.ptr || v[N_TYPE] === T.u32 || v[N_TYPE] === T.i32 ? v : JvPtr(v);
  const rawI32 = v => v[N_TYPE] === T.i32 ? v : Convert(T.i32, numValue(v), CONVERT_SIGNED);
  const rawFor = (ctype, v) => ctype === 'jsval' ? (v[N_TYPE] === T.jsval ? v : valNumber(v))
    : ctype === 'f64' || ctype === 'f32' || ctype === 'f16' ? numValue(v)
    : ctype === 'u64' || ctype === 'i64' ? (v[N_TYPE] === T.i64 || v[N_TYPE] === T.u64 ? v : Convert(T.i64, numValue(v), ctype === 'i64' ? CONVERT_SIGNED : 0))
    : Convert(T.i32, numValue(v), ctype[0] === 'i' ? CONVERT_SIGNED : 0);
  let m;
  if (m = /^(load|store)(Un)?(\w+)$/.exec(op)) {
    const ct = m[3] === 'Jv' ? 'jsval' : m[3].toLowerCase();
    const unaligned = m[2] != null;
    const off = args[1] == null ? 0 : knownValue(scope, args[1]);
    if (typeof off !== 'number') throw new Error(`Porffor.IR.${op}: offset must be a compile-time constant`);
    if (m[1] === 'load') return Load(ct, rawPtr(a(0)), off, unaligned);
    const ptr = rawPtr(a(0));
    const value = rawFor(ct, a(2));
    const out = Store(ct, ptr, off, value, unaligned);
    return out;
  }
  if (op === 'bitsToF32') return Reinterpret(T.f64, rawI32(a(0)), 'bitsToF32');
  if (op === 'f32ToBits') return Reinterpret(T.i32, numValue(a(0)), 'f32ToBits');
  if (op === 'bitsToF16') return Reinterpret(T.f64, rawI32(a(0)), 'bitsToF16');
  if (op === 'f16ToBits') return Reinterpret(T.i32, numValue(a(0)), 'f16ToBits');
  if (op === 'bitsToF64') return Reinterpret(T.f64, a(0));
  if (op === 'f64ToBits') return Reinterpret(T.u64, a(0));
  if (op === 'copy') return MemCopy(rawPtr(a(0)), rawPtr(a(1)), rawI32(a(2)));
  if (op === 'fill') return MemFill(rawPtr(a(0)), rawI32(a(1)), rawI32(a(2)));
  if (op === 'ptr')  return JvPtr(generate(scope, args[0]));
  if (op === 'gcBarrier') return GcBarrier(rawPtr(a(0)), rawI32(a(1)));
  if (op === 'gcBarrierValue') {
    const known = knownType(scope, getNodeType(scope, args[2]));
    if (known === TYPES.number || known === TYPES.boolean || known === TYPES.undefined) return null;
    const ptr = rawPtr(a(0));
    const type = rawI32(a(1));
    if (known != null) return GcBarrier(ptr, type);
    const value = a(2);
    const jv = value[N_TYPE] === T.jsval ? value : valNumber(value);
    return If(canReferenceCheck(scope, jv), [ GcBarrier(ptr, type) ]);
  }
  throw new Error(`unknown Porffor.IR.${op}`);
};

const generateMallocIntrinsic = (scope, args, typeId = 0) => {
  const bytes = args.length === 0 ? Const(T.i32, pageSize) : generate(scope, args[0]);
  return Alloc(bytes[N_TYPE] === T.i32 ? bytes : Convert(T.i32, bytes[N_TYPE] === T.jsval ? JvNum(bytes) : bytes, CONVERT_SIGNED), typeId);
};

// a string made of literals and the names in env (a parameter's value): its value, or undefined
const staticString = (node, env) => {
  if (node.type === 'Literal') return typeof node.value === 'string' || typeof node.value === 'number' ? String(node.value) : undefined;
  if (node.type === 'Identifier') return Object.hasOwn(env, node.name) && env[node.name] != null ? String(env[node.name]) : undefined;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left, env);
    const right = left === undefined ? undefined : staticString(node.right, env);
    return right === undefined ? undefined : left + right;
  }
  if (node.type === 'TemplateLiteral') {
    let out = '';
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked;
      if (i < node.expressions.length) {
        const x = staticString(node.expressions[i], env);
        if (x === undefined) return undefined;
        out += x;
      }
    }
    return out;
  }
  return undefined;
};

// new Function(...) in a function f whose arguments depend on f's parameters, with f called
// with literals: p === 'a' ? <compiled for 'a'> : ... : new Function(...) (as it was)
const specialiseNewFunction = (scope, decl) => {
  const params = scope.ast?.params;
  if (!params?.length || !params.every(x => x.type === 'Identifier')) return null;
  const calls = semantic.literalCalls?.get(scope.ast.id?.name ?? scope.name);
  if (!calls?.length) return null;

  let out = { ...decl, _noSpecialize: true };
  const seen = new Set();
  for (const values of calls.toReversed()) {
    const env = Object.create(null);
    params.forEach((x, i) => env[x.name] = values[i]);
    const strings = decl.arguments.map(x => staticString(x, env));
    if (strings.some(x => x === undefined)) return null;

    const key = JSON.stringify(values.slice(0, params.length));
    if (seen.has(key)) continue;
    seen.add(key);

    let parsed;
    try {
      parsed = semantic(objectHack(parse(`(function(${strings.slice(0, -1).join(',')}){${strings.at(-1) ?? ''}})`)), decl._semanticScopes);
    } catch (e) {
      if (e.name === 'SyntaxError') continue;
      throw e;
    }
    parsed.body[0].expression._constructed = true;

    let test = null;
    params.forEach((x, i) => {
      const cmp = { type: 'BinaryExpression', operator: '===', left: identNode(x.name), right: { type: 'Literal', value: values[i] } };
      test = test ? { type: 'LogicalExpression', operator: '&&', left: test, right: cmp } : cmp;
    });
    out = { type: 'ConditionalExpression', test, consequent: parsed.body[0].expression, alternate: out };
  }
  return seen.size > 0 ? out : null;
};

const generateCall = (scope, decl) => {
  if (decl.type === 'NewExpression') decl._new = true;
  // the method names the program calls, for the member.<name> comptime flags (a read of
  // the property is recorded in generateMember)
  if (!globalThis.precompile && decl.callee.type === 'MemberExpression') {
    const callee = decl.callee;
    const propName = callee.computed
      ? (callee.property.type === 'Literal' && typeof callee.property.value === 'string' ? callee.property.value : null)
      : callee.property.name;
    if (propName) callMember(propName);
  }

  let name = decl.callee.name;

  // opt: virtualize IIFEs -> call the generated func by name
  let iifeEnv = null;
  if (decl.callee.type === 'FunctionExpression' || decl.callee.type === 'ArrowFunctionExpression') {
    const [ func ] = generateFunc(scope, decl.callee, true);
    name = func.name;
    if (getClosureSnapshotCaptureNames(func).length > 0) iifeEnv = closureEnvFor(scope, func);
  }

  if (name?.startsWith('__Porffor_IR_')) {
    if (Prefs.safe) throw new Error('Porffor.IR is not allowed in --safe');
    return generateIRIntrinsic(scope, name.slice(13), decl.arguments);
  }
  if (name === '__Porffor_malloc') return generateMallocIntrinsic(scope, decl.arguments, decl._porfMallocType ?? 0);

  if (name === '__Porffor_coroutine_resume' || name === '__Porffor_coroutine_value' || name === '__Porffor_coroutine_awaiting')
    return Call(name, decl.arguments.map(a => generate(scope, a)), name === '__Porffor_coroutine_value' ? T.jsval : T.i32);

  // eval('known/literal string') -> inline the parsed program
  if (!decl._funcIdx && !decl._new && (name === 'eval' || (decl.callee.type === 'SequenceExpression' && decl.callee.expressions.at(-1)?.name === 'eval'))) {
    const known = knownValue(scope, decl.arguments[0]);
    if (known !== unknownValue) {
      if (decl._evalSyntaxError) return internalThrow(scope, 'SyntaxError', decl._evalSyntaxError);
      const parsed = decl._evalParsed;
      if (!parsed) throw new Error('Known eval source missing semantic eval metadata');

      if (decl._indirectEval || decl.callee.type === 'SequenceExpression' || decl.optional) {
        // indirect eval: a separate func + scope
        const [ func ] = generateFunc({}, { type: 'ArrowFunctionExpression', body: parsed, expression: true, _noClosureEnv: true, _evalBody: true }, true);
        func.generate();
        return Call(func.index, [], func.retType);
      }

      const oldInEval = scope.inEval;
      scope.inEval = true;
      const out = generate(scope, parsed);
      scope.inEval = oldInEval;
      return out;
    }
  }

  // new Function with compile-time-known strings compiles right here
  if (!decl._funcIdx && name === 'Function') {
    const knowns = decl.arguments.map(x => knownValue(scope, x));
    if (knowns.every(x => x !== unknownValue)) {
      const code = String(knowns[knowns.length - 1]);
      const fnArgs = knowns.slice(0, -1).map(x => String(x));
      let parsed;
      try {
        parsed = semantic(objectHack(parse(`(function(${fnArgs.join(',')}){${code}})`)), decl._semanticScopes);
      } catch (e) {
        if (e.name === 'SyntaxError') return internalThrow(scope, 'SyntaxError', e.message);
        throw e;
      }
      parsed.body[0].expression._constructed = true;
      return generate(scope, parsed.body[0].expression);
    }

    // a source made of the enclosing function's parameters (new Function('return ' + x)):
    // compiled for each set of literal arguments the program calls it with, chosen by the
    // parameters' values at run time (others go on as before)
    const specialised = !decl._noSpecialize && specialiseNewFunction(scope, decl);
    if (specialised) return generate(scope, specialised);
  }

  // split __X_prototype_method into method name + target
  let protoName, target;
  if (!decl._new && name && name.startsWith('__')) {
    const spl = name.slice(2).split('_');
    protoName = spl[spl.length - 1];
    target = { ...decl.callee };
    target.name = spl.slice(0, -1).join('_');

    if (builtinFuncs['__' + target.name + '_' + protoName]) protoName = null;
    else if (lookupName(scope, target.name)[0] == null && !(target.name in builtinFuncs)) {
      if (lookupName(scope, '__' + target.name)[0] != null || builtinFuncs['__' + target.name]) target.name = '__' + target.name;
      else protoName = null;
    }
  }

  if (!decl._new && !name && (decl.callee.type === 'MemberExpression' || decl.callee.type === 'ChainExpression')) {
    const prop = (decl.callee.expression ?? decl.callee).property;
    const object = (decl.callee.expression ?? decl.callee).object;
    protoName = prop?.name;
    target = object;
  }

  // super.m() dispatches as a member call (its this is not the object super names)
  if (protoName && target && target.type !== 'Super') {
    const targetKnownType = knownType(scope, getNodeType(scope, target));

    const builtinProtoCands = builtinPrototypeFuncs.get(protoName) ?? [];
    if (!decl._protoInternalCall && builtinProtoCands.length > 0) {
      const targetVal = generate(scope, target);
      const targetTmp = reuseNamed(scope, targetVal);
      const targetIdent = { type: 'Identifier', name: targetTmp[N_A] };

      // a function written as an argument (xs.forEach(function (x) {…})) is made once, here:
      // each type's branch below generating it again would compile it once per branch, and a
      // callback nested in another's once per branch per level (6^depth copies)
      const callArgs = decl.arguments.map(arg => isFuncType(arg.type)
        ? { type: 'Identifier', name: reuseNamed(scope, generate(scope, arg))[N_A] }
        : arg);

      const protoBC = {};
      const member = decl.callee.type === 'ChainExpression' ? decl.callee.expression : decl.callee;
      const fallbackCallee = name || member.type !== 'MemberExpression' || member.object.type === 'Super' ? decl.callee
        : decl.callee.type === 'ChainExpression' ? { ...decl.callee, expression: { ...member, object: targetIdent } }
        : { ...member, object: targetIdent };
      for (const x of builtinProtoCands) {
        const tn = x.split('_prototype_')[0].toLowerCase();
        const t = TYPES[tn.slice(2)] ?? TYPES[tn];
        if (t == null) continue;
        // Object prototype methods fall back through normal lookup so own props win
        if (t === TYPES.object) {
          includeBuiltin(scope, x);
          continue;
        }
        const builtinCall = args => generate(scope, {
          type: 'CallExpression',
          optional: decl.optional,
          callee: { type: 'Identifier', name: x },
          arguments: args,
          _thisArg: targetIdent,
          _protoInternalCall: true
        });

        // str.charCodeAt(number): a load at the call site (string loops call it per
        // character), the builtin for any other index
        if (protoName === 'charCodeAt' && (t === TYPES.string || t === TYPES.bytestring) &&
            decl.arguments.length === 1 && decl.arguments[0].type !== 'SpreadElement') {
          protoBC[t] = () => {
            const val = generate(scope, decl.arguments[0]);
            // a typed number (inside builtins): nothing to check
            if (val[N_TYPE] !== T.jsval) return Call('porf_str_char_code', [ targetTmp, Convert(T.f64, val) ], T.jsval);

            const idx = reuseNamed(scope, val);
            const out = tmp(scope, T.jsval);
            emitIf(scope, JvIsNum(idx),
              () => assign(scope, out, Call('porf_str_char_code', [ targetTmp, JvNum(idx) ], T.jsval)),
              () => assign(scope, out, builtinCall([ { type: 'Identifier', name: idx[N_A] } ])));
            return out;
          };
          continue;
        }

        // a function's own bind (a class's static bind: AsyncLocalStorage.bind) is called, not
        // Function.prototype's: looked for only where the program may give one (see above)
        if (t === TYPES.function && functionOwnMethodNames.has(protoName)) {
          protoBC[t] = () => {
            const out = tmp(scope, T.jsval);
            const own = generate(scope, {
              type: 'CallExpression',
              callee: { type: 'Identifier', name: '__Object_hasOwn' },
              arguments: [ targetIdent, { type: 'Literal', value: protoName } ]
            });
            emitIf(scope, JvTruthy(reuse(scope, own)),
              () => assign(scope, out, coerceValue(generate(scope, { ...decl, callee: fallbackCallee, arguments: callArgs, _protoInternalCall: true }), T.jsval)),
              () => assign(scope, out, coerceValue(builtinCall(callArgs), T.jsval)));
            return out;
          };
          continue;
        }

        // a subclass's override of this method (see subclassOverrides): the builtin only when
        // the value's prototype is the builtin's own
        const ctorName = x.split('_prototype_')[0].slice(2);
        if (subclassOverrides.get(ctorName)?.has(protoName)) {
          protoBC[t] = () => {
            const out = tmp(scope, T.jsval);
            const proto = generate(scope, {
              type: 'CallExpression',
              callee: { type: 'Identifier', name: '__Object_getPrototypeOf' },
              arguments: [ targetIdent ]
            });
            const intrinsic = generate(scope, {
              type: 'MemberExpression', computed: false, optional: false,
              object: { type: 'Identifier', name: ctorName },
              property: { type: 'Identifier', name: 'prototype' }
            });
            const same = generate(scope, {
              type: 'BinaryExpression', operator: '===',
              left: { type: 'Identifier', name: reuseNamed(scope, proto)[N_A] },
              right: { type: 'Identifier', name: reuseNamed(scope, intrinsic)[N_A] }
            });
            emitIf(scope, JvTruthy(reuse(scope, same)),
              () => assign(scope, out, coerceValue(builtinCall(callArgs), T.jsval)),
              () => assign(scope, out, coerceValue(generate(scope, { ...decl, callee: fallbackCallee, arguments: callArgs, _protoInternalCall: true }), T.jsval)));
            return out;
          };
          continue;
        }

        protoBC[t] = () => builtinCall(callArgs);
      }

      // the fallback call reads the object through targetTmp too: regenerating decl as-is
      // would evaluate the object expression a second time (f().push(x) calling f twice)

      protoBC.default = () => Prefs.neverFallbackBuiltinProto && !decl.optional
        ? internalThrow(scope, 'TypeError', `'${protoName}' proto func tried to be called on a type without an impl`)
        : generate(scope, { ...decl, callee: fallbackCallee, arguments: callArgs, _protoInternalCall: true });

      aliasPrimObjsBC(protoBC);

      return typeSwitch(scope, JvType(targetTmp), targetKnownType ?? typeSet(scope, target), protoBC);
    }
  }

  const hasSpread = decl.arguments.some(x => x?.type === 'SpreadElement');
  let spreadArr = null;
  if (hasSpread) {
    spreadArr = generate(scope, { type: 'ArrayExpression', elements: decl.arguments, _doNotMarkTypeUsed: true });
  }
  const userArgs = hasSpread ? [] : decl.arguments;

  // super(...): invoke the parent constructor on #this, threading new.target through,
  // a marker is left so subclass field initialisers inject right after the super() call
  if (decl.callee.type === 'Super') {
    // in an arrow: the enclosing constructor's parent, this and new.target (its closure env)
    const owner = decl.callee._closureThisFunc;
    const superCtor = reuse(scope, generate(scope, owner ? {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__Porffor_object_getPrototype' },
      arguments: [ closureEnvNode(scope, '#callee', owner) ]
    } : scope.ast?._superClassExpr ?? {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__Porffor_object_getPrototype' },
      arguments: [ { type: 'Identifier', name: scope.name } ]
    }));
    const argVals = hasSpread ? [] : userArgs.map(a => reuse(scope, generate(scope, a)));
    const res = reuse(scope, CallDynamic(superCtor, generate(scope, { type: 'ThisExpression', _noGlobalThis: true, _closureThisFunc: owner }),
      argVals, owner ? generate(scope, closureEnvNode(scope, '#newtarget', owner)) : Local('#newtarget', T.jsval), spreadArr));
    // a built-in parent (Map, Array, Date, a typed array) makes an instance of its own
    // rather than filling in this: that instance is this, with the subclass's prototype.
    // Not an error: the Error constructors give a subclass's this its message instead
    // (an error's name and message getters would hide the instance's own)
    const resType = reuse(scope, JvType(res));
    if (scope.constr) emitIf(scope, Bin('&', T.i32, Bin('&', T.i32,
      Bin('!=', T.i32, resType, Const(T.i32, TYPES.object)),
      Bin('!=', T.i32, resType, Const(T.i32, TYPES.undefined))),
      Bin('>', T.u32, Bin('-', T.u32, resType, Const(T.u32, TYPES.error)), Const(T.u32, TYPES.suppressederror - TYPES.error))), () => {
      stmt(scope, builtinCall(scope, '__Porffor_object_setPrototype', [ res, generate(scope, {
        type: 'MemberExpression', computed: false, optional: false,
        object: { type: 'MetaProperty', meta: { type: 'Identifier', name: 'new' }, property: { type: 'Identifier', name: 'target' } },
        property: { type: 'Identifier', name: 'prototype' }
      }) ], T.none));
      stmt(scope, Assign(Local('#this', T.jsval), res));
      if (hasClosureOwnEnv(scope) && scope.closureOwnThis) mirrorToClosureEnv(scope, '#this', { type: 'ThisExpression', _noGlobalThis: true });
    });
    // a parent constructor returning an object of its own: that object is this (its
    // prototype as it is), the subclass's fields are added to it
    if (scope.constr) emitIf(scope, Bin('&', T.i32, Bin('==', T.i32, resType, Const(T.i32, TYPES.object)),
      Bin('!=', T.i32, JvPtr(res), JvPtr(Local('#this', T.jsval)))), () => {
      stmt(scope, Assign(Local('#this', T.jsval), res));
      if (hasClosureOwnEnv(scope) && scope.closureOwnThis) mirrorToClosureEnv(scope, '#this', { type: 'ThisExpression', _noGlobalThis: true });
    });
    if (tracksSuperCall(scope)) stmt(scope, Assign(local(scope, '#super_called', T.i32), Const(T.i32, 1)));
    stmt(scope, CLASS_FIELD_INIT_MARKER);
    return res;
  }

  // not for new: no comptime builtin is a constructor, and the normal path throws for that
  if (name && name in builtinFuncs && builtinFuncs[name].comptime && !decl._noComptime && !decl._new) {
    return builtinFuncs[name].comptime(scope, decl, { generate, getNodeType, knownType, makeString, printStaticStr, createThisArg, exprStmt });
  }

  // resolve the callee to a known user func for a direct call
  let func, directCallEnv = iifeEnv, isBuiltin = false;
  if (decl._funcIdx) func = funcByIndex(decl._funcIdx);
  else {
    const isBuiltinMember = decl.callee._builtinMember && name in builtinFuncs;
    const isLocal = decl.callee.type === 'Identifier' && !isBuiltinMember && lookupName(scope, name)[0] != null;
    const closureBacked = decl.callee.type === 'Identifier' && (decl.callee._closureFunc || scope.closureCaptures?.[name] || (!decl.callee._skipClosureOwnLocals && scope.closureOwnLocals?.[name]));
    const binding = decl.callee._resolvedVariable?.node ?? scope.closureCaptures?.[name]?.node ?? scope.closureOwnLocals?.[name]?.node;
    // a function declaration whose name is assigned somewhere is called through its binding
    const rebound = decl.callee.type === 'Identifier' && decl.callee._resolvedVariable?.node?._reassigned === true;
    if (!isBuiltinMember && !rebound && closureBacked && name && isFuncType(binding?.type) && directCallOnlyRefs(binding)) {
      func = resolveNamedFunction(scope, name);
      // per-iteration snapshot envs can't be recomputed from the caller's env
      if (getPerIterationClosureCaptureNames(func).length > 0) func = null;
      const owner = decl.callee._closureFunc ?? scope.closureCaptures?.[name]?.func;
      // a fully elided env chain leaves the caller envless; the callee then only has
      // elided captures itself, so it never reads the env
      if (func?.closureAware && owner && (hasClosureOwnEnv(scope) || scope.closureAware)) directCallEnv = generate(scope, closureEnvNode(scope, undefined, owner));
    }
    if (isBuiltinMember) {
      isBuiltin = true;
    } else if (!func && !rebound && !isLocal && !closureBacked && name) {
      // a const bound to a function expression calls that function (another function may
      // have its name)
      if (decl.callee._resolvedVariable?.kind === 'const' && !(name in globals)) func = decl.callee._resolvedVariable.node?._func;
      func ??= resolveNamedFunction(scope, name);
      if (!func && name in funcIndex) func = funcByName(name);
      if (!func && name in builtinFuncs) isBuiltin = true;
    }
    if (!func && !rebound && !isBuiltin && !isLocal && !closureBacked && scope.name === name) func = scope;
  }

  if (isBuiltin && !hasSpread) {
    const f = includeBuiltin(scope, name);
    const argv = userArgs.map(a => reuse(scope, generate(scope, a)));
    if (decl._new && f.constr === false) return internalThrow(scope, 'TypeError', `${unhackName(name)} is not a constructor`);
    const newTargetVal = decl._new ? materializeFunctionValue(scope, f, false) : null;
    return Call(f.index, buildDirectArgs(scope, decl, f, argv, newTargetVal, decl._thisArg ? reuse(scope, generate(scope, decl._thisArg)) : null), f.retType ?? T.jsval);
  }

  if (func && !hasSpread) {
    func.generate?.();
    if (func && !decl._new && !decl._insideIndirect) func.onlyNew = false;

    coroTypeUsed(func);

    // evaluate every arg left-to-right up front, before #this creation (C doesn't order
    // call args), args beyond the callee's arity still run
    const argv = userArgs.map(a => reuse(scope, generate(scope, a)));
    if (decl._new && func.constr === false) return internalThrow(scope, 'TypeError', `${unhackName(name)} is not a constructor`);
    const newTargetVal = decl._new ? materializeFunctionValue(scope, func, false) : null;
    const args = buildDirectArgs(scope, decl, func, argv, newTargetVal, decl._thisArg ? reuse(scope, generate(scope, decl._thisArg)) : null, directCallEnv);
    const call = Call(func.index, args, func.retType ?? T.jsval);
    if (func.async || func.generator) call[N_C] = argv;
    return call;
  }

  let calleeVal, thisVal = null;
  const callee = decl.callee.expression ?? decl.callee;
  if (!decl._new && callee.type === 'MemberExpression' && decl.callee.type === 'ChainExpression' && !decl.optional) {
    // (a?.b)(): the parenthesised chain short-circuits on its own (to an undefined callee,
    // which the call then throws on) and still calls with a as this: its own chain context,
    // the object generated inside it too for (a?.b.c)()
    const label = fresh(scope);
    const res = tmp(scope, T.jsval), objTmp = tmp(scope, T.jsval);
    const prevLabel = scope.chainLabel, prevRes = scope.chainRes;
    scope.chainLabel = label;
    scope.chainRes = res;
    const body = collect(scope, () => {
      assign(scope, objTmp, coerceValue(generate(scope, callee.object), T.jsval));
      assign(scope, res, coerceValue(generateMember(scope, callee, objTmp), T.jsval));
    });
    scope.chainLabel = prevLabel;
    scope.chainRes = prevRes;
    stmt(scope, BlockStmt(body, label));
    calleeVal = res;
    thisVal = objTmp;
  } else if (!decl._new && (callee.type === 'MemberExpression')) {
    const objVal = reuse(scope, generate(scope, callee.object));
    calleeVal = generateMember(scope, callee, objVal);
    // super.m(): m is looked up on the parent's prototype, and called on this, unchanged
    thisVal = callee.object.type === 'Super' ? reuse(scope, generate(scope, { type: 'ThisExpression', _noGlobalThis: true, _closureThisFunc: callee.object._closureThisFunc })) : objVal;
  } else {
    calleeVal = generate(scope, decl.callee);
    if (!decl._new) thisVal = decl._thisArg ? reuse(scope, generate(scope, decl._thisArg)) : createThisArg(scope, decl);
  }
  calleeVal = reuse(scope, calleeVal);

  if (decl.optional) {
    emitIf(scope, nullish(scope, calleeVal), () => {
      assign(scope, scope.chainRes, valUndefined());
      stmt(scope, Break(scope.chainLabel));
    });
  }

  const argVals = hasSpread ? [] : userArgs.map(a => reuse(scope, generate(scope, a)));

  if (decl._new) {
    emitIf(scope, JvFalsy(builtinCall(scope, '__ecma262_IsConstructor', [ calleeVal ])),
      () => internalThrow(scope, 'TypeError', `${Prefs.d ? exprText(callee) : 'value'} is not a constructor`));
    thisVal = decl._thisArg ? reuse(scope, generate(scope, decl._thisArg)) : createThisArg(scope, decl);
  } else if (Prefs.d) {
    emitIf(scope, Bin('!=', T.i32, JvType(calleeVal), Const(T.i32, TYPES.function)),
      () => internalThrow(scope, 'TypeError', `${exprText(callee)} is not a function`));
  }

  if (methodIndex && !decl._new && !hasSpread && !decl.optional && callee.type === 'MemberExpression' &&
      !callee.computed && callee.object.type !== 'Super' && callee.property.type === 'Identifier') {
    const devirtualized = devirtualizedCall(scope, decl, callee.property.name, calleeVal, thisVal, argVals);
    if (devirtualized) return devirtualized;
  }

  return CallDynamic(calleeVal, coerceValue(thisVal, T.jsval), argVals, decl._new ? calleeVal : null, spreadArr);
};

// ---- devirtualized method calls (--devirtualize=N) ----
// obj.m(…) reads a function and calls it through the dynamic call (porf_invoke), which clang
// can neither see through nor inline. When the program defines at most N functions as a
// method named m (class methods, F.prototype.m = function, object literal methods), the call
// checks the function it read against each, one compare of its record's function index, and
// calls the one it is directly; anything else (another object, a replaced method) takes the
// dynamic call as before. Only a guess, never assumed: a wrong one costs its compare. Only
// candidates that capture nothing and are neither async nor generators are guessed (their
// direct call needs no closure environment); a name with any other candidate is not guessed.
let methodIndex = null, devirtualizeTally = null, devirtualizeSites = [];

/** Every function the program defines as a method, by name: class and object literal methods, prototype assignments. */
const indexMethods = program => {
  const index = new Map();
  const add = (key, fn) => {
    if (key?.type !== 'Identifier') return;
    const list = index.get(key.name) ?? [];
    list.push(fn);
    index.set(key.name, list);
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (node.type === 'MethodDefinition' && !node.computed && node.kind === 'method') add(node.key, node.value);
    // any other kind of definition under the name (a getter, a setter, an arrow, a value) is
    // still a candidate the call could reach: counted, never guessed
    else if (node.type === 'MethodDefinition' && !node.computed && (node.kind === 'get' || node.kind === 'set')) add(node.key, null);
    if (node.type === 'Property' && !node.computed && node.kind === 'init' && (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression'))
      add(node.key, node.value.type === 'FunctionExpression' ? node.value : null);
    if (node.type === 'Property' && !node.computed && (node.kind === 'get' || node.kind === 'set')) add(node.key, null);
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed &&
        (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression'))
      add(node.left.property, node.right.type === 'FunctionExpression' ? node.right : null);
    for (const key in node) {
      if (key[0] === '_' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(program);
  return index;
};

/**
 * obj.m(…) as guarded direct calls, when m has at most N candidates. The call is emitted as the
 * dynamic call now, in a block of its own; once every candidate is compiled (a method's class
 * may come later in the program than a call of it: declarations are hoisted), a finalizer
 * swaps in the guards and direct calls. A candidate never compiled, or not directly callable,
 * leaves the dynamic call as it is. Null when m is not guessed at all.
 */
const devirtualizedCall = (scope, decl, name, calleeVal, thisVal, argVals) => {
  const candidates = methodIndex.get(name) ?? [];
  const count = candidates.length;
  const plural = `${count} candidate${count > 1 ? 's' : ''}`;
  if (count === 0) { tallyDevirtualize('0 candidates', name); return null; }
  if (count > +Prefs.devirtualize) { tallyDevirtualize(`${count > 4 ? '5+' : count} candidates: more than N`, name); return null; }
  if (candidates.some(fn => fn == null)) { tallyDevirtualize(`${plural}: one a getter, setter or arrow`, name); return null; }

  const res = tmp(scope, T.jsval);
  const thisV = reuse(scope, coerceValue(thisVal, T.jsval));
  const body = collect(scope, () => assign(scope, res, CallDynamic(calleeVal, thisV, argVals, null, null)));
  stmt(scope, BlockStmt(body));

  // temps live here are read by the direct calls made later: kept out of their scratch
  const pinned = scope.tmpBusy.slice();
  const site = { done: false, plural, name };
  devirtualizeSites.push(site);
  onFinalize(() => {
    if (site.done) return;
    const funcs = candidates.map(fn => fn._compiledFunc);
    if (funcs.some(f => !f)) return;
    site.done = true;
    if (funcs.some(f => f.async || f.generator || hasClosureCaptures(f) || f.params.some(p => p.name === '#env'))) {
      tallyDevirtualize(`${plural}: one not directly callable (captures, async or generator)`, name);
      return;
    }
    for (const { name: tmpName, type } of pinned) {
      const pool = scope.tmpPool[type];
      const i = pool ? pool.indexOf(tmpName) : -1;
      if (i !== -1) pool.splice(i, 1);
    }

    const dynamic = () => assign(scope, res, CallDynamic(calleeVal, thisV, argVals, null, null));
    const direct = func => {
      func.generate?.();
      func.onlyNew = false;
      coroTypeUsed(func);
      assign(scope, res, coerceValue(Call(func.index, buildDirectArgs(scope, decl, func, argVals, null, thisV), func.retType ?? T.jsval), T.jsval));
    };
    const guarded = collect(scope, () => emitIf(scope, Bin('==', T.i32, JvType(calleeVal), Const(T.i32, TYPES.function)), () => {
      const index = reuse(scope, Load('u32', JvPtr(calleeVal), 0));
      const chain = i => i === funcs.length ? dynamic()
        : emitIf(scope, Bin('==', T.i32, index, FuncIdx(funcs[i].index)), () => direct(funcs[i]), () => chain(i + 1));
      chain(0);
    }, dynamic));
    body.length = 0;
    body.push(...guarded);
    tallyDevirtualize(`${plural}: devirtualized`, name);
  });
  return res;
};

const tallyDevirtualize = (reason, name) => {
  if (!devirtualizeTally) return;
  const entry = devirtualizeTally.get(reason) ?? { count: 0, names: new Set() };
  entry.count++;
  if (name && entry.names.size < 3) entry.names.add(name);
  devirtualizeTally.set(reason, entry);
};

const generateThis = (scope, decl) => {
  // arrows read the enclosing `this` out of the closure env
  if (decl._closureThisFunc) return generate(scope, closureEnvNode(scope, '#this', decl._closureThisFunc));

  if (scope.overrideThis) return scope.overrideThis;

  // ordinary direct calls have a fixed receiver
  if (scope.directCallOnly) return scope.strict
    ? valUndefined()
    : generate(scope, { type: 'Identifier', name: 'globalThis' });

  // top-level strict module: `this` is undefined
  if (scope.ast?.type === 'Program' && scope.strict) return valUndefined();

  // a non-constructor, non-method function: `this` is globalThis
  if (!scope.constr && !scope.method) return generate(scope, { type: 'Identifier', name: 'globalThis' });

  // when `this` can't be globalThis, read #this directly
  if (
    (!globalThis.precompile && scope.strict) || // strict mode
    scope._onlyConstr || // inside func that is only constructed
    scope._noGlobalThis || // inside func known to never use globalThis
    decl._noGlobalThis // this generation known to not be globalThis
  ) return Local('#this', T.jsval);

  // once, at the function's entry: the block `this` is read in may be a temporary one whose
  // statements are copied (into both arms of a fast path) before the marker is resolved
  if (scope.thisDefaulted) return Local('#this', T.jsval);
  scope.thisDefaulted = true;
  const block = scope.body;
  const marker = Symbol('this default');
  block.unshift(marker);
  onFinalize(() => {
    const i = block.indexOf(marker);
    if (i === -1) return;
    if (scope.onlyNew !== false && !scope.referenced) return void block.splice(i, 1);
    const thisVal = Local('#this', T.jsval);
    // a primitive this is boxed (ToObject): only a program with call, apply or bind can
    // give one (a method called on a primitive is a builtin's)
    const box = [];
    if ('__ecma262_ToObject' in builtinFuncs) whenFact([ [ 'member', 'call' ], [ 'member', 'apply' ], [ 'member', 'bind' ] ], () => {
      const t = JvType(thisVal);
      box.push(If(Bin('|', T.i32, Bin('|', T.i32,
        Bin('==', T.i32, t, Const(T.i32, TYPES.number)),
        Bin('==', T.i32, t, Const(T.i32, TYPES.boolean))),
        Bin('==', T.i32, Bin('|', T.i32, t, Const(T.i32, 0b10000000)), Const(T.i32, TYPES.bytestring))),
        [ Assign(thisVal, builtinCall(scope, '__ecma262_ToObject', [ thisVal ])) ], null));
    });
    block.splice(i, 1, If(JvNullish(thisVal),
      [ Assign(thisVal, generate(scope, { type: 'Identifier', name: 'globalThis' })) ], box));
  });
  return Local('#this', T.jsval);
};

// super: the prototype of the method's [[HomeObject]] (the class's prototype, or the class
// for a static method), not of this: from a subclass's instance, this's prototype chain
// would find the calling method's own class again. Elsewhere, this's prototype's prototype
const generateSuper = (scope, decl) => generate(scope, {
  type: 'CallExpression',
  callee: { type: 'Identifier', name: '__Porffor_object_getPrototype' },
  arguments: [
    // an arrow's is its method's, which parse.js names for it
    scope.ast?._homeObject ?? (scope.ast?.homeRef && (scope.ast.homeStatic ? scope.ast.homeRef : getObjProp(scope.ast.homeRef, 'prototype'))) ?? {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__Porffor_object_getPrototype' },
      arguments: [
        { type: 'ThisExpression', _noGlobalThis: true, _closureThisFunc: decl._closureThisFunc }
      ]
    }
  ]
});

const DEFAULT_VALUE = { type: 'Identifier', name: 'undefined' };

const unhackName = name => {
  if (!name) return name;

  if (name.startsWith('__')) return name.slice(2).replaceAll('_', '.');
  return name.replace(/(?!^)#m\w+$/, '');
};

const knownType = (scope, type) => typeof type === 'number' ? type : null;

// a type is in the program: a fact (hasType)
const useType = x => {
  if (usedTypes.has(x)) return;
  usedTypes.add(x);
  factSet('hasType', x);
  // any typed array kind: what builtins handling typed arrays generically wait on
  if (!typedArraysUsed && TYPED_ARRAY_TYPES.has(x)) {
    typedArraysUsed = true;
    factSet('program', 'typedArrays');
  }
};

const typeUsed = (scope, x) => {
  if (x == null) return;
  useType(x);

  scope.usedTypes ??= new Set();
  scope.usedTypes.add(x);
};

const typeSwitch = (scope, subject, staticType, bc, fallthrough = false) => {
  const branch = x => typeof x === 'function' ? x() : x;
  const entriesOf = bc => {
    if (typeof bc === 'function') bc = bc();
    if (Array.isArray(bc)) return bc;

    return Object.keys(bc)
      .sort((a, b) => a === 'default' ? 1 : b === 'default' ? -1 : +a - +b)
      .map(k => [ k === 'default' ? 'default' : +k, bc[k] ]);
  };
  const entries = entriesOf(bc);
  const typeIdsOf = types => Array.isArray(types) ? types : [ types ];

  // one of a set: only the cases for its types, and no fallback when each has one
  if (Array.isArray(staticType)) {
    if (staticType.length === 1) staticType = staticType[0];
    else {
      const set = staticType;
      const covered = new Set(entries.flatMap(([ types ]) => types === 'default' ? [] : typeIdsOf(types)));
      const needDefault = set.some(t => !covered.has(t));
      const kept = entries.filter(([ types ]) => types === 'default' ? needDefault : typeIdsOf(types).some(t => set.includes(t)));
      return typeSwitch(scope, subject, null, kept, fallthrough);
    }
  }

  if (staticType != null) {
    let def;
    for (const [ types, v ] of entries) {
      if (types === 'default') { def = v; continue; }
      if (types === staticType || (Array.isArray(types) && types.includes(staticType))) return branch(v);
    }
    return def != null ? branch(def) : valUndefined();
  }

  const res = tmp(scope, T.jsval);
  const cases = [];
  const finalizers = [];
  let def;
  const collectAssign = (target, value) => {
    target.push(...collect(scope, () => {
      const pool = scope.tmpPool[res[N_TYPE]];
      const i = pool ? pool.indexOf(res[N_A]) : -1;
      if (i !== -1) pool.splice(i, 1);
      assign(scope, res, typeof value === 'function' ? value() : value);
    }));
  };

  const addDefault = value => {
    def = [];
    finalizers.push(() => {
      if (def.length === 0) collectAssign(def, value);
    });
  };

  const addCase = (types, value) => {
    const typeIds = typeIdsOf(types);
    const body = [];
    cases.push([ typeIds, body, fallthrough ]);
    if (!globalThis.precompile && usesAnyType(typeIds)) collectAssign(body, value);
    finalizers.push(() => {
      if (body.length === 0 && (globalThis.precompile || usesAnyType(typeIds))) collectAssign(body, value);
    });
  };

  for (const [ types, v ] of entries) {
    if (types === 'default') addDefault(v);
    else addCase(types, v);
  }

  // temps live at creation are referenced by deferred case bodies: pull them from
  // the pool so branch scratch cannot clobber them
  const pinned = scope.tmpBusy.slice();
  const chainLabel = scope.chainLabel, chainRes = scope.chainRes;
  let lastTypes = -1;
  const finalize = () => {
    if (lastTypes === usedTypes.size) return;
    lastTypes = usedTypes.size;

    const prevLabel = scope.chainLabel, prevRes = scope.chainRes;
    scope.chainLabel = chainLabel;
    scope.chainRes = chainRes;
    for (const { name, type } of pinned) {
      const pool = scope.tmpPool[type];
      const i = pool ? pool.indexOf(name) : -1;
      if (i !== -1) pool.splice(i, 1);
    }
    for (let i = 0; i < finalizers.length; i++) finalizers[i]();
    scope.chainLabel = prevLabel;
    scope.chainRes = prevRes;
  };
  if (globalThis.precompile) finalize();
  else onFinalize(finalize);

  stmt(scope, TypeSwitch(subject, cases, def));
  return res;
};

const typeIsOneOf = (type, types) =>
  types.map(t => Bin('==', T.i32, type, Const(T.i32, t))).reduce((a, b) => Bin('|', T.i32, a, b));

const allocVar = (scope, name, global = false, valType = T.jsval, redecl = false) => {
  const target = global ? globals : scope.locals;

  // already declared
  if (name in target) {
    if (redecl) {
      // a redeclaration shadows the old binding: move it aside under a unique name
      target['#redecl_' + name + uniqId(scope)] = target[name];
    } else {
      return name;
    }
  }

  target[name] = { type: valType };
  return name;
};

const getVarMetadata = (scope, name, global = false) => {
  const target = global ? globals : scope.locals;
  return target[name]?.metadata;
};

const setVarMetadata = (scope, name, global = false, metadata = {}) => {
  const target = global ? globals : scope.locals;
  target[name].metadata = metadata;
};

const addVarMetadata = (scope, name, global = false, metadata = {}) => {
  const target = global ? globals : scope.locals;

  target[name].metadata ??= {};
  for (const x in metadata) {
    if (metadata[x] != null) target[name].metadata[x] = metadata[x];
  }
};

const HOIST_DECL = 1;
// top-level let/const/class: seen by inner functions only, the body keeps its tdz (a class's
// methods are generated where it is defined, before a later top-level binding)
const HOIST_LEXICAL = 2;
const markVarHoists = (scope, body, moduleTop = false) => {
  scope.hoists ??= new Map();

  const mark = (pattern, kind = HOIST_DECL) => {
    if (!pattern) return;
    const add = name => {
      if (scope.topLevel && name in builtinVars) return;
      scope.hoists.set(name, kind);
    };
    if (typeof pattern === 'string') return void add(pattern);

    switch (pattern.type) {
      case 'Identifier': return void add(pattern.name);
      case 'AssignmentPattern': return mark(pattern.left, kind);
      case 'RestElement': return mark(pattern.argument, kind);
      case 'ArrayPattern':
        for (const x of pattern.elements) mark(x, kind);
        return;
      case 'ObjectPattern':
        for (const x of pattern.properties) mark(x.type === 'RestElement' ? x.argument : x.value, kind);
        return;
    }
  };

  const scan = (node, nested = false) => {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      case 'FunctionDeclaration':
        // Annex B.3.3: a sloppy function declared in a block is a var of this function too,
        // undefined until the block runs (semantic declared it var, or let on a conflict)
        if (nested && node.id && node._variable?.kind === 'var') mark(node.id.name);
        return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
        return;

      case 'VariableDeclaration':
        if (node.kind === 'var') for (const x of node.declarations) mark(x.id);
        return;
    }

    for (const k in node) {
      if (k[0] === '_') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const x of v) scan(x, true);
      else scan(v, true);
    }
  };

  const stmts = body.type === 'Program' || body.type === 'BlockStatement' ? body.body : null;
  if (stmts) for (const x of stmts) {
    if ((moduleTop || scope.topLevel) && x.type === 'VariableDeclaration' && x.kind !== 'var') {
      for (const d of x.declarations) mark(d.id, HOIST_LEXICAL);
    }
    if ((moduleTop || scope.topLevel) && x.type === 'ClassDeclaration' && x.id) mark(x.id, HOIST_LEXICAL);
    scan(x);
  }
};

const materializeHoistedVar = (scope, name) => {
  const global = scope.topLevel;
  allocVar(scope, name, global);
  return global ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
};

// a hoisted top-level let/const/class not yet initialised: undefined with payload 1, which no
// value has (the marker the program starts it with)
const tdzMarker = () => JvConst(TYPES.undefined, 1);

// an inner function's read of a hoisted top-level let/const/class: its TDZ checked at run time
const readHoistedLexical = (scope, top, name) => {
  const global = materializeHoistedVar(top, name);
  if (global[N_TYPE] !== T.jsval || globalThis.precompile) return global;
  tdzGlobals.add(name);
  const value = reuse(scope, global);
  emitIf(scope, Bin('&', T.i32, Bin('==', T.i32, JvType(value), Const(T.i32, TYPES.undefined)), Bin('==', T.i32, JvPtr(value), Const(T.i32, 1))),
    () => exprStmt(scope, internalThrow(scope, 'ReferenceError', `Cannot access '${unhackName(name)}' before initialization`)));
  return value;
};

const lookupHoistedVar = (scope, name) => {
  if (scope.hoists?.get(name) === HOIST_DECL) return materializeHoistedVar(scope, name);

  for (let cursor = scope.parentFunc; cursor; cursor = cursor.parentFunc) {
    if (cursor.topLevel && cursor.hoists?.has(name)) {
      // a top-level class already defined is read as itself, not through the global
      if (cursor.hoists.get(name) === HOIST_LEXICAL) {
        if (!(name in globals) && resolveNamedFunction(scope, name)) return;
        return readHoistedLexical(scope, cursor, name);
      }
      return materializeHoistedVar(cursor, name);
    }
  }
};

const typeAnnoToPorfType = x => {
  if (!x) return null;
  if (TYPES[x.toLowerCase()] != null) return TYPES[x.toLowerCase()];

  switch (x) {
    case 'i32':
    case 'i64':
    case 'f64':
      return TYPES.number;
  }

  return null;
};
const typeAnnoToIrType = x => {
  switch (x) {
    case 'i32': return T.i32;
    case 'i64': return T.i64;
    case 'f64': return T.f64;
  }
  return null;
};

const extractTypeAnnotation = (decl, unwrapPromise = false) => {
  let a = decl;
  while (a.typeAnnotation) a = a.typeAnnotation;
  if (unwrapPromise && a.type === 'TSTypeReference' && a.typeName?.name === 'Promise') a = a.typeParameters?.params?.[0];
  if (!a) return {};

  let types = null, type = null, elementType = null, irType = null;
  if (a.typeName) {
    type = a.typeName.name;
  }
  if (type == null && a.type.endsWith('Keyword')) {
    type = a.type.slice(2, -7).toLowerCase();
    if (type === 'void') type = 'undefined';
  } else if (a.type === 'TSArrayType') {
    type = 'array';
    elementType = extractTypeAnnotation(a.elementType).type;
  } else if (a.type === 'TSUnionType') {
    types = [];
    for (const x of a.types) {
      const inner = extractTypeAnnotation(x);
      if (inner.types) for (const t of inner.types) {
        if (!types.includes(t)) types.push(t);
      }
    }
  }

  irType = typeAnnoToIrType(type);
  type = typeAnnoToPorfType(type);

  if (!types && type != null) types = [ type ];

  // outside precompile, string means string|bytestring
  if (!globalThis.precompile && type === TYPES.string) {
    type = null;
    types = [ TYPES.string, TYPES.bytestring ];
  }

  return { type, types, elementType, irType };
};

const setLocalWithType = (scope, name, isGlobal, decl, tee = false, overrideType = undefined) => {
  const metadata = scope.locals[name]?.metadata;
  // assigning to an annotated local is `value as T`
  if (metadata?.typeAnnotation && !Array.isArray(decl) && decl.type !== 'TSAsExpression')
    decl = { type: 'TSAsExpression', expression: decl, typeAnnotation: metadata.typeAnnotation };
  const known = overrideType ?? metadata?.type ?? (Array.isArray(decl) ? null : getNodeType(scope, decl));
  if (!Array.isArray(decl) && known != null && known !== TYPES.undefined && known !== TYPES.number && known !== TYPES.boolean &&
      decl.type === 'CallExpression' && (decl.callee.name === '__Porffor_malloc' ||
        (decl.callee.type === 'MemberExpression' && decl.callee.object.name === 'Porffor' && decl.callee.property.name === 'malloc')))
    decl._porfMallocType = known;
  // promote to raw f64 only when semantic write analysis proved every visible write numeric
  if (!isGlobal && known === TYPES.number && scope.locals[name]?.type === T.jsval &&
      (metadata?.type === TYPES.number || metadata?.storageType === TYPES.number) &&
      !scope.closureOwnLocals?.[name] && !scope.closureCaptures?.[name] && !metadata?.read && !metadata?.param) {
    scope.locals[name].type = T.f64;
  }
  const ref = isGlobal ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
  const value = Array.isArray(decl) ? decl : generate(scope, decl, name);
  if (known != null && known !== TYPES.undefined && known !== TYPES.number && known !== TYPES.boolean) {
    const alloc = value[N_KIND] === K.Alloc ? value :
      (value[N_KIND] === K.Box && value[N_A][N_KIND] === K.Alloc ? value[N_A] : null);
    if (alloc != null && alloc[N_B] === 0) alloc[N_B] = known;
  }
  setType(scope, name, known);
  assign(scope, ref, ref[N_TYPE] === T.jsval ? (value[N_TYPE] === T.jsval ? value : known != null && known !== TYPES.number ? valOf(value, known) : valNumber(value))
    : ref[N_TYPE] === value[N_TYPE] ? value
    : ref[N_TYPE] === T.f64 ? numValue(value)
    : ref[N_TYPE] === T.ptr ? JvPtr(value)
    : coerceValue(value, ref[N_TYPE]));
  return tee ? (ref[N_TYPE] === T.f64 ? valNumber(ref) : ref) : undefined;
};

const setDefaultFuncName = (decl, name) => {
  if (decl.id) return;

  if (decl.type === 'ClassExpression') {
    for (const x of decl.body.body) {
      if (x.static && x.key.name === 'name') return;
    }
  }

  name = name.split('#')[0];
  decl.id = { type: 'Identifier', name };
  decl._porfDefaultName = true;
};

const generatePatternDstr = (scope, tmpPrefix, pattern, init, defaultValue, emit) => {
  let tmpName = tmpPrefix + uniqId(scope);
  generateVarDstr(scope, 'const', tmpName, init, defaultValue, false);

  // an array pattern over anything but an array takes its values through the iterator
  // protocol (after any default): as many as the pattern names, all for a rest, then closes it
  if (pattern.type === 'ArrayPattern') {
    const known = knownType(scope, getType(scope, tmpName));
    const indexable = known === TYPES.array || (known >= TYPES.uint8clampedarray && known <= TYPES.float64array);
    if (!indexable) {
      const hasRest = pattern.elements.some(e => e?.type === 'RestElement');
      const source = tmpName;
      tmpName = tmpPrefix + uniqId(scope);
      generateVarDstr(scope, 'const', tmpName, {
        type: 'CallExpression',
        callee: identNode('__Porffor_iter_destructure'),
        arguments: [ identNode(source), { type: 'Literal', value: pattern.elements.length - (hasRest ? 1 : 0) }, { type: 'Literal', value: hasRest } ]
      }, undefined, false);
    }
  }

  const tmpRef = Local(tmpName, scope.locals[tmpName]?.type ?? T.jsval);
  if (pattern.type === 'ArrayPattern') {
    const t = reuse(scope, JvType(tmpRef));
    emitIf(scope, Un('!', T.i32, typeIsIterable(t)),
      () => internalThrow(scope, 'TypeError', 'Cannot array destructure a non-iterable'));

    let i = 0;
    const elements = pattern.elements.slice();
    for (const e of elements) {
      if (!e) {
        i++;
        continue;
      }

      if (e.type === 'RestElement') {
        if (e.argument.type === 'ArrayPattern') {
          elements.push(...e.argument.elements);
        } else {
          emit(e.argument, {
            type: 'CallExpression',
            callee: { type: 'Identifier', name: '__Array_prototype_slice' },
            arguments: [
              { type: 'Literal', value: i }
            ],
            _thisArg: identNode(tmpName),
            _protoInternalCall: true
          });
        }

        continue;
      }

      emit(e.type === 'AssignmentPattern' ? e.left : e,
        memberNode(identNode(tmpName), { type: 'Literal', value: i }, true),
        e.type === 'AssignmentPattern' ? e.right : undefined);

      i++;
    }
  } else if (pattern.type === 'ObjectPattern') {
    emitIf(scope, nullish(scope, tmpRef, getType(scope, tmpName)),
      () => internalThrow(scope, 'TypeError', 'Cannot object destructure undefined or null'));

    const usedProps = [];
    for (const prop of pattern.properties) {
      if (prop.type == 'Property') {
        usedProps.push(getProperty(prop));

        const memberComputed = prop.computed || prop.key.type === 'Literal';
        emit(prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value,
          memberNode(identNode(tmpName), prop.key, memberComputed),
          prop.value.type === 'AssignmentPattern' ? prop.value.right : undefined);
      } else if (prop.type === 'RestElement') {
        emit(prop.argument, {
          type: 'CallExpression',
          callee: { type: 'Identifier', name: '__Porffor_object_rest' },
          arguments: [
            { type: 'ObjectExpression', properties: [] },
            identNode(tmpName),
            ...usedProps
          ]
        });
      }
    }
  }
};

const generateVarDstr = (scope, kind, pattern, init, defaultValue, global) => {
  if (init && init.type === 'CallExpression' && init.callee.name === '__Porffor_dlopen') {
    throw new Error('Porffor.dlopen is not yet supported in the native IR backend');
  }

  pattern = identNode(pattern);

  const topLevel = scope.topLevel;
  if (pattern.type === 'Identifier') {
    const name = pattern.name;

    if (init && isFuncType(init.type)) {
      // opt: declare directly from the function expression
      setDefaultFuncName(init, name);
      const [ func ] = generateFunc(scope, init, true);
      pattern._func = func;

      const funcName = init.id?.name;
      if (name !== funcName && funcName in funcIndex) {
        setFuncIndex(name, funcIndex[funcName]);
        delete funcIndex[funcName];
      }

      // an earlier-generated function already read the hoisted global
      const hoistRead = global && name in globals;
      if (!hoistRead && directCallOnlyFunctionBinding(scope, kind, name, pattern, func)) {
        // no binding holds it, so its calls resolve by name: to this function in this scope,
        // not a same-named one declared further out
        bindNamedFunction(scope, name, func);
        return valUndefined();
      }

      // var/let function exprs need their binding value immediately (e.g. constructor .prototype reads), const stays lazy
      if (kind !== 'const' || hoistRead || hasClosureCaptures(func) || scope.closureOwnLocals?.[name]) {
        allocVar(scope, name, global);
        setVarMetadata(scope, name, global, { kind });
        setLocalWithType(scope, name, global, materializeFunctionValue(scope, func), false, TYPES.function);
      }

      // mirror the binding into the closure env when an inner closure captures it
      if (scope.closureOwnLocals?.[name]) mirrorToClosureEnv(scope, name);

      return valUndefined();
    }

    if (defaultValue && isFuncType(defaultValue.type)) {
      setDefaultFuncName(defaultValue, name);
    }

    if (topLevel && name in builtinVars) {
      if (kind !== 'var') return internalThrow(scope, 'SyntaxError', `Identifier '${unhackName(name)}' has already been declared`);
      if (!init) return valUndefined();

      allocVar(scope, name, global);
      setVarMetadata(scope, name, global, { kind });
      setLocalWithType(scope, name, global, init);
      return valUndefined();
    }

    const typed = typedInput && pattern.typeAnnotation && extractTypeAnnotation(pattern);
    const redecl = name in (global ? globals : scope.locals);
    allocVar(scope, name, global, typed?.irType ?? T.jsval);

    const metadata = { kind };
    // read before any write it can observe undefined, so no raw slot
    if (pattern._storageType != null && !(pattern._uninitialized && pattern._storageHazardRef)) metadata.storageType = pattern._storageType;
    if (init?.type === 'ObjectExpression') {
      metadata.ownProperties = new Set();
      for (const prop of init.properties) {
        if (prop.type === 'SpreadElement') continue;
        const propName = prop.computed ? prop.key.value : (prop.key.name ?? prop.key.value);
        if (propName != null) metadata.ownProperties.add(String(propName));
      }
    }
    if (redecl) {
      // a redeclaration is a new binding sharing the slot: drop stale type info, but pin
      // the value type (read) as earlier IR may already reference the local
      const oldMd = (global ? globals : scope.locals)[name].metadata;
      if (oldMd) {
        delete oldMd.type;
        delete oldMd.types;
        delete oldMd.typeAnnotation;
        delete oldMd.elementType;
        delete oldMd.storageType;
      }
      addVarMetadata(scope, name, global, { ...metadata, read: true });
    } else {
      setVarMetadata(scope, name, global, metadata);
    }
    if (typed) addVarMetadata(scope, name, global, { ...typed, typeAnnotation: pattern.typeAnnotation });
    // xs[i] of an array of T: a T, or undefined past its end (what narrowing then tells apart)
    else if (init?.type === 'MemberExpression' && init.computed && init.object.type === 'Identifier') {
      const element = (scope.locals[init.object.name] ?? globals[init.object.name])?.metadata?.elementType;
      if (element != null) addVarMetadata(scope, name, global, { possible: [ element, TYPES.undefined ] });
    }
    // what it holds, when that is one of a few types (a string): typeSet reads it for a
    // local nothing reassigns
    if (!typed && init != null && !global && metadata.possible == null) {
      const set = typeSet(scope, init);
      if (set != null && set.length > 1) addVarMetadata(scope, name, global, { possible: set });
    }

    if (init) {
      setLocalWithType(scope, name, global, init, false, typed?.type);

      if (defaultValue) {
        const ref = global ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
        const doDefault = () => {
          assign(scope, ref, generate(scope, defaultValue, name));
          setType(scope, name, getNodeType(scope, defaultValue), true);
        };
        const st = getType(scope, name);
        if (st === TYPES.undefined) doDefault();
        else if (st == null) emitIf(scope, Bin('==', T.jsval, ref, valUndefined()), doDefault);
      }
    } else {
      // a let is undefined at its declaration, again on every loop iteration
      const ref = global ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
      if (kind === 'let' && !typed && ref[N_TYPE] === T.jsval) assign(scope, ref, valUndefined());
      setInferred(scope, name, null, global);
    }

    if (scope.closureOwnLocals?.[name] && (!redecl || init)) {
      // a loop header's declaration is a new binding each iteration: a new box (a block's
      // are made at its entry, generateBlock)
      if (ownBoxedBinding(scope, name) && scope.closureOwnLocals[name].node._variable?.scope?.type !== 'BlockStatement')
        allocBindingBox(scope, name);
      mirrorToClosureEnv(scope, name, init ? closureLocalReadNode(name) : DEFAULT_VALUE);
    }

    return valUndefined();
  }

  if (pattern.type === 'ArrayPattern') {
    generatePatternDstr(scope, '#destructure', pattern, init, defaultValue,
      (target, value, def) => generateVarDstr(scope, kind, target, value, def, global));
    return valUndefined();
  }

  if (pattern.type === 'ObjectPattern') {
    generatePatternDstr(scope, '#destructure', pattern, init, defaultValue,
      (target, value, def) => generateVarDstr(scope, kind, target, value, def, global));
    return valUndefined();
  }

  if (pattern.type === 'MemberExpression') {
    genStmt(scope, {
      type: 'AssignmentExpression',
      operator: '=',
      left: pattern,
      right: !defaultValue ? init : {
        type: 'LogicalExpression',
        operator: '??',
        left: init,
        right: defaultValue
      }
    });
    return valUndefined();
  }
};

const generatePatternAssign = (scope, pattern, init, defaultValue) => {
  pattern = identNode(pattern);

  if (pattern.type === 'Identifier' && defaultValue && isFuncType(defaultValue.type)) {
    setDefaultFuncName(defaultValue, pattern.name);
  }

  if (pattern.type === 'MemberExpression' && init?.type === 'MemberExpression') {
    // a.b = c.d: bind source key, target object and property up-front for evaluation order
    const id = uniqId(scope);
    const sourceKeyName = '#assign_source_key' + id;
    const targetObjectName = '#assign_target_obj' + id;
    const targetPropertyName = '#assign_target_prop' + id;
    const rhsName = '#assign_value' + id;

    generateVarDstr(scope, 'const', sourceKeyName, {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__ecma262_ToPropertyKey' },
      arguments: [ getProperty(init) ]
    }, undefined, false);
    generateVarDstr(scope, 'const', targetObjectName, pattern.object, undefined, false);
    // (a private name is not a key: obj.#x stays one)
    const priv = pattern.property._private != null;
    if (!priv) generateVarDstr(scope, 'const', targetPropertyName, getProperty(pattern), undefined, false);
    generateVarDstr(scope, 'const', rhsName,
      memberNode(init.object, identNode(sourceKeyName), true), defaultValue, false);
    genStmt(scope, {
      type: 'AssignmentExpression',
      operator: '=',
      left: priv ? memberNode(identNode(targetObjectName), pattern.property, false) : memberNode(identNode(targetObjectName), identNode(targetPropertyName), true),
      right: identNode(rhsName)
    });
    return valUndefined();
  }

  if (pattern.type === 'Identifier' || pattern.type === 'MemberExpression') {
    let right = init;

    if (defaultValue) {
      const tmpName = '#assign' + uniqId(scope);
      generateVarDstr(scope, 'const', tmpName, init, undefined, false);
      right = {
        type: 'ConditionalExpression',
        test: {
          type: 'BinaryExpression',
          operator: '===',
          left: identNode(tmpName),
          right: identNode('undefined')
        },
        consequent: defaultValue,
        alternate: identNode(tmpName)
      };
    }

    genStmt(scope, {
      type: 'AssignmentExpression',
      operator: '=',
      left: pattern,
      right
    });
    return valUndefined();
  }

  if (pattern.type === 'ArrayPattern') {
    generatePatternDstr(scope, '#assign_dstr', pattern, init, defaultValue,
      (target, value, def) => generatePatternAssign(scope, target, value, def));
    return valUndefined();
  }

  if (pattern.type === 'ObjectPattern') {
    generatePatternDstr(scope, '#assign_dstr', pattern, init, defaultValue,
      (target, value, def) => generatePatternAssign(scope, target, value, def));
    return valUndefined();
  }
};

const generateVar = (scope, decl) => {
  const topLevel = scope.topLevel;
  const global = decl._global ?? (topLevel || decl._bare);

  for (const x of decl.declarations) {
    const m = mark(scope);
    generateVarDstr(scope, decl.kind, x.id, x.init, undefined, global);
    release(scope, m);
  }

  return valUndefined();
};

const privateIDName = name => '__#' + name;
const getProperty = (decl, forceValueStr = false) => {
  const prop = decl.property ?? decl.key;
  if (decl.computed) return prop;

  if (prop.name != null) return {
    type: 'Literal',
    value: prop.type === 'PrivateIdentifier' ? privateIDName(prop.name) : prop.name,
  };

  if (forceValueStr && prop.value != null) return {
    ...prop,
    value: prop.value.toString()
  };

  return prop;
};

const propertyNameForError = decl => {
  const prop = getProperty(decl, true);
  if (prop.type === 'Literal' && prop.value !== undefined) return String(prop.value);

  const value = knownValue(null, prop);
  if (value !== unknownValue && value !== undefined) return String(value);
};

const exprText = node => {
  if (node.type === 'Identifier') return unhackName(node.name);
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) return `${exprText(node.object)}.${node.property.name}`;
  if (node.type === 'MemberExpression' && node.property.type === 'Literal') return `${exprText(node.object)}[${JSON.stringify(node.property.value)}]`;
  return '(intermediate value)';
};

const propertyErrorMessage = (action, target, decl) => {
  if (Prefs.d && decl) {
    const name = propertyNameForError(decl);
    const object = exprText(decl.object);
    return `Cannot ${action} property ${name != null ? `'${name}' ` : ''}of ${target}` + (object !== '(intermediate value)' ? ` (${object})` : '');
  }
  return `Cannot ${action} property of ${target}`;
};

const globalThisBindingName = decl => {
  if (decl.type !== 'MemberExpression' || decl.object?.type !== 'Identifier' || decl.object.name !== 'globalThis') return;

  const name = propertyNameForError(decl);
  if (name != null && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name) && !(name in builtinVars)) return name;
};

// a fresh inline cache slot (an entry offset, empty until the site first finds its key),
// for an obj.key read or write: 256 to a data chunk, per unit
const icSlot = scope => {
  const unit = unitOf(scope);
  const ic = icSites[unit] ??= { site: 0, chunk: null };
  const index = ic.site++ % 256;
  if (index === 0)
    ic.chunk = dataSeg(unit, `#ic:${unit}:${ic.site}`, new Array(256).fill(i32Bytes(0x7fffffff)).flat());

  const chunk = DataRef(ic.chunk);
  return index === 0 ? chunk : Bin('+', T.i32, chunk, Const(T.i32, index * 4));
};

// a cached site's key: the address of a constant bytestring (what the IC builtins take),
// or null for any other key (a two-byte string), which then takes the uncached lookup
const icKey = key => key[N_KIND] === K.Box && key[N_A][N_KIND] === K.DataRef &&
  key[N_B][N_KIND] === K.Const && key[N_B][N_A] === TYPES.bytestring ? key[N_A] : null;

const bindMemberTarget = (scope, member, prefix, coerceKey = false) => {
  const id = uniqId(scope);
  const objName = prefix + 'obj' + id;
  generateVarDstr(scope, 'const', objName, member.object, undefined, false);

  let property = member.property;
  if (member.computed && member._closureSlot == null) {
    const keyName = prefix + 'key' + id;
    // a number key is its own property key (and keeps an array's or typed array's
    // element path)
    if (coerceKey && knownType(scope, getNodeType(scope, member.property)) === TYPES.number) coerceKey = false;
    generateVarDstr(scope, 'const', keyName, coerceKey ? {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__ecma262_ToPropertyKey' },
      arguments: [ member.property ]
    } : member.property, undefined, false);
    property = identNode(keyName);
  }

  return memberNode(identNode(objName), property, member.computed, {
    _closureSlot: member._closureSlot,
    _skipChainDepth: member._skipChainDepth
  });
};

const isIdentAssignable = (scope, name, op = '=') => {
  if (!scope.strict && op === '=') return true;

  if (lookupName(scope, name)[0] != null) return true;

  if (lookupHoistedVar(scope, name) != null) return true;

  if (hasFuncWithName(name) && scope.name !== name) return true;

  return false;
};

// todo: generate this array procedurally

const ctHash = prop => {
  if (!Prefs.ctHash || !prop ||
    prop.computed || prop.optional ||
    prop.property.type === 'PrivateIdentifier'
  ) return null;

  prop = prop.property.name;
  if (!prop || prop === '__proto__' || !byteStringable(prop)) return null;
  return hashString(prop);
};

// the hash __Porffor_object_hash gives a string at run time (xxh32-based), of a one-byte
// string known now: a property key, a switch case
const hashString = prop => {
  let i = 0;
  const len = prop.length;
  // (seeded with the length, as __Porffor_object_hash is)
  let hash = (374761393 + len) | 0;

  const rotl = (n, k) => (n << k) | (n >>> (32 - k));
  const read = () => (prop.charCodeAt(i + 3) << 24 | prop.charCodeAt(i + 2) << 16 | prop.charCodeAt(i + 1) << 8 | prop.charCodeAt(i));

  for (; i + 4 <= len; i += 4) {
    hash = Math.imul(rotl(hash + Math.imul(read(), 3266489917), 17), 668265263);
  }

  let tail = 0;
  if (i < len) tail |= prop.charCodeAt(i);
  if (i + 1 < len) tail |= prop.charCodeAt(i + 1) << 8;
  if (i + 2 < len) tail |= prop.charCodeAt(i + 2) << 16;
  if (i < len) hash = Math.imul(rotl(hash + Math.imul(tail, 3266489917), 17), 668265263);

  hash = Math.imul(hash ^ (hash >>> 15), 2246822519);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489917);
  return (hash ^ (hash >>> 16));
};


const generateAssign = (scope, decl, valueUnused = false) => {
  // a function or class expression's own name, inside it, is read-only (parse.js scopes a
  // named expression as a declaration in a wrapper, marked _fromExpression); a function
  // declaration's name is an ordinary binding (babel's _extends reassigns its own)
  const self = decl.left.type === 'Identifier' ? decl.left._selfBinding : null;
  if (self && (self.type !== 'FunctionDeclaration' || self._fromExpression)) {
    if (scope.strict || decl.left._classBinding) return internalThrow(scope, 'TypeError', `Cannot assign to constant variable ${decl.left.name}`);

    const v = generate(scope, decl.right);
    if (valueUnused) { exprStmt(scope, v); return valUndefined(); }
    return v;
  }

  if (decl.left.type === 'Identifier' && ((decl.left._closureFunc && !(decl.left.name in scope.locals)) || scope.closureOwnLocals?.[decl.left.name])) {
    return generateAssign(scope, {
      ...decl,
      left: closureEnvNode(scope, decl.left.name, decl.left._closureFunc ?? scope.ast)
    }, valueUnused);
  }

  const { type, name } = decl.left;
  let [ local, isGlobal ] = lookupName(scope, name);
  if (local === undefined && type === 'Identifier' && lookupHoistedVar(scope, name)) {
    [ local, isGlobal ] = lookupName(scope, name);
  }

  const op = assignmentOp(decl.operator);

  // logical assignment ops short-circuit: x @= y is x @ (x = y), NOT x = x @ y
  // (the store only happens on the branch that evaluates the right)
  const check = logicalChecks[op];
  if (check) {
    if (local !== undefined) {
      // fast path: conditional in-place store, the var itself is the result: if (check(x)) x = y
      const ref = isGlobal ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
      const cond = check(scope, ref, getType(scope, name));
      setInferred(scope, name, knownType(scope, getNodeType(scope, decl)), isGlobal);
      emitIf(scope, cond, () => setLocalWithType(scope, name, isGlobal, decl.right));
      return valueUnused ? valUndefined() : (isGlobal ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval));
    }

    // member/other: x @= y -> x @ (x = y), bases/keys evaluated once before the RHS via temp-backed member nodes
    let left = decl.left;
    let rightLeft = left;
    if (type === 'MemberExpression') {
      left = bindMemberTarget(scope, decl.left, '#logical_');
      rightLeft = { ...left };
    }

    return generate(scope, {
      type: 'LogicalExpression',
      operator: op,
      left,
      right: { type: 'AssignmentExpression', operator: '=', left: rightLeft, right: decl.right }
    }, undefined, valueUnused);
  }

  // obj.#x = y, obj.#x += y: the class's own objects only; a method is not writable
  if (type === 'MemberExpression' && decl.left.property._private) {
    const obj = reuse(scope, generate(scope, decl.left.object));
    const key = reuse(scope, generate(scope, decl.left.property));
    if (decl.left.property._private.kinds.has('method')) {
      exprStmt(scope, generate(scope, decl.right));
      exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrivateMethod', [ obj, key ]));
      return valUndefined();
    }

    const right = op === '=' ? generate(scope, decl.right)
      : performOp(scope, op, reuse(scope, builtinCall(scope, '__Porffor_object_getPrivate', [ obj, key ])), generate(scope, decl.right), null, getNodeType(scope, decl.right));
    const value = reuse(scope, coerceValue(right, T.jsval));
    exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrivate', [ obj, key, value ]));
    return valueUnused ? valUndefined() : value;
  }

  if (type === 'MemberExpression' && decl.left._closureSlot != null) {
    const slot = decl.left._closureSlot - 1;
    const env = reuse(scope, generate(scope, decl.left.object));
    const previous = op === '=' ? null : reuse(scope, generateMember(scope, decl.left, env));
    const right = generate(scope, decl.right);
    const result = op === '=' ? right : performOp(scope, op, previous, right, null, getNodeType(scope, decl.right));
    // a slot holds a jsval: a raw number (parseInt's f64, an i32 count) is boxed as one
    const value = reuse(scope, isRawNum(result) ? valNumber(numValue(result)) : result);
    stmt(scope, Store('f64', JvPtr(env), 8 + slot * 16, JvNum(value)));
    stmt(scope, Store('u8', JvPtr(env), 16 + slot * 16, JvType(value)));
    const freshEnv = env[N_KIND] === K.Local && env[N_A] === '#closure_env_local' && stillFresh(scope, scope.freshEnv);
    if (!freshEnv) stmt(scope, If(canReferenceCheck(scope, value), [
      GcBarrier(JvPtr(env), Const(T.i32, TYPES.__porffor_closureenv))
    ]));
    return valueUnused ? valUndefined() : value;
  }

  if (type === 'MemberExpression' && !decl.left.computed && decl.left.property.name === 'length' && !decl._internalAssign) {
    const known = knownType(scope, getNodeType(scope, decl.left.object));

    const storeLength = (p, ensureArray = null) => {
      const ptr = reuse(scope, p);
      const newVal = reuse(scope, op === '=' ? generate(scope, decl.right) : performOp(scope, op,
        Box(Convert(T.f64, LenGet(ptr)), Const(T.i32, TYPES.number)),
        generate(scope, decl.right), TYPES.number, getNodeType(scope, decl.right)));
      const lenValue = Convert(T.u32, numValue(newVal));
      if (ensureArray === true) {
        stmt(scope, ArrLenSet(ptr, lenValue));
      } else if (ensureArray) {
        emitIf(scope, ensureArray,
          () => stmt(scope, ArrLenSet(ptr, lenValue)),
          () => stmt(scope, LenSet(ptr, lenValue)));
      } else {
        stmt(scope, LenSet(ptr, lenValue));
      }
      // the assignment's value, as a jsval: a typed right side (an i32 in a builtin) is not one
      return coerceValue(newVal, T.jsval);
    };

    if (known != null && (known & TYPE_FLAGS.length) !== 0) {
      const v = storeLength(JvPtr(generate(scope, decl.left.object)), known === TYPES.array);
      return valueUnused ? valUndefined() : v;
    }

    const obj = reuse(scope, generate(scope, decl.left.object));
    const res = tmp(scope, T.jsval);
    emitIf(scope, Bin('!=', T.i32, Bin('&', T.i32, JvType(obj), Const(T.i32, TYPE_FLAGS.length)), Const(T.i32, 0)),
      () => assign(scope, res, coerceValue(storeLength(JvPtr(obj), Bin('==', T.i32, JvType(obj), Const(T.i32, TYPES.array))), T.jsval)),
      () => assign(scope, res, generate(scope, { ...decl, _internalAssign: true })));
    return valueUnused ? valUndefined() : res;
  }

  if (type === 'MemberExpression') {
    const object = decl.left.object;
    const property = getProperty(decl.left);
    const propertyType = getNodeType(scope, property);
    const propertyKnown = knownType(scope, propertyType);
    const canFastComputedIndex = decl.left.computed && propertyKnown === TYPES.number;
    const globalThisName = op === '=' && globalThisBindingName(decl.left);
    const objectType = getNodeType(scope, object);
    const objectKnown = knownType(scope, objectType);
    const objectKnownValue = knownValue(scope, object);

    // opt: do not mark prototype funcs as referenced to optimize this in them
    if (object?.property?.name === 'prototype' && isFuncType(decl.right.type)) decl.right._doNotMarkFuncRef = true;

    const snapshotRef = v => v[N_KIND] === K.Local || v[N_KIND] === K.Global ? tmp(scope, v[N_TYPE], v) : reuse(scope, v);
    const needSnapshot = op === '=' && decl.right.type !== 'Literal' && decl.right.type !== 'Identifier';
    const obj = needSnapshot ? snapshotRef(generate(scope, object)) : reuse(scope, generate(scope, object));
    const prop = needSnapshot ? snapshotRef(generate(scope, property)) : reuse(scope, generate(scope, property));
    const simpleValue = op === '=' ? reuse(scope, generate(scope, decl.right)) : null;

    // regexp.lastIndex: store i32 at offset 8
    if (op === '=' && !decl.left.computed && decl.left.property.name === 'lastIndex' && objectKnown === TYPES.regexp) {
      const v = simpleValue;
      stmt(scope, Store('i32', JvPtr(obj), 8, Convert(T.i32, JvNum(v))));
      return valueUnused ? valUndefined() : v;
    }

    const hash = ctHash(decl.left);

    // compound ops reuse one converted key for their get + set
    const keyOf = () => decl.left.computed && op !== '=' ? builtinCall(scope, '__ecma262_ToPropertyKey', [ prop ]) : prop;
    const setBuiltin = scope.strict ? '__Porffor_object_setStrict' : '__Porffor_object_set';

    if (globalThisName) {
      // globalThis.x writes both the global binding and the object property
      allocVar(scope, globalThisName, true);
      setVarMetadata(scope, globalThisName, true, { kind: 'var' });

      const v = simpleValue;
      assign(scope, Global(globalThisName, T.jsval), v);
      exprStmt(scope, builtinCall(scope, setBuiltin, [ obj, keyOf(), v ]));
      return valueUnused ? valUndefined() : v;
    }

    const genericMemberSet = () => {
      const key = reuse(scope, keyOf());
      // a known key on what may be a plain object: cached per site (reads and writes)
      const cached = hash != null && Prefs.ic && (objectKnown == null || objectKnown === TYPES.object) && icKey(key) != null;
      const value = op === '=' ? simpleValue
        : performOp(scope, op,
            cached ? builtinCall(scope, '__Porffor_object_get_ic', [ obj, icKey(key), Const(T.i32, hash), icSlot(scope) ])
              : hash != null ? builtinCall(scope, '__Porffor_object_get_withHash', [ obj, key, Const(T.i32, hash) ]) : builtinCall(scope, '__Porffor_object_get', [ obj, key ]),
            generate(scope, decl.right), null, getNodeType(scope, decl.right));
      // a class constructor's i-th leading this.k = … (markConstructorAdds): written as entry i
      // of the new object when that holds, else set as any other
      if (cached && op === '=' && decl._constructorEntry != null) {
        const v = reuse(scope, coerceValue(value, T.jsval));
        const added = builtinCall(scope, '__Porffor_object_addAt', [ obj, Const(T.i32, decl._constructorEntry), icKey(key), Const(T.i32, hash), v ]);
        emitIf(scope, Un('!', T.i32, truthy(scope, added, TYPES.boolean)),
          () => exprStmt(scope, builtinCall(scope, '__Porffor_object_set_ic', [ obj, icKey(key), v, Const(T.i32, hash), icSlot(scope), Const(T.i32, scope.strict ? 1 : 0) ])));
        return v;
      }
      if (cached) return builtinCall(scope, '__Porffor_object_set_ic', [ obj, icKey(key), value, Const(T.i32, hash), icSlot(scope), Const(T.i32, scope.strict ? 1 : 0) ]);
      return hash != null
        ? builtinCall(scope, setBuiltin + '_withHash', [ obj, key, value, Const(T.i32, hash) ])
        : builtinCall(scope, setBuiltin, [ obj, key, value ]);
    };

    const arraySet = () => {
      const arr = reuse(scope, JvPtr(obj));
      const { idx, valid } = denseArrayIndexKey(scope, prop);
      const res = tmp(scope, T.jsval);
      emitIf(scope, valid, () => {
        const v = reuse(scope, op === '=' ? simpleValue
          : performOp(scope, op, arrGet(scope, arr, idx), generate(scope, decl.right), null, getNodeType(scope, decl.right)));
        stmt(scope, ArrSet(arr, idx, v));
        assign(scope, res, v[N_TYPE] === T.jsval ? v : valNumber(v));
      }, () => assign(scope, res, genericMemberSet()));
      return res;
    };

    // the number an element store writes: the value's ToNumber (a string, an object's valueOf),
    // skipped where the value is known to be a number
    const taNumber = v => v[N_TYPE] === T.f64 || (op === '=' && getNodeType(scope, decl.right) === TYPES.number) ? numValue(v)
      : numValue(builtinCall(scope, '__ecma262_ToNumber', [ v ]));
    // an element store: the value is converted first (its valueOf runs either way), then
    // written only to an integer index below the length; a compound op reads undefined
    // (NaN) for any other key
    const taStore = (size, read, convert, write) => () => {
      const { idx, valid } = typedArrayIndexKey(scope, obj, prop);
      const inRange = reuse(scope, valid);
      const addr = reuse(scope, taAddr(obj, idx, size));
      let previous = null;
      if (op !== '=') {
        previous = tmp(scope, T.jsval);
        emitIf(scope, inRange, () => assign(scope, previous, read(addr)), () => assign(scope, previous, valUndefined()));
      }
      const v = reuse(scope, op === '=' ? simpleValue
        : performOp(scope, op, previous, generate(scope, decl.right), null, getNodeType(scope, decl.right)));
      const converted = reuse(scope, convert(v));
      emitIf(scope, inRange, () => stmt(scope, write(addr, converted)));
      return v[N_TYPE] === T.jsval ? v : valNumber(v);
    };
    const taSet = (ctype, size, signed) => taStore(size,
      addr => Box(Convert(T.f64, Load(ctype, addr, 4), signed ? CONVERT_SIGNED : 0), Const(T.i32, TYPES.number)),
      v => taNumber(v),
      // an integer element is the low bits of ToUint32 (wrapped modulo 2^32, never
      // saturated: u32[i] = -1 stores 0xffffffff, i8[i] = 200 stores -56)
      (addr, f) => Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' || ctype === 'f16' ? f : signed ? Convert(T.i32, toUint32(scope, f), 0) : toUint32(scope, f)));
    // ToUint8Clamp: clamped to 0..255, then rounded half to even (1.5 is 2, 2.5 is 2; NaN is 0)
    const taSetClamped = taStore(1,
      addr => Box(Convert(T.f64, Load('u8', addr, 4)), Const(T.i32, TYPES.number)),
      v => Convert(T.u32, Call('porf_nearest', [ Bin('min', T.f64, Bin('max', T.f64, taNumber(v), Const(T.f64, 0)), Const(T.f64, 255)) ], T.f64), 0),
      (addr, u) => Store('u8', addr, 4, u));
    const taSetBig = () => {
      const { idx, valid } = typedArrayIndexKey(scope, obj, prop);
      const inRange = reuse(scope, valid);
      const addr = reuse(scope, taAddr(obj, idx, 8));
      let previous = null;
      if (op !== '=') {
        previous = tmp(scope, T.jsval);
        emitIf(scope, inRange, () => assign(scope, previous, builtinCall(scope, '__Porffor_bigint_fromS64', [ Load('i64', addr, 4) ])), () => assign(scope, previous, valUndefined()));
      }
      const v = reuse(scope, op === '=' ? builtinCall(scope, '__ecma262_ToBigInt', [ simpleValue ])
        : builtinCall(scope, '__ecma262_ToBigInt', [ performOp(scope, op, previous, generate(scope, decl.right), null, getNodeType(scope, decl.right)) ]));
      emitIf(scope, inRange, () => stmt(scope, Store('i64', addr, 4, builtinCall(scope, '__Porffor_bigint_toI64', [ v ]))));
      return v;
    };

    const indexedMemberSetBC = [
      [ TYPES.array, arraySet ],
      [ TYPES.uint8array, taSet('u8', 1, false) ],
      [ TYPES.uint8clampedarray, taSetClamped ],
      [ TYPES.int8array, taSet('i8', 1, true) ],
      [ TYPES.uint16array, taSet('u16', 2, false) ],
      [ TYPES.int16array, taSet('i16', 2, true) ],
      [ TYPES.uint32array, taSet('u32', 4, false) ],
      [ TYPES.int32array, taSet('i32', 4, true) ],
      [ TYPES.float16array, taSet('f16', 2, false) ],
      [ TYPES.float32array, taSet('f32', 4, false) ],
      [ TYPES.float64array, taSet('f64', 8, false) ],
      [ TYPES.bigint64array, taSetBig ],
      [ TYPES.biguint64array, taSetBig ]
    ];

    const genericMemberSetBC = [
      [ TYPES.undefined, () => internalThrow(scope, 'TypeError', propertyErrorMessage('set', 'undefined', decl.left)) ],
      ...(objectKnownValue === null ? [ [ TYPES.object, () => {
        if (op === '=') exprStmt(scope, simpleValue);
        return internalThrow(scope, 'TypeError', propertyErrorMessage(op === '=' ? 'set' : 'read', 'null', decl.left));
      } ] ] : Prefs.d ? [ [ TYPES.object, () => {
        emitIf(scope, Bin('==', T.i32, JvPtr(obj), Const(T.u32, 0)), () => internalThrow(scope, 'TypeError', propertyErrorMessage(op === '=' ? 'set' : 'read', 'null', decl.left)));
        return genericMemberSet();
      } ] ] : []),
      [ 'default', genericMemberSet ]
    ];

    const memberSetBC = canFastComputedIndex ? [ ...indexedMemberSetBC, ...genericMemberSetBC ] : genericMemberSetBC;

    let res;
    if (decl.left.computed && propertyKnown == null) {
      res = typeSwitch(scope, prop, null, {
        [TYPES.number]: () => typeSwitch(scope, obj, objectKnown, [ ...indexedMemberSetBC, ...genericMemberSetBC ]),
        default: () => typeSwitch(scope, obj, objectKnown, genericMemberSetBC)
      });
    } else {
      res = typeSwitch(scope, obj, objectKnown, memberSetBC);
    }
    if (valueUnused) {
      exprStmt(scope, res);
      return valUndefined();
    }
    return res;
  }

  if ((type === 'ArrayPattern' || type === 'ObjectPattern') && op === '=') {
    const tmpName = '#rhs' + uniqId(scope);
    generateVarDstr(scope, 'const', tmpName, decl.right, undefined, false);
    generatePatternAssign(scope, decl.left, identNode(tmpName));
    return valueUnused ? valUndefined() : generate(scope, identNode(tmpName));
  }

  if (local === undefined) {
    if (type === 'Identifier' && name === 'arguments' && !scope.arrow) {
      allocVar(scope, name, false);
      setVarMetadata(scope, name, false, { kind: 'var' });

      if (valueUnused) { setLocalWithType(scope, name, false, decl.right); return valUndefined(); }
      return setLocalWithType(scope, name, false, decl.right, true);
    }

    // only allow = for this, or if in strict mode always throw
    if (!isIdentAssignable(scope, name, op)) return internalThrow(scope, 'ReferenceError', `${unhackName(name)} is not defined`);

    if (type !== 'Identifier') {
      const tmpName = '#rhs' + uniqId(scope);
      generateVarDstr(scope, 'const', tmpName, decl.right, undefined, true);
      generateVarDstr(scope, 'var', decl.left, identNode(tmpName), undefined, true);
      return generate(scope, identNode(tmpName));
    }

    if (name in builtinVars) {
      if (scope.strict) return internalThrow(scope, 'TypeError', `Cannot assign to non-writable global ${name}`);

      // just return rhs (eg `NaN = 2`)
      return generate(scope, decl.right);
    }

    // set global and return (eg a = 2)
    generateVarDstr(scope, 'var', name, decl.right, undefined, true);
    return valueUnused ? valUndefined() : generate(scope, decl.left);
  }

  if (local.metadata?.kind === 'const') return internalThrow(scope, 'TypeError', `Cannot assign to constant variable ${name}`);

  if (op === '=') {
    if (valueUnused) { setLocalWithType(scope, name, isGlobal, decl.right); return valUndefined(); }
    return setLocalWithType(scope, name, isGlobal, decl.right, true);
  }

  // compound assignment: left @= right -> left = left @ right
  const cur = isGlobal ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
  const newVal = performOp(scope, op, cur, generate(scope, decl.right), getType(scope, name), getNodeType(scope, decl.right));
  setInferred(scope, name, knownType(scope, getNodeType(scope, decl)), isGlobal);

  if (valueUnused) { setLocalWithType(scope, name, isGlobal, newVal, false, getNodeType(scope, decl)); return valUndefined(); }
  return setLocalWithType(scope, name, isGlobal, newVal, true, getNodeType(scope, decl));
};

const ifIdentifierErrors = (scope, decl) => {
  if (decl.type === 'Identifier') {
    if (decl._resolvedBinding || decl._closureFunc || (!decl._skipClosureOwnLocals && scope.closureOwnLocals?.[decl.name])) return false;
    if (lookup(scope, decl.name, true) == null) return true;
  }

  return false;
};

const generateUnary = (scope, decl) => {
  // numeric value of the argument (ToNumeric), skipping the call if already a number
  const toNumeric = () => knownType(scope, getNodeType(scope, decl.argument)) === TYPES.number
    ? generate(scope, decl.argument)
    : generate(scope, { type: 'CallExpression', callee: { type: 'Identifier', name: '__ecma262_ToNumeric' }, arguments: [ decl.argument ] });
  // - and ~: the C runtime's for a BigInt, `number` for a Number
  const bigintUnary = (cfunc, number) => {
    const known = knownType(scope, getNodeType(scope, decl.argument));
    if (known === TYPES.bigint) return Call(cfunc, [ valNumber(generate(scope, decl.argument)) ], T.jsval);
    if (!usesBigInt || known === TYPES.number) return number(toNumeric());
    const v = reuse(scope, valNumber(toNumeric()));
    return Select(isBigint(v), Call(cfunc, [ v ], T.jsval), number(v));
  };

  switch (decl.operator) {
    case '+':
      if (knownType(scope, getNodeType(scope, decl.argument)) === TYPES.number) return generate(scope, decl.argument);
      return generate(scope, { type: 'CallExpression', callee: { type: 'Identifier', name: '__ecma262_ToNumber' }, arguments: [ decl.argument ] });

    case '-':
      if (decl.prefix && decl.argument.type === 'Literal') {
        if (decl.argument.bigint != null)
          return generate(scope, { type: 'Literal', bigint: `-${decl.argument.bigint}` });
        if (typeof decl.argument.value === 'number')
          return generate(scope, { type: 'Literal', value: -decl.argument.value });
      }
      return bigintUnary('porf_bigint_neg', v => Box(Un('neg', T.f64, numValue(v)), Const(T.i32, TYPES.number)));

    case '~':
      return bigintUnary('porf_bigint_not', v => Box(Convert(T.f64, Un('~', T.i32, Convert(T.i32, toUint32(scope, numValue(v)), CONVERT_RANGE_KNOWN | CONVERT_SIGNED)), CONVERT_SIGNED), Const(T.i32, TYPES.number)));

    case '!': {
      const arg = decl.argument;
      // opt: !!x -> is x truthy
      if (arg.type === 'UnaryExpression' && arg.operator === '!')
        return Box(truthy(scope, generate(scope, arg.argument), getNodeType(scope, arg.argument)), Const(T.i32, TYPES.boolean));
      return Box(falsy(scope, generate(scope, arg), getNodeType(scope, arg)), Const(T.i32, TYPES.boolean));
    }

    case 'void':
      exprStmt(scope, generate(scope, decl.argument));
      return valUndefined();

    case 'delete': {
      if (decl.argument.type === 'MemberExpression') {
        const object = decl.argument.object;
        if (object.type === 'Super') return internalThrow(scope, 'ReferenceError', 'Cannot delete super property');

        const property = getProperty(decl.argument);
        const obj = reuse(scope, generate(scope, object));
        const key = decl.argument.computed ? builtinCall(scope, '__ecma262_ToPropertyKey', [ generate(scope, property) ]) : generate(scope, property);
        return builtinCall(scope, scope.strict ? '__Porffor_object_deleteStrict' : '__Porffor_object_delete', [ obj, key ]);
      }

      let toReturn = true, toGenerate = true;
      if (decl.argument.type === 'Identifier') {
        if (ifIdentifierErrors(scope, decl.argument)) { toReturn = true; toGenerate = false; }
        else toReturn = false;
      }
      if (toGenerate) exprStmt(scope, generate(scope, decl.argument));
      return valBool(toReturn);
    }

    case 'typeof': {
      // a name nothing defines: the global object's property of it, made at run time or not
      if (ifIdentifierErrors(scope, decl.argument)) return globalThis.precompile || decl.argument.name === 'globalThis' ? makeString(scope, 'undefined')
        : generate(scope, { ...decl, argument: memberNode(identNode('globalThis'), identNode(decl.argument.name)) });

      const arg = reuse(scope, generate(scope, decl.argument));
      return typeSwitch(scope, arg, knownType(scope, getNodeType(scope, decl.argument)), [
        [ TYPES.number, () => makeString(scope, 'number') ],
        [ TYPES.boolean, () => makeString(scope, 'boolean') ],
        [ [ TYPES.string, TYPES.bytestring ], () => makeString(scope, 'string') ],
        [ TYPES.undefined, () => makeString(scope, 'undefined') ],
        [ TYPES.function, () => makeString(scope, 'function') ],
        [ TYPES.symbol, () => makeString(scope, 'symbol') ],
        [ TYPES.bigint, () => makeString(scope, 'bigint') ],

        [ 'default', () => makeString(scope, 'object') ]
      ]);
    }
  }
};

const generateUpdate = (scope, decl, valueUnused = false) => {
  if (decl.argument.type === 'Identifier' && (decl.argument._closureFunc || scope.closureOwnLocals?.[decl.argument.name])) {
    return generateUpdate(scope, {
      ...decl,
      argument: closureEnvNode(scope, decl.argument.name, decl.argument._closureFunc ?? scope.ast)
    }, valueUnused);
  }

  const { name } = decl.argument;
  const [ local, isGlobal ] = lookupName(scope, name);
  if (local != null) {
    // fast path: a local/global. todo: not as compliant as the slow path (non-numbers)
    const ref = isGlobal ? Global(name, globals[name]?.type ?? T.jsval) : Local(name, scope.locals[name]?.type ?? T.jsval);
    // a BigInt steps by 1n: the C runtime's, for a value that may be one
    if (usesBigInt && ref[N_TYPE] === T.jsval && knownType(scope, getNodeType(scope, decl.argument)) !== TYPES.number) {
      const dec = Const(T.i32, decl.operator === '--' ? 1 : 0);
      if (!decl.prefix && !valueUnused) {
        const old = tmp(scope, T.jsval, ref);
        assign(scope, ref, Call('porf_numeric_step', [ old, dec ], T.jsval));
        return old;
      }
      assign(scope, ref, Call('porf_numeric_step', [ ref, dec ], T.jsval));
      return valueUnused ? valUndefined() : ref;
    }
    const inc = v => Bin(decl.operator === '++' ? '+' : '-', T.f64, numValue(v), Const(T.f64, 1));
    const incForRef = v => ref[N_TYPE] === T.jsval ? valNumber(inc(v))
      : ref[N_TYPE] === T.f64 ? inc(v)
      : Convert(ref[N_TYPE], inc(v), ref[N_TYPE] === T.i32 ? CONVERT_SIGNED : 0);
    setType(scope, name, TYPES.number);

    if (!decl.prefix && !valueUnused) {
      const old = tmp(scope, ref[N_TYPE], ref);
      assign(scope, ref, incForRef(old));
      return valNumber(old);
    }

    assign(scope, ref, incForRef(ref));
    return valueUnused ? valUndefined() : valNumber(ref);
  }

  let target = decl.argument;
  if (target.type === 'MemberExpression') {
    target = bindMemberTarget(scope, target, '#update', true);
  }

  // ToNumeric: a Number, or a BigInt when the program has them (ToNumber would throw)
  const tmpName = tmp(scope, usesBigInt ? T.jsval : T.f64)[N_A];
  if (usesBigInt) setLocalWithType(scope, tmpName, false, { type: 'CallExpression', callee: { type: 'Identifier', name: '__ecma262_ToNumeric' }, arguments: [ target ] });
  else {
    addVarMetadata(scope, tmpName, false, { type: TYPES.number });
    setLocalWithType(scope, tmpName, false, { type: 'UnaryExpression', operator: '+', prefix: true, argument: target }, false, TYPES.number);
  }

  const assignNode = {
    type: 'AssignmentExpression',
    operator: '=',
    left: target,
    right: usesBigInt ? {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__Porffor_numericStep' },
      arguments: [ { type: 'Identifier', name: tmpName }, { type: 'Literal', value: decl.operator === '--' ? 1 : 0 } ]
    } : {
      type: 'BinaryExpression',
      operator: decl.operator[0],
      left: { type: 'Identifier', name: tmpName },
      right: { type: 'Literal', value: 1 }
    }
  };

  if (decl.prefix) return generate(scope, assignNode, undefined, valueUnused);
  genStmt(scope, assignNode);
  return valueUnused ? valUndefined() : generate(scope, identNode(tmpName));
};

const inferBranchAssigned = [];
const inferBranchStart = scope => {
  scope.inferTree ??= [ Object.create(null) ];
  inferBranchAssigned.push(new Set());
  scope.inferTree.push(Object.create(null));
};

const inferBranchEnd = scope => {
  const assigned = inferBranchAssigned.pop();
  scope.inferTree.pop();

  for (const name of assigned) {
    for (const tree of scope.inferTree) {
      if (name in tree) tree[name] = null;
    }
  }
};

const inferBranchElse = scope => {
  // todo/opt: at end of else, find inferences in common and keep them?
  inferBranchEnd(scope);
  inferBranchStart(scope);
};

const inferLoopPrev = [];
const inferLoopAssigned = [];
// a loop's body is generated once but runs again after its own writes: what was inferred before
// it holds inside only for a name the loop (its test, update, head and body) never assigns or
// declares. Those carry in, their types and narrowed sets; the rest start unknown
const inferLoopStart = (scope, loop = null) => {
  const prev = scope.inferTree ?? [ Object.create(null) ];
  inferLoopPrev.push(prev);
  inferLoopAssigned.push(new Set());
  const root = Object.create(null);
  const { written, declared, opaque } = loop ? writtenNames(loop) : { opaque: true };
  if (!opaque) {
    const kept = name => !written.has(name) && !declared.has(name);
    for (const frame of prev) {
      for (const name in frame) if (kept(name)) root[name] = frame[name];
      for (const name in frame[TYPE_SETS] ?? {}) if (kept(name)) (root[TYPE_SETS] ??= Object.create(null))[name] = frame[TYPE_SETS][name];
    }
  }
  scope.inferTree = [ root ];
};

const inferLoopEnd = scope => {
  const assigned = inferLoopAssigned.pop();
  scope.inferTree = inferLoopPrev.pop();

  for (const name of assigned) {
    for (const tree of scope.inferTree) {
      if (name in tree) tree[name] = null;
    }
  }
};

// ---- type sets ----
// One of several types, which one not known: above all a string, in either of its two
// representations (string, bytestring). Only what cannot be wrong makes one: an operation
// that always gives a string ('a' + x, a template, String(x), s.slice()), a check that ran
// (typeof x === 'string'), or the never-reassigned local one of those was stored in. An
// annotated `: string` counts only under --opt-types, which trusts every annotation. Given a
// set, a typeSwitch keeps only the cases for its types, and drops its fallback when every
// type in it has a case: a type the set rules out is never reached, so it is never checked.
// Kept apart from getType/getNodeType, whose callers take a type as an exact runtime tag.
const STRING_TYPES = [ TYPES.string, TYPES.bytestring ];
const isStringSet = set => set != null && set.length > 0 && set.every(t => STRING_TYPES.includes(t));
const TYPE_SETS = Symbol('type sets');

// String.prototype methods that return a string whatever the arguments
const STRING_RESULT_METHODS = new Set([ 'charAt', 'concat', 'normalize', 'padEnd', 'padStart', 'repeat',
  'replace', 'replaceAll', 'slice', 'substr', 'substring', 'toLocaleLowerCase', 'toLocaleUpperCase',
  'toLowerCase', 'toString', 'toUpperCase', 'toWellFormed', 'trim', 'trimEnd', 'trimStart', 'valueOf' ]);

/** A set a narrowing wrote for `name` in the frames still open; else null. */
const inferredSet = (scope, name) => {
  for (let i = (scope.inferTree?.length ?? 0) - 1; i >= 0; i--) {
    const set = scope.inferTree[i][TYPE_SETS]?.[name];
    if (set != null) return set;
  }
  return null;
};

/** The types `node` may evaluate to, when that is known to be a few of them; else null. */
const typeSet = (scope, node) => {
  if (node == null) return null;
  const known = knownType(scope, getNodeType(scope, node));
  if (known != null) return [ known ];

  switch (node.type) {
    case 'Identifier': {
      if (!narrowable(scope, node)) return null;
      const metadata = getVarMetadata(scope, node.name);
      return inferredSet(scope, node.name) ?? metadata?.possible ?? metadata?.types ?? null;
    }
    case 'TemplateLiteral':
      return STRING_TYPES;
    case 'BinaryExpression':
      // with a string on either side, + concatenates
      if (node.operator === '+' && (isStringSet(typeSet(scope, node.left)) || isStringSet(typeSet(scope, node.right)))) return STRING_TYPES;
      return null;
    case 'ConditionalExpression': {
      const a = typeSet(scope, node.consequent), b = typeSet(scope, node.alternate);
      return a && b ? [ ...new Set([ ...a, ...b ]) ] : null;
    }
    case 'CallExpression': {
      const { callee } = node;
      if (callee.type === 'Identifier' && callee.name === 'String' && !builtinShadowed(scope, 'String')) return STRING_TYPES;
      if (callee.type === 'MemberExpression' && !callee.computed && !node.optional && !callee.optional) {
        const method = callee.property.name;
        if (STRING_RESULT_METHODS.has(method) && isStringSet(typeSet(scope, callee.object))) return STRING_TYPES;
        if (method === 'join' && knownType(scope, getNodeType(scope, callee.object)) === TYPES.array) return STRING_TYPES;
      }
      return null;
    }
  }
  return null;
};

/** The exact type of `node` if known, else its set: what a typeSwitch over it may take. */
const knownTypeOrSet = (scope, node) => knownType(scope, getNodeType(scope, node)) ?? typeSet(scope, node);

// ---- narrowing ----
// A check the code makes proves something about a variable wherever it holds: in the branch
// it guards (`typeof x === 'number' ? x * 2 : …`), and, when the check leaves the block on
// failure (`if (x === undefined) return;`), in the rest of that block. The proof is the
// check itself, run at runtime, so it needs no type annotation to be sound. It is written
// into the branch's inference frame without counting as an assignment: it lasts as long as
// the branch, and a write in the branch would override it. Only a local nothing reassigns
// is narrowed (the semantic pass counted no writes), so no closure or later statement can
// change it between the check and the use. --no-narrow turns it off.

// what `typeof` answers, per type (the same table the typeof operator switches on)
const TYPEOF_TYPES = {
  number: [ TYPES.number ],
  boolean: [ TYPES.boolean ],
  string: [ TYPES.string, TYPES.bytestring ],
  undefined: [ TYPES.undefined ],
  function: [ TYPES.function ],
  symbol: [ TYPES.symbol ],
  bigint: [ TYPES.bigint ]
};
const TYPEOF_LISTED = Object.values(TYPEOF_TYPES).flat();

/** `typeof arg OP 'name'` (either side), as { arg, name, negated }; else null. */
const typeofComparison = decl => {
  if (decl.type !== 'BinaryExpression' || !EQUALITY_OPS.has(decl.operator)) return null;
  const isTypeof = x => x.type === 'UnaryExpression' && x.operator === 'typeof';
  const isName = x => x.type === 'Literal' && typeof x.value === 'string';
  const [ t, lit ] = isTypeof(decl.left) && isName(decl.right) ? [ decl.left, decl.right ]
    : isTypeof(decl.right) && isName(decl.left) ? [ decl.right, decl.left ] : [ null, null ];
  if (t == null) return null;
  return { arg: t.argument, name: lit.value, negated: decl.operator[0] === '!' };
};
const EQUALITY_OPS = new Set([ '===', '!==', '==', '!=' ]);

/** `x` as `undefined` (or `void 0`), which a guard compares against. */
const isUndefinedNode = x => (x.type === 'Identifier' && x.name === 'undefined') ||
  (x.type === 'UnaryExpression' && x.operator === 'void' && x.argument.type === 'Literal');

/** A local a guard can narrow: read directly, and never written after its declaration. */
const narrowable = (scope, node) => node?.type === 'Identifier' &&
  node.name in scope.locals && scope.locals[node.name].type === T.jsval &&
  !node._closureFunc && !scope.closureOwnLocals?.[node.name] &&
  node._resolvedVariable != null && !node._resolvedVariable.node?._writes;

/**
 * What `test` evaluating to `sense` proves: a list of { name, keep } (the variable is one of
 * these types) or { name, drop } (it is none of them).
 */
const guardFacts = (scope, test, sense) => {
  if (!Prefs.narrow || test == null) return [];

  switch (test.type) {
    case 'UnaryExpression':
      if (test.operator === '!') return guardFacts(scope, test.argument, !sense);
      break;

    case 'LogicalExpression':
      // both held for && to be true, and both failed for || to be false
      if ((test.operator === '&&' && sense) || (test.operator === '||' && !sense))
        return [ ...guardFacts(scope, test.left, sense), ...guardFacts(scope, test.right, sense) ];
      break;

    // truthy: at least not undefined (null shares the object type, so it cannot be dropped)
    case 'Identifier':
      if (sense && narrowable(scope, test)) return [ { name: test.name, drop: [ TYPES.undefined ] } ];
      break;

    case 'CallExpression': {
      const { callee } = test;
      if (callee.type === 'MemberExpression' && !callee.computed && callee.object.name === 'Array' &&
          callee.property.name === 'isArray' && !builtinShadowed(scope, 'Array') && narrowable(scope, test.arguments[0])) {
        const name = test.arguments[0].name;
        return [ sense ? { name, keep: [ TYPES.array ] } : { name, drop: [ TYPES.array ] } ];
      }
      break;
    }

    case 'BinaryExpression': {
      if (!EQUALITY_OPS.has(test.operator)) break;
      const holds = (test.operator[0] !== '!') === sense;

      const t = typeofComparison(test);
      if (t != null) {
        const types = TYPEOF_TYPES[t.name];
        if (types == null || !narrowable(scope, t.arg)) break;
        return [ holds ? { name: t.arg.name, keep: types } : { name: t.arg.name, drop: types } ];
      }

      const subject = isUndefinedNode(test.right) ? test.left : isUndefinedNode(test.left) ? test.right : null;
      if (subject == null || !narrowable(scope, subject)) break;
      // x === undefined is exactly undefined; x == undefined may also be null
      if (test.operator.length === 3) return [ holds ? { name: subject.name, keep: [ TYPES.undefined ] } : { name: subject.name, drop: [ TYPES.undefined ] } ];
      if (!holds) return [ { name: subject.name, drop: [ TYPES.undefined ] } ];
      break;
    }
  }

  return [];
};

/** The types a local may hold, as far as they are known; else null. */
const possibleTypes = (scope, name) => {
  const set = inferredSet(scope, name);
  if (set) return set;
  const metadata = getVarMetadata(scope, name);
  if (metadata?.types) return metadata.types;
  if (metadata?.possible) return metadata.possible;
  const known = getType(scope, name);
  return known == null ? null : [ known ];
};

/** Writes what `facts` prove into the current inference frame, where it comes to one type. */
const narrow = (scope, facts) => {
  for (const fact of facts) {
    const types = fact.keep ?? possibleTypes(scope, fact.name)?.filter(t => !fact.drop.includes(t));
    if (!types?.length) continue;
    scope.inferTree ??= [ Object.create(null) ];
    const frame = scope.inferTree.at(-1);
    for (const t of types) typeUsed(scope, t);
    if (types.length === 1) frame[fact.name] = types[0];
    // several: one of them (typeof x === 'string' leaves two representations)
    else (frame[TYPE_SETS] ??= Object.create(null))[fact.name] = types;
  }
};

/** A statement that never completes normally: it returns, throws, breaks or continues. */
const alwaysExits = node => {
  if (node == null) return false;
  switch (node.type) {
    case 'ReturnStatement': case 'ThrowStatement': case 'BreakStatement': case 'ContinueStatement':
      return true;
    case 'BlockStatement': {
      const body = node.body.filter(x => !isEmptyNode(x));
      return body.length > 0 && alwaysExits(body.at(-1));
    }
    case 'IfStatement':
      return alwaysExits(node.consequent) && alwaysExits(node.alternate);
  }
  return false;
};

const generateLoopBinding = (scope, left, valNode) => {
  if (left.type === 'Identifier') generateVarDstr(scope, 'var', left, valNode, undefined, true);
  else if (left.type === 'VariableDeclaration') generateVarDstr(scope, left.kind, left.declarations[0]?.id ?? left, valNode, undefined, scope.topLevel);
  else generatePatternAssign(scope, left, valNode);
};

const getComptimeFlag = (scope, node) => {
  if (!globalThis.precompile || node?.type !== 'TaggedTemplateExpression') return null;

  if (node.tag.name !== '__Porffor_comptime_flag') return null;

  const { quasis, expressions } = node.quasi;
  let out = quasis[0].value.raw;
  for (let i = 0; i < expressions.length; i++) {
    const value = knownValue(scope, expressions[i]);
    if (value === unknownValue) return null;
    out += value + quasis[i + 1].value.raw;
  }

  return out;
};

const generateIf = (scope, decl) => {
  const comptimeFlag = getComptimeFlag(scope, decl.test);
  if (comptimeFlag) {
    const [ kind, value ] = comptimeFlag.split('.');

    inferBranchStart(scope);
    const then = collect(scope, () => genStmt(scope, decl.consequent));
    let els = [];
    if (decl.alternate) {
      inferBranchElse(scope);
      els = collect(scope, () => genStmt(scope, decl.alternate));
      inferBranchEnd(scope);
    } else inferBranchEnd(scope);

    stmt(scope, { __porfComptimeFlag: [ kind, kind === 'hasType' ? TYPES[value] : value, then, els ] });
    return valUndefined();
  }

  const cond = truthy(scope, generate(scope, decl.test), getNodeType(scope, decl.test));

  inferBranchStart(scope);
  narrow(scope, guardFacts(scope, decl.test, true));
  const then = collect(scope, () => genStmt(scope, decl.consequent));
  let els = null;
  if (decl.alternate) {
    inferBranchElse(scope);
    narrow(scope, guardFacts(scope, decl.test, false));
    els = collect(scope, () => genStmt(scope, decl.alternate));
    inferBranchEnd(scope);
  } else inferBranchEnd(scope);

  stmt(scope, If(cond, then, els));
  return valUndefined();
};

const generateConditional = (scope, decl) => {
  const cond = truthy(scope, generate(scope, decl.test), getNodeType(scope, decl.test));
  const resType = getNodeType(scope, decl) === TYPES.number ? T.f64 : T.jsval;
  const res = tmp(scope, resType);

  inferBranchStart(scope);
  narrow(scope, guardFacts(scope, decl.test, true));
  const then = collect(scope, () => assign(scope, res, coerceValue(generate(scope, decl.consequent), resType)));
  inferBranchElse(scope);
  narrow(scope, guardFacts(scope, decl.test, false));
  const els = collect(scope, () => assign(scope, res, coerceValue(generate(scope, decl.alternate), resType)));
  inferBranchEnd(scope);

  stmt(scope, If(cond, then, els));
  return resType === T.f64 ? valNumber(res) : res;
};

const CLAUSE_UNSAFE = new Set([ K.Block, K.If, K.Loop, K.Switch, K.TypeSwitch, K.Try, K.Return,
  K.Break, K.Continue, K.Throw, K.ThrowNew, K.Unreachable ]);

const genLoop = (scope, decl, type) => {
  if (type === 'for' && decl.init) genStmt(scope, decl.init);

  let cond = null;
  const condStmts = [];
  if (decl.test) {
    scope.blockStack.push(condStmts);
    try { cond = truthy(scope, generate(scope, decl.test), getNodeType(scope, decl.test)); }
    finally { scope.blockStack.pop(); }
  }

  const updateStmts = type === 'for' ? collect(scope, () => {
    copyLoopBindingBoxes(scope, decl.init);
    if (decl.update) genStmt(scope, decl.update);
  }) : [];
  const testInBody = condStmts.length > 0 || type === 'dowhile';
  // the for (;; update) clause takes one expression: a statement (an optional chain's
  // labelled block, an if) runs at the end of the body instead
  const updateInClause = type === 'for' && (updateStmts.length === 0 ||
    (updateStmts.length === 1 && !CLAUSE_UNSAFE.has(updateStmts[0][N_KIND])));
  const bodyUpdate = type === 'for' && !updateInClause;

  const L = fresh(scope);
  const C = bodyUpdate || type === 'dowhile' ? fresh(scope) : null;
  const d = { type, brk: L, cont: C ?? L, contViaBreak: C != null };
  consumePendingLabels(scope, d);
  depth.push(d);
  inferLoopStart(scope, decl);

  const testBreak = () => {
    for (const s of condStmts) stmt(scope, s);
    emitIf(scope, Un('!', T.i32, cond), () => stmt(scope, Break(L)));
  };
  const userBody = () => C != null
    ? stmt(scope, BlockStmt(collect(scope, () => genStmt(scope, decl.body)), C))
    : genStmt(scope, decl.body);

  const body = collect(scope, () => {
    if (type === 'dowhile') {
      userBody();
      testBreak();
    } else {
      if (testInBody) testBreak();
      userBody();
      if (bodyUpdate) for (const s of updateStmts) stmt(scope, s);
    }
  });

  inferLoopEnd(scope);
  depth.pop();
  stmt(scope, Loop(testInBody ? null : cond, updateInClause ? (updateStmts[0] ?? null) : null, body, L));
  return valUndefined();
};

// top-level await: synchronously drain promise jobs as there is no coroutine to suspend
const awaitValue = (scope, value) => {
  if (scope.topLevel) return builtinCall(scope, '__Porffor_promise_awaitSync', [ value ]);
  scope.hasAwait = true;
  return Await(value);
};

// Array.prototype methods that change this, and those that return it (#this guard)
// the Array.prototype methods with a version of their own for a receiver that is no array
const ARRAY_GENERIC = new Set([ 'forEach', 'map', 'filter', 'some', 'every', 'reduce', 'reduceRight',
  'find', 'findIndex', 'findLast', 'findLastIndex', 'indexOf', 'lastIndexOf', 'includes', 'concat', 'slice', 'splice' ]);
const ARRAY_MUTATORS = new Set([ 'push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort', 'fill', 'copyWithin' ]);
const ARRAY_RETURNS_THIS = new Set([ 'reverse', 'sort', 'fill', 'copyWithin' ]);

// types for...of iterates without the iterator protocol (its fast paths below)
const FAST_ITERABLES = new Set([
  TYPES.array, TYPES.string, TYPES.bytestring, TYPES.set, TYPES.map,
  TYPES.__porffor_generator, TYPES.__porffor_asyncgenerator,
  TYPES.uint8array, TYPES.int8array, TYPES.uint8clampedarray, TYPES.uint16array, TYPES.int16array,
  TYPES.uint32array, TYPES.int32array, TYPES.float16array, TYPES.float32array, TYPES.float64array,
  TYPES.bigint64array, TYPES.biguint64array
]);

// for...of: the fast paths for built-in iterables, and the iterator protocol for the rest.
// A loop that may take the protocol runs inside a try whose finally closes the iterator
// (IteratorClose), so leaving it early by break, return or a throw calls its return().
const generateForOf = (scope, decl) => {
  if (decl._porfCore) return generateForOfCore(scope, decl);
  const known = knownType(scope, getNodeType(scope, decl.right));
  // for await over a sync generator: a value that rejects closes it (AsyncFromSyncIterator's
  // closeOnRejection), which the protocol's try does and the fast path does not
  if (known != null && FAST_ITERABLES.has(known) && !(decl.await && known === TYPES.__porffor_generator)) return generateForOfCore(scope, decl);
  // for await over anything else that may be a sync generator: the protocol, in every program
  if (decl.await && (known == null || known === TYPES.__porffor_generator)) return generateForOfProtocol(scope, decl);

  // a builtin's loop serves every program: both versions, chosen when it is linked into one
  if (globalThis.precompile) {
    const labels = pendingLabels.slice();
    const full = collect(scope, () => generateForOfProtocol(scope, decl));
    pendingLabels = labels;
    const plain = collect(scope, () => generateForOfCore(scope, { ...decl, _porfCore: true, _builtinOnly: true }));
    stmt(scope, { __porfComptimeFlag: [ 'program', 'usesIterProtocol', full, plain ] });
    return valUndefined();
  }

  // a program that cannot make its own iterators: built-in iterables only, no try/finally
  if (!usesIterProtocol) return generateForOfCore(scope, { ...decl, _porfCore: true, _builtinOnly: true });
  return generateForOfProtocol(scope, decl);
};

const generateForOfProtocol = (scope, decl) => {
  const rec = '#iter_rec' + uniqId(scope);
  allocVar(scope, rec);
  assign(scope, Local(rec, T.jsval), valUndefined());
  const close = {
    type: 'CallExpression',
    callee: identNode(decl.await ? '__Porffor_iter_closeAsync' : '__Porffor_iter_close'),
    arguments: [ identNode(rec) ]
  };
  return generateTry(scope, {
    type: 'TryStatement',
    block: { type: 'BlockStatement', body: [ { ...decl, _porfCore: true, _iterRec: rec } ] },
    handler: null,
    finalizer: {
      type: 'BlockStatement',
      body: [ { type: 'ExpressionStatement', expression: decl.await ? { type: 'AwaitExpression', argument: close } : close } ]
    }
  });
};

const generateForOfCore = (scope, decl) => {
  const rootKnown = knownType(scope, getNodeType(scope, decl.right));
  let rootValue = coerceValue(generate(scope, decl.right), T.jsval);
  // --ropes: a string is read character by character below, so a rope is flattened first
  if (Prefs.ropes && (rootKnown == null || knownStr(rootKnown))) rootValue = builtinCall(scope, '__Porffor_string_flat', [ rootValue ]);
  const root = tmp(scope, T.jsval, rootValue);
  const rootTy = reuse(scope, JvType(root));
  const isAwait = decl.await === true;

  const recName = decl._iterRec;
  // with the protocol, anything else is opened as an iterator (which throws when it is not one)
  if (recName == null && !decl._builtinOnly) emitIf(scope, Un('!', T.i32, isAwait ? Bin('|', T.i32, typeIsIterable(rootTy), typeIsAsyncIterable(rootTy)) : typeIsIterable(rootTy)),
    () => internalThrow(scope, 'TypeError', isAwait ? 'Tried for await..of on non-iterable type' : 'Tried for..of on non-iterable type'));

  if (decl.left.type === 'Identifier' && !isIdentAssignable(scope, decl.left.name))
    return internalThrow(scope, 'ReferenceError', `${decl.left.name} is not defined`);

  const counter = tmp(scope, T.i32);
  const pointer = tmp(scope, T.u32);
  const length = tmp(scope, T.i32);
  assign(scope, counter, Const(T.i32, 0));

  assign(scope, pointer, JvPtr(root));
  assign(scope, length, LenGet(pointer));

  const L = fresh(scope);
  // a generator stepped on the fast path is closed (return(), its finally blocks run) when a
  // break or return leaves the loop early: closeLoops. genOpen: 1 a generator is open, 2 an
  // async generator (closed through its driver, awaited). A throw leaves it open: only the
  // protocol's try (recName) closes on that, with the generator in the loop's record
  const mayBeGenerator = rootKnown == null || rootKnown === TYPES.__porffor_generator || rootKnown === TYPES.__porffor_asyncgenerator;
  const d = { type: 'forof', brk: L, cont: L, contViaBreak: false, scope,
    genOpen: recName == null && mayBeGenerator ? tmp(scope, T.i32, Const(T.i32, 0)) : null,
    close: () => {
      emitIf(scope, Bin('==', T.i32, d.genOpen, Const(T.i32, 1)), () => {
        assign(scope, d.genOpen, Const(T.i32, 0));
        exprStmt(scope, Call('__Porffor_coroutine_resume', [ root, valUndefined(), Const(T.i32, 2) ], T.i32));
      });
      if (isAwait) emitIf(scope, Bin('==', T.i32, d.genOpen, Const(T.i32, 2)), () => {
        assign(scope, d.genOpen, Const(T.i32, 0));
        exprStmt(scope, awaitValue(scope, builtinCall(scope, '__Porffor_AsyncGenerator_advance', [ root, valUndefined(), Const(T.i32, 2) ])));
      });
    } };
  consumePendingLabels(scope, d);

  // after a generator's step (kind 1, or 2 async): finished, the loop ends; otherwise it is
  // open until the next step, for a close if the loop is left early
  const generatorStepped = (done, kind) => {
    const rec = recName == null ? null : Local(recName, T.jsval);
    emitIf(scope, done, () => {
      if (rec) assign(scope, rec, valUndefined());
      else if (d.genOpen) assign(scope, d.genOpen, Const(T.i32, 0));
      stmt(scope, Break(L));
    });
    if (rec) emitIf(scope, Bin('==', T.i32, JvType(rec), Const(T.i32, TYPES.undefined)),
      () => assign(scope, rec, builtinCall(scope, '__Porffor_iter_generatorRecord', [ root ])));
    else if (d.genOpen) assign(scope, d.genOpen, Const(T.i32, kind));
    return Call('__Porffor_coroutine_value', [ root ]);
  };
  depth.push(d);
  inferLoopStart(scope, decl);

  const num = x => Box(Convert(T.f64, x), Const(T.i32, TYPES.number));
  const taNext = (ctype, size, box) => () => {
    emitIf(scope, Bin('==', T.i32, counter, length), () => stmt(scope, Break(L)));
    const addr = reuse(scope, Bin('+', T.u32, Load('u32', pointer, 4),
      size === 1 ? counter : Bin('*', T.u32, counter, Const(T.u32, size))));
    const v = reuse(scope, box(Load(ctype, addr, 4)));
    assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
    return v;
  };
  const strNext = (ctype, size, strType) => () => {
    emitIf(scope, Bin('==', T.i32, counter, length), () => stmt(scope, Break(L)));
    if (size === 1) {
      const code = reuse(scope, Load('u8', Bin('+', T.u32, Bin('+', T.u32, JvPtr(root), Const(T.u32, 4)), counter), 0));
      assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
      return oneCharString(scope, code);
    }
    const out = reuse(scope, Alloc(Const(T.i32, 8), strType));
    stmt(scope, Store('u32', out, 0, Const(T.u32, 1)));
    const src = Bin('+', T.u32, Bin('+', T.u32, JvPtr(root), Const(T.u32, 4)),
      size === 1 ? counter : Bin('*', T.u32, counter, Const(T.u32, size)));
    stmt(scope, Store(ctype, out, 4, Load(ctype, src, 0)));
    assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
    return valOf(out, strType);
  };
  const skipTombstones = (count, entries) => {
    const sk = fresh(scope);
    stmt(scope, Loop(Bin('<', T.u32, counter, count), null, [
      If(Bin('!=', T.u64, Load('u64', Bin('+', T.u32, entries, Bin('*', T.u32, counter, Const(T.u32, 8))), 0), Const(T.u64, -1)), [ Break(sk) ], null),
      Assign(counter, Bin('+', T.i32, counter, Const(T.i32, 1)))
    ], sk));
  };

  const valName = tmp(scope, T.jsval)[N_A];
  const body = collect(scope, () => {
    const nextVal = typeSwitch(scope, root, rootKnown, [
      [ [ TYPES.array ], () => {
        emitIf(scope, Bin('>=', T.i32, counter, LenGet(pointer)), () => stmt(scope, Break(L)));
        const v = reuse(scope, arrGet(scope, pointer, counter));
        assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
        return v;
      } ],

      [ TYPES.__porffor_generator, () => {
        // with the protocol, the generator is in the loop's record from its first step, so
        // leaving the loop early closes it (return(), running its finally blocks); finished,
        // it leaves the record again
        const done = reuse(scope, Call('__Porffor_coroutine_resume', [ root, valUndefined(), Const(T.i32, 0) ], T.i32));
        return generatorStepped(done, 1);
      } ],

      [ TYPES.__porffor_asyncgenerator, () => {
        if (!isAwait) { stmt(scope, Unreachable()); return valUndefined(); }
        // runs the generator through its own awaits to the next yield (or its end)
        const done = reuse(scope, truthy(scope, awaitValue(scope,
          builtinCall(scope, '__Porffor_AsyncGenerator_advance', [ root, valUndefined(), Const(T.i32, 0) ]))));
        return generatorStepped(done, 2);
      } ],

      // by code point: a surrogate pair is one character
      [ TYPES.string, () => {
        emitIf(scope, Bin('==', T.i32, counter, length), () => stmt(scope, Break(L)));
        const ch = reuse(scope, builtinCall(scope, '__Porffor_string_iterAt', [ root, counter ]));
        assign(scope, counter, Bin('+', T.i32, counter, LenGet(JvPtr(ch))));
        return ch;
      } ],
      [ TYPES.bytestring, strNext('u8', 1, TYPES.bytestring) ],

      [ [ TYPES.uint8array, TYPES.uint8clampedarray ], taNext('u8', 1, num) ],
      [ TYPES.int8array, taNext('i8', 1, num) ],
      [ TYPES.uint16array, taNext('u16', 2, num) ],
      [ TYPES.int16array, taNext('i16', 2, num) ],
      [ TYPES.uint32array, taNext('u32', 4, num) ],
      [ TYPES.int32array, taNext('i32', 4, num) ],
      [ TYPES.float16array, taNext('f16', 2, num) ],
      [ TYPES.float32array, taNext('f32', 4, num) ],
      [ TYPES.float64array, taNext('f64', 8, x => Box(x, Const(T.i32, TYPES.number))) ],
      [ TYPES.bigint64array, taNext('i64', 8, x => Box(builtinCall(scope, '__Porffor_bigint_fromS64', [ x ]), Const(T.i32, TYPES.bigint))) ],
      [ TYPES.biguint64array, taNext('i64', 8, x => Box(builtinCall(scope, '__Porffor_bigint_fromU64', [ x ]), Const(T.i32, TYPES.bigint))) ],

      [ TYPES.set, () => {
        const count = reuse(scope, Load('u32', length, 0));
        const entries = reuse(scope, Load('u32', length, 4));
        skipTombstones(count, entries);
        emitIf(scope, Bin('==', T.i32, counter, count), () => stmt(scope, Break(L)));
        const v = reuse(scope, Load('jsval', Bin('+', T.u32, entries, Bin('*', T.u32, counter, Const(T.u32, 8))), 0));
        assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
        return v;
      } ],

      [ TYPES.map, () => {
        const count = reuse(scope, Load('u32', length, 0));
        const keysEnt = reuse(scope, Load('u32', length, 4));
        const valsEnt = reuse(scope, Load('u32', Load('u32', pointer, 4), 4));
        skipTombstones(count, keysEnt);
        emitIf(scope, Bin('==', T.i32, counter, count), () => stmt(scope, Break(L)));
        const off = Bin('*', T.u32, counter, Const(T.u32, 8));
        const kName = tmp(scope, T.jsval)[N_A], vName = tmp(scope, T.jsval)[N_A];
        setLocalWithType(scope, kName, false, Load('jsval', Bin('+', T.u32, keysEnt, off), 0));
        setLocalWithType(scope, vName, false, Load('jsval', Bin('+', T.u32, valsEnt, off), 0));
        assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
        return generate(scope, { type: 'ArrayExpression', elements: [ { type: 'Identifier', name: kName }, { type: 'Identifier', name: vName } ] });
      } ],

      // anything else: the iterator protocol (opened on the first step)
      [ 'default', () => {
        // built-in iterables only: a built-in iterator object (arr.keys() …), stepped directly
        if (decl._builtinOnly) {
          const v = reuse(scope, builtinCall(scope, '__Porffor_iter_stepBuiltinOnly', [ root ]));
          emitIf(scope, truthy(scope, builtinCall(scope, '__Porffor_iter_builtinDone', [ root ])), () => stmt(scope, Break(L)));
          return isAwait ? awaitValue(scope, v) : v;
        }
        if (recName == null) { stmt(scope, Unreachable()); return valUndefined(); }
        const rec = Local(recName, T.jsval);
        emitIf(scope, Bin('==', T.i32, JvType(rec), Const(T.i32, TYPES.undefined)),
          () => assign(scope, rec, builtinCall(scope, isAwait ? '__Porffor_iter_openAsync' : '__Porffor_iter_open', [ root ])));
        const v = reuse(scope, isAwait
          ? awaitValue(scope, builtinCall(scope, '__Porffor_iter_stepAsync', [ rec ]))
          : builtinCall(scope, '__Porffor_iter_step', [ rec ]));
        emitIf(scope, truthy(scope, builtinCall(scope, '__Porffor_iter_isDone', [ rec ])), () => stmt(scope, Break(L)));
        return v;
      } ]
    ]);

    setLocalWithType(scope, valName, false, isAwait ? awaitValue(scope, nextVal) : nextVal);
    generateLoopBinding(scope, decl.left, identNode(valName));
    genStmt(scope, decl.body);
  });

  inferLoopEnd(scope);
  depth.pop();
  stmt(scope, Loop(null, null, body, L));
  return valUndefined();
};

const generateForIn = (scope, decl) => {
  const objName = tmp(scope, T.jsval)[N_A];
  setLocalWithType(scope, objName, false, decl.right);

  if (decl.left.type === 'Identifier' && !isIdentAssignable(scope, decl.left.name))
    return internalThrow(scope, 'ReferenceError', `${decl.left.name} is not defined`);

  const objKnown = knownType(scope, getNodeType(scope, decl.right));
  return typeSwitch(scope, Local(objName, T.jsval), objKnown, {
    [TYPES.object]: () => {
      const counter = tmp(scope, T.i32);
      const pointer = tmp(scope, T.u32);
      const length = tmp(scope, T.i32);
      const objPtr = reuse(scope, JvPtr(Local(objName, T.jsval)));
      assign(scope, counter, Const(T.i32, 0));
      assign(scope, length, Load('u16', objPtr, 0));
      assign(scope, pointer, Load('u32', objPtr, 12));

      const L = fresh(scope), C = fresh(scope);
      const d = { type: 'forin', brk: L, cont: C, contViaBreak: true };
      consumePendingLabels(scope, d);
      depth.push(d);
      inferLoopStart(scope, decl);

      const tmpName = tmp(scope, T.jsval)[N_A];
      const body = collect(scope, () => {
        stmt(scope, BlockStmt(collect(scope, () => {
          setLocalWithType(scope, tmpName, false, Box(Load('u32', pointer, 4), Load('u8', pointer, 18)));
          generateLoopBinding(scope, decl.left, identNode(tmpName));
          emitIf(scope, Bin('&', T.i32,
            Bin('!=', T.i32, Bin('&', T.i32, Load('u16', pointer, 16), Const(T.i32, 0b0100)), Const(T.i32, 0)),
            Bin('!=', T.i32, Load('u8', pointer, 18), Const(T.i32, TYPES.symbol))),
            () => genStmt(scope, decl.body));
        }), C));
        assign(scope, counter, Bin('+', T.i32, counter, Const(T.i32, 1)));
        assign(scope, pointer, Bin('+', T.u32, pointer, Const(T.u32, 20)));
      });

      inferLoopEnd(scope);
      depth.pop();
      stmt(scope, Loop(Bin('!=', T.i32, counter, length), null, body, L));
      return valUndefined();
    },

    // wrap as for..of Object.keys(obj ?? 0); a statement, so the case's value is undefined
    default: () => {
      generate(scope, {
        type: 'ForOfStatement',
        left: decl.left,
        body: decl.body,
        right: {
          type: 'CallExpression',
          callee: { type: 'Identifier', name: '__Object_keys' },
          arguments: [ { type: 'LogicalExpression', left: { type: 'Identifier', name: objName }, operator: '??', right: { type: 'Literal', value: 0 } } ]
        }
      });
      return valUndefined();
    }
  });
};

const generateSwitch = (scope, decl) => {
  // fast path: switch (Porffor.type(x)) over type literals -> a typeSwitch
  if (decl.discriminant.type === 'CallExpression' && decl.discriminant.callee.type === 'Identifier' && decl.discriminant.callee.name === '__Porffor_type') {
    const cases = [];
    let canTypeCheck = true;
    for (const x of decl.cases) {
      let type;
      if (!x.test) type = 'default';
      else if (x.test.type === 'Literal') type = x.test.value;
      else if (x.test.type === 'Identifier' && x.test.name.startsWith('__Porffor_TYPES_')) type = TYPES[x.test.name.slice('__Porffor_TYPES_'.length)];
      if (type !== undefined) cases.push([ type, x.consequent ]);
      else { canTypeCheck = false; break; }
    }

    if (canTypeCheck) {
      const xv = reuse(scope, generate(scope, decl.discriminant.arguments[0]));
      const xKnown = knownType(scope, getNodeType(scope, decl.discriminant.arguments[0]));
      const dd = { type: 'switch_typeswitch', brk: null, cont: null };
      consumePendingLabels(scope, dd);
      depth.push(dd);
      typeSwitch(scope, xv, xKnown, () => {
        const bc = [];
        let types = [];
        for (const [ type, consequent ] of cases) {
          types.push(type);
          if (consequent.length !== 0) {
            const ts = types;
            bc.push([ ts.includes('default') ? 'default' : ts, () => { genStmt(scope, { type: 'BlockStatement', body: consequent }); return valUndefined(); } ]);
            types = [];
          }
        }
        return bc;
      });
      depth.pop();
      return valUndefined();
    }
  }

  const discName = '#switch' + uniqId(scope);
  allocVar(scope, discName, false);
  setLocalWithType(scope, discName, false, decl.discriminant);

  const cases = decl.cases.slice();
  const defIdx = cases.findIndex(x => x.test == null);
  if (defIdx !== -1) cases.push(cases.splice(defIdx, 1)[0]);
  else cases.push({ test: null, consequent: [] });
  const N = cases.length;

  const switchL = fresh(scope);
  const dd = { type: 'switch', brk: switchL, cont: null };
  consumePendingLabels(scope, dd);
  depth.push(dd);

  const labels = cases.map(() => fresh(scope));

  // --switch-hash: with string cases, the discriminant is hashed once (as a property key
  // is) and a string case compares its hash, known now, before comparing the strings: a
  // case that does not match costs an integer compare, not a string compare
  const hashCase = x => Prefs.switchHash && x.test?.type === 'Literal' && typeof x.test.value === 'string' && byteStringable(x.test.value);
  let discHash = null;

  const comparisons = collect(scope, () => {
    if (cases.filter(hashCase).length >= 2) {
      const disc = generate(scope, { type: 'Identifier', name: discName });
      const t = reuse(scope, JvType(disc));
      discHash = tmp(scope, T.i32, Const(T.i32, 0));
      emitIf(scope, Bin('==', T.i32, Bin('|', T.i32, t, Const(T.i32, 0x80)), Const(T.i32, TYPES.bytestring)),
        () => assign(scope, discHash, builtinCall(scope, '__Porffor_object_hash', [ generate(scope, { type: 'Identifier', name: discName }) ])));
    }
    for (let i = 0; i < N; i++) {
      if (cases[i].test && discHash && hashCase(cases[i])) {
        emitIf(scope, Bin('==', T.i32, discHash, Const(T.i32, hashString(cases[i].test.value))),
          () => emitIf(scope, JvTruthy(generate(scope, { type: 'BinaryExpression', operator: '===', left: { type: 'Identifier', name: discName }, right: cases[i].test })),
            () => stmt(scope, Break(labels[N - 1 - i]))));
      } else if (cases[i].test) {
        emitIf(scope, JvTruthy(generate(scope, { type: 'BinaryExpression', operator: '===', left: { type: 'Identifier', name: discName }, right: cases[i].test })),
          () => stmt(scope, Break(labels[N - 1 - i])));
      } else {
        stmt(scope, Break(labels[N - 1 - i])); // default
      }
    }
  });

  let cur = BlockStmt(comparisons, labels[N - 1]);
  for (let j = 1; j < N; j++) {
    const caseBody = collect(scope, () => genStmt(scope, { type: 'BlockStatement', body: cases[j - 1].consequent }));
    cur = BlockStmt([ cur, ...caseBody ], labels[N - 1 - j]);
  }
  const lastBody = collect(scope, () => genStmt(scope, { type: 'BlockStatement', body: cases[N - 1].consequent }));

  depth.pop();
  stmt(scope, BlockStmt([ cur, ...lastBody ], switchL));
  return valUndefined();
};

const LOOP_TYPES = [ 'while', 'dowhile', 'for', 'forof', 'forin' ];
const getNearestLoop = (types = [ ...LOOP_TYPES, 'switch', 'switch_typeswitch' ]) => {
  for (let i = depth.length - 1; i >= 0; i--) {
    if (types.includes(depth[i].type)) return depth[i];
  }

  return null;
};

let pendingLabels = [];
const consumePendingLabels = (scope, d) => {
  if (pendingLabels.length === 0) return;
  scope.labels ??= new Map();
  for (const name of pendingLabels) scope.labels.set(name, d);
  pendingLabels = [];
};

// the for...of loops of this function a jump leaves (to target: from the innermost out, the
// target too when it is left), each closing a generator it still has open
const closeLoops = (scope, target, leavesTarget) => {
  const stop = target == null ? 0 : depth.indexOf(target) + (leavesTarget ? 0 : 1);
  for (let i = depth.length - 1; i >= stop && i >= 0; i--)
    if (depth[i].genOpen && depth[i].scope === scope) depth[i].close();
};

const generateBreak = (scope, decl) => {
  const target = decl.label ? scope.labels.get(decl.label.name) : getNearestLoop();
  const fin = finallyCrossing(scope, target);
  if (fin) {
    finallyExit(scope, fin, fin.exits.push(() => generateBreak(scope, decl)));
    return valUndefined();
  }
  closeLoops(scope, target, true);
  stmt(scope, Break(target.brk));
  return valUndefined();
};

const generateContinue = (scope, decl) => {
  const target = decl.label ? scope.labels.get(decl.label.name) : getNearestLoop(LOOP_TYPES);
  const fin = finallyCrossing(scope, target);
  if (fin) {
    finallyExit(scope, fin, fin.exits.push(() => generateContinue(scope, decl)));
    return valUndefined();
  }
  closeLoops(scope, target, false);
  stmt(scope, target.contViaBreak ? Break(target.cont) : Continue(target.cont));
  return valUndefined();
};

const LOOP_STMTS = [ 'ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForOfStatement', 'ForInStatement' ];
const generateLabel = (scope, decl) => {
  const name = decl.label.name;

  if (LOOP_STMTS.includes(decl.body.type)) {
    pendingLabels.push(name);
    return generate(scope, decl.body);
  }

  const brk = fresh(scope);
  const d = { type: 'label', brk, cont: null };
  (scope.labels ??= new Map()).set(name, d);
  depth.push(d);
  const body = collect(scope, () => genStmt(scope, decl.body));
  depth.pop();
  stmt(scope, BlockStmt(body, brk));
  return valUndefined();
};

const generateThrow = (scope, decl) => {
  // precompile: `throw new SomeError('literal')` lowers to a pattern throw (no error object), same shape as ThrowNew
  if (globalThis.precompile && decl.argument.callee != null) {
    let constructor = decl.argument.callee.name;
    if (constructor && constructor.startsWith('__')) constructor = constructor.split('_').pop();

    const arg = decl.argument.arguments[0];
    if (constructor && (arg == null || arg.value != null)) {
      const message = arg == null ? '' : String(arg.value);
      const msg = message
        ? dataRef(unitOf(scope), `#msg:${message}`, [ ...i32Bytes(message.length), ...[...message].map(c => c.charCodeAt(0) & 0xff) ])
        : Const(T.u32, 0);
      stmt(scope, ThrowNew(TYPES[constructor.toLowerCase()] ?? TYPES.error, msg));
      return;
    }
  }

  stmt(scope, Throw(generate(scope, decl.argument)));
};

// exits inside a try with a finalizer record themselves in #fin_pend and jump to the finalizer, which then completes them
// #fin_pend is 0 for normal completion, else 1 + index into fin.exits
const FIN_THROW = 1, FIN_RETURN = 2;
const finallyCrossing = (scope, target) => {
  const fin = scope.finallyStack?.[scope.finallyStack.length - 1];
  return fin && depth.indexOf(target) < fin.depthIndex ? fin : null;
};
const finallyExit = (scope, fin, kind) => {
  fin.taken.add(kind);
  assign(scope, Local(fin.pend, T.i32), Const(T.i32, kind));
  stmt(scope, Break(fin.brk));
};

const generateTry = (scope, decl) => {
  const fin = decl.finalizer ? finallyStart(scope) : null;
  const tryBody = collect(scope, () => genStmt(scope, decl.block));

  let protectedStmts;
  if (decl.handler) {
    const tmpName = '#catch_tmp' + (scope.catchId = (scope.catchId ?? 0) + 1);
    allocVar(scope, tmpName);
    const param = decl.handler.param;
    const catchBody = collect(scope, () => {
      if (scope.generator) emitIf(scope, Bin('==', T.jsval, Local(tmpName, T.jsval), coroReturnSignal()),
        () => stmt(scope, Throw(Local(tmpName, T.jsval))));
      if (param) generateVarDstr(scope, 'let', param, { type: 'Identifier', name: tmpName }, undefined, false);
      genStmt(scope, decl.handler.body);
    });
    protectedStmts = [ Try(tryBody, tmpName, catchBody) ];
  } else protectedStmts = tryBody;

  if (!fin) {
    for (const s of protectedStmts) stmt(scope, s);
    return;
  }

  finallyEnd(scope, fin, protectedStmts, () => genStmt(scope, decl.finalizer));
};

// exits generated between finallyStart and finallyEnd run the finalizer first
const finallyStart = scope => {
  const id = scope.catchId = (scope.catchId ?? 0) + 1;
  const fin = { brk: fresh(scope), pend: '#fin_pend' + id, val: '#fin_val' + id, catchName: '#catch_tmp' + id, depthIndex: depth.length, taken: new Set() };
  fin.exits = [
    () => stmt(scope, Throw(Local(fin.val, T.jsval))),
    () => generateReturn(scope, { type: 'ReturnStatement', argument: scope.retType === T.none ? null : identNode(fin.val) })
  ];
  allocVar(scope, fin.pend, false, T.i32);
  allocVar(scope, fin.val);
  assign(scope, Local(fin.pend, T.i32), Const(T.i32, 0));
  (scope.finallyStack ??= []).push(fin);
  return fin;
};

const finallyEnd = (scope, fin, protectedStmts, finalize) => {
  scope.finallyStack.pop();

  // anything thrown out of the protected region is held while the finalizer runs
  allocVar(scope, fin.catchName);
  const catchAll = collect(scope, () => {
    assign(scope, Local(fin.val, T.jsval), Local(fin.catchName, T.jsval));
    assign(scope, Local(fin.pend, T.i32), Const(T.i32, FIN_THROW));
  });
  fin.taken.add(FIN_THROW);
  stmt(scope, BlockStmt([ Try(protectedStmts, fin.catchName, catchAll) ], fin.brk));

  finalize();

  let code = 1;
  for (const exit of fin.exits) {
    if (fin.taken.has(code)) emitIf(scope, Bin('==', T.i32, Local(fin.pend, T.i32), Const(T.i32, code)), exit);
    code++;
  }
};

const generateMeta = (scope, decl) => {
  if (decl.meta.name === 'new' && decl.property.name === 'target') {
    // new.target: the hidden #newtarget param (the constructor when invoked via `new`)
    if (scope.constr) return Local('#newtarget', T.jsval);

    // an arrow's is its enclosing function's (in that one's closure env)
    if (decl._closureThisFunc) return generate(scope, closureEnvNode(scope, '#newtarget', decl._closureThisFunc));
    return valUndefined();
  }

  // todo: import.meta
  return internalThrow(scope, 'Error', `porffor: meta property ${decl.meta.name}.${decl.property.name} is not supported yet`);
};

const printStaticStr = (scope, str) => {
  if (str.length === 0) return [];
  let literal = '';
  for (let i = 0; i < str.length; i++) literal += '\\' + str.charCodeAt(i).toString(8).padStart(3, '0');
  return [ RawC(`porf_out("${literal}", ${str.length})`) ];
};

const byteStringable = str => {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0xFF) return false;
  }

  return true;
};

// every one-byte character as a string of its own, 256 in a row of 8 bytes each ([length 1
// u32][char u8][pad]): a one-byte string's s[i] or iteration reads its character's string
// here instead of allocating one (as V8's single character string table). Strings are never
// written to once made, so all can share them
// (one table for the whole program: a builtin's precompiled copy is mapped back to it)
const ONE_CHAR_STRINGS = Array.from({ length: 256 }, (_, c) => [ 1, 0, 0, 0, c, 0, 0, 0 ]).flat();
const isOneCharStrings = bytes => bytes.length === ONE_CHAR_STRINGS.length && bytes.every((x, i) => x === ONE_CHAR_STRINGS[i]);
const oneCharStringsSeg = () => dataSeg('builtins', '#chars:b', ONE_CHAR_STRINGS);
const oneCharStrings = scope => DataRef(globalThis.precompile ? dataSeg(unitOf(scope), '#chars:b', ONE_CHAR_STRINGS) : oneCharStringsSeg());
const oneCharString = (scope, code) =>
  valOf(Bin('+', T.u32, oneCharStrings(scope), Bin('*', T.u32, code, Const(T.u32, 8))), TYPES.bytestring);

const makeString = (scope, str, bytestring = true) => {
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 0xFF) { bytestring = false; break; }
  typeUsed(scope, bytestring ? TYPES.bytestring : TYPES.string);

  if (str.length === 0) return valOf(Const(T.u32, 0), bytestring ? TYPES.bytestring : TYPES.string);

  const bytes = [ ...i32Bytes(str.length) ];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    bytes.push(c & 0xff);
    if (!bytestring) bytes.push((c >>> 8) & 0xff);
  }

  return valOf(dataRef(unitOf(scope), `#str:${bytestring ? 'b' : 's'}:${str}`, bytes), bytestring ? TYPES.bytestring : TYPES.string);
};

const generateArray = (scope, decl, name = '$undeclared', staticAlloc = false) => {
  if (!staticAlloc && !decl._staticAlloc) {
    const template = literalTemplate(scope, decl);
    if (template) return valOf(reuse(scope, Clone(DataRef(template.seg), template.type)), template.type);
  }
  const elements = decl.elements;
  const length = elements.length;
  const capacity = Math.max(length, 2);

  const allocSize = 16 + capacity * 8;

  let pointer;
  const isStatic = staticAlloc || decl._staticAlloc;
  if (isStatic) {
    const uniqueName = name === '$undeclared' ? name + uniqId(scope) : name;
    pointer = dataRef(unitOf(scope), `#staticarr:${uniqueName}`, new Array(allocSize).fill(0));
  } else {
    // header filled in and slots zeroed by one call (porf_arr_alloc)
    pointer = reuse(scope, ArrAlloc(Const(T.i32, capacity)));
  }
  const allocated = isStatic ? null : freshMark(scope);

  if (isStatic) {
    stmt(scope, LenSet(pointer, Const(T.i32, 0)));
    stmt(scope, Store('u32', pointer, 4, Bin('+', T.u32, pointer, Const(T.u32, 16))));
    stmt(scope, Store('i32', pointer, 8, Const(T.i32, capacity)));
  }

  // fast path: store leading non-spread elements straight into their slots (a jsval each)
  let i = 0;
  for (; i < length; i++) {
    if (elements[i] == null) continue;
    if (elements[i].type === 'SpreadElement') break;

    const value = elements[i].type === 'Literal' && typeof elements[i].value === 'number'
      ? valNum(elements[i].value)
      : generate(scope, elements[i]);
    stmt(scope, ArrSet(pointer, Const(T.u32, i), value));
  }

  // direct length = number of leading elements stored
  stmt(scope, LenSet(pointer, Const(T.i32, i)));

  // a collection during element evaluation can sticky-promote this fresh array to old,
  // raw stores of young pointers into it must then be remembered, so flag it to the GC
  // once after construction. skipped for static arrays / all-non-reference entries, no-op sans GC,
  // and when nothing in the elements could collect (the array is still young)
  if (!isStatic && i > 0 && !stillFresh(scope, allocated) &&
      elements.slice(0, i).some(x => {
        if (x == null) return false;
        if (x.type === 'Literal' && typeof x.value === 'number') return false;
        const known = knownType(scope, getNodeType(scope, x));
        return known !== TYPES.number && known !== TYPES.boolean && known !== TYPES.undefined;
      })) {
    stmt(scope, GcBarrier(pointer, Const(T.i32, TYPES.array)));
  }

  for (; i < length; i++) {
    if (elements[i] == null) {
      stmt(scope, ArrLenSet(pointer, Bin('+', T.i32, LenGet(pointer), Const(T.i32, 1))));
      continue;
    }

    const element = elements[i];
    if (element.type === 'SpreadElement') {
      exprStmt(scope, builtinCall(scope, '__Porffor_array_spread', [ valOf(pointer, TYPES.array), generate(scope, element.argument) ]));
      continue;
    }

    const push = includeBuiltin(scope, '__Array_prototype_push');
    exprStmt(scope, Call(push.index, buildDirectArgs(scope, decl, push, [ generate(scope, element) ], null, valOf(pointer, TYPES.array)), push.retType ?? T.jsval));
  }

  typeUsed(scope, TYPES.array);
  return valOf(pointer, TYPES.array);
};

// only computed keys need ToPropertyKey, static ones already are keys
const toPropertyKey = (scope, key, computed = false) =>
  computed ? builtinCall(scope, '__ecma262_ToPropertyKey', [ key[N_TYPE] === T.jsval ? key : valNumber(key) ]) : key;

// a typed array element's address, base + index * size (the data pointer is at +4)
const taAddr = (obj, idx, size) => Bin('+', T.u32, Load('u32', JvPtr(obj), 4),
  size === 1 ? idx : Bin('*', T.u32, idx, Const(T.u32, size)));

// a number key of a typed array: its index, valid for an integer below the length
const typedArrayIndexKey = (scope, obj, prop) => {
  const num = reuse(scope, numValue(prop));
  const idx = reuse(scope, Convert(T.u32, num, 0));
  return {
    idx,
    valid: Bin('&&', T.i32,
      Bin('==', T.i32, num, Convert(T.f64, idx, 0)),
      Bin('<', T.i32, idx, Load('u32', JvPtr(obj), 0)))
  };
};

const denseArrayIndexKey = (scope, prop) => {
  const num = reuse(scope, numValue(prop));
  const idx = reuse(scope, Convert(T.u32, num, 0));
  return {
    idx,
    valid: Bin('&&', T.i32,
      Bin('==', T.i32, num, Convert(T.f64, idx, 0)),
      Bin('<=', T.i32, idx, Const(T.u32, 2147483646)))
  };
};

// Constant literals as data: an object or array literal of nothing but numbers, strings,
// booleans, null and more such literals is a template in the data section, in the runtime's
// own layout, which porf_tmpl_clone copies (a fresh object each time it is evaluated),
// rather than code storing each value. Its strings and nested templates are relocations,
// written once the data is laid out. Not in builtins: their precompiled data is remapped
// segment by segment, which relocations inside a segment would not survive.
const JV_PATTERN_BITS = 0xFFF8000000000000n;
const constBits = (typeId, payload) => JV_PATTERN_BITS | (BigInt(typeId & 0xFF) << 43n) | BigInt(payload >>> 0);
const f64Bytes = n => [ ...new Uint8Array(new Float64Array([ n ]).buffer) ];
const u64Bytes = b => Array.from({ length: 8 }, (_, i) => Number((b >> BigInt(i * 8)) & 0xFFn));
const u32Bytes = n => [ n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff ];

// a constant value: { num }, { type, payload } (a boolean, null), { type, seg } (a string or a
// nested template, by its segment), or null when the node is not a constant
const literalConstant = (scope, node) => {
  if (node == null) return null;
  if (node.type === 'Literal') {
    if (typeof node.value === 'number') return { num: node.value };
    if (typeof node.value === 'boolean') return { type: TYPES.boolean, payload: node.value ? 1 : 0 };
    if (node.value === null && node.raw === 'null') return { type: TYPES.object, payload: 0 };
    if (typeof node.value === 'string') return literalString(scope, node.value);
    return null;
  }
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number')
    return { num: -node.argument.value };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis[0].value.cooked != null)
    return literalString(scope, node.quasis[0].value.cooked);
  if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression') return literalTemplate(scope, node);
  return null;
};

const literalString = (scope, str) => {
  const v = makeString(scope, str);
  // the empty string folds to a constant (its type and a null pointer); the rest point at data
  if (v[N_KIND] === K.JvConst) return { type: v[N_A], payload: v[N_B] };
  return { type: v[N_B][N_A], seg: v[N_A][N_A] };
};

// the template for an object or array literal, { type, seg }, or null if it is not all constant.
// With shape, an object literal's values need not be constant: each one that is not is left
// undefined in the template and listed in dynamic ({ slot, x }, its property), for the code
// that clones the template to evaluate and store
const literalTemplate = (scope, node, shape = false) => {
  if (globalThis.precompile) return null;
  if (shape && node.type !== 'ObjectExpression') return null;
  const relocs = [];
  const dynamic = [];
  let bytes;

  if (node.type === 'ArrayExpression') {
    const values = [];
    for (const x of node.elements) {
      if (x == null || x.type === 'SpreadElement') return null;
      const v = literalConstant(scope, x);
      if (v == null) return null;
      values.push(v);
    }
    if (values.length === 0) return null;
    const capacity = Math.max(values.length, 2);
    bytes = [ ...u32Bytes(values.length), 0, 0, 0, 0, ...u32Bytes(capacity), 0, 0, 0, 0 ];
    for (let i = 0; i < capacity; i++) {
      const v = values[i];
      const off = 16 + i * 8;
      // an empty slot is 0 bits (a hole); +0 is its own pattern, as a stored number's
      if (v == null) bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
      else if (v.num !== undefined) bytes.push(...u64Bytes(Object.is(v.num, 0) ? constBits(TYPES.number, 0)
        : Number.isNaN(v.num) ? 0x7FF8000000000000n : new BigUint64Array(new Float64Array([ v.num ]).buffer)[0]));
      else if (v.seg != null) { bytes.push(0, 0, 0, 0, 0, 0, 0, 0); relocs.push({ off, seg: v.seg, kind: 'bits', type: v.type }); }
      else bytes.push(...u64Bytes(constBits(v.type, v.payload)));
    }
  } else {
    const entries = [];
    const keys = new Set();
    for (const x of node.properties) {
      if (x.type !== 'Property' || x.kind !== 'init' || x.computed || x.method || (x.shorthand && !shape)) return null;
      const key = getProperty(x, true).value;
      if (typeof key !== 'string' || key === '__proto__' || keys.has(key)) return null;
      keys.add(key);
      // a key with no hash known now (the empty key, a two-byte one) is set at run time
      const hash = ctHash({ property: { name: key } });
      if (hash == null) return null;
      let v = x.shorthand ? null : literalConstant(scope, x.value);
      if (v == null) {
        if (!shape) return null;
        dynamic.push({ slot: entries.length, x });
        v = { type: TYPES.undefined, payload: 0 };
      }
      entries.push({ key, keyString: literalString(scope, key), hash, v });
    }
    if (entries.length === 0 || entries.length > 0xffff) return null;
    // (all dynamic, or nothing: no shape to share, or the plain constant template)
    if (shape && dynamic.length === 0) return null;
    const capacity = Math.max(entries.length, 2);
    bytes = [ entries.length & 0xff, entries.length >> 8, capacity & 0xff, capacity >> 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ];
    for (let i = 0; i < capacity; i++) {
      const e = entries[i];
      const off = 16 + i * 20;
      if (e == null) { bytes.push(...new Array(20).fill(0)); continue; }
      const { v, keyString } = e;
      bytes.push(...u32Bytes(e.hash | 0), 0, 0, 0, 0);
      if (keyString.seg != null) relocs.push({ off: off + 4, seg: keyString.seg, kind: 'u32' });
      if (v.num !== undefined) bytes.push(...f64Bytes(v.num));
      else if (v.seg != null) { bytes.push(0, 0, 0, 0, 0, 0, 0, 0); relocs.push({ off: off + 8, seg: v.seg, kind: 'f64' }); }
      else bytes.push(...f64Bytes(v.payload));
      bytes.push(14, v.num !== undefined ? TYPES.number : v.type, keyString.type, 0);
    }
  }

  const type = node.type === 'ArrayExpression' ? TYPES.array : TYPES.object;
  if (shape && type !== TYPES.object) return null;
  const key = `#tmpl:${type}:${bytes.join(',')}:${relocs.map(r => `${r.off}.${r.seg}.${r.kind}.${r.type}`).join(',')}`;
  typeUsed(scope, type);
  const seg = dataSeg(unitOf(scope), key, bytes);
  // (a table beside the segments, which render reads with them)
  dataRelocs[seg] = relocs;
  return { type, seg, dynamic };
};

// an object literal's property value as it is generated: a function is named after its key
// and a method is no constructor
const objectPropertyValue = (x, key) => {
  let { kind, value, method } = x;
  if (method) {
    value._method = true;
    value._noGlobalThis = true;
  }
  if (isFuncType(value.type)) {
    let id = value.id;
    let noFuncIndex = false;

    // todo: support computed names properly
    if (typeof key.value === 'string' && !id) {
      id = { type: 'Identifier', name: key.value };
      noFuncIndex = true;
    }

    // keep closure owner identity for semantic capture resolution; an accessor's name is
    // "get x" / "set x"
    value = { ...value, id, _noFuncIndex: noFuncIndex, _closureSource: value._closureSource ?? value,
      ...((kind === 'get' || kind === 'set') && typeof key.value === 'string' ? { _jsName: kind + ' ' + key.value } : {}) };
  }
  return value;
};

const generateObject = (scope, decl) => {
  const template = literalTemplate(scope, decl);
  if (template) return valOf(reuse(scope, Clone(DataRef(template.seg), template.type)), template.type);

  // its keys constant: the object is its shape's template cloned (keys, hashes and flags
  // written once, in data), then each value that is not constant stored in its slot
  const shape = literalTemplate(scope, decl, true);
  if (shape) {
    const obj = reuse(scope, valOf(reuse(scope, Clone(DataRef(shape.seg), TYPES.object)), TYPES.object));
    const allocated = freshMark(scope);
    for (const { slot, x } of shape.dynamic) {
      const val = reuse(scope, coerceValue(generate(scope, objectPropertyValue(x, getProperty(x, true))), T.jsval));
      const entries = Load('u32', JvPtr(obj), 12);
      stmt(scope, Store('f64', entries, slot * 20 + 8, JvNum(val), true));
      stmt(scope, Store('u8', entries, slot * 20 + 17, JvType(val)));
      if (!stillFresh(scope, allocated)) stmt(scope, If(canReferenceCheck(scope, val), [ GcBarrier(JvPtr(obj), Const(T.i32, TYPES.object)) ]));
    }
    typeUsed(scope, TYPES.object);
    return obj;
  }

  const obj = reuse(scope, builtinCall(scope, '__Porffor_object_new', [ Const(T.i32, Math.max(decl.properties.length, 2)) ]));
  // __Porffor_object_new allocates it as an object: fresh, as makeArrayFromValues' array is
  const allocated = freshMark(scope);
  const keys = new Set();
  let slot = 0;

  for (const x of decl.properties) {
    let { type, argument, computed, kind, value, method } = x;

    // tag function as not a constructor
    if (method) {
      value._method = true;
      value._noGlobalThis = true;
    }

    if (type === 'SpreadElement') {
      slot = -1;
      exprStmt(scope, builtinCall(scope, '__Porffor_object_spread', [ obj, generate(scope, argument) ]));
      continue;
    }

    const key = getProperty(x, true);
    if (isFuncType(value.type)) {
      let id = value.id;
      let noFuncIndex = false;

      // todo: support computed names properly
      if (typeof key.value === 'string' && !id) {
        id = { type: 'Identifier', name: key.value };
        noFuncIndex = true;
      }

      // keep closure owner identity for semantic capture resolution; an accessor's name is
      // "get x" / "set x"
      value = { ...value, id, _noFuncIndex: noFuncIndex, _closureSource: value._closureSource ?? value,
        ...((kind === 'get' || kind === 'set') && typeof key.value === 'string' ? { _jsName: kind + ' ' + key.value } : {}) };
    }

    const hash = slot >= 0 && !computed && kind === 'init' && !keys.has(key.value)
      ? ctHash({ property: { name: key.value } }) : null;
    if (hash != null) {
      keys.add(key.value);
      const prop = reuse(scope, generate(scope, key));
      const val = reuse(scope, coerceValue(generate(scope, value), T.jsval));
      const entries = Load('u32', JvPtr(obj), 12);
      stmt(scope, Store('i32', entries, slot * 20, Const(T.i32, hash)));
      stmt(scope, Store('u32', entries, slot * 20 + 4, JvPtr(prop)));
      stmt(scope, Store('f64', entries, slot * 20 + 8, JvNum(val), true));
      stmt(scope, Store('u8', entries, slot * 20 + 16, Const(T.i32, 14)));
      stmt(scope, Store('u8', entries, slot * 20 + 17, JvType(val)));
      stmt(scope, Store('u8', entries, slot * 20 + 18, JvType(prop)));
      stmt(scope, Store('u16', JvPtr(obj), 0, Const(T.i32, ++slot)));
      if (!stillFresh(scope, allocated)) stmt(scope, If(canReferenceCheck(scope, val), [ GcBarrier(JvPtr(obj), Const(T.i32, TYPES.object)) ]));
    } else {
      slot = -1;
      exprStmt(scope, builtinCall(scope, `__Porffor_object_expr_${kind}`, [
        obj,
        toPropertyKey(scope, generate(scope, key), computed),
        generate(scope, value)
      ]));
    }
  }

  typeUsed(scope, TYPES.object);
  return obj;
};

let memberDemands;
// the program uses a typed array's constructor as a value (not only new Uint8Array(...))
let typedArrayCtorValue = false;
// whether a typed array kind is in the program (program.typedArrays)
let typedArraysUsed = false;
// whether the program can make or use a resizable ArrayBuffer (program.resizableBuffers): it
// names maxByteLength, resize or resizable somewhere (a read, a call, an options object's key, a
// string). Only then does new ArrayBuffer read its options, which takes the generic property read
// and everything it reaches; a buffer that is never resized nor asked about is a fixed one
let resizableBuffers = true;
// whether the program can give an error a cause (program.errorCause): it names cause somewhere.
// Only then does an error's constructor look for one in its options ('cause' in options: the
// generic in, own keys and all), so a program that throws needs none of it
let errorCause = true;

// whether the program names any of these (an identifier: a binding, a property read or key; or
// a string): a feature a builtin supports only for a program that can reach it
const programNames = (node, names) => {
  let found = false;
  const walk = n => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if ((n.type === 'Identifier' && names.has(n.name)) || (n.type === 'Literal' && names.has(n.value))) { found = true; return; }
    for (const k in n) if (k[0] !== '_' && n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(node);
  return found;
};
const TYPED_ARRAY_TYPES = new Set(TYPED_ARRAY_KINDS.map(x => TYPES[x.toLowerCase()]));
let calledMembers;
// the program can make its own iterators (parse.js): for...of and friends need the protocol
let usesIterProtocol = true;
// the program can hold BigInts (parse.js): arithmetic on unknown types checks for them
let usesBigInt = false;
// the program names a script property escape, a \q{} or a property of strings (parse.js):
// regexes carry the script tables, strings in classes, the emoji data
let regexScripts = false, regexStrings = false, regexEmoji = false;

// the program reads a property of this name (x.name, x['name']): a fact (member), and the
// builtins it can reach wait on the types that have them
const demandMember = name => {
  if (memberDemands.has(name)) return;
  memberDemands.add(name);
  if (calledMembers.has(name)) return;
  factSet('member', name);
  onMemberDemanded(name);
};

// it calls a method of this name (x.name(...)): the same fact, for the member.<name> flags
const callMember = name => {
  if (calledMembers.has(name)) return;
  calledMembers.add(name);
  if (memberDemands.has(name)) return;
  factSet('member', name);
  onMemberDemanded(name);
};

const demandMemberRead = decl => {
  const propName = decl.computed
    ? (decl.property.type === 'Literal' && typeof decl.property.value === 'string' ? decl.property.value : null)
    : decl.property.name;
  if (propName && propName !== '__proto__') demandMember(propName);
  // the global object read by a name known only at run time (globalThis[name], self[name]): the
  // globals it can find are the ones the program spells as strings ('Int8Array' in a list)
  if (!propName && decl.computed && decl.object.type === 'Identifier' && GLOBAL_OBJECT_NAMES.has(decl.object.name) && !programStringsDemanded) {
    programStringsDemanded = true;
    for (const x of programStrings) if (x !== '__proto__') demandMember(x);
  }
};

const GLOBAL_OBJECT_NAMES = new Set([ 'globalThis', 'self', 'window', 'global' ]);
// the program's string literals that could name a global (identifier-shaped), and whether a
// computed global read has demanded them
let programStrings = new Set(), programStringsDemanded = false;
const scanProgramStrings = node => {
  const out = new Set();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.type === 'Literal' && typeof n.value === 'string' && /^[A-Za-z_$][\w$]*$/.test(n.value)) out.add(n.value);
    for (const k in n) if (k[0] !== '_' && n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(node);
  return out;
};

const primObjAlias = {
  [TYPES.boolean]: TYPES.booleanobject,
  [TYPES.number]: TYPES.numberobject,
  [TYPES.string]: TYPES.stringobject,
  [TYPES.bytestring]: TYPES.stringobject
};

// builtins that look a method up by name at runtime: when one is in the program, so is the
// method (String([1, 2]) needs Array.prototype.toString though the program never names it).
// So is a name a builtin defines: a module namespace's Symbol.toStringTag
const RUNTIME_METHOD_LOOKUPS = {
  __ecma262_ToPrimitive_Number: [ 'valueOf', 'toString' ],
  __ecma262_ToPrimitive_String: [ 'toString', 'valueOf' ],
  __Porffor_namespace: [ 'toStringTag' ],
  // the Set methods' set-likes (GetSetRecord), a Set among them, and their keys iterators
  __Porffor_set_getSetRecord: [ 'size', 'has', 'keys' ],
  __Porffor_set_keysIterator: [ 'next' ],
  __Porffor_set_keysStep: [ 'done', 'value' ],
  __Porffor_set_keysClose: [ 'return' ]
};

// %TypedArray%.prototype can be reached: through a prototype read of a kind's constructor used
// as a value (each kind's prototype has its own methods)
const whenTypedArrayReachable = fn => whenFact([ [ 'program', 'typedArrayCtorValue' ] ], () =>
  whenFact([ [ 'hasFunc', '__Object_getPrototypeOf' ], [ 'hasFunc', '__Reflect_getPrototypeOf' ], [ 'member', '__proto__' ] ], fn));

// what a property name read can reach: each builtin method (or getter, for constructor)
// of that name, once its type is in the program; a constructor's static of that name, once the
// constructor is used as a value (const O = Object; O.keys: __Porffor_object_builtinStatics)
const onMemberDemanded = propName => {
  const getterOnly = propName === 'constructor';
  for (const x of getterOnly ? builtinPrototypeObjectGetters.values() : (builtinPrototypeFuncs.get(propName) ?? [])) {
    const tn = getterOnly ? x.slice(7, -'_prototype'.length) : x.slice(2, x.indexOf('_prototype_'));
    const include = () => {
      includeBuiltin(topLevelFunc, x);
      if (!getterOnly) {
        const getter = '#get___' + tn + '_prototype';
        if (getter in builtinFuncs) includeBuiltin(topLevelFunc, getter);
      }
    };

    // %TypedArray%.prototype's, in a program that can reach it
    if (tn === 'Porffor_TypedArray') {
      whenTypedArrayReachable(include);
      continue;
    }

    // Porffor's own types are named with __ (__Porffor_Generator_prototype_next is
    // TYPES.__porffor_generator's): without it their methods are never readable
    const t = TYPES[tn.toLowerCase()] ?? TYPES['__' + tn.toLowerCase()];
    // a prototype that is no type's (Iterator.prototype, reached through its constructor or
    // a subclass): once the object is in the program
    if (t == null) {
      const getter = '#get___' + tn + '_prototype';
      if (getter in builtinFuncs) whenFact([ [ 'hasFunc', getter ] ], include);
      continue;
    }
    const types = [ [ 'hasType', t ] ];
    if (primObjAlias[t] != null) types.push([ 'hasType', primObjAlias[t] ]);
    whenFact(types, include);
  }

  for (const [ ctor, x ] of builtinStaticFuncs.get(propName) ?? [])
    whenFact([ [ 'indirect', ctor ] ], () => includeBuiltin(topLevelFunc, x));
};

// the member facts' waiting that does not start at a read: the builtins that look methods up
// by name, and %TypedArray%.prototype's getters (its accessors: a read by a computed key
// names none)
const startMemberDemands = () => {
  for (const name in RUNTIME_METHOD_LOOKUPS)
    whenFact([ [ 'hasFunc', name ] ], () => { for (const method of RUNTIME_METHOD_LOOKUPS[name]) demandMember(method); });
  whenTypedArrayReachable(() => {
    for (const x of [ 'buffer', 'byteLength', 'byteOffset', 'length' ]) includeBuiltin(topLevelFunc, `__Porffor_TypedArray_prototype_${x}$get`);
  });
  // a typed array's [Symbol.toStringTag] getter, in a program that names it and has a kind
  whenFact([ [ 'member', 'toStringTag' ] ], () =>
    whenFact(TYPED_ARRAY_KINDS.map(k => [ 'hasType', TYPES[k.toLowerCase()] ]), () => includeBuiltin(topLevelFunc, '__Porffor_typedArray_toStringTag')));
};

let icSites;

// s[i] is a string only for an index below the length. In the loop that checks exactly that,
//   for (let i = <integer >= 0>; i < s.length; i++) ... s[i] ...
// it always is, when nothing in the body can change i or s (no write to either, no
// declaration of either name, no eval, with or arguments) and s is assigned nowhere in the
// program (by name: over-counting writes only leaves a loop unmarked). Those s[i] are marked
// _inBounds, and type inference and codegen both read the mark: a string, with no check
const astChildren = node => {
  const out = [];
  for (const k in node) {
    if (k[0] === '_' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') out.push(x); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
};

const patternNames = (node, out) => {
  if (!node) return;
  if (node.type === 'Identifier') out.add(node.name);
  else if (node.type === 'ArrayPattern') for (const x of node.elements) patternNames(x, out);
  else if (node.type === 'ObjectPattern') for (const x of node.properties) patternNames(x.type === 'RestElement' ? x.argument : x.value, out);
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
};

// every name a node writes (assignments, updates, for-in/of targets) or declares
const writtenNames = node => {
  const written = new Set(), declared = new Set();
  let opaque = false;
  const walk = n => {
    switch (n.type) {
      case 'AssignmentExpression': patternNames(n.left, written); break;
      case 'UpdateExpression': patternNames(n.argument, written); break;
      case 'ForInStatement': case 'ForOfStatement': if (n.left.type !== 'VariableDeclaration') patternNames(n.left, written); break;
      case 'VariableDeclarator': patternNames(n.id, declared); break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (n.id) declared.add(n.id.name);
        for (const x of n.params) patternNames(x, declared);
        break;
      case 'ClassDeclaration': case 'ClassExpression': if (n.id) declared.add(n.id.name); break;
      case 'CatchClause': patternNames(n.param, declared); break;
      case 'WithStatement': opaque = true; break;
      case 'Identifier': if (n.name === 'arguments' || n.name === 'eval') opaque = true; break;
    }
    for (const x of astChildren(n)) walk(x);
  };
  walk(node);
  return { written, declared, opaque };
};

const markInBoundsIndexes = program => {
  const programWrites = writtenNames(program).written;
  const walk = n => {
    if (n.type === 'ForStatement') {
      const { init, test, update, body } = n;
      const decl = init?.type === 'VariableDeclaration' && init.kind === 'let' && init.declarations.length === 1 ? init.declarations[0] : null;
      const i = decl?.id.type === 'Identifier' ? decl.id.name : null;
      const start = decl?.init;
      const str = test?.type === 'BinaryExpression' && test.operator === '<' && test.left.type === 'Identifier' && test.left.name === i &&
        test.right.type === 'MemberExpression' && !test.right.computed && test.right.property.name === 'length' &&
        test.right.object.type === 'Identifier' ? test.right.object.name : null;
      const steps = update && ((update.type === 'UpdateExpression' && update.operator === '++' && update.argument.type === 'Identifier' && update.argument.name === i) ||
        (update.type === 'AssignmentExpression' && update.operator === '+=' && update.left.type === 'Identifier' && update.left.name === i &&
          update.right.type === 'Literal' && update.right.value === 1));
      if (i && str && i !== str && steps && start?.type === 'Literal' && Number.isInteger(start.value) && start.value >= 0 && !programWrites.has(str)) {
        const { written, declared, opaque } = writtenNames(body);
        if (!opaque && !written.has(i) && !written.has(str) && !declared.has(i) && !declared.has(str)) {
          const mark = m => {
            if (m.type === 'MemberExpression' && m.computed && m.object.type === 'Identifier' && m.object.name === str &&
              m.property.type === 'Identifier' && m.property.name === i) m._inBounds = true;
            for (const x of astChildren(m)) mark(x);
          };
          mark(body);
        }
      }
    }
    for (const x of astChildren(n)) walk(x);
  };
  walk(program);
};

// an array element read: a stored one directly, a hole or one past the end through the spec's
// Get (the runtime's porf_arr_get hands those to __Porffor_array_holeGet)
const arrGet = (scope, arr, index) => {
  // (a builtin's reads include it when the builtin is: precompile's walk)
  if (!globalThis.precompile && '__Porffor_array_holeGet' in builtinFuncs) includeBuiltin(scope, '__Porffor_array_holeGet');
  return ArrGet(arr, index);
};

const generateMember = (scope, decl, objValue = null) => {
  if (!globalThis.precompile) demandMemberRead(decl);
  // builtins unless reassigned via globalThis
  const globalName = decl.object.name === 'globalThis' && !decl.computed && decl.property.name;
  if (globalName && !globalName.startsWith('__') && globalName !== 'null' && !(globalName in globals)) {
    const v = builtinVars[globalName];
    if (v) return typeof v === 'function' ? v(scope, irBuiltinHelpers(scope, globalName, {})) : v;
    if (globalName in builtinFuncs) return materializeFunctionValue(scope, includeBuiltin(scope, globalName));
  }
  const closureSlot = decl._closureSlot;
  if (closureSlot != null) {
    const pointer = JvPtr(reuse(scope, objValue ?? generate(scope, decl.object)));
    if (closureSlot === 0) return valOf(Load('u32', pointer, 0), TYPES.__porffor_closureenv);
    return Box(Load('f64', pointer, 8 + (closureSlot - 1) * 16), Load('u8', pointer, 16 + (closureSlot - 1) * 16));
  }

  const object = decl.object;
  const property = getProperty(decl);

  let objectValue = objValue;
  if (!objectValue) {
    doNotMarkFuncRef = true;
    objectValue = generate(scope, object); // generate first so getNodeType sees the inferred type
    doNotMarkFuncRef = false;
  }

  const type = getNodeType(scope, object);
  const known = knownType(scope, type);
  // one of a few types (a string, either representation): what the switches below may take
  const knownSet = known == null ? typeSet(scope, object) : null;
  const propertyType = getNodeType(scope, property);
  const propertyKnown = knownType(scope, propertyType);
  const objectKnownValue = knownValue(scope, object);

  const obj = reuse(scope, objectValue);

  // a?.b / a?.[b] : a nullish base short-circuits the whole chain to undefined
  if (decl.optional) {
    emitIf(scope, nullish(scope, obj, known), () => {
      assign(scope, scope.chainRes, valUndefined());
      stmt(scope, Break(scope.chainLabel));
    });
  }

  // obj.#x: the class's own objects only
  if (decl.property._private) return builtinCall(scope, '__Porffor_object_getPrivate', [ obj, generate(scope, decl.property) ]);

  const prop = reuse(scope, generate(scope, property));

  // builtin prototype getters dispatch to __X_prototype_NAME$get by the object's runtime type
  let extraBC = [];
  if (!decl.computed && builtinPrototypeGetters.has(decl.property.name)) {
    const bc = [];
    const cands = builtinPrototypeGetters.get(decl.property.name) ?? [];
    for (const x of cands) {
      const t = TYPES[x.split('_prototype_')[0].slice(2).toLowerCase()];
      if (t == null) continue;

      const getter = includeBuiltin(scope, x);
      const callGetter = recv => Call(getter.index, buildDirectArgs(scope, decl, getter, [], null, recv), getter.retType ?? T.jsval);

      if (t === known) return callGetter(obj);
      bc.push([ t, () => callGetter(obj) ]);
    }

    // a value of no known type, in a program, reads the getter through the property lookup
    // (the prototype's accessor) rather than a case per type at every site; but for an
    // Error's message, which Error.prototype's own '' would shadow, and a typed array's
    // getters, which live on %TypedArray% (a lookup does not reach)
    if (known == null) extraBC = globalThis.precompile || decl.property.name === 'message' ? bc
      : bc.filter(([ t ]) => t !== TYPES.array && TYPE_NAMES[t]?.endsWith('Array'));
  }

  const hash = ctHash(decl);

  const genericMemberGet = () => {
    const key = prop[N_TYPE] === T.jsval ? prop : valNumber(prop);
    if (hash == null) return builtinCall(scope, '__Porffor_object_get', [ obj, key ]);

    if (Prefs.ic && (known == null || known === TYPES.object) && icKey(key) != null)
      return builtinCall(scope, '__Porffor_object_get_ic', [ obj, icKey(key), Const(T.i32, hash), icSlot(scope) ]);

    return builtinCall(scope, '__Porffor_object_get_withHash', [ obj, key, Const(T.i32, hash) ]);
  };

  const genericMemberGetBC = [
    ...extraBC,
    [ 'default', () => genericMemberGet() ]
  ];

  // -d: nullish errors include the property name
  if (Prefs.d) genericMemberGetBC.unshift(
    [ TYPES.undefined, () => internalThrow(scope, 'TypeError', propertyErrorMessage('read', 'undefined', decl)) ],
    [ TYPES.object, () => {
      emitIf(scope, Bin('==', T.i32, JvPtr(obj), Const(T.u32, 0)), () => internalThrow(scope, 'TypeError', propertyErrorMessage('read', 'null', decl)));
      return genericMemberGet();
    } ]);

  const lengthMemberGet = () => {
    const lengthVal = () => Box(Convert(T.f64, LenGet(JvPtr(obj))), Const(T.i32, TYPES.number));
    const arrayLengthVal = () => Box(Convert(T.f64, Load('u32', JvPtr(obj), 0)), Const(T.i32, TYPES.number));
    if (known === TYPES.array) return arrayLengthVal();
    if (Prefs.fastLength || (known != null && (known & TYPE_FLAGS.length) !== 0)) return lengthVal();
    // each type in the set keeps its length at the pointer (strings, typed arrays)
    if (knownSet?.every(t => t !== TYPES.array && (t & TYPE_FLAGS.length) !== 0)) return lengthVal();
    if (known != null) return genericMemberGet();

    const res = tmp(scope, T.jsval);
    emitIf(scope, Bin('==', T.i32, JvType(obj), Const(T.i32, TYPES.array)),
      () => assign(scope, res, arrayLengthVal()),
      () => emitIf(scope, Bin('!=', T.i32, Bin('&', T.i32, JvType(obj), Const(T.i32, TYPE_FLAGS.length)), Const(T.i32, 0)),
        () => assign(scope, res, lengthVal()),
        () => assign(scope, res, genericMemberGet())));
    return res;
  };

  // a typed array's element: only for an integer index below its length, any other number
  // key is undefined (an integer-indexed object has no such property, nor looks further)
  const taGetChecked = (size, load) => () => {
    if (decl._inBounds) return load(taAddr(obj, Convert(T.u32, numValue(prop), 0), size));
    const { idx, valid } = typedArrayIndexKey(scope, obj, prop);
    const res = tmp(scope, T.jsval);
    emitIf(scope, valid, () => assign(scope, res, load(taAddr(obj, idx, size))), () => assign(scope, res, valUndefined()));
    return res;
  };
  const taGet = (ctype, size, signed = true) => taGetChecked(size, addr => {
    const loaded = Load(ctype, addr, 4);
    const f = ctype === 'f32' || ctype === 'f64' || ctype === 'f16' ? loaded : Convert(T.f64, loaded, signed ? CONVERT_SIGNED : 0);
    return Box(f, Const(T.i32, TYPES.number));
  });
  const taGetBig = signed => taGetChecked(8, addr =>
    builtinCall(scope, signed ? '__Porffor_bigint_fromS64' : '__Porffor_bigint_fromU64', [ Load('i64', addr, 4) ]));

  // s[i]: a character only for an integer index below the length (s[99], s[-1] and s[1.5]
  // are property reads, which find nothing on a string but what its prototype has)
  const strGet = (ctype, size, strType) => () => {
    // --ropes: its characters are read directly, so a rope is flattened first
    const str = Prefs.ropes ? reuse(scope, builtinCall(scope, '__Porffor_string_flat', [ obj ])) : obj;
    const { idx, valid } = denseArrayIndexKey(scope, prop);
    const res = tmp(scope, T.jsval);
    // an index known to be in bounds (markInBoundsIndexes) needs no check
    emitIf(scope, decl._inBounds ? Const(T.i32, 1) : Bin('&&', T.i32, valid, Bin('<', T.u32, idx, Load('u32', JvPtr(str), 0))), () => {
      const src = Bin('+', T.u32, Bin('+', T.u32, JvPtr(str), Const(T.u32, 4)),
        size === 1 ? idx : Bin('*', T.u32, idx, Const(T.u32, size)));
      if (size === 1) return assign(scope, res, oneCharString(scope, Load('u8', src, 0)));
      const out = reuse(scope, Alloc(Const(T.i32, 8), strType));
      stmt(scope, Store('u32', out, 0, Const(T.u32, 1)));
      stmt(scope, Store(ctype, out, 4, Load(ctype, src, 0)));
      assign(scope, res, valOf(out, strType));
    }, () => assign(scope, res, genericMemberGet()));
    return res;
  };

  const indexedMemberGetBC = [
    [ TYPES.array, () => {
      const { idx, valid } = denseArrayIndexKey(scope, prop);
      const res = tmp(scope, T.jsval);
      emitIf(scope, valid,
        () => assign(scope, res, arrGet(scope, JvPtr(obj), idx)),
        () => assign(scope, res, genericMemberGet()));
      return res;
    } ],
    [ TYPES.string, strGet('u16', 2, TYPES.string) ],
    [ TYPES.bytestring, strGet('u8', 1, TYPES.bytestring) ],
    [ [ TYPES.uint8array, TYPES.uint8clampedarray ], taGet('u8', 1, false) ],
    [ TYPES.int8array, taGet('i8', 1, true) ],
    [ TYPES.uint16array, taGet('u16', 2, false) ],
    [ TYPES.int16array, taGet('i16', 2, true) ],
    [ TYPES.uint32array, taGet('u32', 4, false) ],
    [ TYPES.int32array, taGet('i32', 4, true) ],
    [ TYPES.float16array, taGet('f16', 2) ],
    [ TYPES.float32array, taGet('f32', 4) ],
    [ TYPES.float64array, taGet('f64', 8) ],
    [ TYPES.bigint64array, taGetBig(true) ],
    [ TYPES.biguint64array, taGetBig(false) ],
    ...genericMemberGetBC
  ];

  if (!decl.optional && objectKnownValue === null)
    return internalThrow(scope, 'TypeError', propertyErrorMessage('read', 'null', decl));

  if (!decl.computed && decl.property.name === 'length') return lengthMemberGet();

  // o[i] on a value of no known type, in a program: an array's element and a bytestring's
  // character inline, every other type's through one shared builtin (a UTF-16 string's
  // character, a typed array's element, a property): the rare cases, once, not at every site
  const indexedMemberGetShared = [
    indexedMemberGetBC[0], indexedMemberGetBC[2],
    [ 'default', () => builtinCall(scope, '__Porffor_object_indexGet', [ obj, prop ]) ]
  ];
  if (decl.computed) return typeSwitch(scope, prop, propertyKnown, {
    [TYPES.number]: () => typeSwitch(scope, obj, known ?? knownSet, known == null && knownSet == null && !globalThis.precompile ? indexedMemberGetShared : indexedMemberGetBC),
    default: () => typeSwitch(scope, obj, known ?? knownSet, genericMemberGetBC)
  });

  return typeSwitch(scope, obj, known ?? knownSet, genericMemberGetBC);
};

const generateAwait = (scope, decl) =>
  awaitValue(scope, generate(scope, decl.argument));

const bindClassFieldInitializer = (node, owner, currentArrow = null) => {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Identifier') {
    if (node._closureFunc) owner._closurePassThrough = true;
    return;
  }

  if (node.type === 'ThisExpression') {
    if (!currentArrow) return;
    node._closureThisFunc = owner;
    currentArrow._capturesThis = owner;
    owner._capturedThis = true;

    let cursor = currentArrow?._parentFunc;
    while (cursor && cursor !== owner) {
      cursor._closurePassThrough = true;
      cursor = cursor._parentFunc;
    }
    return;
  }

  if (node.type === 'ArrowFunctionExpression') {
    currentArrow = node;
  } else if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ClassDeclaration' ||
    node.type === 'ClassExpression'
  ) {
    return;
  }

  for (const key in node) {
    if (key[0] === '_') continue;

    const value = node[key];
    if (value == null || typeof value !== 'object') continue;

    if (Array.isArray(value)) {
      for (const item of value) bindClassFieldInitializer(item, owner, currentArrow);
      continue;
    }

    if (value.type) {
      bindClassFieldInitializer(value, owner, currentArrow);
    }
  }
};

const classHasDefinitionSideEffects = decl => {
  if (decl.superClass) return true;

  for (const x of decl.body.body) {
    if (x.type === 'StaticBlock') return true;
    if (x.computed) return true;
    if (x.type === 'PropertyDefinition' && x.static && x.value) return true;
  }

  return false;
};

const classSuperExpr = () => ({
  type: 'CallExpression',
  callee: { type: 'Identifier', name: '__Porffor_object_getPrototype' },
  arguments: [
    { type: 'Identifier', name: '#callee' }
  ]
});

/**
 * Marks a class constructor's leading `this.k = expr` statements with the entry each adds
 * (0, 1, …), for a class with no extends and no fields: `this` is then the new, empty object,
 * and those statements fill it in that order (the member set writes each straight in). The
 * run stops at the first statement that is anything else, repeats a key, or whose value names
 * this, super or eval (which could reach the object between two of them).
 */
const markConstructorAdds = decl => {
  if (decl.superClass) return;
  const body = decl.body.body;
  if (body.some(x => x.type === 'PropertyDefinition' || x.type === 'AccessorProperty')) return;
  const constructor = body.find(x => x.kind === 'constructor')?.value;
  if (constructor?.body?.type !== 'BlockStatement') return;

  const reaches = node => {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'ThisExpression' || node.type === 'Super' || (node.type === 'Identifier' && node.name === 'eval')) return true;
    for (const key in node) {
      if (key[0] === '_' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value) ? value.some(reaches) : value && typeof value.type === 'string' && reaches(value)) return true;
    }
    return false;
  };

  const keys = new Set();
  for (const x of constructor.body.body) {
    const e = x.type === 'ExpressionStatement' ? x.expression : null;
    if (e?.type !== 'AssignmentExpression' || e.operator !== '=' || e.left.type !== 'MemberExpression' ||
        e.left.object.type !== 'ThisExpression' || e.left.computed || e.left.property.type !== 'Identifier') break;
    const key = e.left.property.name;
    if (key === '__proto__' || keys.has(key) || reaches(e.right)) break;
    e._constructorEntry = keys.size;
    keys.add(key);
  }
};

// A class's private names (#x): each a symbol, made once for the class declaration and kept
// in a global. Each #x in a class body (and in the classes inside it) is given the innermost
// declaring class's: its _private, { global, name, kinds, static }
let privateNameCount = 0;
const annotatePrivateNames = (cls, outer) => {
  cls._privAnnotated = true;
  const names = Object.create(outer ?? null);
  const own = [];
  for (const x of cls.body.body) {
    if (x.key?.type !== 'PrivateIdentifier') continue;
    const n = x.key.name;
    let info = Object.hasOwn(names, n) ? names[n] : null;
    if (!info) {
      info = names[n] = { global: `#private${privateNameCount++}_${n}`, name: n, kinds: new Set(), static: !!x.static };
      own.push(info);
    }
    info.kinds.add(x.type === 'MethodDefinition' ? (x.kind === 'method' ? 'method' : 'accessor') : 'field');
  }
  cls._privateNames = own;

  const walk = (node, env) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const y of node) walk(y, env);
      return;
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      // its heritage is outside its own names
      walk(node.superClass, env);
      if (!node._privAnnotated) annotatePrivateNames(node, env);
      return;
    }

    if (node.type === 'PrivateIdentifier') {
      node._private = env[node.name];
      return;
    }

    // a direct eval's source (parsed already) sees the names too
    if (node._evalParsed) walk(node._evalParsed, env);

    for (const k in node) {
      if (k[0] === '_') continue;
      const v = node[k];
      if (v && typeof v === 'object') walk(v, env);
    }
  };
  walk(cls.body, names);
};

const generateClass = (scope, decl) => {
  const expr = decl.type === 'ClassExpression';
  if (!expr && !classHasDefinitionSideEffects(decl) && (decl._refs ?? 0) === 0) {
    return valUndefined();
  }

  if (!decl.id) decl.id = { type: 'Identifier', name: anonymousName(decl) };
  const name = decl.id.name;
  markConstructorAdds(decl);

  const body = decl.body.body;
  const root = { type: 'Identifier', name };

  if (!decl._privAnnotated) annotatePrivateNames(decl, null);
  for (const info of decl._privateNames) {
    allocVar(scope, info.global, true);
    const g = Global(info.global, T.jsval);
    emitIf(scope, Un('!', T.i32, JvTruthy(g)),
      () => assign(scope, g, coerceValue(builtinCall(scope, '__Porffor_privateName', [ makeString(scope, '#' + info.name, true) ]), T.jsval)));
  }
  // an instance's private methods are copied onto it from the constructor (its #callee)
  const privateMethods = body.filter(x => x.type === 'MethodDefinition' && !x.static && x.key._private);

  const constructor = body.find(x => x.kind === 'constructor')?.value;
  const constructorDecl = {
    ...(constructor ?? (decl.superClass ? {
      type: 'FunctionExpression',
      params: [ { type: 'RestElement', argument: { type: 'Identifier', name: 'args' } } ],
      body: {
        type: 'ExpressionStatement',
        expression: {
          type: 'CallExpression',
          callee: { type: 'Super' },
          arguments: [ { type: 'SpreadElement', argument: { type: 'Identifier', name: 'args' } } ]
        }
      }
    } : {
      type: 'FunctionExpression',
      params: [],
      body: { type: 'BlockStatement', body: [] }
    })),
    id: root,
    strict: true,
    type: (!expr || decl._porfDefaultName) ? 'FunctionDeclaration' : 'FunctionExpression',
    _selfAware: !!decl.superClass || privateMethods.length > 0,
    _onlyConstr: true,
    // a class's constructor: its prototype property is read-only
    _class: true,
    _subclass: !!decl.superClass,
    _superClassExpr: decl.superClass ? classSuperExpr() : null,
    _baseClassFieldInit: !decl.superClass && body.some(x => x.type === 'PropertyDefinition' && !x.static),
    ...(constructor ? { _closureSource: constructor } : {})
  };

  for (const x of body) {
    if (x.type === 'PropertyDefinition' && !x.static && x.value) {
      bindClassFieldInitializer(x.value, constructorDecl);
    }
  }

  const [ func ] = generateFunc(scope, constructorDecl);
  if (expr && name.includes('#')) func.jsName = name.split('#')[0];
  bindNamedFunction(scope, name, func);
  func.knownThisSlots = getKnownThisSlots(decl);
  func.generate();

  // the class being defined is its constructor, whatever its binding later holds (read
  // through the binding, a class whose name is assigned somewhere saw it uninitialised)
  const classRoot = reuseNamed(scope, materializeFunctionValue(scope, func));
  const rootIdent = { type: 'Identifier', name: classRoot[N_A] };

  // a closure's view of the class: the class itself, not a read of its name (an outer
  // binding of the same name, var C; class C {} in parse.js's wrapper, would answer that).
  // Before the elements, as the spec binds the class's inner name: a static initialiser
  // that reads the name through the closure env (static BASE = new C()) sees the class
  if (!expr && scope.closureOwnLocals?.[name]) mirrorToClosureEnv(scope, name, rootIdent);
  // code generated before this top-level class (an earlier class's methods) reads it through
  // a hoisted global (lookupHoistedVar): the class is its value from here
  if (!expr && scope.topLevel && scope.hoists?.get(name) === HOIST_LEXICAL && name in globals)
    assign(scope, Global(name, globals[name].type ?? T.jsval), coerceValue(classRoot, globals[name].type ?? T.jsval));

  const classProto = reuse(scope, generate(scope, getObjProp(rootIdent, 'prototype')));

  // a class declared once, at the program's top level, under a binding nothing reassigns:
  // its prototype (which cannot be replaced) kept where each new of it reads it (createThisArg)
  if (!expr && decl._protoGlobal) {
    allocVar(scope, decl._protoGlobal, true);
    assign(scope, Global(decl._protoGlobal, T.jsval), coerceValue(classProto, T.jsval));
  }

  // wire constructor + prototype chains to the superclass, null superclass included
  if (decl.superClass) {
    // a subclass (of Array, maybe) is a constructor an array's methods may have to species-create
    if (!globalThis.precompile) demandMember('species');
    const sup = reuseNamed(scope, generate(scope, decl.superClass));
    const supIdent = { type: 'Identifier', name: sup[N_A] };

    emitIf(scope, Bin('&&', T.i32, Bin('==', T.i32, JvType(sup), Const(T.i32, TYPES.object)), Un('!', T.i32, JvTruthy(sup))),
      () => exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrototype', [ classProto, valNull() ])),
      () => {
        exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrototype', [ classRoot, sup ]));
        exprStmt(scope, builtinCall(scope, '__Porffor_object_setPrototype', [ classProto, generate(scope, getObjProp(supIdent, 'prototype')) ]));
      });
  }

  // `this` in the (static) class body refers to the class itself
  scope.overrideThis = classRoot;

  const fieldInits = [];
  for (const x of body) {
    let { type, value, kind, static: _static, computed } = x;
    if (kind === 'constructor') continue;

    if (type === 'MethodDefinition') {
      value._method = true;
      value._noGlobalThis = true;
      // its [[HomeObject]]: super in it is this object's prototype, whatever this is
      // (through homeRef, which parse.js gives it: analysis saw that reference, not root)
      value._homeObject = _static ? (value.homeRef ?? root) : getObjProp(value.homeRef ?? root, 'prototype');
    }

    if (type === 'StaticBlock') {
      genStmt(scope, { type: 'BlockStatement', body: x.body });
      continue;
    }

    const key = getProperty(x, true);
    value ??= { type: 'Identifier', name: 'undefined' };
    const priv = x.key?._private;

    if (type === 'PropertyDefinition' && !_static) bindClassFieldInitializer(value, func.ast);

    if (isFuncType(value.type)) {
      const closureSource = value;
      let id = value.id;
      let noFuncIndex = false;
      if (typeof key.value === 'string' && !id) { id = { type: 'Identifier', name: key.value }; noFuncIndex = true; }
      value = { ...value, id, _noFuncIndex: noFuncIndex, strict: true, _noGlobalThis: true, _source: closureSource,
        _closureSource: closureSource._closureSource ?? closureSource,
        // an accessor's name is "get x" / "set x"
        ...((kind === 'get' || kind === 'set') && typeof key.value === 'string' ? { _jsName: kind + ' ' + key.value } : {}),
        ...(priv ? { _jsName: (kind === 'get' || kind === 'set' ? kind + ' #' : '#') + priv.name, _privateName: true } : {}) };
    }

    if (priv) {
      // a private element: on the class (static), each instance (a field, made by the
      // constructor), or the constructor's template of a method each instance gets a copy of
      // (a private auto-accessor, accessor #x, is as a private field: nothing sees the difference)
      const privKind = type === 'MethodDefinition' ? (kind === 'get' ? 2 : kind === 'set' ? 3 : 1) : 0;
      if (type === 'AccessorProperty' && !_static) bindClassFieldInitializer(value, func.ast);
      if ((type === 'PropertyDefinition' || type === 'AccessorProperty') && !_static) {
        fieldInits.push(...collect(func, () => exprStmt(func, builtinCall(func, '__Porffor_object_definePrivate', [
          generate(func, { type: 'ThisExpression', _noGlobalThis: true }), Global(priv.global, T.jsval), generate(func, value), Const(T.i32, privKind), Const(T.i32, 1) ]))));
      } else {
        exprStmt(scope, builtinCall(scope, '__Porffor_object_definePrivate', [
          classRoot, Global(priv.global, T.jsval), generate(scope, value), Const(T.i32, privKind), Const(T.i32, _static ? 1 : 2) ]));
      }
      continue;
    }

    if (type === 'PropertyDefinition' && !_static) {
      let keyNode;
      if (computed) {
        const keyGlobal = `#class_computed_prop${scope.start ?? scope.index}` + uniqId(scope);
        allocVar(scope, keyGlobal, true);
        assign(scope, Global(keyGlobal, T.jsval), toPropertyKey(scope, generate(scope, key), true));
        keyNode = () => Global(keyGlobal, T.jsval);
      } else keyNode = () => generate(func, key);

      fieldInits.push(...collect(func, () => exprStmt(func,
        builtinCall(func, '__Porffor_object_class_value', [
          generate(func, { type: 'ThisExpression', _noGlobalThis: true }), keyNode(), generate(func, value) ]))));
    } else {
      let initKind = type === 'MethodDefinition' ? 'method' : 'value';
      if (kind === 'get' || kind === 'set') initKind = kind;

      exprStmt(scope, builtinCall(scope, `__Porffor_object_class_${initKind}`, [
        _static ? classRoot : classProto,
        toPropertyKey(scope, generate(scope, key), computed),
        generate(scope, value)
      ]));
    }
  }

  delete scope.overrideThis;

  // the constructor must be invoked via `new`; field initialisers run after super() in a
  // subclass (at the marker generateCall left), else at the top of the body
  const guard = collect(func, () => emitIf(func, Un('!', T.i32, JvTruthy(Local('#newtarget', T.jsval))),
    () => internalThrow(func, 'TypeError', `Class constructor ${name} requires 'new'`)));
  if (privateMethods.length > 0) {
    const copies = collect(func, () => {
      const self = reuse(func, generate(func, { type: 'ThisExpression', _noGlobalThis: true }));
      for (const info of new Set(privateMethods.map(x => x.key._private)))
        exprStmt(func, builtinCall(func, '__Porffor_object_initPrivateMethod', [ self, Local('#callee', T.jsval), Global(info.global, T.jsval) ]));
    });
    fieldInits.unshift(...copies);
  }

  const markerIdx = func.body.indexOf(CLASS_FIELD_INIT_MARKER);
  if (markerIdx !== -1) func.body.splice(markerIdx, 1, ...fieldInits);
  else func.body.unshift(...fieldInits);
  func.body.unshift(...guard);

  return expr ? classRoot : valUndefined();
};

const generateTemplate = (scope, decl) => {
  let current = null;
  const append = val => {
    if (val.value && !byteStringable(val.value)) decl._type = TYPES.string;

    if (!current) {
      current = val;
      return;
    }

    current = {
      type: 'BinaryExpression',
      operator: '+',
      left: current,
      right: val,
      _template: true
    };
  };

  const { expressions, quasis } = decl;
  for (let i = 0; i < quasis.length; i++) {
    append({
      type: 'Literal',
      value: quasis[i].value.cooked
    });

    if (i < expressions.length) {
      append(expressions[i]);
    }
  }

  return generate(scope, current);
};

const generateTaggedTemplate = (scope, decl) => {
  const isRawCDefinitionBlock = str => /^\s*(?:static\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s+)+(?:\*\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*\)\s*\{/.test(str);
  const intrinsics = {
    __proto__: null,

    __Porffor_c: str => {
      if (Prefs.safe) throw new Error('Porffor.c is not allowed in --safe');
      if (scope.topLevel || isRawCDefinitionBlock(str)) {
        rawHead.push(str);
        return valUndefined();
      }
      stmt(scope, RawC(str, false));
      return valUndefined();
    },

    __Porffor_bs: str => makeString(scope, str, true),
    __Porffor_s: str => makeString(scope, str, false)
  };

  const { quasis, expressions } = decl.quasi;
  if (decl.tag.name in intrinsics) {
    let str = quasis[0].value.raw;

    // ${name} is the C name of a variable, or of a JS function made callable from C:
    // `jsval <name>(jsval, ...)`, one jsval per declared parameter, whatever types the
    // function was compiled with. render resolves the markers once C names are known.
    const cName = name => {
      if (lookupName(scope, name)[0] != null) return `\u0001${name}\u0001`;

      const func = resolveNamedFunction(scope, name);
      if (!func) throw new Error(`Porffor.c: ${name} is not a variable or function`);
      useFunctionValue(func);
      func.cCallable = true;
      return `\u0002${func.index}\u0002`;
    };

    for (let i = 0; i < expressions.length; i++) {
      const e = expressions[i];
      if (!e.name) {
        if (e.type === 'BinaryExpression' && e.operator === '+' && e.left.type === 'Identifier' && e.right.type === 'Literal') {
          str += cName(e.left.name) + e.right.value;
        }
      } else str += cName(e.name);

      str += quasis[i + 1].value.raw;
    }

    return intrinsics[decl.tag.name](str);
  }

  const strings = reuseNamed(scope, generate(scope, {
    type: 'ArrayExpression',
    elements: quasis.map(x => ({ type: 'Literal', value: x.value.cooked }))
  }));

  const tmpIdent = { type: 'Identifier', name: strings[N_A], _type: TYPES.array };
  exprStmt(scope, generate(scope, setObjProp(tmpIdent, 'raw', {
    type: 'ArrayExpression',
    elements: quasis.map(x => ({ type: 'Literal', value: x.value.raw }))
  })));

  return generate(scope, {
    type: 'CallExpression',
    callee: decl.tag,
    arguments: [ tmpIdent, ...expressions ]
  });
};

// anonymous functions are named by source position so a unit's text is stable
let anonymousId = 0;
const anonymousName = decl => globalThis.precompile || decl.start == null ? `#${globalThis.precompile ? 'builtin_' : ''}anonymous${anonymousId++}` : `#anonymous_${decl.start}`;
const uniqId = scope => '_' + (scope.uniqId = (scope.uniqId ?? 0) + 1);
let objectHackers = [], allObjectHackers = [];
const objectHack = node => {
  if (!node) return node;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = objectHack(node[i]);
    }
    return node;
  }

  if (node.type === 'MemberExpression') {
    return (() => {
      if (node.computed || node.optional || node.property.type === 'PrivateIdentifier') return;

      let objectName = node.object.name;
      if (node.object.object?.name === 'globalThis' && !node.object.computed) objectName = node.object.property.name;

      // block length/name: accessible on functions / need method receivers. 'call' passes:
      // the checks below only rewrite when a __X_call builtin exists (only Function.prototype.call)
      if (node.object.name !== 'Porffor' && (node.property.name === 'length' || node.property.name === 'name')) {
        return;
      }
      if (node.property.name === '__proto__') return;
      if (node.property.name === 'propertyIsEnumerable' || node.property.name === 'hasOwnProperty' || node.property.name === 'isPrototypeOf') return;

      if (node.object.type !== 'Identifier' && node.object.type !== 'MemberExpression') return;
      if (objectName && ['undefined', 'null', 'NaN', 'Infinity'].includes(objectName)) return;

      let objectOut;
      if (!objectName) {
        objectOut = objectHack(node.object);
        objectName = objectOut?.name?.slice?.(2);
      }
      if (!objectName || (!objectHackers.includes(objectName) && !objectHackers.some(x => objectName.startsWith(`${x}_`)))) return;

      const name = '__' + objectName + '_' + node.property.name;
      if ((!hasFuncWithName(name) && !(name in builtinVars) && !hasFuncWithName(name + '$get')) && (hasFuncWithName(objectName) || objectName in builtinVars || hasFuncWithName('__' + objectName) || ('__' + objectName) in builtinVars)) return;

      return {
        type: 'Identifier',
        name,
        _builtinMember: true
      };
    })() ?? {
      ...node,
      object: objectHack(node.object),
      property: node.computed ? objectHack(node.property) : node.property
    };
  }

  for (const x in node) {
    if (x[0] === '_') continue;
    const value = node[x];
    if (value != null && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          value[i] = objectHack(value[i]);
        }
      } else if (value.type) {
        node[x] = objectHack(value);
      }
    }
  }

  return node;
};

const funcByIndex = idx => {
  if (idx == null) return null;

  if (funcsByIndex[idx]) return funcsByIndex[idx];

  const func = funcs[idx];
  if (func && func.index === idx) return func;

  return funcs.find(x => x.index === idx);
};
const funcByName = name => funcByIndex(funcIndex[name]);
const hasAmbiguousFuncName = name => funcNameCollisions?.[name] === true;
const setFuncIndex = (name, index) => {
  if (funcIndex[name] != null && funcIndex[name] !== index) {
    funcNameCollisions[name] = true;
  }

  funcIndex[name] = index;
  factSet('hasFunc', name);
};
const bindNamedFunction = (scope, name, func) => {
  if (!scope || !name || !func) return;

  scope.namedFuncBindings ??= Object.create(null);
  scope.namedFuncBindings[name] = func;
};
const resolveNamedFunction = (scope, name) => {
  for (let cursor = scope; cursor; cursor = cursor.parentFunc) {
    const func = cursor.namedFuncBindings?.[name];
    if (func) return func;
    // a variable or parameter of this name (const f = () => ..., a callback's resolve)
    // shadows any function declared by it further out: which function it holds is not known
    if (cursor.locals && Object.hasOwn(cursor.locals, name)) return null;
  }

  // (a top-level variable, the same)
  if (globals && Object.hasOwn(globals, name)) return null;
  if (!hasAmbiguousFuncName(name)) return funcByName(name);
  return null;
};

const builtinFuncByName = name => {
  const normal = funcByName(name);
  if (!normal || normal.internal) return normal;

  return funcs.find(x => x.name === name && x.internal);
};
let irFinalizers;
const onFinalize = fn => { (irFinalizers ??= []).push(fn); };

// Facts: what the program has, each only ever becoming true as it grows: a function in it
// (hasFunc), a type used (hasType), a property name read (member), a program flag (program),
// a built-in prototype read whole (full). What a builtin keeps waits on them (whenFact): its
// choice for a fact is taken as soon as the fact holds; the other only once nothing more can
// become true (settleFacts), one at a time. So nothing is left out for a fact that holds in
// the end, whatever order the program was put together in
let factWaiters, factQueue, factPending;
const factKey = (kind, value) => `${kind}:${value}`;
const factHolds = (kind, value) => {
  switch (kind) {
    case 'hasFunc': return funcIndex[value] != null;
    case 'hasType': return usedTypes.has(value);
    case 'member': return memberDemands.has(value) || calledMembers.has(value);
    case 'program': return programFlagValue(value);
    case 'full': return fullPrototypes.has(value);
    case 'indirect': return funcIndex[value] != null && !!funcByName(value).indirect;
  }
  throw new Error(`unknown fact kind ${kind}`);
};

// when any of facts ([ kind, value ] each) holds, then(); else(), if any, once none can. A
// pure else adds nothing to the program (a flag's empty branch): those give up together
const whenFact = (facts, then, els = null, pure = false) => {
  const waiter = { facts, then, els, pure, state: 0 }; // 0 waiting, 1 taken, 2 given up (else)
  if (facts.some(([ kind, value ]) => factHolds(kind, value))) {
    waiter.state = 1;
    factQueue.push(then);
    return;
  }

  for (const [ kind, value ] of facts) {
    const key = factKey(kind, value);
    let list = factWaiters.get(key);
    if (!list) factWaiters.set(key, list = []);
    list.push(waiter);
  }
  // (one with no else never gives up: taken late, it has left nothing out)
  if (els) factPending.push(waiter);
};

// a fact became true: its waiters' choices are taken (queued: run where the IR is settled)
const factSet = (kind, value) => {
  if (!factWaiters) return;
  const key = factKey(kind, value);
  const list = factWaiters.get(key);
  if (!list) return;
  factWaiters.delete(key);
  for (const waiter of list) {
    if (waiter.state === 1) continue;
    if (waiter.state === 2) throw new Error(`porffor: ${key} became true after a builtin was built without it`);
    waiter.state = 1;
    factQueue.push(waiter.then);
  }
};

const drainFacts = () => {
  let ran = false;
  while (factQueue.length !== 0) {
    ran = true;
    factQueue.shift()();
  }
  return ran;
};

// nothing more is coming from the program: the waiters still waiting give up. First those
// whose else adds to the program, one at a time (what it adds may make a fact true, and its
// waiters are taken before the next gives up), then the pure ones, all at once (they add
// nothing: giving up cannot change another's fact). false once none is left
const giveUpFact = () => {
  factPending = factPending.filter(x => x.state === 0);
  if (factPending.length === 0) return false;

  const impure = factPending.find(x => !x.pure);
  const giving = impure ? [ impure ] : factPending;
  for (const waiter of giving) {
    waiter.state = 2;
    factQueue.push(waiter.els);
  }
  factPending = factPending.filter(x => x.state === 0);
  return true;
};

const programFlagValue = name => name === 'usesIterProtocol' ? usesIterProtocol : name === 'resizableBuffers' ? resizableBuffers : name === 'errorCause' ? errorCause : name === 'typedArrayCtorValue' ? typedArrayCtorValue : name === 'typedArrays' ? typedArraysUsed : name === 'regexScripts' ? regexScripts : name === 'regexStrings' ? regexStrings : name === 'regexEmoji' ? regexEmoji : false;

const generateFunc = (scope, decl, forceNoExpr = false) => {
  doNotMarkFuncRef = false;

  if (!decl.id) decl.id = { type: 'Identifier', name: anonymousName(decl) };
  const name = decl.id.name;
  const topLevel = !!decl._topLevel || decl.type === 'Program';
  const directCallOnly =
    !scope.topLevel &&
    decl.type === 'FunctionDeclaration' &&
    directCallOnlyFunctionNode(decl);
  if (decl.type.startsWith('Class')) {
    const out = generateClass(scope, { ...decl, id: { name } });
    const func = resolveNamedFunction(scope, name);
    return [ func, out ];
  }

  const params = decl.params ?? [];
  const arrow = decl.type === 'ArrowFunctionExpression' || decl.type === 'Program';

  const func = {
    start: decl.start,
    locals: Object.create(null),
    name,
    index: currentFuncIndex++,
    arrow,
    topLevel,
    constr: !directCallOnly && !arrow && !decl.generator && !decl.async && !decl._method, // constructable
    method: !arrow && (decl._method || decl.generator || decl.async), // has this, not constructable
    async: decl.async,
    generator: decl.generator,
    subclass: decl._subclass, _onlyConstr: decl._onlyConstr, _noGlobalThis: decl._noGlobalThis, isClass: !!decl._class,
    // what the Function constructor makes is strict only by its own directive
    strict: decl._constructed ? false : scope.strict || decl.strict,
    usesArguments: decl._usesArguments,
    ast: decl,
    unit: decl._unit ?? scope.unit,
    parentFunc: scope.name ? scope : null,
    selfAware: !!decl._selfAware,
    directCallOnly,
    inEval: !!decl._evalBody,
    closureCaptures: decl._captures && Object.keys(decl._captures).length > 0 ? decl._captures : null,
    closureOwnLocals: decl._capturedVars && Object.keys(decl._capturedVars).length > 0 ? decl._capturedVars : null,
    closureCapturesThis: decl._capturesThis ?? null,
    closurePassThrough: !!decl._closurePassThrough,
    closureAware: decl.type !== 'Program' && closureAwareFunc({
      internal: false,
      name,
      topLevel,
      noClosureEnv: decl._noClosureEnv,
      closureCaptures: decl._captures && Object.keys(decl._captures).length > 0 ? decl._captures : null,
      closureCapturesThis: decl._capturesThis ?? null,
      closurePassThrough: !!decl._closurePassThrough
    }),
    closureOwnThis: !!decl._capturedThis,
    closureOwnNewTarget: !!decl._capturedNewTarget,
    // super() in an arrow finds the parent class through the constructor itself
    closureOwnCallee: !!decl._capturedSuperCall && !!decl._superClassExpr,
    knownThisSlots: !arrow && !decl.generator && !decl.async && !decl._method ? getKnownThisSlots(decl) : null,

    // render's C signature return type (IR T.*), porffor TYPES inference type rides in
    // `returnType`, coroutine kind in `flags` (async/generator bodies are otherwise plain)
    retType: topLevel ? T.none : T.jsval,
    returnType: topLevel ? TYPES.undefined : undefined,

    generate() {
      if (func.body) return func.body;
      initBuilder(func);
      for (const p of func.params) func.locals[p.name] = { type: p.type, metadata: { param: true } };

      let body = decl.body;
      if (decl.type === 'ArrowFunctionExpression' && decl.expression) {
        // expression body desugars to a return
        body = { type: 'ReturnStatement', argument: decl.body };
      }

      if (globalThis.precompile) {
        globalThis.funcBodies ??= {};
        globalThis.funcBodies[name] = body;
      }

      markVarHoists(func, body, !!decl._module);

      // pick numeric var storage before emitting refs
      if (!func.topLevel) {
        for (const [localName, variable] of Object.entries(decl._variables ?? {})) {
          if (func.hoists?.get(localName) !== HOIST_DECL) continue;
          if (variable.node?._storageType !== TYPES.number) continue;
          if (!variable.node._storageInitSeen || variable.node._storageHazardRef) continue;
          if (func.closureOwnLocals?.[localName] || func.closureCaptures?.[localName]) continue;
          allocVar(func, localName, false, T.f64);
        }
      }

      // hoist function decls so earlier calls stay direct (module inits hoist their own)
      const moduleInits = decl.type === 'Program' && !decl._module && body.body.some(x => x._unit != null);
      if (body.type === 'BlockStatement' && !moduleInits) {
        let b = body.body, j = 0;
        if (b[0]?.directive) j++;
        for (let i = 0; i < b.length; i++) {
          if (b[i].type === 'FunctionDeclaration') b.splice(j++, 0, b.splice(i, 1)[0]);
        }
      }

      func.identFailEarly = true;

      if (hasClosureOwnEnv(func)) {
        const count = closureLayout(func).count;
        const parent = reuse(func, func.closureAware ? valOf(Local('#env', T.ptr), TYPES.__porffor_closureenv) : valUndefined());
        allocVar(func, '#closure_env_local');
        setLocalWithType(func, '#closure_env_local', false, makeClosureEnv(func, parent, count), false, TYPES.__porffor_closureenv);
        // the parameters copied in next need no barrier while nothing can collect
        func.freshEnv = freshMark(func);
      }

      // a named function expression sees its own name
      if (decl.type === 'FunctionExpression' && decl.id?.name && func.selfAware) {
        const selfName = decl._variable?.internalName ?? func.name;
        allocVar(func, selfName);
        setVarMetadata(func, selfName, false, { kind: 'function-name' });
        setLocalWithType(func, selfName, false, Local('#callee', T.jsval), false, TYPES.function);
        if (func.closureOwnLocals?.[selfName]?.node === decl) mirrorToClosureEnv(func, selfName);
      }

      // dynamic calls can deliver any receiver: prototype builtins coerce or type-guard #this by annotated type
      if (globalThis.precompile && func.overrideThisType != null && name.includes('_prototype_') && !name.startsWith('__Porffor_')) {
        const t = func.overrideThisType;
        const thisRef = () => Local('#this', T.jsval);
        const prettyName = name.slice(2).replace('_prototype_', '.prototype.');
        const method = name.slice(name.indexOf('_prototype_') + '_prototype_'.length);
        if (t === TYPES.array) {
          // generic: any object can be this (a proxy, an array-like). The method runs on a
          // copy read through [[Get]] (__Porffor_array_snapshot); a mutating one then writes
          // what changed back through [[Set]] and [[Delete]], and gives back the object where
          // it returns this. The final state is the spec's; the order of the traps is not
          emitIf(func, Bin('!=', T.i32, JvType(thisRef()), Const(T.i32, TYPES.array)), () => {
            // an iteration method runs the spec's steps on the object itself
            // (builtins/array_generic.ts): what a callback or a getter changes as it goes counts
            if (ARRAY_GENERIC.has(method)) {
              // (a rest parameter goes as the array it is)
              const userParams = func.params.filter(p => p.name[0] !== '#' || p.name === '#rest').map(p => Local(p.name, p.type));
              stmt(func, Return(builtinCall(func, `__Porffor_arrayGeneric_${method}`, [ thisRef(), ...userParams ])));
              return;
            }
            if (!ARRAY_MUTATORS.has(method)) {
              assign(func, thisRef(), builtinCall(func, '__Porffor_array_snapshot', [ thisRef() ]));
              return;
            }
            allocVar(func, '#array_orig');
            allocVar(func, '#array_before');
            const orig = Local('#array_orig', T.jsval);
            const before = Local('#array_before', T.jsval);
            assign(func, orig, thisRef());
            assign(func, thisRef(), builtinCall(func, '__Porffor_array_snapshot', [ orig ]));
            assign(func, before, builtinCall(func, '__Porffor_array_snapshot', [ thisRef() ]));
            const result = reuse(func, Call(func.index, func.params.map(p => Local(p.name, p.type)), func.retType));
            exprStmt(func, builtinCall(func, '__Porffor_array_writeBack', [ orig, before, thisRef() ]));
            stmt(func, Return(ARRAY_RETURNS_THIS.has(method) ? orig : result));
          });
        } else if (t === TYPES.string) {
          emitIf(func, Bin('!=', T.i32, JvType(thisRef()), Const(T.i32, TYPES.string)), () => {
            const nonNullish = () => internalThrow(func, 'TypeError', `${prettyName} expects 'this' to be non-nullish`);
            emitIf(func, Bin('==', T.i32, JvType(thisRef()), Const(T.i32, TYPES.undefined)), nonNullish);
            emitIf(func, Bin('==', T.i32, JvType(thisRef()), Const(T.i32, TYPES.object)),
              () => emitIf(func, Bin('==', T.i32, JvPtr(thisRef()), Const(T.u32, 0)), nonNullish));
            assign(func, thisRef(), builtinCall(func, '__ecma262_ToString', [ thisRef() ]));
            emitIf(func, Bin('==', T.i32, JvType(thisRef()), Const(T.i32, TYPES.bytestring)),
              () => assign(func, thisRef(), builtinCall(func, '__Porffor_bytestringToString', [ thisRef() ])));
          });
        } else if ([
          TYPES.number, TYPES.promise, TYPES.symbol, TYPES.function,
          TYPES.set, TYPES.map, TYPES.weakref, TYPES.weakset, TYPES.weakmap,
          TYPES.arraybuffer, TYPES.sharedarraybuffer, TYPES.dataview,
          TYPES.textencoder, TYPES.textdecoder, TYPES.disposablestack, TYPES.asyncdisposablestack
        ].includes(t) ||
          // typed arrays hold their elements in slots of their own; so does a RegExp, for all
          // but its generic flags getter and toString
          (t !== TYPES.array && TYPE_NAMES[t]?.endsWith('Array')) ||
          (t === TYPES.regexp && method !== 'flags$get' && method !== 'toString')) {
          let guard = () => internalThrow(func, 'TypeError', `${prettyName} expects 'this' to be a ${TYPE_NAMES[t]}`);
          // a RegExp getter read off RegExp.prototype itself (as an accessor is, by any read of
          // it): source is "(?:)" there and the flags undefined
          if (t === TYPES.regexp && method.endsWith('$get'))
            guard = () => stmt(func, Return(builtinCall(func, '__Porffor_regexp_offTypeGetter', [ thisRef(), Box(Const(T.f64, method === 'source$get' ? 1 : 0), Const(T.i32, TYPES.boolean)) ])));
          emitIf(func, Bin('!=', T.i32, JvType(thisRef()), Const(T.i32, t)),
            t === TYPES.number
              ? () => emitIf(func, Bin('!=', T.i32, JvType(thisRef()), Const(T.i32, TYPES.numberobject)), guard)
              : guard);
        }
      }

      if (hasClosureOwnEnv(func) && func.closureOwnThis) mirrorToClosureEnv(func, '#this', { type: 'ThisExpression' });
      if (hasClosureOwnEnv(func) && func.closureOwnNewTarget) mirrorToClosureEnv(func, '#newtarget', { type: 'MetaProperty', meta: { type: 'Identifier', name: 'new' }, property: { type: 'Identifier', name: 'target' } });
      if (hasClosureOwnEnv(func) && func.closureOwnCallee) mirrorToClosureEnv(func, '#callee', { type: 'Identifier', name: '#callee' });
      if (func.closureOwnLocals?.arguments) mirrorToClosureEnv(func, 'arguments');

      // a program's arguments object: marked, for its Object.prototype and non-array identity
      if (func.usesArguments && !globalThis.precompile)
        exprStmt(func, Call('porf_arr_mark_arguments', [ JvPtr(Local('#allargs', T.jsval)) ], T.none));

      for (let i = 0; i < args.length; i++) {
        const { name: argName, def, destr, type, inferredType } = args[i];
        if (args[i].rest) allocVar(func, argName);
        if (type) {
          const typeAnno = extractTypeAnnotation(type);
          addVarMetadata(func, argName, false, typeAnno);
          if (typeAnno.types) for (const x of typeAnno.types) typeUsed(func, x);
        } else if (inferredType != null) {
          addVarMetadata(func, argName, false, { type: inferredType });
          typeUsed(func, inferredType);
        }

        if (args[i].rest) {
          setLocalWithType(func, argName, false, Local('#rest', T.jsval), false, TYPES.array);
          if (hasClosureOwnEnv(func) && func.closureOwnLocals?.[argName]) mirrorToClosureEnv(func, argName);
          // ...[a, ...b] / ...{ length }: the rest array destructured into the pattern's names
          if (destr) generateVarDstr(func, 'var', destr, { type: 'Identifier', name: argName }, undefined, false);
          continue;
        }

        if (def) {
          const ref = Local(argName, func.locals[argName]?.type ?? T.jsval);
          if (ref[N_TYPE] === T.jsval) emitIf(func, Bin('==', T.i32, JvType(ref), Const(T.i32, TYPES.undefined)), () => {
            const known = getNodeType(func, def);
            const value = generate(func, def, argName);
            assign(func, ref, value[N_TYPE] === T.jsval ? value : known != null && known !== TYPES.number ? valOf(value, known) : valNumber(value));
          });
        }

        if (destr) generateVarDstr(func, 'var', destr, { type: 'Identifier', name: argName }, undefined, false);

        // mirror as each param settles, a later default may be a closure reading it
        if (hasClosureOwnEnv(func) && func.closureOwnLocals?.[argName]) mirrorToClosureEnv(func, argName);
      }

      func.identFailEarly = false;

      if (func.coroInit) yieldPoint(func, valUndefined());

      if (decl._baseClassFieldInit) stmt(func, CLASS_FIELD_INIT_MARKER);

      if (moduleInits) generateModules(func, body.body);
      else genStmt(func, body);

      if (func.topLevel && !decl._module) {
        func.export = true;

        // drain the microtask queue at program end when promises exist: named, or made by
        // an async function (an await resumes from a job, with no Promise builtin named)
        if (('Promise' in funcIndex) || ('__Porffor_promise_create' in funcIndex) || ('__Promise_resolve' in funcIndex) || ('__Promise_reject' in funcIndex) ||
          funcs.some(f => f?.async)) {
          exprStmt(func, builtinCall(func, '__Porffor_promise_runJobs', []));
        }
      }

      // implicit return on fall-off, via generateReturn so constructor coercion and void handling apply
      if (func.body.at(-1)?.[N_KIND] !== K.Return) generateReturn(func, {});

      return func.body;
    }
  };
  // the source node's compiled function, for a devirtualized call to find (--devirtualize); a
  // class or object literal method is compiled from a copy of its node, which names the
  // original (_source, _closureSource)
  decl._compiledFunc = func;
  const source = decl._source ?? decl._closureSource;
  if (source) source._compiledFunc = func;
  decl._porfforFunc = func;

  if (!decl._method && !decl._noFuncIndex) setFuncIndex(name, func.index);
  if (decl.type === 'FunctionDeclaration') bindNamedFunction(scope, name, func);
  if (func.topLevel && !decl._module) topLevelFunc = func;
  funcs.push(func);
  funcsByIndex[func.index] = func;

  if (typedInput && decl.returnType) {
    // unwrap Promise<T> for async functions
    const { type, types, irType } = extractTypeAnnotation(decl.returnType, func.async && !func.generator);
    if (irType != null) {
      func.retType = irType;
      // a raw return type cannot carry the constructed object
      if (irType !== T.jsval) func.constr = false;
    }
    if (type != null) { typeUsed(func, type); func.returnType = type; }
    else if (types != null) { func.returnTypes = types; for (const x of types) typeUsed(func, x); }
  }

  const args = [];
  // ExpectedArgumentCount: the parameters before the first with a default or a rest one
  let jsLength = 0, counting = true;
  for (let i = 0; i < params.length; i++) {
    let argName, def, destr, typeAnnotation;
    const x = params[i];
    switch (x.type) {
      case 'Identifier': {
        argName = x.name;
        typeAnnotation = x.typeAnnotation;
        if (globalThis.precompile && argName === '_argc') { func.usesArguments = true; continue; }
        if (globalThis.precompile && i === 0 && argName === 'this' && !arrow) {
          // a TS this-param types the receiver, it is not a real argument
          func.method = true;
          func.constr = false;
          func._noGlobalThis = true;
          if (typeAnnotation) func.overrideThisType = extractTypeAnnotation(x).type;
          continue;
        }
        if (counting) jsLength++;
        break;
      }
      case 'AssignmentPattern': {
        counting = false;
        def = x.right;
        typeAnnotation = x.typeAnnotation ?? x.left.typeAnnotation;
        if (x.left.name) argName = x.left.name;
        else { argName = '#arg_dstr' + i; destr = x.left; }
        break;
      }
      case 'RestElement': {
        counting = false;
        argName = x.argument.name ?? ('#arg_dstr' + i);
        if (!x.argument.name) destr = x.argument;
        func.hasRestArgument = true;
        args.push({ name: argName, destr, rest: true, type: typedInput && (x.typeAnnotation ?? x.argument.typeAnnotation) });
        continue;
      }
      default:
        argName = '#arg_dstr' + i; destr = x; if (counting) jsLength++; break;
    }
    args.push({ name: argName, def, destr, type: typedInput && typeAnnotation,
      inferredType: !def && !destr ? decl._directParamTypes?.[args.length] : null });
  }

  // sloppy duplicate params: the last is the visible binding, earlier ones become hidden
  // slots so they still receive their positional argument without redeclaring the C param
  for (let i = 0; i < args.length; i++) {
    if (args[i].name[0] === '#') continue;
    for (let j = i + 1; j < args.length; j++) {
      if (args[j].name === args[i].name) {
        args[i].name = '#dupe_arg' + i + '_' + args[i].name;
        break;
      }
    }
  }

  func.coroInit = func.generator && args.some(a => a.def || a.destr);

  func.params = [];
  if (func.selfAware) func.params.push({ name: '#callee', type: T.jsval });
  if (func.closureAware) func.params.push({ name: '#env', type: T.ptr });
  if (func.constr) func.params.push({ name: '#newtarget', type: T.jsval }, { name: '#this', type: T.jsval });
  if (func.method) func.params.push({ name: '#this', type: T.jsval });
  for (const a of args) func.params.push(a.rest ? { name: '#rest', type: T.jsval } : {
    name: a.name,
    type: a.type ? (extractTypeAnnotation(a.type).irType ?? T.jsval) : (a.inferredType === TYPES.number ? T.f64 : T.jsval)
  });
  if (func.usesArguments) func.params.push({ name: '#allargs', type: T.jsval });

  for (const p of func.params) func.locals[p.name] = { type: p.type, metadata: { param: true } };

  func.jsLength = jsLength;
  if (decl._jsName) func.jsName = decl._jsName;
  if (decl._privateName) func.privateName = true;

  if (func.topLevel) func.generate();
  if (globalThis.precompile) func.generate();

  if (decl._doNotMarkFuncRef) doNotMarkFuncRef = true;
  const out = decl.type.endsWith('Expression') && !forceNoExpr ? materializeFunctionExpr(scope, func) : valUndefined();
  doNotMarkFuncRef = false;
  return [ func, out ];
};

// each module's top level becomes an init function in its unit, unitless statements stay in #main
const generateModules = (scope, body) => {
  let unit = null, group = [];
  const flush = () => {
    if (group.length === 0) return;
    // the program's top-level bindings that closures capture (block-scoped ones, per-iteration
    // loop ones) live in the env of the function running that code: here the module's
    const [ func ] = generateFunc(scope, { type: 'Program', id: { name: `#mod_${unit}` }, _module: true, _unit: unit, strict: scope.strict,
      _capturedVars: scope.ast?._capturedVars, _closureSource: scope.ast?._program, body: { type: 'BlockStatement', body: group } });
    exprStmt(scope, Call(func.index, [], T.none));
    group = [];
  };
  for (const x of body) {
    if (x._unit == null) { flush(); genStmt(scope, x); continue; }
    if (x._unit !== unit) { flush(); unit = x._unit; }
    group.push(x);
  }
  flush();
};

const generateBlock = (scope, decl) => {
  // a block's function declarations exist from its start (called or read before their line),
  // after its directives ("use strict" stays first)
  let j = 0;
  while (decl.body[j]?.directive) j++;
  for (let i = j; i < decl.body.length; i++) {
    if (decl.body[i].type === 'FunctionDeclaration') {
      if (i !== j) decl.body.splice(j, 0, decl.body.splice(i, 1)[0]);
      j++;
    }
  }

  // the block's boxed bindings are new on each entry, before its functions snapshot them
  for (const k in decl._variables ?? {}) {
    const name = decl._variables[k].node?.name;
    if (name != null && ownBoxedBinding(scope, name)) allocBindingBox(scope, name);
  }

  inferBranchStart(scope);
  let last = -1;
  if (scope.inEval) {
    for (let i = decl.body.length - 1; i >= 0; i--) {
      if (isEmptyNode(decl.body[i])) continue;
      if (decl.body[i].type === 'ExpressionStatement') last = i;
      break;
    }
  }

  let out = null;
  for (let i = 0; i < decl.body.length; i++) {
    const x = decl.body[i];
    if (isEmptyNode(x)) continue;
    if (i === last) out = generate(scope, x);
    else genStmt(scope, x);

    // `if (x === undefined) return;`: the rest of the block runs only where the test failed
    if (x.type === 'IfStatement' && x.alternate == null && alwaysExits(x.consequent))
      narrow(scope, guardFacts(scope, x.test, false));
  }
  inferBranchEnd(scope);
  return out ?? valUndefined();
};

const staticDirectArgType = node => {
  if (!node) return null;
  if (typeof node._type === 'number') return node._type;
  if (node.type === 'Literal') {
    if (node.bigint != null) return TYPES.bigint;
    if (node.value === null) return TYPES.object;
    if (node.regex) return TYPES.regexp;
    if (typeof node.value === 'string') return byteStringable(node.value) ? TYPES.bytestring : TYPES.string;
    return TYPES[typeof node.value] ?? null;
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return TYPES.undefined;
    if (node.name === 'NaN' || node.name === 'Infinity') return TYPES.number;
    if (node._resolvedVariable?.node?._directInferredType != null)
      return node._resolvedVariable.node._directInferredType;
    if (!node._noStorageInfer && node._resolvedVariable?.node?._storageType === TYPES.number) return TYPES.number;
    return null;
  }
  if (node.type === 'UnaryExpression') {
    if (node.operator === '!') return TYPES.boolean;
    if (node.operator === 'void') return TYPES.undefined;
    if (node.operator === 'typeof') return TYPES.bytestring;
    if (node.operator === 'delete') return TYPES.boolean;
    const t = staticDirectArgType(node.argument);
    if (node.operator === '+') return TYPES.number;
    return t === TYPES.bigint || t === TYPES.number ? t : null;
  }
  if (node.type === 'BinaryExpression') {
    if (['==', '===', '!=', '!==', '>', '>=', '<', '<=', 'instanceof', 'in'].includes(node.operator)) return TYPES.boolean;
    const l = staticDirectArgType(node.left), r = staticDirectArgType(node.right);
    if (l === TYPES.bigint || r === TYPES.bigint)
      return l === TYPES.bigint && r === TYPES.bigint ? TYPES.bigint : null;
    if (node.operator !== '+') return l === TYPES.number && r === TYPES.number ? TYPES.number : null;
    return l === TYPES.number && r === TYPES.number ? TYPES.number : null;
  }
  if (node.type === 'UpdateExpression') {
    const t = staticDirectArgType(node.argument);
    return t === TYPES.bigint || t === TYPES.number ? t : null;
  }
  if (node.type === 'AssignmentExpression') {
    if (node.operator === '=') return staticDirectArgType(node.right);
    if (['||=', '&&=', '??='].includes(node.operator)) return null;
    const l = staticDirectArgType(node.left), r = staticDirectArgType(node.right);
    if (node.operator !== '+=') {
      if (l === TYPES.bigint || r === TYPES.bigint)
        return l === TYPES.bigint && r === TYPES.bigint ? TYPES.bigint : null;
      return l === TYPES.number && r === TYPES.number ? TYPES.number : null;
    }
    return l === TYPES.number && r === TYPES.number ? TYPES.number : null;
  }
  if (node.type === 'SequenceExpression') return staticDirectArgType(node.expressions.at(-1));
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const l = staticDirectArgType(node.consequent ?? node.left);
    const r = staticDirectArgType(node.alternate ?? node.right);
    return l != null && l === r ? l : null;
  }
  if (node.type === 'ArrayExpression') return TYPES.array;
  if (node.type === 'ObjectExpression') return TYPES.object;
  return null;
};

const inferDirectCallParamTypes = root => {
  const infos = new Map();
  for (const decl of root._directCallDecls ?? []) {
    if (directCallOnlyFunctionNode(decl)) infos.set(decl, decl._directCalls);
  }

  // propagate argument types through direct-only call chains
  let changed;
  do {
    changed = false;
    for (const [decl, calls] of infos) {
      for (let i = 0; i < (decl.params?.length ?? 0); i++) {
        const param = decl.params[i];
        if (param?.type !== 'Identifier' || param._directInferredType != null) continue;
        // a parameter the body assigns holds whatever it is given there (`tag = { tag, ... }`),
        // not only what its callers pass: its local keeps the general type
        if (param._writes) continue;

        let inferred = null;
        let valid = calls.length > 0;
        for (const call of calls) {
          let spread = false;
          for (let j = 0; j <= i; j++) if (call.arguments[j]?.type === 'SpreadElement') spread = true;
          const arg = call.arguments[i];
          const type = spread ? null : arg == null ? TYPES.undefined : staticDirectArgType(arg);
          if (type == null || (inferred != null && inferred !== type)) { valid = false; break; }
          inferred = type;
        }
        if (valid && inferred != null) {
          param._directInferredType = inferred;
          changed = true;
        }
      }
    }
  } while (changed);

  for (const [decl] of infos) {
    // only number has a specialized user-function ABI
    const inferred = (decl.params ?? []).map(param =>
      param._directInferredType === TYPES.number ? TYPES.number : undefined);
    if (inferred.some(type => type != null)) decl._directParamTypes = inferred;
  }
};

let globals, funcs, funcsByIndex, funcIndex, funcNameCollisions, currentFuncIndex, depth, data, dataUnits, dataRelocs, dataCache, modular, rawHead, builtinGlobalInits, includedBuiltinGlobalInits, usedTypes, globalInfer, builtinFuncs, builtinVars, builtinPrototypeFuncs, builtinStaticFuncs, builtinPrototypeGetters, builtinPrototypeObjectGetters, topLevelFunc, tdzGlobals, implicitGlobalNames, programWrittenNames;

// the names among Function.prototype's methods (bind, call, apply, toString) the program may give
// a function as its own: a class's static member, or an assignment (F.call = ...). A call of one
// of these on a function then looks for the function's own first; any other stays the builtin
const FUNCTION_METHOD_NAMES = new Set([ 'bind', 'call', 'apply', 'toString' ]);
let functionOwnMethodNames = new Set();
const scanFunctionOwnMethodNames = node => {
  const out = new Set();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if ((n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') && n.static && !n.computed && FUNCTION_METHOD_NAMES.has(n.key?.name)) out.add(n.key.name);
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && FUNCTION_METHOD_NAMES.has(n.left.property?.name)) out.add(n.left.property.name);
    for (const k in n) if (k[0] !== '_' && n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(node);
  return out;
};

// the methods a class extending a builtin with its own prototype methods (Uint8Array, Array, Map,
// ...) defines, by the builtin's name: a call of one of these on a value of that builtin's type
// looks at the value's prototype first (a subclass instance's override wins), any other call
// stays the builtin (node:buffer's Buffer overrides Uint8Array's toString, slice, fill...)
let subclassOverrides = new Map();
const scanSubclassOverrides = node => {
  const out = new Map();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.superClass?.type === 'Identifier') {
      const names = out.get(n.superClass.name) ?? new Set();
      for (const m of n.body?.body ?? []) {
        if (m.type === 'MethodDefinition' && !m.static && !m.computed && m.kind === 'method' && m.key?.name) names.add(m.key.name);
      }
      if (names.size > 0) out.set(n.superClass.name, names);
    }
    for (const k in n) if (k[0] !== '_' && n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(node);
  return out;
};

export default (program, opts = {}) => {
  const entryName = opts.entryName ?? '#main';
  functionOwnMethodNames = globalThis.precompile ? new Set() : scanFunctionOwnMethodNames(program);
  programStrings = globalThis.precompile ? new Set() : scanProgramStrings(program);
  resizableBuffers = globalThis.precompile ? true : programNames(program, new Set([ 'maxByteLength', 'resize', 'resizable' ]));
  errorCause = globalThis.precompile ? true : programNames(program, new Set([ 'cause' ]));
  programStringsDemanded = false;
  subclassOverrides = globalThis.precompile ? new Map() : scanSubclassOverrides(program);
  globals = Object.create(null);
  globals['#ind'] = 0;
  funcs = []; funcsByIndex = [];
  funcIndex = Object.create(null);
  funcNameCollisions = Object.create(null);
  depth = [];
  data = [];
  dataUnits = [];
  dataRelocs = [];
  dataCache = new Map();
  modular = !!program._units;
  rawHead = [];
  builtinGlobalInits = [];
  tdzGlobals = new Set();
  implicitGlobalNames = new Set();
  programWrittenNames = new Set();
  includedBuiltinGlobalInits = new Set();
  irFinalizers = [];
  memberDemands = new Set();
  typedArrayCtorValue = false;
  typedArraysUsed = false;
  calledMembers = new Set();
  usesIterProtocol = !!program._usesIterProtocol;
  // builtins are typed: a BigInt reaches their arithmetic only where they say so
  usesBigInt = !globalThis.precompile && !!program._usesBigInt;
  regexScripts = !globalThis.precompile && !!program._regexScripts;
  regexStrings = !globalThis.precompile && !!program._regexStrings;
  regexEmoji = !globalThis.precompile && !!program._regexEmoji;
  fullPrototypes.clear();
  topLevelFunc = null;
  factWaiters = new Map();
  factQueue = [];
  factPending = [];
  currentFuncIndex = 0;
  icSites = Object.create(null);
  usedTypes = new Set([ TYPES.undefined, TYPES.number, TYPES.boolean, TYPES.function ]);
  globalInfer = Object.create(null);

  if (!builtinFuncs) {
    builtinFuncs = BuiltinFuncs();
    builtinVars = BuiltinVars({ builtinFuncs });

    ({ methods: builtinPrototypeFuncs, getters: builtinPrototypeGetters, prototypeObjects: builtinPrototypeObjectGetters, statics: builtinStaticFuncs } =
      memberIndex(Object.keys(builtinFuncs), x => x in builtinFuncs));

    const getObjectName = x => x.startsWith('__') && x.slice(2, x.indexOf('_', 2));
    allObjectHackers = [ ...new Set(Object.keys(builtinFuncs).map(getObjectName).concat(Object.keys(builtinVars).map(getObjectName)).filter(x => x)) ];
    semantic.objectHack = objectHack;
  }

  if (!globalThis.precompile) startMemberDemands();

  // a user binding shadowing a builtin name, at any depth, disables the object hack for it
  // program-wide: its member accesses are real property accesses (pdfjs's own `Promise`)
  {
    const userDecls = new Set();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      switch (node.type) {
        case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
          if (node.id) patternNames(node.id, userDecls);
          for (const p of node.params) patternNames(p, userDecls);
          break;
        case 'ClassDeclaration': case 'ClassExpression':
          if (node.id) patternNames(node.id, userDecls);
          break;
        case 'VariableDeclarator': patternNames(node.id, userDecls); break;
        case 'CatchClause': patternNames(node.param, userDecls); break;
        // a bare name written with no binding: a sloppy implicit global
        case 'AssignmentExpression': case 'ForInStatement': case 'ForOfStatement': {
          const target = node.left;
          if (target?.type === 'Identifier' && !target._resolvedBinding) implicitGlobalNames.add(target.name);
          break;
        }
        case 'UpdateExpression':
          if (node.argument?.type === 'Identifier' && !node.argument._resolvedBinding) implicitGlobalNames.add(node.argument.name);
          break;
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object' && k[0] !== '_') walk(v);
      }
    };
    // a builtin's own `export const Int8Array` is no user binding: precompile keeps the hack
    if (!globalThis.precompile) walk(program.body);
    objectHackers = userDecls.size > 0 ? allObjectHackers.filter(x => !userDecls.has(x)) : allObjectHackers;
    semantic.objectHackers = objectHackers;
  }
  // every name assigned anywhere (not its declaration): an opaque program (with, eval) all of them
  {
    const { written, opaque } = writtenNames(program);
    programWrittenNames = opaque ? { has: () => true } : written;
  }
  markInBoundsIndexes(program);
  // --devirtualize=N: every function defined as a method, by name (see devirtualizedCall)
  methodIndex = Prefs.devirtualize ? indexMethods(program) : null;
  devirtualizeTally = Prefs.devirtualizeLog ? new Map() : null;
  devirtualizeSites = [];

  // top-level classes nothing rebinds: where each keeps its prototype for new (generateClass)
  for (const x of program.body) {
    if (x.type !== 'ClassDeclaration' || !x.id || x._writes || x.id._writes) continue;
    x._protoGlobal = `#proto#${x.id.name}`;
    x.id._classDeclaration = x;
  }
  if (program._usesTemporal) {
    const polyfillAst = parse(temporalPolyfillSource);
    const polyfill = polyfillAst.body;
    if (program._units) for (const x of polyfill) x._unit = 'temporal';
    program.body = polyfill.concat(program.body);
    // what the prelude's own code needs (its BigInts, its regexes), as the program's parse
    // would have found had it been there, and what depends on it
    for (const flag of [ '_usesBigInt', '_usesIterProtocol', '_regexScripts', '_regexStrings', '_regexEmoji' ])
      if (polyfillAst[flag]) program[flag] = true;
    usesIterProtocol = !!program._usesIterProtocol;
    usesBigInt = !globalThis.precompile && !!program._usesBigInt;
    regexScripts = !globalThis.precompile && !!program._regexScripts;
    regexStrings = !globalThis.precompile && !!program._regexStrings;
    regexEmoji = !globalThis.precompile && !!program._regexEmoji;
  }

  // todo/perf: make this lazy per func (again)
  // semantic relies on object hack happening before
  program = objectHack(program);
  if (Prefs.closures) program = semantic(program);
  // --inline: calls returning a fresh literal that then stays local are inlined (inline.js);
  // --escape (which --inline turns on): literals that never leave their function become one
  // local per field (escape.js)
  if (Prefs.inline && Prefs.closures && !globalThis.precompile) program = inlineCalls(program);
  if ((Prefs.escape || Prefs.inline) && Prefs.closures && !globalThis.precompile) program = escapeAnalysis(program);
  if (Prefs.p) {
    const last = getLastNode(program.body);
    const lastIndex = program.body.indexOf(last);
    if (lastIndex !== -1 && last.type === 'ExpressionStatement') {
      program.body.splice(lastIndex, 1,
        {
          type: 'VariableDeclaration', kind: 'const',
          declarations: [ { type: 'VariableDeclarator', id: identNode('#repl_result'), init: last.expression } ]
        },
        {
          type: 'ExpressionStatement',
          expression: { type: 'CallExpression', callee: identNode('__Porffor_promise_runJobs'), arguments: [] }
        },
        {
          ...last,
          expression: { type: 'CallExpression', callee: identNode('__console_log'), arguments: [ identNode('#repl_result') ] }
        }
      );
    }
  }
  inferDirectCallParamTypes(program);

  // globalThis.x = v anywhere makes x a global binding, but only once codegen reaches that
  // assignment: a function generated before it (a bundle's library code, ahead of the shim
  // that installs setTimeout) would compile its reads of x as not defined. Every such name
  // is a global from the start.
  // A top-level function of that name is then that global's first value: its declaration counts
  // the write, so the hoisted declaration stores the function (as `var f; function f() {}` does)
  // and its reads see the binding, not an uninitialised global.
  const topLevelFunctions = new Map();
  for (const x of program.body) if (x.type === 'FunctionDeclaration' && x.id?.name) topLevelFunctions.set(x.id.name, x);
  const declareGlobalThisNames = node => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(declareGlobalThisNames);
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const name = globalThisBindingName(node.left);
      if (name) {
        allocVar(null, name, true);
        setVarMetadata(null, name, true, { kind: 'var' });
        const declaration = topLevelFunctions.get(name);
        if (declaration) declaration._writes = (declaration._writes ?? 0) + 1;
      }
    }
    for (const key in node) {
      if (key[0] === '_' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (value && typeof value === 'object') declareGlobalThisNames(value);
    }
  };
  declareGlobalThisNames(program.body);

  generateFunc({}, {
    type: 'Program',
    id: { name: entryName },
    _topLevel: true,
    strict: Prefs.module,
    _program: program,
    _captures: program._captures,
    _capturedVars: program._capturedVars,
    _capturesThis: program._capturesThis,
    _capturedThis: program._capturedThis,
    _variables: program._variables,
    _variableIds: program._variableIds,
    _usesArguments: program._usesArguments,
    body: {
      type: 'BlockStatement',
      body: program.body
    }
  });

  if (!globalThis.precompile && funcs.some(f => f.async && !f.generator))
    includeBuiltin(topLevelFunc, '__Porffor_promise_resolve');

  for (const f of funcs.slice()) if (f.referenced || f.export) f.generate?.();

  // until nothing changes: the finalizers, the functions they bring in, and the choices taken
  // for facts that came to hold; then the next of those waiting on a fact gives up (settled
  // program-wide only once nothing more can come)
  for (let pass = 0, steady = 0; ; pass++) {
    const beforeFinalizers = irFinalizers.length;
    const beforeFuncs = funcs.length;
    const beforeTypes = usedTypes.size;

    for (let i = 0; i < irFinalizers.length; i++) irFinalizers[i]();
    for (const f of funcs.slice()) if (f.referenced || f.export) f.generate?.();
    const ranFacts = drainFacts();

    if (!ranFacts && irFinalizers.length === beforeFinalizers && funcs.length === beforeFuncs && usedTypes.size === beforeTypes) {
      steady = 0;
      if (!giveUpFact()) break;
    } else if (++steady > 64) throw new Error('IR finalizers did not converge');
  }
  irFinalizers.length = 0;

  // a builtin global's initializer runs only when some compiled function reads that global: an
  // initializer is made as soon as code naming the global is generated, and code a comptime flag
  // then drops leaves one behind (Symbol.species in a gated-off branch made every program call
  // Symbol at startup). Kept initializers can read other builtin globals: to a fixpoint
  if (builtinGlobalInits.length !== 0) {
    const read = new Set();
    const seen = new Set();
    const walkIR = n => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      seen.add(n);
      if (Array.isArray(n)) {
        if (n[N_KIND] === K.Global && typeof n[3] === 'string') read.add(n[3]);
        for (const x of n) if (x && typeof x === 'object') walkIR(x);
        return;
      }
      for (const k in n) walkIR(n[k]);
    };
    for (const f of funcs) if (f.body) walkIR(f.body);
    const kept = [];
    let pending = builtinGlobalInits;
    for (let changed = true; changed;) {
      changed = false;
      const rest = [];
      for (const init of pending) {
        // (an init is Assign(Global(name), value): its own target is no read of it)
        if (read.has(init[3][3])) {
          kept.push(init);
          walkIR(init[4]);
          changed = true;
        } else rest.push(init);
      }
      pending = rest;
    }
    // (in the order they were made: one can read another made before it)
    const order = new Map(builtinGlobalInits.map((x, i) => [ x, i ]));
    kept.sort((a, b) => order.get(a) - order.get(b));
    if (kept.length !== 0) topLevelFunc.body.unshift(...kept);
  }
  // hoisted top-level let/const/class start uninitialised (read before: a ReferenceError)
  for (const name of tdzGlobals)
    if ((globals[name]?.type ?? T.jsval) === T.jsval) topLevelFunc.body.unshift(Assign(Global(name, T.jsval), tdzMarker()));

  // render input: funcs indexed by func.index, ungenerated ones null (tree-shaken to a trapping stub), globals as {name, type}
  const renderFuncs = [];
  for (const f of funcs) renderFuncs[f.index] = f.body ? f : null;

  // --devirtualize-log: method call sites by how many candidates they have, and what became of them
  for (const site of devirtualizeSites) if (!site.done) tallyDevirtualize(`${site.plural}: a candidate never compiled (dynamic)`, site.name);
  if (devirtualizeTally) for (const [ reason, { count, names } ] of [ ...devirtualizeTally ].sort((a, b) => b[1].count - a[1].count))
    console.log(`devirtualize: ${String(count).padStart(5)}  ${reason}   (.${[ ...names ].join('(), .')}())`);

  // PORF_WHY=1 (or =name, a part of the names to show): each compiled function, and the chain of
  // functions that included it (the first includer of each), from the program down: what brought
  // a builtin into a program that never names it
  if (process.env.PORF_WHY && !globalThis.precompile) {
    const includer = new Map();
    for (const f of funcs) if (f.body) for (const name of f.includes ?? []) if (!includer.has(name)) includer.set(name, f.name);
    const filter = process.env.PORF_WHY === '1' ? null : process.env.PORF_WHY;
    for (const f of funcs) {
      if (!f.body || (filter && !f.name.includes(filter))) continue;
      const chain = [ f.name ];
      for (let at = f.name; includer.has(at) && chain.length < 32;) {
        at = includer.get(at);
        if (chain.includes(at)) break;
        chain.push(at);
      }
      console.error(`why: ${chain.join(' <- ')}`);
    }
  }

  const renderGlobals = [];
  for (const name in globals) {
    if (name === '#ind') continue;
    renderGlobals.push({ name, type: globals[name].type ?? T.jsval });
  }

  return {
    funcs: renderFuncs,
    data,
    dataUnits,
    dataRelocs,
    units: program._units ?? null,
    globals: renderGlobals,
    entry: entryName,
    prefs: rawHead.length ? { ...Prefs, rawHead: [ Prefs.rawHead, ...rawHead ].filter(Boolean).join('\n') } : Prefs,
    usedTypes
  };
};
