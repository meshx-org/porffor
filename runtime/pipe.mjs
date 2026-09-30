// pipeTo and pipeThrough for ReadableStream (ReadableStreamPipeTo,
// https://streams.spec.whatwg.org/#readable-stream-pipe-to): reads the source and writes the
// destination with backpressure (the next read waits for the writer's ready), then closes,
// aborts or cancels across as the standard says, with the preventClose / preventAbort /
// preventCancel options and an AbortSignal. Loaded with WritableStream (./writable-stream.mjs),
// which plugs it into ReadableStream: a program without a WritableStream has nothing to pipe to.

import { ReadableStreamDefaultReader } from './readable-stream-reader.mjs';
import { byteStreams, cancel, readRequest, release } from './stream-internals.mjs';
import { isDictionary, react } from './stream-queue.mjs';
import { WritableStreamDefaultWriter } from './writable-stream-writer.mjs';
import {
	abort,
	closeQueuedOrInFlight,
	releaseWriter,
	writerCloseWithErrorPropagation,
	writerWrite
} from './writable-internals.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** Whether `value` is a ReadableStream (one this runtime made). */
const isReadable = (value) =>
	value !== null && typeof value === 'object' && value._reads !== undefined;

/** Whether `value` is a WritableStream (one this runtime made). */
const isWritable = (value) =>
	value !== null && typeof value === 'object' && value._writeRequests !== undefined;

/**
 * The StreamPipeOptions dictionary, converted as WebIDL does (its members read once, in
 * order): a TypeError for options that are not an object, or a signal that is not an
 * AbortSignal.
 */
function pipeOptions(options) {
	if (!isDictionary(options)) throw new TypeError('pipeTo: the options must be an object');
	const dict = options ?? {};
	const preventAbort = Boolean(dict.preventAbort);
	const preventCancel = Boolean(dict.preventCancel);
	const preventClose = Boolean(dict.preventClose);
	const signal = dict.signal;

	if (
		signal !== undefined &&
		(signal === null ||
			typeof signal !== 'object' ||
			typeof signal.addEventListener !== 'function' ||
			!('aborted' in signal))
	)
		throw new TypeError('pipeTo: the signal must be an AbortSignal');

	return { preventAbort, preventCancel, preventClose, signal };
}

/**
 * ReadableStream's pipeTo (`through` false: resolves once everything is written and the
 * destination closed) and pipeThrough (`through` true: `target` is { writable, readable },
 * and its readable side is returned).
 */
function pipeMethod(source, target, options, through) {
	if (!through) {
		if (!isReadable(source))
			return Promise.reject(new TypeError('ReadableStream.pipeTo: not a ReadableStream'));

		if (!isWritable(target))
			return Promise.reject(new TypeError('ReadableStream.pipeTo: not a WritableStream'));
		let converted;

		try {
			converted = pipeOptions(options);
		} catch (reason) {
			return Promise.reject(reason);
		}

		if (source._reader !== undefined)
			return Promise.reject(new TypeError('ReadableStream.pipeTo: the source is locked'));

		if (target._writer !== undefined)
			return Promise.reject(new TypeError('ReadableStream.pipeTo: the destination is locked'));

		return pipe(source, target, converted);
	}

	if (!isReadable(source)) throw new TypeError('ReadableStream.pipeThrough: not a ReadableStream');

	// the ReadableWritablePair dictionary: readable, then writable, both required
	if (target === null || (typeof target !== 'object' && typeof target !== 'function'))
		throw new TypeError('ReadableStream.pipeThrough: the transform must be an object');
	const readable = target.readable;

	if (!isReadable(readable))
		throw new TypeError('ReadableStream.pipeThrough: the readable side is not a ReadableStream');
	const writable = target.writable;

	if (!isWritable(writable))
		throw new TypeError('ReadableStream.pipeThrough: the writable side is not a WritableStream');
	const converted = pipeOptions(options);

	if (source._reader !== undefined)
		throw new TypeError('ReadableStream.pipeThrough: the stream is locked');

	if (writable._writer !== undefined)
		throw new TypeError('ReadableStream.pipeThrough: the writable side is locked');
	react(pipe(source, writable, converted), ignore, ignore);

	return readable;
}

/** Makes ReadableStream's pipeTo and pipeThrough work (called when WritableStream loads). */
export function plugPipe() {
	byteStreams.pipe = pipeMethod;
}

/**
 * ReadableStreamPipeTo: pipes `source` into `dest`, both unlocked; resolves once everything is
 * written and the destination closed, rejects with what ended it otherwise.
 * @param {ReadableStream} source
 * @param {WritableStream} dest
 * @param {{ preventClose: boolean, preventAbort: boolean, preventCancel: boolean, signal? }} options
 */
export function pipe(source, dest, options) {
	const { preventClose, preventAbort, preventCancel, signal } = options;
	const reader = new ReadableStreamDefaultReader(source);
	const writer = new WritableStreamDefaultWriter(dest);

	// disturbed from here on, before anything is read (a Response's bodyUsed turns true now)
	source._disturbed = true;
	let shuttingDown = false;
	let currentWrite = Promise.resolve();
	let resolvePipe;
	let rejectPipe;
	const promise = new Promise((resolve, reject) => {
		resolvePipe = resolve;
		rejectPipe = reject;
	});
	let abortAlgorithm;

	const finalize = (isError, reason) => {
		releaseWriter(writer);
		release(reader);

		if (signal !== undefined) signal.removeEventListener('abort', abortAlgorithm);

		if (isError) rejectPipe(reason);
		else resolvePipe();
	};

	// another write may start while this one is awaited: wait for that one too
	const waitForWritesToFinish = () => {
		const oldCurrentWrite = currentWrite;

		return react(currentWrite, () =>
			oldCurrentWrite === currentWrite ? undefined : waitForWritesToFinish()
		);
	};

	const shutdownWithAnAction = (action, originalIsError, originalError) => {
		if (shuttingDown) return;
		shuttingDown = true;
		const doTheRest = () => {
			react(
				action(),
				() => finalize(originalIsError, originalError),
				(newError) => finalize(true, newError)
			);
		};

		if (dest._state === 'writable' && !closeQueuedOrInFlight(dest))
			react(waitForWritesToFinish(), doTheRest);
		else doTheRest();
	};

	const shutdown = (isError, reason) => {
		if (shuttingDown) return;
		shuttingDown = true;

		if (dest._state === 'writable' && !closeQueuedOrInFlight(dest))
			react(waitForWritesToFinish(), () => finalize(isError, reason));
		else finalize(isError, reason);
	};

	if (signal !== undefined) {
		abortAlgorithm = () => {
			const reason = signal.reason;
			const actions = [];

			if (!preventAbort)
				actions.push(() => (dest._state === 'writable' ? abort(dest, reason) : Promise.resolve()));

			if (!preventCancel)
				actions.push(() =>
					source._state === 'readable' ? cancel(source, reason) : Promise.resolve()
				);
			shutdownWithAnAction(() => Promise.all(actions.map((action) => action())), true, reason);
		};

		if (signal.aborted) {
			abortAlgorithm();

			return promise;
		}
		signal.addEventListener('abort', abortAlgorithm);
	}

	// one step: wait for ready, read a chunk and write it (not awaited: the next ready is the
	// backpressure); true once the source is done
	const pipeStep = () => {
		if (shuttingDown) return Promise.resolve(true);

		return react(
			writer._ready.promise,
			() =>
				new Promise((resolveRead, rejectRead) => {
					readRequest(source, {
						resolve({ value, done }) {
							if (done) {
								resolveRead(true);

								return;
							}
							// a microtask later, never inside the source's enqueue()
							react(Promise.resolve(), () => {
								currentWrite = react(writerWrite(writer, value), ignore, ignore);
								resolveRead(false);
							});
						},
						reject: rejectRead
					});
				})
		);
	};
	const pipeLoop = () =>
		new Promise((resolveLoop, rejectLoop) => {
			const next = (done) => {
				if (done) resolveLoop();
				else react(pipeStep(), next, rejectLoop);
			};

			next(false);
		});

	// errors propagate forward
	if (source._state === 'errored') {
		const storedError = source._storedError;

		if (!preventAbort) shutdownWithAnAction(() => abort(dest, storedError), true, storedError);
		else shutdown(true, storedError);
	} else
		react(reader._closed.promise, undefined, (storedError) => {
			if (!preventAbort) shutdownWithAnAction(() => abort(dest, storedError), true, storedError);
			else shutdown(true, storedError);
		});

	// errors propagate backward
	if (dest._state === 'errored') {
		const storedError = dest._storedError;

		if (!preventCancel) shutdownWithAnAction(() => cancel(source, storedError), true, storedError);
		else shutdown(true, storedError);
	} else
		react(writer._closed.promise, undefined, (storedError) => {
			if (!preventCancel)
				shutdownWithAnAction(() => cancel(source, storedError), true, storedError);
			else shutdown(true, storedError);
		});

	// closing propagates forward
	const closeForward = () => {
		if (!preventClose) shutdownWithAnAction(() => writerCloseWithErrorPropagation(writer));
		else shutdown();
	};

	if (source._state === 'closed') closeForward();
	else react(reader._closed.promise, closeForward, ignore);

	// closing propagates backward
	if (closeQueuedOrInFlight(dest) || dest._state === 'closed') {
		const destClosed = new TypeError(
			'the destination writable stream closed before all data could be piped to it'
		);

		if (!preventCancel) shutdownWithAnAction(() => cancel(source, destClosed), true, destClosed);
		else shutdown(true, destClosed);
	}
	react(pipeLoop(), ignore, ignore);

	return promise;
}
