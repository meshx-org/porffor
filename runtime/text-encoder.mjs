// TextEncoder (https://encoding.spec.whatwg.org/#interface-textencoder) for a Porffor-compiled
// program: the interface as WebIDL has it (arguments converted and checked, members
// enumerable, a brand check) over Porffor's own UTF-8 encoder (compiler/builtins/textcodec.ts).

import { defineInterface } from './webidl.mjs';
import { utf8Encoder } from './utf8.mjs';

const utf8 = utf8Encoder();

/** Encodes strings into UTF-8 bytes. */
export class TextEncoder {
	#brand = true;

	/** Always 'utf-8'. */
	get encoding() {
		return this.#brand ? 'utf-8' : '';
	}

	/**
	 * A string's UTF-8 bytes (a lone surrogate becomes U+FFFD).
	 * @param {string} [input]
	 * @returns {Uint8Array}
	 */
	encode(input = '') {
		if (!this.#brand) return null;

		return utf8.encode(`${input}`);
	}

	/**
	 * Writes as much of a string as fits, whole characters only, into a Uint8Array.
	 * @param {string} source
	 * @param {Uint8Array} destination
	 * @returns {{ read: number, written: number }} UTF-16 units read and bytes written
	 */
	encodeInto(source, destination) {
		if (!this.#brand) return null;

		if (arguments.length < 2) throw new TypeError('TextEncoder.encodeInto: 2 arguments required');
		const text = `${source}`;

		if (!(destination instanceof Uint8Array))
			throw new TypeError('TextEncoder.encodeInto: destination must be a Uint8Array');

		return utf8.encodeInto(text, destination);
	}
}

defineInterface(TextEncoder, 'TextEncoder');
