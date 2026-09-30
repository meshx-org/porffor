// The state machine behind WritableStream, its writer and its controller: the Streams
// standard's writable stream abstract operations (https://streams.spec.whatwg.org/#ws-abstract-ops),
// in plain JS and in the standard's order, since programs (and the web-platform-tests) see
// that order through their sinks and promises. Fields live on the stream (_state,
// _writeRequests, _pendingAbort, …), the writer (_closed, _ready) and the controller (_queue,
// _started, the algorithms); these functions are the only ones that change them.

import { callback, deferred, react, resolvedWith } from './stream-queue.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** Proves a controller is built here, not by a program (whose `new` must throw). */
export const internalToken = {};
const internal = internalToken;

/** What the controller's queue holds for a close, after the chunks written before it. */
const closeSentinel = {};

/**
 * A promise with its resolve and reject that knows whether it has settled, and whose
 * rejection is handled (nobody is obliged to look at a writer's ready or closed).
 */
export function promiseRecord() {
	const out = deferred();
	const { resolve, reject } = out;

	out.pending = true;
	out.resolve = (value) => {
		out.pending = false;
		resolve(value);
	};
	out.reject = (reason) => {
		out.pending = false;
		reject(reason);
	};
	react(out.promise, ignore, ignore);

	return out;
}

/** A settled record: resolved with undefined, or rejected with `reason` (and handled). */
function settledRecord(rejected, reason) {
	const out = promiseRecord();

	if (rejected) out.reject(reason);
	else out.resolve();

	return out;
}

/**
 * An AbortSignal-shaped signal (aborted, reason, onabort, abort listeners, throwIfAborted),
 * not a real one: AbortSignal brings its event machinery and a clock (AbortSignal.timeout)
 * into every program that writes to a stream, and most sinks never look at the signal.
 */
function streamSignal() {
	return {
		aborted: false,
		reason: undefined,
		onabort: null,
		_listeners: [],
		addEventListener(type, listener) {
			if (type === 'abort') this._listeners.push(listener);
		},
		// a loop, not indexOf and splice, which compile in more than this whole signal
		removeEventListener(type, listener) {
			if (type !== 'abort') return;
			const kept = [];

			for (const other of this._listeners) if (other !== listener) kept.push(other);
			this._listeners = kept;
		},
		throwIfAborted() {
			if (this.aborted) throw this.reason;
		}
	};
}

/** Signals a controller's abort (when a sink asked for its signal): onabort, then the listeners. */
function signalAbort(controller, reason) {
	const signal = controller._signal;

	if (signal === undefined) {
		// nobody holds the signal yet: it is born aborted when asked for
		controller._abortReason = reason === undefined ? abortError() : reason;
		controller._aborted = true;

		return;
	}

	if (signal.aborted) return;
	signal.aborted = true;
	signal.reason = reason === undefined ? abortError() : reason;
	const event = { type: 'abort', target: signal };

	if (typeof signal.onabort === 'function') signal.onabort(event);

	for (const listener of [...signal._listeners]) listener(event);
}

/** What an abort without a reason aborts with. */
function abortError() {
	const out = new Error('This operation was aborted');

	out.name = 'AbortError';

	return out;
}

/** The controller a WritableStream's sink is handed: it can error the stream, or hear an abort. */
export class WritableStreamDefaultController {
	constructor(token = undefined) {
		if (token !== internal) throw new TypeError('Illegal constructor');
	}

	/**
	 * Aborts when the stream is aborted, with abort()'s reason (an AbortError without one):
	 * for a sink to stop a write in flight. Shaped like an AbortSignal (aborted, reason,
	 * onabort, addEventListener('abort'), throwIfAborted) but not one.
	 */
	get signal() {
		if (this._signal === undefined) {
			this._signal = streamSignal();

			if (this._aborted) {
				this._signal.aborted = true;
				this._signal.reason = this._abortReason;
			}
		}

		return this._signal;
	}

	/** Errors the stream: queued writes reject with `reason`. */
	error(reason = undefined) {
		if (this._stream._state === 'writable') controllerError(this, reason);
	}
}

/** Calls a sink's method with the sink as `this`, as a promise (a throw is a rejection). */
function promiseCall(method, sink, args) {
	if (method === undefined) return Promise.resolve();

	try {
		return resolvedWith(Reflect.apply(method, sink, args));
	} catch (reason) {
		return Promise.reject(reason);
	}
}

/**
 * Sets up a WritableStream from an underlying sink (the constructor's work, after the
 * strategy): its methods read once, as WebIDL converts the UnderlyingSink dictionary.
 */
export function setUpFromSink(stream, underlyingSink, hwm, size) {
	const sink = underlyingSink ?? {};
	const abort = callback(sink, 'abort', 'WritableStream');
	const close = callback(sink, 'close', 'WritableStream');
	const start = callback(sink, 'start', 'WritableStream');
	const type = sink.type;
	const write = callback(sink, 'write', 'WritableStream');

	if (type !== undefined) throw new RangeError('WritableStream: invalid type');
	const controller = new WritableStreamDefaultController(internal);

	setUpWritable(
		stream,
		controller,
		() => (start === undefined ? undefined : Reflect.apply(start, sink, [controller])),
		(chunk) => promiseCall(write, sink, [chunk, controller]),
		() => promiseCall(close, sink, []),
		(reason) => promiseCall(abort, sink, [reason]),
		hwm,
		size
	);
}

/** InitializeWritableStream: the stream's own fields. */
function initialize(stream) {
	stream._state = 'writable';
	stream._storedError = undefined;
	stream._writer = undefined;
	stream._controller = undefined;
	stream._writeRequests = [];
	stream._inFlightWrite = undefined;
	stream._closeRequest = undefined;
	stream._inFlightClose = undefined;
	stream._pendingAbort = undefined;
	stream._backpressure = false;
}

/**
 * SetUpWritableStreamDefaultController: a stream run by algorithms (a sink's methods, or a
 * TransformStream's). start returns a value or a promise (a throw leaves here); write, close
 * and abort return promises. `size` is a strategy's size function, or undefined for 1 each.
 */
export function setUpWritable(
	stream,
	controller,
	startAlgorithm,
	writeAlgorithm,
	closeAlgorithm,
	abortAlgorithm,
	hwm,
	size
) {
	initialize(stream);
	controller._stream = stream;
	stream._controller = controller;
	controller._queue = [];
	controller._sizes = [];
	controller._queueTotal = 0;
	controller._signal = undefined;
	controller._aborted = false;
	controller._abortReason = undefined;
	controller._started = false;
	controller._size = size;
	controller._hwm = hwm;
	controller._write = writeAlgorithm;
	controller._close = closeAlgorithm;
	controller._abort = abortAlgorithm;
	updateBackpressure(stream, backpressure(controller));
	const started = startAlgorithm();

	react(
		resolvedWith(started),
		() => {
			controller._started = true;
			advanceQueueIfNeeded(controller);
		},
		(reason) => {
			controller._started = true;
			dealWithRejection(stream, reason);
		}
	);
}

/** Whether a close is queued or with the sink. */
export function closeQueuedOrInFlight(stream) {
	return stream._closeRequest !== undefined || stream._inFlightClose !== undefined;
}

function hasOperationMarkedInFlight(stream) {
	return stream._inFlightWrite !== undefined || stream._inFlightClose !== undefined;
}

/** WritableStreamAbort: queued writes are dropped, the sink hears why once nothing is in flight. */
export function abort(stream, reason) {
	if (stream._state === 'closed' || stream._state === 'errored') return Promise.resolve();
	// the sink's signal hears it first, so a write in flight can stop
	signalAbort(stream._controller, reason);
	const state = stream._state;

	if (state === 'closed' || state === 'errored') return Promise.resolve();

	if (stream._pendingAbort !== undefined) return stream._pendingAbort.record.promise;
	const wasAlreadyErroring = state === 'erroring';
	const record = deferred();

	stream._pendingAbort = {
		record,
		reason: wasAlreadyErroring ? undefined : reason,
		wasAlreadyErroring
	};

	if (!wasAlreadyErroring) startErroring(stream, reason);

	return record.promise;
}

/** WritableStreamClose: closes once the queued writes are done; resolves when the sink has. */
export function close(stream) {
	const state = stream._state;

	if (state === 'closed' || state === 'errored')
		return Promise.reject(new TypeError('WritableStream: already closed or errored'));
	const record = deferred();

	stream._closeRequest = record;
	const writer = stream._writer;

	if (writer !== undefined && stream._backpressure && state === 'writable') writer._ready.resolve();
	// the close sentinel, with size 0
	enqueueValue(stream._controller, closeSentinel, 0);
	advanceQueueIfNeeded(stream._controller);

	return record.promise;
}

function dealWithRejection(stream, reason) {
	if (stream._state === 'writable') {
		startErroring(stream, reason);

		return;
	}
	finishErroring(stream);
}

function startErroring(stream, reason) {
	const controller = stream._controller;

	stream._state = 'erroring';
	stream._storedError = reason;
	const writer = stream._writer;

	if (writer !== undefined) ensureReadyRejected(writer, reason);

	if (!hasOperationMarkedInFlight(stream) && controller._started) finishErroring(stream);
}

function finishErroring(stream) {
	stream._state = 'errored';
	const controller = stream._controller;

	resetQueue(controller);
	const storedError = stream._storedError;
	const requests = stream._writeRequests;

	stream._writeRequests = [];

	for (const request of requests) request.reject(storedError);
	const abortRequest = stream._pendingAbort;

	if (abortRequest === undefined) {
		rejectCloseAndClosedIfNeeded(stream);

		return;
	}
	stream._pendingAbort = undefined;

	if (abortRequest.wasAlreadyErroring) {
		abortRequest.record.reject(storedError);
		rejectCloseAndClosedIfNeeded(stream);

		return;
	}
	const aborted = controller._abort(abortRequest.reason);

	clearAlgorithms(controller);
	react(
		aborted,
		() => {
			abortRequest.record.resolve();
			rejectCloseAndClosedIfNeeded(stream);
		},
		(reason) => {
			abortRequest.record.reject(reason);
			rejectCloseAndClosedIfNeeded(stream);
		}
	);
}

function finishInFlightWrite(stream) {
	stream._inFlightWrite.resolve();
	stream._inFlightWrite = undefined;
}

function finishInFlightWriteWithError(stream, reason) {
	stream._inFlightWrite.reject(reason);
	stream._inFlightWrite = undefined;
	dealWithRejection(stream, reason);
}

function finishInFlightClose(stream) {
	stream._inFlightClose.resolve();
	stream._inFlightClose = undefined;

	if (stream._state === 'erroring') {
		stream._storedError = undefined;

		if (stream._pendingAbort !== undefined) {
			stream._pendingAbort.record.resolve();
			stream._pendingAbort = undefined;
		}
	}
	stream._state = 'closed';
	const writer = stream._writer;

	if (writer !== undefined) writer._closed.resolve();
}

function finishInFlightCloseWithError(stream, reason) {
	stream._inFlightClose.reject(reason);
	stream._inFlightClose = undefined;

	if (stream._pendingAbort !== undefined) {
		stream._pendingAbort.record.reject(reason);
		stream._pendingAbort = undefined;
	}
	dealWithRejection(stream, reason);
}

function rejectCloseAndClosedIfNeeded(stream) {
	if (stream._closeRequest !== undefined) {
		stream._closeRequest.reject(stream._storedError);
		stream._closeRequest = undefined;
	}
	const writer = stream._writer;

	if (writer !== undefined) {
		writer._closed.reject(stream._storedError);
	}
}

function updateBackpressure(stream, pressure) {
	const writer = stream._writer;

	if (writer !== undefined && pressure !== stream._backpressure) {
		if (pressure) writer._ready = promiseRecord();
		else writer._ready.resolve();
	}
	stream._backpressure = pressure;
}

/** A writer's ready rejects with `reason` (a new rejected promise when it had settled). */
export function ensureReadyRejected(writer, reason) {
	if (writer._ready.pending) writer._ready.reject(reason);
	else writer._ready = settledRecord(true, reason);
}

function ensureClosedRejected(writer, reason) {
	if (writer._closed.pending) writer._closed.reject(reason);
	else writer._closed = settledRecord(true, reason);
}

/** SetUpWritableStreamDefaultWriter: locks `stream` to `writer`. */
export function setUpWriter(writer, stream) {
	if (stream._writer !== undefined)
		throw new TypeError('WritableStreamDefaultWriter: the stream is locked to another writer');
	writer._stream = stream;
	stream._writer = writer;
	const state = stream._state;

	if (state === 'writable') {
		writer._ready = settledRecord(false);

		if (!closeQueuedOrInFlight(stream) && stream._backpressure) writer._ready = promiseRecord();
		writer._closed = promiseRecord();
	} else if (state === 'erroring') {
		writer._ready = settledRecord(true, stream._storedError);
		writer._closed = promiseRecord();
	} else if (state === 'closed') {
		writer._ready = settledRecord(false);
		writer._closed = settledRecord(false);
	} else {
		writer._ready = settledRecord(true, stream._storedError);
		writer._closed = settledRecord(true, stream._storedError);
	}
}

/** WritableStreamDefaultWriterGetDesiredSize: null once errored or erroring, 0 once closed. */
export function writerDesiredSize(stream) {
	const state = stream._state;

	if (state === 'errored' || state === 'erroring') return null;

	if (state === 'closed') return 0;

	return stream._controller._hwm - stream._controller._queueTotal;
}

/** WritableStreamDefaultWriterRelease: unlocks; ready and closed reject from here on. */
export function releaseWriter(writer) {
	const stream = writer._stream;
	const released = new TypeError('WritableStreamDefaultWriter: the writer was released');

	ensureReadyRejected(writer, released);
	ensureClosedRejected(writer, released);
	stream._writer = undefined;
	writer._stream = undefined;
}

/** WritableStreamDefaultWriterWrite: queues a chunk; resolves once the sink has taken it. */
export function writerWrite(writer, chunk) {
	const stream = writer._stream;
	const controller = stream._controller;
	const size = controllerChunkSize(controller, chunk);

	if (stream !== writer._stream)
		return Promise.reject(new TypeError('WritableStreamDefaultWriter: the writer was released'));
	const state = stream._state;

	if (state === 'errored') return Promise.reject(stream._storedError);

	if (closeQueuedOrInFlight(stream) || state === 'closed')
		return Promise.reject(new TypeError('WritableStream: cannot write to a closing stream'));

	if (state === 'erroring') return Promise.reject(stream._storedError);
	const request = deferred();

	stream._writeRequests.push(request);
	controllerWrite(controller, chunk, size);

	return request.promise;
}

/** WritableStreamDefaultWriterCloseWithErrorPropagation (for pipeTo). */
export function writerCloseWithErrorPropagation(writer) {
	const stream = writer._stream;
	const state = stream._state;

	if (closeQueuedOrInFlight(stream) || state === 'closed') return Promise.resolve();

	if (state === 'errored') return Promise.reject(stream._storedError);

	return close(stream);
}

/** WritableStreamDefaultControllerErrorIfNeeded. */
export function errorIfNeeded(controller, reason) {
	if (controller._stream._state === 'writable') controllerError(controller, reason);
}

function controllerError(controller, reason) {
	clearAlgorithms(controller);
	startErroring(controller._stream, reason);
}

function clearAlgorithms(controller) {
	controller._write = undefined;
	controller._close = undefined;
	controller._abort = undefined;
	controller._size = undefined;
}

function resetQueue(controller) {
	controller._queue = [];
	controller._sizes = [];
	controller._queueTotal = 0;
}

/** EnqueueValueWithSize: a RangeError for a size that is not a finite, non-negative number. */
function enqueueValue(controller, value, size) {
	if (!(size >= 0) || size === Infinity)
		throw new RangeError('The chunk size is not a finite, non-negative number');
	controller._queue.push(value);
	controller._sizes.push(size);
	controller._queueTotal += size;
}

function dequeueValue(controller) {
	const value = controller._queue.shift();

	controller._queueTotal -= controller._sizes.shift();

	// rounding can take a sum of fractional sizes below zero
	if (controller._queueTotal < 0) controller._queueTotal = 0;

	return value;
}

function backpressure(controller) {
	return controller._hwm - controller._queueTotal <= 0;
}

function controllerChunkSize(controller, chunk) {
	if (controller._size === undefined) return 1;

	try {
		// what the size function returns, checked when it is queued
		return +Reflect.apply(controller._size, undefined, [chunk]);
	} catch (reason) {
		errorIfNeeded(controller, reason);

		return 1;
	}
}

function controllerWrite(controller, chunk, size) {
	try {
		enqueueValue(controller, chunk, size);
	} catch (reason) {
		errorIfNeeded(controller, reason);

		return;
	}
	const stream = controller._stream;

	if (!closeQueuedOrInFlight(stream) && stream._state === 'writable')
		updateBackpressure(stream, backpressure(controller));
	advanceQueueIfNeeded(controller);
}

function advanceQueueIfNeeded(controller) {
	const stream = controller._stream;

	if (!controller._started || stream._inFlightWrite !== undefined) return;
	const state = stream._state;

	if (state === 'erroring') {
		finishErroring(stream);

		return;
	}

	if (state !== 'writable' || controller._queue.length === 0) return;
	const value = controller._queue[0];

	if (value === closeSentinel) processClose(controller);
	else processWrite(controller, value);
}

function processClose(controller) {
	const stream = controller._stream;

	stream._inFlightClose = stream._closeRequest;
	stream._closeRequest = undefined;
	dequeueValue(controller);
	const closed = controller._close();

	clearAlgorithms(controller);
	react(
		closed,
		() => finishInFlightClose(stream),
		(reason) => finishInFlightCloseWithError(stream, reason)
	);
}

function processWrite(controller, chunk) {
	const stream = controller._stream;

	stream._inFlightWrite = stream._writeRequests.shift();
	react(
		controller._write(chunk),
		() => {
			finishInFlightWrite(stream);
			dequeueValue(controller);

			if (!closeQueuedOrInFlight(stream) && stream._state === 'writable')
				updateBackpressure(stream, backpressure(controller));
			advanceQueueIfNeeded(controller);
		},
		(reason) => {
			if (stream._state === 'writable') clearAlgorithms(controller);
			finishInFlightWriteWithError(stream, reason);
		}
	);
}
