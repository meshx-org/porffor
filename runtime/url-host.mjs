// The URL standard's host parser and serializer (https://url.spec.whatwg.org/#hosts-(domains-and-ip-addresses)):
// domains, IPv4 (with the hex and octal forms), IPv6 (with :: compression), and opaque
// hosts for non-special schemes. A host is kept serialized (a string); failure is null.
//
// Domain to ASCII is a subset of UTS #46: lowercasing (full Unicode, the fork's
// toLowerCase), the ideographic full stops as dots, and punycode for non-ASCII labels.
// Not here: UTS #46's mapping table (fullwidth letters, ß-style deviations, NFC), and its
// validity checks, which would need the Unicode data tables that make this large.

import {
	C0_CONTROL,
	codePoints,
	isAsciiDigit,
	isAsciiHexDigit,
	percentDecode,
	percentEncode
} from './url-encoding.mjs';

/** Forbidden host code points: never in any host. */
const forbiddenHost = (cp) =>
	cp === 0x00 ||
	cp === 0x09 ||
	cp === 0x0a ||
	cp === 0x0d ||
	cp === 0x20 ||
	cp === 0x23 ||
	cp === 0x2f ||
	cp === 0x3a ||
	cp === 0x3c ||
	cp === 0x3e ||
	cp === 0x3f ||
	cp === 0x40 ||
	cp === 0x5b ||
	cp === 0x5c ||
	cp === 0x5d ||
	cp === 0x5e ||
	cp === 0x7c;

/** Forbidden domain code points: the host ones, C0 controls, % and DEL. */
const forbiddenDomain = (cp) => forbiddenHost(cp) || cp <= 0x1f || cp === 0x25 || cp === 0x7f;

// ---- punycode (RFC 3492) ----

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

const digitChar = (digit) => String.fromCharCode(digit + (digit < 26 ? 97 : 22));

function adapt(delta, points, first) {
	let scaled = first ? Math.floor(delta / DAMP) : delta >> 1;

	scaled += Math.floor(scaled / points);
	let shift = 0;

	while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
		scaled = Math.floor(scaled / (BASE - T_MIN));
		shift += BASE;
	}

	return shift + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
}

/** A label's code points as punycode (without the xn-- prefix). */
function punycode(points) {
	let out = '';

	for (const cp of points) if (cp < 0x80) out += String.fromCharCode(cp);
	const basic = out.length;
	let handled = basic;

	if (basic > 0) out += '-';
	let next = INITIAL_N;
	let delta = 0;
	let bias = INITIAL_BIAS;

	while (handled < points.length) {
		let least = 0x10ffff + 1;

		for (const cp of points) if (cp >= next && cp < least) least = cp;
		delta += (least - next) * (handled + 1);
		next = least;

		for (const cp of points) {
			if (cp < next) delta++;

			if (cp !== next) continue;
			let rest = delta;

			for (let step = BASE; ; step += BASE) {
				let threshold = step - bias;

				if (threshold < T_MIN) threshold = T_MIN;
				else if (threshold > T_MAX) threshold = T_MAX;

				if (rest < threshold) break;
				out += digitChar(threshold + ((rest - threshold) % (BASE - threshold)));
				rest = Math.floor((rest - threshold) / (BASE - threshold));
			}
			out += digitChar(rest);
			bias = adapt(delta, handled + 1, handled === basic);
			delta = 0;
			handled++;
		}
		delta++;
		next++;
	}

	return out;
}

/** Domain to ASCII (the UTS #46 subset above); null on failure. */
function domainToASCII(domain) {
	const lowered = domain.toLowerCase();
	const labels = [];

	for (const label of lowered.replace(/[。．｡]/g, '.').split('.')) {
		const points = codePoints(label);

		labels.push(points.every((cp) => cp < 0x80) ? label : 'xn--' + punycode(points));
	}

	return labels.join('.');
}

// ---- IPv4 ----

/** An IPv4 number from one dotted part (0x hex, 0 octal, decimal); null when not one. */
function ipv4Number(part) {
	if (part === '') return null;
	let input = part;
	let radix = 10;

	if (input.length >= 2 && (input.startsWith('0x') || input.startsWith('0X'))) {
		input = input.slice(2);
		radix = 16;
	} else if (input.length >= 2 && input.startsWith('0')) {
		input = input.slice(1);
		radix = 8;
	}

	if (input === '') return 0;
	const valid = radix === 16 ? /^[\da-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^\d+$/;

	return valid.test(input) ? parseInt(input, radix) : null;
}

/** Whether a domain's last label is a number (so the host is parsed as IPv4). */
function endsInANumber(input) {
	const parts = input.split('.');

	if (parts[parts.length - 1] === '') {
		if (parts.length === 1) return false;
		parts.pop();
	}
	const last = parts[parts.length - 1];

	if (last !== '' && /^\d+$/.test(last)) return true;

	return ipv4Number(last) !== null;
}

/** An IPv4 address, serialized; null on failure. */
function parseIPv4(input) {
	const parts = input.split('.');

	if (parts[parts.length - 1] === '' && parts.length > 1) parts.pop();

	if (parts.length > 4) return null;
	const numbers = [];

	for (const part of parts) {
		const value = ipv4Number(part);

		if (value === null) return null;
		numbers.push(value);
	}

	for (let i = 0; i < numbers.length - 1; i++) if (numbers[i] > 255) return null;

	if (numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return null;
	let address = numbers[numbers.length - 1];

	for (let i = 0; i < numbers.length - 1; i++) address += numbers[i] * 256 ** (3 - i);
	const octets = [];

	for (let i = 0; i < 4; i++) {
		octets.unshift(address % 256);
		address = Math.floor(address / 256);
	}

	return octets.join('.');
}

// ---- IPv6 ----

/** An IPv6 address as eight 16-bit pieces; null on failure. */
function parseIPv6(input) {
	const address = [0, 0, 0, 0, 0, 0, 0, 0];
	const points = codePoints(input);
	let piece = 0;
	let compress = null;
	let at = 0;
	const cp = () => (at < points.length ? points[at] : -1);

	if (cp() === 0x3a) {
		if (points[at + 1] !== 0x3a) return null;
		at += 2;
		piece++;
		compress = piece;
	}

	while (cp() !== -1) {
		if (piece === 8) return null;

		if (cp() === 0x3a) {
			if (compress !== null) return null;
			at++;
			piece++;
			compress = piece;
			continue;
		}
		let value = 0;
		let length = 0;

		while (length < 4 && isAsciiHexDigit(cp())) {
			value = value * 16 + parseInt(String.fromCharCode(cp()), 16);
			at++;
			length++;
		}

		if (cp() === 0x2e) {
			if (length === 0 || piece > 6) return null;

			return embeddedIPv4(points, at - length, address, piece)
				? finish(address, piece + 2, compress)
				: null;
		} else if (cp() === 0x3a) {
			at++;

			if (cp() === -1) return null;
		} else if (cp() !== -1) return null;
		address[piece] = value;
		piece++;
	}

	return finish(address, piece, compress);
}

/** The dotted IPv4 tail of an IPv6 address, into address[piece] and address[piece + 1]. */
function embeddedIPv4(points, from, address, piece) {
	let at = from;
	let seen = 0;
	let slot = piece;

	while (at < points.length) {
		if (seen > 0) {
			if (points[at] !== 0x2e || seen >= 4) return false;
			at++;
		}

		if (!isAsciiDigit(points[at] ?? -1)) return false;
		let part = null;

		while (at < points.length && isAsciiDigit(points[at])) {
			const digit = points[at] - 0x30;

			if (part === 0) return false; // no leading zeros
			part = part === null ? digit : part * 10 + digit;

			if (part > 255) return false;
			at++;
		}
		address[slot] = address[slot] * 0x100 + part;
		seen++;

		if (seen === 2 || seen === 4) slot++;
	}

	return seen === 4;
}

/** Expands a :: compression; null when the address does not fill its eight pieces. */
function finish(address, pieces, compress) {
	if (compress === null) return pieces === 8 ? address : null;
	let piece = 7;
	let swaps = pieces - compress;

	while (piece !== 0 && swaps > 0) {
		const other = compress + swaps - 1;
		const held = address[piece];

		address[piece] = address[other];
		address[other] = held;
		piece--;
		swaps--;
	}

	return address;
}

/** An IPv6 address, serialized: lowercase hex, the first longest run of zeros as ::. */
function serializeIPv6(address) {
	let bestStart = -1;
	let bestLength = 1;

	for (let i = 0; i < 8;) {
		if (address[i] !== 0) {
			i++;
			continue;
		}
		let end = i;

		while (end < 8 && address[end] === 0) end++;

		if (end - i > bestLength) {
			bestStart = i;
			bestLength = end - i;
		}
		i = end;
	}
	let out = '';

	for (let i = 0; i < 8; i++) {
		if (i === bestStart) {
			out += i === 0 ? '::' : ':';
			i += bestLength - 1;
			continue;
		}
		out += address[i].toString(16);

		if (i !== 7) out += ':';
	}

	return out;
}

// ---- hosts ----

/**
 * Parses a host; null on failure.
 * @param {string} input
 * @param {boolean} isOpaque the URL's scheme is not special
 */
export function parseHost(input, isOpaque) {
	if (input.startsWith('[')) {
		if (!input.endsWith(']')) return null;
		const address = parseIPv6(input.slice(1, -1));

		return address === null ? null : '[' + serializeIPv6(address) + ']';
	}

	if (isOpaque) {
		const points = codePoints(input);

		if (points.some((cp) => cp !== 0x25 && forbiddenHost(cp))) return null;
		let out = '';

		for (const cp of points) out += percentEncode(cp, C0_CONTROL);

		return out;
	}
	const ascii = domainToASCII(percentDecode(input));

	if (ascii === null || ascii === '') return null;

	if (codePoints(ascii).some(forbiddenDomain)) return null;

	return endsInANumber(ascii) ? parseIPv4(ascii) : ascii;
}
