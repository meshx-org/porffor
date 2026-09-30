// KMAC128 and KMAC256 for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/#kmac), over @noble/hashes: generateKey,
// importKey and exportKey ('raw-secret', 'jwk' with alg K128 or K256), sign and verify with an
// outputLength and an optional customization. Loaded (runtime/globals.json) only into a program
// that names one of them.

import { kmac128, kmac256 } from '@noble/hashes/sha3-addons.js';
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
import { registerAlgorithm } from './subtle-crypto.mjs';

const USAGES = ['sign', 'verify'];

/**
 * Registers one KMAC.
 * @param {string} name
 * @param {typeof kmac128} mac
 * @param {number} defaultLength a generated key's bits when no length is given
 */
function registerKmac(name, mac, defaultLength) {
	const jwkAlg = `K${name.slice(4)}`;

	const kmacKey = (length, material, extractable, usages) =>
		makeKey('secret', extractable, { name, length }, usages, material);

	function generateKey(algorithm, extractable, usages) {
		checkUsages(usages, USAGES);
		const length = algorithm.length ?? defaultLength;

		if (length === 0 || length % 8 !== 0)
			throw operationError(`${name}: the length must be a positive multiple of 8`);

		return kmacKey(length, crypto.getRandomValues(new Uint8Array(length / 8)), extractable, usages);
	}

	function importKey(format, keyData, algorithm, extractable, usages) {
		checkUsages(usages, USAGES);
		let material;

		if (format === 'raw-secret') material = keyData;
		else if (format === 'jwk') {
			if (keyData.kty !== 'oct') throw dataError("JWK: kty must be 'oct'");

			if (keyData.k === undefined) throw dataError('JWK: k is missing');
			material = fromBase64url(keyData.k);

			if (keyData.alg !== undefined && keyData.alg !== jwkAlg)
				throw dataError(`JWK: alg must be ${jwkAlg}`);
			checkJwk(keyData, { kty: 'oct', use: 'sig', usages, extractable });
		} else throw notSupported(`${name}: unsupported key format '${format}'`);
		const length = material.length * 8;

		if (length === 0) throw dataError(`${name}: the key is empty`);

		if (algorithm.length !== undefined && algorithm.length !== length)
			throw dataError(`${name}: the length does not match the key`);

		return kmacKey(length, material, extractable, usages);
	}

	function exportKey(format, key) {
		if (format === 'raw-secret') return key._material.slice().buffer;

		if (format === 'jwk')
			return { ...jwkCommon(key), alg: jwkAlg, kty: 'oct', k: base64url(key._material) };

		throw notSupported(`${name}: unsupported key format '${format}'`);
	}

	function sign(algorithm, key, data) {
		if (algorithm.outputLength % 8 !== 0)
			throw operationError(`${name}: the output length must be a multiple of 8`);

		if (algorithm.outputLength === 0) return new Uint8Array(0);

		return mac(key._material, data, {
			dkLen: algorithm.outputLength / 8,
			personalization: algorithm.customization
		});
	}

	const keyParams = { length: 'ulong' };
	const macParams = { customization: 'buffer', outputLength: 'ulong!' };

	registerAlgorithm({
		name,
		params: {
			generateKey: keyParams,
			importKey: keyParams,
			getKeyLength: keyParams,
			sign: macParams,
			verify: macParams
		},
		generateKey,
		importKey,
		exportKey,
		sign,
		verify: (algorithm, key, signature, data) =>
			constantTimeEqual(sign(algorithm, key, data), signature),
		getKeyLength: (algorithm) => algorithm.length ?? defaultLength,
		checkSecret(algorithm, bits) {
			if (algorithm.length !== undefined && algorithm.length !== bits)
				throw dataError(`${name}: the length does not match the key`);
		}
	});
}

registerKmac('KMAC128', kmac128, 128);
registerKmac('KMAC256', kmac256, 256);
