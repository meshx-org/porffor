// TransformStream for a Porffor-compiled guest: a writable side whose chunks a transformer
// turns into the readable side's, with backpressure between them, as the Streams standard's
// transform stream abstract operations have it (https://streams.spec.whatwg.org/#ts-abstract-ops):
// a write waits while the readable side wants nothing, and the transformer is handed a
// TransformStreamDefaultController. Both sides are real streams run by the algorithms here.

import { createReadable } from './readable-stream.mjs';
import {
	canCloseOrEnqueue,
	deferred,
	enqueue as enqueueReadable,
	error as errorReadable,
	requestClose,
	shouldPull
} from './stream-internals.mjs';
import {
	callback,
	extractStrategy,
	isOptionalObject,
	react,
	resolvedWith
} from './stream-queue.mjs';
import { errorIfNeeded } from './writable-internals.mjs';
import { createWritable } from './writable-stream.mjs';

/** Proves a controller is built here, not by a program (whose `new` must throw). */
const internal = {};

/** Calls a transformer's method with the transformer as `this`, as a promise. */
function promiseCall(method, transformer, args) {
	if (method === undefined) return Promise.resolve();

	try {
		return resolvedWith(Reflect.apply(method, transformer, args));
	} catch (reason) {
		return Promise.reject(reason);
	}
}

/** The controller a TransformStream's transformer is handed: it feeds the readable side. */
export class TransformStreamDefaultController {
	constructor(token = undefined) {
		if (token !== internal) throw new TypeError('Illegal constructor');
	}

	/** How much the readable side's queue wants before it is full. */
	get desiredSize() {
		const readable = this._stream._readable;

		if (readable._state === 'errored') return null;

		return readable._state === 'closed' ? 0 : readable._hwm - readable._queueTotal;
	}

	/** Queues a chunk on the readable side. */
	enqueue(chunk = undefined) {
		controllerEnqueue(this, chunk);
	}

	/** Errors both sides with `reason`. */
	error(reason = undefined) {
		transformError(this._stream, reason);
	}

	/** Closes the readable side and errors the writable side: nothing more comes through. */
	terminate() {
		const stream = this._stream;

		if (canCloseOrEnqueue(stream._readable)) requestClose(stream._readable);
		errorWritableAndUnblockWrite(stream, new TypeError('TransformStream: terminated'));
	}
}

function setBackpressure(stream, backpressure) {
	if (stream._backpressureChange !== undefined) stream._backpressureChange.resolve();
	stream._backpressureChange = deferred();
	stream._backpressure = backpressure;
}

function unblockWrite(stream) {
	if (stream._backpressure) setBackpressure(stream, false);
}

function clearAlgorithms(controller) {
	controller._transform = undefined;
	controller._flush = undefined;
	controller._cancel = undefined;
}

function errorWritableAndUnblockWrite(stream, reason) {
	clearAlgorithms(stream._controller);
	errorIfNeeded(stream._writable._controller, reason);
	unblockWrite(stream);
}

/** TransformStreamError: both sides error with `reason`. */
function transformError(stream, reason) {
	errorReadable(stream._readable, reason);
	errorWritableAndUnblockWrite(stream, reason);
}

function controllerEnqueue(controller, chunk) {
	const stream = controller._stream;
	const readable = stream._readable;

	if (!canCloseOrEnqueue(readable))
		throw new TypeError('TransformStream: the readable side is closed or errored');

	try {
		enqueueReadable(readable, chunk);
	} catch (reason) {
		errorWritableAndUnblockWrite(stream, reason);

		throw readable._storedError;
	}
	const backpressure = !shouldPull(readable);

	if (backpressure !== stream._backpressure) setBackpressure(stream, true);
}

function performTransform(controller, chunk) {
	return react(controller._transform(chunk), undefined, (reason) => {
		transformError(controller._stream, reason);

		throw reason;
	});
}

function sinkWrite(stream, chunk) {
	const controller = stream._controller;

	if (!stream._backpressure) return performTransform(controller, chunk);

	return react(stream._backpressureChange.promise, () => {
		const writable = stream._writable;

		if (writable._state === 'erroring') throw writable._storedError;

		return performTransform(controller, chunk);
	});
}

function sinkAbort(stream, reason) {
	const controller = stream._controller;

	if (controller._finish !== undefined) return controller._finish.promise;
	const readable = stream._readable;
	const finish = deferred();

	controller._finish = finish;
	const cancelled = controller._cancel(reason);

	clearAlgorithms(controller);
	react(
		cancelled,
		() => {
			if (readable._state === 'errored') finish.reject(readable._storedError);
			else {
				errorReadable(readable, reason);
				finish.resolve();
			}
		},
		(reason_) => {
			errorReadable(readable, reason_);
			finish.reject(reason_);
		}
	);

	return finish.promise;
}

function sinkClose(stream) {
	const controller = stream._controller;

	if (controller._finish !== undefined) return controller._finish.promise;
	const readable = stream._readable;
	const finish = deferred();

	controller._finish = finish;
	const flushed = controller._flush();

	clearAlgorithms(controller);
	react(
		flushed,
		() => {
			if (readable._state === 'errored') finish.reject(readable._storedError);
			else {
				if (canCloseOrEnqueue(readable)) requestClose(readable);
				finish.resolve();
			}
		},
		(reason) => {
			errorReadable(readable, reason);
			finish.reject(reason);
		}
	);

	return finish.promise;
}

function sourcePull(stream) {
	setBackpressure(stream, false);

	return stream._backpressureChange.promise;
}

function sourceCancel(stream, reason) {
	const controller = stream._controller;

	if (controller._finish !== undefined) return controller._finish.promise;
	const writable = stream._writable;
	const finish = deferred();

	controller._finish = finish;
	const cancelled = controller._cancel(reason);

	clearAlgorithms(controller);
	react(
		cancelled,
		() => {
			if (writable._state === 'errored') finish.reject(writable._storedError);
			else {
				errorIfNeeded(writable._controller, reason);
				unblockWrite(stream);
				finish.resolve();
			}
		},
		(reason_) => {
			errorIfNeeded(writable._controller, reason_);
			unblockWrite(stream);
			finish.reject(reason_);
		}
	);

	return finish.promise;
}

/** A pair of streams joined by a transformer: write in one side, read the other. */
export class TransformStream {
	/**
	 * @param {{ start?, transform?, flush?, cancel? }} [transformer] transform(chunk, controller)
	 *   enqueues what the chunk becomes (the chunk itself when there is no transform);
	 *   flush(controller) runs when the writable side closes, cancel(reason) when either
	 *   side is cancelled or aborted. controller is a TransformStreamDefaultController
	 * @param {{ highWaterMark?: number, size? }} [writableStrategy] (1 chunk)
	 * @param {{ highWaterMark?: number, size? }} [readableStrategy] (0 chunks)
	 */
	constructor(transformer = undefined, writableStrategy = undefined, readableStrategy = undefined) {
		if (!isOptionalObject(transformer))
			throw new TypeError('TransformStream: the transformer must be an object');
		// WebIDL converts the strategies before the constructor reads the transformer
		const writableQueue = extractStrategy(writableStrategy, 1, 'TransformStream');
		const readableQueue = extractStrategy(readableStrategy, 0, 'TransformStream');
		const shape = transformer ?? {};
		const cancel = callback(shape, 'cancel', 'TransformStream');
		const flush = callback(shape, 'flush', 'TransformStream');
		const readableType = shape.readableType;
		const start = callback(shape, 'start', 'TransformStream');
		const transform = callback(shape, 'transform', 'TransformStream');
		const writableType = shape.writableType;

		if (readableType !== undefined) throw new RangeError('TransformStream: invalid readableType');

		if (writableType !== undefined) throw new RangeError('TransformStream: invalid writableType');
		const started = deferred();
		const startAlgorithm = () => started.promise;

		this._writable = createWritable(
			startAlgorithm,
			(chunk) => sinkWrite(this, chunk),
			() => sinkClose(this),
			(reason) => sinkAbort(this, reason),
			writableQueue.hwm,
			writableQueue.size
		);
		this._readable = createReadable(
			{
				source: undefined,
				start: startAlgorithm,
				pull: () => sourcePull(this),
				cancel: (reason) => sourceCancel(this, reason)
			},
			readableQueue.hwm,
			readableQueue.size
		);
		this._backpressure = undefined;
		this._backpressureChange = undefined;
		setBackpressure(this, true);
		const controller = new TransformStreamDefaultController(internal);

		controller._stream = this;
		this._controller = controller;
		controller._finish = undefined;
		controller._transform =
			transform === undefined
				? (chunk) => {
						try {
							controllerEnqueue(controller, chunk);

							return Promise.resolve();
						} catch (reason) {
							return Promise.reject(reason);
						}
					}
				: (chunk) => promiseCall(transform, shape, [chunk, controller]);
		controller._flush = () => promiseCall(flush, shape, [controller]);
		controller._cancel = (reason) => promiseCall(cancel, shape, [reason]);
		started.resolve(start === undefined ? undefined : Reflect.apply(start, shape, [controller]));
	}

	/** The side chunks come out of. */
	get readable() {
		return this._readable;
	}

	/** The side chunks go into. */
	get writable() {
		return this._writable;
	}
}
