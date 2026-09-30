import type {} from './porffor.d.ts';

// todo: support receiver
export const __Reflect_get = (target: any, prop: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  return target[prop];
};

// todo: support receiver
export const __Reflect_set = (target: any, prop: any, value: any, receiver: any = undefined) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  // a typed array's element for another receiver ([[Set]] 10.4.5.5): an index that is not
  // valid sets nothing (the value not even converted), a valid one is the receiver's to set
  if (Porffor.comptime.flag`program.typedArrays`) if (receiver !== undefined) if (receiver !== target) if (__Porffor_object_isTypedArray(target)) {
    const index: any = __Porffor_typedArray_canonicalIndex(ecma262.ToPropertyKey(prop));
    if (index !== undefined) {
      if (Porffor.fastOr(!Number.isInteger(index), index < 0, index >= target.length, Object.is(index, -0))) return true;
      if (!Porffor.object.isObject(receiver)) return false;
      try {
        receiver[prop] = value;
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    target[prop] = value;
    return true;
  } catch {
    return false;
  }
};

export const __Reflect_has = (target: any, prop: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  return prop in target;
};

export const __Reflect_defineProperty = (target: any, prop: any, descriptor: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');
  if (!Porffor.object.isObject(descriptor)) throw new TypeError('Descriptor is a non-object');

  try {
    Object.defineProperty(target, prop, descriptor);
    return true;
  } catch {
    return false;
  }
};

export const __Reflect_deleteProperty = (target: any, prop: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  try {
    return delete target[prop];
  } catch {
    return false;
  }
};

export const __Reflect_getOwnPropertyDescriptor = (target: any, prop: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  return Object.getOwnPropertyDescriptor(target, prop);
};

export const __Reflect_isExtensible = (target: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  return Object.isExtensible(target);
};

export const __Reflect_preventExtensions = (target: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  try {
    Object.preventExtensions(target);
    return true;
  } catch {
    return false;
  }
};

export const __Reflect_getPrototypeOf = (target: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  return Object.getPrototypeOf(target);
};

export const __Reflect_setPrototypeOf = (target: any, proto: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');

  try {
    Object.setPrototypeOf(target, proto);
    return true;
  } catch {
    return false;
  }
};

export const __Reflect_ownKeys = (target: any) => {
  if (!Porffor.object.isObject(target)) throw new TypeError('Target is a non-object');
  if (Porffor.comptime.flag`hasType.proxy`) {
    if (Porffor.type(target) == Porffor.TYPES.proxy) return __Porffor_proxy_ownKeys(target);
  }
  return __Porffor_object_ownKeys(target, true, true, false);
};


export const __Reflect_apply = (target: any, thisArgument: any, argumentsList: any) => {
  return Porffor.call(target, argumentsList, thisArgument, null);
};

export const __Reflect_construct = (target: any, argumentsList: any, newTarget: any = target) => {
  // todo: giving undefined/null to newTarget should not default
  if (!__ecma262_IsConstructor(target)) throw new TypeError('Target is not a constructor');
  if (!__ecma262_IsConstructor(newTarget)) throw new TypeError('newTarget is not a constructor');
  return Porffor.call(target, argumentsList, null, newTarget);
};
