// DER (ITU-T X.690) as the Web Crypto shim's key formats need it: SubjectPublicKeyInfo ('spki',
// RFC 5280) and PrivateKeyInfo ('pkcs8', RFC 5208) around EC, OKP and RSA keys. A strict
// reader (definite lengths, minimal encodings, nothing left over: anything else is a DataError)
// and a writer.

import { concatBytes, dataError } from './crypto-util.mjs';

export const SEQUENCE = 0x30;
export const INTEGER = 0x02;
export const BIT_STRING = 0x03;
export const OCTET_STRING = 0x04;
export const NULL = 0x05;
export const OID = 0x06;

/** The element at `at`: { tag, content, end }. */
function element(bytes, at) {
	if (at + 2 > bytes.length) throw dataError('DER: truncated');
	const tag = bytes[at];
	let length = bytes[at + 1];
	let start = at + 2;

	if (length & 0x80) {
		const count = length & 0x7f;

		if (count === 0 || count > 4 || start + count > bytes.length)
			throw dataError('DER: bad length');
		length = 0;

		for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];

		// DER: the shortest form
		if (length < 0x80 || bytes[start] === 0) throw dataError('DER: length not minimal');
		start += count;
	}

	if (start + length > bytes.length) throw dataError('DER: truncated');

	return { tag, content: bytes.subarray(start, start + length), end: start + length };
}

/**
 * The elements of DER bytes, each { tag, content }, all of the bytes used.
 * @param {Uint8Array} bytes
 * @returns {{ tag: number, content: Uint8Array }[]}
 */
export function derElements(bytes) {
	const out = [];
	let at = 0;

	while (at < bytes.length) {
		const found = element(bytes, at);

		out.push(found);
		at = found.end;
	}

	return out;
}

/** The one element the bytes are, of the tag: a DataError for anything else. */
export function derExpect(bytes, tag) {
	const found = derElements(bytes);

	if (found.length !== 1 || found[0].tag !== tag) throw dataError('DER: unexpected element');

	return found[0].content;
}

/** A SEQUENCE's elements, checking the tags given (a trailing element may be optional). */
export function derSequence(bytes, tags) {
	const found = derElements(derExpect(bytes, SEQUENCE));

	for (let i = 0; i < tags.length && i < found.length; i++)
		if (found[i].tag !== tags[i]) throw dataError('DER: unexpected element');

	return found;
}

/** An OID's content as dotted text. */
export function oidText(content) {
	const values = [];
	let value = 0;

	for (let i = 0; i < content.length; i++) {
		value = value * 128 + (content[i] & 0x7f);

		if (!(content[i] & 0x80)) {
			values.push(value);
			value = 0;
		}
	}

	if (values.length === 0 || content[content.length - 1] & 0x80) throw dataError('DER: bad OID');
	// the first subidentifier holds the first two arcs
	const first = Math.min(Math.floor(values[0] / 40), 2);

	return [first, values[0] - first * 40, ...values.slice(1)].join('.');
}

/** A BIT STRING's bytes (whole bytes only: its unused-bits count must be 0). */
export function bitStringBytes(content) {
	if (content.length === 0 || content[0] !== 0) throw dataError('DER: bad BIT STRING');

	return content.subarray(1);
}

/** An element: tag, length, content. */
export function der(tag, ...contents) {
	const content = concatBytes(...contents);
	const length = content.length;
	let header;

	if (length < 0x80) header = [tag, length];
	else {
		const lengthBytes = [];

		for (let rest = length; rest > 0; rest = Math.floor(rest / 256))
			lengthBytes.unshift(rest % 256);
		header = [tag, 0x80 | lengthBytes.length, ...lengthBytes];
	}

	return concatBytes(new Uint8Array(header), content);
}

/** An OID element from dotted text. */
export function derOid(text) {
	const parts = text.split('.').map(Number);
	const bytes = [parts[0] * 40 + parts[1]];

	for (const part of parts.slice(2)) {
		const groups = [part & 0x7f];

		for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128))
			groups.unshift((rest & 0x7f) | 0x80);
		bytes.push(...groups);
	}

	return der(OID, new Uint8Array(bytes));
}

/** An unsigned big-endian INTEGER element (a leading zero added when the top bit is set). */
export function derUnsigned(bytes) {
	let start = 0;

	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	const trimmed = bytes.subarray(start);

	return trimmed[0] & 0x80 ? der(INTEGER, new Uint8Array([0]), trimmed) : der(INTEGER, trimmed);
}

/** An INTEGER's content as unsigned big-endian bytes (no leading zero); negative is a DataError. */
export function unsignedBytes(content) {
	if (content.length === 0 || content[0] & 0x80) throw dataError('DER: bad INTEGER');

	if (content.length > 1 && content[0] === 0 && !(content[1] & 0x80))
		throw dataError('DER: INTEGER not minimal');

	return content[0] === 0 && content.length > 1 ? content.slice(1) : content.slice();
}

/** A SubjectPublicKeyInfo: the algorithm identifier's elements and the key's bytes. */
export function parseSpki(bytes) {
	const [algorithm, key] = derSequence(bytes, [SEQUENCE, BIT_STRING]);

	if (key === undefined || derElements(bytes).length !== 1) throw dataError('spki: malformed');
	const identifier = derElements(algorithm.content);

	if (identifier.length === 0 || identifier[0].tag !== OID) throw dataError('spki: malformed');

	return {
		oid: oidText(identifier[0].content),
		params: identifier[1],
		key: bitStringBytes(key.content)
	};
}

/** A PrivateKeyInfo: the algorithm identifier's elements and the private key's bytes. */
export function parsePkcs8(bytes) {
	const found = derSequence(bytes, [INTEGER, SEQUENCE, OCTET_STRING]);

	if (found.length < 3) throw dataError('pkcs8: malformed');
	const version = found[0].content;

	if (version.length !== 1 || version[0] > 1) throw dataError('pkcs8: unknown version');
	const identifier = derElements(found[1].content);

	if (identifier.length === 0 || identifier[0].tag !== OID) throw dataError('pkcs8: malformed');

	return { oid: oidText(identifier[0].content), params: identifier[1], key: found[2].content };
}

/** A SubjectPublicKeyInfo from its algorithm identifier's elements and the key. */
export const spki = (identifier, key) =>
	der(SEQUENCE, der(SEQUENCE, ...identifier), der(BIT_STRING, new Uint8Array([0]), key));

/** A PrivateKeyInfo (version 0) from its algorithm identifier's elements and the key. */
export const pkcs8 = (identifier, key) =>
	der(
		SEQUENCE,
		der(INTEGER, new Uint8Array([0])),
		der(SEQUENCE, ...identifier),
		der(OCTET_STRING, key)
	);
