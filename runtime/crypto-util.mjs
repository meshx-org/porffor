// What the Web Crypto shim's algorithms share (subtle-crypto.mjs): bytes from a BufferSource,
// base64url for JWKs, a constant-time compare, algorithm names and the errors the spec throws.

import { DOMException } from './dom-exception.mjs';

/** A BufferSource's bytes, copied (the caller may change its buffer afterwards). */
export function toBytes(data) {
	if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));

	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

	throw new TypeError('The provided value is not of type (ArrayBuffer or ArrayBufferView)');
}

/** Bytes as an ArrayBuffer of their own, as every SubtleCrypto result is. */
export const toBuffer = (bytes) => bytes.slice().buffer;

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes as base64url, unpadded (a JWK's encoding). */
export function base64url(bytes) {
	let out = '';

	for (let i = 0; i < bytes.length; i += 3) {
		const group = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
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
		value = (value << 6) | index;
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

const NAMES = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512', 'HMAC', 'Ed25519'];

/** An algorithm identifier's canonical name (names match case-insensitively), or null. */
export function algorithmName(algorithm) {
	const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;

	if (typeof name !== 'string') throw new TypeError('Algorithm: name is missing');

	return NAMES.find((known) => known.toLowerCase() === name.toLowerCase()) ?? null;
}

export const notSupported = (message) => new DOMException(message, 'NotSupportedError');
export const invalidAccess = (message) => new DOMException(message, 'InvalidAccessError');
export const dataError = (message) => new DOMException(message, 'DataError');
export const syntaxError = (message) => new DOMException(message, 'SyntaxError');

/** Usages checked against those the key allows: a SyntaxError for any other. */
export function checkUsages(usages, allowed) {
	const list = Array.from(usages);

	for (const usage of list)
		if (!allowed.includes(usage)) throw syntaxError(`Cannot create a key with usage '${usage}'`);

	return list;
}
