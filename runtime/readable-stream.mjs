// ReadableStream for a Porffor-compiled guest (Porffor has none): the Streams standard's
// default stream, in plain JS. Underlying sources with start / pull / cancel, a queuing
// strategy (a high-water mark, counted in chunks or in what its size() gives), its
// ReadableStreamDefaultController, and a default reader. Byte streams (type: 'bytes') and
// BYOB readers are ./readable-byte-stream.mjs, compiled in only when a program names one of
// its classes; without it a byte stream is a default one. Not here: `for await` over the
// stream itself (Porffor's for await takes only its own iterables): read with getReader(),
// or `for await (const chunk of stream.values())`.
//
// The build injects this module (esbuild `inject`) into every guest, like ./abort.mjs.

import { ReadableStreamDefaultReader } from './readable-stream-reader.mjs';
import {
	ReadableStreamDefaultController,
	byteStreams,
	canCloseOrEnqueue,
	cancel,
	deferred,
	enqueue,
	error as errorStream,
	readRequest,
	requestClose,
	setUp,
	sourceAlgorithms
} from './stream-internals.mjs';
import { callback, isDictionary, isOptionalObject, react } from './stream-queue.mjs';
import { structuredClone } from './structured-clone.mjs';

export { ReadableStreamDefaultController, ReadableStreamDefaultReader };

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** Async iteration (./readable-stream-iteration.mjs) is not in this program. */
const iterationMissing = () =>
	new TypeError(
		'ReadableStream: async iteration and ReadableStream.from come with a program that iterates a stream (for await, values(), ReadableStream.from)'
	);

/**
 * ReadableStreamDefaultTee (https://streams.spec.whatwg.org/#readable-stream-default-tee): one
 * read of the source at a time, on behalf of whichever branch pulls; each chunk goes to both
 * branches' queues. The source's error reaches both branches as soon as it happens (through
 * its reader's closed), not at their next read. Cancelling one branch drops it; cancelling
 * both cancels the source with [reason1, reason2], and both cancel() calls settle with that.
 * With cloneForBranch2 (a Request's or Response's clone()), the second branch gets a
 * structured clone of each chunk, so the two never share a buffer; a chunk that cannot be
 * cloned errors both branches and cancels the source.
 * @param {ReadableStream} stream
 * @param {boolean} [cloneForBranch2]
 */
export function tee(stream, cloneForBranch2 = false) {
	const reader = new ReadableStreamDefaultReader(stream);
	const canceled = [false, false];
	const reasons = [undefined, undefined];
	const cancelled = deferred();
	const branches = [];
	let reading = false;
	let readAgain = false;

	const enqueueBranch = (index, chunk) => {
		if (!canceled[index] && canCloseOrEnqueue(branches[index])) enqueue(branches[index], chunk);
	};
	const pull = () => {
		if (reading) {
			readAgain = true;

			return Promise.resolve();
		}
		reading = true;
		readRequest(stream, {
			resolve({ value, done }) {
				if (done) {
					reading = false;

					for (let index = 0; index < 2; index++)
						if (!canceled[index] && canCloseOrEnqueue(branches[index]))
							requestClose(branches[index]);

					if (!canceled[0] || !canceled[1]) cancelled.resolve();

					return;
				}
				// a microtask later, so a read in a branch never runs inside the source's enqueue()
				react(Promise.resolve(), () => {
					readAgain = false;
					let second = value;

					if (cloneForBranch2 && !canceled[1]) {
						try {
							second = structuredClone(value);
						} catch (cloneError) {
							errorStream(branches[0], cloneError);
							errorStream(branches[1], cloneError);
							cancelled.resolve(cancel(stream, cloneError));

							return;
						}
					}
					enqueueBranch(0, value);
					enqueueBranch(1, second);
					reading = false;

					if (readAgain) pull();
				});
			},
			reject() {
				reading = false;
			}
		});

		return Promise.resolve();
	};
	const branch = (index) =>
		createReadable(
			{
				source: undefined,
				start: undefined,
				pull,
				cancel(reason) {
					canceled[index] = true;
					reasons[index] = reason;

					if (canceled[1 - index]) cancelled.resolve(cancel(stream, [...reasons]));

					return cancelled.promise;
				}
			},
			1,
			undefined
		);

	branches.push(branch(0), branch(1));
	react(reader._closed.promise, ignore, (reason) => {
		errorStream(branches[0], reason);
		errorStream(branches[1], reason);

		if (!canceled[0] || !canceled[1]) cancelled.resolve();
	});

	return branches;
}

/** What createReadable hands the constructor (a token no program has). */
const creation = { algorithms: undefined, hwm: 0, size: undefined, bytes: false };

/**
 * CreateReadableStream: a default ReadableStream (a byte stream with `bytes`, as
 * CreateReadableByteStream makes) run by `algorithms` ({ start, pull, cancel }, as
 * sourceAlgorithms gives them) rather than an underlying source, as a TransformStream's
 * readable side is.
 */
export function createReadable(algorithms, hwm, size, bytes = false) {
	creation.bytes = bytes;
	creation.algorithms = algorithms;
	creation.hwm = hwm;
	creation.size = size;

	return new ReadableStream(creation);
}

/** A stream of chunks pulled from an underlying source. */
export class ReadableStream {
	/**
	 * @param {{ start?, pull?, cancel?, type?, autoAllocateChunkSize? }} [source] called with
	 *   the controller (a ReadableStreamDefaultController: enqueue, close, error,
	 *   desiredSize); pull when a read or the high-water mark wants a chunk, never twice at
	 *   once. type: 'bytes' makes a byte stream (a ReadableByteStreamController)
	 * @param {{ highWaterMark?: number, size?: (chunk) => number }} [strategy] how much to
	 *   queue ahead (1 chunk; 0 bytes for a byte stream), measured by size (1 per chunk)
	 */
	constructor(source = undefined, strategy = undefined) {
		// CreateReadableStream's (below): a stream run by algorithms, not a source
		if (source === creation) {
			if (creation.bytes) byteStreams.setUp(this, creation.algorithms, creation.hwm);
			else setUp(this, creation.algorithms, creation.hwm, creation.size);

			return;
		}

		if (!isOptionalObject(source))
			throw new TypeError('ReadableStream: the source must be an object');
		// WebIDL converts the strategy argument before the constructor reads the source
		if (!isDictionary(strategy))
			throw new TypeError('ReadableStream: the strategy must be an object');
		const rawHwm = strategy?.highWaterMark;
		// unary +, not Number(): Porffor's Number(undefined) is 0, not NaN
		const givenHwm = rawHwm === undefined ? undefined : +rawHwm;
		const size = callback(strategy ?? {}, 'size', 'ReadableStream');
		const algorithms = sourceAlgorithms(source);
		const bytes = algorithms.type === 'bytes';

		if (bytes && size !== undefined)
			throw new RangeError('ReadableStream: a byte stream cannot have a size function');
		const hwm = givenHwm === undefined ? (bytes ? 0 : 1) : givenHwm;

		if (hwm !== hwm || hwm < 0) throw new RangeError('ReadableStream: invalid highWaterMark');

		// a program that never names the byte stream's classes does not have them: its byte
		// streams are default ones, which take the same chunks (and have no byobRequest)
		if (bytes && byteStreams.setUp !== undefined) byteStreams.setUp(this, algorithms, hwm);
		else setUp(this, algorithms, hwm, size);
	}

	/**
	 * A stream of what an async iterable (or an iterable) gives: pulled one at a time, and
	 * the iterator's return() called when the stream is cancelled.
	 * @param {AsyncIterable | Iterable} asyncIterable
	 */
	static from(asyncIterable) {
		if (byteStreams.from === undefined) throw iterationMissing();

		return byteStreams.from(asyncIterable);
	}

	/** Whether a reader holds it. */
	get locked() {
		return this._reader !== undefined;
	}

	/** Locks it to a new reader. */
	getReader(options = undefined) {
		if (!isDictionary(options))
			throw new TypeError('ReadableStream.getReader: the options must be an object');
		const mode = options?.mode;

		if (mode === undefined) return new ReadableStreamDefaultReader(this);

		if (String(mode) !== 'byob')
			throw new TypeError('ReadableStream.getReader: the mode must be byob or undefined');

		if (byteStreams.reader === undefined)
			throw new TypeError(
				'ReadableStream.getReader: BYOB readers need the byte streams, which a program has when it names ReadableStreamBYOBReader or ReadableByteStreamController'
			);

		return byteStreams.reader(this);
	}

	/**
	 * Its chunks as an async iterator, for `for await (const chunk of stream.values())` (or
	 * of the stream itself, whose @@asyncIterator ./readable-stream-iteration.mjs adds: a
	 * symbol-keyed method costs every program with a stream some 16 KB): leaving the loop
	 * early cancels the stream, unless preventCancel.
	 * @param {{ preventCancel?: boolean }} [options]
	 */
	values(options = undefined) {
		if (!isDictionary(options))
			throw new TypeError('ReadableStream.values: the options must be an object');

		if (byteStreams.iterate === undefined) throw iterationMissing();

		return byteStreams.iterate(this, Boolean(options?.preventCancel));
	}

	/**
	 * Pipes it into a WritableStream; resolves once everything is written and the
	 * destination closed.
	 * @param {WritableStream} destination
	 * @param {{ preventClose?, preventAbort?, preventCancel?, signal? }} [options]
	 */
	pipeTo(destination, options = undefined) {
		// only a program with WritableStream has a destination to pipe to (and the pipe)
		if (byteStreams.pipe === undefined)
			return Promise.reject(new TypeError('ReadableStream.pipeTo: not a WritableStream'));

		return byteStreams.pipe(this, destination, options, false);
	}

	/**
	 * Pipes it through a transform ({ writable, readable }, a TransformStream or one of
	 * its kind) and returns the transform's readable side.
	 */
	pipeThrough(transform, options = undefined) {
		if (byteStreams.pipe === undefined)
			throw new TypeError('ReadableStream.pipeThrough: the writable side is not a WritableStream');

		return byteStreams.pipe(this, transform, options, true);
	}

	/**
	 * Splits it into two streams that each see every chunk (the same chunk objects); it is
	 * locked to them from here on. Cancelling both cancels it, with both reasons.
	 * @returns {[ReadableStream, ReadableStream]}
	 */
	tee() {
		if (this._bytes !== undefined && byteStreams.tee !== undefined) return byteStreams.tee(this);

		return tee(this);
	}

	/** Cancels it (when no reader holds it), telling its source why. */
	cancel(reason = undefined) {
		if (this._reader !== undefined)
			return Promise.reject(new TypeError('ReadableStream.cancel: the stream is locked'));

		return cancel(this, reason);
	}
}
