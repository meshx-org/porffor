// @porf --closures
import type {} from './porffor.d.ts';

// Proxy: the get, set, has, deleteProperty, ownKeys and getOwnPropertyDescriptor traps.
// A proxy is its own type holding [target, handler] (16 bytes, both traced by the GC).
// The object operations in _internal_object.ts / object.ts / reflect.ts hand a proxy to
// the functions below, and every operation whose trap is missing falls through to the
// target. A function's proxy runs its apply and construct traps (see Proxy). Not
// implemented yet: the prototype and extensibility traps, defineProperty and invariant
// checks. A revoked proxy
// (Proxy.revocable) has neither target nor handler, and every operation on it throws.

// Returns any, not Proxy: a return annotation re-tags the returned value, which would
// turn the function returned below into a "proxy" pointing at function memory.
export const Proxy = function (target: any, handler: any): any {
  if (!new.target) throw new TypeError("Constructor Proxy requires 'new'");
  // == null first: isObject(null) is true (its null check compares the value to 0)
  if (target == null) throw new TypeError('Cannot create proxy with a non-object as target');
  if (handler == null) throw new TypeError('Cannot create proxy with a non-object as handler');
  if (!Porffor.object.isObject(target)) throw new TypeError('Cannot create proxy with a non-object as target');
  if (!Porffor.object.isObject(handler)) throw new TypeError('Cannot create proxy with a non-object as handler');

  // A proxy of a function is callable: with an apply or a construct trap, a function that
  // runs them (its other traps do not run, and a property of it is its own, not the
  // target's); with neither, the function itself, which stays callable and constructible.
  if (Porffor.type(target) == Porffor.TYPES.function) {
    if (Porffor.fastAnd(handler.apply == null, handler.construct == null)) return target;
    const callable = function (...args: any[]) {
      if (new.target === undefined) {
        const apply: any = handler.apply;
        if (apply == null) return Porffor.call(target, args, this, undefined);
        return Porffor.callThis(apply, handler, target, this, args);
      }
      const construct: any = handler.construct;
      // constructed without a trap: the target's instance (its prototype, not this function's)
      if (construct == null) return Porffor.call(target, args, null, new.target === callable ? target : new.target);
      const out: any = Porffor.callThis(construct, handler, target, args, new.target);
      if (Porffor.fastOr(out == null, !Porffor.object.isObject(out))) throw new TypeError("'construct' on proxy: trap returned non-object");
      return out;
    };
    return callable;
  }

  const out: Proxy = Porffor.malloc(16);
  Porffor.IR.storeJv(out, 0, target);
  Porffor.IR.storeJv(out, 8, handler);
  return out;
};

export const __Porffor_proxy_target = (proxy: any): any => {
  return Porffor.IR.loadJv(proxy, 0);
};

// The handler, or a TypeError once the proxy has been revoked
export const __Porffor_proxy_handler = (proxy: any): any => {
  const handler: any = Porffor.IR.loadJv(proxy, 8);
  if (handler == null) throw new TypeError('Cannot perform operation on a revoked proxy');
  return handler;
};

// Proxy.revocable's revoke: the proxy lets go of target and handler (a second call does nothing)
export const __Porffor_proxy_revoke = (proxy: any): void => {
  Porffor.IR.storeJv(proxy, 0, null);
  Porffor.IR.storeJv(proxy, 8, null);
};

// Proxy.revocable: a proxy, as new Proxy makes it, and the function that revokes it
export const __Proxy_revocable = (target: any, handler: any): object => {
  if (target == null) throw new TypeError('Cannot create proxy with a non-object as target');
  if (handler == null) throw new TypeError('Cannot create proxy with a non-object as handler');
  if (!Porffor.object.isObject(target)) throw new TypeError('Cannot create proxy with a non-object as target');
  if (!Porffor.object.isObject(handler)) throw new TypeError('Cannot create proxy with a non-object as handler');

  const out: object = {};
  // a function target stays the function itself (see Proxy above): nothing to revoke
  if (Porffor.type(target) == Porffor.TYPES.function) {
    out.proxy = target;
    out.revoke = __Porffor_proxy_revokeNothing;
    return out;
  }

  const proxy: Proxy = Porffor.malloc(16);
  Porffor.IR.storeJv(proxy, 0, target);
  Porffor.IR.storeJv(proxy, 8, handler);
  const made: any = proxy;
  out.proxy = made;
  // no closures in builtins: revoke is __Porffor_proxy_revoke bound to this proxy
  const bind: any = __Function_prototype_bind;
  const revoke: any = __Porffor_proxy_revoke;
  out.revoke = Porffor.callThis(bind, revoke, undefined, made);
  return out;
};

export const __Porffor_proxy_revokeNothing = (): void => {};

// The accessor that target.[[Get]]/[[Set]] would reach for key: walks target's chain the
// way the spec's OrdinaryGet does, so it can be called with the proxy (or whatever the
// receiver is) as this. Returns undefined for a data property or no property at all;
// those need no receiver, so the plain get/set handles them.
export const __Porffor_proxy_findAccessor = (target: any, key: any): any => {
  let obj: any = target;
  while (obj != null) {
    if (Porffor.type(obj) == Porffor.TYPES.proxy) return undefined;
    const desc: any = __Object_getOwnPropertyDescriptor(obj, key);
    if (desc !== undefined) {
      if (Porffor.fastOr('get' in desc, 'set' in desc)) return desc;
      return undefined;
    }
    obj = __Object_getPrototypeOf(obj);
  }
  return undefined;
};

export const __Porffor_proxy_get = (proxy: any, key: any, receiver: any): any => {
  const target: any = Porffor.IR.loadJv(proxy, 0);
  const handler: any = __Porffor_proxy_handler(proxy);
  const trap: any = handler.get;
  if (trap == null) {
    // target.[[Get]](key, receiver)
    if (Porffor.type(target) == Porffor.TYPES.proxy) return __Porffor_proxy_get(target, key, receiver);
    const accessor: any = __Porffor_proxy_findAccessor(target, key);
    if (accessor !== undefined) {
      const get: any = accessor.get;
      if (get == null) return undefined;
      return Porffor.callThis(get, receiver);
    }
    return __Porffor_object_get(target, key);
  }

  return Porffor.callThis(trap, handler, target, key, receiver);
};

export const __Porffor_proxy_set = (proxy: any, key: any, value: any, receiver: any, strict: boolean): any => {
  const target: any = Porffor.IR.loadJv(proxy, 0);
  const handler: any = __Porffor_proxy_handler(proxy);
  const trap: any = handler.set;
  if (trap == null) {
    // target.[[Set]](key, value, receiver): a setter on target's chain runs with receiver
    if (Porffor.type(target) == Porffor.TYPES.proxy) return __Porffor_proxy_set(target, key, value, receiver, strict);
    const accessor: any = __Porffor_proxy_findAccessor(target, key);
    if (accessor !== undefined) {
      const set: any = accessor.set;
      if (set == null) {
        if (strict) throw new TypeError('Cannot set property which has only a getter');
        return value;
      }
      Porffor.callThis(set, receiver, value);
      return value;
    }
    if (strict) __Porffor_object_setStrict(target, key, value);
      else __Porffor_object_set(target, key, value);
    return value;
  }

  const ok: any = Porffor.callThis(trap, handler, target, key, value, receiver);
  if (strict) if (!ok) throw new TypeError("'set' on proxy: trap returned falsish");
  return value;
};

export const __Porffor_proxy_has = (proxy: any, key: any): boolean => {
  const target: any = Porffor.IR.loadJv(proxy, 0);
  const handler: any = __Porffor_proxy_handler(proxy);
  const trap: any = handler.has;
  if (trap == null) return __Porffor_object_in(target, key);

  return !!Porffor.callThis(trap, handler, target, key);
};

export const __Porffor_proxy_deleteProperty = (proxy: any, key: any, strict: boolean): boolean => {
  const target: any = Porffor.IR.loadJv(proxy, 0);
  const handler: any = __Porffor_proxy_handler(proxy);
  const trap: any = handler.deleteProperty;
  if (trap == null) {
    if (strict) return __Porffor_object_deleteStrict(target, key);
    return __Porffor_object_delete(target, key);
  }

  const ok: boolean = !!Porffor.callThis(trap, handler, target, key);
  if (strict) if (!ok) throw new TypeError("'deleteProperty' on proxy: trap returned falsish");
  return ok;
};

// [[OwnPropertyKeys]]: the trap's array-like, checked to hold only strings and symbols.
export const __Porffor_proxy_ownKeys = (proxy: any): any[] => {
  const target: any = Porffor.IR.loadJv(proxy, 0);
  const handler: any = __Porffor_proxy_handler(proxy);
  const trap: any = handler.ownKeys;
  if (trap == null) return __Reflect_ownKeys(target);

  const list: any = Porffor.callThis(trap, handler, target);
  if (!Porffor.object.isObject(list)) throw new TypeError("'ownKeys' on proxy: trap returned a non-object");

  const out: any[] = Porffor.array.new(4);
  const len: i32 = list.length;
  // the keys seen, to find a duplicate (a Set of them past a few: SameValue for strings and
  // symbols is SameValueZero)
  const seen: any = len > 8 ? new Set() : undefined;
  for (let i: i32 = 0; i < len; i++) {
    const key: any = list[i];
    const t: i32 = Porffor.type(key);
    if (Porffor.fastAnd((t | 0b10000000) != Porffor.TYPES.bytestring, t != Porffor.TYPES.symbol))
      throw new TypeError("'ownKeys' on proxy: trap result contains a non-property-key");
    if (seen === undefined) {
      for (let j: i32 = 0; j < i; j++) if (out[j] === key) throw new TypeError("'ownKeys' on proxy: trap returned duplicate entries");
    } else {
      if (seen.has(key)) throw new TypeError("'ownKeys' on proxy: trap returned duplicate entries");
      seen.add(key);
    }
    out[i] = key;
  }
  return out;
};

// [[GetOwnProperty]], normalised to a complete descriptor the way the spec's
// ToPropertyDescriptor + FromPropertyDescriptor would (extra fields are dropped).
export const __Porffor_proxy_getOwnPropertyDescriptor = (proxy: any, key: any): any => {
  const target: any = Porffor.IR.loadJv(proxy, 0);
  const handler: any = __Porffor_proxy_handler(proxy);
  const trap: any = handler.getOwnPropertyDescriptor;
  if (trap == null) return __Object_getOwnPropertyDescriptor(target, key);

  const desc: any = Porffor.callThis(trap, handler, target, key);
  if (desc === undefined) return undefined;
  if (!Porffor.object.isObject(desc)) throw new TypeError("'getOwnPropertyDescriptor' on proxy: trap returned neither object nor undefined");

  const out: any = {};
  if (Porffor.fastOr('get' in desc, 'set' in desc)) {
    out.get = desc.get;
    out.set = desc.set;
  } else {
    out.value = desc.value;
    out.writable = !!desc.writable;
  }
  out.enumerable = !!desc.enumerable;
  out.configurable = !!desc.configurable;
  return out;
};

// Own keys as Object.keys (enumerable strings), Object.getOwnPropertyNames (all strings)
// and object spread (enumerable strings and symbols) see them.
export const __Porffor_proxy_keys = (proxy: any, enumerableOnly: boolean, stringsOnly: boolean): any[] => {
  const keys: any[] = __Porffor_proxy_ownKeys(proxy);
  const out: any[] = Porffor.array.new(4);
  let n: i32 = 0;
  const len: i32 = keys.length;
  for (let i: i32 = 0; i < len; i++) {
    const key: any = keys[i];
    if (stringsOnly) if (Porffor.type(key) == Porffor.TYPES.symbol) continue;
    if (enumerableOnly) {
      const desc: any = __Porffor_proxy_getOwnPropertyDescriptor(proxy, key);
      if (desc === undefined) continue;
      if (!desc.enumerable) continue;
    }
    out[n++] = key;
  }
  return out;
};
