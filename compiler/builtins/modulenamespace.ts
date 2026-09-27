// @porf --closures
import type {} from './porffor.d.ts';

// A module namespace object, for the modules import() reaches: bindings holds a getter per
// export (sorted, as the compiler writes them), read live. A proxy over a frozen stand-in
// makes it the exotic object the spec has: a null prototype, not extensible, each export a
// writable, enumerable, non-configurable data property that cannot be set or deleted, and
// Symbol.toStringTag 'Module'. The stand-in's properties only carry their attributes, so
// the proxy may report them as it does
export const __Porffor_namespace = (bindings: any): any => {
  const target: any = __Object_create(null, undefined);
  const keys: any[] = __Object_keys(bindings);
  for (let i: i32 = 0; i < keys.length; i++) {
    const desc: object = Porffor.object.new(4);
    desc.value = undefined;
    desc.writable = true;
    desc.enumerable = true;
    desc.configurable = false;
    __Object_defineProperty(target, keys[i], desc);
  }
  const tag: object = Porffor.object.new(1);
  tag.value = 'Module';
  __Object_defineProperty(target, Symbol.toStringTag, tag);
  __Object_preventExtensions(target);

  const exported = (key: any): boolean => Porffor.fastAnd(typeof key == 'string', __Object_hasOwn(bindings, key));
  const handler: object = Porffor.object.new(4);
  handler.get = (t: any, key: any): any => {
    if (exported(key)) return bindings[key];
    if (typeof key == 'string') return undefined;
    return __Reflect_get(t, key);
  };
  handler.set = (): boolean => false;
  handler.deleteProperty = (t: any, key: any): boolean => {
    if (typeof key == 'string') return !exported(key);
    return __Reflect_deleteProperty(t, key);
  };
  handler.getOwnPropertyDescriptor = (t: any, key: any): any => {
    if (!exported(key)) return __Reflect_getOwnPropertyDescriptor(t, key);
    const desc: object = Porffor.object.new(4);
    desc.value = bindings[key];
    desc.writable = true;
    desc.enumerable = true;
    desc.configurable = false;
    return desc;
  };
  return new Proxy(target, handler);
};
