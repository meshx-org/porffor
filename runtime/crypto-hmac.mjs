// HMAC for the Web Crypto shim (https://w3c.github.io/webcrypto/#hmac), over @noble/hashes:
// generateKey, importKey and exportKey ('raw', 'raw-secret', 'jwk'), sign and verify. Loaded
// (runtime/globals.json) only into a program that names 'HMAC'; it registers itself with
// SubtleCrypto.

import { hmac } from '@noble/hashes/hmac.js';
import { makeKey } from './crypto-key.mjs';
import {
	base64url,
	checkJwk,
	checkUsages,
	constantTimeEqual,
	dataError,
	fromBase64url,
	jwkCommon,
	notSupported,
	operationError
} from './crypto-util.mjs';
import { hashFunction, registerAlgorithm } from './subtle-crypto.mjs';

/** A JWK's `alg` for an HMAC key, by hash. */
const JWK_ALG = { 'SHA-1': 'HS1', 'SHA-256': 'HS256', 'SHA-384': 'HS384', 'SHA-512': 'HS512' };

const USAGES = ['sign', 'verify'];

/** The length in bits of a key for the hash when none is given: its block size. */
const blockBits = (hash) => hashFunction(hash).blockLen * 8;

/** A secret HMAC key over the given bytes (length in bits). */
const hmacKey = (hash, length, material, extractable, usages) =>
	makeKey(
		'secret',
		extractable,
		{ name: 'HMAC', length, hash: { name: hash.name } },
		usages,
		material
	);

/** generateKey: random bits, as many as the hash's block unless `length` says. */
function generateKey(algorithm, extractable, usages) {
	checkUsages(usages, USAGES);
	let length = blockBits(algorithm.hash);

	if (algorithm.length !== undefined) {
		if (algorithm.length === 0) throw operationError('HMAC: the length cannot be 0');
		length = algorithm.length;
	}

	const material = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 8)));

	return hmacKey(algorithm.hash, length, material, extractable, usages);
}

/** importKey 'raw', 'raw-secret' or 'jwk' (kty oct). */
function importKey(format, keyData, algorithm, extractable, usages) {
	checkUsages(usages, USAGES);
	let material;

	if (format === 'raw' || format === 'raw-secret') material = keyData;
	else if (format === 'jwk') {
		if (keyData.kty !== 'oct') throw dataError("JWK: kty must be 'oct'");

		if (keyData.k === undefined) throw dataError('JWK: k is missing');
		material = fromBase64url(keyData.k);

		if (keyData.alg !== undefined && keyData.alg !== JWK_ALG[algorithm.hash.name])
			throw dataError('JWK: alg does not match the hash');
		checkJwk(keyData, { kty: 'oct', use: 'sig', usages, extractable });
	} else throw notSupported(`HMAC: unsupported key format '${format}'`);

	let length = material.length * 8;

	if (length === 0) throw dataError('HMAC: the key is empty');

	if (algorithm.length !== undefined) {
		if (algorithm.length > length || algorithm.length <= length - 8)
			throw dataError('HMAC: the length does not match the key');
		length = algorithm.length;
	}

	return hmacKey(algorithm.hash, length, material, extractable, usages);
}

/** exportKey 'raw', 'raw-secret' or 'jwk'. */
function exportKey(format, key) {
	if (format === 'raw' || format === 'raw-secret') return key._material.slice().buffer;

	if (format === 'jwk')
		return {
			...jwkCommon(key),
			alg: JWK_ALG[key._algorithm.hash.name],
			kty: 'oct',
			k: base64url(key._material)
		};

	throw notSupported(`HMAC: unsupported key format '${format}'`);
}

/** The MAC of data under the key. */
const sign = (algorithm, key, data) => hmac(hashFunction(key._algorithm.hash), key._material, data);

/** deriveKey's length for an HMAC key: `length`, else the hash's block size. */
function getKeyLength(algorithm) {
	if (algorithm.length === undefined) return blockBits(algorithm.hash);

	if (algorithm.length === 0) throw new TypeError('HMAC: the length cannot be 0');

	return algorithm.length;
}

const KEY_PARAMS = { hash: 'hash!', length: 'ulong' };

registerAlgorithm({
	name: 'HMAC',
	params: {
		generateKey: KEY_PARAMS,
		importKey: KEY_PARAMS,
		getKeyLength: KEY_PARAMS,
		sign: {},
		verify: {}
	},
	generateKey,
	importKey,
	exportKey,
	sign,
	verify: (algorithm, key, signature, data) =>
		constantTimeEqual(sign(algorithm, key, data), signature),
	getKeyLength,
	checkGenerateKey(algorithm) {
		if (algorithm.length === 0) throw operationError('HMAC: the length cannot be 0');
	},
	checkImport(algorithm) {
		if (algorithm.length === 0) throw dataError('HMAC: the length cannot be 0');
	},
	// a shared key of `bits` bits (encapsulateKey): the length, if given, must be it
	checkSecret(algorithm, bits) {
		if (algorithm.length !== undefined && algorithm.length !== bits)
			throw dataError('HMAC: the length does not match the key');
	}
});
