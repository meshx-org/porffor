// TextDecoder (https://encoding.spec.whatwg.org/#interface-textdecoder) for a Porffor-compiled
// program: UTF-8 through Porffor's own decoder (compiler/builtins/textcodec.ts, a SIMD fast
// path). Every other encoding comes from runtime/encoding/ (UTF-16 and the legacy ones), a
// module loaded only when the program names one of its labels (runtime/globals.json), which
// registers its labels and decoder here as it loads. A label no loaded module knows is a
// RangeError, as an unsupported one is.

import { utf8Decoder } from './utf8.mjs';
import { defineInterface } from './webidl.mjs';

/**
 * The encodings TextDecoder knows: label -> encoding name, and name -> a function opening a
 * decoder for it ((fatal, ignoreBOM) => an object with decode(input, options)). UTF-8 from
 * the start, the others as their modules register them (runtime/encoding/decoder.mjs). Kept
 * on this function, not in module bindings: a bundle's injected globals make its modules a
 * cycle, so a registering module can run before this module's top-level code does.
 * @returns {{ labels: object, decoders: object }}
 */
export function encodingRegistry() {
	if (encodingRegistry.state === undefined) {
		const labels = {};

		for (const label of [
			'unicode-1-1-utf-8',
			'unicode11utf8',
			'unicode20utf8',
			'utf-8',
			'utf8',
			'x-unicode20utf8'
		])
			labels[label] = 'utf-8';
		encodingRegistry.state = { labels, decoders: {} };
	}

	return encodingRegistry.state;
}

/**
 * A label's encoding name (https://encoding.spec.whatwg.org/#concept-encoding-get), or null:
 * ASCII whitespace trimmed, ASCII letters lowercased, among the encodings loaded.
 * @param {string} label
 */
export function encodingName(label) {
	let start = 0;
	let end = label.length;
	const space = (unit) =>
		unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d || unit === 0x20;

	while (start < end && space(label.charCodeAt(start))) start++;
	while (end > start && space(label.charCodeAt(end - 1))) end--;
	let key = '';

	for (let i = start; i < end; i++) {
		const unit = label.charCodeAt(i);

		// every label is printable ASCII (and Porffor's property keys end at a NUL: utf-8\0
		// would find utf-8)
		if (unit < 0x21 || unit > 0x7e) return null;
		key += unit >= 0x41 && unit <= 0x5a ? String.fromCharCode(unit + 0x20) : label[i];
	}
	// (own labels only: an inherited property is a function or an object, never a name)
	const name = encodingRegistry().labels[key];

	return typeof name === 'string' ? name : null;
}

/** Decodes bytes in an encoding into a string. */
export class TextDecoder {
	#encoding;
	#fatal;
	#ignoreBOM;
	// the decoding: Porffor's UTF-8 decoder, or a registered encoding's; each keeps its own
	// stream and BOM state
	#decoder;

	/**
	 * @param {string} [label] the encoding's label ('utf-8')
	 * @param {{ fatal?: boolean, ignoreBOM?: boolean }} [options] fatal: malformed input
	 *   throws a TypeError instead of becoming U+FFFD; ignoreBOM: a leading BOM is kept
	 */
	constructor(label = 'utf-8', options = undefined) {
		const text = `${label}`;
		let fatal = false;
		let ignoreBOM = false;

		if (options !== undefined && options !== null) {
			if (typeof options !== 'object' && typeof options !== 'function')
				throw new TypeError('TextDecoder: options must be an object');
			fatal = !!options.fatal;
			ignoreBOM = !!options.ignoreBOM;
		}
		const name = encodingName(text);

		if (name === null) throw new RangeError(`TextDecoder: the "${text}" encoding is not supported`);
		this.#encoding = name;
		this.#fatal = fatal;
		this.#ignoreBOM = ignoreBOM;
		this.#decoder =
			name === 'utf-8'
				? utf8Decoder({ fatal, ignoreBOM })
				: encodingRegistry().decoders[name](fatal, ignoreBOM);
	}

	/** The encoding's name, lowercase ('utf-8'). */
	get encoding() {
		return this.#encoding;
	}

	/** Whether malformed input throws instead of becoming U+FFFD. */
	get fatal() {
		return this.#fatal;
	}

	/** Whether a leading byte order mark is kept. */
	get ignoreBOM() {
		return this.#ignoreBOM;
	}

	/**
	 * Decodes a chunk. With `stream: true` a sequence cut off at its end is held for the
	 * next call; without it, the stream ends here.
	 * @param {ArrayBuffer | ArrayBufferView} [input]
	 * @param {{ stream?: boolean }} [options]
	 * @returns {string}
	 */
	decode(input = undefined, options = undefined) {
		return this.#decoder.decode(input, options);
	}
}

defineInterface(TextDecoder, 'TextDecoder');
