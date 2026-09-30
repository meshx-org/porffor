// What PBKDF2 and HKDF share (https://w3c.github.io/webcrypto/#pbkdf2, #hkdf): the key, which
// is only its secret bytes, imported 'raw' and never extractable nor exportable.

import { makeKey } from './crypto-key.mjs';
import { checkUsages, notSupported, operationError, syntaxError } from './crypto-util.mjs';
import { registerAlgorithm } from './subtle-crypto.mjs';

const USAGES = ['deriveKey', 'deriveBits'];

/**
 * Registers a key derivation algorithm.
 * @param {string} name
 * @param {Record<string, string>} params deriveBits' parameters
 * @param {(algorithm: object, secret: Uint8Array, bytes: number) => Uint8Array} derive
 * @param {(algorithm: object, bytes: number) => void} check throws for parameters it refuses
 */
export function registerKdf(name, params, derive, check) {
	function importKey(format, keyData, _algorithm, extractable, usages) {
		if (format !== 'raw' && format !== 'raw-secret')
			throw notSupported(`${name}: unsupported key format '${format}'`);
		checkUsages(usages, USAGES);

		if (extractable) throw syntaxError(`${name}: a key cannot be extractable`);

		return makeKey('secret', false, { name }, usages, keyData);
	}

	/** The parameters and length checked (a whole number of bytes, one the algorithm makes). */
	function checkDerive(algorithm, length) {
		if (length === null || length % 8 !== 0)
			throw operationError(`${name}: the length must be a multiple of 8`);
		check(algorithm, length / 8);
	}

	/** length bits derived from the key. */
	function deriveBits(algorithm, key, length) {
		checkDerive(algorithm, length);

		return length === 0 ? new Uint8Array(0) : derive(algorithm, key._material, length / 8);
	}

	registerAlgorithm({
		name,
		params: { importKey: {}, deriveBits: params, getKeyLength: {} },
		importKey,
		deriveBits,
		checkDerive,
		// a derived key of this algorithm takes its length from the key it is made from
		getKeyLength: () => null
	});
}
