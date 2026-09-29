// SubtleCrypto (https://w3c.github.io/webcrypto/#subtlecrypto-interface), in JavaScript over
// @noble: digest (SHA-1, SHA-256, SHA-384, SHA-512), HMAC (crypto-hmac.mjs) and Ed25519
// (crypto-ed25519.mjs). Every other algorithm and operation rejects with NotSupportedError.
// Every method returns a promise, and a failure is a rejection, never a throw.

import {
	ed25519Sign,
	ed25519Verify,
	exportEd25519Key,
	generateEd25519Key,
	importEd25519Key
} from './crypto-ed25519.mjs';
import {
	HASHES,
	exportHmacKey,
	generateHmacKey,
	hmacSign,
	hmacVerify,
	importHmacKey
} from './crypto-hmac.mjs';
import { CryptoKey } from './crypto-key.mjs';
import { algorithmName, invalidAccess, notSupported, toBuffer, toBytes } from './crypto-util.mjs';

// (see blob.mjs's TAG)
const TAG = 'SubtleCrypto';

/** The key checked for an operation: of this algorithm, allowed this usage. */
function usableKey(key, name, usage) {
	if (!(key instanceof CryptoKey))
		throw new TypeError('The provided value is not of type CryptoKey');

	if (key.algorithm.name !== name)
		throw invalidAccess(`The key is not for ${name} (it is for ${key.algorithm.name})`);

	if (!key._usages.includes(usage)) throw invalidAccess(`The key does not allow ${usage}`);

	return key;
}

/** The algorithm's name, for an operation that supports only those given. */
function supported(algorithm, names, operation) {
	const name = algorithmName(algorithm);

	if (!name || !names.includes(name)) throw notSupported(`${operation}: unsupported algorithm`);

	return name;
}

/** Cryptographic primitives: hashing, keys, signatures. */
export class SubtleCrypto {
	/**
	 * The digest of data.
	 * @param {string | { name: string }} algorithm 'SHA-1', 'SHA-256', 'SHA-384' or 'SHA-512'
	 * @param {BufferSource} data
	 * @returns {Promise<ArrayBuffer>}
	 */
	async digest(algorithm, data) {
		const name = supported(algorithm, Object.keys(HASHES), 'digest');

		return toBuffer(HASHES[name](toBytes(data)));
	}

	/**
	 * A new key (HMAC) or key pair (Ed25519).
	 * @returns {Promise<CryptoKey | { publicKey: CryptoKey, privateKey: CryptoKey }>}
	 */
	async generateKey(algorithm, extractable, keyUsages) {
		const name = supported(algorithm, ['HMAC', 'Ed25519'], 'generateKey');

		return name === 'HMAC'
			? generateHmacKey(algorithm, Boolean(extractable), keyUsages)
			: generateEd25519Key(Boolean(extractable), keyUsages);
	}

	/**
	 * A key from its bytes or a JWK.
	 * @param {'raw' | 'jwk' | 'spki' | 'pkcs8'} format
	 * @returns {Promise<CryptoKey>}
	 */
	async importKey(format, keyData, algorithm, extractable, keyUsages) {
		const name = supported(algorithm, ['HMAC', 'Ed25519'], 'importKey');

		return name === 'HMAC'
			? importHmacKey(format, keyData, algorithm, Boolean(extractable), keyUsages)
			: importEd25519Key(format, keyData, Boolean(extractable), keyUsages);
	}

	/**
	 * An extractable key's bytes (an ArrayBuffer) or JWK (an object).
	 * @param {'raw' | 'jwk' | 'spki' | 'pkcs8'} format
	 * @param {CryptoKey} key
	 */
	async exportKey(format, key) {
		if (!(key instanceof CryptoKey))
			throw new TypeError('The provided value is not of type CryptoKey');

		if (!key.extractable) throw invalidAccess('The key is not extractable');

		if (key.algorithm.name === 'HMAC') return exportHmacKey(format, key);

		if (key.algorithm.name === 'Ed25519') return exportEd25519Key(format, key);

		throw notSupported('exportKey: unsupported algorithm');
	}

	/**
	 * The signature (HMAC: the MAC) of data under the key.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async sign(algorithm, key, data) {
		const name = supported(algorithm, ['HMAC', 'Ed25519'], 'sign');
		const usable = usableKey(key, name, 'sign');

		return name === 'HMAC' ? hmacSign(usable, data) : ed25519Sign(usable, data);
	}

	/**
	 * Whether signature is data's under the key.
	 * @returns {Promise<boolean>}
	 */
	async verify(algorithm, key, signature, data) {
		const name = supported(algorithm, ['HMAC', 'Ed25519'], 'verify');
		const usable = usableKey(key, name, 'verify');

		return name === 'HMAC'
			? hmacVerify(usable, signature, data)
			: ed25519Verify(usable, signature, data);
	}

	/** Not supported by this runtime: rejects with NotSupportedError. */
	async encrypt() {
		throw notSupported('encrypt is not supported by this runtime');
	}

	/** Not supported by this runtime: rejects with NotSupportedError. */
	async decrypt() {
		throw notSupported('decrypt is not supported by this runtime');
	}

	/** Not supported by this runtime: rejects with NotSupportedError. */
	async deriveBits() {
		throw notSupported('deriveBits is not supported by this runtime');
	}

	/** Not supported by this runtime: rejects with NotSupportedError. */
	async deriveKey() {
		throw notSupported('deriveKey is not supported by this runtime');
	}

	/** Not supported by this runtime: rejects with NotSupportedError. */
	async wrapKey() {
		throw notSupported('wrapKey is not supported by this runtime');
	}

	/** Not supported by this runtime: rejects with NotSupportedError. */
	async unwrapKey() {
		throw notSupported('unwrapKey is not supported by this runtime');
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}
