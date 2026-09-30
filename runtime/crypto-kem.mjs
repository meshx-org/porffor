// What the key encapsulation mechanisms share (the Modern Algorithms in WebCrypto draft's
// encapsulate and decapsulate: ML-KEM, crypto-ml-kem.mjs, and the hybrid KEMs,
// crypto-hybrid-kem.mjs): their keys are crypto-akp.mjs's, and the operations are noble's KEM.

import { registerAkp } from './crypto-akp.mjs';
import { invalidAccess, operationError } from './crypto-util.mjs';

/**
 * Registers a KEM over one of noble's.
 * @param {string} name
 * @param {string | null} oid
 * @param {{ keygen: Function, encapsulate: Function, decapsulate: Function, lengths: { seed: number, publicKey: number } }} kem
 */
export function registerKem(name, oid, kem) {
	registerAkp({
		name,
		oid,
		seedLength: kem.lengths.seed,
		publicLength: kem.lengths.publicKey,
		keygen: (seed) => kem.keygen(seed),
		publicUsages: ['encapsulateKey', 'encapsulateBits'],
		privateUsages: ['decapsulateKey', 'decapsulateBits'],
		use: 'enc',
		params: { encapsulate: {}, decapsulate: {} },
		operations: {
			/** A shared secret and its ciphertext, for the public key. */
			encapsulate(_algorithm, key) {
				if (key._type !== 'public') throw invalidAccess(`${name}: encapsulate needs a public key`);
				let result;

				try {
					result = kem.encapsulate(key._material.publicKey);
				} catch {
					throw operationError(`${name}: the public key is not valid`);
				}

				return { sharedKey: result.sharedSecret, ciphertext: result.cipherText };
			},
			/** The shared secret a ciphertext carries, with the private key. */
			decapsulate(_algorithm, key, ciphertext) {
				if (key._type !== 'private')
					throw invalidAccess(`${name}: decapsulate needs a private key`);

				try {
					return kem.decapsulate(ciphertext, key._material.secretKey);
				} catch {
					throw operationError(`${name}: the ciphertext is not valid`);
				}
			}
		}
	});
}
