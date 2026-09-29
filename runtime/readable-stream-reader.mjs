// ReadableStreamDefaultReader for a Porffor-compiled guest: the one way to read a
// ReadableStream here (Porffor has no for await over async iterables).

import { cancel, deferred, read, release } from './stream-internals.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** Reads a ReadableStream it has locked, chunk by chunk. */
export class ReadableStreamDefaultReader {
	/** @param {ReadableStream} stream */
	constructor(stream) {
		if (stream._reader !== undefined)
			throw new TypeError('ReadableStreamDefaultReader: the stream is locked to another reader');
		this._stream = stream;
		this._closed = deferred();
		// a closed nobody awaits must not count as an unhandled rejection
		this._closed.promise.then(ignore, ignore);
		stream._reader = this;

		if (stream._state === 'closed') this._closed.resolve();
		else if (stream._state === 'errored') this._closed.reject(stream._storedError);
	}

	/** Resolves when the stream closes; rejects when it errors or the reader is released. */
	get closed() {
		return this._closed.promise;
	}

	/** The next chunk: { value, done: false }, or { value: undefined, done: true } at the end. */
	read() {
		if (this._stream === undefined)
			return Promise.reject(new TypeError('ReadableStreamDefaultReader: the reader was released'));

		return read(this._stream);
	}

	/** Cancels the stream, telling its source why. */
	cancel(reason) {
		if (this._stream === undefined)
			return Promise.reject(new TypeError('ReadableStreamDefaultReader: the reader was released'));

		return cancel(this._stream, reason);
	}

	/** Unlocks the stream; reads still waiting reject. */
	releaseLock() {
		release(this);
	}
}
