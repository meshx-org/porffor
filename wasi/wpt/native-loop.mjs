// The event loop of a WPT test compiled natively (Porffor to C, run by tcc): what a component
// gets from its host, in the calls the runtime's platform layer (runtime/host/wasi/async.mjs,
// clock.mjs) makes of it. The runner's bundle maps
// both `wasi:clocks/monotonic-clock@0.3.0` and `rt-async` (the glue's async runtime) here, so
// the guest runs the same timers shim a component does, over this queue instead of the host.
//
// runEventLoop is the host's part: drain the microtasks, then settle the wait that is due
// first (waiting for it in real time), and again, until nothing is pending.

/** Pending waits: { token, due (ms, performance.now), resolve, reject }, in no order. */
const waits = [];
let nextToken = 1;
let lastToken = 0;

/**
 * monotonic-clock.wait-for: a promise settled once `nanos` nanoseconds have passed.
 * @param {number | bigint} nanos
 * @returns {Promise<void>}
 */
export function waitFor(nanos) {
	const token = nextToken++;

	lastToken = token;

	return new Promise((resolve, reject) => {
		waits.push({ token, due: performance.now() + Number(nanos) / 1_000_000, resolve, reject });
	});
}

/** The token of the wait started last, which rtCancel takes. */
export const rtLastToken = () => lastToken;

/** Cancels a pending wait: its promise rejects with `reason`. An unknown token is ignored. */
export function rtCancel(token, reason) {
	const index = waits.findIndex((wait) => wait.token === token);

	if (index < 0) return;
	const [wait] = waits.splice(index, 1);

	wait.reject(reason);
}

/** Runs the promise jobs queued so far; an unhandled rejection is reported, not thrown. */
function drainJobs(onError) {
	try {
		Porffor.promise.runJobs();
	} catch (error) {
		onError(error);
	}
}

/**
 * Runs the program's event loop: jobs, then the earliest timer, until no job and no wait is
 * left, or until `finished()` (a test's timers left running once the harness is done do not
 * matter, as they do not in a browser once it reports). Errors escaping a job go to
 * onError.
 * @param {(error: unknown) => void} onError
 * @param {() => boolean} finished
 */
export function runEventLoop(onError, finished) {
	drainJobs(onError);

	while (waits.length > 0 && !finished()) {
		let first = 0;

		for (let index = 1; index < waits.length; index++)
			if (waits[index].due < waits[first].due) first = index;
		const [wait] = waits.splice(first, 1);

		// the time has to pass: tests compare timers with performance.now and Date.now
		while (performance.now() < wait.due);
		wait.resolve();
		drainJobs(onError);
	}
}

/** Operations waiting for rtSettle: token -> [resolve, reject, lift]. */
const operations = new Map();

/** A promise settled by rtSettle(token), with what lift makes. */
export function rtAwait(token, lift) {
	lastToken = token;

	return new Promise((resolve, reject) => {
		operations.set(token, [resolve, reject, lift]);
	});
}

/** An operation's end: its promise settles with what its lift makes. */
export function rtSettle(token) {
	const operation = operations.get(token);

	if (operation === undefined) return 0;
	operations.delete(token);

	try {
		operation[0](operation[2]());
	} catch (error) {
		operation[1](error);
	}

	return 0;
}

/** An operation that finished at once. */
export function rtNow(lift) {
	lastToken = 0;

	try {
		return Promise.resolve(lift());
	} catch (error) {
		return Promise.reject(error);
	}
}

/** A promise settled after the loop's next turn: a wait of nothing. */
export const rtYield = () => waitFor(0);
