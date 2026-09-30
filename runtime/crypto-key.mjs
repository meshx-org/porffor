// CryptoKey (https://w3c.github.io/webcrypto/#cryptokey-interface): an opaque key. Only
// SubtleCrypto (subtle-crypto.mjs) and its algorithms make one (makeKey); its material never
// leaves it but by exportKey, and then only when it is extractable.

import { KEY_USAGES } from './crypto-util.mjs';

// (see blob.mjs's TAG: a getter, so the module has no top-level side effect)
const TAG = 'CryptoKey';

// The token makeKey passes: `new CryptoKey()` from script throws
const KEY_TOKEN = Symbol('CryptoKey');

/** A copy of a key algorithm dictionary, for script to see (its own hash and exponent too). */
function copyAlgorithm(algorithm) {
	const out = {};

	for (const name of Object.keys(algorithm)) {
		const value = algorithm[name];

		out[name] =
			value instanceof Uint8Array
				? value.slice()
				: typeof value === 'object' && value !== null
					? copyAlgorithm(value)
					: value;
	}

	return out;
}

/** An opaque key: its type, algorithm, usages and whether it can be exported. */
export class CryptoKey {
	/**
	 * @param {symbol} token KEY_TOKEN
	 * @param {{ type: 'secret' | 'private' | 'public', extractable: boolean, algorithm: object, usages: string[], material: unknown }} init
	 */
	constructor(token = undefined, init = undefined) {
		if (token !== KEY_TOKEN) throw new TypeError('Illegal constructor');

		this._type = init.type;
		this._extractable = init.extractable;
		this._algorithm = init.algorithm;
		this._usages = init.usages;
		this._material = init.material;
		// the objects script sees, made once (the spec's [[algorithm_cached]], [[usages_cached]])
		this._algorithmSeen = null;
		this._usagesSeen = null;
	}

	/** 'secret', 'private' or 'public'. */
	get type() {
		return this._type;
	}

	/** Whether exportKey may export it. */
	get extractable() {
		return this._extractable;
	}

	/** The algorithm it is for, with its parameters ({ name, hash, length } for HMAC). */
	get algorithm() {
		this._algorithmSeen ??= copyAlgorithm(this._algorithm);

		return this._algorithmSeen;
	}

	/** What it may be used for ('sign', 'verify'). */
	get usages() {
		this._usagesSeen ??= this._usages.slice();

		return this._usagesSeen;
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}

/**
 * A key (the only way to make one): its usages without duplicates, in the spec's order.
 * @param {'secret' | 'private' | 'public'} type
 * @param {boolean} extractable
 * @param {object} algorithm the KeyAlgorithm dictionary ({ name, ... })
 * @param {string[]} usages
 * @param {unknown} material the algorithm's own form of the key
 */
export function makeKey(type, extractable, algorithm, usages, material) {
	return new CryptoKey(KEY_TOKEN, {
		type,
		extractable,
		algorithm,
		usages: KEY_USAGES.filter((usage) => usages.includes(usage)),
		material
	});
}
