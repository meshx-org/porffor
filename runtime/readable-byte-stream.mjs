// Byte streams for a Porffor-compiled guest: `new ReadableStream({ type: 'bytes' })`, its
// ReadableByteStreamController, BYOB requests and ReadableStreamBYOBReader (the Streams
// standard's readable byte stream algorithms, in plain JS). A byte stream shares the default
// stream's fields and functions (./stream-internals.mjs) and adds its own here: queued chunks
// are { buffer, byteOffset, byteLength } counted in bytes, and a read into a buffer (a BYOB
// read, or a default read with autoAllocateChunkSize) is a pull-into the source fills through
// controller.byobRequest. A BYOB reader's reads wait in the stream's _reads, as a default
// reader's do (one reader at a time), so erroring, cancelling and releasing end both alike.
//
// Its own globals (runtime/globals.json): loaded only when a program names one of its classes,
// and it plugs itself into ReadableStream then (byteStreams), so a program with only default
// streams carries none of it. Buffers are transferred as the standard has it: an enqueued
// chunk's, and a BYOB read's view's, are detached, and the read gives a view of a new one.
// Not here: tee() of a byte stream gives default streams (sharing chunks, not copies).

import { createReadable } from './readable-stream.mjs';
import { ReadableStreamDefaultReader } from './readable-stream-reader.mjs';
import {
	byteStreams,
	canCloseOrEnqueue,
	cancel,
	readRequest,
	deferred,
	desiredSize,
	error,
	finishClose,
	initialize,
	pullIfNeeded,
	release,
	start
} from './stream-internals.mjs';
import { react } from './stream-queue.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** Proves a controller or request is built here, not by a program (whose `new` must throw). */
const internal = {};

/** Takes `buffer`'s contents into a new ArrayBuffer and detaches it, as the standard transfers. */
const transfer = (buffer) => buffer.transfer();

/** Copies `length` bytes between two ArrayBuffers. */
function copyBytes(to, toOffset, from, fromOffset, length) {
	new Uint8Array(to, toOffset, length).set(new Uint8Array(from, fromOffset, length));
}

/** Whether a BYOB reader (not a default one) holds the stream. */
const hasBYOBReader = (stream) => stream._reader instanceof ReadableStreamBYOBReader;

/** A view of what a pull-into has filled, as the type the read asked for. */
function filledView(pullInto) {
	return new pullInto.viewConstructor(
		pullInto.buffer,
		pullInto.byteOffset,
		pullInto.bytesFilled / pullInto.elementSize
	);
}

/** The current BYOB request goes stale: respond() on it throws from here on. */
function invalidateRequest(stream) {
	if (stream._byobRequest === null) return;
	stream._byobRequest._stream = undefined;
	stream._byobRequest._view = null;
	stream._byobRequest = null;
}

function enqueueChunk(stream, buffer, byteOffset, byteLength) {
	stream._queue.push({ buffer, byteOffset, byteLength });
	stream._queueTotal += byteLength;
}

/** Queues a copy of part of `buffer` (what a pull-into filled that no read took). */
function enqueueClonedChunk(stream, buffer, byteOffset, byteLength) {
	let clone;

	try {
		clone = buffer.slice(byteOffset, byteOffset + byteLength);
	} catch (reason) {
		error(stream, reason);

		throw reason;
	}
	enqueueChunk(stream, clone, 0, byteLength);
}

/** A pull-into whose reader let go: what it filled goes to the queue for the next reader. */
function enqueueDetachedPullInto(stream, pullInto) {
	if (pullInto.bytesFilled > 0)
		enqueueClonedChunk(stream, pullInto.buffer, pullInto.byteOffset, pullInto.bytesFilled);
	shiftPullInto(stream);
}

function shiftPullInto(stream) {
	return stream._pullIntos.shift();
}

/** The queue ran dry: a requested close happens now; otherwise the source may be pulled. */
function handleQueueDrain(stream) {
	if (stream._queueTotal === 0 && stream._closeRequested) finishClose(stream);
	else pullIfNeeded(stream);
}

/**
 * Fills a pull-into from the queue, as far as the queue goes: true when it has at least its
 * minimum (whole elements), so its read can be answered.
 */
function fillPullIntoFromQueue(stream, pullInto) {
	const maxBytesToCopy = Math.min(stream._queueTotal, pullInto.byteLength - pullInto.bytesFilled);
	const maxBytesFilled = pullInto.bytesFilled + maxBytesToCopy;
	const maxAlignedBytes = maxBytesFilled - (maxBytesFilled % pullInto.elementSize);
	let remaining = maxBytesToCopy;
	let ready = false;

	if (maxAlignedBytes >= pullInto.minimumFill) {
		remaining = maxAlignedBytes - pullInto.bytesFilled;
		ready = true;
	}

	while (remaining > 0) {
		const head = stream._queue[0];
		const bytesToCopy = Math.min(remaining, head.byteLength);

		copyBytes(
			pullInto.buffer,
			pullInto.byteOffset + pullInto.bytesFilled,
			head.buffer,
			head.byteOffset,
			bytesToCopy
		);

		if (head.byteLength === bytesToCopy) stream._queue.shift();
		else {
			head.byteOffset += bytesToCopy;
			head.byteLength -= bytesToCopy;
		}
		stream._queueTotal -= bytesToCopy;
		pullInto.bytesFilled += bytesToCopy;
		remaining -= bytesToCopy;
	}

	return ready;
}

/** Answers a pull-into's read: a default read or a BYOB one, done once the stream closed. */
function commitPullInto(stream, pullInto) {
	const done = stream._state === 'closed';
	const view = filledView(pullInto);

	// a default read that ends gets no value; a BYOB read gets its buffer back, even empty
	stream._reads
		.shift()
		.resolve({ value: done && pullInto.readerType === 'default' ? undefined : view, done });
}

/** Fills the pending pull-intos from the queue, then answers each that filled, in order. */
function processPullIntos(stream) {
	const filled = [];

	while (stream._pullIntos.length > 0 && stream._queueTotal > 0) {
		const pullInto = stream._pullIntos[0];

		if (!fillPullIntoFromQueue(stream, pullInto)) break;
		shiftPullInto(stream);
		filled.push(pullInto);
	}

	// answered once all are taken off: a read's then() sees no pending request
	for (const pullInto of filled) commitPullInto(stream, pullInto);
}

/** Answers default reads from the queue, one chunk each, while both last. */
function processReadsFromQueue(stream) {
	while (stream._reads.length > 0 && stream._queueTotal > 0) {
		const entry = stream._queue.shift();

		stream._queueTotal -= entry.byteLength;
		handleQueueDrain(stream);
		stream._reads.shift().resolve({
			value: new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength),
			done: false
		});
	}
}

function enqueue(stream, chunk) {
	if (!ArrayBuffer.isView(chunk))
		throw new TypeError(
			'ReadableByteStreamController.enqueue: the chunk must be an ArrayBufferView'
		);

	if (chunk.byteLength === 0 || chunk.buffer.byteLength === 0)
		throw new TypeError('ReadableByteStreamController.enqueue: the chunk is empty');

	if (stream._closeRequested || stream._state !== 'readable')
		throw new TypeError('ReadableByteStreamController.enqueue: the stream is closed');
	const byteOffset = chunk.byteOffset;
	const byteLength = chunk.byteLength;
	const buffer = transfer(chunk.buffer);

	if (stream._pullIntos.length > 0) {
		const first = stream._pullIntos[0];

		if (first.buffer.detached)
			throw new TypeError('ReadableByteStreamController.enqueue: the read buffer is detached');
		invalidateRequest(stream);
		// the waiting read's buffer moves on: a view of it the source kept is detached
		first.buffer = transfer(first.buffer);

		if (first.readerType === 'none') enqueueDetachedPullInto(stream, first);
	}

	if (stream._reader !== undefined && !hasBYOBReader(stream)) {
		processReadsFromQueue(stream);

		if (stream._reads.length === 0) enqueueChunk(stream, buffer, byteOffset, byteLength);
		else {
			// an autoAllocate read waiting on the source: the chunk answers it, not the buffer
			if (stream._pullIntos.length > 0) shiftPullInto(stream);
			stream._reads
				.shift()
				.resolve({ value: new Uint8Array(buffer, byteOffset, byteLength), done: false });
		}
	} else if (hasBYOBReader(stream)) {
		enqueueChunk(stream, buffer, byteOffset, byteLength);
		processPullIntos(stream);
	} else enqueueChunk(stream, buffer, byteOffset, byteLength);
	pullIfNeeded(stream);
}

function close(stream) {
	if (stream._closeRequested || stream._state !== 'readable')
		throw new TypeError('ReadableByteStreamController.close: the stream is closed');

	if (stream._queueTotal > 0) {
		stream._closeRequested = true;

		return;
	}

	if (stream._pullIntos.length > 0) {
		const first = stream._pullIntos[0];

		// a BYOB read of multi-byte elements cannot end on part of one
		if (first.bytesFilled % first.elementSize !== 0) {
			const reason = new TypeError(
				'ReadableByteStreamController.close: a read is left with a partial element'
			);

			error(stream, reason);

			throw reason;
		}
	}
	stream._closeRequested = true;

	// the stream closes, but a BYOB read still pending (a BYOB reader's reads share _reads)
	// ends only at byobRequest.respond(0), with the buffer it brought
	if (hasBYOBReader(stream)) {
		const readIntos = stream._reads;

		stream._reads = [];
		finishClose(stream);
		stream._reads = readIntos;
	} else finishClose(stream);
}

/** respond() and respondWithNewView(): `bytesWritten` of the first pull-into were filled. */
function respond(stream, bytesWritten) {
	const first = stream._pullIntos[0];

	if (stream._state === 'closed') {
		if (bytesWritten !== 0)
			throw new TypeError('ReadableStreamBYOBRequest.respond: the stream is closed, respond(0)');
	} else {
		if (bytesWritten === 0)
			throw new TypeError('ReadableStreamBYOBRequest.respond: nothing was written');

		if (first.bytesFilled + bytesWritten > first.byteLength)
			throw new RangeError('ReadableStreamBYOBRequest.respond: more than the view holds');
	}
	first.buffer = transfer(first.buffer);
	invalidateRequest(stream);

	if (stream._state === 'closed') {
		if (first.readerType === 'none') shiftPullInto(stream);

		if (hasBYOBReader(stream))
			while (stream._reads.length > 0) commitPullInto(stream, shiftPullInto(stream));
	} else respondReadable(stream, bytesWritten, first);
	pullIfNeeded(stream);
}

function respondReadable(stream, bytesWritten, pullInto) {
	pullInto.bytesFilled += bytesWritten;

	if (pullInto.readerType === 'none') {
		enqueueDetachedPullInto(stream, pullInto);
		processPullIntos(stream);

		return;
	}

	if (pullInto.bytesFilled < pullInto.minimumFill) return;
	shiftPullInto(stream);
	// part of an element left over goes back to the queue for the next read
	const remainder = pullInto.bytesFilled % pullInto.elementSize;

	if (remainder > 0) {
		const end = pullInto.byteOffset + pullInto.bytesFilled;

		enqueueClonedChunk(stream, pullInto.buffer, end - remainder, remainder);
	}
	pullInto.bytesFilled -= remainder;
	commitPullInto(stream, pullInto);
	processPullIntos(stream);
}

/**
 * A default read of a byte stream: `request` (a read request: resolve, reject) gets a queued
 * chunk, or waits (with a buffer to fill, auto-allocated).
 */
function pullSteps(stream, request) {
	if (stream._queueTotal > 0) {
		const entry = stream._queue.shift();

		stream._queueTotal -= entry.byteLength;
		handleQueueDrain(stream);

		request.resolve({
			value: new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength),
			done: false
		});

		return;
	}
	const size = stream._autoAllocate;

	if (size !== undefined) {
		let buffer;

		try {
			buffer = new ArrayBuffer(size);
		} catch (reason) {
			request.reject(reason);

			return;
		}
		stream._pullIntos.push({
			buffer,
			bufferByteLength: size,
			byteOffset: 0,
			byteLength: size,
			bytesFilled: 0,
			minimumFill: 1,
			elementSize: 1,
			viewConstructor: Uint8Array,
			readerType: 'default'
		});
	}
	stream._reads.push(request);
	pullIfNeeded(stream);
}

/**
 * A BYOB read: `request` (resolve, reject) gets `view` filled (at least `min` elements) from
 * the queue, or once the source has.
 */
function pullInto(stream, view, min, request) {
	const elementSize = view instanceof DataView ? 1 : view.BYTES_PER_ELEMENT;
	const pullIntoEntry = {
		buffer: undefined,
		bufferByteLength: 0,
		byteOffset: view.byteOffset,
		byteLength: view.byteLength,
		bytesFilled: 0,
		minimumFill: min * elementSize,
		elementSize,
		viewConstructor: view.constructor,
		readerType: 'byob'
	};

	try {
		pullIntoEntry.buffer = transfer(view.buffer);
	} catch (reason) {
		request.reject(reason);

		return;
	}
	pullIntoEntry.bufferByteLength = pullIntoEntry.buffer.byteLength;
	if (stream._pullIntos.length > 0) {
		stream._pullIntos.push(pullIntoEntry);
		stream._reads.push(request);

		return;
	}

	if (stream._state === 'closed') {
		request.resolve({
			value: new pullIntoEntry.viewConstructor(pullIntoEntry.buffer, pullIntoEntry.byteOffset, 0),
			done: true
		});

		return;
	}

	if (stream._queueTotal > 0) {
		if (fillPullIntoFromQueue(stream, pullIntoEntry)) {
			const value = filledView(pullIntoEntry);

			handleQueueDrain(stream);
			request.resolve({ value, done: false });

			return;
		}

		if (stream._closeRequested) {
			const reason = new TypeError(
				'ReadableStreamBYOBReader.read: the stream closed on part of an element'
			);

			error(stream, reason);
			request.reject(reason);

			return;
		}
	}
	stream._pullIntos.push(pullIntoEntry);
	stream._reads.push(request);
	pullIfNeeded(stream);
}

/** What ./stream-internals.mjs calls on a byte stream (the standard's controller steps). */
const steps = {
	read: pullSteps,
	/** Errored or cancelled: pending pull-intos are dropped. */
	reset(stream) {
		invalidateRequest(stream);
		stream._pullIntos = [];
	},
	/** The reader let go: a pull-into the source is filling stays, for the queue to get. */
	release(stream) {
		if (stream._pullIntos.length === 0) return;
		const first = stream._pullIntos[0];

		first.readerType = 'none';
		stream._pullIntos = [first];
	}
};

/**
 * Sets up a byte stream's fields and starts its source (ReadableStream's `type: 'bytes'`):
 * `algorithms` is the converted source (sourceAlgorithms).
 */
function setUpByteStream(stream, algorithms, highWaterMark) {
	const autoAllocate = algorithms.autoAllocateChunkSize;

	if (autoAllocate === 0)
		throw new TypeError('ReadableStream: autoAllocateChunkSize must be positive');
	initialize(stream, algorithms, highWaterMark);
	stream._bytes = steps;
	stream._pullIntos = [];
	stream._autoAllocate = autoAllocate;
	stream._byobRequest = null;
	const controller = new ReadableByteStreamController(internal);

	controller._stream = stream;
	stream._controller = controller;
	start(stream);
}

/** The controller a byte stream's source is handed: it feeds the stream bytes. */
export class ReadableByteStreamController {
	constructor(token = undefined) {
		if (token !== internal) throw new TypeError('Illegal constructor');
	}

	/**
	 * The read waiting for bytes, as a view to fill: null when none is (a BYOB read, or a
	 * default read with autoAllocateChunkSize, makes one).
	 */
	get byobRequest() {
		const stream = this._stream;

		if (stream._byobRequest === null && stream._pullIntos.length > 0) {
			const first = stream._pullIntos[0];
			const request = new ReadableStreamBYOBRequest(internal);

			request._stream = stream;
			request._view = new Uint8Array(
				first.buffer,
				first.byteOffset + first.bytesFilled,
				first.byteLength - first.bytesFilled
			);
			stream._byobRequest = request;
		}

		return stream._byobRequest;
	}

	/** How many bytes the queue wants before it is full; null once errored, 0 once closed. */
	get desiredSize() {
		return desiredSize(this._stream);
	}

	/** Queues a chunk (an ArrayBufferView, whose buffer is transferred), or answers a read. */
	enqueue(chunk) {
		enqueue(this._stream, chunk);
	}

	/** Closes the stream once the queued bytes are read. */
	close() {
		close(this._stream);
	}

	/** Errors the stream: the queue is dropped, reads reject with `reason`. */
	error(reason = undefined) {
		error(this._stream, reason);
	}
}

/** A read waiting on a byte stream's source, as a view for the source to write into. */
export class ReadableStreamBYOBRequest {
	constructor(token = undefined) {
		if (token !== internal) throw new TypeError('Illegal constructor');
	}

	/** Where to write the bytes; null once answered. */
	get view() {
		return this._view;
	}

	/** Says `bytesWritten` bytes were written into view (0 after the stream closed). */
	respond(bytesWritten) {
		if (this._stream === undefined)
			throw new TypeError('ReadableStreamBYOBRequest.respond: the request was already answered');
		// unary +, not Number(): Porffor's Number(undefined) is 0, not NaN
		const written = +bytesWritten;

		if (!(written >= 0) || written !== Math.floor(written))
			throw new TypeError('ReadableStreamBYOBRequest.respond: bytesWritten must be a whole number');

		respond(this._stream, written);
	}

	/** Answers with `view`: the same buffer (transferred or not) and offset, filled to its length. */
	respondWithNewView(view) {
		const stream = this._stream;

		if (stream === undefined)
			throw new TypeError(
				'ReadableStreamBYOBRequest.respondWithNewView: the request was already answered'
			);

		if (!ArrayBuffer.isView(view))
			throw new TypeError('ReadableStreamBYOBRequest.respondWithNewView: not an ArrayBufferView');

		if (view.buffer.detached)
			throw new TypeError('ReadableStreamBYOBRequest.respondWithNewView: the view is detached');
		const first = stream._pullIntos[0];

		if (stream._state === 'closed' ? view.byteLength !== 0 : view.byteLength === 0)
			throw new TypeError(
				'ReadableStreamBYOBRequest.respondWithNewView: the view has the wrong length'
			);

		if (first.byteOffset + first.bytesFilled !== view.byteOffset)
			throw new RangeError(
				'ReadableStreamBYOBRequest.respondWithNewView: the view has the wrong offset'
			);

		if (first.bufferByteLength !== view.buffer.byteLength)
			throw new RangeError(
				'ReadableStreamBYOBRequest.respondWithNewView: the view has the wrong buffer'
			);

		if (first.bytesFilled + view.byteLength > first.byteLength)
			throw new RangeError('ReadableStreamBYOBRequest.respondWithNewView: the view is too long');
		first.buffer = view.buffer;
		respond(stream, view.byteLength);
	}
}

const released = () => new TypeError('ReadableStreamBYOBReader: the reader was released');

/** Reads a byte stream it has locked into buffers the caller brings. */
export class ReadableStreamBYOBReader {
	/** @param {ReadableStream} stream a byte stream (type: 'bytes') */
	constructor(stream) {
		if (stream?._bytes === undefined)
			throw new TypeError('ReadableStreamBYOBReader: the stream is not a byte stream');

		if (stream._reader !== undefined)
			throw new TypeError('ReadableStreamBYOBReader: the stream is locked to another reader');
		this._stream = stream;
		this._closed = deferred();
		// a closed nobody awaits must not count as an unhandled rejection
		react(this._closed.promise, ignore, ignore);
		stream._reader = this;

		if (stream._state === 'closed') this._closed.resolve();
		else if (stream._state === 'errored') this._closed.reject(stream._storedError);
	}

	/** Resolves when the stream closes; rejects when it errors or the reader is released. */
	get closed() {
		return this._closed.promise;
	}

	/**
	 * Reads into `view` (its buffer is transferred): { value, done } where value is a view of
	 * the same type over the filled part, at least `min` elements (1) unless the stream ended.
	 * @param {ArrayBufferView} view
	 * @param {{ min?: number }} [options]
	 */
	read(view, options = undefined) {
		if (!ArrayBuffer.isView(view))
			return Promise.reject(new TypeError('ReadableStreamBYOBReader.read: not an ArrayBufferView'));

		if (view.byteLength === 0 || view.buffer.byteLength === 0)
			return Promise.reject(new TypeError('ReadableStreamBYOBReader.read: the view is empty'));
		const min = options?.min === undefined ? 1 : Number(options.min);

		if (!(min > 0) || min !== Math.floor(min))
			return Promise.reject(
				new TypeError('ReadableStreamBYOBReader.read: min must be a positive whole number')
			);

		if (min > (view instanceof DataView ? view.byteLength : view.length))
			return Promise.reject(
				new RangeError('ReadableStreamBYOBReader.read: min is more than the view holds')
			);

		if (this._stream === undefined) return Promise.reject(released());
		const stream = this._stream;

		stream._disturbed = true;

		if (stream._state === 'errored') return Promise.reject(stream._storedError);
		const request = deferred();

		pullInto(stream, view, min, request);

		return request.promise;
	}

	/** Cancels the stream, telling its source why. */
	cancel(reason = undefined) {
		if (this._stream === undefined) return Promise.reject(released());

		return cancel(this._stream, reason);
	}

	/** Unlocks the stream; reads still waiting reject. */
	releaseLock() {
		release(this);
	}
}

/** CloneAsUint8Array: a copy of what `view` shows, in a buffer of its own. */
const cloneBytes = (view) =>
	new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));

/**
 * ReadableByteStreamTee (https://streams.spec.whatwg.org/#abstract-opdef-readablebytestreamtee):
 * two byte streams that each see every byte, a copy each. A branch with a BYOB read waiting
 * reads the source with a BYOB reader into its own buffer; otherwise the source is read with a
 * default reader. Cancelling both branches cancels the source with both reasons.
 * @param {ReadableStream} stream a byte stream
 */
function byteTee(stream) {
	let reader = new ReadableStreamDefaultReader(stream);
	let reading = false;
	const readAgain = [false, false];
	const canceled = [false, false];
	const reasons = [undefined, undefined];
	const cancelled = deferred();
	const branches = [];
	const open = (index) => !canceled[index] && canCloseOrEnqueue(branches[index]);
	const cancelSource = (reason) => {
		error(branches[0], reason);
		error(branches[1], reason);
		cancelled.resolve(cancel(stream, reason));
	};
	const forwardReaderError = (thisReader) => {
		react(thisReader._closed.promise, undefined, (reason) => {
			if (thisReader !== reader) return;
			error(branches[0], reason);
			error(branches[1], reason);

			if (!canceled[0] || !canceled[1]) cancelled.resolve();
		});
	};
	const readAgainAfter = () => {
		reading = false;

		if (readAgain[0]) pullBranch(0);
		else if (readAgain[1]) pullBranch(1);
	};
	const pullWithDefaultReader = () => {
		if (reader instanceof ReadableStreamBYOBReader) {
			release(reader);
			reader = new ReadableStreamDefaultReader(stream);
			forwardReaderError(reader);
		}
		readRequest(stream, {
			resolve({ value, done }) {
				if (done) {
					reading = false;

					for (let index = 0; index < 2; index++) if (open(index)) close(branches[index]);

					for (let index = 0; index < 2; index++)
						if (branches[index]._pullIntos.length > 0) respond(branches[index], 0);

					if (!canceled[0] || !canceled[1]) cancelled.resolve();

					return;
				}
				react(Promise.resolve(), () => {
					readAgain[0] = false;
					readAgain[1] = false;
					let second = value;

					if (!canceled[0] && !canceled[1])
						try {
							second = cloneBytes(value);
						} catch (reason) {
							cancelSource(reason);

							return;
						}

					if (open(0)) enqueue(branches[0], value);

					if (open(1)) enqueue(branches[1], second);
					readAgainAfter();
				});
			},
			reject() {
				reading = false;
			}
		});
	};
	const pullWithBYOBReader = (view, index) => {
		if (reader instanceof ReadableStreamDefaultReader) {
			release(reader);
			reader = new ReadableStreamBYOBReader(stream);
			forwardReaderError(reader);
		}
		const byob = branches[index];
		const other = branches[1 - index];
		const request = {
			resolve({ value, done }) {
				if (done) {
					reading = false;
					const byobOpen = !canceled[index];
					const otherOpen = !canceled[1 - index];

					if (byobOpen && canCloseOrEnqueue(byob)) close(byob);

					if (otherOpen && canCloseOrEnqueue(other)) close(other);

					if (value !== undefined) {
						if (byobOpen) byob._controller.byobRequest.respondWithNewView(value);

						if (otherOpen && other._pullIntos.length > 0) respond(other, 0);
					}

					if (byobOpen || otherOpen) cancelled.resolve();

					return;
				}
				react(Promise.resolve(), () => {
					readAgain[0] = false;
					readAgain[1] = false;

					if (!canceled[1 - index]) {
						let copy;

						try {
							copy = cloneBytes(value);
						} catch (reason) {
							cancelSource(reason);

							return;
						}

						if (!canceled[index]) byob._controller.byobRequest.respondWithNewView(value);

						if (canCloseOrEnqueue(other)) enqueue(other, copy);
					} else if (!canceled[index]) byob._controller.byobRequest.respondWithNewView(value);
					readAgainAfter();
				});
			},
			reject() {
				reading = false;
			}
		};

		stream._disturbed = true;

		if (stream._state === 'errored') request.reject(stream._storedError);
		else pullInto(stream, view, 1, request);
	};
	const pullBranch = (index) => {
		if (reading) {
			readAgain[index] = true;

			return Promise.resolve();
		}
		reading = true;
		const request = branches[index]._controller.byobRequest;

		if (request === null) pullWithDefaultReader();
		else pullWithBYOBReader(request.view, index);

		return Promise.resolve();
	};
	const branch = (index) =>
		createReadable(
			{
				source: undefined,
				start: undefined,
				pull: () => pullBranch(index),
				cancel(reason) {
					canceled[index] = true;
					reasons[index] = reason;

					if (canceled[1 - index]) cancelled.resolve(cancel(stream, [...reasons]));

					return cancelled.promise;
				}
			},
			0,
			undefined,
			true
		);

	branches.push(branch(0), branch(1));
	forwardReaderError(reader);

	return branches;
}

// plugged into ReadableStream once this module is loaded (it is only when a program names it)
byteStreams.setUp = setUpByteStream;
byteStreams.reader = (stream) => new ReadableStreamBYOBReader(stream);
byteStreams.tee = byteTee;
