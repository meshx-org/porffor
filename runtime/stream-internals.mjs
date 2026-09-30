// The state machine behind ReadableStream and its reader (the Streams standard's readable
// stream abstract operations, https://streams.spec.whatwg.org/#rs-abstract-ops, in plain JS
// and in the standard's order): a queue of chunks, the read requests waiting for one, and
// pulling the underlying source when a read or the high-water mark wants more. Fields live
// on the stream object (_state, _queue, _reads, …); these functions are the only ones that
// change them. A byte stream (type: 'bytes') shares the fields and these functions, and adds
// its own through `stream._bytes` (./readable-byte-stream.mjs), which is only compiled in
// when a program names its classes: nothing here imports it.
//
// A read request is an object with resolve({ value, done }) and reject(reason), called
// synchronously when a chunk comes (a deferred is one; pipeTo brings its own).

import {
	callback,
	chunkSize,
	deferred,
	promiseCall,
	react,
	resolvedWith
} from './stream-queue.mjs';

export { deferred };

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** Proves a controller is built here, not by a program (whose `new` must throw). */
const internal = {};

// where other modules plug in when loaded (stream-queue.mjs: evaluated before any of them)
export { plugs as byteStreams } from './stream-queue.mjs';

/** The controller a default ReadableStream's source is handed: it feeds and ends the stream. */
export class ReadableStreamDefaultController {
	constructor(token = undefined) {
		if (token !== internal) throw new TypeError('Illegal constructor');
	}

	/** How much the queue wants before it is full (the high-water mark less what it holds). */
	get desiredSize() {
		return desiredSize(this._stream);
	}

	/** Queues a chunk, or hands it to a read waiting for one. */
	enqueue(chunk = undefined) {
		if (!canCloseOrEnqueue(this._stream))
			throw new TypeError('ReadableStream: cannot enqueue into a closed stream');
		enqueue(this._stream, chunk);
	}

	/** Closes the stream once the queued chunks are read. */
	close() {
		if (!canCloseOrEnqueue(this._stream)) throw new TypeError('ReadableStream: already closed');
		requestClose(this._stream);
	}

	/** Errors the stream: the queue is dropped, reads reject with `reason`. */
	error(reason = undefined) {
		error(this._stream, reason);
	}
}

/** Whether the source may still enqueue or close (ReadableStreamDefaultControllerCanCloseOrEnqueue). */
export function canCloseOrEnqueue(stream) {
	return !stream._closeRequested && stream._state === 'readable';
}

/** The high-water mark less what the queue holds; null once errored, 0 once closed. */
export function desiredSize(stream) {
	if (stream._state === 'errored') return null;

	return stream._state === 'closed' ? 0 : stream._hwm - stream._queueTotal;
}

/**
 * An underlying source converted as WebIDL converts the UnderlyingSource dictionary (its
 * members read once, in order): { source, start, pull, cancel, type, autoAllocateChunkSize }.
 */
export function sourceAlgorithms(underlyingSource) {
	const source = underlyingSource ?? {};
	const autoAllocate = source.autoAllocateChunkSize;
	const cancel = callback(source, 'cancel', 'ReadableStream');
	const pull = callback(source, 'pull', 'ReadableStream');
	const start = callback(source, 'start', 'ReadableStream');
	const rawType = source.type;
	const type = rawType === undefined ? undefined : String(rawType);

	if (type !== undefined && type !== 'bytes')
		throw new TypeError('ReadableStream: the type must be bytes or undefined');

	return {
		source,
		start:
			start === undefined ? undefined : (controller) => Reflect.apply(start, source, [controller]),
		pull: (controller) => promiseCall(pull, source, [controller]),
		cancel: (reason) => promiseCall(cancel, source, [reason]),
		type,
		// [EnforceRange] unsigned long long
		autoAllocateChunkSize: autoAllocate === undefined ? undefined : enforceRange(autoAllocate)
	};
}

/** WebIDL's [EnforceRange] unsigned long long: a TypeError for NaN, ±Infinity or out of range. */
export function enforceRange(value) {
	const number = +value;

	if (number !== number || number === Infinity || number === -Infinity)
		throw new TypeError('The value is not a finite number');
	const out = Math.trunc(number);

	if (out < 0 || out > Number.MAX_SAFE_INTEGER) throw new TypeError('The value is out of range');

	return out === 0 ? 0 : out;
}

/**
 * The fields every readable stream has, default or byte; its controller comes after.
 * `algorithms` is what sourceAlgorithms gives (or a TransformStream's own).
 */
export function initialize(stream, algorithms, highWaterMark) {
	stream._startAlgorithm = algorithms.start;
	stream._pull = algorithms.pull;
	stream._cancel = algorithms.cancel;
	stream._hwm = highWaterMark;
	stream._queue = [];
	// the sum of the queued chunks' sizes (a default stream without a size function: how many)
	stream._queueTotal = 0;
	stream._reads = [];
	stream._state = 'readable';
	stream._storedError = undefined;
	stream._closeRequested = false;
	stream._started = false;
	stream._pulling = false;
	stream._pullAgain = false;
	stream._disturbed = false;
	stream._reader = undefined;
}

/**
 * Runs the source's start with the controller, then pulls if the queue wants chunks. A throw
 * from start leaves here (the constructor throws it).
 */
export function start(stream) {
	const begin = stream._startAlgorithm;

	stream._startAlgorithm = undefined;
	const started = begin === undefined ? undefined : begin(stream._controller);

	react(
		resolvedWith(started),
		() => {
			stream._started = true;
			pullIfNeeded(stream);
		},
		(reason) => error(stream, reason)
	);
}

/**
 * Sets up a default stream's fields and starts its source. With `size` (a strategy's size
 * function) the queue counts what it returns for each chunk; without, one per chunk.
 */
export function setUp(stream, algorithms, highWaterMark, size) {
	initialize(stream, algorithms, highWaterMark);
	stream._size = size;
	// each queued chunk's size, beside the queue; only kept when a size function gives them
	stream._sizes = size === undefined ? undefined : [];
	const controller = new ReadableStreamDefaultController(internal);

	controller._stream = stream;
	stream._controller = controller;
	start(stream);
}

/** Drops the source's algorithms: nothing calls it again (ReadableStreamDefaultControllerClearAlgorithms). */
export function clearAlgorithms(stream) {
	stream._pull = undefined;
	stream._cancel = undefined;
	stream._size = undefined;
}

/** ReadableStreamDefaultControllerShouldCallPull: whether the source should be asked for more. */
export function shouldPull(stream) {
	if (!canCloseOrEnqueue(stream) || !stream._started) return false;

	if (stream._reader !== undefined && stream._reads.length > 0) return true;

	return desiredSize(stream) > 0;
}

/** Asks the source for more when something wants it; once at a time. */
export function pullIfNeeded(stream) {
	if (!shouldPull(stream)) return;

	if (stream._pulling) {
		stream._pullAgain = true;

		return;
	}
	stream._pulling = true;
	react(
		stream._pull(stream._controller),
		() => {
			stream._pulling = false;

			if (stream._pullAgain) {
				stream._pullAgain = false;
				pullIfNeeded(stream);
			}
		},
		(reason) => error(stream, reason)
	);
}

/** ReadableStreamDefaultControllerEnqueue: to a waiting read, or the queue. */
export function enqueue(stream, chunk) {
	if (stream._reader !== undefined && stream._reads.length > 0)
		stream._reads.shift().resolve({ value: chunk, done: false });
	else if (stream._size === undefined) {
		stream._queue.push(chunk);
		stream._queueTotal++;
	} else {
		let size;

		// a size function that throws, or gives no usable size, errors the stream too
		try {
			size = chunkSize(stream._size, chunk);
		} catch (reason) {
			error(stream, reason);

			throw reason;
		}
		stream._queue.push(chunk);
		stream._sizes.push(size);
		stream._queueTotal += size;
	}
	pullIfNeeded(stream);
}

/** Closed for good (ReadableStreamClose): the reader's closed resolves, waiting reads end. */
export function finishClose(stream) {
	stream._state = 'closed';
	const reader = stream._reader;

	if (reader === undefined) return;
	reader._closed.resolve();
	const reads = stream._reads;

	stream._reads = [];

	for (const read of reads) read.resolve({ value: undefined, done: true });
}

/** ReadableStreamDefaultControllerClose: closes now, or once the queue is read. */
export function requestClose(stream) {
	stream._closeRequested = true;

	if (stream._queue.length === 0) {
		clearAlgorithms(stream);
		finishClose(stream);
	}
}

/** Empties the queue (and a byte stream's pending BYOB fills). */
function resetQueue(stream) {
	stream._queue = [];
	stream._queueTotal = 0;

	if (stream._sizes !== undefined) stream._sizes = [];

	if (stream._bytes !== undefined) stream._bytes.reset(stream);
}

/** Errored for good: the queue is dropped, the reader's closed and waiting reads reject. */
export function error(stream, reason) {
	if (stream._state !== 'readable') return;
	resetQueue(stream);
	clearAlgorithms(stream);
	stream._state = 'errored';
	stream._storedError = reason;
	const reader = stream._reader;

	if (reader === undefined) return;
	reader._closed.reject(reason);
	const reads = stream._reads;

	stream._reads = [];

	for (const read of reads) read.reject(reason);
}

/**
 * ReadableStreamDefaultReaderRead: `request` gets the next chunk, { done: true } once
 * closed, or the stored error; now, or when the source enqueues.
 */
export function readRequest(stream, request) {
	stream._disturbed = true;

	if (stream._state === 'closed') request.resolve({ value: undefined, done: true });
	else if (stream._state === 'errored') request.reject(stream._storedError);
	else if (stream._bytes !== undefined) stream._bytes.read(stream, request);
	else if (stream._queue.length > 0) {
		const value = stream._queue.shift();

		stream._queueTotal -= stream._sizes === undefined ? 1 : stream._sizes.shift();

		// rounding can take a sum of fractional sizes below zero
		if (stream._queueTotal < 0) stream._queueTotal = 0;

		if (stream._closeRequested && stream._queue.length === 0) {
			clearAlgorithms(stream);
			finishClose(stream);
		} else pullIfNeeded(stream);
		request.resolve({ value, done: false });
	} else {
		stream._reads.push(request);
		pullIfNeeded(stream);
	}
}

/** A read: the next chunk, { done: true } once closed, or the stored error. */
export function read(stream) {
	const request = deferred();

	readRequest(stream, request);

	return request.promise;
}

/** Cancels (ReadableStreamCancel): the stream closes, the queue is dropped, the source hears why. */
export function cancel(stream, reason) {
	stream._disturbed = true;

	if (stream._state === 'closed') return Promise.resolve();

	if (stream._state === 'errored') return Promise.reject(stream._storedError);
	// a BYOB reader's reads end too, with nothing read
	finishClose(stream);
	resetQueue(stream);
	const cancelled = stream._cancel(reason);

	clearAlgorithms(stream);

	return react(cancelled, ignore);
}

/** Lets go of the stream: the reader's closed and waiting reads reject, another reader may take it. */
export function release(reader) {
	const stream = reader._stream;

	if (stream === undefined) return;
	const released = new TypeError('ReadableStreamDefaultReader: the reader was released');

	if (stream._state === 'readable') reader._closed.reject(released);
	else {
		reader._closed = deferred();
		react(reader._closed.promise, ignore, ignore);
		reader._closed.reject(released);
	}

	if (stream._bytes !== undefined) stream._bytes.release(stream);
	stream._reader = undefined;
	reader._stream = undefined;
	const reads = stream._reads;

	stream._reads = [];

	for (const waiting of reads) waiting.reject(released);
}

/** SetUpReadableStreamDefaultReader: locks `stream` to `reader`. */
export function setUpReader(reader, stream) {
	if (stream === null || typeof stream !== 'object' || stream._reads === undefined)
		throw new TypeError('ReadableStreamDefaultReader: not a ReadableStream');

	if (stream._reader !== undefined)
		throw new TypeError('ReadableStreamDefaultReader: the stream is locked to another reader');
	reader._stream = stream;
	reader._closed = deferred();
	// a closed nobody awaits must not count as an unhandled rejection
	react(reader._closed.promise, ignore, ignore);
	stream._reader = reader;

	if (stream._state === 'closed') reader._closed.resolve();
	else if (stream._state === 'errored') reader._closed.reject(stream._storedError);
}
