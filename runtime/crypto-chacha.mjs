// ChaCha20-Poly1305 for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/#chacha20-poly1305), over @noble/ciphers:
// 256-bit keys, imported and exported as 'raw-secret' and 'jwk' (alg C20P), and RFC 8439's AEAD
// with a 96-bit iv and a 128-bit tag. Loaded (runtime/globals.json) only into a program that
// names it.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { makeKey } from './crypto-key.mjs';
import {
	base64url,
	checkJwk,
	checkUsages,
	dataError,
	fromBase64url,
	jwkCommon,
	notSupported,
	operationError
} from './crypto-util.mjs';
import { registerAlgorithm } from './subtle-crypto.mjs';

const NAME = 'ChaCha20-Poly1305';
const USAGES = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'];
const KEY_BYTES = 32;

const chachaKey = (material, extractable, usages) =>
	makeKey('secret', extractable, { name: NAME }, usages, material);

function importKey(format, keyData, _algorithm, extractable, usages) {
	checkUsages(usages, USAGES);
	let material;

	if (format === 'raw-secret') material = keyData;
	else if (format === 'jwk') {
		if (keyData.kty !== 'oct') throw dataError("JWK: kty must be 'oct'");

		if (keyData.k === undefined) throw dataError('JWK: k is missing');
		material = fromBase64url(keyData.k);

		if (keyData.alg !== undefined && keyData.alg !== 'C20P')
			throw dataError('JWK: alg must be C20P');
		checkJwk(keyData, { kty: 'oct', use: 'enc', usages, extractable });
	} else throw notSupported(`${NAME}: unsupported key format '${format}'`);

	if (material.length !== KEY_BYTES) throw dataError(`${NAME}: the key must be 256 bits`);

	return chachaKey(material, extractable, usages);
}

function exportKey(format, key) {
	if (format === 'raw-secret') return key._material.slice().buffer;

	if (format === 'jwk')
		return { ...jwkCommon(key), alg: 'C20P', kty: 'oct', k: base64url(key._material) };

	throw notSupported(`${NAME}: unsupported key format '${format}'`);
}

/** The AEAD's parameters: a 96-bit iv, a 128-bit tag. */
function check(algorithm) {
	if (algorithm.iv.length !== 12) throw operationError(`${NAME}: the iv must be 96 bits`);

	if (algorithm.tagLength !== undefined && algorithm.tagLength !== 128)
		throw operationError(`${NAME}: the tag length must be 128`);
}

/** The AEAD for the key and parameters. */
function cipher(algorithm, key) {
	check(algorithm);

	return chacha20poly1305(key._material, algorithm.iv, algorithm.additionalData);
}

/** Runs the AEAD, its failures (a wrong tag) an OperationError. */
function sealed(run) {
	try {
		return run();
	} catch {
		throw operationError(`${NAME}: the operation failed`);
	}
}

const AEAD_PARAMS = { additionalData: 'buffer', iv: 'buffer!', tagLength: 'octet' };

registerAlgorithm({
	name: NAME,
	params: {
		generateKey: {},
		importKey: {},
		getKeyLength: {},
		encrypt: AEAD_PARAMS,
		decrypt: AEAD_PARAMS
	},
	generateKey(_algorithm, extractable, usages) {
		checkUsages(usages, USAGES);

		return chachaKey(crypto.getRandomValues(new Uint8Array(KEY_BYTES)), extractable, usages);
	},
	importKey,
	exportKey,
	encrypt: (algorithm, key, data) => {
		const aead = cipher(algorithm, key);

		return sealed(() => aead.encrypt(data));
	},
	decrypt: (algorithm, key, data) => {
		const aead = cipher(algorithm, key);

		return sealed(() => aead.decrypt(data));
	},
	getKeyLength: () => KEY_BYTES * 8,
	checkParams: (operation, algorithm) => check(algorithm),
	checkSecret(algorithm, bits) {
		if (bits !== KEY_BYTES * 8) throw operationError(`${NAME}: the key must be 256 bits`);
	}
});
