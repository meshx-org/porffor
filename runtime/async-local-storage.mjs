// AsyncLocalStorage (node:async_hooks), as Cloudflare Workers put it on the global object:
// libraries that cannot import node:async_hooks look for it there (better-auth does). The real
// one, over the engine's async context (runtime/node/async_hooks.mjs): a store follows its call
// through every await, timer and host operation, however calls interleave.
export { AsyncLocalStorage } from './node/async_hooks.mjs';
