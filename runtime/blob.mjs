// Blob (https://w3c.github.io/FileAPI/#blob-section): immutable bytes with a type. A Blob
// keeps its bytes as one Uint8Array (`_bytes`), which slice() views and the readers copy out.
// File (file.mjs) extends it.

import { ReadableStream } from './readable-stream.mjs';

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

/** One part of a blob: a Blob, a BufferSource, or anything else as a string. */
function partBytes(part, endings) {
	if (part instanceof Blob) return part._bytes;

	if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));

	if (ArrayBuffer.isView(part))
		return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));

	return stringBytes(String(part), endings);
}

/** The parts' bytes, joined. */
function joinParts(parts, endings) {
	const chunks = [];
	let total = 0;

	for (const part of parts) {
		const bytes = partBytes(part, endings);

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

/** blobParts and options checked as the constructors' WebIDL does. */
function blobInit(blobParts, options) {
	if (
		blobParts !== undefined &&
		(blobParts === null || typeof blobParts[Symbol.iterator] !== 'function')
	)
		throw new TypeError(
			"Failed to construct 'Blob': The provided value cannot be converted to a sequence."
		);

	const endings = options?.endings === undefined ? 'transparent' : String(options.endings);

	if (endings !== 'transparent' && endings !== 'native')
		throw new TypeError(
			`Failed to construct 'Blob': The provided value '${endings}' is not a valid enum value of type EndingType.`
		);

	return {
		bytes: joinParts(blobParts === undefined ? [] : Array.from(blobParts), endings),
		type: options?.type === undefined ? '' : normalizeType(options.type)
	};
}

/** A relative index (slice's start and end) clamped to [0, size]. */
function relativeIndex(value, size, fallback) {
	if (value === undefined) return fallback;
	const index = Math.trunc(Number(value)) || 0;

	return index < 0 ? Math.max(size + index, 0) : Math.min(index, size);
}

/** Immutable bytes with a MIME type. */
export class Blob {
	/**
	 * @param {Iterable<ArrayBuffer | ArrayBufferView | Blob | string>} [blobParts]
	 * @param {{ type?: string, endings?: 'transparent' | 'native' }} [options]
	 */
	constructor(blobParts = undefined, options = undefined) {
		const { bytes, type } = blobInit(blobParts, options);

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

	/** The bytes as a ReadableStream of one Uint8Array chunk. */
	stream() {
		const bytes = this._bytes.slice();

		return new ReadableStream({
			start(controller) {
				if (bytes.length > 0) controller.enqueue(bytes);
				controller.close();
			}
		});
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}
