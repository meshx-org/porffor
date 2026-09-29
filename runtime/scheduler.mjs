// scheduler.yield, setImmediate and requestIdleCallback for a Porffor-compiled guest,
// over the glue's yields (rtYield): an async export's loop gives the host a turn
// (the component model's thread.yield) before it settles them, so a long computation
// that awaits scheduler.yield() now and then lets the host run meanwhile. In a sync
// export the host cannot get a turn; a yield settles once the microtasks have run.
//
// The build injects this module (esbuild `inject`) into guests whose world has async
// functions (the async runtime is what settles yields).

import { rtYield } from 'rt-async';

/** How long an idle callback may run, in milliseconds, as browsers budget it. */
const IDLE_BUDGET_MS = 50;

/** The Prioritized Task Scheduling API's yield: resolves after the host has had a turn. */
export const scheduler = {
	yield() {
		return rtYield();
	}
};

/** Live immediates and idle callbacks: ids a clear has not removed. */
const live = /* @__PURE__ */ new Set();
let nextId = 1;

/**
 * Calls `callback(...args)` after the host has had a turn.
 * @returns {number} the id clearImmediate takes
 */
export function setImmediate(callback, ...args) {
	const id = nextId++;

	live.add(id);
	rtYield().then(() => {
		if (live.delete(id)) callback(...args);
	});

	return id;
}

/** Cancels an immediate; an unknown id is ignored. */
export function clearImmediate(id) {
	live.delete(id);
}

/**
 * Calls `callback(deadline)` after the host has had a turn. There is no idle period to
 * measure: the callback gets the browser's usual budget, 50 ms from when it starts.
 * @returns {number} the id cancelIdleCallback takes
 */
export function requestIdleCallback(callback) {
	const id = nextId++;

	live.add(id);
	rtYield().then(() => {
		if (!live.delete(id)) return;
		const start = performance.now();

		callback({
			didTimeout: false,
			timeRemaining: () => Math.max(0, IDLE_BUDGET_MS - (performance.now() - start))
		});
	});

	return id;
}

export { clearImmediate as cancelIdleCallback };
