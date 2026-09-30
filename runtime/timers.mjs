// setTimeout / setInterval for a Porffor-compiled program, over the platform layer that drives
// its loop: a wait on the clock (porffor:clock's waitFor) and the async bridge (porffor:async).
// Each timer is one wait the loop settles; clearing a timer cancels its wait on the host's side.
// A WASI build's layer is its host (wasi:clocks 0.3's wait-for, the glue's js/async.mjs: an async
// export yields to the host while a timer is pending); a native build's is libuv
// (runtime/host/native/clock.mjs, async.mjs).
//
// A WASI build injects this module (esbuild `inject`) into guests whose world imports
// wasi:clocks/monotonic-clock@0.3.0; a native build with the runtime puts its timers on
// globalThis (runtime/globals.mjs).

import { refWait, waitFor } from 'porffor:clock';
import { rtCancel, rtLastToken, rtYield } from 'porffor:async';

/** Live timers: id -> the token of the wait in flight. */
const timers = /* @__PURE__ */ new Map();
/** The timers that do not keep the program running (Node's unref()). */
const unreferenced = /* @__PURE__ */ new Set();
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
	if (unreferenced.has(id)) refWait(rtLastToken(), false);
	wait.then(() => {
		if (timers.has(id)) tick();
	}, cleared);
}

/**
 * Whether a timer from setTimeout or setInterval keeps the program running (Node's ref() and
 * unref()): the loop ends with only unreferenced timers left. An unknown id is ignored.
 */
export function setTimerRef(id, ref) {
	const token = timers.get(id);

	if (token === undefined) return;
	if (ref) unreferenced.delete(id);
	else unreferenced.add(id);
	refWait(token, ref);
}

/**
 * Calls `callback(...args)` once, after `delay` milliseconds.
 * @returns {number} the id clearTimeout takes
 */
export function setTimeout(callback, delay, ...args) {
	const id = nextId++;

	arm(id, delay, () => {
		timers.delete(id);
		unreferenced.delete(id);
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
	unreferenced.delete(id);
	rtCancel(token, undefined);
}

export { clearTimeout as clearInterval };

/** Live immediates: id -> the token of the yield in flight. */
const immediates = /* @__PURE__ */ new Map();

/**
 * Calls `callback(...args)` once the loop has had its next turn (after its I/O), as Node's
 * setImmediate: a yield to the host (porffor:async's rtYield).
 * @returns {number} the id clearImmediate takes
 */
export function setImmediate(callback, ...args) {
	const id = nextId++;
	const wait = rtYield();

	immediates.set(id, rtLastToken());
	wait.then(() => {
		if (!immediates.has(id)) return;
		immediates.delete(id);
		callback(...args);
	}, cleared);

	return id;
}

/** Cancels an immediate from setImmediate; an unknown id is ignored. */
export function clearImmediate(id) {
	const token = immediates.get(id);

	if (token === undefined) return;
	immediates.delete(id);
	rtCancel(token, undefined);
}
