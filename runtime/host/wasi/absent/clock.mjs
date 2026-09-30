// porffor:clock in a world that cannot wait on the clock (no wasi:clocks/monotonic-clock@0.3.0
// import): what needs a timer (setTimeout, AbortSignal.timeout, EventSource's reconnect) fails
// with this instead of a bare ReferenceError. Such a world gets no timer globals.

/** Throws: nothing can wait here. */
export function waitFor() {
	throw new Error('setTimeout needs a world that imports wasi:clocks/monotonic-clock@0.3.0');
}

/** Nothing waits here, so nothing keeps the program running. */
export const refWait = () => undefined;
