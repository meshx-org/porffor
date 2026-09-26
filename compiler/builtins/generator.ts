// @porf --closures
import type {} from './porffor.d.ts';

// generators are fiber-stack coroutines (runtime in render.js): yield/await suspend, the
// generator value is the coroutine handle. C owns only the mechanism (Porffor.coroutine.*),
// the iterator protocol and { value, done } results live here.

export const __Porffor_Generator_step = (gen: __Porffor_Generator, value: any, mode: i32): object => {
  const done: boolean = Porffor.coroutine.resume(gen, value, mode);
  const result: object = {};
  result.value = Porffor.coroutine.value(gen);
  result.done = done;
  return result;
};

export const __Porffor_Generator_prototype_next = function (this: __Porffor_Generator, value: any): object {
  return __Porffor_Generator_step(this, value, 0);
};

export const __Porffor_Generator_prototype_return = function (this: __Porffor_Generator, value: any): object {
  return __Porffor_Generator_step(this, value, 2);
};

export const __Porffor_Generator_prototype_throw = function (this: __Porffor_Generator, value: any): object {
  return __Porffor_Generator_step(this, value, 1);
};


// async generators: same protocol but every step is async - next/return/throw return
// promises and the produced value is itself awaited. An await inside the body suspends
// the coroutine just as a yield does; the driver waits those out (resuming with the
// settled value, or throwing the rejection in) until the body yields or finishes, so an
// await's promise is never handed to the consumer as a yielded value.

// resumes gen, then through any awaits, until a yield or the end; promise: done
export const __Porffor_AsyncGenerator_run = (gen: __Porffor_AsyncGenerator, value: any, mode: i32, promise: Promise): void => {
  let done: boolean = false;
  try {
    done = Porffor.coroutine.resume(gen, value, mode);
  } catch (e) {
    __Porffor_promise_reject(e, promise);
    return;
  }
  if (!done && Porffor.coroutine.awaiting(gen)) {
    Porffor.callThis(__Promise_prototype_then, Porffor.coroutine.value(gen),
      (v: any): void => {
        __Porffor_AsyncGenerator_run(gen, v, 0 as i32, promise);
      },
      (e: any): void => {
        __Porffor_AsyncGenerator_run(gen, e, 1 as i32, promise);
      });
    return;
  }
  __Porffor_promise_resolve(done, promise);
};

// a promise of whether gen finished, once it has yielded or finished (for await..of too)
export const __Porffor_AsyncGenerator_advance = (gen: __Porffor_AsyncGenerator, value: any, mode: i32): Promise => {
  const promise: Promise = __Porffor_promise_create();
  __Porffor_AsyncGenerator_run(gen, value, mode, promise);
  return promise;
};

export const __Porffor_AsyncGenerator_step = (gen: __Porffor_AsyncGenerator, value: any, mode: i32): Promise => {
  const promise: Promise = __Porffor_promise_create();
  Porffor.callThis(__Promise_prototype_then, __Porffor_AsyncGenerator_advance(gen, value, mode),
    (done: boolean): void => {
      const yielded: any = Porffor.coroutine.value(gen);
      if (Porffor.type(yielded) == Porffor.TYPES.promise) {
        // the yielded value is itself awaited: settle with { value: awaited, done }
        Porffor.callThis(__Promise_prototype_then, yielded,
          (v: any): void => {
            const result: object = {};
            result.value = v;
            result.done = done;
            __Porffor_promise_resolve(result, promise);
          },
          (e: any): void => {
            Porffor.coroutine.resume(gen, undefined, 2 as i32);
            __Porffor_promise_reject(e, promise);
          });
      } else {
        const result: object = {};
        result.value = yielded;
        result.done = done;
        __Porffor_promise_resolve(result, promise);
      }
    },
    (e: any): void => {
      __Porffor_promise_reject(e, promise);
    });
  return promise;
};

export const __Porffor_AsyncGenerator_prototype_next = function (this: __Porffor_AsyncGenerator, value: any) {
  return __Porffor_AsyncGenerator_step(this, value, 0);
};

export const __Porffor_AsyncGenerator_prototype_return = function (this: __Porffor_AsyncGenerator, value: any) {
  return __Porffor_AsyncGenerator_step(this, value, 2);
};

export const __Porffor_AsyncGenerator_prototype_throw = function (this: __Porffor_AsyncGenerator, value: any) {
  return __Porffor_AsyncGenerator_step(this, value, 1);
};

// an async generator is its own async iterator (handled in codegen)

// the iterator helpers (Iterator.prototype, iterator.ts): a generator is an iterator
export const __Porffor_Generator_prototype_map = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_map, this, fn);
};

export const __Porffor_Generator_prototype_filter = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_filter, this, fn);
};

export const __Porffor_Generator_prototype_flatMap = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_flatMap, this, fn);
};

export const __Porffor_Generator_prototype_forEach = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_forEach, this, fn);
};

export const __Porffor_Generator_prototype_some = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_some, this, fn);
};

export const __Porffor_Generator_prototype_every = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_every, this, fn);
};

export const __Porffor_Generator_prototype_find = function (this: __Porffor_Generator, fn: any) {
  return Porffor.callThis(__Iterator_prototype_find, this, fn);
};

export const __Porffor_Generator_prototype_take = function (this: __Porffor_Generator, limit: any) {
  return Porffor.callThis(__Iterator_prototype_take, this, limit);
};

export const __Porffor_Generator_prototype_drop = function (this: __Porffor_Generator, limit: any) {
  return Porffor.callThis(__Iterator_prototype_drop, this, limit);
};

export const __Porffor_Generator_prototype_toArray = function (this: __Porffor_Generator) {
  return Porffor.callThis(__Iterator_prototype_toArray, this);
};

export const __Porffor_Generator_prototype_reduce = function (this: __Porffor_Generator, fn: any, initial: any) {
  return Porffor.callThis(__Iterator_prototype_reduce, this, fn, initial);
};
