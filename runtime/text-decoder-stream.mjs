// TextDecoderStream (https://encoding.spec.whatwg.org/#interface-textdecoderstream) for a
// Porffor-compiled program: bytes in, strings out, over TextDecoder in streaming mode, so a
// character split across chunks arrives whole. A chunk that is not a BufferSource, or
// malformed input when fatal, errors the stream.

import { defineInterface } from './webidl.mjs';
import { TextDecoder } from './text-decoder.mjs';
import { TransformStream } from './transform-stream.mjs';

/** Whether a chunk is a BufferSource (TextDecoder's own undefined, no input, is not one). */
const isBufferSource = (chunk) =>
	chunk instanceof ArrayBuffer ||
	ArrayBuffer.isView(chunk) ||
	(typeof SharedArrayBuffer === 'function' && chunk instanceof SharedArrayBuffer);

/** Decodes a stream of BufferSources into a stream of strings. */
export class TextDecoderStream {
	#decoder;
	#stream;

	/**
	 * @param {string} [label] the encoding's label ('utf-8')
	 * @param {{ fatal?: boolean, ignoreBOM?: boolean }} [options]
	 */
	constructor(label = 'utf-8', options = undefined) {
		const decoder = new TextDecoder(label, options);

		this.#decoder = decoder;
		this.#stream = new TransformStream({
			transform(chunk, controller) {
				if (!isBufferSource(chunk))
					throw new TypeError(
						'TextDecoderStream: a chunk must be an ArrayBuffer or ArrayBufferView'
					);
				const text = decoder.decode(chunk, { stream: true });

				if (text !== '') controller.enqueue(text);
			},
			flush(controller) {
				const text = decoder.decode();

				if (text !== '') controller.enqueue(text);
			}
		});
	}

	/** The encoding's name, lowercase. */
	get encoding() {
		return this.#decoder.encoding;
	}

	/** Whether malformed input errors the stream instead of becoming U+FFFD. */
	get fatal() {
		return this.#decoder.fatal;
	}

	/** Whether a leading byte order mark is kept. */
	get ignoreBOM() {
		return this.#decoder.ignoreBOM;
	}

	/** The side strings come out of. */
	get readable() {
		return this.#stream.readable;
	}

	/** The side bytes go into. */
	get writable() {
		return this.#stream.writable;
	}
}

defineInterface(TextDecoderStream, 'TextDecoderStream');
