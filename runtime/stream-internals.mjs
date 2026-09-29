// The state machine behind ReadableStream and its reader (a plain-JS subset of the
// Streams standard's abstract operations): a queue of chunks, the reads waiting for
// one, and pulling the underlying source when a read or the high-water mark wants more.
// Fields live on the stream object (_state, _queue, _reads, …); these functions are the
// only ones that change them.

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** A promise with its resolve and reject, for reads and the reader's closed. */
export function deferred() {
	const out = {};

	out.promise = new Promise((resolve, reject) => {
		out.resolve = resolve;
		out.reject = reject;
	});

	return out;
}

/** Sets up `stream`'s fields and starts its source. */
export function setUp(stream, source, highWaterMark) {
	stream._source = source;
	stream._hwm = highWaterMark;
	stream._queue = [];
	stream._reads = [];
	stream._state = 'readable';
	stream._storedError = undefined;
	stream._closeRequested = false;
	stream._started = false;
	stream._pulling = false;
	stream._pullAgain = false;
	stream._disturbed = false;
	stream._reader = undefined;
	stream._controller = {
		get desiredSize() {
			if (stream._state === 'errored') return null;

			return stream._state === 'closed' ? 0 : stream._hwm - stream._queue.length;
		},
		enqueue(chunk) {
			enqueue(stream, chunk);
		},
		close() {
			requestClose(stream);
		},
		error(reason) {
			error(stream, reason);
		}
	};
	let started;

	try {
		started = typeof source.start === 'function' ? source.start(stream._controller) : undefined;
	} catch (reason) {
		error(stream, reason);

		return;
	}
	Promise.resolve(started).then(
		() => {
			stream._started = true;
			pullIfNeeded(stream);
		},
		(reason) => error(stream, reason)
	);
}

function shouldPull(stream) {
	if (!stream._started || stream._state !== 'readable' || stream._closeRequested) return false;

	return stream._reads.length > 0 || stream._queue.length < stream._hwm;
}

/** Asks the source for more when something wants it; once at a time. */
export function pullIfNeeded(stream) {
	if (!shouldPull(stream)) return;

	if (stream._pulling) {
		stream._pullAgain = true;

		return;
	}

	if (typeof stream._source.pull !== 'function') return;
	stream._pulling = true;
	let pulled;

	// a throw is a rejected pull, as the spec wraps the algorithm in a promise: the stream
	// errors a microtask later, after a chunk this read already took out (tee's branches get it)
	try {
		pulled = stream._source.pull(stream._controller);
	} catch (reason) {
		pulled = Promise.reject(reason);
	}
	Promise.resolve(pulled).then(
		() => {
			stream._pulling = false;

			if (stream._pullAgain) {
				stream._pullAgain = false;
				pullIfNeeded(stream);
			}
		},
		(reason) => error(stream, reason)
	);
}

function enqueue(stream, chunk) {
	if (stream._closeRequested || stream._state !== 'readable')
		throw new TypeError('ReadableStream: cannot enqueue into a closed stream');

	if (stream._reads.length > 0) stream._reads.shift().resolve({ value: chunk, done: false });
	else stream._queue.push(chunk);
	pullIfNeeded(stream);
}

/** Closed for good: waiting reads end, the reader's closed resolves. */
function finishClose(stream) {
	stream._state = 'closed';
	const reads = stream._reads;

	stream._reads = [];

	for (const read of reads) read.resolve({ value: undefined, done: true });

	if (stream._reader !== undefined) stream._reader._closed.resolve();
}

function requestClose(stream) {
	if (stream._closeRequested || stream._state !== 'readable')
		throw new TypeError('ReadableStream: already closed');
	stream._closeRequested = true;

	if (stream._queue.length === 0) finishClose(stream);
}

/** Errored for good: the queue is dropped, waiting reads and the reader's closed reject. */
export function error(stream, reason) {
	if (stream._state !== 'readable') return;
	stream._state = 'errored';
	stream._storedError = reason;
	stream._queue = [];
	const reads = stream._reads;

	stream._reads = [];

	for (const read of reads) read.reject(reason);

	if (stream._reader !== undefined) stream._reader._closed.reject(reason);
}

/** A read: the next chunk, { done: true } once closed, or the stored error. */
export function read(stream) {
	stream._disturbed = true;

	if (stream._queue.length > 0) {
		const value = stream._queue.shift();

		if (stream._closeRequested && stream._queue.length === 0) finishClose(stream);
		else pullIfNeeded(stream);

		return Promise.resolve({ value, done: false });
	}

	if (stream._state === 'closed') return Promise.resolve({ value: undefined, done: true });

	if (stream._state === 'errored') return Promise.reject(stream._storedError);
	const waiting = deferred();

	stream._reads.push(waiting);
	pullIfNeeded(stream);

	return waiting.promise;
}

/** Cancels: the queue is dropped, the stream closes, and the source hears why. */
export function cancel(stream, reason) {
	stream._disturbed = true;

	if (stream._state === 'closed') return Promise.resolve();

	if (stream._state === 'errored') return Promise.reject(stream._storedError);
	stream._queue = [];
	finishClose(stream);
	let cancelled;

	try {
		cancelled =
			typeof stream._source.cancel === 'function' ? stream._source.cancel(reason) : undefined;
	} catch (reason_) {
		return Promise.reject(reason_);
	}

	return Promise.resolve(cancelled).then(ignore);
}

/** Lets go of the stream: waiting reads reject, and another reader may take it. */
export function release(reader) {
	const stream = reader._stream;

	if (stream === undefined) return;
	const released = new TypeError('ReadableStreamDefaultReader: the reader was released');
	const reads = stream._reads;

	stream._reads = [];

	for (const waiting of reads) waiting.reject(released);

	if (stream._state === 'readable') reader._closed.reject(released);
	stream._reader = undefined;
	reader._stream = undefined;
}
