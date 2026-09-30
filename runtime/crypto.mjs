// The Web Crypto global (https://w3c.github.io/webcrypto/#crypto-interface): Porffor's own
// crypto (getRandomValues and randomUUID, over wasi:random) with a subtle (subtle-crypto.mjs).
// The build injects `crypto` from here only into a guest that names `subtle`
// (scripts/bundle.mjs), so a program that only draws random values carries no @noble code.
//
// Porffor's own crypto is read from the global object when this module loads, before the build
// installs this one there: a bare `crypto` is not Porffor's in a WASI build, which rewrites the
// name to this module's export everywhere, this module too. CryptoKey and SubtleCrypto are
// exported from here too. The algorithms beyond the SHA digests are modules of their own, loaded
// as a program names them (see subtle-crypto.mjs).

import { CryptoKey } from './crypto-key.mjs';
import { DOMException } from './dom-exception.mjs';
import { SubtleCrypto } from './subtle-crypto.mjs';

export { CryptoKey, SubtleCrypto };

// (see blob.mjs's TAG)
const TAG = 'Crypto';

let subtle = null;

// Porffor's crypto (the global object's, until the build installs this module's)
const platform = globalThis.crypto;

// the most bytes one getRandomValues call fills
const MAX_RANDOM_BYTES = 65536;

/** Whether a view is of integers (not floats, not a DataView): what getRandomValues fills. */
const isIntegerArray = (array) =>
	array instanceof Int8Array ||
	array instanceof Uint8Array ||
	array instanceof Uint8ClampedArray ||
	array instanceof Int16Array ||
	array instanceof Uint16Array ||
	array instanceof Int32Array ||
	array instanceof Uint32Array ||
	array instanceof BigInt64Array ||
	array instanceof BigUint64Array;

/** The crypto global: random values and the SubtleCrypto. */
class Crypto {
	/**
	 * Fills an integer typed array with random values, and returns it.
	 * @template {ArrayBufferView} T
	 * @param {T} array
	 * @returns {T}
	 */
	getRandomValues(array) {
		if (!ArrayBuffer.isView(array)) throw new TypeError('getRandomValues takes an ArrayBufferView');

		if (!isIntegerArray(array))
			throw new DOMException('The array is not an integer typed array', 'TypeMismatchError');

		if (array.byteLength > MAX_RANDOM_BYTES)
			throw new DOMException('The array is longer than 65536 bytes', 'QuotaExceededError');

		return platform.getRandomValues(array);
	}

	/** A random version 4 UUID. */
	randomUUID() {
		return platform.randomUUID();
	}

	/** The SubtleCrypto: digests, keys and signatures. */
	get subtle() {
		subtle ??= new SubtleCrypto();

		return subtle;
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}

const webCrypto = new Crypto();

export { Crypto, webCrypto as crypto };
