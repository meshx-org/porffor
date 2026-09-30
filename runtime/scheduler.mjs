// scheduler.yield and requestIdleCallback, over the platform's yields (porffor:async's
// rtYield). In a WASI build an async export's loop gives the host a turn (the component model's
// thread.yield) before it settles them, so a long computation that awaits scheduler.yield() now
// and then lets the host run meanwhile; in a sync export the host cannot get a turn, and a yield
// settles once the microtasks have run. Natively a yield settles in libuv's check phase, after
// the loop's I/O.

import { rtYield } from 'porffor:async';

/** How long an idle callback may run, in milliseconds, as browsers budget it. */
const IDLE_BUDGET_MS = 50;

/** The Prioritized Task Scheduling API's yield: resolves after the host has had a turn. */
export const scheduler = {
	yield() {
		return rtYield();
	}
};

/** Live idle callbacks: ids a cancel has not removed. */
const live = /* @__PURE__ */ new Set();
let nextId = 1;

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

/** Cancels an idle callback; an unknown id is ignored. */
export function cancelIdleCallback(id) {
	live.delete(id);
}
