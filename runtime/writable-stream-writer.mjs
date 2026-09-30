// WritableStreamDefaultWriter for a Porffor-compiled guest: the way to write into a
// WritableStream, with ready for backpressure.

import {
	abort,
	close,
	closeQueuedOrInFlight,
	releaseWriter,
	setUpWriter,
	writerDesiredSize,
	writerWrite
} from './writable-internals.mjs';

const released = () => new TypeError('WritableStreamDefaultWriter: the writer was released');

/** Writes into a WritableStream it has locked. */
export class WritableStreamDefaultWriter {
	/** @param {WritableStream} stream */
	constructor(stream) {
		if (stream === null || typeof stream !== 'object' || stream._controller === undefined)
			throw new TypeError('WritableStreamDefaultWriter: not a WritableStream');
		setUpWriter(this, stream);
	}

	/** Resolves when the stream closes; rejects when it errors or the writer is released. */
	get closed() {
		return this._closed.promise;
	}

	/** Resolves when the stream wants more (backpressure has eased). */
	get ready() {
		return this._ready.promise;
	}

	/** How many more chunks the stream wants before backpressure; null once errored. */
	get desiredSize() {
		if (this._stream === undefined) throw released();

		return writerDesiredSize(this._stream);
	}

	/** Writes a chunk; resolves once the sink has taken it. */
	write(chunk = undefined) {
		return this._stream === undefined ? Promise.reject(released()) : writerWrite(this, chunk);
	}

	/** Closes after the queued writes; resolves once the sink has closed. */
	close() {
		const stream = this._stream;

		if (stream === undefined) return Promise.reject(released());

		if (closeQueuedOrInFlight(stream))
			return Promise.reject(new TypeError('WritableStreamDefaultWriter: already closing'));

		return close(stream);
	}

	/** Aborts the stream, dropping queued writes and telling the sink why. */
	abort(reason = undefined) {
		return this._stream === undefined ? Promise.reject(released()) : abort(this._stream, reason);
	}

	/** Unlocks the stream; another writer may take it. */
	releaseLock() {
		if (this._stream !== undefined) releaseWriter(this);
	}
}
