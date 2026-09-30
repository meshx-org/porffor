// gb18030 and GBK (https://encoding.spec.whatwg.org/#legacy-multi-byte-chinese-(simplified)-encodings),
// registered with TextDecoder: one decoder for both. Loaded only when a program names one of
// their labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';
import { INDEX_GB18030 } from './index-gb18030.mjs';
import { RANGE_CODE_POINTS, RANGE_POINTERS } from './index-gb18030-ranges.mjs';

/** A four-byte sequence's code point (https://encoding.spec.whatwg.org/#index-gb18030-ranges-code-point), or -1. */
function rangesCodePoint(pointer) {
	if ((pointer > 39419 && pointer < 189000) || pointer > 1237575) return -1;

	if (pointer === 7457) return 0xe7c7;

	if (pointer >= 189000) return 0x10000 + pointer - 189000;
	// the last range starting at or before the pointer
	let low = 0;
	let high = RANGE_POINTERS.length - 1;

	while (low < high) {
		const middle = (low + high + 1) >> 1;

		if (RANGE_POINTERS[middle] <= pointer) low = middle;
		else high = middle - 1;
	}

	return RANGE_CODE_POINTS[low] + pointer - RANGE_POINTERS[low];
}

/** The gb18030 decoder (https://encoding.spec.whatwg.org/#gb18030-decoder). */
class Gb18030Decoder {
	constructor() {
		this.first = 0;
		this.second = 0;
		this.third = 0;
		this.prepend = [];
	}

	step(byte) {
		if (byte === EOF) {
			if (this.first === 0 && this.second === 0 && this.third === 0) return FINISHED;
			this.first = 0;
			this.second = 0;
			this.third = 0;
			return ERROR;
		}

		if (this.third !== 0) {
			if (byte < 0x30 || byte > 0x39) {
				this.prepend.push(this.second, this.third, byte);
				this.first = 0;
				this.second = 0;
				this.third = 0;
				return ERROR;
			}
			const cp = rangesCodePoint(
				((this.first - 0x81) * 10 + this.second - 0x30) * 1260 +
					(this.third - 0x81) * 10 +
					byte -
					0x30
			);

			this.first = 0;
			this.second = 0;
			this.third = 0;
			return cp === -1 ? ERROR : cp;
		}

		if (this.second !== 0) {
			if (byte >= 0x81 && byte <= 0xfe) {
				this.third = byte;
				return CONTINUE;
			}
			this.prepend.push(this.second, byte);
			this.first = 0;
			this.second = 0;
			return ERROR;
		}

		if (this.first !== 0) {
			if (byte >= 0x30 && byte <= 0x39) {
				this.second = byte;
				return CONTINUE;
			}
			const lead = this.first;
			const offset = byte < 0x7f ? 0x40 : 0x41;

			this.first = 0;

			if ((byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfe)) {
				const cp = INDEX_GB18030.charCodeAt((lead - 0x81) * 190 + byte - offset);

				if (cp !== 0xfffd) return cp;
			}

			if (byte < 0x80) this.prepend.push(byte);

			return ERROR;
		}

		if (byte < 0x80) return byte;

		if (byte === 0x80) return 0x20ac;

		if (byte <= 0xfe) {
			this.first = byte;
			return CONTINUE;
		}

		return ERROR;
	}
}

registerEncoding(
	'gbk',
	[
		'chinese',
		'csgb2312',
		'csiso58gb231280',
		'gb2312',
		'gb_2312',
		'gb_2312-80',
		'gbk',
		'iso-ir-58',
		'x-gbk'
	],
	() => new Gb18030Decoder()
);
registerEncoding('gb18030', ['gb18030'], () => new Gb18030Decoder());
