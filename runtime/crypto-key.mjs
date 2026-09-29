// CryptoKey (https://w3c.github.io/webcrypto/#cryptokey-interface): an opaque key. Only
// SubtleCrypto (subtle-crypto.mjs) makes one; its bytes (`_material`) never leave it but by
// exportKey, and then only when it is extractable.

// (see blob.mjs's TAG: a getter, so the module has no top-level side effect)
const TAG = 'CryptoKey';

/** The token SubtleCrypto passes to make a key: `new CryptoKey()` from script throws. */
export const KEY_TOKEN = Symbol('CryptoKey');

/** An opaque key: its type, algorithm, usages and whether it can be exported. */
export class CryptoKey {
	/**
	 * @param {symbol} token KEY_TOKEN
	 * @param {{ type: 'secret' | 'private' | 'public', extractable: boolean, algorithm: object, usages: string[], material: Uint8Array }} init
	 */
	constructor(token = undefined, init = undefined) {
		if (token !== KEY_TOKEN) throw new TypeError('Illegal constructor');

		this._type = init.type;
		this._extractable = init.extractable;
		this._algorithm = init.algorithm;
		this._usages = init.usages;
		this._material = init.material;
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
		return this._algorithm;
	}

	/** What it may be used for ('sign', 'verify'). */
	get usages() {
		return this._usages.slice();
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}
