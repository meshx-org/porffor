// node:events: EventEmitter, as Node has it: listeners called in order, synchronously, by
// emit(); 'error' with no listener throws; 'newListener' / 'removeListener' events; once()
// wrappers that off() finds by the original function; the max-listeners leak warning. Plus the
// module's helpers: once(emitter, name) as a promise, on(emitter, name) as an async iterator,
// listenerCount, getEventListeners.
//
// EventEmitter is a plain function with a prototype, not a class: old code subclasses it with
// util.inherits and calls EventEmitter.call(this), which a class constructor refuses.

const kCapture = Symbol('kCapture');
let defaultMaxListeners = 10;

/** Node's ERR_INVALID_ARG_TYPE for a listener that is not a function. */
const checkListener = (listener) => {
	if (typeof listener !== 'function') {
		const e = new TypeError(
			`The "listener" argument must be of type function. Received ${listener === null ? 'null' : typeof listener}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
};

/**
 * Emits named events to the listeners registered for them.
 * @param {{ captureRejections?: boolean }} [options]
 */
export function EventEmitter(options) {
	EventEmitter.init.call(this, options);
}

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;

/** Sets up an emitter's state: what `EventEmitter.call(this)` does in a subclass. */
EventEmitter.init = function (options) {
	if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
		this._events = Object.create(null);
		this._eventsCount = 0;
	}
	this._maxListeners = this._maxListeners || undefined;
	if (options?.captureRejections) this[kCapture] = true;
};

Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
	enumerable: true,
	get: () => defaultMaxListeners,
	set: (n) => {
		if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
			const e = new RangeError(
				`The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ${n}`
			);
			e.code = 'ERR_OUT_OF_RANGE';
			throw e;
		}
		defaultMaxListeners = n;
	}
});

EventEmitter.errorMonitor = Symbol('events.errorMonitor');
EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');

const events = (emitter) => {
	if (emitter._events === undefined) {
		emitter._events = Object.create(null);
		emitter._eventsCount = 0;
	}
	return emitter._events;
};

// the listener a once() wrapper stands for, or the listener itself
const unwrap = (listener) => listener.listener ?? listener;

EventEmitter.prototype.setMaxListeners = function (n) {
	if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
		const e = new RangeError(
			`The value of "n" is out of range. It must be a non-negative number. Received ${n}`
		);
		e.code = 'ERR_OUT_OF_RANGE';
		throw e;
	}
	this._maxListeners = n;
	return this;
};

EventEmitter.prototype.getMaxListeners = function () {
	return this._maxListeners === undefined ? defaultMaxListeners : this._maxListeners;
};

/**
 * Calls each listener of `name` with args, in the order they were added.
 * @returns {boolean} whether there were listeners
 */
EventEmitter.prototype.emit = function (name, ...args) {
	const all = events(this);

	if (name === 'error') {
		if (all[EventEmitter.errorMonitor] !== undefined) this.emit(EventEmitter.errorMonitor, ...args);
		if (all.error === undefined) {
			const error = args[0];
			if (error instanceof Error) throw error;
			const e = new Error(`Unhandled error. (${inspectValue(error)})`);
			e.code = 'ERR_UNHANDLED_ERROR';
			e.context = error;
			throw e;
		}
	}

	const handlers = all[name];
	if (handlers === undefined) return false;

	// a copy: a listener that adds or removes listeners does not change this emit's list
	for (const handler of handlers.slice()) {
		const result = handler.apply(this, args);
		if (this[kCapture] && result !== undefined && typeof result?.then === 'function') {
			result.then(undefined, (error) => {
				const own = this[EventEmitter.captureRejectionSymbol];
				if (typeof own === 'function') own.call(this, error, name, ...args);
				else Promise.resolve().then(() => this.emit('error', error));
			});
		}
	}
	return true;
};

// a short form of a value for an error message
const inspectValue = (value) => {
	if (typeof value === 'string') return `'${value}'`;
	if (value === null || typeof value !== 'object') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
};

const addListener = (emitter, name, listener, prepend) => {
	checkListener(listener);
	const all = events(emitter);

	// 'newListener' before the listener is in: a listener for it does not hear about itself
	if (all.newListener !== undefined) emitter.emit('newListener', name, unwrap(listener));

	const handlers = all[name];
	if (handlers === undefined) {
		all[name] = [listener];
		emitter._eventsCount++;
	} else if (prepend) handlers.unshift(listener);
	else handlers.push(listener);

	const max = emitter.getMaxListeners();
	const count = all[name].length;
	if (max > 0 && count > max && !all[name].warned) {
		all[name].warned = true;
		const label = typeof name === 'symbol' ? name.toString() : name;
		console.error(
			`(node) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. ${count} ${label} listeners added to ${emitter.constructor?.name ?? 'EventEmitter'}. MaxListeners is ${max}. Use emitter.setMaxListeners() to increase limit`
		);
	}
	return emitter;
};

EventEmitter.prototype.on = function (name, listener) {
	return addListener(this, name, listener, false);
};
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

EventEmitter.prototype.prependListener = function (name, listener) {
	return addListener(this, name, listener, true);
};

// a listener that removes itself, then calls listener: off(listener) finds it by .listener
const onceWrapper = (emitter, name, listener) => {
	let fired = false;
	const wrapper = function (...args) {
		if (fired) return undefined;
		fired = true;
		emitter.removeListener(name, wrapper);
		return listener.apply(this, args);
	};
	wrapper.listener = listener;
	return wrapper;
};

EventEmitter.prototype.once = function (name, listener) {
	checkListener(listener);
	return addListener(this, name, onceWrapper(this, name, listener), false);
};

EventEmitter.prototype.prependOnceListener = function (name, listener) {
	checkListener(listener);
	return addListener(this, name, onceWrapper(this, name, listener), true);
};

/** Removes the last-added registration of listener (or of a once() wrapper for it). */
EventEmitter.prototype.removeListener = function (name, listener) {
	checkListener(listener);
	const all = events(this);
	const handlers = all[name];
	if (handlers === undefined) return this;

	for (let i = handlers.length - 1; i >= 0; i--) {
		if (handlers[i] === listener || handlers[i].listener === listener) {
			handlers.splice(i, 1);
			if (handlers.length === 0) {
				delete all[name];
				this._eventsCount--;
			}
			if (all.removeListener !== undefined) this.emit('removeListener', name, listener);
			break;
		}
	}
	return this;
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function (name) {
	const all = events(this);
	const names = name === undefined ? Reflect.ownKeys(all) : [name];

	for (const key of names) {
		// 'removeListener' listeners go last, so they hear about the others
		if (name === undefined && key === 'removeListener') continue;
		const handlers = all[key];
		if (handlers === undefined) continue;
		if (all.removeListener !== undefined && key !== 'removeListener') {
			for (let i = handlers.length - 1; i >= 0; i--) this.removeListener(key, handlers[i]);
		} else {
			delete all[key];
			this._eventsCount--;
		}
	}
	if (name === undefined && all.removeListener !== undefined) {
		delete all.removeListener;
		this._eventsCount--;
	}
	return this;
};

/** The listeners of `name`, once() wrappers unwrapped. */
EventEmitter.prototype.listeners = function (name) {
	return (events(this)[name] ?? []).map(unwrap);
};

/** The listeners of `name`, once() wrappers as they are. */
EventEmitter.prototype.rawListeners = function (name) {
	return (events(this)[name] ?? []).slice();
};

/** How many listeners `name` has (of `listener`, when given). */
EventEmitter.prototype.listenerCount = function (name, listener) {
	const handlers = events(this)[name] ?? [];
	if (listener === undefined) return handlers.length;
	return handlers.filter((h) => h === listener || h.listener === listener).length;
};

/** The names (strings and symbols) that have listeners. */
EventEmitter.prototype.eventNames = function () {
	return Reflect.ownKeys(events(this));
};

/**
 * A promise of the arguments of the next `name` event; rejected by an 'error' event first, or
 * by the signal's abort.
 * @param {EventEmitter | EventTarget} emitter
 * @param {string | symbol} name
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<unknown[]>}
 */
export function once(emitter, name, options) {
	return new Promise((resolve, reject) => {
		const signal = options?.signal;
		if (signal?.aborted) {
			reject(abortError(signal.reason));
			return;
		}

		// an EventTarget: addEventListener with { once }
		if (typeof emitter.addEventListener === 'function' && typeof emitter.on !== 'function') {
			emitter.addEventListener(name, (event) => resolve([event]), { once: true });
			return;
		}

		const done = () => {
			emitter.removeListener(name, onEvent);
			if (name !== 'error') emitter.removeListener('error', onError);
			signal?.removeEventListener?.('abort', onAbort);
		};
		const onEvent = (...args) => {
			done();
			resolve(args);
		};
		const onError = (error) => {
			done();
			reject(error);
		};
		const onAbort = () => {
			done();
			reject(abortError(signal.reason));
		};
		emitter.on(name, onEvent);
		if (name !== 'error') emitter.on('error', onError);
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

const abortError = (cause) => {
	const e = new Error('The operation was aborted');
	e.name = 'AbortError';
	e.code = 'ABORT_ERR';
	if (cause !== undefined) e.cause = cause;
	return e;
};

/**
 * The `name` events of emitter as an async iterator of their argument arrays, until an 'error'
 * event (which it throws) or return().
 * @param {EventEmitter} emitter
 * @param {string | symbol} name
 */
export function on(emitter, name, options) {
	const queue = [];
	const waiting = [];
	let failure = null;
	let finished = false;
	const signal = options?.signal;

	const onEvent = (...args) => {
		const next = waiting.shift();
		if (next !== undefined) next.resolve({ value: args, done: false });
		else queue.push(args);
	};
	const stop = () => {
		finished = true;
		emitter.removeListener(name, onEvent);
		emitter.removeListener('error', onError);
		for (const next of waiting.splice(0)) next.resolve({ value: undefined, done: true });
	};
	const onError = (error) => {
		const next = waiting.shift();
		if (next !== undefined) next.reject(error);
		else failure = error;
		stop();
	};
	emitter.on(name, onEvent);
	if (name !== 'error') emitter.on('error', onError);
	signal?.addEventListener?.('abort', () => onError(abortError(signal.reason)), { once: true });

	return {
		next() {
			if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
			if (failure !== null) {
				const error = failure;
				failure = null;
				return Promise.reject(error);
			}
			if (finished) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
		},
		return() {
			stop();
			return Promise.resolve({ value: undefined, done: true });
		},
		throw(error) {
			onError(error);
			return Promise.reject(error);
		},
		[Symbol.asyncIterator]() {
			return this;
		}
	};
}

/** How many listeners emitter has for `name` (the deprecated static form). */
export const listenerCount = (emitter, name) => emitter.listenerCount(name);

/** The listeners of `name` on an EventEmitter. */
export const getEventListeners = (emitter, name) => emitter.listeners(name);

/** Sets the max listeners of each emitter given (all emitters' default, when none are). */
export const setMaxListeners = (n = defaultMaxListeners, ...emitters) => {
	if (emitters.length === 0) EventEmitter.defaultMaxListeners = n;
	for (const emitter of emitters) emitter.setMaxListeners?.(n);
};

export const errorMonitor = EventEmitter.errorMonitor;
export const captureRejectionSymbol = EventEmitter.captureRejectionSymbol;

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.once = once;
EventEmitter.on = on;
EventEmitter.listenerCount = listenerCount;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.setMaxListeners = setMaxListeners;

export default EventEmitter;
