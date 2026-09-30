// Bodies over wasi:http 0.3, for the client (./http.mjs, porffor:http) and the server
// (./http-server.mjs): an incoming body's stream<u8> as a ReadableStream, and an outgoing
// body (bytes or a ReadableStream) written into one. Every wait on the host is a promise
// the glue's event loop settles; given a signal, that wait is cancelled when it aborts.

import {
	stream_u8_read,
	stream_u8_write,
	stream_u8_drop_readable,
	stream_u8_drop_writable,
	future_result_void_error_code_write,
	future_result_option_own_trailers_error_code_read,
	future_result_option_own_trailers_error_code_drop_readable,
	rtCancel,
	rtLastToken
} from 'rt-async';
import { ReadableStream } from '../../readable-stream.mjs';

/** How many bytes one read asks the host for. */
const CHUNK = 16_384;

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/**
 * The promise of the host operation just issued, cancelled when `signal` aborts: it
 * then rejects with the signal's reason. Called right after the call that made it.
 */
export function abortable(signal, promise) {
	const token = rtLastToken();

	if (signal === undefined || token === 0) return promise;
	const cancel = () => {
		rtCancel(token, signal.reason);
	};

	signal.addEventListener('abort', cancel);
	const stop = () => {
		signal.removeEventListener('abort', cancel);
	};

	promise.then(stop, stop);

	return promise;
}

/**
 * A response body as a ReadableStream of Uint8Arrays, read from the host only as it is
 * read here (a high-water mark of 0: nothing is fetched ahead). At the end, the body's
 * outcome (the trailers future) closes it, or errors it when the body failed.
 * @param {number} stream the body's stream<u8> readable end
 * @param {number} trailers its future<result<option<trailers>, error-code>>
 * @param {number} done the future the guest completes when it is done with the body
 * @param {AbortSignal} [signal]
 */
export function responseBody(stream, trailers, done, signal) {
	let released = false;
	let reading = 0; // the token of the read in flight, while one is

	/** Hands the body back to the host, once: the stream end dropped, done completed. */
	const release = (outcomeRead) => {
		if (released) return;
		released = true;
		stream_u8_drop_readable(stream);
		future_result_void_error_code_write(done, { tag: 'ok', val: undefined }).then(ignore, ignore);

		// nobody will read the body's outcome: its future goes too
		if (!outcomeRead) future_result_option_own_trailers_error_code_drop_readable(trailers);
	};

	return new ReadableStream(
		{
			async pull(controller) {
				const buffer = new Uint8Array(CHUNK);
				let result;

				try {
					signal?.throwIfAborted();
					const read = stream_u8_read(stream, buffer);

					reading = rtLastToken();
					result = await abortable(signal, read);
				} catch (error) {
					reading = 0;
					release(false);
					throw error;
				}
				reading = 0;

				if (result.n > 0)
					controller.enqueue(result.n === CHUNK ? buffer : buffer.slice(0, result.n));

				if (!result.done) return;
				release(true);
				// the body's outcome, known once its stream has closed
				const outcome = await abortable(
					signal,
					future_result_option_own_trailers_error_code_read(trailers)
				);

				if (outcome.tag === 'err')
					throw Object.assign(
						new TypeError('fetch: the response body failed: ' + outcome.val.tag),
						{
							payload: outcome.val
						}
					);
				controller.close();
			},
			cancel(reason) {
				// a read in flight is cancelled with the host; its pull then ends the body
				if (reading !== 0 && rtCancel(reading, reason)) return;
				release(false);
			}
		},
		{ highWaterMark: 0 }
	);
}

/** A request body's bytes: a string (UTF-8), a Uint8Array or an ArrayBuffer. */
export function toBytes(body) {
	if (typeof body === 'string') return new TextEncoder().encode(body);

	if (body instanceof Uint8Array) return body;

	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	throw new TypeError('fetch: unsupported body type');
}

/** Writes all of `bytes` into a stream<u8> writer (until signal aborts); false when the reader left. */
async function writeBytes(writer, bytes, signal) {
	let at = 0;

	while (at < bytes.length) {
		const result = await abortable(signal, stream_u8_write(writer, bytes.subarray(at)));

		at += result.n;

		if (result.done) return false; // the reader went away
	}

	return true;
}

/**
 * Writes a request body into a stream<u8> writer, then closes it: bytes at once, or a
 * ReadableStream of Uint8Arrays chunk by chunk as they come.
 */
export async function writeBody(writer, body, signal) {
	try {
		if (!(body instanceof ReadableStream)) {
			await writeBytes(writer, toBytes(body), signal);

			return;
		}
		const reader = body.getReader();

		try {
			while (true) {
				const { value, done } = await reader.read();

				if (done) break;

				if (!(value instanceof Uint8Array))
					throw new TypeError('fetch: a request body stream must give Uint8Arrays');

				if (!(await writeBytes(writer, value, signal))) break;
			}
		} catch (error) {
			await reader.cancel(error);
			throw error;
		}
	} finally {
		stream_u8_drop_writable(writer);
	}
}
