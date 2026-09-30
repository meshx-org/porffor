// The Streams standard's two built-in queuing strategies, for a Porffor-compiled guest: what
// a stream's high-water mark counts, handed to a stream's constructor as its strategy. Their
// own globals (runtime/globals.json), so a program that never names them does not carry them;
// the streams take any { highWaterMark, size } object alike.

/** The high-water mark an init dictionary must give (a TypeError without one). */
function initHighWaterMark(init, name) {
	if (init === null || typeof init !== 'object' || init.highWaterMark === undefined)
		throw new TypeError(`${name}: the init dictionary needs a highWaterMark`);

	return Number(init.highWaterMark);
}

/**
 * Its size, as the standard shares one function between every instance (and calls it
 * without a `this`).
 */
// a method: named size, and without a prototype, as the standard's function is
const countSize = {
	size() {
		return 1;
	}
}.size;

/** Counts the byte length of each chunk (an ArrayBuffer or ArrayBufferView). */
// a method: named size, and without a prototype, as the standard's function is
const byteLengthSize = {
	size(chunk) {
		return chunk.byteLength;
	}
}.size;

/** Counts chunks: each is 1, whatever it holds. */
export class CountQueuingStrategy {
	/** @param {{ highWaterMark: number }} init how many chunks to queue before backpressure */
	constructor(init) {
		this._hwm = initHighWaterMark(init, 'CountQueuingStrategy');
	}

	/** How many chunks to queue before backpressure. */
	get highWaterMark() {
		return this._hwm;
	}

	/** Every chunk's size: 1. */
	get size() {
		return countSize;
	}
}

/** Counts bytes: each chunk is its byteLength. */
export class ByteLengthQueuingStrategy {
	/** @param {{ highWaterMark: number }} init how many bytes to queue before backpressure */
	constructor(init) {
		this._hwm = initHighWaterMark(init, 'ByteLengthQueuingStrategy');
	}

	/** How many bytes to queue before backpressure. */
	get highWaterMark() {
		return this._hwm;
	}

	/** A chunk's size: its byteLength. */
	get size() {
		return byteLengthSize;
	}
}
