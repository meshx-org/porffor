// Blob (https://w3c.github.io/FileAPI/#blob-section): immutable bytes with a type. A Blob
// keeps its bytes as one Uint8Array (`_bytes`), which slice() views and the readers copy out.
// File (file.mjs) extends it.

import { byteStream, textStream } from './chunk-stream.mjs';
import { defineInterface, isObject } from './webidl.mjs';

// (a constant, not a literal in the getter, and a getter, not a defineProperty after the
// class: a statement at the top level is a side effect that keeps this module in every
// program the build injects it into, used or not)
const TAG = 'Blob';

/** A type as the spec keeps it: lowercased, or '' if it has anything outside U+0020..U+007E. */
function normalizeType(type) {
	const text = String(type);

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);

		if (code < 0x20 || code > 0x7e) return '';
	}

	return text.toLowerCase();
}

/** A string part's bytes: UTF-8, its line endings converted first for `endings: 'native'`. */
function stringBytes(text, endings) {
	// (a component's native line ending is \n, as on every platform but Windows)
	const converted = endings === 'native' ? text.replace(/\r\n?/g, '\n') : text;

	return new TextEncoder().encode(converted);
}

/**
 * One part of a blob as WebIDL converts it: a Blob's bytes, a copy of a BufferSource's, or
 * anything else as a string (encoded once the endings are known).
 */
function convertPart(part) {
	if (part instanceof Blob) return part._bytes;

	if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));

	if (ArrayBuffer.isView(part))
		return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));

	return `${part}`;
}

/**
 * blobParts as a sequence (https://webidl.spec.whatwg.org/#es-sequence): an object whose
 * iterator is walked, each part converted as it comes (a part's conversion can change what the
 * iterator gives next).
 */
export function convertParts(blobParts, what) {
	if (blobParts === undefined) return [];
	const method = isObject(blobParts) ? blobParts[Symbol.iterator] : undefined;

	if (typeof method !== 'function')
		throw new TypeError(
			`Failed to construct '${what}': The provided value cannot be converted to a sequence.`
		);
	const iterator = method.call(blobParts);
	const parts = [];

	while (true) {
		const step = iterator.next();

		if (step.done) return parts;
		parts.push(convertPart(step.value));
	}
}

/** The parts' bytes, joined: strings encoded as UTF-8, their line endings converted first. */
export function joinParts(parts, endings) {
	const chunks = [];
	let total = 0;

	for (const part of parts) {
		const bytes = typeof part === 'string' ? stringBytes(part, endings) : part;

		chunks.push(bytes);
		total += bytes.length;
	}
	const out = new Uint8Array(total);
	let at = 0;

	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}

	return out;
}

/**
 * A BlobPropertyBag (or FilePropertyBag, with lastModified) as WebIDL converts it: undefined,
 * null or an object, its members read in order.
 * @param {unknown} options
 * @param {string} what the interface constructed, for errors
 * @param {boolean} [file] whether it is a FilePropertyBag
 */
export function blobOptions(options, what, file = false) {
	if (options !== undefined && options !== null && !isObject(options))
		throw new TypeError(
			`Failed to construct '${what}': The provided value is not of type '${what}PropertyBag'.`
		);
	const bag = options ?? {};
	const endings = bag.endings === undefined ? 'transparent' : `${bag.endings}`;

	if (endings !== 'transparent' && endings !== 'native')
		throw new TypeError(
			`Failed to construct '${what}': The provided value '${endings}' is not a valid enum value of type EndingType.`
		);
	const lastModified =
		file && bag.lastModified !== undefined ? Number(bag.lastModified) : undefined;
	const type = bag.type === undefined ? '' : normalizeType(`${bag.type}`);

	return { endings, lastModified, type };
}

/**
 * A relative index (slice's start and end), converted as WebIDL's [Clamp] long long (rounded
 * half to even), then clamped to [0, size].
 */
function relativeIndex(value, size, fallback) {
	if (value === undefined) return fallback;
	const number = Number(value);
	let index = 0;

	if (number === Infinity || number === -Infinity) index = number;
	else if (!Number.isNaN(number)) {
		const floor = Math.floor(number);
		const fraction = number - floor;

		index =
			fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
	}

	return index < 0 ? Math.max(size + index, 0) : Math.min(index, size);
}

/** Immutable bytes with a MIME type. */
export class Blob {
	/**
	 * @param {Iterable<ArrayBuffer | ArrayBufferView | Blob | string>} [blobParts]
	 * @param {{ type?: string, endings?: 'transparent' | 'native' }} [options]
	 */
	constructor(blobParts = undefined, options = undefined) {
		const parts = convertParts(blobParts, 'Blob');
		const { endings, type } = blobOptions(options, 'Blob');
		const bytes = joinParts(parts, endings);

		this._bytes = bytes;
		this._type = type;
	}

	/** The size in bytes. */
	get size() {
		return this._bytes.length;
	}

	/** The MIME type, lowercased ('' if unknown). */
	get type() {
		return this._type;
	}

	/**
	 * A Blob of a range of the bytes: start and end are clamped, negative from the end.
	 * @param {number} [start]
	 * @param {number} [end]
	 * @param {string} [contentType]
	 */
	slice(start = undefined, end = undefined, contentType = undefined) {
		const size = this._bytes.length;
		const from = relativeIndex(start, size, 0);
		const to = relativeIndex(end, size, size);
		const out = new Blob();

		out._bytes = this._bytes.subarray(from, Math.max(from, to));
		out._type = contentType === undefined ? '' : normalizeType(contentType);

		return out;
	}

	/** The bytes, as a copy. */
	async bytes() {
		return this._bytes.slice();
	}

	/** The bytes, as a copy in an ArrayBuffer. */
	async arrayBuffer() {
		return this._bytes.slice().buffer;
	}

	/** The bytes decoded as UTF-8. */
	async text() {
		return new TextDecoder().decode(this._bytes);
	}

	/** The bytes as a stream of the strings their UTF-8 decodes to. */
	textStream() {
		return textStream(this.stream());
	}

	/** The bytes as a readable byte stream of one Uint8Array chunk. */
	stream() {
		return byteStream(this._bytes.slice());
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}

defineInterface(Blob, 'Blob', { promises: ['arrayBuffer', 'bytes', 'text'] });
