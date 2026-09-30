// AES for the Web Crypto shim (https://w3c.github.io/webcrypto/#aes-ctr and on: AES-CTR,
// AES-CBC, AES-GCM, AES-KW), over @noble/ciphers: generateKey, importKey and exportKey ('raw',
// 'raw-secret', 'jwk'), encrypt and decrypt (wrapKey and unwrapKey for AES-KW), and the key
// length deriveKey asks for. Loaded (runtime/globals.json) only into a program that names one
// of them ('AES-GCM'); the four share a key and noble's cipher, so they are one module.
//
// Where WebCrypto asks more of a mode than noble has, it is done here: AES-CTR's counter is only
// the low `length` bits of the block (it wraps there, noble's counts all 128), and AES-GCM takes
// tags shorter than noble's 128 bits.

import { aeskw, cbc, ecb, gcm } from '@noble/ciphers/aes.js';
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

const LENGTHS = [128, 192, 256];

/** A JWK's alg for a key of the mode and length: A128GCM, A256KW, ... */
const jwkAlg = (name, bits) => `A${bits}${name.slice(4)}`;

/** Runs a noble cipher call, its failures an OperationError (bad padding, a wrong tag). */
function cipherCall(run, what) {
	try {
		return run();
	} catch {
		throw operationError(`${what} failed`);
	}
}

/** AES-CTR's parameters: a 16-byte counter, of 1 to 128 bits. */
function ctrCheck(algorithm) {
	if (algorithm.counter.length !== 16) throw operationError('AES-CTR: the counter is not 16 bytes');

	if (algorithm.length === 0 || algorithm.length > 128)
		throw operationError('AES-CTR: the length is not 1 to 128');
}

/** The keystream-XORed data of AES-CTR: the counter's low `length` bits count the blocks. */
function ctrCrypt(algorithm, key, data) {
	const { counter, length } = algorithm;

	ctrCheck(algorithm);
	const blocks = Math.ceil(data.length / 16);

	// the counter may not repeat
	if (length < 53 && blocks > 2 ** length)
		throw operationError('AES-CTR: the data is longer than the counter can count');
	const stream = new Uint8Array(blocks * 16);
	const block = counter.slice();

	for (let i = 0; i < blocks; i++) {
		stream.set(block, i * 16);
		// the next counter: add one to the low `length` bits, wrapping there
		let carry = 1;

		for (let bit = 0; bit < length && carry; bit += 8) {
			const at = 15 - bit / 8;
			const width = Math.min(8, length - bit);
			const mask = (1 << width) - 1;
			const low = (block[at] & mask) + carry;

			carry = low > mask ? 1 : 0;
			block[at] = (block[at] & ~mask) | (low & mask);
		}
	}
	const keystream = cipherCall(
		() => ecb(key._material, { disablePadding: true }).encrypt(stream),
		'AES-CTR'
	);
	const out = new Uint8Array(data.length);

	for (let i = 0; i < data.length; i++) out[i] = data[i] ^ keystream[i];

	return out;
}

/** AES-CBC's parameters: a 16-byte iv. */
function cbcCheck(algorithm) {
	if (algorithm.iv.length !== 16) throw operationError('AES-CBC: the iv is not 16 bytes');
}

/** AES-CBC with PKCS#7 padding. */
function cbcCipher(algorithm, key) {
	cbcCheck(algorithm);

	return cbc(key._material, algorithm.iv);
}

const TAG_LENGTHS = [32, 64, 96, 104, 112, 120, 128];

/** AES-GCM's parameters: a tag length it has, an iv: the tag length. */
function gcmCheck(algorithm) {
	const tagBits = algorithm.tagLength ?? 128;

	if (!TAG_LENGTHS.includes(tagBits)) throw operationError('AES-GCM: unsupported tag length');

	// (noble's GHASH-derived J0 takes nonces from 8 bytes; the WPT's are 12 and more)
	if (algorithm.iv.length < 8) throw operationError('AES-GCM: the iv is too short');

	return tagBits;
}

/** AES-GCM's tag length in bytes, and its cipher. */
function gcmCipher(algorithm, key) {
	return {
		tagBytes: gcmCheck(algorithm) / 8,
		cipher: () => gcm(key._material, algorithm.iv, algorithm.additionalData)
	};
}

function gcmEncrypt(algorithm, key, data) {
	const { tagBytes, cipher } = gcmCipher(algorithm, key);
	const sealed = cipherCall(() => cipher().encrypt(data), 'AES-GCM');

	// a shorter tag is the full tag's first bytes
	return sealed.subarray(0, data.length + tagBytes).slice();
}

function gcmDecrypt(algorithm, key, data) {
	const { tagBytes, cipher } = gcmCipher(algorithm, key);

	if (data.length < tagBytes) throw operationError('AES-GCM: the data is shorter than the tag');

	if (tagBytes === 16) return cipherCall(() => cipher().decrypt(data), 'AES-GCM');
	// a short tag: CTR is its own inverse, so encrypting the ciphertext gives the plaintext; that
	// encrypted again gives the full tag to compare the given one against
	const body = data.subarray(0, data.length - tagBytes);
	const plain = cipherCall(() => cipher().encrypt(body), 'AES-GCM').subarray(0, body.length);
	const tag = cipherCall(() => cipher().encrypt(plain), 'AES-GCM').subarray(body.length);

	if (!constantTimeEqual(tag.subarray(0, tagBytes), data.subarray(body.length)))
		throw operationError('AES-GCM: the tag does not match');

	return plain.slice();
}

/** AES-KW (RFC 3394): the data a whole number of 64-bit blocks. */
function kwWrap(algorithm, key, data) {
	if (data.length % 8 !== 0) throw operationError('AES-KW: the key is not a multiple of 64 bits');

	return cipherCall(() => aeskw(key._material).encrypt(data), 'AES-KW');
}

const kwUnwrap = (algorithm, key, data) =>
	cipherCall(() => aeskw(key._material).decrypt(data), 'AES-KW');

/**
 * Registers one AES mode: its key handling, and its operations.
 * @param {string} name
 * @param {string[]} usages the usages its keys may have
 * @param {Record<string, Function>} operations
 * @param {Record<string, Record<string, string>>} params the operations' parameters
 * @param {string[]} [rawFormats] the formats of its bare key bytes (the Modern Algorithms
 *   draft's modes take only 'raw-secret')
 */
export function registerMode(name, usages, operations, params, rawFormats = ['raw', 'raw-secret']) {
	const aesKey = (material, extractable, keyUsages) =>
		makeKey('secret', extractable, { name, length: material.length * 8 }, keyUsages, material);

	/** A key generation's length: 128, 192 or 256, else an OperationError. */
	function checkGenerateKey(algorithm) {
		if (!LENGTHS.includes(algorithm.length))
			throw operationError(`${name}: the length must be 128, 192 or 256`);
	}

	function generateKey(algorithm, extractable, keyUsages) {
		checkUsages(keyUsages, usages);
		checkGenerateKey(algorithm);

		return aesKey(
			crypto.getRandomValues(new Uint8Array(algorithm.length / 8)),
			extractable,
			keyUsages
		);
	}

	function importKey(format, keyData, _algorithm, extractable, keyUsages) {
		checkUsages(keyUsages, usages);
		let material;

		if (rawFormats.includes(format)) material = keyData;
		else if (format === 'jwk') {
			if (keyData.kty !== 'oct') throw dataError("JWK: kty must be 'oct'");

			if (keyData.k === undefined) throw dataError('JWK: k is missing');
			material = fromBase64url(keyData.k);

			if (
				LENGTHS.includes(material.length * 8) &&
				keyData.alg !== undefined &&
				keyData.alg !== jwkAlg(name, material.length * 8)
			)
				throw dataError(`JWK: alg must be ${jwkAlg(name, material.length * 8)}`);
			checkJwk(keyData, { kty: 'oct', use: 'enc', usages: keyUsages, extractable });
		} else throw notSupported(`${name}: unsupported key format '${format}'`);

		if (!LENGTHS.includes(material.length * 8))
			throw dataError(`${name}: the key must be 128, 192 or 256 bits`);

		return aesKey(material, extractable, keyUsages);
	}

	function exportKey(format, key) {
		if (rawFormats.includes(format)) return key._material.slice().buffer;

		if (format === 'jwk')
			return {
				...jwkCommon(key),
				alg: jwkAlg(name, key._material.length * 8),
				kty: 'oct',
				k: base64url(key._material)
			};

		throw notSupported(`${name}: unsupported key format '${format}'`);
	}

	/** deriveKey's length: `length`, if an AES key can have it. */
	function getKeyLength(algorithm) {
		if (!LENGTHS.includes(algorithm.length))
			throw operationError(`${name}: the length must be 128, 192 or 256`);

		return algorithm.length;
	}

	const lengthParams = { length: 'ushort!' };

	registerAlgorithm({
		name,
		params: { generateKey: lengthParams, importKey: {}, getKeyLength: lengthParams, ...params },
		generateKey,
		checkGenerateKey,
		importKey,
		exportKey,
		getKeyLength,
		// supports' check of a shared key's length (encapsulateKey): an AES key can have it
		checkSecret(algorithm, bits) {
			if (!LENGTHS.includes(bits)) throw operationError(`${name}: no key of ${bits} bits`);
		},
		...operations
	});
}

const CIPHER_USAGES = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'];
const CTR_PARAMS = { counter: 'buffer!', length: 'octet!' };
const CBC_PARAMS = { iv: 'buffer!' };
const GCM_PARAMS = { additionalData: 'buffer', iv: 'buffer!', tagLength: 'octet' };

registerMode(
	'AES-CTR',
	CIPHER_USAGES,
	{
		encrypt: ctrCrypt,
		decrypt: ctrCrypt,
		checkParams: (operation, algorithm) => ctrCheck(algorithm)
	},
	{ encrypt: CTR_PARAMS, decrypt: CTR_PARAMS }
);
registerMode(
	'AES-CBC',
	CIPHER_USAGES,
	{
		encrypt: (algorithm, key, data) =>
			cipherCall(() => cbcCipher(algorithm, key).encrypt(data), 'AES-CBC'),
		decrypt: (algorithm, key, data) => {
			const cipher = cbcCipher(algorithm, key);

			return cipherCall(() => cipher.decrypt(data), 'AES-CBC');
		},
		checkParams: (operation, algorithm) => cbcCheck(algorithm)
	},
	{ encrypt: CBC_PARAMS, decrypt: CBC_PARAMS }
);
registerMode(
	'AES-GCM',
	CIPHER_USAGES,
	{
		encrypt: gcmEncrypt,
		decrypt: gcmDecrypt,
		checkParams: (operation, algorithm) => gcmCheck(algorithm)
	},
	{ encrypt: GCM_PARAMS, decrypt: GCM_PARAMS }
);
registerMode(
	'AES-KW',
	['wrapKey', 'unwrapKey'],
	{ wrapKey: kwWrap, unwrapKey: kwUnwrap },
	{ wrapKey: {}, unwrapKey: {} }
);
