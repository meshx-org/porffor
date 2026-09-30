// Async iteration of ReadableStream and ReadableStream.from (the Streams standard's
// ReadableStream async iterator and ReadableStreamFromIterable): `for await (const chunk of
// stream)`, stream.values({ preventCancel }), and a stream made from an async iterable or an
// iterable. Its own provider (runtime/globals.json), loaded for a program that iterates
// asynchronously and may have a stream (load: for await, Symbol.asyncIterator, values(),
// ReadableStream.from), which it plugs into ReadableStream; others do not carry it.

import { ReadableStream, createReadable } from './readable-stream.mjs';
import { ReadableStreamDefaultReader } from './readable-stream-reader.mjs';
import {
	byteStreams,
	canCloseOrEnqueue,
	cancel,
	enqueue,
	readRequest,
	release,
	requestClose
} from './stream-internals.mjs';
import { react, resolvedWith } from './stream-queue.mjs';

/**
 * The async iterator's prototype (next and return), whose own prototype is
 * %AsyncIteratorPrototype% where the engine lets it be found.
 */
const iteratorPrototype = {
	next() {
		const next = () => iteratorNext(this);

		this._ongoing = this._ongoing === undefined ? next() : react(this._ongoing, next, next);

		return this._ongoing;
	},
	return(value) {
		const steps = () => iteratorReturn(this, value);
		const returned = this._ongoing === undefined ? steps() : react(this._ongoing, steps, steps);

		// a next() or return() after this one waits for it
		this._ongoing = returned;

		return react(returned, () => ({ value, done: true }));
	}
};

/** %AsyncIteratorPrototype%, or null where the engine does not let it be found. */
function asyncIteratorPrototype() {
	try {
		const generator = Object.getPrototypeOf(async function* () {});
		const base = generator === null ? null : Object.getPrototypeOf(generator.prototype);

		return base !== null && typeof base === 'object' ? base : null;
	} catch {
		return null;
	}
}

const baseIterator = asyncIteratorPrototype();

// without %AsyncIteratorPrototype% the iterator is its own async iterable, as it would inherit
if (baseIterator === null)
	Object.defineProperty(iteratorPrototype, Symbol.asyncIterator, {
		value() {
			return this;
		},
		writable: true,
		configurable: true
	});
else Object.setPrototypeOf(iteratorPrototype, baseIterator);

/** A new async iterator over `stream`, which it locks (its reader's reads are its steps). */
function asyncIterator(stream, preventCancel) {
	const iterator = Object.create(iteratorPrototype);

	iterator._reader = new ReadableStreamDefaultReader(stream);
	iterator._preventCancel = preventCancel;
	iterator._finished = false;
	iterator._ongoing = undefined;

	return iterator;
}

/** The next step: the next chunk, or the end (the reader released) once closed or errored. */
function iteratorNext(iterator) {
	if (iterator._finished) {
		iterator._ongoing = undefined;

		return Promise.resolve({ value: undefined, done: true });
	}
	const reader = iterator._reader;

	const read = new Promise((resolve, reject) => {
		readRequest(reader._stream, {
			resolve({ value, done }) {
				if (done) release(reader);
				resolve({ value, done });
			},
			reject(reason) {
				release(reader);
				reject(reason);
			}
		});
	});

	return react(
		read,
		(result) => {
			iterator._ongoing = undefined;

			if (result.done) {
				iterator._finished = true;

				return { value: undefined, done: true };
			}

			return { value: result.value, done: false };
		},
		(reason) => {
			iterator._ongoing = undefined;
			iterator._finished = true;

			throw reason;
		}
	);
}

/** The return step: cancels the stream (unless preventCancel) and lets it go. */
function iteratorReturn(iterator, value) {
	if (iterator._finished) return Promise.resolve({ value, done: true });
	iterator._finished = true;
	const reader = iterator._reader;

	if (!iterator._preventCancel) {
		const cancelled = cancel(reader._stream, value);

		release(reader);

		return cancelled;
	}
	release(reader);

	return Promise.resolve();
}

/** An iterator result's check: a TypeError for one that is not an object. */
function iteratorResult(result) {
	if (result === null || (typeof result !== 'object' && typeof result !== 'function'))
		throw new TypeError('ReadableStream.from: the iterator result is not an object');

	return result;
}

/**
 * GetIterator(obj, async): its async iterator, or its sync iterator seen as an async one
 * (CreateAsyncFromSyncIterator: each value awaited), as { iterator, next }.
 */
function asyncIteratorRecord(iterable) {
	if (iterable === null || (typeof iterable !== 'object' && typeof iterable !== 'function'))
		throw new TypeError('ReadableStream.from: the argument is not an object');
	const asyncMethod = iterable[Symbol.asyncIterator];

	if (asyncMethod !== undefined && asyncMethod !== null) {
		const iterator = Reflect.apply(asyncMethod, iterable, []);

		if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function'))
			throw new TypeError('ReadableStream.from: the async iterator is not an object');

		return { iterator, next: iterator.next, sync: false };
	}
	const method = iterable[Symbol.iterator];

	if (method === undefined || method === null)
		throw new TypeError('ReadableStream.from: the argument is not iterable');
	const iterator = Reflect.apply(method, iterable, []);

	if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function'))
		throw new TypeError('ReadableStream.from: the iterator is not an object');

	return { iterator, next: iterator.next, sync: true };
}

/** A sync iterator's step seen as an async one: the value awaited (the iterator closed if it rejects). */
function syncStep(record, result) {
	const done = Boolean(result.done);

	return react(
		resolvedWith(result.value),
		(value) => ({ value, done }),
		(reason) => {
			if (!done) {
				const close = record.iterator.return;

				if (close !== undefined && close !== null) Reflect.apply(close, record.iterator, []);
			}

			throw reason;
		}
	);
}

/** ReadableStreamFromIterable: a stream pulling from the iterator, returning it on cancel. */
function fromIterable(iterable) {
	const record = asyncIteratorRecord(iterable);
	let stream;
	const pull = () => {
		let next;

		try {
			const result = Reflect.apply(record.next, record.iterator, []);

			next = record.sync ? syncStep(record, iteratorResult(result)) : resolvedWith(result);
		} catch (reason) {
			return Promise.reject(reason);
		}

		return react(next, (result) => {
			iteratorResult(result);

			if (result.done) {
				if (canCloseOrEnqueue(stream)) requestClose(stream);
			} else if (canCloseOrEnqueue(stream)) enqueue(stream, result.value);
		});
	};
	const cancelIterator = (reason) => {
		let returned;

		try {
			const method = record.iterator.return;

			if (method === undefined || method === null) return Promise.resolve();
			returned = Reflect.apply(method, record.iterator, [reason]);

			if (record.sync) returned = syncStep(record, iteratorResult(returned));
		} catch (reason_) {
			return Promise.reject(reason_);
		}

		return react(resolvedWith(returned), (result) => {
			iteratorResult(result);
		});
	};

	stream = createReadable(
		{ source: undefined, start: undefined, pull, cancel: cancelIterator },
		0,
		undefined
	);

	return stream;
}

byteStreams.iterate = asyncIterator;
byteStreams.from = fromIterable;
// `for await (const chunk of stream)`: the same function as values(), as WebIDL has it
Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
	value: ReadableStream.prototype.values,
	writable: true,
	configurable: true
});
