// TextDecoderStream for a Porffor-compiled guest: bytes in, strings out, over the fork's
// TextDecoder (UTF-8 only) in streaming mode, so a character split across chunks
// arrives whole. Injected into every guest.

import { TransformStream } from './transform-stream.mjs';

/** Decodes a stream of Uint8Arrays into a stream of strings. */
export class TextDecoderStream {
	/**
	 * @param {string} [label] 'utf-8' (the only encoding here)
	 * @param {{ fatal?: boolean, ignoreBOM?: boolean }} [options]
	 */
	constructor(label, options) {
		const decoder = new TextDecoder(label, options);

		this._decoder = decoder;
		const stream = new TransformStream({
			transform(chunk, controller) {
				const text = decoder.decode(chunk, { stream: true });

				if (text !== '') controller.enqueue(text);
			},
			flush(controller) {
				const text = decoder.decode();

				if (text !== '') controller.enqueue(text);
			}
		});

		this._readable = stream.readable;
		this._writable = stream.writable;
	}

	/** 'utf-8'. */
	get encoding() {
		return this._decoder.encoding;
	}

	/** Whether malformed input errors the stream instead of becoming U+FFFD. */
	get fatal() {
		return this._decoder.fatal;
	}

	/** Whether a leading byte order mark is kept. */
	get ignoreBOM() {
		return this._decoder.ignoreBOM;
	}

	/** The side strings come out of. */
	get readable() {
		return this._readable;
	}

	/** The side bytes go into. */
	get writable() {
		return this._writable;
	}
}
