// WritableStreamDefaultWriter for a Porffor-compiled guest: the way to write into a
// WritableStream, with ready for backpressure.

import { deferred } from './stream-internals.mjs';
import { abort, close, desiredSize, write } from './writable-internals.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

const released = () => new TypeError('WritableStreamDefaultWriter: the writer was released');

/** Writes into a WritableStream it has locked. */
export class WritableStreamDefaultWriter {
	/** @param {WritableStream} stream */
	constructor(stream) {
		if (stream._writer !== undefined)
			throw new TypeError('WritableStreamDefaultWriter: the stream is locked to another writer');
		this._stream = stream;
		this._closed = deferred();
		this._closed.promise.then(ignore, ignore);
		stream._writer = this;

		if (stream._state === 'closed') this._closed.resolve();
		else if (stream._state === 'errored') this._closed.reject(stream._storedError);
	}

	/** Resolves when the stream closes; rejects when it errors or the writer is released. */
	get closed() {
		return this._closed.promise;
	}

	/** Resolves when the stream wants more (backpressure has eased). */
	get ready() {
		return this._stream === undefined ? Promise.reject(released()) : this._stream._ready.promise;
	}

	/** How many more chunks the stream wants before backpressure; null once errored. */
	get desiredSize() {
		if (this._stream === undefined) throw released();

		return desiredSize(this._stream);
	}

	/** Writes a chunk; resolves once the sink has taken it. */
	write(chunk) {
		return this._stream === undefined ? Promise.reject(released()) : write(this._stream, chunk);
	}

	/** Closes after the queued writes; resolves once the sink has closed. */
	close() {
		return this._stream === undefined ? Promise.reject(released()) : close(this._stream);
	}

	/** Aborts the stream, dropping queued writes and telling the sink why. */
	abort(reason) {
		return this._stream === undefined ? Promise.reject(released()) : abort(this._stream, reason);
	}

	/** Unlocks the stream; another writer may take it. */
	releaseLock() {
		const stream = this._stream;

		if (stream === undefined) return;

		if (stream._state === 'writable') this._closed.reject(released());
		stream._writer = undefined;
		this._stream = undefined;
	}
}
