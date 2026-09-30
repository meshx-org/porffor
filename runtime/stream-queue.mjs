// What the readable and the writable streams' state machines share (./stream-internals.mjs,
// ./writable-internals.mjs): a deferred for the reads, writes and closes that wait, and a
// chunk's size under a queuing strategy. Its own module so that writing to a stream does not
// compile in the readable side's machinery.

/**
 * Where other modules plug in when loaded: setUp for `type: 'bytes'`, reader for
 * getReader({ mode: 'byob' }) and tee for a byte stream's tee() (./readable-byte-stream.mjs),
 * pipe for pipeTo (./pipe.mjs, loaded with WritableStream), iterate and from for async
 * iteration and ReadableStream.from (./readable-stream-iteration.mjs). Each undefined when the program does not have it. Here, in
 * the module without imports, so it exists before any module that plugs in runs (the
 * streams' modules import each other in cycles, which order their evaluation otherwise).
 */
export const plugs = {
	setUp: undefined,
	reader: undefined,
	tee: undefined,
	pipe: undefined,
	iterate: undefined,
	from: undefined
};

/**
 * WebIDL's "a promise resolved with" `value`: a new promise, which a thenable `value` settles
 * a few microtasks later (Promise.resolve would hand a promise back as it is, sooner).
 */
export function resolvedWith(value) {
	return new Promise((resolve) => resolve(value));
}

/**
 * Invokes a callback with a promise return type, as WebIDL does: `method` (a function or
 * undefined) called on `self` with `args`, its result as a new promise, a throw as a rejection.
 */
export function promiseCall(method, self, args) {
	if (method === undefined) return Promise.resolve();

	try {
		return resolvedWith(Reflect.apply(method, self, args));
	} catch (reason) {
		return Promise.reject(reason);
	}
}

/** Promise.prototype.then as it was when the runtime loaded: a program's patch does not see streams. */
const promiseThen = Promise.prototype.then;

/**
 * Reacts to `promise` (the standard's "upon fulfillment / rejection") with the original then,
 * so a program that patches Promise.prototype.then does not see the streams' own reactions.
 */
export function react(promise, onFulfilled, onRejected) {
	return Reflect.apply(promiseThen, promise, [onFulfilled, onRejected]);
}

/** A promise with its resolve and reject, for reads, writes and a reader's or writer's closed. */
export function deferred() {
	const out = {};

	out.promise = new Promise((resolve, reject) => {
		out.resolve = resolve;
		out.reject = reject;
	});

	return out;
}

/**
 * A chunk's size under `size` (a strategy's size function): a RangeError for a negative,
 * NaN or infinite one. Called without a `this`, as the standard calls it.
 */
export function chunkSize(size, chunk) {
	// unary +, not Number(): Porffor's Number(undefined) is 0, not NaN
	const out = +size(chunk);

	if (!(out >= 0) || out === Infinity)
		throw new RangeError('The chunk size is not a finite, non-negative number');

	return out;
}

/** Whether WebIDL takes `value` as an `optional object` argument: undefined or an object. */
export function isOptionalObject(value) {
	return (
		value === undefined ||
		(value !== null && (typeof value === 'object' || typeof value === 'function'))
	);
}

/** Whether WebIDL takes `value` as a dictionary: undefined, null or an object. */
export function isDictionary(value) {
	return (
		value === undefined ||
		value === null ||
		typeof value === 'object' ||
		typeof value === 'function'
	);
}

/** A dictionary member that must be a function, or left out. */
export function callback(dict, name, owner) {
	const value = dict[name];

	if (value !== undefined && typeof value !== 'function')
		throw new TypeError(`${owner}: ${name} must be a function`);

	return value;
}

/**
 * A queuing strategy converted as WebIDL converts the QueuingStrategy dictionary, then its
 * high-water mark (`fallback` when it gives none) and size function checked: the TypeError
 * or RangeError a stream's constructor throws for a bad one.
 */
export function extractStrategy(strategy, fallback, owner) {
	if (!isDictionary(strategy)) throw new TypeError(`${owner}: the strategy must be an object`);
	const dict = strategy ?? {};
	const rawHwm = dict.highWaterMark;
	// unary +, not Number(): Porffor's Number(undefined) is 0, not NaN
	const hwm = rawHwm === undefined ? fallback : +rawHwm;
	const size = callback(dict, 'size', owner);

	if (hwm !== hwm || hwm < 0) throw new RangeError(`${owner}: invalid highWaterMark`);

	return { hwm, size };
}
