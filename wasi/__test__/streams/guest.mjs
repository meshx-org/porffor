// The streams fixture: ReadableStream / WritableStream / TransformStream, pipeTo and
// pipeThrough, the text streams, backpressure, errors and aborts across a pipe.

const sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** A ReadableStream of the given chunks, pulled one at a time. */
function from(chunks) {
	const queue = chunks.slice();

	return new ReadableStream({
		pull(controller) {
			if (queue.length === 0) controller.close();
			else controller.enqueue(queue.shift());
		}
	});
}

/** Reads a stream to its end: its chunks. */
async function collect(stream) {
	const reader = stream.getReader();
	const out = [];

	while (true) {
		const { value, done } = await reader.read();

		if (done) return out;
		out.push(value);
	}
}

const errorName = (error) => (error?.name === undefined ? String(error) : error.name);

export async function run() {
	const out = {};
	const bytes = new TextEncoder().encode('é⌘ line one\nline two\nthree');

	// bytes, split mid-character, through a decoder, a line splitter and an uppercaser
	let rest = '';
	const lines = new TransformStream({
		transform(chunk, controller) {
			const parts = (rest + chunk).split('\n');

			rest = parts.pop();

			for (const part of parts) controller.enqueue(part);
		},
		flush(controller) {
			if (rest !== '') controller.enqueue(rest);
		}
	});
	const upper = new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(chunk.toUpperCase());
		}
	});

	out.lines = (
		await collect(
			from([bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5)])
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(lines)
				.pipeThrough(upper)
		)
	).join('|');

	// the other way: strings with a surrogate pair split across chunks, to bytes and back
	out.roundTrip = (
		await collect(
			from(['a\uD83D', '\uDE42b'])
				.pipeThrough(new TextEncoderStream())
				.pipeThrough(new TextDecoderStream())
		)
	).join('');

	// pipeTo a slow sink: the source is pulled only as the sink keeps up
	let pulled = 0;
	let written = 0;
	let ahead = 0;
	const source = new ReadableStream({
		pull(controller) {
			if (pulled === 10) {
				controller.close();

				return;
			}
			pulled++;
			ahead = Math.max(ahead, pulled - written);
			controller.enqueue(pulled);
		}
	});
	const got = [];

	await source.pipeTo(
		new WritableStream({
			async write(chunk) {
				await sleep(5);
				got.push(chunk);
				written++;
			}
		})
	);
	out.piped = got.join(',');
	out.ahead = ahead;

	// the writer: backpressure, close, a write after close
	const sunk = [];
	let closedSink = false;
	const writable = new WritableStream(
		{
			async write(chunk) {
				await sleep(2);
				sunk.push(chunk);
			},
			close() {
				closedSink = true;
			}
		},
		{ highWaterMark: 2 }
	);
	const writer = writable.getWriter();
	const sizes = [writer.desiredSize];

	writer.write('a');
	sizes.push(writer.desiredSize);
	writer.write('b');
	sizes.push(writer.desiredSize);
	await writer.ready;
	await writer.close();
	await writer.closed;
	let afterClose = 'none';

	try {
		await writer.write('c');
	} catch (error) {
		afterClose = errorName(error);
	}
	out.writer = { sunk: sunk.join(''), sizes: sizes.join(','), closedSink, afterClose };

	// a source that fails: pipeTo rejects with its error and aborts the destination
	let abortedWith = 'none';
	let pipeError = 'none';
	const failing = new ReadableStream({
		pull(controller) {
			controller.error(new RangeError('source broke'));
		}
	});

	try {
		await failing.pipeTo(
			new WritableStream({
				abort(reason) {
					abortedWith = reason.message;
				}
			})
		);
	} catch (error) {
		pipeError = error.message;
	}
	out.failing = { pipeError, abortedWith };

	// an AbortSignal stops a pipe: it rejects with the reason, the source is cancelled
	let cancelledWith = 'none';
	const endless = new ReadableStream({
		async pull(controller) {
			await sleep(5);
			controller.enqueue('tick');
		},
		cancel(reason) {
			cancelledWith = errorName(reason);
		}
	});
	let signalled = 'none';

	try {
		await endless.pipeTo(new WritableStream(), { signal: AbortSignal.timeout(40) });
	} catch (error) {
		signalled = errorName(error);
	}
	out.signal = { signalled, cancelledWith };

	return JSON.stringify(out);
}
