// The Fetch standard's body (https://fetch.spec.whatwg.org/#body-mixin), shared by Request
// and Response: a body is a ReadableStream of Uint8Arrays (or none), extracted from what
// the constructor was given, and read once by text() / json() / bytes() / arrayBuffer().
// An object with a body keeps it as `_body` ({ stream } or null).

import { Blob } from './blob.mjs';
import { ReadableStream, tee } from './readable-stream.mjs';
import { URLSearchParams } from './url-search-params.mjs';

/** A ReadableStream of one chunk (none when empty). */
function byteStream(bytes) {
	return new ReadableStream({
		start(controller) {
			if (bytes.length > 0) controller.enqueue(bytes);
			controller.close();
		}
	});
}

/**
 * Extracts a body: its stream and the content-type it implies (null when it implies none).
 * @param {string | ArrayBuffer | ArrayBufferView | Blob | URLSearchParams | ReadableStream} init
 */
export function extractBody(init) {
	if (init instanceof ReadableStream) {
		if (init.locked || init._disturbed)
			throw new TypeError('Body: the stream is locked or has been read');

		return { stream: init, type: null };
	}

	// a Blob's bytes, its type the content-type (none when it has no type)
	if (init instanceof Blob)
		return { stream: init.stream(), type: init.type === '' ? null : init.type };

	if (init instanceof URLSearchParams)
		return {
			stream: byteStream(new TextEncoder().encode(init.toString())),
			type: 'application/x-www-form-urlencoded;charset=UTF-8'
		};

	if (init instanceof ArrayBuffer)
		return { stream: byteStream(new Uint8Array(init.slice(0))), type: null };

	if (ArrayBuffer.isView(init))
		return {
			stream: byteStream(
				new Uint8Array(init.buffer.slice(init.byteOffset, init.byteOffset + init.byteLength))
			),
			type: null
		};

	return {
		stream: byteStream(new TextEncoder().encode(String(init))),
		type: 'text/plain;charset=UTF-8'
	};
}

/** Whether the body has been read (or is being read). */
export function bodyUsed(owner) {
	const body = owner._body;

	return body !== null && body.stream._disturbed;
}

/**
 * Whether the body can no longer be read or cloned: read from, or its stream locked to a
 * reader (https://fetch.spec.whatwg.org/#body-unusable). bodyUsed is only the first.
 */
export function bodyUnusable(owner) {
	const body = owner._body;

	return body !== null && (body.stream._disturbed || body.stream.locked);
}

/** The whole body, as one Uint8Array; a body can be read once. */
export async function consumeBody(owner) {
	if (owner._body === null) return new Uint8Array(0);

	if (bodyUnusable(owner)) throw new TypeError('Body has already been read');
	const reader = owner._body.stream.getReader();
	const chunks = [];
	let total = 0;

	while (true) {
		const { value, done } = await reader.read();

		if (done) break;

		if (!(value instanceof Uint8Array))
			throw new TypeError('Body: a stream chunk is not a Uint8Array');
		chunks.push(value);
		total += value.length;
	}
	reader.releaseLock();
	const out = new Uint8Array(total);
	let at = 0;

	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}

	return out;
}

/** A copy of the body for clone(): the stream split in two, one half kept, one returned. */
export function cloneBody(owner) {
	if (owner._body === null) return null;

	if (bodyUnusable(owner)) throw new TypeError('Body has already been read: cannot clone');
	// the clone's chunks are structured clones: the two bodies never share a buffer
	const [kept, copy] = tee(owner._body.stream, true);

	owner._body = { stream: kept };

	return { stream: copy };
}
