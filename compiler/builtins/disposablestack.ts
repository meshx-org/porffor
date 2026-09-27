import type {} from './porffor.d.ts';

// Explicit resource management: DisposableStack, AsyncDisposableStack, and what `using` and
// `await using` compile to (parse.js lowers a scope holding a using declaration into a
// try/catch/finally around the helpers below).
// https://tc39.es/proposal-explicit-resource-management/
//
// A list of resources is an array of three slots per resource: how to call it, the value,
// and the function. How to call it is
//   0: the value's [Symbol.dispose], with the value as this
//   1: adopt's onDispose(value)
//   2: defer's onDispose()
//   3: await using's fallback to [Symbol.dispose]: called, its result dropped, then an await
//   4: await using of null or undefined: nothing to call, only the await
//   5: the value's [Symbol.asyncDispose], with the value as this, its result awaited
// A DisposableStack holds its list (8 bytes), and null once it is disposed.

// AddDisposableResource: value, once it is on the list (or checked to need nothing)
export const __Porffor_using_add = (list: any[], value: any, async: boolean): any => {
  if (value == null) {
    if (async) {
      Porffor.array.fastPush(list, 4);
      Porffor.array.fastPush(list, undefined);
      Porffor.array.fastPush(list, undefined);
    }
    return value;
  }
  if (!Porffor.object.isObject(value)) throw new TypeError('Resource to dispose is not an object');

  let kind: number = 0;
  let method: any = undefined;
  if (async) {
    kind = 5;
    method = value[Symbol.asyncDispose];
    if (method == null) {
      method = value[Symbol.dispose];
      kind = 3;
    }
  } else {
    method = value[Symbol.dispose];
  }
  if (method == null) throw new TypeError(async ? 'Resource has no Symbol.asyncDispose or Symbol.dispose method' : 'Resource has no Symbol.dispose method');
  if (Porffor.type(method) != Porffor.TYPES.function) throw new TypeError('Resource dispose method is not a function');

  Porffor.array.fastPush(list, kind);
  Porffor.array.fastPush(list, value);
  Porffor.array.fastPush(list, method);
  return value;
};

// adopt and defer: a callback to run at disposal
export const __Porffor_using_addCallback = (list: any[], kind: number, value: any, onDispose: any): void => {
  if (Porffor.type(onDispose) != Porffor.TYPES.function) throw new TypeError('onDispose is not a function');
  Porffor.array.fastPush(list, kind);
  Porffor.array.fastPush(list, value);
  Porffor.array.fastPush(list, onDispose);
};

// DisposeResources: every resource, last added first. An error from one is thrown once the
// rest have run; an error on top of an earlier one (or of the scope's own, when hasError)
// wraps both in a SuppressedError
export const __Porffor_using_dispose = (list: any[], error: any, hasError: boolean): void => {
  let i: i32 = list.length;
  while (i > 0) {
    i -= 3;
    const kind: number = list[i];
    const value: any = list[i + 1];
    const method: any = list[i + 2];
    try {
      if (kind == 0) Porffor.callThis(method, value);
        else if (kind == 1) Porffor.callThis(method, undefined, value);
        else Porffor.callThis(method, undefined);
    } catch (e) {
      if (hasError) error = new SuppressedError(e, error, undefined);
        else error = e;
      hasError = true;
    }
  }
  list.length = 0;
  if (hasError) throw error;
};

// DisposeResources for await using and AsyncDisposableStack: as above, awaiting each one
export const __Porffor_using_disposeAsync = async (list: any[], error: any, hasError: boolean): void => {
  let i: i32 = list.length;
  while (i > 0) {
    i -= 3;
    const kind: number = list[i];
    const value: any = list[i + 1];
    const method: any = list[i + 2];
    try {
      if (kind == 5) await Porffor.callThis(method, value);
        else if (kind == 0) Porffor.callThis(method, value);
        else if (kind == 1) await Porffor.callThis(method, undefined, value);
        else if (kind == 2) await Porffor.callThis(method, undefined);
        else if (kind == 3) {
          Porffor.callThis(method, value);
          await undefined;
        } else await undefined;
    } catch (e) {
      if (hasError) error = new SuppressedError(e, error, undefined);
        else error = e;
      hasError = true;
    }
  }
  list.length = 0;
  if (hasError) throw error;
};

// the list of a stack that is not disposed yet
export const __Porffor_disposable_list = (stack: any): any[] => {
  const list: any = Porffor.IR.loadJv(stack, 0);
  if (list == null) throw new ReferenceError('Stack is already disposed');
  return list;
};

// Porffor builds prototype objects from string-keyed members only: the symbol-keyed ones
// are put on at the first construction
export const __Porffor_disposable_protoSymbols = (proto: any, dispose: any, tag: any, async: boolean): void => {
  if (Porffor.object.lookup(proto, Symbol.toStringTag) != 0) return;
  __Porffor_object_define(proto, async ? Symbol.asyncDispose : Symbol.dispose, dispose, 0b1010);
  __Porffor_object_define(proto, Symbol.toStringTag, tag, 0b0010);
};

export const DisposableStack = function (): DisposableStack {
  if (!new.target) throw new TypeError("Constructor DisposableStack requires 'new'");
  __Porffor_disposable_protoSymbols(__DisposableStack_prototype, __DisposableStack_prototype_dispose, 'DisposableStack', false);

  const out: DisposableStack = Porffor.malloc(8);
  Porffor.IR.storeJv(out, 0, Porffor.array.new(4));
  return out;
};

export const __DisposableStack_prototype_disposed$get = function (this: DisposableStack) {
  return Porffor.IR.loadJv(this, 0) == null;
};

export const __DisposableStack_prototype_use = function (this: DisposableStack, value: any) {
  return __Porffor_using_add(__Porffor_disposable_list(this), value, false);
};

export const __DisposableStack_prototype_adopt = function (this: DisposableStack, value: any, onDispose: any) {
  __Porffor_using_addCallback(__Porffor_disposable_list(this), 1, value, onDispose);
  return value;
};

export const __DisposableStack_prototype_defer = function (this: DisposableStack, onDispose: any): void {
  __Porffor_using_addCallback(__Porffor_disposable_list(this), 2, undefined, onDispose);
};

export const __DisposableStack_prototype_dispose = function (this: DisposableStack): void {
  const list: any = Porffor.IR.loadJv(this, 0);
  if (list == null) return;
  Porffor.IR.storeJv(this, 0, null);
  __Porffor_using_dispose(list, undefined, false);
};

// a new stack takes the resources, and this one is disposed without disposing them
export const __DisposableStack_prototype_move = function (this: DisposableStack): DisposableStack {
  const list: any = __Porffor_disposable_list(this);
  Porffor.IR.storeJv(this, 0, null);
  const out: DisposableStack = Porffor.malloc(8);
  Porffor.IR.storeJv(out, 0, list);
  return out;
};

export const AsyncDisposableStack = function (): AsyncDisposableStack {
  if (!new.target) throw new TypeError("Constructor AsyncDisposableStack requires 'new'");
  __Porffor_disposable_protoSymbols(__AsyncDisposableStack_prototype, __AsyncDisposableStack_prototype_disposeAsync, 'AsyncDisposableStack', true);

  const out: AsyncDisposableStack = Porffor.malloc(8);
  Porffor.IR.storeJv(out, 0, Porffor.array.new(4));
  return out;
};

export const __AsyncDisposableStack_prototype_disposed$get = function (this: AsyncDisposableStack) {
  return Porffor.IR.loadJv(this, 0) == null;
};

export const __AsyncDisposableStack_prototype_use = function (this: AsyncDisposableStack, value: any) {
  return __Porffor_using_add(__Porffor_disposable_list(this), value, true);
};

export const __AsyncDisposableStack_prototype_adopt = function (this: AsyncDisposableStack, value: any, onDispose: any) {
  __Porffor_using_addCallback(__Porffor_disposable_list(this), 1, value, onDispose);
  return value;
};

export const __AsyncDisposableStack_prototype_defer = function (this: AsyncDisposableStack, onDispose: any): void {
  __Porffor_using_addCallback(__Porffor_disposable_list(this), 2, undefined, onDispose);
};

export const __AsyncDisposableStack_prototype_disposeAsync = async function (this: AsyncDisposableStack): void {
  const list: any = Porffor.IR.loadJv(this, 0);
  if (list == null) return;
  Porffor.IR.storeJv(this, 0, null);
  await __Porffor_using_disposeAsync(list, undefined, false);
};

export const __AsyncDisposableStack_prototype_move = function (this: AsyncDisposableStack): AsyncDisposableStack {
  const list: any = __Porffor_disposable_list(this);
  Porffor.IR.storeJv(this, 0, null);
  const out: AsyncDisposableStack = Porffor.malloc(8);
  Porffor.IR.storeJv(out, 0, list);
  return out;
};
