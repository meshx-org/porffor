// The state machine behind WritableStream and its writer (a plain-JS subset of the
// Streams standard): writes queue and go to the underlying sink one at a time, a close
// waits behind them, and the writer's ready reports backpressure against the high-water
// mark. Fields live on the stream object (_state, _queue, …); these functions are the
// only ones that change them.

import { deferred } from './stream-internals.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** A settled-or-pending promise nobody is obliged to handle (ready, closed). */
function quiet(entry) {
	entry.promise.then(ignore, ignore);

	return entry;
}

/** Sets up `stream`'s fields and starts its sink. */
export function setUpWritable(stream, sink, highWaterMark) {
	stream._sink = sink;
	stream._hwm = highWaterMark;
	stream._queue = []; // { chunk, done }
	stream._state = 'writable';
	stream._storedError = undefined;
	stream._started = false;
	stream._inFlight = false;
	stream._close = undefined; // the close request's deferred, once asked
	stream._writer = undefined;
	stream._ready = quiet(deferred());
	stream._ready.settled = true;
	stream._ready.resolve();
	stream._controller = {
		error(reason) {
			error(stream, reason);
		}
	};
	let started;

	try {
		started = typeof sink.start === 'function' ? sink.start(stream._controller) : undefined;
	} catch (reason) {
		error(stream, reason);

		return;
	}
	Promise.resolve(started).then(
		() => {
			stream._started = true;
			advance(stream);
		},
		(reason) => error(stream, reason)
	);
}

/** How many more chunks the queue wants before backpressure. */
export function desiredSize(stream) {
	if (stream._state === 'errored') return null;

	if (stream._state === 'closed') return 0;

	return stream._hwm - stream._queue.length - (stream._inFlight ? 1 : 0);
}

/** Keeps ready pending while the queue is full, resolved otherwise. */
function updateReady(stream) {
	if (stream._state !== 'writable' || stream._close !== undefined) return;
	const full = desiredSize(stream) <= 0;

	if (full && stream._ready.settled) stream._ready = quiet(deferred());
	else if (!full && !stream._ready.settled) {
		stream._ready.settled = true;
		stream._ready.resolve();
	}
}

/** Hands the next write, or the close, to the sink; one at a time. */
function advance(stream) {
	if (!stream._started || stream._inFlight || stream._state !== 'writable') return;

	if (stream._queue.length > 0) {
		const { chunk, done } = stream._queue.shift();

		stream._inFlight = true;
		let written;

		try {
			written = stream._sink.write?.(chunk, stream._controller);
		} catch (reason) {
			written = Promise.reject(reason);
		}
		Promise.resolve(written).then(
			() => {
				stream._inFlight = false;
				done.resolve();
				updateReady(stream);
				advance(stream);
			},
			(reason) => {
				stream._inFlight = false;
				done.reject(reason);
				error(stream, reason);
			}
		);

		return;
	}

	if (stream._close === undefined) return;
	stream._inFlight = true;
	let closed;

	try {
		closed = stream._sink.close?.();
	} catch (reason) {
		closed = Promise.reject(reason);
	}
	Promise.resolve(closed).then(
		() => {
			stream._inFlight = false;
			stream._state = 'closed';
			stream._close.resolve();

			if (stream._writer !== undefined) stream._writer._closed.resolve();
		},
		(reason) => {
			stream._inFlight = false;
			error(stream, reason);
		}
	);
}

/** Queues a chunk for the sink; resolves once the sink has taken it. */
export function write(stream, chunk) {
	if (stream._state === 'errored') return Promise.reject(stream._storedError);

	if (stream._state !== 'writable' || stream._close !== undefined)
		return Promise.reject(new TypeError('WritableStream: cannot write to a closing stream'));
	const done = deferred();

	stream._queue.push({ chunk, done });
	updateReady(stream);
	advance(stream);

	return done.promise;
}

/** Closes once the queued writes are done; resolves when the sink has closed. */
export function close(stream) {
	if (stream._state === 'errored') return Promise.reject(stream._storedError);

	if (stream._state !== 'writable' || stream._close !== undefined)
		return Promise.reject(new TypeError('WritableStream: already closing or closed'));
	stream._close = deferred();

	if (!stream._ready.settled) {
		stream._ready.settled = true;
		stream._ready.resolve();
	}
	advance(stream);

	return stream._close.promise;
}

/** Errored for good: queued writes, the close, the writer's ready and closed reject. */
export function error(stream, reason) {
	if (stream._state === 'errored' || stream._state === 'closed') return;
	stream._state = 'errored';
	stream._storedError = reason;
	const queue = stream._queue;

	stream._queue = [];

	for (const entry of queue) entry.done.reject(reason);
	stream._close?.reject(reason);

	if (stream._ready.settled) stream._ready = quiet(deferred());
	stream._ready.settled = true;
	stream._ready.reject(reason);

	if (stream._writer !== undefined) stream._writer._closed.reject(reason);
}

/** Aborts: queued writes are dropped, the sink hears why, the stream errors. */
export function abort(stream, reason) {
	if (stream._state === 'errored' || stream._state === 'closed') return Promise.resolve();
	error(stream, reason);
	let aborted;

	try {
		aborted = stream._sink.abort?.(reason);
	} catch (reason_) {
		return Promise.reject(reason_);
	}

	return Promise.resolve(aborted).then(ignore);
}
