// WASI clock: porffor:clock's waitFor, the world's wasi:clocks/monotonic-clock@0.3.0 import (its
// wait-for, lowered by the component's glue). runtime/host/native/clock.mjs is the same over libuv.
export { waitFor } from 'wasi:clocks/monotonic-clock@0.3.0';

/**
 * Whether a wait keeps the program running (natively, libuv's ref and unref): a component's
 * export runs until its waits are done either way, so here it changes nothing.
 */
export const refWait = () => undefined;
