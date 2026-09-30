// The URL standard's encoding pieces (https://url.spec.whatwg.org/#percent-encoded-bytes):
// the percent-encode sets, UTF-8 percent-encoding and decoding, code point handling for
// the parser, and the application/x-www-form-urlencoded parser and serializer that
// URLSearchParams uses. Code points are numbers; strings are walked by index, never with
// for...of (Porffor's for...of over a string yields UTF-16 units, not code points).

import { utf8Decoder, utf8Encoder } from './utf8.mjs';

/** An input string as code points: lone surrogates become U+FFFD (a USVString). */
export function codePoints(input) {
	const out = [];

	for (let i = 0; i < input.length; i++) {
		const unit = input.charCodeAt(i);

		if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < input.length) {
			const next = input.charCodeAt(i + 1);

			if (next >= 0xdc00 && next <= 0xdfff) {
				out.push(0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00));
				i++;
				continue;
			}
		}
		out.push(unit >= 0xd800 && unit <= 0xdfff ? 0xfffd : unit);
	}

	return out;
}

/** A string from code points. */
export function fromCodePoints(points) {
	let out = '';

	for (const point of points) out += String.fromCodePoint(point);

	return out;
}

/** A string as a USVString: lone surrogates replaced by U+FFFD. */
export function toUSVString(value) {
	// (a template, not String(): a symbol throws, as WebIDL's conversion does)
	return fromCodePoints(codePoints(`${value}`));
}

export const isAsciiDigit = (cp) => cp >= 0x30 && cp <= 0x39;
export const isAsciiHexDigit = (cp) =>
	isAsciiDigit(cp) || (cp >= 0x41 && cp <= 0x46) || (cp >= 0x61 && cp <= 0x66);
export const isAsciiAlpha = (cp) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
export const isAsciiAlphanumeric = (cp) => isAsciiAlpha(cp) || isAsciiDigit(cp);
export const toAsciiLower = (cp) => (cp >= 0x41 && cp <= 0x5a ? cp + 0x20 : cp);

// ---- percent-encode sets: whether a code point is in the set ----

export const C0_CONTROL = (cp) => cp < 0x20 || cp > 0x7e;
export const FRAGMENT = (cp) =>
	C0_CONTROL(cp) || cp === 0x20 || cp === 0x22 || cp === 0x3c || cp === 0x3e || cp === 0x60;
export const QUERY = (cp) =>
	C0_CONTROL(cp) || cp === 0x20 || cp === 0x22 || cp === 0x23 || cp === 0x3c || cp === 0x3e;
export const SPECIAL_QUERY = (cp) => QUERY(cp) || cp === 0x27;
export const PATH = (cp) =>
	QUERY(cp) || cp === 0x3f || cp === 0x5e || cp === 0x60 || cp === 0x7b || cp === 0x7d;
export const USERINFO = (cp) =>
	PATH(cp) ||
	cp === 0x2f ||
	cp === 0x3a ||
	cp === 0x3b ||
	cp === 0x3d ||
	cp === 0x40 ||
	(cp >= 0x5b && cp <= 0x5d) ||
	cp === 0x7c;
export const COMPONENT = (cp) =>
	USERINFO(cp) || (cp >= 0x24 && cp <= 0x26) || cp === 0x2b || cp === 0x2c;
export const FORM = (cp) =>
	COMPONENT(cp) || cp === 0x21 || (cp >= 0x27 && cp <= 0x29) || cp === 0x7e;

const HEX = '0123456789ABCDEF';
// (Porffor's own codecs: the globals may be the runtime's, not yet run when this module is)
const encoder = /* @__PURE__ */ utf8Encoder();
// UTF-8 decode without BOM: a leading U+FEFF is kept (a BOM in a query is data)
const decoder = /* @__PURE__ */ utf8Decoder({ ignoreBOM: true });

/** The code point, UTF-8 percent-encoded where `inSet` says. */
export function percentEncode(cp, inSet, spaceAsPlus = false) {
	if (spaceAsPlus && cp === 0x20) return '+';

	if (!inSet(cp)) return String.fromCodePoint(cp);
	const bytes = encoder.encode(String.fromCodePoint(cp));
	let out = '';

	for (const byte of bytes) out += '%' + HEX[byte >> 4] + HEX[byte & 15];

	return out;
}

/** A string, UTF-8 percent-encoded where `inSet` says. */
export function percentEncodeString(input, inSet, spaceAsPlus = false) {
	let out = '';

	for (const point of codePoints(input)) out += percentEncode(point, inSet, spaceAsPlus);

	return out;
}

const hexValue = (cp) => (isAsciiDigit(cp) ? cp - 0x30 : (cp | 0x20) - 0x57);

/** The bytes of a string's UTF-8 with each %XX turned into its byte. */
export function percentDecodeBytes(input) {
	const bytes = encoder.encode(input);
	const out = new Uint8Array(bytes.length);
	let count = 0;

	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];

		if (
			byte === 0x25 &&
			i + 2 < bytes.length &&
			isAsciiHexDigit(bytes[i + 1]) &&
			isAsciiHexDigit(bytes[i + 2])
		) {
			out[count++] = (hexValue(bytes[i + 1]) << 4) | hexValue(bytes[i + 2]);
			i += 2;
		} else out[count++] = byte;
	}

	return out.subarray(0, count);
}

/** A percent-decoded string, as UTF-8 (malformed sequences become U+FFFD). */
export function percentDecode(input) {
	return decoder.decode(percentDecodeBytes(input));
}

// ---- application/x-www-form-urlencoded ----

/** Name-value pairs from a query string ('+' is a space). */
export function parseForm(input) {
	const out = [];

	for (const sequence of input.split('&')) {
		if (sequence === '') continue;
		const at = sequence.indexOf('=');
		const name = at === -1 ? sequence : sequence.slice(0, at);
		const value = at === -1 ? '' : sequence.slice(at + 1);

		out.push([percentDecode(name.replaceAll('+', ' ')), percentDecode(value.replaceAll('+', ' '))]);
	}

	return out;
}

/** A query string from name-value pairs. */
export function serializeForm(pairs) {
	let out = '';

	for (const [name, value] of pairs) {
		if (out !== '') out += '&';
		out += percentEncodeString(name, FORM, true) + '=' + percentEncodeString(value, FORM, true);
	}

	return out;
}
