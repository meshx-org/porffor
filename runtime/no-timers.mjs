// Stands in for ./timers.mjs in a world that cannot wait on the clock (no
// wasi:clocks/monotonic-clock@0.3.0 import): library code that needs a timer
// (AbortSignal.timeout, EventSource's reconnect) fails with this instead of a bare
// ReferenceError.

function noClock() {
	throw new Error('setTimeout needs a world that imports wasi:clocks/monotonic-clock@0.3.0');
}

export { noClock as setTimeout, noClock as setInterval };

/** Nothing can have been set: nothing to clear. */
const clearNothing = () => undefined;

export { clearNothing as clearTimeout, clearNothing as clearInterval };
