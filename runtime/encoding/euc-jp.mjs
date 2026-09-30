// EUC-JP (https://encoding.spec.whatwg.org/#euc-jp), registered with TextDecoder. Loaded only
// when a program names one of its labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';
import { INDEX_JIS0208 } from './index-jis0208.mjs';
import { INDEX_JIS0212 } from './index-jis0212.mjs';

/** The EUC-JP decoder (https://encoding.spec.whatwg.org/#euc-jp-decoder). */
class EucJpDecoder {
	constructor() {
		this.jis0212 = false;
		this.lead = 0;
		this.prepend = [];
	}

	step(byte) {
		if (byte === EOF) {
			if (this.lead === 0) return FINISHED;
			this.lead = 0;
			return ERROR;
		}

		if (this.lead === 0x8e && byte >= 0xa1 && byte <= 0xdf) {
			this.lead = 0;
			return 0xff61 - 0xa1 + byte;
		}

		if (this.lead === 0x8f && byte >= 0xa1 && byte <= 0xfe) {
			this.jis0212 = true;
			this.lead = byte;
			return CONTINUE;
		}

		if (this.lead !== 0) {
			const lead = this.lead;
			const index = this.jis0212 ? INDEX_JIS0212 : INDEX_JIS0208;

			this.lead = 0;
			this.jis0212 = false;

			if (lead >= 0xa1 && lead <= 0xfe && byte >= 0xa1 && byte <= 0xfe) {
				const cp = index.charCodeAt((lead - 0xa1) * 94 + byte - 0xa1);

				if (cp !== 0xfffd) return cp;
			}

			if (byte < 0x80) this.prepend.push(byte);

			return ERROR;
		}

		if (byte < 0x80) return byte;

		if (byte === 0x8e || byte === 0x8f || (byte >= 0xa1 && byte <= 0xfe)) {
			this.lead = byte;
			return CONTINUE;
		}

		return ERROR;
	}
}

registerEncoding('euc-jp', ['cseucpkdfmtjapanese', 'euc-jp', 'x-euc-jp'], () => new EucJpDecoder());
