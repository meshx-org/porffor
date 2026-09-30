// WritableStream for a Porffor-compiled guest (Porffor has none): the Streams standard's
// default writable stream, in plain JS. Underlying sinks with start / write / close /
// abort, handed a WritableStreamDefaultController; a queuing strategy (a high-water mark
// counted in chunks, or in what its size() gives; backpressure through the writer's
// ready), and a default writer. Loading it plugs pipeTo into ReadableStream (./pipe.mjs):
// a pipe needs a WritableStream, so a program without one does not carry the pipe.

import { plugPipe } from './pipe.mjs';
import { extractStrategy, isOptionalObject } from './stream-queue.mjs';
import { WritableStreamDefaultWriter } from './writable-stream-writer.mjs';
import {
	WritableStreamDefaultController,
	abort,
	close,
	closeQueuedOrInFlight,
	internalToken,
	setUpFromSink,
	setUpWritable
} from './writable-internals.mjs';

export { WritableStreamDefaultController, WritableStreamDefaultWriter };

plugPipe();

/** What createWritable hands the constructor (a token no program has). */
const creation = { args: undefined };

/**
 * CreateWritableStream: a WritableStream run by algorithms (start returns a value or a
 * promise; write, close and abort return promises) rather than an underlying sink, as a
 * TransformStream's writable side is.
 */
export function createWritable(start, write, close, abort, hwm, size) {
	creation.args = [start, write, close, abort, hwm, size];

	return new WritableStream(creation);
}

/** A destination for chunks, handed to an underlying sink one at a time. */
export class WritableStream {
	/**
	 * @param {{ start?, write?, close?, abort? }} [sink] write gets each chunk in order,
	 *   never two at once, and the controller; close runs after the last write
	 * @param {{ highWaterMark?: number, size?: (chunk) => number }} [strategy] how much to
	 *   queue before backpressure (1 chunk), measured by size (1 per chunk)
	 */
	constructor(sink = undefined, strategy = undefined) {
		// CreateWritableStream's (below): a stream run by algorithms, not a sink
		if (sink === creation) {
			const [start, write, close_, abort_, hwm, size] = creation.args;

			setUpWritable(
				this,
				new WritableStreamDefaultController(internalToken),
				start,
				write,
				close_,
				abort_,
				hwm,
				size
			);

			return;
		}

		if (!isOptionalObject(sink)) throw new TypeError('WritableStream: the sink must be an object');
		// WebIDL converts the strategy argument before the constructor reads the sink
		const { hwm, size } = extractStrategy(strategy, 1, 'WritableStream');

		setUpFromSink(this, sink, hwm, size);
	}

	/** Whether a writer holds it. */
	get locked() {
		return this._writer !== undefined;
	}

	/** Locks it to a new writer. */
	getWriter() {
		return new WritableStreamDefaultWriter(this);
	}

	/** Closes it (when no writer holds it). */
	close() {
		if (this._writer !== undefined)
			return Promise.reject(new TypeError('WritableStream.close: the stream is locked'));

		if (closeQueuedOrInFlight(this))
			return Promise.reject(new TypeError('WritableStream.close: already closing'));

		return close(this);
	}

	/** Aborts it (when no writer holds it), telling its sink why. */
	abort(reason = undefined) {
		if (this._writer !== undefined)
			return Promise.reject(new TypeError('WritableStream.abort: the stream is locked'));

		return abort(this, reason);
	}
}
