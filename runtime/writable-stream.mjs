// WritableStream for a Porffor-compiled guest (Porffor has none): the Streams standard's
// default writable stream, in plain JS. Underlying sinks with start / write / close /
// abort, a high-water mark counted in chunks (backpressure through the writer's ready),
// and a default writer. Injected into every guest, like ./readable-stream.mjs.

import { WritableStreamDefaultWriter } from './writable-stream-writer.mjs';
import { abort, close, setUpWritable } from './writable-internals.mjs';

export { WritableStreamDefaultWriter };

/** A destination for chunks, handed to an underlying sink one at a time. */
export class WritableStream {
	/**
	 * @param {{ start?, write?, close?, abort? }} [sink] write gets each chunk in order,
	 *   never two at once; close runs after the last write
	 * @param {{ highWaterMark?: number }} [strategy] how many chunks to queue before
	 *   backpressure (1)
	 */
	constructor(sink, strategy) {
		const hwm = strategy?.highWaterMark;

		setUpWritable(this, sink ?? {}, hwm === undefined ? 1 : Number(hwm));
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

		return close(this);
	}

	/** Aborts it (when no writer holds it), telling its sink why. */
	abort(reason) {
		if (this._writer !== undefined)
			return Promise.reject(new TypeError('WritableStream.abort: the stream is locked'));

		return abort(this, reason);
	}
}
