// EUC-KR (https://encoding.spec.whatwg.org/#euc-kr), registered with TextDecoder. Loaded only
// when a program names one of its labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';
import { INDEX_EUC_KR } from './index-euc-kr.mjs';

/** The EUC-KR decoder (https://encoding.spec.whatwg.org/#euc-kr-decoder). */
class EucKrDecoder {
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

			this.lead = 0;

			if (byte >= 0x41 && byte <= 0xfe) {
				const cp = INDEX_EUC_KR.charCodeAt((lead - 0x81) * 190 + byte - 0x41);

				if (cp !== 0xfffd) return cp;
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
	'euc-kr',
	[
		'cseuckr',
		'csksc56011987',
		'euc-kr',
		'iso-ir-149',
		'korean',
		'ks_c_5601-1987',
		'ks_c_5601-1989',
		'ksc5601',
		'ksc_5601',
		'windows-949'
	],
	() => new EucKrDecoder()
);
