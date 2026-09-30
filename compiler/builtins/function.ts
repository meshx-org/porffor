// @porf --closures
import type {} from './porffor.d.ts';

// `eval` is invalid syntax so work around
export const _eval = (source: string) => {
  throw new SyntaxError('Dynamic code evaluation is not supported');
};

export const Function = function (source: string) {
  throw new SyntaxError('Dynamic code evaluation is not supported');
};

// %AsyncFunction%: an async function's constructor, which (as Function) makes no function from
// source here: Porffor compiles ahead of time
export const __Porffor_AsyncFunction = function (source: string) {
  throw new SyntaxError('Dynamic code evaluation is not supported');
};

let __Porffor_asyncFunctionProtoObj: any = undefined;

// %AsyncFunction.prototype%: an async function's [[Prototype]] (its property store's, made
// when the function's is: _internal_object.ts), itself inheriting Function.prototype
export const __Porffor_asyncFunction_proto = (): object => {
  if (__Porffor_asyncFunctionProtoObj !== undefined) return __Porffor_asyncFunctionProtoObj;
  const p: object = {};
  __Porffor_object_fastAdd(p, 'constructor', __Porffor_AsyncFunction, 0b0010);
  __Porffor_object_fastAdd(p, Symbol.toStringTag, 'AsyncFunction', 0b0010);
  __Object_setPrototypeOf(p, __Function_prototype);
  __Porffor_asyncFunctionProtoObj = p;
  return p;
};

export const __Function_prototype_toString = function (this: Function) {
  const out: bytestring = Porffor.malloc(256);
  Porffor.IR.storeI32(out, 0, 0);

  Porffor.bytestring.appendStr(out, 'function ');
  Porffor.bytestring.appendStr(out, __Porffor_funcLut_name(this));
  Porffor.bytestring.appendStr(out, '() { [native code] }');
  return out;
};

export const __Function_prototype_toLocaleString = function (this: Function) { return Porffor.callThis(__Function_prototype_toString, this); };

export const __Function_prototype_apply = function (this: Function, thisArg: any, argsArray: any) {
  // an array (arguments included) with no holes is passed as it is: the call reads its
  // entries as the arguments, and the callee's own arguments object is a new array either
  // way (f.apply(this, arguments) copied every call's arguments). A hole reads through the
  // prototype chain, which the copy does, as for any other array-like.
  if (Porffor.type(argsArray) == Porffor.TYPES.array) {
    let dense: i32 = 0;
    Porffor.c`dense = porf_arr_dense((u32)argsArray.val);`;
    if (dense) return Porffor.call(this, argsArray, thisArg, null);
  }
  // CreateListFromArrayLike: anything but null, undefined or an object is refused
  if (argsArray != null && typeof argsArray != 'object' && typeof argsArray != 'function')
    throw new TypeError('Function.prototype.apply: the arguments list must be an object');
  return Porffor.call(this, Array.from(argsArray ?? []) as any[], thisArg, null);
};

export const __Function_prototype_call = function (this: Function, thisArg: any, ...args: any[]) {
  return Porffor.call(this, args, thisArg, null);
};

export const __Function_prototype_bind = function (this: Function, thisArg: any, ...args: any[]) {
  // capture the receiver before bound's own `this` shadows it
  const target: Function = this;
  const bound = function (...callArgs: any[]) {
    // new.target passes through, bound itself maps to the target
    if (new.target === undefined) return Porffor.call(target, args.concat(callArgs), thisArg, undefined);
    return Porffor.call(target, args.concat(callArgs), null, new.target === bound ? target : new.target);
  };

  // property/descriptor paths (not funcLut) so chained binds see the bound name/length
  Object.defineProperty(bound, 'name', { value: 'bound ' + (this as any).name, configurable: true });

  let length: f64 = (Object.getOwnPropertyDescriptor(this, 'length') as any).value - args.length;
  if (length < 0) length = 0;
  Object.defineProperty(bound, 'length', { value: length, configurable: true });

  // a bound function has no prototype property (constructing it uses the target's)
  __Porffor_object_removeOwn(bound, 'prototype');

  return bound;
};
