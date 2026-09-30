// setTimeout, setInterval and setImmediate as Node (and Bun) has them, returning Timeout and
// Immediate objects (ref, unref, hasRef, refresh, close; a Timeout's primitive value is its id),
// over the runtime's timers (runtime/timers.mjs: the platform's clock and loop). The clear
// functions take the object or its id.
//
// An unref()'d timer does not keep a native program running (libuv's unref); in a WASI
// component an export runs until its waits are done, so there unref changes nothing.
import {
	clearImmediate as clearHostImmediate,
	clearTimeout as clearHostTimeout,
	setImmediate as setHostImmediate,
	setInterval as setHostInterval,
	setTimeout as setHostTimeout,
	setTimerRef
} from './timers.mjs';

// Node's limit: a delay over 2^31 - 1 ms (or not a number) is 1 ms
const TIMEOUT_MAX = 2 ** 31 - 1;

const checkCallback = (callback) => {
	if (typeof callback !== 'function') {
		const e = new TypeError(
			`The "callback" argument must be of type function. Received ${callback === null ? 'null' : typeof callback}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
};

const delayMs = (delay) => {
	const ms = Number(delay);
	return ms >= 1 && ms <= TIMEOUT_MAX ? ms : 1;
};

let nextId = 1;
// the timers by their ids, for a clear given the id (a Timeout's primitive value)
const byId = new Map();

/** A timer from setTimeout or setInterval. */
export class Timeout {
	constructor(callback, delay, args, repeat) {
		this._id = nextId++;
		this._callback = callback;
		this._delay = delayMs(delay);
		this._args = args;
		this._repeat = repeat;
		this._ref = true;
		this._handle = 0;
		this._destroyed = false;
		byId.set(this._id, this);
		this._start();
	}

	_start() {
		const run = () => {
			if (!this._repeat) {
				this._destroyed = true;
				byId.delete(this._id);
			}
			this._callback(...this._args);
		};
		this._handle = this._repeat
			? setHostInterval(run, this._delay)
			: setHostTimeout(run, this._delay);
		if (!this._ref) setTimerRef(this._handle, false);
	}

	/** Keeps the program running until the timer fires (the default). */
	ref() {
		this._ref = true;
		if (!this._destroyed) setTimerRef(this._handle, true);
		return this;
	}

	/** Lets the program end while the timer is pending. */
	unref() {
		this._ref = false;
		if (!this._destroyed) setTimerRef(this._handle, false);
		return this;
	}

	hasRef() {
		return this._ref;
	}

	/** Starts the timer's delay over, now. */
	refresh() {
		if (this._destroyed) return this;
		clearHostTimeout(this._handle);
		this._start();
		return this;
	}

	/** Cancels the timer. */
	close() {
		if (this._destroyed) return this;
		this._destroyed = true;
		byId.delete(this._id);
		clearHostTimeout(this._handle);
		return this;
	}

	[Symbol.toPrimitive]() {
		return this._id;
	}

	[Symbol.dispose]() {
		this.close();
	}
}

/** A callback queued by setImmediate. */
export class Immediate {
	constructor(callback, args) {
		this._ref = true;
		this._destroyed = false;
		this._handle = setHostImmediate(() => {
			this._destroyed = true;
			callback(...args);
		});
	}

	ref() {
		this._ref = true;
		return this;
	}

	unref() {
		this._ref = false;
		return this;
	}

	hasRef() {
		return this._ref;
	}

	[Symbol.dispose]() {
		clearImmediate(this);
	}
}

/**
 * Calls callback(...args) once, after delay milliseconds (1 when it is not a number from 1 to
 * 2^31 - 1).
 * @returns {Timeout}
 */
export function setTimeout(callback, delay, ...args) {
	checkCallback(callback);
	return new Timeout(callback, delay, args, false);
}

/**
 * Calls callback(...args) every delay milliseconds until cleared.
 * @returns {Timeout}
 */
export function setInterval(callback, delay, ...args) {
	checkCallback(callback);
	return new Timeout(callback, delay, args, true);
}

/** Cancels a Timeout, given it or its id; anything else is ignored. */
export function clearTimeout(timer) {
	if (timer instanceof Timeout) timer.close();
	else if (typeof timer === 'number' || typeof timer === 'string') byId.get(Number(timer))?.close();
}

export { clearTimeout as clearInterval };

/**
 * Calls callback(...args) once the loop has had its next turn (after its I/O).
 * @returns {Immediate}
 */
export function setImmediate(callback, ...args) {
	checkCallback(callback);
	return new Immediate(callback, args);
}

/** Cancels an Immediate. */
export function clearImmediate(immediate) {
	if (!(immediate instanceof Immediate) || immediate._destroyed) return;
	immediate._destroyed = true;
	clearHostImmediate(immediate._handle);
}

// (node:timers is this and its promises; the globals are this alone, so a program that only sets
// a timeout does not carry timers/promises)
