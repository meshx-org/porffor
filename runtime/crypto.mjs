// The Web Crypto global (https://w3c.github.io/webcrypto/#crypto-interface): Porffor's own
// crypto (getRandomValues and randomUUID, over wasi:random) with a subtle (subtle-crypto.mjs).
// The build injects `crypto` from here only into a guest that names `subtle`
// (scripts/bundle.mjs), so a program that only draws random values carries no @noble code.
//
// In this module `crypto` is still Porffor's: the build rewrites the name to this module's
// export everywhere else. CryptoKey and SubtleCrypto are exported from here too, so the one
// injected file is evaluated after everything it imports.

import { CryptoKey } from './crypto-key.mjs';
import { SubtleCrypto } from './subtle-crypto.mjs';

export { CryptoKey, SubtleCrypto };

// (see blob.mjs's TAG)
const TAG = 'Crypto';

let subtle = null;

/** The crypto global: random values and the SubtleCrypto. */
class Crypto {
	/**
	 * Fills an integer typed array with random values, and returns it.
	 * @template {ArrayBufferView} T
	 * @param {T} array
	 * @returns {T}
	 */
	getRandomValues(array) {
		return crypto.getRandomValues(array);
	}

	/** A random version 4 UUID. */
	randomUUID() {
		return crypto.randomUUID();
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

export { webCrypto as crypto };
