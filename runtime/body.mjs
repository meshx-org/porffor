// The Fetch standard's body (https://fetch.spec.whatwg.org/#body-mixin), shared by Request
// and Response: a body is a ReadableStream of Uint8Arrays (or none), extracted from what
// the constructor was given, and read once by text() / json() / bytes() / arrayBuffer().
// An object with a body keeps it as `_body` ({ stream } or null).

import { Blob } from './blob.mjs';
import { byteStream, textStream } from './chunk-stream.mjs';
import { ReadableStream, tee } from './readable-stream.mjs';
import { readRequest } from './stream-internals.mjs';
import { URLSearchParams } from './url-search-params.mjs';

/**
 * FormData bodies, plugged in by ./body-form-data.mjs when a program uses them (runtime/globals.json):
 * extract makes a FormData's multipart/form-data body (null for anything else), parse reads a body
 * as a FormData. Kept on this function, not in a module binding: a bundle may run the plug's
 * module before this one's top-level code, but never before its functions exist.
 * @returns {{ extract: ((init: unknown) => { stream: ReadableStream, type: string } | null) | null,
 *   parse: ((bytes: Uint8Array, type: string | null) => unknown) | null }}
 */
export function formDataBodies() {
	if (formDataBodies.state === undefined) formDataBodies.state = { extract: null, parse: null };

	return formDataBodies.state;
}

/**
 * A body of bytes known when it is made (a string's, bytes', URLSearchParams'): `source` is the
 * bytes, and its stream is made only once something reads it. A server writes the bytes as they
 * are, with their length, and never makes one.
 */
export class KnownBody {
	/**
	 * @param {Uint8Array} bytes
	 * @param {string | null} type the content-type they imply
	 */
	constructor(bytes, type) {
		this.source = bytes;
		this.type = type;
		this._stream = null;
		// read whole, without its stream ever being made (consumeBody)
		this.taken = false;
	}

	/** The bytes as a stream of one chunk. */
	get stream() {
		if (this._stream === null) this._stream = byteStream(this.source);

		return this._stream;
	}
}

/**
 * Extracts a body: its stream and the content-type it implies (null when it implies none). A body
 * of bytes known now is a KnownBody, which is itself what a Request or Response keeps as `_body`.
 * @param {string | ArrayBuffer | ArrayBufferView | Blob | URLSearchParams | FormData | ReadableStream} init
 * @returns {{ stream: ReadableStream, type: string | null } | KnownBody}
 */
export function extractBody(init) {
	const { extract } = formDataBodies();

	if (extract !== null) {
		const extracted = extract(init);

		if (extracted !== null) return extracted;
	}

	if (init instanceof ReadableStream) {
		if (init.locked || init._disturbed)
			throw new TypeError('Body: the stream is locked or has been read');

		return { stream: init, type: null };
	}

	// a Blob's bytes, its type the content-type (none when it has no type)
	if (init instanceof Blob)
		return { stream: init.stream(), type: init.type === '' ? null : init.type };

	if (init instanceof URLSearchParams)
		return new KnownBody(
			new TextEncoder().encode(init.toString()),
			'application/x-www-form-urlencoded;charset=UTF-8'
		);

	if (init instanceof ArrayBuffer) return new KnownBody(new Uint8Array(init.slice(0)), null);

	if (ArrayBuffer.isView(init))
		return new KnownBody(
			new Uint8Array(init.buffer.slice(init.byteOffset, init.byteOffset + init.byteLength)),
			null
		);

	return new KnownBody(new TextEncoder().encode(String(init)), 'text/plain;charset=UTF-8');
}

/**
 * What an object keeps as `_body` for an extracted body: a KnownBody as it is, else its stream.
 * @param {{ stream: ReadableStream } | KnownBody} extracted
 */
export function keptBody(extracted) {
	return extracted instanceof KnownBody ? extracted : { stream: extracted.stream };
}

/**
 * Whether a header list (Headers' _list) has a name (lower case): a Request's or Response's own
 * check, without the validation Headers.has does for a program's names.
 */
export function listHas(list, name) {
	for (const pair of list) if (pair[0] === name) return true;

	return false;
}

/** Whether the body has been read (or is being read). */
export function bodyUsed(owner) {
	const body = owner._body;

	if (body instanceof KnownBody && body._stream === null) return body.taken;

	return body !== null && body.stream._disturbed;
}

/**
 * Whether the body can no longer be read or cloned: read from, or its stream locked to a
 * reader (https://fetch.spec.whatwg.org/#body-unusable). bodyUsed is only the first.
 */
export function bodyUnusable(owner) {
	const body = owner._body;

	if (body instanceof KnownBody && body._stream === null) return body.taken;

	return body !== null && (body.stream._disturbed || body.stream.locked);
}

/** The whole body, as one Uint8Array; a body can be read once. */
export async function consumeBody(owner) {
	if (owner._body === null) return new Uint8Array(0);

	if (bodyUnusable(owner)) throw new TypeError('Body has already been read');
	const known = owner._body;

	// bytes known now, their stream never made: they are the body, no stream read for them
	if (known instanceof KnownBody && known._stream === null) {
		known.taken = true;

		return known.source;
	}
	const reader = owner._body.stream.getReader();
	const chunks = [];
	let total = 0;

	// read requests, as fetch's own reading is: no promise here is resolved with a
	// { value, done } object, which a then on Object.prototype could step into
	const next = () =>
		new Promise((resolve, reject) => {
			readRequest(owner._body.stream, {
				resolve({ value, done }) {
					if (done) return resolve(true);

					if (!(value instanceof Uint8Array))
						return reject(new TypeError('Body: a stream chunk is not a Uint8Array'));
					chunks.push(value);
					total += value.length;
					resolve(false);
				},
				reject
			});
		});

	while (!(await next()));
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

/**
 * The body as a FormData (https://fetch.spec.whatwg.org/#dom-body-formdata), by its
 * content-type: multipart/form-data or application/x-www-form-urlencoded, else a TypeError.
 */
export async function consumeFormData(owner) {
	const { parse } = formDataBodies();
	const bytes = await consumeBody(owner);

	if (parse === null) throw new TypeError('Body.formData: FormData is not available here');

	return parse(bytes, owner.headers.get('content-type'));
}

/** The body as a stream of the strings its UTF-8 decodes to (an empty one for no body). */
export function consumeTextStream(owner) {
	if (bodyUnusable(owner)) throw new TypeError('Body has already been read');

	return textStream(owner._body === null ? byteStream(new Uint8Array(0)) : owner._body.stream);
}
