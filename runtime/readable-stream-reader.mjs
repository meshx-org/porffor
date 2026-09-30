// ReadableStreamDefaultReader for a Porffor-compiled guest: the way to read a ReadableStream
// chunk by chunk.

import { cancel, read, release, setUpReader } from './stream-internals.mjs';

const released = () => new TypeError('ReadableStreamDefaultReader: the reader was released');

/** Reads a ReadableStream it has locked, chunk by chunk. */
export class ReadableStreamDefaultReader {
	/** @param {ReadableStream} stream */
	constructor(stream) {
		setUpReader(this, stream);
	}

	/** Resolves when the stream closes; rejects when it errors or the reader is released. */
	get closed() {
		return this._closed.promise;
	}

	/** The next chunk: { value, done: false }, or { value: undefined, done: true } at the end. */
	read() {
		return this._stream === undefined ? Promise.reject(released()) : read(this._stream);
	}

	/** Cancels the stream, telling its source why. */
	cancel(reason = undefined) {
		return this._stream === undefined ? Promise.reject(released()) : cancel(this._stream, reason);
	}

	/** Unlocks the stream; reads still waiting reject. */
	releaseLock() {
		release(this);
	}
}
