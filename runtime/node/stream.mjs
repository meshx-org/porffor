// node:stream: Readable, Writable, Duplex, Transform and PassThrough over EventEmitter, with
// pipe, pipeline and finished, async iteration, Readable.from, and the bridges to web streams
// (toWeb / fromWeb, runtime/readable-stream.mjs and writable-stream.mjs). A pragmatic Node:
// object mode, highWaterMark backpressure (write() returns false, then 'drain'), flowing and
// paused reading ('data', 'readable' + read()), 'end' / 'finish' / 'close' / 'error' in Node's
// order, destroy() and autoDestroy.
//
// Where it is simpler than Node's: events are queued as promise jobs (Node's process.nextTick
// runs before those), cork() only holds writes until uncork(), writev is not used, and
// `duplex instanceof Writable` is false (Node answers it with Symbol.hasInstance, which Porffor
// does not consult).
import { EventEmitter } from './events.mjs';
import { Buffer } from './buffer.mjs';
import { StringDecoder } from './string_decoder.mjs';
import { ReadableStream } from '../readable-stream.mjs';
import { WritableStream } from '../writable-stream.mjs';

const nextTick = (fn, ...args) => {
	Promise.resolve().then(() => fn(...args));
};

let defaultHighWaterMark = 65536;
let defaultObjectHighWaterMark = 16;

/** The highWaterMark a stream gets when its options give none. */
export const getDefaultHighWaterMark = (objectMode) =>
	objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;

export const setDefaultHighWaterMark = (objectMode, value) => {
	if (objectMode) defaultObjectHighWaterMark = value;
	else defaultHighWaterMark = value;
};

const codeError = (Kind, code, message) => {
	const e = new Kind(message);
	e.code = code;
	return e;
};

const invalidChunk = (chunk) =>
	codeError(
		TypeError,
		'ERR_INVALID_ARG_TYPE',
		`The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${chunk === null ? 'null' : typeof chunk}`
	);

// a chunk as a Buffer (non-object mode): a string in an encoding, any view's bytes
const chunkBuffer = (chunk, encoding) => {
	if (chunk instanceof Buffer) return chunk;
	if (typeof chunk === 'string') return Buffer.from(chunk, encoding);
	if (ArrayBuffer.isView(chunk))
		return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	throw invalidChunk(chunk);
};

/** Node's legacy Stream: an EventEmitter with pipe(). The base of the others. */
export class Stream extends EventEmitter {
	constructor(options) {
		super(options);
	}
}

// ---- Readable ----

function readableState(stream, options, isDuplex) {
	const objectMode = !!(options.objectMode || (isDuplex && options.readableObjectMode));
	return {
		objectMode,
		highWaterMark:
			options.readableHighWaterMark ?? options.highWaterMark ?? getDefaultHighWaterMark(objectMode),
		buffer: [],
		length: 0,
		flowing: null,
		ended: false,
		endEmitted: false,
		reading: false,
		readingMore: false,
		emittedReadable: false,
		needReadable: false,
		flowScheduled: false,
		destroyed: false,
		errored: null,
		closed: false,
		autoDestroy: options.autoDestroy ?? true,
		emitClose: options.emitClose ?? true,
		decoder: options.encoding ? new StringDecoder(options.encoding) : null,
		encoding: options.encoding ?? null,
		pipes: []
	};
}

/** A source of data: pushed by _read (or push() from anywhere), consumed as 'data' or read(). */
export class Readable extends Stream {
	constructor(options = {}) {
		super(options);
		this._readableState = readableState(this, options, false);
		if (typeof options.read === 'function') this._read = options.read;
		if (typeof options.destroy === 'function') this._destroy = options.destroy;
		if (typeof options.construct === 'function') {
			this._readableState.constructing = true;
			nextTick(() =>
				options.construct.call(this, (error) => {
					this._readableState.constructing = false;
					if (error) this.destroy(error);
					else maybeRead(this);
				})
			);
		}
		if (options.signal !== undefined) addAbortSignal(options.signal, this);
	}

	/** Adds chunk to what is read (null: the end). False when the buffer is at its highWaterMark. */
	push(chunk, encoding) {
		return addChunk(this, chunk, encoding, false);
	}

	/** Puts chunk back at the front of what is read. */
	unshift(chunk, encoding) {
		return addChunk(this, chunk, encoding, true);
	}

	_read() {
		throw codeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _read() method is not implemented');
	}

	/**
	 * In paused mode: size bytes (or objects) from the buffer, all of it with no size, or null
	 * while there are not that many.
	 */
	read(size) {
		const state = this._readableState;
		if (size === 0) {
			maybeRead(this);
			return null;
		}
		if (state.length === 0) {
			if (state.ended) endIfDone(this);
			else {
				state.needReadable = true;
				maybeRead(this);
			}
			return null;
		}
		let out;
		if (state.objectMode) {
			out = state.buffer.shift();
			state.length--;
		} else if (size === undefined || size >= state.length) {
			if (size !== undefined && size > state.length && !state.ended) {
				state.needReadable = true;
				maybeRead(this);
				return null;
			}
			out = takeAll(state);
		} else out = takeBytes(state, size);
		if (state.length === 0) state.needReadable = true;
		if (state.length < state.highWaterMark) maybeRead(this);
		if (state.ended && state.length === 0) endIfDone(this);
		if (out !== null) this.emit('data', out);
		return out;
	}

	/** Chunks as strings in encoding from now on. */
	setEncoding(encoding) {
		const state = this._readableState;
		state.decoder = new StringDecoder(encoding);
		state.encoding = state.decoder.encoding;
		// what is buffered, decoded
		if (!state.objectMode && state.buffer.length > 0) {
			const text = state.buffer
				.map((chunk) => (typeof chunk === 'string' ? chunk : state.decoder.write(chunk)))
				.join('');
			state.buffer = text === '' ? [] : [text];
			state.length = text.length;
		}
		return this;
	}

	on(name, listener) {
		super.on(name, listener);
		const state = this._readableState;
		if (name === 'data') {
			if (state.flowing !== false) this.resume();
		} else if (name === 'readable') {
			if (!state.endEmitted) {
				state.flowing = false;
				state.needReadable = true;
				state.emittedReadable = false;
				if (state.length > 0) emitReadable(this);
				else maybeRead(this);
			}
		}
		return this;
	}

	/** Starts (or goes on) emitting 'data'. */
	resume() {
		const state = this._readableState;
		if (!state.flowing) {
			state.flowing = true;
			this.emit('resume');
		}
		scheduleFlow(this);
		return this;
	}

	/** Stops emitting 'data'; what comes meanwhile is buffered. */
	pause() {
		if (this._readableState.flowing !== false) {
			this._readableState.flowing = false;
			this.emit('pause');
		}
		return this;
	}

	isPaused() {
		return this._readableState.flowing === false;
	}

	/**
	 * Writes what this reads to dest (with its backpressure), and ends dest at the end unless
	 * { end: false }.
	 * @returns dest
	 */
	pipe(dest, options = {}) {
		const source = this;
		const state = this._readableState;
		const onData = (chunk) => {
			if (dest.write(chunk) === false) source.pause();
		};
		const onDrain = () => source.resume();
		const onEnd = () => {
			if (options.end !== false) dest.end();
		};
		const cleanup = () => {
			source.off('data', onData);
			source.off('end', onEnd);
			dest.off('drain', onDrain);
		};
		state.pipes.push({ dest, cleanup });
		source.on('data', onData);
		dest.on('drain', onDrain);
		source.once('end', onEnd);
		source.once('close', cleanup);
		dest.emit('pipe', source);
		if (!state.flowing) source.resume();
		return dest;
	}

	/** Stops piping to dest (to every destination, with none given). */
	unpipe(dest) {
		const state = this._readableState;
		for (const pipe of state.pipes.slice()) {
			if (dest !== undefined && pipe.dest !== dest) continue;
			pipe.cleanup();
			state.pipes.splice(state.pipes.indexOf(pipe), 1);
			pipe.dest.emit('unpipe', this);
		}
		if (state.pipes.length === 0) this.pause();
		return this;
	}

	/** Ends the stream now (with error, when given): 'error' then 'close'. */
	destroy(error, callback) {
		return destroyStream(this, error, callback);
	}

	_destroy(error, callback) {
		callback(error);
	}

	/** The chunks as an async iterator (the stream is destroyed when the loop breaks). */
	[Symbol.asyncIterator]() {
		return readableIterator(this, true);
	}

	/** The chunks as an async iterator; destroyOnReturn false leaves the stream as it is. */
	iterator(options = {}) {
		return readableIterator(this, options.destroyOnReturn !== false);
	}

	/** An array of every chunk, when the stream ends. */
	async toArray() {
		const out = [];
		for await (const chunk of readableIterator(this, true)) out.push(chunk);
		return out;
	}

	get readable() {
		const state = this._readableState;
		return !state.destroyed && !state.errored && !state.endEmitted;
	}

	get readableEnded() {
		return this._readableState.endEmitted;
	}

	get readableFlowing() {
		return this._readableState.flowing;
	}

	get readableLength() {
		return this._readableState.length;
	}

	get readableObjectMode() {
		return this._readableState.objectMode;
	}

	get readableHighWaterMark() {
		return this._readableState.highWaterMark;
	}

	get readableEncoding() {
		return this._readableState.encoding;
	}

	get destroyed() {
		return (this._readableState ?? this._writableState).destroyed;
	}

	get closed() {
		return (this._readableState ?? this._writableState).closed;
	}

	get errored() {
		return (this._readableState ?? this._writableState).errored;
	}

	/** A Readable of an iterable's or async iterable's values (object mode by default). */
	static from(iterable, options = {}) {
		if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
			return new Readable({
				objectMode: true,
				...options,
				read() {
					this.push(iterable);
					this.push(null);
				}
			});
		}
		const iterator =
			typeof iterable?.[Symbol.asyncIterator] === 'function'
				? iterable[Symbol.asyncIterator]()
				: typeof iterable?.[Symbol.iterator] === 'function'
					? iterable[Symbol.iterator]()
					: // an iterator as it is (Porffor's async generator objects have no
						// Symbol.asyncIterator method)
						typeof iterable?.next === 'function'
						? iterable
						: null;
		if (iterator === null)
			throw codeError(
				TypeError,
				'ERR_INVALID_ARG_TYPE',
				`The "iterable" argument must be an instance of Iterable. Received ${typeof iterable}`
			);
		let reading = false;
		return new Readable({
			objectMode: true,
			...options,
			async read() {
				if (reading) return;
				reading = true;
				try {
					for (;;) {
						const { value, done } = await iterator.next();
						if (done) {
							this.push(null);
							break;
						}
						const chunk = await value;
						if (chunk === null) {
							throw codeError(
								TypeError,
								'ERR_STREAM_NULL_VALUES',
								'May not write null values to stream'
							);
						}
						if (!this.push(chunk)) break;
					}
				} catch (error) {
					this.destroy(error);
				}
				reading = false;
			},
			destroy(error, callback) {
				if (typeof iterator.return === 'function') {
					Promise.resolve(iterator.return()).then(
						() => callback(error),
						(e) => callback(error ?? e)
					);
				} else callback(error);
			}
		});
	}

	/** A web ReadableStream of what readable reads. */
	static toWeb(readable) {
		return new ReadableStream({
			start(controller) {
				readable.on('data', (chunk) => {
					controller.enqueue(
						chunk instanceof Buffer
							? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
							: chunk
					);
				});
				readable.once('end', () => controller.close());
				readable.once('error', (error) => controller.error(error));
			},
			cancel(reason) {
				readable.destroy(reason);
			}
		});
	}

	/** A Readable of what a web ReadableStream gives. */
	static fromWeb(stream, options = {}) {
		const reader = stream.getReader();
		return new Readable({
			...options,
			async read() {
				try {
					const { value, done } = await reader.read();
					this.push(done ? null : value);
				} catch (error) {
					this.destroy(error);
				}
			},
			destroy(error, callback) {
				reader.cancel(error).then(
					() => callback(error),
					() => callback(error)
				);
			}
		});
	}
}

function addChunk(stream, chunk, encoding, front) {
	const state = stream._readableState;
	if (chunk === null) {
		if (!state.ended) {
			state.ended = true;
			if (state.decoder !== null) {
				const rest = state.decoder.end();
				if (rest !== '') {
					state.buffer.push(rest);
					state.length += rest.length;
				}
			}
			state.reading = false;
			if (state.flowing) scheduleFlow(stream);
			else emitReadable(stream);
			if (state.length === 0) endIfDone(stream);
		}
		return false;
	}
	if (state.ended && !front) {
		stream.destroy(codeError(Error, 'ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF'));
		return false;
	}
	if (state.destroyed) return false;
	if (!state.objectMode) {
		if (
			typeof chunk === 'string' &&
			state.decoder !== null &&
			(encoding === undefined || encoding === state.encoding)
		) {
			// a string in the stream's own encoding stays one
		} else chunk = chunkBuffer(chunk, encoding);
		if (state.decoder !== null && typeof chunk !== 'string') chunk = state.decoder.write(chunk);
		if (chunk.length === 0) {
			state.reading = false;
			return state.length < state.highWaterMark;
		}
	}
	state.reading = false;
	if (front) state.buffer.unshift(chunk);
	else state.buffer.push(chunk);
	state.length += state.objectMode ? 1 : chunk.length;
	if (state.flowing) scheduleFlow(stream);
	else if (state.needReadable) emitReadable(stream);
	return state.length < state.highWaterMark;
}

const takeAll = (state) => {
	const chunks = state.buffer;
	state.buffer = [];
	state.length = 0;
	if (chunks.length === 1) return chunks[0];
	return state.decoder !== null ? chunks.join('') : Buffer.concat(chunks);
};

const takeBytes = (state, size) => {
	const parts = [];
	let left = size;
	while (left > 0) {
		const chunk = state.buffer[0];
		if (chunk.length <= left) {
			parts.push(state.buffer.shift());
			left -= chunk.length;
		} else {
			parts.push(
				typeof chunk === 'string'
					? chunk.slice(0, left)
					: Buffer.prototype.subarray.call(chunk, 0, left)
			);
			state.buffer[0] =
				typeof chunk === 'string' ? chunk.slice(left) : Buffer.prototype.subarray.call(chunk, left);
			left = 0;
		}
	}
	state.length -= size;
	return state.decoder !== null ? parts.join('') : Buffer.concat(parts);
};

// asks _read for more while the buffer is under its highWaterMark and not ended
function maybeRead(stream) {
	const state = stream._readableState;
	if (state.readingMore || state.ended || state.destroyed || state.constructing) return;
	state.readingMore = true;
	nextTick(() => {
		state.readingMore = false;
		if (state.reading || state.ended || state.destroyed) return;
		if (state.length < state.highWaterMark || state.flowing || state.needReadable) {
			state.reading = true;
			const before = state.length;
			try {
				stream._read(state.objectMode ? 1 : state.highWaterMark);
			} catch (error) {
				stream.destroy(error);
				return;
			}
			// a synchronous push that filled nothing: wait for the next push
			if (state.length > before && state.length < state.highWaterMark && !state.flowing)
				maybeRead(stream);
		}
	});
}

function scheduleFlow(stream) {
	const state = stream._readableState;
	if (state.flowScheduled) return;
	state.flowScheduled = true;
	nextTick(() => {
		state.flowScheduled = false;
		flow(stream);
	});
}

// flowing mode: 'data' for each buffered chunk, then more asked for, or the end
function flow(stream) {
	const state = stream._readableState;
	while (state.flowing && state.buffer.length > 0 && !state.destroyed) {
		const chunk = state.buffer.shift();
		state.length -= state.objectMode ? 1 : chunk.length;
		stream.emit('data', chunk);
	}
	if (!state.flowing || state.destroyed) return;
	if (state.ended) endIfDone(stream);
	else maybeRead(stream);
}

function emitReadable(stream) {
	const state = stream._readableState;
	if (state.emittedReadable) return;
	state.emittedReadable = true;
	nextTick(() => {
		state.emittedReadable = false;
		if (state.destroyed) return;
		if (state.length > 0 || state.ended) {
			state.needReadable = false;
			stream.emit('readable');
		}
		if (state.ended && state.length === 0) endIfDone(stream);
	});
}

// 'end' once everything pushed has been read, then (autoDestroy) 'close'
function endIfDone(stream) {
	const state = stream._readableState;
	if (state.endEmitted || state.endScheduled || !state.ended || state.length > 0) return;
	state.endScheduled = true;
	nextTick(() => {
		if (state.endEmitted || state.destroyed || state.length > 0) return;
		state.endEmitted = true;
		stream.emit('end');
		const writable = stream._writableState;
		if (writable !== undefined && !stream.allowHalfOpen && !writable.ending) stream.end();
		if (state.autoDestroy && (writable === undefined || writable.finished || writable.destroyed))
			stream.destroy();
	});
}

function readableIterator(stream, destroyOnReturn) {
	const chunks = [];
	let error = null;
	let done = false;
	let waiting = null;
	const wake = () => {
		if (waiting === null) return;
		const { resolve, reject } = waiting;
		waiting = null;
		if (chunks.length > 0) resolve({ value: chunks.shift(), done: false });
		else if (error !== null) reject(error);
		else if (done) resolve({ value: undefined, done: true });
		else waiting = { resolve, reject };
	};
	const onData = (chunk) => {
		chunks.push(chunk);
		stream.pause();
		wake();
	};
	const onEnd = () => {
		done = true;
		wake();
	};
	const onError = (e) => {
		error = e;
		wake();
	};
	const onClose = () => {
		if (!done && error === null && !stream._readableState.endEmitted)
			error = codeError(Error, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
		done = true;
		wake();
	};
	stream.on('data', onData);
	stream.on('end', onEnd);
	stream.on('error', onError);
	stream.on('close', onClose);
	const cleanup = () => {
		stream.off('data', onData);
		stream.off('end', onEnd);
		stream.off('error', onError);
		stream.off('close', onClose);
	};
	return {
		next() {
			if (chunks.length > 0) {
				const value = chunks.shift();
				if (chunks.length === 0 && !done) stream.resume();
				return Promise.resolve({ value, done: false });
			}
			if (error !== null) {
				const e = error;
				cleanup();
				return Promise.reject(e);
			}
			if (done) {
				cleanup();
				return Promise.resolve({ value: undefined, done: true });
			}
			stream.resume();
			return new Promise((resolve, reject) => {
				waiting = { resolve, reject };
			});
		},
		return() {
			cleanup();
			if (destroyOnReturn && !stream.destroyed) stream.destroy();
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]() {
			return this;
		}
	};
}

// destroy(): once; _destroy, then 'error' (if any) and 'close', a turn later
function destroyStream(stream, error, callback) {
	const readable = stream._readableState;
	const writable = stream._writableState;
	const state = readable ?? writable;
	if (state.destroyed) {
		if (typeof callback === 'function') callback(state.errored);
		return stream;
	}
	for (const s of [readable, writable]) {
		if (s === undefined) continue;
		s.destroyed = true;
		if (error && !s.errored) s.errored = error;
	}
	stream._destroy(error ?? null, (err) => {
		if (err && !state.errored)
			for (const s of [readable, writable]) if (s !== undefined) s.errored = err;
		// end()'s callbacks, with the error (or a premature close) that ends the stream
		if (writable !== undefined && !writable.finished)
			for (const onFinished of writable.onFinished.splice(0))
				nextTick(
					onFinished,
					err ?? codeError(Error, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close')
				);
		if (typeof callback === 'function') callback(err);
		nextTick(() => {
			if (err && !(writable?.errorEmitted || readable?.errorEmitted)) {
				if (readable !== undefined) readable.errorEmitted = true;
				if (writable !== undefined) writable.errorEmitted = true;
				stream.emit('error', err);
			}
			for (const s of [readable, writable]) if (s !== undefined) s.closed = true;
			if (state.emitClose) stream.emit('close');
		});
	});
	return stream;
}

// ---- Writable ----

function writableState(stream, options, isDuplex) {
	const objectMode = !!(options.objectMode || (isDuplex && options.writableObjectMode));
	return {
		objectMode,
		highWaterMark:
			options.writableHighWaterMark ?? options.highWaterMark ?? getDefaultHighWaterMark(objectMode),
		decodeStrings: options.decodeStrings !== false,
		defaultEncoding: options.defaultEncoding ?? 'utf8',
		buffer: [],
		length: 0,
		writing: false,
		corked: 0,
		needDrain: false,
		ending: false,
		ended: false,
		finalCalled: false,
		prefinished: false,
		finished: false,
		destroyed: false,
		errored: null,
		closed: false,
		autoDestroy: options.autoDestroy ?? true,
		emitClose: options.emitClose ?? true,
		pendingCallbacks: 0,
		onFinished: []
	};
}

function initWritable(stream, options) {
	if (typeof options.write === 'function') stream._write = options.write;
	if (typeof options.writev === 'function') stream._writev = options.writev;
	if (typeof options.final === 'function') stream._final = options.final;
	if (typeof options.destroy === 'function') stream._destroy = options.destroy;
}

/** A destination for data: each write goes to _write, one at a time, the rest buffered. */
export class Writable extends Stream {
	constructor(options = {}) {
		super(options);
		this._writableState = writableState(this, options, false);
		initWritable(this, options);
		if (options.signal !== undefined) addAbortSignal(options.signal, this);
	}
}

const writableMethods = {
	/**
	 * Writes chunk (a string in encoding, or bytes; any value in object mode). False when the
	 * buffer is at its highWaterMark: wait for 'drain'.
	 */
	write(chunk, encoding, callback) {
		const state = this._writableState;
		if (typeof encoding === 'function') {
			callback = encoding;
			encoding = undefined;
		}
		encoding ??= state.defaultEncoding;
		if (chunk === null)
			throw codeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
		if (!state.objectMode) {
			if (typeof chunk === 'string') {
				if (state.decodeStrings) chunk = Buffer.from(chunk, encoding);
			} else if (ArrayBuffer.isView(chunk)) {
				chunk = chunkBuffer(chunk);
				encoding = 'buffer';
			} else throw invalidChunk(chunk);
			if (chunk instanceof Buffer) encoding = 'buffer';
		}
		let error = null;
		if (state.ending) error = codeError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
		else if (state.destroyed)
			error = codeError(
				Error,
				'ERR_STREAM_DESTROYED',
				'Cannot call write after a stream was destroyed'
			);
		if (error !== null) {
			nextTick(() => {
				if (typeof callback === 'function') callback(error);
			});
			if (!state.destroyed) this.destroy(error);
			return false;
		}
		const size = state.objectMode ? 1 : chunk.length;
		state.length += size;
		const ok = state.length < state.highWaterMark;
		if (!ok) state.needDrain = true;
		const request = { chunk, encoding, callback, size };
		state.pendingCallbacks++;
		if (state.writing || state.corked > 0 || state.constructing) state.buffer.push(request);
		else doWrite(this, request);
		return ok;
	},

	/** Ends the stream after writing chunk (if any); callback on 'finish' (or an error). */
	end(chunk, encoding, callback) {
		const state = this._writableState;
		if (typeof chunk === 'function') {
			callback = chunk;
			chunk = undefined;
		} else if (typeof encoding === 'function') {
			callback = encoding;
			encoding = undefined;
		}
		if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
		if (state.corked > 0) {
			state.corked = 1;
			this.uncork();
		}
		if (typeof callback === 'function') {
			if (state.finished) nextTick(callback);
			else if (state.errored) nextTick(callback, state.errored);
			// called before the 'finish' listeners, as Node does (or with the error that ends it)
			else state.onFinished.push(callback);
		}
		if (!state.ending) {
			state.ending = true;
			finishMaybe(this);
			state.ended = true;
		}
		return this;
	},

	/** Holds writes in the buffer until uncork(). */
	cork() {
		this._writableState.corked++;
	},

	uncork() {
		const state = this._writableState;
		if (state.corked === 0) return;
		state.corked--;
		if (state.corked === 0 && !state.writing) clearBuffer(this);
	},

	setDefaultEncoding(encoding) {
		this._writableState.defaultEncoding = encoding;
		return this;
	},

	_write(chunk, encoding, callback) {
		if (typeof this._writev === 'function') this._writev([{ chunk, encoding }], callback);
		else
			throw codeError(
				Error,
				'ERR_METHOD_NOT_IMPLEMENTED',
				'The _write() method is not implemented'
			);
	},

	destroy(error, callback) {
		return destroyStream(this, error, callback);
	},

	_destroy(error, callback) {
		callback(error);
	}
};

const writableGetters = {
	writable() {
		const state = this._writableState;
		return !state.destroyed && !state.errored && !state.ending;
	},
	writableEnded() {
		return this._writableState.ending;
	},
	writableFinished() {
		return this._writableState.finished;
	},
	writableLength() {
		return this._writableState.length;
	},
	writableNeedDrain() {
		return this._writableState.needDrain;
	},
	writableObjectMode() {
		return this._writableState.objectMode;
	},
	writableHighWaterMark() {
		return this._writableState.highWaterMark;
	},
	writableCorked() {
		return this._writableState.corked;
	},
	destroyed() {
		return this._writableState.destroyed;
	},
	closed() {
		return this._writableState.closed;
	},
	errored() {
		return this._writableState.errored;
	}
};

for (const name of Object.keys(writableMethods))
	Object.defineProperty(Writable.prototype, name, {
		value: writableMethods[name],
		writable: true,
		configurable: true
	});
for (const name of Object.keys(writableGetters))
	Object.defineProperty(Writable.prototype, name, {
		get: writableGetters[name],
		configurable: true
	});

function doWrite(stream, request) {
	const state = stream._writableState;
	state.writing = true;
	let sync = true;
	const onwrite = (error) => {
		const finish = () => afterWrite(stream, request, error);
		if (sync) nextTick(finish);
		else finish();
	};
	try {
		stream._write(request.chunk, request.encoding, onwrite);
	} catch (error) {
		onwrite(error);
	}
	sync = false;
}

function afterWrite(stream, request, error) {
	const state = stream._writableState;
	state.writing = false;
	state.length -= request.size;
	state.pendingCallbacks--;
	if (error) {
		if (typeof request.callback === 'function') request.callback(error);
		// the buffered writes fail too
		for (const queued of state.buffer.splice(0)) {
			state.pendingCallbacks--;
			if (typeof queued.callback === 'function') queued.callback(error);
		}
		stream.destroy(error);
		return;
	}
	if (typeof request.callback === 'function') request.callback(null);
	if (state.buffer.length > 0 && state.corked === 0) {
		clearBuffer(stream);
		return;
	}
	if (state.needDrain && state.length === 0 && !state.ending && !state.destroyed) {
		state.needDrain = false;
		stream.emit('drain');
	}
	finishMaybe(stream);
}

function clearBuffer(stream) {
	const state = stream._writableState;
	if (state.buffer.length > 0) doWrite(stream, state.buffer.shift());
	else finishMaybe(stream);
}

// once ended and every write done: _final, then 'finish' (and, autoDestroy, 'close')
function finishMaybe(stream) {
	const state = stream._writableState;
	if (
		!state.ending ||
		state.finished ||
		state.writing ||
		state.buffer.length > 0 ||
		state.destroyed
	)
		return;
	if (state.pendingCallbacks > 0) return;
	if (!state.finalCalled) {
		state.finalCalled = true;
		const done = (error) => {
			if (error) {
				stream.destroy(error);
				return;
			}
			state.prefinished = true;
			stream.emit('prefinish');
			nextTick(() => {
				if (state.finished || state.destroyed) return;
				state.finished = true;
				for (const callback of state.onFinished.splice(0)) callback();
				stream.emit('finish');
				const readable = stream._readableState;
				if (
					state.autoDestroy &&
					(readable === undefined || readable.endEmitted || readable.destroyed)
				)
					stream.destroy();
			});
		};
		if (typeof stream._final === 'function') {
			state.pendingCallbacks++;
			nextTick(() => {
				try {
					stream._final((error) => {
						state.pendingCallbacks--;
						done(error);
					});
				} catch (error) {
					state.pendingCallbacks--;
					done(error);
				}
			});
		} else done(null);
	}
}

Writable.toWeb = (writable) =>
	new WritableStream({
		write(chunk) {
			return new Promise((resolve, reject) => {
				writable.write(chunk, (error) => (error ? reject(error) : resolve()));
			});
		},
		close() {
			return new Promise((resolve, reject) => {
				writable.end((error) => (error ? reject(error) : resolve()));
			});
		},
		abort(reason) {
			writable.destroy(reason);
		}
	});

Writable.fromWeb = (stream, options = {}) => {
	const writer = stream.getWriter();
	return new Writable({
		...options,
		write(chunk, encoding, callback) {
			writer.write(chunk).then(() => callback(), callback);
		},
		final(callback) {
			writer.close().then(() => callback(), callback);
		},
		destroy(error, callback) {
			writer.abort(error).then(
				() => callback(error),
				() => callback(error)
			);
		}
	});
};

// ---- Duplex, Transform, PassThrough ----

/** Readable and Writable in one: its two sides independent (allowHalfOpen) unless told not. */
export class Duplex extends Readable {
	constructor(options = {}) {
		super({ ...options, signal: undefined });
		this._writableState = writableState(this, options, true);
		// a duplex's two sides: its readable side's options are its own
		if (options.readableObjectMode) this._readableState.objectMode = true;
		if (options.readableHighWaterMark === undefined && options.highWaterMark === undefined)
			this._readableState.highWaterMark = getDefaultHighWaterMark(this._readableState.objectMode);
		initWritable(this, options);
		this.allowHalfOpen = options.allowHalfOpen !== false;
		if (options.readable === false) {
			this._readableState.ended = true;
			this._readableState.endEmitted = true;
		}
		if (options.writable === false) {
			this._writableState.ending = true;
			this._writableState.ended = true;
			this._writableState.finished = true;
		}
		if (options.signal !== undefined) addAbortSignal(options.signal, this);
	}

	/** A Duplex of a pair: { readable, writable } streams, or an async generator function. */
	static from(source) {
		if (source instanceof Duplex) return source;
		if (source?.readable !== undefined || source?.writable !== undefined) {
			const { readable, writable } = source;
			const duplex = new Duplex({
				objectMode: true,
				read() {
					readable?.resume();
				},
				write(chunk, encoding, callback) {
					if (writable.write(chunk, encoding) === false) writable.once('drain', callback);
					else callback();
				},
				final(callback) {
					writable.end();
					writable.once('finish', () => callback());
				}
			});
			readable?.on('data', (chunk) => {
				if (!duplex.push(chunk)) readable.pause();
			});
			readable?.once('end', () => duplex.push(null));
			return duplex;
		}
		return Readable.from(source);
	}
}

for (const name of Object.keys(writableMethods)) {
	if (name === 'destroy' || name === '_destroy') continue;
	Object.defineProperty(Duplex.prototype, name, {
		value: writableMethods[name],
		writable: true,
		configurable: true
	});
}
for (const name of Object.keys(writableGetters)) {
	if (name === 'destroyed' || name === 'closed' || name === 'errored') continue;
	Object.defineProperty(Duplex.prototype, name, { get: writableGetters[name], configurable: true });
}

/**
 * A Duplex whose output is its input transformed: transform(chunk, encoding, callback) pushes
 * (or passes callback(null, data)), flush(callback) the rest at the end.
 */
export class Transform extends Duplex {
	constructor(options = {}) {
		super(options);
		if (typeof options.transform === 'function') this._transform = options.transform;
		if (typeof options.flush === 'function') this._flush = options.flush;
		this._readableState.sync = false;
		this._transformCallback = null;
	}

	_transform() {
		throw codeError(
			Error,
			'ERR_METHOD_NOT_IMPLEMENTED',
			'The _transform() method is not implemented'
		);
	}

	_write(chunk, encoding, callback) {
		const readable = this._readableState;
		this._transform(chunk, encoding, (error, data) => {
			if (error) {
				callback(error);
				return;
			}
			if (data !== undefined && data !== null) this.push(data);
			// the readable side full: the next write waits until it is read
			if (readable.length < readable.highWaterMark || readable.flowing) callback();
			else this._transformCallback = callback;
		});
	}

	_read() {
		const callback = this._transformCallback;
		if (callback !== null) {
			this._transformCallback = null;
			callback();
		}
	}

	_final(callback) {
		const done = (error, data) => {
			if (error) {
				callback(error);
				return;
			}
			if (data !== undefined && data !== null) this.push(data);
			this.push(null);
			callback();
		};
		if (typeof this._flush === 'function') this._flush(done);
		else done(null);
	}
}

/** A Transform that passes each chunk on as it is. */
export class PassThrough extends Transform {
	constructor(options) {
		super(options);
	}

	_transform(chunk, encoding, callback) {
		callback(null, chunk);
	}
}

// ---- finished, pipeline, addAbortSignal ----

const isReadableStream = (stream) => stream?._readableState !== undefined;
const isWritableStream = (stream) => stream?._writableState !== undefined;

/**
 * Calls callback once stream is done: ended and finished (as far as it reads and writes),
 * callback(error) on its error or a close before that. Returns a function that stops watching.
 */
export function finished(stream, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}
	const readable = options.readable ?? isReadableStream(stream);
	const writable = options.writable ?? isWritableStream(stream);
	let ended = !readable || stream._readableState?.endEmitted;
	let finishedWriting = !writable || stream._writableState?.finished;
	let called = false;
	const done = (error) => {
		if (called) return;
		called = true;
		cleanup();
		callback.call(stream, error);
	};
	const onEnd = () => {
		ended = true;
		if (finishedWriting) done();
	};
	const onFinish = () => {
		finishedWriting = true;
		if (ended) done();
	};
	const onError = (error) => {
		if (options.error !== false) done(error);
	};
	const onClose = () => {
		if (ended && finishedWriting) done();
		else {
			const errored = stream._readableState?.errored ?? stream._writableState?.errored;
			done(errored ?? codeError(Error, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close'));
		}
	};
	const cleanup = () => {
		stream.off('end', onEnd);
		stream.off('finish', onFinish);
		stream.off('error', onError);
		stream.off('close', onClose);
	};
	stream.on('end', onEnd);
	stream.on('finish', onFinish);
	stream.on('error', onError);
	stream.on('close', onClose);
	const state = stream._readableState ?? stream._writableState;
	if (state?.errored) nextTick(() => done(state.errored));
	else if (state?.closed) nextTick(onClose);
	else if (ended && finishedWriting) nextTick(() => done());
	return cleanup;
}

// a stage of pipeline: a stream as it is; an iterable (first) or a function of the previous
// stage (an async generator function, say) as a Readable of what it yields
const pipelineStage = (stage, previous, isLast) => {
	if (typeof stage === 'function') {
		const result = stage(previous);
		if (isLast && typeof result?.then === 'function') return { promise: result };
		return Readable.from(result);
	}
	if (
		stage?.on === undefined &&
		stage !== null &&
		typeof stage === 'object' &&
		(stage[Symbol.asyncIterator] || stage[Symbol.iterator] || typeof stage.next === 'function')
	)
		return Readable.from(stage);
	return stage;
};

/**
 * Pipes each stream into the next, and calls callback once the last is done (or with the first
 * error: every stream is destroyed then). Stages may be iterables and async generator functions.
 * @returns the last stream
 */
export function pipeline(...streams) {
	const callback = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
	if (streams.length === 1 && Array.isArray(streams[0])) streams = streams[0];
	if (streams.length < 2)
		throw codeError(TypeError, 'ERR_MISSING_ARGS', 'The "streams" argument must be specified');
	let called = false;
	const done = (error, value) => {
		if (called) return;
		called = true;
		if (error)
			for (const stream of stages)
				if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy(error);
		if (callback !== null) callback(error ?? undefined, value);
	};
	const stages = [];
	let previous = null;
	for (let i = 0; i < streams.length; i++) {
		const stage = pipelineStage(streams[i], previous, i === streams.length - 1);
		if (stage?.promise !== undefined) {
			stage.promise.then(
				(value) => done(undefined, value),
				(error) => done(error)
			);
			return previous;
		}
		stages.push(stage);
		if (previous !== null && typeof streams[i] !== 'function') previous.pipe(stage);
		const isLast = i === streams.length - 1;
		finished(stage, { readable: isLast ? undefined : false }, (error) => {
			if (error) done(error);
			else if (isLast) done();
		});
		previous = stage;
	}
	return previous;
}

/** Destroys stream (with an AbortError) when signal aborts. */
export function addAbortSignal(signal, stream) {
	const onAbort = () => {
		const e = new Error('The operation was aborted');
		e.name = 'AbortError';
		e.code = 'ABORT_ERR';
		e.cause = signal.reason;
		stream.destroy(e);
	};
	if (signal.aborted) nextTick(onAbort);
	else signal.addEventListener('abort', onAbort, { once: true });
	return stream;
}

/** Whether stream can still be read from. */
export const isReadable = (stream) => stream?.readable === true;
/** Whether stream can still be written to. */
export const isWritable = (stream) => stream?.writable === true;
/** Whether stream was destroyed with an error. */
export const isErrored = (stream) =>
	!!(stream?._readableState?.errored ?? stream?._writableState?.errored);
/** Whether stream is ended or destroyed. */
export const isDisturbed = (stream) => !!(stream?._readableState?.endEmitted || stream?.destroyed);

// ---- stream/promises ----

/**
 * Pipes each stream into the next; a promise of the end (rejected with the first error).
 * An options object last ({ signal, end }) is taken off the streams.
 */
function pipelinePromise(...streams) {
	const last = streams[streams.length - 1];
	let signal;
	if (
		last !== null &&
		typeof last === 'object' &&
		typeof last.on !== 'function' &&
		!last[Symbol.asyncIterator] &&
		!last[Symbol.iterator] &&
		!Array.isArray(last)
	) {
		signal = streams.pop().signal;
	}
	return new Promise((resolve, reject) => {
		const tail = pipeline(...streams, (error, value) => (error ? reject(error) : resolve(value)));
		signal?.addEventListener(
			'abort',
			() => {
				const e = new Error('The operation was aborted');
				e.name = 'AbortError';
				e.code = 'ABORT_ERR';
				tail?.destroy?.(e);
			},
			{ once: true }
		);
	});
}

/** A promise that stream is done (rejected with its error, or a premature close). */
function finishedPromise(stream, options = {}) {
	return new Promise((resolve, reject) => {
		finished(stream, options, (error) => (error ? reject(error) : resolve()));
	});
}

/** node:stream/promises: pipeline and finished as promises. */
export const promises = { pipeline: pipelinePromise, finished: finishedPromise };

Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.addAbortSignal = addAbortSignal;
Stream.promises = promises;
Stream.isReadable = isReadable;
Stream.isWritable = isWritable;
Stream.isErrored = isErrored;
Stream.isDisturbed = isDisturbed;
Stream.getDefaultHighWaterMark = getDefaultHighWaterMark;
Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;

export default Stream;
