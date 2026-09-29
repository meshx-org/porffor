// TextEncoderStream for a Porffor-compiled guest: strings in, UTF-8 bytes out. A
// surrogate pair split across two chunks is held back and encoded whole. Injected into
// every guest.

import { TransformStream } from './transform-stream.mjs';

/** Whether a UTF-16 unit is the first half of a surrogate pair. */
const isHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;

/** Encodes a stream of strings into a stream of Uint8Arrays (UTF-8). */
export class TextEncoderStream {
	constructor() {
		const encoder = new TextEncoder();
		let pending = '';

		const stream = new TransformStream({
			transform(chunk, controller) {
				let text = pending + String(chunk);

				pending = '';

				if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
					pending = text.slice(-1);
					text = text.slice(0, -1);
				}

				if (text !== '') controller.enqueue(encoder.encode(text));
			},
			flush(controller) {
				// a lone high surrogate at the end encodes as U+FFFD
				if (pending !== '') controller.enqueue(encoder.encode(pending));
			}
		});

		this._encoding = 'utf-8';
		this._readable = stream.readable;
		this._writable = stream.writable;
	}

	/** Always 'utf-8'. */
	get encoding() {
		return this._encoding;
	}

	/** The side bytes come out of. */
	get readable() {
		return this._readable;
	}

	/** The side strings go into. */
	get writable() {
		return this._writable;
	}
}
