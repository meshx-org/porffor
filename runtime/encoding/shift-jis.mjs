// Shift_JIS (https://encoding.spec.whatwg.org/#shift_jis), registered with TextDecoder. Loaded
// only when a program names one of its labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';
import { INDEX_JIS0208 } from './index-jis0208.mjs';

/** The Shift_JIS decoder (https://encoding.spec.whatwg.org/#shift_jis-decoder). */
class ShiftJisDecoder {
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
			const offset = byte < 0x7f ? 0x40 : 0x41;
			const leadOffset = lead < 0xa0 ? 0x81 : 0xc1;

			this.lead = 0;

			if ((byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfc)) {
				const pointer = (lead - leadOffset) * 188 + byte - offset;

				// the end user-defined area
				if (pointer >= 8836 && pointer <= 10715) return 0xe000 - 8836 + pointer;
				const cp = INDEX_JIS0208.charCodeAt(pointer);

				if (cp !== 0xfffd) return cp;
			}

			if (byte < 0x80) this.prepend.push(byte);

			return ERROR;
		}

		if (byte <= 0x80) return byte;

		if (byte >= 0xa1 && byte <= 0xdf) return 0xff61 - 0xa1 + byte;

		if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) {
			this.lead = byte;
			return CONTINUE;
		}

		return ERROR;
	}
}

registerEncoding(
	'shift_jis',
	['csshiftjis', 'ms932', 'ms_kanji', 'shift-jis', 'shift_jis', 'sjis', 'windows-31j', 'x-sjis'],
	() => new ShiftJisDecoder()
);
