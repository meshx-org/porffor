// setTimeout / setInterval for a Porffor-compiled guest, over wasi:clocks 0.3
// (monotonic-clock.wait-for). Each timer is one async wait-for the component's event
// loop settles (the glue's js/async.mjs), so an async export yields to the host while a
// timer is pending. Clearing a timer cancels its wait with the host.
//
// The build injects this module (esbuild `inject`) into guests whose world imports
// wasi:clocks/monotonic-clock@0.3.0, so the global names resolve here.

import { waitFor } from 'wasi:clocks/monotonic-clock@0.3.0';
import { rtCancel, rtLastToken } from 'rt-async';

/** Live timers: id -> the token of the wait in flight. */
const timers = /* @__PURE__ */ new Map();
let nextId = 1;

/**
 * A delay in nanoseconds, as HTML clamps it: not a number or negative is 0. A plain
 * number, not a BigInt: the glue lowers a u64 through Number() either way.
 */
function nanos(delay) {
	const ms = Number(delay);

	return Math.round(ms > 0 ? ms : 0) * 1_000_000;
}

/** A cleared timer's wait, rejected by rtCancel: nothing to do. */
const cleared = () => undefined;

/**
 * Starts one wait for a timer, then runs `tick` unless the timer was cleared: a wait
 * that ended just before clearTimeout has settled already, and cannot be cancelled.
 */
function arm(id, delay, tick) {
	const wait = waitFor(nanos(delay));

	timers.set(id, rtLastToken());
	wait.then(() => {
		if (timers.has(id)) tick();
	}, cleared);
}

/**
 * Calls `callback(...args)` once, after `delay` milliseconds.
 * @returns {number} the id clearTimeout takes
 */
export function setTimeout(callback, delay, ...args) {
	const id = nextId++;

	arm(id, delay, () => {
		timers.delete(id);
		callback(...args);
	});

	return id;
}

/**
 * Calls `callback(...args)` every `delay` milliseconds until cleared.
 * @returns {number} the id clearInterval takes
 */
export function setInterval(callback, delay, ...args) {
	const id = nextId++;
	const tick = () => {
		arm(id, delay, tick);
		callback(...args);
	};

	arm(id, delay, tick);

	return id;
}

/** Cancels a timer from setTimeout or setInterval; an unknown id is ignored. */
export function clearTimeout(id) {
	const token = timers.get(id);

	if (token === undefined) return;
	timers.delete(id);
	rtCancel(token, undefined);
}

export { clearTimeout as clearInterval };
