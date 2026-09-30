// node:timers/promises: the timers as promises (setTimeout, setImmediate) and an async iterator
// (setInterval), each cancelled by an AbortSignal (rejecting with Node's AbortError), over the
// runtime's timers (runtime/timers.mjs). Plus scheduler.wait and scheduler.yield.
import {
	clearImmediate,
	clearInterval,
	clearTimeout,
	setImmediate as setHostImmediate,
	setInterval as setHostInterval,
	setTimeout as setHostTimeout,
	setTimerRef
} from '../../timers.mjs';

/** Node's AbortError: what an aborted operation rejects with. */
class AbortError extends Error {
	constructor(message = 'The operation was aborted', options = undefined) {
		super(message, options);
		this.code = 'ABORT_ERR';
		this.name = 'AbortError';
	}
}

const abortError = (signal) => new AbortError(undefined, { cause: signal.reason });

const checkOptions = (options) => {
	if (options === null || typeof options !== 'object') {
		const e = new TypeError(
			`The "options" argument must be of type object. Received ${options === null ? 'null' : typeof options}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
	return options;
};

// a timer's promise, rejected (and the timer cleared) when the signal aborts
const cancellable = (start, clear, value, options) =>
	new Promise((resolve, reject) => {
		const { signal, ref = true } = checkOptions(options);
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clear(id);
			reject(abortError(signal));
		};
		const id = start(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve(value);
		});
		if (ref === false) setTimerRef(id, false);
		signal?.addEventListener('abort', onAbort, { once: true });
	});

/**
 * A promise of value, after delay milliseconds.
 * @param {number} [delay]
 * @param {unknown} [value]
 * @param {{ signal?: AbortSignal, ref?: boolean }} [options]
 */
export function setTimeout(delay, value, options = {}) {
	return cancellable((done) => setHostTimeout(done, delay), clearTimeout, value, options);
}

/**
 * A promise of value, once the loop has had its next turn.
 * @param {unknown} [value]
 * @param {{ signal?: AbortSignal }} [options]
 */
export function setImmediate(value, options = {}) {
	return cancellable((done) => setHostImmediate(done), clearImmediate, value, options);
}

/**
 * An async iterator that yields value every delay milliseconds (ticks that came while nothing
 * was waiting are yielded one after another), until return() or the signal's abort.
 * @param {number} [delay]
 * @param {unknown} [value]
 * @param {{ signal?: AbortSignal, ref?: boolean }} [options]
 */
export function setInterval(delay, value, options = {}) {
	const { signal, ref = true } = checkOptions(options);
	let ticks = 0;
	let waiting = null;
	let done = false;
	let id = 0;

	const finish = () => {
		if (done) return;
		done = true;
		clearInterval(id);
		signal?.removeEventListener('abort', onAbort);
	};
	const onAbort = () => {
		finish();
		if (waiting !== null) {
			waiting.reject(abortError(signal));
			waiting = null;
		}
	};

	if (!signal?.aborted) {
		id = setHostInterval(() => {
			if (waiting !== null) {
				const { resolve } = waiting;
				waiting = null;
				resolve({ value, done: false });
			} else ticks++;
		}, delay);
		if (ref === false) setTimerRef(id, false);
		signal?.addEventListener('abort', onAbort, { once: true });
	}

	return {
		next() {
			if (signal?.aborted) {
				finish();
				return Promise.reject(abortError(signal));
			}
			if (ticks > 0) {
				ticks--;
				return Promise.resolve({ value, done: false });
			}
			if (done) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve, reject) => {
				waiting = { resolve, reject };
			});
		},
		return() {
			finish();
			if (waiting !== null) {
				waiting.resolve({ value: undefined, done: true });
				waiting = null;
			}
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]() {
			return this;
		}
	};
}

/** Node's scheduler: wait(delay) and yield() as promises. */
export const scheduler = {
	/** A promise that resolves after delay milliseconds. */
	wait: (delay, options) => setTimeout(delay, undefined, options),
	/** A promise that resolves once the loop has had its next turn. */
	yield: () => setImmediate()
};

export default { setTimeout, setImmediate, setInterval, scheduler };
