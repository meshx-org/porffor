// ISO-2022-JP (https://encoding.spec.whatwg.org/#iso-2022-jp), registered with TextDecoder.
// Loaded only when a program names one of its labels (runtime/globals.json).

import { CONTINUE, EOF, ERROR, FINISHED, registerEncoding } from './decoder.mjs';
import { INDEX_JIS0208 } from './index-jis0208.mjs';

// the decoder's states
const ASCII = 0;
const ROMAN = 1;
const KATAKANA = 2;
const LEAD_BYTE = 3;
const TRAIL_BYTE = 4;
const ESCAPE_START = 5;
const ESCAPE = 6;

/** The ISO-2022-JP decoder (https://encoding.spec.whatwg.org/#iso-2022-jp-decoder). */
class Iso2022JpDecoder {
	constructor() {
		this.state = ASCII;
		this.outputState = ASCII;
		this.lead = 0;
		this.output = false;
		this.prepend = [];
	}

	step(byte) {
		switch (this.state) {
			case ASCII:
				if (byte === 0x1b) {
					this.state = ESCAPE_START;
					return CONTINUE;
				}

				if (byte === EOF) return FINISHED;
				this.output = false;

				if (byte <= 0x7f && byte !== 0x0e && byte !== 0x0f) return byte;

				return ERROR;
			case ROMAN:
				if (byte === 0x1b) {
					this.state = ESCAPE_START;
					return CONTINUE;
				}

				if (byte === EOF) return FINISHED;
				this.output = false;

				if (byte === 0x5c) return 0xa5;

				if (byte === 0x7e) return 0x203e;

				if (byte <= 0x7f && byte !== 0x0e && byte !== 0x0f) return byte;

				return ERROR;
			case KATAKANA:
				if (byte === 0x1b) {
					this.state = ESCAPE_START;
					return CONTINUE;
				}

				if (byte === EOF) return FINISHED;
				this.output = false;

				if (byte >= 0x21 && byte <= 0x5f) return 0xff61 - 0x21 + byte;

				return ERROR;
			case LEAD_BYTE:
				if (byte === 0x1b) {
					this.state = ESCAPE_START;
					return CONTINUE;
				}

				if (byte === EOF) return FINISHED;
				this.output = false;

				if (byte >= 0x21 && byte <= 0x7e) {
					this.lead = byte;
					this.state = TRAIL_BYTE;
					return CONTINUE;
				}

				return ERROR;
			case TRAIL_BYTE:
				if (byte === 0x1b) {
					this.state = ESCAPE_START;
					return ERROR;
				}
				this.state = LEAD_BYTE;

				if (byte === EOF) {
					// the end is read again, in the lead byte state
					this.prepend.push(EOF);
					return ERROR;
				}

				if (byte >= 0x21 && byte <= 0x7e) {
					const cp = INDEX_JIS0208.charCodeAt((this.lead - 0x21) * 94 + byte - 0x21);

					return cp === 0xfffd ? ERROR : cp;
				}

				return ERROR;
			case ESCAPE_START:
				if (byte === 0x24 || byte === 0x28) {
					this.lead = byte;
					this.state = ESCAPE;
					return CONTINUE;
				}
				this.prepend.push(byte);
				this.output = false;
				this.state = this.outputState;
				return ERROR;
			default: {
				// ESCAPE
				const lead = this.lead;
				let state = -1;

				this.lead = 0;

				if (lead === 0x28 && byte === 0x42) state = ASCII;
				else if (lead === 0x28 && byte === 0x4a) state = ROMAN;
				else if (lead === 0x28 && byte === 0x49) state = KATAKANA;
				else if (lead === 0x24 && (byte === 0x40 || byte === 0x42)) state = LEAD_BYTE;

				if (state !== -1) {
					const output = this.output;

					this.state = state;
					this.outputState = state;
					this.output = true;

					return output ? ERROR : CONTINUE;
				}
				this.prepend.push(lead, byte);
				this.output = false;
				this.state = this.outputState;
				return ERROR;
			}
		}
	}
}

registerEncoding('iso-2022-jp', ['csiso2022jp', 'iso-2022-jp'], () => new Iso2022JpDecoder());
