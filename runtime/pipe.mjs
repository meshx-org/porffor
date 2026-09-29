// pipeTo for ReadableStream: reads the source and writes the destination with
// backpressure (the next read waits for the writer's ready), then closes, aborts or
// cancels across as the Streams standard says, with the preventClose / preventAbort /
// preventCancel options and an AbortSignal.

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/**
 * Pipes `source` into `destination`; resolves once everything is written and closed.
 * @param {ReadableStream} source
 * @param {WritableStream} destination
 * @param {{ preventClose?, preventAbort?, preventCancel?, signal? }} options
 */
export async function pipe(source, destination, options) {
	if (source.locked) throw new TypeError('ReadableStream.pipeTo: the source is locked');

	if (destination.locked) throw new TypeError('ReadableStream.pipeTo: the destination is locked');
	const { preventClose, preventAbort, preventCancel, signal } = options;

	signal?.throwIfAborted();
	const reader = source.getReader();
	const writer = destination.getWriter();

	// disturbed from here on, before anything is read (a Response's bodyUsed turns true now)
	source._disturbed = true;
	let abortedBy;
	const onAbort = () => {
		abortedBy = signal.reason;

		if (!preventAbort) writer.abort(abortedBy).then(ignore, ignore);

		if (!preventCancel) reader.cancel(abortedBy).then(ignore, ignore);
	};

	signal?.addEventListener('abort', onAbort);

	try {
		while (true) {
			await writer.ready;
			const { value, done } = await reader.read();

			if (abortedBy !== undefined) throw abortedBy;

			if (done) {
				if (!preventClose) await writer.close();

				return;
			}
			// not awaited: the next ready is the backpressure
			writer.write(value).then(ignore, ignore);
		}
	} catch (error) {
		if (abortedBy === undefined) {
			// the source failed: abort the destination; the destination failed: cancel the source
			if (source._state === 'errored') {
				if (!preventAbort) await writer.abort(error).then(ignore, ignore);
			} else if (!preventCancel) await reader.cancel(error).then(ignore, ignore);
		}
		throw error;
	} finally {
		signal?.removeEventListener('abort', onAbort);
		reader.releaseLock();
		writer.releaseLock();
	}
}
