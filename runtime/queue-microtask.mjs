// queueMicrotask, which Porffor lacks: a job on the promise job queue, as the microtask queue is.

/** Calls `callback` once the current job is done, before any timer or I/O. */
export function queueMicrotask(callback) {
	if (typeof callback !== 'function')
		throw new TypeError('The "callback" argument must be of type function');

	Promise.resolve().then(() => callback());
}
