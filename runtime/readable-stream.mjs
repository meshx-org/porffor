// ReadableStream for a Porffor-compiled guest (Porffor has none): the Streams standard's
// default stream, in plain JS. Underlying sources with start / pull / cancel, a
// high-water mark counted in chunks, and a default reader. Not here: byte streams
// (type: 'bytes') and BYOB readers, and `for await` over the
// stream itself (Porffor's for await takes only its own iterables): read with
// getReader(), or `for await (const chunk of stream.values())`.
//
// The build injects this module (esbuild `inject`) into every guest, like ./abort.mjs.

import { pipe } from './pipe.mjs';
import { ReadableStreamDefaultReader } from './readable-stream-reader.mjs';
import { cancel, deferred, setUp } from './stream-internals.mjs';
import { structuredClone } from './structured-clone.mjs';

export { ReadableStreamDefaultReader };

/** An outcome nobody needs to see (a pipeThrough's failure shows on its readable side). */
const ignore = () => undefined;

/** Whether a branch can still take a chunk or be closed (neither closing nor ended). */
const open = (stream) => stream._state === 'readable' && !stream._closeRequested;

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
	const reader = stream.getReader();
	const controllers = [];
	const canceled = [false, false];
	const reasons = [undefined, undefined];
	const cancelled = deferred();
	let reading = false;
	let readAgain = false;

	const pull = () => {
		if (reading) {
			readAgain = true;

			return Promise.resolve();
		}
		reading = true;
		reader.read().then(
			({ value, done }) => {
				if (done) {
					reading = false;

					for (let index = 0; index < 2; index++)
						if (!canceled[index] && open(branches[index])) controllers[index].close();

					if (!canceled[0] || !canceled[1]) cancelled.resolve();

					return;
				}
				readAgain = false;
				const chunks = [value, value];

				if (cloneForBranch2 && !canceled[1]) {
					try {
						chunks[1] = structuredClone(value);
					} catch (cloneError) {
						for (const controller of controllers) controller.error(cloneError);
						cancelled.resolve(cancel(stream, cloneError));

						return;
					}
				}

				for (let index = 0; index < 2; index++)
					if (!canceled[index] && open(branches[index])) controllers[index].enqueue(chunks[index]);
				reading = false;

				if (readAgain) pull();
			},
			() => {
				// the error reaches the branches through closed, below
				reading = false;
			}
		);

		return Promise.resolve();
	};
	// read by the algorithms below only once tee has returned (start runs first, and pull
	// after start's promise settles)
	let branches;
	const branch = (index) =>
		new ReadableStream({
			start(controller) {
				controllers[index] = controller;
			},
			pull,
			cancel(reason) {
				canceled[index] = true;
				reasons[index] = reason;

				if (canceled[1 - index]) cancelled.resolve(cancel(stream, [...reasons]));

				return cancelled.promise;
			}
		});
	branches = [branch(0), branch(1)];

	reader.closed.then(ignore, (reason) => {
		for (const controller of controllers) controller.error(reason);

		if (!canceled[0] || !canceled[1]) cancelled.resolve();
	});

	return branches;
}

/** A stream of chunks pulled from an underlying source. */
export class ReadableStream {
	/**
	 * @param {{ start?, pull?, cancel? }} [source] called with the controller
	 *   ({ enqueue, close, error, desiredSize }); pull when a read or the high-water mark
	 *   wants a chunk, never twice at once
	 * @param {{ highWaterMark?: number }} [strategy] how many chunks to queue ahead (1)
	 */
	constructor(source, strategy) {
		const hwm = strategy?.highWaterMark;

		setUp(this, source ?? {}, hwm === undefined ? 1 : Number(hwm));
	}

	/** Whether a reader holds it. */
	get locked() {
		return this._reader !== undefined;
	}

	/** Locks it to a new reader. */
	getReader(options) {
		if (options?.mode !== undefined)
			throw new TypeError('ReadableStream.getReader: only the default reader is supported');

		return new ReadableStreamDefaultReader(this);
	}

	/**
	 * Its chunks as an async generator, for `for await (const chunk of stream.values())`:
	 * Porffor's for await takes its own generators but not the async iterator protocol,
	 * so `for await (const chunk of stream)` does not work. Leaving the loop early
	 * cancels the stream.
	 */
	async *values() {
		const reader = this.getReader();
		let finished = false;

		try {
			while (true) {
				const { value, done } = await reader.read();

				if (done) {
					finished = true;

					return;
				}

				yield value;
			}
		} finally {
			if (!finished) await reader.cancel();
			reader.releaseLock();
		}
	}

	/**
	 * Pipes it into a WritableStream; resolves once everything is written and the
	 * destination closed.
	 * @param {WritableStream} destination
	 * @param {{ preventClose?, preventAbort?, preventCancel?, signal? }} [options]
	 */
	pipeTo(destination, options) {
		return pipe(this, destination, options ?? {});
	}

	/**
	 * Pipes it through a transform ({ writable, readable }, a TransformStream or one of
	 * its kind) and returns the transform's readable side.
	 */
	pipeThrough(transform, options) {
		pipe(this, transform.writable, options ?? {}).then(ignore, ignore);

		return transform.readable;
	}

	/**
	 * Splits it into two streams that each see every chunk (the same chunk objects); it is
	 * locked to them from here on. Cancelling both cancels it, with both reasons.
	 * @returns {[ReadableStream, ReadableStream]}
	 */
	tee() {
		return tee(this);
	}

	/** Cancels it (when no reader holds it), telling its source why. */
	cancel(reason) {
		if (this._reader !== undefined)
			return Promise.reject(new TypeError('ReadableStream.cancel: the stream is locked'));

		return cancel(this, reason);
	}
}
