// HMAC for the Web Crypto shim (https://w3c.github.io/webcrypto/#hmac), over @noble/hashes:
// generateKey, importKey and exportKey ('raw', 'jwk'), sign and verify.

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { CryptoKey, KEY_TOKEN } from './crypto-key.mjs';
import {
	algorithmName,
	base64url,
	checkUsages,
	constantTimeEqual,
	dataError,
	fromBase64url,
	notSupported,
	syntaxError,
	toBuffer,
	toBytes
} from './crypto-util.mjs';

/** The hash functions, by name. */
export const HASHES = { 'SHA-1': sha1, 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 };

/** A JWK's `alg` for an HMAC key, by hash. */
const JWK_ALG = { 'SHA-1': 'HS1', 'SHA-256': 'HS256', 'SHA-384': 'HS384', 'SHA-512': 'HS512' };

const USAGES = ['sign', 'verify'];

/** The hash an HMAC algorithm names: 'SHA-1' to 'SHA-512'. */
function hashName(algorithm) {
	if (algorithm?.hash === undefined) throw new TypeError('HmacKeyGenParams: hash is missing');
	const name = algorithmName(algorithm.hash);

	if (!name || !(name in HASHES)) throw notSupported('HMAC: unsupported hash');

	return name;
}

/** A secret HMAC key over the given bytes. */
function makeKey(hash, material, extractable, usages) {
	return new CryptoKey(KEY_TOKEN, {
		type: 'secret',
		extractable,
		algorithm: { name: 'HMAC', length: material.length * 8, hash: { name: hash } },
		usages,
		material
	});
}

/** generateKey: random bytes, as many as the hash's block unless `length` (bits) says. */
export function generateHmacKey(algorithm, extractable, usages) {
	const hash = hashName(algorithm);
	const allowed = checkUsages(usages, USAGES);

	if (allowed.length === 0) throw syntaxError('Usages cannot be empty');
	const bits =
		algorithm.length === undefined ? HASHES[hash].blockLen * 8 : Number(algorithm.length);

	if (!(bits > 0) || bits % 8 !== 0) throw notSupported('HMAC: the length must be whole bytes');

	return makeKey(hash, crypto.getRandomValues(new Uint8Array(bits / 8)), extractable, allowed);
}

/** importKey 'raw' or 'jwk' (kty oct). */
export function importHmacKey(format, keyData, algorithm, extractable, usages) {
	const hash = hashName(algorithm);
	const allowed = checkUsages(usages, USAGES);
	let material;

	if (format === 'raw') material = toBytes(keyData);
	else if (format === 'jwk') {
		if (keyData?.kty !== 'oct') throw dataError("JWK: kty must be 'oct'");

		if (keyData.alg !== undefined && keyData.alg !== JWK_ALG[hash])
			throw dataError('JWK: alg does not match the hash');
		material = fromBase64url(keyData.k);
	} else throw notSupported(`HMAC: unsupported key format '${format}'`);

	if (material.length === 0) throw dataError('HMAC: the key is empty');

	return makeKey(hash, material, extractable, allowed);
}

/** exportKey 'raw' or 'jwk'. */
export function exportHmacKey(format, key) {
	if (format === 'raw') return toBuffer(key._material);

	if (format === 'jwk')
		return {
			key_ops: key.usages,
			ext: key.extractable,
			alg: JWK_ALG[key.algorithm.hash.name],
			kty: 'oct',
			k: base64url(key._material)
		};

	throw notSupported(`HMAC: unsupported key format '${format}'`);
}

/** The MAC of data under the key. */
export const hmacSign = (key, data) =>
	toBuffer(hmac(HASHES[key.algorithm.hash.name], key._material, toBytes(data)));

/** Whether signature is data's MAC under the key (compared in constant time). */
export const hmacVerify = (key, signature, data) =>
	constantTimeEqual(new Uint8Array(hmacSign(key, data)), toBytes(signature));
