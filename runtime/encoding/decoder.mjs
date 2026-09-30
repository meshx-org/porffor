// What TextDecoder needs for an encoding other than UTF-8: a decoder that steps byte by byte
// (https://encoding.spec.whatwg.org/#decoders), run over each chunk with its state kept
// between streaming calls, the output collected as UTF-16 units, and a leading BOM dropped
// for UTF-16. Imported by the modules that register such encodings (utf-16.mjs and the
// legacy ones), each loaded only when a program names one of its labels
// (runtime/globals.json): a program that decodes UTF-8 alone carries none of it.

import { encodingRegistry } from '../text-decoder.mjs';

/** What a decoder's step returns besides a code point: nothing to emit yet. */
export const CONTINUE = -1;
/** A decoder error: U+FFFD, or a TypeError when fatal. */
export const ERROR = -2;
/** The end of the queue reached with nothing pending. */
export const FINISHED = -3;
/** The end of the queue, as a byte a decoder is handed. */
export const EOF = -1;

/** UTF-16 code units, grown as they come, read out as a string. */
class Output {
	constructor(size) {
		this.units = new Uint16Array(size < 16 ? 16 : size);
		this.length = 0;
	}

	/** Appends a code point (two units outside the BMP). */
	push(cp) {
		if (this.length + 2 > this.units.length) {
			const units = new Uint16Array(this.units.length * 2);

			units.set(this.units);
			this.units = units;
		}

		if (cp > 0xffff) {
			cp -= 0x10000;
			this.units[this.length++] = 0xd800 + (cp >> 10);
			this.units[this.length++] = 0xdc00 + (cp & 0x3ff);
		} else this.units[this.length++] = cp;
	}

	/** The units from `start` as a string. */
	text(start) {
		let out = '';

		for (let at = start; at < this.length; at += 8192) {
			const end = at + 8192 < this.length ? at + 8192 : this.length;

			out += String.fromCharCode.apply(null, this.units.subarray(at, end));
		}

		return out;
	}
}

/** Runs a decoder over bytes (https://encoding.spec.whatwg.org/#decode-and-enqueue-a-chunk). */
function run(decoder, bytes, flush, fatal, output) {
	const prepend = decoder.prepend;
	let i = 0;

	for (;;) {
		let byte;

		if (prepend !== undefined && prepend.length > 0) byte = prepend.shift();
		else if (i < bytes.length) byte = bytes[i++];
		else if (flush) byte = EOF;
		else return;

		const result = decoder.step(byte);

		if (result === FINISHED) return;

		if (result === ERROR) {
			if (fatal) throw new TypeError('TextDecoder.decode: the encoded data was not valid');
			output.push(0xfffd);
		} else if (result > 0x10ffff) {
			// two code points (Big5's pairs): first << 12 | second, over 0x110000
			const pair = result - 0x110000;

			output.push(pair >> 12);
			output.push(pair & 0xfff);
		} else if (result >= 0) output.push(result);
	}
}

/** A BufferSource's bytes as a Uint8Array over them (no copy). */
function bufferBytes(input) {
	if (input instanceof ArrayBuffer) return new Uint8Array(input);

	if (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer)
		return new Uint8Array(input);

	if (ArrayBuffer.isView(input))
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	throw new TypeError('TextDecoder.decode: input must be an ArrayBuffer or ArrayBufferView');
}

/** One TextDecoder's decoding, for an encoding registered here: TextDecoder's decode. */
class StreamDecoder {
	constructor(name, create, fatal, ignoreBOM) {
		this.create = create;
		this.fatal = fatal;
		// UTF-16 drops a leading BOM (UTF-8's decoder does its own); the legacy ones keep it
		this.dropBOM = !ignoreBOM && (name === 'utf-16le' || name === 'utf-16be');
		this.decoder = null;
		this.bomSeen = false;
		this.doNotFlush = false;
	}

	/** https://encoding.spec.whatwg.org/#dom-textdecoder-decode */
	decode(input, options) {
		const bytes = input === undefined ? new Uint8Array(0) : bufferBytes(input);
		let stream = false;

		if (options !== undefined && options !== null) {
			if (typeof options !== 'object' && typeof options !== 'function')
				throw new TypeError('TextDecoder.decode: options must be an object');
			stream = !!options.stream;
		}

		if (!this.doNotFlush) {
			this.decoder = this.create();
			this.bomSeen = false;
		}
		this.doNotFlush = stream;
		const output = new Output(bytes.length + 8);

		run(this.decoder, bytes, !stream, this.fatal, output);
		let start = 0;

		// the BOM is dropped once, from the start of the stream
		if (!this.bomSeen && output.length > 0) {
			this.bomSeen = true;

			if (this.dropBOM && output.units[0] === 0xfeff) start = 1;
		}

		return output.text(start);
	}
}

/**
 * Makes an encoding available to TextDecoder (a module registering one does, as it loads).
 * @param {string} name the encoding's name, lowercase (TextDecoder's `encoding`)
 * @param {string[]} labels its labels, lowercase
 * @param {() => { step(byte: number): number, prepend?: number[] }} create a new decoder: step
 *   takes a byte (or EOF) and returns a code point, CONTINUE, ERROR or FINISHED; bytes it
 *   pushes on `prepend` are read again before the next input byte
 */
export function registerEncoding(name, labels, create) {
	const registry = encodingRegistry();

	for (const label of labels) registry.labels[label] = name;
	registry.decoders[name] = (fatal, ignoreBOM) => new StreamDecoder(name, create, fatal, ignoreBOM);
}
