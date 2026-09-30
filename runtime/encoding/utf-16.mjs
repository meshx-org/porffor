// UTF-16LE and UTF-16BE (https://encoding.spec.whatwg.org/#utf-16le), registered with
// TextDecoder. Loaded only when a program names one of their labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';

/** The shared UTF-16 decoder (https://encoding.spec.whatwg.org/#shared-utf-16-decoder). */
class Utf16Decoder {
	constructor(bigEndian) {
		this.bigEndian = bigEndian;
		this.lead = -1;
		this.surrogate = -1;
		this.prepend = [];
	}

	step(byte) {
		if (byte === EOF) {
			if (this.lead === -1 && this.surrogate === -1) return FINISHED;
			this.lead = -1;
			this.surrogate = -1;
			return ERROR;
		}

		if (this.lead === -1) {
			this.lead = byte;
			return CONTINUE;
		}
		const unit = this.bigEndian ? (this.lead << 8) | byte : (byte << 8) | this.lead;

		this.lead = -1;

		if (this.surrogate !== -1) {
			const lead = this.surrogate;

			this.surrogate = -1;

			if (unit >= 0xdc00 && unit <= 0xdfff)
				return 0x10000 + ((lead - 0xd800) << 10) + (unit - 0xdc00);
			// the unit's two bytes are read again, after the error
			if (this.bigEndian) this.prepend.push(unit >> 8, unit & 0xff);
			else this.prepend.push(unit & 0xff, unit >> 8);

			return ERROR;
		}

		if (unit >= 0xd800 && unit <= 0xdbff) {
			this.surrogate = unit;
			return CONTINUE;
		}

		if (unit >= 0xdc00 && unit <= 0xdfff) return ERROR;

		return unit;
	}
}

registerEncoding(
	'utf-16le',
	['csunicode', 'iso-10646-ucs-2', 'ucs-2', 'unicode', 'unicodefeff', 'utf-16', 'utf-16le'],
	() => new Utf16Decoder(false)
);
registerEncoding('utf-16be', ['unicodefffe', 'utf-16be'], () => new Utf16Decoder(true));
