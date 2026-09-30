// What the Web Crypto shim's algorithms share (subtle-crypto.mjs): bytes from a BufferSource,
// base64url for JWKs, a constant-time compare, WebIDL's conversions of the values SubtleCrypto
// takes (https://webidl.spec.whatwg.org/#es-type-mapping), JWK checks and the errors the spec
// throws.

import { DOMException } from './dom-exception.mjs';

export const notSupported = (message) => new DOMException(message, 'NotSupportedError');
export const invalidAccess = (message) => new DOMException(message, 'InvalidAccessError');
export const dataError = (message) => new DOMException(message, 'DataError');
export const syntaxError = (message) => new DOMException(message, 'SyntaxError');
export const operationError = (message) => new DOMException(message, 'OperationError');

/** Whether a value is an ArrayBuffer or a view of one (a BufferSource), not a shared one. */
export function isBufferSource(value) {
	if (value instanceof ArrayBuffer) return true;

	return ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer;
}

/** A BufferSource's bytes, copied (the caller may change its buffer afterwards); none if detached. */
export function toBytes(data) {
	// (a detached buffer, or a view of one, has no bytes, and slicing it would throw)
	if (data.byteLength === 0 && isBufferSource(data)) return new Uint8Array(0);

	if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));

	if (isBufferSource(data))
		return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

	throw new TypeError('The provided value is not of type (ArrayBuffer or ArrayBufferView)');
}

/** Bytes as an ArrayBuffer of their own, as every SubtleCrypto result is. */
export const toBuffer = (bytes) => bytes.slice().buffer;

/** Byte arrays joined. */
export function concatBytes(...parts) {
	let length = 0;

	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;

	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}

	return out;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes as base64url, unpadded (a JWK's encoding). */
export function base64url(bytes) {
	let out = '';

	for (let i = 0; i < bytes.length; i += 3) {
		// (bounds checked here, not by reading past the end: Porffor reads a subarray's
		// out-of-range index from the buffer behind it)
		const second = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const third = i + 2 < bytes.length ? bytes[i + 2] : 0;
		const group = (bytes[i] << 16) | (second << 8) | third;
		const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;

		for (let at = 0; at < chars; at++) out += BASE64URL[(group >> (18 - at * 6)) & 63];
	}

	return out;
}

/** base64url (padding allowed) as bytes; a DataError for anything else. */
export function fromBase64url(text) {
	if (typeof text !== 'string') throw dataError('The JWK member is not a string');
	const clean = text.replace(/=+$/, '');
	const out = [];
	let bits = 0;
	let value = 0;

	for (const char of clean) {
		const index = BASE64URL.indexOf(char);

		if (index < 0) throw dataError('The JWK member is not base64url');
		value = ((value << 6) | index) & 0xffff;
		bits += 6;

		if (bits >= 8) {
			bits -= 8;
			out.push((value >> bits) & 255);
		}
	}

	return new Uint8Array(out);
}

/** Whether two byte arrays are equal, in time that depends only on their lengths. */
export function constantTimeEqual(left, right) {
	if (left.length !== right.length) return false;
	let diff = 0;

	for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];

	return diff === 0;
}

/** A name in ASCII upper case: algorithm names match ASCII case-insensitively only. */
export function asciiUpper(text) {
	let out = '';

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);

		out += code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : text[i];
	}

	return out;
}

// WebIDL's conversions (the [EnforceRange] integers, DOMString, BufferSource, the dictionaries):
// a failure is a TypeError

/** WebIDL DOMString. */
export function idlString(value) {
	if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');

	return String(value);
}

/** An [EnforceRange] integer of at most `max`: a TypeError for anything out of range. */
export function enforceRange(value, max, what) {
	const number = Number(value);

	if (!Number.isFinite(number)) throw new TypeError(`${what} is not a finite number`);
	const whole = Math.trunc(number);

	if (whole < 0 || whole > max) throw new TypeError(`${what} is out of range`);

	return whole === 0 ? 0 : whole;
}

/** The values a KeyUsage can have. */
export const KEY_USAGES = [
	'encrypt',
	'decrypt',
	'sign',
	'verify',
	'deriveKey',
	'deriveBits',
	'wrapKey',
	'unwrapKey',
	'encapsulateKey',
	'encapsulateBits',
	'decapsulateKey',
	'decapsulateBits'
];

/** WebIDL sequence<KeyUsage>: an iterable of known usages, else a TypeError. */
export function idlUsages(value) {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
		throw new TypeError('keyUsages is not a sequence');
	const out = [];

	for (const item of value) {
		const usage = idlString(item);

		if (!KEY_USAGES.includes(usage)) throw new TypeError(`'${usage}' is not a KeyUsage`);
		out.push(usage);
	}

	return out;
}

/** Usages checked against those the key allows: a SyntaxError for any other. */
export function checkUsages(usages, allowed) {
	for (const usage of usages)
		if (!allowed.includes(usage)) throw syntaxError(`Cannot create a key with usage '${usage}'`);

	return usages;
}

// The JsonWebKey dictionary's members (https://w3c.github.io/webcrypto/#JsonWebKey-dictionary),
// with the post-quantum drafts' pub and priv, and what each converts to
const JWK_MEMBERS = [
	'alg',
	'crv',
	'd',
	'dp',
	'dq',
	'e',
	'ext',
	'k',
	'key_ops',
	'kty',
	'n',
	'oth',
	'p',
	'priv',
	'pub',
	'q',
	'qi',
	'use',
	'x',
	'y'
];

/** WebIDL JsonWebKey: the members present, converted (a TypeError if one cannot be). */
export function idlJwk(value) {
	if (value === undefined || value === null) return {};

	if (typeof value !== 'object' && typeof value !== 'function')
		throw new TypeError('The key data is not a JsonWebKey');
	const jwk = {};

	for (const member of JWK_MEMBERS) {
		const item = value[member];

		if (item === undefined) continue;

		if (member === 'ext') jwk.ext = Boolean(item);
		else if (member === 'key_ops') {
			if (item === null || typeof item !== 'object')
				throw new TypeError('key_ops is not a sequence');
			jwk.key_ops = Array.from(item, idlString);
		} else if (member === 'oth') {
			if (item === null || typeof item !== 'object') throw new TypeError('oth is not a sequence');
			jwk.oth = Array.from(item);
		} else jwk[member] = idlString(item);
	}

	return jwk;
}

/**
 * The checks every JWK import makes (https://w3c.github.io/webcrypto/#hmac-operations-import-key
 * and alike): kty, use, key_ops and ext against the key asked for; a DataError otherwise.
 * @param {object} jwk a converted JsonWebKey
 * @param {{ kty: string, use?: string, usages: string[], extractable: boolean }} expected
 */
export function checkJwk(jwk, expected) {
	if (jwk.kty !== expected.kty) throw dataError(`JWK: kty must be '${expected.kty}'`);

	if (expected.usages.length > 0 && jwk.use !== undefined && jwk.use !== expected.use)
		throw dataError(`JWK: use must be '${expected.use}'`);

	if (jwk.key_ops !== undefined) {
		if (new Set(jwk.key_ops).size !== jwk.key_ops.length)
			throw dataError('JWK: key_ops has a duplicate');

		for (const usage of expected.usages)
			if (!jwk.key_ops.includes(usage)) throw dataError(`JWK: key_ops does not allow ${usage}`);
	}

	if (jwk.ext === false && expected.extractable) throw dataError('JWK: the key is not extractable');
}

/** The members a JWK export starts with: key_ops and ext. */
export const jwkCommon = (key) => ({ key_ops: key.usages.slice(), ext: key.extractable });

/** Bits of a secret, the first `length` of them (all of it for null): an OperationError for more. */
export function truncateBits(secret, length) {
	if (length === null) return secret;

	if (length > secret.length * 8) throw operationError('The length is more than the secret has');
	const out = secret.slice(0, Math.ceil(length / 8));

	if (length % 8 !== 0) out[out.length - 1] &= 0xff << (8 - (length % 8));

	return out;
}
