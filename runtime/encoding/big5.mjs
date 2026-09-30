// Big5 (https://encoding.spec.whatwg.org/#big5), registered with TextDecoder. Loaded only when
// a program names one of its labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';
import { BIG5_PLANE_2, INDEX_BIG5 } from './index-big5.mjs';

/** A pointer that decodes to two code points, as the decoder contract returns a pair
 * (0x110000 + (first << 12) + second), or -1. */
function pair(pointer) {
	if (pointer === 1133) return 0x110000 + (0xca << 12) + 0x304;

	if (pointer === 1135) return 0x110000 + (0xca << 12) + 0x30c;

	if (pointer === 1164) return 0x110000 + (0xea << 12) + 0x304;

	if (pointer === 1166) return 0x110000 + (0xea << 12) + 0x30c;

	return -1;
}

/** The Big5 decoder (https://encoding.spec.whatwg.org/#big5-decoder). */
class Big5Decoder {
	constructor() {
		this.lead = 0;
		this.prepend = [];
	}

	step(byte) {
		if (byte === EOF) {
			if (this.lead === 0) return FINISHED;
			this.lead = 0;
			return ERROR;
		}

		if (this.lead !== 0) {
			const lead = this.lead;
			const offset = byte < 0x7f ? 0x40 : 0x62;

			this.lead = 0;

			if ((byte >= 0x40 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xfe)) {
				const pointer = (lead - 0x81) * 157 + byte - offset;
				const two = pair(pointer);

				if (two !== -1) return two;
				const unit = INDEX_BIG5.charCodeAt(pointer);

				if ((BIG5_PLANE_2.charCodeAt(pointer >> 4) >> (pointer & 15)) & 1) return 0x20000 + unit;

				if (unit !== 0xfffd) return unit;
			}

			if (byte < 0x80) this.prepend.push(byte);

			return ERROR;
		}

		if (byte < 0x80) return byte;

		if (byte >= 0x81 && byte <= 0xfe) {
			this.lead = byte;
			return CONTINUE;
		}

		return ERROR;
	}
}

registerEncoding(
	'big5',
	['big5', 'big5-hkscs', 'cn-big5', 'csbig5', 'x-x-big5'],
	() => new Big5Decoder()
);
