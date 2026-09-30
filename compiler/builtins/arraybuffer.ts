import type {} from './porffor.d.ts';

export const __ArrayBuffer_isView = (value: any): boolean => {
  return Porffor.fastOr(
    Porffor.type(value) == Porffor.TYPES.dataview,
    Porffor.fastAnd(Porffor.type(value) >= Porffor.TYPES.uint8clampedarray, Porffor.type(value) <= Porffor.TYPES.float64array)
  );
};

export const __Porffor_arraybuffer_detach = (buffer: any): void => {
  // mark as detached by setting length = "-1"
  Porffor.IR.storeI32(buffer, 0, 4294967295);
};

// Resizable buffers and their maxByteLength, as pairs in a plain array (a Map here would
// bring Map into every program making an ArrayBuffer; there are few resizable ones). Such a
// buffer reserves its maximum up front and never moves (typed arrays hold pointers into
// it): resize() changes its length word only
let __Porffor_arraybuffer_max: any = undefined;

export const __Porffor_arraybuffer_maxOf = (buffer: any): any => {
  if (__Porffor_arraybuffer_max === undefined) return undefined;
  const pairs: any[] = __Porffor_arraybuffer_max;
  const len: i32 = pairs.length;
  for (let i: i32 = 0; i < len; i += 2) {
    if (pairs[i] === buffer) return pairs[i + 1];
  }
  return undefined;
};

// Typed array views of resizable buffers, as triples in a plain array: the view, its fixed
// length (-1 when it tracks the buffer's) and element size. resize() sets each one's length
// word, which element access reads: a tracking view's to what now fits, and any view's to 0
// once it is out of bounds
let __Porffor_arraybuffer_views: any = undefined;

export const __Porffor_arraybuffer_addView = (view: any, fixedLength: i32, size: i32): void => {
  if (__Porffor_arraybuffer_views === undefined) __Porffor_arraybuffer_views = Porffor.array.new(6);
  const views: any[] = __Porffor_arraybuffer_views;
  Porffor.array.fastPush(views, view);
  Porffor.array.fastPush(views, fixedLength);
  Porffor.array.fastPush(views, size);
};

// a view's length as its buffer is now: -1 when out of bounds (or detached)
export const __Porffor_arraybuffer_viewLength = (view: any, fixedLength: i32, size: i32): i32 => {
  const offset: i32 = Porffor.IR.loadI32(view, 8);
  const bufferLength: i32 = Porffor.IR.loadI32(Porffor.IR.loadI32(view, 4) - offset, 0);
  if (bufferLength < 0) return -1;
  if (fixedLength < 0) {
    if (offset > bufferLength) return -1;
    return Math.floor((bufferLength - offset) / size);
  }
  if (offset + fixedLength * size > bufferLength) return -1;
  return fixedLength;
};

export const __Porffor_arraybuffer_resizeViews = (buffer: any): void => {
  if (__Porffor_arraybuffer_views === undefined) return;
  const views: any[] = __Porffor_arraybuffer_views;
  const bufferPtr: i32 = Porffor.IR.ptr(buffer);
  const len: i32 = views.length;
  for (let i: i32 = 0; i < len; i += 3) {
    const view: any = views[i];
    if (Porffor.IR.loadI32(view, 4) - Porffor.IR.loadI32(view, 8) != bufferPtr) continue;
    const n: i32 = __Porffor_arraybuffer_viewLength(view, views[i + 1], views[i + 2]);
    Porffor.IR.storeI32(view, 0, n < 0 ? 0 : n);
  }
};

// IsTypedArrayOutOfBounds, for a view of a resizable buffer (any other is never)
export const __Porffor_typedArray_outOfBounds = (ta: any): boolean => {
  if (__Porffor_arraybuffer_views === undefined) return false;
  const views: any[] = __Porffor_arraybuffer_views;
  const len: i32 = views.length;
  for (let i: i32 = 0; i < len; i += 3) {
    if (views[i] === ta) return __Porffor_arraybuffer_viewLength(ta, views[i + 1], views[i + 2]) < 0;
  }
  return false;
};

export const ArrayBuffer = function (length: any, options: any = undefined): ArrayBuffer { // (length is 1)
  // 1. If NewTarget is undefined, throw a TypeError exception.
  if (!new.target) throw new TypeError("Constructor ArrayBuffer requires 'new'");

  // 2. Let byteLength be ? ToIndex(length).
  const byteLength: number = ecma262.ToIndex(length);

  // 3. Let requestedMaxByteLength be ? GetArrayBufferMaxByteLengthOption(options).
  let max: number = -1;
  // read as the plain object it is (read as any, every type with a maxByteLength would come in),
  // in a program that can make a resizable buffer at all (program.resizableBuffers): the read is
  // the generic property read, and brings what that reaches into every program with a buffer
  if (Porffor.comptime.flag`program.resizableBuffers`) {
    if (Porffor.fastAnd(Porffor.type(options) == Porffor.TYPES.object, options !== null)) {
      const maxOption: any = (options as object).maxByteLength;
      if (maxOption !== undefined) {
        max = ecma262.ToIndex(maxOption);
        if (byteLength > max) throw new RangeError('Invalid ArrayBuffer length (over maxByteLength)');
      }
    }
  }

  if (byteLength < 0) throw new RangeError('Invalid ArrayBuffer length (negative)');
  const reserve: number = max >= 0 ? max : byteLength;
  if (reserve > 2147483643) throw new RangeError('Invalid ArrayBuffer length (over maximum supported length)');

  const out: ArrayBuffer = Porffor.malloc(reserve + 4);
  Porffor.IR.storeI32(out, 0, byteLength);
  Porffor.IR.fill(Porffor.IR.ptr(out) + 4, 0, reserve);

  if (max >= 0) {
    if (__Porffor_arraybuffer_max === undefined) __Porffor_arraybuffer_max = Porffor.array.new(4);
    const pairs: any[] = __Porffor_arraybuffer_max;
    const n: i32 = pairs.length;
    pairs[n] = out;
    pairs[n + 1] = max;
  }

  return out;
};

export const __ArrayBuffer_prototype_byteLength$get = function (this: ArrayBuffer) {
  const read: i32 = Porffor.IR.loadI32(this, 0);
  return read >= 0 ? read : 0;
};

export const __ArrayBuffer_prototype_maxByteLength$get = function (this: ArrayBuffer) {
  const read: i32 = Porffor.IR.loadI32(this, 0);
  if (read < 0) return 0;
  const max: any = __Porffor_arraybuffer_maxOf(this);
  return max !== undefined ? max : read;
};

export const __ArrayBuffer_prototype_detached$get = function (this: ArrayBuffer) {
  return Porffor.IR.loadI32(this, 0) == 4294967295;
};

export const __ArrayBuffer_prototype_resizable$get = function (this: ArrayBuffer) {
  return __Porffor_arraybuffer_maxOf(this) !== undefined;
};

export const __ArrayBuffer_prototype_slice = function (this: ArrayBuffer, start: any, end: any) {
  if (this.detached) throw new TypeError('Called ArrayBuffer.prototype.slice on a detached ArrayBuffer');

  const len: i32 = Porffor.IR.loadI32(this, 0);
  if (Porffor.type(end) == Porffor.TYPES.undefined) end = len;

  start = ecma262.ToIntegerOrInfinity(start);
  end = ecma262.ToIntegerOrInfinity(end);

  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }
  if (start > len) start = len;
  if (end < 0) {
    end = len + end;
    if (end < 0) end = 0;
  }
  if (end > len) end = len;

  const out: ArrayBuffer = Porffor.malloc(4 + (end - start));
  Porffor.IR.storeI32(out, 0, end - start);

  Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(this) + 4 + start, end - start);

  return out;
};


export const __ArrayBuffer_prototype_transfer = function (this: ArrayBuffer, newLength: any) {
  return __Porffor_arraybuffer_transfer(this, newLength, true);
};

export const __ArrayBuffer_prototype_transferToFixedLength = function (this: ArrayBuffer, newLength: any) {
  return __Porffor_arraybuffer_transfer(this, newLength, false);
};

// transfer keeps a resizable buffer resizable (the same maxByteLength); ToFixedLength does not
export const __Porffor_arraybuffer_transfer = (buffer: ArrayBuffer, newLength: any, keepResizable: boolean): ArrayBuffer => {
  if (buffer.detached) throw new TypeError('Called ArrayBuffer.prototype.transfer on a detached ArrayBuffer');

  const len: i32 = Porffor.IR.loadI32(buffer, 0);
  const newLen: number = Porffor.type(newLength) == Porffor.TYPES.undefined ? len : ecma262.ToIndex(newLength);

  let out: ArrayBuffer;
  if (Porffor.fastAnd(keepResizable, buffer.resizable)) out = new ArrayBuffer(newLen, { maxByteLength: buffer.maxByteLength });
    else out = new ArrayBuffer(newLen);

  Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(buffer) + 4, Math.min(newLen, len));

  __Porffor_arraybuffer_detach(buffer);

  return out;
};

export const __ArrayBuffer_prototype_resize = function (this: ArrayBuffer, newLength: any) {
  const max: any = __Porffor_arraybuffer_maxOf(this);
  if (max === undefined) throw new TypeError('Called ArrayBuffer.prototype.resize on a non-resizable ArrayBuffer');

  const newLen: number = ecma262.ToIndex(newLength);
  if (this.detached) throw new TypeError('Called ArrayBuffer.prototype.resize on a detached ArrayBuffer');
  if (newLen > max) throw new RangeError('Invalid ArrayBuffer length (over maxByteLength)');

  // what grows back is zeros, what shrank away is gone
  const len: i32 = Porffor.IR.loadI32(this, 0);
  if (newLen > len) Porffor.IR.fill(Porffor.IR.ptr(this) + 4 + len, 0, newLen - len);
  Porffor.IR.storeI32(this, 0, newLen);
  __Porffor_arraybuffer_resizeViews(this);
};

export const SharedArrayBuffer = function (length: any): SharedArrayBuffer {
  // 1. If NewTarget is undefined, throw a TypeError exception.
  if (!new.target) throw new TypeError("Constructor SharedArrayBuffer requires 'new'");

  // 2. Let byteLength be ? ToIndex(length).
  const byteLength: number = ecma262.ToIndex(length);

  if (byteLength < 0) throw new RangeError('Invalid SharedArrayBuffer length (negative)');
  if (byteLength > 2147483643) throw new RangeError('Invalid SharedArrayBuffer length (over maximum supported length)');

  const out: SharedArrayBuffer = Porffor.malloc(byteLength + 4);
  Porffor.IR.storeI32(out, 0, byteLength);
  Porffor.IR.fill(Porffor.IR.ptr(out) + 4, 0, byteLength);

  return out;
};

export const __SharedArrayBuffer_prototype_byteLength$get = function (this: SharedArrayBuffer) {
  return Porffor.IR.loadI32(this, 0);
};

export const __SharedArrayBuffer_prototype_maxByteLength$get = function (this: SharedArrayBuffer) {
  return Porffor.IR.loadI32(this, 0);
};

export const __SharedArrayBuffer_prototype_growable$get = function (this: SharedArrayBuffer) {
  return false;
};


export const __SharedArrayBuffer_prototype_slice = function (this: SharedArrayBuffer, start: any, end: any) {
  const len: i32 = Porffor.IR.loadI32(this, 0);
  if (Porffor.type(end) == Porffor.TYPES.undefined) end = len;

  start = ecma262.ToIntegerOrInfinity(start);
  end = ecma262.ToIntegerOrInfinity(end);

  if (start < 0) {
    start = len + start;
    if (start < 0) start = 0;
  }
  if (start > len) start = len;
  if (end < 0) {
    end = len + end;
    if (end < 0) end = 0;
  }
  if (end > len) end = len;

  const out: SharedArrayBuffer = Porffor.malloc(4 + (end - start));
  Porffor.IR.storeI32(out, 0, end - start);

  Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(this) + 4 + start, end - start);

  return out;
};

export const __SharedArrayBuffer_prototype_grow = function (this: SharedArrayBuffer, newLength: any) {
  // todo: growable not implemented yet so just always fail
  throw new TypeError('Called SharedArrayBuffer.prototype.grow on a non-growable SharedArrayBuffer');
};
